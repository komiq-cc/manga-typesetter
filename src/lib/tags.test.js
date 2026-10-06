import { describe, it, expect, beforeEach } from 'vitest';
import {
  tags,
  bindTags,
  sanitizeTags,
  normalizeTagName,
  LEGACY_TAGS,
  MAX_TAG_LEN,
  createTag,
  updateTag,
  saveTagDefaults,
  deleteTag,
  tagFormFields,
  tagFormDefaults,
  touchTag,
  findTag,
  lineTags,
  hasTag,
  setLineTags,
  toggleLineTag,
  carryTagsForward,
  styleForLine,
  tagsInUse,
  knownTags,
  recentTags,
  boxesWithTag,
} from './tags.svelte.js';
import { app, loadProjectPages, placeActiveAt, byId } from './store.svelte.js';
import { defaultStyle } from './data.js';

// The registry is a module singleton that persists across cases, exactly as it
// persists across chapters in the app. Every case starts from a known one by
// re-binding it empty with a saver that captures the writes - which is also the
// only way to see them, since node has no project.json to write.
let saved;
beforeEach(() => {
  saved = null;
  bindTags(null, (next) => (saved = next));
  app.chapterRef = null;
});

describe('tag names', () => {
  it('folds case and whitespace so a typed name meets the one already on disk', () => {
    // `sfx` is what detection writes into every chapter.json. A user typing
    // `SFX` must land on that tag, not create a second one beside it.
    expect(normalizeTagName('  SFX ')).toBe('sfx');
    expect(normalizeTagName('Sound   Effect')).toBe('sound effect');
  });
  it('refuses a name that is not one', () => {
    expect(normalizeTagName('   ')).toBe(null);
    expect(normalizeTagName('')).toBe(null);
    expect(normalizeTagName(null)).toBe(null);
    expect(normalizeTagName(7)).toBe(null);
  });
  it('caps the length the badge has to render', () => {
    expect(normalizeTagName('x'.repeat(80))).toHaveLength(MAX_TAG_LEN);
  });
  it('is idempotent even when the cap lands on a space', () => {
    // The cap used to run after the trim, so a name whose 24th character was a
    // space kept it. `tagsInUse` then offered `"xxx… "` while `boxesWithTag`
    // re-normalised it to `"xxx…"` and matched nothing: the panel said it would
    // restyle boxes, Enter restyled none, and the queue's lit chip added a
    // near-duplicate instead of removing it.
    const raw = 'x'.repeat(23) + ' yz';
    const once = normalizeTagName(raw);
    expect(once).toBe('x'.repeat(23));
    expect(normalizeTagName(once)).toBe(once);
    // …and the general property, over every cap boundary a space can land on.
    for (let i = 1; i <= MAX_TAG_LEN + 2; i++) {
      const n = normalizeTagName('a'.repeat(i) + ' b'.repeat(6));
      expect(normalizeTagName(n)).toBe(n);
    }
  });
});

describe('stored registry', () => {
  it('drops anything that does not parse', () => {
    expect(sanitizeTags('{{{')).toEqual([]);
    expect(sanitizeTags(null)).toEqual([]);
    expect(sanitizeTags('{"list":"nope"}')).toEqual([]);
  });
  it('vets each default on its own, so one bad field costs a field', () => {
    const [t] = sanitizeTags({ list: [{ name: 'sfx', font: 'Bangers', outline: 5, outlineWidth: 'fat' }] });
    expect(t).toEqual({ name: 'sfx', font: 'Bangers', outline: null, outlineWidth: null, size: null });
  });
  it('collapses duplicate names to the first spelling of them', () => {
    const list = sanitizeTags({ list: [{ name: 'SFX', font: 'Bangers' }, { name: 'sfx', font: 'Nunito' }] });
    expect(list).toHaveLength(1);
    expect(list[0].font).toBe('Bangers');
  });
  it('round-trips through the saver', () => {
    createTag('sfx', { font: 'Bangers', outline: '#000000', outlineWidth: 5 });
    bindTags(saved);
    expect(findTag('sfx')).toEqual({ name: 'sfx', font: 'Bangers', outline: '#000000', outlineWidth: 5, size: null });
  });
});

