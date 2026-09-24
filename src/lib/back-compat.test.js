// ===== Opening what an older build wrote =====
//
// Every fixture in this file is a LITERAL JSON string in the shape a previous
// release actually persisted - not a hand-built object in today's shape with a
// field removed. That is the whole point: the app's promise is that a project
// on somebody's disk keeps working across an update, and the only honest way to
// test it is to feed it the bytes that are on that disk.
//
// Two eras are covered, and they are the two that shipped:
//
//   ERA 1  the oldest chapters. A style is a handful of flat keys - no
//          `shadow` group, no `roughen`, no `shape`/`minOrphan`/`hyphenate`,
//          no `balloon`/`autoHeight`, no `flipH`/`flipV`/`curve`.
//   ERA 2  the last release before this change set. `outline` + `outlineWidth`
//          are the outline, `shadow { on, x, y, blur, color, opacity }` is the
//          shadow, and there is no such thing as a gradient or a pattern.
//
// Anything newer than era 2 has never been written to anyone's disk, so the
// gradient/pattern cases here are gates rather than migrations: they prove that
// a partial or hand-edited group degrades to something both renderers can paint.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeStyle, defaultStyle, PATTERN_KINDS } from './data.js';
import { parsePresets } from './presets.svelte.js';
import { normalizeTranslations } from './importer.js';
import { migrateEntry, migrateDoc } from './editor/history-file.svelte.js';
import { app, loadProjectPages, pageById, byId } from './store.svelte.js';
import { initHistory, loadStack, undo, redo, resetHistory } from './editor/history.svelte.js';

// ---------------------------------------------------------------------------
// the fixtures
// ---------------------------------------------------------------------------

// An era-2 style, exactly as `defaultStyle()` serialised it before strokes.
const ERA2_STYLE = `{
  "font": "Bangers",
  "size": 34,
  "bold": true,
  "italic": false,
  "align": "center",
  "valign": "middle",
  "color": "#1a1a1a",
  "opacity": 1,
  "uppercase": true,
  "outline": "#ff0044",
  "outlineWidth": 5,
  "lineHeight": 1.1,
  "letterSpacing": 0,
  "rotation": 0,
  "flipH": false,
  "flipV": false,
  "shadow": { "on": true, "x": 3, "y": 4, "blur": 6, "color": "#112233", "opacity": 0.5 },
  "roughen": { "on": false, "amount": 4, "detail": 0.05, "seed": 7 },
  "curve": 0,
  "shape": "auto",
  "minOrphan": 3,
  "hyphenate": true,
  "balloon": true,
  "autoHeight": true
}`;

// An era-1 style: the flat keys and nothing else.
const ERA1_STYLE = `{
  "font": "Comic Neue",
  "size": 26,
  "bold": true,
  "align": "left",
  "color": "#101010",
  "outline": "#00ff88",
  "outlineWidth": 2,
  "lineHeight": 1.2
}`;

// A whole chapter.json from era 2, carrying every page shape the loader has to
// survive: an unmeasured page (w/h 0), a page with no `detect` at all, a page
// whose `detect` has panels but no boxes, a box with `lineN: null` (the old
// canvas-only text box), tags on one line and none on another.
const ERA2_CHAPTER = `{
  "schema": 1,
  "id": "ch_abc",
  "number": "12",
  "title": "The Duel",
  "createdAt": "2026-01-04T10:00:00.000Z",
  "updatedAt": "2026-01-09T18:22:13.000Z",
  "pages": [
    {
      "id": 1,
      "file": "001.png",
      "cleaned": "001.png",
      "w": 1200,
      "h": 1700,
      "lines": [
        { "n": 1, "type": "dialogue", "jp": "\\u3042", "en": "Ah.", "tags": ["shout"] },
        { "n": 2, "type": "sfx", "jp": "\\u30c9\\u30f3", "en": "DOOM" }
      ],
      "detect": {
        "panels": [[0, 0, 1200, 850]],
        "boxes": [{ "n": 1, "box": [100, 120, 300, 260], "vertical": true, "font_size": 30 }]
      },
      "boxes": [
        {
          "id": "b1",
          "lineN": 1,
          "text": null,
          "x": 110,
          "y": 130,
          "w": 180,
          "h": 120,
          "style": ${ERA2_STYLE},
          "fit": { "kind": "ellipse", "cx": 200, "cy": 190, "rx": 90, "ry": 60 }
        },
        {
          "id": "b2",
          "lineN": null,
          "text": "hand-typed",
          "x": 400,
          "y": 900,
          "w": 200,
          "h": 60,
          "style": ${ERA1_STYLE}
        }
      ]
    },
    {
      "id": 2,
      "file": "002.png",
      "cleaned": null,
      "w": 0,
      "h": 0,
      "lines": [],
      "detect": { "panels": [[0, 0, 100, 100]] },
      "boxes": []
    },
    {
      "id": 3,
      "file": "003.png",
      "cleaned": null,
      "w": 1200,
      "h": 1700,
      "lines": [{ "n": 1, "type": "narration", "jp": "", "en": "Later." }],
      "boxes": []
    }
  ]
}`;

