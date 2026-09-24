// ===== Central reactive store (Svelte 5 runes) =====
import {
  PAGE_W,
  PAGE_H,
  BUILTIN_FONTS,
  USER_FONTS,
  defaultStyle,
  applyBoxDefaults,
  normalizeStyle,
  normalizeFit,
  normalizeInkStroke,
  normalizeFinish,
  normalizeReview,
  normalizeTypesetting,
  normalizeAuto,
} from './data.js';
// The tag module reaches back for nothing - it takes the pages it works on as
// arguments - so this stays a one-way edge and the two cannot cycle. What comes
// across, and for which moment:
//
//   styleForLine     the style a placed box is born with, and - since applying
//                    a tag to an already-placed line restyles its box - the
//                    style that box is moved to. One function for both, so the
//                    two orders (tag then place, place then tag) cannot drift
//                    into two different answers.
//   boxesWithTag     the boxes a tag-scoped bulk edit lands on.
//   toggleLineTag    the write itself, wrapped by `toggleTagOnLine` below so the
//                    restyle and its history entry cannot be forgotten by a
//                    caller.
//   lineTags         to tell an apply from an un-apply, which is the only one of
//                    the two that restyles anything.
//   normalizeTagName so a hand-edited chapter.json cannot put a tag on a line in
//                    a spelling the rest of the app would treat as a second tag.
//   carryTagsForward the one rule for "this page's lines are being replaced
//                    wholesale": queue-side markup follows its line number
//                    across, and the free-typed rows the user added - which no
//                    importer and no detector has any opinion about - are
//                    appended untouched. The JSON re-import path already goes
//                    through it; `applyDetection` now does too, so the two
//                    cannot answer differently.
import {
  styleForLine,
  boxesWithTag,
  toggleLineTag,
  lineTags,
  normalizeTagName,
  carryTagsForward,
  tagSize,
  rememberTagSize,
} from './tags.svelte.js';
// The one edge in this file that points at a module which points back: `measure`
// imports `fontCssFor` from here. Both directions are lazy - neither module
// touches the other at evaluation time, only inside function bodies - so the
// cycle resolves whichever order the two are first loaded in, and it buys the
// far more valuable property that `measure.js` stays the single owner of text
// metrics. The alternative was a second measurer living in the store, which is
// exactly how the editor and the exporter would start disagreeing about where a
// line breaks.
import { canMeasure, textInset, balancedBoxSize, clearLayoutMemo, setTypesetEnabled } from './measure.js';
// Containment - whether a box's text stays inside the box, and the ladder that
// makes it. Pure, and it joins the lazy store <-> measure cycle above on the
// same terms: nothing in it runs at evaluation time.
import {
  boxCandidate,
  placeBlock,
  placeAtHeight,
  containBox,
  inkHeight,
  growAround,
  fitBox,
  reviewFor,
  isAutoBox,
  manualReason,
  REVIEW_REASONS,
} from './contain.js';
import { neededHeight, growToFit, hasHangul } from './typeset.js';
// The pixel half of balloon fitting, and the two halves of getting pixels to it.
// `balloon.js` is pure and knows nothing about this app; `page-pixels.js` is the
// app's answer to "where do the pixels come from", and it answers null wherever
// there is no canvas - which is to say under node, where every test below takes
// the fallback path exactly as a page nobody has opened does.
import { detectBalloon, detectBalloonAt, inscribedRect, balloonFrame, shapeContainsPoint } from './balloon.js';
import { pagePixelsFor, forgetPagePixels } from './page-pixels.js';
import { measureChapterFits } from './chapter-fit.js';
// One-way, and it must stay that way: the brush tool's state module knows only
// its own defaults, so `setTool` can disarm it without the two ever cycling.
import { setBrushMode } from './brush-tool.svelte.js';
import { scaleStroke } from './brush.js';
import { translateStrokes } from './brush-board.svelte.js';
import { translateClipShapes } from './text-paint.js';
import { stripPageExtent, stripDragYBounds } from './editor/strip.js';

export { PAGE_W, PAGE_H };

let boxSeq = 1;
let pageLoadSeq = 5000; // page ids for imported projects that carry none

// Replace all pages from an imported project (e.g. a lossless PSD). Normalizes
// styles up to the current schema.
// Object URLs (raw/cleaned) are passed through as-is - the caller regenerates
// them from the source.
//
// Page and box ids are persisted in chapter.json and are addressed by the undo
// history across sessions, so a load keeps the id it was given. A fresh one is
// minted only when there is none, or when the file names two of them the same -
// two boxes answering to one id would confuse selection, deletion and undo
// alike, and so would two pages. The pre-pass walks the whole document first so
// both sequences start past the highest id in it, and something minted on page
// one cannot take an id that page nine already owns.
//
// Returns how many ids it had to mint. Anything above zero means what is now in
// memory disagrees with the file, and the caller has to get that written back:
// the minted ids come off module-global counters, so leaving the repair unsaved
// means the same box is called something different every session - the drift the
// history cannot see.
const idNum = (id) => (typeof id === 'string' && /^b\d+$/.test(id) ? Number(id.slice(1)) : 0);

// `line.tags` comes out of chapter.json, which is a file on the user's disk that
// nothing stops them opening in an editor - and two shapes of it break the app
// rather than merely reading oddly:
//
//   ["sfx","sfx"]  the queue renders its chips in a keyed `{#each}`, so a
//                  duplicate throws Svelte's `each_key_duplicate` and the whole
//                  panel stops rendering.
//   ["SFX"]        renders a chip whose click, going through `normalizeTagName`
//                  like every other write, adds `sfx` beside it instead of
//                  removing it.
//
// Both are the same failure - a name in the document that the app's own
// vocabulary would never have produced - so the fix is the app's own vocabulary,
// applied once, on the way in. A `tags` that is not an array at all is dropped
// rather than repaired: the array's *presence* is what tells `lineTags` the user
// has taken over from the legacy `line.type`, and a string there means the file
// never said that.
function sanitizeLine(l) {
  const out = { ...l };
  if (l?.placed) out.placed = true;
  if (!Array.isArray(l?.tags)) {
    delete out.tags;
    return out;
  }
  const names = [];
  for (const raw of l.tags) {
    const n = normalizeTagName(raw);
    if (n && !names.includes(n)) names.push(n);
  }
  out.tags = names;
  return out;
}

// `box.review` off disk: through `normalizeReview`, and only when there is one,
// so a box that fit is saved and loaded without the key at all.
const reviewField = (r) => {
  const review = normalizeReview(r);
  return review ? { review } : null;
};
const autoField = (a) => {
  const auto = normalizeAuto(a);
  return auto ? { auto } : null;
};

export function loadProjectPages(rawPages) {
  const takenBoxes = new Set();
  const takenPages = new Set();
  let minted = 0;
  for (const p of rawPages) {
    if (typeof p.id === 'number' && p.id >= pageLoadSeq) pageLoadSeq = p.id + 1;
    for (const b of p.boxes ?? []) {
      const n = idNum(b.id);
      if (n >= boxSeq) boxSeq = n + 1;
    }
  }
  app.pages = rawPages.map((p) => {
    const keepPage = p.id != null && !takenPages.has(p.id);
    const pageId = keepPage ? p.id : pageLoadSeq++;
    takenPages.add(pageId);
    if (!keepPage) minted++;
    const cp = {
      id: pageId,
      raw: p.raw ?? null,
      cleaned: p.cleaned ?? null,
      // The page's own durable filenames inside the chapter's raws/ and
      // cleaned/. Carried on the page, never re-derived by position, so a save
      // can never hand one page's images to another. `raw` and `cleaned` above
      // are the runtime blob URLs and never reach disk.
      file: p.file ?? null,
      cleanedFile: p.cleanedFile ?? null,
      // Unknown stays unknown. `PAGE_W`/`PAGE_H` used to stand in for a missing
      // pair, and that is an invented coordinate space, not a default: the
      // boxes in the same file were authored against the image, so the moment
      // the canvas measures it `setPageDims` would see a *learned* space
      // changing and drag every box across by 1080/850. 0 means "nobody has
      // measured this yet", which is the state `createChapter` leaves every
      // page in anyway, and it is the one state the first measurement can be
      // adopted from without moving anything. Consumers ask the art instead -
      // see `hasPageSpace`.
      w: p.w > 0 ? p.w : 0,
      h: p.h > 0 ? p.h : 0,
      // "`w`/`h` describe the raster this page NO LONGER draws." Set by the
      // closed-chapter source edits when a page's art was swapped and the new
      // image could not be measured at that moment (see `respacePage` in
      // library.svelte.js): the old space is kept, because it is the space the
      // boxes are quoted in, and this flag is what stops the next open reading
      // it as a measurement and adopting a new one without moving them. The
      // open decodes the art, rescales, and clears it. Carried through a load
      // rather than recomputed - only the file knows the swap happened.
      needsRespace: p.needsRespace === true,
      lines: (p.lines ?? []).map(sanitizeLine),
      // Both halves defaulted, not just `panels`. `detect` arrives from a file
      // this build did not write - a hand edit, a foreign tool, a half-written
      // record - and one that carries `panels` but no `boxes` used to throw
      // straight out of the load, which loses the whole chapter rather than the
      // one field that is missing. An absent list is an empty list, which is
      // what every reader of it already handles.
      detect: p.detect
        ? {
            panels: (p.detect.panels ?? []).slice(),
            // A measured fit (see `placeDetectedInChapter`) through the same
            // `normalizeFit` a box's goes through. Absent stays absent: that is
            // "not measured", which is not the same answer as null.
            boxes: (p.detect.boxes ?? []).map((b) =>
              b.fit === undefined ? { ...b } : { ...b, fit: normalizeFit(b.fit) },
            ),
          }
        : null,
      // NOT migrated: a box already on disk with `lineN: null` is loaded as it
      // was, and stays a canvas-only box that cannot be tagged. Giving it a line
      // here would mean inventing a queue row, with a number the user never
      // chose, in a chapter they have not opened since - writing rows into
      // somebody's document as a side effect of looking at it. Every one of
      // those boxes keeps rendering, exporting (`extraBoxes` in exporter.js) and
      // round-tripping through the PSD exactly as before; what they cannot do is
      // carry a tag, and the remedy is in the user's hands and is one they can
      // see: delete the box and type it again. Silence is the cost, and it is
      // cheaper than a renumber nobody asked for. See `isFreeBox`, which is
      // written to answer for both shapes for exactly this reason.
      boxes: (p.boxes ?? []).map((b) => {
        const keep = typeof b.id === 'string' && b.id !== '' && !takenBoxes.has(b.id);
        const id = keep ? b.id : 'b' + boxSeq++;
        takenBoxes.add(id);
        if (!keep) minted++;
        return {
          id,
          lineN: b.lineN,
          text: b.text ?? null,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          style: normalizeStyle(b.style),
          // The balloon this box was fitted to, in page coordinates. Through
          // `normalizeFit` for the same reason the style goes through
          // `normalizeStyle`: what is on disk was written by some build, and a
          // shape this one does not recognise - a third `kind`, a NaN from a
          // hand edit - has to degrade to "this box has no fit" rather than
          // reaching the line breaker. Always present, never undefined, so the
          // field exists on the reactive proxy from the first render and a
          // component reading `box.fit` subscribes to it before anything writes
          // one.
          fit: normalizeFit(b.fit),
          // The containment flag, as saved - absent when the box fit. Carried
          // through rather than dropped because it is the one record of a box
          // the user has not dealt with yet; the refit below re-checks every box
          // against this build's measurements and brings it up to date, keeping
          // the saved reason when the box still does not fit.
          ...reviewField(b.review),
          // The solver's record (FIT-5), absent on a box it has never managed.
          // Carried and nothing more: a load re-checks, it never re-solves.
          ...autoField(b.auto),
        };
      }),
      activeLineN: null,
    };
    for (const b of cp.boxes) {
      if (b.lineN != null) {
        const ln = cp.lines.find((l) => l.n === b.lineN);
        if (ln) ln.placed = true;
      }
    }
    cp.activeLineN = firstUnplaced(cp);
    return cp;
  });
  // Boxes arriving from outside this session get the same treatment every other
  // path gets - see `autoFitBox`. A box on disk was sized by an older build, by a
  // hand-edited file, or against a user font that has since been replaced, and
  // any of those can leave text hanging out of its own rectangle the moment the
  // chapter opens. Grow-only, so a box that is roomier than its text is left
  // exactly as the user left it, and a no-op in an environment with no text
  // metrics, so a test run never rewrites geometry from a stand-in number.
  for (const p of app.pages) refitPage(p);
  // A different document is now open, and page ids are per-document counters
  // that collide freely across chapters - so anything the cache still holds is
  // at best dead weight and at worst another chapter's page 3. The src check
  // inside the cache would already refuse to hand those pixels over; this is
  // what gives the memory back at the moment the chapter changes rather than at
  // the next decode.
  forgetPagePixels();
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
  clearPending();
  app.loaded = true;
  markUnsaved();
  return minted;
}

// ---------- free-typed lines ----------
// A box made with the Text tool used to live on the canvas alone - `lineN: null`,
// no queue row, and so no line for a tag to sit on. Tags live on lines, so that
// box could not be tagged, could not be reached by a tag-scoped bulk edit, and
// did not appear in the "N / M placed" count of the page it was on. It now gets
// a line of its own, and the whole of what makes that line *free* is its number:
//
//   n < 0  - free-typed. The user made this line by typing on the canvas.
//   n > 0  - imported. The translator numbered it; psd.js and exporter.js write
//            that number out and a re-imported translations file joins on it.
//
// The number is the marker rather than a `free: true` field beside it, and that
// is the decision the rest of this rests on. A new field would have to be
// carried by every serializer the document passes through - chapter.json,
// `serializePage` in psd.js, the detected-text JSON export - and any one of them
// forgetting it turns a free line into an imported line with an absurd number.
// `n` is already carried by all of them, because nothing works without it.
//
// Negative because every producer of a translations file numbers from 1: the
// engine's detector, the JSON importer's own fallback (`Number(n) || idx + 1`
// in `normLine`), and this app's exporter. So the two spaces cannot meet, no
// imported line ever has to be renumbered to make room, and a re-import - which
// replaces a page's lines wholesale - cannot land on top of one (see
// `carryTagsForward`, which is what carries free lines across that replacement).
export const isFreeLine = (l) => Number.isFinite(l?.n) && l.n < 0;
// A box with no imported line behind it. Two shapes, and the second is why this
// is a function rather than `b.lineN < 0`:
//
//   lineN < 0     a free-typed box made since free boxes joined the queue.
//   lineN == null a free-typed box saved before that, in a chapter on disk.
//
// The old ones are deliberately NOT migrated on load - see `loadProjectPages`.
export const isFreeBox = (b) => b?.lineN == null || b.lineN < 0;

// The number the next free-typed line on this page takes: one below the lowest
// number the page already carries, so it collides with nothing currently there -
// not with an imported line, not with an earlier free one, and not with a
// negative number some hand-edited file put in the document. Per page, because
// `box.lineN` only ever joins within a page.
export const nextFreeLineN = (p) =>
  Math.min(0, ...(p?.lines ?? []).map((l) => (Number.isFinite(l?.n) ? l.n : 0))) - 1;

export function firstUnplaced(p) {
  const placed = placedLineNs(p);
  const u = p?.lines?.find((l) => !isFreeLine(l) && !placed.has(l.n));
  return u ? u.n : null;
}
export const isPlaced = (p, n) => {
  const ln = lineByN(p, n);
  return Boolean(ln?.placed || p?.boxes?.some((b) => b.lineN === n));
};

// The same question asked about EVERY line at once.
//
// `isPlaced` is a scan of the page's boxes, and two places in the editor were
// asking it once per line: the queue, to shade the rows it has already placed,
// and the shell, to count them for the panel's "N / M placed". Both are
// `lines.length * boxes.length` and both re-ran on every page turn - which on a
// page of forty lines and forty boxes is 3200 comparisons per component per
// turn, for an answer one pass over the boxes gives.
//
// A `Set` rather than a count, because the two callers want different things out
// of it and a set answers both: membership for the queue's per-row flag, size
// for the shell's total. Free lines are in it like any other - a box's `lineN`
// is a box's `lineN` - so `placed / total` reads exactly as it did.
export function placedLineNs(p) {
  const out = new Set();
  for (const l of p?.lines ?? []) if (l.placed) out.add(l.n);
  for (const b of p?.boxes ?? []) if (b.lineN != null) out.add(b.lineN);
  return out;
}
export const lineByN = (p, n) => p.lines.find((l) => l.n === n);

// ---------- how far through a page's translation we are ----------
// The translate workspace's answer to "N / M placed": a line is done when it has
// English on it. Derived, never stored - a stored flag would be one more thing
// the textarea has to remember to keep in step, and it would be wrong the first
// time anything wrote `en` from outside the queue (a JSON import, a paste, an
// undo). Whitespace does not count, because a line holding a stray space is not
// a line anybody has translated.
export const isTranslated = (l) => !!lineText(l).trim();
export const translatedCount = (lines) => (lines ?? []).filter(isTranslated).length;

// ---------- reactive state ----------
export const app = $state({
  loaded: false, // becomes true once real pages/images/JSON are imported
  pageIndex: 0,
  // Empty until a chapter is opened from the library; the editor is only
  // routed to once one has been.
  pages: [],
  selectedId: null,
  editingId: null, // box currently in inline-edit mode
  tool: 'place', // one of TOOLS - see setTool
  lastStyle: defaultStyle(), // style new boxes inherit (follows the previous box; size is per tag, see sizeKeyFor)
  // Bulk-style picker mode. `style` is the template being edited, `targets` the
  // boxes clicked on the canvas (`targetSet` its membership index - see
  // `isBulkTarget`), `mask` which of the template's properties this edit is
  // actually about - see BULK_PROPS.
  // `tag`/`scope` are the other way of naming the same targets: picking a tag
  // fills `targets` with every box carrying it inside `scope`, so there is one
  // selection and one Apply no matter which way the user named the boxes.
  bulk: { active: false, targets: [], targetSet: new Set(), style: null, mask: {}, tag: '', scope: 'chapter' },
  exportOpen: false, // export scope/destination dialog
  exportDir: '', // last chosen output directory (native only), persisted
  exportName: 'page', // base filename, persisted
  // How tall one output image is when a longstrip chapter is re-sliced on
  // export, in strip (page) pixels - see editor/strip-cuts.js, whose
  // SLICE_H_DEFAULT this mirrors. It lives here rather than in the dialog so
  // that closing and reopening the dialog does not throw the number away; the
  // export path falls back to the default if it is ever cleared.
  stripSliceH: 8000,
  zoom: 1,
  isFit: true,
  // True while a zoom gesture is still moving - see `setZoomLive`. It is the
  // canvas's answer to "is this frame one of many", and the boxes that
  // re-rasterise themselves at the zoom read it to decide whether to repaint
  // now or once the gesture stops.
  zoomLive: false,
  fmt: 'PNG',
  // `system` is what `scanSystemFonts` found installed on this machine - every
  // family, whether or not the menus offer it (that is a preference, see
  // prefs.svelte.js). Empty in a browser, and until the scan lands.
  fonts: { builtin: BUILTIN_FONTS.slice(), user: USER_FONTS.slice(), system: [] },
  // Bumped once per batch of faces becoming available - see `noteFontsChanged`.
  // Not a count of anything and never read for its value: it exists so that a
  // layout derived from a text measurement can depend on "the fonts have
  // changed", which is otherwise not a reactive fact.
  fontsVersion: 0,
  rawZoom: 0, // 0 = Fit, else scale
  saved: false,
  // The last autosave was rejected by the disk. There is no manual save in this
  // app, so this is the user's only signal that their work is not reaching the
  // filesystem - it stays raised until a write lands, not just until the next
  // toast fades.
  saveFailed: false,
  exporting: false,
  leftWidth: 280,
  sidebarHidden: false, // raw reference sidebar collapsed to the rail's caret
  toast: { msg: '', seq: 0 },
  sidecar: { status: 'unknown', device: null, info: null }, // in-process detection engine health
  detecting: false, // detection/OCR request in flight
  detectBatch: null, // { done, total } while a whole-chapter detect runs, else null
  chapterPlace: null, // { done, total } while "Place chapter" measures its balloons, else null
  chapterRef: null, // { projectId, chapterId } while a chapter is open
  // The open chapter's workflow mode, mirrored from its chapter.json - see
  // CHAPTER_MODES. It is a property of the chapter and not a preference of the
  // app, so `openChapter` writes it on every open and `closeChapter` puts it
  // back to the default: two chapters in different modes must each open the way
  // their own file says, whichever was opened first.
  chapterMode: 'typeset',
  // The open chapter's PROJECT's layout, mirrored from its project.json - see
  // LAYOUTS. Like the mode above it is a property of what is open rather than a
  // preference of the app, so `openChapter` writes it and `closeChapter` puts
  // it back.
  projectLayout: 'pages',
  // The open chapter's typesetting, mirrored from its chapter.json - see
  // `normalizeTypesetting` in data.js. Like the mode, it belongs to the chapter:
  // `useChapterTypesetting` sets it on every open, and plain is what stands while
  // nothing is open.
  typesetting: normalizeTypesetting(null),
  // The open project's source language for detection/OCR. This is project
  // state, not a global preference: opening another series must select that
  // series' recognizer and reading direction instead of carrying this one over.
  projectOcrLanguage: 'ja',
});

// ---------- derived helpers ----------
// A blank stand-in keeps every consumer total while no chapter is open. The
// editor is only routed to with pages loaded, so this is a safety net, not a
// code path with a UI.
// Frozen, arrays included: a write to the shared singleton is a bug, and it
// should throw where it happens rather than quietly pollute a non-reactive
// object that every empty-document consumer shares.
const NO_PAGE = Object.freeze({
  id: 0,
  raw: null,
  cleaned: null,
  file: null,
  cleanedFile: null,
  w: PAGE_W,
  h: PAGE_H,
  lines: Object.freeze([]),
  detect: null,
  boxes: Object.freeze([]),
  activeLineN: null,
});
export const page = () => app.pages[app.pageIndex] ?? NO_PAGE;
export const byId = (id) => page().boxes.find((b) => b.id === id);
// English text for a line. Back-compat: fall back to legacy natural/stylised/text
// fields so projects saved under the old schema still render.
export const lineText = (ln) => {
  if (!ln) return '';
  return ln.en ?? ln.natural ?? ln.stylised ?? ln.text ?? '';
};
// Resolve a box's display text. Line-backed boxes (text == null) look up their
// line on `p` - defaulting to the current page, but callers rendering another
// page (e.g. export-all) must pass that page so glyphs resolve correctly.
export const boxText = (b, p = page()) => {
  if (b.text != null) return b.text;
  return lineText(lineByN(p ?? page(), b.lineN));
};

