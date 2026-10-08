//! The engine against the four fixture fonts in `src/test/fonts/`.
//!
//! These pin behaviour the app relies on. Agreement with HarfBuzz and Skia is
//! checked from node (`parity/`), on the wasm build.

use mt_text::{
    bold_outset, BoldAdvance, Engine, Face, FontBoxRule, FontId, Synth, WrapOptions, OBLIQUE_SKEW,
};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    engine.add_font_bytes(bytes, 0).expect("fixture font loads")
}

fn all(engine: &mut Engine) -> [FontId; 4] {
    [
        load(engine, "ComicNeue-Regular.ttf"),
        load(engine, "Bangers-Regular.ttf"),
        load(engine, "DejaVuSans.ttf"),
        load(engine, "DejaVuSans-Oblique.ttf"),
    ]
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn registry_reports_names_and_facts() {
    let mut e = Engine::new();
    let [comic, bangers, dejavu, oblique] = all(&mut e);

    let c = e.info(comic).unwrap();
    assert_eq!(c.family, "Comic Neue");
    assert_eq!(c.postscript_name, "ComicNeue-Regular");
    assert_eq!(c.units_per_em, 1000);
    assert!(!c.is_variable());
    assert_eq!(c.faces_in_file, 1);

    assert_eq!(e.info(bangers).unwrap().postscript_name, "Bangers-Regular");
    let d = e.info(dejavu).unwrap();
    assert_eq!(
        (d.family.as_str(), d.subfamily.as_str()),
        ("DejaVu Sans", "Book")
    );
    assert_eq!(d.units_per_em, 2048);
    assert_eq!(d.glyph_count, 6241);
    assert_eq!(
        e.info(oblique).unwrap().postscript_name,
        "DejaVuSans-Oblique"
    );
}

#[test]
fn ids_are_reused_after_removal_and_never_zero() {
    let mut e = Engine::new();
    let a = load(&mut e, "ComicNeue-Regular.ttf");
    let b = load(&mut e, "Bangers-Regular.ttf");
    assert!(a != 0 && b != 0 && a != b);
    assert!(e.remove_font(a));
    assert!(!e.remove_font(a));
    assert!(e.info(a).is_err());
    assert!(e.advance(Face::new(a, 16.0), "x").is_err());
    assert_eq!(load(&mut e, "DejaVuSans.ttf"), a);
    assert!(e.info(0).is_err());
}

#[test]
fn garbage_and_out_of_range_faces_are_rejected() {
    let mut e = Engine::new();
    assert!(e.add_font_bytes(vec![0u8; 256], 0).is_err());
    assert!(e.add_font_bytes(Vec::new(), 0).is_err());
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    assert!(e.add_font_bytes(std::fs::read(path).unwrap(), 3).is_err());
}

#[test]
fn a_sibling_face_shares_the_bytes() {
    let mut e = Engine::new();
    let a = load(&mut e, "ComicNeue-Regular.ttf");
    let b = e.add_sibling_face(a, 0).unwrap();
    assert_ne!(a, b);
    assert_eq!(
        e.font(a).unwrap().bytes().as_ptr(),
        e.font(b).unwrap().bytes().as_ptr()
    );
    assert!(e.add_sibling_face(a, 1).is_err());
}

#[test]
fn advance_is_the_shaped_run_scaled_once() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    // Comic Neue: A 581, V 536, and a -43 kern between them.
    assert_eq!(e.advance_units(comic, "A").unwrap(), 581);
    assert_eq!(e.advance_units(comic, "V").unwrap(), 536);
    assert_eq!(e.advance_units(comic, "AV").unwrap(), 581 + 536 - 43);
    assert!(close(
        e.advance(Face::new(comic, 100.0), "AV").unwrap(),
        107.4
    ));
    assert!(close(
        e.advance(Face::new(comic, 22.5), "AV").unwrap(),
        1074.0 * 22.5 / 1000.0
    ));
    // Kerning reaches across a space: the breaker measures whole lines.
    let whole = e.advance_units(dejavu, "T o").unwrap();
    let parts = e.advance_units(dejavu, "T").unwrap()
        + e.advance_units(dejavu, " ").unwrap()
        + e.advance_units(dejavu, "o").unwrap();
    assert_eq!(whole, parts);
    assert!(
        e.advance_units(dejavu, "To").unwrap()
            < e.advance_units(dejavu, "T").unwrap() + e.advance_units(dejavu, "o").unwrap()
    );
    assert_eq!(e.advance(Face::new(dejavu, 16.0), "").unwrap(), 0.0);
}

