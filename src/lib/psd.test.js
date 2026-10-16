import { describe, it, expect, afterEach } from 'vitest';
import { readPsd, initializeCanvas } from 'ag-psd';
import {
  buildPagePsd,
  isRasterOnly,
  numberBoxIds,
  pagePsdDocument,
  serializePage,
  textLayerFor,
  writePagePsd,
  fontRequestFor,
  reconstructForeign,
  psdSelfTest,
} from './psd.js';
import { PAGE_W, PAGE_H, emptyFaces, defaultStyle, normalizeStyle } from './data.js';
import { BOX_PAD, textInset } from './measure.js';
import { app } from './store.svelte.js';
import { _setPostScriptNameFor, _clearPostScriptNames } from './fonts.js';

afterEach(() => {
  app.fonts.user = [];
  _clearPostScriptNames();
});

// KNOWN GAP: these call numberBoxIds directly, so they prove the numbering and
// nothing about the call site. Deleting the numberBoxIds(pages) line from
// chapterPagesFromPsdFiles restores the duplicate-id bug with this file still
// green. The import path around it cannot run here - it reads PSD bytes through
// blob URLs and needs ag-psd's canvas backend, neither of which exists in the
// node test environment - so the wiring is checked by reading it, not by a test.

// The shape toChapterPage hands the library: bytes and geometry elided, since
// only the boxes matter here.
const psdPage = (n, boxCount) => ({
  rawName: `page-00${n}.png`,
  w: 800,
  h: 1200,
  lines: [],
  boxes: Array.from({ length: boxCount }, (_, i) => ({ lineN: null, text: `p${n}-${i}` })),
});

