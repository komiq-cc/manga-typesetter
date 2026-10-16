import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
const calls = vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  return { opens: [] };
});
vi.mock('./lib/library.svelte.js', () => ({
  library: { root: '', projects: [], error: '' }, initRoot: async () => {},
  openChapter: (projectId, chapterId) => new Promise((resolve, reject) => calls.opens.push({ projectId, chapterId, resolve, reject })),
  flushBeforeLeaving: async () => true,
  leaveApprovalCurrent: () => true,
}));
vi.mock('./lib/fonts.js', async (original) => ({ ...await original(), restoreFonts: async () => {}, scanSystemFonts: async () => {} }));
vi.mock('./lib/importer.js', async (original) => ({ ...await original(), isTauri: () => false }));
vi.mock('./lib/sidecar.js', () => ({ checkSidecar: async () => null }));
vi.mock('./lib/editor/EditorRoot.svelte', () => ({ default: () => {} }));
vi.mock('./lib/FontModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/BrushModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/SettingsModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/ExportDialog.svelte', () => ({ default: () => {} }));
vi.mock('./lib/Toast.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/HomeFrame.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/LibraryView.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/ProjectView.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/NewChapterDialog.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/ChapterSourcesSheet.svelte', () => ({ default: () => {} }));

import App from './App.svelte';
import Inspector from './lib/Inspector.svelte';
import { app, loadProjectPages, page } from './lib/store.svelte.js';
import { inspectorTab, setInspectorTab } from './lib/inspector-tabs.svelte.js';
import { defaultStyle, normalizeStyle } from './lib/data.js';
import { resetRoute, setLeaveEditorHook, goEditor } from './lib/route.svelte.js';
async function settle() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await tick(); } }

// ===========================================================================
// The window's arrows, and the controls that answer an arrow first
// ===========================================================================
// A bare arrow nudges the selected box. A focused control with arrows of its
// own (the Inspector's tab strip) answers the press where it stands, and the
// box stays where it is.

async function openEditor() {
  render(App); await settle();
  await goEditor('p', 'c'); await settle();
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  calls.opens[0].resolve(); await settle();
  loadProjectPages([{ id: 1, w: 1000, h: 1000, lines: [], boxes: [
    { id: 'b', lineN: null, text: 'HI', x: 100, y: 100, w: 200, h: 100, style: normalizeStyle(defaultStyle()) },
  ] }]);
  app.selectedId = 'b';
  await settle();
  return page().boxes[0];
}
const arrow = (el, key = 'ArrowRight') => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  resetRoute(); setLeaveEditorHook(null); app.chapterRef = null; calls.opens = [];
  setInspectorTab('text');
});
afterEach(async () => {
  await cleanup(); resetRoute(); app.chapterRef = null; app.selectedId = null; loadProjectPages([]);
  document.body.innerHTML = '';
});

it('a bare arrow still nudges the selected box', async () => {
  const b = await openEditor();
  expect(arrow(document.body).defaultPrevented).toBe(true);
  expect(b.x).toBe(101);
});

it('an arrow a focused control already answered does not also nudge the box', async () => {
  const b = await openEditor();
  const widget = document.createElement('button');
  widget.addEventListener('keydown', (e) => e.preventDefault());
  document.body.append(widget);
  arrow(widget);
  arrow(widget, 'ArrowDown');
  expect(b.x).toBe(100);
  expect(b.y).toBe(100);
});

it('the Inspector tab strip takes its arrows without moving the selected box', async () => {
  const b = await openEditor();
  render(Inspector, { onSettings: () => {} }); await settle();
  const tab = document.getElementById('insp-tab-text');
  expect(tab).not.toBe(null);
  tab.focus();
  const ev = arrow(tab);
  await settle();
  expect(ev.defaultPrevented).toBe(true);
  expect(inspectorTab.id).toBe('fill');
  expect(b.x, 'the tab press reached the window as a nudge').toBe(100);
  // The Effects sub-tabs, the same.
  setInspectorTab('effects'); await settle();
  const sub = document.querySelector('[id^="insp-subtab-"][aria-selected="true"]');
  expect(sub).not.toBe(null);
  arrow(sub);
  await settle();
  expect(b.x).toBe(100);
});
