// ===== Central reactive store (Svelte 5 runes) =====
import { untrack } from 'svelte';
import {
  PAGE_W,
  PAGE_H,
  BUILTIN_FONTS,
  USER_FONTS,
  defaultStyle,
  applyBoxDefaults,
  normalizeStyle,
  normalizeFit,
  normalizeOutline,
  normalizeInkStroke,
  normalizeFinish,
  normalizeReview,
  normalizeTypesetting,
  normalizeAuto,
  LAYOUT_VERSION,
  LAYOUT_VERSION_RUST,
  plainStyle,
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
  findTag,
} from './tags.svelte.js';
// The one edge in this file that points at a module which points back: `measure`
// imports `fontCssFor` from here. Both directions are lazy - neither module
// touches the other at evaluation time, only inside function bodies - so the
// cycle resolves whichever order the two are first loaded in, and it buys the
// far more valuable property that `measure.js` stays the single owner of text
// metrics. The alternative was a second measurer living in the store, which is
// exactly how the editor and the exporter would start disagreeing about where a
// line breaks.
import {
  canMeasure,
  textInset,
  balancedBoxSize,
  clearLayoutMemo,
  setTypesetEnabled,
  faceFor,
} from './measure.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { browserFaceReady } from './text-engine/browser.js';
import { solveLayout } from './auto-layout.js';
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
  fitLimit,
  reviewFor,
  isAutoBox,
  manualReason,
  REVIEW_REASONS,
} from './contain.js';
import { neededHeight, growToFit, hasHangul } from './typeset.js';
import { takesHeightFloor } from './resize-math.js';
// The pixel half of balloon fitting, and the two halves of getting pixels to it.
// `balloon.js` is pure and knows nothing about this app; `page-pixels.js` is the
// app's answer to "where do the pixels come from", and it answers null wherever
// there is no canvas - which is to say under node, where every test below takes
// the fallback path exactly as a page nobody has opened does.
import { detectBalloon, detectBalloonAt, inscribedRect, balloonFrame, shapeContainsPoint, localUniformity, contrastInk } from './balloon.js';
import { findOutline } from './bubble-outline.js';
import { pagePixelsFor, forgetPagePixels } from './page-pixels.js';
import { measureChapterFits } from './chapter-fit.js';
// One-way, and it must stay that way: the brush tool's state module knows only
// its own defaults, so `setTool` can disarm it without the two ever cycling.
import { setBrushMode } from './brush-tool.svelte.js';
import { scaleStroke } from './brush.js';
import { translateStrokes } from './brush-board.svelte.js';
import { translateClipShapes } from './text-paint.js';
import { stripPageExtent, stripDragYBounds } from './editor/strip.js';
import { revealInStrip } from './editor/strip-sync.svelte.js';
import { exportPageColumn } from './export-pages.svelte.js';

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
const outlineField = (o) => {
  const outline = normalizeOutline(o);
  return outline ? { outline } : null;
};

// A loaded box given the plain wrap, for a chapter laid out under the old
// chapter-wide plain switch (`openTypesetting` in data.js). A solve that still
// described the box is renewed for the plain one, which lays out the same:
// left on the old fingerprint, a box still waiting for its face would read as
// edited (`solvePending`) and never be solved.
function givePlainWrap(b, p) {
  const style = plainStyle(b.style);
  if (style === b.style) return;
  const text = b.auto?.stamp ? boxText(b, p) : null;
  const stood = text != null && solveStands(b, text);
  b.style = style;
  if (stood) b.auto.stamp = solveStamp(b, text);
}