// A logs/history.json from era 2. Every kind that carries a payload is here,
// and the `place` / `delete` pair carry a whole box - which is the one the
// canvas used to throw on.
const ERA2_HISTORY = `{
  "version": 1,
  "pages": {
    "1": {
      "undo": [
        {
          "t": "place",
          "pageId": 1,
          "boxId": "b9",
          "index": 0,
          "activeBefore": 1,
          "activeAfter": 2,
          "box": {
            "id": "b9",
            "lineN": 1,
            "text": null,
            "x": 10,
            "y": 20,
            "w": 150,
            "h": 90,
            "style": ${ERA2_STYLE}
          }
        },
        {
          "t": "move",
          "pageId": 1,
          "boxId": "b1",
          "before": { "x": 10, "y": 20 },
          "after": { "x": 30, "y": 40 }
        },
        {
          "t": "resize",
          "pageId": 1,
          "boxId": "b1",
          "before": { "w": 100, "h": 40, "size": 20 },
          "after": { "w": 200, "h": 80, "size": 28 }
        },
        {
          "t": "text",
          "pageId": 1,
          "boxId": "b1",
          "before": "old words",
          "after": "new words"
        },
        {
          "t": "style",
          "pageId": 1,
          "boxId": "b1",
          "before": ${ERA1_STYLE},
          "after": ${ERA2_STYLE}
        }
      ],
      "redo": [
        {
          "t": "delete",
          "pageId": 1,
          "boxId": "b7",
          "index": 1,
          "box": {
            "id": "b7",
            "lineN": 2,
            "text": null,
            "x": 1,
            "y": 2,
            "w": 3,
            "h": 4,
            "style": ${ERA1_STYLE}
          }
        }
      ]
    },
    "2": {
      "undo": [
        {
          "t": "bulk",
          "pageId": 2,
          "items": [
            { "pageId": 2, "boxId": "b3", "before": ${ERA1_STYLE}, "after": ${ERA2_STYLE} }
          ]
        }
      ],
      "redo": []
    }
  }
}`;

// A translations.json from era 2: an unmeasured page exported `width`/`height`
// as the app's fallback page size rather than saying it did not know.
const ERA2_TRANSLATIONS = `{
  "pages": [
    {
      "page": 1,
      "width": 1200,
      "height": 1700,
      "panels": [[0, 0, 1200, 850]],
      "lines": [
        { "n": 1, "jp": "\\u3042", "en": "Ah.", "type": "dialogue", "tags": ["shout"],
          "box": [100, 120, 300, 260], "placed": { "x": 110, "y": 130, "w": 180, "h": 120 } },
        { "n": 2, "jp": "\\u30c9\\u30f3", "en": "DOOM", "type": "sfx", "box": null, "placed": null }
      ]
    },
    { "page": 2, "width": 850, "height": 1200, "panels": [], "lines": [] }
  ]
}`;

// The same file as this build writes it: an unmeasured page says `null`.
const NOW_TRANSLATIONS = ERA2_TRANSLATIONS.replace(
  '{ "page": 2, "width": 850, "height": 1200,',
  '{ "page": 2, "width": null, "height": null,',
);

// ---------------------------------------------------------------------------
// 1. chapter.json - the style schema
// ---------------------------------------------------------------------------

