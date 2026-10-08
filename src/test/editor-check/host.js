// The page side of the editor check (scripts/editor-check.mjs drives it).
//
// A dev-only page, like capture.html: it mounts the REAL editor canvas
// (Canvas.svelte, and through it TextBox.svelte) on the real store, loads
// fonts the way a user's are loaded (fonts.js), and flips the real
// `textEngine` switch. Nothing of the app is stood in for. What it adds is a
// set of questions the driver can ask from outside - where each box is, what
// its canvas holds, what the exporter would paint - on `window.__ec`.
//
// It is not part of the build (`vite build` takes index.html alone) and
// nothing in the app imports it.
import { mount, unmount, flushSync, tick } from 'svelte';
import '../../styles.css';
import Canvas from '../../lib/editor/Canvas.svelte';
import {
  app, page, loadProjectPages, useChapterTypesetting, setZoom, setZoomLive, selectBox, deselect, beginEdit, endEdit, gotoPage, noteFontsChanged,
} from '../../lib/store.svelte.js';
import { initHistory } from '../../lib/editor/history.svelte.js';
import { restoreFonts, scanSystemFonts, addFontFile } from '../../lib/fonts.js';
import { engineSwitch, useTextEngine } from '../../lib/engine-switch.svelte.js';
import { textEngine, glyphPainter } from '../../lib/text-engine/index.js';
import { renderBoxTexture, renderPageCanvas, warpTexture } from '../../lib/exporter.js';
import { PICTURE_MAX_PX, pictureScale } from '../../lib/editor/box-picture.js';
import { defaultStyle, normalizeStyle } from '../../lib/data.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
// Effects flushed, the observer's first answers in, and what they caused painted.
async function settle(frames = 3) {
  await tick();
  flushSync();
  for (let i = 0; i < frames; i++) await frame();
  flushSync();
}

let canvasView = null;
function show() {
  if (canvasView) return;
  canvasView = mount(Canvas, { target: document.getElementById('app'), props: { onReady: () => {} } });
}
function hide() {
  if (!canvasView) return;
  unmount(canvasView);
  canvasView = null;
}