describe('recency order', () => {
  it('puts the most recently used tag first', () => {
    createTag('sfx');
    createTag('thought');
    createTag('sign');
    expect(tags.list.map((t) => t.name)).toEqual(['sign', 'thought', 'sfx']);
    touchTag('sfx');
    expect(tags.list.map((t) => t.name)).toEqual(['sfx', 'sign', 'thought']);
  });
  it('re-ranks rather than duplicating a tag already known', () => {
    createTag('sfx', { font: 'Bangers' });
    touchTag('sfx');
    expect(tags.list).toHaveLength(1);
    // …and re-touching never re-defaults it: the create form must not be able to
    // silently overwrite defaults on a name the user forgot they had.
    createTag('sfx', { font: 'Nunito' });
    expect(findTag('sfx').font).toBe('Bangers');
  });
  it('refuses to update a name it does not hold', () => {
    // The picker leans on this: a tag offered only because the open chapter uses
    // it has nothing to update, and the settings form creates it instead rather
    // than letting the user's choices vanish into a null.
    expect(updateTag('ghost', { font: 'Bangers' })).toBe(null);
    expect(tags.list).toHaveLength(0);
  });
  it('hands the picker its first four slots', () => {
    createTag('a');
    createTag('b');
    createTag('c');
    createTag('d');
    createTag('e');
    expect(recentTags().map((t) => t.name)).toEqual(['e', 'd', 'c', 'b']);
  });
  it('applying a tag promotes it, removing it does not', () => {
    createTag('sfx');
    createTag('sign');
    const line = { n: 1, type: 'dialogue' };
    toggleLineTag(line, 'sfx');
    expect(tags.list[0].name).toBe('sfx');
    toggleLineTag(line, 'sfx'); // removed again
    // Still first: un-tagging one line says nothing about how often the tag is
    // used, and a re-rank here would shuffle the picker under the user's cursor
    // while they correct a mistake.
    expect(tags.list[0].name).toBe('sfx');
  });
});

describe('saving a tag’s settings', () => {
  it('updates the entry the registry already holds, in place', () => {
    createTag('sign');
    createTag('sfx', { font: 'Bangers' });
    saveTagDefaults('sfx', { font: 'Nunito', outline: '#000000', outlineWidth: 4 });
    expect(findTag('sfx')).toEqual({ name: 'sfx', font: 'Nunito', outline: '#000000', outlineWidth: 4, size: null });
    // Configuring a tag is not using it, so it does not move.
    expect(tags.list.map((t) => t.name)).toEqual(['sfx', 'sign']);
  });

  it('admits an unregistered chapter tag at the end, never at slot 1', () => {
    // The picker offers tags the open chapter uses that the registry has never
    // seen. Saving settings on one used to go through `createTag` → `touchTag`,
    // which promoted it to the front - an undocumented third case in "promote on
    // apply, never on remove", and it reordered the picker's first two slots
    // under the cursor of a user who was only editing a font.
    createTag('sign');
    createTag('thought');
    const before = tags.list.map((t) => t.name);
    saveTagDefaults('sfx', { font: 'Bangers' });
    expect(tags.list.map((t) => t.name)).toEqual([...before, 'sfx']);
    expect(recentTags().map((t) => t.name)).toEqual([...before, 'sfx']);
    expect(recentTags()[0].name).not.toBe('sfx');
    expect(findTag('sfx').font).toBe('Bangers');
  });

  it('normalises the name and refuses one that is not a name', () => {
    saveTagDefaults('  SFX ', { font: 'Bangers' });
    expect(findTag('sfx').font).toBe('Bangers');
    expect(saveTagDefaults('   ', { font: 'Bangers' })).toBe(null);
    expect(tags.list).toHaveLength(1);
  });
});