// ---------- where a box's own text lives ----------
// Every box in the document reads through `boxText` above, and that has not
// changed. What these two are for is the other direction: a *write*, and which
// field it lands in.
//
//   free-typed (lineN < 0)  the line's `en`. The box carries `text: null` and
//                           owns nothing, exactly like a box placed from the
//                           queue - which is the whole point of giving it a
//                           line. One copy of the text, in the one place the
//                           queue's textarea, `boxText`, `boxTextFor` in psd.js
//                           and the detected-text JSON export all already read.
//   anything else           `box.text`, unchanged. For a queue-placed box that
//                           is an override of its line, which is what it has
//                           always been; for a legacy free box (lineN == null)
//                           it is the only place there is.
//
// Two copies was the alternative and it is the one to argue against, because it
// looks cheaper: keep the text on the box and mirror it onto the line for the
// exporter. The mirror can only be written where the store can see the write,
// and the contenteditable writes on every keystroke - so the queue row for that
// line renders a stale copy for as long as the user keeps typing, and typing
// into the queue's textarea writes a line the box's own non-null `text` then
// shadows. The box simply stops following the queue. There is no version of the
// mirror that is not that bug.
//
// `p` is the page the box is on, defaulting to the one on screen. Callers
// rendering or exporting another page must pass it, for the same reason
// `boxText` takes one.
export function boxOwnText(b, p = page()) {
  if (b?.lineN != null && b.lineN < 0) return lineByN(p ?? page(), b.lineN)?.en ?? null;
  return b?.text ?? null;
}
// `opts.fit: false` writes the text and fits nothing - for the history, which
// puts back the geometry it recorded rather than deriving one (see `restoreFit`
// in history.svelte.js). A fit run first would be a ladder that can move, widen
// and shrink the box, overwritten a moment later by the record.
export function setBoxText(b, v, p = page(), opts) {
  if (!b) return;
  const fit = opts?.fit !== false;
  if (b.lineN != null && b.lineN < 0) {
    const ln = lineByN(p ?? page(), b.lineN);
    // A free box whose line has gone is a document that has already lost the
    // text; writing `b.text` here would resurrect it as an override nothing
    // else in the app knows how to reach.
    if (ln) ln.en = v ?? '';
    // Same reason as below: the text changed, so the box may no longer fit it.
    if (fit) autoFitBox(b, p);
    return;
  }
  b.text = v;
  if (fit) autoFitBox(b, p);
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// ---------- auto-height, and containment ----------
// The box's rectangle has to describe its text. It did not: the editor renders
// with `overflow:visible` and the exporter grows a footprint of its own
// (`topExtra`/`bottomExtra` in `layoutBox`), so four wrapped lines in a box sized
// for two spilled above and below the rectangle and out of the speech bubble,
// with nothing anywhere saying so. For a typesetting tool that is not a cosmetic
// problem - the rectangle is the thing the user positions, resizes and aligns,
// and a rectangle that lies about its contents makes every one of those gestures
// guesswork.
//
// The rule is now the user's, and it is stricter than "the height follows the
// text": text never goes outside its box, measured in PIXELS - italic overhang,
// accents, strokes, shadows, and every effect laid on them (OVF-7) - and it is
// never clipped to get there. A box either fits or carries `box.review` saying
// it does not (see contain.js, which decides both, and data.js for the flag's
// shape). Two ways that gets enforced:
//
//   the ladder     `autoFitBox`. After an edit or a placement, an AUTO box (auto
//                  sizing on, straight text, and no mesh, ink or mask pinned to
//                  it - see `isAutoBox` in contain.js) that does not fit is
//                  grown - height, then width, within its balloon and the page -
//                  and then its font is shrunk, no lower than `minSizeFor`; only
//                  if that fails is it flagged. A MANUAL box is never moved,
//                  resized or shrunk here: it gets the verdict and nothing else.
//   grow-only      `refitBox` and `autoFitBoxTo`. A chapter opening, a font
//                  arriving, the component's own safety net: the height grows
//                  to hold the lines and their ink (`growHeightTo`), and the
//                  flag is brought up to date. Nothing else moves - opening a
//                  chapter must never change a box's size, width or position,
//                  so a box laid out by an older engine that no longer fits is
//                  grown taller when that is enough, and otherwise flagged, not
//                  refitted.
//
// Every path that can change what the box has to fit calls one of them - inline
// typing, the Inspector's text field and style controls, the queue's own
// translation field, a bulk apply, a tag apply, a width drag, a placement, a
// chapter load, and a font arriving after all of those (`noteFontsChanged`) -
// because a `$effect` in the component would only ever cover the boxes rendered
// on the page currently on screen. An undo or redo restores the recorded
// geometry directly rather than re-deriving it, and then re-checks.
//
// Records nothing of its own. The fit is not an edit - it is a consequence of an
// edit the user has already made, and giving it its own history entry would
// charge two presses of undo for one gesture. Instead every record whose edit
// can trigger a fit carries the box's geometry and size on both sides of it
// (`geomBefore` / `geomAfter` - see `fitGeom` below and the `style`, `text` and
// `bulk` kinds in history.svelte.js), so one press puts back the box the user
// actually had. It used to re-run the fit on the way back instead, which cannot
// work: the fit never shrinks a box, so an undo could never give back the height
// the grow took.
//
// Answers true when it changed the box's geometry or size, so a caller can tell.
// A change of flag alone is not a change to the document's layout and does not
// count.
export function autoFitBox(b, p = page()) {
  if (!b?.style || !canMeasure()) return false;
  const cand = boxCandidate(b, boxText(b, p));
  if (!isAutoBox(cand)) {
    reviewBox(b, p);
    return false;
  }
  const r = fitBox(cand, { page: p, strip: stripOf(p), minSize: minSizeFor(b, p) });
  const changed = writeFit(b, r);
  writeReview(b, r.review);
  return changed;
}

// The smallest a ladder may shrink a box's font to. The larger of two floors:
//
//   the preference, `prefs.minFontSize` - an absolute size below which text is
//   not worth reading, whatever it was set at (mirrored here by the prefs
//   module, which the store cannot import - see `setMinFontSize`);
//   three quarters of the size this kind of text is set at - the size remembered
//   for the line's tag (`tagSize`), or the box's own when there is none. A
//   quarter smaller is about as far as a letterer shrinks one balloon before it
//   reads as a different voice from the balloons around it; past that, the text
//   needs a decision - a bigger balloon, fewer words - and the flag asks for it.
let minFontSize = 12;
export function setMinFontSize(v) {
  const n = Number(v);
  if (n > 0) minFontSize = n;
}
function minSizeFor(b, p) {
  const line = b.lineN != null && p ? lineByN(p, b.lineN) : null;
  const ref = tagSize(sizeKeyFor(line)) ?? b.style.size;
  return Math.max(minFontSize, 0.75 * ref);
}

const stripOf = (p) => (isLongstrip() ? stripPageExtent(app.pages, p?.id) : null);

// The ladder's answer, written back. Only the fields that moved are written,
// so a box that already fits is not dirtied field by field.
function writeFit(b, r) {
  let changed = false;
  for (const k of ['x', 'y', 'w', 'h']) {
    if (b[k] !== r[k]) {
      b[k] = r[k];
      changed = true;
    }
  }
  if (b.style.size !== r.size) {
    b.style.size = r.size;
    changed = true;
  }
  return changed;
}

// THE writer of `box.review`, and it writes only when the flag changes: every
// component showing a badge subscribes to the field, and a fresh-but-equal
// object per keystroke would repaint every one of them for nothing. Absent - not
// null - when the box fits, so a box that has never overflowed looks exactly
// like one saved before the field existed.
function writeReview(b, review) {
  if (!review) {
    if (b.review !== undefined) delete b.review;
    return;
  }
  const cur = b.review;
  if (
    cur &&
    cur.kind === review.kind &&
    cur.reason === review.reason &&
    cur.overflow?.l === review.overflow.l &&
    cur.overflow?.t === review.overflow.t &&
    cur.overflow?.r === review.overflow.r &&
    cur.overflow?.b === review.overflow.b
  ) {
    return;
  }
  b.review = review;
}

// The verdict alone: check the box as it stands and bring its flag up to date.
// Moves nothing. The reason a flag already carries is kept - it was written by
// whatever last tried to fit the box, and that is still the explanation - and a
// new flag says why the box was left as it is: an auto box found by a pass that
// only grows heights "no longer fits", a manual one names what makes it manual.
//
// No metrics, no verdict, for the reason `autoFitBox` asks the same question: a
// flag computed from stand-in widths would be a number invented by the test
// runner and written into the user's document.
//
// `place` is for a caller that has just placed the block for the box exactly as
// it stands (`placeBlock`), so the lines are not measured twice.
export function reviewBox(b, p = page(), place) {
  if (!b?.style || !canMeasure()) return;
  const cand = boxCandidate(b, boxText(b, p));
  const v = containBox(cand, place ?? placeBlock(cand));
  if (v.fits) {
    writeReview(b, null);
    return;
  }
  const reason = b.review?.reason ?? (isAutoBox(cand) ? REVIEW_REASONS.stale : manualReason(cand));
  writeReview(b, reviewFor(v, reason));
}

// Grow-only by line count and ink, and the verdict. The chapter-open and
// font-arrival path (`refitPage`), and the history's fallback for an entry that
// recorded no geometry: neither is an edit, so neither may resize anything but
// the height, and that only upward.
export function refitBox(b, p = page()) {
  if (!b?.style || !canMeasure()) return false;
  const cand = boxCandidate(b, boxText(b, p));
  const place = placeBlock(cand);
  // Text on a curve has no lines to count, and is never an auto box.
  return growAndReview(b, p, cand, place, place.isCurve ? 0 : place.lines.length);
}

// ===== the same fit, for a caller that has already broken the lines =====
//
// `refitBox` above is the answer for everything that only knows the box. The
// editor is not one of those. A `TextBox` has just laid its own lines out to draw
// them - identical text, identical style, identical width, identical balloon -
// and breaking the very same block a second time to count it was measured at
// half of a page turn's entire JavaScript cost with the typesetting beta on.
//
// So the component hands the count it already has to this instead: its safety
// net, grow-only by that count plus the verdict. It is deliberately NOT the
// ladder. The component calls it from an effect on every relevant change, and a
// ladder there would resize boxes as a side effect of rendering them; the edits
// that should run the ladder all call `autoFitBox` themselves.
//
// `lineCount` is trusted. It has to be - the whole point is not to re-derive it
// - and the one caller is the one place in the app that cannot get it wrong,
// because the number it passes is the number of lines it is about to draw.
//
// The block is still placed once here, for the ink: the verdict reads it, and
// so does the height (OVF-8, below). Placing it is the layout memo's hit on the
// lines the component has just broken, not a second break.
export function autoFitBoxTo(b, lineCount, p = page()) {
  if (!b?.style || !canMeasure()) return false;
  const cand = boxCandidate(b, boxText(b, p));
  return growAndReview(b, p, cand, placeBlock(cand), lineCount);
}

// The two grow-only paths' shared tail: grow an auto box's height, then write
// the verdict. The growth moves `y` and `h` and nothing else, which the lines
// do not read, so the block placed for the box as it stood is re-placed at the
// new height rather than laid out again.
function growAndReview(b, p, cand, place, lineCount) {
  const changed = isAutoBox(cand) ? growHeightTo(b, lineCount, p, cand, place) : false;
  reviewBox(b, p, changed ? placeAtHeight(place, boxCandidate(b, cand.text)) : place);
  return changed;
}

// The grow-only height rule, once: the taller of what the lines need and what
// the ink needs, anchored by `valign`, capped by the page - or by the whole
// strip in a longstrip document, where a box may hang over a seam.
//
// The lines: their line boxes inside the content box (the box less
// `textInset` - its padding and its outline's reach - above and below).
//
// The ink (OVF-8): the line boxes are not the glyphs. An accent over a capital
// rises past the font's ascent, a descender under a tight line height drops
// past the line box, and a shadow thrown down reaches past both - and a box
// sized from its line count alone had all of that outside it, flagged "no
// longer fits" on every opening with nothing done about it, when growing is
// exactly what these paths are allowed to do. `inkHeight` (contain.js) is the
// height at which the verdict clears on the edge that growing moves; zero when
// the ink is already inside, or only outside on the edge the block is anchored
// to, which no height clears.
function growHeightTo(b, lineCount, p, cand, place) {
  const s = b.style;
  const need = Math.max(neededHeight(lineCount, s, textInset(s)), inkHeight(cand, place));
  const extent = stripOf(p);
  const next = extent && extent.total > 0
    ? growToFit({ y: b.y + extent.top, h: b.h, valign: s.valign }, need, extent.total)
    : growToFit({ y: b.y, h: b.h, valign: s.valign }, need, p?.h ?? 0);
  if (extent && extent.total > 0) next.y -= extent.top;
  if (next.h === b.h && next.y === b.y) return false;
  b.y = next.y;
  b.h = next.h;
  return true;
}

// The fields a fit is allowed to move, as the history records them. Taken on
// either side of an edit that can fit a box, so an undo restores what the user
// was looking at rather than what a re-derivation would produce now. The size is
// the style's, and `setFields` in history.svelte.js knows to put it back there.
export const fitGeom = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size });

// ===== the flag's own commands =====
//
// "Fit now": the ladder, once, on any box - including a manual one, because the
// user asking is exactly what a manual box waits for. What it may do depends on
// what made the box manual:
//
//   sized by hand     grown within its balloon like an auto box, and it stays
//                     manual afterwards.
//   hand-placed       text on a curve, a mesh warp, or hand-drawn ink or a mask
//                     around text: the box keeps its rectangle and may only have
//                     its font shrunk, because its geometry is its own or pinned
//                     to its corner, and growing the box would slide the text
//                     against it (see `isAutoBox`).
//   only ink          a box with ink or a mask and no text has no font to shrink
//                     and nothing anchored to it, so it is grown around what it
//                     paints with the ink carried the other way (`holdInk`) -
//                     nothing moves on the page but the box's own rectangle.
//
// One undo entry, and none when nothing moved.
export function fitBoxNow(boxId = app.selectedId, p = page()) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b?.style || !canMeasure()) return false;
  settleEdits();
  const before = cloneStyle(b.style);
  const geomBefore = fitGeom(b);
  const text = boxText(b, p);
  const cand = boxCandidate(b, text);
  const reason = manualReason(cand);
  let changed;
  if ((reason === REVIEW_REASONS.ink || reason === REVIEW_REASONS.mask) && !String(text ?? '').trim()) {
    changed = holdInk(b, p);
    reviewBox(b, p);
  } else {
    const lockGeom = reason !== REVIEW_REASONS.manual;
    const r = fitBox(cand, { page: p, strip: stripOf(p), minSize: minSizeFor(b, p), geometry: !lockGeom });
    changed = writeFit(b, r);
    writeReview(b, r.review);
  }
  if (!changed) return false;
  recordEdit({ t: 'style', pageId: p.id, boxId: b.id, before, after: cloneStyle(b.style), geomBefore, geomAfter: fitGeom(b) });
  markUnsaved();
  return true;
}

// "Make auto": auto sizing back on, and the ladder run on the result - one undo
// entry for both. A curved, warped, inked or masked box turns its flag on and
// stays manual, since what makes it manual is not the flag.
export function makeBoxAuto(boxId = app.selectedId, p = page()) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b?.style) return false;
  settleEdits();
  const before = cloneStyle(b.style);
  const geomBefore = fitGeom(b);
  const was = b.style.autoHeight;
  b.style.autoHeight = true;
  const moved = autoFitBox(b, p);
  if (was !== false && !moved) return false;
  recordEdit({ t: 'style', pageId: p.id, boxId: b.id, before, after: cloneStyle(b.style), geomBefore, geomAfter: fitGeom(b) });
  markUnsaved();
  return true;
}

// Every flagged box, in page order: what the queue's list and the export's
// pre-flight read. Reactive when read inside a `$derived` - it reads each box's
// `review`, and `writeReview` only writes when a flag actually changes.
export function flaggedBoxes(pages = app.pages) {
  const out = [];
  for (const pg of pages ?? []) {
    for (const b of pg?.boxes ?? []) if (b.review) out.push({ pageId: pg.id, boxId: b.id, review: b.review });
  }
  return out;
}

// Every box on a page, for the moments a whole page's worth of text arrives at
// once rather than being typed: a chapter opening from disk, a project imported
// from a PSD. Both land boxes whose height was decided by an older build, or by
// a hand-edited file, or by a font that has since been replaced.
//
// Grow-only and verdict-only (`refitBox`), never the ladder: opening a chapter
// must not change the size, width or position of anything in it. What no longer
// fits is flagged, and stays as the user left it until they ask.
export function refitPage(p) {
  if (!p) return 0;
  let n = 0;
  for (const b of p.boxes) if (refitBox(b, p)) n++;
  return n;
}

// ---------- a font arriving changes every measurement ----------
// Text metrics are not a constant. A user font is registered asynchronously -
// read out of IndexedDB at boot, or added from a file mid-session - and until
// its face is in `document.fonts` every measurement of a box using it is made
// against the fallback family. That is the normal cold-start order, not an edge
// case: `loadProjectPages` refits the whole chapter against the fallback, writes
// each `box.h` from it, and the real face lands a moment later.
//
// Nothing then recomputed anything, and the disagreement was permanent and
// three-way: the canvas kept the breaks it had derived, `box.h` kept a height
// derived from a font nobody is looking at, and the exporter - which awaits
// `document.fonts.ready` before it measures - broke the lines somewhere else
// again and drew a block of a different height. The user's own screen was the
// one thing that was wrong.
//
// So a face becoming available is an event, and this is it. Two halves, and both
// are needed:
//
//   the counter  `app.fontsVersion`, read reactively by everything that derives
//                a layout from a measurement (`TextBox`'s shaped lines and its
//                fit effect). Bumping it is what makes a component recompute
//                breaks it has no other reason to doubt.
//   the refit    the boxes in the open chapter, including the pages not on
//                screen, which have no component to re-run anything.
//
// Idempotent and grow-only like every other fit, so calling it more often than
// strictly necessary costs a measurement pass and changes nothing else.
//
// `fonts.js` calls this after it registers a face, and `App.svelte` calls it
// once `document.fonts.ready` resolves at boot, which covers the built-in faces
// and any face the browser was still fetching.
export function noteFontsChanged() {
  return relayoutAll();
}
// The same re-measure, for anything else that changes how every line lays out
// without touching any box - today, the open chapter's typesetting switch in
// Settings (`setChapterTypesetMode`). Bumping `fontsVersion` is what wakes the
// components; the name is historical, it is simply "every measurement is stale".
export function relayoutAll() {
  // FIRST, before anything re-measures. `measure.js` remembers where a block of
  // text broke, keyed on the style's font NAME - and what that name resolves to,
  // or what metrics the face behind it has, is exactly what has just changed.
  // Every entry in that map is now an answer to a question about a different
  // font, and the refit below would read them straight back out.
  clearLayoutMemo();
  app.fontsVersion++;
  let n = 0;
  for (const p of app.pages) n += refitPage(p);
  // Only when something moved: the geometry is in the document, so it has to
  // reach disk, and an unsaved flag raised by a font that changed no box would
  // be a write nobody asked for.
  if (n) markUnsaved();
  return n;
}

// ---------- the chapter's typesetting (DET-3) ----------
// The line breaker is the document's, not the machine's: `typesetEnabled()`
// in measure.js is the gate every layout reads, and these are the only writers
// of it in the app. The library calls `useChapterTypesetting` with the record's
// field before the pages load - their refit already measures under it - and
// with nothing when the chapter closes.
export function useChapterTypesetting(raw) {
  app.typesetting = normalizeTypesetting(raw);
  setTypesetEnabled(app.typesetting.mode === 'smart');
}

// Settings' switch for the open chapter. Saved with it, and every box
// re-measured under the new breaker the way a font arriving re-measures them.
export function setChapterTypesetMode(mode) {
  const next = normalizeTypesetting({ ...app.typesetting, mode });
  if (next.mode === app.typesetting.mode) return;
  useChapterTypesetting(next);
  relayoutAll();
  markUnsaved();
}

// Deep copy of a style object, normalised up to the current schema (nested
// gradient/pattern/roughen groups and the strokes/shadows lists included), safe
// for reactive proxies.
export function cloneStyle(s) {
  return normalizeStyle($state.snapshot(s));
}

// ---------- font size remembered per tag ----------
// The size a new box is born at follows the last box that carried the SAME
// primary tag, not the last box touched: an `sfx` box sized up to 60 must not
// drag the next dialogue box up with it, and the dialogue size must not pull
// the next `sfx` back down. Everything else about the style still follows
// `lastStyle`. The group is the line's first tag - the same one `styleForLine`
// lets win - and an untagged line is its own group, keyed by the empty string.
//
// Persisted beside the tag registry, in project.json, and for the same reason:
// "sfx is about 60 here" is a fact about this series, not about the person or
// about any one chapter - see `bindTags`.
export const sizeKeyFor = (line) => (line ? lineTags(line)[0] ?? '' : '');

// A legacy free box (`lineN == null`) has no line and lands in the untagged group.
export function rememberSizeFor(p, box) {
  if (!box?.style || typeof box.style.size !== 'number' || !Number.isFinite(box.style.size)) return;
  const line = box.lineN != null && p ? lineByN(p, box.lineN) : null;
  rememberTagSize(sizeKeyFor(line), box.style.size);
}

// Remember the active box's style so the next placed box inherits it.
export function rememberStyle(box) {
  const b = box ?? (app.selectedId ? byId(app.selectedId) : null);
  if (b?.style) {
    app.lastStyle = cloneStyle(b.style);
    rememberSizeFor(page(), b);
  }
}

// The style a box is born with: `lastStyle` under the line's tag defaults,
// with the size taken from the line's own group when that group has been
// seen before. A group with no memory yet falls back to `lastStyle.size`.
export function inheritedStyleFor(ln) {
  const style = styleForLine(ln, applyBoxDefaults(cloneStyle(app.lastStyle)));
  const size = tagSize(sizeKeyFor(ln));
  if (size != null) style.size = size;
  return style;
}

// ---------- export prefs persistence ----------
try {
  const saved = JSON.parse(localStorage.getItem('mt.export') || '{}');
  if (saved.dir) app.exportDir = saved.dir;
  if (saved.name) app.exportName = saved.name;
} catch {
  /* ignore */
}
export function saveExportPrefs(dir, name) {
  if (dir != null) app.exportDir = dir;
  if (name != null) app.exportName = name;
  try {
    localStorage.setItem('mt.export', JSON.stringify({ dir: app.exportDir, name: app.exportName }));
  } catch {
    /* ignore */
  }
}

