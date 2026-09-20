// ===== Chapter package (.mtchapter) =====
// One chapter, with everything another machine needs to keep working on it, in
// a single ZIP. Pure: bytes in, bytes out. No filesystem, no store, no DOM - the
// app-side orchestration (reading the chapter's files, pulling font bytes out
// of IndexedDB, creating the chapter on import) lives in package-flow.js.
//
// Layout inside the archive - see docs/superpowers/specs/2026-08-22-chapter-package-design.md:
//
//   manifest.json
//   chapter.json                    the record exactly as it sits on disk
//   translations.json               derived text JSON (nothing reads it back)
//   raws/<file>                     byte-for-byte
//   cleaned/<file>                  byte-for-byte, only pages that have one
//   fonts/<family>/<slot>/<file>    user font faces; built-ins are named only
//
// Rasters and fonts are stored, not deflated - PNG/JPG/WebP/TTF/OTF/WOFF2 are
// already compressed and deflating them again costs time for nothing. The JSON
// files are deflated.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export const PACKAGE_FORMAT = 'manga-typesetter/chapter';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXT = 'mtchapter';

const FACE_SLOTS = ['regular', 'bold', 'italic', 'boldItalic'];

// A name that resolves to one plain file inside its directory: no separators,
// no traversal. The same rule the library applies to page file names, applied
// here to everything the archive names, because an archive is a file somebody
// else wrote.
export const isPlainFileName = (name) =>
  typeof name === 'string' &&
  name.trim().length > 0 &&
  !name.includes('/') &&
  !name.includes('\\') &&
  name !== '.' &&
  name !== '..';

const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));

// Sanitise a family name into a single path segment for `fonts/<family>/`.
// Only used to build the archive path; the real family name travels in the
// manifest, so a lossy fold here costs nothing.
const familySegment = (name) => String(name).replace(/[\\/]+/g, '_').trim() || 'font';

// ---------- build ----------

// input:
//   record        the chapter.json record (pages with file/cleaned/w/h/lines/detect/boxes)
//   translations  string, the derived text JSON (optional)
//   project       { name, layout, ocrLanguage }
//   raws          Map<fileName, Uint8Array>   every page.file must be present
//   cleaned       Map<fileName, Uint8Array>   every page.cleaned must be present
//   fonts         [{ name, faces: { slot: { file, data } | null } }]  user fonts only
//   tags          [{ name, font, outline, outlineWidth }]
//   app           version string
//   exportedAt    ISO string (passed in, so the builder stays deterministic in tests)
export function buildChapterPackage({
  record,
  translations = null,
  project = {},
  raws = new Map(),
  cleaned = new Map(),
  fonts = [],
  tags = [],
  app = '',
  exportedAt = new Date().toISOString(),
}) {
  if (!record || !Array.isArray(record.pages)) throw new Error('No chapter record to package');

  const files = {};
  const store = (bytes) => [u8(bytes), { level: 0 }];

  for (const pg of record.pages) {
    if (!isPlainFileName(pg.file)) throw new Error(`Page ${pg.id} has no file name`);
    const raw = raws.get(pg.file);
    if (!raw) throw new Error(`Missing raw image "${pg.file}"`);
    files[`raws/${pg.file}`] = store(raw);
    if (pg.cleaned) {
      if (!isPlainFileName(pg.cleaned)) throw new Error(`Page ${pg.id} has a bad cleaned file name`);
      const cl = cleaned.get(pg.cleaned);
      if (!cl) throw new Error(`Missing cleaned image "${pg.cleaned}"`);
      files[`cleaned/${pg.cleaned}`] = store(cl);
    }
  }

  const manifestFonts = [];
  for (const f of fonts) {
    if (!f?.name) continue;
    const seg = familySegment(f.name);
    const faces = {};
    for (const slot of FACE_SLOTS) {
      const face = f.faces?.[slot];
      if (!face?.data || !isPlainFileName(face.file)) {
        faces[slot] = null;
        continue;
      }
      const path = `fonts/${seg}/${slot}/${face.file}`;
      files[path] = store(face.data);
      faces[slot] = path;
    }
    manifestFonts.push({ name: f.name, faces });
  }

  const manifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    app,
    exportedAt,
    project: {
      name: project.name ?? '',
      layout: project.layout ?? 'pages',
      ocrLanguage: project.ocrLanguage ?? 'ja',
    },
    chapter: {
      number: record.number ?? 0,
      title: record.title ?? '',
      mode: record.mode ?? 'typeset',
      pageCount: record.pages.length,
    },
    fonts: manifestFonts,
    tags: tags.map((t) => ({
      name: t.name,
      font: t.font ?? null,
      outline: t.outline ?? null,
      outlineWidth: t.outlineWidth ?? null,
    })),
  };

  files['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  files['chapter.json'] = [strToU8(JSON.stringify(record, null, 2)), { level: 6 }];
  if (typeof translations === 'string') {
    files['translations.json'] = [strToU8(translations), { level: 6 }];
  }

  return zipSync(files);
}

