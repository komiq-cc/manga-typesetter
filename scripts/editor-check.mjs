#!/usr/bin/env node
// Drives the editor check page (editor-check.html, src/test/editor-check/host.js)
// in a headless Chromium over the DevTools protocol, and writes what it saw.
//
//   npm run dev -- --port 5201 --strictPort          (in another shell)
//   node scripts/editor-check.mjs --data <tp-data> [--url http://localhost:5201]
//        [--out <tp-data>/reports/p6] [--only bytes,export,look,edit,cost,real,near,hits,mask,limits,ink,drag,type,type2,typecost]
//        [--chapter tsukimichi__121] [--chrome <path>] [--port 9377]
//
// No dependency is added for this: the protocol is spoken over node's own
// WebSocket, and pictures are read with @napi-rs/canvas, which the test lanes
// already use. `--data` is the directory the text-port harness keeps the
// user's fonts and chapter copies in; it is only read, through a server bound
// to 127.0.0.1 that answers the check page's origin and nobody else, and the
// one place written is `--out`.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : acc), []),
);
const URL_BASE = (args.url ?? 'http://localhost:5201').replace(/\/$/, '');
const DATA = args.data ? resolve(args.data) : null;
const OUT = resolve(args.out ?? (DATA ? join(DATA, 'reports', 'p6') : 'editor-check-out'));
const ONLY = new Set((args.only ?? 'bytes,export,look,edit,cost,real,near,hits,mask,limits,ink,drag,type,type2,typecost').split(','));
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(args.port ?? 9377);
const CHAPTER = args.chapter ?? 'tsukimichi__121';
// The display's density: the browser is started as a display of it, and
// every step runs at it. Not the DevTools emulation's `deviceScaleFactor`: an
// emulated 2x display lays out and snaps in CSS px and scales afterwards,
// which a real one does not, and a canvas set on a half CSS px is shown a
// device pixel off or resampled there (measured, Chrome 155: 1 of 25 pictures
// pixel for pixel at zoom 137% emulated, 25 of 25 real).
const DSF = Number(args.dsf ?? 2);
const atDensity = (list, at = (row) => row[1]) => list.filter((row) => at(row) === DSF);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---- the browser ----
const profile = mkdtempSync(join(tmpdir(), 'editor-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1600,1000', `--force-device-scale-factor=${DSF}`, 'about:blank',
], { stdio: 'ignore' });
let closing = false;
function cleanup() {
  if (closing) return;
  closing = true;
  try {
    chrome.kill();
  } catch {
    /* gone already */
  }
  dataServer?.close();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300).unref?.();
}
process.on('exit', cleanup);
process.on('SIGINT', () => (cleanup(), process.exit(130)));

async function connect() {
  let target;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  if (!target) throw new Error('Chromium did not open a page to debug');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    waiting.set(++id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, errors };
}

const cdp = await connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

// The page function `window.__ec[name](...args)`, awaited, by value.
async function ec(name, ...a) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `window.__ec[${JSON.stringify(name)}](...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
// A window of this size, CSS px. `dpr` is given only by the one step that
// checks a display changing under the page.
async function viewport(width, height, dpr = 0) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: dpr, mobile: false });
  await sleep(150);
}
async function load() {
  await cdp.send('Page.navigate', { url: `${URL_BASE}/editor-check.html` });
  for (let i = 0; i < 300; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    if (r.result.value === 'ec ready') return;
    await sleep(100);
  }
  throw new Error(`the check page did not come up at ${URL_BASE}/editor-check.html: ${cdp.errors.slice(-3).join(' | ')}`);
}

// ---- pictures ----
async function decode(buffer) {
  const img = await loadImage(buffer);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data, canvas: c };
}
// A screenshot of a CSS-px rectangle, in device px.
async function shot(rect) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 }, captureBeyondViewport: false });
  return decode(Buffer.from(r.data, 'base64'));
}
const fromDataUrl = (url) => decode(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.min(img.w - x, Math.round(w));
  h = Math.min(img.h - y, Math.round(h));
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(img.canvas, x, y, w, h, 0, 0, w, h);
  return { w, h, data: c.getContext('2d').getImageData(0, 0, w, h).data, canvas: c };
}
// Averaged down by a whole factor, as a compositor shows a supersampled page.
function shrink(img, k) {
  const w = Math.floor(img.w / k);
  const h = Math.floor(img.h / k);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 4; ch++) {
        let s = 0;
        for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += img.data[((y * k + j) * img.w + x * k + i) * 4 + ch];
        out.data[(y * w + x) * 4 + ch] = Math.round(s / (k * k));
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return { w, h, data: out.data, canvas: c };
}
// The box of pixels that are not paper; with `dark`, of the near-black ones
// only, which leaves the editor's coloured selection chrome out.
function inkBox(img, dark = false) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (dark ? img.data[i] > 110 || img.data[i + 1] > 110 || img.data[i + 2] > 110 : img.data[i] > 235 && img.data[i + 1] > 235 && img.data[i + 2] > 235) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return n ? { x0, y0, x1: x1 + 1, y1: y1 + 1, n } : null;
}
// Two pictures of one size on paper: the mean and the worst channel
// difference over the pixels either one inked, and how much of the ink that is.
function compare(a, b) {
  const w = Math.min(a.w, b.w);
  const h = Math.min(a.h, b.h);
  let sum = 0, n = 0, worst = 0, over32 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.w + x) * 4;
      const j = (y * b.w + x) * 4;
      const paperA = a.data[i] > 250 && a.data[i + 1] > 250 && a.data[i + 2] > 250;
      const paperB = b.data[j] > 250 && b.data[j + 1] > 250 && b.data[j + 2] > 250;
      if (paperA && paperB) continue;
      const d = Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2]));
      sum += d;
      n++;
      if (d > worst) worst = d;
      if (d > 32) over32++;
    }
  }
  return { inked: n, mean: n ? +(sum / n).toFixed(2) : 0, worst, over32: n ? +((over32 / n) * 100).toFixed(2) : 0 };
}
const offsets = (a, b, per = 1) => (a && b ? {
  left: +((b.x0 - a.x0) / per).toFixed(2), top: +((b.y0 - a.y0) / per).toFixed(2), right: +((b.x1 - a.x1) / per).toFixed(2), bottom: +((b.y1 - a.y1) / per).toFixed(2),
  cx: +(((b.x0 + b.x1) / 2 - (a.x0 + a.x1) / 2) / per).toFixed(2), cy: +(((b.y0 + b.y1) / 2 - (a.y0 + a.y1) / 2) / per).toFixed(2),
} : null);
const save = (name, canvas) => writeFileSync(join(OUT, name), canvas.toBuffer('image/png'));
// Labelled pairs, one row a box: [label, left picture, right picture].
function sheet(name, rows, heads) {
  const pad = 12;
  const label = 26;
  const w = pad + rows.reduce((m, r) => Math.max(m, r[1].w + pad + r[2].w), 0) + pad;
  const h = pad + label + rows.reduce((s, r) => s + label + Math.max(r[1].h, r[2].h) + pad, 0);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.font = '16px sans-serif';
  ctx.fillText(heads, pad, pad + 14);
  let y = pad + label;
  for (const [text, a, b] of rows) {
    ctx.fillStyle = '#000';
    ctx.fillText(text, pad, y + 16);
    y += label;
    ctx.drawImage(a.canvas, pad, y);
    ctx.drawImage(b.canvas, pad + a.w + pad, y);
    y += Math.max(a.h, b.h) + pad;
  }
  save(name, c);
}

// ---- the user's fonts and chapters, read-only, for the check page alone ----
let dataServer = null;
let dataBase = null;
if (DATA) {
  const origin = new URL(URL_BASE).origin;
  dataServer = createServer((req, res) => {
    if (req.headers.origin && req.headers.origin !== origin) return void res.writeHead(403).end();
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);
    const file = resolve(DATA, `.${path}`);
    const ok = req.method === 'GET' && /^\/(fonts|chapters)\/[^/]+$/.test(path) && file.startsWith(DATA + sep) && existsSync(file) && statSync(file).isFile();
    if (!ok) return void res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => dataServer.listen(0, '127.0.0.1', r));
  dataBase = `http://127.0.0.1:${dataServer.address().port}`;
}

// ---- the run ----
const report = { url: URL_BASE, displayDensity: DSF, started: new Date().toISOString() };
const cellOf = (b, f, z, margin = 44) => ({ x: f.x + (b.page.x - margin) * z, y: f.y + (b.page.y - margin) * z, w: (b.page.w + margin * 2) * z, h: (b.page.h + margin * 2) * z });

await viewport(1800, 1700);
await load();
report.boot = await ec('boot');
report.fonts = await ec('addFixtureFonts');
const opened = await ec('openSynthetic');
log('opened the synthetic chapter:', JSON.stringify(opened), 'engine wasm in this build:', report.boot.available);
if (!report.boot.available) throw new Error('the wasm is not built: npm run build:engine');
const PAGE = { w: 5 * 310, h: Math.ceil(opened.boxes[0] / 5) * 230 };
// A viewport that holds the whole page at this zoom, so every box is on screen.
const fit = (z) => viewport(PAGE.w * z + 240, PAGE.h * z + 240);

if (ONLY.has('bytes')) {
  // 1. With the switch off: DOM. With it on: one canvas per box, and its bytes
  //    are `renderBoxTexture`'s at the same scale.
  report.off = await ec('engine', 'browser');
  await fit(1);
  await ec('zoom', 1);
  const offRects = await ec('rects');
  report.offBoxes = offRects.boxes.map((b) => ({ id: b.id, dom: b.dom, canvas: b.canvas?.painter ?? (b.canvas ? 'old' : null) }));
  report.on = await ec('engine', 'rust');
  log('switch on:', JSON.stringify(report.on));
  report.bytes = [];
  for (const [z, dpr] of atDensity([[1, 1], [1.37, 1], [3, 1], [1, 2], [0.5, 2], [1.37, 2], [1.5, 2]])) {
    await fit(z);
    await ec('zoom', z);
    const rows = await ec('sameAsExporter');
    const align = await ec('alignment');
    const bad = rows.filter((r) => !r.painted || r.bytes !== 0 || r.editor?.[0] !== r.exporter?.[0]);
    report.bytes.push({ zoom: z, dpr, scale: z * dpr, boxes: rows.length, identical: rows.filter((r) => r.painted && r.bytes === 0).length, different: bad, alignment: align });
    // The screen itself: the canvas's own pixels laid over paper, against a
    // screenshot, where the layout says the canvas is and a pixel either side.
    const pics = await ec('pictures');
    const screen = await shot({ x: 0, y: 0, w: PAGE.w * z + 240, h: PAGE.h * z + 240 });
    const onScreen = [];
    for (const pic of pics.filter((q) => q.plain)) {
      const tex = await fromDataUrl(pic.url);
      let best = null;
      for (const dy of [0, -1, 1]) {
        for (const dx of [0, -1, 1]) {
          const x0 = Math.round(pic.x) + dx;
          const y0 = Math.round(pic.y) + dy;
          let sum = 0, n = 0, unlike = 0;
          for (let y = 0; y < tex.h; y++) {
            for (let x = 0; x < tex.w; x++) {
              const i = (y * tex.w + x) * 4;
              const al = tex.data[i + 3];
              if (!al) continue;
              const j = ((y0 + y) * screen.w + x0 + x) * 4;
              let d = 0;
              for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(Math.round((tex.data[i + k] * al + 255 * (255 - al)) / 255) - screen.data[j + k]));
              sum += d;
              n++;
              if (d > 2) unlike++;
            }
          }
          const mean = n ? sum / n : 0;
          if (!best || mean < best.mean) best = { dx, dy, mean: +mean.toFixed(3), unlike, inked: n };
        }
      }
      onScreen.push({ id: pic.id, fraction: [+(pic.x % 1).toFixed(3), +(pic.y % 1).toFixed(3)], ...best });
    }
    const exact = onScreen.filter((r) => r.dx === 0 && r.dy === 0 && r.mean < 0.5);
    report.bytes.at(-1).onScreen = onScreen;
    log(`   on screen: ${exact.length}/${onScreen.length} upright pictures shown pixel for pixel`, JSON.stringify(onScreen.filter((r) => !exact.includes(r)).slice(0, 4)));
    const off = align.filter((a) => !a.turned && (Math.min(a.offX, 1 - a.offX) > 0.01 || Math.min(a.offY, 1 - a.offY) > 0.01 || Math.abs(a.scaleX - 1) > 1e-3));
    log(`zoom ${z} dpr ${dpr}: ${rows.length - bad.length}/${rows.length} canvases byte-identical to renderBoxTexture; ${off.length} upright canvases off the device grid`, bad.length ? JSON.stringify(bad.slice(0, 3)) : '', off.length ? JSON.stringify(off.slice(0, 3)) : '');
  }
}

if (ONLY.has('bytes') && DSF === 1) {
  // The window dragged to a display of another density: the pictures follow.
  // (Emulated, so only the repaint is looked at here, not where it lands.)
  await ec('zoom', 1);
  const before = (await ec('sameAsExporter')).map((r) => r.editor?.[0]);
  await viewport(PAGE.w + 250, PAGE.h + 240, 2);
  await sleep(300);
  const rows = await ec('sameAsExporter');
  await viewport(PAGE.w + 240, PAGE.h + 240);
  await sleep(300);
  const after = (await ec('sameAsExporter')).map((r) => r.editor?.[0]);
  report.densityChange = {
    scaleFollowed: rows.every((r) => r.scale >= 2 && r.painted && r.bytes === 0),
    widths: { at1x: before.slice(0, 3), at2x: rows.slice(0, 3).map((r) => r.editor?.[0]), backAt1x: after.slice(0, 3) },
  };
  log('display density 1 -> 2 -> 1:', JSON.stringify(report.densityChange));
}

if (ONLY.has('export')) {
  // 2. The editor, as the screen shows it, against the export of the page.
  await ec('engine', 'rust');
  report.export = {};
  for (const dpr of atDensity([1, 2], (d) => d)) {
    await fit(1);
    await ec('zoom', 1);
    const rects = await ec('rects');
    const f = rects.frame;
    const screen = await shot(f);
    const exported = await fromDataUrl((await ec('exportPng', 2)).url);
    const file = dpr === 1 ? shrink(exported, 2) : exported;
    save(`editor-on-100-${dpr}x.png`, screen.canvas);
    save(`export-for-${dpr}x.png`, file.canvas);
    const rows = [];
    const pairs = [];
    for (const b of rects.boxes) {
      const c = cellOf(b, { x: 0, y: 0 }, dpr);
      const a = crop(screen, c.x, c.y, c.w, c.h);
      const e = crop(file, c.x, c.y, c.w, c.h);
      rows.push({ id: b.id, ...compare(a, e), ink: offsets(inkBox(e), inkBox(a)) });
      if (rows.at(-1).worst > 8) pairs.push([`${b.id}   (mean ${rows.at(-1).mean}, worst ${rows.at(-1).worst} of 255)`, e, a]);
    }
    for (let i = 0; i < pairs.length; i += 6) sheet(`export-${dpr}x-${String(i / 6 + 1).padStart(2, '0')}.png`, pairs.slice(i, i + 6), `zoom 100%, ${dpr}x display, the boxes that differ: export${dpr === 1 ? ' (2x, averaged down)' : ' (2x)'} left, editor with the switch ON right`);
    report.export[`dpr${dpr}`] = rows;
    log(`editor screenshot (zoom 1, dpr ${dpr}) against the 2x export${dpr === 1 ? ' averaged down' : ''}:`);
    for (const r of rows) log(`  ${r.id.padEnd(16)} mean ${String(r.mean).padStart(6)} worst ${String(r.worst).padStart(4)} >32: ${String(r.over32).padStart(6)}%  ink box ${r.ink ? `${r.ink.left} ${r.ink.top} ${r.ink.right} ${r.ink.bottom}` : 'none'}`);
  }
}

