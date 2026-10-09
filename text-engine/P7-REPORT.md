# P7: typing into a box that is a picture

Branch `tp/editor`, from `58369aa`. The brief is
`tp-data/briefs/p7-editor-typing.md`. This file is written in stages; section
1 was written before any code and is kept as the plan the code was held to.
Where the code ended up different, section 1 says so in a line marked
**Changed**.

## 1. Design (written first)

### 1.1 What a box being typed into is made of, with `textEngine: 'rust'`

```
div.clipwrap                      (carries the flip, as at rest)
  canvas.warpl[data-painter=engine]   the picture, the same paint as at rest
  div.type-edit                   takes the pointer; holds the marks
    span.tsel*                    selection, one rectangle per row
    span.tcomp*                   the composing range, one underline per row
    span.tcaret                   the caret
  div.txt.editable.unseen[contenteditable]   the text the OS types into
```

The editable is the element it is today, built by the same `drawEditLines`
from the same `editSegs`, with the same listeners. It is not seen: no
colour, no caret, no selection highlight, no pointer.

**Changed.** It is `opacity:0`, not transparent ink: Chromium paints a mark
of its own, opaque, on the text an IME composes, and it lay over the
picture (seen in the first pictures of the check). It is also
`overflow-anchor:none` (section 6). A curve has `div.curve-edit` in place of
`div.type-edit`, as it has with the switch off, and both hold `span.tpad`
targets for text that leaves the frame. `beforeinput` to
`rawEdit` to `setBoxText` is untouched. The picture is repainted by the
paint effect that paints a box at rest, because `text` is in its key.

One element in the template for both ways of typing (seen and unseen), so a
paint that throws mid-edit changes a class and a style on the element that
has the focus, and does not replace it.

### 1.2 Where positions come from

One new engine export, `mt_line_carets(font, size, flags, text_len,
letter_spacing)`. It calls `paint::shape_run`, which is the function the
painter calls for every straight run (`paint/mod.rs`, `paint_job_with`), with
the same face, text and letter spacing. For each cluster it writes the
cluster's UTF-16 offset and the pen x of its first glyph (the placed glyph's
x less its own x offset), then one closing pair: the text's length and the
run's advance. So letter spacing, the synthesised bold's advance, kerning,
fallback parts and ligature suppression are the painter's by construction,
not copied.

JS builds rows from three things that already exist and that the painter
reads too:

- `placeBlock(boxCandidate(box, text))`: the lines, `lineX` (the anchor each
  line is drawn at), `blockY`, `lineH`. This is what `layoutBox` and
  `glyphJob` paint from.
- `editLines(text, cased, lines)`: each line as a slice of the raw text
  (`start`, `head`, `body`, `hyphen`, `tail`).
- `lineCarets` for each line's string (the invented hyphen included, as the
  painter is given it).

A line's start is `lineX[i] + alignOffset(align, advance)`, the painter's
own sum; a stop is the start plus the cluster's pen. Rows are in page px,
box-local, before the flip: the frame the mask shapes and the mesh are in
(`maskLocal`). Marks are drawn at `page px * zoom` inside the clip wrapper,
so the box's turn and the wrapper's flip carry them as they carry the
picture.

Curved text keeps its own model (`curve-caret.js`): the glyph anchors are
`placeBlock`'s `layout`, the list the painter draws one glyph per entry
from, times the zoom.

### 1.3 The caret model (pure functions on rows; no DOM)

A **row** is `{ top, height, from, to, offs[], xs[], soft }`: the raw
offsets it can show a caret at (ascending, grapheme boundaries only) and the
x of each.

**Changed.** A row is `{ top, height, offs[], xs[], soft, hard, line }`.
`from` and `to` are the first and last of `offs`. `hard` says the row ends
at a Return; `line` is the painted line it is, or -1 for a trimmed one. Rows are the drawn lines, plus one row for each Return the layout
trims at either end of the block (above the first line, below the last).

Rules, each to be tested:

1. **Inside a cluster** (a ligature): the stops are the grapheme boundaries
   inside it, at even divisions of the distance to the next cluster's pen.
   An offset inside a grapheme (after a base, before its combining mark)
   has no stop and shows at the stop before it.
2. **Hidden whitespace hangs.** The space a line wrapped at, and spaces at
   the end of a paragraph that the breaker drops, are not drawn. A caret
   after `k` of them stands `k` space advances (plus letter spacing) right
   of the line's last pen; before `k` leading ones, that far left of its
   first. So a space typed at the end of a line moves the caret, as it does
   today.
3. **A soft wrap shares one offset between two rows**: the end of the upper
   (after its hanging spaces) and the start of the lower. The caret shows on
   the lower row unless it has upstream affinity. Affinity is set by End,
   by a click right of the upper row's end, and by Up or Down landing
   there; any edit and any other move clears it.
4. **A Return is a hard break**: before it is the upper row, after it the
   lower. No sharing.
5. **Trimmed Returns** (leading and trailing): each opens a row a line
   height above or below the block, with one stop at the line's anchor.
6. **Empty box, empty line, a line of spaces only**: one stop at the
   anchor (the centre for centred text); spaces hang from it by rule 2.
7. **Up and Down** go to the stop nearest a remembered x on the next row;
   the x is kept until something other than Up or Down moves the caret. Up
   on the first row goes to offset 0 and Down on the last to the end.
8. **Home, End, Cmd+Left, Cmd+Right**: the row's first and last stop.
   **Cmd+Up, Cmd+Down**: the text's start and end. Shift extends from the
   anchor in every case.
9. **Left and Right** are taken too, by grapheme on the raw text (the brief
   allows native; the hidden element's line elements make a native Right at
   a wrap a keypress that changes no offset). Word movement stays native.
10. **Soft-line deletes** take `[row start, caret]` and `[caret, row end]`
    from the rows; hard-line deletes take the paragraph from the raw text.
11. **Selection** is one rectangle per row, the row's full height. A row
    whose hard break is inside the selection is extended by a small fixed
    width so an empty selected line shows.

