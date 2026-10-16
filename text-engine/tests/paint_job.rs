//! `paint_job`, feature by feature. Properties of the pixels, not golden
//! images: where the ink lands, what colour a known point has, what happens
//! where two shapes overlap.
#![cfg(feature = "paint")]

use mt_text::paint::{
    decode, paint_job, Affine, Align, Band, BoldDraw, Fill, Job, Mesh, Pt, Raster, Request, Rgba,
    Roughen, Run, Stop, Tile, MAGIC, MAX_MESH_SIDE, MAX_SIDE, WIRE_VERSION,
};
use mt_text::{bold_outset, BoldAdvance, Engine, Error, Face, FontId, Synth, WEBKIT_BOLD_ADVANCE};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const WHITE: Rgba = Rgba([255, 255, 255, 255]);
const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);

fn run(text: &str, x: f64, y: f64) -> Run {
    Run {
        text: text.to_owned(),
        x,
        y,
        rot: 0.0,
        sx: 1.0,
        sy: 1.0,
        skew: 0.0,
        drip: 0.0,
        fill: None,
    }
}

fn job(runs: Vec<Run>) -> Job {
    Job {
        curved: false,
        align: Align::Left,
        letter_spacing: 0.0,
        bands: Vec::new(),
        silhouette: None,
        no_fill: false,
        fill: Some(Fill::Solid(BLACK)),
        mesh: None,
        roughen: None,
        runs,
    }
}

fn request(job: Job, face: Face) -> Request {
    Request {
        job,
        face,
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
    }
}

fn paint(e: &mut Engine, r: &Request) -> Raster {
    paint_job(e, r).unwrap().expect("something was drawn")
}

/// The pixel at device `(x, y)`, transparent outside the raster.
fn px(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (lx, ly) = (x - r.x, y - r.y);
    if lx < 0 || ly < 0 || lx >= r.width as i32 || ly >= r.height as i32 {
        return [0; 4];
    }
    let i = (ly as usize * r.width as usize + lx as usize) * 4;
    [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]
}

/// Device box of the pixels with any alpha: `(x0, y0, x1, y1)`, end exclusive.
fn inked(r: &Raster) -> (i32, i32, i32, i32) {
    let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in 0..r.height as i32 {
        for x in 0..r.width as i32 {
            if r.data[(y as usize * r.width as usize + x as usize) * 4 + 3] != 0 {
                b = (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1));
            }
        }
    }
    (b.0 + r.x, b.1 + r.y, b.2 + r.x, b.3 + r.y)
}

/// `got` is the whole-pixel box of ink whose exact edges are `want`: never
/// inside it by a pixel, never outside it by one. An edge pixel covered by
/// less than half an alpha level is not ink, hence the small slack inward.
fn assert_box(got: (i32, i32, i32, i32), want: (f64, f64, f64, f64)) {
    let slack = 0.08;
    for (g, w, outward) in [
        (got.0, want.0, -1.0),
        (got.1, want.1, -1.0),
        (got.2, want.2, 1.0),
        (got.3, want.3, 1.0),
    ] {
        let over = (f64::from(g) - w) * outward;
        assert!(
            over > -slack && over < 1.0 + slack,
            "edge at {g}, ink at {w}: {got:?} vs {want:?}"
        );
    }
}

#[test]
fn an_empty_job_and_a_job_of_spaces_draw_nothing() {
    let mut e = Engine::new();
    let font = load(&mut e, "ComicNeue-Regular.ttf");
    let face = Face::new(font, 30.0);
    assert_eq!(paint_job(&mut e, &request(job(vec![]), face)), Ok(None));
    let spaces = job(vec![run("   ", 10.0, 40.0), run("", 10.0, 80.0)]);
    assert_eq!(paint_job(&mut e, &request(spaces, face)), Ok(None));
    // Ink, but nothing to paint it with.
    let mut clear = job(vec![run("A", 10.0, 40.0)]);
    clear.fill = Some(Fill::Solid(Rgba([9, 9, 9, 0])));
    assert_eq!(paint_job(&mut e, &request(clear, face)), Ok(None));
    // A transform that flattens the plane leaves nothing either.
    let mut flat = request(job(vec![run("A", 10.0, 40.0)]), face);
    flat.transform = Affine([1.0, 2.0, 2.0, 4.0, 0.0, 0.0]);
    assert_eq!(paint_job(&mut e, &flat), Ok(None));
    // An unknown font is an error, not an empty picture.
    let bad = request(job(vec![run("A", 0.0, 0.0)]), Face::new(999, 30.0));
    assert_eq!(paint_job(&mut e, &bad), Err(Error::UnknownFont));
}

#[test]
fn the_raster_is_cut_to_the_ink_at_each_alignment() {
    let mut e = Engine::new();
    for name in ["ComicNeue-Regular.ttf", "DejaVuSans.ttf"] {
        let font = load(&mut e, name);
        let face = Face::new(font, 40.0);
        let ink = e.line_ink(face, "WHAT?!").unwrap();
        for (align, start) in [
            (Align::Left, 0.0),
            (Align::Center, -ink.width / 2.0),
            (Align::Right, -ink.width),
        ] {
            let mut j = job(vec![run("WHAT?!", 300.25, 120.5)]);
            j.align = align;
            let r = paint(&mut e, &request(j, face));
            let want = (
                300.25 + start - ink.left,
                120.5 - ink.ascent,
                300.25 + start + ink.right,
                120.5 + ink.descent,
            );
            assert_box(inked(&r), want);
            // No larger than the ink needs: the raster is the box of the
            // outline, which is the box of the inked pixels unless the
            // outline only grazes its last pixel.
            let (got, all) = (
                inked(&r),
                (r.x, r.y, r.x + r.width as i32, r.y + r.height as i32),
            );
            assert!(
                got.0 - all.0 <= 1 && got.1 - all.1 <= 1,
                "{got:?} in {all:?}"
            );
            assert!(
                all.2 - got.2 <= 1 && all.3 - got.3 <= 1,
                "{got:?} in {all:?}"
            );
            assert!(all.0 <= got.0 && all.1 <= got.1 && all.2 >= got.2 && all.3 >= got.3);
        }
    }
}

#[test]
fn letter_spacing_moves_each_glyph_and_counts_after_the_last_one() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let ink = e.line_ink(face, "HHH").unwrap();
    let spaced = |align| {
        let mut j = job(vec![run("HHH", 200.0, 100.0)]);
        j.align = align;
        j.letter_spacing = 10.0;
        j
    };
    // Left: the last glyph is two gaps to the right.
    let left = inked(&paint(&mut e, &request(spaced(Align::Left), face)));
    assert_box(
        left,
        (
            200.0 - ink.left,
            100.0 - ink.ascent,
            200.0 + ink.right + 20.0,
            100.0 + ink.descent,
        ),
    );
    // Right: the advance ends at the anchor with a gap after the last
    // glyph, so the ink stops a gap short of where it would without spacing.
    let right = inked(&paint(&mut e, &request(spaced(Align::Right), face)));
    let end = 200.0 - ink.width + ink.right - 10.0;
    assert!((f64::from(right.2) - end).abs() < 1.0, "{right:?} vs {end}");
    // Centre: half the trailing gap left of centre.
    let centre = inked(&paint(&mut e, &request(spaced(Align::Center), face)));
    let mid = f64::from(centre.0 + centre.2) / 2.0;
    let want = 200.0 + (ink.right - ink.left - ink.width) / 2.0 - 5.0;
    assert!((mid - want).abs() < 0.75, "{mid} vs {want}");

    // Every glyph, not only the ends: the boxes above would be the same if
    // the middle H had stayed where it is without spacing. An H is one run
    // of inked columns (its bar joins its stems), so the picture has three,
    // each the same width and a glyph's advance plus the gap after the last.
    let raster = paint(&mut e, &request(spaced(Align::Left), face));
    let inked_column = |x: u32| {
        (0..raster.height).any(|y| raster.data[((y * raster.width + x) * 4 + 3) as usize] >= 128)
    };
    let mut letters: Vec<(u32, u32)> = Vec::new();
    for x in 0..raster.width {
        match (inked_column(x), letters.last_mut()) {
            (true, Some(last)) if last.1 == x => last.1 = x + 1,
            (true, _) => letters.push((x, x + 1)),
            _ => {}
        }
    }
    assert_eq!(letters.len(), 3, "{letters:?}");
    let pitch = ink.width / 3.0 + 10.0;
    let one = e.line_ink(face, "H").unwrap();
    for (k, &(from, to)) in letters.iter().enumerate() {
        let left = 200.0 - one.left + k as f64 * pitch;
        let got = f64::from(raster.x) + f64::from(from);
        assert!(
            (got - left).abs() <= 1.0,
            "letter {k} starts at {got}, not {left}"
        );
        let width = f64::from(to - from);
        assert!(
            (width - (one.left + one.right)).abs() <= 1.5,
            "letter {k} is {width} wide"
        );
    }
    // The same line unspaced has its middle letter a gap further left.
    let plain = paint(&mut e, &request(job(vec![run("HHH", 200.0, 100.0)]), face));
    assert_eq!(plain.width + 20, raster.width);
}

#[test]
fn the_transform_scales_turns_and_moves_the_ink() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let ink = e.line_ink(face, "Hx").unwrap();
    let (x, y) = (20.0, 60.0);
    // Corners of the ink box in job space.
    let corners = [
        Pt::new(x - ink.left, y - ink.ascent),
        Pt::new(x + ink.right, y - ink.ascent),
        Pt::new(x + ink.right, y + ink.descent),
        Pt::new(x - ink.left, y + ink.descent),
    ];
    let (sin, cos) = 33f64.to_radians().sin_cos();
    for m in [
        Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]),
        Affine([1.0, 0.0, 0.0, 1.0, -500.5, 33.25]),
        // Rotated 33 degrees about the origin, at 1.5x, then moved.
        Affine([1.5 * cos, 1.5 * sin, -1.5 * sin, 1.5 * cos, 400.0, 50.0]),
        // A quarter turn: "H" and "x" have straight sides, so the box of
        // the turned ink is the turned box.
        Affine([0.0, 1.0, -1.0, 0.0, 300.0, 0.0]),
    ] {
        let mut r = request(job(vec![run("Hx", x, y)]), face);
        r.transform = m;
        let got = inked(&paint(&mut e, &r));
        let dev: Vec<Pt> = corners.iter().map(|&c| m.apply(c)).collect();
        let lo = |f: fn(&Pt) -> f64| dev.iter().map(f).fold(f64::INFINITY, f64::min);
        let hi = |f: fn(&Pt) -> f64| dev.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
        let outer = (lo(|p| p.x), lo(|p| p.y), hi(|p| p.x), hi(|p| p.y));
        if m.0[1] == 0.0 || m.0[0] == 0.0 {
            assert_box(got, outer);
        } else {
            // Turned by an odd angle the ink is inside the turned box and
            // touches it only at the glyphs' own corners.
            assert!(f64::from(got.0) >= outer.0 - 1.0 && f64::from(got.2) <= outer.2 + 1.0);
            assert!(f64::from(got.1) >= outer.1 - 1.0 && f64::from(got.3) <= outer.3 + 1.0);
            let (w, h) = (f64::from(got.2 - got.0), f64::from(got.3 - got.1));
            assert!(w > (outer.2 - outer.0) * 0.8 && h > (outer.3 - outer.1) * 0.8);
        }
    }
}

/// A band, a synthesised bold and a weight all move the outline to one side
/// of the way it runs, and a mirror swaps the sides.
#[test]
fn a_mirrored_job_is_the_job_mirrored() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let bold = Synth {
        bold: true,
        oblique: false,
    };
    let band = Band {
        color: RED,
        opacity: 1.0,
        line: 6.0,
    };
    for (rule, synth, bands, weight) in [
        (BoldAdvance::Unchanged, Synth::NONE, vec![band], 0.0),
        (BoldAdvance::Unchanged, bold, Vec::new(), 0.0),
        (BoldAdvance::WebKit, bold, vec![band], 0.0),
        (BoldAdvance::Unchanged, Synth::NONE, Vec::new(), 1.5),
    ] {
        e.rules.bold_advance = rule;
        let mut j = job(vec![run("Rb", 20.0, 60.0)]);
        j.bands = bands;
        let face = Face {
            synth,
            ..Face::new(font, 40.0)
        };
        let mut r = request(j, face);
        r.weight = weight;
        let straight = paint(&mut e, &r);
        r.transform = Affine([-1.0, 0.0, 0.0, 1.0, 200.0, 0.0]);
        let mirrored = paint(&mut e, &r);
        let (a, b) = (inked(&straight), inked(&mirrored));
        assert_eq!((200 - a.2, a.1, 200 - a.0, a.3), b, "{rule:?} {synth:?}");
        for y in a.1..a.3 {
            for x in a.0..a.2 {
                let (p, q) = (px(&straight, x, y), px(&mirrored, 199 - x, y));
                for c in 0..4 {
                    assert!(p[c].abs_diff(q[c]) <= 2, "{x},{y}: {p:?} vs {q:?}");
                }
            }
        }
    }
}

