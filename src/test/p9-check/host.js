// The page side of the first-open check of P9 (scripts/text-port/p9-check.mjs
// drives it): what the app shows and writes when a chapter lettered under the
// browser meets the Rust text engine, in a real browser.
//
// A dev-only page, like editor-check.html: the REAL editor canvas and the
// REAL text queue (Queue.svelte, with the notice in it) on the real store,
// fonts loaded the way a user's are (fonts.js), the real `textEngine` switch
// and the real wasm. Two things of the desktop app are not here, and the
// page says what it does instead:
//
//   the library   a plain browser has no filesystem, so no chapter is read or
//                 written. A chapter copy is fetched from the driver's
//                 read-only server and opened by the calls `loadChapter`
//                 (library.svelte.js) makes, in its order; the saver is one
//                 that stamps the version the way `writeOpenChapter` does,
//                 and keeps what it would have written.
//   WebKit        the browser that measured before the switch is this one.
//
// It is not part of the build and nothing in the app imports it.
import { mount, flushSync, tick } from 'svelte';
import '../../styles.css';
import Canvas from '../../lib/editor/Canvas.svelte';
import Queue from '../../lib/Queue.svelte';
import {
  app, loadProjectPages, useChapterTypesetting, setSaver, markSaved, markUnsaved, flushSave, stampTypesetting, firstFit, firstFitChanges, flaggedBoxes,
  fontsSettling, reviewOf, gotoPage, selectBox,
} from '../../lib/store.svelte.js';
import { initHistory } from '../../lib/editor/history.svelte.js';
import { restoreFonts, scanSystemFonts, addFontFile } from '../../lib/fonts.js';
import { engineSwitch, useTextEngine } from '../../lib/engine-switch.svelte.js';
import { textEngine } from '../../lib/text-engine/index.js';
import { legacyTypesetting, setLegacyTypeset, REVIEW_REASONS } from '../../lib/data.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 3) {
  await tick();
  flushSync();
  for (let i = 0; i < frames; i++) await frame();
  flushSync();
}

mount(Canvas, { target: document.getElementById('app'), props: { onReady: () => {} } });
mount(Queue, { target: document.getElementById('queue') });

// What would have gone to disk: the version each save carries, and the
// document of the last one.
const saves = [];
let kept = null;
setSaver(async () => {
  const typesetting = stampTypesetting();
  saves.push(typesetting.version);
  kept = { typesetting, pages: JSON.parse(JSON.stringify(app.pages)) };
  markSaved();
});

let record = null;
// As `loadChapter`: the chapter's own typesetting, the pages, the ref, and
// saved unless the load had to mint ids.
async function openRecord(rec) {
  const pages = rec.pages.map((p) => ({ ...p, raw: null, cleaned: null, file: null, cleanedFile: null }));
  app.chapterRef = null;
  const t0 = performance.now();
  useChapterTypesetting(rec.typesetting ?? legacyTypesetting());
  const minted = loadProjectPages(pages);
  const ms = performance.now() - t0;
  app.chapterRef = { projectId: 'p9-check', chapterId: 'copy' };
  if (minted) markUnsaved();
  else markSaved();
  await settle();
  await fontsSettling(app.pages);
  await settle();
  return { ms: Math.round(ms), minted: !!minted, pages: app.pages.length, boxes: app.pages.reduce((n, p) => n + p.boxes.length, 0) };
}

const noticeEl = () => document.querySelector('#queue .en');
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

