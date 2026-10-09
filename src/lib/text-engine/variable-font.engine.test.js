import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../../test/rust-engine.js';
import { weightOnAxis } from './rust.js';
import { createRustGlyphPainter } from './rust-painter.js';
import { drawnFace, drawnRuns } from './drawn-face.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './index.js';
import { clearLayoutMemo } from '../measure.js';
import { textLayerFor } from '../psd.js';
import { addInstance, instancesSupported } from '../../../text-engine/js/instance.mjs';

// ===========================================================================
// A variable font is drawn at the weight that was asked
// ===========================================================================
// The fonts are this machine's, read where they lie: the repository ships no
// variable font, and is not to. Where one is absent its tests say SKIPPED by
// name and do not run - they are proofs for a Mac, measured against what
// Chromium 155 drew of the same files on 2026-10-09 (text-engine/P8-REPORT.md):
//
//   STIX Two Text, `wght` 400..700, default 400, "Hamburgefonstiv 0123" at 100 px
//     weight 400                       962.2 px wide
//     weight 700, the installed font  1047.3 px wide - the real 700 instance
//   SF NS Mono, `wght` 294.67..900, default 294.67 (a Light)
//     weight 400 is the 400 instance, not the file's default
//
// The rule itself (`weightOnAxis`) needs no font and is tested on every machine.

const SYSTEM = {
  stix: '/System/Library/Fonts/Supplemental/STIXTwoText.ttf',
  stixItalic: '/System/Library/Fonts/Supplemental/STIXTwoText-Italic.ttf',
  mono: '/System/Library/Fonts/SFNSMono.ttf',
};
const here = (...fonts) => fonts.every((f) => existsSync(SYSTEM[f]));
const onThisMachine = (...fonts) => (here(...fonts) ? it : (name, fn) => it.skip(`SKIPPED, ${fonts.map((f) => SYSTEM[f]).join(' and ')} not on this machine: ${name}`, fn));
const TEXT = 'Hamburgefonstiv 0123';
// How wide the ink of a line is: `width` in an ink answer is the advance.
const inkWidth = (ink) => ink.left + ink.right;

const face = (name, { bold = false, italic = false, size = 100 } = {}) => ({
  key: `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px "${name}"`, name, bold, italic, size, css: `"${name}"`,
});

describe('which weight of an axis a request is drawn at', () => {
  const axis = (min, def, max) => ({ tag: 'wght', min, default: def, max });

  it('is the weight asked, 400 or 700, inside the axis', () => {
    expect(weightOnAxis(axis(400, 400, 700), false, 'regular')).toEqual({ wght: 400, fauxBold: false });
    expect(weightOnAxis(axis(400, 400, 700), true, 'regular')).toEqual({ wght: 700, fauxBold: false });
    // Not where the file starts: SF Compact starts at 1000, SF NS Mono at 294.67.
    expect(weightOnAxis(axis(1, 1000, 1000), false, 'regular')).toEqual({ wght: 400, fauxBold: false });
    expect(weightOnAxis(axis(294.67, 294.67, 900), false, 'italic')).toEqual({ wght: 400, fauxBold: false });
  });

  it('stops at the end of the axis, and emboldens only a bold that end is too light for', () => {
    expect(weightOnAxis(axis(300, 400, 650), true, 'regular')).toEqual({ wght: 650, fauxBold: false });
    expect(weightOnAxis(axis(300, 400, 500), true, 'regular')).toEqual({ wght: 500, fauxBold: true });
    expect(weightOnAxis(axis(600, 800, 900), false, 'regular')).toEqual({ wght: 600, fauxBold: false });
  });

  it('is 700 for a face in a bold slot whatever is asked, as a face registered bold is', () => {
    expect(weightOnAxis(axis(400, 400, 700), false, 'bold')).toEqual({ wght: 700, fauxBold: false });
    expect(weightOnAxis(axis(400, 400, 700), false, 'boldItalic')).toEqual({ wght: 700, fauxBold: false });
  });

  it('is nothing for a font with no weight axis, or one that is not on the CSS scale', () => {
    expect(weightOnAxis(null, true, 'regular')).toBe(null);
    expect(weightOnAxis(undefined, false, 'regular')).toBe(null);
    // Skia.ttf, an old GX font: 0.48 to 3.2.
    expect(weightOnAxis(axis(0.48, 1, 3.2), true, 'regular')).toBe(null);
  });
});

