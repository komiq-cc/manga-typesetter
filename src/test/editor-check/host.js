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
import { pictureScale, pictureTexture, PICTURE_MAX_PX, PICTURE_DRAG_PX } from '../../lib/editor/box-picture.js';
import { defaultStyle, normalizeStyle } from '../../lib/data.js';
import { boxText } from '../../lib/store.svelte.js';
import { typeModel } from '../../lib/type-rows.js';
import { rawOffset, domPoint } from '../../lib/edit-lines.js';

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
    try {
      out.typing = await this.typeSelf();
    } catch (err) {
      out.typing = { error: String(err?.stack ?? err) };
    }
    out.errors = consoleErrors.slice();
    return out;
  },
  spec(name) {
    return { limits: LIMITS_SPEC, mask: MASK_SPEC, type: TYPE_SPEC, typeEdge: TYPE_EDGE_SPEC, typeCost: TYPE_COST_SPEC, type2: TYPE2_SPEC }[name];
  },

  // ---- typing into the picture (P7) ----
  // The box being typed into, as the page has it: its text, what the editable
  // holds and has selected (raw offsets, anchor and focus), what the box is
  // made of, the marks drawn over the picture, and where the browser has its
  // own caret - the rectangle the system hangs an IME's window on.
  typeState() {
    const id = app.editingId;
    const el = id != null ? boxEl(id) : null;
    const ed = el?.querySelector('.txt.editable');
    if (!ed) return { editing: id ?? null, editable: false, text: id != null ? boxText(boxOf(id), page()) : null };
    const sel = window.getSelection();
    const inside = sel.rangeCount > 0 && ed.contains(sel.focusNode);
    let native = null;
    if (inside) {
      const r = document.createRange();
      r.setStart(sel.focusNode, sel.focusOffset);
      r.collapse(true);
      // Where the browser's caret is. A place with no rectangle of its own
      // (measured, Chromium 155): in front of a Return that starts its text
      // node, where the Return's rectangle - as wide as nothing - is; and on
      // a line with nothing on it, where its `<br>`'s is.
      let q = r.getClientRects()[0];
      let from = 'range';
      const n = sel.focusNode;
      if (!q && n.nodeType === 3 && n.data[sel.focusOffset] === '\n') {
        r.setEnd(n, sel.focusOffset + 1);
        q = r.getClientRects()[0];
        from = 'return';
      } else if (!q && n.nodeType === 1) {
        const at = n.childNodes[sel.focusOffset] ?? n;
        const br = at.nodeName === 'BR' ? at : !at.textContent ? at.querySelector('br') : null;
        q = br?.getBoundingClientRect();
        from = 'br';
      }
      native = q ? { x: q.x, y: q.y, w: q.width, h: q.height, from } : null;
    }
    const cnv = el.querySelector('canvas.warpl');
    const mark = el.querySelector('.tcaret, .ccaret');
    return {
      editing: id,
      editable: true,
      focused: document.activeElement === ed,
      unseen: ed.classList.contains('unseen'),
      ghost: ed.classList.contains('ghost'),
      text: boxText(boxOf(id), page()),
      held: ed.textContent,
      sel: inside ? [rawOffset(ed, sel.anchorNode, sel.anchorOffset), rawOffset(ed, sel.focusNode, sel.focusOffset)] : null,
      canvas: cnv ? { painter: cnv.dataset.painter ?? null, w: cnv.width, h: cnv.height, rect: rectOf(cnv) } : null,
      overlay: el.querySelector('.type-edit') ? 'flat' : el.querySelector('.curve-edit') ? 'curve' : null,
      caret: mark ? { ...rectOf(mark), off: mark.classList.contains('off') } : null,
      sels: [...el.querySelectorAll('.tsel, .csel:not(.ccomp)')].map(rectOf),
      comps: [...el.querySelectorAll('.tcomp, .ccomp')].map(rectOf),
      native,
      nudge: ed.style.transform || '',
    };
  },
  // Where a caret can stand on a box, from the model the marks are drawn by
  // (type-rows.js), with every stop as a point of the screen: the middle of
  // its row, through the box's zoom, flip and turn. For a curve, the glyphs,
  // each with the middle of its left and right half. Needs the engine.
  typeRows(id) {
    const b = boxOf(id);
    const el = boxEl(id);
    const ed = el.querySelector('.txt.editable');
    const m = typeModel(b, ed ? ed.textContent : boxText(b, page()));
    if (!m) return null;
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const z = app.zoom;
    const rad = ((b.style.rotation || 0) * Math.PI) / 180;
    const client = (x, y) => {
      let dx = (x - b.w / 2) * z;
      let dy = (y - b.h / 2) * z;
      if (b.style.flipH) dx = -dx;
      if (b.style.flipV) dy = -dy;
      return { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad), y: cy + dx * Math.sin(rad) + dy * Math.cos(rad) };
    };
    if (m.kind === 'flat') {
      return {
        kind: 'flat',
        zoom: z,
        lines: m.lines,
        rows: m.rows.map((row) => ({ top: row.top, height: row.height, offs: row.offs, xs: row.xs, soft: row.soft, hard: row.hard, line: row.line, y: row.top + row.height / 2, lead: row.lead ? { ...row.lead, p: client(row.lead.x, row.top + row.height / 2) } : null, trail: row.trail ? { ...row.trail, p: client(row.trail.x, row.top + row.height / 2) } : null })),
        // A point of the box's own frame (page px from its corner) on screen.
        at: m.rows.map((row) => row.xs.map((x) => client(x, row.top + row.height / 2))),
        frame: { origin: client(0, 0), ex: client(1, 0), ey: client(0, 1) },
      };
    }
    const half = (g, side) => client(b.w / 2 + g.x + (side * g.w * Math.cos(g.rot)) / 4, b.h / 2 + g.y + (side * g.w * Math.sin(g.rot)) / 4);
    return { kind: 'curve', zoom: z, drawn: m.drawn, mapped: !!m.map, glyphs: m.glyphs.map((g) => ({ ch: g.ch, left: half(g, -1), right: half(g, 1) })) };
  },
  // Every letter of a box as the two places a press on it can go: the middle
  // of its left half (the caret goes before it, raw offset `o`) and of its
  // right (after it). `row` and `k` say which stop of the model that is.
  typeHalves(id) {
    const m = this.typeRows(id);
    const out = [];
    if (!m) return out;
    const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (m.kind === 'curve') {
      m.glyphs.forEach((g, i) => {
        if (far(g.left, g.right) < 1.5) return;
        out.push({ p: g.left, o: i, row: 0, k: i }, { p: g.right, o: i + 1, row: 0, k: i + 1 });
      });
      return out;
    }
    m.rows.forEach((row, i) => {
      for (let k = 0; k + 1 < row.offs.length; k++) {
        const a = m.at[i][k];
        const b = m.at[i][k + 1];
        if (far(a, b) < 1.5) continue;
        out.push({ p: lerp(a, b, 0.25), o: row.offs[k], row: i, k }, { p: lerp(a, b, 0.75), o: row.offs[k + 1], row: i, k: k + 1 });
      }
    });
    return out;
  },
  // The typing check's questions that need no screenshot, no outside pointer
  // and no IME: what any browser can answer of itself (`selfCheck`, for the
  // system's WebKit). The presses are events made here, not the system's.
  // What matters most in it is `nativeCaret`: how far the browser's own caret
  // - where the system would hang an IME's window - is from the drawn one.
  async typeSelf() {
    await this.engine('rust');
    await this.openCustom(TYPE_SPEC);
    await this.zoom(1);
    const out = {};
    const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    for (const b of TYPE_SPEC.pages[0].boxes) {
      const id = b.id;
      await this.reveal(id);
      const rest = rectOf(boxEl(id).querySelector('canvas.warpl'));
      await this.edit(id);
      const first = this.typeState();
      const row = { whileTyping: { canvas: first.canvas?.painter ?? null, overlay: first.overlay, unseen: first.unseen, focused: first.focused }, picture: this.typeSame(id), canvasMoved: JSON.stringify(first.canvas?.rect) !== JSON.stringify(rest) };
      const overlay = boxEl(id).querySelector('.type-edit, .curve-edit');
      const pts = this.typeHalves(id);
      let wrong = 0;
      let worst = 0;
      const none = [];
      const from = new Set();
      for (const h of pts) {
        const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: h.p.x, clientY: h.p.y };
        overlay?.dispatchEvent(new PointerEvent('pointerdown', init));
        overlay?.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        await settle(1);
        const s = this.typeState();
        if (s.sel?.[0] !== h.o || s.sel?.[1] !== h.o) wrong++;
        if (s.native && s.caret) {
          from.add(s.native.from);
          const a = mid(s.native);
          const c = mid(s.caret);
          worst = Math.max(worst, Math.hypot(a.x - c.x, a.y - c.y));
        } else none.push(h.o);
      }
      Object.assign(row, { presses: pts.length, wrongOffset: wrong, nativeCaret: { worstCssPxFromDrawn: +worst.toFixed(2), noRectangle: none.length, noRectangleAt: [...new Set(none)], from: [...from] } });
      // A key the page takes (Up), and one edit through `beforeinput`.
      const ed = boxEl(id).querySelector('.txt.editable');
      const before = this.typeState();
      const down = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      ed.dispatchEvent(down);
      ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'q', bubbles: true, cancelable: true }));
      await settle(2);
      const after = this.typeState();
      row.keyTaken = down.defaultPrevented;
      row.typed = { text: after.text.length === before.text.length + 1, picture: this.typeSame(id).bytes };
      ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
      await settle(2);
      row.textBack = this.typeState().text === before.text;
      await this.endEdit();
      out[id] = row;
    }
    return out;
  },
  // The picture of one box against `renderBoxTexture` asked for the same
  // scale - painted from what the editable holds, which while an IME composes
  // is not yet the box's text.
  typeSame(id) {
    const b = boxOf(id);
    const pg = page();
    const el = boxEl(id);
    const cnv = el?.querySelector('canvas.warpl[data-painter="engine"]');
    if (!cnv) return { id, canvas: false };
    if (!cnv.width) return { id, canvas: true, painted: false };
    const held = el.querySelector('.txt.editable')?.textContent;
    const of = held != null && held !== boxText(b, pg) ? { ...b, text: held } : b;
    const scale = pictureScale(app.zoom, devicePixelRatio, b.style.rotation);
    const tex = pictureTexture(of, pg, null, scale);
    const r = warpTexture(tex, of);
    const out = { id, canvas: true, painted: true, editor: [cnv.width, cnv.height], exporter: [r.canvas.width, r.canvas.height], composing: of !== b };
    if (cnv.width === r.canvas.width && cnv.height === r.canvas.height) Object.assign(out, differ(pixelsOf(cnv), pixelsOf(r.canvas)));
    r.canvas.width = 0;
    r.canvas.height = 0;
    return out;
  },
  // The selection put where the browser itself would put it (a word step, a
  // key it kept): raw offsets, in the editable, and said as the browser says it.
  async typeSelect(a, f = a) {
    const ed = document.querySelector('.tbox .txt.editable');
    const [ac, ai] = domPoint(ed, a);
    const [fc, fi] = domPoint(ed, f);
    window.getSelection().setBaseAndExtent(ac, ai, fc, fi);
    document.dispatchEvent(new Event('selectionchange'));
    await settle(2);
    return this.typeState();
  },
  // How long the rows of a box take to make, from its text: the model the
  // caret and the selection are drawn by, `n` times.
  timeModel(id, n = 5) {
    const b = boxOf(id);
    const text = boxText(b, page());
    const ms = [];
    let rows = 0;
    let stops = 0;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const m = typeModel(b, text);
      ms.push(performance.now() - t0);
      rows = m?.rows?.length ?? 0;
      stops = m?.rows?.reduce((sum, r) => sum + r.offs.length, 0) ?? 0;
    }
    return { letters: text.length, rows, stops, ms: stats(ms) };
  },
  // What the paint of a box alone takes, at the scale the editor shows it
  // at: within the budget a box at rest has, and within the one a key's
  // paint is given. The texture only, `n` times each, in turn.
  timePaint(id, n = 7) {
    const b = boxOf(id);
    const pg = page();
    const scale = pictureScale(app.zoom, devicePixelRatio, b.style.rotation);
    const out = {};
    const ms = { full: [], key: [] };
    for (let i = 0; i < n; i++) {
      for (const [name, budget] of [['full', PICTURE_MAX_PX], ['key', PICTURE_DRAG_PX]]) {
        const t0 = performance.now();
        const tex = pictureTexture(b, pg, null, scale, budget);
        ms[name].push(performance.now() - t0);
        out[`${name}MP`] = +((tex.canvas.width * tex.canvas.height) / 1e6).toFixed(2);
        tex.canvas.width = 0;
        tex.canvas.height = 0;
      }
    }
    return { ...out, full: stats(ms.full), key: stats(ms.key) };
  },
  // A paste or a cut, as the event the browser sends, carrying its own
  // clipboard: the system's is the user's and is not read or written here.
  clip(type, text = null) {
    const ed = document.querySelector('.tbox .txt.editable');
    const data = new DataTransfer();
    if (text != null) data.setData('text/plain', text);
    const ev = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
    ed.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, data: data.getData('text/plain') };
  },
  // A word put in the place of another the way the system's autocorrect and
  // its spelling menu do it: one `beforeinput` naming the range it replaces
  // and carrying the new word, which is not `data`.
  replace(a, b, word) {
    const ed = document.querySelector('.tbox .txt.editable');
    const [sc, so] = domPoint(ed, a);
    const [ec, eo] = domPoint(ed, b);
    const data = new DataTransfer();
    data.setData('text/plain', word);
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertReplacementText', data: null, dataTransfer: data, bubbles: true, cancelable: true,
      targetRanges: [new StaticRange({ startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo })],
    });
    ed.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  },
  // Every edit the browser has asked for since the last call: its kind, and
  // the range it names as raw offsets and as the place in the document.
  inputsSeen() {
    return inputs.splice(0);
  },
  // The last request for the system's menu: what it was aimed at.
  menuSeen() {
    const m = menu;
    menu = null;
    return m;
  },
  async wait(frames = 1) {
    await settle(frames);
  },
  // Only the picture: the selection's frame and handles, the drawn marks and
  // the browser's own caret and highlight all hidden, so that two screenshots
  // of a box differ by its text alone.
  bare(on) {
    document.getElementById('ec-bare')?.remove();
    if (!on) return;
    const st = document.createElement('style');
    st.id = 'ec-bare';
    st.textContent = [
      '.tbox, .tbox:hover { outline-color: transparent !important; }',
      '.tbox .handle, .tbox .rotate-stem, .tbox .mask-gizmo, .tbox .review-badge, .tbox .lock-chip-wrap, .tbox .tsel, .tbox .tcaret, .tbox .tcomp, .tbox .csel, .tbox .ccaret { visibility: hidden !important; }',
      '.tbox .txt.editable { caret-color: transparent !important; }',
      '.tbox .txt.editable::selection, .tbox .txt.editable *::selection { background: transparent !important; }',
    ].join('\n');
    document.head.append(st);
  },
  // The drawn caret held lit, so that a picture of it is a picture of it.
  freezeCaret(on) {
    document.getElementById('ec-freeze')?.remove();
    if (!on) return;
    const st = document.createElement('style');
    st.id = 'ec-freeze';
    st.textContent = '.tcaret, .ccaret { animation: none !important; }';
    document.head.append(st);
  },
  // What a keystroke costs, from the edit the browser asks for (`beforeinput`,
  // the one way in for every kind of typing) to the end of its effects - for a
  // pictured box that is the paint - and to the next frame. A letter typed at
  // the end of the text and taken away again, `n` times each.
  async timeType(n = 20) {
    const ed = document.querySelector('.tbox .txt.editable');
    if (!ed) return { error: 'no box is being typed into' };
    const el = ed.closest('.tbox');
    const sync = [];
    const withFrame = [];
    const send = (inputType, data) => ed.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));
    for (let i = 0; i < n * 2; i++) {
      await frame();
      const t0 = performance.now();
      if (i % 2 === 0) send('insertText', 'A');
      else send('deleteContentBackward', null);
      flushSync();
      document.body.getBoundingClientRect();
      sync.push(performance.now() - t0);
      await frame();
      withFrame.push(performance.now() - t0);
    }
    const cnv = el.querySelector('canvas.warpl');
    // What the canvas holds while the keys are coming, and after the pause
    // the full paint waits for (TextBox.svelte `keyed`). The full paint is
    // timed where it can be made to happen: an edit that ends inside the
    // pause paints it at once, so the edit is ended there, and begun again.
    const during = cnv ? [cnv.width, cnv.height] : null;
    const id = app.editingId;
    const pictured = cnv?.dataset.painter === 'engine';
    const unseen = ed.classList.contains('unseen');
    const t0 = performance.now();
    // As the blur ends it: with the text the editable holds.
    endEdit(ed.textContent);
    flushSync();
    document.body.getBoundingClientRect();
    const ending = performance.now() - t0;
    await frame();
    const settled = cnv?.isConnected ? [cnv.width, cnv.height] : null;
    const soft = !!(during && settled && during[0] * during[1] < settled[0] * settled[1]);
    await this.edit(id);
    // And by the pause itself: a key, then nothing for twice the pause.
    const again = document.querySelector('.tbox .txt.editable');
    const cnv2 = again?.closest('.tbox').querySelector('canvas.warpl');
    again?.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'A', bubbles: true, cancelable: true }));
    flushSync();
    const key1 = cnv2 ? [cnv2.width, cnv2.height] : null;
    await new Promise((r) => setTimeout(r, 320));
    await frame();
    const afterPause = cnv2 ? [cnv2.width, cnv2.height] : null;
    again?.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 320));
    await frame();
    return { sync: stats(sync), toNextFrame: stats(withFrame), canvas: settled, during, soft, endingMs: ending, afterKey: key1, afterPause, pictured, unseen };
  },
  // The same from a real key: stamped when the page hears the key go down,
  // and again at the first frame after it. The driver sends the keys.
  keyTimes(on) {
    if (on === false) {
      const out = keyStamps.slice();
      keyStamps.length = 0;
      window.removeEventListener('keydown', onKeyStamp, true);
      return out;
    }
    keyStamps.length = 0;
    window.addEventListener('keydown', onKeyStamp, true);
    return [];
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
  // Its advance is inside the frame and its ink is not: an italic J's hook
  // starts left of where its line does.
  { id: 'lean', x: 600, y: 470, w: 200, h: 230, text: 'J', over: { italic: true, size: 160, align: 'left', font: 'Aaa Sans' } },
] }] };
const ellipse = (cx, cy, rx, ry, mode = 'include') => ({ on: true, mode, brushSize: 20, shapes: [{ kind: 'ellipse', cx, cy, rx, ry }] });
const MASK_SPEC = { pages: [{ w: 1500, h: 900, boxes: [
  { id: 'include', x: 40, y: 40, w: 220, h: 110, over: { clip: ellipse(110, 50, 80, 32) } },
  { id: 'exclude', x: 340, y: 40, w: 220, h: 110, over: { clip: ellipse(110, 50, 44, 20, 'exclude') } },
  { id: 'large', x: 40, y: 220, w: 1000, h: 600, over: { size: 120, clip: ellipse(500, 300, 420, 240) } },
  { id: 'unmasked', x: 640, y: 40, w: 220, h: 110 },
] }] };
// The outside review's box, 7,000 page px long, and four to refuse two of,
// one of them warped.
const LIMITS_SPEC = { pages: [{ w: 7200, h: 600, boxes: [
  { id: 'long', x: 40, y: 60, w: 7000, h: 100, text: 'A LINE AS LONG AS A STRIP IS TALL' },
  { id: 'refused', x: 40, y: 260, w: 220, h: 110, text: 'THIS ONE IS\nREFUSED' },
  { id: 'refused-warped', x: 940, y: 260, w: 220, h: 110, text: 'REFUSED\nAND WARPED', over: { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [232, 14], [-8, 118], [220, 110]] } } },
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
const boxOf = (id) => page().boxes.find((x) => String(x.id) === String(id));
let menu = null;
window.addEventListener('contextmenu', (e) => {
  const ed = document.querySelector('.tbox .txt.editable');
  const sel = window.getSelection();
  const inside = ed && sel.rangeCount > 0 && ed.contains(sel.focusNode);
  menu = {
    inEditable: !!e.target.closest?.('[contenteditable="true"]'), target: String(e.target.className ?? ''), prevented: e.defaultPrevented,
    // What is selected as the menu is asked for, and whether the pointer is on it.
    sel: inside ? [rawOffset(ed, sel.anchorNode, sel.anchorOffset), rawOffset(ed, sel.focusNode, sel.focusOffset)] : null,
    onSelection: inside ? [...sel.getRangeAt(0).getClientRects()].some((r) => e.clientX >= r.left - 0.5 && e.clientX <= r.right + 0.5 && e.clientY >= r.top - 0.5 && e.clientY <= r.bottom + 0.5) : false,
    moved: ed?.style.transform ?? '',
  };
}, true);
const inputs = [];
window.addEventListener('beforeinput', (e) => {
  const ed = e.target.closest?.('.txt.editable');
  const r = e.getTargetRanges?.()[0];
  const where = (n, o) => `${n.nodeType === 3 ? `"${n.data.replace(/\n/g, '\\n')}"` : `<${n.nodeName.toLowerCase()}${n.className ? `.${String(n.className).replace(/ /g, '.')}` : ''}>`}:${o}`;
  inputs.push({
    type: e.inputType,
    range: r && ed ? [rawOffset(ed, r.startContainer, r.startOffset), rawOffset(ed, r.endContainer, r.endOffset)] : null,
    from: r ? where(r.startContainer, r.startOffset) : null,
    to: r ? where(r.endContainer, r.endOffset) : null,
  });
}, true);
const keyStamps = [];
function onKeyStamp(e) {
  const row = { key: e.key, heard: performance.now(), sinceEvent: performance.now() - e.timeStamp };
  keyStamps.push(row);
  // The handlers and their effects run in this task; the frame is after it.
  queueMicrotask(() => setTimeout(() => (row.task = performance.now() - row.heard)));
  requestAnimationFrame(() => (row.frame = performance.now() - row.heard));
}
// One box of each kind the typing check goes through (scripts/editor-check.mjs,
// `type`). The fallback box: no font here or among the user's has kana, so
// its borrowed letters are Greek and Cyrillic (from the last-resort family)
// and its kana is the letter no font has.
const TYPE_SPEC = { pages: [{ w: 1560, h: 760, boxes: [
  { id: 'centre', x: 40, y: 60, w: 240, h: 120 },
  { id: 'left', x: 340, y: 60, w: 240, h: 120, over: { align: 'left', valign: 'top', size: 24 } },
  { id: 'right', x: 640, y: 60, w: 240, h: 120, over: { align: 'right', valign: 'bottom', size: 24, letterSpacing: 2 } },
  { id: 'stroke-gradient', x: 940, y: 60, w: 240, h: 120, over: { size: 32, strokes: [{ color: '#101010', width: 3, opacity: 1 }], gradient: { on: true, kind: 'linear', angle: 180, scope: 'line', stops: [{ color: '#ff2a00', pos: 0, opacity: 1 }, { color: '#1b3cff', pos: 1, opacity: 1 }] } } },
  { id: 'bold', x: 1240, y: 60, w: 260, h: 120, over: { bold: true } },
  { id: 'italic', x: 40, y: 300, w: 240, h: 120, over: { font: SANS, size: 24, italic: true }, text: 'Wait for me\noffice affix' },
  { id: 'upper', x: 340, y: 300, w: 240, h: 120, over: { uppercase: true, size: 26 }, text: 'Wait for me\nStraße over' },
  { id: 'wrapped', x: 640, y: 300, w: 240, h: 150, over: { size: 22, align: 'left', valign: 'top' }, text: 'the quick brown fox jumps over the lazy dog and runs off home' },
  { id: 'returns', x: 940, y: 300, w: 240, h: 150, over: { size: 26, valign: 'top' }, text: 'AFTER ME\nTHE END\n\n' },
  { id: 'fallback', x: 1240, y: 300, w: 260, h: 120, over: { size: 26 }, text: 'HAVE Ω Ж\nLACK あ' },
  { id: 'rot30', x: 80, y: 560, w: 240, h: 120, over: { rotation: 30 } },
  { id: 'flipped', x: 440, y: 560, w: 240, h: 120, over: { flipH: true, strokes: [{ color: '#d02020', width: 3, opacity: 1 }] } },
  { id: 'arc', x: 800, y: 580, w: 260, h: 120, over: { curve: 45 }, text: 'ALONG AN ARC WE GO' },
] }] };
// The typing check's odd ones: nothing to draw, nothing but spaces, a word
// the system corrects, a picture refused while it is typed into, and the
// boxes with something over or under their text.
const TYPE_EDGE_SPEC = { pages: [{ w: 1560, h: 520, boxes: [
  { id: 'empty', x: 40, y: 60, w: 240, h: 120, text: '' },
  { id: 'spaces', x: 340, y: 60, w: 240, h: 120, text: '   ', over: { align: 'left', valign: 'top' } },
  { id: 'corrected', x: 640, y: 60, w: 240, h: 120, text: 'teh quick fox\nran home', over: { size: 26 } },
  { id: 'refused', x: 940, y: 60, w: 240, h: 120 },
  { id: 'masked', x: 40, y: 300, w: 240, h: 120, over: { clip: ellipse(120, 60, 90, 40) } },
  { id: 'inked', x: 340, y: 300, w: 240, h: 120, over: { ink: { on: true, strokes: [{ size: 9, color: '#0a50c8', opacity: 1, pts: [[10, 96, 0.6], [60, 104, 1], [120, 92, 1], [180, 106, 0.8], [214, 96, 0.4]] }] } } },
  { id: 'smear', x: 640, y: 300, w: 240, h: 120, over: { motionBlur: { on: true, x: 2, y: 0, amount: 6 } } },
  { id: 'warped', x: 940, y: 300, w: 240, h: 120, over: { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [252, 14], [-8, 128], [240, 120]] } } },
] }] };
// The second round's boxes: three rows of a word each; a letter cased to two
// with the line broken between the two; an uppercase curve with such a
// letter; a box over the budget a key's paint is given, and one under it.
const TYPE2_SPEC = { pages: [{ w: 1560, h: 900, boxes: [
  { id: 'rows', x: 60, y: 60, w: 96, h: 150, over: { size: 26, align: 'left', valign: 'top' }, text: 'AAAA BBBB CCCC' },
  { id: 'split', x: 300, y: 60, w: 60, h: 200, over: { size: 40, uppercase: true, align: 'left', valign: 'top', shape: 'off' }, text: 'aßb' },
  { id: 'upper-arc', x: 480, y: 90, w: 320, h: 140, over: { curve: 45, uppercase: true }, text: 'straße über uns' },
  { id: 'small', x: 900, y: 60, w: 220, h: 110 },
  { id: 'bold', x: 1200, y: 60, w: 300, h: 120, over: { bold: true } },
  { id: 'big', x: 60, y: 340, w: 640, h: 440, over: { size: 90, strokes: [{ color: '#d02020', width: 4, opacity: 1 }], shadows: [{ x: 4, y: 4, blur: 6, color: '#000000', opacity: 0.6 }], blur: 1 } },
  // Text that runs out of its frame, straight and on a curve: where the
  // editable under the picture is not.
  { id: 'spill', x: 1240, y: 320, w: 80, h: 40, text: 'OVERFLOWING\nSIDEWAYS\nAND\nDOWN' },
  { id: 'arc-out', x: 880, y: 460, w: 260, h: 60, over: { curve: 80 }, text: 'ALONG AN ARC WE GO' },
] }] };
// One line of twenty thousand letters, which nothing breaks.
const LONG_LINE = 'A'.repeat(20000);
// The three sizes of box the cost of a keystroke is taken on.
const TYPE_COST_SPEC = { pages: [{ w: 1400, h: 1700, boxes: [
  { id: 'balloon', x: 60, y: 60, w: 220, h: 110 },
  { id: 'effect', x: 60, y: 260, w: 600, h: 400, over: { size: 90, strokes: [{ color: '#d02020', width: 4, opacity: 1 }], shadows: [{ x: 4, y: 4, blur: 6, color: '#000000', opacity: 0.6 }], blur: 1 } },
  { id: 'page-wide', x: 60, y: 760, w: 1100, h: 800, over: { size: 150, strokes: [{ color: '#d02020', width: 6, opacity: 1 }], shadows: [{ x: 6, y: 6, blur: 8, color: '#000000', opacity: 0.6 }] } },
  // One word of twenty thousand letters: the breaker keeps a word whole, so
  // it is one line, and one row of twenty thousand stops.
  { id: 'long-line', x: 60, y: 1600, w: 1100, h: 60, over: { size: 20, align: 'left', valign: 'top' }, text: LONG_LINE },
] }] };
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
