#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { flags, dataDir, guardedPath, safeId, gitInfo } from './lib/common.mjs';

export { guardedPath } from './lib/common.mjs';
export function requestPath(data, method, raw) {
  // Decode BEFORE interpreting the route; URL normalisation would erase '..'.
  const path = decodeURIComponent(raw.split('?')[0]);
  if (method === 'GET' && /^\/(fonts|corpus)\//.test(path)) return guardedPath(data, path.slice(1));
  if (method === 'PUT' && path.startsWith('/runs/')) {
    const parts = path.slice(1).split('/');
    if (parts.length < 4) throw new Error('Expected /runs/<engine>/<runId>/<relative path>');
    safeId(parts[1]);
    safeId(parts[2]);
    return guardedPath(data, parts.join('/'));
  }
  throw new Error('Unsupported route');
}
// `origin` is the one page allowed to talk to the collector. It serves the
// user's own fonts and chapter text, and a browser lets any open web page ask
// a local port, so "any origin" would hand both to whatever site is open.
export function createCollector(data, { metadata = gitInfo(), log = console.log, origin = 'http://localhost:5173' } = {}) {
  return createServer(async (req, res) => {
    if (req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403).end(`Origin ${req.headers.origin} is not the capture page (${origin})`);
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      // The dev page cannot query git; capture provenance comes from this
      // read-only extension to the collector, never guessed in the browser.
      if (req.method === 'GET' && req.url === '/meta') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(metadata));
        return;
      }
      const target = requestPath(data, req.method, req.url);
      if (req.method === 'GET') {
        if (!statSync(target).isFile()) throw new Error('Expected a file');
        res.setHeader('Content-Type', target.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        await pipeline(createReadStream(target), res);
        return;
      }
      const append = new URL(req.url, 'http://127.0.0.1').searchParams.get('append') === '1';
      if (target.endsWith('/manifest.json') && append) throw new Error('Cannot append manifest');
      mkdirSync(dirname(target), { recursive: true });
      await pipeline(req, createWriteStream(target, { flags: append ? 'a' : 'w' }));
      if (target.endsWith('/manifest.json')) {
        const manifest = JSON.parse(readFileSync(target, 'utf8'));
        if (manifest.finishedAt) log(`text-port finished: ${manifest.engine}/${manifest.runId} ${JSON.stringify(manifest.counts)}`);
      }
      res.writeHead(204).end();
    } catch (error) {
      if (!res.destroyed) res.writeHead(error.code === 'ENOENT' ? 404 : 400).end(error.message);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = flags(['--data', '--port', '--origin']);
    const data = dataDir(args.data);
    const port = Number(args.port || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const origin = args.origin || 'http://localhost:5173';
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) throw new Error('--origin must be a local http origin');
    const server = createCollector(data, { origin });
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`text-port collector: http://127.0.0.1:${port} data=${data} origin=${origin}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
