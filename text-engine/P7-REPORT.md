# P7: typing into a box that is a picture

Branch `tp/editor`, from `58369aa`. The brief is
`tp-data/briefs/p7-editor-typing.md`. This file is written in stages; section
1 was written before any code and is kept as the plan the code was held to.
Where the code ended up different, section 1 says so in a line marked
**Changed**.

A second round followed an outside review (brief
`tp-data/briefs/p7b-typing-fixes.md`): section 12. Lines of sections 1 to 11
that it made untrue are corrected in place and marked **Second round**; the
line numbers in every section are the final tree's.

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
    **Changed (second round).** Hard-line deletes take the row too: in the
    editable every drawn line is a block, so the system's "paragraph" is a
    drawn line, and WebKit sends Cmd+Backspace as `deleteHardLineBackward`
    (section 12, finding 2).
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

**Changed (second round).** A raw offset is a stop only where the RAW text's
graphemes allow one and its cased offset is exactly a stop of the cased row;
and a letter drawn as two with the line broken between the two keeps both
halves (section 12, findings 1 and 6).

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
**Second round.** The effect is made whenever the engine is drawing, not
only for an edit that began with it (section 12, finding 5).

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
| The one flag everything new is behind | `engineSwitch.painting`, read as `enginePaints`, `src/lib/TextBox.svelte:118` |
| The model is not made with the switch off | `typed` returns null first thing, `TextBox.svelte:119-120` |
| The overlay is not in the DOM | `{#if typeFlat}` and `typeCurve`, `TextBox.svelte:2701`, `2725` |
| The one new effect is made only while the engine is drawing (**second round**: not only for an edit begun with it) | a child of the editable's redraw effect, made inside `if (enginePaints)`, `TextBox.svelte:1875-1898`; what the teardown puts back is behind `if (!pictureEdit) return;`, `TextBox.svelte:1848`. With the switch off the flag is read, false, and nothing is made |
| The key budget (**second round**) | `keyed()` returns first thing unless the box is typed into as a picture, `TextBox.svelte:202-203`: no state set, no timer |
| The editable has no new attribute | `class:unseen={typing}` is false, `style` is `editStyle` as before, `TextBox.svelte:2759-2761` |
| New listeners | none on the editable. The overlay's are on the overlay. On a curve's overlay with the switch off the drag handlers are what they were (`!typing ||`, `TextBox.svelte:2125`) |

Proofs.

| Proof | Result |
|---|---|
| `src/lib/TextBox-switch-off.dom.test.js` (the DOM of a box with the switch off, at rest and typed into, against its stored snapshots; file not edited) | passes |
| Default-mode capture against `runs/ref-sk/base` (`p7-sk`; second round `p7b-sk`) | 3,405 files each, only `manifest.json` differs, both times |
| Editor check, existing steps, switch OFF, against `reports/p6-merged-2` at 1x and 2x (again on the final tree) | every leaf equal in `off`, `offBoxes`, `bytes`, `export`, `look`, `near`, `hits`, `limits`; `mask/off` differs only in the host of a blob URL (`localhost` then, `127.0.0.1` now); `costSynthetic`, `real` and `drag` differ only in timings |

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
| The export: per cluster, its UTF-16 offset and the pen of its first glyph, then the length and the advance | `mt_line_carets`, `text-engine/src/abi.rs:565`, a new function at the end of the file. It calls `paint::shape_run`, the painter's call for a straight run. `src/paint/` is not edited |
| JS adapter | `lineCarets`, `text-engine/js/engine.mjs:289`; `src/lib/text-engine/rust.js:235` |
| Rows from the painter's statements | `typeModel`, `src/lib/type-rows.js:97`: `placeBlock` (lines, `lineX`, `blockY`, `lineH`, so indent and the ink shift are the painter's), `editLines`, `linePens` |
| A line's start | `lineX[i] + alignOffset(align, advance)`, `type-rows.js:116`, the painter's own sum |
| The arithmetic | `src/lib/flat-caret.js` (no DOM, no engine) |
| Curves | the glyph list `placeBlock` gives the painter, `type-rows.js:107` |

Proofs.

| Proof | Result |
|---|---|
| `text-engine/tests/carets.rs`: every stop equals `shape_run`'s glyph x, through the C ABI | 8 tests pass (7, and the second round's on a size or a spacing that is no number) |
| Pixels (`type-rows.engine.test.js`, "in pixels"): a line is painted at 2x with and without each cluster; the first column that changes is the caret before it plus the cluster's own left bearing | within 1 device px for a kerned pair (`AVAVA`), a ligature (`fi` in DejaVu Sans), letter spacing, letter spacing breaking the ligature, a synthesised bold, a real italic, a borrowed letter (Cyrillic from DejaVu Sans in Comic Neue). Worst seen 0.8 device px, always the fraction a pixel column cuts off |
| The same test with every line started 3 px right of the painter's start (mutation T17) | 14 of 23 tests fail: the pixel test sees a 3 px drift |
| Browser: the canvas while typed into against `renderBoxTexture` of the same text | 0 bytes different, 13 boxes, at 60, 100 and 300%, at 1x and 2x |
| Browser: the drawn caret against the stop the model gives, after a real press | worst 0.012 CSS px at 2x, 0.024 at 1x (1,842 presses each) |

### Item 3. What the browser did for flat text

| Behaviour | Code | Rule |
|---|---|---|
| Caret at every raw offset, blinking, `--tintline`, as tall as the line | `typeMarks`, `TextBox.svelte:2230`; `.tcaret`, `src/styles.css:808` | `caretAt`, `flat-caret.js:205` |
| Selection, one rectangle a row | `selectionRects`, `flat-caret.js:215` | a selected Return adds a sliver 0.3 of the font size wide, so an empty selected line shows |
| Press, drag, Shift+press | `onTypePointerDown`, `TextBox.svelte:2279` | `offsetAt`, `flat-caret.js:255`: the nearest stop of the row level with the pointer, the later of two as near |
| Double-click | `onTypeMouseDown`, `TextBox.svelte:2335`; `wordPress`, `flat-caret.js:313` | measured in Chromium, below |
| Triple-click | `linePress`, `flat-caret.js:320` | measured in Chromium, below |
| A drag from the second or third press (**second round**) | the same drag, `TextBox.svelte:2296-2310`, `2341` | by words, by rows, as the browser does: section 12, finding 8 |
| Up, Down with a remembered column; Home, End; Cmd+Left, Right, Up, Down; Shift forms | `typeKey`, `TextBox.svelte:2417`; `moveCaret`, `flat-caret.js:355` | our rows |
| The keys a Mac binds to a move or a cut by lines: Control+A, E, N, P, F, B, V, K, Control+Left and Right, Option+Up and Down, Option+PageUp and PageDown (**second round**) | `boundKey`, `flat-caret.js:446`; `typeKey` | our rows: section 12, finding 2 |
| Left, Right | the same | one grapheme of the raw text. Taken, not left native: where a line wrapped the editable has two places for one offset and a native Right spent a press between them (the check counts 0 presses that did not move) |
| Word movement, word delete | left to the browser | logical order, no layout in it |
| Line deletes | `onEditBeforeInput`, `TextBox.svelte:1982`; `lineDeleteSpan`, `flat-caret.js:413` | our row, on the side of a wrap the caret shows on. **Second round:** the hard-line deletes take the row too (they took the paragraph), and a curve cuts to its paragraph's end (`curveCut`, `TextBox.svelte:2192`). No other `inputType` was found whose target range depends on layout |
| Ligatures and clusters | `bodyPens`, `flat-caret.js:150` (**second round**: one pass over the clusters; `penAt` searched them again for every letter) | even divisions of the cluster's advance, one a grapheme; no stop inside a grapheme (`graphemeBounds`, `type-rows.js:42`) |
| Wraps and trimmed Returns | `buildRows`, `flat-caret.js:65`; `rowOf`, `flat-caret.js:179` | section 1.3, rules 2 to 5: hidden spaces hang; a wrap's offset shows on the lower row unless the caret came there by End, by a press past the upper row's end, or by Up or Down; each trimmed Return has a row of its own |
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

Unit tests: `flat-caret.test.js` (62), `type-rows.engine.test.js` (26),
`TextBox-engine-typing.dom.test.js` (56). (48, 23 and 27 before the second
round.)