describe('deleting a tag', () => {
  it('forgets the vocabulary entry and nothing else', () => {
    createTag('sfx', { font: 'Bangers' });
    createTag('sign');
    const line = { n: 1, tags: ['sfx'] };
    expect(deleteTag('SFX')).toBe(true);
    expect(findTag('sfx')).toBe(null);
    expect(tags.list.map((t) => t.name)).toEqual(['sign']);
    // The line keeps the tag - the name is the only join to lines in chapters
    // this app has not read, so deletion cannot mean "take it off my document".
    expect(lineTags(line)).toEqual(['sfx']);
  });

  it('leaves a box already carrying the tag exactly as it was placed', () => {
    createTag('sfx', { font: 'Bangers' });
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', jp: '', en: 'DOOM' }], boxes: [] },
    ]);
    placeActiveAt(100, 100);
    const id = app.pages[0].boxes[0].id;
    expect(byId(id).style.font).toBe('Bangers');
    deleteTag('sfx');
    expect(byId(id).style.font).toBe('Bangers');
  });

  it('stops proposing defaults to boxes placed afterwards', () => {
    createTag('sfx', { font: 'Bangers' });
    const line = { n: 1, type: 'sfx' };
    expect(styleForLine(line, { ...defaultStyle() }).font).toBe('Bangers');
    deleteTag('sfx');
    expect(styleForLine(line, { ...defaultStyle() }).font).toBe(defaultStyle().font);
  });

  it('survives in the picker while the open chapter still uses it, unconfigured', () => {
    createTag('sfx', { font: 'Bangers' });
    const pages = [{ id: 1, lines: [{ n: 1, type: 'sfx' }], boxes: [] }];
    deleteTag('sfx');
    // Not a bug and the UI has to say so: the tag is still on the lines, so
    // `knownTags` still has to offer it - just with nothing behind it.
    expect(knownTags(pages).find((t) => t.name === 'sfx')).toEqual({
      name: 'sfx',
      font: null,
      outline: null,
      outlineWidth: null,
    });
  });

  it('reports whether there was anything to delete', () => {
    expect(deleteTag('ghost')).toBe(false);
    expect(deleteTag('  ')).toBe(false);
  });

  it('reaches the saver, so the tag stays gone across a reopen', () => {
    createTag('sfx');
    createTag('sign');
    deleteTag('sfx');
    bindTags(saved);
    expect(tags.list.map((t) => t.name)).toEqual(['sign']);
  });
});

describe('the settings form’s round trip', () => {
  it('keeps a width whose colour did not survive sanitising', () => {
    // `sanitizeTags` vets the two fields on their own, so this entry is one a
    // stored registry really produces - a bad colour costs the colour, not the
    // width. The form seeded its switch from `outline` alone, so this opened
    // with the switch off and Save wrote `outlineWidth: null` over the 6.
    const [t] = sanitizeTags({ list: [{ name: 'sfx', outline: 5, outlineWidth: 6 }] });
    expect(t).toEqual({ name: 'sfx', font: null, outline: null, outlineWidth: 6, size: null });
    const f = tagFormFields(t);
    expect(f.outlineOn).toBe(true);
    expect(tagFormDefaults(f).outlineWidth).toBe(6);
  });

  it('round-trips an entry that sets both halves', () => {
    createTag('sfx', { font: 'Bangers', outline: '#000000', outlineWidth: 5 });
    expect(tagFormDefaults(tagFormFields(findTag('sfx')))).toEqual({
      font: 'Bangers',
      outline: '#000000',
      outlineWidth: 5,
      size: null,
    });
  });

  it('reads unset as unset, both ways', () => {
    const f = tagFormFields(null);
    expect(f.outlineOn).toBe(false);
    expect(tagFormDefaults(f)).toEqual({ font: null, outline: null, outlineWidth: null, size: null });
    // And turning the switch off clears both halves together, which is what the
    // switch says it does.
    expect(tagFormDefaults({ ...f, outlineOn: false, outline: '#000000', outlineWidth: 9 })).toEqual({
      font: null,
      outline: null,
      outlineWidth: null,
      size: null,
    });
  });

  it('round-trips a default size, and reads an empty field as none', () => {
    createTag('sfx', { size: 60 });
    const f = tagFormFields(findTag('sfx'));
    expect(f.size).toBe(60);
    expect(tagFormDefaults(f).size).toBe(60);
    expect(tagFormDefaults({ ...f, size: '' }).size).toBe(null);
    expect(sanitizeTags({ list: [{ name: 'a', size: -3 }, { name: 'b', size: 'big' }] }).map((t) => t.size)).toEqual([null, null]);
  });
});

