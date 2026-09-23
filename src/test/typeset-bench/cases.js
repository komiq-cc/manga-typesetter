// The lettering benchmark's cases (TST-2). Synthetic and hand-written: no page
// images from any real book, and all the English is written for this file.
//
// A case is one balloon on one page, and everything the app would be handed for
// it:
//
//   page      the page's size in px. The runner draws it: a screentone page
//             with a white balloon in a dark outline (see runner.js).
//   balloon   the bubble the text belongs in, or null for text set over the
//             art. `{ kind: 'ellipse', cx, cy, rx, ry }` or
//             `{ kind: 'rect', x, y, w, h }` (outer edge of the outline), plus
//             optional `tail: [x, y]` (tip of a tail) and `cut: y` (a panel
//             border across the top of the balloon, cutting it off above y).
//   det       what the detector reported: the source text's rectangle
//             `[x1, y1, x2, y2]`, and whether it was set vertically.
//   text      the translation, `\n` between paragraphs.
//   tag       the line's tag.
//   style     font, size and outline as the letterer's style would give them.
//             The fixtures have regular faces only, so the runner sets
//             `bold: false` on everything.
//   refSize   the size a human letterer would pick for this balloon. Today's
//             placement never picks a size (FIT-1), so size / refSize is where
//             that shows.
//
// Categories group the cases for the contact sheets.

const box = (cx, cy, w, h) => [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];

const PAGE = { w: 700, h: 900 };
const COMIC = 'Comic Neue';
const BANGERS = 'Bangers';
const DEJAVU = 'DejaVu Sans';

