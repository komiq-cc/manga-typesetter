//! A face has one fallback-handle rule for metrics, empty queries and carets.
//! Use real fixture fonts and the public engine/ABI, including recovery after
//! a rejected query. No answer may silently fall back to the primary face.

use mt_text::abi::{
    mt_advance, mt_alloc, mt_chain_free, mt_chain_new, mt_chain_push, mt_font_add, mt_font_box,
    mt_font_info, mt_glyph_ink, mt_line_ink, mt_missing, mt_out_len, mt_out_ptr, mt_result_ptr,
    mt_text_reserve, mt_wrap_plain, Status, RESULT_SLOTS,
};
use mt_text::{Engine, Error, Face, FontId, Synth, WrapOptions};

fn bytes(name: &str) -> Vec<u8> {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(path).unwrap()
}

fn load(engine: &mut Engine, name: &str) -> FontId {
    engine.add_font_bytes(bytes(name), 0).unwrap()
}

#[derive(Clone, Copy, Debug)]
enum Query {
    Advance,
    FontBox,
    FontBoxUnrounded,
    LineInk,
    GlyphInk,
    Wrap,
    Missing,
    LineFonts,
}

const QUERIES: [Query; 8] = [
    Query::Advance,
    Query::FontBox,
    Query::FontBoxUnrounded,
    Query::LineInk,
    Query::GlyphInk,
    Query::Wrap,
    Query::Missing,
    Query::LineFonts,
];

fn query(engine: &mut Engine, face: Face, text: &str, which: Query) -> Result<(), Error> {
    match which {
        Query::Advance => engine.advance(face, text).map(|_| ()),
        Query::FontBox => engine.font_box(face).map(|_| ()),
        Query::FontBoxUnrounded => engine.font_box_unrounded(face).map(|_| ()),
        Query::LineInk => engine.line_ink(face, text).map(|_| ()),
        Query::GlyphInk => engine.glyph_ink(face, text).map(|_| ()),
        Query::Wrap => engine
            .wrap_plain(
                face,
                text,
                WrapOptions {
                    width: 120.0,
                    letter_spacing: 0.0,
                },
            )
            .map(|_| ()),
        Query::Missing => engine.missing_in(face, text).map(|_| ()),
        Query::LineFonts => engine.line_fonts(face, text).map(|_| ()),
    }
}

#[test]
fn every_face_query_refuses_unknown_and_freed_chains_before_any_fast_path() {
    let mut engine = Engine::new();
    let font = load(&mut engine, "ComicNeue-Regular.ttf");
    let lender = load(&mut engine, "DejaVuSans.ttf");
    let live = engine.chain_new();
    engine.chain_push(live, lender, Synth::NONE).unwrap();
    let gone = engine.chain_new();
    assert!(engine.chain_free(gone));
    let plain = Face::new(font, 30.0);
    for chain in [65535, gone] {
        let bad = Face { chain, ..plain };
        for text in ["", "\n", "WAIT!", "AΩB"] {
            for which in QUERIES {
                assert_eq!(
                    query(
                        &mut engine,
                        Face {
                            chain: live,
                            ..plain
                        },
                        text,
                        which
                    ),
                    Ok(()),
                    "valid control: {which:?}, {text:?}"
                );
                assert_eq!(
                    query(&mut engine, bad, text, which),
                    Err(Error::UnknownFont),
                    "{which:?}, chain {chain}, {text:?}"
                );
            }
        }
        // A previous successful measured line is gone after a refused one.
        engine
            .line_fonts(
                Face {
                    chain: live,
                    ..plain
                },
                "AΩB",
            )
            .unwrap();
        assert_eq!(engine.parts().len(), 3);
        assert!(engine.line_fonts(bad, "WAIT!").is_err());
        assert!(engine.parts().is_empty());
        assert!(engine.last_run().is_empty());
    }
}

