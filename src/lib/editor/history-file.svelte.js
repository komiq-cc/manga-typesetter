// ===== The history file =====
// Only the page on screen keeps its undo stack in memory. Every other page's
// lives here, in the chapter's own directory, so a chapter with two hundred
// pages costs one page's entries of RAM rather than every page's - and so undo survives
// a relaunch.
//
//   <chapter-dir>/logs/history.json
//
// History is a convenience. Nothing in this module may be able to fail an edit,
// a save or a page turn: every disk error is reported once and swallowed, and
// nothing on the document's own save path ever waits on this one.
import { fsx } from '../fsx.js';
import { normalizeStyle, plainStyle } from '../data.js';
import { toast, toastError, DOC_SAVE_MS, rescalePageGeometry, rescaleStyle, rescaleAuto, scaleFit, lengthScale } from '../store.svelte.js';
import { scaleStroke } from '../brush.js';
import {
  takeStack,
  peekStack,
  loadStack,
  resetHistory,
  setHistorySink,
  setOffscreenSink,
  setOffscreenAmender,
  MAX_STEPS,
} from './history.svelte.js';

export const emptyDoc = () => ({ version: 1, pages: {} });

// A document of a version this build does not know is not repaired, it is
// replaced - a file whose shape we cannot read is worth less than the undo it
// would cost to start over.
export function mergeStack(doc, pageId, stack) {
  const next =
    doc && doc.version === 1 && doc.pages ? { ...doc, pages: { ...doc.pages } } : emptyDoc();
  const key = String(pageId);
  const undo = stack?.undo ?? [];
  const redo = stack?.redo ?? [];
  // A page the user has undone their way out of leaves no key behind. Without
  // this the file only ever grows, one page at a time, for the life of the
  // chapter.
  //
  // The one thing this drops that a user might miss: `loadStack` discards
  // entries of a kind this build cannot apply, so a stack written by a NEWER
  // build comes back empty and is then deleted rather than left for the build
  // that understands it. Accepted knowingly - `version` is what is supposed to
  // guard a format change, and a downgrade keeping records it can neither apply
  // nor show would be the worse trade.
  if (!undo.length && !redo.length) delete next.pages[key];
  else next.pages[key] = { undo, redo };
  return next;
}

// One entry onto the stack of a page whose stack is not in memory. Everything
// the live stack does to a new entry, done to a stored one: appended to the
// undo side, capped at the same depth, and the redo tail forfeited - a page the
// user had undone their way back through and then left has no branch forward
// once something new lands on it, exactly as it would have had none if they
// had been standing on it at the time.
//
// A pure function over the document, like `mergeStack` beside it, because that
// is what makes the one thing worth testing here testable without a disk.
export function appendEntry(doc, pageId, entry) {
  const cur = stackFrom(doc, pageId);
  return mergeStack(doc, pageId, { undo: [...cur.undo, entry].slice(-MAX_STEPS), redo: [] });
}

export function stackFrom(doc, pageId) {
  if (!doc || doc.version !== 1 || !doc.pages) return { undo: [], redo: [] };
  const s = doc.pages[String(pageId)];
  return { undo: s?.undo ?? [], redo: s?.redo ?? [] };
}

// Records made while a read was in flight sit on top of whatever that read
// brought back: the disk half is older by definition - it was written before
// this session started - so it goes underneath, and the newer half's redo
// branch is the one that stands, because anything recorded has already
// forfeited a redo. An untouched stack takes the stored one whole, which is
// what every ordinary open does.
export function graft(stored, live) {
  if (!live?.undo?.length && !live?.redo?.length) return stored;
  return { undo: [...stored.undo, ...live.undo].slice(-MAX_STEPS), redo: live.redo };
}

