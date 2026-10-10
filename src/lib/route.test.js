import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  route,
  goLibrary,
  goProject,
  goEditor,
  goBack,
  setLeaveEditorHook,
  resetRoute,
} from './route.svelte.js';

beforeEach(() => {
  setLeaveEditorHook(null);
  resetRoute();
});

describe('route', () => {
  it('starts at the library', () => {
    expect(route.name).toBe('library');
    expect(route.projectId).toBe(null);
    expect(route.chapterId).toBe(null);
  });

  it('carries ids into the project view', () => {
    goProject('p1');
    expect(route.name).toBe('project');
    expect(route.projectId).toBe('p1');
    expect(route.chapterId).toBe(null);
  });

  it('carries both ids into the editor', () => {
    goEditor('p1', 'c1');
    expect(route.name).toBe('editor');
    expect(route.projectId).toBe('p1');
    expect(route.chapterId).toBe('c1');
  });

  it('goes back to the previous entry', () => {
    goProject('p1');
    goEditor('p1', 'c1');
    goBack();
    expect(route.name).toBe('project');
    expect(route.projectId).toBe('p1');
  });

  it('stays at the library when there is no history', () => {
    goBack();
    expect(route.name).toBe('library');
  });

  it('does not record a no-op navigation in history', () => {
    goProject('p1');
    goProject('p1');
    goBack();
    expect(route.name).toBe('library');
  });
});

describe('leave-editor hook', () => {
  it('fires when leaving the editor', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    goEditor('p1', 'c1');
    expect(hook).not.toHaveBeenCalled();
    await goLibrary();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not fire when navigating between non-editor views', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    await goProject('p1');
    await goLibrary();
    expect(hook).not.toHaveBeenCalled();
  });

  it('fires on goBack out of the editor', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    goProject('p1');
    goEditor('p1', 'c1');
    await goBack();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});


describe('overlapping navigation ownership', () => {
  it('an older fulfilled leave cannot overwrite the newer route', async () => {
    await goEditor('p1', 'c1');
    const releases = [];
    setLeaveEditorHook(() => new Promise((resolve) => releases.push(resolve)));
    const old = goLibrary();
    const newer = goProject('p2');
    releases[1]();
    expect(await newer).toBe(true);
    releases[0]();
    expect(await old).toBe(false);
    expect(route).toMatchObject({ name: 'project', projectId: 'p2' });
  });

  it('a no-op request keeps the current editor and supersedes an older leave', async () => {
    await goEditor('p1', 'c1');
    let release;
    setLeaveEditorHook(() => new Promise((resolve) => { release = resolve; }));
    const old = goLibrary();
    expect(await goEditor('p1', 'c1')).toBe(true);
    release();
    expect(await old).toBe(false);
    expect(route).toMatchObject({ name: 'editor', chapterId: 'c1' });
  });
});


it.each(['same editor', 'refused newer leave'])('a superseded Back retains history after %s', async (newerKind) => {
  await goProject('p1'); await goEditor('p1', 'c1');
  let release;
  let calls = 0;
  setLeaveEditorHook(() => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.reject(new Error('stay')));
  const old = goBack();
  if (newerKind === 'same editor') expect(await goEditor('p1', 'c1')).toBe(true);
  else expect(await goLibrary()).toBe(false);
  release(); expect(await old).toBe(false);
  expect(route.name).toBe('editor');
  setLeaveEditorHook(async () => {});
  expect(await goBack(), 'the Back destination was never consumed by superseded work').toBe(true);
  expect(route).toMatchObject({ name: 'project', projectId: 'p1' });
});
