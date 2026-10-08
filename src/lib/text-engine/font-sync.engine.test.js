import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../../test/rust-engine.js';
import { buildCollection, systemFaceAnswer } from '../../test/font-collection.js';
import { createFontSync } from './font-sync.js';

// ===========================================================================
// The font sync on the real engine, with the fixture fonts
// ===========================================================================
// font-sync.test.js pins the sync's decisions on a stand-in. Here the same
// code hands real font files to the real adapter: that a face registered
// through it measures as that font, that a collection's faces are picked by
// index and held once, and that a name the machine does not have is measured
// in the last resort and nowhere else.

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const oblique = fixtureFont('DejaVuSans-Oblique.ttf');

const SIZE = 26;
const face = (name, extra = {}) => ({ key: `${extra.italic ? 'italic ' : ''}${extra.bold ? 700 : 400} ${SIZE}px ${name}`, name, bold: false, italic: false, size: SIZE, css: name, ...extra });
const sysEntry = (name, slots) => ({ name, system: true, faces: Object.fromEntries(slots.map((s) => [s, { file: null }])) });

// What each fixture measures on its own, from an engine that holds nothing else.
let alone;
beforeAll(async () => {
  const e = await rustEngine({ fixtures: false });
  e.addFace('Comic Neue', 'regular', comic);
  e.addFace('Bangers', 'regular', bangers);
  e.addFace('DejaVu Sans', 'regular', dejavu);
  e.addFace('DejaVu Sans', 'italic', oblique);
  alone = {
    comic: e.advance(face('Comic Neue'), 'WAVE'),
    bangers: e.advance(face('Bangers'), 'WAVE'),
    dejavu: e.advance(face('DejaVu Sans'), 'WAVE'),
    oblique: e.advance(face('DejaVu Sans', { italic: true }), 'WAVE'),
    box: e.fontBox(face('DejaVu Sans')),
  };
  expect(new Set([alone.comic, alone.bangers, alone.dejavu]).size).toBe(3);
});

let engine;
beforeEach(async () => {
  engine = await rustEngine({ fixtures: false });
});

// The native side, serving the fixtures as this machine's installed fonts.
function native(files) {
  const calls = [];
  const systemFace = async (family, slot) => {
    calls.push(`${family}/${slot}`);
    const file = (files[family] ?? []).find((f) => slot in f.slots);
    if (!file) throw new Error(`no font called '${family}' is installed on this computer`);
    return systemFaceAnswer(file.slots, file.bytes);
  };
  return { calls, systemFace };
}

