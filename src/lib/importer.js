// Source material coming in from outside the library: the native file picker,
// and the tolerant normalisation of a translations JSON.
//
// Nothing here touches the open document - it does not import the store at all.
// Imports belong to the home screen: a chapter's pages come from the library,
// and the editor is for typesetting. `tags.svelte.js` is the one exception and
// is not one in substance: it is the tag *model*, it imports nothing itself, and
// only its pure line functions are used here.

import { setLineTags } from './tags.svelte.js';

const TYPES = ['dialogue', 'sfx', 'narration'];

function parseLineNumber(val) {
  if (val == null || typeof val === 'boolean') return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

// Normalize one line object/string → { n, jp, en, type } - plus `tags` on the
// one input that actually carries them.
// Back-compat: a bare string or a `{ text }`-only object becomes `en`; legacy
// `natural`/`stylised` collapse to a single `en` (natural preferred).
// jp defaults to '', type to 'dialogue'.
//
// Line numbers: when a page uses 0-based indexing (e.g. n: 0), all explicit line
// numbers on that page are shifted by +1 so that n:0 becomes 1, n:1 becomes 2, etc.,
// preserving 1-based uniqueness throughout the document without collisions.
// Missing or unparseable line numbers fall back to `idx + 1`.
//
// `tags` is passed through only when the file really has an array there, and the
// distinction matters: `tags` absent means "nobody has said", which is what lets
// `lineTags` read the line's legacy `type` instead, and what lets a re-import
// carry the tags the user applied by hand over the file's silence. An array
// materialised here out of nothing - `[]` for every line - would look like the
// user having deliberately cleared every tag in the chapter, and a re-import
// would then wipe them all. See `carryTagsForward`.
function normLine(item, idx, shift = 0) {
  if (typeof item === 'string') {
    return { n: idx + 1, jp: '', en: item, type: 'dialogue' };
  }
  if (!item || typeof item !== 'object') {
    return { n: idx + 1, jp: '', en: '', type: 'dialogue' };
  }
  const rawN = parseLineNumber(item.n ?? item.id ?? item.number ?? item.index);
  const legacy = item.text ?? item.content ?? item.tl ?? item.translation ?? item.t;
  const en = item.en ?? item.natural ?? item.stylised ?? item.stylized ?? legacy ?? '';
  const jp = item.jp ?? item.japanese ?? item.original ?? item.raw ?? item.ko ?? item.korean ?? item.kr ?? '';
  const type = item.type ?? item.kind ?? 'dialogue';
  const out = {
    n: rawN !== null ? rawN + shift : idx + 1,
    jp: String(jp),
    en: String(en),
    type: TYPES.includes(type) ? type : 'dialogue',
  };
  // Vetted rather than trusted - this is the one place an arbitrary file reaches
  // the document - and vetted by the document's own function rather than a fold
  // spelled a second time here, which is also what makes `type` follow the tags:
  // a file carrying both, disagreeing, would otherwise land a line whose badge
  // and whose export said different things about it.
  if (Array.isArray(item.tags)) setLineTags(out, item.tags);
  return out;
}

function isPageObject(obj) {
  return (
    obj != null &&
    typeof obj === 'object' &&
    (obj.texts != null ||
      obj.lines != null ||
      obj.text_lines != null ||
      obj.items != null ||
      obj.translations != null ||
      obj.page != null)
  );
}

// Normalize one page object → { lines: [...] }
function normPage(obj) {
  const arr = obj.texts ?? obj.lines ?? obj.text_lines ?? obj.items ?? obj.translations ?? [];
  const rawList = Array.isArray(arr) ? arr.filter((item) => item != null) : [];
  // Detect 0-based indexing: if any line on this page explicitly specifies line 0
  // (via n, id, number, or index), shift all explicit numbers by +1 so 0-based
  // translations become 1-based without collapsing 0 into 1 and causing duplicates.
  const hasZero = rawList.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const rawVal = item.n ?? item.id ?? item.number ?? item.index;
    return parseLineNumber(rawVal) === 0;
  });
  const shift = hasZero ? 1 : 0;
  const lines = rawList
    .map((item, idx) => normLine(item, idx, shift))
    .sort((a, b) => a.n - b.n);
  return { lines };
}

// Accept: [pages], {pages:[...]}, single {page,texts}, or bare [lines]/{texts}
export function normalizeTranslations(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('unrecognized translations JSON');
  }

  let rawPages;
  if (Array.isArray(data)) {
    // could be array of pages or array of lines
    if (data.some(isPageObject)) rawPages = data;
    else rawPages = [{ texts: data }];
  } else if ('pages' in data) {
    if (!Array.isArray(data.pages)) {
      throw new Error('unrecognized translations JSON');
    }
    rawPages = data.pages;
  } else if (isPageObject(data)) {
    rawPages = [data];
  } else {
    rawPages = [{ texts: [] }];
  }
  return rawPages.filter((p) => p != null && typeof p === 'object').map(normPage);
}

