# P6 report: with the Rust engine on, the editor shows a box as the engine's own picture

Branch `tp/editor`, cut from `text-port` at `56e99c7`. Eight commits, none
pushed, no trailers:

```
28f9b0e feat(editor): the rust painter is installed with the rust engine, and taken out with it
9f4f348 feat(editor): a box's texture can be painted at a scale other than the export's 2
84451f4 test(editor): the structure of a box with the switch off is written down before anything changes it
0823d25 feat(editor): with the rust engine drawing, a box at rest is one canvas painted by the exporter
0d64416 fix(editor): the picture follows the display and sits on the screen's pixels
4f63da0 test(editor): a page and a driver that check the editor in a real browser
0119191 feat(editor): a turned box is painted finer than the screen, and the picture's arithmetic is tested
cb2eab0 test(editor): the check times a resize at 300% and a page turn both ways
```

"Measured" below means I ran it and read the number or looked at the picture.
"Inferred" means it follows from the code and I did not observe it. Everything
measured in a browser was measured in headless Chrome 155 on this Mac, started
as a real 1x or 2x display (`--force-device-scale-factor`). **Nothing was run
in the Tauri app or in WebKit.** Section 12 lists what that leaves open.

## 1. Result in short

- The Rust painter goes in and out with the Rust engine; `engineSwitch.painting`
  is the one flag that says so, and the editor reads only that.
- With the flag true, a box at rest is one canvas painted by `renderBoxTexture`
  at zoom x device pixel ratio. The warped-box canvas became that general
  path: same element, same effect, same sequence counter, same release.
- A box being typed into, or whose curve is being edited, is today's DOM.
- With the flag false nothing changes: suite green with no existing test
  edited, both capture runs byte-identical to their references, DOM snapshot
  taken before `TextBox.svelte` was touched still matches.
- In a real browser, at every zoom and density tried, every editor canvas
  holds exactly `renderBoxTexture`'s bytes (30 of 30 synthetic, 23 of 23 real),
  and every upright picture is shown on screen pixel for pixel (25 of 25).
- On a 2x display at 100% the editor's screen pixels equal the 2x export's
  file pixels exactly for 26 of 30 box kinds. The four that differ are
  explained in section 6.
- Three bugs that every jsdom test passed were found only by the browser run
  (section 11). One of them painted no box at all.

## 2. What was built, file by file

Modified:

- `src/lib/engine-switch.svelte.js` - painter installed with the engine,
  removed with it; `engineSwitch.painting`. Hunks in section 14.
- `src/lib/exporter.js` - scale parameter and pixel budget for
  `renderBoxTexture`; two scratch canvases released. Hunks in section 14.
- `src/lib/TextBox.svelte` - the display path. `enginePaints` (the flag),
  `engineShown = enginePaints && !editing` (the seam), `pictureRes` (scale),
  `near`/`pictureOn` (whether this box holds pixels), `pictured = warped ||
  engineShown`. `warpKey` is `pictureKey(...)` or `PICTURE_OFF` when the engine
  shows the box and the old key otherwise. `paintWarp` and the mesh gizmo's
  `begin`/`frame` branch on `engineShown`. The paint effect releases the
  canvas on `PICTURE_OFF`. Template: the DOM text stack, the roughen SVG
  filter, the motion-blur taps, the mask CSS and the ink canvas are not
  rendered while `engineShown`; the canvas gets `data-painter="engine"` and
  `pictureCss(...)`. No CSS rule was added.
- `src/lib/editor/Canvas.svelte` - two attributes: strip boxes get `lazy`,
  paged boxes get `shown={m.i === app.pageIndex}`. Neither is read unless
  the flag is true.

New, shipped:

- `src/lib/editor/box-picture.js` - `PICTURE_MAX_PX`, `TURNED_OVERSAMPLE`,
  `pictureScale`, `paintBoxPicture`, `paintPictureTexture`, `pictureCss`,
  `pageCorner`, `PICTURE_OFF`, `pictureKey`.
