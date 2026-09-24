// Real user-font loading: FontFace registration + IndexedDB persistence.
//
// A font here is a family group, not a file. Scanlation cannot use faux bold or
// faux italic - a synthesised slant next to real lettering is immediately
// visible, and a smeared 700 of a brush face looks like a mistake - so a family
// holds up to four real faces (regular, bold, italic, boldItalic) and each one
// is handed to the browser with the CSS descriptors that describe it:
//
//   new FontFace('Manga Temple', bytes, { weight: '700', style: 'italic' })
//
// Every face registers under the SAME family string. That is the whole trick,
// and the reason nothing downstream had to change for this: fontCssFor still
// returns one family, the canvas/DOM/export paths still ask for
// `font-weight:700`, and the browser picks the real 700 face when one has been
// registered and synthesises only when none has. Inventing per-face family
// names ("Manga Temple Bold") would instead have meant teaching every one of
// those call sites - and every style.font string already saved to disk - about
// names that did not exist when the document was written.
import { app, toast, noteFontsChanged, fontByName } from './store.svelte.js';
import { FACE_SLOTS, emptyFaces } from './data.js';

export { FACE_SLOTS };

const DB_NAME = 'manga-typesetter';
const STORE = 'fonts';
const DB_VERSION = 2;

export const SLOT_LABEL = {
  regular: 'Regular',
  bold: 'Bold',
  italic: 'Italic',
  boldItalic: 'Bold Italic',
};

// ---- pure helpers (no IndexedDB, no DOM - see fonts.test.js) ----

