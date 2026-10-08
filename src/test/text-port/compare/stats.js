// Nearest-rank p99 preserves tail failures; median uses the two middle values.
export function summarize(values) {
  if (values instanceof Distribution) return values.summarize();
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  if (!count) return { count: 0, max: null, median: null, p50: null, p99: null };
  const middle = Math.floor(count / 2);
  const median = count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count, max: sorted[count - 1], median, p50: median, p99: sorted[Math.ceil(count * 0.99) - 1] };
}

export function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && equal(a[key], b[key]));
}

// JSON cannot represent non-finite differences. Preserve them explicitly.
export function json(value, space = 0) {
  return JSON.stringify(value, (_, item) => typeof item === 'number' && !Number.isFinite(item) ? String(item) : item, space);
}

// Exact quantiles with one entry per distinct value, rather than one per
// repeated glyph/array observation. Counts retain every observation.
export class Distribution {
  constructor() {
    this.values = new Map();
    this.count = 0;
  }

  push(value) {
    this.values.set(value, (this.values.get(value) ?? 0) + 1);
    this.count++;
  }

  summarize() {
    if (!this.count) return summarize([]);
    const entries = [...this.values].sort(([a], [b]) => a - b);
    const ranks = [Math.floor((this.count - 1) / 2), Math.floor(this.count / 2), Math.ceil(this.count * 0.99) - 1];
    const found = [];
    let seen = 0;
    for (const [value, count] of entries) {
      for (let i = 0; i < ranks.length; i++) {
        if (seen <= ranks[i] && ranks[i] < seen + count) found[i] = value;
      }
      seen += count;
    }
    const median = (found[0] + found[1]) / 2;
    return { count: this.count, max: entries.at(-1)[0], median, p50: median, p99: found[2] };
  }
}