#[test]
fn default_features_form_ligatures_with_utf16_clusters() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    // DejaVu has an ffi ligature; Comic Neue has none.
    let run = e.shape(dejavu, "office").unwrap().to_vec();
    assert_eq!(
        run.iter().map(|g| g.cluster).collect::<Vec<_>>(),
        [0, 1, 4, 5]
    );
    assert_eq!(e.shape(comic, "office").unwrap().len(), 6);
    // Clusters count UTF-16 units, so the glyph after an astral code point
    // starts at 3, not at 2 (code points) or 5 (UTF-8 bytes).
    let run = e.shape(dejavu, "a\u{1F600}b").unwrap().to_vec();
    assert_eq!(run.iter().map(|g| g.cluster).collect::<Vec<_>>(), [0, 1, 3]);
}

#[test]
fn missing_reports_code_points_without_a_glyph() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    assert!(e.missing(comic, "plain ascii").unwrap().is_empty());
    assert_eq!(e.missing(comic, "ok \u{D55C}\u{AE00}!").unwrap(), [3, 4]);
}

#[test]
fn skias_font_box_follows_the_table_rule() {
    let mut e = Engine::new();
    e.rules.font_box = FontBoxRule::Skia;
    let [comic, bangers, dejavu, _] = all(&mut e);
    // DejaVu: hhea 1901/483 differs from OS/2 typo 1556/492 and
    // USE_TYPO_METRICS is off, so hhea must win.
    let b = e.font_box(Face::new(dejavu, 2048.0)).unwrap();
    assert!(close(b.ascent, 1901.0) && close(b.descent, 483.0));
    // Unrounded at fractional sizes.
    let b = e.font_box(Face::new(comic, 14.5)).unwrap();
    assert!(close(b.ascent, 13.05) && close(b.descent, 3.625));
    let b = e.font_box(Face::new(bangers, 1000.0)).unwrap();
    assert!(close(b.ascent, 883.0) && close(b.descent, 181.0));
}

#[test]
fn the_line_box_rule_orders_the_three_tables() {
    use mt_text::{line_box, LineBox, VerticalMetrics};
    let lb = |a: f64, d: f64| LineBox {
        ascent: a,
        descent: d,
        line_gap: 0.0,
    };
    let (hhea, typo, win) = (lb(900.0, 250.0), lb(800.0, 200.0), lb(1000.0, 350.0));
    let v = |h, t, w, flag| VerticalMetrics {
        hhea: h,
        typo: t,
        win: w,
        use_typo_metrics: flag,
    };
    assert_eq!(line_box(&v(Some(hhea), Some(typo), Some(win), false)), hhea);
    assert_eq!(line_box(&v(Some(hhea), Some(typo), Some(win), true)), typo);
    assert_eq!(
        line_box(&v(Some(lb(0.0, 0.0)), Some(typo), Some(win), false)),
        typo
    );
    assert_eq!(
        line_box(&v(Some(lb(0.0, 0.0)), Some(lb(0.0, 0.0)), Some(win), false)),
        win
    );
    assert_eq!(line_box(&v(None, None, None, false)), LineBox::default());
}

#[test]
fn line_ink_is_the_exact_outline_box() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    let f = Face::new(comic, 1000.0);
    // At 1000 px the numbers are the font's own units.
    let g = e.line_ink(f, "g").unwrap();
    assert!(g.has_ink);
    assert!(close(g.width, 530.0));
    assert!(close(g.left, -46.0) && close(g.right, 453.0));
    assert!(close(g.ascent, 505.0) && close(g.descent, 188.0));
    // A line's box is the union of its glyph boxes at their pen positions.
    let a = e.line_ink(f, "A").unwrap();
    let av = e.line_ink(f, "AV").unwrap();
    let v = e.line_ink(f, "V").unwrap();
    assert!(close(av.left, a.left));
    assert!(close(av.right, 538.0 + v.right));
    assert!(close(av.ascent, a.ascent.max(v.ascent)));
    // Leading spaces move the ink; they do not pin the box to the origin.
    let sp = e.advance(f, " ").unwrap();
    let lead = e.line_ink(f, " g").unwrap();
    assert!(close(lead.left, g.left - sp));
    // A flat-bottomed glyph sits exactly on the baseline, printed as 0, not -0.
    let h = e.line_ink(Face::new(dejavu, 16.0), "H").unwrap();
    assert_eq!(h.descent.to_bits(), 0.0f64.to_bits());
}

