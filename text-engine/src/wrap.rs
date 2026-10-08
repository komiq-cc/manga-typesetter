//! Greedy line breaking for `plain` mode, standing in for the CSS breaker.
//!
//! Models `white-space: pre-wrap; overflow-wrap: break-word`: break at UAX #14
//! opportunities, keep spaces, let trailing spaces hang past the edge, and
//! break inside a word only when the word alone is wider than the line.

use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::engine::{Engine, Face};
use crate::Error;

/// One wrapped line as a half-open range of UTF-16 offsets into the input.
/// The range never contains the newline that ended it.
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
    /// Added after every code point, as CSS `letter-spacing` does.
    pub letter_spacing: f64,
}

/// What the breaker needs to know about one code point.
struct Unit {
    utf16: u32,
    /// Advance of the clusters that start at this code point, in font units.
    /// A ligature's whole advance sits on its first code point, so a break
    /// inside one is measured as if it fell after it. Good enough for a first
    /// cut; an exact answer needs a reshape of both halves.
    advance: i64,
    is_space: bool,
    /// A break is allowed before this code point.
    can_break: bool,
}

impl Engine {
    /// Breaks `text` into lines no wider than `opts.width`.
    ///
    /// The paragraph is shaped once and lines are measured from its cluster
    /// advances, the way a browser does it, so a line's width here can differ
    /// from `advance(line)` by the kerning across the break.
    pub fn wrap_plain(
        &mut self,
        face: Face,
        text: &str,
        opts: WrapOptions,
    ) -> Result<Vec<LineRange>, Error> {
        let upem = f64::from(self.font(face.font)?.info.units_per_em);
        let scale = face.size / upem;
        let mut lines = Vec::new();
        let mut para_start_utf16 = 0u32;
        // split_inclusive keeps the newline with its paragraph so offsets add
        // up; a trailing newline still yields the empty last line CSS shows.
        for para in text.split_inclusive('\n') {
            let body = para.strip_suffix('\n').unwrap_or(para);
            self.wrap_paragraph(face, body, para_start_utf16, scale, opts, &mut lines)?;
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
        scale: f64,
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
        let mut units: Vec<Unit> = Vec::with_capacity(para.len());
        let mut byte_to_unit = vec![usize::MAX; para.len() + 1];
        let mut at16 = 0u32;
        for (i, (byte, ch)) in para.char_indices().enumerate() {
            byte_to_unit[byte] = i;
            units.push(Unit {
                utf16: at16,
                advance: 0,
                is_space: ch == ' ' || ch == '\t',
                can_break: false,
            });
            at16 += ch.len_utf16() as u32;
        }
        byte_to_unit[para.len()] = units.len();
        for (byte, kind) in linebreaks(para) {
            let u = byte_to_unit[byte];
            if u < units.len() && kind == BreakOpportunity::Allowed {
                units[u].can_break = true;
            }
        }
        let run = self.shape(face.font, para)?;
        // Clusters are UTF-16 offsets; find the unit each one starts at.
        let mut unit_at = 0usize;
        for g in run {
            while unit_at + 1 < units.len() && units[unit_at + 1].utf16 <= g.cluster {
                unit_at += 1;
            }
            // Left-to-right text has non-decreasing clusters, but a reordered
            // cluster must still land on its own unit.
            let target = if units[unit_at].utf16 == g.cluster {
                unit_at
            } else {
                units
                    .iter()
                    .rposition(|u| u.utf16 <= g.cluster)
                    .unwrap_or(0)
            };
            units[target].advance += i64::from(g.x_advance);
        }

        let width_of = |from: usize, to: usize| -> f64 {
            // Trailing spaces hang, so they do not count against the width.
            let mut end = to;
            while end > from && units[end - 1].is_space {
                end -= 1;
            }
            let adv: i64 = units[from..end].iter().map(|u| u.advance).sum();
            adv as f64 * scale + (end - from) as f64 * opts.letter_spacing
        };
        let off = |u: usize| -> u32 {
            if u < units.len() {
                base + units[u].utf16
            } else {
                base + at16
            }
        };

        let mut start = 0usize;
        while start < units.len() {
            // Furthest break opportunity that still fits.
            let mut best: Option<usize> = None;
            let mut i = start + 1;
            let mut overflowed = false;
            while i <= units.len() {
                let at_break = i == units.len() || units[i].can_break;
                if at_break {
                    if width_of(start, i) <= opts.width {
                        best = Some(i);
                    } else {
                        overflowed = true;
                        break;
                    }
                }
                i += 1;
            }
            let end = match (best, overflowed) {
                (Some(b), _) => b,
                (None, _) => {
                    // The first word alone is too wide: break inside it,
                    // taking as many code points as fit and at least one.
                    let word_end = i.min(units.len());
                    let mut e = start + 1;
                    while e < word_end && width_of(start, e + 1) <= opts.width {
                        e += 1;
                    }
                    e
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
