import { describe, it, expect, beforeEach, vi } from 'vitest';

// Installing an update ends the process (Windows exits inside `install()`,
// everywhere else `relaunch()` restarts), and neither is a close request, so
// the quit routes' save never ran. These pin that the updater now asks the same
// question a quit asks, and takes no for an answer.
//
// `verdict`: what the chapter's save before leaving resolves to.
// `current`: whether that yes still belongs to the document on screen.
// `verdicts`: per-call overrides, consumed in order, for the second question.
// `duringSave`: runs while the save is in flight, after it has been asked for.
const h = vi.hoisted(() => ({
  ops: [],
  app: { chapterRef: null },
  turn: 1,
  verdict: true,
  verdicts: [],
  current: true,
  duringSave: null,
}));

vi.mock('./importer.js', () => ({ isTauri: () => false }));
vi.mock('./store.svelte.js', () => ({
  app: h.app,
  chapterSaveCycle: () => h.turn,
  flushSidebar: () => h.ops.push('flush-sidebar'),
}));
vi.mock('./editor/panels.svelte.js', () => ({
  flushPanels: () => h.ops.push('flush-panels'),
}));
vi.mock('./library.svelte.js', () => {
  const issued = new WeakSet();
  return {
    flushBeforeLeaving(where) {
      h.ops.push(`save:${where}`);
      h.duringSave?.();
      const p = Promise.resolve(h.verdicts.length ? h.verdicts.shift() : h.verdict);
      issued.add(p);
      return p;
    },
    leaveApprovalCurrent: (p) => issued.has(p) && h.current,
  };
});
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: async () => {
    h.ops.push('relaunch');
  },
}));

const { installUpdate } = await import('./updater.js');

function fakeUpdate() {
  return {
    async download(onEvent) {
      h.ops.push('download');
      onEvent({ event: 'Started', data: { contentLength: 10 } });
      onEvent({ event: 'Progress', data: { chunkLength: 10 } });
      onEvent({ event: 'Finished' });
    },
    async install() {
      h.ops.push('install');
    },
  };
}

const CHAPTER = { projectId: 'p1', chapterId: 'c1' };

beforeEach(() => {
  h.ops.length = 0;
  h.app.chapterRef = CHAPTER;
  h.turn = 1;
  h.verdict = true;
  h.verdicts.length = 0;
  h.current = true;
  h.duringSave = null;
});

describe('installUpdate and the open chapter', () => {
  it('saves the open chapter before the install that can end the process, and again before the restart', async () => {
    const progress = [];
    await installUpdate(fakeUpdate(), (p) => progress.push(p.percent));
    expect(h.ops).toEqual([
      'download',
      'flush-sidebar', 'flush-panels', 'save:quit',
      'install',
      'flush-sidebar', 'flush-panels', 'save:quit',
      'relaunch',
    ]);
    expect(progress).toEqual([0, 100, 100]);
  });

  it('installs nothing when the save refuses or is still writing', async () => {
    h.verdict = false;
    const err = await installUpdate(fakeUpdate()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // In its own words, not wrapped as a failed install.
    expect(err.message).toMatch(/^Not installed: .*not been saved/);
    expect(h.ops).not.toContain('install');
    expect(h.ops).not.toContain('relaunch');
  });

  it('installs nothing when the yes no longer belongs to the document on screen', async () => {
    h.current = false;
    await expect(installUpdate(fakeUpdate())).rejects.toThrow(/Not installed/);
    expect(h.ops).not.toContain('install');
  });

  it('installs nothing when the chapter changed while its save was being awaited', async () => {
    // After the save was asked for and before its answer is read: a new
    // document turn, as an edit or a reload would make.
    h.duringSave = () => {
      h.turn = 2;
    };
    await expect(installUpdate(fakeUpdate())).rejects.toThrow(/Not installed/);
    expect(h.ops).not.toContain('install');
  });

  it('the retry after a refusal goes through the same door, without downloading again', async () => {
    const update = fakeUpdate();
    h.verdict = false;
    await expect(installUpdate(update)).rejects.toThrow(/Not installed/);
    // The save's own two-step escape decides the second answer; here it says yes.
    h.verdict = true;
    h.ops.length = 0;
    await installUpdate(update);
    expect(h.ops.filter((op) => op === 'download')).toEqual([]);
    expect(h.ops).toEqual([
      'flush-sidebar', 'flush-panels', 'save:quit',
      'install',
      'flush-sidebar', 'flush-panels', 'save:quit',
      'relaunch',
    ]);
  });

  it('does not restart when the save after the install says no', async () => {
    h.verdicts.push(true, false);
    await expect(installUpdate(fakeUpdate())).rejects.toThrow(/installed, but the app was not restarted/);
    expect(h.ops).toContain('install');
    expect(h.ops).not.toContain('relaunch');
  });

  it('with no chapter open, flushes the preference tiers and installs without asking the library', async () => {
    h.app.chapterRef = null;
    await installUpdate(fakeUpdate());
    expect(h.ops).not.toContain('save:quit');
    expect(h.ops).toEqual([
      'download',
      'flush-sidebar', 'flush-panels',
      'install',
      'flush-sidebar', 'flush-panels',
      'relaunch',
    ]);
  });

  it('still reports a failed download as an install failure', async () => {
    const update = fakeUpdate();
    update.download = async () => {
      throw new Error('network down');
    };
    await expect(installUpdate(update)).rejects.toThrow('Failed to install update: network down');
    expect(h.ops).not.toContain('save:quit');
    expect(h.ops).not.toContain('install');
  });
});
