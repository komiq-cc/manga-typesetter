//! `paint_box`, pass by pass. Properties of the pixels, as in `paint_job.rs`:
//! where a shadow lands, what a blur keeps, what a mask shows.
#![cfg(feature = "paint")]

use mt_text::paint::{
    decode_box, paint_box, paint_job, Affine, Align, BoxRequest, Clip, ClipMode, ClipShape, Fill,
    Job, Mesh, Pt, Raster, Request, Rgba, Run, Shadow, Tap, BOX_MAGIC, BOX_WIRE_VERSION, MAGIC,
    WIRE_VERSION,
};
use mt_text::{Engine, Error, Face, FontId};

fn load(engine: &mut Engine) -> FontId {
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);

/// A job of one line, "HI" at 60, its ink inside about (40..110, 56..100).
fn request(font: FontId) -> Request {
    Request {
        job: Job {
            curved: false,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Solid(BLACK)),
            mesh: None,
            roughen: None,
            runs: vec![Run {
                text: "HI".to_owned(),
                x: 40.0,
                y: 100.0,
                rot: 0.0,
                sx: 1.0,
                sy: 1.0,
                skew: 0.0,
                drip: 0.0,
                fill: None,
            }],
        },
        face: Face::new(font, 60.0),
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
    }
}

fn plain(font: FontId) -> BoxRequest {
    BoxRequest {
        width: 200,
        height: 160,
        shadows: Vec::new(),
        blur: 0.0,
        taps: Vec::new(),
        clip: None,
        request: request(font),
    }
}

fn shadow(color: Rgba, x: f64, y: f64) -> Shadow {
    Shadow {
        color,
        opacity: 1.0,
        x,
        y,
        blur: 0.0,
    }
}

fn paint(e: &mut Engine, r: &mut BoxRequest) -> Raster {
    paint_box(e, r).unwrap().expect("something was drawn")
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

/// Device box of the pixels `keep` says yes to: `(x0, y0, x1, y1)`.
fn boxed(r: &Raster, keep: impl Fn([u8; 4]) -> bool) -> (i32, i32, i32, i32) {
    let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in r.y..r.y + r.height as i32 {
        for x in r.x..r.x + r.width as i32 {
            if keep(px(r, x, y)) {
                b = (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1));
            }
        }
    }
    b
}

fn inked(r: &Raster) -> (i32, i32, i32, i32) {
    boxed(r, |p| p[3] != 0)
}

fn alpha_sum(r: &Raster) -> u64 {
    r.data.chunks_exact(4).map(|p| u64::from(p[3])).sum()
}

fn is_red(p: [u8; 4]) -> bool {
    p[3] > 200 && p[0] > 200 && p[1] < 40 && p[2] < 40
}

fn is_black(p: [u8; 4]) -> bool {
    p[3] > 200 && p[0] < 40 && p[1] < 40 && p[2] < 40
}

#[test]
fn a_box_with_nothing_laid_on_it_is_its_glyph_job() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = paint_job(&mut e, &b.request).unwrap().unwrap();
    assert_eq!(paint(&mut e, &mut b), glyphs);
    // A shadow with no opacity and a tap with no weight are nothing too.
    b.shadows = vec![Shadow {
        opacity: 0.0,
        ..shadow(RED, 5.0, 5.0)
    }];
    b.taps = vec![Tap {
        dx: 3.0,
        dy: 0.0,
        weight: 0.0,
    }];
    assert_eq!(paint(&mut e, &mut b), glyphs);
    // And the request comes back as it went in.
    assert_eq!(b.request.job.silhouette, None);
}

