// ===== App preferences =====
// Preferences that belong to the person, not to a document: they survive a
// chapter close and are never written into a saved file - the typesetting beta,
// the defaults a new text box is born with, and the keyboard rebindings. The
// shape is one `$state` object, one localStorage key holding all of it, and a
// single setter, so a preference can never be changed without being persisted
// and applied in the same breath.
//
// The module APPLIES on import, not on some `initPrefs()` call, because what it
// gates is the layout engine and layout runs the moment a page mounts.
// App.svelte imports it at boot for exactly that reason: by the time anything
// measures a line, `setTypesetEnabled` has already been told.
//
// Both consumers are leaves or near-leaves and neither imports this module back,
// which is what keeps that import-time apply safe: nothing here can run before
// the module it is writing into has finished evaluating.
import { setTypesetEnabled } from './measure.js';
import { setBoxDefaults } from './data.js';
import { relayoutAll, app, setTool, setBrushToolAllowed } from './store.svelte.js';
import { normalizeOcrModels } from './ocr-models.js';

const KEY = 'mt.prefs';

export const prefs = $state({
  // The shaped line breaking / hyphenation / balloon fitting engine. Beta, and
  // off until the user says otherwise - see the TYPESETTING section in Settings.
  typeset: false,
  // The brush drawing tool (work in progress). Off by default until ready.
  brushTool: false,
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
  // Boolean here, `'auto' | 'off'` on the style - the style's third state was
  // never reachable from any switch, and a preference with two values should
  // not pretend otherwise. `applyBoxDefaults` does the translation.
  defaultShape: true,
  defaultHyphenate: true,
  defaultBalloon: true,
  defaultMinOrphan: 3,
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
});

// The two font lists are string arrays; anything else in them is dropped.
const NAME_LIST_KEYS = ['hiddenBuiltinFonts', 'shownSystemFonts'];
const cleanNames = (v) =>
  Array.isArray(v) ? [...new Set(v.filter((n) => typeof n === 'string' && n.trim()))] : null;

// The box defaults, split by what a value of theirs may be. Named once so the
// setter's validation and the loader's validation cannot drift apart.
const BOOL_KEYS = ['typeset', 'defaultAutoHeight', 'defaultShape', 'defaultHyphenate', 'defaultBalloon', 'brushTool'];
const NUM_KEYS = { defaultMinOrphan: [1, 8] };

// Push the box defaults to where a box is actually born. The store seeds a new
// box's style through `applyBoxDefaults` in data.js, and data.js is a leaf - it
// imports nothing - so it cannot read `prefs` itself. This is the same shape as
// `setTypesetEnabled` right below: the preference is stored here and MIRRORED
// into the module that consumes it, by the one function that is allowed to write
// a preference, so the copy can never be a version behind.
function applyBoxDefaults() {
  setBoxDefaults({
    autoHeight: prefs.defaultAutoHeight,
    // Boolean here, `'auto' | 'off'` on the style - the translation happens once,
    // at the edge, so nothing downstream has to know the preference is narrower.
    shape: prefs.defaultShape ? 'auto' : 'off',
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
        defaultHyphenate: prefs.defaultHyphenate,
        defaultBalloon: prefs.defaultBalloon,
        defaultMinOrphan: prefs.defaultMinOrphan,
        brushTool: prefs.brushTool,
        shortcuts: $state.snapshot(prefs.shortcuts),
        hiddenBuiltinFonts: $state.snapshot(prefs.hiddenBuiltinFonts),
        shownSystemFonts: $state.snapshot(prefs.shownSystemFonts),
        ocrModels: $state.snapshot(prefs.ocrModels),
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
  }
  prefs[key] = value;
  // Applying is part of setting. Nothing else in the app watches `prefs`, so a
  // caller that only wrote the field would leave the engine on the old answer.
  if (key === 'typeset') {
    setTypesetEnabled(!!value);
    // The flag is read inside measure.js, which nothing reactive watches, so
    // every box on screen would keep its old line breaks until something else
    // nudged it. Re-measure the document the way a font arriving does.
    relayoutAll();
  }
  // Turning the brush tool off falls back to pan so brush mode disarms cleanly.
  if (key === 'brushTool') {
    setBrushToolAllowed(!!value);
    if (!value && app.tool === 'brush') {
      setTool('pan');
    }
  }
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
  setTypesetEnabled(prefs.typeset);
  applyBoxDefaults();
  setBrushToolAllowed(prefs.brushTool);
}

load();
