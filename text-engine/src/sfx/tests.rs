use super::*;

const D: f64 = core::f64::consts::PI / 180.0;

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[track_caller]
fn all_near(got: impl IntoIterator<Item = f64>, want: &[f64]) {
    let got: Vec<f64> = got.into_iter().collect();
    assert_eq!(got.len(), want.len(), "{got:?}");
    for (g, w) in got.iter().zip(want) {
        assert!(near(*g, *w), "{got:?} is not {want:?}");
    }
}

fn mv(kind: Kind, a: f64, b: f64) -> Move {
    Move { kind, a, b }
}

/// Size 10, no gaps, one move set.
fn params(moves: Vec<Move>) -> Params {
    Params {
        size: 10.0,
        line_height: 10.0,
        letter_spacing: 0.0,
        amount: 1.0,
        seed: 1,
        flow: Flow::Row,
        row_shift: 0.0,
        moves,
    }
}

/// One row of `n` letters, each 10 wide.
fn row(n: usize) -> Vec<Vec<f64>> {
    vec![vec![10.0; n]]
}

fn run(n: usize, moves: Vec<Move>) -> Vec<Placed> {
    layout(&row(n), &params(moves))
}

#[test]
fn no_moves_is_a_plain_centred_row() {
    let out = run(3, vec![]);
    all_near(out.iter().map(|p| p.x), &[-10.0, 0.0, 10.0]);
    all_near(out.iter().map(|p| p.y), &[0.0; 3]);
    all_near(out.iter().map(|p| p.rot), &[0.0; 3]);
    all_near(out.iter().map(|p| p.sx), &[1.0; 3]);
    all_near(out.iter().map(|p| p.sy), &[1.0; 3]);
    all_near(out.iter().map(|p| p.skew), &[0.0; 3]);
    all_near(out.iter().map(|p| p.w), &[10.0; 3]);
    assert!(layout(&[], &params(vec![])).is_empty());
    assert!(layout(&[vec![]], &params(vec![])).is_empty());
}

#[test]
fn step_rises_to_the_right() {
    // c = -0.5, 0, 0.5; dy = -A * c * size = 6, 0, -6.
    let out = run(3, vec![mv(Kind::Step, 1.2, 0.0)]);
    all_near(out.iter().map(|p| p.y), &[6.0, 0.0, -6.0]);
    all_near(out.iter().map(|p| p.x), &[-10.0, 0.0, 10.0]);
}

#[test]
fn zigzag_alternates_from_up() {
    // Even letters go up (negative y), odd ones down; the box is re-centred.
    let out = run(3, vec![mv(Kind::Zigzag, 0.5, 0.0)]);
    all_near(out.iter().map(|p| p.y), &[-5.0, 5.0, -5.0]);
}

#[test]
fn wave_follows_a_sine_and_turns_with_its_slope() {
    // Width 50, A * size = 3: dy = 3 sin(2 pi t), t = 0, .25, .5, .75, 1.
    let out = run(5, vec![mv(Kind::Wave, 0.3, 1.0)]);
    all_near(out.iter().map(|p| p.y), &[0.0, 3.0, 0.0, -3.0, 0.0]);
    let slope = 3.0 * 2.0 * core::f64::consts::PI / 50.0;
    all_near(
        out.iter().map(|p| p.rot),
        &[slope.atan(), 0.0, (-slope).atan(), 0.0, slope.atan()],
    );
    // Cycles of zero or less mean one.
    let one = run(5, vec![mv(Kind::Wave, 0.3, 0.0)]);
    all_near(one.iter().map(|p| p.y), &[0.0, 3.0, 0.0, -3.0, 0.0]);
    // Two cycles.
    let two = run(5, vec![mv(Kind::Wave, 0.3, 2.0)]);
    all_near(two.iter().map(|p| p.y), &[0.0, 0.0, 0.0, 0.0, 0.0]);
}

#[test]
fn wave_reads_the_width_the_sizes_leave() {
    // `grow` widens the row, which flattens the wave's turn.
    let plain = run(3, vec![mv(Kind::Wave, 0.3, 1.0)]);
    let grown = run(3, vec![mv(Kind::Wave, 0.3, 1.0), mv(Kind::Grow, 1.0, 0.0)]);
    // t = 0 is the first letter of both; its slope is A size 2 pi / width.
    all_near(
        [plain[0].rot],
        &[(3.0 * 2.0 * core::f64::consts::PI / 30.0).atan()],
    );
    // sizes .5, 1, 1.5: the row is 30 wide again, so the same turn.
    all_near([grown[0].rot], &[plain[0].rot]);
    let wide = run(
        3,
        vec![
            mv(Kind::Wave, 0.3, 1.0),
            mv(Kind::Grow, 1.0, 0.0),
            mv(Kind::Lead, 1.0, 0.0),
        ],
    );
    // The first letter doubles (to 1 after grow's .5): the row is 35 wide.
    all_near(
        [wide[0].rot],
        &[(3.0 * 2.0 * core::f64::consts::PI / 35.0).atan()],
    );
}

#[test]
fn bounce_hops_and_squashes_on_landing() {
    // h = |sin(2 pi t)| = 0, 1, 0, 1, 0; dy = -5 h; the ends squash to .8.
    let out = run(5, vec![mv(Kind::Bounce, 0.5, 2.0)]);
    all_near(out.iter().map(|p| p.y), &[3.0, -2.0, 3.0, -2.0, 3.0]);
    all_near(out.iter().map(|p| p.sy), &[0.8, 1.0, 0.8, 1.0, 0.8]);
    all_near(out.iter().map(|p| p.sx), &[1.0; 5]);
    // Hops of zero or less mean two.
    let dflt = run(5, vec![mv(Kind::Bounce, 0.5, 0.0)]);
    all_near(dflt.iter().map(|p| p.y), &[3.0, -2.0, 3.0, -2.0, 3.0]);
}

