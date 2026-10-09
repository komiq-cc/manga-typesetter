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
colour, no caret, no selection highlight, no pointer. `beforeinput` to
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
x of each. Rows are the drawn lines, plus one row for each Return the layout
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

While composing, the browser writes into the hidden element; the box's
text is not changed until the composition ends (as now). The picture and
the rows are made from the element's `textContent` meanwhile
(`composeText`, as curved text does today), and the composing range is
underlined.

### 1.6 What stays as it is

- `textEngine: 'browser'`: every new branch is behind `engineSwitch.painting`.
- A warped box: no caret through a mesh. It keeps the engine's picture
  while its text is edited from the Inspector, and has no marks, as today.
- A paint that throws: the box is DOM text for that key, typed into as
  today, by the same element.
