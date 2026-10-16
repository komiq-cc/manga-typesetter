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
import { createEngine, SYNTH_BOLD, SYNTH_OBLIQUE, CHAIN_SHIFT, RULES } from '../../../text-engine/js/engine.mjs';
import { addInstance, instancesSupported } from '../../../text-engine/js/instance.mjs';
import { lineFonts, lineFontsSupported } from '../../../text-engine/js/line-fonts.mjs';
import { FACE_SLOTS } from '../data.js';
import { fontBytesHash } from './font-identity.js';

const ITALIC_SLOTS = new Set(['italic', 'boldItalic']);
const BOLD_SLOTS = new Set(['bold', 'boldItalic']);
// A handle is kept per face key, and a key holds the size: a long session
// zooming through sizes must not grow the table without bound.
const HANDLES_MAX = 4096;

// The rule choices that are switches (text-engine/RULES.md), and the value
// each has unless a caller says otherwise. `boldAdvance` is the user's choice
// (2026-10-08): a synthesised bold is as wide as macOS has always set it.
export const DEFAULT_RULES = Object.freeze({ boldAdvance: 'webkit', fontBox: 'browser', inkBaseline: 'include' });
// Rules the adapter applies itself, to what the engine answered.
const ADAPTER_RULES = { inkBaseline: ['exact', 'include'] };

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

// A VARIABLE FONT WITH A WEIGHT AXIS is every weight in one file, and the app
// asks for two: regular and bold, 400 and 700 as CSS counts them. The face is
// drawn at the weight asked, brought into the axis' range - not at wherever
// the file's axes happen to start (SF Compact starts at 1000), and not as its
// regular smeared when a bold is asked and the font can draw a real one.
//
// What is left to synthesise is what CSS leaves: a bold asked of an axis
// that stops short of 600 is the axis' heaviest, emboldened.
//
// A face in a BOLD slot is drawn at 700 whatever is asked, as the browser
// draws a face registered with `weight: 700` (fonts.js) - that is the slot's
// meaning, and a family with only that face shows its regular as it.
//
// Only an axis on the CSS scale counts: old GX fonts (Skia) have a `wght`
// that runs 0.48 to 3.2, which means nothing here.
const WEIGHT = { regular: 400, bold: 700 };
const SYNTH_BOLD_BELOW = 600;
export function weightOnAxis(axis, bold, slot) {
  if (!axis || !(axis.min >= 1 && axis.max <= 1000 && axis.max >= 100)) return null;
  const asked = bold || BOLD_SLOTS.has(slot) ? WEIGHT.bold : WEIGHT.regular;
  const wght = Math.min(axis.max, Math.max(axis.min, asked));
  return { wght, fauxBold: bold && wght < SYNTH_BOLD_BELOW };
}

/**
 * @param {BufferSource | WebAssembly.Module} source mt_text.wasm, as bytes or compiled
 * @param {{ rules?: { boldAdvance?: 'unchanged' | 'webkit', fontBox?: 'browser' | 'skia' } }} [options]
 */