#[test]
fn the_raster_is_cut_to_the_surface() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let whole = inked(&paint(&mut e, &mut b));
    // A surface that ends through the letters.
    b.width = 70;
    b.height = 80;
    let r = paint(&mut e, &mut b);
    let got = inked(&r);
    assert_eq!((got.0, got.1), (whole.0, whole.1));
    assert_eq!((got.2, got.3), (70, 80));
    assert!(r.x >= 0 && r.y >= 0 && r.x + r.width as i32 <= 70 && r.y + r.height as i32 <= 80);
    // The same with a pass laid on, which takes the other road.
    b.shadows = vec![shadow(RED, 2.0, 2.0)];
    let r = paint(&mut e, &mut b);
    assert!(r.x + r.width as i32 <= 70 && r.y + r.height as i32 <= 80);
    // Nothing inside the surface is nothing.
    b.request.transform = Affine::translate(500.0, 0.0);
    assert_eq!(paint_box(&mut e, &mut b), Ok(None));
}

#[test]
fn a_shadow_is_thrown_under_the_letters_in_its_colour() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = inked(&paint(&mut e, &mut b));
    b.shadows = vec![shadow(RED, 12.0, 7.0)];
    let r = paint(&mut e, &mut b);
    // The letters are where they were and are still black. (An edge pixel
    // is black over red now, so the box of black is within a pixel.)
    let (now, was) = (boxed(&r, is_black), glyphs);
    for (a, b) in [(now.0, was.0), (now.1, was.1), (now.2, was.2), (now.3, was.3)] {
        assert!((a - b).abs() <= 1, "{now:?} against {was:?}");
    }
    // The red is the same shape, 12 right and 7 down.
    let red = boxed(&r, |p| p[3] != 0 && p[0] > 128);
    assert_eq!(red.2, glyphs.2 + 12);
    assert_eq!(red.3, glyphs.3 + 7);
    // Under: on the H's bar, where the stem's shadow falls too, the letter
    // shows.
    let (mx, my) = (glyphs.0 + 14, (glyphs.1 + glyphs.3) / 2);
    assert!(is_black(px(&r, mx, my)), "{:?}", px(&r, mx, my));
    // The same job twice is the same bytes.
    assert_eq!(paint(&mut e, &mut b), r);
}

#[test]
fn a_shadow_has_its_opacity_and_the_first_is_on_top() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = inked(&paint(&mut e, &mut b));
    // Far enough that the shadow is clear of the letters.
    b.shadows = vec![Shadow {
        opacity: 0.5,
        ..shadow(RED, 0.0, 50.0)
    }];
    let r = paint(&mut e, &mut b);
    let p = px(&r, glyphs.0 + 4, glyphs.1 + 54);
    assert!((126..=129).contains(&p[3]) && p[0] == 255, "{p:?}");
    // Two shadows at one place: the first in the list is the one seen.
    b.shadows = vec![shadow(RED, 0.0, 50.0), shadow(BLUE, 0.0, 50.0)];
    let r = paint(&mut e, &mut b);
    assert!(is_red(px(&r, glyphs.0 + 4, glyphs.1 + 54)));
}

#[test]
fn a_shadow_turns_and_mirrors_with_the_box() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.shadows = vec![shadow(RED, 30.0, 0.0)];
    // A quarter turn about (100, 80): job right is device down.
    let turn = Affine::translate(100.0, 80.0)
        .after(&Affine::rotate(0.0, 1.0))
        .after(&Affine::translate(-100.0, -80.0));
    b.request.transform = turn;
    let r = paint(&mut e, &mut b);
    let (black, red) = (boxed(&r, is_black), boxed(&r, is_red));
    assert_eq!((red.0, red.2), (black.0, black.2), "thrown down, not across");
    assert_eq!(red.3, black.3 + 30);
    // Mirrored left to right: job right is device left.
    b.request.transform = Affine([-1.0, 0.0, 0.0, 1.0, 200.0, 0.0]);
    let r = paint(&mut e, &mut b);
    let (black, red) = (boxed(&r, is_black), boxed(&r, is_red));
    assert_eq!(red.0, black.0 - 30);
    // Twice the scale throws it twice as far.
    b.request.transform = Affine::scale(2.0, 2.0);
    b.width = 400;
    b.height = 320;
    let r = paint(&mut e, &mut b);
    let (black, red) = (boxed(&r, is_black), boxed(&r, is_red));
    assert_eq!(red.2, black.2 + 60);
}

