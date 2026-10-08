import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { manifestDifferences, groups } from './records.js';
import { compareNumbers, numberDifference, NumberAccumulator } from './numbers.js';
import { compareLayout } from './layout.js';
import { openCaseWriter, joinedBatches, validateRunCounts, compactCase } from './io.js';
import { evaluateGates, GateTableAccumulator, validateGates, matchesTags } from './gates.js';
import { equal, summarize, Distribution } from './stats.js';

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

export async function compareRuns(before, after, {
  corpus = {}, gates, envelope, statistics = true, out, sampleLimit = 150,
  onBatch, retainCases = true
} = {}) {
  validateGates(gates);
  if (!corpus.hashes && gates.gates.some(gate => gate.excludeTags !== undefined || gate.onlyTags !== undefined)) {
    throw new Error('Tag selectors require --corpus');
  }
  if (envelope?.runs?.some(run => [before, after].some(candidate =>
    !equal(run.manifest?.corpus, candidate.manifest.corpus) || run.manifest?.fonts !== candidate.manifest.fonts))) {
    throw new Error('Envelope font/corpus hashes do not match compared runs');
  }
  const hashDifferences = manifestDifferences(before.manifest, after.manifest);
  if (corpus.hashes) {
    for (const group of groups) {
      if (corpus.hashes[group] !== before.manifest.corpus[group] || corpus.hashes[group] !== after.manifest.corpus[group]) {
        hashDifferences.push(`supplied corpus.${group}`);
      }
    }
  }
  const config = { ...gates, gates: gates.gates.filter(gate => gate.kind !== 'hashes') };
  const hashConfig = { ...gates, gates: gates.gates.filter(gate => gate.kind === 'hashes') };
  const hashGates = evaluateGates([], hashDifferences, hashConfig, envelope, corpus.hashes ? 5 : 2, Boolean(corpus.hashes));
  const collector = new Map();
  const results = new Map();
  const byTag = new GateTableAccumulator(gates, 'tag');
  const byFont = new GateTableAccumulator(gates, 'font');
  const summary = {};
  const numberStats = {};
  const pixels = Object.fromEntries(['bboxDelta', 'iou', 'meanAbs', 'thick'].map(metric => [metric, new Distribution()]));
  const cases = [];
  const timings = { numbers: 0, decode: 0, images: 0 };
  for (const group of groups) {
    const accumulator = statistics && group !== 'pixels' ? new NumberAccumulator(group, gates) : null;
    const writer = out && group !== 'pixels' ? await openCaseWriter(out, group) : null;
    const counts = { total: 0, compared: 0, missing: 0, error: 0, skipped: 0, 'skip-mismatch': 0, skippedBefore: 0, skippedAfter: 0 };
    summary[group] = counts;
    let sample = [];
    try {
      for await (const batch of joinedBatches(before, after, corpus, group)) {
        const start = performance.now();
        for (const item of batch) {
          counts.total++;
          counts[item.status]++;
          counts.skippedBefore += Number(item.beforeSkipped);
          counts.skippedAfter += Number(item.afterSkipped);
          if (item.status !== 'compared' || group === 'pixels') continue;
          if (group === 'metrics') item.numbers = compareNumbers(item.before, item.after);
          else {
            item.layout = compareLayout(item.before, item.after);
            item.numbers = item.layout.numbers;
          }
          requiredNumbers(item);
        }
        timings.numbers += performance.now() - start;
        if (group === 'pixels') await comparePixels(batch, before, after, timings);
        const partial = evaluateGates(batch, hashDifferences, config, envelope,
          corpus.hashes ? 5 : 2, Boolean(corpus.hashes), collector);
        mergeGates(results, partial);
        for (const item of batch) {
          for (const gate of hashGates) {
            if ((!gate.group || gate.group === group) && matchesTags(item, gate)) {
              item.quantities ??= {};
              item.quantities[gate.id] = Number(hashDifferences.length > 0);
            }
          }
          if (item.image && statistics) {
            for (const metric of Object.keys(pixels)) pixels[metric].push(item.image[metric]);
          }
        }
        if (onBatch) onBatch(batch, hashDifferences);
        if (statistics) {
          accumulator?.add(batch);
          byTag.add(batch);
          byFont.add(batch);
        }
        for (const item of batch) {
          if (writer) await writer.write(item);
          if (!retainCases) continue;
          if (out && group !== 'pixels') sample.push(sampleCase(item));
          else cases.push(item);
        }
        if (out && group !== 'pixels') sample = sample.sort(caseOrder).slice(0, sampleLimit);
      }
      if (writer) await writer.close();
    } catch (error) {
      writer?.abort();
      throw error;
    }
    cases.push(...sample);
    if (accumulator) numberStats[group] = accumulator.finish();
  }
  for (const run of [before, after]) {
    if (run.streamed) validateRunCounts(run);
  }
  // Also retain EMPTY gates when no batch exists in any group.
  mergeGates(results, evaluateGates([], hashDifferences, config, envelope,
    corpus.hashes ? 5 : 2, Boolean(corpus.hashes), collector));
  for (const result of results.values()) finishGate(result, collector.get(result.id));
  for (const gate of hashGates) results.set(gate.id, gate);
  const gateLines = gates.gates.map(gate => results.get(gate.id));
  const report = {
    version: 1,
    before: { directory: before.dir, manifest: before.manifest },
    after: { directory: after.dir, manifest: after.manifest },
    pass: !Object.values(summary).some(counts => counts.error || counts.missing)
      && gateLines.every(gate => gate.pass || !gate.enforce),
    hashDifferences,
    metadataSource: corpus.hashes ? 'corpus' : 'id prefix (font); id suffix (mode); unknown sizes gated conservatively',
    referenceEnvelope: envelope ? {
      version: envelope.version, pairs: envelope.pairs, runs: envelope.runs, convention: envelope.convention
    } : null,
    summary,
    gates: gateLines,
    byTag: statistics ? byTag.finish() : {},
    byFont: statistics ? byFont.finish() : {},
    statistics: statistics ? {
      ...numberStats,
      pixels: Object.fromEntries(Object.entries(pixels).map(([metric, values]) => [metric, summarize(values)]))
    } : {},
    streamedGroups: out ? ['metrics', 'layout'] : [],
    cases: statistics ? cases.sort((a, b) => caseOrder(a, b) || a.group.localeCompare(b.group)) : cases
  };
  if (process.env.TP_PROFILE) console.error(`Compare phases (ms): ${JSON.stringify(timings)}; RSS ${process.memoryUsage().rss}`);
  return report;
}