// ---------- styles inside a stored stack, from an older schema ----------
//
// An undo entry quotes STYLES, and a style's schema has moved: the flat
// `outline`/`outlineWidth`/`shadow{on,...}` era became `strokes[]`/`shadows[]`,
// and `gradient`/`pattern`/`fillOpacity`/`blur` joined it. `normalizeStyle` is
// where every other route into the document migrates - `loadProjectPages` for
// chapter.json, `parsePresets` for the stored presets - and this file is the
// last route that did not.
//
// Two of the three kinds that carry a style were already covered by accident:
// `style` and `bulk` go through `cloneStyle` (which IS `normalizeStyle`) on the
// way onto the box. `place` and `delete` do not - they `structuredClone(e.box)`
// straight back into the page - so an entry recorded by a build before strokes
// existed put a box on the page with no `strokes`, no `gradient` and no
// `pattern` at all. `TextBox.svelte` reads `s.pattern.on` and `s.gradient.on`
// unguarded, because every style that reaches it has been normalised; that box
// threw on render, taking the canvas with it. Undo of an old deletion was a
// crash, not a degradation.
//
// Done here, at the one place the document is parsed, rather than at the apply:
// the rescale below reads the same styles (`rescaleStyle` scales `strokes[].width`
// and knows nothing of `outlineWidth`), so a stack migrated only on its way to a
// box would still be rescaled in the old shape and lose its outline's width.
//
// Identity-preserving on purpose. An entry that is already current is handed
// back as the very object that came in, so a document that needed nothing is
// `===` the one parsed - which is what `rescaleStoredHistory` tests to decide
// whether the file is worth rewriting, and what keeps `sameStack`'s per-entry
// identity check meaning "somebody edited this page" rather than "this page was
// loaded".
const isCurrentStyle = (s) =>
  !!s &&
  typeof s === 'object' &&
  Array.isArray(s.strokes) &&
  Array.isArray(s.shadows) &&
  !!s.gradient &&
  typeof s.gradient === 'object' &&
  !!s.pattern &&
  typeof s.pattern === 'object' &&
  s.outline === undefined &&
  s.outlineWidth === undefined &&
  s.shadow === undefined;

// Whether this value is a style that has to be moved forward. A non-object is
// not a style and is left alone - `text` entries hold strings in `before`/
// `after`, and `move`/`resize` hold a subset of x/y/w/h/size, which normalising
// would inflate into a whole style and then apply field by field onto the box.
const stale = (s) => !!s && typeof s === 'object' && !isCurrentStyle(s);

// `plain`: the chapter was laid out under the old chapter-wide plain switch, and
// its boxes open with the plain wrap as their own (`openTypesetting` in
// data.js). So does every box and box style its stacks put back - a style
// recorded then holds the shaped breaker's fields the switch kept from acting,
// and an undo of an unrelated colour change would otherwise re-break the
// box's lines. `lastStyle` is not a box's, and is left as recorded.
export function migrateEntry(e, plain = false) {
  if (!e || typeof e !== 'object') return e;
  let out = e;
  const put = (k, v) => {
    if (out === e) out = { ...e };
    out[k] = v;
  };
  // A box's style moved forward: to this build's schema, and to the plain wrap
  // when the chapter's was. The very object when neither applies.
  const forward = (s) => {
    const cur = stale(s) ? normalizeStyle(s) : s;
    return plain ? plainStyle(cur) : cur;
  };
  const forwardBox = (b) => {
    if (!b || typeof b !== 'object') return b;
    const style = forward(b.style);
    return style === b.style ? b : { ...b, style };
  };

  // `place` / `delete`: a whole box, restored verbatim. The one that crashed.
  const box = forwardBox(e.box);
  if (box !== e.box) put('box', box);
  // `style`: the pair IS a pair of styles. Only for this kind - see `stale`.
  if (e.t === 'style') {
    const before = forward(e.before);
    const after = forward(e.after);
    if (before !== e.before) put('before', before);
    if (after !== e.after) put('after', after);
  }
  // `bulk`: one style pair per box it touched, plus the `lastStyle` pair that
  // rides along with a template apply (absent on every entry written before it
  // existed, which is exactly what `apply` already checks for). `placeMany`:
  // one whole box per item, as `place`.
  if (stale(e.lastStyleBefore)) put('lastStyleBefore', normalizeStyle(e.lastStyleBefore));
  if (stale(e.lastStyleAfter)) put('lastStyleAfter', normalizeStyle(e.lastStyleAfter));
  if (Array.isArray(e.items)) {
    let moved = false;
    const items = e.items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const next =
        e.t === 'bulk'
          ? { before: forward(it.before), after: forward(it.after) }
          : { box: forwardBox(it.box) };
      if (Object.keys(next).every((k) => next[k] === it[k])) return it;
      moved = true;
      return { ...it, ...next };
    });
    if (moved) put('items', items);
  }
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function migrateDoc(doc, plain = false) {
  if (!doc || doc.version !== 1 || !doc.pages) return doc;
  const pages = {};
  let touched = false;
  for (const [key, stack] of Object.entries(doc.pages)) {
    const undo = (stack?.undo ?? []).map((e) => migrateEntry(e, plain));
    const redo = (stack?.redo ?? []).map((e) => migrateEntry(e, plain));
    if (sameList(undo, stack?.undo ?? []) && sameList(redo, stack?.redo ?? [])) {
      pages[key] = stack;
      continue;
    }
    pages[key] = { undo, redo };
    touched = true;
  }
  return touched ? { ...doc, pages } : doc;
}