#[test]
fn jitter_is_seeded_and_bounded() {
    let mut p = params(vec![mv(Kind::Jitter, 0.2, 12.0)]);
    p.amount = 1.5;
    let rows = row(2);
    let out = layout(&rows, &p);
    // The turn is r2 * b * amount degrees, r2 from channel 2.
    for (g, q) in out.iter().enumerate() {
        all_near([q.rot], &[noise(1, 0, g, 2) * 12.0 * 1.5 * D]);
    }
    // The offsets: A = 0.3, dx = r0 * A * .6 * size, dy = r1 * A * size.
    // Block centring moves both letters alike, so compare their difference.
    let dx = |g| noise(1, 0, g, 0) * 0.3 * 0.6 * 10.0;
    let dy = |g| noise(1, 0, g, 1) * 0.3 * 10.0;
    assert!(near(out[1].x - out[0].x, 10.0 + dx(1) - dx(0)));
    assert!(near(out[1].y - out[0].y, dy(1) - dy(0)));
    assert_eq!(layout(&rows, &p), out);
    p.seed = 2;
    assert_ne!(layout(&rows, &p), out);
    // `a` of zero leaves the turn: cascade's jitter is only a tilt.
    let tilt_only = run(2, vec![mv(Kind::Jitter, 0.0, 13.0)]);
    all_near(tilt_only.iter().map(|q| q.x), &[-5.0, 5.0]);
    all_near(tilt_only.iter().map(|q| q.y), &[0.0, 0.0]);
    assert!(tilt_only.iter().any(|q| q.rot != 0.0));
}

#[test]
fn noise_is_pinned_and_in_range() {
    // Pinned: a change to the hash changes every seeded look in every chapter.
    assert_eq!(noise(1, 0, 0, 0), noise(1, 0, 0, 0));
    assert!(near(noise(0, 0, 0, 0), PINNED[0]), "{}", noise(0, 0, 0, 0));
    assert!(near(noise(1, 0, 0, 0), PINNED[1]), "{}", noise(1, 0, 0, 0));
    assert!(near(noise(1, 2, 3, 1), PINNED[2]), "{}", noise(1, 2, 3, 1));
    let (mut lo, mut hi) = (1.0f64, -1.0f64);
    for g in 0..2000 {
        let v = noise(7, 1, g, (g % 3) as u32);
        assert!((-1.0..=1.0).contains(&v));
        lo = lo.min(v);
        hi = hi.max(v);
    }
    assert!(lo < -0.9 && hi > 0.9, "{lo} {hi}");
    // The channels, moves and glyphs are different streams.
    let base = noise(5, 0, 0, 0);
    assert_ne!(base, noise(5, 0, 0, 1));
    assert_ne!(base, noise(5, 1, 0, 0));
    assert_ne!(base, noise(5, 0, 1, 0));
    assert_ne!(base, noise(6, 0, 0, 0));
}

/// `noise(0, 0, 0, 0)`, `noise(1, 0, 0, 0)` and `noise(1, 2, 3, 1)`, worked out
/// independently of the Rust (the same integer steps in Python).
const PINNED: [f64; 3] = [-0.4847528495557496, -0.9107529078402447, 0.6897527151018736];

#[test]
fn mix_sets_each_letters_size_from_noise() {
    let out = run(4, vec![mv(Kind::Mix, 0.5, 0.0)]);
    for (g, p) in out.iter().enumerate() {
        all_near([p.sx], &[(1.0 + noise(1, 0, g, 0) * 0.5).max(0.2)]);
        all_near([p.sy], &[p.sx]);
    }
    assert!(out.iter().any(|p| p.sx != 1.0));
}

#[test]
fn grow_scales_from_small_to_big_and_reflows() {
    // c = -.5, 0, .5: sizes .5, 1, 1.5; widths 5, 10, 15 fill -15 to 15.
    let out = run(3, vec![mv(Kind::Grow, 1.0, 0.0)]);
    all_near(out.iter().map(|p| p.sx), &[0.5, 1.0, 1.5]);
    all_near(out.iter().map(|p| p.sy), &[0.5, 1.0, 1.5]);
    all_near(out.iter().map(|p| p.x), &[-12.5, -5.0, 7.5]);
    all_near(out.iter().map(|p| p.y), &[0.0; 3]);
    let shrunk = run(3, vec![mv(Kind::Grow, -1.0, 0.0)]);
    all_near(shrunk.iter().map(|p| p.sx), &[1.5, 1.0, 0.5]);
}

#[test]
fn letters_never_overlap_after_a_reflow() {
    let rows = vec![vec![8.0, 12.5, 7.0, 10.0, 15.0, 9.0, 11.0, 6.0]];
    for moves in [
        vec![mv(Kind::Grow, 1.2, 0.0)],
        vec![mv(Kind::Mix, 0.8, 0.0)],
        vec![
            mv(Kind::Grow, -0.9, 0.0),
            mv(Kind::Mix, 0.6, 0.0),
            mv(Kind::Lead, 0.7, 0.0),
        ],
        vec![mv(Kind::Swell, 1.0, 0.0), mv(Kind::Taper, 1.5, 0.2)],
    ] {
        let out = layout(&rows, &params(moves));
        assert_eq!(out.len(), 8);
        for pair in out.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let (end, start) = (a.x + a.w * a.sx / 2.0, b.x - b.w * b.sx / 2.0);
            assert!(end <= start + 1e-9, "{end} runs into {start}");
            // With no letter gap they also touch.
            assert!(near(end, start), "{end} {start}");
        }
    }
}