#[test]
fn a_run_without_ink_says_so() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let f = Face::new(comic, 40.0);
    for text in [" ", "   ", ""] {
        let ink = e.line_ink(f, text).unwrap();
        assert!(!ink.has_ink);
        assert_eq!(
            (ink.left, ink.right, ink.ascent, ink.descent),
            (0.0, 0.0, 0.0, 0.0)
        );
        assert!(!e.glyph_ink(f, text).unwrap().has_ink);
    }
    assert!(e.line_ink(f, " ").unwrap().width > 0.0);
}

#[test]
fn glyph_ink_is_line_ink_moved_to_the_centre_and_the_middle_baseline() {
    let mut e = Engine::new();
    for font in all(&mut e) {
        for size in [8.0, 14.5, 22.5, 96.0] {
            let f = Face::new(font, size);
            let b = e.font_box_unrounded(f).unwrap();
            let mid = (b.ascent - b.descent) / 2.0;
            assert!(close(e.middle_shift(f).unwrap(), mid));
            for ch in ["A", "g", "W", "i", "."] {
                let line = e.line_ink(f, ch).unwrap();
                let glyph = e.glyph_ink(f, ch).unwrap();
                assert!(close(glyph.left, line.left + line.width / 2.0));
                assert!(close(glyph.right, line.right - line.width / 2.0));
                assert!(close(glyph.ascent, line.ascent - mid));
                assert!(close(glyph.descent, line.descent + mid));
            }
        }
    }
}

#[test]
fn metrics_scale_linearly_with_size() {
    let mut e = Engine::new();
    for font in all(&mut e) {
        let text = "WHAT THE HELL ARE YOU DOING?!";
        let one = e.line_ink(Face::new(font, 10.0), text).unwrap();
        let ten = e.line_ink(Face::new(font, 100.0), text).unwrap();
        for (a, b) in [
            (one.width, ten.width),
            (one.left, ten.left),
            (one.right, ten.right),
            (one.ascent, ten.ascent),
            (one.descent, ten.descent),
        ] {
            assert!((a * 10.0 - b).abs() < 1e-9, "{a} * 10 != {b}");
        }
    }
}

#[test]
fn synthetic_styles_keep_the_advance_and_grow_the_ink() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let size = 40.0;
    let plain = Face::new(comic, size);
    let bold = Face {
        synth: Synth {
            bold: true,
            oblique: false,
        },
        ..plain
    };
    let slanted = Face {
        synth: Synth {
            bold: false,
            oblique: true,
        },
        ..plain
    };

    let p = e.line_ink(plain, "H").unwrap();
    let b = e.line_ink(bold, "H").unwrap();
    let s = e.line_ink(slanted, "H").unwrap();
    assert_eq!(p.width, b.width);
    assert_eq!(p.width, s.width);

    // 40 px is past the 36 px knee: the pen is size / 32 wide, half each side.
    let grow = bold_outset(size);
    assert!(close(grow, 40.0 / 32.0 / 2.0));
    assert!(close(bold_outset(9.0), 9.0 / 24.0 / 2.0));
    assert!(close(bold_outset(4.0), 4.0 / 24.0 / 2.0));
    assert!(bold_outset(20.0) > 20.0 / 32.0 / 2.0 && bold_outset(20.0) < 20.0 / 24.0 / 2.0);
    for (plain, bold) in [
        (p.left, b.left),
        (p.right, b.right),
        (p.ascent, b.ascent),
        (p.descent, b.descent),
    ] {
        assert!(close(bold, plain + grow));
    }

    // The slant shears about the baseline: the top moves right by skew * height,
    // heights are untouched, and what is below the baseline moves left.
    assert!(close(s.ascent, p.ascent) && close(s.descent, p.descent));
    assert!(s.right > p.right);
    // DejaVu's H has square corners, so its top right corner is the point
    // that travels furthest and the box grows by exactly skew * cap height.
    let dejavu = load(&mut e, "DejaVuSans.ttf");
    let up = e.line_ink(Face::new(dejavu, size), "H").unwrap();
    let slant = |font| Face {
        font,
        size,
        synth: Synth {
            bold: false,
            oblique: true,
        },
        chain: 0,
    };
    let sl = e.line_ink(slant(dejavu), "H").unwrap();
    assert!((sl.right - (up.right + f64::from(OBLIQUE_SKEW) * up.ascent)).abs() < 1e-6);
    assert!(close(sl.left, up.left));
    // What hangs below the baseline moves left: DejaVu's p has a square
    // stem whose foot is its leftmost point.
    let up = e.line_ink(Face::new(dejavu, size), "p").unwrap();
    let sl = e.line_ink(slant(dejavu), "p").unwrap();
    assert!((sl.left - (up.left + f64::from(OBLIQUE_SKEW) * up.descent)).abs() < 1e-6);
}

