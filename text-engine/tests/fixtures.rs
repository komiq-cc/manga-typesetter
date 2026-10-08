//! The engine against the four fixture fonts in `src/test/fonts/`.
//!
//! These pin behaviour the app relies on. Agreement with HarfBuzz and Skia is
//! checked from node (`parity/`), on the wasm build.

use mt_text::{bold_outset, Engine, Face, FontBoxRule, FontId, Synth, WrapOptions, OBLIQUE_SKEW};

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
