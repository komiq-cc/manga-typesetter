// The lettering benchmark's runner (TST-2). Runs in the `realfont` test project
// only: it needs the real canvas and fonts src/test/real-fonts.js sets up.
//
// Each case (cases.js) goes through the app's own pipeline, not a copy of it:
//
//   1. a page is drawn for it - screentone, some art, the balloon in a dark
//      outline - and its pixels are handed to the store through the caller's
//      `setPixels`, which feeds the test file's `pagePixelsFor` mock (the
//      pattern balloon-wiring.test.js uses);
//   2. the page is loaded with `loadProjectPages`, one line and one detection;
//   3. a LAYOUT FUNCTION decides the box. The default, `storeLayout`, is what
//      "Place from detection" does today: `placeDetectedOnPage`, then the lines
//      every renderer lays that box out in;
//   4. the box is painted by the exporter (`renderBoxTexture`) and everything
//      below is measured off that paint and those lines.
//
// A layout function is `(benchCase, ctx) => result`, sync or async:
//
//   ctx     { page, line, det, style } - the loaded store page, its one line,
//           its one detection, and the style the store would give a box born on
//           that line now (`inheritedStyleFor`).
//   result  { x, y, w, h, size, lines, fit?, path? } - the box in page px, the
//           font size, the lines as drawn, the balloon shape the box is laid out
//           to (normalizeFit format, or null), and which layout path produced
//           the lines when the layout can say (BRK-4). The store's own box can
//           ride along as `box`; otherwise one is built from the numbers.
//
// So a solver can be benchmarked by passing it here (see
// scripts/typeset-bench.mjs --layout) and every number below compares.
//
// Metrics, per case:
//
//   boxOverflow    how far the painted ink - glyphs and outlines - reaches past
//                  the box, worst edge, page px. <= 0.5 is inside (OVF-2).
//   glyphOverflow  the same with the outlines removed, so an overflow can be
//                  told apart: outline (OVF-3) or the glyphs themselves.
//   inkInBalloon   share of the painted ink (alpha-weighted) inside the
//                  balloon's white interior. null over the art.
//   sizeRatio      size / refSize.
//   lineCount, aspect (block width / block height, line boxes),
//   fill           block area / balloon interior area. null over the art.
//   ovalScore      1 - RMS distance between the line-width profile (each line
//                  over the widest) and an oval profile: BRK-3's five-line
//                  62/86/100/86/62, as the curve 1 - 0.62u^2 + 0.24u^4 through
//                  the line centres. 1 is a perfect match.
//   rectScore      the same against a rectangle (every line as wide as the
//                  widest).
//   ragged         the deepest notch: how far a line falls short of the mean of
//                  its two neighbours, over the widest line. 0 is a smooth
//                  silhouette of any shape.
//   orphan         the last line is one short word (under 40% of the widest)
//                  and the last paragraph had more than one.
//   hyphens        lines that end in a hyphen with a word continuing below.
//   path           the layout path, when the layout reports one (null today).
//   renderMatches  the exporter, laying out the same box, draws the same lines.
//
// Not measured, and not measurable offline: manual correction rate and time per
// bubble (TST-2). Those need real users on real pages.
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, loadProjectPages, page, placeDetectedOnPage, inheritedStyleFor } from '../../lib/store.svelte.js';
import { bindTags } from '../../lib/tags.svelte.js';
import {
  layoutLines,
  lineWidth,
  applyCase,
  balloonWidthsFor,
  setTypesetEnabled,
  clearLayoutMemo,
  BOX_PAD,
} from '../../lib/measure.js';
import { renderBoxTexture } from '../../lib/exporter.js';
import { systemFontEntry } from '../../lib/fonts.js';
import { defaultStyle, normalizeStyle } from '../../lib/data.js';

export const APPROVED_PATH = new URL('./approved.json', import.meta.url);

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
const PAPER = 248;
const INK = 18;
const RING = 3; // the balloon outline's width
const grey = (v) => `rgb(${v},${v},${v})`;

