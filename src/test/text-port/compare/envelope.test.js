import { describe, it, expect } from 'vitest';
import { buildEnvelope } from './envelope.js';
import { compareNumbers } from './numbers.js';
import { compareLayout } from './layout.js';

const metric = (id, delta, tags = []) => ({
  id, tags, group: 'metrics', status: 'compared',
  numbers: compareNumbers({ adv: 10 }, { adv: 10 + delta })
});

describe('pairwise reference coverage', () => {
  it('separates covered/uncovered distributions and counts skipped cases per pair', () => {
    const before = { lines: ['one two'], lineX: [0] };
    const after = { lines: ['one', 'two'], lineX: [0, 1] };
    const layout = compareLayout(before, after);
    const report = {
      before: { manifest: { engine: 'a' } },
      after: { manifest: { engine: 'b' } },
      hashDifferences: [],
      cases: [
        metric('m.covered', 1), metric('m.uncovered', 9, ['uncovered']),
        { id: 'm.skip', group: 'metrics', status: 'skip-mismatch', numbers: [] },
        { id: 'l.smart', group: 'layout', mode: 'smart', status: 'compared', tags: [],
          before, after, layout, numbers: layout.numbers }
      ]
    };
    const envelope = buildEnvelope([report], []);
    expect(envelope.metrics['metrics.adv']).toMatchObject({ p50: 5, max: 9 });
    expect(envelope.covered['metrics.adv']).toMatchObject({ p50: 1, p99: 1, max: 1 });
    expect(envelope.uncovered['metrics.adv']).toMatchObject({ p50: 9, p99: 9, max: 9 });
    expect(envelope.pairwise[0]).toMatchObject({
      before: 'a', after: 'b', skipped: 1, skippedByGroup: { metrics: 1 },
      covered: { 'metrics.adv': { p50: 1 } },
      smartLines: { covered: { count: 1, identical: 0, share: 0 } },
      unpairedObservations: { 'layout.lineX': 1 }
    });
  });
  it('rejects null coordinates inside paired layout arrays', () => {
    const before = { lines: ['one'], lineX: [0] };
    const after = { lines: ['one'], lineX: [null] };
    const layout = compareLayout(before, after);
    const item = { id: 'l.bad', group: 'layout', status: 'compared', before, after, layout, numbers: layout.numbers };
    expect(() => buildEnvelope([{ hashDifferences: [], cases: [item] }], [])).toThrow('Reference has invalid number');
  });
  it('still rejects invalid recorded numbers rather than treating them as unpaired layout tails', () => {
    const item = metric('m.bad', 0);
    item.numbers = compareNumbers({ adv: 10 }, { adv: null });
    expect(() => buildEnvelope([{ hashDifferences: [], cases: [item] }], [])).toThrow('Reference has invalid number');
  });
});
