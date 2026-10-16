import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  app, loadProjectPages, page, moveLine, lineByN, boxText, setLineText,
  settleEdits, placedLineNs, placeableDetectedLines, detectedRectFor, deleteBox,
} from './store.svelte.js';
import { initHistory, resetHistory, peekStack, loadStack, record, undo, redo } from './editor/history.svelte.js';
import { buildTextJson } from './text-json.js';
import { normalizeTranslations } from './importer.js';
import { serializePage } from './psd.js';
import { snapshotExportPages } from './export-pages.svelte.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => ({
  id: 1, w: 800, h: 1200,
  // Sparse and deliberately not sorted: undo must recover the old numbers AND
  // the old array order, including the free row between imported rows.
  lines: [
    { n: 10, jp: 'あ', en: 'alpha', tags: ['shout'] },
    { n: -2, jp: '', en: 'free' },
    { n: 30, jp: 'い', en: 'beta' },
    { n: 20, jp: 'う', en: 'gamma' },
  ],
  boxes: [
    { id: 'b1', lineN: 10, text: null, x: 10, y: 20, w: 90, h: 50 },
    { id: 'b2', lineN: 30, text: null, x: 20, y: 30, w: 90, h: 50 },
    { id: 'b3', lineN: 10, text: 'override', x: 30, y: 40, w: 90, h: 50 },
    { id: 'b4', lineN: -2, text: null, x: 40, y: 50, w: 90, h: 50 },
    { id: 'b5', lineN: null, text: 'legacy', x: 50, y: 60, w: 90, h: 50 },
  ],
  detect: { panels: [[0, 0, 800, 1200]], boxes: [
    { n: 10, box: [10, 20, 100, 70], vertical: true, fit: null },
    { n: 30, box: [20, 30, 110, 80], font_size: 16 },
    { n: 20, box: [30, 40, 120, 90], vertical: false },
    { n: -2, box: [40, 50, 130, 100] },
  ] },
});