- `src/lib/editor/display-scale.svelte.js` - `displayScale()`, the device
  pixel ratio as something reactive (a `createSubscriber` on a `resolution`
  media query; listens only while a picture depends on it).
- `src/lib/editor/near-view.js` - `watchNear(el, cb)`, one shared
  `IntersectionObserver` with a 50% margin.

New, tests and tools:

- `src/lib/engine-switch-painter.test.js` (unit, 11)
- `src/lib/exporter-scale.engine.test.js` (engine, 22)
- `src/lib/TextBox-switch-off.dom.test.js` + snapshot (dom, 18; 13 snapshots)
- `src/lib/TextBox-engine-picture.dom.test.js` (dom, 66)
- `src/lib/editor/box-picture.test.js` (unit, 34)
- `src/lib/editor/near-view.test.js` (unit, 7)
- `src/lib/editor/box-picture.engine.test.js` (engine, 32)
- `src/test/fake-canvas.js`, `src/test/dom-outline.js` - helpers for the above
- `editor-check.html`, `src/test/editor-check/host.js`,
  `scripts/editor-check.mjs` - the real-browser check (section 15)

Not touched: `text-engine/**` (this report is the only file added there),
`scripts/text-port/**`, `src/test/text-port/**`, `measure.js`,
`browser-painter.js`, `rust-painter.js`, every existing test.

## 3. Scale and pixel budget

**Scale.** `pictureScale(zoom, dpr, rotation) = zoom * dpr`, times
`TURNED_OVERSAMPLE = 2` when `rotation % 90 !== 0`. The canvas's CSS size is
its backing store divided by that, so an upright box is one texture pixel per
device pixel.

**Why turned boxes are painted at twice the scale.** The turn is CSS's, so the
compositor resamples the picture. Measured on 22px type turned 7 degrees, as
the share of inked pixels that are neither paper nor ink (fewer is sharper):

| | DOM text | export | canvas at 1x scale | canvas at 2x scale |
|---|---|---|---|---|
| 100%, 1x display | 49.4% | 49.7% | 67.3% | 43.3% |
| 100%, 2x display | 28.5% | 28.7% | 42.0% | 23.7% |
| 300%, 1x display | 20.4% | - | 31.9% | 16.9% |

The cost is four times the pixels for turned boxes only, inside the same
budget, and one repaint when a box first leaves or returns to an axis
(section 4). Quarter turns are not oversampled.

**Upright boxes are as sharp as the DOM.** Same measure, plain box: 100% 1x
canvas 52.9% against DOM 47.0% (two different rasterisers; the export is
52.9% too); 100% 2x 28.3% against 27.2%; 300% 21.6% against 22.2%.

**Corner snapping.** A one-to-one picture is only shown one to one if it
starts on a device pixel. `pictureCss` moves the corner of an upright,
unmirrored box to the nearest device pixel (at most half of one). The snap
is to the screen, not the page: `pageCorner(frameEl)` reads the page frame's
position when a picture is painted, once per flush for all boxes. Measured:
at zoom 137% on a 2x display the page starts on a half pixel; before this
every canvas there was half a device pixel off, after it 25 of 25 are exact.

**Budget.** `PICTURE_MAX_PX = 8 * 1024 * 1024` pixels per box, 32 MB of RGBA.
Reason: it is about one 4K screen (3840 x 2160 = 8.3 MP), so no single box
can hold more than a screenful, and it is well above anything measured: the
largest box of the real page at 300% on a 2x display was 2.47 MP (9.9 MB),
the largest synthetic one 5.8 MB. A box over the budget is painted at a lower
scale for that box only (`textureScale`), same footprint, stretched by CSS.
There is no tiling: such a box is softer than its neighbours. A 400 x 300
box stays at full scale up to 800% on a 2x display.

