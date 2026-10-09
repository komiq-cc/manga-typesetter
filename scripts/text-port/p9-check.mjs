#!/usr/bin/env node
// The first-open check of P9, in a real browser: what the app shows and what
// it would write when a chapter lettered under the browser is met by the Rust
// text engine. Drives p9-check.html (src/test/p9-check/host.js) in a headless
// Chromium over the DevTools protocol, as scripts/editor-check.mjs drives its
// page.
//
//   node scripts/text-port/p9-check.mjs --data <tp-data> [--out <tp-data>/reports/p9/check]
//        [--chapter tsukimichi__122] [--legacy-mode smart] [--chrome <path>]
//
// It starts its own Vite on port 5205 and stops it when it is done; the
// browser's DevTools port is 9383. `--data` is only read, through a server
// bound to 127.0.0.1 that answers the check page's origin and nobody else.
// Written under `--out`: pictures of the queue (they show chapter text: keep
// them out of the repository) and check.json, which holds numbers only.
//
// The page has no filesystem. Its saver is one that stamps the version as the
// app's does and counts; that a real file is not touched is the business of
// src/lib/first-fit.engine.test.js.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : acc), []),
);
if (!args.data) {
  console.error('--data <tp-data> is required');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = resolve(args.data);
const OUT = resolve(args.out ?? join(DATA, 'reports', 'p9', 'check'));
const CHAPTER = args.chapter ?? 'tsukimichi__122';
const LEGACY = args['legacy-mode'] ?? 'smart';
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VITE_PORT = 5205;
const DEVTOOLS_PORT = 9383;
const URL_BASE = `http://localhost:${VITE_PORT}`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---- what is started here, and stopped here ----
const vite = spawn(join(ROOT, 'node_modules/.bin/vite'), ['--port', String(VITE_PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
const profile = mkdtempSync(join(tmpdir(), 'p9-check-'));
let chrome = null;
let dataServer = null;
let closing = false;
function cleanup() {
  if (closing) return;
  closing = true;
  for (const child of [chrome, vite]) {
    try {
      child?.kill();
    } catch {
      /* gone already */
    }
  }
  dataServer?.close();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300).unref?.();
}
process.on('exit', cleanup);
process.on('SIGINT', () => (cleanup(), process.exit(130)));
process.on('SIGTERM', () => (cleanup(), process.exit(143)));

async function viteUp() {
  for (let i = 0; i < 300; i++) {
    if (vite.exitCode != null) throw new Error(`Vite did not start on port ${VITE_PORT} (is it taken?): ${viteLog.trim().split('\n').slice(-2).join(' | ')}`);
    try {
      if ((await fetch(`${URL_BASE}/p9-check.html`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`Vite did not answer on port ${VITE_PORT}`);
}

async function connect() {
  let target;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
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

const failures = [];
function check(name, ok, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

try {
  await viteUp();
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEVTOOLS_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1500,1000', '--force-device-scale-factor=2', 'about:blank',
  ], { stdio: 'ignore' });
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const p9 = async (name, ...a) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `window.__p9[${JSON.stringify(name)}](...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shot = async (name, rect = null) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(rect ? { clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } } : {}) });
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
    return name;
  };

  // ---- the user's fonts and one chapter copy, read-only ----
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
  const dataBase = `http://127.0.0.1:${dataServer.address().port}`;

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 0, mobile: false });
  await cdp.send('Page.navigate', { url: `${URL_BASE}/p9-check.html` });
  for (let i = 0; ; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    if (r.result.value === 'p9 ready') break;
    if (i > 300) throw new Error(`the check page did not come up: ${cdp.errors.slice(-3).join(' | ')}`);
    await sleep(100);
  }

  const report = { chapter: CHAPTER, legacyMode: LEGACY, steps: {} };
  report.boot = await p9('boot');
  if (!report.boot.available) throw new Error('the wasm is not built: npm run build:engine');
  // The user's fonts: every face of fonts.json that is not one of the
  // repository's fixtures (those stand for built-ins, which the app has no file of).
  const fonts = JSON.parse(readFileSync(join(DATA, 'fonts', 'fonts.json'), 'utf8')).fonts.filter((f) => !/^src\/test\/fonts\//.test(f.source));
  report.fontFaces = await p9('addFonts', fonts.map((f) => ({ family: f.family, slot: f.slot, file: f.file })), dataBase);
  report.file = await p9('fetchChapter', `${dataBase}/chapters/${encodeURIComponent(CHAPTER)}.json`, LEGACY);
  log(`chapter ${CHAPTER}: version in file ${report.file.version ?? 'none'}, mode ${report.file.mode}; ${report.fontFaces} font faces loaded`);
  const queue = await p9('queueRect');

  // 1. As today: the switch off. No notice, and leaving writes at version 1.
  report.steps.browser = { engine: await p9('engine', 'browser'), open: await p9('open'), state: await p9('state') };
  const browserGeometry = JSON.stringify(await p9('geometry'));
  check('browser: no notice, nothing noted', !report.steps.browser.state.notice && !report.steps.browser.state.firstFit.open);
  await shot('1-browser.png', queue);

  // 2. The switch turned on over the open chapter.
  const on = await p9('engine', 'rust');
  check('the Rust engine measures', on.phase === 'on' && on.measuring === 'rust', `last resort ${on.lastResort}`);
  await p9('wait', 1100);
  const over = await p9('state');
  report.steps.switchedOnOverOpen = { engine: on, state: over };
  check('switch on over an open chapter: the notice is there', !!over.notice, over.notice?.what ?? '');
  check('switch on over an open chapter: not marked unsaved, nothing written after the debounce', over.saved && over.saves.length === 0);
  await shot('2-switched-on.png', queue);

  // 3. Off again: the boxes are the browser's again.
  await p9('engine', 'browser');
  const backGeometry = JSON.stringify(await p9('geometry'));
  const off = await p9('state');
  report.steps.switchedOff = { state: off, sameAsBefore: backGeometry === browserGeometry };
  check('switch off: every box as the browser had it, no notice, nothing written', backGeometry === browserGeometry && !off.notice && off.saves.length === 0);
  await p9('close');

  // 4. The switch on, and the chapter opened from the file.
  await p9('engine', 'rust');
  const opened = await p9('open');
  await p9('wait', 1100);
  const first = await p9('state');
  report.steps.openedUnderRust = { open: opened, state: first };
  check('opened under the Rust engine: the notice is there', !!first.notice, first.notice?.what ?? '');
  check('opened under the Rust engine: not marked unsaved, nothing written after the debounce', first.saved && first.saves.length === 0);
  check('the notice says nothing is saved yet, and offers Show first and Keep', /Nothing is saved until/.test(first.notice?.note ?? '') && first.notice?.buttons.join(',') === 'Show first,Keep');
  await shot('3-opened-notice.png', queue);
  await shot('3-opened-window.png');

  // Leaving it untouched.
  await p9('leave');
  const left = await p9('state');
  report.steps.leftUntouched = { saves: left.saves.length };
  check('leaving untouched writes nothing', left.saves.length === 0);

  // 5. The way through the boxes: Show first, and the review list.
  const pressed = first.changes?.first ? await p9('press', 'Show first') : false;
  const shown = await p9('state');
  const list = await p9('openList');
  report.steps.stepThrough = { showFirst: pressed, pageIndex: shown.pageIndex, selected: shown.selected, list, listed: shown.listed, listedForLines: shown.listedForLines, flagged: shown.flagged };
  if (first.changes?.first) check('Show first selects a box', pressed && shown.selected);
  check('the review list holds the flagged boxes and the ones whose lines moved', !!list && list.rows === shown.listed && shown.listed === shown.flagged + shown.listedForLines, list ? `${list.head}; ${JSON.stringify(list.reasons)}` : 'no list');
  check('the boxes the notice counts for lines are the rows added to the list', shown.listedForLines <= (first.changes?.relaid ?? 0));
  await shot('4-review-list.png', queue);
  await shot('4-review-window.png');

  // 6. Keep.
  const keepPressed = await p9('press', 'Keep');
  const keptState = await p9('state');
  report.steps.kept = { pressed: keepPressed, state: keptState };
  check('Keep writes once, at version 2, and the notice goes', keepPressed && keptState.saves.length === 1 && keptState.saves[0] === 2 && !keptState.notice);
  check('the rows for moved lines go with the notice', keptState.listedForLines === 0 && keptState.listed === keptState.flagged);
  await shot('5-kept.png', queue);

  // 7. The kept chapter opened again: nothing to say. Then back under the browser.
  await p9('close');
  const again = await p9('openKept');
  const againState = await p9('state');
  report.steps.keptReopened = { open: again, state: againState };
  check('a version 2 chapter opens with no notice', !againState.notice && !againState.firstFit.open && againState.version === 2);
  await p9('close');
  await p9('engine', 'browser');
  await p9('openKept');
  const under = await p9('state');
  await p9('leave');
  const underLeft = await p9('state');
  report.steps.keptUnderBrowser = { opened: under, left: underLeft };
  check('a version 2 chapter under the browser: no notice; leaving saves it at version 1', !under.notice && underLeft.saves.length === 2 && underLeft.saves[1] === 1);

  // 8. A handle held down (the second round). The real TextBox writes the box
  // as the pointer moves and marks the chapter unsaved when the handle is let
  // go. In between the document has changed and still reads "saved": leaving
  // then must write it, and the notice must not count the user's own height
  // as the engine's.
  await p9('close');
  await p9('engine', 'rust');
  await p9('open');
  await p9('wait', 300);
  const grabbed = await p9('grab', 's');
  if (check('a box the engine left as the file has it can be taken by its bottom handle', !!grabbed)) {
    const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
    const before = await p9('held', grabbed.page, grabbed.index);
    await mouse('mousePressed', grabbed.x, grabbed.y, 1);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', grabbed.x, grabbed.y + i * 10, 1);
    await p9('wait', 100);
    const held = await p9('held', grabbed.page, grabbed.index);
    check('held down: the box is taller, and the chapter still reads as saved', held.box[3] > before.box[3] && held.saved, `height ${before.box[3]} to ${held.box[3]}`);
    check('held down: the notice does not count the user\'s height as the engine\'s', held.changes?.grew === before.changes?.grew, `grew ${before.changes?.grew} then ${held.changes?.grew}`);
    // Quit, or the window going away, with the button still down: the flush.
    await p9('leave');
    const flushed = await p9('held', grabbed.page, grabbed.index);
    const written = await p9('keptBox', grabbed.page, grabbed.index);
    check('leaving with the handle still held writes the box as the hand has it', flushed.saves === before.saves + 1 && !!written && written[3] === held.box[3], `saves ${before.saves} to ${flushed.saves}; written height ${written?.[3]}`);
    await mouse('mouseReleased', grabbed.x, grabbed.y + 60, 0);
    await p9('wait', 1100);
    const let_go = await p9('held', grabbed.page, grabbed.index);
    check('let go: still not counted as grown by the engine', let_go.changes?.grew === before.changes?.grew, `grew ${let_go.changes?.grew}`);
    report.steps.handleHeld = { before, held, flushed, written, letGo: let_go };
    await shot('6-handle-held.png');
  }

  report.errors = cdp.errors.slice(0, 20);
  report.failures = failures;
  writeFileSync(join(OUT, 'check.json'), JSON.stringify(report, null, 2) + '\n');
  log(`first open of ${CHAPTER} under the Rust engine: ${opened.boxes} boxes, load ${opened.ms} ms (browser: ${report.steps.browser.open.ms} ms; version 2: ${again.ms} ms)`);
  log(`notice: ${first.notice?.what ?? 'none'}`);
  log(`${failures.length ? `${failures.length} FAILED` : 'all passed'}; written to ${OUT}`);
  if (cdp.errors.length) log(`page errors: ${cdp.errors.slice(0, 5).join(' | ')}`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
