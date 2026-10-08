// ===== Which fonts the menus offer =====
// The font selects (Inspector, bulk editor, tag form) and the Font Library all
// read one answer from here. It is a separate module from fonts.js on purpose:
// this one reads the preferences, and prefs.svelte.js imports the layout engine
// to apply the typesetting switch - so a module on the measuring path (psd.js
// imports fonts.js) must not import it back, or the two load half-built.
import { app, fontMissing } from './store.svelte.js';
import { prefs, setPref } from './prefs.svelte.js';

// The user's own fonts first: they were put there on purpose, for this work,
// and a letterer with three manga faces should not scroll past forty Google
// families to reach them. Then the built-ins the user has not hidden, then the
// installed system fonts the user has chosen to show. A group with nothing in
// it is left out, so a select never shows an empty heading.
//
// One function, read by every menu and by the Font Library, so "what is
// offered" cannot be answered differently in two places.
export function fontGroups() {
  const hidden = new Set(prefs.hiddenBuiltinFonts);
  const shown = new Set(prefs.shownSystemFonts);
  return [
    { key: 'user', label: 'Your fonts', fonts: app.fonts.user },
    { key: 'builtin', label: 'Built-in', fonts: app.fonts.builtin.filter((f) => !hidden.has(f.name)) },
    { key: 'system', label: 'System', fonts: app.fonts.system.filter((f) => shown.has(f.name)) },
  ].filter((g) => g.fonts.length);
}

// Whether the menus currently offer `name`. A menu bound to a box set in a
// family that is not offered still has to show that family as its value.
export const isFontOffered = (name) => fontGroups().some((g) => g.fonts.some((f) => f.name === name));

// What a font select says beside the family a box is set in, when that family
// needs a word. Two different things used to read "(not in menus)": a family
// the user hid, which draws as itself, and a family this machine has not got,
// which draws as something else. The second is the one that changes the page,
// so it is asked first - a missing family says so even while a menu still
// lists it, as every built-in does once the Rust engine measures.
export function fontCaveat(name) {
  if (!name) return null;
  if (fontMissing(name)) return 'font missing';
  return isFontOffered(name) ? null : 'not in menus';
}

const without = (list, name) => list.filter((n) => n !== name);
export const isBuiltinHidden = (name) => prefs.hiddenBuiltinFonts.includes(name);
export const isSystemShown = (name) => prefs.shownSystemFonts.includes(name);
export function setBuiltinHidden(name, hide) {
  const cur = prefs.hiddenBuiltinFonts;
  setPref('hiddenBuiltinFonts', hide ? [...without(cur, name), name] : without(cur, name));
}
export function setSystemShown(name, show) {
  const cur = prefs.shownSystemFonts;
  setPref('shownSystemFonts', show ? [...without(cur, name), name] : without(cur, name));
}

