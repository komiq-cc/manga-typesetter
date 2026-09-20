# Manga Typesetter: How To

Manga Typesetter puts translated lettering into speech balloons. It runs on a
laptop, handles chapters with hundreds of pages, and stays under a gigabyte of
memory by offloading to disk.

Public beta. It works and is in daily use, but expect rough edges.

## Contents

- [Home screen](#home-screen)
- [Editor](#editor)
  - [Modes](#modes)
  - [Fit to balloon](#fit-to-balloon)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Text box options](#text-box-options)
  - [Typesetting defaults](#typesetting-defaults)
  - [Queue, tags and fonts](#queue-tags-and-fonts)
- [Detection](#detection)
- [Export](#export)
- [Chapter packages (.mtchapter)](#chapter-packages-mtchapter)

## Home screen

A **project** is a series. Chapters live under projects. When you create a
project, pick **longstrip** (manhwa, manhua) or **pages** (manga). This choice
is permanent for the project.

When you create a chapter, pick the raw pages, the cleaned pages, and
optionally a translation JSON from a translator. Then pick the chapter mode:

- **Typeset**: everything. Detection, translation, tagging, lettering, export.
- **Translate**: raw pages only, detection tools, and per-bubble translation
  with optional tags. Made for translators who do not typeset.

## Editor

Raw pages sit on the left in a hideable panel. The cleaned page is in the
middle. Text box options and the text queue float over it.

### Modes

Top left of the page:

- **Paste mode** (pointer icon): click to place the next queued line.
- **Text mode** (T icon): click to create an empty text box.
- **Hand mode** (pan icon): pan the page.

Top right:

- **Bulk mode**: change chosen properties across many boxes at once, by tag or
  by clicking boxes, page-wide or chapter-wide. Only the properties you tick
  are applied; everything else on each target box is left alone.

### Fit to balloon

Click inside a bubble in Paste or Text mode and the app reads the balloon's
shape from the page pixels, sizes the box to it, and line-breaks the text to
the shape. A click on artwork or a gutter falls back to a plain box.

Press `Cmd/Ctrl+Shift+F` to re-fit the selected box to the balloon under it.
Use it after you edit text, resize, or move a box into a bubble.

### Keyboard shortcuts

`Cmd` on macOS, `Ctrl` on Windows. Mode, tab, rotation and fit shortcuts keep
working while you type; the rest stand down so they cannot eat what you write.

| Keys | Action |
|---|---|
| `Cmd/Ctrl+1` / `2` / `3` | Paste mode / Text mode / Hand mode |
| `Cmd/Ctrl+D` | Duplicate the selected box |
| `Delete` / `Backspace` | Delete the selected box |
| `Cmd/Ctrl+0` | Reset the selected box's rotation |
| `Cmd/Ctrl+Shift+F` | Fit the selected box to its balloon |
| `Cmd/Ctrl+Shift+C` / `Cmd/Ctrl+Shift+V` | Copy / paste a box's style |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo (`Cmd/Ctrl+Y` also redoes) |
| `Cmd/Ctrl+]` / `Cmd/Ctrl+[` | Next / previous options tab |
| `Cmd/Ctrl+Alt+1..4` | Jump to Text / Fill / Effects / Layout tab |

Rebind any of these under **Settings > Shortcuts**. Click the keys on a row and
press the new combination. A combination another action holds is refused and
the holder is named. **Default** restores one row, **Reset all shortcuts**
restores everything.

Three keys are fixed because they depend on what is selected: `Esc` closes then
deselects, `Tab` steps through the boxes on the page, and the arrow keys nudge
the selected box, or turn the page when nothing is selected. Hold `Shift` for a
bigger nudge.

### Text box options

Four tabs:

- **Text**: content, font family and size, bold / italic / caps, rotation.
- **Fill**: solid, gradient or pattern fill; fill and box opacity. Gradients
  take up to eight stops, linear or radial.
- **Effects**: stacked strokes, stacked shadows, arc warp, blur, roughen.
- **Layout**: position, size, mirror, alignment, leading, tracking, presets,
  per-box typeset options.

### Typesetting defaults

Under **Settings > Typesetting**: auto height (the box grows to fit its text)
and the line-breaking options (shaped breaks, hyphenation, balloon fitting,
minimum word length left alone on a line). These apply to boxes you create
from then on. Existing boxes keep their settings; change those with Bulk mode,
which exposes all of them per box.

### Queue, tags and fonts

**Text queue**: the list of translated lines waiting to be placed. Fill it from
the translation JSON, or type lines as you go.

**Tags**: attach a tag (like `sfx` or `aside`) to a line while translating. A
tag can carry its own default font. Restyle everything with a tag at once in
Bulk mode.

**Fonts**: pick a family once and map its real bold / italic / bold-italic
faces in the font menu (top right). After that, toggling bold or italic uses
the mapped face; a faux face is synthesised when none is mapped.

## Detection

Run detection on one page or the whole chapter. It finds speech bubbles and
text blocks, sorts them in the project's reading order, separates SFX from
dialogue, and transcribes Japanese with manga-ocr or Chinese/Korean with a
selected language-specific PaddleOCR recognizer. A project's source language is
chosen when the project is created and applies only to that project. Choose
the recognizer used for each language under **Settings → System → Models**.
Chinese defaults to PP-OCRv6 Medium; Korean defaults to PP-OCRv5 Korean because
PP-OCRv6 does not support Korean. Models download on first use when selected.

## Export

PNG, JPG, WebP, PSD or JSON, one page or the whole chapter, at native
resolution. The PSD has one editable Photoshop type layer per box over the
cleaned and raw art, and embeds the project JSON so importing it back is
lossless. Longstrip chapters are stitched and re-sliced on export, with a
warning when a cut would land through lettering.

## Chapter packages (.mtchapter)

To hand a chapter to someone else, click **Export** on the chapter row in the
project screen. That writes one `.mtchapter` file with the pages, every text
box and its style, the user fonts those boxes use, and the chapter's tags.
Undo history is not included.

To receive one, click **New chapter**, pick **Package** as the source, choose
the file, and pick or create the target project. Missing fonts are installed
into the Font Library (existing faces are never replaced), unknown tags are
added, and the chapter opens with nothing missing.
