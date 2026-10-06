import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
  // The atomic writes below mint these, exactly as the real fsx does.
  const live = new Set();
  let tmpSeq = 0;
  // A write into a directory that does not exist fails, the way the real one
  // does. Without this, deleting an mkdir anywhere in the library would not
  // break a single test. Kept off the object: tests swap these methods for
  // arrows that call the original unbound.
  const requireParent = (p) => {
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (parent && !tree.dirs.has(parent)) throw new Error('ENOENT ' + parent);
  };
  return {
    fsx: {
      _tree: tree,
      // Directories AND files, because the library reads this listing for two
      // things now: the chapter folders under a project, and the leftover temp
      // files a crashed atomic write leaves beside a record.
      async readDir(p) {
        const prefix = p.endsWith('/') ? p : p + '/';
        const out = [];
        const names = new Set();
        for (const d of tree.dirs) {
          if (d.startsWith(prefix)) {
            const rest = d.slice(prefix.length);
            if (rest && !rest.includes('/') && !names.has(rest)) {
              names.add(rest);
              out.push({ name: rest, isDirectory: true, isFile: false });
            }
          }
        }
        for (const f of tree.files.keys()) {
          if (f.startsWith(prefix)) {
            const rest = f.slice(prefix.length);
            if (rest && !rest.includes('/') && !names.has(rest)) {
              names.add(rest);
              out.push({ name: rest, isDirectory: false, isFile: true });
            }
          }
        }
        return out;
      },
      async readTextFile(p) {
        if (!tree.files.has(p)) throw new Error('ENOENT ' + p);
        return tree.files.get(p);
      },
      async writeTextFile(p, c) {
        requireParent(p);
        tree.files.set(p, c);
      },
      // The mechanics, not just the contract. It used to be modelled as a plain
      // write, and the whole point of the real one - that the target is only
      // ever touched by a rename, so a write that dies leaves the previous
      // contents standing and a temp file beside them - was exercised nowhere
      // above fsx.test.js. The library now depends on both halves: it sweeps the
      // leftovers (`sweepTemps`) and it asks which of them a write still holds
      // (`liveTemps`), and neither could be tested against a mock that renames
      // nothing.
      //
      // Routed through this object's own methods, so a test that swaps in a disk
      // which cannot write still breaks the writes it means to break - it just
      // sees the temp path now. `_targetOf` is how such a test names the file a
      // write is ultimately for.
      async writeTextFileAtomic(p, c) {
        const tmp = `${p}.${++tmpSeq}.tmp`;
        live.add(tmp);
        try {
          await this.writeTextFile(tmp, c);
          await this.rename(tmp, p);
        } catch (e) {
          tree.files.delete(tmp);
          throw e;
        } finally {
          live.delete(tmp);
        }
      },
      async rename(from, to) {
        if (!tree.files.has(from)) throw new Error('ENOENT ' + from);
        requireParent(to);
        tree.files.set(to, tree.files.get(from));
        tree.files.delete(from);
      },
      liveTemps() {
        return new Set(live);
      },
      _targetOf(p) {
        return String(p).replace(/\.\d+\.tmp$/, '');
      },
      // Mirrors `{ recursive: true }`: every ancestor comes into being too, so
      // a directory the app created is visible to `exists` at every level.
      async mkdir(p) {
        const parts = p.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          if (d) tree.dirs.add(d);
        }
      },
      // `{ recursive: true }` on a directory, and an ordinary unlink when the
      // path is a file - removing a single cleaned page is the latter.
      async remove(p) {
        for (const d of [...tree.dirs]) if (d === p || d.startsWith(p + '/')) tree.dirs.delete(d);
        for (const f of [...tree.files.keys()]) if (f === p || f.startsWith(p + '/')) tree.files.delete(f);
      },
      async exists(p) {
        return tree.dirs.has(p) || tree.files.has(p);
      },
      async join(...parts) {
        return parts.join('/');
      },
      async homeDir() {
        return '/home/u';
      },
      async readFile(p) {
        return tree.files.get(p) ?? new Uint8Array();
      },
      async writeFile(p, bytes) {
        requireParent(p);
        tree.files.set(p, bytes);
      },
    },
  };
});

const { fsx } = await import('./fsx.js');
const {
  library,
  setRoot,
  scanLibrary,
  createProject,
  setProjectOcrLanguage,
  deleteProject,
  deleteChapter,
  projectById,
  createChapterFromPages,
  readChapterPackageSources,
} = await import('./library.svelte.js');

function seedProject(slug, json, chapters = []) {
  fsx._tree.dirs.add(`/lib/${slug}`);
  fsx._tree.files.set(`/lib/${slug}/project.json`, json);
  for (const [cslug, cjson] of chapters) {
    fsx._tree.dirs.add(`/lib/${slug}/${cslug}`);
    fsx._tree.files.set(`/lib/${slug}/${cslug}/chapter.json`, cjson);
  }
}

const PROJECT = (id, name) =>
  JSON.stringify({ schema: 1, id, name, createdAt: 'T0', updatedAt: 'T0', coverChapterId: null, coverPageId: null });

const CHAPTER = (id, number, pages) =>
  JSON.stringify({ schema: 1, id, number, title: '', createdAt: 'T0', updatedAt: 'T0', pages });

beforeEach(async () => {
  fsx._tree.dirs.clear();
  fsx._tree.files.clear();
  fsx._tree.dirs.add('/lib');
  await setRoot('/lib');
});

describe('scanLibrary', () => {
  it('finds projects and their chapters', async () => {
    seedProject('one-piece', PROJECT('p1', 'One Piece'), [['001', CHAPTER('c1', 1, [{ id: 1 }, { id: 2 }])]]);
    await scanLibrary();
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].name).toBe('One Piece');
    expect(library.projects[0].chapters[0].pageCount).toBe(2);
  });

  it('skips a corrupt project.json without failing the scan', async () => {
    seedProject('good', PROJECT('p1', 'Good'));
    fsx._tree.dirs.add('/lib/bad');
    fsx._tree.files.set('/lib/bad/project.json', '{ this is not json');
    await scanLibrary();
    expect(library.projects.filter((p) => !p.unreadable)).toHaveLength(1);
    expect(library.projects.filter((p) => p.unreadable)).toHaveLength(1);
    expect(library.error).toBeTruthy();
  });

  it('ignores directories with no project.json', async () => {
    fsx._tree.dirs.add('/lib/.DS_Store_dir');
    await scanLibrary();
    expect(library.projects).toHaveLength(0);
  });

  it('records whether a chapter has any typesetting on it', async () => {
    const BOXED = JSON.stringify({
      schema: 1,
      id: 'c2',
      number: 2,
      title: '',
      createdAt: 'T0',
      updatedAt: 'T0',
      pages: [{ id: 1, boxes: [{ id: 'b1', lineN: 1 }] }],
    });
    seedProject('t', PROJECT('p1', 'T'), [
      ['001', CHAPTER('c1', 1, [{ id: 1 }, { id: 2 }])],
      ['002', BOXED],
    ]);
    await scanLibrary();
    const [raws, typeset] = library.projects[0].chapters;
    expect(raws.typeset).toBe(false);
    expect(typeset.typeset).toBe(true);
  });

  it('sorts chapters by number', async () => {
    seedProject('x', PROJECT('p1', 'X'), [
      ['010', CHAPTER('c10', 10, [])],
      ['002', CHAPTER('c2', 2, [])],
    ]);
    await scanLibrary();
    expect(library.projects[0].chapters.map((c) => c.number)).toEqual([2, 10]);
  });

  it('flags a duplicated project folder instead of keying two cards on one id', async () => {
    // Duplicating a folder inside the library root is the obvious way to back
    // one up, and it copies the id along with everything else.
    seedProject('one-piece', PROJECT('p1', 'One Piece'));
    seedProject('one-piece-backup', PROJECT('p1', 'One Piece'));
    await scanLibrary();
    expect(library.projects).toHaveLength(2);
    // The {#each} key holds, so the grid neither throws nor mis-associates.
    expect(new Set(library.projects.map((p) => p.id)).size).toBe(2);
    // The first one keeps the id and stays usable; the copy is inert, so a
    // delete cannot remove one directory and leave the other entry behind.
    expect(projectById('p1').slug).toBe('one-piece');
    const flagged = library.projects.filter((p) => p.duplicate);
    expect(flagged.map((p) => p.slug)).toEqual(['one-piece-backup']);
    expect(flagged[0].unreadable).toBe(true);
    expect(library.error).toMatch(/one-piece-backup/);
  });

  it('flags a duplicated chapter folder the same way', async () => {
    seedProject('x', PROJECT('p1', 'X'), [
      ['001', CHAPTER('c1', 1, [{ id: 1 }])],
      ['001-copy', CHAPTER('c1', 1, [{ id: 1 }])],
    ]);
    await scanLibrary();
    const chapters = library.projects[0].chapters;
    expect(new Set(chapters.map((c) => c.id)).size).toBe(2);
    expect(chapters.filter((c) => c.duplicate).map((c) => c.slug)).toEqual(['001-copy']);
    expect(library.error).toMatch(/001-copy/);
  });

  it('keeps the boot failure on screen instead of scanning nowhere', async () => {
    // What a failed initRoot leaves behind: no root, and a message the library
    // screen is already rendering. The scan the screen runs on mount - and the
    // retry button that lands back here - must not wipe it.
    await setRoot('');
    library.error = 'Could not work out where your library lives: no home directory';
    await scanLibrary();
    expect(library.loading).toBe(false);
    expect(library.projects).toHaveLength(0);
    expect(library.error).toMatch(/Could not work out where your library lives/);
  });

  it('lets the newer scan win when a blocked one settles late', async () => {
    // Scan A goes out against the old root and blocks - on this machine that was
    // a macOS folder-permission prompt sitting unanswered at boot.
    fsx._tree.dirs.add('/old');
    await setRoot('/old');
    let refuse;
    const blocked = new Promise((_, reject) => {
      refuse = reject;
    });
    // The prompt sits in front of the very first call the scan makes, so the
    // old root is the one this scan is provably reading.
    const origExists = fsx.exists;
    fsx.exists = async (p) => (p === '/old' ? blocked : origExists(p));
    const scanA = scanLibrary();

    try {
      // The user takes the app's own documented recovery - Settings ▸ Change
      // folder - and scan B reads the new root successfully.
      seedProject('kept', PROJECT('p1', 'Kept'));
      await setRoot('/lib');
      await scanLibrary();
      expect(library.projects.map((p) => p.slug)).toEqual(['kept']);

      // Only now does the blocked scan give up.
      refuse(
        new Error('failed to read directory at path: /old with error: Operation not permitted'),
      );
      await scanA;
    } finally {
      fsx.exists = origExists;
    }

    // The freshly scanned library survives, and the user is not told that the
    // folder they are looking at cannot be read.
    expect(library.projects.map((p) => p.slug)).toEqual(['kept']);
    expect(library.error).toBe('');
    // The flag belongs to the scan that finished last in sequence, not in time.
    expect(library.loading).toBe(false);
  });

  it('names the root it actually read when a scan fails', async () => {
    await setRoot('/old');
    const origReadDir = fsx.readDir;
    fsx.readDir = async (p) => {
      if (p === '/old') throw new Error('Operation not permitted');
      return origReadDir(p);
    };
    try {
      fsx._tree.dirs.add('/old');
      await scanLibrary();
    } finally {
      fsx.readDir = origReadDir;
    }
    expect(library.error).toMatch(/library at \/old/);
    expect(library.error).not.toMatch(/\/lib\b/);
  });

  it('marks a corrupt chapter.json as unreadable without failing the scan', async () => {
    seedProject('y', PROJECT('p1', 'Y'), [['001', CHAPTER('c1', 1, [])]]);
    fsx._tree.dirs.add('/lib/y/002');
    fsx._tree.files.set('/lib/y/002/chapter.json', '{ this is not json');
    fsx._tree.dirs.add('/lib/y/no-marker');
    await scanLibrary();
    const chapters = library.projects[0].chapters;
    expect(chapters.filter((c) => !c.unreadable)).toHaveLength(1);
    expect(chapters.filter((c) => c.unreadable)).toHaveLength(1);
    expect(chapters.find((c) => c.slug === 'no-marker')).toBeUndefined();
    expect(library.error).toBeTruthy();
  });
});

describe('createProject', () => {
  it('writes project.json and appears in the catalogue', async () => {
    const p = await createProject('New Series');
    expect(p.slug).toBe('new-series');
    expect(fsx._tree.files.has('/lib/new-series/project.json')).toBe(true);
    expect(projectById(p.id)).toBeTruthy();
  });

  it('avoids a directory collision on a duplicate name', async () => {
    await createProject('Dup');
    const second = await createProject('Dup');
    expect(second.slug).toBe('dup-2');
  });

  it('never writes into an existing directory the scan never saw', async () => {
    // The user's own folder, holding the only copies of their raws. It carries
    // no project.json, so the scan ignores it and the catalogue has no idea it
    // is there - which is exactly why the check has to reach the disk.
    fsx._tree.dirs.add('/lib/one-piece');
    fsx._tree.files.set('/lib/one-piece/ch1-p001.png', new Uint8Array([7]));

    const p = await createProject('One Piece');

    expect(p.slug).toBe('one-piece-2');
    expect(fsx._tree.files.has('/lib/one-piece/project.json')).toBe(false);
    expect(fsx._tree.files.has('/lib/one-piece-2/project.json')).toBe(true);
    // And the folder is still theirs: deleting the project they just made
    // cannot reach it.
    await deleteProject(p.id);
    expect(fsx._tree.files.get('/lib/one-piece/ch1-p001.png')).toEqual(new Uint8Array([7]));
  });
});

describe('deleteProject', () => {
  it('removes the directory and the catalogue entry', async () => {
    const p = await createProject('Gone');
    await deleteProject(p.id);
    expect(fsx._tree.dirs.has('/lib/gone')).toBe(false);
    expect(projectById(p.id)).toBeUndefined();
  });
});

const { withinHome } = await import('./library.svelte.js');

// $HOME/** is the only filesystem scope this app is granted, so a root outside
// it is refused - which makes the comparison the one thing standing between a
// Windows user and a library they cannot choose.
describe('withinHome', () => {
  it('accepts the home directory and what is under it, and nothing else', async () => {
    expect(await withinHome('/home/u')).toBe(true);
    expect(await withinHome('/home/u/')).toBe(true);
    expect(await withinHome('/home/u/Documents/Manga')).toBe(true);
    expect(await withinHome('/elsewhere')).toBe(false);
    // Not a prefix match on the string: a sibling whose name starts with the
    // home directory's is outside it.
    expect(await withinHome('/home/u2/Manga')).toBe(false);
  });

  it('reads a Windows path as the path it is', async () => {
    // `homeDir()` answers `C:\Users\u` there, and the folder picker hands back
    // backslashes too. Compared with '/' written into the test, every valid
    // Windows path failed and Settings refused the folder the user just chose.
    const orig = fsx.homeDir;
    fsx.homeDir = async () => 'C:\\Users\\u';
    try {
      expect(await withinHome('C:\\Users\\u\\Documents\\Manga')).toBe(true);
      expect(await withinHome('c:\\users\\u\\documents\\manga')).toBe(true);
      expect(await withinHome('C:\\USERS\\U\\DOCUMENTS\\MANGA')).toBe(true);
      expect(await withinHome('C:\\Users\\u')).toBe(true);
      expect(await withinHome('c:\\users\\u')).toBe(true);
      expect(await withinHome('C:\\Users\\u2\\Manga')).toBe(false);
      expect(await withinHome('D:\\Manga')).toBe(false);
    } finally {
      fsx.homeDir = orig;
    }
  });
});

describe('deleteChapter', () => {
  it('removes the chapter directory and entry without touching the project', async () => {
    const p = await createProject('Keep');
    fsx._tree.dirs.add('/lib/keep/001');
    fsx._tree.files.set('/lib/keep/001/chapter.json', CHAPTER('c1', 1, []));
    await scanLibrary();
    const chapter = projectById(p.id).chapters[0];
    await deleteChapter(p.id, chapter.id);
    expect(fsx._tree.dirs.has('/lib/keep/001')).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
    expect(fsx._tree.dirs.has('/lib/keep')).toBe(true);
    expect(fsx._tree.files.has('/lib/keep/project.json')).toBe(true);
  });
});