#[test]
fn a_surface_beyond_the_guard_is_refused() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let mut r = request(job(vec![run("WWWW", 0.0, 0.0)]), Face::new(font, 400.0));
    r.transform = Affine([20.0, 0.0, 0.0, 20.0, 0.0, 0.0]);
    assert_eq!(paint_job(&mut e, &r), Err(Error::BadSpec));
    r.transform = Affine([8.0, 0.0, 0.0, 8.0, 0.0, 0.0]);
    let ok = paint(&mut e, &r);
    assert!(ok.width <= MAX_SIDE && ok.height <= MAX_SIDE);
}

#[test]
fn glyphs_that_overlap_are_one_shape_and_weight_grows_it() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let one = e.line_ink(face, "H").unwrap();
    // Two H pulled over each other by half a letter, in a half-transparent
    // fill: where they share ink it is laid once, neither doubled (a canvas
    // that fills letter by letter) nor missing.
    let mut j = job(vec![run("HH", 100.0, 100.0)]);
    j.letter_spacing = -one.width / 2.0;
    j.fill = Some(Fill::Solid(Rgba([255, 0, 0, 128])));
    let r = paint(&mut e, &request(j.clone(), face));
    let mut alphas = [0usize; 256];
    for p in r.data.chunks_exact(4) {
        alphas[p[3] as usize] += 1;
    }
    assert!(alphas[128] > 300, "{}", alphas[128]);
    assert_eq!(alphas[129..].iter().sum::<usize>(), 0);
    // The bar of the first H runs on into the second: one unbroken row.
    let mid_y = (100.0 - one.ascent / 2.0) as i32;
    let (from, to) = (
        100.0 + one.left.abs() + 1.0,
        100.0 + one.width / 2.0 + one.right - 1.0,
    );
    for x in from.ceil() as i32..to.floor() as i32 {
        assert_eq!(px(&r, x, mid_y)[3], 128, "column {x}");
    }

    // Weight: every edge of the fill moves out by that many device pixels,
    // here 2 at a scale of 2. The band stays where it was, so the heavier
    // fill covers 2 px more of it, and the ink is no larger for it.
    let mut j = job(vec![run("H", 100.0, 100.0)]);
    j.bands = vec![Band {
        color: BLUE,
        opacity: 1.0,
        line: 4.0,
    }];
    let mut heavy = request(j, face);
    heavy.transform = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    let plain = paint(&mut e, &heavy);
    heavy.weight = 2.0;
    let r = paint(&mut e, &heavy);
    let left = |r: &Raster, colour: [u8; 4]| {
        let y = 2 * mid_y;
        (r.x..r.x + r.width as i32)
            .find(|&x| px(r, x, y) == colour)
            .unwrap()
    };
    let black = [0, 0, 0, 255];
    assert_eq!(left(&plain, black) - left(&r, black), 2, "the fill");
    assert_eq!(left(&plain, BLUE.0), left(&r, BLUE.0), "the band");
    assert_eq!(inked(&plain), inked(&r));
    assert_box(
        inked(&r),
        (
            2.0 * (100.0 - one.left - 2.0),
            2.0 * (100.0 - one.ascent - 2.0),
            2.0 * (100.0 + one.right + 2.0),
            2.0 * (100.0 + one.descent + 2.0),
        ),
    );
    // With no band the ink grows by the weight, and a silhouette is as wide
    // as the wider of the heavier fill and the band: here the weight, 3
    // device px against the band's 2 job units at a scale of 1.
    let mut bare = request(job(vec![run("H", 100.0, 100.0)]), face);
    bare.weight = 3.0;
    let grown = (
        100.0 - one.left - 3.0,
        100.0 - one.ascent - 3.0,
        100.0 + one.right + 3.0,
        100.0 + one.descent + 3.0,
    );
    assert_box(inked(&paint(&mut e, &bare)), grown);
    bare.job.bands = vec![Band {
        color: BLUE,
        opacity: 1.0,
        line: 4.0,
    }];
    bare.job.silhouette = Some(RED);
    assert_box(inked(&paint(&mut e, &bare)), grown);
}

#[test]
fn a_scene_and_a_job_buffer_beyond_the_guards_are_refused() {
    use mt_text::abi_paint::{mt_paint_job, mt_paint_job_reserve, MAX_JOB_BYTES};
    use mt_text::paint::Scene;
    // A scene's surface passes the guard a job's does: each side, and the
    // pixels. 16384 x 16384 has sides that pass and a gigabyte of pixels.
    let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    assert!(Scene::new(16384, 16384, identity).is_err());
    assert!(Scene::new(16385, 1, identity).is_err());
    assert!(Scene::new(8192, 8192, identity).is_ok());

    // A job buffer larger than any job is refused with a null pointer, and
    // the next call is served as if nothing had happened.
    assert!(mt_paint_job_reserve(usize::MAX).is_null());
    assert!(mt_paint_job_reserve(MAX_JOB_BYTES + 1).is_null());
    let bytes = wire(77, "abc");
    let ptr = mt_paint_job_reserve(bytes.len());
    assert!(!ptr.is_null());
    // SAFETY: `ptr` is the engine's job buffer, at least `bytes.len()` long.
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    // Font 77 was never added: the job is read and refused for that, -2.
    assert_eq!(mt_paint_job(bytes.len()), -2);
}

#[test]
fn bands_are_painted_widest_first_under_the_fill() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    // "I" in DejaVu Sans is a plain bar: a stem with flat ends.
    let ink = e.line_ink(face, "I").unwrap();
    let mut j = job(vec![run("I", 100.0, 100.0)]);
    j.bands = vec![
        Band {
            color: RED,
            opacity: 1.0,
            line: 20.0,
        },
        Band {
            color: BLUE,
            opacity: 1.0,
            line: 8.0,
        },
    ];
    j.fill = Some(Fill::Solid(WHITE));
    let r = paint(&mut e, &request(j, face));
    let (left, right) = (100.0 - ink.left, 100.0 + ink.right);
    let mid_y = (100.0 - ink.ascent / 2.0) as i32;
    // Walking in from the left at mid height: red from 10 px out, blue
    // from 4 px out, white inside the stem.
    assert_eq!(px(&r, (left - 12.0) as i32, mid_y), [0, 0, 0, 0]);
    assert_eq!(px(&r, (left - 7.0) as i32, mid_y), [255, 0, 0, 255]);
    assert_eq!(px(&r, (left - 2.5) as i32, mid_y), [0, 0, 255, 255]);
    assert_eq!(
        px(&r, ((left + right) / 2.0) as i32, mid_y),
        [255, 255, 255, 255]
    );
    assert_eq!(px(&r, (right + 7.0) as i32, mid_y), [255, 0, 0, 255]);
    // The widest band reaches half its pen past the ink, corners rounded.
    assert_box(
        inked(&r),
        (
            left - 10.0,
            100.0 - ink.ascent - 10.0,
            right + 10.0,
            100.0 + ink.descent + 10.0,
        ),
    );
    let corner = px(&r, (left - 9.0) as i32, (100.0 - ink.ascent - 9.0) as i32);
    assert_eq!(
        corner[3], 0,
        "a round join leaves the corner of the box empty"
    );
}

#[test]
fn no_fill_cuts_the_glyphs_out_of_the_bands() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.line_ink(face, "I").unwrap();
    let bands = vec![
        Band {
            color: RED,
            opacity: 1.0,
            line: 20.0,
        },
        Band {
            color: BLUE,
            opacity: 1.0,
            line: 8.0,
        },
    ];
    let mut j = job(vec![run("I", 100.0, 100.0)]);
    j.bands = bands.clone();
    j.fill = Some(Fill::Solid(WHITE));
    j.no_fill = true;
    let r = paint(&mut e, &request(j.clone(), face));
    let (left, right) = (100.0 - ink.left, 100.0 + ink.right);
    let mid_y = (100.0 - ink.ascent / 2.0) as i32;
    // The bands outside the stem are as they were, and the stem is empty:
    // not the fill, and not the half of the blue band that lay inside it.
    assert_eq!(px(&r, (left - 7.0) as i32, mid_y), [255, 0, 0, 255]);
    assert_eq!(px(&r, (left - 2.5) as i32, mid_y), [0, 0, 255, 255]);
    assert_eq!(px(&r, (left + 1.5) as i32, mid_y), [0, 0, 0, 0]);
    assert_eq!(px(&r, ((left + right) / 2.0) as i32, mid_y), [0, 0, 0, 0]);
    assert_eq!(px(&r, (right + 7.0) as i32, mid_y), [255, 0, 0, 255]);
    // It reaches as far as it did with a fill.
    assert_box(
        inked(&r),
        (
            left - 10.0,
            100.0 - ink.ascent - 10.0,
            right + 10.0,
            100.0 + ink.descent + 10.0,
        ),
    );

    // The silhouette a shadow is cast from is cut the same way.
    let grey = Rgba([119, 119, 119, 255]);
    j.silhouette = Some(grey);
    let s = paint(&mut e, &request(j.clone(), face));
    assert_eq!(px(&s, (left - 7.0) as i32, mid_y), [119, 119, 119, 255]);
    assert_eq!(px(&s, ((left + right) / 2.0) as i32, mid_y), [0, 0, 0, 0]);

    // And with no band there is nothing to cut from: nothing is drawn.
    j.bands.clear();
    assert!(paint_job(&mut e, &request(j.clone(), face)).unwrap().is_none());
    j.silhouette = None;
    assert!(paint_job(&mut e, &request(j, face)).unwrap().is_none());
}

/// The stretches of ink along device row `y`, each from where it starts to
/// where it ends in fractions of a pixel. Right for upright edges, which is
/// what a stem has: a pixel's coverage is then how far the ink reaches
/// into it.
fn stretches(r: &Raster, y: i32) -> Vec<(f64, f64)> {
    let cov = |x: i32| f64::from(px(r, x, y)[3]) / 255.0;
    let mut out = Vec::new();
    let mut x = r.x;
    let end = r.x + r.width as i32;
    while x < end {
        if cov(x) == 0.0 {
            x += 1;
            continue;
        }
        let first = x;
        while x < end && cov(x) > 0.0 {
            x += 1;
        }
        out.push((
            f64::from(first + 1) - cov(first),
            f64::from(x - 1) + cov(x - 1),
        ));
    }
    out
}

