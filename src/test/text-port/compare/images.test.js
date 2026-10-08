import { describe, it, expect } from 'vitest';
import { distanceTransform } from './distance.js';
import { alphaBbox, alignImages, compareAlpha, heatMap } from './images.js';

function brute(mask, w, h) {
  return Array.from(mask, (_, i) => {
    let squared = Infinity;
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
      if (x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x]) continue;
      squared = Math.min(squared, (i % w - x) ** 2 + (Math.floor(i / w) - y) ** 2);
    }
    return Math.sqrt(squared);
  });
}
const image = (width, height, alpha) => ({ width, height, alpha: Uint8Array.from(alpha) });
const origin = { ox: 0, oy: 0, ss: 1 };

describe('exact distance transform and alpha comparison', () => {
  it('matches brute force for 300 deterministic random masks, including rectangular grids', () => {
    let seed = 771;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let sample = 0; sample < 300; sample++) {
      const w = 1 + Math.floor(random() * 9);
      const h = 1 + Math.floor(random() * 9);
      const mask = Uint8Array.from({ length: w * h }, () => random() > 0.3 ? 1 : 0);
      expect([...distanceTransform(mask, w, h)]).toEqual(brute(mask, w, h));
    }
  });
  it('handles empty, full, singleton and diagonal distances with exterior background', () => {
    expect([...distanceTransform(new Uint8Array(25), 5, 5)]).toEqual(Array(25).fill(0));
    const full = new Uint8Array(25).fill(1);
    expect(distanceTransform(full, 5, 5)[12]).toBe(3);
    full[6] = 0;
    expect(distanceTransform(full, 5, 5)[12]).toBe(Math.sqrt(2));
    expect(distanceTransform(Uint8Array.of(1), 1, 1)[0]).toBe(1);
    expect(() => distanceTransform(Uint8Array.of(1), 2, 1)).toThrow();
  });
  it('aligns differently sized textures in device pixels using ss', () => {
    const a = image(2, 1, [255, 0]);
    const b = image(4, 1, [0, 0, 255, 0]);
    const aligned = alignImages(a, b, { ...origin, ss: 2 }, { ...origin, ss: 2, ox: 1 });
    expect(compareAlpha(aligned)).toMatchObject({ bboxDelta: 0, iou: 1, meanAbs: 0, thick: 0 });
  });
  it('uses the opposite origin sign for cropped page layers', () => {
    const a = image(3, 1, [0, 0, 255]);
    const b = image(1, 1, [255]);
    expect(compareAlpha(alignImages(a, b, { left: 10, top: 20, ss: 1 }, { left: 12, top: 20, ss: 1 }))).toMatchObject({ bboxDelta: 0, iou: 1, thick: 0 });
  });
  it('does not round away fractional relative origins or silently resample', () => {
    const a = image(1, 1, [255]);
    expect(() => alignImages(a, a, origin, { ...origin, ox: 0.25 })).toThrow('device-pixel grid');
    expect(() => alignImages(a, a, origin, { ...origin, ss: 2 })).toThrow('supersampling');
    expect(compareAlpha(alignImages(a, a, { ...origin, ox: 0.25 }, { ...origin, ox: 0.25 })).iou).toBe(1);
  });
  it('computes alpha support mean, threshold IoU, exclusive bbox and XOR thickness', () => {
    const aligned = alignImages(image(2, 1, [128, 100]), image(2, 1, [127, 0]), origin, origin);
    expect(compareAlpha(aligned)).toMatchObject({ bboxDelta: 1, iou: 0, meanAbs: 50.5, thick: 2, xorCount: 1 });
    expect(alphaBbox(Uint8Array.of(0, 1, 0, 1), 2, 2)).toEqual([1, 0, 2, 2]);
    expect([...heatMap(aligned).slice(0, 4)]).toEqual([255, 0, 255, 128]);
    expect([...heatMap(aligned).slice(4, 8)]).toEqual([255, 210, 0, 100]);
  });
  it('defines two empty images as identical and empty versus ink as infinite bbox change', () => {
    const empty = image(1, 1, [0]);
    expect(compareAlpha(alignImages(empty, empty, origin, origin))).toMatchObject({ bboxDelta: 0, iou: 1, meanAbs: 0, thick: 0 });
    expect(compareAlpha(alignImages(empty, image(1, 1, [255]), origin, origin))).toMatchObject({ bboxDelta: Infinity, iou: 0, thick: 2 });
  });
});