const { createChapter } = await import('./library.svelte.js');

function fakeFile(name, byte) {
  return { name, arrayBuffer: async () => new Uint8Array([byte]).buffer };
}

describe('createChapter', () => {
  it('writes chapter.json with one page per file, in natural order', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 3,
      title: 'The Duel',
      files: [fakeFile('page10.png', 10), fakeFile('page2.png', 2)],
    });
    expect(c.slug).toBe('003-the-duel');
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    expect(json.pages.map((pg) => pg.file)).toEqual(['page2.png', 'page10.png']);
  });

  it('appears in the project catalogue immediately', async () => {
    const p = await createProject('Series');
    await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    expect(projectById(p.id).chapters).toHaveLength(1);
  });

  it('rolls back the directory when a copy fails', async () => {
    const p = await createProject('Series');
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({ projectId: p.id, number: 1, title: '', files: [broken] }),
    ).rejects.toThrow();
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
  });

  it('sidesteps an existing directory rather than merging into it', async () => {
    const p = await createProject('Series');
    fsx._tree.dirs.add(`${p.dir}/001`);
    fsx._tree.files.set(`${p.dir}/001/scan-001.png`, new Uint8Array([9]));
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    expect(c.slug).toBe('001-2');
    expect(fsx._tree.files.has(`${p.dir}/001/chapter.json`)).toBe(false);
    expect(fsx._tree.files.get(`${p.dir}/001/scan-001.png`)).toEqual(new Uint8Array([9]));
  });

  it("rolls back nothing when the directory was not this run's to remove", async () => {
    const p = await createProject('Series');
    fsx._tree.dirs.add(`${p.dir}/001`);
    fsx._tree.files.set(`${p.dir}/001/scan-001.png`, new Uint8Array([9]));
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({ projectId: p.id, number: 1, title: '', files: [broken] }),
    ).rejects.toThrow();
    // The rollback took out the directory this run made, and left the one it
    // stepped around completely alone.
    expect(fsx._tree.dirs.has(`${p.dir}/001-2`)).toBe(false);
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(true);
    expect(fsx._tree.files.get(`${p.dir}/001/scan-001.png`)).toEqual(new Uint8Array([9]));
  });

  it('removes nothing at all when the directory could not be created', async () => {
    const p = await createProject('Series');
    const removed = [];
    const origMkdir = fsx.mkdir;
    const origRemove = fsx.remove;
    fsx.mkdir = async () => {
      throw new Error('read-only filesystem');
    };
    fsx.remove = async (path) => {
      removed.push(path);
      return origRemove(path);
    };
    try {
      await expect(
        createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] }),
      ).rejects.toThrow('read-only filesystem');
    } finally {
      fsx.mkdir = origMkdir;
      fsx.remove = origRemove;
    }
    expect(removed).toEqual([]);
  });

  it('dedupes colliding filenames instead of overwriting on disk', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('page.png', 1), fakeFile('page.png', 2)],
    });
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    const names = json.pages.map((pg) => pg.file);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(fsx._tree.files.has(`${c.dir}/raws/${name}`)).toBe(true);
    }
    const bytesA = fsx._tree.files.get(`${c.dir}/raws/${names[0]}`);
    const bytesB = fsx._tree.files.get(`${c.dir}/raws/${names[1]}`);
    expect(bytesA).not.toEqual(bytesB);
  });

  it('rolls back when the project.json write fails after raws and chapter.json succeed', async () => {
    const orig = fsx.writeTextFile;
    let projectWrites = 0;
    fsx.writeTextFile = async (path, contents) => {
      if (fsx._targetOf(path).endsWith('/project.json')) {
        projectWrites++;
        // First write is createProject's own project.json; the second is the
        // one createChapter performs after copying raws and writing chapter.json.
        if (projectWrites === 2) throw new Error('disk full');
      }
      return orig(path, contents);
    };
    let p;
    try {
      p = await createProject('Series');
      await expect(
        createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] }),
      ).rejects.toThrow();
    } finally {
      fsx.writeTextFile = orig;
    }
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
    expect(projectById(p.id).coverChapterId).toBeNull();
  });
});

// The project's cover art is one chapter's first page, and `buildChapter`
// decides whether to offer a new one on `!p.coverChapterId` alone. So an id left
// naming a chapter that has been deleted is not a stale field - it is a project
// that can never have a thumbnail again, however many chapters are imported into
// it afterwards.
describe('deleting the chapter the project cover came from', () => {
  const projectJson = (p) => JSON.parse(fsx._tree.files.get(`${p.dir}/project.json`));

  it('gives the cover up rather than leaving it naming nothing', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    expect(projectById(p.id).coverChapterId).toBe(c.id);

    await deleteChapter(p.id, c.id);

    // In memory and on disk both - a catalogue that agreed and a project.json
    // that did not would come back wrong on the next scan.
    expect(projectById(p.id).coverChapterId).toBeNull();
    expect(projectJson(p).coverChapterId).toBeNull();
    expect(projectJson(p).coverPageId).toBeNull();
  });

  it('lets the next import become the cover again', async () => {
    const p = await createProject('Series');
    const first = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    await deleteChapter(p.id, first.id);

    const second = await createChapter({ projectId: p.id, number: 2, title: '', files: [fakeFile('b.png', 2)] });
    // The whole point of clearing it: this used to be `false` forever.
    expect(projectById(p.id).coverChapterId).toBe(second.id);
    expect(projectJson(p).coverChapterId).toBe(second.id);
  });

  it('leaves the cover alone when some other chapter goes', async () => {
    const p = await createProject('Series');
    const cover = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    const other = await createChapter({ projectId: p.id, number: 2, title: '', files: [fakeFile('b.png', 2)] });
    const before = projectJson(p);

    await deleteChapter(p.id, other.id);

    expect(projectById(p.id).coverChapterId).toBe(cover.id);
    // Not rewritten at all: a delete that touches nothing has nothing to say.
    expect(projectJson(p)).toEqual(before);
  });

  it('keeps the layout when it does have to rewrite project.json', async () => {
    // The rewrite is whole-record, and the layout is chosen once at creation and
    // can never be chosen again - losing it here would silently turn a webtoon
    // project back into a paged one.
    const p = await createProject('Webtoon', { layout: 'longstrip' });
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    await deleteChapter(p.id, c.id);
    expect(projectJson(p).layout).toBe('longstrip');
    await scanLibrary();
    expect(projectById(p.id).layout).toBe('longstrip');
  });
});

// Staging the thumbnail during chapter creation ensures that a mid-import failure
// never unlinks or overwrites an existing project-level thumb.png, and leaves
// no orphaned thumbnail file when creating the project's first chapter.
describe('cover thumbnail lifecycle and rollback', () => {
  function withThumbSupport(fn) {
    const origImage = globalThis.Image;
    const origDocument = globalThis.document;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;

    URL.createObjectURL = () => 'blob:fake-thumb';
    URL.revokeObjectURL = () => {};
    globalThis.Image = class {
      set src(_) {
        this.naturalWidth = 100;
        this.naturalHeight = 100;
        setTimeout(() => this.onload?.(), 0);
      }
    };
    globalThis.document = {
      createElement(tag) {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              imageSmoothingQuality: 'high',
              drawImage: () => {},
            }),
            toBlob: (cb) => cb(new Blob([new Uint8Array([99, 100])])),
          };
        }
        return {};
      },
    };

    return fn().finally(() => {
      globalThis.Image = origImage;
      globalThis.document = origDocument;
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    });
  }

  it('preserves existing project thumb.png when a subsequent chapter import fails', async () => {
    const p = await createProject('Series');
    await withThumbSupport(() =>
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('a.png', 1)],
      }),
    );
    expect(fsx._tree.files.get(`${p.dir}/thumb.png`)).toEqual(new Uint8Array([99, 100]));
    expect(projectById(p.id).coverChapterId).toBeTruthy();

    // Second chapter import fails during page copy
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await withThumbSupport(async () => {
      await expect(
        createChapter({
          projectId: p.id,
          number: 2,
          title: '',
          files: [broken],
        }),
      ).rejects.toThrow();
    });

    // The project's existing thumb.png must be completely preserved
    expect(fsx._tree.files.get(`${p.dir}/thumb.png`)).toEqual(new Uint8Array([99, 100]));
  });

  it('leaves no thumb.png behind when the first chapter import fails during copy', async () => {
    const p = await createProject('Series');
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await withThumbSupport(async () => {
      await expect(
        createChapter({
          projectId: p.id,
          number: 1,
          title: '',
          files: [broken],
        }),
      ).rejects.toThrow();
    });

    expect(fsx._tree.files.has(`${p.dir}/thumb.png`)).toBe(false);
  });

  it('rolls back thumb.png if project.json write fails after thumbnail is written', async () => {
    const orig = fsx.writeTextFile;
    let projectWrites = 0;
    fsx.writeTextFile = async (path, contents) => {
      if (fsx._targetOf(path).endsWith('/project.json')) {
        projectWrites++;
        if (projectWrites === 2) throw new Error('disk full');
      }
      return orig(path, contents);
    };

    try {
      const p = await createProject('Series');
      await withThumbSupport(async () => {
        await expect(
          createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] }),
        ).rejects.toThrow();
      });
      expect(fsx._tree.files.has(`${p.dir}/thumb.png`)).toBe(false);
    } finally {
      fsx.writeTextFile = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// what a page knows about its own size on the day it is imported
// ---------------------------------------------------------------------------
//
// A page's `w`/`h` is its coordinate space: box geometry is in it, the exporters
// size their documents to it, and the store treats `0` as "nobody has measured
// this yet" rather than as a size (see `hasPageSpace`). Until createChapter
// measured, the ONLY thing in the app that ever decoded an image was the canvas,
// one page at a time as the user opened it - so a 28-page chapter had 23 pages
// stored 0x0, and Export All ran the whole chapter through a zero.
//
// The measurement runs through `createImageBitmap`, which this environment has
// not got: node is exactly the "no decoder at all" case the import has to
// survive, so every case here installs its own. A decoder keyed by the file's
// one byte, because `fakeFile(name, byte)` is what the rest of this file builds
// pages out of.
function withDecoder(sizes, fn) {
  const real = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (blob) => {
    const [byte] = new Uint8Array(await blob.arrayBuffer());
    const size = sizes[byte];
    if (!size) throw new Error('unsupported image');
    return { ...size, close() {} };
  };
  return fn().finally(() => {
    globalThis.createImageBitmap = real;
  });
}

describe('createChapter measures its pages', () => {
  const pageSizes = (c) =>
    JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`)).pages.map((pg) => [pg.w, pg.h]);

  it('stores each raw page at the size the decoder read off its bytes', async () => {
    const p = await createProject('Series');
    const c = await withDecoder(
      { 1: { width: 1080, height: 1535 }, 2: { width: 2160, height: 1535 } },
      () =>
        createChapter({
          projectId: p.id,
          number: 1,
          title: '',
          files: [fakeFile('a.png', 1), fakeFile('b.png', 2)],
        }),
    );
    // Per page, not per chapter: a double-page spread is a different size from
    // the pages either side of it, and one number for the chapter would draw it
    // stretched for the whole of the user's session.
    expect(pageSizes(c)).toEqual([
      [1080, 1535],
      [2160, 1535],
    ]);
  });

  it('leaves a page it could not decode unmeasured rather than guessing at it', async () => {
    const p = await createProject('Series');
    const c = await withDecoder({ 1: { width: 1080, height: 1535 } }, () =>
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('a.png', 1), fakeFile('corrupt.png', 9)],
      }),
    );
    // 0, not PAGE_W/PAGE_H and not the neighbour's size: the store adopts a
    // first measurement from 0 without moving anything, and adopts one from a
    // *learned* space by dragging every box on the page across the difference.
    // A guess here would be defended later as if it had been measured.
    expect(pageSizes(c)).toEqual([
      [1080, 1535],
      [0, 0],
    ]);
    // The page is still a page - an undecodable file is copied and kept, and
    // the canvas gets another go at measuring it when the user opens it.
    expect(JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`)).pages).toHaveLength(2);
  });

  it('measures the cleaned raster, not the raw, when a page has both', async () => {
    const p = await createProject('Series');
    const c = await withDecoder(
      { 1: { width: 1080, height: 1535 }, 2: { width: 2160, height: 3070 } },
      () =>
        createChapter({
          projectId: p.id,
          number: 1,
          title: '',
          files: [fakeFile('raw.png', 1)],
          cleanedFiles: [fakeFile('clean.png', 2)],
        }),
    );
    // Everything that draws a page draws `cleaned ?? raw`, so the cleaned
    // raster's size IS the page's space. Storing the raw's would put every box
    // the user places into a coordinate system nothing on screen is drawn in.
    expect(pageSizes(c)).toEqual([[2160, 3070]]);
  });

  it('takes a page back to unmeasured when its cleaned raster will not decode', async () => {
    const p = await createProject('Series');
    const c = await withDecoder({ 1: { width: 1080, height: 1535 } }, () =>
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('raw.png', 1)],
        cleanedFiles: [fakeFile('clean.png', 9)],
      }),
    );
    // The raw's measurement is a true fact about a file this page no longer
    // displays. Kept, it would be a stored page size the exporter renders at,
    // with the cleaned art stretched into a shape it never had.
    expect(pageSizes(c)).toEqual([[0, 0]]);
  });

  it('imports normally where there is no image decoder at all', async () => {
    // The headless case, and the one this whole file runs in: no
    // `createImageBitmap`, so nothing is measured and nothing is invented. An
    // import must not fail because the environment cannot decode a PNG.
    expect(globalThis.createImageBitmap).toBeUndefined();
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    expect(pageSizes(c)).toEqual([[0, 0]]);
  });
});

const { openChapter, saveOpenChapter, closeChapter, chapterById, flushBeforeLeaving, resetSaveFailures } =
  await import('./library.svelte.js');
const { app, markUnsaved, page, loadProjectPages } = await import('./store.svelte.js');
const {
  readChapterSources,
  replaceCleanedPages,
  setPageCleaned,
  clearPageCleaned,
  removeAllCleaned,
  applyTranslations,
} = await import('./library.svelte.js');
const { route, goEditor, goLibrary, resetRoute } = await import('./route.svelte.js');

// The editor store is module-global, so no case may inherit another's open
// chapter - a stale chapterRef would let a save land in the wrong file.
beforeEach(() => closeChapter());

// A chapter with two same-named picked files, so the on-disk names are deduped
// and `pages[].file` is provably not the name the user picked.
async function seedOpenChapter() {
  const p = await createProject('Series');
  const c = await createChapter({
    projectId: p.id,
    number: 1,
    title: '',
    files: [fakeFile('page.png', 1), fakeFile('page.png', 2)],
  });
  await openChapter(p.id, c.id);
  return { p, c };
}

const chapterJson = (c) => JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));

const { tags, createTag, findTag, rememberTagSize, tagSize } = await import('./tags.svelte.js');