**Every effect follows the scale.** `exporter-scale.engine.test.js` paints
each kind at 1 and at 3, averages the 3 down and compares (mean alpha
difference over inked pixels, of 255): plain 8.00, bands 1.59, gradient 8.06,
pattern 7.90, shadow 10.97, blurred shadow 3.89, blur 2.66, smear 2.30,
roughen 26.80, mask include 8.03, exclude 7.97, arc 7.88, circle 8.34. Each
scale factor was removed in turn to see the test fail (blur 27.40, smear
13.39, roughen 38.97, shadow offset 78.64, shadow blur 20.26), then restored.
Roughen differs most because its displacement is rounded to whole device
pixels.

## 4. What repaints when

The key is `pictureKey`: the style less what CSS applies to the finished
picture (rotation, opacity, both flips), the ink key, the text, `w`, `h`, the
shaped lines and their indents, the scale, `app.fontsVersion`. Position is
not in it. Each row below is a test in `TextBox-engine-picture.dom.test.js`.

| change | repaint |
|---|---|
| move | no (CSS position; the corner snap is recomputed, style only) |
| turn, from one non-axis angle to another | no |
| turn, first degree off an axis, or back onto one | once (scale changes by 2) |
| opacity, flip, select, select another box | no |
| resize, text, colour, size, stroke, shadow, blur, mask, curve, path, mesh, ink | yes |
| fonts arriving (`app.fontsVersion`) | yes |
| zoom that is not a gesture | yes |
| zoom gesture (`app.zoomLive`) | no; the browser stretches the bitmap; once on settle |
| box mounted mid-gesture | paints its first frame |
| display density changes | yes |
| box leaves the near-viewport area, or its page is hidden | pixels released |
| edit starts | pixels released, DOM shown |
| edit ends | painted again |
| roughen noise phase arriving | one extra paint for a roughened box |

A paint that finishes late is dropped by the sequence counter (tested: late
noise after an unmount, after an edit start, after a newer key).

## 5. Memory

Rules of map C section 5.3 as applied:

- Canvas pixels are released with `width = height = 0` on unmount, edit
  start, switch off, hidden page, leaving the near area. Tested in jsdom.
- Intermediates are released: the texture after the copy, the shadow
  silhouette and the mask canvas inside the exporter. Tested with the real
  engine: after painting seven kinds, at most one canvas made on the way
  still holds pixels, and it is the painter's bounded scratch. This test was
  not mutation-checked.
- No data URLs on this path. The mask image and the SVG filter definitions
  are not built at all while the picture is shown.
- Nothing heavy in the reactive key: the ink block goes in by its existing
  key, the texture never.
- Hidden pages hold no pixels (`shown`). Measured: 0.0 MB on hidden pages in
  every reading.
- Boxes far from the viewport hold no pixels (`watchNear`, 50% margin). In a
  longstrip a box waits for the observer before its first paint (`lazy`); in
  paged mode it paints at once and is released if the observer says far.

**Page budget.** There is no hard cap for a page. The bound is geometric: the
near area is the viewport plus half a viewport on each side, four viewport
areas. For a 1600 x 1000 window on a 2x display that is 4 x 3200 x 2000 x 4
bytes = 102 MB if every pixel of it were covered once. Boxes that straddle
the edge count whole, footprints can overlap, and turned boxes hold four
times their area, so this is an estimate and not a guarantee; each box is
capped at 32 MB regardless.

**Measured** (sum of `width * height * 4` over every canvas in the document,
1600 x 1000 window):

| page | display | switch | 60% | 100% | 300% | elements in boxes |
|---|---|---|---|---|---|---|
| synthetic, 30 boxes | 2x | off | 0.1 MB | 0.2 MB | 2.0 MB | 326 |
| synthetic, 30 boxes | 2x | on | 6.1 MB (30 of 30) | 12.7 MB (20 of 30) | 10.3 MB (2 of 30) | 96 |
| synthetic, 30 boxes | 1x | on | 1.5 MB | 3.2 MB | 2.6 MB | 96 |
| real page, 23 boxes (54 mounted) | 2x | off | 0 | 0 | 0 | 706 |
| real page, 23 boxes (54 mounted) | 2x | on | 4.7 MB (23 of 54) | 11.3 MB (19 of 54) | 28.4 MB (6 of 54) | 162 |
| real page, 23 boxes (54 mounted) | 1x | on | 1.2 MB | 2.8 MB | 7.1 MB | 162 |