#[test]
fn a_shadow_blur_is_half_a_box_blur_and_grows_with_the_scale() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.request.job.fill = None;
    b.shadows = vec![Shadow {
        blur: 8.0,
        ..shadow(BLACK, 0.0, 0.0)
    }];
    let soft = paint(&mut e, &mut b);
    // The same picture from the whole-box blur at half the number.
    b.shadows = vec![shadow(BLACK, 0.0, 0.0)];
    b.blur = 4.0;
    assert_eq!(paint(&mut e, &mut b), soft);
    // And it reaches about three sigma past the letters.
    b.blur = 0.0;
    let hard = inked(&paint(&mut e, &mut b));
    let reach = hard.0 - inked(&soft).0;
    assert!((8..=16).contains(&reach), "reached {reach}");
}

#[test]
fn a_blur_keeps_the_ink_and_spreads_it() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let sharp = paint(&mut e, &mut b);
    b.blur = 3.0;
    let soft = paint(&mut e, &mut b);
    let (a, c) = (alpha_sum(&sharp) as f64, alpha_sum(&soft) as f64);
    assert!((a - c).abs() / a < 0.02, "{a} to {c}");
    let (s, t) = (inked(&sharp), inked(&soft));
    assert!(t.0 < s.0 - 4 && t.2 > s.2 + 4 && t.1 < s.1 - 4 && t.3 > s.3 + 4);
    // Nothing is fully inked at the old edge any more.
    assert!(px(&soft, s.0, (s.1 + s.3) / 2)[3] < 200);
}

#[test]
fn taps_add_moved_copies() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let sharp = paint(&mut e, &mut b);
    // One whole copy where it stands is the picture.
    b.taps = vec![Tap {
        dx: 0.0,
        dy: 0.0,
        weight: 1.0,
    }];
    assert_eq!(paint(&mut e, &mut b), sharp);
    // Two half copies, 40 apart: each letter twice, at half strength.
    b.taps = vec![
        Tap {
            dx: 0.0,
            dy: 0.0,
            weight: 0.5,
        },
        Tap {
            dx: 0.0,
            dy: 40.0,
            weight: 0.5,
        },
    ];
    let r = paint(&mut e, &mut b);
    let s = inked(&sharp);
    assert_eq!(inked(&r), (s.0, s.1, s.2, s.3 + 40));
    let total = alpha_sum(&r) as f64 / alpha_sum(&sharp) as f64;
    assert!((0.98..1.02).contains(&total), "{total}");
    let p = px(&r, s.0 + 4, s.1 + 4);
    assert!((126..=129).contains(&p[3]), "{p:?}");
}

