// A stand-in for the Rust adapter (src/lib/text-engine/rust.js) for the unit
// lane, where there is no wasm: the same registry surface, and measurements
// that are plain arithmetic.
//
// Like the real one it measures only families it was given, and throws for
// any other, so a test that lets a wrong name through fails loudly. Each
// family has its own width per letter (set from its name), so a measurement
// made in the wrong family is a different number, not a coincidence.
import { FACE_SLOTS } from '../lib/data.js';

// Bytes that say what kind of file they are; nothing reads past the tag.
const tagged = (tag, fill = 7) => Uint8Array.from([...tag, fill, fill, fill, fill]);
export const SFNT = () => tagged([0x00, 0x01, 0x00, 0x00]);
export const OTF = () => tagged([0x4f, 0x54, 0x54, 0x4f]);
export const TTC = () => tagged([0x74, 0x74, 0x63, 0x66]);
export const WOFF2 = () => tagged([0x77, 0x4f, 0x46, 0x32]);
// What the fake refuses, as the engine refuses a file it cannot parse.
export const CORRUPT = () => tagged([0x00, 0x01, 0x00, 0x00], 0xff);

/** Letter width of a family, as a share of the size: stable, and different for every name used in the tests. */
export function widthOf(family) {
  let h = 0;
  for (const c of family) h = (h * 31 + c.charCodeAt(0)) % 997;
  return 0.3 + (h % 50) / 100;
}

export function fakeRustEngine() {
  // family -> { slot: { index, file } }, `file` being the bytes object handed in
  const families = new Map();
  const listeners = new Set();
  let fallbacks = [];
  const asked = [];
  const changed = () => {
    for (const cb of [...listeners]) cb();
  };
  const fam = (face) => {
    asked.push(face.name);
    if (!families.has(face.name)) throw new Error(`text engine: font '${face.name}' is not registered, so '${face.key}' cannot be measured`);
    return widthOf(face.name);
  };
  const ink = (face, text) => {
    const width = text.length * face.size * fam(face);
    return { width, left: 0, right: width, ascent: face.size * 0.7, descent: face.size * 0.2 };
  };
  const refuse = (family, bytes) => {
    if (bytes[4] === 0xff || bytes[0] === 0x77) throw new Error(`text engine: cannot read ${family}`);
  };
  const put = (family, slot, face) => {
    if (!families.has(family)) families.set(family, {});
    families.get(family)[slot] = face;
  };
  return {
    id: 'rust',
    advance: (face, text) => text.length * face.size * fam(face),
    fontBox: (face) => (fam(face), { ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    faceReady: (face) => families.has(face.name),
    missing: (face, text) => {
      fam(face);
      // Anything outside Latin-1 is a letter no fake face has.
      return [...new Set([...text].map((ch) => ch.codePointAt(0)).filter((cp) => cp > 0xff))];
    },
    addFace(family, slot, bytes, index = 0) {
      refuse(family, bytes);
      put(family, slot, { index, file: bytes });
      changed();
    },
    addFaces(family, bytes, faces) {
      refuse(family, bytes);
      for (const f of faces) put(family, f.slot, { index: f.index, file: bytes });
      changed();
    },
    removeFace(family, slot) {
      const f = families.get(family);
      if (!f?.[slot]) return false;
      delete f[slot];
      if (!Object.keys(f).length) families.delete(family);
      changed();
      return true;
    },
    removeFamily(family) {
      if (!families.delete(family)) return false;
      changed();
      return true;
    },
    hasFamily: (family) => families.has(family),
    facesOf: (family) => FACE_SLOTS.filter((s) => families.get(family)?.[s]),
    setFallbacks(names) {
      fallbacks = [...names];
      changed();
    },
    fallbacks: () => [...fallbacks],

    // For the assertions.
    families,
    /** Every family name a measurement was asked in, in order. */
    asked,
    registered: () => Object.fromEntries([...families].map(([name, f]) => [name, FACE_SLOTS.filter((s) => f[s])])),
  };
}

/**
 * A stand-in for the native side: `system_font_face` and `font_to_sfnt`.
 * `files` is { family: [{ slots: { slot: index }, bytes }] }, one entry per
 * font file the family's faces live in. Answers are held back until
 * `release()` when `hold` is set, to look at the moment in between.
 */
export function fakeNative(files = {}, { hold = false } = {}) {
  const calls = [];
  const waiting = [];
  const gate = () => (hold ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve());
  const invoke = async (cmd, args) => {
    calls.push([cmd, cmd === 'font_to_sfnt' ? 'bytes' : args]);
    await gate();
    if (cmd === 'system_font_face') {
      const file = (files[args.family] ?? []).find((f) => args.slot in f.slots);
      if (!file) throw new Error(`no system font '${args.family}'`);
      const out = new Uint8Array(16 + file.bytes.length);
      const view = new DataView(out.buffer);
      FACE_SLOTS.forEach((slot, i) => view.setInt32(i * 4, file.slots[slot] ?? -1, true));
      out.set(file.bytes, 16);
      return out.buffer;
    }
    if (cmd === 'font_to_sfnt') {
      if (args[4] === 0xff) throw new Error('not a WOFF file');
      return SFNT().buffer;
    }
    throw new Error(`unknown command ${cmd}`);
  };
  invoke.calls = calls;
  invoke.release = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  return invoke;
}