beforeEach(() => {
  vi.useFakeTimers();
  app.chapterRef = null;
  app.chapterMode = 'typeset';
  loadProjectPages([fixture()]);
  page().activeLineN = 30;
  initHistory();
  resetHistory();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('reading order joins', () => {
  it('moves every join together and undoes the exact page in one step', () => {
    const p = page();
    const before = copy(p);
    const free = p.lines[1];
    const boxes = p.boxes.slice();
    const detected = p.detect.boxes.slice();
    const text = p.boxes.map((b) => boxText(b, p));
    expect(moveLine(20, 1)).toBe(true);
    expect(p.lines.map((l) => [l.n, l.en])).toEqual([[1, 'gamma'], [-2, 'free'], [2, 'alpha'], [3, 'beta']]);
    expect(p.lines[1]).toBe(free);
    expect(p.boxes.map((b) => b.lineN)).toEqual([2, 3, 2, -2, null]);
    expect(p.activeLineN).toBe(3);
    expect(p.detect.boxes.map((d) => d.n)).toEqual([2, 3, 1, -2]);
    for (const [i, b] of p.boxes.entries()) {
      expect(b).toBe(boxes[i]);
      expect(boxText(b, p)).toBe(text[i]);
    }
    for (const [i, d] of p.detect.boxes.entries()) expect(d).toBe(detected[i]);
    expect(lineByN(p, 2).tags).toEqual(['shout']);
    expect(placedLineNs(p)).toEqual(new Set([2, 3, -2]));
    expect(placeableDetectedLines(p).map((l) => l.n)).toEqual([1]);
    expect(detectedRectFor(p, 1)).toEqual([30, 40, 120, 90]);
    expect(peekStack().undo).toEqual([{
      t: 'order', pageId: 1, before: [10, 30, 20], numbers: [[20, 1], [10, 2], [30, 3]],
    }]);
    const after = copy(p);
    expect(undo()).toBe(true);
    expect(copy(p)).toEqual(before);
    expect(peekStack().undo).toHaveLength(0);
    expect(redo()).toBe(true);
    expect(copy(p)).toEqual(after);
  });

  it('settles typing under its old number, then remaps its history with the page', () => {
    const p = page();
    setLineText(p, 30, 'edited beta');
    expect(moveLine(20, 1)).toBe(true);
    expect(peekStack().undo.map((e) => [e.t, e.lineN])).toEqual([['line', 3], ['order', undefined]]);
    expect(undo()).toBe(true);
    expect(peekStack().undo[0].lineN).toBe(30);
    expect(lineByN(p, 30).en).toBe('edited beta');
    expect(undo()).toBe(true);
    expect(lineByN(p, 30).en).toBe('beta');
    expect(redo()).toBe(true);
    expect(redo()).toBe(true);
    expect(lineByN(p, 3).en).toBe('edited beta');
    expect(boxText(p.boxes[1], p)).toBe('edited beta');
  });

  it('remaps deleted box snapshots, batch placements and historical queue positions', () => {
    const p = page();
    const b2 = copy(p.boxes[1]);
    record({ t: 'placeMany', pageId: 1, items: [{ box: b2, index: 1 }], activeBefore: 30, activeAfter: 20 });
    deleteBox('b1');
    expect(moveLine(20, 1)).toBe(true);
    const [batch, deletion] = peekStack().undo;
    expect([batch.items[0].box.lineN, batch.activeBefore, batch.activeAfter]).toEqual([3, 3, 1]);
    expect([deletion.box.lineN, deletion.activeBefore, deletion.activeAfter]).toEqual([2, 3, 3]);
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(p.boxes[0].lineN).toBe(10);
    expect(boxText(p.boxes[0], p)).toBe('alpha');
    expect(undo()).toBe(true);
    expect(p.boxes.some((b) => b.id === 'b2')).toBe(false);
    expect(p.activeLineN).toBe(30);
    expect(redo()).toBe(true);
    expect(p.boxes.find((b) => b.id === 'b2').lineN).toBe(30);
    expect(redo()).toBe(true);
    expect(redo()).toBe(true);
    expect(p.boxes.find((b) => b.id === 'b2').lineN).toBe(3);
  });

  it('crosses repeated moves and saved redo stacks without rewriting transition maps', () => {
    const p = page();
    const original = copy(p);
    moveLine(20, 1);
    const first = copy(p);
    const transition = copy(peekStack().undo[0]);
    setLineText(p, 2, 'edited alpha');
    moveLine(2, 3);
    const last = copy(p);
    expect(peekStack().undo[0]).toEqual(transition);
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(copy(p)).toEqual(first);
    expect(undo()).toBe(true);
    expect(copy(p)).toEqual(original);
    loadStack(1, copy(peekStack()));
    expect(redo()).toBe(true);
    expect(redo()).toBe(true);
    expect(redo()).toBe(true);
    expect(copy(p)).toEqual(last);
  });

  it('exports the new joins to text JSON, translations and PSD, keeping an in-flight export whole', () => {
    const [held] = snapshotExportPages([page()]);
    moveLine(20, 1);
    const json = JSON.parse(buildTextJson([page()]));
    const lines = json.pages[0].lines;
    expect(lines.find((l) => l.en === 'alpha')).toMatchObject({ n: 2, box: [10, 20, 100, 70], placed: { x: 10, y: 20 } });
    expect(normalizeTranslations(json)[0].lines.find((l) => l.en === 'beta').n).toBe(3);
    const psd = serializePage(page());
    expect(psd.boxes.map((b) => b.lineN)).toEqual([2, 3, 2, -2, null]);
    expect(psd.lines.find((l) => l.n === 2).en).toBe('alpha');
    expect(psd.detect.boxes.map((d) => d.n)).toEqual([2, 3, 1, -2]);
    expect(held.lines.map((l) => l.n)).toEqual([10, -2, 30, 20]);
    expect(held.boxes[0].lineN).toBe(10);
  });

  it('leaves free active lines, other pages and redo alone on an invalid or unchanged move', () => {
    page().activeLineN = -2;
    moveLine(20, 1);
    expect(page().activeLineN).toBe(-2);
    undo();
    const before = copy(page());
    for (const [n, to] of [[-2, 1], [99, 1], [10, 1], [10, 0], [10, 4], [10, 1.5]]) {
      expect(moveLine(n, to)).toBe(false);
    }
    expect(copy(page())).toEqual(before);
    expect(peekStack().redo).toHaveLength(1);
    const other = { ...fixture(), id: 2 };
    app.pages.push(other);
    const otherBefore = copy(app.pages[1]);
    moveLine(20, 1);
    expect(copy(app.pages[1])).toEqual(otherBefore);
  });

  it('refuses ambiguous numbers before changing any link', () => {
    page().lines[2].n = 10;
    const duplicate = copy(page());
    expect(moveLine(20, 1)).toBe(false);
    expect(copy(page())).toEqual(duplicate);
    page().lines[2].n = 30;
    page().boxes[0].lineN = 1;
    const orphan = copy(page());
    expect(moveLine(20, 1)).toBe(false);
    expect(copy(page())).toEqual(orphan);
    expect(peekStack()).toEqual({ undo: [], redo: [] });
  });
});
