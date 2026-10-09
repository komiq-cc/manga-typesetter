# P6b: what the outside review found in the editor picture, fixed

Branch `tp/editor`, on top of `5d73134`. Seventeen commits, listed in section
14. The brief is `tp-data/briefs/p6b-editor-fixes.md`; items below carry its
numbers and the review's finding numbers.

Every figure is marked **measured** or **inferred**. Measured in Chromium
means headless Chrome 155 driven by `scripts/editor-check.mjs`. Measured in
WKWebView means this Mac's system WebKit (macOS 27.0, build 26A428, WebKit
bundle 22625.1.29.11.27) in a real `WKWebView`, by
`scripts/editor-check-webkit.swift`. The machine was loaded while these ran:
two other workers and the coordinator's captures.

## 0. Result

| proof | result |
|---|---|
| `./node_modules/.bin/vitest run` | 112 files passed, 1 skipped; 3,219 tests passed, 7 skipped (measured, at `3d6580b`; baseline 107 files, 3,117 passed, 7 skipped). `cli.test.js` did not time out in this run |
| `npm run build` | exit 0 (measured). TextBox has the two warnings it had ("captures the initial value of `box`", lines 191 and 192) and no new one |
| capture, default mode, against `runs/ref-sk/base` | only `manifest.json` differs (measured, at `3d6580b`, the last commit that touches `src`). 64,718 metrics, 17,538 layouts, 3,732 pictures, 0 errors. `p6b-sk` deleted |
| capture, `--engine new`, against `runs/new/r3` (at `3d6580b`) | `layout.jsonl` and `metrics.jsonl` byte-identical. `manifest.json`, `pixels.jsonl` and 15 PNGs differ. All 15: the old picture is the new one cropped, 0 pixels unlike inside the old canvas (measured). `p6b-new` left in place |
| editor check, Chromium, 1x and 2x | 0 page errors both. Sections below |
| editor check, WKWebView, 2x | the questions that need no screenshot: same answers as Chromium. Section 11 |

## 1. Finding 2: the painter's scratch canvas only grew

**Wrong.** `rust-painter.js` kept one scratch canvas and raised it to the
widest and the tallest raster seen. The bound was on each raster, not on the
canvas. One wide line and one tall column, each under the bound, left a
canvas of their product.

**Measured before:** after the review's two jobs (140 W on a line, then 80
lines of WWW, size 12, 6 device px to the page px) the painter held
54,280,456 px, 217 MB of RGBA. Through the box-picture path: 8739 x 6306,
210 MB.

**Changed.** `src/lib/text-engine/rust-painter.js:83`. The scratch is judged
by what it would be after this raster. It grows while the grown canvas is
within `SCRATCH_KEEP_PX` (2048 x 2048 px of area, line 23). Past that it is
cut to this raster. A raster over the bound by itself still goes through a
canvas that is given back at once.

**Chosen differently from the brief.** The brief says: over the bound, use a
one-off canvas. Measured with that policy: after one wide raster, 20 ordinary
paints made 20 one-off canvases (21 canvases made). The wide scratch stayed,
and every ordinary raster taller than it could grow to was "over". With the
kept scratch re-cut to the raster instead: at most 2 canvases made for the
same 21 paints (measured). Held pixels are within the bound either way.

**Tests.** `src/lib/text-engine/rust-painter-scratch.engine.test.js`, 7
tests, with a canvas double that records every size it is given. Watched
fail before the fix: "a very wide raster and then a very tall one", "in the
other order too", "stays useful after one very wide raster" (the last against
the brief's literal policy). `box-picture.engine.test.js` "what it holds":
the bound test now paints a wide and a tall box; watched fail on the old
painter (55,108,134 px held).

**Corrected.** `text-engine/P6-REPORT.md` section 5 said "at most 2048 x
2048". It now says what was true and what is.

## 2. Findings 5 and 3: the near-viewport margin did nothing

**Wrong (5).** `near-view.js` made an `IntersectionObserver` with
`rootMargin: '50%'` and no `root`. With no root the margin grows the window.
But the editor's canvas is inside `.editor-scroll` (`overflow: auto`), and a
scroll container between the target and the root clips first, with no
margin. So a box was "near" only when it was in view.