### Item 4. Uppercase

**Chosen: mapped properly.** `caseMap` (`flat-caret.js:473`) builds the cased
offset of every raw offset, letter by letter, and checks the result against
the cased text the painter is given. Rows are built in cased offsets and
carried to raw ones (`mapRows`, `flat-caret.js:533`), so no caret can stand
between the two S of one `ß`. Why: the fallback would make one German word
change how a whole box is typed into. If the check fails (a casing that is
not letter by letter) `typeModel` returns null and the box is DOM text
(`type-rows.js:106`); no such casing is known for `toUpperCase`.
**Second round:** the map no longer puts a stop inside a grapheme of the
text typed, and a `ß` whose two S are on two rows keeps both (section 12,
findings 1 and 6).

Tests: "casing that changes the length" in all three test files. Browser:
the `upper` box (`Straße` drawn `STRASSE`), 44 of 44 presses, all keys and
edits, at both densities. A curve with `ß` is typed into as a picture too
(dom test, 7 marks for 6 letters).

### Item 5. IME and the OS

| What | Where |
|---|---|
| Composed text is in the picture | `composeText` is in the picture's key and the paint reads a stand-in box, `TextBox.svelte:639-640`, `676`; `onEditInput`, `2013` |
| The composing span is underlined | `composeAt`, `composeSpan`, `TextBox.svelte:2220-2228`; `.tcomp`, `.ccomp` |
| The native caret is under the drawn one | `nativeCaret`, `alignNative`, `editShift`, `TextBox.svelte:2473-2530`. The editable is laid out as before and then moved by the measured difference, taken back through the turn and the flip |
| Places with no rectangle of their own | in front of a Return that starts its text node, the Return's own rectangle; on an empty line, its `<br>`'s (measured in Chromium; fixed in `c761767` after the self-check found them) |
| Autocorrect | `insertReplacementText` goes through `editSpan` (`getTargetRanges`) and `applyEdit` with `dataTransfer`, as it always did: `TextBox.svelte:1949`, `1968` |
| Right button | `typeMenu`, `TextBox.svelte:2356` (**second round**: on a curve too, and the editable has its own selection under the pointer) |

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
  **Second round:** while the overlay stands aside the editable is moved so
  that its own selection is under the pointer (section 12, finding 7).
- **On a curve** (**second round**) the right button takes the same path as
  on straight text. It did nothing before: the first round's line here, that
  a curve did what it does with the switch off, was untrue for an uppercase
  curve whose casing changes the length, which the switch off types into as
  flat DOM text.
- **Double-click then drag** (**second round**) extends by words, and
  triple-click then drag by rows. On a curve it does not: there the overlay
  is the switch-off one.

### Item 6. No jump

| What | Where |
|---|---|
| The canvas is the same element, not repainted, when the edit starts and ends | the picture's key does not hold `editing`; `engineWanted`, `TextBox.svelte:130` |
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
`TextBox.svelte:1530`).

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
(`TextBox.svelte:2701`, `2756`). A paint that throws sets `failed`; `typing`
goes false; the class `unseen` and the style change on the element that has
the focus. Nothing is replaced. A model that throws is caught and is the
same (`TextBox.svelte:124-128`). The input path is not forked: the same
handlers, with one line that swaps the range of a line delete
(`TextBox.svelte:1982`).

| Proof | Result |
|---|---|
| dom test "a picture that cannot be painted never takes the text with it" | the same element, caret kept, typing goes on, the picture returns |
| Browser, real keys: the painter made to refuse a `Q`; type `Q` mid-edit | the text holds the `Q`; the box is DOM text; focus kept, caret at 5; one console line; type `u`, caret 6; two Backspaces and it is its picture again, caret 4, 0 bytes |

### Item 9. Cost

**Second round: this item is rewritten.** The first round measured the six
rows below, found the large boxes over a frame (103.1 ms a key for the
effect box at 300%, 74.6 and 46.6 for the page-wide box) and proposed a
smaller pixel budget while keys are coming. That is built
(`TextBox.svelte:198-216`, `673`, `681`): a key marks the box as being typed
into for 150 ms; while it is, the picture is painted within the budget a
resize has (`PICTURE_DRAG_PX`, 1,048,576 px, where the full one is
8,388,608); 150 ms after the last key it is painted once in full, and at
once when the edit ends. A box under the smaller budget is painted exactly
as before. The marks are drawn from the rows, in page px, and do not move.

A keystroke's work is timed from the `beforeinput` to the end of its
effects (the paint, then a forced layout): 20 inserts and 20 deletes each,
median (min to max), ms. Chromium 155 headless, a real 2x display density.
A frame is 16.7 ms.

The machine was shared and loaded for the whole round, and the load moves
these figures more than the code does, so there are two runs. **Quiet** is a
run with the load average at 8 to 12, made straight after a run of the
FIRST round's tree (`a91a4f3`, served from a scratch copy; load average 11
to 15) so the two can be compared. **Final** is the run of the final proofs
(load average 20 to 37).

| Box | Zoom | Canvas at rest, and while keys come | First round's tree | Now, quiet | Now, final | Switch off, final |
|---|---|---|---|---|---|---|
| balloon, 220 x 110 | 100% | 0.11 MP, the same | 2.1 (1.7 to 2.8) | 2.2 (1.8 to 3.4) | 4.1 (3.1 to 5.1) | 0.9 (0.6 to 1.2) |
| balloon | 300% | 0.97 MP, the same | 3.9 (3.7 to 4.5) | 4.2 (3.5 to 7.1) | 7.7 (6.1 to 9.0) | 0.7 (0.5 to 1.2) |
| effect box (stroke, shadow, blur), 600 x 400 | 100% | 1.21 MP, 1.05 MP | 14.3 (13.0 to 15.5) | 15.3 (13.7 to 21.8) | 21.7 (18.9 to 25.7) | 1.3 (1.0 to 2.0) |
| effect box | 300% | 8.39 MP, 1.05 MP | 84.7 (62.4 to 163.5) | 14.9 (13.4 to 17.9) | 22.7 (21.4 to 25.0) | 1.2 (0.9 to 2.4) |
| page-wide, 1100 x 800 | 100% | 4.07 MP, 1.05 MP | 31.7 (27.8 to 41.6) | 12.5 (10.1 to 15.2) | 19.9 (18.0 to 21.6) | 0.9 (0.6 to 1.7) |
| page-wide | 300% | 8.39 MP, 1.05 MP | 87.5 (53.8 to 128.5) | 12.4 (11.0 to 18.6) | 19.5 (17.1 to 21.3) | 1.7 (0.9 to 2.1) |
| one line of 20,000 letters | 100% | 0.08 MP, the same | not in that check | 83.1 (73.7 to 104.0) | 108.7 (103.9 to 122.2) | 5.5 (2.7 to 11.8) |
| the long line | 300% | 0.08 MP, the same | not in that check | 110.2 (107.9 to 118.8) | 108.0 (103.7 to 117.8) | 5.7 (3.8 to 6.1) |

From real keys (12 letters and 12 Backspaces each), from the key heard by
the page: the first frame after it (median), and the key's own task
(median / max), ms.

| Box | Zoom | Now, quiet: frame; task | Now, final: frame; task | First round's tree: frame; task | Switch off, final: frame; task |
|---|---|---|---|---|---|
| balloon | 100% | 6.4; 10.3 / 21.1 | 10.8; 11.5 / 30.4 | 8.8; 9.3 / 17.8 | 1.4; 1.9 / 2.6 |
| balloon | 300% | 15.1; 15.7 / 23.0 | 10.0; 11.2 / 20.6 | 11.6; 12.9 / 21.6 | 1.3; 1.7 / 2.9 |
| effect box | 100% | 16.0; 16.6 / 33.3 | 25.4; 26.1 / 29.5 | 17.7; 18.2 / 25.3 | 8.1; 8.3 / 17.8 |
| effect box | 300% | 15.7; 16.1 / 27.6 | 25.8; 26.6 / 29.7 | 79.8; 80.2 / 112.4 | 1.5; 1.9 / 17.2 |
| page-wide | 100% | 14.5; 15.0 / 17.1 | 23.9; 24.6 / 28.2 | 39.6; 40.9 / 46.7 | 1.5; 1.7 / 3.7 |
| page-wide | 300% | 18.4; 19.1 / 24.4 | 22.8; 23.4 / 26.9 | 110.6; 111.4 / 130.3 | 1.9; 2.4 / 3.5 |
| the long line | 100% | 72.0; 72.9 / 88.6 | 115.1; 116.0 / 123.7 | not in that check | 5.2; 5.7 / 11.4 |
| the long line | 300% | 109.3; 110.5 / 117.2 | 106.1; 107.9 / 122.4 | not in that check | 4.9; 5.9 / 8.3 |