#[test]
fn swell_is_biggest_in_the_middle() {
    // 1 - .28 A + .78 A k^2, k = sin(pi t): .72 at the ends, 1.5 at the middle.
    let out = run(3, vec![mv(Kind::Swell, 1.0, 0.0)]);
    all_near(out.iter().map(|p| p.sx), &[0.72, 1.5, 0.72]);
    // The pinch never goes under .6.
    let pinch = run(5, vec![mv(Kind::Swell, -3.0, 0.0)]);
    assert!(pinch.iter().all(|p| p.sx >= 0.6 - 1e-12));
    assert!(near(pinch[2].sx, 0.6));
}

#[test]
fn fan_tilt_alt_and_tumble_turn_letters() {
    let fan = run(3, vec![mv(Kind::Fan, 20.0, 0.0)]);
    all_near(fan.iter().map(|p| p.rot), &[-10.0 * D, 0.0, 10.0 * D]);
    let tilt = run(3, vec![mv(Kind::Tilt, 15.0, 0.0)]);
    all_near(tilt.iter().map(|p| p.rot), &[15.0 * D; 3]);
    let alt = run(3, vec![mv(Kind::Alt, 10.0, 0.0)]);
    all_near(alt.iter().map(|p| p.rot), &[-10.0 * D, 10.0 * D, -10.0 * D]);
    // t^2 * 60 at t = 0, .5, 1.
    let tumble = run(3, vec![mv(Kind::Tumble, 60.0, 2.0)]);
    all_near(tumble.iter().map(|p| p.rot), &[0.0, 15.0 * D, 60.0 * D]);
    let linear = run(3, vec![mv(Kind::Tumble, 60.0, 0.0)]);
    all_near(linear.iter().map(|p| p.rot), &[0.0, 30.0 * D, 60.0 * D]);
}

#[test]
fn drop_falls_on_a_curve() {
    // dy = t^2 * 10 = 0, 2.5, 10; the box runs -5 to 15, so it moves up 5.
    let out = run(3, vec![mv(Kind::Drop, 1.0, 2.0)]);
    all_near(out.iter().map(|p| p.y), &[-5.0, -2.5, 5.0]);
}

#[test]
fn lean_and_domino_skew() {
    let lean = run(3, vec![mv(Kind::Lean, 20.0, 0.0)]);
    all_near(lean.iter().map(|p| p.skew), &[20.0 * D; 3]);
    let domino = run(3, vec![mv(Kind::Domino, 40.0, 0.0)]);
    all_near(domino.iter().map(|p| p.skew), &[0.0, 20.0 * D, 40.0 * D]);
}

#[test]
fn explode_spreads_from_the_middle() {
    // A = 1: dx = c * 10, dy = |c| * 7.5 (down for even letters), turn
    // c * 70 degrees, size 1 + |c| * .45. The sizes flow to 12.25, 10, 12.25.
    let out = run(3, vec![mv(Kind::Explode, 1.0, 0.0)]);
    all_near(out.iter().map(|p| p.x), &[-16.125, 0.0, 16.125]);
    all_near(out.iter().map(|p| p.rot), &[-35.0 * D, 0.0, 35.0 * D]);
    all_near(out.iter().map(|p| p.sx), &[1.225, 1.0, 1.225]);
    // dy 3.75, 0, 3.75; the heights 12.25, 10, 12.25 about those centres.
    // The middle letter (10 high, not moved) reaches -5; the others reach 9.875.
    let mid = (-5.0 + 3.75 + 6.125) / 2.0;
    all_near(out.iter().map(|p| p.y), &[3.75 - mid, -mid, 3.75 - mid]);
    // Odd letters go the other way.
    let four = run(4, vec![mv(Kind::Explode, 1.0, 0.0)]);
    assert!(four[0].y > four[1].y && four[2].y > four[1].y && four[2].y > four[3].y);
}

#[test]
fn stretch_is_tall_not_wide() {
    let out = run(3, vec![mv(Kind::Stretch, 0.5, 0.0)]);
    all_near(out.iter().map(|p| p.sx), &[1.0; 3]);
    all_near(out.iter().map(|p| p.sy), &[1.5; 3]);
    let squat = run(2, vec![mv(Kind::Stretch, -2.0, 0.0)]);
    all_near(squat.iter().map(|p| p.sy), &[0.2; 2]);
}

#[test]
fn lead_enlarges_the_first_letter_of_the_whole_text() {
    let rows = vec![vec![10.0, 10.0], vec![10.0, 10.0]];
    let out = layout(&rows, &params(vec![mv(Kind::Lead, 0.7, 0.0)]));
    all_near(out.iter().map(|p| p.sx), &[1.7, 1.0, 1.0, 1.0]);
}

#[test]
fn taper_shrinks_the_tail_from_its_start() {
    // s = 1 - max(0, t - .5) at t = 0, .25, .5, .75, 1.
    let out = run(5, vec![mv(Kind::Taper, 1.0, 0.5)]);
    all_near(out.iter().map(|p| p.sx), &[1.0, 1.0, 1.0, 0.75, 0.5]);
    let floor = run(2, vec![mv(Kind::Taper, 5.0, 0.0)]);
    all_near(floor.iter().map(|p| p.sx), &[1.0, 0.2]);
}

