//! The engine: registered fonts, shaping, and the metric queries built on it.

use std::ops::Range;

use harfrust::{Buffer, Direction, Feature, ShapeOptions, ShapePlan, ShaperFont, Tag};
use unicode_linebreak::{break_property, BreakClass};

use crate::font::{FontEntry, FontInfo, PlanSlot, SharedBytes};
use crate::Error;

/// Handle of a fallback chain. Zero means "no chain": a letter the face lacks
/// is then its `.notdef` glyph.
pub type ChainId = u32;

/// What a synthesised bold does to an advance. The two browsers disagree, so
/// the rule is a switch and not a constant; RULES.md has the measurements.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BoldAdvance {
    /// Chromium and Skia: the bold outline is wider, the pen moves as before.
    #[default]
    Unchanged,
    /// WebKit: every glyph's advance grows by `size / 36`.
    WebKit,
}

/// Which line box `fontBox` reports.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FontBoxRule {
    /// What Chromium and WebKit report on macOS: `hhea`, scaled the way
    /// CoreText scales it, each value rounded to a whole pixel.
    #[default]
    Browser,
    /// What Skia with FreeType reports (the node test lane): the table ladder
    /// of [`crate::line_box`], unrounded.
    Skia,
}

/// The rule choices that are switches. Everything else is fixed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub bold_advance: BoldAdvance,
    pub font_box: FontBoxRule,
}

/// Share of the font size a WebKit synthetic bold adds to every glyph's
/// advance. Measured: 0.2222 px at 8 px through 2.6667 px at 96 px.
pub const WEBKIT_BOLD_ADVANCE: f64 = 1.0 / 36.0;

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

    pub fn bits(self) -> u32 {
        u32::from(self.bold) | u32::from(self.oblique) << 1
    }
}

/// A registered font at a size, with any synthesised style.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Face {
    pub font: FontId,
    pub size: f64,
    pub synth: Synth,
    /// Where a letter this font lacks is looked for, or zero.
    pub chain: ChainId,
}

impl Face {
    pub fn new(font: FontId, size: f64) -> Self {
        Self {
            font,
            size,
            synth: Synth::NONE,
            chain: 0,
        }
    }
}

/// A stretch of a measured line that is drawn from one font: the glyphs
/// `glyphs` of [`Engine::line`].
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub font: FontId,
    pub synth: Synth,
    pub glyphs: Range<usize>,
    /// The text it was shaped from, in UTF-16 units of the line. The parts of
    /// a line cover it end to end, in order, and one never ends inside a
    /// cluster: a letter and the marks on it are one font's.
    pub text: Range<u32>,
}

/// How one stretch of text is shaped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ShapeMode {
    /// Tab, LF, FF and CR are measured as a space, which is what a canvas
    /// does to a string before it measures it.
    pub canvas_space: bool,
    /// `liga` and `clig` off: what both browsers do to text that has letter
    /// spacing.
    pub no_ligatures: bool,
    /// `rand` off. HarfBuzz applies a font's random alternates by default,
    /// from a sequence that restarts with every buffer, so the width of a
    /// line is not the sum of its words and a breaker that tries many lines
    /// ends up choosing by the dice. WebKit does not apply the feature at
    /// all, and measured text here does not either (RULES.md).
    pub no_random: bool,
}

impl ShapeMode {
    pub const RAW: Self = Self {
        canvas_space: false,
        no_ligatures: false,
        no_random: false,
    };
    pub const MEASURE: Self = Self {
        canvas_space: true,
        no_ligatures: false,
        no_random: true,
    };

    /// Identifies the feature set, for the plan cache.
    pub(crate) fn feature_bits(self) -> u8 {
        u8::from(self.no_ligatures) | u8::from(self.no_random) << 1
    }
}

/// The characters a canvas replaces with U+0020 before measuring ("ASCII
/// whitespace" in the HTML standard, less the space itself).
pub(crate) fn is_canvas_space(ch: char) -> bool {
    matches!(ch, '\t' | '\n' | '\u{c}' | '\r')
}

/// Whether `ch` belongs to the letter before it: a combining mark, a joiner,
/// a variation selector or an emoji modifier. Such a character is never
/// drawn from a different font than its base.
pub(crate) fn extends_cluster(ch: char) -> bool {
    matches!(
        break_property(ch as u32),
        BreakClass::CombiningMark | BreakClass::ZeroWidthJoiner | BreakClass::EmojiModifier
    )
}

#[derive(Default)]
pub struct Engine {
    fonts: Vec<Option<FontEntry>>,
    chains: Vec<Option<Vec<(FontId, Synth)>>>,
    pub rules: Rules,
    /// Taken out for each shape call and put back, so a hot loop of `advance`
    /// calls reuses the glyph arrays instead of allocating them every time.
    buffer: Option<Buffer>,
    pub(crate) run: Vec<Glyph>,
    /// The glyphs of the last measured line, all its parts end to end, with
    /// clusters counted from the start of the line.
    pub(crate) line: Vec<Glyph>,
    pub(crate) parts: Vec<Part>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one face of a font file.
    pub fn add_font(&mut self, data: SharedBytes, face_index: u32) -> Result<FontId, Error> {
        let entry = FontEntry::new(data, face_index)?;
        Ok(self.insert(entry))
    }