describe('numberBoxIds', () => {
  it('numbers boxes across the whole document rather than restarting each page', () => {
    const pages = [psdPage(1, 2), psdPage(2, 3)];
    numberBoxIds(pages);
    expect(pages.map((p) => p.boxes.map((b) => b.id))).toEqual([
      ['b1', 'b2'],
      ['b3', 'b4', 'b5'],
    ]);
  });

  it('leaves no id owned by two boxes', () => {
    const pages = [psdPage(1, 4), psdPage(2, 4), psdPage(3, 4)];
    numberBoxIds(pages);
    const ids = pages.flatMap((p) => p.boxes.map((b) => b.id));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('does not spend an id on a page that carries no boxes', () => {
    const pages = [psdPage(1, 1), psdPage(2, 0), psdPage(3, 1)];
    numberBoxIds(pages);
    expect(pages[2].boxes[0].id).toBe('b2');
  });
});

// The embedded project JSON is what makes the PSD lossless, so what it drops is
// gone for good on a re-import. Both of these are things it used to drop.
describe('serializePage', () => {
  it('carries a free-typed line and the box that points at it', () => {
    // A negative number is the only marker a free-typed line has (see
    // `isFreeLine` in store.svelte.js), and it is `n` - a field nothing can
    // forget, because nothing works without it. The line also carries the box's
    // text, so losing the line loses the words on the page.
    const out = serializePage({
      id: 3,
      w: 800,
      h: 1200,
      lines: [{ n: -1, type: 'dialogue', jp: '', en: 'BOOM' }],
      boxes: [{ lineN: -1, text: null, x: 1, y: 2, w: 3, h: 4, style: {} }],
    });
    expect(out.lines[0]).toEqual({ n: -1, type: 'dialogue', jp: '', en: 'BOOM' });
    expect(out.boxes[0].lineN).toBe(-1);
    expect(out.boxes[0].text).toBe(null);
  });

  it('writes the tags a line carries, so a round trip does not flatten them to a type', () => {
    // `type` holds one of three names, so `shout` came back as `dialogue` and
    // the user's own vocabulary was lost. The JSON exporter already writes
    // `tags` for this reason; this file did not.
    const out = serializePage({
      id: 3,
      w: 8,
      h: 8,
      lines: [{ n: 1, type: 'dialogue', jp: '', en: 'x', tags: ['shout', 'sfx'] }],
      boxes: [],
    });
    expect(out.lines[0].tags).toEqual(['shout', 'sfx']);
  });

  it('leaves `tags` off a line that has none, rather than writing an empty array', () => {
    // The array's presence is what tells `lineTags` the user has taken over
    // from the legacy `type`; an invented `[]` reads as every tag deliberately
    // cleared, and a re-import would then wipe them.
    const out = serializePage({ id: 3, w: 8, h: 8, lines: [{ n: 1, type: 'sfx', jp: '', en: '' }], boxes: [] });
    expect('tags' in out.lines[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRasterOnly / textLayerFor - curved and roughened boxes can't be
// reproduced by Photoshop's own text engine (see the comment on isRasterOnly
// in psd.js), so their layer has to carry pixels and no `text` object at all.
// Neither function touches a canvas - textLayerFor is handed its rendered
// pixels rather than computing them - so both are reachable straight from
// node, same as serializePage above.
// ---------------------------------------------------------------------------

describe('isRasterOnly', () => {
  it('is true for a curved box', () => {
    expect(isRasterOnly({ curve: 40, roughen: { on: false } })).toBe(true);
  });

  it('is true for a negative curve (frown), not just a positive one', () => {
    expect(isRasterOnly({ curve: -25, roughen: { on: false } })).toBe(true);
  });

  it('is true for a roughened box', () => {
    expect(isRasterOnly({ curve: 0, roughen: { on: true } })).toBe(true);
  });

  // A type layer's transform is a rotation matrix, determinant +1, so it cannot
  // express the mirror the pixels already carry.
  it('is true for a mirrored box, in either axis', () => {
    expect(isRasterOnly({ curve: 0, roughen: { on: false }, flipH: true })).toBe(true);
    expect(isRasterOnly({ curve: 0, roughen: { on: false }, flipV: true })).toBe(true);
  });

  // Every glyph-by-glyph layout goes down the same route as the arc, for the
  // same reason: Photoshop re-renders a type layer as a straight paragraph in
  // the box rect, over pixels that were laid out along a path or a ring.
  it('is true for text on a bezier path, once the path has anchors to follow', () => {
    const pts = [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 40, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
    ];
    expect(isRasterOnly({ path: { on: true, pts } })).toBe(true);
    // A path switched on but not yet drawn lays out as ordinary lines (see
    // layoutBox's `isPath`), so it is still a live type layer.
    expect(isRasterOnly({ path: { on: true, pts: [] } })).toBe(false);
    expect(isRasterOnly({ path: { on: true, pts: [pts[0]] } })).toBe(false);
    expect(isRasterOnly({ path: { on: false, pts } })).toBe(false);
  });

  // The mesh warp, for the same reason the mirror is here: a type layer's
  // transform has no room to state a quad, so Photoshop would lay the glyphs out
  // in the box rect over pixels that were carried somewhere else.
  it('is true for a box with a mesh warp on it', () => {
    const pts = [[0, 0], [100, 0], [0, 100], [120, 140]];
    expect(isRasterOnly({ warp: { on: true, cols: 1, rows: 1, pts } })).toBe(true);
    // Switched off, or never dragged: an ordinary live type layer.
    expect(isRasterOnly({ warp: { on: false, cols: 1, rows: 1, pts } })).toBe(false);
    expect(isRasterOnly({ warp: { on: true, cols: 1, rows: 1, pts: [] } })).toBe(false);
    // And a mesh the sanitiser would have thrown away is not a mesh: nine points
    // are wanted for a 2x2 grid.
    expect(isRasterOnly({ warp: { on: true, cols: 2, rows: 2, pts } })).toBe(false);
  });

  it('is true for text closed into a circle', () => {
    expect(isRasterOnly({ circle: { on: true, angle: 0, inside: false } })).toBe(true);
    expect(isRasterOnly({ circle: { on: false } })).toBe(false);
  });

  // The mask hides ink. A re-render has no mask, so Photoshop would show the
  // letters the user erased - but only a mask with shapes hides anything, and
  // an empty one must not cost the box its editability.
  it('is true for an active visibility mask and false for an empty one', () => {
    expect(isRasterOnly({ clip: { on: true, mode: 'exclude', shapes: [{ kind: 'ellipse', cx: 1, cy: 1, rx: 2, ry: 2 }] } })).toBe(true);
    expect(isRasterOnly({ clip: { on: true, mode: 'exclude', shapes: [] } })).toBe(false);
    expect(isRasterOnly({ clip: { on: false, shapes: [{ kind: 'ellipse', cx: 1, cy: 1, rx: 2, ry: 2 }] } })).toBe(false);
  });

  // Both blur the finished composite - fill, strokes and shadows together -
  // which no per-effect Photoshop track can restate.
  it('is true for a whole-text blur', () => {
    expect(isRasterOnly({ blur: 3 })).toBe(true);
    expect(isRasterOnly({ blur: 0 })).toBe(false);
  });

  it('is true for a motion blur that has a direction, false for one that has none', () => {
    expect(isRasterOnly({ motionBlur: { on: true, x: 2, y: 0, amount: 16 } })).toBe(true);
    expect(isRasterOnly({ motionBlur: { on: true, x: 0, y: -3, amount: 16 } })).toBe(true);
    // (0,0) draws nothing at all - see motionBlurExtent - so it changes nothing.
    expect(isRasterOnly({ motionBlur: { on: true, x: 0, y: 0, amount: 16 } })).toBe(false);
    expect(isRasterOnly({ motionBlur: { on: false, x: 2, y: 2, amount: 16 } })).toBe(false);
  });

  it('is true for a pattern fill', () => {
    expect(isRasterOnly({ pattern: { on: true, kind: 'dots', fg: '#000', bg: '#fff', scale: 1 } })).toBe(true);
    expect(isRasterOnly({ pattern: { on: false, kind: 'dots' } })).toBe(false);
  });

  // Only the shape `gradientOverlay` can actually state stays live type.
  it('is true for a gradient Photoshop cannot restate, false for the linear block one', () => {
    const g = { on: true, kind: 'linear', scope: 'box', angle: 180, stops: [] };
    expect(isRasterOnly({ gradient: g })).toBe(false);
    expect(isRasterOnly({ gradient: { ...g, scope: 'line' } })).toBe(true);
    expect(isRasterOnly({ gradient: { ...g, kind: 'radial' } })).toBe(true);
    expect(isRasterOnly({ gradient: { ...g, on: false, scope: 'line' } })).toBe(false);
    // An older style with no `kind` at all is the linear one.
    expect(isRasterOnly({ gradient: { on: true, scope: 'box' } })).toBe(false);
  });

  it('is false for a plain box with neither', () => {
    expect(isRasterOnly({ curve: 0, roughen: { on: false } })).toBe(false);
  });

  it('is false when curve/roughen are simply absent from the style', () => {
    expect(isRasterOnly({})).toBe(false);
  });

  // The whole point of the predicate is that it is narrow: an ordinary lettered
  // box - the one this app makes hundreds of per chapter - has to stay an
  // editable Photoshop type layer, and every switch above is off by default.
  it('is false for the app default style', () => {
    expect(isRasterOnly(defaultStyle())).toBe(false);
  });
});

describe('isRasterOnly with ink', () => {
  it('is false for a box with the ink block off', () => {
    expect(isRasterOnly(normalizeStyle({ ink: { on: false, strokes: [] } }))).toBe(false);
  });

  it('is false for a box switched on but with nothing drawn', () => {
    expect(isRasterOnly(normalizeStyle({ ink: { on: true, strokes: [] } }))).toBe(false);
  });

  it('is true for a box with a drawn stroke', () => {
    const s = normalizeStyle({
      ink: { on: true, strokes: [{ size: 20, pts: [[0, 0, 1], [10, 0, 1]] }] },
    });
    expect(isRasterOnly(s)).toBe(true);
  });
});

describe('fontRequestFor', () => {
  const userFont = (name, faces) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), ...faces } });

  it('prefers the parsed PostScript name for a known real face', () => {
    app.fonts.user = [
      userFont('Wildwords', {
        regular: { file: 'Wildwords.ttf' },
        bold: { file: 'Wildwords-Bold.ttf' },
      }),
    ];
    _setPostScriptNameFor('Wildwords', 'regular', 'CCWildWords-Regular');
    _setPostScriptNameFor('Wildwords', 'bold', 'CCWildWords-Bold');

    expect(fontRequestFor({ font: 'Wildwords' })).toEqual({
      name: 'CCWildWords-Regular',
      fauxBold: false,
      fauxItalic: false,
    });
    expect(fontRequestFor({ font: 'Wildwords', bold: true })).toEqual({
      name: 'CCWildWords-Bold',
      fauxBold: false,
      fauxItalic: false,
    });
  });

  it('uses the regular face parsed PostScript name with faux flags when synthesizing an unknown face', () => {
    app.fonts.user = [
      userFont('Wildwords', {
        regular: { file: 'Wildwords.ttf' },
      }),
    ];
    _setPostScriptNameFor('Wildwords', 'regular', 'CCWildWords-Regular');

    // Style requests bold, but only regular face exists -> fauxBold: true on the regular parsed name
    expect(fontRequestFor({ font: 'Wildwords', bold: true })).toEqual({
      name: 'CCWildWords-Regular',
      fauxBold: true,
      fauxItalic: false,
    });
    // Style requests bold + italic -> fauxBold: true, fauxItalic: true
    expect(fontRequestFor({ font: 'Wildwords', bold: true, italic: true })).toEqual({
      name: 'CCWildWords-Regular',
      fauxBold: true,
      fauxItalic: true,
    });
  });

  it('uses the regular face parsed PostScript name when family face is unknown (known: false)', () => {
    app.fonts.user = [userFont('EmptyFamily', {})];
    _setPostScriptNameFor('EmptyFamily', 'regular', 'RealPSName-Roman');
    expect(fontRequestFor({ font: 'EmptyFamily', bold: true })).toEqual({
      name: 'RealPSName-Roman',
      fauxBold: true,
      fauxItalic: false,
    });
  });

  it('falls back to constructed name and suffix when no parsed PostScript name exists', () => {
    // Comic Neue is a built-in with no parsed name in map
    expect(fontRequestFor({ font: 'Comic Neue' })).toEqual({
      name: 'ComicNeue',
      fauxBold: false,
      fauxItalic: false,
    });
    expect(fontRequestFor({ font: 'Comic Neue', bold: true })).toEqual({
      name: 'ComicNeue-Bold',
      fauxBold: false,
      fauxItalic: false,
    });
    expect(fontRequestFor({ font: 'Comic Neue', bold: true, italic: true })).toEqual({
      name: 'ComicNeue-BoldItalic',
      fauxBold: false,
      fauxItalic: false,
    });

    // Bangers is regular-only built-in
    expect(fontRequestFor({ font: 'Bangers', bold: true })).toEqual({
      name: 'Bangers',
      fauxBold: true,
      fauxItalic: false,
    });
  });
});

describe('textLayerFor', () => {
  const page = { lines: [] };
  const rendered = {
    imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) },
    left: 3,
    top: 4,
    right: 13,
    bottom: 10,
    opacity: 1,
  };
  const baseStyle = { curve: 0, roughen: { on: false }, opacity: 0.8, align: 'center', size: 24, font: 'Comic Neue' };
  const box = (style) => ({ lineN: null, text: 'hi', x: 0, y: 0, w: 40, h: 20, style });

  it('writes an editable `text` object for an ordinary box', () => {
    const layer = textLayerFor(page, box(baseStyle), rendered);
    expect(layer.text).toBeTruthy();
    expect(layer.text.text).toBe('hi');
    expect(layer.name).toBe('hi');
  });

  it('drops `text` for a curved box and keeps the rendered pixels/bounds/opacity/blendMode', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, curve: 35 }), rendered);
    expect('text' in layer).toBe(false);
    expect(layer.imageData).toBe(rendered.imageData);
    expect([layer.left, layer.top, layer.right, layer.bottom]).toEqual([3, 4, 13, 10]);
    expect(layer.opacity).toBe(0.8);
    expect(layer.blendMode).toBe('normal');
  });

  it('drops `text` for a roughened box the same way', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, roughen: { on: true } }), rendered);
    expect('text' in layer).toBe(false);
    expect(layer.imageData).toBe(rendered.imageData);
  });

  it('marks the raster-only layer name so it reads as deliberate, not broken', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, curve: 10 }), rendered);
    expect(layer.name).toBe('hi [raster, not editable in Photoshop]');
  });

  it('returns null for an empty raster-only box when rendered is null or has no pixels', () => {
    // Empty boxes with raster styling return null rather than an image layer with imageData: undefined
    expect(textLayerFor(page, box({ ...baseStyle, curve: 35 }), null)).toBe(null);
    expect(textLayerFor(page, box({ ...baseStyle, roughen: { on: true } }), null)).toBe(null);
    expect(textLayerFor(page, box({ ...baseStyle, flipH: true }), null)).toBe(null);
    expect(textLayerFor(page, box({ ...baseStyle, flipV: true }), null)).toBe(null);
  });

  // Which boxes become layers, stated as one rule. `buildPagePsd` filters the
  // nulls out of its layer list, so a page holding one shifts every layer after
  // it up by one - and `psdSelfTest` walked `page.boxes` by index against
  // `textGroup.children`, so from that box on it was comparing each layer with
  // the WRONG box's render and checking the wrong box's line breaks. The self
  // test now rebuilds the same filtered list, and this is the rule it rebuilds:
  // a box is dropped exactly when it is raster-only and painted no pixels.
  it('drops a box from the layer list exactly when it is raster-only and paints nothing', () => {
    const noPixels = { ...rendered, imageData: null };
    const cases = [
      [baseStyle, null],
      [baseStyle, rendered],
      [{ ...baseStyle, curve: 35 }, rendered],
      [{ ...baseStyle, curve: 35 }, null],
      [{ ...baseStyle, curve: 35 }, noPixels],
      [{ ...baseStyle, roughen: { on: true } }, noPixels],
      [{ ...baseStyle, flipV: true }, rendered],
    ];
    for (const [style, r] of cases) {
      const dropped = textLayerFor(page, box(style), r) === null;
      expect(dropped, JSON.stringify(style)).toBe(isRasterOnly(style) && !r?.imageData);
    }
  });

  // Faux bold/italic is what a scanlator is trying to avoid, so the flag is
  // written from whether the family really has that face (fonts.js/hasFace) and
  // not from the style bit alone. Comic Neue is a built-in whose Google Fonts
  // request asks for all four faces; Bangers is regular-only, so the same style
  // bit has to come out the other way on it.
  it('asks for the real face and leaves the faux flag off when the family has one', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, font: 'Comic Neue', bold: true }), rendered);
    expect(layer.text.style.font.name).toBe('ComicNeue-Bold');
    expect(layer.text.style.fauxBold).toBe(false);
  });

  it('names the bold-italic face when the family has that one too', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, font: 'Comic Neue', bold: true, italic: true }), rendered);
    expect(layer.text.style.font.name).toBe('ComicNeue-BoldItalic');
    expect(layer.text.style.fauxBold).toBe(false);
    expect(layer.text.style.fauxItalic).toBe(false);
  });

  it('falls back to the family name and the faux flag when there is no real face', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, font: 'Bangers', bold: true }), rendered);
    expect(layer.text.style.font.name).toBe('Bangers');
    expect(layer.text.style.fauxBold).toBe(true);
  });

  // Per axis, because that is how the browser matched it: Comic Neue owns all
  // four faces, Bangers owns only its regular, so the same style bit is real on
  // one and synthesised on the other.
  it('fauxes only the axis the family cannot supply', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, font: 'Bangers', bold: true, italic: true }), rendered);
    expect(layer.text.style.font.name).toBe('Bangers');
    expect(layer.text.style.fauxBold).toBe(true);
    expect(layer.text.style.fauxItalic).toBe(true);
  });

  // The canvas draws the fallback family for a font this machine has not got,
  // so the layer has to describe THAT family - asking one half of the question
  // about the name in the document and the other about the family on screen is
  // how a layer ends up claiming a font nobody rendered.
  it('describes the fallback family when the document names a font nobody has', () => {
    const layer = textLayerFor(page, box({ ...baseStyle, font: 'Gone Missing', bold: true }), rendered);
    expect(layer.text.style.font.name).toBe('ComicNeue-Bold');
    expect(layer.text.style.fauxBold).toBe(false);
  });

  it('leaves both flags off for an unstyled box', () => {
    const layer = textLayerFor(page, box(baseStyle), rendered);
    expect(layer.text.style.font.name).toBe('ComicNeue');
    expect(layer.text.style.fauxBold).toBe(false);
    expect(layer.text.style.fauxItalic).toBe(false);
  });

  it('uses the parsed PostScript name on the generated Photoshop text layer when available', () => {
    app.fonts.user = [
      { name: 'Anime Ace', css: `'Anime Ace'`, real: true, faces: { ...emptyFaces(), bold: { file: 'AnimeAce-Bold.ttf' } } },
    ];
    _setPostScriptNameFor('Anime Ace', 'bold', 'AnimeAce2BB-Bold');
    const layer = textLayerFor(page, box({ ...baseStyle, font: 'Anime Ace', bold: true }), rendered);
    expect(layer.text.style.font.name).toBe('AnimeAce2BB-Bold');
    expect(layer.text.style.fauxBold).toBe(false);
  });

  // Layer effects: Photoshop re-renders editable text layers from internal
  // engine data and discards cached pixels, so an outline must carry a stroke
  // effect and drop shadow must carry a dropShadow effect.
  it('attaches a stroke effect with the correct size, position, and color', () => {
    const layer = textLayerFor(
      page,
      box({ ...baseStyle, strokes: [{ color: '#ff3300', width: 3, opacity: 1 }] }),
      rendered,
    );
    expect(layer.effects).toBeDefined();
    expect(layer.effects.stroke).toHaveLength(1);
    const stroke = layer.effects.stroke[0];
    expect(stroke.enabled).toBe(true);
    expect(stroke.position).toBe('outside');
    expect(stroke.size).toEqual({ units: 'Pixels', value: 3 });
    expect(stroke.fillType).toBe('color');
    expect(stroke.color).toEqual({ r: 255, g: 51, b: 0 });
  });

  // A stroke's own `width` is the band the user sees, and Photoshop's 'outside'
  // size is the distance from the glyph - so the second stroke out is sized at
  // both widths together, and the list goes in outermost first because that is
  // the order Photoshop paints it in.
  it('sizes a second stroke at its outer edge and puts it first', () => {
    const layer = textLayerFor(
      page,
      box({
        ...baseStyle,
        strokes: [
          { color: '#ffffff', width: 3, opacity: 1 },
          { color: '#000000', width: 2, opacity: 0.5 },
        ],
      }),
      rendered,
    );
    expect(layer.effects.stroke.map((k) => [k.size.value, k.color, k.opacity])).toEqual([
      [5, { r: 0, g: 0, b: 0 }, 0.5],
      [3, { r: 255, g: 255, b: 255 }, 1],
    ]);
  });

  it('leaves stroke off when the box has no strokes', () => {
    const layerZero = textLayerFor(page, box({ ...baseStyle, strokes: [] }), rendered);
    expect(layerZero.effects?.stroke).toBeUndefined();
    const layerNone = textLayerFor(page, box(baseStyle), rendered);
    expect(layerNone.effects?.stroke).toBeUndefined();
  });

  it('leaves dropShadow off when the box has no shadows', () => {
    const layerOff = textLayerFor(page, box({ ...baseStyle, shadows: [] }), rendered);
    expect(layerOff.effects?.dropShadow).toBeUndefined();

    const layerNone = textLayerFor(page, box(baseStyle), rendered);
    expect(layerNone.effects).toBeUndefined();
  });

  // A gradient fill is the one fill Photoshop can state for itself. A pattern
  // and the whole-text blur cannot be, and stay in the cached pixels.
  it('writes a whole-block gradient as a gradientOverlay and nothing for a pattern', () => {
    const g = {
      on: true,
      angle: 180,
      scope: 'box',
      stops: [
        { color: '#ffffff', pos: 0 },
        { color: '#000000', pos: 1 },
      ],
    };
    const layer = textLayerFor(page, box({ ...baseStyle, gradient: g }), rendered);
    expect(layer.effects.gradientOverlay).toHaveLength(1);
    const go = layer.effects.gradientOverlay[0];
    expect(go.angle).toBe(-90); // CSS 180deg (top→bottom) is Photoshop's -90
    // `fillOpacity` is gone from the schema; the overlay is always full-on.
    expect(go.opacity).toBe(1);
    expect(go.gradient.colorStops.map((c) => c.location)).toEqual([0, 1]);

    // A radial ramp is not the same construction as Photoshop's radial overlay,
    // so it must not come out as one - and it must not fall back to the linear
    // branch either, which is what a `scope`-only check used to let it do.
    const radial = textLayerFor(page, box({ ...baseStyle, gradient: { ...g, kind: 'radial' } }), rendered);
    expect(radial.effects?.gradientOverlay).toBeUndefined();
    expect('text' in radial).toBe(false);

    // Per-line scope has no Photoshop equivalent, and neither has a pattern.
    // Both are now raster-only rather than live type layers quietly missing
    // their fill: a re-render discards the cached pixels, so a type layer here
    // showed flat `fillColor` text where the app shows a ramp or a tile.
    const perLine = textLayerFor(page, box({ ...baseStyle, gradient: { ...g, scope: 'line' } }), rendered);
    expect(perLine.effects?.gradientOverlay).toBeUndefined();
    expect('text' in perLine).toBe(false);
    const pat = textLayerFor(
      page,
      box({ ...baseStyle, pattern: { on: true, kind: 'dots', fg: '#000', bg: '#fff', scale: 1 } }),
      rendered,
    );
    expect(pat.effects).toBeUndefined();
    expect('text' in pat).toBe(false);
  });

  it('attaches a dropShadow effect and round-trips angle and distance back to canvas x and y offsets', () => {
    // Test multiple offset combinations across all quadrants.
    // Canvas y grows downward; Photoshop light angle is counter-clockwise from +x
    // with shadow cast away from the light.
    const testCases = [
      { x: 4, y: 5, blur: 6, color: '#112233', opacity: 0.75 },
      { x: -6, y: 8, blur: 2, color: '#000000', opacity: 0.5 },
      { x: -5, y: -7, blur: 3, color: '#ffffff', opacity: 1 },
      { x: 9, y: -3, blur: 0, color: '#aa00cc', opacity: 0.9 },
      { x: 0, y: 10, blur: 4, color: '#000000', opacity: 0.6 },
      { x: -8, y: 0, blur: 5, color: '#000000', opacity: 0.4 },
    ];

    for (const s of testCases) {
      const layer = textLayerFor(page, box({ ...baseStyle, shadows: [{ ...s }] }), rendered);
      expect(layer.effects?.dropShadow).toHaveLength(1);
      const ds = layer.effects.dropShadow[0];
      expect(ds.enabled).toBe(true);
      expect(ds.useGlobalLight).toBe(false);
      expect(ds.size).toEqual({ units: 'Pixels', value: s.blur });
      expect(ds.opacity).toBe(s.opacity);

      // Inverse conversion: light angle θ in degrees, distance in pixels.
      // Light is at θ, shadow is cast opposite: ( -dist * cos(θ), dist * sin(θ) ).
      const rad = (ds.angle * Math.PI) / 180;
      const recoveredX = -ds.distance.value * Math.cos(rad);
      const recoveredY = ds.distance.value * Math.sin(rad);
      expect(recoveredX).toBeCloseTo(s.x, 5);
      expect(recoveredY).toBeCloseTo(s.y, 5);
    }
  });

  it('leaves raster-only layers (curve, roughen, flip) completely free of effects', () => {
    const styledWithEffects = {
      ...baseStyle,
      strokes: [{ color: '#ffffff', width: 4, opacity: 1 }],
      shadows: [{ x: 3, y: 4, blur: 5, color: '#000000', opacity: 0.8 }],
    };

    // Curved
    const curvedLayer = textLayerFor(page, box({ ...styledWithEffects, curve: 30 }), rendered);
    expect('text' in curvedLayer).toBe(false);
    expect('effects' in curvedLayer).toBe(false);

    // Roughened
    const roughenedLayer = textLayerFor(page, box({ ...styledWithEffects, roughen: { on: true } }), rendered);
    expect('text' in roughenedLayer).toBe(false);
    expect('effects' in roughenedLayer).toBe(false);

    // Mirrored H
    const flipHLayer = textLayerFor(page, box({ ...styledWithEffects, flipH: true }), rendered);
    expect('text' in flipHLayer).toBe(false);
    expect('effects' in flipHLayer).toBe(false);

    // Mirrored V
    const flipVLayer = textLayerFor(page, box({ ...styledWithEffects, flipV: true }), rendered);
    expect('text' in flipVLayer).toBe(false);
    expect('effects' in flipVLayer).toBe(false);
  });

  // Geometry: an editable Photoshop type layer must match the editor's text
  // container and the raster exporter. The editor's text box div has padding: 2px
  // (BOX_PAD) on every side, and layoutLines wraps text within `box.w - BOX_PAD * 2`.
  // Photoshop's text engine flows paragraph text inside `boxBounds` starting at
  // the transformed content origin. If the transform origin were placed flush with
  // the outer box frame, Photoshop's live re-render would position left- and top-
  // aligned text 2px too high and 2px too far left compared to the cached pixels
  // underneath. Similarly, boxBounds must represent the inner content area rather
  // than the outer frame so that line reflow width matches the app.
  it('offsets the type layer transform by BOX_PAD and sizes boxBounds to the content box for unrotated text', () => {
    const unrotatedBox = {
      lineN: null,
      text: 'hello',
      x: 100,
      y: 60,
      w: 120,
      h: 80,
      style: { ...baseStyle, rotation: 0 },
    };
    const layer = textLayerFor(page, unrotatedBox, rendered);
    expect(layer.text).toBeDefined();

    // boxBounds is the BLOCK's rect measured from the origin: the content width
    // (frame minus padding on both sides), because that is what both the app and
    // Photoshop reflow at, and the block's own height rather than the rest of
    // the frame, because Photoshop starts the paragraph at the top of this rect.
    // `baseStyle` has no explicit lineHeight, so one line is 24 * 1.1 - 26.4,
    // which the frame rounds UP to whole pixels (OVF-10, below).
    expect(layer.text.boxBounds).toEqual([0, 0, 120 - BOX_PAD * 2, Math.ceil(24 * 1.1)]);

    // The transform matrix [cos, sin, -sin, cos, tx, ty] for an unrotated box
    // must place the content origin at (box.x + BOX_PAD, box.y + blockY), and
    // `baseStyle` names no `valign`, which is the top - i.e. BOX_PAD.
    const [xx, xy, yx, yy, tx, ty] = layer.text.transform;
    expect(xx).toBeCloseTo(1, 6);
    expect(xy).toBeCloseTo(0, 6);
    expect(yx).toBeCloseTo(0, 6);
    expect(yy).toBeCloseTo(1, 6);
    expect(tx).toBeCloseTo(100 + BOX_PAD, 6);
    expect(ty).toBeCloseTo(60 + BOX_PAD, 6);
  });

  // Photoshop has no `valign`: it flows a paragraph from the top of `boxBounds`
  // and stops. So the app's vertical alignment has to be spent on WHERE that
  // rect starts, or a middle- or bottom-aligned box describes text at the top of
  // the frame while its cached pixels show it centred - and the words jump the
  // moment Photoshop re-renders the layer. `valign` defaults to 'middle', so
  // this was nearly every box in a document.
  it('anchors the type layer at the text block, not the box frame, for each valign', () => {
    const at = (valign) => {
      const layer = textLayerFor(
        page,
        { lineN: null, text: 'hello', x: 100, y: 60, w: 120, h: 80, style: { ...baseStyle, rotation: 0, valign } },
        rendered,
      );
      return layer.text.transform[5];
    };
    // One line, no explicit lineHeight in baseStyle.
    const blockH = 24 * 1.1;
    expect(at('top')).toBeCloseTo(60 + BOX_PAD, 6);
    expect(at('middle')).toBeCloseTo(60 + (80 - blockH) / 2, 6);
    expect(at('bottom')).toBeCloseTo(60 + 80 - BOX_PAD - blockH, 6);
    // A style that names no alignment at all has to answer like the exporter's
    // own fallback, which is the top.
    expect(at(undefined)).toBeCloseTo(60 + BOX_PAD, 6);
  });

  // The content box is the box less `textInset` - the padding plus the
  // outline's reach - on every side, in every renderer: the editor pads `.tbox`
  // by it and the raster exporter anchors the block by it. So an outlined box's
  // type layer starts that much further in, and its frame is that much narrower
  // on both sides - or Photoshop's re-render of a left- or top-aligned box lands
  // the outline's width away from the cached pixels under it.
  it('insets the type layer by the outline as well as the padding', () => {
    const strokes = [
      { color: '#ffffff', width: 3, opacity: 1 },
      { color: '#000000', width: 2, opacity: 0.5 },
    ];
    const layer = textLayerFor(
      page,
      { lineN: null, text: 'hello', x: 100, y: 60, w: 160, h: 80, style: { ...baseStyle, rotation: 0, valign: 'top', strokes } },
      rendered,
    );
    const inset = BOX_PAD + 3 + 2;
    expect(textInset({ strokes })).toBe(inset);
    expect(layer.text.boxBounds[2]).toBe(160 - inset * 2);
    expect(layer.text.transform[4]).toBeCloseTo(100 + inset, 6);
    expect(layer.text.transform[5]).toBeCloseTo(60 + inset, 6);
  });

  // OVF-10. The frame is whole pixels rounded UP, never down: a frame a
  // fraction narrower than the content box re-breaks its widest line when
  // Photoshop re-renders the layer, and one a fraction shorter than the block
  // hides the last line. The fraction goes on the side the text is not aligned
  // to, so each line's aligned edge is where the canvas put it, and the anchor
  // stays inside the box.
  it.each([
    ['left', 0],
    ['center', 0.5],
    ['right', 1],
  ])('rounds the frame up, and keeps a %s-aligned edge where the canvas has it', (align, share) => {
    const w = 120.4;
    const layer = textLayerFor(page, { lineN: null, text: 'hello', x: 100, y: 60, w, h: 80, style: { ...baseStyle, rotation: 0, align } }, rendered);
    const content = w - BOX_PAD * 2; // 116.4, which `Math.round` made 116
    const [x0, y0, fw, fh] = layer.text.boxBounds;
    expect([x0, y0, fw, fh]).toEqual([0, 0, 117, 27]);
    const tx = layer.text.transform[4];
    expect(tx).toBeCloseTo(100 + BOX_PAD - share * (fw - content), 6);
    // The frame's left edge, centre or right edge is the content box's.
    expect(tx + share * fw).toBeCloseTo(100 + BOX_PAD + share * content, 6);
    expect(tx).toBeGreaterThan(100);
    expect(layer.text.transform[5]).toBeCloseTo(60 + BOX_PAD, 6);
  });

  it('adds nothing to a frame that is already whole pixels, float noise and all', () => {
    // Five lines of 1.1 x 14 are 77.00000000000001, and 116 of content can
    // arrive as 116.00000000000003: a pixel of frame each, rounded up bare.
    expect(5 * (1.1 * 14)).toBeGreaterThan(77);
    const layer = textLayerFor(
      page,
      { lineN: null, text: 'a\nb\nc\nd\ne', x: 100, y: 60, w: 120 + 3e-14, h: 90, style: { ...baseStyle, rotation: 0, align: 'right', lineHeight: 1.1, size: 14 } },
      rendered,
    );
    expect(layer.text.boxBounds).toEqual([0, 0, 116, 77]);
    expect(layer.text.transform[4]).toBeCloseTo(100 + BOX_PAD, 6);
  });

  it('rotates the padded content origin about the box frame centre rather than about the inset origin', () => {
    // When a box is rotated, the pivot point must remain the geometric centre
    // of the outer box frame (cx, cy), matching exporter.js raster painting.
    // Pivoting about the inset content origin (ox, oy) instead of the frame
    // centre would cause the entire box to translate and orbit away from its
    // visual footprint upon rotation.
    const rotatedBox = {
      lineN: null,
      text: 'hello rotated',
      x: 100,
      y: 50,
      w: 200,
      h: 80,
      style: { ...baseStyle, rotation: 90 },
    };
    const layer = textLayerFor(page, rotatedBox, rendered);
    expect(layer.text).toBeDefined();

    const rad = (90 * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = 100 + 200 / 2; // 200
    const cy = 50 + 80 / 2; // 90
    const ox = 100 + BOX_PAD; // 102
    const oy = 50 + BOX_PAD; // 52

    const expectedTx = cx + (ox - cx) * cos - (oy - cy) * sin;
    const expectedTy = cy + (ox - cx) * sin + (oy - cy) * cos;

    const [xx, xy, yx, yy, tx, ty] = layer.text.transform;
    expect(xx).toBeCloseTo(cos, 6);
    expect(xy).toBeCloseTo(sin, 6);
    expect(yx).toBeCloseTo(-sin, 6);
    expect(yy).toBeCloseTo(cos, 6);
    expect(tx).toBeCloseTo(expectedTx, 6);
    expect(ty).toBeCloseTo(expectedTy, 6);

    // Transforming the centre of the inner content box [0, 0, Wc, Hc] by this
    // matrix must land at the exact geometric centre of the outer box frame (cx, cy).
    const contentW = 200 - BOX_PAD * 2;
    const contentH = 80 - BOX_PAD * 2;
    const transformedCenterX = tx + (contentW / 2) * xx + (contentH / 2) * yx;
    const transformedCenterY = ty + (contentW / 2) * xy + (contentH / 2) * yy;
    expect(transformedCenterX).toBeCloseTo(cx, 6);
    expect(transformedCenterY).toBeCloseTo(cy, 6);
  });
});

