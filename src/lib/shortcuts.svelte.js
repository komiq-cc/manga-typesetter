// ===== Keyboard shortcut registry =====
// One list of every shortcut the editor answers to, one way of writing a key
// combination down, one place that turns a KeyboardEvent into the action it
// means. Before this, the combos lived as a ladder of `if (e.key === 'v')`
// inside App.svelte's keydown handler: nothing could list them, nothing could
// rebind them, and two of them could collide without anybody noticing.
//
// A combo is a canonical string - modifiers in a fixed order, then the key:
//
//   'Mod+1'          'Mod+Shift+c'      'Mod+Alt+3'      'Delete'
//
// `Mod` is the platform's command modifier: ⌘ on a Mac, Ctrl everywhere else.
// That is the whole reason the token exists - a shortcut is written once and
// means the key a user of that platform expects. `Ctrl` (on a Mac) and `Meta`
// (off one) name the *other* one, for a user who rebinds onto it deliberately.
//
// The key half comes from `event.code` where the code names a physical key, so
// Alt combos survive macOS turning Alt+A into 'å', and Shift+1 stays '1'
// rather than becoming '!'. Named keys (Escape, Delete, ArrowLeft) keep their
// `event.key` spelling. The keypad is spelled as the keys it is - 'Numpad3',
// not the top-row '3' its legend happens to emit - so a rebind onto one never
// fires from the other.
//
// What is NOT here: Escape, Tab, and the arrow keys. All three are contextual
// rather than nominal - Escape closes whatever is topmost, Tab walks the
// selection only when focus is on the canvas, and an arrow nudges the selected
// box or turns the page depending on whether anything is selected. They are not
// actions with a combo, they are one key with several meanings, and a rebind
// screen that offered them would be lying about what it could change.
import { prefs, setPref } from './prefs.svelte.js';

// ---------- platform ----------
function detectMac() {
  if (typeof navigator === 'undefined') return false;
  const s = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(s);
}
let MAC = detectMac();
export const isMacKeyboard = () => MAC;
// Tests run under node, where there is no navigator to ask; a build running in
// a webview that misreports itself can be corrected the same way.
export function setMacKeyboard(v) {
  MAC = !!v;
}

// ---------- combo parsing ----------
// Punctuation and space, by the physical key that carries them on a US layout.
// Anything not in here falls back to `event.key`, which is right for every
// named key and acceptable for the rest.
const CODE_KEYS = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
};
// The keypad's operator keys have no punctuation spelling worth borrowing -
// their `event.key` varies by layout - so they are named by their codes.
const NUMPAD_KEYS = {
  NumpadAdd: 'NumpadAdd',
  NumpadSubtract: 'NumpadSubtract',
  NumpadMultiply: 'NumpadMultiply',
  NumpadDivide: 'NumpadDivide',
  NumpadDecimal: 'NumpadDecimal',
};
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

// The key half of a combo, as this module spells it. Null for a press that is
// only a modifier - the rebind capture uses that to keep waiting.
export function eventKeyName(e) {
  const code = e?.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  // The physical keypad, distinct from the digit row it sits beside.
  if (/^Numpad\d$/.test(code)) return code;
  const k = e?.key;
  // A dead key is waiting for its base letter; it produces no character yet,
  // and must be checked before the code table or a dead Backquote would read
  // as '`'.
  if (k === 'Dead') return null;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (NUMPAD_KEYS[code]) return NUMPAD_KEYS[code];
  if (!k) return null;
  if (MODIFIER_KEYS.has(k)) return null;
  if (k === ' ') return 'Space';
  return k.length === 1 ? k.toLowerCase() : k;
}

