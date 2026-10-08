import { describe, it, expect } from 'vitest';
import { buildCorpus, completeStyle } from './corpus.js';
import { defaultStyle, PATTERN_KINDS } from '../../lib/data.js';

const fonts = { version: 1, fonts: [
  { family: 'Comic Neue', slot: 'regular' }, { family: 'Bangers', slot: 'regular' },
  { family: 'DejaVu Sans', slot: 'regular' }, { family: 'DejaVu Sans', slot: 'italic' },
] };
const corpus = buildCorpus(fonts);
describe('the frozen synthetic text-port corpus', () => {
  it('has unique filename-safe ids, even for colliding family slugs', () => {
    const colliding = buildCorpus({ fonts: [...fonts.fonts, { family: 'A B', slot: 'regular' }, { family: 'A-B', slot: 'regular' }] });
    for (const cases of Object.values(colliding).map((c) => c.cases)) {
      expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
      expect(cases.every((c) => /^[a-z0-9._-]+$/.test(c.id) && !c.id.includes('..'))).toBe(true);
    }
  });
  it('builds byte-identically without mutating fonts or returned cases', () => {
    const before = JSON.stringify(fonts);
    const a = buildCorpus(fonts);
    const b = buildCorpus(fonts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    a.layout.cases[0].box.style.gradient.stops[0].color = '#123456';
    expect(b.layout.cases[0].box.style.gradient.stops[0].color).toBe('#ffffff');
    expect(JSON.stringify(fonts)).toBe(before);
  });
  it('provides every style field and nested default field', () => {
    const missing = [];
    function schema(actual, defaults, prefix) {
      for (const key of Object.keys(defaults)) {
        const path = `${prefix}.${key}`;
        if (!Object.hasOwn(actual, key)) missing.push(path);
        else if (defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) schema(actual[key], defaults[key], path);
      }
    }
    const defaults = defaultStyle();
    for (const c of Object.values(corpus).flatMap((v) => v.cases)) schema(c.style ?? c.box?.style ?? c.solve.style, defaults, c.id);
    expect(missing).toEqual([]);
    expect(completeStyle({ gradient: { on: true } }).gradient.stops).toEqual(defaultStyle().gradient.stops);
  });
  it('covers the requested case ranges, modes, slots and effects', () => {
    expect(corpus.layout.cases.length).toBeGreaterThanOrEqual(600);
    expect(corpus.layout.cases.length).toBeLessThanOrEqual(900);
    expect(corpus.layout.cases.filter((c) => c.solve)).toHaveLength(60);
    expect(corpus.pixels.cases.length).toBeGreaterThanOrEqual(250);
    expect(corpus.pixels.cases.length).toBeLessThanOrEqual(400);
    expect(new Set(corpus.layout.cases.map((c) => c.mode))).toEqual(new Set(['plain', 'smart']));
    expect(new Set(corpus.pixels.cases.filter((c) => c.box.style.pattern.on).map((c) => c.box.style.pattern.kind))).toEqual(new Set(PATTERN_KINDS));
    expect(corpus.metrics.cases.some((c) => c.tags.includes('missing-glyph'))).toBe(true);
    expect(corpus.metrics.cases.find((c) => c.font === 'DejaVu Sans' && c.italic && !c.bold).tags).not.toContain('faux-italic');
    expect(corpus.metrics.cases.find((c) => c.font === 'Comic Neue' && c.bold && c.italic).tags).toEqual(expect.arrayContaining(['faux-bold', 'faux-italic']));
  });
});
