// ===== App preferences =====
// Preferences that belong to the person, not to a document: they survive a
// chapter close and are never written into a saved file - the typesetting a new
// chapter starts with, the defaults a new text box is born with, and the
// keyboard rebindings. The
// shape is one `$state` object, one localStorage key holding all of it, and a
// single setter, so a preference can never be changed without being persisted
// and applied in the same breath.
//
// The module APPLIES on import, not on some `initPrefs()` call, because what it
// feeds is read the moment a box or a chapter is made. App.svelte imports it at
// boot for exactly that reason.
//
// Both consumers are leaves or near-leaves and neither imports this module back,
// which is what keeps that import-time apply safe: nothing here can run before
// the module it is writing into has finished evaluating.
import { setBoxDefaults, setTypesetDefault, setLegacyTypeset } from './data.js';
import { app, setTool, setBrushToolAllowed, setMinFontSize, setInheritBoxStyle } from './store.svelte.js';
import { normalizeOcrModels } from './ocr-models.js';
import { useTextEngine } from './engine-switch.svelte.js';

const KEY = 'mt.prefs';

// Not a preference: what this machine laid chapters out with before a chapter
// carried its own line breaker (DET-3), for the chapters that still do not.
// 'smart' only when the stored blob said `typeset: true` - the user turned the
// beta on - the first time a build with the field ran; a default never counts,
// because the default is what BRK-1 will change. Frozen from then on and saved
// in the same blob, so switching the new-chapter preference afterwards cannot
// re-break an old chapter that has not been opened (and stamped) since.
let legacyTypeset = 'plain';

export const prefs = $state({
  // The shaped line breaking / hyphenation / balloon fitting engine, for NEW
  // chapters. On by default - see the TYPESETTING section in Settings. A chapter
  // carries its own answer once it exists (`typesetting` in chapter.json, see
  // data.js), so this never re-breaks one.
  typeset: true,
  // The brush drawing tool (work in progress). Off by default until ready.
  brushTool: false,
  // Place and Text tools can start from defaults instead of the last box's style.
  inheritBoxStyle: true,
  // ---- typesetting defaults for NEW text boxes ----
  // These five are per-BOX style properties (`style.autoHeight`, `style.shape`
  // and friends - see `defaultStyle` in data.js). What lives here is only the
  // value a box is BORN with; once a box exists its own style is what answers,
  // and a bulk edit is how one is changed after the fact. The Inspector used to
  // carry a switch per box for each of them, which put five engine settings in
  // front of someone trying to move a bubble; they are one set of defaults, so
  // they are set once, here.
  //
  // Their starting values are exactly `defaultStyle()`'s, which is what makes
  // an absent key in storage indistinguishable from a fresh install.
  defaultAutoHeight: true,
  // Boolean here - shaped or plain - and the shape a shaped block aims for
  // beside it (BRK-3): `style.shape` is 'off' or one of these three, and
  // `applyBoxDefaults` does the translation.
  defaultShape: true,
  defaultBlockShape: 'auto',
  defaultHyphenate: true,
  defaultBalloon: true,
  defaultMinOrphan: 3,
  // The smallest size, in page px, the fit ladder may shrink a box's text to
  // when it does not fit (see `autoFitBox` in the store). The ladder's working
  // floor is relative - three quarters of the size the box's tag is set at - and
  // this is the absolute one under it, for a tag that is small to begin with.
  // 12: scan pages are mostly 1100-1600px wide and read fit-to-width at around
  // 700-1000 CSS px, which puts 12 page px at 7-8px on screen - the bottom of
  // what anything sets text at to be read rather than glanced at. Past that the
  // ladder would be trading an overflow it can report for text nobody can read,
  // and the flag is the better failure. No Settings control: it is a guard rail
  // for the machine, not a style anyone is choosing.
  minFontSize: 12,
  // Keyboard shortcut overrides, as { shortcutId: combo }. Only the ones the
  // user changed are in here; everything else answers to its default, so a
  // build that moves a default moves it for everyone who never rebound it.
  // The vocabulary of ids and the combo spelling both live in shortcuts.svelte.js.
  shortcuts: {},
  // ---- which fonts the menus offer ----
  // Two lists of family names, and deliberately not one list of "visible fonts":
  // a built-in is offered until the user hides it, a font installed on this
  // machine is hidden until the user shows it, so each list holds only the
  // exceptions and a fresh install has both empty. A hidden family still draws -
  // a box already set in it keeps its face - it just stops being offered. Both
  // are machine preferences, not document facts: the system list describes this
  // computer, and another machine's copy of the chapter has its own.
  hiddenBuiltinFonts: [],
  shownSystemFonts: [],
  // Recognition quality/size is a preference of this installation, separate
  // for each project language. Project files continue to store only language.
  ocrModels: normalizeOcrModels(null),
  // Who measures text: 'browser', as the app always has, or 'rust', the Rust
  // text engine on the user's own font files (engine-switch.svelte.js). Off by
  // default while the port is being checked against the browser. A machine
  // preference like the rest: it says how this computer measures, and a
  // chapter carries nothing of it.
  textEngine: 'browser',
});