// A modifier set, in the one order every combo string is written in.
function join(mods, key) {
  const parts = [];
  if (mods.mod) parts.push('Mod');
  if (mods.other) parts.push(MAC ? 'Ctrl' : 'Meta');
  if (mods.alt) parts.push('Alt');
  if (mods.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

// AltGr (the right-hand Alt on Windows/Linux) reports itself as Ctrl+Alt.
// Typing one of its characters - é, µ, @ on a German layout - must never be
// read as Mod+Alt+key, or the shortcut system would eat characters people are
// typing. Only asked off a Mac, where AltGr does not exist.
export const isAltGrEvent = (e) =>
  !MAC && typeof e?.getModifierState === 'function' && e.getModifierState('AltGraph');

// The combo a keypress spells. Null when the press is only a modifier.
export function eventCombo(e) {
  const key = eventKeyName(e);
  if (key == null) return null;
  // An AltGr press drops the Mod half: it reads as plain Alt+key, which no
  // default shortcut holds, so the character reaches the page untouched.
  const altgr = isAltGrEvent(e);
  return join(
    {
      mod: altgr ? false : MAC ? !!e.metaKey : !!e.ctrlKey,
      other: MAC ? !!e.ctrlKey : !!e.metaKey,
      alt: !!e.altKey,
      shift: !!e.shiftKey,
    },
    key,
  );
}

// Every multi-character name eventKeyName can produce, spelled exactly as it
// spells them: `event.key` names for the non-printing keys, the keypad by its
// codes. Hand-written combos are matched against this case-insensitively;
// anything else is rejected rather than stored as an override that persists
// but can never fire.
const NAMED_KEYS = [
  'Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'PrintScreen', 'ScrollLock', 'Pause', 'NumLock', 'ContextMenu',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
  'NumpadDecimal', // keypad Enter reads as Enter, so it needs no name of its own
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'Space',
];
const NAMED_KEY_SPELLINGS = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

function canonKeyName(key) {
  if (key.length === 1) return key.toLowerCase();
  return NAMED_KEY_SPELLINGS.get(key.toLowerCase()) ?? null;
}

// Put a hand-written combo into canonical form so two spellings of the same
// keypress compare equal. Unknown modifier names are dropped rather than
// guessed at; an empty key half means the string was not a combo at all, and
// so is a key half no keypress can produce.
export function normalizeCombo(combo) {
  if (typeof combo !== 'string') return null;
  const raw = combo.trim();
  if (!raw) return null;
  // Split on '+' but keep a literal '+' key ('Mod++' is Mod plus the plus key).
  const bits = raw.split('+');
  if (raw.endsWith('+') && bits[bits.length - 1] === '') {
    bits.pop();
    bits[bits.length - 1] = '+';
  }
  const mods = { mod: false, other: false, alt: false, shift: false };
  let key = null;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i].trim();
    if (!b) continue;
    const low = b.toLowerCase();
    const last = i === bits.length - 1;
    if (!last || bits.length === 1) {
      if (low === 'mod' || low === 'cmdorctrl') { mods.mod = true; continue; }
      if (low === 'ctrl' || low === 'control') { MAC ? (mods.other = true) : (mods.mod = true); continue; }
      if (low === 'meta' || low === 'cmd' || low === 'command') { MAC ? (mods.mod = true) : (mods.other = true); continue; }
      if (low === 'alt' || low === 'option' || low === 'opt') { mods.alt = true; continue; }
      if (low === 'shift') { mods.shift = true; continue; }
      if (!last) return null; // an unknown modifier is not a combo we can honour
    }
    key = b.length === 1 ? b.toLowerCase() : b === ' ' ? 'Space' : b;
  }
  if (!key) return null;
  const canon = canonKeyName(key);
  if (!canon) return null;
  return join(mods, canon);
}

export const combosEqual = (a, b) => {
  const x = normalizeCombo(a);
  return !!x && x === normalizeCombo(b);
};

export const matchesCombo = (e, combo) => {
  const c = eventCombo(e);
  return !!c && c === normalizeCombo(combo);
};

// What a keypress means while a row on the settings screen waits to be
// rebound. 'pass' hands the press to the rest of the app untouched - an IME
// mid-composition, an AltGr character; swallowing those would eat text.
// 'wait' keeps waiting without swallowing (a lone modifier is the first half
// of a combo, not one). 'cancel' and 'bind' are the press doing its job and
// are stopped where they stand.
export function captureAction(e) {
  if (e.isComposing || e.keyCode === 229) return { act: 'pass' };
  const withModifier = !!e.metaKey || !!e.ctrlKey || !!e.altKey || !!e.shiftKey;
  if (!withModifier && e.key === 'Escape') return { act: 'cancel' };
  if (isAltGrEvent(e)) return { act: 'pass' };
  const combo = eventCombo(e);
  if (!combo) return { act: 'wait' };
  return { act: 'bind', combo };
}

