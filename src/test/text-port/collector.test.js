import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedPath, requestPath, createCollector } from '../../../scripts/text-port/collector.mjs';

describe('collector path guard', () => {
  it('accepts only data-serving and run-upload routes', () => {
    expect(requestPath('/tmp/tp', 'GET', '/fonts/fonts.json')).toBe('/tmp/tp/fonts/fonts.json');
    expect(requestPath('/tmp/tp', 'GET', '/corpus/layout.json')).toBe('/tmp/tp/corpus/layout.json');
    expect(requestPath('/tmp/tp', 'PUT', '/runs/ref-cr/a/png/p.a.png?append=1')).toBe('/tmp/tp/runs/ref-cr/a/png/p.a.png');
    expect(() => requestPath('/tmp/tp', 'PUT', '/fonts/font.ttf')).toThrow();
    expect(() => requestPath('/tmp/tp', 'GET', '/runs/ref-cr/a/manifest.json')).toThrow();
  });
  it('rejects traversal, absolute paths, encoded separators and malformed ids', () => {
    for (const path of ['../escape', '/tmp/escape', 'fonts/../escape', 'fonts//escape', 'fonts/./escape', 'fonts\\escape', 'fonts/\0escape']) expect(() => guardedPath('/tmp/tp', path), path).toThrow();
    for (const path of ['/fonts/%2e%2e/escape', '/fonts/%2fetc/passwd', '/fonts/%5c..%5cescape', '/fonts/%00x', '/fonts/%ZZ']) expect(() => requestPath('/tmp/tp', 'GET', path), path).toThrow();
    for (const path of ['/runs/../a/x', '/runs/ref-cr/../x', '/runs/ref-cr/a/%2e%2e/x', '/runs/ref-cr/a//etc/passwd']) expect(() => requestPath('/tmp/tp', 'PUT', path), path).toThrow();
  });
  it('rejects symlinks that could escape the data directory', () => {
    const data = mkdtempSync(join(tmpdir(), 'tp-guard-'));
    try {
      mkdirSync(join(data, 'runs'));
      symlinkSync(tmpdir(), join(data, 'runs', 'escape'));
      expect(() => guardedPath(data, 'runs/escape/x')).toThrow('Symlink');
      symlinkSync(join(data, 'absent'), join(data, 'runs', 'dangling'));
      expect(() => guardedPath(data, 'runs/dangling')).toThrow('Symlink');
      expect(() => guardedPath(join(data, 'runs', 'escape'), 'x')).toThrow('Symlink');
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

// The collector hands out the user's fonts and chapter text. A browser lets
// any open web page ask a local port, so only the capture page may be answered.
describe('collector origin', () => {
  it('answers the capture page and no other origin', async () => {
    const data = mkdtempSync(join(tmpdir(), 'tp-origin-'));
    const server = createCollector(data, { metadata: { commit: 'x', dirty: false }, log: () => {}, origin: 'http://localhost:5199' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/meta`;
    try {
      const page = await fetch(url, { headers: { Origin: 'http://localhost:5199' } });
      expect(page.status).toBe(200);
      expect(page.headers.get('access-control-allow-origin')).toBe('http://localhost:5199');
      const other = await fetch(url, { headers: { Origin: 'https://example.com' } });
      expect(other.status).toBe(403);
      expect(other.headers.get('access-control-allow-origin')).toBeNull();
      // A local tool sends no Origin header and is not a web page.
      expect((await fetch(url)).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(data, { recursive: true, force: true });
    }
  });
});

// A capture page left open in a browser runs again whenever the dev server
// reloads it. It once wrote a third of a run over a finished reference.
describe('collector runs are written once', () => {
  it('refuses to overwrite data and refuses anything after the manifest', async () => {
    const data = mkdtempSync(join(tmpdir(), 'tp-once-'));
    const server = createCollector(data, { metadata: { commit: 'x', dirty: false }, log: () => {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/runs/ref-cr/a`;
    const put = (path, body) => fetch(`${base}/${path}`, { method: 'PUT', body });
    try {
      // The page starts each file empty, then appends.
      expect((await put('metrics.jsonl', '')).status).toBe(204);
      expect((await put('metrics.jsonl?append=1', '{"id":"m.a"}\n')).status).toBe(204);
      expect((await put('png/p.a.png', 'png')).status).toBe(204);
      // A second page starting the same run would empty the file: refused.
      const again = await put('metrics.jsonl', '');
      expect(again.status).toBe(409);
      expect(await again.text()).toMatch(/already has metrics\.jsonl/);
      expect((await put('png/p.a.png', 'other')).status).toBe(409);
      expect(readFileSync(join(data, 'runs/ref-cr/a/metrics.jsonl'), 'utf8')).toBe('{"id":"m.a"}\n');
      expect((await put('manifest.json', '{"engine":"ref-cr","runId":"a"}')).status).toBe(204);
      // Finished: nothing more, not even an append.
      expect((await put('metrics.jsonl?append=1', '{"id":"m.b"}\n')).status).toBe(409);
      expect((await put('layout.jsonl', '')).status).toBe(409);
      expect(readFileSync(join(data, 'runs/ref-cr/a/metrics.jsonl'), 'utf8')).toBe('{"id":"m.a"}\n');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(data, { recursive: true, force: true });
    }
  });
});
