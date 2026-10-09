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

// ===========================================================================
// Variable fonts made here, in memory
// ===========================================================================
// Comic Neue with an `fvar` table put in (and an `MVAR` where a test wants
// one). It has no `gvar`, so its outlines are the same everywhere - what
// these tests are about is everything else an instance is: which numbers of
// a file the engine believes, where the instance is, and what it is called.
// No file is added to the repository and every machine runs them.

fn comic_bytes() -> Vec<u8> {
    let path = format!(
        "{}/../src/test/fonts/ComicNeue-Regular.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(path).unwrap()
}

/// `font` with `tables` added (or put in place of the ones it has).
fn with_tables(font: &[u8], tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    let u16_at = |at: usize| u16::from_be_bytes([font[at], font[at + 1]]) as usize;
    let u32_at = |at: usize| u32::from_be_bytes(font[at..at + 4].try_into().unwrap()) as usize;
    let mut all: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    for i in 0..u16_at(4) {
        let rec = 12 + i * 16;
        let tag: [u8; 4] = font[rec..rec + 4].try_into().unwrap();
        if tables.iter().any(|(t, _)| **t == tag) {
            continue;
        }
        let (offset, len) = (u32_at(rec + 8), u32_at(rec + 12));
        all.push((tag, font[offset..offset + len].to_vec()));
    }
    all.extend(tables.iter().map(|(t, d)| (**t, d.clone())));
    all.sort_by_key(|(tag, _)| *tag);
    let mut out = font[..4].to_vec();
    out.extend((all.len() as u16).to_be_bytes());
    out.extend([0u8; 6]);
    let mut offset = 12 + all.len() * 16;
    let mut body = Vec::new();
    for (tag, data) in &all {
        out.extend(tag);
        out.extend(0u32.to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((data.len() as u32).to_be_bytes());
        body.extend(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
        offset = 12 + all.len() * 16 + body.len();
    }
    out.extend(body);
    out
}

/// 16.16, from a number of 1/65536ths.
type Fixed = i32;
const fn fx(whole: i32) -> Fixed {
    whole * 65536
}
struct Axis(&'static [u8; 4], Fixed, Fixed, Fixed);
/// A named instance: the name ID of its style, where it is, and the name ID
/// of its PostScript name when the table is to carry one.
struct Named(u16, Vec<Fixed>, Option<u16>);

fn fvar(axes: &[Axis], instances: &[Named]) -> Vec<u8> {
    let with_ps = instances.iter().any(|i| i.2.is_some());
    let mut t = Vec::new();
    for v in [
        1u16,
        0,
        16,
        2,
        axes.len() as u16,
        20,
        instances.len() as u16,
    ] {
        t.extend(v.to_be_bytes());
    }
    t.extend((4 + 4 * axes.len() as u16 + if with_ps { 2 } else { 0 }).to_be_bytes());
    for Axis(tag, min, default, max) in axes {
        t.extend(*tag);
        for v in [min, default, max] {
            t.extend(v.to_be_bytes());
        }
        t.extend([0, 0, 1, 0]); // flags, and a name ID nobody reads here
    }
    for Named(style, at, ps) in instances {
        t.extend(style.to_be_bytes());
        t.extend([0, 0]);
        for v in at {
            t.extend(v.to_be_bytes());
        }
        if with_ps {
            t.extend(ps.unwrap_or(0xffff).to_be_bytes());
        }
    }
    t
}

/// An `MVAR` that moves each of `values` by its delta at the top of the
/// first of `axis_count` axes, and by nothing at the default.
fn mvar(axis_count: u16, values: &[(&[u8; 4], i16)]) -> Vec<u8> {
    let mut values: Vec<_> = values.to_vec();
    values.sort_by_key(|(tag, _)| **tag);
    let n = values.len() as u16;
    let mut t = Vec::new();
    for v in [1u16, 0, 0, 8, n, 12 + 8 * n] {
        t.extend(v.to_be_bytes());
    }
    for (i, (tag, _)) in values.iter().enumerate() {
        t.extend(**tag);
        t.extend([0, 0]);
        t.extend((i as u16).to_be_bytes());
    }
    // The item variation store: one region (the first axis from its default
    // to its top), one set of deltas.
    let regions = 4 + 6 * u32::from(axis_count);
    t.extend(1u16.to_be_bytes());
    t.extend(12u32.to_be_bytes());
    t.extend(1u16.to_be_bytes());
    t.extend((12 + regions).to_be_bytes());
    t.extend(axis_count.to_be_bytes());
    t.extend(1u16.to_be_bytes());
    for axis in 0..axis_count {
        let (start, peak, end): (i16, i16, i16) = if axis == 0 {
            (0, 0x4000, 0x4000)
        } else {
            (0, 0, 0)
        };
        for v in [start, peak, end] {
            t.extend(v.to_be_bytes());
        }
    }
    for v in [n, 1, 1, 0] {
        t.extend(v.to_be_bytes());
    }
    for (_, delta) in &values {
        t.extend(delta.to_be_bytes());
    }
    t
}

const WDTH: Tag = Tag::new(b"wdth");
const SLNT: Tag = Tag::new(b"slnt");

fn variable(engine: &mut Engine, axes: &[Axis], instances: &[Named]) -> FontId {
    let bytes = with_tables(&comic_bytes(), &[(b"fvar", fvar(axes, instances))]);
    engine
        .add_font_bytes(bytes, 0)
        .expect("the made font loads")
}

fn name(engine: &Engine, font: FontId) -> String {
    engine.info(font).unwrap().postscript_name.clone()
}

#[test]
fn an_axis_that_is_not_a_range_is_not_an_axis_and_nothing_traps() {
    // Each of these is a file a damaged or hostile font can be.
    let damaged = [
        Axis(b"wght", fx(800), fx(400), fx(700)), // minimum above the maximum
        Axis(b"wght", fx(400), fx(900), fx(700)), // default above the maximum
        Axis(b"wght", fx(400), fx(100), fx(700)), // default below the minimum
        Axis(b"wght", fx(900), fx(900), fx(100)), // all of it upside down
    ];
    for axis in damaged {
        let mut e = Engine::new();
        let font = variable(
            &mut e,
            &[axis, Axis(b"wdth", fx(50), fx(100), fx(200))],
            &[],
        );
        // The font is a font: it measures, and it says it has one axis.
        assert!(e.advance(Face::new(font, 100.0), TEXT).unwrap() > 0.0);
        let axes: Vec<_> = e
            .info(font)
            .unwrap()
            .axes
            .iter()
            .map(|a| a.tag.clone())
            .collect();
        assert_eq!(axes, ["wdth"]);
        // A place on the damaged axis is refused, for any number, and the
        // engine goes on working afterwards.
        for value in [700.0, 0.0, -1e30, 1e30, f32::MAX, f32::MIN_POSITIVE] {
            assert!(e.add_instance(font, &[(WGHT, value)]).is_err(), "{value}");
        }
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(e.add_instance(font, &[(WGHT, value)]).is_err());
            assert!(e.add_instance(font, &[(WDTH, value)]).is_err());
        }
        // The sound axis beside it is still an axis.
        let wide = e.add_instance(font, &[(WDTH, 1e30)]).unwrap();
        assert_eq!(e.font(wide).unwrap().location(), &[(WDTH, 200.0)]);
        assert_eq!(name(&e, wide), "ComicNeue_200wdth");
        assert!(e.advance(Face::new(wide, 100.0), TEXT).unwrap() > 0.0);
    }
}

#[test]
fn an_instance_of_an_instance_keeps_the_axes_it_was_already_moved_on() {
    let mut e = Engine::new();
    let font = variable(
        &mut e,
        &[
            Axis(b"wght", fx(100), fx(400), fx(900)),
            Axis(b"wdth", fx(50), fx(100), fx(200)),
        ],
        &[],
    );
    let bold = e.add_instance(font, &[(WGHT, 700.0)]).unwrap();
    let bold_wide = e.add_instance(bold, &[(WDTH, 150.0)]).unwrap();
    assert_eq!(
        e.font(bold_wide).unwrap().location(),
        &[(WGHT, 700.0), (WDTH, 150.0)]
    );
    assert_eq!(name(&e, bold_wide), "ComicNeue_700wght_150wdth");
    // Moved again on the first axis: that one changes, the other stays.
    let light_wide = e.add_instance(bold_wide, &[(WGHT, 300.0)]).unwrap();
    assert_eq!(name(&e, light_wide), "ComicNeue_300wght_150wdth");
    // Both in one call are the same place.
    let both = e
        .add_instance(font, &[(WGHT, 700.0), (WDTH, 150.0)])
        .unwrap();
    assert_eq!(name(&e, both), "ComicNeue_700wght_150wdth");
    // An axis back at its default is not spelled out.
    let back = e.add_instance(bold_wide, &[(WGHT, 400.0)]).unwrap();
    assert_eq!(name(&e, back), "ComicNeue_150wdth");
}

#[test]
fn an_axis_value_is_spelled_so_that_it_reads_back_as_the_same_number() {
    let mut e = Engine::new();
    let font = variable(
        &mut e,
        &[
            Axis(b"wght", fx(100), fx(400), fx(900)),
            Axis(b"slnt", fx(-20), 0, fx(20)),
        ],
        &[],
    );
    let mut named = |settings: &[(Tag, f32)]| {
        let id = e.add_instance(font, settings).unwrap();
        name(&e, id)
    };
    assert_eq!(named(&[(WGHT, 650.0)]), "ComicNeue_650wght");
    assert_eq!(named(&[(WGHT, 87.5 + 100.0)]), "ComicNeue_187.5wght");
    // Two 16.16 numbers, 4 and 32 steps of 1/65536 above 650: two names.
    assert_eq!(
        named(&[(WGHT, 650.0 + 4.0 / 65536.0)]),
        "ComicNeue_650.00006wght"
    );
    assert_eq!(
        named(&[(WGHT, 650.0 + 32.0 / 65536.0)]),
        "ComicNeue_650.00049wght"
    );
    // One step of 1/65536, the smallest difference a file can hold. (Near
    // 650 the values the engine takes, `f32`, are four steps apart: what is
    // told apart is every place an instance can be put.)
    assert_eq!(named(&[(SLNT, 1.0 / 65536.0)]), "ComicNeue_.00002slnt");
    assert_eq!(named(&[(SLNT, 2.0 / 65536.0)]), "ComicNeue_.00003slnt");
    assert_eq!(named(&[(SLNT, -3.0 / 65536.0)]), "ComicNeue_-.00005slnt");
    // No leading zero, a sign for what is below zero, and a tag whole.
    assert_eq!(named(&[(SLNT, 0.5)]), "ComicNeue_.5slnt");
    assert_eq!(named(&[(SLNT, -0.25)]), "ComicNeue_-.25slnt");
    assert_eq!(named(&[(SLNT, -12.0)]), "ComicNeue_-12slnt");
    assert_eq!(
        named(&[(WGHT, 100.0), (SLNT, -20.0)]),
        "ComicNeue_100wght_-20slnt"
    );
}

#[test]
fn a_name_too_long_is_the_last_resort_and_still_tells_instances_apart() {
    let tags: [&'static [u8; 4]; 10] = [
        b"aaaa", b"bbbb", b"cccc", b"dddd", b"eeee", b"ffff", b"gggg", b"hhhh", b"iiii", b"jjjj",
    ];
    let axes: Vec<Axis> = tags.iter().map(|t| Axis(t, 0, fx(500), fx(1000))).collect();
    let mut e = Engine::new();
    let font = variable(&mut e, &axes, &[]);
    let place = |last: f32| -> Vec<(Tag, f32)> {
        tags.iter()
            .enumerate()
            .map(|(i, t)| {
                (
                    Tag::new(t),
                    if i == 9 { last } else { 123.456_79 + i as f32 },
                )
            })
            .collect()
    };
    // Ten descriptors of some fourteen characters each: over 127.
    let a = e.add_instance(font, &place(650.0)).unwrap();
    let b = e.add_instance(font, &place(651.0)).unwrap();
    let (a, b) = (name(&e, a), name(&e, b));
    for n in [&a, &b] {
        assert!(n.len() <= 127, "{} characters", n.len());
        assert!(n.starts_with("ComicNeue-"), "{n}");
        assert!(n.ends_with("..."), "{n}");
        assert_eq!(n.len(), "ComicNeue-".len() + 32 + 3);
        assert!(n["ComicNeue-".len()..n.len() - 3]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
    }
    assert_ne!(a, b);
    // The same place is the same name, every time.
    let again = e.add_instance(font, &place(650.0)).unwrap();
    assert_eq!(name(&e, again), a);
    // A name that fits is left as it is.
    let short = e.add_instance(font, &[(Tag::new(b"aaaa"), 1.0)]).unwrap();
    assert_eq!(name(&e, short), "ComicNeue_1aaaa");
}

#[test]
fn a_named_instance_has_the_name_the_font_gives_it() {
    // Name ID 1 of the file is "Comic Neue", 2 "Regular", 6 "ComicNeue-Regular".
    let axes = || [Axis(b"wght", fx(100), fx(400), fx(900))];
    // The table states a PostScript name for the instance: that name.
    let mut e = Engine::new();
    let stated = variable(&mut e, &axes(), &[Named(1, vec![fx(700)], Some(6))]);
    let bold = e.add_instance(stated, &[(WGHT, 700.0)]).unwrap();
    assert_eq!(name(&e, bold), "ComicNeue-Regular");
    // It states none: the prefix, a hyphen and the instance's style name.
    let unstated = variable(&mut e, &axes(), &[Named(1, vec![fx(700)], None)]);
    let bold = e.add_instance(unstated, &[(WGHT, 700.0)]).unwrap();
    assert_eq!(name(&e, bold), "ComicNeue-ComicNeue");
    // A place next to the named one is not the named one.
    let near = e
        .add_instance(unstated, &[(WGHT, 700.0 + 4.0 / 65536.0)])
        .unwrap();
    assert_eq!(name(&e, near), "ComicNeue_700.00006wght");
}

#[test]
fn an_instance_has_its_own_line_metrics() {
    let axes = [Axis(b"wght", fx(100), fx(400), fx(900))];
    let bytes = with_tables(
        &comic_bytes(),
        &[
            (b"fvar", fvar(&axes, &[])),
            (b"MVAR", mvar(1, &[(b"hasc", 120), (b"hdsc", -60)])),
        ],
    );
    let mut e = Engine::new();
    let font = e.add_font_bytes(bytes, 0).unwrap();
    let top = e.add_instance(font, &[(WGHT, 900.0)]).unwrap();
    let typo = |e: &Engine, id| e.info(id).unwrap().vertical.typo.unwrap();
    let (base, moved) = (typo(&e, font), typo(&e, top));
    assert_eq!(moved.ascent - base.ascent, 120.0);
    assert_eq!(moved.descent - base.descent, 60.0);
    // Half way up the axis, half the move.
    let half = e.add_instance(font, &[(WGHT, 650.0)]).unwrap();
    assert_eq!(typo(&e, half).ascent - base.ascent, 60.0);
}

// ---- names: what a font says of itself is not believed unread ----

/// A `name` table of these records and no others, as Windows English.
fn name_table(records: &[(u16, &str)]) -> Vec<u8> {
    let mut t = Vec::new();
    let mut strings: Vec<u8> = Vec::new();
    for v in [0u16, records.len() as u16, 6 + 12 * records.len() as u16] {
        t.extend(v.to_be_bytes());
    }
    for (id, text) in records {
        let wide: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        for v in [3u16, 1, 0x409, *id, wide.len() as u16, strings.len() as u16] {
            t.extend(v.to_be_bytes());
        }
        strings.extend(wide);
    }
    t.extend(strings);
    t
}

/// A font called "Test", with these axes, named instances and further names.
fn named(engine: &mut Engine, axes: &[Axis], instances: &[Named], more: &[(u16, &str)]) -> FontId {
    let mut records = vec![(1, "Test"), (2, "Regular"), (6, "Test-Regular")];
    for &(id, text) in more {
        records.retain(|(have, _)| *have != id);
        records.push((id, text));
    }
    let mut tables = vec![(b"name", name_table(&records))];
    if !axes.is_empty() {
        tables.push((b"fvar", fvar(axes, instances)));
    }
    engine
        .add_font_bytes(with_tables(&comic_bytes(), &tables), 0)
        .expect("the made font loads")
}

/// What a PostScript name may be made of: printable ASCII, no space, none
/// of PostScript's ten delimiters; and no longer than 127.
fn is_a_postscript_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 127
        && name
            .bytes()
            .all(|b| (33..=126).contains(&b) && !b"[](){}<>/%".contains(&b))
}

#[test]
fn two_places_never_share_a_name_whatever_the_axis_tags_are() {
    // Each pair of tags reads the same, or reads as the other with a digit
    // of the value, once the bytes a name cannot hold are dropped.
    let pairs: [(&'static [u8; 4], f32, &'static [u8; 4], f32); 4] = [
        (b"AB-C", 1.0, b"A-BC", 1.0),   // both "ABC"
        (b"1abc", 1.0, b"abc ", 11.0),  // "_1" "1abc" and "_11" "abc"
        (b"----", 312.0, b"12  ", 3.0), // "_312" "" and "_3" "12"
        (b"wg t", 5.0, b"wgt ", 5.0),   // both "wgt"
    ];
    for (one, at_one, other, at_other) in pairs {
        let mut e = Engine::new();
        let axes = [Axis(one, 0, 0, fx(1000)), Axis(other, 0, 0, fx(1000))];
        let font = named(&mut e, &axes, &[], &[]);
        let a = e.add_instance(font, &[(Tag::new(one), at_one)]).unwrap();
        let b = e
            .add_instance(font, &[(Tag::new(other), at_other)])
            .unwrap();
        let both = e
            .add_instance(
                font,
                &[(Tag::new(one), at_one), (Tag::new(other), at_other)],
            )
            .unwrap();
        let names = [name(&e, a), name(&e, b), name(&e, both)];
        assert_ne!(names[0], names[1], "{one:?} {other:?}");
        assert_ne!(names[0], names[2]);
        assert_ne!(names[1], names[2]);
        for n in &names {
            assert!(is_a_postscript_name(n), "{n}");
            // Not the note's own form, which cannot tell these apart: the
            // last resort.
            assert!(n.starts_with("Test-") && n.ends_with("..."), "{n}");
        }
        // The same place is the same name, every time.
        let again = e.add_instance(font, &[(Tag::new(one), at_one)]).unwrap();
        assert_eq!(name(&e, again), names[0]);
    }
    // A tag that only loses a byte, and is still no other tag of the font,
    // keeps the note's form.
    let mut e = Engine::new();
    let axes = [Axis(b"AB-C", 0, 0, fx(1000)), Axis(b"wght", 0, 0, fx(1000))];
    let font = named(&mut e, &axes, &[], &[]);
    let a = e.add_instance(font, &[(Tag::new(b"AB-C"), 1.0)]).unwrap();
    assert_eq!(name(&e, a), "Test_1ABC");
    let b = e.add_instance(font, &[(WGHT, 1.0)]).unwrap();
    assert_eq!(name(&e, b), "Test_1wght");
}

#[test]
fn two_named_instances_with_one_name_are_not_both_called_it() {
    let axes = || [Axis(b"wght", fx(100), fx(400), fx(900))];
    // The same style name at two places.
    let mut e = Engine::new();
    let font = named(
        &mut e,
        &axes(),
        &[
            Named(256, vec![fx(600)], None),
            Named(256, vec![fx(700)], None),
        ],
        &[(256, "Heavy")],
    );
    let (a, b) = (
        e.add_instance(font, &[(WGHT, 600.0)]).unwrap(),
        e.add_instance(font, &[(WGHT, 700.0)]).unwrap(),
    );
    assert_eq!(name(&e, a), "Test_600wght");
    assert_eq!(name(&e, b), "Test_700wght");
    // The same PostScript name stated for two places.
    let mut e = Engine::new();
    let font = named(
        &mut e,
        &axes(),
        &[
            Named(256, vec![fx(600)], Some(258)),
            Named(257, vec![fx(700)], Some(258)),
        ],
        &[(256, "Semi"), (257, "Heavy"), (258, "Test-Stated")],
    );
    let (a, b) = (
        e.add_instance(font, &[(WGHT, 600.0)]).unwrap(),
        e.add_instance(font, &[(WGHT, 700.0)]).unwrap(),
    );
    // Not the name, and not the style either: the place, spelled out.
    assert_eq!(name(&e, a), "Test_600wght");
    assert_eq!(name(&e, b), "Test_700wght");
    // A name stated twice for ONE place is that place's name.
    let mut e = Engine::new();
    let font = named(
        &mut e,
        &axes(),
        &[
            Named(256, vec![fx(700)], Some(258)),
            Named(257, vec![fx(700)], Some(258)),
        ],
        &[(256, "Semi"), (257, "Heavy"), (258, "Test-Stated")],
    );
    let a = e.add_instance(font, &[(WGHT, 700.0)]).unwrap();
    assert_eq!(name(&e, a), "Test-Stated");
}

#[test]
fn a_name_the_font_states_is_used_only_when_it_is_a_postscript_name() {
    let axes = || [Axis(b"wght", fx(100), fx(400), fx(900))];
    let stated = |text: &str| {
        let mut e = Engine::new();
        let font = named(
            &mut e,
            &axes(),
            &[Named(257, vec![fx(700)], Some(256))],
            &[(256, text), (257, "Heavy")],
        );
        let bold = e.add_instance(font, &[(WGHT, 700.0)]).unwrap();
        name(&e, bold)
    };
    // A name that is one is the instance's name, as the font says.
    assert_eq!(stated("Test_Heavy-1.0"), "Test_Heavy-1.0");
    assert_eq!(stated("  Test-Stated  "), "Test-Stated");
    // One that is not is not used, and the instance has the made name.
    let mut bad = vec![
        "Bad []/%é Name".to_string(),
        "Tést".into(),
        "Te\u{7}st".into(),
    ];
    bad.extend(" [](){}<>/%".chars().map(|c| format!("Te{c}st")));
    bad.push("T".repeat(128));
    for text in &bad {
        assert_eq!(stated(text), "Test-Heavy", "{text:?}");
    }

    // Name ID 6 of a font with no axes, where the engine reads it.
    let plain = |text: &str| {
        let mut e = Engine::new();
        let font = named(&mut e, &[], &[], &[(6, text)]);
        name(&e, font)
    };
    assert_eq!(plain("Test-Regular"), "Test-Regular");
    assert_eq!(plain("  Test-Regular "), "Test-Regular");
    for text in &bad {
        // No name: whoever writes one down makes it from the family.
        assert_eq!(plain(text), "", "{text:?}");
    }
    assert_eq!(plain("   "), "");

    // Name ID 25, the prefix of every made name: letters and digits of it.
    let mut e = Engine::new();
    let font = named(&mut e, &axes(), &[], &[(25, "Te st[]/%é(1)")]);
    let at = e.add_instance(font, &[(WGHT, 650.0)]).unwrap();
    assert_eq!(name(&e, at), "Test1_650wght");
    // One with no letter or digit in it is no prefix: the family is.
    let mut e = Engine::new();
    let font = named(&mut e, &axes(), &[], &[(25, " []/% ")]);
    let at = e.add_instance(font, &[(WGHT, 650.0)]).unwrap();
    assert_eq!(name(&e, at), "Test_650wght");
}

#[test]
fn the_last_resort_name_is_within_the_limit_whatever_the_prefix() {
    let long = "P".repeat(200);
    let mut e = Engine::new();
    let axes = [Axis(b"wght", fx(100), fx(400), fx(900))];
    let font = named(&mut e, &axes, &[], &[(25, &long)]);
    let (a, b) = (
        e.add_instance(font, &[(WGHT, 650.0)]).unwrap(),
        e.add_instance(font, &[(WGHT, 651.0)]).unwrap(),
    );
    let (a, b) = (name(&e, a), name(&e, b));
    for n in [&a, &b] {
        assert_eq!(n.len(), 127, "{n}");
        assert!(is_a_postscript_name(n), "{n}");
        // As much of the prefix as leaves room for `-`, the hash and `...`.
        assert!(n.starts_with(&format!("{}-", "P".repeat(91))), "{n}");
        assert!(n.ends_with("..."));
    }
    assert_ne!(a, b);
}
