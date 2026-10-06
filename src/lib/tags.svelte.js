// ===== Tags =====
// A tag is a name the user puts on a queued line - `sfx`, `narration`, whatever
// else they invent - plus an optional default font, outline and font size that a
// box picks up at the moment it is placed.
//
// Two halves, deliberately kept apart, because they persist in different places
// and for different reasons:
//
//   the applied tags  live on the line, in chapter.json, with the document.
//                     They are what the user marked up, and they mean nothing
//                     without the chapter they were marked on.
//   the registry      lives in project.json, with the project. It is that
//                     project's working vocabulary - "sfx means Bangers with a
//                     fat outline here" - and a second project starts with none
//                     of it: a tag made in one series must not turn up, usable
//                     and pre-styled, in another. Nothing needs the registry to
//                     draw: a tag's defaults are baked into the box's own style
//                     at placement time, so a chapter opened on a machine whose
//                     copy of the project lacks the registry renders identically.
//                     The remembered font size per tag lives beside it, for the
//                     same reason - "sfx is about 60 in this series".
//
// This module imports nothing. Not the store, not the filesystem - the functions
// that touch the document take the pages they work on as an argument, which is
// also what makes the whole model testable in node. The store imports *this*,
// for the one thing that has to happen inside placement.

// Every write here is a discrete click - created a tag, edited a tag, applied a
// tag - never a drag or a key repeat, so there is nothing to coalesce: each one
// hands the whole registry to the saver the library bound (see `bindTags`).

// The two values `line.type` has ever carried that mean anything to a reader.
// `dialogue` is the unmarked default and is deliberately not a tag: the queue has
// always hidden its badge, and promoting it would put a tag on every line in
// every chapter ever imported.
export const LEGACY_TAGS = ['sfx', 'narration'];

// A tag name is folded to one canonical spelling before anything else sees it.
// Without this, a user typing `SFX` creates a second tag beside the `sfx` that is
// already in every chapter.json detection has ever written, and the migration
// below buys nothing. Length is capped because the name is rendered in a badge on
// a row in a narrow floating panel.
// This function must be idempotent - `normalizeTagName(normalizeTagName(x))`
// has to equal `normalizeTagName(x)` - because the two halves of the model
// normalise at different moments and then compare the results by string
// equality. `tagsInUse` reports the name stored on the line; `boxesWithTag`
// re-normalises the name it is handed and matches against that. A name that
// changed on the second pass matched nothing, so a tag the panel had just
// offered restyled zero boxes and the queue's lit chip added a near-duplicate
// instead of removing it.
//
// Hence the second trim, after the cap and not before it: a 25-character name
// whose 24th character is a space came out of `.slice()` still carrying it.
export const MAX_TAG_LEN = 24;
export function normalizeTagName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LEN).trim();
  return n === '' ? null : n;
}

// ---------- the registry ----------
// Ordered most-recently-used first. One array rather than a list plus a separate
// recency order, because two of them can disagree - a name in the order that is
// not in the list is a slot in the picker that applies a tag with no defaults and
// no way to edit it. The picker's first two slots are simply the first two
// entries.
export const tags = $state({ list: [], sizes: {} });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const okSize = (v) => (isNum(v) && v > 0 ? v : null);

// A stored registry is a preference of the least important kind, so the same rule
// as the panel geometry applies: anything that does not parse, or does not carry
// the right types, is dropped rather than coerced. An entry survives only if its
// name survives; each default is vetted on its own, so one bad colour costs a
// colour and not the tag.
export function sanitizeTags(stored) {
  let raw = stored;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const arr = Array.isArray(raw?.list) ? raw.list : [];
  const out = [];
  const seen = new Set();
  for (const e of arr) {
    const name = normalizeTagName(e && typeof e === 'object' ? e.name : e);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      font: typeof e?.font === 'string' && e.font !== '' ? e.font : null,
      outline: typeof e?.outline === 'string' && e.outline !== '' ? e.outline : null,
      outlineWidth: isNum(e?.outlineWidth) ? e.outlineWidth : null,
      size: okSize(e?.size),
    });
  }
  return out;
}

// The remembered font size per tag group, keyed by the line's first tag - the
// same one `styleForLine` lets win - with the untagged group under ''. Anything
// that is not a finite number is dropped, like a bad tag default.
export function sanitizeTagSizes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isNum(v)) out[k] = v;
  return out;
}

// The registry is bound to the open project by the library, which is the one
// module that knows where project.json is: `stored` is `{ list, sizes }` off the
// project record and `save` is called with the same shape after every write.
// This module still imports nothing. With no project open the registry is empty
// and writes go nowhere, which is what `unbindTags` puts it back to.
let saver = null;