// ---------- a page's coordinate space changing under a stored stack ----------
//
// An undo entry is geometry, in the page's coordinates, exactly like the boxes
// in chapter.json - the whole point of a command record is that it can put a
// rectangle back where it was. So when a page's art is replaced at another
// resolution and the record is moved into the new space, this file has to move
// with it. Left behind, the chapter looks right until the first press of undo,
// which throws a box back to where it sat under the previous raster - and the
// larger the resolution change, the further off-page it lands.
//
// Rescaled rather than discarded, because discarding is the answer that costs
// the user something real (the last five edits on every page of the chapter) for
// a problem that has an exact solution. The one thing that cannot be moved is an
// entry this build does not recognise, and those are dropped on load anyway.
//
// Every kind in history.svelte.js, and what is quoted in page coordinates in it:
//
//   place / delete   `box` - a whole box, rectangle, fit and style.
//   move / resize    `before` / `after` - a subset of x/y/w/h plus `size`, which
//                    lives on the style and is carried flat here (`setFields`).
//   placeMany        `items[].box` - whole boxes, as `place`.
//   style / bulk     `before` / `after` are STYLES, and `geomBefore`/`geomAfter`
//                    are the geometry the fit left the box at (`fitGeom`: the
//                    rectangle, the size and the solver record - { y, h } in
//                    entries written before that).
//   text             `before` / `after` are strings; only the geometry pair moves.
//   line             the geometry pair of every box the edit re-sized, in `boxes`.
//   refit            the geometry pair, with the balloon fit in each.
//
// A geometry pair's solver record keeps its stamp as recorded: the stamp is a
// fingerprint of the whole box, which an entry does not hold, so a status it
// describes stops counting once the rescaled box is put back - the flag it
// raised goes quiet, and the next edit's solve raises it again if it still
// applies.
//
// A field that is not there is not invented: entries outlive the build that
// wrote them, and half of these are optional by design.
const scaleGeom = (g, sx, sy) => {
  if (!g || typeof g !== 'object') return g;
  const out = { ...g };
  const s = lengthScale(sx, sy);
  if (Number.isFinite(out.x)) out.x *= sx;
  if (Number.isFinite(out.y)) out.y *= sy;
  if (Number.isFinite(out.w)) out.w *= sx;
  if (Number.isFinite(out.h)) out.h *= sy;
  // The one style field a geometry entry carries flat - a resize changes the
  // type size along with the rectangle. A length, so it takes the same factor
  // `rescaleStyle` gives every other length.
  if (Number.isFinite(out.size)) out.size *= s;
  if (out.auto) out.auto = rescaleAuto(out.auto, sx, sy);
  if (out.fit) out.fit = scaleFit(out.fit, sx, sy);
  if (out.ink && typeof out.ink === 'object' && Array.isArray(out.ink.strokes)) {
    out.ink = {
      ...out.ink,
      strokes: out.ink.strokes.map((k) => scaleStroke(k, sx, sy)),
    };
  }
  return out;
};


// Through `rescalePageGeometry` on a one-box stand-in page rather than a second
// copy of the same arithmetic: a recorded box and a live box are the same shape,
// and the day one of them learns a new page-coordinate field the other must not
// be left behind.
const scaleRecordedBox = (b, sx, sy) => {
  if (!b || typeof b !== 'object') return b;
  const copy = structuredClone(b);
  rescalePageGeometry({ boxes: [copy] }, sx, sy);
  return copy;
};

