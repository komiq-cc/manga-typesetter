//! The kinds and presets table as one JSON string, written by hand: the
//! crate has no serde, and the shape is fixed and ASCII.

use super::envelope::ENVELOPES;
use super::table::{KindInfo, Preset, KINDS, PRESETS};

/// A number as JSON. Rust's `{}` for an `f64` never writes an exponent and
/// writes `1` for `1.0`; every number in the table is finite.
fn num(out: &mut String, v: f64) {
    out.push_str(&v.to_string());
}

/// A string as JSON. The table is ASCII; a quote or a backslash is escaped
/// anyway so that it stays one if a label ever has one.
fn text(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_ascii() && !c.is_ascii_control() => out.push(c),
            _ => out.push('?'),
        }
    }
    out.push('"');
}

fn field(out: &mut String, name: &str) {
    text(out, name);
    out.push(':');
}

fn kind(out: &mut String, k: &KindInfo) {
    out.push('{');
    field(out, "kind");
    text(out, k.id);
    out.push(',');
    field(out, "label");
    text(out, k.label);
    out.push(',');
    field(out, "unit");
    text(out, k.unit);
    for (name, v) in [("min", k.min), ("max", k.max), ("step", k.step)] {
        out.push(',');
        field(out, name);
        num(out, v);
    }
    out.push(',');
    field(out, "b");
    match &k.b {
        None => out.push_str("null"),
        Some(b) => {
            out.push('{');
            field(out, "label");
            text(out, b.label);
            for (name, v) in [
                ("min", b.min),
                ("max", b.max),
                ("step", b.step),
                ("default", b.default),
            ] {
                out.push(',');
                field(out, name);
                num(out, v);
            }
            out.push('}');
        }
    }
    out.push('}');
}

fn preset(out: &mut String, p: &Preset) {
    out.push('{');
    field(out, "id");
    text(out, p.id);
    out.push(',');
    field(out, "name");
    text(out, p.name);
    out.push(',');
    field(out, "group");
    text(out, p.group);
    out.push(',');
    field(out, "flow");
    text(out, if p.stack { "stack" } else { "row" });
    out.push(',');
    field(out, "rowShift");
    num(out, p.row_shift);
    out.push(',');
    field(out, "gap");
    num(out, p.gap);
    out.push(',');
    field(out, "lineHeight");
    match p.line_height {
        Some(v) => num(out, v),
        None => out.push_str("null"),
    }
    out.push(',');
    field(out, "envelope");
    match p.envelope {
        None => out.push_str("null"),
        Some(e) => {
            out.push('{');
            field(out, "kind");
            text(out, e.kind.id());
            out.push(',');
            field(out, "bend");
            num(out, e.bend);
            out.push(',');
            field(out, "cols");
            num(out, f64::from(e.cols));
            out.push(',');
            field(out, "rows");
            num(out, f64::from(e.rows));
            out.push('}');
        }
    }
    out.push(',');
    field(out, "moves");
    out.push('[');
    for (i, (k, a, b)) in p.moves.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('{');
        field(out, "kind");
        text(out, k.info().id);
        out.push(',');
        field(out, "a");
        num(out, *a);
        out.push(',');
        field(out, "b");
        num(out, *b);
        out.push('}');
    }
    out.push_str("]}");
}

/// `{"kinds": [...], "presets": [...], "envelopes": [...]}`; see the table for
/// the fields. `envelopes` are the ids of the warps, in their wire order.
pub fn info_json() -> String {
    let mut out = String::new();
    out.push_str("{\"kinds\":[");
    for (i, k) in KINDS.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        kind(&mut out, k);
    }
    out.push_str("],\"presets\":[");
    for (i, p) in PRESETS.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        preset(&mut out, p);
    }
    out.push_str("],\"envelopes\":[");
    for (i, e) in ENVELOPES.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        text(&mut out, e.id());
    }
    out.push_str("]}");
    out
}
