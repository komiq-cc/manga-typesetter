import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../test/rust-engine.js';
import { systemFaceAnswer } from '../test/font-collection.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// ===========================================================================
// What a chapter package says of a font is what the font gate says of it
// ===========================================================================
// package-fonts.test.js has the wording and the lists, with a stand-in for
// the gate. Here the gate is the real one: the real switch, the real engine,
// fonts handed over the way the app hands them over. What is checked is the
// two cases a list cannot tell apart from a font that is drawn:
//
//   - a family in the user's library whose only file the engine cannot read
//     (a WOFF2 and no decoder for it);
//   - a family the system scan lists whose file cannot be read.
//
// Both are in a list, and both are drawn in the last-resort face.

let chapter;
vi.mock('./library.svelte.js', () => ({
  projectById: () => ({ id: 'p1', name: 'My Project' }),
  readChapterPackageSources: async () => chapter,
  projectTag: () => null,
  addProjectTags: async () => 0,
  createChapterFromPages: async (args) => ({ id: 'c-new', ...args }),
}));

const { app, setFontSource, fontMissing } = await import('./store.svelte.js');
const { engineSwitch, useTextEngine, whyFontMissing, _setEngineSwitchDeps, _resetEngineSwitch } = await import('./engine-switch.svelte.js');
const { textEngine, setTextEngine } = await import('./text-engine/index.js');
const { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } = await import('./fonts.js');
const { exportChapterPackage, inspectPackage, fontStatus } = await import('./package-flow.js');
const { buildChapterPackage, readChapterPackage } = await import('./package.js');

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const copy = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fontFile = (name, bytes) => ({ name, arrayBuffer: async () => copy(bytes) });
// A file that says it is WOFF2: the browser's stand-in takes it, and there
// is nothing here to decode it.
const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4, 5, 6, 7, 8]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// The machine: three families the scan lists, and a file for two of them.
const FILES = { 'Helvetica Neue': comic, 'DejaVu Sans': dejavu };
const invoke = async (cmd, args) => {
  if (cmd === 'system_font_coverage') return { families: [], none: args.codePoints };
  if (cmd === 'font_to_sfnt') throw new Error('not a WOFF file');
  if (cmd !== 'system_font_face') throw new Error(`unexpected command ${cmd}`);
  const bytes = FILES[args.family];
  if (!bytes) throw new Error(`'${args.family}' could not be read`);
  return systemFaceAnswer({ regular: 0 }, bytes, { known: args.known });
};

const boxIn = (font) => ({ id: `b-${font}`, lineN: null, text: 'HI', x: 0, y: 0, w: 100, h: 40, style: { font, size: 20 } });
const chapterIn = (...fonts) => ({
  record: { id: 'c1', number: 7, title: 'Seven', mode: 'typeset', typesetting: { mode: 'smart', version: 1 }, pages: [{ id: 1, file: 'p1.png', boxes: fonts.map(boxIn) }] },
  translations: null,
  project: { name: 'My Project', layout: 'pages', ocrLanguage: 'ja' },
  raws: new Map([['p1.png', png]]),
  cleaned: new Map(),
});
const asFile = (bytes) => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const statuses = async (bytes) => Object.fromEntries((await inspectPackage(asFile(bytes), 'p1')).summary.fonts.map((f) => [f.name, f.status]));

const original = { engine: textEngine(), system: app.fonts.system };
const library = fakeIndexedDB();
let downloads;

async function on() {
  const engine = await rustEngine({ fixtures: false });
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
  await useTextEngine('rust');
  expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: 'Helvetica Neue' });
}

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
  app.fonts.system = [
    systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true } }),
    systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true } }),
    systemFontEntry({ name: 'Broken Sys', faces: { regular: true } }),
  ];
});

afterEach(async () => {
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  setFontSource(null);
  watchUserFaces(null);
  for (const f of [...app.fonts.user]) await removeUserFont(f.name);
  library.rows.clear();
  app.fonts.system = original.system;
  setTextEngine(original.engine);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the import says of a font what the engine will draw it in', () => {
  const incoming = (...fonts) => buildChapterPackage({ ...chapterIn(...fonts), fonts: fonts.map((name) => ({ name, faces: {} })) });

  it('a library font the engine cannot read is missing, not present', async () => {
    await addFontFile(fontFile('Packed.woff2', woff2));
    await addFontFile(fontFile('Mine.ttf', bangers));
    await on();
    // Both are in the library's list...
    expect(app.fonts.user.map((f) => f.name).sort()).toEqual(['Mine', 'Packed']);
    // ...and one of them is a font the editor lists as missing.
    expect(await statuses(incoming('Packed', 'Mine'))).toEqual({ Packed: 'missing', Mine: 'present' });
    expect(fontMissing('Packed')).toBe(true);
    expect(whyFontMissing('Packed')).toBe('unreadable');
  });

  it('a system font whose file cannot be read is missing, not installed here; nothing had asked for it before', async () => {
    await on();
    // Not asked of the gate by anything yet: the dialog's question is the
    // first, and it waits for the answer.
    expect(await statuses(incoming('DejaVu Sans', 'Broken Sys', 'Gone Font'))).toEqual({ 'DejaVu Sans': 'system', 'Broken Sys': 'missing', 'Gone Font': 'missing' });
    expect(whyFontMissing('Broken Sys')).toBe('unreadable');
  });

  it('a shipped font whose every face is already in the library, unreadable there, is missing: the import would not put the file in', async () => {
    await addFontFile(fontFile('Packed.woff2', woff2));
    await on();
    const bytes = buildChapterPackage({ ...chapterIn('Packed'), fonts: [{ name: 'Packed', faces: { regular: { file: 'Packed.ttf', data: comic } } }] });
    expect(await statuses(bytes)).toEqual({ Packed: 'missing' });
    // A face of it the library does not have is still one to install.
    const more = readChapterPackage(buildChapterPackage({ ...chapterIn('Packed'), fonts: [{ name: 'Packed', faces: { bold: { file: 'Packed-Bold.ttf', data: comic } } }] }));
    expect(fontStatus(more.fonts[0])).toBe('install');
  });
});

describe('the export says of a font that stays what the engine has for it', () => {
  it('a system font the engine cannot read has no file on this computer', async () => {
    await on();
    chapter = chapterIn('DejaVu Sans', 'Broken Sys', 'Gone Font');
    const saved = await exportChapterPackage('p1', 'c1');
    expect(saved.staying).toEqual([
      { name: 'DejaVu Sans', why: 'system' },
      { name: 'Broken Sys', why: 'missing' },
      { name: 'Gone Font', why: 'missing' },
    ]);
  });
});
