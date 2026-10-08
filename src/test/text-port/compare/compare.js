import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { joinRuns, manifestDifferences, groups } from './records.js';
import { compareNumbers, numberDifference, numberStatistics, NumberAccumulator } from './numbers.js';
import { compareLayout } from './layout.js';
import { openCaseWriter } from './io.js';
import { evaluateGates, gateTables, validateGates } from './gates.js';
import { equal, summarize } from './stats.js';

function requiredNumbers(item) {
  if (item.group === 'layout' && Array.isArray(item.before.curve) && Array.isArray(item.after.curve)) return;
  let paths = ['adv', 'font.ascent', 'font.descent'];
  if (item.group === 'layout') {
    paths = item.before.solve !== undefined || item.after.solve !== undefined
      ? ['solve.size', 'solve.x', 'solve.y', 'solve.w', 'solve.h']
      : ['blockY', 'blockH', 'baseY', 'lineH'];
  }
  const get = (object, field) => field.split('.').reduce((value, key) => value?.[key], object);
  for (const field of paths) {
    if (!item.numbers.some(diff => diff.path === field)) {
      item.numbers.push({
        path: field,
        field,
        ...numberDifference(get(item.before, field), get(item.after, field))
      });
    }
  }
  const array = item.group === 'metrics' ? 'chars' : paths[0].startsWith('solve') ? 'solve.lines' : 'lineX';
  if (!Array.isArray(get(item.before, array)) || !Array.isArray(get(item.after, array))) {
    if (!item.numbers.some(diff => diff.path === `${array}.length`)) {
      item.numbers.push({
        path: `${array}.length`,
        field: `${array}.length`,
        structural: true,
        ...numberDifference(undefined, undefined)
      });
    }
  }
}

export function severity(item) {
  if (item.severity !== undefined) return item.severity;
  if (item.status === 'missing' || item.status === 'error') return Infinity;
  if (item.image) {
    return Math.max(item.image.bboxDelta, item.image.thick, (1 - item.image.iou) * 100, item.image.meanAbs / 255);
  }
  if (item.layout && (!item.layout.linesIdentical || item.layout.verdictChanged)) return 10000;
  return item.numbers.reduce((max, diff) => Math.max(max, diff.abs), 0);
}