// The two font lists are string arrays; anything else in them is dropped.
const NAME_LIST_KEYS = ['hiddenBuiltinFonts', 'shownSystemFonts'];
const cleanNames = (v) =>
  Array.isArray(v) ? [...new Set(v.filter((n) => typeof n === 'string' && n.trim()))] : null;

// The box defaults, split by what a value of theirs may be. Named once so the
// setter's validation and the loader's validation cannot drift apart.
const BOOL_KEYS = ['typeset', 'defaultAutoHeight', 'defaultShape', 'defaultHyphenate', 'defaultBalloon', 'brushTool', 'inheritBoxStyle'];
const NUM_KEYS = { defaultMinOrphan: [1, 8], minFontSize: [4, 48] };
const ENUM_KEYS = { defaultBlockShape: ['auto', 'oval', 'rect'], textEngine: ['browser', 'rust'] };

// Push the box defaults to where a box is actually born. The store seeds a new
// box's style through `applyBoxDefaults` in data.js, and data.js is a leaf - it
// imports nothing - so it cannot read `prefs` itself. The new-chapter
// typesetting goes the same way (`setTypesetDefault`): the preference is stored
// here and MIRRORED into the module that consumes it, by the one function that
// is allowed to write a preference, so the copy can never be a version behind.
function applyBoxDefaults() {
  setBoxDefaults({
    autoHeight: prefs.defaultAutoHeight,
    // Two preferences here, one `style.shape` - the translation happens once,
    // at the edge, so nothing downstream has to know they are two.
    shape: prefs.defaultShape ? prefs.defaultBlockShape : 'off',
    hyphenate: prefs.defaultHyphenate,
    balloon: prefs.defaultBalloon,
    minOrphan: prefs.defaultMinOrphan,
  });
}

function persist() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        typeset: prefs.typeset,
        defaultAutoHeight: prefs.defaultAutoHeight,
        defaultShape: prefs.defaultShape,
        defaultBlockShape: prefs.defaultBlockShape,
        defaultHyphenate: prefs.defaultHyphenate,
        defaultBalloon: prefs.defaultBalloon,
        defaultMinOrphan: prefs.defaultMinOrphan,
        minFontSize: prefs.minFontSize,
        brushTool: prefs.brushTool,
        inheritBoxStyle: prefs.inheritBoxStyle,
        shortcuts: $state.snapshot(prefs.shortcuts),
        hiddenBuiltinFonts: $state.snapshot(prefs.hiddenBuiltinFonts),
        shownSystemFonts: $state.snapshot(prefs.shownSystemFonts),
        ocrModels: $state.snapshot(prefs.ocrModels),
        textEngine: prefs.textEngine,
        legacyTypeset,
      }),
    );
  } catch {
    /* ignore - a preference that cannot be stored just starts at its default next launch */
  }
}

