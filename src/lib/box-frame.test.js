import { describe, it, expect } from 'vitest';
import { screenPoint, flipPoint, flipDelta, mirrorTransform, mirrorCss } from './box-frame.js';
import { handlePoints, warpDragGesture, nudgeDelta } from './warp-gizmo.js';
import { liquifyMeshGesture } from './liquify-mesh.js';
import { defaultPathPts, normalizeStyle } from './data.js';

// Every gizmo on a flipped box has to agree with the picture: a handle is drawn
// where the flipped result shows the thing it moves, and a drag moves the
// result the way the pointer went. The points are stored unflipped (the export
// flips the finished bitmap last), so each gizmo goes screen -> stored through
// `flipPoint`/`flipDelta` and draws stored -> screen through `mirrorCss`.
//
// `drawn` applies an overlay's inline mirror the way CSS does - scale about
// the transform origin - so what is asserted is where the browser puts it.

const W = 200;
const H = 100;
const FLIPS = [
  { flipH: true, flipV: false },
  { flipH: false, flipV: true },
  { flipH: true, flipV: true },
];
const boxOf = (flip, extra = {}) => ({
  id: 'b1',
  x: 40,
  y: 30,
  w: W,
  h: H,
  text: 'A',
  style: normalizeStyle({ ...flip, ...extra }),
});

function drawn(css, [x, y], z = 1) {
  if (!css) return [x, y];
  const m = /scale\((-?1), (-?1)\);transform-origin:([\d.]+)px ([\d.]+)px/.exec(css);
  const [sx, sy, ox, oy] = m.slice(1).map(Number);
  return [(ox + sx * (x * z - ox)) / z, (oy + sy * (y * z - oy)) / z];
}

describe('the two frames', () => {
  it('undoes the zoom, the box position and the rotation into the screen frame', () => {
    const origin = { left: 10, top: 20 };
    const box = boxOf({}, { rotation: 0 });
    expect(screenPoint(10 + (40 + 5) * 2, 20 + (30 + 7) * 2, origin, 2, box)).toEqual([5, 7]);
    // A quarter turn clockwise: 20 px below the centre on screen is 20 px
    // right of it in the box's own frame.
    const turned = boxOf({}, { rotation: 90 });
    const [x, y] = screenPoint(10 + 40 + 100, 20 + 30 + 50 + 20, origin, 1, turned);
    expect(x).toBeCloseTo(120, 9);
    expect(y).toBeCloseTo(50, 9);
  });

  it('mirrors a point about the centre on each flipped axis, and back again', () => {
    expect(flipPoint([30, 20], boxOf({}))).toEqual([30, 20]);
    expect(flipPoint([30, 20], boxOf(FLIPS[0]))).toEqual([170, 20]);
    expect(flipPoint([30, 20], boxOf(FLIPS[1]))).toEqual([30, 80]);
    expect(flipPoint([30, 20], boxOf(FLIPS[2]))).toEqual([170, 80]);
    for (const f of FLIPS) expect(flipPoint(flipPoint([30, 20], boxOf(f)), boxOf(f))).toEqual([30, 20]);
    expect(flipDelta([3, -4], FLIPS[2])).toEqual([-3, 4]);
    expect(flipDelta([3, -4], {})).toEqual([3, -4]);
  });

  it("states the overlay mirror as the box's own flip, about the box's centre", () => {
    expect(mirrorTransform({})).toBe('');
    expect(mirrorCss({}, W, H)).toBe('');
    expect(mirrorTransform(FLIPS[0])).toBe('scale(-1, 1)');
    for (const f of FLIPS) {
      for (const z of [1, 1.5]) {
        const [x, y] = drawn(mirrorCss(f, W * z, H * z), [30, 20], z);
        const [ex, ey] = flipPoint([30, 20], boxOf(f));
        expect(x).toBeCloseTo(ex, 9);
        expect(y).toBeCloseTo(ey, 9);
      }
    }
  });
});

