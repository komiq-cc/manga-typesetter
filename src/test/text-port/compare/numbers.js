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

export function numberStatistics(cases, group) {
  const buckets = new Map();
  for (const item of cases.filter(item => item.group === group && item.status === 'compared')) {
    for (const diff of item.numbers) {
      const key = JSON.stringify([item.font, diff.field]);
      if (!buckets.has(key)) buckets.set(key, { font: item.font, field: diff.field, entries: [] });
      buckets.get(key).entries.push({ id: item.id, tags: item.tags, ...diff });
    }
  }
  return [...buckets.values()].map(({ font, field, entries }) => {
    const byCase = new Map();
    for (const entry of entries) {
      if (!byCase.has(entry.id)) byCase.set(entry.id, { ...entry, elements: 0 });
      const item = byCase.get(entry.id);
      if (entry.abs > item.abs) Object.assign(item, { path: entry.path, before: entry.before, after: entry.after });
      item.abs = Math.max(item.abs, entry.abs);
      item.rel = Math.max(item.rel, entry.rel);
      item.invalid ||= entry.invalid;
      item.elements++;
    }
    const caseValues = [...byCase.values()];
    return { font, field, caseCount: caseValues.length,
      absolute: summarize(entries.map(entry => entry.abs)), relative: summarize(entries.map(entry => entry.rel)),
      perCase: { absolute: summarize(caseValues.map(entry => entry.abs)), relative: summarize(caseValues.map(entry => entry.rel)) },
      invalid: entries.filter(entry => entry.invalid).length,
      worst: caseValues.sort((a, b) => b.abs - a.abs || b.rel - a.rel || a.id.localeCompare(b.id)).slice(0, 200) };
  }).sort((a, b) => a.font.localeCompare(b.font) || a.field.localeCompare(b.field));
}