// ---------------------------------------------------------------------------
// export layer schema - what the file is allowed to contain
// ---------------------------------------------------------------------------
//
// pagePsdDocument and writePagePsd are the half of the exporter below the
// canvas, where the layer schema - the thing that decided a 60-70 MB export -
// is decided, and both run here on rasters handed in as plain ImageData.
// buildPagePsd, the DOM half above them, gets its own block near the bottom of
// this file for the narrow case that is still reachable from node.
//
// ag-psd's reader wants a canvas per layer. Hand it plain ImageData instead, so
// a file written here can be read back; anything that reaches for a real canvas
// throws rather than half-working against a DOM this environment hasn't got.
initializeCanvas(
  () => {
    throw new Error('no canvas in the node test environment');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
);
const READ = { useImageData: true, skipThumbnail: true };

// Incompressible content, so a raster costs its full size in the file and the
// size assertions below actually count rasters. A flat white page would
// collapse to nothing and hide an extra one.
function noise(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = s & 0xff;
    data[i + 1] = (s >> 8) & 0xff;
    data[i + 2] = (s >> 16) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

// No two adjacent bytes equal (so RLE can only literal-copy it) but a short
// repeating period (so deflate crushes it). The one difference between RLE and
// ZIP channel data that is visible from outside the file.
function periodic(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : (i * 37) & 0xff;
  return { width, height, data };
}

const W = 240;
const H = 360;
// One full-page RGB raster, uncompressed. A real one in the file lands a few
// percent over this - RLE pays a little to literal-copy incompressible bytes,
// and an all-opaque alpha channel collapses to nearly nothing - so the bounds
// below are stated as multiples of it rather than as byte counts.
const RASTER = W * H * 3;
const project = { key: 'mt:project', schema: 1, page: { id: 7, w: W, h: H, boxes: [], lines: [] } };
const baseLayer = (name, seed) => ({ name, left: 0, top: 0, right: W, bottom: H, imageData: noise(W, H, seed) });
const textLayer = () => ({
  name: 'hi',
  left: 20,
  top: 30,
  right: 70,
  bottom: 60,
  imageData: noise(50, 30, 99),
  text: {
    text: 'hi',
    orientation: 'horizontal',
    transform: [1, 0, 0, 1, 20, 30],
    antiAlias: 'smooth',
    shapeType: 'box',
    boxBounds: [0, 0, 50, 30],
    style: { font: { name: 'MyriadPro-Regular' }, fontSize: 20, fillColor: { r: 0, g: 0, b: 0 } },
    paragraphStyle: { justification: 'center' },
  },
});
const fullDoc = () =>
  pagePsdDocument({
    w: W,
    h: H,
    textLayers: [textLayer()],
    baseLayers: [baseLayer('Raw', 2), baseLayer('Cleaned', 1)],
    project,
  });
// The shape textLayerFor hands back for a curved/roughened box: same kind of
// bounds and pixels as textLayer() above, but no `text` key at all.
const rasterLayer = () => ({
  name: 'yo [raster, not editable in Photoshop]',
  left: 5,
  top: 8,
  right: 45,
  bottom: 38,
  imageData: noise(40, 30, 55),
  opacity: 1,
  blendMode: 'normal',
});

describe('pagePsdDocument', () => {
  it('writes a full-page flat white merged composite, carrying none of the art', () => {
    // Absent, the composite is written as zeros and macOS - Finder, Preview,
    // Quick Look, sips, all of which read ONLY the merged image and ignore the
    // thumbnail resource - renders every export as a solid black page. Real, it
    // costs a whole second copy of the page. Flat white is the only option that
    // is neither, and Photoshop rebuilds the true composite from the layers on
    // open regardless.
    const comp = fullDoc().imageData;
    expect([comp.width, comp.height]).toEqual([W, H]);
    expect(comp.data.every((v) => v === 255)).toBe(true);
  });

  it('writes no thumbnail image resource', () => {
    // There was a hand-built 160px one. macOS never reads resource 1036 - a
    // file with a valid thumbnail and one without Quick Look identically - and
    // no reader we can name and test on this machine reads it either, so its
    // ~15 KB and the extra full-page render that built it bought nothing.
    const res = fullDoc().imageResources;
    expect(res.thumbnail).toBeUndefined();
    expect(res.thumbnailRaw).toBeUndefined();
  });

  // `children[0]` is the BOTTOM layer, so this list reads upwards: the art
  // first, the lettering over it. Built the other way round - which is how it
  // used to be - the page art covers every text layer and the export opens as
  // bare, untypeset artwork.
  it('carries the Base and Text groups, art at the bottom and text on top', () => {
    const doc = fullDoc();
    expect(doc.children.map((c) => c.name)).toEqual(['Base', 'Text']);
    // Every root entry is a group: the hidden `Flattened preview` raster that
    // used to sit here was a flat layer, and that is how one would come back.
    expect(doc.children.every((c) => Array.isArray(c.children))).toBe(true);
  });

  it('leaves the Base group out of a page with no art rather than writing an empty one', () => {
    const doc = pagePsdDocument({ w: W, h: H, textLayers: [], project });
    expect(doc.children.map((c) => c.name)).toEqual(['Text']);
  });

  it('sizes the document to the page, so base art is stored unresampled', () => {
    const doc = fullDoc();
    const raw = doc.children[0].children[0];
    expect(raw.name).toBe('Raw');
    expect([doc.width, doc.height]).toEqual([W, H]);
    expect([raw.right - raw.left, raw.bottom - raw.top]).toEqual([W, H]);
  });

  it('carries a raster-only layer with no `text` key alongside an ordinary one that still has it', () => {
    // The mix a page with both a plain and a curved/roughened box actually
    // produces: pagePsdDocument does not itself decide this (textLayerFor
    // does, see above) but has to pass the distinction through untouched.
    const doc = pagePsdDocument({ w: W, h: H, textLayers: [textLayer(), rasterLayer()], project });
    const [text, raster] = doc.children.find((c) => c.name === 'Text').children;
    expect('text' in text).toBe(true);
    expect('text' in raster).toBe(false);
    expect([raster.imageData.width, raster.imageData.height]).toEqual([40, 30]);
  });
});

describe('writePagePsd', () => {
  // The order survives the file, not just the document object: ag-psd's writer
  // emits `children` in array order and its reader walks the file back from the
  // top with `unshift`, so a round trip is the closest thing here to asking
  // Photoshop which layer is on top. (It was asked directly, once: a written
  // page composited by psd-tools and diffed against renderPageCanvas is what
  // found the groups the wrong way up.)
  it('reads back as Base then Text, with no flat preview layer and an editable type layer', () => {
    const psd = readPsd(writePagePsd(fullDoc()), READ);
    expect(psd.children.map((c) => c.name)).toEqual(['Base', 'Text']);
    expect(psd.children.every((c) => c.children)).toBe(true);
    expect(psd.children[1].children.every((l) => !!l.text)).toBe(true);
    // Cleaned over Raw, or the cleaning is hidden by the art it replaced.
    expect(psd.children[0].children.map((l) => l.name)).toEqual(['Raw', 'Cleaned']);
  });

  it('round-trips a raster-only layer through a real PSD with no `text` on it, next to one that keeps it', () => {
    const doc = pagePsdDocument({ w: W, h: H, textLayers: [textLayer(), rasterLayer()], project });
    const psd = readPsd(writePagePsd(doc), READ);
    const [text, raster] = psd.children.find((c) => c.name === 'Text').children;
    expect(!!text.text).toBe(true);
    expect(!!raster.text).toBe(false);
    // The raster layer's pixels and bounds still round-trip byte-for-byte -
    // dropping `text` doesn't cost it anything the other layers keep.
    const ref = noise(40, 30, 55).data;
    expect([raster.left, raster.top, raster.right, raster.bottom]).toEqual([5, 8, 45, 38]);
    expect([raster.imageData.width, raster.imageData.height]).toEqual([40, 30]);
    expect(raster.imageData.data.findIndex((v, i) => v !== ref[i])).toBe(-1);
  });

  it('reads the merged image back as a white page', () => {
    const psd = readPsd(writePagePsd(fullDoc()), READ);
    expect([psd.imageData.width, psd.imageData.height]).toEqual([W, H]);
    expect(psd.imageData.data.every((v, i) => (i % 4 === 3 ? true : v === 255))).toBe(true);
  });

  it('spends nothing on that composite', () => {
    // Why the black page could be fixed for free. ag-psd emits the composite
    // section whether or not it is handed one, and a run-length code costs the
    // same on a run of 255s as on the run of 0s it would otherwise write, so
    // the white page is exactly as cheap as no page. Measured on a real
    // 800x1150 two-raster export: 5,490,174 bytes with the white composite,
    // 5,490,174 with an all-black one, 5,490,174 with none - and 8,133,354 with
    // the page's actual pixels in there. A composite that stops being constant
    // fails this by roughly a whole raster.
    const bare = fullDoc();
    delete bare.imageData;
    expect(writePagePsd(fullDoc()).byteLength).toBe(writePagePsd(bare).byteLength);
  });

  it('round-trips base pixels byte-for-byte', () => {
    // A re-imported export rebuilds page.raw / page.cleaned from these layers,
    // so a lossy channel encoding would quietly corrupt the art on the way back
    // in and no other check here would see it.
    const psd = readPsd(writePagePsd(fullDoc()), READ);
    const raw = psd.children[0].children[0];
    expect(raw.name).toBe('Raw');
    const ref = noise(W, H, 2).data;
    expect([raw.imageData.width, raw.imageData.height]).toEqual([W, H]);
    // The index rather than the arrays: a failing toEqual on 345,600 channels
    // prints 345,600 channels.
    expect(raw.imageData.data.findIndex((v, i) => v !== ref[i])).toBe(-1);
  });

  it('writes RLE channel data, not ZIP', () => {
    // `compress: true` was tried and reverted: 52% smaller, but 638-642 ms per
    // page against RLE's 21-24 ms, awaited per page on the webview's main
    // thread - twelve seconds of frozen UI for a twenty-page chapter. Nothing
    // about the file's contents changes when it comes back, which is exactly
    // why this needs guarding from the outside: `periodic` is content RLE can
    // only literal-copy and deflate takes to a few kilobytes. Measured on this
    // very document - RLE 272,936 bytes, ZIP 8,504.
    const doc = pagePsdDocument({
      w: W,
      h: H,
      textLayers: [],
      baseLayers: [{ name: 'Raw', left: 0, top: 0, right: W, bottom: H, imageData: periodic(W, H) }],
      project,
    });
    expect(writePagePsd(doc).byteLength).toBeGreaterThan(RASTER);
  });

  it('costs its two base rasters and nothing else full-page', () => {
    // Every extra full-page raster this schema has carried lands here as
    // another whole RASTER: the hidden `Flattened preview` layer, and the
    // merged composite the moment it stops being constant. The old schema wrote
    // four of them at a 2x supersampled document - sixteen times the upper
    // bound below. The lower bound is the other half of the claim: the two that
    // ARE supposed to be here have to still be here, at full page size.
    const bytes = writePagePsd(fullDoc()).byteLength;
    expect(bytes).toBeGreaterThan(2 * RASTER);
    expect(bytes).toBeLessThan(2.4 * RASTER);
  });

  it('round-trips stroke and drop shadow layer effects through a real PSD', () => {
    // Test that layer effects generated by textLayerFor survive the writePsd/readPsd
    // binary encoding and decoding, preserving stroke size/position/color and
    // drop shadow size/distance/angle/opacity, while raster layers remain effect-free.
    const styledBox = {
      lineN: null,
      text: 'FX',
      x: 10,
      y: 15,
      w: 80,
      h: 40,
      style: {
        curve: 0,
        roughen: { on: false },
        opacity: 1,
        align: 'center',
        size: 20,
        font: 'Comic Neue',
        strokes: [{ color: '#ff0000', width: 3, opacity: 1 }],
        shadows: [{ x: 4, y: 5, blur: 6, color: '#000000', opacity: 0.75 }],
      },
    };
    const renderedBox = {
      imageData: noise(50, 30, 99),
      left: 10,
      top: 15,
      right: 90,
      bottom: 55,
      opacity: 1,
    };
    const styledTextLayer = textLayerFor({ lines: [] }, styledBox, renderedBox);
    const plainRasterLayer = rasterLayer();

    const doc = pagePsdDocument({
      w: W,
      h: H,
      textLayers: [styledTextLayer, plainRasterLayer],
      project,
    });

    const psd = readPsd(writePagePsd(doc), READ);
    const [readText, readRaster] = psd.children[0].children;

    // Raster-only layer has no effects
    expect(readRaster.effects).toBeUndefined();

    // Text layer carries the stroke effect
    expect(readText.effects).toBeDefined();
    expect(readText.effects.stroke).toHaveLength(1);
    expect(readText.effects.stroke[0].size).toEqual({ units: 'Pixels', value: 3 });
    expect(readText.effects.stroke[0].position).toBe('outside');
    expect(readText.effects.stroke[0].color).toEqual({ r: 255, g: 0, b: 0 });

    // Text layer carries the drop shadow effect
    expect(readText.effects.dropShadow).toHaveLength(1);
    const ds = readText.effects.dropShadow[0];
    expect(ds.size).toEqual({ units: 'Pixels', value: 6 });
    expect(ds.opacity).toBe(0.75);
    expect(ds.color).toEqual({ r: 0, g: 0, b: 0 });

    // Verify angle and distance inverse round-trip back to original (x: 4, y: 5)
    const rad = (ds.angle * Math.PI) / 180;
    const recoveredX = -ds.distance.value * Math.cos(rad);
    const recoveredY = ds.distance.value * Math.sin(rad);
    expect(recoveredX).toBeCloseTo(4, 3);
    expect(recoveredY).toBeCloseTo(5, 3);
  });
});

// ---------------------------------------------------------------------------
// buildPagePsd - the DOM half
// ---------------------------------------------------------------------------
//
// buildPagePsd renders every raster through a canvas, so it normally stops at
// the browser. Exactly one page shape gets through here: no boxes, no raw, no
// cleaned. Then the only DOM it touches is `document.fonts.ready` and one
// scratch canvas nothing draws on, and it still decides the two things it is
// worth failing a build over - the document's size and the merged composite.
//
// KNOWN GAP: a page WITH art or boxes is not reachable in this environment, so
// nothing here proves the base layers go in unresampled or that a text layer
// carries its box's pixels. That is what psdSelfTest is for, and it now has a
// caller - the Developer group in the Settings modal, DEV builds only. It is a
// button somebody presses, not coverage; this gap is still a gap.
const withStubDocument = async (fn) => {
  const prev = globalThis.document;
  globalThis.document = {
    fonts: { ready: Promise.resolve() },
    // The shared box-raster scratch canvas, which a page with no boxes never
    // draws on. Anything that does draw - a thumbnail render coming back, say
    // - fails loudly here rather than silently passing.
    createElement: () => ({
      getContext: () => {
        throw new Error('buildPagePsd drew on a canvas; this environment has none');
      },
    }),
  };
  try {
    return await fn();
  } finally {
    globalThis.document = prev;
  }
};
const bareBuild = () => withStubDocument(() => buildPagePsd({ id: 7, w: 300, h: 420, lines: [], boxes: [] }));

describe('buildPagePsd', () => {
  it('sizes the document to the page rather than to a supersampled copy of it', async () => {
    // This file used to build at `scale = 2`, which put Raw and Cleaned in at
    // 4x their pixel count - invented pixels, for scanned art that has no
    // detail up there - and was most of a 39.94 MB page. Restoring the
    // supersample doubles both numbers below.
    const psd = readPsd(await bareBuild(), READ);
    expect([psd.width, psd.height]).toEqual([300, 420]);
  });

  // A page is `w:0,h:0` from the moment `createChapter` copies it until
  // something decodes its image, and only the canvas does that - one page at a
  // time, as the user opens them. Export All reaches every page, including the
  // ones nobody has looked at: 23 of the 28 pages in the author's own library
  // are saved at 0x0. `p.w ?? PAGE_W` let that straight through, and a 0x0 PSD
  // is a file nothing can open. With no image to measure either, the page has
  // no honest size and the defaults are the only answer left - but they have to
  // be an answer, not a zero.
  it('never sizes the document to nothing, however unmeasured the page', async () => {
    const psd = readPsd(
      await withStubDocument(() => buildPagePsd({ id: 7, w: 0, h: 0, lines: [], boxes: [] })),
      READ,
    );
    expect([psd.width, psd.height]).toEqual([PAGE_W, PAGE_H]);
    expect([psd.imageData.width, psd.imageData.height]).toEqual([PAGE_W, PAGE_H]);
  });

  // The same unmeasured page with art to measure: the document is the art's
  // size, and the page the file carries for re-import has to say that size
  // too - the importer believes it, and a page that says 850x1200 over
  // 123x234 art has every box rescaled out of place the next time the art is
  // measured.
  it('embeds the page at the size the document was measured to', async () => {
    const prevImage = globalThis.Image;
    globalThis.Image = class {
      set src(url) {
        this._src = url;
        queueMicrotask(() => {
          this.naturalWidth = 123;
          this.naturalHeight = 234;
          this.onload?.();
        });
      }
      get src() {
        return this._src;
      }
    };
    try {
      const bytes = await withStubDocument(() => buildPagePsd({ id: 7, w: 0, h: 0, raw: 'blob:art', lines: [], boxes: [] }));
      const psd = readPsd(bytes, READ);
      expect([psd.width, psd.height]).toEqual([123, 234]);
      const xmp = psd.imageResources.xmpMetadata;
      const page = JSON.parse(Buffer.from(xmp.match(/<mt:project>([\s\S]*?)<\/mt:project>/)[1].trim(), 'base64').toString('utf8')).page;
      expect([page.w, page.h]).toEqual([123, 234]);
    } finally {
      globalThis.Image = prevImage;
    }
  });

  it('comes out of the whole pipeline with a white page as its merged image', async () => {
    // End to end, not at the seam: the composite has to survive buildPagePsd
    // too, because a black one is what every export looked like in Finder,
    // Preview and Quick Look while Photoshop showed it perfectly.
    const psd = readPsd(await bareBuild(), READ);
    expect([psd.imageData.width, psd.imageData.height]).toEqual([300, 420]);
    expect(psd.imageData.data.every((v, i) => (i % 4 === 3 ? true : v === 255))).toBe(true);
  });
});

describe('reconstructForeign', () => {
  it('reconstructs text box frame geometry from transform and boxBounds rather than tight ink bounds', async () => {
    // Tight glyph bounds (e.g. 115..145, 65..85) vs outer frame geometry (100, 60, 120, 80)
    const foreignPsd = {
      width: 800,
      height: 1200,
      children: [
        {
          name: 'Layer 1',
          left: 115,
          top: 65,
          right: 145,
          bottom: 85,
          text: {
            text: 'Foreign text',
            transform: [1, 0, 0, 1, 102, 62],
            boxBounds: [0, 0, 116, 76],
            style: {
              fontSize: 24,
              font: { name: 'Arial-BoldMT' },
            },
          },
        },
      ],
    };

    const page = await reconstructForeign(foreignPsd);
    expect(page.boxes).toHaveLength(1);
    const b = page.boxes[0];
    expect(b.x).toBe(100);
    expect(b.y).toBe(60);
    expect(b.w).toBe(120);
    expect(b.h).toBe(80);
    expect(b.text).toBe('Foreign text');
    expect(b.style.bold).toBe(true);
  });

  // ...and back. A box this app wrote comes back the size it went out, outline
  // and all: the importer reads the outline off the layer's stroke effects -
  // the writer's outermost-first outer edges, back to innermost-first widths -
  // and undoes the same inset. Undoing the padding alone brought an outlined box
  // back 10px narrower than it went out, so its lines broke somewhere else. A
  // layer with no stroke effect comes back with no outline, rather than with
  // the app's default: its frame was not laid out with the default's inset.
  it('reads the outline back off the stroke effects and undoes its inset', async () => {
    const strokes = [
      { color: '#ffffff', width: 3, opacity: 1 },
      { color: '#000000', width: 2, opacity: 0.5 },
    ];
    // One line at lineHeight 1, in a box exactly as tall as it and its inset:
    // the height the importer recovers is the block's.
    const style = normalizeStyle({ ...defaultStyle(), size: 24, lineHeight: 1, align: 'left', valign: 'top', strokes });
    const box = { lineN: null, text: 'hello', x: 100, y: 60, w: 160, h: 24 + textInset(style) * 2, style };
    const layer = textLayerFor({ lines: [] }, box, null);
    const bare = textLayerFor({ lines: [] }, { ...box, style: { ...style, strokes: [] } }, null);
    delete bare.effects;
    const page = await reconstructForeign({ width: 800, height: 1200, children: [layer, bare] });
    const [b, plain] = page.boxes;
    expect(b.style.strokes).toEqual(strokes);
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }).toEqual({ x: 100, y: 60, w: 160, h: box.h });
    expect(b.style.align).toBe('left');
    expect(plain.style.strokes).toEqual([]);
    expect({ x: plain.x, y: plain.y, w: plain.w, h: plain.h }).toEqual({ x: 100, y: 60, w: 160, h: 24 + BOX_PAD * 2 });
  });

  // OVF-10: the frame the writer rounds up comes back as a box no narrower than
  // the one that went out, so its lines do not re-break on the way in - the
  // old `Math.round` brought a 120.4 box back 120 wide, 0.4px short of the
  // width its widest line was broken to - and its aligned edge is where it
  // was, to the importer's own whole-pixel rounding.
  it('brings a box of fractional width back no narrower than it went out', async () => {
    const style = normalizeStyle({ ...defaultStyle(), size: 24, lineHeight: 1.1, align: 'right', valign: 'top', strokes: [] });
    const box = { lineN: null, text: 'hello', x: 100.3, y: 60, w: 120.4, h: 40, style };
    const layer = textLayerFor({ lines: [] }, box, null);
    delete layer.effects;
    const pg = await reconstructForeign({ width: 800, height: 1200, children: [layer] });
    const [b] = pg.boxes;
    expect(b.w).toBeGreaterThanOrEqual(box.w);
    expect(b.h - BOX_PAD * 2).toBeGreaterThanOrEqual(24 * 1.1);
    expect(Math.abs(b.x + b.w - (box.x + box.w))).toBeLessThanOrEqual(0.5);
  });

  it('falls back to raster ink bounds when boxBounds or transform are absent', async () => {
    const foreignPsd = {
      width: 800,
      height: 1200,
      children: [
        {
          name: 'Point Text',
          left: 50,
          top: 40,
          right: 180,
          bottom: 90,
          text: {
            text: 'Point text',
            style: { fontSize: 20 },
          },
        },
      ],
    };

    const page = await reconstructForeign(foreignPsd);
    expect(page.boxes).toHaveLength(1);
    const b = page.boxes[0];
    expect(b.x).toBe(50);
    expect(b.y).toBe(40);
    expect(b.w).toBe(130);
    expect(b.h).toBe(50);
  });
});

describe('psdSelfTest', () => {
  it('is exported as an async function for developer self-testing', () => {
    expect(typeof psdSelfTest).toBe('function');
  });
});
