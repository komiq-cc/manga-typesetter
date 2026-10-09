import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../../test/rust-engine.js';
import { systemFaceAnswer } from '../../test/font-collection.js';
import { coverage, covers } from '../../../scripts/text-port/lib/cmap.mjs';
import { createFontSync } from './font-sync.js';

// ===========================================================================
// A letter the face lacks, on the real engine and the fixture fonts
// ===========================================================================
// font-sync-letters.test.js pins the wiring on a stand-in. Here the real
// adapter measures and paints: a line that mixes Latin with letters the Latin
// face lacks, before and after the family that has them joins the chain. That
// the second face was used is read off the numbers - the advance is the sum
// of the parts each font measures alone, and the ink and the picture of the
// borrowed letter are the lending font's own.
//
// No font in src/test/fonts has kana. DejaVu Sans has the heart, the note and
// an astral letter (U+1F600) that Comic Neue and Bangers lack, so those stand
// in for them; kana stay what they are here, letters nothing has.

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const oblique = fixtureFont('DejaVuSans-Oblique.ttf');

const SIZE = 40;
const face = (name, extra = {}) => ({ key: `${extra.italic ? 'italic ' : ''}${extra.bold ? 700 : 400} ${SIZE}px ${name}`, name, bold: false, italic: false, size: SIZE, css: name, ...extra });
const sysEntry = (name, slots) => ({ name, system: true, faces: Object.fromEntries(slots.map((s) => [s, { file: null }])) });
const cp = (ch) => ch.codePointAt(0);
const HEART = '♥';
const NOTE = '♪';
const GRIN = '\u{1F600}';

// What each font measures alone, from an engine that holds nothing else and
// has no chain.
let alone;
beforeAll(async () => {
  const e = await rustEngine({ fixtures: false });
  e.addFace('Comic Neue', 'regular', comic);
  e.addFace('Bangers', 'regular', bangers);
  e.addFace('DejaVu Sans', 'regular', dejavu);
  alone = {
    advance: (name, text) => e.advance(face(name), text),
    ink: (name, text) => e.lineInk(face(name), text),
    glyph: (name, text) => e.glyphInk(face(name), text),
    wrap: (name, text, width) => e.wrapPlain(face(name), text, { width }),
    paint: (name, text) => picture(e, face(name), text),
  };
  // The premise: which of these letters each font has.
  expect(e.missing(face('Comic Neue'), `${HEART}${NOTE}${GRIN}あ`)).toEqual([cp(HEART), cp(NOTE), cp(GRIN), cp('あ')]);
  expect(e.missing(face('Bangers'), `${HEART}${NOTE}${GRIN}あ`)).toEqual([cp(HEART), cp(NOTE), cp(GRIN), cp('あ')]);
  expect(e.missing(face('DejaVu Sans'), `${HEART}${NOTE}${GRIN}あ`)).toEqual([cp('あ')]);
});

// One line of text painted by the engine, as the bytes of its picture.
function picture(engine, f, text) {
  return engine.low.paint({ width: 160, height: 80, lines: [{ face: engine.handle(f), text, x: 20, y: 60 }], fill: 0x000000ff });
}
const inked = (img) => img.data.reduce((n, v, i) => n + (i % 4 === 3 && v ? 1 : 0), 0);

let engine;
beforeEach(async () => {
  engine = await rustEngine({ fixtures: false });
});

// The machine: the user's two Latin fonts, and one installed family that has
// more. With no family of the OS list installed the last resort is the user's
// font that sorts first, Bangers - a Latin face, as it is on every OS list.
// The native side's coverage answer is worked out from the fixture's `cmap` by
// the harness's own reader, so it comes from neither the engine nor the code
// under test.
function machine({ hold = false } = {}) {
  const files = { 'DejaVu Sans': [{ slots: { regular: 0 }, bytes: dejavu }, { slots: { italic: 0 }, bytes: oblique }] };
  const ranges = coverage(dejavu).ranges;
  const calls = [];
  const waiting = [];
  const gate = () => (hold ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve());
  const onArrival = vi.fn();
  // The scan lands after the user's library, as it does at launch: with no
  // font at all yet, the first installed family would be read to measure with.
  const fonts = { user: [], system: [] };
  const sync = createFontSync({
    engine,
    fonts,
    os: 'macos',
    systemFace: async (family, slot, known) => {
      calls.push(`face ${family}/${slot}`);
      await gate();
      return systemFaceAnswer(files[family].find((f) => slot in f.slots).slots, files[family].find((f) => slot in f.slots).bytes, { known });
    },
    systemCoverage: async (codePoints) => {
      calls.push(`coverage ${codePoints.map((c) => c.toString(16)).join(' ')}`);
      await gate();
      const mine = codePoints.filter((c) => covers(ranges, c));
      return { families: mine.length ? [{ name: 'DejaVu Sans', order: '1dejavu sans\u0001DejaVu Sans', codePoints: mine }] : [], none: codePoints.filter((c) => !covers(ranges, c)) };
    },
    onArrival,
  });
  sync.setUserFace('Comic Neue', 'regular', comic);
  sync.setUserFace('Bangers', 'regular', bangers);
  fonts.system = [sysEntry('DejaVu Sans', ['regular', 'italic'])];
  sync.refresh();
  expect(calls).toEqual([]);
  expect(sync.lastResort()).toBe('Bangers');
  expect(engine.fallbacks()).toEqual(['Bangers']);
  const release = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  return { sync, calls, onArrival, release };
}

