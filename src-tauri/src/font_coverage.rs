//! Which installed family has a letter the chosen font lacks.
//!
//! A lettering font has Latin and little else, and a manga page mixes it with
//! kana, kanji, Hangul, hearts, stars, arrows and notes. A browser draws those
//! from some system font and tells nobody which. The Rust text engine draws
//! only from bytes it was handed, so it has to be told: the frontend asks here
//! with the code points it has no glyph for, and is answered with family
//! names - which it then sends for like any other system family
//! (`system_font_face`). No path goes either way.
//!
//! THE RULE (text-engine/RULES.md, rule 11). Every code point is answered by
//! itself: it is drawn from the first family, in one fixed order of all the
//! installed families, that has a glyph for it. So the answer for a letter
//! never depends on which other letters were asked about with it, on the
//! order questions arrive in, or on the order a directory or a hash map
//! happens to list things. The order is:
//!
//!   1. this OS's short list (`preferred`), as written;
//!   2. then every other installed family, by its name folded to lower case,
//!      and by the name itself where two fold alike.
//!
//! A family is judged by one face, its regular (else the first slot it has),
//! and by the `cmap` subtable a shaper would use. A face that draws its
//! glyphs as bitmaps or in colour (`sbix`, `CBDT`, `SVG `, `COLR`) is never
//! offered: the engine draws outlines in one colour, and such a face answers
//! for an emoji with an empty outline - a letter that is there and cannot be
//! seen. A file that is no longer the one the scan found is not offered
//! either; `system_font_face` would refuse it.
//!
//! WHAT IT COSTS, measured on the Mac this was written on (`measure_this_
//! machine` below prints it): nothing until the first question. The scan
//! reads no `cmap` - it runs at every launch, with the browser measuring too,
//! and must not get slower for a feature that is off. A face's coverage is
//! read the first time the walk reaches it, only its `cmap` table and not the
//! file, and kept until the next scan; so a question about kana opens the few
//! files at the head of the list, and only a letter nothing has makes the
//! walk read every family once.

use crate::system_fonts::{index, FaceFile, FontIndex};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// The most code points one question may carry. A box's text has a few dozen
/// distinct letters and the frontend splits anything longer; this is what
/// keeps one call's work bounded whoever is calling.
pub const MAX_CODE_POINTS: usize = 1024;

/// The largest `cmap` table that is read. The biggest on the Mac this was
/// written on is under 1 MB (a CJK face with ninety thousand letters); a
/// table past this is a broken file, not a bigger font.
const MAX_CMAP_BYTES: u32 = 16 * 1024 * 1024;

/// Which list applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Macos,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// The families looked in first, most preferred first: what the OS itself
/// falls back to for Japanese, Chinese, Korean and symbols.
///
/// macOS: CoreText's own default cascade list for Helvetica Neue
/// (`CTFontCopyDefaultCascadeListForLanguages`, languages `en` and `ja`, read
/// on macOS 27), in its order, cut to the families that carry leftover Latin,
/// Japanese, Chinese, Korean and symbols. Left out: its private faces (names
/// starting with a dot), the families for scripts a manga page does not mix
/// in (Arabic, Thai, the Indic scripts - those are found by rule 2), and
/// Apple Color Emoji, which is a bitmap face.
///
/// Windows and Linux were not read off a machine: Windows is the UI font
/// Microsoft documents per language (Yu Gothic UI and Meiryo for Japanese,
/// Malgun Gothic, Microsoft YaHei, Microsoft JhengHei) and Segoe UI Symbol;
/// Linux is the Noto CJK families the large distributions install as their
/// default, then the symbol faces beside them.
pub fn preferred(os: Os) -> &'static [&'static str] {
    match os {
        Os::Macos => &[
            "Helvetica",
            "Lucida Grande",
            "Hiragino Sans",
            "Hiragino Sans GB",
            "PingFang SC",
            "PingFang TC",
            "PingFang HK",
            "Apple SD Gothic Neo",
            "Menlo",
            "Apple Symbols",
            "STIX Two Math",
        ],
        Os::Windows => &[
            "Yu Gothic UI",
            "Yu Gothic",
            "Meiryo",
            "Malgun Gothic",
            "Microsoft YaHei",
            "Microsoft JhengHei",
            "Segoe UI Symbol",
        ],
        Os::Linux => &[
            "Noto Sans CJK JP",
            "Noto Sans CJK KR",
            "Noto Sans CJK SC",
            "Noto Sans CJK TC",
            "Noto Sans Symbols",
            "Noto Sans Symbols 2",
            "DejaVu Sans",
        ],
    }
}

/// Where a family stands in the order, as text that sorts the way the order
/// goes when compared code point by code point: the frontend keeps the
/// families it was given in this order (the engine takes a letter from the
/// first of them that has it) without knowing the rule behind it.
fn order_key(os: Os, family: &str) -> String {
    match preferred(os).iter().position(|name| *name == family) {
        Some(at) => format!("0{at:04}"),
        None => format!("1{}\u{1}{family}", family.to_lowercase()),
    }
}

/// The installed families in the order letters are looked for in them.
fn ordered(os: Os, index: &FontIndex) -> Vec<(String, String)> {
    let mut all: Vec<(String, String)> = index.keys().map(|name| (order_key(os, name), name.clone())).collect();
    all.sort();
    all
}

/// The code points one face has a glyph for: sorted ranges, both ends
/// included, none touching the next.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Coverage {
    ranges: Vec<(u32, u32)>,
    /// The face draws in bitmaps or in colour, so it is never offered.
    picture: bool,
}

impl Coverage {
    pub fn has(&self, cp: u32) -> bool {
        self.ranges.binary_search_by(|&(first, last)| {
            if cp < first {
                std::cmp::Ordering::Greater
            } else if cp > last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
    }

    /// How many code points, for the tests and the measurement.
    #[cfg(test)]
    fn count(&self) -> u64 {
        self.ranges.iter().map(|&(a, b)| u64::from(b - a) + 1).sum()
    }
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at.checked_add(2)?)?.try_into().ok()?))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

