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
import { app, normalizeLayout, normalizeOcrLanguage, fontsGated, fontFamiliesSettling, fontMissing, fontSourceNow } from './store.svelte.js';
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

// The families a chapter names that go into its package with no font file,
// and why each has none, as [{ name, why }]:
//
//   'system'   installed on this machine. Its file is the system's, or
//              another vendor's, and is not ours to copy: the other machine
//              draws the chapter in it only if it has the same font installed.
//   'missing'  no file anywhere on this machine either - a font the chapter
//              came with a name for and nothing else, a built-in included
//              (the Rust engine has no bytes for one).
//
// `fonts` is what goes in the manifest (`{ name, faces }`), `named` every
// family the chapter uses - the manifest leaves the built-ins out.
//
// Said only with the Rust engine switched on (`fontsGated`), where a family
// without bytes is a family that is drawn in a stand-in. With the switch off
// the list is empty and the export says what it always said.
//
// Which of the two is THE FONT GATE's answer (`fontMissing`), not a list's: a
// family the system scan lists whose file cannot be read is in the list and
// is drawn in a stand-in all the same. Whoever calls this has waited for the
// gate to know (`familiesKnown`).
export function fontsStaying(fonts, named = fonts.map((f) => f.name)) {
  if (!fontsGated()) return [];
  const carried = new Set(fonts.filter((f) => Object.values(f.faces ?? {}).some(Boolean)).map((f) => f.name));
  return named.filter((name) => !carried.has(name)).map((name) => ({ name, why: drawnAsItself(name) && !inLibrary(name) ? 'system' : 'missing' }));
}

// With the Rust engine switched on: whether the engine draws `name` in a face
// of that family - the gate's word, which is the editor's "font missing"
// notice said the other way round.
const drawnAsItself = (name) => fontSourceNow()?.ready?.(name) !== false && !fontMissing(name);
const inLibrary = (name) => app.fonts.user.some((f) => f.name === name);

// A lasting answer belongs to the source that settled it. A replacement is
// waited for too; a failed or still-pending wait cannot describe drawable fonts.
// Read the statuses synchronously here before returning across another await.
async function familiesKnown(names, known) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const held = fontSourceNow();
    if (!held?.settle) return known();
    try {
      await fontFamiliesSettling(names);
    } catch (e) {
      if (fontSourceNow() !== held) continue;
      throw new Error(`Could not inspect package fonts: ${e?.message || e}`);
    }
    if (fontSourceNow() !== held) continue;
    if (names.some((name) => held.ready?.(name) === false)) {
      throw new Error('Could not inspect package fonts: some fonts are still loading. Try again.');
    }
    return known();
  }
  throw new Error('Could not inspect package fonts: the font source kept changing. Try again.');
}

// One sentence for those families, for whoever tells the user; '' for none.
export function stayingNote(staying) {
  if (!staying?.length) return '';
  const names = (why) => staying.filter((f) => f.why === why).map((f) => f.name);
  const parts = [];
  if (names('system').length) parts.push(`${names('system').join(', ')} (installed here; a system font's file is not copied)`);
  if (names('missing').length) parts.push(`${names('missing').join(', ')} (no file on this computer)`);
  return `Fonts not in the package: ${parts.join('; ')}`;
}