fn clip(mode: ClipMode, shapes: Vec<ClipShape>) -> Option<Clip> {
    Some(Clip {
        mode,
        origin: Pt::new(0.0, 0.0),
        shapes,
    })
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> ClipShape {
    ClipShape::Polygon(vec![
        Pt::new(x0, y0),
        Pt::new(x1, y0),
        Pt::new(x1, y1),
        Pt::new(x0, y1),
    ])
}

#[test]
fn include_and_exclude_are_the_two_halves_of_the_picture() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let whole = paint(&mut e, &mut b);
    let s = inked(&whole);
    let mid = f64::from(s.0 + s.2) / 2.0 + 0.5;
    let shapes = || vec![rect(0.0, 0.0, mid, 200.0)];
    b.clip = clip(ClipMode::Include, shapes());
    let left = paint(&mut e, &mut b);
    b.clip = clip(ClipMode::Exclude, shapes());
    let right = paint(&mut e, &mut b);
    assert!(inked(&left).2 <= mid.ceil() as i32);
    assert!(inked(&right).0 >= mid.floor() as i32);
    for y in s.1..s.3 {
        for x in s.0..s.2 {
            let sum = i32::from(px(&left, x, y)[3]) + i32::from(px(&right, x, y)[3]);
            let want = i32::from(px(&whole, x, y)[3]);
            assert!((sum - want).abs() <= 1, "{x},{y}: {sum} against {want}");
        }
    }
    // Shapes that cover nothing: include shows nothing, exclude everything.
    b.clip = clip(ClipMode::Include, vec![rect(900.0, 900.0, 950.0, 950.0)]);
    assert_eq!(paint_box(&mut e, &mut b), Ok(None));
    b.clip = clip(ClipMode::Exclude, vec![rect(900.0, 900.0, 950.0, 950.0)]);
    assert_eq!(paint(&mut e, &mut b), whole);
    b.clip = clip(ClipMode::Include, Vec::new());
    assert_eq!(paint_box(&mut e, &mut b), Ok(None));
}

/// A box that is one flat sheet of ink, to see a mask's own shape in.
fn sheet(font: FontId) -> BoxRequest {
    let mut b = plain(font);
    // A block character with a band wide enough to fill the surface.
    b.request.job.runs[0].text = "H".to_owned();
    b.request.job.bands = vec![mt_text::paint::Band {
        color: BLACK,
        opacity: 1.0,
        line: 600.0,
    }];
    b
}

#[test]
fn each_shape_covers_what_it_should() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = sheet(font);
    // An ellipse.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Ellipse {
            centre: Pt::new(100.0, 80.0),
            rx: 40.0,
            ry: 20.0,
        }],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), (60, 60, 140, 100));
    assert_eq!(px(&r, 100, 80)[3], 255);
    assert_eq!(px(&r, 65, 65)[3], 0);
    // A stroke: two legs, round at the ends and at the corner.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Stroke {
            size: 20.0,
            pts: vec![Pt::new(40.0, 40.0), Pt::new(120.0, 40.0), Pt::new(120.0, 120.0)],
        }],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), (30, 30, 130, 130));
    // Solid along both legs and across the joint: one line, not patches.
    for (x, y) in [(40, 40), (80, 40), (120, 40), (120, 80), (120, 120), (126, 34)] {
        assert_eq!(px(&r, x, y)[3], 255, "{x},{y}");
    }
    // The outer corner is round: its very tip is clear.
    assert_eq!(px(&r, 129, 30)[3], 0);
    // One point is a dot.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Stroke {
            size: 30.0,
            pts: vec![Pt::new(100.0, 80.0)],
        }],
    );
    assert_eq!(inked(&paint(&mut e, &mut b)), (85, 65, 115, 95));
    // A figure of eight is filled in both loops.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Polygon(vec![
            Pt::new(20.0, 20.0),
            Pt::new(100.0, 100.0),
            Pt::new(100.0, 20.0),
            Pt::new(20.0, 100.0),
        ])],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(px(&r, 30, 60)[3], 255);
    assert_eq!(px(&r, 90, 60)[3], 255);
    assert_eq!(px(&r, 60, 30)[3], 0);
    // Two shapes that overlap are one shape there.
    b.clip = clip(
        ClipMode::Include,
        vec![rect(20.0, 20.0, 100.0, 100.0), rect(60.0, 60.0, 140.0, 140.0)],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(px(&r, 80, 80)[3], 255);
    assert_eq!(px(&r, 30, 130)[3], 0);
}

