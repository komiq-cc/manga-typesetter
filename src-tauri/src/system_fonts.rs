//! The fonts installed on this machine, by family, with which of the four faces
//! the app distinguishes (regular, bold, italic, bold italic) are really there.
//!
//! The webview draws an installed family by name - `font-family: 'Name'` needs
//! no bytes handed over - so all the frontend wants from here is the list of
//! names and, per family, which faces it can count on being real rather than
//! synthesised. fontdb parses only the tables it needs to answer that, which is
//! why a scan of several hundred families is a fraction of a second; it is
//! still run off the main thread, because the webview asks at boot.
//!
//! The Rust text engine in the webview (text-engine/) does need bytes: it
//! measures from the font file itself. So the scan also remembers, for each
//! face it folds into a slot, the file it is in and its index in that file.
//! Neither is sent with the list - a path is this machine's business - and
//! `system_font_face` hands over one face's file when the frontend asks for it
//! by family and slot, which it does the first time a box uses that family.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
pub struct Faces {
    pub regular: bool,
    pub bold: bool,
    pub italic: bool,
    #[serde(rename = "boldItalic")]
    pub bold_italic: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct SystemFont {
    pub name: String,
    pub faces: Faces,
}

/// CSS `font-weight: bold` is 700, and the browser's bold matching picks the
/// nearest face at or above 600 (the "semibold or heavier counts as bold" rule
/// of the CSS font matching algorithm). Anything under that renders as the
/// family's regular for a normal-weight request.
const BOLD_FROM: u16 = 600;

/// The four slots, in the order the frontend lists them (`FACE_SLOTS` in
/// src/lib/data.js). The header of `system_font_face`'s answer is in this
/// order, so the two must not drift apart.
pub const SLOTS: [&str; 4] = ["regular", "bold", "italic", "boldItalic"];

fn slot_of(weight: u16, italic: bool) -> usize {
    match (weight >= BOLD_FROM, italic) {
        (false, false) => 0,
        (true, false) => 1,
        (false, true) => 2,
        (true, true) => 3,
    }
}

/// Families whose name begins with a dot are the OS's own UI faces on macOS
/// (".SF NS", ".Keyboard"), not installed for documents and not offered by
/// any font menu the user has seen.
fn listed(family: &str) -> bool {
    !family.is_empty() && !family.starts_with('.')
}

/// Fold one face into its family's entry. Shared by the scan and the tests so
/// the grouping rule is exercised without a font directory.
fn fold(map: &mut BTreeMap<String, Faces>, family: &str, weight: u16, italic: bool) {
    if !listed(family) {
        return;
    }
    let e = map.entry(family.to_string()).or_default();
    match slot_of(weight, italic) {
        0 => e.regular = true,
        1 => e.bold = true,
        2 => e.italic = true,
        _ => e.bold_italic = true,
    }
}

/// Where the face behind one slot lives: the file, and which face of the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaceFile {
    pub path: PathBuf,
    pub index: u32,
    /// How far this face is from what was asked of the slot; see `rank`.
    rank: u32,
    /// The file as the scan found it (`FileStat`), so a later read can tell it
    /// is still that file.
    stat: FileStat,
}

/// What can be known of a file without reading it: its length, and when it
/// was last written, in nanoseconds since the epoch. Zeroes for a file that
/// could not be asked, which no real font file matches.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
struct FileStat {
    size: u64,
    modified: u128,
}

