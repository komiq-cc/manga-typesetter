import { describe, it, expect, afterEach } from 'vitest';
import { app } from './store.svelte.js';
import {
  faceSlot,
  parseFontFilename,
  groupFontFiles,
  resolveFace,
  FACE_SLOTS,
  parsePostScriptName,
  postScriptNameFor,
  _setPostScriptNameFor,
  _clearPostScriptNames,
  _restoreFontRecords,
  systemFontEntry,
} from './fonts.js';
import { fontGroups, isFontOffered, setBuiltinHidden, setSystemShown } from './font-menu.js';
import { BUILTIN_FONTS, emptyFaces } from './data.js';
import { setPref } from './prefs.svelte.js';

// Only the pure half of fonts.js is exercised here: registration needs FontFace
// and persistence needs IndexedDB, neither of which exists in the node test
// environment. What that half decides is the interesting part anyway - which
// file is which face of which family, and whether a real face exists at all,
// which is what the exporter asks before it lets Photoshop fake one.

const userFont = (name, faces) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), ...faces } });

afterEach(() => {
  app.fonts.user = [];
  _clearPostScriptNames();
});

describe('faceSlot', () => {
  it('maps the two style switches onto the four slots', () => {
    expect(faceSlot({ bold: false, italic: false })).toBe('regular');
    expect(faceSlot({ bold: true, italic: false })).toBe('bold');
    expect(faceSlot({ bold: false, italic: true })).toBe('italic');
    expect(faceSlot({ bold: true, italic: true })).toBe('boldItalic');
  });

  it('treats a missing or partial style as regular rather than throwing', () => {
    expect(faceSlot()).toBe('regular');
    expect(faceSlot({})).toBe('regular');
    expect(faceSlot({ italic: true })).toBe('italic');
  });
});

describe('parseFontFilename', () => {
  it('reads a plain file as the regular face', () => {
    expect(parseFontFilename('MangaTemple.ttf')).toEqual({ family: 'MangaTemple', slot: 'regular' });
  });

  it('keeps the pre-group family name for a suffix-less file so saved styles still resolve', () => {
    // This is exactly what the old cleanName() produced: extension off,
    // separators to spaces. A user upgrading must not have their fonts renamed.
    expect(parseFontFilename('Manga_Temple.ttf').family).toBe('Manga Temple');
    expect(parseFontFilename('CC-Wild-Words.otf').family).toBe('CC Wild Words');
  });

  it('detects the four faces across the separators real files use', () => {
    expect(parseFontFilename('MangaTemple-Bold.ttf')).toEqual({ family: 'MangaTemple', slot: 'bold' });
    expect(parseFontFilename('MangaTemple_Italic.otf')).toEqual({ family: 'MangaTemple', slot: 'italic' });
    expect(parseFontFilename('MangaTemple BoldItalic.woff2')).toEqual({ family: 'MangaTemple', slot: 'boldItalic' });
    expect(parseFontFilename('MangaTemple-Bold-Italic.ttf')).toEqual({ family: 'MangaTemple', slot: 'boldItalic' });
    expect(parseFontFilename('MangaTemple-Bold Italic.ttf')).toEqual({ family: 'MangaTemple', slot: 'boldItalic' });
  });

  it('reads a camel-cased suffix with no separator at all', () => {
    expect(parseFontFilename('MangaTempleBold.ttf')).toEqual({ family: 'MangaTemple', slot: 'bold' });
    expect(parseFontFilename('MangaTempleBoldItalic.ttf')).toEqual({ family: 'MangaTemple', slot: 'boldItalic' });
  });

  it('ignores case and the abbreviations foundries ship', () => {
    expect(parseFontFilename('ccwildwords-bold.TTF')).toEqual({ family: 'ccwildwords', slot: 'bold' });
    expect(parseFontFilename('CCWildWords-BI.ttf')).toEqual({ family: 'CCWildWords', slot: 'boldItalic' });
    expect(parseFontFilename('CCWildWords-BdIt.ttf')).toEqual({ family: 'CCWildWords', slot: 'boldItalic' });
    expect(parseFontFilename('Anime-Ace-Oblique.otf')).toEqual({ family: 'Anime Ace', slot: 'italic' });
  });

  it('files an explicit Regular under regular instead of into the family name', () => {
    expect(parseFontFilename('Roboto-Regular.ttf')).toEqual({ family: 'Roboto', slot: 'regular' });
  });

  it('collapses every weight above regular onto the single bold slot', () => {
    expect(parseFontFilename('AnimeAce-Semibold.otf').slot).toBe('bold');
    expect(parseFontFilename('AnimeAce-Black.otf').slot).toBe('bold');
    expect(parseFontFilename('AnimeAce-ExtraBold.otf').slot).toBe('bold');
    expect(parseFontFilename('AnimeAce-BlackItalic.otf').slot).toBe('boldItalic');
  });

  it('leaves a style word alone when it is part of the family name', () => {
    // A trailing token only counts when the whole token is a style word, so
    // "Blackletter" and "Words" survive and "BoldFace" keeps its Bold.
    expect(parseFontFilename('BoldFace.ttf')).toEqual({ family: 'BoldFace', slot: 'regular' });
    expect(parseFontFilename('BoldFace-Italic.ttf')).toEqual({ family: 'BoldFace', slot: 'italic' });
    expect(parseFontFilename('MangaBlackletter.otf')).toEqual({ family: 'MangaBlackletter', slot: 'regular' });
    expect(parseFontFilename('CCWildWords.ttf')).toEqual({ family: 'CCWildWords', slot: 'regular' });
  });

  it('never leaves the family empty', () => {
    expect(parseFontFilename('Bold.ttf').family).toBe('Bold');
  });
});

