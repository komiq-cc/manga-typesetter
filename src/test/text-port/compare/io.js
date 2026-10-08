import { readFile, realpath, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { groups, caseMetadata, joinCase } from './records.js';
import { alphaBbox, alignImages, heatMap } from './images.js';
import { createInterface } from 'node:readline';
import { equal, json } from './stats.js';

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

export async function readRun(directory, { stream = false } = {}) {
  const dir = await realpath(directory);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  if (!manifest || typeof manifest.engine !== 'string' || typeof manifest.commit !== 'string' || !manifest.host || typeof manifest.fonts !== 'string'
    || groups.some(group => typeof manifest.corpus?.[group] !== 'string')) throw new Error(`${dir}: incomplete manifest`);
  const run = { dir, manifest, streamed: stream };
  if (stream) return run;
  for (const group of groups) {
    run[group] = new Map();
    for await (const record of readRecords(run, group)) run[group].set(record.id, record);
  }
  validateRunCounts(run);
  return run;
}

export async function* readRecords(run, group) {
  const file = path.join(run.dir, `${group}.jsonl`);
  const input = createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const ids = new Set();
  let lineNumber = 0;
  let skipped = 0;
  let errors = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`${file}:${lineNumber}: invalid JSON`);
      }
      if (!record || typeof record.id !== 'string' || !/^[a-z0-9._-]+$/.test(record.id)) {
        throw new Error(`${file}:${lineNumber}: invalid case id`);
      }
      if (ids.has(record.id)) throw new Error(`${file}:${lineNumber}: duplicate id ${record.id}`);
      ids.add(record.id);
      skipped += Number(record.skip !== undefined);
      errors += Number(record.error !== undefined);
      yield record;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (run.manifest.counts?.[group] !== ids.size) {
    throw new Error(`${run.dir}: manifest counts.${group} does not match JSONL record count`);
  }
  run.recordCounts ??= {};
  run.recordCounts[group] = { skipped, errors };
}

export function validateRunCounts(run) {
  for (const kind of ['skipped', 'errors']) {
    const count = groups.reduce((sum, group) => sum + run.recordCounts[group][kind], 0);
    if (run.manifest.counts[kind] !== count) {
      throw new Error(`${run.dir}: manifest counts.${kind} does not match ${kind === 'skipped' ? 'skip' : 'error'} records`);
    }
  }
}

