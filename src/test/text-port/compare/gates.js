import { summarize, Distribution } from './stats.js';

const rules = new Set(['integrity', 'number', 'image', 'identical-lines', 'unchanged', 'within-envelope']);
const kinds = new Set(['errors', 'missing', 'hashes', 'invalid']);
const imageMetrics = new Set(['bboxDelta', 'iou', 'meanAbs', 'thick']);

export function validateGates(config) {
  if (config?.version !== 1 || !Array.isArray(config.gates)) {
    throw new Error('Expected gates version 1 and gates array');
  }
  const ids = new Set();
  for (const gate of config.gates) {
    if (!gate.id || ids.has(gate.id) || !rules.has(gate.rule) || typeof gate.enforce !== 'boolean' || typeof gate.why !== 'string') {
      throw new Error(`Invalid or duplicate gate: ${gate.id}`);
    }
    ids.add(gate.id);
    for (const selector of ['excludeTags', 'onlyTags']) {
      if (gate[selector] !== undefined && (!Array.isArray(gate[selector]) || gate[selector].some(tag => typeof tag !== 'string' || !tag))) {
        throw new Error(`Invalid ${selector}: ${gate.id}`);
      }
    }
    if (gate.rule === 'integrity' && !kinds.has(gate.kind)) {
      throw new Error(`Unknown integrity gate: ${gate.id}`);
    }
    if (gate.rule !== 'integrity' && !['metrics', 'layout', 'pixels'].includes(gate.group)) {
      throw new Error(`Missing gate group: ${gate.id}`);
    }
    if (gate.rule === 'integrity' && gate.group !== undefined && !['metrics', 'layout', 'pixels'].includes(gate.group)) {
      throw new Error(`Invalid integrity group: ${gate.id}`);
    }
    if (['identical-lines', 'unchanged'].includes(gate.rule) && gate.group !== 'layout') {
      throw new Error(`Layout rule requires layout group: ${gate.id}`);
    }
    if (gate.rule === 'image' && gate.group !== 'pixels') {
      throw new Error(`Image rule requires pixels group: ${gate.id}`);
    }
    if (gate.mode !== undefined && !['smart', 'plain'].includes(gate.mode)) {
      throw new Error(`Invalid mode: ${gate.id}`);
    }
    if (gate.rule === 'number' && (!Array.isArray(gate.fields) || !gate.fields.length || (gate.abs === undefined && gate.rel === undefined))) {
      throw new Error(`Invalid number gate: ${gate.id}`);
    }
    if ((gate.rule === 'image' || (gate.rule === 'within-envelope' && gate.group === 'pixels')) && !imageMetrics.has(gate.metric)) {
      throw new Error(`Invalid image metric: ${gate.id}`);
    }
    if (gate.rule === 'image' && gate.min === undefined && gate.max === undefined) {
      throw new Error(`Missing image threshold: ${gate.id}`);
    }
    if (gate.rule === 'within-envelope' && gate.group !== 'pixels' && (typeof gate.field !== 'string' || !gate.field)) {
      throw new Error(`Missing envelope field: ${gate.id}`);
    }
    if (gate.rule === 'unchanged' && !['verdictChanged', 'curveChanged', 'solveChanged'].includes(gate.property)) {
      throw new Error(`Invalid changed property: ${gate.id}`);
    }
    for (const key of ['abs', 'rel', 'min', 'max', 'atLeast', 'minSize', 'factor']) {
      if (gate[key] !== undefined && (!Number.isFinite(gate[key]) || gate[key] < 0)) {
        throw new Error(`Invalid ${key}: ${gate.id}`);
      }
    }
    if (gate.atLeast !== undefined && gate.atLeast > 1) {
      throw new Error(`Invalid atLeast: ${gate.id}`);
    }
    if (gate.stat !== undefined && !['p50', 'p99', 'max'].includes(gate.stat)) {
      throw new Error(`Invalid envelope stat: ${gate.id}`);
    }
    if (gate.fields?.some(field => typeof field !== 'string' || !field)) {
      throw new Error(`Invalid fields: ${gate.id}`);
    }
  }
  return config;
}

export function matchesField(field, pattern) {
  return pattern.endsWith('*') ? field.startsWith(pattern.slice(0, -1)) : field === pattern || field === `${pattern}.length`;
}

export function metricKey(group, field) {
  return `${group}.${field}`;
}

function envelopeEntry(envelope, group, field) {
  const entry = envelope?.metrics?.[metricKey(group, field)];
  return field === 'iou' && group === 'pixels' ? entry?.loss : entry;
}