if (ONLY.has('look')) {
  // 3. Switch off beside switch on, to look at, and the ink box of each box
  //    in both.
  report.look = {};
  for (const [z, dpr, tag] of atDensity([[1, 1, '100-1x'], [3, 1, '300-1x'], [1, 2, '100-2x'], [1.5, 2, '150-2x']])) {
    await fit(z);
    await ec('engine', 'browser');
    await ec('zoom', z);
    const offRects = await ec('rects');
    const offShot = await shot(offRects.frame);
    await ec('engine', 'rust');
    await ec('zoom', z);
    const onRects = await ec('rects');
    const onShot = await shot(onRects.frame);
    save(`page-${tag}-off.png`, offShot.canvas);
    save(`page-${tag}-on.png`, onShot.canvas);
    const rows = [];
    const pairs = [];
    for (const b of onRects.boxes) {
      const c = cellOf(b, { x: 0, y: 0 }, z * dpr);
      const a = crop(offShot, c.x, c.y, c.w, c.h);
      const e = crop(onShot, c.x, c.y, c.w, c.h);
      const off = offsets(inkBox(a), inkBox(e));
      rows.push({ id: b.id, devicePx: off, pagePx: offsets(inkBox(a), inkBox(e), z * dpr), ...compare(a, e) });
      pairs.push([`${b.id}   (ink box, on minus off, device px: ${off ? `${off.left} ${off.top} ${off.right} ${off.bottom}` : 'no ink'})`, a, e]);
    }
    report.look[tag] = { zoom: z, dpr, frameMoved: { x: onRects.frame.x - offRects.frame.x, y: onRects.frame.y - offRects.frame.y }, boxes: rows };
    for (let i = 0; i < pairs.length; i += 6) sheet(`look-${tag}-${String(i / 6 + 1).padStart(2, '0')}.png`, pairs.slice(i, i + 6), `zoom ${z * 100}%, ${dpr}x display: switch OFF (DOM text) left, switch ON (engine canvas) right`);
    log(`look ${tag}: ink box of the canvas minus the DOM's, device px (left top right bottom):`);
    for (const r of rows) log(`  ${r.id.padEnd(16)} ${r.devicePx ? `${r.devicePx.left} ${r.devicePx.top} ${r.devicePx.right} ${r.devicePx.bottom}` : 'no ink'}   centre ${r.devicePx ? `${r.devicePx.cx} ${r.devicePx.cy}` : ''}`);
  }
}

if (ONLY.has('edit')) {
  // 4. With the switch on: a box at rest (canvas), typed into (the editable),
  //    and at rest again.
  await fit(1);
  await ec('engine', 'rust');
  await ec('zoom', 1);
  const rects = await ec('rects');
  report.edit = [];
  const pairs = [];
  for (const id of ['plain', 'left-top', 'right-bottom', 'fractional', 'stroked', 'shadows', 'faux-bold', 'faux-italic', 'real-italic', 'missing-font', 'arc', 'path']) {
    const b = rects.boxes.find((x) => x.id === id);
    const c = cellOf(b, rects.frame, 1);
    // Selected first: a box is selected before and after it is typed into,
    // and the selection's frame is in both pictures.
    await ec('select', id);
    const rest = await shot(c);
    await ec('edit', id);
    const typing = await shot(c);
    const made = (await ec('rects')).boxes.find((x) => x.id === id);
    await ec('endEdit');
    await ec('select', id);
    const again = await shot(c);
    await ec('select', null);
    let unlike = 0;
    for (let k = 0; k < rest.data.length; k++) if (rest.data[k] !== again.data[k]) unlike++;
    // The type is black and the editor's chrome is not.
    const off = offsets(inkBox(rest, true), inkBox(typing, true));
    report.edit.push({ id, editingWas: { canvas: made.canvas?.painter ?? (made.canvas ? 'old' : null), editable: made.editable }, restToEditing: off, bytesUnlikeAfter: unlike });
    pairs.push([`${id}   (black ink box, editing minus rest, device px: ${off ? `${off.left} ${off.top} ${off.right} ${off.bottom}` : 'no ink'})`, rest, typing]);
    log(`  edit ${id.padEnd(14)} editing minus rest: ${off ? `${off.left} ${off.top} ${off.right} ${off.bottom}` : 'no ink'}; while editing: canvas ${made.canvas?.painter ?? !!made.canvas}, editable ${made.editable}; bytes unlike once back at rest: ${unlike}`);
  }
  sheet(`edit-100-${DSF}x.png`, pairs, `switch ON, zoom 100%, ${DSF}x display: at rest (engine canvas) left, being typed into (contenteditable) right`);
}

// What a user waits for, with the switch off and on, in a 1600 x 1000 window.
// The DOM path's figures are its script and layout only: the browser rasters
// its text afterwards, off the main thread, where a page cannot time it. The
// canvas path's figures are the whole of it.
async function costs(label, resizeId) {
  const out = {};
  const ms = (st) => `${st.median.toFixed(1)} (${st.min.toFixed(1)}-${st.max.toFixed(1)})`;
  for (const mode of ['browser', 'rust']) {
    await ec('engine', mode);
    await viewport(1600, 1000);
    const m = { held: {}, resize: {} };
    for (const z of [0.6, 1, 3]) {
      await ec('zoom', z);
      await ec('reveal', resizeId);
      await sleep(300);
      m.held[`${z * 100}%`] = await ec('held');
      if (z !== 0.6) m.resize[`${z * 100}%`] = await ec('timeResize', resizeId, 30);
    }
    await ec('zoom', 1);
    m.mount = await ec('timeMount', 6);
    m.repaintAll = await ec('timeRepaintAll', 6);
    m.zoomGesture = await ec('timeZoomGesture', 0.8, 1.6, 12);
    m.zoomGestureDeep = await ec('timeZoomGesture', 2, 3, 12);
    await ec('zoom', 1);
    m.turn = await ec('timeTurn', 5);
    await ec('zoom', 1);
    out[mode] = m;
    log(`${label} / switch ${mode === 'rust' ? 'ON' : 'OFF'}, ms as median (min-max):`);
    log(`   mount ${ms(m.mount.sync)}, to the second frame ${ms(m.mount.toSecondFrame)}; every box repainted ${ms(m.repaintAll.sync)}`);
    log(`   resize, a frame: ${Object.entries(m.resize).map(([k, v]) => `at ${k} ${ms(v)} for ${(v.canvasPx / 1e6).toFixed(2)} MP`).join('; ')}`);
    log(`   zoom gesture 80-160%: a tick ${ms(m.zoomGesture.tick)}, the settle ${m.zoomGesture.settle.toFixed(1)}; 200-300%: a tick ${ms(m.zoomGestureDeep.tick)}, the settle ${m.zoomGestureDeep.settle.toFixed(1)}`);
    if (m.turn) log(`   page turn (${m.turn.boxes.join(' and ')} boxes) ${ms(m.turn.sync)}`);
    log(`   held: ${Object.entries(m.held).map(([k, v]) => `${k}: ${(v.bytes / 1048576).toFixed(1)} MB in ${v.withPixels} of ${v.canvases} canvases (largest ${(v.largest / 1048576).toFixed(1)} MB, on hidden pages ${(v.onHiddenPages.bytes / 1048576).toFixed(1)} MB), ${v.boxElements} elements in ${v.boxes} boxes`).join(' | ')}`);
  }
  return out;
}

if (ONLY.has('cost')) {
  report.costSynthetic = await costs('synthetic page', 'bands');
}

