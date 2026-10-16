import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeStack, stackFrom, emptyDoc, appendEntry, graft } from './history-file.svelte.js';

vi.mock('../fsx.js', () => {
  const files = new Map();
  return {
    files,
    fsx: {
      join: async (...p) => p.join('/'),
      mkdir: async () => {},
      exists: async (p) => files.has(p),
      readTextFile: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      writeTextFileAtomic: async (p, c) => void files.set(p, c),
    },
  };
});

describe('the history document', () => {
  const order = { t: 'order', pageId: 3, before: [10, 20], numbers: [[20, 1], [10, 2]] };
  const line = { t: 'line', pageId: 3, lineN: 10, before: 'old', after: 'new' };

  it('remaps an off-screen stack before appending a reading-order entry', () => {
    const before = mergeStack(emptyDoc(), 3, { undo: [line], redo: [line] });
    const after = appendEntry(before, 3, order);
    expect(stackFrom(after, 3)).toEqual({ undo: [{ ...line, lineN: 2 }, order], redo: [] });
    expect(stackFrom(before, 3)).toEqual({ undo: [line], redo: [line] });
  });

  it('remaps history read from disk through moves made while the read was pending', () => {
    const stored = { undo: [line], redo: [] };
    expect(graft(stored, { undo: [order], redo: [] })).toEqual({ undo: [{ ...line, lineN: 2 }, order], redo: [] });
    expect(graft(stored, { undo: [], redo: [order] })).toEqual({ undo: [line], redo: [order] });
    expect(stored.undo[0]).toBe(line);
  });

  it('starts empty and versioned', () => {
    expect(emptyDoc()).toEqual({ version: 1, pages: {} });
  });

  it('stores a page stack under its id as a string key', () => {
    const doc = mergeStack(emptyDoc(), 3, { undo: [{ t: 'move' }], redo: [] });
    expect(Object.keys(doc.pages)).toEqual(['3']);
    expect(doc.pages['3'].undo.length).toBe(1);
  });

  it('drops a page whose stack is empty rather than growing the file forever', () => {
    let doc = mergeStack(emptyDoc(), 3, { undo: [{ t: 'move' }], redo: [] });
    doc = mergeStack(doc, 3, { undo: [], redo: [] });
    expect(doc.pages['3']).toBeUndefined();
  });

  it('reads a stack back, and an unknown page reads as empty', () => {
    const doc = mergeStack(emptyDoc(), 7, { undo: [{ t: 'move' }], redo: [{ t: 'text' }] });
    expect(stackFrom(doc, 7).undo.length).toBe(1);
    expect(stackFrom(doc, 8)).toEqual({ undo: [], redo: [] });
  });

  it('treats a corrupt document as empty', () => {
    expect(stackFrom(null, 1)).toEqual({ undo: [], redo: [] });
    expect(stackFrom({ version: 99 }, 1)).toEqual({ undo: [], redo: [] });
  });
});