export function evaluateGates(cases, hashDifferences, config, envelope, hashCheckCount = 2, hasCorpus = false, collector) {
  validateGates(config);
  if (!hasCorpus && config.gates.some(gate => gate.excludeTags !== undefined || gate.onlyTags !== undefined)) {
    throw new Error('Tag selectors require --corpus');
  }
  return config.gates.map(gate => {
    let candidates = cases.filter(item => item.status === 'compared'
      && (!gate.group || item.group === gate.group)
      && (!gate.mode || item.mode === gate.mode) && matchesTags(item, gate));
    let unknownSize = [];
    if (gate.minSize !== undefined) {
      unknownSize = candidates.filter(item => !Number.isFinite(item.size)).map(item => item.id);
      // Without corpus metadata, apply the threshold conservatively.
      candidates = candidates.filter(item => !Number.isFinite(item.size) || item.size >= gate.minSize);
    }
    let exceptions = [];
    let failures = 0;
    let count = candidates.length;
    const values = new Distribution();
    const envelopeComparisons = new Map();
    let collected;
    if (collector) {
      if (!collector.has(gate.id)) collector.set(gate.id, { values: new Distribution(), envelope: new Map() });
      collected = collector.get(gate.id);
    }
    let quantity = 0;
    function track(field, value) {
      quantity = Math.max(quantity, value);
      values.push(value);
      collected?.values.push(value);
      const entry = envelopeEntry(envelope, gate.group, field);
      if (!entry) return;
      if (!envelopeComparisons.has(field)) envelopeComparisons.set(field, { field, candidate: new Distribution(), reference: entry });
      envelopeComparisons.get(field).candidate.push(value);
      if (collected) {
        if (!collected.envelope.has(field)) collected.envelope.set(field, { field, candidate: new Distribution(), reference: entry });
        collected.envelope.get(field).candidate.push(value);
      }
    }
    if (gate.rule === 'integrity') {
      const bad = cases.filter(item => {
        if (gate.kind === 'errors') return item.status === 'error';
        if (gate.kind === 'missing') return item.status === 'missing';
        if (gate.kind === 'invalid') {
          return (!gate.group || item.group === gate.group)
            && (item.invalidNumbers ?? item.numbers.some(diff => diff.invalid || diff.structural));
        }
        return false;
      });
      const scoped = cases.filter(item => (!gate.group || item.group === gate.group) && matchesTags(item, gate));
      const selected = bad.filter(item => (!gate.group || item.group === gate.group) && matchesTags(item, gate));
      const invalid = new Set(selected);
      for (const item of scoped) {
        item.quantities ??= {};
        const value = gate.kind === 'hashes' ? Number(hashDifferences.length > 0) : Number(invalid.has(item));
        item.quantities[gate.id] = value;
        values.push(value);
        collected?.values.push(value);
      }
      failures = gate.kind === 'hashes' ? hashDifferences.length : selected.length;
      exceptions = gate.kind === 'hashes' ? hashDifferences.map(field => ({ field })) : selected.slice(0, 2000).map(item => ({ id: item.id, group: item.group }));
      for (const item of selected) {
        if (!item.gates.includes(gate.id)) item.gates.push(gate.id);
      }
      count = gate.kind === 'hashes' ? hashCheckCount : cases.filter(item => (!gate.group || item.group === gate.group) && matchesTags(item, gate)).length;
    } else {
      if (gate.rule === 'within-envelope' && !envelope) {
        throw new Error(`Gate ${gate.id} requires --envelope`);
      }
      const eligible = [];
      for (const item of candidates) {
        quantity = 0;
        let failed = false;

        if (gate.rule === 'number' || (gate.rule === 'within-envelope' && gate.group !== 'pixels')) {
          const fields = gate.fields ?? [gate.field];
          const diffs = item.numbers.filter(diff => fields.some(field => matchesField(diff.field, field)));
          if (!diffs.length) continue;

          for (const diff of diffs) {
            track(diff.field, diff.abs);
            let ok;
            if (gate.rule === 'within-envelope') {
              // Broken candidate elements fail without demanding a reference
              // distribution for a length mismatch absent in reference runs.
              if (diff.invalid || diff.structural) ok = false;
              else {
                const entry = envelopeEntry(envelope, gate.group, diff.field);
                const limit = entry?.[gate.stat ?? 'max'];
                if (!Number.isFinite(limit)) {
                  throw new Error(`Missing finite envelope for ${gate.group}.${diff.field}`);
                }
                ok = diff.abs <= limit * (gate.factor ?? 1);
              }
            } else {
              ok = !diff.invalid && !diff.structural
                && ((gate.abs !== undefined && diff.abs <= gate.abs)
                  || (gate.rel !== undefined && diff.rel <= gate.rel));
            }
            failed ||= !ok;
          }

        } else if (gate.rule === 'image' || gate.rule === 'within-envelope') {
          const raw = item.image[gate.metric];
          const value = gate.metric === 'iou' ? 1 - raw : raw;
          track(gate.metric, value);

          if (gate.rule === 'within-envelope') {
            const limit = envelopeEntry(envelope, gate.group, gate.metric)?.[gate.stat ?? 'max'];
            if (!Number.isFinite(limit)) {
              throw new Error(`Missing finite envelope for pixels.${gate.metric}`);
            }
            failed = !Number.isFinite(raw) || value > limit * (gate.factor ?? 1);

          } else {
            failed = !Number.isFinite(raw)
              || (gate.min !== undefined && raw < gate.min) || (gate.max !== undefined && raw > gate.max);
          }
        } else if (gate.rule === 'identical-lines') {
          if (item.layout.linesComparable === false) continue;
          failed = !item.layout.linesIdentical;
          track('linesChanged', Number(failed));
        } else if (gate.rule === 'unchanged') {
          failed = item.layout[gate.property];
          track(gate.property, Number(failed));
        }
        eligible.push(item);
        item.quantities ??= {};
        // One observation per eligible case in the tag/font gate tables.
        item.quantities[gate.id] = gate.metric === 'iou' ? item.image.iou : quantity;
        if (failed) {
          failures++;
          if (!item.gates.includes(gate.id)) item.gates.push(gate.id);
          if (exceptions.length < 2000) exceptions.push({ id: item.id, group: item.group });
        }
      }
      count = eligible.length;
    }
    const fraction = count ? (count - failures) / count : 1;
    const pass = fraction + 1e-12 >= (gate.atLeast ?? 1);
    return {
      ...gate,
      pass,
      count,
      failures,
      exceptionCount: failures,
      exceptionsTruncated: failures > exceptions.length,
      fraction,
      empty: count === 0,
      unknownSize: unknownSize.slice(0, 2000),
      unknownSizeCount: unknownSize.length,
      statistics: summarize(values),
      exceptions,
      envelope: [...envelopeComparisons.values()].map(({ field, candidate, reference }) => {
        const statistics = summarize(candidate);
        return {
          field,
          candidate: statistics,
          reference,
          ratioToMax: reference.max === 0 ? (statistics.max === 0 ? 0 : Infinity) : statistics.max / reference.max
        };
      })
    };
  });
}

