import { summarize } from './stats.js';
import { metricKey } from './gates.js';

export function buildEnvelope(reports, runs) {
  const buckets = new Map();
  const add = (key, value, relative) => {
    if (!buckets.has(key)) buckets.set(key, { values: [], relative: [] });
    buckets.get(key).values.push(value);
    if (relative !== undefined) buckets.get(key).relative.push(relative);
  };
  for (const report of reports) {
    if (report.hashDifferences.length || report.cases.some(item => ['missing', 'error'].includes(item.status))) throw new Error('Reference runs have mismatched hashes, missing cases or capture errors');
    for (const item of report.cases) {
      for (const diff of item.numbers) {
        if (diff.invalid) throw new Error(`Reference has invalid number: ${item.id} ${diff.path}`);
        add(metricKey(item.group, diff.field), diff.abs, diff.rel);
      }
      if (item.image) for (const metric of ['bboxDelta', 'iou', 'meanAbs', 'thick']) add(metricKey('pixels', metric), item.image[metric]);
    }
  }
  const metrics = Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => [key, {
    ...summarize(bucket.values), min: bucket.values.reduce((min, value) => Math.min(min, value), Infinity),
    ...(bucket.relative.length ? { relative: summarize(bucket.relative) } : {}),
    ...(key === 'pixels.iou' ? { loss: summarize(bucket.values.map(value => 1 - value)) } : {})
  }]));
  return { version: 1, convention: 'Pooled case/element observations across every unordered run pair; numeric absolute differences, raw image metrics, and 1-iou loss for gating.',
    runs: runs.map(run => ({ directory: run.dir, manifest: run.manifest })), pairs: reports.length, metrics,
    skipped: reports.map(report => report.cases.filter(item => ['skipped', 'skip-mismatch'].includes(item.status)).map(item => ({ group: item.group, id: item.id, status: item.status }))) };
}

export function validateEnvelope(envelope) {
  if (envelope?.version !== 1 || !envelope.metrics || typeof envelope.metrics !== 'object' || !Array.isArray(envelope.runs) || envelope.runs.length < 2) throw new Error('Expected envelope version 1, metrics object and reference runs');
  function restore(object) {
    for (const [key, value] of Object.entries(object)) {
      if (value && typeof value === 'object') restore(value);
      else if (['p50', 'p99', 'max', 'median', 'min'].includes(key) && value === 'Infinity') object[key] = Infinity;
    }
  }
  restore(envelope.metrics);
  return envelope;
}
