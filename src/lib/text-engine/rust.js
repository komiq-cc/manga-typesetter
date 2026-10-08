// The Rust text engine (text-engine/, wasm) behind the measuring-engine seam.
//
//   const engine = await createRustTextEngine(wasmBytesOrModule)
//   engine.addFace('Comic Neue', 'regular', bytes)
//   setTextEngine(engine)
//
// Instantiating is the only async step; every method of the seam is a plain
// synchronous call afterwards. text-engine/js/engine.mjs stays the low-level
// loader (font ids, raw calls); this file knows what the app calls a face.
//
// The engine measures only what was registered here. A family nobody added is
// not ready, and measuring it throws: a silent substitute would be a layout
// solved against a font nobody sees.
import { createEngine, SYNTH_BOLD, SYNTH_OBLIQUE } from '../../../text-engine/js/engine.mjs';
import { FACE_SLOTS } from '../data.js';

const ITALIC_SLOTS = new Set(['italic', 'boldItalic']);
const BOLD_SLOTS = new Set(['bold', 'boldItalic']);
// A handle is kept per face key, and a key holds the size: a long session
// zooming through sizes must not grow the table without bound.
const HANDLES_MAX = 4096;

// Which registered slot a request draws from, and what it has to synthesise:
// CSS font matching narrowed to the app's two axes, the same order as
// `resolveFace` in fonts.js. Slant first (an italic request prefers any italic
// face), then weight within what is left. A family that owns only a bold face
// renders its regular as that face, heavier than asked and not synthesised.
export function matchSlot(present, bold, italic) {
  let pool = present.filter((s) => ITALIC_SLOTS.has(s) === italic);
  if (!pool.length) pool = present;
  const slot = pool.find((s) => BOLD_SLOTS.has(s) === bold) ?? pool[0];
  return { slot, fauxBold: bold && !BOLD_SLOTS.has(slot), fauxItalic: italic && !ITALIC_SLOTS.has(slot) };
}

/**
 * @param {BufferSource | WebAssembly.Module} source mt_text.wasm, as bytes or compiled
 */
export async function createRustTextEngine(source) {
  const low = await createEngine(source);
  // family -> { regular, bold, italic, boldItalic }: engine font ids, 0 = absent
  const families = new Map();
  // face.key -> the resolved engine face; emptied whenever the faces change
  const handles = new Map();
  const listeners = new Set();

  function facesChanged() {
    handles.clear();
    for (const cb of [...listeners]) cb();
  }

  function build(face) {
    const fam = families.get(face.name);
    if (!fam) {
      throw new Error(`text engine: font '${face.name}' is not registered, so '${face.key}' cannot be measured`);
    }
    const { slot, fauxBold, fauxItalic } = matchSlot(FACE_SLOTS.filter((s) => fam[s]), !!face.bold, !!face.italic);
    return {
      name: face.name, bold: !!face.bold, italic: !!face.italic, slot,
      // The three fields the low-level loader reads.
      font: fam[slot], size: face.size, flags: (fauxBold ? SYNTH_BOLD : 0) | (fauxItalic ? SYNTH_OBLIQUE : 0),
    };
  }

  // The key is only a hash key: a hit is checked against the fields that
  // decide the answer, so nothing here depends on how the caller spells it.
  function resolve(face) {
    let h = handles.get(face.key);
    if (h !== undefined && h.name === face.name && h.size === face.size && h.bold === !!face.bold && h.italic === !!face.italic) return h;
    h = build(face);
    if (handles.size >= HANDLES_MAX) handles.clear();
    handles.set(face.key, h);
    return h;
  }

  // What the caller of the DOM breaker always got (browser.js): a line loses
  // its trailing whitespace, and a line the breaker started - not the first
  // of its paragraph - loses its leading whitespace too.
  function lineStrings(text, lines) {
    const out = [];
    for (const [a, b] of lines) {
      const raw = text.slice(a, b).replace(/\s+$/, '');
      out.push(a === 0 || text.charCodeAt(a - 1) === 10 ? raw : raw.replace(/^\s+/, ''));
    }
    return out;
  }

  return {
    id: 'rust',
    advance(face, text) {
      return low.advance(resolve(face), text);
    },
    fontBox(face) {
      return low.fontBox(resolve(face));
    },
    lineInk(face, text) {
      return low.lineInk(resolve(face), text);
    },
    glyphInk(face, text) {
      return low.glyphInk(resolve(face), text);
    },
    wrapPlain(face, text, opts) {
      const out = lineStrings(text, low.wrapPlain(resolve(face), text, { width: Math.max(1, opts.width), letterSpacing: opts.letterSpacing || 0 }));
      return out.length ? out : [''];
    },
    loading() {
      return false;
    },
    onFontsChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    faceReady(face) {
      return families.has(face.name);
    },

    /** Code points of `text` the face has no glyph for, each once, in order of first appearance. */
    missing(face, text) {
      const out = [];
      for (const at of low.missing(resolve(face), text)) {
        const cp = text.codePointAt(at);
        if (!out.includes(cp)) out.push(cp);
      }
      return out;
    },

    /**
     * Registers one face of a family; `family` is the name a box's
     * `style.font` uses. A second face for the same slot replaces the first.
     */
    addFace(family, slot, bytes) {
      if (typeof family !== 'string' || !family) throw new Error('text engine: a face needs a family name');
      if (!FACE_SLOTS.includes(slot)) throw new Error(`text engine: unknown face slot '${slot}'`);
      let font;
      try {
        font = low.addFont(bytes);
      } catch (error) {
        throw new Error(`text engine: cannot read ${family}/${slot}: ${error.message}`);
      }
      let fam = families.get(family);
      if (!fam) {
        fam = Object.fromEntries(FACE_SLOTS.map((s) => [s, 0]));
        families.set(family, fam);
      }
      if (fam[slot]) low.removeFont(fam[slot]);
      fam[slot] = font;
      facesChanged();
    },
    removeFamily(family) {
      const fam = families.get(family);
      if (!fam) return false;
      for (const slot of FACE_SLOTS) if (fam[slot]) low.removeFont(fam[slot]);
      families.delete(family);
      facesChanged();
      return true;
    },
    hasFamily(family) {
      return families.has(family);
    },
    /** What a request resolves to: `{ slot, fauxBold, fauxItalic }`, or null for an unregistered family. */
    resolveFace(face) {
      if (!families.has(face.name)) return null;
      const h = resolve(face);
      return { slot: h.slot, fauxBold: (h.flags & SYNTH_BOLD) !== 0, fauxItalic: (h.flags & SYNTH_OBLIQUE) !== 0 };
    },
    /** The low-level engine, for tools that need font ids or raw runs. */
    low,
  };
}