describe('tag registry per project', () => {
  const projectJson = (p) => JSON.parse(fsx._tree.files.get(`${p.dir}/project.json`));
  const chapterIn = (p) =>
    createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('page.png', 1)] });

  it('is written into project.json and does not follow the user into another project', async () => {
    const a = await createProject('Series A');
    const ca = await chapterIn(a);
    await openChapter(a.id, ca.id);
    createTag('sfx', { font: 'Bangers', outline: '#000000', outlineWidth: 5 });
    rememberTagSize('sfx', 60);
    // Let the chained project.json write land.
    await new Promise((r) => setTimeout(r, 0));
    expect(projectJson(a).tags).toEqual([{ name: 'sfx', font: 'Bangers', outline: '#000000', outlineWidth: 5, size: null }]);
    expect(projectJson(a).tagSizes).toEqual({ sfx: 60 });
    closeChapter();
    expect(tags.list).toEqual([]);
    expect(tags.sizes).toEqual({});

    const b = await createProject('Series B');
    const cb = await chapterIn(b);
    await openChapter(b.id, cb.id);
    expect(findTag('sfx')).toBeNull();
    expect(tagSize('sfx')).toBeNull();
    expect(projectJson(b).tags).toEqual([]);
    closeChapter();

    // Back in A the vocabulary is still A's.
    await openChapter(a.id, ca.id);
    expect(findTag('sfx')?.font).toBe('Bangers');
    expect(tagSize('sfx')).toBe(60);
    closeChapter();
  });

  it('survives a chapter import, which rewrites project.json whole', async () => {
    const a = await createProject('Series A');
    const ca = await chapterIn(a);
    await openChapter(a.id, ca.id);
    createTag('sfx', { font: 'Bangers' });
    await new Promise((r) => setTimeout(r, 0));
    closeChapter();
    await createChapter({ projectId: a.id, number: 2, title: '', files: [fakeFile('p2.png', 1)] });
    expect(projectJson(a).tags.map((t) => t.name)).toEqual(['sfx']);
  });

  it('reads a project written with its own registry, and gives a pre-registry project an empty one', async () => {
    seedProject('own', JSON.stringify({ ...JSON.parse(PROJECT('p1', 'Own')), tags: [{ name: 'SFX', font: 'Bangers' }], tagSizes: { sfx: 44, bad: 'x' } }));
    seedProject('old', PROJECT('p2', 'Old'));
    await scanLibrary();
    expect(projectById('p1').tags).toEqual([{ name: 'sfx', font: 'Bangers', outline: null, outlineWidth: null, size: null }]);
    expect(projectById('p1').tagSizes).toEqual({ sfx: 44 });
    // No legacy localStorage in node, so nothing to adopt.
    expect(projectById('p2').tags).toEqual([]);
    expect(projectById('p2').tagSizes).toEqual({});
  });
});

describe('openChapter', () => {
  it('loads a page per record entry and resolves raws by file name', async () => {
    const { p, c } = await seedOpenChapter();
    expect(app.pages).toHaveLength(2);
    expect(app.pages.every((pg) => String(pg.raw).startsWith('blob:'))).toBe(true);
    expect(app.chapterRef).toEqual({ projectId: p.id, chapterId: c.id });
    expect(app.saved).toBe(true);
    closeChapter();
  });

  it('keeps the typesetting when a raw is missing from disk', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    const record = chapterJson(c);
    record.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    fsx._tree.files.delete(`${c.dir}/raws/${record.pages[0].file}`);
    const orig = fsx.readFile;
    fsx.readFile = async (path) => {
      if (!fsx._tree.files.has(path)) throw new Error('ENOENT ' + path);
      return orig(path);
    };
    try {
      await openChapter(p.id, c.id);
    } finally {
      fsx.readFile = orig;
    }
    expect(app.pages[0].raw).toBeNull();
    expect(app.pages[0].lines).toHaveLength(1);
    // The reference survives the missing file, so the next save cannot orphan
    // the raw by writing an empty name over it.
    expect(app.pages[0].file).toBe(record.pages[0].file);
    closeChapter();
  });

  it('writes back the ids it had to repair instead of reminting them every session', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    // What the PSD importer wrote before it numbered ids across the document:
    // page two answers to the same ids as page one. The loader repairs that on
    // the way in, but the repair is only worth anything if it reaches the file -
    // otherwise which id a box gets depends on how many chapters were opened
    // first, and it changes every session.
    const record = chapterJson(c);
    const dupe = (id) => ({ id, lineN: null, text: 'x', x: 0, y: 0, w: 10, h: 10, style: {} });
    record.pages[0].boxes = [dupe('b1'), dupe('b2')];
    record.pages[1].boxes = [dupe('b1')];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));

    await openChapter(p.id, c.id);
    const ids = app.pages.flatMap((pg) => pg.boxes.map((b) => b.id));
    expect(new Set(ids).size).toBe(3);
    // A repair is unsaved work. An open that changed nothing still comes up
    // saved - that case is covered above.
    expect(app.saved).toBe(false);
    await saveOpenChapter();
    expect(chapterJson(c).pages.flatMap((pg) => pg.boxes.map((b) => b.id))).toEqual(ids);
    closeChapter();
  });

  it('a close during a slow open supersedes the load, so a later save cannot write an empty document', async () => {
    // The interleaving that cost a real chapter its pages: the user clicks a
    // chapter, backs out of the editor while the first page's image is still
    // being read, and then toggles the chapter's mode from the project screen.
    // Before `closeChapter` bumped `openSeq`, the parked load resumed after the
    // close, re-established `chapterRef`/`loadedRef` over a document the close
    // had already emptied, and the toggle's `markUnsaved` autosaved `pages: []`
    // over the chapter's only copy.
    const { p, c } = await seedOpenChapter();
    closeChapter();
    // Measured pages, so the open's only `readFile` is the page-image mint -
    // which parks the load exactly at the await the real interleaving hit.
    const record = chapterJson(c);
    for (const pg of record.pages) {
      pg.w = 100;
      pg.h = 200;
    }
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));

    const orig = fsx.readFile;
    let release;
    const gate = new Promise((r) => (release = r));
    fsx.readFile = async (path) => {
      await gate;
      return orig(path);
    };
    let open;
    try {
      open = openChapter(p.id, c.id);
      // Let the load run to the gated image read...
      await new Promise((r) => setTimeout(r, 0));
      // ...then back out of the editor while it is parked there.
      closeChapter();
      release();
      await open;
    } finally {
      fsx.readFile = orig;
    }

    // The load noticed it was superseded and never re-established the refs.
    expect(app.chapterRef).toBeNull();
    expect(app.loaded).toBe(false);
    expect(app.pages).toEqual([]);

    // The toggle that used to poison the file now takes the closed-chapter
    // branch and rewrites the record it read - pages and all.
    await setChapterMode(p.id, c.id, 'translate');
    await saveOpenChapter();
    const after = chapterJson(c);
    expect(after.mode).toBe('translate');
    expect(after.pages).toHaveLength(2);
  });

  it('refuses to open an unreadable chapter rather than loading a blank one', async () => {
    closeChapter();
    seedProject('z', PROJECT('p1', 'Z'));
    fsx._tree.dirs.add('/lib/z/001');
    fsx._tree.files.set('/lib/z/001/chapter.json', '{ this is not json');
    await scanLibrary();
    const c = projectById('p1').chapters[0];
    expect(c.unreadable).toBe(true);
    await expect(openChapter('p1', c.id)).rejects.toThrow();
    expect(app.chapterRef).toBeNull();
  });
});

describe('saveOpenChapter', () => {
  it('keeps pages[].file exactly as it is on disk and never writes a blob URL', async () => {
    const { c } = await seedOpenChapter();
    const before = chapterJson(c).pages.map((pg) => pg.file);
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    await saveOpenChapter();
    const after = chapterJson(c);
    expect(after.pages.map((pg) => pg.file)).toEqual(before);
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).not.toContain('blob:');
    expect(after.pages[0]).not.toHaveProperty('raw');
    closeChapter();
  });

  it('round-trips boxes with their nested style objects as plain data', async () => {
    const { p, c } = await seedOpenChapter();
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    app.pages[0].boxes = [
      {
        id: 'b1',
        lineN: 1,
        text: null,
        x: 10,
        y: 20,
        w: 100,
        h: 40,
        style: {
          font: 'Bangers',
          size: 30,
          shadows: [{ x: 3, y: 3, blur: 4, color: '#000000', opacity: 0.5 }],
          roughen: { on: false },
        },
      },
    ];
    await saveOpenChapter();
    expect(chapterJson(c).pages[0].boxes[0].style.shadows[0].x).toBe(3);
    closeChapter();
    await openChapter(p.id, c.id);
    expect(app.pages[0].boxes[0].style.font).toBe('Bangers');
    expect(app.pages[0].boxes[0].style.shadows).toEqual([
      { x: 3, y: 3, blur: 4, color: '#000000', opacity: 0.5 },
    ]);
    // Unset keys are filled from the current schema, not left undefined.
    expect(app.pages[0].boxes[0].style.roughen.amount).toBe(4);
    closeChapter();
  });

  it('turns the catalogue entry typeset once a box is placed', async () => {
    const { p, c } = await seedOpenChapter();
    expect(chapterById(p.id, c.id).typeset).toBe(false);
    app.pages[0].boxes = [
      { id: 'b1', lineN: null, text: 'Ah', x: 0, y: 0, w: 10, h: 10, style: {} },
    ];
    await saveOpenChapter();
    expect(chapterById(p.id, c.id).typeset).toBe(true);
    closeChapter();
  });

  it('updates the catalogue entry only after the write lands', async () => {
    const { p, c } = await seedOpenChapter();
    const entry = chapterById(p.id, c.id);
    const stale = entry.updatedAt;
    fsx._tree.files.delete(`${c.dir}/chapter.json`); // read fails -> no write
    await expect(saveOpenChapter()).rejects.toThrow();
    expect(chapterById(p.id, c.id).updatedAt).toBe(stale);
    closeChapter();
  });

  // The 800ms debounce cannot be called back once it has entered
  // `Promise.resolve().then(saver)`, so two of these genuinely overlap. Each
  // snapshots `app.pages` at its own moment: unserialised, the older snapshot
  // can rename last and put a stale document over a newer one. The atomic write
  // is what stops the file tearing; the queue is what makes the last edit win.
  it('serialises overlapping saves so the later edit lands last', async () => {
    const { c } = await seedOpenChapter();
    const line = (en) => ({ n: 1, type: 'dialogue', jp: 'あ', en });
    let release;
    let entered;
    const gate = new Promise((r) => (release = r));
    const atGate = new Promise((r) => (entered = r));
    const orig = fsx.writeTextFileAtomic;
    let writes = 0;
    // Only the first write waits, so a pair left to race would land in the
    // wrong order - the second document first, the first one over the top of it.
    fsx.writeTextFileAtomic = async function (p, contents) {
      if (++writes === 1) {
        entered();
        await gate;
      }
      return orig.call(this, p, contents);
    };
    try {
      app.pages[0].lines = [line('first')];
      const a = saveOpenChapter();
      await atGate; // `a` has taken its snapshot and is held at the write
      app.pages[0].lines = [line('second')];
      const b = saveOpenChapter();
      // A tick of real time: enough for an unqueued `b` to run its reads and
      // land its write ahead of the one still held below, and idle time for a
      // queued one, which has not started at all.
      await new Promise((r) => setTimeout(r, 0));
      release();
      await Promise.all([a, b]);
    } finally {
      fsx.writeTextFileAtomic = orig;
    }
    expect(chapterJson(c).pages[0].lines[0].en).toBe('second');
    closeChapter();
  });

  // The serialisation queue makes the writes land in order; it does not by
  // itself stop the older one from telling the pill "saved" after a newer
  // snapshot has already been queued behind it. `saveSeq` is what closes that:
  // it is stamped at call time, before either write starts, so the first
  // save's own finish can see that a second one exists.
  it('does not mark saved while a newer save is already queued behind it', async () => {
    const { c } = await seedOpenChapter();
    const line = (en) => ({ n: 1, type: 'dialogue', jp: 'あ', en });
    app.pages[0].lines = [line('first')];
    markUnsaved();
    const a = saveOpenChapter();
    app.pages[0].lines = [line('second')];
    markUnsaved();
    const b = saveOpenChapter(); // queued behind `a` before `a` has written anything
    await a;
    // `a`'s snapshot reached disk, but `b`'s - the newer one - has not yet;
    // the indicator must not claim everything is saved while a save is still
    // outstanding.
    expect(app.saved).toBe(false);
    await b;
    expect(app.saved).toBe(true);
    expect(chapterJson(c).pages[0].lines[0].en).toBe('second');
    closeChapter();
  });

  it('updates the live catalogue entry when scanLibrary completes concurrently during save', async () => {
    const { p, c } = await seedOpenChapter();
    app.pages[0].boxes = [
      { id: 'b1', lineN: null, text: 'Ah', x: 0, y: 0, w: 10, h: 10, style: {} },
    ];
    markUnsaved();

    const orig = fsx.writeTextFileAtomic;
    let scanned = false;
    fsx.writeTextFileAtomic = async function (path, contents) {
      const res = await orig.call(this, path, contents);
      // Trigger a rescan while writeOpenChapter is awaiting disk operations
      if (!scanned && path.endsWith('chapter.json')) {
        scanned = true;
        await scanLibrary();
      }
      return res;
    };

    try {
      await saveOpenChapter();
    } finally {
      fsx.writeTextFileAtomic = orig;
    }

    const live = chapterById(p.id, c.id);
    expect(live).toBeTruthy();
    expect(live.typeset).toBe(true);
    expect(live.pageCount).toBe(2);
    closeChapter();
  });

  it('does nothing when no chapter is open', async () => {
    const { c } = await seedOpenChapter();
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    closeChapter();
    await saveOpenChapter();
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
  });
});

// Cleaned pages pair with raws by position after the natural sort, which is the
// only rule that imposes no naming convention - and the reason every count
// mismatch has to be stated rather than absorbed.
describe('cleaned pages at creation', () => {
  const line = (n, en) => ({ n, type: 'dialogue', jp: 'あ', en });
  const parsed = (...ens) => ens.map((en) => ({ lines: [line(1, en)] }));

  async function chapterWith(files, cleanedFiles, translations = null) {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files, cleanedFiles, translations });
    return { p, c, record: chapterJson(c) };
  }

  it('pairs the Nth cleaned file with the Nth page', async () => {
    const { record } = await chapterWith(
      [fakeFile('p10.png', 10), fakeFile('p2.png', 2)],
      [fakeFile('c10.png', 110), fakeFile('c2.png', 102)],
    );
    // Both lists take the same natural sort, so page 1 is p2/c2.
    expect(record.pages.map((pg) => [pg.file, pg.cleaned])).toEqual([
      ['p2.png', 'c2.png'],
      ['p10.png', 'c10.png'],
    ]);
  });

  it('leaves the pages a short cleaned list does not reach on their raw', async () => {
    const { record } = await chapterWith(
      [fakeFile('a.png', 1), fakeFile('b.png', 2), fakeFile('c.png', 3)],
      [fakeFile('x.png', 9)],
    );
    expect(record.pages.map((pg) => pg.cleaned)).toEqual(['x.png', null, null]);
  });

  it('ignores cleaned files past the end rather than inventing pages for them', async () => {
    const { c, record } = await chapterWith(
      [fakeFile('a.png', 1)],
      [fakeFile('x.png', 9), fakeFile('y.png', 8)],
    );
    expect(record.pages).toHaveLength(1);
    // The extra was never copied - a file with no page is a file nothing can
    // ever remove.
    expect(fsx._tree.files.has(`${c.dir}/cleaned/y.png`)).toBe(false);
  });

  it('creates no cleaned/ directory when no cleaned pages were picked', async () => {
    const { c, record } = await chapterWith([fakeFile('a.png', 1)], []);
    expect(record.pages[0].cleaned).toBeNull();
    expect(fsx._tree.dirs.has(`${c.dir}/cleaned`)).toBe(false);
  });

  it('dedups raws and cleaned pages independently, so one name can be both', async () => {
    const { c, record } = await chapterWith(
      [fakeFile('01.png', 1), fakeFile('01.png', 2)],
      [fakeFile('01.png', 3), fakeFile('01.png', 4)],
    );
    expect(record.pages.map((pg) => pg.file)).toEqual(['01.png', '01-2.png']);
    expect(record.pages.map((pg) => pg.cleaned)).toEqual(['01.png', '01-2.png']);
    // Same name, different directory, different bytes - neither overwrote the other.
    expect(fsx._tree.files.get(`${c.dir}/raws/01.png`)).toEqual(new Uint8Array([1]));
    expect(fsx._tree.files.get(`${c.dir}/cleaned/01.png`)).toEqual(new Uint8Array([3]));
  });

  it('copies the cleaned pages byte for byte', async () => {
    const { c } = await chapterWith([fakeFile('a.png', 1)], [fakeFile('x.png', 77)]);
    expect(fsx._tree.files.get(`${c.dir}/cleaned/x.png`)).toEqual(new Uint8Array([77]));
  });

  it('applies the translations it was given, and ignores the pages past the end', async () => {
    const { record } = await chapterWith(
      [fakeFile('a.png', 1), fakeFile('b.png', 2)],
      [],
      parsed('One', 'Two', 'Three'),
    );
    expect(record.pages.map((pg) => pg.lines[0]?.en)).toEqual(['One', 'Two']);
  });

  it('removes the whole chapter when a cleaned copy fails', async () => {
    const p = await createProject('Series');
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('a.png', 1)],
        cleanedFiles: [broken],
      }),
    ).rejects.toThrow();
    // Not a chapter with raws and no cleaned pages - no chapter at all.
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(fsx._tree.files.has(`${p.dir}/001/raws/a.png`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
  });
});

