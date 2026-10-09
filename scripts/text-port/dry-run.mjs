#!/usr/bin/env node
// The dry run of P9: every box of every chapter copy, as the file has it,
// against the same box after the app's own open path under the Rust text
// engine. See src/lib/text-port-dryrun.realfont.test.js for what is run and
// lib/dry-report.mjs for what is written.
//
//   node scripts/text-port/dry-run.mjs --data <tp-data> --out <dir> [--legacy-mode smart|plain] [--load-fixtures yes]
//
// Reads `<data>/chapters/*.json` (copies), `<data>/fonts/` and Safari's
// capture `<data>/runs/ref-wk/base`. Writes only under `--out`:
//
//   report.html   the report, one file, pictures inside it
//   report.md     the same in text, pictures by path
//   totals.json   the counts
//   boxes.jsonl   one line per changed box (holds chapter text: keep it private)
//   sheets/       the same pictures, sixteen boxes to a sheet
//   raw/, img/    what the lane wrote
//
// `--legacy-mode` is what a chapter saved before it carried its own mode is
// opened with. It has no default, and the run stops at the first such chapter
// without it: the app opens that chapter with what this machine's typesetting
// switch said when the build that added the field first ran
// (`legacyTypesetting`, data.js), which no copy carries, and the two modes
// break lines differently. For the 13 copies it is `smart`, which is what the
// corpus was cut with; 5 of them have no mode of their own.
//
// Exit code: 0; 2 when the report cannot be signed as it stands - a box
// changed its x, width or size, a height shrank, a top edge moved without its
// height growing (gate G6, as pages or as a long strip), or a chapter was not
// opened because a page of it is repaired from its picture; 1 when the run
// failed (a stored box with no partner after the open and a box with text
// and no layout are failures: no report is written from them).
//
// `--load-fixtures yes` hands the Rust engine the repository's fixture fonts
// too, as fonts the user has loaded. They carry the names of two former
// built-ins (Bangers, Comic Neue), so this is the run that says what is left
// once those are loaded. Not the report to sign: the user's machine has no
// such files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { flags, root, dataDir } from './lib/common.mjs';
import { writeReport } from './lib/dry-report.mjs';

try {
  const args = flags(['--data', '--out', '--legacy-mode', '--report-only', '--load-fixtures', '--webkit-metrics']);
  if (!args.out) throw new Error('--out <dir> is required');
  const data = dataDir(args.data);
  const out = resolve(args.out);
  if (args['report-only'] !== 'yes') {
    // A run is whole or it is nothing: what a previous one left is removed.
    for (const part of ['raw', 'img', 'sheets', 'report.html', 'report.md', 'totals.json', 'boxes.jsonl']) rmSync(resolve(out, part), { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const run = spawnSync(
      `${root}node_modules/.bin/vitest`,
      ['run', '--project', 'realfont', 'src/lib/text-port-dryrun.realfont.test.js'],
      { cwd: root, env: { ...process.env, TP_DRYRUN: '1', TP_DATA: data, TP_OUT: out, TP_LEGACY_MODE: args['legacy-mode'] ?? '', TP_WEBKIT_METRICS: args['webkit-metrics'] ?? '', TP_LOAD_FIXTURES: args['load-fixtures'] === 'yes' ? '1' : '' }, stdio: 'inherit' },
    );
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`the dry run's lane failed (exit ${run.status})`);
  }
  const totals = await writeReport({ data, out });
  console.log(`dry run: ${out}/report.html`);
  console.log(JSON.stringify(totals.total));
  // G6: no box changes x, w or size on open, heights only grow, and a top
  // edge moves only with the height it belongs to - as pages and as a long
  // strip. And nothing can be said of a chapter that was not opened.
  if (totals.refused.length) console.error(`dry run: NOT OPENED: ${totals.refused.map((r) => r.chapter).join(', ')} (a page is repaired from its picture on open)`);
  if (totals.total.x || totals.total.w || totals.total.size || totals.total.shrank || totals.total.yAlone || totals.total.stripBreach || totals.refused.length) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