describe('a style written before strokes and shadows were lists', () => {
  it('keeps an era-2 outline as the innermost stroke, with its colour and width', () => {
    const s = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect(s.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
  });

  it('keeps an era-2 shadow, exactly where it was cast', () => {
    const s = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect(s.shadows).toEqual([{ x: 3, y: 4, blur: 6, color: '#112233', opacity: 0.5 }]);
  });

  it('reads a switched-off shadow as no shadow rather than as a black one', () => {
    const off = { ...JSON.parse(ERA2_STYLE), shadow: { on: false, x: 9, y: 9, blur: 9, color: '#ff0000', opacity: 1 } };
    expect(normalizeStyle(off).shadows).toEqual([]);
  });

  it('reads outlineWidth 0 as no outline, not as a default one', () => {
    const none = { ...JSON.parse(ERA2_STYLE), outlineWidth: 0 };
    expect(normalizeStyle(none).strokes).toEqual([]);
  });

  it('migrates an era-1 style, whose keys stop well short of the schema', () => {
    const s = normalizeStyle(JSON.parse(ERA1_STYLE));
    const d = defaultStyle();
    expect(s.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
    expect(s.shadows).toEqual([]);
    // Everything era 1 never heard of answers to today's default, so the
    // chapter opens with shaping, hyphenation and auto-height on.
    expect(s.shape).toBe(d.shape);
    expect(s.minOrphan).toBe(d.minOrphan);
    expect(s.hyphenate).toBe(d.hyphenate);
    expect(s.balloon).toBe(d.balloon);
    expect(s.autoHeight).toBe(d.autoHeight);
    expect(s.roughen).toEqual(d.roughen);
    expect(s.curve).toBe(0);
    expect(s.flipH).toBe(false);
    // …and what it DID say survives untouched.
    expect(s.font).toBe('Comic Neue');
    expect(s.size).toBe(26);
    expect(s.align).toBe('left');
    expect(s.color).toBe('#101010');
    expect(s.lineHeight).toBe(1.2);
  });

  it('leaves no legacy key behind for a later reader to trust', () => {
    const s = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect('outline' in s).toBe(false);
    expect('outlineWidth' in s).toBe(false);
    expect('shadow' in s).toBe(false);
  });

  it('fills the fill fields no old style ever had', () => {
    const s = normalizeStyle(JSON.parse(ERA1_STYLE));
    expect(s.gradient.on).toBe(false);
    expect(s.gradient.stops).toHaveLength(2);
    expect(s.pattern.on).toBe(false);
    expect(PATTERN_KINDS).toContain(s.pattern.kind);
    expect('fillOpacity' in s).toBe(false);
    expect(s.blur).toBe(0);
  });

  it('folds legacy fillOpacity into whole-box opacity', () => {
    const s = normalizeStyle({ fillOpacity: 0.5, opacity: 0.8 });
    expect(s.opacity).toBeCloseTo(0.4);
    expect('fillOpacity' in s).toBe(false);
    const full = normalizeStyle({ fillOpacity: 1 });
    expect(full.opacity).toBe(1);
  });

  it('migrates legacy motionBlur by dropping length/angle while keeping on and defaulting x/y/amount', () => {
    const s = normalizeStyle({ motionBlur: { on: true, length: 40, angle: 90 } });
    expect(s.motionBlur).toEqual({ on: true, x: 2, y: 0, amount: 16 });
  });

  it('migrates legacy clip with on: true up to the new schema with defaults and empty shapes', () => {
    const s = normalizeStyle({ clip: { on: true } });
    expect(s.clip).toEqual({ on: true, mode: 'exclude', brushSize: 20, shapes: [] });
  });

  it('is idempotent, so a migrated style survives every later save', () => {
    const once = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect(normalizeStyle(once)).toEqual(once);
  });

  it('takes a style that already has strokes as written, ignoring stale legacy keys', () => {
    const mixed = {
      ...JSON.parse(ERA2_STYLE),
      strokes: [{ color: '#000000', width: 1, opacity: 0.5 }, { color: '#ffffff', width: 4, opacity: 1 }],
      shadows: [],
    };
    const s = normalizeStyle(mixed);
    expect(s.strokes).toEqual([
      { color: '#000000', width: 1, opacity: 0.5 },
      { color: '#ffffff', width: 4, opacity: 1 },
    ]);
    expect(s.shadows).toEqual([]);
  });

  // Gradients never shipped, so these are gates on a hand-edited or
  // future-written file rather than migrations of anything on a real disk.
  it('gives a two-stop gradient with no per-stop alpha the alpha it was painting with', () => {
    const s = normalizeStyle({
      gradient: { on: true, angle: 90, scope: 'box', stops: [{ color: '#ffffff', pos: 0 }, { color: '#000000', pos: 1 }] },
    });
    expect(s.gradient.stops).toEqual([
      { color: '#ffffff', pos: 0, opacity: 1 },
      { color: '#000000', pos: 1, opacity: 1 },
    ]);
    // Radial arrived after linear; a file with none of its fields keeps painting
    // exactly as it did.
    expect(s.gradient.kind).toBe('linear');
    expect(s.gradient.cx).toBe(0.5);
    expect(s.gradient.cy).toBe(0.5);
    expect(s.gradient.radius).toBe(1);
  });

  it('sorts a gradient’s stops and refuses a one-stop ramp', () => {
    const s = normalizeStyle({
      gradient: { on: true, stops: [{ color: '#111111', pos: 0.9 }, { color: '#222222', pos: 0.1 }] },
    });
    expect(s.gradient.stops.map((x) => x.pos)).toEqual([0.1, 0.9]);
    const one = normalizeStyle({ gradient: { on: true, stops: [{ color: '#111111', pos: 0 }] } });
    expect(one.gradient.stops).toEqual(defaultStyle().gradient.stops);
  });

  it('folds a pattern kind this build cannot draw back to one it can', () => {
    const s = normalizeStyle({ pattern: { on: true, kind: 'moire-of-the-future', fg: '#000000', bg: '#ffffff' } });
    expect(s.pattern.kind).toBe(defaultStyle().pattern.kind);
  });

  it('keeps a block shape it knows and folds any other back to auto', () => {
    for (const shape of ['auto', 'oval', 'rect', 'off']) expect(normalizeStyle({ shape }).shape).toBe(shape);
    expect(normalizeStyle({ shape: 'hexagon' }).shape).toBe('auto');
    expect(normalizeStyle({ shape: 3 }).shape).toBe('auto');
    expect(normalizeStyle({}).shape).toBe(defaultStyle().shape);
  });
});

// ---------------------------------------------------------------------------
// 2. chapter.json - the page records
// ---------------------------------------------------------------------------

describe('a whole chapter.json from the last release', () => {
  let record;
  beforeEach(() => {
    record = JSON.parse(ERA2_CHAPTER);
    loadProjectPages(record.pages);
  });

  it('loads every page, keeping the ids the file gave them', () => {
    expect(app.pages.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('keeps the boxes’ persisted ids rather than minting new ones', () => {
    expect(pageById(1).boxes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('leaves an unmeasured page unmeasured rather than inventing a space', () => {
    expect([pageById(2).w, pageById(2).h]).toEqual([0, 0]);
    expect([pageById(1).w, pageById(1).h]).toEqual([1200, 1700]);
  });

  it('reads a detect with panels and no boxes as an empty box list', () => {
    expect(pageById(2).detect).toEqual({ panels: [[0, 0, 100, 100]], boxes: [] });
  });

  it('reads a page with no detect at all as having none', () => {
    expect(pageById(3).detect).toBeNull();
  });

  it('reads a record with no needsRespace as a page that needs none', () => {
    expect(app.pages.every((p) => p.needsRespace === false)).toBe(true);
  });

  it('migrates every box’s style on the way in, both eras at once', () => {
    expect(byId('b1').style.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
    expect(byId('b1').style.shadows).toHaveLength(1);
    expect(byId('b2').style.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
    // Every style the canvas will read has the groups it reads unguarded.
    for (const p of app.pages) {
      for (const b of p.boxes) {
        expect(b.style.gradient).toBeTruthy();
        expect(b.style.pattern).toBeTruthy();
        expect(Array.isArray(b.style.strokes)).toBe(true);
        expect(Array.isArray(b.style.shadows)).toBe(true);
      }
    }
  });

  it('keeps a canvas-only box exactly as it was - lineN null, not renumbered', () => {
    expect(byId('b2').lineN).toBeNull();
    expect(byId('b2').text).toBe('hand-typed');
  });

  it('keeps the balloon a box was fitted to', () => {
    expect(byId('b1').fit).toEqual({ kind: 'ellipse', cx: 200, cy: 190, rx: 90, ry: 60 });
  });

  it('keeps the lines, their tags, and the silence of a line that has none', () => {
    const [l1, l2] = pageById(1).lines;
    expect(l1.tags).toEqual(['shout']);
    expect('tags' in l2).toBe(false);
    expect(l2.type).toBe('sfx');
  });
});

// ---------------------------------------------------------------------------
// 3. logs/history.json
// ---------------------------------------------------------------------------

describe('an undo history written before the style schema moved', () => {
  const parsed = () => JSON.parse(ERA2_HISTORY);

  it('migrates the style inside a place entry’s box', () => {
    const e = migrateEntry(parsed().pages['1'].undo[0]);
    expect(e.box.style.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
    expect(e.box.style.gradient).toBeTruthy();
    expect(e.box.style.pattern).toBeTruthy();
    // Everything else about the record is untouched.
    expect(e.t).toBe('place');
    expect(e.index).toBe(0);
    expect(e.activeBefore).toBe(1);
    expect(e.box.x).toBe(10);
  });

  it('migrates a delete entry’s box the same way', () => {
    const e = migrateEntry(parsed().pages['1'].redo[0]);
    expect(e.box.style.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
  });

  it('migrates both halves of a style entry', () => {
    const e = migrateEntry(parsed().pages['1'].undo[4]);
    expect(e.before.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
    expect(e.after.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
  });

  it('migrates each item of a bulk entry, and leaves an absent lastStyle pair absent', () => {
    const e = migrateEntry(parsed().pages['2'].undo[0]);
    expect(e.items[0].before.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
    expect(e.items[0].after.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
    expect(e.items[0].boxId).toBe('b3');
    expect('lastStyleBefore' in e).toBe(false);
  });

  // The trap this migration has to step over: `move`/`resize` also carry
  // `before`/`after`, and they are NOT styles - they are the handful of fields
  // that changed. Normalising one would inflate it into a whole style and then
  // write every field of it onto the box.
  it('does not touch a move or resize entry’s geometry pair', () => {
    const mv = parsed().pages['1'].undo[1];
    const rz = parsed().pages['1'].undo[2];
    expect(migrateEntry(mv)).toBe(mv);
    expect(migrateEntry(rz)).toBe(rz);
    expect(migrateEntry(rz).before).toEqual({ w: 100, h: 40, size: 20 });
  });

  it('does not touch a text entry’s strings', () => {
    const tx = parsed().pages['1'].undo[3];
    expect(migrateEntry(tx)).toBe(tx);
    expect(migrateEntry(tx).before).toBe('old words');
  });

  it('hands a document that needs nothing back as the very object it was given', () => {
    const already = migrateDoc(parsed());
    expect(migrateDoc(already)).toBe(already);
  });

  it('leaves a document of an unknown version alone', () => {
    const future = { version: 99, pages: {} };
    expect(migrateDoc(future)).toBe(future);
    expect(migrateDoc(null)).toBeNull();
  });

  it('migrates every page’s stack, on both sides', () => {
    const doc = migrateDoc(parsed());
    expect(doc.pages['1'].undo[0].box.style.strokes).toHaveLength(1);
    expect(doc.pages['1'].redo[0].box.style.strokes).toHaveLength(1);
    expect(doc.pages['2'].undo[0].items[0].after.strokes).toHaveLength(1);
  });
});

// The proof that matters: the entry actually replays. An era-2 `delete` undone
// puts a box back on the page, and what it puts back has to be a style the
// canvas can read - `TextBox.svelte` reads `s.pattern.on` and `s.gradient.on`
// with no guard at all, because everything that reaches it has been normalised.
describe('replaying an era-2 entry against today’s document', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(JSON.parse(ERA2_CHAPTER).pages);
  });
  afterEach(() => resetHistory());

  const deletion = () => {
    const doc = migrateDoc(JSON.parse(ERA2_HISTORY));
    // Aimed at a box the fixture chapter really has, so the entry describes
    // this document rather than some other one.
    const e = structuredClone(doc.pages['1'].undo[0]);
    e.t = 'delete';
    e.box.id = 'b2';
    e.index = 1;
    return e;
  };

  it('restores a deleted box with a style the renderers can read', () => {
    const before = pageById(1).boxes.length;
    // The box the entry is about, taken away so the undo has somewhere to put it.
    pageById(1).boxes = pageById(1).boxes.filter((b) => b.id !== 'b2');
    loadStack(1, { undo: [deletion()], redo: [] });
    expect(undo()).toBe(true);
    expect(pageById(1).boxes).toHaveLength(before);
    const s = byId('b2').style;
    expect(s.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
    expect(s.gradient.on).toBe(false);
    expect(s.pattern.on).toBe(false);
    expect(s.shadows).toHaveLength(1);
    expect('fillOpacity' in s).toBe(false);
    // And forward again, with nothing corrupted on the way.
    expect(redo()).toBe(true);
    expect(pageById(1).boxes.some((b) => b.id === 'b2')).toBe(false);
  });

  it('replays an era-2 style entry onto a box that is standing in today’s schema', () => {
    const e = {
      t: 'style',
      pageId: 1,
      boxId: 'b1',
      before: JSON.parse(ERA1_STYLE),
      after: JSON.parse(ERA2_STYLE),
    };
    loadStack(1, { undo: [migrateEntry(e)], redo: [] });
    expect(undo()).toBe(true);
    expect(byId('b1').style.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
    expect(byId('b1').style.pattern).toBeTruthy();
    expect(byId('b1').style.gradient).toBeTruthy();
  });

  it('replays an era-2 move entry without disturbing anything but the geometry', () => {
    const e = {
      t: 'move',
      pageId: 1,
      boxId: 'b1',
      before: { x: 10, y: 20 },
      after: { x: 110, y: 130 },
    };
    const strokes = structuredClone(byId('b1').style.strokes);
    loadStack(1, { undo: [migrateEntry(e)], redo: [] });
    expect(undo()).toBe(true);
    expect([byId('b1').x, byId('b1').y]).toEqual([10, 20]);
    expect(byId('b1').style.strokes).toEqual(strokes);
    expect(byId('b1').style.size).toBe(34);
  });
});

// ---------------------------------------------------------------------------
// 4. translations.json
// ---------------------------------------------------------------------------

describe('a translations file, whichever era wrote it', () => {
  const linesOf = (json) =>
    normalizeTranslations(JSON.parse(json)).map((p) => p.lines.map((l) => [l.n, l.en, l.type]));

  it('reads the same lines out of a numeric-fallback file and a null one', () => {
    expect(linesOf(ERA2_TRANSLATIONS)).toEqual(linesOf(NOW_TRANSLATIONS));
  });

  it('reads the old file the app used to write', () => {
    const pages = normalizeTranslations(JSON.parse(ERA2_TRANSLATIONS));
    expect(pages).toHaveLength(2);
    expect(pages[0].lines.map((l) => l.n)).toEqual([1, 2]);
    expect(pages[0].lines[0].en).toBe('Ah.');
    expect(pages[0].lines[0].tags).toEqual(['shout']);
    expect(pages[1].lines).toEqual([]);
  });

  it('reads a page whose size is null without inventing one or dropping the page', () => {
    const pages = normalizeTranslations(JSON.parse(NOW_TRANSLATIONS));
    expect(pages).toHaveLength(2);
    expect(pages[1].lines).toEqual([]);
  });

  // The two shapes an even older hand-rolled file took.
  it('still reads a bare array of lines and a `texts` page', () => {
    expect(normalizeTranslations(['one', 'two'])[0].lines.map((l) => l.en)).toEqual(['one', 'two']);
    const p = normalizeTranslations({ page: 1, texts: [{ id: 0, text: 'zero' }, { id: 1, text: 'one' }] });
    expect(p[0].lines.map((l) => l.n)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 5. localStorage
// ---------------------------------------------------------------------------

describe('a presets blob from the last release', () => {
  const ERA2_PRESETS = `{"list":[
    {"id":"pr_1","name":"Shout","style":${ERA2_STYLE}},
    {"id":"pr_2","name":"Whisper","style":${ERA1_STYLE}}
  ]}`;

  it('migrates each preset’s style through the one seam every style goes through', () => {
    const list = parsePresets(ERA2_PRESETS);
    expect(list.map((p) => p.name)).toEqual(['Shout', 'Whisper']);
    expect(list[0].style.strokes).toEqual([{ color: '#ff0044', width: 5, opacity: 1 }]);
    expect(list[0].style.shadows).toHaveLength(1);
    expect(list[1].style.strokes).toEqual([{ color: '#00ff88', width: 2, opacity: 1 }]);
    for (const p of list) {
      expect(p.style.gradient).toBeTruthy();
      expect(p.style.pattern).toBeTruthy();
      expect('outline' in p.style).toBe(false);
    }
  });

  it('keeps the ids, so a preset the user saved is the same preset after the update', () => {
    expect(parsePresets(ERA2_PRESETS).map((p) => p.id)).toEqual(['pr_1', 'pr_2']);
  });

  it('drops a blob it cannot read rather than failing the launch', () => {
    expect(parsePresets('{ not json')).toEqual([]);
    expect(parsePresets('{"list":"nope"}')).toEqual([]);
    expect(parsePresets(null)).toEqual([]);
  });
});

describe('a prefs blob from before shortcuts could be rebound', () => {
  // `prefs.svelte.js` applies on import, so the storage it reads has to be in
  // place before the module is. A fresh registry per case is what makes that
  // testable at all - see the dynamic import.
  const withStorage = async (raw) => {
    const map = new Map(raw == null ? [] : [['mt.prefs', raw]]);
    globalThis.localStorage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
      removeItem: (k) => void map.delete(k),
    };
    vi.resetModules();
    const mod = await import('./prefs.svelte.js');
    return { prefs: mod.prefs, setPref: mod.setPref, map };
  };
  const realStorage = globalThis.localStorage;
  afterEach(() => {
    if (realStorage) globalThis.localStorage = realStorage;
    else delete globalThis.localStorage;
  });

  it('reads a blob with no `shortcuts` key and leaves the map empty', async () => {
    const { prefs } = await withStorage('{"typeset":true}');
    expect(prefs.typeset).toBe(true);
    expect(prefs.shortcuts).toEqual({});
  });

  it('reads a blob with no keys at all', async () => {
    const { prefs } = await withStorage('{}');
    expect(prefs.typeset).toBe(false);
    expect(prefs.shortcuts).toEqual({});
  });

  it('leaves the defaults standing for a corrupt or absent blob', async () => {
    expect((await withStorage('{ not json')).prefs.shortcuts).toEqual({});
    expect((await withStorage(null)).prefs.typeset).toBe(false);
  });

  it('refuses a `shortcuts` of the wrong shape rather than handing it to the matcher', async () => {
    const { prefs } = await withStorage('{"typeset":false,"shortcuts":["mod+z"]}');
    expect(prefs.shortcuts).toEqual({});
  });

  // The typesetting defaults moved out of the Inspector and into Settings, so a
  // blob written by any build before that has none of them. Absent has to mean
  // exactly what `defaultStyle()` says, or upgrading would silently change how
  // every box the user places from then on lays its text out.
  it('has no box defaults in it, and every one of them stands at the style default', async () => {
    const { prefs } = await withStorage('{"typeset":true}');
    const d = defaultStyle();
    expect(prefs.defaultAutoHeight).toBe(d.autoHeight);
    expect(prefs.defaultShape).toBe(d.shape !== 'off');
    expect(prefs.defaultBlockShape).toBe(d.shape);
    expect(prefs.defaultHyphenate).toBe(d.hyphenate);
    expect(prefs.defaultBalloon).toBe(d.balloon);
    expect(prefs.defaultMinOrphan).toBe(d.minOrphan);
  });

  it('takes stored box defaults, and refuses values of the wrong type or range', async () => {
    const a = await withStorage('{"defaultAutoHeight":false,"defaultMinOrphan":6}');
    expect(a.prefs.defaultAutoHeight).toBe(false);
    expect(a.prefs.defaultMinOrphan).toBe(6);
    // A string where a boolean belongs, and a number outside the range the
    // control offers: one is dropped, the other is clamped into it.
    const b = await withStorage('{"defaultBalloon":"yes","defaultMinOrphan":900}');
    expect(b.prefs.defaultBalloon).toBe(true);
    expect(b.prefs.defaultMinOrphan).toBe(8);
    // A block shape the control does not offer is dropped too (BRK-3).
    const c = await withStorage('{"defaultBlockShape":"rect"}');
    expect(c.prefs.defaultBlockShape).toBe('rect');
    const e = await withStorage('{"defaultBlockShape":"off"}');
    expect(e.prefs.defaultBlockShape).toBe('auto');
  });
});

describe('a tags blob from the last release', () => {
  // Tags still persist an outline as one colour and one width - that half of the
  // format has not moved, and this is the fixture that says so.
  const ERA2_TAGS = `{"list":[
    {"name":"shout","font":"Bangers","outline":"#ff0000","outlineWidth":6},
    {"name":"whisper","font":null,"outline":null,"outlineWidth":null}
  ]}`;

  it('loads, and a tag’s outline reaches a style as the style’s stroke list', async () => {
    const tags = await import('./tags.svelte.js');
    tags.bindTags(ERA2_TAGS);
    expect(tags.tags.list.map((t) => t.name)).toEqual(['shout', 'whisper']);
    const base = normalizeStyle(JSON.parse(ERA1_STYLE));
    const styled = tags.styleForLine({ n: 1, tags: ['shout'] }, base);
    expect(styled.font).toBe('Bangers');
    expect(styled.strokes).toEqual([{ color: '#ff0000', width: 6, opacity: 1 }]);
    // A tag that names nothing changes nothing.
    expect(tags.styleForLine({ n: 2, tags: ['whisper'] }, base).strokes).toEqual(base.strokes);
  });
});

// Ink is newer than any release on disk, so these are the gate: a saved project
// has no `ink` key at all, and must come back with the off default rather than
// undefined - every ink call site reads `style.ink` without guarding it.
describe('a project saved before ink existed', () => {
  it('loads a project saved before ink existed and gives it the default block', () => {
    const s = normalizeStyle({ size: 28, color: '#111111' });
    expect(s.ink).toEqual({ on: false, strokes: [] });
  });

  it('round-trips a project with ink through normalizeStyle unchanged', () => {
    const once = normalizeStyle({
      ink: { on: true, strokes: [{ size: 20, pts: [[0, 0, 1], [10, 5, 0.5]] }] },
    });
    expect(normalizeStyle(once)).toEqual(once);
  });
});

// The warp mesh is newer still, and the same gate applies twice over: every
// call site reads `style.warp.pts` without guarding it, and a `pts` array that
// does not match its own grid would have the painter reading past the end of
// the mesh mid-triangle.
describe('a project saved before the warp mesh existed', () => {
  it('loads a project saved before warp existed and gives it the default block', () => {
    const s = normalizeStyle({ size: 28, color: '#111111' });
    expect(s.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
  });

  it('gives a style that pre-dates warp a mesh the engine reads as identity', () => {
    const s = normalizeStyle(JSON.parse(ERA1_STYLE));
    expect(s.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
  });

  it('round-trips a project with a warp mesh through normalizeStyle unchanged', () => {
    const once = normalizeStyle({
      warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [0, 100], [120, 140]] },
    });
    expect(once.warp.pts).toHaveLength(4);
    expect(normalizeStyle(once)).toEqual(once);
  });

  it('resets a hand-edited mesh whose length does not match its grid', () => {
    const s = normalizeStyle({ warp: { on: true, cols: 4, rows: 4, pts: [[0, 0], [1, 1]] } });
    expect(s.warp).toEqual({ on: true, cols: 4, rows: 4, pts: [] });
  });
});

// A newborn box takes the last box's style as its starting point, but never the
// last box's own geometry: strokes drawn in one box must not appear in the next
// box the letterer places.
describe('a newborn box and the previous box\'s geometry', () => {
  it('starts with no ink, path, mask shapes or warp of its own', async () => {
    const { applyBoxDefaults } = await import('./data.js');
    const prev = normalizeStyle({
      ink: { on: true, strokes: [{ pts: [[1, 2, 0.5], [3, 4, 0.5]] }] },
      path: { on: true, pts: [[0, 0], [9, 9]] },
      warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    });
    const s = applyBoxDefaults(structuredClone(prev));
    expect(s.ink).toEqual({ on: false, strokes: [] });
    expect(s.path).toEqual({ on: false, pts: [] });
    expect(s.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
    expect(s.clip.shapes).toEqual([]);
  });
});
