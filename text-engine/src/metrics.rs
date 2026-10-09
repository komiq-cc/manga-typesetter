//! Metric queries: the numbers a canvas `TextMetrics` used to supply.
//!
//! The rules were first fixed by measuring Skia (`parity/skia.mjs`,
//! `parity/synth.mjs`, recorded in SPIKE.md) and then set against captures of
//! Chromium and WebKit on the user's fonts; RULES.md records what each
//! reference does and which way every rule went.

use crate::engine::{BoldAdvance, Engine, Face, FontBoxRule, ShapeMode, Synth};
use crate::font::{FontInfo, LineBox, VerticalMetrics};
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

/// The ascender and descender a browser on macOS builds its line box from,
/// in font units, before any scaling or rounding.
///
/// Always `hhea`: of the user's 108 faces, the six that set
/// `USE_TYPO_METRICS` with typo values different from `hhea` are all reported
/// from `hhea` by both browsers. The descender's sign is dropped (one face
/// states it above the baseline and is reported with the same magnitude
/// below it), and a descender of zero is replaced by the depth of the font's
/// glyph box, `-head.yMin` (one face; both browsers do it). The mirror case,
/// an ascender of zero, and a font whose `hhea` states nothing at all, were
/// not seen: they fall back the same way and down the table ladder.
pub fn browser_line_units(info: &FontInfo) -> (f64, f64) {
    let v = &info.vertical;
    let stated = |l: &LineBox| l.ascent != 0.0 || l.descent != 0.0;
    let line = match v.hhea {
        Some(h) if stated(&h) => h,
        _ => line_box(v),
    };
    let (y_min, y_max) = info.bbox_y.unwrap_or((0, 0));
    let ascent = if line.ascent == 0.0 && y_max > 0 {
        f64::from(y_max)
    } else {
        line.ascent.abs()
    };
    let descent = if line.descent == 0.0 && y_min < 0 {
        -f64::from(y_min)
    } else {
        line.descent.abs()
    };
    (ascent, descent)
}

/// Scales a vertical metric the way CoreText does, which is what both
/// browsers then round.
///
/// For a CFF font it is the plain product. For a TrueType font the scale
/// `units / unitsPerEm` goes through a 16.16 fixed-point number first, so a
/// value that is exactly half a pixel in real arithmetic can land a hair
/// under it and round the other way (Bebas Neue at 25 px: 22.5 becomes 22).
/// On 2,049 face and size pairs (`parity/fontbox.mjs`) this split reproduces
/// every one; plain arithmetic for both kinds misses 4, fixed point 31.
fn coretext_scale(units: f64, info: &FontInfo, size: f64) -> f64 {
    let upem = f64::from(info.units_per_em);
    if info.truetype {
        (units * 65536.0 / upem).round() / 65536.0 * size
    } else {
        units * size / upem
    }
}

impl Engine {
    /// The font's line-box ascent and descent at this size.
    ///
    /// Under the default rule both are whole pixels, each rounded by itself,
    /// half up: what `fontBoundingBoxAscent`/`Descent` are in Chromium and in
    /// WebKit, which agree on every face and size captured.
    pub fn font_box(&self, face: Face) -> Result<FontBox, Error> {
        self.check_chain(face.chain)?;
        let info = self.info(face.font)?;
        match self.rules.font_box {
            FontBoxRule::Skia => self.font_box_unrounded(face),
            FontBoxRule::Browser => {
                let (a, d) = browser_line_units(info);
                Ok(FontBox {
                    ascent: (coretext_scale(a, info, face.size) + 0.5).floor(),
                    descent: (coretext_scale(d, info, face.size) + 0.5).floor(),
                })
            }
        }
    }

    /// The line box before any rounding: the same table values as
    /// [`Engine::font_box`], scaled in plain arithmetic.
    pub fn font_box_unrounded(&self, face: Face) -> Result<FontBox, Error> {
        self.check_chain(face.chain)?;
        let info = self.info(face.font)?;
        let scale = face.size / f64::from(info.units_per_em);
        let (a, d) = match self.rules.font_box {
            FontBoxRule::Skia => {
                let line = line_box(&info.vertical);
                (line.ascent, line.descent)
            }
            FontBoxRule::Browser => browser_line_units(info),
        };
        Ok(FontBox {
            ascent: a * scale,
            descent: d * scale,
        })
    }

    /// How far the canvas `middle` baseline sits above the alphabetic one:
    /// half the line box below its top, from the unrounded box.
    ///
    /// No two references agree here. Skia snaps the line height to a whole
    /// pixel first, WebKit works in whole pixels and drops a half, Chromium
    /// centres the font's em box instead of its line box (RULES.md). The
    /// engine keeps the one that is linear in the size, so a glyph on a curve
    /// sits at the same place at every zoom.
    pub fn middle_shift(&self, face: Face) -> Result<f64, Error> {
        let b = self.font_box_unrounded(face)?;
        Ok((b.ascent - b.descent) / 2.0)
    }

    /// Union of the outline boxes of the line, pen starting at x = 0 on the
    /// alphabetic baseline. Returns `(advance, x_min, y_min, x_max, y_max)`
    /// in pixels with y up, or no box when nothing has ink.
    fn run_extents(&mut self, face: Face, text: &str) -> Result<(f64, Option<Extent>), Error> {
        self.measure_line(face, text, ShapeMode::MEASURE)?;
        let mut origin = 0.0f64;
        let mut ext: Option<Extent> = None;
        for part in &self.parts {
            let entry = self.font(part.font)?;
            let scale = face.size / f64::from(entry.info.units_per_em);
            let extra = self.bold_extra(part.synth, face.size);
            // The ink of a synthesised bold is the ink of the way it is
            // drawn, and the rule that sets its advance sets that too
            // (`paint::BoldDraw::for_rule`): grown on every side when the
            // advance is unchanged, and under WebKit's rule the glyph drawn
            // again one `extra` to the right, which adds to its right edge
            // and to nothing else.
            let grow = if part.synth.bold && self.rules.bold_advance == BoldAdvance::Unchanged {
                bold_outset(face.size)
            } else {
                0.0
            };
            let mut pen = 0i64;
            for (n, g) in self.line[part.glyphs.clone()].iter().enumerate() {
                if let Some(b) = entry.glyph_bounds(g.id, part.synth.oblique) {
                    let ox = (pen + i64::from(g.x_offset)) as f64;
                    let oy = f64::from(g.y_offset);
                    // `shift` is zero for a single part without the WebKit
                    // bold rule, and adding 0.0 changes no bit of the result.
                    let shift = origin + n as f64 * extra;
                    let cur = (
                        shift + (ox + f64::from(b.x_min)) * scale - grow,
                        (oy + f64::from(b.y_min)) * scale - grow,
                        shift + (ox + f64::from(b.x_max)) * scale + grow + extra,
                        (oy + f64::from(b.y_max)) * scale + grow,
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
            origin += pen as f64 * scale + part.glyphs.len() as f64 * extra;
        }
        Ok((self.line_advance(face.size)?, ext))
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