const TEXT = `I ${HEART} YOU ${NOTE}`;

describe('a line that mixes a Latin face with letters it lacks', () => {
  it('is measured with the empty box until the family that has them is in, then with that family', async () => {
    const { sync, calls, onArrival, release } = machine({ hold: true });
    const f = face('Comic Neue');
    // Before: neither the face nor the last resort has them, and they are Comic Neue's empty box.
    const before = { advance: engine.advance(f, TEXT), heart: engine.lineInk(f, HEART) };
    expect(engine.missing(f, TEXT)).toEqual([cp(HEART), cp(NOTE)]);
    expect(before.advance).toBe(alone.advance('Comic Neue', TEXT));
    expect(before.heart).toEqual(alone.ink('Comic Neue', HEART));

    // Looking is what asks: one question, both letters.
    expect(sync.lettersOf(f, TEXT)).toEqual({ borrowed: [], none: [], pending: [cp(HEART), cp(NOTE)], unread: [] });
    expect(calls).toEqual(['coverage 2665 266a']);
    // Nothing moves while the answer and the file are on their way.
    release();
    await vi.waitFor(() => expect(calls).toContain('face DejaVu Sans/regular'));
    expect(engine.advance(f, TEXT)).toBe(before.advance);
    expect(sync.lettersOf(f, TEXT).pending).toEqual([cp(HEART), cp(NOTE)]);
    expect(onArrival).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) {
      release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await sync.settled();
    expect(onArrival).toHaveBeenCalledTimes(1);
    expect(engine.fallbacks()).toEqual(['Bangers', 'DejaVu Sans']);
    expect(engine.facesOf('DejaVu Sans')).toEqual(['regular', 'italic']);

    // After. The advance: each stretch is shaped by its own font, so the line
    // is exactly the sum of what each font measures alone.
    const parts = [['Comic Neue', 'I '], ['DejaVu Sans', HEART], ['Comic Neue', ' YOU '], ['DejaVu Sans', NOTE]];
    const sum = parts.reduce((w, [name, text]) => w + alone.advance(name, text), 0);
    const after = engine.advance(f, TEXT);
    expect(after).toBeCloseTo(sum, 9);
    expect(after).not.toBe(before.advance);
    // The same letters in the lending font's own widths, not the empty box's.
    expect(engine.advance(f, HEART)).toBe(alone.advance('DejaVu Sans', HEART));
    expect(engine.advance(f, HEART)).not.toBe(alone.advance('Comic Neue', HEART));
    // The ink: the borrowed letter's outline is DejaVu's, to the last digit.
    expect(engine.lineInk(f, HEART)).toEqual(alone.ink('DejaVu Sans', HEART));
    expect(engine.lineInk(f, HEART)).not.toEqual(before.heart);
    // A glyph asked for by itself (curved text) sits on the `middle` baseline
    // of the face that was asked, Comic Neue's: the note is DejaVu's outline,
    // as wide and as tall, placed on the line it is set in.
    const note = engine.glyphInk(f, NOTE);
    const own = alone.glyph('DejaVu Sans', NOTE);
    expect([note.width, note.left, note.right]).toEqual([own.width, own.left, own.right]);
    expect(note.ascent + note.descent).toBeCloseTo(own.ascent + own.descent, 9);
    // How far a font's `middle` baseline is above its alphabetic one, read
    // off a letter it has: the note's top is DejaVu's, less Comic Neue's middle.
    const middle = alone.ink('Comic Neue', 'A').ascent - alone.glyph('Comic Neue', 'A').ascent;
    expect(note.ascent).toBeCloseTo(alone.ink('DejaVu Sans', NOTE).ascent - middle, 9);
    expect(note.ascent).not.toBeCloseTo(own.ascent, 3);
    // The line's ink ends where the note's does: the last part is DejaVu's.
    const line = engine.lineInk(f, TEXT);
    const head = parts.slice(0, 3).reduce((w, [name, text]) => w + alone.advance(name, text), 0);
    expect(line.right).toBeCloseTo(head + alone.ink('DejaVu Sans', NOTE).right, 6);
    // Nothing is missing any more, and the look says where each letter came from.
    expect(engine.missing(f, TEXT)).toEqual([]);
    expect(sync.lettersOf(f, TEXT)).toEqual({ borrowed: [{ family: 'DejaVu Sans', letters: [cp(HEART), cp(NOTE)] }], none: [], pending: [], unread: [] });
    // Asked once, read once a file.
    expect(calls).toEqual(['coverage 2665 266a', 'face DejaVu Sans/regular', 'face DejaVu Sans/italic']);
  });

  it('is painted with the lending font’s glyph where it was an empty box', async () => {
    const { sync } = machine();
    const f = face('Comic Neue');
    const before = picture(engine, f, HEART);
    expect(Buffer.from(before.data).equals(Buffer.from(alone.paint('Comic Neue', HEART).data))).toBe(true);
    sync.lettersOf(f, HEART);
    await sync.settled();
    const after = picture(engine, f, HEART);
    expect(inked(after)).toBeGreaterThan(0);
    expect(Buffer.from(after.data).equals(Buffer.from(alone.paint('DejaVu Sans', HEART).data))).toBe(true);
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(false);
    // And the Latin beside it is still Comic Neue's.
    expect(Buffer.from(picture(engine, f, 'WAVE').data).equals(Buffer.from(alone.paint('Comic Neue', 'WAVE').data))).toBe(true);
  });

  it('leaves a line the face covers bit for bit what it was', async () => {
    const { sync } = machine();
    const f = face('Comic Neue');
    const lines = ['WAVE', 'AVATAR To. fi', 'Hello, world!'];
    const before = lines.map((text) => [engine.advance(f, text), engine.lineInk(f, text), engine.wrapPlain(f, text, { width: 90 })]);
    sync.lettersOf(f, TEXT);
    await sync.settled();
    expect(engine.fallbacks()).toEqual(['Bangers', 'DejaVu Sans']);
    expect(lines.map((text) => [engine.advance(f, text), engine.lineInk(f, text), engine.wrapPlain(f, text, { width: 90 })])).toEqual(before);
    for (const text of lines) expect(engine.advance(f, text)).toBe(alone.advance('Comic Neue', text));
  });

  it('borrows an astral letter the same way', async () => {
    const { sync, calls } = machine();
    const f = face('Bangers');
    expect(sync.lettersOf(f, `HA ${GRIN}`).pending).toEqual([cp(GRIN)]);
    await sync.settled();
    expect(calls[0]).toBe('coverage 1f600');
    expect(engine.advance(f, GRIN)).toBe(alone.advance('DejaVu Sans', GRIN));
    expect(engine.lineInk(f, GRIN)).toEqual(alone.ink('DejaVu Sans', GRIN));
    expect(engine.advance(f, `HA ${GRIN}`)).toBeCloseTo(alone.advance('Bangers', 'HA ') + alone.advance('DejaVu Sans', GRIN), 9);
    expect(sync.lettersOf(f, `HA ${GRIN}`)).toEqual({ borrowed: [{ family: 'DejaVu Sans', letters: [cp(GRIN)] }], none: [], pending: [], unread: [] });
  });

  it('keeps a letter no installed font has as the face’s empty box, and says so once', async () => {
    const { sync, calls } = machine();
    const f = face('Comic Neue');
    const before = engine.advance(f, 'あ!');
    expect(sync.lettersOf(f, 'あ!').pending).toEqual([cp('あ')]);
    await sync.settled();
    for (let i = 0; i < 3; i++) expect(sync.lettersOf(f, 'あ!')).toEqual({ borrowed: [], none: [cp('あ')], pending: [], unread: [] });
    expect(calls).toEqual(['coverage 3042']);
    expect(engine.fallbacks()).toEqual(['Bangers']);
    expect(engine.advance(f, 'あ!')).toBe(before);
    expect(engine.missing(f, 'あ!')).toEqual([cp('あ')]);
  });

  it('breaks plain text against the borrowed widths', async () => {
    const { sync } = machine();
    const f = face('Comic Neue');
    const text = `${HEART}${HEART}${HEART} ${HEART}${HEART}${HEART} ${HEART}${HEART}${HEART}`;
    const width = alone.advance('DejaVu Sans', `${HEART}${HEART}${HEART} ${HEART}${HEART}${HEART}`) + 1;
    sync.lettersOf(f, text);
    await sync.settled();
    // Two groups to a line by DejaVu's hearts; the empty box is another width.
    expect(engine.wrapPlain(f, text, { width })).toEqual([`${HEART}${HEART}${HEART} ${HEART}${HEART}${HEART}`, `${HEART}${HEART}${HEART}`]);
    expect(alone.advance('Comic Neue', HEART)).not.toBe(alone.advance('DejaVu Sans', HEART));
  });

  it('says what the face lacks before each family of the chain is asked', async () => {
    const { sync } = machine();
    const f = face('Comic Neue');
    sync.lettersOf(f, TEXT);
    await sync.settled();
    const text = `é${HEART}あ`;
    expect(engine.missing(f, text, 0)).toEqual([cp(HEART), cp('あ')]);
    expect(engine.missing(f, text, 1)).toEqual([cp(HEART), cp('あ')]);
    expect(engine.missing(f, text, 2)).toEqual([cp('あ')]);
    expect(engine.missing(f, text)).toEqual([cp('あ')]);
    // Asking with a shorter chain leaves measuring on the whole one.
    expect(engine.advance(f, HEART)).toBe(alone.advance('DejaVu Sans', HEART));
  });
});