export function bindTags(stored, save = null) {
  tags.list = sanitizeTags(stored);
  tags.sizes = sanitizeTagSizes(stored?.sizes);
  saver = typeof save === 'function' ? save : null;
}

export function unbindTags() {
  bindTags(null, null);
}

function save() {
  if (!saver) return;
  try {
    saver({ list: $state.snapshot(tags.list), sizes: $state.snapshot(tags.sizes) });
  } catch {
    /* the library's saver reports its own failures */
  }
}

// Size memory per tag group: the REFERENCE size the user chose for the group,
// which placement solves down from (FIT-1). Read at placement (see
// `inheritedStyleFor`), written on a deliberate size change and nothing else
// (see `rememberSizeFor`). An unchanged size is not a write, so it does not
// reach project.json.
export const tagSize = (key) => (isNum(tags.sizes[key]) ? tags.sizes[key] : null);

export function rememberTagSize(key, size) {
  if (typeof key !== 'string' || !isNum(size) || tags.sizes[key] === size) return;
  tags.sizes[key] = size;
  save();
}

// A default size the user has just set in the tag's form is also the size the
// group is remembered at: it is the newest deliberate choice for this kind of
// text, and a memory left over from an older chapter must not outrank it. Only
// a CHANGED default writes it, so saving the form for its font does not throw
// away a size learned from the boxes since. No save here - the caller saves.
function seedSize(name, before, after) {
  if (after != null && after !== before) tags.sizes[name] = after;
}

export const findTag = (name) => tags.list.find((t) => t.name === name) ?? null;

// Registering and re-ranking are one operation because they are one event: the
// user used this tag. A name that is not in the registry joins it at the front
// with no defaults - which is how a tag that only ever existed in an imported
// chapter.json becomes editable - and a name already in it moves to the front.
// `defaults` is only honoured on the way in; see `updateTag` for why an existing
// entry is never overwritten from here.
export function touchTag(name, defaults = null) {
  const n = normalizeTagName(name);
  if (!n) return null;
  const found = findTag(n);
  const entry = found ?? {
    name: n,
    font: defaults?.font ?? null,
    outline: defaults?.outline ?? null,
    outlineWidth: isNum(defaults?.outlineWidth) ? defaults.outlineWidth : null,
    size: okSize(defaults?.size),
  };
  if (!found) seedSize(n, null, entry.size);
  tags.list = [entry, ...tags.list.filter((t) => t.name !== n)];
  save();
  return entry;
}

// Creating a tag is `touchTag` with the defaults the creation form collected.
// Naming it separately would be a parallel function; naming it at all is worth it
// because the caller's intent - and the failure when the name is already taken -
// is different. An existing name is returned rather than re-defaulted, so the
// create form can never silently overwrite the defaults of a tag the user forgot
// they had.
export function createTag(name, defaults = null) {
  return touchTag(name, defaults);
}

// The whole not-retroactive rule lives here, and it lives here by being absent:
// this writes the registry and nothing else. It never walks the document, because
// a box's style is a value that was copied out of this entry once, at placement,
// and never a reference back into it. So a tag edited today cannot reach a box
// placed yesterday - not by policy, but because there is no path from here to
// that box. See `styleForLine` for the other half.
//
// `null` clears a default back to unset, which is the state that means "fall back
// to whatever the style would have been". `undefined` leaves the field alone.
export function updateTag(name, patch = {}) {
  const t = findTag(normalizeTagName(name));
  if (!t) return null;
  if (patch.font !== undefined) t.font = typeof patch.font === 'string' && patch.font !== '' ? patch.font : null;
  if (patch.outline !== undefined)
    t.outline = typeof patch.outline === 'string' && patch.outline !== '' ? patch.outline : null;
  if (patch.outlineWidth !== undefined) t.outlineWidth = isNum(patch.outlineWidth) ? patch.outlineWidth : null;
  if (patch.size !== undefined) {
    const size = okSize(patch.size);
    seedSize(t.name, t.size, size);
    t.size = size;
  }
  save();
  return t;
}

