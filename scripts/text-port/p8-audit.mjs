// The P8 audit: which browser text calls the app still makes, and from where.
//
//   node scripts/text-port/p8-audit.mjs --data <tp-data> [--out <tp-data>/reports/p8]
//        [--chapter tsukimichi__121] [--chrome <path>] [--only browser,rust]
//
// It starts its own Vite on port 5204 and its own headless Chromium on
// DevTools port 9382, loads THE APP (index.html, nothing stood in front of
// it), and counts every call to
//
//   CanvasRenderingContext2D.prototype.measureText / fillText / strokeText
//   (and the same three of an OffscreenCanvas context)
//   document.fonts.load / .check / .ready, new FontFace
//   Range.prototype.getClientRects / getBoundingClientRect
//
// by the line of the app that made it, while the app is driven through a
// user's session: a real chapter opened, pages turned, a box selected, moved
// and resized with the mouse, its font, size and style changed in the
// Inspector, auto-fit, auto-typeset of a page, and the three exports - PNG,
// PSD, .mtchapter. Twice: with the preference `textEngine` at 'browser', and
// at 'rust'. The two tables go to <out>/audit.md, the counts to audit.json.
//
// WHAT IS STOOD IN FOR, because a plain browser has no Tauri:
//
// - The library. A chapter is a folder on disk the app reads through Tauri;
//   here the chapter's record (a copy under <data>/chapters, served read-only
//   by this script's Vite) is handed to the store by the same calls the
//   library makes after reading it. The pages have no art: boxes on white.
// - The .mtchapter export reads the chapter's files from disk before it
//   builds anything. Here the steps after that read are run as they are
//   written in `exportChapterPackage` (package-flow.js) - the fonts
//   gathered, the package built, what stays behind worked out, and the
//   package inspected as an import would - with a one-pixel picture a page.
// - System fonts. There are none outside Tauri: every family is a file of
//   the user's (<data>/fonts), loaded the way a user loads one.
//
// TYPING INTO A BOX IS LEFT OUT. It is another phase's (P7) and its calls
// are that phase's to count.
//
// After the second run, with the engine still on, the script writes a PSD of
// untouched pages of the chapter, reads it back with ag-psd, and sets every
// type layer against what the engine's painter was handed for that box
// (<out>/psd-proof.md, and the .psd beside it).
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { readPsd } from 'ag-psd';

const VITE_PORT = 5204;
const CDP_PORT = 9382;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : acc), []));
if (!args.data) {
  process.stderr.write('usage: node scripts/text-port/p8-audit.mjs --data <tp-data> [--out dir] [--chapter name]\n');
  process.exit(2);
}
const DATA = resolve(args.data);
const OUT = resolve(args.out ?? join(DATA, 'reports', 'p8'));
const CHAPTER = args.chapter ?? 'tsukimichi__121';
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MODES = (args.only ?? 'browser,rust').split(',');
const BASE = `http://localhost:${VITE_PORT}`;
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- the server
// The app, served as `npm run dev` serves it, and the user's fonts and
// chapters beside it, read-only, under a path nothing of the app asks for.
const vite = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { port: VITE_PORT, strictPort: true, host: 'localhost' },
  plugins: [{
    name: 'p8-audit-data',
    configureServer(server) {
      server.middlewares.use('/__p8', (req, res) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = resolve(DATA, '.' + path);
        const ok = req.method === 'GET' && /^\/(fonts|chapters)\/[^/]+$/.test(path) && file.startsWith(DATA + sep) && existsSync(file) && statSync(file).isFile();
        if (!ok) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  }],
});
await vite.listen();