export async function compareRuns(before, after, { corpus = {}, gates, envelope, statistics = true, out, sampleLimit = 150, releaseInputs = false } = {}) {
  validateGates(gates);
  if (!corpus.hashes && gates.gates.some(gate => gate.excludeTags !== undefined || gate.onlyTags !== undefined)) {
    throw new Error('Tag selectors require --corpus');
  }
  if (envelope?.runs?.some(run => [before, after].some(candidate =>
    !equal(run.manifest?.corpus, candidate.manifest.corpus) || run.manifest?.fonts !== candidate.manifest.fonts))) {
    throw new Error('Envelope font/corpus hashes do not match compared runs');
  }
  const cases = joinRuns(before, after, corpus);
  const hashDifferences = manifestDifferences(before.manifest, after.manifest);
  if (corpus.hashes) {
    for (const group of groups) {
      if (corpus.hashes[group] !== before.manifest.corpus[group] || corpus.hashes[group] !== after.manifest.corpus[group]) {
        hashDifferences.push(`supplied corpus.${group}`);
      }
    }
  }
  const timings = { numbers: 0, decode: 0, images: 0 };
  const earlyConfig = { ...gates, gates: out ? gates.gates.filter(gate =>
    gate.rule === 'integrity' && !gate.group && gate.kind !== 'invalid') : [] };
  const earlyGates = evaluateGates(cases, hashDifferences, earlyConfig, envelope, corpus.hashes ? 5 : 2, Boolean(corpus.hashes));
  const earlyIds = new Set(earlyGates.map(gate => gate.id));
  const metricStart = performance.now();
  const metricResult = out ? await streamMetrics(cases, gates, hashDifferences, envelope, corpus, out, sampleLimit, releaseInputs, before, after) : null;
  if (releaseInputs && metricResult) {
    before.metrics.clear();
    after.metrics.clear();
    corpus.metrics?.clear();
  }
  timings.metricsStream = performance.now() - metricStart;
  for (const item of cases) {
    if (item.status !== 'compared') continue;
    if (item.group === 'pixels' || (metricResult && item.group === 'metrics')) continue;
    const start = performance.now();
    {
      if (item.group === 'metrics') item.numbers = compareNumbers(item.before, item.after);
      if (item.group === 'layout') {
        item.layout = compareLayout(item.before, item.after);
        item.numbers = item.layout.numbers;
      }
      requiredNumbers(item);
      timings.numbers += performance.now() - start;
    }
  }
  if (process.env.TP_PROFILE) console.error(`Before pixels: ${JSON.stringify(process.memoryUsage())}`);
  await comparePixels(cases, before, after, timings);
  if (process.env.TP_PROFILE) console.error(`After pixels: ${JSON.stringify(process.memoryUsage())}`);
  let start = performance.now();
  const remaining = metricResult ? { ...gates, gates: gates.gates.filter(gate => gate.group !== 'metrics' && !earlyIds.has(gate.id)) } : gates;
  const evaluated = evaluateGates(cases, hashDifferences, remaining, envelope, corpus.hashes ? 5 : 2, Boolean(corpus.hashes));
  const byId = new Map([...evaluated, ...earlyGates, ...(metricResult?.gates ?? [])].map(gate => [gate.id, gate]));
  const gateLines = gates.gates.map(gate => byId.get(gate.id));
  timings.gates = performance.now() - start;
  // Missing captures and engine errors fail even if a custom file omits guards.
  const pass = !cases.some(item => item.status === 'error' || item.status === 'missing')
    && gateLines.every(gate => gate.pass || !gate.enforce);
  const summary = Object.fromEntries(groups.map(group => {
    const items = cases.filter(item => item.group === group);
    return [group, {
      total: items.length,
      ...Object.fromEntries(['compared', 'missing', 'error', 'skipped', 'skip-mismatch'].map(status => [
        status, items.filter(item => item.status === status).length
      ])),
      skippedBefore: items.filter(item => (item.beforeSkipped ?? (item.before?.skip !== undefined))).length,
      skippedAfter: items.filter(item => (item.afterSkipped ?? (item.after?.skip !== undefined))).length
    }];
  }));
  start = performance.now();
  const report = {
    version: 1,
    before: { directory: before.dir, manifest: before.manifest },
    after: { directory: after.dir, manifest: after.manifest },
    pass,
    hashDifferences,
    metadataSource: corpus.hashes ? 'corpus' : 'id prefix (font); id suffix (mode); unknown sizes gated conservatively',
    referenceEnvelope: envelope ? {
      version: envelope.version, pairs: envelope.pairs, runs: envelope.runs, convention: envelope.convention
    } : null,
    summary,
    gates: gateLines,
    byTag: statistics ? gateTables(cases, gates, 'tag') : {},
    byFont: statistics ? gateTables(cases, gates, 'font') : {},
    statistics: statistics ? {
      metrics: metricResult?.statistics ?? numberStatistics(cases, 'metrics'),
      layout: numberStatistics(cases, 'layout'),
      pixels: Object.fromEntries(['bboxDelta', 'iou', 'meanAbs', 'thick'].map(metric => [
        metric, summarize(cases.filter(item => item.image).map(item => item.image[metric]))
      ]))
    } : {},
    streamedGroups: metricResult ? ['metrics'] : [],
    cases: statistics ? cases.sort((a, b) => Number(b.gates.length > 0) - Number(a.gates.length > 0)
      || severity(b) - severity(a) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id)) : cases
  };
  timings.statisticsAndSort = performance.now() - start;
  if (process.env.TP_PROFILE) console.error(`Compare phases (ms): ${JSON.stringify(timings)}; RSS ${process.memoryUsage().rss}`);
  return report;
}

export async function attachImages(report, before, after, out, limit) {
  await rm(path.join(out, 'img'), { recursive: true, force: true });
  await mkdir(path.join(out, 'img'), { recursive: true });
  const selected = new Set();
  for (const group of groups) {
    const items = report.cases.filter(item => item.group === group && item.status === 'compared');
    for (const item of items.slice(0, limit === 'all' ? items.length : limit)) selected.add(item);
  }
  const pictures = [...selected].filter(item => item.image);
  for (let offset = 0; offset < pictures.length; offset += 64) {
    const batches = [pictures.slice(offset, offset + 32), pictures.slice(offset + 32, offset + 64)].filter(batch => batch.length);
    await Promise.all(batches.map(async batch => {
      const result = await pixelBatch(batch, before, after, out);
      batch.forEach((item, index) => {
        Object.assign(item, result.results[index]);
      });
    }));
  }
  report.assets = {
    limit,
    selected: [...selected].map(item => ({ group: item.group, id: item.id })),
    pixelCases: [...selected].filter(item => item.image).length
  };
}

async function comparePixels(cases, before, after, timings) {
  const pixels = cases.filter(item => item.group === 'pixels' && item.status === 'compared');
  // Recycling isolates native decoder allocations as well as JS alpha arrays.
  // At most two batches of 128 pictures are resident outside the main thread.
  for (let offset = 0; offset < pixels.length; offset += 256) {
    const batches = [pixels.slice(offset, offset + 128), pixels.slice(offset + 128, offset + 256)].filter(batch => batch.length);
    await Promise.all(batches.map(async batch => {
      const result = await pixelBatch(batch, before, after);
      batch.forEach((item, index) => {
        item.image = result.results[index];
      });
      timings.decode += result.timings.decode;
      timings.images += result.timings.images;
    }));
  }
}

