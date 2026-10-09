//! `mt_line_carets`: the caret stops of a line are the painter's own pens.
//!
//! Through the C ABI, as JS calls it, against `paint::shape_run` on a second
//! engine holding the same fonts: the function the painter places a straight
//! run's glyphs with.
#![cfg(feature = "paint")]

use mt_text::abi::{
    mt_alloc, mt_chain_new, mt_chain_push, mt_font_add, mt_line_carets, mt_out_len, mt_out_ptr,
    mt_rule_set, mt_text_reserve, RULE_BOLD_ADVANCE,
};
use mt_text::paint::shape_run;
use mt_text::{BoldAdvance, Engine, Face, FontId, Synth, WEBKIT_BOLD_ADVANCE};

fn bytes(name: &str) -> Vec<u8> {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(path).unwrap()
}

/// The font in the engine behind the ABI.
fn abi_font(name: &str) -> u32 {
    let data = bytes(name);
    let ptr = mt_alloc(data.len());
    // SAFETY: `ptr` holds `data.len()` writable bytes from `mt_alloc`, and
    // `mt_font_add` takes the allocation over.
    unsafe {
        core::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        mt_font_add(ptr, data.len(), 0)
    }
}

fn own_font(engine: &mut Engine, name: &str) -> FontId {
    engine.add_font_bytes(bytes(name), 0).unwrap()
}

struct Carets {
    at: Vec<u32>,
    x: Vec<f64>,
    len: u32,
    advance: f64,
}