describe('a tag’s default size', () => {
  it('is remembered for the group when it is set, so it outranks an older memory', () => {
    tags.sizes.sfx = 44;
    createTag('sfx', { size: 60 });
    expect(tags.sizes.sfx).toBe(60);
    expect(saved.sizes.sfx).toBe(60);
    saveTagDefaults('sfx', { size: 70 });
    expect(tags.sizes.sfx).toBe(70);
  });

  it('does not overwrite the memory when the form is saved for something else', () => {
    createTag('sfx', { size: 60 });
    tags.sizes.sfx = 48; // learned from a box since
    saveTagDefaults('sfx', { font: 'Bangers', size: 60 });
    expect(tags.sizes.sfx).toBe(48);
    saveTagDefaults('sfx', { size: null });
    expect(findTag('sfx').size).toBe(null);
    expect(tags.sizes.sfx).toBe(48);
  });
});

describe('tags surviving a re-import', () => {
  const imported = () => [
    { n: 1, jp: 'あ', en: 'One', type: 'dialogue' },
    { n: 2, jp: 'い', en: 'Two', type: 'sfx' },
    { n: 3, jp: 'う', en: 'Three', type: 'dialogue' },
  ];

  it('carries a hand-applied tag across by line number', () => {
    // The importer has never had a `tags` field to read and a re-import replaces
    // the page's lines wholesale, so a corrected translations file used to throw
    // away every tag the user had invented while leaving their boxes in place.
    const prev = [{ n: 1, tags: ['whisper', 'sfx'] }, { n: 3, tags: [] }];
    const out = carryTagsForward(prev, imported());
    expect(out[0].tags).toEqual(['whisper', 'sfx']);
    expect(out[2].tags).toEqual([]);
  });

  it('re-projects the restored tags onto line.type for the exporters', () => {
    // Otherwise the restored line carries tags:['sfx'] under the incoming
    // type:'dialogue', and the JSON/PSD exporters - which still read `type` -
    // disagree with the queue about the same line.
    const out = carryTagsForward([{ n: 1, tags: ['whisper', 'sfx'] }], imported());
    expect(out[0].type).toBe('sfx');
    // …including back down to dialogue for a line the user untagged.
    const off = carryTagsForward([{ n: 2, tags: [] }], imported());
    expect(off[1].type).toBe('dialogue');
    expect(lineTags(off[1])).toEqual([]);
  });

  it('lets the file speak for a line the user never tagged', () => {
    const out = carryTagsForward([{ n: 1, type: 'narration' }], imported());
    expect('tags' in out[0]).toBe(false);
    expect(out[1].type).toBe('sfx'); // straight from the file
  });

  it('drops tags whose line number the new file does not describe', () => {
    // Nothing to attach them to. The boxes on that number are counted as
    // orphaned by the caller, which is where that loss is already reported.
    const out = carryTagsForward([{ n: 9, tags: ['whisper'] }], imported());
    expect(out.map((l) => l.n)).toEqual([1, 2, 3]);
    expect(out.some((l) => Array.isArray(l.tags))).toBe(false);
  });

  it('never mutates the lines it was handed', () => {
    const prev = [{ n: 1, tags: ['whisper'] }];
    const next = imported();
    const out = carryTagsForward(prev, next);
    expect(next[0].tags).toBeUndefined();
    expect(next[0].type).toBe('dialogue');
    expect(out[0]).not.toBe(next[0]);
    // The carried array is the line's own, not one shared with the old page.
    expect(out[0].tags).not.toBe(prev[0].tags);
  });

  it('is a no-op on a chapter nobody has tagged', () => {
    expect(carryTagsForward([], imported())).toEqual(imported());
    expect(carryTagsForward(undefined, imported())).toEqual(imported());
  });

  // A translations file describes the translator's lines and says nothing about
  // the ones the user typed onto the page, so the wholesale replacement used to
  // take those out - and with them the free box's *text*, which is where it
  // lives, and its only queue row. The user would be left with a box rendering
  // nothing and no row to type into.
  it('keeps the free-typed lines the file says nothing about', () => {
    const prev = [
      { n: 1, tags: ['whisper'] },
      { n: -1, type: 'dialogue', jp: '', en: 'BOOM', tags: ['sfx'] },
      { n: -2, type: 'dialogue', jp: '', en: 'crunch' },
    ];
    const out = carryTagsForward(prev, imported());
    expect(out.map((l) => l.n)).toEqual([1, 2, 3, -1, -2]);
    // The text and the tags both, because both only exist here.
    expect(out[3]).toEqual({ n: -1, type: 'dialogue', jp: '', en: 'BOOM', tags: ['sfx'] });
    expect(out[4].en).toBe('crunch');
  });

  it('appends them after the imported lines, in their own order', () => {
    // Free lines are pushed on the end as they are made, so this is where they
    // already sit in the queue - a re-import must not shuffle the panel.
    const out = carryTagsForward([{ n: -2 }, { n: -1 }], imported());
    expect(out.map((l) => l.n)).toEqual([1, 2, 3, -2, -1]);
  });

  it('copies them rather than handing the old page’s objects to the new one', () => {
    const prev = [{ n: -1, en: 'BOOM' }];
    const out = carryTagsForward(prev, imported());
    expect(out[3]).not.toBe(prev[0]);
  });

  it('leaves a number the incoming file already claims to the file', () => {
    // Two lines answering to one number is the one outcome nothing downstream
    // survives - `lineByN` would hand the box whichever came first.
    const out = carryTagsForward([{ n: -1, en: 'mine' }], [...imported(), { n: -1, en: 'theirs' }]);
    expect(out.filter((l) => l.n === -1)).toHaveLength(1);
    expect(out.at(-1).en).toBe('theirs');
  });
});

