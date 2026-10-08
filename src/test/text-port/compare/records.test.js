import { describe, it, expect } from 'vitest';
import { parseJsonl, caseMetadata, joinRuns, manifestDifferences } from './records.js';
import { compareLayout } from './layout.js';

const run = records => ({ metrics: new Map(records.map(item => [item.id, item])), layout: new Map(), pixels: new Map() });
describe('records and layout', () => {
  it('reads CRLF/blank lines but rejects malformed JSON, duplicates and unsafe ids', () => {
    expect(parseJsonl('\r\n{"id":"m.a"}\r\n', 'test').size).toBe(1);
    expect(() => parseJsonl('{oops}', 'test')).toThrow('test:1: invalid JSON');
    expect(() => parseJsonl('{"id":"m.a"}\n{"id":"m.a"}', 'test')).toThrow('duplicate id');
    expect(() => parseJsonl('{"id":"../escape"}', 'test')).toThrow('invalid case id');
    expect(() => parseJsonl('null', 'test')).toThrow('invalid case id');
  });
  it('joins by id, reports both missing directions, skip mismatches and errors', () => {
    const cases = joinRuns(run([{ id: 'm.a' }, { id: 'm.b', skip: 'unsupported' }, { id: 'm.c', error: 'bad' }, { id: 'm.e', skip: 'reason' }]), run([{ id: 'm.b', adv: 1 }, { id: 'm.c', skip: 'reason' }, { id: 'm.d' }, { id: 'm.e', skip: 'reason' }]));
    expect(Object.fromEntries(cases.map(item => [item.id, item.status]))).toEqual({ 'm.a': 'missing', 'm.b': 'skip-mismatch', 'm.c': 'error', 'm.e': 'skipped', 'm.d': 'missing' });
  });
  it('uses corpus metadata and falls back to the id prefix without inventing a size', () => {
    expect(caseMetadata('l.a.smart')).toEqual({ font: 'l', tags: [], mode: 'smart', size: null });
    expect(caseMetadata('p.a', new Map([['p.a', { box: { style: { font: 'Comic', size: 22 } }, tags: ['curve'], mode: 'plain' }]]))).toMatchObject({ font: 'Comic', size: 22, tags: ['curve'], mode: 'plain' });
  });
  it('reports a corpus case absent from both recordings', () => {
    const cases = joinRuns(run([]), run([]), { metrics: new Map([['m.lost', { font: 'Test' }]]) });
    expect(cases[0]).toMatchObject({ id: 'm.lost', status: 'missing', before: null, after: null });
  });
  it('ignores key ordering in decisions and manifests', () => {
    expect(compareLayout({ verdict: { fits: true, overflow: false } }, { verdict: { overflow: false, fits: true } }).verdictChanged).toBe(false);
    expect(manifestDifferences({ corpus: { a: 1, b: 2 }, fonts: 'x' }, { corpus: { b: 2, a: 1 }, fonts: 'y' })).toEqual(['fonts']);
  });
  it('reports largest offsets, curve characters, solver answers and changed verdicts', () => {
    const a = { lines: ['one'], lineX: [2], blockY: 1, baseY: 3, ink: { l: 1 }, curve: [{ ch: 'A', x: 3, y: 1, rot: 0, w: 4 }], verdict: { fits: true } };
    const b = { ...a, lines: ['two'], lineX: [5], blockY: 4, baseY: 8, ink: { l: 5 }, curve: [{ ch: 'B', x: 4, y: 1, rot: 0.1, w: 4 }], verdict: { fits: false } };
    const diff = compareLayout(a, b);
    expect(diff).toMatchObject({ linesIdentical: false, verdictChanged: true, curveChanged: true, largest: { lineX: 3, blockY: 3, baseY: 5, ink: 4, curve: 1 } });
    expect(diff.changes.some(change => change.path === 'curve.0.ch')).toBe(true);
    expect(compareLayout({ solve: { size: 20, lines: ['a'], status: 'fit' } }, { solve: { size: 22, lines: ['b'], status: 'failed' } })).toMatchObject({ solveChanged: true, linesIdentical: false, largest: { solve: 2 } });
  });
});