function sampleCase(item) {
  const compact = compactCase(item);
  const largest = new Map();
  for (const diff of item.numbers) {
    if (!largest.has(diff.field) || diff.abs > largest.get(diff.field).abs) largest.set(diff.field, diff);
  }
  return {
    ...compact, group: item.group, severity: severity(item),
    numbers: [...largest.values()].map(diff => ({ ...diff, path: diff.field })),
    ...(item.layout ? {
      layout: compact.layout,
      linesA: item.before?.solve?.lines ?? item.before?.lines,
      linesB: item.after?.solve?.lines ?? item.after?.lines
    } : {})
  };
}

function mergeGates(results, partial) {
  for (const gate of partial) {
    if (!results.has(gate.id)) {
      results.set(gate.id, { ...gate, count: 0, failures: 0, exceptions: [], unknownSize: [], unknownSizeCount: 0 });
    }
    const result = results.get(gate.id);
    result.count += gate.count;
    result.failures += gate.failures;
    result.unknownSizeCount += gate.unknownSizeCount;
    result.unknownSize.push(...gate.unknownSize.slice(0, 2000 - result.unknownSize.length));
    result.exceptions.push(...gate.exceptions.slice(0, 2000 - result.exceptions.length));
  }
}

function finishGate(result, collected) {
  result.fraction = result.count ? (result.count - result.failures) / result.count : 1;
  result.pass = result.fraction + 1e-12 >= (result.atLeast ?? 1);
  result.empty = result.count === 0;
  result.exceptionCount = result.failures;
  result.exceptionsTruncated = result.failures > result.exceptions.length;
  result.statistics = summarize(collected.values);
  result.envelope = [...collected.envelope.values()].map(({ field, candidate, reference }) => {
    const statistics = summarize(candidate);
    return {
      field, candidate: statistics, reference,
      ratioToMax: reference.max === 0 ? (statistics.max === 0 ? 0 : Infinity) : statistics.max / reference.max
    };
  });
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

