// The fonts installed on this machine, and the two answers the app's native
// side gives about them, re-made in node for the dry run.
//
// In the app the Rust text engine gets a system family's bytes from the Tauri
// command `system_font_face` and asks `system_font_coverage` which installed
// family has a letter the chosen font lacks (src-tauri/src/system_fonts.rs,
// font_coverage.rs). A dry run in node has no Tauri process, and a dry run
// that left both out would measure a missing font in nothing and a borrowed
// letter as an empty box, which is not what the app does. So this is the same
// two rules, written again from the Rust source:
//
//   the scan    every face of every font file under the OS's font folders,
//               folded by family into the four slots the app knows, the face
//               nearest to what the slot is asked for kept (`rank`);
//   coverage    each code point answered by itself, by the first family that
//               has a glyph for it in one fixed order: the OS's short list as
//               written, then every other family by its name folded to lower
//               case. A family is judged by its regular face (else the first
//               slot it has), and a face that draws in bitmaps or in colour is
//               never offered.
//
// It is a second implementation, not the first one run: where a font file is
// unusual (a style read from other tables than the three looked at here) the
// two can pick different faces. What the dry run takes from it is written into
// its output, family by family and file by file, so it can be checked against
// the app.
import { openSync, readSync, closeSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { coverage, covers } from './cmap.mjs';

export const SLOTS = ['regular', 'bold', 'italic', 'boldItalic'];
const BOLD_FROM = 600;

// `fontdb::Database::load_system_fonts` on macOS.
export const MAC_FONT_DIRS = [
  '/Library/Fonts',
  '/System/Library/Fonts',
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font7',
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font8',
  '/Network/Library/Fonts',
  join(homedir(), 'Library/Fonts'),
];

// `preferred(Os::Macos)` in font_coverage.rs.
export const MAC_PREFERRED = [
  'Helvetica', 'Lucida Grande', 'Hiragino Sans', 'Hiragino Sans GB', 'PingFang SC', 'PingFang TC', 'PingFang HK',
  'Apple SD Gothic Neo', 'Menlo', 'Apple Symbols', 'STIX Two Math',
];

function reader(path) {
  const fd = openSync(path, 'r');
  return {
    at(pos, length) {
      const out = Buffer.alloc(length);
      const got = readSync(fd, out, 0, length, pos);
      return got === length ? out : out.subarray(0, got);
    },
    close: () => closeSync(fd),
  };
}

// Where each face's table directory starts: one for a plain font, one per
// font of a collection.
function directories(file) {
  const head = file.at(0, 12);
  if (head.length < 12) return [];
  if (head.toString('latin1', 0, 4) !== 'ttcf') return [0];
  const count = head.readUInt32BE(8);
  if (count > 4096) return [];
  const offsets = file.at(12, count * 4);
  return Array.from({ length: Math.floor(offsets.length / 4) }, (_, i) => offsets.readUInt32BE(i * 4));
}

function tables(file, dir) {
  const head = file.at(dir, 12);
  if (head.length < 12) return null;
  const tag = head.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const count = head.readUInt16BE(4);
  const records = file.at(dir + 12, count * 16);
  const out = new Map();
  for (let i = 0; i + 16 <= records.length; i += 16) {
    out.set(records.toString('latin1', i, i + 4), { offset: records.readUInt32BE(i + 8), length: records.readUInt32BE(i + 12) });
  }
  return out;
}

const utf16be = (b) => {
  let out = '';
  for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode(b.readUInt16BE(i));
  return out;
};

// The family name fontdb leads with: the typographic family (16), else the
// family (1); among the Unicode records the US English one, else the first.
function familyOf(file, table) {
  if (!table || table.length < 6 || table.length > 1 << 20) return null;
  const name = file.at(table.offset, table.length);
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > name.length) break;
    const rec = {
      platform: name.readUInt16BE(at), encoding: name.readUInt16BE(at + 2), language: name.readUInt16BE(at + 4),
      id: name.readUInt16BE(at + 6), length: name.readUInt16BE(at + 8), offset: name.readUInt16BE(at + 10),
    };
    if (strings + rec.offset + rec.length <= name.length) records.push(rec);
  }
  const text = (rec) => name.subarray(strings + rec.offset, strings + rec.offset + rec.length);
  for (const id of [16, 1]) {
    const unicode = records.filter((r) => r.id === id && (r.platform === 0 || (r.platform === 3 && (r.encoding === 1 || r.encoding === 10))));
    const found = unicode.map((r) => ({ name: utf16be(text(r)), english: r.platform === 3 && r.language === 0x0409 }));
    if (!found.some((f) => f.english)) {
      for (const r of records) if (r.id === id && r.platform === 1 && r.encoding === 0 && r.language === 0) found.push({ name: text(r).toString('latin1'), english: true });
    }
    if (!found.length) continue;
    return (found.find((f) => f.english) ?? found[0]).name;
  }
  return null;
}