export function rescaleEntry(entry, sx, sy) {
  if (!entry || typeof entry !== 'object') return entry;
  const e = { ...entry };
  if (e.box) e.box = scaleRecordedBox(e.box, sx, sy);
  if (e.t === 'move' || e.t === 'resize') {
    e.before = scaleGeom(e.before, sx, sy);
    e.after = scaleGeom(e.after, sx, sy);
  } else if (e.t === 'style') {
    e.before = rescaleStyle(e.before, sx, sy);
    e.after = rescaleStyle(e.after, sx, sy);
  }
  if (e.geomBefore) e.geomBefore = scaleGeom(e.geomBefore, sx, sy);
  if (e.geomAfter) e.geomAfter = scaleGeom(e.geomAfter, sx, sy);
  if (Array.isArray(e.boxes)) {
    e.boxes = e.boxes.map((g) => ({
      ...g,
      geomBefore: scaleGeom(g.geomBefore, sx, sy),
      geomAfter: scaleGeom(g.geomAfter, sx, sy),
    }));
  }
  // Two shapes of item: a bulk's (styles and geometry pairs) and a batch
  // placement's (a whole box). Only the fields an item has are scaled, so
  // neither grows the other's keys.
  if (Array.isArray(e.items)) {
    e.items = e.items.map((it) => {
      const out = { ...it };
      if (it.box) out.box = scaleRecordedBox(it.box, sx, sy);
      if (it.before) out.before = rescaleStyle(it.before, sx, sy);
      if (it.after) out.after = rescaleStyle(it.after, sx, sy);
      if (it.geomBefore) out.geomBefore = scaleGeom(it.geomBefore, sx, sy);
      if (it.geomAfter) out.geomAfter = scaleGeom(it.geomAfter, sx, sy);
      return out;
    });
  }
  // The style every later box is born with, which a bulk entry walks back and
  // forth with its boxes: in the new space too, or an undo after the rescale
  // would hand every new box the old space's sizes.
  if (e.lastStyleBefore) e.lastStyleBefore = rescaleStyle(e.lastStyleBefore, sx, sy);
  if (e.lastStyleAfter) e.lastStyleAfter = rescaleStyle(e.lastStyleAfter, sx, sy);
  return e;
}

// One whole document. `scales` is `[{ pageId, sx, sy }]` - only the pages whose
// space actually changed, so a chapter where one page was re-cleaned leaves the
// other two hundred stacks byte-identical.
export function rescaleDoc(doc, scales) {
  if (!doc || doc.version !== 1 || !doc.pages) return doc;
  const pages = { ...doc.pages };
  let touched = false;
  for (const { pageId, sx, sy } of scales ?? []) {
    const key = String(pageId);
    const stack = pages[key];
    if (!stack || !Number.isFinite(sx) || !Number.isFinite(sy) || (sx === 1 && sy === 1)) continue;
    pages[key] = {
      undo: (stack.undo ?? []).map((e) => rescaleEntry(e, sx, sy)),
      redo: (stack.redo ?? []).map((e) => rescaleEntry(e, sx, sy)),
    };
    touched = true;
  }
  return touched ? { ...doc, pages } : doc;
}

// The disk half, for the closed-chapter source edits in library.svelte.js. Safe
// to do behind this module's back precisely because the chapter is closed: `dir`
// is null, nothing is scheduled, and there is no in-memory document that could
// land on top of this write afterwards.
//
// A chapter with no history file has nothing to move and writes nothing - the
// same promise `flushHistory` keeps, that a chapter nobody has edited leaves no
// `logs/` behind.
export async function rescaleStoredHistory(chapterDir, scales) {
  if (!chapterDir || !scales?.length) return false;
  const { file } = await pathsFor(chapterDir);
  if (!(await fsx.exists(file))) return false;
  let parsed;
  try {
    parsed = JSON.parse(await fsx.readTextFile(file));
  } catch {
    // Unreadable is not repaired here. It costs undo and nothing else, and the
    // next write from an open chapter replaces it.
    return false;
  }
  // Migrated before it is rescaled, not after: `rescaleStyle` scales
  // `strokes[].width` and has never heard of `outlineWidth`, so an old entry
  // moved first keeps its outline and one moved second would lose the width.
  const next = rescaleDoc(migrateDoc(parsed), scales);
  if (next === parsed) return false;
  await fsx.writeTextFileAtomic(file, JSON.stringify(next));
  return true;
}