// ---------- persistence intervals ----------
// Four writers used to carry four numbers picked one at a time - 200ms for the
// panels, 800ms for the chapter, 800ms again for the history file, and nothing
// at all for the sidebar. Two tiers instead, split on what a write costs and on
// what losing one costs, so a new writer has a number to join rather than one to
// invent.
//
// PREF_SAVE_MS - a preference. A few hundred bytes of localStorage, synchronous,
// no filesystem and none of the user's work in it: panel geometry, sidebar
// width. Losing one costs a window position, so the window can be short. It is
// not zero because every writer in this tier is driven by a drag or a key
// repeat, and coalescing those is the whole point of the debounce.
//
// DOC_SAVE_MS - the user's work. The chapter's JSON and the undo history beside
// it, both real filesystem writes through the atomic-write path, both driven by
// continuous typing. Four times the preference interval because each write is
// orders of magnitude dearer, and shortening it would put a whole-document write
// between keystrokes. The longer loss window is not carried by the timer: every
// route out of the editor - leaving, quitting, opening another chapter - flushes
// both writers rather than waiting for it.
//
// The chapter and its history share the number deliberately. They describe the
// same document, and a history file written on a different beat than the pages
// it addresses is the one way the two can reach disk disagreeing about how many
// edits have happened.
export const PREF_SAVE_MS = 200;
export const DOC_SAVE_MS = 800;

// ---------- reference sidebar persistence ----------
// The rail drags the sidebar between a fixed floor and a window-relative
// ceiling; a value off disk gets the same clamp, so a hand-edited or stale
// entry can never wedge the sidebar at a width the rail itself would refuse to
// produce.
export const SIDEBAR_MIN = 200;
// The ceiling is a share of the window, not a fixed number of pixels. It used
// to be a flat 460, which on any monitor worth owning is about a fifth of the
// screen - and the raw page is reference material a letterer reads from, so a
// fifth is not enough. 460 survives as the FLOOR of the ceiling: on a small
// window, and in any environment that cannot measure one (the node tests, a
// module load before layout), the sidebar can still reach the width it always
// could.
export const SIDEBAR_MAX = 460;
export const SIDEBAR_MAX_SHARE = 0.4;
export function sidebarMaxWidth(viewportW) {
  const vw = Number.isFinite(viewportW)
    ? viewportW
    : typeof window === 'undefined'
      ? 0
      : window.innerWidth;
  return Math.max(SIDEBAR_MAX, Math.round(vw * SIDEBAR_MAX_SHARE));
}
export const clampSidebarWidth = (w, viewportW) =>
  clamp(w, SIDEBAR_MIN, sidebarMaxWidth(viewportW));
// What comes back out of storage is parsed and vetted here rather than inline
// below, because the read itself runs once at module load in an environment the
// tests do not have - split out, the part that can actually be wrong is the
// part that can be tested. Anything the rail could not have written is dropped
// rather than coerced: a width that is not a number, a `hidden` that is not a
// boolean, a blob that is not an object at all. Absent keys stay absent so the
// caller can tell "not stored" from "stored as the default".
export function sidebarFromJSON(raw) {
  let saved;
  try {
    saved = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (!saved || typeof saved !== 'object') return {};
  const out = {};
  if (Number.isFinite(saved.width)) out.width = clampSidebarWidth(saved.width);
  if (typeof saved.hidden === 'boolean') out.hidden = saved.hidden;
  return out;
}
// Same defensive shape as the export prefs above: read once at module load,
// written back through one function, every failure swallowed. Storage is
// absent entirely in the node test environment, and a corrupt entry must cost
// the user their sidebar width, not the editor.
try {
  const { width, hidden } = sidebarFromJSON(localStorage.getItem('mt.sidebar'));
  if (width != null) app.leftWidth = width;
  if (hidden != null) app.sidebarHidden = hidden;
} catch {
  /* ignore */
}
// Null whenever there is nothing pending, so `flushSidebar` can tell "the user
// moved the rail and the timer has not fired" from "there is nothing to write" -
// and a chapter nobody touched the sidebar in leaves no storage entry behind
// that it did not already have.
let sidebarT = null;
function writeSidebar() {
  try {
    localStorage.setItem(
      'mt.sidebar',
      JSON.stringify({ width: app.leftWidth, hidden: app.sidebarHidden }),
    );
  } catch {
    /* ignore */
  }
}
export function saveSidebar() {
  // Debounced, unlike the export prefs above, because the rail's arrow-key
  // contract calls this on every key that moved the edge - and a held arrow
  // auto-repeats, so an unbuffered write is dozens of serialisations a second
  // for a string nobody reads until the next launch. See PREF_SAVE_MS.
  clearTimeout(sidebarT);
  sidebarT = setTimeout(() => {
    sidebarT = null;
    writeSidebar();
  }, PREF_SAVE_MS);
}
// What the debounce cost, given back. This write used to be synchronous and so
// could not be lost; putting it on a timer opened a 200ms window in which ⌘Q
// destroys the window with the last drag of the rail still pending. The document
// and its history are drained on every route out of the editor (see
// `flushBeforeLeaving`) and this is the same obligation, one tier down - cheap,
// synchronous, and safe to call when there is nothing pending, because
// `clearTimeout` of a fired or never-set timer is a no-op and the write is
// idempotent.
//
// Only this store's preference. `panels.svelte.js` keeps a timer of exactly the
// same shape and has always had the same hole; closing it needs a flush export
// there, called from the same place this one is.
export function flushSidebar() {
  if (!sidebarT) return;
  clearTimeout(sidebarT);
  sidebarT = null;
  writeSidebar();
}

// ---------- registration seams ----------
// Four things outside the store want to hear about something the store does -
// the saver, the recorder, the page switch, the settle - and the store must stay
// unaware of who they are, or it would have to import the filesystem and the
// history and cycle with both.
//
// Each was one slot, which is fine right up until a second listener wants the
// same seam: the second registration silently displaced the first, so a panel
// that coalesces its edits would have taken the Inspector's settle away and
// neither of them would have said a word - the Inspector's edits would simply
// stop being recorded. So each seam keeps a list.
//
// Registration hands back its own unsubscribe, and that one is exact: it drops
// the entry it created and nothing else, so two subscribers can leave in either
// order. It is the only release the app itself uses - every registration in
// src/ now holds its unsubscribe and calls it.
//
// Passing anything that is not a function clears the seam outright. That is a
// blunt instrument and it is worth being honest about: `setSaver(null)` unhooks
// `saveOpenChapter` and every autosave in the app stops with nothing said. It is
// kept because the test suites lean on it as a teardown - a hook registered for
// one case must not leak into the next, and `null` is the spelling they use -
// and because taking it away would leave those releases as silent no-ops, which
// is the same hazard pointing the other way. Nothing in the app passes null; if
// you are reaching for it in src/, you want the unsubscribe.
function seam() {
  let subs = [];
  // A box per registration rather than the bare function: two subscribers that
  // registered the same function would otherwise share one identity, and the
  // first release would take both of them out.
  const subscribe = (fn) => {
    if (typeof fn !== 'function') {
      subs = [];
      return () => {};
    }
    const sub = { fn };
    subs = [...subs, sub];
    return () => {
      subs = subs.filter((s) => s !== sub);
    };
  };
  // Copy-on-write above, so a notify holds the list it started with: a
  // subscriber that unsubscribes from inside its own callback cannot make the
  // walk skip the one behind it. The results come back for the one seam that
  // has any - the saver's promises.
  const notify = (...args) => subs.map((s) => s.fn(...args));
  return { subscribe, notify, size: () => subs.length };
}

// ---------- save indicator + autosave ----------
// The saver is registered by library.svelte.js rather than imported, so the
// store stays unaware of the filesystem and the two modules do not cycle.
const savers = seam();
let saveT;
export function setSaver(fn) {
  return savers.subscribe(fn);
}
// Every registered saver, as one promise. Started off a resolved promise so a
// saver that throws synchronously comes back as a rejection like any other, and
// `Promise.all` hands on the first rejection untouched - flushSave's caller
// reads that reason to decide whether the user may leave the chapter.
const runSavers = () => Promise.resolve().then(() => Promise.all(savers.notify()));
export function markUnsaved() {
  app.saved = false;
  if (!savers.size() || !app.chapterRef) return;
  clearTimeout(saveT);
  // There is no manual save in this app, so a rejected autosave is the user's
  // only signal that their work is not reaching the disk. Never swallow it.
  saveT = setTimeout(() => {
    runSavers().catch((e) => {
      // A toast lasts two seconds; the work being off-disk lasts until a write
      // lands. The indicator carries the second half of that, so the user can
      // still find out why an hour later.
      app.saveFailed = true;
      toast(`Could not save: ${e?.message ?? e}`);
    });
  }, DOC_SAVE_MS);
}
export function markSaved() {
  // The debounce goes with the flag, and it has to: `markSaved` means "the disk
  // is current", and a timer left armed against work that has already landed
  // writes the whole document a second time 800ms later. On the way out of a
  // chapter that second write is not merely redundant - `openChapter` has by
  // then pointed `app.chapterRef` somewhere else, and the pages the stale timer
  // hands the saver are the ones it was told about when it was armed. Cancelled
  // here rather than by each caller, because this is the one function every
  // "already written" path already calls.
  clearTimeout(saveT);
  app.saved = true;
}
export function flushSave() {
  clearTimeout(saveT);
  // Every non-debounce save comes through here - leaving the editor, quitting,
  // opening another chapter - and this is the path most likely to be the one
  // that fails, because it is the one that runs when the user is on their way
  // out. It also cancels the debounce, so a rejection here leaves nothing
  // scheduled to raise the indicator later: without this catch the pill would
  // sit on its neutral dot promising a save that no longer exists. The error is
  // rethrown untouched - flushBeforeLeaving still decides whether the user may
  // go, and says why.
  return savers.size() && app.chapterRef
    ? runSavers().catch((e) => {
        app.saveFailed = true;
        throw e;
      })
    : Promise.resolve();
}

// ---------- edit recorder (undo/redo) ----------
// The store stays unaware of the history the same way it stays unaware of the
// filesystem: the history module registers itself, and a build with no history
// records nothing and behaves exactly as before.
const recorders = seam();
export function setRecorder(fn) {
  return recorders.subscribe(fn);
}
export function recordEdit(entry) {
  recorders.notify(entry);
}
// Registered the same way, for the same reason: only the page on screen keeps
// its undo stack in memory, so something has to hear about a page turn and swap
// it for the one on disk. The store must not be the module that knows that,
// hence a hook rather than an import.
const pageSwitchHooks = seam();
export function setPageSwitchHook(fn) {
  return pageSwitchHooks.subscribe(fn);
}
// And a third, for the edit that is still being made when something else
// happens. A panel that coalesces a run of changes into one entry - the
// Inspector's settle timer - always leaves a window in which an edit has been
// applied to the document and not yet recorded. `recordEdit` has no page
// awareness of its own: it pushes onto whichever stack is live at the moment it
// is called. So everything that would make a late entry land somewhere it does
// not belong - a page turn, an undo, the start of a drag - closes that window
// through here first.
const editSettleHooks = seam();
export function setEditSettleHook(fn) {
  return editSettleHooks.subscribe(fn);
}
export function settleEdits() {
  // Subscribers first, then the store's own inline edit, because that is the
  // order the user made them in: a panel's pending entry has been sitting in its
  // settle window for up to 400ms while the box on the canvas is still being
  // typed into. The other way round hands the user an undo that walks their own
  // session backwards - the panel's tweak comes off first, then the typing that
  // preceded it. Pinned by 'records a subscriber's pending entry before its own
  // inline edit' in store.test.js, which is the whole of the claim: flip these
  // two lines and it fails.
  editSettleHooks.notify();
  // The inline box edit is settled here rather than by each caller because this
  // is already what every path that would strand an unrecorded edit calls - the
  // page turn, the undo, the start of a drag, the way out of the chapter - and
  // the box being typed into is exactly as strandable as the panel's slider was.
  // A page turn mid-typing used to throw the record away outright; that is the
  // undo step it was costing.
  //
  // Recording only. `editingId` is deliberately left standing: `settleEdits`
  // also runs at the start of a drag, and closing the caret there would end an
  // edit the user is still in the middle of. Whoever actually ends the edit
  // nulls it, and both halves below are idempotent, so being called twice on the
  // way out records once.
  settleText();
  settlePending();
  settleNudge();
}
// The history addresses pages by id, not by index: an entry may outlive the
// page being the one on screen.
export const pageById = (id) => app.pages.find((p) => p.id === id) ?? null;

// A free-typed box is not history until the gesture that made it is over.
// Creating it and dropping it again empty are halves of one gesture, and
// recording them separately would cost two undo presses, the first of which
// brings back an empty box the user never wanted. So `addEmptyBox` only leaves
// the box pending, and whoever ends the edit settles it: one `place` record if
// the box survived, nothing at all if it did not.
let pendingPlace = null;
// What the box being edited read at the start of the part of the session that
// has not been recorded yet - the text the edit began with, until a settle
// records that far and re-arms this from where it left off (see `settleText`).
// `undefined` is the only value that means "nothing is armed", which is why
// `null` is used for a box with no text of its own: `endEdit` decides whether to
// record on `before !== undefined`.
//
// Held here rather than in the component that opened the edit, because that
// component is frequently not the one that ends it, and one entry per run of
// typing is only possible while somebody still remembers the text it started
// from.
let editBefore = undefined;
// And the box's fitted geometry at that same moment, for the same span of the
// session. Typing is the commonest way a box grows, so a `text` entry has to
// carry the height either side of it or an undo hands back the short text in the
// tall box - see `autoFitBox`. Kept beside `editBefore` rather than folded into
// it because `endEdit` takes an explicit before-*text* from callers that know
// better, and a pair there would mean every caller knowing about geometry too.
let editGeomBefore = null;
// Exported for the paths that put the whole document away: there is nothing
// left to record against, so the gesture is dropped rather than settled.
export const clearPending = () => {
  pendingPlace = null;
  editBefore = undefined;
  editGeomBefore = null;
  // The nudge window too: it names a page by id, and the document these paths
  // put away is the one that page belonged to.
  nudgePending = null;
  clearTimeout(nudgeT);
};
// Every path that ends an edit calls this - not just `endEdit`. `deselect` and
// `selectBox` null `editingId` on pointerdown, before the browser fires blur on
// the contenteditable, so the blur's `endEdit` finds nothing to end and returns
// early. Settling only there would leave the box pending for good, and the next
// `deleteBox` would mistake a real box full of real text for a gesture that
// never happened and record nothing - undo silently losing the user's work.
function settlePending() {
  const pend = pendingPlace;
  if (!pend) return;
  pendingPlace = null;
  const p = pageById(pend.pageId);
  // The index is read now rather than remembered from creation time: boxes may
  // have come and gone while the user was typing.
  const index = p ? p.boxes.findIndex((x) => x.id === pend.id) : -1;
  if (index === -1) return; // already gone - the gesture left nothing to undo
  // No queue fields: a free-typed box never touched `activeLineN`, and claiming
  // it did would make this undo rewind a queue move belonging to another edit.
  //
  // The line does ride along, and it has to: the gesture created a queue row as
  // well as a box, so an undo that took only the box back would leave a row in
  // the queue pointing at nothing - unplaceable (see `placeActiveAt`), holding
  // the text of a box that is no longer there, and impossible to get rid of
  // because the queue has no delete. See the `place` kind in history.svelte.js.
  recordEdit({
    t: 'place',
    pageId: p.id,
    index,
    box: $state.snapshot(p.boxes[index]),
    ...freeLineRecord(p, p.boxes[index]),
  });
}

// The free line a box created, as the two fields the history's `place` and
// `delete` kinds read: the line itself and where it sat in `p.lines`. Empty for
// every other box, so an entry about a queue-placed box carries no line fields
// at all and the history's `e.line == null` branch is the ordinary path.
function freeLineRecord(p, b) {
  if (!b || b.lineN == null || b.lineN >= 0) return {};
  const lineIndex = p.lines.findIndex((l) => l.n === b.lineN);
  if (lineIndex === -1) return {};
  return { line: $state.snapshot(p.lines[lineIndex]), lineIndex };
}

// The text half of ending an edit, and it has to live beside `settlePending`
// for exactly the same reason: the contenteditable writes `box.text` on every
// keystroke, so by the time anything ends the edit the document is already
// current - what is missing is the one record that stands for the whole
// session. And the blur that would carry it arrives after `deselect` or
// `selectBox` has already nulled `editingId`, so `endEdit` finds nothing to end
// and returns early. Left to the blur alone, every edit finished by clicking
// somewhere else would be applied and never recorded, and the next undo would
// rewind an edit the user did not just make.
//
// A box whose placement is still pending is left alone: `settlePending` records
// that gesture as one `place` carrying the typed text, and a `text` record
// beside it would be the same edit counted twice.
// Idempotent by re-arming rather than by forgetting, and the difference is the
// rest of the session. `editBefore` used to be cleared unconditionally on the
// way in, which does make a second call record nothing - but `endEdit`'s guard
// is `before !== undefined`, so everything typed *after* a mid-session settle
// was then recorded by nobody. Any caller that settles while the edit continues
// disabled the recording it was supposed to protect: `flushBeforeLeaving` on a
// save that fails throws instead of closing the chapter, and the user is bounced
// back into the editor with `editingId` still set and the before-text gone - for
// the rest of that session, silently.
//
// So the invariant is structural instead: while an edit session is live,
// `editBefore` is what the box read at the start of the part that has not been
// recorded yet. A settle records that part and starts the next one from where it
// left off. Only the absence of a session clears it.
function settleText() {
  const id = app.editingId;
  const before = editBefore;
  if (id == null) {
    editBefore = undefined;
    return;
  }
  const b = byId(id);
  // Re-armed from the document, which the editable has already written every
  // keystroke into - the same value `beginEdit` would have taken had the session
  // started here. A box that has gone leaves nothing to arm from.
  //
  // Through `boxOwnText`, not `b.text`, so a free-typed box is compared against
  // the field its own text actually lives in. Read off `b.text` it is null on
  // both sides of every edit, and every settle mid-session - a page turn, a
  // drag, the way out of the chapter - would decide nothing had changed and
  // record nothing.
  const geomBefore = editGeomBefore;
  editBefore = b ? boxOwnText(b) : undefined;
  editGeomBefore = b ? fitGeom(b) : null;
  if (before === undefined) return;
  if (pendingPlace?.id === id) return;
  const now = b ? boxOwnText(b) : null;
  if (!b || now === before) return;
  recordEdit({
    t: 'text',
    pageId: page().id,
    boxId: id,
    before: before ?? null,
    after: now,
    geomBefore,
    geomAfter: fitGeom(b),
  });
}

// ---------- toast ----------
let toastT;
export function toast(msg) {
  app.toast = { msg, seq: app.toast.seq + 1 };
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    app.toast = { msg: '', seq: app.toast.seq + 1 };
  }, 2200);
}

// ---------- page nav ----------
export function gotoPage(i) {
  if (i < 0 || i > app.pages.length - 1) return;
  // Before the index moves, and it has to be: an entry still inside its settle
  // window belongs to the page being left, and the stack that is live is the
  // only place it can be pushed. A step later and it would land on the page
  // being arrived at, where the next write would file that page's entries under
  // this one's key. That covers the inline edit too - the box being typed into
  // when the page turned used to have its record dropped on the way out, which
  // is one undo step the user paid for every page turn mid-edit.
  settleEdits();
  const from = page().id;
  app.pageIndex = i;
  app.selectedId = null;
  // The caret cannot follow the page. Nothing is thrown away closing it: the
  // settle above has already written the record and cleared the gesture, which
  // is what `clearPending` here used to do instead of.
  app.editingId = null;
  const p = page();
  if (p.activeLineN == null) p.activeLineN = firstUnplaced(p);
  // Only when the page actually changed. A re-entry onto the page already on
  // screen would otherwise hand the live stack over and take it straight back,
  // scheduling a write of a document nothing has changed.
  if (from !== p.id) pageSwitchHooks.notify(from, p.id);
}
export const nextPage = () => gotoPage(app.pageIndex + 1);
export const prevPage = () => gotoPage(app.pageIndex - 1);

// ---------- selection ----------
// Selecting a box ADOPTS its style: the next box placed follows the one the user
// last put their hands on, size and rotation included. Without this the only
// writers of `lastStyle` were the Inspector's own edits, so clicking a box and
// then placing another produced the style of whatever box was edited before it -
// the "one behind" the user kept hitting. Clicking is the whole of the gesture
// that says "this is the box I mean", so it is where the adoption belongs.
//
// `remember: false` is for the selections that are not a user pointing at a box:
// creating one. A newborn box's style is `lastStyle` already, plus whatever the
// line's TAG forced onto it (`styleForLine`) and the typesetting defaults - and
// feeding that back would make a tag's font leak onto every box placed after a
// tagged one, which is exactly what tags exist not to do.
//
// `activate` follows `remember` by default and for the same reason: a box the
// user pointed at - a click, a Tab - is the one the queue should be showing, so
// its row lights up and scrolls into view, exactly as clicking that row selects
// the box. The two directions are one relationship. A box selected because it
// was just created is not that: placement has already advanced the queue past
// it. Undo and redo pass `activate: false` explicitly, because they select with
// `remember` on and the entry being applied has already put `activeLineN` where
// it was when the edit happened. The Place tool is unaffected by the active
// line being one already on the page - see `placeActiveAt`.
export function selectBox(id, { remember = true, activate = remember } = {}) {
  // Text first: it is the half that has to see `pendingPlace` still standing.
  if (app.editingId && app.editingId !== id) {
    settleText();
    settlePending();
  }
  app.selectedId = id;
  if (app.editingId && app.editingId !== id) app.editingId = null;
  const b = id ? byId(id) : null;
  if (remember && b) rememberStyle(b);
  if (activate && b && b.lineN != null) page().activeLineN = b.lineN;
}
export function deselect() {
  if (app.editingId) {
    const b = byId(app.editingId);
    const own = b ? boxOwnText(b) : null;
    if (own != null && own.trim() === '' && isFreeBox(b)) {
      const id = app.editingId;
      app.editingId = null;
      app.selectedId = null;
      deleteBox(id);
      return;
    }
    settleText();
    settlePending();
  }
  app.selectedId = null;
  app.editingId = null;
}