#[test]
fn slant_tilts_the_row_about_its_origin() {
    // -30 degrees: the right end rises. Positions (+-10, 0) turn to
    // (+-8.66, -+5); each letter turns with the row.
    let out = run(3, vec![mv(Kind::Slant, -30.0, 0.0)]);
    let c = 10.0 * (30.0 * D).cos();
    all_near(out.iter().map(|p| p.x), &[-c, 0.0, c]);
    all_near(out.iter().map(|p| p.y), &[5.0, 0.0, -5.0]);
    all_near(out.iter().map(|p| p.rot), &[-30.0 * D; 3]);
    // Two slants add.
    let two = run(
        3,
        vec![mv(Kind::Slant, -10.0, 0.0), mv(Kind::Slant, -20.0, 0.0)],
    );
    all_near(two.iter().map(|p| p.rot), &[-30.0 * D; 3]);
    // A letter's own offset turns with the row too: dy 6 at x = -10.
    let step = run(
        3,
        vec![mv(Kind::Step, 1.2, 0.0), mv(Kind::Slant, 90.0, 0.0)],
    );
    // (x, dy) = (-10, 6) turned a quarter clockwise is (-6, -10).
    // Box x runs -6..., so only the order of the letters is checked here.
    assert!(step[0].y < step[2].y);
}

#[test]
fn rows_take_a_line_and_shift_sideways() {
    let rows = vec![vec![10.0, 10.0], vec![10.0, 10.0]];
    let mut p = params(vec![]);
    p.line_height = 20.0;
    p.row_shift = 0.5;
    let out = layout(&rows, &p);
    // Row 0 spans -10..10, row 1 spans -5..15 (shifted 5): centre x 2.5; the
    // rows' boxes run -5..25 in y: centre 10.
    all_near(out.iter().map(|q| q.x), &[-7.5, 2.5, -2.5, 7.5]);
    all_near(out.iter().map(|q| q.y), &[-10.0, -10.0, 10.0, 10.0]);
}

#[test]
fn empty_rows_still_take_a_line() {
    let rows = vec![vec![10.0], vec![], vec![10.0]];
    let mut p = params(vec![]);
    p.line_height = 20.0;
    let out = layout(&rows, &p);
    assert_eq!(out.len(), 2);
    assert!(near(out[1].y - out[0].y, 40.0));
}

#[test]
fn letter_spacing_goes_between_letters_only() {
    let mut p = params(vec![]);
    p.letter_spacing = 4.0;
    let out = layout(&row(3), &p);
    all_near(out.iter().map(|q| q.x), &[-14.0, 0.0, 14.0]);
}

#[test]
fn stack_flow_is_one_letter_a_row() {
    let rows = vec![vec![10.0, 10.0], vec![10.0]];
    let mut p = params(vec![mv(Kind::Fan, 20.0, 0.0)]);
    p.flow = Flow::Stack;
    p.line_height = 20.0;
    p.row_shift = 0.3;
    let out = layout(&rows, &p);
    // i and n run over the whole text: -10, 0, 10 degrees.
    all_near(out.iter().map(|q| q.rot), &[-10.0 * D, 0.0, 10.0 * D]);
    // Rows 20 apart, each 3 further right, the block centred.
    all_near(out.iter().map(|q| q.y), &[-20.0, 0.0, 20.0]);
    all_near(out.iter().map(|q| q.x), &[-3.0, 0.0, 3.0]);
    // Each letter is its own row, so a row slant turns each about its own
    // origin and the letters do not fan out along x.
    let stacked = Params {
        moves: vec![mv(Kind::Slant, 30.0, 0.0)],
        ..p.clone()
    };
    let out = layout(&rows, &stacked);
    all_near(out.iter().map(|q| q.rot), &[30.0 * D; 3]);
    all_near(out.iter().map(|q| q.x), &[-3.0, 0.0, 3.0]);
}

#[test]
fn the_block_is_centred_on_the_origin() {
    let rows = vec![vec![9.0, 13.0, 7.5], vec![11.0], vec![], vec![8.0, 8.0]];
    for moves in [
        vec![],
        vec![mv(Kind::Step, 1.0, 0.0), mv(Kind::Grow, 0.8, 0.0)],
        vec![
            mv(Kind::Jitter, 0.3, 20.0),
            mv(Kind::Mix, 0.4, 0.0),
            mv(Kind::Slant, -17.0, 0.0),
        ],
        vec![mv(Kind::Explode, 0.9, 0.0), mv(Kind::Drop, 1.0, 2.0)],
    ] {
        let mut p = params(moves);
        p.row_shift = 0.4;
        p.line_height = 14.0;
        let out = layout(&rows, &p);
        let x0 = out
            .iter()
            .map(|q| q.x - q.w * q.sx / 2.0)
            .fold(f64::MAX, f64::min);
        let x1 = out
            .iter()
            .map(|q| q.x + q.w * q.sx / 2.0)
            .fold(f64::MIN, f64::max);
        let y0 = out
            .iter()
            .map(|q| q.y - 5.0 * q.sy)
            .fold(f64::MAX, f64::min);
        let y1 = out
            .iter()
            .map(|q| q.y + 5.0 * q.sy)
            .fold(f64::MIN, f64::max);
        assert!(
            near(x0 + x1, 0.0) && near(y0 + y1, 0.0),
            "{x0} {x1} {y0} {y1}"
        );
    }
}

#[test]
fn amount_scales_every_move_and_zero_is_plain() {
    let moves = vec![
        mv(Kind::Tilt, 10.0, 0.0),
        mv(Kind::Step, 1.0, 0.0),
        mv(Kind::Grow, 1.0, 0.0),
    ];
    let mut p = params(moves);
    p.amount = 0.5;
    let out = layout(&row(3), &p);
    all_near(out.iter().map(|q| q.rot), &[5.0 * D; 3]);
    all_near(out.iter().map(|q| q.sx), &[0.75, 1.0, 1.25]);
    p.amount = 0.0;
    assert_eq!(layout(&row(3), &p), run(3, vec![]));
    // The jitter's turn scales too.
    let mut j = params(vec![mv(Kind::Jitter, 0.0, 10.0)]);
    j.amount = 0.0;
    assert!(layout(&row(3), &j).iter().all(|q| q.rot == 0.0));
}