describe('cleaned pages survive the round trip', () => {
  async function seedCleanedChapter() {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1), fakeFile('b.png', 2)],
      cleanedFiles: [fakeFile('x.png', 9)],
    });
    return { p, c };
  }

  it('reopens with each page on the image it was typeset on', async () => {
    const { p, c } = await seedCleanedChapter();
    await openChapter(p.id, c.id);
    expect(app.pages.map((pg) => pg.cleanedFile)).toEqual(['x.png', null]);
    expect(String(app.pages[0].cleaned).startsWith('blob:')).toBe(true);
    expect(app.pages[1].cleaned).toBeNull();
    // Editing anything must not cost the page its cleaned image.
    app.pages[1].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    await saveOpenChapter();
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['x.png', null]);
    closeChapter();
  });

  it('keeps the cleaned name when the file itself is gone', async () => {
    const { p, c } = await seedCleanedChapter();
    fsx._tree.files.delete(`${c.dir}/cleaned/x.png`);
    const orig = fsx.readFile;
    fsx.readFile = async (path) => {
      if (!fsx._tree.files.has(path)) throw new Error('ENOENT ' + path);
      return orig(path);
    };
    try {
      await openChapter(p.id, c.id);
    } finally {
      fsx.readFile = orig;
    }
    // Falls back to the raw for rendering, but the reference survives - a save
    // that dropped it would unlink a file the user only has to put back.
    expect(app.pages[0].cleaned).toBeNull();
    expect(app.pages[0].cleanedFile).toBe('x.png');
    await saveOpenChapter();
    expect(chapterJson(c).pages[0].cleaned).toBe('x.png');
    closeChapter();
  });

  it('opens a slice 1 chapter with no cleaned key, and gains one on save', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    // Exactly what slice 1 wrote: a page record with no `cleaned` at all.
    const record = chapterJson(c);
    delete record.pages[0].cleaned;
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await openChapter(p.id, c.id);
    expect(app.pages[0].cleanedFile).toBeNull();
    expect(app.pages[0].file).toBe('a.png');
    await saveOpenChapter();
    expect(chapterJson(c).pages[0]).toHaveProperty('cleaned', null);
    closeChapter();
  });
});

describe('the chapter sources sheet', () => {
  const line = (n, en) => ({ n, type: 'dialogue', jp: 'あ', en });
  const parsed = (...ens) => ens.map((en) => ({ lines: [line(1, en)] }));

  async function seedThree(cleanedFiles = []) {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1), fakeFile('b.png', 2), fakeFile('c.png', 3)],
      cleanedFiles,
    });
    return { p, c };
  }

  it('reports which cleaned files are actually on disk', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    fsx._tree.files.delete(`${c.dir}/cleaned/y.png`);
    const { pages } = await readChapterSources(p.id, c.id);
    expect(pages.map((pg) => pg.missing)).toEqual([false, true, false]);
  });

  it('replaces a subset in bulk and leaves the later pages alone', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8), fakeFile('z.png', 7)]);
    const out = await replaceCleanedPages(p.id, c.id, [fakeFile('new.png', 20)]);
    expect(out).toEqual({ replaced: 1, ignored: 0 });
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['new.png', 'y.png', 'z.png']);
    // The image it replaced is gone, and the ones it did not touch are not.
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/z.png`)).toBe(true);
  });

  it('ignores bulk files past the last page', async () => {
    const { p, c } = await seedThree();
    const out = await replaceCleanedPages(p.id, c.id, [
      fakeFile('1.png', 1),
      fakeFile('2.png', 2),
      fakeFile('3.png', 3),
      fakeFile('4.png', 4),
    ]);
    expect(out).toEqual({ replaced: 3, ignored: 1 });
    expect(fsx._tree.files.has(`${c.dir}/cleaned/4.png`)).toBe(false);
  });

  it('keeps the pages it managed to replace when a copy fails part-way', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8), fakeFile('z.png', 7)]);
    // Named so the natural sort puts the unreadable one second - this order is
    // the whole point of the case.
    const broken = { name: '2-bad.png', arrayBuffer: async () => { throw new Error('read failed') } };
    await expect(
      replaceCleanedPages(p.id, c.id, [fakeFile('1-new.png', 20), broken, fakeFile('3-later.png', 21)]),
    ).rejects.toThrow(/page 2/);
    // Page 1 keeps its new image; the rest keep theirs. No half-restored state,
    // and nothing points at a file that is not there.
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['1-new.png', 'y.png', 'z.png']);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/1-new.png`)).toBe(true);
  });

  it('leaves the record untouched and clears up after itself when the write fails', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    const orig = fsx.writeTextFileAtomic;
    fsx.writeTextFileAtomic = async () => {
      throw new Error('disk full');
    };
    try {
      await expect(replaceCleanedPages(p.id, c.id, [fakeFile('new.png', 20)])).rejects.toThrow(
        /disk full/,
      );
    } finally {
      fsx.writeTextFileAtomic = orig;
    }
    // The record still says what it said, the image it named is still there,
    // and the copy nothing ever pointed at is gone.
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(true);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/new.png`)).toBe(false);
  });

  it('never hands a new copy a name a page still claims, even a missing one', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    // Page 1's image has gone missing from disk - one of the states this sheet
    // exists to repair - while the record still names it.
    fsx._tree.files.delete(`${c.dir}/cleaned/x.png`);
    await replaceCleanedPages(p.id, c.id, [fakeFile('x.png', 30)]);
    const cleaned = chapterJson(c).pages.map((pg) => pg.cleaned);
    // Page 1 gets its own file. If the free name had been chosen from the disk
    // alone it would have been `x.png` again - and page 1 would then be sharing
    // one image with whatever else still claimed that name.
    expect(cleaned[0]).not.toBe('x.png');
    expect(new Set(cleaned.filter(Boolean)).size).toBe(cleaned.filter(Boolean).length);
    expect(fsx._tree.files.get(`${c.dir}/cleaned/${cleaned[0]}`)).toEqual(new Uint8Array([30]));
  });

  it('keeps a file two pages point at until the last of them lets go', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    // A record can name one file from two pages - a hand edit, or a chapter
    // folder copied and re-pointed. Unlinking on the first release would leave
    // the second page pointing at nothing.
    const record = chapterJson(c);
    record.pages[1].cleaned = 'x.png';
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await clearPageCleaned(p.id, c.id, record.pages[0].id);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(true);
    await clearPageCleaned(p.id, c.id, record.pages[1].id);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
  });

  it('refuses to aim a delete outside the chapter, whatever the record says', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    // chapter.json is an ordinary file: a hand edit or a foreign tool can put
    // a path in a name field, and fsx.remove is recursive.
    const record = chapterJson(c);
    record.pages[0].cleaned = '../raws';
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await clearPageCleaned(p.id, c.id, record.pages[0].id);
    expect(chapterJson(c).pages[0].cleaned).toBeNull();
    // The raws are still there. The name was left alone rather than resolved.
    expect(fsx._tree.files.get(`${c.dir}/raws/a.png`)).toEqual(new Uint8Array([1]));
  });

  it('sets one page by its id, not its position', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const id = chapterJson(c).pages[2].id;
    const name = await setPageCleaned(p.id, c.id, id, fakeFile('third.png', 30));
    expect(name).toBe('third.png');
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['x.png', null, 'third.png']);
  });

  it('deletes the image a per-page set replaced', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const id = chapterJson(c).pages[0].id;
    const name = await setPageCleaned(p.id, c.id, id, fakeFile('x.png', 30));
    // Same name as the one already there, so it lands beside it and the old one
    // goes - never overwritten in place.
    expect(name).toBe('x-2.png');
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.get(`${c.dir}/cleaned/x-2.png`)).toEqual(new Uint8Array([30]));
  });

  // The balloons "Place chapter" measured are answers about the raster, and a
  // new clean is a new raster - whatever it is called. A name alone would not
  // do: a page redelivered twice gets `x.png` back (`x.png`, `x-2.png`, `x.png`).
  it('drops the balloons measured for the raster a per-page set replaced', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const record = chapterJson(c);
    const fit = { kind: 'ellipse', cx: 50, cy: 50, rx: 30, ry: 20 };
    for (const pg of record.pages) {
      pg.detect = { panels: [], boxes: [{ n: 1, box: [40, 40, 60, 60], fit }, { n: 2, box: [0, 0, 9, 9], fit: null }] };
    }
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await setPageCleaned(p.id, c.id, record.pages[0].id, fakeFile('x.png', 30));
    const [first, second] = chapterJson(c).pages;
    expect(first.detect.boxes.map((d) => 'fit' in d)).toEqual([false, false]);
    expect(first.detect.boxes[0].box).toEqual([40, 40, 60, 60]);
    expect(second.detect.boxes.map((d) => d.fit)).toEqual([fit, null]);
  });

  it('unlinks one page without touching the others', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    await clearPageCleaned(p.id, c.id, chapterJson(c).pages[0].id);
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual([null, 'y.png', null]);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/y.png`)).toBe(true);
  });

  it('removes every cleaned page and leaves the raws alone', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    expect(await removeAllCleaned(p.id, c.id)).toBe(2);
    expect(chapterJson(c).pages.every((pg) => pg.cleaned === null)).toBe(true);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.get(`${c.dir}/raws/a.png`)).toEqual(new Uint8Array([1]));
  });

  it('refuses every edit while the chapter is open in the editor', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const pageId = chapterJson(c).pages[0].id;
    await openChapter(p.id, c.id);
    try {
      await expect(replaceCleanedPages(p.id, c.id, [fakeFile('n.png', 1)])).rejects.toThrow(/open/);
      await expect(setPageCleaned(p.id, c.id, pageId, fakeFile('n.png', 1))).rejects.toThrow(/open/);
      await expect(clearPageCleaned(p.id, c.id, pageId)).rejects.toThrow(/open/);
      await expect(removeAllCleaned(p.id, c.id)).rejects.toThrow(/open/);
      await expect(applyTranslations(p.id, c.id, parsed('One'))).rejects.toThrow(/open/);
      await expect(readChapterSources(p.id, c.id)).rejects.toThrow(/open/);
      // And nothing got as far as the disk.
      expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['x.png', null, null]);
    } finally {
      closeChapter();
    }
  });

  // The check at the top of a source edit is a claim about a moment, and every
  // one of these functions then awaits - the picked file's bytes, an image
  // decode per page, the copies. A chapter opened inside that window passed a
  // check made before it existed, and what used to happen next is the whole bug:
  // the open read the record as it was, this wrote its own version over the top,
  // and the editor's first autosave put the pre-edit pages back - with the new
  // cleaned rasters on disk and nothing in the record pointing at them.
  it('refuses to commit a source edit the editor opened the chapter underneath', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    // The chapter is taken over while the replacement's bytes are still being
    // read. Written straight onto the ref rather than through `openChapter`,
    // which now waits for exactly this mutation to finish (the case below) -
    // this is the last-line check, and what it defends is the invariant, not one
    // route to breaking it.
    const slowFile = {
      name: 'n.png',
      async arrayBuffer() {
        app.chapterRef = { projectId: p.id, chapterId: c.id };
        return new Uint8Array([7]).buffer;
      },
    };
    try {
      await expect(replaceCleanedPages(p.id, c.id, [slowFile])).rejects.toThrow(/open/);
      // The record is untouched, and the file this run copied is not left
      // orphaned in `cleaned/` for a later page to be aliased onto.
      expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
      expect(fsx._tree.files.has(`${c.dir}/cleaned/n.png`)).toBe(false);
    } finally {
      closeChapter();
    }
  });

  // The other end of the same race, and the one a re-check alone cannot close:
  // a mutation that started FIRST is already past every check it has, so the
  // open has to be the one that waits.
  it('makes an open wait for a source edit that is already in flight', async () => {
    const { p, c } = await seedThree();
    let opened = null;
    const slowFile = {
      name: 'n.png',
      async arrayBuffer() {
        // Asked for while the mutation holds the gate. It must not read the
        // record until the write below has landed.
        opened = openChapter(p.id, c.id);
        return new Uint8Array([7]).buffer;
      },
    };
    await replaceCleanedPages(p.id, c.id, [slowFile]);
    expect(chapterJson(c).pages[0].cleaned).toBe('n.png');
    await opened;
    try {
      // The document the editor is holding is the one the edit wrote, not the
      // one it read.
      expect(app.pages[0].cleanedFile).toBe('n.png');
    } finally {
      closeChapter();
    }
  });

  // The gate serialises every source edit and an open waits behind whatever is
  // already in flight, which makes "did the last one finish?" the only question
  // the editor ever has to answer - and makes a mutation that never releases it
  // the worst failure the module could have: every later edit and every later
  // open would wait on it forever, with no error and nothing on screen to say
  // so. So the queue is pinned against the way a mutation actually ends badly.
  it('does not strand the queue when a source edit fails', async () => {
    const { p, c } = await seedThree();
    const bad = {
      name: 'n.png',
      async arrayBuffer() {
        throw new Error('the file went away');
      },
    };
    await expect(replaceCleanedPages(p.id, c.id, [bad])).rejects.toThrow(/went away/);
    // The next edit runs rather than queueing behind the failure...
    const out = await replaceCleanedPages(p.id, c.id, [fakeFile('good.png', 4)]);
    expect(out).toEqual({ replaced: 1, ignored: 0 });
    // ...and so does an open, which waits on the same queue before it claims
    // the chapter.
    await openChapter(p.id, c.id);
    try {
      expect(app.pages[0].cleanedFile).toBe('good.png');
    } finally {
      closeChapter();
    }
  });

  // The same, one layer up: a mutation refused outright - the chapter is open
  // in the editor - never reaches its own body, so the queue entry it made has
  // to settle from the rejection alone.
  it('does not strand the queue when a source edit is refused', async () => {
    const { p, c } = await seedThree();
    await openChapter(p.id, c.id);
    try {
      await expect(replaceCleanedPages(p.id, c.id, [fakeFile('n.png', 4)])).rejects.toThrow(/open/);
    } finally {
      closeChapter();
    }
    await expect(replaceCleanedPages(p.id, c.id, [fakeFile('n.png', 4)])).resolves.toEqual({
      replaced: 1,
      ignored: 0,
    });
    await openChapter(p.id, c.id);
    closeChapter();
  });

  // A translations file says what is on pages 1..N. It says nothing about
  // whether the chapter has pages after that, so it never shortens one - the
  // bug that deleted a chapter's trailing pages and every box on them.
  it('applies lines without shortening or extending the chapter', async () => {
    const { p, c } = await seedThree();
    const before = chapterJson(c);
    before.pages[2].boxes = [{ id: 'b1', lineN: 1, text: 'End', x: 1, y: 2, w: 3, h: 4, style: {} }];
    before.pages[2].lines = [line(1, 'End')];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(before));

    const out = await applyTranslations(p.id, c.id, parsed('One', 'Two'));
    expect(out).toEqual({ covered: 2, kept: 1, ignored: 0, lines: 2, orphaned: 0 });
    const after = chapterJson(c);
    expect(after.pages).toHaveLength(3);
    expect(after.pages.map((pg) => pg.lines[0].en)).toEqual(['One', 'Two', 'End']);
    expect(after.pages[2].boxes).toHaveLength(1);
    expect(after.pages.map((pg) => pg.file)).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('counts the placed boxes a renumbered file leaves with nothing to say', async () => {
    const { p, c } = await seedThree();
    const record = chapterJson(c);
    record.pages[0].lines = [line(1, 'Old')];
    // Line-backed: it renders whatever line 1 says. Free-typed boxes carry
    // their own text and are unaffected, so only the first is counted.
    record.pages[0].boxes = [
      { id: 'b1', lineN: 1, text: null, x: 0, y: 0, w: 1, h: 1, style: {} },
      { id: 'b2', lineN: null, text: 'mine', x: 0, y: 0, w: 1, h: 1, style: {} },
    ];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));

    const out = await applyTranslations(p.id, c.id, [{ lines: [line(7, 'New')] }]);
    expect(out.orphaned).toBe(1);
    // Nothing was deleted - the boxes are all still there to be re-pointed.
    expect(chapterJson(c).pages[0].boxes).toHaveLength(2);
  });

  // A translations file has never carried tags, and the re-import replaces a
  // page's lines wholesale - so it used to leave the boxes standing and strip
  // every tag they had been placed under, with nothing said about it.
  it('carries hand-applied tags across a re-import, by line number', async () => {
    const { p, c } = await seedThree();
    const record = chapterJson(c);
    record.pages[0].lines = [
      { n: 1, type: 'dialogue', jp: 'あ', en: 'Old', tags: ['whisper', 'sfx'] },
      { n: 2, type: 'dialogue', jp: 'い', en: 'Old two', tags: [] },
    ];
    record.pages[0].boxes = [{ id: 'b1', lineN: 1, text: null, x: 0, y: 0, w: 1, h: 1, style: {} }];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));

    await applyTranslations(p.id, c.id, [
      { lines: [line(1, 'New'), { n: 2, type: 'sfx', jp: 'い', en: 'New two' }] },
    ]);

    const after = chapterJson(c).pages[0].lines;
    expect(after[0].en).toBe('New'); // the file still owns the words
    expect(after[0].tags).toEqual(['whisper', 'sfx']); // …and the user still owns the tags
    expect(after[0].type).toBe('sfx'); // re-projected, so the exporters agree
    // An empty array is the user having taken the tags *off*, so the file's
    // `sfx` must not put one back.
    expect(after[1].tags).toEqual([]);
    expect(after[1].type).toBe('dialogue');
  });

  it('lets the file speak for a line the user never tagged', async () => {
    const { p, c } = await seedThree();
    const record = chapterJson(c);
    record.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Old' }];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await applyTranslations(p.id, c.id, [{ lines: [{ n: 1, type: 'narration', jp: 'あ', en: 'New' }] }]);
    const after = chapterJson(c).pages[0].lines[0];
    expect(after.type).toBe('narration');
    expect('tags' in after).toBe(false);
  });

  it('never appends the pages a longer file describes', async () => {
    const { p, c } = await seedThree();
    const out = await applyTranslations(p.id, c.id, parsed('1', '2', '3', '4', '5'));
    expect(out.ignored).toBe(2);
    // No page arrives with file:'' - unrenderable, and impossible to get rid of.
    expect(chapterJson(c).pages.map((pg) => pg.file)).toEqual(['a.png', 'b.png', 'c.png']);
  });
});

