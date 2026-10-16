// ===== Bounded undo/redo =====
// Five steps, per page, as command records rather than document snapshots: an
// entry is plain data describing one edit and its inverse, so it costs tens of
// bytes and serialises to JSON without ceremony. Only the page on screen keeps
// its stack in memory; every other page's lives in the chapter's history file.
import {
  app,
  pageById,
  markUnsaved,
  toast,
  toastError,
  selectBox,
  setRecorder,
  cloneStyle,
  settleEdits,
  setBoxText,
  refitBox,
  reviewBox,
  solvePending,
  markSelectedSize,
  fitHeld,
  anyFitHeld,
  dropHeldFit,
  payHeldFit,
  setFitLander,
} from '../store.svelte.js';

// About thirty steps a page (UND-1). Entries are deltas of tens of bytes, the
// live stack is one page's, and the rest spill to `logs/history.json`, so the
// depth costs disk, not RAM.
export const MAX_STEPS = 30;

export const history = $state({ canUndo: false, canRedo: false, pageId: null });

let undoStack = [];
let redoStack = [];
// While a step is being walked the store's mutations must not be recorded - an
// undo is not an edit. This is the only guard there is, so it has to stay
// raised for the whole of `step`, not just the apply.
let applying = false;

function sync() {
  history.canUndo = undoStack.length > 0;
  history.canRedo = redoStack.length > 0;
}

const boxOf = (entry) => {
  const p = pageById(entry.pageId);
  if (!p) return null;
  return p.boxes.find((b) => b.id === entry.boxId) ?? null;
};

// Why a box can be missing decides what the user is told, so both cases are
// asked about rather than reported as one.
const missing = (e) => new Error(pageById(e.pageId) ? 'the text box is gone' : 'the page is gone');

// A place advances the queue and a delete hands the line back, so both records
// carry the queue's position on either side of the edit. A record written
// before the field existed simply leaves the queue alone.
const setActive = (p, n) => {
  if (n !== undefined) p.activeLineN = n;
};

// Geometry entries carry only the fields that changed. `size` lives on the
// style rather than the box, and a resize changes it alongside w/h.
// Inked boxes carry their scaled strokes in ink. A refit carries the balloon
// fit, and a box the solver manages its record (`auto`), both copied out whole
// so the box never shares an object with the entry.
const setFields = (b, from) => {
  for (const k of Object.keys(from)) {
    if (k === 'size') b.style.size = from.size;
    else if (k === 'autoHeight') b.style.autoHeight = from.autoHeight;
    else if (k === 'ink') b.style.ink = structuredClone(from.ink);
    else if (k === 'fit') b.fit = from.fit ? structuredClone(from.fit) : null;
    else if (k === 'outline') {
      if (from.outline) b.outline = structuredClone(from.outline);
      else delete b.outline;
    }
    else if (k === 'auto') {
      if (from.auto) b.auto = structuredClone(from.auto);
      else delete b.auto;
    }
    else if (k === 'colours') {
      b.style.color = from.colours.color;
      from.colours.strokes.forEach((c, i) => {
        if (b.style.strokes[i]) b.style.strokes[i].color = c;
      });
      b.style.autoContrast = from.colours.auto;
    }
    else b[k] = from[k];
  }
};


// The height an edit's auto-fit left the box at, on either side of it. Carried
// by every kind whose edit can change what the box has to fit - `style`, `text`,
// `bulk` - because the fit is grow-only, so re-deriving it on the way back can
// never give the height back: an Inspector size change from 20 to 48 grew a
// three-line box from 80 to 320 and an undo left it 320 tall around 20pt text,
// with no step that could recover it. Worse with `autoHeight`, where the undo
// restores the flag to false and the re-derivation does not even run.
//
// A missing pair is not an error. Entries persist to disk and outlive the build
// that wrote them, and a caller that changed a style without measuring anything
// (the rotate drag) has no geometry to offer; both mean "nobody recorded a
// height here", and re-deriving one is what this code did for every entry until
// now - safe, because grow-only cannot make a box too small for its text. It is
// the grow-only fit (`refitBox`), not the ladder: a step through the history is
// not an edit, and a ladder here could shrink a font no entry accounts for.
//
// A pair written before the fit could move anything but `y`/`h` puts back just
// those two, which is all that build's fit could have changed.
//
// Either way the containment flag is brought up to date for the box as it now
// stands, so an undo never leaves a flag describing the geometry it undid.
const restoreFit = (b, e, dir, p) => {
  const g = dir === 'undo' ? e.geomBefore : e.geomAfter;
  if (g) {
    setFields(b, g);
    reviewBox(b, p);
  } else refitBox(b, p);
};

