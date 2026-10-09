//! Variation instances, against a variable font OF THIS MACHINE read where it
//! lies. The repository ships no font file for this (it ships none it does
//! not have to), so on a machine without the font these tests say so and
//! pass: they are proofs for a Mac, not a gate for every lane.
//!
//! The figures are the font's own: STIX Two Text has one axis, `wght` 400 to
//! 700, default 400, and four named instances.

use mt_text::{Engine, Face, FontId};
use skrifa::raw::types::Tag;

const STIX: &str = "/System/Library/Fonts/Supplemental/STIXTwoText.ttf";
const WGHT: Tag = Tag::new(b"wght");
const TEXT: &str = "Hamburgefonstiv 0123";

fn stix(engine: &mut Engine) -> Option<FontId> {
    match std::fs::read(STIX) {
        Ok(bytes) => Some(
            engine
                .add_font_bytes(bytes, 0)
                .expect("the system font loads"),
        ),
        Err(_) => {
            eprintln!("SKIPPED: {STIX} is not on this machine");
            None
        }
    }
}

/// How wide the ink of `text` is at 1000 px: font units, for these fonts.
fn ink(engine: &mut Engine, font: FontId, text: &str) -> f64 {
    let i = engine.line_ink(Face::new(font, 1000.0), text).unwrap();
    i.left + i.right
}

#[test]
fn an_instance_is_measured_and_drawn_at_its_own_place() {
    let mut e = Engine::new();
    let Some(base) = stix(&mut e) else { return };
    let bold = e.add_instance(base, &[(WGHT, 700.0)]).unwrap();
    assert!(bold != base && bold != 0);

    // Advances come from the instance (HVAR): the bold is wider.
    let regular = e.advance(Face::new(base, 100.0), TEXT).unwrap();
    let wide = e.advance(Face::new(bold, 100.0), TEXT).unwrap();
    assert!((regular - 962.2).abs() < 0.05, "regular {regular}");
    assert!((wide - 1047.3).abs() < 0.05, "bold {wide}");

    // Outlines come from the instance too (gvar): the ink of an `l`, stem
    // and serifs, is 234 units across and then 303, which no change of
    // advance would do.
    let thin = ink(&mut e, base, "l");
    let thick = ink(&mut e, bold, "l");
    assert_eq!((thin, thick), (234.0, 303.0));

    // The font it was made from is where it was.
    assert_eq!(e.advance(Face::new(base, 100.0), TEXT).unwrap(), regular);
    assert!(e.font(base).unwrap().location().is_empty());
    assert_eq!(e.font(bold).unwrap().location(), &[(WGHT, 700.0)]);
}

#[test]
fn an_instance_at_the_default_is_the_font_itself() {
    let mut e = Engine::new();
    let Some(base) = stix(&mut e) else { return };
    let same = e.add_instance(base, &[(WGHT, 400.0)]).unwrap();
    assert_eq!(
        e.advance(Face::new(same, 100.0), TEXT).unwrap(),
        e.advance(Face::new(base, 100.0), TEXT).unwrap()
    );
    assert_eq!(ink(&mut e, same, "l"), ink(&mut e, base, "l"));
    assert_eq!(
        e.info(same).unwrap().postscript_name,
        e.info(base).unwrap().postscript_name
    );
}

#[test]
fn a_value_past_the_axis_stops_at_its_end_and_an_unknown_axis_is_ignored() {
    let mut e = Engine::new();
    let Some(base) = stix(&mut e) else { return };
    let top = e.add_instance(base, &[(WGHT, 700.0)]).unwrap();
    let over = e.add_instance(base, &[(WGHT, 1000.0)]).unwrap();
    assert_eq!(e.font(over).unwrap().location(), &[(WGHT, 700.0)]);
    assert_eq!(
        e.advance(Face::new(over, 100.0), TEXT).unwrap(),
        e.advance(Face::new(top, 100.0), TEXT).unwrap()
    );
    let none = e.add_instance(base, &[(Tag::new(b"slnt"), -12.0)]).unwrap();
    assert!(e.font(none).unwrap().location().is_empty());
    assert!(e.add_instance(base, &[(WGHT, f32::NAN)]).is_err());
    assert!(e.add_instance(9999, &[(WGHT, 700.0)]).is_err());
}

#[test]
fn an_instance_has_the_name_adobes_rule_gives_it() {
    let mut e = Engine::new();
    let Some(base) = stix(&mut e) else { return };
    assert_eq!(e.info(base).unwrap().postscript_name, "STIXTwoText");
    // A named instance of the font: its own name.
    let bold = e.add_instance(base, &[(WGHT, 700.0)]).unwrap();
    assert_eq!(
        e.info(bold).unwrap().postscript_name,
        "STIXTwoTextRoman-Bold"
    );
    // A place between the named ones: the axis value spelled out.
    let between = e.add_instance(base, &[(WGHT, 650.0)]).unwrap();
    assert_eq!(
        e.info(between).unwrap().postscript_name,
        "STIXTwoTextRoman_650wght"
    );
    // The family and the axes are the file's, at every place.
    assert_eq!(e.info(bold).unwrap().family, e.info(base).unwrap().family);
    assert_eq!(e.info(bold).unwrap().axes.len(), 1);
}

#[test]
fn an_instance_outlives_the_font_it_was_made_from() {
    let mut e = Engine::new();
    let Some(base) = stix(&mut e) else { return };
    let bold = e.add_instance(base, &[(WGHT, 700.0)]).unwrap();
    let wide = e.advance(Face::new(bold, 100.0), TEXT).unwrap();
    assert!(e.remove_font(base));
    assert_eq!(e.advance(Face::new(bold, 100.0), TEXT).unwrap(), wide);
    assert!(e.remove_font(bold));
}

#[test]
fn a_font_with_no_axes_is_itself_at_any_place() {
    let mut e = Engine::new();
    let path = format!(
        "{}/../src/test/fonts/ComicNeue-Regular.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    let comic = e.add_font_bytes(std::fs::read(path).unwrap(), 0).unwrap();
    let again = e.add_instance(comic, &[(WGHT, 700.0)]).unwrap();
    assert_eq!(
        e.advance(Face::new(again, 100.0), TEXT).unwrap(),
        e.advance(Face::new(comic, 100.0), TEXT).unwrap()
    );
    assert_eq!(e.info(again).unwrap().postscript_name, "ComicNeue-Regular");
}
