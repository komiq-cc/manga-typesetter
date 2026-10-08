import { describe, it, expect, vi } from 'vitest';
import { createFontSync, fontKind, readSystemFace } from './font-sync.js';
import { fakeRustEngine, fakeNative, SFNT, OTF, TTC, WOFF2, CORRUPT } from '../../test/fake-rust-engine.js';

// The sync on a stand-in engine and a stand-in native side: which family a
// name is measured as, when, and what the engine holds for it. The same code
// against the real engine is font-sync.engine.test.js.

const sysEntry = (name, slots = ['regular']) => ({ name, system: true, faces: Object.fromEntries(slots.map((s) => [s, { file: null }])) });

function setup({ system = [], files = {}, os = 'macos', native = true, hold = false } = {}) {
  const engine = fakeRustEngine();
  const fonts = { user: [], system };
  const invoke = fakeNative(files, { hold });
  const onArrival = vi.fn();
  const sync = createFontSync({
    engine,
    fonts,
    os,
    systemFace: native ? (family, slot) => invoke('system_font_face', { family, slot }) : null,
    toSfnt: native ? (bytes) => invoke('font_to_sfnt', bytes) : null,
    onArrival,
  });
  return { engine, fonts, invoke, onArrival, sync };
}

describe('what a font file is', () => {
  it('reads the kind off the first four bytes', () => {
    expect(fontKind(SFNT())).toBe('sfnt');
    expect(fontKind(OTF())).toBe('sfnt');
    expect(fontKind(Uint8Array.from([0x74, 0x72, 0x75, 0x65]))).toBe('sfnt');
    expect(fontKind(TTC())).toBe('collection');
    expect(fontKind(WOFF2())).toBe('woff2');
    expect(fontKind(Uint8Array.from([0x77, 0x4f, 0x46, 0x46, 0]))).toBe('woff');
    expect(fontKind(Uint8Array.from([1, 2, 3, 4]))).toBe('unknown');
    expect(fontKind(new Uint8Array(2))).toBe('unknown');
  });
});

describe('the answer of the system face command', () => {
  it('is four face indexes, one per slot, then the file', () => {
    const buf = new Uint8Array(16 + 3);
    const view = new DataView(buf.buffer);
    [2, -1, 0, -1].forEach((n, i) => view.setInt32(i * 4, n, true));
    buf.set([9, 8, 7], 16);
    const { faces, bytes } = readSystemFace(buf.buffer);
    expect(faces).toEqual([{ slot: 'regular', index: 2 }, { slot: 'italic', index: 0 }]);
    expect([...bytes]).toEqual([9, 8, 7]);
  });
  it('refuses an answer with no file in it', () => {
    expect(() => readSystemFace(new ArrayBuffer(16))).toThrow('empty answer');
  });
});