// The flag of every box a step put back into the document. A box comes back
// from its snapshot with the flag it had then; the page around it - its line's
// text, a font - may have moved on since. A box that comes back still waiting
// for its face may find the face arrived while it was gone, with no font event
// left to solve it, so it is solved here (`solvePending`).
const recheck = (p, boxes) => {
  const back = boxes.map((snap) => p.boxes.find((x) => x.id === snap.id)).filter(Boolean);
  solvePending(p, back);
  for (const b of back) reviewBox(b, p);
};

// Every command type, and how to walk it in each direction. `apply` throws a
// plain Error when the document no longer matches; the caller turns that into
// a message and drops the entry.
// A free-typed box brings a queue line into existence with it and takes that
// line away again when it is deleted (see `addEmptyBox` and `deleteBox`), so the
// two have to move together in the history as well - otherwise an undo leaves
// either a box rendering nothing or an unplaceable blank row nothing can remove.
// `e.line` is carried only by entries about such a box; every entry about a
// queue-placed box has none, and these are no-ops for it.
//
// Both halves ask whether the line is there rather than asserting it: the
// history is bounded (`MAX_STEPS`) and shares a page with edits it did not
// record, so a line that is already back (or already gone) is a document that
// agrees with where this entry is trying to take it, not a failure to report.
const dropLine = (p, e) => {
  if (!e.line) return;
  p.lines = p.lines.filter((l) => l.n !== e.line.n);
};
const restoreLine = (p, e) => {
  if (!e.line || p.lines.some((l) => l.n === e.line.n)) return;
  p.lines.splice(Math.min(e.lineIndex ?? p.lines.length, p.lines.length), 0, structuredClone(e.line));
};