#[test]
fn sizes_and_skew_are_clamped() {
    let out = run(2, vec![mv(Kind::Lead, 100.0, 0.0)]);
    all_near([out[0].sx, out[0].sy], &[8.0, 8.0]);
    // s = .2 times a stretch of .2 would be .04.
    let tiny = run(
        3,
        vec![mv(Kind::Grow, -2.0, 0.0), mv(Kind::Stretch, -0.8, 0.0)],
    );
    all_near([tiny[2].sx, tiny[2].sy], &[0.2, 0.1]);
    let tall = run(
        1,
        vec![mv(Kind::Lead, 5.0, 0.0), mv(Kind::Stretch, 5.0, 0.0)],
    );
    all_near([tall[0].sx, tall[0].sy], &[6.0, 8.0]);
    let lean = run(2, vec![mv(Kind::Lean, 200.0, 0.0)]);
    all_near(lean.iter().map(|q| q.skew), &[75.0 * D; 2]);
    let back = run(2, vec![mv(Kind::Lean, -200.0, 0.0)]);
    all_near(back.iter().map(|q| q.skew), &[-75.0 * D; 2]);
}

#[test]
fn only_the_first_eight_moves_count() {
    let mut moves = vec![mv(Kind::Tilt, 1.0, 0.0); 8];
    let eight = run(2, moves.clone());
    moves.push(mv(Kind::Tilt, 40.0, 0.0));
    assert_eq!(run(2, moves), eight);
    all_near(eight.iter().map(|q| q.rot), &[8.0 * D; 2]);
}

#[test]
fn a_number_that_is_not_finite_gives_nothing() {
    let rows = row(3);
    let ok = params(vec![mv(Kind::Tilt, 10.0, 0.0)]);
    assert_eq!(layout(&rows, &ok).len(), 3);
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(layout(&[vec![10.0, bad, 10.0]], &ok).is_empty());
        for edit in 0..7 {
            let mut p = ok.clone();
            match edit {
                0 => p.size = bad,
                1 => p.line_height = bad,
                2 => p.letter_spacing = bad,
                3 => p.amount = bad,
                4 => p.row_shift = bad,
                5 => p.moves[0].a = bad,
                _ => p.moves[0].b = bad,
            }
            assert!(layout(&rows, &p).is_empty(), "{edit} {bad}");
        }
    }
    // An answer that overflows is refused too.
    let huge = Params {
        size: 1e308,
        line_height: 1e308,
        ..ok
    };
    assert!(layout(&[vec![1e308; 2], vec![1e308]], &huge).is_empty());
}

#[test]
fn the_same_seed_is_the_same_look_and_another_is_not() {
    let moves = vec![mv(Kind::Jitter, 0.2, 10.0), mv(Kind::Mix, 0.3, 0.0)];
    let a = layout(&row(8), &params(moves.clone()));
    assert_eq!(a, layout(&row(8), &params(moves.clone())));
    let mut p = params(moves);
    p.seed = 99;
    assert_ne!(a, layout(&row(8), &p));
    // A move with no random part ignores the seed.
    let calm = vec![mv(Kind::Wave, 0.3, 1.0), mv(Kind::Grow, 0.5, 0.0)];
    let mut q = params(calm.clone());
    let b = layout(&row(8), &q);
    q.seed = 1234;
    assert_eq!(b, layout(&row(8), &q));
}

#[test]
fn every_kind_has_its_row_and_every_preset_is_sound() {
    for (i, info) in KINDS.iter().enumerate() {
        assert_eq!(info.kind as usize, i, "{}", info.id);
        assert_eq!(info.kind.info().id, info.id);
        assert_eq!(Kind::from_id(info.id), Some(info.kind));
        assert!(info.min < info.max && info.step > 0.0);
        assert!(["em", "deg", "x"].contains(&info.unit));
        if let Some(b) = info.b {
            assert!(b.min <= b.default && b.default <= b.max, "{}", info.id);
        }
    }
    assert_eq!(Kind::from_id("nope"), None);
    let ids: Vec<_> = KINDS.iter().map(|k| k.id).collect();
    for (i, id) in ids.iter().enumerate() {
        assert!(!ids[..i].contains(id), "{id} twice");
    }
    for (i, p) in PRESETS.iter().enumerate() {
        assert!(!PRESETS[..i].iter().any(|q| q.id == p.id), "{} twice", p.id);
        assert!(p.moves.len() <= MAX_MOVES);
        // A preset does something: moves, a warp, or both.
        assert!(!p.moves.is_empty() || p.envelope.is_some(), "{}", p.id);
        if let Some(e) = p.envelope {
            assert!(p.moves.is_empty(), "{}", p.id);
            assert!(e.cols >= 1 && e.rows >= 1, "{}", p.id);
            let pts = mesh(
                e.kind,
                e.bend,
                e.cols as usize,
                e.rows as usize,
                100.0,
                40.0,
            );
            assert_eq!(pts.len(), (e.cols as usize + 1) * (e.rows as usize + 1));
        }
        assert!(["Move", "Size", "Shape", "Hand"].contains(&p.group));
        // Every preset lays out real text into finite numbers.
        let out = layout(
            &[vec![9.0, 12.0, 10.0, 11.0, 8.0], vec![10.0, 10.0]],
            &Params {
                flow: if p.stack { Flow::Stack } else { Flow::Row },
                row_shift: p.row_shift,
                letter_spacing: p.gap * 10.0,
                moves: p.moves.iter().map(|&(kind, a, b)| mv(kind, a, b)).collect(),
                ..params(vec![])
            },
        );
        assert_eq!(out.len(), 7, "{}", p.id);
    }
    assert_eq!(PRESETS.len(), 15);
    assert_eq!(KINDS.len(), 21);
}