// ---------- display ----------
const KEY_LABELS = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Enter: '↵',
  Space: 'Space',
  Tab: 'Tab',
  NumpadAdd: 'Num+',
  NumpadSubtract: 'Num−',
  NumpadMultiply: 'Num×',
  NumpadDivide: 'Num÷',
  NumpadDecimal: 'Num.',
};
for (let i = 0; i <= 9; i++) KEY_LABELS[`Numpad${i}`] = `Num${i}`;
const MOD_LABELS_MAC = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
// Off a Mac, `Mod` is Ctrl and `Meta` is the key with the vendor's logo on it.
// Both are spelled out: there is no glyph convention to lean on.
const MOD_LABELS = { Mod: 'Ctrl', Meta: 'Meta', Alt: 'Alt', Shift: 'Shift' };

// How the combo is shown to a person: ⌘⇧C on a Mac, Ctrl+Shift+C elsewhere.
export function formatCombo(combo) {
  const c = normalizeCombo(combo);
  if (!c) return '';
  const bits = c.split('+');
  const key = bits.pop();
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (MAC) return bits.map((m) => MOD_LABELS_MAC[m] ?? m).join('') + label;
  return [...bits.map((m) => MOD_LABELS[m] ?? m), label].join('+');
}

// ---------- the registry ----------
// `whenTyping` is the answer to "does this still fire while the caret is in a
// text field?". It is true only for combos that cannot be part of typing and
// whose action a letterer plainly still wants mid-sentence: switching tool,
// flipping the Inspector to another tab, straightening a box. Undo is not one
// of them - a text field runs its own undo stack - and neither is Delete, which
// would eat the box the user is writing into.
const DEFS = [
  // Tools. Cmd/Ctrl+digit rather than the bare v/t/h these used to be: see the
  // comment on dispatchShortcut for why the bare letters could not work. The
  // digits count down the tool rail in the order it draws them (place, text,
  // brush when enabled, hand) so the key and the button a user is looking at
  // agree.
  { id: 'tool.place', label: 'Paste mode (place queued line)', group: 'Modes', combo: 'Mod+1', whenTyping: true },
  { id: 'tool.text', label: 'Text mode (new box)', group: 'Modes', combo: 'Mod+2', whenTyping: true },
  { id: 'tool.brush', label: 'Brush mode (hand-letter)', group: 'Modes', combo: 'Mod+3', whenTyping: true },
  { id: 'tool.pan', label: 'Hand mode (pan)', group: 'Modes', combo: 'Mod+4', whenTyping: true },

  // Selected box. Duplicate and the style clipboard are pure Mod combos -
  // no layout produces one by typing - so they stay live in a text field.
  { id: 'box.duplicate', label: 'Duplicate box', group: 'Text box', combo: 'Mod+d', whenTyping: true },
  { id: 'box.delete', label: 'Delete box', group: 'Text box', combo: 'Delete' },
  { id: 'box.deleteAlt', label: 'Delete box (alternate)', group: 'Text box', combo: 'Backspace' },
  { id: 'box.resetRotation', label: 'Reset rotation to 0°', group: 'Text box', combo: 'Mod+0', whenTyping: true },
  { id: 'box.fitBalloon', label: 'Fit to balloon (on/off)', group: 'Text box', combo: 'Mod+Shift+f', whenTyping: true },
  // The Refit button's own key (UX-3): measure the balloon again and typeset
  // the box in it. Beside the switch above rather than on it - one turns balloon
  // layout on and off, this re-lays the box out - and Alt rather than Shift+R,
  // which a hand used to a browser presses to reload.
  { id: 'box.retypeset', label: 'Re-fit to balloon (typeset again)', group: 'Text box', combo: 'Mod+Alt+f', whenTyping: true },
  // Lock layout (FIT-5): hold the box's size, width, place and line breaks as
  // they stand, so edits and Refit keep them - and again to let every lock go.
  // A key because a box with no lock yet shows no lock chip to click. L for
  // lock, with Alt beside Refit's Mod+Alt+F; Mod+L alone is the address bar to
  // a hand used to a browser.
  { id: 'box.layoutLock', label: 'Lock layout (on/off)', group: 'Text box', combo: 'Mod+Alt+l', whenTyping: true },
  { id: 'style.copy', label: 'Copy style', group: 'Text box', combo: 'Mod+Shift+c', whenTyping: true },
  { id: 'style.paste', label: 'Paste style', group: 'Text box', combo: 'Mod+Shift+v', whenTyping: true },

  // The queue's batch placement. Mod+Shift+p rather than a bare key for the
  // reason every other shortcut here is a Mod combo: a letterer's caret is in
  // the Inspector's text field or a queue row nearly all the time, and a
  // printable key there is typing before it is anything else. The chapter-wide
  // half has no key on purpose - it writes boxes onto pages the user is not
  // looking at, which is not something a mis-typed combo should be able to do.
  { id: 'queue.placeDetected', label: 'Place detected bubbles on this page', group: 'Text queue', combo: 'Mod+Shift+p', whenTyping: true },

  // History.
  { id: 'edit.undo', label: 'Undo', group: 'History', combo: 'Mod+z' },
  { id: 'edit.redo', label: 'Redo', group: 'History', combo: 'Mod+Shift+z' },
  { id: 'edit.redoAlt', label: 'Redo (alternate)', group: 'History', combo: 'Mod+y' },

  // Inspector tabs.
  { id: 'inspector.tabNext', label: 'Next tab', group: 'Text box options', combo: 'Mod+]', whenTyping: true },
  { id: 'inspector.tabPrev', label: 'Previous tab', group: 'Text box options', combo: 'Mod+[', whenTyping: true },
  { id: 'inspector.tabText', label: 'Go to Text tab', group: 'Text box options', combo: 'Mod+Alt+1', whenTyping: true },
  { id: 'inspector.tabFill', label: 'Go to Fill tab', group: 'Text box options', combo: 'Mod+Alt+2', whenTyping: true },
  { id: 'inspector.tabEffects', label: 'Go to Effects tab', group: 'Text box options', combo: 'Mod+Alt+3', whenTyping: true },
  { id: 'inspector.tabLayout', label: 'Go to Layout tab', group: 'Text box options', combo: 'Mod+Alt+4', whenTyping: true },
];