// ---------- inline editing ----------
// `opts` is `selectBox`'s, and passed straight through: the only caller with an
// opinion is the one creating the box it is about to put a caret in.
export function beginEdit(id, opts) {
  // Re-entrant: the box carries the double-click that opens the edit, and the
  // contenteditable inside it has no handler of its own, so double-clicking a
  // word to select it lands here again on the box already being edited. Taking
  // the before-text again would move it forward to whatever has been typed
  // since, and the undo would then only rewind as far as the last double-click.
  const already = app.editingId === id;
  selectBox(id, opts);
  app.editingId = id;
  // Remembered here, at the one moment it is still true, so whoever ends the
  // edit records one entry for the session rather than one per keystroke.
  if (!already) {
    const b = byId(id);
    editBefore = boxOwnText(b);
    editGeomBefore = b ? fitGeom(b) : null;
  }
}
// `beforeText` is what the box read when the edit began. It is optional - left
// off, what `beginEdit` remembered is used, which is what every caller in the
// app relies on; an explicit one is for a caller that knows better.
export function endEdit(commitText, beforeText) {
  const id = app.editingId;
  const before = beforeText !== undefined ? beforeText : editBefore;
  app.editingId = null;
  if (id == null) return;
  // Below the early return on purpose: a blur that arrives after something else
  // has already ended the edit must not clear the before-text of an edit that
  // has since begun. Whoever ended it took this with them.
  editBefore = undefined;
  // Taken before the commit below, because that is what grows the box.
  const geomBefore = editGeomBefore;
  editGeomBefore = null;
  const b = byId(id);
  if (!b) return;
  // The blur or the Escape that changed nothing, on a box that reads its text
  // off its queue line.
  //
  // Such a box owns no text - `b.text` is null on purpose, so `boxText` resolves
  // through the line and the queue's textarea keeps reaching the canvas - and
  // `editBefore` is `boxOwnText`, which is that same null. But the editable
  // hands back what it was *displaying*, which is the line's string. Compared as
  // they stand, an untouched blur reads as "null became 'Hello'": `setBoxText`
  // writes that string onto the box as an override, the box stops following its
  // line for ever, and `recordEdit` pushes a history entry for an edit nobody
  // made. Double-clicking a box to look at it and clicking away was enough.
  //
  // So the no-op is recognised against what the box *displays* rather than
  // against what it owns. Only for a queue-placed box: a free-typed one (lineN
  // < 0) has its text on its line by design and `boxOwnText` already reads the
  // same field on both sides, and a legacy box (lineN == null) owns its string
  // outright. Ahead of everything below because there is nothing to commit,
  // nothing to record and nothing to mark unsaved - the document is exactly as
  // it was found.
  if (b.lineN != null && b.lineN > 0 && b.text == null && commitText === boxText(b, page())) return;
  if (commitText != null) {
    setBoxText(b, commitText);
    markUnsaved();
  }
  // drop an empty placeholder box the user never typed into - and, with it, the
  // queue line the gesture created. `isFreeBox` rather than `lineN == null`
  // because a free box now has a line: read the old way, a box typed today
  // survived empty and left a blank row in the queue forever.
  const own = boxOwnText(b);
  if (own != null && own.trim() === '' && isFreeBox(b)) {
    deleteBox(id);
    return;
  }
  // The box survived, so the gesture that created it is now worth one record -
  // with the text the user actually typed, not the empty string it was born
  // with. Its own `text` record would be the same gesture counted twice.
  if (pendingPlace?.id === id) {
    settlePending();
    return;
  }
  if (before !== undefined && commitText != null && commitText !== before) {
    recordEdit({
      t: 'text',
      pageId: page().id,
      boxId: id,
      before: before ?? null,
      after: commitText,
      // Null when the caller supplied its own before-text without ever having
      // opened an edit session here (`endEdit('hi', '')`), which is a caller
      // that knows the text and cannot know the geometry. The history falls back
      // to a fit in that case, exactly as it does for an entry off disk.
      geomBefore,
      geomAfter: fitGeom(b),
    });
  }
}

// ---------- page dimensions (the page's coordinate space) ----------
// `p.w`/`p.h` are not a note about the file on disk - they ARE the page's
// coordinate space. Every box's x/y/w/h is expressed in it, `.page-frame` is
// `p.w * zoom` by `p.h * zoom`, and `.page-img` inside that frame is
// `width:100%; height:100%`. Nothing letterboxes. So a page whose w/h disagree
// with the natural size of the image drawn in it does not show a mismatch, it
// *stretches the art*, silently, and the zoom percentage becomes a ratio
// against numbers nothing else in the app agrees with. One invariant carries
// all of that:
//
//   p.w/p.h == the natural size of the image the canvas draws in the frame
//              (`p.cleaned ?? p.raw`), at every zoom, on every page.
//
// Exactly two states are legal. A page that has learned its space (both
// positive), and a page that has not yet - `w:0,h:0`, which is what
// `createChapter` writes for every page it copies, because it never decodes the
// images. The second is not a size, it is "unknown", and the difference is why
// this asks for a *positive* pair rather than a truthy one: 0 must never be
// treated as a measurement, or a 0-wide frame becomes a real coordinate space
// that boxes get clamped into.
export const hasPageSpace = (p) =>
  Number.isFinite(p?.w) && Number.isFinite(p?.h) && p.w > 0 && p.h > 0;

// The page an image belongs to, identified by the URL that loaded - never by
// "whichever page is on screen now". `raw`/`cleaned` are per-page object URLs,
// unique by construction, so this is an exact answer with no timing in it. The
// alternative, which is what this used to do, is a race the user pays for: an
// image decode that finishes after a page turn writes the size of the page
// being *left* onto the page being *arrived at*, and on a chapter with a
// double-page spread in it that is one page permanently drawn stretched, saved
// to disk that way.
export function pageForSrc(src) {
  if (!src) return null;
  return app.pages.find((p) => p.cleaned === src || p.raw === src) ?? null;
}

// Everything on the page that is expressed in page coordinates, moved from the
// old space into the new one. Boxes are the user's typesetting; `detect.boxes`
// and `detect.panels` are the detector's geometry, which the detected-text JSON
// export writes out and the PSD round-trip carries. Both are in page
// coordinates, so both move, or the two halves of the page end up describing
// different pictures.
//
// Not recorded in the undo history, deliberately. This is not an edit the user
// made; it is the document being brought back into agreement with its own art,
// and an undo of it would put every box back into a coordinate space that no
// longer exists.
//
// Exported because the canvas is not the only place a page's art is replaced.
// The sources sheet swaps a chapter's cleaned rasters while the chapter is
// CLOSED (see `replaceCleanedPages` and friends in library.svelte.js), and those
// paths rewrite `w`/`h` in the record directly - so they need the same move,
// applied to the same fields, or the two would drift into different ideas of
// what a page's coordinate space contains. It reads and writes plain fields
// only, so a record page off disk is as valid an argument as a live one.
// One factor for everything that is a LENGTH rather than a position: a font
// size, a stroke width, a blur radius. Positions and extents have an axis and
// take `sx` or `sy`; a length does not, and under a non-uniform rescale there is
// no single number that is right for it. The geometric mean is the answer that
// is wrong by the least: it preserves area, so a 2x-wide 0.5x-tall page leaves
// the text the same weight it had, and it degrades to exactly `sx` (== `sy`) for
// the uniform rescale, which is what every real resolution change is.
//
// Non-uniform rescale is a change of ASPECT - a cleaner redelivering at a shape
// the art never had - and nothing on the page survives that faithfully. This is
// documented rather than guarded because the alternative, refusing to move the
// style at all, is the bug this exists to close: text quoted in the old page's
// pixels rendered against the new page's, which at a 2x resolution bump is
// half-size text with hairline strokes on every box in the chapter.
export const lengthScale = (sx, sy) => Math.sqrt(sx * sy);

// Everything in a style that is quoted in page pixels, moved into the new space.
// The rest of the style - colours, alignments, fractions like the gradient stops
// and `pattern.scale` (a multiple of `size`, so it follows for free) - is
// resolution-independent and is carried across untouched.
//
// Returns a NEW style, and new arrays inside it, rather than mutating: the
// closed-chapter path (`respacePage` in library.svelte.js) hands this the pages
// it read off disk with the boxes only shallow-copied, and a rollback that found
// the record's own style objects already scaled would write the new geometry
// back under the old images.
export function rescaleStyle(st, sx, sy) {
  if (!st || typeof st !== 'object') return st;
  const s = lengthScale(sx, sy);
  if (!Number.isFinite(s) || s <= 0 || (s === 1 && sx === 1 && sy === 1)) return st;
  const len = (v) => (Number.isFinite(v) ? v * s : v);
  const out = { ...st };
  out.size = len(st.size);
  // The whole-text gaussian, in page px, and the tracking between glyphs, which
  // `measure.js` and the exporter both scale against `size` in the same space.
  out.blur = len(st.blur);
  out.letterSpacing = len(st.letterSpacing);
  if (Array.isArray(st.strokes)) out.strokes = st.strokes.map((k) => ({ ...k, width: len(k.width) }));
  if (Array.isArray(st.shadows)) {
    // A shadow's offset is a position with an axis, so it takes the axis factor
    // exactly; its blur is a length and takes the mean, like every other length.
    out.shadows = st.shadows.map((sh) => ({
      ...sh,
      x: Number.isFinite(sh.x) ? sh.x * sx : sh.x,
      y: Number.isFinite(sh.y) ? sh.y * sy : sh.y,
      blur: len(sh.blur),
    }));
  }
  if (st.roughen && typeof st.roughen === 'object') {
    // `amount` is a displacement in page px; `detail` is the noise's frequency,
    // which is cycles PER page px - so it moves the other way, or the same
    // roughening comes back as a different grain on a rescaled page.
    out.roughen = {
      ...st.roughen,
      amount: len(st.roughen.amount),
      detail: Number.isFinite(st.roughen.detail) ? st.roughen.detail / s : st.roughen.detail,
    };
  }
  if (st.ink && typeof st.ink === 'object' && Array.isArray(st.ink.strokes)) {
    out.ink = {
      ...st.ink,
      strokes: st.ink.strokes.map((k) => scaleStroke(k, sx, sy)),
    };
  }
  return out;
}


// The balloon a box was fitted to is page geometry like the box's own
// rectangle, and it moves with it. Left behind, a chapter whose cleaned raster
// arrives at another resolution would keep every box's text laid out to a
// curve measured in the old coordinate space - the boxes would follow the art
// and their line breaks would not. An axis-aligned ellipse scaled per axis is
// still an axis-aligned ellipse, so this is exact for both kinds.
const scaleFit = (f, sx, sy) => {
  if (!f) return f;
  if (f.kind === 'ellipse') {
    return { kind: 'ellipse', cx: f.cx * sx, cy: f.cy * sy, rx: f.rx * sx, ry: f.ry * sy };
  }
  if (f.kind === 'rect') {
    return { kind: 'rect', x: f.x * sx, y: f.y * sy, w: f.w * sx, h: f.h * sy };
  }
  return null;
};

export function rescalePageGeometry(p, sx, sy) {
  for (const b of p.boxes ?? []) {
    // The rectangle. A rotated box is stored as an axis-aligned x/y/w/h plus
    // `style.rotation`, so a NON-UNIFORM rescale of it is an approximation: the
    // exact image of a rotated rectangle under an anisotropic map is a
    // parallelogram, which this document has no way to express, and the shear
    // is dropped. It is exact for every uniform rescale (every resolution
    // change) and for any box at rotation 0, which between them is everything
    // but a redelivery at a different aspect ratio - where the art itself has
    // been reshaped and no placement survives faithfully anyway.
    b.x *= sx;
    b.y *= sy;
    b.w *= sx;
    b.h *= sy;
    if (b.fit) b.fit = scaleFit(b.fit, sx, sy);
    // The type is page geometry too. Without this the boxes follow the art and
    // the text inside them does not: a chapter re-cleaned at 2x came back with
    // every line half the size it was drawn at, hairline strokes and shadows
    // that had come loose from the glyphs - all of it invisible until the
    // export, because the record looked perfectly consistent.
    b.style = rescaleStyle(b.style, sx, sy);
  }
  const d = p.detect;
  if (!d) return;
  const scaleBox = (box) =>
    Array.isArray(box) && box.length === 4
      ? [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]
      : box;
  d.panels = (d.panels ?? []).map(scaleBox);
  for (const db of d.boxes ?? []) {
    db.box = scaleBox(db.box);
    // A glyph height, so it follows the vertical scale. Wrong only for a
    // non-uniform rescale, which is a change of aspect - the case where no
    // single number is right and the box geometry beside it is already the
    // thing that matters. Deliberately NOT `lengthScale` like the style's own
    // `size` above: this is the detector's measurement of the source art, an
    // upright glyph's height in the space it was detected in, and the axis it
    // was measured along is known. The style's `size` has no axis at all.
    if (Number.isFinite(db.font_size)) db.font_size *= sy;
    // The balloon measured for the block, when one was (`placeDetectedInChapter`).
    if (db.fit) db.fit = scaleFit(db.fit, sx, sy);
  }
}

// The one way a page's coordinate space is ever set or changed. Pinned to a
// page rather than reading `page()`, so the caller has to say which page the
// measurement is about - see `pageForSrc`.
//
// Returns whether anything moved, so a caller that has to react (the canvas
// refits) can tell a real change from a re-confirmation of what was already
// true.
export function setPageDims(p, w, h) {
  // A failed decode reports 0. Adopting that would erase the space rather than
  // measure it, and every box on the page would clamp to the origin.
  if (!p || !(w > 0) || !(h > 0)) return false;
  if (p.w === w && p.h === h) return false;
  // Nothing was authored in a space that did not exist, so there is nothing to
  // move: this is the first honest measurement the page has ever had. It is
  // also the common case - `createChapter` writes `w:0,h:0` for every page, and
  // a page only learns better by being opened in the canvas or detected on.
  const known = hasPageSpace(p);
  const sx = known ? w / p.w : 1;
  const sy = known ? h / p.h : 1;
  p.w = w;
  p.h = h;
  // A page that already had a space and now has a different one is a page whose
  // art was replaced - a cleaned raster at another resolution arriving over a
  // page that has already been typeset is the way this happens. The boxes were
  // authored over that art and have to follow it, or the fix for the stretch
  // would itself move every line off the bubble it was placed in.
  if (known) rescalePageGeometry(p, sx, sy);
  // Whether it was a first measurement or a rescale, the document on disk no
  // longer matches what is in memory. Left unsaved, a chapter re-learns its
  // page sizes one visit at a time, every session, and every page nobody opened
  // stays at 0x0 for the exporter to find.
  markUnsaved();
  return true;
}

// What the canvas actually calls: an image finished decoding, here is the URL it
// loaded and the size it turned out to be. Returns the page it landed on, or
// null when no page owns that URL.
export function setPageDimsForSrc(src, w, h) {
  const p = pageForSrc(src);
  if (!p) return null;
  setPageDims(p, w, h);
  return p;
}

// ---------- tool mode ----------
// The tools the canvas knows how to answer to. `pan` is the hand: it drags the
// viewport and nothing else, which is the one tool where a stray click cannot
// leave a box behind. Anything outside this list is refused rather than stored:
// an unknown tool is not an inert no-op, it is a canvas where every press falls
// through to `deselect` and the only way out is pressing another tool.
export const TOOLS = ['place', 'text', 'brush', 'pan'];
let brushToolAllowed = false;
export function setBrushToolAllowed(allowed) {
  brushToolAllowed = !!allowed;
}
export const isBrushToolAllowed = () => brushToolAllowed;

export function setTool(t) {
  if (!TOOLS.includes(t)) return;
  // A translate chapter has no place and no text tool - the rail hides both and
  // the canvas is there to be read, not typeset on. Refused here rather than at
  // each caller: the rail buttons, the v/t keyboard shortcuts and anything added
  // later all arrive through this one door, and a tool the canvas would honour
  // must never be reachable in a mode whose whole point is that it cannot add a
  // box. See `placeActiveAt`/`addEmptyBox` for the second, deeper guard.
  if (isTranslateMode() && t !== 'pan') return;
  if (t === 'brush' && !brushToolAllowed) return;
  app.tool = t;
  // The brush is the one tool with a mode of its own. Choosing it from the rail
  // arms drawing; leaving it disarms, so a stray drag on the page after
  // switching to the hand cannot lay down ink.
  setBrushMode(t === 'brush' ? 'draw' : null);
}

// ---------- the chapter's workflow mode ----------
// A chapter is either being typeset - everything this app has ever done - or
// translated, which is the raw page, the queue and nothing else. It is stored in
// chapter.json; a file with no `mode` at all reads as 'typeset', which is what
// every chapter on disk before this existed actually is.
export const CHAPTER_MODES = ['typeset', 'translate'];
export const normalizeChapterMode = (m) => (CHAPTER_MODES.includes(m) ? m : 'typeset');
// A function rather than a `$derived`: it is read from plain modules as well as
// from components, and read inside a component's `$derived` it tracks `app`
// exactly as a direct property read would.
export const isTranslateMode = () => app.chapterMode === 'translate';

// ---------- the project's page layout ----------
// A project is either a stack of pages the reader turns - every project this app
// has ever made - or a webtoon longstrip, where the chapter is one column of
// slices with nothing between them and "page" is only a record of where the file
// was cut. It is chosen when the project is created and stored in project.json;
// a file with no `layout` reads as 'pages', which is what every project on disk
// before this existed actually is.
//
// It belongs to the PROJECT rather than the chapter: a series is drawn one way
// or the other and a chapter that disagreed with its neighbours would be a
// chapter the reader cannot read. So chapters inherit it and there is no
// per-chapter override.
export const LAYOUTS = ['pages', 'longstrip'];
export const normalizeLayout = (l) => (LAYOUTS.includes(l) ? l : 'pages');
// Same shape and same reasoning as `isTranslateMode` above.
export const isLongstrip = () => app.projectLayout === 'longstrip';

// ---------- the project's OCR language ----------
//
// Kept as compact ISO 639-1 codes on disk and over IPC. Every project written
// before this existed was detected with manga-ocr, so an absent or unknown
// value is Japanese. The visible choice is offered for longstrip projects,
// where manhwa/manhua need their own recognizers.
export const OCR_LANGUAGES = ['ja', 'zh', 'ko'];
export const normalizeOcrLanguage = (language) =>
  OCR_LANGUAGES.includes(language) ? language : 'ja';

// Make `p` the current page, if it is not already. In a strip every page is on
// screen at once, so a click, a drag or a caret can land on a page the index is
// not pointing at - and the index is what selection, the undo stack and the
// queue are all scoped to. Moving it is not a page turn the user asked for; it
// is the index catching up with where they are already working.
//
// Routed through `gotoPage` rather than writing the index, so the history swap
// and the queue's `activeLineN` still happen exactly once per change. A no-op in
// a paged document, where the page under the pointer is the current one by
// construction.
export function focusPage(p) {
  if (!p) return;
  const i = app.pages.indexOf(p);
  if (i >= 0 && i !== app.pageIndex) gotoPage(i);
}

// ---------- apply the detection result to the current page ----------
// result = { img_width, img_height, panels, lines:[{n,type,jp,en,box,vertical,font_size}] }
//
// `img_width`/`img_height` are the decoded size of the image the engine was
// handed - `src-tauri/src/detect/engine.rs` decodes the bytes once and
// `detect::analyze` reports that image's dimensions, with no resize anywhere
// between - and every `box` below is in that space. So they are not a second opinion
// about the page's size that can simply be written over the first: they are the
// frame of reference the boxes are quoted in.
//
// Which makes the old behaviour - overwrite `p.w`/`p.h` and keep the boxes -
// exactly backwards. The canvas draws `p.cleaned ?? p.raw`, detection runs on
// `p.raw`, and the moment a chapter has a cleaned raster at a different
// resolution the page adopted the raw's size and stretched the cleaned art
// into it. The page's space belongs to the art on screen; the detector's
// geometry is mapped into it.
export function applyDetection(result, target = null) {
  const p = target ?? page();
  const dw = result.img_width;
  const dh = result.img_height;
  // A page with no space yet has nothing to map into and nothing to contradict,
  // and the detector has just decoded the raw at full size - so this is the one
  // case where its numbers are the page's numbers. `setPageDims` is what writes
  // them, so the "nothing was authored in a space that did not exist" reasoning
  // stays in one place.
  if (!hasPageSpace(p)) setPageDims(p, dw, dh);
  const sx = hasPageSpace(p) && dw > 0 ? p.w / dw : 1;
  const sy = hasPageSpace(p) && dh > 0 ? p.h / dh : 1;
  const intoPage = (box) =>
    Array.isArray(box) && box.length === 4
      ? [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]
      : box;
  // The detector's lines replace the page's, and what the USER put on those
  // lines does not go with them. Read `en: ''` - which is what this was - the
  // first re-detection of a page threw away every translation on it and every
  // row the user had typed, with no undo entry and no warning. Re-detecting is
  // an ordinary thing to do (a better model, a cleaned raster, a page that came
  // out wrong the first time); losing an afternoon of translation to it is not.
  //
  // What carries, and the rule for each, because "keep the user's work" is not
  // one rule:
  //
  //   en    kept when a line with the same `n` was already there AND its `jp` is
  //         unchanged. Detection renumbers from 1 in reading order on every run,
  //         so `n` alone is not a durable identity - one bubble found that was
  //         missed before shifts every number after it. The Japanese is the
  //         durable half: same number, same `jp` means the detector found the
  //         same sentence again and the English typed against it still belongs
  //         to it. A changed `jp` means that number now names a different
  //         sentence, and carrying the old English onto it would put a
  //         confident, wrong translation in the queue - strictly worse than an
  //         empty row, which the user can see is empty.
  //   tags  carried by `carryTagsForward`, by number alone. Deliberately the
  //         looser rule, and deliberately the same one the JSON re-import path
  //         already applies to the same wholesale replacement: a tag is
  //         queue-side markup, one click to apply and one click to remove, so
  //         the cost of carrying one onto the wrong row is not the cost of
  //         carrying a translation onto it. One rule for "lines replaced
  //         wholesale" beats two that drift.
  //   free  lines (`n < 0`) are rows the user typed onto the page. The detector
  //         has no opinion about them - it never saw them and cannot renumber
  //         them, since its numbers start at 1. `carryTagsForward` appends them
  //         untouched, exactly as it does on a re-import.
  const before = new Map(p.lines.map((l) => [l.n, l]));
  p.lines = carryTagsForward(
    p.lines,
    result.lines.map((l) => {
      const jp = l.jp ?? '';
      const was = before.get(l.n);
      return {
        n: l.n,
        type: l.type,
        jp,
        en: was && (was.jp ?? '') === jp ? (was.en ?? '') : '',
        ...(l.lang != null ? { lang: l.lang } : result.lang != null ? { lang: result.lang } : {}),
      };
    }),
  );
  // Detection geometry kept separately - read by the detected-text JSON export
  // and carried through the PSD round-trip. In page coordinates, like every
  // other geometry the document stores, which is what `intoPage` is for:
  // unscaled it would be in whatever space the engine happened to decode, and
  // the two would only agree by luck.
  p.detect = {
    panels: (result.panels ?? []).map(intoPage),
    boxes: result.lines.map((l) => ({
      n: l.n,
      box: intoPage(l.box),
      vertical: l.vertical,
      font_size: Number.isFinite(l.font_size) ? l.font_size * sy : l.font_size,
      ...(l.lang != null ? { lang: l.lang } : result.lang != null ? { lang: result.lang } : {}),
    })),
    ...(result.lang != null ? { lang: result.lang } : {}),
  };
  // The typeset boxes go. Every one of them is bound to a line number the
  // detector has just reassigned, so keeping them would leave boxes rendering
  // whatever sentence now happens to hold their old number.
  //
  // The free-typed ones stay, and they have to: their lines survive the
  // replacement above, and a surviving line whose box was wiped is precisely
  // the orphan row `deleteBox` goes out of its way never to leave - unplaceable
  // (`placeActiveAt` refuses a line that is already placed by construction),
  // undeletable (the queue has no such control), holding the text of a box that
  // is gone. The box and its line survive together or neither does. A legacy
  // free box (`lineN == null`) has no line at all and owns its own string, so it
  // survives for the simpler reason that nothing here renumbered anything it
  // depends on.
  const kept = new Set(p.boxes.filter(isFreeBox).map((b) => b.id));
  // Two ids can still be pointing into the half that is about to go. Left
  // standing, `selectedId` names a box the Inspector and every keyboard action
  // then look up and fail to find, and `editingId` is worse than dangling:
  // App.svelte reads it as "the user is mid-edit" and returns before any global
  // shortcut is reached, so the whole keyboard stays dead until something else
  // happens to clear it.
  //
  // Cleared rather than settled. The wipe is not an edit and records nothing -
  // there is no entry for a `text` record to sit beside, and an entry describing
  // a box the next line removes would only give undo something to fail on. This
  // is the case `clearPending` exists for: the document is being put away, so
  // the gesture in flight is dropped rather than recorded.
  const wiping = (id) => id != null && !kept.has(id) && p.boxes.some((b) => b.id === id);
  const dropSel = wiping(app.selectedId);
  const dropEdit = wiping(app.editingId);
  if (dropSel) app.selectedId = null;
  if (dropEdit) {
    app.editingId = null;
    clearPending();
  }
  p.boxes = p.boxes.filter((b) => kept.has(b.id));
  p.activeLineN = firstUnplaced(p);
  app.loaded = true;
  markUnsaved();
}