The caret is as tall as the row (the line height), `--tintline`, blinking.

### 1.4 Uppercase

Offsets are raw; the picture is cased. When casing keeps the length the two
are one for one. When it does not (`ß` to `SS`) a per-code-point map from
raw offsets to cased offsets is built and checked against `applyCase`'s own
answer; rows are built in cased offsets and carried to raw ones through it,
so a caret cannot stand between the two S of one `ß`. If the check fails
the box is typed into as DOM text, as today.

### 1.5 The hidden editable and the IME

The OS puts the candidate window at the hidden element's native caret. Two
things keep that on the drawn caret:

- the element is laid out as it is today (same lines, same font size and
  metrics, same place in the flex wrapper, inside the same flip), so its
  own caret is already near ours;
- after every caret move, and on every `input` and `selectionchange` of a
  composition, the native caret's rectangle and the drawn caret's are read
  and the element is translated by their difference (taken back through
  the box's turn and flip). This is the only DOM geometry read while
  typing, and nothing that is drawn depends on it.

**Changed.** It is not hung on events. One effect runs when the drawn marks,
the zoom, the turn, the flip or the box's size change, which covers every
caret move and every composed character, because both redraw the marks. A
difference under 0.25 px is left alone, so the effect settles.

While composing, the browser writes into the hidden element; the box's
text is not changed until the composition ends (as now). The picture and
the rows are made from the element's `textContent` meanwhile
(`composeText`, as curved text does today), and the composing range is
underlined.

### 1.6 What stays as it is

- `textEngine: 'browser'`: every new branch is behind `engineSwitch.painting`.
- A warped box: no caret through a mesh. It keeps the engine's picture
  while its text is edited from the Inspector, and has no marks, as today.

**Changed** (a correction, the code is as it was): a double-click on a
warped box starts no edit at all, with either engine (`onDblClick`). If its
edit flag is set some other way it is painted the old way and has no
editable, as with the switch off.
- A paint that throws: the box is DOM text for that key, typed into as
  today, by the same element.

## 2. What was built, in one paragraph

With `textEngine: 'rust'` a box being typed into stays the canvas it is at
rest. The same paint effect repaints it on every change of the text. A
transparent overlay takes the pointer and holds the caret, the selection
and the composing underline, all drawn from rows made of the painter's own
lines and pens. The `contenteditable` is the same element as before, at
`opacity:0`, and every edit still goes `beforeinput` to `rawEdit` to
`setBoxText`. With the switch off none of it is reached.

Figures below are **measured** unless a line says **inferred**. The browser
figures are Chromium 155, headless, on this Mac, driven over DevTools with
real key, mouse and IME events (`scripts/editor-check.mjs`, steps `type` and
`typecost`), at a real 1x and a real 2x display density.

## 3. The nine items

### Item 1. Default mode is untouched

| What | Where |
|---|---|
| The one flag everything new is behind | `engineSwitch.painting`, read as `enginePaints`, `src/lib/TextBox.svelte:117` |
| The model is not made with the switch off | `typed` returns null first thing, `TextBox.svelte:118-119` |
| The overlay is not in the DOM | `{#if typeFlat}` and `typeCurve`, `TextBox.svelte:2505`, `2529` |
| The one new effect is made only for an edit begun with the engine drawing | `if (!picturing) return;` in `editField`, `TextBox.svelte:1816`, `1834` |
| The editable has no new attribute | `class:unseen={typing}` is false, `style` is `editStyle` as before, `TextBox.svelte:2563-2565` |
| New listeners | none on the editable. The overlay's are on the overlay |

Proofs.

| Proof | Result |
|---|---|
| `src/lib/TextBox-switch-off.dom.test.js` (the DOM of a box with the switch off, at rest and typed into, against its stored snapshots; file not edited) | passes |
| Default-mode capture `p7-sk` against `runs/ref-sk/base` | 3,405 files each, only `manifest.json` differs |
| Editor check, existing steps, switch OFF, against `reports/p6-merged-2` at 1x and 2x | every leaf equal in `off`, `offBoxes`, `bytes`, `export`, `look`, `near`, `hits`, `limits`; `mask/off` differs only in the host of a blob URL (`localhost` then, `127.0.0.1` now); `costSynthetic`, `real` and `drag` differ only in timings |

Three entries of the existing steps read differently **with the switch on**,
which is this task:

| Entry (switch on) | Before | Now |
|---|---|---|
| `edit[*].editingWas.canvas` | none (DOM text) | `engine` |
| `edit[*].restToEditing`, `ink[*].typingMinusRest` | up to 8 device px (the synthesised bold), 1 to 2 px elsewhere | 0 everywhere |
| `mask/on/*/theFlushTheEditBegan.masked` | true (a CSS mask over DOM text) | false: the box is still its picture, and the mask is cut in the picture. The `masked` box of the `type` step shows the screen unchanged, 0 bytes |

### Item 2. One geometry

| What | Where |
|---|---|
| The export: per cluster, its UTF-16 offset and the pen of its first glyph, then the length and the advance | `mt_line_carets`, `text-engine/src/abi.rs:561`, a new function at the end of the file. It calls `paint::shape_run`, the painter's call for a straight run. `src/paint/` is not edited |
| JS adapter | `lineCarets`, `text-engine/js/engine.mjs:289`; `src/lib/text-engine/rust.js:235` |
| Rows from the painter's statements | `typeModel`, `src/lib/type-rows.js:89`: `placeBlock` (lines, `lineX`, `blockY`, `lineH`, so indent and the ink shift are the painter's), `editLines`, `linePens` |
| A line's start | `lineX[i] + alignOffset(align, advance)`, `type-rows.js:108`, the painter's own sum |
| The arithmetic | `src/lib/flat-caret.js` (no DOM, no engine) |
| Curves | the glyph list `placeBlock` gives the painter, `type-rows.js:99` |

Proofs.

