//! Font registry: bytes in, a shaping font plus the facts the app asks about.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;

use harfrust::{Direction, Script, ShapePlan};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::prelude::{LocationRef, Size};
use skrifa::raw::types::{NameId, Tag};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, GlyphId, MetadataProvider};

use crate::Error;

/// Font bytes shared between the shaper's font and the outline reader.
///
/// One allocation serves both: a CJK collection is tens of MB and the wasm
/// heap never shrinks, so a second copy would be paid for the whole session.
pub type SharedBytes = Arc<dyn AsRef<[u8]> + Send + Sync>;

/// Ascender and descender as one table states them, in font units.
///
/// `descent` is positive below the baseline, the canvas convention.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LineBox {
    pub ascent: f64,
    pub descent: f64,
    pub line_gap: f64,
}

/// The three vertical metric sets a font can state, kept apart so the choice
/// between them is a rule the engine owns rather than a side effect of a
/// library default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VerticalMetrics {
    pub hhea: Option<LineBox>,
    pub typo: Option<LineBox>,
    pub win: Option<LineBox>,
    pub use_typo_metrics: bool,
}

/// One variation axis in user coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct AxisInfo {
    pub tag: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

/// What the app needs to know about a face without shaping anything.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontInfo {
    pub family: String,
    pub subfamily: String,
    pub full_name: String,
    pub postscript_name: String,
    /// Name ID 16, which groups a whole family where name ID 1 splits it into
    /// four-style groups.
    pub typographic_family: String,
    pub units_per_em: u16,
    pub glyph_count: u32,
    pub axes: Vec<AxisInfo>,
    pub vertical: VerticalMetrics,
    /// TrueType outlines (a `glyf` table) rather than CFF. CoreText scales the
    /// two kinds of font with different arithmetic, which shows in the line
    /// box (see `metrics.rs`).
    pub truetype: bool,
    /// `head.yMin` and `head.yMax`, the box of all glyphs, in font units.
    pub bbox_y: Option<(i16, i16)>,
    /// Number of faces in the file this face came from (more than 1 for TTC).
    pub faces_in_file: u32,
    pub byte_len: usize,
}

impl FontInfo {
    pub fn is_variable(&self) -> bool {
        !self.axes.is_empty()
    }
}

/// Tight outline bounds of one glyph in font units, y up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphBounds {
    pub x_min: f32,
    pub y_min: f32,
    pub x_max: f32,
    pub y_max: f32,
}

/// Glyph ids are small and dense, and a bounds lookup happens once per glyph
/// of every measured line, so the default SipHash would dominate `lineInk`.
#[derive(Default)]
pub struct GlyphHasher(u64);

impl Hasher for GlyphHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    fn write_u32(&mut self, n: u32) {
        self.0 = u64::from(n).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

type GlyphMap<V> = HashMap<u32, V, BuildHasherDefault<GlyphHasher>>;

pub(crate) struct PlanSlot {
    pub script: Option<Script>,
    pub direction: Direction,
    /// Which optional features the plan was built without
    /// (`ShapeMode::feature_bits`).
    pub features: u8,
    pub plan: ShapePlan,
}

pub struct FontEntry {
    data: SharedBytes,
    index: u32,
    /// The shaping font, AT THIS ENTRY'S PLACE on the font's variation axes:
    /// the default one for a font registered from its file, another for an
    /// instance (`instance`). Its normalized coordinates are what outlines
    /// are drawn at too, so what is measured and what is painted are one
    /// instance.
    pub(crate) hb: harfrust::Font,
    /// The axis values this entry was moved to, in user units; empty at the
    /// font's default. Kept so an instance of an instance adds to them.
    location: Vec<(Tag, f32)>,
    pub info: FontInfo,
    /// Building a plan costs far more than shaping a short line with it, and
    /// a font sees a handful of script/direction pairs at most.
    pub(crate) plans: RefCell<Vec<PlanSlot>>,
    /// Keyed by glyph id and whether the synthetic slant is applied, because
    /// a slanted outline's box is not the slanted box of the upright outline.
    bounds: RefCell<[GlyphMap<Option<GlyphBounds>>; 2]>,
}

/// Horizontal shear of the synthetic oblique: x moves by this share of y.
///
/// The value Skia and Chromium use for a faked italic (`SK_Scalar1 / 4`),
/// confirmed against Skia in `parity/synth.mjs`.
pub const OBLIQUE_SKEW: f32 = 0.25;

impl FontEntry {
    pub fn new(data: SharedBytes, index: u32) -> Result<Self, Error> {
        let bytes: &[u8] = (*data).as_ref();
        let font = FontRef::from_index(bytes, index).map_err(|_| Error::BadFont)?;
        let hb = harfrust::Font::new(Arc::clone(&data), index).ok_or(Error::BadFont)?;
        let info = read_info(&font, &hb, bytes);
        Ok(Self {
            data,
            index,
            hb,
            location: Vec::new(),
            info,
            plans: RefCell::new(Vec::new()),
            bounds: RefCell::new([GlyphMap::default(), GlyphMap::default()]),
        })
    }

