#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { readRun, readCorpus, writeJsonStream } from '../../src/test/text-port/compare/io.js';
import { compareRuns } from '../../src/test/text-port/compare/compare.js';
import { EnvelopeAccumulator } from '../../src/test/text-port/compare/envelope.js';

export async function main(args) {
  const runs = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      runs.push(arg);
    } else if (['--out', '--corpus'].includes(arg) && !options[arg]
      && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[arg] = args[++i];
    } else {
      throw new Error('Unknown or duplicate envelope option');
    }
  }
  const out = options['--out'];
  if (runs.length < 2 || !out) {
    throw new Error('Usage: node scripts/text-port/envelope.mjs <run> <run> [<run>...] [--corpus <dir>] --out <file>');
  }
  const recordings = await Promise.all(runs.map(dir => readRun(dir, { stream: true })));
  const corpus = await readCorpus(options['--corpus']);
  const accumulator = new EnvelopeAccumulator(recordings);
  for (let a = 0; a < recordings.length; a++) {
    for (let b = a + 1; b < recordings.length; b++) {
      accumulator.beginPair(recordings[a].manifest.engine, recordings[b].manifest.engine);
      const report = await compareRuns(recordings[a], recordings[b], {
        corpus, gates: { version: 1, gates: [] }, statistics: false, retainCases: false,
        onBatch: (batch, hashes) => accumulator.addBatch(batch, hashes)
      });
      if (report.hashDifferences.length) throw new Error('Reference runs have mismatched hashes');
      accumulator.endPair();
    }
  }
  const envelope = accumulator.finish();
  envelope.metadataSource = options['--corpus'] ? 'corpus' : 'unknown tags; covered/uncovered tables unavailable';
  if (!options['--corpus']) {
    envelope.covered = null;
    envelope.uncovered = null;
    for (const pair of envelope.pairwise) {
      pair.covered = null;
      pair.uncovered = null;
      pair.smartLines.covered = null;
      pair.smartLines.uncovered = null;
    }
  }
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeJsonStream(out, envelope);
  console.log(`Envelope: ${recordings.length} runs, ${envelope.pairs} pairs, ${Object.keys(envelope.metrics).length} metrics -> ${out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`Input error: ${error.message}`);
    process.exitCode = 2;
  });
}
