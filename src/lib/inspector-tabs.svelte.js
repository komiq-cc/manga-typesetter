// ===== Which Inspector tab is open =====
// The Text Box Options panel is four tabs across the top, and which one is
// showing is remembered for the session rather than saved: a letterer working
// through a page of strokes selects twenty boxes in a row and wants the same
// tab each time; a letterer who quits and comes back is starting a different
// job.
//
// It lives out here rather than in Inspector.svelte's module script because the
// keyboard has to reach it too - the tab-hop shortcuts are dispatched from
// App.svelte, which has no handle on the panel and should not grow one. The
// panel reads this state and writes it; the shortcuts write it; nothing else
// needs to know the panel exists.
export const INSPECTOR_TABS = ['text', 'fill', 'effects', 'layout'];

export const inspectorTab = $state({ id: 'text' });

export function setInspectorTab(id) {
  if (!INSPECTOR_TABS.includes(id)) return false;
  inspectorTab.id = id;
  return true;
}

// +1 / -1, wrapping. Wrapping rather than stopping at the ends because four
// tabs is a ring you flick through, not a list you scroll.
export function cycleInspectorTab(step = 1) {
  const i = INSPECTOR_TABS.indexOf(inspectorTab.id);
  const from = i === -1 ? 0 : i;
  const n = INSPECTOR_TABS.length;
  inspectorTab.id = INSPECTOR_TABS[(((from + step) % n) + n) % n];
  return inspectorTab.id;
}

// ===== Which Effects sub-tab is open =====
// Session-only state, same reasoning as the main tabs.
// `warp` is the arc / circle / bezier-path group and has been since before the
// mesh existed; `transform` is the mesh - free transform at a 1x1 grid, mesh
// transform above it. Two different features with two adjacent names, so the
// panel labels them "Warp" and "Transform" and the design says so in as many
// words: they must not be confused.
// `liquify` sits beside `transform` because it edits the same mesh with a
// round tool instead of handles.
// `sfx` is first in the row and is not the default: the tab a session opens on
// is still Stroke.
export const EFFECTS_SUBTABS = ['sfx', 'stroke', 'shadow', 'warp', 'transform', 'liquify', 'blur', 'edges', 'mask'];

export const effectsSubTab = $state({ id: 'stroke' });

export function setEffectsSubTab(id) {
  if (!EFFECTS_SUBTABS.includes(id)) return false;
  effectsSubTab.id = id;
  return true;
}
