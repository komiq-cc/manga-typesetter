import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fixtureFont } from '../test/rust-engine.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// ===========================================================================
// What a chapter package says about fonts, on the way out and on the way in
// ===========================================================================
// The export and the import as the app runs them - package-flow.js, fonts.js,
// package.js, the store's font lists - with the fixture fonts as the user's
// files. What is stood in for: the library's files on disk (one chapter,
// handed over by the mock below), IndexedDB, `FontFace`, and the browser's
// download.
//
// "The Rust engine switched on" is, to this code, the font gate: a font
// source that can settle (`fontsGated`) and says which families are missing
// (`fontMissing`). package-flow.js asks nothing else of the engine, so a
// source that answers those two is the whole of the switch here. The one
// below answers as the engine does when every file on the machine can be
// read; a file that cannot is package-fonts.engine.test.js, with the real
// gate.

let chapter;
vi.mock('./library.svelte.js', () => ({
  projectById: () => ({ id: 'p1', name: 'My Project' }),
  readChapterPackageSources: async () => chapter,
  projectTag: () => null,
  addProjectTags: async () => 0,
  createChapterFromPages: async (args) => ({ id: 'c-new', ...args }),
}));

const { app, setFontSource } = await import('./store.svelte.js');
const { addFontFile, removeUserFont, installFontFace, systemFontEntry } = await import('./fonts.js');
const { exportChapterPackage, inspectPackage, importChapterPackage, fontStatus, fontsStaying, stayingNote, packageFontStatuses } = await import('./package-flow.js');
const { readChapterPackage, buildChapterPackage } = await import('./package.js');

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const copy = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fontFile = (name, bytes) => ({ name, arrayBuffer: async () => copy(bytes) });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const boxIn = (font) => ({ id: `b-${font}`, lineN: null, text: 'HI', x: 0, y: 0, w: 100, h: 40, style: { font, size: 20 } });
// One page, a box in each of the named fonts.
const chapterIn = (...fonts) => ({
  record: { id: 'c1', number: 7, title: 'Seven', mode: 'typeset', typesetting: { mode: 'smart', version: 1 }, pages: [{ id: 1, file: 'p1.png', boxes: fonts.map(boxIn) }] },
  translations: null,
  project: { name: 'My Project', layout: 'pages', ocrLanguage: 'ja' },
  raws: new Map([['p1.png', png]]),
  cleaned: new Map(),
});

const library = fakeIndexedDB();
const before = { builtin: app.fonts.builtin, system: app.fonts.system };
let downloads;
const engineOn = () =>
  setFontSource({
    ready: () => true,
    settle: async () => {},
    // Bytes are the library's or the system's; a built-in has none.
    missing: (name) => ![...app.fonts.user, ...app.fonts.system].some((f) => f.name === name),
  });

// The package the export wrote, read back.
async function exported() {
  const saved = await exportChapterPackage('p1', 'c1');
  expect(downloads).toHaveLength(1);
  const pkg = readChapterPackage(new Uint8Array(await downloads[0].arrayBuffer()));
  return { saved, pkg, fonts: Object.fromEntries(pkg.fonts.map((f) => [f.name, f.shipped])) };
}
const asFile = (bytes) => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const statuses = async (pkgBytes) => Object.fromEntries((await inspectPackage(asFile(pkgBytes), 'p1')).summary.fonts.map((f) => [f.name, f.status]));

beforeEach(() => {
  downloads = [];
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} }, createElement: () => ({ click() {} }) });
  vi.stubGlobal('indexedDB', library);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => (downloads.push(blob), 'blob:test'));
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  app.fonts.system = [systemFontEntry({ name: 'Arial', faces: { regular: true, bold: true } })];
});

