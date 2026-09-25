// ===== Chapter package: the app-side flow =====
// package.js knows the bytes; this knows the app. Export reads a closed
// chapter's files and font bytes and hands them to the builder; import takes a
// read package apart into the library, the font store and the tag registry.
import { fsx } from './fsx.js';
import {
  projectById,
  createChapterFromPages,
  readChapterPackageSources,
  projectTag,
  addProjectTags,
} from './library.svelte.js';
import { userFontRecords, installFontFace } from './fonts.js';
import { tagsInUse } from './tags.svelte.js';
import { app, normalizeLayout, normalizeOcrLanguage } from './store.svelte.js';
import { isTauri, pickFilesTauri } from './importer.js';
import {
  buildChapterPackage,
  readChapterPackage,
  packagePagesForImport,
  fontFamiliesUsed,
  packageFileName,
  PACKAGE_EXT,
} from './package.js';
import { legacyTypesetting } from './data.js';

async function appVersion() {
  if (!isTauri()) return '';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '';
  }
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- export ----------

// A record from before the typesetting field existed opens with whatever
// this machine's legacy answer was (legacyTypesetting()). Stamp it on export
// so the other machine opens it the same way instead of falling back to
// plain. A copy: the record read from disk is left as it was.
export function recordForExport(record) {
  if (!record || record.typesetting != null) return record;
  return { ...record, typesetting: legacyTypesetting() };
}

// Build the package for a closed chapter and save it through the OS dialog.
// Resolves to the path written, or null when the user cancelled. Throws when
// the chapter cannot be read or the write fails.
export async function exportChapterPackage(projectId, chapterId) {
  const p = projectById(projectId);
  if (!p) throw new Error('No such project');
  const src = await readChapterPackageSources(projectId, chapterId);
  const record = recordForExport(src.record);
  const pages = record.pages ?? [];

  // The tag vocabulary this chapter uses, as its PROJECT knows it - the registry
  // is the project's, not the machine's. Entries the project has never
  // configured travel as names with no defaults - which is what they are here.
  const inUse = tagsInUse(pages);
  const tagEntries = inUse.map(
    (name) => projectTag(projectId, name) ?? { name, font: null, outline: null, outlineWidth: null },
  );

  // Only user fonts carry bytes; a built-in is named in the style and the other
  // machine has it too.
  const families = fontFamiliesUsed(pages, tagEntries).filter(
    (name) => !app.fonts.builtin.some((f) => f.name === name),
  );
  const found = await userFontRecords(families);
  // A family the chapter names but this machine has no bytes for still goes in
  // the manifest, empty - so the importing side can say "missing" about it
  // instead of silently drawing the fallback.
  const fonts = families.map(
    (name) => found.find((f) => f.name === name) ?? { name, faces: {} },
  );

  const bytes = buildChapterPackage({
    record,
    translations: src.translations,
    project: src.project,
    raws: src.raws,
    cleaned: src.cleaned,
    fonts,
    tags: tagEntries,
    app: await appVersion(),
  });
  const name = packageFileName(p.name, record.number);

  if (!isTauri()) {
    downloadBytes(bytes, name);
    return name;
  }
  const [{ save }, { join }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/path'),
  ]);
  const defaultPath = app.exportDir ? await join(app.exportDir, name) : name;
  const path = await save({
    defaultPath,
    filters: [{ name: 'Chapter package', extensions: [PACKAGE_EXT] }],
  });
  if (!path) return null;
  await fsx.writeFileAtomic(path, bytes);
  return path;
}

// ---------- import ----------

export async function pickPackageFile() {
  if (isTauri()) {
    const files = await pickFilesTauri({
      name: 'Chapter package',
      extensions: [PACKAGE_EXT, 'zip'],
      multiple: false,
    });
    return files?.[0] ?? null;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = `.${PACKAGE_EXT},.zip,application/zip`;
  await new Promise((resolve) => {
    input.onchange = resolve;
    input.click();
  });
  return input.files?.[0] ?? null;
}

// What a font in the package means on THIS machine.
//   'install'  shipped in the package and at least one of its faces is not here yet
//   'present'  every shipped face is already in the library
//   'builtin'  a bundled Google family - nothing to do
//   'missing'  named by the chapter but the package carries no bytes and the
//              library here has none either - boxes will fall back
export function fontStatus(f) {
  if (app.fonts.builtin.some((b) => b.name === f.name)) return 'builtin';
  const local = app.fonts.user.find((u) => u.name === f.name)?.faces ?? null;
  if (!f.shipped) return local ? 'present' : 'missing';
  const slots = Object.keys(f.faces).filter((s) => f.faces[s]);
  return slots.every((s) => local?.[s]) ? 'present' : 'install';
}

// Parse a picked file and describe it for the dialog. Throws the reader's
// message for anything that is not a package.
// `projectId` is the project the package would land in; a tag is 'known' when
// that project's registry already has it, since registries are per project.
export async function inspectPackage(file, projectId = null) {
  const pkg = readChapterPackage(new Uint8Array(await file.arrayBuffer()));
  const { manifest, record } = pkg;
  return {
    pkg,
    summary: {
      number: Number.isFinite(Number(record.number)) ? Number(record.number) : 1,
      title: record.title ?? '',
      mode: record.mode === 'translate' ? 'translate' : 'typeset',
      pageCount: record.pages.length,
      cleanedCount: record.pages.filter((pg) => pg.cleaned).length,
      boxCount: record.pages.reduce((n, pg) => n + (pg.boxes?.length ?? 0), 0),
      layout: normalizeLayout(manifest.project?.layout),
      ocrLanguage: normalizeOcrLanguage(manifest.project?.ocrLanguage),
      projectName: manifest.project?.name ?? '',
      app: manifest.app ?? '',
      exportedAt: manifest.exportedAt ?? '',
      fonts: pkg.fonts.map((f) => ({ name: f.name, status: fontStatus(f) })),
      tags: pkg.tags.map((t) => ({ name: t.name, status: projectTag(projectId, t.name) ? 'known' : 'new' })),
    },
  };
}

// Fonts first, tags second, chapter last - so a chapter that lands is one
// whose fonts are already registered when it first draws. A font that fails to
// load is counted and does not stop the import: the chapter still renders on
// the fallback, and the user can add the face by hand.
// Returns { chapter, fontsInstalled, fontsFailed, tagsAdded }.
export async function importChapterPackage({ pkg, projectId, number, title }) {
  let fontsInstalled = 0;
  let fontsFailed = 0;
  for (const f of pkg.fonts) {
    for (const slot of Object.keys(f.faces)) {
      const face = f.faces[slot];
      if (!face) continue;
      const r = await installFontFace({ family: f.name, slot, file: face.file, data: face.data });
      if (r === 'installed') fontsInstalled++;
      else if (r === 'failed') fontsFailed++;
    }
  }

  // Into the target project's own registry, never a global one.
  const tagsAdded = await addProjectTags(projectId, pkg.tags);

  const chapter = await createChapterFromPages({
    projectId,
    number,
    title: title ?? pkg.record.title ?? '',
    pages: packagePagesForImport(pkg),
    mode: pkg.record.mode === 'translate' ? 'translate' : 'typeset',
    // The chapter's own, absent reading as plain - never this machine's default.
    typesetting: pkg.record.typesetting ?? null,
  });
  return { chapter, fontsInstalled, fontsFailed, tagsAdded };
}
