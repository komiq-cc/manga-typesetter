import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { coverage, covers } from '../../../scripts/text-port/lib/cmap.mjs';

const font = (name) => readFileSync(new URL(`../fonts/${name}`, import.meta.url));

describe('which letters a font file has', () => {
  it('reads a Latin face: its letters are there, kana is not', () => {
    const { ranges, symbol } = coverage(font('ComicNeue-Regular.ttf'));
    expect(symbol).toBe(false);
    for (const ch of 'AVATAR wave, 0189!?') expect(covers(ranges, ch.codePointAt(0)), ch).toBe(true);
    expect(covers(ranges, 0x3042)).toBe(false);
    expect(covers(ranges, 0x1f600)).toBe(false);
  });

  it('reads a wide face past Latin', () => {
    const { ranges } = coverage(font('DejaVuSans.ttf'));
    for (const cp of [0x41, 0xe9, 0x2026, 0x203c, 0x416]) expect(covers(ranges, cp), cp.toString(16)).toBe(true);
    expect(covers(ranges, 0x3042)).toBe(false);
  });

  it('keeps its ranges sorted and apart, so the search can halve them', () => {
    const { ranges } = coverage(font('Bangers-Regular.ttf'));
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1] + 1);
    for (const [a, b] of ranges) expect(b).toBeGreaterThanOrEqual(a);
  });

  it('refuses what is not a font rather than answering for it', () => {
    expect(() => coverage(Buffer.from('not a font at all, just text'))).toThrow(/not a TrueType or OpenType font/);
  });
});
