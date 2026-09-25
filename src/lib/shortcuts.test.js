import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SHORTCUTS,
  setMacKeyboard,
  isMacKeyboard,
  eventKeyName,
  eventCombo,
  normalizeCombo,
  combosEqual,
  matchesCombo,
  formatCombo,
  comboFor,
  defaultCombo,
  isCustomCombo,
  conflictFor,
  setCombo,
  resetCombo,
  resetAllCombos,
  lookupShortcut,
  dispatchShortcut,
  registerShortcutHandlers,
  clearShortcutHandlers,
  shortcutGroups,
  captureAction,
} from './shortcuts.svelte.js';
import { prefs, setPref } from './prefs.svelte.js';
import { createRebindCapture } from './rebind-capture.js';

// A KeyboardEvent, as much of one as this module reads. `code` is the physical
// key and `key` is what the layout produced - the two disagree on purpose in
// the tests that care (Shift+1 is '!', Alt+A on a Mac is 'å'). `altgr` stands
// in for getModifierState('AltGraph'), which Windows reports alongside
// ctrlKey for its right-hand Alt.
function press(code, opts = {}) {
  const { key, mod, other, alt, shift, altgr } = opts;
  const mac = isMacKeyboard();
  return {
    code,
    key: key ?? codeToKey(code),
    metaKey: !!(mac ? mod : other),
    ctrlKey: !!(mac ? other : mod),
    altKey: !!alt,
    shiftKey: !!shift,
    keyCode: 0,
    getModifierState: (m) => !!altgr && m === 'AltGraph',
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}
function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

// localStorage is what prefs persists through, and node has none.
let store;
beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => (store[k] = String(v)),
    removeItem: (k) => delete store[k],
  });
  setMacKeyboard(true);
  setPref('shortcuts', {});
  setPref('brushTool', false);
  clearShortcutHandlers();
});
afterEach(() => {
  setPref('shortcuts', {});
  setPref('brushTool', false);
  clearShortcutHandlers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe('combo spelling', () => {
  it('names the key by its physical code, not by what the layout produced', () => {
    // Shift+1 is '!' on a US layout and something else elsewhere; the shortcut
    // is the 1 key either way.
    expect(eventKeyName(press('Digit1', { key: '!', shift: true }))).toBe('1');
    // macOS turns Alt+A into 'å'. Without the code, every Alt shortcut in the
    // registry would be unreachable on a Mac.
    expect(eventKeyName(press('KeyA', { key: 'å', alt: true }))).toBe('a');
    expect(eventKeyName(press('BracketRight'))).toBe(']');
    expect(eventKeyName(press('Space', { key: ' ' }))).toBe('Space');
  });

  it('has no name for a press that is only a modifier', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(eventKeyName({ code: k + 'Left', key: k })).toBe(null);
    }
    expect(eventCombo({ code: 'MetaLeft', key: 'Meta', metaKey: true })).toBe(null);
  });

  it('keeps named keys as their key spelling', () => {
    expect(eventKeyName({ code: 'Delete', key: 'Delete' })).toBe('Delete');
    expect(eventKeyName({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBe('ArrowLeft');
  });

  it('spells numpad keys as themselves, not their top-row aliases', () => {
    // The keypad's 3 sits beside M, not under F3; binding one must never fire
    // from the other, so they get distinct names despite sharing a legend.
    expect(eventKeyName({ code: 'Numpad3', key: '3' })).toBe('Numpad3');
    expect(eventKeyName({ code: 'NumpadAdd', key: '+' })).toBe('NumpadAdd');
    expect(eventKeyName({ code: 'NumpadSubtract', key: '-' })).toBe('NumpadSubtract');
    expect(eventKeyName({ code: 'NumpadDecimal', key: '.' })).toBe('NumpadDecimal');
    setMacKeyboard(false);
    const e = press('Numpad3', { mod: true });
    expect(eventCombo(e)).toBe('Mod+Numpad3');
    expect(matchesCombo(e, 'mod+numpad3')).toBe(true);
    // And a top-row press still reads as the digit.
    expect(matchesCombo(press('Digit3', { mod: true }), 'Mod+3')).toBe(true);
    expect(matchesCombo(press('Digit3', { mod: true }), 'Mod+Numpad3')).toBe(false);
  });

  it('has no name for a dead key, even one sitting on a punctuation code', () => {
    // Dead keys arrive with their physical code attached (Backquote on a US
    // layout); without this check the capture would read them as '`'.
    expect(eventKeyName({ code: 'Backquote', key: 'Dead' })).toBe(null);
    expect(eventCombo({ code: 'Quote', key: 'Dead', shiftKey: true })).toBe(null);
  });

  it('reads Mod as command on a Mac and as control everywhere else', () => {
    setMacKeyboard(true);
    expect(eventCombo({ code: 'Digit1', key: '1', metaKey: true })).toBe('Mod+1');
    expect(eventCombo({ code: 'Digit1', key: '1', ctrlKey: true })).toBe('Ctrl+1');
    setMacKeyboard(false);
    expect(eventCombo({ code: 'Digit1', key: '1', ctrlKey: true })).toBe('Mod+1');
    expect(eventCombo({ code: 'Digit1', key: '1', metaKey: true })).toBe('Meta+1');
  });

  it('reads AltGr character input as Alt, never as Mod+Alt, off a Mac', () => {
    setMacKeyboard(false);
    // Windows reports AltGr as Ctrl+Alt. Typing one of its characters used to
    // spell Mod+Alt+key and get eaten by the shortcut system.
    const e = press('Digit3', { mod: true, alt: true, altgr: true });
    expect(eventCombo(e)).toBe('Alt+3');
    expect(matchesCombo(e, 'Mod+Alt+3')).toBe(false);
    const fn = vi.fn();
    registerShortcutHandlers({ 'tool.pan': fn });
    expect(dispatchShortcut(e)).toBe(null);
    expect(fn).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    // A plain Ctrl+Alt press is still Mod+Alt.
    expect(eventCombo(press('Digit3', { mod: true, alt: true }))).toBe('Mod+Alt+3');
    // And on a Mac the flag does not exist / does not apply.
    setMacKeyboard(true);
    const macEvent = press('Digit3', { mod: true, alt: true, altgr: true });
    expect(eventCombo(macEvent)).toBe('Mod+Alt+3');
  });

  it('writes modifiers in one order however they were typed', () => {
    expect(normalizeCombo('Shift+Alt+Mod+c')).toBe('Mod+Alt+Shift+c');
    expect(normalizeCombo('mod+shift+C')).toBe('Mod+Shift+c');
    expect(normalizeCombo('  Mod + D ')).toBe('Mod+d');
    expect(normalizeCombo('CmdOrCtrl+z')).toBe('Mod+z');
    expect(combosEqual('Mod+Shift+C', 'shift+mod+c')).toBe(true);
    expect(combosEqual('Mod+c', 'Mod+Shift+c')).toBe(false);
  });

  it('spells Cmd and Ctrl into Mod by platform, so a combo means the same thing on both', () => {
    setMacKeyboard(true);
    expect(normalizeCombo('Cmd+1')).toBe('Mod+1');
    expect(normalizeCombo('Ctrl+1')).toBe('Ctrl+1');
    setMacKeyboard(false);
    expect(normalizeCombo('Ctrl+1')).toBe('Mod+1');
    expect(normalizeCombo('Cmd+1')).toBe('Meta+1');
  });

  it('refuses what is not a combo', () => {
    for (const bad of ['', '   ', null, undefined, 42, 'Shift', 'Hyper+k', {}, 'Mod+Hyper', 'mod+mediaplay']) {
      expect(normalizeCombo(bad)).toBe(null);
    }
    // The plus key itself is still a key.
    expect(normalizeCombo('Mod++')).toBe('Mod++');
  });

  it('canonicalises the key half against names a keypress can produce', () => {
    // Wrong-case named keys used to persist as overrides that never fired,
    // because events spell them 'Delete' and the blob said 'delete'.
    expect(normalizeCombo('mod+delete')).toBe('Mod+Delete');
    expect(normalizeCombo('Mod+ESCAPE')).toBe('Mod+Escape');
    expect(normalizeCombo('Mod+arrowleft')).toBe('Mod+ArrowLeft');
    expect(normalizeCombo('Mod+numpad3')).toBe('Mod+Numpad3');
    expect(normalizeCombo('Mod+F5')).toBe('Mod+F5');
  });

  it('matches an event against a combo written either way round', () => {
    const e = press('KeyC', { mod: true, shift: true });
    expect(matchesCombo(e, 'Mod+Shift+c')).toBe(true);
    expect(matchesCombo(e, 'shift+mod+C')).toBe(true);
    expect(matchesCombo(e, 'Mod+c')).toBe(false);
    expect(matchesCombo(press('KeyC', { mod: true }), 'Mod+Shift+c')).toBe(false);
  });

  it('shows glyphs on a Mac and words elsewhere', () => {
    setMacKeyboard(true);
    expect(formatCombo('Mod+Shift+c')).toBe('⌘⇧C');
    expect(formatCombo('Mod+1')).toBe('⌘1');
    expect(formatCombo('Delete')).toBe('Del');
    setMacKeyboard(false);
    expect(formatCombo('Mod+Shift+c')).toBe('Ctrl+Shift+C');
    expect(formatCombo('nonsense++')).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('the registry itself', () => {
  it('gives every shortcut an id, a label, a group and a canonical default', () => {
    for (const s of SHORTCUTS) {
      expect(typeof s.id).toBe('string');
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.group.length).toBeGreaterThan(0);
      expect(s.combo).toBe(normalizeCombo(s.combo));
    }
  });

  it('binds no two actions to the same default', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const combos = SHORTCUTS.map((s) => s.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('carries the tool modes in rail order according to brushTool preference', () => {
    // With brushTool off: Mod+3 is pan, Mod+4 is unassigned, and tool.brush is absent from groups.
    setPref('brushTool', false);
    expect(defaultCombo('tool.place')).toBe('Mod+1');
    expect(defaultCombo('tool.text')).toBe('Mod+2');
    expect(defaultCombo('tool.pan')).toBe('Mod+3');
    expect(lookupShortcut(press('Digit3', { mod: true }))?.id).toBe('tool.pan');
    expect(lookupShortcut(press('Digit4', { mod: true }))).toBe(null);
    const groupsOff = shortcutGroups();
    expect(groupsOff.flatMap((g) => g.items).some((s) => s.id === 'tool.brush')).toBe(false);
    expect(groupsOff.flatMap((g) => g.items).length).toBe(SHORTCUTS.length - 1);

    // With brushTool on: Mod+3 is tool.brush, Mod+4 is tool.pan, and tool.brush is in groups.
    setPref('brushTool', true);
    expect(defaultCombo('tool.place')).toBe('Mod+1');
    expect(defaultCombo('tool.text')).toBe('Mod+2');
    expect(defaultCombo('tool.brush')).toBe('Mod+3');
    expect(defaultCombo('tool.pan')).toBe('Mod+4');
    expect(lookupShortcut(press('Digit3', { mod: true }))?.id).toBe('tool.brush');
    expect(lookupShortcut(press('Digit4', { mod: true }))?.id).toBe('tool.pan');
    const groupsOn = shortcutGroups();
    expect(groupsOn.flatMap((g) => g.items).some((s) => s.id === 'tool.brush')).toBe(true);
    expect(groupsOn.flatMap((g) => g.items).length).toBe(SHORTCUTS.length);
  });
});

// ---------------------------------------------------------------------------
describe('overrides', () => {
  it('answers with the default until the user says otherwise', () => {
    expect(comboFor('tool.pan')).toBe('Mod+3');
    expect(isCustomCombo('tool.pan')).toBe(false);
    expect(comboFor('no.such.shortcut')).toBe(null);
  });

  it('takes a rebind, canonicalises it, and persists only what changed', () => {
    const r = setCombo('tool.pan', 'shift+Mod+H');
    expect(r).toEqual({ ok: true, combo: 'Mod+Shift+h' });
    expect(comboFor('tool.pan')).toBe('Mod+Shift+h');
    expect(isCustomCombo('tool.pan')).toBe(true);
    // One key in the blob: the rest of the registry is still its defaults, and
    // stays free to have them moved by a later build.
    const saved = JSON.parse(store['mt.prefs']);
    expect(saved.shortcuts).toEqual({ 'tool.pan': 'Mod+Shift+h' });
  });

  it('drops the override when the user rebinds back to the default', () => {
    setCombo('tool.pan', 'Mod+Shift+h');
    expect(setCombo('tool.pan', 'mod+3').ok).toBe(true);
    expect(isCustomCombo('tool.pan')).toBe(false);
    expect(JSON.parse(store['mt.prefs']).shortcuts).toEqual({});
  });

  it('refuses a combo another action already holds, and says which', () => {
    const r = setCombo('tool.pan', 'Mod+1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('conflict');
    expect(r.conflict.id).toBe('tool.place');
    // And nothing moved.
    expect(comboFor('tool.pan')).toBe('Mod+3');
    // A conflict is against the combo in force, not the default it started at.
    setCombo('tool.pan', 'Mod+Shift+h');
    expect(conflictFor('Mod+Shift+h')?.id).toBe('tool.pan');
    expect(conflictFor('Mod+3')).toBe(null);
    // Rebinding a shortcut onto the combo it already has is not a conflict.
    expect(conflictFor('Mod+Shift+h', 'tool.pan')).toBe(null);
    expect(setCombo('tool.pan', 'Mod+Shift+h').ok).toBe(true);
  });

  it('refuses an unknown id and an unusable combo', () => {
    expect(setCombo('no.such.shortcut', 'Mod+9')).toEqual({ ok: false, reason: 'unknown' });
    expect(setCombo('tool.pan', 'Shift')).toEqual({ ok: false, reason: 'invalid' });
    expect(comboFor('tool.pan')).toBe('Mod+3');
  });

  it('refuses to rebind the contextual fixed keys', () => {
    // Escape, Tab and the arrows mean whatever the current focus says they
    // mean; the registry dispatch runs first, so a rebind onto one would
    // steal it from every context it serves.
    for (const combo of ['Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowDown']) {
      const r = setCombo('tool.pan', combo);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('contextual');
    }
    // Nothing was written - only the empty map beforeEach persists.
    expect(JSON.parse(store['mt.prefs']).shortcuts).toEqual({});
    expect(comboFor('tool.pan')).toBe('Mod+3');
  });

  it('resets one shortcut and all of them', () => {
    setCombo('tool.pan', 'Mod+Shift+h');
    setCombo('edit.undo', 'Mod+Alt+z');
    expect(resetCombo('tool.pan')).toBe(true);
    expect(comboFor('tool.pan')).toBe('Mod+3');
    // Nothing to reset is not a failure to reset, but it is not a write either.
    expect(resetCombo('tool.pan')).toBe(false);
    expect(resetCombo('no.such.shortcut')).toBe(false);
    expect(comboFor('edit.undo')).toBe('Mod+Alt+z');
    resetAllCombos();
    for (const s of SHORTCUTS) {
      if (s.id === 'tool.brush') expect(comboFor(s.id)).toBe(null);
      else if (s.id === 'tool.pan') expect(comboFor(s.id)).toBe('Mod+3');
      else expect(comboFor(s.id)).toBe(s.combo);
    }
    expect(JSON.parse(store['mt.prefs']).shortcuts).toEqual({});
  });

  it('reads the saved overrides back on the next launch, and only the sane ones', async () => {
    store['mt.prefs'] = JSON.stringify({
      typeset: false,
      shortcuts: {
        'tool.pan': 'Mod+Shift+h',
        'tool.text': 42, // not a string
        'tool.place': '   ', // not a combo
      },
    });
    // A fresh module registry is the only honest way to run the load path.
    vi.resetModules();
    const fresh = await import('./prefs.svelte.js');
    expect(fresh.prefs.shortcuts).toEqual({ 'tool.pan': 'Mod+Shift+h' });
  });

  it('prunes loaded overrides for unknown ids and unspeakable combos', async () => {
    store['mt.prefs'] = JSON.stringify({
      typeset: false,
      shortcuts: {
        'ghost.action': 'Mod+q', // an id this build does not know
        'tool.pan': 'Mod+Shift+h', // sane, stays
        'box.delete': 'Mod+Hyper', // a combo no keypress can produce
      },
    });
    vi.resetModules();
    // Importing the registry is what arms the prune; prefs alone only
    // shape-checks. The app always loads both.
    await import('./shortcuts.svelte.js');
    await import('./prefs.svelte.js');
    await new Promise((resolve) => queueMicrotask(resolve));
    const fresh = await import('./prefs.svelte.js');
    expect(fresh.prefs.shortcuts).toEqual({ 'tool.pan': 'Mod+Shift+h' });
  });

  it('keeps a preference that is not an object out of the map', () => {
    setPref('shortcuts', 'nonsense');
    expect(prefs.shortcuts).toEqual({});
    setPref('shortcuts', null);
    expect(prefs.shortcuts).toEqual({});
    setPref('shortcuts', ['Mod+1']);
    expect(prefs.shortcuts).toEqual({});
  });

  it('ignores an override that is not a combo and falls back to the default', () => {
    setPref('shortcuts', { 'tool.pan': 'Hyper+k' });
    expect(comboFor('tool.pan')).toBe('Mod+3');
    setPref('brushTool', true);
    expect(comboFor('tool.pan')).toBe('Mod+4');
  });
});

// ---------------------------------------------------------------------------
describe('dispatch', () => {
  it('finds the shortcut a keypress means, override included', () => {
    expect(lookupShortcut(press('Digit1', { mod: true }))?.id).toBe('tool.place');
    expect(lookupShortcut(press('KeyQ', { mod: true }))).toBe(null);
    setCombo('tool.place', 'Mod+Alt+p');
    expect(lookupShortcut(press('Digit1', { mod: true }))).toBe(null);
    expect(lookupShortcut(press('KeyP', { key: 'π', mod: true, alt: true }))?.id).toBe('tool.place');
  });

  it('runs the handler and swallows the key', () => {
    const fn = vi.fn();
    registerShortcutHandlers({ 'tool.pan': fn });
    const e = press('Digit3', { mod: true });
    expect(dispatchShortcut(e)).toBe('tool.pan');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('leaves a key alone when nothing is bound to it or nothing is listening', () => {
    const e = press('Digit3', { mod: true });
    // Registered by nobody: the press is not ours to prevent.
    expect(dispatchShortcut(e)).toBe(null);
    expect(e.preventDefault).not.toHaveBeenCalled();
    const e2 = press('KeyQ', { mod: true });
    expect(dispatchShortcut(e2)).toBe(null);
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it('lets a handler decline, and does not eat the key when it does', () => {
    const fn = vi.fn(() => false);
    registerShortcutHandlers({ 'box.delete': fn });
    const e = press('Delete');
    expect(dispatchShortcut(e)).toBe(null);
    expect(fn).toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('holds back everything but the typing-safe shortcuts while the caret is in a field', () => {
    const tool = vi.fn();
    const del = vi.fn();
    const undo = vi.fn();
    registerShortcutHandlers({ 'tool.pan': tool, 'box.delete': del, 'edit.undo': undo });
    // The whole point of the rebind: a mode switch still works mid-sentence.
    expect(dispatchShortcut(press('Digit3', { mod: true }), { typing: true })).toBe('tool.pan');
    // These two would eat the box being typed into, or fight the field's own
    // undo stack.
    expect(dispatchShortcut(press('Delete'), { typing: true })).toBe(null);
    expect(dispatchShortcut(press('KeyZ', { mod: true }), { typing: true })).toBe(null);
    expect(del).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    // And out of a field, all three are live.
    expect(dispatchShortcut(press('Delete'))).toBe('box.delete');
    expect(dispatchShortcut(press('KeyZ', { mod: true }))).toBe('edit.undo');
  });

  it('unregisters cleanly', () => {
    const fn = vi.fn();
    const release = registerShortcutHandlers({ 'tool.pan': fn });
    release();
    expect(dispatchShortcut(press('Digit3', { mod: true }))).toBe(null);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends the rebound key to the action, not the old one', () => {
    const place = vi.fn();
    const pan = vi.fn();
    registerShortcutHandlers({ 'tool.place': place, 'tool.pan': pan });
    setCombo('tool.place', 'Mod+Alt+p');
    dispatchShortcut(press('KeyP', { key: 'π', mod: true, alt: true }));
    expect(place).toHaveBeenCalledTimes(1);
    // The vacated combo does nothing until something is bound to it.
    expect(dispatchShortcut(press('Digit1', { mod: true }))).toBe(null);
    expect(setCombo('tool.pan', 'Mod+1').ok).toBe(true);
    dispatchShortcut(press('Digit1', { mod: true }));
    expect(pan).toHaveBeenCalledTimes(1);
  });

  it('keeps the pure-Mod text-box actions live while typing', () => {
    // No layout produces Mod+D or Mod+Shift+C/V/F by typing, so a letterer
    // mid-sentence still gets duplicate and the style clipboard.
    const dup = vi.fn();
    const copy = vi.fn();
    const paste = vi.fn();
    const fit = vi.fn();
    const retype = vi.fn();
    registerShortcutHandlers({ 'box.duplicate': dup, 'style.copy': copy, 'style.paste': paste, 'box.fitBalloon': fit, 'box.retypeset': retype });
    expect(dispatchShortcut(press('KeyD', { mod: true }), { typing: true })).toBe('box.duplicate');
    expect(dispatchShortcut(press('KeyC', { mod: true, shift: true }), { typing: true })).toBe('style.copy');
    expect(dispatchShortcut(press('KeyV', { mod: true, shift: true }), { typing: true })).toBe('style.paste');
    expect(dispatchShortcut(press('KeyF', { mod: true, shift: true }), { typing: true })).toBe('box.fitBalloon');
    expect(dispatchShortcut(press('KeyF', { mod: true, alt: true }), { typing: true })).toBe('box.retypeset');
    expect(retype).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('warns instead of silently overwriting a registered handler', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = vi.fn();
      const second = vi.fn();
      registerShortcutHandlers({ 'tool.pan': first });
      registerShortcutHandlers({ 'tool.pan': second });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('tool.pan');
      // The newcomer is the one wired up.
      expect(dispatchShortcut(press('Digit3', { mod: true }))).toBe('tool.pan');
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('dispatches Mod+3 and Mod+4 according to brushTool preference', () => {
    const brush = vi.fn();
    const pan = vi.fn();
    registerShortcutHandlers({ 'tool.brush': brush, 'tool.pan': pan });

    // With brushTool: false (default), Mod+3 is pan, Mod+4 is unassigned
    expect(dispatchShortcut(press('Digit3', { mod: true }))).toBe('tool.pan');
    expect(pan).toHaveBeenCalledTimes(1);
    expect(dispatchShortcut(press('Digit4', { mod: true }))).toBe(null);
    expect(brush).not.toHaveBeenCalled();

    // With brushTool: true, Mod+3 is brush, Mod+4 is pan
    setPref('brushTool', true);
    expect(dispatchShortcut(press('Digit3', { mod: true }))).toBe('tool.brush');
    expect(brush).toHaveBeenCalledTimes(1);
    expect(dispatchShortcut(press('Digit4', { mod: true }))).toBe('tool.pan');
    expect(pan).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
describe('what a keypress means during a rebind capture', () => {
  it('binds real keypresses and cancels on bare Escape', () => {
    const bind = captureAction(press('KeyH', { shift: true }));
    expect(bind).toEqual({ act: 'bind', combo: 'Shift+h' });
    // captureAction only decides; the swallow is the listener's job and is
    // checked in the lifecycle tests below.
    expect(captureAction(press('Escape', { key: 'Escape' }))).toEqual({ act: 'cancel' });
  });

  it('passes IME composition keystrokes through untouched', () => {
    const composing = { ...press('KeyA'), isComposing: true };
    expect(captureAction(composing)).toEqual({ act: 'pass' });
    expect(composing.preventDefault).not.toHaveBeenCalled();
    const synthetic = { ...press('KeyA'), keyCode: 229 };
    expect(captureAction(synthetic)).toEqual({ act: 'pass' });
  });

  it('passes AltGr character input through and waits on lone modifiers without swallowing them', () => {
    setMacKeyboard(false);
    const altgr = press('KeyQ', { mod: true, alt: true, altgr: true });
    expect(captureAction(altgr)).toEqual({ act: 'pass' });
    expect(altgr.preventDefault).not.toHaveBeenCalled();
    const loneShift = press('ShiftLeft', { key: 'Shift' });
    expect(captureAction(loneShift)).toEqual({ act: 'wait' });
    expect(loneShift.preventDefault).not.toHaveBeenCalled();
    // Escape carrying a modifier is not the cancel key.
    expect(captureAction(press('Escape', { key: 'Escape', mod: true })).act).toBe('bind');
    setMacKeyboard(true);
  });
});

// ---------------------------------------------------------------------------
describe('the rebind capture lifecycle', () => {
  // Enough of a window to watch who is listening.
  function fakeWindow() {
    const listeners = { keydown: [] };
    return {
      listeners,
      addEventListener: (type, fn) => listeners[type].push(fn),
      removeEventListener: (type, fn) => {
        const i = listeners[type].indexOf(fn);
        if (i !== -1) listeners[type].splice(i, 1);
      },
      fire(e) {
        for (const fn of [...listeners.keydown]) fn(e);
      },
      get armed() {
        return listeners.keydown.length > 0;
      },
    };
  }
  function setup() {
    const win = fakeWindow();
    const bound = [];
    let cancelled = 0;
    const capture = createRebindCapture(win, {
      onKey: (combo, done) => {
        bound.push(combo);
        done();
      },
      onCancel: () => cancelled++,
    });
    return { win, capture, bound, cancelled: () => cancelled };
  }

  it('is armed only while the modal is open AND a row is listening', () => {
    const { win, capture } = setup();
    // Neither condition alone arms the listener.
    capture.setOpen(true);
    expect(win.armed).toBe(false);
    capture.setOpen(false);
    capture.begin('tool.pan');
    expect(win.armed).toBe(false);
    capture.setOpen(false);
    expect(win.armed).toBe(false);
    // Both together do - and keys reach it.
    capture.setOpen(true);
    capture.begin('tool.pan');
    expect(win.armed).toBe(true);
    win.fire(press('KeyH', { shift: true }));
    expect(win.armed).toBe(false); // binding finished the capture
    // Clicking the row that already listens cancels rather than restarting.
    capture.setOpen(true);
    expect(capture.begin('tool.pan')).toBe('tool.pan');
    expect(capture.begin('tool.pan')).toBe(null);
    expect(win.armed).toBe(false);
  });

  it('disarms and cancels when the modal closes mid-capture', () => {
    const { win, capture, bound, cancelled } = setup();
    capture.setOpen(true);
    capture.begin('box.duplicate');
    expect(win.armed).toBe(true);
    // The user clicks the scrim or the ✗ instead of pressing a key...
    capture.setOpen(false);
    // ...and the listener is gone: nothing swallows, nothing rebinds.
    expect(win.armed).toBe(false);
    expect(capture.current).toBe(null);
    expect(cancelled()).toBe(1);
    const e = press('KeyD', { mod: true });
    win.fire(e);
    expect(bound).toEqual([]);
    expect(e.preventDefault).not.toHaveBeenCalled();
    // Reopening starts clean, not mid-capture.
    capture.setOpen(true);
    expect(win.armed).toBe(false);
    expect(cancelled()).toBe(1);
  });

  it('takes the listener down when the row finishes or is cancelled', () => {
    const { win, capture, bound } = setup();
    capture.setOpen(true);
    capture.begin('style.copy');
    win.fire(press('KeyC', { mod: true, shift: true }));
    expect(bound).toEqual(['Mod+Shift+c']);
    expect(win.armed).toBe(false);
    // A bare Escape cancels without binding anything - and is swallowed.
    capture.setOpen(true);
    capture.begin('style.paste');
    const esc = press('Escape', { key: 'Escape' });
    win.fire(esc);
    expect(bound).toEqual(['Mod+Shift+c']);
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(win.armed).toBe(false);
    // And end() is safe to call when nothing is listening.
    capture.end();
    expect(win.armed).toBe(false);
  });
});