#[test]
fn wrap_breaks_greedily_at_uax14_opportunities() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let f = Face::new(comic, 20.0);
    let text = "WHAT THE HELL ARE YOU DOING?!";
    let lines = |e: &mut Engine, text: &str, width: f64| -> Vec<String> {
        let units: Vec<u16> = text.encode_utf16().collect();
        e.wrap_plain(
            f,
            text,
            WrapOptions {
                width,
                letter_spacing: 0.0,
            },
        )
        .unwrap()
        .iter()
        .map(|l| String::from_utf16(&units[l.start as usize..l.end as usize]).unwrap())
        .collect()
    };

    assert_eq!(lines(&mut e, text, 1e6), [text]);
    let wrapped = lines(&mut e, text, 120.0);
    assert!(wrapped.len() > 1);
    // Nothing is lost or reordered, and every line fits once its hanging
    // spaces are dropped.
    assert_eq!(wrapped.concat(), text);
    for line in &wrapped {
        assert!(
            e.advance(f, line.trim_end()).unwrap() <= 120.0 + 1e-9,
            "{line:?}"
        );
    }
    // Each line is as long as it can be: the next word would not have fit.
    let first = wrapped[0].trim_end();
    let next_word = wrapped[1].split(' ').next().unwrap();
    assert!(e.advance(f, &format!("{first} {next_word}")).unwrap() > 120.0);

    // Newlines are hard breaks and are not part of any line.
    assert_eq!(lines(&mut e, "ONE\nTWO", 1e6), ["ONE", "TWO"]);
    assert_eq!(lines(&mut e, "ONE\n\nTWO\n", 1e6), ["ONE", "", "TWO", ""]);
    assert_eq!(lines(&mut e, "", 100.0), [""]);

    // A word wider than the line is broken inside (overflow-wrap), one code
    // point at the very least.
    let pieces = lines(&mut e, "AAAAAAAAAAAA", 30.0);
    assert!(pieces.len() > 3);
    assert_eq!(pieces.concat(), "AAAAAAAAAAAA");
    assert_eq!(lines(&mut e, "WW", 1.0), ["W", "W"]);

    // A no-break space does not offer a break; a hyphen does, after itself.
    assert_eq!(
        lines(&mut e, "NO\u{a0}BREAK HERE", 95.0)[0],
        "NO\u{a0}BREAK "
    );
    assert_eq!(lines(&mut e, "WELL-KNOWN", 70.0), ["WELL-", "KNOWN"]);
}

#[test]
fn letter_spacing_counts_against_the_wrap_width() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let f = Face::new(comic, 20.0);
    let text = "AAAA BBBB";
    let width = e.advance(f, text).unwrap() + 1.0;
    let tight = e
        .wrap_plain(
            f,
            text,
            WrapOptions {
                width,
                letter_spacing: 0.0,
            },
        )
        .unwrap();
    let loose = e
        .wrap_plain(
            f,
            text,
            WrapOptions {
                width,
                letter_spacing: 2.0,
            },
        )
        .unwrap();
    assert_eq!(tight.len(), 1);
    assert_eq!(loose.len(), 2);
}

#[test]
fn shaping_is_repeatable_and_independent_of_call_order() {
    let mut e = Engine::new();
    let [comic, bangers, ..] = all(&mut e);
    let first = e.shape(comic, "office waffle").unwrap().to_vec();
    e.shape(bangers, "\u{D55C}\u{AE00} mixed \u{3042}").unwrap();
    e.shape(comic, "").unwrap();
    assert_eq!(e.shape(comic, "office waffle").unwrap(), first.as_slice());
}