// A page's `w`/`h` is the space its boxes are placed in and the size every
// exporter writes its document at, and everything that draws a page draws
// `cleaned ?? raw`. So swapping a page's cleaned raster for one of another size
// and leaving the old numbers standing is not a stale field: it is boxes in a
// coordinate system nothing on screen is drawn in, and a PSD sized to a raster
// that is not there any more. Worse, `hasPageSpace` reads the old number as
// measured, so no later open ever repairs it.
// Deleting the chapter the editor is looking at used to be allowed, and it left
// the app editing a ghost: the canvas kept drawing a directory that no longer
// existed, the debounced autosave recreated chapter.json inside the deleted
// tree, and the next scan brought a one-file chapter back with every raw gone.
describe('deleting what the editor is holding', () => {
  it('refuses to delete the open chapter, and leaves it on disk', async () => {
    const { p, c } = await seedOpenChapter();
    try {
      await expect(deleteChapter(p.id, c.id)).rejects.toThrow(/open/);
      expect(fsx._tree.files.has(`${c.dir}/chapter.json`)).toBe(true);
      expect(projectById(p.id).chapters).toHaveLength(1);
    } finally {
      closeChapter();
    }
  });

  it('refuses to delete the project that chapter is in', async () => {
    const { p, c } = await seedOpenChapter();
    try {
      await expect(deleteProject(p.id)).rejects.toThrow(/open/);
      expect(fsx._tree.files.has(`${c.dir}/chapter.json`)).toBe(true);
      expect(projectById(p.id)).toBeTruthy();
    } finally {
      closeChapter();
    }
  });

  it('still deletes a chapter of the project that is not the open one', async () => {
    const { p, c } = await seedOpenChapter();
    const other = await createChapter({
      projectId: p.id,
      number: 2,
      title: '',
      files: [fakeFile('z.png', 3)],
    });
    try {
      await deleteChapter(p.id, other.id);
      expect(projectById(p.id).chapters.map((x) => x.id)).toEqual([c.id]);
    } finally {
      closeChapter();
    }
  });

  it('deletes freely once the chapter is closed', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    await deleteChapter(p.id, c.id);
    expect(fsx._tree.files.has(`${c.dir}/chapter.json`)).toBe(false);
    await deleteProject(p.id);
    expect(projectById(p.id)).toBeUndefined();
  });
});

// An atomic write is `<target>.<n>.tmp` renamed over the target. The rename
// cannot tear, but a process killed between the two steps leaves the temp file
// beside the record for good - and the record is rewritten every 800ms while
// someone is typing, so it is one leftover per crash, forever.
describe('leftover temp files', () => {
  it('sweeps the litter of a dead write out of a chapter directory on open', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    const litter = `${c.dir}/chapter.json.7.tmp`;
    fsx._tree.files.set(litter, '{ half a record');
    // Not ours, and not for us to delete however much it looks like scratch.
    fsx._tree.files.set(`${c.dir}/notes.tmp`, 'the letterer’s own file');
    await openChapter(p.id, c.id);
    try {
      expect(fsx._tree.files.has(litter)).toBe(false);
      expect(fsx._tree.files.has(`${c.dir}/notes.tmp`)).toBe(true);
      // …and the chapter itself is untouched by the sweep.
      expect(app.pages).toHaveLength(2);
    } finally {
      closeChapter();
    }
  });

  it('sweeps a project directory as the scan reads it', async () => {
    const p = await createProject('Series');
    fsx._tree.files.set(`${p.dir}/project.json.3.tmp`, '{');
    await scanLibrary();
    expect(fsx._tree.files.has(`${p.dir}/project.json.3.tmp`)).toBe(false);
    expect(projectById(p.id)).toBeTruthy();
  });

  // The one thing a sweep must never do: a temp file a write is still holding is
  // not litter, it is the bytes that write is about to rename into place.
  it('never takes a temp file a write still holds', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    const stale = `${c.dir}/chapter.json.7.tmp`;
    const inFlight = `${c.dir}/translations.json.8.tmp`;
    fsx._tree.files.set(stale, '{ a write that died');
    fsx._tree.files.set(inFlight, '{ a write still going');
    const orig = fsx.liveTemps;
    // What a concurrent write looks like to the sweep: the same shape of name,
    // still claimed. Delete it and the rename behind it has nothing to rename.
    fsx.liveTemps = () => new Set([inFlight]);
    try {
      await openChapter(p.id, c.id);
      expect(fsx._tree.files.has(stale)).toBe(false);
      expect(fsx._tree.files.has(inFlight)).toBe(true);
    } finally {
      fsx.liveTemps = orig;
      closeChapter();
    }
  });
});

describe('a cleaned page brings its own coordinate space', () => {
  const sizes = (c) => chapterJson(c).pages.map((pg) => [pg.w, pg.h]);

  // Measured at import, so the numbers under test are real ones rather than the
  // 0x0 every no-decoder seed in this file produces.
  async function measuredPair() {
    const p = await createProject('Series');
    const c = await withDecoder({ 1: { width: 1000, height: 1400 } }, () =>
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('a.png', 1), fakeFile('b.png', 1)],
      }),
    );
    expect(sizes(c)).toEqual([
      [1000, 1400],
      [1000, 1400],
    ]);
    return { p, c };
  }

  it('re-measures the pages a bulk replace lands on, and only those', async () => {
    const { p, c } = await measuredPair();
    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
    );
    expect(sizes(c)).toEqual([
      [2000, 2800],
      [1000, 1400],
    ]);
  });

  it('re-measures the page a per-page set lands on', async () => {
    const { p, c } = await measuredPair();
    const id = chapterJson(c).pages[1].id;
    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      setPageCleaned(p.id, c.id, id, fakeFile('hi.png', 5)),
    );
    expect(sizes(c)).toEqual([
      [1000, 1400],
      [2000, 2800],
    ]);
  });

  it('keeps the page in the space its boxes are in when the new raster will not decode', async () => {
    const { p, c } = await measuredPair();
    // NOT 0. Zeroing it used to look honest - "nobody has measured this" - but
    // the boxes on the page are still quoted in the 1000x1400 the record no
    // longer claims, and the next open would measure the NEW image, read the
    // page as never measured, and adopt that size around them without moving
    // anything. The old space stands and the page is flagged instead, so the
    // move happens at a moment that can actually measure both ends of it.
    await withDecoder({}, () => replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]));
    expect(sizes(c)).toEqual([
      [1000, 1400],
      [1000, 1400],
    ]);
    expect(chapterJson(c).pages[0].needsRespace).toBe(true);
    // …and only the page that lost its art carries it.
    expect(chapterJson(c).pages[1].needsRespace).toBeUndefined();
  });

  it('defers the move when a cleaned image is taken away and the raw cannot be read', async () => {
    const { p, c } = await measuredPair();
    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5), fakeFile('lo.png', 5)]),
    );
    const [one, two] = chapterJson(c).pages.map((pg) => pg.id);
    await clearPageCleaned(p.id, c.id, one);
    // The page draws its raw again, and the raw is not necessarily 2000x2800 -
    // but there is no decoder here, so the target space is unknown. The page
    // keeps the space its boxes are in and says so; it does not pretend to be
    // unmeasured, which is the one state a later open adopts a size from.
    expect(sizes(c)[0]).toEqual([2000, 2800]);
    expect(chapterJson(c).pages[0].needsRespace).toBe(true);
    expect(sizes(c)[1]).toEqual([2000, 2800]);

    await removeAllCleaned(p.id, c.id);
    expect(sizes(c)).toEqual([
      [2000, 2800],
      [2000, 2800],
    ]);
    expect(chapterJson(c).pages.map((pg) => pg.needsRespace)).toEqual([true, true]);
    // …and the open finishes the move, which is the half that makes deferring it
    // safe: the raw decodes here, so both spaces are known at last.
    await withDecoder({ 1: { width: 1000, height: 1400 } }, () => openChapter(p.id, c.id));
    expect(app.pages.map((pg) => [pg.w, pg.h])).toEqual([
      [1000, 1400],
      [1000, 1400],
    ]);
    // The flag is spent, and the repair is written back rather than redone on
    // every open.
    expect(app.pages.every((pg) => !pg.needsRespace)).toBe(true);
    await flushSave();
    expect(chapterJson(c).pages.every((pg) => pg.needsRespace === undefined)).toBe(true);
    closeChapter();
  });

  // Re-measuring the page is only half of what replacing its art means. The
  // boxes on it were placed against the OLD raster, in the old raster's
  // coordinates - so a page that changes space without moving them is a page
  // whose typesetting has silently slid off the bubbles it was aimed at, and
  // nothing later repairs it: `hasPageSpace` reads the new number as measured,
  // the canvas measures the same number and `setPageDims` returns false. The
  // rescale has to happen here, at the one moment both spaces are known.
  async function typesetPair() {
    const { p, c } = await measuredPair();
    const rec = chapterJson(c);
    rec.pages[0].boxes = [
      { id: 'b1', lineN: 1, text: 'hi', x: 100, y: 700, w: 200, h: 140, style: {}, fit: null },
    ];
    rec.pages[0].detect = {
      panels: [[10, 20, 110, 220]],
      boxes: [{ n: 1, box: [100, 700, 300, 840], vertical: false, font_size: 28 }],
    };
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(rec, null, 2));
    return { p, c };
  }

  it('drags the boxes across when a bulk replace doubles the page', async () => {
    const { p, c } = await typesetPair();
    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
    );
    const pg = chapterJson(c).pages[0];
    expect([pg.w, pg.h]).toEqual([2000, 2800]);
    // Exactly 2x in both axes, because the page is exactly 2x in both axes.
    expect(pg.boxes[0]).toMatchObject({ x: 200, y: 1400, w: 400, h: 280 });
    // The detector's geometry is in the same space and moves with it.
    expect(pg.detect.panels[0]).toEqual([20, 40, 220, 440]);
    expect(pg.detect.boxes[0].box).toEqual([200, 1400, 600, 1680]);
    expect(pg.detect.boxes[0].font_size).toBe(56);
    // …and the page nobody replaced is untouched.
    expect(chapterJson(c).pages[1]).toMatchObject({ w: 1000, h: 1400 });
  });

  it('drags the boxes across when a per-page set changes the raster', async () => {
    const { p, c } = await typesetPair();
    const id = chapterJson(c).pages[0].id;
    await withDecoder({ 5: { width: 500, height: 1400 } }, () =>
      setPageCleaned(p.id, c.id, id, fakeFile('hi.png', 5)),
    );
    const pg = chapterJson(c).pages[0];
    expect([pg.w, pg.h]).toEqual([500, 1400]);
    // Half as wide, same height: a non-uniform rescale, and each axis follows
    // its own factor.
    expect(pg.boxes[0]).toMatchObject({ x: 50, y: 700, w: 100, h: 140 });
  });

  it('leaves the boxes alone when the new raster is the same size', async () => {
    const { p, c } = await typesetPair();
    await withDecoder({ 5: { width: 1000, height: 1400 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
    );
    expect(chapterJson(c).pages[0].boxes[0]).toMatchObject({
      x: 100,
      y: 700,
      w: 200,
      h: 140,
    });
  });

  it('drags the boxes back into the raw when a cleaned image is taken away', async () => {
    const { p, c } = await typesetPair();
    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
    );
    const id = chapterJson(c).pages[0].id;
    // The page goes back to drawing its raw, which is 1000x1400 - and the raw
    // is on disk, so this is a change between two KNOWN spaces like any other.
    // Left unmeasured instead, the boxes would keep the cleaned raster's
    // coordinates and the next open would adopt the raw's space around them
    // without moving anything.
    await withDecoder({ 1: { width: 1000, height: 1400 } }, () =>
      clearPageCleaned(p.id, c.id, id),
    );
    const pg = chapterJson(c).pages[0];
    expect([pg.w, pg.h]).toEqual([1000, 1400]);
    expect(pg.boxes[0]).toMatchObject({ x: 100, y: 700, w: 200, h: 140 });
  });

  it('does the same for every page when all the cleaned images go at once', async () => {
    const { p, c } = await typesetPair();
    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
    );
    await withDecoder({ 1: { width: 1000, height: 1400 } }, () => removeAllCleaned(p.id, c.id));
    const pg = chapterJson(c).pages[0];
    expect([pg.w, pg.h]).toEqual([1000, 1400]);
    expect(pg.boxes[0]).toMatchObject({ x: 100, y: 700, w: 200, h: 140 });
  });

  // The stored undo stacks are in page coordinates too. A record moved into a
  // new space beside a history file left in the old one is a chapter where one
  // press of undo throws the box back to where it sat under the previous raster
  // - and the bigger the resolution change, the further off-page it lands.
  describe('the chapter’s stored undo history moves with it', () => {
    const historyPath = (c) => `${c.dir}/logs/history.json`;
    const seedHistory = (c, entries) => {
      fsx._tree.dirs.add(`${c.dir}/logs`);
      fsx._tree.files.set(
        historyPath(c),
        JSON.stringify({ version: 1, pages: { 1: { undo: entries, redo: [] } } }),
      );
    };
    const storedUndo = (c) => JSON.parse(fsx._tree.files.get(historyPath(c))).pages['1'].undo;

    it('rescales a recorded move by the same factor the boxes moved by', async () => {
      const { p, c } = await typesetPair();
      seedHistory(c, [
        { t: 'move', pageId: 1, boxId: 'b1', before: { x: 100, y: 200 }, after: { x: 150, y: 250 } },
      ]);
      await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
        replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
      );
      expect(storedUndo(c)[0]).toMatchObject({
        before: { x: 200, y: 400 },
        after: { x: 300, y: 500 },
      });
    });

    it('carries a recorded box’s rectangle and its page-pixel style across', async () => {
      const { p, c } = await typesetPair();
      seedHistory(c, [
        {
          t: 'place',
          pageId: 1,
          index: 0,
          box: {
            id: 'b1',
            x: 10,
            y: 20,
            w: 30,
            h: 40,
            style: { size: 26, letterSpacing: 4, strokes: [{ color: '#fff', width: 3 }] },
          },
        },
      ]);
      await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
        replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
      );
      const box = storedUndo(c)[0].box;
      expect(box).toMatchObject({ x: 20, y: 40, w: 60, h: 80 });
      // A uniform 2x, so every length doubles - the type included, which is the
      // half that used to be left behind on the boxes as well.
      expect(box.style).toMatchObject({ size: 52, letterSpacing: 8 });
      expect(box.style.strokes[0].width).toBe(6);
    });

    it('leaves the stacks of pages nobody replaced exactly as they were', async () => {
      const { p, c } = await typesetPair();
      seedHistory(c, [
        { t: 'move', pageId: 1, boxId: 'b1', before: { x: 100 }, after: { x: 150 } },
      ]);
      const doc = JSON.parse(fsx._tree.files.get(historyPath(c)));
      doc.pages['2'] = { undo: [{ t: 'move', pageId: 2, boxId: 'b9', before: { x: 7 }, after: { x: 9 } }], redo: [] };
      fsx._tree.files.set(historyPath(c), JSON.stringify(doc));
      await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
        replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
      );
      const after = JSON.parse(fsx._tree.files.get(historyPath(c)));
      expect(after.pages['2'].undo[0]).toMatchObject({ before: { x: 7 }, after: { x: 9 } });
    });

    it('writes nothing at all for a chapter that has no history file', async () => {
      const { p, c } = await typesetPair();
      await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
        replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
      );
      expect(fsx._tree.files.has(historyPath(c))).toBe(false);
    });
  });

  it('leaves the boxes where they are and defers the move when nothing can decode', async () => {
    const { p, c } = await typesetPair();
    // No decoder at all: the new space is unknowable, so there is no factor to
    // scale by. The boxes stay where they were - and so does the space they are
    // quoted in, which is the part that used to be thrown away.
    await withDecoder({}, () => replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]));
    const pg = chapterJson(c).pages[0];
    expect([pg.w, pg.h]).toEqual([1000, 1400]);
    expect(pg.needsRespace).toBe(true);
    expect(pg.boxes[0]).toMatchObject({ x: 100, y: 700, w: 200, h: 140 });
  });

  // The whole reason deferring is allowed: the open is a moment that CAN decode,
  // and it finishes the move that the source edit could not. Without this half
  // the flag would just be a note nobody acts on.
  it('finishes the deferred move on the next open, boxes and all', async () => {
    const { p, c } = await typesetPair();
    await withDecoder({}, () => replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]));
    // The page draws its cleaned raster, and it is 2000x2800 - twice the space
    // the boxes were placed in.
    await withDecoder({ 5: { width: 2000, height: 2800 }, 1: { width: 1000, height: 1400 } }, () =>
      openChapter(p.id, c.id),
    );
    expect([app.pages[0].w, app.pages[0].h]).toEqual([2000, 2800]);
    expect(app.pages[0].boxes[0]).toMatchObject({ x: 200, y: 1400, w: 400, h: 280 });
    expect(app.pages[0].detect.panels[0]).toEqual([20, 40, 220, 440]);
    // And the repair is on disk, so the next open pays nothing and - far more
    // importantly - cannot scale the same page twice.
    await flushSave();
    const pg = chapterJson(c).pages[0];
    expect([pg.w, pg.h]).toEqual([2000, 2800]);
    expect(pg.needsRespace).toBeUndefined();
    expect(pg.boxes[0]).toMatchObject({ x: 200, y: 1400 });
    closeChapter();
  });
});