const KINDS = {
  place: {
    label: 'that placement',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        const i = p.boxes.findIndex((b) => b.id === e.box.id);
        if (i === -1) throw new Error('the text box is gone');
        p.boxes.splice(i, 1);
        dropLine(p, e);
        if (e.box.lineN != null && e.box.lineN > 0) {
          const ln = p.lines.find((l) => l.n === e.box.lineN);
          if (ln) ln.placed = false;
        }
        setActive(p, e.activeBefore);
      } else {
        if (p.boxes.some((b) => b.id === e.box.id)) throw new Error('the text box is back already');
        restoreLine(p, e);
        if (e.box.lineN != null && e.box.lineN > 0) {
          const ln = p.lines.find((l) => l.n === e.box.lineN);
          if (ln) ln.placed = true;
        }
        p.boxes.splice(Math.min(e.index, p.boxes.length), 0, structuredClone(e.box));
        recheck(p, [e.box]);
        setActive(p, e.activeAfter);
      }
    },
  },
  placeMany: {
    label: 'that batch placement',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        for (let idx = e.items.length - 1; idx >= 0; idx--) {
          const item = e.items[idx];
          const i = p.boxes.findIndex((b) => b.id === item.box.id);
          if (i === -1) throw new Error('the text box is gone');
          p.boxes.splice(i, 1);
          if (item.box.lineN != null) {
            const ln = p.lines?.find((l) => l.n === item.box.lineN);
            if (ln) ln.placed = false;
          }
        }
        setActive(p, e.activeBefore);
      } else {
        for (const item of e.items) {
          if (p.boxes.some((b) => b.id === item.box.id)) throw new Error('the text box is back already');
          if (item.box.lineN != null) {
            const ln = p.lines?.find((l) => l.n === item.box.lineN);
            if (ln) ln.placed = true;
          }
          p.boxes.splice(Math.min(item.index, p.boxes.length), 0, structuredClone(item.box));
        }
        recheck(p, e.items.map((item) => item.box));
        setActive(p, e.activeAfter);
      }
    },
  },
  delete: {
    label: 'that deletion',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        if (p.boxes.some((b) => b.id === e.box.id)) throw new Error('the text box is back already');
        // The line first, so the box is never in the document for a tick with
        // nothing behind it - and because the box's text lives on that line, a
        // box restored without it renders empty.
        restoreLine(p, e);
        // `index` is what puts the box back where it sat in the stacking order
        // rather than on top of everything drawn since.
        p.boxes.splice(Math.min(e.index, p.boxes.length), 0, structuredClone(e.box));
        recheck(p, [e.box]);
        setActive(p, e.activeBefore);
      } else {
        const i = p.boxes.findIndex((b) => b.id === e.box.id);
        if (i === -1) throw new Error('the text box is gone');
        p.boxes.splice(i, 1);
        dropLine(p, e);
        setActive(p, e.activeAfter);
      }
    },
  },
  move: {
    label: 'that move',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      setFields(b, dir === 'undo' ? e.before : e.after);
      // A move in a paged document cannot change what fits, but the flag is
      // cheap to confirm and a longstrip box can be moved across a seam.
      reviewBox(b, pageById(e.pageId));
    },
  },
  resize: {
    label: 'that resize',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      setFields(b, dir === 'undo' ? e.before : e.after);
      reviewBox(b, pageById(e.pageId));
    },
  },
  style: {
    label: 'that style change',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      b.style = cloneStyle(dir === 'undo' ? e.before : e.after);
      // After the style, never before: the fit these two fields describe was
      // taken with that style in place, and a re-derivation triggered in between
      // would be measuring the wrong one.
      restoreFit(b, e, dir, pageById(e.pageId));
    },
  },
  // The Refit button (`refitBalloon`): the balloon fit, the rectangle, the size
  // and the solver record, all inside the two geometry records.
  refit: {
    label: 'that refit',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      restoreFit(b, e, dir, pageById(e.pageId));
    },
  },
  // Outlines approved (`approveOutline`, `approvePageOutlines`): each box's
  // outline record as it was on either side, null for none. Nothing is laid
  // out again; approval changes no geometry.
  outlines: {
    label: 'that approval',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      let hit = 0;
      for (const item of e.items ?? []) {
        const b = p.boxes.find((x) => x.id === item.boxId);
        if (!b) continue;
        const g = dir === 'undo' ? item.before : item.after;
        if (g) b.outline = structuredClone(g);
        else delete b.outline;
        hit++;
      }
      if (!hit) throw new Error(e.items?.length > 1 ? 'those text boxes are gone' : 'the text box is gone');
    },
  },
  // A lock set or let go (`setBoxLocks`): the locks and the reference size of
  // each box, exactly as they were on either side. Nothing is laid out again,
  // because the command itself lays nothing out - putting back the locks is
  // the whole of the edit.
  locks: {
    label: 'that lock change',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      let hit = 0;
      for (const item of e.items ?? []) {
        const b = p.boxes.find((x) => x.id === item.boxId);
        if (!b?.auto) continue;
        const g = dir === 'undo' ? item.before : item.after;
        b.auto.locks = { ...g.locks };
        if (g.refSize > 0) b.auto.refSize = g.refSize;
        hit++;
      }
      if (!hit) throw new Error(e.items?.length > 1 ? 'those text boxes are gone' : 'the text box is gone');
    },
  },
  text: {
    label: 'that text edit',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      // Through the store, because which field a box's text lives in is the
      // store's rule and there are two answers: a free-typed box's text is on
      // its line, everything else's is on the box. Written straight to `b.text`
      // here, an undo of a free box's edit would leave the old text as a box-
      // level override *over* the new text still standing on the line - the box
      // and its queue row saying different things, with no gesture that could
      // put them back in step.
      const p = pageById(e.pageId);
      // Without its fit: what the box's geometry was on this side of the edit is
      // recorded, not derived, and a fit run first - a ladder that can widen the
      // box and shrink its font - would only be written over by the record, or,
      // for a record older than the ladder that carries y/h alone, survive it.
      setBoxText(b, dir === 'undo' ? e.before : e.after, p, { fit: false });
      restoreFit(b, e, dir, p);
    },
  },
  // A queue line's translation, edited in the Queue panel's textarea. Its own
  // kind rather than `text` because the edit belongs to the LINE - there may
  // be no box at all, or one box reading the line, and `text`'s contract
  // (setBoxText on a box) writes a box-level override that would freeze the
  // box against its own line forever. Every box bound to the line refits, for
  // the same reason `setBoxText` fits as it writes.
  line: {
    label: 'that translation edit',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      const ln = p.lines.find((l) => l.n === e.lineN);
      if (!ln) throw new Error('the queue line is gone');
      ln.en = dir === 'undo' ? e.before : e.after;
      // A writer that recorded the bound boxes' geometry on both sides of the
      // edit (`boxes: [{ boxId, geomBefore, geomAfter }]`) gets it put back, as
      // the `text` kind does. One that did not - every entry written so far -
      // gets the grow-only refit this kind always had, and the flag.
      const recorded = new Map((e.boxes ?? []).map((g) => [g.boxId, g]));
      for (const b of p.boxes) {
        if (b.lineN !== e.lineN) continue;
        const g = recorded.get(b.id);
        if (g) restoreFit(b, g, dir, p);
        else refitBox(b, p);
      }
    },
  },
  bulk: {
    label: 'that bulk style',
    apply(e, dir) {
      // One entry, one page - and the page is the entry's, not the item's. An
      // entry that reached across pages could only ever live on one stack, so
      // undoing it from there mutated boxes on a page that was keeping its own
      // stack meanwhile: that page's `before`/`after` still described the
      // pre-mutation world, and its next undo restored a style it had not been
      // in since. A chapter-wide tag apply is split by the writer into one entry
      // per page instead (`applyBulkToTag`), so the invariant this reads for is
      // established at the source.
      //
      // Stated here rather than merely relied on: an item naming another page is
      // a writer that has regressed, and skipping it is what makes that show up
      // as a bulk that undid less than it should rather than as a desync on a
      // page the user is not even looking at. The item's own `pageId` stays on
      // the record because that is what lets the writer group by page, and
      // because a record is worth more when it describes what it changed.
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      let hit = 0;
      for (const item of e.items) {
        if (item.pageId != null && item.pageId !== e.pageId) continue;
        const b = p.boxes.find((x) => x.id === item.boxId);
        if (!b) continue;
        b.style = cloneStyle(dir === 'undo' ? item.before : item.after);
        // Per item, because one entry covers many boxes and they grew by
        // different amounts - same reasoning as the `style` kind above.
        restoreFit(b, item, dir, p);
        hit++;
      }
      // A bulk that touched five boxes is still worth undoing when one has
      // since been deleted; it is only a failure when none of them are left.
      if (!hit) throw new Error('those text boxes are gone');
      // The style every box placed after the apply inherits rode along with it
      // (`restyleForBulk` merges the ticked template half into `lastStyle`), so
      // it walks back with the boxes - an undo that restored them but left
      // `lastStyle` bulk-advanced would let every future box inherit a style no
      // step on the stack accounts for. Entries from writers that never touch
      // `lastStyle` carry no pair and leave it alone.
      if (e.lastStyleBefore && e.lastStyleAfter) {
        app.lastStyle = cloneStyle(dir === 'undo' ? e.lastStyleBefore : e.lastStyleAfter);
      }
    },
  },
};

