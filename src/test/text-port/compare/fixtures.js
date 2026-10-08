import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { alphaBbox } from './images.js';
import { saveRgba } from './io.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

export function fakeAlpha(width = 16, height = 12, kind = 'normal') {
  const alpha = new Uint8Array(width * height);
  if (kind === 'blob') {
    alpha[width + 1] = 50;
    alpha[(height - 2) * width + width - 2] = 50;
  } else {
    for (let y = 3; y < Math.min(height - 1, 8); y++) for (let x = 3; x < Math.min(width - 1, 10); x++) alpha[y * width + x] = kind === 'shift' ? 100 : 255;
  }
  return alpha;
}

async function writePixel(dir, record, alpha, width, height) {
  const rgba = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) { rgba[i * 4] = 17; rgba[i * 4 + 1] = 103; rgba[i * 4 + 3] = alpha[i]; }
  record.bbox = alphaBbox(alpha, width, height);
  record.alphaSum = alpha.reduce((sum, value) => sum + value, 0);
  await saveRgba(path.join(dir, record.png), width, height, rgba);
}

// All fixtures contain real alpha PNGs and hash their actual corpus bytes.
// Failure variants isolate one enforced gate so CLI exit codes are meaningful.
export async function makeFakeRuns(root, { pixelCount = 3, metricCount = 2, layoutCount = 2, width = 16, height = 12, variants = true } = {}) {
  await mkdir(root, { recursive: true });
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  const records = { metrics: [], layout: [], pixels: [] };
  const definitions = { metrics: [], layout: [], pixels: [] };
  const images = [];
  for (let i = 0; i < metricCount; i++) {
    const id = `m.fake.${i}`;
    definitions.metrics.push({ id, font: 'Fake Font', size: 20, text: 'AB', tags: ['synthetic', 'kern'] });
    records.metrics.push({ id, adv: 10, chars: [4, 6], font: { ascent: 15, descent: 5 }, ink: { l: 0, t: -15, r: 10, b: 5 }, glyphs: { A: { l: 0, r: 4 } } });
  }
  for (let i = 0; i < layoutCount; i++) {
    const id = `l.fake.${i}.smart`;
    definitions.layout.push({ id, mode: 'smart', box: { style: { font: 'Fake Font', size: 20 } }, tags: ['synthetic'] });
    records.layout.push({ id, lines: ['one two', 'three four'], lineX: [0, 0], blockY: 0, blockH: 40, baseY: 15, lineH: 20, curve: null, ink: { l: 0, t: 0, r: 40, b: 40 }, verdict: { fits: true } });
  }
  for (let i = 0; i < pixelCount; i++) {
    const id = `p.fake.${i}`;
    const kind = i === 1 ? 'blob' : i === 2 ? 'shift' : 'normal';
    definitions.pixels.push({ id, mode: 'smart', via: 'texture', box: { style: { font: 'Fake Font', size: kind === 'blob' ? 12 : 20 } }, tags: ['synthetic', kind] });
    records.pixels.push({ id, png: `png/${id}.png`, ox: 0, oy: 0, cw: width, ch: height, ss: 1 });
    images.push(fakeAlpha(width, height, kind));
  }
  const corpusHashes = {};
  for (const group of ['metrics', 'layout', 'pixels']) {
    const bytes = JSON.stringify({ version: 1, cases: definitions[group] });
    await writeFile(path.join(corpus, `${group}.json`), bytes);
    corpusHashes[group] = hash(bytes);
  }
  const manifest = { engine: 'ref-sk', runId: 'fake', commit: '0000000000000000000000000000000000000000', dirty: false,
    host: { userAgent: 'fake', platform: 'node', dpr: 1 }, fonts: hash('fake fonts'), corpus: corpusHashes,
    counts: { metrics: metricCount, layout: layoutCount, pixels: pixelCount, skipped: 0 }, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' };
  const before = path.join(root, 'before');
  await mkdir(path.join(before, 'png'), { recursive: true });
  for (let i = 0; i < pixelCount; i++) await writePixel(before, records.pixels[i], images[i], width, height);
  const save = async (dir, data, meta) => {
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(meta));
    for (const group of ['metrics', 'layout', 'pixels']) await writeFile(path.join(dir, `${group}.jsonl`), data[group].map(record => JSON.stringify(record)).join('\n') + '\n');
  };
  await save(before, records, manifest);
  const names = variants ? ['pass', 'advance', 'lines', 'blob', 'shift', 'missing', 'hash'] : ['pass'];
  const pairs = {};
  for (const name of names) {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, 'png'), { recursive: true });
    const data = clone(records);
    const meta = clone(manifest);
    meta.engine = 'new';
    for (const record of data.pixels) await copyFile(path.join(before, record.png), path.join(dir, record.png));
    if (name === 'advance') data.metrics[0].adv += 0.5;
    if (name === 'lines') data.layout[0].lines = ['one', 'two three four'];
    if (name === 'blob') {
      const alpha = images[1].slice();
      for (let y = 3; y < 8; y++) for (let x = 4; x < 9; x++) alpha[y * width + x] = 255;
      await writePixel(dir, data.pixels[1], alpha, width, height);
    }
    if (name === 'shift') data.pixels[2].ox = -3;
    if (name === 'missing') { data.metrics.pop(); meta.counts.metrics--; }
    if (name === 'hash') meta.corpus.metrics = hash('different corpus');
    await save(dir, data, meta);
    pairs[name] = dir;
  }
  return { before, corpus, pairs };
}
