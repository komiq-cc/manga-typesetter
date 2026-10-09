//! The C ABI the wasm build exports.
//!
//! Every export is a plain function over integers and floats. Text arrives as
//! UTF-8 that the caller wrote into the buffer returned by `mt_text_reserve`;
//! fixed-size answers come back in the 16-slot `f64` result buffer, lists in
//! the byte buffer behind `mt_out_ptr`, glyphs behind `mt_run_ptr`.
//!
//! Status convention: functions that fill a buffer return a count `>= 0`, or
//! a negative [`Status`] code. `mt_advance` returns NaN on failure because its
//! return value is the answer itself and the call is too hot for a second
//! round trip.
//!
//! The exports are compiled for native builds as well, so the ABI layer is
//! covered by `cargo test` and not only by the node checks.

use std::cell::RefCell;
use std::sync::Arc;

use crate::engine::{BoldAdvance, Engine, Face, FontBoxRule, Synth};
use crate::memory::{self, AbiBytes};
use crate::wrap::WrapOptions;
use crate::{Error, ABI_VERSION};

/// Number of `f64` slots behind `mt_result_ptr`.
pub const RESULT_SLOTS: usize = 16;

#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    BadFont = -1,
    UnknownFont = -2,
    BadText = -3,
    Shape = -4,
    BadSpec = -5,
}

impl From<Error> for Status {
    fn from(e: Error) -> Self {
        match e {
            Error::BadFont => Self::BadFont,
            Error::UnknownFont => Self::UnknownFont,
            Error::BadText => Self::BadText,
            Error::Shape => Self::Shape,
            Error::BadSpec => Self::BadSpec,
        }
    }
}

struct State {
    engine: Engine,
    text: Vec<u8>,
    out: Vec<u8>,
    #[cfg(feature = "paint")]
    scene: Option<crate::paint::Scene>,
    /// Boxed so its address survives the thread-local being moved into place.
    result: Box<[f64; RESULT_SLOTS]>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        engine: Engine::new(),
        text: Vec::new(),
        out: Vec::new(),
        #[cfg(feature = "paint")]
        scene: None,
        result: Box::new([0.0; RESULT_SLOTS]),
    });
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// Runs `f` with the engine the exports share, for exports that live in
/// another file (`abi_paint.rs`).
#[cfg(feature = "paint")]
pub(crate) fn with_engine<R>(f: impl FnOnce(&mut Engine) -> R) -> R {
    with(|s| f(&mut s.engine))
}

/// Runs `f` with the engine and the first `len` bytes of the text buffer.
/// A rejected query leaves no previous or partial answer in either buffer.
fn with_text<R>(
    len: usize,
    f: impl FnOnce(&mut Engine, &str, &mut State2<'_>) -> Result<R, Error>,
) -> Result<R, Error> {
    with(|s| {
        let State {
            engine,
            text,
            out,
            result,
            ..
        } = s;
        let answer = (|| {
            let bytes = text.get(..len).ok_or(Error::BadText)?;
            let text = core::str::from_utf8(bytes).map_err(|_| Error::BadText)?;
            f(engine, text, &mut State2 { out, result })
        })();
        if answer.is_err() {
            out.clear();
            result.fill(0.0);
        }
        answer
    })
}

/// The output buffers, split from the engine so both can be borrowed at once.
struct State2<'a> {
    out: &'a mut Vec<u8>,
    result: &'a mut [f64; RESULT_SLOTS],
}

fn code<T: Into<i32>>(r: Result<T, Error>) -> i32 {
    match r {
        Ok(v) => v.into(),
        Err(e) => Status::from(e) as i32,
    }
}

/// `flags`: bit 0 synthetic bold, bit 1 synthetic oblique, bits 8 and up the
/// fallback chain's handle (zero for none). Every nonzero handle must still
/// be held, including for a font-box or empty-text query: otherwise the
/// answer is `UnknownFont` (NaN for `mt_advance`).
fn face(font: u32, size: f64, flags: u32) -> Face {
    Face {
        font,
        size,
        synth: Synth::from_bits(flags),
        chain: flags >> 8,
    }
}