describe('a save whose chapter moved under it', () => {
  it('abandons the write when the chapter is closed while the read is in flight', async () => {
    const { c } = await seedOpenChapter();
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    const orig = fsx.readTextFile;
    fsx.readTextFile = async (path) => {
      const out = await orig(path);
      // The user leaves the editor while this save's read is still in flight.
      if (path === `${c.dir}/chapter.json`) closeChapter();
      return out;
    };
    try {
      await saveOpenChapter();
    } finally {
      fsx.readTextFile = orig;
    }
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
    expect(c.pageCount).toBe(2);
  });
});

describe('a failed save is visible', () => {
  it('toasts when the debounced autosave cannot write', async () => {
    await seedOpenChapter();
    const orig = fsx.writeTextFile;
    fsx.writeTextFile = async () => {
      throw new Error('disk full');
    };
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      fsx.writeTextFile = orig;
    }
    expect(app.saved).toBe(false);
    expect(app.toast.msg).toMatch(/Could not save/);
    closeChapter();
  });

  it('keeps the user in the editor when the leave-save fails', async () => {
    const { p, c } = await seedOpenChapter();
    resetRoute();
    await goEditor(p.id, c.id);
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    const orig = fsx.writeTextFile;
    fsx.writeTextFile = async () => {
      throw new Error('disk full');
    };
    let moved;
    try {
      moved = await goLibrary();
    } finally {
      fsx.writeTextFile = orig;
    }
    expect(moved).toBe(false);
    expect(route.name).toBe('editor');
    expect(app.chapterRef).not.toBeNull();
    expect(app.pages[0].lines).toHaveLength(1); // the work is still on screen
    expect(app.toast.msg).toMatch(/staying in the editor/);
    resetRoute();
    closeChapter();
  });

  // A disk that will never write must not be able to pin the user in the editor
  // - or, via the same guard on the window, inside a window that will not close.
  describe('the second-attempt escape', () => {
    // Swap in a filesystem that cannot write, for the duration of `fn`.
    async function withBrokenDisk(fn) {
      const orig = fsx.writeTextFile;
      fsx.writeTextFile = async () => {
        throw new Error('disk full');
      };
      try {
        return await fn();
      } finally {
        fsx.writeTextFile = orig;
      }
    }

    it('lets the user out of the editor on a second consecutive failure', async () => {
      const { p, c } = await seedOpenChapter();
      resetRoute();
      await goEditor(p.id, c.id);
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];

      const [first, second] = await withBrokenDisk(async () => {
        const a = await goLibrary();
        const firstMsg = app.toast.msg;
        const b = await goLibrary();
        return [
          { moved: a, msg: firstMsg },
          { moved: b, msg: app.toast.msg },
        ];
      });

      expect(first.moved).toBe(false);
      expect(first.msg).toMatch(/ask to leave again/i);
      expect(second.moved).toBe(true);
      expect(route.name).toBe('library');
      expect(app.chapterRef).toBeNull();
      // The message names the cost rather than repeating the error.
      expect(second.msg).toMatch(/never written to disk/i);
      // Nothing reached the file - which is exactly what the user was told.
      expect(chapterJson(c).pages[0].lines).toHaveLength(0);
      resetRoute();
    });

    it('starts the two-step over once a save works again', async () => {
      const { p, c } = await seedOpenChapter();
      resetRoute();
      await goEditor(p.id, c.id);
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];

      // One failure banks an escape...
      expect(await withBrokenDisk(() => goLibrary())).toBe(false);
      // ...but a save that lands spends it, so the next failure refuses again
      // rather than walking out on work the user never agreed to lose.
      await saveOpenChapter();
      expect(await withBrokenDisk(() => goLibrary())).toBe(false);
      expect(route.name).toBe('editor');
      expect(app.toast.msg).toMatch(/staying in the editor/);

      resetRoute();
      closeChapter();
    });

    it('refuses the first quit and releases the second, in quit wording', async () => {
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];

      const first = await withBrokenDisk(() => flushBeforeLeaving('quit'));
      expect(first).toBe(false);
      expect(app.toast.msg).toMatch(/not quitting/);
      expect(app.toast.msg).toMatch(/ask to quit again/i);

      const second = await withBrokenDisk(() => flushBeforeLeaving('quit'));
      expect(second).toBe(true);
      expect(app.toast.msg).toMatch(/never written to disk/i);
      // The chapter is still open: quitting is the caller's job, not the guard's.
      expect(app.chapterRef).not.toBeNull();
      closeChapter();
    });

    // The other way a disk stops answering, and the one the two-step above
    // cannot see: not a rejection but a call that never comes back - a network
    // volume that has gone away, a wedged mount, an `fsync_path` IPC with no
    // timeout of its own. The close handler has already prevented the default by
    // then and `safeToQuit` is single-flight, so an unbounded await meant every
    // later press of ⌘Q handed back the same promise that was never going to
    // settle: a window that could not be closed, with nothing on screen to say
    // why, and Force Quit the only way out.
    //
    // ...and the refusal costs no escape. A rejection means the bytes are
    // definitely not on disk, which is what the two-step is for; a timeout means
    // nobody knows yet, and spending an escape on it would let the NEXT press
    // quit on work that may be seconds from landing.
    it('refuses rather than hanging when a save never comes back', async () => {
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      // A second saver that never answers, rather than a filesystem that never
      // answers: the shape `flushSave` sees is identical and nothing is left
      // wedged in the module's own write queue afterwards.
      let release;
      const off = setSaver(() => new Promise((r) => (release = r)));
      vi.useFakeTimers();
      try {
        const leaving = flushBeforeLeaving('quit');
        // Just past the wait, and no further: the toast that says so clears
        // itself two seconds later, and this test is about what it said.
        await vi.advanceTimersByTimeAsync(10500);
        expect(await leaving).toBe(false);
      } finally {
        vi.useRealTimers();
        release?.();
        off();
      }
      // Said, not silent - and in the wording of a save nobody knows the fate of
      // yet rather than one that is known to have failed.
      expect(app.toast.msg).toMatch(/still writing to disk/i);
      expect(app.toast.msg).toMatch(/not quitting/i);

      // No escape banked: a real failure straight after still refuses.
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      expect(app.toast.msg).toMatch(/ask to quit again/i);
      resetSaveFailures();
      closeChapter();
    });

    it('counts the streak across both ways out, not per button', async () => {
      // One refused quit, then one attempt to leave the editor: the escape is
      // about a disk that keeps failing, not about which button was pressed.
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      expect(await withBrokenDisk(() => flushBeforeLeaving('editor'))).toBe(true);
      closeChapter();
    });

    it('closing the chapter clears the streak', async () => {
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      closeChapter();

      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      // A fresh chapter must get its own first refusal, not inherit one.
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      closeChapter();
      resetSaveFailures();
    });
  });

  it('leaves the editor normally when the save succeeds', async () => {
    const { p, c } = await seedOpenChapter();
    resetRoute();
    await goEditor(p.id, c.id);
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    const moved = await goLibrary();
    expect(moved).toBe(true);
    expect(route.name).toBe('library');
    expect(app.chapterRef).toBeNull();
    expect(chapterJson(c).pages[0].lines).toHaveLength(1);
    resetRoute();
  });
});

describe('the stand-in page', () => {
  it('is frozen, so an accidental write throws instead of polluting it', () => {
    closeChapter();
    const p = page();
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      p.w = 5;
    }).toThrow();
    expect(() => p.boxes.push({ id: 'x' })).toThrow();
    expect(page().boxes).toHaveLength(0);
  });
});

describe('autosave debounce', () => {
  function countChapterWrites(c) {
    const orig = fsx.writeTextFile;
    const state = { n: 0, restore: () => (fsx.writeTextFile = orig) };
    fsx.writeTextFile = async (path, contents) => {
      if (fsx._targetOf(path) === `${c.dir}/chapter.json`) state.n++;
      return orig(path, contents);
    };
    return state;
  }

  it('writes the open chapter once the debounce elapses', async () => {
    const { c } = await seedOpenChapter();
    const writes = countChapterWrites(c);
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      writes.restore();
    }
    expect(writes.n).toBe(1);
    expect(chapterJson(c).pages[0].lines).toHaveLength(1);
    closeChapter();
  });

  it('does not write after the chapter has been closed', async () => {
    const { c } = await seedOpenChapter();
    const writes = countChapterWrites(c);
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      closeChapter();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      writes.restore();
    }
    expect(writes.n).toBe(0);
    expect(chapterJson(c).pages[0].lines).toEqual([]);
  });

  it('does not write into the chapter opened next', async () => {
    const { p, c } = await seedOpenChapter();
    const second = await createChapter({
      projectId: p.id,
      number: 2,
      title: '',
      files: [fakeFile('a.png', 3)],
    });
    const writes = countChapterWrites(second);
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      closeChapter();
      await openChapter(p.id, second.id);
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      writes.restore();
    }
    expect(writes.n).toBe(0);
    expect(chapterJson(second).pages[0].lines).toEqual([]);
    expect(chapterJson(c).pages[0].lines).toEqual([]);
    closeChapter();
  });
});

// ===== switching chapters =====
// The window between "app.pages is chapter B's" and "app.chapterRef says B" is
// the most expensive bug in this file: everything that writes reads the ref, and
// chapter.json is the only copy of a chapter's typesetting. A save landing in
// that window - the 800ms debounce, a quit, or the goBack the App runs when an
// open fails - used to serialise chapter B's document straight over chapter A.
const { flushSave, setSaver } = await import('./store.svelte.js');

