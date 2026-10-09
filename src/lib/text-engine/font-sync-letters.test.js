import { describe, it, expect, vi } from 'vitest';
import { createFontSync, COVERAGE_MAX } from './font-sync.js';
import { fakeRustEngine, fakeNative, SFNT } from '../../test/fake-rust-engine.js';

// A letter the face lacks, on a stand-in engine and a stand-in native side:
// who is asked, how often, what the chain becomes and in what order, and what
// a box is told meanwhile. The rule itself (which family has a letter) is the
// native side's, tested in src-tauri/src/font_coverage.rs; the same wiring
// against the real engine is font-fallback.engine.test.js.

const sysEntry = (name, slots = ['regular']) => ({ name, system: true, faces: Object.fromEntries(slots.map((s) => [s, { file: null }])) });
const cp = (ch) => ch.codePointAt(0);
const cps = (text) => [...text].map(cp);
const face = (name, over = {}) => ({ name, key: `${name}/20`, size: 20, bold: false, italic: false, ...over });

// A machine with a Latin last resort and three families that have other
// letters; `coverage` is the order the native side looks in.
const MACHINE = [
  ['Lucida Grande', '→✓'],
  ['Hiragino Sans', 'あいう漢♥→'],
  ['Apple SD Gothic Neo', '한漢'],
];

function setup({ coverage = MACHINE, system, hold = false, native = true, failing = [] } = {}) {
  const names = system ?? ['Helvetica Neue', ...(Array.isArray(coverage) ? coverage.map(([name]) => name) : [])];
  const engine = fakeRustEngine();
  if (Array.isArray(coverage)) for (const [name, letters] of coverage) engine.cover(name, letters);
  const fonts = { user: [], system: names.map((name) => sysEntry(name)) };
  const files = Object.fromEntries(names.filter((n) => !failing.includes(n)).map((name) => [name, [{ slots: { regular: 0 }, bytes: SFNT() }]]));
  const invoke = fakeNative(files, { hold, coverage });
  const onArrival = vi.fn();
  const sync = createFontSync({
    engine,
    fonts,
    os: 'macos',
    systemFace: (family, slot, known) => invoke('system_font_face', { family, slot, known }),
    toSfnt: null,
    systemCoverage: native ? (codePoints) => invoke('system_font_coverage', { codePoints }) : null,
    onArrival,
  });
  const questions = () => invoke.calls.filter(([cmd]) => cmd === 'system_font_coverage').map(([, args]) => args.codePoints);
  const fetched = () => invoke.calls.filter(([cmd]) => cmd === 'system_font_face').map(([, args]) => args.family);
  return { engine, fonts, invoke, onArrival, sync, questions, fetched };
}

// The user's own Latin face, in and ready, and the last resort with it.
async function withFace(ctx, name = 'Wild Words') {
  ctx.sync.setUserFace(name, 'regular', SFNT());
  ctx.sync.refresh();
  await ctx.sync.settled();
  ctx.invoke.calls.length = 0;
  ctx.onArrival.mockClear();
  return face(name);
}