/// Rule switches for `mt_rule_set`.
pub const RULE_BOLD_ADVANCE: u32 = 1;
pub const RULE_FONT_BOX: u32 = 2;

fn put_u32s(out: &mut Vec<u8>, values: impl IntoIterator<Item = u32>) -> i32 {
    out.clear();
    let mut n = 0i32;
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
        n += 1;
    }
    n
}

#[no_mangle]
pub extern "C" fn mt_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn mt_alloc(byte_len: usize) -> *mut u8 {
    memory::alloc(byte_len)
}

/// # Safety
///
/// `ptr` must be null or come from `mt_alloc(byte_len)` and not be used again.
#[no_mangle]
pub unsafe extern "C" fn mt_free(ptr: *mut u8, byte_len: usize) {
    // SAFETY: forwarded contract.
    unsafe { memory::free(ptr, byte_len) }
}

/// Live heap bytes of the wasm instance; zero in a native build, which does
/// not install the counting allocator.
#[no_mangle]
pub extern "C" fn mt_heap_live() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        memory::counting::LIVE.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Returns the text buffer, grown to hold at least `capacity` bytes. The
/// pointer stays valid until the next call with a larger capacity.
#[no_mangle]
pub extern "C" fn mt_text_reserve(capacity: usize) -> *mut u8 {
    with(|s| {
        if s.text.len() < capacity {
            s.text.resize(capacity, 0);
        }
        s.text.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn mt_result_ptr() -> *const f64 {
    with(|s| s.result.as_ptr())
}

#[no_mangle]
pub extern "C" fn mt_out_ptr() -> *const u8 {
    with(|s| s.out.as_ptr())
}

#[no_mangle]
pub extern "C" fn mt_out_len() -> usize {
    with(|s| s.out.len())
}

/// Glyphs of the last shape call: `mt_shape`'s return value times six `i32`.
#[no_mangle]
pub extern "C" fn mt_run_ptr() -> *const u8 {
    with(|s| s.engine.last_run().as_ptr().cast())
}

/// Registers face `face_index` of the font file at `ptr`. Takes ownership of
/// the allocation whether or not the font is accepted. Returns the font id,
/// or 0 if the bytes are not a readable font.
///
/// # Safety
///
/// `ptr` must come from `mt_alloc(byte_len)` and hold `byte_len` initialised
/// bytes; the caller must not free or reuse it.
#[no_mangle]
pub unsafe extern "C" fn mt_font_add(ptr: *mut u8, byte_len: usize, face_index: u32) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: forwarded contract; ownership moves into `AbiBytes`.
    let bytes = unsafe { AbiBytes::from_raw(ptr, byte_len) };
    with(|s| s.engine.add_font(Arc::new(bytes), face_index).unwrap_or(0))
}

/// Registers another face of the file `font` was loaded from, sharing its
/// bytes. Returns the new id or 0.
#[no_mangle]
pub extern "C" fn mt_font_add_sibling(font: u32, face_index: u32) -> u32 {
    with(|s| s.engine.add_sibling_face(font, face_index).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn mt_font_remove(font: u32) -> i32 {
    with(|s| i32::from(s.engine.remove_font(font)))
}

/// Describes a font. Numbers go to the result buffer:
///
/// `[units_per_em, glyph_count, axis_count, faces_in_file, byte_len,
///   use_typo_metrics, present_mask, hhea_asc, hhea_desc, hhea_gap,
///   typo_asc, typo_desc, typo_gap, win_asc, win_desc, truetype_outlines]`
///
/// where `present_mask` has bit 0 for `hhea`, 1 for typo, 2 for win. Strings
/// go to the out buffer as UTF-8 lines: family, subfamily, full name,
/// PostScript name, typographic family, then one `tag min default max` line
/// per axis. Returns the number of result slots written.
#[no_mangle]
pub extern "C" fn mt_font_info(font: u32) -> i32 {
    with(|s| {
        let info = match s.engine.info(font) {
            Ok(i) => i,
            Err(e) => return Status::from(e) as i32,
        };
        let v = &info.vertical;
        let mask = u32::from(v.hhea.is_some())
            | u32::from(v.typo.is_some()) << 1
            | u32::from(v.win.is_some()) << 2;
        let (h, t, w) = (
            v.hhea.unwrap_or_default(),
            v.typo.unwrap_or_default(),
            v.win.unwrap_or_default(),
        );
        let numbers: [f64; RESULT_SLOTS] = [
            f64::from(info.units_per_em),
            f64::from(info.glyph_count),
            info.axes.len() as f64,
            f64::from(info.faces_in_file),
            info.byte_len as f64,
            f64::from(u8::from(v.use_typo_metrics)),
            f64::from(mask),
            h.ascent,
            h.descent,
            h.line_gap,
            t.ascent,
            t.descent,
            t.line_gap,
            w.ascent,
            w.descent,
            f64::from(u8::from(info.truetype)),
        ];
        s.result[..numbers.len()].copy_from_slice(&numbers);
        let mut text = [
            info.family.as_str(),
            info.subfamily.as_str(),
            info.full_name.as_str(),
            info.postscript_name.as_str(),
            info.typographic_family.as_str(),
        ]
        .map(|line| line.replace('\n', " "))
        .join("\n");
        for a in &info.axes {
            text.push_str(&format!("\n{} {} {} {}", a.tag, a.min, a.default, a.max));
        }
        s.out.clear();
        s.out.extend_from_slice(text.as_bytes());
        numbers.len() as i32
    })
}

/// Bytes held for one font: the file plus the engine's caches for it.
#[no_mangle]
pub extern "C" fn mt_font_bytes_held(font: u32) -> f64 {
    with(|s| {
        s.engine
            .font_bytes_held(font)
            .map_or(f64::NAN, |b| b as f64)
    })
}

/// Sets one of the rules that are switches. Returns 0, or `BadSpec` for an
/// unknown rule or value.
///
/// - `RULE_BOLD_ADVANCE` (1): 0 a synthetic bold leaves advances alone
///   (Chromium), 1 it adds `size / 36` to every glyph (WebKit).
/// - `RULE_FONT_BOX` (2): 0 the browsers' whole-pixel `hhea` box, 1 Skia's
///   unrounded table ladder.
#[no_mangle]
pub extern "C" fn mt_rule_set(rule: u32, value: u32) -> i32 {
    with(|s| {
        let rules = &mut s.engine.rules;
        match (rule, value) {
            (RULE_BOLD_ADVANCE, 0) => rules.bold_advance = BoldAdvance::Unchanged,
            (RULE_BOLD_ADVANCE, 1) => rules.bold_advance = BoldAdvance::WebKit,
            (RULE_FONT_BOX, 0) => rules.font_box = FontBoxRule::Browser,
            (RULE_FONT_BOX, 1) => rules.font_box = FontBoxRule::Skia,
            _ => return Status::BadSpec as i32,
        }
        0
    })
}

/// Makes an empty fallback chain and returns its handle (never zero).
#[no_mangle]
pub extern "C" fn mt_chain_new() -> u32 {
    with(|s| s.engine.chain_new())
}

/// Appends `font`, with the styles to synthesise for it, to a chain.
#[no_mangle]
pub extern "C" fn mt_chain_push(chain: u32, font: u32, flags: u32) -> i32 {
    with(
        |s| match s.engine.chain_push(chain, font, Synth::from_bits(flags)) {
            Ok(()) => 0,
            Err(e) => Status::from(e) as i32,
        },
    )
}

#[no_mangle]
pub extern "C" fn mt_chain_free(chain: u32) -> i32 {
    with(|s| i32::from(s.engine.chain_free(chain)))
}

/// Advance in pixels of the first `text_len` bytes of the text buffer. NaN on
/// failure.
#[no_mangle]
pub extern "C" fn mt_advance(font: u32, size: f64, flags: u32, text_len: usize) -> f64 {
    with_text(text_len, |engine, text, _| {
        engine.advance(face(font, size, flags), text)
    })
    .unwrap_or(f64::NAN)
}

/// Writes `[ascent, descent]` to the result buffer.
#[no_mangle]
pub extern "C" fn mt_font_box(font: u32, size: f64, flags: u32) -> i32 {
    with(|s| match s.engine.font_box(face(font, size, flags)) {
        Ok(b) => {
            s.result[0] = b.ascent;
            s.result[1] = b.descent;
            2
        }
        Err(e) => {
            s.out.clear();
            s.result.fill(0.0);
            Status::from(e) as i32
        }
    })
}

fn put_ink(result: &mut [f64; RESULT_SLOTS], ink: crate::Ink) -> i32 {
    let has_ink = f64::from(u8::from(ink.has_ink));
    result[..6].copy_from_slice(&[
        ink.width,
        ink.left,
        ink.right,
        ink.ascent,
        ink.descent,
        has_ink,
    ]);
    6
}

/// Writes `[width, left, right, ascent, descent, has_ink]` for a left-aligned line on
/// the alphabetic baseline.
#[no_mangle]
pub extern "C" fn mt_line_ink(font: u32, size: f64, flags: u32, text_len: usize) -> i32 {
    code(with_text(text_len, |engine, text, st| {
        let ink = engine.line_ink(face(font, size, flags), text)?;
        Ok(put_ink(st.result, ink))
    }))
}

/// Writes `[width, left, right, ascent, descent, has_ink]` for one glyph anchored at
/// its centre on the `middle` baseline.
#[no_mangle]
pub extern "C" fn mt_glyph_ink(font: u32, size: f64, flags: u32, text_len: usize) -> i32 {
    code(with_text(text_len, |engine, text, st| {
        let ink = engine.glyph_ink(face(font, size, flags), text)?;
        Ok(put_ink(st.result, ink))
    }))
}

/// Shapes the text and returns the glyph count; read them at `mt_run_ptr`.
#[no_mangle]
pub extern "C" fn mt_shape(font: u32, text_len: usize) -> i32 {
    code(with_text(text_len, |engine, text, _| {
        Ok(engine.shape(font, text)?.len() as i32)
    }))
}

/// Wraps the text and returns the line count; the out buffer then holds one
/// `(start, end)` pair of `u32` UTF-16 offsets per line.
#[no_mangle]
pub extern "C" fn mt_wrap_plain(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    width: f64,
    letter_spacing: f64,
) -> i32 {
    code(with_text(text_len, |engine, text, st| {
        let opts = WrapOptions {
            width,
            letter_spacing,
        };
        let lines = engine.wrap_plain(face(font, size, flags), text, opts)?;
        put_u32s(st.out, lines.iter().flat_map(|l| [l.start, l.end]));
        Ok(lines.len() as i32)
    }))
}

/// Returns how many clusters have no glyph in the font or in the chain that
/// `flags` names; the out buffer holds their UTF-16 offsets as `u32`.
#[no_mangle]
pub extern "C" fn mt_missing(font: u32, flags: u32, text_len: usize) -> i32 {
    code(with_text(text_len, |engine, text, st| {
        let missing = engine.missing_in(face(font, 1.0, flags), text)?;
        Ok(put_u32s(st.out, missing))
    }))
}

/// Starts a scene: a transparent `width` x `height` surface and the canvas
/// transform `(a, b, c, d, e, f)` from user space to it. Replaces any scene
/// in progress.
#[cfg(feature = "paint")]
#[no_mangle]
pub extern "C" fn mt_paint_begin(
    width: u32,
    height: u32,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
) -> i32 {
    with(
        |s| match crate::paint::Scene::new(width, height, [a, b, c, d, e, f]) {
            Ok(scene) => {
                s.scene = Some(scene);
                0
            }
            Err(err) => Status::from(err) as i32,
        },
    )
}

/// Adds the text buffer's first `text_len` bytes as a line whose origin is at
/// (`x`, `y`) on the alphabetic baseline, in user space.
#[cfg(feature = "paint")]
#[no_mangle]
pub extern "C" fn mt_paint_line(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    x: f64,
    y: f64,
) -> i32 {
    with(|s| {
        let State {
            engine,
            text,
            scene,
            ..
        } = s;
        let mut run = || -> Result<i32, Error> {
            let bytes = text.get(..text_len).ok_or(Error::BadText)?;
            let text = core::str::from_utf8(bytes).map_err(|_| Error::BadText)?;
            let scene = scene.as_mut().ok_or(Error::BadSpec)?;
            scene.add_line(engine, face(font, size, flags), text, x, y)?;
            Ok(0)
        };
        code(run())
    })
}

/// Strokes all lines added so far, round join, pen `line_width` user units
/// wide (canvas `lineWidth`), colour `0xRRGGBBAA`.
#[cfg(feature = "paint")]
#[no_mangle]
pub extern "C" fn mt_paint_stroke(line_width: f32, rgba: u32) -> i32 {
    with(|s| match s.scene.as_mut() {
        Some(scene) => code(
            scene
                .stroke(line_width, crate::paint::Rgba::from_u32(rgba))
                .map(|()| 0),
        ),
        None => Status::BadSpec as i32,
    })
}

/// Fills all lines added so far with the solid colour `0xRRGGBBAA`.
#[cfg(feature = "paint")]
#[no_mangle]
pub extern "C" fn mt_paint_fill(rgba: u32) -> i32 {
    with(|s| match s.scene.as_mut() {
        Some(scene) => code(scene.fill(crate::paint::Rgba::from_u32(rgba)).map(|()| 0)),
        None => Status::BadSpec as i32,
    })
}

/// Ends the scene and moves its pixels to the out buffer as straight-alpha
/// RGBA8, `width * height * 4` bytes. Returns that byte count.
#[cfg(feature = "paint")]
#[no_mangle]
pub extern "C" fn mt_paint_end() -> i32 {
    with(|s| match s.scene.take() {
        Some(scene) => match scene.try_into_rgba() {
            Ok(out) => {
                s.out = out;
                i32::try_from(s.out.len()).unwrap_or(Status::BadSpec as i32)
            }
            Err(e) => {
                s.out.clear();
                Status::from(e) as i32
            }
        },
        None => Status::BadSpec as i32,
    })
}

/// Where a caret stands on a painted line: the pen position of every cluster
/// of the text buffer's first `text_len` bytes, as the painter places them.
///
/// The line is shaped by `paint::shape_run`, the call the painter makes for a
/// straight run, with the same face and the same letter spacing, so every
/// position is the painter's: its letter spacing after each cluster, its
/// synthesised bold's advance, its fallback parts, its ligatures on or off.
/// Nothing is measured a second time here.
///
/// Returns the cluster count `n`. The out buffer then holds `n + 1` pairs of
/// little-endian `f64`: per cluster, its UTF-16 offset in the line and the x
/// of its first glyph's pen (the glyph's origin less its own x offset), in
/// pixels from the line's start, in the order the clusters are drawn; then
/// one closing pair, the text's length in UTF-16 units and the line's
/// advance. The advance is the number `align_offset` centres the line by.
///
/// A size or a letter spacing that is not a finite number is `BadSpec`:
/// every position would be NaN or infinite, and a caller told "n clusters"
/// would draw a caret from them.
#[cfg(feature = "paint")]
#[no_mangle]
pub extern "C" fn mt_line_carets(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    letter_spacing: f64,
) -> i32 {
    if !size.is_finite() || !letter_spacing.is_finite() {
        with(|s| {
            s.out.clear();
            s.result.fill(0.0);
        });
        return Status::BadSpec as i32;
    }
    code(with_text(text_len, |engine, text, st| {
        let run = crate::paint::shape_run(engine, face(font, size, flags), text, letter_spacing)?;
        st.out.clear();
        let mut n = 0i32;
        let mut last = None;
        // `shape_run` leaves the measured line in the engine, glyph for glyph
        // with what it placed.
        for (placed, glyph) in run.glyphs.iter().zip(engine.line.iter()) {
            if last == Some(glyph.cluster) {
                continue;
            }
            last = Some(glyph.cluster);
            let upem = f64::from(engine.font(placed.font)?.info.units_per_em);
            let pen = placed.x - f64::from(glyph.x_offset) * (size / upem);
            st.out
                .extend_from_slice(&f64::from(glyph.cluster).to_le_bytes());
            st.out.extend_from_slice(&pen.to_le_bytes());
            n += 1;
        }
        let len16 = text.encode_utf16().count() as f64;
        st.out.extend_from_slice(&len16.to_le_bytes());
        st.out.extend_from_slice(&run.advance.to_le_bytes());
        Ok(n)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(name: &str) -> u32 {
        let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(path).unwrap();
        let ptr = mt_alloc(bytes.len());
        // SAFETY: `ptr` holds `bytes.len()` writable bytes from `mt_alloc`.
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
        // SAFETY: the allocation is initialised and handed over.
        unsafe { mt_font_add(ptr, bytes.len(), 0) }
    }

    fn set_text(s: &str) -> usize {
        let ptr = mt_text_reserve(s.len());
        // SAFETY: the text buffer holds at least `s.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(s.as_ptr(), ptr, s.len()) };
        s.len()
    }

    #[test]
    fn advance_matches_the_engine_through_the_abi() {
        let id = load("ComicNeue-Regular.ttf");
        assert_ne!(id, 0);
        let n = set_text("WHAT THE HELL?!");
        let through_abi = mt_advance(id, 22.5, 0, n);
        let direct = with(|s| s.engine.advance(Face::new(id, 22.5), "WHAT THE HELL?!"));
        assert_eq!(Ok(through_abi), direct);
        assert!(through_abi > 0.0);
    }

    #[test]
    fn rejected_fonts_and_bad_utf8_report_failure() {
        let ptr = mt_alloc(64);
        // SAFETY: 64 writable bytes from `mt_alloc`, zeroed before use.
        unsafe { core::ptr::write_bytes(ptr, 0, 64) };
        // SAFETY: initialised allocation, ownership handed over.
        assert_eq!(unsafe { mt_font_add(ptr, 64, 0) }, 0);

        let id = load("DejaVuSans.ttf");
        let p = mt_text_reserve(2);
        // SAFETY: two bytes fit; 0xFF 0xFE is never valid UTF-8.
        unsafe { p.copy_from(&[0xFFu8, 0xFE] as *const u8, 2) };
        assert!(mt_advance(id, 16.0, 0, 2).is_nan());
        assert_eq!(mt_shape(id, 2), Status::BadText as i32);
        assert_eq!(mt_shape(9999, 0), Status::UnknownFont as i32);
    }

    #[test]
    fn font_info_reports_names_and_metrics() {
        let id = load("Bangers-Regular.ttf");
        assert_eq!(mt_font_info(id), 16);
        let (upem, names) = with(|s| (s.result[0], String::from_utf8(s.out.clone()).unwrap()));
        assert_eq!(upem, 1000.0);
        let mut lines = names.lines();
        assert_eq!(lines.next(), Some("Bangers"));
        assert_eq!(lines.nth(2), Some("Bangers-Regular"));
    }
}