#[test]
fn zero_and_held_empty_chains_keep_every_metric_and_a_live_chain_lends() {
    let mut engine = Engine::new();
    let font = load(&mut engine, "ComicNeue-Regular.ttf");
    let lender = load(&mut engine, "DejaVuSans.ttf");
    let empty = engine.chain_new();
    let live = engine.chain_new();
    engine.chain_push(live, lender, Synth::NONE).unwrap();
    let plain = Face::new(font, 30.0);
    let held_empty = Face {
        chain: empty,
        ..plain
    };
    for text in ["", "\n", "WAIT!", "AΩB"] {
        assert_eq!(
            engine.advance(plain, text),
            engine.advance(held_empty, text)
        );
        assert_eq!(engine.font_box(plain), engine.font_box(held_empty));
        assert_eq!(
            engine.font_box_unrounded(plain),
            engine.font_box_unrounded(held_empty)
        );
        assert_eq!(
            engine.line_ink(plain, text),
            engine.line_ink(held_empty, text)
        );
        assert_eq!(
            engine.glyph_ink(plain, text),
            engine.glyph_ink(held_empty, text)
        );
        assert_eq!(
            engine.missing_in(plain, text),
            engine.missing_in(held_empty, text)
        );
        let opts = WrapOptions {
            width: 120.0,
            letter_spacing: 0.0,
        };
        assert_eq!(
            engine.wrap_plain(plain, text, opts),
            engine.wrap_plain(held_empty, text, opts)
        );
        let own: Vec<_> = engine
            .line_fonts(plain, text)
            .unwrap()
            .iter()
            .map(|p| (p.font, p.text.clone()))
            .collect();
        let empty: Vec<_> = engine
            .line_fonts(held_empty, text)
            .unwrap()
            .iter()
            .map(|p| (p.font, p.text.clone()))
            .collect();
        assert_eq!(own, empty);
    }
    let fallback = Face {
        chain: live,
        ..plain
    };
    assert_eq!(engine.missing_in(plain, "AΩB").unwrap(), [1]);
    assert!(engine.missing_in(fallback, "AΩB").unwrap().is_empty());
    let parts: Vec<_> = engine
        .line_fonts(fallback, "AΩB")
        .unwrap()
        .iter()
        .map(|p| p.font)
        .collect();
    assert_eq!(parts, [font, lender, font]);
    let borrowed = engine.advance(Face::new(lender, 30.0), "Ω").unwrap();
    assert_eq!(engine.advance(fallback, "Ω").unwrap(), borrowed);
}

fn abi_font(name: &str) -> u32 {
    let data = bytes(name);
    let ptr = mt_alloc(data.len());
    // SAFETY: this initialized mt_alloc buffer transfers to mt_font_add.
    unsafe {
        core::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        mt_font_add(ptr, data.len(), 0)
    }
}