    /// The same face at another place on its variation axes: `settings` are
    /// axis tags and values in user units (`wght` 700). An axis not named
    /// stays where this entry has it, a value past an axis' range is brought
    /// to its end, and an axis the font does not have is ignored - so on a
    /// font with no axes this is the font again.
    ///
    /// The bytes are shared, not copied. Shaping, advances, outlines, bounds
    /// and the line box are all read at the new place; the PostScript name
    /// is the instance's (`instance_postscript_name`). Everything else in
    /// `info` describes the file, as it does for the default.
    pub fn instance(&self, settings: &[(Tag, f32)]) -> Result<Self, Error> {
        let bytes: &[u8] = (*self.data).as_ref();
        let font = FontRef::from_index(bytes, self.index).map_err(|_| Error::BadFont)?;
        let mut location = self.location.clone();
        for &(tag, value) in settings {
            if !value.is_finite() {
                return Err(Error::BadSpec);
            }
            let Some(axis) = font.axes().iter().find(|a| a.tag() == tag) else {
                continue;
            };
            let value = value.clamp(axis.min_value(), axis.max_value());
            match location.iter_mut().find(|(t, _)| *t == tag) {
                Some(at) => at.1 = value,
                None => location.push((tag, value)),
            }
        }
        let hb = self
            .hb
            .instance_builder()
            .variations(location.iter().copied())
            .build();
        let mut info = read_info(&font, &hb, bytes);
        if let Some(name) = instance_postscript_name(&font, &location) {
            info.postscript_name = name;
        }
        Ok(Self {
            data: Arc::clone(&self.data),
            index: self.index,
            hb,
            location,
            info,
            plans: RefCell::new(Vec::new()),
            bounds: RefCell::new([GlyphMap::default(), GlyphMap::default()]),
        })
    }

    /// Where this entry is on the font's axes, as `(tag, user value)`; empty
    /// at the default.
    pub fn location(&self) -> &[(Tag, f32)] {
        &self.location
    }

    pub fn bytes(&self) -> &[u8] {
        (*self.data).as_ref()
    }

    pub(crate) fn shared_bytes(&self) -> SharedBytes {
        Arc::clone(&self.data)
    }

    /// The table directory is re-read per call on purpose: it is a few dozen
    /// bytes, and holding a borrowing `FontRef` beside the bytes it borrows
    /// would need a self-referential struct.
    pub(crate) fn font_ref(&self) -> Option<FontRef<'_>> {
        FontRef::from_index(self.bytes(), self.index).ok()
    }

    /// Sends one glyph's unhinted outline, in font units, to `pen`.
    pub fn draw_glyph(&self, glyph: u32, pen: &mut impl OutlinePen) -> bool {
        let Some(font) = self.font_ref() else {
            return false;
        };
        let Some(outline) = font.outline_glyphs().get(GlyphId::new(glyph)) else {
            return false;
        };
        // No coordinates at the font's default, which is `LocationRef::default()`.
        let location = LocationRef::new(self.hb.normalized_coords());
        let settings = DrawSettings::unhinted(Size::unscaled(), location);
        outline.draw(settings, pen).is_ok()
    }

    /// Tight bounds of a glyph's outline, or `None` for a glyph with no ink.
    pub fn glyph_bounds(&self, glyph: u32, oblique: bool) -> Option<GlyphBounds> {
        let slot = usize::from(oblique);
        if let Some(hit) = self.bounds.borrow()[slot].get(&glyph) {
            return *hit;
        }
        let mut pen = BoundsPen::new(if oblique { OBLIQUE_SKEW } else { 0.0 });
        let found = if self.draw_glyph(glyph, &mut pen) {
            pen.finish()
        } else {
            None
        };
        self.bounds.borrow_mut()[slot].insert(glyph, found);
        found
    }

    /// Bytes this entry holds beyond the font file itself. An estimate from
    /// container lengths, good enough to see growth.
    pub fn cache_bytes(&self) -> usize {
        let bounds = self.bounds.borrow();
        let per_bound = std::mem::size_of::<(u32, Option<GlyphBounds>)>();
        (bounds[0].capacity() + bounds[1].capacity()) * per_bound
    }
}