/// A band round a synthesised bold is the stroke the reference that draws
/// the bold that way makes: the font's outline stroked with a pen wider by
/// the bold's own (an outset, Skia), or stroked at its place and at the end
/// of the smear with everything between (WebKit). The weight does not move
/// it. Seen with no fill over it, across the stem of an "I", which is a
/// rectangle.
#[test]
fn a_band_round_a_bold_glyph_is_the_outlines_stroke_made_bold() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let size = 200.0;
    let regular = Face::new(font, size);
    let bold = Face {
        synth: Synth {
            bold: true,
            oblique: false,
        },
        ..regular
    };
    let ink = e.line_ink(regular, "I").unwrap();
    let (x, y) = (100.0, 300.0);
    let (x0, x1) = (x - ink.left, x + ink.right);
    let o = bold_outset(size);
    let v = size * WEBKIT_BOLD_ADVANCE;
    // Wide enough that every band below leaves the middle of the stem bare.
    assert!(x1 - x0 > 6.0 + (2.0 * o).max(v) + 2.0, "{}", x1 - x0);
    let row = (y - ink.ascent / 2.0) as i32;
    let unchanged = BoldAdvance::Unchanged;
    let webkit = BoldAdvance::WebKit;
    // The rule, the face, the weight, the pen (half the band's line), and
    // how far the band reaches to the left and to the right of each edge
    // of the stem.
    for (rule, face, weight, pen, reach) in [
        (unchanged, regular, 0.0, 3.0, (3.0, 3.0)),
        (unchanged, bold, 0.0, 3.0, (3.0 + o, 3.0 + o)),
        (unchanged, bold, 0.0, 0.5, (0.5 + o, 0.5 + o)),
        (unchanged, regular, 2.25, 3.0, (3.0, 3.0)),
        (unchanged, bold, 1.5, 3.0, (3.0 + o, 3.0 + o)),
        (webkit, bold, 0.0, 3.0, (3.0, 3.0 + v)),
        (webkit, bold, 1.5, 3.0, (3.0, 3.0 + v)),
        // A pen thinner than the smear is long: still one band at each
        // edge, not two lines.
        (webkit, bold, 0.0, v / 4.0, (v / 4.0, v / 4.0 + v)),
    ] {
        e.rules.bold_advance = rule;
        let mut j = job(vec![run("I", x, y)]);
        j.fill = None;
        j.bands = vec![Band {
            color: RED,
            opacity: 1.0,
            line: pen * 2.0,
        }];
        let mut r = request(j, face);
        r.weight = weight;
        let got = stretches(&paint(&mut e, &r), row);
        let want = [(x0 - reach.0, x0 + reach.1), (x1 - reach.0, x1 + reach.1)];
        let what = format!(
            "{rule:?}, bold {}, weight {weight}, pen {pen}",
            face.synth.bold
        );
        assert_eq!(got.len(), 2, "{what}: {got:?}, wanted {want:?}");
        for (g, w) in got.iter().zip(want) {
            assert!(
                (g.0 - w.0).abs() < 0.06 && (g.1 - w.1).abs() < 0.06,
                "{what}: {got:?}, wanted {want:?}"
            );
        }
    }
}

#[test]
fn a_translucent_band_is_laid_once_where_strokes_overlap() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // A pen this wide makes the strokes of the two stems overlap, and the
    // strokes of the two lines too.
    let mut j = job(vec![run("ll", 40.0, 60.0), run("ll", 40.0, 90.0)]);
    j.bands = vec![Band {
        color: RED,
        opacity: 0.5,
        line: 24.0,
    }];
    j.fill = Some(Fill::Solid(Rgba([0, 0, 0, 0])));
    let r = paint(&mut e, &request(j, face));
    let alphas: Vec<u8> = r.data.chunks_exact(4).map(|p| p[3]).collect();
    assert_eq!(alphas.iter().copied().max(), Some(128));
    // Most of the band is at exactly that one alpha: it is a flat tone.
    let full = alphas.iter().filter(|&&a| a == 128).count();
    let any = alphas.iter().filter(|&&a| a > 0).count();
    assert!(full * 10 > any * 8, "{full} of {any}");
    // Band opacity multiplies the colour's own alpha.
    let mut j = job(vec![run("l", 40.0, 60.0)]);
    j.bands = vec![Band {
        color: Rgba([255, 0, 0, 128]),
        opacity: 0.5,
        line: 24.0,
    }];
    j.fill = None;
    let r = paint(&mut e, &request(j, face));
    assert_eq!(r.data.chunks_exact(4).map(|p| p[3]).max(), Some(64));
}

#[test]
fn a_thin_stroke_keeps_its_width_in_coverage() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.line_ink(face, "I").unwrap();
    // A pen 0.3 px wide round a bar: the left edge of the bar carries a
    // line 0.3 px wide, wherever it falls on the pixel grid.
    for shift in [0.0, 0.13, 0.5, 0.77] {
        let mut j = job(vec![run("I", 100.0 + shift, 100.0)]);
        j.bands = vec![Band {
            color: BLACK,
            opacity: 1.0,
            line: 0.3,
        }];
        j.fill = None;
        let r = paint(&mut e, &request(j, face));
        let left = 100.0 + shift - ink.left;
        let y = (100.0 - ink.ascent / 2.0) as i32;
        let sum: u32 = (-2..=2)
            .map(|d| u32::from(px(&r, left.floor() as i32 + d, y)[3]))
            .sum();
        assert!(
            (sum as f64 - 0.3 * 255.0).abs() <= 2.0,
            "{sum} at shift {shift}"
        );
    }
}

#[test]
fn the_silhouette_is_one_flat_shape() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.line_ink(face, "Il").unwrap();
    let grey = Rgba([119, 119, 119, 128]);
    let mut j = job(vec![run("Il", 100.0, 100.0)]);
    j.bands = vec![
        Band {
            color: RED,
            opacity: 0.3,
            line: 12.0,
        },
        Band {
            color: BLUE,
            opacity: 1.0,
            line: 4.0,
        },
    ];
    j.fill = Some(Fill::Solid(WHITE));
    j.silhouette = Some(grey);
    let r = paint(&mut e, &request(j, face));
    // One colour throughout, and nowhere more than its own alpha: the
    // stroke and the fill are one shape, not one laid over the other.
    for p in r.data.chunks_exact(4).filter(|p| p[3] != 0) {
        assert!(p[3] <= 128);
        if p[3] > 8 {
            assert!(p[..3].iter().all(|&c| (118..=120).contains(&c)), "{p:?}");
        }
    }
    // It reaches as far as the widest band and ignores the band's opacity.
    assert_box(
        inked(&r),
        (
            100.0 - ink.left - 6.0,
            100.0 - ink.ascent - 6.0,
            100.0 + ink.right + 6.0,
            100.0 + ink.descent + 6.0,
        ),
    );
    let inside = px(&r, (100.0 - ink.left + 2.0) as i32, 80);
    assert_eq!(inside, [119, 119, 119, 128]);
}

fn two_stops(a: Rgba, b: Rgba) -> Vec<Stop> {
    vec![Stop { pos: 0.0, color: a }, Stop { pos: 1.0, color: b }]
}

#[test]
fn a_linear_gradient_has_its_ends_and_its_midpoint() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.line_ink(face, "I").unwrap();
    let (top, bottom) = (100.0 - ink.ascent, 100.0 + ink.descent);
    let x = (100.0 + (ink.right - ink.left) / 2.0) as i32;
    let mut j = job(vec![run("I", 100.0, 100.0)]);
    // Down the stem, from 10 px below its top to 10 px above its bottom.
    j.fill = Some(Fill::Linear {
        from: Pt::new(0.0, top + 10.0),
        to: Pt::new(0.0, bottom - 10.0),
        stops: two_stops(RED, BLUE),
    });
    let r = paint(&mut e, &request(j.clone(), face));
    assert_eq!(px(&r, x, (top + 3.0) as i32), [255, 0, 0, 255]);
    assert_eq!(px(&r, x, (bottom - 3.0) as i32), [0, 0, 255, 255]);
    let mid = px(&r, x, ((top + bottom) / 2.0) as i32);
    assert!((i32::from(mid[0]) - 127).abs() <= 4 && (i32::from(mid[2]) - 127).abs() <= 4);
    // Under a 2x transform the same job is the same picture, twice the size.
    let mut big = request(j, face);
    big.transform = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    let r2 = paint(&mut e, &big);
    assert_eq!(px(&r2, 2 * x, (2.0 * (top + 3.0)) as i32), [255, 0, 0, 255]);
    let mid2 = px(&r2, 2 * x, (top + bottom) as i32);
    assert!((i32::from(mid2[0]) - i32::from(mid[0])).abs() <= 3);
}

#[test]
fn a_gradient_fades_through_alpha_without_darkening() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.line_ink(face, "I").unwrap();
    let (top, bottom) = (100.0 - ink.ascent, 100.0 + ink.descent);
    let mut j = job(vec![run("I", 100.0, 100.0)]);
    j.fill = Some(Fill::Linear {
        from: Pt::new(0.0, top),
        to: Pt::new(0.0, bottom),
        stops: two_stops(RED, Rgba([255, 0, 0, 0])),
    });
    let r = paint(&mut e, &request(j, face));
    let x = (100.0 + (ink.right - ink.left) / 2.0) as i32;
    let mid = px(&r, x, ((top + bottom) / 2.0) as i32);
    // Half alpha, and still pure red: the colour is stated straight.
    assert!((i32::from(mid[3]) - 127).abs() <= 3, "{mid:?}");
    assert_eq!(&mid[..3], &[255, 0, 0]);
}

#[test]
fn a_radial_gradient_runs_from_its_centre_to_its_radius() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.line_ink(face, "I").unwrap();
    let cx = 100.0 + (ink.right - ink.left) / 2.0;
    // On a pixel centre, so that a pixel above and one below are equally far.
    let cy = (100.0 - ink.ascent / 2.0).floor() + 0.5;
    let mut j = job(vec![run("I", 100.0, 100.0)]);
    j.fill = Some(Fill::Radial {
        centre: Pt::new(cx, cy),
        radius: 16.0,
        stops: two_stops(BLACK, WHITE),
    });
    let r = paint(&mut e, &request(j, face));
    let at = |dy: f64| px(&r, cx as i32, (cy + dy) as i32)[0];
    assert!(at(0.0) < 16);
    assert!((i32::from(at(8.0)) - 127).abs() <= 12);
    assert_eq!(at(18.0), 255);
    assert_eq!(at(-18.0), 255);
    // The same distance above and below the centre is the same colour.
    assert!((i32::from(at(6.0)) - i32::from(at(-6.0))).abs() <= 2);
}

#[test]
fn each_line_can_have_a_gradient_of_its_own() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let ink = e.line_ink(face, "HH").unwrap();
    let line = |y: f64, a: Rgba, b: Rgba| Run {
        fill: Some(Fill::Linear {
            from: Pt::new(50.0 - ink.left, 0.0),
            to: Pt::new(50.0 + ink.right, 0.0),
            stops: two_stops(a, b),
        }),
        ..run("HH", 50.0, y)
    };
    let mut j = job(vec![line(60.0, RED, BLUE), line(120.0, BLUE, RED)]);
    j.fill = None;
    let r = paint(&mut e, &request(j, face));
    let (l, rt) = (
        (50.0 - ink.left + 2.0) as i32,
        (50.0 + ink.right - 3.0) as i32,
    );
    assert!(px(&r, l, 45)[0] > 240 && px(&r, rt, 45)[2] > 240);
    assert!(px(&r, l, 105)[2] > 240 && px(&r, rt, 105)[0] > 240);
}

#[test]
fn a_pattern_repeats_at_its_pitch_under_the_transform() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 80.0);
    let ink = e.line_ink(face, "I").unwrap();
    // A 4 x 4 tile, left half black and right half white: vertical stripes.
    let mut rgba = Vec::new();
    for _ in 0..4 {
        for x in 0..4 {
            let v = if x < 2 { 0 } else { 255 };
            rgba.extend_from_slice(&[v, v, v, 255]);
        }
    }
    let tile = Tile::from_rgba(4, 4, &rgba).unwrap();
    let mut j = job(vec![run("I", 100.0, 100.0)]);
    // One tile every 2 job units, so 4 device px at 2x: tile pixel for pixel.
    j.fill = Some(Fill::Pattern {
        tile: 0,
        pitch: 2.0,
        origin: Pt::new(100.0, 0.0),
        fallback: RED,
    });
    let mut req = request(j, face);
    req.transform = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    req.tiles = vec![tile];
    let r = paint(&mut e, &req);
    let y = (2.0 * (100.0 - ink.ascent / 2.0)) as i32;
    let x0 = (2.0 * (100.0 - ink.left) + 2.0).ceil() as i32;
    let x1 = (2.0 * (100.0 + ink.right) - 2.0).floor() as i32;
    assert!(x1 - x0 >= 8, "the stem is wide enough to hold two tiles");
    for x in x0..x1 {
        // Device x = 200 is a tile corner: two black columns, two white.
        let want = if (x - 200).rem_euclid(4) < 2 { 0 } else { 255 };
        assert_eq!(px(&r, x, y), [want, want, want, 255], "x = {x}");
    }
    // A tile that was not supplied: the flat fallback colour.
    req.tiles.clear();
    let r = paint(&mut e, &req);
    assert_eq!(px(&r, (x0 + x1) / 2, y), [255, 0, 0, 255]);
}