// Weight, width and slant, from OS/2 (and `post` for a slant the flags do
// not state), as ttf-parser reads them for fontdb.
function styleOf(file, t) {
  let weight = 400;
  let stretch = 5;
  let italic = false;
  let oblique = false;
  const os2 = t.get('OS/2');
  if (os2 && os2.length >= 64) {
    const b = file.at(os2.offset, 64);
    weight = b.readUInt16BE(4) || 400;
    stretch = b.readUInt16BE(6);
    if (stretch < 1 || stretch > 9) stretch = 5;
    const selection = b.readUInt16BE(62);
    italic = !!(selection & 1);
    oblique = !italic && b.readUInt16BE(0) >= 4 && !!(selection & 0x200);
  }
  const post = t.get('post');
  if (!italic && !oblique && post && post.length >= 8 && file.at(post.offset + 4, 4).readInt32BE(0) !== 0) oblique = true;
  return { weight, stretch, italic, oblique };
}

const slotOf = (weight, italic) => (weight >= BOLD_FROM ? 1 : 0) + (italic ? 2 : 0);

// `rank` in system_fonts.rs: how far a face is from the one CSS matching picks
// for its slot. Lower is nearer.
function rank(weight, italic, oblique, stretch) {
  const width = stretch === 5 ? 0 : stretch < 5 ? 5 - stretch : 10 + (stretch - 5);
  const slant = italic && oblique ? 1 : 0;
  let heft;
  if (weight >= BOLD_FROM) heft = weight >= 700 ? weight - 700 : 1000 + (700 - weight);
  else if (weight >= 400 && weight <= 500) heft = weight - 400;
  else if (weight < 400) heft = 200 + (400 - weight);
  else heft = 1000 + weight;
  return width * 1_000_000 + slant * 100_000 + heft;
}

function fontFiles(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) fontFiles(path, out);
    else if (['.ttf', '.otf', '.ttc', '.otc'].includes(extname(name).toLowerCase())) out.push(path);
  }
  return out;
}

/**
 * Every installed family with the file and face behind each of its slots.
 * @returns {Map<string, ({ path: string, index: number, rank: number } | null)[]>}
 */
export function scanInstalled(dirs = MAC_FONT_DIRS) {
  const index = new Map();
  for (const path of dirs.flatMap((d) => fontFiles(d))) {
    let file;
    try {
      file = reader(path);
    } catch {
      continue;
    }
    try {
      directories(file).forEach((dir, face) => {
        const t = tables(file, dir);
        if (!t) return;
        const family = familyOf(file, t.get('name'));
        // A name that begins with a dot is the OS's own UI face (`listed`).
        if (!family || family.startsWith('.')) return;
        const s = styleOf(file, t);
        const slanted = s.italic || s.oblique;
        const found = { path, index: face, rank: rank(s.weight, slanted, s.oblique, s.stretch) };
        if (!index.has(family)) index.set(family, [null, null, null, null]);
        const slots = index.get(family);
        const slot = slotOf(s.weight, slanted);
        const have = slots[slot];
        const better = !have || found.rank < have.rank || (found.rank === have.rank && (found.path < have.path || (found.path === have.path && found.index < have.index)));
        if (better) slots[slot] = found;
      });
    } catch {
      // A file that cannot be read is a font the machine does not have.
    } finally {
      file.close();
    }
  }
  return index;
}

/** The scan as the frontend's list has it: names, and which faces are real. */
export function systemList(index) {
  return [...index].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, slots]) => ({
    name,
    faces: Object.fromEntries(SLOTS.map((slot, i) => [slot, !!slots[i]])),
    stamp: slots.map((s) => (s ? `${s.path}#${s.index}` : '-')).join('|'),
  }));
}

