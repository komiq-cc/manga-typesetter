import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFakeRuns } from './fixtures.js';

const cache = path.resolve('node_modules/.cache/text-port-test');
const run = (fixture, out, extra = []) => spawnSync(process.execPath, [
  'scripts/text-port/compare.mjs', fixture.before, fixture.pairs.pass,
  '--corpus', fixture.corpus, '--out', out,
  ...(extra.includes('--gates') ? [] : ['--gates', 'src/test/text-port/compare/strict-gates.json']), ...extra
], { encoding: 'utf8', timeout: 60000 });

async function rows(out, group) {
  const text = await readFile(path.join(out, 'cases', `${group}.jsonl`), 'utf8');
  return text.trim().split('\n').map(line => JSON.parse(line));
}

describe('scale, sampling and tag gates', () => {
  it('streams every case, caps failing assets, and lifts the cap explicitly', async () => {
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(path.join(cache, 'scale-'));
    try {
      const fixture = await makeFakeRuns(root, {
        metricCount: 20000, layoutCount: 2000, pixelCount: 300,
        variants: false, failing: true, uncoveredEvery: 10
      });
      const out = path.join(root, 'report');
      const result = run(fixture, out, ['--limit', '5']);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.split('\n').length).toBeLessThanOrEqual(40);
      const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
      expect(report).not.toHaveProperty('cases');
      for (const [group, count] of Object.entries({ metrics: 20000, layout: 2000, pixels: 300 })) {
        const full = await rows(out, group);
        expect(full).toHaveLength(count);
        for (const row of full) {
          expect(row).not.toHaveProperty('before');
          expect(row).not.toHaveProperty('after');
          if (row.numbers) {
            expect(Array.isArray(row.numbers)).toBe(false);
            for (const field of Object.keys(row.numbers)) expect(field).not.toMatch(/glyphs\.[^.]+\.|\[\d+\]/);
          }
        }
        expect(new Set(full.map(item => item.id)).size).toBe(count);
      }
      expect(report.assets.pixelCases).toBe(5);
      expect(await readdir(path.join(out, 'img'))).toHaveLength(25);
      const metrics = await rows(out, 'metrics');
      expect(metrics.find(item => item.tags.includes('uncovered')).gates).toContain('metrics.advance.uncovered');
      expect(metrics.find(item => item.tags.includes('uncovered')).gates).not.toContain('metrics.advance');
      const covered = report.gates.find(gate => gate.id === 'metrics.advance');
      expect(covered).toMatchObject({ count: 18000, failures: 18000, exceptionCount: 18000, exceptionsTruncated: true });
      expect(covered.exceptions).toHaveLength(2000);
      expect(report.gates.find(gate => gate.id === 'metrics.advance.uncovered')).toMatchObject({ count: 2000, failures: 2000, enforce: false });
      expect(report.byTag.metrics.find(row => row.tag === 'covered')).toMatchObject({ cases: 18000 });
      expect(report.byTag.metrics.find(row => row.tag === 'uncovered').gates['metrics.advance.uncovered']).toMatchObject({ failures: 2000, quantity: { p50: 2, p99: 2, max: 2 } });
      for (const file of ['report.json', 'report.html']) expect((await stat(path.join(out, file))).size).toBeLessThan(5 * 1024 * 1024);
      const html = await readFile(path.join(out, 'report.html'), 'utf8');
      expect(html).toContain('rows are a sample');
      expect(html).toContain('cases/metrics.jsonl');
      const data = JSON.parse(html.match(/id="data">([\s\S]*?)<\/script>/)[1]);
      expect(data).toHaveLength(15);
      // Reuse the output directory to ensure old assets cannot violate a cap.
      const all = run(fixture, out, ['--limit', '0', '--assets', 'all']);
      expect(all.status, all.stderr).toBe(1);
      expect(await readdir(path.join(out, 'img'))).toHaveLength(1500);
      const zero = run(fixture, out, ['--limit', '0']);
      expect(zero.status, zero.stderr).toBe(1);
      expect(await readdir(path.join(out, 'img'))).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