/// A panic is an abort in the wasm build and takes the whole engine with it,
/// so a damaged font file must be refused or measured, never crash. This is a
/// smoke test over a few hundred damaged files, not a proof.
#[test]
fn damaged_fonts_do_not_panic() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut accepted = 0;
    for name in [
        "ComicNeue-Regular.ttf",
        "Bangers-Regular.ttf",
        "DejaVuSans.ttf",
    ] {
        let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
        let good = std::fs::read(path).unwrap();
        for round in 0..120 {
            let mut bytes = good.clone();
            match round % 3 {
                // Cut the file short.
                0 => bytes.truncate(next() as usize % good.len()),
                // Scribble over a stretch of it.
                1 => {
                    let at = next() as usize % good.len();
                    let len = (next() as usize % 4096).min(good.len() - at);
                    for b in &mut bytes[at..at + len] {
                        *b = next() as u8;
                    }
                }
                // Flip a handful of single bytes, the table directory included.
                _ => {
                    for _ in 0..8 {
                        let at = next() as usize % good.len().min(8192);
                        bytes[at] ^= 1 << (next() % 8);
                    }
                }
            }
            let mut e = Engine::new();
            let Ok(id) = e.add_font_bytes(bytes, 0) else {
                continue;
            };
            accepted += 1;
            let face = Face::new(id, 22.5);
            let text = "WHAT THE HELL?! office waffle \u{c9}clat";
            let _ = e.advance(face, text);
            let _ = e.line_ink(face, text);
            let _ = e.glyph_ink(face, "g");
            let _ = e.font_box(face);
            let _ = e.wrap_plain(
                face,
                text,
                WrapOptions {
                    width: 60.0,
                    letter_spacing: 0.0,
                },
            );
        }
    }
    // The test only means something if damaged files do get past the door.
    assert!(accepted > 30, "only {accepted} damaged files were accepted");
}

fn wrap(e: &mut Engine, f: Face, text: &str, width: f64, letter_spacing: f64) -> Vec<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    e.wrap_plain(
        f,
        text,
        WrapOptions {
            width,
            letter_spacing,
        },
    )
    .unwrap()
    .iter()
    .map(|l| String::from_utf16(&units[l.start as usize..l.end as usize]).unwrap())
    .collect()
}

fn bold(f: Face) -> Face {
    Face {
        synth: Synth {
            bold: true,
            oblique: false,
        },
        ..f
    }
}

#[test]
fn the_browsers_font_box_is_hhea_in_whole_pixels() {
    let mut e = Engine::new();
    let [comic, bangers, dejavu, _] = all(&mut e);
    let fb = |e: &Engine, font, size| {
        let b = e.font_box(Face::new(font, size)).unwrap();
        (b.ascent, b.descent)
    };
    // 900/250 of 1000 at 20 px, and 14.5 px rounds each value by itself.
    assert_eq!(fb(&e, comic, 20.0), (18.0, 5.0));
    assert_eq!(fb(&e, comic, 14.5), (13.0, 4.0));
    // DejaVu's OS/2 typo numbers (1556/492) differ from hhea (1901/483):
    // 18.56 and 4.72, so hhea it is.
    assert_eq!(fb(&e, dejavu, 20.0), (19.0, 5.0));
    // A TrueType font is scaled through 16.16 fixed point, which lands a hair
    // under the exact product: 900/1000 becomes 58982/65536, so 4.5 and 13.5
    // are 4.49997 and 13.49991 and round down where plain arithmetic rounds up.
    assert_eq!(fb(&e, comic, 5.0), (4.0, 1.0));
    assert_eq!(fb(&e, comic, 15.0), (13.0, 4.0));
    assert_eq!(fb(&e, bangers, 500.0), (441.0, 90.0));
    // The unrounded box is still there for what must not jump with size.
    let u = e.font_box_unrounded(Face::new(comic, 15.0)).unwrap();
    assert!(close(u.ascent, 13.5) && close(u.descent, 3.75));
}

