//! The SFX layout exports: letters measured by the engine, placed by
//! [`crate::sfx::layout`].
//!
//! The caller writes the text (its rows joined by `\n`) into the text buffer
//! (`mt_text_reserve`), the recipe in its wire form (`sfx::decode_params`)
//! into the buffer behind `mt_sfx_params_reserve`, and calls `mt_sfx_layout`.
//! The answer is in the shared out buffer, as `mt_line_carets` leaves its.
//!
//! Kept apart from `abi.rs` for the reason `abi_paint.rs` is: the only thing
//! shared is the engine and its fonts. These exports are newer than the ABI
//! number, as `mt_line_carets` is: adding one changes no existing signature
//! or layout, and a loader that needs them tests for them.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::abi::{face, with_engine_text, with_out, Status};
use crate::paint::budget;
use crate::sfx::{self, Params};
use crate::Error;

#[derive(Default)]
struct State {
    params: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// Largest recipe accepted, in bytes. Eight moves are 160; the rest is a
/// guard like the paint job's.
pub const MAX_PARAMS_BYTES: usize = 1 << 16;

/// Returns the params buffer, grown to hold at least `capacity` bytes, or
/// null when `capacity` is more than [`MAX_PARAMS_BYTES`] or the memory is
/// not to be had. The pointer stays valid until the next call with a larger
/// capacity.
#[no_mangle]
pub extern "C" fn mt_sfx_params_reserve(capacity: usize) -> *mut u8 {
    with(|s| {
        if s.params.len() < capacity {
            let more = capacity - s.params.len();
            if capacity > MAX_PARAMS_BYTES || s.params.try_reserve_exact(more).is_err() {
                return core::ptr::null_mut();
            }
            s.params.resize(capacity, 0);
        }
        s.params.as_mut_ptr()
    })
}

/// Eight `f64` per code point, in the order of [`sfx::Placed`]: x, y, rot,
/// sx, sy, skew, w, drip.
pub const RECORD_F64S: usize = 8;

/// Places the code points of the text buffer's first `text_len` bytes, which
/// are rows joined by `\n`, as the recipe in the params buffer's first
/// `params_len` bytes says. Each code point's advance is measured the way
/// `mt_advance` measures that one code point, in the face `font`, `size`,
/// `flags`.
///
/// Returns the code point count `n` (newlines are not counted). The out
/// buffer then holds `n` records of [`RECORD_F64S`] little-endian `f64`, in
/// text order. A negative [`Status`] otherwise, and the out buffer is empty:
/// among others `BadSpec` for a recipe that is malformed or has a number
/// that is not finite, or an answer that is not (a size so large that the
/// advances overflow).
#[no_mangle]
pub extern "C" fn mt_sfx_layout(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    params_len: usize,
) -> i32 {
    let params =
        with(|s| sfx::decode_params(s.params.get(..params_len).ok_or(Error::BadSpec)?, size));
    let run = |engine: &mut crate::Engine, text: &str, out: &mut Vec<u8>| -> Result<i32, Error> {
        let _budget = budget::Scope::new();
        out.clear();
        let params: Params = params?;
        let face = face(font, size, flags);
        let mut rows: Vec<Vec<f64>> = Vec::new();
        budget::reserve_raw(&mut rows, text.split('\n').count())?;
        // One measurement per distinct code point.
        let mut seen: HashMap<char, f64> = HashMap::new();
        let mut buf = [0u8; 4];
        for line in text.split('\n') {
            let mut row = Vec::new();
            budget::reserve_raw(&mut row, line.chars().count())?;
            for c in line.chars() {
                let adv = match seen.get(&c) {
                    Some(&a) => a,
                    None => {
                        let a = engine.advance(face, c.encode_utf8(&mut buf))?;
                        seen.insert(c, a);
                        a
                    }
                };
                row.push(adv);
            }
            rows.push(row);
        }
        let want: usize = rows.iter().map(Vec::len).sum();
        let placed = sfx::layout(&rows, &params);
        // An empty answer to a text with letters is a refusal (see `layout`).
        if placed.len() != want {
            return Err(Error::BadSpec);
        }
        budget::reserve_raw(out, placed.len() * RECORD_F64S * 8)?;
        for p in &placed {
            for v in [p.x, p.y, p.rot, p.sx, p.sy, p.skew, p.w, p.drip] {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        Ok(placed.len() as i32)
    };
    // A failed call leaves the out buffer empty (`with_engine_text`).
    match with_engine_text(text_len, run) {
        Ok(n) => n,
        Err(e) => Status::from(e) as i32,
    }
}

/// The points of a warp grid (see `sfx::mesh`): `kind` is the envelope's
/// index in `sfx::ENVELOPES`, the grid `cols` by `rows` cells over a box `w`
/// by `h`, bent by `bend`.
///
/// Returns the point count `n`, which is `(cols + 1) * (rows + 1)` and never
/// zero. The out buffer then holds `n` pairs of little-endian `f64` (x, y),
/// row-major, top-left first. `BadSpec` otherwise (an unknown kind, a number
/// that is not finite, a box or grid that is empty or too big), and the out
/// buffer is empty.
#[no_mangle]
pub extern "C" fn mt_sfx_envelope(
    kind: u32,
    bend: f64,
    cols: u32,
    rows: u32,
    w: f64,
    h: f64,
) -> i32 {
    let run = |out: &mut Vec<u8>| -> Result<i32, Error> {
        let _budget = budget::Scope::new();
        out.clear();
        let kind = sfx::Envelope::from_index(kind).ok_or(Error::BadSpec)?;
        let pts = sfx::mesh(kind, bend, cols as usize, rows as usize, w, h);
        if pts.is_empty() {
            return Err(Error::BadSpec);
        }
        budget::reserve_raw(out, pts.len() * 16)?;
        for p in &pts {
            out.extend_from_slice(&p[0].to_le_bytes());
            out.extend_from_slice(&p[1].to_le_bytes());
        }
        Ok(pts.len() as i32)
    };
    with_out(|out| match run(out) {
        Ok(n) => n,
        Err(e) => {
            out.clear();
            Status::from(e) as i32
        }
    })
}

/// The kinds, the built-in presets and the warp ids as one JSON document (see
/// `sfx::info_json`): ASCII bytes in the out buffer. Returns their count.
#[no_mangle]
pub extern "C" fn mt_sfx_info() -> i32 {
    let json = sfx::info_json();
    with_out(|out| {
        out.clear();
        out.extend_from_slice(json.as_bytes());
    });
    json.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{mt_advance, mt_alloc, mt_font_add, mt_out_len, mt_out_ptr, mt_text_reserve};
    use crate::sfx::{Flow, Kind, Move};

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

    fn set_params(b: &[u8]) -> usize {
        let ptr = mt_sfx_params_reserve(b.len());
        assert!(!ptr.is_null());
        // SAFETY: the params buffer holds at least `b.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(b.as_ptr(), ptr, b.len()) };
        b.len()
    }

    /// `line height, letter spacing, amount, row shift, seed, flow, moves`.
    fn wire(flow: u32, moves: &[(u32, f64, f64)]) -> Vec<u8> {
        let mut b = Vec::new();
        for v in [30.0f64, 1.5, 1.0, 0.25] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&7u32.to_le_bytes());
        b.extend_from_slice(&flow.to_le_bytes());
        b.extend_from_slice(&(moves.len() as u32).to_le_bytes());
        for &(k, a, bb) in moves {
            b.extend_from_slice(&k.to_le_bytes());
            b.extend_from_slice(&a.to_le_bytes());
            b.extend_from_slice(&bb.to_le_bytes());
        }
        b
    }

    fn out() -> Vec<f64> {
        let (ptr, len) = (mt_out_ptr(), mt_out_len());
        // SAFETY: the out buffer holds `len` bytes at `ptr`.
        let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
        bytes
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn layout_measures_each_code_point_like_advance_and_places_it() {
        let font = load("ComicNeue-Regular.ttf");
        let text = "WAVE\nOh!\n\nfi";
        let moves = [(2u32, 0.3, 1.0), (6, 0.5, 0.0), (19, -10.0, 0.0)];
        let n = mt_sfx_layout(font, 24.0, 0, set_text(text), set_params(&wire(0, &moves)));
        assert_eq!(n, 9, "newlines are not letters");
        let got = out();
        assert_eq!(got.len(), 9 * RECORD_F64S);
        // The same call by hand.
        let rows: Vec<Vec<f64>> = text
            .split('\n')
            .map(|line| {
                line.chars()
                    .map(|c| {
                        let s = c.to_string();
                        mt_advance(font, 24.0, 0, set_text(&s))
                    })
                    .collect()
            })
            .collect();
        let want = sfx::layout(
            &rows,
            &Params {
                size: 24.0,
                line_height: 30.0,
                letter_spacing: 1.5,
                amount: 1.0,
                seed: 7,
                flow: Flow::Row,
                row_shift: 0.25,
                moves: vec![
                    Move {
                        kind: Kind::Wave,
                        a: 0.3,
                        b: 1.0,
                    },
                    Move {
                        kind: Kind::Grow,
                        a: 0.5,
                        b: 0.0,
                    },
                    Move {
                        kind: Kind::Slant,
                        a: -10.0,
                        b: 0.0,
                    },
                ],
            },
        );
        assert_eq!(want.len(), 9);
        for (rec, p) in got.chunks(RECORD_F64S).zip(&want) {
            assert_eq!(rec, [p.x, p.y, p.rot, p.sx, p.sy, p.skew, p.w, p.drip]);
            assert!(rec[6] > 0.0);
        }
        // `fi` is two code points here, one advance each.
        assert_eq!(got[7 * RECORD_F64S + 6], want[7].w);
        // Stack flow gives the same letters, one to a row.
        let n = mt_sfx_layout(font, 24.0, 0, set_text("ab"), set_params(&wire(1, &[])));
        assert_eq!(n, 2);
        let two = out();
        // The wire's row shift is 0.25 em, 6 px at 24.
        assert!(
            (two[RECORD_F64S] - two[0] - 6.0).abs() < 1e-9,
            "one column, shifted"
        );
        assert!(
            (two[RECORD_F64S + 1] - two[1] - 30.0).abs() < 1e-9,
            "a line apart"
        );
    }

    #[test]
    fn layout_refuses_what_it_cannot_place_and_leaves_nothing_behind() {
        let font = load("DejaVuSans.ttf");
        let t = set_text("abc");
        let good = wire(0, &[(0, 1.0, 0.0)]);
        assert_eq!(mt_sfx_layout(font, 20.0, 0, t, set_params(&good)), 3);
        // An unknown font, a size that is not a number, a kind that is not
        // in the table, a flow that is not, a recipe the buffer lacks.
        assert_eq!(
            mt_sfx_layout(9999, 20.0, 0, t, set_params(&good)),
            Status::UnknownFont as i32
        );
        assert_eq!(mt_out_len(), 0);
        for (size, p) in [
            (f64::NAN, good.clone()),
            (f64::INFINITY, good.clone()),
            (20.0, wire(0, &[(99, 1.0, 0.0)])),
            (20.0, wire(2, &[])),
            (20.0, wire(0, &[(0, f64::NAN, 0.0)])),
        ] {
            let len = set_params(&p);
            assert_eq!(mt_sfx_layout(font, size, 0, t, len), Status::BadSpec as i32);
            assert_eq!(mt_out_len(), 0);
        }
        assert_eq!(
            mt_sfx_layout(font, 20.0, 0, t, MAX_PARAMS_BYTES),
            Status::BadSpec as i32
        );
        // Text that is not UTF-8.
        let p = mt_text_reserve(2);
        // SAFETY: two bytes fit; 0xFF 0xFE is never valid UTF-8.
        unsafe { p.copy_from(&[0xFFu8, 0xFE] as *const u8, 2) };
        assert_eq!(
            mt_sfx_layout(font, 20.0, 0, 2, set_params(&good)),
            Status::BadText as i32
        );
        // No text is no letters, and the params are still checked.
        assert_eq!(
            mt_sfx_layout(font, 20.0, 0, set_text(""), set_params(&good)),
            0
        );
        assert_eq!(
            mt_sfx_layout(font, 20.0, 0, set_text("\n\n"), set_params(&good)),
            0
        );
        // The buffer refuses what is over the limit and changes nothing.
        assert!(mt_sfx_params_reserve(MAX_PARAMS_BYTES + 1).is_null());
    }

    #[test]
    fn layout_records_are_eight_numbers_with_the_drip_last() {
        let font = load("DejaVuSans.ttf");
        let drip = sfx::KINDS
            .iter()
            .position(|k| k.kind == Kind::Drip)
            .unwrap() as u32;
        let t = set_text("DRIP");
        let n = mt_sfx_layout(font, 20.0, 0, t, set_params(&wire(0, &[(drip, 1.0, 1.0)])));
        assert_eq!(n, 4);
        let got = out();
        assert_eq!(RECORD_F64S, 8);
        assert_eq!(got.len(), 4 * 8);
        assert!(
            got.chunks(8).all(|r| r[7] >= 8.0 && r[7] <= 20.0),
            "{got:?}"
        );
        // No drip move: the last number is zero in every record.
        let n = mt_sfx_layout(font, 20.0, 0, t, set_params(&wire(0, &[])));
        assert_eq!(n, 4);
        assert!(out().chunks(8).all(|r| r[7] == 0.0));
    }

    #[test]
    fn envelope_gives_the_mesh_and_refuses_what_it_cannot_make() {
        for (i, kind) in sfx::ENVELOPES.iter().enumerate() {
            let n = mt_sfx_envelope(i as u32, 0.6, 4, 2, 120.0, 40.0);
            assert_eq!(n, 15, "{kind:?}");
            let got = out();
            assert_eq!(got.len(), 15 * 2);
            let want = sfx::mesh(*kind, 0.6, 4, 2, 120.0, 40.0);
            assert_eq!(want.len(), 15);
            for (g, w) in got.chunks(2).zip(&want) {
                assert_eq!(g, w);
            }
        }
        let good = |kind, bend, cols, rows, w, h| mt_sfx_envelope(kind, bend, cols, rows, w, h);
        assert_eq!(good(0, 0.5, 2, 1, 100.0, 40.0), 6);
        for status in [
            good(99, 0.5, 2, 1, 100.0, 40.0),
            good(0, f64::NAN, 2, 1, 100.0, 40.0),
            good(0, f64::INFINITY, 2, 1, 100.0, 40.0),
            good(0, 0.5, 0, 1, 100.0, 40.0),
            good(0, 0.5, 2, 65, 100.0, 40.0),
            good(0, 0.5, 2, 1, 0.0, 40.0),
            good(0, 0.5, 2, 1, 100.0, -1.0),
        ] {
            assert_eq!(status, Status::BadSpec as i32);
            assert_eq!(mt_out_len(), 0);
        }
    }

    #[test]
    fn info_is_the_json_in_the_out_buffer() {
        let n = mt_sfx_info();
        assert_eq!(n as usize, mt_out_len());
        // SAFETY: the out buffer holds `n` bytes at its pointer.
        let bytes = unsafe { core::slice::from_raw_parts(mt_out_ptr(), n as usize) };
        let json = core::str::from_utf8(bytes).unwrap();
        assert_eq!(json, sfx::info_json());
        assert!(json.starts_with("{\"kinds\":["));
        assert!(json.ends_with("\"envelopes\":[\"arch\",\"valley\",\"flag\",\"rise\"]}"));
    }
}