#[test]
fn a_curved_glyph_is_centred_on_its_point_and_turned_about_it() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.glyph_ink(face, "H").unwrap();
    let glyph = |rot: f64| {
        let mut j = job(vec![Run {
            rot,
            fill: Some(Fill::Solid(BLACK)),
            ..run("H", 200.0, 150.0)
        }]);
        j.curved = true;
        j.fill = None;
        // Straight-text settings a curved job ignores.
        j.align = Align::Right;
        j.letter_spacing = 50.0;
        j
    };
    let upright = inked(&paint(&mut e, &request(glyph(0.0), face)));
    assert_box(
        upright,
        (
            200.0 - ink.left,
            150.0 - ink.ascent,
            200.0 + ink.right,
            150.0 + ink.descent,
        ),
    );
    // A quarter turn clockwise: what was above the point is now to its right.
    let turned = inked(&paint(
        &mut e,
        &request(glyph(core::f64::consts::FRAC_PI_2), face),
    ));
    assert_box(
        turned,
        (
            200.0 - ink.descent,
            150.0 - ink.left,
            200.0 + ink.ascent,
            150.0 + ink.right,
        ),
    );
}

#[test]
fn a_curved_glyphs_gradient_is_stated_in_the_glyphs_own_frame() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.glyph_ink(face, "I").unwrap();
    // The gradient runs up the glyph in the glyph's frame: from its foot
    // (red) to its head (blue). Turned a quarter turn, the head points
    // right in the picture, and the blue goes with it.
    let fill = Fill::Linear {
        from: Pt::new(0.0, ink.descent),
        to: Pt::new(0.0, -ink.ascent),
        stops: two_stops(RED, BLUE),
    };
    let mut j = job(vec![Run {
        rot: core::f64::consts::FRAC_PI_2,
        fill: Some(fill),
        ..run("I", 200.0, 150.0)
    }]);
    j.curved = true;
    j.fill = None;
    j.bands = vec![Band {
        color: WHITE,
        opacity: 1.0,
        line: 4.0,
    }];
    let r = paint(&mut e, &request(j, face));
    let head = px(&r, (200.0 + ink.ascent - 3.0) as i32, 150);
    let foot = px(&r, (200.0 - ink.descent + 3.0) as i32, 150);
    assert!(head[2] > 220 && head[0] < 35, "{head:?}");
    assert!(foot[0] > 220 && foot[2] < 35, "{foot:?}");
    // The band goes round the turned glyph.
    assert_eq!(
        px(&r, (200.0 + ink.ascent + 1.0) as i32, 150),
        [255, 255, 255, 255]
    );
}

/// A curved job of one glyph at (200, 150), turned and scaled as asked.
fn curved(text: &str, rot: f64, sx: f64, sy: f64, skew: f64) -> Job {
    let mut j = job(vec![Run {
        rot,
        sx,
        sy,
        skew,
        drip: 0.0,
        fill: Some(Fill::Solid(BLACK)),
        ..run(text, 200.0, 150.0)
    }]);
    j.curved = true;
    j.fill = None;
    j
}

/// Straight-alpha sum of the differences between two rasters on the same
/// pixels, and how many pixels differ by more than 8.
fn difference(a: &Raster, b: &Raster) -> (u64, usize) {
    assert_eq!((a.x, a.y, a.width, a.height), (b.x, b.y, b.width, b.height));
    let sum = a
        .data
        .iter()
        .zip(&b.data)
        .map(|(p, q)| u64::from(p.abs_diff(*q)))
        .sum();
    let big = a
        .data
        .chunks(4)
        .zip(b.data.chunks(4))
        .filter(|(p, q)| p.iter().zip(*q).any(|(p, q)| p.abs_diff(*q) > 8))
        .count();
    (sum, big)
}

#[test]
fn a_curved_glyph_is_scaled_about_its_centre() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.glyph_ink(face, "H").unwrap();
    let one = inked(&paint(
        &mut e,
        &request(curved("H", 0.0, 1.0, 1.0, 0.0), face),
    ));
    let wide = inked(&paint(
        &mut e,
        &request(curved("H", 0.0, 2.0, 1.0, 0.0), face),
    ));
    // Twice as wide about the same centre; as tall as before.
    assert_box(
        wide,
        (
            200.0 - 2.0 * ink.left,
            150.0 - ink.ascent,
            200.0 + 2.0 * ink.right,
            150.0 + ink.descent,
        ),
    );
    let (w1, w2) = (f64::from(one.2 - one.0), f64::from(wide.2 - wide.0));
    assert!((w2 / w1 - 2.0).abs() < 0.05, "{w1} {w2}");
    assert_eq!((one.1, one.3), (wide.1, wide.3));
    // Tall only.
    let tall = inked(&paint(
        &mut e,
        &request(curved("H", 0.0, 1.0, 3.0, 0.0), face),
    ));
    assert_box(
        tall,
        (
            200.0 - ink.left,
            150.0 - 3.0 * ink.ascent,
            200.0 + ink.right,
            150.0 + 3.0 * ink.descent,
        ),
    );
}

#[test]
fn a_scaled_glyph_is_the_glyph_at_the_bigger_size() {
    // The scale is about the glyph's centre, so size 30 at 2x is size 60,
    // curves included: the outline is flattened finely enough for the size
    // it ends up at.
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    for (text, from, to, k) in [
        ("H", 30.0, 60.0, 2.0),
        ("O", 10.0, 80.0, 8.0),
        ("S", 60.0, 30.0, 0.5),
    ] {
        let small = Face::new(font, from);
        let big = Face::new(font, to);
        let scaled = paint(&mut e, &request(curved(text, 0.0, k, k, 0.0), small));
        let direct = paint(&mut e, &request(curved(text, 0.0, 1.0, 1.0, 0.0), big));
        let (sum, wrong) = difference(&scaled, &direct);
        let pixels = scaled.width as usize * scaled.height as usize;
        assert!(
            wrong * 200 < pixels,
            "{text}: {wrong} of {pixels} pixels differ"
        );
        assert!(sum < 255 * 4 * pixels as u64 / 400, "{text}: {sum}");
    }
    // And a turned one.
    let small = Face::new(font, 30.0);
    let big = Face::new(font, 60.0);
    let quarter = core::f64::consts::FRAC_PI_2 / 1.5;
    let scaled = paint(&mut e, &request(curved("R", quarter, 2.0, 2.0, 0.0), small));
    let direct = paint(&mut e, &request(curved("R", quarter, 1.0, 1.0, 0.0), big));
    let (_, wrong) = difference(&scaled, &direct);
    assert!(wrong * 200 < scaled.width as usize * scaled.height as usize);
}

#[test]
fn a_positive_skew_leans_the_top_of_the_letter_right() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 80.0);
    let ink = e.glyph_ink(face, "I").unwrap();
    let mean_x = |r: &Raster, y0: i32, y1: i32| {
        let (mut sum, mut n) = (0.0, 0.0);
        for y in y0..y1 {
            for x in r.x..r.x + r.width as i32 {
                let a = f64::from(px(r, x, y)[3]);
                sum += a * f64::from(x);
                n += a;
            }
        }
        sum / n
    };
    let height = ink.ascent + ink.descent;
    let (top, foot) = ((150.0 - ink.ascent) as i32, (150.0 + ink.descent) as i32);
    let q = (height / 4.0) as i32;
    for skew in [0.3_f64, -0.3] {
        let r = paint(&mut e, &request(curved("I", 0.0, 1.0, 1.0, skew), face));
        let lean = mean_x(&r, top, top + q) - mean_x(&r, foot - q, foot);
        // The two bands are `height / 2` apart: the shift is tan(skew) of it.
        let want = skew.tan() * f64::from(foot - top - q);
        assert!(
            (lean - want).abs() < 0.08 * want.abs() + 1.0,
            "{skew}: {lean} vs {want}"
        );
        assert_eq!(lean > 0.0, skew > 0.0);
    }
    // The leaning letter turns with the rest of the frame: skew, then turn.
    let r = paint(
        &mut e,
        &request(
            curved("I", core::f64::consts::FRAC_PI_2, 1.0, 1.0, 0.3),
            face,
        ),
    );
    let upright = paint(&mut e, &request(curved("I", 0.0, 1.0, 1.0, 0.3), face));
    assert_eq!((r.width, r.height), (upright.height, upright.width));
}

#[test]
fn a_mirrored_glyph_keeps_its_bands_outside() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.glyph_ink(face, "L").unwrap();
    let mut j = curved("L", 0.0, -1.0, 1.0, 0.0);
    j.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 8.0,
    }];
    let r = paint(&mut e, &request(j, face));
    // Mirrored about the centre line: the ink that was right of it is left.
    assert_box(
        inked(&r),
        (
            200.0 - ink.right - 4.0,
            150.0 - ink.ascent - 4.0,
            200.0 + ink.left + 4.0,
            150.0 + ink.descent + 4.0,
        ),
    );
    // The band is round the mirrored glyph, not inside it.
    let edge = (200.0 - ink.right) as i32;
    // The foot bar of the L now points left; its end is two pixels in from
    // the edge, three above the bottom.
    let bar = (150.0 + ink.descent - 3.0) as i32;
    assert_eq!(px(&r, edge - 2, bar), RED.0);
    assert_eq!(px(&r, edge + 2, bar), BLACK.0);
}

#[test]
fn only_a_curved_job_reads_scale_and_skew() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let plain = paint(&mut e, &request(job(vec![run("HI", 30.0, 80.0)]), face));
    let odd = job(vec![Run {
        sx: 3.0,
        sy: 0.5,
        skew: 1.0,
        drip: 0.0,
        ..run("HI", 30.0, 80.0)
    }]);
    assert_eq!(paint(&mut e, &request(odd, face)), plain);
}

#[test]
fn a_run_scale_does_not_stretch_its_fill() {
    // A gradient across the glyph's frame, red at x = -20 to blue at +20,
    // under a letter made eight times as wide. Stretched with the letter it
    // would run across all of it; it does not.
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let ink = e.glyph_ink(face, "I").unwrap();
    let mut j = curved("I", 0.0, 8.0, 1.0, 0.0);
    j.runs[0].fill = Some(Fill::Linear {
        from: Pt::new(-20.0, 0.0),
        to: Pt::new(20.0, 0.0),
        stops: two_stops(RED, BLUE),
    });
    let r = paint(&mut e, &request(j, face));
    let at = |x: i32| px(&r, x, 150);
    // Offset -12 is a fifth of the way: 80% red.
    let p = at(188);
    assert!(p[0].abs_diff(204) <= 3 && p[2].abs_diff(51) <= 3, "{p:?}");
    let q = at(212);
    assert!(q[0].abs_diff(51) <= 3 && q[2].abs_diff(204) <= 3, "{q:?}");
    // Beyond the gradient's ends the letter is the end colours.
    let (lx, rx) = (
        (200.0 - 8.0 * ink.left) as i32 + 3,
        (200.0 + 8.0 * ink.right) as i32 - 3,
    );
    assert_eq!(at(lx), RED.0);
    assert_eq!(at(rx), BLUE.0);
}

#[test]
fn synthetic_bold_grows_the_ink_by_one_outset_and_italic_slants_it() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let plain = Face::new(font, 48.0);
    let ink = e.line_ink(plain, "H").unwrap();
    let o = bold_outset(48.0);
    let with = |bold, oblique| Face {
        synth: Synth { bold, oblique },
        ..plain
    };
    let (x, y) = (100.0, 100.0);
    let bold = inked(&paint(
        &mut e,
        &request(job(vec![run("H", x, y)]), with(true, false)),
    ));
    assert_box(
        bold,
        (
            x - ink.left - o,
            y - ink.ascent - o,
            x + ink.right + o,
            y + ink.descent + o,
        ),
    );
    // Painted where it is measured, slant and all.
    for face in [with(false, true), with(true, true)] {
        let m = e.line_ink(face, "H").unwrap();
        let got = inked(&paint(&mut e, &request(job(vec![run("H", x, y)]), face)));
        assert_box(got, (x - m.left, y - m.ascent, x + m.right, y + m.descent));
    }
    // The slant leans the top to the right by a quarter of the height.
    let italic = inked(&paint(
        &mut e,
        &request(job(vec![run("H", x, y)]), with(false, true)),
    ));
    let lean = f64::from(italic.2) - (x + ink.right);
    assert!((lean - 0.25 * ink.ascent).abs() < 1.0, "{lean}");
    // A band round a bold glyph starts from the bold outline.
    let mut j = job(vec![run("H", x, y)]);
    j.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 6.0,
    }];
    let banded = inked(&paint(&mut e, &request(j, with(true, false))));
    assert_box(
        banded,
        (
            x - ink.left - o - 3.0,
            y - ink.ascent - o - 3.0,
            x + ink.right + o + 3.0,
            y + ink.descent + o + 3.0,
        ),
    );
}

