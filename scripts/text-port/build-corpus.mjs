#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { buildCorpus, completeStyle } from '../../src/test/text-port/corpus.js';
import { normalizeFit } from '../../src/lib/data.js';
import { flags, root, sha256, dataDir, guardedPath, safeId } from './lib/common.mjs';
import { coverage, covers } from './lib/cmap.mjs';

const fixtures = [
  { family: 'Comic Neue', slot: 'regular', path: 'src/test/fonts/ComicNeue-Regular.ttf' },
  { family: 'Bangers', slot: 'regular', path: 'src/test/fonts/Bangers-Regular.ttf' },
  { family: 'DejaVu Sans', slot: 'regular', path: 'src/test/fonts/DejaVuSans.ttf' },
  { family: 'DejaVu Sans', slot: 'italic', path: 'src/test/fonts/DejaVuSans-Oblique.ttf' },
];
function writeJSON(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function chapterCases(data, list, corpus, legacyMode) {
  const dir = guardedPath(data, 'chapters');
  const omitted = new Map();
  let empty = 0;
  if (!existsSync(dir)) return { omitted, empty };
  const families = new Set(list.fonts.map((f) => f.family));
  const metrics = new Set(corpus.metrics.cases.map((c) => JSON.stringify([c.font, c.bold, c.italic, c.size, c.text])));
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const chapter = JSON.parse(readFileSync(guardedPath(dir, name), 'utf8'));
    // Chapter ids are retained when filename-safe; fail rather than collide
    // after lossy sanitisation of a file stem, page id, or box id.
    const stem = safeId(basename(name, '.json').toLowerCase());
    // A chapter saved before the mode existed has none of its own: the app
    // resolves it from the machine's prefs, which the harness cannot see, so
    // the caller must say which one, and the corpus must not guess.
    const mode = chapter.typesetting?.mode ?? legacyMode;
    if (!mode) throw new Error(`${name}: chapter has no typesetting.mode; pass --legacy-mode smart|plain`);
    if (!['smart', 'plain'].includes(mode)) throw new Error(`${name}: invalid typesetting mode '${mode}'`);
    (chapter.pages ?? []).forEach((p, pi) => (p.boxes ?? []).forEach((b, bi) => {
      const font = b.style?.font;
      if (!families.has(font)) {
        omitted.set(String(font), (omitted.get(String(font)) ?? 0) + 1);
        return;
      }
      // `boxText` in store.svelte.js: a box placed from the queue carries
      // `text: null` and shows its line's English, so most of a chapter's
      // text is on the page's lines and not on its boxes.
      const line = (p.lines ?? []).find((l) => l.n === b.lineN);
      const text = String(b.text ?? line?.en ?? line?.natural ?? line?.stylised ?? line?.text ?? '');
      // A box nobody has typed in draws nothing, under any engine.
      if (!text.trim()) {
        empty++;
        return;
      }
      const id = `c.${stem}.p${safeId(String(p.id ?? pi).toLowerCase())}.b${safeId(String(b.id ?? bi).toLowerCase())}`;
      const raw = { ...b.style };
      const stripped = 'ink' in raw || 'warp' in raw;
      delete raw.ink;
      delete raw.warp;
      // The brief explicitly removes these two groups from chapter cases;
      // every other field still comes from the complete default schema.
      const style = completeStyle(raw);
      delete style.ink;
      delete style.warp;
      const c = { id, mode, page: { w: p.w, h: p.h }, box: { ...b, text, style, fit: normalizeFit(b.fit) }, tags: stripped ? ['chapter', 'stripped'] : ['chapter'] };
      corpus.layout.cases.push(c);
      // Every real box is painted: these are the pictures a before and after
      // of the port is judged on.
      corpus.pixels.cases.push({ ...c, via: 'texture' });
      for (const [li, text] of c.box.text.split(/\r?\n/).entries()) {
        const key = JSON.stringify([font, style.bold, style.italic, style.size, text]);
        if (metrics.has(key)) continue;
        metrics.add(key);
        corpus.metrics.cases.push({ id: `${id}.m${li}`, font, bold: style.bold, italic: style.italic, size: style.size, text, style, tags: c.tags });
      }
    }));
  }
  return { omitted, empty };
}
// Tag every case whose text has a letter its face has no glyph for. Such a
// string is drawn from a fallback face the host picks, so it measures the host
// and not the engine; the comparison judges those cases apart.
function tagUncovered(corpus, faces) {
  // The face CSS matching picks for a style: the slant first, then the weight.
  const rangesFor = (family, bold, italic) => {
    const f = faces.get(family);
    const wanted = italic && (f.italic || f.boldItalic) ? [f.italic, f.boldItalic] : [f.regular, f.bold];
    const [light, heavy] = wanted[0] || wanted[1] ? wanted : [f.italic, f.boldItalic];
    return bold ? heavy ?? light : light ?? heavy;
  };
  let count = 0;
  for (const value of Object.values(corpus)) {
    for (const c of value.cases) {
      const style = c.box?.style ?? c.solve?.style ?? c;
      const raw = String(c.text ?? c.box?.text ?? c.solve?.text ?? '');
      const text = style.uppercase ? raw.toUpperCase() : raw;
      const ranges = rangesFor(style.font, !!style.bold, !!style.italic);
      // A tab is set as a space, and a line break is not set at all.
      const missing = [...text.replace(/\t/g, ' ').replace(/[\r\n]/g, '')].some((ch) => !covers(ranges, ch.codePointAt(0)));
      if (!missing) continue;
      c.tags = [...(c.tags ?? []), 'uncovered'];
      count++;
    }
  }
  return count;
}
try {
  const args = flags(['--data', '--fonts', '--legacy-mode']);
  const data = dataDir(args.data);
  mkdirSync(guardedPath(data, 'fonts'), { recursive: true });
  mkdirSync(guardedPath(data, 'corpus'), { recursive: true });
  const extra = args.fonts ? JSON.parse(readFileSync(resolve(args.fonts), 'utf8')) : [];
  if (!Array.isArray(extra)) throw new Error('--fonts must contain an array of { family, slot, path }');
  const seen = new Set();
  const faces = new Map();
  const fonts = [...fixtures, ...extra].map((f) => {
    if (!f.family || /['\\\r\n]/.test(f.family) || !['regular', 'bold', 'italic', 'boldItalic'].includes(f.slot)) throw new Error(`Invalid font entry: ${JSON.stringify(f)}`);
    const key = JSON.stringify([f.family, f.slot]);
    if (seen.has(key)) throw new Error(`Duplicate font face: ${f.family}/${f.slot}`);
    seen.add(key);
    const source = f.path;
    const bytes = readFileSync(resolve(root, source));
    const hash = sha256(bytes);
    const ext = extname(source).slice(1).toLowerCase();
    if (!/^[a-z0-9]+$/.test(ext)) throw new Error(`Invalid font extension: ${source}`);
    const file = `${hash}.${ext}`;
    writeFileSync(guardedPath(data, `fonts/${file}`), bytes);
    if (!faces.has(f.family)) faces.set(f.family, {});
    faces.get(f.family)[f.slot] = coverage(bytes).ranges;
    return { family: f.family, slot: f.slot, file, sha256: hash, source };
  }).sort((a, b) => a.family < b.family ? -1 : a.family > b.family ? 1 : a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0);
  const list = { version: 1, fonts };
  const corpus = buildCorpus(list);
  const { omitted, empty } = chapterCases(data, list, corpus, args['legacy-mode']);
  const uncovered = tagUncovered(corpus, faces);
  for (const [name, value] of Object.entries(corpus)) {
    const ids = new Set();
    for (const c of value.cases) {
      safeId(c.id);
      if (ids.has(c.id)) throw new Error(`Duplicate ${name} id: ${c.id}`);
      ids.add(c.id);
    }
    // One line: a corpus over a real font library is tens of megabytes, and
    // every host parses all of it.
    writeFileSync(guardedPath(data, `corpus/${name}.json`), JSON.stringify(value) + '\n');
  }
  writeJSON(guardedPath(data, 'fonts/fonts.json'), list);
  console.log(`corpus: ${Object.entries(corpus).map(([k, v]) => `${k}=${v.cases.length}`).join(' ')} fonts=${fonts.length}`);
  for (const [font, count] of [...omitted].sort()) console.log(`omitted unknown font '${font}': ${count} boxes`);
  if (empty) console.log(`omitted empty chapter boxes: ${empty}`);
  console.log(`cases with a letter their face lacks: ${uncovered}`);
  console.log(`data: ${data}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