// What the settings form saves, and the reason it is not `updateTag` with a
// fallback to `createTag`: the picker offers tags the open chapter uses that the
// registry has never seen, and saving settings on one of those has to admit it -
// but admitting it through `touchTag` re-ranked it to slot 1, which is a third
// case in a rule stated as "promote on apply, never on remove". The user was
// configuring a tag, not using it, and the picker reordered under their cursor
// while they did. So a name the registry does not hold joins at the *end*, where
// it changes nobody's first two slots.
export function saveTagDefaults(name, defaults = {}) {
  const n = normalizeTagName(name);
  if (!n) return null;
  if (findTag(n)) return updateTag(n, defaults);
  const entry = {
    name: n,
    font: typeof defaults.font === 'string' && defaults.font !== '' ? defaults.font : null,
    outline: typeof defaults.outline === 'string' && defaults.outline !== '' ? defaults.outline : null,
    outlineWidth: isNum(defaults.outlineWidth) ? defaults.outlineWidth : null,
    size: okSize(defaults.size),
  };
  seedSize(n, null, entry.size);
  tags.list = [...tags.list, entry];
  save();
  return entry;
}

// Renaming is deliberately not offered. A tag's name is the only thing joining an
// entry here to the lines carrying it in every chapter on disk - including the
// ones not open - so a rename would either orphan those lines or need a rewrite
// this app has no way to perform across chapters it has not read.
//
// Deleting is offered, and it is a narrower thing than it looks: it forgets the
// vocabulary entry and nothing else. The lines carrying the name keep carrying
// it, in this chapter and in every chapter on disk; the boxes keep the style
// they were placed with, because that style is a value they own and never a
// reference back here. What actually changes is that the tag stops proposing
// defaults to boxes placed from now on, and stops appearing in the picker -
// except that a chapter still using it puts it back, unconfigured, via
// `knownTags`. All of which the UI has to say out loud, because "delete" is a
// word users read as "and take it off my document".
//
// Returns whether an entry was there to remove.
export function deleteTag(name) {
  const n = normalizeTagName(name);
  if (!n || !findTag(n)) return false;
  tags.list = tags.list.filter((t) => t.name !== n);
  save();
  return true;
}

// ---------- the settings form's two halves ----------
// Seeding the form from an entry, and reading the entry back out of it. They
// live here rather than in the queue because they are one round trip and their
// bug was a disagreement between them: the form seeded its outline switch from
// `outline` alone, while `sanitizeTags` vets `outline` and `outlineWidth`
// independently - so an entry holding a width and no colour (which is exactly
// what a stored entry with a bad colour sanitises down to) opened with the
// switch off, and Save wrote the width away.
//
// The switch means "this tag sets an outline", so it lights for either half, and
// the half that was missing shows its fallback where the user can see it before
// they press Save. Saving then writes both or clears both, which is the only
// reading under which the form is a faithful view of what it will write.
export function tagFormFields(t) {
  return {
    outlineOn: t?.outline != null || t?.outlineWidth != null,
    font: t?.font ?? '',
    outline: t?.outline ?? '#ffffff',
    outlineWidth: t?.outlineWidth ?? 3,
    // '' is "no default size", shown as an empty field.
    size: t?.size ?? '',
  };
}

// `null` for a default the user left unset - that is the value that means "fall
// back to whatever the style would have been", and it is why a tag with nothing
// configured changes nothing.
export function tagFormDefaults(f) {
  return {
    font: f.font === '' ? null : f.font,
    outline: f.outlineOn ? f.outline : null,
    outlineWidth: f.outlineOn ? f.outlineWidth : null,
    size: f.size === '' || f.size == null ? null : +f.size,
  };
}

// ---------- tags on a line ----------
// The migration, and it is a read-time one: nothing rewrites a file. A line that
// has never been tagged has no `tags` array, and is read as carrying whatever its
// legacy `line.type` said - so every chapter detection has ever written arrives
// already tagged, with no save, no schema bump and no chance of a load marking a
// document dirty. The array's *presence* is the marker that the user has taken
// over: once they have, an empty array means "no tags", not "fall back to type".
export function lineTags(line) {
  if (!line) return [];
  if (Array.isArray(line.tags)) return line.tags;
  return LEGACY_TAGS.includes(line.type) ? [line.type] : [];
}

export const hasTag = (line, name) => lineTags(line).includes(name);

// Writing tags also projects them back onto `line.type`, because that field is
// still what the JSON and PSD exporters write and what the importer reads, and
// neither of them knows about tags. Left alone, a line the user untagged would
// keep exporting as `sfx` forever. The projection is the first legacy tag in the
// user's own order, so the leftmost tag is the one that speaks for the line
// outside this app.
export function setLineTags(line, names) {
  const out = [];
  for (const raw of names) {
    const n = normalizeTagName(raw);
    if (n && !out.includes(n)) out.push(n);
  }
  line.tags = out;
  line.type = out.find((n) => LEGACY_TAGS.includes(n)) ?? 'dialogue';
  return out;
}

