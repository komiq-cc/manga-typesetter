#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { readRun, readJson } from '../../src/test/text-port/compare/io.js';
import { compareRuns } from '../../src/test/text-port/compare/compare.js';
import { buildEnvelope } from '../../src/test/text-port/compare/envelope.js';
import { json } from '../../src/test/text-port/compare/stats.js';

export async function main(args) {
  const runs = [];
  let out;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && !out && args[i + 1] && !args[i + 1].startsWith('--')) out = args[++i];
    else if (args[i].startsWith('--')) throw new Error('Unknown or duplicate envelope option');
    else runs.push(args[i]);
  }
  if (runs.length < 2 || !out) throw new Error('Usage: node scripts/text-port/envelope.mjs <run> <run> [<run>...] --out <file>');
  const recordings = await Promise.all(runs.map(readRun));
  const gates = await readJson(fileURLToPath(new URL('./gates.json', import.meta.url)));
  const reports = [];
  for (let a = 0; a < recordings.length; a++) for (let b = a + 1; b < recordings.length; b++) reports.push(await compareRuns(recordings[a], recordings[b], { gates }));
  const envelope = buildEnvelope(reports, recordings);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, json(envelope, 2));
  console.log(`Envelope: ${recordings.length} runs, ${reports.length} pairs, ${Object.keys(envelope.metrics).length} metrics -> ${out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(`Input error: ${error.message}`); process.exitCode = 2; });
}