describe('user faces', () => {
  it('registers a face under its family and slot, as the bytes are', () => {
    const { engine, sync } = setup();
    const regular = SFNT();
    const bold = OTF();
    sync.setUserFace('Wild Words', 'regular', regular);
    sync.setUserFace('Wild Words', 'bold', bold.buffer);
    expect(engine.registered()).toEqual({ 'Wild Words': ['regular', 'bold'] });
    expect(engine.families.get('Wild Words').regular.file).toBe(regular);
    expect(sync.nameFor('Wild Words')).toBe('Wild Words');
    expect(sync.ready('Wild Words')).toBe(true);
    expect(sync.missing('Wild Words')).toBe(false);
  });

  it('replaces the face in a slot, and takes one face or the whole family back out', () => {
    const { engine, sync } = setup();
    const first = SFNT();
    const second = SFNT();
    sync.setUserFace('Wild Words', 'regular', first);
    sync.setUserFace('Wild Words', 'italic', SFNT());
    sync.setUserFace('Wild Words', 'regular', second);
    expect(engine.families.get('Wild Words').regular.file).toBe(second);
    sync.removeUserFace('Wild Words', 'italic');
    expect(engine.registered()).toEqual({ 'Wild Words': ['regular'] });
    sync.removeUserFace('Wild Words', 'regular');
    expect(engine.registered()).toEqual({});
    expect(sync.missing('Wild Words')).toBe(true);
    sync.setUserFace('Anime Ace', 'regular', SFNT());
    sync.setUserFace('Anime Ace', 'bold', SFNT());
    sync.removeUserFamily('Anime Ace');
    expect(engine.registered()).toEqual({});
  });

  it('registers the first face of a collection the user dropped', () => {
    const { engine, sync } = setup();
    sync.setUserFace('Gothic', 'regular', TTC());
    expect(engine.families.get('Gothic').regular.index).toBe(0);
  });

  it('counts a file the engine cannot read as no face at all', () => {
    const { engine, sync } = setup();
    sync.setUserFace('Broken', 'regular', CORRUPT());
    expect(engine.registered()).toEqual({});
    expect(sync.missing('Broken')).toBe(true);
    expect(sync.whyMissing('Broken')).toBe('unreadable');
    // And a good face that a bad file replaced is gone with it: the user's
    // slot no longer holds the file the engine had.
    sync.setUserFace('Wild Words', 'regular', SFNT());
    sync.setUserFace('Wild Words', 'regular', CORRUPT());
    expect(engine.registered()).toEqual({});
  });

  it('decodes a WOFF2 face natively, and the family is on its way until it is', async () => {
    const { engine, sync, invoke, onArrival } = setup({ hold: true });
    sync.setUserFace('Webby', 'regular', WOFF2());
    expect(invoke.calls).toEqual([['font_to_sfnt', 'bytes']]);
    expect(engine.registered()).toEqual({});
    expect(sync.ready('Webby')).toBe(false);
    expect(sync.missing('Webby')).toBe(false);
    invoke.release();
    await sync.settled();
    expect(engine.registered()).toEqual({ Webby: ['regular'] });
    // What went into the engine is the decoded font, not the WOFF2.
    expect(fontKind(engine.families.get('Webby').regular.file)).toBe('sfnt');
    expect(sync.ready('Webby')).toBe(true);
    expect(sync.nameFor('Webby')).toBe('Webby');
    expect(onArrival).toHaveBeenCalledWith('Webby');
  });

  it('reports a compressed face as missing where nothing can decode it', async () => {
    const { engine, sync, invoke } = setup({ native: false });
    sync.setUserFace('Webby', 'regular', WOFF2());
    await sync.settled();
    expect(invoke.calls).toEqual([]);
    expect(engine.registered()).toEqual({});
    expect(sync.ready('Webby')).toBe(true);
    expect(sync.missing('Webby')).toBe(true);
    expect(sync.whyMissing('Webby')).toBe('compressed');
    // Its real face beside it is enough for the family to be measured as itself.
    sync.setUserFace('Webby', 'bold', SFNT());
    expect(sync.missing('Webby')).toBe(false);
    expect(sync.nameFor('Webby')).toBe('Webby');
  });

  it('drops a decode that finishes after its face was replaced or removed', async () => {
    const { engine, sync, invoke, onArrival } = setup({ hold: true });
    sync.setUserFace('Webby', 'regular', WOFF2());
    const real = SFNT();
    sync.setUserFace('Webby', 'regular', real);
    sync.setUserFace('Gone', 'regular', WOFF2());
    sync.removeUserFamily('Gone');
    invoke.release();
    await sync.settled();
    expect(engine.families.get('Webby').regular.file).toBe(real);
    expect(engine.registered()).toEqual({ Webby: ['regular'] });
    expect(onArrival).not.toHaveBeenCalled();
  });

  it('says a decode that failed is unreadable', async () => {
    const { sync, onArrival } = setup();
    const bad = WOFF2();
    bad[4] = 0xff;
    sync.setUserFace('Webby', 'regular', bad);
    await sync.settled();
    expect(sync.missing('Webby')).toBe(true);
    expect(sync.whyMissing('Webby')).toBe('unreadable');
    expect(onArrival).toHaveBeenCalledWith('Webby');
  });
});