describe('groupFontFiles', () => {
  it('turns a four-file drop into one family with four faces', () => {
    const groups = groupFontFiles([
      'MangaTemple.ttf',
      'MangaTemple-Bold.ttf',
      'MangaTemple-Italic.ttf',
      'MangaTemple-BoldItalic.ttf',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('MangaTemple');
    expect(groups[0].faces).toEqual({
      regular: { file: 'MangaTemple.ttf' },
      bold: { file: 'MangaTemple-Bold.ttf' },
      italic: { file: 'MangaTemple-Italic.ttf' },
      boldItalic: { file: 'MangaTemple-BoldItalic.ttf' },
    });
  });

  it('keeps separate families apart and leaves unfilled slots null', () => {
    const groups = groupFontFiles(['Wildwords-Bold.ttf', 'AnimeAce.ttf', 'Wildwords.ttf']);
    expect(groups.map((g) => g.family)).toEqual(['Wildwords', 'AnimeAce']);
    const wild = groups[0];
    expect(wild.faces.regular).toEqual({ file: 'Wildwords.ttf' });
    expect(wild.faces.bold).toEqual({ file: 'Wildwords-Bold.ttf' });
    expect(wild.faces.italic).toBe(null);
    expect(wild.faces.boldItalic).toBe(null);
    expect(groups[1].faces.regular).toEqual({ file: 'AnimeAce.ttf' });
  });

  it('lets a later file take a slot an earlier one claimed', () => {
    const [g] = groupFontFiles(['Deft-Semibold.ttf', 'Deft-Black.ttf']);
    expect(g.faces.bold).toEqual({ file: 'Deft-Black.ttf' });
  });
});

describe('resolveFace', () => {
  it('says nothing is known about a font nobody has loaded, and calls both axes faux', () => {
    expect(resolveFace('Nothing At All', { bold: true })).toEqual({
      slot: 'bold',
      fauxBold: true,
      fauxItalic: false,
      known: false,
    });
    expect(resolveFace('Nothing At All', {}).known).toBe(false);
  });

  it('takes the exact face when the family has it', () => {
    app.fonts.user = [
      userFont('MangaTemple', {
        regular: { file: 'MangaTemple.ttf' },
        bold: { file: 'MangaTemple-Bold.ttf' },
      }),
    ];
    expect(resolveFace('MangaTemple', {})).toEqual({ slot: 'regular', fauxBold: false, fauxItalic: false, known: true });
    expect(resolveFace('MangaTemple', { bold: true })).toEqual({ slot: 'bold', fauxBold: false, fauxItalic: false, known: true });
  });

  // The reason this is per axis and not per slot: CSS matches a family one axis
  // at a time, so a bold-italic request against regular+bold gets the REAL bold
  // face with only the slant synthesised. Reporting both as faux would tell
  // Photoshop to smear a weight the renderer here never smeared.
  it('keeps the real weight and fauxes only the slant when the family has no italics', () => {
    app.fonts.user = [
      userFont('MangaTemple', {
        regular: { file: 'MangaTemple.ttf' },
        bold: { file: 'MangaTemple-Bold.ttf' },
      }),
    ];
    expect(resolveFace('MangaTemple', { bold: true, italic: true })).toEqual({
      slot: 'bold',
      fauxBold: false,
      fauxItalic: true,
      known: true,
    });
    expect(resolveFace('MangaTemple', { italic: true })).toEqual({
      slot: 'regular',
      fauxBold: false,
      fauxItalic: true,
      known: true,
    });
  });

  it('prefers a real italic face over the upright one, and fauxes the weight instead', () => {
    app.fonts.user = [
      userFont('Brushy', { regular: { file: 'Brushy.ttf' }, italic: { file: 'Brushy-Italic.ttf' } }),
    ];
    expect(resolveFace('Brushy', { bold: true, italic: true })).toEqual({
      slot: 'italic',
      fauxBold: true,
      fauxItalic: false,
      known: true,
    });
  });

  // A family whose only file is a bold one renders EVERYTHING in that face -
  // the browser has nothing else to match - so an unbolded box has to be
  // described as the bold face and not as a regular nobody drew.
  it('names the only face a family owns, even for a style that did not ask for it', () => {
    app.fonts.user = [userFont('Heavyish', { bold: { file: 'Heavyish-Bold.ttf' } })];
    expect(resolveFace('Heavyish', {})).toEqual({ slot: 'bold', fauxBold: false, fauxItalic: false, known: true });
  });

  it('answers for built-ins from what the Google Fonts request actually loads', () => {
    // Comic Neue is requested at 400/700 in both slants, Bangers at 400 only -
    // so bold Bangers is genuinely synthesised and has to admit it.
    expect(resolveFace('Comic Neue', { bold: true })).toEqual({ slot: 'bold', fauxBold: false, fauxItalic: false, known: true });
    expect(resolveFace('Comic Neue', { bold: true, italic: true }).slot).toBe('boldItalic');
    expect(resolveFace('Bangers', {})).toEqual({ slot: 'regular', fauxBold: false, fauxItalic: false, known: true });
    expect(resolveFace('Bangers', { bold: true })).toEqual({ slot: 'regular', fauxBold: true, fauxItalic: false, known: true });
    expect(resolveFace('Patrick Hand', { italic: true }).fauxItalic).toBe(true);
  });

  it('tolerates a missing style object', () => {
    expect(resolveFace('Bangers').slot).toBe('regular');
  });
});

describe('BUILTIN_FONTS faces', () => {
  it('gives every built-in a complete face map with a real regular', () => {
    for (const f of BUILTIN_FONTS) {
      expect(Object.keys(f.faces).sort()).toEqual([...FACE_SLOTS].sort());
      expect(f.faces.regular).toBeTruthy();
    }
  });
});

function buildSfnt({
  sfntVersion = 0x00010000,
  isTtc = false,
  records = [],
  includeNameTable = true,
  tableTag = 'name',
  corruptTableOffset = false,
} = {}) {
  let strBytes = [];
  const recHeaders = [];

  for (const r of records) {
    let bytes = [];
    if (r.rawBytes) {
      bytes = r.rawBytes;
    } else {
      const enc = r.encoding || (r.platformID === 1 ? 'mac' : 'utf-16be');
      if (enc === 'utf-16be') {
        for (let i = 0; i < r.str.length; i++) {
          const code = r.str.charCodeAt(i);
          bytes.push((code >> 8) & 0xff, code & 0xff);
        }
      } else {
        for (let i = 0; i < r.str.length; i++) {
          bytes.push(r.str.charCodeAt(i) & 0xff);
        }
      }
    }
    const offset = strBytes.length;
    const length = bytes.length;
    strBytes = strBytes.concat(bytes);
    recHeaders.push({
      platformID: r.platformID,
      encodingID: r.encodingID,
      languageID: r.languageID,
      nameID: r.nameID,
      length,
      offset,
    });
  }

  const nameTableSize = 6 + recHeaders.length * 12 + strBytes.length;
  const nameTable = new Uint8Array(nameTableSize);
  const nameView = new DataView(nameTable.buffer);
  nameView.setUint16(0, 0, false); // format 0
  nameView.setUint16(2, recHeaders.length, false); // count
  nameView.setUint16(4, 6 + recHeaders.length * 12, false); // stringOffset

  recHeaders.forEach((rec, idx) => {
    const o = 6 + idx * 12;
    nameView.setUint16(o, rec.platformID, false);
    nameView.setUint16(o + 2, rec.encodingID, false);
    nameView.setUint16(o + 4, rec.languageID, false);
    nameView.setUint16(o + 6, rec.nameID, false);
    nameView.setUint16(o + 8, rec.length, false);
    nameView.setUint16(o + 10, rec.offset, false);
  });

  const strOffset = 6 + recHeaders.length * 12;
  for (let i = 0; i < strBytes.length; i++) {
    nameTable[strOffset + i] = strBytes[i];
  }

  const sfntHeaderSize = 12;
  const tableDirSize = 16;
  const fontOffset = isTtc ? 16 : 0;
  const totalSfntSize = fontOffset + sfntHeaderSize + tableDirSize + (includeNameTable ? nameTableSize : 0);

  const totalBuf = new Uint8Array(totalSfntSize);
  const totalView = new DataView(totalBuf.buffer);

  if (isTtc) {
    totalView.setUint32(0, 0x74746366, false); // 'ttcf'
    totalView.setUint16(4, 1, false);
    totalView.setUint16(6, 0, false);
    totalView.setUint32(8, 1, false); // numFonts = 1
    totalView.setUint32(12, 16, false); // offsetTable[0] = 16
  }

  totalView.setUint32(fontOffset, sfntVersion, false);
  totalView.setUint16(fontOffset + 4, 1, false); // numTables = 1
  totalView.setUint16(fontOffset + 6, 16, false);
  totalView.setUint16(fontOffset + 8, 1, false);
  totalView.setUint16(fontOffset + 10, 0, false);

  let tagVal = 0x6e616d65;
  if (!includeNameTable || tableTag !== 'name') {
    tagVal = 0x68656164; // 'head'
  }
  const tagOffset = fontOffset + 12;
  totalView.setUint32(tagOffset, tagVal, false);
  totalView.setUint32(tagOffset + 4, 0, false);
  const tableDataOffset = corruptTableOffset ? 99999 : fontOffset + sfntHeaderSize + tableDirSize;
  totalView.setUint32(tagOffset + 8, tableDataOffset, false);
  totalView.setUint32(tagOffset + 12, nameTableSize, false);

  if (includeNameTable && !corruptTableOffset) {
    totalBuf.set(nameTable, fontOffset + sfntHeaderSize + tableDirSize);
  }

  return totalBuf;
}

describe('parsePostScriptName', () => {
  it('finds nameID 6 via the 3/1 UTF-16BE record', () => {
    const buf = buildSfnt({
      records: [
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: 'Arial-BoldMT' },
      ],
    });
    expect(parsePostScriptName(buf)).toBe('Arial-BoldMT');
    expect(parsePostScriptName(buf.buffer)).toBe('Arial-BoldMT');
  });

  it('prefers Windows UTF-16BE 0x0409 record over Macintosh record when both are present', () => {
    const buf = buildSfnt({
      records: [
        { platformID: 1, encodingID: 0, languageID: 0, nameID: 6, str: 'WildWords-Mac' },
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: 'WildWords-Win' },
      ],
    });
    expect(parsePostScriptName(buf)).toBe('WildWords-Win');
  });

  it('extracts nameID 6 from a macintosh-record-only font', () => {
    const buf = buildSfnt({
      records: [
        { platformID: 1, encodingID: 0, languageID: 0, nameID: 6, str: 'CCWildWords-Regular' },
      ],
    });
    expect(parsePostScriptName(buf)).toBe('CCWildWords-Regular');
  });

  it('reads from a TrueType Collection (ttcf) first font', () => {
    const buf = buildSfnt({
      isTtc: true,
      records: [
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: 'TTCFont-Regular' },
      ],
    });
    expect(parsePostScriptName(buf)).toBe('TTCFont-Regular');
  });

  it('accepts OTTO and true sfnt versions', () => {
    const ottoBuf = buildSfnt({
      sfntVersion: 0x4f54544f, // 'OTTO'
      records: [{ platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: 'OTTOFont-Bold' }],
    });
    expect(parsePostScriptName(ottoBuf)).toBe('OTTOFont-Bold');

    const trueBuf = buildSfnt({
      sfntVersion: 0x74727565, // 'true'
      records: [{ platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: 'TrueFont-Italic' }],
    });
    expect(parsePostScriptName(trueBuf)).toBe('TrueFont-Italic');
  });

  it('returns null when nameID 6 is absent from the name table', () => {
    const buf = buildSfnt({
      records: [
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 1, str: 'FamilyName' },
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 4, str: 'Full Font Name' },
      ],
    });
    expect(parsePostScriptName(buf)).toBe(null);
  });

  it('returns null for truncated or garbage buffers without throwing', () => {
    expect(parsePostScriptName(null)).toBe(null);
    expect(parsePostScriptName(undefined)).toBe(null);
    expect(parsePostScriptName(new Uint8Array(0))).toBe(null);
    expect(parsePostScriptName(new Uint8Array([0x00, 0x01, 0x00]))).toBe(null);
    expect(parsePostScriptName(new Uint8Array(100))).toBe(null);
    expect(parsePostScriptName('not a buffer')).toBe(null);
  });

  it('returns null when name table is missing or offsets are corrupt', () => {
    const noNameTable = buildSfnt({ includeNameTable: false });
    expect(parsePostScriptName(noNameTable)).toBe(null);

    const corruptOffset = buildSfnt({ corruptTableOffset: true });
    expect(parsePostScriptName(corruptOffset)).toBe(null);
  });

  it('strips NUL bytes and trims whitespace, returning null if empty', () => {
    const buf = buildSfnt({
      records: [
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: '  FontName-Bold\0\0  ' },
      ],
    });
    expect(parsePostScriptName(buf)).toBe('FontName-Bold');

    const emptyBuf = buildSfnt({
      records: [
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, str: '   \0\0  ' },
      ],
    });
    expect(parsePostScriptName(emptyBuf)).toBe(null);
  });

  it('decodes odd-length UTF-16BE name records cleanly without trailing replacement character', () => {
    // 12 characters ("TestFont-Reg") = 24 bytes UTF-16BE + 1 stray trailing byte = 25 bytes total
    const baseStr = 'TestFont-Reg';
    const utf16Bytes = [];
    for (let i = 0; i < baseStr.length; i++) {
      const code = baseStr.charCodeAt(i);
      utf16Bytes.push((code >> 8) & 0xff, code & 0xff);
    }
    utf16Bytes.push(0x00); // 25th (odd) byte
    expect(utf16Bytes.length % 2).toBe(1);

    const buf = buildSfnt({
      records: [
        { platformID: 3, encodingID: 1, languageID: 0x0409, nameID: 6, rawBytes: utf16Bytes },
      ],
    });
    const parsed = parsePostScriptName(buf);
    expect(parsed).toBe('TestFont-Reg');
    expect(parsed).not.toContain('\uFFFD');
  });
});

