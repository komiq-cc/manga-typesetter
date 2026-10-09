// The dry run of P9: what the app does to a chapter lettered under WebKit when
// it is opened with the Rust text engine. Launched by
// scripts/text-port/dry-run.mjs and by nothing else; it does nothing unless
// TP_DRYRUN=1.
//
// It runs the app's own code on copies of chapter.json files, the way the
// capture lane beside it runs the corpus: the real store, the real switch
// (engine-switch.svelte.js), the real font sync, the wasm, and the user's
// font files. Three things a node process does not have are stood in for, and
// each is named in the output:
//
//   the library's open   `loadChapter` in library.svelte.js reads a chapter off
//                        disk through Tauri. What it then does to the document
//                        is made here in its order (`open`): the project's
//                        layout, the chapter's typesetting, the pages. Two
//                        things it does first cannot be made here and are not
//                        guessed at. It repairs a page from its picture (a
//                        page whose art was replaced at another size, or one
//                        with no size): the copies have no pictures, so a
//                        chapter with such a page is refused, by name. And it
//                        takes the layout from the project, which the copies
//                        do not carry: so the open is run under both layouts
//                        (pages, long strip) and a box that comes out
//                        differently is counted.
//   the native side      the bytes of a system family and which installed
//                        family has a letter (scripts/text-port/lib/
//                        installed-fonts.mjs).
//   the browser          Skia (@napi-rs/canvas) measures where the app would
//                        ask WebKit: "the browser engine's stand-in". It cannot
//                        break plain text, so plain chapters have no such run.
//
// Per chapter, in this order:
//
//   1. the switch off: opened as it is today, measured by the stand-in;
//   2. the switch on: opened from the file again, then left until every font
//      it sent for is in - once as a long strip, for the boxes alone, and
//      once as pages, which is the run everything else is read from;
//      The notice's own counts are read, the chapter is left (what is
//      written by that), and then kept (what is written by that);
//   3. the document as step 2 left it, opened with the switch off again: what
//      a chapter the Rust engine has fitted meets when the user goes back, and
//      what a save there writes.
//
// A stored box is matched to the box the open made of it by where it stands
// in the file, as the loader carries it, never by an id the load may have
// repaired; a stored box with no partner, and a box with text that has no
// layout, are errors of the run.
//
// Nothing is written but under TP_OUT. No time, no path of this machine's
// home and no random number goes into what is written, so a second run gives
// the same bytes.
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { GlobalFonts } from '@napi-rs/canvas';
import { dataDir, guardedPath, safeId, sha256, root } from '../../scripts/text-port/lib/common.mjs';
import { scanInstalled, systemList, nativeStandIn } from '../../scripts/text-port/lib/installed-fonts.mjs';
import { at, storedIds, assertPartners, unrepairedPages, changeOf } from '../../scripts/text-port/lib/dry-compare.mjs';

const FIXTURE_SOURCE = /^src\/test\/fonts\//;