if (ONLY.has('real') && DATA) {
  // 5. A real chapter, in the user's own fonts.
  const chapter = JSON.parse(readFileSync(join(DATA, 'chapters', `${CHAPTER}.json`), 'utf8'));
  const used = new Set(chapter.pages.flatMap((p) => (p.boxes ?? []).map((b) => b.style?.font)));
  const list = JSON.parse(readFileSync(join(DATA, 'fonts', 'fonts.json'), 'utf8')).fonts.filter((f) => used.has(f.family) && !/^src\/test\/fonts\//.test(f.source ?? ''));
  await ec('engine', 'browser');
  const added = await ec('addFonts', list.map((f) => ({ family: f.family, slot: f.slot, file: f.file })), dataBase);
  const info = await ec('openUrl', `${dataBase}/chapters/${CHAPTER}.json`);
  const busiest = info.boxes.indexOf(Math.max(...info.boxes));
  report.real = { chapter: CHAPTER.replace(/__.*/, '…'), pages: info.pages, boxes: info.boxes, faces: added.length, page: busiest };
  log(`real chapter: ${info.pages} pages, ${info.boxes.reduce((a, b) => a + b, 0)} boxes, ${added.length} faces loaded; page ${busiest + 1} has ${info.boxes[busiest]}`);
  await ec('goto', busiest);
  report.real.on = await ec('engine', 'rust');
  report.real.bytes = [];
  for (const z of [0.6, 1, 2]) {
    await viewport(chapter.pages[busiest].w * z + 240, chapter.pages[busiest].h * z + 240);
    await ec('zoom', z);
    const rows = await ec('sameAsExporter');
    const bad = rows.filter((r) => !r.painted || r.bytes !== 0);
    report.real.bytes.push({ zoom: z, dpr: DSF, boxes: rows.length, identical: rows.length - bad.length, different: bad });
    log(`  zoom ${z} dpr ${DSF}: ${rows.length - bad.length}/${rows.length} canvases byte-identical to renderBoxTexture`);
  }
  report.real.cost = await costs('real page', await ec('largest'));
  // To look at: the page with the switch off and on. Written beside the
  // report, which is outside the repository, because it is the user's text.
  for (const mode of ['browser', 'rust']) {
    await viewport(chapter.pages[busiest].w + 240, chapter.pages[busiest].h + 240);
    await ec('engine', mode);
    await ec('zoom', 1);
    const r = await ec('rects');
    save(`real-page-${DSF}x-${mode === 'rust' ? 'on' : 'off'}.png`, (await shot(r.frame)).canvas);
  }
}

// ---- the second check: what is near, what takes the pointer, what is held ----
const WINDOW = { w: 1600, h: 1000 };
const painted = (b) => !!b.canvas && b.canvas.w > 0;
async function click(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(120);
}

if (ONLY.has('near')) {
  // The observer's margin, in the real scrolling area: a box within half the
  // area of it holds its picture before it is in view, a box further does
  // not, and a box is judged by what its picture covers. The page works it
  // out (`nearCheck`); the picture of the spilling box is taken here.
  report.near = {};
  await ec('engine', 'rust');
  await viewport(WINDOW.w, WINDOW.h);
  for (const layout of ['pages', 'longstrip']) {
    let row;
    try {
      row = await ec('nearCheck', layout);
      const st = await ec('scrollTo', 0, row.spillTop, 4);
      const shown = await shot({ x: st.scroll.x, y: st.scroll.y, w: st.scroll.w, h: st.scroll.h });
      save(`near-spill-${layout}-${DSF}x.png`, shown.canvas);
      row.spill.inkOnScreen = inkBox(shown, true)?.n ?? 0;
    } catch (err) {
      row = { ...row, error: String(err.message ?? err) };
    }
    report.near[layout] = row;
    log(`near / ${layout}:`, JSON.stringify(row));
  }
}

if (ONLY.has('hits')) {
  // Letters the picture shows outside the frame take the pointer, and the
  // picture's own padding does not. The page asks its own hit test
  // (`hitsCheck`); here the ink is read off the screen and a real click made.
  await viewport(WINDOW.w, WINDOW.h);
  const { ids, points, rows } = await ec('hitsCheck');
  report.hits = rows;
  const state = await ec('boxesState');
  const shown = await shot({ x: state.scroll.x, y: state.scroll.y, w: state.scroll.w, h: state.scroll.h });
  // Every point tried, drawn over a copy of the picture: where the DOM had a
  // letter, green if it took the pointer and red if not; ink outside a frame
  // that did not, pink.
  const rest = crop(shown, 0, 0, shown.w, shown.h);
  const marks = rest.canvas.getContext('2d');
  for (const id of ids) {
    const pts = points[id];
    const onHits = await ec('hitTest', pts);
    const made = state.boxes.find((b) => b.id === id);
    for (const [i, q] of pts.entries()) {
      marks.fillStyle = onHits[i] === id ? '#00a040' : '#e00000';
      marks.fillRect((q.x - state.scroll.x) * DSF - 2, (q.y - state.scroll.y) * DSF - 2, 4, 4);
    }
    marks.strokeStyle = '#0060ff';
    marks.strokeRect((made.rect.x - state.scroll.x) * DSF, (made.rect.y - state.scroll.y) * DSF, made.rect.w * DSF, made.rect.h * DSF);
    // The ink itself, as the screen shows it: every dark pixel of the picture
    // that is outside the frame, a sample of them asked of the hit test.
    const cr = made.canvas.rect;
    const ink = [];
    for (let y = Math.floor((cr.y - state.scroll.y) * DSF); y < (cr.y + cr.h - state.scroll.y) * DSF; y++) {
      for (let x = Math.floor((cr.x - state.scroll.x) * DSF); x < (cr.x + cr.w - state.scroll.x) * DSF; x++) {
        const i = (y * shown.w + x) * 4;
        if (shown.data[i] > 110 || shown.data[i + 1] > 110 || shown.data[i + 2] > 110) continue;
        const q = { x: state.scroll.x + (x + 0.5) / DSF, y: state.scroll.y + (y + 0.5) / DSF };
        if (q.x < made.rect.x || q.x > made.rect.x + made.rect.w || q.y < made.rect.y || q.y > made.rect.y + made.rect.h) ink.push(q);
      }
    }
    const every = Math.max(1, Math.floor(ink.length / 400));
    const sample = ink.filter((_, i) => i % every === 0);
    const inkHits = sample.length ? await ec('hitTest', sample) : [];
    for (const [i, q] of sample.entries()) {
      if (inkHits[i] === id) continue;
      marks.fillStyle = '#ff00c0';
      marks.fillRect((q.x - state.scroll.x) * DSF - 1, (q.y - state.scroll.y) * DSF - 1, 3, 3);
    }
    rows[id].inkOutsideTheFrame = { devicePx: ink.length, sampled: sample.length, hit: inkHits.filter((h) => h === id).length };
    // A real click on a letter outside the frame selects the box.
    const out = pts.filter((q) => q.outside);
    if (out.length) {
      await ec('select', null);
      const q = out[Math.floor(out.length / 2)];
      await click(q.x, q.y);
      rows[id].clickOutsideTheFrameSelected = (await ec('state')).selected;
      await ec('select', null);
    }
    log(`hits ${id.padEnd(7)}`, JSON.stringify(rows[id]));
  }
  save(`hits-${DSF}x.png`, rest.canvas);
}

if (ONLY.has('mask')) {
  // A masked box at rest keeps its mask image; an edit begun on it is masked
  // in the same flush. What the image is: a PNG blob per masked box.
  await viewport(WINDOW.w, WINDOW.h);
  const spec = await ec('spec', 'mask');
  report.mask = {};
  for (const mode of ['browser', 'rust']) {
    await ec('engine', mode);
    const before = (await ec('blobs')).length;
    await ec('openCustom', spec);
    await ec('zoom', 1);
    await sleep(300);
    const blobs = (await ec('blobs')).slice(before).filter((b) => b.live);
    const row = { liveBlobs: blobs.length, blobBytes: blobs.map((b) => b.size), types: [...new Set(blobs.map((b) => b.type))], boxes: {} };
    for (const id of ['include', 'exclude', 'large', 'unmasked']) {
      const rest = await ec('maskState', id);
      const now = await ec('editNow', id);
      await ec('endEdit');
      row.boxes[id] = { atRest: rest, theFlushTheEditBegan: now };
    }
    report.mask[mode === 'rust' ? 'on' : 'off'] = row;
    log(`mask / switch ${mode === 'rust' ? 'ON' : 'OFF'}:`, JSON.stringify(row));
  }
}

if (ONLY.has('limits')) {
  // A box longer than the engine's longest side is painted, lower; a box the
  // painter refuses is shown as its text and the rest of the page is painted.
  await viewport(WINDOW.w, WINDOW.h);
  await ec('engine', 'rust');
  report.limits = {};
  await ec('openCustom', await ec('spec', 'limits'));
  const z = 3 / DSF;
  await ec('zoom', z);
  await ec('scrollTo', 0, 0, 4);
  const errorsBefore = cdp.errors.length;
  const long = (await ec('boxesState')).boxes.find((b) => b.id === 'long');
  const same = (await ec('sameAsExporter')).find((r) => r.id === 'long');
  report.limits.long = { zoom: z, scale: z * DSF, wouldBe: Math.round(7000 * z * DSF), canvas: long.canvas, dom: long.dom, sameAsExporter: same, pageErrors: cdp.errors.length - errorsBefore };
  log('limits / long box:', JSON.stringify(report.limits.long));
  // Its text is in the middle of 7,000 page px: scrolled to, to be looked at.
  await ec('scrollTo', Math.round(long.rect.x + long.rect.w / 2 - WINDOW.w / 2), 0, 4);
  const middle = await shot({ x: 0, y: 0, w: WINDOW.w, h: 500 });
  report.limits.long.inkOnScreen = inkBox(middle, true)?.n ?? 0;
  save(`limits-long-${DSF}x.png`, middle.canvas);
  await ec('scrollTo', 0, 0, 2);

  const three = async () => Object.fromEntries((await ec('boxesState')).boxes.filter((b) => b.id !== 'long').map((b) => [b.id, { engine: painted(b) && b.canvas.painter === 'engine', dom: b.dom }]));
  const said = async () => (await ec('logged')).filter((m) => /could not be painted/.test(m)).length;
  await ec('logged');
  const steps = {};
  steps.before = await three();
  await ec('refuse', 'REFUSED');
  await ec('zoom', 1);
  steps.refusedAndRepainted = { boxes: await three(), said: await said() };
  await ec('zoom', 1.25);
  steps.repaintedAgain = { boxes: await three(), said: await said() };
  save(`limits-refused-${DSF}x.png`, (await shot({ x: 0, y: 0, w: WINDOW.w, h: 700 })).canvas);
  await ec('refuse', null);
  await ec('zoom', 1);
  steps.allowedAgain = { boxes: await three(), said: await said() };
  report.limits.refused = steps;
  // The refusal is this step's own doing; anything else stays a page error.
  const mine = (e) => /could not be painted|this job is refused/.test(String(e));
  report.limits.expectedErrors = cdp.errors.filter(mine).length;
  for (let i = cdp.errors.length - 1; i >= 0; i--) if (mine(cdp.errors[i])) cdp.errors.splice(i, 1);
  log('limits / a refused box:', JSON.stringify(steps));
}

if (ONLY.has('ink')) {
  // Ink that reaches past its advance is in the picture: no texture has ink
  // on its own edge, and at rest the letter is where typing shows it.
  await viewport(WINDOW.w, WINDOW.h);
  await ec('engine', 'rust');
  const J = [
    ['j-italic', { italic: true, size: 80, align: 'left' }, 'J'],
    ['j-upright', { size: 80, align: 'left' }, 'J'],
    ['j-right', { italic: true, size: 80, align: 'right' }, 'fJf'],
    ['wham-italic', { italic: true, size: 60, align: 'left', font: 'Check Bangers' }, 'WHAM'],
    ['sans-italic', { italic: true, size: 70, align: 'left', font: 'Aaa Sans' }, 'jf'],
  ];
  await ec('openCustom', { pages: [{ w: 1500, h: 400, boxes: J.map(([id, over, text], i) => ({ id, x: 80 + i * 280, y: 120, w: 150, h: 120, text, over })) }] });
  await ec('zoom', 1);
  const rects = await ec('boxesState');
  const pics = await ec('pictures');
  report.ink = [];
  const pairs = [];
  for (const [id] of J) {
    const tex = await fromDataUrl(pics.find((q) => q.id === id).url);
    // Ink on the outermost row or column of a texture: [pixels, strongest alpha] a side.
    const side = (n, at) => {
      let count = 0, most = 0;
      for (let i = 0; i < n; i++) {
        const a = tex.data[at(i) * 4 + 3];
        if (a) count++;
        if (a > most) most = a;
      }
      return [count, most];
    };
    const edges = { left: side(tex.h, (y) => y * tex.w), right: side(tex.h, (y) => y * tex.w + tex.w - 1), top: side(tex.w, (x) => x), bottom: side(tex.w, (x) => (tex.h - 1) * tex.w + x) };
    const edge = Object.values(edges).reduce((n, e) => n + e[0], 0);
    const b = rects.boxes.find((x) => x.id === id);
    const cell = { x: b.rect.x - 70, y: b.rect.y - 50, w: b.rect.w + 140, h: b.rect.h + 100 };
    const rest = await shot(cell);
    await ec('edit', id);
    const typing = await shot(cell);
    await ec('endEdit');
    await ec('select', null);
    const inkRest = inkBox(rest, true);
    const off = offsets(inkRest, inkBox(typing, true));
    report.ink.push({ id, texture: [tex.w, tex.h], inkedPixelsOnTheTextureEdge: edge, edges: edge ? edges : undefined, inkLeftOfTheBoxDevicePx: inkRest ? +(70 * DSF - inkRest.x0).toFixed(1) : null, typingMinusRest: off });
    pairs.push([`${id}   (black ink box, typing minus rest, device px: ${off ? `${off.left} ${off.top} ${off.right} ${off.bottom}` : 'no ink'})`, rest, typing]);
    log(`ink ${id.padEnd(12)}`, JSON.stringify(report.ink.at(-1)));
  }
  sheet(`ink-${DSF}x.png`, pairs, `switch ON, zoom 100%, ${DSF}x display: at rest (engine canvas) left, being typed into right`);
}

if (ONLY.has('drag')) {
  // A handle dragged, a frame at a time: what a frame costs, and what the
  // canvas holds while the drag is on and once it is let go.
  await viewport(WINDOW.w, WINDOW.h);
  report.drag = {};
  const spec = { pages: [{ w: 1400, h: 1700, boxes: [
    { id: 'balloon', x: 60, y: 60, w: 220, h: 110 },
    { id: 'effect', x: 60, y: 260, w: 600, h: 400, over: { size: 90, strokes: [{ color: '#d02020', width: 4, opacity: 1 }] } },
    { id: 'page-wide', x: 60, y: 760, w: 1100, h: 800, over: { size: 150, strokes: [{ color: '#d02020', width: 6, opacity: 1 }], shadows: [{ x: 6, y: 6, blur: 8, color: '#000000', opacity: 0.6 }] } },
  ] }] };
  const ms = (st) => `${st.median.toFixed(1)} (${st.min.toFixed(1)}-${st.max.toFixed(1)})`;
  for (const mode of ['browser', 'rust']) {
    await ec('engine', mode);
    await ec('openCustom', spec);
    const out = (report.drag[mode === 'rust' ? 'on' : 'off'] = {});
    for (const zoom of [1, 3]) {
      await ec('zoom', zoom);
      for (const id of ['balloon', 'effect', 'page-wide']) {
        await ec('reveal', id);
        const r = await ec('timeDrag', id, 'e', 30, 2);
        out[`${id}@${zoom * 100}%`] = r;
        const mp = (s) => (s ? `${((s[0] * s[1]) / 1e6).toFixed(2)} MP` : 'no canvas');
        log(`drag / switch ${mode === 'rust' ? 'ON ' : 'OFF'} ${id.padEnd(9)} at ${zoom * 100}%: a frame ${r.error ?? ms(r.frame)} ms, letting go ${r.letGo?.toFixed(1)} ms; canvas before ${mp(r.before)}, at the last frame ${mp(r.during)}, after ${mp(r.after)}; grew ${r.grewPagePx} page px`);
      }
    }
  }
}


// ---- typing into the picture (P7) ----
// Real input from here on: keys, the mouse and an IME's composition go in
// through the DevTools protocol, as the system would send them. On macOS the
// editing a key stands for is the system's to say (a key binding), so a key
// the page leaves to the browser carries the command the system would attach.
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const VK = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Backspace: 8, Delete: 46, Escape: 27, Enter: 13 };
async function key(name, { mods = 0, text = null, commands = null } = {}) {
  const vk = VK[name] ?? name.toUpperCase().charCodeAt(0);
  const base = { key: name, code: VK[name] ? name : `Key${name.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function mouse(type, p, { button = 'left', buttons = 1, clickCount = 1, mods = 0 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons, clickCount, modifiers: mods });
}
// `count` presses at one place: 2 is a double-click, 3 a triple.
async function pressAt(p, { count = 1, mods = 0, button = 'left' } = {}) {
  for (let c = 1; c <= count; c++) {
    await mouse('mousePressed', p, { button, buttons: button === 'left' ? 1 : 2, clickCount: c, mods });
    await mouse('mouseReleased', p, { button, buttons: 0, clickCount: c, mods });
  }
}
async function dragTo(a, b) {
  await mouse('mousePressed', a);
  await mouse('mouseMoved', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  await mouse('mouseMoved', b);
  await mouse('mouseReleased', b, { buttons: 0 });
}
const typeState = async (frames = 1) => {
  await ec('wait', frames);
  return ec('typeState');
};
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The stop of a row nearest an x, the later of two as near (flat-caret.js).
const nearest = (row, x) => row.xs.reduce((best, v, j) => (Math.abs(v - x) <= Math.abs(row.xs[best] - x) ? j : best), 0);
const cellFor = async (id, margin = 40) => {
  const b = (await ec('boxesState')).boxes.find((x) => x.id === id);
  return { box: b, cell: { x: b.rect.x - margin, y: b.rect.y - margin, w: b.rect.w + margin * 2, h: b.rect.h + margin * 2 } };
};
// A box brought to the middle of the window and left to settle there: the
// app scrolls to a box it selects, and a box that was far off paints when
// the observer says it is near.
const bring = async (id) => {
  await ec('select', id);
  await ec('wait', 8);
  await ec('reveal', id);
  await ec('reveal', id);
  for (let i = 0; i < 20; i++) {
    const c = (await cellFor(id)).box.canvas;
    if (c?.w > 0) break;
    await ec('wait', 3);
  }
};
// An edit begun as a user begins one: a double-click on the box.
const begin = async (id) => {
  const { box } = await cellFor(id);
  await pressAt(middle(box.rect), { count: 2 });
  return typeState(2);
};
// A stretch of time long enough that the next edit is a step of its own in
// the field's undo (field-undo.svelte.js gathers typing into runs).
const pause = () => sleep(700);
const end = async () => {
  await key('Escape');
  await ec('wait', 2);
  const editing = (await ec('state')).editing;
  if (editing) await ec('endEdit');
  return !editing;
};

// A box over the budget a key's paint is given is soft for 150 ms after a key
// (TextBox.svelte `keyed`): what is compared with the exporter is then the
// picture it settles to, and that it was soft is said (`wasSoft`).
const typeSameSettled = async (id) => {
  let r = await ec('typeSame', id);
  if (r.painted && !same(r.editor, r.exporter)) {
    await sleep(260);
    await ec('wait', 2);
    r = { ...(await ec('typeSame', id)), wasSoft: true };
  }
  return r;
};
if (ONLY.has('type')) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await viewport(WINDOW.w, WINDOW.h);
  const spec = await ec('spec', 'type');
  const ids = spec.pages[0].boxes.map((b) => b.id).filter((id) => !args.ids || args.ids.split(',').includes(id));
  const T = (report.type = { boxes: {}, zooms: {}, browserSelects: {}, fails: [], checks: 0 });
  const check = (ok, id, what, detail) => {
    T.checks++;
    if (!ok) T.fails.push({ id, what, detail });
    return ok;
  };
  // -- what the browser selects today, with the switch off: measured, to match --
  await ec('engine', 'rust');
  await ec('openCustom', spec);
  await ec('zoom', 1);
  // Asked at the two halves of every letter (the places the engine's rows
  // say they are): where one press puts the browser's caret, what two select,
  // and - once a row - what three select. A place where the browser's own
  // layout puts the caret at another offset than the engine's rows do is no
  // comparison of the RULE, and is counted apart.
  const samples = {};
  for (const id of ids) {
    await bring(id);
    const m = await ec('typeRows', id);
    if (m?.kind !== 'flat') continue;
    samples[id] = { halves: await ec('typeHalves', id), rows: m.rows.map((row, i) => (row.line >= 0 && row.offs.length > 2 ? { row: i, p: lerp(m.at[i][1], m.at[i][2], 0.5) } : null)).filter(Boolean) };
  }
  await ec('engine', 'browser');
  await ec('zoom', 1);
  for (const id of Object.keys(samples)) {
    await bring(id);
    await begin(id);
    const out = { halves: [], rows: [] };
    for (const h of samples[id].halves) {
      await pressAt(h.p);
      const caret = (await typeState()).sel?.[1];
      await pressAt(h.p, { count: 2 });
      out.halves.push({ caret, word: (await typeState()).sel });
    }
    for (const q of samples[id].rows) {
      await pressAt(q.p, { count: 3 });
      out.rows.push((await typeState()).sel);
    }
    await end();
    T.browserSelects[id] = out;
  }

  // -- with the switch on --
  await ec('engine', 'rust');
  await ec('openCustom', spec);
  const sheets = [];
  for (const zoom of [1, 0.6, 3]) {
    await ec('zoom', zoom);
    const full = zoom === 1;
    const Z = full ? T.boxes : (T.zooms[`${zoom * 100}%`] = {});
    for (const id of ids) {
      const R = (Z[id] = {});
      const errorsBefore = cdp.errors.length;
      try {
      await (async () => {
      await bring(id);
      const text0 = spec.pages[0].boxes.find((b) => b.id === id).text ?? 'WAIT FOR ME\nOVER THERE!';
      // 1. The edit starting and ending: nothing but the marks changes.
      await ec('bare', true);
      const { cell, box: at0 } = await cellFor(id);
      // The pointer where the double-click will be, so that what it hovers is
      // in every picture alike.
      await mouse('mouseMoved', middle(at0.rect), { buttons: 0 });
      await ec('wait', 2);
      const rest = await shot(cell);
      const restCanvas = (await cellFor(id)).box.canvas;
      let st = await begin(id);
      const typing = await shot(cell);
      const sameBytes = await ec('typeSame', id);
      R.whileTyping = { canvas: st.canvas?.painter ?? null, overlay: st.overlay, unseen: st.unseen, ghost: st.ghost, focused: st.focused };
      check(st.editing === id && st.canvas?.painter === 'engine' && (st.unseen || st.ghost) && !!st.overlay, id, 'typed into as its picture', R.whileTyping);
      check(sameBytes.painted && sameBytes.bytes === 0, id, 'picture is renderBoxTexture, byte for byte', sameBytes);
      check(same(st.canvas?.rect, restCanvas?.rect) && st.canvas?.w === restCanvas?.w, id, 'the canvas did not move or change size when the edit began', { rest: restCanvas, typing: st.canvas });
      let unlike = 0;
      for (let k = 0; k < rest.data.length; k++) if (rest.data[k] !== typing.data[k]) unlike++;
      R.editStart = { screenBytesUnlike: unlike, inkBox: offsets(inkBox(rest, true), inkBox(typing, true)) };
      check(unlike === 0, id, 'screen unchanged when the edit began (marks hidden)', R.editStart);
      // The first focus selects everything, and shows it.
      R.firstFocus = { sel: st.sel, held: st.held, marks: st.sels.length, caretShown: st.caret ? !st.caret.off : null };
      check(same(st.sel, [0, text0.length]) && st.sels.length > 0, id, 'first focus selects all and shows it', R.firstFocus);
      check(await end(), id, 'Escape ends the edit');
      await ec('select', id);
      await ec('wait', 3);
      const again = await shot(cell);
      unlike = 0;
      for (let k = 0; k < rest.data.length; k++) if (rest.data[k] !== again.data[k]) unlike++;
      R.editEnd = { screenBytesUnlike: unlike };
      check(unlike === 0, id, 'screen unchanged once the edit ended', R.editEnd);
      await ec('bare', false);

      // 2. A press on each half of every letter.
      st = await begin(id);
      const model = await ec('typeRows', id);
      const pts = await ec('typeHalves', id);
      const flat = model.kind === 'flat';
      let wrong = 0;
      let caretOff = 0;
      let worstCaret = 0;
      const firstWrong = [];
      for (const h of pts) {
        await pressAt(h.p);
        st = await typeState();
        if (!same(st.sel, [h.o, h.o])) {
          wrong++;
          if (firstWrong.length < 4) firstWrong.push({ want: h.o, got: st.sel, row: h.row });
        }
        // The caret is drawn at the stop the press went to, on its row.
        if (flat && st.caret) {
          const d = far(middle(st.caret), model.at[h.row][h.k]);
          worstCaret = Math.max(worstCaret, d);
          if (d > 0.75 || st.caret.off) caretOff++;
        }
      }
      R.presses = { letterHalves: pts.length, wrongOffset: wrong, firstWrong, caretNotAtItsStop: caretOff, worstCaretCssPx: +worstCaret.toFixed(3) };
      check(pts.length > 0 && wrong === 0, id, 'a press on each half of every letter goes to its offset', R.presses);
      check(caretOff === 0, id, 'the caret is drawn at the stop pressed, on its row', R.presses);
      if (!full) {
        check(await end(), id, 'Escape ends the edit');
        check(cdp.errors.length === errorsBefore, id, 'no page error', cdp.errors.slice(errorsBefore));
        log(`type ${String(zoom * 100).padStart(3)}% ${id.padEnd(16)} bytes ${sameBytes.bytes}, start ${R.editStart.screenBytesUnlike}, end ${R.editEnd.screenBytesUnlike}; presses ${pts.length - wrong}/${pts.length}, caret worst ${R.presses.worstCaretCssPx} px`);
        return;
      }

      const len = st.held.length;
      if (flat) {
        const rows = model.rows;
        const at = model.at;
        const drawn = rows.map((r, i) => (r.line >= 0 ? i : -1)).filter((i) => i >= 0);
        // 3. Double-click and triple-click, against what the browser selected.
        const was = T.browserSelects[id] ?? { halves: [], rows: [] };
        const mine = samples[id] ?? { halves: [], rows: [] };
        let words = 0;
        let wordsUnlike = 0;
        let elsewhere = 0;
        const unlike = [];
        for (const [n, h] of mine.halves.entries()) {
          // Only where the browser's own layout put its caret at the same offset.
          if (was.halves[n]?.caret !== h.o) {
            elsewhere++;
            continue;
          }
          await pressAt(h.p, { count: 2 });
          const word = (await typeState()).sel;
          words++;
          if (!same(word, was.halves[n].word)) {
            wordsUnlike++;
            if (unlike.length < 6) unlike.push({ at: h.o, got: word, browser: was.halves[n].word });
          }
        }
        let linesUnlike = 0;
        const lines = [];
        for (const [n, q] of mine.rows.entries()) {
          await pressAt(q.p, { count: 3 });
          const line = (await typeState()).sel;
          lines.push({ row: q.row, got: line, browser: was.rows[n] });
          if (!same(line, was.rows[n])) linesUnlike++;
        }
        R.clicks = { doubleClicksCompared: words, unlikeTheBrowser: wordsUnlike, unlike, browserCaretElsewhere: elsewhere, tripleClicks: lines.length, tripleUnlikeTheBrowser: linesUnlike, lines };
        check(words > 0 && wordsUnlike === 0, id, 'double-click selects what the browser selects', R.clicks);
        check(lines.length > 0 && linesUnlike === 0, id, 'triple-click selects what the browser selects', lines);
        // 4. A drag across rows, Shift+click, and the rectangles drawn for it.
        const a = { row: drawn[0], k: 1 };
        const b = { row: drawn[drawn.length - 1], k: Math.min(3, rows[drawn[drawn.length - 1]].offs.length - 1) };
        await dragTo(at[a.row][a.k], at[b.row][b.k]);
        st = await typeState();
        const wantSel = [rows[a.row].offs[a.k], rows[b.row].offs[b.k]];
        R.drag = { sel: st.sel, want: wantSel, rectangles: st.sels.length, rowsSpanned: b.row - a.row + 1 };
        check(same(st.sel, wantSel) && st.sels.length === b.row - a.row + 1 && st.caret?.off === true, id, 'a drag selects from stop to stop, a rectangle a row', R.drag);
        await pressAt(at[a.row][Math.min(4, rows[a.row].offs.length - 1)], { mods: MOD.shift });
        st = await typeState();
        check(same(st.sel, [wantSel[0], rows[a.row].offs[Math.min(4, rows[a.row].offs.length - 1)]]), id, 'Shift+click extends from the anchor', st.sel);

        // 5. The keys that go by lines, across rows of unequal length.
        const K = (R.keys = []);
        const step = async (name, opts, want, what) => {
          await key(name, opts);
          const s = await typeState();
          const ok = same(s.sel, want.sel) && (want.row == null || (!!s.caret && far(middle(s.caret), at[want.row][want.k]) < 1));
          K.push({ key: what, sel: s.sel, want: want.sel, ok });
          check(ok, id, `key ${what}`, { got: s.sel, want, caret: s.caret && middle(s.caret) });
          return s;
        };
        // From the end of the longest drawn row.
        const longest = drawn.reduce((m, i) => (rows[i].xs.at(-1) - rows[i].xs[0] > rows[m].xs.at(-1) - rows[m].xs[0] ? i : m), drawn[0]);
        const lastK = rows[longest].offs.length - 1;
        // The end of its body: the last stop that is not a hanging space is
        // where the text ends, which a press on the last letter's right half gives.
        const endHalf = pts.filter((h) => h.row === longest).at(-1);
        await pressAt(endHalf.p);
        st = await typeState();
        const startO = st.sel[1];
        const goal = rows[longest].xs[rows[longest].offs.indexOf(startO)];
        const walk = async (dir, shift) => {
          let cur = longest;
          const anchor = startO;
          const name = dir > 0 ? 'ArrowDown' : 'ArrowUp';
          for (let n = 0; n < rows.length + 1; n++) {
            const next = cur + dir;
            let want;
            if (next < 0) want = { sel: [shift ? anchor : 0, 0] };
            else if (next >= rows.length) want = { sel: [shift ? anchor : len, len] };
            else {
              const k = nearest(rows[next], goal);
              want = { sel: [shift ? anchor : rows[next].offs[k], rows[next].offs[k]], row: next, k };
            }
            await step(name, { mods: shift ? MOD.shift : 0, commands: [shift ? (dir > 0 ? 'moveDownAndModifySelection' : 'moveUpAndModifySelection') : dir > 0 ? 'moveDown' : 'moveUp'] }, want, `${shift ? 'Shift+' : ''}${name}`);
            if (next < 0 || next >= rows.length) break;
            cur = next;
          }
        };
        await walk(1, false);
        await pressAt(endHalf.p);
        await walk(-1, false);
        await pressAt(endHalf.p);
        await walk(1, true);
        // Home and End on every drawn row; End on a wrapped row stays on it.
        for (const i of drawn) {
          const row = rows[i];
          if (row.offs.length < 3) continue;
          await pressAt(lerp(at[i][1], at[i][2], 0.25));
          await step('Home', { commands: ['moveToBeginningOfLine'] }, { sel: [row.offs[0], row.offs[0]], row: i, k: 0 }, 'Home');
          await step('End', { commands: ['moveToEndOfLine'] }, { sel: [row.offs.at(-1), row.offs.at(-1)], row: i, k: row.offs.length - 1 }, `End${row.soft ? ' (wrapped row)' : ''}`);
          await step('ArrowLeft', { mods: MOD.meta, commands: ['moveToBeginningOfLine'] }, { sel: [row.offs[0], row.offs[0]], row: i, k: 0 }, 'Cmd+Left');
          await step('ArrowRight', { mods: MOD.meta | MOD.shift, commands: ['moveToEndOfLineAndModifySelection'] }, { sel: [row.offs[0], row.offs.at(-1)] }, 'Cmd+Shift+Right');
        }
        await step('ArrowUp', { mods: MOD.meta, commands: ['moveToBeginningOfDocument'] }, { sel: [0, 0] }, 'Cmd+Up');
        const lastRow = rows.length - 1;
        await step('ArrowDown', { mods: MOD.meta, commands: ['moveToEndOfDocument'] }, { sel: [len, len], row: lastRow, k: rows[lastRow].offs.indexOf(len) }, 'Cmd+Down');
        // Left and Right step through every offset there is, one a press.
        await key('ArrowUp', { mods: MOD.meta });
        let stuck = 0;
        let prev = 0;
        let steps = 0;
        for (let n = 0; n < len + 2; n++) {
          await key('ArrowRight', { commands: ['moveRight'] });
          const s = await typeState(0);
          if (s.sel[1] === prev && prev < len) stuck++;
          if (s.sel[1] === len) {
            steps = n + 1;
            break;
          }
          prev = s.sel[1];
        }
        R.rightSteps = { presses: steps, characters: len, pressesThatDidNotMove: stuck };
        check(stuck === 0 && steps > 0 && steps <= len, id, 'Right moves at every press, start to end', R.rightSteps);

        // 6. Typing, deleting, pasting, cutting, undoing.
        const E = (R.edits = {});
        const row = rows[drawn[0]];
        const k0 = Math.min(3, row.offs.length - 2);
        const o = row.offs[k0];
        await pressAt(lerp(at[drawn[0]][k0], at[drawn[0]][k0 + 1], 0.25));
        await pause();
        await key('q', { text: 'q' });
        st = await typeState(2);
        E.typed = st.text === text0.slice(0, o) + 'q' + text0.slice(o) && same(st.sel, [o + 1, o + 1]);
        const afterType = await ec('typeSame', id);
        check(E.typed, id, 'a letter typed goes in at the caret', { text: st.text, sel: st.sel });
        check(afterType.bytes === 0 && afterType.painted, id, 'the picture after a letter is renderBoxTexture', afterType);
        await key('Backspace', { commands: ['deleteBackward'] });
        st = await typeState(2);
        E.backspace = st.text === text0 && same(st.sel, [o, o]);
        check(E.backspace, id, 'Backspace takes it away', { text: st.text, sel: st.sel });
        await pause();
        // By word: the browser says how far (its own target range), as with the switch off.
        await key('Backspace', { mods: MOD.alt, commands: ['deleteWordBackward'] });
        st = await typeState(2);
        E.wordDelete = { removed: text0.length - st.text.length, text: st.text };
        check(st.text.length < text0.length && st.text.endsWith(text0.slice(o)) && text0.startsWith(st.text.slice(0, st.sel[1])), id, 'Alt+Backspace takes a word', E.wordDelete);
        await key('z', { mods: MOD.meta });
        st = await typeState(2);
        E.undoWord = st.text === text0;
        check(E.undoWord, id, 'Cmd+Z brings the word back', st.text);
        // To the line's start: OUR line. From a row that is not the first, where there is one.
        const dr = drawn.length > 1 ? drawn[1] : drawn[0];
        const dk = Math.min(4, rows[dr].offs.length - 1);
        await pressAt(lerp(at[dr][dk - 1], at[dr][dk], 0.75));
        st = await typeState();
        const from = rows[dr].offs[0];
        const to = st.sel[1];
        await pause();
        await key('Backspace', { mods: MOD.meta, commands: ['deleteToBeginningOfLine'] });
        st = await typeState(2);
        E.lineDelete = { row: dr, want: text0.slice(0, from) + text0.slice(to), got: st.text };
        check(st.text === E.lineDelete.want && to > from, id, 'Cmd+Backspace deletes to the start of the picture\'s line', E.lineDelete);
        await key('z', { mods: MOD.meta });
        st = await typeState(2);
        check(st.text === text0, id, 'Cmd+Z brings the line back', st.text);
        await key('z', { mods: MOD.meta | MOD.shift });
        st = await typeState(2);
        E.redo = st.text === E.lineDelete.want;
        check(E.redo, id, 'Cmd+Shift+Z takes it away again', st.text);
        await key('z', { mods: MOD.meta });
        await ec('wait', 2);
        // Paste and cut carry their own clipboard (the system's is the user's).
        await pressAt(lerp(at[drawn[0]][k0], at[drawn[0]][k0 + 1], 0.25));
        await pause();
        const pasted = await ec('clip', 'paste', 'XY\nZ');
        st = await typeState(2);
        E.paste = st.text === text0.slice(0, o) + 'XY\nZ' + text0.slice(o) && pasted.prevented;
        check(E.paste, id, 'a paste goes in at the caret', { text: st.text });
        const pasteSame = await ec('typeSame', id);
        check(pasteSame.bytes === 0, id, 'the picture after a paste is renderBoxTexture', pasteSame);
        await key('z', { mods: MOD.meta });
        st = await typeState(2);
        check(st.text === text0, id, 'Cmd+Z takes the paste out', st.text);
        await pressAt(lerp(at[drawn[0]][k0], at[drawn[0]][k0 + 1], 0.25));
        await key('ArrowRight', { mods: MOD.shift, commands: ['moveRightAndModifySelection'] });
        await key('ArrowRight', { mods: MOD.shift, commands: ['moveRightAndModifySelection'] });
        st = await typeState();
        const cutSpan = [Math.min(...st.sel), Math.max(...st.sel)];
        const cut = await ec('clip', 'cut');
        st = await typeState(2);
        E.cut = { clipboard: cut.data, want: text0.slice(...cutSpan), text: st.text };
        check(cut.data === text0.slice(...cutSpan) && cut.data.length > 0 && st.text === text0.slice(0, cutSpan[0]) + text0.slice(cutSpan[1]), id, 'a cut takes the selection, as raw text', E.cut);
        await key('z', { mods: MOD.meta });
        st = await typeState(2);
        check(st.text === text0, id, 'Cmd+Z puts the cut back', st.text);
        // A word step is the browser's (Alt+Right): the marks follow its selection.
        await key('ArrowUp', { mods: MOD.meta });
        await key('ArrowRight', { mods: MOD.alt, commands: ['moveWordRight'] });
        st = await typeState();
        E.wordStep = st.sel;
        check(st.sel[1] > 0 && st.sel[0] === st.sel[1] && st.caret && !st.caret.off, id, 'Alt+Right (the browser\'s word step) moves the drawn caret', st.sel);

        // The right button: the system's menu is asked of the editable.
        await ec('menuSeen');
        const mp = lerp(at[drawn[0]][1], at[drawn[0]][2], 0.5);
        await pressAt(mp, { button: 'right' });
        st = await typeState(2);
        const menu = await ec('menuSeen');
        R.menu = { ...menu, sel: st.sel };
        check(st.sel[0] !== st.sel[1], id, 'the right button selects the word under it', st.sel);
        check(menu?.inEditable === true, id, 'the menu is asked of the editable', menu);
        await key('ArrowUp', { mods: MOD.meta });
      } else {
        // The curve: Up and Down are the text's ends, a letter goes in and out.
        await pressAt(pts[5].p);
        await key('ArrowUp', { commands: ['moveUp'] });
        st = await typeState();
        check(same(st.sel, [0, 0]), id, 'key Up on a curve: the start', st.sel);
        await key('ArrowDown', { commands: ['moveDown'] });
        st = await typeState();
        check(same(st.sel, [len, len]), id, 'key Down on a curve: the end', st.sel);
        await pressAt(pts[6].p);
        const o = pts[6].o;
        await pause();
        await key('q', { text: 'q' });
        st = await typeState(2);
        const afterType = await ec('typeSame', id);
        check(st.text === text0.slice(0, o) + 'q' + text0.slice(o) && afterType.bytes === 0, id, 'a letter typed on the curve is in the picture', { text: st.text, afterType });
        await key('Backspace', { commands: ['deleteBackward'] });
        st = await typeState(2);
        check(st.text === text0, id, 'Backspace takes it away', st.text);
        await dragTo(pts[2].p, pts[11].p);
        st = await typeState();
        R.drag = { sel: st.sel, want: [pts[2].o, pts[11].o], marks: st.sels.length };
        check(same(st.sel, R.drag.want) && st.sels.length === Math.abs(pts[11].o - pts[2].o), id, 'a drag on the curve selects glyph to glyph', R.drag);
      }

      // 7. An IME: composed text is in the picture, underlined; the box's text
      //    is its own until the composition ends; and the browser's caret, which
      //    the system hangs the IME's window on, is under the drawn one.
      const C = (R.ime = {});
      const cp = pts[Math.min(7, pts.length - 1)];
      await pressAt(cp.p);
      st = await typeState();
      const co = st.sel[1];
      const before = st.native && st.caret ? +far(middle(st.native), middle(st.caret)).toFixed(2) : null;
      await pause();
      await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 });
      st = await typeState(3);
      const comp1 = await ec('typeSame', id);
      C.composing = { boxText: st.text === text0, held: st.held === text0.slice(0, co) + 'かな' + text0.slice(co), underlines: st.comps.length, picture: comp1.bytes, fromStandIn: comp1.composing };
      C.nativeCaretFromDrawn = [before, st.native && st.caret ? +far(middle(st.native), middle(st.caret)).toFixed(2) : null];
      check(C.composing.boxText && C.composing.held && st.comps.length > 0, id, 'composed text is held and underlined, and is not yet the box\'s', C.composing);
      check(comp1.painted && comp1.bytes === 0 && comp1.composing, id, 'the picture while composing is renderBoxTexture of the composed text', comp1);
      await cdp.send('Input.imeSetComposition', { text: 'かなも', selectionStart: 1, selectionEnd: 1 });
      st = await typeState(3);
      C.nativeCaretFromDrawn.push(st.native && st.caret ? +far(middle(st.native), middle(st.caret)).toFixed(2) : null);
      C.caretInsideComposition = same(st.sel, [co + 1, co + 1]);
      check(C.caretInsideComposition, id, 'the caret inside the composition is where the IME put it', st.sel);
      check(C.nativeCaretFromDrawn.every((d) => d != null && d <= 4), id, 'the browser\'s own caret is within 4 CSS px of the drawn one', C.nativeCaretFromDrawn);
      if (full) {
        await ec('freezeCaret', true);
        await ec('wait', 1);
        sheets.push([id, 'ime', await shot((await cellFor(id)).cell)]);
      }
      await cdp.send('Input.insertText', { text: '仮名' });
      st = await typeState(3);
      await pause();
      const committed = await ec('typeSame', id);
      C.committed = st.text === text0.slice(0, co) + '仮名' + text0.slice(co) && st.comps.length === 0 && committed.bytes === 0 && !committed.composing;
      check(C.committed, id, 'the composition ended is the box\'s text and its picture', { text: st.text, committed });
      await key('z', { mods: MOD.meta });
      st = await typeState(2);
      C.undone = st.text === text0;
      check(C.undone, id, 'Cmd+Z takes the composed text out', st.text);

      // 8. To look at: the caret, and a selection.
      await ec('freezeCaret', true);
      const look = pts[Math.min(9, pts.length - 1)];
      await pressAt(look.p);
      await ec('wait', 2);
      sheets.push([id, 'caret', await shot((await cellFor(id)).cell)]);
      if (flat) {
        const rows = model.rows.map((r, i) => (r.line >= 0 ? i : -1)).filter((i) => i >= 0);
        const lastRowI = rows[rows.length - 1];
        await dragTo(model.at[rows[0]][2], model.at[lastRowI][Math.max(1, model.rows[lastRowI].offs.length - 3)]);
      } else await dragTo(pts[4].p, pts[21].p);
      await ec('wait', 2);
      sheets.push([id, 'selection', await shot((await cellFor(id)).cell)]);
      await ec('freezeCaret', false);

      check(await end(), id, 'Escape ends the edit');
      const after = await ec('typeState');
      check(after.text === text0 || after.text == null, id, 'the text is what it was', after.text);
      check(cdp.errors.length === errorsBefore, id, 'no page error', cdp.errors.slice(errorsBefore));
      const bad = T.fails.filter((f) => f.id === id).length;
      log(`type 100% ${id.padEnd(16)} bytes ${sameBytes.bytes}, start ${R.editStart.screenBytesUnlike}, end ${R.editEnd.screenBytesUnlike}; presses ${pts.length - wrong}/${pts.length}, caret worst ${R.presses.worstCaretCssPx} px; ime caret ${JSON.stringify(R.ime.nativeCaretFromDrawn)} px; failed ${bad}`);
      })();
      } catch (err) {
        // One box's trouble is that box's: said, and the next one is gone through.
        check(false, id, 'the step threw', String(err?.stack ?? err).slice(0, 400));
        log(`type ${zoom * 100}% ${id}: threw ${String(err?.message ?? err)}`);
        await ec('bare', false);
        await ec('freezeCaret', false);
        if ((await ec('state')).editing) await ec('endEdit');
      }
    }
  }
  // -- the odd ones, at 100% --
  if (!args.ids || args.ids.split(',').includes('edges')) {
    const edge = await ec('spec', 'typeEdge');
    await ec('openCustom', edge);
    await ec('zoom', 1);
    const E = (T.edges = {});
    const textOf = (id) => edge.pages[0].boxes.find((b) => b.id === id).text ?? 'WAIT FOR ME\nOVER THERE!';
    const edgeShots = [];
    const picture = async (id, what) => {
      await ec('freezeCaret', true);
      await ec('wait', 2);
      edgeShots.push([id, what, await shot((await cellFor(id)).cell)]);
      await ec('freezeCaret', false);
    };
    const guard = async (id, run) => {
      const errorsBefore = cdp.errors.length;
      try {
        await bring(id);
        await run((E[id] = {}));
      } catch (err) {
        check(false, id, 'the step threw', String(err?.stack ?? err).slice(0, 400));
        log(`type edges ${id}: threw ${String(err?.message ?? err)}`);
        await ec('freezeCaret', false);
      }
      await ec('refuse', null);
      if ((await ec('state')).editing) await end();
      // The refusal is said on the console, once, by the app: that one is wanted.
      const said = cdp.errors.splice(errorsBefore);
      const wanted = id === 'refused' ? said.filter((e) => String(e).includes('could not be painted')) : [];
      if (id === 'refused') check(wanted.length === 1, id, 'the refusal is said on the console once', said.map((e) => String(e).slice(0, 80)));
      check(said.length === wanted.length, id, 'no page error', said.filter((e) => !wanted.includes(e)));
      log(`type edges ${id.padEnd(10)} ${JSON.stringify(E[id]).slice(0, 420)}`);
    };
    const caretFromNative = (st) => (st.native && st.caret ? +far(middle(st.native), middle(st.caret)).toFixed(2) : null);

    // Nothing in the box: a caret as tall as a line where the first letter
    // will be, and the first letter typed is drawn.
    await guard('empty', async (R) => {
      const { box } = await cellFor('empty');
      let st = await begin('empty');
      R.start = { editing: st.editing === 'empty', overlay: st.overlay, unseen: st.unseen, focused: st.focused, sel: st.sel, caret: st.caret, nativeFromDrawn: caretFromNative(st) };
      const lineH = 30 * 1.1;
      check(st.editing === 'empty' && st.overlay === 'flat' && st.unseen && st.focused, 'empty', 'an empty box is typed into as a picture', R.start);
      check(!!st.caret && !st.caret.off && st.caret.h > lineH * 0.8 && Math.abs(middle(st.caret).x - middle(box.rect).x) < 1 && Math.abs(middle(st.caret).y - middle(box.rect).y) < 1, 'empty', 'its caret is a line tall, at the middle of a centred box', { caret: st.caret, box: box.rect });
      check(R.start.nativeFromDrawn != null && R.start.nativeFromDrawn <= 4, 'empty', 'the browser\'s own caret is within 4 CSS px of the drawn one', R.start.nativeFromDrawn);
      await picture('empty', 'empty, caret');
      await key('a', { text: 'a' });
      st = await typeState(3);
      const one = await ec('typeSame', 'empty');
      R.typed = { text: st.text, sel: st.sel, bytes: one.bytes, painted: one.painted };
      check(st.text === 'a' && same(st.sel, [1, 1]) && one.painted && one.bytes === 0, 'empty', 'the first letter typed is the box\'s text and its picture', R.typed);
      const y1 = middle(st.caret).y;
      await key('Enter', { text: '\r', commands: ['insertNewline'] });
      st = await typeState(3);
      R.returned = { text: st.text, sel: st.sel, caretDown: +(middle(st.caret).y - y1).toFixed(2), nativeFromDrawn: caretFromNative(st) };
      check(st.text === 'a\n' && same(st.sel, [2, 2]) && R.returned.caretDown > lineH * 0.4, 'empty', 'a Return opens a line with nothing on it and the caret stands on it', R.returned);
      check(R.returned.nativeFromDrawn != null && R.returned.nativeFromDrawn <= 4, 'empty', 'on the empty last line too the browser\'s caret is within 4 CSS px', R.returned.nativeFromDrawn);
      await key('Backspace', { commands: ['deleteBackward'] });
      await key('Backspace', { commands: ['deleteBackward'] });
      st = await typeState(3);
      R.emptied = { text: st.text, sel: st.sel, caret: !!st.caret, unseen: st.unseen };
      check(st.text === '' && same(st.sel, [0, 0]) && !!st.caret && st.unseen, 'empty', 'deleted back to nothing, the caret is still drawn', R.emptied);
      check(await end(), 'empty', 'Escape ends the edit');
    });

    // Nothing but spaces.
    await guard('spaces', async (R) => {
      let st = await begin('spaces');
      const model = await ec('typeRows', 'spaces');
      R.start = { overlay: st.overlay, unseen: st.unseen, sel: st.sel, rows: model?.rows?.map((r) => r.offs), xs: model?.rows?.map((r) => r.xs.map((v) => +v.toFixed(2))) };
      check(st.overlay === 'flat' && st.unseen && same(st.sel, [0, 3]), 'spaces', 'a box of spaces is typed into as a picture, all of it selected', R.start);
      await key('ArrowRight', { commands: ['moveRight'] });
      st = await typeState(2);
      const xEnd = st.caret?.x;
      await key('ArrowLeft', { commands: ['moveLeft'] });
      st = await typeState(2);
      R.step = { sel: st.sel, movedBy: xEnd != null && st.caret ? +(xEnd - st.caret.x).toFixed(2) : null, nativeFromDrawn: caretFromNative(st) };
      check(same(st.sel, [2, 2]) && R.step.movedBy > 2, 'spaces', 'the caret steps over a space by a space\'s width', R.step);
      check(R.step.nativeFromDrawn != null && R.step.nativeFromDrawn <= 4, 'spaces', 'the browser\'s own caret is within 4 CSS px of the drawn one', R.step.nativeFromDrawn);
      await key('x', { text: 'x' });
      st = await typeState(3);
      const one = await ec('typeSame', 'spaces');
      R.typed = { text: st.text, sel: st.sel, bytes: one.bytes };
      check(st.text === '  x ' && same(st.sel, [3, 3]) && one.bytes === 0, 'spaces', 'a letter typed among the spaces is drawn where the caret was', R.typed);
      await picture('spaces', 'spaces and an x');
      await pause();
      await key('z', { mods: MOD.meta });
      check((await typeState(2)).text === '   ', 'spaces', 'Cmd+Z takes it out');
      check(await end(), 'spaces', 'Escape ends the edit');
    });

    // The system's correction of a word: one input naming what it replaces.
    await guard('corrected', async (R) => {
      const text0 = textOf('corrected');
      await begin('corrected');
      const pts = await ec('typeHalves', 'corrected');
      await pressAt(pts.find((h) => h.o === 9).p);
      await ec('wait', 2);
      const sent = await ec('replace', 0, 3, 'the');
      let st = await typeState(3);
      const one = await ec('typeSame', 'corrected');
      R.replaced = { prevented: sent.prevented, text: st.text, sel: st.sel, bytes: one.bytes };
      check(sent.prevented && st.text === 'the' + text0.slice(3) && one.bytes === 0, 'corrected', 'a correction replaces its word, through the same input the box always took, and is drawn', R.replaced);
      check(same(st.sel, [3, 3]), 'corrected', 'the caret is after the corrected word', st.sel);
      await pause();
      await ec('replace', 4, 9, 'quiet');
      st = await typeState(3);
      R.second = st.text;
      check(st.text === 'the quiet' + text0.slice(9), 'corrected', 'a second correction, of a word further on', st.text);
      await pause();
      await key('z', { mods: MOD.meta });
      await pause();
      await key('z', { mods: MOD.meta });
      st = await typeState(2);
      R.undone = st.text;
      check(st.text === text0, 'corrected', 'Cmd+Z twice takes both corrections out', st.text);
      check(await end(), 'corrected', 'Escape ends the edit');
    });

    // A picture that cannot be painted while it is typed into: the text
    // stays, in the same editable, with the caret where it was.
    await guard('refused', async (R) => {
      const text0 = textOf('refused');
      await begin('refused');
      const pts = await ec('typeHalves', 'refused');
      const at = pts.find((h) => h.o === 4);
      await pressAt(at.p);
      let st = await typeState(2);
      check(st.unseen && same(st.sel, [4, 4]), 'refused', 'typed into as a picture before the refusal', { unseen: st.unseen, sel: st.sel });
      await ec('refuse', 'Q');
      await key('Q', { text: 'Q', mods: MOD.shift });
      st = await typeState(4);
      const withQ = text0.slice(0, 4) + 'Q' + text0.slice(4);
      R.refused = { text: st.text, held: st.held, sel: st.sel, unseen: st.unseen, focused: st.focused, overlay: st.overlay, canvas: st.canvas?.w ?? null, logged: (await ec('logged')).length };
      check(st.text === withQ && st.held === withQ, 'refused', 'the letter whose picture is refused is in the box\'s text all the same', R.refused);
      check(!st.unseen && st.overlay == null && st.focused && same(st.sel, [5, 5]), 'refused', 'the box is DOM text now, focus and caret kept', R.refused);
      await picture('refused', 'refused: DOM text');
      await key('u', { text: 'u' });
      st = await typeState(3);
      R.typedAsText = { text: st.text, sel: st.sel };
      check(st.text === text0.slice(0, 4) + 'Qu' + text0.slice(4) && same(st.sel, [6, 6]), 'refused', 'typing goes on, into the text', R.typedAsText);
      await key('Backspace', { commands: ['deleteBackward'] });
      await key('Backspace', { commands: ['deleteBackward'] });
      st = await typeState(4);
      const back = await ec('typeSame', 'refused');
      R.back = { text: st.text, sel: st.sel, unseen: st.unseen, overlay: st.overlay, focused: st.focused, bytes: back.bytes };
      check(st.text === text0 && st.unseen && st.overlay === 'flat' && st.focused && same(st.sel, [4, 4]) && back.bytes === 0, 'refused', 'the refused letter deleted, the box is its picture again, caret kept', R.back);
      await ec('refuse', null);
      await ec('logged');
      check(await end(), 'refused', 'Escape ends the edit');
    });

    // Something over or around the text: a clip mask, brush ink, a smear.
    for (const id of ['masked', 'inked', 'smear']) {
      await guard(id, async (R) => {
        const text0 = textOf(id);
        await ec('bare', true);
        const { cell } = await cellFor(id);
        await mouse('mouseMoved', middle(cell), { buttons: 0 });
        await ec('wait', 2);
        const rest = await shot(cell);
        let st = await begin(id);
        const editingShot = await shot(cell);
        let d = 0;
        for (let k = 0; k < rest.data.length; k++) if (rest.data[k] !== editingShot.data[k]) d++;
        edgeShots.push([id, `${id}, at rest`, rest], [id, `${id}, edit begun (marks hidden)`, editingShot]);
        const one = await ec('typeSame', id);
        R.start = { overlay: st.overlay, unseen: st.unseen, canvas: st.canvas?.painter ?? null, bytes: one.bytes ?? null, screenBytesUnlike: d };
        await ec('bare', false);
        check(st.overlay === 'flat' && st.unseen && st.canvas?.painter === 'engine', id, 'typed into as its picture', R.start);
        check(one.painted && one.bytes === 0, id, 'the picture while typing is renderBoxTexture', one);
        check(d === 0, id, 'the screen does not change when the edit starts', d);
        const pts = await ec('typeHalves', id);
        let wrong = 0;
        for (const h of pts) {
          await pressAt(h.p);
          const s = await typeState();
          if (!same(s.sel, [h.o, h.o])) wrong++;
        }
        R.presses = { n: pts.length, wrong };
        check(wrong === 0, id, 'a press on every half of every letter puts the caret there', R.presses);
        await pressAt(pts.find((h) => h.o === 4).p);
        await key('k', { text: 'k' });
        st = await typeState(3);
        const two = await ec('typeSame', id);
        R.typed = { text: st.text === text0.slice(0, 4) + 'k' + text0.slice(4), bytes: two.bytes };
        check(R.typed.text && two.bytes === 0, id, 'a letter typed is drawn', R.typed);
        await picture(id, `${id}, typing`);
        await pause();
        await key('z', { mods: MOD.meta });
        check((await typeState(2)).text === text0, id, 'Cmd+Z takes it out');
        check(await end(), id, 'Escape ends the edit');
      });
    }

    // A warped box is one canvas with no text element under it, and was never
    // typed into where it stands (TextBox.svelte, `onDblClick`): still so.
    await guard('warped', async (R) => {
      const st = await begin('warped');
      const box = (await cellFor('warped')).box;
      R.byDoubleClick = { editing: st.editing ?? null, editable: st.editable, canvas: box.canvas?.w > 0 };
      check(st.editing == null && !st.editable && box.canvas?.w > 0, 'warped', 'a double-click on a warped box starts no edit, and its picture stays', R.byDoubleClick);
      await picture('warped', 'warped, double-clicked: no edit');
    });

    {
      const w = 12 + edgeShots.reduce((sum, q) => sum + q[2].w + 12, 0);
      const h = 12 + 26 + Math.max(...edgeShots.map((q) => q[2].h)) + 12;
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#d8d8d8';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '14px sans-serif';
      let x = 12;
      for (const q of edgeShots) {
        ctx.fillStyle = '#000';
        ctx.fillText(q[1], x, 28);
        ctx.drawImage(q[2].canvas, x, 38);
        x += q[2].w + 12;
      }
      if (edgeShots.length) save(`type-${DSF}x-edges.png`, c);
    }

    // The questions the system's WebKit is asked (scripts/editor-check-webkit.swift),
    // answered here by Chromium: the presses are events made in the page.
    const self = (T.self = await ec('typeSelf'));
    for (const [id, row] of Object.entries(self)) {
      check(row.whileTyping.canvas === 'engine' && row.whileTyping.unseen && row.picture.bytes === 0 && !row.canvasMoved, id, 'self-check: typed into as its picture, which does not move', row);
      check(row.presses > 0 && row.wrongOffset === 0, id, 'self-check: every press made in the page lands on its offset', row);
      check(row.nativeCaret.noRectangle === 0 && row.nativeCaret.worstCssPxFromDrawn <= 4, id, 'self-check: the browser\'s caret is within 4 CSS px of the drawn one at every stop', row.nativeCaret);
      check(row.typed.text && row.typed.picture === 0 && row.textBack, id, 'self-check: a letter typed and deleted', row);
    }
    log(`type self-check (Chromium): ${Object.entries(self).map(([id, r]) => `${id} ${r.presses - r.wrongOffset}/${r.presses}, native ${r.nativeCaret.worstCssPxFromDrawn} px`).join('; ')}`);
  }

  // The pictures: one row a box - the caret, a selection, an IME composing.
  for (let i = 0; i < ids.length; i += 5) {
    const part = ids.slice(i, i + 5);
    const w = 12 + Math.max(...part.map((id) => sheets.filter((q) => q[0] === id).reduce((s, q) => s + q[2].w + 12, 0)));
    const h = 12 + part.reduce((s, id) => s + 26 + Math.max(...sheets.filter((q) => q[0] === id).map((q) => q[2].h)) + 12, 0);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '16px sans-serif';
    let y = 12;
    for (const id of part) {
      const mine = sheets.filter((q) => q[0] === id);
      ctx.fillStyle = '#000';
      ctx.fillText(`${id}: ${mine.map((q) => q[1]).join(' | ')}   (switch ON, zoom 100%, ${DSF}x)`, 12, y + 16);
      y += 26;
      let x = 12;
      for (const q of mine) {
        ctx.drawImage(q[2].canvas, x, y);
        x += q[2].w + 12;
      }
      y += Math.max(...mine.map((q) => q[2].h)) + 12;
    }
    save(`type-${DSF}x-${String(i / 5 + 1).padStart(2, '0')}.png`, c);
  }
  T.verdict = { checks: T.checks, failed: T.fails.length };
  log(`type verdict (${DSF}x): ${T.checks - T.fails.length} of ${T.checks} checks passed, ${T.fails.length} failed`);
  for (const f of T.fails.slice(0, 60)) log('  FAILED', f.id, '-', f.what, JSON.stringify(f.detail)?.slice(0, 300));
}

// ---- typing into the picture, second round (P7b) ----
// What the outside review found, each asked of the browser with real keys
// and a real mouse: the keys macOS binds to a move or a cut by lines (sent
// with the editing command the system attaches, which is what a browser runs
// when the page does not take the key), a drag that leaves the picture, a
// drag from a double and a triple press, the right button on a curve, the
// engine coming on in the middle of an edit, a letter cased to two with the
// line broken between the two, and the budget a key's paint is given.
if (ONLY.has('type2')) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await viewport(WINDOW.w, WINDOW.h);
  const spec = await ec('spec', 'type2');
  const T = (report.type2 = { fails: [], checks: 0 });
  const check = (ok, id, what, detail) => {
    T.checks++;
    if (!ok) T.fails.push({ id, what, detail });
    return ok;
  };
  const textOf = (id) => spec.pages[0].boxes.find((b) => b.id === id).text ?? 'WAIT FOR ME\nOVER THERE!';
  const open = async (mode, zoom = 1) => {
    await ec('engine', mode);
    await ec('openCustom', spec);
    await ec('zoom', zoom);
  };
  const errorsBefore = cdp.errors.length;
  const caretFromNative = (st) => (st.native && st.caret ? +far(middle(st.native), middle(st.caret)).toFixed(2) : null);

  // -- 1. the keys the system binds --
  // Every key from the same caret, in the middle of the second of three
  // rows, with the switch off and with it on: the selection and the text
  // after it are to be the same. Then, with the switch on, from the one
  // place the editable cannot say: the upper side of a wrap.
  const CTRL = MOD.ctrl;
  const ALT = MOD.alt;
  const SH = MOD.shift;
  const KEYS = [
    ['Control+A', 'a', CTRL, ['MoveToBeginningOfParagraph']],
    ['Control+E', 'e', CTRL, ['MoveToEndOfParagraph']],
    ['Control+N', 'n', CTRL, ['MoveDown']],
    ['Control+P', 'p', CTRL, ['MoveUp']],
    ['Control+F', 'f', CTRL, ['MoveForward']],
    ['Control+B', 'b', CTRL, ['MoveBackward']],
    ['Control+Shift+A', 'A', CTRL | SH, ['MoveToBeginningOfParagraphAndModifySelection']],
    ['Control+Shift+E', 'E', CTRL | SH, ['MoveToEndOfParagraphAndModifySelection']],
    ['Control+Shift+N', 'N', CTRL | SH, ['MoveDownAndModifySelection']],
    ['Control+Shift+P', 'P', CTRL | SH, ['MoveUpAndModifySelection']],
    ['Control+Left', 'ArrowLeft', CTRL, ['MoveToLeftEndOfLine']],
    ['Control+Right', 'ArrowRight', CTRL, ['MoveToRightEndOfLine']],
    ['Control+Shift+Right', 'ArrowRight', CTRL | SH, ['MoveToRightEndOfLineAndModifySelection']],
    ['Option+Up', 'ArrowUp', ALT, ['MoveBackward', 'MoveToBeginningOfParagraph']],
    ['Option+Down', 'ArrowDown', ALT, ['MoveForward', 'MoveToEndOfParagraph']],
    ['Option+Shift+Up', 'ArrowUp', ALT | SH, ['MoveParagraphBackwardAndModifySelection']],
    ['Option+Shift+Down', 'ArrowDown', ALT | SH, ['MoveParagraphForwardAndModifySelection']],
    ['Control+V', 'v', CTRL, ['MovePageDown']],
    ['Control+K', 'k', CTRL, ['DeleteToEndOfParagraph']],
    ['Control+D', 'd', CTRL, ['DeleteForward']],
    ['Control+H', 'h', CTRL, ['DeleteBackward']],
    ['Cmd+Backspace', 'Backspace', MOD.meta, ['DeleteToBeginningOfLine']],
    ['Cmd+Delete', 'Delete', MOD.meta, ['DeleteToEndOfLine']],
    ['paragraph delete back', 'Backspace', MOD.meta | CTRL, ['DeleteToBeginningOfParagraph']],
  ];
  const sent = { browser: {}, rust: {} };
  const runKeys = async (mode) => {
    await open(mode);
    await bring('rows');
    const out = {};
    for (const [name, k, mods, commands] of KEYS) {
      await begin('rows');
      await ec('typeSelect', 7);
      await ec('inputsSeen');
      await key(k, { mods, commands });
      const st = await typeState(3);
      out[name] = { sel: st.sel, text: st.text };
      // What the browser asked for, when the page left the key to it.
      sent[mode][name] = (await ec('inputsSeen')).map((i) => `${i.type} ${JSON.stringify(i.range)} (${i.from} to ${i.to})`);
      await end();
      // The text back, for the next key: the page is opened again.
      if (st.text !== textOf('rows')) {
        await ec('openCustom', spec);
        await bring('rows');
      }
    }
    return out;
  };
  const rowsModel = async () => (await ec('typeRows', 'rows')).rows.map((r) => [r.offs[0], r.offs.at(-1)]);
  const off = await runKeys('browser');
  const on = await runKeys('rust');
  const shape = await rowsModel();
  T.keys = { rows: shape, off, on, sent, unlike: KEYS.map(([name]) => name).filter((name) => !same(off[name], on[name])) };
  for (const [name] of KEYS) if (sent.browser[name].length || sent.rust[name].length) log(`type2 keys: ${name}: switch off, the browser asks ${JSON.stringify(sent.browser[name])}; switch on ${JSON.stringify(sent.rust[name])}`);
  check(same(shape, [[0, 5], [5, 10], [10, 14]]), 'rows', 'the box is three rows of a word each', shape);
  // Three of them are not compared with the switch off. For a delete to the
  // end of the line or of the paragraph, and for one to the paragraph's
  // start, THIS browser's own range in the editable runs to the same column
  // of the block after or before (it is logged above), and with the switch
  // off the app cuts what the browser names. The system's WebKit names the
  // row's end and start for the same keys (P7-REPORT, "Second round"), and
  // that is the rule the picture's rows go by.
  const BY_ROW = { 'Control+K': { sel: [7, 7], text: 'AAAA BBCCCC' }, 'Cmd+Delete': { sel: [7, 7], text: 'AAAA BBCCCC' }, 'paragraph delete back': { sel: [5, 5], text: 'AAAA BB CCCC' } };
  T.keys.byRow = Object.keys(BY_ROW);
  for (const [name] of KEYS) {
    if (BY_ROW[name]) check(same(on[name], BY_ROW[name]), 'rows', `${name}: cut to the end of the row the caret is on`, { on: on[name], want: BY_ROW[name], thisBrowserWithTheSwitchOff: off[name] });
    else check(same(off[name], on[name]), 'rows', `${name}: the same selection and text as with the switch off`, { off: off[name], on: on[name] });
  }
  // The upper side of a wrap: End on row one, then each key. The editable's
  // own caret is at the start of row two there.
  const UPPER = [
    ['Control+A', 'a', CTRL, ['MoveToBeginningOfParagraph'], { sel: [0, 0] }],
    ['Control+Left', 'ArrowLeft', CTRL, ['MoveToLeftEndOfLine'], { sel: [0, 0] }],
    ['Control+Shift+A', 'A', CTRL | SH, ['MoveToBeginningOfParagraphAndModifySelection'], { sel: [5, 0] }],
    ['Control+E', 'e', CTRL, ['MoveToEndOfParagraph'], { sel: [5, 5], row: 0 }],
    ['Option+Up', 'ArrowUp', ALT, ['MoveBackward', 'MoveToBeginningOfParagraph'], { sel: [0, 0] }],
    ['Option+Down', 'ArrowDown', ALT, ['MoveForward', 'MoveToEndOfParagraph'], { sel: [10, 10], row: 1 }],
    ['Control+N', 'n', CTRL, ['MoveDown'], { sel: [10, 10], row: 1 }],
    ['Control+K', 'k', CTRL, ['DeleteToEndOfParagraph'], { text: 'AAAA BBB CCCC' }],
    ['Cmd+Delete', 'Delete', MOD.meta, ['DeleteToEndOfLine'], { text: 'AAAA BBB CCCC' }],
    ['Cmd+Backspace', 'Backspace', MOD.meta, ['DeleteToBeginningOfLine'], { text: 'BBBB CCCC' }],
    ['paragraph delete back', 'Backspace', MOD.meta | CTRL, ['DeleteToBeginningOfParagraph'], { text: 'BBBB CCCC' }],
  ];
  T.upper = {};
  const model = await ec('typeRows', 'rows');
  for (const [name, k, mods, commands, want] of UPPER) {
    await begin('rows');
    await pressAt(lerp(model.at[0][1], model.at[0][2], 0.2));
    await key('End', { commands: ['moveToEndOfLine'] });
    let st = await typeState(2);
    const from = { sel: st.sel, row: st.caret ? model.rows.findIndex((r) => Math.abs(middle(st.caret).y - model.at[model.rows.indexOf(r)][0].y) < 2) : null };
    await key(k, { mods, commands });
    st = await typeState(3);
    const got = { sel: st.sel, text: st.text, row: st.caret ? model.rows.findIndex((r, i) => Math.abs(middle(st.caret).y - model.at[i][0].y) < 2) : null };
    T.upper[name] = { from, got, want };
    check(same(from, { sel: [5, 5], row: 0 }), 'rows', `${name}: the caret begins on the upper side of the wrap`, from);
    check((want.sel ? same(got.sel, want.sel) : true) && (want.text ? got.text === want.text : got.text === textOf('rows')) && (want.row == null || got.row === want.row), 'rows', `${name} from the upper side of a wrap goes by the drawn row`, { got, want });
    await end();
    if (st.text !== textOf('rows')) {
      await ec('openCustom', spec);
      await bring('rows');
    }
  }
  log(`type2 keys: ${KEYS.length - T.keys.unlike.length} of ${KEYS.length} keys the same with the switch off and on (unlike: ${T.keys.unlike.join(', ') || 'none'}; ${T.keys.byRow.length} are held to the row instead); ${UPPER.length} from the upper side of a wrap`);

  // -- 2. the pointer --
  // The same gestures with the switch off, for what the browser selects.
  await open('rust');
  await bring('small');
  const small = await ec('typeRows', 'small');
  // "WAIT FOR ME" over "OVER THERE!": letters of FOR, ME, WAIT and THERE.
  const P = { for: lerp(small.at[0][5], small.at[0][6], 0.5), me: lerp(small.at[0][9], small.at[0][10], 0.5), wait: lerp(small.at[0][1], small.at[0][2], 0.5), there: lerp(small.at[1][6], small.at[1][7], 0.5), over: lerp(small.at[1][1], small.at[1][2], 0.5) };
  const dragFrom = async (count, from, tos) => {
    for (let c = 1; c < count; c++) {
      await mouse('mousePressed', from, { clickCount: c });
      await mouse('mouseReleased', from, { buttons: 0, clickCount: c });
    }
    await mouse('mousePressed', from, { clickCount: count });
    const out = [(await typeState()).sel];
    for (const to of tos) {
      await mouse('mouseMoved', lerp(from, to, 0.5));
      await mouse('mouseMoved', to);
      out.push((await typeState()).sel);
    }
    await mouse('mouseReleased', tos.at(-1), { buttons: 0, clickCount: count });
    out.push((await typeState()).sel);
    return out;
  };
  const pointer = async (mode) => {
    await open(mode);
    await bring('small');
    await begin('small');
    const out = { presses: {} };
    // Where one press at each of the places goes, to read the drags by.
    for (const [name, p] of Object.entries(P)) {
      await pressAt(p);
      out.presses[name] = (await typeState()).sel?.[1];
      await sleep(450);
    }
    out.words = await dragFrom(2, P.for, [P.me, P.wait, P.there, P.for]);
    await sleep(450);
    out.lines = await dragFrom(3, P.wait, [P.there, P.wait]);
    await sleep(450);
    out.linesUp = await dragFrom(3, P.over, [P.wait, P.over]);
    await sleep(450);
    await end();
    return out;
  };
  const pOff = await pointer('browser');
  const pOn = await pointer('rust');
  T.pointer = { off: pOff, on: pOn };
  const span = (list) => list.map((sel) => (sel ? [Math.min(...sel), Math.max(...sel)] : null));
  const within = (o, a, b) => o >= a && o <= b;
  check(within(pOn.presses.for, 5, 8) && within(pOn.presses.me, 9, 11) && within(pOn.presses.wait, 0, 4) && within(pOn.presses.there, 17, 22) && within(pOn.presses.over, 12, 16), 'small', 'the places pressed are in FOR, ME, WAIT, THERE and OVER', pOn.presses);
  check(same(pOn.words, [[5, 8], [5, 11], [8, 0], [5, 22], [5, 8], [5, 8]]), 'small', 'a drag from a double press goes by words', pOn.words);
  check(same(span(pOn.words), span(pOff.words)), 'small', 'and selects what the browser selects for the same drag', { on: pOn.words, off: pOff.words });
  check(same(span(pOn.lines), span(pOff.lines)) && same(span(pOn.linesUp), span(pOff.linesUp)), 'small', 'a drag from a triple press selects the rows the browser selects', { on: [pOn.lines, pOn.linesUp], off: [pOff.lines, pOff.linesUp] });
  check(pOn.lines[1][1] > pOn.lines[0][1] && pOn.linesUp[1][1] < pOn.linesUp[0][0], 'small', 'a drag from a triple press goes by rows', [pOn.lines, pOn.linesUp]);
  // A drag that leaves the picture: the pointer is the overlay's until it is
  // let go, so the selection follows it over the page.
  await sleep(450);
  await bring('small');
  await begin('small');
  await sleep(450);
  {
    const { box } = await cellFor('small');
    const from = lerp(small.at[0][2], small.at[0][3], 0.2);
    await mouse('mousePressed', from);
    const inside = lerp(small.at[0][6], small.at[0][7], 0.2);
    await mouse('mouseMoved', inside);
    const a = (await typeState()).sel;
    // Well off the box, to its right and below its last row.
    const outside = { x: box.rect.x + box.rect.w + 160, y: box.rect.y + box.rect.h + 90 };
    await mouse('mouseMoved', lerp(inside, outside, 0.5));
    await mouse('mouseMoved', outside);
    const b = (await typeState()).sel;
    await mouse('mouseReleased', outside, { buttons: 0 });
    const c = (await typeState()).sel;
    const len = textOf('small').length;
    T.pointer.leaves = { inside: a, outside: b, released: c, want: [2, len] };
    check(same(a, [2, 6]) && same(b, [2, len]) && same(c, [2, len]), 'small', 'a drag that leaves the picture goes on selecting, to the last row\'s end', T.pointer.leaves);
  }
  await end();
  log(`type2 pointer: words ${JSON.stringify(pOn.words)} (browser ${JSON.stringify(pOff.words)}); rows ${JSON.stringify(pOn.lines)} ${JSON.stringify(pOn.linesUp)}; off the picture ${JSON.stringify(T.pointer.leaves)}`);

  // -- 3. the right button on a curve --
  await bring('upper-arc');
  await begin('upper-arc');
  {
    const curve = await ec('typeRows', 'upper-arc');
    // "straße über uns" is drawn STRASSE ÜBER UNS: glyph 9 is the B of ÜBER.
    await pressAt(curve.glyphs[1].right);
    await ec('menuSeen');
    await pressAt(curve.glyphs[9].left, { button: 'right' });
    let st = await typeState(3);
    const menu = await ec('menuSeen');
    T.menu = { drawn: curve.drawn, mapped: curve.mapped, ...menu, sel: st.sel, nudge: st.nudge };
    check(curve.drawn === 'STRASSE ÜBER UNS' && curve.mapped, 'upper-arc', 'an uppercase curve with a letter cased to two', { drawn: curve.drawn, mapped: curve.mapped });
    check(same(st.sel, [7, 11]), 'upper-arc', 'the right button on a curve selects the word under it, and the system leaves it selected', T.menu);
    check(menu?.inEditable === true && menu.onSelection === true && same(menu.sel, [7, 11]), 'upper-arc', 'the menu is asked of the editable, with that word selected and the pointer on it', menu);
    // On the selection: left alone.
    await sleep(80);
    await ec('menuSeen');
    await pressAt(curve.glyphs[10].right, { button: 'right' });
    st = await typeState(3);
    const again = await ec('menuSeen');
    check(same(st.sel, [7, 11]) && again?.inEditable === true, 'upper-arc', 'on the selection it leaves the selection alone', { sel: st.sel, again });
    // And the editable is back where the caret wants it once the menu is gone.
    await sleep(120);
    await pressAt(curve.glyphs[3].left);
    st = await typeState(3);
    T.menu.after = { sel: st.sel, nativeFromDrawn: caretFromNative(st) };
    check(same(st.sel, [3, 3]) && T.menu.after.nativeFromDrawn != null && T.menu.after.nativeFromDrawn <= 4, 'upper-arc', 'afterwards a press places the caret, with the browser\'s own under it', T.menu.after);
  }
  await end();
  // Letters outside the frame, where the editable under the picture is not:
  // the menu is still the editable's, and is for the word pressed.
  T.menu.outside = {};
  for (const id of ['spill', 'arc-out']) {
    await bring(id);
    await begin(id);
    const m = await ec('typeRows', id);
    const { box } = await cellFor(id);
    const out = (p) => p.x < box.rect.x - 4 || p.x > box.rect.x + box.rect.w + 4 || p.y < box.rect.y - 4 || p.y > box.rect.y + box.rect.h + 4;
    const pts = m.kind === 'flat' ? m.at.flatMap((row, i) => row.slice(0, -1).map((p, k) => ({ p: lerp(p, row[k + 1], 0.25), o: m.rows[i].offs[k] }))) : m.glyphs.map((g, i) => ({ p: g.left, o: i }));
    const far = pts.filter((q) => out(q.p) && /\S/.test(textOf(id)[q.o] ?? ''));
    const q = far[Math.floor(far.length / 2)];
    await pressAt(pts[1].p);
    await sleep(450);
    await ec('menuSeen');
    await pressAt(q.p, { button: 'right' });
    const st = await typeState(3);
    const menu = await ec('menuSeen');
    const word = textOf(id).slice(Math.min(...st.sel), Math.max(...st.sel));
    T.menu.outside[id] = { lettersOutsideTheFrame: far.length, of: pts.length, pressed: q.o, sel: st.sel, word, menu };
    check(far.length > 0 && !/\s/.test(word) && word.length > 1 && Math.min(...st.sel) <= q.o && q.o < Math.max(...st.sel), id, 'the right button on a letter outside the frame selects its word', T.menu.outside[id]);
    check(menu?.inEditable === true && menu.onSelection === true && same(menu.sel, st.sel), id, 'and the menu is asked of the editable, on that selection', menu);
    await end();
  }
  log(`type2 menu: ${JSON.stringify(T.menu)}`);

  // -- 4. the engine coming on, and going off, in the middle of an edit --
  {
    await open('browser');
    await bring('bold');
    await begin('bold');
    const m0 = await typeState();
    await ec('typeSelect', 9);
    const offStyle = (await typeState()).nudge;
    await ec('engine', 'rust');
    await ec('wait', 6);
    let st = await ec('typeSelect', 9);
    const mid = { overlay: st.overlay, unseen: st.unseen, focused: st.focused, sel: st.sel, nativeFromDrawn: caretFromNative(st), nudge: st.nudge };
    // And what an edit begun with the engine on has at the same offset.
    await end();
    await begin('bold');
    st = await ec('typeSelect', 9);
    const fresh = { nativeFromDrawn: caretFromNative(st), nudge: st.nudge };
    // Off again in the middle of this one.
    await ec('engine', 'browser');
    await ec('wait', 6);
    st = await ec('typeSelect', 9);
    const back = { overlay: st.overlay, unseen: st.unseen, editable: st.editable, nudge: st.nudge };
    await end();
    T.midEdit = { beganAs: { overlay: m0.overlay, unseen: m0.unseen }, offStyle, mid, fresh, back };
    check(m0.editable && !m0.unseen && m0.overlay == null, 'bold', 'the edit began as DOM text', T.midEdit.beganAs);
    check(mid.overlay === 'flat' && mid.unseen && mid.focused, 'bold', 'the engine coming on makes it the picture, in the same edit', mid);
    check(mid.nativeFromDrawn != null && mid.nativeFromDrawn <= 4, 'bold', 'and the browser\'s own caret is brought within 4 CSS px of the drawn one', mid);
    check(mid.nudge !== '' && mid.nudge === fresh.nudge, 'bold', 'by the same distance as in an edit begun with the engine on', { mid: mid.nudge, fresh: fresh.nudge });
    check(back.editable && !back.unseen && back.overlay == null && back.nudge === offStyle, 'bold', 'the switch going off mid-edit leaves the editable where it is with the switch off', { back, offStyle });
    log(`type2 mid-edit: on ${JSON.stringify(mid)}; fresh ${JSON.stringify(fresh)}; off again ${JSON.stringify(back)} (switch-off style ${JSON.stringify(offStyle)})`);
  }

  // -- 5. a letter cased to two, the line broken between the two --
  await open('rust');
  await bring('split');
  await begin('split');
  {
    const m = await ec('typeRows', 'split');
    const rows = m.rows.map((r) => ({ offs: r.offs, lead: r.lead?.o ?? null, trail: r.trail?.o ?? null, soft: r.soft }));
    const a = m.rows.findIndex((r) => r.trail);
    const b = m.rows.findIndex((r) => r.lead);
    T.split = { lines: m.lines, rows };
    check(a >= 0 && b === a + 1, 'split', 'the line is broken between the two letters one is drawn as', T.split);
    if (a >= 0 && b >= 0) {
      const A = m.rows[a];
      const B = m.rows[b];
      const [lo, hi] = [B.lead.o, A.trail.o];
      // The letter selected: a rectangle on each row.
      let st = await ec('typeSelect', lo, hi);
      T.split.selected = { sel: st.sel, marks: st.sels.map((r) => [Math.round(r.y), Math.round(r.w)]) };
      check(st.sels.length === 2 && Math.abs(st.sels[0].y - st.sels[1].y) > 4 && st.sels.every((r) => r.w > 4), 'split', 'the letter selected is marked on both rows', T.split.selected);
      // A caret at either side of it, on either side of the wrap: never
      // between the halves.
      const carets = [];
      for (const o of [lo, hi]) {
        st = await ec('typeSelect', o);
        carets.push({ o, at: st.caret && [+(middle(st.caret).x).toFixed(1), +(middle(st.caret).y).toFixed(1)] });
      }
      const between = [A.trail.p, B.lead.p];
      T.split.carets = carets;
      T.split.between = between.map((p) => [+p.x.toFixed(1), +p.y.toFixed(1)]);
      check(carets.every((c) => c.at && between.every((p) => Math.hypot(c.at[0] - p.x, c.at[1] - p.y) > 3)), 'split', 'no caret is drawn between the two halves', T.split);
      // A press on each half goes to the nearer side of the whole letter.
      const halfA = lerp(m.at[a][A.xs.length - 1], A.trail.p, 0.75);
      const halfB = lerp(B.lead.p, m.at[b][0], 0.25);
      await pressAt(halfA);
      const pa = await typeState();
      await pressAt(halfB);
      const pb = await typeState();
      T.split.presses = { rightOfFirst: pa.sel, leftOfSecond: pb.sel, want: [[hi, hi], [lo, lo]] };
      check(same(pa.sel, [hi, hi]) && same(pb.sel, [lo, lo]), 'split', 'a press on a half goes to the nearer side of the whole letter', T.split.presses);
      // And typing there goes where the caret is drawn.
      await pressAt(halfA);
      await key('x', { text: 'x' });
      st = await typeState(3);
      const text0 = textOf('split');
      T.split.typed = st.text;
      check(st.text === text0.slice(0, hi) + 'x' + text0.slice(hi), 'split', 'a letter typed after it goes after it', st.text);
    }
  }
  await end();
  log(`type2 split: ${JSON.stringify(T.split)}`);

  // -- 6. the budget a key's paint is given --
  // At 300%: the large box is over a megapixel, the balloon is not.
  await open('rust', 3);
  {
    const B = (T.budget = {});
    const mp = (c) => (c ? +((c.w * c.h) / 1e6).toFixed(3) : null);
    // The balloon: the same bytes as the exporter's straight after a key,
    // with no pause, and nothing painted after it.
    await bring('small');
    await begin('small');
    await pressAt((await ec('typeHalves', 'small'))[6].p);
    let st = await typeState();
    const rest = st.canvas;
    await key('q', { text: 'q' });
    await ec('wait', 1);
    const now = await ec('typeSame', 'small');
    st = await ec('typeState');
    const during = st.canvas;
    await sleep(400);
    const later = await ec('typeSame', 'small');
    st = await typeState();
    B.small = { atRestMP: mp(rest), afterKeyMP: mp(during), afterKey: now, afterPause: later, afterPauseMP: mp(st.canvas) };
    check(now.painted && now.bytes === 0 && same(now.editor, now.exporter), 'small', 'a box under the budget is the exporter\'s bytes straight after a key', now);
    check(mp(during) === mp(rest) && later.bytes === 0 && mp(st.canvas) === mp(rest), 'small', 'and is the same canvas after the pause', B.small);
    await key('Backspace', { commands: ['deleteBackward'] });
    await end();
    // The large box.
    await bring('big');
    await begin('big');
    await pressAt((await ec('typeHalves', 'big'))[6].p);
    st = await typeState(2);
    const big0 = st.canvas;
    const caret0 = st.caret;
    // What the picture is while keys are coming is read IN the page, at the
    // first frame after the key: this script, on a loaded machine, can take
    // longer than the pause to look.
    const inPause = (seen) => seen.find((x) => x.ms < 140) ?? null;
    await ec('picturesSeen');
    await key('q', { text: 'q' });
    await ec('wait', 1);
    st = await ec('typeState');
    const soft = inPause(await ec('picturesSeen'));
    const caret1 = st.caret;
    await sleep(400);
    st = await typeState(2);
    const sharp = st.canvas;
    const sharpSame = await ec('typeSame', 'big');
    const caret2 = st.caret;
    B.big = { atRestMP: mp(big0), afterKeyMP: mp(soft), afterPauseMP: mp(sharp), afterPause: sharpSame, caret: [caret0, caret1, caret2].map((c) => c && [+c.x.toFixed(2), +c.y.toFixed(2), +c.h.toFixed(2)]) };
    check(mp(big0) > 1.1, 'big', 'the large box is over the budget at rest', B.big);
    check(soft && mp(soft) <= 1.08 && mp(soft) < mp(big0), 'big', 'while keys are coming it is painted within a megapixel', { soft, atRest: mp(big0) });
    check(mp(sharp) === mp(big0) && sharpSame.painted && sharpSame.bytes === 0, 'big', 'after the pause it is renderBoxTexture, byte for byte', sharpSame);
    check(caret1 && caret2 && Math.abs(caret1.x - caret2.x) < 0.01 && Math.abs(caret1.y - caret2.y) < 0.01 && Math.abs(caret1.h - caret2.h) < 0.01, 'big', 'the caret does not move when the picture is painted in full', B.big.caret);
    // A composition in the large box: soft while it is composed, in full
    // after a pause with the composition still open, and it ends as it did.
    const text1 = st.text;
    const co = st.sel[1];
    await sleep(700);
    await ec('picturesSeen');
    await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 });
    await ec('wait', 1);
    const compSoft = inPause(await ec('picturesSeen'));
    await sleep(400);
    st = await typeState(2);
    const compSame = await ec('typeSame', 'big');
    const comp = { softMP: mp(compSoft), sharpMP: mp(st.canvas), held: st.held === text1.slice(0, co) + 'かな' + text1.slice(co), boxText: st.text === text1, underlines: st.comps.length, picture: compSame };
    await cdp.send('Input.insertText', { text: '仮名' });
    st = await typeState(3);
    await sleep(400);
    const done = await ec('typeSame', 'big');
    st = await typeState();
    comp.committed = st.text === text1.slice(0, co) + '仮名' + text1.slice(co) && st.comps.length === 0;
    comp.committedPicture = done;
    B.composition = comp;
    check(compSoft && comp.softMP <= 1.08 && comp.held && comp.boxText && comp.underlines > 0, 'big', 'a composition is painted within the budget while it is composed, and is not yet the box\'s text', comp);
    check(comp.sharpMP === mp(big0) && compSame.painted && compSame.bytes === 0 && compSame.composing, 'big', 'and in full after the pause, from the composed text', compSame);
    check(comp.committed && done.painted && done.bytes === 0 && !done.composing, 'big', 'the composition ended is the box\'s text and its picture', { committed: comp.committed, done });
    // The edit ending inside the pause: in full at once.
    await ec('endAtNextEdit');
    await key('w', { text: 'w' });
    await ec('wait', 2);
    const endSeen = await ec('endSeen');
    const ended = await ec('typeSame', 'big');
    B.ending = { ...endSeen, beforeMP: mp(endSeen.before), afterMP: mp(endSeen.after), after: ended };
    check(endSeen.ms < 140 && endSeen.editing == null && endSeen.sameCanvas && B.ending.beforeMP <= 1.08 && B.ending.afterMP === mp(big0), 'big', 'the edit ending inside the pause paints it in full at once', B.ending);
    check(ended.painted && ended.bytes === 0 && same(ended.editor, ended.exporter), 'big', 'and what it painted is renderBoxTexture, byte for byte', ended);
    log(`type2 budget: balloon ${B.small.atRestMP} MP at rest, ${B.small.afterKeyMP} after a key (bytes unlike the exporter ${now.bytes}); large box ${B.big.atRestMP} MP at rest, ${B.big.afterKeyMP} at the frame after a key (${soft ? soft.ms.toFixed(0) : '?'} ms after it), ${B.big.afterPauseMP} after the pause (bytes unlike ${sharpSame.bytes}); composing ${comp.softMP} then ${comp.sharpMP} MP (bytes unlike ${compSame.bytes}); ended ${endSeen.ms.toFixed(0)} ms after a key: ${B.ending.beforeMP} MP then ${B.ending.afterMP} at once, bytes unlike ${ended.bytes}`);
  }
  await ec('zoom', 1);
  check(cdp.errors.length === errorsBefore, 'type2', 'no page error', cdp.errors.slice(errorsBefore));
  T.verdict = { checks: T.checks, failed: T.fails.length };
  log(`type2 verdict (${DSF}x): ${T.checks - T.fails.length} of ${T.checks} checks passed, ${T.fails.length} failed`);
  for (const f of T.fails) log(`  FAILED ${f.id}: ${f.what} ${JSON.stringify(f.detail).slice(0, 600)}`);
}

if (ONLY.has('typecost')) {
  // What a keystroke costs: to the end of its effects (for a pictured box, the
  // paint) and to the next frame, on three sizes of box, at 100% and 300%,
  // with the switch on and off.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await viewport(WINDOW.w, WINDOW.h);
  const spec = await ec('spec', 'typeCost');
  report.typeCost = {};
  const ms = (st) => `${st.median.toFixed(1)} (${st.min.toFixed(1)}-${st.max.toFixed(1)})`;
  for (const mode of ['browser', 'rust']) {
    await ec('engine', mode);
    await ec('openCustom', spec);
    const out = (report.typeCost[mode === 'rust' ? 'on' : 'off'] = {});
    for (const zoom of [1, 3]) {
      await ec('zoom', zoom);
      for (const id of ['balloon', 'effect', 'page-wide', 'long-line']) {
        await ec('reveal', id);
        // The rows of the box, made from its text: what the caret is drawn by.
        const rows = mode === 'rust' ? await ec('timeModel', id, 9) : null;
        // And its paint alone, in full and within the budget a key is given.
        const paint = mode === 'rust' ? await ec('timePaint', id, 7) : null;
        await ec('edit', id);
        const r = await ec('timeType', id === 'long-line' ? 6 : 20);
        r.rows = rows;
        r.paint = paint;
        // And from real keys: heard by the page to the first frame after.
        await ec('keyTimes', true);
        for (let i = 0; i < 12; i++) {
          await key('a', { text: 'a' });
          await sleep(60);
        }
        for (let i = 0; i < 12; i++) {
          await key('Backspace', { commands: ['deleteBackward'] });
          await sleep(60);
        }
        const keys = (await ec('keyTimes', false)).filter((k) => k.task != null && k.frame != null);
        const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? null;
        r.realKeys = { n: keys.length, taskMedian: med(keys.map((k) => k.task)), taskMax: Math.max(...keys.map((k) => k.task)), frameMedian: med(keys.map((k) => k.frame)), frameMax: Math.max(...keys.map((k) => k.frame)) };
        await ec('endEdit');
        await ec('select', null);
        out[`${id}@${zoom * 100}%`] = r;
        const mp = (c) => (c ? `${((c[0] * c[1]) / 1e6).toFixed(2)} MP` : 'none');
        log(`typecost / switch ${mode === 'rust' ? 'ON ' : 'OFF'} ${id.padEnd(9)} at ${zoom * 100}%: a keystroke ${r.error ?? ms(r.sync)} ms to the end of its effects, ${r.error ? '' : ms(r.toNextFrame)} to the next frame; canvas ${mp(r.canvas)} at rest, ${mp(r.during)} while keys come${r.soft ? `, ${mp(r.afterKey)} after one key and ${mp(r.afterPause)} after the pause; the edit ending inside the pause ${r.endingMs.toFixed(1)} ms` : `; the edit ending ${r.endingMs?.toFixed(1)} ms`}${rows ? `; rows of ${rows.letters} letters (${rows.rows} rows, ${rows.stops} stops) ${ms(rows.ms)} ms; the paint alone ${ms(paint.full)} ms at ${paint.fullMP} MP, ${ms(paint.key)} ms at ${paint.keyMP} MP` : ''}; real keys (n ${r.realKeys.n}): task ${r.realKeys.taskMedian?.toFixed(1)} median, ${r.realKeys.taskMax.toFixed(1)} max; to the frame ${r.realKeys.frameMedian?.toFixed(1)} median`);
      }
    }
  }
}

report.pageErrors = cdp.errors;
report.finished = new Date().toISOString();
writeFileSync(join(OUT, `report-${DSF}x.json`), JSON.stringify(report, null, 2));
log(`wrote ${join(OUT, `report-${DSF}x.json`)}; page errors: ${cdp.errors.length}`);
for (const e of cdp.errors.slice(0, 12)) log('  page error:', String(e).slice(0, 300));
cleanup();
process.exit(0);