#[test]
fn the_same_job_paints_the_same_bytes() {
    let mut e = Engine::new();
    let font = load(&mut e, "Bangers-Regular.ttf");
    let mut j = job(vec![run("WHAT?!", 30.3, 70.7), run("office", 30.3, 120.1)]);
    j.bands = vec![Band {
        color: WHITE,
        opacity: 0.7,
        line: 5.0,
    }];
    j.fill = Some(Fill::Radial {
        centre: Pt::new(90.0, 80.0),
        radius: 70.0,
        stops: two_stops(RED, Rgba([0, 0, 255, 100])),
    });
    let mut req = request(j, Face::new(font, 44.0));
    req.transform = Affine([1.9, 0.3, -0.3, 1.9, 12.5, 3.25]);
    let a = paint(&mut e, &req);
    let b = paint(&mut e, &req);
    assert_eq!(a, b);
    // A second engine, fonts loaded afresh.
    let mut e2 = Engine::new();
    load(&mut e2, "Bangers-Regular.ttf");
    assert_eq!(paint(&mut e2, &req), a);
}

#[test]
fn a_letter_the_face_lacks_is_painted_from_the_fallback_font() {
    let mut e = Engine::new();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let dejavu = load(&mut e, "DejaVuSans.ttf");
    let size = 40.0;
    // Comic Neue has no Greek; DejaVu Sans has.
    let chain = e.chain_new();
    e.chain_push(chain, dejavu, Synth::NONE).unwrap();
    let with = Face {
        chain,
        ..Face::new(comic, size)
    };
    let (x, y) = (50.0, 90.0);
    let text = "A\u{3a9}B";
    // Painted where it is measured: the line's ink box, fallback and all.
    let ink = e.line_ink(with, text).unwrap();
    let got = inked(&paint(&mut e, &request(job(vec![run(text, x, y)]), with)));
    assert_box(
        got,
        (x - ink.left, y - ink.ascent, x + ink.right, y + ink.descent),
    );
    // The omega alone is DejaVu's glyph at the place the line gives it:
    // after Comic Neue's "A".
    let a = e.advance(Face::new(comic, size), "A").unwrap();
    let omega = e.line_ink(Face::new(dejavu, size), "\u{3a9}").unwrap();
    let mut only = request(job(vec![run("\u{3a9}", x + a, y)]), Face::new(dejavu, size));
    let alone = paint(&mut e, &only);
    let line = paint(&mut e, &request(job(vec![run(text, x, y)]), with));
    let (mut same, mut all) = (0, 0);
    for yy in alone.y..alone.y + alone.height as i32 {
        // Clear of the A and the B on either side.
        for xx in (x + a + 2.0) as i32..(x + a + omega.width - 2.0) as i32 {
            all += 1;
            same += usize::from(px(&alone, xx, yy) == px(&line, xx, yy));
        }
    }
    assert!(all > 500 && same == all, "{same} of {all}");
    // With no chain the same text is the face's own .notdef: another picture.
    only = request(job(vec![run(text, x, y)]), Face::new(comic, size));
    assert_ne!(paint(&mut e, &only), line);
    // A line the face covers is not a bit different with a chain.
    let plain = paint(
        &mut e,
        &request(job(vec![run("WAIT!", x, y)]), Face::new(comic, size)),
    );
    assert_eq!(
        paint(&mut e, &request(job(vec![run("WAIT!", x, y)]), with)),
        plain
    );
}

#[test]
fn whitespace_a_canvas_turns_into_a_space_is_painted_as_one() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 30.0);
    let spaced = paint(&mut e, &request(job(vec![run("H H", 10.0, 40.0)]), face));
    for text in ["H\tH", "H\nH", "H\rH", "H\u{c}H"] {
        let got = paint(&mut e, &request(job(vec![run(text, 10.0, 40.0)]), face));
        assert_eq!(got, spaced, "{text:?}");
    }
}

#[test]
fn a_synthesised_bold_is_painted_where_it_is_measured_under_each_rule() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let bold = Face {
        synth: Synth {
            bold: true,
            oblique: false,
        },
        ..Face::new(font, 36.0)
    };
    let (x, y) = (40.0, 80.0);
    let regular = e.line_ink(Face::new(font, 36.0), "HIH").unwrap();
    let mut inks = Vec::new();
    for rule in [BoldAdvance::Unchanged, BoldAdvance::WebKit] {
        e.rules.bold_advance = rule;
        // The request names no way to draw the bold: the rule decides, and
        // the ink the engine measures is the ink of that drawing.
        let ink = e.line_ink(bold, "HIH").unwrap();
        for align in [Align::Left, Align::Center, Align::Right] {
            let mut j = job(vec![run("HIH", x, y)]);
            j.align = align;
            let start = match align {
                Align::Left => 0.0,
                Align::Center => -ink.width / 2.0,
                Align::Right => -ink.width,
            };
            let got = inked(&paint(&mut e, &request(j, bold)));
            assert_box(
                got,
                (
                    x + start - ink.left,
                    y - ink.ascent,
                    x + start + ink.right,
                    y + ink.descent,
                ),
            );
        }
        inks.push(ink);
    }
    let (grown, smeared) = (inks[0], inks[1]);
    // Unchanged: the same advance, the ink grown on every side.
    assert_eq!(grown.width, regular.width);
    let by = grown.left - regular.left;
    assert!(by > 0.3 && (grown.ascent - regular.ascent - by).abs() < 1e-9);
    // WebKit: size / 36 = 1 px more per glyph, the last glyph two steps on
    // and drawn again a step to the right, and nothing added above or below
    // or on the left.
    assert!((smeared.width - regular.width - 3.0).abs() < 1e-9);
    assert!((smeared.right - regular.right - 3.0).abs() < 1e-9);
    assert_eq!(
        (smeared.left, smeared.ascent, smeared.descent),
        (regular.left, regular.ascent, regular.descent)
    );
    // Naming the other drawing outright still paints it, off the measure.
    let mut named = request(job(vec![run("HIH", x, y)]), bold);
    named.bold_draw = Some(BoldDraw::Outset);
    let got = inked(&paint(&mut e, &named));
    assert!(f64::from(got.1) < y - smeared.ascent - 0.3, "{got:?}");
}

#[test]
fn a_bold_drawn_as_a_smear_thickens_stems_and_not_bars() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let size = 72.0;
    let plain = Face::new(font, size);
    let bold = Face {
        synth: Synth {
            bold: true,
            oblique: false,
        },
        ..plain
    };
    let by = size * WEBKIT_BOLD_ADVANCE;
    assert_eq!(by, 2.0);
    let (x, y) = (40.0, 100.0);
    // "I" in DejaVu Sans is a plain bar, "H" two of them and a crossbar.
    let ink = e.line_ink(plain, "H").unwrap();
    let smear = |e: &mut Engine, j: Job, face: Face| {
        let mut r = request(j, face);
        r.bold_draw = Some(BoldDraw::Smear);
        paint(e, &r)
    };
    let regular = paint(&mut e, &request(job(vec![run("H", x, y)]), plain));
    let smeared = smear(&mut e, job(vec![run("H", x, y)]), bold);
    // The ink reaches `by` further right and no further anywhere else.
    assert_box(
        inked(&smeared),
        (
            x - ink.left,
            y - ink.ascent,
            x + ink.right + by,
            y + ink.descent,
        ),
    );
    // Through the crossbar, down the middle of the letter: as thick as it was.
    let column = |r: &Raster, xx: i32| -> u32 {
        (r.y..r.y + r.height as i32)
            .map(|yy| u32::from(px(r, xx, yy)[3]))
            .sum()
    };
    let mid = (x + (ink.right - ink.left) / 2.0) as i32;
    assert_eq!(column(&smeared, mid), column(&regular, mid));
    // Across the left stem, at a quarter of the height: wider by `by`.
    let row =
        |r: &Raster, yy: i32| -> u32 { (r.x..mid).map(|xx| u32::from(px(r, xx, yy)[3])).sum() };
    let at = (y - ink.ascent / 4.0) as i32;
    let grown = f64::from(row(&smeared, at)) - f64::from(row(&regular, at));
    assert!((grown / 255.0 - by).abs() < 0.02, "{grown}");
    // The outset bold thickens both.
    let outset = paint(&mut e, &request(job(vec![run("H", x, y)]), bold));
    let o = 2.0 * bold_outset(size);
    let bar = f64::from(column(&outset, mid)) - f64::from(column(&regular, mid));
    assert!((bar / 255.0 - o).abs() < 0.02, "{bar}");
    // A band round a smeared bold starts from the smeared shape.
    let mut j = job(vec![run("H", x, y)]);
    j.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 8.0,
    }];
    assert_box(
        inked(&smear(&mut e, j, bold)),
        (
            x - ink.left - 4.0,
            y - ink.ascent - 4.0,
            x + ink.right + by + 4.0,
            y + ink.descent + 4.0,
        ),
    );
    // On a curve the smear turns with the glyph: a quarter turn clockwise
    // sends it down the page.
    let g = e.glyph_ink(plain, "I").unwrap();
    let mut j = job(vec![Run {
        rot: core::f64::consts::FRAC_PI_2,
        fill: Some(Fill::Solid(BLACK)),
        ..run("I", 200.0, 150.0)
    }]);
    j.curved = true;
    j.fill = None;
    assert_box(
        inked(&smear(&mut e, j, bold)),
        (
            200.0 - g.descent,
            150.0 - g.left,
            200.0 + g.ascent,
            150.0 + g.right + by,
        ),
    );
}

/// A request in its wire form, as `text-engine/js/paint.mjs` writes it.
fn wire(font: u32, text: &str) -> Vec<u8> {
    let mut b = Vec::new();
    let u = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
    let f = |b: &mut Vec<u8>, v: f64| b.extend_from_slice(&v.to_le_bytes());
    u(&mut b, MAGIC);
    u(&mut b, WIRE_VERSION);
    u(&mut b, font);
    u(&mut b, 2); // oblique
    u(&mut b, 5); // fallback chain
    u(&mut b, 2); // bold drawn as a smear
    f(&mut b, 40.0);
    for v in [2.0, 0.0, 0.0, 2.0, 5.0, 6.0] {
        f(&mut b, v);
    }
    f(&mut b, 0.375); // weight
    u(&mut b, 0); // straight, no silhouette
    u(&mut b, 1); // centre
    f(&mut b, 1.5);
    b.extend_from_slice(&[1, 2, 3, 4]);
    u(&mut b, 1); // one band
    b.extend_from_slice(&[255, 255, 255, 255]);
    f(&mut b, 0.5);
    f(&mut b, 6.0);
    u(&mut b, 2); // linear fill
    for v in [0.0, 10.0, 0.0, 50.0] {
        f(&mut b, v);
    }
    u(&mut b, 2);
    f(&mut b, 0.0);
    b.extend_from_slice(&[255, 0, 0, 255]);
    f(&mut b, 1.0);
    b.extend_from_slice(&[0, 0, 255, 128]);
    u(&mut b, 0); // no mesh
    u(&mut b, 0); // not roughened
    u(&mut b, 1); // one run
    for v in [100.0, 40.0, 0.0, 1.0, 1.0, 0.0, 0.0] {
        f(&mut b, v);
    }
    u(&mut b, 4); // its own fill: a pattern
    u(&mut b, 0);
    f(&mut b, 12.0);
    f(&mut b, 3.0);
    f(&mut b, 4.0);
    b.extend_from_slice(&[9, 8, 7, 255]);
    u(&mut b, text.len() as u32);
    b.extend_from_slice(text.as_bytes());
    u(&mut b, 1); // one 1 x 2 tile
    u(&mut b, 1);
    u(&mut b, 2);
    b.extend_from_slice(&[0, 0, 0, 255, 255, 255, 255, 255]);
    b
}

