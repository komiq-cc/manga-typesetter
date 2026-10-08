import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { joinRuns, manifestDifferences, groups } from './records.js';
import { compareNumbers, numberDifference, numberStatistics } from './numbers.js';
import { compareLayout } from './layout.js';
import { loadAlpha, writeAssets } from './io.js';
import { alignImages, compareAlpha } from './images.js';
import { evaluateGates } from './gates.js';
import { equal, summarize } from './stats.js';

function requiredNumbers(item) {
  const paths = item.group === 'metrics' ? ['adv', 'font.ascent', 'font.descent']
    : item.before.solve !== undefined || item.after.solve !== undefined ? ['solve.size', 'solve.x', 'solve.y', 'solve.w', 'solve.h'] : ['blockY', 'blockH', 'baseY', 'lineH'];
  const get = (object, field) => field.split('.').reduce((value, key) => value?.[key], object);
  for (const field of paths) if (!item.numbers.some(diff => diff.path === field)) item.numbers.push({ path: field, field, ...numberDifference(get(item.before, field), get(item.after, field)) });
  const array = item.group === 'metrics' ? 'chars' : paths[0].startsWith('solve') ? 'solve.lines' : 'lineX';
  if (!Array.isArray(get(item.before, array)) || !Array.isArray(get(item.after, array))) {
    if (!item.numbers.some(diff => diff.path === `${array}.length`)) item.numbers.push({ path: `${array}.length`, field: `${array}.length`, structural: true, ...numberDifference(undefined, undefined) });
  }
}

export function severity(item) {
  if (item.status === 'missing' || item.status === 'error') return Infinity;
  if (item.image) return Math.max(item.image.bboxDelta, item.image.thick, (1 - item.image.iou) * 100, item.image.meanAbs / 255);
  if (item.layout && (!item.layout.linesIdentical || item.layout.verdictChanged)) return 10000;
  return item.numbers.reduce((max, diff) => Math.max(max, diff.abs), 0);
}

export async function compareRuns(before, after, { corpus = {}, gates, envelope } = {}) {
  if (envelope?.runs?.some(run => [before, after].some(candidate => !equal(run.manifest?.corpus, candidate.manifest.corpus) || run.manifest?.fonts !== candidate.manifest.fonts))) {
    throw new Error('Envelope font/corpus hashes do not match compared runs');
  }
  const cases = joinRuns(before, after, corpus);
  const hashDifferences = manifestDifferences(before.manifest, after.manifest);
  if (corpus.hashes) for (const group of groups) {
    if (corpus.hashes[group] !== before.manifest.corpus[group] || corpus.hashes[group] !== after.manifest.corpus[group]) hashDifferences.push(`supplied corpus.${group}`);
  }
  for (const item of cases) {
    if (item.status !== 'compared') continue;
    if (item.group === 'metrics') item.numbers = compareNumbers(item.before, item.after);
    if (item.group === 'layout') { item.layout = compareLayout(item.before, item.after); item.numbers = item.layout.numbers; }
    if (item.group !== 'pixels') requiredNumbers(item);
    else {
      const a = await loadAlpha(before, item.before);
      const b = await loadAlpha(after, item.after);
      item.image = compareAlpha(alignImages(a, b, item.before, item.after));
    }
  }
  const gateLines = evaluateGates(cases, hashDifferences, gates, envelope, corpus.hashes ? 5 : 2);
  const integrity = cases.filter(item => item.status === 'error' || item.status === 'missing');
  // Missing captures and engine errors fail even if a custom file omits guards.
  const pass = !integrity.length && gateLines.every(gate => gate.pass || !gate.enforce);
  const summary = Object.fromEntries(groups.map(group => {
    const items = cases.filter(item => item.group === group);
    return [group, { total: items.length, ...Object.fromEntries(['compared', 'missing', 'error', 'skipped', 'skip-mismatch'].map(status => [status, items.filter(item => item.status === status).length])),
      skippedBefore: items.filter(item => item.before?.skip !== undefined).length, skippedAfter: items.filter(item => item.after?.skip !== undefined).length }];
  }));
  return { version: 1, before: { directory: before.dir, manifest: before.manifest }, after: { directory: after.dir, manifest: after.manifest }, pass,
    hashDifferences, metadataSource: corpus.hashes ? 'corpus' : 'id prefix (font); id suffix (mode); unknown sizes gated conservatively',
    referenceEnvelope: envelope ? { version: envelope.version, pairs: envelope.pairs, runs: envelope.runs, convention: envelope.convention } : null,
    summary, gates: gateLines, statistics: { metrics: numberStatistics(cases, 'metrics'), layout: numberStatistics(cases, 'layout'),
      pixels: Object.fromEntries(['bboxDelta', 'iou', 'meanAbs', 'thick'].map(metric => [metric, summarize(cases.filter(item => item.image).map(item => item.image[metric]))])) },
    cases: cases.sort((a, b) => Number(b.gates.length > 0) - Number(a.gates.length > 0) || severity(b) - severity(a) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id)) };
}

export async function attachImages(report, before, after, out, limit) {
  await mkdir(path.join(out, 'img'), { recursive: true });
  const selected = new Set();
  for (const group of groups) {
    const items = report.cases.filter(item => item.group === group && item.status === 'compared');
    for (const item of items.slice(0, limit)) selected.add(item);
    for (const item of items) if (item.gates.length) selected.add(item);
  }
  for (const item of selected) if (item.image) await writeAssets(out, item, before, after);
  report.assets = { limit, selected: [...selected].map(item => ({ group: item.group, id: item.id })), pixelCases: [...selected].filter(item => item.image).length };
}
