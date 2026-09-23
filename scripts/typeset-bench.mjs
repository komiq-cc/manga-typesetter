#!/usr/bin/env node
// The lettering benchmark (TST-2), with its outputs written to disk.
//
//   node scripts/typeset-bench.mjs [--out DIR] [--layout MODULE] [--approve all|ID,ID...]
//
//   --out DIR         where report.json and the contact sheets (one PNG per
//                     category) go. Default node_modules/.cache/typeset-bench.
//   --layout MODULE   benchmark another layout: a module whose default (or
//                     `layout`) export is `(benchCase, ctx) => ({ x, y, w, h,
//                     size, lines, fit?, path? })`. Default: the store's own
//                     placement. See src/test/typeset-bench/runner.js.
//   --approve IDS     record these cases' current layout (or all of them) in
//                     src/test/typeset-bench/approved.json, which later runs
//                     compare against.
//
// It is the benchmark test file run on its own, in the real-font lane, with the
// environment variables it reads set. `npx vitest run` runs the same file and
// prints the same table, writing nothing.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const usage = 'usage: node scripts/typeset-bench.mjs [--out DIR] [--layout MODULE] [--approve all|ID,ID...]';

const env = { ...process.env, TYPESET_BENCH_OUT: resolve(root, 'node_modules/.cache/typeset-bench') };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  if (!['--out', '--layout', '--approve'].includes(flag) || !value || value.startsWith('--')) {
    console.error(usage);
    process.exit(2);
  }
  i++;
  if (flag === '--out') env.TYPESET_BENCH_OUT = resolve(value);
  if (flag === '--layout') env.TYPESET_BENCH_LAYOUT = resolve(value);
  if (flag === '--approve') env.TYPESET_BENCH_APPROVE = value;
}

const run = spawnSync(
  'npx',
  ['vitest', 'run', '--project', 'realfont', 'src/lib/typeset-bench.realfont.test.js'],
  { cwd: root, env, stdio: 'inherit' },
);
process.exit(run.status ?? 1);