// ---------- a fit owed to an entry ----------
// An entry carries its box's geometry on both sides of the edit, fit included,
// and the fit normally runs before the entry is recorded. Not always: with the
// Rust text engine measuring, a box whose face is still on its way is not
// fitted - a fit measured in a stand-in would be a number nobody chose - and
// the fit runs when the face lands (`autoFitBox`, `relayoutAll` in the store).
// The entry was recorded in between, with the box as the edit left it. Undo
// then redo put back that rectangle, 60x60 where the finished edit was 128x70.
//
// So an entry recorded while its box is held says so (`fitOwed`, the box ids),
// and three things keep it honest, none of them a step of its own:
//
//   the fit lands   the latest owing entry for the box takes the box as it now
//                   stands as its after side (`fitLanded`), and owes nothing.
//   a step is taken the box is back at the after side of the entry now on top
//                   of the undo stack for it. If that entry still owes the fit
//                   - it was undone before the face came, or it sits under a
//                   later edit that took the landing - the box is fitted here,
//                   or held again while the face is still coming, and both
//                   entries either side of that state are corrected
//                   (`settleOwed`). If it owes nothing, a fit still held for
//                   the box is dropped: it belonged to an edit no longer there.
//
// Only the kinds and boxes that have a geometry to correct are ever marked, so
// a lock change or a deletion made meanwhile cannot take the landing instead
// of the edit it belongs to. With the browser measuring nothing is ever held,
// no entry is marked, and none of this runs.