// `plain`: the chapter was laid out plain, and every box takes that wrap as its
// own (`givePlainWrap`) before anything below measures it.
export function loadProjectPages(rawPages, { plain = false } = {}) {
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
            boxes: (p.detect.boxes ?? []).map((b) => {
              const { outline, ...d } = b;
              if (b.fit === undefined) return d;
              return { ...d, fit: normalizeFit(b.fit), ...outlineField(outline) };
            }),
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
          // Where the fit came from and whether anyone approved it (Bubble A),
          // absent on a box saved before outlines existed.
          ...outlineField(b.outline),
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
  if (plain) for (const p of app.pages) for (const b of p.boxes) givePlainWrap(b, p);
  // Boxes arriving from outside this session get the same treatment every other
  // path gets - see `autoFitBox`. A box on disk was sized by an older build, by a
  // hand-edited file, or against a user font that has since been replaced, and
  // any of those can leave text hanging out of its own rectangle the moment the
  // chapter opens. Grow-only, so a box that is roomier than its text is left
  // exactly as the user left it, and a no-op in an environment with no text
  // metrics, so a test run never rewrites geometry from a stand-in number.
  // Before it, the one box a load lays out: one placed while its face was
  // loading and never solved, whose face is in by now (`solvePending`).
  //
  // And before either, with the Rust engine switched on and a chapter it has
  // not fitted before: every box is noted as the file has it (`beginFirstFit`),
  // so that what this pass changes can be told to the user and taken back.
  beginFirstFit();
  for (const p of app.pages) {
    solvePending(p);
    refitPage(p);
  }
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
  // The loader's own flag, not an edit: it stands until whoever opened the
  // chapter says whether what is in memory is what is in the file
  // (`loadChapter`), and the first-fit test below must not read it as the
  // user's doing.
  loaderDirty = true;
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
  lastStyle: defaultStyle(), // remembered style; new boxes inherit it when enabled (size is per tag, see sizeKeyFor)
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
  toast: { msg: '', seq: 0, kind: 'info' },
  // Errors that stay until the user closes them (FLOW-6). A failure gone in two
  // seconds is a failure the user may never have seen, so these are kept apart
  // from the passing toast above and stack, newest last. See `toastError`.
  errors: [],
  sidecar: { status: 'unknown', device: null, info: null }, // in-process detection engine health
  detecting: false, // detection/OCR request in flight
  detectBatch: null, // { done, total } while a whole-chapter detect runs, else null
  chapterPlace: null, // { done, total } while "Place chapter" measures its balloons, else null
  // The Regions view (Bubble C, FLOW-7, FLOW-12): every bubble outline in its
  // approval colour, the selected box's points, detected blocks with no box,
  // and line numbers. A view, not a document setting.
  showRegions: false,
  // True while the raw-page key is held (FLOW-7): the canvas shows the page
  // before cleaning, in place.
  peekRaw: false,
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

// ---------- an edit the Inspector has written onto a box ----------
// The panel writes the style, text or geometry field itself, then says so here:
// the store sizes the box for it (`autoFitBox` - the solver, the ladder or the
// verdict), marks the document, and carries the style to the next box placed.
// The panel records the history; it sizes nothing (ARC-1).
export function boxEdited(b, p = page()) {
  if (b) autoFitBox(b, p);
  markUnsaved();
  rememberStyle(b);
}

// The box as the Inspector's history sees it: the style, the text, the
// rectangle, the balloon fit a typed X or Y moves, and the solver's record, which an edit there can change (a typed
// size becomes the reference and is locked, a width is locked) and which the
// solve it runs rewrites.
export const boxSnap = (b) => ({
  style: cloneStyle(b.style),
  text: boxOwnText(b),
  x: b.x,
  y: b.y,
  w: b.w,
  h: b.h,
  fit: b.fit ? $state.snapshot(b.fit) : null,
  auto: b.auto ? $state.snapshot(b.auto) : null,
});

// The history entries one settled burst of Inspector edits makes, from the box
// before it (`boxSnap`) and after. `geom` says the burst typed into a placement
// field.
//
// Each entry carries everything the fit that burst ran can move - the rectangle,
// the size and the solver's record - since the solver re-sets the size and the
// height, and on a first solve the width and the place. So a style change that
// is only what a move or a text edit caused - the size a re-solve settled on,
// and for a move the ink carried with the rectangle - is no entry of its own:
// the `resize` or `text` entry puts it back with the rectangle, and one edit is
// one undo. A burst that also changed the look records that as its own `style`
// entry, as two edits. The balloon fit rides along, since a typed X or Y moves
// it with the box (`moveBoxTo`).
export function boxEditRecords(key, before, after, geom) {
  const out = [];
  const withFit = (g, snap) => ('fit' in snap ? { ...g, fit: snap.fit } : g);
  const withAuto = (g, snap) => withFit(snap.auto ? { ...g, auto: snap.auto } : g, snap);
  const fitOf = (snap) => withAuto({ x: snap.x, y: snap.y, w: snap.w, h: snap.h, size: snap.style.size }, snap);
  const geomOf = (snap) => {
    const g = fitOf(snap);
    if (snap.style?.ink?.on) g.ink = structuredClone(snap.style.ink);
    return g;
  };
  const fit = { geomBefore: fitOf(before), geomAfter: fitOf(after) };
  const moved = geom && ['x', 'y', 'w', 'h'].some((k) => before[k] !== after[k]);
  const typed = before.text !== after.text;
  const look = (st, ink) => JSON.stringify({ ...st, size: null, ...(ink ? { ink: null } : null) });
  const same = (ink) => look(before.style, ink) === look(after.style, ink);
  const carried = (moved && same(true)) || (typed && same(false));
  if (JSON.stringify(before.style) !== JSON.stringify(after.style) && !carried) {
    out.push({ t: 'style', ...key, before: before.style, after: after.style, ...fit });
  }
  if (moved) out.push({ t: 'resize', ...key, before: geomOf(before), after: geomOf(after) });
  if (typed) out.push({ t: 'text', ...key, before: before.text ?? null, after: after.text, ...fit });
  return out;
}

// ---------- a queue line's translation, typed into the queue ----------
// The queue's own field writes the line, and every box reading that line is
// fitted to it, as `setBoxText` fits the one box it writes. Here rather than in
// the panel, so the queue sizes nothing itself (ARC-1).
//
// One `line` entry per typing burst, so the toolbar undo can rewind a queue
// edit like any other edit - the field's own Cmd+Z covers the keystrokes. The
// burst opens on the first write to a line and closes LINE_SETTLE_MS after the
// last, or when another line is written, or when anything asks the app to
// settle (a page turn, an undo press - `settleEdits`). The boxes reading the
// line re-size as it is typed, so the entry carries their geometry on both
// sides as well (`boxes: [{ boxId, geomBefore, geomAfter }]`), which the
// history's `line` kind puts back: one undo restores the text and the boxes.
const LINE_SETTLE_MS = 400;
let linePending = null; // { pageId, lineN, before, geoms }
let lineT = null;
export function setLineText(p, n, v) {
  const ln = p ? lineByN(p, n) : null;
  if (!ln) return;
  if (linePending && (linePending.lineN !== n || linePending.pageId !== p.id)) settleLine();
  linePending ??= { pageId: p.id, lineN: n, before: ln.en ?? '', geoms: lineBoxGeoms(p, n) };
  ln.en = v;
  fitLineBoxes(p, n);
  markUnsaved();
  clearTimeout(lineT);
  lineT = setTimeout(settleLine, LINE_SETTLE_MS);
}
function settleLine() {
  clearTimeout(lineT);
  const pend = linePending;
  linePending = null;
  if (!pend) return;
  const pg = pageById(pend.pageId);
  const ln = pg ? lineByN(pg, pend.lineN) : null;
  if (!ln) return;
  const after = ln.en ?? '';
  if (after === pend.before) return;
  const now = new Map(lineBoxGeoms(pg, pend.lineN).map((g) => [g.boxId, g.geom]));
  const boxes = pend.geoms
    .filter((g) => now.has(g.boxId))
    .map((g) => ({ boxId: g.boxId, geomBefore: g.geom, geomAfter: now.get(g.boxId) }));
  recordEdit({ t: 'line', pageId: pend.pageId, lineN: pend.lineN, before: pend.before, after, boxes });
}
function fitLineBoxes(p, n) {
  for (const b of p?.boxes ?? []) if (b.lineN === n) autoFitBox(b, p);
}
const lineBoxGeoms = (p, n) =>
  (p?.boxes ?? []).filter((b) => b.lineN === n).map((b) => ({ boxId: b.id, geom: fitGeom(b) }));

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
// shape). Three ways that gets enforced:
//
//   the solver     `autoFitBox`, for a box the auto-layout solver manages: an
//                  AUTO box (auto sizing on, straight text, and no mesh, ink or
//                  mask pinned to it - see `isAutoBox` in contain.js) with a
//                  solver record (`box.auto`), text to set and its face loaded.
//                  After an edit its size, height and lines are solved again
//                  inside its balloon (`resolveBox`), so the height shrinks back
//                  when the text gets shorter or the box wider, and the size
//                  goes back up towards the reference size (FIT-2). What the
//                  solver cannot fit is flagged.
//   the ladder     `autoFitBox`, for every other auto box - one saved before the
//                  solver existed, one typed onto the page: after an edit or a
//                  placement, one that does not fit is grown - height, then
//                  width, within its balloon and the page - and then its font is
//                  shrunk, no lower than `minSizeFor`; only if that fails is it
//                  flagged. A MANUAL box is never moved, resized or shrunk here:
//                  it gets the verdict and nothing else.
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
// typing and its end (`setBoxText`, `endEdit`), the Inspector's text field and
// style controls, a preset, a style paste, the queue's own translation field
// (`fitLineBoxes`), a bulk apply, a tag apply, the balloon switch, the Refit
// button, a width drag, a placement, a chapter load, and a font arriving after
// all of those (`noteFontsChanged`) - because a `$effect` in the component would
// only ever cover the boxes rendered on the page currently on screen. The one
// effect that does size a box, TextBox's, is the grow-only net and nothing more
// (ARC-1). An undo or redo restores the recorded geometry directly rather than
// re-deriving it, and then re-checks.
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
  // An edit's fit: the box is the user's from here, and no longer one the
  // notice counts as the engine's doing.
  noteEdited(b);
  if (boxFaceArriving(b, p)) {
    holdFit(b);
    return false;
  }
  // Before the ladder can shrink it: a size the user has just typed or dragged
  // is their reference size, and the answer below is only what fits.
  noteSizeEdit(b, p);
  const text = boxText(b, p);
  const cand = boxCandidate(b, text);
  if (!isAutoBox(cand)) {
    reviewBox(b, p);
    return false;
  }
  if (b.auto?.on) {
    const solved = resolveBox(b, p, text);
    if (solved != null) return solved;
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
//   for the line's tag (`tagSize`), or the box's own reference size when there
//   is none (`refSizeOf`: not the size it was shrunk to, or every shrink would
//   lower the floor for the next). A
//   quarter smaller is about as far as a letterer shrinks one balloon before it
//   reads as a different voice from the balloons around it; past that, the text
//   needs a decision - a bigger balloon, fewer words - and the flag asks for it.
//
// The solver stops at the same floor (`solveFloor`, off the box's own reference
// size), and text it cannot fit there is flagged rather than shrunk on towards
// the preference. That is a choice, and the rule it answers to - text never
// leaves its box unflagged, and is never clipped - holds either way: the
// preference is the one floor nothing ever goes below, "Fit now" included, and
// the three quarters is how far the app goes without asking. Shrinking a
// balloon's text to half the size of its neighbours to avoid a flag would trade
// a visible, fixable problem for a quiet one nobody is told about.
let minFontSize = 12;
export function setMinFontSize(v) {
  const n = Number(v);
  if (n > 0) minFontSize = n;
}
const solveFloor = (ref) => Math.max(minFontSize, 0.75 * ref);
function minSizeFor(b, p) {
  const line = b.lineN != null && p ? lineByN(p, b.lineN) : null;
  return solveFloor(tagSize(sizeKeyFor(line)) ?? refSizeOf(b));
}

const stripOf = (p) => {
  const copied = exportPageColumn(p);
  const pages = copied === undefined ? (isLongstrip() ? app.pages : null) : copied;
  return pages ? stripPageExtent(pages, p?.id) : null;
};

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
  seeSize(b);
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

// Whether a box needs review, and why: what every reader of the flag asks - the
// editor's badge, the shared check list and export preflight, the PSD's layer
// name. The containment check's flag (`box.review`), or else the solver's
// (below), which is not written anywhere: it is worked out from the solver's
// record each time it is read, so it can never outlive the box it was about.
// `p` is the box's page, for its text.
export const reviewOf = (b, p) => b?.review ?? solverReview(b, p);

// The solver's own "does not fit" (FIT-5), for a box the containment check has
// nothing against. The solver asks more of a box than that its ink stays inside
// it: every line has to fit its own row of the balloon. Its best effort when
// nothing does - `status: 'overflow'` - can hold every glyph inside a box that
// itself runs past the balloon's curve, and the check, which measures against
// the box, then passes a box whose text the user can see leaving its bubble.
//
// So the last solve's answer is part of the verdict, for as long as it is the
// answer that stands: an auto box (auto sizing on and nothing hand-placed in it
// - see `isAutoBox`) whose solver record is on, whose last solve overflowed, and
// which is still the box that solve laid out (`solveStands`). Read off
// `box.auto` rather than kept in `box.review`, because the record is what is
// saved with the box and snapshotted with it by the history - so a chapter
// opening (measured or not), an undo and a redo all come to the same flag, and
// no check has to run for it to appear or to go. It goes when a later solve
// succeeds, when the box turns manual, and when anything the solve was solved
// for changes - by whichever path changes it.
//
// No edge of the box is crossed, so every side reads 0 - it is the balloon the
// text leaves, and the reason names what the solver ran out of.
function solverReview(b, p) {
  const a = b?.auto;
  if (!a?.on || a.status !== 'overflow' || !isAutoBox(b) || !solveStands(b, boxText(b, p))) return null;
  return { kind: 'overflow', overflow: { l: 0, t: 0, r: 0, b: 0 }, reason: a.reason ?? REVIEW_REASONS.minSize };
}

// What a solve was solved FOR, as a short fingerprint kept on the record
// (`auto.stamp`): the text, the rectangle, the balloon and every style field the
// lines are laid out from. The status is the solve's answer only while the box
// still matches it. Most edits - typing, a size or font change, a resize, a
// rotation, a refit to another balloon - run the ladder or nothing, not the
// solver, and it is not theirs to keep a solver's record up to date; they
// change the box, and the stamp stops matching. A move and a rescale are the
// exceptions: they carry the fit with the box, so the solve is the same one
// somewhere else, and they renew the stamp (`moveBoxTo`). An undo that puts
// the box back as it was solved makes it match again. One comparison wherever
// the status is read, instead of a guard in every path that can edit a box.
//
// Hashed, because the text can be long and the stamp rides every save. FNV-1a,
// 32 bits: a collision would take an edit that lands on the same hash, about one
// in four billion.
// The flips count because they mirror the finished block inside the box, and
// a block anchored to one edge lands at the other - away from the rows the
// balloon gave it.
const STAMP_STYLE = ['font', 'size', 'bold', 'italic', 'align', 'valign', 'lineHeight', 'letterSpacing', 'uppercase', 'shape', 'balloon', 'hyphenate', 'minOrphan', 'rotation', 'flipH', 'flipV'];
function solveStamp(b, text) {
  const s = b.style;
  const key = JSON.stringify([
    String(text ?? ''),
    b.x,
    b.y,
    b.w,
    b.h,
    textInset(s),
    b.fit ?? null,
    ...STAMP_STYLE.map((k) => s[k] ?? null),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const solveStands = (b, text) => !!b.auto?.stamp && b.auto.stamp === solveStamp(b, text);

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
  if (!b?.style || !canMeasure() || boxFaceArriving(b, p)) return;
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
  if (!b?.style || !canMeasure() || boxFaceArriving(b, p)) return false;
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
  if (!b?.style || !canMeasure() || boxFaceArriving(b, p)) return false;
  const cand = boxCandidate(b, boxText(b, p));
  return growAndReview(b, p, cand, placeBlock(cand), lineCount);
}

// The two grow-only paths' shared tail: grow an auto box's height, then write
// the verdict. The growth moves `y` and `h` and nothing else, which the lines
// do not read, so the block placed for the box as it stood is re-placed at the
// new height rather than laid out again.
//
// Not an edit, so a box that was the solve's answer before it grew is still
// that answer after: its stamp moves with it (`solveStamp`).
function growAndReview(b, p, cand, place, lineCount) {
  // For a chapter the Rust engine fits for the first time: what this writes
  // is the engine's doing, when the box is still as the engine last left it.
  const was = fitting(b);
  const held = solveStands(b, cand.text);
  const changed = isAutoBox(cand) ? growHeightTo(b, lineCount, p, cand, place) : false;
  if (changed && held) b.auto.stamp = solveStamp(b, cand.text);
  reviewBox(b, p, changed ? placeAtHeight(place, boxCandidate(b, cand.text)) : place);
  fitted(b, was);
  noteRelaid(b, place);
  return changed;
}

// The grow-only height rule, once: the taller of what the lines need and what
// the ink needs, anchored by `valign`, capped by the page - or by the whole
// strip in a longstrip document, where a box may hang over a seam.
//
// A box the solver manages is capped by its balloon instead, within its page
// (`fitLimit`, never smaller than the box as it stands), and never by the whole
// strip (FIT-2): the page cap is how an oversized font once became a box 708 px
// tall that had left its bubble, and in a longstrip the whole chapter was the
// cap. What its balloon cannot hold is flagged, like any overflow.
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
  const lim = b.auto?.on ? fitLimit(cand, p, null) : null;
  const extent = lim ? { top: -lim.y0, total: lim.y1 - lim.y0 } : stripOf(p);
  const from = extent && extent.total > 0 ? b.y + extent.top : b.y;
  const next = extent && extent.total > 0
    ? growToFit({ y: from, h: b.h, valign: s.valign }, need, extent.total)
    : growToFit({ y: b.y, h: b.h, valign: s.valign }, need, p?.h ?? 0);
  // Nothing to grow. Compare in the extent's own coordinates: a top edge
  // taken into a long strip's coordinates
  // and back is not always the number it was (`(y + top) - top`, off in the
  // last bit), and the comparison below then reads that as a box that moved -
  // a `y` written by an open that grew nothing, in hundreds of boxes of a
  // long chapter. Neither engine may rewrite a no-growth top edge.
  if (next.h === b.h && next.y === from) return false;
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
// A box the solver manages carries its record too - the reference size, the
// locks and the status of the solve that laid it out - since an edit re-solves
// it, and an undo that put the rectangle back without the record would leave a
// status about a box that is no longer there.
export const fitGeom = (b) => ({
  x: b.x,
  y: b.y,
  w: b.w,
  h: b.h,
  size: b.style.size,
  ...(b.auto ? { auto: $state.snapshot(b.auto) } : null),
});

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
  if (!b?.style || !canMeasure() || boxFaceArriving(b, p)) return false;
  settleEdits();
  const before = cloneStyle(b.style);
  const geomBefore = fitGeom(b);
  const reviewBefore = b.review;
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
  if (!changed) {
    if (b.review !== reviewBefore) markUnsaved();
    return false;
  }
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
  const reviewBefore = b.review;
  b.style.autoHeight = true;
  const moved = autoFitBox(b, p);
  if (was !== false && !moved) {
    if (b.review !== reviewBefore) markUnsaved();
    return false;
  }
  recordEdit({ t: 'style', pageId: p.id, boxId: b.id, before, after: cloneStyle(b.style), geomBefore, geomAfter: fitGeom(b) });
  markUnsaved();
  return true;
}

// Every flagged box, in page order: the overflow half of the check list
// (`checkItems`). Reactive when read inside a `$derived` - it reads each box's
// `review`, and `writeReview` only writes when a flag actually changes, and
// each box's solver status, past which it reads only for a box that overflowed.
export function flaggedBoxes(pages = app.pages) {
  const out = [];
  for (const pg of pages ?? []) {
    for (const b of pg?.boxes ?? []) {
      // The queue's list also holds a box whose lines the Rust engine moved
      // the first time it fitted the chapter, while that is being told
      // (`relaidNote`). Only this list: the badge, the export and the PSD ask
      // `reviewOf`, and to them such a box is one that fits.
      const review = reviewOf(b, pg) ?? relaidNote(b);
      if (review) out.push({ pageId: pg.id, boxId: b.id, review });
    }
  }
  return out;
}

// ===== the check list (FLOW-1) =====
//
// Every reason a box or a line still needs a look, in one list: what the
// "N to check" pill counts, what Next (Mod+J) walks, what the queue's review
// list groups and what the export warns with. Derived, never stored: each
// reason is read off the box as it stands, so fixing the box is what clears it.
//
// Order: page order, then box order on the page, then the page's unplaced
// lines in queue order. A box with several reasons has one item per reason, in
// CHECK_REASONS order, so the list can group them; Next walks places, not items.
//
//   overflow  the text does not fit (`reviewOf`, as `flaggedBoxes` lists it)
//   open      the finder found no closed outline (01-bubble-check.md)
//   outline   an outline nobody approved; `confidence` for the list's sort
//   stale     laid out for inputs the box no longer has (`isLayoutStale`)
//   empty     a box with no text and no ink: a line placed before it had English
//   font      set in a font this machine cannot draw
//   unplaced  a detected line with no box yet (`placeableDetectedLines`)
//
// Glossary misses (06-text.md) join once the series guide exists (M4).
export const CHECK_REASONS = ['overflow', 'open', 'outline', 'stale', 'empty', 'font', 'unplaced'];

export function pageCheckItems(pg, pageIndex = app.pages.indexOf(pg)) {
  const out = [];
  if (!pg) return out;
  const pageId = pg.id;
  (pg.boxes ?? []).forEach((b, slot) => {
    const at = { pageId, pageIndex, slot, boxId: b.id };
    const review = reviewOf(b, pg) ?? relaidNote(b);
    if (review) out.push({ ...at, reason: 'overflow', review });
    const state = outlineState(b);
    if (state === 'open') out.push({ ...at, reason: 'open' });
    else if (state === 'waiting') out.push({ ...at, reason: 'outline', confidence: Number(b.outline?.confidence) || 0 });
    if (isLayoutStale(b, pg)) out.push({ ...at, reason: 'stale' });
    const inked = !!(b.style?.ink?.on && b.style.ink.strokes?.length);
    if (!inked && !String(boxText(b, pg) ?? '').trim()) out.push({ ...at, reason: 'empty' });
    const font = b.style?.font;
    if (typeof font === 'string' && font && fontMissing(font)) out.push({ ...at, reason: 'font', font });
  });
  const n = pg.boxes?.length ?? 0;
  placeableDetectedLines(pg).forEach((l, i) => {
    out.push({ pageId, pageIndex, slot: n + i, lineN: l.n, reason: 'unplaced' });
  });
  return out;
}

export function checkItems(pages = app.pages) {
  if (isTranslateMode()) return [];
  const out = [];
  (pages ?? []).forEach((pg, i) => {
    for (const it of pageCheckItems(pg, i)) out.push(it);
  });
  return out;
}

// Each page's status (FLOW-2), by page index, from a check list: 'todo' while
// the page has detected lines with no box, else 'check' while it has anything
// else to look at, else 'done'. Unplaced outranks the rest because a page with
// text still to place is not typeset yet, whatever its placed boxes say. Never
// stored, so there is no "done" stamp for a later edit to void: fixing the
// last item is what makes a page done.
export function pageStatuses(items, count = app.pages.length) {
  const out = new Array(count).fill('done');
  for (const it of items ?? []) {
    const i = it.pageIndex;
    if (i < 0 || i >= count || out[i] === 'todo') continue;
    out[i] = it.reason === 'unplaced' ? 'todo' : 'check';
  }
  return out;
}

// The open chapter's list, worked out once and shared: the pill, the queue's
// list, the page dots and the export all read `checks.items` rather than each
// walking the chapter. Lazy: nothing is computed until something reads it.
// `pages` is one pass over that same list, so the dots add no walk of their own.
//
// Held page by page, so a keystroke in one box works out that page's list
// again and only joins the others: a whole chapter of fits and stamps is tens
// of milliseconds, too much to pay per letter.
class PageChecks {
  constructor(pg) {
    this.pg = pg;
  }
  items = $derived(pageCheckItems(this.pg, app.pages.indexOf(this.pg)));
}
// Each page's list is made under its own effect root, and so is the
// chapter's. A derived made with no effect over it (here, inside the chapter's
// list as it runs) is never told when what it read changes, and keeps its first
// answer forever.
function rooted(make) {
  let made;
  $effect.root(() => {
    made = make();
  });
  return made;
}
const pageChecks = new WeakMap();
function checksOf(pg) {
  let c = pageChecks.get(pg);
  if (!c) pageChecks.set(pg, (c = rooted(() => new PageChecks(pg))));
  return c.items;
}
class ChapterChecks {
  items = $derived(isTranslateMode() ? [] : app.pages.flatMap(checksOf));
  pages = $derived(pageStatuses(this.items, app.pages.length));
}
export const checks = rooted(() => new ChapterChecks());

// The first item at a place after `cursor` ({ pageIndex, boxId?, lineN? }),
// wrapping to the start of the chapter. A cursor on nothing (no selection)
// takes the page's first item, so Next from a fresh page starts on it. Null
// when the list is empty.
export function nextCheck(items, cursor = { pageIndex: app.pageIndex, boxId: app.selectedId }) {
  if (!items?.length) return null;
  const pi = cursor?.pageIndex ?? 0;
  const pg = app.pages[pi];
  let slot = -1;
  if (cursor?.boxId != null) slot = (pg?.boxes ?? []).findIndex((b) => b.id === cursor.boxId);
  else if (cursor?.lineN != null) {
    const own = items.find((it) => it.pageIndex === pi && it.lineN === cursor.lineN);
    slot = own ? own.slot : -1;
  }
  const after = (it) => it.pageIndex > pi || (it.pageIndex === pi && it.slot > slot);
  return items.find(after) ?? items[0];
}

// Open one check item: its page, then the box selected (the Inspector on it),
// or the unplaced line made the queue's active line with the Place tool ready.
export function openCheck(it) {
  if (!it) return false;
  if (it.pageIndex !== app.pageIndex) gotoPage(it.pageIndex);
  if (it.boxId != null) {
    selectBox(it.boxId);
    if (isLongstrip()) revealInStrip(it.boxId);
  } else if (it.lineN != null) {
    if (app.selectedId) deselect();
    page().activeLineN = it.lineN;
    setTool('place');
  }
  return true;
}

// Next (Mod+J): the next thing to check after the selection. Says so when the
// list is empty.
export function goNextCheck(items = checkItems()) {
  const it = nextCheck(items);
  if (!it) {
    toast('Nothing to check');
    return false;
  }
  return openCheck(it);
}

// Next page with work (FLOW-8): the first page after this one, wrapping, that
// is not done (`checks.pages`) - unplaced lines or anything else to check. The
// page-sized step beside Next's item-sized one, and with no "done" stamp to
// set on the way out: the page is done when its list is empty.
//
// In a strip there is no page to turn to - the scroll leads the index - so the
// page's first item is opened instead, which scrolls to it when it is a box.
export function nextPageWithWork(statuses = checks.pages) {
  const n = statuses.length;
  for (let k = 1; k < n; k++) {
    const i = (app.pageIndex + k) % n;
    if (statuses[i] === 'done') continue;
    if (isLongstrip()) return openCheck(checks.items.find((it) => it.pageIndex === i));
    gotoPage(i);
    return true;
  }
  const here = statuses[app.pageIndex];
  toast(here && here !== 'done' ? 'Only this page has work left' : 'Every page is done');
  return false;
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

// ---------- a chapter the Rust engine fits for the first time ----------
// A chapter's boxes were sized by whichever engine measured when they were
// lettered, and the file says which: `typesetting.version`, 1 for the browser,
// 2 for the Rust text engine (data.js). The two do not measure alike - the
// Rust engine reads a glyph's true outline where WebKit reports a line's
// advance as its ink, it has one rule for a synthesised bold, and its own
// breaker for plain text (text-engine/RULES.md) - so the first time the Rust
// engine opens a version 1 chapter, the grow-only pass every open runs can
// find something to do: a height to grow, a flag to raise or to clear, a
// line that breaks somewhere else. Nothing else: a box's width, size and
// place are not the open's to change under either engine (`refitBox`).
//
// The user's rule for that moment (2026-09-23) is that this may happen, and
// two things follow from it being the engine's doing and not theirs:
//
//   they are told   what changed, once, in the queue (EngineNotice.svelte):
//                   how many boxes grew, how many are newly flagged, how many
//                   are no longer, how many break their lines differently.
//                   Flagged boxes are in the review list as always; a box
//                   whose lines moved and that still fits is listed there too
//                   (`relaidNote`), for as long as the notice stands, so the
//                   list the app already has is how they are stepped through.
//   nothing is      until the user edits the chapter or keeps the changes
//   written         (`keepFirstFit`). Opening does not mark the document
//                   unsaved, a font arriving afterwards does not either
//                   (`relayoutAll`), and leaving the chapter untouched writes
//                   nothing (`flushSave`). Turning the switch off again puts
//                   every box back as it was noted (`endFirstFit`). The first
//                   save that does run - any edit's - carries the grown
//                   heights and the flags with it, and stamps the file 2
//                   once every box has been fitted (`stampTypesetting`).
//
// For that, every box is noted as it stood before the engine fitted it: at a
// load, as the file has it; when the switch comes on over an open chapter,
// as the browser left it. Kept beside the document, never in it, and only
// while the Rust engine is switched on: with the browser measuring none of
// this runs, and a chapter opens exactly as it always has.
//
// "Untouched" is decided by looking, not by a flag (`firstFitUntouched`): the
// document is compared with what was noted plus what the engine itself wrote
// (`fitting`, `fitted`). The chapter's saved flag does not see everything
// that changes a document - a handle that is still held down has changed a
// box and marked nothing - and a save skipped on its word, or a box put back
// over the user's hand, is work lost.
//
// THE INVARIANT this block holds while the switch is on, and `settleDisk` is
// the one function that holds it:
//
//   When nothing is in motion - no save in flight, no debounce armed, no box
//   waiting for a font, the engine not starting - exactly one of these is
//   true:
//   (a) the chapter is untouched and unkept, and the file on disk is the
//       file that was opened, byte for byte;
//   (b) the file on disk is the document in memory, and its version is 2 if
//       and only if the Rust engine has fitted every box in it.
//   And while things are in motion, leaving, quitting or the switch going
//   off ends in one of the two.
//
// Nothing about it is remembered from an earlier moment. What the file holds
// is kept (`disk`: the document and the number of the last save that landed,
// or of the open), and whether the file is behind is worked out from that,
// the document and what is waiting, each time something stops moving: a save
// landing, a font landing, the engine starting, Keep, Keep's wait running
// out. A save that lands does not make the chapter saved; the file not being
// behind does. src/lib/first-fit.model.test.js drives every order of those
// events it can draw and reads the file.
//
// How its lines broke before is not in the file. It is asked of the engine
// that measured before the switch (`linesBefore`) for as long as there is
// one: AT CUT-OVER, when the browser's measuring goes, that question has
// nobody to answer it, `relaid` is then never set, and the notice counts
// heights and flags alone.
export const firstFit = $state({
  // The open chapter has boxes noted: it is at version 1 and the Rust engine
  // is, or is about to be, the one fitting it.
  open: false,
  // What the engine changed has reached disk: a save taken while the Rust
  // engine measured has landed (`landed`).
  kept: false,
  // The user has pressed Keep and its write has not landed yet: it waits for
  // the fonts still on their way, for `KEEP_WAIT_MS` at most.
  keeping: false,
  // The user has answered the notice, and what they answered is done.
  dismissed: false,
  // Raised when something kept beside a box changes - its lines found to
  // have moved, a fit of the engine's, an edit of the user's - since that is
  // where no signal sees it.
  seen: 0,
});
// box -> its note (`noteBox`); and the pages in their order, each as
// everything of it but its boxes.
let noted = new WeakMap();
let notedPages = [];
let notedTypesetting = null;
let notedMode = null;
// `firstFit.seen` is written from inside fits, and a fit can run inside an
// effect: counted here, so that raising it reads no signal.
let seenCount = 0;
const sawFirstFit = () => {
  firstFit.seen = ++seenCount;
};
// `app.saved` is false because a load has just swapped the document in
// (`loadProjectPages`), and for no other reason: lowered by the next thing
// that says whether the document is saved.
let loaderDirty = false;
// What a save took as the saver took its snapshot, until it lands or fails
// (`stampTypesetting`): the number it wrote, the document it wrote under
// either engine, and whether the Rust engine was measuring. Browser snapshots
// are recorded too: turning Rust on during one must not call newer memory disk.
let stamping = null;
// What the file holds with a chapter loaded: the document
// (`docText`) and the number of the last save that landed, or of the open;
// and whether it is still the file that was opened. `owned` settles save debt
// acquired by Rust, including a pending snapshot across an off/on transition.
// A fresh browser chapter records its snapshot without acquiring that policy.
let disk = null;
let documentTurn = 0;
// Final outgoing writes can overlap. A matching browser handoff retires
// ownership only after every final that acquired this Rust debt has settled.
const finalSettlements = new Set();
const finalOwnsDocument = () => [...finalSettlements].some((t) => t.owned && t.turn === documentTurn && t.ref === app.chapterRef);
// Keep's wait: how long it lasts, its timer, whether it has run out, and the
// promise `keepFirstFit` handed back.
export const KEEP_WAIT_MS = 4000;
let keepT = null;
let keepOver = false;
let keepAnswer = null;
function endKeep(error = null) {
  clearTimeout(keepT);
  keepT = null;
  keepOver = false;
  const answer = keepAnswer;
  keepAnswer = null;
  if (firstFit.keeping) firstFit.keeping = false;
  if (error) answer?.reject(error);
  else answer?.resolve();
}

function resetFirstFit() {
  endKeep();
  firstFit.open = false;
  firstFit.kept = false;
  firstFit.dismissed = false;
  noted = new WeakMap();
  notedPages = [];
  notedTypesetting = null;
  notedMode = null;
}

// Whether the Rust engine is the one measuring: the switch is on and its
// engine is installed (it is not while it starts, nor with no font to read).
const rustMeasuring = () => !!fontSource?.measuring?.();

// ---- what a fit may write of a box, and everything else of it ----
// A box is noted in two halves. `own` is what the open is allowed to write:
// for a box that was laid out before, its top, its height, its flag and its
// solve's stamp (the grow-only pass, `growAndReview`); for a box stored as
// 'pending', which was never laid out and is the one kind an open lays out
// under either engine (`solvePending`), its whole rectangle, its size and its
// solver record as well. `rest` is everything else of the box, as a save
// would write it. Strings, so that comparing a box with its note is one
// comparison whatever the box holds.
const fitOwn = (b, pending) =>
  JSON.stringify(
    pending ? [b.x, b.y, b.w, b.h, b.style?.size ?? null, b.review ?? null, b.auto ?? null] : [b.y, b.h, b.review ?? null, b.auto?.stamp ?? null],
  );
function fitRest(b, pending) {
  const { y, h, review, auto, ...rest } = b;
  if (!pending) return JSON.stringify([rest, auto ? { ...auto, stamp: null } : null]);
  const { x, w, style, ...other } = rest;
  return JSON.stringify([other, style ? { ...style, size: null } : null]);
}
// A page less its boxes' contents, as a save would write it: its pictures'
// names, its space, its lines, what was detected on it, and which boxes it
// holds in which order.
const pageRest = (p) =>
  JSON.stringify([p.id, p.file ?? null, p.cleanedFile ?? null, p.w, p.h, !!p.needsRespace, p.lines ?? null, p.detect ?? null, p.boxes.map((b) => b.id)]);

function noteBox(b, p, lines) {
  const pending = b.auto?.status === 'pending';
  const own = fitOwn(b, pending);
  return {
    pending,
    rest: fitRest(b, pending),
    // As the engine last left it, which is as it was noted until it has run.
    own,
    // As it was noted, to count against and to put back.
    was: own,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    size: b.style?.size ?? null,
    review: b.review ? $state.snapshot(b.review) : null,
    auto: pending ? $state.snapshot(b.auto) : null,
    stamp: b.auto?.stamp ?? null,
    flagged: !!(b.review ?? solverReview(b, p)),
    lines: lines?.get(b) ?? null,
    relaid: false,
    // An edit's own fit has had the box since (`noteEdited`).
    edited: false,
  };
}

function beginFirstFit() {
  resetFirstFit();
  // The file, as far as this session knows it: the document that has just
  // been read from it (or that the browser has open, when the switch comes
  // on over a chapter), before the engine fits anything.
  const opened = !disk;
  disk ??= { doc: docText(), version: app.typesetting.version, mode: app.chapterMode, asOpened: true, owned: false };
  if (!fontSource) return;
  // Engine turns own save debt, not a fresh disk snapshot. A browser write
  // still in flight (or an unsaved browser edit) is already behind this memory.
  disk.owned = true;
  for (const t of finalSettlements) if (t.turn === documentTurn && t.ref === app.chapterRef) t.owned = true;
  disk.asOpened = opened || (!stamping && (app.saved || loaderDirty) && disk.doc === docText() && disk.version === app.typesetting.version);
  noted = new WeakMap();
  notedTypesetting = JSON.stringify({ ...app.typesetting, version: 0 });
  notedMode = app.chapterMode;
  const first = app.typesetting.version < LAYOUT_VERSION_RUST;
  const lines = first ? linesBefore() : null;
  notedPages = app.pages.map((p) => {
    for (const b of p.boxes) noted.set(b, noteBox(b, p, lines));
    return pageRest(p);
  });
  firstFit.open = first;
}

// Every box's lines as the engine that measured before the switch breaks
// them: the browser, for as long as the app has one. Null when there is no
// such engine to ask. A box it cannot answer for - text on a curve, a face
// the browser has not loaded, a breaker this environment lacks - is left out,
// and is then a box whose lines are not known to have moved.
//
// Asked with that engine installed and the font source out, which is the
// state a browser session is in, so a name resolves as it does there. Both
// are put back before anything else runs: nothing renders and nothing is
// fitted in between, and the layouts kept from either engine are dropped on
// the way in and on the way out (`setTextEngine`, measure.js).
function linesBefore() {
  const engine = fontSource?.before?.();
  if (!engine || !canMeasure()) return null;
  const source = fontSource;
  const now = textEngine();
  const out = new Map();
  fontSource = null;
  if (now !== engine) setTextEngine(engine);
  try {
    for (const p of app.pages) {
      for (const b of p.boxes) {
        try {
          const text = boxText(b, p);
          if (!b.style || !/\S/.test(String(text ?? ''))) continue;
          if (engine.loading?.() || engine.faceReady?.(faceFor(b.style, b.style.size)) === false) continue;
          const place = placeBlock(boxCandidate(b, text));
          if (!place.isCurve && Array.isArray(place.lines)) out.set(b, place.lines.slice());
        } catch {
          /* not known */
        }
      }
    }
  } finally {
    if (now !== engine) setTextEngine(now);
    fontSource = source;
  }
  return out;
}

// ---- the engine's own writes, told from everybody else's ----
// Whether a noted box is still the engine's: across, in size and in what a
// fit may write it is as the engine last left it, and no edit has fitted it.
// A box the user has dragged taller, moved, resized, re-flagged ("Fit now")
// or edited in any way that runs a fit is theirs from then on.
const stillFitted = (b, was) =>
  !was.edited && (was.pending || (b.x === was.x && b.w === was.w && b.style?.size === was.size)) && fitOwn(b, was.pending) === was.own;
// Around a fit that is not an edit (`growAndReview`, `solvePending`): the
// box's note when what the fit is about to write is the engine's doing, and
// what it wrote, kept as the engine's. A box that was not the engine's when
// the fit began is left as it is noted: it does not become the engine's again
// by being fitted.
function fitting(b) {
  const was = noted.get(b);
  return was && stillFitted(b, was) ? was : null;
}
function fitted(b, was) {
  if (!was) return;
  const own = fitOwn(b, was.pending);
  if (own === was.own) return;
  was.own = own;
  sawFirstFit();
}

// A fit has just placed the box's block: whether its lines are the ones it
// had before. Only said by the Rust engine, of a box it can answer for.
function noteRelaid(b, place) {
  const was = noted.get(b);
  if (!was?.lines || place.isCurve || !Array.isArray(place.lines) || !rustMeasuring()) return;
  const relaid = was.lines.length !== place.lines.length || was.lines.some((line, i) => line !== place.lines[i]);
  if (relaid === was.relaid) return;
  was.relaid = relaid;
  sawFirstFit();
}
// An edit's fit has the box (`autoFitBox`): it is the user's, and nothing the
// notice says is said of it any more.
function noteEdited(b) {
  const was = noted.get(b);
  if (!was || was.edited) return;
  was.edited = true;
  was.relaid = false;
  was.lines = null;
  sawFirstFit();
}

// What `flaggedBoxes` lists beside the flags: a box whose lines the engine
// moved, while the notice stands. The flag's shape, so the queue's list shows
// it as it shows any other; no edge is crossed, so every side reads 0. Never
// written, and not a flag: `box.review` is not touched, `reviewOf` does not
// answer with it, and the note goes with the notice.
//
// Made when first asked for, not as the module loads: the reasons come from a
// module that imports this one back, and are not there yet in every load order.
let relaidFlag = null;
function relaidNote(b) {
  if (!firstFit.open || firstFit.dismissed) return null;
  firstFit.seen;
  if (!noted.get(b)?.relaid) return null;
  relaidFlag ??= Object.freeze({ kind: 'overflow', overflow: Object.freeze({ l: 0, t: 0, r: 0, b: 0 }), reason: REVIEW_REASONS.relaid });
  return relaidFlag;
}

/**
 * What the Rust engine did to the open chapter the first time it fitted it;
 * null when there is nothing to say (the browser measures, the chapter is at
 * version 2, the notice was answered, or the engine is still starting).
 *
 * Counted box by box against the note, and only of a box that is still as
 * the engine left it (`stillFitted`): a box the user has since made taller,
 * moved, re-flagged or edited is theirs, and what stands in it now is not
 * the engine's doing. `laid` is the boxes stored as never laid out that this
 * open laid out, which is the one case where an open sets a width, a size
 * and a place. `first` is the first box to look at: one newly flagged, or one
 * whose lines moved.
 */
export function firstFitChanges(pages = app.pages) {
  if (!firstFit.open || firstFit.dismissed) return null;
  // The engine coming on is not a signal of its own; the relayout it runs is.
  app.fontsVersion;
  firstFit.seen;
  if (!rustMeasuring()) return null;
  let grew = 0;
  let flagged = 0;
  let cleared = 0;
  let relaid = 0;
  let laid = 0;
  let first = null;
  for (const pg of pages ?? []) {
    for (const b of pg?.boxes ?? []) {
      const was = noted.get(b);
      if (!was || !stillFitted(b, was)) continue;
      if (was.pending) {
        if (was.own !== was.was) laid++;
        continue;
      }
      const now = !!(b.review ?? solverReview(b, pg));
      if (b.h > was.h) grew++;
      if (now && !was.flagged) flagged++;
      if (!now && was.flagged) cleared++;
      if (was.relaid) relaid++;
      if (!first && ((now && !was.flagged) || was.relaid)) first = { pageId: pg.id, boxId: b.id };
    }
  }
  return { grew, flagged, cleared, relaid, laid, first, kept: firstFit.kept, keeping: firstFit.keeping };
}

// Whether the open document is what was noted plus what the engine did, and
// nothing else: the file is still the file that was opened (no save has
// landed, none is in flight), nothing has said the chapter is unsaved, the
// user has not asked for it to be kept, and every page and every box compares
// equal to its note - the same pages in the same order, the same boxes in the
// same order, each as noted in everything a fit may not write and as the
// engine last left it in what a fit may.
//
// The comparison is what decides, not the flag. A handle held down has
// changed a box and marked nothing; "Fit now" on a box it cannot improve
// writes a new reason and marks nothing; and whatever else writes the
// document without saying so is seen here the same way. It costs what taking
// a save's snapshot costs, and is asked only where a save or the switch going
// off is about to act on the answer.
//
// Untracked: it reads the whole document, and whoever asks is not to be run
// again for every change to it.
const firstFitUntouched = () => firstFit.open && !firstFit.keeping && untrack(documentAsFitted);
function documentAsFitted() {
  if (!fontSource || !disk?.asOpened || stamping) return false;
  if (!app.saved && !loaderDirty) return false;
  if (notedMode !== app.chapterMode || notedTypesetting !== JSON.stringify({ ...app.typesetting, version: 0 })) return false;
  if (app.pages.length !== notedPages.length) return false;
  for (const [i, p] of app.pages.entries()) {
    if (notedPages[i] !== pageRest(p)) return false;
    for (const b of p.boxes) {
      const was = noted.get(b);
      if (!was || fitOwn(b, was.pending) !== was.own || fitRest(b, was.pending) !== was.rest) return false;
    }
  }
  return true;
}

// The switch going off. An untouched chapter is put back as it was noted, so
// that trying the engine and turning it off again is not an edit; one the
// user has edited or kept stays as it is, since it is on disk that way or
// about to be. The same test as the save's (`flushSave`), so a chapter is
// never both written as the engine left it and put back.
//
// A box that was laid out before gets back what the grow-only pass may write
// of it, and a box stored as 'pending' everything its solve wrote: no box is
// left half the file's and half the engine's.
function endFirstFit() {
  // What the browser's rules will not write by themselves: a chapter whose
  // file is behind, or that the user asked to keep, goes to disk as it
  // stands. Asked before anything is put back or forgotten.
  const owed = !!app.chapterRef && app.loaded && (firstFit.keeping || fileBehind(true));
  if (firstFitUntouched()) {
    for (const p of app.pages) {
      for (const b of p.boxes) {
        const was = noted.get(b);
        if (!was) continue;
        if (was.pending) {
          if (b.x !== was.x) b.x = was.x;
          if (b.w !== was.w) b.w = was.w;
          if (b.style && b.style.size !== was.size) b.style.size = was.size;
          b.auto = JSON.parse(JSON.stringify(was.auto));
        } else if (b.auto && b.auto.stamp !== was.stamp) b.auto.stamp = was.stamp;
        if (b.y !== was.y) b.y = was.y;
        if (b.h !== was.h) b.h = was.h;
        writeReview(b, was.review);
      }
    }
  }
  resetFirstFit();
  // A pending Rust-owned save must survive off/on. If there is no debt and no
  // snapshot in flight, hand this chapter back to the ordinary browser policy.
  if (disk && !owed && !stamping) disk.owned = false;
  if (owed) markUnsaved();
}

/**
 * The notice's answer: what the engine changed is kept. ONE write - the
 * grown heights, the flags, and the file's version - unless a save has
 * already carried it, and the notice goes when that write has landed.
 *
 * The write happens when its wait is over (`settleDisk`): at once when no
 * box is waiting for a font, otherwise when the fonts have landed, so that
 * what is kept is everything the engine has to say and the file can be
 * stamped (`stampTypesetting`). Until then the notice says it is waiting
 * (`firstFit.keeping`). The wait has an end: after `KEEP_WAIT_MS` what there
 * is is written, at the number the file had, and if the font does come later
 * the box it fits and the number follow by themselves.
 *
 * The press marks nothing unsaved while it waits - the ordinary debounce
 * would write before the wait is over - and loses nothing either: leaving,
 * quitting or the switch going off writes a chapter the user asked to keep
 * (`flushSave`, `endFirstFit`).
 *
 * A write that fails brings the notice back with Keep to press again:
 * nothing was kept. The rejection is handed on for the notice to say.
 */
export function keepFirstFit() {
  if (!firstFit.open) return Promise.resolve();
  if (firstFit.kept) {
    firstFit.dismissed = true;
    return Promise.resolve();
  }
  if (!rustMeasuring()) return Promise.resolve();
  if (!firstFit.keeping) {
    firstFit.keeping = true;
    keepOver = false;
    keepT = setTimeout(() => {
      keepOver = true;
      settleDisk();
    }, KEEP_WAIT_MS);
    const answer = {};
    answer.promise = new Promise((resolve, reject) => Object.assign(answer, { resolve, reject }));
    // Handed back for whoever wants to say why it failed; not an unhandled
    // rejection when nobody does.
    answer.promise.catch(() => {});
    keepAnswer = answer;
  }
  const { promise } = keepAnswer;
  settleDisk();
  return promise;
}

// Whether any box of the open chapter is waiting for its font, or for a
// letter's (`faceArriving`): it has not been fitted by the engine yet.
const anyBoxWaiting = () => app.pages.some((p) => p.boxes.some((b) => b.style && boxFaceArriving(b, p)));

// The open document as a save writes it, in one string: the chapter's
// typesetting but for its number, and every page in its order with its
// pictures' names, its space, its lines, what was detected on it and its
// boxes (`writeOpenChapter`, library.svelte.js). Two of these being equal is
// what "the file is the document" means here.
const docText = () =>
  untrack(() =>
    JSON.stringify([
      app.chapterMode,
      { ...app.typesetting, version: 0 },
      app.pages.map((p) => [p.id, p.file ?? null, p.cleanedFile ?? null, p.w, p.h, !!p.needsRespace, p.lines ?? null, p.detect ?? null, p.boxes]),
    ]),
  );

/**
 * The number a save taken now writes: which engine has fitted the boxes
 * going to disk with it. Three cases, not two:
 *
 *   the Rust engine measures   2, when every box of the chapter has been
 *                              fitted by it. While a box still waits for its
 *                              font the file's own number is written: 2 says
 *                              every box in the file is the Rust engine's,
 *                              and the save is not held up for it.
 *   the browser measures       what the chapter had - except that a 2 becomes
 *   (no font source)           a 1 again, since its boxes are the browser's
 *                              now, and the Rust engine is to say what it
 *                              changes the next time it meets them.
 *   neither                    the Rust engine is switched on and still
 *                              starting: every fit is held, so nobody has
 *                              fitted this document since it was read, and
 *                              the number the file had is written.
 */
function versionNow() {
  const had = app.typesetting.version;
  if (rustMeasuring()) return anyBoxWaiting() ? had : LAYOUT_VERSION_RUST;
  return !fontSource && had === LAYOUT_VERSION_RUST ? LAYOUT_VERSION : had;
}

/**
 * The chapter's typesetting as a save writes it, stamped with `versionNow`.
 * Called by the saver in the breath it takes its snapshot of the pages, and
 * by nothing else: this is the one place the number is decided, and the one
 * moment the store learns what a save carries. The open chapter takes the
 * number, the file is known to hold that document, and the first fit counts
 * as kept, when that save lands (`landed`) and not before: a write that
 * fails has stamped nothing.
 */
const typesettingSnapshots = new WeakMap();
export function stampTypesetting() {
  const version = versionNow();
  stamping = { version, doc: docText(), mode: app.chapterMode, byRust: rustMeasuring(), turn: documentTurn, owned: !!fontSource || !!disk?.owned };
  const fields = { ...app.typesetting, version };
  typesettingSnapshots.set(fields, stamping);
  return fields;
}

// Both files of this particular snapshot landed, even if a newer save call
// is queued. The writer passes the exact fields object returned above, so a
// failed/obsolete callback cannot substitute another write's current stamp.
// Every actual BOTH-file receipt advances the disk ledger, including browser
// writes. Queued final callers must see progress independently of the indicator.
export function noteTypesettingSaved(fields) {
  const took = typesettingSnapshots.get(fields);
  typesettingSnapshots.delete(fields);
  if (!took || took.turn !== documentTurn) return;
  landed(took);
}

// The save that took that snapshot has landed (`markSaved`, from the saver).
// The open chapter takes its number, and with a font source the file is now
// known to hold what it took. Then, whoever said the disk is current - a
// save, or the loader that has just read the file - whether it is so is
// looked at (`settleDisk`), not taken on their word.
function landed(took = stamping) {
  if (stamping === took) stamping = null;
  if (took && took.turn === documentTurn) {
    if (app.typesetting.version !== took.version) app.typesetting = { ...app.typesetting, version: took.version };
    disk = { doc: took.doc, version: took.version, mode: took.mode, asOpened: false, owned: !!fontSource || !!disk?.owned || took.owned };
    if (firstFit.open && took.byRust) {
      firstFit.kept = took.doc === docText() && took.version === versionNow();
      if (firstFit.keeping && !keepWaits() && firstFit.kept) {
        firstFit.dismissed = true;
        endKeep();
      }
    }
  } else if (!disk?.owned && app.loaded) {
    // The loader marks the browser document saved without a stamped write.
    // Retain the loaded snapshot for future actual save comparisons.
    disk = { doc: docText(), version: app.typesetting.version, mode: app.chapterMode, asOpened: true, owned: false };
  }
  settleDisk();
}

// Whether the file is behind the document: not (a), and not yet (b).
// `leaving` is for the switch going off, which is not a moment to wait in.
function fileBehind(leaving = false) {
  if ((!fontSource && !disk?.owned) || !disk || !app.loaded || !app.chapterRef) return false;
  // (a): only what was noted and what the engine did, and nobody asked
  // for more. The notes also cover a version2 chapter, whose notice stays
  // off: a grow-only fit there still must not arm a save by itself.
  if (untrack(documentAsFitted) && (!firstFit.keeping || (!leaving && keepWaits()))) return false;
  return (firstFit.keeping && (leaving || !keepWaits())) || disk.doc !== docText() || disk.version !== versionNow() || (disk.mode != null && disk.mode !== app.chapterMode);
}
// Keep's wait: a box is still waiting for its font, and the time is not up.
const keepWaits = () => !keepOver && anyBoxWaiting();

/**
 * Holds the invariant at the head of this block. Called whenever something
 * stops moving - a save lands or the loader says the disk is current
 * (`markSaved`), a font lands or the engine starts (`relayoutAll`), Keep is
 * pressed or its wait runs out - and asks one question of the state as it
 * stands: is the file behind the document? If it is, a save is armed, or for
 * Keep made at once. Nothing is carried over from an earlier answer.
 *
 * A save in flight needs no thought here: when it lands this is asked again,
 * of what it carried.
 */
function settleDisk() {
  if (!fileBehind()) {
    // Once the work crossing Rust's switch-off has landed, ordinary browser
    // autosaves resume their ordinary policy. Actual browser receipts still
    // participate in explicit final convergence and exact saved marking.
    if (!fontSource && disk && !finalOwnsDocument()) disk.owned = false;
    return;
  }
  if (firstFit.kept) firstFit.kept = false;
  if (firstFit.keeping && !keepWaits()) {
    const answer = keepAnswer;
    // Several fonts may land while the same Keep write is held. They all
    // owe the latest document, not one queued write per arrival. When this
    // write ends, settle again if its snapshot is behind.
    if (answer.writing) {
      loaderDirty = false;
      app.saved = false;
      return;
    }
    answer.writing = true;
    markUnsaved();
    flushSave().then(() => {
      if (keepAnswer !== answer) return;
      answer.writing = false;
      settleDisk();
    }, () => {});
  // A waiting Keep owns its deadline. Retrying a failed write has saved=false
  // and no debounce; do not invent an 800ms write before that deadline. An
  // already armed user-edit timer stays armed at its original deadline.
  } else if (!firstFit.keeping && (app.saved || !saveT)) markUnsaved();
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
// strictly necessary costs a measurement pass and changes nothing else. The one
// thing it lays out afresh is a box that was never laid out: placed while its
// face was loading, and solved once that face is in (`solvePending`).
//
// `fonts.js` calls this after it registers a face, and `App.svelte` calls it
// once `document.fonts.ready` resolves at boot, which covers the built-in faces
// and any face the browser was still fetching.
export function noteFontsChanged() {
  return relayoutAll();
}
// The same re-measure, for anything else that changes how every line lays out
// without touching any box - the chapter's breaker switched wholesale
// (`setChapterTypesetMode`), or the text engine. Bumping `fontsVersion` is what wakes the
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
  for (const p of app.pages) n += landPage(p).n;
  if (fitsAwaited > 0 && !app.pages.some((p) => p.boxes.some((b) => fitsAwaitingFace.has(b)))) fitsAwaited = 0;
  // Only when something moved: the geometry is in the document, so it has to
  // reach disk, and an unsaved flag raised by a font that changed no box would
  // be a write nobody asked for.
  //
  // With the Rust engine switched on (a font source) that is not the
  // question. A height the grow-only pass grew is not written for its own
  // sake: the engine coming on, a system family's bytes arriving a moment
  // after a chapter opened, a letter's font being found - none is the user's
  // doing, and each would otherwise put the file on disk 800ms after a
  // chapter was merely opened. Whether anything is to be written is whether
  // the file is behind the document (`settleDisk`): it is not for a chapter
  // nobody has touched, and it is when an edit's own fit has just landed,
  // when a save went out before this font came, or when the user asked for
  // the chapter to be kept and this was what it waited for.
  if (fontSource) settleDisk();
  else if (n) markUnsaved();
  return n;
}

// One page, after a font landed: the fits that were held for it, the solves
// that were pending, and the grow-only refit of everything else. `open` is
// false for a page that is no longer in the document (`fontsSettling`): it has
// no history, and a page of the chapter that is open now may carry its id.
//
// Answers how many boxes moved (`n`), and how many of those were laid out or
// fitted for an edit rather than grown by the grow-only pass (`edited`).
function landPage(p, open = true) {
  // Counted so a session with nothing waiting never walks the boxes for it.
  const landing = fitsAwaited > 0 ? heldFitsLanding(p) : null;
  let edited = solvePending(p);
  if (landing) edited += fitLanding(p, landing);
  const n = edited + refitPage(p);
  // Last, with the box as all three left it: the edit that asked for the fit
  // was recorded before the fit could run, and its undo entry is owed this.
  if (landing && open) for (const { b, was } of landing) fitLanders.notify(p.id, b.id, was, fitGeom(b));
  return { n, edited };
}

// Every box on a page placed while its face was loading, solved now that the
// face is in (DET-4). Placement will not solve against the fallback family -
// a size solved for a font nobody sees - so such a box is placed by the old
// rules and marked 'pending' (`bornBox`). Left to the grow-only refit above, its
// height then followed the real face's lines with nothing to hold it to its
// balloon: 323 px tall in a balloon of 180.
//
// Only 'pending' boxes, never one with a solve behind it: a font arriving must
// not change the size, width or position of anything already laid out, and a
// box with no status was placed without text and belongs to the ladder. And
// only a pending box still as it was placed (its stamp, `solveStamp`): one the
// user has since typed into, moved, resized, rotated or restyled - by any path -
// is theirs, and a solve would throw that away; one they have drawn ink on,
// masked, curved or sized by hand is manual. Either is settled to no status, for
// the ladder, and so is one the solver has nothing to lay out. A face still
// loading leaves its boxes pending for the next arrival.
//
// Run wherever pending boxes can meet a loaded face: a font arriving
// (`relayoutAll`), a chapter opening whose faces are already in
// (`loadProjectPages`), and an undo or redo putting a box back
// (history.svelte.js). Synchronous, so no chapter can open between the check
// and the write. `boxes` narrows it to the boxes a caller has just put back.
export function solvePending(p, boxes = p?.boxes) {
  if (!p || !canMeasure()) return 0;
  let n = 0;
  for (const b of boxes ?? []) {
    if (b.auto?.status !== 'pending') continue;
    // The one layout an open may run, under either engine: what it writes is
    // the engine's doing too, when the box is still as it was noted.
    const was = fitting(b);
    if (solveOnePending(b, p)) n++;
    fitted(b, was);
  }
  return n;
}
function solveOnePending(b, p) {
  const a = b.auto;
  const text = boxText(b, p);
  if (!a.on || !isAutoBox(b) || !/\S/.test(text) || !solveStands(b, text)) {
    a.status = null;
    return false;
  }
  if (!faceReady(b.style, text)) return false;
  if (solveBox(b, p, text, { x: b.x + b.w / 2, y: b.y + b.h / 2 })) return true;
  a.status = null;
  return false;
}

// ---------- the chapter's typesetting (DET-3) ----------
// The line breaker is the document's, not the machine's: `typesetEnabled()`
// in measure.js is the gate every layout reads, and these are the only writers
// of it in the app. The library calls `useChapterTypesetting` with the record's
// field before the pages load - their refit already measures under it - and
// with nothing when the chapter closes.
export function useChapterTypesetting(raw) {
  documentTurn++;
  stamping = null;
  disk = null;
  app.typesetting = normalizeTypesetting(raw);
  setTypesetEnabled(app.typesetting.mode === 'smart');
  // Another chapter, or none: what was noted of the last one goes with it.
  resetFirstFit();
}

// The open chapter's breaker switched wholesale, saved with it, and every box
// re-measured under the new breaker the way a font arriving re-measures them.
// The app has no control for it any more - the line breaking is each box's,
// and a chapter opens 'smart' (`openTypesetting` in data.js) - so its callers
// are the tests and the audit script that drive the breaker directly.
export function setChapterTypesetMode(mode) {
  if (!app.chapterRef) return;
  const next = normalizeTypesetting({ ...app.typesetting, mode });
  if (next.mode === app.typesetting.mode) return;
  // Settings changes this document, not its identity. Preserve an older save's
  // snapshot/ownership while dropping the old breaker's first-fit notice.
  app.typesetting = next;
  setTypesetEnabled(next.mode === 'smart');
  resetFirstFit();
  relayoutAll();
  markUnsaved();
}

// Deep copy of a style object, normalised up to the current schema (nested
// gradient/pattern/roughen groups and the strokes/shadows lists included), safe
// for reactive proxies.
export function cloneStyle(s) {
  return normalizeStyle($state.snapshot(s));
}

// Mirrored by prefs.svelte.js, which imports the store and cannot be imported back.
let inheritBoxStyle = true;
export function setInheritBoxStyle(enabled) {
  inheritBoxStyle = !!enabled;
}

// ---------- font size per tag ----------
// The size a new box is born at follows the box before it that carries the
// SAME primary tag, not the last box touched: an `sfx` box sized up to 60 must
// not drag the next dialogue box up with it, and the dialogue size must not
// pull the next `sfx` back down. Everything else about the style still follows
// `lastStyle`. The group is the line's first tag - the same one `styleForLine`
// lets win - and an untagged line is its own group, keyed by the empty string.
//
// "Before it" is reading order: the nearest earlier line of the group that has
// a box, on this page or the pages before (`previousGroupBox`). Not the group's
// last EDITED box: going back to fix an older `sfx` box and then placing the
// next one used to hand the new box the older box's size - the one before the
// one before it - rather than its neighbour's.
//
// A group with no box before the new one falls back to its size memory, kept
// beside the tag registry in project.json for the same reason the registry is
// kept there: "sfx is about 60 here" is a fact about this series, not about
// the person or about any one chapter - see `bindTags`. Then to the tag's own
// default size (set in its form), then to the default style's. Never to the
// size of another group.
//
// What is followed and remembered is a REFERENCE size (FIT-1): the size the
// user chose for this kind of text, which the solver starts from and never
// exceeds - not the size a balloon made it shrink to, which fed back in would
// ratchet every later box smaller. So the memory is written on a deliberate
// size change and on nothing else. It used to be written on every `selectBox`
// too, which made it "the last size clicked": one click on a big SFX box set
// every later SFX box.
export const sizeKeyFor = (line) => (line ? lineTags(line)[0] ?? '' : '');

// The size the user chose for a box: its solver record's `refSize`, or - for a
// box the solver does not manage - the size it is set at, which nothing but the
// user changes.
export const refSizeOf = (b) => (b?.auto?.on && b.auto.refSize > 0 ? b.auto.refSize : b?.style?.size);

// A deliberate size change: the box's reference size, and its group's memory.
// A legacy free box (`lineN == null`) has no line and lands in the untagged group.
//
// And the size is LOCKED on a box the solver manages: a size the user set is
// not one the solver may take back. Text it cannot hold at that size is flagged
// rather than shrunk out from under the edit - quietly shrinking a size the user
// has just typed would be the fit arguing with them. The Refit button respects
// the lock too; only an undo of the edit gives the box its freedom back.
export function rememberSizeFor(p, box) {
  if (!box?.style || typeof box.style.size !== 'number' || !Number.isFinite(box.style.size)) return;
  if (box.auto) {
    box.auto.refSize = box.style.size;
    box.auto.locks.size = true;
  }
  seeSize(box);
  const line = box.lineN != null && p ? lineByN(p, box.lineN) : null;
  rememberTagSize(sizeKeyFor(line), box.style.size);
}

// Telling the user's size from the program's. Every deliberate size change -
// the Inspector's field, a preset, a corner drag - lands on the SELECTED box
// and is followed by an `autoFitBox` or a `rememberStyle`, and neither of those
// is told why it runs. So the selected box's size is marked when it is selected
// and again after every fit writes it (`writeFit`); a size that differs from
// the mark at the next fit or remember was written by neither, and is the
// user's. One mark, not one per box: a size is only ever edited on the box in
// front of the user, and the bulk editor, which edits many, says so itself
// (`rememberSizeFor`).
//
// Anything else that writes a size has to move the mark with it, or the next
// edit of the box reads the write as the user's: a solve (`solveBox`), a
// rescale, and an undo or redo, which puts back a size that was the user's or
// the program's once and is neither now - so the history re-marks the selected
// box after every step (`markSelectedSize`), including the steps that do not
// select anything, like a bulk apply's.
let sizeMark = { id: null, size: null };
function markSize(b) {
  sizeMark = { id: b.id, size: b.style?.size };
}
function seeSize(b) {
  if (sizeMark.id === b.id) sizeMark.size = b.style.size;
}
export function markSelectedSize() {
  const b = app.selectedId ? byId(app.selectedId) : null;
  if (b?.style) markSize(b);
}
function noteSizeEdit(b, p) {
  if (sizeMark.id !== b.id || b.style.size === sizeMark.size) return;
  rememberSizeFor(p, b);
  if (app.lastStyle) app.lastStyle.size = b.style.size;
}

// Remember the active box's style so the next placed box inherits it - all of
// it but the size, which follows only a deliberate size change (see above).
export function rememberStyle(box) {
  const b = box ?? (app.selectedId ? byId(app.selectedId) : null);
  if (!b?.style) return;
  noteSizeEdit(b, page());
  const size = app.lastStyle?.size;
  app.lastStyle = cloneStyle(b.style);
  if (size > 0) app.lastStyle.size = size;
}

// The box of `ln`'s group nearest before `ln` in reading order: the highest
// earlier line on `p`, else the last line of the group on the nearest page
// before it. Null when the group has no box before `ln`.
function previousGroupBox(p, ln) {
  const key = sizeKeyFor(ln);
  const lastOf = (pg, below) => {
    let best = null;
    let bestN = -Infinity;
    for (const b of pg.boxes ?? []) {
      if (b.lineN == null || !(b.lineN < below) || b.lineN < bestN) continue;
      if (sizeKeyFor(lineByN(pg, b.lineN)) !== key) continue;
      best = b;
      bestN = b.lineN;
    }
    return best;
  };
  const here = lastOf(p, ln.n);
  if (here) return here;
  for (let i = app.pages.indexOf(p) - 1; i >= 0; i--) {
    const b = lastOf(app.pages[i], Infinity);
    if (b) return b;
  }
  return null;
}

// The size a box of `ln`'s group is born at - see above.
function groupSizeFor(p, ln) {
  const key = sizeKeyFor(ln);
  // With inheritance off, use the tag's configured default, not sizes learned
  // from boxes in this chapter or remembered from earlier chapters.
  if (!inheritBoxStyle) return findTag(key)?.size ?? defaultStyle().size;
  const prev = p && ln ? refSizeOf(previousGroupBox(p, ln)) : null;
  if (prev > 0) return prev;
  return tagSize(key) ?? findTag(key)?.size ?? defaultStyle().size;
}

// The style a box is born with: the remembered style (when enabled) or app
// defaults under the line's tag defaults,
// with the size its group gives it (`groupSizeFor`). A reference size (see
// above), which placement solves down from.
export function inheritedStyleFor(ln, p = page()) {
  const base = inheritBoxStyle ? cloneStyle(app.lastStyle) : defaultStyle();
  const style = styleForLine(ln, applyBoxDefaults(base));
  style.size = groupSizeFor(p, ln);
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
// A save that failed has stamped nothing (`stampTypesetting`), and a Keep
// that was waiting on it has kept nothing: the notice offers it again.
const saveFailed = (e, ref, turn) => {
  // A delayed outgoing failure belongs only to that exact document cycle.
  // The caller still receives the original error after another chapter loads.
  if (app.chapterRef !== ref || documentTurn !== turn) return e;
  stamping = null;
  app.saveFailed = true;
  if (firstFit.keeping) endKeep(e);
  return e;
};
export function markUnsaved() {
  loaderDirty = false;
  app.saved = false;
  if (!savers.size() || !app.chapterRef) return;
  clearTimeout(saveT);
  saveT = null;
  // There is no manual save in this app, so a rejected autosave is the user's
  // only signal that their work is not reaching the disk. Never swallow it.
  saveT = setTimeout(() => {
    saveT = null;
    const ref = app.chapterRef, turn = documentTurn;
    runSavers().catch((e) => {
      // A toast lasts two seconds; the work being off-disk lasts until a write
      // lands. The indicator carries the second half of that, so the user can
      // still find out why an hour later.
      saveFailed(e, ref, turn);
      const previous = app.chapterRef !== ref || documentTurn !== turn;
      toastError(`Could not save${previous ? ' the previous chapter' : ''}: ${e?.message ?? e}`);
    });
  }, DOC_SAVE_MS);
}
export function markSaved({ written = false } = {}) {
  // A writer has already supplied its exact BOTH-file snapshot. Never cancel
  // a newer edit's timer or manufacture a receipt from current live pages.
  if (written && !chapterSaveCurrent()) {
    // A raw gesture can change pages after the prior debounce has fired.
    // Preserve any newer timer; otherwise arm the actual remaining intent.
    if (!saveT && !chapterBytesCurrent()) markUnsaved();
    return;
  }
  // The debounce goes with the flag, and it has to: `markSaved` means "the disk
  // is current", and a timer left armed against work that has already landed
  // writes the whole document a second time 800ms later. On the way out of a
  // chapter that second write is not merely redundant - `openChapter` has by
  // then pointed `app.chapterRef` somewhere else, and the pages the stale timer
  // hands the saver are the ones it was told about when it was armed. Cancelled
  // here rather than by each caller, because this is the one function every
  // "already written" path already calls.
  clearTimeout(saveT);
  saveT = null;
  loaderDirty = false;
  app.saved = true;
  // The write that was stamped is on disk: the open chapter takes its number.
  // And with the Rust engine switched on, "saved" is not this caller's to
  // say: a document that changed after the save's snapshot was taken - an
  // edit, a font landing, the engine starting - is unsaved again at once
  // (`landed`, `settleDisk`).
  if (!written) landed();
}

// Navigation captures the cycle as well as the ref: a reload can reuse a ref.
export const chapterSaveCycle = () => documentTurn;
// A final caller may approve an explicit discard as well as a durable save.
// Capture exactly the approved document; a later edit/load needs its own reply.
export function chapterSaveApproval() {
  const ref = app.chapterRef, turn = documentTurn, source = fontSource;
  const doc = docText(), version = versionNow(), mode = app.chapterMode;
  return () => app.chapterRef === ref && documentTurn === turn && fontSource === source && docText() === doc &&
    versionNow() === version && app.chapterMode === mode;
}
const chapterBytesCurrent = () => !!disk && disk.doc === docText() && disk.version === versionNow() && disk.mode === app.chapterMode;
export function chapterSaveCurrent() {
  if (!savers.size() || !app.chapterRef || !app.loaded || firstFitUntouched()) return true;
  return !fontSource?.starting && chapterBytesCurrent();
}

export function flushSave({ settle = false } = {}) {
  clearTimeout(saveT);
  saveT = null;
  // A chapter the Rust engine fitted for the first time, which the user has
  // neither edited nor kept: there is nothing of theirs to write, and what
  // the engine grew and flagged is not written by leaving (`firstFit`).
  // Decided by comparing the document with what was noted, so that a change
  // nobody marked - a handle still held down - is written like any other.
  if (firstFitUntouched()) return Promise.resolve();
  // Every non-debounce save comes through here - leaving the editor, quitting,
  // opening another chapter - and this is the path most likely to be the one
  // that fails, because it is the one that runs when the user is on their way
  // out. It also cancels the debounce, so a rejection here leaves nothing
  // scheduled to raise the indicator later: without this catch the pill would
  // sit on its neutral dot promising a save that no longer exists. The error is
  // rethrown untouched - flushBeforeLeaving still decides whether the user may
  // go, and says why.
  const ref = app.chapterRef;
  const owned = !!fontSource || !!disk?.owned;
  const turn = documentTurn;
  const ticket = settle && savers.size() && ref ? { ref, turn, owned } : null;
  if (ticket) finalSettlements.add(ticket);
  return savers.size() && ref
    ? runSavers().then(async () => {
        if (settle && app.chapterRef === ref && documentTurn === turn) {
          const startup = fontSource?.starting?.();
          if (startup) await startup;
        }
        // Every engine must finish changes discovered while its final snapshot
        // was held. The exact outgoing ref and load cycle are covered. A font
        // still absent is not waited for: compare the document/version that
        // actually exists now, rather than Keep's remaining wait or future fit.
        while (
          settle && app.chapterRef === ref && documentTurn === turn && app.loaded &&
          disk &&
          !chapterSaveCurrent()
        ) {
          const startup = fontSource?.starting?.();
          if (startup) await startup;
          if (app.chapterRef !== ref || documentTurn !== turn || chapterSaveCurrent()) break;
          clearTimeout(saveT);
          saveT = null;
          await runSavers();
        }
      }).catch((e) => {
        throw saveFailed(e, ref, turn);
      }).finally(() => {
        if (!ticket) return;
        finalSettlements.delete(ticket);
        if (app.chapterRef === ref && documentTurn === turn) settleDisk();
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
  // The queue's line burst is a panel's pending entry too, kept here since the
  // store writes it (`setLineText`).
  settleLine();
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
  // And the queue's line burst, for the same reason.
  linePending = null;
  clearTimeout(lineT);
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
// `app.toast` is always the last thing said, whatever its kind, so a reader
// asking "what did the app just tell the user" has one place to look. Only an
// info toast is drawn from it; an error is drawn from `app.errors`.
export function toast(msg, kind = 'info') {
  app.toast = { msg, seq: app.toast.seq + 1, kind };
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    app.toast = { msg: '', seq: app.toast.seq + 1, kind: 'info' };
  }, 2200);
}

// An error that stays until it is closed. The same message raised again - an
// autosave failing on every keystroke - is one card that moves to the front
// and counts, not a wall of copies. Capped: past that many, the oldest goes.
const ERRORS_MAX = 4;
let errorSeq = 0;
export function toastError(msg) {
  toast(msg, 'error');
  const text = String(msg);
  const same = app.errors.find((e) => e.msg === text);
  const rest = app.errors.filter((e) => e !== same);
  const entry = same ? { ...same, count: same.count + 1 } : { id: ++errorSeq, msg: text, count: 1 };
  app.errors = [...rest, entry].slice(-ERRORS_MAX);
}

export function dismissError(id) {
  app.errors = app.errors.filter((e) => e.id !== id);
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
// last put their hands on, rotation included - all but the size, which follows
// only a deliberate size change (FIT-1, see `rememberStyle`). Without this the only
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
  // Looking at a box is not choosing its size (FIT-1): the mark only lets a
  // later edit of it be told apart from what the fit wrote.
  if (b?.style) markSize(b);
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
    // roughening comes back as a different grain on a rescaled page. `grit`
    // is a displacement too.
    out.roughen = {
      ...st.roughen,
      amount: len(st.roughen.amount),
      ...(Number.isFinite(st.roughen.grit) ? { grit: len(st.roughen.grit) } : {}),
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
// still an axis-aligned ellipse, and bands of rows are still bands of rows, so
// this is exact for every kind.
export const scaleFit = (f, sx, sy) => {
  if (!f) return f;
  if (f.kind === 'ellipse') {
    return { kind: 'ellipse', cx: f.cx * sx, cy: f.cy * sy, rx: f.rx * sx, ry: f.ry * sy };
  }
  if (f.kind === 'rect') {
    return { kind: 'rect', x: f.x * sx, y: f.y * sy, w: f.w * sx, h: f.h * sy };
  }
  if (f.kind === 'rows') {
    const spans = f.spans.map((sp) => sp && [sp[0] * sx, sp[1] * sx]);
    return { kind: 'rows', y0: f.y0 * sy, step: f.step * sy, spans };
  }
  if (f.kind === 'poly') return { kind: 'poly', pts: f.pts.map(([x, y]) => [x * sx, y * sy]) };
  return null;
};

// The same fit carried by (dx, dy), for a box the user moves (`moveBoxTo`).
// A new object every time, so a fit shared with the gesture's starting copy -
// or with anything else - is never moved under it.
export const translateFit = (f, dx, dy) => {
  if (!f) return f;
  if (f.kind === 'ellipse') return { kind: 'ellipse', cx: f.cx + dx, cy: f.cy + dy, rx: f.rx, ry: f.ry };
  if (f.kind === 'rect') return { kind: 'rect', x: f.x + dx, y: f.y + dy, w: f.w, h: f.h };
  if (f.kind === 'rows') {
    const spans = f.spans.map((sp) => sp && [sp[0] + dx, sp[1] + dx]);
    return { kind: 'rows', y0: f.y0 + dy, step: f.step, spans };
  }
  if (f.kind === 'poly') return { kind: 'poly', pts: f.pts.map(([x, y]) => [x + dx, y + dy]) };
  return null;
};

// The solver's record in the new space: its sizes are lengths, like the
// style's own. The stamp is the caller's to renew - it is a fingerprint of the
// whole box.
export function rescaleAuto(a, sx, sy) {
  if (!a || typeof a !== 'object') return a;
  const s = lengthScale(sx, sy);
  if (!Number.isFinite(s) || s <= 0 || s === 1) return a;
  const out = { ...a };
  if (Number.isFinite(a.refSize)) out.refSize = a.refSize * s;
  if (Number.isFinite(a.minSize)) out.minSize = a.minSize * s;
  return out;
}

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
    // Whether the last solve still describes the box, asked before anything
    // moves: afterwards it is the same solve in the new space. Never asked of a
    // recorded box on a stand-in page with no lines (history-file.svelte.js),
    // whose text may live on a line it does not have: its stamp stays as
    // recorded, like every other recorded stamp.
    const text = b.auto?.stamp && Array.isArray(p.lines) ? boxText(b, p) : null;
    const stood = text != null && solveStands(b, text);
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
    // And the size the user chose, which is a size like the style's: left
    // behind, the next solve at 2x would shrink every box to the old reference.
    // A new object, for the reason `rescaleStyle` returns one.
    if (b.auto) {
      b.auto = rescaleAuto(b.auto, sx, sy);
      if (stood) b.auto.stamp = solveStamp(b, text);
    }
    seeSize(b);
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
// Flush text still gets the inscribed rectangle, where its block reads centred
// in the balloon rather than hugging one side of it. Its lines follow the
// balloon's rows too (`balloonWidthsFor`), each set in to its row's edge
// (`lineIndents`) - which inside that rectangle is the box's own edge, and past
// it, once auto height has grown the box, the curve.
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
  return measureBalloon(p, block, pixels)?.fit ?? null;
}

// A fit worth keeping has room in it: a balloon so small that the safety inset
// eats it whole leaves no rectangle to put text in. `interiorLineWidths` would
// answer its own floor of one pixel for every line, which no line breaker can
// do anything sensible with.
function hasRoom(shape) {
  const room = shape && inscribedRect(shape);
  return !!room && room.w > 0 && room.h > 0;
}

// The outline finder's answer as a measurement: the `poly` fit and its record.
// Null when the finder found no closed outline, or one with no room in it.
function outlineMeasure(found) {
  if (!found || found.open || !Array.isArray(found.pts)) return null;
  const fit = normalizeFit({ kind: 'poly', pts: found.pts });
  if (!fit || !hasRoom(fit)) return null;
  return { fit, outline: { source: found.source, confidence: found.confidence, approved: null } };
}

// The old fill-and-fit's answer as a measurement, for a bubble the outline
// finder could not close: its shape, with the fit's own confidence.
function fillMeasure(res) {
  if (!res || !res.shape || res.escaped) return null;
  if (!(res.confidence >= MIN_FIT_CONFIDENCE)) return null;
  const fit = normalizeFit(res.shape);
  if (!fit || !hasRoom(fit)) return null;
  return { fit, outline: { source: 'fill', confidence: res.confidence, approved: null } };
}

// The record of a box measured and found in no closed bubble: no fit, and an
// outline that says so, so the check list can ask for one (01-bubble-check.md).
export const OPEN_OUTLINE = Object.freeze({ source: 'box', confidence: 0, approved: null, open: true });
const openMeasure = () => ({ fit: null, outline: { ...OPEN_OUTLINE } });

// The first of two measurements that found a bubble; else the first that was
// measured at all, so "looked and found nothing" is not lost to "could not
// look". `second` is a thunk: it is not measured when the first one answers.
function firstFound(first, second) {
  if (first?.fit) return first;
  const next = second();
  if (next?.fit) return next;
  return first ?? next ?? null;
}

// The bubble around a block, measured: `{ fit, outline }`, or null when the
// page's pixels are not in hand or the block is not a block. The outline
// finder's ladder first (`findOutline` in bubble-outline.js: caption, ring,
// flood, dark bubble); then the old fill-and-fit, which still answers some
// bubbles the ladder's solidity gate refuses, with a stored outline record
// that says so; then no fit and an open outline.
//
// The page's other detected blocks go along as neighbours: a bubble joined to
// the next one is split between their texts (Bubble B). `scale` maps page
// coordinates into the pixels, for a caller holding the raster at another
// size (`measureBlock`, whose block is already in pixel space).
export function measureBalloon(p, block, pixels, scale = null) {
  if (!Array.isArray(block) || block.length !== 4) return null;
  const image = pixels ?? pagePixelsFor(p);
  if (!image) return null;
  const neighbors = neighbourBlocks(p, block, image, scale);
  const m = outlineMeasure(findOutline(image, block, { neighbors })) ?? fillMeasure(detectBalloon(image, block));
  return m ? withInk(m, image) : openMeasure();
}

// The measurement with the text colour its bubble calls for written on its
// outline record (LET-3), read off the same pixels the outline came from.
function withInk(m, image) {
  const ink = contrastInk(image, m.fit);
  if (ink) m.outline.ink = ink;
  return m;
}

// The other detected blocks near this one, in the pixels' space. Only those
// whose centre is inside the finder's widest window: the finder grows its
// window to hold every neighbour it is given (Komatose passes the whole page),
// and a block across the page cannot share a bubble with this one anyway.
//
// A block that overlaps this one's centre, or whose centre this one covers, is
// not a neighbour: it is this text measured another way - the line's own
// detected block, asked about again through a refit's stored rectangle or a
// click on the text - and splitting the bubble between the two would cut the
// one bubble in half.
function neighbourBlocks(p, block, image, scale) {
  const sx = scale?.sx ?? 1;
  const sy = scale?.sy ?? 1;
  const [x1, y1, x2, y2] = block;
  const reach = Math.min(
    Math.max(400, 0.25 * Math.min(image.width, image.height)),
    2.6 * Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 48),
  );
  const out = [];
  for (const d of p?.detect?.boxes ?? []) {
    if (!Array.isArray(d.box) || d.box.length !== 4) continue;
    const b = [d.box[0] * sx, d.box[1] * sy, d.box[2] * sx, d.box[3] * sy];
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const covers = (r, x, y) =>
      x >= Math.min(r[0], r[2]) && x <= Math.max(r[0], r[2]) && y >= Math.min(r[1], r[3]) && y <= Math.max(r[1], r[3]);
    if (covers(b, mx, my) || covers(block, cx, cy)) continue;
    if (cx < Math.min(x1, x2) - reach || cx > Math.max(x1, x2) + reach) continue;
    if (cy < Math.min(y1, y2) - reach || cy > Math.max(y1, y2) + reach) continue;
    out.push(b);
  }
  return out;
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
  return measureBalloonAt(p, imgX, imgY, pixels)?.fit ?? null;
}

// How far the outline finder looks around a click, as its `minPad`: there is
// no block to scale a window from, so the floor is the window, about the
// half-extent the click fill searches (`pointWindow` in balloon.js).
const CLICK_PAD = 160;

// `balloonFitAt` as a measurement, by `measureBalloon`'s rules. The finder is
// asked first with the click as a two-pixel block; the click must be on a solid
// light colour (`localUniformity`) before either looks, and inside what they
// found after.
export function measureBalloonAt(p, imgX, imgY, pixels, scale = null) {
  if (!Number.isFinite(+imgX) || !Number.isFinite(+imgY)) return null;
  const image = pixels ?? pagePixelsFor(p);
  if (!image) return null;
  const x = +imgX;
  const y = +imgY;
  if (!localUniformity(image, x, y)?.uniform) return openMeasure();
  const block = [x - 1, y - 1, x + 1, y + 1];
  const neighbors = neighbourBlocks(p, block, image, scale);
  const found = outlineMeasure(findOutline(image, block, { minPad: CLICK_PAD, neighbors }));
  if (found && shapeContainsPoint(found.fit, x, y)) return withInk(found, image);
  const filled = fillMeasure(detectBalloonAt(image, x, y));
  if (filled && shapeContainsPoint(filled.fit, x, y)) return withInk(filled, image);
  return openMeasure();
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
  return ontoPage(p, { x: cx - w / 2, y: cy - h / 2, w, h });
}
const ontoPage = (p, r) => {
  const at = (v, size, extent) => (extent > 0 ? clamp(v, 0, Math.max(0, extent - size)) : Math.max(0, v));
  return { x: at(r.x, r.w, p?.w ?? 0), y: at(r.y, r.h, p?.h ?? 0), w: r.w, h: r.h };
};

// Where a box is placed, in order of how much is known about the bubble under
// it:
//
//   the balloon    the page's pixels are in hand and the flood fill recovered
//                  a shape it believes. The text is laid out inside that shape,
//                  and the shape is kept so the line breaker can lay text out
//                  to the curve.
//   the click      no detection, or a detection that missed this bubble - but
//                  the pixels under the pointer are a solid light colour, so
//                  the same flood fill runs from the click itself and the box
//                  is sized from the balloon it finds. This is the paste-mode
//                  case: a translation in the queue, a page nobody analysed,
//                  and a user pointing at the bubble they want it in.
//   the text       no fit either way, so the box is sized from what has to go
//                  in it: the width that makes the text a balanced block rather
//                  than the fixed 220 that made it a column. Centred on the
//                  detector's rectangle when there is one - a location, not a
//                  size (GEO-3) - and on the click when not.
//   the block      ...and with no text to measure, the detector's rectangle,
//                  inset, transposed first when the Japanese in it was set
//                  vertically, since a tall narrow column is the one shape
//                  English does not want. No transpose in the fitted branches
//                  above: the balloon is already the right aspect for the real
//                  bubble, and swapping its sides would be a heuristic
//                  overruling a measurement.
//   the constants  ...and 220x92 when there is not even that - an empty queue
//                  row on a page nobody detected, or an environment with no
//                  metrics.
//
// With text to set, the solver (auto-layout.js) takes it from there: the size,
// the width and the lines together, from the line's reference size down to the
// largest size that fits the balloon (FIT-1), and with no balloon, the width
// whose block reads best (GEO-3). The box is born with its solver record
// (`box.auto`), so the size the user chose outlives the size the balloon
// allowed. Without text, metrics or the face the text is set in, the box is
// placed by the list above and the ladder fits it; its record carries the
// reference size and no status, since nothing was solved - except that a box
// with text that only lacked its face is 'pending', and is solved when the face
// arrives (`solvePending`).
//
// Tag defaults plus the preferences for the five typesetting flags. When style
// inheritance is enabled, size follows the tag group and the rest follows
// `lastStyle`; otherwise, styling and size start from app and tag defaults.
//
// `measured` is a measurement already taken for this line's block
// (`placeDetectedInChapter`): `{ fit, outline }`, with a null fit for one
// measured and found in no bubble. Undefined measures here.
function bornBox(p, ln, imgX, imgY, measured) {
  const style = inheritedStyleFor(ln, p);
  const text = lineText(ln);
  const measurable = /\S/.test(text) && canMeasure();
  const solvable = measurable && faceReady(style, text);
  const det = detectedEntryFor(p, ln.n, imgX, imgY);
  // The block first: a detected rectangle is a measurement of where the Japanese
  // in THIS line sat, so it seeds the fill closer to the right balloon than a
  // click can when the two disagree. The click is the answer when there is no
  // block, which is most of the time in paste mode.
  const m =
    measured !== undefined
      ? measured
      : firstFound(measureBalloon(p, det?.box ?? null), () => measureBalloonAt(p, imgX, imgY));
  let fit = m?.fit ?? null;
  let outline = m?.outline ?? null;
  let g = fit ? fittedRect(p, fit, style.align) : null;
  let at = { x: imgX, y: imgY };
  // The two are dropped together, deliberately: a fit the box was not sized from
  // is a fit the box should not be laid out to either, and carrying one while
  // placing from the block would leave the rectangle and its line breaks
  // describing two different bubbles.
  if (!g) {
    fit = null;
    if (outline && !outline.open) outline = { ...OPEN_OUTLINE };
    const rect = looksVertical(det, ln, p) ? transposeRect(det.box) : (det?.box ?? null);
    // The block says where the Japanese sat - which bubble, and its centre - and
    // nothing about how much room the English needs: a short line, or a column
    // read as a row, was a box as narrow as the 40 px minimum and a stack of
    // one-word lines (GEO-3). So text is sized from itself and centred on the
    // block - by the solver below, or here by the balanced size when the solver
    // cannot run - and only a box with no text to measure takes the block's size.
    if (rect) at = { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2 };
    // Skipped when the solver is about to size the box from the text anyway.
    // And skipped with no canvas, for the reason `autoFitBox` asks the same
    // question: every metric is a stand-in there, which is fine for deciding a
    // line break in a test and not fine for a number written into the user's
    // document. Either way the block, or the old constants, stand.
    // And skipped while the face is on its way to the Rust engine, or the
    // engine is: the balanced size would be measured in the stand-in, written
    // into the box and into the `place` entry, and it is the solver's to give
    // when the face lands (the box is 'pending', below).
    const bal = solvable || !canMeasure() || faceArriving(style, text) ? null : balancedBoxSize(text, style);
    g = bal ? placementRect(p, null, at.x, at.y, bal.w, bal.h) : placementRect(p, rect, imgX, imgY);
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
    // Computed above rather than here, because the box has to be sized from this
    // line's text in the style it is about to be set in - a box sized against
    // the inherited size and then born at a tag's larger one would be the wrong
    // shape from its first frame.
    style,
    // The balloon this box was fitted to, or null when it was not. Written on
    // every placed box either way so the field is never absent - see the same
    // reasoning in `loadProjectPages`. It rides inside the `place` history entry
    // below (`$state.snapshot(b)` takes the whole box), so an undo of a
    // placement takes the fit with it.
    fit,
    // Where the fit came from, and that nobody has approved it yet. Absent when
    // the page's pixels were not in hand to look.
    ...(outline ? { outline } : null),
    auto: normalizeAuto({ refSize: style.size }),
  };
  // A box born in plain black or white lets its bubble pick between the two;
  // any other colour was picked by somebody, and stays (LET-3).
  b.style.autoContrast = PLAIN_INKS.has(String(b.style.color).toLowerCase());
  applyBubbleInk(b, p);
  // Before the push and before the record, so the one `place` entry this gesture
  // writes carries the box the user is actually looking at. A box whose line
  // already has its translation typed in the queue is placed at the size that
  // text needs; an empty one is placed at the bubble's size and grows as it is
  // filled in, through `setBoxText`.
  if (!(solvable && solveBox(b, p, text, at))) {
    autoFitBox(b, p);
    // Stamped as it now stands, so any edit before the face arrives - by
    // whatever path - hands it to the ladder instead (`solvePending`).
    if (measurable && !solvable) {
      b.auto.status = 'pending';
      b.auto.stamp = solveStamp(b, text);
    }
  }
  return b;
}

// The solver's answer, written onto a box: in its balloon, or with none,
// centred on `at` - for a box being born the detected block's centre or the
// click, for a pending one its own centre, which is where it was placed.
// Answers false when there was nothing the solver would lay out (text on a
// curve), so the caller places the box as before.
//
// `stay` keeps the box where it stands: its position is locked for this solve,
// whatever its record says, and it is not pulled back onto its page - see
// `resolveBox`. The solver holds such a box to its balloon and its page itself
// (`rowsFit`, `onPage` in auto-layout.js): an answer that would leave either is
// no answer, so the text shrinks or the box is flagged. The best effort's growth is bounded by the balloon and the
// page, never by a whole longstrip (FIT-2).
function solveBox(b, p, text, at, stay = false) {
  const a = b.auto;
  const region = b.fit ?? { kind: 'hint', x: at.x, y: at.y, w: 0, h: 0 };
  const r = solveLayout({
    text,
    style: b.style,
    refSize: a.refSize,
    region,
    locks: stay ? { ...a.locks, pos: true } : a.locks,
    opts: {
      minSize: solveFloor(a.refSize),
      minW: MIN_BOX_W,
      minH: MIN_BOX_H,
      box: { x: b.x, y: b.y, w: b.w, h: b.h },
      page: p,
    },
  });
  if (!r) return false;
  const g = stay ? { x: r.x, y: r.y, w: r.w, h: r.h } : ontoPage(p, r);
  for (const k of ['x', 'y', 'w', 'h']) if (b[k] !== g[k]) b[k] = g[k];
  if (b.style.size !== r.size) b.style.size = r.size;
  // Not the user's size, so the mark follows it (`noteSizeEdit`).
  seeSize(b);
  // An overflow whose ink is still inside the box is flagged from the record
  // (`solverReview`), for as long as the box is the one solved here.
  b.auto.status = r.status;
  b.auto.reason = r.reasons[0] ?? null;
  b.auto.stamp = solveStamp(b, text);
  writeReview(b, r.review);
  return true;
}

// An edit's solve (FIT-2), for `autoFitBox`: the size, the height and the lines
// again, inside the box's balloon - from the reference size, so text that got
// shorter gets its size back, and to the height it now needs, so a box whose
// text got shorter or that was made wider gives the height back. A box keeps its
// place on the page: an edit re-sets the text where the box stands, and only
// the Refit button re-places it in its balloon (`refitBalloon`). A box never
// solved - placed with no text to set - is laid out whole the first time its
// text arrives, as placement would have laid it out.
//
// Null when the solver has nothing to say - no metrics, blank text, or a face
// still loading, which it must not be measured against (DET-4) - so the caller
// fits the box by the older rules; otherwise whether the box's rectangle or
// size moved.
function resolveBox(b, p, text, stay = !!b.auto.stamp) {
  if (!canMeasure() || !/\S/.test(text) || !faceReady(b.style, text)) return null;
  const before = fitGeom(b);
  if (!solveBox(b, p, text, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, stay)) return null;
  return ['x', 'y', 'w', 'h', 'size'].some((k) => before[k] !== (k === 'size' ? b.style.size : b[k]));
}

// Whether the face a style names is loaded, so a measurement of it is a
// measurement of what will be drawn (DET-4). One the page has asked for and
// not got yet measures as the fallback family, and a size solved against that
// is a size for a font nobody sees - so the box is placed as before instead,
// and the face is asked for so the next placement has it. True where there is
// no font set to ask (node, the realfont lane), and for a font string the set
// cannot parse, which measures as the fallback on either path.
function faceReady(style, text) {
  if (faceArriving(style, text)) return false;
  const engine = textEngine();
  const face = faceFor(style, style.size);
  return engine ? engine.faceReady(face) : browserFaceReady(face);
}

// With the Rust engine switched on: the face this style names is on its way to
// it, or the engine itself is. Whatever measures the box meanwhile is a
// stand-in for what will, so the fits below leave the box alone until the news
// arrives (`relayoutAll`) - a height grown for the stand-in would be a number
// in the document nobody chose, and growing is never undone. Asking is also
// what sends for a system family's bytes the first time a box uses it. Always
// false with no font source, which is the browser measuring as it always has.
//
// `text` is what the box holds, where the caller has it: a letter the face
// lacks is drawn from another installed family, and that family arrives the
// same way the face does - asked for by the first box that needs it, and not
// to be written from until it is in (`lettersReady`). A box whose own face is
// in can therefore still be waiting, for a letter.
function faceArriving(style, text) {
  if (!fontSource) return false;
  if (!fontSource.ready(style.font)) return true;
  return text != null && !!fontSource.lettersReady && !fontSource.lettersReady(style, text);
}
// The same for a box on its page. The text is not looked up at all with no
// font source: this is asked before every fit, in every session.
function boxFaceArriving(b, p) {
  return !!fontSource && faceArriving(b.style, boxText(b, p));
}

// The boxes an edit tried to fit while their face was arriving. An edit runs
// the whole ladder and a font arriving runs only the grow-only refit, so
// without this the first box ever set in a system family would wait for its
// next edit to be fitted. Held by identity and weakly: a box that an undo
// replaced or a chapter closing dropped is simply not found again.
const fitsAwaitingFace = new WeakSet();
let fitsAwaited = 0;
function holdFit(b) {
  if (fitsAwaitingFace.has(b)) return;
  fitsAwaitingFace.add(b);
  fitsAwaited++;
}
// How short a drag of the handle `dir` may leave a box. That is a matter for
// the top and bottom edges only (`takesHeightFloor`, resize-math.js: a corner
// scales the type and takes no floor, a left or right edge leaves the height
// alone); for any other handle it is the plain minimum and nothing else
// happens here. Auto height keeps
// its promise through the drag - an edge can make the box roomier, never
// shorter than its text - so the floor is what `lineCount` lines need, capped
// at the page as the fit itself is, and the plain minimum for a box that is
// not auto-sized or has no lines to count (curved text).
//
// It is here, beside the fits, because it is one of them and must stand down
// when they do. While the box's face is arriving the count is of lines broken
// in a stand-in, and a floor taken from it is a height nobody chose written
// into the document by a one-pixel drag - upward, which is never undone. So
// then the floor is the plain minimum, and the fit is held for when the face
// lands, as an edit's is - only then: a fit is owed where a floor stood down,
// and a drag that takes none has stood nothing down. A fit held for a corner
// drag re-set the box when the face landed, to a width and a place the user
// had not chosen. With no font source `faceArriving` is always false and this
// is the number the drag always used.
export const EDGE_DRAG_MIN = 30;
export function edgeDragFloor(b, dir, lineCount, p = page()) {
  const s = b?.style;
  if (!takesHeightFloor(dir)) return EDGE_DRAG_MIN;
  if (!s || s.autoHeight === false || lineCount == null) return EDGE_DRAG_MIN;
  if (faceArriving(s)) {
    holdFit(b);
    return EDGE_DRAG_MIN;
  }
  return Math.min(neededHeight(lineCount, s, textInset(s)), p?.h || Infinity);
}

// The held boxes of a page whose face is in by now, each with the geometry it
// stood at before anything fits it, and no longer held.
function heldFitsLanding(p) {
  const out = [];
  for (const b of p.boxes) {
    if (!fitsAwaitingFace.has(b) || boxFaceArriving(b, p)) continue;
    fitsAwaitingFace.delete(b);
    out.push({ b, was: fitGeom(b), pending: b.auto?.status === 'pending' });
  }
  return out;
}
// Their fits, after `solvePending` has had the page. One placed while it
// waited is the solver's and was solved there - unless it was edited since,
// which hands it to the ladder (its status is then gone), or its solve is
// still to come (still 'pending').
function fitLanding(p, landing) {
  let n = 0;
  for (const { b, pending } of landing) {
    if (pending && b.auto?.status != null) continue;
    if (autoFitBox(b, p)) n++;
  }
  return n;
}

// ---------- a fit that lands after its edit was recorded ----------
// An edit's fit is part of the edit: its history entry carries the box's
// geometry on both sides (`geomBefore` / `geomAfter`). A held fit breaks that -
// the entry was recorded with the box as the edit left it, unfitted, and the
// fit ran when the face landed, in no entry at all: undo then redo put back
// the unfitted rectangle. The history keeps its own entries right (see "a fit
// owed to an entry" in history.svelte.js); these are what it needs of the
// store, which knows which boxes are held and how to fit one.
//
// Whether a fit of this box is being held for its face.
export const fitHeld = (b) => fitsAwaited > 0 && fitsAwaitingFace.has(b);
export const anyFitHeld = () => fitsAwaited > 0;
// The box is no longer owed one: a step through the history put it back to a
// state nobody edited their way to.
export function dropHeldFit(b) {
  fitsAwaitingFace.delete(b);
}
// The box is owed one - a step through the history put it back as an edit left
// it before its fit could run. Held again while the face is still on its way
// (null); fitted now otherwise, and the geometry on either side handed back
// for the entry.
export function payHeldFit(b, p) {
  if (!b?.style || !canMeasure()) return null;
  if (boxFaceArriving(b, p)) {
    holdFit(b);
    return null;
  }
  fitsAwaitingFace.delete(b);
  const was = fitGeom(b);
  if (b.auto?.status === 'pending') solvePending(p, [b]);
  else autoFitBox(b, p);
  return { was, now: fitGeom(b) };
}
// Told of every held fit as it lands: the page, the box, and its geometry
// before and after. A seam, like the recorder, so the store knows no history.
const fitLanders = seam();
export function setFitLander(fn) {
  return fitLanders.subscribe(fn);
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
    const b = bornBox(p, ln, cx, cy, storedMeasure(det));
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

// The measurement stored on a detected block, as `bornBox` takes it: undefined
// when it was never measured. Fresh copies, never the block's own objects. A
// block measured before outlines existed has no record; one with no fit was
// measured and found in no bubble.
function storedMeasure(det) {
  if (det.fit === undefined) return undefined;
  const fit = normalizeFit(det.fit);
  const outline = normalizeOutline(det.outline) ?? (fit ? null : { ...OPEN_OUTLINE });
  return { fit, outline };
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
    for (const d of p.detect?.boxes ?? []) {
      if (!fits.has(d)) continue;
      const m = fits.get(d);
      d.fit = m?.fit ?? null;
      if (m?.outline) d.outline = m.outline;
      else delete d.outline;
    }
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
  const m = firstFound(measureBalloon(p, [x1 * sx, y1 * sy, x2 * sx, y2 * sy], pixels, { sx, sy }), () =>
    measureBalloonAt(p, ((x1 + x2) / 2) * sx, ((y1 + y2) / 2) * sy, pixels, { sx, sy }),
  );
  if (!m || (sx === 1 && sy === 1)) return m;
  return { ...m, fit: scaleFit(m.fit, 1 / sx, 1 / sy) };
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
// Then the text is typeset again in what it found (FIT-4): the solver, as at
// placement, from the box's reference size - the size, the width, the height,
// the lines and the box's place in the balloon, all of them, except what the
// box has locked (`auto.locks`: a width set by hand, a size typed in). With no
// balloon, around the box's own centre. An edit only re-sets the text where the
// box stands (`resolveBox`); this is the one command that re-places it. An auto
// box with no solver record - one typed onto the page, or saved before the
// solver existed - is given one here, at the size it is set at: pressing the
// button is asking for exactly this.
//
// When the solver has nothing to say - blank text, a face still loading - the
// box is fitted as before: a fit that appears where there was none resizes it
// to the balloon, the way placement sizes it (`fittedRect`), and the ladder
// runs. A manual box gets its new fit and the verdict, nothing else.
//
// Idempotent (DET-2): the same box on the same balloon is solved to the same
// answer, so a second press finds the balloon the first one laid the box out in
// and changes nothing.
//
// One press is one undo step (UX-2): the `refit` entry carries the fit, the
// rectangle, the size and the solver record on either side, because the solve
// can move all of them and none of them can be re-derived on the way back. A
// press that changed none of them records nothing, so an undo never lands on a
// step that does nothing.
export function refitBalloon(boxId = app.selectedId, p = page()) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b) return false;
  // A pending Inspector edit on this box would settle AFTER this one and record
  // on top of it - the same reason `toggleBalloonFit` settles first.
  settleEdits();
  const before = b.fit;
  const m = balloonUnder(p, b);
  const { fit, solved } = setBoxOutline(b, p, m?.fit ?? null, m?.outline);
  const where = fit ? `the ${panelLike(b) ? 'panel' : 'balloon'} under this box` : null;
  if (fit) toast(solved != null ? `Typeset again in ${where}` : `Fitted to ${where}`);
  else if (before) toast('No balloon found under this box - layout is rectangular again');
  else toast('No balloon found under this box');
  return !!fit;
}

// A box given a new fit and outline record, and its text typeset again in it:
// the solver, as at placement, or, when it has nothing to say, the old fit
// (a fit that appears where there was none sizes the box to the balloon) and
// the ladder. One undo step (`refit`), recorded only when something changed.
//
// `geomBefore` is for a gesture that already moved the outline live (a point
// drag): the box as it stood when the gesture began.
function setBoxOutline(b, p, fit, outline, geomBefore = refitGeom(b)) {
  const before = geomBefore.fit;
  b.fit = fit;
  setOutline(b, outline);
  applyBubbleInk(b, p);
  const text = boxText(b, p);
  const auto = isAutoBox(boxCandidate(b, text));
  if (auto && !b.auto && b.style.size > 0) b.auto = normalizeAuto({ refSize: b.style.size });
  const solved = auto && b.auto?.on ? resolveBox(b, p, text, false) : null;
  if (solved == null) {
    if (fit && !before && auto) {
      const g = fittedRect(p, fit, b.style.align);
      if (g) Object.assign(b, g);
    }
    // The height follows: a box laid out to a curve breaks into a different
    // number of lines than the same box laid out flat, and the rectangle has to
    // describe that. What no longer fits is flagged.
    autoFitBox(b, p);
  }
  const geomAfter = refitGeom(b);
  if (JSON.stringify(geomAfter) !== JSON.stringify(geomBefore)) {
    recordEdit({ t: 'refit', pageId: p.id, boxId: b.id, geomBefore, geomAfter });
    markUnsaved();
  }
  return { fit, solved };
}

// ===== the outline, by hand (Bubble C) =====
//
// What the Regions view and the Inspector do to a box's outline: approve it,
// replace it with the box's own rectangle, or move its points. Every change to
// the points clears the approval and typesets the text again inside them.

// The outline's state, for its colour and the Inspector's words:
//   'user' | 'ai'   approved, and by whom
//   'waiting'       a fit nobody has approved - including one saved before
//                   outlines had a record
//   'open'          looked, and found no closed outline
//   null            never looked (no fit, no record)
export function outlineState(b) {
  if (!b) return null;
  if (b.fit) return b.outline?.approved ?? 'waiting';
  return b.outline?.open ? 'open' : null;
}

// Any fit as outline points, for drawing and for the handles: a poly is
// itself; an oval is sampled; a rectangle is its corners; rows go down the
// left edges and back up the right.
export function outlinePoints(fit) {
  const f = normalizeFit(fit);
  if (!f) return [];
  if (f.kind === 'poly') return f.pts;
  if (f.kind === 'rect') return [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]];
  if (f.kind === 'ellipse') {
    const n = 32;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [Math.round((f.cx + f.rx * Math.cos(a)) * 100) / 100, Math.round((f.cy + f.ry * Math.sin(a)) * 100) / 100];
    });
  }
  const left = [];
  const right = [];
  f.spans.forEach((sp, i) => {
    if (!sp) return;
    const y0 = f.y0 + i * f.step;
    left.push([sp[0], y0], [sp[0], y0 + f.step]);
    right.push([sp[1], y0], [sp[1], y0 + f.step]);
  });
  const pts = [...left, ...right.reverse()];
  // Rows of hundreds of bands are hundreds of points; keep every k-th so the
  // handles stay few. The stored fit is untouched until the user drags one.
  const k = Math.ceil(pts.length / 64);
  return k > 1 ? pts.filter((_, i) => i % k === 0) : pts;
}

// Approve the outline under one box. An open outline cannot be approved: there
// is nothing drawn to approve, and approving it would hide it from the check.
export function approveOutline(boxId = app.selectedId, p = page(), by = 'user') {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b) return false;
  if (!b.fit) {
    toast('No outline to approve - use Outline = box, or Refit');
    return false;
  }
  const n = approveBoxes(p, [b], by);
  if (n) toast('Outline approved');
  return n > 0;
}

// Approve every fitted, unapproved outline on the page, in one undo step.
export function approvePageOutlines(p = page(), by = 'user') {
  // Only what nobody approved: an AI approval stays one, for the user to spot-check.
  const waiting = (p?.boxes ?? []).filter((b) => b.fit && !b.outline?.approved);
  const n = approveBoxes(p, waiting, by);
  const open = (p?.boxes ?? []).filter((b) => outlineState(b) === 'open').length;
  const openStr = open ? ` · ${open} with no outline left` : '';
  toast(n ? `Approved ${n} outline${n === 1 ? '' : 's'}${openStr}` : `Nothing to approve${openStr}`);
  return n;
}

function approveBoxes(p, boxes, by) {
  settleEdits();
  const items = [];
  for (const b of boxes) {
    if (!b.fit || b.outline?.approved === by) continue;
    const before = b.outline ? $state.snapshot(b.outline) : null;
    // A fit saved before outlines had a record is the old fill-and-fit's.
    b.outline = { ...(before ?? { source: 'fill', confidence: 0 }), approved: by };
    delete b.outline.open;
    items.push({ boxId: b.id, before, after: $state.snapshot(b.outline) });
  }
  if (items.length) {
    recordEdit({ t: 'outlines', pageId: p.id, items });
    markUnsaved();
  }
  return items.length;
}

// The box's own rectangle as its outline: for free text, an SFX, or a bubble
// the finder could not close. Unapproved, like any new outline.
export function outlineToBox(boxId = app.selectedId, p = page()) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b) return false;
  settleEdits();
  const { x, y, w, h } = b;
  const fit = normalizeFit({ kind: 'poly', pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
  if (!fit) return false;
  setBoxOutline(b, p, fit, { source: 'box', confidence: 1, approved: null });
  toast('Outline set to the box');
  return true;
}

// A point drag, live: the outline moves under the pointer and the text follows
// it on screen. Nothing is recorded; `commitOutlinePoints` does that once, from
// the geometry `outlineGeom` took when the drag began.
export const outlineGeom = (b) => refitGeom(b);
export function previewOutlinePoints(b, pts) {
  const fit = normalizeFit({ kind: 'poly', pts });
  if (fit) b.fit = fit;
  return !!fit;
}

// The points as the user left them: a hand-made outline, unapproved, with the
// text typeset again inside it. One undo step back to `geomBefore`.
export function commitOutlinePoints(boxId, pts, p = page(), geomBefore = null) {
  const b = (p?.boxes ?? []).find((x) => x.id === boxId);
  if (!b) return false;
  const fit = normalizeFit({ kind: 'poly', pts });
  if (!fit) return false;
  setBoxOutline(b, p, fit, { source: 'manual', confidence: 1, approved: null }, geomBefore ?? refitGeom(b));
  return true;
}

// The layout key (01-bubble-check.md): a box's solver stamp already is one - a
// hash of its text, rectangle, style (font included) and fit, renewed by every
// solve and every move that keeps the solve. An auto box whose stamp no longer
// matches was laid out for inputs it no longer has.
export function isLayoutStale(b, p = page()) {
  if (!b?.auto?.stamp || b.auto.status === 'pending') return false;
  return !solveStands(b, boxText(b, p));
}

// "Keep current layouts": the boxes stand as they are, and their stamps say so.
export function keepCurrentLayouts(p = page()) {
  let n = 0;
  for (const b of p?.boxes ?? []) {
    if (!isLayoutStale(b, p)) continue;
    b.auto.stamp = solveStamp(b, boxText(b, p));
    n++;
  }
  if (n) markUnsaved();
  return n;
}

// What a refit can move, as its history entry records it. Plain copies, taken
// before the fit is replaced, so the two sides never share an object. The
// solver record is written on both sides, as null where there is none, so an
// undo of the press that gave a box its record takes the record away again.
const refitGeom = (b) => ({
  ...fitGeom(b),
  fit: b.fit ? $state.snapshot(b.fit) : null,
  outline: b.outline ? $state.snapshot(b.outline) : null,
  auto: b.auto ? $state.snapshot(b.auto) : null,
  // A refit can recolour the text (LET-3), so the entry carries the colours.
  colours: {
    color: b.style.color,
    strokes: (b.style.strokes ?? []).map((k) => k.color),
    auto: !!b.style.autoContrast,
  },
});

// ===== the text colour from the bubble (LET-3) =====
//
// On a box that lets its bubble pick (`style.autoContrast`): black or white
// text, whichever stands out on the bubble's inside, and the first stroke the
// other one. Runs at placement and at a refit, never on its own: the colour a
// box has is the colour it keeps until its outline changes. The colour comes
// from the outline record when the finder measured it, else from the page's
// pixels if they are in hand - and is then written onto the record, so the
// file remembers what the bubble said. Answers whether anything changed.
const PLAIN_INKS = new Set(['#000000', '#ffffff', '#000', '#fff']);
function applyBubbleInk(b, p) {
  if (!b.style?.autoContrast || !b.fit) return false;
  let ink = b.outline?.ink;
  if (!ink) {
    const image = pagePixelsFor(p);
    ink = image ? contrastInk(image, b.fit) : null;
    if (ink && b.outline && !b.outline.open) b.outline.ink = ink;
  }
  if (!ink) return false;
  const edge = ink === '#000000' ? '#ffffff' : '#000000';
  let changed = false;
  if (b.style.color !== ink) {
    b.style.color = ink;
    changed = true;
  }
  const k = b.style.strokes?.[0];
  if (k && k.color !== edge) {
    k.color = edge;
    changed = true;
  }
  return changed;
}

// ===== locks (FIT-5) =====
//
// What the solver may not change on a box (`auto.locks`, read by `locksOf` in
// auto-layout.js) used to be set only as a side effect - a size typed in, a
// width dragged wider - and the only way to let one go was an undo, which also
// took back the edit that set it. These are the commands that set and clear
// them on purpose: the lock chip on the page and the Bulk panel call them, and
// nothing else decides what a lock means.
//
// Only a box the solver manages has locks worth showing or changing. A manual
// box - sizing off, text on a curve, a mesh warp, ink or a mask - is never laid
// out by the solver, so a lock on it would do nothing and a chip would promise
// something it cannot deliver.
const LOCK_KEYS = ['size', 'width', 'height', 'pos', 'breaks'];

export const lockableBox = (b) => !!(b?.auto?.on && b.style && isAutoBox(boxCandidate(b, null)));

// The locks a box has on, as a plain object, or null when it has none (or none
// that mean anything - see `lockableBox`). What the chip reads to decide
// whether to show at all and which entries its menu offers.
export function boxLocks(b) {
  if (!lockableBox(b)) return null;
  const l = b.auto.locks ?? {};
  const on = {};
  for (const k of LOCK_KEYS) if (l[k] === true) on[k] = true;
  return Object.keys(on).length ? on : null;
}

// Whether the whole layout is held, as "Lock layout" holds it. The line breaks
// are the one lock nothing else sets, so they are what marks it.
export const layoutLocked = (b) => !!boxLocks(b)?.breaks;

// What a lock change can move, as the `locks` history entry records it: the
// locks, and the reference size, which "Lock layout" rewrites (below). Plain
// copies, never the live proxy.
const lockRecord = (b) => ({ locks: { ...$state.snapshot(b.auto.locks) }, refSize: b.auto.refSize });

// Sets or clears locks on one box or several, anywhere in the chapter: `patch`
// names the locks to change, `{ size: false }` or `{ width: true }`, and leaves
// the rest as they are.
//
// Releasing the size or the width lets the line breaks go too. The breaks hold
// both (`locksOf`), so "Unlock size" on a box whose breaks are held would
// otherwise change nothing at all.
//
// `hold` is "Lock layout": the size, the width, the place and the breaks, held
// as they stand. The solver's size lock holds the REFERENCE size, not the one
// on the box, so a box the solver had shrunk to 18 from 24 would jump back up
// to 24 at its next edit - the opposite of holding it. So the size it stands at
// becomes its reference, as a size typed on the box does (`rememberSizeFor`).
// Only this box's: the tag's remembered size is left alone, because locking a
// box is not saying anything about every other box of its kind.
//
// Nothing is typeset again. A lock or an unlock is a statement about the next
// solve, and a box that jumped the moment its lock was clicked away would be
// the fit arguing with the user; Refit (`refitBalloon`, Mod+Alt+F by default) is
// how they ask for the box to be laid out again without it.
//
// One undo step per page the boxes are on (the same rule as `recordBulkByPage`:
// an entry is only ever on one page's stack), and none when nothing changed.
// Answers how many boxes changed.
export function setBoxLocks(ids, patch = {}, { hold = false } = {}) {
  const want = new Set(Array.isArray(ids) ? ids : [ids]);
  if (!want.size) return 0;
  // An Inspector edit still settling would record after this and on top of it.
  settleEdits();
  const byPage = new Map();
  let changed = 0;
  for (const pg of app.pages) {
    for (const b of pg.boxes ?? []) {
      if (!want.has(b.id) || !lockableBox(b)) continue;
      const before = lockRecord(b);
      const next = { ...before.locks, ...patch };
      if (patch.size === false || patch.width === false) next.breaks = false;
      for (const k of LOCK_KEYS) {
        const v = next[k] === true;
        if (b.auto.locks[k] !== v) b.auto.locks[k] = v;
      }
      if (hold && b.style.size > 0 && b.auto.refSize !== b.style.size) b.auto.refSize = b.style.size;
      const after = lockRecord(b);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      const items = byPage.get(pg.id) ?? [];
      items.push({ boxId: b.id, before, after });
      byPage.set(pg.id, items);
      changed++;
    }
  }
  for (const [pageId, items] of byPage) {
    // A one-box entry names its box, so the undo selects it (`step`).
    recordEdit({ t: 'locks', pageId, ...(items.length === 1 ? { boxId: items[0].boxId } : null), items });
  }
  if (changed) markUnsaved();
  return changed;
}

// The chip's and the Bulk panel's commands, in words. `which` is 'size',
// 'width' or 'all'.
export function unlockBoxes(ids, which = 'all') {
  const patch = which === 'all' ? Object.fromEntries(LOCK_KEYS.map((k) => [k, false])) : { [which]: false };
  return setBoxLocks(ids, patch);
}

export const lockBoxLayout = (ids) => setBoxLocks(ids, { size: true, width: true, pos: true, breaks: true }, { hold: true });

// The keyboard's Lock layout (`box.layoutLock`): a switch on the selected box,
// like the balloon fit's. Held already, it lets every lock go. Told in a toast
// either way, since nothing on the page moves to show it happened.
export function toggleLayoutLock(boxId = app.selectedId) {
  const b = byId(boxId);
  if (!b) return false;
  if (!lockableBox(b)) {
    toast('This box is laid out by hand - it has no layout to lock');
    return false;
  }
  if (layoutLocked(b)) {
    if (unlockBoxes(boxId, 'all')) toast('Layout unlocked - Refit will lay this box out again');
  } else if (lockBoxLayout(boxId)) toast('Layout locked - edits and Refit keep this box as it is');
  return true;
}

// The balloon a box sits in, from the seeds `refitBalloon` describes.
function balloonUnder(p, b) {
  const covers = (x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  const centreOf = ([x1, y1, x2, y2]) => [(x1 + x2) / 2, (y1 + y2) / 2];
  const blocks = [];
  const det = (p.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4);
  if (det) blocks.push(det.box);
  const room = b.fit && inscribedRect(b.fit);
  if (room) blocks.push([room.x, room.y, room.x + room.w, room.y + room.h]);
  let first = null;
  for (const block of blocks) {
    if (!covers(...centreOf(block))) continue;
    const m = measureBalloon(p, block);
    if (m?.fit) return m;
    first ??= m;
  }
  return firstFound(first, () => measureBalloonAt(p, b.x + b.w / 2, b.y + b.h / 2));
}

// A box's outline record, written or taken away. A fresh object, never one
// shared with a measurement or a stored block.
function setOutline(b, outline) {
  if (outline) b.outline = { ...outline };
  else delete b.outline;
}

// Is the fit under this box a panel rather than a balloon - for a toast's word.
const panelLike = (b) => b.fit?.kind === 'rect' || b.outline?.source === 'caption';

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
  if (!on && !b.fit) {
    const m = balloonUnder(p, b);
    b.fit = m?.fit ?? null;
    setOutline(b, m?.outline);
  }
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
  else if (b.fit) toast(`Balloon fit on - ${panelLike(b) ? 'panel' : 'balloon'} under this box`);
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
    // Through `inheritedStyleFor` like `placeActiveAt`, respecting the same
    // style inheritance preference and new-box defaults.
    style: inheritedStyleFor(ln, p),
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
  const snap = boxSnapshot(src, p);
  return placeSnapshot(p, snap, snap.box.x + DUP_OFFSET, snap.box.y + DUP_OFFSET);
}

// What a copy needs of its source, taken whole at the moment of the copy: the
// box, and the line it reads its words from. Plain data, so a clipboard holding
// it is untouched by later edits to the source - or by the source's page being
// turned away from, or the source being deleted.
function boxSnapshot(src, p) {
  const from = lineByN(p, src.lineN);
  const tags = lineTags(from);
  const text = boxText(src, p);
  return {
    box: {
      x: src.x,
      y: src.y,
      w: src.w,
      h: src.h,
      style: cloneStyle(src.style),
      fit: normalizeFit($state.snapshot(src.fit)),
      outline: normalizeOutline($state.snapshot(src.outline)),
      // The solver's record: whether it manages the box, the size it was solved
      // from and the locks the user set. A copy that lost it would lay itself
      // out differently the first time either box is edited.
      auto: normalizeAuto($state.snapshot(src.auto)),
      // Whether the box is still the solve's answer. The copy is the same solve
      // somewhere else - its fit moves with it - so it keeps the answer the way
      // a moved box does (`moveBoxTo`), and only then.
      solved: !!src.auto && src.auto.status !== 'pending' && solveStands(src, text),
    },
    line: {
      type: from?.type ?? 'dialogue',
      jp: from?.jp ?? '',
      // What the source SHOWS, not what its line says: a queue-placed box can
      // override its line with `box.text`, and a legacy free box has no line at
      // all, so `boxText` is the only reader that answers for every case.
      en: text,
      ...(tags.length ? { tags: [...tags] } : null),
    },
  };
}

// A snapshot made into a new box on `p`, its top-left at (x, y) or as near as
// the page allows. One undo entry, and the copy ends up selected.
function placeSnapshot(p, snap, x, y) {
  const ln = { n: nextFreeLineN(p), ...snap.line };
  if (ln.tags) ln.tags = [...ln.tags];
  p.lines.push(ln);
  const src = snap.box;
  const b = {
    id: 'b' + boxSeq++,
    lineN: ln.n,
    // Always null. The copy is a free box, and a free box's text lives on its
    // line (`setBoxText` writes `ln.en` when lineN < 0). Carrying `src.text`
    // here left a non-null override that `boxText` kept showing while every
    // edit went to the line - the copy looked frozen on the original's words.
    text: null,
    x: clamp(x, 0, Math.max(0, p.w - src.w)),
    y: clamp(y, 0, Math.max(0, p.h - src.h)),
    w: src.w,
    h: src.h,
    // Cloned again, not handed over: one clipboard pasted twice is two boxes
    // that must restyle apart.
    style: cloneStyle(src.style),
    fit: null,
  };
  // The fit is the box's width profile, carried to the offset the copy sits
  // at as a move carries it (`moveBoxTo`): its rows hang from where the box
  // draws its block (`balloonWidthsFor`), so a fit left where the original's
  // balloon is would break the copy's lines on other rows. With it carried,
  // the copy breaks exactly where the original does.
  b.fit = translateFit(normalizeFit(structuredClone(src.fit)), b.x - src.x, b.y - src.y);
  // Its outline record too, unapproved: the copy's outline sits where the copy
  // does, and nobody has looked at it there.
  const outline = normalizeOutline(src.outline);
  if (outline) b.outline = { ...outline, approved: null };
  if (src.auto) {
    b.auto = normalizeAuto(structuredClone(src.auto));
    if (src.solved) b.auto.stamp = solveStamp(b, ln.en);
  }
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

// ---------- copy / paste ----------
// A box copied with Mod+C and pasted with Mod+V, onto the page on screen - the
// same page or any other. The clipboard is the app's own rather than the
// system's: what it holds is a box, not text, and the system clipboard stays
// the text fields' to use.
//
// `landed` is where the clipboard last landed on each page, the copy's own
// page counting its source. A paste onto a page it has landed on steps down
// and right from there, as a duplicate does, so pasting twice gives two boxes
// rather than one on top of the other; a first paste onto another page lands
// where the box stood on its own page, which on a chapter of same-sized pages
// is the same place in the panel layout.
let boxClipboard = null;

export const hasCopiedBox = () => !!boxClipboard;

export function copyBox(id = app.selectedId) {
  if (!app.pages.length || isTranslateMode()) return false;
  const p = page();
  const src = p.boxes.find((b) => b.id === id);
  if (!src) return false;
  // A debounced edit still pending on the box would otherwise be missing from
  // the copy: the user copies what they see.
  settleEdits();
  const snap = boxSnapshot(src, p);
  boxClipboard = { ...snap, landed: new Map([[p.id, { x: src.x, y: src.y }]]) };
  return true;
}

export function pasteBox() {
  if (!boxClipboard || !app.pages.length || isTranslateMode()) return null;
  settleEdits(); // see `duplicateBox`
  const p = page();
  const { landed, box } = boxClipboard;
  const last = landed.get(p.id);
  const id = last
    ? placeSnapshot(p, boxClipboard, last.x + DUP_OFFSET, last.y + DUP_OFFSET)
    : placeSnapshot(p, boxClipboard, box.x, box.y);
  const b = p.boxes.find((x) => x.id === id);
  landed.set(p.id, { x: b.x, y: b.y });
  return id;
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
// Updates the box geometry and scales stroke points and sizes. `base` is the
// box as the gesture found it - its w/h, and its strokes when it is inked.
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
  // Against the width the gesture started from when the caller says (`base`), so
  // every step of an edge drag re-sets the text, not only the steps that moved
  // the pointer sideways: each one writes the height back from the start.
  const widened = nw !== ow;
  // A new place and nothing else - the Inspector's X or Y - is a move, and
  // carries the balloon fit and a standing solve with the box as a drag does.
  const moveOnly = nw === b.w && nh === b.h && !Number.isFinite(geom.size) && (nx !== b.x || ny !== b.y);
  b.w = nw;
  b.h = nh;
  if (moveOnly) moveBoxTo(b, nx, ny, p);
  else {
    b.x = nx;
    b.y = ny;
  }
  if (Number.isFinite(geom.size)) {
    b.style.size = geom.size;
  }
  // A width set by hand is the box's from here on: the solver keeps it through
  // every later edit and Refit (`auto.locks.width`), and an edge drag re-sets the
  // text in it as it goes - the size back towards the reference and the height
  // to what the lines now need, so a box made wider gives its height back
  // (FIT-2). Not a corner drag, which sets the size too and is the user's size
  // edit (`noteSizeEdit`).
  if (widened && b.auto?.on) b.auto.locks.width = true;
  if (widened && !Number.isFinite(geom.size) && b.auto?.on && isAutoBox(b)) {
    if (resolveBox(b, p, boxText(b, p), true) != null) return b;
    // The face is on its way, so the text was not re-set in the new width:
    // owed for when it lands, as an edit's fit is (`autoFitBox`).
    if (boxFaceArriving(b, p)) holdFit(b);
  }
  // Any other drag is the user choosing the box, so it never runs the ladder -
  // but the flag has to describe the box they chose. A height-only drag changes
  // nothing the component's own fit effect watches, so this is the only place
  // that would notice the text no longer fits.
  reviewBox(b, p);
  return b;
}


// ---------- moving a box ----------
// A box the user moves - a drag or the arrow keys - takes its balloon fit with
// it, so its lines stay the lines it had (GEO-2). The rows a fitted block is
// broken to hang from where the box draws it (`balloonWidthsFor`), and that is
// right for everything that places a box: the solver, a refit, a resize, auto
// height. A move is not one of those. Measured against the balloon where it
// stands, a box dragged a few pixels up drew every line on another row, and its
// breaks changed under the pointer - and then again at the next keystroke,
// when the solver held it where it now stood and checked each line against the
// balloon's rows there (`rowsFit`), shrinking the text or flagging it for a
// balloon it had only been nudged within.
//
// So the fit is the box's width profile, as `duplicateBox` has always treated
// it, and it rides with the box: the lines, their indents, the solver's verdict
// and the export are all the same as before the move, only somewhere else. What
// the user has put where the balloon is narrower is theirs, as it is sideways,
// where the rows were already centred on the box; Refit is the command that
// sets the text again in the balloon under the box (`refitBalloon`, which
// measures it afresh there).
//
// A solve that described the box before the move describes it after, as after a
// rescale: its stamp moves with it, so an overflow the solver flagged stays
// flagged (`solverReview`). Not a box still waiting for its face: its stamp
// says it is as it was placed, and a move is the user's (`solvePending`).
//
// `from` is where the gesture started - `moveGeom` taken then - so a drag moves
// the fit from one place by the whole distance rather than by every pointer
// step in turn.
export const moveGeom = (b) => ({
  x: b.x,
  y: b.y,
  ...(b.fit ? { fit: $state.snapshot(b.fit) } : null),
  ...(b.outline ? { outline: $state.snapshot(b.outline) } : null),
  ...(b.auto ? { auto: $state.snapshot(b.auto) } : null),
});

export function moveBoxTo(b, x, y, p = page(), from = moveGeom(b)) {
  const text = b.auto?.stamp && b.auto.status !== 'pending' ? boxText(b, p) : null;
  const stood = text != null && solveStands(b, text);
  b.x = x;
  b.y = y;
  if (from.fit) b.fit = translateFit(from.fit, x - from.x, y - from.y);
  // The outline went with the box, off the bubble it was approved on.
  if (b.outline?.approved && (x !== from.x || y !== from.y)) b.outline.approved = null;
  if (stood) b.auto.stamp = solveStamp(b, text);
}

// ---------- keyboard nudge ----------
// The arrow keys, moving the selected box a pixel at a time. Bounds are the
// drag's, not the page's: a box the user deliberately hung off the edge must not
// jump back onto the page on the first arrow press.
//
// A run of presses coalesces into one entry through the same settle window the
// Inspector's sliders use - the history is `MAX_STEPS` deep, so an entry per
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
  recordEdit({ t: 'move', pageId: pend.pageId, boxId: pend.boxId, before: pend.before, after: moveGeom(b) });
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
  nudgePending ??= { boxId: id, pageId: p.id, before: moveGeom(b) };
  moveBoxTo(b, x, y, p);
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
  'noFill',
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
  'roughen.grit',
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
  fill: ['color', 'noFill', 'opacity', 'blur', 'motionBlur', 'strokes', 'gradient', 'pattern'],
  shadow: ['shadows'],
  warp: ['curve', 'circle', 'roughen.on', 'roughen.amount', 'roughen.detail', 'roughen.seed', 'roughen.grit', 'clip'],
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
  // A colour set across boxes is a colour set by hand: the bubbles stop
  // picking it (LET-3).
  if (mask.color || mask.strokes) out.autoContrast = false;
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

// The Bulk panel's two lock buttons (FIT-5): "Unlock selected" lets every lock
// go on the boxes it has picked, "Lock layout of selected" holds each one's
// layout as it stands. They act at once, like the page's lock chip, rather than
// waiting for Apply: a lock is not a style, and the mask and the template have
// nothing to say about it. A tag selection is resolved again first, for the
// reason `applyBulk` gives. Manual boxes among the picks are passed over
// (`lockableBox`); the toast counts what changed, one undo step per page.
export function lockBulkTargets(lock) {
  if (!app.bulk.active) return 0;
  if (app.bulk.tag) syncBulkTagTargets();
  const ids = app.bulk.targets;
  if (!ids.length) {
    toast('No boxes selected');
    return 0;
  }
  const n = lock ? lockBoxLayout(ids) : unlockBoxes(ids, 'all');
  const boxes = `${n} box${n === 1 ? '' : 'es'}`;
  if (lock) toast(n ? `Layout locked on ${boxes}` : 'Nothing to lock - those boxes are held already, or laid out by hand');
  else toast(n ? `Unlocked ${boxes} - Refit lays each one out again` : 'None of those boxes has a lock');
  return n;
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

// Who answers for a font name when the lists above are not the whole story.
// The Rust text engine measures only faces whose bytes it was handed, so with
// it switched on (engine-switch.svelte.js) a family in the lists may still be
// on its way - a system face is read from disk the first time a box uses it -
// or may be one the machine has no bytes for at all, a built-in included. The
// switch installs this while it is on, and takes it out again when it is off:
//
//   nameFor(name)  the family that is measured and drawn for `name` right now,
//                  or null to leave the answer to the lists. Absent while the
//                  engine is still starting.
//   ready(name)    false while that answer is temporary: the face is on its
//                  way, and nothing may be written into the document from a
//                  measurement of what stands in for it.
//   missing(name)  whether the machine has no usable face for `name` at all.
//   lettersReady(style, text)
//                  false while a letter of `text` the style's face lacks is
//                  still being looked for among the installed fonts, or the
//                  family that has it is on its way: the same "nothing may be
//                  written" as `ready`, for one box's text. Asking is what
//                  starts the looking. Absent while the engine is starting.
//   settle(pages)  a promise for "nothing these pages need is on its way any
//                  more" (`fontsSettling`).
//   measuring()    whether the Rust engine is the one measuring right now.
//                  Absent while it is starting.
//   before()       the engine that measured before the switch went on, for
//                  asking how a box's lines broke then (`linesBefore`).
//
// Null, which is every session that never turns the switch on, leaves every
// function below answering exactly as it did before there was a switch.
let fontSource = null;
export function setFontSource(source) {
  const was = fontSource;
  // Going off: the boxes go back as they were before the engine fitted them,
  // unless the user has kept or edited them since. Before the source goes,
  // and before the browser re-fits what is open (`leave`).
  if (was && !source) endFirstFit();
  fontSource = source ?? null;
  // Coming on over a chapter that is already open: it is noted as it stands,
  // fitted by the browser, before the engine re-fits it.
  if (!was && fontSource && app.loaded) beginFirstFit();
}

// Identity of the source a lasting font-status wait belongs to.
export function fontSourceNow() {
  return fontSource;
}

// What an export waits for before it paints `pages`: every face their boxes
// are set in, and every family a letter of theirs is borrowed from, in the
// Rust engine or known not to be coming, and the boxes that waited for them
// fitted. A page of the chapter that was never on screen names fonts nobody
// has asked for yet, so asking here is also what sends for them. Null with no
// font source - the browser measuring - where there is nothing to wait for
// and nothing is awaited.
//
// It answers for THESE pages. A font landing fits the pages that are open
// (`relayoutAll`); the ones an export took may not be among them any more -
// the chapter was closed, or another opened, while it waited - and nothing
// would ever fit those. So they are fitted here, the same way, before the
// export is let through to paint them.
//
// It rejects when the wait gives up (see `fontsSettled` in
// engine-switch.svelte.js), and the export then fails and says so: it never
// resolves over something still on its way.
export function fontsSettling(pages = app.pages) {
  const settling = fontSource?.settle ? fontSource.settle(pages) : null;
  if (!settling) return null;
  return settling.then(() => {
    for (const p of pages ?? []) if (p?.boxes && !app.pages.includes(p)) landPage(p, false);
  });
}

// The same wait for FAMILIES, for whoever must say something lasting of a
// family no box of an open page is set in (a chapter package's fonts,
// package-flow.js): until it resolves `fontMissing` can answer "no" of a
// family that is only on its way - a system family is read the first time it
// is asked about - and its file may yet turn out unreadable. Asked as the
// gate is asked everything, through boxes; they hold no text, so no letter is
// looked for. Null with no font source.
export function fontFamiliesSettling(names) {
  if (!fontSource?.settle) return null;
  return fontSource.settle([{ boxes: names.map((font) => ({ lineN: null, text: '', style: { font } })) }]);
}

// Whether an export has that wait in front of it: a font source that can
// settle, which is the Rust engine switched on. An exporter asks so that it
// waits on ONE thing - this, or the browser's own font set, which is what it
// waited on before there was a switch and still does without one.
export function fontsGated() {
  return !!fontSource?.settle;
}

export function fontNameFor(name) {
  if (fontSource?.nameFor) {
    // What a name resolves to here changes with no list changing - the bytes
    // of a system face landing is not an edit to `app.fonts` - so a reactive
    // caller subscribes to the one signal that is raised for it.
    app.fontsVersion;
    const family = fontSource.nameFor(name);
    if (family) return family;
  }
  return fontByName(name) ? name : FALLBACK_FONT;
}

// The family a measuring engine is asked for when a style names `name`. With
// no font source that is the name itself, as it always was: the browser reads
// the CSS list and never looks at it. With one it is the family the source
// resolved the name to, which is also the family `fontCssFor` hands the memo
// in measure.js its key from - so the Rust engine, which finds a family by
// this name, is never asked for one it does not have, and no measurement is
// kept under one family's key that was made in another.
export function measuredFontFor(name) {
  return fontSource?.nameFor?.(name) || name;
}

// Whether the document names a font this machine cannot draw `name` in, so it
// is drawn in something else. With the browser measuring that is a name no
// list has; with the Rust engine it is a family there are no bytes for.
export function fontMissing(name) {
  if (fontSource?.missing) {
    app.fontsVersion;
    return fontSource.missing(name);
  }
  return !fontByName(name);
}

// The open chapter's missing families, each with how many boxes are set in it,
// most boxes first. One answer for the whole chapter, so nobody has to open
// every box to find out a font did not come with the file.
export function missingFonts(pages = app.pages) {
  const count = new Map();
  for (const p of pages ?? []) {
    for (const b of p.boxes ?? []) {
      const name = b.style?.font;
      if (typeof name !== 'string' || !name) continue;
      count.set(name, (count.get(name) ?? 0) + 1);
    }
  }
  return [...count]
    .filter(([name]) => fontMissing(name))
    .map(([name, boxes]) => ({ name, boxes }))
    .sort((a, b) => b.boxes - a.boxes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function fontCssFor(name) {
  const f = fontByName(fontNameFor(name));
  return f ? f.css : "'Comic Neue', cursive";
}