**Measured before, in WKWebView** (a page shaped like the editor's, 1600 x
1000): targets 2%, 25%, 45% and 60% of the area below the fold. No root, 50%
margin: `false false false false`. Root at the scroll container, 50% margin:
`true true true false`. `scrollMargin: '50%'`, no root: `true true true
false`.

**Which form.** `root` with `rootMargin`: Chrome 51, Safari 12.1 (MDN's
table). `scrollMargin`: Chrome 120, Firefox 141, Safari 26 (same table). The
Tauri config sets no minimum macOS, and the window is the system's WebKit.
So `root` with `rootMargin`. That `scrollMargin` works on this Mac's WebKit
is measured; that it fails on an older one is inferred from the table.

**Changed.** `src/lib/editor/near-view.js:40` finds the nearest ancestor
that scrolls (computed `overflow`, cached per parent). Line 62 keeps one
observer per root, made with `{ root, rootMargin }` (line 71). The header
comment says what the margin is measured from and what it bounds.

**Wrong (3).** A box was judged by its rectangle. Ink goes past the
rectangle: an overflowing line, a curve, a shadow. A box whose rectangle was
far let go of ink that was still in view.

**Changed.** `src/lib/TextBox.svelte:147`. The observer watches an empty
element (`.reach`, markup at line 2031) laid over the footprint the picture
was last painted to, and over the box until there is one. The footprint is
kept when the pixels are let go, so a box comes back by the measure it left
by. The predecessor's judge inferred 1 of 2,482 real boxes at 300 to 400%
needs this once the margin is real; I did not re-measure that figure.

**Tests.** `src/lib/editor/near-view.test.js`, 10 tests; three watched fail
(the root, one observer per root, the window fallback).
`TextBox-engine-picture.dom.test.js`, "a box nobody can see": three tests
on the watched element. These three were written with the change and were
not watched failing.

**Measured in Chromium, 1x and 2x, and in WKWebView 2x** (`near` step; a
column of 40 balloons down a 6,000 px page, 1600 x 1000 window; the same in
a longstrip of three pages):

| | paged | longstrip |
|---|---|---|
| at the top: boxes in view that hold a picture | 7 of 7 | 7 of 7 |
| within the margin, not in view | 3 of 3 | 3 of 3 |
| beyond the margin | 0 of 30 | 0 of 29 |
| scrolled on by 45% of the area: boxes newly in view | 3 | 3 |
| of them, painted before the scroll | 3 | 3 |
| a box 60 px high with lines 1,400 px below it, its rectangle 0.58 of the area above the top edge: holds its picture | yes | yes |
| the same box scrolled three areas further | let go | let go |

All three browsers gave these numbers. Before the fix the second row would
be 0 of 3 (inferred from the WKWebView measurement above and from the test;
I did not run the old code in the check).

**The memory bound, corrected.** `P6-REPORT.md` said the near area bounds a
page to four viewport areas, 102 MB. It did not, and does not. What is
bounded is which boxes hold pixels: those whose footprint touches the
scrolling area grown by half its size each way. Each holds its whole picture,
up to 32 MB. Measured held, sum of `width * height * 4` over every canvas,
1600 x 1000 window, Chromium:

| page | display | 60% | 100% | 300% |
|---|---|---|---|---|
| synthetic, 30 boxes | 2x | 6.1 MB (30 of 30) | 16.9 MB (30 of 30) | 37.0 MB (9 of 30) |
| synthetic, 30 boxes | 1x | 1.5 MB (30 of 30) | 4.2 MB (30 of 30) | 9.3 MB (9 of 30) |
| real page, 23 boxes (54 mounted) | 2x | 4.7 MB (23 of 54) | 13.0 MB (23 of 54) | 76.0 MB (15 of 54) |
| real page, 23 boxes (54 mounted) | 1x | 1.2 MB (23 of 54) | 3.2 MB (23 of 54) | 19.0 MB (15 of 54) |

P6 measured 10.3 MB and 28.4 MB in the 300% 2x cells. The difference is the
margin being real: 9 and 15 boxes hold pixels where 2 and 6 did. Largest
single canvas in these readings: 9.9 MB.

## 3. Finding 1: a long box threw; and any paint that throws

