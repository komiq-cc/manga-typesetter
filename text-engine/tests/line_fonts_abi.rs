//! `mt_line_fonts` through the C ABI, as JS calls it: what it answers for
//! input it cannot serve, and that it writes nowhere it was not given.
#![cfg(feature = "paint")]

use mt_text::abi::{mt_alloc, mt_chain_new, mt_chain_push, mt_font_add};
use mt_text::abi_line_fonts::{mt_line_fonts, LINE_FONT_FIELDS};

fn abi_font(name: &str) -> u32 {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    let data = std::fs::read(path).unwrap();
    let ptr = mt_alloc(data.len());
    // SAFETY: `ptr` holds `data.len()` writable bytes from `mt_alloc`, and
    // `mt_font_add` takes the allocation over.
    unsafe {
        core::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        mt_font_add(ptr, data.len(), 0)
    }
}

const UNTOUCHED: u32 = 0xdead_beef;

/// Calls it with `cap` of a larger buffer offered, and returns the answer
/// and the whole buffer.
fn ask(font: u32, flags: u32, text: &str, cap: usize) -> (i32, Vec<u32>) {
    let mut out = vec![UNTOUCHED; 64];
    assert!(cap <= out.len());
    // SAFETY: `text` is readable for its length and `out` writable for 64
    // `u32`s, of which `cap` are offered.
    let n = unsafe {
        mt_line_fonts(
            font,
            flags,
            text.as_ptr(),
            text.len(),
            out.as_mut_ptr(),
            cap,
        )
    };
    (n, out)
}

/// Comic Neue with a chain of DejaVu Sans: `AΩB` is three parts.
fn setup() -> (u32, u32) {
    let comic = abi_font("ComicNeue-Regular.ttf");
    let dejavu = abi_font("DejaVuSans.ttf");
    let chain = mt_chain_new();
    assert_eq!(mt_chain_push(chain, dejavu, 0), 0);
    (comic, chain << 8)
}

#[test]
fn room_for_fewer_parts_than_there_are_is_an_error_and_nothing_is_written() {
    let (comic, flags) = setup();
    let need = 3 * LINE_FONT_FIELDS;
    let (n, out) = ask(comic, flags, "AΩB", need);
    assert_eq!(n, 3);
    assert!(out[..need].iter().all(|v| *v != UNTOUCHED));
    assert!(out[need..].iter().all(|v| *v == UNTOUCHED));
    // One `u32` short, one part's worth, half a part, none: each an error,
    // and not one `u32` of the buffer written, offered or not.
    for cap in [need - 1, LINE_FONT_FIELDS, 2, 0] {
        let (n, out) = ask(comic, flags, "AΩB", cap);
        assert_eq!(n, -2, "room for {cap}");
        assert!(out.iter().all(|v| *v == UNTOUCHED), "room for {cap}");
    }
    // No buffer at all.
    // SAFETY: a null `out` with no room is allowed.
    let n = unsafe { mt_line_fonts(comic, flags, "AΩB".as_ptr(), 4, core::ptr::null_mut(), 0) };
    assert_eq!(n, -2);
}

#[test]
fn an_unknown_font_or_chain_or_text_that_is_not_utf8_is_minus_one() {
    let (comic, flags) = setup();
    assert_eq!(ask(comic, flags, "AΩB", 64).0, 3);
    // A chain nobody made: an error, and not the font by itself.
    let (n, out) = ask(comic, 65535 << 8, "Ω", 64);
    assert_eq!(n, -1);
    assert!(out.iter().all(|v| *v == UNTOUCHED));
    assert_eq!(ask(comic, ((flags >> 8) + 1) << 8, "Ω", 64).0, -1);
    // No chain is no chain.
    assert_eq!(ask(comic, 0, "Ω", 64).0, 1);
    assert_eq!(ask(987_654, flags, "A", 64).0, -1);
    let bad = [0xffu8, 0xfe];
    let mut out = [UNTOUCHED; 8];
    // SAFETY: two readable bytes, eight writable `u32`s.
    let n = unsafe { mt_line_fonts(comic, flags, bad.as_ptr(), 2, out.as_mut_ptr(), 8) };
    assert_eq!(n, -1);
    assert_eq!(out, [UNTOUCHED; 8]);
}
