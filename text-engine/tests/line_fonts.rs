//! Which font each stretch of a line is drawn in (`Engine::line_fonts`),
//! against the fixture fonts: Comic Neue has no Greek, Bangers has `Ħ` and
//! no `Ω`, DejaVu Sans has both.

use mt_text::{Engine, Face, FontId, Synth};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

/// Comic Neue with a chain of Bangers (emboldened), then DejaVu Sans.
fn setup() -> (Engine, Face, [FontId; 3]) {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let bangers = load(&mut e, "Bangers-Regular.ttf");
    let dejavu = load(&mut e, "DejaVuSans.ttf");
    let chain = e.chain_new();
    e.chain_push(chain, bangers, Synth::from_bits(1)).unwrap();
    e.chain_push(chain, dejavu, Synth::NONE).unwrap();
    let face = Face {
        chain,
        ..Face::new(comic, 40.0)
    };
    (e, face, [comic, bangers, dejavu])
}

fn fonts(e: &mut Engine, face: Face, text: &str) -> Vec<(FontId, u32, u32, u32)> {
    e.line_fonts(face, text)
        .unwrap()
        .iter()
        .map(|p| (p.font, p.synth.bits(), p.text.start, p.text.end))
        .collect()
}

#[test]
fn a_line_the_face_has_all_of_is_one_part() {
    let (mut e, face, [comic, ..]) = setup();
    assert_eq!(fonts(&mut e, face, "WAIT"), [(comic, 0, 0, 4)]);
    assert_eq!(fonts(&mut e, face, ""), [(comic, 0, 0, 0)]);
}

#[test]
fn a_letter_stays_with_the_lender_before_it_whatever_the_chain_lists_first() {
    let (mut e, face, [comic, bangers, dejavu]) = setup();
    // Bangers is first in the chain and has `Ħ`; alone, it lends it.
    assert_eq!(
        fonts(&mut e, face, "AĦ"),
        [(comic, 0, 0, 1), (bangers, 1, 1, 2)]
    );
    // After `Ω`, which only DejaVu has, `Ħ` stays in DejaVu.
    assert_eq!(
        fonts(&mut e, face, "AΩĦB"),
        [(comic, 0, 0, 1), (dejavu, 0, 1, 3), (comic, 0, 3, 4)]
    );
    // The parts are what is measured: their advances, each alone in its
    // font, are the line's.
    let whole = e.advance(face, "ΩĦ").unwrap();
    let alone = e.advance(Face::new(dejavu, 40.0), "ΩĦ").unwrap();
    assert_eq!(whole, alone);
}

#[test]
fn a_part_never_ends_inside_a_cluster_and_offsets_are_utf16() {
    let (mut e, face, [comic, _, dejavu]) = setup();
    // A letter and the mark on it are one font's.
    assert_eq!(
        fonts(&mut e, face, "AΩ\u{301}B"),
        [(comic, 0, 0, 1), (dejavu, 0, 1, 3), (comic, 0, 3, 4)]
    );
    // A letter outside the BMP is two units: U+1D538, a double-struck A
    // DejaVu Sans has and Comic Neue has not.
    let parts = fonts(&mut e, face, "A\u{1d538}B");
    assert_eq!(parts.len(), 3, "{parts:?}");
    assert_eq!((parts[1].2, parts[1].3), (1, 3));
    assert_eq!((parts[2].2, parts[2].3), (3, 4));
    assert_eq!(parts[1].0, dejavu);
}