| Proof | Result |
|---|---|
| `text-engine/tests/carets.rs`: every stop equals `shape_run`'s glyph x, through the C ABI | 7 tests pass |
| Pixels (`type-rows.engine.test.js`, "in pixels"): a line is painted at 2x with and without each cluster; the first column that changes is the caret before it plus the cluster's own left bearing | within 1 device px for a kerned pair (`AVAVA`), a ligature (`fi` in DejaVu Sans), letter spacing, letter spacing breaking the ligature, a synthesised bold, a real italic, a borrowed letter (Cyrillic from DejaVu Sans in Comic Neue). Worst seen 0.8 device px, always the fraction a pixel column cuts off |
| The same test with every line started 3 px right of the painter's start (mutation T17) | 14 of 23 tests fail: the pixel test sees a 3 px drift |
| Browser: the canvas while typed into against `renderBoxTexture` of the same text | 0 bytes different, 13 boxes, at 60, 100 and 300%, at 1x and 2x |
| Browser: the drawn caret against the stop the model gives, after a real press | worst 0.012 CSS px at 2x, 0.024 at 1x (1,842 presses each) |

### Item 3. What the browser did for flat text

| Behaviour | Code | Rule |
|---|---|---|
| Caret at every raw offset, blinking, `--tintline`, as tall as the line | `typeMarks`, `TextBox.svelte:2124`; `.tcaret`, `src/styles.css:808` | `caretAt`, `flat-caret.js:190` |
| Selection, one rectangle a row | `selectionRects`, `flat-caret.js:200` | a selected Return adds a sliver 0.3 of the font size wide, so an empty selected line shows |
| Press, drag, Shift+press | `onTypePointerDown`, `TextBox.svelte:2167` | `offsetAt`, `flat-caret.js:236`: the nearest stop of the row level with the pointer, the later of two as near |
| Double-click | `onTypeMouseDown`, `TextBox.svelte:2202`; `wordPress`, `flat-caret.js:284` | measured in Chromium, below |
| Triple-click | `linePress`, `flat-caret.js:291` | measured in Chromium, below |
| Up, Down with a remembered column; Home, End; Cmd+Left, Right, Up, Down; Shift forms | `typeKey`, `TextBox.svelte:2239`; `moveCaret`, `flat-caret.js:320` | our rows |
| Left, Right | the same | one grapheme of the raw text. Taken, not left native: where a line wrapped the editable has two places for one offset and a native Right spent a press between them (the check counts 0 presses that did not move) |
| Word movement, word delete | left to the browser | logical order, no layout in it |
| Soft-line deletes | `onEditBeforeInput`, `TextBox.svelte:1918`; `lineDeleteSpan`, `flat-caret.js:364` | our row, on the side of a wrap the caret shows on. Hard-line deletes take the paragraph from the raw text. No other `inputType` was found whose target range depends on layout |
| Ligatures and clusters | `penAt`, `flat-caret.js:141` | even divisions of the cluster's advance, one a grapheme; no stop inside a grapheme (`graphemeBounds`, `type-rows.js:42`) |
| Wraps and trimmed Returns | `buildRows`, `flat-caret.js:61`; `rowOf`, `flat-caret.js:169` | section 1.3, rules 2 to 5: hidden spaces hang; a wrap's offset shows on the lower row unless the caret came there by End, by a press past the upper row's end, or by Up or Down; each trimmed Return has a row of its own |
| Empty box, empty line, only spaces | `buildRows` | one stop at the anchor; spaces hang from it |

What the browser selects today (measured with the switch off, real presses
at the two halves of every letter, then matched):

