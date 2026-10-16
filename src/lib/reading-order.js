// Line numbers are page-local joins, not labels. Change every live join in one
// synchronous pass, using a complete map so swaps never read a number already
// written by this pass. Free rows keep both their numbers and their slots.
export const orderMap = (entry, dir = 'redo') =>
  new Map(entry.numbers.map(([before, after]) => dir === 'undo' ? [after, before] : [before, after]));

export function applyLineOrder(p, entry, dir = 'redo') {
  const numbers = orderMap(entry, dir);
  const order = dir === 'undo' ? entry.before : entry.numbers.map(([, n]) => n);
  const imported = p.lines.filter((l) => !(l.n < 0));
  const targets = new Set(numbers.values());
  if (
    imported.length !== numbers.size || new Set(imported.map((l) => l.n)).size !== numbers.size ||
    imported.some((l) => !Number.isFinite(l.n) || l.n <= 0 || !numbers.has(l.n)) ||
    targets.size !== numbers.size || order.length !== numbers.size ||
    new Set(order).size !== numbers.size || order.some((n) => !Number.isFinite(n) || n <= 0 || !targets.has(n))
  ) throw new Error('the queue line numbers are not unique or have changed');
  // An orphan must not silently become attached when a sparse page is numbered
  // from one. Refuse that ambiguous edit before touching any part of the page.
  const refs = [p.activeLineN, ...p.boxes.map((b) => b.lineN), ...(p.detect?.boxes ?? []).map((d) => d.n)];
  if (refs.some((n) => n > 0 && !numbers.has(n) && targets.has(n))) {
    throw new Error('a line number has no queue line');
  }
  const remap = (n) => numbers.get(n) ?? n;
  for (const l of imported) l.n = remap(l.n);
  const byN = new Map(imported.map((l) => [l.n, l]));
  let i = 0;
  p.lines = p.lines.map((l) => l.n < 0 ? l : byN.get(order[i++]));
  for (const b of p.boxes) if (b.lineN > 0) b.lineN = remap(b.lineN);
  p.activeLineN = remap(p.activeLineN);
  for (const d of p.detect?.boxes ?? []) if (d.n > 0) d.n = remap(d.n);
}

// Ordinary history entries use the page's CURRENT numbering, even when their
// box is temporarily deleted. Order entries instead describe transitions:
// their maps and before-order stay immutable, and are crossed in stack order.
// Copy on change because the history file also holds these same entry objects.
export function remapLineEntry(e, pageId, numbers) {
  if (e.pageId !== pageId || e.t === 'order') return e;
  let out = e;
  const put = (key, value) => {
    if (value === e[key]) return;
    if (out === e) out = { ...e };
    out[key] = value;
  };
  const remap = (n) => numbers.get(n) ?? n;
  const box = (b) => b && remap(b.lineN) !== b.lineN ? { ...b, lineN: remap(b.lineN) } : b;
  for (const key of ['lineN', 'activeBefore', 'activeAfter']) put(key, remap(e[key]));
  put('box', box(e.box));
  if (e.line && remap(e.line.n) !== e.line.n) put('line', { ...e.line, n: remap(e.line.n) });
  if (e.items) {
    const items = e.items.map((it) => {
      const b = box(it.box);
      return b === it.box ? it : { ...it, box: b };
    });
    if (items.some((it, i) => it !== e.items[i])) put('items', items);
  }
  return out;
}

export function remapLineStack(stack, entry, dir = 'redo') {
  const numbers = orderMap(entry, dir);
  const remap = (e) => remapLineEntry(e, entry.pageId, numbers);
  return { undo: stack.undo.map(remap), redo: stack.redo.map(remap) };
}