// ---------- placement ----------
// The box a click places used to be 220x92 whatever it was placed on, which is
// a number chosen for a page nobody has seen. Detection already knows better:
// `applyDetection` stores `p.detect.boxes = [{ n, box: [x1,y1,x2,y2], ... }]` in
// page coordinates, one rect per detected line, and that rect is where the
// Japanese actually sat - so it is the size and the position the English wants.
//
// Two ways to find the rect, in this order:
//   the line's own      the queue row being placed has detected geometry. This is
//                       the normal case and the right answer even if the user
//                       clicks slightly off the bubble.
//   the one clicked in  no geometry for this line, but the click landed inside
//                       some other detected rect. The user is pointing at a
//                       bubble; use it.
// Neither, and the old constants stand. A page that was never detected, or a
// free-typed box, keeps behaving exactly as it did.
//
// The rect is inset before it becomes a box, because a detected rect is drawn
// tight around ink and text pressed against a bubble's outline is the thing
// letterers spend their time avoiding. The inset scales with the rect, so a
// small SFX label is not eaten by a margin sized for a full page of dialogue,
// and it is bounded at both ends so it is never invisible and never dominant.
//
// Pure, and exported, because "what size is a box on this bubble" is arithmetic
// worth pinning down in a test without a canvas anywhere near it.
const BUBBLE_INSET = 0.08; // of the rect's shorter side
const BUBBLE_INSET_MIN = 3;
const BUBBLE_INSET_MAX = 14;
// The floors the resize handles already enforce (`Math.max(40, ...)` /
// `Math.max(30, ...)` in TextBox), so placement cannot produce a box smaller
// than a drag is allowed to make one.
const MIN_BOX_W = 40;
const MIN_BOX_H = 30;
const insideRect = (r, x, y) =>
  Array.isArray(r) && r.length === 4 && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
// The whole detection entry, not just its rect: placement needs `vertical` too,
// and the two have to come from the SAME entry or a page with two overlapping
// bubbles could take its rectangle from one and its orientation from the other.
export function detectedEntryFor(p, lineN, imgX, imgY) {
  const dets = p?.detect?.boxes ?? [];
  const own = dets.find((d) => d.n === lineN && Array.isArray(d.box) && d.box.length === 4);
  if (own) return own;
  return dets.find((d) => insideRect(d.box, imgX, imgY)) ?? null;
}
export function detectedRectFor(p, lineN, imgX, imgY) {
  return detectedEntryFor(p, lineN, imgX, imgY)?.box ?? null;
}

// The detected block, transposed about its own centre: a rect `rw` x `rh` comes
// back `rh` x `rw`, centred where it was.
//
// This is the answer to a `vertical: true` detection, which means the Japanese
// in that block is set in a column - tall and narrow, and the block is drawn
// tight around it. English wants precisely the opposite shape in the same
// bubble, so placing a box at the block's own aspect puts a wide language into a
// rectangle shaped for a narrow one, and every line breaks after one or two
// words.
//
// It is deliberately only a fallback. When a balloon fit succeeded, the
// inscribed rectangle of the fitted shape has already answered the question with
// the actual geometry of the actual bubble - it is wide because the bubble is
// wide, not because a heuristic swapped two numbers - and transposing on top of
// that would be a second, worse opinion applied to a good answer. So this runs
// only where there is no fit, and `placeActiveAt` says so at the call site.
export function transposeRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4) return rect;
  const [x1, y1, x2, y2] = rect;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rw = Math.abs(x2 - x1);
  const rh = Math.abs(y2 - y1);
  return [cx - rh / 2, cy - rw / 2, cx + rh / 2, cy + rw / 2];
}

// How much of a fit has to be believed before a box is sized from it.
//
// `fitBalloonShape` has already refused everything it considers unexplained -
// an escaped fill, a jagged burst, a thought cloud - so anything arriving here
// with a shape passed its residual, coverage and span gates. This is the second
// gate, and it is cheap insurance rather than a duplicate: the accepted band
// runs all the way down to a confidence of 0 (a fit whose residual sits exactly
// on `maxResidual`), and a shape believed that little is one the detector's own
// rectangle is a better answer than. Real fits on real bubbles score above 0.8.
const MIN_FIT_CONFIDENCE = 0.5;

// The box geometry a fitted shape implies: `balloonFrame` - the balloon less the
// safety inset `balloon.js` applies for us, as wide as it is at its widest and
// as tall as its inscribed rectangle - pushed onto the page by the same clamp
// `placementRect` uses.
//
// It used to be the inscribed rectangle, whose width is about 70% of the
// balloon's. The lines are capped at the box, so every one of them came out that
// wide and a fitted box laid its text out as a rectangle (GEO-1). At the full
// width the balloon's rows decide every line and the box still holds them all.
//
// Flush text still gets the inscribed rectangle. Only centred text follows the
// balloon's rows (`balloonWidthsFor`); a left- or right-aligned block sets flat
// from the box's edge, and the one rectangle whose every row is inside the curve
// is the inscribed one.
//
// Pure and exported for the same reason `placementRect` is - "what size is a box
// on this bubble" is arithmetic worth pinning down without a canvas anywhere
// near it.
export function fittedRect(p, shape, align) {
  const r = align === 'left' || align === 'right' ? inscribedRect(shape) : balloonFrame(shape);
  if (!r || !(r.w > 0) || !(r.h > 0)) return null;
  const w = Math.max(MIN_BOX_W, r.w);
  const h = Math.max(MIN_BOX_H, r.h);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const onPage = (v, size, extent) =>
    extent > 0 ? clamp(v, 0, Math.max(0, extent - size)) : Math.max(0, v);
  return { x: onPage(cx - w / 2, w, p?.w ?? 0), y: onPage(cy - h / 2, h, p?.h ?? 0), w, h };
}

// Fit the balloon around a block of page coordinates, or answer null.
//
// Every one of the ways this returns null is a real, expected case rather than
// an error path, and together they are the fallback contract placement rests on:
//
//   no pixels    the page has not been decoded into the cache - a chapter just
//                opened, a page never looked at, or the node test environment,
//                which has no canvas at all.
//   no block     nothing was detected behind this line and the click landed on
//                bare paper, so there is nowhere to seed a fill from.
//   irregular    `balloon.js` looked and refused: a thought cloud, an SFX burst,
//                a profile it cannot explain. `shape` is null on that verdict.
//   escaped      the fill got out through a gap in the outline, so what it
//                measured is the paper around the bubble rather than the bubble.
//                Refused explicitly here as well as inside `fitBalloonShape`,
//                because this is the failure that would be worst if it ever got
//                through: an escaped fill very often fits a beautiful rectangle.
//   unconvincing the fit is below `MIN_FIT_CONFIDENCE`.
//
// Every one of them lands the caller on exactly today's behaviour.
//
// `pixels` is for a caller that has the page's pixels in hand rather than in the
// click cache - the chapter-wide measure (`placeDetectedInChapter`).
export function balloonFitFor(p, block, pixels) {
  if (!Array.isArray(block) || block.length !== 4) return null;
  const image = pixels ?? pagePixelsFor(p);
  if (!image) return null;
  const res = detectBalloon(image, block);
  if (!res || !res.shape || res.escaped) return null;
  if (!(res.confidence >= MIN_FIT_CONFIDENCE)) return null;
  const shape = normalizeFit(res.shape);
  // And one last one: a balloon so small that the safety inset eats it whole
  // leaves no rectangle to put text in. `interiorLineWidths` would answer its
  // own floor of one pixel for every line, which no line breaker can do anything
  // sensible with. A shape with no room in it is not a shape worth keeping.
  const room = shape && inscribedRect(shape);
  if (!room || !(room.w > 0) || !(room.h > 0)) return null;
  return shape;
}

// The same answer, from a CLICK instead of a detected block.
//
// `balloonFitFor` above needs the detector to have run, and for the line being
// placed to have geometry in it. Neither is true of the common case this exists
// for: the user has a translation in the queue, the page was never analysed (or
// the detector missed this bubble), and all they do is point at the balloon they
// want the text in. That gesture carries exactly one piece of information - the
// point - and the page's own pixels can turn it into the same shape a detection
// would have produced, because the balloon is drawn on the page whether or not
// anything has looked for it.
//
// Every guard `balloonFitFor` applies applies here too, for the same reasons,
// plus one that is specific to a click:
//
//   the shape must contain the click. The fill is seeded at the pointer so the
//   REGION contains it by construction, but the fitted shape is an approximation
//   of that region, and an ellipse fitted to a bubble the user clicked near the
//   rim of can end up excluding the very point they aimed at. Sizing a box from
//   such a fit moves it somewhere they did not point, which reads as the click
//   having been swallowed. Falling back puts the box under the pointer, which is
//   the one thing the gesture unambiguously asked for.
//
// The solid-colour test that comes first lives in `detectBalloonAt`, and it is
// what makes this safe to call on every placement rather than only on the ones
// somebody expects to succeed: a click on artwork is refused by a 13x13 sample
// of pixels and never reaches a flood fill.
export function balloonFitAt(p, imgX, imgY, pixels) {
  if (!Number.isFinite(+imgX) || !Number.isFinite(+imgY)) return null;
  const image = pixels ?? pagePixelsFor(p);
  if (!image) return null;
  const res = detectBalloonAt(image, imgX, imgY);
  if (!res || !res.shape || res.escaped) return null;
  if (!(res.confidence >= MIN_FIT_CONFIDENCE)) return null;
  const shape = normalizeFit(res.shape);
  if (!shape) return null;
  if (!shapeContainsPoint(shape, imgX, imgY)) return null;
  const room = inscribedRect(shape);
  if (!room || !(room.w > 0) || !(room.h > 0)) return null;
  return shape;
}

// Is this detected block a column whose rectangle should be transposed for
// horizontal translated text?
//
// `vertical` is the detector's own answer and is believed whenever it gives one,
// in both directions. The fallback is for the case it says nothing at all - an
// older detection, a hand-written chapter.json, a sidecar that did not report the
// field. Korean blocks only use an explicit vertical flag: Hangul in a tall
// bubble can still be horizontal text and must keep that bubble's shape.
//
// It matters because the untransposed column is one of the two ways a box ends
// up as a tall narrow strip: placed at a 40x200 rectangle, auto-height then grows
// it further with every line the 40px width forces.
const VERTICAL_ASPECT = 1.6;
export function looksVertical(det, ln = null, p = null) {
  if (!det || !Array.isArray(det.box) || det.box.length !== 4) return false;
  const korean =
    det.lang === 'ko' ||
    ln?.lang === 'ko' ||
    p?.detect?.lang === 'ko' ||
    app.projectOcrLanguage === 'ko' ||
    hasHangul(det.text ?? det.jp ?? ln?.jp ?? '');
  if (korean) return det.vertical === true;
  if (det.vertical != null) return !!det.vertical;
  const [x1, y1, x2, y2] = det.box;
  const rw = Math.abs(x2 - x1);
  const rh = Math.abs(y2 - y1);
  return rw > 0 && rh > rw * VERTICAL_ASPECT;
}
export function placementRect(p, rect, imgX, imgY, fallbackW = 220, fallbackH = 92) {
  let w = fallbackW;
  let h = fallbackH;
  let cx = imgX;
  let cy = imgY;
  if (rect) {
    const [x1, y1, x2, y2] = rect;
    const rw = Math.abs(x2 - x1);
    const rh = Math.abs(y2 - y1);
    const inset = Math.min(BUBBLE_INSET_MAX, Math.max(BUBBLE_INSET_MIN, Math.round(Math.min(rw, rh) * BUBBLE_INSET)));
    w = Math.max(MIN_BOX_W, rw - inset * 2);
    h = Math.max(MIN_BOX_H, rh - inset * 2);
    cx = (x1 + x2) / 2;
    cy = (y1 + y2) / 2;
  }
  // The same clamp the old constants got: a box is placed centred on the point
  // and then pushed back onto the page.
  //
  // Only against a page that has been measured, which is the same guard
  // `growToFit` carries and for the same reason. `p.w`/`p.h` are 0 until
  // something decodes the art, and a box centred on a detected bubble at x=600
  // was being clamped to `[0, max(0, 0 - w)]` - that is, to 0 - so every
  // placement on a page the canvas had not measured yet collapsed onto the
  // origin and the bubble the detector found was thrown away. Off the page is
  // recoverable by dragging; a pile of boxes in the top-left corner is what the
  // user has to undo.
  const onPage = (v, size, extent) =>
    extent > 0 ? clamp(v, 0, Math.max(0, extent - size)) : Math.max(0, v);
  return {
    x: onPage(cx - w / 2, w, p.w),
    y: onPage(cy - h / 2, h, p.h),
    w,
    h,
  };
}

// The sizes a box can be placed at, in order of how much is known about the
// bubble under it:
//
//   the balloon    the page's pixels are in hand and the flood fill recovered
//                  a shape it believes. The box is the largest rectangle that
//                  fits inside that shape, and the shape is kept so the line
//                  breaker can lay text out to the curve.
//   the click      no detection, or a detection that missed this bubble - but
//                  the pixels under the pointer are a solid light colour, so
//                  the same flood fill runs from the click itself and the box
//                  is sized from the balloon it finds. This is the paste-mode
//                  case: a translation in the queue, a page nobody analysed,
//                  and a user pointing at the bubble they want it in.
//   the block      no fit either way. The detector's rectangle, inset - today's
//                  answer - transposed first when the Japanese in it was set
//                  vertically, since a tall narrow column is the one shape
//                  English does not want. No transpose in the fitted branches
//                  above: the inscribed rect of the real balloon is already the
//                  right aspect for the real bubble, and swapping its sides
//                  would be a heuristic overruling a measurement.
//   the text       nothing detected and nothing under the pointer worth
//                  fitting, so the box is sized from what has to go in it: the
//                  width that makes the text a balanced block rather than the
//                  fixed 220 that made it a column. See `balancedBoxSize`.
//   the constants  ...and 220x92 when there is not even text to measure - an
//                  empty queue row, or an environment with no metrics.
// Per-tag font size (untagged is its own group), everything else still
// inherits `lastStyle` - the font, colour and strokes chosen by hand on the
// last box touched - plus the preferences for the five typesetting flags
// (see `applyBoxDefaults`).
//
// `measured` is a fit already measured for this line's block, or null for one
// measured and found irregular (`placeDetectedInChapter`); undefined measures
// here.
function bornBox(p, ln, imgX, imgY, measured) {
  const style = inheritedStyleFor(ln);
  const det = detectedEntryFor(p, ln.n, imgX, imgY);
  // The block first: a detected rectangle is a measurement of where the Japanese
  // in THIS line sat, so it seeds the fill closer to the right balloon than a
  // click can when the two disagree. The click is the answer when there is no
  // block, which is most of the time in paste mode.
  let fit =
    measured !== undefined ? measured : (balloonFitFor(p, det?.box ?? null) ?? balloonFitAt(p, imgX, imgY));
  let g = fit ? fittedRect(p, fit, style.align) : null;
  // The two are dropped together, deliberately: a fit the box was not sized from
  // is a fit the box should not be laid out to either, and carrying one while
  // placing from the block would leave the rectangle and its line breaks
  // describing two different bubbles.
  if (!g) {
    fit = null;
    const rect = looksVertical(det, ln, p) ? transposeRect(det.box) : (det?.box ?? null);
    // Skipped whenever there IS a rect, because `placementRect` ignores the
    // fallback pair in that case and the measurement could not change the answer.
    // And skipped with no canvas, for the reason `autoFitBox` asks the same
    // question: every metric is a stand-in there, which is fine for deciding a
    // line break in a test and not fine for a number written into the user's
    // document. Either way the old constants stand.
    const bal = rect || !canMeasure() ? null : balancedBoxSize(lineText(ln), style);
    g = placementRect(p, rect, imgX, imgY, bal?.w ?? 220, bal?.h ?? 92);
  }
  const b = {
    id: 'b' + boxSeq++,
    lineN: ln.n,
    text: null,
    x: g.x,
    y: g.y,
    w: g.w,
    h: g.h,
    // One of the two moments a tag's defaults are read - the other is an apply
    // onto a box already placed (`toggleTagOnLine`), which calls this same
    // function so the two orders cannot disagree. What lands on the box is a
    // plain value it owns from here on, so *editing* the tag afterwards still
    // cannot reach back into it - that is the not-retroactive rule, and it is
    // unchanged: there is no path from `updateTag` to a box, only from a
    // deliberate apply. A line with no tags, or tags with nothing set, comes
    // back with the inherited style untouched, which is what makes tags optional.
    // Computed above rather than here, because the balanced fallback size has to
    // measure this line's text in the style it is about to be set in - a box
    // sized against the inherited size and then born at a tag's larger one would
    // be the wrong shape from its first frame.
    style,
    // The balloon this box was fitted to, or null when it was not. Written on
    // every placed box either way so the field is never absent - see the same
    // reasoning in `loadProjectPages`. It rides inside the `place` history entry
    // below (`$state.snapshot(b)` takes the whole box), so an undo of a
    // placement takes the fit with it.
    fit,
  };
  // Before the push and before the record, so the one `place` entry this gesture
  // writes carries the height the user is actually looking at. A box whose line
  // already has its translation typed in the queue is placed at the size that
  // text needs; an empty one is placed at the bubble's size and grows as it is
  // filled in, through `setBoxText`.
  autoFitBox(b, p);
  return b;
}

// `target` is the page the click landed on. It defaults to the current one,
// which is the only page a paged document can offer - in a longstrip every page
// is on screen at once and the canvas resolves the frame under the pointer, so
// the coordinates and the page they are in must travel together or the box
// lands on whichever slice the scroll position happens to have made current.
export function placeActiveAt(imgX, imgY, target = null) {
  // Nothing places a box in a translate chapter. The rail forces the hand and
  // the canvas checks too, so this is the third lock on the same door - cheap,
  // and it is the one that holds whatever a future caller does, because a box on
  // a page nobody is typesetting is work the user would have to find and delete.
  if (isTranslateMode()) return;
  // Before anything is recorded or selected. The undo stack that is live, the
  // selection the Inspector reads and the queue on screen are all scoped to the
  // current page, so placing onto another one has to move the index first or the
  // edit is filed against a page nobody is looking at. No-op when the target is
  // already current, which is every call a paged document makes.
  focusPage(target);
  // The edit this click ends is recorded before the placement it starts. Left to
  // the `selectBox` at the bottom - which settles as a side effect of moving the
  // selection - the free-typed box the user had just finished would be recorded
  // *after* the box this click places, and undo would then rewind the pair in
  // the wrong order: the older edit first, the newer one still standing.
  settleEdits();
  const p = target ?? page();
  if (p.activeLineN == null) return;
  let ln = lineByN(p, p.activeLineN);
  if (!ln) return;
  // The active line is also the row the queue highlights, and it is often a
  // line already on the page: clicking a placed row arms it (`activateLine` does
  // not discriminate), selecting a box on the canvas activates its line (see
  // `selectBox`), and a free-typed line's box is what created it. Placing any of
  // those again would drop a second box rendering the same text on top of the
  // first, with no sign in the queue that there were two. The tool's job is the
  // next line that is NOT on the page yet, so it places that one instead; with
  // nothing left to place, the click does what it does with an empty queue.
  if (isFreeLine(ln) || isPlaced(p, ln.n)) {
    const n = firstUnplaced(p);
    if (n == null) {
      deselect();
      return;
    }
    ln = lineByN(p, n);
  }
  ln.placed = true;
  // The queue advances as part of this edit, so the record carries both sides
  // of it - undoing the box without rewinding the queue would leave the two
  // disagreeing about what still needs placing.
  const activeBefore = p.activeLineN;
  const b = bornBox(p, ln, imgX, imgY);
  p.boxes.push(b);
  p.activeLineN = firstUnplaced(p);
  if (p.activeLineN == null && app.tool === 'place') {
    setTool('text');
  }
  recordEdit({
    t: 'place',
    pageId: p.id,
    index: p.boxes.length - 1,
    box: $state.snapshot(b),
    activeBefore,
    activeAfter: p.activeLineN,
  });
  markUnsaved();
  // Not remembered: this box's style came OUT of `lastStyle` a moment ago, with
  // the line's tag stamped over it. See `selectBox`.
  selectBox(b.id, { remember: false });
  toast(
    `Placed line ${ln.n} → next: ${p.activeLineN ? 'line ' + p.activeLineN : 'all placed'}`,
  );
}

