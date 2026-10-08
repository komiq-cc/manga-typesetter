import { describe, it, expect } from 'vitest';
import { evaluateGates, validateGates } from './gates.js';
import { compareLayout } from './layout.js';
import { compareNumbers } from './numbers.js';
import { buildEnvelope } from './envelope.js';

const config = gate => ({ version: 1, gates: [{ id: 'test', why: 'test tolerance', enforce: true, ...gate }] });
const numericCase = (id, a, b) => ({ id, group: 'metrics', status: 'compared', gates: [], numbers: compareNumbers(a, b) });
describe('gates and reference envelope', () => {
  it('applies absolute OR relative tolerance to every char and keeps tolerated tail exceptions', () => {
    const cases = Array.from({ length: 1000 }, (_, i) => numericCase(`m.${i}`, { adv: 1000, chars: [10, 1000] }, { adv: 1000.4, chars: [10.01, i === 0 ? 1001 : 1000.4] }));
    const [gate] = evaluateGates(cases, [], config({ rule: 'number', group: 'metrics', fields: ['adv', 'chars'], abs: 0.02, rel: 0.0005, atLeast: 0.999 }));
    expect(gate).toMatchObject({ pass: true, count: 1000, failures: 1, fraction: 0.999 });
    expect(gate.exceptions[0]).toMatchObject({ id: 'm.0', group: 'metrics' });
    expect(cases[0].gates).toEqual(['test']);
    expect(evaluateGates(cases.slice(0, 999), [], config({ rule: 'number', group: 'metrics', fields: ['chars'], abs: 0.02, rel: 0.0005, atLeast: 0.999 }))[0].pass).toBe(false);
  });
  it('filters tag selectors, supports their intersection, and requires corpus metadata', () => {
    const cases = ['covered', 'uncovered', 'uncovered'].map((label, i) => ({
      ...numericCase(`m.${i}`, { adv: 1 }, { adv: 3 }),
      tags: label === 'covered' ? ['kern'] : i === 1 ? ['uncovered', 'kern'] : ['uncovered']
    }));
    const base = { rule: 'number', group: 'metrics', fields: ['adv'], abs: 0 };
    const filters = config({ ...base, excludeTags: ['uncovered'] });
    expect(() => evaluateGates(cases, [], filters)).toThrow('require --corpus');
    expect(evaluateGates(cases, [], filters, undefined, 2, true)[0]).toMatchObject({ count: 1, failures: 1 });
    expect(evaluateGates(cases, [], config({ ...base, onlyTags: ['uncovered'], enforce: false }), undefined, 2, true)[0]).toMatchObject({ count: 2, failures: 2, enforce: false });
    expect(evaluateGates(cases, [], config({ ...base, onlyTags: ['uncovered'], excludeTags: ['kern'] }), undefined, 2, true)[0]).toMatchObject({ count: 1, failures: 1 });
    expect(() => validateGates(config({ ...base, onlyTags: 'uncovered' }))).toThrow('Invalid onlyTags');
  });
  it('counts cases rather than individual array entries', () => {
    const cases = [numericCase('m.a', { chars: [1, 1, 1] }, { chars: [3, 3, 3] }), numericCase('m.b', { chars: [1] }, { chars: [1] })];
    expect(evaluateGates(cases, [], config({ group: 'metrics', rule: 'number', fields: ['chars'], abs: 0.02 }))[0]).toMatchObject({ count: 2, failures: 1 });
  });
  it('fails numeric absence and array lengths even with generous thresholds', () => {
    const cases = [numericCase('m.a', { chars: [1], adv: 1 }, { chars: [], adv: null })];
    expect(evaluateGates(cases, [], config({ rule: 'number', group: 'metrics', fields: ['chars', 'adv'], abs: 100, rel: 100 }))[0].pass).toBe(false);
  });
  it('applies min font size, explicitly gates unknown sizes, and excludes skips', () => {
    const cases = [12, 16, null].map((size, i) => ({ id: `p.${i}`, group: 'pixels', status: 'compared', size, gates: [], image: { iou: 0.9 }, numbers: [] }));
    cases.push({ id: 'p.skip', group: 'pixels', status: 'skip-mismatch', size: 20, gates: [], numbers: [] });
    expect(evaluateGates(cases, [], config({ group: 'pixels', rule: 'image', metric: 'iou', min: 0.97, minSize: 16 }))[0]).toMatchObject({ count: 2, failures: 2, unknownSize: ['p.2'] });
  });
  it('reports mode-specific lines and every changed verdict', () => {
    const cases = ['smart', 'plain'].map(mode => ({ id: `l.${mode}`, group: 'layout', status: 'compared', mode, gates: [], numbers: [], layout: { linesIdentical: false, verdictChanged: true } }));
    expect(evaluateGates(cases, [], config({ group: 'layout', rule: 'identical-lines', mode: 'smart', atLeast: 0.99 }))[0]).toMatchObject({ count: 1, failures: 1 });
    expect(evaluateGates(cases, [], config({ group: 'layout', rule: 'unchanged', property: 'verdictChanged', enforce: false }))[0]).toMatchObject({ pass: false, enforce: false, failures: 2 });
  });
  it('excludes valid curved null lines but fails missing straight line arrays', () => {
    const curved = { curve: [], lines: null, lineX: null };
    const broken = { curve: null, lineX: [] };
    const cases = [curved, broken].map((record, index) => ({
      id: `l.${index}`, group: 'layout', status: 'compared', gates: [], numbers: [],
      layout: compareLayout(record, record)
    }));
    expect(evaluateGates(cases, [], config({ group: 'layout', rule: 'identical-lines' }))[0]).toMatchObject({ count: 1, failures: 1 });
    expect(cases[1].gates).toContain('test');
  });
  it('applies within-envelope to absolute numbers and image overlap loss', () => {
    const envelope = { metrics: { 'metrics.adv': { max: 0.3, p99: 0.2 }, 'pixels.iou': { max: 1, loss: { max: 0.04, p99: 0.02 } } } };
    const n = [numericCase('m.a', { adv: 10 }, { adv: 10.25 })];
    const rule = { group: 'metrics', rule: 'within-envelope', field: 'adv' };
    expect(evaluateGates(n, [], config(rule), envelope)[0].pass).toBe(true);
    expect(evaluateGates(n, [], config({ ...rule, stat: 'p99' }), envelope)[0].pass).toBe(false);
    const p = [{ id: 'p.a', group: 'pixels', status: 'compared', numbers: [], gates: [], image: { iou: 0.97 } }];
    expect(evaluateGates(p, [], config({ group: 'pixels', rule: 'within-envelope', metric: 'iou' }), envelope)[0].pass).toBe(true);
    expect(() => evaluateGates(n, [], config(rule))).toThrow('requires --envelope');
    expect(() => evaluateGates(n, [], config(rule), { metrics: {} })).toThrow('Missing finite envelope');
  });
  it('rejects unknown or malformed gate rules rather than silently accepting them', () => {
    expect(() => validateGates(config({ rule: 'typo' }))).toThrow();
    expect(() => validateGates(config({ rule: 'image', group: 'pixels', metric: 'misspelled', max: 1 }))).toThrow();
    expect(() => validateGates(config({ rule: 'number', group: 'metrics', fields: ['adv'], abs: -1 }))).toThrow();
    expect(() => validateGates(config({ rule: 'identical-lines', group: 'layout', atLeast: 2 }))).toThrow();
  });
  it('fails a candidate array mismatch without requiring a reference length-error metric', () => {
    const cases = [numericCase('m.a', { chars: [1] }, { chars: [] })];
    const [gate] = evaluateGates(cases, [], config({ group: 'metrics', rule: 'within-envelope', field: 'chars' }), { metrics: { 'metrics.chars': { max: 0 } } });
    expect(gate).toMatchObject({ pass: false, failures: 1 });
  });
  it('pools every pair into p50/p99/max and preserves raw IoU and its loss', () => {
    const report = delta => ({ hashDifferences: [], cases: [{ ...numericCase('m.a', { adv: 10 }, { adv: 10 + delta }), image: { bboxDelta: delta, iou: 1 - delta / 10, meanAbs: delta, thick: delta } }] });
    const env = buildEnvelope([report(1), report(2), report(3)], []);
    expect(env).toMatchObject({ pairs: 3, metrics: { 'metrics.adv': { p50: 2, p99: 3, max: 3 }, 'pixels.iou': { p50: 0.8, p99: 0.9, max: 0.9 } } });
    expect(env.metrics['pixels.iou'].loss.max).toBeCloseTo(0.3);
    expect(() => buildEnvelope([{ hashDifferences: ['fonts'], cases: [] }], [])).toThrow('mismatched hashes');
  });
});