/// The subtables a shaper would read, best first: all of Unicode before the
/// ones that stop at U+FFFF. The symbol encoding (3, 0) is not among them: it
/// maps a private range, and a font with nothing else has no letters to lend.
const SUBTABLES: [(u16, u16); 8] = [(3, 10), (0, 6), (0, 4), (3, 1), (0, 3), (0, 2), (0, 1), (0, 0)];

/// A `cmap` table's coverage: every code point its best Unicode subtable maps
/// to a glyph other than glyph 0. None when it has no subtable this reads.
/// Nothing in the table is trusted: every offset is checked against its
/// length, and a count that runs past the end stops there.
fn parse_cmap(table: &[u8]) -> Option<Vec<(u32, u32)>> {
    let count = usize::from(be16(table, 2)?);
    let mut found: Vec<(u16, u16, usize)> = Vec::new();
    for i in 0..count {
        let rec = 4 + i * 8;
        let Some(offset) = be32(table, rec + 4) else { break };
        found.push((be16(table, rec)?, be16(table, rec + 2)?, offset as usize));
    }
    for want in SUBTABLES {
        let Some(&(_, _, at)) = found.iter().find(|(p, e, _)| (*p, *e) == want) else { continue };
        let Some(format) = be16(table, at) else { continue };
        let mut out = Ranges::default();
        let read = match format {
            0 => subtable_0(table, at, &mut out),
            4 => subtable_4(table, at, &mut out),
            6 => subtable_6(table, at, &mut out),
            10 => subtable_10(table, at, &mut out),
            12 => subtable_12(table, at, &mut out, false),
            13 => subtable_12(table, at, &mut out, true),
            _ => None,
        };
        if read.is_some() {
            return Some(out.finish());
        }
    }
    None
}

/// Code points as they are found, folded into ranges.
#[derive(Default)]
struct Ranges(Vec<(u32, u32)>);

impl Ranges {
    fn add(&mut self, first: u32, last: u32) {
        if first > last || first > 0x10_FFFF {
            return;
        }
        let last = last.min(0x10_FFFF);
        match self.0.last_mut() {
            Some(prev) if first >= prev.0 && first <= prev.1.saturating_add(1) => prev.1 = prev.1.max(last),
            _ => self.0.push((first, last)),
        }
    }

    fn finish(mut self) -> Vec<(u32, u32)> {
        self.0.sort_unstable();
        let mut merged: Vec<(u32, u32)> = Vec::with_capacity(self.0.len());
        for (first, last) in self.0 {
            match merged.last_mut() {
                Some(prev) if first <= prev.1.saturating_add(1) => prev.1 = prev.1.max(last),
                _ => merged.push((first, last)),
            }
        }
        merged
    }
}

fn subtable_0(t: &[u8], at: usize, out: &mut Ranges) -> Option<()> {
    let glyphs = t.get(at + 6..at + 6 + 256)?;
    for (cp, glyph) in glyphs.iter().enumerate() {
        if *glyph != 0 {
            out.add(cp as u32, cp as u32);
        }
    }
    Some(())
}

fn subtable_4(t: &[u8], at: usize, out: &mut Ranges) -> Option<()> {
    let segs = usize::from(be16(t, at + 6)?) / 2;
    let ends = at + 14;
    let starts = ends + segs * 2 + 2;
    let deltas = starts + segs * 2;
    let offsets = deltas + segs * 2;
    for s in 0..segs {
        let end = u32::from(be16(t, ends + s * 2)?);
        let start = u32::from(be16(t, starts + s * 2)?);
        let delta = u32::from(be16(t, deltas + s * 2)?);
        let offset = usize::from(be16(t, offsets + s * 2)?);
        if start > end {
            continue;
        }
        if offset == 0 {
            // The glyph is `cp + delta` in sixteen bits: glyph 0 for exactly
            // one code point of the segment, if that one is in it.
            let zero = (0x1_0000 - delta) & 0xFFFF;
            if zero < start || zero > end {
                out.add(start, end);
            } else {
                if zero > start {
                    out.add(start, zero - 1);
                }
                if zero < end {
                    out.add(zero + 1, end);
                }
            }
            continue;
        }
        for cp in start..=end {
            let at = offsets + s * 2 + offset + (cp - start) as usize * 2;
            let raw = u32::from(be16(t, at).unwrap_or(0));
            if raw != 0 && (raw + delta) & 0xFFFF != 0 {
                out.add(cp, cp);
            }
        }
    }
    Some(())
}

fn subtable_6(t: &[u8], at: usize, out: &mut Ranges) -> Option<()> {
    let first = u32::from(be16(t, at + 6)?);
    let count = usize::from(be16(t, at + 8)?);
    for i in 0..count {
        let Some(glyph) = be16(t, at + 10 + i * 2) else { break };
        if glyph != 0 {
            out.add(first + i as u32, first + i as u32);
        }
    }
    Some(())
}

fn subtable_10(t: &[u8], at: usize, out: &mut Ranges) -> Option<()> {
    let first = be32(t, at + 12)?;
    let count = be32(t, at + 16)? as usize;
    for i in 0..count {
        let Some(glyph) = be16(t, at + 20 + i * 2) else { break };
        let cp = first.checked_add(i as u32)?;
        if glyph != 0 {
            out.add(cp, cp);
        }
    }
    Some(())
}

/// Formats 12 and 13: groups of `(first, last, glyph)`. In 12 the glyph
/// counts up through the group, in 13 (`same`) the whole group is one glyph.
fn subtable_12(t: &[u8], at: usize, out: &mut Ranges, same: bool) -> Option<()> {
    let groups = be32(t, at + 12)? as usize;
    for g in 0..groups {
        let rec = at + 16 + g * 12;
        let (Some(first), Some(last), Some(glyph)) = (be32(t, rec), be32(t, rec + 4), be32(t, rec + 8)) else { break };
        if first > last {
            continue;
        }
        if glyph != 0 {
            out.add(first, last);
        } else if !same && first < last {
            // Glyph 0 for the first letter of the group only.
            out.add(first + 1, last);
        }
    }
    Some(())
}

const fn tag(t: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*t)
}

