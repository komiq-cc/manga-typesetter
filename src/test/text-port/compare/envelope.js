import { summarize } from './stats.js';
import { metricKey } from './gates.js';

function add(buckets, key, value, relative) {
  if (!buckets.has(key)) buckets.set(key, { values: [], relative: [] });
  const bucket = buckets.get(key);
  bucket.values.push(value);
  if (relative !== undefined) bucket.relative.push(relative);
}

function summarizeBuckets(buckets) {
  return Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => [key, {
    ...summarize(bucket.values),
    min: bucket.values.reduce((min, value) => Math.min(min, value), Infinity),
    ...(bucket.relative.length ? { relative: summarize(bucket.relative) } : {}),
    ...(key === 'pixels.iou' ? { loss: summarize(bucket.values.map(value => 1 - value)) } : {})
  }]));
}

export class EnvelopeAccumulator {
  constructor(runs) {
    this.runs = runs;
    this.buckets = new Map();
    this.covered = new Map();
    this.uncovered = new Map();
    this.pairwise = [];
    this.skipped = [];
  }

  add(report) {
    if (report.hashDifferences.length || report.cases.some(item => ['missing', 'error'].includes(item.status))) {
      throw new Error('Reference runs have mismatched hashes, missing cases or capture errors');
    }
    const buckets = { all: new Map(), covered: new Map(), uncovered: new Map() };
    const skipped = report.cases.filter(item => ['skipped', 'skip-mismatch'].includes(item.status));
    const unpaired = {};
    const lines = Object.fromEntries(['all', 'covered', 'uncovered'].map(label => [label, { count: 0, identical: 0 }]));
    for (const item of report.cases) {
      if (item.status !== 'compared') continue;
      const label = item.tags?.includes('uncovered') ? 'uncovered' : 'covered';
      const record = (key, value, relative) => {
        add(this.buckets, key, value, relative);
        add(this[label], key, value, relative);
        add(buckets.all, key, value, relative);
        add(buckets[label], key, value, relative);
      };
      for (const diff of item.numbers) {
        if (diff.invalid) {
          // Different line/curve array lengths are engine decisions. An
          // unpaired coordinate has no finite delta; count it separately.
          if (isUnpaired(item, diff)) {
            const key = metricKey(item.group, diff.field);
            unpaired[key] = (unpaired[key] ?? 0) + 1;
            continue;
          }
          throw new Error(`Reference has invalid number: ${item.id} ${diff.path}`);
        }
        record(metricKey(item.group, diff.field), diff.abs, diff.rel);
      }
      if (item.image) {
        for (const metric of ['bboxDelta', 'iou', 'meanAbs', 'thick']) record(metricKey('pixels', metric), item.image[metric]);
      }
      if (item.group === 'layout' && item.mode === 'smart' && item.layout.linesComparable !== false) {
        for (const key of ['all', label]) {
          lines[key].count++;
          lines[key].identical += Number(item.layout.linesIdentical);
        }
      }
    }
    this.skipped.push(skipped.map(item => ({ group: item.group, id: item.id, status: item.status })));
    this.pairwise.push({
      before: report.before?.manifest.engine,
      after: report.after?.manifest.engine,
      skipped: skipped.length,
      unpairedObservations: unpaired,
      skippedByGroup: Object.fromEntries(['metrics', 'layout', 'pixels'].map(group => [group, skipped.filter(item => item.group === group).length])),
      metrics: summarizeBuckets(buckets.all),
      covered: summarizeBuckets(buckets.covered),
      uncovered: summarizeBuckets(buckets.uncovered),
      smartLines: Object.fromEntries(Object.entries(lines).map(([label, value]) => [label, {
        ...value, share: value.count ? value.identical / value.count : null
      }]))
    });
  }

  finish() {
    return {
      version: 1,
      convention: 'Pooled case/element observations across every unordered run pair; numeric absolute differences, raw image metrics, and 1-iou loss for gating. Pairwise rows exclude and count cases skipped by either run.',
      runs: this.runs.map(run => ({ directory: run.dir, manifest: run.manifest })),
      pairs: this.pairwise.length,
      metrics: summarizeBuckets(this.buckets),
      covered: summarizeBuckets(this.covered),
      uncovered: summarizeBuckets(this.uncovered),
      pairwise: this.pairwise,
      skipped: this.skipped
    };
  }
}

export function buildEnvelope(reports, runs) {
  const accumulator = new EnvelopeAccumulator(runs);
  for (const report of reports) accumulator.add(report);
  return accumulator.finish();
}

export function validateEnvelope(envelope) {
  if (envelope?.version !== 1 || !envelope.metrics || typeof envelope.metrics !== 'object' || !Array.isArray(envelope.runs) || envelope.runs.length < 2) {
    throw new Error('Expected envelope version 1, metrics object and reference runs');
  }
  function restore(object) {
    for (const [key, value] of Object.entries(object)) {
      if (value && typeof value === 'object') restore(value);
      else if (['p50', 'p99', 'max', 'median', 'min'].includes(key) && value === 'Infinity') object[key] = Infinity;
    }
  }
  restore(envelope.metrics);
  return envelope;
}

function isUnpaired(item, diff) {
  if (item.group !== 'layout') return false;
  const match = /^(lineX|curve)\[(\d+)\]/.exec(diff.path);
  if (match) {
    const key = match[1];
    const index = Number(match[2]);
    const a = item.before?.[key];
    const b = item.after?.[key];
    const validAbsent = (record, value) => value === null
      && Array.isArray(key === 'lineX' ? record.curve : record.lines);
    const arraysValid = (Array.isArray(a) || validAbsent(item.before, a))
      && (Array.isArray(b) || validAbsent(item.after, b));
    return arraysValid && (index >= (a?.length ?? 0) || index >= (b?.length ?? 0));
  }
  if (['blockY', 'blockH', 'baseY', 'lineH'].includes(diff.path)) {
    const curvedA = Array.isArray(item.before?.curve) && item.before[diff.path] === null;
    const curvedB = Array.isArray(item.after?.curve) && item.after[diff.path] === null;
    return (curvedA && Number.isFinite(item.after[diff.path]))
      || (curvedB && Number.isFinite(item.before[diff.path]));
  }
  return false;
}
