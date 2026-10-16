//! The params of `mt_sfx_layout` as bytes: little-endian, read in this order.
//!
//! ```text
//! f64 line height, letter spacing, amount, row shift
//! u32 seed, u32 flow (0 row, 1 stack)
//! u32 move count, then per move: u32 kind (its row in KINDS), f64 a, f64 b
//! ```
//!
//! The size is not in it: it is the face's, which the export takes beside it.
//! `text-engine/js/engine.mjs` (`sfxLayout`) writes it. A number that is not
//! finite, a kind or flow that is not in the table, or bytes left over, is
//! `BadSpec`.

use super::table::KINDS;
use super::{Flow, Move, Params};
use crate::paint::budget;
use crate::Error;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::BadSpec)?;
        let s = self.bytes.get(self.at..end).ok_or(Error::BadSpec)?;
        self.at = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }
}

/// The params in `bytes`, for a face of `size` pixels.
pub fn decode_params(bytes: &[u8], size: f64) -> Result<Params, Error> {
    if !size.is_finite() {
        return Err(Error::BadSpec);
    }
    let mut r = Reader { bytes, at: 0 };
    let line_height = r.f64()?;
    let letter_spacing = r.f64()?;
    let amount = r.f64()?;
    let row_shift = r.f64()?;
    let seed = r.u32()?;
    let flow = match r.u32()? {
        0 => Flow::Row,
        1 => Flow::Stack,
        _ => return Err(Error::BadSpec),
    };
    let count = r.u32()? as usize;
    // Each move is 20 bytes, so a bad count cannot ask for a huge allocation.
    if count.checked_mul(20).ok_or(Error::BadSpec)? > bytes.len() - r.at {
        return Err(Error::BadSpec);
    }
    let moves = budget::collect((0..count).map(|_| {
        let kind = KINDS.get(r.u32()? as usize).ok_or(Error::BadSpec)?.kind;
        Ok(Move {
            kind,
            a: r.f64()?,
            b: r.f64()?,
        })
    }))?;
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    Ok(Params {
        size,
        line_height,
        letter_spacing,
        amount,
        seed,
        flow,
        row_shift,
        moves,
    })
}