// Where an entry keeps the geometry of box `id` on one side of its edit
// ('before' | 'after'), as { get, set } over a copy of the entry - or null
// when it keeps none. A placement's after side is the placed box itself.
function geomSlot(e, id, side) {
  const key = side === 'after' ? 'geomAfter' : 'geomBefore';
  const fields = (get, set) => ({ get, set });
  if (e.t === 'move' || e.t === 'resize') {
    if (e.boxId !== id || !e[side]) return null;
    return fields(() => e[side], (g) => ({ ...e, [side]: g }));
  }
  if (e.t === 'style' || e.t === 'text' || e.t === 'refit') {
    if (e.boxId !== id || !e[key]) return null;
    return fields(() => e[key], (g) => ({ ...e, [key]: g }));
  }
  if (e.t === 'line' || e.t === 'bulk') {
    const list = e.t === 'line' ? 'boxes' : 'items';
    const i = (e[list] ?? []).findIndex((it) => it.boxId === id && it[key]);
    if (i === -1) return null;
    return fields(() => e[list][i][key], (g) => ({ ...e, [list]: e[list].map((it, j) => (j === i ? { ...it, [key]: g } : it)) }));
  }
  if (side !== 'after') return null;
  // The box as it was placed, whole: its rectangle, its size inside its style,
  // and its solver record.
  const boxed = (box, put) =>
    fields(
      () => ({ x: box.x, y: box.y, w: box.w, h: box.h, size: box.style?.size, ...(box.auto ? { auto: box.auto } : null) }),
      (g) => {
        const next = { ...box, x: g.x, y: g.y, w: g.w, h: g.h, style: { ...box.style, size: g.size } };
        if (g.auto) next.auto = g.auto;
        return put(next);
      },
    );
  if (e.t === 'place') return e.box?.id === id ? boxed(e.box, (box) => ({ ...e, box })) : null;
  if (e.t === 'placeMany') {
    const i = (e.items ?? []).findIndex((it) => it.box?.id === id);
    return i === -1 ? null : boxed(e.items[i].box, (box) => ({ ...e, items: e.items.map((it, j) => (j === i ? { ...it, box } : it)) }));
  }
  return null;
}

// Every box an entry keeps an after-side geometry for.
function boxesOf(e) {
  const ids = [e.boxId, e.box?.id, ...(e.boxes ?? []).map((g) => g.boxId), ...(e.items ?? []).map((it) => it.boxId ?? it.box?.id)];
  return [...new Set(ids.filter((id) => id != null && geomSlot(e, id, 'after')))];
}

