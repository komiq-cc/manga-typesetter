//! Metric queries: the numbers a canvas `TextMetrics` used to supply.
//!
//! Each rule here was fixed by measuring Skia (`parity/skia.mjs`,
//! `parity/synth.mjs`); SPIKE.md records the measurements.

use crate::engine::{Engine, Face, Synth};
use crate::font::{LineBox, VerticalMetrics};
use crate::Error;

/// Line-box ascent and descent in pixels, both positive.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FontBox {
    pub ascent: f64,
    pub descent: f64,
}

/// Ink extents around an anchor, in pixels, in the sign convention of canvas
/// `actualBoundingBox*`: each value is positive when the ink reaches that
/// side of the anchor.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Ink {
    /// Advance of the run, not the width of the ink.
    pub width: f64,
    pub left: f64,
    pub right: f64,
    pub ascent: f64,
    pub descent: f64,
    /// False when no glyph of the run has an outline (spaces only, or empty
    /// text). The four extents are then zero, which is NOT what Skia reports:
    /// it returns a zero-size box at the pen origin. A caller that unions
    /// boxes must skip a run without ink instead of adding the anchor point.
    pub has_ink: bool,
}

/// `(x_min, y_min, x_max, y_max)` in pixels, y up.
type Extent = (f64, f64, f64, f64);

/// Picks the metric set a line box is built from, in font units.
///
/// `hhea` first, as every browser's font backend on every platform starts
/// there; `OS/2` typo only when the font asks for it with `USE_TYPO_METRICS`
/// or `hhea` states nothing; the clipping (`win`) values last.
pub fn line_box(v: &VerticalMetrics) -> LineBox {
    let stated = |l: &LineBox| l.ascent != 0.0 || l.descent != 0.0;
    match (v.hhea, v.typo, v.win) {
        (_, Some(typo), _) if v.use_typo_metrics => typo,
        (Some(hhea), _, _) if stated(&hhea) => hhea,
        (_, Some(typo), _) if stated(&typo) => typo,
        (_, _, Some(win)) => win,
        (hhea, _, _) => hhea.unwrap_or_default(),
    }
}

/// Half the width, in pixels, by which a synthesised bold grows an outline on
/// every side.
///
/// Skia's rule: the outline is stroked with a pen `size * k` wide and the
/// stroke is unioned with the fill, where `k` runs linearly from 1/24 at 9 px
/// to 1/32 at 36 px and is held outside that range (measured in
/// `parity/synth.mjs`, worst deviation 0.002 of the size).
///
/// Skia strokes with a miter join, so sharp corners reach up to 2.5 outsets;
/// the box computed here is the round-join one, exactly one outset. Which
/// join the engine draws is an open decision recorded in SPIKE.md.
pub fn bold_outset(size: f64) -> f64 {
    const LO: (f64, f64) = (9.0, 1.0 / 24.0);
    const HI: (f64, f64) = (36.0, 1.0 / 32.0);
    let k = if size <= LO.0 {
        LO.1
    } else if size >= HI.0 {
        HI.1
    } else {
        LO.1 + (HI.1 - LO.1) * (size - LO.0) / (HI.0 - LO.0)
    };
    size * k / 2.0
}

impl Engine {
    /// The font's line-box ascent and descent at this size, unrounded.
    pub fn font_box(&self, face: Face) -> Result<FontBox, Error> {
        let info = self.info(face.font)?;
        let line = line_box(&info.vertical);
        let scale = face.size / f64::from(info.units_per_em);
        Ok(FontBox {
            ascent: line.ascent * scale,
            descent: line.descent * scale,
        })
    }

    /// How far the canvas `middle` baseline sits above the alphabetic one:
    /// half the line box below its top.
    ///
    /// Skia computes `ascent - round(ascent + descent) / 2`, the same thing
    /// with the line height snapped to a whole pixel (verified exactly in
    /// `parity/skia.mjs`). The snap is left out here because a rule that
    /// rounds in pixels gives a different layout at every zoom level.
    pub fn middle_shift(&self, face: Face) -> Result<f64, Error> {
        let b = self.font_box(face)?;
        Ok((b.ascent - b.descent) / 2.0)
    }

    /// Union of the outline boxes of the shaped run, pen starting at x = 0 on
    /// the alphabetic baseline. Returns `(advance, x_min, y_min, x_max,
    /// y_max)` in pixels with y up, or no box when nothing has ink.
    fn run_extents(&mut self, face: Face, text: &str) -> Result<(f64, Option<Extent>), Error> {
        self.shape(face.font, text)?;
        let entry = self.font(face.font)?;
        let scale = face.size / f64::from(entry.info.units_per_em);
        let mut pen = 0i64;
        let mut ext: Option<Extent> = None;
        for g in self.last_run() {
            if let Some(b) = entry.glyph_bounds(g.id, face.synth.oblique) {
                let ox = (pen + i64::from(g.x_offset)) as f64;
                let oy = f64::from(g.y_offset);
                let cur = (
                    ox + f64::from(b.x_min),
                    oy + f64::from(b.y_min),
                    ox + f64::from(b.x_max),
                    oy + f64::from(b.y_max),
                );
                ext = Some(match ext {
                    None => cur,
                    Some(e) => (
                        e.0.min(cur.0),
                        e.1.min(cur.1),
                        e.2.max(cur.2),
                        e.3.max(cur.3),
                    ),
                });
            }
            pen += i64::from(g.x_advance);
        }
        let grow = if face.synth.bold {
            bold_outset(face.size)
        } else {
            0.0
        };
        let ext = ext.map(|e| {
            (
                e.0 * scale - grow,
                e.1 * scale - grow,
                e.2 * scale + grow,
                e.3 * scale + grow,
            )
        });
        Ok((pen as f64 * scale, ext))
    }

    /// Ink extents of a line drawn left-aligned on the alphabetic baseline.
    pub fn line_ink(&mut self, face: Face, text: &str) -> Result<Ink, Error> {
        let (width, ext) = self.run_extents(face, text)?;
        Ok(match ext {
            None => Ink {
                width,
                ..Ink::default()
            },
            // `+ 0.0` turns a negative zero into a positive one, so an edge that
            // sits exactly on the anchor does not print as "-0".
            Some((x0, y0, x1, y1)) => Ink {
                width,
                left: -x0 + 0.0,
                right: x1 + 0.0,
                ascent: y1 + 0.0,
                descent: -y0 + 0.0,
                has_ink: true,
            },
        })
    }

    /// Ink extents of one glyph drawn centred on its advance with the
    /// `middle` baseline at the anchor.
    pub fn glyph_ink(&mut self, face: Face, text: &str) -> Result<Ink, Error> {
        let (width, ext) = self.run_extents(face, text)?;
        let mid = self.middle_shift(face)?;
        let half = width / 2.0;
        Ok(match ext {
            None => Ink {
                width,
                ..Ink::default()
            },
            Some((x0, y0, x1, y1)) => Ink {
                width,
                left: half - x0,
                right: x1 - half,
                ascent: y1 - mid,
                descent: mid - y0,
                has_ink: true,
            },
        })
    }
}

impl Synth {
    /// Whether any style is synthesised.
    pub fn any(self) -> bool {
        self.bold || self.oblique
    }
}
