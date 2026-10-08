import { compareNumbers } from './numbers.js';
import { equal } from './stats.js';

export function compareLayout(before, after) {
  const numbers = compareNumbers(before, after);
  const largest = prefix => Math.max(0, ...numbers.filter(item => item.path === prefix || item.path.startsWith(`${prefix}.`) || item.path.startsWith(`${prefix}[`)).map(item => item.abs));
  const changes = [];
  // Include non-numeric decisions and added/removed keys, including curve chars.
  function walk(a, b, path) {
    if (equal(a, b) || (typeof a === 'number' && typeof b === 'number')) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key);
    } else changes.push({ path, before: a ?? null, after: b ?? null });
  }
  walk(before, after, '');
  const solve = before.solve !== undefined || after.solve !== undefined;
  const linesA = solve ? before.solve?.lines : before.lines;
  const linesB = solve ? after.solve?.lines : after.lines;
  return { numbers, linesIdentical: Array.isArray(linesA) && Array.isArray(linesB) && linesA.every(line => typeof line === 'string') && linesB.every(line => typeof line === 'string') && equal(linesA, linesB),
    verdictChanged: !equal(before.verdict, after.verdict), largest: Object.fromEntries(['lineX', 'blockY', 'baseY', 'ink', 'curve', 'solve'].map(key => [key, largest(key)])),
    curveChanged: !equal(before.curve, after.curve), solveChanged: !equal(before.solve, after.solve), changes };
}