// --------------------------------------------------------------- the browser
const profile = mkdtempSync(join(tmpdir(), 'p8-audit-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1700,1100', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' });
let done = false;
async function stop(code) {
  if (done) return;
  done = true;
  try {
    chrome.kill();
  } catch { /* gone */ }
  await vite.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => stop(130));

let target;
for (let i = 0; i < 100 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page');
  } catch { /* not up yet */ }
  if (!target) await sleep(100);
}
if (!target) {
  process.stderr.write('no Chromium page on the DevTools port\n');
  await stop(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const waiting = new Map();
const pageErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { res, rej } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else res(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  waiting.set(++seq, { res, rej });
  ws.send(JSON.stringify({ id: seq, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const call = (fn, ...a) => evaluate(`window.__p8.${fn}(${a.map((x) => JSON.stringify(x)).join(',')})`);

// ------------------------------------------------------------ what is counted
// Runs before any script of the page. A call is charged to the first frame of
// its stack that is a file of the app's server; the frames of this script
// have no address and fall away by themselves.
const COUNTERS = `(() => {
  Error.stackTraceLimit = 40;
  const A = (window.__p8a = { phase: 'boot', counts: {}, samples: {}, blobs: [] });
  function note(api) {
    const frames = [];
    for (const line of new Error().stack.split('\\n').slice(1)) {
      const m = /^at (?:(?:async )?(.*?) \\()?(https?:\\/\\/[^\\s)]+?):(\\d+):(\\d+)\\)?$/.exec(line.trim());
      if (!m) continue;
      frames.push([m[1] || '', m[2], +m[3], +m[4]]);
      if (frames.length >= 6) break;
    }
    const top = frames[0];
    const key = A.phase + '|' + api + '|' + (top ? top[1] + ':' + top[2] + ':' + top[3] : '(no frame of the app)');
    A.counts[key] = (A.counts[key] || 0) + 1;
    if (!A.samples[key]) A.samples[key] = frames;
  }
  const wrap = (proto, name, api) => {
    const real = proto[name];
    proto[name] = function (...a) {
      note(api);
      return real.apply(this, a);
    };
  };
  for (const name of ['measureText', 'fillText', 'strokeText']) {
    wrap(CanvasRenderingContext2D.prototype, name, name);
    if (self.OffscreenCanvasRenderingContext2D) wrap(OffscreenCanvasRenderingContext2D.prototype, name, 'offscreen ' + name);
  }
  wrap(FontFaceSet.prototype, 'load', 'document.fonts.load');
  wrap(FontFaceSet.prototype, 'check', 'document.fonts.check');
  const ready = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, 'ready');
  Object.defineProperty(FontFaceSet.prototype, 'ready', { ...ready, get() { note('document.fonts.ready'); return ready.get.call(this); } });
  window.FontFace = new Proxy(window.FontFace, { construct(t, a) { note('new FontFace'); return new t(...a); } });
  wrap(Range.prototype, 'getClientRects', 'Range.getClientRects');
  wrap(Range.prototype, 'getBoundingClientRect', 'Range.getBoundingClientRect');
  // What the app hands the browser to save is kept, so an export can be read back.
  const make = URL.createObjectURL;
  URL.createObjectURL = function (b) { if (b instanceof Blob) A.blobs.push(b); return make.call(URL, b); };
})();`;

// ------------------------------------------------------------- the page side
// A module of the page, so that it shares the app's own module instances.
const PAGE = `
import * as st from '/src/lib/store.svelte.js';
import * as rt from '/src/lib/route.svelte.js';
import * as fonts from '/src/lib/fonts.js';
import * as sw from '/src/lib/engine-switch.svelte.js';
import * as prefs from '/src/lib/prefs.svelte.js';
import * as ex from '/src/lib/exporter.js';
import * as te from '/src/lib/text-engine/index.js';
import * as psd from '/src/lib/psd.js';
import * as pkg from '/src/lib/package.js';
import * as flow from '/src/lib/package-flow.js';

const A = window.__p8a;
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 250) {
  for (let i = 0; i < 3; i++) await frame();
  await wait(ms);
  if (te.textEngine()?.id === 'rust') await sw.fontsSettled();
  for (let i = 0; i < 2; i++) await frame();
}
const boxEl = (id) => document.querySelector('.tbox[data-id="' + CSS.escape(String(id)) + '"]');
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
const b64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const PNG1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
let record = null;

window.__p8 = {
  phase(name) { A.phase = name; },
  counts() { return { counts: A.counts, samples: A.samples }; },
  async addFonts(list) {
    const added = [];
    for (const f of list) {
      if (st.app.fonts.user.find((u) => u.name === f.family)?.faces?.[f.slot]) continue;
      const res = await fetch('/__p8/fonts/' + f.file);
      if (!res.ok) throw new Error(f.file + ': ' + res.status);
      const r = await fonts.addFontFile(new File([await res.arrayBuffer()], f.file), { family: f.family, slot: f.slot });
      if (r) added.push(f.family + '/' + f.slot);
    }
    await settle();
    return added;
  },
  async engine(mode) {
    prefs.setPref('textEngine', mode);
    await sw.useTextEngine(mode);
    await settle(400);
    return { mode: sw.engineSwitch.mode, phase: sw.engineSwitch.phase, painting: sw.engineSwitch.painting, error: sw.engineSwitch.error, measuring: te.textEngine()?.id ?? null, draws: te.engineDraws() };
  },
  // The chapter as the library hands it over once it has read the folder.
  // The last page is emptied of its boxes and its lines are marked unplaced,
  // so that there is a page for auto-typeset to set from nothing.
  async open(name) {
    record = await (await fetch('/__p8/chapters/' + name + '.json')).json();
    const pages = structuredClone(record.pages).map((p) => ({ ...p, raw: null, cleaned: null, file: null, cleanedFile: null }));
    const last = pages[pages.length - 1];
    last.boxes = [];
    for (const l of last.lines ?? []) l.placed = false;
    st.useChapterTypesetting(record.typesetting ?? null);
    st.loadProjectPages(pages);
    st.app.chapterRef = { projectId: 'p8', chapterId: 'c8' };
    await rt.goEditor('p8', 'c8');
    await settle(600);
    return { route: rt.route.name, pages: st.app.pages.length, boxes: st.app.pages.map((p) => p.boxes.length), typesetting: st.app.typesetting?.mode, tool: st.app.tool, canvas: !!document.querySelector('.page-frame'), inspector: !!document.querySelector('.insp-pane, #insp-font') };
  },
  async goto(i) {
    st.gotoPage(i);
    await settle();
    return st.app.pageIndex;
  },
  // The box of the page in front that a session is acted out on: the first
  // with plain text, a line of its own and room around it.
  pick() {
    const p = st.page();
    const b = p.boxes.find((x) => x.lineN != null && !x.style?.rotation && !x.style?.warp?.on) ?? p.boxes[0];
    return b ? String(b.id) : null;
  },
  async reveal(id) {
    st.setTool('text');
    boxEl(id)?.scrollIntoView({ block: 'center', inline: 'center' });
    await settle(150);
    const el = boxEl(id);
    return el ? rectOf(el) : null;
  },
  selected() { return st.app.selectedId == null ? null : String(st.app.selectedId); },
  async select(id) { st.selectBox(id); await settle(150); },
  box(id) {
    const b = st.page().boxes.find((x) => String(x.id) === String(id));
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h, font: b.style.font, size: b.style.size, bold: !!b.style.bold, italic: !!b.style.italic } : null;
  },
  handle() {
    const all = [...document.querySelectorAll('.tbox .handle')].filter((h) => !h.classList.contains('rot'));
    const h = all.find((x) => x.classList.contains('se')) ?? all.find((x) => x.classList.contains('e')) ?? all[all.length - 1];
    return h ? { ...rectOf(h), classes: h.className } : null;
  },
  settle,
  // The Inspector's own controls, as a hand works them.
  async inspect(what) {
    const say = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
    if (what === 'font') {
      const el = document.getElementById('insp-font');
      if (!el) return { done: false, why: 'no #insp-font' };
      const other = [...el.options].map((o) => o.value).find((v) => v !== el.value && st.app.fonts.user.some((f) => f.name === v));
      if (!other) return { done: false, why: 'no other family in the list' };
      el.value = other;
      say(el);
      await settle();
      return { done: true, to: other };
    }
    if (what === 'size' || what === 'largest') {
      const el = document.getElementById('insp-size');
      if (!el) return { done: false, why: 'no #insp-size' };
      const sizes = [...el.options].map((o) => o.value).filter((v) => v !== el.value && Number(v) >= 16);
      const other = what === 'largest' ? sizes.reduce((a, b) => (Number(b) > Number(a) ? b : a)) : sizes[0];
      el.value = other;
      say(el);
      await settle();
      return { done: true, to: other };
    }
    const el = document.querySelector('button[title="' + (what === 'bold' ? 'Bold' : 'Italic') + '"]');
    if (!el) return { done: false, why: 'no ' + what + ' button' };
    el.click();
    await settle();
    return { done: true };
  },
  // A box pulled in under its text, and "Fit now" on it, in one turn: no
  // effect of the canvas runs between the two, so what changes the box is
  // the fit and nothing else. Then the page's own refit, as a font landing
  // would ask it.
  async squeezeFit(id) {
    const b = st.page().boxes.find((x) => String(x.id) === String(id));
    const geom = () => [b.w, b.h, b.style.size].map((n) => Math.round(n * 10) / 10);
    const before = geom();
    // Narrower than its longest word and one line high: nothing of it fits.
    b.w = Math.min(b.w, 56);
    b.h = Math.min(b.h, 18);
    const squeezed = geom();
    const one = st.fitBoxNow(id);
    const fitted = geom();
    const page = st.refitPage(st.page());
    await settle();
    return { before, squeezed, fitted, fitChangedTheBox: one && fitted.join() !== squeezed.join(), pageRefit: page, after: geom() };
  },
  async autoTypeset() {
    st.setChapterTypesetMode('smart');
    await settle();
    const placed = st.placeDetectedOnPage();
    await settle(500);
    return { mode: st.app.typesetting?.mode, placed, boxes: st.page().boxes.length };
  },
  async exportAs(fmt) {
    const from = A.blobs.length;
    const ok = await ex.exportImages(fmt, 'page');
    await settle();
    const blobs = A.blobs.slice(from);
    return { ok, files: blobs.map((b) => ({ type: b.type, bytes: b.size })), toast: st.app.toast?.msg ?? null };
  },
  // exportChapterPackage (package-flow.js), from the line after it has read
  // the chapter's files, and then the package looked at as an import looks.
  async exportPackage() {
    const rec = flow.recordForExport({ ...structuredClone(record), pages: structuredClone(record.pages) });
    const pages = rec.pages ?? [];
    const named = pkg.fontFamiliesUsed(pages, []);
    const families = named.filter((name) => !st.app.fonts.builtin.some((f) => f.name === name));
    const found = await fonts.userFontRecords(families);
    const list = families.map((name) => found.find((f) => f.name === name) ?? { name, faces: {} });
    const raws = new Map(pages.map((p) => [p.file, PNG1]));
    const cleaned = new Map(pages.filter((p) => p.cleaned).map((p) => [p.cleaned, PNG1]));
    const bytes = pkg.buildChapterPackage({ record: rec, translations: null, project: { name: 'P8 audit', layout: 'pages', ocrLanguage: 'ja' }, raws, cleaned, fonts: list, tags: [], app: 'p8-audit' });
    // familiesKnown (package-flow.js), which the export awaits here.
    try { await st.fontFamiliesSettling(named); } catch { /* said as it stands */ }
    const staying = flow.fontsStaying(list, named);
    const seen = await flow.inspectPackage(new File([bytes], 'audit.mtchapter'), null);
    await settle();
    return { bytes: bytes.byteLength, families: named.length, shipped: list.filter((f) => Object.values(f.faces).some(Boolean)).length, staying, note: flow.stayingNote(staying), statuses: Object.fromEntries(seen.summary.fonts.map((f) => [f.name, f.status])) };
  },

  // ---- the PSD proof ----
  async selfTest(i) {
    const r = await psd.psdSelfTest(st.app.pages[i]);
    return { ok: r.ok, checks: r.checks, diffs: (r.diffs ?? []).slice(0, 10) };
  },
  // What the painter is handed for every box of the chapter: its lines.
  linesAll() {
    const painter = te.glyphPainter();
    const real = painter.paint;
    const out = [];
    for (const [i, p] of st.app.pages.entries()) {
      for (const box of p.boxes) {
        const lines = [];
        painter.paint = function (ctx, job) { for (const r of job.runs) lines.push(r.text); return real.call(this, ctx, job); };
        try {
          ex.renderBox(box, p);
        } catch { /* a box that cannot be painted has no lines */ } finally {
          painter.paint = real;
        }
        out.push({ index: i, page: p.id, id: String(box.id), bold: !!box.style.bold, italic: !!box.style.italic, font: box.style.font, w: box.w, size: box.style.size, lines });
      }
    }
    return out;
  },
  // One page as a PSD, and beside it what the painter was handed for each of
  // its boxes when the same page is painted: the face asked, the font the
  // engine resolved it to, what it synthesised, and the lines.
  async psdOf(i) {
    const p = st.app.pages[i];
    const bytes = await psd.buildPagePsd(p);
    const engine = te.textEngine();
    const rust = engine?.id === 'rust' && te.engineDraws();
    const painter = te.glyphPainter();
    const real = painter.paint;
    const boxes = [];
    for (const box of p.boxes) {
      const jobs = [];
      painter.paint = function (ctx, job) { jobs.push(job); return real.call(this, ctx, job); };
      try {
        ex.renderBox(box, p);
      } catch (e) {
        jobs.push({ error: String(e) });
      } finally {
        painter.paint = real;
      }
      boxes.push({
        id: String(box.id), font: box.style.font, bold: !!box.style.bold, italic: !!box.style.italic,
        jobs: jobs.map((job) => {
          if (job.error) return job;
          const out = { face: { name: job.face.name, bold: !!job.face.bold, italic: !!job.face.italic, size: job.face.size }, lines: job.runs.map((r) => r.text), curved: !!job.curved };
          if (rust && engine.hasFamily(job.face.name)) {
            const h = engine.handle(job.face);
            const r = engine.resolveFace(job.face);
            out.drawn = { postScriptName: engine.low.fontInfo(h.font).postScriptName, slot: r.slot, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic, lacking: engine.missing(job.face, job.runs.map((x) => x.text).join(''), 0).length };
          }
          return out;
        }),
      });
    }
    return { page: p.id, psd: await b64(new Blob([bytes])), boxes, engine: engine?.id ?? null, draws: te.engineDraws() };
  },
};
`;

// ------------------------------------------------------------------- driving
async function mouse(type, x, y, buttons = 0) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
}
async function drag(x0, y0, dx, dy, steps = 8) {
  await mouse('mouseMoved', x0, y0);
  await mouse('mousePressed', x0, y0, 1);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x0 + (dx * i) / steps, y0 + (dy * i) / steps, 1);
    await sleep(30);
  }
  await mouse('mouseReleased', x0 + dx, y0 + dy, 0);
}

const fontList = JSON.parse(readFileSync(join(DATA, 'fonts', 'fonts.json'), 'utf8')).fonts;
const chapterRecord = JSON.parse(readFileSync(join(DATA, 'chapters', `${CHAPTER}.json`), 'utf8'));
const used = new Set(chapterRecord.pages.flatMap((p) => (p.boxes ?? []).map((b) => b.style?.font)));
const chapterFonts = fontList.filter((f) => used.has(f.family));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Browser.setDownloadBehavior', { behavior: 'deny' });
await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTERS });

async function session(mode) {
  const notes = {};
  // A clean machine each time: no font library left over from the run before.
  await send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'all' });
  await send('Page.navigate', { url: `${BASE}/` });
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (await evaluate('document.readyState === "complete" && !!document.querySelector("#app")?.firstElementChild').catch(() => false)) break;
  }
  await sleep(500);
  await evaluate(`new Promise((res, rej) => { const s = document.createElement('script'); s.type = 'module'; s.textContent = ${JSON.stringify(PAGE)} + '\\nwindow.__p8ready = true;'; s.onerror = rej; document.head.appendChild(s); const t = setInterval(() => { if (window.__p8ready) { clearInterval(t); res(true); } }, 50); setTimeout(() => rej(new Error('the page module did not start')), 15000); })`);

  const phase = async (name, fn) => {
    await call('phase', name);
    const r = await fn();
    await call('settle', 200);
    notes[name] = r;
    log(`  [${mode}] ${name}: ${JSON.stringify(r)}`.slice(0, 400));
  };

  await phase('load the fonts', () => call('addFonts', chapterFonts));
  if (mode === 'rust') await phase('switch the engine on', () => call('engine', 'rust'));
  await phase('open the chapter', () => call('open', CHAPTER));
  await phase('turn pages', async () => {
    const at = [];
    for (const i of [1, 2, 3, 2, 1, 0, 3]) at.push(await call('goto', i));
    return at;
  });
  const id = await call('pick');
  await phase('select and move a box', async () => {
    const r = await call('reveal', id);
    const before = await call('box', id);
    await mouse('mouseMoved', r.x + r.w / 2, r.y + r.h / 2);
    await mouse('mousePressed', r.x + r.w / 2, r.y + r.h / 2, 1);
    await mouse('mouseReleased', r.x + r.w / 2, r.y + r.h / 2, 0);
    await call('settle', 150);
    let by = 'mouse';
    if ((await call('selected')) !== id) {
      await call('select', id);
      by = 'store (the click did not select)';
    }
    const r2 = await call('reveal', id);
    await drag(r2.x + r2.w / 2, r2.y + r2.h / 2, 46, 28);
    await call('settle', 200);
    const after = await call('box', id);
    return { box: id, selectedBy: by, moved: [after.x - before.x, after.y - before.y].map((n) => Math.round(n * 10) / 10) };
  });
  await phase('resize it', async () => {
    const before = await call('box', id);
    const h = await call('handle');
    if (!h) return { done: false, why: 'no handle on the selected box' };
    await drag(h.x + h.w / 2, h.y + h.h / 2, 38, 22);
    await call('settle', 250);
    const after = await call('box', id);
    return { handle: h.classes, grew: [after.w - before.w, after.h - before.h].map((n) => Math.round(n * 10) / 10) };
  });
  await phase('Inspector: font', () => call('inspect', 'font'));
  await phase('Inspector: size', () => call('inspect', 'size'));
  await phase('Inspector: bold, italic', async () => ({ bold: await call('inspect', 'bold'), italic: await call('inspect', 'italic'), box: await call('box', id) }));
  // A box pulled in under its text, and then asked to fit ("Fit now").
  await phase('auto-fit', async () => {
    const r = await call('squeezeFit', id);
    // A phase in which fit changed nothing proves nothing about fit.
    if (!r.fitChangedTheBox) throw new Error(`auto-fit did not change the box: ${JSON.stringify(r)}`);
    return r;
  });
  await phase('auto-typeset a page', async () => {
    await call('goto', chapterRecord.pages.length - 1);
    return call('autoTypeset');
  });
  await call('goto', 3);
  await phase('export PNG', () => call('exportAs', 'PNG'));
  await phase('export PSD', () => call('exportAs', 'PSD'));
  await phase('export .mtchapter', () => call('exportPackage'));
  await call('phase', 'after');
  return { notes, ...(await call('counts')) };
}