// ---- the synthetic chapter: one box of each kind ----
// The fixture fonts under the names they are loaded by below. `Aaa Sans`
// sorts first, so it is the last-resort family (text-engine/last-resort.js,
// rule 2: outside Tauri there are no system faces) and the one a letter the
// box's own face lacks is looked for in.
const COMIC = 'Check Comic';
const BANGERS = 'Check Bangers';
const SANS = 'Aaa Sans';
const WORDS = 'WAIT FOR ME\nOVER THERE!';
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: COMIC, size: 30, strokes: [], ...over });
const KINDS = [
  ['plain', {}],
  ['stroked', { strokes: [{ color: '#d02020', width: 3, opacity: 1 }] }],
  ['gradient-line', { size: 34, gradient: { on: true, kind: 'linear', angle: 180, scope: 'line', stops: [{ color: '#ff2a00', pos: 0, opacity: 1 }, { color: '#1b3cff', pos: 1, opacity: 1 }] } }],
  ['gradient-radial', { size: 34, font: BANGERS, gradient: { on: true, kind: 'radial', cx: 0.5, cy: 0.5, radius: 1, scope: 'box', stops: [{ color: '#ffd000', pos: 0, opacity: 1 }, { color: '#c00030', pos: 1, opacity: 1 }] } }],
  ['pattern', { size: 40, font: BANGERS, pattern: { on: true, kind: 'dots', fg: '#000000', bg: '#ffb000', scale: 1 }, strokes: [{ color: '#000000', width: 2, opacity: 1 }] }],
  ['bands', { strokes: [{ color: '#ffffff', width: 2, opacity: 1 }, { color: '#000000', width: 2, opacity: 1 }, { color: '#00a0ff', width: 4, opacity: 0.5 }] }],
  ['shadows', { strokes: [{ color: '#ffffff', width: 2, opacity: 1 }], shadows: [{ x: 4, y: 4, blur: 6, color: '#000000', opacity: 0.6 }, { x: -6, y: 8, blur: 0, color: '#ff0060', opacity: 0.5 }] }],
  ['blur', { blur: 2 }],
  ['smear', { motionBlur: { on: true, x: 2, y: 0, amount: 6 } }],
  ['roughen', { size: 36, font: BANGERS, roughen: { on: true, amount: 5, detail: 0.06, seed: 7 } }],
  ['clip-include', { clip: { on: true, mode: 'include', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 110, cy: 50, rx: 80, ry: 32 }] } }],
  ['clip-exclude', { clip: { on: true, mode: 'exclude', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 110, cy: 50, rx: 44, ry: 20 }] } }],
  ['ink', { ink: { on: true, strokes: [{ size: 9, color: '#0a50c8', opacity: 1, pts: [[10, 96, 0.6], [60, 104, 1], [120, 92, 1], [180, 106, 0.8], [214, 96, 0.4]] }] } }],
  ['arc', { curve: 45 }, 'ALONG AN ARC WE GO'],
  ['circle', { size: 20, circle: { on: true, angle: 0, inside: false, r: 0 } }, 'ROUND AND ROUND IT GOES '],
  ['path', { size: 24, path: { on: true, pts: [{ x: 6, y: 80, ix: -40, iy: 0, ox: 50, oy: -70 }, { x: 214, y: 40, ix: -50, iy: 70, ox: 40, oy: 0 }] } }, 'DOWN A BEZIER PATH'],
  ['flipped', { flipH: true, strokes: [{ color: '#d02020', width: 3, opacity: 1 }] }],
  ['rot7', { rotation: 7 }],
  ['rot90', { rotation: 90 }, 'TURNED\nA QUARTER'],
  ['rot7-shadow', { rotation: 7, shadows: [{ x: 4, y: 4, blur: 4, color: '#000000', opacity: 0.6 }] }],
  ['opacity', { opacity: 0.5, strokes: [{ color: '#d02020', width: 3, opacity: 1 }] }],
  ['faux-bold', { bold: true }],
  ['faux-italic', { italic: true }],
  ['real-italic', { font: SANS, size: 24, italic: true }],
  ['missing-font', { font: 'No Such Font', size: 24 }],
  ['missing-letter', { size: 26 }, 'HAVE Ω Ж\nLACK あ'],
  ['left-top', { align: 'left', valign: 'top', size: 24 }],
  ['right-bottom', { align: 'right', valign: 'bottom', size: 24, letterSpacing: 2 }],
  ['fractional', {}, WORDS, { dx: 0.37, dy: 0.61 }],
  ['warped', { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [232, 14], [-8, 118], [220, 110]] } }],
];
const COLS = 5;
const CELL = { w: 310, h: 230 };
const BOX = { w: 220, h: 110 };
export function syntheticPages() {
  const boxes = KINDS.map(([id, over, text = WORDS, at = {}], i) => ({
    id,
    lineN: null,
    text,
    x: (i % COLS) * CELL.w + (CELL.w - BOX.w) / 2 + (at.dx ?? 0),
    y: Math.floor(i / COLS) * CELL.h + (CELL.h - BOX.h) / 2 + (at.dy ?? 0),
    w: BOX.w,
    h: BOX.h,
    // Sizes are the test's own: the fit must not grow a box here.
    style: style({ autoHeight: false, ...over }),
  }));
  return [{ id: 1, w: COLS * CELL.w, h: Math.ceil(KINDS.length / COLS) * CELL.h, lines: [], boxes }];
}

async function fetchFile(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new File([await res.arrayBuffer()], name);
}

const pixelsOf = (cnv) => cnv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cnv.width, cnv.height).data;

// How two rasters of one size differ: bytes that are not the same, and the
// largest difference in any channel.
function differ(a, b) {
  let n = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    n++;
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return { bytes: n, worst };
}

const boxEl = (id) => document.querySelector(`.tbox[data-id="${CSS.escape(String(id))}"]`);
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const stats = (xs) => ({ n: xs.length, min: Math.min(...xs), median: median(xs), max: Math.max(...xs) });

