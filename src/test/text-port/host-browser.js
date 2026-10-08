import * as store from '../../lib/store.svelte.js';
import * as measure from '../../lib/measure.js';
import * as contain from '../../lib/contain.js';
import * as exporter from '../../lib/exporter.js';
import * as solver from '../../lib/auto-layout.js';
import { probe } from './probe.js';
import { prepareFonts } from './fonts.js';

const progress = document.getElementById('progress');
const counts = { metrics: 0, layout: 0, pixels: 0, skipped: 0, errors: 0 };
const safeId = (s) => {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(s) || s.includes('..')) throw new Error(`Unsafe id: ${s}`);
  return s;
};
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
async function capture() {
  const startedAt = new Date().toISOString();
  const query = new URLSearchParams(location.search);
  const engine = query.get('engine') || 'ref-cr';
  if (!['ref-cr', 'ref-wk'].includes(engine)) throw new Error(`Invalid browser engine '${engine}'`);
  const collector = (query.get('collector') || 'http://127.0.0.1:8787').replace(/\/$/, '');
  const runId = safeId(query.get('run') || startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15));
  const selected = query.has('only') ? query.get('only').split(',') : ['metrics', 'layout', 'pixels'];
  if (!selected.length || selected.some((s) => !['metrics', 'layout', 'pixels'].includes(s))) throw new Error('only must be metrics, layout, pixels, comma separated');
  const get = async (path) => {
    const response = await fetch(`${collector}/${path}`);
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.arrayBuffer();
  };
  const put = async (path, body, append = false) => {
    const response = await fetch(`${collector}/runs/${engine}/${runId}/${path}${append ? '?append=1' : ''}`, { method: 'PUT', body });
    if (!response.ok) throw new Error(`PUT ${path}: HTTP ${response.status}: ${await response.text()}`);
  };
  const parse = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const fontBytes = await get('fonts/fonts.json');
  const list = parse(fontBytes);
  const metadata = parse(await get('meta'));
  const families = prepareFonts(store, list);
  const faces = [];
  for (const f of list.fonts) {
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(f.file)) throw new Error(`Invalid font filename: ${f.file}`);
    const bytes = await get(`fonts/${f.file}`);
    if (await sha256(bytes) !== f.sha256) throw new Error(`Font hash mismatch: ${f.family}/${f.slot}`);
    const descriptors = {};
    if (['bold', 'boldItalic'].includes(f.slot)) descriptors.weight = '700';
    if (['italic', 'boldItalic'].includes(f.slot)) descriptors.style = 'italic';
    const face = new FontFace(f.family, bytes, descriptors);
    await face.load();
    document.fonts.add(face);
    faces.push(face);
    progress.textContent = `Loaded font ${f.family}/${f.slot}`;
  }
  await document.fonts.ready;
  if (faces.some((f) => f.status !== 'loaded')) throw new Error(`Fonts not loaded: ${faces.filter((f) => f.status !== 'loaded').map((f) => f.family).join(', ')}`);
  measure.clearLayoutMemo();
  const corpus = {}, hashes = {};
  for (const kind of ['metrics', 'layout', 'pixels']) {
    const bytes = await get(`corpus/${kind}.json`);
    hashes[kind] = await sha256(bytes);
    corpus[kind] = parse(bytes).cases;
    for (const c of corpus[kind]) safeId(c.id);
  }
  await exporter.settleNoise(corpus.pixels.map((c) => c.box));
  const modules = { ...measure, ...contain, ...exporter, ...solver, fontByName: store.fontByName };
  const errors = [];
  for (const kind of ['metrics', 'layout', 'pixels'].filter((k) => selected.includes(k))) {
    await put(`${kind}.jsonl`, '');
    let batch = [];
    let deadline = performance.now() + 20;
    for (const result of probe(modules, kind, corpus[kind], { families })) {
      let record = result.record;
      if (record.png) {
        let canvas = result.canvas;
        try {
          if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.width = result.imageData.width;
            canvas.height = result.imageData.height;
            canvas.getContext('2d').putImageData(result.imageData, 0, 0);
          }
          const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Canvas PNG encoding returned null')), 'image/png'));
          await put(record.png, png);
        } catch (error) {
          // Encoding is a case error; transport failure must abort the run.
          if (error.message.startsWith('PUT ') || error instanceof TypeError) throw error;
          record = { id: record.id, error: `PNG encoding: ${error.message}` };
        } finally {
          if (canvas) { canvas.width = 0; canvas.height = 0; }
        }
      }
      counts[kind]++;
      if (record.skip) counts.skipped++;
      if (record.error) {
        counts.errors++;
        if (errors.length < 3) errors.push(`${record.id}: ${record.error}`);
      }
      batch.push(JSON.stringify(record));
      if (batch.length >= 20 || performance.now() >= deadline) {
        await put(`${kind}.jsonl`, batch.join('\n') + '\n', true);
        batch = [];
        progress.textContent = `${kind}: ${counts[kind]}/${corpus[kind].length}\n${JSON.stringify(counts)}\n${errors.join('\n')}`;
        await nextFrame();
        deadline = performance.now() + 20;
      }
    }
    if (batch.length) await put(`${kind}.jsonl`, batch.join('\n') + '\n', true);
  }
  const manifest = {
    engine, runId, commit: metadata.commit, dirty: metadata.dirty,
    host: { userAgent: navigator.userAgent, platform: navigator.platform, dpr: devicePixelRatio },
    corpus: hashes, fonts: await sha256(fontBytes), counts, startedAt, finishedAt: new Date().toISOString(),
  };
  await put('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  const ok = counts.errors === 0;
  const error = errors.length ? errors.join('\n') : null;
  progress.textContent = `${ok ? 'Finished' : 'Failed'}: ${collector}/runs/${engine}/${runId}\n${JSON.stringify(counts)}${error ? `\n${error}` : ''}`;
  window.__tp = { done: true, ok, counts, error };
  document.title = ok ? 'tp done' : 'tp failed';
}
capture().catch((error) => {
  const message = error.message ?? String(error);
  progress.textContent = `CAPTURE FAILED\n${message}\n${JSON.stringify(counts)}`;
  window.__tp = { done: true, ok: false, counts, error: message };
  document.title = 'tp failed';
});
