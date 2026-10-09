//! Greedy line breaking for `plain` mode, standing in for the CSS breaker.
//!
//! The CSS it imitates is the hidden element the app used to ask
//! (`src/lib/text-engine/browser.js`):
//!
//! ```css
//! white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word;
//! ```
//!
//! which comes to four rules:
//!
//! 1. A line may end at a UAX #14 break opportunity, tailored as the browsers
//!    tailor it ([`tailor`]).
//! 2. Spaces are kept, and the spaces at the end of a line hang: they are not
//!    counted against the width, however many there are.
//! 3. A line takes as many words as fit. A word that does not fit goes to the
//!    next line whole.
//! 4. Only a word that is wider than the line by itself is cut, after the
//!    last letter that fits and never before a combining mark; a line always
//!    takes at least one letter.
//!
//! Letter spacing is added after every letter, the last one of the line too,
//! and switches the font's ligatures off, as both browsers do.
//!
//! RULES.md has the agreement with Chromium and WebKit on the corpus.

use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::engine::{extends_cluster, is_canvas_space, Engine, Face, ShapeMode};
use crate::Error;

/// One wrapped line as a half-open range of UTF-16 offsets into the input.
/// The range never contains the newline that ended it. It does contain the
/// spaces that hang at its end; trimming them is the caller's business, as it
/// was with the DOM.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WrapOptions {
    /// Content width in pixels.
    pub width: f64,
    /// Added after every letter, as CSS `letter-spacing` does.
    pub letter_spacing: f64,
}

/// What the breaker needs to know about one code point.
struct Unit {
    utf16: u32,
    byte: usize,
    /// Advance, in pixels, of the glyphs whose cluster starts here when the
    /// whole paragraph is shaped at once. A ligature's advance sits on its
    /// first letter, which is why a cut inside a word is measured again.
    advance: f64,
    is_space: bool,
    /// A line may end before this code point.
    can_break: bool,
    /// Belongs to the letter before it; takes no letter spacing and is never
    /// the first thing on a line.
    mark: bool,
}

/// One paragraph being broken: its code points, and the running sums the
/// width of any stretch is read from.
struct Para<'a> {
    text: &'a str,
    units: Vec<Unit>,
    /// `adv[i]` is the advance of units `0..i`.
    adv: Vec<f64>,
    /// `letters[i]` is how many of units `0..i` take letter spacing.
    letters: Vec<u32>,
    spacing: f64,
}

impl Para<'_> {
    fn len(&self) -> usize {
        self.units.len()
    }

    fn byte(&self, unit: usize) -> usize {
        self.units.get(unit).map_or(self.text.len(), |u| u.byte)
    }

    /// The end of `from..to` once the spaces that would hang are left off.
    fn trimmed(&self, from: usize, to: usize) -> usize {
        let mut end = to;
        while end > from && self.units[end - 1].is_space {
            end -= 1;
        }
        end
    }

    fn letters_in(&self, from: usize, to: usize) -> f64 {
        f64::from(self.letters[to] - self.letters[from])
    }

    /// Width of `from..to` as a line: hanging spaces left off, letter spacing
    /// after every letter that stays.
    fn width(&self, from: usize, to: usize) -> f64 {
        let end = self.trimmed(from, to);
        self.adv[end] - self.adv[from] + self.letters_in(from, end) * self.spacing
    }

    /// Whether a line may start at `unit`: not in the middle of a letter and
    /// its marks.
    fn boundary(&self, unit: usize) -> bool {
        unit >= self.len() || !self.units[unit].mark
    }

    /// The next place after `unit` a word may be cut, no further than `last`.
    fn next_boundary(&self, unit: usize, last: usize) -> usize {
        let mut i = unit + 1;
        while i < last && !self.boundary(i) {
            i += 1;
        }
        i.min(last)
    }

    /// Takes the advances of units `from..` from the engine's measured line,
    /// which must be the text from `from` to the end of the paragraph.
    fn take_advances(&mut self, engine: &Engine, face: Face, from: usize) -> Result<(), Error> {
        for u in &mut self.units[from..] {
            u.advance = 0.0;
        }
        let base = self.units.get(from).map_or(0, |u| u.utf16);
        for part in &engine.parts {
            let upem = f64::from(engine.font(part.font)?.info.units_per_em);
            let extra = engine.bold_extra(part.synth, face.size);
            for g in &engine.line[part.glyphs.clone()] {
                // The unit this cluster starts at: the last one at or before
                // the cluster's offset.
                let at = self.units.partition_point(|u| u.utf16 <= base + g.cluster);
                let unit = &mut self.units[at.saturating_sub(1).max(from)];
                unit.advance += f64::from(g.x_advance) * face.size / upem + extra;
            }
        }
        self.adv.truncate(from + 1);
        self.letters.truncate(from + 1);
        let (mut a, mut l) = (self.adv[from], self.letters[from]);
        for u in &self.units[from..] {
            a += u.advance;
            l += u32::from(!u.mark);
            self.adv.push(a);
            self.letters.push(l);
        }
        Ok(())
    }
}

/// A width that fits by less than this is taken to fit. Line widths here are
/// sums of `f64`; the browsers' are 32-bit sums snapped to 1/64 px, so a line
/// that exactly fills its box must not fall out over the last bit.
const FIT_SLACK: f64 = 1.0 / 128.0;

/// Whether a line may end between `before` and `after`, where UAX #14 as the
/// `unicode-linebreak` crate implements it says it may.
///
/// The one place a departure from the standard goes. There is none today:
/// see RULES.md for what was looked at.
fn tailor(_before: char, _after: char) -> bool {
    true
}