fn carets(font: u32, size: f64, flags: u32, text: &str, spacing: f64) -> Carets {
    let ptr = mt_text_reserve(text.len());
    // SAFETY: the text buffer holds at least `text.len()` bytes.
    unsafe { core::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
    let n = mt_line_carets(font, size, flags, text.len(), spacing);
    assert!(n >= 0, "mt_line_carets failed with {n}");
    let n = n as usize;
    assert_eq!(mt_out_len(), (n + 1) * 16);
    // SAFETY: the out buffer holds `mt_out_len()` initialised bytes.
    let out = unsafe { core::slice::from_raw_parts(mt_out_ptr(), mt_out_len()) };
    let f = |i: usize| f64::from_le_bytes(out[i * 8..i * 8 + 8].try_into().unwrap());
    Carets {
        at: (0..n).map(|i| f(2 * i) as u32).collect(),
        x: (0..n).map(|i| f(2 * i + 1)).collect(),
        len: f(2 * n) as u32,
        advance: f(2 * n + 1),
    }
}

#[test]
fn every_stop_is_the_pen_the_painter_places_the_glyph_at() {
    let font = abi_font("ComicNeue-Regular.ttf");
    let mut e = Engine::new();
    let own = own_font(&mut e, "ComicNeue-Regular.ttf");
    let text = "AVATAR WAVE!";
    let c = carets(font, 22.5, 0, text, 0.0);
    let run = shape_run(&mut e, Face::new(own, 22.5), text, 0.0).unwrap();
    assert_eq!(c.at, (0..12).collect::<Vec<u32>>());
    assert_eq!(c.len, 12);
    assert_eq!(c.x.len(), run.glyphs.len());
    for (x, g) in c.x.iter().zip(&run.glyphs) {
        assert_eq!(*x, g.x);
    }
    assert_eq!(c.advance, run.advance);
    // The pair is kerned: V starts left of where A's own advance ends.
    let a = e.advance(Face::new(own, 22.5), "A").unwrap();
    assert!(c.x[1] < a, "AV is kerned in this font: {} < {a}", c.x[1]);
}

#[test]
fn letter_spacing_follows_every_cluster_and_is_in_the_advance() {
    let font = abi_font("ComicNeue-Regular.ttf");
    let plain = carets(font, 40.0, 0, "WAVE!", 0.0);
    let spaced = carets(font, 40.0, 0, "WAVE!", 3.0);
    for i in 0..5 {
        assert!((spaced.x[i] - plain.x[i] - 3.0 * i as f64).abs() < 1e-9);
    }
    assert!((spaced.advance - plain.advance - 15.0).abs() < 1e-9);
}

#[test]
fn a_ligature_is_one_cluster_and_letter_spacing_breaks_it() {
    let font = abi_font("DejaVuSans.ttf");
    let joined = carets(font, 40.0, 0, "fix", 0.0);
    assert_eq!(joined.at, vec![0, 2]);
    assert_eq!(joined.len, 3);
    let spaced = carets(font, 40.0, 0, "fix", 2.0);
    assert_eq!(spaced.at, vec![0, 1, 2]);
}

#[test]
fn a_synthesised_bold_moves_every_later_stop_under_the_webkit_rule() {
    let font = abi_font("ComicNeue-Regular.ttf");
    let plain = carets(font, 36.0, 0, "BOLD", 0.0);
    assert_eq!(mt_rule_set(RULE_BOLD_ADVANCE, 1), 0);
    let bold = carets(font, 36.0, 1, "BOLD", 0.0);
    let extra = 36.0 * WEBKIT_BOLD_ADVANCE;
    for i in 0..4 {
        assert!((bold.x[i] - plain.x[i] - extra * i as f64).abs() < 1e-9);
    }
    assert!((bold.advance - plain.advance - 4.0 * extra).abs() < 1e-9);
    // And it is the painter's number for the same face.
    let mut e = Engine::new();
    e.rules.bold_advance = BoldAdvance::WebKit;
    let own = own_font(&mut e, "ComicNeue-Regular.ttf");
    let face = Face {
        synth: Synth::from_bits(1),
        ..Face::new(own, 36.0)
    };
    let run = shape_run(&mut e, face, "BOLD", 0.0).unwrap();
    for (x, g) in bold.x.iter().zip(&run.glyphs) {
        assert_eq!(*x, g.x);
    }
}

#[test]
fn a_letter_from_the_fallback_chain_stands_where_its_part_is_placed() {
    let comic = abi_font("ComicNeue-Regular.ttf");
    let sans = abi_font("DejaVuSans.ttf");
    let chain = mt_chain_new();
    assert_eq!(mt_chain_push(chain, sans, 0), 0);
    // Comic Neue has no Cyrillic; DejaVu Sans does.
    let text = "A\u{416}B";
    let c = carets(comic, 30.0, chain << 8, text, 0.0);
    assert_eq!(c.at, vec![0, 1, 2]);

    let mut e = Engine::new();
    let own_comic = own_font(&mut e, "ComicNeue-Regular.ttf");
    let own_sans = own_font(&mut e, "DejaVuSans.ttf");
    let own_chain = e.chain_new();
    e.chain_push(own_chain, own_sans, Synth::NONE).unwrap();
    let face = Face {
        chain: own_chain,
        ..Face::new(own_comic, 30.0)
    };
    let run = shape_run(&mut e, face, text, 0.0).unwrap();
    assert_eq!(
        run.glyphs[1].font, own_sans,
        "the middle letter is borrowed"
    );
    for (x, g) in c.x.iter().zip(&run.glyphs) {
        assert_eq!(*x, g.x);
    }
    // The borrowed letter is as wide as its own font makes it.
    let zhe = e.advance(Face::new(own_sans, 30.0), "\u{416}").unwrap();
    assert!((c.x[2] - c.x[1] - zhe).abs() < 1e-9);
    assert_eq!(c.advance, run.advance);
}

#[test]
fn an_empty_line_has_no_stop_and_no_advance() {
    let font = abi_font("ComicNeue-Regular.ttf");
    let c = carets(font, 30.0, 0, "", 5.0);
    assert!(c.at.is_empty());
    assert_eq!(c.len, 0);
    assert_eq!(c.advance, 0.0);
}

#[test]
fn offsets_are_utf16_units() {
    let font = abi_font("DejaVuSans.ttf");
    // U+1D11E is two UTF-16 units and four UTF-8 bytes.
    let c = carets(font, 30.0, 0, "a\u{1D11E}b", 0.0);
    assert_eq!(c.at, vec![0, 1, 3]);
    assert_eq!(c.len, 4);
}