export function placeableDetectedLines(p) {
  if (!p?.lines) return [];
  const placed = placedLineNs(p);
  return p.lines.filter((l) => l && !isFreeLine(l) && !placed.has(l.n) && detectedBlockOf(p, l.n));
}

// The detected entry for a line whose block is a usable rectangle, or null.
function detectedBlockOf(p, n) {
  return (
    (p.detect?.boxes ?? []).find(
      (d) =>
        d?.n === n &&
        Array.isArray(d.box) &&
        d.box.length === 4 &&
        d.box.every((v) => typeof v === 'number' && Number.isFinite(v)),
    ) ?? null
  );
}

// One page's worth of the batch, with nothing around it: no page turn, no
// selection, no toast. Split out of `placeDetectedOnPage` so the chapter-wide
// pass below can run it over a page the user is not looking at - which is the
// whole difference between the two entry points, and the reason neither of them
// duplicates the placement itself.
//
// The history entry names the page it belongs to, so an entry for an off-screen
// page is merged into that page's own stack rather than the live one - see the
// offscreen sink in editor/history.svelte.js, which exists for exactly this.
//
// Returns the boxes placed, as the `placeMany` items, so the caller can select
// the last one when the page is the one on screen.
//
// A block with a fit stored on it (`placeDetectedInChapter`) is placed with that
// fit rather than measured again; one without is measured from whatever pixels
// the click cache has.
function placeDetectedInto(p) {
  const lines = placeableDetectedLines(p);
  if (!lines.length) return [];
  const activeBefore = p.activeLineN;
  const items = [];
  for (const ln of lines) {
    ln.placed = true;
    const det = detectedBlockOf(p, ln.n);
    const [x1, y1, x2, y2] = det.box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    // A copy: the box's fit is its own from here on, not the block's.
    const b = bornBox(p, ln, cx, cy, det.fit && { ...det.fit });
    p.boxes.push(b);
    items.push({ index: p.boxes.length - 1, box: $state.snapshot(b) });
  }
  p.activeLineN = firstUnplaced(p);
  recordEdit({
    t: 'placeMany',
    pageId: p.id,
    items,
    activeBefore,
    activeAfter: p.activeLineN,
  });
  return items;
}

// How many lines on a page still want a box and have no detected bubble to put
// one in. What the toast reports as "left".
function undetectedRemaining(p) {
  const placed = placedLineNs(p);
  return (p.lines ?? []).filter((l) => !isFreeLine(l) && !placed.has(l.n)).length;
}

export function placeDetectedOnPage(target = null) {
  if (isTranslateMode()) return 0;
  if (!app.pages.length) return 0;
  focusPage(target);
  settleEdits();
  const p = target ?? page();
  const items = placeDetectedInto(p);
  if (!items.length) {
    toast('No detected bubbles left to place on this page');
    return 0;
  }
  if (p.activeLineN == null && app.tool === 'place') {
    setTool('text');
  }
  markUnsaved();
  const lastBox = items[items.length - 1]?.box;
  if (lastBox) {
    selectBox(lastBox.id, { remember: false });
  }
  const remaining = undetectedRemaining(p);
  const countStr = `${items.length} box${items.length === 1 ? '' : 'es'}`;
  const leftStr = remaining > 0 ? ` · ${remaining} left with no detected bubble` : '';
  toast(`Placed ${countStr} from detection${leftStr}`);
  return items.length;
}

// Every page of the chapter, in one press. The page the user is looking at is
// done last and keeps the selection, so the editor ends where it started rather
// than on whichever page happened to be last in the list.
//
// Measured first, then placed (DET-1). Placement fits each box to its balloon
// from the page's pixels, and synchronously the only pixels there are the ones
// the click cache holds - the pages loaded around the reading position. So this
// used to place those pages fitted and every other page with the detector's
// rectangle, and one chapter placed from two reading positions came out as two
// documents. Now every page's balloons are measured before anything is placed,
// by `measureChapterFits` (chapter-fit.js), which reads one page at a time and
// lets it go. The answers are stored on the detected blocks (`det.fit`: a shape,
// or null for measured and irregular; absent is not measured), so a second press
// - or a page placed by itself - reads them instead of the pixels again. They
// move with `rescalePageGeometry`, go with a new detection (which replaces
// `detect`), and are dropped by a new clean (`respacePage` in library.svelte.js).
//
// Then one synchronous pass places everything, one undo entry per page as
// before. The run takes seconds and the document is live under it, so before
// anything is committed:
//
//   the run must not have been cancelled - the Queue's Cancel or Esc
//   (`cancelChapterPlace`), or the library closing or opening a chapter or
//   switching this one to translate, which cancel it the moment they start;
//   the chapter must still be the one measured and still be typeset work;
//   a page whose detection, raster or coordinate space changed under the run is
//   left alone rather than placed from answers about another picture, and the
//   toast says so;
//   a line placed by hand in the meantime is not placed twice -
//   `placeableDetectedLines` is asked again at commit.
//
// Cancelled, it changes nothing: no box, no history entry, no stored fit.
let chapterRun = null;

export function cancelChapterPlace() {
  chapterRun?.abort();
}

export async function placeDetectedInChapter() {
  if (isTranslateMode() || chapterRun) return 0;
  if (!app.pages.length) return 0;
  const pages = app.pages;
  const run = (chapterRun = new AbortController());
  const before = new Map(pages.map((p) => [p, rasterOf(p)]));
  let fits;
  try {
    fits = await measureChapterFits(pages, {
      blocksFor: unmeasuredBlocks,
      fitFor: measureBlock,
      signal: run.signal,
      onProgress: (progress) => {
        app.chapterPlace = progress;
      },
    });
  } finally {
    chapterRun = null;
    app.chapterPlace = null;
  }
  if (!fits || run.signal.aborted || app.pages !== pages || isTranslateMode()) {
    if (app.pages === pages) toast('Place chapter cancelled - nothing was placed');
    return 0;
  }
  settleEdits();
  const here = page();
  let total = 0;
  let pagesTouched = 0;
  let changed = 0;
  const placeOn = (p) => {
    const was = before.get(p);
    const now = rasterOf(p);
    if (!was || was.detect !== now.detect || was.file !== now.file || was.w !== now.w || was.h !== now.h) {
      if (placeableDetectedLines(p).length) changed++;
      return [];
    }
    for (const d of p.detect?.boxes ?? []) if (fits.has(d)) d.fit = fits.get(d);
    const items = placeDetectedInto(p);
    if (items.length) {
      total += items.length;
      pagesTouched++;
    }
    return items;
  };
  for (const p of app.pages) if (p !== here) placeOn(p);
  const lastItems = placeOn(here);
  // The stored answers are document too, placed or not.
  if (total || fits.size) markUnsaved();
  const changedStr = changed ? ` · ${changed} page${changed === 1 ? '' : 's'} changed while fitting, place again` : '';
  if (!total) {
    toast(`No detected bubbles left to place in this chapter${changedStr}`);
    return 0;
  }
  if (here.activeLineN == null && app.tool === 'place') {
    setTool('text');
  }
  const lastBox = lastItems[lastItems.length - 1]?.box;
  if (lastBox) selectBox(lastBox.id, { remember: false });
  const remaining = app.pages.reduce((n, p) => n + undetectedRemaining(p), 0);
  const countStr = `${total} box${total === 1 ? '' : 'es'}`;
  const pageStr = `${pagesTouched} page${pagesTouched === 1 ? '' : 's'}`;
  const leftStr = remaining > 0 ? ` · ${remaining} left with no detected bubble` : '';
  toast(`Placed ${countStr} across ${pageStr}${leftStr}${changedStr}`);
  return total;
}

// What a page's measured fits are answers about: its detection, its raster's
// durable name, and its coordinate space.
const rasterOf = (p) => ({ detect: p.detect, file: p.cleanedFile ?? p.file, w: p.w, h: p.h });

// The blocks a chapter place will ask a fit for and has none stored.
const unmeasuredBlocks = (p) =>
  placeableDetectedLines(p)
    .map((ln) => detectedBlockOf(p, ln.n))
    .filter((d) => d.fit === undefined);

// The fit `bornBox` would measure for a detected block - the block, then its
// centre as a click - from pixels in hand. The pixels are the raster at its
// natural size; a page whose space is another size has the block mapped into
// the pixels and the answer mapped back.
function measureBlock(p, det, pixels) {
  const sx = p.w > 0 ? pixels.width / p.w : 1;
  const sy = p.h > 0 ? pixels.height / p.h : 1;
  const [x1, y1, x2, y2] = det.box;
  const fit =
    balloonFitFor(p, [x1 * sx, y1 * sy, x2 * sx, y2 * sy], pixels) ??
    balloonFitAt(p, ((x1 + x2) / 2) * sx, ((y1 + y2) / 2) * sy, pixels);
  return sx === 1 && sy === 1 ? fit : scaleFit(fit, 1 / sx, 1 / sy);
}

// ---------- re-running a fit by hand ----------
// The fit is measured once, at placement, from the DETECTOR's block. Two things
// then routinely make that answer stale, and neither is a bug: the user drags
// the box onto a different bubble, or the page is cleaned after it was typeset
// and the balloon under the box now has nothing in it. Re-deciding the fit on
// every render is not an option - it is a flood fill over a megapixel - so it is
// a button, and this is what the button calls.
//
// The fill is never seeded from the box's own rectangle. That rectangle is the
// output of the last height fit, and a box whose text outgrew its balloon crosses
// the outline: the fill's edge seeds start on the paper outside and it escapes,
// so pressing the button on a box nobody touched cleared the fit it was placed
// with (DET-2). The seeds, in order, each only while the box still covers its
// centre - a box dragged onto another bubble has left all of them behind:
//
//   the detected block of the box's line - what placement seeded from, so an
//   untouched box finds the balloon it was placed in;
//   the stored fit's own rectangle, which lies inside the balloon it describes;
//   and a click at the box's centre (`balloonFitAt`) - the box is where the user
//   put it, and this finds the balloon it is on now.
//
// A box sitting on bare paper, on a burst, or on a page whose pixels are not
// decoded gets its fit cleared rather than left pointing at a bubble it has been
// dragged away from - a stale fit is worse than none, because the text is laid
// out to a curve that is no longer under it.
//
// A fit that appears where there was none resizes an auto box to the balloon, the
// way placement sizes it (`fittedRect`), so a box placed with the rectangle
// fallback and refitted once its page is decoded ends up where a fitted
// placement would have put it. A box that already had a fit keeps its rectangle:
// the user may have sized it. Either way the ladder runs, as it does at
// placement, so the same box on the same balloon gives the same answer however
// often the button is pressed.
//
// One press is one undo step (UX-2): the `refit` entry carries the fit, the
// rectangle and the size on either side, because the ladder can move all of
// them and none of them can be re-derived on the way back. A press that changed
// none of them records nothing, so an undo never lands on a step that does
// nothing.
export function refitBalloon(boxId = app.selectedId, p = page()) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b) return false;
  // A pending Inspector edit on this box would settle AFTER this one and record
  // on top of it - the same reason `toggleBalloonFit` settles first.
  settleEdits();
  const before = b.fit;
  const geomBefore = refitGeom(b);
  const fit = balloonUnder(p, b);
  b.fit = fit;
  if (fit && !before && isAutoBox(boxCandidate(b, boxText(b, p)))) {
    const g = fittedRect(p, fit, b.style.align);
    if (g) Object.assign(b, g);
  }
  // The height follows: a box laid out to a curve breaks into a different number
  // of lines than the same box laid out flat, and the rectangle has to describe
  // that. What no longer fits is flagged.
  autoFitBox(b, p);
  const geomAfter = refitGeom(b);
  if (JSON.stringify(geomAfter) !== JSON.stringify(geomBefore)) {
    recordEdit({ t: 'refit', pageId: p.id, boxId: b.id, geomBefore, geomAfter });
  }
  if (fit) toast(`Fitted to the ${fit.kind === 'rect' ? 'panel' : 'balloon'} under this box`);
  else if (before) toast('No balloon found under this box - layout is rectangular again');
  else toast('No balloon found under this box');
  markUnsaved();
  return !!fit;
}

// What a refit can move, as its history entry records it. Plain copies, taken
// before the fit is replaced, so the two sides never share an object.
const refitGeom = (b) => ({ ...fitGeom(b), fit: b.fit ? $state.snapshot(b.fit) : null });

// The balloon a box sits in, from the seeds `refitBalloon` describes.
function balloonUnder(p, b) {
  const covers = (x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  const centreOf = ([x1, y1, x2, y2]) => [(x1 + x2) / 2, (y1 + y2) / 2];
  const blocks = [];
  const det = (p.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4);
  if (det) blocks.push(det.box);
  const room = b.fit && inscribedRect(b.fit);
  if (room) blocks.push([room.x, room.y, room.x + room.w, room.y + room.h]);
  for (const block of blocks) {
    if (!covers(...centreOf(block))) continue;
    const fit = balloonFitFor(p, block);
    if (fit) return fit;
  }
  return balloonFitAt(p, b.x + b.w / 2, b.y + b.h / 2);
}

// ---------- turning balloon fit on and off for one box ----------
// The switch, not the measurement. `refitBalloon` above re-measures the balloon
// under the box and is what the Inspector's button calls; this flips
// `style.balloon`, which is what decides whether the measurement is USED - see
// `balloonWidthsFor` in measure.js, which returns null the moment the flag is
// false.
//
// It exists because the two were only reachable separately: the keyboard could
// re-fit but not un-fit, so a box the fit had made worse - a burst, a bubble
// with a tail through the text, a caption box the fill escaped from - had to be
// taken to the Bulk style panel to be turned off. One box at a time, the switch
// is what a letterer wants, and it is the same key either way.
//
// Turning it back ON re-measures only when there is nothing to turn on: the
// stored fit is kept when the switch goes off, so off-then-on is free and lands
// back exactly where it was. A box that has never been fitted gets one measure
// here, so the key does something visible the first time it is pressed.
//
// Recorded as a style edit, unlike `refitBalloon`, because that is what it is:
// one boolean on `style`, with the height `autoFitBox` derives from it, and both
// halves are what the `style` entry kind already carries.
export function toggleBalloonFit(boxId = app.selectedId, p = page()) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b) return false;
  // A pending Inspector edit on this box would settle AFTER this one and record
  // on top of it - the same reason `pasteStyle`'s caller settles first.
  settleEdits();
  const before = cloneStyle(b.style);
  const geomBefore = fitGeom(b);
  const on = b.style.balloon !== false;
  b.style.balloon = !on;
  if (!on && !b.fit) b.fit = balloonUnder(p, b);
  // The height follows the flag: a box laid out to a curve breaks into a
  // different number of lines than the same box laid out flat.
  autoFitBox(b, p);
  recordEdit({
    t: 'style',
    pageId: p.id,
    boxId: b.id,
    before,
    after: cloneStyle(b.style),
    geomBefore,
    geomAfter: fitGeom(b),
  });
  markUnsaved();
  if (on) toast('Balloon fit off for this box');
  else if (b.fit) toast(`Balloon fit on - ${b.fit.kind === 'rect' ? 'panel' : 'balloon'} under this box`);
  else toast('Balloon fit on - no balloon found under this box');
  return !on;
}

// ---------- empty text box (free-typed) ----------
// Creates a queue line as well as a box, and that is the change: a box typed
// straight onto the canvas is now a line-backed box like any other, so it can be
// tagged, a tag-scoped bulk edit reaches it, and it is counted by the queue's
// "N / M placed" - as placed, which it is by construction, since the box is what
// brought the line into existence.
//
// The line's three fields, and why each reads the way it does:
//   n     negative, one below everything on the page. See `isFreeLine`.
//   jp    ''. There is no Japanese source - the user typed English onto the
//         page. The queue renders `{#if line.jp}` and the box renders its JP
//         pill on the same condition, so an empty string is not a blank label,
//         it is no label at all.
//   en    '' to start, and from then on the box's text: this is where a free
//         box's text lives (see `setBoxText`). The queue's textarea edits it and
//         the canvas follows, which is the same relationship a placed box has
//         with its line.
//   type  'dialogue', which is one of the three names `normLine` validates in
//         importer.js. Anything else and the app's own exported JSON would be
//         rejected - silently downgraded to 'dialogue' - on re-import.
// `target` as in `placeActiveAt`: the page the click landed on, defaulting to
// the current one.
export function addEmptyBox(imgX, imgY, target = null) {
  if (!app.pages.length) return null; // no chapter open: never write into the stand-in page
  if (isTranslateMode()) return null; // no canvas boxes in a translate chapter - see `placeActiveAt`
  // Same reason as `placeActiveAt`: this ends in `beginEdit`, and the caret and
  // the pending-place record it leaves behind are both scoped to the page the
  // index points at.
  focusPage(target);
  const p = target ?? page();
  const ln = { n: nextFreeLineN(p), type: 'dialogue', jp: '', en: '' };
  p.lines.push(ln);
  const w = 200,
    h = 70;
  const b = {
    id: 'b' + boxSeq++,
    lineN: ln.n,
    // Null, not ''. The text lives on the line; a box that owned a string here
    // would shadow it in `boxText` and the queue's textarea would stop reaching
    // the box the moment anything wrote one.
    text: null,
    x: clamp(imgX - w / 2, 0, Math.max(0, p.w - w)),
    y: clamp(imgY - h / 2, 0, Math.max(0, p.h - h)),
    w,
    h,
    // Through `inheritedStyleFor` like `placeActiveAt`: font size follows the
    // untagged size memory (or `lastStyle.size`), defaults come from preferences,
    // and everything else inherits `lastStyle`.
    style: inheritedStyleFor(ln),
    // Never fitted at birth: a box typed onto the page is not on a detected
    // bubble and there is no block to seed a fill from. The user can ask for one
    // from the Inspector once the box is where they want it, which is what
    // `refitBalloon` is for. Present and null rather than absent, like every
    // other box.
    fit: null,
  };
  p.boxes.push(b);
  markUnsaved();
  // `beginEdit` selects, which settles whatever gesture was in progress before
  // this one. Only then is this box the pending one. Not remembered, for the
  // reason `selectBox` gives: this style came out of `lastStyle`.
  beginEdit(b.id, { remember: false });
  pendingPlace = { id: b.id, pageId: p.id };
  return b.id;
}

export function addQueueLine() {
  if (!app.pages.length) return null;
  const p = page();
  const ln = { n: nextFreeLineN(p), type: 'dialogue', jp: '', en: '' };
  p.lines.push(ln);
  p.activeLineN = ln.n;
  markUnsaved();
  return ln.n;
}

// ---------- a text box from the queue's Add button ----------
// `addEmptyBox` takes page coordinates, and the caller that has none is the
// queue's Add button: it lives in a panel floating over the canvas, and the user
// may be looking at any corner of a page zoomed to 400%. The page's own centre
// is not an answer - at that zoom it is usually off-screen, and a box the user
// cannot see is a box they cannot type into, which is the whole point of the
// button.
//
// So the landing point is the centre of *the part of the page that is on
// screen*: the page frame intersected with the canvas viewport. Pure, and taking
// both rectangles rather than reading them, so the arithmetic is testable in
// node where there is no layout - the DOM read is the four lines below it.
//
// Falls back to the page's centre whenever there is nothing to measure (no
// canvas mounted, a zoom of zero) or the page is scrolled entirely out of view.
// That last case is not a viewport at all, and a box placed against an empty
// intersection would land at whichever edge the page had been dragged past.
export function visiblePageCenter(p, viewport, frame, zoom = 1) {
  const w = p?.w > 0 ? p.w : PAGE_W;
  const h = p?.h > 0 ? p.h : PAGE_H;
  const middle = { x: w / 2, y: h / 2 };
  if (!viewport || !frame || !(zoom > 0)) return middle;
  const left = Math.max(viewport.left, frame.left);
  const right = Math.min(viewport.right, frame.right);
  const top = Math.max(viewport.top, frame.top);
  const bottom = Math.min(viewport.bottom, frame.bottom);
  if (!(right > left) || !(bottom > top)) return middle;
  return {
    x: clamp(((left + right) / 2 - frame.left) / zoom, 0, w),
    y: clamp(((top + bottom) / 2 - frame.top) / zoom, 0, h),
  };
}

// The DOM half. `.editor-scroll` and `.page-frame` are Canvas.svelte's elements
// and this only ever measures them - the scroll position they encode is the one
// thing the store does not hold and cannot derive from `app.zoom`. A read is
// enough, so the canvas keeps sole ownership of that scroll and there is no
// second copy of it to fall out of step.
//
// Worth being honest about the shape of this: a registration seam, like
// `setSaver` and `setPageSwitchHook` above, would be the tidier edge - the
// canvas handing over a `viewportRect()` at mount. That is a change to
// Canvas.svelte, and this needs no cooperation from it at all, so the query
// stands until somebody wants the seam for a second reason.
export function visibleCenterInView() {
  const el = (sel) =>
    typeof document === 'undefined' ? null : (document.querySelector(sel)?.getBoundingClientRect() ?? null);
  // Addressed by page id, because NEITHER canvas mounts one frame: a longstrip
  // mounts every page in the chapter, and a paged one keeps its neighbours
  // mounted and hidden so a turn is a visibility change (see `mountedPages` in
  // Canvas.svelte). A bare `.page-frame` would answer with whichever came first
  // in the list - in a strip the top slice, a rectangle nowhere near the
  // viewport whose intersection with it is empty, so every box added from the
  // queue's button landed at the page's centre instead of the reader's; in a
  // paged chapter a `display:none` neighbour, whose rect is all zeros. Both
  // carry the attribute, so there is one selector rather than a branch, and the
  // fallback is for a canvas that is not mounted at all.
  const frame = el(`.page-frame[data-page-id="${page().id}"]`) ?? el('.page-frame');
  return visiblePageCenter(page(), el('.editor-scroll'), frame, app.zoom);
}

export function addTextBoxInView() {
  if (!app.pages.length) return null;
  const { x, y } = visibleCenterInView();
  return addEmptyBox(x, y);
}

// ---------- duplicate ----------
// Far enough that the copy is visibly its own box and near enough that it is
// obviously the same one.
const DUP_OFFSET = 16;