#[test]
fn the_wire_form_decodes_to_the_job_it_states() {
    let bytes = wire(7, "Héllo");
    let r = decode(&bytes).unwrap();
    assert_eq!(r.face.font, 7);
    assert_eq!(r.face.size, 40.0);
    assert!(r.face.synth.oblique && !r.face.synth.bold);
    assert_eq!(r.face.chain, 5);
    assert_eq!(r.bold_draw, Some(BoldDraw::Smear));
    assert_eq!(r.weight, 0.375);
    assert_eq!(r.transform, Affine([2.0, 0.0, 0.0, 2.0, 5.0, 6.0]));
    assert_eq!(
        r.job,
        Job {
            curved: false,
            align: Align::Center,
            letter_spacing: 1.5,
            bands: vec![Band {
                color: WHITE,
                opacity: 0.5,
                line: 6.0
            }],
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Linear {
                from: Pt::new(0.0, 10.0),
                to: Pt::new(0.0, 50.0),
                stops: two_stops(RED, Rgba([0, 0, 255, 128])),
            }),
            mesh: None,
            roughen: None,
            runs: vec![Run {
                text: "Héllo".to_owned(),
                x: 100.0,
                y: 40.0,
                rot: 0.0,
                sx: 1.0,
                sy: 1.0,
                skew: 0.0,
                drip: 0.0,
                fill: Some(Fill::Pattern {
                    tile: 0,
                    pitch: 12.0,
                    origin: Pt::new(3.0, 4.0),
                    fallback: Rgba([9, 8, 7, 255]),
                }),
            }],
        }
    );
    assert_eq!(
        (r.tiles.len(), r.tiles[0].width, r.tiles[0].height),
        (1, 1, 2)
    );
}

#[test]
fn a_runs_scale_and_skew_are_read_and_their_range_is_checked() {
    let good = wire(1, "abc");
    // The pattern fill (36 bytes) and the text length sit after the run's
    // x, y, rot, sx, sy, skew, drip.
    let len_at = good.len() - 20 - 3 - 4;
    let drip_at = len_at - 36 - 8;
    let skew_at = drip_at - 8;
    let (sy_at, sx_at) = (skew_at - 8, skew_at - 16);
    let f = |at: usize| f64::from_le_bytes(good[at..at + 8].try_into().unwrap());
    assert_eq!(
        (f(sx_at - 8), f(sx_at), f(sy_at), f(skew_at)),
        (0.0, 1.0, 1.0, 0.0)
    );
    assert_eq!(f(sx_at - 24), 100.0);
    let with = |at: usize, v: f64| {
        let mut b = good.clone();
        b[at..at + 8].copy_from_slice(&v.to_le_bytes());
        decode(&b)
    };
    let run = |at, v| with(at, v).map(|r| r.job.runs[0].clone());
    let r = run(sx_at, -2.0).unwrap();
    assert_eq!((r.sx, r.sy, r.skew), (-2.0, 1.0, 0.0));
    let r = run(sy_at, 100.0).unwrap();
    assert_eq!((r.sx, r.sy, r.skew), (1.0, 100.0, 0.0));
    let r = run(skew_at, -1.4).unwrap();
    assert_eq!((r.sx, r.sy, r.skew), (1.0, 1.0, -1.4));
    assert_eq!(run(sx_at, 0.01).unwrap().sx, 0.01);
    for at in [sx_at, sy_at] {
        for bad in [0.0, 0.009, -0.009, 100.5, -101.0, f64::NAN, f64::INFINITY] {
            assert_eq!(with(at, bad).err(), Some(Error::BadSpec), "{at} {bad}");
        }
    }
    for bad in [1.41, -1.41, 3.0, f64::NAN, f64::NEG_INFINITY] {
        assert_eq!(with(skew_at, bad).err(), Some(Error::BadSpec), "{bad}");
    }
    assert_eq!(run(drip_at, 12.5).unwrap().drip, 12.5);
    assert_eq!(run(drip_at, 4096.0).unwrap().drip, 4096.0);
    for bad in [-0.5, 4096.5, f64::NAN, f64::INFINITY] {
        assert_eq!(with(drip_at, bad).err(), Some(Error::BadSpec), "{bad}");
    }
    // The version before this one is not read.
    let mut old = good.clone();
    old[4] = 6;
    assert_eq!(decode(&old).err(), Some(Error::BadSpec));
    assert_eq!(WIRE_VERSION, 7);
}

#[test]
fn a_damaged_wire_form_is_refused_not_guessed_at() {
    let good = wire(1, "abc");
    assert!(decode(&good).is_ok());
    // Cut short anywhere, or with bytes left over.
    for len in 0..good.len() {
        assert!(decode(&good[..len]).is_err(), "accepted {len} bytes");
    }
    let mut long = good.clone();
    long.push(0);
    assert_eq!(decode(&long).err(), Some(Error::BadSpec));
    // A NaN where a number belongs: the size is the f64 at byte 24.
    let mut nan = good.clone();
    nan[24..32].copy_from_slice(&f64::NAN.to_le_bytes());
    assert_eq!(decode(&nan).err(), Some(Error::BadSpec));
    let mut inf = good.clone();
    inf[32..40].copy_from_slice(&f64::INFINITY.to_le_bytes());
    assert_eq!(decode(&inf).err(), Some(Error::BadSpec));
    // Wrong magic, wrong version, an unknown alignment or way to draw a bold.
    let mut magic = good.clone();
    magic[0] ^= 1;
    assert!(decode(&magic).is_err());
    let mut version = good.clone();
    version[4] = 99;
    assert!(decode(&version).is_err());
    let mut align = good.clone();
    align[92] = 9;
    assert!(decode(&align).is_err());
    let mut bold = good.clone();
    bold[20] = 7;
    assert!(decode(&bold).is_err());
    // No drawing named: the engine's bold rule decides.
    let mut by_rule = good.clone();
    by_rule[20] = 0;
    assert_eq!(decode(&by_rule).unwrap().bold_draw, None);
    // A weight below nothing or beyond the guard: the f64 at byte 80.
    for w in [-0.25, 64.5] {
        let mut weight = good.clone();
        weight[80..88].copy_from_slice(&f64::to_le_bytes(w));
        assert_eq!(decode(&weight).err(), Some(Error::BadSpec), "{w}");
    }
    // Text that is not UTF-8.
    let mut text = good.clone();
    let at = good.len() - 20 - 3 - 4;
    assert_eq!(&good[at + 4..at + 7], b"abc");
    text[at + 4] = 0xff;
    assert_eq!(decode(&text).err(), Some(Error::BadText));
}

#[test]
fn thousands_of_parts_are_bounded_and_the_next_job_paints() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let mut j = job(vec![run(&"I".repeat(6000), 10.1, 50.2)]);
    j.letter_spacing = -e.advance(face, "I").unwrap();
    j.bands = vec![
        Band {
            color: BLACK,
            opacity: 1.0,
            line: 4.0
        };
        4
    ];
    j.bands.resize(1024, j.bands[0]);
    let r = request(j, face);
    assert_eq!(paint_job(&mut e, &r).err(), Some(Error::BadSpec));
    // The live budget is cleared even after a refusal.
    assert!(
        paint_job(&mut e, &request(job(vec![run("I", 10.1, 50.2)]), face))
            .unwrap()
            .is_some()
    );
}

#[test]
fn clipped_union_matches_a_larger_scene_and_the_job_raster() {
    use mt_text::paint::Scene;
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let mut small = Scene::new(10, 50, [1., 0., 0., 1., 0., 0.]).unwrap();
    let mut large = Scene::new(30, 70, [1., 0., 0., 1., 0., 0.]).unwrap();
    for x in [-7.1, -7.3] {
        small.add_line(&mut e, face, "I", x, 35.).unwrap();
        large.add_line(&mut e, face, "I", x + 10., 45.).unwrap();
    }
    small.fill(BLACK).unwrap();
    large.fill(BLACK).unwrap();
    let a = small.try_into_rgba().unwrap();
    let b = large.try_into_rgba().unwrap();
    let r = paint(
        &mut e,
        &request(job(vec![run("I", -7.1, 35.), run("I", -7.3, 35.)]), face),
    );
    for y in 0..50 {
        for x in 0..10 {
            let i = (y * 10 + x) * 4;
            let k = ((y + 10) * 30 + x + 10) * 4;
            assert_eq!(&a[i..i + 4], &b[k..k + 4], "crop ({x},{y})");
            assert_eq!(&a[i..i + 4], &px(&r, x as i32, y as i32), "job ({x},{y})");
        }
    }
    assert_eq!(a[(20 * 10) * 4 + 3], 197);
}

#[test]
fn repeating_a_part_three_times_does_not_darken_it() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let single = paint(&mut e, &request(job(vec![run("I", 10.1, 50.2)]), face));
    let triple = paint(&mut e, &request(job(vec![run("I", 10.1, 50.2); 3]), face));
    assert_eq!(single, triple);
}

#[test]
fn swapping_the_last_two_parallel_edges_keeps_the_review_pixels() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let xs = [10.1, 10.3, 10.5];
    let first = paint(
        &mut e,
        &request(job(xs.iter().map(|&x| run("I", x, 50.2)).collect()), face),
    );
    let order = [0, 2, 1];
    let reordered = paint(
        &mut e,
        &request(
            job(order.iter().map(|&i| run("I", xs[i], 50.2)).collect()),
            face,
        ),
    );
    assert_eq!(first, reordered, "{order:?}");
}

#[test]
fn rounding_residue_does_not_turn_the_next_parts_direction() {
    use mt_text::paint::Scene;
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 32.);
    let mut small = Scene::new(48, 44, [1., 0., 0., 1., 0., 0.]).unwrap();
    let mut large = Scene::new(220, 160, [1., 0., 0., 1., 0., 0.]).unwrap();
    for (t, x, y) in [
        ("M", -9.546875, 30.015625),
        ("V", -5.734375, 29.140625),
        ("W", 6.265625, 27.1875),
    ] {
        small.add_line(&mut e, face, t, x, y).unwrap();
        large.add_line(&mut e, face, t, x + 64., y + 64.).unwrap();
    }
    small.fill(BLACK).unwrap();
    large.fill(BLACK).unwrap();
    let a = small.into_rgba().unwrap();
    let b = large.into_rgba().unwrap();
    let pixel = (6 * 48 + 11) * 4 + 3;
    let crop = ((6 + 64) * 220 + 11 + 64) * 4 + 3;
    assert!(
        a[pixel].abs_diff(b[crop]) <= 1,
        "{} vs {}",
        a[pixel],
        b[crop]
    );
}

#[test]
fn an_oversized_shaping_run_is_refused_before_the_engine_grows() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.);
    assert_eq!(
        paint_job(
            &mut e,
            &request(job(vec![run(&"I".repeat(262_145), 10., 50.)]), face)
        )
        .err(),
        Some(Error::BadSpec)
    );
    assert!(
        paint_job(&mut e, &request(job(vec![run("I", 10., 50.)]), face))
            .unwrap()
            .is_some()
    );
}

#[test]
fn four_hairline_parts_stay_near_supersampled_truth() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.);
    let mut j = job([10.1, 10.3, 10.5, 10.7].map(|x| run("I", x, 50.2)).to_vec());
    j.fill = None;
    j.bands = vec![Band {
        color: BLACK,
        opacity: 1.,
        line: 0.3,
    }];
    let mut req = request(j, face);
    req.transform = Affine([2., 0., 0., 2., 0., 0.]);
    let base = paint(&mut e, &req);
    // A 0.6-device-pixel band, with four parts 0.2 job units apart.
    // Average a 16x raster onto the same device grid, including transparent
    // samples. The clear-after-union rule has mean error 15.3; retained
    // directions have mean error 2.9 (RULES.md rule 12).
    const N: i32 = 16;
    req.transform = Affine([32., 0., 0., 32., 0., 0.]);
    let hi = paint(&mut e, &req);
    let x0 = base.x.min(hi.x.div_euclid(N));
    let y0 = base.y.min(hi.y.div_euclid(N));
    let x1 = (base.x + base.width as i32).max((hi.x + hi.width as i32 + N - 1).div_euclid(N));
    let y1 = (base.y + base.height as i32).max((hi.y + hi.height as i32 + N - 1).div_euclid(N));
    let (mut sum, mut inked) = (0.0, 0);
    for y in y0..y1 {
        for x in x0..x1 {
            let mut truth = 0.0;
            for sy in 0..N {
                for sx in 0..N {
                    truth += f64::from(px(&hi, x * N + sx, y * N + sy)[3]);
                }
            }
            truth /= f64::from(N * N);
            let got = f64::from(px(&base, x, y)[3]);
            if truth >= 0.5 || got > 0.0 {
                sum += (got - truth).abs();
                inked += 1;
            }
        }
    }
    assert!(inked > 0);
    let mean = sum / f64::from(inked);
    assert!(mean < 4.0, "hairline mean error={mean}");
}