const owes = (e, id) => Array.isArray(e.fitOwed) && e.fitOwed.includes(id);

// The entry with `geom` as its `side` for box `id`. Only the fields a fit can
// move are written, over what the entry had, so a balloon fit or ink it
// carried stays. A move or a resize carries only the fields its edit changed,
// and puts back only those: the other side is given the fit's fields too,
// from the box as it stood before the fit, so what one direction writes the
// other can take back.
function withGeom(e, id, side, geom, other) {
  const slot = geomSlot(e, id, side);
  if (!slot) return e;
  const fit = structuredClone(geom);
  let next = slot.set({ ...slot.get(), ...fit });
  if (next.t === 'move' || next.t === 'resize') {
    const far = side === 'after' ? 'before' : 'after';
    const filled = { ...next[far] };
    for (const k of Object.keys(fit)) if (!(k in filled) && other && k in other) filled[k] = structuredClone(other[k]);
    next = { ...next, [far]: filled };
  }
  return next;
}

const paid = (e, id) => {
  const left = (e.fitOwed ?? []).filter((x) => x !== id);
  const { fitOwed: _was, ...rest } = e;
  return left.length ? { ...rest, fitOwed: left } : rest;
};

// The latest entry of a stack that keeps an after side for the box.
function latestFor(stack, pageId, id) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].pageId === pageId && geomSlot(stack[i], id, 'after')) return i;
  }
  return -1;
}

// A held fit has landed (the store's `relayoutAll`). The entry it belongs to
// is the latest one about the box, when that one owes it; one that owes
// nothing was recorded with the box already fitted, and is left alone.
function fitLanded(pageId, boxId, was, now) {
  const amend = (undo) => {
    const i = latestFor(undo, pageId, boxId);
    if (i === -1 || !owes(undo[i], boxId)) return false;
    undo[i] = paid(withGeom(undo[i], boxId, 'after', now, was), boxId);
    return true;
  };
  // A page whose stack is not the live one keeps it in the history file.
  if (offscreenAmend?.(pageId, amend)) return;
  if (amend(undoStack)) sink?.(history.pageId);
}

// After a step: every box the stepped entry is about now stands at the after
// side of the entry on top of the undo stack for it. See above.
function settleOwed(entry, dir) {
  if (!anyFitHeld() && !entry.fitOwed?.length && !undoStack.some((e) => e.fitOwed?.length)) return;
  const p = pageById(entry.pageId);
  if (!p) return;
  const ids = new Set([...boxesOf(entry), ...(entry.fitOwed ?? [])]);
  for (const id of ids) {
    const b = p.boxes.find((x) => x.id === id);
    if (!b) continue;
    const i = latestFor(undoStack, entry.pageId, id);
    if (i === -1 || !owes(undoStack[i], id)) {
      dropHeldFit(b);
      continue;
    }
    const fit = payHeldFit(b, p);
    if (!fit) continue;
    undoStack[i] = paid(withGeom(undoStack[i], id, 'after', fit.now, fit.was), id);
    // The entry just undone starts from that same state.
    const top = redoStack.length - 1;
    if (dir === 'undo' && redoStack[top] === entry) redoStack[top] = withGeom(entry, id, 'before', fit.now, fit.was);
    reviewBox(b, p);
  }
}

// The history file registers itself here so a new entry can schedule its own
// write. Without it the live page's stack would only reach disk on a page
// switch, and an edit made and then abandoned would be lost on quit.
//
// Hands back a release that puts the previous sink back, for the same reason
// `setOffscreenSink` below does: a test standing in front of the real one -
// registered at the history file's module load, before any test runs - must not
// unhook it for whatever runs next.
let sink = null;
export function setHistorySink(fn) {
  const prev = sink;
  sink = fn;
  return () => {
    if (sink === fn) sink = prev;
  };
}

