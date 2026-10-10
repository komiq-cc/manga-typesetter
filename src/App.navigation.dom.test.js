import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
const calls = vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  return { opens: [], quits: [], close: null, destroy: vi.fn(), approval: true };
});
vi.mock('./lib/library.svelte.js', () => ({
  library: { root: '', projects: [], error: '' }, initRoot: async () => {},
  openChapter: (projectId, chapterId) => new Promise((resolve, reject) => calls.opens.push({ projectId, chapterId, resolve, reject })),
  flushBeforeLeaving: () => new Promise((resolve) => calls.quits.push({ resolve })),
  leaveApprovalCurrent: () => calls.approval,
}));
vi.mock('./lib/fonts.js', async (original) => ({ ...await original(), restoreFonts: async () => {}, scanSystemFonts: async () => {} }));
vi.mock('./lib/importer.js', async (original) => ({ ...await original(), isTauri: () => true }));
vi.mock('./lib/sidecar.js', () => ({ checkSidecar: async () => null }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: async (callback) => { calls.close = callback; }, destroy: calls.destroy,
}) }));
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
import * as store from './lib/store.svelte.js';
const { app } = store;
import { route, resetRoute, setLeaveEditorHook, goEditor, goProject } from './lib/route.svelte.js';
async function settle() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await tick(); } }
beforeEach(() => {
  resetRoute(); setLeaveEditorHook(null); app.chapterRef = null;
  calls.opens = []; calls.quits = []; calls.close = null; calls.destroy.mockClear(); calls.approval = true;
});
afterEach(async () => { await cleanup(); resetRoute(); app.chapterRef = null; });

it('a rejected superseded App open cannot navigate away from the current chapter', async () => {
  render(App); await settle();
  await goEditor('p', 'old'); await settle();
  const old = calls.opens[0]; expect(old.chapterId).toBe('old');
  await goEditor('p', 'current'); await settle();
  const current = calls.opens[1]; expect(current.chapterId).toBe('current');
  app.chapterRef = { projectId: 'p', chapterId: 'current' }; current.resolve(); await settle();
  old.reject(new Error('old open failed')); await settle();
  expect(route, 'the old catch cannot run Back on the new route').toMatchObject({ name: 'editor', chapterId: 'current' });
  expect(app.chapterRef.chapterId).toBe('current');
  expect(calls.quits).toHaveLength(0);
});

it('the current App open failure still navigates back and reports its error', async () => {
  render(App); await settle(); await goProject('p'); await goEditor('p', 'bad'); await settle();
  calls.opens[0].reject(new Error('current open failed')); await settle();
  expect(route.name).toBe('project'); expect(app.toast.msg).toContain('current open failed');
});

it.each(['new chapter', 'new choice'])('a pending quit cannot destroy the window after a %s', async (change) => {
  app.chapterRef = { projectId: 'p', chapterId: 'old' };
  render(App); await settle(); expect(calls.close).toBeTypeOf('function');
  const ref = app.chapterRef, turn = store.chapterSaveCycle?.();
  const closing = calls.close({ preventDefault: vi.fn() }); await settle();
  expect(calls.quits).toHaveLength(1);
  if (change === 'new chapter') app.chapterRef = { projectId: 'p', chapterId: 'new' };
  else calls.approval = false; // Original leave approved older bytes, then a new edit invalidated that exact approval.
  calls.quits[0].resolve(true); await closing;
  expect(calls.destroy, 'the last destroy continuation must own the approved document').not.toHaveBeenCalled();
  if (change === 'new choice') { expect(app.chapterRef).toBe(ref); expect(store.chapterSaveCycle?.()).toBe(turn); }
});

it('an unchanged approved quit still destroys the window', async () => {
  app.chapterRef = { projectId: 'p', chapterId: 'own' };
  render(App); await settle();
  const closing = calls.close({ preventDefault: vi.fn() }); await settle();
  calls.quits[0].resolve(true); await closing;
  expect(calls.destroy).toHaveBeenCalledTimes(1);
});

it('a new chapter starts its own quit while the old quit is pending', async () => {
  app.chapterRef = { projectId: 'p', chapterId: 'old' };
  render(App); await settle();
  const oldClosing = calls.close({ preventDefault: vi.fn() }); await settle();
  app.chapterRef = { projectId: 'p', chapterId: 'new' };
  const newClosing = calls.close({ preventDefault: vi.fn() }); await settle();
  expect(calls.quits, 'the new document must get its own public request').toHaveLength(2);
  calls.quits[0].resolve(true); await oldClosing;
  expect(calls.destroy).not.toHaveBeenCalled();
  calls.quits[1].resolve(true); await newClosing;
  expect(calls.destroy).toHaveBeenCalledTimes(1);
});
