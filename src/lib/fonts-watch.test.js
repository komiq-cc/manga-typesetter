import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// What fonts.js offers whoever keeps a second copy of the user's faces in step
// (the Rust text engine, through engine-switch.svelte.js): the watcher it
// tells, the bytes of what is already loaded, and the promise that says the
// boot restore and scan are over. IndexedDB is a small stand-in
// (src/test/fake-indexeddb.js); the module is loaded fresh for each case
// because it keeps its connection.

const SFNT = (fill) => Uint8Array.from([0, 1, 0, 0, fill, fill]).buffer;
const fontFile = (name, buffer) => ({ name, arrayBuffer: async () => buffer });

// "Nothing is kept" is a statement about memory, so it is asked of the
// collector and not of the module: a file whose bytes are made when it is read
// and that the test itself holds only weakly. `held()` is whether anything
// still reaches them after a collection. The collector is switched on here,
// for this file, the way Node allows it at run time.
v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');
function weakFile(name, fill) {
  let ref = null;
  return {
    name,
    arrayBuffer: async () => {
      const bytes = SFNT(fill);
      ref = new WeakRef(bytes);
      return bytes;
    },
    // A WeakRef keeps its target for the rest of the turn it was read in.
    held: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collect();
      return ref?.deref() !== undefined;
    },
  };
}

let idb;
let fonts;
let store;
beforeEach(async () => {
  vi.resetModules();
  idb = fakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  // No canvas: the store then measures with its stand-ins, as in any unit test.
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} }, createElement: () => ({ getContext: () => null }) });
  store = await import('./store.svelte.js');
  fonts = await import('./fonts.js');
});
afterEach(() => vi.unstubAllGlobals());

function watcher() {
  const said = [];
  fonts.watchUserFaces({
    added: (family, slot, bytes) => said.push(['added', family, slot, new Uint8Array(bytes)[4]]),
    removed: (family, slot) => said.push(['removed', family, slot]),
    removedFamily: (family) => said.push(['removedFamily', family]),
    scanned: () => said.push(['scanned']),
  });
  return said;
}

describe('whoever watches the user’s faces', () => {
  it('is told of each one with its bytes, before the layout that follows', async () => {
    const said = watcher();
    const version = store.app.fontsVersion;
    const at = [];
    fonts.watchUserFaces({ added: (family) => at.push([family, store.app.fontsVersion - version]), removed() {}, removedFamily() {} });
    await fonts.addFontFile(fontFile('WildWords.ttf', SFNT(1)));
    expect(at).toEqual([['WildWords', 0]]);
    expect(store.app.fontsVersion).toBe(version + 1);
    expect(said).toEqual([]);
  });

  it('hears of a restore, an add, a package install, a replacement and both removals', async () => {
    const said = watcher();
    await fonts._restoreFontRecords([{ name: 'Restored', slot: 'bold', file: 'r.ttf', data: SFNT(1) }]);
    await fonts.addFontFile(fontFile('Added-Italic.ttf', SFNT(2)));
    await fonts.installFontFace({ family: 'Packed', slot: 'regular', file: 'p.ttf', data: new Uint8Array(SFNT(3)) });
    await fonts.addFontFile(fontFile('Added-v2.ttf', SFNT(4)), { family: 'Added', slot: 'italic' });
    await fonts.removeFontFace('Restored', 'bold');
    await fonts.removeUserFont('Packed');
    expect(said).toEqual([
      ['added', 'Restored', 'bold', 1],
      ['added', 'Added', 'italic', 2],
      ['added', 'Packed', 'regular', 3],
      ['added', 'Added', 'italic', 4],
      ['removed', 'Restored', 'bold'],
      ['removedFamily', 'Packed'],
    ]);
  });

  it('is told nothing once it stops watching, and nothing is kept for it', async () => {
    const said = watcher();
    fonts.watchUserFaces(null);
    const file = weakFile('WildWords.ttf', 1);
    await fonts.addFontFile(file);
    // The library has the bytes, which is where they belong...
    expect(await file.held()).toBe(true);
    // ...and it is the only place: with its copy gone, nobody has them.
    idb.rows.clear();
    expect(await file.held()).toBe(false);
    await fonts.removeUserFont('WildWords');
    expect(said).toEqual([]);
  });

  it('nor is anything kept with a watcher, when the library has the bytes', async () => {
    watcher();
    const file = weakFile('WildWords.ttf', 1);
    await fonts.addFontFile(file);
    idb.rows.clear();
    expect(await file.held()).toBe(false);
  });
});