"n of m" is canvases holding pixels of canvases mounted. The DOM path's own
memory (glyph layers, compositor tiles) is not visible to a page and was not
measured; the element count is the only figure I have for it.

Not released: the Rust painter keeps a scratch canvas and a tile cache.
(Corrected in P6b. This said "of at most 2048 x 2048", which was false: the
bound was on each raster and the canvas was raised to the widest and the
tallest seen, so one wide line and one tall column left 8739 x 6306, 210 MB,
measured. Since P6b the kept canvas holds at most 2048 x 2048 pixels in
area, whatever its shape; see `P6B-REPORT.md`, item 1.) Releasing them needs
an edit to `rust-painter.js`, which I did not make. A new painter is created each time the switch goes on and the
reference is dropped when it goes off, so they are collectable; when they are
collected was not observed.

## 6. Editor equals export

**Same bytes as `renderBoxTexture`.** For each box the check page reads the
editor canvas and calls `renderBoxTexture` + `warpTexture` at the same scale
and budget. Measured, all identical:

- synthetic, 1x display: zoom 100%, 137%, 300% - 30 of 30 each
- synthetic, 2x display: zoom 50%, 100%, 137%, 150% - 30 of 30 each
- real chapter page, both displays: zoom 60%, 100%, 200% - 23 of 23 each

**Same pixels on the screen.** The canvas's bytes laid over white, against a
screenshot at the position layout reports: 25 of 25 upright boxes exact
(mean difference 0) at every zoom above on both displays. The five others
are turned, mirrored or translucent and are resampled or blended by design.

**Against the export route** (`renderPageCanvas` at 2x; editor screenshot at
100%). On the 2x display the two are the same resolution and compared
directly; on the 1x display the export is averaged down 2:1, so it is a
comparison of two resolutions and not expected to be zero. Mean / worst
channel difference of 255 over inked pixels:

| kind | 2x display | 1x display |
|---|---|---|
| plain, gradient (both), blur, arc, circle, path, rot90, faux italic, real italic, missing font, missing letter, left-top, right-bottom | 0 / 0 | 0.17-0.74 / 2 |
| stroked, flipped, pattern, bands, shadows, faux bold | 0 / 0 | 0.17-0.58 / 26-61 |
| smear | 0 / 0 | 1.8 / 14 |
| clip include, clip exclude | 0 / 0 | 1.04, 0.7 / 78, 79 |
| ink | 0 / 0 | 3.07 / 86 |
| roughen | 0 / 0 | 20.5 / 190 |
| warped | 0 / 0 | 19.29 / 145 |
| opacity | 0.21 / 1 | 0.34 / 23 |
| rot7 | 6.01 / 58 | 9.59 / 81 |
| rot7-shadow | 5.45 / 95 | 4.8 / 77 |
| fractional | 84.64 / 255 | 0.24 / 2 |

Ink boxes agree to the pixel everywhere except `fractional` on 2x (1 device
pixel) and one edge of `opacity` and `rot7-shadow` (1 device pixel).

The four that differ on 2x, and why:

- **fractional** (box at x .37, y .61 page px). The export rounds an upright
  box's origin to a whole page pixel (`paintBoxOnPage`); the editor snaps to
  a device pixel, half a page pixel on 2x. Same picture, one device pixel
  apart. The editor is nearer the box's true position.
- **rot7**. The export paints a plain turned box directly at the angle; the
  editor turns a picture with CSS. With oversampling the difference is 6.01,
  without it was 14.89.
- **rot7-shadow**. The export turns a 2x bitmap for a composited box. Without
  oversampling the editor did the same and the difference was 0.07; with it
  the editor is finer than the export and the difference is 5.45. This is
  the price of the sharpness in section 3.