// Record order is not part of the capture contract. Index one group's first
// run, then consume the second as a stream and release matched records.
export async function* joinedBatches(before, after, corpus, group, batchSize = 500) {
  const indexed = before.streamed ? new Map() : new Map(before[group]);
  if (before.streamed) {
    for await (const record of readRecords(before, group)) indexed.set(record.id, record);
  }
  const pending = new Set(corpus[group]?.keys() ?? []);
  let batch = [];
  const records = after.streamed ? readRecords(after, group) : after[group].values();
  for await (const record of records) {
    batch.push(joinCase(group, record.id, indexed.get(record.id), record, corpus[group]));
    indexed.delete(record.id);
    pending.delete(record.id);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  for (const [id, record] of indexed) {
    batch.push(joinCase(group, id, record, undefined, corpus[group]));
    pending.delete(id);
    indexed.delete(id);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  for (const id of pending) {
    batch.push(joinCase(group, id, undefined, undefined, corpus[group]));
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export async function readCorpus(directory) {
  if (!directory) return {};
  const corpus = {};
  corpus.hashes = {};
  for (const group of groups) {
    const file = path.join(directory, `${group}.json`);
    const bytes = await readFile(file);
    const data = JSON.parse(bytes);
    if (data.version !== 1 || !Array.isArray(data.cases)) throw new Error(`${file}: expected corpus version 1 and cases array`);
    corpus[group] = new Map();
    for (const item of data.cases) {
      if (!item || typeof item.id !== 'string' || !/^[a-z0-9._-]+$/.test(item.id)) throw new Error(`${file}: invalid case id`);
      if (corpus[group].has(item.id)) throw new Error(`${file}: duplicate id ${item.id}`);
      if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string'))) throw new Error(`${file}: invalid tags ${item.id}`);
      corpus[group].set(item.id, caseMetadata(item.id, new Map([[item.id, item]])));
    }
    corpus.hashes[group] = createHash('sha256').update(bytes).digest('hex');
  }
  return corpus;
}

export async function loadAlpha(run, record) {
  if (typeof record.png !== 'string') throw new Error(`${record.id}: missing PNG path`);
  const file = await realpath(path.resolve(run.dir, record.png));
  if (!file.startsWith(`${run.dir}${path.sep}`)) throw new Error(`${record.id}: PNG path outside run`);
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, image.width, image.height).data;
  canvas.width = 1;
  canvas.height = 1;
  const { width, height } = image;
  const alpha = new Uint8Array(width * height);
  let sum = 0;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = rgba[i * 4 + 3];
    sum += alpha[i];
  }
  const bbox = alphaBbox(alpha, width, height);
  if (!equal(bbox, record.bbox)) throw new Error(`${record.id}: recorded bbox does not match PNG`);
  if (sum !== record.alphaSum) throw new Error(`${record.id}: recorded alphaSum does not match PNG`);
  return { width, height, alpha, bbox, file };
}

export async function saveRgba(file, width, height, rgba) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  await writeFile(file, canvas.toBuffer('image/png'));
  canvas.width = 1;
  canvas.height = 1;
}

function alphaRgba(alpha) {
  const rgba = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
  return rgba;
}

export async function writeAssets(out, item, before, after) {
  const a = await loadAlpha(before, item.before);
  const b = await loadAlpha(after, item.after);
  const aligned = alignImages(a, b, item.before, item.after, true);
  item.image = { ...item.image, width: aligned.width, height: aligned.height, offset: aligned.offset };
  const stem = `pixels-${item.id}`;
  item.images = Object.fromEntries(['before', 'after', 'heat', 'beforeAligned', 'afterAligned'].map(name => [name, `img/${stem}-${name}.png`]));
  // Keep exact captures as well as the aligned views used by the flicker UI.
  await copyFile(a.file, path.join(out, item.images.before));
  await copyFile(b.file, path.join(out, item.images.after));
  await saveRgba(path.join(out, item.images.heat), aligned.width, aligned.height, heatMap(aligned));
  await saveRgba(path.join(out, item.images.beforeAligned), aligned.width, aligned.height, alphaRgba(aligned.before));
  await saveRgba(path.join(out, item.images.afterAligned), aligned.width, aligned.height, alphaRgba(aligned.after));
}

export async function writeReports(out, report, html) {
  await mkdir(path.join(out, 'cases'), { recursive: true });
  for (const group of groups) {
    if (report.streamedGroups?.includes(group)) continue;
    const stream = createWriteStream(path.join(out, 'cases', `${group}.jsonl`));
    const done = finished(stream);
    // Observe errors even when a write is waiting for drain.
    done.catch(() => {});
    for (const item of report.cases) {
      if (item.group !== group) continue;
      if (!stream.write(`${json(compactCase(item))}\n`)) await once(stream, 'drain');
    }
    stream.end();
    await done;
  }
  const { cases, ...summary } = report;
  await writeJsonStream(path.join(out, 'report.json'), summary);
  await writeFile(path.join(out, 'report.html'), html);
}

// Serialize the summary in bounded chunks too: a corpus can have thousands
// of glyph fields, each with its own 200-worst list.
export async function writeJsonStream(file, value) {
  const stream = createWriteStream(file);
  const done = finished(stream);
  done.catch(() => {});
  let buffer = '';
  function* parts(item) {
    if (item === null || typeof item !== 'object') {
      yield json(item);
    } else if (Array.isArray(item)) {
      yield '[';
      for (let i = 0; i < item.length; i++) {
        if (i) yield ',';
        yield* parts(item[i] ?? null);
      }
      yield ']';
    } else if (Object.values(item).every(child => child === null || typeof child !== 'object'
      || (Array.isArray(child) && child.length <= 100
        && child.every(value => value === null || typeof value !== 'object')))) {
      yield json(item);
    } else {
      yield '{';
      let first = true;
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        if (!first) yield ',';
        first = false;
        yield json(key);
        yield ':';
        yield* parts(child);
      }
      yield '}';
    }
  }
  for (const part of parts(value)) {
    buffer += part;
    if (buffer.length >= 65536) {
      if (!stream.write(buffer)) await once(stream, 'drain');
      buffer = '';
    }
  }
  stream.end(buffer);
  await done;
}

export async function openCaseWriter(out, group) {
  await mkdir(path.join(out, 'cases'), { recursive: true });
  const stream = createWriteStream(path.join(out, 'cases', `${group}.jsonl`));
  const done = finished(stream);
  done.catch(() => {});
  return {
    async write(item) {
      if (!stream.write(`${json(compactCase(item))}\n`)) await once(stream, 'drain');
    },
    async close() {
      stream.end();
      await done;
    },
    abort() {
      stream.destroy();
    }
  };
}

export function compactCase(item) {
  const numbers = {};
  for (const diff of item.numbers ?? []) numbers[diff.field] = Math.max(numbers[diff.field] ?? 0, diff.abs);
  return {
    id: item.id, font: item.font, tags: item.tags, mode: item.mode, size: item.size,
    status: item.status, gates: item.gates, quantities: item.quantities,
    ...(Object.keys(numbers).length ? { numbers } : {}),
    ...(item.skipReasons ? { skipReasons: item.skipReasons } : {}),
    ...(item.errors ? { errors: item.errors } : {}),
    ...(item.layout ? { layout: {
      linesComparable: item.layout.linesComparable,
      linesIdentical: item.layout.linesIdentical,
      largest: item.layout.largest,
      verdictChanged: item.layout.verdictChanged,
      curveChanged: item.layout.curveChanged,
      solveChanged: item.layout.solveChanged,
      changes: [...new Set(item.layout.changes.map(change => (typeof change === 'string' ? change : change.path)
        .replace(/\.\d+(?=\.|$)/g, '')))]
    } } : {}),
    ...(item.image ? { image: Object.fromEntries(['bboxDelta', 'iou', 'meanAbs', 'thick']
      .map(metric => [metric, item.image[metric]])) } : {}),
    ...(item.images ? { images: item.images } : {})
  };
}