export async function createRustTextEngine(source, options = {}) {
  const low = await createEngine(source);
  // family -> { regular, bold, italic, boldItalic }: engine font ids, 0 = absent
  const families = new Map();
  // face.key -> the resolved engine face; emptied whenever the faces change
  const handles = new Map();
  const listeners = new Set();
  // Font id is reusable. PSD fallback identity instead follows the file's
  // bytes, collection index and actual clamped variable place, not the id.
  const fontSources = new Map();
  let postScriptNames = null;
  // Families a letter is looked for in when the face lacks it, in order, and
  // the engine chain built from them for each weight and slant asked.
  let fallbacks = [];
  // (how many of the fallback families, counted from the front) x (weight and
  // slant) -> the engine chain made of them. Measuring uses all of them; a
  // shorter one answers "which letters does the face lack before the n-th
  // family is asked" (`missing`).
  const chains = new Map();
  const rules = { ...DEFAULT_RULES };

  // Every measurement a caller kept may be stale after this.
  function changed() {
    postScriptNames = null;
    for (const chain of chains.values()) low.chainFree(chain);
    chains.clear();
    handles.clear();
    for (const cb of [...listeners]) cb();
  }

  function applyRules(next) {
    for (const [name, value] of Object.entries(next ?? {})) {
      if (ADAPTER_RULES[name]) {
        if (!ADAPTER_RULES[name].includes(value)) throw new Error(`text engine: unknown rule ${name}=${value}`);
      } else {
        if (!RULES[name] || !(value in RULES[name].values)) throw new Error(`text engine: unknown rule ${name}=${value}`);
        low.setRule(name, value);
      }
      rules[name] = value;
    }
  }
  // The defaults too: the engine's own are not all the app's.
  applyRules({ ...DEFAULT_RULES, ...options.rules });

  const present = (fam) => FACE_SLOTS.filter((s) => fam[s]);

  // Variable fonts (see `weightOnAxis`). A slot holds the font as its file
  // starts it; the weights it is drawn at are fonts of their own to the
  // engine, made the first time one is asked for and gone with the slot's.
  const canInstance = instancesSupported(low);
  // slot font -> its `wght` axis, or null; slot font -> weight -> engine font
  const weightAxes = new Map();
  const instances = new Map();
  function weightAxis(font) {
    let axis = weightAxes.get(font);
    if (axis === undefined) {
      axis = (canInstance && low.fontInfo(font).axes.find((a) => a.tag === 'wght')) || null;
      weightAxes.set(font, axis);
    }
    return axis;
  }
  // The font a slot's face is drawn from for this weight, and whether it is
  // emboldened: the slot's own font and what `matchSlot` said, unless the
  // font has a weight axis.
  function weighted(font, slot, bold, fauxBold) {
    const axis = weightAxis(font);
    const at = weightOnAxis(axis, bold, slot);
    if (!at) return { font, fauxBold };
    if (at.wght === axis.default) return { font, fauxBold: at.fauxBold };
    let made = instances.get(font);
    if (!made) instances.set(font, (made = new Map()));
    if (!made.has(at.wght)) {
      const instance = addInstance(low, font, { wght: at.wght });
      made.set(at.wght, instance);
      const source = fontSources.get(font);
      fontSources.set(instance, { ...source, location: [['wght', Math.fround(at.wght)]] });
      postScriptNames = null;
    }
    return { font: made.get(at.wght), fauxBold: at.fauxBold };
  }
  // Called for a slot's font when it goes, after `changed()`: nothing names
  // the instances by then.
  function forgetWeights(font) {
    weightAxes.delete(font);
    for (const instance of instances.get(font)?.values() ?? []) {
      low.removeFont(instance);
      fontSources.delete(instance);
    }
    instances.delete(font);
  }

  // The face one family of the fallback list lends to a request of this
  // weight and slant, and what is synthesised of it: the one statement of
  // that, for the chain that is measured and drawn from (`chainFor`) and for
  // whoever has to name the face afterwards (`lenders`).
  function lend({ family, first }, bold, italic) {
    const fam = families.get(family);
    const slots = present(fam);
    const { slot, fauxBold, fauxItalic } = first
      ? { slot: slots[0], fauxBold: bold && !BOLD_SLOTS.has(slots[0]), fauxItalic: italic && !ITALIC_SLOTS.has(slots[0]) }
      : matchSlot(slots, bold, italic);
    return { family, slot, ...weighted(fam[slot], slot, bold, fauxBold), fauxItalic };
  }

  // The chain is the same for every family asked in one weight and slant.
  // A fallback family answers with the face CSS would pick from it, so a
  // bold line borrows a bold letter where the fallback has one - unless it
  // was listed to lend by its first face (`setFallbacks`), and then it is
  // that face whatever is asked, emboldened and slanted here.
  function chainFor(bold, italic, depth = Infinity) {
    const count = Math.max(0, Math.min(fallbacks.length, depth));
    const at = count * 4 + ((bold ? 1 : 0) | (italic ? 2 : 0));
    const have = chains.get(at);
    if (have !== undefined) return have;
    const lenders = fallbacks.slice(0, count).filter((f) => families.has(f.family));
    // 0 is "no chain" to the engine: the face answers alone.
    let chain = 0;
    if (lenders.length) {
      chain = low.chainNew();
      for (const lender of lenders) {
        const { font, fauxBold, fauxItalic } = lend(lender, bold, italic);
        low.chainPush(chain, font, { bold: fauxBold, italic: fauxItalic });
      }
    }
    chains.set(at, chain);
    return chain;
  }

  function build(face) {
    const fam = families.get(face.name);
    if (!fam) {
      throw new Error(`text engine: font '${face.name}' is not registered, so '${face.key}' cannot be measured`);
    }
    const bold = !!face.bold;
    const italic = !!face.italic;
    const { slot, fauxBold: smeared, fauxItalic } = matchSlot(present(fam), bold, italic);
    const { font, fauxBold } = weighted(fam[slot], slot, bold, smeared);
    return {
      name: face.name, bold, italic, slot,
      // The three fields the low-level loader reads.
      font, size: face.size,
      flags: (fauxBold ? SYNTH_BOLD : 0) | (fauxItalic ? SYNTH_OBLIQUE : 0) | (chainFor(bold, italic) << CHAIN_SHIFT),
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

  function checkFace(family, slot) {
    if (typeof family !== 'string' || !family) throw new Error('text engine: a face needs a family name');
    if (!FACE_SLOTS.includes(slot)) throw new Error(`text engine: unknown face slot '${slot}'`);
  }

  // Which font file an engine font was read from, for the files that have a
  // name (`addFaces`): file id -> the engine fonts that read its one copy, and
  // back. The engine frees a file's bytes with the last font made from them,
  // so the set is the count of who still needs the copy, and any member of it
  // is a font a new face of the same file can be made beside.
  const fileFonts = new Map();
  const fontFile = new Map();
  function noteFile(font, file) {
    if (file == null) return;
    fontFile.set(font, file);
    if (!fileFonts.has(file)) fileFonts.set(file, new Set());
    fileFonts.get(file).add(font);
  }
  function removeFont(font) {
    forgetWeights(font);
    low.removeFont(font);
    fontSources.delete(font);
    const file = fontFile.get(font);
    if (file === undefined) return;
    fontFile.delete(font);
    const fonts = fileFonts.get(file);
    fonts.delete(font);
    if (!fonts.size) fileFonts.delete(file);
  }

  // `fonts` is `[[slot, engine font id], ...]`, already read by the engine.
  function put(family, fonts) {
    let fam = families.get(family);
    if (!fam) {
      fam = Object.fromEntries(FACE_SLOTS.map((s) => [s, 0]));
      families.set(family, fam);
    }
    const old = [];
    for (const [slot, font] of fonts) {
      if (fam[slot]) old.push(fam[slot]);
      fam[slot] = font;
    }
    // Chains name fonts by id: drop them before the font they name goes.
    changed();
    for (const font of old) removeFont(font);
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
      const ink = low.lineInk(resolve(face), text);
      // RULES.md rule 4: a line's ink box reaches its baseline, as WebKit's
      // does. A line drawn wholly above the baseline would otherwise report a
      // negative descent, which `blockInk` in measure.js takes for "no ink
      // metrics" and answers by not centring the whole block on its ink.
      if (rules.inkBaseline === 'include') {
        if (ink.ascent < 0) ink.ascent = 0;
        if (ink.descent < 0) ink.descent = 0;
      }
      return ink;
    },
    glyphInk(face, text) {
      return low.glyphInk(resolve(face), text);
    },
    // `lineHeight` and `align` do not move a break; they are part of the seam
    // because the DOM breaker needed them to build its element.
    wrapPlain(face, text, opts) {
      const out = lineStrings(text, low.wrapPlain(resolve(face), text, { width: Math.max(1, opts.width), letterSpacing: Number(opts.letterSpacing) || 0 }));
      return out.length ? out : [''];
    },
    /**
     * Where a caret stands on a line the painter draws: `{ at, x, length,
     * advance }`, the UTF-16 offset and the pen of every cluster of `text`,
     * from the painter's own shaping (text-engine/js/engine.mjs). For the
     * same face, text and letter spacing a job's run is painted with. Absent
     * on a wasm built before the export existed: a caller asks first.
     */
    lineCarets: low.hasLineCarets
      ? (face, text, letterSpacing = 0) => low.lineCarets(resolve(face), text, Number(letterSpacing) || 0)
      : undefined,
    /**
     * SFX lettering (sfx.js): `sfxLayout(face, rows, params)` places every
     * letter of `rows` (strings, one per row) on its own, `[{ ch, x, y, rot,
     * sx, sy, skew, w }]` in px from the block's centre, and `sfxInfo()` is the
     * engine's own table of move kinds and built-in presets. Only the Rust
     * engine has them, and only a wasm built with them: the methods are absent
     * otherwise, which is how `sfxAvailable` tells the browser engine and a
     * stale wasm from this one.
     */
    ...(typeof low.sfxLayout === 'function' && low.hasSfx !== false
      ? {
          sfxLayout: (face, rows, params) => low.sfxLayout(resolve(face), rows, params),
          sfxInfo: () => low.sfxInfo(),
        }
      : null),
    // An envelope's mesh over a box (`style.warp.pts`), from a wasm that has it.
    ...(typeof low.sfxEnvelope === 'function' && low.hasSfxEnvelope ? { sfxEnvelope: (...args) => low.sfxEnvelope(...args) } : null),
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

    /**
     * Code points of `text` that neither the face nor any fallback family has
     * a glyph for, each once, in order of first appearance.
     *
     * `depth` looks in the first `depth` fallback families only: 0 is what
     * the face itself lacks, 1 what is still lacking after the first family
     * of the list, and so on. Left out, every family is asked, which is what
     * is measured and drawn.
     */
    missing(face, text, depth = Infinity) {
      const out = [];
      let h = resolve(face);
      if (depth < fallbacks.length) {
        h = { font: h.font, size: h.size, flags: (h.flags & ((1 << CHAIN_SHIFT) - 1)) | (chainFor(h.bold, h.italic, depth) << CHAIN_SHIFT) };
      }
      for (const at of low.missing(h, text)) {
        const cp = text.codePointAt(at);
        if (!out.includes(cp)) out.push(cp);
      }
      return out;
    },

    /**
     * Registers one face of a family; `family` is the name a box's
     * `style.font` uses. A second face for the same slot replaces the first.
     * `index` picks the face inside a collection (`.ttc`); a plain font file
     * has only face 0.
     */
    addFace(family, slot, bytes, index = 0) {
      checkFace(family, slot);
      let font;
      try {
        font = low.addFont(bytes, index);
      } catch (error) {
        throw new Error(`text engine: cannot read ${family}/${slot}: ${error.message}`);
      }
      fontSources.set(font, { bytes: fontBytesHash(bytes), index: index >>> 0, location: [] });
      put(family, [[slot, font]]);
    },
    /**
     * Registers several faces of a family out of ONE file, a collection:
     * `faces` is `[{ slot, index }]`. The bytes are copied into the engine
     * once and every face reads that copy, so a system collection of tens of
     * megabytes is held once however many of its faces the family uses.
     *
     * `file` names the file, when the caller has a name for it. A file the
     * engine already holds under that name is not copied in again: the faces
     * are made beside the ones it has, whichever family those belong to, and
     * `bytes` may then be null. That is what keeps Helvetica and Helvetica
     * Neue - two families, one `.ttc` - to one copy between them. The copy
     * lives until the last face made from it is removed.
     */
    addFaces(family, bytes, faces, file = null) {
      if (!Array.isArray(faces) || !faces.length) throw new Error('text engine: a collection needs at least one face');
      for (const f of faces) checkFace(family, f.slot);
      let beside = file == null ? undefined : fileFonts.get(file)?.values().next().value;
      if (beside === undefined && !bytes) throw new Error(`text engine: the file of ${family} is not held, and no bytes came with it`);
      const sourceBytes = beside === undefined ? fontBytesHash(bytes) : fontSources.get(beside).bytes;
      const made = [];
      try {
        for (const f of faces) {
          const font = beside === undefined ? low.addFont(bytes, f.index ?? 0) : low.addSiblingFace(beside, f.index ?? 0);
          fontSources.set(font, { bytes: sourceBytes, index: (f.index ?? 0) >>> 0, location: [] });
          beside ??= font;
          made.push([f.slot, font]);
        }
      } catch (error) {
        // All or nothing: half a family would measure its bold as a smeared regular.
        for (const [, font] of made) {
          low.removeFont(font);
          fontSources.delete(font);
        }
        throw new Error(`text engine: cannot read ${family}: ${error.message}`);
      }
      for (const [, font] of made) noteFile(font, file);
      put(family, made);
    },
    /** Whether a file given under this name (`addFaces`) is still held. */
    hasFile(file) {
      return fileFonts.has(file);
    },
    /** The names of the files held, for whoever can avoid sending one again. */
    files() {
      return [...fileFonts.keys()];
    },
    /** Takes one face back out; the family goes with its last face. False when there was none. */
    removeFace(family, slot) {
      const fam = families.get(family);
      const old = fam?.[slot];
      if (!old) return false;
      fam[slot] = 0;
      if (!present(fam).length) families.delete(family);
      changed();
      removeFont(old);
      return true;
    },
    removeFamily(family) {
      const fam = families.get(family);
      if (!fam) return false;
      families.delete(family);
      changed();
      for (const slot of FACE_SLOTS) if (fam[slot]) removeFont(fam[slot]);
      return true;
    },
    hasFamily(family) {
      return families.has(family);
    },
    /** The slots a family has a real face in, in the app's slot order; empty for an unregistered family. */
    facesOf(family) {
      const fam = families.get(family);
      return fam ? present(fam) : [];
    },

    /**
     * The families a letter is looked for in when the face asked has no glyph
     * for it, most preferred first. A name that is not registered is skipped
     * until it is. With an empty list a missing letter is the face's own
     * `.notdef` box, and `missing` reports it.
     *
     * An entry is a family name, and the family then lends from the face CSS
     * matching picks for the weight and slant asked. Or it is
     * `{ family, face: 'first' }`, and the family lends from ONE face in
     * every weight and slant: its regular, or the first slot it has (the
     * app's slot order), synthesised to what is asked. That is for a family
     * somebody chose by the letters of that one face (RULES.md rule 11): its
     * bold may lack what its regular has.
     */
    setFallbacks(list) {
      if (!Array.isArray(list)) throw new Error('text engine: fallbacks are a list of family names');
      const next = new Map();
      for (const item of list) {
        const first = typeof item !== 'string';
        if (first && (typeof item?.family !== 'string' || item.face !== 'first')) throw new Error('text engine: fallbacks are a list of family names');
        const family = first ? item.family : item;
        const key = `${first ? 1 : 0}${family}`;
        if (!next.has(key)) next.set(key, { family, first });
      }
      fallbacks = [...next.values()];
      changed();
    },
    /** The families of the list by name, in its order. */
    fallbacks() {
      return fallbacks.map((f) => f.family);
    },
    /**
     * The face each family of the list lends to a request of this weight and
     * slant, in the list's order, as `{ family, slot, font, fauxBold,
     * fauxItalic }` - `font` is the engine's id of it. Null for a family that
     * is not registered, which lends nothing. Entry `n - 1` is what `missing`
     * with depth `n` adds to depth `n - 1`.
     */
    lenders(bold, italic) {
      return fallbacks.map((f) => (families.has(f.family) ? lend(f, !!bold, !!italic) : null));
    },
    /**
     * `text`, as ONE line of `face`, cut into the stretches drawn from one
     * engine font each: `[{ font, bold, italic, start, end }]`, UTF-16
     * offsets, covering the text in order. `bold` and `italic` are what is
     * synthesised of that font. These are the parts the engine measures the
     * line in and paints it in - asked, not worked out: a letter stays with
     * the lender before it when that lender has it (RULES.md rule 10), which
     * no list of missing letters shows. Null from a wasm too old to say.
     */
    lineParts(face, text) {
      return lineFontsSupported(low) ? lineFonts(low, resolve(face), text) : null;
    },

    /**
     * Changes rule switches, e.g. `{ boldAdvance: 'webkit' }` (see
     * text-engine/RULES.md), and tells the listeners: numbers measured under
     * the old rules are stale.
     */
    setRules(next) {
      applyRules(next);
      changed();
    },
    rules() {
      return { ...rules };
    },

    /** What a request resolves to: `{ slot, fauxBold, fauxItalic }`, or null for an unregistered family. */
    resolveFace(face) {
      if (!families.has(face.name)) return null;
      const h = resolve(face);
      return { slot: h.slot, fauxBold: (h.flags & SYNTH_BOLD) !== 0, fauxItalic: (h.flags & SYNTH_OBLIQUE) !== 0 };
    },
    /** The engine face a request draws with, `{ font, size, flags }`: what the low-level loader and the painter take. */
    handle(face) {
      return resolve(face);
    },
    /** Stable PSD source identity; size and faux styling do not change it. */
    sourceIdentity(font) {
      const source = fontSources.get(font);
      if (!source) throw new Error('text engine: PSD font source is not held');
      return JSON.stringify([source.bytes, source.index, source.location]);
    },
    /** All declared/generated names reachable by the app's real style requests.
     * Compute the complete set once per registration state, including variable
     * 400/700 places not requested yet: fallback names cannot depend on which
     * box is exported first. Instances share bytes and are freed with the slot.
     */
    postScriptNames() {
      if (!postScriptNames) {
        const names = new Set();
        for (const fam of families.values()) for (const slot of present(fam)) {
          const font = fam[slot];
          for (const id of new Set([font, weighted(font, slot, false, false).font, weighted(font, slot, true, false).font])) {
            const name = low.fontInfo(id).postScriptName;
            if (name) names.add(name);
          }
        }
        postScriptNames = names;
      }
      return postScriptNames;
    },
    /** The low-level engine, for tools that need font ids or raw runs. */
    low,
  };
}