export const CASES = [
  // ---- ordinary ovals: vertical Japanese in a wide bubble ----
  {
    id: 'oval-short',
    category: 'oval',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 120, ry: 80, tail: [470, 420] },
    det: { box: box(350, 300, 60, 110), vertical: true },
    text: 'Where did you put the keys?',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 26,
  },
  {
    id: 'oval-medium',
    category: 'oval',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 320, rx: 165, ry: 115, tail: [200, 480] },
    det: { box: box(350, 320, 120, 160), vertical: true },
    text: 'If we leave right now, we can still catch the last train before the storm hits.',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 26,
  },
  {
    id: 'oval-long',
    category: 'oval',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 360, rx: 215, ry: 155, tail: [560, 560] },
    det: { box: box(350, 360, 180, 220), vertical: true },
    text:
      'You keep saying the plan is simple, but every simple plan you have ever made has ended ' +
      'with us running from somebody, soaking wet, at three in the morning.',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 24,
  },

  // ---- upright ovals: taller than wide ----
  {
    id: 'upright-tall',
    category: 'upright',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 330, rx: 105, ry: 175, tail: [250, 540] },
    det: { box: box(350, 330, 50, 210), vertical: true },
    text: 'I told you already. I am not going back there. Not tonight, not ever.',
    tag: 'dialogue',
    style: { font: COMIC, size: 24 },
    refSize: 24,
  },
  {
    // GEO-1's probe: a six-line block in an oval whose usable interior is about
    // 120 x 160 px half-axes after the safety inset.
    id: 'upright-six',
    category: 'upright',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 340, rx: 137, ry: 177 },
    det: { box: box(350, 340, 110, 230), vertical: true },
    text:
      'Everyone in this town knows the old mill is haunted, but nobody will tell you who haunts it, ' +
      'or why they never leave.',
    tag: 'dialogue',
    style: { font: COMIC, size: 22 },
    refSize: 22,
  },

  // ---- captions: rectangular narration boxes ----
  {
    id: 'caption-wide',
    category: 'caption',
    page: PAGE,
    balloon: { kind: 'rect', x: 40, y: 40, w: 330, h: 86 },
    det: { box: [70, 58, 340, 108], vertical: false },
    text: 'Three days later, somewhere north of the border.',
    tag: 'narration',
    style: { font: COMIC, size: 22 },
    refSize: 22,
  },
  {
    id: 'caption-block',
    category: 'caption',
    page: PAGE,
    balloon: { kind: 'rect', x: 420, y: 60, w: 240, h: 170 },
    det: { box: [470, 80, 610, 210], vertical: true },
    text: 'The city never really sleeps. It just lowers its voice and waits for somebody to listen.',
    tag: 'narration',
    style: { font: COMIC, size: 22 },
    refSize: 21,
  },
  {
    // Italic in a real oblique face, whose ink leans past its advances.
    id: 'caption-italic',
    category: 'caption',
    page: PAGE,
    balloon: { kind: 'rect', x: 200, y: 620, w: 300, h: 96 },
    det: { box: [230, 640, 470, 696], vertical: false },
    text: 'Meanwhile, back at the harbour, nobody had noticed a thing.',
    tag: 'narration',
    style: { font: DEJAVU, size: 20, italic: true },
    refSize: 20,
  },

  // ---- long names and long words ----
  {
    id: 'name-rank',
    category: 'name',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 320, rx: 170, ry: 110, tail: [520, 450] },
    det: { box: box(350, 320, 130, 150), vertical: true },
    text: 'Lieutenant Commander Anastasia Wolkenstein-Ravensburg, reporting for duty!',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 24,
  },
  {
    id: 'name-long-word',
    category: 'name',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 320, rx: 140, ry: 100, tail: [200, 430] },
    det: { box: box(350, 320, 100, 140), vertical: true },
    text: 'Professor Oberkirchnerhartmannsweiler wants you in his office. Now.',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 22,
  },

  // ---- short exclamations ----
  {
    id: 'exclaim-what',
    category: 'exclaim',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 70, ry: 50, tail: [430, 380] },
    det: { box: box(350, 300, 34, 70), vertical: true },
    text: 'What?!',
    tag: 'dialogue',
    style: { font: COMIC, size: 30, uppercase: true },
    refSize: 30,
  },
  {
    // One word in a big balloon: the size a letterer would reach for is far
    // above the style's, and nothing today grows it.
    id: 'exclaim-no',
    category: 'exclaim',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 320, rx: 150, ry: 110, tail: [180, 430] },
    det: { box: box(350, 320, 40, 90), vertical: true },
    text: 'No.',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 40,
  },
  {
    id: 'exclaim-wait',
    category: 'exclaim',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 115, ry: 72, tail: [230, 390] },
    det: { box: box(350, 300, 70, 100), vertical: true },
    text: 'Hey! Wait up!',
    tag: 'dialogue',
    style: { font: BANGERS, size: 32 },
    refSize: 32,
  },

  // ---- more than one paragraph in a balloon ----
  {
    id: 'para-three',
    category: 'para',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 360, rx: 200, ry: 160, tail: [150, 560] },
    det: { box: box(350, 360, 170, 220), vertical: true },
    text: 'Listen.\nThe bridge is out, the radio is dead, and nobody knows we are here.\nSo we walk.',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 24,
  },
  {
    // GEO-2's probe: two paragraphs, and rows for each.
    id: 'para-two',
    category: 'para',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 340, rx: 175, ry: 135, tail: [540, 500] },
    det: { box: box(350, 340, 130, 180), vertical: true },
    text: 'I found the letter in your coat.\nWere you ever going to tell me?',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 25,
  },

  // ---- outlined type ----
  {
    // Over the art, no balloon: the heavy outline is what makes it readable.
    id: 'outline-art',
    category: 'outline',
    page: PAGE,
    balloon: null,
    det: { box: [210, 500, 490, 580], vertical: false },
    text: 'STAY BEHIND ME!',
    tag: 'shout',
    style: { font: BANGERS, size: 34, strokes: [{ color: '#ffffff', width: 6, opacity: 1 }] },
    refSize: 34,
  },
  {
    id: 'outline-double',
    category: 'outline',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 155, ry: 95, tail: [520, 420] },
    det: { box: box(350, 300, 100, 130), vertical: true },
    text: "Don't you dare touch that button.",
    tag: 'dialogue',
    style: {
      font: COMIC,
      size: 26,
      strokes: [
        { color: '#ffffff', width: 4, opacity: 1 },
        { color: '#1a1a1a', width: 2, opacity: 1 },
      ],
    },
    refSize: 26,
  },

  // ---- awkward balloon edges ----
  {
    id: 'edge-narrow',
    category: 'edge',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 330, rx: 58, ry: 165 },
    det: { box: box(350, 330, 30, 200), vertical: true },
    text: 'Sorry, excuse me, coming through.',
    tag: 'dialogue',
    style: { font: COMIC, size: 24 },
    refSize: 20,
  },
  {
    id: 'edge-tiny',
    category: 'edge',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 46, ry: 34, tail: [400, 360] },
    det: { box: box(350, 300, 22, 40), vertical: true },
    text: 'Huh?',
    tag: 'dialogue',
    style: { font: COMIC, size: 26 },
    refSize: 18,
  },
  {
    id: 'edge-flat',
    category: 'edge',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 230, ry: 52 },
    det: { box: box(350, 300, 260, 40), vertical: false },
    text: 'Keep your voice down, the guards are right outside.',
    tag: 'dialogue',
    style: { font: COMIC, size: 24 },
    refSize: 22,
  },
  {
    // A balloon running into the panel border above it, which cuts its top off.
    id: 'edge-clipped',
    category: 'edge',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 170, rx: 165, ry: 115, cut: 100 },
    det: { box: box(350, 185, 110, 130), vertical: true },
    text: 'We were never supposed to find this place.',
    tag: 'dialogue',
    style: { font: COMIC, size: 24 },
    refSize: 24,
  },

  // ---- sound effects: tokens no line breaker can split ----
  {
    id: 'sfx-balloon',
    category: 'sfx',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 110, ry: 80 },
    det: { box: box(350, 300, 60, 120), vertical: true },
    text: 'KRRSSHH!!',
    tag: 'sfx',
    style: { font: BANGERS, size: 40 },
    refSize: 34,
  },
  {
    // OVF-4's example, over the art: 478 px of token at 30 px.
    id: 'sfx-art',
    category: 'sfx',
    page: PAGE,
    balloon: null,
    det: { box: [306, 250, 392, 650], vertical: true },
    text: 'AAAAAARRRRRGGGGGHHHHHHHHH!!!!',
    tag: 'sfx',
    style: { font: BANGERS, size: 30 },
    refSize: 30,
  },

  // ---- Hangul and kana left in the translation ----
  // None of the fixture faces has these glyphs, so they measure and draw as
  // `.notdef` boxes about half an em wide - narrower than a real CJK face.
  {
    id: 'cjk-hangul',
    category: 'cjk',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 300, rx: 120, ry: 85 },
    det: { box: box(350, 300, 130, 50), vertical: false, lang: 'ko' },
    text: '쿵쾅쿵쾅쿵쾅!!',
    tag: 'sfx',
    style: { font: COMIC, size: 30 },
    refSize: 30,
  },
  {
    id: 'cjk-kana',
    category: 'cjk',
    page: PAGE,
    balloon: { kind: 'ellipse', cx: 350, cy: 320, rx: 150, ry: 100, tail: [510, 440] },
    det: { box: box(350, 320, 100, 140), vertical: true },
    text: 'She just whispered ドキドキ and ran off.',
    tag: 'dialogue',
    style: { font: COMIC, size: 24 },
    refSize: 24,
  },
];

export const CATEGORIES = [...new Set(CASES.map((c) => c.category))];
