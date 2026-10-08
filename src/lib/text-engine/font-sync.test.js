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
    systemFace: native ? (family, slot, known) => invoke('system_font_face', { family, slot, known }) : null,
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
  // Written out byte by byte, as system_fonts.rs writes it.
  const answer = ({ version = 2, slots = [2, -1, 0, -1], id = [0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 0xff], size = 3, flags = 1, file = [9, 8, 7] } = {}) => {
    const buf = new Uint8Array(40 + file.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, version, true);
    slots.forEach((n, i) => view.setInt32(4 + i * 4, n, true));
    buf.set(id, 20);
    view.setBigUint64(28, BigInt(size), true);
    view.setUint32(36, flags, true);
    buf.set(file, 40);
    return buf.buffer;
  };

  it('is a version, four face indexes, the file’s id and length, a flag, then the file', () => {
    const { faces, file, size, bytes } = readSystemFace(answer());
    expect(faces).toEqual([{ slot: 'regular', index: 2 }, { slot: 'italic', index: 0 }]);
    expect(file).toBe('deadbeef000102ff');
    expect(size).toBe(3);
    expect([...bytes]).toEqual([9, 8, 7]);
  });
  it('is the header alone for a file the engine was said to hold', () => {
    const { faces, file, size, bytes } = readSystemFace(answer({ flags: 0, size: 70_000_000, file: [] }));
    expect(faces).toEqual([{ slot: 'regular', index: 2 }, { slot: 'italic', index: 0 }]);
    expect(file).toBe('deadbeef000102ff');
    expect(size).toBe(70_000_000);
    expect(bytes).toBe(null);
  });
  it('refuses a layout it does not know, the one before this included', () => {
    // Version 1 had no version: its first four bytes were the regular's index.
    const v1 = new Uint8Array(16 + 3);
    new DataView(v1.buffer).setInt32(4, -1, true);
    expect(() => readSystemFace(v1.buffer)).toThrow('answer of version 0, and this reads version 2');
    expect(() => readSystemFace(answer({ version: 3 }))).toThrow('answer of version 3');
  });
  it('refuses an answer that says a file follows and holds none, or not all of it', () => {
    expect(() => readSystemFace(new ArrayBuffer(0))).toThrow('empty answer');
    expect(() => readSystemFace(answer().slice(0, 30))).toThrow('empty answer');
    expect(() => readSystemFace(answer({ file: [] }))).toThrow('does not hold the file');
    expect(() => readSystemFace(answer({ size: 4 }))).toThrow('does not hold the file');
  });
});

describe('what a name resolved to', () => {
  it('is remembered for a bounded number of names, and answered the same once forgotten', async () => {
    const { engine, invoke, sync } = setup({ system: [sysEntry('Zapfino')], files: { Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }] } });
    sync.setUserFace('Anchor', 'regular', SFNT());
    sync.ready('Zapfino');
    await sync.settled();
    expect(invoke.calls).toHaveLength(1);
    // Every chapter opened brings its own font names, and most are of fonts
    // this machine has not got. A session sees a great many.
    for (let i = 0; i < 5000; i++) expect(sync.nameFor(`Font Of Chapter ${i}`)).toBe('Anchor');
    expect(sync.snapshot().resolved).toBeLessThanOrEqual(256);
    // Forgotten is not changed: the same answers, and nothing sent for twice.
    expect(sync.nameFor('Zapfino')).toBe('Zapfino');
    expect(sync.ready('Zapfino')).toBe(true);
    expect(sync.nameFor('Font Of Chapter 0')).toBe('Anchor');
    expect(sync.missing('Font Of Chapter 0')).toBe(true);
    expect(invoke.calls).toHaveLength(1);
    expect(engine.registered()).toEqual({ Anchor: ['regular'], Zapfino: ['regular'] });
  });
});

