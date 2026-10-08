import { summarize } from './stats.js';

const rules = new Set(['integrity', 'number', 'image', 'identical-lines', 'unchanged', 'within-envelope']);
const kinds = new Set(['errors', 'missing', 'hashes', 'invalid']);
const imageMetrics = new Set(['bboxDelta', 'iou', 'meanAbs', 'thick']);

export function validateGates(config) {
  if (config?.version !== 1 || !Array.isArray(config.gates)) throw new Error('Expected gates version 1 and gates array');
  const ids = new Set();
  for (const gate of config.gates) {
    if (!gate.id || ids.has(gate.id) || !rules.has(gate.rule) || typeof gate.enforce !== 'boolean' || typeof gate.why !== 'string') throw new Error(`Invalid or duplicate gate: ${gate.id}`);
    ids.add(gate.id);
    if (gate.rule === 'integrity' && !kinds.has(gate.kind)) throw new Error(`Unknown integrity gate: ${gate.id}`);
    if (gate.rule !== 'integrity' && !['metrics', 'layout', 'pixels'].includes(gate.group)) throw new Error(`Missing gate group: ${gate.id}`);
    if (gate.rule === 'integrity' && gate.group !== undefined && !['metrics', 'layout', 'pixels'].includes(gate.group)) throw new Error(`Invalid integrity group: ${gate.id}`);
    if (['identical-lines', 'unchanged'].includes(gate.rule) && gate.group !== 'layout') throw new Error(`Layout rule requires layout group: ${gate.id}`);
    if (gate.rule === 'image' && gate.group !== 'pixels') throw new Error(`Image rule requires pixels group: ${gate.id}`);
    if (gate.mode !== undefined && !['smart', 'plain'].includes(gate.mode)) throw new Error(`Invalid mode: ${gate.id}`);
    if (gate.rule === 'number' && (!Array.isArray(gate.fields) || !gate.fields.length || (gate.abs === undefined && gate.rel === undefined))) throw new Error(`Invalid number gate: ${gate.id}`);
    if ((gate.rule === 'image' || (gate.rule === 'within-envelope' && gate.group === 'pixels')) && !imageMetrics.has(gate.metric)) throw new Error(`Invalid image metric: ${gate.id}`);
    if (gate.rule === 'image' && gate.min === undefined && gate.max === undefined) throw new Error(`Missing image threshold: ${gate.id}`);
    if (gate.rule === 'within-envelope' && gate.group !== 'pixels' && (typeof gate.field !== 'string' || !gate.field)) throw new Error(`Missing envelope field: ${gate.id}`);
    if (gate.rule === 'unchanged' && !['verdictChanged', 'curveChanged', 'solveChanged'].includes(gate.property)) throw new Error(`Invalid changed property: ${gate.id}`);
    for (const key of ['abs', 'rel', 'min', 'max', 'atLeast', 'minSize', 'factor']) if (gate[key] !== undefined && (!Number.isFinite(gate[key]) || gate[key] < 0)) throw new Error(`Invalid ${key}: ${gate.id}`);
    if (gate.atLeast !== undefined && gate.atLeast > 1) throw new Error(`Invalid atLeast: ${gate.id}`);
    if (gate.stat !== undefined && !['p50', 'p99', 'max'].includes(gate.stat)) throw new Error(`Invalid envelope stat: ${gate.id}`);
    if (gate.fields?.some(field => typeof field !== 'string' || !field)) throw new Error(`Invalid fields: ${gate.id}`);
  }
  return config;
}

export function matchesField(field, pattern) {
  return pattern.endsWith('*') ? field.startsWith(pattern.slice(0, -1)) : field === pattern || field === `${pattern}.length`;
}

export function metricKey(group, field) { return `${group}.${field}`; }

function envelopeEntry(envelope, group, field) {
  const entry = envelope?.metrics?.[metricKey(group, field)];
  return field === 'iou' && group === 'pixels' ? entry?.loss : entry;
}