fn stat_of(path: &std::path::Path) -> std::io::Result<FileStat> {
    let meta = std::fs::metadata(path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Ok(FileStat { size: meta.len(), modified })
}

/// One family's four slots, in `SLOTS` order.
pub type FaceFiles = [Option<FaceFile>; 4];

/// Every listed family's files. Kept on this side only.
pub type FontIndex = BTreeMap<String, FaceFiles>;

/// How far a face is from the one the webview draws for its slot: lower is
/// nearer, and the nearest is the one whose file the slot remembers.
///
/// A slot holds many faces - Thin, Light, Regular and Medium all fold into
/// `regular` - and the webview, which still paints the text, picks one of them
/// by the CSS font matching algorithm for `font-weight: 400` or `700`,
/// `font-stretch: normal`. The engine has to measure that same face, so this
/// is that algorithm on the three things it looks at, in its order:
///
///   width   normal first, then the narrower ones nearest first, then wider;
///   slant   in an italic slot a true italic before an oblique;
///   weight  for 400: 400, then up to 500, then lighter ones nearest first,
///           then the rest going up. For 700: 700 and up, nearest first, then
///           the lighter ones nearest first.
///
/// `stretch` is the OS/2 width class, 1 (ultra-condensed) to 9, 5 normal.
fn rank(weight: u16, italic: bool, oblique: bool, stretch: u16) -> u32 {
    let width = match stretch {
        5 => 0,
        s if s < 5 => u32::from(5 - s),
        s => 10 + u32::from(s - 5),
    };
    let slant = u32::from(italic && oblique);
    let w = u32::from(weight);
    let heft = if weight >= BOLD_FROM {
        if w >= 700 { w - 700 } else { 1000 + (700 - w) }
    } else if (400..=500).contains(&w) {
        w - 400
    } else if w < 400 {
        200 + (400 - w)
    } else {
        1000 + w
    };
    width * 1_000_000 + slant * 100_000 + heft
}

/// Remember `path`/`index` as the file of the slot this face folds into, if
/// it is nearer to what the slot is asked for than the one already there.
/// Equal faces (the same font installed in two directories) settle on the
/// lower path, so the choice does not depend on the order of the scan.
#[allow(clippy::too_many_arguments)]
fn fold_file(
    index: &mut FontIndex,
    family: &str,
    weight: u16,
    italic: bool,
    oblique: bool,
    stretch: u16,
    path: &std::path::Path,
    face_index: u32,
) {
    if !listed(family) {
        return;
    }
    let found = FaceFile {
        path: path.to_path_buf(),
        index: face_index,
        rank: rank(weight, italic, oblique, stretch),
        stat: FileStat::default(),
    };
    let slot = &mut index.entry(family.to_string()).or_default()[slot_of(weight, italic)];
    let better = match slot {
        None => true,
        Some(have) => (found.rank, &found.path, found.index) < (have.rank, &have.path, have.index),
    };
    if better {
        *slot = Some(found);
    }
}

fn scan_db(db: &fontdb::Database) -> (Vec<SystemFont>, FontIndex) {
    let mut map: BTreeMap<String, Faces> = BTreeMap::new();
    let mut index = FontIndex::new();
    for face in db.faces() {
        // The first family name is the one the file itself leads with, which is
        // the English name on every font that has one.
        let Some((family, _)) = face.families.first() else { continue };
        let italic = matches!(face.style, fontdb::Style::Italic | fontdb::Style::Oblique);
        // A face with no file behind it cannot be handed over, and a slot the
        // list claims has to be one `system_font_face` can answer for.
        let path = match &face.source {
            fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _) => path,
            fontdb::Source::Binary(_) => continue,
        };
        fold(&mut map, family, face.weight.0, italic);
        fold_file(
            &mut index,
            family,
            face.weight.0,
            italic,
            face.style == fontdb::Style::Oblique,
            face.stretch.to_number(),
            path,
            face.index,
        );
    }
    stat_files(&mut index);
    (map.into_iter().map(|(name, faces)| SystemFont { name, faces }).collect(), index)
}

/// Notes every chosen file as it stands now. After the fold rather than in
/// it: only the face a slot keeps needs asking about, and a collection is
/// asked once however many slots and families it is behind.
fn stat_files(index: &mut FontIndex) {
    let mut seen: std::collections::HashMap<PathBuf, FileStat> = std::collections::HashMap::new();
    for file in index.values_mut().flatten().flatten() {
        file.stat = *seen.entry(file.path.clone()).or_insert_with(|| stat_of(&file.path).unwrap_or_default());
    }
}

fn scan() -> (Vec<SystemFont>, FontIndex) {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    scan_db(&db)
}

