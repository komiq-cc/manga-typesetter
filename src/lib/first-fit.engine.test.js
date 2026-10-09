// ===== A browser-lettered chapter on disk, opened by the Rust engine =====
//
// first-fit.test.js pins the rules on stand-in engines. This is the same
// question asked of what the app runs: the real `library.svelte.js` over
// node:fs (as roundtrip.realfs.test.js mounts it), the wasm, and fixture fonts
// handed over the way the app hands fonts over. What it reads is the file:
// its bytes before the open, after the open, after the fonts have landed,
// after the debounce, after leaving - and after the two things that are
// allowed to change it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./fsx.js', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const live = new Set();
  let tmpSeq = 0;
  return {
    fsx: {
      async readDir(p) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
      },
      readTextFile: (p) => fs.readFile(p, 'utf8'),
      writeTextFile: (p, c) => fs.writeFile(p, c, 'utf8'),
      async writeTextFileAtomic(p, c) {
        const tmp = `${p}.${++tmpSeq}.tmp`;
        live.add(tmp);
        try {
          await fs.writeFile(tmp, c, 'utf8');
          await fs.rename(tmp, p);
        } finally {
          live.delete(tmp);
        }
      },
      liveTemps() {
        return new Set(live);
      },
      async readFile(p) {
        return new Uint8Array(await fs.readFile(p));
      },
      writeFile: (p, bytes) => fs.writeFile(p, bytes),
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      remove: (p) => fs.rm(p, { recursive: true, force: true }),
      async exists(p) {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      async join(...parts) {
        return path.join(...parts);
      },
      async homeDir() {
        return os.tmpdir();
      },
    },
  };
});

const { library, setRoot, createProject, createChapter, openChapter, closeChapter, flushBeforeLeaving, resetSaveFailures } = await import('./library.svelte.js');
const { app, loadProjectPages, firstFit, firstFitChanges, keepFirstFit, markUnsaved, DOC_SAVE_MS } = await import('./store.svelte.js');
const { initHistory } = await import('./editor/history.svelte.js');
const { switchHistoryPage } = await import('./editor/history-file.svelte.js');
const { setPageSwitchHook } = await import('./store.svelte.js');
const { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } = await import('./engine-switch.svelte.js');
const { textEngine, setTextEngine } = await import('./text-engine/index.js');
const { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } = await import('./fonts.js');
const { setTypesetEnabled, typesetEnabled, clearLayoutMemo } = await import('./measure.js');
const { rustEngine, fixtureFont } = await import('../test/rust-engine.js');
const { buildCollection, systemFaceAnswer } = await import('../test/font-collection.js');
const { fakeIndexedDB } = await import('../test/fake-indexeddb.js');

// ---------- a page image ----------
const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
function pngBytes(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.alloc(1 + w, 200));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- the fonts ----------
const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const oblique = fixtureFont('DejaVuSans-Oblique.ttf');
const copy = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fontFile = (name, bytes) => ({ name, arrayBuffer: async () => copy(bytes) });
// The machine's fonts: the last resort, and a family read on first use.
const FILES = {
  'DejaVu Sans': [{ slots: { regular: 0 }, bytes: dejavu }, { slots: { italic: 0 }, bytes: oblique }],
  'Comic Bangers': [{ slots: { regular: 0, bold: 1 }, bytes: buildCollection([comic, bangers]) }],
};
// A system file can take its time: with `slow` set, every family but the last
// resort waits for it.
let slow = null;
const invoke = async (cmd, args) => {
  if (cmd === 'system_font_coverage') return { families: [], none: args.codePoints };
  if (cmd !== 'system_font_face') throw new Error(`unexpected command ${cmd}`);
  if (slow && args.family !== 'DejaVu Sans') await slow;
  const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
  if (!file) throw new Error(`no font called '${args.family}' is installed on this computer`);
  return systemFaceAnswer(file.slots, file.bytes, { known: args.known });
};

// ---------- the chapter ----------
// Three boxes as an older build left them: too short for their text, in a
// user font, a system font and a font this machine does not have.
const SIZE = 26;
const TEXT = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG';
const made = (id, font, y) => ({
  id, lineN: null, text: TEXT, x: 60, y, w: 150, h: 20,
  style: { font, size: SIZE, lineHeight: 1.1, valign: 'top', outlineWidth: 0 },
});
const BOXES = [made('user', 'MyComic', 40), made('system', 'Comic Bangers', 220), made('gone', 'No Such Font', 400)];

let root;
let source;
let seq = 0;
let p;
let c;
const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
const fontLibrary = fakeIndexedDB();

const chapterFile = () => join(c.dir, 'chapter.json');
const record = async () => JSON.parse(await readFile(chapterFile(), 'utf8'));
// Every file under the chapter, by content: what an open may not change.
async function digest(dir = c.dir, out = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const at = join(dir, e.name);
    if (e.isDirectory()) await digest(at, out);
    else out[at.slice(c.dir.length)] = createHash('sha256').update(await readFile(at)).digest('hex');
  }
  return out;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boxes = () => app.pages[0].boxes;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mt-first-fit-'));
  source = join(root, 'sources');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'raw-01.png'), pngBytes(400, 600));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
  vi.stubGlobal('indexedDB', fontLibrary);
  closeChapter();
  resetSaveFailures();
  initHistory();
  setPageSwitchHook(switchHistoryPage);
  const dir = join(root, `library-${++seq}`);
  await mkdir(dir, { recursive: true });
  await setRoot(dir);
  library.projects = [];
  app.fonts.system = [
    systemFontEntry({ name: 'Comic Bangers', faces: { regular: true, bold: true } }),
    systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } }),
  ];
  _setEngineSwitchDeps({ available: () => true, createEngine: () => rustEngine({ fixtures: false }), invoke: async () => invoke, booted: async () => {}, os: () => 'linux' });
  await addFontFile(fontFile('MyComic.ttf', comic));

  // The chapter, made by the library and then given its boxes on disk: a file
  // from before the Rust engine, at version 1.
  p = await createProject('First fit');
  c = await createChapter({
    projectId: p.id, number: 1, title: 'Old',
    files: [{ name: 'raw-01.png', arrayBuffer: async () => copy(await readFile(join(source, 'raw-01.png'))) }],
    translations: [],
  });
  const rec = await record();
  rec.pages[0].boxes = structuredClone(BOXES);
  rec.typesetting = { mode: 'smart', version: 1 };
  await writeFile(chapterFile(), JSON.stringify(rec));
});

