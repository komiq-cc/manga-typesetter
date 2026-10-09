import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../../../text-engine/js/engine.mjs';
import { lineFonts } from '../../../text-engine/js/line-fonts.mjs';
import { engineWasm, fixtureFont } from '../../test/rust-engine.js';

let engine;
let font;
let lender;
beforeAll(async () => {
  engine = await createEngine(engineWasm());
  font = engine.addFont(fixtureFont('ComicNeue-Regular.ttf'));
  lender = engine.addFont(fixtureFont('DejaVuSans.ttf'));
});

const queries = [
  ['advance', (face, text) => engine.advance(face, text)],
  ['fontBox', (face) => engine.fontBox(face)],
  ['lineInk', (face, text) => engine.lineInk(face, text)],
  ['glyphInk', (face, text) => engine.glyphInk(face, text)],
  ['wrapPlain', (face, text) => engine.wrapPlain(face, text, { width: 120 })],
  ['missing', (face, text) => engine.missing(face, text)],
  ['lineCarets', (face, text) => engine.lineCarets(face, text)],
];

const buffers = () => {
  const ex = engine.exports;
  return {
    result: Array.from(new Float64Array(ex.memory.buffer, ex.mt_result_ptr(), 16)),
    out: Array.from(new Uint8Array(ex.memory.buffer, ex.mt_out_ptr(), ex.mt_out_len())),
  };
};

function prime() {
  engine.fontInfo(font);
  engine.wrapPlain(engine.face(font, 30), 'WAIT!', { width: 120 });
  expect(buffers().result.some((n) => n !== 0)).toBe(true);
  expect(buffers().out.length).toBeGreaterThan(0);
}

describe('one fallback-chain rule for every measurement and caret query', () => {
  for (const [name, query] of queries) {
    it(`${name} refuses unknown and freed handles before reading an answer, clears it, and recovers`, () => {
      const live = engine.chainNew();
      engine.chainPush(live, lender);
      const gone = engine.chainNew();
      expect(engine.chainFree(gone)).toBe(true);
      const valid = engine.face(font, 30, { chain: live });
      try {
        for (const chain of [65535, gone]) {
          const bad = engine.face(font, 30, { chain });
          for (const text of ['', '\n', 'WAIT!', 'AΩB']) {
            prime();
            const expected = query(valid, text);
            const expectedBuffers = buffers();
            prime();
            expect(() => query(bad, text)).toThrow(/unknown font or chain/);
            expect(buffers()).toEqual({ result: Array(16).fill(0), out: [] });
            prime();
            expect(query(valid, text)).toEqual(expected);
            expect(buffers()).toEqual(expectedBuffers);
          }
        }
      } finally {
        expect(engine.chainFree(live)).toBe(true);
      }
    });
  }

  it('chain zero and a held empty chain keep the same answers, and a live list lends its glyph', () => {
    const empty = engine.chainNew();
    const live = engine.chainNew();
    engine.chainPush(live, lender);
    const plain = engine.face(font, 30);
    const heldEmpty = engine.face(font, 30, { chain: empty });
    const fallback = engine.face(font, 30, { chain: live });
    try {
      for (const [, query] of queries) {
        for (const text of ['', '\n', 'WAIT!', 'AΩB']) expect(query(heldEmpty, text)).toEqual(query(plain, text));
      }
      expect(engine.missing(plain, 'AΩB')).toEqual([1]);
      expect(engine.missing(fallback, 'AΩB')).toEqual([]);
      expect(engine.advance(fallback, 'Ω')).toBe(engine.advance(engine.face(lender, 30), 'Ω'));
      expect(lineFonts(engine, fallback, 'AΩB').map((part) => part.font)).toEqual([font, lender, font]);
    } finally {
      expect(engine.chainFree(empty)).toBe(true);
      expect(engine.chainFree(live)).toBe(true);
    }
  });

  it('lineFonts throws for a refused handle and recovers with balanced allocations', () => {
    const empty = engine.chainNew();
    const gone = engine.chainNew();
    expect(engine.chainFree(gone)).toBe(true);
    const ex = engine.exports;
    const held = new Map();
    const counted = {
      exports: {
        memory: ex.memory,
        mt_line_fonts: ex.mt_line_fonts,
        mt_alloc(size) {
          const ptr = ex.mt_alloc(size);
          held.set(ptr, size);
          return ptr;
        },
        mt_free(ptr, size) {
          expect(held.get(ptr)).toBe(size);
          held.delete(ptr);
          ex.mt_free(ptr, size);
        },
      },
    };
    try {
      for (const text of ['', 'WAIT!', 'AΩB']) {
        const valid = engine.face(font, 30, { chain: empty });
        const expected = lineFonts(counted, valid, text);
        expect(held.size).toBe(0);
        for (const chain of [65535, gone]) {
          expect(() => lineFonts(counted, engine.face(font, 30, { chain }), text)).toThrow(/unknown font or chain/);
          expect(held.size).toBe(0);
          expect(lineFonts(counted, valid, text)).toEqual(expected);
          expect(held.size).toBe(0);
        }
      }
    } finally {
      expect(engine.chainFree(empty)).toBe(true);
    }
  });
});
