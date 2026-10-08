#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readRun, readCorpus, readJson, writeReports } from '../../src/test/text-port/compare/io.js';
import { compareRuns, attachImages } from '../../src/test/text-port/compare/compare.js';
import { validateEnvelope } from '../../src/test/text-port/compare/envelope.js';
import { renderHtml } from '../../src/test/text-port/compare/html.js';

const usage = 'Usage: node scripts/text-port/compare.mjs <runA> <runB> [--out <dir>] [--gates <file>] [--corpus <dir>] [--envelope <file>] [--limit <n>] [--assets all]';
export function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (!['--out', '--gates', '--corpus', '--envelope', '--limit', '--assets'].includes(arg)
      || options[arg.slice(2)] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(usage);
    }
    options[arg.slice(2)] = args[++i];
  }
  if (positional.length !== 2) throw new Error(usage);
  const limit = options.limit === undefined ? 150 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 0 || (options.limit !== undefined && !/^\d+$/.test(options.limit))) {
    throw new Error('--limit must be a nonnegative integer');
  }
  if (options.assets !== undefined && options.assets !== 'all') throw new Error('--assets accepts only all');
  return { positional, ...options, limit };
}

export function summary(report) {
  const lines = ['Gate                         Result       Within threshold'];
  for (const gate of report.gates.slice(0, 32)) {
    const result = gate.empty ? 'EMPTY' : gate.pass ? 'PASS' : 'FAIL';
    let annotation = '';
    if (gate.envelope.length) {
      annotation = ` envelope max ratios: ${gate.envelope.map(entry => `${entry.field}=${entry.ratioToMax}`).join(', ')}`;
    } else if (report.referenceEnvelope) {
      annotation = ' envelope: no comparable metric';
    }
    lines.push(`${gate.id.padEnd(28)} ${result.padEnd(6)}${gate.enforce ? '     ' : ' info'} ${gate.count - gate.failures}/${gate.count}${annotation}`);
  }
  if (report.gates.length > 32) lines.push(`${report.gates.length - 32} further gates are listed in report.json and report.html`);
  for (const [group, counts] of Object.entries(report.summary)) {
    lines.push(`${group}: ${counts.compared} compared; ${counts.missing} missing; ${counts.error} errors; ${counts.skipped} both skipped; ${counts['skip-mismatch']} skip mismatches`);
  }
  if (report.hashDifferences.length) lines.push(`WARNING: hash mismatch: ${report.hashDifferences.join(', ')}`);
  lines.push(`Overall: ${report.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

export async function main(args) {
  const timings = {};
  let start = performance.now();
  const options = parseArgs(args);
  const [before, after] = await Promise.all(options.positional.map(dir => readRun(dir, { stream: true })));
  const data = process.env.TP_DATA ?? 'node_modules/.cache/text-port';
  const out = path.resolve(options.out ?? path.join(data, 'reports', `${before.manifest.engine}-vs-${after.manifest.engine}-${Date.now()}`));
  // Output must not overwrite a recording's input files.
  for (const run of [before, after]) {
    if (out === run.dir || out.startsWith(`${run.dir}${path.sep}`)) throw new Error('Report output must be outside both run directories');
  }
  const corpus = await readCorpus(options.corpus);
  const gates = await readJson(options.gates ?? fileURLToPath(new URL('./gates.json', import.meta.url)));
  const envelope = options.envelope ? validateEnvelope(await readJson(options.envelope)) : undefined;
  timings.read = performance.now() - start;
  const report = await compareRuns(before, after, { corpus, gates, envelope, out, sampleLimit: options.limit });
  report.sampleLimit = options.limit;
  start = performance.now();
  await attachImages(report, before, after, out, options.assets === 'all' ? 'all' : options.limit);
  timings.assets = performance.now() - start;
  start = performance.now();
  await writeReports(out, report, renderHtml(report));
  timings.reports = performance.now() - start;
  if (process.env.TP_PROFILE) console.error(`CLI phases (ms): ${JSON.stringify(timings)}; RSS ${process.memoryUsage().rss}`);
  console.log(summary(report));
  console.log(`Report: ${path.join(out, 'report.html')}`);
  return report.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`Input error: ${error.message}`);
    process.exitCode = 2;
  });
}