describe('switching from one chapter to another', () => {
  const line = (en) => ({ n: 1, type: 'dialogue', jp: 'あ', en });

  // Two chapters whose page filenames differ, so a test can tell which document
  // is in the store just by looking at it. Chapter A is opened and saved with a
  // line of its own, which is what must still be on disk at the end.
  async function twoChapters() {
    const p = await createProject('Series');
    const a = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    const b = await createChapter({ projectId: p.id, number: 2, title: '', files: [fakeFile('b.png', 2)] });
    await openChapter(p.id, a.id);
    app.pages[0].lines = [line('From A')];
    await saveOpenChapter();
    return { p, a, b };
  }

  // Runs `hook` once, at the exact moment `app.pages` has become chapter B's
  // document - `page-images.js` reads the pages around the one being opened
  // through this seam, which is the await the old code left the ref standing
  // across. Reports whether the window was ever actually entered, so a case
  // cannot pass by never reaching the thing it is about.
  function duringTheSwap(hook) {
    const orig = fsx.readFile;
    const state = { entered: false, restore: () => (fsx.readFile = orig) };
    fsx.readFile = async (path) => {
      if (!state.entered && app.pages[0]?.file === 'b.png') {
        state.entered = true;
        await hook();
      }
      return orig(path);
    };
    return state;
  }

  it('has no chapter to save into while the document is being swapped', async () => {
    const { p, a, b } = await twoChapters();
    const seen = [];
    const hook = duringTheSwap(async () => {
      seen.push(app.chapterRef);
      // Both routes a save reaches disk by, fired inside the window.
      await flushSave();
      await saveOpenChapter();
    });
    try {
      await openChapter(p.id, b.id);
    } finally {
      hook.restore();
    }
    expect(hook.entered).toBe(true);
    expect(seen).toEqual([null]);
    // Chapter A still says what it said. Before the fix this file held chapter
    // B's single page and chapter A's typesetting was gone for good.
    expect(chapterJson(a).pages.map((pg) => pg.file)).toEqual(['a.png']);
    expect(chapterJson(a).pages[0].lines[0].en).toBe('From A');
    expect(chapterJson(b).pages.map((pg) => pg.file)).toEqual(['b.png']);
    expect(app.chapterRef).toEqual({ projectId: p.id, chapterId: b.id });
    closeChapter();
  });

  it('cannot write the incoming chapter into the outgoing one on the way out', async () => {
    // Finding 3's shape: the open fails mid-way, `App.svelte` answers by
    // navigating back, and the route's leave hook flushes on the way. That flush
    // has to find nothing to write, not chapter A's name over chapter B's pages.
    const { p, a, b } = await twoChapters();
    let left;
    const hook = duringTheSwap(async () => {
      left = await flushBeforeLeaving('editor');
    });
    try {
      await openChapter(p.id, b.id);
    } finally {
      hook.restore();
    }
    expect(hook.entered).toBe(true);
    expect(left).toBe(true); // nothing pending, so the user is free to go
    expect(chapterJson(a).pages[0].lines[0].en).toBe('From A');
    expect(chapterJson(a).pages).toHaveLength(1);
    closeChapter();
  });

  it('puts the editor away when the open fails part-way, rather than half-loading', async () => {
    const { p, a, b } = await twoChapters();
    const orig = fsx.readTextFile;
    fsx.readTextFile = async (path) => {
      if (path === `${b.dir}/chapter.json`) throw new Error('volume went away');
      return orig(path);
    };
    try {
      await expect(openChapter(p.id, b.id)).rejects.toThrow(/volume went away/);
    } finally {
      fsx.readTextFile = orig;
    }
    // Nothing is open, so the goBack that follows has nothing to aim at.
    expect(app.chapterRef).toBeNull();
    expect(app.loaded).toBe(false);
    expect(await flushBeforeLeaving('editor')).toBe(true);
    expect(chapterJson(a).pages[0].lines[0].en).toBe('From A');
  });

  it('keeps the chapter it could not flush on screen, rather than dropping it', async () => {
    // The open starts by writing out whatever the outgoing chapter still owes.
    // A disk that refuses that is not a reason to close the chapter: the edits
    // it could not write are still in front of the user, and the next attempt is
    // their way out. Nothing has been given up at that point, so nothing is.
    const { p, a, b } = await twoChapters();
    app.pages[0].lines = [line('unwritten')];
    markUnsaved();
    const orig = fsx.writeTextFile;
    fsx.writeTextFile = async () => {
      throw new Error('disk full');
    };
    try {
      await expect(openChapter(p.id, b.id)).rejects.toThrow(/disk full/);
    } finally {
      fsx.writeTextFile = orig;
    }
    expect(app.chapterRef).toEqual({ projectId: p.id, chapterId: a.id });
    expect(app.pages[0].lines[0].en).toBe('unwritten');
    // And the retry still lands where it should.
    await saveOpenChapter();
    expect(chapterJson(a).pages[0].lines[0].en).toBe('unwritten');
    closeChapter();
    resetSaveFailures();
  });

  it('lets the newer open win when a slower one settles late', async () => {
    const p = await createProject('Series');
    const slow = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('slow.png', 1)] });
    const quick = await createChapter({ projectId: p.id, number: 2, title: '', files: [fakeFile('quick.png', 2)] });

    let release;
    const gate = new Promise((r) => (release = r));
    const orig = fsx.readFile;
    // One chapter's read sits; the other comes back at once. That is the real
    // ordering - a user who clicks one chapter, changes their mind, and clicks
    // another before the first has finished decoding.
    fsx.readFile = async (path) => {
      if (path.endsWith('slow.png')) await gate;
      return orig(path);
    };
    let opening;
    try {
      opening = openChapter(p.id, slow.id);
      await new Promise((r) => setTimeout(r, 0)); // it reaches the gate
      await openChapter(p.id, quick.id);
      release();
      await opening;
    } finally {
      fsx.readFile = orig;
    }

    // The late one abandoned everything: the document, the ref, and any claim on
    // where the next edit goes.
    expect(app.pages.map((pg) => pg.file)).toEqual(['quick.png']);
    expect(app.chapterRef).toEqual({ projectId: p.id, chapterId: quick.id });

    app.pages[0].lines = [line('Ah')];
    await saveOpenChapter();
    expect(chapterJson(quick).pages[0].lines[0].en).toBe('Ah');
    expect(chapterJson(slow).pages[0].lines).toEqual([]);
    closeChapter();
  });

  it('refuses a sources edit to a chapter that is still opening', async () => {
    // `app.chapterRef` is null for the whole of a load, so the refusal that
    // keeps the sheet off an open chapter has to know about one on its way in -
    // the open finishes holding its own copy of the pages, and the first autosave
    // would put that straight back over whatever the sheet wrote.
    const { p, b } = await twoChapters();
    let refused;
    const hook = duringTheSwap(async () => {
      refused = await replaceCleanedPages(p.id, b.id, [fakeFile('n.png', 3)]).then(
        () => null,
        (e) => e,
      );
    });
    try {
      await openChapter(p.id, b.id);
    } finally {
      hook.restore();
    }
    expect(hook.entered).toBe(true);
    expect(refused?.message).toMatch(/open/);
    expect(chapterJson(b).pages[0].cleaned).toBeNull();
    closeChapter();
  });
});

// The two ends of the wiring, against the same fake disk the chapter uses: the
// chapter's own directory is where its undo history lives, and putting the
// chapter away is what gets the live page's stack into it.
const { record, history, resetHistory } = await import('./editor/history.svelte.js');
const { setEditSettleHook } = await import('./store.svelte.js');

describe('the undo history follows the chapter', () => {
  const historyJson = (c) => JSON.parse(fsx._tree.files.get(`${c.dir}/logs/history.json`));
  const aMove = (pageId) => ({
    t: 'move',
    pageId,
    boxId: 'b1',
    before: { x: 0, y: 0 },
    after: { x: 9, y: 9 },
  });
  // `openChapter` starts the history deliberately without awaiting it, so a
  // test has to let the microtasks it queued run before asking what it did.
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('writes the live page stack into the chapter it belongs to, on close', async () => {
    const { c } = await seedOpenChapter();
    await settled();
    const pid = app.pages[0].id;
    record(aMove(pid));
    closeChapter();
    await settled();
    expect(historyJson(c).pages[String(pid)].undo).toHaveLength(1);
    expect(history.canUndo).toBe(false); // and the live stack went with it
  });

  // The journal used to be started and left to arrive. The user can act the
  // instant the open resolves, and `openHistory` overwrites the document
  // unconditionally when it lands - so a page turn or an edit inside that window
  // met a read that wiped the in-flight records and loaded page one's stack over
  // whichever page they had moved to.
  it('has the page-one stack in hand the moment the open resolves', async () => {
    const { p, c } = await seedOpenChapter();
    await settled();
    record(aMove(app.pages[0].id));
    closeChapter();
    await settled();
    resetHistory();

    await openChapter(p.id, c.id);
    // No settle: this is the state the editor is handed.
    expect(history.canUndo).toBe(true);
    closeChapter();
    await settled();
  });

  it('brings that stack back when the chapter is opened again', async () => {
    const { p, c } = await seedOpenChapter();
    await settled();
    record(aMove(app.pages[0].id));
    closeChapter();
    await settled();
    resetHistory();
    await openChapter(p.id, c.id);
    await settled();
    expect(history.canUndo).toBe(true);
    closeChapter();
    await settled();
  });

  it('flushes the records on the way out of the app, alongside the document', async () => {
    const { c } = await seedOpenChapter();
    await settled();
    const pid = app.pages[0].id;
    record(aMove(pid));
    // The quit path: the window is destroyed the moment this resolves, so
    // anything still on the history's debounce has to have landed by then.
    expect(await flushBeforeLeaving('quit')).toBe(true);
    expect(historyJson(c).pages[String(pid)].undo).toHaveLength(1);
    closeChapter();
    await settled();
  });

  // A panel that coalesces a run of changes into one entry always leaves a
  // window in which the edit has been applied to the document and not yet
  // recorded. Leaving the editor unmounts that panel, so without a settle on
  // the way out the tweak reaches disk while its history entry never exists:
  // the stack comes back a step short of the document, and the next undo
  // rewinds the edit before it while the last one still stands.
  it('records an edit still inside its settle window before the editor is left', async () => {
    const { c } = await seedOpenChapter();
    await settled();
    const pid = app.pages[0].id;
    // Standing in for the Inspector's settle timer: an entry that exists only
    // for as long as someone asks for it, and dies with the panel otherwise.
    let pending = aMove(pid);
    setEditSettleHook(() => {
      if (pending) record(pending);
      pending = null;
    });
    try {
      expect(await flushBeforeLeaving('editor')).toBe(true);
    } finally {
      setEditSettleHook(null);
    }
    expect(history.canUndo).toBe(true);
    closeChapter();
    await settled();
    expect(historyJson(c).pages[String(pid)].undo).toHaveLength(1);
  });

  // The history module reports and swallows every failure, so the one thing
  // left that can go wrong in it is a call that never comes back - a volume
  // that has gone away, a wedged mount. The close-request path is single-flight,
  // so a window held open by that could not even be retried.
  it('does not let a history write that never returns pin the window open', async () => {
    await seedOpenChapter();
    await settled();
    record(aMove(app.pages[0].id));
    let release;
    const wedged = new Promise((r) => (release = r));
    const orig = fsx.writeTextFileAtomic;
    fsx.writeTextFileAtomic = function (path, body) {
      return path.endsWith('/logs/history.json')
        ? wedged.then(() => orig.call(this, path, body))
        : orig.call(this, path, body);
    };
    vi.useFakeTimers();
    try {
      const leaving = flushBeforeLeaving('quit');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await leaving).toBe(true);
    } finally {
      vi.useRealTimers();
      // Let the wedged write through on the way out: the queue it sits in is
      // module-global, and a case that left it stuck would take the next one
      // with it.
      release();
      await settled();
      fsx.writeTextFileAtomic = orig;
    }
    closeChapter();
    await settled();
  });
});

// Pages imported before `createChapter` measured them sit on disk as w:0,h:0.
// The canvas repairs one per visit, so a chapter nobody has flipped through end
// to end still exports blank sheets. The open is where the whole chapter can be
// repaired at once - and the repair has to be marked unsaved, or every open
// redoes it and never writes it.
describe('openChapter backfills unmeasured pages', () => {
  // A chapter written before the measuring import: both pages 0x0 on disk.
  async function seedUnmeasured() {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    const record = chapterJson(c);
    for (const pg of record.pages) {
      pg.w = 0;
      pg.h = 0;
    }
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    return { p, c };
  }

  it('measures every page stored 0x0 and marks the repair to be written', async () => {
    const { p, c } = await seedUnmeasured();
    await withDecoder({ 1: { width: 1080, height: 1535 }, 2: { width: 2160, height: 1535 } }, () =>
      openChapter(p.id, c.id),
    );
    // Per page, off each page's own bytes - a spread must not inherit its
    // neighbour's width.
    expect(app.pages.map((pg) => [pg.w, pg.h])).toEqual([
      [1080, 1535],
      [2160, 1535],
    ]);
    // Unsaved, or the repair never reaches disk and the next open redoes it.
    expect(app.saved).toBe(false);
    closeChapter();
  });

  it('leaves a page it cannot decode at 0 rather than guessing', async () => {
    const { p, c } = await seedUnmeasured();
    await withDecoder({ 1: { width: 1080, height: 1535 } }, () => openChapter(p.id, c.id));
    expect([app.pages[1].w, app.pages[1].h]).toEqual([0, 0]);
    closeChapter();
  });

  it('does not re-decode a chapter whose pages are already measured', async () => {
    // Seeded through a decoder, so `createChapter` measured it - unlike
    // `seedOpenChapter`, which runs in node's no-decoder case and therefore
    // writes exactly the 0x0 pages the two cases above are about.
    const sizes = { 1: { width: 1080, height: 1535 }, 2: { width: 2160, height: 1535 } };
    const p = await createProject('Series');
    const c = await withDecoder(sizes, () =>
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('page.png', 1), fakeFile('page.png', 2)],
      }),
    );
    let decodes = 0;
    await withDecoder(
      new Proxy(sizes, {
        get(t, k) {
          decodes++;
          return t[k];
        },
      }),
      () => openChapter(p.id, c.id),
    );
    // The open pays nothing on a measured chapter and - the point of the
    // `repaired` flag - does not schedule a write of what it just read.
    expect(decodes).toBe(0);
    expect(app.saved).toBe(true);
    closeChapter();
  });
});

// ===== the chapter's workflow mode =====
// A chapter is either being typeset or translated, and the answer lives in its
// own chapter.json - not in a preference, so two chapters in one project can
// disagree and each open the way its own file says.
const { setChapterMode } = await import('./library.svelte.js');
const { setTool } = await import('./store.svelte.js');

describe('the chapter mode on disk', () => {
  beforeEach(() => {
    closeChapter();
    setTool('place');
  });

  it('reads a chapter.json with no mode field as typeset', async () => {
    // Every chapter written before this field existed. None of them may change
    // behaviour, which is the whole reason the default is not stored.
    seedProject('old', PROJECT('p1', 'Old'), [['001', CHAPTER('c1', 1, [{ id: 1 }])]]);
    await scanLibrary();
    expect(chapterJson({ dir: '/lib/old/001' }).mode).toBeUndefined();
    expect(projectById('p1').chapters[0].mode).toBe('typeset');
  });

  it('reads an explicit mode, and refuses one it does not implement', async () => {
    const withMode = (id, n, mode) =>
      JSON.stringify({ schema: 1, id, number: n, title: '', mode, createdAt: 'T0', updatedAt: 'T0', pages: [] });
    seedProject('m', PROJECT('p1', 'M'), [
      ['001', withMode('c1', 1, 'translate')],
      ['002', withMode('c2', 2, 'typeset')],
      // Hand-edited, or written by something else. It must not leave a chapter
      // in a mode the editor has no branch for.
      ['003', withMode('c3', 3, 'clean')],
    ]);
    await scanLibrary();
    expect(projectById('p1').chapters.map((c) => c.mode)).toEqual(['translate', 'typeset', 'typeset']);
  });

  it('writes the mode a new chapter was created in, and defaults to typeset', async () => {
    const p = await createProject('Series');
    const t = await createChapter({
      projectId: p.id,
      number: 1,
      title: 'Translate me',
      files: [fakeFile('a.png', 1)],
      mode: 'translate',
    });
    expect(chapterJson(t).mode).toBe('translate');
    expect(t.mode).toBe('translate');

    const d = await createChapter({ projectId: p.id, number: 2, title: '', files: [fakeFile('b.png', 2)] });
    expect(chapterJson(d).mode).toBe('typeset');
    expect(d.mode).toBe('typeset');
  });
});

describe('opening a chapter in each mode', () => {
  beforeEach(() => {
    closeChapter();
    setTool('place');
  });
  afterEach(() => {
    closeChapter();
    setTool('place');
  });

  it('mirrors the chapter it opened, and puts the tool on the hand', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
      mode: 'translate',
    });
    await openChapter(p.id, c.id);
    expect(app.chapterMode).toBe('translate');
    // The place and text tools are about to leave the rail, so whatever the
    // previous chapter was left holding cannot survive into this one.
    expect(app.tool).toBe('pan');
  });

  it('leaks nothing from a translate chapter into the typeset one opened after it', async () => {
    const p = await createProject('Series');
    const t = await createChapter({
      projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)], mode: 'translate',
    });
    const s = await createChapter({
      projectId: p.id, number: 2, title: '', files: [fakeFile('b.png', 2)],
    });
    await openChapter(p.id, t.id);
    expect(app.chapterMode).toBe('translate');
    await openChapter(p.id, s.id);
    expect(app.chapterMode).toBe('typeset');
    // And the other way round, so neither order is the one that happens to work.
    await openChapter(p.id, t.id);
    expect(app.chapterMode).toBe('translate');
  });

  it('goes back to the default when the chapter closes', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)], mode: 'translate',
    });
    await openChapter(p.id, c.id);
    closeChapter();
    // Nothing typeset-specific may stay stripped on the way back to the library.
    expect(app.chapterMode).toBe('typeset');
  });
});

describe('switching a chapter mode from the project screen', () => {
  beforeEach(() => {
    closeChapter();
    setTool('place');
  });
  afterEach(() => closeChapter());

  it('patches a closed chapter.json without opening it', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    const before = chapterJson(c);

    await setChapterMode(p.id, c.id, 'translate');

    expect(chapterJson(c).mode).toBe('translate');
    expect(chapterById(p.id, c.id).mode).toBe('translate');
    // Nothing else in the record moved. A mode switch is one field, and the
    // pages are the part of this file that cannot be re-derived.
    expect(chapterJson(c).pages).toEqual(before.pages);
    // And no chapter was opened to do it.
    expect(app.chapterRef).toBeNull();

    await setChapterMode(p.id, c.id, 'typeset');
    expect(chapterJson(c).mode).toBe('typeset');
  });

  it('refuses a mode nothing implements rather than storing it', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    await setChapterMode(p.id, c.id, 'clean');
    expect(chapterJson(c).mode).toBe('typeset');
  });

  it('goes through the open document when that chapter is the one on screen', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    await openChapter(p.id, c.id);
    expect(app.saved).toBe(true);

    await setChapterMode(p.id, c.id, 'translate');
    // The state changes immediately - the editor is on screen and has to
    // restripe now - and the write is the ordinary autosave, so it cannot race
    // the open document's own next save into the same file.
    expect(app.chapterMode).toBe('translate');
    expect(app.tool).toBe('pan');
    expect(app.saved).toBe(false);
    expect(chapterJson(c).mode).toBe('typeset'); // not yet - the debounce owns it

    await saveOpenChapter();
    expect(chapterJson(c).mode).toBe('translate');
  });

  it('clears inline editing and bulk mode when switching open chapter to translate', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    await openChapter(p.id, c.id);
    app.editingId = 'b1';
    app.bulk.active = true;

    await setChapterMode(p.id, c.id, 'translate');

    expect(app.editingId).toBeNull();
    expect(app.bulk.active).toBe(false);
    expect(app.chapterMode).toBe('translate');
  });
});