// One click on a picker chip. Applying also promotes the tag in the registry -
// that is what makes the first two slots the two tags the user actually reaches
// for - while removing does not: un-tagging one line is not a statement about how
// often the tag is used, and letting it re-rank would shuffle the picker under
// the user's cursor as they correct a mistake.
export function toggleLineTag(line, name) {
  const n = normalizeTagName(name);
  if (!n) return lineTags(line);
  const cur = lineTags(line);
  if (cur.includes(n)) return setLineTags(line, cur.filter((x) => x !== n));
  const next = setLineTags(line, [...cur, n]);
  touchTag(n);
  return next;
}

// ---------- surviving a re-import ----------
// A translations file describes `{ n, jp, en, type }` and nothing else - the
// importer has never had a `tags` field to read, and re-importing replaces a
// page's lines wholesale. So re-running a corrected translation over a chapter
// that had been tagged by hand threw every hand-applied tag away while leaving
// the boxes exactly where they were: `sfx` and `narration` came back through
// `type`, and anything the user had invented was gone with no warning.
//
// This carries them across, joined by line number, which is the same join the
// placed boxes already use (`box.lineN`). The rule is the one `lineTags` already
// states: the presence of a `tags` array is the marker that the user has taken
// over that line, so where it is present it wins outright and the incoming
// `type` does not get a vote. A line the user never touched has no array and
// takes whatever the file says, exactly as before.
//
// Written through `setLineTags` so the restored tags also re-project onto
// `type`; otherwise a restored line would carry `tags: ['sfx']` under the
// incoming `type: 'dialogue'` and the exporters, which still read `type`, would
// disagree with the queue about the same line.
//
// Precedence, in full: an incoming line that carries its own `tags` array wins -
// the file said something explicit and a file the user chose to import is a
// statement. Failing that, the previous page's array carries forward. Failing
// both, the incoming `type` speaks, which is the pre-tag behaviour unchanged.
//
// It also keeps the page's free-typed lines - the ones a box made with the Text
// tool brought into existence, numbered below zero (see `isFreeLine` in
// store.svelte.js). A translations file describes the translator's lines and
// says nothing whatever about these, so the wholesale replacement would take
// them out, and the cost is not a tag: it is the *text*, which is where a free
// box's text lives, plus the box's only queue row. The user would be left with a
// box on the page rendering nothing, no row to type into, and no way back short
// of re-importing the old file. They are appended after the incoming lines, in
// their own order, which is where they already sit in the queue - free lines are
// pushed on the end as they are made, so a re-import does not shuffle the panel.
//
// A number the incoming file already claims is left to the file. It cannot
// happen from any producer this app has met (translators number from 1) and if
// it does, two lines answering to one number is the one outcome nothing
// downstream survives - `lineByN` would hand the box whichever came first.
export function carryTagsForward(prevLines = [], nextLines = []) {
  const kept = new Map();
  for (const l of prevLines) if (l && Array.isArray(l.tags)) kept.set(l.n, l.tags);
  const out = nextLines.map((l) => {
    if (Array.isArray(l.tags)) return l;
    const tags = kept.get(l.n);
    if (!tags) return l;
    const copy = { ...l };
    setLineTags(copy, tags);
    return copy;
  });
  const taken = new Set(nextLines.map((l) => l?.n));
  for (const l of prevLines) {
    if (l && Number.isFinite(l.n) && l.n < 0 && !taken.has(l.n)) out.push({ ...l });
  }
  return out;
}

// ---------- defaults reaching a box ----------
// Called once, by `placeActiveAt`, at the instant the box is created - the only
// moment a tag's defaults are ever read. What comes back is a plain style value
// that the box then owns outright, which is why editing the tag later cannot
// touch it.
//
// `base` is consumed: the flat keys are copied over it and the nested groups
// (shadow, roughen) come through by reference, so every caller hands over a style
// it has just cloned rather than one something else still holds.
//
// The leftmost tag wins. A later tag only fills in what the earlier ones left
// unset, so the first tag on a line is its primary one and adding a second cannot
// quietly restyle it. An unset default - the `null` - is what makes tags optional
// at all: it changes nothing, and the box keeps the style it would have had.
// A tag still defines an outline as one colour and one width, which is what a
// tag has always been and what the picker offers. The style it lands on holds a
// LIST of strokes, so the two have to be reconciled, and the rule is the one
// that keeps a tag meaning what it says: a tag that defines an outline defines
// THE outline, so it replaces the box's stroke list rather than adding to it -
// otherwise tagging a box that already had two strokes would give it three, and
// the tag's own colour would be buried under the box's.
//
// A tag that names only a colour (no width) is read as "this outline, at
// whatever width is already there", so it recolours the first stroke and adds
// one at the default width only when the box has none; a tag that names only a
// width does the same the other way round. Both together replace the list
// outright. A width of 0 is a real answer - no outline at all.
export function styleForLine(line, base) {
  const out = { ...base };
  const done = { font: false, outline: false, outlineWidth: false };
  for (const name of lineTags(line)) {
    const t = findTag(name);
    if (!t) continue;
    if (!done.font && t.font != null) {
      out.font = t.font;
      done.font = true;
    }
    if (!done.outline && t.outline != null) {
      out.strokes = withStrokeColor(out.strokes, t.outline, done.outlineWidth);
      done.outline = true;
    }
    if (!done.outlineWidth && t.outlineWidth != null) {
      out.strokes = withStrokeWidth(out.strokes, t.outlineWidth, done.outline);
      done.outlineWidth = true;
    }
  }
  return out;
}

