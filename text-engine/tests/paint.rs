//! The painter against the metric queries: what is drawn must sit where
//! `line_ink` says the ink is.
#![cfg(feature = "paint")]

use mt_text::paint::{Rgba, Scene};
use mt_text::{Engine, Face, FontId, Synth};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

/// Box of the pixels with any coverage: `(x0, y0, x1, y1)`, end exclusive.
fn touched(rgba: &[u8], width: u32) -> Option<(u32, u32, u32, u32)> {
    let mut b: Option<(u32, u32, u32, u32)> = None;
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        if px[3] == 0 {
            continue;
        }
        let (x, y) = (i as u32 % width, i as u32 / width);
        b = Some(match b {
            None => (x, y, x + 1, y + 1),
            Some(b) => (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1)),
        });
    }
    b
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const WHITE: Rgba = Rgba([255, 255, 255, 255]);

fn paint(
    e: &mut Engine,
    face: Face,
    text: &str,
    scale: f32,
    stroke: Option<f32>,
) -> (Vec<u8>, u32) {
    let (w, h) = (600u32, 300u32);
    let mut scene = Scene::new(w, h, [scale, 0.0, 0.0, scale, 0.0, 0.0]).unwrap();
    scene.add_line(e, face, text, 40.0, 90.0).unwrap();
    if let Some(width) = stroke {
        scene.stroke(width, WHITE);
    }
    scene.fill(BLACK);
    (scene.into_rgba(), w)
}

/// tiny-skia antialiases by 4x4 supersampling, so a sliver of ink narrower
/// than a quarter pixel can leave its pixel untouched.
const SUBSAMPLE: f64 = 0.25;

/// The touched-pixel box must match the exact ink box: no more than a
/// subsample short of an edge, and less than one pixel past it.
fn assert_matches_ink(
    b: (u32, u32, u32, u32),
    ink: mt_text::Ink,
    scale: f64,
    grow: f64,
    slack: f64,
) {
    let (ox, oy) = (40.0 * scale, 90.0 * scale);
    let want = (
        ox - (ink.left + grow) * scale,
        oy - (ink.ascent + grow) * scale,
        ox + (ink.right + grow) * scale,
        oy + (ink.descent + grow) * scale,
    );
    let got = (
        f64::from(b.0),
        f64::from(b.1),
        f64::from(b.2),
        f64::from(b.3),
    );
    for (g, w, outward) in [
        (got.0, want.0, -1.0),
        (got.1, want.1, -1.0),
        (got.2, want.2, 1.0),
        (got.3, want.3, 1.0),
    ] {
        let over = (g - w) * outward;
        assert!(
            over > -SUBSAMPLE - slack && over < 1.0 + slack,
            "edge at {g}, ink at {w}, overshoot {over}"
        );
    }
}

#[test]
fn fill_lands_on_the_ink_box_at_1x_and_2x() {
    let mut e = Engine::new();
    for name in [
        "ComicNeue-Regular.ttf",
        "Bangers-Regular.ttf",
        "DejaVuSans.ttf",
    ] {
        let font = load(&mut e, name);
        let face = Face::new(font, 40.0);
        for text in ["Hg", "WHAT?!", "office"] {
            let ink = e.line_ink(face, text).unwrap();
            for scale in [1.0f32, 2.0] {
                let (rgba, w) = paint(&mut e, face, text, scale, None);
                let b = touched(&rgba, w).expect("something was drawn");
                assert_matches_ink(b, ink, f64::from(scale), 0.0, 0.05);
            }
        }
    }
}

#[test]
fn a_round_join_stroke_grows_the_box_by_half_the_pen() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let ink = e.line_ink(face, "Hx").unwrap();
    // Pen 6 wide: 3 px outside the outline on every side, corners included,
    // because a round join never reaches further than half the pen.
    let (rgba, w) = paint(&mut e, face, "Hx", 2.0, Some(6.0));
    assert_matches_ink(touched(&rgba, w).unwrap(), ink, 2.0, 3.0, 0.05);
}

#[test]
fn synthetic_styles_are_drawn_where_they_are_measured() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    for synth in [
        Synth {
            bold: true,
            oblique: false,
        },
        Synth {
            bold: false,
            oblique: true,
        },
        Synth {
            bold: true,
            oblique: true,
        },
    ] {
        let face = Face {
            font,
            size: 40.0,
            synth,
            chain: 0,
        };
        let ink = e.line_ink(face, "Hkx").unwrap();
        let (rgba, w) = paint(&mut e, face, "Hkx", 2.0, None);
        assert_matches_ink(touched(&rgba, w).unwrap(), ink, 2.0, 0.0, 0.05);
    }
}

#[test]
fn overlapping_strokes_of_neighbours_are_laid_down_once() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    let half = Rgba([255, 0, 0, 128]);
    let mut scene = Scene::new(300, 150, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).unwrap();
    scene.add_line(&mut e, face, "ll", 40.0, 90.0).unwrap();
    // A pen this wide makes the strokes of the two stems overlap.
    scene.stroke(24.0, half);
    let rgba = scene.into_rgba();
    let max_alpha = rgba.chunks_exact(4).map(|p| p[3]).max().unwrap();
    assert!(max_alpha <= 129, "overlap doubled up: alpha {max_alpha}");
    assert!(max_alpha >= 127);
}

#[test]
fn bad_surfaces_are_refused_and_empty_scenes_stay_transparent() {
    assert!(Scene::new(0, 10, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).is_err());
    assert!(Scene::new(10, 100_000, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).is_err());
    assert!(Scene::new(10, 10, [f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0]).is_err());
    let mut scene = Scene::new(8, 8, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).unwrap();
    scene.stroke(4.0, WHITE);
    scene.fill(BLACK);
    assert!(scene.into_rgba().iter().all(|&b| b == 0));
}