afterEach(async () => {
  slow = null;
  closeChapter();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  watchUserFaces(null);
  for (const f of [...app.fonts.user]) await removeUserFont(f.name);
  fontLibrary.rows.clear();
  app.fonts.system = original.system;
  loadProjectPages([]);
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  vi.unstubAllGlobals();
});

describe('a version 1 chapter opened with the Rust engine on', () => {
  it('is fitted in memory - heights grow, nothing else moves - and not one byte of it changes on disk', async () => {
    await useTextEngine('rust');
    expect(engineSwitch.phase).toBe('on');
    const before = await digest();
    expect(Object.keys(before)).toContain('/chapter.json');

    // The system family's file is still being read when the chapter is open:
    // the order a real open has, and the one that used to write the file.
    let land;
    slow = new Promise((resolve) => (land = resolve));
    await openChapter(p.id, c.id);
    expect(app.chapterRef).toBeTruthy();
    expect(boxes()[1].h).toBe(20);
    land();
    await _engineSwitchSync().settled();
    // The user font and the missing one are fitted at the open, the system
    // family when its file has been read: all three grown, none moved across.
    for (const [i, b] of boxes().entries()) {
      expect(b.h).toBeGreaterThan(20);
      expect({ x: b.x, w: b.w, size: b.style.size }).toEqual({ x: BOXES[i].x, w: BOXES[i].w, size: SIZE });
    }
    expect(firstFitChanges()).toMatchObject({ grew: 3, kept: false });
    expect(app.saved).toBe(true);
    expect(await digest()).toEqual(before);

    // Not after the debounce an edit would have armed.
    await wait(DOC_SAVE_MS + 200);
    expect(await digest()).toEqual(before);

    // And not by leaving.
    expect(await flushBeforeLeaving('editor')).toBe(true);
    closeChapter();
    expect(await digest()).toEqual(before);
  });

  it('is written by Keep: the grown heights, and the one integer', async () => {
    await useTextEngine('rust');
    const old = await record();
    await openChapter(p.id, c.id);
    await _engineSwitchSync().settled();
    const grown = boxes().map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    await keepFirstFit();
    const rec = await record();
    expect(rec.typesetting).toEqual({ mode: 'smart', version: 2 });
    expect(rec.pages[0].boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))).toEqual(grown);
    // Nothing else in the record is new: the same fields, and no note of what moved.
    expect(Object.keys(rec).sort()).toEqual(Object.keys(old).sort());
    expect(Object.keys(rec.typesetting)).toEqual(['mode', 'version']);
    closeChapter();

    // Opened again it is a chapter the engine has fitted: nothing to say.
    await openChapter(p.id, c.id);
    await _engineSwitchSync().settled();
    expect(firstFit.open).toBe(false);
    expect(firstFitChanges()).toBe(null);
    expect(boxes().map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))).toEqual(grown);
  });

  it('is written by the save an edit causes, with the same integer', async () => {
    await useTextEngine('rust');
    await openChapter(p.id, c.id);
    await _engineSwitchSync().settled();
    boxes()[0].text = 'EDITED';
    markUnsaved();
    expect(await flushBeforeLeaving('editor')).toBe(true);
    const rec = await record();
    expect(rec.typesetting.version).toBe(2);
    expect(rec.pages[0].boxes[0].text).toBe('EDITED');
    expect(rec.pages[0].boxes[1].h).toBe(boxes()[1].h);
  });

  it('a version 2 chapter saved with the browser measuring is version 1 again, and nothing else in it changes', async () => {
    await useTextEngine('rust');
    await openChapter(p.id, c.id);
    await _engineSwitchSync().settled();
    await keepFirstFit();
    closeChapter();
    const two = await record();

    await useTextEngine('browser');
    await openChapter(p.id, c.id);
    expect(app.typesetting.version).toBe(2);
    expect(firstFit.open).toBe(false);
    // Leaving writes, as it always has under the browser.
    expect(await flushBeforeLeaving('editor')).toBe(true);
    closeChapter();
    const one = await record();
    expect(one.typesetting).toEqual({ mode: 'smart', version: 1 });
    expect({ ...one, typesetting: null, updatedAt: null }).toEqual({ ...two, typesetting: null, updatedAt: null });
  });
});

describe('the same chapter with the browser measuring', () => {
  it('opens and leaves as it always has: written on leaving, still version 1', async () => {
    const old = await record();
    await openChapter(p.id, c.id);
    expect(firstFit.open).toBe(false);
    expect(firstFitChanges()).toBe(null);
    expect(await flushBeforeLeaving('editor')).toBe(true);
    closeChapter();
    const rec = await record();
    expect(rec.typesetting).toEqual({ mode: 'smart', version: 1 });
    // Nothing measures in this lane without the engine, so no box moved.
    const rect = (b) => ({ id: b.id, text: b.text, x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size });
    expect(rec.pages[0].boxes.map(rect)).toEqual(old.pages[0].boxes.map(rect));
  });
});
