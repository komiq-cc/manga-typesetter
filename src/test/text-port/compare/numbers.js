import { summarize } from './stats.js';

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
      visit(a?.[key], b?.[key], next, field ? `${field}.${key}` : key);
    }
  }
  visit(before, after, path, path);
  return result;
}

export class NumberAccumulator {
  constructor(group) {
    this.group = group;
    this.buckets = new Map();
  }

  add(cases) {
    const buckets = this.buckets;
    for (const item of cases) {
      if (item.group !== this.group || item.status !== 'compared') continue;
      const local = new Map();
      for (const diff of item.numbers) {
        const key = `${item.font}\0${diff.field}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            font: item.font,
            field: diff.field,
            absolute: [], relative: [], perAbs: [], perRel: [],
            invalid: 0,
            worst: [],
            cutoff: null
          });
        }
        const bucket = buckets.get(key);
        bucket.absolute.push(diff.abs);
        bucket.relative.push(diff.rel);
        bucket.invalid += Number(diff.invalid);
        if (!local.has(key)) {
          local.set(key, {
            id: item.id,
            tags: item.tags,
            // Reuse the bucket's path for scalar fields instead of retaining
            // a separately constructed path string for every observation.
            path: diff.path === diff.field ? bucket.field : diff.path,
            before: diff.before,
            after: diff.after,
            abs: diff.abs,
            rel: diff.rel,
            invalid: diff.invalid,
            structural: Boolean(diff.structural),
            elements: 0
          });
        }
        const entry = local.get(key);
        if (diff.abs > entry.abs) {
          entry.path = diff.path === diff.field ? bucket.field : diff.path;
          entry.before = diff.before;
          entry.after = diff.after;
        }
        entry.abs = Math.max(entry.abs, diff.abs);
        entry.rel = Math.max(entry.rel, diff.rel);
        entry.invalid ||= diff.invalid;
        entry.structural ||= Boolean(diff.structural);
        entry.elements++;
      }
      for (const [key, entry] of local) {
        const bucket = buckets.get(key);
        bucket.perAbs.push(entry.abs);
        bucket.perRel.push(entry.rel);
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

  finish() {
    return [...this.buckets.values()].map(bucket => ({
      font: bucket.font,
      field: bucket.field,
      caseCount: bucket.perAbs.length,
      absolute: summarize(bucket.absolute),
      relative: summarize(bucket.relative),
      perCase: { absolute: summarize(bucket.perAbs), relative: summarize(bucket.perRel) },
      invalid: bucket.invalid,
      worst: bucket.worst.sort(worstOrder).slice(0, 200)
    })).sort((a, b) => a.font.localeCompare(b.font) || a.field.localeCompare(b.field));
  }
}

export function numberStatistics(cases, group) {
  const accumulator = new NumberAccumulator(group);
  accumulator.add(cases);
  return accumulator.finish();
}

function worstOrder(a, b) {
  return b.abs - a.abs || b.rel - a.rel || a.id.localeCompare(b.id);
}
