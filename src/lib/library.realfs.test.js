// ===== The library against a real filesystem =====
//
// library.test.js runs the catalogue against an in-memory `fsx`, which is the
// right seam for logic. It cannot answer the question this slice actually turns
// on: do the bytes that come out of a copy equal the bytes that went in?
//
// So this file swaps the same seam for node:fs and runs the real code over real
// PNGs in a temp directory - including a 16-bit greyscale one, which is what a
// manga raw frequently is and what a decode/re-encode would quietly flatten.
// It is the disk half of slice 2a's acceptance pass; the half that needs eyes
// on a window (the pairing summary before you commit, the PSD re-encode notice,
// both themes) is not something a test can claim.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./fsx.js', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const live = new Set();
  let tmpSeq = 0;
  return {
    fsx: {
      async readDir(p) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
        }));
      },
      readTextFile: (p) => fs.readFile(p, 'utf8'),
      writeTextFile: (p, c) => fs.writeFile(p, c, 'utf8'),
      // The real one's shape, not a stand-in for it: a per-write unique temp
      // name (two writes to one path overlap routinely) and a live-set the
      // library's temp sweep asks before it deletes anything of this shape.
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
      trash: (p) => fs.rm(p, { recursive: true, force: true }),
      rename: (from, to) => fs.rename(from, to),
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
        return tmpdir();
      },
    },
  };
});

const {
  library,
  setRoot,
  scanLibrary,
  createProject,
  createChapter,
  openChapter,
  saveOpenChapter,
  closeChapter,
  readChapterSources,
  setPageCleaned,
  replaceCleanedPages,
  applyTranslations,
} = await import('./library.svelte.js');
const { app } = await import('./store.svelte.js');
const { setResidentWindow } = await import('./page-images.js');

// ---------- fixtures ----------
// Real PNGs, written by hand so the bit depth is something this file chose
// rather than something a library decided. Greyscale, because that is what a
// manga raw usually is.

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