#[test]
fn a_mask_is_the_boxes_and_goes_where_the_box_goes() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = sheet(font);
    let shapes = vec![rect(10.0, 10.0, 50.0, 30.0)];
    // Stated from the box's corner.
    b.clip = Some(Clip {
        mode: ClipMode::Include,
        origin: Pt::new(30.0, 40.0),
        shapes: shapes.clone(),
    });
    assert_eq!(inked(&paint(&mut e, &mut b)), (40, 50, 80, 70));
    // Carried by the transform.
    b.request.transform = Affine::scale(2.0, 2.0);
    b.width = 400;
    b.height = 320;
    assert_eq!(inked(&paint(&mut e, &mut b)), (80, 100, 160, 140));
    // And bent by the box's mesh: one that moves the box whole moves it.
    b.request.transform = Affine::IDENTITY;
    let moved = |dx: f64, dy: f64| Mesh {
        cols: 1,
        rows: 1,
        pts: vec![
            Pt::new(dx, dy),
            Pt::new(200.0 + dx, dy),
            Pt::new(dx, 160.0 + dy),
            Pt::new(200.0 + dx, 160.0 + dy),
        ],
        x: 0.0,
        y: 0.0,
        w: 200.0,
        h: 160.0,
    };
    b.request.job.mesh = Some(moved(25.0, -15.0));
    assert_eq!(inked(&paint(&mut e, &mut b)), (65, 35, 105, 55));
}

#[test]
fn the_passes_come_in_their_order() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let s = inked(&paint(&mut e, &mut b));
    // The mask is last: it cuts the blur's spread clean.
    b.blur = 4.0;
    let mid = f64::from(s.0 + s.2) / 2.0;
    b.clip = clip(ClipMode::Include, vec![rect(0.0, 0.0, mid, 200.0)]);
    let r = paint(&mut e, &mut b);
    assert!(inked(&r).2 <= mid.ceil() as i32);
    assert!(inked(&r).0 < s.0 - 4, "the blur still spreads where it is shown");
    // The blur is over the shadow too: a hard shadow comes out soft.
    b.clip = None;
    b.shadows = vec![shadow(RED, 0.0, 30.0)];
    let r = paint(&mut e, &mut b);
    assert!(inked(&r).3 > s.3 + 30 + 4);
}

// ---- the wire form ----

fn u(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn f(b: &mut Vec<u8>, v: f64) {
    b.extend_from_slice(&v.to_le_bytes());
}

/// A glyph job on the wire: "HI", black, nothing else.
fn job_bytes(font: u32) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, MAGIC);
    u(&mut b, WIRE_VERSION);
    u(&mut b, font);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 60.0);
    for v in [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
        f(&mut b, v);
    }
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 0.0);
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0); // no bands
    u(&mut b, 1); // solid fill
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0); // no mesh
    u(&mut b, 0); // not roughened
    u(&mut b, 1);
    for v in [40.0, 100.0, 0.0, 1.0, 1.0, 0.0, 0.0] {
        f(&mut b, v);
    }
    u(&mut b, 0);
    u(&mut b, 2);
    b.extend_from_slice(b"HI");
    u(&mut b, 0);
    b
}

/// A box job on the wire with one of everything, and where each part
/// starts: the shadow's opacity, the blur, the tap's weight, the clip mode.
fn wire(font: u32) -> (Vec<u8>, [usize; 4]) {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, 1);
    b.extend_from_slice(&[255, 0, 0, 255]);
    let opacity_at = b.len();
    for v in [0.5, 6.0, -4.0, 3.0] {
        f(&mut b, v);
    }
    let blur_at = b.len();
    f(&mut b, 1.5);
    u(&mut b, 1);
    f(&mut b, 2.0);
    f(&mut b, 0.0);
    let weight_at = b.len();
    f(&mut b, 0.25);
    let mode_at = b.len();
    u(&mut b, 2);
    f(&mut b, 10.0);
    f(&mut b, 20.0);
    u(&mut b, 3);
    u(&mut b, 1);
    for v in [1.0, 2.0, 3.0, 4.0] {
        f(&mut b, v);
    }
    u(&mut b, 2);
    u(&mut b, 3);
    for v in [0.0, 0.0, 9.0, 0.0, 0.0, 9.0] {
        f(&mut b, v);
    }
    u(&mut b, 3);
    f(&mut b, 5.0);
    u(&mut b, 1);
    f(&mut b, 7.0);
    f(&mut b, 8.0);
    let job = job_bytes(font);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    (b, [opacity_at, blur_at, weight_at, mode_at])
}