describe('system faces', () => {
  const helvetica = () => ({ 'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 4 }, bytes: TTC() }] });

  it('are not sent for until a name is asked about, the last resort aside', async () => {
    const { invoke, sync } = setup({
      system: [sysEntry('Helvetica'), sysEntry('Zapfino')],
      files: { Helvetica: [{ slots: { regular: 0 }, bytes: SFNT() }], Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }] },
    });
    sync.refresh();
    await sync.settled();
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Helvetica', slot: 'regular' }]]);
  });

  it('are sent for on the first question, and the family is not ready until they are in', async () => {
    const { engine, invoke, onArrival, sync } = setup({
      system: [sysEntry('Zapfino')],
      files: { Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }] },
      hold: true,
    });
    expect(sync.ready('Zapfino')).toBe(false);
    expect(sync.missing('Zapfino')).toBe(false);
    // Asked again, by every box set in it: one request.
    sync.ready('Zapfino');
    sync.nameFor('Zapfino');
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Zapfino', slot: 'regular' }]]);
    expect(engine.registered()).toEqual({});
    invoke.release();
    await sync.settled();
    expect(engine.registered()).toEqual({ Zapfino: ['regular'] });
    expect(sync.ready('Zapfino')).toBe(true);
    expect(sync.nameFor('Zapfino')).toBe('Zapfino');
    expect(onArrival).toHaveBeenCalledTimes(1);
    expect(onArrival).toHaveBeenCalledWith('Zapfino');
  });

  it('brings a collection across once, and its faces share the one copy', async () => {
    const { engine, invoke, sync } = setup({ system: [sysEntry('Helvetica Neue', ['regular', 'bold', 'italic', 'boldItalic'])], files: helvetica() });
    sync.ready('Helvetica Neue');
    await sync.settled();
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Helvetica Neue', slot: 'regular' }]]);
    const fam = engine.families.get('Helvetica Neue');
    expect(Object.fromEntries(Object.entries(fam).map(([slot, f]) => [slot, f.index]))).toEqual({ regular: 0, bold: 1, italic: 2, boldItalic: 4 });
    expect(new Set(Object.values(fam).map((f) => f.file)).size).toBe(1);
  });

  it('asks again for a slot that lives in another file', async () => {
    const { engine, invoke, sync } = setup({
      system: [sysEntry('Arial', ['regular', 'bold'])],
      files: { Arial: [{ slots: { regular: 0 }, bytes: SFNT() }, { slots: { bold: 0 }, bytes: SFNT() }] },
    });
    sync.ready('Arial');
    await sync.settled();
    expect(invoke.calls.map((c) => c[1].slot)).toEqual(['regular', 'bold']);
    expect(engine.registered()).toEqual({ Arial: ['regular', 'bold'] });
  });

  it('puts none of a family in the engine while one of its files is still on the way', async () => {
    const files = { Arial: [{ slots: { regular: 0 }, bytes: SFNT() }, { slots: { bold: 0 }, bytes: CORRUPT() }] };
    const { engine, sync } = setup({ system: [sysEntry('Arial', ['regular', 'bold'])], files });
    sync.ready('Arial');
    await sync.settled();
    // The second file was unreadable: the family is not half there.
    expect(engine.registered()).toEqual({});
    expect(sync.missing('Arial')).toBe(true);
    expect(sync.whyMissing('Arial')).toBe('unreadable');
  });

  it('counts a family whose bytes cannot be read as missing, and tells whoever is waiting', async () => {
    const { sync, onArrival } = setup({ system: [sysEntry('Ghost')] });
    expect(sync.ready('Ghost')).toBe(false);
    await sync.settled();
    expect(sync.ready('Ghost')).toBe(true);
    expect(sync.missing('Ghost')).toBe(true);
    expect(onArrival).toHaveBeenCalledWith('Ghost');
  });

  it('drops a family the next scan no longer lists, and tries a failed one again', async () => {
    const files = { Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }] };
    const { engine, fonts, invoke, sync } = setup({ system: [sysEntry('Zapfino'), sysEntry('Ghost')], files });
    sync.ready('Zapfino');
    sync.ready('Ghost');
    await sync.settled();
    expect(engine.registered()).toEqual({ Zapfino: ['regular'] });
    files.Ghost = [{ slots: { regular: 0 }, bytes: SFNT() }];
    fonts.system = [sysEntry('Ghost')];
    sync.refresh();
    expect(engine.registered()).toEqual({});
    expect(sync.missing('Zapfino')).toBe(true);
    expect(sync.ready('Ghost')).toBe(false);
    await sync.settled();
    expect(sync.nameFor('Ghost')).toBe('Ghost');
    expect(invoke.calls.filter((c) => c[1].family === 'Ghost')).toHaveLength(2);
  });

  it('gives the name to the user’s own family when both have it', async () => {
    const { engine, sync, invoke } = setup({ system: [sysEntry('Arial')], files: { Arial: [{ slots: { regular: 0 }, bytes: SFNT() }] }, hold: true });
    sync.ready('Arial');
    const mine = SFNT();
    sync.setUserFace('Arial', 'bold', mine);
    invoke.release();
    await sync.settled();
    // The system file that was on its way does not land on top of the user's.
    expect(engine.registered()).toEqual({ Arial: ['bold'] });
    expect(engine.families.get('Arial').bold.file).toBe(mine);
    // And when the user's goes, the system family is asked for afresh.
    sync.removeUserFamily('Arial');
    expect(sync.ready('Arial')).toBe(false);
    invoke.release();
    await sync.settled();
    expect(engine.registered()).toEqual({ Arial: ['regular'] });
  });

  it('has no system fonts where there is no native side', () => {
    const { sync, invoke } = setup({ system: [sysEntry('Arial')], native: false });
    expect(sync.ready('Arial')).toBe(true);
    expect(sync.missing('Arial')).toBe(true);
    expect(invoke.calls).toEqual([]);
  });
});