fn set_text(text: &str) -> usize {
    let ptr = mt_text_reserve(text.len());
    // SAFETY: reserve returned at least text.len() writable bytes.
    unsafe { core::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
    text.len()
}

fn answers() -> ([f64; RESULT_SLOTS], Vec<u8>) {
    // SAFETY: result holds RESULT_SLOTS doubles, out holds mt_out_len bytes.
    unsafe {
        let result = core::slice::from_raw_parts(mt_result_ptr(), RESULT_SLOTS);
        let out = core::slice::from_raw_parts(mt_out_ptr(), mt_out_len());
        (result.try_into().unwrap(), out.to_vec())
    }
}

fn prime_answers(font: u32) {
    assert_eq!(mt_font_info(font), RESULT_SLOTS as i32);
    assert_eq!(
        mt_wrap_plain(font, 30.0, 0, set_text("WAIT!"), 120.0, 0.0),
        1
    );
    let (result, out) = answers();
    assert!(result.iter().any(|n| *n != 0.0));
    assert!(!out.is_empty());
}

#[derive(Clone, Copy, Debug)]
enum AbiQuery {
    Advance,
    FontBox,
    LineInk,
    GlyphInk,
    Wrap,
    Missing,
    #[cfg(feature = "paint")]
    Carets,
}

fn abi_query(font: u32, flags: u32, text: &str, which: AbiQuery) -> i32 {
    let len = set_text(text);
    match which {
        AbiQuery::Advance => {
            if mt_advance(font, 30.0, flags, len).is_nan() {
                Status::UnknownFont as i32
            } else {
                0
            }
        }
        AbiQuery::FontBox => mt_font_box(font, 30.0, flags),
        AbiQuery::LineInk => mt_line_ink(font, 30.0, flags, len),
        AbiQuery::GlyphInk => mt_glyph_ink(font, 30.0, flags, len),
        AbiQuery::Wrap => mt_wrap_plain(font, 30.0, flags, len, 120.0, 0.0),
        AbiQuery::Missing => mt_missing(font, flags, len),
        #[cfg(feature = "paint")]
        AbiQuery::Carets => mt_text::abi::mt_line_carets(font, 30.0, flags, len, 0.0),
    }
}

#[test]
fn every_measure_export_refuses_unknown_and_freed_chains_clears_and_recovers() {
    let font = abi_font("ComicNeue-Regular.ttf");
    let lender = abi_font("DejaVuSans.ttf");
    let live = mt_chain_new();
    assert_eq!(mt_chain_push(live, lender, 0), 0);
    let gone = mt_chain_new();
    assert_eq!(mt_chain_free(gone), 1);
    let queries = [
        AbiQuery::Advance,
        AbiQuery::FontBox,
        AbiQuery::LineInk,
        AbiQuery::GlyphInk,
        AbiQuery::Wrap,
        AbiQuery::Missing,
        #[cfg(feature = "paint")]
        AbiQuery::Carets,
    ];
    for chain in [65535, gone] {
        for text in ["", "\n", "WAIT!", "AΩB"] {
            for which in queries {
                prime_answers(font);
                let valid = abi_query(font, live << 8, text, which);
                assert!(valid >= 0, "valid control: {which:?}, {text:?}");
                let expected = answers();
                prime_answers(font);
                assert_eq!(
                    abi_query(font, chain << 8, text, which),
                    Status::UnknownFont as i32,
                    "{which:?}, chain {chain}, {text:?}"
                );
                assert_eq!(
                    answers(),
                    ([0.0; RESULT_SLOTS], Vec::new()),
                    "stale answer: {which:?}, {text:?}"
                );
                prime_answers(font);
                assert_eq!(abi_query(font, live << 8, text, which), valid);
                assert_eq!(answers(), expected, "recovery: {which:?}, {text:?}");
            }
        }
    }
}

#[cfg(feature = "paint")]
#[test]
fn line_fonts_also_refuses_a_freed_chain_without_touching_caller_memory() {
    use mt_text::abi_line_fonts::mt_line_fonts;
    let font = abi_font("ComicNeue-Regular.ttf");
    let empty = mt_chain_new();
    let gone = mt_chain_new();
    assert_eq!(mt_chain_free(gone), 1);
    for text in ["", "WAIT!", "AΩB"] {
        for flags in [0, empty << 8] {
            let mut out = [0xdead_beef; 64];
            // SAFETY: readable UTF-8 text and a writable output buffer.
            assert_eq!(
                unsafe {
                    mt_line_fonts(
                        font,
                        flags,
                        text.as_ptr(),
                        text.len(),
                        out.as_mut_ptr(),
                        out.len(),
                    )
                },
                1
            );
        }
        for chain in [65535, gone] {
            let mut out = [0xdead_beef; 64];
            // SAFETY: readable UTF-8 text and a writable output buffer.
            assert_eq!(
                unsafe {
                    mt_line_fonts(
                        font,
                        chain << 8,
                        text.as_ptr(),
                        text.len(),
                        out.as_mut_ptr(),
                        out.len(),
                    )
                },
                -1
            );
            assert_eq!(out, [0xdead_beef; 64]);
        }
    }
}