/// The files behind the last scan's list. Replaced whole with every scan, like
/// the list the frontend holds, so the two describe the same moment.
static INDEX: Mutex<Option<Arc<FontIndex>>> = Mutex::new(None);

fn rescan() -> Vec<SystemFont> {
    let (list, index) = scan();
    *INDEX.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(index));
    list
}

fn index() -> Arc<FontIndex> {
    if let Some(index) = INDEX.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return index;
    }
    // Asked for a face before anyone asked for the list.
    rescan();
    INDEX.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

#[tauri::command]
pub async fn system_fonts() -> Vec<SystemFont> {
    tauri::async_runtime::spawn_blocking(rescan).await.unwrap_or_default()
}

/// Bytes before the file in `system_font_face`'s answer: one little-endian
/// i32 per slot.
pub const FACE_HEADER: usize = SLOTS.len() * 4;

/// The largest font file that is handed over: 128 MiB.
///
/// The file is read whole, crosses to the webview whole and is copied into
/// the engine's memory whole, so there has to be a size nobody is surprised
/// by. The large files an OS ships are its CJK collections, and the largest
/// text collection on the Mac this was written on is 101 MB (Kaiti.ttc; the
/// others - Xingkai, Hannotate, PingFang, Songti - are 64 to 85 MB), so this
/// admits all of them. It does not admit Apple Color Emoji (183 MB), which is
/// a bitmap font the engine could not use anyway. The same number bounds a
/// decoded WOFF (font_decode.rs).
pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

/// The bytes of a font file with room for the answer's header in front of
/// them, readable as the font alone: the file is checked by parsing it, and
/// then sent, without a second copy of something this size being made.
struct Answer(Vec<u8>);
impl AsRef<[u8]> for Answer {
    fn as_ref(&self) -> &[u8] {
        &self.0[FACE_HEADER..]
    }
}