#[test]
fn hairline_crop_ignores_rounding_noise_in_incoming_slopes() {
    use mt_text::paint::Scene;
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 32.);
    let mut small = Scene::new(192, 176, [4., 0., 0., 4., 0., 0.]).unwrap();
    let mut large = Scene::new(320, 304, [4., 0., 0., 4., 64., 64.]).unwrap();
    for (text, x, y) in [
        ("A", 6.125, 31.03125),
        ("A", -6.515625, 29.5625),
        ("V", -0.21875, 30.671875),
    ] {
        small.add_line(&mut e, face, text, x, y).unwrap();
        large.add_line(&mut e, face, text, x, y).unwrap();
    }
    // 0.75 device pixels; without the incoming slope floor this scene's
    // cut and larger-scene crop differ by 55 alpha levels natively.
    small.stroke(0.75 / 2. / 4., BLACK).unwrap();
    large.stroke(0.75 / 2. / 4., BLACK).unwrap();
    let a = small.into_rgba().unwrap();
    let b = large.into_rgba().unwrap();
    let mut worst = 0;
    for y in 0..176 {
        for x in 0..192 {
            let cut = a[(y * 192 + x) * 4 + 3];
            let crop = b[((y + 64) * 320 + x + 64) * 4 + 3];
            worst = worst.max(cut.abs_diff(crop));
        }
    }
    assert!(worst <= 1, "hairline crop delta={worst}");
}

#[test]
fn decode_alone_refuses_a_run_over_the_wire_limit() {
    assert_eq!(
        decode(&wire(7, &"I".repeat(262_145))).err(),
        Some(Error::BadSpec)
    );
    assert!(decode(&wire(7, &"I".repeat(262_144))).is_ok());
}

// ---- the mesh warp and the drip ----

/// The mesh that moves nothing: the grid over the rectangle.
fn grid(cols: u32, rows: u32, (x, y, w, h): (f64, f64, f64, f64)) -> Mesh {
    let mut pts = Vec::new();
    for j in 0..=rows {
        for i in 0..=cols {
            pts.push(Pt::new(
                (w * f64::from(i)) / f64::from(cols),
                (h * f64::from(j)) / f64::from(rows),
            ));
        }
    }
    Mesh {
        cols,
        rows,
        pts,
        x,
        y,
        w,
        h,
    }
}

const BOX: (f64, f64, f64, f64) = (10.0, 10.0, 220.0, 70.0);

fn banded(text: &str) -> Job {
    let mut j = job(vec![run(text, 20.0, 60.0)]);
    j.bands = vec![Band {
        color: WHITE,
        opacity: 1.0,
        line: 8.0,
    }];
    j
}

#[test]
fn a_mesh_that_moves_nothing_paints_the_pixels_of_no_mesh() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face {
        synth: Synth {
            bold: true,
            oblique: false,
        },
        ..Face::new(font, 40.0)
    };
    let mut j = banded("Bend me");
    let plain = paint(&mut e, &request(j.clone(), face));
    for (cols, rows) in [(1, 1), (3, 2), (24, 24)] {
        j.mesh = Some(grid(cols, rows, BOX));
        assert_eq!(
            paint(&mut e, &request(j.clone(), face)),
            plain,
            "{cols}x{rows}"
        );
    }
    // A mesh that cannot be read is no mesh either.
    let mut torn = grid(2, 2, BOX);
    torn.pts[4].y -= 20.0;
    torn.pts.pop();
    j.mesh = Some(torn);
    assert_eq!(paint(&mut e, &request(j, face)), plain);
}

#[test]
fn a_one_cell_mesh_moved_whole_moves_the_picture_whole() {
    let mut e = Engine::new();
    let font = load(&mut e, "ComicNeue-Regular.ttf");
    let face = Face::new(font, 40.0);
    let mut j = banded("Whole");
    let plain = paint(&mut e, &request(j.clone(), face));
    let mut m = grid(1, 1, BOX);
    for p in &mut m.pts {
        *p = Pt::new(p.x + 7.0, p.y - 3.0);
    }
    j.mesh = Some(m);
    let moved = paint(&mut e, &request(j, face));
    // A parallelogram is one affine map: no edge is cut, and the same
    // outline a whole number of pixels away covers the same pixels.
    assert_eq!((moved.x, moved.y), (plain.x + 7, plain.y - 3));
    assert_eq!((moved.width, moved.height), (plain.width, plain.height));
    assert_eq!(moved.data, plain.data);
}

/// The first and the last device row with ink in columns `x0..x1`.
fn rows_inked(r: &Raster, x0: i32, x1: i32) -> (i32, i32) {
    let mut span = (i32::MAX, i32::MIN);
    for y in r.y..r.y + r.height as i32 {
        if (x0..x1).any(|x| px(r, x, y)[3] != 0) {
            span = (span.0.min(y), span.1.max(y));
        }
    }
    span
}

#[test]
fn an_arch_lifts_the_middle_and_the_band_bends_with_the_letters() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // Seven stems across the box, and the box's arch: the middle node up
    // 18, the ends down 18, a parabola between (4 cells reproduce it).
    let mut m = grid(4, 1, BOX);
    for p in &mut m.pts {
        let u = p.x / BOX.2;
        p.y += 36.0 * (0.5 - 4.0 * u * (1.0 - u));
    }
    let text = "I I I I I I I I I";
    let mut fill = job(vec![run(text, 20.0, 60.0)]);
    let flat = paint(&mut e, &request(fill.clone(), face));
    fill.mesh = Some(m.clone());
    let bent = paint(&mut e, &request(fill, face));
    let (fx0, _, fx1, _) = inked(&flat);
    let mid = (fx0 + fx1) / 2;
    let (flat_top, flat_foot) = rows_inked(&flat, fx0, fx1);
    // The stem nearest the middle, and the first one.
    let (mid_top, mid_foot) = rows_inked(&bent, mid - 8, mid + 8);
    let (end_top, end_foot) = rows_inked(&bent, fx0, fx0 + 4);
    let u_end = (f64::from(fx0) + 2.0 - BOX.0) / BOX.2;
    let end_shift = 36.0 * (0.5 - 4.0 * u_end * (1.0 - u_end));
    assert!(
        (f64::from(mid_top - flat_top) + 18.0).abs() <= 1.5,
        "{mid_top} {flat_top}"
    );
    assert!((f64::from(mid_foot - flat_foot) + 18.0).abs() <= 1.5);
    assert!(
        (f64::from(end_top - flat_top) - end_shift).abs() <= 2.5,
        "{end_top} {end_shift}"
    );
    assert!((f64::from(end_foot - flat_foot) - end_shift).abs() <= 2.5);
    // The letters are as wide as they were: an arch moves a point up or
    // down only.
    let (bx0, _, bx1, _) = inked(&bent);
    assert_eq!((bx0, bx1), (fx0, fx1));

    // With a band the picture is the bent letters with 4 more on every
    // side: the band went through the mesh with them.
    let mut j = banded(text);
    j.mesh = Some(m);
    let ringed = paint(&mut e, &request(j, face));
    let (rx0, ry0, rx1, ry1) = inked(&ringed);
    let (_, by0, _, by1) = inked(&bent);
    for (got, want) in [
        (bx0 - rx0, 4),
        (rx1 - bx1, 4),
        (by0 - ry0, 4),
        (ry1 - by1, 4),
    ] {
        assert!((got - want).abs() <= 1, "{got} for {want}");
    }
    // White just above the middle stem, black inside it.
    let above = px(&ringed, mid, mid_top - 2);
    assert_eq!(above, [255, 255, 255, 255], "the band above the stem");
}

#[test]
fn a_gradient_goes_with_the_letter_the_mesh_moves() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // Red at the cap height, blue at the baseline.
    let mut j = job(vec![run("I I I I I I I I I", 20.0, 60.0)]);
    j.fill = Some(Fill::Linear {
        from: Pt::new(0.0, 31.0),
        to: Pt::new(0.0, 60.0),
        stops: two_stops(RED, BLUE),
    });
    let flat = paint(&mut e, &request(j.clone(), face));
    let mut m = grid(4, 1, BOX);
    for p in &mut m.pts {
        let u = p.x / BOX.2;
        p.y += 36.0 * (0.5 - 4.0 * u * (1.0 - u));
    }
    j.mesh = Some(m);
    let bent = paint(&mut e, &request(j, face));
    let (x0, _, x1, _) = inked(&flat);
    let mid = (x0 + x1) / 2;
    let (flat_top, flat_foot) = rows_inked(&flat, mid - 8, mid + 8);
    let (top, foot) = rows_inked(&bent, mid - 8, mid + 8);
    assert!(top < flat_top - 12, "the middle stem went up");
    // The stem has the colours it had, 18 higher: red-ish at its top and
    // blue-ish at its foot. Left where the job stated it, the gradient
    // would paint the lifted stem red nearly to its foot.
    for (dy, name) in [(3, "top"), (14, "middle")] {
        let (a, b) = (px(&flat, mid, flat_top + dy), px(&bent, mid, top + dy));
        for c in 0..3 {
            assert!(
                (i32::from(a[c]) - i32::from(b[c])).abs() <= 12,
                "{name}: {a:?} {b:?}"
            );
        }
    }
    let (a, b) = (px(&flat, mid, flat_foot - 3), px(&bent, mid, foot - 3));
    assert!(
        b[2] > 180 && (i32::from(a[2]) - i32::from(b[2])).abs() <= 12,
        "{a:?} {b:?}"
    );
}

#[test]
fn a_band_stays_outside_a_letter_the_mesh_turns_over() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // Left and right swapped: the box mirrored about its own middle.
    let mut m = grid(1, 1, BOX);
    m.pts.swap(0, 1);
    m.pts.swap(2, 3);
    let mut fill = job(vec![run("Flip", 20.0, 60.0)]);
    fill.mesh = Some(m.clone());
    let plain = paint(&mut e, &request(job(vec![run("Flip", 20.0, 60.0)]), face));
    let turned = paint(&mut e, &request(fill, face));
    let (px0, py0, px1, py1) = inked(&plain);
    let (tx0, ty0, tx1, ty1) = inked(&turned);
    // Mirrored about x = 120: the same rows, the columns reflected.
    assert_eq!((ty0, ty1), (py0, py1));
    assert_eq!((tx0, tx1), (240 - px1, 240 - px0));
    let mut j = banded("Flip");
    j.mesh = Some(m);
    let ringed = paint(&mut e, &request(j, face));
    let (rx0, ry0, rx1, ry1) = inked(&ringed);
    for (got, want) in [
        (tx0 - rx0, 4),
        (rx1 - tx1, 4),
        (ty0 - ry0, 4),
        (ry1 - ty1, 4),
    ] {
        assert!((got - want).abs() <= 1, "{got} for {want}");
    }
}

#[test]
fn a_mesh_gone_to_its_horizon_refuses_the_job() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // The right edge folded back so far that the homography's horizon runs
    // through the letters.
    let mut m = grid(1, 1, BOX);
    m.pts[1] = Pt::new(120.0, 34.9);
    m.pts[3] = Pt::new(120.0, 35.1);
    let mut j = job(vec![run("Horizon line here", -200.0, 60.0)]);
    j.mesh = Some(m);
    assert_eq!(paint_job(&mut e, &request(j, face)), Err(Error::BadSpec));
    // And the next job paints.
    let next = paint(&mut e, &request(job(vec![run("ok", 20.0, 60.0)]), face));
    assert!(next.data.iter().any(|&v| v != 0));
}