// depth 8 or 16, greyscale, a ramp plus a solid band so two files differ.
function pngBytes(w, h, depth, level) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = 0; // colour type 0 - greyscale
  const px = depth === 16 ? 2 : 1;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * px);
    for (let x = 0; x < w; x++) {
      const v = y > h * 0.7 ? level : Math.round((x / w) * 255);
      if (depth === 16) row.writeUInt16BE(v * 257, 1 + x * 2);
      else row[1 + x] = v;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let root;
let srcDir;

// A File-alike over real bytes on disk, which is what the picker hands the
// library: a name, and an arrayBuffer().
function fileFrom(dir, name) {
  return {
    name,
    async arrayBuffer() {
      const buf = await readFile(join(dir, name));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

const RAWS = ['raw-01.png', 'raw-02.png', 'raw-03.png', 'raw-04.png', 'raw-05.png', 'raw-06.png'];
const CLEANED = ['clean-01.png', 'clean-02.png', 'clean-03.png', 'clean-04.png'];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mt-realfs-'));
  srcDir = join(root, 'sources');
  await mkdir(srcDir, { recursive: true });
  // Page 1's raw is 16-bit. Anything that decodes and re-encodes it comes back
  // 8-bit, and the checksum says so.
  for (let i = 0; i < RAWS.length; i++) {
    await writeFile(join(srcDir, RAWS[i]), pngBytes(120, 170, i === 0 ? 16 : 8, (i + 1) * 30));
  }
  for (let i = 0; i < CLEANED.length; i++) {
    await writeFile(join(srcDir, CLEANED[i]), pngBytes(120, 170, 8, 200 + i * 10));
  }
  await writeFile(join(srcDir, 'swap.png'), pngBytes(120, 170, 8, 20));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

// A library per case. One shared root would let a scan see every project every
// earlier case created, which is a property of the test, not of the app.
let caseSeq = 0;

beforeEach(async () => {
  closeChapter();
  const dir = join(root, `library-${++caseSeq}`);
  await mkdir(dir, { recursive: true });
  await setRoot(dir);
  library.projects = [];
});

const raws = () => RAWS.map((n) => fileFrom(srcDir, n));
const cleaned = () => CLEANED.map((n) => fileFrom(srcDir, n));

async function sixAndFour(translations = null) {
  const p = await createProject('Acceptance');
  const c = await createChapter({
    projectId: p.id,
    number: 1,
    title: 'Sources',
    files: raws(),
    cleanedFiles: cleaned(),
    translations,
  });
  return { p, c };
}

const record = async (c) => JSON.parse(await readFile(join(c.dir, 'chapter.json'), 'utf8'));

describe('six raws and four cleaned, on a real disk', () => {
  it('gives the first four pages a cleaned image and leaves the last two on their raw', async () => {
    const { c } = await sixAndFour();
    const rec = await record(c);
    expect(rec.pages.map((pg) => pg.file)).toEqual(RAWS);
    expect(rec.pages.map((pg) => pg.cleaned)).toEqual([...CLEANED, null, null]);
  });

  it('copies every file byte for byte, 16-bit greyscale included', async () => {
    const { c } = await sixAndFour();
    for (const name of RAWS) {
      expect(await readFile(join(c.dir, 'raws', name))).toEqual(await readFile(join(srcDir, name)));
    }
    for (const name of CLEANED) {
      expect(await readFile(join(c.dir, 'cleaned', name))).toEqual(
        await readFile(join(srcDir, name)),
      );
    }
    // Named explicitly, because this is the one a decode would silently break:
    // IHDR byte 8 is the bit depth, byte 9 the colour type.
    const page1 = await readFile(join(c.dir, 'raws', 'raw-01.png'));
    expect(page1[24]).toBe(16);
    expect(page1[25]).toBe(0);
  });

  it('reopens with each page on the image it was typeset on', async () => {
    const { p, c } = await sixAndFour();
    await openChapter(p.id, c.id);
    try {
      expect(app.pages).toHaveLength(6);
      // Pages 1-4 typeset on the cleaned image; 5-6 fall back to their raw.
      // Asserted on the filenames, which every page carries, and not on the
      // blob URLs: those exist only for the pages in the resident window (see
      // page-images.js), so `!!pg.cleaned` answers where the window is, not
      // what each page is typeset on. The residency itself is the next test.
      expect(app.pages.map((pg) => pg.cleanedFile)).toEqual([...CLEANED, null, null]);
      expect(app.pages.every((pg) => !!pg.file)).toBe(true);
      expect(!!app.pages[0].cleaned).toBe(true);
    } finally {
      closeChapter();
    }
  });

  it('holds only a window of page images in memory, and moves it', async () => {
    const { p, c } = await sixAndFour();
    await openChapter(p.id, c.id);
    try {
      // Opening awaits the page being opened and starts its neighbours, so the
      // far end of the chapter is the honest assertion: it has a file on disk
      // and no picture in memory. This is the whole point - a 200-page chapter
      // used to mint all 200 before it drew one.
      expect(!!app.pages[0].raw).toBe(true);
      expect(!!app.pages[5].raw).toBe(false);

      // Move the window to the far end. Awaiting is what makes page 5 present;
      // page 0 is now three pages outside a radius-2 window and is given back.
      await setResidentWindow(app.pages, 5);
      expect(!!app.pages[5].raw).toBe(true);
      expect(!!app.pages[0].raw).toBe(false);
      // The name is untouched by any of it - a released page is a page that can
      // be read again, not a page that has lost its image.
      expect(app.pages[0].file).toBeTruthy();
    } finally {
      closeChapter();
    }
  });

  it('survives a save and a reopen with every pairing intact', async () => {
    const { p, c } = await sixAndFour();
    await openChapter(p.id, c.id);
    app.pages[5].boxes = [
      { id: 'b1', lineN: null, text: 'typeset', x: 1, y: 2, w: 30, h: 10, style: {} },
    ];
    await saveOpenChapter();
    closeChapter();
    await openChapter(p.id, c.id);
    try {
      expect(app.pages.map((pg) => pg.cleanedFile)).toEqual([...CLEANED, null, null]);
      expect(app.pages[5].boxes).toHaveLength(1);
    } finally {
      closeChapter();
    }
  });

  it('applies a translations file to the pages it covers and no further', async () => {
    const { c } = await sixAndFour([
      { lines: [{ n: 1, type: 'dialogue', jp: 'いち', en: 'One' }] },
      { lines: [{ n: 1, type: 'dialogue', jp: 'に', en: 'Two' }] },
      { lines: [{ n: 1, type: 'dialogue', jp: 'さん', en: 'Three' }] },
    ]);
    const rec = await record(c);
    expect(rec.pages.map((pg) => pg.lines[0]?.en ?? null)).toEqual([
      'One',
      'Two',
      'Three',
      null,
      null,
      null,
    ]);
  });
});

describe('changing a chapter’s sources afterwards, on a real disk', () => {
  it('swaps one page’s cleaned image, keeps the old file, and the swap survives a reopen', async () => {
    const { p, c } = await sixAndFour();
    const before = await record(c);
    const pageId = before.pages[1].id;

    const name = await setPageCleaned(p.id, c.id, pageId, fileFrom(srcDir, 'swap.png'));
    expect(name).toBe('swap.png');

    const after = await record(c);
    expect(after.pages.map((pg) => pg.cleaned)).toEqual([
      'clean-01.png',
      'swap.png',
      'clean-03.png',
      'clean-04.png',
      null,
      null,
    ]);
    // The new bytes are the source's, and the image it replaced is kept for undo.
    expect(await readFile(join(c.dir, 'cleaned', 'swap.png'))).toEqual(
      await readFile(join(srcDir, 'swap.png')),
    );
    await expect(readFile(join(c.dir, 'cleaned', 'clean-02.png'))).rejects.toThrow();
    expect(await readFile(join(c.dir, 'logs', 'previous-cleaned', 'clean-02.png'))).toEqual(
      await readFile(join(srcDir, 'clean-02.png')),
    );

    await openChapter(p.id, c.id);
    try {
      expect(app.pages[1].cleanedFile).toBe('swap.png');
    } finally {
      closeChapter();
    }
  });

  it('renames rather than overwrites when the new file shares a name with one already there', async () => {
    const { p, c } = await sixAndFour();
    const before = await record(c);
    // Page 3 gets a file called clean-01.png while page 1 still has one.
    const name = await setPageCleaned(
      p.id,
      c.id,
      before.pages[2].id,
      fileFrom(srcDir, 'clean-01.png'),
    );
    expect(name).toBe('clean-01-2.png');
    const after = await record(c);
    expect(after.pages[0].cleaned).toBe('clean-01.png');
    expect(after.pages[2].cleaned).toBe('clean-01-2.png');
    // Page 1's image is untouched - the second copy landed beside it.
    expect(await readFile(join(c.dir, 'cleaned', 'clean-01.png'))).toEqual(
      await readFile(join(srcDir, 'clean-01.png')),
    );
  });

  it('replaces a subset in bulk and leaves the later pages alone', async () => {
    const { p, c } = await sixAndFour();
    const out = await replaceCleanedPages(p.id, c.id, [
      fileFrom(srcDir, 'swap.png'),
      fileFrom(srcDir, 'clean-04.png'),
    ]);
    expect(out.replaced).toBe(2);
    const rec = await record(c);
    // The picked list is natural-sorted before it is paired, so clean-04 goes
    // to page 1 and swap to page 2 - not the order they were passed in. That is
    // the rule, and it is why the dialog states the pairing before committing.
    // clean-04.png is still claimed by page 4, so the copy lands beside it.
    expect(rec.pages.map((pg) => pg.cleaned)).toEqual([
      'clean-04-2.png',
      'swap.png',
      'clean-03.png',
      'clean-04.png',
      null,
      null,
    ]);
  });

  it('flags a cleaned file that has gone missing instead of dropping the reference', async () => {
    const { p, c } = await sixAndFour();
    await rm(join(c.dir, 'cleaned', 'clean-03.png'));
    const { pages } = await readChapterSources(p.id, c.id);
    expect(pages.map((pg) => pg.missing)).toEqual([false, false, true, false, false, false]);

    // Opening falls back to the raw, and the name is still on the page - so the
    // next save cannot unlink a file the user only has to put back.
    await openChapter(p.id, c.id);
    try {
      expect(app.pages[2].cleaned).toBeNull();
      expect(app.pages[2].cleanedFile).toBe('clean-03.png');
      await saveOpenChapter();
    } finally {
      closeChapter();
    }
    expect((await record(c)).pages[2].cleaned).toBe('clean-03.png');
  });

  it('never shortens the chapter when a shorter translations file is applied later', async () => {
    const { p, c } = await sixAndFour();
    const out = await applyTranslations(p.id, c.id, [
      { lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Only page one' }] },
    ]);
    expect(out).toMatchObject({ covered: 1, kept: 5, ignored: 0 });
    const rec = await record(c);
    expect(rec.pages).toHaveLength(6);
    expect(rec.pages.map((pg) => pg.file)).toEqual(RAWS);
  });
});

describe('a slice 1 chapter on a real disk', () => {
  it('opens unchanged and gains a cleaned key the first time it is saved', async () => {
    const p = await createProject('Legacy');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fileFrom(srcDir, 'raw-01.png'), fileFrom(srcDir, 'raw-02.png')],
    });
    // Exactly what slice 1 wrote: no `cleaned` key on the page at all.
    const rec = await record(c);
    for (const pg of rec.pages) delete pg.cleaned;
    await writeFile(join(c.dir, 'chapter.json'), JSON.stringify(rec, null, 2));

    await openChapter(p.id, c.id);
    try {
      expect(app.pages.map((pg) => pg.file)).toEqual(['raw-01.png', 'raw-02.png']);
      expect(app.pages.map((pg) => pg.cleanedFile)).toEqual([null, null]);
      await saveOpenChapter();
    } finally {
      closeChapter();
    }
    expect((await record(c)).pages.every((pg) => pg.cleaned === null)).toBe(true);
    // And the raws are still the bytes that went in.
    expect(await readFile(join(c.dir, 'raws', 'raw-01.png'))).toEqual(
      await readFile(join(srcDir, 'raw-01.png')),
    );
  });

  // The record is rewritten every 800ms while someone is typing, and an atomic
  // write is a temp file plus a rename. A process killed between the two leaves
  // that temp file beside chapter.json for good - one per crash, forever, in the
  // folder the user browses. The target is never damaged, which is the property
  // the rename buys; the litter is what nobody was clearing up.
  it('sweeps a dead write’s leftover beside the record, and only that shape', async () => {
    const { p, c } = await sixAndFour();
    const litter = join(c.dir, 'chapter.json.9.tmp');
    const theirs = join(c.dir, 'notes.tmp');
    // Our shape of name, but not one of our records: another tool's temp file.
    const tools = join(c.dir, 'translation-draft.1.tmp');
    await writeFile(litter, '{ half a record');
    await writeFile(theirs, 'the letterer’s own file');
    await writeFile(tools, 'another tool’s file');
    const before = await readFile(join(c.dir, 'chapter.json'), 'utf8');

    await openChapter(p.id, c.id);
    try {
      expect(app.pages).toHaveLength(6);
    } finally {
      closeChapter();
    }
    await expect(readFile(litter, 'utf8')).rejects.toThrow();
    expect(await readFile(theirs, 'utf8')).toBe('the letterer’s own file');
    expect(await readFile(tools, 'utf8')).toBe('another tool’s file');
    // The record the sweep walked past is byte-identical.
    expect(await readFile(join(c.dir, 'chapter.json'), 'utf8')).toBe(before);
  });

  it('is found by a scan of a real directory tree', async () => {
    await sixAndFour();
    library.projects = [];
    await scanLibrary();
    expect(library.error).toBe('');
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].chapters[0].pageCount).toBe(6);
  });
});