**Wrong.** `textureScale` kept a texture inside a pixel budget and said
nothing about a side. The engine paints no raster with a side over 16,384 px
(`MAX_SIDE`, `text-engine/src/paint/mod.rs:62`) and throws.

**Measured before:** the review's 7000 x 100 box at scale 3 throws `mt-text:
paintJob: malformed paint job, or a surface larger than the engine allows`.
At scale 2 it paints.

**Changed.**
- `src/lib/exporter.js:533`: `textureScale(cw, ch, scale, maxPx = Infinity,
  maxSide = Infinity)`. The side limit allows for the round-up of a canvas.
  `renderBoxTexture` (line 587) takes and passes it. Both default to no
  limit, so the export is as it was.
- `src/lib/text-engine/rust-painter.js:32`: `MAX_RASTER_SIDE = 16384`, the
  one place the page states the engine's limit. The painter carries it as
  `maxSide` (line 121). `rust-painter-limit.test.js` reads the Rust source
  and holds the two together.
- `src/lib/editor/box-picture.js:45`: `pictureTexture` asks the installed
  painter for `maxSide`. Every picture the editor shows is made there.

**Any throw.** A paint that threw inside the effect left the box with its
last picture or none, and stopped the other effects of the same flush.
Measured before, in jsdom: of three boxes repainted in one flush, one
`paintBoxPicture` call was reached; and an unhandled rejection from the late
repaint.

`src/lib/TextBox.svelte:575` (`tryPaint`): the throw is caught where the
paint is called. The canvas is released. The box is shown as its DOM text
(`engineShown`, line 122, is false while the key that failed is the key)
until what it is painted from changes, and then it is tried again. It is
logged once per box, not once a frame.

**Tests.** For the side: `exporter-scale.engine.test.js`, "the longest side
of one texture", and `box-picture.engine.test.js`, the long box; six watched
fail. For the throw: `TextBox-engine-picture.dom.test.js`, "a paint that
throws"; seven watched fail.

**Measured in Chromium 1x and 2x, and WKWebView** (`limits` step): the 7000
x 100 box at scale 3 would be 21,000 px wide. It is painted 16,384 x 253, by
the engine, with 0 page errors, and its bytes are `renderBoxTexture`'s at the
same limits (0 bytes differ of 16,580,608). A painter made to refuse one box
of three: that box is its DOM text, the two beside it are engine pictures,
one message is logged; repainted again while still refused, no second
message; allowed again, it is the picture again.

**Not done.** The mesh gizmo's drag (`warpPainter.begin` and `frame`) is not
wrapped. A warped box painted the old way has no DOM text to fall back to
and is left empty on a throw until its key changes.

## 4. Finding 7: letters outside the frame could not be clicked

**Wrong.** The canvas is `pointer-events: none`, and the box's own rectangle
was the only target. Curved text and overflowing lines are drawn outside it.

**Changed.** `src/lib/TextBox.svelte:1009`. While the picture is shown and
the box is not warped, transparent targets stand where the letters are: one
per glyph of a curve, at the glyph's own place and turn (line 2073), or one
rectangle for straight text that runs past its box (line 2076; the block's
advances by its line boxes, `blockRect` in `contain.js:247`). Straight text
that fits has none. They state no `pointer-events` of their own, so the hand
tool still deafens them with the rest of the box. The canvas and `.warpl`
are untouched.

**Tests.** `TextBox-engine-picture.dom.test.js`, "what takes the pointer
while the box is a picture", 9 tests; four watched fail.

**Measured in Chromium 1x and 2x** (`hits` step, the browser's own
`elementFromPoint`, and a real click through the DevTools protocol):

| box | letters outside the frame, where the DOM has them | hit, switch off | hit, switch on | ink outside the frame on screen, sampled | of it hit | corners of the picture's padding that hit | a real click on an outside letter selects |
|---|---|---|---|---|---|---|---|
| arc | 4 of 14 | 4 | 4 | 530 px (2x), 382 (1x) | all | 0 of 4 | the box |
| circle | 0 of 19 | - | - | 0 | - | 0 of 4 | - |
| path | 0 of 15 | - | - | 90 (2x), 22 (1x) | all | 0 of 4 | - |
| overflowing straight text | 40 of 45 | 40 | 39 | 405 (2x), 462 (1x) | all | 0 of 4 | the box |
| plain | 0 of 10 | - | - | 0 | - | 0 of 4 | - |

**Measured in WKWebView:** the same counts for the letter points and the
padding corners (4 and 4; 40 and 39; 0 of 4 everywhere). The ink sample and
the real click need a screenshot and an outside pointer and were not run
there.

**The one miss (39 of 40).** It is not a hole in the target. With the switch
off, CSS starts a centred line that is wider than its box at the box's left
edge: the widest line was at x 402, 86.6 wide, in a frame at 400, 80 wide
(measured). The engine centres it, as the export does: the target is at
396.7, 86.6 wide (measured). The missed point is where the DOM had the last
4% of that line, 5.3 px right of where the picture has it. Every sampled
pixel of the picture's own ink hit. That 5.3 px is a difference between the
DOM text and the export that was there before this task; I did not change it.

## 5. Findings 8 and 10: the mask at rest, and a test double that could not show it

**Wrong.** With the picture shown, the mask image was dropped. An edit begun
on a masked box showed the editable unmasked until the image was built
again, which `toBlob` does a task later. The jsdom double had no `toBlob`,
took the synchronous branch, and could not show the gap.

**Changed.**
- `src/lib/TextBox.svelte:266`: the mask is dropped only when the box has no
  mask, not while the picture is shown.
- `src/test/fake-canvas.js:37`: `installFakeCanvas({ asyncBlob })`. With it
  the canvas has a `toBlob` that answers a task later, and
  `URL.createObjectURL` is stood in for; both put back on uninstall.

**What it holds, measured** (`mask` step): one PNG blob per masked box.

| box | mask image | Chromium | WKWebView |
|---|---|---|---|
| 220 x 110, include | 832 x 736 | 16,308 bytes | 12,855 bytes |
| 220 x 110, exclude | 832 x 736 | 15,827 bytes | 13,548 bytes |
| 1000 x 600, include | 1600 x 1216 | 51,087 bytes | 46,794 bytes |

At rest the wrapper's computed `mask-image` is `none` (measured, both
browsers): the picture has the mask in its pixels, and no style refers to
the blob. That it is therefore not decoded at rest is inferred. With the
switch off the same three blobs exist and are in use, so nothing is held
with the switch on that was not held with it off.

**Tests.** `src/lib/TextBox-engine-mask.dom.test.js`, 6 tests, with the
asynchronous `toBlob`; three watched fail.

**Measured, Chromium 1x and 2x and WKWebView:** the edit begun and the
effects flushed, and the wrapper asked in the same turn, before any task:
masked, for all three masked boxes; not masked for the unmasked one.

## 6. Finding 4: ink past the advance was cut

**Wrong.** `layoutBox` sized a box's canvas from its lines' advances and
line boxes. Glyphs ink past both. What was past the canvas was cut at rest
and came back while the box was typed into.

**Measured before** (the engine's raster against the canvas it is copied to;
share of ink, by alpha, that fell outside): the review's italic J at 300 px,
left-aligned, 11.79%. Upright J, 2.67%. Faux-italic WHAM filling its box,
5.45%.

**Changed.** `src/lib/exporter.js:303`. When the Rust engine both measures
and paints, the footprint grows to hold the ink rectangle of the placed
lines (`linesInkRect`, `src/lib/contain.js:266`), less the 4 px of spare the
padding already has (`PAD_SPARE`, line 160).

**The gate.** One, at the engine seam: `engineDraws()`,
`src/lib/text-engine/index.js:57`. It is true when an engine is installed
and the installed painter says it paints with that engine. It has one
caller, in `layoutBox`. At cut-over the function and the `if` go and the
growth is unconditional; the comment at the function says so.

**Consumers checked.** `layoutBox` feeds `renderBoxTexture`, the page
composite, the PSD rasters, the warped box and the editor picture. All take
`ox`, `oy`, `cw`, `ch` from it and place by them, so a larger footprint
moves no ink. The capture proof below is that check on 3,732 pictures.
`boxInkRect` in `contain.js` now calls the same `linesInkRect`.

**Tests.** `src/lib/exporter-footprint.engine.test.js`, 26 cases. "Before"
is the same painter not saying which engine it paints with. Twelve watched
fail with the gate off. After: 0 ink lost at scales 1, 2, 2.74 and 6
(measured). The J's footprint grew 44 px on the left.

**Capture proof, `--engine new` against `runs/new/r3`** (measured, after the
last code commit). `layout.jsonl` and `metrics.jsonl`: byte-identical
(`cmp`). 15 of 3,732 pictures differ. For each, the canvas grew, and inside
the old canvas 0 pixels are unlike.

| case | grew, device px at scale 2 | new ink |
|---|---|---|
| `p.base.17.40.1.left`, `.center`, `.right` | top 16, bottom 10 | +1.731% |
| `p.base.37.40.1.left`, `.center`, `.right` | top 6, bottom 16 | +1.09% |
| `p.base.49.22.1.right` | right 4 | +0.447% |
| `p.base.49.40.1.right` | right 18 | +0.739% |
| `p.base.50.40.0.left` | left 2 | +0.008% |
| `p.base.51.40.1.left`, `.center`, `.right` | top 26, bottom 16 | +2.62% |
| `p.fx.2.faux-italic.1` | right 6 | +0.064% |
| a real chapter box (page 12) | right 8 | +0.074% |
| a real chapter box (page 24) | right 2 | +0.074% |

By side: top and bottom 9, right 5, left 1.

**Measured in Chromium** (`ink` step, 1x and 2x): five boxes with
overhanging letters, at rest against being typed into. The black ink box
moves by at most 1 device px on any side between the two. Two textures have
ink on their outermost column (5 pixels on one at both densities, 3 on the
other at 1x). That is a footprint grown
exactly to the ink, not a cut: the same box in the footprint test loses ink
with the growth off and none with it on (`italic jf at 70`, measured).

**Not done.** Curved and path text keep their fixed margin (0.75 of the
size); this item changed straight text only.

## 7. Item 13: the edge-drag floor

**Wrong.** A side handle's drag stops a box with auto height at the height
its lines need. `TextBox.svelte` worked that out itself, from the lines on
screen. While the box's face is still arriving those lines are a stand-in's,
and every fit in the store stands down for that (`faceArriving`,
`holdFit`); this one did not.

**Measured before** (DOM test): with the face arriving, a bottom edge
dragged far up stopped at 109 px, the stand-in's line count, not at 30.

**Changed.** `src/lib/store.svelte.js:3099`: `edgeDragFloor(b, lineCount,
p)`, beside the fits it mirrors. It returns the plain minimum
(`EDGE_DRAG_MIN`, 30) and holds the fit while the face is arriving.
`TextBox.svelte:1224` asks it.

**Tests.** `src/lib/edge-drag-floor.test.js`, 6 tests (a new function; not
watched failing). `src/lib/TextBox-edge-drag.dom.test.js`, 3 tests; one
watched fail.

## 8. Findings 6, 11, 12

**6. A screen reader had nothing.** A box shown as a picture has no text
node. `src/lib/TextBox.svelte:994`: while the picture is shown and the box
has text, the root carries `aria-label` with the text, and `role="group"`
so that the name is allowed. Typed into, or with the switch off, neither is
set. Tests: "what a screen reader is told", 5 tests; two watched fail. Not
run with VoiceOver.

**11. The picture test's circle was not a circle.** `KINDS.circle` in
`box-picture.engine.test.js` lacked what makes `circleLayout` run and took
the straight route. It now has the style and the text of a ring (line 94),
and a test says each kind takes the route its name says; watched fail.

**12. The scale test compared alpha only.** `against()` in
`exporter-scale.engine.test.js:84` now compares premultiplied colour as
well. Limits are measured, scale 3 averaged down against scale 1, of 255:

| kind | solid pixels, mean | solid pixels, worst | inked pixels, mean |
|---|---|---|---|
| flat colour | 0.01 | 0 | 0.42 |
| gradient | 0.19 | 1 | 0.44 to 0.57 |
| gradient, box | 0.20 | 1 | |
| gradient, radial | 0.33 | 1 | |
| pattern | 1.06 | 7 | 2.03 (worst 36) |
| bands | 0.36 | 65 | 0.45 |

Mutation cases (a fill painted flat where it should be a gradient) fail the
new limits. They are new checks and pass by design; not watched failing.

## 9. A lower scale while a handle resizes

**Measured before** (`drag` step: a real pointer drag of the east handle, a
step a frame, time to the end of the frame's effects; median and range of 30
frames):

| box | display, zoom | canvas | a frame |
|---|---|---|---|
| balloon 220 x 110 | 2x, 100% | 0.14 MP | 2.3 ms (2.0 to 2.9) |
| balloon | 2x, 300% | 1.05 MP | 6.1 ms (5.2 to 7.5) |
| effect 600 x 400 | 2x, 100% | 1.12 MP | 12.7 ms (10.4 to 13.7) |
| effect | 1x, 300% | 2.38 MP | 24.8 ms (22.1 to 30.3) |
| effect | 2x, 300% | 8.39 MP | 72.2 ms (63.0 to 78.8) |
| page-wide 1100 x 800 | 2x, 100% | 4.28 MP | 47.9 ms (40.0 to 53.4) |
| page-wide | 1x, 300% | 8.39 MP | 87.1 ms (77.5 to 104.7) |
| page-wide | 2x, 300% | 8.39 MP | 85.0 ms (70.6 to 88.1) |

P6 inferred "about 60 ms a frame for an 8 MP box". Measured: 72 to 87.

**Changed.** `src/lib/TextBox.svelte:132`: `resizing`, a flag of the
component, set on the drag's first move (line 1228) and cleared when it ends
(line 1243). `pictureRes` reads it (line 133). While it is set, the scale is
`dragScale` (`src/lib/editor/box-picture.js:91`): the scale asked for, or
less for a box whose own area at that scale is over `PICTURE_DRAG_PX`, one
megapixel. The scale is in the picture's key, so letting go is one repaint.

**Chosen differently from the brief, in amount.** The brief says a lower
scale. A scale lowered for every box would soften the ordinary balloon, whose
frame is 2 to 6 ms and needs nothing. A budget touches only the boxes whose
frame is dear.

**Measured after.** Two runs: one minutes after the before run, under the
same load, and the final run of the whole check, on a quieter machine. The
before figures have no quiet counterpart, so compare the first two columns.

| box | display, zoom | canvas at the last frame | a frame, before | a frame, after, same load | a frame, final run | letting go, final run |
|---|---|---|---|---|---|---|
| balloon | 2x, 100% | 0.14 MP | 2.3 ms | 2.5 ms (2.0 to 3.0) | 1.7 ms (1.0 to 2.9) | 0.8 ms |
| balloon | 2x, 300% | 1.05 MP | 6.1 ms | 5.4 ms (5.0 to 6.0) | 3.5 ms (3.0 to 4.1) | 0.5 ms |
| effect | 2x, 100% | 1.12 MP | 12.7 ms | 12.8 ms (12.0 to 14.0) | 7.4 ms (7.0 to 11.7) | 7.4 ms |
| effect | 1x, 300% | 1.12 MP, was 2.38 | 24.8 ms | 13.6 ms (10.6 to 14.2) | 8.1 ms (7.8 to 8.4) | 14.0 ms |
| effect | 2x, 300% | 1.12 MP, was 8.39 | 72.2 ms | 13.8 ms (12.9 to 14.9) | 8.1 ms (7.4 to 8.6) | 41.1 ms |
| page-wide | 2x, 100% | 1.21 MP, was 4.28 | 47.9 ms | 17.3 ms (16.8 to 19.9) | 10.7 ms (10.0 to 11.6) | 28.5 ms |
| page-wide | 1x, 300% | 1.21 MP, was 8.39 | 87.1 ms | 17.9 ms (17.0 to 20.6) | 17.7 ms (10.6 to 19.3) | 88.1 ms |
| page-wide | 2x, 300% | 1.21 MP, was 8.39 | 85.0 ms | 17.8 ms (15.3 to 19.8) | 11.3 ms (10.6 to 12.9) | 53.3 ms |

Letting go is the one repaint at the scale the box has at rest. After it the
canvas is what it was before the drag (8.39 MP for the large boxes;
measured). With the switch off a frame of the same drag is 0.5 to 1.0 ms of
script; the browser's own layout and raster come after and a page cannot
time them.

The canvas is a little over a megapixel because the budget is on the box's
area and the footprint has padding.

**What it does not do.** It bounds the part of a frame that follows the
pixels. The `cost` step's resize of a box with three bands of outline took
42 ms a frame at 1.18 MP and 10 ms at 0.13 MP under load, and 24.5 ms and
6.1 ms in the final run (measured, 2x): that is the bands' own work. That step writes the width without a handle, so it does not
set the flag, and its figures are the same before and after.

**Tests.** `box-picture.test.js`, "the scale while a handle is resizing the
box", 4 tests; `TextBox-engine-picture.dom.test.js`, "while a handle is
resizing the box", 5 tests. Watched fail: the four unit tests and two of the
DOM tests (one of them only on the missing export). The other three DOM
tests say what must not change and passed before.

## 10. Not this task

Finding 9, neighbour pages kept painted, and tiling: not done, as the brief
says.

## 11. What was run where

| | Chromium 155, headless | WKWebView (system WebKit) | the Tauri app |
|---|---|---|---|
| the observer's margin, paged and longstrip (item 2) | 1x, 2x | 2x | not run |
| the footprint judged, not the rectangle (finding 3) | 1x, 2x | 2x | not run |
| the long box within the side limit (item 3) | 1x, 2x | 2x | not run |
| a refused paint | 1x, 2x | not run | not run |
| hit targets by `elementFromPoint` (item 4) | 1x, 2x | 2x | not run |
| hit targets by a real click, and by the ink on screen | 1x, 2x | not run | not run |
| the mask at the hand-over (item 5) | 1x, 2x | 2x | not run |
| ink at rest against typing (item 6) | 1x, 2x | not run | not run |
| a frame of a resize (item 9) | 1x, 2x | not run | not run |
| the predecessor's steps (bytes, export, look, edit, cost, a real chapter) | 1x, 2x | not run | not run |

Nothing was run in the Tauri app, on Windows (WebView2) or on Linux
(WebKitGTK). WKWebView was run at the display's own 2x only. What was not
run in WKWebView is everything that needs a screenshot or a pointer from
outside the page; the runner has neither.

The WKWebView figures are from one completed run, at 06:23 on the day of
this report, on the source as committed (`host.js` and everything under
`src/lib` as at `f915739`; the one later change to `src` is a comment). Five
runs were started. One completed. Two ran with the Mac idle for seven
minutes: the page reported `visibilityState: hidden` and got 0 animation
frames in 3 s (measured), and the check, which waits on frames, did not
finish. Two more did not finish before that was understood; that they were
the same thing is inferred. The runner now says a hidden page at once and
exits 4. To run it again the display has to be awake and unlocked.

## 12. What only the real desktop app can show

- That the margin is real in the app's own window on the user's macOS, and
  in WebView2 and WebKitGTK. `root` with `rootMargin` is in every one of
  them by the compatibility table (inferred); only this Mac's WebKit was
  run.
- What a frame of a resize costs in WKWebView. The figures in section 9 are
  Chromium's canvas; WebKit's is another implementation.
- That a pen or a trackpad lands on the hit targets as a mouse click does.
- What VoiceOver says for a box with `role="group"` and a name.
- A system font with ink far past its advance. The capture has two real
  boxes that grew; the check page has no system faces outside Tauri.
- The process's real memory with the margin real. The figures in section 2
  are canvas backing stores, summed by the page.

## 13. Also seen, not changed

- With the switch off, a centred line wider than its box is set from the
  box's left edge by CSS; the engine and the export centre it. 5.3 px in the
  check's box (measured). Section 4.
- In Chromium the faux-bold box at rest is 8 device px wider on each side
  than the same box being typed into, at 2x (measured; P6's run had 0). The
  picture is byte-identical to the exporter's, and the layout records are
  unchanged by this branch, so it is not from these commits. It came with
  the merge at `5d73134`: the engine measures a synthesised bold as WebKit
  does and Chromium's DOM does not (inferred; not run in WebKit).

## 14. Commits

| hash | subject |
|---|---|
| `9b1bc89` | fix(text-engine): the painter's kept scratch canvas is bounded by what it becomes, not by the raster that arrived |
| `47f340f` | fix(editor): the near-viewport observer is rooted at the scrolling area, so its margin is real |
| `fe0fded` | fix(editor): a box is near the viewport by what its picture covers, not by its rectangle |
| `e65796a` | fix(editor): a box's picture is kept inside the longest side the engine paints, not only inside the pixel budget |
| `b0d0f25` | fix(editor): a box whose picture cannot be painted is shown as its text, and the rest of the page is painted |
| `bf23015` | fix(editor): text the engine's picture shows outside the frame takes the pointer again |
| `f97250f` | fix(editor): a masked box keeps its mask image at rest, so typing does not start on unmasked text |
| `4fe8539` | fix(text): with the rust engine drawing, a box's footprint holds the ink of its glyphs, not only their advances |
| `c7f3498` | fix(store): an edge drag's height floor stands down while the box's face is arriving, as every fit does |
| `2e41922` | fix(editor): a box shown as the engine's picture says its text to a screen reader |
| `455ae83` | test(editor): the picture test's circle is a circle |
| `46b4180` | test(editor): the scale test compares colour, not only alpha |
| `ec13050` | test(editor): the editor check asks what is near, what takes the pointer, what is held and what a drag costs |
| `553eb60` | test(text): the footprint test holds the editor check's italic jf, whose ink starts on its canvas's first column |
| `f915739` | fix(editor): a box over a megapixel is painted lower while a handle resizes it, and in full once when it is let go |
| `3d6580b` | docs(editor): the drag budget's comment says what it does not bound, and the check's picture of the long box shows its text |

And the commit this report is in, with `scripts/text-port/cropped.mjs` and
the corrections to `P6-REPORT.md`.

## 15. How each proof was run

All from the worktree `tp-editor`.

```
./node_modules/.bin/vitest run
npm run build

