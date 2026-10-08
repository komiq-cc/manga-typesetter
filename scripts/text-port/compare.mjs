#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, readCorpus, readJson, writeReports } from '../../src/test/text-port/compare/io.js';
import { compareRuns, attachImages } from '../../src/test/text-port/compare/compare.js';
import { validateEnvelope } from '../../src/test/text-port/compare/envelope.js';
import { renderHtml } from '../../src/test/text-port/compare/html.js';

const usage = 'Usage: node scripts/text-port/compare.mjs <runA> <runB> [--out <dir>] [--gates <file>] [--corpus <dir>] [--envelope <file>] [--limit <n>]';
export function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!['--out', '--gates', '--corpus', '--envelope', '--limit'].includes(arg) || options[arg.slice(2)] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
    options[arg.slice(2)] = args[++i];
  }
  if (positional.length !== 2) throw new Error(usage);
  const limit = options.limit === undefined ? 150 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 0 || (options.limit !== undefined && !/^\d+$/.test(options.limit))) throw new Error('--limit must be a nonnegative integer');
  return { positional, ...options, limit };
}

export function summary(report) {
  const lines = ['Gate                         Result       Within threshold'];
  for (const gate of report.gates) lines.push(`${gate.id.padEnd(28)} ${(gate.empty ? 'EMPTY' : gate.pass ? 'PASS' : 'FAIL').padEnd(6)}${gate.enforce ? '     ' : ' info'} ${gate.count - gate.failures}/${gate.count}${gate.envelope.length ? ` envelope max ratios: ${gate.envelope.map(entry => `${entry.field}=${entry.ratioToMax}`).join(', ')}` : report.referenceEnvelope ? ' envelope: no comparable metric' : ''}`);
  for (const [group, counts] of Object.entries(report.summary)) lines.push(`${group}: ${counts.compared} compared; ${counts.missing} missing; ${counts.error} errors; ${counts.skipped} both skipped; ${counts['skip-mismatch']} skip mismatches`);
  if (report.hashDifferences.length) lines.push(`WARNING: hash mismatch: ${report.hashDifferences.join(', ')}`);
  lines.push(`Overall: ${report.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

export async function main(args) {
  const options = parseArgs(args);
  const [before, after] = await Promise.all(options.positional.map(readRun));
  const data = process.env.TP_DATA ?? 'node_modules/.cache/text-port';
  const out = path.resolve(options.out ?? path.join(data, 'reports', `${before.manifest.engine}-vs-${after.manifest.engine}-${Date.now()}`));
  // Output must not overwrite a recording's input files.
  for (const run of [before, after]) if (out === run.dir || out.startsWith(`${run.dir}${path.sep}`)) throw new Error('Report output must be outside both run directories');
  const corpus = await readCorpus(options.corpus);
  const gates = await readJson(options.gates ?? fileURLToPath(new URL('./gates.json', import.meta.url)));
  const envelope = options.envelope ? validateEnvelope(await readJson(options.envelope)) : undefined;
  const report = await compareRuns(before, after, { corpus, gates, envelope });
  await attachImages(report, before, after, out, options.limit);
  await writeReports(out, report, renderHtml(report));
  console.log(summary(report));
  console.log(`Report: ${path.join(out, 'report.html')}`);
  return report.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(`Input error: ${error.message}`); process.exitCode = 2; });
}