window.__p9 = {
  async boot() {
    initHistory();
    restoreFonts();
    scanSystemFonts();
    await document.fonts.ready;
    return { dpr: devicePixelRatio, ua: navigator.userAgent, available: engineSwitch.available };
  },
  // The user's own fonts, from the driver's read-only server (never the repo).
  async addFonts(list, base) {
    const added = [];
    for (const f of list) {
      if (app.fonts.user.find((u) => u.name === f.family)?.faces?.[f.slot]) continue;
      const res = await fetch(`${base}/fonts/${f.file}`);
      if (!res.ok) throw new Error(`${f.file}: ${res.status}`);
      const r = await addFontFile(new File([await res.arrayBuffer()], f.file), { family: f.family, slot: f.slot });
      if (r) added.push(`${f.family}/${f.slot}`);
    }
    await document.fonts.ready;
    return added.length;
  },
  async fetchChapter(url, legacyMode) {
    record = await (await fetch(url)).json();
    setLegacyTypeset(legacyMode);
    return { version: record.typesetting?.version ?? null, mode: record.typesetting?.mode ?? `${legacyMode} (legacy)` };
  },
  open: () => openRecord(record),
  // The chapter as the last save would have written it.
  openKept: () => openRecord(kept),
  close() {
    app.chapterRef = null;
    useChapterTypesetting(null);
    loadProjectPages([]);
    markSaved();
  },
  async engine(mode) {
    await useTextEngine(mode);
    await settle(4);
    await fontsSettling(app.pages);
    await settle();
    return { mode: engineSwitch.mode, phase: engineSwitch.phase, error: engineSwitch.error, lastResort: engineSwitch.lastResort, measuring: textEngine()?.id ?? null };
  },
  async leave() {
    await flushSave();
    await settle(1);
  },
  async wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await settle(1);
  },
  // Numbers and fixed words only: nothing of the chapter's text.
  state() {
    const el = noticeEl();
    const listed = flaggedBoxes();
    return {
      saved: app.saved,
      saves: saves.slice(),
      version: app.typesetting.version,
      firstFit: { open: firstFit.open, kept: firstFit.kept, dismissed: firstFit.dismissed },
      changes: firstFitChanges(),
      notice: el
        ? { what: el.querySelector('.en-what').textContent.trim(), note: el.querySelector('.en-note').textContent.replace(/\s+/g, ' ').trim(), buttons: [...el.querySelectorAll('.en-btn')].map((b) => b.textContent.trim()), rect: rectOf(el) }
        : null,
      listed: listed.length,
      listedForLines: listed.filter((f) => f.review.reason === REVIEW_REASONS.relaid).length,
      flagged: app.pages.reduce((n, p) => n + p.boxes.filter((b) => reviewOf(b, p)).length, 0),
      pageIndex: app.pageIndex,
      selected: app.selectedId != null,
    };
  },
  // Every box's rectangle, size and flag, in order.
  geometry() {
    return app.pages.flatMap((p) => p.boxes.map((b) => [b.x, b.y, b.w, b.h, b.style.size, b.review ? 1 : 0]));
  },
  async press(name) {
    const b = [...(noticeEl()?.querySelectorAll('.en-btn') ?? [])].find((x) => x.textContent.trim() === name);
    if (!b) return false;
    b.click();
    await settle(4);
    return true;
  },
  // The review list under the notice, opened: its rows by reason.
  async openList() {
    const head = [...document.querySelectorAll('#queue .rv-head')].find((h) => /review/.test(h.textContent));
    if (!head) return null;
    if (head.getAttribute('aria-expanded') !== 'true') head.click();
    await settle(2);
    const rows = [...head.closest('.rv').querySelectorAll('.rv-row')];
    const reasons = {};
    for (const r of rows) {
      const why = r.querySelector('.rv-why').textContent.split(' · ')[0];
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    return { head: head.querySelector('.rv-count').textContent.trim(), rows: rows.length, reasons };
  },
  queueRect: () => rectOf(document.getElementById('queue')),

  // ---- a handle of the real TextBox, for the driver's own mouse ----
  // A box the open left exactly as the file has it, selected on its page, and
  // where its `dir` handle is on screen. The driver presses the mouse there
  // itself: the page only says where.
  async grab(dir) {
    for (let pi = 0; pi < app.pages.length; pi++) {
      const stored = record.pages[pi];
      const candidates = app.pages[pi].boxes.map((b, i) => [b, i]).filter(([b, i]) => stored.boxes[i] && stored.boxes[i].h === b.h && stored.boxes[i].y === b.y && !b.review);
      if (!candidates.length) continue;
      if (app.pageIndex !== pi) gotoPage(pi);
      await settle(3);
      for (const [b, i] of candidates) {
        selectBox(b.id);
        await settle(2);
        const el = document.querySelector(`#app .handle.${dir}`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        // Room below it to drag into, and nothing over it.
        if (y + 80 > innerHeight || document.elementFromPoint(x, y) !== el) continue;
        return { page: pi, index: i, x, y, box: [b.x, b.y, b.w, b.h] };
      }
    }
    return null;
  },
  // That box now, whether the chapter reads as saved, and what the notice counts.
  held(page, index) {
    const b = app.pages[page].boxes[index];
    return { box: [b.x, b.y, b.w, b.h], saved: app.saved, changes: firstFitChanges(), saves: saves.length };
  },
  // The same box in what the last save would have written.
  keptBox(page, index) {
    const b = kept?.pages[page]?.boxes[index];
    return b ? [b.x, b.y, b.w, b.h] : null;
  },
};

document.title = 'p9 ready';