/// One face's file, as the frontend reads it (`readSystemFace` in
/// src/lib/text-engine/font-sync.js): for each slot in `SLOTS` order the index
/// of that slot's face inside this file, or -1 when that slot's face is not in
/// this file, then the file's bytes untouched.
///
/// The header is why a collection crosses once. Helvetica Neue's four faces
/// are one `.ttc`; asked for its regular, this says where the other three are
/// in the same bytes, and the frontend registers all four from the one copy.
///
/// The path and the indexes are the last scan's, and a scan can be minutes or
/// hours old: a font updated, replaced or removed since then is a different
/// file, or none, behind the same path. So nothing is sent on the scan's word
/// alone. The file must be the length and age the scan found; it must be no
/// larger than `MAX_FILE_BYTES`; and what was read must parse as a font that
/// has a face at every index the header gives and, at one of them at least,
/// a face of the family that was asked for. Anything else is an error for
/// this family - which the frontend shows as a missing font and asks about
/// again after the next scan - never some other font's bytes under its name.
fn face_answer(index: &FontIndex, family: &str, slot: &str) -> Result<Vec<u8>, String> {
    let Some(at) = SLOTS.iter().position(|s| *s == slot) else {
        return Err(format!("there is no face slot called '{slot}'"));
    };
    let Some(files) = index.get(family) else {
        return Err(format!("no font called '{family}' is installed on this computer"));
    };
    let Some(asked) = &files[at] else {
        return Err(format!("'{family}' has no {slot} face"));
    };
    // The path stays out of every message: it is not the frontend's to know.
    let unread = |e: std::io::Error| format!("the file of '{family}' could not be read - {e}");
    let changed = || format!("the file of '{family}' has changed since the fonts were listed");
    let now = stat_of(&asked.path).map_err(unread)?;
    if now != asked.stat {
        return Err(changed());
    }
    if now.size > MAX_FILE_BYTES {
        return Err(format!(
            "the file of '{family}' is too large to load ({} MB; the limit is {} MB)",
            now.size / (1024 * 1024),
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let places: Vec<i32> =
        files.iter().map(|file| file.as_ref().filter(|f| f.path == asked.path).map_or(-1, |f| f.index as i32)).collect();
    let mut out = Vec::with_capacity(FACE_HEADER + now.size as usize);
    for place in &places {
        out.extend_from_slice(&place.to_le_bytes());
    }
    {
        use std::io::Read;
        // One more byte than expected is allowed through, so a file that grew
        // between the two looks is seen to have grown.
        let file = std::fs::File::open(&asked.path).map_err(unread)?;
        file.take(now.size + 1).read_to_end(&mut out).map_err(unread)?;
    }
    if (out.len() - FACE_HEADER) as u64 != now.size {
        return Err(changed());
    }
    let answer = Arc::new(Answer(out));
    let listed = {
        let mut db = fontdb::Database::new();
        db.load_font_source(fontdb::Source::Binary(answer.clone()));
        let face_at = |i: i32| db.faces().find(|f| f.index == i as u32);
        let placed: Vec<_> = places.iter().filter(|i| **i >= 0).map(|i| face_at(*i)).collect();
        placed.iter().all(Option::is_some)
            && placed.iter().flatten().any(|f| f.families.first().is_some_and(|(name, _)| name == family))
    };
    if !listed {
        return Err(format!("the file of '{family}' is no longer the font that was listed"));
    }
    // The database is gone, so this is the only holder.
    Arc::try_unwrap(answer).map(|a| a.0).map_err(|_| "the font file is still being read".to_string())
}

/// The file of one face of one installed family, as a raw binary response: a
/// font as a JSON array of numbers would be several times its own size, and
/// some of these are tens of megabytes.
#[tauri::command]
pub async fn system_font_face(family: String, slot: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || face_answer(&index(), &family, &slot))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_faces_under_their_family_by_weight_and_slant() {
        let mut map = BTreeMap::new();
        fold(&mut map, "Wild Words", 400, false);
        fold(&mut map, "Wild Words", 700, false);
        fold(&mut map, "Wild Words", 400, true);
        fold(&mut map, "Anime Ace", 400, false);
        assert_eq!(
            map.get("Wild Words"),
            Some(&Faces { regular: true, bold: true, italic: true, bold_italic: false })
        );
        assert_eq!(map.get("Anime Ace"), Some(&Faces { regular: true, ..Default::default() }));
    }

    #[test]
    fn semibold_counts_as_bold_and_light_as_regular() {
        let mut map = BTreeMap::new();
        fold(&mut map, "F", 600, true);
        fold(&mut map, "F", 300, false);
        assert_eq!(map.get("F"), Some(&Faces { regular: true, bold_italic: true, ..Default::default() }));
    }

    #[test]
    fn skips_the_os_private_ui_faces() {
        let mut map = BTreeMap::new();
        fold(&mut map, ".SF NS", 400, false);
        fold(&mut map, "", 400, false);
        assert!(map.is_empty());
    }

    use std::path::Path;

    fn file(index: &FontIndex, family: &str, slot: usize) -> Option<(String, u32)> {
        index.get(family)?[slot].as_ref().map(|f| (f.path.to_string_lossy().into_owned(), f.index))
    }

    #[test]
    fn remembers_the_file_and_the_index_of_each_slot() {
        let mut index = FontIndex::new();
        let ttc = Path::new("/fonts/HelveticaNeue.ttc");
        fold_file(&mut index, "Helvetica Neue", 400, false, false, 5, ttc, 0);
        fold_file(&mut index, "Helvetica Neue", 700, false, false, 5, ttc, 1);
        fold_file(&mut index, "Helvetica Neue", 400, true, false, 5, ttc, 2);
        fold_file(&mut index, "Helvetica Neue", 700, true, false, 5, ttc, 4);
        fold_file(&mut index, "Arial", 400, false, false, 5, Path::new("/fonts/Arial.ttf"), 0);
        fold_file(&mut index, ".SF NS", 400, false, false, 5, Path::new("/fonts/SFNS.ttf"), 0);
        assert_eq!(file(&index, "Helvetica Neue", 0), Some(("/fonts/HelveticaNeue.ttc".into(), 0)));
        assert_eq!(file(&index, "Helvetica Neue", 1), Some(("/fonts/HelveticaNeue.ttc".into(), 1)));
        assert_eq!(file(&index, "Helvetica Neue", 2), Some(("/fonts/HelveticaNeue.ttc".into(), 2)));
        assert_eq!(file(&index, "Helvetica Neue", 3), Some(("/fonts/HelveticaNeue.ttc".into(), 4)));
        assert_eq!(file(&index, "Arial", 0), Some(("/fonts/Arial.ttf".into(), 0)));
        assert_eq!(file(&index, "Arial", 1), None);
        assert!(!index.contains_key(".SF NS"));
    }

    #[test]
    fn a_slot_keeps_the_face_css_matching_would_draw() {
        // Whatever order the scan meets them in.
        let weights = [100u16, 300, 400, 500, 600, 700, 900];
        for order in [weights.to_vec(), weights.iter().rev().copied().collect()] {
            let mut index = FontIndex::new();
            for (i, w) in order.iter().enumerate() {
                fold_file(&mut index, "F", *w, false, false, 5, Path::new(&format!("/f/{w}.otf")), i as u32);
            }
            assert_eq!(file(&index, "F", 0).unwrap().0, "/f/400.otf");
            assert_eq!(file(&index, "F", 1).unwrap().0, "/f/700.otf");
        }
        // No 400: Medium before Light. No 700: the heavier before Semibold.
        let mut index = FontIndex::new();
        for w in [300u16, 500, 600, 800] {
            fold_file(&mut index, "G", w, false, false, 5, Path::new(&format!("/g/{w}.otf")), 0);
        }
        assert_eq!(file(&index, "G", 0).unwrap().0, "/g/500.otf");
        assert_eq!(file(&index, "G", 1).unwrap().0, "/g/800.otf");
        // Only lighter than regular: the nearest one.
        let mut index = FontIndex::new();
        for w in [100u16, 300, 200] {
            fold_file(&mut index, "H", w, false, false, 5, Path::new(&format!("/h/{w}.otf")), 0);
        }
        assert_eq!(file(&index, "H", 0).unwrap().0, "/h/300.otf");
    }

    #[test]
    fn a_slot_prefers_normal_width_and_a_true_italic() {
        let mut index = FontIndex::new();
        fold_file(&mut index, "F", 400, false, false, 3, Path::new("/f/condensed.otf"), 0);
        fold_file(&mut index, "F", 500, false, false, 5, Path::new("/f/medium.otf"), 0);
        fold_file(&mut index, "F", 400, false, false, 7, Path::new("/f/expanded.otf"), 0);
        assert_eq!(file(&index, "F", 0).unwrap().0, "/f/medium.otf");
        fold_file(&mut index, "F", 400, true, true, 5, Path::new("/f/oblique.otf"), 0);
        assert_eq!(file(&index, "F", 2).unwrap().0, "/f/oblique.otf");
        fold_file(&mut index, "F", 400, true, false, 5, Path::new("/f/italic.otf"), 0);
        fold_file(&mut index, "F", 400, true, true, 5, Path::new("/f/oblique.otf"), 0);
        assert_eq!(file(&index, "F", 2).unwrap().0, "/f/italic.otf");
        // The same face twice: the lower path, whichever came first.
        fold_file(&mut index, "F", 400, true, false, 5, Path::new("/a/italic.otf"), 0);
        assert_eq!(file(&index, "F", 2).unwrap().0, "/a/italic.otf");
    }

    /// The fonts the JavaScript tests measure with, read from where they are
    /// (src/test/fonts): the answer is checked by parsing it now, so it has to
    /// be given real fonts, and no font is added for it.
    fn fixture(name: &str) -> Vec<u8> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/test/fonts").join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }
    const DEJAVU: &str = "DejaVuSans.ttf";
    const OBLIQUE: &str = "DejaVuSans-Oblique.ttf";
    const BANGERS: &str = "Bangers-Regular.ttf";

    /// A `.ttc` of whole fonts laid end to end: each font's table directory
    /// is its own, with every offset moved to where the font now starts.
    fn collection(fonts: &[Vec<u8>]) -> Vec<u8> {
        let header = 12 + 4 * fonts.len();
        let mut out = Vec::new();
        out.extend_from_slice(b"ttcf");
        out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        out.extend_from_slice(&(fonts.len() as u32).to_be_bytes());
        let mut at = header;
        for font in fonts {
            out.extend_from_slice(&(at as u32).to_be_bytes());
            at += font.len().next_multiple_of(4);
        }
        for font in fonts {
            let base = out.len() as u32;
            let mut moved = font.clone();
            let tables = u16::from_be_bytes([font[4], font[5]]) as usize;
            for t in 0..tables {
                let field = 12 + 16 * t + 8;
                let offset = u32::from_be_bytes(font[field..field + 4].try_into().unwrap());
                moved[field..field + 4].copy_from_slice(&(offset + base).to_be_bytes());
            }
            moved.resize(font.len().next_multiple_of(4), 0);
            out.extend(moved);
        }
        out
    }

    /// A font file written for one test, in a directory of its own.
    fn temp_font(test: &str, name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mt-system-fonts-{}-{test}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// The index a scan would have made of these faces, each file noted as it
    /// stands now: `(family, weight, italic, path, face index)`.
    fn scanned(faces: &[(&str, u16, bool, &Path, u32)]) -> FontIndex {
        let mut index = FontIndex::new();
        for (family, weight, italic, path, at) in faces {
            fold_file(&mut index, family, *weight, *italic, false, 5, path, *at);
        }
        stat_files(&mut index);
        index
    }

    fn header(answer: &[u8]) -> [i32; 4] {
        let mut out = [0i32; 4];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = i32::from_le_bytes(answer[i * 4..i * 4 + 4].try_into().unwrap());
        }
        out
    }

    #[test]
    fn answers_with_the_file_and_where_each_slot_is_in_it() {
        let both = collection(&[fixture(OBLIQUE), fixture(DEJAVU)]);
        let ttc = temp_font("answers", "collection.ttc", &both);
        let bold = temp_font("answers", "bold.ttf", &fixture(DEJAVU));
        let index = scanned(&[("DejaVu Sans", 400, false, &ttc, 1), ("DejaVu Sans", 400, true, &ttc, 0), ("DejaVu Sans", 700, false, &bold, 0)]);

        let regular = face_answer(&index, "DejaVu Sans", "regular").unwrap();
        // regular and italic are in this file, bold is in another, there is no bold italic.
        assert_eq!(header(&regular), [1, -1, 0, -1]);
        assert_eq!(&regular[FACE_HEADER..], &both[..]);
        let other = face_answer(&index, "DejaVu Sans", "bold").unwrap();
        assert_eq!(header(&other), [-1, 0, -1, -1]);
        assert_eq!(&other[FACE_HEADER..], &fixture(DEJAVU)[..]);
    }

    /// `to` in place of the file at `path`, at the length and the age the
    /// scan found there: only reading it can tell.
    fn swap_quietly(path: &Path, to: &[u8]) {
        let meta = std::fs::metadata(path).unwrap();
        let mut bytes = to.to_vec();
        assert!(bytes.len() as u64 <= meta.len(), "the stand-in has to fit in the file it replaces");
        bytes.resize(meta.len() as usize, 0);
        std::fs::write(path, bytes).unwrap();
        std::fs::File::options().write(true).open(path).unwrap().set_modified(meta.modified().unwrap()).unwrap();
        assert_eq!(stat_of(path).unwrap().modified, meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    }

    #[test]
    fn a_file_that_went_or_changed_since_the_scan_is_an_error_for_its_family() {
        let font = temp_font("changed", "font.ttf", &fixture(DEJAVU));
        let index = scanned(&[("DejaVu Sans", 400, false, &font, 0)]);
        assert!(face_answer(&index, "DejaVu Sans", "regular").is_ok());

        // Another font written over it: a different length, a later date.
        std::fs::write(&font, fixture(BANGERS)).unwrap();
        assert_eq!(
            face_answer(&index, "DejaVu Sans", "regular").unwrap_err(),
            "the file of 'DejaVu Sans' has changed since the fonts were listed"
        );
        // Uninstalled.
        std::fs::remove_file(&font).unwrap();
        let gone = face_answer(&index, "DejaVu Sans", "regular").unwrap_err();
        assert!(gone.starts_with("the file of 'DejaVu Sans' could not be read - "), "{gone}");
        assert!(!gone.contains("mt-system-fonts"), "{gone}");
    }

    #[test]
    fn a_file_swapped_behind_the_same_length_and_date_is_found_by_reading_it() {
        // Another family's font where this family's was.
        let font = temp_font("swapped", "font.ttf", &fixture(DEJAVU));
        let index = scanned(&[("DejaVu Sans", 400, false, &font, 0)]);
        swap_quietly(&font, &fixture(BANGERS));
        assert_eq!(
            face_answer(&index, "DejaVu Sans", "regular").unwrap_err(),
            "the file of 'DejaVu Sans' is no longer the font that was listed"
        );
        // Something that is not a font at all.
        swap_quietly(&font, b"not a font, though it is the right length and age");
        assert_eq!(
            face_answer(&index, "DejaVu Sans", "regular").unwrap_err(),
            "the file of 'DejaVu Sans' is no longer the font that was listed"
        );

        // A collection of two replaced by a font of one: the family is still
        // in it, and the italic the header would place at index 1 is not.
        let ttc = temp_font("swapped", "two.ttc", &collection(&[fixture(DEJAVU), fixture(OBLIQUE)]));
        let index = scanned(&[("DejaVu Sans", 400, false, &ttc, 0), ("DejaVu Sans", 400, true, &ttc, 1)]);
        assert!(face_answer(&index, "DejaVu Sans", "italic").is_ok());
        swap_quietly(&ttc, &fixture(DEJAVU));
        for slot in ["regular", "italic"] {
            assert_eq!(
                face_answer(&index, "DejaVu Sans", slot).unwrap_err(),
                "the file of 'DejaVu Sans' is no longer the font that was listed",
                "{slot}"
            );
        }
    }

    #[test]
    fn a_file_over_the_limit_is_refused_without_being_read() {
        // A sparse file: the length is all there is of it.
        let big = temp_font("large", "huge.ttc", b"");
        std::fs::File::options().write(true).open(&big).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        let index = scanned(&[("Huge", 400, false, &big, 0)]);
        assert_eq!(
            face_answer(&index, "Huge", "regular").unwrap_err(),
            "the file of 'Huge' is too large to load (128 MB; the limit is 128 MB)"
        );
    }

    #[test]
    fn says_what_is_wrong_when_it_cannot_answer() {
        let index = scanned(&[("Arial", 400, false, Path::new("/nowhere/at/all/Arial.ttf"), 0)]);
        assert_eq!(
            face_answer(&index, "No Such Font", "regular").unwrap_err(),
            "no font called 'No Such Font' is installed on this computer"
        );
        assert_eq!(face_answer(&index, "Arial", "bold").unwrap_err(), "'Arial' has no bold face");
        assert_eq!(face_answer(&index, "Arial", "heavy").unwrap_err(), "there is no face slot called 'heavy'");
        let unread = face_answer(&index, "Arial", "regular").unwrap_err();
        assert!(unread.starts_with("the file of 'Arial' could not be read - "), "{unread}");
        // The path is this machine's business.
        assert!(!unread.contains("nowhere"), "{unread}");
    }

    /// The real scan, on whatever this machine has. On a machine with no fonts
    /// at all (a bare CI container) there is nothing to check and it says so.
    #[test]
    fn the_scan_keeps_a_file_for_every_face_it_lists_and_hands_over_a_font() {
        let (list, index) = scan();
        if list.is_empty() {
            eprintln!("no system fonts on this machine: the scan and the bytes command were not exercised");
            return;
        }
        assert_eq!(list.len(), index.len());
        for font in &list {
            let files = index.get(&font.name).unwrap_or_else(|| panic!("{} is listed with no files", font.name));
            let listed = [font.faces.regular, font.faces.bold, font.faces.italic, font.faces.bold_italic];
            for (slot, claimed) in listed.iter().enumerate() {
                assert_eq!(files[slot].is_some(), *claimed, "{} / {}", font.name, SLOTS[slot]);
                if let Some(f) = &files[slot] {
                    assert!(f.path.is_absolute(), "{} / {}: {:?}", font.name, SLOTS[slot], f.path);
                }
            }
        }
        // Nothing about a path or an index is in what the frontend receives.
        let sent = serde_json::to_value(&list[0]).unwrap();
        let keys = |v: &serde_json::Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&sent), ["faces", "name"]);
        assert_eq!(keys(&sent["faces"]), ["bold", "boldItalic", "italic", "regular"]);

        // The first face found: its answer is a font fontdb can parse, with a
        // face at the index the header gives.
        let first = &list[0];
        let slot = [first.faces.regular, first.faces.bold, first.faces.italic, first.faces.bold_italic]
            .iter()
            .position(|has| *has)
            .expect("a listed family has a face");
        let answer = face_answer(&index, &first.name, SLOTS[slot]).expect("the first system face can be read");
        let at = header(&answer)[slot];
        assert!(at >= 0, "the header does not place the face that was asked for");
        let mut db = fontdb::Database::new();
        db.load_font_data(answer[FACE_HEADER..].to_vec());
        let parsed: Vec<_> = db.faces().collect();
        assert!(!parsed.is_empty(), "{} did not parse as a font", first.name);
        let face = parsed.iter().find(|f| f.index == at as u32).expect("the file has a face at that index");
        assert_eq!(face.families.first().map(|(name, _)| name.as_str()), Some(first.name.as_str()));

        assert_eq!(
            face_answer(&index, "No Such Font \u{1F47B}", "regular").unwrap_err(),
            "no font called 'No Such Font \u{1F47B}' is installed on this computer"
        );
    }

    /// The families the frontend's last-resort rule looks for
    /// (src/lib/text-engine/last-resort.js), on a machine that has them: every
    /// slot's answer holds a face of that family, of that weight and slant, at
    /// the index the header gives. This is where a real collection is read.
    #[test]
    fn hands_over_every_face_of_the_last_resort_families_this_machine_has() {
        let (list, index) = scan();
        let mut checked = 0;
        for name in ["Helvetica Neue", "Helvetica", "Arial", "Segoe UI", "DejaVu Sans", "Liberation Sans", "Noto Sans"] {
            let Some(font) = list.iter().find(|f| f.name == name) else { continue };
            let has = [font.faces.regular, font.faces.bold, font.faces.italic, font.faces.bold_italic];
            for slot in (0..4).filter(|s| has[*s]) {
                let answer = face_answer(&index, name, SLOTS[slot]).unwrap_or_else(|e| panic!("{name} / {}: {e}", SLOTS[slot]));
                let places = header(&answer);
                let mut db = fontdb::Database::new();
                db.load_font_data(answer[FACE_HEADER..].to_vec());
                // Every slot the header places in this file, not only the one asked for.
                for other in (0..4).filter(|s| places[*s] >= 0) {
                    let face = db
                        .faces()
                        .find(|f| f.index == places[other] as u32)
                        .unwrap_or_else(|| panic!("{name} / {}: no face {} in the file", SLOTS[other], places[other]));
                    assert_eq!(face.families.first().map(|(n, _)| n.as_str()), Some(name));
                    let italic = face.style != fontdb::Style::Normal;
                    assert_eq!(slot_of(face.weight.0, italic), other, "{name} / {}", SLOTS[other]);
                    checked += 1;
                }
                assert!(places[slot] >= 0, "{name} / {}", SLOTS[slot]);
            }
        }
        if checked == 0 {
            eprintln!("none of the last-resort families is installed here: nothing was read");
        }
    }
}
