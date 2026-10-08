#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { flags, root, dataDir, safeId, runIdNow } from './lib/common.mjs';

try {
  const args = flags(['--data', '--engine', '--run']);
  const env = { ...process.env, TP_CAPTURE: '1', TP_DATA: dataDir(args.data), TP_ENGINE: safeId(args.engine || 'ref-sk'), TP_RUN_ID: safeId(args.run || runIdNow()) };
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