impl Engine {
    /// Breaks `text` into lines no wider than `opts.width`.
    ///
    /// A paragraph is shaped once and its lines are measured from the
    /// advances of that one run, the way a browser does it, so a line's
    /// width here can differ from `advance(line)` by the kerning across the
    /// break. Where a word is cut the rest is shaped again from the cut, as
    /// a browser does, because the cut may have gone through a ligature.
    pub fn wrap_plain(
        &mut self,
        face: Face,
        text: &str,
        opts: WrapOptions,
    ) -> Result<Vec<LineRange>, Error> {
        self.check_chain(face.chain)?;
        self.font(face.font)?;
        let mut lines = Vec::new();
        let mut para_start_utf16 = 0u32;
        // split_inclusive keeps the newline with its paragraph so offsets add
        // up; a trailing newline still yields the empty last line CSS shows.
        for para in text.split_inclusive('\n') {
            let body = para.strip_suffix('\n').unwrap_or(para);
            self.wrap_paragraph(face, body, para_start_utf16, opts, &mut lines)?;
            para_start_utf16 += para.encode_utf16().count() as u32;
        }
        if text.is_empty() || text.ends_with('\n') {
            lines.push(LineRange {
                start: para_start_utf16,
                end: para_start_utf16,
            });
        }
        Ok(lines)
    }

    fn wrap_paragraph(
        &mut self,
        face: Face,
        para: &str,
        base: u32,
        opts: WrapOptions,
        lines: &mut Vec<LineRange>,
    ) -> Result<(), Error> {
        if para.is_empty() {
            lines.push(LineRange {
                start: base,
                end: base,
            });
            return Ok(());
        }
        let spacing = if opts.letter_spacing.is_finite() {
            opts.letter_spacing
        } else {
            0.0
        };
        let mode = ShapeMode {
            no_ligatures: spacing != 0.0,
            ..ShapeMode::MEASURE
        };
        let mut units: Vec<Unit> = Vec::with_capacity(para.len());
        let mut byte_to_unit = vec![usize::MAX; para.len() + 1];
        let mut at16 = 0u32;
        for (i, (byte, ch)) in para.char_indices().enumerate() {
            byte_to_unit[byte] = i;
            units.push(Unit {
                utf16: at16,
                byte,
                advance: 0.0,
                is_space: ch == ' ' || is_canvas_space(ch),
                can_break: false,
                mark: i > 0 && extends_cluster(ch),
            });
            at16 += ch.len_utf16() as u32;
        }
        let n = units.len();
        byte_to_unit[para.len()] = n;
        for (byte, kind) in linebreaks(para) {
            let u = byte_to_unit[byte];
            if u == 0 || u >= n || kind != BreakOpportunity::Allowed {
                continue;
            }
            let before = para[..byte].chars().next_back().unwrap_or(' ');
            let after = para[byte..].chars().next().unwrap_or(' ');
            units[u].can_break = tailor(before, after);
        }
        let mut p = Para {
            text: para,
            units,
            adv: vec![0.0],
            letters: vec![0],
            spacing,
        };
        self.measure_line(face, para, mode)?;
        p.take_advances(self, face, 0)?;

        let off =
            |p: &Para<'_>, u: usize| -> u32 { base + p.units.get(u).map_or(at16, |u| u.utf16) };
        let limit = opts.width + FIT_SLACK;

        let mut start = 0usize;
        while start < n {
            // The furthest opportunity that still fits, and the first that
            // does not.
            let mut best: Option<usize> = None;
            let mut over: Option<usize> = None;
            for i in (start + 1..=n).filter(|&i| i == n || p.units[i].can_break) {
                if p.width(start, i) <= limit {
                    best = Some(i);
                } else {
                    over = Some(i);
                    break;
                }
            }
            let end = match (best, over) {
                (Some(b), _) => b,
                (None, None) => n,
                (None, Some(word_end)) => {
                    // One word wider than the line. Cut after the last letter
                    // that fits, measured as the piece will be drawn: shaped
                    // by itself, so a ligature or a kerning pair across the
                    // cut is not counted as if it were still whole.
                    let last = p.trimmed(start, word_end);
                    let first = p.next_boundary(start, last);
                    let piece =
                        |engine: &mut Engine, p: &Para<'_>, to: usize| -> Result<f64, Error> {
                            engine.measure_line(face, &p.text[p.byte(start)..p.byte(to)], mode)?;
                            Ok(engine.line_advance(face.size)?
                                + p.letters_in(start, to) * p.spacing)
                        };
                    // Start from the paragraph's own advances, then correct.
                    let mut cut = first;
                    while cut < last && p.width(start, p.next_boundary(cut, last)) <= limit {
                        cut = p.next_boundary(cut, last);
                    }
                    while cut > first && piece(self, &p, cut)? > limit {
                        let mut back = cut - 1;
                        while back > first && !p.boundary(back) {
                            back -= 1;
                        }
                        cut = back;
                    }
                    while cut < last {
                        let further = p.next_boundary(cut, last);
                        if further == cut || piece(self, &p, further)? > limit {
                            break;
                        }
                        cut = further;
                    }
                    if cut >= last {
                        word_end
                    } else {
                        // What follows the cut is a new run: whatever the
                        // shaper did across it (a ligature, a kerning pair,
                        // a contextual form) is gone.
                        self.measure_line(face, &p.text[p.byte(cut)..], mode)?;
                        p.take_advances(self, face, cut)?;
                        cut
                    }
                }
            };
            lines.push(LineRange {
                start: off(&p, start),
                end: off(&p, end),
            });
            start = end;
        }
        Ok(())
    }
}
