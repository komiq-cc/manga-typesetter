// A TrueType collection built in memory out of plain font files, for the
// tests that need one: no `.ttc` is in the repository, and the ones a machine
// has cannot be copied into it.
//
// A collection is a `ttcf` header listing where each font's table directory
// starts, then the fonts. A font's directory addresses its tables from the
// start of the FILE, so each font is copied whole and its table offsets are
// moved by where the copy landed. Nothing is shared between the fonts, which
// a real collection would do and no reader requires.

/**
 * @param {Uint8Array[]} fonts plain sfnt files
 * @returns {Uint8Array} one `.ttc` holding them, in order, as faces 0..n-1
 */
export function buildCollection(fonts) {
  const header = 12 + 4 * fonts.length;
  const pad4 = (n) => (n + 3) & ~3;
  let at = header;
  const starts = fonts.map((font) => {
    const start = at;
    at += pad4(font.byteLength);
    return start;
  });
  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  out.set([0x74, 0x74, 0x63, 0x66]); // 'ttcf'
  view.setUint32(4, 0x00010000); // version 1.0
  view.setUint32(8, fonts.length);
  fonts.forEach((font, i) => {
    const start = starts[i];
    view.setUint32(12 + 4 * i, start);
    out.set(font, start);
    const tables = view.getUint16(start + 4);
    for (let t = 0; t < tables; t++) {
      const record = start + 12 + 16 * t;
      view.setUint32(record + 8, view.getUint32(record + 8) + start);
    }
  });
  return out;
}

/** `system_font_face`'s answer for a file: where each slot's face is in it (`{ slot: index }`), then the bytes. */
export function systemFaceAnswer(slots, bytes) {
  const order = ['regular', 'bold', 'italic', 'boldItalic'];
  const out = new Uint8Array(16 + bytes.byteLength);
  const view = new DataView(out.buffer);
  order.forEach((slot, i) => view.setInt32(i * 4, slots[slot] ?? -1, true));
  out.set(bytes, 16);
  return out.buffer;
}