describe('the adapter’s collection faces', () => {
  it('picks a face of a collection by its index', () => {
    const ttc = buildCollection([comic, bangers]);
    engine.addFace('First', 'regular', ttc, 0);
    engine.addFace('Second', 'regular', ttc, 1);
    expect(engine.advance(face('First'), 'WAVE')).toBe(alone.comic);
    expect(engine.advance(face('Second'), 'WAVE')).toBe(alone.bangers);
    expect(() => engine.addFace('Third', 'regular', ttc, 2)).toThrow('cannot read Third/regular');
    expect(engine.hasFamily('Third')).toBe(false);
  });

  it('registers several faces of one file, and holds the file once', () => {
    const ttc = buildCollection([comic, bangers, dejavu]);
    const held = () => engine.low.heapLive();
    const empty = held();
    engine.addFaces('Coll', ttc, [{ slot: 'regular', index: 0 }, { slot: 'bold', index: 1 }, { slot: 'italic', index: 2 }]);
    const shared = held() - empty;
    expect(engine.facesOf('Coll')).toEqual(['regular', 'bold', 'italic']);
    expect(engine.advance(face('Coll'), 'WAVE')).toBe(alone.comic);
    expect(engine.advance(face('Coll', { bold: true }), 'WAVE')).toBe(alone.bangers);
    expect(engine.advance(face('Coll', { italic: true }), 'WAVE')).toBe(alone.dejavu);
    // The same three faces, each from its own copy of the file.
    engine.removeFamily('Coll');
    const before = held();
    engine.addFace('Apart', 'regular', ttc, 0);
    engine.addFace('Apart', 'bold', ttc, 1);
    engine.addFace('Apart', 'italic', ttc, 2);
    const apart = held() - before;
    expect(shared).toBeGreaterThan(ttc.byteLength);
    expect(shared).toBeLessThan(ttc.byteLength * 1.5);
    expect(apart).toBeGreaterThan(ttc.byteLength * 2.9);
  });

  it('registers none of a collection when one index is out of range', () => {
    const ttc = buildCollection([comic, bangers]);
    expect(() => engine.addFaces('Coll', ttc, [{ slot: 'regular', index: 0 }, { slot: 'bold', index: 5 }])).toThrow('cannot read Coll');
    expect(engine.hasFamily('Coll')).toBe(false);
  });

  it('takes one face back out, and the family with its last', () => {
    engine.addFace('DejaVu Sans', 'regular', dejavu);
    engine.addFace('DejaVu Sans', 'italic', oblique);
    expect(engine.advance(face('DejaVu Sans', { italic: true }), 'WAVE')).toBe(alone.oblique);
    expect(engine.removeFace('DejaVu Sans', 'italic')).toBe(true);
    // Italic is now the regular, slanted: the upright advance.
    expect(engine.advance(face('DejaVu Sans', { italic: true }), 'WAVE')).toBe(alone.dejavu);
    expect(engine.removeFace('DejaVu Sans', 'italic')).toBe(false);
    expect(engine.removeFace('DejaVu Sans', 'regular')).toBe(true);
    expect(engine.hasFamily('DejaVu Sans')).toBe(false);
    expect(() => engine.advance(face('DejaVu Sans'), 'WAVE')).toThrow("font 'DejaVu Sans' is not registered");
  });
});