describe('the file on disk', () => {
  const CH1 = '/lib/proj/ch1';
  const CH2 = '/lib/proj/ch2';
  const PATH = `${CH1}/logs/history.json`;
  const PATH2 = `${CH2}/logs/history.json`;

  // A record for page 1, distinguishable from the next one.
  const anEntry = (x) => ({
    t: 'move',
    pageId: 1,
    boxId: 'b1',
    before: { x: 0, y: 0 },
    after: { x, y: x },
  });

  const undoCount = (files, path, key) => JSON.parse(files.get(path)).pages[key].undo.length;

  const mod = () => import('./history-file.svelte.js');
  const hist = () => import('./history.svelte.js');
  const disk = () => import('../fsx.js');
  const store = () => import('../store.svelte.js');

  // A read the test holds open. Everything the user can do while a chapter's
  // history is still coming off disk happens in that window, and it is the only
  // way to put an interleave under this module deterministically.
  const heldRead = async () => {
    const { fsx, files } = await disk();
    let release;
    const gate = new Promise((r) => (release = r));
    const spy = vi.spyOn(fsx, 'readTextFile').mockImplementation(async (p) => {
      await gate;
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    });
    return { release: () => release(), restore: () => spy.mockRestore() };
  };

  // Every test starts from a closed chapter, an empty stack and an empty disk -
  // the module keeps all three across a test file.
  beforeEach(async () => {
    const { __setDir } = await mod();
    const { resetHistory } = await hist();
    const { files } = await disk();
    __setDir(null);
    resetHistory();
    files.clear();
  });

  it('writes what it was given and reads it back', async () => {
    const { __setDir, switchHistoryPage, flushHistory } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 1, y: 1 } });
    await switchHistoryPage(1, 2);
    expect(history.canUndo).toBe(false);
    await switchHistoryPage(2, 1);
    expect(history.canUndo).toBe(true);
    await flushHistory();
    expect(undoCount(files, PATH, '1')).toBe(1);
  });

  // ===== a page turn is not an edit =====
  //
  // Reading through a chapter used to schedule a full rewrite of the history
  // document on every single turn - serialise every page's stack, write the file
  // - to store back exactly the bytes already in it. So the write is now
  // conditional on the page being left actually having something new to say.
  it('schedules no write for a page turn that changed nothing', async () => {
    const { __setDir, switchHistoryPage } = await mod();
    const { files } = await disk();
    vi.useFakeTimers();
    try {
      __setDir(CH1);
      // Four turns through a chapter nobody has edited. Nothing to write, and
      // nothing written - the same promise `flushHistory` keeps, that a chapter
      // opened, read and left leaves no `logs/` behind.
      for (let i = 1; i <= 4; i++) await switchHistoryPage(i, i + 1);
      await vi.advanceTimersByTimeAsync(800);
      expect(files.has(PATH)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ...and it still writes for one that did. The skip is a comparison of what
  // the page hands back against what the document already holds, so anything
  // that touched the stack fails it.
  it('still schedules a write for a page turn that leaves an edit behind', async () => {
    const { __setDir, switchHistoryPage } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    vi.useFakeTimers();
    try {
      __setDir(CH1);
      record(anEntry(4));
      await switchHistoryPage(1, 2);
      await vi.advanceTimersByTimeAsync(800);
      expect(undoCount(files, PATH, '1')).toBe(1);

      // Back to page 1, one more edit, and away again. The file on disk is a
      // page behind, and the turn is what says so.
      files.clear();
      await switchHistoryPage(2, 1);
      record(anEntry(5));
      await switchHistoryPage(1, 2);
      await vi.advanceTimersByTimeAsync(800);
      expect(undoCount(files, PATH, '1')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // And a turn away from a page whose stack is unchanged must not lose it. The
  // skip is a skipped WRITE, never a skipped hand-back: the entries have to be
  // there when the user turns back.
  it('keeps a stack it declined to rewrite', async () => {
    const { __setDir, switchHistoryPage, flushHistory } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(2));
    await switchHistoryPage(1, 2);
    await switchHistoryPage(2, 3);
    await switchHistoryPage(3, 1);
    expect(history.canUndo).toBe(true);
    await flushHistory();
    expect(undoCount(files, PATH, '1')).toBe(1);
  });

  // The mechanism that saves an edit made and then abandoned: no page turn, no
  // close, just a record and the clock.
  it('writes on its own debounce, with no page turn to prompt it', async () => {
    const { __setDir } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    vi.useFakeTimers();
    try {
      __setDir(CH1);
      record(anEntry(7));
      expect(files.has(PATH)).toBe(false);
      await vi.advanceTimersByTimeAsync(800);
      expect(undoCount(files, PATH, '1')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The whole point of the file: the stack of a page nobody is looking at is
  // still there after the app has been shut down and started again.
  it('restores a page stack written by an earlier run', async () => {
    const { files } = await disk();
    files.set(PATH, JSON.stringify({ version: 1, pages: { 3: { undo: [anEntry(5)], redo: [] } } }));
    const { openHistory } = await mod();
    const { history } = await hist();
    await openHistory(CH1, 3);
    expect(history.canUndo).toBe(true);
    expect(history.pageId).toBe(3);
  });

  it('opens with no history rather than failing on a corrupt file', async () => {
    const { files } = await disk();
    files.set(PATH, '{ this is not json');
    const { openHistory } = await mod();
    const { history } = await hist();
    await expect(openHistory(CH1, 3)).resolves.toBeUndefined();
    expect(history.canUndo).toBe(false);
  });

  // The chapter being left is flushed before anything is reset. Without it, a
  // chapter switched away from inside the debounce window loses its records
  // with nothing having failed.
  it('flushes the chapter it is leaving rather than dropping its records', async () => {
    const { __setDir, openHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(2));
    expect(files.has(PATH)).toBe(false); // still inside the debounce window
    await openHistory(CH2, 1);
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1);
  });

  // A route re-entry lands on the chapter already open. It resets the document
  // just as hard as a switch does, so it has to write first.
  it('flushes before a reopen of the chapter already open', async () => {
    const { __setDir, openHistory, switchHistoryPage } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(9));
    expect(files.has(PATH)).toBe(false);
    await openHistory(CH1, 2);
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1);
    // And the records came back with the reopened chapter, not merely survived
    // on disk.
    await switchHistoryPage(2, 1);
    expect(history.canUndo).toBe(true);
  });

  // A write bound to the chapter it was started for. Read live under the awaits,
  // the path would come from one chapter and the body from the next.
  it('keeps a write in flight bound to the chapter that started it', async () => {
    const { __setDir, openHistory, flushHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(3));
    const pending = flushHistory(); // in flight, deliberately not awaited yet
    await openHistory(CH2, 1);
    await pending;
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1); // not the empty document
    expect(files.has(PATH2)).toBe(false); // and nothing of ch2's in ch1's file
  });

  // Closing hands the live page's stack over on the way out, and it does not
  // need to be told which page that is.
  it('saves the live page on close even when the caller names no page', async () => {
    const { __setDir, closeHistory, flushHistory } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(4));
    await closeHistory();
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1);
    expect(history.canUndo).toBe(false);
    // No chapter is open any more, so a late debounce writes nothing at all.
    files.clear();
    await flushHistory();
    expect(files.size).toBe(0);
  });

  // closeChapter fires the close and does not wait on it. A chapter opened
  // while that write is in flight must survive the close resuming underneath
  // it: reset unconditionally, the new chapter loses its stack and - with `dir`
  // cleared - every later flush returns early, so nothing it records ever
  // reaches disk again for the rest of the session.
  it('leaves a chapter opened during its close alone', async () => {
    const { __setDir, closeHistory, flushHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(1));
    const closing = closeHistory(); // in flight, deliberately not awaited yet
    // What an `openHistory` landing under that flush leaves behind - the seam
    // exists to put the module in exactly the state an open would. Driving the
    // real `openHistory` here cannot reproduce the interleave: it flushes on
    // the way in, so it queues behind this very write and always finishes
    // second.
    __setDir(CH2);
    await closing;
    // The chapter that was closing still wrote what it had…
    expect(undoCount(files, PATH, '1')).toBe(1);
    // …and the one that opened underneath it is still the live chapter, still
    // writing to its own file.
    record(anEntry(8));
    await flushHistory();
    expect(undoCount(files, PATH2, '1')).toBe(1);
  });

  // A step is an edit as far as the file is concerned. The document's own
  // autosave runs for the same press; a step that scheduled nothing here left
  // chapter.json past the undo and history.json still before it, and a crash in
  // that window brought the app back with a journal that no longer described
  // the document it addressed.
  it('writes the journal after an undo, with no page turn to prompt it', async () => {
    const { __setDir } = await mod();
    const { record, undo } = await hist();
    const { loadProjectPages } = await store();
    const { files } = await disk();
    vi.useFakeTimers();
    try {
      loadProjectPages([
        {
          id: 1,
          w: 800,
          h: 1200,
          lines: [],
          boxes: [{ id: 'b1', lineN: null, text: 'one', x: 0, y: 0, w: 100, h: 40, style: null }],
        },
      ]);
      __setDir(CH1);
      record(anEntry(7));
      await vi.advanceTimersByTimeAsync(800);
      expect(undoCount(files, PATH, '1')).toBe(1);
      expect(undo()).toBe(true);
      await vi.advanceTimersByTimeAsync(800);
      const saved = JSON.parse(files.get(PATH)).pages['1'];
      // The entry moved to the redo side on disk, not just in memory.
      expect(saved.undo).toHaveLength(0);
      expect(saved.redo).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // `openChapter` starts the load and does not wait on it, so everything below
  // happens while the disk is still answering. All of it is NEWER than what the
  // disk has to say, and none of it may be overwritten by the read landing.
  describe('a chapter that is still loading', () => {
    const seed = async (pages) => {
      const { files } = await disk();
      files.set(PATH, JSON.stringify({ version: 1, pages }));
    };

    // The page the open was called for is not necessarily the page the user is
    // on by the time the read comes back. Loaded blindly, page 1's stack landed
    // in memory while page 2 was on screen - every press from then on rewinding
    // a box the user could not see.
    it('loads the page the user is on now, not the one it was called for', async () => {
      await seed({ 1: { undo: [anEntry(1)], redo: [] }, 2: { undo: [anEntry(2)], redo: [] } });
      const { openHistory, switchHistoryPage } = await mod();
      const { history, peekStack } = await hist();
      const read = await heldRead();
      try {
        const opening = openHistory(CH1, 1);
        await switchHistoryPage(1, 2); // the reader turns the page mid-load
        read.release();
        await opening;
        expect(history.pageId).toBe(2);
        expect(peekStack().undo.map((e) => e.after.x)).toEqual([2]);
      } finally {
        read.restore();
      }
    });

    // And an edit made in that window is the newest thing there is. It used to
    // be thrown away by the load landing on top of it - an undo the user had
    // already earned, gone, with nothing to say it had ever existed.
    it('keeps an edit made while it was still loading, on top of what came off disk', async () => {
      await seed({ 1: { undo: [anEntry(1)], redo: [] } });
      const { openHistory } = await mod();
      const { record, peekStack } = await hist();
      const read = await heldRead();
      try {
        const opening = openHistory(CH1, 1);
        record(anEntry(9)); // the reader edits the page while it loads
        read.release();
        await opening;
        // Oldest first: the stored history underneath, this session's edit on
        // top, and one press of undo takes the edit the user just made.
        expect(peekStack().undo.map((e) => e.after.x)).toEqual([1, 9]);
      } finally {
        read.restore();
      }
    });

    // The same page merged into the document rather than the live stack - an
    // off-screen record filed while the read was in flight.
    it('keeps an off-screen record made while it was still loading', async () => {
      await seed({ 2: { undo: [anEntry(1)], redo: [] } });
      const { openHistory, flushHistory } = await mod();
      const { record } = await hist();
      const { files } = await disk();
      const read = await heldRead();
      try {
        const opening = openHistory(CH1, 1);
        record({ ...anEntry(9), pageId: 2 });
        read.release();
        await opening;
        await flushHistory();
        expect(JSON.parse(files.get(PATH)).pages['2'].undo.map((e) => e.after.x)).toEqual([1, 9]);
      } finally {
        read.restore();
      }
    });

    // And a load whose chapter has been closed and opened again underneath it
    // has nothing left to say. The path is the same on both sides of that, which
    // is why the guard cannot be a path.
    it('drops what it read when the chapter was closed and reopened underneath it', async () => {
      await seed({ 1: { undo: [anEntry(1)], redo: [] } });
      const { openHistory, closeHistory, __setDir } = await mod();
      const { record, peekStack } = await hist();
      const read = await heldRead();
      try {
        const opening = openHistory(CH1, 1);
        await closeHistory();
        __setDir(CH1); // back into the same chapter - a new session, same path
        record(anEntry(9));
        read.release();
        await opening;
        expect(peekStack().undo.map((e) => e.after.x)).toEqual([9]);
      } finally {
        read.restore();
      }
    });
  });

  // The other half of the same identity problem. `closeChapter` fires the close
  // and does not wait on it, and the reader's own back button puts them straight
  // back into the chapter they just left: the close then resumed, found its own
  // path still in place, and tore down the session that had landed underneath it
  // - stack wiped and `dir` nulled, so nothing that session recorded ever
  // reached disk again.
  it('leaves a reopen of the same chapter alone while its close is still flushing', async () => {
    const { __setDir, closeHistory, flushHistory } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(1));
    const closing = closeHistory(); // in flight, deliberately not awaited yet
    __setDir(CH1); // the same chapter, opened again - see the note above
    record(anEntry(2));
    await closing;
    // The new session still has its stack…
    expect(history.canUndo).toBe(true);
    // …and still reaches disk, with its own record and not the closed session's.
    await flushHistory();
    expect(JSON.parse(files.get(PATH)).pages['1'].undo.map((e) => e.after.x)).toEqual([2]);
  });

  // The desync this seam exists to prevent, end to end. Before it, an entry
  // naming an off-screen page went onto the LIVE stack and then told this module
  // that page was live - so the next write filed the page on screen's whole
  // stack under the other page's key. Two pages' undo, gone, in one press of
  // Apply.
  it('files an entry naming an off-screen page onto that page, not the live one', async () => {
    const { __setDir, flushHistory } = await mod();
    const { record, history, peekStack } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(1)); // page 1 is the live one, with one entry of its own
    record({
      t: 'bulk',
      pageId: 2,
      items: [{ boxId: 'b7', pageId: 2, before: { size: 10 }, after: { size: 30 } }],
    });
    // The live stack never saw it: `canUndo` is still page 1's own entry, and
    // one press of undo is still one press.
    expect(history.canUndo).toBe(true);
    expect(peekStack().undo).toHaveLength(1);
    expect(peekStack().undo[0].pageId).toBe(1);
    await flushHistory();
    const doc = JSON.parse(files.get(PATH));
    expect(doc.pages['1'].undo).toHaveLength(1);
    expect(doc.pages['2'].undo).toHaveLength(1);
    expect(doc.pages['2'].undo[0].t).toBe('bulk');
  });

  // Everything the live stack does to a new entry, done to a stored one.
  it('caps an off-screen stack and forfeits its redo like any other', async () => {
    const { openHistory, flushHistory } = await mod();
    const { record, MAX_STEPS } = await hist();
    const { files } = await disk();
    // Page 2 comes off disk with a redo branch and no undo - a page the user
    // undid their way back through and then left.
    files.set(PATH, JSON.stringify({ version: 1, pages: { 2: { undo: [], redo: [anEntry(1)] } } }));
    await openHistory(CH1, 1); // page 1 is the live one
    for (let i = 0; i < MAX_STEPS + 2; i++) {
      record({ t: 'move', pageId: 2, boxId: 'b7', before: { x: i }, after: { x: i + 1 } });
    }
    await flushHistory();
    const doc = JSON.parse(files.get(PATH));
    expect(doc.pages['2'].undo).toHaveLength(MAX_STEPS);
    // The oldest two fell off the bottom, not the newest two off the top.
    expect(doc.pages['2'].undo[0].before.x).toBe(2);
    expect(doc.pages['2'].redo).toEqual([]);
  });

  // A chapter this module is not keeping a document for has nothing to merge
  // into - the entry stays where it has always been.
  it('refuses an off-screen entry when no chapter is open', async () => {
    const { __setDir } = await mod();
    const { record, peekStack } = await hist();
    __setDir(null);
    record({ t: 'move', pageId: 2, boxId: 'b7', before: { x: 0 }, after: { x: 1 } });
    expect(peekStack().undo).toHaveLength(1);
  });

  it('files the live page under its own key when the page turn does not say', async () => {
    const { __setDir, switchHistoryPage, flushHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(6));
    await switchHistoryPage(undefined, 2);
    await flushHistory();
    expect(Object.keys(JSON.parse(files.get(PATH)).pages)).toEqual(['1']);
  });

  // A chapter the user opened, looked at and left is not a chapter with a
  // history, and it must not acquire a logs directory to explain.
  it('leaves nothing behind for a chapter that was opened and not edited', async () => {
    const { openHistory, closeHistory } = await mod();
    const { fsx, files } = await disk();
    const mkdir = vi.spyOn(fsx, 'mkdir');
    try {
      await openHistory(CH1, 1);
      await closeHistory();
      expect(files.size).toBe(0);
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
  });

  // The other direction: once there is a file, an empty document has to reach
  // it, or a history the user has undone their way out of would never clear.
  it('writes the empty document over a history that has been undone away', async () => {
    const { files } = await disk();
    files.set(PATH, JSON.stringify({ version: 1, pages: { 1: { undo: [anEntry(5)], redo: [] } } }));
    const { openHistory, closeHistory } = await mod();
    const { loadStack, history } = await hist();
    await openHistory(CH1, 1);
    expect(history.canUndo).toBe(true);
    loadStack(1, { undo: [], redo: [] }); // undone to the bottom
    await closeHistory();
    expect(JSON.parse(files.get(PATH))).toEqual({ version: 1, pages: {} });
  });

  it('survives a disk that refuses', async () => {
    const { __setDir, flushHistory } = await mod();
    const { record } = await hist();
    const { fsx, files } = await disk();
    __setDir(CH1);
    // There has to be something to write, and a file already there to keep up
    // to date, or the flush below has nothing to refuse.
    record(anEntry(1));
    await flushHistory();
    expect(files.has(PATH)).toBe(true);
    const boom = vi.spyOn(fsx, 'writeTextFileAtomic').mockRejectedValue(new Error('read-only'));
    await expect(flushHistory()).resolves.toBeUndefined();
    boom.mockRestore();
    // The queue survives it: the next write still lands.
    files.delete(PATH);
    await flushHistory();
    expect(undoCount(files, PATH, '1')).toBe(1);
  });
});

// A page rescaled under its history: every geometry pair moves into the new
// space, the solver's reference size with it (it is a size like the style's),
// and so do the balloon a refit recorded and the boxes a queue line edit did.
describe('rescaling a recorded entry', () => {
  it('scales the solver record, a refit fit and a line edit’s boxes', async () => {
    const { rescaleEntry } = await import('./history-file.svelte.js');
    const geom = (k) => ({ x: 10 * k, y: 20 * k, w: 100 * k, h: 40 * k, size: 20 * k, auto: { on: true, refSize: 26 * k, locks: {}, status: 'ok', stamp: 's' } });
    const refit = rescaleEntry({ t: 'refit', geomBefore: { ...geom(1), fit: { kind: 'ellipse', cx: 50, cy: 50, rx: 30, ry: 20 } }, geomAfter: geom(1) }, 2, 2);
    expect(refit.geomBefore.auto.refSize).toBe(52);
    expect(refit.geomBefore.fit).toEqual({ kind: 'ellipse', cx: 100, cy: 100, rx: 60, ry: 40 });
    expect(refit.geomAfter).toEqual(geom(2));
    const line = rescaleEntry({ t: 'line', lineN: 1, before: 'a', after: 'b', boxes: [{ boxId: 'b1', geomBefore: geom(1), geomAfter: geom(1) }] }, 2, 2);
    expect(line.boxes[0].geomBefore).toEqual(geom(2));
    expect(line.boxes[0].geomAfter).toEqual(geom(2));
  });

  it('scales a batch placement’s boxes, and adds no bulk keys to them', async () => {
    const { rescaleEntry } = await import('./history-file.svelte.js');
    const box = { id: 'b1', lineN: 1, text: null, x: 10, y: 20, w: 100, h: 40, style: { size: 20 }, fit: null, auto: { on: true, refSize: 26, locks: {}, status: 'ok', stamp: 's' } };
    const e = rescaleEntry({ t: 'placeMany', pageId: 1, items: [{ index: 0, box }] }, 2, 2);
    expect(Object.keys(e.items[0]).sort()).toEqual(['box', 'index']);
    expect([e.items[0].box.x, e.items[0].box.w, e.items[0].box.style.size, e.items[0].box.auto.refSize]).toEqual([20, 200, 40, 52]);
    expect(e.items[0].box.auto.stamp).toBe('s');
  });

  it('scales the style a bulk entry walks back for new boxes', async () => {
    const { rescaleEntry } = await import('./history-file.svelte.js');
    const e = rescaleEntry({ t: 'bulk', pageId: 1, items: [], lastStyleBefore: { size: 20 }, lastStyleAfter: { size: 30 } }, 2, 2);
    expect([e.lastStyleBefore.size, e.lastStyleAfter.size]).toEqual([40, 60]);
  });
});