let dir = null;
let doc = emptyDoc();
// Which visit to a chapter is in force. Bumped every time a chapter is
// installed or torn down, and captured by anything that has to survive an
// await - because `dir` cannot answer the question those callers are actually
// asking. Two visits to the SAME chapter are two sessions and share a path, so
// a close comparing paths found its own path still in place after a reopen had
// landed underneath it and tore the new session down: stack wiped, `dir`
// nulled, and every later write returning early for the rest of the session.
let session = 0;
let saveT = null;
let told = false;
// The id of the page whose stack is live in memory. Every write merges it in
// first, so an edit reaches disk on its own debounce rather than waiting for a
// page switch that may never come.
let livePageId = null;
// True once this chapter has a history file to keep up to date - one found when
// it was opened, or one this session has written. Until then an empty document
// is not worth writing: a chapter the user opened, looked at and left has to
// leave nothing behind to explain, and this is the whole reason `logs/` is
// created on the way to a write rather than on the way in. Once there IS a
// file, an empty document is written like any other, or a history the user has
// undone their way out of would never actually clear.
let onDisk = false;

setHistorySink((pageId) => {
  livePageId = pageId;
  schedule();
});

// The off-screen write. Deliberately the only path that can add to a page other
// than the live one, and deliberately unable to move `livePageId`: that is the
// difference between filing one entry against page B and handing page A's whole
// stack to page B's key, which is what happened while `record` had nowhere else
// to put such an entry.
//
// Refused in two cases, both of which mean "there is no stored stack for this",
// and both of which leave the entry on the live stack where it has always been:
// no chapter open (nothing to merge into, and `flushHistory` would drop it), and
// no live page claimed - the test seam and the moment before a chapter's first
// page is loaded, where the module cannot say which page the stack in memory
// belongs to and must not guess.
setOffscreenSink((pageId, entry) => {
  if (!dir || livePageId == null || pageId === livePageId) return false;
  doc = appendEntry(doc, pageId, entry);
  schedule();
  return true;
});

// The off-screen correction: a fit that landed for a box on a page other than
// the live one, whose edit is in that page's stored stack (see "a fit owed to
// an entry" in history.svelte.js). Refused in the same two cases as the write
// above, and for the same reasons; the live stack is then the caller's to
// correct. The stored entries are not touched in place: the correction is made
// on a copy of the list and merged like any other change.
setOffscreenAmender((pageId, amend) => {
  if (!dir || livePageId == null || pageId === livePageId) return false;
  const cur = stackFrom(doc, pageId);
  const undo = cur.undo.slice();
  if (amend(undo)) {
    doc = mergeStack(doc, pageId, { undo, redo: cur.redo });
    schedule();
  }
  return true;
});

// Test seam. The app reaches this through openHistory, and this has to leave the
// module in the same state that would: a leftover live page id or a pending
// debounce from the previous chapter would file one chapter's entries into
// another's document.
export function __setDir(d) {
  clearTimeout(saveT);
  dir = d;
  doc = emptyDoc();
  told = false;
  livePageId = null;
  onDisk = false;
  // Including the session, or this seam would not stand in for an open at all:
  // what an open installs is a new session, and that is the whole of what tells
  // a close still in flight that the chapter it was tearing down is gone.
  session++;
}

// Takes the directory rather than reading `dir`, because every caller has
// already bound the chapter it is working for and `dir` can change under an
// await.
async function pathsFor(base) {
  const logs = await fsx.join(base, 'logs');
  return { logs, file: await fsx.join(logs, 'history.json') };
}

// Said once per chapter. A disk that refuses this file refuses it on every
// keystroke, and one lost convenience is not worth a toast a second.
function complainOnce(e) {
  if (told) return;
  told = true;
  toastError(`Undo history is not being saved - ${e?.message ?? e}`);
}

