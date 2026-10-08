// Which code points a font file has a glyph for, read from its `cmap` table.
//
// The corpus needs this and nothing else from a font: a string with a letter
// the face lacks is drawn from whatever fallback face the host has, so two
// engines disagreeing on it says nothing about either engine. Those cases are
// tagged and judged apart. The reader is the harness's own so that the answer
// does not come from any engine under test.

const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

// The subtable a browser would use: full Unicode before the BMP-only ones,
// and the symbol encoding last.
const RANK = [
  [3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0], [3, 0],
];

function subtable(buf) {
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') throw new Error('font collections are not supported');
  if (tag !== 'OTTO' && tag !== 'true' && u32(buf, 0) !== 0x00010000) throw new Error('not a TrueType or OpenType font');
  const tables = u16(buf, 4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = u32(buf, rec + 8);
  }
  if (cmap < 0) throw new Error('font has no cmap table');
  const found = new Map();
  for (let i = 0, n = u16(buf, cmap + 2); i < n; i++) {
    const rec = cmap + 4 + i * 8;
    found.set(`${u16(buf, rec)},${u16(buf, rec + 2)}`, cmap + u32(buf, rec + 4));
  }
  for (const [platform, encoding] of RANK) {
    const at = found.get(`${platform},${encoding}`);
    if (at === undefined) continue;
    const format = u16(buf, at);
    if ([0, 4, 6, 12].includes(format)) return { at, format, symbol: platform === 3 && encoding === 0 };
  }
  throw new Error('font has no cmap subtable this reader knows');
}

// Sorted, merged `[first, last]` ranges of the code points that map to a glyph
// other than glyph 0, the "missing" glyph.
export function coverage(buf) {
  const { at, format, symbol } = subtable(buf);
  const ranges = [];
  const add = (cp) => {
    const last = ranges[ranges.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else ranges.push([cp, cp]);
  };
  if (format === 0) {
    for (let cp = 0; cp < 256; cp++) if (buf[at + 6 + cp]) add(cp);
  } else if (format === 6) {
    const first = u16(buf, at + 6);
    for (let i = 0, n = u16(buf, at + 8); i < n; i++) if (u16(buf, at + 10 + i * 2)) add(first + i);
  } else if (format === 4) {
    const segs = u16(buf, at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const offsets = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = u16(buf, ends + s * 2);
      const start = u16(buf, starts + s * 2);
      const delta = u16(buf, deltas + s * 2);
      const offset = u16(buf, offsets + s * 2);
      for (let cp = start; cp <= end && cp < 0xffff; cp++) {
        let glyph;
        if (offset === 0) glyph = (cp + delta) & 0xffff;
        else {
          const where = offsets + s * 2 + offset + (cp - start) * 2;
          const raw = where + 2 <= buf.length ? u16(buf, where) : 0;
          glyph = raw ? (raw + delta) & 0xffff : 0;
        }
        if (glyph) add(cp);
      }
    }
  } else {
    for (let g = 0, n = u32(buf, at + 12); g < n; g++) {
      const rec = at + 16 + g * 12;
      const start = u32(buf, rec);
      const end = u32(buf, rec + 4);
      const glyph = u32(buf, rec + 8);
      for (let cp = start; cp <= end; cp++) if (glyph + (cp - start)) add(cp);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { ranges: merged, symbol };
}

export function covers(ranges, cp) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}