#[test]
fn the_wire_form_decodes_to_the_box_it_states() {
    let (bytes, _) = wire(3);
    let r = decode_box(&bytes).unwrap();
    assert_eq!((r.width, r.height), (200, 160));
    assert_eq!(
        r.shadows,
        vec![Shadow {
            color: RED,
            opacity: 0.5,
            x: 6.0,
            y: -4.0,
            blur: 3.0
        }]
    );
    assert_eq!(r.blur, 1.5);
    assert_eq!(
        r.taps,
        vec![Tap {
            dx: 2.0,
            dy: 0.0,
            weight: 0.25
        }]
    );
    assert_eq!(
        r.clip,
        Some(Clip {
            mode: ClipMode::Exclude,
            origin: Pt::new(10.0, 20.0),
            shapes: vec![
                ClipShape::Ellipse {
                    centre: Pt::new(1.0, 2.0),
                    rx: 3.0,
                    ry: 4.0
                },
                ClipShape::Polygon(vec![Pt::new(0.0, 0.0), Pt::new(9.0, 0.0), Pt::new(0.0, 9.0)]),
                ClipShape::Stroke {
                    size: 5.0,
                    pts: vec![Pt::new(7.0, 8.0)]
                },
            ],
        })
    );
    assert_eq!(r.request.face.font, 3);
    assert_eq!(r.request.job.runs[0].text, "HI");
    assert_eq!((BOX_MAGIC, BOX_WIRE_VERSION), (0x4250_544d, 1));
}

#[test]
fn a_damaged_box_is_refused_not_guessed_at() {
    let (good, [opacity_at, blur_at, weight_at, mode_at]) = wire(1);
    assert!(decode_box(&good).is_ok());
    for len in 0..good.len() {
        assert!(decode_box(&good[..len]).is_err(), "accepted {len} bytes");
    }
    let mut long = good.clone();
    long.push(0);
    assert!(decode_box(&long).is_err());
    let with_f = |at: usize, v: f64| {
        let mut b = good.clone();
        b[at..at + 8].copy_from_slice(&v.to_le_bytes());
        decode_box(&b).map(|_| ()).err()
    };
    let with_u = |at: usize, v: u32| {
        let mut b = good.clone();
        b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        decode_box(&b).map(|_| ()).err()
    };
    for bad in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
        assert_eq!(with_f(opacity_at, bad), Some(Error::BadSpec), "opacity {bad}");
        assert_eq!(with_f(weight_at, bad), Some(Error::BadSpec), "weight {bad}");
    }
    for bad in [-1.0, 4097.0, f64::NAN] {
        assert_eq!(with_f(blur_at, bad), Some(Error::BadSpec), "blur {bad}");
        // The shadow's own blur is three numbers past its opacity.
        assert_eq!(with_f(opacity_at + 24, bad), Some(Error::BadSpec), "shadow blur {bad}");
    }
    // A throw past the guard.
    assert_eq!(with_f(opacity_at + 8, 1e9), Some(Error::BadSpec));
    // A mode, a magic, a version and a surface that are not ones.
    assert_eq!(with_u(mode_at, 3), Some(Error::BadSpec));
    assert_eq!(with_u(0, MAGIC), Some(Error::BadSpec));
    assert_eq!(with_u(4, 2), Some(Error::BadSpec));
    assert_eq!(with_u(8, 0), Some(Error::BadSpec));
    assert_eq!(with_u(8, 1 << 20), Some(Error::BadSpec));
    // Counts past their guards, and counts the bytes cannot hold.
    assert_eq!(with_u(16, 17), Some(Error::BadSpec));
    assert_eq!(with_u(16, 2), Some(Error::BadSpec));
    assert_eq!(with_u(blur_at + 8, 513), Some(Error::BadSpec));
    assert_eq!(with_u(mode_at + 20, 4097), Some(Error::BadSpec));
    // A shape of no known kind.
    assert_eq!(with_u(mode_at + 24, 9), Some(Error::BadSpec));
}

