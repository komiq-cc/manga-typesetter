import { describe, it, expect, afterEach } from 'vitest';
import { recordForExport } from './package-flow.js';
import { setLegacyTypeset, legacyTypesetting } from './data.js';

describe('recordForExport', () => {
  afterEach(() => {
    setLegacyTypeset('plain');
  });

  it('stamps legacyTypesetting when the record has no typesetting field (smart)', () => {
    setLegacyTypeset('smart');
    const record = { id: 'c1', number: 1, title: 'Chapter 1', pages: [] };
    const exported = recordForExport(record);
    expect(exported.typesetting).toEqual({ mode: 'smart', version: 1 });
    expect(exported.typesetting).toEqual(legacyTypesetting());
  });

  it('stamps legacyTypesetting when the record has no typesetting field (plain)', () => {
    setLegacyTypeset('plain');
    const record = { id: 'c1', number: 1, title: 'Chapter 1', pages: [] };
    const exported = recordForExport(record);
    expect(exported.typesetting).toEqual({ mode: 'plain', version: 1 });
    expect(exported.typesetting).toEqual(legacyTypesetting());
  });

  it('stamps legacyTypesetting when the typesetting field is null', () => {
    setLegacyTypeset('smart');
    const record = { id: 'c1', number: 1, typesetting: null, pages: [] };
    const exported = recordForExport(record);
    expect(exported.typesetting).toEqual({ mode: 'smart', version: 1 });
    expect(exported.typesetting).toEqual(legacyTypesetting());
  });

  it('does not mutate the source record and creates a shallow copy', () => {
    setLegacyTypeset('smart');
    const pages = [{ id: 1, file: 'p1.png' }];
    const record = { id: 'c1', number: 1, pages };
    const exported = recordForExport(record);
    expect(record.typesetting).toBeUndefined();
    expect(exported).not.toBe(record);
    expect(exported.pages).toBe(record.pages);
    expect(exported.typesetting).toEqual({ mode: 'smart', version: 1 });
  });

  it('preserves existing typesetting when already present', () => {
    setLegacyTypeset('plain');
    const recordSmart = { id: 'c1', typesetting: { mode: 'smart', version: 1 } };
    expect(recordForExport(recordSmart).typesetting).toEqual({ mode: 'smart', version: 1 });

    setLegacyTypeset('smart');
    const recordPlain = { id: 'c2', typesetting: { mode: 'plain', version: 1 } };
    expect(recordForExport(recordPlain).typesetting).toEqual({ mode: 'plain', version: 1 });

    const recordCustomVersion = { id: 'c3', typesetting: { mode: 'smart', version: 2 } };
    expect(recordForExport(recordCustomVersion).typesetting).toEqual({ mode: 'smart', version: 2 });
  });
});