// `order_key` in font_coverage.rs.
function orderKey(family, preferred) {
  const at = preferred.indexOf(family);
  return at >= 0 ? `0${String(at).padStart(4, '0')}` : `1${family.toLowerCase()}\u0001${family}`;
}
const byCodePoint = (a, b) => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};

// What one face covers, read from its `cmap` alone; null for a face that
// draws pictures or cannot be read.
function faceCoverage(found) {
  const file = reader(found.path);
  try {
    const dir = directories(file)[found.index];
    const t = dir === undefined ? null : tables(file, dir);
    if (!t) return null;
    if (['sbix', 'CBDT', 'SVG ', 'COLR'].some((tag) => t.has(tag))) return null;
    const cmap = t.get('cmap');
    if (!cmap || cmap.length > 4 * 1024 * 1024) return null;
    // The reader takes a whole font: a directory of one table, then the table.
    const bytes = Buffer.alloc(28 + cmap.length);
    bytes.writeUInt32BE(0x00010000, 0);
    bytes.writeUInt16BE(1, 4);
    bytes.write('cmap', 12, 'latin1');
    bytes.writeUInt32BE(28, 20);
    bytes.writeUInt32BE(cmap.length, 24);
    file.at(cmap.offset, cmap.length).copy(bytes, 28);
    return coverage(bytes).ranges;
  } catch {
    return null;
  } finally {
    file.close();
  }
}

/**
 * The two commands, answering as the native side does (`readSystemFace` in
 * src/lib/text-engine/font-sync.js reads the first one's answer).
 * @param {ReturnType<typeof scanInstalled>} index
 * @param {{ preferred?: string[] }} [options]
 */
export function nativeStandIn(index, { preferred = MAC_PREFERRED } = {}) {
  const ordered = [...index.keys()].map((name) => [orderKey(name, preferred), name]).sort((a, b) => byCodePoint(a[0], b[0]));
  const judged = new Map();
  const covering = (name) => {
    if (!judged.has(name)) {
      const slots = index.get(name);
      const face = slots[0] ?? slots.find(Boolean);
      judged.set(name, face ? faceCoverage(face) : null);
    }
    return judged.get(name);
  };
  const ids = new Map();
  const idOf = (path) => {
    if (!ids.has(path)) ids.set(path, (ids.size + 1).toString(16).padStart(16, '0'));
    return ids.get(path);
  };
  // What was handed over, for the run's record: family -> slot -> file and face.
  const served = new Map();
  const asked = new Map();
  return {
    served,
    asked,
    systemFace(family, slot, known = []) {
      const slots = index.get(family);
      const want = SLOTS.indexOf(slot);
      const found = slots?.[want];
      if (!found) throw new Error(`no font called '${family}' is installed on this computer`);
      const id = idOf(found.path);
      const send = !known.includes(id);
      const bytes = readFileSync(found.path);
      const out = new Uint8Array(40 + (send ? bytes.byteLength : 0));
      const view = new DataView(out.buffer);
      view.setUint32(0, 2, true);
      // Every slot of the family that lives in this same file crosses with it.
      SLOTS.forEach((_, i) => view.setInt32(4 + i * 4, slots[i]?.path === found.path ? slots[i].index : -1, true));
      for (let i = 0; i < 8; i++) out[20 + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
      view.setBigUint64(28, BigInt(bytes.byteLength), true);
      view.setUint32(36, send ? 1 : 0, true);
      if (send) out.set(bytes, 40);
      if (!served.has(family)) served.set(family, {});
      SLOTS.forEach((s, i) => {
        if (slots[i]?.path === found.path) served.get(family)[s] = `${found.path}#${slots[i].index}`;
      });
      return out.buffer;
    },
    systemCoverage(codePoints) {
      const families = new Map();
      const none = [];
      for (const cp of codePoints) {
        const hit = ordered.find(([, name]) => {
          const ranges = covering(name);
          return ranges && covers(ranges, cp);
        });
        asked.set(cp, hit ? hit[1] : null);
        if (!hit) {
          none.push(cp);
          continue;
        }
        if (!families.has(hit[1])) families.set(hit[1], { name: hit[1], order: hit[0], codePoints: [] });
        families.get(hit[1]).codePoints.push(cp);
      }
      return { families: [...families.values()], none };
    },
  };
}