describe('a variable font of this machine', () => {
  let rust;
  const before = { engine: textEngine(), painter: glyphPainter() };
  const hadDocument = 'document' in globalThis;
  const oldDocument = globalThis.document;
  beforeAll(async () => {
    globalThis.document = { createElement: () => createCanvas(300, 150) };
    rust = await rustEngine();
    if (here('stix')) rust.addFace('STIX Two Text', 'regular', readFileSync(SYSTEM.stix));
    if (here('stix', 'stixItalic')) rust.addFace('STIX Two Text', 'italic', readFileSync(SYSTEM.stixItalic));
    if (here('mono')) rust.addFace('SF NS Mono', 'regular', readFileSync(SYSTEM.mono));
  });
  afterEach(() => {
    setTextEngine(before.engine);
    setGlyphPainter(before.painter);
    clearLayoutMemo();
  });
  afterAll(() => {
    if (hadDocument) globalThis.document = oldDocument;
    else delete globalThis.document;
  });

  it('this build of the engine can make instances', () => {
    expect(instancesSupported(rust.low)).toBe(true);
    expect(instancesSupported({ exports: {} })).toBe(false);
    expect(() => addInstance({ exports: {} }, 1, { wght: 700 })).toThrow(/cannot make font instances/);
    expect(() => addInstance(rust.low, 1, { wg: 700 })).toThrow(/not an axis tag/);
  });

  onThisMachine('stix')('bold is the real 700 instance: as wide as the browser draws it, and not emboldened', () => {
    const regular = rust.advance(face('STIX Two Text'), TEXT);
    const bold = rust.advance(face('STIX Two Text', { bold: true }), TEXT);
    expect(regular).toBeCloseTo(962.2, 1);
    expect(bold).toBeCloseTo(1047.3, 1);
    // What it was before: the 400 instance, each glyph `size / 36` wider.
    expect(bold).not.toBeCloseTo(regular + TEXT.length * (100 / 36), 0);
    expect(rust.resolveFace(face('STIX Two Text', { bold: true }))).toEqual({ slot: 'regular', fauxBold: false, fauxItalic: false });
    // Not the regular's outlines moved apart: the `l` itself is thicker, 234
    // font units of ink across to 303.
    expect(inkWidth(rust.lineInk(face('STIX Two Text', { size: 1000 }), 'l'))).toBe(234);
    expect(inkWidth(rust.lineInk(face('STIX Two Text', { bold: true, size: 1000 }), 'l'))).toBe(303);
  });

  onThisMachine('stix')('the name of what was drawn is the instance, by the rule Adobe names instances with', () => {
    expect(drawnFace(rust, face('STIX Two Text'))).toEqual({ family: 'STIX Two Text', slot: 'regular', fauxBold: false, fauxItalic: false, postScriptName: 'STIXTwoText' });
    expect(drawnFace(rust, face('STIX Two Text', { bold: true }))).toEqual({
      family: 'STIX Two Text', slot: 'regular', fauxBold: false, fauxItalic: false, postScriptName: 'STIXTwoTextRoman-Bold',
    });
  });

  onThisMachine('stix', 'stixItalic')('bold italic is the italic file at 700, with nothing synthesised', () => {
    const f = face('STIX Two Text', { bold: true, italic: true });
    expect(rust.resolveFace(f)).toEqual({ slot: 'italic', fauxBold: false, fauxItalic: false });
    const italic = rust.advance(face('STIX Two Text', { italic: true }), TEXT);
    expect(rust.advance(f, TEXT)).toBeGreaterThan(italic + 40);
    expect(drawnFace(rust, f).postScriptName).toMatch(/Italic.*Bold/);
    expect(drawnFace(rust, face('STIX Two Text', { italic: true })).postScriptName).toBe('STIXTwoText-Italic');
  });

  onThisMachine('mono')('regular is weight 400, not the weight the file starts at', () => {
    const f = face('SF NS Mono');
    const info = rust.low.fontInfo(rust.handle(f).font);
    const started = rust.low.fontInfo(rust.low.addFont(readFileSync(SYSTEM.mono)));
    expect(started.axes.find((a) => a.tag === 'wght').default).toBeLessThan(300);
    expect(info.postScriptName).not.toBe(started.postScriptName);
    // A heavier `l` than the file's own start, and a heavier one again for bold.
    const light = inkWidth(rust.low.lineInk({ font: rust.low.addFont(readFileSync(SYSTEM.mono)), size: 1000, flags: 0 }, 'l'));
    const regular = inkWidth(rust.lineInk(face('SF NS Mono', { size: 1000 }), 'l'));
    const bold = inkWidth(rust.lineInk(face('SF NS Mono', { bold: true, size: 1000 }), 'l'));
    expect(regular).toBeGreaterThan(light + 5);
    expect(bold).toBeGreaterThan(regular + 20);
    expect(rust.resolveFace(face('SF NS Mono', { bold: true })).fauxBold).toBe(false);
  });

  onThisMachine('stix')('the painter draws the instance that was measured', () => {
    const painter = createRustGlyphPainter(rust);
    const inked = (bold) => {
      const canvas = createCanvas(1200, 200);
      const ctx = canvas.getContext('2d');
      painter.paint(ctx, {
        face: face('STIX Two Text', { bold }), curved: false, align: 'left', letterSpacing: 0, bands: [], silhouette: null,
        fill: { kind: 'solid', color: '#000000' }, runs: [{ text: TEXT, x: 10, y: 120 }],
      });
      const data = ctx.getImageData(0, 0, 1200, 200).data;
      let sum = 0, right = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (!data[i]) continue;
        sum += data[i] / 255;
        right = Math.max(right, ((i - 3) / 4) % 1200);
      }
      return { ink: Math.round(sum), right };
    };
    const regular = inked(false);
    const bold = inked(true);
    // Chromium's own figures for the same line: 19,826 px of ink at 400 and
    // 30,040 at the real 700 - 10,214 more - against 5,702 more for a 400 it
    // emboldened itself. The engine lays 18,022 and 28,225: the same 10,200
    // more. (Both of Chromium's are some 1,800 over the engine's, which is
    // macOS thickening every glyph it rasterises, at any weight.)
    expect(Math.abs(regular.ink - 18022)).toBeLessThan(200);
    expect(Math.abs(bold.ink - regular.ink - 10214)).toBeLessThan(200);
    // And it ends where the wider advances put it.
    expect(bold.right - regular.right).toBeGreaterThan(75);
  });

  onThisMachine('stix')('a PSD type layer names the instance and asks Photoshop to embolden nothing', () => {
    setTextEngine(rust);
    setGlyphPainter(createRustGlyphPainter(rust));
    clearLayoutMemo();
    const style = { font: 'STIX Two Text', size: 30, bold: true, italic: false, lineHeight: 1.1, align: 'center', valign: 'top', color: '#000000', strokes: [] };
    const layer = textLayerFor({ lines: [] }, { id: 'b', lineN: null, text: 'WAIT', x: 10, y: 10, w: 300, h: 100, style }, null);
    expect(layer.text.style).toMatchObject({ font: { name: 'STIXTwoTextRoman-Bold' }, fauxBold: false, fauxItalic: false });
    const plain = textLayerFor({ lines: [] }, { id: 'b', lineN: null, text: 'WAIT', x: 10, y: 10, w: 300, h: 100, style: { ...style, bold: false } }, null);
    expect(plain.text.style).toMatchObject({ font: { name: 'STIXTwoText' }, fauxBold: false });
  });

  onThisMachine('stix')('a variable font that lends a letter lends it at the weight asked', () => {
    // Comic Neue has no Greek; STIX does.
    rust.setFallbacks(['STIX Two Text']);
    try {
      const runs = drawnRuns(rust, face('Comic Neue', { bold: true }), 'AΩ');
      expect(runs.map((r) => [r.own, r.postScriptName, r.fauxBold])).toEqual([
        [true, 'ComicNeue-Regular', true],
        [false, 'STIXTwoTextRoman-Bold', false],
      ]);
    } finally {
      rust.setFallbacks([]);
    }
  });

  onThisMachine('stix')('the instances go when the face they were made of goes', () => {
    const bytes = readFileSync(SYSTEM.stix);
    rust.addFace('Passing', 'regular', bytes);
    const instance = rust.handle(face('Passing', { bold: true })).font;
    const base = rust.handle(face('Passing')).font;
    expect(instance).not.toBe(base);
    expect(rust.low.fontInfo(instance).postScriptName).toBe('STIXTwoTextRoman-Bold');
    rust.removeFamily('Passing');
    expect(() => rust.low.fontInfo(instance)).toThrow();
    expect(() => rust.low.fontInfo(base)).toThrow();
    // Replacing a face drops the weights made of the old one too.
    rust.addFace('Passing', 'regular', bytes);
    const first = rust.handle(face('Passing', { bold: true })).font;
    rust.addFace('Passing', 'regular', readFileSync(SYSTEM.stix));
    const second = rust.handle(face('Passing', { bold: true })).font;
    expect(rust.low.fontInfo(second).postScriptName).toBe('STIXTwoTextRoman-Bold');
    expect(rust.advance(face('Passing', { bold: true }), TEXT)).toBeCloseTo(1047.3, 1);
    rust.removeFamily('Passing');
    expect(() => rust.low.fontInfo(first)).toThrow();
    expect(() => rust.low.fontInfo(second)).toThrow();
  });
});