// ===========================================================================
// The face that was judged is the face that draws
// ===========================================================================
// The native side judges a family by ONE face, its regular. "Alpha" here has
// a letter in its regular (DejaVu Sans Oblique's file) and not in its bold
// (Bangers' file); "Beta" (DejaVu Sans) has the letter too, and an Arabic
// letter Alpha lacks, so it is loaded for another box's sake. A bold box's
// letter is Alpha's - its regular, made bold by the engine - whether Beta is
// loaded or not and whichever of the two arrived first, and that is the
// family the editor names. Lent by the face CSS matching picks, it was the
// empty box (Alpha's bold has no such letter) until Beta happened to be
// loaded, and Beta's letter from then on.
//
// The letter is a Cyrillic one: the heart this was found with is the same
// drawing in both DejaVu files, and nothing would tell Alpha's from Beta's.
// Ж is slanted in the one and upright in the other.
describe('a bold box borrowing a letter the lending family has only in its regular', () => {
  const ZHE = 'Ж';
  const HAMZA = '\u0621';
  const FILES = {
    Alpha: [{ slots: { regular: 0 }, bytes: oblique }, { slots: { bold: 0 }, bytes: bangers }],
    Beta: [{ slots: { regular: 0 }, bytes: dejavu }],
  };
  // What the native side would answer: the first family, by name, whose REGULAR has the letter.
  const judged = [['Alpha', coverage(oblique).ranges], ['Beta', coverage(dejavu).ranges]];
  let lone;

  beforeAll(async () => {
    // Each lending face by itself, asked for in bold: the engine makes the bold.
    const e = await rustEngine({ fixtures: false });
    e.addFace('Comic Neue', 'regular', comic);
    e.addFace('Alpha regular', 'regular', oblique);
    e.addFace('Alpha bold', 'regular', bangers);
    e.addFace('Beta regular', 'regular', dejavu);
    lone = { advance: (name, text, bold = true) => e.advance(face(name, { bold }), text), ink: (name, text) => e.lineInk(face(name, { bold: true }), text) };
    // The premise.
    expect(e.missing(face('Alpha regular'), `${ZHE}${HAMZA}`)).toEqual([cp(HAMZA)]);
    expect(e.missing(face('Alpha bold'), ZHE)).toEqual([cp(ZHE)]);
    expect(e.missing(face('Beta regular'), `${ZHE}${HAMZA}`)).toEqual([]);
    // Told apart: the empty box by its width, the two letters by their ink.
    expect(lone.advance('Comic Neue', ZHE)).not.toBe(lone.advance('Alpha regular', ZHE));
    expect(lone.ink('Alpha regular', ZHE)).not.toEqual(lone.ink('Beta regular', ZHE));
  });

  function installed() {
    const calls = [];
    const fonts = { user: [], system: [] };
    const sync = createFontSync({
      engine,
      fonts,
      os: 'macos',
      systemFace: async (family, slot, known) => {
        const file = FILES[family].find((f) => slot in f.slots);
        return systemFaceAnswer(file.slots, file.bytes, { known });
      },
      systemCoverage: async (codePoints) => {
        calls.push(codePoints);
        const families = judged.map(([name]) => ({ name, order: `1${name.toLowerCase()}\u0001${name}`, codePoints: [] }));
        const none = [];
        for (const c of codePoints) {
          const at = judged.findIndex(([, ranges]) => covers(ranges, c));
          (at < 0 ? none : families[at].codePoints).push(c);
        }
        return { families: families.filter((f) => f.codePoints.length), none };
      },
    });
    sync.setUserFace('Comic Neue', 'regular', comic);
    fonts.system = [sysEntry('Alpha', ['regular', 'bold']), sysEntry('Beta', ['regular'])];
    sync.refresh();
    expect(sync.lastResort()).toBe('Comic Neue');
    return { sync, calls };
  }

  const bold = face('Comic Neue', { bold: true });
  const regular = face('Comic Neue');
  // The letter as a bold box and as a regular one measure and name it now.
  function letter(sync) {
    return {
      bold: engine.advance(bold, ZHE),
      ink: engine.lineInk(bold, ZHE),
      regular: engine.advance(regular, ZHE),
      named: [sync.lettersOf(bold, ZHE), sync.lettersOf(regular, ZHE)].map((l) => (l.pending.length ? 'pending' : l.borrowed.map((b) => b.family).join('+') || 'nothing')),
    };
  }
  async function borrow(sync, text) {
    sync.lettersOf(regular, text);
    await sync.settled();
  }

  for (const [first, second] of [[ZHE, HAMZA], [HAMZA, ZHE]]) {
    it(`is Alpha's letter made bold, with ${first === ZHE ? 'Alpha' : 'Beta'} the first to arrive`, async () => {
      const { sync } = installed();
      const want = {
        bold: lone.advance('Alpha regular', ZHE),
        ink: lone.ink('Alpha regular', ZHE),
        regular: lone.advance('Alpha regular', ZHE, false),
        named: ['Alpha', 'Alpha'],
      };
      await borrow(sync, first);
      sync.lettersOf(bold, ZHE);
      await sync.settled();
      // Whatever was loaded on the way here, the letter is settled now.
      expect(letter(sync)).toEqual(want);
      await borrow(sync, second);
      // Both families in, in the rule's order: nothing about the letter moved.
      expect(engine.fallbacks()).toEqual(['Comic Neue', 'Alpha', 'Beta']);
      expect(letter(sync)).toEqual(want);
      expect(want.ink).not.toEqual(lone.ink('Beta regular', ZHE));
      expect(want.bold).not.toBe(lone.advance('Comic Neue', ZHE));
      // And the Arabic letter, which Alpha's regular lacks, is Beta's in both weights.
      expect(engine.advance(bold, HAMZA)).toBe(lone.advance('Beta regular', HAMZA));
      expect(sync.lettersOf(bold, HAMZA).borrowed).toEqual([{ family: 'Beta', letters: [cp(HAMZA)] }]);
    });
  }

  it('lends the last resort by the face CSS picks: a real italic where it has one', async () => {
    // The other half of the rule. Nobody judged the last resort by one face:
    // the engine is asked, weight by weight, what it lacks.
    const e = engine;
    e.addFace('Comic Neue', 'regular', comic);
    e.addFace('Resort', 'regular', dejavu);
    e.addFace('Resort', 'italic', oblique);
    e.setFallbacks(['Resort']);
    const slanted = face('Comic Neue', { italic: true });
    expect(e.advance(slanted, ZHE)).toBe(e.advance(face('Resort', { italic: true }), ZHE));
    expect(e.resolveFace(face('Resort', { italic: true }))).toEqual({ slot: 'italic', fauxBold: false, fauxItalic: false });
    // Listed to lend by its first face, the same family lends its regular, slanted by the engine.
    e.setFallbacks([{ family: 'Resort', face: 'first' }]);
    e.addFace('Upright', 'regular', dejavu);
    expect(e.lineInk(slanted, ZHE)).toEqual(e.lineInk(face('Upright', { italic: true }), ZHE));
    expect(e.lineInk(slanted, ZHE)).not.toEqual(e.lineInk(face('Resort', { italic: true }), ZHE));
    expect(() => e.setFallbacks([{ family: 'Resort' }])).toThrow('fallbacks are a list of family names');
    expect(() => e.setFallbacks([7])).toThrow('fallbacks are a list of family names');
  });
});