describe('a letter the face lacks', () => {
  it('is not asked about when the face has every letter', async () => {
    const ctx = setup();
    const f = await withFace(ctx);
    expect(ctx.sync.lettersOf(f, 'HELLO THERE')).toEqual({ borrowed: [], none: [], pending: [] });
    expect(ctx.questions()).toEqual([]);
  });

  it('is drawn from the last resort when that has it, and nobody is asked', async () => {
    const ctx = setup();
    ctx.engine.cover('Helvetica Neue', 'Ω');
    const f = await withFace(ctx);
    expect(ctx.sync.lettersOf(f, 'Ω')).toEqual({ borrowed: [{ family: 'Helvetica Neue', letters: [cp('Ω')] }], none: [], pending: [] });
    expect(ctx.questions()).toEqual([]);
  });

  it('is asked about, its family sent for, and appended to the chain once it is in', async () => {
    const ctx = setup({ hold: true });
    const f = await withFaceHeld(ctx);
    // The first look sends the question, and the letter is pending.
    expect(ctx.sync.lettersOf(f, 'あ!')).toEqual({ borrowed: [], none: [], pending: [cp('あ')] });
    expect(ctx.questions()).toEqual([[cp('あ')]]);
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue']);
    expect(ctx.onArrival).not.toHaveBeenCalled();
    // The answer names a family: still pending, while its file is read.
    ctx.invoke.release();
    await flush();
    expect(ctx.fetched()).toEqual(['Hiragino Sans']);
    expect(ctx.sync.lettersOf(f, 'あ!').pending).toEqual([cp('あ')]);
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue']);
    expect(ctx.onArrival).not.toHaveBeenCalled();
    // The file lands: the family is in the chain, after the last resort, and
    // whoever measured is told, once.
    ctx.invoke.release();
    await ctx.sync.settled();
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans']);
    expect(ctx.onArrival).toHaveBeenCalledTimes(1);
    expect(ctx.sync.lettersOf(f, 'あ!')).toEqual({ borrowed: [{ family: 'Hiragino Sans', letters: [cp('あ')] }], none: [], pending: [] });
    expect(ctx.sync.snapshot().letters).toEqual({ [cp('あ')]: 'Hiragino Sans' });
  });

  it('is one question for a set of letters, not one a box or a layout', async () => {
    const ctx = setup();
    const f = await withFace(ctx);
    // Twenty boxes, laid out five times each, in two faces of the family.
    for (let i = 0; i < 100; i++) ctx.sync.lettersOf(i % 2 ? f : face('Wild Words', { bold: true }), 'あい → う');
    expect(ctx.questions()).toEqual([cps('→あいう').sort((a, b) => a - b)]);
    await ctx.sync.settled();
    for (let i = 0; i < 100; i++) ctx.sync.lettersOf(f, 'あい → う');
    expect(ctx.questions()).toHaveLength(1);
    // Each family is sent for once, however many letters it is behind.
    expect(ctx.fetched().sort()).toEqual(['Hiragino Sans', 'Lucida Grande']);
  });

  it('asks only about the letters that are new, and never about one twice', async () => {
    const ctx = setup({ hold: true });
    const f = await withFaceHeld(ctx);
    // Typing: every keystroke is another string, and the answers are slow.
    ctx.sync.lettersOf(f, 'あ');
    ctx.sync.lettersOf(f, 'あい');
    ctx.sync.lettersOf(f, 'あい');
    ctx.sync.lettersOf(f, 'あいう☃');
    expect(ctx.questions()).toEqual([[cp('あ')], [cp('い')], [cp('☃'), cp('う')].sort((a, b) => a - b)]);
    while (ctx.sync.snapshot().letters[cp('あ')] === 'pending') {
      ctx.invoke.release();
      await flush();
    }
    await ctx.sync.settled();
    ctx.sync.lettersOf(f, 'あいう☃ again');
    expect(ctx.questions()).toHaveLength(3);
    expect(ctx.fetched()).toEqual(['Hiragino Sans']);
  });

  it('remembers that no installed font has a letter, and does not ask again', async () => {
    const ctx = setup();
    const f = await withFace(ctx);
    expect(ctx.sync.lettersOf(f, '☃').pending).toEqual([cp('☃')]);
    await ctx.sync.settled();
    expect(ctx.onArrival).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) expect(ctx.sync.lettersOf(f, '☃ ☃')).toEqual({ borrowed: [], none: [cp('☃')], pending: [] });
    expect(ctx.questions()).toEqual([[cp('☃')]]);
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue']);
    expect(ctx.sync.snapshot().letters).toEqual({ [cp('☃')]: null });
  });

  it('remembers a question that failed, and does not ask it in a loop', async () => {
    const ctx = setup({ coverage: 'fail', system: ['Helvetica Neue'] });
    const f = await withFace(ctx);
    expect(ctx.sync.lettersOf(f, 'あ').pending).toEqual([cp('あ')]);
    await ctx.sync.settled();
    expect(ctx.onArrival).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) expect(ctx.sync.lettersOf(f, 'あ')).toEqual({ borrowed: [], none: [cp('あ')], pending: [] });
    await ctx.sync.settled();
    expect(ctx.questions()).toEqual([[cp('あ')]]);
  });

  it('remembers a family that could not be read: its letters are ones nothing has', async () => {
    const ctx = setup({ failing: ['Hiragino Sans'] });
    const f = await withFace(ctx);
    ctx.sync.lettersOf(f, 'あ한');
    await ctx.sync.settled();
    expect(ctx.sync.lettersOf(f, 'あ한')).toEqual({ borrowed: [{ family: 'Apple SD Gothic Neo', letters: [cp('한')] }], none: [cp('あ')], pending: [] });
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue', 'Apple SD Gothic Neo']);
    // Nothing is sent for twice, and nothing is asked twice.
    for (let i = 0; i < 5; i++) ctx.sync.lettersOf(f, 'あ한');
    await ctx.sync.settled();
    expect(ctx.fetched().filter((n) => n === 'Hiragino Sans')).toHaveLength(1);
    expect(ctx.questions()).toHaveLength(1);
    expect(ctx.sync.missing('Hiragino Sans')).toBe(true);
  });

  it('keeps a family the list does not have out of the chain: there is nothing to send for', async () => {
    // The native side scanned again and found a family this side has not heard of.
    const ctx = setup({ system: ['Helvetica Neue', 'Lucida Grande'] });
    const f = await withFace(ctx);
    ctx.sync.lettersOf(f, 'あ→');
    await ctx.sync.settled();
    expect(ctx.sync.lettersOf(f, 'あ→')).toEqual({ borrowed: [{ family: 'Lucida Grande', letters: [cp('→')] }], none: [cp('あ')], pending: [] });
    expect(ctx.fetched()).toEqual(['Lucida Grande']);
  });

  it('has nobody to ask in a plain browser, and says so by not waiting', async () => {
    const ctx = setup({ native: false });
    const f = await withFace(ctx);
    expect(ctx.sync.canAskLetters()).toBe(false);
    expect(ctx.sync.lettersOf(f, 'あ')).toEqual({ borrowed: [], none: [cp('あ')], pending: [] });
    expect(ctx.invoke.calls).toEqual([]);
  });
});

