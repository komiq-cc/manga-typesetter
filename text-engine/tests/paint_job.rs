//! `paint_job`, feature by feature. Properties of the pixels, not golden
//! images: where the ink lands, what colour a known point has, what happens
//! where two shapes overlap.
#![cfg(feature = "paint")]

use mt_text::paint::{
    decode, paint_job, Affine, Align, Band, BoldDraw, Fill, Job, Pt, Raster, Request, Rgba, Run,
    Stop, Tile, MAGIC, MAX_SIDE, WIRE_VERSION,
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
        fill: Some(Fill::Solid(BLACK)),
        runs,
    }
}

fn request(job: Job, face: Face) -> Request {
    Request {
        job,
        face,
        bold_draw: BoldDraw::Outset,
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
fn a_bold_under_the_webkit_advance_rule_is_painted_where_it_is_measured() {
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
    let narrow = e.line_ink(bold, "HIH").unwrap();
    e.rules.bold_advance = BoldAdvance::WebKit;
    let wide = e.line_ink(bold, "HIH").unwrap();
    // Two glyphs each moved on by size / 36 = 1 px, and the advance by three.
    assert!((wide.right - narrow.right - 2.0).abs() < 1e-9);
    assert!((wide.width - narrow.width - 3.0).abs() < 1e-9);
    for align in [Align::Left, Align::Center, Align::Right] {
        let mut j = job(vec![run("HIH", x, y)]);
        j.align = align;
        let start = match align {
            Align::Left => 0.0,
            Align::Center => -wide.width / 2.0,
            Align::Right => -wide.width,
        };
        let got = inked(&paint(&mut e, &request(j, bold)));
        assert_box(
            got,
            (
                x + start - wide.left,
                y - wide.ascent,
                x + start + wide.right,
                y + wide.descent,
            ),
        );
    }
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
        r.bold_draw = BoldDraw::Smear;
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
    u(&mut b, 1); // bold drawn as a smear
    f(&mut b, 40.0);
    for v in [2.0, 0.0, 0.0, 2.0, 5.0, 6.0] {
        f(&mut b, v);
    }
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
    u(&mut b, 1); // one run
    for v in [100.0, 40.0, 0.0] {
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
    assert_eq!(r.bold_draw, BoldDraw::Smear);
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
            fill: Some(Fill::Linear {
                from: Pt::new(0.0, 10.0),
                to: Pt::new(0.0, 50.0),
                stops: two_stops(RED, Rgba([0, 0, 255, 128])),
            }),
            runs: vec![Run {
                text: "Héllo".to_owned(),
                x: 100.0,
                y: 40.0,
                rot: 0.0,
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
    align[84] = 9;
    assert!(decode(&align).is_err());
    let mut bold = good.clone();
    bold[20] = 7;
    assert!(decode(&bold).is_err());
    // Text that is not UTF-8.
    let mut text = good.clone();
    let at = good.len() - 20 - 3 - 4;
    assert_eq!(&good[at + 4..at + 7], b"abc");
    text[at + 4] = 0xff;
    assert_eq!(decode(&text).err(), Some(Error::BadText));
}