#[test]
fn the_info_json_has_the_documented_shape() {
    let j = info_json();
    assert!(j.is_ascii());
    assert!(j.starts_with("{\"kinds\":[{\"kind\":\"step\",\"label\":\"Stairs\",\"unit\":\"em\",\"min\":-3,\"max\":3,\"step\":0.05,\"b\":null}"), "{j}");
    assert!(j.contains(
        "{\"kind\":\"wave\",\"label\":\"Wave\",\"unit\":\"em\",\"min\":-1,\"max\":1,\"step\":0.01,\"b\":{\"label\":\"Cycles\",\"min\":0.5,\"max\":4,\"step\":0.25,\"default\":1}}"
    ));
    assert!(j.contains(
        "{\"id\":\"stairs-down\",\"name\":\"Stairs down\",\"group\":\"Move\",\"flow\":\"row\",\"rowShift\":0,\"gap\":0,\"lineHeight\":null,\"envelope\":null,\"moves\":[{\"kind\":\"step\",\"a\":-1.2,\"b\":0}]}"
    ));
    assert!(j.contains("\"id\":\"cascade\",\"name\":\"Cascade\",\"group\":\"Hand\",\"flow\":\"stack\",\"rowShift\":0.3,\"gap\":0,\"lineHeight\":0.72,\"envelope\":null"));
    assert!(j.contains("{\"kind\":\"taper\",\"a\":1.6,\"b\":0.75}"));
    // A preset is a shape and no more: it names no colour and no stroke.
    assert!(!j.contains("\"look\""));
    assert_eq!(
        j.matches("\"kind\":\"").count(),
        21 + PRESETS
            .iter()
            .map(|p| p.moves.len() + usize::from(p.envelope.is_some()))
            .sum::<usize>()
    );
    assert!(j.contains("\"id\":\"valley\",\"name\":\"Valley\",\"group\":\"Shape\""));
    assert!(j.contains(
        "\"lineHeight\":null,\"envelope\":{\"kind\":\"valley\",\"bend\":0.6,\"cols\":4,\"rows\":1},\"moves\":[]"
    ));
    assert!(j.contains("\"envelope\":null,\"moves\":[{\"kind\":\"step\""));
    assert_eq!(j.matches("\"envelope\":").count(), PRESETS.len());
    assert_eq!(j.matches("\"envelope\":{").count(), 1);
    assert!(j.contains("\"envelopes\":[\"arch\",\"valley\",\"flag\",\"rise\"]"));
    assert!(j.contains("{\"kind\":\"drip\",\"a\":0.45,\"b\":0.5}"));
    assert_eq!(j.matches("\"id\":\"").count(), PRESETS.len());
    assert!(!j.contains("e-") && !j.contains("NaN") && !j.contains("inf"));
    // Balanced, outside strings.
    let (mut depth, mut quoted) = (0i32, false);
    for c in j.chars() {
        match c {
            '"' => quoted = !quoted,
            '{' | '[' if !quoted => depth += 1,
            '}' | ']' if !quoted => depth -= 1,
            _ => {}
        }
        assert!(depth >= 0);
    }
    assert_eq!((depth, quoted), (0, false));
    assert!(j.ends_with("],\"envelopes\":[\"arch\",\"valley\",\"flag\",\"rise\"]}"));
}

#[test]
fn the_wire_form_decodes_and_refuses_what_it_should() {
    fn bytes(nums: [f64; 4], seed: u32, flow: u32, moves: &[(u32, f64, f64)]) -> Vec<u8> {
        let mut b = Vec::new();
        for v in nums {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&seed.to_le_bytes());
        b.extend_from_slice(&flow.to_le_bytes());
        b.extend_from_slice(&(moves.len() as u32).to_le_bytes());
        for &(k, a, bb) in moves {
            b.extend_from_slice(&k.to_le_bytes());
            b.extend_from_slice(&a.to_le_bytes());
            b.extend_from_slice(&bb.to_le_bytes());
        }
        b
    }
    let good = bytes(
        [12.0, -1.5, 0.75, 0.25],
        77,
        1,
        &[(2, 0.3, 2.0), (19, -20.0, 0.0)],
    );
    let p = decode_params(&good, 22.5).unwrap();
    assert_eq!(
        p,
        Params {
            size: 22.5,
            line_height: 12.0,
            letter_spacing: -1.5,
            amount: 0.75,
            seed: 77,
            flow: Flow::Stack,
            row_shift: 0.25,
            moves: vec![mv(Kind::Wave, 0.3, 2.0), mv(Kind::Slant, -20.0, 0.0)],
        }
    );
    for len in 0..good.len() {
        assert_eq!(
            decode_params(&good[..len], 10.0),
            Err(crate::Error::BadSpec),
            "{len}"
        );
    }
    let mut long = good.clone();
    long.push(0);
    assert!(decode_params(&long, 10.0).is_err());
    assert!(decode_params(&good, f64::NAN).is_err());
    assert!(decode_params(&bytes([f64::NAN, 0.0, 1.0, 0.0], 1, 0, &[]), 10.0).is_err());
    assert!(decode_params(&bytes([1.0, 0.0, 1.0, 0.0], 1, 2, &[]), 10.0).is_err());
    assert!(decode_params(&bytes([1.0, 0.0, 1.0, 0.0], 1, 0, &[(21, 1.0, 0.0)]), 10.0).is_err());
    assert!(decode_params(
        &bytes([1.0, 0.0, 1.0, 0.0], 1, 0, &[(0, f64::INFINITY, 0.0)]),
        10.0
    )
    .is_err());
    // A count that the bytes cannot hold.
    let mut count = bytes([1.0, 0.0, 1.0, 0.0], 1, 0, &[]);
    let at = count.len() - 4;
    count[at..].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode_params(&count, 10.0).is_err());
}

