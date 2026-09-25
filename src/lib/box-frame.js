// ===== where a pointer lands, in a box's own frames =====
//
// Two frames, one step apart, and every gizmo on a box works in one of them.
//
// The SCREEN frame is box-local page px with the box's rotation undone: what
// the box's own element shows, and what an overlay drawn as its child (the
// selection handles, the liquify ring) is placed in with no maths at all.
//
// The STORED frame is that, mirrored by the box's flip. The mask shapes, the
// warp mesh and the bezier path are all stated before the flip, because the
// export makes the flip last - `paintBoxOnPage` mirrors the finished bitmap
// about the box's centre - and the editor does the same with `wrapMirror`. So
// a point under the pointer is stored mirrored, and a gizmo that draws stored
// points draws them through the same mirror (`mirrorCss`), which puts every
// handle on the part of the flipped picture it moves.
//
// The flip is its own inverse, so `flipPoint` maps both ways.

// A client-space pointer position in the screen frame. `origin` is the page
// frame's client rect (only its left/top are read), `zoom` the editor's.
export function screenPoint(clientX, clientY, origin, zoom, box) {
  const px = (clientX - origin.left) / zoom - box.x;
  const py = (clientY - origin.top) / zoom - box.y;
  const rad = (-(box.style?.rotation || 0) * Math.PI) / 180;
  if (!rad) return [px, py];
  const cx = box.w / 2;
  const cy = box.h / 2;
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * Math.cos(rad) - dy * Math.sin(rad), cy + dx * Math.sin(rad) + dy * Math.cos(rad)];
}

// A point between the screen frame and the stored one: mirrored about the
// box's centre on each flipped axis.
export function flipPoint([x, y], box) {
  const s = box.style;
  return [s?.flipH ? box.w - x : x, s?.flipV ? box.h - y : y];
}

// A step between the two frames - a drag's delta, an arrow key's nudge. A
// mirror about the centre reverses a step without moving it.
export function flipDelta([dx, dy], style) {
  return [style?.flipH ? -dx : dx, style?.flipV ? -dy : dy];
}

// The flip as a CSS transform, or '' for an unflipped box.
export function mirrorTransform(style) {
  return style?.flipH || style?.flipV ? `scale(${style.flipH ? -1 : 1}, ${style.flipV ? -1 : 1})` : '';
}

// The inline style that draws an overlay of stored points mirrored with the
// box: the flip, about the centre of a `w` x `h` (zoomed px) overlay whose
// top-left is the box's.
export function mirrorCss(style, w, h) {
  const m = mirrorTransform(style);
  return m ? `transform:${m};transform-origin:${w / 2}px ${h / 2}px;` : '';
}