// The copy always gets a FREE line of its own rather than joining the source's,
// whatever the source was placed from. Two boxes on one imported line is the
// state `firstUnplaced` and `placeActiveAt` are written to prevent, and a free
// line carries the type, the Japanese, the English and the tags across, so
// `boxText` answers the same for both and a tag-scoped bulk edit still reaches
// the copy.
export function duplicateBox(id = app.selectedId) {
  if (!app.pages.length) return null; // no chapter open: never write into the stand-in page
  if (isTranslateMode()) return null; // no canvas boxes in a translate chapter - see `placeActiveAt`
  // Before anything is read: a settle arriving after this gesture's own record
  // would sit on top of it, so the first undo would rewind the edit that came
  // *before* the duplicate.
  settleEdits();
  const p = page();
  const src = p.boxes.find((b) => b.id === id);
  if (!src) return null;
  const from = lineByN(p, src.lineN);
  const ln = {
    n: nextFreeLineN(p),
    type: from?.type ?? 'dialogue',
    jp: from?.jp ?? '',
    // What the source SHOWS, not what its line says: a queue-placed box can
    // override its line with `box.text`, and a legacy free box has no line at
    // all, so `boxText` is the only reader that answers for every case.
    en: boxText(src, p),
  };
  const tags = lineTags(from);
  if (tags.length) ln.tags = [...tags];
  p.lines.push(ln);
  const b = {
    id: 'b' + boxSeq++,
    lineN: ln.n,
    // Always null. The copy is a free box, and a free box's text lives on its
    // line (`setBoxText` writes `ln.en` when lineN < 0). Carrying `src.text`
    // here left a non-null override that `boxText` kept showing while every
    // edit went to the line - the copy looked frozen on the original's words.
    text: null,
    x: clamp(src.x + DUP_OFFSET, 0, Math.max(0, p.w - src.w)),
    y: clamp(src.y + DUP_OFFSET, 0, Math.max(0, p.h - src.h)),
    w: src.w,
    h: src.h,
    style: cloneStyle(src.style),
    // The fit is used as a width profile rather than as a position on the page
    // (see `balloonWidthsFor`), so the copy breaks its lines exactly where the
    // original does even though it sits at the offset.
    fit: normalizeFit($state.snapshot(src.fit)),
  };
  // The copy's own verdict, before the record takes its snapshot. Not the
  // source's flag copied across: the copy sits somewhere else and reads its
  // text off a line of its own.
  reviewBox(b, p);
  p.boxes.push(b);
  // One entry for the whole gesture, and the same kind a free-typed placement
  // records: undo takes the box and its line back out together. No queue fields
  // - nothing here touched `activeLineN`.
  recordEdit({
    t: 'place',
    pageId: p.id,
    index: p.boxes.length - 1,
    box: $state.snapshot(b),
    ...freeLineRecord(p, b),
  });
  markUnsaved();
  selectBox(b.id);
  return b.id;
}

// ---------- a box born from the brush board ----------
// The board's strokes become a box of their own: a free line, a box sized to
// the ink, `ink.on`, and nothing else - no text, and a style that starts from
// the defaults rather than from `lastStyle`, because a hand-lettered sound
// effect is not the previous balloon's dialogue with the words taken out.
//
// `w`/`h` and `strokes` are what `boardPlacement` hands back: the strokes are
// already in the box's own frame. The box is centred on `(imgX, imgY)`, page
// px, and clamped onto the page the way `addEmptyBox` clamps.
//
// One `place` entry, the kind `duplicateBox` records, so undo takes the box and
// its line out together.
export function addInkBox({ w, h, strokes, finish }, imgX, imgY, target = null) {
  if (!app.pages.length) return null;
  if (isTranslateMode()) return null;
  // Normalised before anything is written: a list of strokes that all turn
  // out empty must not leave a ghost box and an orphan queue row behind.
  const list = (Array.isArray(strokes) ? strokes : []).map(normalizeInkStroke).filter(Boolean);
  if (!list.length) return null;
  settleEdits();
  focusPage(target);
  const p = target ?? page();
  const ln = { n: nextFreeLineN(p), type: 'sfx', jp: '', en: '' };
  p.lines.push(ln);
  const bw = Math.max(1, Math.round(Number(w) || 0));
  const bh = Math.max(1, Math.round(Number(h) || 0));
  const style = applyBoxDefaults(defaultStyle());
  style.ink = { on: true, strokes: list };
  // The box's strokes and shadows wrap its ink as one shape (see `drawInk`),
  // so they are the finish the board was showing and nothing else: a text
  // box's default outline is a text box's, and none was asked for here.
  const fin = normalizeFinish(finish);
  style.strokes = fin.strokes;
  style.shadows = fin.shadows;
  const b = {
    id: 'b' + boxSeq++,
    lineN: ln.n,
    text: null,
    x: Math.round(imgX - bw / 2),
    y: Math.round(imgY - bh / 2),
    w: bw,
    h: bh,
    style,
    fit: null,
  };
  holdInk(b, p);
  b.x = clamp(b.x, 0, Math.max(0, p.w - b.w));
  b.y = clamp(b.y, 0, Math.max(0, p.h - b.h));
  // Born with its own verdict, as a duplicate is: an inked box is manual, so
  // nothing fits it unasked, and the flag is the one thing that can say so.
  reviewBox(b, p);
  p.boxes.push(b);
  recordEdit({
    t: 'place',
    pageId: p.id,
    index: p.boxes.length - 1,
    box: $state.snapshot(b),
    ...freeLineRecord(p, b),
  });
  markUnsaved();
  selectBox(b.id, { remember: false });
  return b.id;
}

// A box grown around its ink, with the ink carried the other way (OVF-7): the
// box's rectangle grows by what the check finds outside it, on the side it is
// outside, and the strokes - and a mask's shapes, pinned to the same corner -
// move back by the same amount, so nothing lands anywhere else on the page
// (`growAround` in contain.js, which also keeps a flipped or turned box still).
// Two callers, both of which have only ink to hold:
//
//   `addInkBox`   the board sizes the box to the strokes' own reach and a margin
//                 (`boardPlacement`), but what the strokes wear - the finish's
//                 outline and shadows - can reach past the margin, and a box
//                 whose ink ran out of it the moment it was placed would be
//                 flagged for something the user never did.
//   `fitBoxNow`   the flag's answer for a box that is only ink. Resizing one
//                 scales the strokes with it (`resizeBox`), so its overhang
//                 grows with the box and no drag can clear it; this can.
//
// Answers whether the box changed.
function holdInk(b, p) {
  if (!canMeasure()) return false;
  const g = growAround(boxCandidate(b, boxText(b, p)));
  if (!g) return false;
  const s = b.style;
  if (s.ink?.strokes?.length) s.ink = { ...s.ink, strokes: translateStrokes(s.ink.strokes, g.dx, g.dy) };
  if (s.clip?.shapes?.length) s.clip = { ...s.clip, shapes: translateClipShapes(s.clip.shapes, g.dx, g.dy) };
  b.x = g.x;
  b.y = g.y;
  b.w = g.w;
  b.h = g.h;
  return true;
}

// Replace a box's ink with strokes edited on the board. One `style` entry;
// the box's geometry is left alone, because the strokes come back in the frame
// they left in and the ink canvas already grows to hold overhang - which is
// the user's to fix, so the flag says whether the ink still fits.
export function setBoxInk(pageId, boxId, strokes) {
  const p = pageById(pageId);
  const b = p?.boxes.find((x) => x.id === boxId);
  if (!b) return false;
  settleEdits();
  const before = cloneStyle(b.style);
  const list = (Array.isArray(strokes) ? strokes : []).map(normalizeInkStroke).filter(Boolean);
  const ink = { on: list.length > 0, strokes: list };
  // Applying what is already there is not an edit: no entry, no dirty flag,
  // or the next undo would rewind nothing visible.
  if (JSON.stringify(before.ink) === JSON.stringify(ink)) return true;
  b.style.ink = ink;
  reviewBox(b, p);
  recordEdit({ t: 'style', pageId, boxId, before, after: cloneStyle(b.style) });
  markUnsaved();
  return true;
}

// Resize or move a box, scaling hand-drawn ink strokes when present.
// Updates the box geometry and scales stroke points and sizes.
export function resizeBox(pageId, boxId, geom, base = null) {
  const p = pageById(pageId) ?? page();
  const b = p?.boxes.find((x) => x.id === boxId);
  if (!b || !geom) return null;
  const ow = base?.w ?? b.w;
  const oh = base?.h ?? b.h;
  const nw = Number.isFinite(geom.w) ? geom.w : b.w;
  const nh = Number.isFinite(geom.h) ? geom.h : b.h;
  const nx = Number.isFinite(geom.x) ? geom.x : b.x;
  const ny = Number.isFinite(geom.y) ? geom.y : b.y;

  const baseStrokes = base?.ink?.strokes ?? b.style?.ink?.strokes;
  if (b.style?.ink?.on && Array.isArray(baseStrokes) && baseStrokes.length > 0) {
    if (ow > 0 && oh > 0 && (nw !== ow || nh !== oh)) {
      const sx = nw / ow;
      const sy = nh / oh;
      b.style.ink = {
        ...b.style.ink,
        strokes: baseStrokes.map((k) => scaleStroke(k, sx, sy)),
      };
    } else if (base && nw === ow && nh === oh) {
      b.style.ink = {
        ...b.style.ink,
        strokes: baseStrokes.map((k) => scaleStroke(k, 1, 1)),
      };
    }
  }
  b.w = nw;
  b.h = nh;
  b.x = nx;
  b.y = ny;
  if (Number.isFinite(geom.size)) {
    b.style.size = geom.size;
  }
  // A drag is the user choosing the box, so it never runs the ladder - but the
  // flag has to describe the box they chose. A height-only drag changes nothing
  // the component's own fit effect watches, so this is the only place that
  // would notice the text no longer fits.
  reviewBox(b, p);
  return b;
}


// ---------- keyboard nudge ----------
// The arrow keys, moving the selected box a pixel at a time. Bounds are the
// drag's, not the page's: a box the user deliberately hung off the edge must not
// jump back onto the page on the first arrow press.
//
// A run of presses coalesces into one entry through the same settle window the
// Inspector's sliders use - the history is five steps deep, so an entry per
// keypress would empty it before the user had finished moving one box.
const NUDGE_SETTLE_MS = 400;
let nudgePending = null;
let nudgeT = null;
function settleNudge() {
  const pend = nudgePending;
  if (!pend) return;
  nudgePending = null;
  clearTimeout(nudgeT);
  const p = pageById(pend.pageId);
  const b = p?.boxes.find((x) => x.id === pend.boxId);
  if (!b) return; // the box went while the window was open - nothing to record against
  if (b.x === pend.before.x && b.y === pend.before.y) return;
  recordEdit({ t: 'move', pageId: pend.pageId, boxId: pend.boxId, before: pend.before, after: { x: b.x, y: b.y } });
}

export function nudgeBox(id, dx, dy) {
  if (isTranslateMode()) return false;
  const p = page();
  const b = p.boxes.find((x) => x.id === id);
  if (!b) return false;
  // A run on one box keeps its window open; anything else closes it first.
  if (nudgePending && (nudgePending.boxId !== id || nudgePending.pageId !== p.id)) settleNudge();
  else if (!nudgePending) settleEdits();
  const x = clamp(b.x + dx, -b.w + 20, p.w - 20);
  const stripBounds = isLongstrip() ? stripDragYBounds(app.pages, p.id, b.h) : null;
  const y = stripBounds
    ? clamp(b.y + dy, stripBounds.min, stripBounds.max)
    : clamp(b.y + dy, -b.h + 20, p.h - 20);
  if (x === b.x && y === b.y) return false;
  nudgePending ??= { boxId: id, pageId: p.id, before: { x: b.x, y: b.y } };
  b.x = x;
  b.y = y;
  clearTimeout(nudgeT);
  nudgeT = setTimeout(settleNudge, NUDGE_SETTLE_MS);
  markUnsaved();
  return true;
}

// ---------- rotation ----------
// Straighten a box, in one press. The Inspector has had the 0° button on its
// rotation row since the row existed, but the button is only reachable with the
// panel open and the Text tab in front of you; a letterer who has just dragged
// a rotation handle by accident wants the box back at zero without going
// looking for it.
//
// It records its own history entry rather than borrowing the Inspector's
// settle timer: this is one discrete edit, not the tail of a scrub, and it can
// arrive with the panel unmounted. `settleEdits` first for the usual reason -
// a debounced panel edit still open on this box would otherwise record AFTER
// the reset and put the rotation back on the next undo.
export function resetBoxRotation(id = app.selectedId) {
  if (isTranslateMode()) return false;
  const b = byId(id);
  if (!b?.style) return false;
  if (!b.style.rotation) return false;
  settleEdits();
  const before = cloneStyle(b.style);
  const geomBefore = fitGeom(b);
  b.style.rotation = 0;
  autoFitBox(b);
  markUnsaved();
  rememberStyle(b);
  recordEdit({
    t: 'style',
    pageId: page().id,
    boxId: b.id,
    before,
    after: cloneStyle(b.style),
    geomBefore,
    geomAfter: fitGeom(b),
  });
  return true;
}

// ---------- delete ----------
export function deleteBox(id) {
  if (isTranslateMode()) return;
  const p = page();
  const b = byId(id);
  if (!b) return;
  // All three taken before the removal: the undo has to put the box back where
  // it was in the stacking order, not on the end, and take its line back out of
  // the queue.
  const index = p.boxes.findIndex((x) => x.id === id);
  const snap = $state.snapshot(b);
  const activeBefore = p.activeLineN;
  // Taken before the removal, for the same reason as the three above: the line
  // has to come out with the box, and putting it back needs to know where in
  // `p.lines` it sat.
  const freeLine = freeLineRecord(p, b);
  p.boxes = p.boxes.filter((x) => x.id !== id);
  // The line goes with the box. A free line exists only to be that box's queue
  // row - it holds the box's text and its tags and nothing else - so leaving it
  // behind leaves a row the user cannot place (see `placeActiveAt`), cannot
  // delete (the queue has no such control) and did not ask for. An imported line
  // is the opposite case and is untouched: it came from the translation, it
  // outlives any box, and it goes back into the queue below.
  if (freeLine.line) {
    p.lines = p.lines.filter((l) => l.n !== b.lineN);
    // The queue cannot stay armed on a line that has just left the document.
    // `activeLineN` is what `placeActiveAt` looks the line up by, so a stale
    // negative number there makes every subsequent click on the canvas in Place
    // mode a silent no-op - `lineByN` answers undefined and placement returns
    // without a word. The user's only way out was to click another queue row,
    // which is not a thing anybody knows to try. Guarded rather than
    // unconditional because the queue may well be armed on some other line,
    // which this delete has no business moving.
    if (p.activeLineN === b.lineN) p.activeLineN = firstUnplaced(p);
  }
  // A box that was never recorded as placed is never recorded as deleted: this
  // is the half of the empty-placeholder gesture that undoes the other half.
  if (pendingPlace?.id === id) clearPending();
  else {
    recordEdit({
      t: 'delete',
      pageId: p.id,
      index,
      box: snap,
      activeBefore,
      activeAfter: p.activeLineN,
      ...freeLine,
    });
  }
  app.selectedId = null;
  // The caret goes with the box. A delete can arrive from outside the box being
  // typed into - the Inspector's button, the keyboard while the pointer is
  // elsewhere - and `editingId` left naming a box that no longer exists is not
  // a cosmetic leak: App.svelte reads it as "the user is typing" and returns
  // out of the keydown handler before any shortcut is reached, so every global
  // shortcut in the app stays dead for the rest of the session. Nothing is
  // settled on the way past - whatever was typed is already in the document,
  // and the document no longer holds the box.
  if (app.editingId === id) app.editingId = null;
  markUnsaved();
  toast('Deleted text box');
}

// ---------- bulk style mode ----------
// Opened from the chrome cluster at top right, where the mode toggles live -
// this is a mode, not a tool, which is why it is no longer on the tool rail.
// User tweaks one style, clicks the boxes to apply it to, then hits Apply.

// Every style property a bulk edit can push onto a box, named by where it lives
// on the style: a flat key, or `group.field` for the roughen group. This list
// is the mask's whole vocabulary - a property that is not here is a property no
// tick box can turn on and no apply can move, which is why the panel lays its
// rows out against it rather than against a list of its own.
//
// Position and size are deliberately absent. They are the Inspector's: a bulk
// edit that set twenty boxes to the same x/y would stack them on top of each
// other, and there is no reading of "apply this style to those boxes" that
// wants that.
export const BULK_PROPS = [
  // Font & Layout
  'font',
  'size',
  'bold',
  'italic',
  'uppercase',
  'align',
  'valign',
  'lineHeight',
  'letterSpacing',
  // Fill & Stroke & Shadow. `gradient`, `pattern`, `strokes` and `shadows`
  // are whole-value leaves: a bulk edit moves the entire gradient / the entire
  // stroke list, never one field of one stroke. Splitting a list by index
  // would name entries the target boxes do not have.
  'color',
  'opacity',
  'gradient',
  'pattern',
  'strokes',
  'shadows',
  'blur',
  'motionBlur',
  // Warp & Edges
  'curve',
  'circle',
  'roughen.on',
  'roughen.amount',
  'roughen.detail',
  'roughen.seed',
  'clip',
  // `path`, `ink` and `warp` are deliberately absent: anchors, hand-drawn
  // strokes and mesh control points are all box-local geometry in THIS box's
  // px, and a bulk edit would smear them across boxes of different sizes - a
  // warp mesh especially, whose points stop meaning anything the moment the box
  // they were dragged on is not the box they land on.
  // Typeset
  'shape',
  'minOrphan',
  'hyphenate',
  'balloon',
  'autoHeight',
  // Transform
  'rotation',
  'flipH',
  'flipV',
];

// The keys above that are moved WHOLE - a bulk edit copies a whole
// gradient or a whole stroke list, never one field of one stroke (see the
// comment on BULK_PROPS). Named once here because two places have to agree on
// it: the style-leaf arithmetic that pins BULK_PROPS against `defaultStyle`
// treats these as single leaves rather than groups of them.
export const BULK_WHOLE_LEAVES = ['gradient', 'pattern', 'strokes', 'shadows', 'motionBlur', 'clip', 'circle'];

// How the panel rows group the mask's vocabulary for its tick-all headers.
// Declared beside BULK_PROPS rather than inside the panel so there is one list
// of what a bulk edit can move and one grouping of it: a key in here but not in
// BULK_PROPS would be a header that ticks nothing, and the tests pin the two
// together. Every key appears in exactly one group.
export const GROUPS = {
  font: ['font', 'size', 'bold', 'italic', 'uppercase', 'align', 'valign', 'lineHeight', 'letterSpacing'],
  fill: ['color', 'opacity', 'blur', 'motionBlur', 'strokes', 'gradient', 'pattern'],
  shadow: ['shadows'],
  warp: ['curve', 'circle', 'roughen.on', 'roughen.amount', 'roughen.detail', 'roughen.seed', 'clip'],
  typeset: ['shape', 'minOrphan', 'hyphenate', 'balloon'],
  transform: ['rotation', 'flipH', 'flipV', 'autoHeight'],
};

// The mask holds only the ticked keys, so "not ticked" and "absent" are the same
// state and there is no third one to get out of step. Read through here rather
// than off `app.bulk.mask` directly, so a key that is not a real property - a
// typo in a panel row, a path from an older build - can never be counted as a
// tick that then moves nothing.
export const bulkTicked = () => BULK_PROPS.filter((k) => app.bulk.mask[k]);
export function setBulkProp(key, on) {
  if (!BULK_PROPS.includes(key)) return;
  const next = { ...app.bulk.mask };
  if (on) next[key] = true;
  else delete next[key];
  app.bulk.mask = next;
}
// What every control in the panel calls as it writes into the template: touching
// a property is the user saying they want it in this edit. That is the whole
// reason a fresh mask can start empty (see `openBulk`) without the first bulk
// edit being an exercise in ticking boxes.
export const tickBulkProp = (key) => setBulkProp(key, true);

// `template`'s value wins for every ticked property; everything else comes off
// `base` untouched. This one function is the whole of "unticked properties leave
// the target boxes alone", so the click-to-select apply and the tag apply cannot
// drift into two different answers about what a mask means.
export function mergeMasked(base, template, mask = {}) {
  // Both cloned: the whole-value leaves (`strokes`, `gradient`, ...) are arrays
  // and objects, and copying them by reference off a reactive template would
  // leave every target box sharing one stroke list with the panel.
  return mergeMaskedInto(cloneStyle(base), cloneStyle(template), mask);
}

// The in-place half of `mergeMasked`, for callers applying one template to many
// bases - the bulk apply above all. `out` and `template` are overwritten /
// read as they stand, so the caller clones them (once for the batch, not once
// per box) and hands the clones over.
export function mergeMaskedInto(out, template, mask = {}) {
  for (const key of BULK_PROPS) {
    if (!mask[key]) continue;
    const dot = key.indexOf('.');
    if (dot === -1) {
      const v = template[key];
      // A style never holds undefined on purpose (`normalizeStyle` fills every
      // leaf), so an absent field means "the template has no opinion" rather
      // than "write nothing here" - skipping it is what keeps a partial
      // template from erasing the base's value.
      if (v !== undefined) out[key] = v;
    } else {
      // `cloneStyle` normalises, so the nested group is present on `out` even
      // when `base` came off an older document that had never heard of it.
      const grp = key.slice(0, dot);
      const field = key.slice(dot + 1);
      const gv = template[grp]?.[field];
      if (gv !== undefined) out[grp][field] = gv;
    }
  }
  return out;
}

export function openBulk() {
  // Bulk mode ends any inline edit, and the box being typed into stays on the
  // page - so the gesture that created it is settled and recorded, not dropped.
  if (app.editingId) {
    settleText();
    settlePending();
  }
  const seed = app.selectedId ? byId(app.selectedId)?.style : null;
  app.bulk = {
    active: true,
    targets: [],
    // Membership index over `targets`. A Set rather than a second array so a
    // "is this box ticked?" read is O(1): the canvas asks it once per box per
    // frame while targets are highlighted. Rebuilt on every toggle - the array
    // stays the source of truth.
    targetSet: new Set(),
    style: cloneStyle(seed ?? app.lastStyle),
    // Nothing ticked. The other two candidates are worse: everything ticked is
    // today's behaviour - the whole template lands on every target - which is
    // the complaint this mask exists to answer, and it would make "only the
    // colour" twenty-six unticks. A remembered mask would silently carry the
    // last edit's intent into an unrelated one.
    //
    // Empty is only workable because every control ticks its own property as it
    // is changed (`tickBulkProp`): the user who wants to change the colour picks
    // a colour and presses Apply, and the tick boxes are there to correct that
    // - to drop a property they fiddled with and thought better of, or to push a
    // value they never touched because the seeded template already holds it.
    mask: {},
    // No tag chosen: the panel opens in click-to-select. Scope is remembered
    // across opens no more than the mask is - an edit that quietly inherited
    // "this page" from an hour ago would silently miss the rest of a chapter.
    tag: '',
    scope: 'chapter',
  };
  app.editingId = null;
}
export function closeBulk() {
  app.bulk = { active: false, targets: [], targetSet: new Set(), style: null, mask: {}, tag: '', scope: 'chapter' };
}

