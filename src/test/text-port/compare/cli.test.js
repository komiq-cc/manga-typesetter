import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { makeFakeRuns } from './fixtures.js';
import { readRun, readCorpus, readJson, loadAlpha } from './io.js';
import { compareRuns } from './compare.js';
import { parseArgs } from '../../../../scripts/text-port/compare.mjs';

let root;
let fixture;
let gates;
const cli = (script, args) => spawnSync(process.execPath, [`scripts/text-port/${script}.mjs`, ...args], { encoding: 'utf8', timeout: 30000 });
// The tool's own tests judge with every gate enforced at its tightest. The
// project's gates.json is calibrated from real captures and changes with them.
const STRICT_GATES = 'src/test/text-port/compare/strict-gates.json';
async function compare(name, extra = []) {
  const out = path.join(root, `report-${name}`);
  const gateArgs = extra.includes('--gates') ? [] : ['--gates', STRICT_GATES];
  const result = cli('compare', [fixture.before, fixture.pairs[name] ?? path.join(root, name), '--corpus', fixture.corpus, '--out', out, '--limit', '1', ...gateArgs, ...extra]);
  const report = result.status === 2 ? null : JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
  const cases = report ? (await Promise.all(['metrics', 'layout', 'pixels'].map(async group => {
    const text = await readFile(path.join(out, 'cases', `${group}.jsonl`), 'utf8');
    return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
  }))).flat() : [];
  return { result, report, cases, out };
}
async function modify(name, group, change) {
  const dir = path.join(root, name);
  await cp(fixture.pairs.pass, dir, { recursive: true });
  const file = path.join(dir, `${group}.jsonl`);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  change(records);
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.counts[group] = records.length;
  manifest.counts.errors = records.filter(record => record.error !== undefined).length;
  manifest.counts.skipped = records.filter(record => record.skip !== undefined).length;
  await writeFile(manifestFile, JSON.stringify(manifest));
  return dir;
}

