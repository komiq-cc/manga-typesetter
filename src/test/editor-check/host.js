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
import { flipTestPaint } from './refuse.js';
import { renderPageCanvas, warpTexture } from '../../lib/exporter.js';
import { pictureScale, pictureTexture } from '../../lib/editor/box-picture.js';
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
      const tex = pictureTexture(b, pg, null, scale);
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
    return { zoom: app.zoom, page: app.pageIndex, selected: app.selectedId, editing: app.editingId, engine: { ...engineSwitch }, toast: app.toast?.msg ?? '' };
  },

  // ---- the second check (P6b): what is near, what takes the pointer ----
  // A chapter of the driver's own boxes: `{ layout?, pages: [{ w, h, boxes:
  // [{ id, text, x, y, w, h, over }] }] }`, `over` being what the box's style
  // differs from the check's plain one by.
  async openCustom(spec) {
    app.projectLayout = spec.layout === 'longstrip' ? 'longstrip' : 'pages';
    const pages = spec.pages.map((p, i) => ({
      id: i + 1, w: p.w, h: p.h, lines: [],
      boxes: p.boxes.map((b) => ({ id: b.id, lineN: null, text: b.text ?? WORDS, x: b.x, y: b.y, w: b.w, h: b.h, style: style({ autoHeight: false, ...(b.over ?? {}) }) })),
    }));
    return this.open(pages, { mode: 'smart' });
  },
  // The scrolling area and every mounted box in it: the box's rectangle, the
  // rectangle the near-viewport observer is given (`.reach`), and what its
  // canvas holds. CSS px, viewport coordinates.
  boxesState() {
    const sc = document.querySelector('.editor-scroll');
    const r = sc.getBoundingClientRect();
    return {
      scroll: { x: r.x + sc.clientLeft, y: r.y + sc.clientTop, w: sc.clientWidth, h: sc.clientHeight, left: sc.scrollLeft, top: sc.scrollTop, sw: sc.scrollWidth, sh: sc.scrollHeight },
      boxes: [...document.querySelectorAll('.tbox')].map((el) => {
        const cnv = el.querySelector('canvas.warpl');
        const reach = el.querySelector('.reach');
        return {
          id: el.dataset.id,
          hidden: !!el.closest('.page-off'),
          rect: rectOf(el),
          reach: reach ? rectOf(reach) : null,
          canvas: cnv ? { painter: cnv.dataset.painter ?? null, w: cnv.width, h: cnv.height, rect: rectOf(cnv) } : null,
          dom: !!el.querySelector('.txt, .arcstack'),
        };
      }),
    };
  },
  // The area scrolled to a place, and what stands `frames` frames later.
  // With 1 that is the first frame a user sees after the scroll.
  async scrollTo(left, top, frames = 3) {
    const sc = document.querySelector('.editor-scroll');
    sc.scrollTo(left, top);
    for (let i = 0; i < frames; i++) await frame();
    flushSync();
    return this.boxesState();
  },
  // Where the letters of a box are, as the DOM lays them (the switch must be
  // off): the centre of every glyph of a curve, or of every line of straight
  // text, with whether it is outside the box's own rectangle.
  letterPoints(id) {
    const el = boxEl(id);
    const box = el.getBoundingClientRect();
    const at = (x, y) => ({ x, y, outside: x < box.left || x > box.right || y < box.top || y > box.bottom });
    const curve = [...el.querySelectorAll('.arcstack .arc:first-child .arc-ch')].filter((g) => g.textContent.trim());
    if (curve.length) {
      return curve.map((g) => {
        const r = g.getBoundingClientRect();
        return at(r.x + r.width / 2, r.y + r.height / 2);
      });
    }
    // A line's element is as wide as the box; its text is not.
    return [...el.querySelectorAll('.txt.shaped .tlayer.base .tline')].flatMap((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      const r = range.getBoundingClientRect();
      if (!r.width) return [];
      return [0.04, 0.25, 0.5, 0.75, 0.96].map((t) => at(r.x + r.width * t, r.y + r.height / 2));
    });
  },
  // A handle of the box dragged as a pointer drags it, a step a frame: what a
  // frame of the drag costs to the end of its effects, what letting go costs,
  // and what the box's canvas held before, at the last frame, and after.
  async timeDrag(id, dir = 'e', n = 30, step = 2) {
    const b = page().boxes.find((x) => String(x.id) === String(id));
    const was = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    selectBox(b.id);
    await settle(2);
    const handle = boxEl(id).querySelector(`.handle.${dir}`);
    if (!handle) return { error: `no handle ${dir}` };
    const r = handle.getBoundingClientRect();
    const x0 = r.x + r.width / 2;
    const y0 = r.y + r.height / 2;
    const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y });
    const size = () => {
      const c = boxEl(id).querySelector('canvas.warpl');
      return c ? [c.width, c.height] : null;
    };
    const before = size();
    handle.dispatchEvent(ev('pointerdown', x0, y0));
    const sync = [];
    let during = null;
    for (let i = 1; i <= n; i++) {
      await frame();
      const t0 = performance.now();
      document.dispatchEvent(ev('pointermove', x0 + i * step, y0));
      flushSync();
      document.body.getBoundingClientRect();
      sync.push(performance.now() - t0);
      if (i === n) during = size();
    }
    await frame();
    const t0 = performance.now();
    document.dispatchEvent(ev('pointerup', x0 + n * step, y0));
    flushSync();
    document.body.getBoundingClientRect();
    const letGo = performance.now() - t0;
    await settle(2);
    const after = size();
    const grew = b.w - was.w;
    b.x = was.x;
    b.y = was.y;
    b.w = was.w;
    b.h = was.h;
    b.style.size = was.size;
    deselect();
    await settle(2);
    return { frame: stats(sync), letGo, before, during, after, grewPagePx: grew };
  },
  // The rectangles a pictured box takes the pointer by, beside its own.
  hitRects(id) {
    return [...boxEl(id).querySelectorAll('.hit')].map(rectOf);
  },
  // Which box each point of the screen belongs to, by the browser's own hit test.
  hitTest(points) {
    return points.map((p) => document.elementFromPoint(p.x, p.y)?.closest('.tbox')?.dataset.id ?? null);
  },
  // Points inside a pictured box's canvas and outside both its frame and its
  // ink: the footprint's padding, a pixel in from each corner.
  paddingPoints(id) {
    const cnv = boxEl(id)?.querySelector('canvas.warpl');
    if (!cnv) return [];
    const r = cnv.getBoundingClientRect();
    return [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]].map(([x, y]) => ({ x, y }));
  },
  // A masked box's hand-over: the edit begun and the effects flushed, and
  // whether the wrapper is masked there and then, before any task has run.
  editNow(id) {
    beginEdit(id);
    flushSync();
    const wrap = boxEl(id).querySelector('.clipwrap');
    const cs = getComputedStyle(wrap);
    const image = cs.maskImage || cs.webkitMaskImage || '';
    return { editing: app.editingId, editable: !!boxEl(id).querySelector('.txt.editable'), masked: /url\(/.test(image), image: image.slice(0, 24) };
  },
  // What masks the box's wrapper now, and what the box is made of.
  maskState(id) {
    const el = boxEl(id);
    const cs = getComputedStyle(el.querySelector('.clipwrap'));
    const image = cs.maskImage || cs.webkitMaskImage || '';
    const cnv = el.querySelector('canvas.warpl');
    return { masked: /url\(/.test(image), canvas: cnv ? [cnv.width, cnv.height] : null, dom: !!el.querySelector('.txt, .arcstack') };
  },
  // The observer's margin, in the real scrolling area, for one layout: which
  // boxes hold a picture at the top of the chapter, whether what a scroll
  // brings into view was painted before it, and the box whose lines run far
  // past its rectangle. Asked of the page alone, so any browser can answer.
  async nearCheck(layout) {
    const row = { opened: await this.openCustom(NEAR_CHAPTERS[layout]) };
    await this.zoom(1);
    const sorted = (st) => {
      const out = { inView: [], inMargin: [], far: [] };
      for (const b of st.boxes.filter((x) => !x.hidden && x.id !== 'spill')) {
        const r = b.reach ?? b.rect;
        out[meets(r, st.scroll) ? 'inView' : meets(r, grown(st.scroll, 0.5)) ? 'inMargin' : 'far'].push(b);
      }
      return out;
    };
    const count = (list) => `${list.filter(painted).length}/${list.length}`;
    const s0 = await this.scrollTo(0, 0, 4);
    const k0 = sorted(s0);
    row.atTop = { area: [s0.scroll.w, s0.scroll.h], mounted: s0.boxes.length, inViewPainted: count(k0.inView), inMarginPainted: count(k0.inMargin), farPainted: count(k0.far) };
    // Scrolled 45% of the area on: what is in view now was painted before.
    const had = new Set(s0.boxes.filter(painted).map((b) => b.id));
    const by = Math.round(s0.scroll.h * 0.45);
    const s1 = await this.scrollTo(0, by, 1);
    const k1 = sorted(s1);
    const fresh = k1.inView.filter((b) => !k0.inView.some((a) => a.id === b.id));
    row.afterScroll = { scrolledBy: by, newInView: fresh.length, ofThemPaintedBeforeTheScroll: fresh.filter((b) => had.has(b.id)).length, inViewPainted: count(k1.inView) };
    // The spilling box: its rectangle more than half the area above the top
    // edge, its lines still on screen.
    const sp0 = s1.boxes.find((b) => b.id === 'spill');
    const top = Math.round(s1.scroll.top + (sp0.rect.y + sp0.rect.h - s1.scroll.y) + s1.scroll.h * 0.5 + 80);
    const s2 = await this.scrollTo(0, top, 4);
    const sp = s2.boxes.find((b) => b.id === 'spill');
    row.spillTop = top;
    row.spill = sp ? {
      rectAboveTheAreaBy: +((s2.scroll.y - (sp.rect.y + sp.rect.h)) / s2.scroll.h).toFixed(3),
      rectWithinMargin: meets(sp.rect, grown(s2.scroll, 0.5)),
      reachInView: sp.reach ? meets(sp.reach, s2.scroll) : null,
      reach: sp.reach, painted: painted(sp), canvas: sp.canvas ? [sp.canvas.w, sp.canvas.h] : null,
    } : { mounted: false };
    // And far past it: let go.
    const s3 = await this.scrollTo(0, Math.round(top + s2.scroll.h * 3), 4);
    const spFar = s3.boxes.find((b) => b.id === 'spill');
    row.spillFar = spFar ? { reachWithinMargin: spFar.reach ? meets(spFar.reach, grown(s3.scroll, 0.5)) : null, painted: painted(spFar) } : { mounted: false };
    const k3 = sorted(s3);
    row.farDown = { inViewPainted: count(k3.inView), inMarginPainted: count(k3.inMargin), farPainted: count(k3.far) };
    row.held = this.held();
    return row;
  },
  // Letters outside the frame: where the DOM has them with the switch off,
  // and whether the same places take the pointer with it on; and the
  // picture's padding, which must not. Leaves the chapter open, switch on.
  async hitsCheck() {
    await this.engine('browser');
    await this.openCustom(HITS_SPEC);
    await this.zoom(1);
    const ids = HITS_SPEC.pages[0].boxes.map((b) => b.id);
    const points = {};
    const off = {};
    for (const id of ids) {
      points[id] = this.letterPoints(id);
      off[id] = this.hitTest(points[id]);
    }
    await this.engine('rust');
    await this.zoom(1);
    const rows = {};
    for (const id of ids) {
      const pts = points[id];
      const on = this.hitTest(pts);
      const pad = this.paddingPoints(id);
      const cnv = boxEl(id).querySelector('canvas.warpl');
      rows[id] = {
        shownAs: cnv ? cnv.dataset.painter ?? 'old' : 'dom', letters: pts.length, outsideTheFrame: pts.filter((q) => q.outside).length,
        whereTheDomHadLetters: { switchOff: off[id].filter((h) => h === id).length, switchOn: on.filter((h) => h === id).length, outsideSwitchOn: pts.filter((q, i) => q.outside && on[i] === id).length },
        paddingCorners: pad.length, paddingCornersThatHit: this.hitTest(pad).filter((h) => h === id).length,
        hitRects: this.hitRects(id).length,
      };
      if (id === 'spill') {
        // Where CSS set the widest overflowing line with the switch off,
        // against the one rectangle the picture takes the pointer by, and the
        // frame: [left, width], CSS px.
        const lines = [];
        for (let i = 0; i + 4 < pts.length; i += 5) {
          const w = (pts[i + 4].x - pts[i].x) / 0.92;
          lines.push([+(pts[i].x - 0.04 * w).toFixed(1), +w.toFixed(1)]);
        }
        const r = this.hitRects(id)[0];
        const f = rectOf(boxEl(id));
        Object.assign(rows[id], { widestDomLine: lines.reduce((a, b) => (b[1] > a[1] ? b : a)), hitRect: r ? [+r.x.toFixed(1), +r.w.toFixed(1)] : null, frame: [f.x, f.w] });
      }
    }
    return { ids, points, rows };
  },
  // Everything above that needs no screenshot and no outside pointer, in one
  // go: what a browser with no driver (the system's WebKit, through
  // scripts/editor-check-webkit.swift) is asked. `#self` in the address runs it.
  async selfCheck() {
    const out = { ua: navigator.userAgent, dpr: devicePixelRatio, window: [innerWidth, innerHeight] };
    out.boot = await this.boot();
    await this.addFixtureFonts();
    out.engine = await this.engine('rust');
    out.near = {};
    for (const layout of Object.keys(NEAR_CHAPTERS)) out.near[layout] = await this.nearCheck(layout);
    out.hits = (await this.hitsCheck()).rows;
    await this.openCustom(LIMITS_SPEC);
    await this.zoom(3 / devicePixelRatio);
    const long = (await this.scrollTo(0, 0, 4)).boxes.find((b) => b.id === 'long');
    out.long = { scale: 3, canvas: long.canvas ? [long.canvas.w, long.canvas.h, long.canvas.painter] : null, dom: long.dom };
    await this.zoom(1);
    await this.openCustom(MASK_SPEC);
    await this.zoom(1);
    await new Promise((r) => setTimeout(r, 300));
    out.mask = {};
    for (const id of ['include', 'exclude', 'large', 'unmasked']) {
      out.mask[id] = { atRest: this.maskState(id), theFlushTheEditBegan: this.editNow(id) };
      await this.endEdit();
    }
    out.blobs = this.blobs().filter((b) => b.live).map((b) => b.size);
    out.errors = consoleErrors.slice();
    return out;
  },
  spec(name) {
    return { limits: LIMITS_SPEC, mask: MASK_SPEC }[name];
  },
  // Every blob the page has minted a URL for, and whether it still stands.
  blobs() {
    return minted.map((m) => ({ size: m.size, type: m.type, live: m.live }));
  },
  // The installed painter made to refuse any job whose text has `marker` in it.
  refuse(marker) {
    return flipTestPaint(glyphPainter(), marker);
  },
  logged() {
    return consoleErrors.splice(0);
  },
};

// ---- the second check's chapters ----
const meets = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const grown = (r, by) => ({ x: r.x - r.w * by, y: r.y - r.h * by, w: r.w * (1 + 2 * by), h: r.h * (1 + 2 * by) });
const painted = (b) => !!b.canvas && b.canvas.w > 0;
// A column of balloons 150 page px apart, and one small box whose lines run
// 1,400 page px below it.
const column = (n, first) => Array.from({ length: n }, (_, i) => ({ id: `c${first + i}`, x: 60, y: 40 + i * 150, w: 220, h: 110 }));
const SPILL = { id: 'spill', x: 420, y: 60, w: 200, h: 60, text: Array.from({ length: 38 }, (_, i) => `LINE ${i + 1}`).join('\n'), over: { valign: 'top' } };
const NEAR_CHAPTERS = {
  pages: { pages: [{ w: 800, h: 6000, boxes: [...column(40, 0), SPILL] }] },
  longstrip: { layout: 'longstrip', pages: [0, 1, 2].map((p) => ({ w: 800, h: 2000, boxes: [...column(13, p * 13), ...(p ? [] : [SPILL])] })) },
};
const HITS_SPEC = { pages: [{ w: 1400, h: 800, boxes: [
  { id: 'arc', x: 100, y: 200, w: 220, h: 110, text: 'ALONG AN ARC WE GO', over: { curve: 45 } },
  { id: 'circle', x: 500, y: 200, w: 220, h: 110, text: 'ROUND AND ROUND IT GOES ', over: { size: 20, circle: { on: true, angle: 0, inside: false, r: 0 } } },
  { id: 'path', x: 900, y: 200, w: 220, h: 110, text: 'DOWN A BEZIER PATH', over: { size: 24, path: { on: true, pts: [{ x: 6, y: 80, ix: -40, iy: 0, ox: 50, oy: -70 }, { x: 214, y: 40, ix: -50, iy: 70, ox: 40, oy: 0 }] } } },
  { id: 'spill', x: 300, y: 520, w: 80, h: 40, text: 'OVERFLOWING\nSIDEWAYS\nAND\nDOWN\nTHE\nPAGE' },
  { id: 'plain', x: 900, y: 560, w: 220, h: 110 },
] }] };
const ellipse = (cx, cy, rx, ry, mode = 'include') => ({ on: true, mode, brushSize: 20, shapes: [{ kind: 'ellipse', cx, cy, rx, ry }] });
const MASK_SPEC = { pages: [{ w: 1500, h: 900, boxes: [
  { id: 'include', x: 40, y: 40, w: 220, h: 110, over: { clip: ellipse(110, 50, 80, 32) } },
  { id: 'exclude', x: 340, y: 40, w: 220, h: 110, over: { clip: ellipse(110, 50, 44, 20, 'exclude') } },
  { id: 'large', x: 40, y: 220, w: 1000, h: 600, over: { size: 120, clip: ellipse(500, 300, 420, 240) } },
  { id: 'unmasked', x: 640, y: 40, w: 220, h: 110 },
] }] };
// The outside review's box, 7,000 page px long, and three to refuse one of.
const LIMITS_SPEC = { pages: [{ w: 7200, h: 600, boxes: [
  { id: 'long', x: 40, y: 60, w: 7000, h: 100, text: 'A LINE AS LONG AS A STRIP IS TALL' },
  { id: 'refused', x: 40, y: 260, w: 220, h: 110, text: 'THIS ONE IS\nREFUSED' },
  { id: 'beside', x: 340, y: 260, w: 220, h: 110 },
  { id: 'after', x: 640, y: 260, w: 220, h: 110 },
] }] };

// Blob URLs, counted: what a mask image standing at rest holds (finding 8).
const minted = [];
{
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    minted.push({ url, size: blob.size, type: blob.type, live: true });
    return url;
  };
  URL.revokeObjectURL = (url) => {
    const m = minted.find((x) => x.url === url);
    if (m) m.live = false;
    return revoke(url);
  };
}
const consoleErrors = [];
{
  const error = console.error.bind(console);
  console.error = (...a) => {
    consoleErrors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    error(...a);
  };
}
document.title = 'ec ready';
if (location.hash === '#self') {
  window.__ec.selfCheck().then(
    (out) => Object.assign(window, { __out: out, __done: true }),
    (err) => Object.assign(window, { __out: { error: String(err?.stack ?? err) }, __done: true }),
  );
}
