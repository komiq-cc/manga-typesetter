//! `mt-text`: font parsing, shaping, metrics and glyph raster for
//! manga-typesetter.
//!
//! One crate, built twice: natively for `cargo test`, and as
//! `wasm32-unknown-unknown` for the app, where JS calls the `mt_*` exports in
//! [`abi`] synchronously. See `SPIKE.md` for what this spike measured.
//!
//! Ownership across the ABI:
//!
//! - `mt_alloc(len)` returns a pointer into linear memory; the caller owns it
//!   until `mt_free(ptr, len)` or until it is handed to `mt_font_add`, which
//!   always takes it.
//! - `mt_text_reserve`, `mt_result_ptr`, `mt_out_ptr` and `mt_run_ptr` return
//!   engine-owned buffers. A pointer from them is valid until the next call
//!   that writes the same buffer, and any view over `memory.buffer` is void
//!   after linear memory grows.
//! - A panic aborts (`panic = "abort"`): in wasm that is a trap, after which
//!   the instance must be thrown away.

pub mod abi;
#[cfg(feature = "paint")]
pub mod abi_paint;
mod engine;
mod font;
pub mod memory;
mod metrics;
#[cfg(feature = "paint")]
pub mod paint;
mod wrap;

pub use engine::{Engine, Face, FontId, Glyph, Synth};
pub use font::{
    AxisInfo, BoundsPen, FontEntry, FontInfo, GlyphBounds, LineBox, SharedBytes, VerticalMetrics,
    OBLIQUE_SKEW,
};
pub use metrics::{bold_outset, line_box, FontBox, Ink};
pub use wrap::{LineRange, WrapOptions};

/// Bumped whenever an export's signature, a buffer layout or an ownership
/// rule changes. The JS loader refuses a module with a different number.
pub const ABI_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The bytes are not a font this stack can read, or the face index is out
    /// of range.
    BadFont,
    UnknownFont,
    /// The text buffer did not hold valid UTF-8.
    BadText,
    Shape,
    /// A paint spec was malformed or asked for an impossible surface.
    BadSpec,
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::BadFont => "unreadable font or face index out of range",
            Self::UnknownFont => "unknown font id",
            Self::BadText => "text is not valid UTF-8",
            Self::Shape => "shaping failed",
            Self::BadSpec => "malformed paint spec",
        })
    }
}

impl std::error::Error for Error {}