if (process.env.TP_DRYRUN !== '1') {
  it.skip('text-port dry run disabled; run scripts/text-port/dry-run.mjs', () => {});
} else {
  it('opens every chapter copy under both engines', async () => {
    const data = dataDir();
    const out = process.env.TP_OUT;
    if (!out) throw new Error('TP_OUT is not set');
    const legacyMode = process.env.TP_LEGACY_MODE || '';
    const wasmPath = `${root}text-engine/js/generated/mt_text.wasm`;
    if (!existsSync(wasmPath)) throw new Error(`${wasmPath} is missing; run npm run build:engine`);
    const wasm = readFileSync(wasmPath);

    // ---- the user's fonts ----
    // The harness's font list holds the user's own files and the four fixture
    // files of the repository under the names of two built-in families
    // (Bangers, Comic Neue). The app has no such file for a built-in: the
    // browser fetches those and the Rust engine has no bytes for them. So the
    // fixtures go to the stand-in browser, which draws them as the app's
    // browser does, and never to the Rust engine.
    //
    // Unless asked (`--load-fixtures`): then they are handed over as fonts
    // the user has loaded, which is the question "what is left of this
    // report once I load Bangers and Comic Neue".
    const loadFixtures = process.env.TP_LOAD_FIXTURES === '1';
    const list = JSON.parse(readFileSync(guardedPath(data, 'fonts/fonts.json')));
    const userFaces = [];
    const browserFamilies = new Set();
    for (const f of list.fonts) {
      const path = guardedPath(data, `fonts/${f.file}`);
      const bytes = readFileSync(path);
      if (sha256(bytes) !== f.sha256) throw new Error(`Font hash mismatch: ${f.family}/${f.slot}`);
      if (!GlobalFonts.has(f.family) || !FIXTURE_SOURCE.test(f.source)) {
        if (!GlobalFonts.registerFromPath(path, f.family)) throw new Error(`Cannot register font ${path} as '${f.family}'`);
      }
      browserFamilies.add(f.family);
      if (loadFixtures || !FIXTURE_SOURCE.test(f.source)) userFaces.push({ name: f.family, slot: f.slot, data: new Uint8Array(bytes) });
    }

    const store = await import('./store.svelte.js');
    const measure = await import('./measure.js');
    const seam = await import('./text-engine/index.js');
    const contain = await import('./contain.js');
    const exporter = await import('./exporter.js');
    const dataJs = await import('./data.js');
    const fonts = await import('./fonts.js');
    const typeset = await import('./typeset.js');
    const sw = await import('./engine-switch.svelte.js');
    const { createRustTextEngine } = await import('./text-engine/rust.js');
    const { app } = store;
    if (seam.textEngine()?.id !== 'browser') throw new Error('The stand-in browser engine is not installed');

    // ---- the app's font lists ----
    const slots = ['regular', 'bold', 'italic', 'boldItalic'];
    const groups = new Map();
    for (const f of userFaces) {
      if (!groups.has(f.name)) groups.set(f.name, { name: f.name, css: `'${f.name}'`, real: true, faces: Object.fromEntries(slots.map((s) => [s, null])) });
      groups.get(f.name).faces[f.slot] = { file: 'user' };
    }
    const installed = scanInstalled();
    const native = nativeStandIn(installed);
    app.fonts = {
      // A family handed over as loaded is not also a built-in: the app
      // refuses a user font under a built-in's name while that list stands
      // (fonts.js), so this is the state after the list has gone.
      builtin: dataJs.BUILTIN_FONTS.filter((f) => !groups.has(f.name)),
      user: [...groups.values()],
      system: systemList(installed).map((f) => fonts.systemFontEntry(f)),
    };
    const invoke = async (cmd, args) => {
      if (cmd === 'system_font_face') return native.systemFace(args.family, args.slot, args.known);
      if (cmd === 'system_font_coverage') return native.systemCoverage(args.codePoints);
      throw new Error(`dry run: no stand-in for the command ${cmd}`);
    };
    sw._setEngineSwitchDeps({
      available: () => true,
      createEngine: async () => createRustTextEngine(wasm),
      invoke: async () => invoke,
      booted: async () => {},
      records: async () => userFaces,
      watch: () => {},
      os: () => 'macos',
    });

    // ---- the saver: what would have gone to disk, and when ----
    // As `writeOpenChapter` (library.svelte.js): the version is stamped as the
    // snapshot is taken, and the document is then what is on disk. Each entry
    // is the version that write would carry.
    const writes = [];
    store.setSaver(async () => {
      writes.push(store.stampTypesetting().version);
      store.markSaved();
    });

    // What `loadChapter` (library.svelte.js) does to the document once it has
    // read the record, in its order. The pictures of the pages are not read:
    // a chapter whose pages need them is not opened at all (`unrepairedPages`).
    function open(record, stem, layout = 'pages') {
      const pages = (record.pages ?? []).map((pg) => ({ ...pg, file: pg.file ?? null, cleanedFile: pg.cleaned ?? null, raw: null, cleaned: null }));
      app.chapterRef = null;
      app.projectLayout = layout;
      store.useChapterTypesetting(record.typesetting ?? dataJs.legacyTypesetting());
      const minted = store.loadProjectPages(pages);
      assertPartners(stem, record.pages, app.pages, `the open (${layout}, ${seam.textEngine()?.id ?? 'nothing'} measuring)`);
      app.chapterRef = { projectId: 'dry-run', chapterId: stem };
      if (minted) store.markUnsaved();
      else store.markSaved();
      return minted;
    }
    // Closed, and the document emptied: the switch re-fits whatever is open
    // when it is turned, and the next step starts from the file, not from that.
    const close = () => {
      store.markSaved();
      app.chapterRef = null;
      store.loadProjectPages([]);
      store.markSaved();
    };
    const plainPages = () => JSON.parse(JSON.stringify(app.pages));

    const geom = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style?.size ?? null });
    function boxState(b, p) {
      const review = store.reviewOf(b, p);
      return {
        ...geom(b),
        review: review ? { reason: review.reason, overflow: review.overflow, stored: !!b.review } : null,
        auto: b.auto ? b.auto.status ?? 'none' : null,
      };
    }
    function layOf(b, p) {
      const text = String(store.boxText(b, p) ?? '');
      if (!text.trim()) return null;
      try {
        const cand = contain.boxCandidate(b, text);
        const place = contain.placeBlock(cand);
        const v = contain.containBox(cand, place);
        return {
          lines: place.isCurve ? null : place.lines ?? null,
          lineX: place.isCurve ? null : place.lineX ?? null,
          blockY: place.blockY ?? null,
          blockH: place.blockH ?? null,
          // Everything the box paints, as Safari's capture has it (probe.js).
          ink: (() => {
            const k = contain.boxInkRect(cand, place);
            return k ? { l: k.x, t: k.y, r: k.x + k.w, b: k.y + k.h } : null;
          })(),
          curve: !!place.isCurve,
          fits: v.fits,
          overflow: v.overflow,
        };
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    }
    // Every box of the open document, by where it stands (`at`). A box with
    // text whose layout threw is kept, to fail the run by name at its end.
    const layFailures = [];
    function snapshot({ lay = true, engine = '', fails = () => true } = {}) {
      const boxes = new Map();
      app.pages.forEach((p, pi) => {
        p.boxes.forEach((b, bi) => {
          const laid = lay ? layOf(b, p) : null;
          if (laid?.error && fails(b)) layFailures.push(`${ids.get(at(pi, bi))} under ${engine}: ${laid.error}`);
          boxes.set(at(pi, bi), { state: boxState(b, p), lay: laid });
        });
      });
      return boxes;
    }
    let ids = new Map();
    let lastResort = null;

    const wk = new Map();
    const wkFile = guardedPath(data, 'runs/ref-wk/base/layout.jsonl');
    if (existsSync(wkFile)) {
      for (const line of readFileSync(wkFile, 'utf8').split('\n')) {
        if (!line.startsWith('{"id":"c.')) continue;
        const r = JSON.parse(line);
        wk.set(r.id, r);
      }
    }

    mkdirSync(`${out}/raw`, { recursive: true });
    mkdirSync(`${out}/img/after`, { recursive: true });
    const boxFile = `${out}/raw/boxes.jsonl`;
    writeFileSync(boxFile, '');
    const chapters = [];
    const dir = guardedPath(data, 'chapters');

    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const stem = safeId(basename(name, '.json').toLowerCase());
      const record = JSON.parse(readFileSync(guardedPath(dir, name), 'utf8'));
      const named = storedIds(stem, record.pages);
      ids = named.ids;
      // A page the loader repairs from its picture: not something this run
      // can do, so nothing is said of the chapter but that.
      const unrepaired = unrepairedPages(record);
      if (unrepaired.length) {
        chapters.push({ chapter: stem, refused: unrepaired, pages: (record.pages ?? []).length, boxes: ids.size });
        continue;
      }
      const hasMode = !!record.typesetting?.mode;
      if (!hasMode && !['smart', 'plain'].includes(legacyMode)) throw new Error(`${name}: chapter has no typesetting.mode; pass --legacy-mode smart|plain`);
      dataJs.setLegacyTypeset(legacyMode);
      const mode = record.typesetting?.mode ?? legacyMode;
      const version = record.typesetting?.version ?? null;

      // The file's own boxes, before any code of the app has seen them.
      const stored = new Map();
      (record.pages ?? []).forEach((p, pi) => (p.boxes ?? []).forEach((b, bi) => {
        const review = dataJs.normalizeReview(b.review);
        stored.set(at(pi, bi), {
          ...geom(b), review: review ? { reason: review.reason, overflow: review.overflow, stored: true } : null,
          auto: b.auto ? b.auto.status ?? 'none' : null,
          font: b.style?.font ?? null, bold: !!b.style?.bold, italic: !!b.style?.italic, valign: b.style?.valign ?? null, align: b.style?.align ?? null,
          pageIndex: pi, pageId: p.id ?? pi, boxId: b.id ?? null,
        });
      }));

      // 0. The flags as the file states them. A box's flag is its `review`, or
      // else the solver's record (`reviewOf`), which only the store can read:
      // so the file is loaded once with nothing measuring, when a load checks
      // nothing and fits nothing, and the flags are read off that.
      await sw.useTextEngine('browser');
      const standIn = seam.textEngine();
      seam.setTextEngine(null);
      open(record, stem);
      const filed = snapshot({ lay: false });
      // What the stored height says of the lines it was sized for, and what
      // Safari's own lines need: plain arithmetic on the box's style.
      const heights = new Map();
      app.pages.forEach((p, pi) => p.boxes.forEach((b, bi) => {
        const inset = measure.textInset(b.style);
        let implied = null;
        for (let n = 1; n <= 60 && implied == null; n++) if (Math.abs(typeset.neededHeight(n, b.style, inset) - b.h) < 0.01) implied = n;
        const w = wk.get(ids.get(at(pi, bi)));
        heights.set(at(pi, bi), { impliedLines: implied, safariNeeds: Array.isArray(w?.lines) ? typeset.neededHeight(w.lines.length, b.style, inset) : null, autoHeight: b.style.autoHeight !== false });
      }));
      close();
      seam.setTextEngine(standIn);

      // 1. As today: the switch off.
      let browser = null;
      // The stand-in has only the families of the font list: a box in any
      // other is not read from its run, and cannot fail it.
      const standsIn = (b) => browserFamilies.has(b.style?.font);
      if (mode === 'smart') {
        open(record, stem);
        browser = snapshot({ engine: 'the stand-in browser', fails: standsIn });
        close();
      }

      // 2. The switch on, then the same file opened.
      await sw.useTextEngine('rust');
      if (sw.engineSwitch.phase !== 'on') throw new Error(`The Rust engine did not start: ${sw.engineSwitch.error}`);
      lastResort = sw.engineSwitch.lastResort;
      // As a long strip first, for the boxes alone: the project's layout is
      // not in the copies, and it decides how far a box may grow (the page,
      // or the whole strip).
      open(record, stem, 'longstrip');
      await store.fontsSettling(app.pages);
      const strip = snapshot({ lay: false });
      close();
      const writesBefore = writes.length;
      const minted = open(record, stem);
      const opened = snapshot({ lay: false });
      const savedAtOpen = app.saved;
      // Every font the boxes sent for, in; the boxes that waited, fitted.
      await store.fontsSettling(app.pages);
      const savedAfterFonts = app.saved;
      const rust = snapshot({ engine: 'the Rust engine' });
      // What the app's own notice says of this chapter (EngineNotice.svelte).
      // Its "new line breaks" are counted against the engine that measured
      // before the switch: here the stand-in, in the app WebKit.
      const said = store.firstFitChanges();
      const notice = said ? { grew: said.grew, flagged: said.flagged, cleared: said.cleared, relaid: said.relaid, laid: said.laid } : null;
      const fontFacts = new Map();
      app.pages.forEach((p, pi) => p.boxes.forEach((b, bi) => {
        const letters = sw.boxLetters(b, p);
        const family = b.style?.font;
        fontFacts.set(at(pi, bi), {
          missing: typeof family === 'string' ? store.fontMissing(family) : false,
          why: typeof family === 'string' ? sw.whyFontMissing(family) : null,
          drawnIn: typeof family === 'string' ? store.fontNameFor(family) : null,
          kind: app.fonts.user.some((f) => f.name === family) ? 'user' : app.fonts.system.some((f) => f.name === family) ? 'system' : app.fonts.builtin.some((f) => f.name === family) ? 'builtin' : 'unknown',
          fauxBold: !!b.style?.bold && !!groups.get(family) && !groups.get(family).faces.bold && !groups.get(family).faces.boldItalic,
          fauxItalic: !!b.style?.italic && !!groups.get(family) && !groups.get(family).faces.italic && !groups.get(family).faces.boldItalic,
          borrowed: letters.borrowed.map((l) => ({ family: l.family, letters: l.letters })),
          none: [...letters.none],
          unread: letters.unread.map((l) => ({ family: l.family, letters: l.letters })),
        });
      }));
      // Leaving the chapter: what the app's flush does with a document nobody edited.
      const beforeLeave = writes.length;
      await store.flushSave();
      const writesOnLeave = writes.length - beforeLeave;

      // The pictures of every box that changed, as the app would draw it now.
      const painted = [];
      for (const [pi, p] of app.pages.entries()) {
        for (const [bi, b] of p.boxes.entries()) {
          const id = ids.get(at(pi, bi));
          const here = at(pi, bi);
          const r = rust.get(here);
          // No text; or a layout that threw, which fails the run below.
          if (!r.lay || r.lay.error) continue;
          const change = changeOf({ id, stored: { ...stored.get(here), review: filed.get(here)?.state.review ?? null }, rust: r, wk: wk.get(id) ?? null, font: fontFacts.get(here) });
          if (!change.any && !fontFacts.get(here).missing) continue;
          const text = String(store.boxText(b, p) ?? '');
          const box = JSON.parse(JSON.stringify(b));
          box.text = text;
          // As the corpus cut them: hand-drawn ink and a warp are not text.
          delete box.style.ink;
          delete box.style.warp;
          try {
            await exporter.settleNoise([box]);
            const { canvas } = exporter.renderBoxTexture(box, { w: p.w, h: p.h });
            writeFileSync(`${out}/img/after/${id}.png`, canvas.toBuffer('image/png'));
            canvas.width = 0;
            canvas.height = 0;
            painted.push(id);
          } catch (error) {
            painted.push(`${id} FAILED ${error?.message ?? error}`);
          }
        }
      }
      // The notice's Keep: the one thing besides an edit that writes.
      const beforeKeep = writes.length;
      await store.keepFirstFit();
      const writesOnKeep = writes.length - beforeKeep;
      const versionOnKeep = writesOnKeep ? writes[writes.length - 1] : null;
      const fitted = plainPages();
      const keptTypesetting = { ...app.typesetting };
      close();

      // 3. Back: what the Rust engine left, opened with the switch off.
      await sw.useTextEngine('browser');
      let back = null;
      let versionBack = null;
      if (mode === 'smart') {
        open({ ...record, typesetting: keptTypesetting, pages: fitted.map((p) => ({ ...p, cleaned: p.cleanedFile })) }, stem);
        back = snapshot({ engine: 'the stand-in browser, going back', fails: standsIn });
        // Leaving it there: the browser's save, and the version it writes.
        const beforeBack = writes.length;
        await store.flushSave();
        versionBack = writes.length > beforeBack ? writes[writes.length - 1] : null;
        close();
      }

      for (const [here, s] of stored) {
        const id = ids.get(here);
        // Guaranteed by `assertPartners` at every open; said again where the
        // row is written, since a row without one would be a box not counted.
        if (!rust.get(here) || !strip.get(here)) throw new Error(`${id}: the stored box has no partner after the open`);
        const line = {
          id, chapter: stem, mode, ...s, review: filed.get(here)?.state.review ?? null, ...heights.get(here),
          opened: opened.get(here)?.state ?? null,
          rust: rust.get(here),
          strip: strip.get(here).state,
          browser: browser && browserFamilies.has(s.font) ? browser.get(here) ?? null : null,
          back: back && browserFamilies.has(s.font) ? back.get(here) ?? null : null,
          fontFacts: fontFacts.get(here) ?? null,
          painted: painted.includes(id),
        };
        writeFileSync(boxFile, JSON.stringify(line) + '\n', { flag: 'a' });
      }
      chapters.push({
        chapter: stem, mode, modeFrom: hasMode ? 'file' : 'legacy', version, pages: (record.pages ?? []).length, boxes: stored.size,
        idsRepaired: named.repaired,
        minted, savedAtOpen, savedAfterFonts, writesByOpening: beforeLeave - writesBefore, writesOnLeave,
        notice, writesOnKeep, versionOnKeep, versionBack,
        browserRun: !!browser, paintFailures: painted.filter((p) => p.includes(' FAILED ')),
      });
    }

    await sw.useTextEngine('browser');
    // A path under the home folder is written as `~`: the folder's name is the user's.
    const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
    const served = Object.fromEntries([...native.served].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([family, faces]) => [family, Object.fromEntries(Object.entries(faces).map(([slot, file]) => [slot, tilde(file)]))]));
    const asked = Object.fromEntries([...native.asked].sort((a, b) => a[0] - b[0]).map(([cp, family]) => [`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, family]));
    const builtinNames = dataJs.BUILTIN_FONTS.map((f) => f.name);
    writeFileSync(`${out}/raw/run.json`, JSON.stringify({
      wasm: sha256(wasm), legacyMode: legacyMode || null, loadFixtures,
      userFamilies: groups.size, userFaces: userFaces.length, installedFamilies: installed.size,
      lastResort, systemFacesServed: served, lettersAsked: asked,
      builtinInstalled: builtinNames.filter((n) => installed.has(n)),
      wkCases: wk.size, chapters,
    }, null, 2) + '\n');
    // A box either has a layout under each engine it is read from, or the run
    // is wrong: named here, and no report is written from it.
    expect(layFailures).toEqual([]);
    expect(chapters.flatMap((c) => c.paintFailures ?? [])).toEqual([]);
  }, 1800000);
}