// The other half of the same seam, for an entry that names a page whose stack
// is not the live one - a chapter-wide tag apply's share of a page the user is
// not looking at. Pushing that onto the live stack is the desync this exists to
// prevent: the entry would rewind boxes on another page while that page kept a
// stack whose own `before`/`after` still described the world before the bulk,
// so its next undo would restore a style it had not been in since. And it must
// not go through `sink` either, which assigns the history file's `livePageId`
// - an entry naming another page would hand this page's whole stack to that
// page's key in history.json, which is the worse half of the same bug.
//
// So the file takes such an entry and merges it straight into the stored
// document under its own page's key, touching neither the live stack nor
// `livePageId`. It answers true when it has done so; false means the page named
// IS the live one, or there is no chapter file to merge into, and the live
// stack keeps the entry exactly as before.
// Hands back a release that puts the previous sink back rather than clearing the
// slot, so a test can stand in front of the real one - registered at the history
// file's module load, before any test runs - without unhooking it for whatever
// runs next.
let offscreen = null;
export function setOffscreenSink(fn) {
  const prev = offscreen;
  offscreen = fn;
  return () => {
    if (offscreen === fn) offscreen = prev;
  };
}

// The history file's half of `fitLanded`, for a page whose stack it holds: it
// is handed the function that corrects an undo stack in place, and answers
// true when the page is one of its own.
let offscreenAmend = null;
export function setOffscreenAmender(fn) {
  const prev = offscreenAmend;
  offscreenAmend = fn;
  return () => {
    if (offscreenAmend === fn) offscreenAmend = prev;
  };
}

export function record(entry) {
  if (applying) return;
  if (!KINDS[entry?.t]) return;
  // Detached at the door rather than trusting every mutation site: a record
  // that still points at something live would be rewritten by the next edit to
  // that box, and a reactive proxy would not survive the trip to disk as JSON.
  // Both halves earn their place - `snapshot` unwraps the proxies, and it hands
  // plain objects straight back, which is exactly the aliasing case.
  const flat = structuredClone($state.snapshot(entry));
  // Recorded while a box of it waits for its face to be fitted: the after side
  // is not the finished edit yet (see "a fit owed to an entry").
  if (anyFitHeld()) {
    const p = pageById(flat.pageId);
    const owed = p ? boxesOf(flat).filter((id) => fitHeld(p.boxes.find((b) => b.id === id))) : [];
    if (owed.length) flat.fitOwed = owed;
  }
  // An entry belongs to the page it names, and this is the one line that makes
  // that true of every mutation site at once rather than of the careful ones.
  // With no sink registered - a build with no history file, and every test of
  // this module alone - nothing routes and the live stack takes everything,
  // which is what it did before.
  if (flat.pageId != null && offscreen?.(flat.pageId, flat)) return;
  undoStack.push(flat);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  redoStack = [];
  history.pageId = flat.pageId;
  sync();
  sink?.(flat.pageId);
}

