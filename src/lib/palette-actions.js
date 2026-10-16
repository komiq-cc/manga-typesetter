// ===== What the command palette can run (FLOW-4) =====
// Two halves. Every registered shortcut, read off the registry each time the
// palette asks, so a rebind shows its new key and a handler that is not
// registered (no editor mounted) is simply not offered. And the actions that
// have no key - detection, the chapter-wide place, export, the drawers, each
// Settings tab - as one plain array, `ACTIONS`, so the next one is one line.
//
// An entry runs the action; it never just points at where the action lives.
// A shortcut runs through `runShortcut`, the same handler its key reaches, so
// the palette and the key cannot disagree about what "Duplicate box" does.
//
// Entry shape: { id, label, group, keywords, shortcut?, when(), run(ctx) }.
// `when` hides what the current mode cannot run - a translate chapter, no box
// selected, a run already going - rather than offering it and then refusing.
// `ctx` is what only App.svelte holds: the font library and Settings drawers.
import {
  app,
  byId,
  gotoPage,
  hasCopiedBox,
  isLongstrip,
  isTranslateMode,
  openBulk,
  placeDetectedInChapter,
  saveSidebar,
} from './store.svelte.js';
import { sidecarReady, detectCurrentPage, detectAllPages } from './sidecar.js';
import { SHORTCUTS, comboFor, formatCombo, hasShortcutHandler, runShortcut } from './shortcuts.svelte.js';
import { prefs } from './prefs.svelte.js';
import { jobs } from './jobs.svelte.js';

// A chapter open in typeset mode: what nearly every action needs.
const typeset = () => app.loaded && !isTranslateMode();
const boxSelected = () => typeset() && app.selectedId != null && !!byId(app.selectedId);
// Both detect scopes ask the engine for work, so both need it up and idle -
// the detect menu's own test. Translate chapters detect too.
const canDetect = () => app.loaded && sidecarReady() && !app.detecting;

// The ids a menu should not list twice: a second key for the same action.
const SAME_AS = new Set(['box.deleteAlt', 'edit.redoAlt']);

// Words a letterer might type that the registry's label does not hold.
const SHORTCUT_KEYWORDS = {
  'tool.place': 'tool paste place',
  'tool.text': 'tool new box add',
  'tool.brush': 'tool hand letter draw',
  'tool.pan': 'tool hand move scroll',
  'box.duplicate': 'clone copy',
  'box.delete': 'remove',
  'box.resetRotation': 'rotate straighten angle',
  'box.fitBalloon': 'bubble auto',
  'box.retypeset': 'refit bubble balloon',
  'box.layoutLock': 'lock unlock freeze',
  'box.approveOutline': 'bubble outline ok',
  'view.regions': 'show outlines bubbles detected',
  'style.copy': 'format look',
  'style.paste': 'format look apply',
  'queue.placeDetected': 'place page bubbles detected',
  'review.next': 'check review overflow problems flagged',
  'edit.undo': 'back history',
  'edit.redo': 'history',
  'inspector.tabNext': 'inspector options',
  'inspector.tabPrev': 'inspector options',
  'inspector.tabText': 'inspector options',
  'inspector.tabFill': 'inspector options colour color',
  'inspector.tabEffects': 'inspector options stroke shadow',
  'inspector.tabLayout': 'inspector options',
};

// What each shortcut needs before it can do anything. Box and style actions
// need a box; the rest need a typeset chapter. The handlers refuse on their own
// too - this only keeps the list from offering what would be refused.
function shortcutWhen(id) {
  if (id === 'tool.brush' && !prefs.brushTool) return false;
  if (id === 'box.paste') return typeset() && hasCopiedBox();
  if (id.startsWith('box.') || id.startsWith('style.')) return boxSelected();
  return typeset();
}

// The registry, as palette entries. Built per call rather than once: the key
// shown is the one bound now, and the handlers come and go with the editor.
export function shortcutActions() {
  return SHORTCUTS.filter((s) => s.id !== 'palette.open' && !SAME_AS.has(s.id)).map((s) => ({
    id: s.id,
    label: s.label,
    group: s.group,
    keywords: SHORTCUT_KEYWORDS[s.id] ?? '',
    shortcut: s.id,
    when: () => hasShortcutHandler(s.id) && shortcutWhen(s.id),
    run: () => runShortcut(s.id),
  }));
}