// `plain`: the chapter was laid out plain - see `migrateEntry`.
export async function openHistory(chapterDir, pageId, { plain = false } = {}) {
  // Whatever chapter is open has a document nobody else will write, and
  // everything below resets it. Flushed first, so a chapter left inside the
  // debounce window does not lose its records - a page turn is not the only
  // thing that can end a chapter, and this module cannot rely on the caller
  // having closed the old one first.
  //
  // Not conditional on the chapter changing: a route re-entry into the chapter
  // already open lands here too, and it would drop the last 800ms of records
  // along with any page merged into `doc` but not yet written.
  if (dir) await flushHistory();
  clearTimeout(saveT);
  dir = chapterDir;
  doc = emptyDoc();
  told = false;
  livePageId = pageId;
  onDisk = false;
  resetHistory();
  // The session this open installs, claimed in the same synchronous breath as
  // `dir` so that two opens are ordered by the assignment that installed them:
  // the slower read then finds a session that is no longer its own and drops
  // what it read, rather than landing its document and its page's stack on top
  // of the newer chapter's.
  const mine = ++session;
  if (!dir) return;
  let loaded = emptyDoc();
  // A file that is there is one to keep up to date from here on, whatever was
  // in it - a corrupt one included, since the next write is what repairs it.
  let found = false;
  try {
    // The argument rather than `dir`, which can change under every await below.
    const { file } = await pathsFor(chapterDir);
    if (await fsx.exists(file)) {
      found = true;
      const parsed = JSON.parse(await fsx.readTextFile(file));
      // The one place the stored document is parsed, and so the one place its
      // entries are moved forward to this build's style schema - see
      // `migrateEntry`. Before the graft below, because what is grafted onto it
      // is this session's own records, which are current by construction.
      if (parsed && parsed.version === 1 && parsed.pages) loaded = migrateDoc(parsed, plain);
    }
  } catch {
    // A corrupt or unreadable history file costs undo and nothing else. It is
    // replaced by the next write.
    loaded = emptyDoc();
  }
  // Not `dir !== chapterDir`: a close and a reopen of this very chapter, both
  // landing while the read was in flight, leave the same path in place while
  // everything the read was for has been thrown away and replaced.
  if (session !== mine) return;
  // Nothing above waited on the user. A page turn, an off-screen record, an
  // edit on this very page - all of them can have happened while the disk was
  // answering, and all of them are NEWER than what it answered with. So the
  // read lands underneath what is already here rather than over the top of it:
  // assigning `doc = loaded` was how a page turned during a chapter's load lost
  // the entries it had made, and how the stack of the page the open was started
  // for arrived on top of the page the user had moved to.
  const pages = { ...loaded.pages };
  for (const [key, live] of Object.entries(doc.pages ?? {})) {
    pages[key] = graft(stackFrom(loaded, key), live);
  }
  doc = { version: 1, pages };
  if (found) onDisk = true;
  // The page on screen NOW, which is not necessarily the one this open was
  // called for. Whatever is in there is replayed optimistically: an entry that
  // no longer fits the document is reported and dropped by history.svelte.js at
  // the moment it is pressed, not weeded out here - validating a stack against
  // a document would cost a walk of every page to save a message nobody may
  // see.
  loadStack(livePageId, graft(stackFrom(doc, livePageId), peekStack()));
}

// Whether handing a page's stack back has actually changed the document.
//
// Identity per entry, not a deep compare, and that is the whole trick: the
// entries on the live stack came OUT of `doc` through `loadStack`, which filters
// but does not copy, so a page that was turned to and away from without an edit
// hands back the very objects it was given. Anything that made a record replaced
// or appended an object and fails the check at once.
//
// A stack that filtered something out on the way in - an entry of a kind this
// build cannot apply - also fails it, and should: the document is then holding a
// record that will never come back, and the write that drops it is the point.
function sameStack(a, b) {
  const eq = (x, y) => x.length === y.length && x.every((e, i) => e === y[i]);
  return eq(a.undo, b.undo) && eq(a.redo, b.redo);
}

export async function switchHistoryPage(fromPageId, toPageId) {
  // The caller need not know which page's stack is live; this module already
  // does. A caller that passes the wrong `from` would otherwise file one page's
  // entries under another page's key, where they would fail on the first press.
  const from = fromPageId ?? livePageId;
  // A page turn is not an edit. Reading through a chapter used to schedule a
  // full serialise-and-write of the history document on every single turn -
  // `JSON.stringify` of every page's stack, an atomic file write - to store back
  // exactly the bytes already there. So the merge and the write happen only when
  // the page being left actually has something new to say.
  let dirty = false;
  if (from != null) {
    const taken = takeStack();
    dirty = !sameStack(stackFrom(doc, from), taken);
    if (dirty) doc = mergeStack(doc, from, taken);
  }
  loadStack(toPageId, stackFrom(doc, toPageId));
  livePageId = toPageId;
  if (dirty) schedule();
}