// The pages a tag-scoped selection or apply reaches. One reading of
// `app.bulk.scope`, shared by the selection sync below and by the Apply the
// panel fires, so the boxes highlighted are exactly the boxes restyled.
export function bulkScopePages() {
  if (app.bulk.scope === 'page') {
    const p = page();
    return p ? [p] : [];
  }
  return app.pages;
}

// A tag IS a selection: choosing one names its boxes, so the user never clicks
// them. This is the single place that turns a tag into `targets`, which is what
// makes the canvas highlight, the footer count and the Apply agree - before,
// the tag lived only in the panel and the footer Apply stayed disabled at
// "0 selected" while the user was staring at a tag they had just picked.
export function syncBulkTagTargets() {
  if (!app.bulk.active) return 0;
  if (!app.bulk.tag) return 0;
  const next = boxesWithTag(app.bulk.tag, bulkScopePages()).map((h) => h.box.id);
  app.bulk.targets = next;
  app.bulk.targetSet = new Set(next);
  return next.length;
}

export function setBulkTag(name) {
  if (!app.bulk.active) return;
  app.bulk.tag = name || '';
  // Clearing the tag clears what the tag put there. Leaving the boxes ticked
  // would hand the user a selection with nothing on screen explaining it.
  if (!app.bulk.tag) {
    app.bulk.targets = [];
    app.bulk.targetSet = new Set();
    return;
  }
  syncBulkTagTargets();
}

export function setBulkScope(scope) {
  if (!app.bulk.active) return;
  app.bulk.scope = scope === 'page' ? 'page' : 'chapter';
  // Only a tag selection follows the scope. A hand-picked set is the user's
  // own list of boxes and narrowing the scope must not silently drop half of it.
  if (app.bulk.tag) syncBulkTagTargets();
}
// A Set read rather than `targets.includes`: this runs once per box per frame
// while the panel is open (the canvas highlights every target), and a linear
// scan per box is the one cost a tick list does not have to pay.
export const isBulkTarget = (id) => app.bulk.active && app.bulk.targetSet.has(id);
export function toggleBulkTarget(id) {
  if (!app.bulk.active) return;
  // A click takes the selection over. The tag's boxes stay ticked - they are a
  // fine starting point to refine - but the tag itself is dropped, or the next
  // scope change would re-derive the set and throw the refinement away.
  app.bulk.tag = '';
  const i = app.bulk.targets.indexOf(id);
  const next = i === -1 ? [...app.bulk.targets, id] : app.bulk.targets.filter((x) => x !== id);
  app.bulk.targets = next;
  app.bulk.targetSet = new Set(next);
}
// The one place the mask is turned into new styles, for both ways of naming the
// boxes. `boxes` is what to restyle; the record's `before`/`after` are whole
// styles rather than the masked fields, because that is what the history's
// `bulk` kind assigns - an entry carrying only the changed fields would replace
// each box's style with a fragment on undo.
function restyleForBulk(boxes) {
  const items = [];
  // One clone of the template for the whole batch, not one per box: the merge
  // reads it and never writes it, so every target can share the copy. (`out`,
  // by contrast, is per box - each `after` must stand alone.)
  const tpl = cloneStyle(app.bulk.style);
  const mask = app.bulk.mask;
  // The style every box placed afterwards inherits moves with this apply too -
  // see the block below - so the history entry has to carry it on both sides,
  // or an undo would restore the boxes and leave `lastStyle` bulk-advanced:
  // every future box would then be born in a style no undo step accounts for.
  let lastStyleBefore = null;
  let lastStyleAfter = null;
  for (const { page: pg, box: b } of boxes) {
    const before = cloneStyle(b.style);
    const after = mergeMaskedInto(cloneStyle(before), tpl, mask);
    const geomBefore = fitGeom(b);
    b.style = cloneStyle(after);
    if (mask?.size) rememberSizeFor(pg, b);
    // A bulk that changes the font, the size or the line height changes what
    // every target box has to fit. It costs no extra undo step: the item carries
    // the geometry either side of the fit, so the one entry the apply writes
    // walks the style and the height it caused back together - per box, because
    // one entry covers many and they grew by different amounts.
    autoFitBox(b, pg);
    items.push({ pageId: pg.id, boxId: b.id, before, after, geomBefore, geomAfter: fitGeom(b) });
  }
  // Both inside the guard, and `lastStyle` especially: an apply that matched no
  // box is not an edit, and it must not leave a trace on the style every later
  // box is born with. `applyBulkToTag('nosuchtag')` restyled nothing and still
  // moved the inherited roughen amount from 4 to 13 - a style the user could
  // then not account for, because it had never been applied to anything they
  // could see.
  //
  // Only the ticked half carries, for the same reason it is the only half that
  // reaches a box: handing `lastStyle` the whole template would push properties
  // this edit deliberately left alone onto every box placed afterwards.
  if (items.length) {
    markUnsaved();
    lastStyleBefore = cloneStyle(app.lastStyle);
    app.lastStyle = mergeMaskedInto(app.lastStyle, tpl, mask);
    lastStyleAfter = cloneStyle(app.lastStyle);
  }
  return { items, lastStyleBefore, lastStyleAfter };
}

// The history half of a bulk apply, shared by both ways of naming the boxes,
// because both can now reach more than one page - the tag-scoped apply always
// could, and the click-to-select one can the moment the chapter is a longstrip.
//
// One entry per page the apply reached, onto that page's own stack - not one
// entry for the whole apply. A single entry can only live on one stack, and undo
// is per page: the one entry filed against the page on screen would rewind boxes
// on pages that were keeping stacks of their own, whose `before`/`after` still
// described the world before this apply. Their next undo would then restore a
// style they had not been in since, and redo the same in reverse. Splitting is
// what makes each page's stack describe only its own boxes, which is the
// invariant the history's `bulk` kind reads for.
//
// The cost, and it is a real one the callers say out loud: an apply that spans
// pages is not one press of undo. It is one press *per page*, taken on that
// page. Every other reading of it was a lie about what undo would do.
//
// Items keep the order they were restyled in, so each page's entry carries its
// boxes in document order. Which page's entry is written first does not matter -
// they go to different stacks. Returns how many pages were reached, which is the
// only thing the callers' messages need that they cannot see for themselves.
//
// `lastStyleBefore`/`lastStyleAfter` ride on every entry the apply produces (all
// of them carry the same pair), because undoing one of those entries has to walk
// the inherited style back with the boxes - see `restyleForBulk`. Entries from
// writers that never touch `lastStyle` simply omit the pair.
function recordBulkByPage(items, lastStyleBefore = null, lastStyleAfter = null) {
  const byPage = new Map();
  for (const it of items) {
    const bucket = byPage.get(it.pageId);
    if (bucket) bucket.push(it);
    else byPage.set(it.pageId, [it]);
  }
  for (const [pageId, its] of byPage)
    recordEdit({ t: 'bulk', pageId, items: its, lastStyleBefore, lastStyleAfter });
  return byPage.size;
}

export function applyBulk() {
  if (!app.bulk.active || !app.bulk.style) return;
  // A tag selection is re-resolved at apply time rather than trusting the ids
  // `syncBulkTagTargets` left behind: tagging or untagging a line while the
  // panel is open changes which boxes the tag names, and the apply must land on
  // what the tag means now, not on what it meant when it was picked.
  if (app.bulk.tag) {
    applyBulkToTag(app.bulk.tag, bulkScopePages());
    return;
  }
  // An apply with nothing ticked would write each box's own style back over
  // itself and record an undo step that rewinds nothing. Refused with a reason
  // rather than silently doing nothing, because from the user's side an Apply
  // that changed no pixel is indistinguishable from a broken one.
  if (!bulkTicked().length) {
    toast('Tick a property first - nothing is set to change');
    return;
  }
  // Every page, not `page()`. In a longstrip chapter the whole chapter is drawn
  // as one column, so the user can tick targets on any slice while the index
  // sits on whichever one the scroll last focused - and a lookup scoped to that
  // one page answered `undefined` for all the rest, which `filter(Boolean)` then
  // dropped without a word. Tick six boxes, press Apply, two of them change and
  // the toast says two. A paged chapter is unaffected: every target is on the
  // page on screen by construction, so this finds it on the first page it looks
  // at.
  const { items, lastStyleBefore, lastStyleAfter } = restyleForBulk(
    app.bulk.targets
      .map((id) => {
        for (const pg of app.pages) {
          const box = pg.boxes.find((x) => x.id === id);
          if (box) return { page: pg, box };
        }
        return null;
      })
      .filter(Boolean),
  );
  // Nothing matched - every ticked target was on a page that has since gone, or
  // the click never landed. Closing here would throw the composed template away
  // along with the mask, and the user would rebuild both to try again; the
  // template has cost them something to compose, so it stays.
  if (!items.length) {
    toast('No boxes selected');
    return;
  }
  // One record per page rather than one for the apply, for the reason spelled
  // out over `recordBulkByPage` - which in a paged chapter is still exactly one.
  const pageCount = recordBulkByPage(items, lastStyleBefore, lastStyleAfter);
  closeBulk();
  toast(
    `Applied style to ${items.length} box${items.length > 1 ? 'es' : ''}` +
      (pageCount > 1 ? ` · ${pageCount} pages, one undo step each` : ''),
  );
}

// The tag-driven half of the same edit: every box carrying `name` is restyled at
// once, without the user clicking one of them. Scope is the `pages` array the
// caller hands over - `app.pages` for the whole chapter, `[page()]` for this one
// - which is the vocabulary `boxesWithTag` already speaks, so there is no scope
// enum here either. `app.bulk.targets` is untouched and unread: the click-to-
// select flow and this one are two ways of naming boxes, never one.
//
// A box typed onto the page is reached like any other: it has a line of its own
// now (see `addEmptyBox`), so it can be tagged and `boxesWithTag` returns it.
// The one thing still out of reach is a free-typed box saved to disk before that
// was true - no line, so no tags - and those are deliberately left unmigrated.
// The panel counts them out loud rather than leaving the user to wonder why
// three boxes on the page did not change.
//
// Returns how many boxes were restyled, so the caller can say so.
export function applyBulkToTag(name, pages = app.pages) {
  if (!app.bulk.active || !app.bulk.style) return 0;
  if (!bulkTicked().length) {
    toast('Tick a property first - nothing is set to change');
    return 0;
  }
  const { items, lastStyleBefore, lastStyleAfter } = restyleForBulk(boxesWithTag(name, pages));
  // Kept open for the same reason as `applyBulk`: the template and its mask
  // survive an apply that reached nothing.
  if (!items.length) {
    toast(`No boxes tagged “${name}” in scope`);
    return 0;
  }
  // One entry per page - see `recordBulkByPage`. Grouped in the order
  // `boxesWithTag` walked the pages, so each page's entry carries its boxes in
  // document order.
  const pageCount = recordBulkByPage(items, lastStyleBefore, lastStyleAfter);
  closeBulk();
  toast(
    `Applied style to ${items.length} box${items.length > 1 ? 'es' : ''} tagged “${name}”` +
      (pageCount > 1 ? ` · ${pageCount} pages, one undo step each` : ''),
  );
  return items.length;
}

// ---------- tags on a queued line ----------
// Applying a tag used to be an action with no effect the user could see: a
// tag's defaults reach a box only through `styleForLine` inside `placeActiveAt`,
// so tagging a line whose box was already placed changed a badge and nothing
// else, and the user was left to conclude the tag defaults did not work.
//
// So an apply now restyles the box, and the rule is exactly the rule placement
// already follows - the box is moved to `styleForLine(line, its own style)`.
// Stated the other way round: after applying a tag, the box carries the style it
// would have been born with had it been placed under the line's tags as they now
// stand. The two orders agree by construction, because they are the same
// function; there is no second answer to keep in step.
//
// What that means for manual styling, since it is the question the rule has to
// answer: the tag wins, over the three fields a tag can define and no others.
// `styleForLine` only ever sets font and the stroke list, and only those
// its tags actually define - so size, colour, shadow, warp, rotation, every
// property the user set by hand in the Inspector, come through untouched. If the
// tag defines nothing, nothing changes, nothing is recorded, and the caller is
// told so. The alternative - manual styling wins - makes an apply do nothing on
// precisely the boxes the user has been fiddling with, which is the complaint
// this exists to answer. It is one undo press away either way.
//
// Un-applying restyles nothing. A box's style is a value it owns, not a
// reference to the tag; there is no "what it would have been" to go back to, and
// guessing would be a second rule for the same button.
//
// The tag write itself is not history - it never has been, and the chip is its
// own inverse. So an undo of the restyle gives the style back while the tag
// stays on the line, which is the honest reading of "one undo step for the
// restyle" and the reason the panel must not call this "undo the tag".
const sameStyle = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function restyleLineBoxes(p, ln) {
  // Every box on the line, not the first: `activateLine` will happily re-arm a
  // line that is already placed, so a second click on the canvas gives that line
  // two boxes. Both are the line's, so both follow its tags - and one entry
  // covers them, or the user would pay two presses for one click.
  const items = [];
  for (const b of p.boxes) {
    if (b.lineN !== ln.n) continue;
    const before = cloneStyle(b.style);
    const after = cloneStyle(styleForLine(ln, cloneStyle(b.style)));
    if (sameStyle(before, after)) continue;
    const geomBefore = fitGeom(b);
    b.style = cloneStyle(after);
    // A tag sets the font, and a different font measures differently - so this
    // is a restyle that can change how many lines the box's text takes, exactly
    // like the bulk apply above, and it fits for the same reason and records the
    // geometry either side for the same one.
    autoFitBox(b, p);
    items.push({ pageId: p.id, boxId: b.id, before, after, geomBefore, geomAfter: fitGeom(b) });
  }
  if (!items.length) return 0;
  // A `style` entry when there is one box, because that is what it is and its
  // failure message says so; `bulk` only for the case that needs it.
  if (items.length === 1) {
    const it = items[0];
    recordEdit({
      t: 'style',
      pageId: p.id,
      boxId: it.boxId,
      before: it.before,
      after: it.after,
      geomBefore: it.geomBefore,
      geomAfter: it.geomAfter,
    });
  } else {
    recordEdit({ t: 'bulk', pageId: p.id, items });
  }
  markUnsaved();
  return items.length;
}

// One click on a tag chip in the queue. Returns
//   { tags, added, restyled }
// - the line's tags after the click, whether this was an apply or an un-apply,
// and how many boxes were restyled (0 whenever the tag defines nothing, the line
// has no box yet, or this was an un-apply), so the panel can tell the user what
// actually happened rather than guessing.
export function toggleTagOnLine(n, name, p = page()) {
  const ln = lineByN(p, n);
  const tag = normalizeTagName(name);
  if (!ln || !tag) return { tags: ln ? lineTags(ln).slice() : [], added: false, restyled: 0 };
  const had = lineTags(ln).includes(tag);
  const tags = toggleLineTag(ln, tag);
  // The tags live on the line in chapter.json, so the click is a document edit
  // whether or not a box moved.
  markUnsaved();
  return { tags: tags.slice(), added: !had, restyled: had ? 0 : restyleLineBoxes(p, ln) };
}

// ---------- queue row click ----------
export function activateLine(n) {
  const p = page();
  p.activeLineN = n;
  if (isTranslateMode()) return;
  const b = p.boxes.find((x) => x.lineN === n);
  if (b) selectBox(b.id);
  else deselect();
}

// ---------- zoom ----------
// What the number means: `zoom` is page pixels to CSS pixels, so 100% draws the
// page's own pixel grid one-for-one - the frame is `p.w * zoom` wide and the
// image fills it. It is a ratio against `p.w`/`p.h`, which is why `setPageDims`
// keeping those equal to the displayed image's natural size is what makes the
// readout true rather than merely self-consistent.
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
// Quantised to a thousandth, here rather than only at the fit that used to do
// it. `app.zoom` is read by every mounted box - each tick rebuilds its
// `boxStyle`, its `textStyle` and its whole paint stack - so the value's
// precision is a cost paid by the entire page. The fit had this already (see
// `computeFit` in Canvas.svelte, where two pages a pixel apart in height gave
// zooms differing in the ninth decimal); the wheel did not, and a trackpad pinch
// is sixty to a hundred events of `zoom * exp(-dy * k)`, every one of them a
// fresh float and therefore a fresh rebuild of every box in the window.
//
// A thousandth is below what any of this can show: at 3000px of page it is 3px
// of travel, and the gesture still reads as continuous because the quantum is
// far smaller than a wheel notch. What it buys is that the events which do not
// move the zoom that far now write the value that is already there - and
// assigning an unchanged primitive to a rune is not a change, so nothing
// downstream re-runs at all.
const ZOOM_QUANTUM = 1000;
export function setZoom(z, isFit = false) {
  const q = Math.round(clamp(z, ZOOM_MIN, ZOOM_MAX) * ZOOM_QUANTUM) / ZOOM_QUANTUM;
  app.zoom = isFinite(q) ? q : app.zoom;
  app.isFit = isFit;
}
export function applyFit(z) {
  setZoom(z, true);
}
// A zoom gesture in flight, and the one thing that makes zooming an inked or
// warped page usable.
//
// Everything a box draws in CSS - its frame, its text, its strokes - is laid out
// by the browser at whatever zoom it is handed, and costs a frame's worth of
// layout. The two things it draws into a CANVAS do not: the ink layer repaints
// every sampled point of every stroke, and the warp layer re-runs the exporter's
// whole composite through the mesh. Both were keyed on the raw zoom, so a
// trackpad pinch asked for one full re-render of both, per box, per event.
//
// A canvas the browser is already scaling to its CSS box is not wrong while the
// gesture is moving - it is soft, by however far the zoom has travelled since
// the last paint - and it is exactly right the moment the gesture stops and the
// deferred paint runs. That is the trade this flag buys. It is the same one the
// warp gizmo already makes while a mesh handle is down.
export function setZoomLive(on) {
  app.zoomLive = !!on;
}
// The buttons step through named stops rather than multiplying by a constant.
// A ×1.2 ladder started from a fit of 43% reaches 52%, 62%, 75%, 90%, 107% - the
// user can never land on the half or the full size they are asking for, and the
// readout looks arbitrary because it is. These are the stops an image editor
// offers, so "50%" is a thing you can actually be at.
export const ZOOM_STOPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
// A hair of slack either side: fit lands on arbitrary values, and one that sits
// a floating-point crumb below a stop must still step up to the next one rather
// than to the stop it is already at.
const EPS = 1e-6;
export const zoomIn = () =>
  setZoom(ZOOM_STOPS.find((z) => z > app.zoom + EPS) ?? ZOOM_MAX);
export const zoomOut = () =>
  setZoom(ZOOM_STOPS.findLast((z) => z < app.zoom - EPS) ?? ZOOM_MIN);
export const zoomReset = () => setZoom(1);

// ---------- raw zoom ----------
// `app.rawZoom` is the reference sidebar's own scale, and 0 is Fit rather than a
// zoom of nothing - the image is `width:100%` of the column at 0 and
// `width:{100*rawZoom}%` at anything else. Both the buttons and the sidebar's
// wheel go through this one multiply so the two cannot drift, and so the Fit
// floor is written once.
//
// The ceiling is new and is the wheel's doing: the buttons were unbounded
// because reaching an absurd zoom took a lot of presses, and a trackpad pinch
// gets there in one flick. 8x the column width is far past anything a
// screentone inspection needs.
export const RAW_ZOOM_MAX = 8;
export function rawZoomBy(factor) {
  // Fit IS the floor, so a zoom out from it has nowhere to go. Without this the
  // `=== 0 ? 1` below reads Fit as 1x and steps down to 0.8 - the sidebar
  // visibly *shrinking* below the fit it was already at, on the one press whose
  // whole meaning is "smaller than this", and then jumping back to Fit on the
  // press after. Only the shrinking half returns early: zooming in from Fit
  // really does start from 1x, which is the entire reason that branch exists.
  if (app.rawZoom === 0 && factor < 1) return;
  const next = (app.rawZoom === 0 ? 1 : app.rawZoom) * factor;
  // Below Fit there is nothing to see, so the bottom of the range IS Fit rather
  // than a smaller and smaller thumbnail.
  app.rawZoom = next < 0.3 ? 0 : Math.min(next, RAW_ZOOM_MAX);
}
export const rawZoomIn = () => rawZoomBy(1.25);
export const rawZoomOut = () => rawZoomBy(1 / 1.25);

// ---------- fonts ----------
// The family a `style.font` string actually renders as. A document can name a
// font this machine has not got - a chapter authored elsewhere, or a font the
// user has since removed from the library - and everything downstream then
// silently draws the fallback instead. Callers that have to describe what was
// drawn (the PSD exporter names a face and says whether it was synthesised)
// need the same answer the renderer got, so the substitution happens here, once,
// rather than being re-derived per caller.
export const FALLBACK_FONT = 'Comic Neue';

// Every family the app can draw, whichever list it came from. Hidden built-ins
// and unshown system fonts are still in here: the menus stop offering them, but
// a box already set in one keeps its face.
export const allFonts = () => [...app.fonts.user, ...app.fonts.builtin, ...app.fonts.system];

// The family entry for a name, first list wins - the order `allFonts` states.
//
// Indexed rather than searched, because this sits under every text measurement:
// `measure.js` resolves the family on each `measureText`, and one line-balancing
// pass makes a few hundred of those. Spreading and scanning every list twice per
// call - the whole installed system font list included, hundreds of entries on a
// Mac - made a single box resize cost tens of milliseconds per pointer move.
//
// Rebuilt when any list is replaced or changes length, which covers every way
// the app changes them (a scan assigns, removal filters, an added family is
// pushed). Those same reads are what a reactive caller subscribes to, so a
// derived that resolved a font before its family arrived still re-runs.
let fontIndex = null;
let fontIndexOf = [];
export function fontByName(name) {
  const { user, builtin, system } = app.fonts;
  const k = fontIndexOf;
  if (
    !fontIndex ||
    k[0] !== user || k[1] !== builtin || k[2] !== system ||
    k[3] !== user.length || k[4] !== builtin.length || k[5] !== system.length
  ) {
    fontIndex = new Map();
    for (const f of allFonts()) if (!fontIndex.has(f.name)) fontIndex.set(f.name, f);
    fontIndexOf = [user, builtin, system, user.length, builtin.length, system.length];
  }
  return fontIndex.get(name) ?? null;
}

export function fontNameFor(name) {
  return fontByName(name) ? name : FALLBACK_FONT;
}

export function fontCssFor(name) {
  const f = fontByName(fontNameFor(name));
  return f ? f.css : "'Comic Neue', cursive";
}