describe('user faces', () => {
  it('takes a face there are no bytes of as the user’s and unusable, and says which kind of unusable', () => {
    const { engine, sync } = setup({ system: [sysEntry('Wild Words')], files: { 'Wild Words': [{ slots: { regular: 0 }, bytes: SFNT() }] } });
    sync.setUserFace('Anchor', 'regular', SFNT());
    sync.setUserFace('Wild Words', 'regular', null);
    expect(engine.registered()).toEqual({ Anchor: ['regular'] });
    expect(sync.ready('Wild Words')).toBe(true);
    expect(sync.missing('Wild Words')).toBe(true);
    expect(sync.whyMissing('Wild Words')).toBe('unsaved');
    expect(sync.nameFor('Wild Words')).toBe('Anchor');
    // The bytes turn up after all (the file was added again): a face like any other.
    sync.setUserFace('Wild Words', 'regular', SFNT());
    expect(sync.missing('Wild Words')).toBe(false);
    expect(sync.whyMissing('Wild Words')).toBe(null);
    // And one that had bytes and now has none loses the face it had.
    sync.setUserFace('Wild Words', 'regular', null);
    expect(engine.registered()).toEqual({ Anchor: ['regular'] });
  });

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

  it('is not ready while any face of the family is still being decoded, though another is in', async () => {
    const { engine, sync, invoke, onArrival } = setup({ hold: true });
    sync.setUserFace('Webby', 'regular', SFNT());
    expect(sync.ready('Webby')).toBe(true);
    sync.setUserFace('Webby', 'bold', WOFF2());
    // The regular is in the engine and a bold box would be measured from it,
    // smeared: that is a stand-in for the face on its way, so nothing may be
    // written from it.
    expect(engine.registered()).toEqual({ Webby: ['regular'] });
    expect(sync.ready('Webby')).toBe(false);
    expect(sync.missing('Webby')).toBe(false);
    // Shown as itself meanwhile, not as the last resort: its own regular is nearer.
    expect(sync.nameFor('Webby')).toBe('Webby');
    invoke.release();
    await sync.settled();
    expect(engine.registered()).toEqual({ Webby: ['regular', 'bold'] });
    expect(sync.ready('Webby')).toBe(true);
    expect(onArrival).toHaveBeenCalledWith('Webby');
  });

  it('is ready again when the face that was on its way turns out unreadable', async () => {
    const { sync, invoke } = setup({ hold: true });
    sync.setUserFace('Webby', 'regular', SFNT());
    const bad = WOFF2();
    bad[4] = 0xff;
    sync.setUserFace('Webby', 'bold', bad);
    expect(sync.ready('Webby')).toBe(false);
    invoke.release();
    await sync.settled();
    // Finally failed is an answer too: the regular is all the family has.
    expect(sync.ready('Webby')).toBe(true);
    expect(sync.missing('Webby')).toBe(false);
    expect(sync.nameFor('Webby')).toBe('Webby');
  });

  it('keeps a user family as the last resort while another of its faces is decoded', async () => {
    const { engine, sync, invoke } = setup({ hold: true, native: true });
    sync.setUserFace('Anchor', 'regular', SFNT());
    expect(sync.lastResort()).toBe('Anchor');
    sync.setUserFace('Anchor', 'bold', WOFF2());
    // Still the family every missing name is measured in: it has a face.
    expect(sync.lastResort()).toBe('Anchor');
    expect(sync.nameFor('Nowhere')).toBe('Anchor');
    expect(engine.fallbacks()).toEqual(['Anchor']);
    invoke.release();
    await sync.settled();
    expect(sync.lastResort()).toBe('Anchor');
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
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Helvetica', slot: 'regular', known: [] }]]);
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
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Zapfino', slot: 'regular', known: [] }]]);
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
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Helvetica Neue', slot: 'regular', known: [] }]]);
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

  // Helvetica and Helvetica Neue are one `.ttc` on a Mac, and so are most CJK
  // families and their siblings. The native side names the file in each
  // answer, and the sync says which files the engine holds when it asks.
  describe('two families in one file', () => {
    const shared = () => {
      const ttc = TTC();
      return {
        'Helvetica Neue': [{ slots: { regular: 0, bold: 1 }, bytes: ttc }],
        Helvetica: [{ slots: { regular: 2 }, bytes: ttc }, { slots: { bold: 0 }, bytes: OTF() }],
      };
    };
    const both = () => [sysEntry('Helvetica', ['regular', 'bold']), sysEntry('Helvetica Neue', ['regular', 'bold'])];
    const sizes = (invoke) => invoke.answers.map((a) => a.byteLength);
    const known = (invoke) => invoke.calls.map(([, args]) => `${args.family}/${args.slot} knowing ${args.known.length}`);

    it('cross once: the second family is told the file is held, and reads the copy that is there', async () => {
      const { engine, invoke, sync } = setup({ system: both(), files: shared() });
      sync.refresh();
      await sync.settled();
      expect(sync.lastResort()).toBe('Helvetica Neue');
      expect(engine.copied).toHaveLength(1);
      sync.ready('Helvetica');
      await sync.settled();
      expect(known(invoke)).toEqual(['Helvetica Neue/regular knowing 0', 'Helvetica/regular knowing 1', 'Helvetica/bold knowing 1']);
      // The collection came once; the second answer about it is a header.
      expect(sizes(invoke)).toEqual([40 + 8, 40, 40 + 8]);
      expect(engine.copied).toHaveLength(2);
      expect(engine.registered()).toEqual({ 'Helvetica Neue': ['regular', 'bold'], Helvetica: ['regular', 'bold'] });
      const neue = engine.families.get('Helvetica Neue');
      const plain = engine.families.get('Helvetica');
      expect(plain.regular.file).toBe(neue.regular.file);
      expect(plain.regular.index).toBe(2);
      expect(plain.bold.file).not.toBe(neue.regular.file);
      expect(sync.ready('Helvetica')).toBe(true);
    });

    it('keep the file until the last of them is gone', async () => {
      const t = setup({ system: both(), files: shared() });
      t.sync.refresh();
      t.sync.ready('Helvetica');
      await t.sync.settled();
      const [ttc] = t.engine.files();
      expect(t.engine.files()).toHaveLength(2);
      t.fonts.system = [sysEntry('Helvetica', ['regular', 'bold'])];
      t.sync.refresh();
      expect(t.engine.registered()).toEqual({ Helvetica: ['regular', 'bold'] });
      expect(t.engine.hasFile(ttc)).toBe(true);
      t.fonts.system = [];
      t.sync.refresh();
      expect(t.engine.files()).toEqual([]);
    });

    it('asked for at the same moment both get the file, and the engine keeps one copy', async () => {
      const { engine, invoke, sync } = setup({ system: both(), files: shared(), hold: true });
      sync.refresh();
      sync.ready('Helvetica');
      await vi.waitFor(() => expect(invoke.calls).toHaveLength(2));
      invoke.release();
      await vi.waitFor(() => expect(invoke.calls).toHaveLength(3));
      invoke.release();
      await sync.settled();
      expect(sizes(invoke)).toEqual([40 + 8, 40 + 8, 40 + 8]);
      // Three files crossed, two were taken in: the collection once.
      expect(engine.copied).toHaveLength(2);
      expect(engine.files()).toHaveLength(2);
      expect(engine.families.get('Helvetica').regular.file).toBe(engine.families.get('Helvetica Neue').regular.file);
    });

    it('send for the file after all when the family it was held for went meanwhile', async () => {
      const t = setup({ system: both(), files: shared(), hold: true });
      t.sync.refresh();
      await vi.waitFor(() => expect(t.invoke.calls).toHaveLength(1));
      t.invoke.release();
      await t.sync.settled();
      t.invoke.calls.length = 0;
      t.invoke.answers.length = 0;

      t.sync.ready('Helvetica');
      await vi.waitFor(() => expect(t.invoke.calls).toHaveLength(1));
      // Helvetica Neue is uninstalled while Helvetica's answer is on its way.
      t.fonts.system = [sysEntry('Helvetica', ['regular', 'bold'])];
      t.sync.refresh();
      expect(t.engine.files()).toEqual([]);
      for (const calls of [2, 3]) {
        t.invoke.release();
        await vi.waitFor(() => expect(t.invoke.calls).toHaveLength(calls));
      }
      t.invoke.release();
      await t.sync.settled();
      expect(known(t.invoke)).toEqual(['Helvetica/regular knowing 1', 'Helvetica/bold knowing 0', 'Helvetica/regular knowing 0']);
      expect(sizes(t.invoke)).toEqual([40, 40 + 8, 40 + 8]);
      expect(t.engine.registered()).toEqual({ Helvetica: ['regular', 'bold'] });
      expect(t.sync.ready('Helvetica')).toBe(true);
      expect(t.sync.missing('Helvetica')).toBe(false);
    });

    it('read again after one of its files moved, a family is not sent the file that did not', async () => {
      const files = shared();
      const stamped = (stamp) => [{ ...sysEntry('Helvetica', ['regular', 'bold']), stamp }, { ...sysEntry('Helvetica Neue', ['regular', 'bold']), stamp: 'same' }];
      const t = setup({ system: stamped('one'), files });
      t.sync.refresh();
      t.sync.ready('Helvetica');
      await t.sync.settled();
      t.invoke.calls.length = 0;
      t.invoke.answers.length = 0;
      // Helvetica's bold, the file of its own, was updated.
      files.Helvetica[1] = { slots: { bold: 0 }, bytes: OTF() };
      t.fonts.system = stamped('two');
      t.sync.refresh();
      t.sync.ready('Helvetica');
      await t.sync.settled();
      expect(known(t.invoke)).toEqual(['Helvetica/regular knowing 2', 'Helvetica/bold knowing 2']);
      expect(sizes(t.invoke)).toEqual([40, 40 + 8]);
      expect(t.engine.registered().Helvetica).toEqual(['regular', 'bold']);
      // The collection, the old bold, the new bold.
      expect(t.engine.copied).toHaveLength(3);
      expect(t.engine.files()).toHaveLength(2);
    });

    it('read again, a family keeps its own file through the change though nobody else holds it', async () => {
      // The file is held by nobody else: the family's own old faces keep it
      // while the new ones are made beside them.
      const ttc = TTC();
      const files = { Zapfino: [{ slots: { regular: 0 }, bytes: ttc }] };
      const t = setup({ system: [{ ...sysEntry('Zapfino'), stamp: 'one' }], files });
      t.sync.ready('Zapfino');
      await t.sync.settled();
      files.Zapfino = [{ slots: { regular: 0, bold: 1 }, bytes: ttc }];
      t.fonts.system = [{ ...sysEntry('Zapfino', ['regular', 'bold']), stamp: 'one' }];
      t.sync.refresh();
      t.sync.ready('Zapfino');
      await t.sync.settled();
      expect(sizes(t.invoke)).toEqual([40 + 8, 40]);
      expect(t.engine.copied).toHaveLength(1);
      expect(t.engine.registered().Zapfino).toEqual(['regular', 'bold']);
      expect(t.engine.files()).toHaveLength(1);
    });
  });

  describe('after another scan', () => {
    // Fonts that differ in what follows the tag: the native stand-in copies
    // the bytes into its answer, so which file the engine holds is told by content.
    const font = (fill) => Uint8Array.from([0, 1, 0, 0, fill, fill, fill, fill]);
    const held = (t, family, slot) => [...t.engine.families.get(family)[slot].file];
    const listed = (stamps = {}) => [
      { ...sysEntry('Helvetica Neue', ['regular', 'bold']), stamp: stamps['Helvetica Neue'] ?? 'aaaa' },
      { ...sysEntry('Zapfino'), stamp: stamps.Zapfino ?? 'bbbb' },
    ];
    async function loaded({ hold = false } = {}) {
      const files = { 'Helvetica Neue': [{ slots: { regular: 0, bold: 1 }, bytes: font(1) }], Zapfino: [{ slots: { regular: 0 }, bytes: font(2) }] };
      const t = setup({ system: listed(), files, hold });
      t.files = files;
      t.sync.refresh();
      expect(t.sync.ready('Zapfino')).toBe(false);
      await vi.waitFor(() => expect(t.invoke.calls).toHaveLength(2));
      t.invoke.release();
      await t.sync.settled();
      expect(t.engine.registered()).toEqual({ 'Helvetica Neue': ['regular', 'bold'], Zapfino: ['regular'] });
      t.invoke.calls.length = 0;
      t.onArrival.mockClear();
      return t;
    }
    const rescan = (t, list) => {
      t.fonts.system = list;
      t.sync.refresh();
    };

    it('leaves alone a family whose files are as they were', async () => {
      const t = await loaded();
      rescan(t, listed());
      expect(t.sync.ready('Zapfino')).toBe(true);
      expect(t.sync.nameFor('Zapfino')).toBe('Zapfino');
      expect(t.sync.ready('Helvetica Neue')).toBe(true);
      await t.sync.settled();
      expect(t.invoke.calls).toEqual([]);
    });

    it('sends again for a family that has a face it did not have', async () => {
      const t = await loaded();
      // A bold was installed: the engine has been smearing one from the regular.
      t.files.Zapfino.push({ slots: { bold: 0 }, bytes: font(3) });
      rescan(t, [listed()[0], { ...sysEntry('Zapfino', ['regular', 'bold']), stamp: 'bbbb' }]);
      // Not sent for until somebody asks about it.
      expect(t.invoke.calls).toEqual([]);
      expect(t.sync.ready('Zapfino')).toBe(false);
      // Shown as itself meanwhile, in what the engine has of it.
      expect(t.sync.nameFor('Zapfino')).toBe('Zapfino');
      await t.sync.settled();
      expect(t.invoke.calls.map(([, args]) => `${args.family}/${args.slot}`)).toEqual(['Zapfino/regular', 'Zapfino/bold']);
      expect(t.engine.registered().Zapfino).toEqual(['regular', 'bold']);
      expect(held(t, 'Zapfino', 'bold')).toEqual([...font(3)]);
      expect(t.sync.ready('Zapfino')).toBe(true);
      expect(t.onArrival).toHaveBeenCalledWith('Zapfino');
    });

    it('sends again for a family whose file was replaced where it is, which only the stamp shows', async () => {
      const t = await loaded();
      t.files.Zapfino = [{ slots: { regular: 0 }, bytes: font(4) }];
      rescan(t, listed({ Zapfino: 'cccc' }));
      expect(t.sync.ready('Zapfino')).toBe(false);
      expect(held(t, 'Zapfino', 'regular')).toEqual([...font(2)]);
      await t.sync.settled();
      expect(held(t, 'Zapfino', 'regular')).toEqual([...font(4)]);
      // And nobody else was read again.
      expect(t.invoke.calls.map(([, args]) => args.family)).toEqual(['Zapfino']);
    });

    it('drops a face the family no longer has', async () => {
      const t = await loaded();
      t.files['Helvetica Neue'] = [{ slots: { regular: 0 }, bytes: font(5) }];
      rescan(t, [{ ...sysEntry('Helvetica Neue', ['regular']), stamp: 'dddd' }, listed()[1]]);
      await t.sync.settled();
      expect(t.engine.registered()['Helvetica Neue']).toEqual(['regular']);
    });

    it('reads the last resort again though no box names it, and measures in its old bytes until the new ones are in', async () => {
      const t = await loaded({ hold: true });
      expect(t.sync.lastResort()).toBe('Helvetica Neue');
      t.files['Helvetica Neue'] = [{ slots: { regular: 0, bold: 1 }, bytes: font(6) }];
      rescan(t, listed({ 'Helvetica Neue': 'eeee' }));
      await vi.waitFor(() => expect(t.invoke.calls).toHaveLength(1));
      // Being read again, and still what every missing name is measured in.
      expect(t.sync.ready('Helvetica Neue')).toBe(false);
      expect(t.sync.lastResort()).toBe('Helvetica Neue');
      expect(t.sync.nameFor('Nowhere')).toBe('Helvetica Neue');
      expect(held(t, 'Helvetica Neue', 'regular')).toEqual([...font(1)]);
      t.invoke.release();
      await t.sync.settled();
      expect(held(t, 'Helvetica Neue', 'regular')).toEqual([...font(6)]);
      expect(t.sync.lastResort()).toBe('Helvetica Neue');
      expect(t.sync.ready('Helvetica Neue')).toBe(true);
    });

    it('takes out what it had of a family whose new files cannot be read', async () => {
      const t = await loaded();
      delete t.files.Zapfino;
      rescan(t, listed({ Zapfino: 'ffff' }));
      t.sync.ready('Zapfino');
      await t.sync.settled();
      expect(t.engine.registered().Zapfino).toBeUndefined();
      expect(t.sync.missing('Zapfino')).toBe(true);
      expect(t.sync.nameFor('Zapfino')).toBe('Helvetica Neue');
    });

    it('takes out a family that moved and was then uninstalled before anybody asked', async () => {
      const t = await loaded();
      rescan(t, listed({ Zapfino: 'cccc' }));
      rescan(t, [listed()[0]]);
      expect(t.engine.registered().Zapfino).toBeUndefined();
      expect(t.sync.missing('Zapfino')).toBe(true);
    });

    it('leaves nothing in the engine when it is disposed with a family waiting to be read again', async () => {
      const t = await loaded();
      rescan(t, listed({ Zapfino: 'cccc' }));
      t.sync.dispose();
      expect(t.engine.registered()).toEqual({});
    });
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