// Parse the real PostScript name (nameID 6) out of font file bytes (TrueType,
// OpenType/CFF, or TTC collection). Photoshop identifies installed fonts by
// their exact PostScript name, which often differs from simple family+suffix
// combinations (e.g. "Arial-BoldMT", "CCWildWords-Regular", "AnimeAce2BB-Italic").
export function parsePostScriptName(buf) {
  if (!buf) return null;
  let u8;
  if (buf instanceof Uint8Array) {
    u8 = buf;
  } else if (buf instanceof ArrayBuffer) {
    u8 = new Uint8Array(buf);
  } else if (ArrayBuffer.isView(buf)) {
    u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    return null;
  }

  if (u8.byteLength < 12) return null;

  try {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let fontStart = 0;
    const tag0 = view.getUint32(0, false);

    if (tag0 === 0x74746366) {
      // 'ttcf' (TrueType Collection)
      if (view.byteLength < 16) return null;
      const numFonts = view.getUint32(8, false);
      if (numFonts < 1) return null;
      fontStart = view.getUint32(12, false);
      if (fontStart + 12 > view.byteLength) return null;
      const fontTag = view.getUint32(fontStart, false);
      if (fontTag !== 0x00010000 && fontTag !== 0x74727565 && fontTag !== 0x4f54544f) {
        return null;
      }
    } else if (tag0 === 0x00010000 || tag0 === 0x74727565 || tag0 === 0x4f54544f) {
      // 0x00010000 (TrueType), 'true' (TrueType OS X), 'OTTO' (OpenType CFF)
      fontStart = 0;
    } else {
      return null;
    }

    const numTables = view.getUint16(fontStart + 4, false);
    const tableDirEnd = fontStart + 12 + numTables * 16;
    if (tableDirEnd > view.byteLength) return null;

    let nameTableOffset = 0;
    let nameTableLength = 0;
    let foundNameTable = false;

    for (let i = 0; i < numTables; i++) {
      const entryOffset = fontStart + 12 + i * 16;
      const tag = view.getUint32(entryOffset, false);
      if (tag === 0x6e616d65) {
        // 'name'
        nameTableOffset = view.getUint32(entryOffset + 8, false);
        nameTableLength = view.getUint32(entryOffset + 12, false);
        foundNameTable = true;
        break;
      }
    }

    if (!foundNameTable) return null;
    if (nameTableOffset + 6 > view.byteLength || nameTableLength < 6) return null;

    const count = view.getUint16(nameTableOffset + 2, false);
    const stringOffset = view.getUint16(nameTableOffset + 4, false);
    const stringStorageBase = nameTableOffset + stringOffset;

    if (nameTableOffset + 6 + count * 12 > view.byteLength) return null;
    if (stringStorageBase > view.byteLength) return null;

    const candidates = [];

    for (let i = 0; i < count; i++) {
      const recOffset = nameTableOffset + 6 + i * 12;
      const platformID = view.getUint16(recOffset, false);
      const encodingID = view.getUint16(recOffset + 2, false);
      const languageID = view.getUint16(recOffset + 4, false);
      const nameID = view.getUint16(recOffset + 6, false);
      const length = view.getUint16(recOffset + 8, false);
      const offset = view.getUint16(recOffset + 10, false);

      if (nameID !== 6 || length === 0) continue;

      const strStart = stringStorageBase + offset;
      if (strStart + length > view.byteLength) continue;

      // Ranking preference:
      // 1. platformID 3 (Windows), encodingID 1 (Unicode BMP), languageID 0x0409 (US English)
      // 2. platformID 3, encodingID 1 (other languages)
      // 3. platformID 3, other encodings
      // 4. platformID 0 (Unicode)
      // 5. platformID 1 (Macintosh), encodingID 0 (Roman)
      // 6. any other nameID 6 record
      let rank = 10;
      if (platformID === 3 && encodingID === 1 && languageID === 0x0409) {
        rank = 100;
      } else if (platformID === 3 && encodingID === 1) {
        rank = 90;
      } else if (platformID === 3) {
        rank = 80;
      } else if (platformID === 0) {
        rank = 70;
      } else if (platformID === 1 && encodingID === 0) {
        rank = 60;
      }

      candidates.push({
        platformID,
        encodingID,
        strStart,
        length,
        rank,
      });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.rank - a.rank);

    for (const cand of candidates) {
      const { platformID, encodingID, strStart, length } = cand;
      const slice = u8.subarray(strStart, strStart + length);
      let str = '';

      if (platformID === 3 || platformID === 0) {
        // UTF-16BE name records with odd byte length decode with a trailing replacement char (\uFFFD),
        // breaking PostScript matching - truncate to even length before decoding.
        const evenLen = slice.length - (slice.length % 2);
        const evenSlice = evenLen === slice.length ? slice : slice.subarray(0, evenLen);
        try {
          str = new TextDecoder('utf-16be').decode(evenSlice);
        } catch {
          str = '';
          for (let k = 0; k + 1 < evenSlice.length; k += 2) {
            str += String.fromCharCode((evenSlice[k] << 8) | evenSlice[k + 1]);
          }
        }
      } else if (platformID === 1 && encodingID === 0) {
        str = '';
        for (let k = 0; k < slice.length; k++) {
          str += String.fromCharCode(slice[k]);
        }
      } else {
        const evenLen = slice.length - (slice.length % 2);
        const evenSlice = evenLen === slice.length ? slice : slice.subarray(0, evenLen);
        if (evenSlice.length >= 2 && evenSlice[0] === 0) {
          try {
            str = new TextDecoder('utf-16be').decode(evenSlice);
          } catch {
            str = '';
            for (let k = 0; k + 1 < evenSlice.length; k += 2) {
              str += String.fromCharCode((evenSlice[k] << 8) | evenSlice[k + 1]);
            }
          }
        } else {
          try {
            str = new TextDecoder('utf-8').decode(slice);
          } catch {
            str = '';
            for (let k = 0; k < slice.length; k++) {
              str += String.fromCharCode(slice[k]);
            }
          }
        }
      }

      const cleaned = str.replace(/\0/g, '').trim();
      if (cleaned.length > 0) {
        return cleaned;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Which face a given style asks for. The one place the two booleans become a
// slot name, so the register/lookup/export paths cannot disagree about it.
export function faceSlot({ bold = false, italic = false } = {}) {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

export function isBold(slot) {
  return slot === 'bold' || slot === 'boldItalic';
}
export function isItalic(slot) {
  return slot === 'italic' || slot === 'boldItalic';
}

// Style words as they turn up at the end of real font file names. Everything
// heavier than regular collapses onto `bold`, because a family here has exactly
// one bold slot: if someone drops both Semibold and Black, the later drop takes
// the slot. That is a worse answer than a real weight axis and a better one
// than dropping half the files on the floor.
const HEAVY = /^(bold|black|heavy|bd|bld|blk)/;
const PLAIN = /^(regular|normal)/;
const SLANT = /^(italic|oblique|ital|it)$/;

// A trailing token is a style marker only if the whole token is consumed by
// these words. "Bold" is a marker, "Blackletter" is part of a family name, and
// the difference is that the second one has something left over.
function classifyStyleToken(token) {
  const t = String(token)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!t) return null;
  if (t === 'bi') return { bold: true, italic: true };
  let rest = t.replace(/^(semi|demi|extra|ultra)/, '');
  let bold = false;
  let italic = false;
  let named = false;
  if (HEAVY.test(rest)) {
    bold = true;
    named = true;
    rest = rest.replace(HEAVY, '');
  } else if (PLAIN.test(rest)) {
    named = true;
    rest = rest.replace(PLAIN, '');
  }
  if (SLANT.test(rest)) {
    italic = true;
    named = true;
    rest = '';
  }
  if (rest || !named) return null;
  return { bold, italic };
}

function familyName(stem) {
  return stem
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A style suffix is either delimited (Foo-Bold, Foo_bold, "Foo Bold") or
// camel-attached (FooBold). Both are eaten from the right, repeatedly, so
// "Foo-Bold-Italic" and "FooBoldItalic" land in the same slot as
// "Foo-BoldItalic".
const DELIM_TAIL = /^(.*\S)[\s._-]+([A-Za-z]+)$/;
const CAMEL_TAIL = /^(.*[a-z0-9])([A-Z][a-z]+)$/;

// Filename -> which family it belongs to and which face it is. This is what
// makes dropping MangaTemple.ttf, MangaTemple-Bold.ttf, MangaTemple-Italic.ttf
// and MangaTemple-BoldItalic.ttf in one go produce one family with four faces
// instead of four unrelated fonts the letterer has to switch between by hand.
//
// The family name of a suffix-less file is deliberately identical to what this
// module produced before groups existed, so a font a user already has keeps its
// name and every saved style.font that points at it keeps resolving.
export function parseFontFilename(filename) {
  const base = String(filename).replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
  let stem = base;
  let bold = false;
  let italic = false;
  for (;;) {
    const m = stem.match(DELIM_TAIL) || stem.match(CAMEL_TAIL);
    if (!m) break;
    const kind = classifyStyleToken(m[2]);
    if (!kind) break;
    bold = bold || kind.bold;
    italic = italic || kind.italic;
    stem = m[1];
  }
  const family = familyName(stem) || familyName(base);
  return { family, slot: faceSlot({ bold, italic }) };
}

// The grouping a multi-file drop implies, without touching the store: one entry
// per family, faces filled by inference. Later files win a contested slot.
export function groupFontFiles(filenames) {
  const groups = new Map();
  for (const filename of filenames) {
    const { family, slot } = parseFontFilename(filename);
    if (!groups.has(family)) groups.set(family, { family, faces: emptyFaces() });
    groups.get(family).faces[slot] = { file: filename };
  }
  return [...groups.values()];
}

function findGroup(fontName) {
  return fontByName(fontName);
}

// ---- the fonts installed on this machine ----
// Asked of the Rust side (src-tauri/src/system_fonts.rs), which walks the OS
// font directories and reports each family with the faces it really has. No
// bytes come back: the webview draws an installed family by name, so an entry
// is the same shape as a built-in - a name, the CSS to ask for it, and the
// faces map the PSD exporter and the Font Library read.
//
// Outside Tauri there is nothing to scan and the list stays empty. The result
// replaces the list wholesale, so a font uninstalled between two scans is gone
// from it; a box set in it then draws the fallback, exactly as it would on a
// machine that never had it.
let invokeFn = null;
async function getInvoke() {
  if (invokeFn) return invokeFn;
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  const mod = await import('@tauri-apps/api/core');
  invokeFn = mod.invoke;
  return invokeFn;
}

export function systemFontEntry({ name, faces }) {
  const out = emptyFaces();
  for (const slot of FACE_SLOTS) if (faces?.[slot]) out[slot] = { file: null };
  // The generic fallback after the name is what the browser draws if the family
  // vanishes; matches the shape of a built-in's `css`.
  // Double-quoted, because installed family names carry apostrophes.
  return { name, css: `"${name.replace(/"/g, '\\"')}", sans-serif`, faces: out, system: true };
}

let scanning = null;
export function scanSystemFonts() {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      const invoke = await getInvoke();
      if (!invoke) return app.fonts.system;
      const found = await invoke('system_fonts');
      app.fonts.system = (Array.isArray(found) ? found : [])
        .filter((f) => f && typeof f.name === 'string' && f.name)
        .map(systemFontEntry);
      // Boxes set in a system font were measured against the fallback until
      // now, if the chapter opened before the scan landed.
      noteFontsChanged();
    } catch (e) {
      toast(`Could not read the system fonts - ${e?.message || e}`);
    } finally {
      scanning = null;
    }
    return app.fonts.system;
  })();
  return scanning;
}

// Which face the BROWSER will actually draw for this style, and which half of
// the style it has to synthesise to get there. Returns
// `{ slot, fauxBold, fauxItalic, known }`.
//
// Not the same question as "is there a face for this exact slot", which is what
// this used to answer and why it was wrong: CSS matches a family per axis, not
// per combination. A family with regular + bold and no italics, asked for bold
// italic, gets the real bold face with only the slant synthesised - reporting
// "no boldItalic face, so both are faux" would tell Photoshop to smear a weight
// the renderer here never smeared.
//
// The order below is CSS font matching's order, narrowed to the two axes this
// app has: slant first (an italic request prefers any italic face), then weight
// within what is left. `fauxBold` is true only when bold was asked for and the
// chosen face is not a bold one - a family that owns ONLY a bold face renders
// its regular as that bold face, heavier than asked but not synthesised, and
// the export has to name the face that was really used or Photoshop redraws a
// regular the app never showed.
//
// `known: false` means the family has no registered face at all (an unknown
// name, or a built-in the Google request never asked for); the caller decides
// what to substitute, and the faux flags then describe what a fallback family
// would have to synthesise.
export function resolveFace(fontName, style = {}) {
  const want = { bold: !!style.bold, italic: !!style.italic };
  const faces = findGroup(fontName)?.faces;
  const present = faces ? FACE_SLOTS.filter((s) => faces[s]) : [];
  if (!present.length) {
    return { slot: faceSlot(want), fauxBold: want.bold, fauxItalic: want.italic, known: false };
  }
  let pool = present.filter((s) => isItalic(s) === want.italic);
  const noSlant = pool.length === 0;
  if (noSlant) pool = present;
  const slot = pool.find((s) => isBold(s) === want.bold) ?? pool[0];
  return {
    slot,
    fauxBold: want.bold && !isBold(slot),
    fauxItalic: want.italic && !isItalic(slot),
    known: true,
  };
}

// ---- IndexedDB ----

const recordKey = (name, slot) => `${name}::${slot}`;

// v1 stored one record per font, keyed by name. v2 stores one per face, keyed
// by `name::slot`. An object store's keyPath cannot be changed in place, so the
// upgrade reads the old rows, drops the store and rebuilds it - which is safe
// only because it all happens inside the one versionchange transaction, where
// the getAll callback still runs before the transaction commits.
//
// Every v1 record becomes the regular face of a family named exactly what it
// was named before. Re-inferring the family from the filename here would be
// tidier - a user's old "MangaTemple Bold" entry really is the bold face of
// "MangaTemple" - but it would rename fonts underneath documents that already
// reference them by name, which is a worse outcome than one legacy family that
// happens to look bold.
//
// One connection for the session, not one per operation. Every call here used
// to open its own and never close it, which was survivable while the version
// never changed and became a hang the moment it did: an open at a new version
// waits for every other connection to the same database to close, and a
// connection nobody holds a reference to cannot be closed. `onversionchange`
// is the other half - it fires on THIS connection when another context wants
// to upgrade, and closing there is what lets that other one proceed instead of
// blocking on us.
//
// `onblocked` fires when the wait cannot be resolved (an older build of the app
// open in another window, which has no versionchange handler to close itself).
// A blocked request fires neither `success` nor `error`, so without this the
// promise never settles at all: the font library silently stays empty and every
// later add hangs behind it with no toast. Rejecting turns that into a message
// the user can act on.
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
        return;
      }
      if (ev.oldVersion < 2) {
        const all = req.transaction.objectStore(STORE).getAll();
        all.onsuccess = () => {
          const rows = all.result || [];
          db.deleteObjectStore(STORE);
          const next = db.createObjectStore(STORE, { keyPath: 'key' });
          for (const r of rows) {
            if (!r?.name) continue;
            next.put({ key: recordKey(r.name, 'regular'), name: r.name, slot: 'regular', file: r.file, data: r.data });
          }
        };
      }
    };
    req.onblocked = () =>
      reject(new Error('Another window of this app is holding the font library open - close it and try again'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  // A failed open must not be the answer for the rest of the session: the two
  // reasons it fails - blocked by another window, and an upgrade that aborted -
  // are both things the user can clear without reloading.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function dbPut(rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

async function dbDelete(keys) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const k of keys) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- registration ----

// Faces this session has handed to document.fonts, so a single one can be taken
// back out again. FontFaceSet.delete needs the object that was added, and the
// set itself is not indexable by family+descriptors.
const registered = new Map();

// In-memory cache of PostScript names parsed from registered font file bytes,
// keyed by `family::slot`.
const parsedPostScriptNames = new Map();

export function postScriptNameFor(family, slot) {
  return parsedPostScriptNames.get(recordKey(family, slot)) || null;
}

export function _setPostScriptNameFor(family, slot, name) {
  const key = recordKey(family, slot);
  if (name) parsedPostScriptNames.set(key, name);
  else parsedPostScriptNames.delete(key);
}

export function _clearPostScriptNames() {
  parsedPostScriptNames.clear();
}

function unregisterFace(family, slot) {
  const key = recordKey(family, slot);
  parsedPostScriptNames.delete(key);
  const face = registered.get(key);
  if (!face) return;
  try {
    document.fonts.delete(face);
  } catch {
    /* already gone */
  }
  registered.delete(key);
}

async function registerFace(family, data, slot) {
  const desc = {};
  if (isBold(slot)) desc.weight = '700';
  if (isItalic(slot)) desc.style = 'italic';
  const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  const psName = parsePostScriptName(buf);
  const face = new FontFace(family, buf, desc);
  await face.load();
  unregisterFace(family, slot); // replacing a face: out with the old one first
  if (psName) {
    parsedPostScriptNames.set(recordKey(family, slot), psName);
  }
  document.fonts.add(face);
  registered.set(recordKey(family, slot), face);
  return face;
}

// ---- store plumbing ----

function putGroupFace(family, slot, file) {
  let g = app.fonts.user.find((f) => f.name === family);
  if (!g) {
    g = { name: family, css: `'${family}'`, real: true, faces: emptyFaces() };
    app.fonts.user.push(g);
  }
  if (!g.faces) g.faces = emptyFaces();
  g.faces[slot] = { file };
}

// Restore font records into the session, skipping any family+slot already registered.
export async function _restoreFontRecords(records) {
  for (const rec of records) {
    const slot = FACE_SLOTS.includes(rec.slot) ? rec.slot : 'regular';
    // The same guard `addFontFile` applies. A record predating the built-in of
    // that name would otherwise put a second entry with the same name in both
    // font menus, and `findGroup` - built-ins first - would then answer for the
    // wrong one.
    if (app.fonts.builtin.some((f) => f.name === rec.name)) continue;

    // Skip restore for a family+slot already registered this session (e.g. if the user
    // added or replaced a face while restore was in flight).
    if (registered.has(recordKey(rec.name, slot)) || app.fonts.user.find((f) => f.name === rec.name)?.faces?.[slot]) {
      continue;
    }

    try {
      await registerFace(rec.name, rec.data, slot);
      putGroupFace(rec.name, slot, rec.file);
    } catch {
      /* skip bad font */
    }
  }
  // Once, after the whole restore rather than per face: a chapter open while
  // these arrive was laid out and measured against the fallback family, so its
  // shaped line breaks and its fitted box heights are answers to the wrong
  // metrics until something re-asks. Boxes on pages nobody has opened are
  // included - the export reaches those too. See `noteFontsChanged`.
  if (records.length) noteFontsChanged();
}

// The stored records - file name and bytes - for the named user families, for
// packaging a chapter. Built-ins have no record and come back absent. Returns
// [{ name, faces: { slot: { file, data } | null } }], one entry per family that
// has at least one face on record.
export async function userFontRecords(families) {
  if (typeof indexedDB === 'undefined' || !families?.length) return [];
  const want = new Set(families);
  const records = await dbGetAll();
  const byFamily = new Map();
  for (const rec of records) {
    if (!want.has(rec?.name) || !rec.data) continue;
    const slot = FACE_SLOTS.includes(rec.slot) ? rec.slot : 'regular';
    let g = byFamily.get(rec.name);
    if (!g) {
      g = { name: rec.name, faces: emptyFaces() };
      byFamily.set(rec.name, g);
    }
    g.faces[slot] = { file: rec.file, data: rec.data };
  }
  return [...byFamily.values()];
}

// Put a face from a chapter package into the library, but only into an empty
// slot: a face the user already has for this family+slot is theirs and is never
// replaced by one that arrived in somebody else's chapter. Returns 'installed',
// 'present' (slot already filled), 'builtin' (family is a built-in) or 'failed'.
export async function installFontFace({ family, slot, file, data }) {
  if (!family || !FACE_SLOTS.includes(slot) || !data) return 'failed';
  if (app.fonts.builtin.some((f) => f.name === family)) return 'builtin';
  if (app.fonts.user.find((f) => f.name === family)?.faces?.[slot]) return 'present';
  let buf;
  try {
    buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    await registerFace(family, buf, slot);
  } catch {
    return 'failed';
  }
  putGroupFace(family, slot, file);
  noteFontsChanged();
  try {
    await dbPut({ key: recordKey(family, slot), name: family, slot, file, data: buf });
  } catch (e) {
    toast(`"${family}" loaded but could not be saved - ${e?.message || e}`);
  }
  return 'installed';
}

// Restore persisted user fonts on startup.
export async function restoreFonts() {
  if (typeof indexedDB === 'undefined') return;
  let records = [];
  try {
    records = await dbGetAll();
  } catch (e) {
    // Said out loud rather than swallowed. The library coming up empty is
    // indistinguishable from having no fonts, and the two reasons this throws -
    // another window holding the database open, and an upgrade that aborted -
    // are both things the user can act on once they know.
    toast(`Font library unavailable - ${e?.message || e}`);
    return;
  }
  await _restoreFontRecords(records);
}

// Add one file (.ttf/.otf/.woff2). Family and face are read off the filename
// unless `target` names them, which is how the Font Library lets the user drop
// a file into a slot the guesser would not have chosen.
export async function addFontFile(file, target = null) {
  const inferred = parseFontFilename(file.name);
  const family = target?.family || inferred.family;
  const slot = target?.slot || inferred.slot;
  if (!family) {
    toast(`Could not read a font name from "${file.name}"`);
    return false;
  }
  if (app.fonts.builtin.some((f) => f.name === family)) {
    toast(`"${family}" is a built-in font`);
    return false;
  }
  const current = app.fonts.user.find((f) => f.name === family)?.faces?.[slot];
  if (current && current.file === file.name) {
    toast(`"${family}" already has this ${SLOT_LABEL[slot].toLowerCase()} face`);
    return null;
  }
  let buf;
  try {
    buf = await file.arrayBuffer();
    await registerFace(family, buf, slot);
  } catch {
    toast(`Could not load "${file.name}": unsupported or corrupt`);
    return null;
  }
  putGroupFace(family, slot, file.name);
  // A face the user adds mid-session is the same event as one restored at boot:
  // any box already using this family was measured without it.
  noteFontsChanged();
  try {
    await dbPut({ key: recordKey(family, slot), name: family, slot, file: file.name, data: buf });
  } catch (e) {
    // The face is loaded and usable for this session - it is the persistence
    // that failed - so this is a warning and not a rejection. Reported
    // separately from the load failure above because the two ask the user for
    // completely different things.
    toast(`"${family}" loaded but could not be saved - ${e?.message || e}`);
  }
  return { family, slot };
}

// The drop/browse entry point. One toast for the whole drop rather than one per
// file, since the point of grouping is that four files are one font.
export async function addFontFiles(files) {
  // Faces, not files. Two files can infer the same family and slot -
  // `Wildwords.ttf` beside `Wildwords-Regular.ttf` is a common foundry pairing
  // - and the second overwrites the first, so counting files claimed a face the
  // library card underneath would not show.
  const added = new Map();
  for (const f of [...files]) {
    const r = await addFontFile(f);
    if (r) added.set(recordKey(r.family, r.slot), r.family);
  }
  if (!added.size) return; // whatever went wrong already said so
  const families = [...new Set(added.values())];
  if (families.length === 1) {
    toast(added.size === 1 ? `Added font "${families[0]}"` : `Added "${families[0]}" - ${added.size} faces`);
  } else {
    toast(`Added ${added.size} faces across ${families.length} fonts`);
  }
}

// Drop a single face. The family goes with it when that was its last one -
// an entry with no real face at all would offer the letterer a font that
// renders as nothing but the fallback.
export async function removeFontFace(name, slot) {
  const g = app.fonts.user.find((f) => f.name === name);
  if (!g) return;
  if (g.faces) g.faces[slot] = null;
  unregisterFace(name, slot);
  try {
    await dbDelete([recordKey(name, slot)]);
  } catch {
    /* ignore */
  }
  // Losing a face changes metrics as much as gaining one: every box on that
  // family now matches against what is left, or against the fallback.
  noteFontsChanged();
  if (!g.faces || !FACE_SLOTS.some((s) => g.faces[s])) {
    app.fonts.user = app.fonts.user.filter((f) => f.name !== name);
    toast('Font removed');
  } else {
    toast(`${SLOT_LABEL[slot]} face removed`);
  }
}

export async function removeUserFont(name) {
  app.fonts.user = app.fonts.user.filter((f) => f.name !== name);
  for (const slot of FACE_SLOTS) unregisterFace(name, slot);
  noteFontsChanged(); // see removeFontFace
  try {
    await dbDelete(FACE_SLOTS.map((s) => recordKey(name, s)));
  } catch {
    /* ignore */
  }
  toast('Font removed');
}