The paint alone (the box's texture made 7 times at each budget, median),
and what the full paint costs when an edit ends inside the pause (one
timing). Final run, ms.

| Box | Zoom | Full budget | Key budget | The edit ending inside the pause |
|---|---|---|---|---|
| balloon | 100% | 0.7 at 0.11 MP | 0.8 at 0.11 MP | 1.9 (nothing to paint) |
| balloon | 300% | 4.4 at 0.97 MP | 4.2 at 0.97 MP | 1.5 (nothing to paint) |
| effect box | 100% | 21.2 at 1.21 MP | 19.2 at 1.05 MP | 21.5 |
| effect box | 300% | 100.5 at 8.39 MP | 19.4 at 1.05 MP | 111.0 |
| page-wide | 100% | 45.4 at 4.07 MP | 16.3 at 1.05 MP | 49.1 |
| page-wide | 300% | 81.2 at 8.39 MP | 15.8 at 1.05 MP | 88.2 |
| the long line | 100% | 94.8 at 0.08 MP | 94.5 at 0.08 MP | 95.3 |
| the long line | 300% | 94.0 at 0.08 MP | 93.5 at 0.08 MP | 99.4 |

Reading them.

- **The balloon is not touched.** Its canvas is the same size at rest, while
  keys come and after the pause; its bytes straight after a key are
  `renderBoxTexture`'s (0 unlike, `type2` step); nothing is painted after
  the pause (dom test "a box under that budget is painted as it always was,
  once a key and never again"). Its time is the first round's tree's in the
  same conditions: 2.2 against 2.1 ms and 4.2 against 3.9 (the ranges
  overlap). The 4.1 and 7.7 of the final run are the load: the existing
  `costSynthetic` step, whose code this round did not touch, has medians
  1.9 times those of `reports/p6-merged-2` in the same run (**measured**
  ratio; that it is the load is **inferred**).
- **The large boxes.** The effect box at 300% is 14.9 ms where the first
  round's tree is 84.7 in the same conditions, and 103.1 in the first
  round's own table; the page-wide box 12.5 and 12.4 where it is 31.7 and
  87.5. After one key the canvas is 1.05 MP; after the pause it is the size
  it has at rest, and its bytes are `renderBoxTexture`'s.
- **Still over a frame, quiet run:** none of the six rows by its median
  (single keys were: the largest are 21.8 for the effect box at 100% and
  18.6 for the page-wide box at 300%). **Final run:** the effect box by 5.0 ms
  (100%) and 6.0 ms (300%), the page-wide box by 3.2 and 2.8 ms. Why: at a
  megapixel the effect box's paint alone is 19.2 to 19.4 ms in that run
  (a stroke, a shadow and a blur over every pixel of the budget), and the
  page-wide box's 15.8 to 16.3 ms, with 2.5 to 3.7 ms of other work a key.
  The budget is the one a resize has; a smaller one would be softer letters
  and was not asked for.
- **The long line is over a frame by 66 to 94 ms, and the budget cannot
  help it.** Its picture is 0.08 MP at either budget. Its paint is 69 to 95
  ms because it has 20,000 glyphs to shape and place, which is the painter's
  work (`text-engine/src/paint/`, not this task's to edit). The rows, which
  were this round's finding 3, are 5.3 to 7.0 ms of it (6.0 at 100% and 7.0
  at 300% in the final run). With the switch off the same key is 5.5 ms.
  A line of 20,000 letters is a paste, not a balloon.
- **The edit ending inside the pause** pays for the full paint once: 21.5 to
  111.0 ms, at the moment the edit ends.
- The balloon's 6 to 15 ms to the first frame is the wait for the display's
  next frame, not work, as in the first round (**inferred** from the work
  figure, which is the measured one).

At 1x, final run (load average 21 to 25), the same boxes cost 2.4, 3.2,
9.9, 19.8, 17.3 and 16.9 ms, and the long line 106.2 and 106.8. Only the
effect box at 300% (2.71 MP at rest) and the page-wide box at 300% (8.39
MP) are over the budget there; the page-wide box at 100% is 1.02 MP, under
it, and is painted as before (paint alone 13.3 ms). The first round's 1x
figures were 0.8, 1.2, 3.6, 18.4, 6.1 and 46.5 on a quieter machine; no 1x
run of the first round's tree was made beside this one.

Logs: `node_modules/.cache/p7b/final-2x.log`, `final-1x.log`,
`ab-typecost-first-round-tree.log`, `ab-typecost-this-tree.log`.

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

**Second round.** The tables below are the first round's run, on the first
round's tests. Four of those tests were rewritten in the second round
because the behaviour they held changed ("the hard-line deletes take the
paragraph", "a key with Alt or Control, and a key while an IME composes, is
left to the browser", "the second press of a double-click selects the word
the caret went to, and ends the drag", "the right button selects the word
under it and steps aside for the system's menu, then comes back"). The
second round's mutations are in section 12.4.

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
   aside for up to 1 s. **Second round:** for that time the editable is
   moved so that its own selection is under the pointer (choice 20).
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

Second round:

17. **The system's keys are taken only on a Mac keyboard** (`isMacKeyboard`).
    Elsewhere a key with Control or Alt is the browser's, as before:
    Control+A there is Select All.
18. **Every line delete takes the drawn row**, the ones that name a
    paragraph too: in the editable a paragraph is a drawn line, and it is
    what WebKit sends for Cmd+Backspace.
19. **Home and End stay the row's ends, and PageUp and PageDown the
    text's**, as in the first round and as Chromium has them. WebKit itself
    does nothing for Home, End and PageDown in an editable that does not
    scroll, and Shift+Home selects to the text's start (run in the key
    probe). Not changed: say if the app should follow WebKit here.
20. **For the system's menu the editable is moved under the pointer.** The
    menu is offered at the pointer and acts on what the editable has there.
    Without the move a right press on text outside the frame, or on a
    curve's letters, lands on something that is not the editable and the
    system collapses the selection (measured in Chromium, section 12,
    finding 7). The move lasts until the menu event or 1 s.
21. **A letter split across two rows is kept in the picture**, not sent back
    to DOM text: each row says which half it draws (`lead`, `trail`). Only a
    row that is nothing but the middle of one letter (no casing makes one)
    sends the box back to DOM text.
22. **The pause is 150 ms**, the budget the one a resize has
    (`PICTURE_DRAG_PX`). An undo and what an IME has in hand count as keys.
23. **A second pointer** neither moves nor ends a drag, and its press is
    ignored while the first is down. With the switch off a curve's handlers
    are left as they were (they do not tell pointers apart there either:
    default mode is not this task's to change).
24. **Control+T, Control+O, Control+D, Control+H** are left to the browser:
    what they change is at the caret's offset and no row is in it.

## 7. What the brief asked that could not be met as written

- **"A fallback letter (kana in a Latin font)."** No font here has kana: 108
  faces in `tp-data/fonts/fonts.json` and the repository's fixture fonts
  were read with fontTools, 0 have kana or CJK (16 have Cyrillic). The
  fallback box borrows Greek and Cyrillic from the last-resort family and
  holds one kana that no font has. No font was added or downloaded.
- **The system WebKit.** In the first round `scripts/editor-check-webkit.swift`
  stopped at once with "the page is hidden", and nothing was measured in
  WKWebView. **Second round: it runs.** The runner put its window off every
  screen, and this macOS (27) does not count such a window as visible, so
  its page got no frames; the display was not the cause. The window is now
  on the screen, transparent and behind the others (`7aa5245`). Its answer
  is in section 12.6.

## 8. Not done

Built in the second round, and so no longer here: the lower scale while
typing; double-click then drag by words and triple-click then drag by rows;
a run in WKWebView.

- Scrolling the page while a drag selection leaves the window.
- Per-clause marks of an IME.
- Any run with a real IME, with a pen, or with real keys in the desktop
  app's own window (the key probe and the self-check are WKWebView on this
  Mac, driven by events made for them).
- A drag by words or rows on a curve.
- The default-mode scroll jump at edit start (item 6) is reported, not fixed.
- With the switch off a curve's drag handlers do not tell pointers apart
  (the review's finding 4, in default mode): reported, not changed.
- A keystroke in a line of 20,000 letters is about 100 ms, the painter's
  (item 9).

## 9. What only the desktop app can show: a walk-through

Set the text engine to Rust in Settings first.

1. Double-click a balloon. Nothing should move. Everything is selected.
2. Click between two letters; drag; Shift+click; double-click a word;
   triple-click a line. Up and Down across a short line and back.
3. Type, Backspace, Option+Backspace, Cmd+Backspace on a wrapped line,
   Cmd+Z, Cmd+Shift+Z, Cmd+C, Cmd+X, Cmd+V. On a line that wrapped, with
   the caret in its middle: Control+A, Control+E, Control+K, Control+N,
   Control+P, Option+Up, Option+Down. Each should go by the line as drawn.
4. **Japanese IME**: type `kana`, look where the candidate window opens (it
   should hang from the drawn caret), move through candidates, Return. In a
   box whose font has no kana the composing text shows as empty boxes: is
   that acceptable, or should composing text borrow a system font?
5. The same in a rotated box, a flipped box and on an arc.
6. **Autocorrect and text replacement**: type `teh `; type a replacement
   shortcut from System Settings. The word should change in the picture.
7. **Right-click** a word: is it selected, and does the menu offer Cut,
   Copy, Paste and spelling suggestions? Pick a suggestion. The same on a
   curve, and on a word that hangs outside its frame.
8. **Dictation** and the **emoji picker** (Ctrl+Cmd+Space): do they open at
   the caret and insert?
9. **A pen**: tap to place the caret, drag to select. A pen press can end
   before the pointer is captured; the press should still place the caret.
10. A very large box at 300%: the letters are soft while keys come and
    sharp 150 ms after the last one. Is the pause right, and is the soft
    picture acceptable?
11. The WebKit self-check (it ran in the second round, section 12.6; a
    window appears, transparent, behind the others):
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

**Second round: this table is the final tree's.** (The first round's
figures were 3,437 tests, 103 Rust tests, 1072 of 1072.)

| Proof | Result |
|---|---|
| `./node_modules/.bin/vitest run` | 121 files passed, 1 skipped; 3,483 tests passed, 7 skipped, 0 failed |
| `cargo test` in `text-engine` | 104 passed, 0 failed (lib 36, `carets` 8, `fixtures` 27, `paint` 5, `paint_job` 28) |
| `cargo fmt --check` in `text-engine` | clean |
| `cargo clippy --all-targets -- -D warnings`, default features | clean |
| the same, `--no-default-features` | clean |
| the same, `--features raster-compare` | clean |
| `npm run build` | built |
| Default-mode capture `p7b-sk` against `ref-sk/base` | only `manifest.json` differs (3,405 files each) |
| Rust capture `p7b-new` against `new/p6b-new2` | only `manifest.json` differs (3,736 files each): no painted pixel moved |
| Editor check, 2x | `type verdict (2x): 1072 of 1072 checks passed, 0 failed`; `type2 verdict (2x): 84 of 84 checks passed, 0 failed`; page errors 0 |
| Editor check, 1x | `type verdict (1x): 1072 of 1072 checks passed, 0 failed`; `type2 verdict (1x): 84 of 84 checks passed, 0 failed`; page errors 0 |
| Editor check, existing steps, switch off, against `reports/p6-merged-2`, 1x and 2x | as in item 1: every leaf equal but timings and the blob URL's host |
| System WebKit self-check, start and end of the round | ran both times; `typing`: 13 boxes, 614 presses, 0 at a wrong offset, the native caret at most 0.23 CSS px from the drawn one, 0 places without a rectangle, 0 bytes between the picture and the exporter; `errors: []` |
| Capture runs | deleted after the comparison |
| Vite on 5203 | stopped |

The captures, the suite and the build were run at `d32b28f`. The one later
commit before this report (`a4859f3`) touches only the check script and the
check page, which neither the suite, the build nor the capture reads; the
suite and the build were run once more after it with the same figures.

The first whole 2x run of the check had one failure, in `type2`: "while
keys are coming it is painted within a megapixel" read 8.39 MP. The script
looked at the canvas over DevTools after the key, and on the loaded machine
that was later than the 150 ms pause, so it saw the full paint the app had
by then rightly made (0 bytes from the exporter). The reading is now taken
in the page at the first frame after the key (18 to 23 ms after it), and
the edit that ends inside the pause is ended there too (24 to 26 ms after a
key); `a4859f3`. Both densities then passed whole.

Logs are in `node_modules/.cache/p7/` and `node_modules/.cache/p7b/`;
reports and pictures in `tp-data/reports/p7/`.

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
| `a91a4f3` | the first round's report |
| `7aa5245` | second round: the WebKit runner's window is on the screen |
| `8b5ed0e` | `cargo fmt` |
| `acc5404` | findings 1, 6, 3: graphemes, the split letter, rows in one pass |
| `5b9d385` | finding 9: `mt_line_carets` refuses a size or a spacing that is no number; the JS check |
| `ecc6528` | finding 2, the model: the system's key table, line deletes by row |
| `bdff71c` | findings 2, 4, 5, 7, 8 and the large box, in the component |
| `3ee9828` | the menu: the editable's selection under the pointer |
| `92dada7` | the check's `type2` step |
| `59e8b58` | the cost step: the long line, the paint alone, the edit ending inside the pause |
| `d32b28f` | the tests the second mutation run asked for |
| `a4859f3` | the check reads the picture in the page, inside the pause |
| this one | the second round's report |

## 12. Second round

The brief is `tp-data/briefs/p7b-typing-fixes.md`: the formatter, nine
findings and five surviving mutations of an outside review (Codex, read
only; the end of `tp-data/reports/codex-p7-review.out`), the large box, and
the system WebKit. Every finding was reproduced on the first round's tree
before it was fixed. Figures are **measured** unless a line says
**inferred**.

### 12.1 The formatter

`cargo fmt` re-wrapped one `assert_eq!` of `text-engine/tests/carets.rs`
(`8b5ed0e`). `cargo fmt --check` and the three clippy runs are in the final
proofs (section 10).

### 12.2 The nine findings

**Finding 1. A caret stop inside a combining grapheme, or a surrogate pair.**

- Reproduced: yes, in Node (`node_modules/.cache/p7b/repro-model.mjs`, run
  on the first round's tree). Uppercase `ßá` (an `a` and U+0301): the raw
  stops were 0, 1, 2, 3, with 2 between the `a` and its accent.
- What was wrong: `mapRows` gave every raw offset the cased stop nearest
  it, so a boundary `buildRows` had left out of the cased text came back;
  the only place it knew to be inside a letter was a surrogate pair.
- Now: a raw offset is a stop of a row only when a caret may stand there in
  the RAW text (`bounds`, the raw text's graphemes, `type-rows.js:130`) and
  its cased offset is exactly a stop of the cased row
  (`flat-caret.js:536`, `548`). The same run now gives 0, 1, 3.
- Tests (`flat-caret.test.js`): "a letter and the mark it carries, after a
  letter cased to two: no stop between them"; "an emoji after a letter
  cased to two: no stop inside its pair of units".
- Mutations: S1, G1, G2.

**Finding 2. The keys macOS binds are left to the hidden editable.**

- Reproduced: yes. In the component: the new key tests run against the
  first round's `TextBox.svelte` fail, 7 of them
  (`node_modules/.cache/p7b/repro-component.log`). What the system sends was
  run in the system's own WKWebView (below).
- What was wrong: `typeKey` left every key with Option or Control to the
  browser, which did it by the editable's lines, with the editable's caret
  on the lower side of a wrap whatever the drawn one showed.
- Also wrong, found by the run and not in the review: the first round cut
  the PARAGRAPH for the hard-line deletes. WebKit sends Cmd+Backspace as
  `deleteHardLineBackward` naming the row, so in the app Cmd+Backspace on a
  wrapped line would have cut to the paragraph's start. (Chromium, which the
  first round's check ran in, sends `deleteSoftLineBackward`.)
- Now: `boundKey` (`flat-caret.js:445-459`) is the table of the system's
  keys whose result depends on a row, as keys of `moveCaret`; `typeKey`
  (`TextBox.svelte:2417-2433`) answers them from the picture's rows, on the
  side of a wrap the caret is drawn on, and prevents the key, so the system
  does nothing of its own (run: 33 keys with the keydown prevented, 0
  `beforeinput`, 0 moves of the selection). Option+Up and Down are
  `LineUp` and `LineDown` (`flat-caret.js:373`). Control+K cuts from the
  caret to the row's end through the same edit path as any delete, so undo
  holds it (`TextBox.svelte:2423-2427`). Every line delete the browser
  sends, soft or hard, is cut from the row (`lineDeleteSpan`,
  `flat-caret.js:413`; `TextBox.svelte:1982`). On a curve, which is one
  line, they are the curve's keys: the paragraph's ends, the text's ends,
  a cut to the paragraph's end (`curveKey`, `TextBox.svelte:2159`;
  `curveCut`, `2192`). Only on a Mac keyboard (`isMacKeyboard`,
  `shortcuts.svelte.js:39`), and never with the switch off.
- Tests: `flat-caret.test.js` "the keys a Mac binds to a move or a cut by
  lines" (4) and "the deletes that name a paragraph take the row too";
  `TextBox-engine-typing.dom.test.js` "the keys a Mac binds to a move or a
  cut by lines go by the picture's lines" (9), "on a keyboard that is not a
  Mac's ...". Browser (`type2`, each density): 24 keys and line deletes
  with the switch off and on, 21 the same in both; the other 3 are held to
  the row rule, because Chromium with the switch off names the same column
  of the next or the previous block for them (Control+K and Cmd+Delete
  `[7,12]`, the paragraph delete back `[2,7]`, where the row is `[7,10]` and
  `[5,7]`); 11 keys again from the upper side of a wrap.
- Mutations: S2, K1 to K17.

What macOS sends for each key. "Read" is the system's own table
(`/System/Library/Frameworks/AppKit.framework/Resources/StandardKeyBinding.dict`
on this Mac). "Run" is a probe in the system's WKWebView (macOS 27) with
the app's DOM for an editable (one block a drawn line), three rows of raw
offsets 0-5, 5-10, 10-14, the caret at 7, the key sent to the view as an
`NSEvent`: `tp-data/reports/p7/keyprobe.swift`, `keyprobe-default.txt`,
`keyprobe-prevent.txt`. The probe page is not the app.

| Key | The system's command (read) | What the page got (run) | Answered now by |
|---|---|---|---|
| Control+A | `moveToBeginningOfParagraph:` | a keydown; the caret to 5, the row's start | `Home` on our row |
| Control+E | `moveToEndOfParagraph:` | a keydown; the caret to 10 | `End` on our row |
| Control+P | `moveUp:` | a keydown; 2 | `ArrowUp` |
| Control+N | `moveDown:` | a keydown; 12 | `ArrowDown` |
| Control+F | `moveForward:` | a keydown; 8 | `ArrowRight` |
| Control+B | `moveBackward:` | a keydown; 6 | `ArrowLeft` |
| Control+Shift+A, E, N | the same, modifying the selection | a keydown; selection `[7,5]`, `[7,10]`, `[7,12]` | the same keys with Shift |
| Control+Shift+P, F, B, V | the same, modifying the selection | not run, read only | the same keys with Shift |
| Control+V | `pageDown:` | a keydown; 14, the text's end | `PageDown`: the text's end |
| Control+K | `deleteToEndOfParagraph:` | a keydown, then `beforeinput` `deleteContentForward` with the range `[7,10]` | a cut from the caret to our row's end; the keydown is prevented |
| Control+Left, Right | `moveToLeftEndOfLine:`, `moveToRightEndOfLine:` | a keydown; 5 and 10 | `Home`, `End` |
| Control+Shift+Left, Right | the same, modifying the selection | not run, read only | `Home`, `End` with Shift |
| Control+Up, Down | `scrollPageUp:`, `scrollPageDown:` | a keydown; no move | the browser's (no row in it) |
| Option+Up | `moveBackward:` then `moveToBeginningOfParagraph:` | a keydown; 5 | `LineUp`: one step back, then that row's start |
| Option+Down | `moveForward:` then `moveToEndOfParagraph:` | a keydown; 10 | `LineDown` |
| Option+Shift+Up, Down | `moveParagraphBackwardAndModifySelection:`, forward | a keydown; selection `[7,2]` and `[7,12]`: the same column of the row above and below | `ArrowUp`, `ArrowDown` with Shift |
| Option+PageDown | `pageDown:` | a keydown; 14 | the text's end |
| Option+PageUp | `pageUp:` | not run, read only | the text's start |
| Cmd+Backspace | `deleteToBeginningOfLine:` | `beforeinput` `deleteHardLineBackward`, range `[5,7]` | cut from our row (it was the paragraph) |
| Cmd+Forward Delete | none | a keydown; nothing | nothing to answer |
| Control+D | `deleteForward:` | `deleteContentForward` `[7,8]` | the browser's: one offset, no row in it |
| Control+H | `deleteBackward:` | `deleteContentBackward` `[6,7]` | the browser's |
| Control+T | `transpose:` | `insertText` over `[6,8]` | the browser's: its range is the two letters at the caret. An insert that carries no text does nothing (`edit-lines.js:241`) |
| Control+O | `insertNewlineIgnoringFieldEditor:` then `moveBackward:` | `insertParagraph` at 7, then the caret back one | the browser's |
| Control+Y, Control+L | `yank:`, `centerSelectionInVisibleArea:` | a keydown; nothing | nothing to answer |
| Home, End | `scrollToBeginningOfDocument:`, `scrollToEndOfDocument:` | a keydown; no move | the row's ends, as in the first round (choice 19) |
| Shift+Home | `moveToBeginningOfDocumentAndModifySelection:` | selection `[7,0]` | the row's start, with Shift (choice 19) |
| PageUp, PageDown | `scrollPageUp:`, `scrollPageDown:` | PageDown: a keydown; no move. PageUp not run | the text's ends, as in the first round (choice 19) |
| Option+Left, Right; Option+Backspace, Option+Forward Delete | `moveWordLeft:`, `moveWordRight:`, `deleteWordBackward:`, `deleteWordForward:` | not run in the probe (Option+Backspace is in the Chromium check) | the browser's, as in the first round: by the words of the text, no row in it |
| Control+Backspace | `deleteBackwardByDecomposingPreviousCharacter:` | not run, read only | the browser's: at the caret's offset |

Run in Chromium, by the editor command's name over DevTools, not by a real
system key: `DeleteToEndOfParagraph` arrives as `deleteHardLineForward`,
`DeleteToBeginningOfLine` as `deleteSoftLineBackward`, `DeleteToEndOfLine`
as `deleteSoftLineForward`, `DeleteToBeginningOfParagraph` as
`deleteHardLineBackward`. Which key Chromium itself maps to which command on
macOS was only read about. The app's window is WebKit.

**Finding 3. Rows take quadratic time on a long line.**

- Reproduced: yes, in Node on the first round's tree, this machine: 26 ms
  for 5,000 letters, 45 for 10,000, 161 for 20,000, 479 for 40,000 (the
  review's own run: 624 ms and 2.65 s).
- What was wrong: `penAt` searched the clusters back from the last one for
  every offset, and `xOn` walked the stops.
- Now: `bodyPens` makes a line's pens in one pass over its clusters
  (`flat-caret.js:150`); `xOn` and `stopNear` search by halves (`193`,
  `268`). The same run: 4.8 ms for 20,000 and 2.6 ms for 40,000. In the
  browser the rows of the 20,000 letter line are 6.0 to 7.0 ms.
- Test: "its rows are made in one pass over its clusters, not one pass a
  letter" (it counts the reads of the cluster list). Mutation: Q1.
- The long line is in the cost table (item 9). Its keystroke is still about
  100 ms, which is its paint and not its rows.

**Finding 4. Drag handlers do not tell pointers apart.**

- Reproduced: yes, in the component (first round's `TextBox.svelte`): a
  second pointer's move changed the selection from `[1,1]` to `[1,13]`, and
  its release ended the first pointer's drag.
- What was wrong: the handlers on the overlay acted on any pointer's event.
- Now: a drag knows its pointer (`TextBox.svelte:2295`); its move and its
  end are that pointer's alone (`2297`, `2313`); another pointer's press
  while it is down is not a press of the text (`2282`); it ends on that
  pointer's `pointerup`, `pointercancel` or `lostpointercapture`
  (`2325-2328`), and when the edit ends (`1852`). On a curve that is a
  picture the same (`2125`); with the switch off a curve's handlers are as
  they were.
- Tests: "a drag is the pointer's that began it" (3). Browser: a drag that
  leaves the picture goes on selecting, `[2,6]` then `[2,23]`. A second
  pointer cannot be made over DevTools' mouse, so that part is the
  component test's alone.
- Mutations: P1 to P5, S4.

**Finding 5. The native caret is not aligned when the engine comes on
during an edit.**

- Reproduced: yes, in the component: the engine switched on in the middle of
  an edit left the editable with no transform; an edit begun with it had
  one.
- What was wrong: the effect was made only if the edit BEGAN with the
  engine drawing (a value read once).
- Now: it is a child of the editable's redraw effect, which reads the flag,
  so it is made whenever the engine is drawing and unmade when it is not
  (`TextBox.svelte:1875-1898`). The reverse: a box that stops being a
  picture in the middle of an edit (the paint throws, the model has no
  answer) has the distance taken back (`1878-1885`), and so has the switch
  going off (`1899-1904`) and the edit ending (`1848-1858`).
- Tests: "the editable's own caret is kept under the drawn one" (4).
  Browser (`type2`, the synthesised bold): the engine switched on in the
  middle of an edit, the native caret is 0 px from the drawn one and the
  editable is moved by `translate(2.92969px, 0.898439px)`, the same as in an
  edit begun with it; switched off again, its style is the switch-off one,
  `translateY(0.655px)`.
- Mutations: A1, A2, A3, S3.

**Finding 6. A letter drawn as two, with the line broken between the two.**

- Reproduced: yes, in Node on the first round's tree: with `ß` drawn `SS`
  and the rows `AS` and `SB`, the selection of the `ß` was one rectangle
  (the first S), and a press on the first S's right half put the caret for
  "after the ß" at the end of the upper row, between the halves. The real
  engine makes the split (`aßb`, uppercase, 40 px, a 60 px box, plain
  wrapping).
- What was wrong: the upper row was given the offset after the letter as a
  stop it shared with the lower row.
- Now: fixed in the picture, not sent back to DOM text. Neither row has a
  stop on that side. The upper row says where its half ends and the offset
  after the whole letter (`trail`), the lower where its half starts and the
  offset before it (`lead`): `flat-caret.js:554-555`. A selection of the
  letter covers both halves (`227-228`); a press on a half goes to the
  nearer side of the whole letter (`263-264`); three presses take the row
  with the whole letter; the upper row is not shared. A row that would be
  nothing but the middle of one letter has no stop: `mapRows` answers null
  (`552`) and the box is typed into as DOM text (`type-rows.js:131`); no
  casing known makes one.
- Tests: `flat-caret.test.js` "a letter drawn as two, and the line broken
  between them" (7); `type-rows.engine.test.js` "the real breaker makes it,
  and neither row has a caret between the halves". Browser (`type2`, box
  `split`): lines `AS` and `SB`; the `ß` selected is two marks; the carets
  for offsets 1 and 2 stand at the start of the first S and the end of the
  second, none at the two places between; a press right of the first S is
  offset 2 and one left of the second S offset 1; an `x` typed there makes
  `aßxb`.
- Mutations: L1 to L12.

**Finding 7. An uppercase curve whose casing changes length has no menu.**

- Reproduced: yes, in the component: the right button on such a curve left
  the selection `[1,1]` and the overlay in the way.
- What was wrong: the curve's overlay ignored every button but the left.
  With the switch off such a box is flat DOM text and has the system's menu.
- Now: the right button on a curve that is a picture takes the path
  straight text has (`TextBox.svelte:2114`, `typeMenu`, `2356-2401`): the
  word under the nearest glyph is selected unless the press is on the
  selection, and the overlay steps aside (`styles.css:816-817`).
- One thing more was needed, for straight text too. The system offers its
  menu at the pointer and acts on what the editable has THERE, and the
  hidden editable's letters are not where the picture's are: a curve's are
  in a straight line, and text outside the frame is clipped. Measured in
  Chromium: a right press on a word outside the frame had the box layer
  for its target, not the editable, and the selection collapsed. So while
  the overlay stands aside the editable is moved to put its own selection's
  rectangle under the pointer (`menuShift`, `TextBox.svelte:2378-2386`,
  through the box's turn and flip, `2498`), is not clipped (`styles.css:817`),
  and is put back, its caret under the drawn one again, after the menu event
  or 1 s (`2387-2396`). The caret's alignment stands still meanwhile
  (`2504`).
- Tests: "the right button on a curve that is a picture" (2), "while the
  editable is moved for the menu its caret is not brought back" (1).
  Browser (`type2`): on `upper-arc` (`STRASSE ÜBER UNS`, a mapped curve) the
  `contextmenu` event's target is in the editable, it is not prevented, the
  selection is `[7,11]` and the pointer is on it; on `spill` (22 of 26
  letters outside the frame) the word `SIDEWAYS`, on `arc-out` (5 of 18
  outside) `ALONG`, each in the editable and under the pointer.
- Mutations: C1 to C5.
- Not run: the system's menu itself. A headless Chromium shows none, and
  what WebKit's menu offers there is in the walk-through (section 9, 7).

**Finding 8. A double-click or triple-click cannot be extended by
dragging.**

- Reproduced: yes (the review read it from the code): in the component a
  drag after the second press left `[5,8]`.
- Built: the drag the press began goes on, by words after two presses and
  by rows after three (`TextBox.svelte:2341`, `2302-2309`): from the far end
  of the word or row the press took to the far end of the one under the
  pointer; back inside it, the word or row itself.
- Tests: "and a drag from there goes by words, the word the press took
  staying selected"; "a drag from the third press goes by rows of the
  picture". Browser (`type2`, each density): six stations of a drag from a
  double press select `[5,8]`, `[5,11]`, `[8,0]`, `[5,22]`, `[5,8]`,
  `[5,8]`, and the spans are the browser's own for the same drag with the
  switch off; a drag from a triple press down and up selects the rows the
  browser selects.
- Mutations: D1 to D4.
- Not built: the same on a curve.

**Finding 9. `mt_line_carets` answers success with NaN.**

- Reproduced: yes: the cargo test written first failed with `left: 1`,
  `right: -5` (`node_modules/.cache/p7b/repro-9.log`).
- Now: a size or a letter spacing that is not finite is `BadSpec`, as the
  other exports answer a bad number (`text-engine/src/abi.rs:572`, in the
  function at the end of the file). In JS a position, an offset or an
  advance that is not finite is thrown on (`linePens`, `type-rows.js:58-66`),
  which leaves the box typed into as DOM text.
- Tests: `carets.rs`
  `a_size_or_a_spacing_that_is_no_number_is_an_error_and_not_a_line_of_them`;
  `type-rows.engine.test.js` "a size or a spacing that is no number is
  refused by the engine, not answered with positions that are none" and "an
  engine that answers with a position that is no number is not believed".
- Mutations: R1, R2, N1, N2.

### 12.3 The five surviving mutations of the review

| Mutation | The test that fails on it | Lane |
|---|---|---|
| S1. The duplicate-mapping skip removed (`ß😀`) | "an emoji after a letter cased to two: no stop inside its pair of units" | unit |
| S2. No override for `deleteSoftLineForward` | "a delete to the line's END is cut from the picture's row too, and so is one that names the paragraph"; and `type2` Cmd+Delete, held to the row | component, browser |
| S3. The vertical flip not taken out in `flipDelta` | "by the distance between them, taken through the box's flip" (a box flipped top to bottom) | component |
| S4. `setPointerCapture` removed | "the press takes the pointer for itself, so the drag follows it off the picture; a pointer that cannot be taken still places the caret"; and `type2`, the drag that leaves the picture | component, browser |
| S5, S6. No reset of `edUp`; of `goalX` | "no side of a wrap is kept: the caret shows where the browser has it"; "no column is kept: Up goes by where the caret now is" | component |

Each was run in the scratch copy; each fails exactly the test named
(`S1` to `S6` in the table below). The browser checks named beside them
were not run against the mutated tree.

### 12.4 Mutations of the second round

Run in a scratch copy (`mutate2.mjs`, its results and logs are in the
session's scratch directory, not the repository). 67 mutations of
`flat-caret.js`, `type-rows.js` and `TextBox.svelte` against the three test
files (144 tests, 0 failing unmutated), and 2 of `mt_line_carets` against
`cargo test --test carets`. Every one fails at least one test. The first
pass left four alive (L3, K6, K7, C5); a test was added for each
(`d32b28f`) and they were run again. One more candidate was dropped as no
mutation at all: `typeModel` passing no raw graphemes to `mapRows` changes
nothing the real engine can make, because the cased text's own graphemes
and the exact match of stops already leave the same offsets out
(**inferred** from the two rules; the unit test G1 holds the raw rule
itself).

| Id | Mutation | Tests failing | The first of them |
|---|---|---|---|
| S1 | (review a) the duplicate-mapping skip is removed | 1 | casing that changes the length an emoji after a letter cased to two: no stop inside its pair of units |
| S2 | (review b) no override for deleteSoftLineForward | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines a delete to the line's END is cut from the picture's row too, and so is ... |
| S3 | (review c) the vertical flip is not taken out of the caret's distance | 1 | the editable's own caret is kept under the drawn one by the distance between them, taken through the box's flip |
| S4 | (review d) the press does not take the pointer | 1 | a drag is the pointer's that began it the press takes the pointer for itself, so the drag follows it off the picture; a pointer that cannot be take... |
| S5 | (review e) a native selection does not reset the side of the wrap | 1 | a selection the browser moved itself starts again no side of a wrap is kept: the caret shows where the browser has it |
| S6 | (review e) a native selection does not reset the column | 1 | a selection the browser moved itself starts again no column is kept: Up goes by where the caret now is |
| G1 | the raw text's graphemes are not asked | 1 | casing that changes the length a letter and the mark it carries, after a letter cased to two: no stop between them |
| G2 | a raw offset is given the nearest cased stop, as it was | 1 | casing that changes the length a letter and the mark it carries, after a letter cased to two: no stop between them |
| L1 | no trailing half | 6 | casing that changes the length a letter drawn as two, and the line broken between them neither row has a stop between the halves, and nothing is sh... |
| L2 | no leading half | 5 | casing that changes the length a letter drawn as two, and the line broken between them neither row has a stop between the halves, and nothing is sh... |
| L3 | the leading half names the offset inside the letter | 1 | casing that changes the length a letter drawn as two, and the line broken between them a letter of two units drawn as three, split: the half on the... |
| L4 | a row with a trailing half is still soft | 4 | casing that changes the length a letter drawn as two, and the line broken between them neither row has a stop between the halves, and nothing is sh... |
| L5 | the selection leaves out the leading half | 2 | casing that changes the length a letter drawn as two, and the line broken between them the letter selected is both its halves |
| L6 | the selection leaves out the trailing half | 2 | casing that changes the length a letter drawn as two, and the line broken between them the letter selected is both its halves |
| L7 | a press on the trailing half goes to the row's last stop | 1 | casing that changes the length a letter drawn as two, and the line broken between them a press on a half goes to the nearer side of the whole letter |
| L8 | a press on the leading half goes to the row's first stop | 1 | casing that changes the length a letter drawn as two, and the line broken between them a press on a half goes to the nearer side of the whole letter |
| L9 | three presses leave the split letter out (start) | 1 | casing that changes the length a letter drawn as two, and the line broken between them three presses take the row with the whole letter; Down lands... |
| L10 | three presses leave the split letter out (end) | 1 | casing that changes the length a letter drawn as two, and the line broken between them three presses take the row with the whole letter; Down lands... |
| L11 | Down lands on the nearest stop of ANY row | 1 | casing that changes the length a letter drawn as two, and the line broken between them three presses take the row with the whole letter; Down lands... |
| L12 | a row with no stop is kept | 1 | casing that changes the length a letter drawn as two, and the line broken between them a row that is nothing but the middle of one letter has no st... |
| Q1 | the pens of a line are made again for every letter | 1 | a line as long as a paste makes it its rows are made in one pass over its clusters, not one pass a letter |
| K1 | Control+A is End | 5 | the keys a Mac binds to a move or a cut by lines Control with a letter is the key the system binds it to, and Shift extends |
| K2 | Control+Shift+K is a cut | 2 | the keys a Mac binds to a move or a cut by lines Control with a letter is the key the system binds it to, and Shift extends |
| K3 | Cmd with Control is taken | 2 | the keys a Mac binds to a move or a cut by lines anything else is the browser`s |
| K4 | Option+Shift+Up is the step and the row's start | 2 | the keys a Mac binds to a move or a cut by lines Option+Up and Down are a step and a row`s end; with Shift, Up and Down; Option+PageUp and PageDown... |
| K5 | the step back is looked for on the upper side | 1 | the keys a Mac binds to a move or a cut by lines a step and then the end of the row arrived at (Option+Up, Option+Down) |
| K6 | the step on is looked for on the lower side | 1 | the keys a Mac binds to a move or a cut by lines a step and then the end of the row arrived at (Option+Up, Option+Down) |
| K7 | Option+Up steps from the focus of a selection | 1 | the keys a Mac binds to a move or a cut by lines a step and then the end of the row arrived at (Option+Up, Option+Down) |
| K8 | a delete that names the paragraph goes to the paragraph's start | 2 | line deletes are cut from our rows the deletes that name a paragraph take the row too: in the editable a paragraph is a drawn line |
| K9 | a forward delete that names the paragraph is the browser's | 3 | line deletes are cut from our rows the deletes that name a paragraph take the row too: in the editable a paragraph is a drawn line |
| K10 | the keys are taken on any keyboard | 1 | the keys that go by lines go by the picture's lines on a keyboard that is not a Mac's a key with Alt or Control, and anywhere a key while an IME co... |
| K11 | a key with Option or Control is never taken | 6 | the keys a Mac binds to a move or a cut by lines go by the picture's lines Control+E and Control+A are the row's ends, on the side of a wrap the ca... |
| K12 | Control+K with a selection cuts to the row's end | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines Control+K cuts to the row's end, the row the caret is drawn on |
| K13 | Control+K forgets the side of the wrap | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines Control+K cuts to the row's end, the row the caret is drawn on |
| K14 | a curve takes the keys with the switch off too | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines with the switch off none of it is taken, on straight text or on a curve |
| K15 | a curve never takes them | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines on a curve that is a picture they are the curve's keys: the paragraph's ... |
| K16 | Option+Down on a curve does not step first | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines on a curve that is a picture they are the curve's keys: the paragraph's ... |
| K17 | a line delete on a curve is the hidden editable's | 1 | the keys a Mac binds to a move or a cut by lines go by the picture's lines on a curve that is a picture they are the curve's keys: the paragraph's ... |
| P1 | any pointer moves the drag | 1 | a drag is the pointer's that began it another pointer moving over the picture, or let go, neither moves the selection nor ends the drag |
| P2 | any pointer ends the drag | 1 | a drag is the pointer's that began it another pointer moving over the picture, or let go, neither moves the selection nor ends the drag |
| P3 | a second pointer's press takes the drag over | 1 | a drag is the pointer's that began it another pointer moving over the picture, or let go, neither moves the selection nor ends the drag |
| P4 | on a curve any pointer is the drag's | 1 | a drag is the pointer's that began it on a curve that is a picture too |
| P5 | losing the pointer does not end the drag | 1 | a drag is the pointer's that began it the press takes the pointer for itself, so the drag follows it off the picture; a pointer that cannot be take... |
| D1 | the second press ends the drag | 2 | the pointer on the picture and a drag from there goes by words, the word the press took staying selected |
| D2 | a drag backwards keeps the anchor at the word's start | 2 | the pointer on the picture and a drag from there goes by words, the word the press took staying selected |
| D3 | a drag forwards goes to the unit's start | 2 | the pointer on the picture and a drag from there goes by words, the word the press took staying selected |
| D4 | back inside the word the selection stays where the drag left it | 2 | the pointer on the picture and a drag from there goes by words, the word the press took staying selected |
| C1 | the right button on a curve does nothing | 2 | the right button on a curve that is a picture selects the word under it and steps aside for the system's menu, as on straight text - a curve with a... |
| C2 | the editable is not moved under the pointer | 1 | the right button on a curve that is a picture for as long as it stands aside the editable has its own selection under the pointer, and is put back ... |
| C3 | the move is not taken through the flip | 1 | the right button on a curve that is a picture for as long as it stands aside the editable has its own selection under the pointer, and is put back ... |
| C4 | the editable is left where the menu had it | 1 | the right button on a curve that is a picture for as long as it stands aside the editable has its own selection under the pointer, and is put back ... |
| C5 | the caret's alignment undoes the move for the menu | 1 | while the editable is moved for the menu its caret is not brought back a selection changing under the menu leaves the editable where the menu has it |
| A1 | the alignment is made only if the edit began with the engine | 1 | the editable's own caret is kept under the drawn one and is when the engine comes on in the middle of an edit, as in one begun with it |
| A2 | the switch going off keeps the distance | 1 | the editable's own caret is kept under the drawn one nothing of it is left when the switch goes off in the middle of an edit, or the paint fails |
| A3 | a picture that stops being painted keeps the distance | 1 | the editable's own caret is kept under the drawn one nothing of it is left when the switch goes off in the middle of an edit, or the paint fails |
| B1 | a key's paint has the full budget | 3 | while keys are coming a large box is painted within a smaller budget and once in full, 150 ms after the last key; the marks do not move with it |
| B2 | the pause does not paint in full | 3 | while keys are coming a large box is painted within a smaller budget and once in full, 150 ms after the last key; the marks do not move with it |
| B3 | every box is painted again after the pause | 1 | while keys are coming a large box is painted within a smaller budget a box under that budget is painted as it always was, once a key and never again |
| B4 | the edit ending does not settle the keys | 2 | while keys are coming a large box is painted within a smaller budget the edit ending inside the pause paints it in full at once, and leaves no timer |
| B5 | the pause is ten times as long | 4 | while keys are coming a large box is painted within a smaller budget and once in full, 150 ms after the last key; the marks do not move with it |
| B6 | a key sets the timer with the switch off | 1 | while keys are coming a large box is painted within a smaller budget with the switch off a key sets no timer |
| B7 | what an IME has in hand is not a key | 1 | while keys are coming a large box is painted within a smaller budget an undo is a key, and so is what an IME has in hand: the composition is painte... |
| B8 | an undo is not a key | 1 | while keys are coming a large box is painted within a smaller budget an undo is a key, and so is what an IME has in hand: the composition is painte... |
| B9 | a key does not start the pause again | 1 | while keys are coming a large box is painted within a smaller budget and once in full, 150 ms after the last key; the marks do not move with it |
| B10 | the paint in full is made while keys are still marked as coming | 3 | while keys are coming a large box is painted within a smaller budget and once in full, 150 ms after the last key; the marks do not move with it |
| N1 | an answer with a position that is no number is believed | 1 | the engine can say where a caret stands an engine that answers with a position that is no number is not believed |
| N2 | only the advance is looked at | 1 | the engine can say where a caret stands an engine that answers with a position that is no number is not believed |
| R1 | `mt_line_carets` does not look at the size | 1 | a_size_or_a_spacing_that_is_no_number_is_an_error_and_not_a_line_of_them (`cargo test --test carets`) |
| R2 | `mt_line_carets` does not look at the letter spacing | 1 | the same test |

### 12.5 The large box

Built as proposed (item 9, which has the tables). The proofs asked for:

| Asked | Proof | Result |
|---|---|---|
| The cost table again, all six rows, both tables | item 9 | there, with the long line |
| The balloon untouched: the same bytes while typing | `type2`: the balloon's canvas straight after a key against `renderBoxTexture`; dom test "a box under that budget is painted as it always was, once a key and never again" | 0 bytes unlike; 0.969 MP at rest, after a key and after the pause (2x; 0.242 MP at 1x); one paint a key, none after the pause |
| The sharp paint after the pause is `renderBoxTexture`, byte for byte | `type2`, box `big` at 300% | 8.391 MP at rest, 1.049 MP at the frame after a key, 8.391 MP after the pause, 0 bytes unlike (1x: 3.128, 1.049, 3.128, 0) |
| The marks do not move | `type2`: the caret's rectangle after the key and after the full paint; dom test "... the marks do not move with it" | equal to 0.01 px |
| A composition keeps working | `type2`: `imeSetComposition` in the large box, a pause with the composition open, then the commit; dom test "an undo is a key, and so is what an IME has in hand ..." | at 2x: 1.049 MP while composed, 8.391 MP after the pause from the composed text (0 bytes unlike), still underlined and not yet the box's text; committed text and picture right (1x: 1.049 then 3.128 MP, 0 bytes unlike) |
| No timer left when the edit ends | `type2`: the edit ended in the page 24 to 26 ms after a key; dom test "the edit ending inside the pause paints it in full at once, and leaves no timer" | 1.049 MP then 8.391 MP at once, 0 bytes unlike; no 150 ms timer left |
| No timer left when the box is deleted | dom test "a box deleted inside the pause leaves no timer either" | none left |
| With the switch off | dom test "with the switch off a key sets no timer" | none set |

Mutations: B1 to B10.

### 12.6 The system WebKit

`scripts/editor-check-webkit.swift` was run at the start of the round and
at the end. At the start it answered "the page is hidden", as it had for the
coordinator. Why: the runner placed its window off every screen, and this
macOS does not count such a window as visible, so WebKit gave its page no
frames. The screen was not locked and the display was awake. The window is
now on the screen, transparent and ordered behind the others, and nothing
is needed of anyone at the machine (`7aa5245`). It then ran, both times,
with the same answer.

Its `typing` part, at the end (`tp-data/reports/p7/webkit-end.json`;
AppleWebKit 605.1.15, display density 2):

| Question | Answer, all 13 boxes |
|---|---|
| While typed into | the engine's canvas, the overlay (flat; a curve's on the arc), the editable unseen and focused |
| The canvas moved at edit start | no |
| The picture against the exporter | 0 bytes unlike |
| Presses at both halves of every letter | 614 in all, 0 at a wrong offset |
| The native caret from the drawn one | at most 0.23 CSS px (0.13 to 0.23 a box; 0 on the arc) |
| Places where WebKit gives a caret no rectangle | 0 |
| A key taken by the model | yes |
| A letter typed | in the text, the picture 0 bytes from the exporter; the text back after it is taken out |
| `errors` | `[]` |

So the first round's statement that nothing was measured in WKWebView no
longer holds (section 7). What is still not measured there is in 12.8.

### 12.7 Found on the way

- WebKit sends Cmd+Backspace as `deleteHardLineBackward` (finding 2). Fixed.
- Chromium with the switch off, for a forward line delete and for the
  paragraph delete back, names the same column of the next or the previous
  block of the editable, not the row. The check holds those three to the
  row rule and compares the other 21 with the switch off.
- The check read the picture too late on a loaded machine (section 10).
  Fixed in the check; the app was right.
- With the switch off a curve's drag handlers do not tell pointers apart.
  Default mode: reported, not changed.
- Home and End: section 6, choice 19.
- With typesetting off, or `shape: 'off'`, the plain wrapper's own
  `placeBlock` takes 258 ms for one line of 20,000 letters and 1,273 ms for
  40,000 (Node, measured once on the loaded machine). It is the layout's,
  in both modes, and not this task's.

### 12.8 What could not be run

- Real keys in the desktop app's own window. The key table's "run" column
  is a probe page in WKWebView with events made for it; Control+Shift+P, F
  and B and Option+PageUp were only read in the system's table.
- Which key Chromium maps to which editing command on macOS (read about).
- The system's context menu itself, in either browser.
- A second pointer in a browser (the component test has it).
- A real IME, a pen, dictation, the emoji picker.
- The first round's tree at 1x beside this one (the 2x pair is in item 9).
- The five review mutations and the round's 69 were run against the unit and
  component tests, not against the browser check.