// Defaults are canonicalised once, here, so nothing downstream has to wonder
// whether 'Mod+Shift+C' and 'Mod+Shift+c' are the same shortcut.
export const SHORTCUTS = DEFS.map((d) => ({ ...d, combo: normalizeCombo(d.combo) }));
const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export const shortcutById = (id) => BY_ID.get(id) ?? null;
export function defaultCombo(id) {
  if (id === 'tool.pan') return prefs.brushTool ? 'Mod+4' : 'Mod+3';
  return BY_ID.get(id)?.combo ?? null;
}

const activeShortcuts = () =>
  prefs.brushTool ? SHORTCUTS : SHORTCUTS.filter((s) => s.id !== 'tool.brush');

// The groups, in registry order, for the settings screen.
export function shortcutGroups() {
  const out = [];
  for (const s of activeShortcuts()) {
    let g = out.find((x) => x.name === s.group);
    if (!g) out.push((g = { name: s.group, items: [] }));
    g.items.push(s);
  }
  return out;
}

// ---------- user overrides ----------
// Stored in the same preferences blob as everything else that belongs to the
// person rather than the document - see prefs.svelte.js. Only ids this build
// knows are honoured, so a preference written by a newer build (or by hand)
// cannot bind a key to nothing.
export function comboFor(id) {
  if (id === 'tool.brush' && !prefs.brushTool) return null;
  const over = prefs.shortcuts?.[id];
  if (typeof over === 'string') {
    const c = normalizeCombo(over);
    if (c) return c;
  }
  return defaultCombo(id);
}

export const isCustomCombo = (id) => comboFor(id) !== defaultCombo(id);

// The shortcut a combo is already taken by, ignoring one id (the one being
// rebound). Null when the combo is free.
export function conflictFor(combo, exceptId = null) {
  const c = normalizeCombo(combo);
  if (!c) return null;
  for (const s of activeShortcuts()) {
    if (s.id === exceptId) continue;
    if (comboFor(s.id) === c) return s;
  }
  return null;
}

function writeOverrides(next) {
  setPref('shortcuts', next);
}

