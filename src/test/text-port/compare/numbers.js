import { summarize, Distribution } from './stats.js';
import { matchesField, matchesTags } from './gates.js';

export function fieldPattern(path) {
  return path.replace(/\[\d+\]/g, '').replace(/^glyphs\.[^.]+\./, 'glyphs.');
}

export function numberDifference(before, after) {
  const invalid = !Number.isFinite(before) || !Number.isFinite(after);
  const abs = invalid ? Infinity : Math.abs(after - before);
  const rel = invalid ? Infinity : before === 0 ? (abs === 0 ? 0 : Infinity) : abs / Math.abs(before);
  return { before: before ?? null, after: after ?? null, abs, rel, invalid };
}

// Traverse both trees so a removed subtree or array tail cannot disappear.
export function compareNumbers(before, after, path = '') {
  const result = [];
  function visit(a, b, name, field) {
    if (typeof a === 'number' || typeof b === 'number') {
      result.push({ path: name, field, ...numberDifference(a, b) });
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      const aa = Array.isArray(a) ? a : [];
      const bb = Array.isArray(b) ? b : [];
      if (aa.length !== bb.length || Array.isArray(a) !== Array.isArray(b)) {
        result.push({ path: `${name}.length`, field: `${field}.length`, structural: true,
          ...numberDifference(Array.isArray(a) ? aa.length : undefined, Array.isArray(b) ? bb.length : undefined) });
      }
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) visit(aa[i], bb[i], `${name}[${i}]`, field);
      return;
    }
    const keys = new Set([...Object.keys(a && typeof a === 'object' ? a : {}), ...Object.keys(b && typeof b === 'object' ? b : {})]);
    for (const key of keys) {
      const next = name ? `${name}.${key}` : key;
      visit(a?.[key], b?.[key], next, name === 'glyphs' ? field : field ? `${field}.${key}` : key);
    }
  }
  visit(before, after, path, path);
  return result;
}

export class NumberAccumulator {
  constructor(group, gates = { gates: [] }) {
    this.group = group;
    this.gates = gates.gates.filter(gate => gate.group === group && gate.rule === 'number');
    this.buckets = new Map();
  }

  add(cases) {
    for (const item of cases) {
      if (item.group !== this.group || item.status !== 'compared') continue;
      const local = new Map();
      for (const diff of item.numbers) {
        const field = fieldPattern(diff.field);
        if (!local.has(field)) local.set(field, []);
        local.get(field).push(diff);
      }
      const labels = [{}, { font: item.font }, ...[...new Set([
        ...item.tags, item.tags.includes('uncovered') ? 'uncovered' : 'covered'
      ])].map(tag => ({ tag }))];
      for (const [field, diffs] of local) {
        const worst = diffs.reduce((a, b) => b.abs > a.abs ? b : a);
        const rel = diffs.reduce((max, diff) => Math.max(max, diff.rel), 0);
        const gates = this.gates.filter(gate => (!gate.mode || gate.mode === item.mode)
          && matchesTags(item, gate) && gate.fields.some(pattern => matchesField(field, pattern)));
        for (const label of labels) {
          const key = `${label.font ?? ''}\0${label.tag ?? ''}\0${field}`;
          if (!this.buckets.has(key)) {
            this.buckets.set(key, {
              ...label, field, absolute: new Distribution(), relative: new Distribution(),
              perAbs: new Distribution(), perRel: new Distribution(), invalid: 0,
              overThreshold: {}, worst: [], cutoff: null
            });
          }
          const bucket = this.buckets.get(key);
          for (const diff of diffs) {
            bucket.absolute.push(diff.abs);
            bucket.relative.push(diff.rel);
            bucket.invalid += Number(diff.invalid);
            for (const gate of gates) {
              const over = diff.invalid || diff.structural || !((gate.abs !== undefined && diff.abs <= gate.abs)
                || (gate.rel !== undefined && diff.rel <= gate.rel));
              bucket.overThreshold[gate.id] = (bucket.overThreshold[gate.id] ?? 0) + Number(over);
            }
          }
          bucket.perAbs.push(worst.abs);
          bucket.perRel.push(rel);
          if (label.font !== undefined || label.tag !== undefined) continue;
          const entry = { id: item.id, before: worst.before, after: worst.after, abs: worst.abs };
          if (!bucket.cutoff || worstOrder(entry, bucket.cutoff) < 0) {
            bucket.worst.push(entry);
            if (bucket.worst.length >= 250 || (bucket.worst.length === 200 && !bucket.cutoff)) {
              bucket.worst = bucket.worst.sort(worstOrder).slice(0, 200);
              bucket.cutoff = bucket.worst[199];
            }
          }
        }
      }
    }
  }

  finish() {
    return [...this.buckets.values()].map(bucket => ({
      ...(bucket.font !== undefined ? { font: bucket.font } : {}),
      ...(bucket.tag !== undefined ? { tag: bucket.tag } : {}),
      field: bucket.field,
      caseCount: bucket.perAbs.count,
      absolute: summarize(bucket.absolute),
      relative: summarize(bucket.relative),
      perCase: { absolute: summarize(bucket.perAbs), relative: summarize(bucket.perRel) },
      invalid: bucket.invalid,
      overThreshold: bucket.overThreshold,
      ...(bucket.font === undefined && bucket.tag === undefined
        ? { worst: bucket.worst.sort(worstOrder).slice(0, 200) } : {})
    })).sort((a, b) => a.field.localeCompare(b.field)
      || (a.font ?? '').localeCompare(b.font ?? '') || (a.tag ?? '').localeCompare(b.tag ?? ''));
  }
}

export function numberStatistics(cases, group) {
  const accumulator = new NumberAccumulator(group);
  accumulator.add(cases);
  return accumulator.finish();
}

function worstOrder(a, b) {
  return b.abs - a.abs || a.id.localeCompare(b.id);
}