#[test]
fn drip_sends_some_letters_down_and_leaves_the_tops_level() {
    // Share 1: every letter runs, 0.4 to 1.0 of a * size.
    let all = run(40, vec![mv(Kind::Drip, 0.5, 1.0)]);
    for p in &all {
        assert!(
            p.drip >= 0.4 * 5.0 - 1e-9 && p.drip <= 5.0 + 1e-9,
            "{}",
            p.drip
        );
    }
    assert!(all.iter().any(|p| (p.drip - all[0].drip).abs() > 1e-6));
    // The numbers are the hash's: r0 < share, r1 in the length.
    for (g, p) in all.iter().enumerate() {
        let r1 = (noise(1, 0, g, 1) + 1.0) / 2.0;
        all_near([p.drip], &[0.5 * 10.0 * (0.4 + 0.6 * r1)]);
    }
    // A mid share: some dry, some not.
    let some = run(40, vec![mv(Kind::Drip, 0.5, 0.5)]);
    assert!(some.iter().any(|p| p.drip == 0.0));
    assert!(some.iter().any(|p| p.drip > 0.0));
    for (g, p) in some.iter().enumerate() {
        let wet = (noise(1, 0, g, 0) + 1.0) / 2.0 < 0.5;
        assert_eq!(p.drip > 0.0, wet, "{g}");
    }
    // Share zero (the default is a half) means a half; a negative `a` never
    // pulls a letter up.
    let neg = run(40, vec![mv(Kind::Drip, -0.5, 1.0)]);
    assert!(neg.iter().all(|p| p.drip == 0.0));
    assert!(some.iter().chain(&all).all(|p| p.drip >= 0.0));
    let dflt = run(40, vec![mv(Kind::Drip, 0.5, 0.0)]);
    assert_eq!(dflt, some);
    // Never past four sizes.
    let far = run(3, vec![mv(Kind::Drip, 2.0, 1.0), mv(Kind::Drip, 2.0, 1.0)]);
    assert!(far.iter().all(|p| p.drip <= 40.0 + 1e-9 && p.drip > 0.0));
    // Same seed, same numbers; another seed, others.
    assert_eq!(all, run(40, vec![mv(Kind::Drip, 0.5, 1.0)]));
    let mut p = params(vec![mv(Kind::Drip, 0.5, 1.0)]);
    p.seed = 77;
    let other = layout(&row(40), &p);
    assert_ne!(
        all.iter().map(|q| q.drip).collect::<Vec<_>>(),
        other.iter().map(|q| q.drip).collect::<Vec<_>>()
    );
    // It moves nothing sideways and the tops stay level.
    let plain = run(40, vec![]);
    all_near(
        all.iter().map(|q| q.x),
        &plain.iter().map(|q| q.x).collect::<Vec<_>>(),
    );
    assert!(all.iter().all(|q| q.y == all[0].y), "tops level");
    assert!(plain.iter().all(|q| q.drip == 0.0));
    // The block's bottom takes the longest drip in: the box is centred.
    let low = all.iter().map(|q| q.drip).fold(0.0, f64::max);
    all_near([all[0].y], &[-low / 2.0]);
}

#[test]
fn drip_is_clean_for_stacks_and_amount() {
    let mut p = params(vec![mv(Kind::Drip, 0.4, 1.0)]);
    p.amount = 0.0;
    assert!(layout(&row(5), &p).iter().all(|q| q.drip == 0.0));
    p.amount = 2.0;
    p.flow = Flow::Stack;
    let out = layout(&row(5), &p);
    assert_eq!(out.len(), 5);
    assert!(out
        .iter()
        .all(|q| q.drip >= 0.4 * 8.0 - 1e-9 && q.drip <= 8.0 + 1e-9));
    let mut bad = p.clone();
    bad.moves[0].a = f64::NAN;
    assert!(layout(&row(5), &bad).is_empty());
}

/// A mesh as rows of `(x, y)` pairs, for reading.
fn pts(kind: Envelope, bend: f64) -> Vec<[f64; 2]> {
    mesh(kind, bend, 2, 1, 100.0, 40.0)
}

#[track_caller]
fn all_pts(got: &[[f64; 2]], want: &[[f64; 2]]) {
    assert_eq!(got.len(), want.len(), "{got:?}");
    for (g, w) in got.iter().zip(want) {
        assert!(
            near(g[0], w[0]) && near(g[1], w[1]),
            "{got:?} is not {want:?}"
        );
    }
}

#[test]
fn arch_and_valley_bend_the_middle() {
    // cols 2, rows 1, 100 by 40, bend .5: k = 20. u = 0, .5, 1 gives
    // 0.5 - 4u(1-u) = .5, -.5, .5: the ends go down 10, the middle up 10.
    all_pts(
        &pts(Envelope::Arch, 0.5),
        &[
            [0.0, 10.0],
            [50.0, -10.0],
            [100.0, 10.0],
            [0.0, 50.0],
            [50.0, 30.0],
            [100.0, 50.0],
        ],
    );
    all_pts(
        &pts(Envelope::Valley, 0.5),
        &[
            [0.0, -10.0],
            [50.0, 10.0],
            [100.0, -10.0],
            [0.0, 30.0],
            [50.0, 50.0],
            [100.0, 30.0],
        ],
    );
    // A negative bend flips the arch into a valley.
    all_pts(&pts(Envelope::Arch, -0.5), &pts(Envelope::Valley, 0.5));
}