// ===== translations.json =====
// A second file beside chapter.json, rewritten by every save in both modes. It
// is derived - chapter.json is still the only copy of anything - so nothing
// reads it back; it exists so the chapter's text is a plain JSON document on
// disk at all times rather than only after an export.
const { buildTextJson } = await import('./text-json.js');
const translationsJson = (c) => JSON.parse(fsx._tree.files.get(`${c.dir}/translations.json`));

describe('the translations file', () => {
  beforeEach(() => closeChapter());
  afterEach(() => closeChapter());

  it('is written when the chapter is created, from whatever lines it came with', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1), fakeFile('b.png', 2)],
      translations: [{ lines: [{ n: 1, jp: 'あ', en: 'Ah' }] }, { lines: [] }],
    });
    const doc = translationsJson(c);
    expect(doc.schema).toBe(1);
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0].lines).toEqual([
      expect.objectContaining({ n: 1, jp: 'あ', en: 'Ah' }),
    ]);
    expect(doc.pages[1].lines).toEqual([]);
  });

  it('exists from birth even for a chapter with nothing in it yet', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    expect(translationsJson(c).pages).toHaveLength(1);
  });

  it("follows every save, and is the export's own document", async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
      translations: [{ lines: [{ n: 1, jp: 'あ', en: '' }] }],
    });
    await openChapter(p.id, c.id);
    expect(translationsJson(c).pages[0].lines[0].en).toBe('');

    // What the queue's textarea does: write the line, mark the document dirty.
    // The 800ms debounce then carries both files, which is why this needs no
    // rule about saving every N boxes.
    page().lines[0].en = 'Ah';
    markUnsaved();
    await saveOpenChapter();

    expect(translationsJson(c).pages[0].lines[0].en).toBe('Ah');
    // Byte for byte the document `exportTextJson` writes, because it is the
    // same serialiser - two copies of one file format would drift the moment
    // either was touched.
    expect(fsx._tree.files.get(`${c.dir}/translations.json`)).toBe(buildTextJson(app.pages));
  });

  // Every edit made from the project screen goes through `commitPages`, which
  // used to write chapter.json alone. The derived file then sat there describing
  // the chapter as it had been before the re-import - for as long as nobody
  // happened to open the chapter in the editor and trip the autosave.
  it('follows an edit made while the chapter is closed', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
      translations: [{ lines: [{ n: 1, jp: 'あ', en: 'Old' }] }],
    });
    expect(translationsJson(c).pages[0].lines[0].en).toBe('Old');

    await applyTranslations(p.id, c.id, [
      { lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'New' }] },
    ]);

    expect(app.chapterRef).toBeNull(); // nothing was opened to do it
    expect(translationsJson(c).pages[0].lines[0].en).toBe('New');
  });

  it('follows a cleaned page whose raster is a different size', async () => {
    // The document carries each page's width and height, so a page op that
    // changes them is a page op this file has to hear about too.
    const p = await createProject('Series');
    const c = await withDecoder({ 1: { width: 1000, height: 1400 } }, () =>
      createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] }),
    );
    expect(translationsJson(c).pages[0]).toMatchObject({ width: 1000, height: 1400 });

    await withDecoder({ 5: { width: 2000, height: 2800 } }, () =>
      replaceCleanedPages(p.id, c.id, [fakeFile('hi.png', 5)]),
    );
    expect(translationsJson(c).pages[0]).toMatchObject({ width: 2000, height: 2800 });
  });

  it('is written beside the chapter it belongs to, never the one just opened', async () => {
    const p = await createProject('Series');
    const a = await createChapter({
      projectId: p.id, number: 1, title: '',
      files: [fakeFile('a.png', 1)],
      translations: [{ lines: [{ n: 1, jp: 'あ', en: 'From A' }] }],
    });
    const b = await createChapter({
      projectId: p.id, number: 2, title: '',
      files: [fakeFile('b.png', 2)],
      translations: [{ lines: [{ n: 1, jp: 'い', en: 'From B' }] }],
    });
    await openChapter(p.id, a.id);
    await saveOpenChapter();
    await openChapter(p.id, b.id);
    await saveOpenChapter();
    expect(translationsJson(a).pages[0].lines[0].en).toBe('From A');
    expect(translationsJson(b).pages[0].lines[0].en).toBe('From B');
  });
});

// ===========================================================================
// The project's page layout
// ===========================================================================
// Fixed when the project is created and never again - a longstrip project's
// pages are slices of one continuous drawing, and reading them back as separate
// pages describes art that does not exist. So what matters is that the flag
// survives everything that rewrites the record it lives in.
describe('the layout survives the project.json round trip', () => {
  const projectJson = (slug) => JSON.parse(fsx._tree.files.get(`/lib/${slug}/project.json`));

  it('defaults to pages, and is written even then', async () => {
    const p = await createProject('Paged Series');
    expect(p.layout).toBe('pages');
    expect(projectJson(p.slug).layout).toBe('pages');
  });

  it('writes the chosen layout and hands it back on the catalogue record', async () => {
    const p = await createProject('Webtoon', { layout: 'longstrip' });
    expect(projectJson(p.slug).layout).toBe('longstrip');
    expect(p.layout).toBe('longstrip');
  });

  it('refuses a layout it does not know rather than storing it', async () => {
    const p = await createProject('Odd', { layout: 'scroll-sideways' });
    expect(projectJson(p.slug).layout).toBe('pages');
  });

  it('reads back off disk, and reads a record written before the flag as pages', async () => {
    await createProject('Webtoon', { layout: 'longstrip' });
    // A slice 1 project.json: no `layout` key at all.
    seedProject('legacy', PROJECT('p-legacy', 'Legacy'));
    await scanLibrary();
    expect(projectById('p-legacy').layout).toBe('pages');
    expect(library.projects.find((x) => x.name === 'Webtoon').layout).toBe('longstrip');
  });

  // `buildChapter` rewrites project.json whole to move the cover, so anything it
  // does not name is deleted from a file that can never be re-answered.
  it('is not dropped when a chapter is added to the project', async () => {
    const p = await createProject('Webtoon', { layout: 'longstrip' });
    await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    expect(projectJson(p.slug).layout).toBe('longstrip');
    await scanLibrary();
    expect(projectById(p.id).layout).toBe('longstrip');
  });
});

describe('the OCR language belongs to one project', () => {
  const projectJson = (slug) => JSON.parse(fsx._tree.files.get(`/lib/${slug}/project.json`));

  it('stores a language for either layout and defaults old or invalid values to Japanese', async () => {
    const korean = await createProject('Korean Strip', { layout: 'longstrip', ocrLanguage: 'ko' });
    const invalid = await createProject('Unknown Strip', { layout: 'longstrip', ocrLanguage: 'xx' });
    const pages = await createProject('Pages', { layout: 'pages', ocrLanguage: 'zh' });
    expect(korean.ocrLanguage).toBe('ko');
    expect(projectJson(korean.slug).ocrLanguage).toBe('ko');
    expect(invalid.ocrLanguage).toBe('ja');
    expect(pages.ocrLanguage).toBe('zh');
    expect(projectJson(pages.slug).ocrLanguage).toBe('zh');

    seedProject('legacy-language', PROJECT('p-legacy-language', 'Legacy language'));
    await scanLibrary();
    expect(projectById('p-legacy-language').ocrLanguage).toBe('ja');
  });

  it('adopts the Korean branch preference for old projects with no language field', async () => {
    const originalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => key === 'mt.prefs' ? '{"projectLanguage":"ko"}' : null,
    };
    try {
      seedProject('old-korean', PROJECT('p-old-korean', 'Old Korean'));
      await scanLibrary();
      expect(projectById('p-old-korean').ocrLanguage).toBe('ko');
    } finally {
      if (originalStorage) globalThis.localStorage = originalStorage;
      else delete globalThis.localStorage;
    }
  });

  it('lets an existing paged project switch to Korean and persists the choice', async () => {
    const p = await createProject('Korean Pages', { layout: 'pages' });
    expect(p.ocrLanguage).toBe('ja');
    await setProjectOcrLanguage(p.id, 'ko');
    expect(p.ocrLanguage).toBe('ko');
    expect(projectJson(p.slug).ocrLanguage).toBe('ko');
    await scanLibrary();
    expect(projectById(p.id).ocrLanguage).toBe('ko');
  });

  it('survives a whole project.json rewrite when a chapter is added', async () => {
    const p = await createProject('Chinese Strip', { layout: 'longstrip', ocrLanguage: 'zh' });
    await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    expect(projectJson(p.slug).ocrLanguage).toBe('zh');
  });

  it('is mirrored on open, reset on close, and never leaks to another project', async () => {
    const korean = await createProject('Korean Strip', { layout: 'longstrip', ocrLanguage: 'ko' });
    const koreanChapter = await createChapter({
      projectId: korean.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    const japanese = await createProject('Japanese Strip', { layout: 'longstrip' });
    const japaneseChapter = await createChapter({
      projectId: japanese.id,
      number: 1,
      title: '',
      files: [fakeFile('b.png', 2)],
    });

    await openChapter(korean.id, koreanChapter.id);
    expect(app.projectOcrLanguage).toBe('ko');
    await openChapter(japanese.id, japaneseChapter.id);
    expect(app.projectOcrLanguage).toBe('ja');
    closeChapter();
    expect(app.projectOcrLanguage).toBe('ja');
  });
});

describe('the open chapter carries its project\'s layout', () => {
  afterEach(() => closeChapter());

  it('is set from the owning project on open and put back on close', async () => {
    const p = await createProject('Webtoon', { layout: 'longstrip' });
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    await openChapter(p.id, c.id);
    expect(app.projectLayout).toBe('longstrip');
    closeChapter();
    expect(app.projectLayout).toBe('pages');
  });

  // Two projects, opened one after the other: the second must not inherit the
  // first's layout, the same way it must not inherit its mode.
  it('is rewritten on every open rather than left standing', async () => {
    const strip = await createProject('Webtoon', { layout: 'longstrip' });
    const stripC = await createChapter({ projectId: strip.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    const paged = await createProject('Paged');
    const pagedC = await createChapter({ projectId: paged.id, number: 1, title: '', files: [fakeFile('b.png', 2)] });

    await openChapter(strip.id, stripC.id);
    expect(app.projectLayout).toBe('longstrip');
    await openChapter(paged.id, pagedC.id);
    expect(app.projectLayout).toBe('pages');
  });
});

// A chapter rebuilt from PSD pages requires validated, non-empty file names and
// deterministically deduplicates duplicate names on disk.
describe('createChapterFromPages', () => {
  it('writes chapter with raws and cleaned pages and appears in catalogue', async () => {
    const p = await createProject('PsdSeries');
    const c = await createChapterFromPages({
      projectId: p.id,
      number: 1,
      title: 'From PSD',
      pages: [
        {
          rawName: 'p001.png',
          rawBytes: new Uint8Array([1, 2, 3]),
          cleanedName: 'p001-cleaned.png',
          cleanedBytes: new Uint8Array([4, 5, 6]),
          w: 1000,
          h: 1500,
          lines: [{ n: 1, text: 'Hello' }],
          boxes: [],
        },
      ],
    });
    expect(c.slug).toBe('001-from-psd');
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    expect(json.pages[0].file).toBe('p001.png');
    expect(json.pages[0].cleaned).toBe('p001-cleaned.png');
    expect(fsx._tree.files.get(`${c.dir}/raws/p001.png`)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fsx._tree.files.get(`${c.dir}/cleaned/p001-cleaned.png`)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('rejects pages missing rawName (undefined, null, empty string, or whitespace)', async () => {
    const p = await createProject('Series');
    await expect(
      createChapterFromPages({
        projectId: p.id,
        number: 1,
        title: '',
        pages: [{ rawName: undefined, rawBytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/file name/i);

    await expect(
      createChapterFromPages({
        projectId: p.id,
        number: 1,
        title: '',
        pages: [{ rawName: '', rawBytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/file name/i);

    await expect(
      createChapterFromPages({
        projectId: p.id,
        number: 1,
        title: '',
        pages: [{ rawName: '   ', rawBytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/file name/i);

    expect(projectById(p.id).chapters).toHaveLength(0);
  });

  it('rejects cleaned pages missing cleanedName when cleanedBytes is provided', async () => {
    const p = await createProject('Series');
    await expect(
      createChapterFromPages({
        projectId: p.id,
        number: 1,
        title: '',
        pages: [
          {
            rawName: 'p1.png',
            rawBytes: new Uint8Array([1]),
            cleanedName: null,
            cleanedBytes: new Uint8Array([2]),
          },
        ],
      }),
    ).rejects.toThrow(/cleaned.*file name/i);
  });

  it('deduplicates colliding rawNames deterministically across multiple pages', async () => {
    const p = await createProject('Series');
    const c = await createChapterFromPages({
      projectId: p.id,
      number: 1,
      title: '',
      pages: [
        { rawName: 'page.png', rawBytes: new Uint8Array([1]) },
        { rawName: 'page.png', rawBytes: new Uint8Array([2]) },
      ],
    });
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    expect(json.pages.map((pg) => pg.file)).toEqual(['page.png', 'page-2.png']);
    expect(fsx._tree.files.get(`${c.dir}/raws/page.png`)).toEqual(new Uint8Array([1]));
    expect(fsx._tree.files.get(`${c.dir}/raws/page-2.png`)).toEqual(new Uint8Array([2]));
  });
});

describe('chapter packages', () => {
  it('createChapterFromPages carries the mode into the record', async () => {
    const p = await createProject('Series');
    const c = await createChapterFromPages({
      projectId: p.id,
      number: 3,
      title: '',
      mode: 'translate',
      pages: [{ rawName: 'p1.png', rawBytes: new Uint8Array([1]) }],
    });
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    expect(json.mode).toBe('translate');
    expect(c.mode).toBe('translate');
  });

  it('readChapterPackageSources returns the record and every named file byte-for-byte', async () => {
    const p = await createProject('Series', { layout: 'longstrip', ocrLanguage: 'zh' });
    const c = await createChapterFromPages({
      projectId: p.id,
      number: 1,
      title: 'One',
      pages: [
        {
          rawName: 'a.png',
          rawBytes: new Uint8Array([1, 2]),
          cleanedName: 'a-c.png',
          cleanedBytes: new Uint8Array([3]),
          w: 10,
          h: 20,
          lines: [{ n: 1, text: 'x' }],
          boxes: [{ id: 'b1', lineN: 1, x: 1, y: 2, w: 3, h: 4, style: { font: 'F' } }],
        },
        { rawName: 'b.png', rawBytes: new Uint8Array([4, 5, 6]) },
      ],
    });
    const src = await readChapterPackageSources(p.id, c.id);
    expect(src.record.number).toBe(1);
    expect(src.record.title).toBe('One');
    expect(src.record.pages).toHaveLength(2);
    expect(src.record.pages[0].boxes[0].id).toBe('b1');
    expect(src.project).toEqual({ name: 'Series', layout: 'longstrip', ocrLanguage: 'zh' });
    expect(src.raws.get('a.png')).toEqual(new Uint8Array([1, 2]));
    expect(src.raws.get('b.png')).toEqual(new Uint8Array([4, 5, 6]));
    expect(src.cleaned.get('a-c.png')).toEqual(new Uint8Array([3]));
    expect(typeof src.translations).toBe('string');
    expect(JSON.parse(src.translations)).toBeTruthy();
  });

  it('readChapterPackageSources refuses an unreadable chapter', async () => {
    seedProject('s', PROJECT('p1', 'S'), [['001', '{not json']]);
    await scanLibrary();
    const c = projectById('p1').chapters[0];
    await expect(readChapterPackageSources('p1', c.id)).rejects.toThrow(/could not be read/);
  });
});