// Matches SettingsModal's TABS, by id. Listed here rather than imported so this
// module does not load the Settings component to read four names.
const SETTINGS_TABS = [
  { id: 'general', label: 'General', keywords: 'theme library folder updates' },
  { id: 'typesetting', label: 'Typesetting', keywords: 'auto height line breaking hyphen' },
  { id: 'shortcuts', label: 'Shortcuts', keywords: 'keys keyboard rebind hotkeys' },
  { id: 'system', label: 'System', keywords: 'memory engine models cache gpu version' },
];

// Actions with no key. One line each; add the next one here.
export const ACTIONS = [
  { id: 'detect.page', label: 'Detect text on this page', group: 'Detect', keywords: 'ocr scan read find', when: canDetect, run: () => detectCurrentPage() },
  { id: 'detect.chapter', label: 'Detect text in whole chapter', group: 'Detect', keywords: 'ocr scan read find all pages', when: canDetect, run: () => detectAllPages() },
  { id: 'queue.placeChapter', label: 'Place detected bubbles in whole chapter', group: 'Text queue', keywords: 'place all pages', when: () => typeset() && app.pages.length > 0 && !app.chapterPlace, run: () => placeDetectedInChapter() },
  { id: 'jobs.retry', label: 'Retry failed pages', group: 'Detect', keywords: 'again failed errors jobs', when: () => !!retryable() && sidecarReady() && !app.detecting, run: () => retryable()?.retry() },
  { id: 'chapter.export', label: 'Export…', group: 'Chapter', keywords: 'save png psd zip pages images', when: () => typeset() && !app.exporting, run: () => { app.exportOpen = true; } },
  { id: 'bulk.open', label: 'Bulk style', group: 'Text box', keywords: 'many boxes style all batch', when: () => typeset() && !app.bulk.active, run: () => openBulk() },
  { id: 'view.rawShow', label: 'Show raw page', group: 'View', keywords: 'compare raw original reference sidebar japanese', when: () => typeset() && app.sidebarHidden, run: toggleRaw },
  { id: 'view.rawHide', label: 'Hide raw page', group: 'View', keywords: 'compare raw original reference sidebar japanese', when: () => typeset() && !app.sidebarHidden, run: toggleRaw },
  { id: 'fonts.open', label: 'Font library', group: 'General', keywords: 'fonts typeface add load', when: () => !isTranslateMode(), run: (ctx) => ctx.openFonts?.() },
  ...SETTINGS_TABS.map((t) => ({
    id: `settings.${t.id}`,
    label: `Settings: ${t.label}`,
    group: 'Settings',
    keywords: `preferences options ${t.keywords}`,
    when: () => true,
    run: (ctx) => ctx.openSettings?.(t.id),
  })),
];

// The newest finished job with failed pages it can run again (FLOW-5).
const retryable = () => jobs.items.findLast((j) => !j.running && j.failed.length && j.retry && j.current());

// The rail's caret, from the palette: the same flag and the same save.
function toggleRaw() {
  app.sidebarHidden = !app.sidebarHidden;
  saveSidebar();
}

// "page 12", "p12", "p 12" or a bare "12": the one entry built from what was
// typed. Paged chapters only - a strip has no pages to turn, its index follows
// the scroll (see the Pager, which a strip does not mount either).
const PAGE_QUERY = /^(?:page|pg|p)?\s*(\d+)$/i;
export function pageAction(query) {
  const m = PAGE_QUERY.exec(query.trim());
  if (!m || !app.loaded || isLongstrip()) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > app.pages.length) return null;
  return {
    id: 'page.go',
    label: `Go to page ${n}`,
    group: 'Pages',
    keywords: '',
    when: () => true,
    run: () => gotoPage(n - 1),
  };
}

// Every word must appear somewhere in the label, the group or the keywords.
export function matchesQuery(entry, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${entry.label} ${entry.group} ${entry.keywords}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// What the palette lists for a query: the page jump first when the query is a
// page, then everything runnable now that matches every word.
export function paletteResults(query = '') {
  const out = [];
  const jump = pageAction(query);
  if (jump) out.push(jump);
  for (const a of [...shortcutActions(), ...ACTIONS]) {
    if (a.when() && matchesQuery(a, query)) out.push(a);
  }
  return out;
}

// The key shown beside an entry, or '' when it has none.
export const entryKey = (entry) => (entry.shortcut ? formatCombo(comboFor(entry.shortcut)) : '');