export function evaluateGates(cases, hashDifferences, config, envelope, hashCheckCount = 2) {
  validateGates(config);
  const caseIndex = new Map(cases.map(item => [`${item.group}:${item.id}`, item]));
  return config.gates.map(gate => {
    let candidates = cases.filter(item => item.status === 'compared' && (!gate.group || item.group === gate.group) && (!gate.mode || item.mode === gate.mode));
    let unknownSize = [];
    if (gate.minSize !== undefined) {
      unknownSize = candidates.filter(item => !Number.isFinite(item.size)).map(item => item.id);
      // Without corpus metadata, apply the threshold conservatively.
      candidates = candidates.filter(item => !Number.isFinite(item.size) || item.size >= gate.minSize);
    }
    let exceptions = [];
    let count = candidates.length;
    const values = [];
    const envelopeComparisons = new Map();
    function track(field, value) {
      values.push(value);
      const entry = envelopeEntry(envelope, gate.group, field);
      if (!entry) return;
      if (!envelopeComparisons.has(field)) envelopeComparisons.set(field, { field, candidate: [], reference: entry });
      envelopeComparisons.get(field).candidate.push(value);
    }
    if (gate.rule === 'integrity') {
      const bad = gate.kind === 'errors' ? cases.filter(item => item.status === 'error')
        : gate.kind === 'missing' ? cases.filter(item => item.status === 'missing')
          : gate.kind === 'invalid' ? cases.filter(item => (!gate.group || item.group === gate.group) && item.numbers.some(diff => diff.invalid || diff.structural)) : [];
      exceptions = gate.kind === 'hashes' ? hashDifferences.map(field => ({ field })) : bad.map(item => ({ id: item.id, group: item.group, differences: gate.kind === 'invalid' ? item.numbers.filter(diff => diff.invalid || diff.structural) : undefined }));
      count = gate.kind === 'hashes' ? hashCheckCount : cases.filter(item => !gate.group || item.group === gate.group).length;
    } else {
      if (gate.rule === 'within-envelope' && !envelope) throw new Error(`Gate ${gate.id} requires --envelope`);
      const eligible = [];
      for (const item of candidates) {
        let failed = false;
        let details;
        if (gate.rule === 'number' || (gate.rule === 'within-envelope' && gate.group !== 'pixels')) {
          const fields = gate.fields ?? [gate.field];
          const diffs = item.numbers.filter(diff => fields.some(field => matchesField(diff.field, field)));
          if (!diffs.length) continue;
          details = [];
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
                if (!Number.isFinite(limit)) throw new Error(`Missing finite envelope for ${gate.group}.${diff.field}`);
                ok = diff.abs <= limit * (gate.factor ?? 1);
              }
            } else ok = !diff.invalid && !diff.structural && ((gate.abs !== undefined && diff.abs <= gate.abs) || (gate.rel !== undefined && diff.rel <= gate.rel));
            if (!ok) details.push(diff);
          }
          failed = details.length > 0;
        } else if (gate.rule === 'image' || gate.rule === 'within-envelope') {
          const raw = item.image[gate.metric];
          const value = gate.metric === 'iou' ? 1 - raw : raw;
          track(gate.metric, value);
          details = { metric: gate.metric, value: raw };
          if (gate.rule === 'within-envelope') {
            const limit = envelopeEntry(envelope, gate.group, gate.metric)?.[gate.stat ?? 'max'];
            if (!Number.isFinite(limit)) throw new Error(`Missing finite envelope for pixels.${gate.metric}`);
            failed = !Number.isFinite(raw) || value > limit * (gate.factor ?? 1);
            details.limit = limit;
          } else failed = !Number.isFinite(raw) || (gate.min !== undefined && raw < gate.min) || (gate.max !== undefined && raw > gate.max);
        } else if (gate.rule === 'identical-lines') failed = !item.layout.linesIdentical;
        else if (gate.rule === 'unchanged') failed = item.layout[gate.property];
        eligible.push(item);
        if (failed) exceptions.push({ id: item.id, group: item.group, details });
      }
      count = eligible.length;
    }
    const fraction = count ? (count - exceptions.length) / count : 1;
    const pass = fraction + 1e-12 >= (gate.atLeast ?? 1);
    for (const exception of exceptions) {
      const item = caseIndex.get(`${exception.group}:${exception.id}`);
      if (item) item.gates.push(gate.id);
    }
    return { ...gate, pass, count, failures: exceptions.length, fraction, empty: count === 0, unknownSize,
      statistics: summarize(values), exceptions,
      envelope: [...envelopeComparisons.values()].map(({ field, candidate, reference }) => ({ field, candidate: summarize(candidate), reference,
        ratioToMax: reference.max === 0 ? (summarize(candidate).max === 0 ? 0 : Infinity) : summarize(candidate).max / reference.max })) };
  });
}