describe('migration from line.type', () => {
  it('reads an untagged legacy line as carrying its type', () => {
    expect(lineTags({ n: 1, type: 'sfx' })).toEqual(['sfx']);
    expect(lineTags({ n: 2, type: 'narration' })).toEqual(['narration']);
  });
  it('leaves dialogue unmarked - it is the default, not a tag', () => {
    expect(lineTags({ n: 1, type: 'dialogue' })).toEqual([]);
    expect(lineTags({ n: 2 })).toEqual([]);
    expect(LEGACY_TAGS).not.toContain('dialogue');
  });
  it('rewrites nothing on read, so opening an old chapter marks nothing dirty', () => {
    const line = { n: 1, type: 'sfx' };
    lineTags(line);
    expect('tags' in line).toBe(false);
  });
  it('treats the array’s presence as the user having taken over', () => {
    // An empty array must mean "no tags", not "fall back to type" - otherwise a
    // tag the user removed comes straight back on the next read.
    const line = { n: 1, type: 'sfx' };
    setLineTags(line, []);
    expect(lineTags(line)).toEqual([]);
  });
  it('projects tags back onto line.type for the exporters that still read it', () => {
    const line = { n: 1, type: 'dialogue' };
    setLineTags(line, ['shout', 'sfx']);
    // The first *legacy* name is what the JSON and PSD exporters get; `shout`
    // means nothing to them.
    expect(line.type).toBe('sfx');
    setLineTags(line, ['shout']);
    expect(line.type).toBe('dialogue');
  });
  it('normalises and dedupes on write', () => {
    const line = { n: 1, type: 'dialogue' };
    setLineTags(line, ['SFX', ' sfx ', '', 'Sign']);
    expect(line.tags).toEqual(['sfx', 'sign']);
  });
  it('toggles a tag on and off one line', () => {
    const line = { n: 1, type: 'dialogue' };
    toggleLineTag(line, 'sign');
    expect(hasTag(line, 'sign')).toBe(true);
    toggleLineTag(line, 'sign');
    expect(hasTag(line, 'sign')).toBe(false);
  });
  it('toggling a legacy line off starts from the tag it already had', () => {
    const line = { n: 1, type: 'sfx' };
    toggleLineTag(line, 'sfx');
    expect(lineTags(line)).toEqual([]);
    expect(line.type).toBe('dialogue');
  });
});

