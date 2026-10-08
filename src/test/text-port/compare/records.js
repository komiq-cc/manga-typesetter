import { equal } from './stats.js';
export const groups = ['metrics', 'layout', 'pixels'];

export function parseJsonl(text, label) {
  const records = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`${label}:${index + 1}: invalid JSON`); }
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !/^[a-z0-9._-]+$/.test(record.id)) {
      throw new Error(`${label}:${index + 1}: invalid case id`);
    }
    if (records.has(record.id)) throw new Error(`${label}:${index + 1}: duplicate id ${record.id}`);
    records.set(record.id, record);
  });
  return records;
}

export function caseMetadata(id, corpus) {
  const item = corpus?.get(id);
  const style = item?.box?.style ?? item?.solve?.style;
  return { font: item?.font ?? style?.font ?? id.split('.')[0], tags: item?.tags ?? [],
    mode: item?.mode ?? (/\.(smart|plain)$/.exec(id)?.[1] ?? null), size: item?.size ?? style?.size ?? item?.solve?.size ?? null };
}

export function joinRuns(before, after, corpus = {}) {
  const cases = [];
  for (const group of groups) {
    for (const id of new Set([...before[group].keys(), ...after[group].keys(), ...(corpus[group]?.keys() ?? [])])) {
      const a = before[group].get(id);
      const b = after[group].get(id);
      let status = 'compared';
      if (a?.error !== undefined || b?.error !== undefined) status = 'error';
      else if (!a || !b) status = 'missing';
      else if (a.skip !== undefined || b.skip !== undefined) status = a.skip !== undefined && b.skip !== undefined ? 'skipped' : 'skip-mismatch';
      cases.push({ group, id, ...caseMetadata(id, corpus[group]), status, before: a ?? null, after: b ?? null, numbers: [], gates: [] });
    }
  }
  return cases;
}

export function manifestDifferences(a, b) {
  return ['corpus', 'fonts'].filter(key => !equal(a[key], b[key]));
}
