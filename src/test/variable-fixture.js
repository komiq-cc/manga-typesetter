// Font files made in a test, in memory, out of a fixture font: a variable
// font (an `fvar` table put into Comic Neue) and a font whose name records
// say nothing. The repository ships no variable font and no damaged one, and
// is not to: what a test needs of such a file it writes here.
//
// A font made this way has axes and no `gvar`, so its outlines and advances
// are the same everywhere on them. What it is for is everything else: which
// numbers of a file the engine believes, where an instance is, what it is
// called.

const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const tagBytes = (tag) => [...tag].map((c) => c.charCodeAt(0));
/** A number as the 16.16 an `fvar` holds. */
const fixed = (v) => u32(Math.round(v * 65536) | 0);

/** `font` (an sfnt, as bytes) with `tables` (`{ tag: bytes }`) added, or put in place of the ones it has. */
export function withTables(font, tables) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const all = [];
  for (let i = 0; i < view.getUint16(4); i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...font.subarray(rec, rec + 4));
    if (tag in tables) continue;
    all.push([tag, font.subarray(view.getUint32(rec + 8), view.getUint32(rec + 8) + view.getUint32(rec + 12))]);
  }
  for (const [tag, data] of Object.entries(tables)) all.push([tag, Uint8Array.from(data)]);
  all.sort(([a], [b]) => (a < b ? -1 : 1));
  const head = 12 + all.length * 16;
  const padded = (n) => (n + 3) & ~3;
  const out = new Uint8Array(head + all.reduce((n, [, d]) => n + padded(d.length), 0));
  out.set(font.subarray(0, 4));
  out.set(u16(all.length), 4);
  let at = head;
  all.forEach(([tag, data], i) => {
    out.set([...tagBytes(tag), 0, 0, 0, 0, ...u32(at), ...u32(data.length)], 12 + i * 16);
    out.set(data, at);
    at += padded(data.length);
  });
  return out;
}

/**
 * An `fvar` table. `axes` is `[[tag, min, default, max]]` - any numbers, a
 * range or not; `instances` is `[{ style, at, postScriptName }]`: the name
 * IDs of a named instance's style and (optionally) PostScript name, and its
 * value on each axis.
 */
export function fvarTable(axes, instances = []) {
  const withName = instances.some((i) => i.postScriptName != null);
  const out = [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(axes.length), ...u16(20), ...u16(instances.length), ...u16(4 + 4 * axes.length + (withName ? 2 : 0))];
  for (const [tag, min, def, max] of axes) out.push(...tagBytes(tag), ...fixed(min), ...fixed(def), ...fixed(max), 0, 0, 1, 0);
  for (const i of instances) out.push(...u16(i.style), 0, 0, ...i.at.flatMap(fixed), ...(withName ? u16(i.postScriptName ?? 0xffff) : []));
  return Uint8Array.from(out);
}

/** `font` as a variable font with these axes. */
export const variableFont = (font, axes, instances) => withTables(font, { fvar: fvarTable(axes, instances) });

/** `font` with every record of name ID `id` turned to spaces: a name that is there and says nothing. */
export function blankName(font, id = 6) {
  const out = Uint8Array.from(font);
  const view = new DataView(out.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(...out.subarray(rec, rec + 4)) !== 'name') continue;
    const table = view.getUint32(rec + 8);
    const strings = table + view.getUint16(table + 4);
    for (let n = 0; n < view.getUint16(table + 2); n++) {
      const at = table + 6 + n * 12;
      if (view.getUint16(at + 6) !== id) continue;
      const wide = view.getUint16(at) !== 1; // every platform but Macintosh is UTF-16BE
      const start = strings + view.getUint16(at + 10);
      for (let k = 0; k < view.getUint16(at + 8); k++) out[start + k] = wide && k % 2 === 0 ? 0 : 0x20;
    }
  }
  return out;
}
