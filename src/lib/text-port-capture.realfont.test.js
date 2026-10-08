import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { probe } from '../test/text-port/probe.js';
import { prepareFonts } from '../test/text-port/fonts.js';
import { dataDir, guardedPath, safeId, sha256, runIdNow, gitInfo, root } from '../../scripts/text-port/lib/common.mjs';

// `new` runs the app on the Rust engine. The wasm is a build product, so a
// capture that cannot find it stops here instead of measuring with Skia under
// the wrong name.
function readEngineWasm() {
  const path = `${root}text-engine/js/generated/mt_text.wasm`;
  if (!existsSync(path)) throw new Error(`text-port capture: ${path} is missing; run npm run build:engine`);
  return readFileSync(path);
}
// Asked of the engine itself: the canvas-only document of this lane has no
// line layout, and an engine with a breaker of its own does not need one.
function canBreakPlain(engine, face) {
  try {
    return Array.isArray(engine?.wrapPlain?.(face, 'a b', { width: 1000, lineHeight: 1.2, letterSpacing: 0, align: 'left' }));
  } catch {
    return false;
  }
}

if (process.env.TP_CAPTURE !== '1') {
  it.skip('text-port capture disabled; set TP_CAPTURE=1 via scripts/text-port/capture-node.mjs', () => {});
} else {
  it('captures every frozen corpus case', async () => {
    const startedAt = new Date().toISOString();
    const data = dataDir();
    const engine = safeId(process.env.TP_ENGINE || 'ref-sk');
    const runId = safeId(process.env.TP_RUN_ID || runIdNow());
    const dir = guardedPath(data, `runs/${engine}/${runId}`);
    if (existsSync(dir)) throw new Error(`Run already exists: ${dir}`);
    if (!['ref-sk', 'new'].includes(engine)) throw new Error(`The node host captures ref-sk or new, not '${engine}'`);
    const wasm = engine === 'new' ? readEngineWasm() : null;
    const rust = wasm ? await (await import('./text-engine/rust.js')).createRustTextEngine(wasm) : null;
    const fontBytes = readFileSync(guardedPath(data, 'fonts/fonts.json'));
    const list = JSON.parse(fontBytes);
    for (const f of list.fonts) {
      const path = guardedPath(data, `fonts/${f.file}`);
      const bytes = readFileSync(path);
      if (sha256(bytes) !== f.sha256) throw new Error(`Font hash mismatch: ${f.family}/${f.slot}`);
      // Skia keeps the faces in both modes: the exporter still paints with it.
      if (!GlobalFonts.registerFromPath(path, f.family)) throw new Error(`Cannot register font ${path} as '${f.family}'`);
      rust?.addFace(f.family, f.slot, bytes);
    }
    // Import after registration: measure.js owns a canvas and caches advances.
    const store = await import('./store.svelte.js');
    const measure = await import('./measure.js');
    // measure.js installs the browser engine as it loads; the Rust engine
    // replaces it here, before anything has been measured.
    const seam = await import('./text-engine/index.js');
    if (rust) seam.setTextEngine(rust);
    if (seam.textEngine()?.id !== (rust ? 'rust' : 'browser')) throw new Error(`Wrong measuring engine installed: ${seam.textEngine()?.id}`);
    const contain = await import('./contain.js');
    const exporter = await import('./exporter.js');
    const solver = await import('./auto-layout.js');
    const families = prepareFonts(store, list);
    const plain = canBreakPlain(seam.textEngine(), measure.faceFor({ font: families[0], bold: false, italic: false }, 16));
    const modules = { ...measure, ...contain, ...exporter, ...solver, fontByName: store.fontByName };
    measure.clearLayoutMemo();
    const corpus = {};
    const hashes = {};
    for (const name of ['metrics', 'layout', 'pixels']) {
      const bytes = readFileSync(guardedPath(data, `corpus/${name}.json`));
      hashes[name] = sha256(bytes);
      corpus[name] = JSON.parse(bytes).cases;
      for (const c of corpus[name]) safeId(c.id);
    }
    await exporter.settleNoise(corpus.pixels.map((c) => c.box));
    mkdirSync(guardedPath(dir, 'png'), { recursive: true });
    const counts = { metrics: 0, layout: 0, pixels: 0, skipped: 0, errors: 0 };
    const errors = [];
    for (const name of ['metrics', 'layout', 'pixels']) {
      const file = guardedPath(dir, `${name}.jsonl`);
      writeFileSync(file, '');
      for (const result of probe(modules, name, corpus[name], { families, plain })) {
        const record = result.record;
        try {
          if (record.png) {
            let canvas = result.canvas;
            if (!canvas) {
              canvas = createCanvas(result.imageData.width, result.imageData.height);
              canvas.getContext('2d').putImageData(result.imageData, 0, 0);
            }
            writeFileSync(guardedPath(dir, record.png), canvas.toBuffer('image/png'));
            canvas.width = 0;
            canvas.height = 0;
          }
        } catch (error) {
          result.record = { id: record.id, error: `PNG encoding: ${error.message}` };
        }
        const r = result.record;
        counts[name]++;
        if (r.skip) counts.skipped++;
        if (r.error) {
          counts.errors++;
          if (errors.length < 3) errors.push(`${r.id}: ${r.error}`);
        }
        writeFileSync(file, JSON.stringify(r) + '\n', { flag: 'a' });
      }
    }
    const manifest = {
      engine, runId, ...gitInfo(), host: { userAgent: `node ${process.version}; @napi-rs/canvas${wasm ? `; mt-text wasm ${sha256(wasm)}` : ''}`, platform: process.platform, dpr: 1 },
      corpus: hashes, fonts: sha256(fontBytes), counts, startedAt, finishedAt: new Date().toISOString(),
    };
    writeFileSync(guardedPath(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`text-port run: ${dir}\ncounts: ${JSON.stringify(counts)}`);
    if (errors.length) console.error(`first errors:\n${errors.join('\n')}`);
    expect(counts.errors, errors.join('\n')).toBe(0);
  }, 300000);
}