// ---------- read ----------

function parseJson(entries, name) {
  const bytes = entries[name];
  if (!bytes) throw new Error(`Not a chapter package - no ${name}`);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error(`Not a chapter package - ${name} is not valid JSON`);
  }
}

// Returns
//   { manifest, record, translations, raws: Map, cleaned: Map,
//     fonts: [{ name, faces: { slot: { file, data } | null } }], tags: [...] }
// Throws on anything that is not a package this build can import. Every file
// name is checked to be plain before it is handed to anything that writes.
export function readChapterPackage(bytes) {
  let entries;
  try {
    entries = unzipSync(u8(bytes));
  } catch {
    throw new Error('Not a chapter package - could not read the archive');
  }
  const manifest = parseJson(entries, 'manifest.json');
  if (manifest.format !== PACKAGE_FORMAT) throw new Error('Not a chapter package');
  if (typeof manifest.version !== 'number' || manifest.version > PACKAGE_VERSION) {
    throw new Error(`This package was made by a newer version of the app (format ${manifest.version})`);
  }
  const record = parseJson(entries, 'chapter.json');
  if (!Array.isArray(record.pages)) throw new Error('The package has no pages');

  const raws = new Map();
  const cleaned = new Map();
  record.pages.forEach((pg, i) => {
    if (!isPlainFileName(pg?.file)) throw new Error(`Page ${i + 1} has no file name`);
    const raw = entries[`raws/${pg.file}`];
    if (!raw) throw new Error(`Page ${i + 1} is missing its image "${pg.file}"`);
    raws.set(pg.file, raw);
    if (pg.cleaned != null) {
      if (!isPlainFileName(pg.cleaned)) throw new Error(`Page ${i + 1} has a bad cleaned file name`);
      const cl = entries[`cleaned/${pg.cleaned}`];
      if (!cl) throw new Error(`Page ${i + 1} is missing its cleaned image "${pg.cleaned}"`);
      cleaned.set(pg.cleaned, cl);
    }
  });

  const fonts = [];
  for (const f of Array.isArray(manifest.fonts) ? manifest.fonts : []) {
    if (typeof f?.name !== 'string' || !f.name.trim()) continue;
    const faces = {};
    let any = false;
    for (const slot of FACE_SLOTS) {
      const path = f.faces?.[slot];
      const data = typeof path === 'string' ? entries[path] : null;
      const file = typeof path === 'string' ? path.split('/').pop() : null;
      if (data && isPlainFileName(file)) {
        faces[slot] = { file, data };
        any = true;
      } else {
        faces[slot] = null;
      }
    }
    // A family that ships no bytes at all is still worth naming: the dialog
    // can say "built-in" or "not included" about it.
    fonts.push({ name: f.name, faces, shipped: any });
  }

  const tags = [];
  for (const t of Array.isArray(manifest.tags) ? manifest.tags : []) {
    if (typeof t?.name !== 'string' || !t.name.trim()) continue;
    tags.push({
      name: t.name,
      font: typeof t.font === 'string' && t.font ? t.font : null,
      outline: typeof t.outline === 'string' && t.outline ? t.outline : null,
      outlineWidth: typeof t.outlineWidth === 'number' && Number.isFinite(t.outlineWidth) ? t.outlineWidth : null,
    });
  }

  const translations = entries['translations.json'] ? strFromU8(entries['translations.json']) : null;

  return { manifest, record, translations, raws, cleaned, fonts, tags };
}

// The pages `createChapterFromPages` takes, built from a read package.
export function packagePagesForImport(pkg) {
  return pkg.record.pages.map((pg) => ({
    rawName: pg.file,
    rawBytes: pkg.raws.get(pg.file),
    cleanedName: pg.cleaned ?? null,
    cleanedBytes: pg.cleaned ? (pkg.cleaned.get(pg.cleaned) ?? null) : null,
    w: pg.w ?? 0,
    h: pg.h ?? 0,
    lines: pg.lines ?? [],
    detect: pg.detect ?? null,
    boxes: pg.boxes ?? [],
  }));
}

// The family names a chapter's typesetting depends on: every box's font and
// the font default of every tag in use. Names only; the caller decides which
// are user fonts with bytes to ship.
export function fontFamiliesUsed(pages = [], tagEntries = []) {
  const out = new Set();
  for (const p of pages) {
    for (const b of p?.boxes ?? []) if (b?.style?.font) out.add(b.style.font);
  }
  for (const t of tagEntries) if (t?.font) out.add(t.font);
  return [...out];
}

// Default file name for an exported package.
export function packageFileName(projectName, chapterNumber) {
  const stem = String(projectName ?? 'chapter')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `${stem || 'chapter'}-ch${chapterNumber ?? 0}.${PACKAGE_EXT}`;
}