    /// Registers font `of` again at another place on its variation axes
    /// (`FontEntry::instance`): a font of its own from then on, measured and
    /// drawn there, sharing the bytes of the first. `of` stays as it was.
    pub fn add_instance(
        &mut self,
        of: FontId,
        settings: &[(skrifa::raw::types::Tag, f32)],
    ) -> Result<FontId, Error> {
        let entry = self.font(of)?.instance(settings)?;
        Ok(self.insert(entry))
    }

    fn insert(&mut self, entry: FontEntry) -> FontId {
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
        idx as FontId + 1
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
        self.shape_mode(font, text, 0, ShapeMode::RAW)
    }

    /// [`Engine::shape`] with the ways measuring differs from raw shaping,
    /// and clusters counted from `base` (the UTF-16 offset of `text` in the
    /// line it was cut from).
    pub(crate) fn shape_mode(
        &mut self,
        font: FontId,
        text: &str,
        base: u32,
        mode: ShapeMode,
    ) -> Result<&[Glyph], Error> {
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
        let mut cluster = base;
        for ch in text.chars() {
            let shaped = if mode.canvas_space && is_canvas_space(ch) {
                ' '
            } else {
                ch
            };
            buffer.push(shaped as u32, cluster);
            cluster += ch.len_utf16() as u32;
        }
        buffer.guess_segment_properties();
        let shaper = ShaperFont::new(&entry.hb);
        let (script, direction) = (buffer.script(), buffer.direction());
        let mut plans = entry.plans.borrow_mut();
        let off = [
            Feature::new(Tag::new(b"rand"), 0, ..),
            Feature::new(Tag::new(b"liga"), 0, ..),
            Feature::new(Tag::new(b"clig"), 0, ..),
        ];
        let features: &[Feature] = match (mode.no_random, mode.no_ligatures) {
            (false, false) => &[],
            (true, false) => &off[..1],
            (false, true) => &off[1..],
            (true, true) => &off,
        };
        let bits = mode.feature_bits();
        let at = match plans
            .iter()
            .position(|p| p.script == script && p.direction == direction && p.features == bits)
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
                    features: bits,
                    plan: ShapePlan::new(&entry.hb, dir, script, None, features),
                });
                plans.len() - 1
            }
        };
        let options = ShapeOptions::new()
            .plan(Some(&plans[at].plan))
            .features(features);
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

    /// Registers an empty fallback chain and returns its handle.
    pub fn chain_new(&mut self) -> ChainId {
        let idx = match self.chains.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                self.chains.push(None);
                self.chains.len() - 1
            }
        };
        self.chains[idx] = Some(Vec::new());
        idx as ChainId + 1
    }

    /// Appends a font to a chain. Earlier fonts are preferred.
    pub fn chain_push(&mut self, chain: ChainId, font: FontId, synth: Synth) -> Result<(), Error> {
        self.font(font)?;
        self.chains
            .get_mut((chain as usize).wrapping_sub(1))
            .and_then(Option::as_mut)
            .ok_or(Error::UnknownFont)?
            .push((font, synth));
        Ok(())
    }

    pub fn chain_free(&mut self, chain: ChainId) -> bool {
        self.chains
            .get_mut((chain as usize).wrapping_sub(1))
            .is_some_and(|slot| slot.take().is_some())
    }

    /// Whether `font` can draw `text` with no `.notdef`: every character is
    /// in its character map, or shaping finds a way (a composed accent, a
    /// character the shaper hides).
    fn covers(&mut self, font: FontId, text: &str) -> bool {
        let Ok(entry) = self.font(font) else {
            return false;
        };
        let shaper = ShaperFont::new(&entry.hb);
        let mapped = |ch: char| {
            let ch = if is_canvas_space(ch) { ' ' } else { ch };
            shaper.nominal_glyph(ch as u32).is_some()
        };
        if text.chars().all(mapped) {
            return true;
        }
        match self.shape_mode(font, text, 0, ShapeMode::MEASURE) {
            Ok(run) => !run.is_empty() && run.iter().all(|g| g.id != 0),
            Err(_) => false,
        }
    }

    /// Shapes `text` for measuring and leaves it in `self.line` as one or
    /// more parts.
    ///
    /// Without a chain, or when the face has every letter, that is one part.
    /// Otherwise the line is cut where coverage changes: each cluster (a
    /// letter with the marks that belong to it) is drawn from the face
    /// itself if the face can, else from the font the part before it uses if
    /// that font can, else from the first font of the chain that can, else
    /// from the face as `.notdef`. Each part is shaped by itself, so there is
    /// no kerning across a change of font.
    pub(crate) fn measure_line(
        &mut self,
        face: Face,
        text: &str,
        mode: ShapeMode,
    ) -> Result<(), Error> {
        self.parts.clear();
        self.line.clear();
        self.shape_mode(face.font, text, 0, mode)?;
        let chain = match face.chain {
            0 => None,
            id => self
                .chains
                .get((id as usize).wrapping_sub(1))
                .and_then(Option::as_ref)
                .filter(|c| !c.is_empty()),
        };
        let whole = chain.is_none() || self.run.iter().all(|g| g.id != 0);
        if whole {
            std::mem::swap(&mut self.line, &mut self.run);
            self.parts.push(Part {
                font: face.font,
                synth: face.synth,
                glyphs: 0..self.line.len(),
                text: 0..text.encode_utf16().count() as u32,
            });
            return Ok(());
        }
        let mut fonts = vec![(face.font, face.synth)];
        fonts.extend(chain.into_iter().flatten().copied());
        // (byte range, UTF-16 offset, index into `fonts`), merged as they come.
        let mut cuts: Vec<(Range<usize>, u32, usize)> = Vec::new();
        let mut current = 0usize;
        let mut at16 = 0u32;
        let mut chars = text.char_indices().peekable();
        while let Some((start, ch)) = chars.next() {
            let mut end = start + ch.len_utf8();
            let mut len16 = ch.len_utf16() as u32;
            while let Some(&(_, next)) = chars.peek() {
                if !extends_cluster(next) {
                    break;
                }
                end += next.len_utf8();
                len16 += next.len_utf16() as u32;
                chars.next();
            }
            let cluster = &text[start..end];
            let base = &text[start..start + ch.len_utf8()];
            let order = |fonts_len: usize| {
                let mut order = vec![0usize];
                if current != 0 {
                    order.push(current);
                }
                order.extend((1..fonts_len).filter(|&i| i != current));
                order
            };
            let order = order(fonts.len());
            let pick = order
                .iter()
                .copied()
                .find(|&i| self.covers(fonts[i].0, cluster))
                .or_else(|| {
                    (base.len() < cluster.len())
                        .then(|| {
                            order
                                .iter()
                                .copied()
                                .find(|&i| self.covers(fonts[i].0, base))
                        })
                        .flatten()
                })
                .unwrap_or(0);
            current = pick;
            match cuts.last_mut() {
                Some((range, _, font)) if *font == pick => range.end = end,
                _ => cuts.push((start..end, at16, pick)),
            }
            at16 += len16;
        }
        for (range, base16, i) in cuts {
            let (font, synth) = fonts[i];
            let len16 = text[range.clone()].encode_utf16().count() as u32;
            self.shape_mode(font, &text[range], base16, mode)?;
            let from = self.line.len();
            self.line.extend_from_slice(&self.run);
            self.parts.push(Part {
                font,
                synth,
                glyphs: from..self.line.len(),
                text: base16..base16 + len16,
            });
        }
        Ok(())
    }

    /// What a synthesised bold adds to each glyph's advance, in pixels.
    pub(crate) fn bold_extra(&self, synth: Synth, size: f64) -> f64 {
        if synth.bold && self.rules.bold_advance == BoldAdvance::WebKit {
            size * WEBKIT_BOLD_ADVANCE
        } else {
            0.0
        }
    }

    /// Advance of the measured line in pixels.
    ///
    /// Each part is summed in integer font units and scaled once, so the
    /// result does not depend on the order glyph advances are added in.
    pub(crate) fn line_advance(&self, size: f64) -> Result<f64, Error> {
        let mut total = 0.0;
        for part in &self.parts {
            let upem = f64::from(self.font(part.font)?.info.units_per_em);
            let glyphs = &self.line[part.glyphs.clone()];
            let units: i64 = glyphs.iter().map(|g| i64::from(g.x_advance)).sum();
            total += units as f64 * size / upem;
            total += glyphs.len() as f64 * self.bold_extra(part.synth, size);
        }
        Ok(total)
    }

    /// Advance of `text` in pixels, without letter spacing: one shaped run,
    /// or one per font when the face's chain supplies a missing letter.
    pub fn advance(&mut self, face: Face, text: &str) -> Result<f64, Error> {
        self.measure_line(face, text, ShapeMode::MEASURE)?;
        self.line_advance(face.size)
    }

    /// The parts of the last measured line.
    pub fn parts(&self) -> &[Part] {
        &self.parts
    }

    /// Which font each stretch of `text` is drawn in, as one line of `face`:
    /// the parts `measure_line` cuts it into, which is what `advance`
    /// measures and what the painter paints. Nobody has to work out from
    /// coverage which family lent a letter: this is the answer itself.
    pub fn line_fonts(&mut self, face: Face, text: &str) -> Result<&[Part], Error> {
        self.measure_line(face, text, ShapeMode::MEASURE)?;
        Ok(&self.parts)
    }

    /// Code points of `text` the font has no glyph for (shaped to `.notdef`),
    /// as UTF-16 offsets.
    pub fn missing(&mut self, font: FontId, text: &str) -> Result<Vec<u32>, Error> {
        self.missing_in(Face::new(font, 1.0), text)
    }

    /// Like [`Engine::missing`], for a face: only what no font of its chain
    /// has either.
    pub fn missing_in(&mut self, face: Face, text: &str) -> Result<Vec<u32>, Error> {
        self.measure_line(face, text, ShapeMode::MEASURE)?;
        let mut out: Vec<u32> = self
            .line
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