describe('the chain', () => {
  it('is in the native side’s order, whichever family was asked for first', async () => {
    const order = async (texts) => {
      const ctx = setup();
      const f = await withFace(ctx);
      for (const text of texts) {
        ctx.sync.lettersOf(f, text);
        await ctx.sync.settled();
      }
      return ctx.engine.fallbacks();
    };
    const want = ['Helvetica Neue', 'Lucida Grande', 'Hiragino Sans', 'Apple SD Gothic Neo'];
    expect(await order(['한', 'あ', '✓'])).toEqual(want);
    expect(await order(['✓', 'あ', '한'])).toEqual(want);
    expect(await order(['あ✓한'])).toEqual(want);
  });

  it('asks about a letter another borrowed family happens to have, so its own family is in', async () => {
    // Hangul first: the Korean family is in the chain, and it has 漢 too. The
    // engine would draw 漢 from it and report nothing missing - and the
    // chapter would be set in another font than when the kana came first.
    const ctx = setup();
    const f = await withFace(ctx);
    ctx.sync.lettersOf(f, '한');
    await ctx.sync.settled();
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue', 'Apple SD Gothic Neo']);
    expect(ctx.engine.missing(f, '漢')).toEqual([]);
    expect(ctx.sync.lettersOf(f, '漢').pending).toEqual([cp('漢')]);
    await ctx.sync.settled();
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans', 'Apple SD Gothic Neo']);
    expect(ctx.sync.lettersOf(f, '漢')).toEqual({ borrowed: [{ family: 'Hiragino Sans', letters: [cp('漢')] }], none: [], pending: [] });
  });

  it('is one chain for every face: a second family borrows the same letters from the same place', async () => {
    const ctx = setup();
    const f = await withFace(ctx);
    ctx.sync.setUserFace('Anime Ace', 'regular', SFNT());
    ctx.sync.lettersOf(f, 'あ');
    await ctx.sync.settled();
    ctx.invoke.calls.length = 0;
    expect(ctx.sync.lettersOf(face('Anime Ace'), 'あ')).toEqual({ borrowed: [{ family: 'Hiragino Sans', letters: [cp('あ')] }], none: [], pending: [] });
    expect(ctx.invoke.calls).toEqual([]);
  });

  it('sorts the order as the native side compares it, code point by code point', async () => {
    // U+FF21 is below U+1F600 as a code point and above it as UTF-16.
    const ctx = setup({ coverage: [['Astral', '♥'], ['Fullwidth', '♪']], system: ['Helvetica Neue', 'Astral', 'Fullwidth'] });
    const f = await withFace(ctx);
    const answers = { [cp('♥')]: { name: 'Astral', order: '1\u{1F600}' }, [cp('♪')]: { name: 'Fullwidth', order: '1Ａ' } };
    const sync = createFontSync({
      engine: ctx.engine,
      fonts: ctx.fonts,
      os: 'macos',
      systemFace: (family, slot, known) => ctx.invoke('system_font_face', { family, slot, known }),
      systemCoverage: async (asked) => ({ families: asked.map((c) => ({ ...answers[c], codePoints: [c] })), none: [] }),
    });
    sync.setUserFace('Wild Words', 'regular', SFNT());
    sync.refresh();
    await sync.settled();
    sync.lettersOf(f, '♥♪');
    await sync.settled();
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue', 'Fullwidth', 'Astral']);
  });

  it('splits a question longer than the native side takes', async () => {
    const ctx = setup({ coverage: [] });
    const f = await withFace(ctx);
    const text = String.fromCodePoint(...Array.from({ length: COVERAGE_MAX + 500 }, (_, i) => 0x4e00 + i));
    expect(ctx.sync.lettersOf(f, text).pending).toHaveLength(COVERAGE_MAX + 500);
    expect(ctx.questions().map((q) => q.length)).toEqual([COVERAGE_MAX, 500]);
    await ctx.sync.settled();
    expect(ctx.sync.lettersOf(f, text).none).toHaveLength(COVERAGE_MAX + 500);
    expect(ctx.questions()).toHaveLength(2);
  });
});

