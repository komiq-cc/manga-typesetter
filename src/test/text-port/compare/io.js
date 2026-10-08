import { readFile, realpath, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { groups, parseJsonl } from './records.js';
import { alphaBbox, alignImages, heatMap } from './images.js';
import { equal, json } from './stats.js';

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { throw new Error(`${file}: ${error.message}`); }
}

export async function readRun(directory) {
  const dir = await realpath(directory);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  if (!manifest || typeof manifest.engine !== 'string' || typeof manifest.commit !== 'string' || !manifest.host || typeof manifest.fonts !== 'string'
    || groups.some(group => typeof manifest.corpus?.[group] !== 'string')) throw new Error(`${dir}: incomplete manifest`);
  const run = { dir, manifest };
  for (const group of groups) run[group] = parseJsonl(await readFile(path.join(dir, `${group}.jsonl`), 'utf8'), `${dir}/${group}.jsonl`);
  for (const group of groups) {
    if (manifest.counts?.[group] !== run[group].size) throw new Error(`${dir}: manifest counts.${group} does not match JSONL record count`);
  }
  const skipped = groups.reduce((sum, group) => sum + [...run[group].values()].filter(record => record.skip !== undefined).length, 0);
  if (manifest.counts.skipped !== skipped) throw new Error(`${dir}: manifest counts.skipped does not match skip records`);
  return run;
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
    corpus[group] = parseJsonl(data.cases.map(item => JSON.stringify(item)).join('\n'), file);
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
  const alpha = new Uint8Array(image.width * image.height);
  let sum = 0;
  for (let i = 0; i < alpha.length; i++) { alpha[i] = rgba[i * 4 + 3]; sum += alpha[i]; }
  const bbox = alphaBbox(alpha, image.width, image.height);
  if (!equal(bbox, record.bbox)) throw new Error(`${record.id}: recorded bbox does not match PNG`);
  if (sum !== record.alphaSum) throw new Error(`${record.id}: recorded alphaSum does not match PNG`);
  return { width: image.width, height: image.height, alpha, file };
}

export async function saveRgba(file, width, height, rgba) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  await writeFile(file, canvas.toBuffer('image/png'));
}

function alphaRgba(alpha) {
  const rgba = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
  return rgba;
}

export async function writeAssets(out, item, before, after) {
  const a = await loadAlpha(before, item.before);
  const b = await loadAlpha(after, item.after);
  const aligned = alignImages(a, b, item.before, item.after);
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
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.json'), json(report, 2));
  await writeFile(path.join(out, 'report.html'), html);
}