function step(from, to, dir) {
  const entry = from.pop();
  if (!entry) return false;
  // The guard has to cover everything the step does, not just the apply:
  // `selectBox` ends an inline edit, which settles a placement the user had in
  // progress, which records. Left outside, that record would land on the undo
  // stack mid-step and clear the redo entry this very step just pushed.
  try {
    applying = true;
    KINDS[entry.t].apply(entry, dir);
    to.push(entry);
    // Show the user what just changed. `place` and `delete` name their box
    // inside the box itself, which is why this is not just `entry.boxId`. When
    // the step was the one that took the box away, the selection has to go with
    // it - left pointing at nothing, the inspector blanks and Delete becomes a
    // no-op.
    const id = entry.boxId ?? entry.box?.id;
    if (id) {
      if (pageById(entry.pageId)?.boxes.some((b) => b.id === id)) selectBox(id, { activate: false });
      else if (app.selectedId === id) app.selectedId = null;
    }
    if (entry.t === 'placeMany') {
      if (dir === 'undo') {
        if (app.selectedId && entry.items?.some((it) => it.box?.id === app.selectedId)) {
          app.selectedId = null;
        }
      } else {
        const last = entry.items?.[entry.items.length - 1]?.box?.id;
        if (last && pageById(entry.pageId)?.boxes.some((b) => b.id === last)) {
          selectBox(last, { activate: false });
        }
      }
    }
    // A size the step put back is nobody's edit: without this, the next fit of
    // the selected box would take it for one the user just typed and make it
    // the box's reference, locked (see `noteSizeEdit`).
    markSelectedSize();
    // After the mark, so a fit run here is not read as a size the user typed.
    settleOwed(entry, dir);
    markUnsaved();
    sync();
    return true;
  } catch (err) {
    // Replay and fail loudly: the entry is dropped, the user is told what it
    // was, and the next press carries on to whatever is still valid beneath it.
    toastError(`Could not ${dir} ${KINDS[entry.t].label}: ${err.message}`);
    sync();
    return false;
  } finally {
    applying = false;
    // A step moves the stack as surely as a record does, so the journal has to
    // be scheduled here too. Without it the document's own autosave wrote the
    // post-undo pages 800ms later while history.json still held the pre-undo
    // stack, and a crash or a kill in between left the two disagreeing about
    // how many edits had happened - the next press then replayed an entry
    // against a document it was never recorded against.
    //
    // In the failure branch as well: a step that could not apply DROPS its
    // entry, and a stack that has lost an entry is as changed as one that has
    // moved it. Left unscheduled, the journal would keep offering an entry this
    // build has already refused once.
    //
    // The live page rather than the entry's own: this is `livePageId` on the
    // other side of the seam, and an entry naming a page that is gone - the one
    // kind that reliably lands in the branch above - would otherwise hand the
    // live page's whole stack to a dead page's key.
    sink?.(history.pageId);
  }
}

// An edit still inside a settle window has been applied to the document and not
// yet recorded, and it is the one the user means: dragging a slider and pressing
// undo is how anyone rejects a change. Stepping over it would rewind the entry
// beneath it instead, leave the unwanted change standing, and then let the
// settle land on top and clear the redo this step had just pushed - no way
// forward and no way back. So the window is closed first, from here rather than
// from the keyboard handler, so every way of asking for a step gets it.
export const undo = () => {
  settleEdits();
  return step(undoStack, redoStack, 'undo');
};
export const redo = () => {
  settleEdits();
  return step(redoStack, undoStack, 'redo');
};

// A copy of the live stack, for a write that must not disturb it.
export function peekStack() {
  return { undo: undoStack.slice(), redo: redoStack.slice() };
}

// The live page hands its stack over on a page switch and takes another back.
export function takeStack() {
  const out = { undo: undoStack, redo: redoStack };
  undoStack = [];
  redoStack = [];
  sync();
  return out;
}

// Whatever comes back off disk is untrusted: a record of a kind this build no
// longer knows how to apply is dropped rather than kept to fail on a press.
export function loadStack(pageId, stack) {
  undoStack = Array.isArray(stack?.undo)
    ? stack.undo.filter((e) => KINDS[e?.t]).slice(-MAX_STEPS)
    : [];
  redoStack = Array.isArray(stack?.redo)
    ? stack.redo.filter((e) => KINDS[e?.t]).slice(-MAX_STEPS)
    : [];
  history.pageId = pageId;
  sync();
}

export function resetHistory() {
  undoStack = [];
  redoStack = [];
  history.pageId = null;
  sync();
}

// Registered once, at boot. Idempotent, and it has to say so itself now that the
// store's seams take a list rather than a slot: a second call used to overwrite
// the one subscriber and cost nothing, and would now leave two of us on the
// recorder - every edit pushed onto the stack twice, so one press of undo would
// only ever rewind half a step. Releasing our own registration first is what the
// unsubscribe the store hands back is for.
let releaseRecorder = null;
let releaseLander = null;
export function initHistory() {
  releaseRecorder?.();
  releaseRecorder = setRecorder(record);
  releaseLander?.();
  releaseLander = setFitLander(fitLanded);
}