node scripts/text-port/capture-node.mjs --data <tp-data> --run p6b-sk
diff -rq <tp-data>/runs/ref-sk/base <tp-data>/runs/ref-sk/p6b-sk

node scripts/text-port/capture-node.mjs --data <tp-data> --run p6b-new --engine new
diff -rq <tp-data>/runs/new/r3 <tp-data>/runs/new/p6b-new
cmp <tp-data>/runs/new/r3/layout.jsonl <tp-data>/runs/new/p6b-new/layout.jsonl
cmp <tp-data>/runs/new/r3/metrics.jsonl <tp-data>/runs/new/p6b-new/metrics.jsonl
node scripts/text-port/cropped.mjs <tp-data>/runs/new/r3 <tp-data>/runs/new/p6b-new

./node_modules/.bin/vite --port 5203 --strictPort --host 127.0.0.1     (kept running)
node scripts/editor-check.mjs --data <tp-data> --url http://127.0.0.1:5203 --port 9381 --out <tp-data>/reports/p6b --dsf 2
node scripts/editor-check.mjs --data <tp-data> --url http://127.0.0.1:5203 --port 9381 --out <tp-data>/reports/p6b --dsf 1
swiftc scripts/editor-check-webkit.swift -o <scratch>/editor-check-webkit
<scratch>/editor-check-webkit http://127.0.0.1:5203 > <tp-data>/reports/p6b/webkit.json
```

The last one needs the display awake and unlocked (section 11).

`--port 9381` is the DevTools port; 9377 is the default and may be another
worker's. The check's steps can be run alone: `--only
near,hits,mask,limits,ink,drag`. The first load of the check page after the
dev server starts can reload itself once while Vite prepares its
dependencies, and the driver then fails at its second question; run it
again.

Written by the check, in `<tp-data>/reports/p6b`: `report-1x.json`,
`report-2x.json`, `webkit.json`, and the pictures. The ones this task adds:
`near-spill-<layout>-<n>x.png` (the spilling box, its rectangle off screen),
`hits-<n>x.png` (every point tried: green took the pointer, red did not,
pink is ink that did not), `limits-long-<n>x.png`,
`limits-refused-<n>x.png`, `ink-<n>x.png` (at rest beside being typed
into). I looked at each of these at both densities, and at
`page-100-2x-on.png`. The logs are `<tp-data>/reports/p6b-check-1x.log` and
`p6b-check-2x.log`.

The capture was also run in default mode four times between commits
(`p6b-ska` to `p6b-skd`) and once with `--engine new` (`p6b-newa`); each
default run differed from `base` in `manifest.json` only. Those runs are
deleted. The brief's naming for a second try is `p6b-sk2`; I used letters.

The before figures in section 9 are from the same `drag` step run on the
tree before `f915739`; that run's report was not kept.