- **Two presses**: the caret goes where one press puts it; the selection is
  the word segment (`Intl.Segmenter`, the browser's own word rule) that
  starts at or holds that offset. So the right half of a word's last letter
  selects the space after it. At a hard line end it selects the Return.
  Past the end of a row that wrapped it selects nothing.
- **Three presses**: the row, with the space it wrapped at, or with its
  Return.

| Compared with the browser (each density) | Count | Unlike |
|---|---|---|
| Double-clicks where both carets went to one offset | 529 | 0 |
| Double-clicks where the browser's own layout put its caret at another offset (not a comparison of the rule; 43 of them the flipped box, which the browser types into unflipped) | 49 | not compared |
| Triple-clicks | 25 | 0 |

Browser check, each of 13 boxes, each density (all pass):

| Check | Figure |
|---|---|
| Presses at both halves of every letter, at 60, 100 and 300% | 1,842, 0 at a wrong offset |
| Drag across rows, Shift+press | selection and rectangle count as expected |
| Down, Up, Shift+Down, Home, End, Cmd+Left, Cmd+Shift+Right, Cmd+Up, Cmd+Down across unequal lines | every selection as `moveCaret` says for the box's rows, caret on the stop |
| Right from the start to the end | as many presses as characters |
| Type, Backspace, Alt+Backspace, Cmd+Backspace, paste, cut, Cmd+Z, Cmd+Shift+Z | text and caret offset right after each, picture 0 bytes from `renderBoxTexture` |
| Empty box; box of three spaces | caret a line tall at the anchor; first letter drawn; a Return opens a row a line lower; a space steps the caret 10.02 px (the engine's space) |

Unit tests: `flat-caret.test.js` (48), `type-rows.engine.test.js` (23),
`TextBox-engine-typing.dom.test.js` (27).

### Item 4. Uppercase

**Chosen: mapped properly.** `caseMap` (`flat-caret.js:390`) builds the cased
offset of every raw offset, letter by letter, and checks the result against
the cased text the painter is given. Rows are built in cased offsets and
carried to raw ones (`mapRows`, `flat-caret.js:425`), so no caret can stand
between the two S of one `ß`. Why: the fallback would make one German word
change how a whole box is typed into. If the check fails (a casing that is
not letter by letter) `typeModel` returns null and the box is DOM text
(`type-rows.js:98`); no such casing is known for `toUpperCase`.

Tests: "casing that changes the length" in all three test files. Browser:
the `upper` box (`Straße` drawn `STRASSE`), 44 of 44 presses, all keys and
edits, at both densities. A curve with `ß` is typed into as a picture too
(dom test, 7 marks for 6 letters).

### Item 5. IME and the OS

| What | Where |
|---|---|
| Composed text is in the picture | `composeText` is in the picture's key and the paint reads a stand-in box, `TextBox.svelte:601-610`, `645`; `onEditInput`, `1951` |
| The composing span is underlined | `composeAt`, `composeSpan`, `TextBox.svelte:2114-2119`; `.tcomp`, `.ccomp` |
| The native caret is under the drawn one | `nativeCaret`, `alignNative`, `editShift`, `TextBox.svelte:2285-2331`. The editable is laid out as before and then moved by the measured difference, taken back through the turn and the flip |
| Places with no rectangle of their own | in front of a Return that starts its text node, the Return's own rectangle; on an empty line, its `<br>`'s (measured in Chromium; fixed in `c761767` after the self-check found them) |
| Autocorrect | `insertReplacementText` goes through `editSpan` (`getTargetRanges`) and `applyEdit` with `dataTransfer`, as it always did: `TextBox.svelte:1887`, `1919` |
| Right button | `typeMenu`, `TextBox.svelte:2214` |

| Proof (browser, each density) | Figure |
|---|---|
| `Input.imeSetComposition` twice, then a commit, 13 boxes | composed text held and underlined, not yet the box's; picture 0 bytes from `renderBoxTexture` of the composed text; caret inside the composition where the IME put it; committed text right; Cmd+Z takes it out |
| Native caret rectangle to drawn caret, during composition | worst 0.24 CSS px (limit 4) |
| The same after a press at every stop of every box (614 stops, events made in the page) | worst 0.24 CSS px; no stop without a rectangle |
| Synthetic `insertReplacementText` with a `StaticRange` and a `DataTransfer`, two words | replaced, drawn, caret after the word, undone by two Cmd+Z |
| Right press on the picture, 12 straight boxes | the word under it is selected; the `contextmenu` event's target is the editable (so `shell-guards.js` keeps the native menu) |

What is lost, exactly:

- **Spelling squiggles.** The editable is not painted, so they are not
  seen. The spelling suggestions in the menu still come from the editable
  (inferred: the menu is the editable's).
- **The browser's own composition marks.** One underline of ours marks the
  whole composing span. An IME's per-clause styling (the thick segment being
  converted) is not shown.
- **Glyphs the box's fonts lack.** The composing text is drawn by the
  engine, so kana in a box with no kana font shows as empty boxes while
  composing (seen in every `ime` picture), where DOM text would borrow a
  system font. It is what the export would draw.
- **The context menu.** A right press selects the word under it unless it
  is on the selection, then the overlay steps aside (class `ctx`, until the
  menu event or 1 s) so the system's hit test finds the editable. Cut, Copy
  and Paste are then the editable's own. Cmd+C, X and V never went through
  the overlay and work as before. "Look Up" by force press on the picture is
  not offered (inferred: the press lands on the overlay).
- **On a curve** the right button does what it does with the switch off:
  the curve's overlay was already there and is not changed.
- **Double-click then drag** does not extend by words, and triple-click then
  drag not by rows.

### Item 6. No jump

| What | Where |
|---|---|
| The canvas is the same element, not repainted, when the edit starts and ends | the picture's key does not hold `editing`; `engineWanted`, `TextBox.svelte:129` |
| The first focus selects all and shows it | `editField` as before; `typeMarks.sel`; the caret is hidden over a selection (`.off`) |
| The page does not scroll | `overflow-anchor:none` on the unseen editable, `styles.css:803` |

| Proof (browser) | Figure |
|---|---|
| Screen bytes unlike, rest against edit begun, marks hidden | 0, 13 boxes, 3 zooms, 2 densities, and the masked, inked and smeared boxes |
| Screen bytes unlike, rest against edit ended | 0, the same |
| The canvas rectangle and size across the edit start | unchanged |
| Existing `edit` and `ink` steps | 0 device px on every side for every box; the synthesised bold read 8 before |
| First focus | everything selected, a rectangle a row |

**Found on the way, and not this task's to fix:** with the switch off, at
300%, starting an edit of a centred box scrolls the page by half a line (43
CSS px measured). Chromium anchors its scrolling on the focused editable,
and the editable's top moves as its lines are drawn into it. It was so
before this task. In typing mode it would have moved the picture, so the
unseen editable is no scroll anchor. Default mode is left as it is.

### Item 7. Rotation, flip, zoom, density, and the effects

The marks are children of the clip wrapper, placed in page px times the
zoom, so the box's turn and the wrapper's flip carry them as they carry the
canvas. A pointer is taken back through both (`maskLocal`,
`TextBox.svelte:1496`).

| Box | Presses right, 60 / 100 / 300% | Worst caret, CSS px | Seen in the pictures |
|---|---|---|---|
| rotated 30 degrees | 44 of 44 each | 0.011 (0.022 at 1x) | caret and selection tilted with the letters |
| flipped | 44 of 44 each | 0.011 (0.022 at 1x) | mirrored with the letters; the flip is kept while typing (with the switch off the box drops it) |
| arc | 36 of 36 each | 0 | a tilted caret between two glyphs; a mark a glyph |

The press counts are the same at 1x. What each of these does while typed into:

| Box | While typed into | Measured |
|---|---|---|
| Clip mask | the picture, with the mask cut in it; marks are not masked | 0 screen bytes at edit start, 44 of 44 presses, a typed letter 0 bytes from `renderBoxTexture` |
| Brush ink | the picture, the ink canvas over it as at rest | the same |
| Motion blur | the smeared picture; the caret stands at the unsmeared pen | the same |
| Warped (mesh, liquify) | **today's behaviour**: a double-click starts no edit, with either engine; the text is edited from the panel | checked: no edit, the picture stays |

### Item 8. A failure never eats text

One `contenteditable` in the template serves both ways of showing the box
(`TextBox.svelte:2504`, `2560`). A paint that throws sets `failed`; `typing`
goes false; the class `unseen` and the style change on the element that has
the focus. Nothing is replaced. A model that throws is caught and is the
same (`TextBox.svelte:123-127`). The input path is not forked: the same
handlers, with one line that swaps the range of a line delete
(`TextBox.svelte:1918`).

| Proof | Result |
|---|---|
| dom test "a picture that cannot be painted never takes the text with it" | the same element, caret kept, typing goes on, the picture returns |
| Browser, real keys: the painter made to refuse a `Q`; type `Q` mid-edit | the text holds the `Q`; the box is DOM text; focus kept, caret at 5; one console line; type `u`, caret 6; two Backspaces and it is its picture again, caret 4, 0 bytes |

### Item 9. Cost

A keystroke's work is timed from the `beforeinput` to the end of its
effects (the paint, then a forced layout). 20 inserts and 20 deletes each.
Chromium 155 headless, a real 2x display density. Median (min to max), ms.

| Box | Zoom | Canvas | Switch on | Switch off |
|---|---|---|---|---|
| balloon, 220 x 110 | 100% | 0.11 MP | 1.7 (1.3 to 2.3) | 0.6 (0.4 to 1.0) |
| balloon | 300% | 0.97 MP | 4.1 (3.3 to 4.7) | 0.7 (0.4 to 0.9) |
| effect box (stroke, shadow, blur), 600 x 400 | 100% | 1.21 MP | 14.4 (11.5 to 16.3) | 0.5 (0.4 to 0.8) |
| effect box | 300% | 8.39 MP | 103.1 (70.7 to 117.8) | 0.6 (0.4 to 0.8) |
| page-wide, 1100 x 800 | 100% | 4.07 MP | 46.6 (28.0 to 50.7) | 0.5 (0.3 to 0.8) |
| page-wide | 300% | 8.39 MP | 74.6 (69.6 to 91.0) | 0.6 (0.4 to 0.7) |

From real keys (12 letters and 12 Backspaces each), the time from the key
heard by the page to the first frame after it, median / max, ms:

| Box | Zoom | Switch on | Switch off |
|---|---|---|---|
| balloon | 100% | 9.1 / 16.7 | 1.1 / 16.3 |
| balloon | 300% | 9.4 / 16.1 | 1.2 / 15.2 |
| effect box | 100% | 17.9 / 22.8 | 8.2 / 215.7 |
| effect box | 300% | 103.2 / 117.9 | 1.0 / 15.7 |
| page-wide | 100% | 43.1 / 50.5 | 1.0 / 14.6 |
| page-wide | 300% | 77.2 / 81.6 | 0.9 / 15.8 |

Reading them. **The balloon is under a frame**: 1.7 ms of work at 100% and
4.1 at 300%. Its 9 ms to the first frame is the wait for the display's next
frame, not work: a blinking caret keeps frames coming at 60 a second, where
the switch-off page draws one at once (**inferred** from the two medians;
the work figure is the measured one). Where the work is long the first
frame comes when it ends (103.1 against 103.2), so the paint is in the first
frame after the key. The 215.7 is one stray frame (**inferred**: the
machine was shared and loaded).

At 1x the same boxes cost 0.8, 1.2, 3.6, 18.4, 6.1 and 46.5 ms.

**The large boxes are not under a frame**: the effect box at 300% and the
page-wide box at both zooms. **Proposed, not built**: the form P6b built for
resizing. `TextBox.svelte:642` already paints with a smaller pixel budget
while a box is resized (`PICTURE_DRAG_PX`) and repaints sharp when the
gesture stops. The same budget while keys are coming, and one sharp paint
about 150 ms after the last key. The marks need nothing: the rows do not
depend on the picture's scale. Expected cost: the `drag` step of this same
run paints these boxes at 1.05 MP in 5.0 ms (effect, 300%) and 5.9 ms
(page-wide, 300%) a frame (**measured** for a resize; **inferred** for a
keystroke). The price is letters that are soft while one types fast in a
very large box.

## 4. The browser check's pictures, and what I saw

`tp-data/reports/p7/type-1x-01..03.png`, `type-2x-01..03.png` (each box: an
IME composing, a caret, a selection) and `type-1x-edges.png`,
`type-2x-edges.png`. I looked at all eight.

- **Caret**: a tint line the full height of its line, in the gap it should
  be in, in all 13 boxes. Tilted in the rotated box and on the arc; on the
  mirrored side in the flipped box.
- **Selection**: one blue rectangle a row, the row's height. The first row
  runs past its last letter by the sliver that stands for the selected
  Return. In the wrapped paragraph each row runs over the space it wrapped
  at. In the right-aligned box the sliver is past the frame. On the arc, a
  tilted rectangle a glyph.
- **IME**: the three composed characters are drawn as empty boxes (no font
  here has kana), underlined in the tint, the caret after the first of
  them, the rest of the line moved right. In the stroke-and-gradient box the
  composed text makes the line wrap, as it would once typed.
- **1x against 2x**: the same pictures at half the size; the caret is 1.5
  CSS px wide in both.
- **Edges**: an empty box with a caret a line tall in its middle; `x` typed
  among spaces at the line's start with the caret after it; the refused box
  as plain DOM text with its outline; the masked box cut by its ellipse at
  rest, at edit start and while typing; ink under the text throughout; the
  smeared box smeared throughout; the warped box selected, with handles and
  no caret.
- The arc and the smeared box have no outline in the pictures. That is the
  check page's own rule for a box flagged for review
  (`editor-check.html:16`), not the app.

## 5. Mutations: what each new test fails on

Run in a scratch copy, not the worktree. 110 mutations of
`flat-caret.js`, `type-rows.js`, `TextBox.svelte`, `engine.mjs` and
`rust.js`, and 7 of `mt_line_carets`. Every mutation fails at least one
test, and every one of the 105 new tests fails on at least one mutation.
The first run found seven behaviours no test held (a third trailing Return,
graphemes inside a cluster, a press exactly between two stops, a cased text
as long as the letters cased, Home from a wrap's upper side, a curve's caret
at the focus, a curve with `ß`); tests were added (`71c5dce`). It also had
one mutation that changed nothing and two tests that needed a sharper one;
those mutations were rewritten. The list and the per-mutation results are in
`node_modules/.cache/p7/mutate.mjs`, `mutation-results.json`,
`mutate-rs.py`, `mutation-rust.json`.

`src/lib/flat-caret.test.js` (48 tests, no engine, no DOM)

| Test | Fails on |
|---|---|
| one line: the stop before character k is at the line start plus its pen | F42: a caret is not as tall as its row |
| an empty box: one row, one stop, at the anchor | F35: an empty line stands at x 0 |
| an empty line between two paragraphs has its own row, at its anchor | F35: an empty line stands at x 0 |
| a Return is a hard break: before it the upper row, after it the lower, whatever the affinity | F10: xOn takes the stop before an exact one |
| the space a line wrapped at: after it is the lower row, or with upstream affinity the upper, one space out | F9: a shared offset always shows on the upper row |
| two spaces at a wrap: the first is on the upper row only | F9: a shared offset always shows on the upper row |
| spaces typed at the end of the last line move the caret | F3: trailing hidden spaces take no room |
| a line of only spaces: they hang from the anchor | F35: an empty line stands at x 0 |
| leading spaces a paragraph lost hang to the left of its first pen | F2: leading hidden spaces hang to the right |
| a break with nothing between the lines (after a hyphen that is in the text): one offset, two rows | F9: a shared offset always shows on the upper row |
| an invented hyphen is not a character: the row ends at the pen before it | F38: a row ends at the line advance, the invented hyphen included |
| trailing Returns: one row a line height below for each, at the anchor | F5: rows below the block all on the first of them |
| leading Returns: one row a line height above for each | F1: rows above the block one line too high |
| a text of Returns only: the one drawn line, then a row for each | F5b: the row after the last Return on the last line itself |
| a ligature is one cluster: the stops inside it divide its advance evenly | F8: a cluster divided by code units, not graphemes |
| a base and its combining mark are one stop apart from the next: none stands between them | F37: a stop inside a grapheme |
| an emoji is two code units and one stop | F37: a stop inside a grapheme |
| the left half of a glyph is the offset before it, the right half the offset after | F14: the earlier of two stops as near |
| past the end of a wrapped row is its last stop, with upstream affinity | F15: a press past a wrapped row has no affinity |
| above the block is the first row and below it the last | F13b: a point above every row is on the last |
| the span of the row a caret is on | F19: a row span starts at the text start |
| inside one row | F12: rows outside the selection get a rectangle |
| across a wrap: the upper row to its hanging space, the lower from its start | F12: rows outside the selection get a rectangle |
| a row whose Return is selected is wider by the break mark, and an empty selected line shows | F11: a selected Return adds nothing |
| everything | F41: a selection rectangle is as wide as nothing |
| Down and Up keep the column they set out from across a short row | F20: Up and Down forget their column |
| with no column remembered, the caret`s own x is the column | F10: xOn takes the stop before an exact one |
| Up on the first row goes to the start of the text, Down on the last to its end | F21: Up on the first row stays put |
| Up landing on the end of a wrapped row stays on that row | F27: Up landing on a wrapped row end loses its affinity |
| Home and End are the row`s ends; End on a wrapped row is upstream | F44: Home goes to the text start |
| Cmd+Left and Cmd+Right are Home and End; Cmd+Up and Cmd+Down the ends of the text | F23: Cmd+Up and Cmd+Down are not taken |
| Shift keeps the anchor in every one of them | F23: Cmd+Up and Cmd+Down are not taken |
| Left and Right step a grapheme, and collapse a selection to its near end | F25: Left and Right step from a selection instead of collapsing it |
| any other key is not ours | F26: any key is taken |
| the soft-line deletes take the row, not the paragraph | F46: a soft-line forward delete takes nothing |
| the hard-line deletes take the paragraph | F29: a hard-line delete takes the row |
| any other input is left to the browser`s own range | F30: every input is a line delete |
| one for one needs no map | F31: a map is made even when the lengths agree |
| the cased offset of every raw offset | F32: the cased offset counts raw lengths |
| a cased text that is not the letters cased one by one has no map | F33: the cased text is not checked against the letters |
| rows made in cased offsets, in raw ones: no stop between the two S | F32: the cased offset counts raw lengths |
| a wrap is still shared after the mapping | F32: the cased offset counts raw lengths |
| with no map the rows are themselves | F34b: rows without a map are copied |
| the run of the text that holds an offset: a word, the spaces, a mark, a Return | F40: a word is the old wordAt, not the segmenter |
| two presses: the run that starts at or holds the offset one press goes to | F16: the word at the end of the text is not clamped |
| two presses past the end of a row that wrapped select nothing: the caret, on that row | F17: two presses past a wrapped row select a word |
| three presses: the row, with the space it wrapped at, or with its Return | F18: three presses leave the Return out |
| three presses on an empty line select its Return | F18: three presses leave the Return out |

`src/lib/type-rows.engine.test.js` (23 tests, the real engine, real fonts, pixels)

| Test | Fails on |
|---|---|
| the built wasm has the export | E1: the adapter says the wasm has no lineCarets |
| without an engine that has it, there is no model and the box is typed into as DOM text | T14: canType is always true |
| a kerned pair: V stands closer to A than A`s advance | E2: the pen read from the offset column |
| a ligature: "fi" is one cluster, and the letter after it stands after it | F7: no division inside a cluster |
| letter spacing: every later glyph is that much further on | T3: the pens are asked for without letter spacing |
| letter spacing breaks the ligature, and each letter has its own stop on its own ink | T3: the pens are asked for without letter spacing |
| a synthesised bold: the stops are the wider advances the painter steps by | E4: the adapter drops the synthesis flags of a face |
| a real italic | T8: the pens of a plain face of the family |
| a letter borrowed from another family stands where its own advance puts it and the next after it | E3: the adapter drops the fallback chain of a face |
| uppercase: the caret is on the cased glyph | T13: the pens of the raw text, not the cased |
| left, letter spacing 0 | T17: every line starts 3 px right of where the painter starts it |
| left, letter spacing 9 | T18: a row ends a letter spacing short of the advance |
| center, letter spacing 0 | T1: a centred line starts at its anchor |
| center, letter spacing 9 | T1: a centred line starts at its anchor |
| right, letter spacing 0 | T2: a right-aligned line starts at its anchor |
| right, letter spacing 9 | T2: a right-aligned line starts at its anchor |
| each row is one of placeBlock`s lines, at its top, a line high | T1: a centred line starts at its anchor |
| a click on the middle of a letter`s left half is the offset before it, its right half the offset after | T7: stops from the line anchor, not the painter start |
| an empty box has its caret where a letter would start | T11: an empty line at x 0 |
| hidden spaces hang by the engine`s own space, letter spacing included | T6: a hidden space without the letter spacing |
| "ß" drawn as "SS": the stops either side of it are two glyphs apart, and none is between | T10: rows in raw offsets whatever the casing |
| the glyphs are the ones the painter is given | T16: the curve glyphs are a copy with x moved |
| a curved box with nothing in it is straight, as the painter has it: one row | T15: a curve is whatever has a curve in its style |

`src/lib/TextBox-engine-typing.dom.test.js` (27 tests, the component in jsdom)

| Test | Fails on |
|---|---|
| stays the canvas it was: the same element, not painted again, with the editable under it unseen | X2: the editable is seen |
| and is the same canvas, not painted again, when the edit ends with nothing typed | X33: the picture key changes with the edit |
| says nothing of its own to a screen reader: the text is in the document | X4: the canvas keeps its label while edited |
| keeps its flip, which with the switch off it drops for the caret | X5: the flip is dropped while typing |
| a warped box is not typed into as a picture: it is what it was before, the old paint and no editable | X3: a warped box is given a model |
| an engine that cannot say where a caret stands leaves the box the editable it is with the switch off | X31: the engine is wanted whatever the model |
| the first focus selects everything, and shows it: a rectangle a row, and no caret | X6: the caret shows with a selection |
| the caret stands at its offset's pen, as tall as its line, in zoomed px | X7: the caret is not zoomed |
| a row past the frame has a target of its own for the pointer | X8: no target past the frame |
| a press goes to the nearest stop of its row: the left half of a letter before it, the right half after | F13: a point is on a row only below its bottom |
| the press keeps the focus in the editable: its default is prevented | X9: the press on the picture is not prevented |
| a drag selects from where it began, and Shift extends from the anchor | X10: Shift does not extend a press |
| the second press of a double-click selects the word the caret went to, and ends the drag | X11: the second press leaves the drag going |
| the third selects the line of the picture it is on: the row, not the paragraph | X12: two presses select the row and three the word |
| the right button selects the word under it and steps aside for the system's menu, then comes back | X13: the overlay does not step aside for the menu |
| Down and Up keep their column across a shorter row, End and Home go to the row's ends | X15: the column is dropped after every key |
| End on a wrapped row stays on that row, and Right from there is one press to the next letter | X17: the keys forget the side of a wrap |
| a key with Alt or Control, and a key while an IME composes, is left to the browser | X16: a key with Alt or Control is taken |
| a letter typed is the box's text, and the same canvas is painted once more | X33: the picture key changes with the edit |
| a delete to the line's start is cut from the picture's row, on the side of a wrap the caret is on | X18: line deletes are the browser range |
| with something selected a line delete takes the selection, as the browser says | X18b: a line delete ignores a selection |
| what an IME composes is in the picture and underlined, and is the box's text only when it ends | X20: composed text is not held for the picture |
| the box becomes its text in the SAME editable, with its caret, and goes on being typed into | X26: the editable is made again when the picture comes or goes |
| a model that throws is the same: DOM text, nothing lost | X27: a model that throws is not caught |
| a curve is typed into on its picture: the marks on the painter's glyphs, the editable a ghost | X25: a curve has no targets on its glyphs |
| a curve whose casing makes a letter two is typed into on its picture all the same, a mark a drawn glyph | X24: a curve typed into is not a ghost |
| uppercase that makes a letter two: the caret after it stands after both | T10: rows in raw offsets whatever the casing |

`text-engine/tests/carets.rs` (7 tests, through the C ABI)

| Test | Fails on |
|---|---|
| a_letter_from_the_fallback_chain_stands_where_its_part_is_placed | R3: the face is asked for without its flags (synthesis, chain) |
| a_ligature_is_one_cluster_and_letter_spacing_breaks_it | R2: the line is shaped without letter spacing |
| a_synthesised_bold_moves_every_later_stop_under_the_webkit_rule | R3: the face is asked for without its flags (synthesis, chain) |
| an_empty_line_has_no_stop_and_no_advance | R5: the advance has the letter spacing added again |
| every_stop_is_the_pen_the_painter_places_the_glyph_at | R1: the pen is the glyph origin plus one |
| letter_spacing_follows_every_cluster_and_is_in_the_advance | R2: the line is shaped without letter spacing |
| offsets_are_utf16_units | R4: the length is in UTF-8 bytes |


## 6. Choices the brief did not make

1. **The editable is `opacity:0`**, not transparent ink (section 1.1).
2. **`overflow-anchor:none`** on it (item 6).
3. **Left and Right are taken** by the model, not left native (item 3).
4. **`ß` is mapped**, not sent back to DOM text (item 4).
5. **Double-click and triple-click** follow the rule measured in Chromium,
   Return and wrap space included (item 3).
6. **A selected Return** shows as a sliver 0.3 of the font size wide.
7. **The native caret is brought under the drawn one by measuring and
   moving** the editable (a transform), not by laying it out differently.
   Differences under 0.25 px are left.
8. **The right button** selects the word under it and the overlay steps
   aside for up to 1 s.
9. **A curve** keeps its own marks (`curve-caret.js`) on the painter's
   glyphs, with a pointer target a glyph, because an arc leaves its frame.
10. **Text that leaves the frame** (a long line, a trimmed Return's row) has
    a pointer target of its own (`typePad`).
11. **An engine without `mt_line_carets`** (an older wasm) leaves a box
    typed into as DOM text; nothing fails.
12. **One more paint when a composition ends**: the picture's key holds the
    shaped lines, which change at the commit. Accepted.
13. **The marks are not snapped to the device grid** as the picture is. At
    most half a device pixel between the two.
14. **Paste and cut in the check** are clipboard events carrying their own
    data. The system clipboard is the user's and is not read or written.
15. **The typing questions a browser can answer of itself** were added to
    the check page's `selfCheck`, so the WKWebView runner asks them too.
16. **`glyphAt`** (stage 2) was removed when the measured double-click rule
    replaced it.

## 7. What the brief asked that could not be met as written

- **"A fallback letter (kana in a Latin font)."** No font here has kana: 108
  faces in `tp-data/fonts/fonts.json` and the repository's fixture fonts
  were read with fontTools, 0 have kana or CJK (16 have Cyrillic). The
  fallback box borrows Greek and Cyrillic from the last-resort family and
  holds one kana that no font has. No font was added or downloaded.
- **The system WebKit.** `scripts/editor-check-webkit.swift` was built and
  run; it stopped at once with "the page is hidden": the display was asleep
  or locked for the whole session. So nothing here is measured in WKWebView.
  The typing questions are in place for it (below).

## 8. Not done

- The lower scale while typing (proposed in item 9).
- Double-click then drag by words; triple-click then drag by rows.
- Scrolling the page while a drag selection leaves the window.
- Per-clause marks of an IME.
- Any run in WKWebView, with a real IME, or with a pen.
- The default-mode scroll jump at edit start (item 6) is reported, not fixed.

## 9. What only the desktop app can show: a walk-through

Set the text engine to Rust in Settings first.

1. Double-click a balloon. Nothing should move. Everything is selected.
2. Click between two letters; drag; Shift+click; double-click a word;
   triple-click a line. Up and Down across a short line and back.
3. Type, Backspace, Option+Backspace, Cmd+Backspace on a wrapped line,
   Cmd+Z, Cmd+Shift+Z, Cmd+C, Cmd+X, Cmd+V.
4. **Japanese IME**: type `kana`, look where the candidate window opens (it
   should hang from the drawn caret), move through candidates, Return. In a
   box whose font has no kana the composing text shows as empty boxes: is
   that acceptable, or should composing text borrow a system font?
5. The same in a rotated box, a flipped box and on an arc.
6. **Autocorrect and text replacement**: type `teh `; type a replacement
   shortcut from System Settings. The word should change in the picture.
7. **Right-click** a word: is it selected, and does the menu offer Cut,
   Copy, Paste and spelling suggestions? Pick a suggestion.
8. **Dictation** and the **emoji picker** (Ctrl+Cmd+Space): do they open at
   the caret and insert?
9. **A pen**: tap to place the caret, drag to select. A pen press can end
   before the pointer is captured; the press should still place the caret.
10. A very large box at 300%: is typing sluggish enough to want the lower
    scale (item 9)?
11. With the display awake, the WebKit self-check:
    `npm run dev -- --port 5201 --strictPort`, then
    `swiftc scripts/editor-check-webkit.swift -o /tmp/editor-check-webkit`
    and `/tmp/editor-check-webkit http://127.0.0.1:5201 > webkit.json`. Read
    `typing` in it: `wrongOffset` should be 0 and
    `nativeCaret.worstCssPxFromDrawn` under 4 for each box. If
    `noRectangle` is not 0, WebKit gives a caret no rectangle at those
    offsets, the editable is not moved there, and the candidate window is
    then where the browser's own layout puts the caret (a few px off for a
    synthesised bold).

## 10. Final proofs

| Proof | Result |
|---|---|
| `./node_modules/.bin/vitest run` | 121 files passed, 1 skipped; 3,437 tests passed, 7 skipped (the baseline's 118 files and 3,339 tests, plus 3 files and 98 tests; the skips are the baseline's) |
| `cargo test` in `text-engine` | 103 passed, 0 failed, 6 binaries; `carets` 7 of 7 |
| `npm run build` | built |
| Default-mode capture `p7-sk` against `ref-sk/base` | only `manifest.json` differs (3,405 files) |
| Rust capture `p7-new` against `new/p6b-new2` | only `manifest.json` differs (3,736 files): no painted pixel moved |
| Editor check, 2x | `type verdict (2x): 1072 of 1072 checks passed, 0 failed`; page errors 0 |
| Editor check, 1x | `type verdict (1x): 1072 of 1072 checks passed, 0 failed`; page errors 0 |
| Capture runs | deleted after the comparison |
| Vite on 5203 | stopped |

Logs are in `node_modules/.cache/p7/`; reports and pictures in
`tp-data/reports/p7/`.

## 11. Commits

| Commit | What |
|---|---|
| `a890e59` | the plan, before the code (section 1) |
| `c3dd8c8` | the caret model as arithmetic on rows, with its unit tests |
| `58dbf2a` | `mt_line_carets` and its cargo tests |
| `01207f2` | rows from the painter's lines and pens, with the pixel proof |
| `8c01def` | the wiring in `TextBox.svelte` behind the switch, with its dom tests |
| `4f572da` | the browser's double-click and triple-click rule; targets on a curve's glyphs; the editable not painted |
| `8e21de8` | the check's `type` and `typecost` steps |
| `c761767` | the native caret found at a line's end and on an empty line |
| `d59b8a3` | the odd boxes in the check; the self-check's typing questions |
| `71c5dce` | the tests the mutation run asked for |
| this one | the report |
