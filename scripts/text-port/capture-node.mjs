#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { flags, root, dataDir, safeId, runIdNow } from './lib/common.mjs';

try {
  // --rules boldAdvance=webkit,...  rule switches of the Rust engine (`new` only)
  // --only layout,...             a partial run for looking at one kind; not a capture to compare gates on
  const args = flags(['--data', '--engine', '--run', '--rules', '--only']);
  const env = {
    ...process.env, TP_CAPTURE: '1', TP_DATA: dataDir(args.data), TP_ENGINE: safeId(args.engine || 'ref-sk'), TP_RUN_ID: safeId(args.run || runIdNow()),
    TP_RULES: args.rules ?? '', TP_ONLY: args.only ?? '',
  };
  const run = spawnSync(
    `${root}node_modules/.bin/vitest`,
    ['run', '--project', 'realfont', 'src/lib/text-port-capture.realfont.test.js'],
    { cwd: root, env, stdio: 'inherit' },
  );
  if (run.error) console.error(run.error.message);
  process.exitCode = run.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