fn read_info(font: &FontRef<'_>, hb: &harfrust::Font, bytes: &[u8]) -> FontInfo {
    let name = |id: NameId| {
        font.localized_strings(id)
            .english_or_first()
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    let metrics = hb.metrics();
    let line = |l: skrifa::raw::model::metrics::LineBox| LineBox {
        ascent: f64::from(l.ascender.to_f32()),
        descent: -f64::from(l.descender.to_f32()),
        line_gap: f64::from(l.line_gap.to_f32()),
    };
    let vertical = VerticalMetrics {
        hhea: metrics.hhea_line.map(line),
        typo: metrics.typo_line.map(line),
        // usWinDescent is stored positive-down already; the model reports it
        // as a descender below zero like the other two.
        win: metrics.win_line.map(|w| LineBox {
            ascent: f64::from(w.ascender.to_f32()),
            descent: -f64::from(w.descender.to_f32()),
            line_gap: 0.0,
        }),
        use_typo_metrics: metrics.use_typo_metrics,
    };
    let axes = font
        .axes()
        .iter()
        .map(|a| AxisInfo {
            tag: a.tag().to_string(),
            min: a.min_value(),
            default: a.default_value(),
            max: a.max_value(),
        })
        .collect();
    let faces_in_file = match skrifa::raw::FileRef::new(bytes) {
        Ok(skrifa::raw::FileRef::Collection(c)) => c.len(),
        _ => 1,
    };
    FontInfo {
        family: name(NameId::FAMILY_NAME),
        subfamily: name(NameId::SUBFAMILY_NAME),
        full_name: name(NameId::FULL_NAME),
        postscript_name: name(NameId::POSTSCRIPT_NAME),
        typographic_family: name(NameId::TYPOGRAPHIC_FAMILY_NAME),
        units_per_em: metrics.units_per_em,
        glyph_count: metrics.num_glyphs,
        axes,
        vertical,
        truetype: font.table_data(Tag::new(b"glyf")).is_some(),
        bbox_y: font.head().ok().map(|h| (h.y_min(), h.y_max())),
        faces_in_file,
        byte_len: bytes.len(),
    }
}

/// The PostScript name of a variable font at `location`, by Adobe's rule for
/// naming instances (Technical Note 5902), or `None` at the font's default,
/// whose name is the font's own name ID 6.
///
/// - A named instance of the font at exactly this place that states a
///   PostScript name: that name.
/// - Otherwise a prefix - name ID 25, else the typographic family, else the
///   family, letters and digits only - and then `-` and the named
///   instance's subfamily name (letters and digits only) when the place is a
///   named instance, or `_<value><tag>` for every axis away from its default
///   when it is not: `STIXTwoTextRoman-Bold`, `STIXTwoTextRoman_650wght`.
///
/// The note's last step, a hash in place of a name longer than 127
/// characters, is not taken: the name is cut at 127.
fn instance_postscript_name(font: &FontRef<'_>, location: &[(Tag, f32)]) -> Option<String> {
    let axes = font.axes();
    // Every axis' value at this place, in the font's axis order.
    let at: Vec<f32> = axes
        .iter()
        .map(|a| {
            location
                .iter()
                .find(|(tag, _)| *tag == a.tag())
                .map_or(a.default_value(), |(_, v)| *v)
        })
        .collect();
    if axes
        .iter()
        .zip(&at)
        .all(|(a, v)| (a.default_value() - v).abs() < 1e-3)
    {
        return None;
    }
    let text = |id: skrifa::string::StringId| {
        font.localized_strings(id)
            .english_or_first()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    let plain = |s: String| -> String { s.chars().filter(char::is_ascii_alphanumeric).collect() };
    let named = font.named_instances().iter().find(|inst| {
        let coords: Vec<f32> = inst.user_coords().collect();
        coords.len() == at.len() && coords.iter().zip(&at).all(|(a, b)| (a - b).abs() < 1e-3)
    });
    if let Some(name) = named
        .as_ref()
        .and_then(|inst| inst.postscript_name_id())
        .and_then(text)
    {
        return Some(name);
    }
    let prefix = text(NameId::VARIATIONS_POSTSCRIPT_NAME_PREFIX)
        .or_else(|| text(NameId::TYPOGRAPHIC_FAMILY_NAME).map(plain))
        .or_else(|| text(NameId::FAMILY_NAME).map(plain))
        .filter(|s| !s.is_empty())?;
    let mut name = prefix;
    match named.and_then(|inst| text(inst.subfamily_name_id())) {
        Some(style) => {
            name.push('-');
            name.push_str(&plain(style));
        }
        None => {
            for (axis, value) in axes.iter().zip(&at) {
                if (axis.default_value() - value).abs() < 1e-3 {
                    continue;
                }
                // Whole numbers as they are, the rest to three places with
                // the trailing zeroes gone.
                let mut number = format!("{value:.3}");
                if number.contains('.') {
                    number = number
                        .trim_end_matches('0')
                        .trim_end_matches('.')
                        .to_string();
                }
                name.push('_');
                name.push_str(&number);
                name.push_str(axis.tag().to_string().trim());
            }
        }
    }
    name.truncate(127);
    Some(name)
}

/// Collects the exact extent of an outline, curve extrema included.
///
/// The control-point box would be cheaper but overstates the ink wherever an
/// off-curve point sticks out past the curve, which is most round glyphs.
pub struct BoundsPen {
    skew: f32,
    cur: (f32, f32),
    b: Option<GlyphBounds>,
}

impl BoundsPen {
    pub fn new(skew: f32) -> Self {
        Self {
            skew,
            cur: (0.0, 0.0),
            b: None,
        }
    }

    pub fn finish(self) -> Option<GlyphBounds> {
        self.b.filter(|b| b.x_max > b.x_min || b.y_max > b.y_min)
    }

    fn map(&self, x: f32, y: f32) -> (f32, f32) {
        (x + self.skew * y, y)
    }

    fn add(&mut self, p: (f32, f32)) {
        let b = self.b.get_or_insert(GlyphBounds {
            x_min: p.0,
            y_min: p.1,
            x_max: p.0,
            y_max: p.1,
        });
        b.x_min = b.x_min.min(p.0);
        b.y_min = b.y_min.min(p.1);
        b.x_max = b.x_max.max(p.0);
        b.y_max = b.y_max.max(p.1);
    }
}

fn quad_at(p0: f32, p1: f32, p2: f32, t: f32) -> f32 {
    let u = 1.0 - t;
    u * u * p0 + 2.0 * u * t * p1 + t * t * p2
}

fn cubic_at(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let u = 1.0 - t;
    u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3
}

/// Parameters in (0, 1) where a cubic's derivative on one axis is zero.
fn cubic_extrema(p0: f32, p1: f32, p2: f32, p3: f32) -> [Option<f32>; 2] {
    let a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
    let b = 2.0 * (p0 - 2.0 * p1 + p2);
    let c = p1 - p0;
    let inside = |t: f32| (t > 0.0 && t < 1.0).then_some(t);
    if a.abs() < 1e-9 {
        if b.abs() < 1e-9 {
            return [None, None];
        }
        return [inside(-c / b), None];
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return [None, None];
    }
    let s = disc.sqrt();
    [inside((-b + s) / (2.0 * a)), inside((-b - s) / (2.0 * a))]
}

impl OutlinePen for BoundsPen {
    fn move_to(&mut self, x: f32, y: f32) {
        // A lone move_to draws nothing, so it must not widen the box.
        self.cur = self.map(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.map(x, y);
        self.add(self.cur);
        self.add(p);
        self.cur = p;
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let c = self.map(cx0, cy0);
        let p = self.map(x, y);
        let s = self.cur;
        self.add(s);
        self.add(p);
        let tx = {
            let d = s.0 - 2.0 * c.0 + p.0;
            (d.abs() > 1e-9).then(|| (s.0 - c.0) / d)
        };
        let ty = {
            let d = s.1 - 2.0 * c.1 + p.1;
            (d.abs() > 1e-9).then(|| (s.1 - c.1) / d)
        };
        for t in [tx, ty].into_iter().flatten() {
            if t > 0.0 && t < 1.0 {
                self.add((quad_at(s.0, c.0, p.0, t), quad_at(s.1, c.1, p.1, t)));
            }
        }
        self.cur = p;
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let c0 = self.map(cx0, cy0);
        let c1 = self.map(cx1, cy1);
        let p = self.map(x, y);
        let s = self.cur;
        self.add(s);
        self.add(p);
        let ts = cubic_extrema(s.0, c0.0, c1.0, p.0)
            .into_iter()
            .chain(cubic_extrema(s.1, c0.1, c1.1, p.1));
        for t in ts.flatten() {
            self.add((
                cubic_at(s.0, c0.0, c1.0, p.0, t),
                cubic_at(s.1, c0.1, c1.1, p.1, t),
            ));
        }
        self.cur = p;
    }

    fn close(&mut self) {}
}