function pixelBatch(batch, before, after, out) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pixel-worker.js', import.meta.url), {
      workerData: {
        before: { dir: before.dir },
        after: { dir: after.dir },
        out,
        cases: batch.map(item => ({
          id: item.id, before: item.before, after: item.after, image: item.image
        }))
      }
    });
    let result;
    worker.once('message', message => {
      result = message;
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !result) reject(new Error(`Pixel worker exited ${code} without a result`));
      else if (result.error) reject(new Error(result.error));
      else resolve(result);
    });
  });
}

function caseOrder(a, b) {
  return Number(b.gates.length > 0) - Number(a.gates.length > 0)
    || severity(b) - severity(a) || a.id.localeCompare(b.id);
}

async function streamMetrics(cases, gates, hashes, envelope, corpus, out, limit, releaseInputs, before, after) {
  const items = cases.filter(item => item.group === 'metrics');
  const config = { ...gates, gates: gates.gates.filter(gate => gate.group === 'metrics') };
  const globalInvalid = { ...gates, gates: gates.gates.filter(gate =>
    gate.rule === 'integrity' && !gate.group && gate.kind === 'invalid') };
  const collector = new Map();
  const results = new Map();
  const accumulator = new NumberAccumulator('metrics');
  const writer = await openCaseWriter(out, 'metrics');
  let sample = [];
  try {
    for (let offset = 0; offset < items.length; offset += 500) {
      const batch = items.slice(offset, offset + 500);
      for (const item of batch) {
        if (item.status !== 'compared') continue;
        item.numbers = compareNumbers(item.before, item.after);
        requiredNumbers(item);
      }
      const partial = evaluateGates(batch, hashes, config, envelope, corpus.hashes ? 5 : 2, Boolean(corpus.hashes), collector);
      for (const gate of partial) {
        if (!results.has(gate.id)) {
          results.set(gate.id, { ...gate, count: 0, failures: 0, exceptions: [], unknownSize: [], unknownSizeCount: 0 });
        }
        const result = results.get(gate.id);
        result.unknownSizeCount += gate.unknownSizeCount;
        result.unknownSize.push(...gate.unknownSize.slice(0, 2000 - result.unknownSize.length));
        result.count += gate.count;
        result.failures += gate.failures;
        result.exceptions.push(...gate.exceptions.slice(0, 2000 - result.exceptions.length));
      }
      // Global validity gates need to appear in streamed rows as well. Their
      // aggregate result is evaluated once all groups have been processed.
      evaluateGates(batch, hashes, globalInvalid, envelope, corpus.hashes ? 5 : 2, Boolean(corpus.hashes));
      accumulator.add(batch);
      for (const item of batch) {
        item.beforeSkipped = item.before?.skip !== undefined;
        item.afterSkipped = item.after?.skip !== undefined;
        item.invalidNumbers = item.numbers.some(diff => diff.invalid || diff.structural);
        item.severity = severity(item);
        await writer.write(item);
      }
      if (releaseInputs) {
        for (const item of batch) {
          before.metrics.delete(item.id);
          after.metrics.delete(item.id);
          corpus.metrics?.delete(item.id);
        }
      }
      const candidates = [...sample, ...batch];
      sample = candidates.sort(caseOrder).slice(0, limit);
      const selected = new Set(sample);
      for (const item of candidates) {
        if (!selected.has(item)) {
          item.numbers = [];
          if (releaseInputs) {
            item.before = null;
            item.after = null;
          }
        }
      }
    }
    await writer.close();
  } catch (error) {
    writer.abort();
    throw error;
  }
  // Evaluate an empty group as well, preserving EMPTY gates for zero records.
  if (!items.length) {
    for (const gate of evaluateGates([], hashes, config, envelope, corpus.hashes ? 5 : 2, Boolean(corpus.hashes), collector)) {
      results.set(gate.id, gate);
    }
  }
  for (const result of results.values()) {
    result.fraction = result.count ? (result.count - result.failures) / result.count : 1;
    result.pass = result.fraction + 1e-12 >= (result.atLeast ?? 1);
    result.empty = result.count === 0;
    result.exceptionCount = result.failures;
    result.exceptionsTruncated = result.failures > result.exceptions.length;
    const collected = collector.get(result.id);
    result.statistics = summarize(collected.values);
    result.envelope = [...collected.envelope.values()].map(({ field, candidate, reference }) => {
      const statistics = summarize(candidate);
      return {
        field,
        candidate: statistics,
        reference,
        ratioToMax: reference.max === 0 ? (statistics.max === 0 ? 0 : Infinity) : statistics.max / reference.max
      };
    });
  }
  return { gates: [...results.values()], statistics: accumulator.finish() };
}