// Small deterministic PRNG, seeded from the case id, so a page is the same
// picture on every run and every machine.
function seeded(str) {
  let a = 2166136261;
  for (let i = 0; i < str.length; i++) a = Math.imul(a ^ str.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bodyCentre = (b) => (b.kind === 'ellipse' ? [b.cx, b.cy] : [b.x + b.w / 2, b.y + b.h / 2]);

function bodyPath(ctx, b, inset) {
  ctx.beginPath();
  if (b.kind === 'ellipse') ctx.ellipse(b.cx, b.cy, b.rx - inset, b.ry - inset, 0, 0, Math.PI * 2);
  else ctx.rect(b.x + inset, b.y + inset, b.w - inset * 2, b.h - inset * 2);
}

// A wedge from inside the body out to the tip. Drawn dark at full size and white
// inset by the outline's width, like the body, so body and tail are one closed
// figure with one outline.
function tailPath(ctx, b, inset) {
  const [cx, cy] = bodyCentre(b);
  const [tx, ty] = b.tail;
  const len = Math.hypot(tx - cx, ty - cy);
  const ux = (tx - cx) / len;
  const uy = (ty - cy) / len;
  const rx = b.kind === 'ellipse' ? b.rx : b.w / 2;
  const ry = b.kind === 'ellipse' ? b.ry : b.h / 2;
  const reach = 1 / Math.hypot(ux / rx, uy / ry); // centre to rim along the tail
  const bx = cx + ux * reach * 0.7;
  const by = cy + uy * reach * 0.7;
  const half = Math.min(rx, ry) * 0.22 - inset;
  ctx.beginPath();
  ctx.moveTo(bx - uy * half, by + ux * half);
  ctx.lineTo(tx - ux * inset * 2, ty - uy * inset * 2);
  ctx.lineTo(bx + uy * half, by - ux * half);
  ctx.closePath();
}

function drawBalloon(ctx, b, pageW) {
  for (const [colour, inset] of [
    [grey(INK), 0],
    [grey(PAPER), RING],
  ]) {
    ctx.fillStyle = colour;
    bodyPath(ctx, b, inset);
    ctx.fill();
    if (b.tail) {
      tailPath(ctx, b, inset);
      ctx.fill();
    }
  }
  if (b.cut != null) {
    // The panel above: a white gutter, and the panel's border line across the
    // balloon's top.
    ctx.fillStyle = grey(PAPER);
    ctx.fillRect(0, 0, pageW, b.cut - 3);
    ctx.fillStyle = grey(INK);
    ctx.fillRect(0, b.cut - 3, pageW, 5);
  }
}

// Screentone: mid-grey dots on a light grey, the texture balloons sit on. One
// sheet per page size, because a pattern fill is most of the cost of a page.
const tones = new Map();
function toneSheet(w, h) {
  const key = `${w}x${h}`;
  if (!tones.has(key)) {
    const tile = createCanvas(8, 8);
    const t = tile.getContext('2d');
    t.fillStyle = grey(200);
    t.fillRect(0, 0, 8, 8);
    t.fillStyle = grey(110);
    t.beginPath();
    t.arc(4, 4, 1.7, 0, Math.PI * 2);
    t.fill();
    const sheet = createCanvas(w, h);
    const g = sheet.getContext('2d');
    g.fillStyle = g.createPattern(tile, 'repeat');
    g.fillRect(0, 0, w, h);
    tones.set(key, sheet);
  }
  return tones.get(key);
}

// The page as a canvas (for the contact sheet) and as the ImageData-shaped
// object `balloon.js` reads.
export function drawPage(c) {
  const { w, h } = c.page;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(toneSheet(w, h), 0, 0);
  // Some art: dark strokes anywhere, balloons included - the balloon is drawn
  // over them, as it is on a page.
  const rnd = seeded(c.id);
  ctx.strokeStyle = grey(40);
  ctx.lineWidth = 2.5;
  for (let i = 0; i < 60; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const a = rnd() * Math.PI * 2;
    const l = 20 + rnd() * 80;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  if (c.balloon) drawBalloon(ctx, c.balloon, w);
  const img = ctx.getImageData(0, 0, w, h);
  return { canvas, image: { width: w, height: h, data: img.data } };
}

// Is a page point inside the balloon's white interior (the body; not the tail)?
export function interiorOf(b) {
  if (!b) return null;
  const top = b.cut != null ? b.cut + 2 : -Infinity;
  if (b.kind === 'ellipse') {
    const rx = b.rx - RING;
    const ry = b.ry - RING;
    return (x, y) => y >= top && ((x - b.cx) / rx) ** 2 + ((y - b.cy) / ry) ** 2 <= 1;
  }
  return (x, y) => y >= top && x >= b.x + RING && x <= b.x + b.w - RING && y >= b.y + RING && y <= b.y + b.h - RING;
}

function bodyBounds(b) {
  if (b.kind === 'ellipse') return { x0: b.cx - b.rx, y0: b.cy - b.ry, x1: b.cx + b.rx, y1: b.cy + b.ry };
  return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
}

function interiorArea(b, inside) {
  const { x0, y0, x1, y1 } = bodyBounds(b);
  let n = 0;
  for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) if (inside(x + 0.5, y + 0.5)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// The layout under test
// ---------------------------------------------------------------------------

// What the app does today: "Place from detection", then the lines every
// renderer lays that box out in.
export function storeLayout(c, { page: p }) {
  if (placeDetectedOnPage(p) !== 1) throw new Error(`${c.id}: the store placed no box`);
  const b = p.boxes[0];
  const s = b.style;
  return {
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    size: s.size,
    lines: rendererLines(b, c.text),
    fit: b.fit,
    path: null,
    box: b,
  };
}

// The exporter's, the editor's and the PSD's one call (see `layoutLines`).
function rendererLines(b, text) {
  const s = b.style;
  return layoutLines(applyCase(text, s), s, s.size, Math.max(1, b.w - BOX_PAD * 2), balloonWidthsFor(b, s, s.size));
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

// The exporter's paint of the box: how far its ink reaches past each box edge,
// its ink bounds in page px, and the share of it inside `inside`.
function inkOf(box, p, inside) {
  const tex = renderBoxTexture(box, p);
  const { canvas, ox, oy, ss } = tex;
  const W = canvas.width;
  const H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  let total = 0;
  let within = 0;
  const x0 = box.x - ox;
  const y0 = box.y - oy;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = d[(y * W + x) * 4 + 3];
      if (a === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (inside) {
        total += a;
        if (inside(x0 + (x + 0.5) / ss, y0 + (y + 0.5) / ss)) within += a;
      }
    }
  }
  if (maxX < 0) return { tex, overflow: -Infinity, inBalloon: inside ? 1 : null };
  const overflow = Math.max(
    ox - minX / ss,
    oy - minY / ss,
    (maxX + 1) / ss - ox - box.w,
    (maxY + 1) / ss - oy - box.h,
  );
  return { tex, overflow, inBalloon: inside ? within / total : null };
}

// BRK-3's oval, as a curve through the line centres: 62/86/100/86/62 at five.
function ovalProfile(n) {
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => {
    const u = (2 * i) / (n - 1) - 1;
    return 1 - 0.62 * u * u + 0.24 * u ** 4;
  });
}

function shapeScores(widths) {
  const max = Math.max(0, ...widths);
  if (!(max > 0)) return { ovalScore: null, rectScore: null, ragged: null };
  const prof = widths.map((w) => w / max);
  const oval = ovalProfile(prof.length);
  const top = Math.max(...oval);
  const rms = (target) => Math.sqrt(prof.reduce((s, v, i) => s + (v - target[i]) ** 2, 0) / prof.length);
  let ragged = 0;
  for (let i = 1; i < prof.length - 1; i++) ragged = Math.max(ragged, (prof[i - 1] + prof[i + 1]) / 2 - prof[i]);
  return {
    ovalScore: 1 - rms(oval.map((v) => v / top)),
    rectScore: 1 - rms(prof.map(() => 1)),
    ragged,
  };
}

function isOrphan(lines, widths, text) {
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1].trim();
  if (/\s/.test(last)) return false;
  const lastPara = text.split('\n').filter((s) => /\S/.test(s)).pop() ?? '';
  if (!/\s/.test(lastPara.trim())) return false; // a one-word paragraph is not an orphan
  return widths[widths.length - 1] < 0.4 * Math.max(...widths);
}

function hyphenBreaks(lines) {
  let n = 0;
  for (let i = 0; i < lines.length - 1; i++) if (/[-‐]$/.test(lines[i]) && /^\p{L}/u.test(lines[i + 1])) n++;
  return n;
}

const r1 = (v) => Math.round(v * 10) / 10;

// What "the same layout" means for approval: the box, the size and the lines.
export function signatureOf(out) {
  return { size: r1(out.size), x: r1(out.x), y: r1(out.y), w: r1(out.w), h: r1(out.h), lines: [...out.lines] };
}

function compareApproved(sig, approved) {
  if (!approved) return { status: 'new', changed: [] };
  const changed = Object.keys(sig).filter((k) => JSON.stringify(sig[k]) !== JSON.stringify(approved[k]));
  return { status: changed.length ? 'changed' : 'same', changed };
}

export function readApproved() {
  try {
    return JSON.parse(readFileSync(APPROVED_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

// The fonts and switches the bench runs under. DejaVu Sans goes in the way an
// installed font does; the typesetting beta is on, because with it off the
// layout needs a browser's DOM (see src/test/real-fonts.js).
export function prepareBench() {
  setTypesetEnabled(true);
  app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
  clearLayoutMemo();
}

export async function runCase(c, { layout = storeLayout, setPixels, approved = {}, keepArt = false }) {
  const art = drawPage(c);
  setPixels(art.image);
  // The style the letterer set up for this kind of line. No tag defaults and no
  // remembered tag sizes, so this is exactly the style a new box inherits.
  bindTags(null);
  app.chapterRef = null;
  app.lastStyle = normalizeStyle({ ...defaultStyle(), bold: false, ...c.style });
  loadProjectPages([
    {
      id: 1,
      w: c.page.w,
      h: c.page.h,
      lines: [{ n: 1, jp: c.det.lang === 'ko' ? '쿵쾅' : 'テキスト', en: c.text, type: 'dialogue', tags: [c.tag] }],
      boxes: [],
      detect: {
        panels: [],
        boxes: [{ n: 1, box: c.det.box, vertical: c.det.vertical, font_size: 20, ...(c.det.lang ? { lang: c.det.lang } : {}) }],
      },
    },
  ]);
  const p = page();
  const ctx = { page: p, line: p.lines[0], det: p.detect.boxes[0], style: inheritedStyleFor(p.lines[0]) };
  const out = await layout(c, ctx);

  const box = out.box ?? {
    id: 'bench',
    lineN: 1,
    text: null,
    x: out.x,
    y: out.y,
    w: out.w,
    h: out.h,
    style: { ...ctx.style, size: out.size },
    fit: out.fit ?? null,
  };
  const s = box.style;
  const lines = [...out.lines];
  const widths = lines.map((l) => lineWidth(l, s, out.size));
  const blockW = Math.max(0, ...widths);
  const blockH = lines.length * out.size * s.lineHeight;
  const inside = interiorOf(c.balloon);
  const ink = inkOf(box, p, inside);
  const glyphs = inkOf({ ...box, style: { ...s, strokes: [] } }, p, null);
  const sig = signatureOf(out);

  const result = {
    id: c.id,
    category: c.category,
    tag: c.tag,
    font: s.font,
    refSize: c.refSize,
    layout: { ...sig, fit: out.fit?.kind ?? 'none' },
    metrics: {
      boxOverflow: ink.overflow,
      glyphOverflow: glyphs.overflow,
      inkInBalloon: ink.inBalloon,
      sizeRatio: out.size / c.refSize,
      lineCount: lines.length,
      aspect: blockW / blockH,
      fill: inside ? (blockW * blockH) / interiorArea(c.balloon, inside) : null,
      ...shapeScores(widths),
      orphan: isOrphan(lines, widths, c.text),
      hyphens: hyphenBreaks(lines),
      path: out.path ?? null,
      renderMatches: JSON.stringify(rendererLines(box, c.text)) === JSON.stringify(lines),
    },
    approval: compareApproved(sig, approved[c.id]),
  };
  if (keepArt) {
    const b = { x: box.x, y: box.y, w: box.w, h: box.h };
    Object.defineProperty(result, 'art', { value: { page: art.canvas, tex: ink.tex, box: b, case: c } });
  }
  return result;
}

export async function runBench(cases, opts) {
  prepareBench();
  const out = [];
  for (const c of cases) out.push(await runCase(c, opts));
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const fx = (v, d = 2) => (v == null ? '-' : Number.isFinite(v) ? v.toFixed(d) : String(v));

export function benchTable(results) {
  const head = ['case', 'fit', 'size/ref', 'lines', 'box+', 'glyph+', 'in-bal', 'fill', 'aspect', 'oval', 'rect', 'notch', 'orph', 'hyph', 'path', 'approved'];
  const rows = results.map((r) => {
    const m = r.metrics;
    return [
      r.id,
      r.layout.fit,
      `${r.layout.size}/${r.refSize}`,
      String(m.lineCount),
      fx(m.boxOverflow, 1),
      fx(m.glyphOverflow, 1),
      m.inkInBalloon == null ? '-' : `${(m.inkInBalloon * 100).toFixed(1)}%`,
      fx(m.fill),
      fx(m.aspect),
      fx(m.ovalScore),
      fx(m.rectScore),
      fx(m.ragged),
      m.orphan ? 'yes' : '-',
      String(m.hyphens),
      m.path ?? '-',
      r.approval.status + (r.approval.changed.length ? `(${r.approval.changed.join(',')})` : ''),
    ];
  });
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(width[i])).join('  ').trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

// One PNG per category: each case's page around the balloon, the detector's
// rectangle (dashed), the box (magenta), and the text as the exporter paints it.
export function writeContactSheets(results, dir) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  const TW = 330;
  const TH = 300;
  const LABEL = 48;
  const GAP = 12;
  for (const cat of [...new Set(results.map((r) => r.category))]) {
    const rs = results.filter((r) => r.category === cat && r.art);
    if (!rs.length) continue;
    const cols = Math.min(3, rs.length);
    const rows = Math.ceil(rs.length / cols);
    const sheet = createCanvas(GAP + cols * (TW + GAP), GAP + rows * (TH + LABEL + GAP));
    const g = sheet.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, sheet.width, sheet.height);
    rs.forEach((r, i) => {
      const { page: pg, tex, box, case: c } = r.art;
      const tx = GAP + (i % cols) * (TW + GAP);
      const ty = GAP + Math.floor(i / cols) * (TH + LABEL + GAP);
      // The crop: the balloon, the box and the detection, with a margin.
      const rects = [
        { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h },
        { x0: c.det.box[0], y0: c.det.box[1], x1: c.det.box[2], y1: c.det.box[3] },
      ];
      if (c.balloon) rects.push(bodyBounds(c.balloon));
      const cx0 = Math.min(...rects.map((q) => q.x0)) - 24;
      const cy0 = Math.min(...rects.map((q) => q.y0)) - 24;
      const cx1 = Math.max(...rects.map((q) => q.x1)) + 24;
      const cy1 = Math.max(...rects.map((q) => q.y1)) + 24;
      const k = Math.min(TW / (cx1 - cx0), TH / (cy1 - cy0), 1.5);
      g.save();
      g.beginPath();
      g.rect(tx, ty, TW, TH);
      g.clip();
      g.fillStyle = '#dddddd';
      g.fillRect(tx, ty, TW, TH);
      g.translate(tx + (TW - (cx1 - cx0) * k) / 2, ty + (TH - (cy1 - cy0) * k) / 2);
      g.scale(k, k);
      g.translate(-cx0, -cy0);
      g.drawImage(pg, 0, 0);
      g.drawImage(tex.canvas, box.x - tex.ox, box.y - tex.oy, tex.cw, tex.ch);
      g.lineWidth = 1 / k;
      g.setLineDash([4 / k, 3 / k]);
      g.strokeStyle = '#1e7fd6';
      g.strokeRect(c.det.box[0], c.det.box[1], c.det.box[2] - c.det.box[0], c.det.box[3] - c.det.box[1]);
      g.setLineDash([]);
      g.strokeStyle = '#e0138c';
      g.strokeRect(box.x, box.y, box.w, box.h);
      g.restore();
      const m = r.metrics;
      g.fillStyle = '#111111';
      g.font = "bold 12px 'DejaVu Sans'";
      g.fillText(`${r.id}  (${r.layout.fit}, ${r.approval.status})`, tx, ty + TH + 15);
      g.font = "11px 'DejaVu Sans'";
      g.fillText(
        `size ${r.layout.size}/${r.refSize}  ${m.lineCount} lines  box ${fx(m.boxOverflow, 1)}  glyph ${fx(m.glyphOverflow, 1)}`,
        tx,
        ty + TH + 30,
      );
      g.fillText(
        `in balloon ${m.inkInBalloon == null ? '-' : (m.inkInBalloon * 100).toFixed(1) + '%'}  fill ${fx(m.fill)}  oval ${fx(m.ovalScore)}  rect ${fx(m.rectScore)}`,
        tx,
        ty + TH + 44,
      );
    });
    const file = join(dir, `${cat}.png`);
    writeFileSync(file, sheet.toBuffer('image/png'));
    written.push(file);
  }
  return written;
}

export function writeReport(results, dir, meta = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify({ ...meta, cases: results }, null, 2) + '\n');
  return file;
}

// Approve the current layout of the named cases (or 'all'), merged into the
// checked-in approved.json.
export function approve(results, ids) {
  const all = readApproved();
  const pick = ids === 'all' ? results : results.filter((r) => ids.includes(r.id));
  for (const r of pick) {
    const { fit: _fit, ...sig } = r.layout;
    all[r.id] = sig;
  }
  const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  writeFileSync(APPROVED_PATH, JSON.stringify(sorted, null, 2) + '\n');
  return pick.map((r) => r.id);
}