/// One face's coverage, from its file: the table directory and the `cmap`
/// table are read, and nothing else of a file that may be a hundred megabytes.
fn read_coverage(path: &Path, face_index: u32) -> Result<Coverage, String> {
    let io = |e: std::io::Error| e.to_string();
    let mut file = std::fs::File::open(path).map_err(io)?;
    let length = file.metadata().map_err(io)?.len();
    let mut head = [0u8; 12];
    file.read_exact(&mut head).map_err(io)?;
    if &head[0..4] == b"ttcf" {
        let faces = be32(&head, 8).unwrap_or(0);
        if face_index >= faces {
            return Err("the collection has no such face".into());
        }
        let mut at = [0u8; 4];
        file.seek(SeekFrom::Start(12 + 4 * u64::from(face_index))).map_err(io)?;
        file.read_exact(&mut at).map_err(io)?;
        file.seek(SeekFrom::Start(u64::from(u32::from_be_bytes(at)))).map_err(io)?;
        file.read_exact(&mut head).map_err(io)?;
    } else if face_index != 0 {
        return Err("a plain font file has one face".into());
    }
    let version = be32(&head, 0).unwrap_or(0);
    if version != 0x0001_0000 && version != tag(b"OTTO") && version != tag(b"true") {
        return Err("not a TrueType or OpenType font".into());
    }
    let tables = usize::from(be16(&head, 4).unwrap_or(0));
    let mut directory = vec![0u8; tables * 16];
    file.read_exact(&mut directory).map_err(io)?;
    let mut cmap = None;
    let mut picture = false;
    for record in directory.chunks_exact(16) {
        let name = be32(record, 0).unwrap_or(0);
        if name == tag(b"cmap") {
            cmap = Some((be32(record, 8).unwrap_or(0), be32(record, 12).unwrap_or(0)));
        } else if [tag(b"sbix"), tag(b"CBDT"), tag(b"SVG "), tag(b"COLR")].contains(&name) {
            picture = true;
        }
    }
    let Some((offset, size)) = cmap else {
        return Err("the font has no cmap table".into());
    };
    if size > MAX_CMAP_BYTES || u64::from(offset) + u64::from(size) > length {
        return Err("the font's cmap table does not fit its file".into());
    }
    let mut table = vec![0u8; size as usize];
    file.seek(SeekFrom::Start(u64::from(offset))).map_err(io)?;
    file.read_exact(&mut table).map_err(io)?;
    let ranges = parse_cmap(&table).ok_or("the font has no Unicode cmap this reads")?;
    Ok(Coverage { ranges, picture })
}

/// The face a family is judged by: its regular, else the first slot it has.
fn judged(index: &FontIndex, family: &str) -> Option<FaceFile> {
    index.get(family)?.iter().flatten().next().cloned()
}

/// What has been read since the last scan. It belongs to one scan's index
/// (`Arc::ptr_eq`) and is dropped with it: a new scan may have found other
/// files behind the same names.
#[derive(Default)]
pub struct Seen {
    scan: Option<Arc<FontIndex>>,
    order: Vec<(String, String)>,
    /// family -> its coverage; None for a family that cannot be offered.
    read: HashMap<String, Option<Arc<Coverage>>>,
}

impl Seen {
    fn follow(&mut self, os: Os, index: &Arc<FontIndex>) {
        if self.scan.as_ref().is_some_and(|have| Arc::ptr_eq(have, index)) {
            return;
        }
        self.scan = Some(index.clone());
        self.order = ordered(os, index);
        self.read.clear();
    }

    /// The family's coverage if it can be offered right now: its file is
    /// still the one the scan found, and its glyphs are outlines.
    fn offerable(&mut self, index: &FontIndex, family: &str) -> Option<Arc<Coverage>> {
        let face = judged(index, family)?;
        // Asked every time, of a family already read too: the file can go
        // between two questions, and asking is one `stat`.
        if !face.unchanged() {
            return None;
        }
        self.read
            .entry(family.to_string())
            .or_insert_with(|| read_coverage(&face.path, face.index).ok().filter(|c| !c.picture).map(Arc::new))
            .clone()
    }