describe('postScriptNameFor', () => {
  it('returns null for unknown family/slot', () => {
    expect(postScriptNameFor('NonExistent', 'regular')).toBe(null);
  });

  it('retrieves the recorded PostScript name for a family and slot', () => {
    _setPostScriptNameFor('CustomFont', 'bold', 'CustomFont-BoldPS');
    expect(postScriptNameFor('CustomFont', 'bold')).toBe('CustomFont-BoldPS');
    expect(postScriptNameFor('CustomFont', 'regular')).toBe(null);
  });

  it('clears recorded names when cleared or removed', () => {
    _setPostScriptNameFor('CustomFont', 'regular', 'CustomFont-RegularPS');
    expect(postScriptNameFor('CustomFont', 'regular')).toBe('CustomFont-RegularPS');
    _setPostScriptNameFor('CustomFont', 'regular', null);
    expect(postScriptNameFor('CustomFont', 'regular')).toBe(null);
  });
});

describe('_restoreFontRecords', () => {
  it('skips restoring a face for a family and slot that is already registered this session', async () => {
    // User added MangaTemple regular mid-session
    app.fonts.user = [
      {
        name: 'MangaTemple',
        css: "'MangaTemple'",
        real: true,
        faces: { ...emptyFaces(), regular: { file: 'MangaTemple-New.ttf' } },
      },
    ];

    // Stale IndexedDB record from previous session
    const staleRecord = {
      name: 'MangaTemple',
      slot: 'regular',
      file: 'MangaTemple-Old.ttf',
      data: new Uint8Array(0),
    };

    await _restoreFontRecords([staleRecord]);

    // Should NOT overwrite the user's newly added face
    const group = app.fonts.user.find((f) => f.name === 'MangaTemple');
    expect(group.faces.regular.file).toBe('MangaTemple-New.ttf');
  });
});