#[test]
fn webkits_synthetic_bold_adds_a_36th_of_the_size_per_glyph() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    let size = 36.0;
    let plain = Face::new(comic, size);
    let w = e.advance(plain, "WAIT").unwrap();
    assert_eq!(e.advance(bold(plain), "WAIT").unwrap(), w);

    e.rules.bold_advance = BoldAdvance::WebKit;
    assert!(close(e.advance(bold(plain), "WAIT").unwrap(), w + 4.0));
    // A real face is left alone, and so is the unsynthesised request.
    assert_eq!(e.advance(plain, "WAIT").unwrap(), w);
    // A ligature is one glyph and is widened once: "office" is o, ffi, c, e.
    let d = Face::new(dejavu, size);
    let office = e.advance(d, "office").unwrap();
    assert!(close(e.advance(bold(d), "office").unwrap(), office + 4.0));
    // The ink follows the pen: the second letter sits one step further right.
    let a = e.line_ink(bold(plain), "II").unwrap();
    e.rules.bold_advance = BoldAdvance::Unchanged;
    let b = e.line_ink(bold(plain), "II").unwrap();
    assert!(close(a.width, b.width + 2.0));
    assert!(close(a.right, b.right + 1.0));
    assert!(close(a.left, b.left));
}

#[test]
fn ascii_whitespace_is_measured_as_a_space() {
    let mut e = Engine::new();
    let [comic, bangers, dejavu, _] = all(&mut e);
    for font in [comic, bangers, dejavu] {
        let f = Face::new(font, 22.5);
        let spaced = e.advance(f, "A B").unwrap();
        for ws in ['\t', '\n', '\r', '\u{c}'] {
            let text = format!("A{ws}B");
            assert_eq!(e.advance(f, &text).unwrap(), spaced, "{ws:?}");
            assert_eq!(e.line_ink(f, &text).unwrap(), e.line_ink(f, "A B").unwrap());
            assert!(e.missing(font, &text).unwrap().is_empty());
        }
        // Other spaces are the font's own business.
        assert_ne!(e.advance(f, "A\u{2003}B").unwrap(), spaced);
    }
    // The raw run still shows what the font does with the character itself.
    let tab = e.shape(comic, "\t").unwrap()[0].id;
    let space = e.shape(comic, " ").unwrap()[0].id;
    assert_ne!(tab, space);
}

#[test]
fn spaces_at_the_end_of_a_line_hang_and_a_long_word_moves_before_it_is_cut() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let f = Face::new(comic, 20.0);
    let ab = e.advance(f, "AB").unwrap();
    // However many spaces follow, they are not counted against the width.
    assert_eq!(wrap(&mut e, f, "AB      AB", ab, 0.0), ["AB      ", "AB"]);
    assert_eq!(
        wrap(&mut e, f, "AB AB", ab * 2.0 - 0.01, 0.0),
        ["AB ", "AB"]
    );
    // A line that exactly fills the box fits.
    let whole = e.advance(f, "AB AB").unwrap();
    assert_eq!(wrap(&mut e, f, "AB AB", whole, 0.0), ["AB AB"]);
    assert_eq!(wrap(&mut e, f, "AB AB", whole - 0.01, 0.0), ["AB ", "AB"]);
    // A word wider than the line goes to a line of its own first; only then
    // is it cut, after the last letter that fits.
    let w = e.advance(f, "W").unwrap();
    assert_eq!(
        wrap(&mut e, f, "A WWWWW", w * 3.0 + 0.01, 0.0),
        ["A ", "WWW", "WW"]
    );
    // Spaces alone never force an empty line.
    assert_eq!(wrap(&mut e, f, "W W", 1.0, 0.0), ["W ", "W"]);
}

