//! The kinds of move the UI lists and the built-in presets: data, and the one
//! place both are written (`info_json` formats this table for the app).

use super::Envelope;

/// A kind of per-letter move. The table [`KINDS`] has one row for each, in
/// this order, and a kind crosses the wire as its row's index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Step,
    Zigzag,
    Wave,
    Bounce,
    Jitter,
    Mix,
    Grow,
    Swell,
    Fan,
    Tilt,
    Alt,
    Tumble,
    Drop,
    Lean,
    Domino,
    Explode,
    Stretch,
    Lead,
    Taper,
    Slant,
    Drip,
}

/// A move's second number, when it has one.
#[derive(Clone, Copy, Debug)]
pub struct BInfo {
    pub label: &'static str,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub default: f64,
}

/// What the UI needs to show a kind: its name, and the unit and range of `a`.
#[derive(Clone, Copy, Debug)]
pub struct KindInfo {
    pub kind: Kind,
    pub id: &'static str,
    pub label: &'static str,
    /// `"em"`, `"deg"`, or `"x"` for a multiple (a fraction of 1).
    pub unit: &'static str,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub b: Option<BInfo>,
}

const fn k(
    kind: Kind,
    id: &'static str,
    label: &'static str,
    unit: &'static str,
    (min, max, step): (f64, f64, f64),
) -> KindInfo {
    KindInfo {
        kind,
        id,
        label,
        unit,
        min,
        max,
        step,
        b: None,
    }
}

const fn with_b(
    mut info: KindInfo,
    label: &'static str,
    (min, max, step): (f64, f64, f64),
    default: f64,
) -> KindInfo {
    info.b = Some(BInfo {
        label,
        min,
        max,
        step,
        default,
    });
    info
}

pub const KINDS: [KindInfo; 21] = [
    k(Kind::Step, "step", "Stairs", "em", (-3.0, 3.0, 0.05)),
    k(Kind::Zigzag, "zigzag", "Zigzag", "em", (-1.0, 1.0, 0.01)),
    with_b(
        k(Kind::Wave, "wave", "Wave", "em", (-1.0, 1.0, 0.01)),
        "Cycles",
        (0.5, 4.0, 0.25),
        1.0,
    ),
    with_b(
        k(Kind::Bounce, "bounce", "Bounce", "em", (-1.5, 1.5, 0.01)),
        "Hops",
        (1.0, 6.0, 1.0),
        2.0,
    ),
    with_b(
        k(Kind::Jitter, "jitter", "Shake", "em", (0.0, 1.0, 0.01)),
        "Max tilt",
        (0.0, 45.0, 1.0),
        8.0,
    ),
    k(Kind::Mix, "mix", "Size mix", "x", (0.0, 1.0, 0.01)),
    k(Kind::Grow, "grow", "Grow", "x", (-1.5, 1.5, 0.05)),
    k(Kind::Swell, "swell", "Swell", "x", (-1.5, 1.5, 0.05)),
    k(Kind::Fan, "fan", "Fan", "deg", (-90.0, 90.0, 1.0)),
    k(Kind::Tilt, "tilt", "Tilt", "deg", (-90.0, 90.0, 1.0)),
    k(
        Kind::Alt,
        "alt",
        "Alternate tilt",
        "deg",
        (-45.0, 45.0, 1.0),
    ),
    with_b(
        k(
            Kind::Tumble,
            "tumble",
            "Tumble",
            "deg",
            (-180.0, 180.0, 1.0),
        ),
        "Curve",
        (0.5, 4.0, 0.1),
        1.0,
    ),
    with_b(
        k(Kind::Drop, "drop", "Drop", "em", (-3.0, 3.0, 0.05)),
        "Curve",
        (0.5, 4.0, 0.1),
        1.0,
    ),
    k(Kind::Lean, "lean", "Lean", "deg", (-75.0, 75.0, 1.0)),
    k(
        Kind::Domino,
        "domino",
        "Domino lean",
        "deg",
        (-75.0, 75.0, 1.0),
    ),
    k(Kind::Explode, "explode", "Explode", "em", (-3.0, 3.0, 0.01)),
    k(Kind::Stretch, "stretch", "Stretch", "x", (-0.8, 2.0, 0.05)),
    k(
        Kind::Lead,
        "lead",
        "Big first letter",
        "x",
        (0.0, 3.0, 0.05),
    ),
    with_b(
        k(Kind::Taper, "taper", "Taper", "x", (-2.0, 3.0, 0.05)),
        "Start",
        (0.0, 1.0, 0.05),
        0.5,
    ),
    k(Kind::Slant, "slant", "Row slant", "deg", (-60.0, 60.0, 1.0)),
    with_b(
        k(Kind::Drip, "drip", "Drip", "em", (0.0, 2.0, 0.05)),
        "Share",
        (0.0, 1.0, 0.05),
        0.5,
    ),
];