export function matchesTags(item, gate) {
  const tags = item.tags ?? [];
  return !gate.excludeTags?.some(tag => tags.includes(tag))
    && (gate.onlyTags === undefined || gate.onlyTags.some(tag => tags.includes(tag)));
}

export class GateTableAccumulator {
  constructor(config, key) {
    this.config = config;
    this.key = key;
    this.groups = {};
  }

  add(cases) {
    const { config, key, groups } = this;
  for (const item of cases) {
    groups[item.group] ??= new Map();
    const labels = key === 'tag' ? [...new Set([...(item.tags ?? []), item.tags?.includes('uncovered') ? 'uncovered' : 'covered'])] : [item.font];
    for (const label of labels) {
      const table = groups[item.group];
      if (!table.has(label)) table.set(label, { [key]: label, cases: 0, gates: new Map() });
      const row = table.get(label);
      row.cases++;
      for (const gate of config.gates.filter(gate => !gate.group || gate.group === item.group)) {
        if (!row.gates.has(gate.id)) row.gates.set(gate.id, { count: 0, failures: 0, values: new Distribution() });
        const bucket = row.gates.get(gate.id);
        bucket.failures += Number(item.gates.includes(gate.id));
        if (item.quantities?.[gate.id] !== undefined) {
          bucket.count++;
          bucket.values.push(item.quantities[gate.id]);
        }
      }
    }
  }
  }

  finish() {
    const { groups, key } = this;
  for (const group of ['metrics', 'layout', 'pixels']) {
    groups[group] ??= new Map();
    if (key === 'tag') {
      for (const label of ['covered', 'uncovered']) {
        if (!groups[group].has(label)) groups[group].set(label, { tag: label, cases: 0, gates: new Map() });
      }
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([group, table]) => [group,
    [...table.values()].map(row => ({ ...row, gates: Object.fromEntries([...row.gates].map(([id, bucket]) => [id, {
      count: bucket.count, failures: bucket.failures, quantity: summarize(bucket.values)
    }])) })).sort((a, b) => a[key].localeCompare(b[key]))
  ]));
}

}

export function gateTables(cases, config, key) {
  const accumulator = new GateTableAccumulator(config, key);
  accumulator.add(cases);
  return accumulator.finish();
}
