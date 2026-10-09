import { afterEach, describe, expect, it } from 'vitest';
import { rustEngine, fixtureFont } from '../../test/rust-engine.js';
import { buildCollection } from '../../test/font-collection.js';
import { nameTable, variableFont, withTables } from '../../test/variable-fixture.js';
import { fontRequestFor, textLayerFor } from '../psd.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './index.js';
import { createRustGlyphPainter } from './rust-painter.js';
import { drawnFace, drawnRuns } from './drawn-face.js';
import { clearLayoutMemo } from '../measure.js';

const before = { engine: textEngine(), painter: glyphPainter() };
const damaged = (file, records = []) => withTables(fixtureFont(file), {
  name: nameTable([[1, 'Fixture'], [2, 'Regular'], [6, 'Bad/Name'], ...records]),
});
const comic = damaged('ComicNeue-Regular.ttf');
const dejavu = damaged('DejaVuSans.ttf');
const style = (font, bold = false, italic = false) => ({ font, bold, italic, size: 30, lineHeight: 1.1, align: 'left', valign: 'top', color: '#000000', strokes: [] });
const face = (name, bold = false, size = 30) => ({ name, bold, italic: false, size, key: `${name}/${bold}/${size}` });
const install = (engine) => { setTextEngine(engine); setGlyphPainter(createRustGlyphPainter(engine)); clearLayoutMemo(); };
const request = (font, bold = false, italic = false) => fontRequestFor(style(font, bold, italic));
const borrowedName = (engine, family, bold = false) => {
  engine.setFallbacks([family]);
  const layer = textLayerFor({ lines: [] }, { id: 'b', lineN: null, text: 'AΩ', x: 0, y: 0, w: 200, h: 100, style: style('Comic Neue', bold) }, null);
  return layer.text.styleRuns.find((run) => run.style.font).style.font.name;
};
const legal = (name) => name.length <= 127 && /^[!-~]+$/.test(name) && !/[\[\](){}<>/%]/.test(name);

afterEach(() => { setTextEngine(before.engine); setGlyphPainter(before.painter); clearLayoutMemo(); });