describe('defaults reaching a style', () => {
  const base = () => ({ ...defaultStyle() });

  it('changes nothing when the line has no tags', () => {
    expect(styleForLine({ n: 1, type: 'dialogue' }, base())).toEqual(base());
  });
  it('changes nothing when the tag has no defaults', () => {
    createTag('sfx');
    expect(styleForLine({ n: 1, type: 'sfx' }, base())).toEqual(base());
  });
  it('applies only the defaults that are set', () => {
    createTag('sfx', { font: 'Bangers' });
    const s = styleForLine({ n: 1, type: 'sfx' }, base());
    expect(s.font).toBe('Bangers');
    expect(s.strokes).toEqual(base().strokes);
  });
  it('lets the leftmost tag win and a later one only fill the gaps', () => {
    createTag('sfx', { font: 'Bangers' });
    createTag('sign', { font: 'Nunito', outline: '#ff0000', outlineWidth: 8 });
    const line = { n: 1, tags: ['sfx', 'sign'] };
    const s = styleForLine(line, base());
    expect(s.font).toBe('Bangers'); // the primary tag
    // sfx left the outline unset, so sign fills it - and a tag that defines an
    // outline defines THE outline, so it stands as the box's whole stroke list.
    expect(s.strokes).toEqual([{ color: '#ff0000', width: 8, opacity: 1 }]);
  });

  // A tag's outline is still one colour and one width - that is what the picker
  // offers - so it has to be reconciled with a style that holds a list.
  it('recolours the stroke the box has when the tag names only a colour', () => {
    createTag('sign', { outline: '#ff0000' });
    const style = { ...base(), strokes: [{ color: '#ffffff', width: 7, opacity: 0.5 }] };
    expect(styleForLine({ n: 1, tags: ['sign'] }, style).strokes).toEqual([
      { color: '#ff0000', width: 7, opacity: 0.5 },
    ]);
  });
  it('adds one at the default width when the box has no stroke to recolour', () => {
    createTag('sign', { outline: '#ff0000' });
    const style = { ...base(), strokes: [] };
    expect(styleForLine({ n: 1, tags: ['sign'] }, style).strokes).toEqual([
      { color: '#ff0000', width: 3, opacity: 1 },
    ]);
  });
  it('resizes the stroke the box has when the tag names only a width', () => {
    createTag('sign', { outlineWidth: 9 });
    const style = { ...base(), strokes: [{ color: '#123456', width: 2, opacity: 1 }] };
    expect(styleForLine({ n: 1, tags: ['sign'] }, style).strokes).toEqual([
      { color: '#123456', width: 9, opacity: 1 },
    ]);
    expect(styleForLine({ n: 1, tags: ['sign'] }, { ...base(), strokes: [] }).strokes).toEqual([
      { color: '#ffffff', width: 9, opacity: 1 },
    ]);
  });
  it('takes a width of 0 as no outline at all', () => {
    createTag('sign', { outline: '#ff0000', outlineWidth: 0 });
    const style = { ...base(), strokes: [{ color: '#ffffff', width: 3, opacity: 1 }] };
    expect(styleForLine({ n: 1, tags: ['sign'] }, style).strokes).toEqual([]);
  });
  it('replaces a whole stack of strokes rather than adding to it', () => {
    createTag('sign', { outline: '#ff0000', outlineWidth: 4 });
    const style = {
      ...base(),
      strokes: [
        { color: '#ffffff', width: 3, opacity: 1 },
        { color: '#000000', width: 2, opacity: 1 },
      ],
    };
    expect(styleForLine({ n: 1, tags: ['sign'] }, style).strokes).toEqual([
      { color: '#ff0000', width: 4, opacity: 1 },
    ]);
  });
  it('ignores a tag the registry has never heard of', () => {
    expect(styleForLine({ n: 1, tags: ['ghost'] }, base())).toEqual(base());
  });
});

