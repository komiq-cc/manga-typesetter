// The boxes src/lib/fx-compare.engine.test.js paints before and after. Each is
// a name, a style laid over the default (font Bangers at 56), and optionally
// its text, its size and the paper it is shown on.
const stroke = (color, width) => ({ color, width, opacity: 1 });
const shadow = (over = {}) => ({ color: '#000000', opacity: 0.6, x: 6, y: 6, blur: 6, ...over });
const rough = (amount, detail, seed = 7, grit = 0) => ({ on: true, amount, detail, seed, grit });
const pattern = (kind, over = {}) => ({ on: true, kind, fg: '#000000', bg: '#ffffff', scale: 1, ...over });

export const FX_CASES = [
  // ---- roughening ----
  { name: 'rough-1-default', style: { roughen: rough(4, 0.05) } },
  { name: 'rough-2-strong', style: { roughen: rough(10, 0.05) } },
  { name: 'rough-3-fine', style: { roughen: rough(4, 0.15) } },
  { name: 'rough-4-max', style: { roughen: rough(20, 0.2) } },
  {
    name: 'rough-5-outline',
    style: { color: '#ffffff', strokes: [stroke('#000000', 5)], roughen: rough(6, 0.08) },
    paper: '#d8d8d8',
  },
  {
    name: 'rough-6-thin-type',
    text: 'thin strokes\nbreak first',
    style: { font: 'Comic Neue', size: 34, roughen: rough(6, 0.12) },
  },
  {
    name: 'rough-7-gradient',
    style: {
      gradient: { on: true, kind: 'linear', angle: 90, scope: 'box', stops: [{ pos: 0, color: '#ff3b30' }, { pos: 1, color: '#1d4ed8' }] },
      strokes: [stroke('#000000', 4)],
      roughen: rough(8, 0.06),
    },
  },
  {
    name: 'rough-8-shadow',
    style: { strokes: [stroke('#ffffff', 4)], shadows: [shadow()], roughen: rough(6, 0.07) },
    paper: '#bcd3ea',
  },
  { name: 'rough-9-blurred', style: { blur: 1.5, roughen: rough(8, 0.06) } },
  { name: 'rough-10-turned', style: { rotation: 12, roughen: rough(6, 0.07) } },

  // ---- grit: the fine tear over the crumple (only the engine draws it) ----
  { name: 'grit-1-light', style: { roughen: rough(4, 0.05, 7, 1) } },
  { name: 'grit-2-medium', style: { roughen: rough(4, 0.05, 7, 2) } },
  { name: 'grit-3-heavy', style: { roughen: rough(10, 0.05, 7, 4) } },
  { name: 'grit-4-alone', style: { roughen: rough(0, 0.05, 7, 2.5) } },
  { name: 'grit-5-thin-type', text: 'thin strokes\nbreak first', style: { font: 'Comic Neue', size: 34, roughen: rough(6, 0.12, 7, 1.5) } },
  {
    name: 'grit-6-outline',
    style: { color: '#ffffff', strokes: [stroke('#000000', 5)], roughen: rough(6, 0.08, 7, 2) },
    paper: '#d8d8d8',
  },

  // ---- the box job: shadows, blur, smear, mask ----
  { name: 'box-1-shadow', style: { strokes: [stroke('#ffffff', 4)], shadows: [shadow()] }, paper: '#bcd3ea' },
  {
    name: 'box-2-two-shadows',
    style: { color: '#ffffff', strokes: [stroke('#111111', 4)], shadows: [shadow({ color: '#ff2d55', opacity: 1, x: 5, y: 5, blur: 0 }), shadow({ x: 10, y: 10, blur: 10 })] },
    paper: '#f4e9c9',
  },
  { name: 'box-3-glow', style: { color: '#ffffff', strokes: [], shadows: [shadow({ color: '#00a2ff', opacity: 1, x: 0, y: 0, blur: 14 })] }, paper: '#101820' },
  { name: 'box-4-blur', style: { strokes: [], blur: 2.5 } },
  { name: 'box-5-smear', style: { strokes: [], motionBlur: { on: true, x: 2, y: 0, amount: 16 } } },
  { name: 'box-6-smear-diagonal', style: { strokes: [], motionBlur: { on: true, x: 1.5, y: -1, amount: 24 } } },
  {
    name: 'box-7-mask-include',
    style: { strokes: [stroke('#ffffff', 4)], shadows: [shadow()], clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 160, cy: 75, rx: 120, ry: 55 }] } },
    paper: '#bcd3ea',
  },
  {
    name: 'box-8-mask-brush',
    style: {
      strokes: [],
      clip: { on: true, mode: 'exclude', shapes: [{ kind: 'stroke', size: 14, pts: [[30, 20], [110, 70], [170, 40], [240, 110], [300, 60]] }, { kind: 'stroke', size: 22, pts: [[70, 120]] }] },
    },
  },

  // ---- turned and mirrored: painted at the angle, not turned afterwards ----
  { name: 'turn-1-plain-shadow', style: { rotation: 17, strokes: [stroke('#ffffff', 4)], shadows: [shadow()] }, paper: '#bcd3ea' },
  { name: 'turn-2-thin-type', text: 'small type, turned\nstays sharp', style: { font: 'Comic Neue', size: 22, rotation: -8, strokes: [], shadows: [shadow({ x: 2, y: 2, blur: 2 })] } },
  { name: 'turn-3-mirrored', style: { flipH: true, strokes: [stroke('#ffffff', 4)], shadows: [shadow()] }, paper: '#bcd3ea' },
  { name: 'turn-4-blur-smear', style: { rotation: 30, strokes: [], motionBlur: { on: true, x: 2, y: 0, amount: 12 } } },
  {
    name: 'turn-5-mask',
    style: { rotation: -20, strokes: [stroke('#ffffff', 4)], clip: { on: true, mode: 'include', shapes: [{ kind: 'poly', pts: [[10, 10], [310, 30], [280, 140], [40, 120]] }] } },
    paper: '#d8d8d8',
  },

  // ---- pattern fills: the tile is the engine's drawing ----
  { name: 'tone-1-halftone', style: { pattern: pattern('halftone'), strokes: [stroke('#000000', 4)] } },
  { name: 'tone-2-dots-small', style: { pattern: pattern('dots', { scale: 0.5 }), strokes: [stroke('#000000', 4)] } },
  { name: 'tone-3-diagonal', style: { pattern: pattern('diagonal', { fg: '#ff2d55', bg: '#ffe9a8' }), strokes: [stroke('#111111', 4)] } },
  { name: 'tone-4-crosshatch', style: { pattern: pattern('crosshatch'), strokes: [stroke('#000000', 4)] } },
  { name: 'tone-5-grid-turned', style: { rotation: 14, pattern: pattern('grid', { fg: '#1d4ed8' }), strokes: [stroke('#000000', 4)] } },
  {
    name: 'tone-6-halftone-rough',
    style: { pattern: pattern('halftone', { scale: 0.7 }), strokes: [stroke('#000000', 5)], roughen: rough(6, 0.07), shadows: [shadow()] },
    paper: '#bcd3ea',
  },

  // ---- the mesh, with what used to keep it on the canvas ----
  {
    name: 'mesh-1-mask',
    style: {
      strokes: [stroke('#ffffff', 4)],
      shadows: [shadow()],
      warp: { on: true, cols: 2, rows: 1, pts: [[0, 20], [160, -10], [320, 25], [10, 150], [160, 125], [310, 160]] },
      clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 160, cy: 75, rx: 130, ry: 60 }] },
    },
    paper: '#bcd3ea',
  },
  {
    name: 'mesh-2-rough-turned',
    style: {
      rotation: 10,
      color: '#ffffff',
      strokes: [stroke('#000000', 5)],
      roughen: rough(6, 0.07),
      warp: { on: true, cols: 2, rows: 1, pts: [[0, 0], [160, 30], [320, 0], [0, 150], [160, 180], [320, 150]] },
    },
    paper: '#d8d8d8',
  },
];