impl Kind {
    pub fn info(self) -> &'static KindInfo {
        // The table is in `Kind` order (a test holds it to that).
        &KINDS[self as usize]
    }

    /// The kind a table row's id names.
    pub fn from_id(id: &str) -> Option<Kind> {
        KINDS.iter().find(|k| k.id == id).map(|k| k.kind)
    }
}

/// A warp a preset asks the app to set up beside the moves: one of the
/// [`Envelope`] shapes over a `cols` by `rows` grid, bent by `bend` (a
/// fraction of the box's height). [`mesh`] gives the points.
#[derive(Clone, Copy, Debug)]
pub struct Env {
    pub kind: Envelope,
    pub bend: f64,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub stack: bool,
    /// Ems each row moves sideways from the one above.
    pub row_shift: f64,
    /// Letter gap, ems.
    pub gap: f64,
    /// A line-height multiplier, or the box's own.
    pub line_height: Option<f64>,
    /// A warp to set up, or none.
    pub envelope: Option<Env>,
    /// `(kind, a, b)`.
    pub moves: &'static [(Kind, f64, f64)],
}

const fn p(
    id: &'static str,
    name: &'static str,
    group: &'static str,
    moves: &'static [(Kind, f64, f64)],
) -> Preset {
    Preset {
        id,
        name,
        group,
        stack: false,
        row_shift: 0.0,
        gap: 0.0,
        line_height: None,
        envelope: None,
        moves,
    }
}

pub const PRESETS: [Preset; 15] = [
    p(
        "stairs-down",
        "Stairs down",
        "Move",
        &[(Kind::Step, -1.2, 0.0)],
    ),
    p("shaky", "Shaky", "Move", &[(Kind::Jitter, 0.17, 13.0)]),
    p(
        "tumble",
        "Tumble",
        "Move",
        &[(Kind::Tumble, 70.0, 1.0), (Kind::Drop, 0.8, 2.0)],
    ),
    p(
        "rumble",
        "Rumble",
        "Move",
        &[(Kind::Step, -0.73, 0.0), (Kind::Jitter, 0.03, 5.0)],
    ),
    p("grow", "Grow", "Size", &[(Kind::Grow, 1.0, 0.0)]),
    p("shrink", "Shrink", "Size", &[(Kind::Grow, -1.0, 0.0)]),
    Preset {
        gap: 0.04,
        ..p(
            "swell",
            "Swell",
            "Size",
            &[(Kind::Swell, 1.0, 0.0), (Kind::Fan, 16.0, 0.0)],
        )
    },
    Preset {
        gap: 0.02,
        ..p(
            "pinch",
            "Pinch",
            "Size",
            &[(Kind::Swell, -0.8, 0.0), (Kind::Fan, -16.0, 0.0)],
        )
    },
    Preset {
        envelope: Some(Env {
            kind: Envelope::Valley,
            bend: 0.6,
            cols: 4,
            rows: 1,
        }),
        ..p("valley", "Valley", "Shape", &[])
    },
    p(
        "domino-lean",
        "Domino lean",
        "Shape",
        &[(Kind::Domino, 38.0, 0.0)],
    ),
    p("explode", "Explode", "Shape", &[(Kind::Explode, 0.87, 0.0)]),
    Preset {
        gap: -0.06,
        ..p(
            "wobble",
            "Wobble",
            "Hand",
            &[
                (Kind::Lead, 0.7, 0.0),
                (Kind::Mix, 0.17, 0.0),
                (Kind::Jitter, 0.12, 8.0),
            ],
        )
    },
    Preset {
        stack: true,
        row_shift: 0.3,
        line_height: Some(0.72),
        ..p(
            "cascade",
            "Cascade",
            "Hand",
            &[(Kind::Jitter, 0.0, 13.0), (Kind::Taper, 1.6, 0.75)],
        )
    },
    Preset {
        ..p(
            "whoosh",
            "Whoosh",
            "Hand",
            &[
                (Kind::Step, -1.94, 0.0),
                (Kind::Lean, 26.0, 0.0),
                (Kind::Tilt, 9.0, 0.0),
                (Kind::Swell, -0.5, 0.0),
                (Kind::Grow, 0.3, 0.0),
            ],
        )
    },
    p("drip", "Drip", "Hand", &[(Kind::Drip, 0.45, 0.5)]),
];