// Keys whose meaning depends on what is selected or focused. The registry
// dispatch runs before the contextual handlers in App.svelte's keydown
// ladder, so a rebind onto one of these would steal it everywhere; they are
// refused as rebind targets rather than quietly broken.
const CONTEXTUAL_KEYS = new Set(['Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

// Returns { ok } or { ok: false, reason, conflict } - the settings screen shows
// the conflict rather than silently stealing a key from another action.
export function setCombo(id, combo) {
  if (!BY_ID.has(id)) return { ok: false, reason: 'unknown' };
  const c = normalizeCombo(combo);
  if (!c) return { ok: false, reason: 'invalid' };
  if (CONTEXTUAL_KEYS.has(c.split('+').pop())) return { ok: false, reason: 'contextual' };
  const clash = conflictFor(c, id);
  if (clash) return { ok: false, reason: 'conflict', conflict: clash };
  const next = { ...($state.snapshot(prefs.shortcuts) ?? {}) };
  // Back to the default is an absence, not an entry that happens to match: it
  // keeps the stored blob small and lets a later build move a default without
  // every user being pinned to the old one.
  if (c === defaultCombo(id)) delete next[id];
  else next[id] = c;
  writeOverrides(next);
  return { ok: true, combo: c };
}

export function resetCombo(id) {
  if (!BY_ID.has(id)) return false;
  const cur = $state.snapshot(prefs.shortcuts) ?? {};
  if (!(id in cur)) return false;
  const next = { ...cur };
  delete next[id];
  writeOverrides(next);
  return true;
}

export function resetAllCombos() {
  writeOverrides({});
}

// Overrides read out of storage are pruned once against the registry this
// build actually has: an id it does not know, or a combo its spelling rules
// cannot produce, would otherwise sit in the map forever doing nothing.
// Runs on a microtask rather than at module-eval time because prefs loads
// before this module's tables exist (it is this module's own dependency), so
// any earlier call would reach into half-built bindings.
function pruneLoadedOverrides() {
  const cur = $state.snapshot(prefs.shortcuts) ?? {};
  const next = {};
  for (const [id, combo] of Object.entries(cur)) {
    if (BY_ID.has(id) && typeof combo === 'string' && normalizeCombo(combo)) next[id] = combo;
  }
  if (Object.keys(next).length !== Object.keys(cur).length) setPref('shortcuts', next);
}
queueMicrotask(pruneLoadedOverrides);

// ---------- dispatch ----------
// Handlers are registered rather than imported, for the reason the store's
// recorder is: this module must not know what a tool or a box is, and a test
// must be able to watch a keypress arrive without a document underneath it.
const handlers = new Map();
export function registerShortcutHandlers(map) {
  const ids = Object.keys(map);
  for (const id of ids) {
    // A silent overwrite looks exactly like a shortcut that has stopped
    // working, so say so. Two components claiming one id is always a bug.
    if (import.meta.env?.DEV && handlers.has(id)) {
      console.warn(`[shortcuts] handler for "${id}" registered twice - the new one replaces the old`);
    }
    handlers.set(id, map[id]);
  }
  return () => {
    for (const id of ids) if (handlers.get(id) === map[id]) handlers.delete(id);
  };
}
export const clearShortcutHandlers = () => handlers.clear();

// The shortcut a keypress means, or null.
export function lookupShortcut(e) {
  const c = eventCombo(e);
  if (!c) return null;
  return activeShortcuts().find((s) => comboFor(s.id) === c) ?? null;
}

// The one entry point the keydown handler uses. `typing` is the caller's answer
// to "is the caret in a text field right now" - the registry decides what that
// means per shortcut rather than the handler refusing everything, which is what
// made the old bare-letter tool keys unreachable in practice: a letterer's
// caret is almost always in the Inspector's text field or a queue row, and
// every printable key there is typing before it is anything else.
//
// Returns the id it ran, or null if the press was not ours.
export function dispatchShortcut(e, { typing = false } = {}) {
  const def = lookupShortcut(e);
  if (!def) return null;
  if (typing && !def.whenTyping) return null;
  const fn = handlers.get(def.id);
  if (!fn) return null;
  // A handler returning exactly false declines the press - the action did not
  // apply (no selection, wrong chapter mode) and the key should fall through.
  if (fn(e) === false) return null;
  e.preventDefault?.();
  return def.id;
}
