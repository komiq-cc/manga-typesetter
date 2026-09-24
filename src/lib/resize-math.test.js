import { describe, it, expect } from 'vitest';
import { resizeBoxMath } from './resize-math.js';

describe('resizeBoxMath', () => {
  const box = (over = {}) => ({
    x: 100,
    y: 100,
    w: 120,
    h: 200,
    size: 20,
    ...over,
  });

  // (a) S-edge drag upward past the text with autoHeight on -> h == floor, not 30
  it('(a) S-edge drag upward past the text with autoHeight on floors at text height, not 30', () => {
    const o = box({ h: 200 });
    const floor = 100; // text requires 100px
    // Drag upward by 150px (without floor would be 200 - 150 = 50; with dy = -180 would be 30)
    const res = resizeBoxMath(0, -150, 's', o, 0, floor);
    expect(res.h).toBe(floor);
    expect(res.h).not.toBe(30);
    // S-edge drag leaves top edge (y) unchanged
    expect(res.y).toBe(o.y);
  });

  // (b) N-edge drag with autoHeight on -> h floored and bottom edge stays put (unrotated)
  it('(b) N-edge drag with autoHeight on floors height and bottom edge stays put', () => {
    const o = box({ y: 100, h: 200 });
    const originalBottom = o.y + o.h; // 300
    const floor = 100;
    // Drag N edge downward by 150px (attempting to shrink height to 50px)
    const res = resizeBoxMath(0, 150, 'n', o, 0, floor);
    expect(res.h).toBe(floor);
    // The bottom edge must stay exactly at 300
    expect(res.y + res.h).toBe(originalBottom);
    expect(res.y).toBe(200);
  });

  // (c) S-edge drag taller -> h grows
  it('(c) S-edge drag taller grows the box height', () => {
    const o = box({ h: 200 });
    const floor = 100;
    // Drag downward by 60px
    const res = resizeBoxMath(0, 60, 's', o, 0, floor);
    expect(res.h).toBe(260);
    expect(res.h).toBeGreaterThan(o.h);
    expect(res.y).toBe(o.y);
  });

  // (d) autoHeight off -> old min 30 behaviour
  it('(d) autoHeight off keeps old min 30 behaviour', () => {
    const o = box({ y: 100, h: 200 });
    // Drag S-edge upward past 30 (dy = -190 -> 200 - 190 = 10 < 30)
    const resS = resizeBoxMath(0, -190, 's', o, 0, 30);
    expect(resS.h).toBe(30);
    expect(resS.y).toBe(o.y);

    // Also with default floor (omitted 6th argument)
    const resDefault = resizeBoxMath(0, -190, 's', o, 0);
    expect(resDefault.h).toBe(30);

    // N-edge drag past 30 with autoHeight off floors at 30 and keeps bottom edge anchored
    const resN = resizeBoxMath(0, 190, 'n', o, 0, 30);
    expect(resN.h).toBe(30);
    expect(resN.y + resN.h).toBe(o.y + o.h);
  });

  describe('additional edge and corner coverage', () => {
    it('scales font size on corner drag (se)', () => {
      const o = box({ w: 100, h: 100, size: 20 });
      // Drag corner to double height: 100 -> 200
      const res = resizeBoxMath(100, 100, 'se', o, 0, 50);
      expect(res.w).toBe(200);
      expect(res.h).toBe(200);
      expect(res.size).toBe(40);
    });

    it('enforces min width 40 on E and W edge drags without touching height', () => {
      const o = box({ x: 100, w: 100, h: 100 });
      // Drag E edge inward past 40
      const resE = resizeBoxMath(-80, 0, 'e', o, 0);
      expect(resE.w).toBe(40);
      expect(resE.h).toBe(100);
      expect(resE.x).toBe(100);

      // Drag W edge inward past 40 -> opposite edge (x + w = 200) stays put
      const resW = resizeBoxMath(80, 0, 'w', o, 0);
      expect(resW.w).toBe(40);
      expect(resW.x + resW.w).toBe(200);
      expect(resW.h).toBe(100);
    });

    it('keeps the bottom edge put on a floored N-edge drag of a rotated box', () => {
      const o = box({ x: 100, y: 100, w: 100, h: 100 });
      // Midpoint of the bottom edge on the page, for a box rotated clockwise.
      const bottomMid = (b, deg) => {
        const t = (deg * Math.PI) / 180;
        return [b.x + b.w / 2 - (b.h / 2) * Math.sin(t), b.y + b.h / 2 + (b.h / 2) * Math.cos(t)];
      };
      for (const deg of [30, 90, -45]) {
        const res = resizeBoxMath(0, 70, 'n', o, deg, 60);
        expect(res.h).toBe(60);
        const [ax, ay] = bottomMid(o, deg), [bx, by] = bottomMid(res, deg);
        expect(bx).toBeCloseTo(ax, 6);
        expect(by).toBeCloseTo(ay, 6);
      }
    });
  });
});