// ---------------------------------------------------------------------------
// What the font menus offer: the user's fonts first, built-ins until hidden,
// system fonts once shown.
// ---------------------------------------------------------------------------
describe('fontGroups', () => {
  afterEach(() => {
    app.fonts.user = [];
    app.fonts.system = [];
    setPref('hiddenBuiltinFonts', []);
    setPref('shownSystemFonts', []);
  });

  it('lists the user’s fonts first, then the built-ins, and no empty group', () => {
    app.fonts.user = [userFont('Manga Temple', { regular: { file: 'MT.ttf' } })];
    const g = fontGroups();
    expect(g.map((x) => x.key)).toEqual(['user', 'builtin']);
    expect(g[0].fonts.map((f) => f.name)).toEqual(['Manga Temple']);
    expect(g[1].fonts).toHaveLength(BUILTIN_FONTS.length);
  });

  it('a hidden built-in leaves the menus but is still a font the app can draw', () => {
    setBuiltinHidden('Bangers', true);
    expect(fontGroups().find((g) => g.key === 'builtin').fonts.some((f) => f.name === 'Bangers')).toBe(false);
    expect(isFontOffered('Bangers')).toBe(false);
    expect(resolveFace('Bangers', {}).known).toBe(true);
    setBuiltinHidden('Bangers', false);
    expect(isFontOffered('Bangers')).toBe(true);
  });

  it('system fonts are hidden until shown, and shown ones come last', () => {
    app.fonts.system = [
      systemFontEntry({ name: 'Helvetica', faces: { regular: true, bold: true } }),
      systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
    ];
    expect(fontGroups().some((g) => g.key === 'system')).toBe(false);
    setSystemShown('Zapfino', true);
    const g = fontGroups();
    expect(g.map((x) => x.key)).toEqual(['builtin', 'system']);
    expect(g[1].fonts.map((f) => f.name)).toEqual(['Zapfino']);
    // Known to the face resolver whether or not it is offered.
    expect(resolveFace('Helvetica', { bold: true })).toMatchObject({ slot: 'bold', fauxBold: false, known: true });
  });

  it('a system entry has a built-in’s shape: quoted family with a fallback, faces as slots', () => {
    const e = systemFontEntry({ name: "O'Brien", faces: { regular: true, italic: true } });
    expect(e.css).toBe('"O\'Brien", sans-serif');
    expect(e.faces).toEqual({ regular: { file: null }, bold: null, italic: { file: null }, boldItalic: null });
    expect(e.system).toBe(true);
    // An older native side sends no fingerprint; the entry then has none.
    expect('stamp' in e).toBe(false);
  });

  it('a system entry carries the scan’s fingerprint of its files, for whoever keeps bytes of them', () => {
    expect(systemFontEntry({ name: 'Zapfino', faces: { regular: true }, stamp: '00ab34cd00ab34cd' }).stamp).toBe('00ab34cd00ab34cd');
  });
});