#[test]
fn flag_is_one_sine_and_rise_a_slope() {
    // Flag, k = 20, u = 0, .5, 1: sin(2 pi u) = 0 at all three nodes.
    all_pts(
        &pts(Envelope::Flag, 0.5),
        &[
            [0.0, 0.0],
            [50.0, 0.0],
            [100.0, 0.0],
            [0.0, 40.0],
            [50.0, 40.0],
            [100.0, 40.0],
        ],
    );
    // Four columns: u = .25 is the crest, y0 - k/2 * 1; u = .75 the trough.
    let f = mesh(Envelope::Flag, 0.5, 4, 1, 100.0, 40.0);
    all_pts(
        &f[..5],
        &[
            [0.0, 0.0],
            [25.0, -10.0],
            [50.0, 0.0],
            [75.0, 10.0],
            [100.0, 0.0],
        ],
    );
    // Rise, k = 20: y moves by k (.5 - (1 - cos(pi u)) / 2) = 10, 0, -10, and
    // x by k/2 (.5 - v) = 5 on the top row, -5 on the bottom.
    all_pts(
        &pts(Envelope::Rise, 0.5),
        &[
            [5.0, 10.0],
            [55.0, 0.0],
            [105.0, -10.0],
            [-5.0, 50.0],
            [45.0, 40.0],
            [95.0, 30.0],
        ],
    );
}

#[test]
fn no_bend_is_the_identity_grid_to_the_bit() {
    for kind in ENVELOPES {
        let (cols, rows) = (7, 3);
        let got = mesh(kind, 0.0, cols, rows, 123.4, 56.7);
        assert_eq!(got.len(), (cols + 1) * (rows + 1));
        for j in 0..=rows {
            for i in 0..=cols {
                let want = [
                    (123.4 * i as f64) / cols as f64,
                    (56.7 * j as f64) / rows as f64,
                ];
                assert_eq!(got[j * (cols + 1) + i], want, "{kind:?} {i} {j}");
            }
        }
        // Negative zero is zero too.
        assert_eq!(mesh(kind, -0.0, cols, rows, 123.4, 56.7), got);
    }
}

#[test]
fn the_mesh_counts_its_points_row_major() {
    let m = mesh(Envelope::Arch, 0.3, 5, 3, 60.0, 30.0);
    assert_eq!(m.len(), 6 * 4);
    // The arch moves y only: x is the column's, and a row's nodes share a
    // column pattern with the next row's.
    for j in 0..4 {
        for i in 0..6 {
            assert!(near(m[j * 6 + i][0], 12.0 * i as f64));
            assert!(near(m[j * 6 + i][1] - m[i][1], 10.0 * j as f64));
        }
    }
    // The bend is held to two boxes' heights.
    assert_eq!(
        mesh(Envelope::Arch, 9.0, 3, 1, 10.0, 10.0),
        mesh(Envelope::Arch, 2.0, 3, 1, 10.0, 10.0)
    );
    assert_eq!(
        mesh(Envelope::Rise, -9.0, 3, 1, 10.0, 10.0),
        mesh(Envelope::Rise, -2.0, 3, 1, 10.0, 10.0)
    );
    assert_eq!(
        mesh(Envelope::Arch, 0.5, MAX_ENVELOPE_GRID, 1, 10.0, 10.0).len(),
        65 * 2
    );
}

#[test]
fn a_mesh_that_cannot_be_made_is_empty() {
    let ok = mesh(Envelope::Arch, 0.5, 2, 1, 100.0, 40.0);
    assert_eq!(ok.len(), 6);
    let nan = f64::NAN;
    for m in [
        mesh(Envelope::Arch, nan, 2, 1, 100.0, 40.0),
        mesh(Envelope::Arch, f64::INFINITY, 2, 1, 100.0, 40.0),
        mesh(Envelope::Arch, 0.5, 2, 1, nan, 40.0),
        mesh(Envelope::Arch, 0.5, 2, 1, 100.0, f64::INFINITY),
        mesh(Envelope::Arch, 0.5, 2, 1, 0.0, 40.0),
        mesh(Envelope::Arch, 0.5, 2, 1, 100.0, 0.0),
        mesh(Envelope::Arch, 0.5, 2, 1, -5.0, 40.0),
        mesh(Envelope::Arch, 0.5, 0, 1, 100.0, 40.0),
        mesh(Envelope::Arch, 0.5, 2, 0, 100.0, 40.0),
        mesh(Envelope::Arch, 0.5, 65, 1, 100.0, 40.0),
        mesh(Envelope::Arch, 0.5, 2, 65, 100.0, 40.0),
        mesh(Envelope::Arch, 0.5, usize::MAX, usize::MAX, 100.0, 40.0),
        // The answer would overflow.
        mesh(Envelope::Arch, 2.0, 2, 1, 100.0, f64::MAX),
    ] {
        assert!(m.is_empty());
    }
}

#[test]
fn envelopes_are_named_and_numbered_in_wire_order() {
    let ids: Vec<_> = ENVELOPES.iter().map(|e| e.id()).collect();
    assert_eq!(ids, ["arch", "valley", "flag", "rise"]);
    for (i, e) in ENVELOPES.iter().enumerate() {
        assert_eq!(Envelope::from_index(i as u32), Some(*e));
    }
    assert_eq!(Envelope::from_index(4), None);
    assert_eq!(Envelope::from_index(u32::MAX), None);
    // The presets: the shape first in "Shape", drip last in "Hand".
    let shape: Vec<_> = PRESETS
        .iter()
        .filter(|p| p.group == "Shape")
        .map(|p| p.id)
        .collect();
    assert_eq!(shape, ["valley", "domino-lean", "explode"]);
    let drip = PRESETS.iter().find(|p| p.id == "drip").unwrap();
    assert_eq!(
        (drip.group, drip.moves),
        ("Hand", &[(Kind::Drip, 0.45, 0.5)][..])
    );
    assert_eq!(PRESETS.last().unwrap().id, "drip");
    assert_eq!(Kind::Drip as usize, 20);
    assert_eq!(Kind::from_id("drip"), Some(Kind::Drip));
}