// A picked .json → one entry per page it describes. Throws on unparseable
// input so the caller can say so where the file was chosen, rather than
// leaving the user with a picker that appears to have done nothing.
export async function readTranslations(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    throw new Error(`Invalid JSON - could not parse ${file.name}`);
  }
  return normalizeTranslations(data);
}

// Tauri injects __TAURI_INTERNALS__; absent in the browser (same check as sidecar.js).
export function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  json: 'application/json',
};

function basename(path) {
  return String(path).split('/').pop().split('\\').pop();
}

function mimeFromExt(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Native file dialog (Tauri): open() → absolute paths → readFile → File objects,
// so the shared import pipeline (which works on File/Blob) stays unchanged.
// Dynamic imports keep the Tauri plugins out of the browser bundle path.
export async function pickFilesTauri({ name, extensions, multiple }) {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ multiple, filters: [{ name, extensions }] });
  if (!selected) return null; // cancelled
  const paths = Array.isArray(selected) ? selected : [selected];
  if (!paths.length) return null;
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const files = [];
  const unreadable = [];
  for (const path of paths) {
    const fname = basename(path);
    try {
      const bytes = await readFile(path);
      files.push(new File([bytes], fname, { type: mimeFromExt(fname) }));
    } catch (e) {
      unreadable.push(`${fname} (${e?.message || e})`);
    }
  }
  // Everything downstream of this pairs the list with pages BY POSITION. A list
  // that quietly skipped file 5 of 20 is not 19 good files - it is 15 pages
  // about to be given the wrong image, under a summary that reports the loss as
  // one missing page at the end. So a partial read is a failure, not a result.
  if (unreadable.length) {
    throw new Error(`Could not read ${unreadable.length} of ${paths.length}: ${unreadable.join(', ')}`);
  }
  return files.length ? files : null;
}

// The image extensions every picker in the app offers.
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'];

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Sniffed, not read off the name: a `.png` the user renamed from a WebP is a
// WebP to every decoder that matters, and the picker's extension has never been
// evidence of what a file actually is.
export async function isPng(file) {
  try {
    const head = new Uint8Array(await file.slice(0, PNG_MAGIC.length).arrayBuffer());
    return PNG_MAGIC.every((b, i) => head[i] === b);
  } catch {
    return false;
  }
}

export function pngName(name) {
  const s = String(name);
  const dot = s.lastIndexOf('.');
  return `${dot > 0 ? s.slice(0, dot) : s}.png`;
}

// Every page picked from outside becomes a PNG on the way in.
//
// Two decoders read a page in this app and they do not agree on what a page may
// be. The webview decodes it to draw, measure and export; the detection engine
// decodes it in Rust (`image::load_from_memory`). A WebP chapter therefore
// imported, drew and measured perfectly and then failed detection on every
// page - the engine reads a shorter list of formats than the webview does.
//
// Normalising here rather than teaching each consumer a longer format list: the
// picker is the one door a page comes in through, the webview's decoder is
// already the one whose answer the rest of the app trusts (see `imageSize` in
// library.svelte.js), and PNG is lossless - the stored page is exactly the
// pixels the canvas would have drawn from the original.
//
// A file that is already PNG passes through untouched, so bit depth, colour
// type and ICC profile survive a plain PNG import bit for bit. So does a file
// this webview cannot decode (TIFF, in every current engine): the import keeps
// the original bytes rather than failing, because the engine's own decoder
// still covers those and a page kept beats a picker that appears to have done
// nothing.
export async function toPng(file) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  if (await isPng(file)) return file;
  let bitmap = null;
  let canvas = null;
  try {
    bitmap = await createImageBitmap(file);
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return file;
    return new File([await blob.arrayBuffer()], pngName(file.name), { type: 'image/png' });
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
    // A page is tens of megabytes of RGBA backing store. An import loop that
    // left one canvas per page for the collector would hold the whole chapter.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

// One page at a time: a chapter is hundreds of them, and converting the batch
// in parallel would hold every decoded bitmap at once.
export async function pickImageFiles(multiple = true) {
  const picked = await pickFilesTauri({ name: 'Images', extensions: IMAGE_EXTENSIONS, multiple });
  if (!picked) return null;
  const out = [];
  for (const f of picked) out.push(await toPng(f));
  return out;
}

export function pickJsonFile() {
  return pickFilesTauri({ name: 'JSON', extensions: ['json'], multiple: false });
}
