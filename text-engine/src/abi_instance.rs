//! Variation instances over the C ABI: one export, in a file of its own.
//!
//! A variable font is one file and many faces: every place on its axes is a
//! font with its own advances, outlines and name. The engine registers a
//! font at its default place (`mt_font_add`); this makes another font id of
//! the same bytes at another place, and from then on that id is a font like
//! any other to every export - measured, wrapped, painted and named there.
//!
//! WHY A FILE OF ITS OWN, AND WHY BEHIND `paint`. The exports share one
//! engine, kept in `abi.rs`, and the only door to it from another file is
//! `abi::with_engine`, which `abi.rs` compiles with the `paint` feature
//! because the painter's exports were its one user. This file was written
//! while `abi.rs` was another worker's, so it uses that door and carries its
//! condition. Nothing here paints: when `abi.rs` is next touched,
//! `with_engine` can lose its `cfg` and this module with it.

use skrifa::raw::types::Tag;

use crate::abi::with_engine;

/// Registers font `font` again with axis `tag` at `value` (user units, as
/// `wght` 700), every other axis where `font` has it. Returns the new font's
/// id, or 0 for an unknown font or a value that is not a number.
///
/// `tag` is the axis tag's four bytes, first letter in the top byte. A value
/// past the axis' range is brought to its end; on a font without that axis
/// the new font is `font` again under another id. The bytes are shared, and
/// the new id is removed with `mt_font_remove` like any other - the file
/// lives until the last font made from it is gone.
#[no_mangle]
pub extern "C" fn mt_font_add_instance(font: u32, tag: u32, value: f32) -> u32 {
    let tag = Tag::from_be_bytes(tag.to_be_bytes());
    with_engine(|engine| engine.add_instance(font, &[(tag, value)]).unwrap_or(0))
}