// `replace` says the other half of the outline came from this same tag, so the
// pair is the whole outline and the box's own strokes go.
const STROKE_W = 3;
const STROKE_C = '#ffffff';
function withStrokeColor(strokes, color, replace) {
  if (replace) return [{ color, width: strokes?.[0]?.width ?? STROKE_W, opacity: 1 }];
  if (!strokes?.length) return [{ color, width: STROKE_W, opacity: 1 }];
  return [{ ...strokes[0], color }, ...strokes.slice(1)];
}
function withStrokeWidth(strokes, width, replace) {
  if (width <= 0) return [];
  if (replace) return [{ color: strokes?.[0]?.color ?? STROKE_C, width, opacity: 1 }];
  if (!strokes?.length) return [{ color: STROKE_C, width, opacity: 1 }];
  return [{ ...strokes[0], width }, ...strokes.slice(1)];
}

// ---------- picker + bulk-editor surface ----------
// Everything below takes the pages it should look at rather than reaching for the
// open document, which is also how scope is expressed: the whole chapter is
// `app.pages`, the current page is `[page()]`. A scope enum would have been a
// second vocabulary for something the caller can already say by choosing an
// array, and it would have had to be threaded through every one of these.

// Every tag name actually carried by a line in `pages`, first-seen order (page
// order, then line order). This is the list the bulk editor's tag selector shows:
// tags in use in this chapter, not the user's whole vocabulary.
export function tagsInUse(pages = []) {
  const out = [];
  for (const p of pages) {
    for (const l of p?.lines ?? []) {
      for (const t of lineTags(l)) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

// What the picker offers: the registry in recency order, then any tag the open
// chapter uses that the registry has never heard of, as an unconfigured entry.
// The second half is what stops a freshly imported chapter full of `sfx` from
// presenting an empty picker - those tags exist, the user just has not applied
// one by hand yet.
export function knownTags(pages = []) {
  const out = tags.list.map((t) => ({ ...t }));
  for (const name of tagsInUse(pages)) {
    if (!out.some((t) => t.name === name)) out.push({ name, font: null, outline: null, outlineWidth: null });
  }
  return out;
}

// The picker's first four slots.
export const recentTags = (pages = []) => knownTags(pages).slice(0, 4);

// Every box carrying `name` within `pages`. The boxes come back live - the same
// objects the document holds, not snapshots - because the caller's whole purpose
// is to write styles onto them and record one history entry for the lot. The page
// and line ride along so a caller can address the box by page id without going
// looking for it again.
//
// A box with no line at all (`lineN == null`) is never returned, and there is
// exactly one kind left: a free-typed box saved to disk before free-typed boxes
// joined the queue, which `loadProjectPages` deliberately does not migrate. It
// has no line, tags live on lines, so it cannot be tagged and cannot be reached
// by a tag-scoped bulk edit.
//
// A box typed onto the canvas *today* has a line - a negative-numbered one it
// created (see `addEmptyBox`) - and is returned like any other. That is the
// whole point of giving it one: "everything is taggable" is a claim about this
// function, and it used to be false for every box the Text tool made.
export function boxesWithTag(name, pages = []) {
  const n = normalizeTagName(name);
  const out = [];
  if (!n) return out;
  for (const p of pages) {
    // A page's lines by number, built once per page rather than a `.find` per
    // box - a chapter of hundreds of placed boxes made that O(boxes × lines)
    // for the same answer, since line numbers are unique within a page.
    const byN = new Map();
    for (const l of p?.lines ?? []) if (l && !byN.has(l.n)) byN.set(l.n, l);
    for (const b of p?.boxes ?? []) {
      if (b.lineN == null) continue;
      const line = byN.get(b.lineN);
      if (line && hasTag(line, n)) out.push({ page: p, line, box: b });
    }
  }
  return out;
}
