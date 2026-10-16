// ===== Floating panel geometry =====
// The two right-hand editor panels are windows, not columns: the user drags,
// resizes and hides them, and the layout they leave behind is theirs across
// relaunches. This module owns nothing but that geometry - no DOM, no pointer
// handling - so the rules that are easy to get wrong (a window that shrank
// between sessions, a corrupt preference) are testable without a browser.
//
// The one thing it takes from the store is the interval its writes are debounced
// on, so this module and the sidebar's preference coalesce on the same beat
// rather than on two numbers that drifted apart. Nothing else - no state, no
// document.
import { PREF_SAVE_MS } from '../store.svelte.js';

export const PANEL_IDS = ['options', 'queue'];

export const MIN_W = 220;
export const MIN_H = 160;
const DEF_W = 320;
const GAP = 16;
// The band along the top of the canvas that the floating chrome owns, tooltips
// included: a 12px inset, a 32px pill, the 7px the tooltip drops by, and a ~23px
// tooltip, plus air. A panel opening inside this covers the tooltips of the pills
// at the right end of the row, and it cannot be fixed with a z-index - the
// tooltip is an ::after inside `.pill-row`, whose own stacking context at 30
// caps it below any panel at 50. So the panels open below the band instead.
const CHROME_BAND = 84;
const DEF_OPTIONS_H = 420;
// However far a panel is dragged, this much of it stays inside the window. It
// is the difference between a layout the user can undo by hand and one that
// needs the reset button.
const KEEP_X = 120;
const KEEP_Y = 32;
const KEY = 'mt.panels';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function defaultGeometry(vw) {
  const x = Math.max(GAP, vw - DEF_W - GAP);
  return {
    options: { x, y: CHROME_BAND, w: DEF_W, h: DEF_OPTIONS_H, hidden: false, z: 1 },
    // Stacked directly under the options panel, computed rather than written
    // out, so moving the band cannot leave the two overlapping.
    queue: { x, y: CHROME_BAND + DEF_OPTIONS_H + GAP, w: DEF_W, h: 360, hidden: false, z: 2 },
  };
}

export function clampPanel(g, vw, vh) {
  const w = clamp(num(g.w) ?? DEF_W, MIN_W, Math.max(MIN_W, vw - GAP));
  const h = clamp(num(g.h) ?? MIN_H, MIN_H, Math.max(MIN_H, vh - GAP));
  // A hidden panel is clamped as the panel it comes back as: its tab lives
  // under the tool strip (RailTools.svelte) and has no place of its own, so
  // the geometry stored is only ever the panel's.
  return {
    x: clamp(num(g.x) ?? 0, 0, Math.max(0, vw - KEEP_X)),
    y: clamp(num(g.y) ?? 0, 0, Math.max(0, vh - KEEP_Y)),
    w,
    h,
    hidden: g.hidden === true,
    z: num(g.z) ?? 1,
  };
}

// A stored layout is user data of the least important kind. Anything that does
// not parse, or does not carry the right types, is replaced by the default for
// that panel alone - a broken half never costs the good half.
export function sanitize(stored, vw, vh) {
  const defs = defaultGeometry(vw);
  let raw = stored;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const out = {};
  for (const id of PANEL_IDS) {
    const g = raw && typeof raw === 'object' ? raw[id] : null;
    const usable =
      g &&
      typeof g === 'object' &&
      num(g.x) !== null &&
      num(g.y) !== null &&
      num(g.w) !== null &&
      num(g.h) !== null &&
      typeof g.hidden === 'boolean';
    // The fallback goes through the clamp too. `defaultGeometry` lays the
    // panels out by width alone, so on a short window an unclamped default
    // parks the queue below the fold - the very thing this module exists to
    // prevent, and it would happen on the first run rather than in some odd
    // corner.
    out[id] = clampPanel(usable ? g : defs[id], vw, vh);
  }
  return out;
}

export const panels = $state(defaultGeometry(1440));

let store = null;
let saveT = null;

function assign(next) {
  for (const id of PANEL_IDS) Object.assign(panels[id], next[id]);
}