// ------------------------------------------------- stack lines, as source lines
// A frame is a line of what Vite served. A `.js` file is served with its
// lines where they are; a `.svelte` file is compiled, and its map says which
// line of the component a line of the compiled module came from.
const maps = new Map();
async function sourceLine(url, line, column) {
  const clean = url.split('?')[0];
  const path = clean.startsWith(BASE) ? clean.slice(BASE.length + 1) : clean;
  if (!maps.has(clean)) {
    let map = null;
    try {
      const text = await (await fetch(url)).text();
      const m = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(text);
      if (m) map = new TraceMap(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')));
    } catch { /* as served */ }
    maps.set(clean, map);
  }
  const map = maps.get(clean);
  if (map) {
    const at = originalPositionFor(map, { line, column: Math.max(0, column - 1) });
    if (at.line != null) return `${path}:${at.line}`;
  }
  return `${path}:${line}`;
}

const PHASES = ['boot', 'load the fonts', 'switch the engine on', 'open the chapter', 'turn pages', 'select and move a box', 'resize it', 'Inspector: font', 'Inspector: size', 'Inspector: bold, italic', 'auto-fit', 'auto-typeset a page', 'export PNG', 'export PSD', 'export .mtchapter'];
async function table(run) {
  const rows = new Map();
  for (const [key, n] of Object.entries(run.counts)) {
    const [phase, api, where] = key.split('|');
    if (!PHASES.includes(phase)) continue;
    const frames = run.samples[key] ?? [];
    const named = [];
    for (const [fn, url, line, column] of frames.slice(0, 4)) named.push(`${await sourceLine(url, line, column)}${fn ? ` (${fn})` : ''}`);
    const caller = named[0] ?? where;
    const id = `${api}|${caller}`;
    if (!rows.has(id)) rows.set(id, { api, caller, via: named.slice(1), phases: {}, total: 0 });
    const row = rows.get(id);
    row.phases[phase] = (row.phases[phase] ?? 0) + n;
    row.total += n;
  }
  return [...rows.values()].sort((a, b) => a.api.localeCompare(b.api) || b.total - a.total);
}
function markdown(mode, rows) {
  const phases = PHASES.filter((p) => rows.some((r) => r.phases[p]));
  const out = [`## textEngine: '${mode}'`, '', `| call | caller | via | total | ${phases.join(' | ')} |`, `|---|---|---|---:|${phases.map(() => '---:').join('|')}|`];
  for (const r of rows) out.push(`| ${r.api} | ${r.caller} | ${r.via.slice(0, 2).join(' < ')} | ${r.total} | ${phases.map((p) => r.phases[p] ?? '').join(' | ')} |`);
  const totals = {};
  for (const r of rows) totals[r.api] = (totals[r.api] ?? 0) + r.total;
  out.push('', `Totals: ${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '');
  return out.join('\n');
}

// --------------------------------------------------------------------- the run
const report = { chapter: CHAPTER, started: new Date().toISOString(), ua: null, runs: {} };
let md = `# P8 audit: browser text calls, by caller\n\nChapter ${CHAPTER}, ${chapterFonts.length} font files of ${new Set(chapterFonts.map((f) => f.family)).size} families. Typing into a box is not acted out (P7).\n\n`;
try {
  for (const mode of MODES) {
    log(`session with textEngine: '${mode}'`);
    const run = await session(mode);
    const rows = await table(run);
    report.runs[mode] = { notes: run.notes, rows };
    md += markdown(mode, rows) + '\n';
    process.stdout.write('\n' + markdown(mode, rows) + '\n');
  }
  report.ua = await evaluate('navigator.userAgent');

  // The PSD proof, in the session that is still open (the last of MODES).
  if (MODES.at(-1) === 'rust' && args.psd !== '0') {
    await call('phase', 'proof');
    // Every box of the chapter under both engines, to find the ones they
    // break differently; the pages the session above edited are left out.
    const edited = new Set([3, chapterRecord.pages.length - 1]);
    const on = (await call('linesAll')).filter((b) => !edited.has(b.index));
    await call('engine', 'browser');
    const off = new Map((await call('linesAll')).map((b) => [`${b.index}/${b.id}`, b.lines]));
    const back = await call('engine', 'rust');
    if (!back.draws) throw new Error('the engine did not come back on for the PSD proof');
    const differ = on.filter((b) => b.lines.join('\n') !== (off.get(`${b.index}/${b.id}`) ?? []).join('\n'));
    report.breaks = { boxes: on.length, differ: differ.map((b) => ({ index: b.index, page: b.page, box: b.id, font: b.font, size: b.size, w: b.w, rust: b.lines, browser: off.get(`${b.index}/${b.id}`) })) };
    log(`boxes of the untouched pages: ${on.length}; broken differently by the two engines: ${differ.length}`);
    // The pages of the proof: those with a box broken differently (three at
    // most) and the first with a bold or an italic box, or the ones asked for.
    const pages = args.pages ? args.pages.split(',').map(Number) : [...new Set([...differ.map((b) => b.index), on.find((x) => x.bold || x.italic)?.index].filter((i) => i != null))].slice(0, 4);
    report.selfTest = await call('selfTest', pages[0]);
    log('psdSelfTest, engine on, page index', pages[0], JSON.stringify(report.selfTest).slice(0, 600));
    const proof = [];
    for (const i of pages) {
      const made = await call('psdOf', i);
      const file = join(OUT, `${CHAPTER}-p${made.page}.rust.psd`);
      const bytes = Buffer.from(made.psd, 'base64');
      writeFileSync(file, bytes);
      proof.push({ index: i, page: made.page, file, bytes: bytes.length, boxes: made.boxes, engine: made.engine, draws: made.draws, off });
    }
    // The same pages written with the switch OFF, for one question: a type
    // layer that holds no text (a box with no text) - is it written either
    // way, the same layer?
    await call('engine', 'browser');
    for (const row of proof) row.offLayers = typeLayers(Buffer.from((await call('psdOf', row.index)).psd, 'base64'));
    if (!(await call('engine', 'rust')).draws) throw new Error('the engine did not come back on after the default-mode PSDs');
    report.proof = proof.map((row) => psdTable(row));
    md += proofMarkdown(report.proof, report.selfTest, report.breaks);
  }
  report.pageErrors = pageErrors;
  writeFileSync(join(OUT, 'audit.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(OUT, 'audit.md'), md);
  log('written:', join(OUT, 'audit.md'), join(OUT, 'audit.json'));
  if (pageErrors.length) log('page errors:', pageErrors.length, pageErrors.slice(0, 3).join(' | ').slice(0, 600));
  await stop(0);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  if (pageErrors.length) process.stderr.write(`page errors: ${pageErrors.slice(0, 5).join('\n')}\n`);
  await stop(1);
}

// ------------------------------------------------------------- reading it back
function typeLayers(bytes) {
  const doc = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const out = [];
  const walk = (layers) => {
    for (const l of layers ?? []) {
      if (l.text) out.push({ name: l.name, at: [l.left, l.top, l.right, l.bottom], text: l.text.text, font: l.text.style?.font?.name ?? null, fauxBold: !!l.text.style?.fauxBold, fauxItalic: !!l.text.style?.fauxItalic, runs: (l.text.styleRuns ?? []).map((r) => ({ length: r.length, font: r.style?.font?.name ?? null, fauxBold: r.style?.fauxBold, fauxItalic: r.style?.fauxItalic })) });
      walk(l.children);
    }
  };
  walk(doc.children);
  return out;
}
// A type layer's text is its lines with a carriage return between them.
function linesOf(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
}
function psdTable(row) {
  const layers = typeLayers(readFileSync(row.file));
  const rows = [];
  const left = [...layers];
  for (const box of row.boxes) {
    const job = box.jobs.find((j) => j.lines?.some((l) => l.trim()));
    if (!job) continue;
    const want = job.lines.join('\n');
    const at = left.findIndex((l) => linesOf(l.text).join('\n') === want);
    const layer = at < 0 ? null : left.splice(at, 1)[0];
    const browser = row.off.get(`${row.index}/${box.id}`) ?? null;
    rows.push({
      box: box.id,
      asked: `${box.font}${box.bold ? ' bold' : ''}${box.italic ? ' italic' : ''}`,
      engine: job.drawn ?? null,
      engineLines: job.lines,
      layer: layer ? { name: layer.name, font: layer.font, fauxBold: layer.fauxBold, fauxItalic: layer.fauxItalic, lines: linesOf(layer.text), runs: layer.runs } : null,
      rasterOnly: !layer,
      same: !!layer && !!job.drawn && layer.font === job.drawn.postScriptName && layer.fauxBold === job.drawn.fauxBold && layer.fauxItalic === job.drawn.fauxItalic,
      browserLines: browser,
      breaksDiffer: !!browser && browser.join('\n') !== want,
    });
  }
  const emptyOf = (list) => list.filter((l) => !String(l.text ?? '').trim()).map((l) => `${l.name} @ ${l.at.join(',')}`).sort();
  const empty = { on: emptyOf(layers), off: emptyOf(row.offLayers ?? []), boxesWithNoText: row.boxes.filter((b) => !b.jobs.some((j) => j.lines?.some((l) => l.trim()))).map((b) => b.id) };
  empty.same = empty.on.join('|') === empty.off.join('|');
  return { page: row.page, file: row.file, bytes: row.bytes, typeLayers: layers.length, typeLayersOff: row.offLayers?.length ?? null, empty, unmatched: left.map((l) => ({ name: l.name, font: l.font, lines: linesOf(l.text) })), rows };
}
function proofMarkdown(proof, selfTest, breaks) {
  const out = ['## A PSD written with the engine on, read back', '', `Boxes on the pages the session did not edit: ${breaks.boxes}. Broken differently by the two engines: ${breaks.differ.length}${breaks.differ.length ? ` (${breaks.differ.map((b) => `p${b.page} ${b.box}`).join(', ')})` : ''}.`, '', `psdSelfTest on the first of these pages, engine on: ok ${selfTest.ok}, checks ${JSON.stringify(selfTest.checks)}.`, ''];
  for (const p of proof) {
    const text = p.rows.filter((r) => !r.rasterOnly);
    out.push(`### page ${p.page}: ${p.file.split('/').pop()} (${p.bytes} bytes, ${p.typeLayers} type layers)`, '');
    out.push(`Boxes with text: ${p.rows.length}. Type layers whose font name and faux flags are the engine's: ${text.filter((r) => r.same).length} of ${text.length}. Whose lines are the painter's lines: ${text.length} of ${text.length} (a layer is matched by them). Raster-only: ${p.rows.filter((r) => r.rasterOnly).length}. Boxes the two engines break differently: ${p.rows.filter((r) => r.breaksDiffer).length}.`, '');
    out.push(`Type layers with no text: ${p.empty.on.length} with the engine on (${p.empty.on.join('; ') || 'none'}), ${p.empty.off.length} in the same page written with the switch off; the same layers, by name and rectangle: ${p.empty.same ? 'yes' : 'NO'}. Boxes of the page with no text: ${p.empty.boxesWithNoText.join(', ') || 'none'}. Type layers in all: ${p.typeLayers} on, ${p.typeLayersOff} off.`, '');
    if (p.unmatched.length) out.push(`Type layers with no painted box of the same lines: ${p.unmatched.map((l) => `"${l.name}" (${l.font}: ${l.lines.join(' / ')})`).join('; ')}.`, '');
    out.push('| box | asked | layer name | layer font | faux b/i | engine drew | faux b/i | lines (layer = engine) | browser breaks |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of p.rows) {
      const l = r.layer;
      out.push(`| ${r.box} | ${r.asked} | ${l ? l.name : ''} | ${l ? l.font : '(raster only)'} | ${l ? `${l.fauxBold ? 'B' : '-'}/${l.fauxItalic ? 'I' : '-'}` : ''} | ${r.engine?.postScriptName ?? ''} | ${r.engine ? `${r.engine.fauxBold ? 'B' : '-'}/${r.engine.fauxItalic ? 'I' : '-'}` : ''} | ${r.engineLines.join(' / ')} | ${r.breaksDiffer ? r.browserLines.join(' / ') : 'same'} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
