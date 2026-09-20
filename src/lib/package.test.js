import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import {
  buildChapterPackage,
  readChapterPackage,
  packagePagesForImport,
  fontFamiliesUsed,
  packageFileName,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
} from './package.js';

const bytes = (...n) => new Uint8Array(n);

function sampleRecord() {
  return {
    schema: 1,
    id: 'c_1',
    number: 7,
    title: 'Seven',
    mode: 'typeset',
    createdAt: 'a',
    updatedAt: 'b',
    pages: [
      {
        id: 1,
        file: 'p1.png',
        cleaned: 'p1-clean.png',
        w: 800,
        h: 1200,
        lines: [{ n: 1, jp: 'a', en: 'b', tags: ['sfx'] }],
        detect: { panels: [], boxes: [] },
        boxes: [
          { id: 'b1', lineN: 1, x: 10, y: 20, w: 100, h: 50, style: { font: 'Wild Words', size: 20 } },
        ],
      },
      { id: 2, file: 'p2.png', cleaned: null, w: 0, h: 0, lines: [], detect: null, boxes: [] },
    ],
  };
}

function sampleInput() {
  return {
    record: sampleRecord(),
    translations: '{"pages":[]}',
    project: { name: 'My Series', layout: 'longstrip', ocrLanguage: 'ko' },
    raws: new Map([
      ['p1.png', bytes(1, 2, 3)],
      ['p2.png', bytes(4, 5)],
    ]),
    cleaned: new Map([['p1-clean.png', bytes(9, 9, 9, 9)]]),
    fonts: [
      {
        name: 'Wild Words',
        faces: {
          regular: { file: 'WW-Regular.ttf', data: bytes(7, 7) },
          bold: { file: 'WW-Bold.ttf', data: bytes(8, 8, 8) },
          italic: null,
          boldItalic: null,
        },
      },
    ],
    tags: [{ name: 'sfx', font: 'Wild Words', outline: '#fff', outlineWidth: 3 }],
    app: '0.1.1',
    exportedAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('buildChapterPackage', () => {
  it('writes the expected entries', () => {
    const zip = buildChapterPackage(sampleInput());
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(
      [
        'chapter.json',
        'cleaned/p1-clean.png',
        'fonts/Wild Words/bold/WW-Bold.ttf',
        'fonts/Wild Words/regular/WW-Regular.ttf',
        'manifest.json',
        'raws/p1.png',
        'raws/p2.png',
        'translations.json',
      ].sort(),
    );
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest.format).toBe(PACKAGE_FORMAT);
    expect(manifest.version).toBe(PACKAGE_VERSION);
    expect(manifest.project).toEqual({ name: 'My Series', layout: 'longstrip', ocrLanguage: 'ko' });
    expect(manifest.chapter).toEqual({ number: 7, title: 'Seven', mode: 'typeset', pageCount: 2 });
    expect(manifest.fonts).toEqual([
      {
        name: 'Wild Words',
        faces: {
          regular: 'fonts/Wild Words/regular/WW-Regular.ttf',
          bold: 'fonts/Wild Words/bold/WW-Bold.ttf',
          italic: null,
          boldItalic: null,
        },
      },
    ]);
    expect(manifest.tags).toEqual([{ name: 'sfx', font: 'Wild Words', outline: '#fff', outlineWidth: 3 }]);
    // Rasters are byte-for-byte.
    expect([...entries['raws/p1.png']]).toEqual([1, 2, 3]);
    expect([...entries['cleaned/p1-clean.png']]).toEqual([9, 9, 9, 9]);
  });

  it('refuses a page whose raw bytes are missing', () => {
    const input = sampleInput();
    input.raws.delete('p2.png');
    expect(() => buildChapterPackage(input)).toThrow(/p2\.png/);
  });

  it('refuses a page whose cleaned bytes are missing', () => {
    const input = sampleInput();
    input.cleaned.delete('p1-clean.png');
    expect(() => buildChapterPackage(input)).toThrow(/p1-clean\.png/);
  });

  it('refuses a page with a traversing file name', () => {
    const input = sampleInput();
    input.record.pages[0].file = '../p1.png';
    input.raws.set('../p1.png', bytes(1));
    expect(() => buildChapterPackage(input)).toThrow(/file name/);
  });
});

describe('readChapterPackage', () => {
  it('round-trips everything the builder put in', () => {
    const pkg = readChapterPackage(buildChapterPackage(sampleInput()));
    expect(pkg.record).toEqual(sampleRecord());
    expect(pkg.translations).toBe('{"pages":[]}');
    expect(pkg.manifest.project.layout).toBe('longstrip');
    expect(pkg.manifest.project.ocrLanguage).toBe('ko');
    expect([...pkg.raws.get('p1.png')]).toEqual([1, 2, 3]);
    expect([...pkg.raws.get('p2.png')]).toEqual([4, 5]);
    expect([...pkg.cleaned.get('p1-clean.png')]).toEqual([9, 9, 9, 9]);
    expect(pkg.fonts).toHaveLength(1);
    expect(pkg.fonts[0].name).toBe('Wild Words');
    expect(pkg.fonts[0].shipped).toBe(true);
    expect(pkg.fonts[0].faces.regular.file).toBe('WW-Regular.ttf');
    expect([...pkg.fonts[0].faces.regular.data]).toEqual([7, 7]);
    expect([...pkg.fonts[0].faces.bold.data]).toEqual([8, 8, 8]);
    expect(pkg.fonts[0].faces.italic).toBeNull();
    expect(pkg.tags).toEqual([{ name: 'sfx', font: 'Wild Words', outline: '#fff', outlineWidth: 3 }]);
  });

  it('rejects bytes that are not a zip', () => {
    expect(() => readChapterPackage(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a chapter package/);
  });

  it('rejects a zip with the wrong format tag', () => {
    const input = sampleInput();
    const zip = buildChapterPackage(input);
    const entries = unzipSync(zip);
    const m = JSON.parse(strFromU8(entries['manifest.json']));
    m.format = 'something-else';
    const bad = zipSync({ ...entries, 'manifest.json': strToU8(JSON.stringify(m)) });
    expect(() => readChapterPackage(bad)).toThrow(/Not a chapter package/);
  });

  it('rejects a newer format version', () => {
    const entries = unzipSync(buildChapterPackage(sampleInput()));
    const m = JSON.parse(strFromU8(entries['manifest.json']));
    m.version = PACKAGE_VERSION + 1;
    const bad = zipSync({ ...entries, 'manifest.json': strToU8(JSON.stringify(m)) });
    expect(() => readChapterPackage(bad)).toThrow(/newer version/);
  });

  it('rejects a package whose page image is missing from the archive', () => {
    const entries = unzipSync(buildChapterPackage(sampleInput()));
    delete entries['raws/p2.png'];
    const bad = zipSync(entries);
    expect(() => readChapterPackage(bad)).toThrow(/Page 2 is missing its image/);
  });

  it('rejects a record whose page file name traverses', () => {
    const entries = unzipSync(buildChapterPackage(sampleInput()));
    const rec = JSON.parse(strFromU8(entries['chapter.json']));
    rec.pages[1].file = '../../etc/passwd';
    entries['raws/../../etc/passwd'] = bytes(1);
    const bad = zipSync({ ...entries, 'chapter.json': strToU8(JSON.stringify(rec)) });
    expect(() => readChapterPackage(bad)).toThrow(/file name/);
  });

  it('keeps a font family that ships no bytes, marked unshipped', () => {
    const entries = unzipSync(buildChapterPackage(sampleInput()));
    const m = JSON.parse(strFromU8(entries['manifest.json']));
    m.fonts.push({ name: 'Ghost', faces: {} });
    const zip = zipSync({ ...entries, 'manifest.json': strToU8(JSON.stringify(m)) });
    const pkg = readChapterPackage(zip);
    const ghost = pkg.fonts.find((f) => f.name === 'Ghost');
    expect(ghost.shipped).toBe(false);
    expect(ghost.faces.regular).toBeNull();
  });
});

describe('packagePagesForImport', () => {
  it('shapes pages the way createChapterFromPages takes them', () => {
    const pkg = readChapterPackage(buildChapterPackage(sampleInput()));
    const pages = packagePagesForImport(pkg);
    expect(pages).toHaveLength(2);
    expect(pages[0].rawName).toBe('p1.png');
    expect([...pages[0].rawBytes]).toEqual([1, 2, 3]);
    expect(pages[0].cleanedName).toBe('p1-clean.png');
    expect([...pages[0].cleanedBytes]).toEqual([9, 9, 9, 9]);
    expect(pages[0].w).toBe(800);
    expect(pages[0].boxes[0].id).toBe('b1');
    expect(pages[0].boxes[0].style.font).toBe('Wild Words');
    expect(pages[0].lines[0].tags).toEqual(['sfx']);
    expect(pages[1].cleanedName).toBeNull();
    expect(pages[1].cleanedBytes).toBeNull();
  });
});

describe('fontFamiliesUsed', () => {
  it('collects box fonts and tag default fonts, once each', () => {
    const pages = [
      { boxes: [{ style: { font: 'A' } }, { style: { font: 'B' } }] },
      { boxes: [{ style: { font: 'A' } }, { style: {} }] },
    ];
    const tags = [{ name: 'sfx', font: 'C' }, { name: 'x', font: null }];
    expect(fontFamiliesUsed(pages, tags)).toEqual(['A', 'B', 'C']);
  });
});

describe('packageFileName', () => {
  it('builds a safe default name', () => {
    expect(packageFileName('My Series: Vol 1', 7)).toBe('My-Series-Vol-1-ch7.mtchapter');
    expect(packageFileName('', 2)).toBe('chapter-ch2.mtchapter');
  });
});
