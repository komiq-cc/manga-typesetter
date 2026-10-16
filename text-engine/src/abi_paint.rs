//! The painter's exports: one call per job.
//!
//! The caller writes a job in its wire form (`paint::decode`) into the buffer
//! behind `mt_paint_job_reserve` and calls `mt_paint_job`. The pixels stay in
//! an engine-owned buffer until the next job or `mt_paint_job_release`.
//!
//! Kept apart from `abi.rs` so the two can change independently; the only
//! thing shared is the engine and its fonts.

use std::cell::RefCell;

use crate::abi::{with_engine, Status};
use crate::paint::{self, Raster};
use crate::Error;

#[derive(Default)]
struct State {
    job: Vec<u8>,
    pixels: Vec<u8>,
    /// `[x, y, width, height]` of the last raster, in device pixels. Boxed
    /// so its address survives the thread-local being moved into place.
    result: Box<[f64; 4]>,
    #[cfg(any(
        feature = "raster-tiny-skia",
        feature = "raster-zeno",
        feature = "raster-vello"
    ))]
    rasterizer: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// Largest job accepted, in bytes. A guard like the surface's: a job is its
/// text and its pattern tiles, and the largest the app can write is a few
/// megabytes.
pub const MAX_JOB_BYTES: usize = 1 << 28;

/// Returns the job buffer, grown to hold at least `capacity` bytes, or null
/// when `capacity` is more than [`MAX_JOB_BYTES`] or the memory is not to be
/// had. The pointer stays valid until the next call with a larger capacity.
///
/// A refusal changes nothing: the buffer is as it was and the engine paints
/// the next job as if this call had not been made. (Growing a `Vec` past
/// what the allocator can give aborts, which in wasm is a trap that leaves
/// this module's state borrowed for good.)
#[no_mangle]
pub extern "C" fn mt_paint_job_reserve(capacity: usize) -> *mut u8 {
    with(|s| {
        if s.job.len() < capacity {
            let more = capacity - s.job.len();
            if capacity > MAX_JOB_BYTES || s.job.try_reserve_exact(more).is_err() {
                return core::ptr::null_mut();
            }
            s.job.resize(capacity, 0);
        }
        s.job.as_mut_ptr()
    })
}

/// Paints the job in the first `byte_len` bytes of the job buffer.
///
/// Returns 1 when something was drawn: `mt_paint_job_result` then holds
/// `[x, y, width, height]` and `mt_paint_job_pixels` points at
/// `width * height * 4` bytes of straight-alpha RGBA8. Returns 0 when the
/// job draws nothing, or a negative [`Status`].
#[no_mangle]
pub extern "C" fn mt_paint_job(byte_len: usize) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let painted = (|| -> Result<Option<Raster>, Error> {
            let _budget = paint::budget::Scope::new();
            let request = paint::decode(s.job.get(..byte_len).ok_or(Error::BadSpec)?)?;
            #[cfg(any(
                feature = "raster-tiny-skia",
                feature = "raster-zeno",
                feature = "raster-vello"
            ))]
            let rasterizer = paint::compare::by_id(s.rasterizer).ok_or(Error::BadSpec)?;
            #[cfg(not(any(
                feature = "raster-tiny-skia",
                feature = "raster-zeno",
                feature = "raster-vello"
            )))]
            let rasterizer: &dyn paint::Rasterizer = &paint::Exact;
            with_engine(|engine| paint::paint_job_with(engine, &request, rasterizer))
        })();
        match painted {
            Ok(Some(raster)) => {
                *s.result = [
                    f64::from(raster.x),
                    f64::from(raster.y),
                    f64::from(raster.width),
                    f64::from(raster.height),
                ];
                s.pixels = raster.data;
                1
            }
            Ok(None) => 0,
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// Paints the box job in the first `byte_len` bytes of the job buffer: a
/// glyph job and the shadows, the blur, the smear and the mask that go with
/// it (`paint::decode_box`).
///
/// The result is read as a glyph job's is: 1 when something was drawn, with
/// `mt_paint_job_result` and `mt_paint_job_pixels` holding it; 0 when the
/// box draws nothing; or a negative [`Status`].
#[no_mangle]
pub extern "C" fn mt_paint_box(byte_len: usize) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let painted = (|| -> Result<Option<Raster>, Error> {
            let _budget = paint::budget::Scope::new();
            let mut request = paint::decode_box(s.job.get(..byte_len).ok_or(Error::BadSpec)?)?;
            with_engine(|engine| paint::paint_box(engine, &mut request))
        })();
        match painted {
            Ok(Some(raster)) => {
                *s.result = [
                    f64::from(raster.x),
                    f64::from(raster.y),
                    f64::from(raster.width),
                    f64::from(raster.height),
                ];
                s.pixels = raster.data;
                1
            }
            Ok(None) => 0,
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// The version of the box job wire form this build reads.
#[no_mangle]
pub extern "C" fn mt_paint_box_wire_version() -> u32 {
    paint::BOX_WIRE_VERSION
}

/// Draws one tile of a pattern fill: `kind` as [`paint::PatternKind`]
/// numbers them, `side` pixels square, `fg` over `bg` (both `0xRRGGBBAA`),
/// a hairline `line` of the tile wide.
///
/// Returns 1 with the tile in `mt_paint_job_pixels` as straight RGBA8 and
/// `mt_paint_job_result` holding `[0, 0, side, side]`, or a negative
/// [`Status`]. The tile is a raster like any other: the next job replaces
/// it.
#[no_mangle]
pub extern "C" fn mt_paint_pattern_tile(kind: u32, side: u32, fg: u32, bg: u32, line: f64) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let drawn = (|| -> Result<Vec<u8>, Error> {
            let _budget = paint::budget::Scope::new();
            let kind = paint::PatternKind::from_id(kind).ok_or(Error::BadSpec)?;
            paint::pattern_tile(
                kind,
                paint::Rgba::from_u32(fg),
                paint::Rgba::from_u32(bg),
                side,
                line,
                &paint::Exact,
            )
        })();
        match drawn {
            Ok(pixels) => {
                *s.result = [0.0, 0.0, f64::from(side), f64::from(side)];
                s.pixels = pixels;
                1
            }
            Err(e) => Status::from(e) as i32,
        }
    })
}

#[no_mangle]
pub extern "C" fn mt_paint_job_result() -> *const f64 {
    with(|s| s.result.as_ptr())
}

#[no_mangle]
pub extern "C" fn mt_paint_job_pixels() -> *const u8 {
    with(|s| s.pixels.as_ptr())
}

/// Frees the last raster. Optional: the next job replaces it anyway.
#[no_mangle]
pub extern "C" fn mt_paint_job_release() {
    with(|s| s.pixels = Vec::new());
}

/// The version of the job wire form this build reads.
#[no_mangle]
pub extern "C" fn mt_paint_wire_version() -> u32 {
    paint::WIRE_VERSION
}

/// Picks the rasteriser for the jobs that follow: 0 exact area (the one the
/// painter ships with), 1 tiny-skia, 2 zeno, 3 vello_cpu. Returns 0, or -5 for an unknown
/// id. Only in a comparison build.
#[cfg(any(
    feature = "raster-tiny-skia",
    feature = "raster-zeno",
    feature = "raster-vello"
))]
#[no_mangle]
pub extern "C" fn mt_paint_rasterizer(id: u32) -> i32 {
    if paint::compare::by_id(id).is_none() {
        return Status::BadSpec as i32;
    }
    with(|s| s.rasterizer = id);
    0
}