// Build the package for a closed chapter and save it through the OS dialog.
// Resolves to `{ path, staying }` - the path written and the families that
// went without a font file (`fontsStaying`) - or null when the user
// cancelled. Throws when the chapter cannot be read or the write fails.
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
  const named = fontFamiliesUsed(pages, tagEntries);
  const families = named.filter(
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
  const staying = fontsGated()
    ? await familiesKnown(named, () => fontsStaying(fonts, named))
    : fontsStaying(fonts, named);

  if (!isTauri()) {
    downloadBytes(bytes, name);
    return { path: name, staying };
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
  return { path, staying };
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
//
// With the Rust engine switched on (`fontsGated`) that is not the whole of
// it, and two of the answers are wrong: a built-in is NOT "nothing to do" -
// the engine has no bytes for one, so it is a missing font like any other -
// and a font installed on this machine is not missing at all. There:
//
//   'install'  as above
//   'present'  in the user's library (every shipped face, or the family when
//              none was shipped)
//   'system'   not in the package and not in the library, and installed on
//              this machine: drawn in the installed font
//   'missing'  none of those: drawn in the last-resort face, and listed as
//              a missing font in the editor
export function fontStatus(f) {
  if (fontsGated()) return engineFontStatus(f);
  if (app.fonts.builtin.some((b) => b.name === f.name)) return 'builtin';
  const local = app.fonts.user.find((u) => u.name === f.name)?.faces ?? null;
  if (!f.shipped) return local ? 'present' : 'missing';
  const slots = Object.keys(f.faces).filter((s) => f.faces[s]);
  return slots.every((s) => local?.[s]) ? 'present' : 'install';
}

//
// Present, system and missing are THE FONT GATE's answer for the family
// (`fontMissing`), not a list's: a family is in the library's list with a
// file the engine cannot read (a WOFF2 and nothing to decode it), and in the
// system scan's with a file that cannot be read, and either is drawn in the
// last-resort face. Only "to install" is read off the lists, because it is a
// statement about them: a shipped face the library has no slot for is one
// the import will put in.
function engineFontStatus(f) {
  const local = app.fonts.user.find((u) => u.name === f.name)?.faces ?? null;
  // A font shipped under a built-in's name is refused by `installFontFace`
  // while there are built-ins, so it is not "to install": what happens to it
  // is what the machine has for that name. With the list empty - cut-over -
  // this is never true and such a font installs like any other.
  const refused = app.fonts.builtin.some((b) => b.name === f.name);
  if (f.shipped && !refused) {
    const slots = Object.keys(f.faces).filter((s) => f.faces[s]);
    // A slot the library already has is left as it is by the import
    // (`installFontFace`), readable or not: with every shipped face there,
    // what the family will be is what it is now.
    if (!slots.every((s) => local?.[s])) return 'install';
  }
  if (!drawnAsItself(f.name)) return 'missing';
  return local ? 'present' : 'system';
}

// The fonts a package's chapter depends on, each with what it means here:
// the manifest's list, and - with the Rust engine switched on - the families
// the chapter names that the manifest leaves out. The exporting machine left
// its built-ins out ("the other machine has it too"), and to the engine a
// built-in is a font with no bytes: a chapter set in one would otherwise
// import without a word and open with every box marked "font missing".
//
// Synchronous, in both modes: with the switch off this is the list it always
// was, there when the call returns. With it on, the answer is what the gate
// says AT THIS MOMENT, and a family nothing has asked about yet is only on
// its way - so whoever wants the lasting answer awaits `packageFontsKnown`
// first, as `inspectPackage` does.
export function packageFontStatuses(pkg) {
  const out = pkg.fonts.map((f) => ({ name: f.name, status: fontStatus(f) }));
  if (!fontsGated()) return out;
  const listed = new Set(pkg.fonts.map((f) => f.name));
  for (const name of fontFamiliesUsed(pkg.record?.pages ?? [], pkg.tags ?? [])) {
    if (!listed.has(name)) out.push({ name, status: engineFontStatus({ name, faces: {}, shipped: false }) });
  }
  return out;
}

// With the Rust engine switched on: resolves when the gate knows every
// family `packageFontStatuses` will be asked about (`familiesKnown`). Only
// ever called with the switch on; with it off there is nothing to wait for
// and nothing may be awaited (see `inspectPackage`).
function packageFontsKnown(pkg) {
  return familiesKnown([...new Set([...pkg.fonts.map((f) => f.name), ...fontFamiliesUsed(pkg.record?.pages ?? [], pkg.tags ?? [])])], () => packageFontStatuses(pkg));
}

// Parse a picked file and describe it for the dialog. Throws the reader's
// message for anything that is not a package.
// `projectId` is the project the package would land in; a tag is 'known' when
// that project's registry already has it, since registries are per project.
export async function inspectPackage(file, projectId = null) {
  const pkg = readChapterPackage(new Uint8Array(await file.arrayBuffer()));
  const { manifest, record } = pkg;
  // Behind the switch, and not an `await` of something already settled: with
  // the browser measuring this function awaits the file and nothing else,
  // as it did before there was a gate.
  const fonts = fontsGated() ? await packageFontsKnown(pkg) : packageFontStatuses(pkg);
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
      fonts,
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