    /// How many families have been read so far, for the tests and the measurement.
    #[cfg(test)]
    fn families_read(&self) -> usize {
        self.read.len()
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Covering {
    /// The family, as `system_fonts` lists it.
    pub name: String,
    /// Where it stands among the families letters are looked for in; see
    /// `order_key`. Compared code point by code point, lower is earlier.
    pub order: String,
    /// The code points asked about that it is the first to have, ascending.
    #[serde(rename = "codePoints")]
    pub code_points: Vec<u32>,
}

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct CoverageAnswer {
    /// In the order letters are looked for in them.
    pub families: Vec<Covering>,
    /// The code points no installed family has, ascending.
    pub none: Vec<u32>,
}

/// Which family each of `asked` is drawn from. Each code point is answered
/// once, however often it was listed; a number that is no Unicode scalar
/// value is one nothing has.
pub fn cover(os: Os, index: &Arc<FontIndex>, read: &mut Seen, asked: &[u32]) -> Result<CoverageAnswer, String> {
    if asked.len() > MAX_CODE_POINTS {
        return Err(format!("too many letters asked about at once ({}; the limit is {MAX_CODE_POINTS})", asked.len()));
    }
    let mut left: Vec<u32> = asked.to_vec();
    left.sort_unstable();
    left.dedup();
    let mut answer = CoverageAnswer::default();
    left.retain(|cp| {
        let scalar = char::from_u32(*cp).is_some();
        if !scalar {
            answer.none.push(*cp);
        }
        scalar
    });
    read.follow(os, index);
    for at in 0..read.order.len() {
        if left.is_empty() {
            break;
        }
        let (order, name) = read.order[at].clone();
        let Some(coverage) = read.offerable(index, &name) else { continue };
        let mine: Vec<u32> = left.iter().copied().filter(|cp| coverage.has(*cp)).collect();
        if mine.is_empty() {
            continue;
        }
        left.retain(|cp| !coverage.has(*cp));
        answer.families.push(Covering { name, order, code_points: mine });
    }
    answer.none.extend(left);
    answer.none.sort_unstable();
    Ok(answer)
}

static READ: Mutex<Option<Seen>> = Mutex::new(None);

/// Which installed family has each of these code points. Off the main thread:
/// the first question about a letter nothing has reads a `cmap` out of every
/// installed family.
#[tauri::command]
pub async fn system_font_coverage(code_points: Vec<u32>) -> Result<CoverageAnswer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let index = index();
        let mut guard = READ.lock().unwrap_or_else(|e| e.into_inner());
        cover(Os::current(), &index, guard.get_or_insert_with(Seen::default), &code_points)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system_fonts::tests::{collection, fixture, scanned, temp_font, BANGERS, DEJAVU, OBLIQUE};
    use std::path::PathBuf;

    const HEART: u32 = 0x2665;
    const NOTE: u32 = 0x266A;
    const KANA_A: u32 = 0x3042;
    const GRIN: u32 = 0x1F600; // astral, and DejaVu Sans has it
    const OLD_ITALIC_A: u32 = 0x10300; // astral too

    fn font(test: &str, name: &str, fixture_name: &str) -> PathBuf {
        temp_font(&format!("coverage-{test}"), name, &fixture(fixture_name))
    }

    /// The answer as `(family, code points)` pairs, and what nothing has.
    fn asked(os: Os, index: FontIndex, cps: &[u32]) -> (Vec<(String, Vec<u32>)>, Vec<u32>) {
        let answer = cover(os, &Arc::new(index), &mut Seen::default(), cps).unwrap();
        (answer.families.into_iter().map(|f| (f.name, f.code_points)).collect(), answer.none)
    }

    fn pairs(list: &[(&str, &[u32])]) -> Vec<(String, Vec<u32>)> {
        list.iter().map(|(name, cps)| (name.to_string(), cps.to_vec())).collect()
    }

    #[test]
    fn reads_the_same_letters_as_the_harness_s_own_reader() {
        // The counts are what scripts/text-port/lib/cmap.mjs reads out of the
        // same four files: a reader written apart from this one.
        for (name, letters, ranges) in [(DEJAVU, 5906, 278), (OBLIQUE, 5271, 222), (BANGERS, 557, 60), ("ComicNeue-Regular.ttf", 303, 38)] {
            let path = font("reads", name, name);
            let coverage = read_coverage(&path, 0).unwrap();
            assert_eq!((coverage.count(), coverage.ranges.len()), (letters, ranges), "{name}");
            assert!(!coverage.picture, "{name}");
            assert!(coverage.ranges.windows(2).all(|w| w[0].1 + 1 < w[1].0), "{name}: ranges touch or are out of order");
        }
        let dejavu = read_coverage(&font("reads", DEJAVU, DEJAVU), 0).unwrap();
        for cp in [0x41, 0xE9, 0x3A9, 0x416, HEART, 0x2192, 0x2605, NOTE, GRIN, OLD_ITALIC_A, 0x2603, 0xFFFD] {
            assert!(dejavu.has(cp), "U+{cp:04X}");
        }
        for cp in [KANA_A, 0xD55C, 0x1D49C, 0xFFFF, 0, 0x10_FFFF, u32::MAX] {
            assert!(!dejavu.has(cp), "U+{cp:04X}");
        }
        let bangers = read_coverage(&font("reads", BANGERS, BANGERS), 0).unwrap();
        assert!(bangers.has(0x41) && bangers.has(0x2019) && !bangers.has(HEART) && !bangers.has(0x3A9));
    }

    #[test]
    fn a_face_inside_a_collection_is_read_by_its_index() {
        let ttc = temp_font("coverage-collection", "two.ttc", &collection(&[fixture(BANGERS), fixture(DEJAVU)]));
        assert_eq!(read_coverage(&ttc, 0).unwrap().count(), 557);
        assert_eq!(read_coverage(&ttc, 1).unwrap().count(), 5906);
        assert_eq!(read_coverage(&ttc, 2).unwrap_err(), "the collection has no such face");
        let plain = font("collection", "plain.ttf", DEJAVU);
        assert_eq!(read_coverage(&plain, 1).unwrap_err(), "a plain font file has one face");
        let junk = temp_font("coverage-collection", "junk.ttf", b"this is not a font at all, only bytes");
        assert_eq!(read_coverage(&junk, 0).unwrap_err(), "not a TrueType or OpenType font");
        let short = temp_font("coverage-collection", "short.ttf", b"\0\x01");
        assert!(read_coverage(&short, 0).is_err());
    }

    #[test]
    fn each_letter_goes_to_the_first_family_in_the_order_that_has_it() {
        let latin = font("order", "latin.ttf", BANGERS);
        let wide = font("order", "wide.ttf", DEJAVU);
        // No family of any OS list: the order is the folded name alone.
        // "alpha" is before "Zeta" there, though 'Z' is before 'a' in bytes.
        let index = scanned(&[("Zeta", 400, false, &wide, 0), ("alpha", 400, false, &wide, 0), ("Beta", 400, false, &latin, 0)]);
        assert_eq!(asked(Os::Macos, index, &[HEART, 0x41, KANA_A]), (pairs(&[("alpha", &[0x41, HEART])]), vec![KANA_A]));
        // The first family takes what it has and the next what is left.
        let index = scanned(&[("Zeta", 400, false, &wide, 0), ("Beta", 400, false, &latin, 0)]);
        assert_eq!(asked(Os::Macos, index, &[HEART, 0x41, 0x42, NOTE]), (pairs(&[("Beta", &[0x41, 0x42]), ("Zeta", &[HEART, NOTE])]), vec![]));
        // Two names that fold alike: the name itself decides.
        let index = scanned(&[("abc", 400, false, &wide, 0), ("ABC", 400, false, &wide, 0), ("Abc", 400, false, &wide, 0)]);
        assert_eq!(asked(Os::Macos, index, &[HEART]).0, pairs(&[("ABC", &[HEART])]));
    }

    #[test]
    fn the_families_the_os_itself_falls_back_to_come_first() {
        let wide = font("preferred", "wide.ttf", DEJAVU);
        let index = || {
            scanned(&[
                ("Aardvark", 400, false, &wide, 0),
                ("Hiragino Sans", 400, false, &wide, 0),
                ("Lucida Grande", 400, false, &wide, 0),
                ("Meiryo", 400, false, &wide, 0),
                ("Noto Sans CJK JP", 400, false, &wide, 0),
            ])
        };
        assert_eq!(asked(Os::Macos, index(), &[HEART]).0, pairs(&[("Lucida Grande", &[HEART])]));
        assert_eq!(asked(Os::Windows, index(), &[HEART]).0, pairs(&[("Meiryo", &[HEART])]));
        assert_eq!(asked(Os::Linux, index(), &[HEART]).0, pairs(&[("Noto Sans CJK JP", &[HEART])]));
        // With none of a list installed, the name order is all there is.
        let bare = scanned(&[("Zeta", 400, false, &wide, 0), ("Aardvark", 400, false, &wide, 0)]);
        assert_eq!(asked(Os::Windows, bare, &[HEART]).0, pairs(&[("Aardvark", &[HEART])]));
        // The keys sort the way the order goes: list first and in its own
        // order, then names.
        for os in [Os::Macos, Os::Windows, Os::Linux] {
            let list = preferred(os);
            assert!(!list.is_empty() && list.len() <= 12, "{os:?}: a short list");
            let keys: Vec<String> = list.iter().map(|name| order_key(os, name)).collect();
            assert!(keys.windows(2).all(|w| w[0] < w[1]), "{os:?}");
            assert!(keys.last().unwrap() < &order_key(os, "\u{1}"), "{os:?}");
            assert!(order_key(os, "") < order_key(os, "A"), "{os:?}");
        }
    }

    #[test]
    fn a_letter_s_answer_does_not_depend_on_what_else_was_asked_or_in_what_order() {
        let latin = font("alone", "latin.ttf", BANGERS);
        let wide = font("alone", "wide.ttf", DEJAVU);
        let slanted = font("alone", "slanted.ttf", OBLIQUE);
        let faces: Vec<(&str, u16, bool, &Path, u32)> = vec![
            ("Gamma", 400, false, &wide, 0),
            ("beta", 400, false, &latin, 0),
            ("Alpha Oblique", 400, true, &slanted, 0),
            ("Hiragino Sans", 400, false, &latin, 0),
        ];
        let cps = [0x41, 0xE9, 0x3A9, HEART, NOTE, GRIN, OLD_ITALIC_A, KANA_A, 0x10A0, 0x2026];
        let whole = asked(Os::Macos, scanned(&faces), &cps);
        // Asked backwards, twice over, and with the index built the other way round.
        let mut backwards: Vec<u32> = cps.iter().rev().copied().collect();
        backwards.extend_from_slice(&cps);
        let reversed: Vec<_> = faces.iter().rev().copied().collect();
        assert_eq!(asked(Os::Macos, scanned(&reversed), &backwards), whole);
        // And one at a time: the same family for every letter.
        for cp in cps {
            let (families, none) = asked(Os::Macos, scanned(&faces), &[cp]);
            let whole_family = whole.0.iter().find(|(_, mine)| mine.contains(&cp)).map(|(name, _)| name.clone());
            assert_eq!(families.first().map(|(name, _)| name.clone()), whole_family, "U+{cp:04X}");
            assert_eq!(none.contains(&cp), whole.1.contains(&cp), "U+{cp:04X}");
        }
        // Every letter was placed once.
        let placed: usize = whole.0.iter().map(|(_, mine)| mine.len()).sum();
        assert_eq!(placed + whole.1.len(), cps.len());
        assert_eq!(whole.1, vec![KANA_A]);
    }

    #[test]
    fn odd_family_names_are_names_like_any_other() {
        let wide = font("names", "wide.ttf", DEJAVU);
        let long = "L".repeat(4000);
        let names = ["It's \"quoted\"", "ヒラギノ角ゴシック", "\u{1F47B} Ghost", "line\nbreak", "tab\there", " leading space", "\u{1}control", "ÀCCENT", long.as_str()];
        for name in names {
            let index = scanned(&[(name, 400, false, &wide, 0)]);
            let answer = cover(Os::Macos, &Arc::new(index), &mut Seen::default(), &[HEART]).unwrap();
            assert_eq!(answer.families.len(), 1, "{name:?}");
            assert_eq!(answer.families[0].name, name);
            // Nothing of the name is lost on the way to the frontend.
            let sent = serde_json::to_value(&answer).unwrap();
            assert_eq!(sent["families"][0]["name"], name);
            assert_eq!(sent["families"][0]["codePoints"], serde_json::json!([HEART]));
            assert!(sent["families"][0]["order"].is_string());
            assert_eq!(sent["none"], serde_json::json!([]));
        }
        // All of them at once: one fixed order, the same whichever way the index was filled.
        let all: Vec<(&str, u16, bool, &Path, u32)> = names.iter().map(|name| (*name, 400, false, wide.as_path(), 0)).collect();
        let backwards: Vec<_> = all.iter().rev().copied().collect();
        let first = asked(Os::Macos, scanned(&all), &[HEART]);
        assert_eq!(first, asked(Os::Macos, scanned(&backwards), &[HEART]));
        assert_eq!(first.0, pairs(&[("\u{1}control", &[HEART])]));
    }

    #[test]
    fn a_file_gone_or_changed_since_the_scan_is_not_offered() {
        let first = font("gone", "first.ttf", DEJAVU);
        let second = font("gone", "second.ttf", DEJAVU);
        let index = Arc::new(scanned(&[("Alpha", 400, false, &first, 0), ("Beta", 400, false, &second, 0)]));
        let mut seen = Seen::default();
        let name = |seen: &mut Seen| cover(Os::Macos, &index, seen, &[HEART]).unwrap().families[0].name.clone();
        assert_eq!(name(&mut seen), "Alpha");
        // Uninstalled after it was read and kept: the next family answers.
        std::fs::remove_file(&first).unwrap();
        assert_eq!(name(&mut seen), "Beta");
        // Written over: another length and date, so not the file that was listed.
        std::fs::write(&second, fixture(BANGERS)).unwrap();
        let answer = cover(Os::Macos, &index, &mut seen, &[HEART, 0x41]).unwrap();
        assert_eq!(answer, CoverageAnswer { families: vec![], none: vec![0x41, HEART] });
        // And a file that was never there to read.
        let index = Arc::new(scanned(&[("Nowhere", 400, false, Path::new("/nowhere/at/all/font.ttf"), 0)]));
        assert_eq!(cover(Os::Macos, &index, &mut Seen::default(), &[0x41]).unwrap().none, vec![0x41]);
    }

    #[test]
    fn a_letter_nothing_has_an_astral_one_and_a_number_that_is_no_letter() {
        let latin = font("astral", "latin.ttf", BANGERS);
        let wide = font("astral", "wide.ttf", DEJAVU);
        let index = || scanned(&[("Latin", 400, false, &latin, 0), ("Wide", 400, false, &wide, 0)]);
        // Astral code points are code points: one the font has, one it has not.
        assert_eq!(asked(Os::Macos, index(), &[GRIN, OLD_ITALIC_A, 0x1F9FF]), (pairs(&[("Wide", &[OLD_ITALIC_A, GRIN])]), vec![0x1F9FF]));
        // Nothing has kana here; the last code point there is; a surrogate, a
        // number past the end of Unicode and the largest number there is.
        let (families, none) = asked(Os::Macos, index(), &[KANA_A, 0x10_FFFF, 0xD800, 0xDFFF, 0x11_0000, u32::MAX, 0]);
        assert_eq!(families, vec![]);
        assert_eq!(none, vec![0, KANA_A, 0xD800, 0xDFFF, 0x10_FFFF, 0x11_0000, u32::MAX]);
    }

    #[test]
    fn an_empty_question_reads_nothing_and_a_long_one_is_refused() {
        let wide = font("bounds", "wide.ttf", DEJAVU);
        let index = Arc::new(scanned(&[("Wide", 400, false, &wide, 0)]));
        let mut seen = Seen::default();
        assert_eq!(cover(Os::Macos, &index, &mut seen, &[]).unwrap(), CoverageAnswer::default());
        assert_eq!(seen.families_read(), 0);
        // At the limit it is answered, each letter once however often listed.
        let mut most: Vec<u32> = (0x41..0x41 + 26).cycle().take(MAX_CODE_POINTS).collect();
        let answer = cover(Os::Macos, &index, &mut seen, &most).unwrap();
        assert_eq!(answer.families[0].code_points, (0x41..0x41 + 26).collect::<Vec<u32>>());
        // One more is an error, and nothing is looked up for it.
        most.push(HEART);
        let mut fresh = Seen::default();
        assert_eq!(
            cover(Os::Macos, &index, &mut fresh, &most).unwrap_err(),
            "too many letters asked about at once (1025; the limit is 1024)"
        );
        assert_eq!(fresh.families_read(), 0);
        let endless = vec![KANA_A; 5_000_000];
        assert!(cover(Os::Macos, &index, &mut fresh, &endless).is_err());
    }

    #[test]
    fn a_face_that_draws_pictures_is_never_offered() {
        // No colour font is added for this: a fixture's own directory, with
        // one table's name written over. The reader looks at names only.
        for table in [b"sbix", b"CBDT", b"SVG ", b"COLR"] {
            let mut bytes = fixture(DEJAVU);
            let tables = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
            let record = (0..tables).map(|t| 12 + 16 * t).find(|at| &bytes[*at..*at + 4] == b"gasp").expect("the fixture has a gasp table");
            bytes[record..record + 4].copy_from_slice(table);
            let name = String::from_utf8_lossy(table).trim().to_string();
            let colour = temp_font("coverage-picture", &format!("{name}.ttf"), &bytes);
            assert!(read_coverage(&colour, 0).unwrap().picture, "{name}");
            let plain = font("picture", "plain.ttf", DEJAVU);
            let index = scanned(&[("Aaa Colour", 400, false, &colour, 0), ("Plain", 400, false, &plain, 0)]);
            assert_eq!(asked(Os::Macos, index, &[GRIN]).0, pairs(&[("Plain", &[GRIN])]), "{name}");
            let alone = scanned(&[("Aaa Colour", 400, false, &colour, 0)]);
            assert_eq!(asked(Os::Macos, alone, &[GRIN]), (vec![], vec![GRIN]), "{name}");
        }
    }

    #[test]
    fn a_family_is_judged_by_its_regular_face_and_read_once_a_scan() {
        let latin = font("judged", "latin.ttf", BANGERS);
        let wide = font("judged", "wide.ttf", DEJAVU);
        // The regular has no heart, the bold has: the family is not offered for it.
        let index = scanned(&[("Mixed", 400, false, &latin, 0), ("Mixed", 700, false, &wide, 0)]);
        assert_eq!(asked(Os::Macos, index, &[HEART]), (vec![], vec![HEART]));
        // No regular: the first slot it has.
        let index = scanned(&[("Bold Only", 700, false, &wide, 0)]);
        assert_eq!(asked(Os::Macos, index, &[HEART]).0, pairs(&[("Bold Only", &[HEART])]));

        // What was read is kept for the scan it was read under, and no longer.
        let index = Arc::new(scanned(&[("Alpha", 400, false, &latin, 0), ("Beta", 400, false, &wide, 0)]));
        let mut seen = Seen::default();
        cover(Os::Macos, &index, &mut seen, &[0x41]).unwrap();
        assert_eq!(seen.families_read(), 1, "a letter the first family has opens the first family only");
        cover(Os::Macos, &index, &mut seen, &[HEART]).unwrap();
        assert_eq!(seen.families_read(), 2);
        let kept = seen.read["Beta"].clone().unwrap();
        cover(Os::Macos, &index, &mut seen, &[NOTE]).unwrap();
        assert!(Arc::ptr_eq(&kept, seen.read["Beta"].as_ref().unwrap()), "read a second time");
        let rescanned = Arc::new(scanned(&[("Alpha", 400, false, &wide, 0)]));
        assert_eq!(cover(Os::Macos, &rescanned, &mut seen, &[HEART]).unwrap().families[0].name, "Alpha");
        assert_eq!(seen.families_read(), 1);
    }

    /// A `cmap` with one subtable, (3, 10) or (3, 1) by the format.
    fn cmap_with(format: u16, body: &[u8]) -> Vec<u8> {
        let mut t = vec![0, 0, 0, 1, 0, 3, 0, if format >= 8 { 10 } else { 1 }, 0, 0, 0, 12];
        t.extend_from_slice(&format.to_be_bytes());
        t.extend_from_slice(body);
        t
    }

    fn words(list: &[u16]) -> Vec<u8> {
        list.iter().flat_map(|w| w.to_be_bytes()).collect()
    }

    fn longs(list: &[u32]) -> Vec<u8> {
        list.iter().flat_map(|w| w.to_be_bytes()).collect()
    }

    #[test]
    fn every_cmap_format_leaves_out_the_letters_that_map_to_glyph_zero() {
        // Format 4, three segments: A-C by delta (B is glyph 0: 0x42 + delta
        // wraps to it), a-c through the glyph array (b is 0 there), the end mark.
        let mut body = words(&[0, 0, 6, 0, 0, 0]); // length, language, segCountX2, three search fields
        body.extend(words(&[0x43, 0x63, 0xFFFF, 0])); // end codes, pad
        body.extend(words(&[0x41, 0x61, 0xFFFF])); // start codes
        body.extend(words(&[0x1_0000u32.wrapping_sub(0x42) as u16, 0, 1])); // deltas
        body.extend(words(&[0, 4, 0])); // range offsets: the second points two words on
        body.extend(words(&[7, 0, 9])); // glyph array for a, b, c
        assert_eq!(parse_cmap(&cmap_with(4, &body)).unwrap(), vec![(0x41, 0x41), (0x43, 0x43), (0x61, 0x61), (0x63, 0x63)]);

        // Format 12: a group whose first letter is glyph 0, one astral group.
        let mut body = words(&[0]);
        body.extend(longs(&[0, 0, 3, 0x3041, 0x3043, 0, 0x1F600, 0x1F602, 50, 0x30, 0x39, 5]));
        assert_eq!(parse_cmap(&cmap_with(12, &body)).unwrap(), vec![(0x30, 0x39), (0x3042, 0x3043), (0x1F600, 0x1F602)]);

        // Format 13: a whole group is one glyph, and glyph 0 is none.
        let mut body = words(&[0]);
        body.extend(longs(&[0, 0, 2, 0x100, 0x1FF, 0, 0x200, 0x2FF, 3]));
        assert_eq!(parse_cmap(&cmap_with(13, &body)).unwrap(), vec![(0x200, 0x2FF)]);

        // Format 6: a run of glyph ids from a first code.
        let body = words(&[0, 0, 0x41, 3, 5, 0, 6]);
        assert_eq!(parse_cmap(&cmap_with(6, &body)).unwrap(), vec![(0x41, 0x41), (0x43, 0x43)]);

        // Format 10: the same in 32 bits.
        let mut body = words(&[0]);
        body.extend(longs(&[0, 0, 0x1F600, 3]));
        body.extend(words(&[1, 0, 2]));
        assert_eq!(parse_cmap(&cmap_with(10, &body)).unwrap(), vec![(0x1F600, 0x1F600), (0x1F602, 0x1F602)]);

        // Format 0: one byte a code.
        let mut body = words(&[0, 0]);
        let mut glyphs = [0u8; 256];
        glyphs[0x41] = 1;
        glyphs[0x42] = 2;
        body.extend_from_slice(&glyphs);
        assert_eq!(parse_cmap(&cmap_with(0, &body)).unwrap(), vec![(0x41, 0x42)]);

        // The symbol encoding alone is no Unicode coverage; neither is a format nobody reads.
        let mut symbol = cmap_with(6, &words(&[0, 0, 0xF041, 1, 5]));
        symbol[7] = 0;
        assert_eq!(parse_cmap(&symbol), None);
        assert_eq!(parse_cmap(&cmap_with(2, &words(&[0, 0]))), None);
    }

    #[test]
    fn a_cmap_cut_short_anywhere_is_read_as_far_as_it_goes_and_never_past_its_end() {
        // The real table of each fixture, at every length it could be cut to
        // and with every count field set to its largest: no panic, no letter
        // past the end of Unicode.
        for name in [DEJAVU, BANGERS] {
            let bytes = fixture(name);
            let tables = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
            let record = (0..tables).map(|t| 12 + 16 * t).find(|at| &bytes[*at..*at + 4] == b"cmap").unwrap();
            let offset = u32::from_be_bytes(bytes[record + 8..record + 12].try_into().unwrap()) as usize;
            let length = u32::from_be_bytes(bytes[record + 12..record + 16].try_into().unwrap()) as usize;
            let table = &bytes[offset..offset + length];
            let whole = parse_cmap(table).unwrap();
            for cut in (0..length).step_by(7) {
                if let Some(ranges) = parse_cmap(&table[..cut]) {
                    assert!(ranges.iter().all(|&(a, b)| a <= b && b <= 0x10_FFFF), "{name} cut at {cut}");
                    assert!(ranges.len() <= whole.len() + 1, "{name} cut at {cut}");
                }
            }
            for at in (0..length.min(4096)).step_by(2) {
                let mut loud = table.to_vec();
                loud[at] = 0xFF;
                loud[at + 1] = 0xFF;
                if let Some(ranges) = parse_cmap(&loud) {
                    assert!(ranges.iter().all(|&(a, b)| a <= b && b <= 0x10_FFFF), "{name} loud at {at}");
                }
            }
        }
    }

    /// What this machine answers, where it is a Mac with the families macOS
    /// ships: the kana come from Hiragino Sans, as CoreText draws them.
    #[test]
    fn on_this_machine_the_kana_come_from_the_family_the_os_uses() {
        let (list, index) = crate::system_fonts::scan();
        if list.is_empty() {
            eprintln!("no system fonts on this machine: nothing was asked");
            return;
        }
        let index = Arc::new(index);
        let mut seen = Seen::default();
        let cps = [KANA_A, 0x30A2, 0x6F22, 0xD55C, HEART, 0x2605, 0x2192, NOTE, GRIN, 0x10_FFFF];
        let answer = cover(Os::current(), &index, &mut seen, &cps).unwrap();
        // The same question again, and from a cold start, is the same answer.
        assert_eq!(cover(Os::current(), &index, &mut seen, &cps).unwrap(), answer);
        assert_eq!(cover(Os::current(), &index, &mut Seen::default(), &cps).unwrap(), answer);
        assert!(answer.none.contains(&0x10_FFFF));
        // Every family named is one the list has, and its file can be handed over.
        for family in &answer.families {
            assert!(list.iter().any(|f| f.name == family.name), "{} is not in the list", family.name);
            assert!(!family.code_points.is_empty());
        }
        let orders: Vec<&String> = answer.families.iter().map(|f| &f.order).collect();
        assert!(orders.windows(2).all(|w| w[0] < w[1]), "the families are not in the order letters are looked for in them");
        if cfg!(target_os = "macos") && list.iter().any(|f| f.name == "Hiragino Sans") {
            let of = |cp: u32| answer.families.iter().find(|f| f.code_points.contains(&cp)).map(|f| f.name.as_str());
            assert_eq!(of(KANA_A), Some("Hiragino Sans"));
            assert_eq!(of(0x30A2), Some("Hiragino Sans"));
            assert_eq!(of(0x6F22), Some("Hiragino Sans"));
        }
    }

    /// Not a test: the numbers behind the choice of when coverage is read.
    /// `cargo test measure_this_machine -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn measure_this_machine() {
        use std::time::Instant;
        let t = Instant::now();
        let (list, index) = crate::system_fonts::scan();
        let scan = t.elapsed();
        let index = Arc::new(index);
        println!("installed families: {}; the scan as it is: {scan:.2?}", list.len());

        // A: coverage read for every family, as a scan that kept it would.
        let t = Instant::now();
        let mut ranges = 0usize;
        let mut letters = 0u64;
        let mut unread = 0;
        let mut pictures = Vec::new();
        let mut largest = (0usize, String::new());
        for name in index.keys() {
            let face = judged(&index, name).unwrap();
            match read_coverage(&face.path, face.index) {
                Ok(c) => {
                    ranges += c.ranges.len();
                    letters += c.count();
                    if c.ranges.len() > largest.0 {
                        largest = (c.ranges.len(), name.clone());
                    }
                    if c.picture {
                        pictures.push(name.clone());
                    }
                }
                Err(_) => unread += 1,
            }
        }
        let all = t.elapsed();
        println!("A  every family's cmap read: {all:.2?} ({ranges} ranges, {} KB held, {letters} letters, {unread} unreadable)", ranges * 8 / 1024);
        println!("   most ranges: {} in {}; picture faces: {pictures:?}", largest.0, largest.1);
        let t = Instant::now();
        for name in index.keys() {
            let face = judged(&index, name).unwrap();
            let _ = read_coverage(&face.path, face.index);
        }
        println!("   the same again, files now in the OS cache: {:.2?}", t.elapsed());

        // B: read as the walk reaches a family. Each from a cold start.
        let kana: Vec<u32> = "こんにちは".chars().map(u32::from).collect();
        let mixed = [KANA_A, 0x6F22, 0xD55C, HEART, 0x2605, 0x2192, NOTE];
        for (what, cps) in [("kana", &kana[..]), ("kana, kanji, hangul, symbols", &mixed[..]), ("a letter nothing has", &[0x10_FFFF][..]), ("an emoji", &[GRIN][..])] {
            let mut seen = Seen::default();
            let t = Instant::now();
            let answer = cover(Os::current(), &index, &mut seen, cps).unwrap();
            let first = t.elapsed();
            let t = Instant::now();
            cover(Os::current(), &index, &mut seen, cps).unwrap();
            let again = t.elapsed();
            let names: Vec<String> = answer.families.iter().map(|f| format!("{} x{}", f.name, f.code_points.len())).collect();
            println!("B  {what}: first answer {first:.2?} ({} families read), again {again:.2?}: {names:?}, none {}", seen.families_read(), answer.none.len());
        }

        // The rule beside what CoreText itself picks for Helvetica Neue
        // (`CTFontCreateForString`, read on the same machine): the letters of
        // a sample that Helvetica Neue lacks, and the family each went to.
        let sample: [(char, &str); 23] = [
            ('あ', "Hiragino Sans"), ('ア', "Hiragino Sans"), ('漢', "Hiragino Sans"), ('한', "Apple SD Gothic Neo"),
            ('♥', "Hiragino Sans"), ('★', "Hiragino Sans"), ('→', "Lucida Grande"), ('😀', "Apple Color Emoji"),
            ('☃', "Hiragino Sans"), ('✓', "Lucida Grande"), ('〜', "Hiragino Sans"), ('ー', "Hiragino Sans"),
            ('♡', "Hiragino Sans"), ('☆', "Hiragino Sans"), ('←', "Lucida Grande"), ('♫', "Hiragino Sans"),
            ('⚠', "Hiragino Sans"), ('▶', "Lucida Grande"), ('■', "Lucida Grande"), ('○', "Lucida Grande"),
            ('卍', "Hiragino Sans"), ('㊙', "Hiragino Sans"), ('①', "Hiragino Sans"),
        ];
        if cfg!(target_os = "macos") {
            let mut seen = Seen::default();
            let mut same = 0;
            for (ch, coretext) in sample {
                let answer = cover(Os::Macos, &index, &mut seen, &[u32::from(ch)]).unwrap();
                let mine = answer.families.first().map_or("(none)", |f| f.name.as_str()).to_string();
                if mine == coretext {
                    same += 1;
                } else {
                    println!("   U+{:04X}: the rule {mine}, CoreText {coretext}", u32::from(ch));
                }
            }
            println!("C  the family CoreText picks, of {} sample letters Helvetica Neue lacks: {same} the same", sample.len());
        }
    }
}
