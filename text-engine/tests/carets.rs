//! `mt_line_carets`: the caret stops of a line are the painter's own pens.
//!
//! Through the C ABI, as JS calls it, against `paint::shape_run` on a second
//! engine holding the same fonts: the function the painter places a straight
//! run's glyphs with.
#![cfg(feature = "paint")]

use mt_text::abi::{
    mt_alloc, mt_chain_new, mt_chain_push, mt_font_add, mt_line_carets, mt_out_len, mt_out_ptr,
    mt_rule_set, mt_text_reserve, Status, RULE_BOLD_ADVANCE,
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

/// The call as JS makes it, for its answer alone.
fn answer(font: u32, size: f64, text: &str, spacing: f64) -> i32 {
    let ptr = mt_text_reserve(text.len());
    // SAFETY: the text buffer holds at least `text.len()` bytes.
    unsafe { core::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
    mt_line_carets(font, size, 0, text.len(), spacing)
}

#[test]
fn a_size_or_a_spacing_that_is_no_number_is_an_error_and_not_a_line_of_them() {
    let font = abi_font("ComicNeue-Regular.ttf");
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(answer(font, bad, "a", 0.0), Status::BadSpec as i32);
        assert_eq!(answer(font, 30.0, "a", bad), Status::BadSpec as i32);
        // And with no letter to place: the question is as bad.
        assert_eq!(answer(font, bad, "", 0.0), Status::BadSpec as i32);
    }
    // The numbers a box has are answered: any size, a spacing either way.
    assert_eq!(answer(font, 30.0, "a", 0.0), 1);
    assert_eq!(answer(font, 0.0, "a", -4.0), 1);
    let c = carets(font, 30.0, 0, "ab", -2.5);
    assert!(c.x.iter().all(|x| x.is_finite()) && c.advance.is_finite());
}

/// A question with finite numbers can still have an answer without them: a
/// size so large that the pens overflow. That is an error too, with nothing
/// left in the out buffer for a caller to read as positions.
#[test]
fn an_answer_with_a_position_that_is_not_finite_is_an_error() {
    let font = abi_font("ComicNeue-Regular.ttf");
    assert_eq!(answer(font, f64::MAX, "MMMM", 0.0), Status::BadSpec as i32);
    assert_eq!(mt_out_len(), 0);
    assert_eq!(answer(font, 30.0, "MMMM", f64::MAX), Status::BadSpec as i32);
    assert_eq!(mt_out_len(), 0);
    assert_eq!(
        answer(font, 30.0, "MMMM", -f64::MAX),
        Status::BadSpec as i32
    );
    assert_eq!(mt_out_len(), 0);
    // One letter: its pen is 0 and written, and the advance alone is not a
    // number. Nothing is left of the pen.
    assert_eq!(
        answer(font, f64::MAX, "M", f64::MAX),
        Status::BadSpec as i32
    );
    assert_eq!(mt_out_len(), 0);
    // Large, and every position still a number: answered.
    assert_eq!(answer(font, 1.0e9, "MMMM", 0.0), 4);
    let c = carets(font, 1.0e9, 0, "MMMM", 0.0);
    assert!(c.x.iter().all(|x| x.is_finite()) && c.advance.is_finite());
    assert!(c.advance > c.x[3] && c.x[3] > c.x[1]);
}

/// Alter the existing test font in memory. Every advance is zero; a GPOS
/// single-position lookup moves only A by 32767 units. No font file is made.
fn zero_advance_offset_font() -> Vec<u8> {
    use skrifa::{FontRef, MetadataProvider};
    let font = bytes("ComicNeue-Regular.ttf");
    let glyph = FontRef::new(&font)
        .unwrap()
        .charmap()
        .map('A')
        .unwrap()
        .to_u32() as u16;
    let u16_at = |at: usize| u16::from_be_bytes(font[at..at + 2].try_into().unwrap());
    let u32_at = |at: usize| u32::from_be_bytes(font[at..at + 4].try_into().unwrap()) as usize;
    let mut tables = Vec::new();
    for i in 0..usize::from(u16_at(4)) {
        let rec = 12 + i * 16;
        let tag: [u8; 4] = font[rec..rec + 4].try_into().unwrap();
        let (at, len) = (u32_at(rec + 8), u32_at(rec + 12));
        if tag != *b"GPOS" {
            tables.push((tag, font[at..at + len].to_vec()));
        }
    }
    let hhea = &tables.iter().find(|(tag, _)| tag == b"hhea").unwrap().1;
    let metrics = usize::from(u16::from_be_bytes(hhea[34..36].try_into().unwrap()));
    let hmtx = &mut tables.iter_mut().find(|(tag, _)| tag == b"hmtx").unwrap().1;
    for i in 0..metrics {
        hmtx[i * 4..i * 4 + 2].copy_from_slice(&0u16.to_be_bytes());
    }
    let words = |out: &mut Vec<u8>, values: &[u16]| {
        out.extend(values.iter().flat_map(|v| v.to_be_bytes()));
    };
    let mut gpos = Vec::new();
    // Header, ScriptList with DFLT/default LangSys, FeatureList with kern,
    // LookupList with one SinglePos format 1/xPlacement, coverage of A.
    words(&mut gpos, &[1, 0, 10, 30, 44, 1]);
    gpos.extend(b"DFLT");
    words(&mut gpos, &[8, 4, 0, 0, 0xffff, 1, 0, 1]);
    gpos.extend(b"kern");
    words(
        &mut gpos,
        &[8, 0, 1, 0, 1, 4, 1, 0, 1, 8, 1, 8, 1, 32767, 1, 1, glyph],
    );
    tables.push((*b"GPOS", gpos));
    tables.sort_by_key(|(tag, _)| *tag);
    let mut out = font[..4].to_vec();
    out.extend((tables.len() as u16).to_be_bytes());
    out.extend([0u8; 6]);
    let mut body = Vec::new();
    for (tag, data) in &tables {
        out.extend(tag);
        out.extend(0u32.to_be_bytes());
        out.extend(((12 + tables.len() * 16 + body.len()) as u32).to_be_bytes());
        out.extend((data.len() as u32).to_be_bytes());
        body.extend(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
    }
    out.extend(body);
    out
}

#[test]
fn a_nonfinite_pen_with_finite_advance_is_refused_and_cleared() {
    let data = zero_advance_offset_font();
    let mut engine = Engine::new();
    let own = engine.add_font_bytes(data.clone(), 0).unwrap();
    let shaped = engine.shape(own, "BA").unwrap().to_vec();
    let run = shape_run(&mut engine, Face::new(own, f64::MAX), "BA", 0.0).unwrap();
    assert_eq!(
        run.advance, 0.0,
        "the advance guard must not mask the pen guard"
    );
    assert_eq!(shaped.len(), 2);
    assert_eq!(shaped[0].x_offset, 0);
    assert_eq!(shaped[1].x_offset, 32767);
    let scale = f64::MAX / f64::from(engine.font(own).unwrap().info.units_per_em);
    let pens: Vec<_> = run
        .glyphs
        .iter()
        .zip(&shaped)
        .map(|(p, g)| p.x - f64::from(g.x_offset) * scale)
        .collect();
    assert!(pens[0].is_finite());
    assert!(!pens[1].is_finite());
    let ptr = mt_alloc(data.len());
    // SAFETY: mt_alloc gave us data.len() writable bytes; mt_font_add owns them.
    let font = unsafe {
        core::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        mt_font_add(ptr, data.len(), 0)
    };
    assert_eq!(answer(font, f64::MAX, "BA", 0.0), Status::BadSpec as i32);
    assert_eq!(mt_out_len(), 0, "the earlier finite pen must be cleared");
    assert_eq!(answer(font, 30.0, "BA", 0.0), 2);
}