#[test]
fn letter_spacing_follows_every_letter_and_switches_ligatures_off() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    let f = Face::new(comic, 20.0);
    let a = e.advance(f, "H").unwrap();
    let s = 3.0;
    // The last letter of a line carries its spacing too: four letters need
    // four spacings.
    assert_eq!(wrap(&mut e, f, "HHHH", 4.0 * a + 4.0 * s, s), ["HHHH"]);
    assert_eq!(wrap(&mut e, f, "HHHH", 4.0 * a + 3.5 * s, s), ["HHH", "H"]);
    // A hanging space takes none.
    assert_eq!(
        wrap(&mut e, f, "HH HH", 2.0 * a + 2.0 * s, s),
        ["HH ", "HH"]
    );
    // A mark is not a letter of its own.
    let accented = e.advance(f, "e\u{301}").unwrap();
    assert_eq!(
        wrap(&mut e, f, "e\u{301}e\u{301}", 2.0 * accented + 2.0 * s, s),
        ["e\u{301}e\u{301}"]
    );

    // DejaVu draws "ff" as one glyph, narrower than two. Spaced out it is
    // two letters again, and that is the width the breaker tests.
    let d = Face::new(dejavu, 40.0);
    let joined = e.advance(d, "ff").unwrap();
    let apart = 2.0 * e.advance(d, "f").unwrap();
    assert!(joined < apart - 0.5, "the fixture has no ff ligature");
    assert_eq!(wrap(&mut e, d, "ff", apart + 2.0 * s, s), ["ff"]);
    assert_eq!(wrap(&mut e, d, "ff", apart + 2.0 * s - 0.05, s), ["f", "f"]);
    assert_eq!(wrap(&mut e, d, "ff", joined, 0.0), ["ff"]);
}

#[test]
fn a_cut_never_parts_a_mark_from_its_letter_and_what_follows_is_shaped_again() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    let f = Face::new(comic, 20.0);
    assert_eq!(
        wrap(&mut e, f, "e\u{301}e\u{301}", 1.0, 0.0),
        ["e\u{301}", "e\u{301}"]
    );
    // A cut through DejaVu's ffi ligature: every piece is measured as it
    // will be drawn, by itself, so none is wider than the box.
    let d = Face::new(dejavu, 40.0);
    let text = "ffiffiffiffi";
    for width in [30.0, 41.0, 55.0, 64.0, 90.0] {
        let lines = wrap(&mut e, d, text, width, 0.0);
        assert_eq!(lines.concat(), text);
        for line in &lines {
            let w = e.advance(d, line).unwrap();
            assert!(
                w <= width + 1.0 / 128.0 || line.chars().count() == 1,
                "{line:?} is {w} in {width}"
            );
        }
    }
}

/// Comic Neue with a chain of the fonts named, most preferred first.
fn with_chain(e: &mut Engine, font: FontId, chain: &[FontId], size: f64) -> Face {
    let id = e.chain_new();
    for &f in chain {
        e.chain_push(id, f, Synth::NONE).unwrap();
    }
    Face {
        chain: id,
        ..Face::new(font, size)
    }
}

#[test]
fn a_letter_the_face_lacks_is_drawn_from_the_chain() {
    let mut e = Engine::new();
    let [comic, bangers, dejavu, _] = all(&mut e);
    let size = 40.0;
    let plain = Face::new(comic, size);
    let d = Face::new(dejavu, size);
    // Comic Neue has no Greek; DejaVu Sans has.
    assert_eq!(e.missing(comic, "A\u{3a9}B").unwrap(), [1]);
    let f = with_chain(&mut e, comic, &[dejavu], size);

    let a = e.advance(plain, "A").unwrap();
    let b = e.advance(plain, "B").unwrap();
    let omega = e.advance(d, "\u{3a9}").unwrap();
    assert!(close(e.advance(f, "A\u{3a9}B").unwrap(), a + omega + b));
    let fonts: Vec<FontId> = e.parts().iter().map(|p| p.font).collect();
    assert_eq!(fonts, [comic, dejavu, comic]);
    assert!(e.missing_in(f, "A\u{3a9}B").unwrap().is_empty());

    // The ink is the fallback glyph's own, at its place on the line.
    let alone = e.line_ink(d, "\u{3a9}").unwrap();
    let line = e.line_ink(f, "A\u{3a9}").unwrap();
    assert!(close(line.width, a + omega));
    assert!(close(line.right, a + alone.right));
    assert!(close(
        line.ascent,
        alone.ascent.max(e.line_ink(plain, "A").unwrap().ascent)
    ));
    let glyph = e.glyph_ink(f, "\u{3a9}").unwrap();
    let own = e.glyph_ink(d, "\u{3a9}").unwrap();
    assert!(glyph.has_ink);
    assert!(close(glyph.left, own.left) && close(glyph.right, own.right));

    // Text the face covers is one part and not a bit different.
    for text in ["WAIT!", "", "   ", "A V"] {
        assert_eq!(e.advance(f, text).unwrap(), e.advance(plain, text).unwrap());
        assert_eq!(e.parts().len(), 1);
        assert_eq!(
            e.line_ink(f, text).unwrap(),
            e.line_ink(plain, text).unwrap()
        );
    }

    // No chain, or an empty one: the face's own .notdef, as before.
    let notdef = e.advance(plain, "A\u{3a9}B").unwrap();
    assert!(!close(notdef, a + omega + b));
    let empty = with_chain(&mut e, comic, &[], size);
    assert_eq!(e.advance(empty, "A\u{3a9}B").unwrap(), notdef);
    assert_eq!(e.missing_in(empty, "A\u{3a9}B").unwrap(), [1]);

    // What no font of the chain has is still reported, and only that.
    let both = with_chain(&mut e, comic, &[bangers, dejavu], size);
    assert_eq!(
        e.missing_in(both, "A\u{3a9}\u{d55c}B\u{d55c}").unwrap(),
        [2, 4]
    );
    assert!(e.chain_free(both.chain));
    assert!(!e.chain_free(both.chain));
}

