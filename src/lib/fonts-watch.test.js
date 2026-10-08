import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What fonts.js offers whoever keeps a second copy of the user's faces in step
// (the Rust text engine, through engine-switch.svelte.js): the watcher it
// tells, the bytes of what is already loaded, and the promise that says the
// boot restore and scan are over. IndexedDB is a small stand-in written below;
// the module is loaded fresh for each case because it keeps its connection.

// An IndexedDB that holds records in a Map: enough of the API for fonts.js -
// one store keyed by `key`, put / getAll / delete inside a transaction.
function fakeIndexedDB(rows = new Map()) {
  const later = (fn) => queueMicrotask(fn);
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      const tx = {};
      const settle = () => later(() => tx.oncomplete?.());
      tx.objectStore = () => ({
        put(rec) {
          rows.set(rec.key, rec);
          settle();
        },
        delete(key) {
          rows.delete(key);
          settle();
        },
        getAll() {
          const req = {};
          later(() => {
            req.result = [...rows.values()];
            req.onsuccess?.();
          });
          return req;
        },
      });
      return tx;
    },
  };
  return {
    rows,
    open() {
      const req = { result: db };
      later(() => req.onsuccess?.());
      return req;
    },
  };
}

const SFNT = (fill) => Uint8Array.from([0, 1, 0, 0, fill, fill]).buffer;
const fontFile = (name, buffer) => ({ name, arrayBuffer: async () => buffer });

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
    await fonts.addFontFile(fontFile('WildWords.ttf', SFNT(1)));
    await fonts.removeUserFont('WildWords');
    expect(said).toEqual([]);
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

  it('include a face that loaded and could not be saved, until it is removed', async () => {
    idb.open = () => {
      throw new Error('quota');
    };
    await fonts.addFontFile(fontFile('Unsaved.ttf', SFNT(5)));
    expect(store.app.toast.msg).toContain('could not be saved');
    expect((await fonts.loadedFaceRecords()).map((r) => [r.name, new Uint8Array(r.data)[4]])).toEqual([['Unsaved', 5]]);
    await fonts.removeUserFont('Unsaved');
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
