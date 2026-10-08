#!/usr/bin/env node
// Drives the editor check page (editor-check.html, src/test/editor-check/host.js)
// in a headless Chromium over the DevTools protocol, and writes what it saw.
//
//   npm run dev -- --port 5201 --strictPort          (in another shell)
//   node scripts/editor-check.mjs --data <tp-data> [--url http://localhost:5201]
//        [--out <tp-data>/reports/p6] [--only bytes,export,look,edit,cost,real]
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
const ONLY = new Set((args.only ?? 'bytes,export,look,edit,cost,real').split(','));
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
    scaleFollowed: rows.every((r) => r.scale === 2 && r.painted && r.bytes === 0),
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

async function costs(label, resizeId) {
  const out = {};
  for (const mode of ['browser', 'rust']) {
    await ec('engine', mode);
    const m = {};
    for (const z of [0.6, 1, 3]) {
      await viewport(1600, 1000);
      await ec('zoom', z);
      await sleep(300);
      m[`held@${z * 100}%`] = await ec('held');
    }
    await viewport(1600, 1000);
    await ec('zoom', 1);
    m.mount = await ec('timeMount', 5);
    m.repaintAll = await ec('timeRepaintAll', 6);
    m.resize = await ec('timeResize', resizeId, 30);
    m.zoomGesture = await ec('timeZoomGesture', 0.8, 1.6, 12);
    m.turn = await ec('timeTurn', 4);
    await ec('zoom', 1);
    out[mode] = m;
    log(`${label} / ${mode}: mount ${JSON.stringify(m.mount.sync)} repaint-all ${JSON.stringify(m.repaintAll.sync)} resize ${JSON.stringify(m.resize)} zoom tick ${JSON.stringify(m.zoomGesture.tick)} settle ${m.zoomGesture.settle.toFixed(1)}`);
    log(`   turn ${JSON.stringify(m.turn)} held ${Object.entries(m).filter(([k]) => k.startsWith('held')).map(([k, v]) => `${k}: ${(v.bytes / 1048576).toFixed(1)} MB in ${v.withPixels}/${v.canvases} canvases, ${v.boxElements} elements`).join(' | ')}`);
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
  report.real.cost = await costs('real page', String(chapter.pages[busiest].boxes[0].id));
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

report.pageErrors = cdp.errors;
report.finished = new Date().toISOString();
writeFileSync(join(OUT, `report-${DSF}x.json`), JSON.stringify(report, null, 2));
log(`wrote ${join(OUT, `report-${DSF}x.json`)}; page errors: ${cdp.errors.length}`);
for (const e of cdp.errors.slice(0, 12)) log('  page error:', String(e).slice(0, 300));
cleanup();
process.exit(0);