#[test]
fn a_run_stays_in_the_font_it_is_in_and_a_mark_stays_with_its_letter() {
    let mut e = Engine::new();
    let [comic, bangers, dejavu, _] = all(&mut e);
    let size = 40.0;
    // U+0126 is in Bangers and DejaVu, U+03A9 only in DejaVu, neither in
    // Comic Neue.
    let f = with_chain(&mut e, comic, &[bangers, dejavu], size);
    let fonts = |e: &mut Engine, text: &str| -> Vec<FontId> {
        e.advance(f, text).unwrap();
        e.parts().iter().map(|p| p.font).collect()
    };
    // Taken by itself the letter comes from the first font that has it.
    assert_eq!(fonts(&mut e, "\u{126}"), [bangers]);
    // After a letter only DejaVu has, the run stays in DejaVu.
    assert_eq!(fonts(&mut e, "\u{3a9}\u{126}"), [dejavu]);
    assert_eq!(fonts(&mut e, "\u{126}\u{3a9}"), [bangers, dejavu]);
    // The face itself is always preferred where it has the letter, a space
    // included.
    assert_eq!(
        fonts(&mut e, "\u{3a9} \u{3a9}A"),
        [dejavu, comic, dejavu, comic]
    );

    // Comic Neue has the acute accent, but an accent goes where its letter
    // goes: the pair is one cluster in DejaVu.
    assert!(e.missing(comic, "\u{301}").unwrap().is_empty());
    assert_eq!(fonts(&mut e, "A\u{3a9}\u{301}B"), [comic, dejavu, comic]);
    let d = Face::new(dejavu, size);
    let plain = Face::new(comic, size);
    let want = e.advance(plain, "A").unwrap()
        + e.advance(d, "\u{3a9}\u{301}").unwrap()
        + e.advance(plain, "B").unwrap();
    assert!(close(e.advance(f, "A\u{3a9}\u{301}B").unwrap(), want));
}

#[test]
fn the_breaker_measures_with_the_chain_too() {
    let mut e = Engine::new();
    let [comic, _, dejavu, _] = all(&mut e);
    let size = 40.0;
    let plain = Face::new(comic, size);
    let f = with_chain(&mut e, comic, &[dejavu], size);
    let word = "\u{3a9}\u{3a9}\u{3a9}";
    let text = format!("{word} {word}");
    let real = e.advance(f, word).unwrap();
    let boxes = e.advance(plain, word).unwrap();
    assert!((real - boxes).abs() > 1.0);
    // The width that decides is the fallback font's, not the .notdef box's.
    assert_eq!(
        wrap(&mut e, f, &text, real, 0.0),
        [format!("{word} "), word.into()]
    );
    assert_eq!(wrap(&mut e, f, &text, real - 0.05, 0.0).len(), 4);
    let two = e.advance(f, &text).unwrap();
    assert_eq!(wrap(&mut e, f, &text, two, 0.0), [text.as_str()]);
    // A cut inside the fallback word is measured in the fallback font.
    let one = e.advance(f, "\u{3a9}").unwrap();
    assert_eq!(
        wrap(&mut e, f, word, one * 2.0, 0.0),
        ["\u{3a9}\u{3a9}", "\u{3a9}"]
    );
}
