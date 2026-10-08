//! The engine: registered fonts, shaping, and the metric queries built on it.

use harfrust::{Buffer, Direction, ShapeOptions, ShapePlan, ShaperFont};

use crate::font::{FontEntry, FontInfo, PlanSlot, SharedBytes};
use crate::Error;

/// Handle of a registered font. Zero is never a valid id, so a failed call
/// across the C ABI can return it.
pub type FontId = u32;

/// One shaped glyph in font units.
///
/// The layout is the wire format too: six 32-bit fields, read from JS as an
/// `Int32Array`. Positions stay integers in font units so a comparison with
/// HarfBuzz is exact rather than within a tolerance.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Glyph {
    pub id: u32,
    /// UTF-16 code unit offset of the cluster in the input, because that is
    /// what a JS string index is.
    pub cluster: u32,
    pub x_advance: i32,
    pub y_advance: i32,
    pub x_offset: i32,
    pub y_offset: i32,
}

/// Request for a style the font file does not contain.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Synth {
    pub bold: bool,
    pub oblique: bool,
}

impl Synth {
    pub const NONE: Self = Self {
        bold: false,
        oblique: false,
    };

    pub fn from_bits(bits: u32) -> Self {
        Self {
            bold: bits & 1 != 0,
            oblique: bits & 2 != 0,
        }
    }
}

/// A registered font at a size, with any synthesised style.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Face {
    pub font: FontId,
    pub size: f64,
    pub synth: Synth,
}

impl Face {
    pub fn new(font: FontId, size: f64) -> Self {
        Self {
            font,
            size,
            synth: Synth::NONE,
        }
    }
}

#[derive(Default)]
pub struct Engine {
    fonts: Vec<Option<FontEntry>>,
    /// Taken out for each shape call and put back, so a hot loop of `advance`
    /// calls reuses the glyph arrays instead of allocating them every time.
    buffer: Option<Buffer>,
    pub(crate) run: Vec<Glyph>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one face of a font file.
    pub fn add_font(&mut self, data: SharedBytes, face_index: u32) -> Result<FontId, Error> {
        let entry = FontEntry::new(data, face_index)?;
        let slot = self.fonts.iter().position(Option::is_none);
        let idx = match slot {
            Some(i) => {
                self.fonts[i] = Some(entry);
                i
            }
            None => {
                self.fonts.push(Some(entry));
                self.fonts.len() - 1
            }
        };
        Ok(idx as FontId + 1)
    }

    /// Registers another face of a file that is already loaded, without a
    /// second copy of the bytes. This is how the faces of a TTC are added.
    pub fn add_sibling_face(&mut self, of: FontId, face_index: u32) -> Result<FontId, Error> {
        let data = self.font(of)?.shared_bytes();
        self.add_font(data, face_index)
    }

    pub fn add_font_bytes(&mut self, bytes: Vec<u8>, face_index: u32) -> Result<FontId, Error> {
        self.add_font(std::sync::Arc::new(bytes), face_index)
    }

    pub fn remove_font(&mut self, id: FontId) -> bool {
        let Some(slot) = self.fonts.get_mut((id as usize).wrapping_sub(1)) else {
            return false;
        };
        slot.take().is_some()
    }

    pub fn font(&self, id: FontId) -> Result<&FontEntry, Error> {
        self.fonts
            .get((id as usize).wrapping_sub(1))
            .and_then(Option::as_ref)
            .ok_or(Error::UnknownFont)
    }

    pub fn info(&self, id: FontId) -> Result<&FontInfo, Error> {
        Ok(&self.font(id)?.info)
    }

    /// Shapes `text` as one left-to-right-or-guessed run with the font's
    /// default features and leaves the glyphs in `self.run`.
    ///
    /// Script and direction are guessed from the text exactly as
    /// `hb_buffer_guess_segment_properties` does, which is what the HarfBuzz
    /// reference in the parity check is asked to do as well.
    pub fn shape(&mut self, font: FontId, text: &str) -> Result<&[Glyph], Error> {
        self.run.clear();
        let entry = self
            .fonts
            .get((font as usize).wrapping_sub(1))
            .and_then(Option::as_ref)
            .ok_or(Error::UnknownFont)?;
        if text.is_empty() {
            return Ok(&self.run);
        }
        let mut buffer = self.buffer.take().unwrap_or_default();
        buffer.clear();
        let mut cluster = 0u32;
        for ch in text.chars() {
            buffer.push(ch as u32, cluster);
            cluster += ch.len_utf16() as u32;
        }
        buffer.guess_segment_properties();
        let shaper = ShaperFont::new(&entry.hb);
        let (script, direction) = (buffer.script(), buffer.direction());
        let mut plans = entry.plans.borrow_mut();
        let at = match plans
            .iter()
            .position(|p| p.script == script && p.direction == direction)
        {
            Some(i) => i,
            None => {
                let dir = if direction == Direction::Invalid {
                    Direction::LeftToRight
                } else {
                    direction
                };
                plans.push(PlanSlot {
                    script,
                    direction,
                    plan: ShapePlan::new(&entry.hb, dir, script, None, &[]),
                });
                plans.len() - 1
            }
        };
        let options = ShapeOptions::new().plan(Some(&plans[at].plan));
        let shaped = harfrust::shape(&shaper, &mut buffer, options);
        if shaped.is_ok() {
            let infos = buffer.glyph_infos();
            let positions = buffer.glyph_positions();
            self.run.reserve(infos.len());
            for (info, pos) in infos.iter().zip(positions) {
                self.run.push(Glyph {
                    id: info.glyph_id,
                    cluster: info.cluster,
                    x_advance: pos.x_advance,
                    y_advance: pos.y_advance,
                    x_offset: pos.x_offset,
                    y_offset: pos.y_offset,
                });
            }
        }
        drop(plans);
        self.buffer = Some(buffer);
        shaped.map_err(|_| Error::Shape)?;
        Ok(&self.run)
    }

    /// The glyphs of the last `shape` call.
    pub fn last_run(&self) -> &[Glyph] {
        &self.run
    }

    /// Sum of the run's advances in font units.
    pub fn advance_units(&mut self, font: FontId, text: &str) -> Result<i64, Error> {
        let run = self.shape(font, text)?;
        Ok(run.iter().map(|g| i64::from(g.x_advance)).sum())
    }

    /// Advance of `text` shaped as one run, in pixels, without letter spacing.
    ///
    /// Summed in integer font units and scaled once, so the result does not
    /// depend on the order glyph advances are added in.
    pub fn advance(&mut self, face: Face, text: &str) -> Result<f64, Error> {
        let upem = f64::from(self.font(face.font)?.info.units_per_em);
        let units = self.advance_units(face.font, text)?;
        Ok(units as f64 * face.size / upem)
    }

    /// Code points of `text` the font has no glyph for (shaped to `.notdef`),
    /// as UTF-16 offsets.
    pub fn missing(&mut self, font: FontId, text: &str) -> Result<Vec<u32>, Error> {
        let run = self.shape(font, text)?;
        let mut out: Vec<u32> = run
            .iter()
            .filter(|g| g.id == 0)
            .map(|g| g.cluster)
            .collect();
        out.dedup();
        Ok(out)
    }

    /// Memory the engine holds for one font: the file plus caches.
    pub fn font_bytes_held(&self, id: FontId) -> Result<usize, Error> {
        let entry = self.font(id)?;
        Ok(entry.info.byte_len + entry.cache_bytes())
    }
}