describe('the sync, on real fonts', () => {
  const linux = () => ({
    'DejaVu Sans': [{ slots: { regular: 0 }, bytes: dejavu }, { slots: { italic: 0 }, bytes: oblique }],
    'Comic Bangers': [{ slots: { regular: 0, bold: 1 }, bytes: buildCollection([comic, bangers]) }],
  });
  const installed = () => [sysEntry('Comic Bangers', ['regular', 'bold']), sysEntry('DejaVu Sans', ['regular', 'italic'])];

  function setup({ files = linux(), system = installed(), toSfnt = null } = {}) {
    const n = native(files);
    const onArrival = vi.fn();
    const sync = createFontSync({ engine, fonts: { user: [], system }, os: 'linux', systemFace: n.systemFace, toSfnt, onArrival });
    return { ...n, sync, onArrival };
  }
  // Measured the way measure.js asks once the store has resolved the name.
  const measured = (sync, name, extra) => engine.advance(face(sync.nameFor(name), extra), 'WAVE');

  it('measures a user face from the bytes it was handed', () => {
    const { sync } = setup();
    sync.setUserFace('Bangers', 'regular', bangers);
    // As IndexedDB hands a record over: an ArrayBuffer.
    sync.setUserFace('Comic Neue', 'regular', comic.buffer.slice(comic.byteOffset, comic.byteOffset + comic.byteLength));
    expect(measured(sync, 'Bangers')).toBe(alone.bangers);
    expect(measured(sync, 'Comic Neue')).toBe(alone.comic);
    sync.setUserFace('Bangers', 'regular', comic);
    expect(measured(sync, 'Bangers')).toBe(alone.comic);
  });

  it('measures a name the machine does not have in the last resort, once that has been read from disk', async () => {
    const { sync, calls } = setup();
    sync.refresh();
    expect(sync.lastResort()).toBe(null);
    await sync.settled();
    expect(sync.lastResort()).toBe('DejaVu Sans');
    // One request per file: the family's two faces are two files here.
    expect(calls).toEqual(['DejaVu Sans/regular', 'DejaVu Sans/italic']);
    for (const name of ['No Such Font', 'Bangers', 'Comic Neue']) {
      expect(sync.missing(name)).toBe(true);
      expect(measured(sync, name)).toBe(alone.dejavu);
      expect(measured(sync, name, { italic: true })).toBe(alone.oblique);
      expect(engine.fontBox(face(sync.nameFor(name)))).toEqual(alone.box);
    }
  });

  it('measures a system family as the last resort while it is read, and as itself after', async () => {
    const { sync, calls, onArrival } = setup();
    sync.refresh();
    await sync.settled();
    calls.length = 0;
    expect(sync.ready('Comic Bangers')).toBe(false);
    expect(measured(sync, 'Comic Bangers')).toBe(alone.dejavu);
    await sync.settled();
    expect(calls).toEqual(['Comic Bangers/regular']);
    expect(onArrival).toHaveBeenLastCalledWith('Comic Bangers');
    expect(sync.ready('Comic Bangers')).toBe(true);
    // Two faces of one collection, each the right one.
    expect(measured(sync, 'Comic Bangers')).toBe(alone.comic);
    expect(measured(sync, 'Comic Bangers', { bold: true })).toBe(alone.bangers);
  });

  it('looks for a letter the face lacks in the last resort, and reports what nothing has', async () => {
    const { sync } = setup();
    sync.setUserFace('Bangers', 'regular', bangers);
    // Bangers has no Greek and no kana; DejaVu Sans has Greek.
    expect(engine.missing(face('Bangers'), 'ΩこA')).toEqual([0x3a9, 0x3053]);
    const before = engine.advance(face('Bangers'), 'Ω');
    sync.refresh();
    await sync.settled();
    expect(engine.fallbacks()).toEqual(['DejaVu Sans']);
    expect(engine.missing(face('Bangers'), 'ΩこA')).toEqual([0x3053]);
    expect(engine.advance(face('Bangers'), 'Ω')).toBe(engine.advance(face('DejaVu Sans'), 'Ω'));
    expect(engine.advance(face('Bangers'), 'Ω')).not.toBe(before);
    // Letters the face has are still its own.
    expect(engine.advance(face('Bangers'), 'WAVE')).toBe(alone.bangers);
  });

  it('cannot use a compressed face without a decoder, and measures the decoded font with one', async () => {
    const woff2 = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const plain = setup();
    plain.sync.refresh();
    await plain.sync.settled();
    plain.sync.setUserFace('Webby', 'regular', woff2);
    expect(plain.sync.missing('Webby')).toBe(true);
    expect(plain.sync.whyMissing('Webby')).toBe('compressed');
    expect(measured(plain.sync, 'Webby')).toBe(alone.dejavu);

    engine = await rustEngine({ fixtures: false });
    // What the native decoder answers with: the font that was inside.
    const decoding = setup({ toSfnt: async () => bangers.buffer.slice(bangers.byteOffset, bangers.byteOffset + bangers.byteLength) });
    decoding.sync.setUserFace('Webby', 'regular', woff2);
    expect(decoding.sync.ready('Webby')).toBe(false);
    await decoding.sync.settled();
    expect(decoding.sync.missing('Webby')).toBe(false);
    expect(measured(decoding.sync, 'Webby')).toBe(alone.bangers);
  });

  it('counts a file the engine cannot parse as a missing font', async () => {
    const { sync } = setup();
    sync.refresh();
    await sync.settled();
    // The right first four bytes and nothing of a font after them.
    sync.setUserFace('Broken', 'regular', Uint8Array.from([0, 1, 0, 0, 9, 9, 9, 9]));
    expect(engine.hasFamily('Broken')).toBe(false);
    expect(sync.whyMissing('Broken')).toBe('unreadable');
    expect(measured(sync, 'Broken')).toBe(alone.dejavu);
  });

  it('leaves the engine empty when it is taken apart', async () => {
    const { sync } = setup();
    sync.setUserFace('Bangers', 'regular', bangers);
    sync.refresh();
    await sync.settled();
    sync.nameFor('Comic Bangers');
    await sync.settled();
    const full = engine.low.heapLive();
    sync.dispose();
    for (const name of ['Bangers', 'DejaVu Sans', 'Comic Bangers']) expect(engine.hasFamily(name)).toBe(false);
    expect(engine.fallbacks()).toEqual([]);
    // The bytes went with the families.
    expect(full - engine.low.heapLive()).toBeGreaterThan(bangers.byteLength + dejavu.byteLength + oblique.byteLength);
  });
});
