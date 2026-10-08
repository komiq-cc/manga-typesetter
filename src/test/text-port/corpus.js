// data.js and its brush geometry dependency are pure: keep the frozen corpus
// tied to the app's real schema without importing measurement or a host.
import { defaultStyle, normalizeFit, PATTERN_KINDS } from '../../lib/data.js';

export const sizes = [8, 11, 12, 14.5, 16, 18, 22, 22.5, 26, 30, 33.3, 40, 64, 96];
const strings = [
  ['words', 'Hello world', 'words'],
  ['dialogue', 'WHAT THE HELL ARE YOU DOING?!', 'caps'],
  ['wont', "I WON'T LET YOU...!!", 'caps'],
  ['mixed', 'Wait, Captain McCloud!', 'mixed'],
  ...['AV', 'AVA', 'To', 'Ty', 'WA', 'LT', 'Yo', 'P.', 'r.'].map((s, i) => [`kern-${i}`, s, 'kern']),
  ...['fi', 'fl', 'ffi', 'ffl', 'office waffle'].map((s, i) => [`liga-${i}`, s, 'ligature']),
  ...['...', '!?', '?!', '‼', '—', '-', "'\"", '‘’“”'].map((s, i) => [`punct-${i}`, s, 'punctuation']),
  ['digits', '0123456789', 'digits'],
  ['hyphen', 'extraordi-', 'hyphen'],
  ...['ÉCLAT', 'naïve', 'Über', 'façade'].map((s, i) => [`accent-${i}`, s, 'accent']),
  ['leading', '  WAIT!', 'spaces'], ['double', 'Wait  for me', 'spaces'],
  ...['A', 'g', 'W', 'i', '.', ' '].map((s, i) => [`single-${i}`, s, 'single']),
  ['pangram', 'The quick brown fox jumps over the lazy dog, while five boxing wizards jump quickly.', 'pangram'],
  ['nbsp', 'Wait\u00a0here', 'nbsp'], ['tab', 'Wait\there', 'tab'],
  ['hangul', '안녕하세요', 'missing-glyph'], ['japanese', 'かな漢字', 'missing-glyph'], ['emoji', '😀', 'missing-glyph'],
];
const subset = [0, 1, 3, 4, 6, 13, 17, 18, 26, 28, 35, 43];
const texts = [
  'WAIT!', 'Come back here now.', 'WHAT THE HELL ARE YOU DOING?! I WON\'T LET YOU...!!',
  'WAIT!\n\nYou mean the red door?\nNo way.',
  'Pneumonoultramicroscopicsilicovolcanoconiosis negotiations.',
  'If we leave right now we can still catch the last train before the storm hits the valley. I told you this morning that the bridge would not hold and nobody listened to me not even the captain beside you.',
];
const page = { w: 800, h: 1200 };
const copy = (x) => JSON.parse(JSON.stringify(x));
export function completeStyle(over = {}) {
  const s = defaultStyle();
  for (const [k, v] of Object.entries(over)) {
    s[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...s[k], ...copy(v) } : copy(v);
  }
  return s;
}
export function familiesOf(list) {
  return [...new Set(list.fonts.map((f) => f.family))].sort();
}
// Index as well as slug: distinct Unicode family names must never collide.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';
const familyId = (family, i) => `${i}-${slug(family)}`;
function faux(list, family, bold, italic) {
  const slots = list.fonts.filter((f) => f.family === family).map((f) => f.slot);
  if (slots.includes(bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular')) return [];
  if (bold && italic) return slots.includes('italic') ? ['faux-bold'] : slots.includes('bold') ? ['faux-italic'] : ['faux-bold', 'faux-italic'];
  return [bold ? 'faux-bold' : null, italic ? 'faux-italic' : null].filter(Boolean);
}
export function metricsCases(list) {
  const cases = [];
  familiesOf(list).forEach((font, f) => {
    for (const [slot, bold, italic] of [['r', false, false], ['b', true, false], ['i', false, true], ['bi', true, true]]) {
      for (const size of sizes) {
        for (const [id, text, tag] of (size === 22 || size === 40 ? strings : subset.map((i) => strings[i]))) {
          cases.push({ id: `m.${familyId(font, f)}.${slot}.${size}.${id}`, font, bold, italic, size, text, style: completeStyle({ font, bold, italic, size }), tags: [tag, ...faux(list, font, bold, italic)] });
        }
      }
    }
  });
  return cases;
}
function boxCase(id, font, size, text, over = {}, extra = {}) {
  return { id, mode: 'smart', page: { ...page }, box: { id, x: 200, y: 250, w: 240, h: 180, text, style: completeStyle({ font, size, ...over }), fit: null }, ...extra };
}
const path = { on: true, pts: [
  { x: 10, y: 90, ix: 0, iy: 0, ox: 50, oy: -40 },
  { x: 230, y: 90, ix: -50, iy: 40, ox: 0, oy: 0 },
] };
const stroke = (width, color = '#ffffff', opacity = 1) => ({ width, color, opacity });
export function layoutCases(list) {
  const families = familiesOf(list);
  const cases = [];
  // 216 text/width/align/valign combinations, three cyclic samples each.
  // Family, size, mode and stroke rotate independently instead of expanding
  // the full product. Three fixture families give 648 base cases.
  let n = 0;
  for (const text of texts) for (const w of [60, 120, 200, 320]) {
    for (const align of ['left', 'center', 'right']) for (const valign of ['top', 'middle', 'bottom']) {
      for (let j = 0; j < Math.max(3, families.length); j++) {
        const c = boxCase(`l.matrix.${n}.${j}`, families[(n + j) % families.length], [14, 22, 40][(Math.floor(n / 3) + j) % 3], text, {
          align, valign, strokes: [[], defaultStyle().strokes, [stroke(6)]][(Math.floor(n / 9) + j) % 3],
        });
        c.box.w = w;
        c.mode = (n + j) % 2 ? 'plain' : 'smart';
        cases.push(c);
      }
      n++;
    }
  }
  const additions = [
    { shape: 'off' }, ...[-1, 0, 2].map((letterSpacing) => ({ letterSpacing })),
    ...[1, 1.1, 1.4].map((lineHeight) => ({ lineHeight })), { uppercase: true },
    { curve: -60 }, { curve: 30 }, { circle: { on: true } }, { path },
  ];
  families.forEach((font, i) => {
    additions.forEach((over, j) => cases.push(boxCase(`l.extra.${i}.${j}`, font, 22, texts[1], over)));
    for (const fit of [
      { kind: 'ellipse', cx: 320, cy: 340, rx: 120, ry: 90 },
      { kind: 'rect', x: 200, y: 250, w: 240, h: 180 },
    ]) {
      const c = boxCase(`l.fit.${i}.${fit.kind}`, font, 22, texts[5]);
      c.box.fit = normalizeFit(fit);
      cases.push(c);
    }
  });
  const regions = [
    { kind: 'ellipse', cx: 400, cy: 400, rx: 170, ry: 140 },
    { kind: 'ellipse', cx: 300, cy: 300, rx: 90, ry: 70 },
    { kind: 'rect', x: 220, y: 260, w: 360, h: 280 },
    { kind: 'hint', x: 380, y: 380, w: 40, h: 40 }, null,
  ];
  // Six texts x five regions x two reference sizes = 60 solver answers.
  texts.forEach((text, i) => regions.forEach((region, j) => {
    for (const refSize of [22, 40]) cases.push({
      id: `l.solve.${i}.${j}.${refSize}`, mode: 'smart', solve: {
        text, style: completeStyle({ font: families[(i + j) % families.length], align: ['left', 'center', 'right'][i % 3] }),
        refSize, region, locks: {}, opts: { minSize: 12, minW: 30, minH: 20, box: { x: 250, y: 300, w: 300, h: 200 }, page: { ...page } },
      },
    });
  }));
  return cases;
}
export function pixelsCases(list) {
  const cases = [];
  const pixelTexts = ['AVATAR WAVE!', 'WAIT!\nCome back here.\nI won\'t let you!!'];
  familiesOf(list).forEach((font, i) => {
    for (const size of [14, 22, 40]) pixelTexts.forEach((text, t) => {
      for (const align of ['left', 'center', 'right']) cases.push(boxCase(`p.base.${i}.${size}.${t}.${align}`, font, size, text, { align, strokes: [] }, { via: 'texture' }));
    });
  });
  const sh = { x: 4, y: 3, blur: 0, color: '#333333', opacity: 1 };
  const effects = [
    ...[1, 2, 3].map((n) => [`bands-${n}`, { strokes: Array.from({ length: n }, (_, i) => stroke(2, ['#ffffff', '#e22b2b', '#000000'][i])) }]),
    ['band-alpha', { strokes: [stroke(3, '#000000', 0.5)] }],
    ...[0, 90].map((angle) => [`linear-${angle}`, { gradient: { on: true, angle } }]),
    ['radial', { gradient: { on: true, kind: 'radial' } }], ['line-gradient', { gradient: { on: true, scope: 'line' } }],
    ...PATTERN_KINDS.map((kind) => [`pattern-${kind}`, { pattern: { on: true, kind } }]),
    ['shadow', { shadows: [sh] }], ['shadow-blur', { shadows: [{ ...sh, blur: 3 }] }],
    ['shadows', { shadows: [sh, { ...sh, x: -4, y: -3 }] }],
    ['shadows-blur', { shadows: [{ ...sh, blur: 3 }, { ...sh, x: -4, y: -3, blur: 5 }] }],
    ['blur', { blur: 2 }], ['motion', { motionBlur: { on: true, x: 2, y: 1, amount: 8 } }],
    ['roughen', { roughen: { on: true } }],
    ...['include', 'exclude'].map((mode) => [`clip-${mode}`, { clip: { on: true, mode, shapes: [{ kind: 'ellipse', cx: 120, cy: 90, rx: 85, ry: 55 }] } }]),
    ['spacing', { letterSpacing: 3 }], ['faux-bold', { bold: true }], ['faux-italic', { italic: true }],
    ['arc', { curve: 30 }], ['circle', { circle: { on: true } }], ['path', { path }],
    ...[0, 7, 33, 90].map((rotation) => [`rotation-${rotation}`, { rotation }, 'layer']),
    ['rotation-shadow', { rotation: 33, shadows: [sh] }, 'layer'],
    ['flip-h', { flipH: true }, 'layer'], ['flip-v', { flipV: true }, 'layer'],
  ];
  const targets = [['Comic Neue', 22], ['Comic Neue', 40], ['Bangers', 40]].filter(([f]) => familiesOf(list).includes(f));
  targets.forEach(([font, size], i) => effects.forEach(([name, over, via = 'texture']) => {
    pixelTexts.forEach((text, t) => cases.push(boxCase(`p.fx.${i}.${name}.${t}`, font, size, text, { strokes: [], ...over }, { via, tags: [name, ...faux(list, font, !!over.bold, !!over.italic)] })));
  }));
  return cases;
}
export function buildCorpus(list) {
  if (!list.fonts?.length) throw new Error('fonts.json contains no fonts');
  return Object.fromEntries([['metrics', metricsCases], ['layout', layoutCases], ['pixels', pixelsCases]].map(([name, fn]) => [name, { version: 1, cases: fn(list) }]));
}
