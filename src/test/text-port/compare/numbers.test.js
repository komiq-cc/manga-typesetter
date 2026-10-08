import { describe, it, expect } from 'vitest';
import { compareNumbers, numberDifference, numberStatistics } from './numbers.js';
import { summarize, json } from './stats.js';

describe('numeric differences', () => {
  it('uses the reference magnitude and makes nonzero differences from zero infinite', () => {
    expect(numberDifference(-10, -9)).toMatchObject({ abs: 1, rel: 0.1, invalid: false });
    expect(numberDifference(0, 0).rel).toBe(0);
    expect(numberDifference(0, 1).rel).toBe(Infinity);
  });
  it.each([undefined, null, NaN, Infinity, '3'])('reports finite versus %s in both directions', value => {
    expect(numberDifference(3, value)).toMatchObject({ abs: Infinity, rel: Infinity, invalid: true });
    expect(numberDifference(value, 3).invalid).toBe(true);
  });
  it('compares arrays element-wise, removed tails and removed nested fields', () => {
    const diffs = compareNumbers({ chars: [1, 2], ink: { l: 1, r: 4 }, glyphs: { A: { x: 3 } } }, { chars: [1], ink: null });
    expect(diffs.find(diff => diff.path === 'chars.length')).toMatchObject({ abs: 1, structural: true });
    expect(diffs.find(diff => diff.path === 'chars[1]')).toMatchObject({ field: 'chars', invalid: true });
    expect(diffs.find(diff => diff.path === 'ink.r').invalid).toBe(true);
    expect(diffs.find(diff => diff.path === 'glyphs.A.x').invalid).toBe(true);
  });
  it('keeps an added number even when the entire reference subtree is absent', () => {
    expect(compareNumbers({}, { font: { ascent: 4 } })[0]).toMatchObject({ field: 'font.ascent', invalid: true });
  });
  it('summarizes per font and field, limits worst lists to 200 and preserves tags', () => {
    const cases = Array.from({ length: 250 }, (_, i) => ({ group: 'metrics', status: 'compared', font: 'Test', id: `m.${i}`, tags: ['kern'], numbers: compareNumbers({ chars: [0, 0] }, { chars: [i, i] }) }));
    const [stats] = numberStatistics(cases, 'metrics');
    expect(stats.caseCount).toBe(250);
    expect(stats.absolute.count).toBe(500);
    expect(stats.absolute.max).toBe(249);
    expect(stats.worst).toHaveLength(200);
    expect(new Set(stats.worst.map(item => item.id)).size).toBe(200);
    expect(stats.worst[0]).toMatchObject({ id: 'm.249', tags: ['kern'] });
  });
  it('defines median, nearest-rank p99, empty samples and JSON infinities', () => {
    expect(summarize([4, 1, 3, 2])).toMatchObject({ max: 4, median: 2.5, p99: 4 });
    expect(summarize([]).max).toBeNull();
    expect(JSON.parse(json({ abs: Infinity, rel: NaN }))).toEqual({ abs: 'Infinity', rel: 'NaN' });
  });
});
