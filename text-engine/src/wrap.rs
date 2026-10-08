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
    /// break.
    pub fn wrap_plain(
        &mut self,
        face: Face,
        text: &str,
        opts: WrapOptions,
    ) -> Result<Vec<LineRange>, Error> {
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
            canvas_space: true,
            no_ligatures: spacing != 0.0,
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

        self.measure_line(face, para, mode)?;
        for part in &self.parts {
            let upem = f64::from(self.font(part.font)?.info.units_per_em);
            let extra = self.bold_extra(part.synth, face.size);
            for g in &self.line[part.glyphs.clone()] {
                // The unit this cluster starts at: the last one at or before
                // the cluster's offset.
                let at = units.partition_point(|u| u.utf16 <= g.cluster);
                let unit = &mut units[at.saturating_sub(1)];
                unit.advance += f64::from(g.x_advance) * face.size / upem + extra;
            }
        }

        // Prefix sums: `adv[i]` is the advance of units `0..i`, `letters[i]`
        // how many of them take letter spacing.
        let mut adv = Vec::with_capacity(n + 1);
        let mut letters = Vec::with_capacity(n + 1);
        let (mut a, mut l) = (0.0f64, 0u32);
        adv.push(a);
        letters.push(l);
        for u in &units {
            a += u.advance;
            l += u32::from(!u.mark);
            adv.push(a);
            letters.push(l);
        }
        // The end of `from..to` once the spaces that would hang are left off.
        let trimmed = |from: usize, to: usize| -> usize {
            let mut end = to;
            while end > from && units[end - 1].is_space {
                end -= 1;
            }
            end
        };
        let width_of = |from: usize, to: usize| -> f64 {
            let end = trimmed(from, to);
            adv[end] - adv[from] + f64::from(letters[end] - letters[from]) * spacing
        };
        let off = |u: usize| -> u32 {
            if u < n {
                base + units[u].utf16
            } else {
                base + at16
            }
        };
        let limit = opts.width + FIT_SLACK;

        let mut start = 0usize;
        while start < n {
            // The furthest opportunity that still fits, and the first that
            // does not.
            let mut best: Option<usize> = None;
            let mut over: Option<usize> = None;
            for i in (start + 1..=n).filter(|&i| i == n || units[i].can_break) {
                if width_of(start, i) <= limit {
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
                    let last = trimmed(start, word_end);
                    let boundary = |i: usize| i >= last || !units[i].mark;
                    let next = |mut i: usize| {
                        i += 1;
                        while !boundary(i) {
                            i += 1;
                        }
                        i.min(last)
                    };
                    let first = next(start);
                    let piece = |engine: &mut Engine, to: usize| -> Result<f64, Error> {
                        let to_byte = if to < n { units[to].byte } else { para.len() };
                        engine.measure_line(face, &para[units[start].byte..to_byte], mode)?;
                        Ok(engine.line_advance(face.size)?
                            + f64::from(letters[to] - letters[start]) * spacing)
                    };
                    // Start from the paragraph's own advances, then correct.
                    let mut cut = first;
                    while cut < last && width_of(start, next(cut)) <= limit {
                        cut = next(cut);
                    }
                    while cut > first && piece(self, cut)? > limit {
                        let mut back = cut - 1;
                        while back > first && !boundary(back) {
                            back -= 1;
                        }
                        cut = back;
                    }
                    while cut < last {
                        let further = next(cut);
                        if further == cut || piece(self, further)? > limit {
                            break;
                        }
                        cut = further;
                    }
                    if cut >= last {
                        word_end
                    } else {
                        cut
                    }
                }
            };
            lines.push(LineRange {
                start: off(start),
                end: off(end),
            });
            start = end;
        }
        Ok(())
    }
}
