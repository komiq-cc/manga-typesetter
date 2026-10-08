#!/usr/bin/env node
import path from 'node:path';
import { makeFakeRuns } from '../../src/test/text-port/compare/fixtures.js';

const args = process.argv.slice(2);
const root = args.shift();
let pixelCount = 3;
let variants = true;
try {
  if (!root) throw new Error('Usage: node scripts/text-port/fake-runs.mjs <out-dir> [--pixels <n>] [--passing-only]');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pixels' && /^\d+$/.test(args[i + 1] ?? '')) pixelCount = Number(args[++i]);
    else if (args[i] === '--passing-only') variants = false;
    else throw new Error('Unknown fake-runs option');
  }
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 3) throw new Error('--pixels must be at least 3');
  console.log(JSON.stringify(await makeFakeRuns(path.resolve(root), { pixelCount, variants }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 2; }
