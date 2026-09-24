// Edge and corner resize geometry for a text box, pulled out of TextBox.svelte's
// pointer handler so it can be tested without a DOM. The height floor is applied
// BEFORE the opposite-edge anchor is worked out, so a clamped top-edge drag
// still leaves the bottom edge where it was.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// `o` is the box at pointer-down ({ x, y, w, h, size }), `dx`/`dy` the pointer
// travel already turned into the box's own frame, `rotation` its angle in
// degrees. `heightFloor` is how short an edge drag may make the box: the text's
// own height while auto-height is on, so a drag can never leave text hanging
// out of the bottom, and 30 otherwise. A corner drag ignores it - it scales the
// font with the height, so the text shrinks along with the box.
export function resizeBoxMath(dx, dy, dir, o, rotation = 0, heightFloor = 30) {
  const rad = (-(rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hasE = dir.includes('e'), hasW = dir.includes('w'), hasN = dir.includes('n'), hasS = dir.includes('s');
  const corner = (hasE || hasW) && (hasN || hasS);
  const floor = corner ? 30 : Math.max(30, heightFloor);

  let nw = o.w, nh = o.h;
  if (hasE) nw = Math.max(40, o.w + dx);
  if (hasW) nw = Math.max(40, o.w - dx);
  if (hasS) nh = Math.max(floor, o.h + dy);
  if (hasN) nh = Math.max(floor, o.h - dy);
  // Opposite edge anchor for rotated box scaling.
  const shiftX = hasE ? (nw - o.w) / 2 : hasW ? (o.w - nw) / 2 : 0;
  const shiftY = hasS ? (nh - o.h) / 2 : hasN ? (o.h - nh) / 2 : 0;
  const x = o.x + o.w / 2 + (shiftX * cos + shiftY * sin) - nw / 2;
  const y = o.y + o.h / 2 + (shiftY * cos - shiftX * sin) - nh / 2;

  const size = corner && o.h > 0 ? clamp(Math.round(o.size * (nh / o.h)), 6, 200) : undefined;
  return { x, y, w: nw, h: nh, size };
}