afterEach(async () => {
  setFontSource(null);
  for (const f of [...app.fonts.user]) await removeUserFont(f.name);
  library.rows.clear();
  app.fonts.builtin = before.builtin;
  app.fonts.system = before.system;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the export says which fonts go without a file', () => {
  beforeEach(async () => {
    await addFontFile(fontFile('WildWords.ttf', bangers));
    chapter = chapterIn('WildWords', 'Arial', 'Gone Font', 'Comic Neue');
  });

  it('with the engine on: a system font and a font with no file are named, each for what it is', async () => {
    engineOn();
    const { saved, fonts } = await exported();
    // The user's font travels; the system font and the absent one are named
    // in the manifest with no faces; the built-in is not in the manifest.
    expect(fonts).toEqual({ WildWords: true, Arial: false, 'Gone Font': false });
    expect(saved.path).toBe('My-Project-ch7.mtchapter');
    expect(saved.staying).toEqual([
      { name: 'Arial', why: 'system' },
      { name: 'Gone Font', why: 'missing' },
      { name: 'Comic Neue', why: 'missing' },
    ]);
    expect(stayingNote(saved.staying)).toBe(
      "Fonts not in the package: Arial (installed here; a system font's file is not copied); Gone Font, Comic Neue (no file on this computer)",
    );
  });

  it('no system font file is ever copied into a package', async () => {
    engineOn();
    const { pkg } = await exported();
    expect(pkg.fonts.find((f) => f.name === 'Arial').faces).toEqual({ regular: null, bold: null, italic: null, boldItalic: null });
    expect(pkg.fonts.filter((f) => f.shipped).map((f) => f.name)).toEqual(['WildWords']);
  });

  it('with the switch off the same package is written and nothing more is said', async () => {
    const { saved, fonts } = await exported();
    expect(fonts).toEqual({ WildWords: true, Arial: false, 'Gone Font': false });
    expect(saved).toEqual({ path: 'My-Project-ch7.mtchapter', staying: [] });
    expect(stayingNote(saved.staying)).toBe('');
    expect(fontsStaying([{ name: 'Arial', faces: {} }])).toEqual([]);
  });

  it('a library font that goes without its file is not called a system font, drawn here or not', async () => {
    engineOn();
    // In the library and drawn as itself, and no file of it came out of the
    // library to be copied (it was loaded and could not be saved).
    expect(fontsStaying([{ name: 'WildWords', faces: {} }])).toEqual([{ name: 'WildWords', why: 'missing' }]);
    expect(fontsStaying([{ name: 'Arial', faces: {} }])).toEqual([{ name: 'Arial', why: 'system' }]);
  });

  it('a chapter whose every font travels has nothing to say', async () => {
    engineOn();
    chapter = chapterIn('WildWords');
    expect((await exported()).saved.staying).toEqual([]);
  });
});

describe('the import says what each font will be on this machine', () => {
  // A package from another machine: one font shipped, three only named.
  const incoming = (fonts = ['Shipped Font', 'Arial', 'Gone Font', 'Mine'], used = fonts) =>
    buildChapterPackage({
      ...chapterIn(...used),
      fonts: fonts.map((name) => (name === 'Shipped Font' ? { name, faces: { regular: { file: 'Shipped.ttf', data: bangers } } } : { name, faces: {} })),
    });

  it('with the engine on: to install, in the library, installed on this machine, missing', async () => {
    await addFontFile(fontFile('Mine.ttf', comic));
    engineOn();
    expect(await statuses(incoming())).toEqual({ 'Shipped Font': 'install', Arial: 'system', 'Gone Font': 'missing', Mine: 'present' });
  });

  it('with the engine on, a built-in the exporter left out of the manifest is a missing font, and is said', async () => {
    engineOn();
    // 'Comic Neue' is used by a box and is not in the manifest, as today's export writes it.
    const st = await statuses(incoming(['Shipped Font'], ['Shipped Font', 'Comic Neue']));
    expect(st).toEqual({ 'Shipped Font': 'install', 'Comic Neue': 'missing' });
  });

  it('with the switch off the answers are the ones it always gave', async () => {
    await addFontFile(fontFile('Mine.ttf', comic));
    // A system font is "missing", a built-in is "builtin", and a family the manifest does not list is not listed.
    expect(await statuses(incoming())).toEqual({ 'Shipped Font': 'install', Arial: 'missing', 'Gone Font': 'missing', Mine: 'present' });
    expect(await statuses(incoming(['Shipped Font', 'Comic Neue'], ['Shipped Font', 'Comic Neue', 'Bangers']))).toEqual({ 'Shipped Font': 'install', 'Comic Neue': 'builtin' });
  });

  it('with the switch off the statuses are there at once: no promise, and not a tick later than before', async () => {
    await addFontFile(fontFile('Mine.ttf', comic));
    const bytes = incoming();
    // The list itself, not a promise of it.
    const out = packageFontStatuses(readChapterPackage(bytes));
    expect(Array.isArray(out)).toBe(true);
    expect(Object.fromEntries(out.map((f) => [f.name, f.status]))).toEqual({ 'Shipped Font': 'install', Arial: 'missing', 'Gone Font': 'missing', Mine: 'present' });
    // `inspectPackage` awaits the file's bytes and nothing else. Set beside
    // a function that awaits exactly that and was started AFTER it: one
    // more await anywhere in it, and the other finishes first.
    const order = [];
    const file = asFile(bytes);
    const inspected = inspectPackage(file, 'p1').then(() => order.push('inspectPackage'));
    const beside = (async () => void (await file.arrayBuffer()))().then(() => order.push('one await'));
    await Promise.all([inspected, beside]);
    expect(order).toEqual(['inspectPackage', 'one await']);
  });

  it('inspection waits again when the font source is replaced, including when the old wait rejects', async () => {
    for (const rejectOld of [false, true]) {
      let endOld, endNew, askedNew;
      const newAsked = new Promise((resolve) => (askedNew = resolve));
      const oldWait = new Promise((resolve, reject) => (endOld = rejectOld ? () => reject(new Error('old source gave up')) : resolve));
      setFontSource({ ready: () => true, missing: () => false, settle: () => oldWait });
      const inspected = statuses(incoming(['Arial']));
      // `inspectPackage` has awaited the bytes and begun the original wait.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      let pending = true;
      const newWait = new Promise((resolve) => (endNew = () => { pending = false; resolve(); }));
      setFontSource({ ready: () => !pending, missing: () => !pending, settle: () => (askedNew(), newWait) });
      let finished = false;
      inspected.then(() => { finished = true; });
      endOld();
      await newAsked;
      expect(finished).toBe(false);
      endNew();
      expect(await inspected).toEqual({ Arial: 'missing' });
    }
  });

  it('give-up errors stay visible and a pending family is never called system or present', async () => {
    setFontSource({ ready: () => false, missing: () => false, settle: () => Promise.reject(new Error('the fonts never settled')) });
    expect(packageFontStatuses(readChapterPackage(incoming(['Arial'])))).toEqual([{ name: 'Arial', status: 'missing' }]);
    await expect(statuses(incoming(['Arial']))).rejects.toThrow(/Could not inspect package fonts.*never settled/);
    setFontSource({ ready: () => false, missing: () => false, settle: async () => {} });
    await expect(statuses(incoming(['Arial']))).rejects.toThrow(/still loading/);
  });

  it('unending source replacement gives up visibly rather than returning an unsound status', async () => {
    const next = () => ({ ready: () => false, missing: () => false, settle: async () => { setFontSource(next()); } });
    setFontSource(next());
    await expect(statuses(incoming(['Arial']))).rejects.toThrow(/font source kept changing/);
  });

  it('a shipped font is present once every face of it is in the library, in either mode', async () => {
    const pkg = readChapterPackage(incoming(['Shipped Font']));
    expect(fontStatus(pkg.fonts[0])).toBe('install');
    await importChapterPackage({ pkg, projectId: 'p1', number: 7 });
    expect(fontStatus(pkg.fonts[0])).toBe('present');
    engineOn();
    expect(fontStatus(pkg.fonts[0])).toBe('present');
  });
});