- **opacity**. CSS opacity against canvas alpha, one level of rounding.

On the 1x display the large figures are roughen (displacement rounded to
device pixels, so the grain differs between scale 1 and scale 2) and warped
(the mesh resampled at two resolutions).

## 7. Position: DOM text against the canvas

Ink box of the switch-on screenshot minus the switch-off one, device pixels,
left top right bottom. The page frame did not move between the two (0, 0).

| kind | 100% 1x | 300% 1x | 100% 2x | 150% 2x |
|---|---|---|---|---|
| plain | 0 0 1 -1 | 0 1 0 1 | 0 0 0 0 | 0 1 0 1 |
| gradients, pattern, shadows, blur, smear, roughen, clips, ink, arc, circle, path, faux bold, both italics, left-top, fractional | within 1 | within 1, pattern right -2 | within 1 | within 1, pattern right -2 |
| right-bottom | 0 1 0 -1 | 0 1 0 0 | 0 2 0 1 | 0 1 0 0 |
| rot7, rot90, rot7-shadow | within 1 | within 1 | within 1 | within 1 |
| warped | 0 0 1 0 | 1 2 -1 0 | 1 2 -1 0 | 2 3 -1 -1 |
| stroked, flipped, opacity | 0 3 1 -2 | 1 11 0 -5 | 0 7 0 -4 | 1 11 0 -5 |
| bands | 0 17 1 -12 | 0 54 0 -33 | 0 36 0 -22 | 0 54 0 -33 |
| missing font | 6 1 -10 -2 | 18 6 -29 -6 | 12 4 -19 -3 | 18 5 -29 -7 |
| missing letter | -1 1 0 0 | -4 1 3 0 | -3 0 2 0 | -4 1 3 0 |

Everything over one pixel has a cause I looked at in the pictures:

- **stroked, flipped, opacity, bands**: the browser's text stroke has mitre
  spikes above and below the letters; the engine's stroke has round joins.
  The letters do not move; the spikes are gone. Known from P5A.
- **missing font**: the DOM falls back to the browser's default face, the
  engine to the last-resort family. Different letters, different widths.
- **missing letter**: the DOM borrows the glyph from a system font; the
  engine draws the missing-glyph box.
- **warped**: the old path stretches a 2x texture; the new one paints at the
  display's scale. At 300% the old one is visibly soft and the new one is not.
- **right-bottom top 2 on 2x at 100%**: not explained beyond the two
  rasterisers' antialiasing at the ink box threshold; it is 1 at every other
  setting.

## 8. Edit start and edit end

Switch on, zoom 100%, twelve boxes (plain, left-top, right-bottom,
fractional, stroked, shadows, faux bold, faux italic, real italic, missing
font, arc, path). While editing: no engine canvas, the editable present, in
all twelve. Box of the black ink while being typed into minus at rest:

- 1x display: every edge within 1 device pixel.
- 2x display: within 1 device pixel except left-top (top -2) and
  right-bottom (top -2, bottom -2), which is one CSS pixel.

After the edit ends the screenshot is identical, byte for byte, to the one
before it began, for all twelve on both displays.

What does change at edit start is the look, because the editing element is
today's and is simpler than the finished box: on the `shadows` box the
stroke bands disappear and the shadow thins while typing, and a stroked box
shows the browser's mitred stroke. The first is the same with the switch
off; the second is new only in that the box at rest now has round joins.

## 9. Cost

1600 x 1000 window, milliseconds, median (min-max) of the two quiet runs,
then the range seen across all runs including loaded ones. This machine had
other agents building on it; the same measurement varied by a factor of two
to three between runs. The DOM path's figures are script and layout only:
the browser rasters its text afterwards off the main thread, where a page
cannot time it. The canvas path's figures are the whole of it. They are not
like for like.