describe('after another scan', () => {
  it('asks again: a font may have been installed, and one that failed gets another try', async () => {
    const ctx = setup({ failing: ['Hiragino Sans'] });
    const f = await withFace(ctx);
    ctx.sync.lettersOf(f, 'あ☃한');
    await ctx.sync.settled();
    expect(ctx.sync.lettersOf(f, 'あ☃한').none).toEqual([cp('あ'), cp('☃')]);
    expect(ctx.questions()).toHaveLength(1);
    // The same list object is no scan at all.
    expect(ctx.sync.refresh()).toBe(false);
    ctx.fonts.system = [...ctx.fonts.system];
    expect(ctx.sync.refresh()).toBe(true);
    expect(ctx.sync.refresh()).toBe(false);
    expect(ctx.sync.snapshot().letters).toEqual({});
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue']);
    expect(ctx.sync.lettersOf(f, 'あ☃한').pending).toEqual(cps('あ☃한'));
    await ctx.sync.settled();
    expect(ctx.questions()).toHaveLength(2);
    // The family that was in stays in the engine and is not read again.
    expect(ctx.fetched().filter((n) => n === 'Apple SD Gothic Neo')).toHaveLength(1);
    expect(ctx.engine.fallbacks()).toEqual(['Helvetica Neue', 'Apple SD Gothic Neo']);
  });

  it('drops an answer that was on its way to what the scan threw away', async () => {
    const ctx = setup({ hold: true });
    const f = await withFaceHeld(ctx);
    ctx.sync.lettersOf(f, 'あ');
    ctx.fonts.system = [...ctx.fonts.system];
    ctx.sync.refresh();
    ctx.invoke.release();
    await flush();
    expect(ctx.sync.snapshot().letters).toEqual({});
    expect(ctx.fetched()).toEqual([]);
  });
});

describe('taking it all back', () => {
  it('forgets the letters and empties the chain, and an answer that lands afterwards changes nothing', async () => {
    const ctx = setup({ hold: true });
    const f = await withFaceHeld(ctx);
    ctx.sync.lettersOf(f, 'あ');
    ctx.sync.dispose();
    ctx.invoke.release();
    await flush();
    ctx.invoke.release();
    await ctx.sync.settled();
    expect(ctx.engine.fallbacks()).toEqual([]);
    expect(ctx.engine.registered()).toEqual({});
    expect(ctx.onArrival).not.toHaveBeenCalled();
  });
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// As `withFace`, for a native side that holds its answers back: they are let
// through until the last resort is in, and held again from there.
async function withFaceHeld(ctx, name = 'Wild Words') {
  ctx.sync.setUserFace(name, 'regular', SFNT());
  ctx.sync.refresh();
  while (ctx.sync.lastResort() !== 'Helvetica Neue') {
    ctx.invoke.release();
    await flush();
  }
  ctx.invoke.calls.length = 0;
  ctx.onArrival.mockClear();
  return face(name);
}
