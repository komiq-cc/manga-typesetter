#!/usr/bin/env node
// Direct WebKit metrics for the existing Safari layout's exact lines. Reads
// only tp-data COPIES. The output and private HTML (which includes font bytes)
// stay outside the repository. Use a NEW output path for each measured run:
// node scripts/text-port/dry-metrics.mjs --data <tp-data> --out <private-json>
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { flags, dataDir, guardedPath, root, sha256 } from './lib/common.mjs';
import { metricKey } from './lib/dry-metrics.mjs';

const args = flags(['--data', '--out']);
if (!args.out) throw new Error('--out <private-json> is required');
const data = dataDir(args.data);
const out = resolve(args.out);
if (out.startsWith(root) || existsSync(out)) throw new Error('direct metrics need a new private output path outside the repository');
const sources = {};
const read = (path) => { const bytes = readFileSync(guardedPath(data, path)); sources[path] = sha256(bytes); return bytes; };
const corpus = JSON.parse(read('corpus/layout.json')).cases;
const layouts = new Map(read('runs/ref-wk/base/layout.jsonl').toString().split('\n').filter(Boolean).map((s) => JSON.parse(s)).map((r) => [r.id, r]));
const fontList = JSON.parse(read('fonts/fonts.json')).fonts;
const requests = new Map();
for (const c of corpus) {
  const lines = layouts.get(c.id)?.lines;
  const s = c.box?.style;
  if (!c.id.startsWith('c.') || !s || !Array.isArray(lines)) continue;
  for (const text of lines) { const key = metricKey(s, text); if (!requests.has(key)) requests.set(key, { key, text, font: s.font, bold: !!s.bold, italic: !!s.italic, size: s.size, spacing: Number(s.letterSpacing) || 0 }); }
}
const needed = new Set([...requests.values()].map((r) => r.font));
const faces = fontList.filter((f) => needed.has(f.family)).map((f) => {
  const bytes = read(`fonts/${f.file}`);
  if (sha256(bytes) !== f.sha256) throw new Error(`font hash mismatch: ${f.family}/${f.slot}`);
  return { family: f.family, slot: f.slot, sha256: f.sha256, file: f.file, base64: bytes.toString('base64') };
});
for (const family of needed) if (!faces.some((f) => f.family === family)) throw new Error(`no local FontFace records for ${family}; direct metrics must not use an unnamed fallback`);
const payload = JSON.stringify({ requests: [...requests.values()], faces }).replace(/</g, '\\u003c');
const scratch = mkdtempSync(`${dirname(out)}/direct-webkit-`);
try {
  const html = `${scratch}/metrics.html`;
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><script>
const {requests,faces}=${payload};
window.__done=false;
window.__out={complete:false,errors:[],records:[]};
(async()=>{
 try {
  for(const f of faces){
   const descriptors={weight: f.slot==='bold'||f.slot==='boldItalic'?'700':'400',style:f.slot==='italic'||f.slot==='boldItalic'?'italic':'normal'};
   const face=new FontFace(f.family,'url(data:font/sfnt;base64,'+f.base64+')',descriptors);
   await face.load(); document.fonts.add(face);
   if(face.status!=='loaded'||!document.fonts.has(face))throw new Error('FontFace failed: '+f.family+'/'+f.slot);
  }
  await document.fonts.ready;
  const ctx=document.createElement('canvas').getContext('2d');
  ctx.textAlign='left';ctx.textBaseline='alphabetic';
  for(const r of requests){
   const family='"'+r.font.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"')+'"';
   const css=(r.italic?'italic ':'')+(r.bold?'700':'400')+' '+r.size+'px '+family;
   if(!faces.some(f=>f.family===r.font))throw new Error('no loaded local family: '+r.font);
   if(!document.fonts.check(css,r.text))throw new Error('font not ready: '+r.key);
   ctx.font=css;
   const f=ctx.measureText('Hg'), k=ctx.measureText(r.text);
   const metrics={font:{ascent:f.fontBoundingBoxAscent,descent:f.fontBoundingBoxDescent},ink:{ascent:k.actualBoundingBoxAscent,descent:k.actualBoundingBoxDescent,width:k.width,left:k.actualBoundingBoxLeft,right:k.actualBoundingBoxRight}};
   if(!Object.values(metrics.font).concat(Object.values(metrics.ink)).every(Number.isFinite))throw new Error('nonfinite metrics: '+r.key);
   window.__out.records.push({key:r.key,request:r,css,faces:faces.filter(f=>f.family===r.font).map(({family,slot,sha256,file})=>({family,slot,sha256,file})),metrics});
  }
  window.__out.complete=true;
 } catch(e){window.__out.errors.push(String(e?.message??e));}
 window.__done=true;
})();</script>`);
  const executable = `${scratch}/capture`;
  const build = spawnSync('swiftc', [`${root}scripts/text-port/dry-metrics-webkit.swift`, '-o', executable], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || 'Swift build failed');
  const capture = spawnSync(executable, [html], { encoding: 'utf8', timeout: 130000, maxBuffer: 64 * 1024 * 1024 });
  if (capture.status !== 0) throw new Error(capture.stdout || capture.stderr || 'WebKit capture failed');
  const result = JSON.parse(capture.stdout);
  if (!result.complete || result.errors.length || result.records.length !== requests.size) throw new Error('incomplete WebKit metrics');
  writeFileSync(out, JSON.stringify({ schema: 1, engine: 'system-webkit', measurementContract: 'browser.js fontBox/lineInk: alphabetic canvas measureText without letterSpacing; measure.js adds horizontal spacing only, so raw vertical ink metrics match. The named family is loaded from these FontFace bytes; WebKit may borrow individual missing glyphs. The dry report excludes missing/borrowing boxes from rule3/4 attribution.', sources, ...result }, null, 2) + '\n');
  console.log(`direct WebKit metrics: ${result.records.length} requests; ${out}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