#[test]
fn a_drip_pulls_the_foot_down_and_keeps_the_top_level() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let mut j = curved("H", 0.0, 1.0, 1.0, 0.0);
    let plain = paint(&mut e, &request(j.clone(), face));
    j.runs[0].drip = 14.0;
    let wet = paint(&mut e, &request(j.clone(), face));
    let (px0, py0, px1, py1) = inked(&plain);
    let (wx0, wy0, wx1, wy1) = inked(&wet);
    assert_eq!(
        (wx0, wx1, wy0),
        (px0, px1, py0),
        "the top and the sides stay"
    );
    assert_eq!(wy1, py1 + 14, "the foot is 14 lower");
    // The upper half is the same pixels: nothing above the middle moves.
    let half = (py0 + py1) / 2 - 1;
    for y in py0..half {
        for x in px0..px1 {
            assert_eq!(px(&wet, x, y), px(&plain, x, y), "{x} {y}");
        }
    }
    // A band is pulled with the outline: 4 more on every side of the wet
    // letter, the top included.
    j.bands = vec![Band {
        color: WHITE,
        opacity: 1.0,
        line: 8.0,
    }];
    let ringed = paint(&mut e, &request(j.clone(), face));
    let (rx0, ry0, rx1, ry1) = inked(&ringed);
    for (got, want) in [
        (wx0 - rx0, 4),
        (rx1 - wx1, 4),
        (wy0 - ry0, 4),
        (ry1 - wy1, 4),
    ] {
        assert!((got - want).abs() <= 1, "{got} for {want}");
    }
    // Only a curved job reads it.
    let mut straight = job(vec![run("H", 20.0, 60.0)]);
    let dry = paint(&mut e, &request(straight.clone(), face));
    straight.runs[0].drip = 14.0;
    assert_eq!(paint(&mut e, &request(straight, face)), dry);
}

/// `wire(1, "abc")` with a mesh block in place of its "no mesh".
fn wire_with_mesh(block: &[u8]) -> Vec<u8> {
    let good = wire(1, "abc");
    // From the end: the tile (20), the text (3) and its length (4), the
    // run's pattern fill (36) and seven numbers (56), the run count (4),
    // the roughening's `0` (4), and before that the mesh's `0`.
    let mesh_at = good.len() - 20 - 3 - 4 - 36 - 56 - 4 - 4 - 4;
    assert_eq!(good[mesh_at..mesh_at + 12], [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    let mut b = good[..mesh_at].to_vec();
    b.extend_from_slice(block);
    b.extend_from_slice(&good[mesh_at + 4..]);
    b
}

/// `wire(1, "abc")` with a roughening in place of its "not roughened".
fn wire_with_roughen(amount: f64, detail: f64, seed: f64, origin: [f64; 2]) -> Vec<u8> {
    wire_with_grit(amount, detail, seed, origin, 0.0)
}

fn wire_with_grit(amount: f64, detail: f64, seed: f64, origin: [f64; 2], grit: f64) -> Vec<u8> {
    let good = wire(1, "abc");
    let at = good.len() - 20 - 3 - 4 - 36 - 56 - 4 - 4;
    let mut b = good[..at].to_vec();
    b.extend_from_slice(&1u32.to_le_bytes());
    for v in [amount, detail, seed, origin[0], origin[1], grit] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&good[at + 4..]);
    b
}

#[test]
fn a_roughening_on_the_wire_is_read_and_a_bad_one_is_refused() {
    let r = decode(&wire_with_grit(4.0, 0.05, 7.0, [12.0, -6.0], 1.5)).unwrap();
    assert_eq!(
        r.job.roughen,
        Some(Roughen {
            amount: 4.0,
            detail: 0.05,
            seed: 7.0,
            origin: Pt::new(12.0, -6.0),
            grit: 1.5,
        })
    );
    for grit in [-0.5, 5000.0, f64::NAN] {
        assert_eq!(
            decode(&wire_with_grit(4.0, 0.05, 7.0, [0.0, 0.0], grit)).err(),
            Some(Error::BadSpec),
            "grit {grit}"
        );
    }
    for (amount, detail, seed) in [
        (5000.0, 0.05, 7.0),
        (4.0, -0.01, 7.0),
        (4.0, 9.0, 7.0),
        (f64::NAN, 0.05, 7.0),
        (4.0, 0.05, f64::INFINITY),
    ] {
        assert_eq!(
            decode(&wire_with_roughen(amount, detail, seed, [0.0, 0.0])).err(),
            Some(Error::BadSpec),
            "{amount} {detail} {seed}"
        );
    }
}

fn mesh_block(cols: u32, rows: u32, rect: [f64; 4], pts: &[f64]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&cols.to_le_bytes());
    b.extend_from_slice(&rows.to_le_bytes());
    for v in rect.iter().chain(pts) {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

#[test]
fn a_mesh_on_the_wire_is_read_and_a_bad_one_is_refused() {
    let pts = [
        0.0, 1.0, 50.0, -4.0, 100.0, 2.0, 0.0, 40.0, 50.0, 44.5, 100.0, 40.0,
    ];
    let rect = [12.0, -6.0, 100.0, 40.0];
    let r = decode(&wire_with_mesh(&mesh_block(2, 1, rect, &pts))).unwrap();
    assert_eq!(
        r.job.mesh,
        Some(Mesh {
            cols: 2,
            rows: 1,
            pts: pts.chunks(2).map(|p| Pt::new(p[0], p[1])).collect(),
            x: 12.0,
            y: -6.0,
            w: 100.0,
            h: 40.0,
        })
    );
    // The rest of the job is where it was.
    assert_eq!(r.job.runs[0].text, "abc");
    assert_eq!(decode(&wire(1, "abc")).unwrap().job.mesh, None);
    // The largest grid, and one past it each way.
    let side = MAX_MESH_SIDE;
    let many = vec![0.0; (side as usize + 1) * 2 * 2];
    assert!(decode(&wire_with_mesh(&mesh_block(side, 1, rect, &many))).is_ok());
    let refused = |block: Vec<u8>| decode(&wire_with_mesh(&block)).err();
    assert_eq!(
        refused(mesh_block(side + 1, 1, rect, &many)),
        Some(Error::BadSpec)
    );
    assert_eq!(
        refused(mesh_block(1, side + 1, rect, &many)),
        Some(Error::BadSpec)
    );
    assert_eq!(refused(mesh_block(2, 0, rect, &pts)), Some(Error::BadSpec));
    assert_eq!(
        refused(mesh_block(u32::MAX, u32::MAX, rect, &pts)),
        Some(Error::BadSpec)
    );
    // A rectangle with no size, a number that is not one.
    for bad in [
        [12.0, -6.0, 0.0, 40.0],
        [12.0, -6.0, 100.0, -1.0],
        [f64::NAN, 0.0, 100.0, 40.0],
    ] {
        assert_eq!(refused(mesh_block(2, 1, bad, &pts)), Some(Error::BadSpec));
    }
    let mut nan = pts;
    nan[7] = f64::INFINITY;
    assert_eq!(refused(mesh_block(2, 1, rect, &nan)), Some(Error::BadSpec));
    // A point short, and a point too many: the job no longer parses.
    assert!(refused(mesh_block(2, 1, rect, &pts[..10])).is_some());
    let mut long = pts.to_vec();
    long.extend([1.0, 2.0]);
    assert!(refused(mesh_block(2, 1, rect, &long)).is_some());
    // A count the bytes cannot hold asks for no memory.
    let mut cut = wire_with_mesh(&mesh_block(side, side, rect, &pts));
    cut.truncate(cut.len() - 40);
    assert_eq!(decode(&cut).err(), Some(Error::BadSpec));
}

// ---- roughening ----

fn rough(amount: f64, detail: f64) -> Roughen {
    Roughen {
        amount,
        detail,
        seed: 7.0,
        origin: Pt::new(20.0, 20.0),
        grit: 0.0,
    }
}

/// How many pixels are neither clear nor full: the edge.
fn edge_pixels(r: &Raster) -> usize {
    r.data
        .chunks(4)
        .filter(|p| p[3] != 0 && p[3] != 255)
        .count()
}

fn solid_pixels(r: &Raster) -> usize {
    r.data.chunks(4).filter(|p| p[3] == 255).count()
}

#[test]
fn a_roughening_that_moves_nothing_paints_the_pixels_of_none() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let mut j = banded("Rough me");
    let plain = paint(&mut e, &request(j.clone(), face));
    for (amount, detail) in [(0.0, 0.05), (4.0, 0.0)] {
        j.roughen = Some(rough(amount, detail));
        assert_eq!(
            paint(&mut e, &request(j.clone(), face)),
            plain,
            "{amount} {detail}"
        );
    }
}

#[test]
fn a_roughened_letter_moves_within_half_the_amount_and_stays_sharp() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let mut j = job(vec![run("Rough", 20.0, 80.0)]);
    let plain = paint(&mut e, &request(j.clone(), face));
    j.roughen = Some(rough(6.0, 0.05));
    let bent = paint(&mut e, &request(j.clone(), face));
    assert_ne!(bent, plain);
    // The same job, the same bytes.
    assert_eq!(paint(&mut e, &request(j.clone(), face)), bent);
    // No point goes further than half the amount.
    let (p, b) = (inked(&plain), inked(&bent));
    for (got, was) in [(b.0, p.0), (b.1, p.1), (b.2, p.2), (b.3, p.3)] {
        assert!((got - was).abs() <= 4, "{b:?} against {p:?}");
    }
    // The ink is the letter's, moved: about as much of it, and an edge no
    // wider than an edge is. Moved pixels made every edge pixel a grey one
    // and the letter's inside with it.
    let ratio = solid_pixels(&bent) as f64 / solid_pixels(&plain) as f64;
    assert!((0.9..1.1).contains(&ratio), "solid ink ratio {ratio}");
    let edges = edge_pixels(&bent) as f64 / edge_pixels(&plain) as f64;
    assert!(edges < 1.5, "edge pixels grew by {edges}");
    // Another seed is another crumple.
    j.roughen = Some(Roughen {
        seed: 8.0,
        ..rough(6.0, 0.05)
    });
    assert_ne!(paint(&mut e, &request(j, face)), bent);
}

#[test]
fn a_roughened_band_is_roughened_with_its_letter() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 60.0);
    let mut j = job(vec![run("Ring", 30.0, 90.0)]);
    j.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 8.0,
    }];
    j.roughen = Some(rough(6.0, 0.08));
    let r = paint(&mut e, &request(j, face));
    // Everywhere there is fill there is band round it: no black pixel has a
    // clear pixel within two of it.
    let (w, h) = (r.width as i32, r.height as i32);
    for y in 0..h {
        for x in 0..w {
            let p = px(&r, x + r.x, y + r.y);
            if p != [0, 0, 0, 255] {
                continue;
            }
            for (dx, dy) in [(-2, 0), (2, 0), (0, -2), (0, 2)] {
                let q = px(&r, x + r.x + dx, y + r.y + dy);
                assert_ne!(q[3], 0, "fill at {x},{y} has no band at {dx},{dy}");
            }
        }
    }
}

#[test]
fn a_roughening_is_stated_in_the_box_and_bent_by_the_mesh_after() {
    let mut e = Engine::new();
    let font = load(&mut e, "ComicNeue-Regular.ttf");
    let face = Face::new(font, 40.0);
    let mut j = banded("Bend me");
    j.roughen = Some(rough(5.0, 0.06));
    let rough_only = paint(&mut e, &request(j.clone(), face));
    // A mesh that moves the whole box moves the roughened picture whole: the
    // crumple is the box's, not the page's.
    let mut moved = grid(1, 1, BOX);
    for p in &mut moved.pts {
        p.x += 30.0;
        p.y += 10.0;
    }
    j.mesh = Some(moved);
    let both = paint(&mut e, &request(j, face));
    assert_eq!((both.x, both.y), (rough_only.x + 30, rough_only.y + 10));
    assert_eq!(both.data, rough_only.data);
}

#[test]
fn a_mesh_that_enlarges_the_letters_flattens_them_as_finely_as_a_transform_would() {
    // The outline is flattened before the mesh bends it. A mesh that makes
    // the box fifty times larger made its chords fifty times further from the
    // curve as well, and an "O" came out faceted (6102 pixels off, by up to
    // 169 levels, against the same enlargement made by the transform).
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 20.0);
    let mut j = job(vec![run("O", 20.0, 40.0)]);
    j.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 0.5,
    }];
    let mut big = request(j.clone(), face);
    big.transform = Affine::scale(50.0, 50.0);
    let want = paint(&mut e, &big);
    let mut m = grid(1, 1, (0.0, 0.0, 64.0, 64.0));
    m.pts = vec![
        Pt::new(0.0, 0.0),
        Pt::new(3200.0, 0.0),
        Pt::new(0.0, 3200.0),
        Pt::new(3200.0, 3200.0),
    ];
    j.mesh = Some(m);
    let got = paint(&mut e, &request(j, face));
    assert_eq!(difference(&got, &want), (0, 0));
}