// AT CUT-OVER the built-in list is removed. These run with it empty, which is
// what the app will be then, and must hold then as they do now.
describe('with no built-in fonts (cut-over)', () => {
  // A font file the user loaded under the name a built-in had.
  const formerBuiltin = { name: 'Comic Neue', faces: { regular: { file: 'ComicNeue-Regular.ttf', data: comic } } };

  it('today a package cannot install a font under a built-in name', async () => {
    const pkg = readChapterPackage(buildChapterPackage({ ...chapterIn('Comic Neue'), fonts: [formerBuiltin] }));
    expect(pkg.fonts[0].shipped).toBe(true);
    expect(await installFontFace({ family: 'Comic Neue', slot: 'regular', file: 'ComicNeue-Regular.ttf', data: comic })).toBe('builtin');
    engineOn();
    // Refused, and nowhere on this machine: missing is what it will be.
    expect(fontStatus(pkg.fonts[0])).toBe('missing');
  });

  for (const mode of ['engine on', 'switch off']) {
    it(`a package that carries a font under a former built-in name installs it (${mode})`, async () => {
      app.fonts.builtin = [];
      if (mode === 'engine on') engineOn();
      const bytes = buildChapterPackage({ ...chapterIn('Comic Neue'), fonts: [formerBuiltin] });
      expect(await statuses(bytes)).toEqual({ 'Comic Neue': 'install' });
      const pkg = readChapterPackage(bytes);
      const done = await importChapterPackage({ pkg, projectId: 'p1', number: 7 });
      expect(done).toMatchObject({ fontsInstalled: 1, fontsFailed: 0 });
      expect(app.fonts.user.find((f) => f.name === 'Comic Neue').faces.regular).toEqual({ file: 'ComicNeue-Regular.ttf' });
      expect(library.rows.has('Comic Neue::regular')).toBe(true);
      expect(await statuses(bytes)).toEqual({ 'Comic Neue': 'present' });
    });

    it(`a font the user loaded under a former built-in name travels with the chapter (${mode})`, async () => {
      app.fonts.builtin = [];
      if (mode === 'engine on') engineOn();
      await addFontFile(fontFile('Comic Neue.ttf', comic));
      chapter = chapterIn('Comic Neue', 'Bangers');
      const { saved, pkg, fonts } = await exported();
      // Comic Neue has a file and goes; Bangers has none and is named, empty.
      expect(fonts).toEqual({ 'Comic Neue': true, Bangers: false });
      expect(pkg.fonts[0].faces.regular.file).toBe('Comic Neue.ttf');
      expect(pkg.fonts[0].faces.regular.data.byteLength).toBe(comic.byteLength);
      expect(saved.staying).toEqual(mode === 'engine on' ? [{ name: 'Bangers', why: 'missing' }] : []);
    });
  }
});