describe('PSD fallback identities follow the complete actual face', () => {
  it('keeps raw family distinctions in both primary and borrowed names, including whitespace normalization', async () => {
    const engine = await rustEngine();
    engine.addFace('Bad []', 'regular', comic);
    engine.addFace('Bad[]', 'regular', dejavu);
    install(engine);
    const one = request('Bad []').name;
    const two = request('Bad[]').name;
    expect(one).not.toBe(two);
    expect(legal(one) && legal(two)).toBe(true);
    expect(borrowedName(engine, 'Bad[]')).toBe(two);
    // Same DejaVu bytes registered under whitespace-distinct aliases must
    // still carry the raw family identity; no CSS normalization before hash.
    engine.addFace('Bad []', 'regular', dejavu);
    expect(request('Bad []').name).not.toBe(two);
    expect(borrowedName(engine, 'Bad []')).toBe(request('Bad []').name);
  });

  it('separates a default fallback from a valid named variable instance and keeps faux flags honest', async () => {
    const engine = await rustEngine();
    const bytes = withTables(variableFont(fixtureFont('ComicNeue-Regular.ttf'), [['wght', 100, 400, 900]], [{ style: 256, at: [700], postScriptName: 257 }]), {
      name: nameTable([[1, 'Test'], [2, 'Regular'], [6, 'Bad/Name'], [256, 'Heavy'], [257, 'Test']]),
    });
    engine.addFace('Test', 'regular', bytes);
    install(engine);
    const normal = request('Test');
    const heavy = request('Test', true);
    expect(normal.name).not.toBe('Test');
    expect(heavy).toEqual({ name: 'Test', fauxBold: false, fauxItalic: false });
    expect(normal.fauxBold).toBe(false);
    // Faux bold/italic use the same real base identity, with flags carrying
    // synthesis. A real bold slot gets a different slot identity.
    engine.addFace('Foo', 'regular', dejavu);
    const regular = request('Foo');
    expect(request('Foo', true, true)).toEqual({ name: regular.name, fauxBold: true, fauxItalic: true });
    engine.addFace('Foo', 'bold', comic);
    engine.addFace('Foo-Bold', 'regular', dejavu);
    expect(request('Foo', true).fauxBold).toBe(false);
    expect(request('Foo', true).name).not.toBe(request('Foo-Bold').name);
    engine.addFace('Foo-Bold', 'regular', comic);
    // Even equal bytes cannot collapse raw family/real-slot boundaries.
    expect(request('Foo', true).name).not.toBe(request('Foo-Bold').name);
  });

  it('distinguishes bytes and collection indices but stays stable across reload, font-id reuse and engine replacement', async () => {
    const collection = buildCollection([comic, dejavu]);
    const first = await rustEngine();
    first.addFaces('Source', collection, [{ slot: 'regular', index: 0 }], 'file');
    install(first);
    const original = request('Source').name;
    const originalFont = first.handle(face('Source')).font;
    const source = first.sourceIdentity(originalFont);
    first.addFaces('Other', null, [{ slot: 'regular', index: 0 }], 'file');
    expect(first.sourceIdentity(first.handle(face('Other')).font)).toBe(source);
    first.addFaces('Source', null, [{ slot: 'regular', index: 1 }], 'file');
    expect(request('Source').name).not.toBe(original);
    const removed = first.handle(face('Source')).font;
    const removedSource = first.sourceIdentity(removed);
    expect(removedSource).not.toBe(source);
    first.removeFamily('Source');
    expect(() => first.sourceIdentity(removed)).toThrow(/not held/);
    first.addFace('Noise', 'regular', comic);
    expect(first.handle(face('Noise')).font).toBe(originalFont);
    first.addFaces('Source', null, [{ slot: 'regular', index: 0 }], 'file');
    // The allocator's first empty slot is reused: the same id now means a
    // different collection face, while its old metadata has been replaced.
    expect(first.handle(face('Source')).font).toBe(removed);
    expect(first.sourceIdentity(removed)).toBe(source);
    expect(request('Source').name).toBe(original);
    const second = await rustEngine({ fixtures: false });
    second.addFaces('Source', collection, [{ slot: 'regular', index: 0 }]);
    expect(second.handle(face('Source')).font).not.toBe(removed);
    install(second);
    expect(request('Source').name).toBe(original);
    const reordered = await rustEngine({ fixtures: false });
    reordered.addFace('Noise', 'regular', comic);
    reordered.addFaces('Source', collection, [{ slot: 'regular', index: 0 }]);
    expect(reordered.handle(face('Source')).font).not.toBe(second.handle(face('Source')).font);
    expect(reordered.sourceIdentity(reordered.handle(face('Source')).font)).toBe(source);
    install(reordered);
    expect(request('Source').name).toBe(original);
    install(second);
    second.addFace('Bytes', 'regular', comic);
    const one = request('Bytes').name;
    second.addFace('Bytes', 'regular', dejavu);
    expect(request('Bytes').name).not.toBe(one);
  });

  it('takes source metadata back after partial collection registration fails', async () => {
    const engine = await rustEngine({ fixtures: false });
    const collection = buildCollection([comic, dejavu]);
    const made = [];
    const add = engine.low.addFont;
    engine.low.addFont = (...args) => { const id = add(...args); made.push(id); return id; };
    try {
      expect(() => engine.addFaces('Failed', collection, [{ slot: 'regular', index: 0 }, { slot: 'bold', index: 9 }])).toThrow(/cannot read Failed/);
      expect(made).toHaveLength(1);
      expect(engine.hasFamily('Failed')).toBe(false);
      expect(() => engine.sourceIdentity(made[0])).toThrow(/not held/);
      expect(() => engine.low.fontInfo(made[0])).toThrow();
    } finally {
      engine.low.addFont = add;
    }
    engine.addFace('Recovered', 'regular', dejavu);
    const recovered = engine.handle(face('Recovered')).font;
    expect(recovered).toBe(made[0]);
    const fresh = await rustEngine({ fixtures: false });
    fresh.addFace('Recovered', 'regular', dejavu);
    expect(engine.sourceIdentity(recovered)).toBe(fresh.sourceIdentity(fresh.handle(face('Recovered')).font));
    install(engine);
    const recoveredName = request('Recovered').name;
    install(fresh);
    expect(request('Recovered').name).toBe(recoveredName);
  });

  it('omits source metadata from default primary and borrowed runs, and adds the actual lender only on request', async () => {
    const engine = await rustEngine();
    engine.addFace('Lender', 'regular', dejavu);
    engine.setFallbacks(['Lender']);
    const own = face('Comic Neue');
    const text = 'AΩ\n\u{1d538}B';
    const plain = drawnRuns(engine, own, text);
    expect(plain.map((run) => [run.start, run.end, run.own, run.family])).toEqual([
      [0, 1, true, 'Comic Neue'], [1, 2, false, 'Lender'],
      [2, 3, true, 'Comic Neue'], [3, 5, false, 'Lender'], [5, 6, true, 'Comic Neue'],
    ]);
    for (const run of plain) expect(Object.keys(run).sort()).toEqual(['end', 'family', 'fauxBold', 'fauxItalic', 'own', 'postScriptName', 'slot', 'start']);
    const metadata = drawnRuns(engine, own, text, { source: true });
    expect(metadata.map(({ sourceIdentity, ...run }) => run)).toEqual(plain);
    for (const run of metadata) expect(run.sourceIdentity).toBe(engine.sourceIdentity(engine.handle(face(run.family)).font));
  });

  it('uses actual clamped locations, keeps metadata opt-in, and releases eagerly named instances with their source', async () => {
    const engine = await rustEngine({ fixtures: false });
    const bytes = variableFont(comic, [['wght', 600, 800, 900]]);
    engine.addFace('Clamped', 'regular', bytes);
    const own = face('Clamped');
    const font = engine.handle(own).font;
    expect(JSON.parse(engine.sourceIdentity(font))[2]).toEqual([['wght', 600]]);
    expect(engine.sourceIdentity(engine.handle(face('Clamped', false, 120)).font)).toBe(engine.sourceIdentity(font));
    expect(drawnFace(engine, own)).not.toHaveProperty('sourceIdentity');
    expect(drawnRuns(engine, own, 'HI')[0]).not.toHaveProperty('sourceIdentity');
    expect(drawnFace(engine, own, { source: true }).sourceIdentity).toBe(engine.sourceIdentity(font));
    engine.postScriptNames();
    const heavy = engine.handle(face('Clamped', true)).font;
    expect(JSON.parse(engine.sourceIdentity(heavy))[2]).toEqual([['wght', 700]]);
    engine.removeFamily('Clamped');
    expect(() => engine.sourceIdentity(font)).toThrow(/not held/);
    expect(() => engine.sourceIdentity(heavy)).toThrow(/not held/);
    expect(() => engine.low.fontInfo(font)).toThrow();
    expect(() => engine.low.fontInfo(heavy)).toThrow();
  });

  it('disambiguates direct stated/generated aliases independently of font request order', async () => {
    const probe = await rustEngine({ fixtures: false });
    probe.addFace('Alias', 'regular', comic);
    install(probe);
    const occupied = request('Alias').name;
    const stated = withTables(variableFont(fixtureFont('DejaVuSans.ttf'), [['wght', 100, 400, 900]], [{ style: 256, at: [700], postScriptName: 257 }]), {
      name: nameTable([[1, 'Declared'], [2, 'Regular'], [6, 'Bad/Name'], [256, 'Heavy'], [257, occupied]]),
    });
    const names = [];
    for (const firstBold of [false, true]) {
      const engine = await rustEngine({ fixtures: false });
      engine.addFace('Alias', 'regular', comic);
      engine.addFace('Declared', 'regular', stated);
      install(engine);
      if (firstBold) expect(request('Declared', true).name).toBe(occupied);
      const fallback = request('Alias').name;
      expect(fallback).not.toBe(occupied);
      expect(request('Declared', true).name).toBe(occupied);
      expect(request('Alias').name).toBe(fallback);
      names.push(fallback);
      // A warmed complete-name cache must follow replacement and removal.
      // The old variable base and its generated bold place lose their metadata.
      const oldBase = engine.handle(face('Declared')).font;
      const oldHeavy = engine.handle(face('Declared', true)).font;
      expect(engine.postScriptNames().has(occupied)).toBe(true);
      engine.addFace('Declared', 'regular', comic);
      for (const font of [oldBase, oldHeavy]) {
        expect(() => engine.sourceIdentity(font)).toThrow(/not held/);
        expect(() => engine.low.fontInfo(font)).toThrow();
      }
      expect(engine.postScriptNames().has(occupied)).toBe(false);
      expect(request('Alias').name).toBe(occupied);
      engine.addFace('Declared', 'regular', stated);
      expect(engine.postScriptNames().has(occupied)).toBe(true);
      expect(request('Alias').name).toBe(fallback);
      engine.removeFamily('Declared');
      expect(engine.postScriptNames().has(occupied)).toBe(false);
      expect(request('Alias').name).toBe(occupied);
    }
    expect(names[0]).toBe(names[1]);
  });
});
