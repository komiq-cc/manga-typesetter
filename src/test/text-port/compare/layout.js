import { compareNumbers } from './numbers.js';
import { equal } from './stats.js';

const glyphs = curve => (Array.isArray(curve) ? curve.map(glyph => glyph.ch) : curve ?? null);
const choice = solve => (solve ? { size: solve.size, lines: solve.lines, status: solve.status, reason: solve.reason } : null);

export function compareLayout(before, after) {
  const numbers = compareNumbers(before, after);
  const largest = prefix => Math.max(0, ...numbers.filter(item =>
    item.path === prefix || item.path.startsWith(`${prefix}.`)
      || item.path.startsWith(`${prefix}[`)).map(item => item.abs));
  const changes = [];
  // Include non-numeric decisions and added/removed keys, including curve chars.
  function walk(a, b, path) {
    if (equal(a, b) || (typeof a === 'number' && typeof b === 'number')) return;
    if (a && b && typeof a === 'object' && typeof b === 'object'
      && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
    } else {
      changes.push({ path, before: a ?? null, after: b ?? null });
    }
  }
  walk(before, after, '');
  const solve = before.solve !== undefined || after.solve !== undefined;
  const linesA = solve ? before.solve?.lines : before.lines;
  const linesB = solve ? after.solve?.lines : after.lines;
  const curved = Array.isArray(before.curve) && Array.isArray(after.curve)
    && linesA === null && linesB === null;
  return {
    numbers,
    linesComparable: !curved,
    linesIdentical: Array.isArray(linesA) && Array.isArray(linesB)
      && linesA.every(line => typeof line === 'string')
      && linesB.every(line => typeof line === 'string') && equal(linesA, linesB),
    // The decision, not the arithmetic: the overflow figures are numbers and
    // are compared as numbers above, where a last-digit difference between two
    // hosts is a tiny difference and not a changed verdict.
    verdictChanged: before.verdict?.fits !== after.verdict?.fits,
    largest: Object.fromEntries(['lineX', 'blockY', 'baseY', 'ink', 'curve', 'solve'].map(key => [key, largest(key)])),
    // Which glyphs are set, in what order; where they sit is in `largest.curve`.
    curveChanged: !equal(glyphs(before.curve), glyphs(after.curve)),
    // What the solver chose. Its box may differ in the last digits between
    // hosts; a hundredth of a pixel is the same answer.
    solveChanged: !equal(choice(before.solve), choice(after.solve)) || largest('solve') > 0.01,
    changes
  };
}