beforeAll(async () => {
  const cache = path.resolve('node_modules/.cache/text-port-test');
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(path.join(cache, 'unit-'));
  fixture = await makeFakeRuns(root);
  gates = await readJson(STRICT_GATES);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('complete CLI', () => {
  it('passes a fake pair and writes escaped, self-contained HTML with a valid inline script', async () => {
    const { result, report, cases, out } = await compare('pass');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Overall: PASS');
    expect(report.summary.pixels.compared).toBe(3);
    expect(report.assets.pixelCases).toBe(1);
    const html = await readFile(path.join(out, 'report.html'), 'utf8');
    expect(html).toContain('Show 100 more');
    expect(html).toContain('Start flicker');
    expect(html).not.toMatch(/<script[^>]*src=|<link[^>]*href=|https?:\/\//);
    expect(() => new vm.Script(html.match(/<script>\n([\s\S]*?)<\/script>/)[1])).not.toThrow();
    const item = cases.find(item => item.images);
    for (const relative of Object.values(item.images)) expect((await readFile(path.join(out, relative))).length).toBeGreaterThan(0);
  });
  it.each([['advance', 'metrics.advance'], ['lines', 'layout.smart-lines'], ['blob', 'pixels.thick'], ['shift', 'pixels.bbox'], ['missing', 'capture.missing'], ['hash', 'capture.hashes']])('fails %s with exactly the expected enforced gate %s', async (name, expected) => {
    const { result, report, cases, out } = await compare(name);
    expect(result.status, result.stderr).toBe(1);
    expect(report.gates.filter(gate => gate.enforce && !gate.pass).map(gate => gate.id)).toEqual([expected]);
    expect(result.stdout).toMatch(new RegExp(`${expected.replaceAll('.', '\\.')}\\s+FAIL`));
    if (name === 'blob' || name === 'shift') expect(cases.find(item => item.gates.includes(expected)).images).toBeDefined();
    if (name === 'hash') expect(await readFile(path.join(out, 'report.html'), 'utf8')).toContain('MEANINGLESS COMPARISON');
  });
  it('counts and lists skips, and one-sided skips do not fail', async () => {
    await modify('skips', 'metrics', records => { records[0] = { id: records[0].id, skip: 'unsupported' }; });
    const { result, report, cases } = await compare('skips');
    expect(result.status, result.stderr).toBe(0);
    expect(report.summary.metrics).toMatchObject({ 'skip-mismatch': 1, skippedAfter: 1, skippedBefore: 0 });
    expect(cases.find(item => item.status === 'skip-mismatch').skipReasons.after).toBe('unsupported');
  });
  it('makes any capture error fail the run', async () => {
    await modify('errors', 'metrics', records => { records[0] = { id: records[0].id, error: 'font missing' }; });
    const { result, report, cases } = await compare('errors');
    expect(result.status).toBe(1);
    expect(report.gates.find(gate => gate.id === 'capture.errors').pass).toBe(false);
    expect(cases.find(item => item.status === 'error').gates).toContain('capture.errors');
  });
  it('respects a zero image limit even for gate failures', async () => {
    const out = path.join(root, 'zero-limit');
    const result = cli('compare', [fixture.before, fixture.pairs.blob, '--corpus', fixture.corpus, '--out', out, '--limit', '0', '--gates', STRICT_GATES]);
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
    expect(report.assets.pixelCases).toBe(0);
  });
  it('reports missing/null numeric fields rather than skipping them', async () => {
    await modify('nulls', 'metrics', records => { records[0].adv = null;
      delete records[0].font.descent;
      records[0].chars.pop(); });
    const { result, report, cases } = await compare('nulls');
    expect(result.status).toBe(1);
    expect(cases.find(item => item.id === 'm.fake.0').numbers).toMatchObject({ adv: 'Infinity', 'font.descent': 'Infinity', chars: 'Infinity' });
  });
  it('report-only gates never fail an otherwise valid pair', async () => {
    const config = structuredClone(gates);
    config.gates.find(gate => gate.id === 'metrics.advance').enforce = false;
    const file = path.join(root, 'report-only.json');
    await writeFile(file, JSON.stringify(config));
    const { result, report, cases } = await compare('advance', ['--gates', file]);
    expect(result.status).toBe(0);
    expect(report.gates.find(gate => gate.id === 'metrics.advance')).toMatchObject({ pass: false, enforce: false });
  });
  it('returns input-error exit 2 for usage errors, duplicates and bad PNG metadata', async () => {
    expect(cli('compare', []).status).toBe(2);
    expect(cli('compare', [fixture.before, fixture.pairs.pass, '--limit', '-1']).status).toBe(2);
    expect(cli('compare', [fixture.before, fixture.pairs.pass, '--wat', 'x']).status).toBe(2);
    await modify('duplicates', 'metrics', records => { records.push(records[0]); });
    const duplicate = await compare('duplicates');
    expect(duplicate.result.status).toBe(2);
    expect(duplicate.result.stderr).toContain('duplicate id');
    await modify('bad-bbox', 'pixels', records => { records[0].bbox[0]++; });
    const bbox = await compare('bad-bbox');
    expect(bbox.result.status).toBe(2);
    expect(bbox.result.stderr).toContain('recorded bbox');
  });
  it('reads corpus metadata, compares exactly preserved alpha, and uses prefix fallback', async () => {
    const before = await readRun(fixture.before);
    const after = await readRun(fixture.pairs.pass);
    const corpus = await readCorpus(fixture.corpus);
    expect(corpus.pixels.get('p.fake.1').size).toBe(12);
    expect([...((await loadAlpha(before, before.pixels.get('p.fake.0'))).alpha)].filter(a => a > 0)).toEqual(Array(35).fill(255));
    const unfiltered = structuredClone(gates);
    for (const gate of unfiltered.gates) {
      delete gate.excludeTags;
      delete gate.onlyTags;
    }
    const report = await compareRuns(before, after, { gates: unfiltered });
    expect(report.cases.find(item => item.id === 'p.fake.0').font).toBe('p');
    expect(report.gates.find(gate => gate.id === 'pixels.iou').unknownSize).toHaveLength(3);
  });
  it('rejects tag-aware gates without a corpus with exit 2', () => {
    const result = cli('compare', [fixture.before, fixture.pairs.pass, '--out', path.join(root, 'no-corpus')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Tag selectors require --corpus');
  });
  it('rejects stale error counts in a manifest', async () => {
    const dir = await modify('stale-errors', 'metrics', records => {
      records[0] = { id: records[0].id, error: 'capture error' };
    });
    const file = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.counts.errors = 0;
    await writeFile(file, JSON.stringify(manifest));
    const result = cli('compare', [dir, dir, '--corpus', fixture.corpus, '--out', path.join(root, 'stale-errors-report')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('manifest counts.errors');
  });
  it('builds every reference pair and supports within-envelope and annotation in the compare CLI', async () => {
    const file = path.join(root, 'envelope.json');
    const result = cli('envelope', [fixture.before, fixture.pairs.pass, fixture.pairs.advance, '--out', file]);
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    expect(envelope.pairs).toBe(3);
    expect(envelope.metrics['metrics.adv'].max).toBe(0.5);
    expect(envelope.metrics['pixels.iou'].loss.max).toBe(0);
    const custom = structuredClone(gates);
    custom.gates = custom.gates.filter(gate => gate.id !== 'metrics.advance');
    custom.gates.push({ id: 'advance.envelope', rule: 'within-envelope', group: 'metrics', field: 'adv', why: 'Reference spread', enforce: true });
    const gatesFile = path.join(root, 'envelope-gates.json');
    await writeFile(gatesFile, JSON.stringify(custom));
    const compared = await compare('advance', ['--envelope', file, '--gates', gatesFile]);
    expect(compared.result.status, compared.result.stderr).toBe(0);
    expect(compared.result.stdout).toContain('envelope max ratios');
    expect(compared.report.gates.find(gate => gate.id === 'advance.envelope').envelope[0].reference.max).toBe(0.5);
    expect(compared.report.referenceEnvelope.pairs).toBe(3);
    expect(compared.result.stdout).toContain('envelope: no comparable metric');
    envelope.runs[0].manifest.fonts = 'unrelated fonts';
    await writeFile(file, JSON.stringify(envelope));
    const unrelated = await compare('pass', ['--envelope', file]);
    expect(unrelated.result.status).toBe(2);
    expect(unrelated.result.stderr).toContain('Envelope font/corpus hashes');
    expect(cli('envelope', [fixture.before, fixture.pairs.hash, '--out', file]).status).toBe(2);
  });
  it('parses options in any position without accepting duplicate flags', () => {
    expect(parseArgs(['--limit', '0', 'a', '--out', 'out', 'b'])).toMatchObject({ positional: ['a', 'b'], out: 'out', limit: 0 });
    expect(() => parseArgs(['a', 'b', '--limit', '1', '--limit', '2'])).toThrow('Usage:');
  });
  it('rejects stale manifest counts so common dropped JSONL rows cannot silently pass', async () => {
    const dir = await modify('stale-counts', 'metrics', records => { records.pop(); });
    const file = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.counts.metrics++;
    await writeFile(file, JSON.stringify(manifest));
    const result = cli('compare', [dir, dir, '--corpus', fixture.corpus, '--out', path.join(root, 'stale-counts-report')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('manifest counts.metrics');
  });
});