window.__ec = {
  // Fonts as a user's are: through fonts.js, into IndexedDB and `document.fonts`.
  async boot() {
    initHistory();
    restoreFonts();
    scanSystemFonts();
    await document.fonts.ready;
    return { dpr: devicePixelRatio, ua: navigator.userAgent, available: engineSwitch.available };
  },
  async addFixtureFonts() {
    const faces = [
      [SANS, 'regular', '/src/test/fonts/DejaVuSans.ttf'],
      [SANS, 'italic', '/src/test/fonts/DejaVuSans-Oblique.ttf'],
      [BANGERS, 'regular', '/src/test/fonts/Bangers-Regular.ttf'],
      [COMIC, 'regular', '/src/test/fonts/ComicNeue-Regular.ttf'],
    ];
    for (const [family, slot, url] of faces) {
      if (app.fonts.user.find((f) => f.name === family)?.faces?.[slot]) continue;
      const r = await addFontFile(await fetchFile(url, `${family}-${slot}.ttf`), { family, slot });
      if (!r) throw new Error(`could not add ${family}/${slot}: ${app.toast?.msg ?? ''}`);
    }
    await document.fonts.ready;
    return app.fonts.user.map((f) => f.name);
  },
  // The user's own fonts, from the driver's read-only server (never the repo).
  async addFonts(list, base) {
    const added = [];
    for (const f of list) {
      if (app.fonts.user.find((u) => u.name === f.family)?.faces?.[f.slot]) continue;
      const r = await addFontFile(await fetchFile(`${base}/fonts/${f.file}`, f.file), { family: f.family, slot: f.slot });
      if (r) added.push(`${f.family}/${f.slot}`);
    }
    await document.fonts.ready;
    return added;
  },
  async openSynthetic() {
    return this.open(syntheticPages(), { mode: 'smart' });
  },
  async openUrl(url) {
    const chapter = await (await fetch(url)).json();
    // The art is not part of the copy: boxes on white, at the page's own size.
    const pages = chapter.pages.map((p) => ({ ...p, raw: null, cleaned: null, file: null, cleanedFile: null }));
    return this.open(pages, chapter.typesetting ?? null);
  },
  async open(pages, typesetting) {
    hide();
    useChapterTypesetting(typesetting);
    loadProjectPages(pages);
    show();
    await settle();
    return { pages: app.pages.length, boxes: app.pages.map((p) => p.boxes.length) };
  },
  async engine(mode) {
    await useTextEngine(mode);
    await settle(4);
    return {
      mode: engineSwitch.mode, phase: engineSwitch.phase, painting: engineSwitch.painting, error: engineSwitch.error, lastResort: engineSwitch.lastResort,
      measuring: textEngine()?.id ?? null, painter: glyphPainter().id ?? 'browser',
    };
  },
  async zoom(z) {
    setZoom(z);
    await settle();
    return app.zoom;
  },
  async goto(i) {
    gotoPage(i);
    await settle();
    return app.pageIndex;
  },
  async select(id) {
    if (id == null) deselect();
    else selectBox(id);
    await settle(1);
  },
  async edit(id) {
    beginEdit(id);
    await settle(2);
    // The edit opens with everything selected; a highlight is not ink.
    window.getSelection()?.collapseToEnd?.();
    await settle(1);
  },
  async endEdit() {
    const el = document.querySelector('.tbox .txt.editable');
    // A blur is how the app ends an edit, but a headless window that never
    // had the focus does not always send one.
    el?.blur();
    await settle(1);
    const ended = !app.editingId;
    if (!ended) endEdit(null);
    await settle(2);
    return { byBlur: ended, editing: app.editingId };
  },

  // A box brought to the middle of the viewport, so that it is one of those
  // that hold a picture however deep the zoom.
  async reveal(id) {
    boxEl(id)?.scrollIntoView({ block: 'center', inline: 'center' });
    await settle(3);
  },
  // The box of the page in front with the largest area.
  largest() {
    return String(page().boxes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a)).id);
  },

  // Where every box of the page in front is, and what it is made of.
  rects() {
    const frameEl = document.querySelector('.page-frame:not(.page-off)');
    return {
      zoom: app.zoom,
      dpr: devicePixelRatio,
      frame: frameEl ? rectOf(frameEl) : null,
      boxes: page().boxes.map((b) => {
        const el = boxEl(b.id);
        if (!el) return { id: b.id, mounted: false };
        const cnv = el.querySelector('canvas.warpl');
        return {
          id: b.id,
          mounted: true,
          page: { x: b.x, y: b.y, w: b.w, h: b.h },
          rect: rectOf(el),
          nodes: el.querySelectorAll('*').length,
          dom: !!el.querySelector('.txt, .arcstack'),
          editable: !!el.querySelector('.txt.editable, [contenteditable="true"], [contenteditable="plaintext-only"]'),
          canvas: cnv ? { painter: cnv.dataset.painter ?? null, w: cnv.width, h: cnv.height, rect: rectOf(cnv) } : null,
        };
      }),
    };
  },

  // Editor against exporter: for every box shown as the engine's picture, the
  // canvas's bytes against `renderBoxTexture` asked for the same scale.
  sameAsExporter() {
    const pg = page();
    return pg.boxes.map((b) => {
      const scale = pictureScale(app.zoom, devicePixelRatio, b.style.rotation);
      const cnv = boxEl(b.id)?.querySelector('canvas.warpl[data-painter="engine"]');
      if (!cnv) return { id: b.id, canvas: false };
      if (!cnv.width) return { id: b.id, canvas: true, painted: false };
      const tex = renderBoxTexture(b, pg, null, scale, PICTURE_MAX_PX);
      const r = warpTexture(tex, b);
      const out = { id: b.id, canvas: true, painted: true, editor: [cnv.width, cnv.height], exporter: [r.canvas.width, r.canvas.height], ss: tex.ss, scale };
      if (cnv.width === r.canvas.width && cnv.height === r.canvas.height) Object.assign(out, differ(pixelsOf(cnv), pixelsOf(r.canvas)), { total: cnv.width * cnv.height * 4 });
      r.canvas.width = 0;
      r.canvas.height = 0;
      return out;
    });
  },

  // Whether a canvas is shown one texture pixel to one device pixel: its CSS
  // box against its backing store, and where its corner sits on the device grid.
  alignment() {
    const dpr = devicePixelRatio;
    return [...document.querySelectorAll('canvas.warpl[data-painter="engine"]')].filter((c) => c.width).map((c) => {
      const r = c.getBoundingClientRect();
      const b = c.closest('.tbox');
      const turned = getComputedStyle(b).transform !== 'matrix(1, 0, 0, 1, 0, 0)' || getComputedStyle(c.parentElement).transform !== 'none';
      return { id: b.dataset.id, turned, offX: (r.x * dpr) % 1, offY: (r.y * dpr) % 1, scaleX: (r.width * dpr) / c.width, scaleY: (r.height * dpr) / c.height };
    });
  },

  // Each engine canvas as it is held, and where its corner is in device px:
  // what the driver lays over a screenshot to see whether the screen shows
  // those very pixels.
  pictures() {
    const dpr = devicePixelRatio;
    return [...document.querySelectorAll('canvas.warpl[data-painter="engine"]')].filter((c) => c.width).map((c) => {
      const r = c.getBoundingClientRect();
      const b = c.closest('.tbox');
      const box = page().boxes.find((x) => String(x.id) === b.dataset.id);
      const st = box.style;
      return {
        id: b.dataset.id,
        plain: !st.rotation && !st.flipH && !st.flipV && (st.opacity ?? 1) >= 0.999,
        x: r.x * dpr, y: r.y * dpr, w: c.width, h: c.height, url: c.toDataURL('image/png'),
      };
    });
  },

  async exportPng(scale = 1, index = app.pageIndex) {
    const cnv = await renderPageCanvas(app.pages[index], scale);
    const url = cnv.toDataURL('image/png');
    const out = { w: cnv.width, h: cnv.height, url };
    cnv.width = 0;
    cnv.height = 0;
    return out;
  },

  // What the page holds: canvas backing stores, and elements.
  held() {
    const all = [...document.querySelectorAll('canvas')];
    const live = all.filter((c) => c.width * c.height > 0);
    const bytes = (list) => list.reduce((a, c) => a + c.width * c.height * 4, 0);
    const hidden = all.filter((c) => c.closest('.page-off'));
    return {
      canvases: all.length,
      withPixels: live.length,
      bytes: bytes(live),
      largest: live.reduce((a, c) => Math.max(a, c.width * c.height * 4), 0),
      onHiddenPages: { canvases: hidden.length, bytes: bytes(hidden) },
      boxes: document.querySelectorAll('.tbox').length,
      boxElements: document.querySelectorAll('.tbox, .tbox *').length,
      textLayers: document.querySelectorAll('.tlayer, .arc').length,
    };
  },

  // ---- cost ----
  // Every box of the page repainted from scratch (a font arriving does this),
  // timed to the end of the effects: for a canvas that is the paint itself,
  // for DOM text it is the style and markup only - the browser's own layout
  // and raster come after, and `frame` is the time to the next frame with them.
  async timeRepaintAll(n = 5) {
    const sync = [];
    const withFrame = [];
    for (let i = 0; i < n; i++) {
      await frame();
      const t0 = performance.now();
      noteFontsChanged();
      flushSync();
      document.body.getBoundingClientRect();
      sync.push(performance.now() - t0);
      await frame();
      withFrame.push(performance.now() - t0);
    }
    return { sync: stats(sync), toNextFrame: stats(withFrame) };
  },
  // The canvas torn down and mounted again: what opening the page costs.
  async timeMount(n = 4) {
    const sync = [];
    const withFrames = [];
    for (let i = 0; i < n; i++) {
      hide();
      await frame();
      const t0 = performance.now();
      show();
      flushSync();
      document.body.getBoundingClientRect();
      sync.push(performance.now() - t0);
      await frame();
      await frame();
      flushSync();
      withFrames.push(performance.now() - t0);
    }
    await settle();
    return { sync: stats(sync), toSecondFrame: stats(withFrames) };
  },
  // A page turn and back: the hidden neighbour comes on screen.
  async timeTurn(n = 4) {
    if (app.pages.length < 2) return null;
    const sync = [];
    const from = app.pageIndex;
    const to = from + 1 < app.pages.length ? from + 1 : from - 1;
    for (let i = 0; i < n; i++) {
      for (const target of [to, from]) {
        await frame();
        await frame();
        const t0 = performance.now();
        gotoPage(target);
        flushSync();
        document.body.getBoundingClientRect();
        sync.push(performance.now() - t0);
      }
    }
    await settle();
    return { sync: stats(sync), boxes: [app.pages[to].boxes.length, app.pages[from].boxes.length] };
  },
  // A resize drag: the box one page px wider per frame, as the handle writes it.
  async timeResize(id, n = 30) {
    const b = page().boxes.find((x) => String(x.id) === String(id));
    const w0 = b.w;
    const sync = [];
    for (let i = 1; i <= n; i++) {
      await frame();
      const t0 = performance.now();
      b.w = w0 + i;
      flushSync();
      document.body.getBoundingClientRect();
      sync.push(performance.now() - t0);
    }
    b.w = w0;
    await settle();
    const el = boxEl(id)?.querySelector('canvas.warpl');
    return { ...stats(sync), canvasPx: el ? el.width * el.height : 0 };
  },
  // A zoom gesture: the ticks while it moves, then the settle that repaints.
  async timeZoomGesture(from, to, steps = 12) {
    setZoom(from);
    await settle();
    const ticks = [];
    setZoomLive(true);
    for (let i = 1; i <= steps; i++) {
      await frame();
      const t0 = performance.now();
      setZoom(from + ((to - from) * i) / steps);
      flushSync();
      document.body.getBoundingClientRect();
      ticks.push(performance.now() - t0);
    }
    await frame();
    const t0 = performance.now();
    setZoomLive(false);
    flushSync();
    document.body.getBoundingClientRect();
    const settleMs = performance.now() - t0;
    await settle();
    return { tick: stats(ticks), settle: settleMs };
  },
  state() {
    return { zoom: app.zoom, page: app.pageIndex, engine: { ...engineSwitch }, toast: app.toast?.msg ?? '' };
  },
};
document.title = 'ec ready';