describe('a family the machine does not have', () => {
  const mac = () => ({
    system: [sysEntry('Arial'), sysEntry('Helvetica'), sysEntry('Zapfino')],
    files: { Helvetica: [{ slots: { regular: 0 }, bytes: SFNT() }], Arial: [{ slots: { regular: 0 }, bytes: SFNT() }] },
  });

  it('is measured as the last resort of the OS, once that is in the engine', async () => {
    const { engine, sync, invoke } = setup({ ...mac(), hold: true });
    sync.refresh();
    // On its way: there is nothing yet to measure a missing name in.
    expect(sync.lastResort()).toBe(null);
    expect(sync.nameFor('No Such Font')).toBe(null);
    invoke.release();
    await sync.settled();
    expect(sync.lastResort()).toBe('Helvetica');
    expect(engine.fallbacks()).toEqual(['Helvetica']);
    for (const name of ['No Such Font', 'Bangers', 'Comic Neue']) {
      expect(sync.nameFor(name)).toBe('Helvetica');
      expect(sync.missing(name)).toBe(true);
      expect(sync.ready(name)).toBe(true);
      expect(sync.whyMissing(name)).toBe('absent');
    }
    expect(sync.whyMissing('Helvetica')).toBe(null);
  });

  it('is measured as the next of the list when the first cannot be read', async () => {
    const { sync } = setup({ ...mac(), files: { Arial: [{ slots: { regular: 0 }, bytes: SFNT() }] } });
    sync.refresh();
    await sync.settled();
    expect(sync.lastResort()).toBe('Arial');
  });

  it('is measured as the user’s first family where there are no system fonts', () => {
    const { engine, sync } = setup({ native: false });
    expect(sync.lastResort()).toBe(null);
    sync.setUserFace('Wild Words', 'regular', SFNT());
    sync.setUserFace('Anime Ace', 'regular', SFNT());
    expect(sync.lastResort()).toBe('Anime Ace');
    expect(sync.nameFor('Bangers')).toBe('Anime Ace');
    expect(engine.fallbacks()).toEqual(['Anime Ace']);
    sync.removeUserFamily('Anime Ace');
    expect(sync.lastResort()).toBe('Wild Words');
    expect(sync.nameFor('Bangers')).toBe('Wild Words');
    sync.removeUserFamily('Wild Words');
    expect(sync.lastResort()).toBe(null);
    expect(sync.nameFor('Bangers')).toBe(null);
    expect(engine.fallbacks()).toEqual([]);
  });

  it('is measured as the last resort while its own face is on the way, and as itself after', async () => {
    const { sync, invoke } = setup({ ...mac(), files: { ...mac().files, Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }] } });
    sync.refresh();
    await sync.settled();
    expect(sync.nameFor('Zapfino')).toBe('Helvetica');
    expect(sync.ready('Zapfino')).toBe(false);
    await sync.settled();
    expect(sync.nameFor('Zapfino')).toBe('Zapfino');
    expect(invoke.calls.map((c) => c[1].family)).toEqual(['Helvetica', 'Zapfino']);
  });

  it('never names a family the engine does not hold', async () => {
    const { engine, sync } = setup({ ...mac() });
    sync.setUserFace('Wild Words', 'regular', SFNT());
    sync.setUserFace('Webby', 'regular', CORRUPT());
    sync.refresh();
    const names = ['Wild Words', 'Webby', 'Zapfino', 'Helvetica', 'Arial', 'Bangers', 'nope', ''];
    const check = () => {
      for (const name of names) {
        const family = sync.nameFor(name);
        if (family !== null) expect(engine.hasFamily(family)).toBe(true);
      }
    };
    check();
    await sync.settled();
    check();
    sync.removeUserFamily('Wild Words');
    check();
  });
});

describe('taking it all back', () => {
  it('leaves the engine empty and ignores what lands afterwards', async () => {
    const { engine, sync, invoke, onArrival } = setup({
      system: [sysEntry('Helvetica')],
      files: { Helvetica: [{ slots: { regular: 0 }, bytes: SFNT() }] },
      hold: true,
    });
    sync.setUserFace('Wild Words', 'regular', SFNT());
    sync.setUserFace('Webby', 'regular', WOFF2());
    sync.refresh();
    sync.dispose();
    invoke.release();
    await sync.settled();
    expect(engine.registered()).toEqual({});
    expect(engine.fallbacks()).toEqual([]);
    expect(onArrival).not.toHaveBeenCalled();
  });
});