// The same interval the document's own autosave uses, and the same constant
// rather than the same number written twice - the two describe one document, and
// a history file written on a different beat than the pages it addresses is the
// one way they can reach disk disagreeing about how many edits have happened.
// Its own timer all the same: the two never wait on each other, so a page turn
// is not held up by this write, and this write failing is not the document's
// problem.
function schedule() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    flushHistory();
  }, DOC_SAVE_MS);
}

// Writes are serialised. A debounce that has just fired and a close that flushes
// on the way out can both be in flight, each carrying its own snapshot of the
// document - and without a queue the older snapshot can land last and take the
// newer one's records with it.
let writing = Promise.resolve();

export async function flushHistory() {
  clearTimeout(saveT);
  // Bound before the first await, and nothing below reads module state again.
  // Every await here is a window in which the user can close this chapter or
  // open another; read live, `dir` would name the chapter now in force and
  // `doc` would be its document, and the two halves of the write would come
  // from different chapters. saveOpenChapter and scanLibrary each document the
  // same trap at length.
  const mine = dir;
  if (!mine) return;
  // The live page's stack is only in memory until this point.
  if (livePageId != null) doc = mergeStack(doc, livePageId, peekStack());
  // Nothing to say, and nothing on disk saying otherwise: a chapter opened,
  // read and left leaves no `logs/` directory and no file behind.
  if (!Object.keys(doc.pages ?? {}).length && !onDisk) return;
  const body = JSON.stringify(doc);
  // Claimed here rather than after the write lands, so a flush queued behind
  // this one cannot decide there is no file to clear while this one is still
  // creating it. A write that then fails is reported, and the next attempt
  // writes the same document again.
  onDisk = true;
  const done = writing.then(() => write(mine, body));
  writing = done;
  await done;
}

// Both halves of the write are arguments, so nothing here can be overtaken by a
// chapter opened underneath it: the path names the chapter this write was
// started for and the body is the document that chapter had at that moment.
// That is why there is no re-check of `dir` between the awaits - abandoning
// would not protect any state, it would only throw away a correct write. What
// the checks would have enforced is enforced at the source instead: every path
// that moves `dir` - openHistory and closeHistory - flushes first.
async function write(mine, body) {
  try {
    const { logs, file } = await pathsFor(mine);
    // Created on the way to the first write, never up front: a chapter nobody
    // has edited has no logs directory to explain.
    await fsx.mkdir(logs);
    await fsx.writeTextFileAtomic(file, body);
  } catch (e) {
    // Every failure ends here. This promise is the queue, so it must resolve
    // whatever the disk did, or one bad write would strand every later one.
    complainOnce(e);
  }
}

export async function closeHistory(pageId) {
  // Same as switchHistoryPage: the caller need not name the page. Guarding the
  // merge on the argument alone and then resetting regardless would silently
  // throw the live stack away.
  const pid = pageId ?? livePageId;
  if (pid != null) doc = mergeStack(doc, pid, takeStack());
  livePageId = null;
  // Bound before the await, like everything else here that survives one. This
  // is called fire-and-forget by closeChapter, so a chapter can be opened while
  // the flush is still in flight: `openHistory` would finish first and this
  // would then wipe its document, its stack and its `dir` - and with `dir` null
  // every later flush returns early, so that chapter's undo would silently
  // never reach disk again. A close whose chapter has already been replaced has
  // nothing left to tear down; the flush above has already written it.
  //
  // The session and not the path, because the case that matters most is the one
  // a path cannot see: closing a chapter and going straight back into it - the
  // reader's own back button - installs a NEW session on the same directory. On
  // `dir !== mine` that read as "nothing happened here" and the teardown ran
  // over the top of the session the user was now in.
  const mine = session;
  await flushHistory();
  if (session !== mine) return;
  // Torn down, and the session with it: an `openHistory` still waiting on its
  // read belongs to the chapter this just closed, and must not land its
  // document on a module that no longer has one.
  session++;
  dir = null;
  doc = emptyDoc();
  onDisk = false;
  resetHistory();
}