#[test]
fn a_box_read_from_the_wire_paints() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (bytes, _) = wire(font);
    let mut b = decode_box(&bytes).unwrap();
    let r = paint(&mut e, &mut b);
    assert!(r.width > 0 && r.x >= 0 && r.y >= 0);
    // A font the engine does not hold is its own error.
    let (bytes, _) = wire(999);
    let mut b = decode_box(&bytes).unwrap();
    assert_eq!(paint_box(&mut e, &mut b).err(), Some(Error::UnknownFont));
}

/// A box job on the wire with `n` shadows, each thrown a little further, and
/// nothing else laid on it.
fn shadowed(font: u32, n: u32) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, n);
    for i in 0..n {
        b.extend_from_slice(&[255, 0, 0, 255]);
        for v in [0.5, 2.0 + f64::from(i % 4), 2.0, 1.0] {
            f(&mut b, v);
        }
    }
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 0);
    let job = job_bytes(font);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    b
}

#[test]
fn a_box_has_every_shadow_its_style_has() {
    // The app counts no shadows: a style may hold as many as a person adds,
    // and the canvas paints each. The decoder once stopped at 16, and the
    // 17th made the box one the engine would not paint at all.
    let mut e = Engine::new();
    let font = load(&mut e);
    for n in [16, 17, 64] {
        let mut b = decode_box(&shadowed(font, n)).unwrap();
        assert_eq!(b.shadows.len(), n as usize);
        let r = paint(&mut e, &mut b);
        assert!(
            r.data
                .chunks_exact(4)
                .any(|p| is_red(p.try_into().unwrap())),
            "{n}"
        );
    }
    // A count the bytes cannot hold is still refused before anything is
    // allocated.
    let mut b = shadowed(font, 17);
    b[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(decode_box(&b).map(|_| ()).err(), Some(Error::BadSpec));
}

/// A box job on the wire masked by `shapes` dots far off the lettering, the
/// last of them a stroke of `points` points, so what is cut is nothing.
fn masked(font: u32, shapes: u32, points: u32) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, 0);
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 2);
    f(&mut b, 0.0);
    f(&mut b, 0.0);
    u(&mut b, shapes + 1);
    for i in 0..shapes {
        u(&mut b, 1);
        for v in [-500.0 - f64::from(i % 50), -500.0, 1.0, 1.0] {
            f(&mut b, v);
        }
    }
    u(&mut b, 3);
    f(&mut b, 1.0);
    u(&mut b, points);
    for i in 0..points {
        f(&mut b, -900.0 - f64::from(i % 7));
        f(&mut b, -900.0);
    }
    let job = job_bytes(font);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    b
}

#[test]
fn a_box_has_every_mask_shape_its_style_has() {
    // The app counts no mask strokes, nor the points in one: the canvas
    // paints a mask of any size. The decoder once stopped at 4096 shapes and
    // 65536 points, and one more made the box one the engine would not paint.
    let mut e = Engine::new();
    let font = load(&mut e);
    for (shapes, points) in [(4096, 8), (5000, 8), (8, 70_000)] {
        let mut b = decode_box(&masked(font, shapes, points)).unwrap();
        assert_eq!(b.clip.as_ref().unwrap().shapes.len(), shapes as usize + 1);
        let r = paint(&mut e, &mut b);
        assert!(r.data.chunks_exact(4).any(|p| p[3] > 0), "{shapes} shapes, {points} points");
    }
}