describe('a face that loaded and could not be saved', () => {
  const full = () => {
    idb.open = () => {
      throw new Error('quota');
    };
  };
  const listed = async () => (await fonts.loadedFaceRecords()).map((r) => [r.name, r.slot, r.file, r.data && new Uint8Array(r.data)[4]]);

  it('with nobody watching: the bytes are not kept, and the face is listed as one there are no bytes of', async () => {
    full();
    const file = weakFile('Unsaved.ttf', 5);
    await fonts.addFontFile(file);
    expect(store.app.toast.msg).toContain('could not be saved');
    // Loaded, and drawn by the browser from its own copy.
    expect(store.app.fonts.user.map((f) => f.name)).toEqual(['Unsaved']);
    expect(await file.held()).toBe(false);
    expect(await listed()).toEqual([['Unsaved', 'regular', 'Unsaved.ttf', null]]);
    // A watcher that starts now is too late for it.
    watcher();
    expect(await listed()).toEqual([['Unsaved', 'regular', 'Unsaved.ttf', null]]);
  });

  it('with a watcher: the bytes are kept for as long as it watches, and given back when it stops', async () => {
    full();
    const said = watcher();
    const file = weakFile('Unsaved.ttf', 5);
    await fonts.addFontFile(file);
    expect(said).toEqual([['added', 'Unsaved', 'regular', 5]]);
    expect(await file.held()).toBe(true);
    expect(await listed()).toEqual([['Unsaved', 'regular', 'Unsaved.ttf', 5]]);
    fonts.watchUserFaces(null);
    expect(await file.held()).toBe(false);
    expect(await listed()).toEqual([['Unsaved', 'regular', 'Unsaved.ttf', null]]);
  });

  it('from a chapter package is the same case', async () => {
    full();
    expect(await fonts.installFontFace({ family: 'Packed', slot: 'bold', file: 'p.ttf', data: new Uint8Array(SFNT(3)) })).toBe('installed');
    expect(await listed()).toEqual([['Packed', 'bold', 'p.ttf', null]]);
  });

  it('is forgotten with the face, and a file added again that does save is read back as any other', async () => {
    full();
    await fonts.addFontFile(fontFile('Unsaved.ttf', SFNT(5)));
    await fonts.removeUserFont('Unsaved');
    expect(await listed()).toEqual([]);
    await fonts.addFontFile(fontFile('Unsaved.ttf', SFNT(5)));
    delete idb.open;
    idb.open = fakeIndexedDB(idb.rows).open;
    // Replaced by a file the library takes: the note that it has no bytes goes.
    await fonts.addFontFile(fontFile('Unsaved-v2.ttf', SFNT(6)), { family: 'Unsaved', slot: 'regular' });
    expect(await listed()).toEqual([['Unsaved', 'regular', 'Unsaved-v2.ttf', 6]]);
  });
});

describe('the bytes of what is already loaded', () => {
  it('are read back from the library for every face the session has', async () => {
    await fonts.addFontFile(fontFile('WildWords.ttf', SFNT(1)));
    await fonts.addFontFile(fontFile('WildWords-Bold.ttf', SFNT(2)));
    expect([...idb.rows.keys()]).toEqual(['WildWords::regular', 'WildWords::bold']);
    const records = await fonts.loadedFaceRecords();
    expect(records.map((r) => [r.name, r.slot, r.file, new Uint8Array(r.data)[4]])).toEqual([
      ['WildWords', 'regular', 'WildWords.ttf', 1],
      ['WildWords', 'bold', 'WildWords-Bold.ttf', 2],
    ]);
  });

  it('leave out a record whose face is not the one loaded', async () => {
    await fonts.addFontFile(fontFile('WildWords.ttf', SFNT(1)));
    // In the library but not in this session: never restored, or another file.
    idb.rows.set('Stranger::regular', { key: 'Stranger::regular', name: 'Stranger', slot: 'regular', file: 's.ttf', data: SFNT(8) });
    idb.rows.set('WildWords::regular', { key: 'WildWords::regular', name: 'WildWords', slot: 'regular', file: 'someone-elses.ttf', data: SFNT(9) });
    expect(await fonts.loadedFaceRecords()).toEqual([]);
  });
});

describe('the boot of the font lists', () => {
  it('is over only when the restore and the scan have both finished', async () => {
    let done = false;
    fonts.fontsBooted().then(() => (done = true));
    await fonts.restoreFonts();
    await Promise.resolve();
    expect(done).toBe(false);
    // Outside the desktop app there is nothing to scan, and that is an answer too.
    await fonts.scanSystemFonts();
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it('is over even when the library could not be read', async () => {
    idb.open = () => {
      throw new Error('blocked');
    };
    await fonts.restoreFonts();
    await fonts.scanSystemFonts();
    await expect(fonts.fontsBooted()).resolves.toBeTruthy();
    expect(store.app.toast.msg).toContain('Font library unavailable');
  });
});