Real chapter page (23 boxes, the user's fonts, 28-page chapter):

| | switch off | switch on, 1x | switch on, 2x | on, range over all runs |
|---|---|---|---|---|
| page mounted | 5.5-13.3 | 19.4 (18.6-43.1) | 25.7 (25.3-61.0) | medians 19-76, maxima 149 and 187 |
| every box repainted (a font arrives) | 31-98 | 29.0 (28.6-37.8) | 36.7 (35.7-43.0) | 29-118 |
| resize, per frame, largest box, 100% | 0.4-1.2 | 4.2 (3.5-6.3), 0.04 MP | 5.2 (4.5-9.8), 0.17 MP | 3.5-11.2 |
| resize, per frame, largest box, 300% | 0.7 | 6.7 (6.3-12.2), 0.39 MP | 11.7 (11.4-25.3), 1.56 MP | 6.3-31.1 |
| zoom gesture, per tick | 5.0-16.5 | 1.6 | 1.6 | 1.0-4.1 |
| zoom settle, 80 to 160% | 0.0-0.1 | 23.1 | 41.2 | 23-86 |
| zoom settle, 200 to 300% | 0.1 | 15.3 | 35.3 | 15-48 |
| page turn (14 or 23 boxes) | 1.7-3.7 | 21.6 (13.5-24.7) | 34.5 (20.8-36.6) | 14-107 |

Synthetic page (30 boxes, every effect), switch on: mounted 20.8-29.5,
every box repainted 18.4-24.7, resize per frame 2.8-4.0 at 100% and 7.9-9.4
at 300%, zoom settle 10.8-39.7, zoom tick 0.7-1.9.

Where the time goes: a CPU profile of 60 resize frames put 228 of 257 ms
(89%) inside the Rust painter's `paint`, in WebAssembly. A profile of page
turns showed the same functions on top. The editor's own additions were
small: `pageCorner` 5.5 ms and `pictureKey` 3.9 ms over the 60 frames.

Readings:

- **Zoom gestures are cheaper with the switch on** (no layout per tick), and
  the settle costs one repaint of the visible boxes, 15-86 ms.
- **Resize** fits a 60 Hz frame at 100%. At 300% on a 2x display the largest
  balloon of this page took 11.7 ms in a quiet run and 26-31 ms in a loaded
  one. I did not build a lower scale while dragging: the quiet figure does
  not ask for it and the loaded one does. If it is wanted, the place is
  `pictureRes`; it needs a "resizing" flag the store does not have today.
- **A page turn costs a repaint of the page** because hidden pages hold no
  pixels: 14-35 ms quiet, up to 107 ms loaded, against under 4 ms of script
  with the switch off. Keeping the two neighbours painted would make the
  turn free and roughly triple the pixels held. I chose memory; this is the
  decision in this report I am least sure of and it is one line to reverse
  (`shown` in `Canvas.svelte`).

## 10. Every visible difference between switch off and on, in the editor

1. Stroke joins: round, not mitred. No spikes on stroked and banded text.
2. A box in a font that is not loaded is drawn in the last-resort family,
   not the browser's default face.
3. A letter the font lacks is drawn as the missing-glyph box, not borrowed
   from a system font.
4. Antialiasing is the engine's: at 100% on a 1x display slightly greyer
   edges than the browser's text (52.9% against 47.0% mid-tones); no
   measurable difference at 300% or on 2x.
5. Position: within 1 device pixel of the DOM text for ordinary boxes
   (section 7).
6. Warped boxes are sharp above 200%, where they were soft.
7. Turned text is slightly crisper than the DOM's (section 3).
8. A box at rest now looks like the export. A box being typed into looks as
   it always has. So for a stroked box the joins change at edit start and
   change back at edit end. Everything else about the editing look is as
   today.
9. A box whose mask is on: when an edit starts, the mask image has to be
   built before the DOM text can be masked, which is asynchronous. A frame
   of unmasked text is possible. Inferred; I did not capture it.
10. Hit area: the frame is the same target (measured: centre and corner hit,
    6 px outside does not, both ways). Glyphs that hang outside the frame
    are no longer targets: on the arc box four letters outside the frame hit
    the box with the switch off and none with it on. The canvas is
    `pointer-events: none`.
11. Text of a box at rest cannot be found by the browser's find or selected,
    since it is pixels. Inferred from there being no text node.
12. Turning a box from exactly upright, the first degree repaints once.
13. After the window is resized or a panel opens, the page can shift by a
    fraction of a pixel and pictures sit up to half a device pixel off until
    their next repaint. Inferred from `pageCorner` being read at paint time.

## 11. What the browser showed that the tests did not

- **No box was painted at all.** The display density was state written on
  first read, inside a `$derived`; Svelte threw `state_unsafe_mutation` and
  every canvas stayed 300 x 150. All 61 jsdom tests passed because they set
  the density by hand, around the lazy path. Fixed with `createSubscriber`;
  four tests now go through the listening path.
- **Pictures half a pixel off at non-integer zooms.** The snap was to the
  page's grid, and the page is centred on a half pixel at 137%. Fixed with
  `pageCorner`.
- **Turned text was soft.** Fixed by oversampling.
- **The DevTools density emulation is not a display.** With
  `Emulation.setDeviceMetricsOverride` at 2x, 1 of 25 pictures was pixel
  exact at 137%; with the browser started at 2x, 25 of 25. The emulation
  snaps in CSS pixels. All figures here are from real densities. The
  emulation is used once, to see the pictures follow a density change (228
  to 456 to 228 pixels wide, bytes identical at each). A change of density
  alone, with the window size unchanged, fired no media query event in
  headless Chrome; with a size change it did.

## 12. Not done, and not verified

- **Not run in the Tauri app or in WebKit.** Unverified there: device-pixel
  snapping, `IntersectionObserver` behaviour, the `resolution` media query
  firing when the window moves between displays, all timings.
- **Longstrip not exercised in the browser.** The `lazy` path is tested in
  jsdom with a fake observer only.
- **Lower scale while resizing**: not built (section 9).
- **Tiling for a box over the budget**: not built; such a box is softer.
- **`rust-painter.js` scratch and tile cache**: not released explicitly
  (section 5).
- **Neighbour pages** are repainted on a turn rather than kept (section 9).
- **A real-browser pixel comparison of switch-off against the base commit**
  was not made. The evidence for "nothing changes" is the suite, the two
  capture runs and the DOM snapshot.
- Mutation checks were made for the scale tests only.

## 13. The seam for the typing task

One line in `TextBox.svelte`:

```js
const engineShown = $derived(enginePaints && !editing);
```

Everything that decides between the picture and the DOM reads `engineShown`.
Removing `&& !editing` shows the picture while typing; what is then missing
is the caret, the selection and input, which is the typing task. `text` is
already in the repaint key, so a keystroke repaints.

## 14. Hunks

`src/lib/exporter.js` (4 git hunks, 5 changes):

1. `paintShadows`: silhouette canvas sized with `Math.ceil(L.cw * SS)` /
   `Math.ceil(L.ch * SS)` instead of the bare product.
2. `paintShadows`: `sil.width = 0; sil.height = 0;` after the loop.
3. New `export function textureScale(cw, ch, scale, maxPx = Infinity)`.
4. `renderBoxTexture(box, p, tips, scale = 2, maxPx = Infinity)`:
   `SS = textureScale(...)`, canvas `Math.ceil`ed to `pw` x `ph`.
5. `renderBoxTexture`: mask canvas released after use; returns
   `cw: pw / SS, ch: ph / SS`.

At the default scale 2 every one of these is the old arithmetic (the
footprint is whole page pixels, so `ceil` is the identity). Proof: the test
"default equals explicit 2" and the two capture runs.

`src/lib/engine-switch.svelte.js` (7 git hunks):

1. Header comment: the engine that measures also draws.
2. Two comments: step 6 of the startup order, and the session with no
   last-resort face (no engine, so no painter).
3. Imports `glyphPainter`, `setGlyphPainter`, `createRustGlyphPainter`.
4. `REAL.createPainter: (engine) => createRustGlyphPainter(engine)`.
5. State field `engineSwitch.painting: false`, with its comment.
6. `painter`, `painterBefore`, `paintWith(engine)`; `apply()` ends with
   `paintWith(want)`.
7. `leave()` calls `paintWith(null)`.

`paintWith` removes only its own painter: one installed by someone else
since is left alone (tested).

## 15. Tests and checks

Suite on the final commit: **103 files passed, 1 skipped; 3,052 tests
passed, 7 skipped.** Baseline was 96 + 1 and 2,862 + 7. No existing test
file was edited.

Capture runs on the final commit, both deleted afterwards:

- `capture-node.mjs --run p6-check` against `runs/ref-sk/base`:
  `metrics.jsonl` (64,718 lines), `layout.jsonl` (17,538), `pixels.jsonl`
  (3,732) identical; all 3,401 PNGs identical; only `manifest.json` differs.
- `--engine new --rules boldAdvance=webkit --run p6-new` against
  `runs/new/r2w`: the same three files identical; all 3,732 PNGs identical;
  only `manifest.json` differs.

Switch off, DOM: `TextBox-switch-off.dom.test.js` snapshots straight,
finished, pattern, masked, arc, circle, path, warped and inked boxes, a box
at 250%, selected, typed into, and an arc typed into. The snapshot was
committed (`84451f4`) before `TextBox.svelte` was modified and has not been
regenerated since.

To re-run the browser check:

```
npm run build:engine
npm run dev -- --port 5201 --strictPort
node scripts/editor-check.mjs --data <tp-data> --dsf 1
node scripts/editor-check.mjs --data <tp-data> --dsf 2
```

It writes `report-1x.json`, `report-2x.json` and the pictures to
`<tp-data>/reports/p6/`. `--only bytes,export,look,edit,cost,real` picks
steps. It needs Chrome at the default macOS path (`--chrome` to change) and
adds no dependency. The dev server and the browser I used are stopped.

Pictures, in `tp-data/reports/p6/` (44 files, 19 MB, includes the user's
text in `real-page-*`; nothing was copied into the repository):

- `look-<zoom>-<density>-NN.png`: switch off left, on right, six boxes a sheet
- `page-<zoom>-<density>-off.png` / `-on.png`: the whole synthetic page
- `export-<density>-NN.png`: the boxes that differ from the export, side by side
- `editor-on-100-<density>.png`, `export-for-<density>.png`: the two wholes
- `edit-100-<density>.png`: at rest left, being typed into right
- `real-page-<density>-off.png` / `-on.png`

I looked at the 100% and 300% look sheets, the export sheets, the edit
sheets and the real page pair. The selection frame is magenta in them
because the check page recolours it to tell it from black type.

## 16. A manual check in the desktop app

1. Load two or three of your own fonts. Open a chapter. In Settings set the
   text engine to Rust. Boxes should not jump by more than a pixel.
2. Zoom to 300%. Straight text, a turned box and a warped box should all be
   as sharp as with the switch off. Zoom with the trackpad: text may look
   stretched during the gesture and must sharpen when it stops.
3. Double-click a box. The text should stay where it is, to within a pixel.
   Type. Click away. The box should look as it did before.
4. Drag a box: it must follow without lag. Resize a large balloon at 300%:
   note whether it stutters.
5. Turn a page forward and back. Note whether the pause is noticeable.
6. Drag the window to a display of another density, if there is one. Text
   should be sharp there within a moment.
7. Click a letter of curved text that hangs outside its frame: it will not
   select the box. Click inside the frame: it will.
8. Export a page and compare it with the editor at 100%.
9. Set the engine back to Browser. Everything should be as it was before
   step 1.
10. With Activity Monitor open, zoom to 300% and turn through ten pages with
    the engine on. Memory of the web content process should not climb page
    after page.