describe('the warp gizmo on a flipped box', () => {
  for (const f of FLIPS) {
    it(`draws a handle on its flipped point and drags it under the pointer (${JSON.stringify(f)})`, () => {
      const box = boxOf(f, { warp: { on: true, cols: 2, rows: 2 } });
      const css = mirrorCss(box.style, W, H);
      // Handle 0 is the stored top-left corner; flipped, it shows elsewhere.
      const h0 = handlePoints(box.style.warp, W, H)[0];
      const shown = drawn(css, [h0.x, h0.y]);
      expect(shown).toEqual(flipPoint([0, 0], box));

      // The pointer grabs it where it is shown and goes to (60, 30) on screen.
      // `toLocal` is the box's `maskLocal`: the screen point, flipped out.
      const g = warpDragGesture(box, 1, 0);
      const start = flipPoint(shown, box);
      const p0 = box.style.warp.pts[0];
      const [gx, gy] = [p0[0] - start[0], p0[1] - start[1]];
      const [x, y] = flipPoint([60, 30], box);
      g.to(x + gx, y + gy);
      const q = box.style.warp.pts[0];
      expect(drawn(css, q)).toEqual([60, 30]);

      // An arrow key moves it the way the arrow points, on screen.
      g.by(...flipDelta(nudgeDelta('ArrowRight'), box.style));
      g.by(...flipDelta(nudgeDelta('ArrowDown', true), box.style));
      expect(drawn(css, box.style.warp.pts[0])).toEqual([61, 40]);
      g.cancel();
    });
  }
});

describe('liquify on a flipped box', () => {
  // The same screen drag on a flipped box and on its unflipped twin must show
  // the same picture: the flipped mesh, drawn through the flip, is the twin's.
  const tool = { mode: 'push', radius: 40, strength: 100 };
  const sorted = (pts) => pts.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function push(box, path) {
    const g = liquifyMeshGesture(box, 1, tool);
    let [lx, ly] = flipPoint(path[0], box);
    for (const p of path.slice(1)) {
      const [x, y] = flipPoint(p, box);
      g.step({ cx: x, cy: y, dx: x - lx, dy: y - ly, scale: 1 });
      lx = x;
      ly = y;
    }
    const out = box.style.warp.pts.map((p) => [...p]);
    g.cancel();
    return out;
  }
  for (const f of FLIPS) {
    it(`bends the mesh the way the pointer went, under the ring (${JSON.stringify(f)})`, () => {
      const path = [[60, 40], [70, 46], [82, 50]];
      const twin = push(boxOf({}), path);
      const box = boxOf(f);
      const flipped = push(box, path);
      const css = mirrorCss(box.style, W, H);
      expect(sorted(flipped.map((p) => drawn(css, p)))).toEqual(sorted(twin));
      // And it did bend: the drag moved something off the identity mesh.
      const still = push(boxOf({}), path.slice(0, 1));
      expect(sorted(twin)).not.toEqual(sorted(still));
    });
  }
});

describe('the path gizmo on a flipped box', () => {
  for (const f of FLIPS) {
    it(`draws the anchors flipped and moves them with the pointer (${JSON.stringify(f)})`, () => {
      const box = boxOf(f, { path: { on: true, pts: defaultPathPts(W, H) } });
      const css = mirrorCss(box.style, W, H);
      const pt = box.style.path.pts[0];
      const before = drawn(css, [pt.x, pt.y]);
      expect(before).toEqual(flipPoint([pt.x, pt.y], box));
      // `startPathDrag`: the screen delta, rotation undone, mirrored in.
      const [dx, dy] = flipDelta([15, -8], box.style);
      const after = drawn(css, [pt.x + dx, pt.y + dy]);
      expect(after[0] - before[0]).toBeCloseTo(15, 9);
      expect(after[1] - before[1]).toBeCloseTo(-8, 9);
    });
  }
});