export function loadPanels(storage, vw, vh) {
  store = storage;
  let stored = null;
  try {
    stored = storage?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  assign(sanitize(stored, vw, vh));
}

export function serializePanels() {
  const out = {};
  for (const id of PANEL_IDS) out[id] = { ...panels[id] };
  return JSON.stringify(out);
}

// `loadPanels` binds the editor's storage, and until the editor has mounted this
// session there is none - but `resetPanels` is a Settings action, and Settings
// opens from the library screen too. A reset that wrote nowhere would be the
// worst of both: the panels snap back in memory, the stale blob stays on disk,
// and the next editor mount loads it straight back over the top. So a write with
// nothing bound falls back to the storage the editor would have handed us.
const writeTo = () => store ?? globalThis.localStorage ?? null;

function writePanels() {
  try {
    writeTo()?.setItem(KEY, serializePanels());
  } catch {
    /* a layout preference is not worth a message */
  }
}

// Null whenever there is nothing pending, so `flushPanels` can tell "a panel was
// dragged and the timer has not fired" from "there is nothing to write" - a
// session nobody moved a panel in must not leave a storage entry behind that it
// did not already have.
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    saveT = null;
    writePanels();
  }, PREF_SAVE_MS);
}

// The debounce given back on the way out, the same obligation `flushSidebar`
// carries one module over: ⌘Q destroys the window without an unload the page can
// await, so a panel dragged inside the last PREF_SAVE_MS would be lost. Safe to
// call with nothing pending, and idempotent - clearing a fired or never-set
// timer is a no-op.
export function flushPanels() {
  if (!saveT) return;
  clearTimeout(saveT);
  saveT = null;
  writePanels();
}

// The mutators take whatever the caller hands them, minimum sizes aside: the
// module has no idea how big the window is, and inventing one here would fight
// the drag it is meant to record. Keeping a panel reachable is the caller's
// half of the bargain - call `clampAll` when the drag ends and whenever the
// window resizes.
export function movePanel(id, x, y) {
  panels[id].x = x;
  panels[id].y = y;
  save();
}

export function resizePanel(id, w, h) {
  panels[id].w = Math.max(MIN_W, w);
  panels[id].h = Math.max(MIN_H, h);
  save();
}

export function setHidden(id, hidden) {
  panels[id].hidden = hidden;
  save();
}

// Clicking a panel brings it forward. Two panels only, so the z values stay
// small and never need normalising.
// The test is against the *other* panels, not against the overall top: a
// layout where both carry the same z - which a stored blob written without
// them produces - would otherwise satisfy "I am already the top" forever, and
// the user could never bring either one forward again.
export function raisePanel(id) {
  const rest = PANEL_IDS.filter((p) => p !== id).map((p) => panels[p].z);
  if (!rest.length) return;
  const below = Math.max(...rest);
  if (panels[id].z > below) return;
  panels[id].z = below + 1;
  save();
}

// `persist` is the difference between a clamp the user asked for and one the
// window did to them. Clamping only ever shrinks, so writing the result of a
// resize would make a moment of small window permanent: drag the corner in, the
// geometry is squeezed and saved, drag it back out and the panels stay small
// with nothing short of the reset to recover them. A drag that ends persists
// (the user placed it); a resize does not. Nothing is lost by that - `loadPanels`
// re-clamps to whatever the window is on the next mount anyway.
export function clampAll(vw, vh, persist = true) {
  for (const id of PANEL_IDS) Object.assign(panels[id], clampPanel(panels[id], vw, vh));
  if (persist) save();
}

// The way out of a layout the user cannot drag back, and the only caller is the
// Settings modal - which is not part of the editor route, so this runs just as
// often with no panel mounted and no `loadPanels` behind it. Nothing here
// touches the DOM or the document: `panels` is this module's own singleton and
// exists from load, and the write goes through `writeTo` so a reset from the
// library screen still reaches disk. The caller passes the live window size,
// which is the only thing this cannot work out for itself.
export function resetPanels(vw, vh) {
  assign(defaultGeometry(vw));
  clampAll(vw, vh);
}
