import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { probe } from '../test/text-port/probe.js';
import { prepareFonts } from '../test/text-port/fonts.js';
import { dataDir, guardedPath, safeId, sha256, runIdNow, gitInfo } from '../../scripts/text-port/lib/common.mjs';

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
    const fontBytes = readFileSync(guardedPath(data, 'fonts/fonts.json'));
    const list = JSON.parse(fontBytes);
    for (const f of list.fonts) {
      const path = guardedPath(data, `fonts/${f.file}`);
      if (sha256(readFileSync(path)) !== f.sha256) throw new Error(`Font hash mismatch: ${f.family}/${f.slot}`);
      if (!GlobalFonts.registerFromPath(path, f.family)) throw new Error(`Cannot register font ${path} as '${f.family}'`);
    }
    // Import after registration: measure.js owns a canvas and caches advances.
    const store = await import('./store.svelte.js');
    const measure = await import('./measure.js');
    const contain = await import('./contain.js');
    const exporter = await import('./exporter.js');
    const solver = await import('./auto-layout.js');
    const families = prepareFonts(store, list);
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
      for (const result of probe(modules, name, corpus[name], { families, browser: false })) {
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
      engine, runId, ...gitInfo(), host: { userAgent: `node ${process.version}; @napi-rs/canvas`, platform: process.platform, dpr: 1 },
      corpus: hashes, fonts: sha256(fontBytes), counts, startedAt, finishedAt: new Date().toISOString(),
    };
    writeFileSync(guardedPath(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`text-port run: ${dir}\ncounts: ${JSON.stringify(counts)}`);
    if (errors.length) console.error(`first errors:\n${errors.join('\n')}`);
    expect(counts.errors, errors.join('\n')).toBe(0);
  }, 300000);
}
