#!/usr/bin/env node
import path from 'node:path';
import { makeFakeRuns } from '../../src/test/text-port/compare/fixtures.js';

const args = process.argv.slice(2);
const root = args.shift();
const options = { pixelCount: 3, metricCount: 2, layoutCount: 2, variants: true };
const counts = { '--pixels': 'pixelCount', '--metrics': 'metricCount', '--layout': 'layoutCount' };
try {
  if (!root) {
    throw new Error('Usage: node scripts/text-port/fake-runs.mjs <out-dir> [--pixels <n>] [--metrics <n>] [--layout <n>] [--passing-only] [--failing]');
  }
  for (let i = 0; i < args.length; i++) {
    const key = counts[args[i]];
    if (key && /^\d+$/.test(args[i + 1] ?? '')) {
      options[key] = Number(args[++i]);
    } else if (args[i] === '--passing-only') {
      options.variants = false;
    } else if (args[i] === '--failing') {
      options.failing = true;
    } else {
      throw new Error('Unknown fake-runs option');
    }
  }
  for (const [flag, key] of Object.entries(counts)) {
    const minimum = key === 'pixelCount' ? 3 : 2;
    if (!Number.isSafeInteger(options[key]) || options[key] < minimum) {
      throw new Error(`${flag} must be at least ${minimum}`);
    }
  }
  console.log(JSON.stringify(await makeFakeRuns(path.resolve(root), options), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