describe('editing a tag is not retroactive', () => {
  const chapter = () =>
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [
          { n: 1, type: 'sfx', jp: '', en: 'DOOM' },
          { n: 2, type: 'sfx', jp: '', en: 'CRASH' },
        ],
        boxes: [],
      },
    ]);

  it('leaves a box already carrying the tag with the style it was placed with', () => {
    createTag('sfx', { font: 'Bangers', outline: '#000000', outlineWidth: 6 });
    chapter();
    placeActiveAt(100, 100); // line 1, with Bangers
    const first = app.pages[0].boxes[0].id;
    expect(byId(first).style.font).toBe('Bangers');

    updateTag('sfx', { font: 'Nunito', outline: '#ff0000', outlineWidth: 2 });

    // The box placed before the edit is untouched - the whole point.
    expect(byId(first).style.font).toBe('Bangers');
    expect(byId(first).style.strokes).toEqual([{ color: '#000000', width: 6, opacity: 1 }]);

    // And the next placement takes the new defaults, which is the other half of
    // "applies to future uses only".
    placeActiveAt(200, 200); // line 2
    const second = app.pages[0].boxes[1].id;
    expect(byId(second).style.font).toBe('Nunito');
    expect(byId(second).style.strokes).toEqual([{ color: '#ff0000', width: 2, opacity: 1 }]);
  });

  it('does not reach back when the tag gains a default it never had', () => {
    createTag('sfx');
    chapter();
    placeActiveAt(100, 100);
    const first = app.pages[0].boxes[0].id;
    const wasFont = byId(first).style.font;
    updateTag('sfx', { font: 'Bangers' });
    expect(byId(first).style.font).toBe(wasFont);
  });

  it('clearing a default back to unset restores the fallback for future boxes', () => {
    createTag('sfx', { font: 'Bangers' });
    chapter();
    placeActiveAt(100, 100);
    updateTag('sfx', { font: null });
    placeActiveAt(200, 200);
    const second = app.pages[0].boxes[1];
    // Unset means the tag forces nothing, so the box gets the style it would
    // have inherited anyway - not the Bangers the box before it was given.
    expect(second.style.font).toBe(app.lastStyle.font);
    expect(second.style.font).not.toBe('Bangers');
  });

  it('does not touch a box whose line was never tagged', () => {
    createTag('sfx', { font: 'Bangers' });
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: '', en: 'hi' }], boxes: [] },
    ]);
    placeActiveAt(100, 100);
    expect(app.pages[0].boxes[0].style.font).toBe(app.lastStyle.font);
    expect(app.pages[0].boxes[0].style.font).not.toBe('Bangers');
  });
});

