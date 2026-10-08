import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedPath, requestPath } from '../../../scripts/text-port/collector.mjs';

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