export function setPref(key, value) {
  if (!(key in prefs)) return;
  // The one non-boolean, non-numeric preference. A caller handing this anything
  // but a plain object would leave every shortcut lookup reading properties off
  // a number - and an array is an object too, but not the kind of map this is.
  if (key === 'shortcuts' && (!value || typeof value !== 'object' || Array.isArray(value))) return;
  if (key === 'ocrModels') value = normalizeOcrModels(value);
  if (NAME_LIST_KEYS.includes(key)) {
    value = cleanNames(value);
    if (!value) return;
  }
  // A number preference is stored as a number in range or not at all: a NaN from
  // a half-typed field would reach the line breaker as a threshold nothing can
  // satisfy, and it would be persisted as `null`.
  if (key in NUM_KEYS) {
    const [lo, hi] = NUM_KEYS[key];
    const n = Math.round(+value);
    if (!Number.isFinite(n)) return;
    value = Math.min(hi, Math.max(lo, n));
  } else if (BOOL_KEYS.includes(key)) {
    value = !!value;
  } else if (key in ENUM_KEYS && !ENUM_KEYS[key].includes(value)) {
    return;
  }
  prefs[key] = value;
  // Applying is part of setting. Nothing else in the app watches `prefs`, so a
  // caller that only wrote the field would leave the engine on the old answer.
  // No relayout: it is what the NEXT chapter is created with. The open one has
  // its own switch (`setChapterTypesetMode` in the store).
  if (key === 'typeset') setTypesetDefault(!!value);
  // Turning the brush tool off falls back to pan so brush mode disarms cleanly.
  if (key === 'brushTool') {
    setBrushToolAllowed(!!value);
    if (!value && app.tool === 'brush') {
      setTool('pan');
    }
  }
  // Mirrored into the store the way the box defaults are mirrored into data.js.
  // No relayout: it bounds what the next fit may do, and moves nothing already
  // on the page.
  if (key === 'minFontSize') setMinFontSize(value);
  if (key === 'inheritBoxStyle') setInheritBoxStyle(value);
  // The one preference that re-measures everything, and it does so itself:
  // the engine is swapped and every box laid out again once it is in.
  if (key === 'textEngine') useTextEngine(value);
  // No relayout for these: they are what the NEXT box is born with, and boxes
  // already on the page keep the flags they carry. Re-measuring here would be
  // re-measuring nothing.
  if (key.startsWith('default')) applyBoxDefaults();
  persist();
}

// Read whatever is on disk. Only booleans we know about are taken - a value
// written by a newer build, or a corrupt blob, leaves the defaults standing.
function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    /* ignore */
  }
  if (!saved || typeof saved !== 'object') saved = null;
  // Key by key, and only a value of the right type is taken. A build that never
  // wrote the box defaults leaves every one of them absent, and absent is the
  // fresh-install answer - which is `defaultStyle()`'s answer, so a chapter made
  // before this preference existed keeps behaving the way it did.
  for (const k of BOOL_KEYS) {
    if (saved && typeof saved[k] === 'boolean') prefs[k] = saved[k];
  }
  for (const [k, [lo, hi]] of Object.entries(NUM_KEYS)) {
    const n = saved && typeof saved[k] === 'number' ? Math.round(saved[k]) : NaN;
    if (Number.isFinite(n)) prefs[k] = Math.min(hi, Math.max(lo, n));
  }
  for (const [k, values] of Object.entries(ENUM_KEYS)) {
    if (saved && values.includes(saved[k])) prefs[k] = saved[k];
  }
  // Shortcut overrides are a string->string map and nothing else; a value of
  // any other shape is dropped rather than handed to the key matcher. What is
  // loaded here is still only shape-checked: whether an id means anything and
  // whether a combo can fire is the registry's business, and shortcuts.svelte.js
  // prunes both once its tables exist.
  if (
    saved &&
    typeof saved === 'object' &&
    saved.shortcuts &&
    typeof saved.shortcuts === 'object' &&
    !Array.isArray(saved.shortcuts)
  ) {
    const clean = {};
    for (const [id, combo] of Object.entries(saved.shortcuts)) {
      if (typeof id === 'string' && typeof combo === 'string' && combo.trim()) clean[id] = combo;
    }
    prefs.shortcuts = clean;
  }
  for (const k of NAME_LIST_KEYS) {
    const names = saved ? cleanNames(saved[k]) : null;
    if (names) prefs[k] = names;
  }
  prefs.ocrModels = normalizeOcrModels(saved?.ocrModels);
  // Read before anything this session can persist, so the blob it reads is the
  // one the last build left. Until the first write stamps it, every launch
  // derives the same answer from the same unchanged blob.
  legacyTypeset =
    saved?.legacyTypeset === 'smart' || saved?.legacyTypeset === 'plain'
      ? saved.legacyTypeset
      : saved?.typeset === true
        ? 'smart'
        : 'plain';
  setLegacyTypeset(legacyTypeset);
  setTypesetDefault(prefs.typeset);
  applyBoxDefaults();
  setMinFontSize(prefs.minFontSize);
  setBrushToolAllowed(prefs.brushTool);
  setInheritBoxStyle(prefs.inheritBoxStyle);
  // Here and not at first use: a chapter can open before anything asks, and
  // the engine has to be standing in the way of its first fit by then. A
  // no-op for 'browser', which is every install that never touched the switch.
  useTextEngine(prefs.textEngine);
}

load();