describe('the surface the bulk editor consumes', () => {
  const doc = () => [
    {
      id: 1,
      lines: [
        { n: 1, type: 'sfx' },
        { n: 2, type: 'dialogue', tags: ['shout'] },
        { n: -1, type: 'dialogue', jp: '', en: 'typed on the page', tags: ['shout'] },
      ],
      boxes: [
        { id: 'b1', lineN: 1 },
        { id: 'b2', lineN: 2 },
        // A free-typed box saved before free-typed boxes joined the queue. It
        // is deliberately not migrated on load (see `loadProjectPages`), so it
        // has no line and can carry no tag. `b5` below is what one made today
        // looks like: a line of its own, numbered below zero, tagged like any
        // other.
        { id: 'b3', lineN: null },
        { id: 'b5', lineN: -1 },
      ],
      // Pushed on the end, which is where free lines sit in the queue.
    },
    {
      id: 2,
      lines: [{ n: 1, type: 'narration', tags: ['narration', 'sfx'] }],
      boxes: [{ id: 'b4', lineN: 1 }],
    },
  ];

  it('lists the tags in use in first-seen order, legacy ones included', () => {
    expect(tagsInUse(doc())).toEqual(['sfx', 'shout', 'narration']);
  });
  it('is empty for a document nobody has tagged', () => {
    expect(tagsInUse([{ id: 1, lines: [{ n: 1, type: 'dialogue' }], boxes: [] }])).toEqual([]);
    expect(tagsInUse()).toEqual([]);
  });

  it('offers the registry first, then whatever the chapter uses that it has not seen', () => {
    createTag('sign');
    const names = knownTags(doc()).map((t) => t.name);
    expect(names[0]).toBe('sign');
    expect(names).toEqual(['sign', 'sfx', 'shout', 'narration']);
    // A chapter-only tag arrives unconfigured, which is what makes it editable
    // from the picker rather than only from the JSON.
    expect(knownTags(doc()).find((t) => t.name === 'sfx')).toEqual({
      name: 'sfx',
      font: null,
      outline: null,
      outlineWidth: null,
    });
  });
  it('never lists a tag twice when the chapter uses one the registry knows', () => {
    createTag('sfx');
    expect(knownTags(doc()).filter((t) => t.name === 'sfx')).toHaveLength(1);
  });

  it('finds every box carrying a tag across the pages it is given', () => {
    const pages = doc();
    // Chapter scope is the whole array…
    expect(boxesWithTag('sfx', pages).map((h) => h.box.id)).toEqual(['b1', 'b4']);
    // …and page scope is one page in an array of its own. The scope selector is
    // the array the caller passes; there is no second vocabulary for it.
    expect(boxesWithTag('sfx', [pages[0]]).map((h) => h.box.id)).toEqual(['b1']);
    expect(boxesWithTag('shout', pages).map((h) => h.box.id)).toEqual(['b2', 'b5']);
  });

  // This test used to read "never returns a free-typed box - it has no line and
  // so no tags", and that is no longer the rule: a box made with the Text tool
  // now creates a line of its own, so it is taggable and a tag-scoped bulk edit
  // reaches it. What survives of the old claim is the half that is still true -
  // a box with no line at all cannot be tagged - and the only boxes left in that
  // state are the ones already on disk, which `loadProjectPages` deliberately
  // does not migrate.
  it('returns a free-typed box today, and still never one saved without a line', () => {
    const ids = ['sfx', 'shout', 'narration'].flatMap((t) => boxesWithTag(t, doc()).map((h) => h.box.id));
    expect(ids).toContain('b5');
    expect(ids).not.toContain('b3');
  });
  it('hands back the live box, not a copy, so the caller can restyle it', () => {
    const pages = doc();
    const hit = boxesWithTag('sfx', pages)[0];
    expect(hit.box).toBe(pages[0].boxes[0]);
    expect(hit.page).toBe(pages[0]);
    expect(hit.line).toBe(pages[0].lines[0]);
  });
  it('normalises the name it is asked for, and refuses a non-name', () => {
    expect(boxesWithTag('SFX', doc())).toHaveLength(2);
    expect(boxesWithTag('  ', doc())).toEqual([]);
    expect(boxesWithTag('sfx')).toEqual([]);
  });

  // Line numbers are unique within a page in every document this app writes;
  // the lookup joins on a per-page map for speed rather than a scan per box,
  // and a map keeps only the FIRST line of a number - which is what `.find`
  // answered too. Pinned so an optimisation cannot quietly change the answer.
  it('joins each box to the first line carrying its number', () => {
    const pages = [
      {
        id: 1,
        lines: [
          { n: 1, type: 'dialogue', tags: ['shout'] },
          { n: 1, type: 'sfx' },
        ],
        boxes: [{ id: 'b1', lineN: 1 }],
      },
    ];
    const hits = boxesWithTag('shout', pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(pages[0].lines[0]);
    expect(boxesWithTag('sfx', pages)).toEqual([]);
  });
});
