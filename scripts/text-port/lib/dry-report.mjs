// The dry run's report: the counts, and every box that changes, each with a
// picture before and after, its old and new lines and the cause in one
// sentence. Written from what the lane left under `<out>/raw` and from
// Safari's capture; nothing here measures anything.
//
// A cause is a rule of text-engine/RULES.md, or one of four things that are
// not the engine at all (the file was already behind today's app; the font is
// a former built-in; a letter is borrowed; the box grew, so what is in it
// moved with it). Each is decided from a fact the run recorded, named in the
// sentence. A change none of them accounts for is listed as unexplained.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { guardedPath } from './common.mjs';
import { changeOf, MOVED_PX } from './dry-compare.mjs';

const KINDS = [
  ['geometry', 'Width, size or horizontal position changed (must be none)'],
  ['shrank', 'Height shrank (must be none)'],
  ['lines', 'Line breaks changed'],
  ['newlyFlagged', 'Newly flagged "needs review"'],
  ['unflagged', 'No longer flagged'],
  ['grew', 'Grew taller'],
  ['moved', `Text block moved more than ${MOVED_PX} px, box unchanged`],
];

const px = (n) => (Math.round(n * 100) / 100).toString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sides = (o) => ['l', 't', 'r', 'b'].filter((k) => o?.[k] > 0.5);
const sideNames = { l: 'left', t: 'top', r: 'right', b: 'bottom' };
const overflowWords = (o) => sides(o).map((k) => `${px(o[k])} px past the ${sideNames[k]}`).join(', ') || 'no edge';

// The cause of each thing that changed for one box.
function explain(row, c, wk) {
  const out = [];
  const say = (what, cause, rule = '') => out.push({ what, cause, rule });
  const font = row.fontFacts ?? {};
  const browser = row.browser?.state ?? null;
  const o = row.rust.lay?.overflow ?? {};
  const missing = c.missing ? `the font '${row.font}' is not on this machine (${font.kind === 'builtin' ? 'a former built-in' : 'not loaded'}): the engine sets the box in ${font.drawnIn}` : null;
  const borrowed = c.borrows
    ? `a letter the font lacks is drawn from ${[...new Set(font.borrowed.map((b) => b.family))].join(', ') || 'no font'}; Safari takes it from a font of its own choosing`
    : null;
  if (c.x || c.w || c.size) say('geometry', null);
  if (c.shrank) say('shrank', null);
  if (c.lines) {
    if (missing) say('lines', missing, 'D2b');
    else if (borrowed) say('lines', borrowed, 'rules 10, 11');
    else if (row.mode === 'plain') say('lines', "plain mode: the engine's own breaker replaces the browser's CSS breaker", 'rule 9');
    else if (font.fauxBold) say('lines', 'the bold is synthesised and its advance is a rule of the engine', 'rule 7');
    else say('lines', null);
  }
  if (c.newlyFlagged) {
    const where = overflowWords(o);
    if (missing) say('newlyFlagged', `${missing}, whose letters are another width (${where})`, 'D2b');
    else if (c.flaggedBySafari) say('newlyFlagged', `not the engine: Safari's own check already finds this box overflowing as stored (${overflowWords(wk?.verdict?.overflow)}), so today's app flags it on open too; the file had no flag`, 'stale file');
    else if (borrowed) say('newlyFlagged', `${borrowed} (${where})`, 'rules 10, 11');
    else if (c.lines) say('newlyFlagged', `follows from the new line breaks (${where})`, 'see lines');
    else if (sides(o).every((k) => k === 'l' || k === 'r')) say('newlyFlagged', `true overhang: ${where}. WebKit reports a line's advance as its left and right ink edges and so never saw it; the engine measures the outline`, 'rule 4');
    else if (browser?.review) say('newlyFlagged', `${where}; the stand-in browser, which also measures real ink, flags it too. WebKit's ink box is stepped to 1/64 px and the engine's is exact`, 'rule 4');
    else say('newlyFlagged', null);
  }
  if (c.unflagged) {
    if (c.flaggedBySafari === false) say('unflagged', "not the engine: Safari's own check passes this box as stored, so today's app clears the flag on open too; the flag in the file was out of date", 'stale file');
    else if (missing) say('unflagged', missing, 'D2b');
    else if (c.flaggedBySafari === true) say('unflagged', `Safari finds ${overflowWords(wk?.verdict?.overflow)}; by the outline's own box the ink is inside`, 'rule 4');
    else say('unflagged', null);
  }
  if (c.grew) {
    const also = browser && browser.h > row.h;
    const stale = row.safariNeeds != null && row.safariNeeds > row.h + 0.01;
    const ink = stale && row.rust.state.h - row.safariNeeds > 0.5 ? `; ${px(row.rust.state.h - row.safariNeeds)} px of it is for ink past the line boxes` : '';
    if (!row.rust.lay) say('grew', `not the engine: the box has no text, and an empty box is grown to the height one line of its font needs${also ? ` (the stand-in browser grows it by ${px(browser.h - row.h)} px on open as well)` : ''}`, 'stale file');
    else if (missing) say('grew', `${missing}, which needs more height`, 'D2b');
    else if (stale) say('grew', `not the engine: Safari's own ${wk.lines.length} lines need ${px(row.safariNeeds)} px and the file has ${px(row.h)} px, so today's app grows this box on open too${also ? ` (the stand-in browser grows it by ${px(browser.h - row.h)} px)` : ''}${ink}`, 'stale file');
    else if (also && Math.abs(browser.h - row.rust.state.h) <= 1) say('grew', `not the engine: the stand-in browser grows it by ${px(browser.h - row.h)} px on open as well`, 'stale file');
    else if (c.lines) say('grew', 'follows from the new line breaks', 'see lines');
    else if (borrowed) say('grew', borrowed, 'rules 10, 11');
    else say('grew', null);
  }
  if (c.moved && !c.grew && !c.dy) {
    if (missing) say('moved', missing, 'D2b');
    else if (c.lines) say('moved', 'follows from the new line breaks', 'see lines');
    else if (borrowed) say('moved', borrowed, 'rules 10, 11');
    else say('moved', `the block is centred on its ink, and the engine's ink box is the outline's where WebKit's is stepped and, sideways, the advance (${c.blockDy != null ? `${px(c.blockDy)} px down` : ''}${c.blockDx ? `, ${px(c.blockDx)} px right` : ''})`, 'rule 4');
  }
  return out;
}

const blank = () => ({
  boxes: 0, lettered: 0, compared: 0, pending: 0,
  x: 0, w: 0, size: 0, shrank: 0,
  grew: 0, grewNotEngine: 0, grewMax: 0, grewSum: 0, yMoved: 0, yAlone: 0,
  newlyFlagged: 0, newlyFlaggedNotEngine: 0, unflagged: 0, unflaggedNotEngine: 0, flaggedBefore: 0, flaggedAfter: 0,
  lines: 0, moved: 0, movedOver2: 0, missing: 0, borrows: 0, changed: 0, unexplained: 0,
  back: { run: 0, grew: 0, newlyFlagged: 0, unflagged: 0, x: 0, w: 0, size: 0 },
  safariBack: { newlyFlagged: 0, unflagged: 0 },
});
function add(total, t) {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'object') add(total[k], v);
    else if (k === 'grewMax') total[k] = Math.max(total[k], v);
    else total[k] += v;
  }
}

/**
 * @param {{ data: string, out: string }} dirs
 * @returns {{ total: object, chapters: object }}
 */
export async function writeReport({ data, out }) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const run = JSON.parse(readFileSync(`${out}/raw/run.json`, 'utf8'));
  const rows = readFileSync(`${out}/raw/boxes.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const wk = new Map();
  const wkFile = guardedPath(data, 'runs/ref-wk/base/layout.jsonl');
  if (existsSync(wkFile)) {
    for (const line of readFileSync(wkFile, 'utf8').split('\n')) {
      if (line.startsWith('{"id":"c.')) {
        const r = JSON.parse(line);
        wk.set(r.id, r);
      }
    }
  }
  mkdirSync(`${out}/img/before`, { recursive: true });
  const chapters = {};
  for (const c of run.chapters) chapters[c.chapter] = { ...blank(), mode: c.mode, modeFrom: c.modeFrom, version: c.version, pages: c.pages, open: c };
  const total = blank();
  const changed = [];
  const fontsMissing = new Map();
  const borrowing = [];

  for (const row of rows) {
    const t = chapters[row.chapter];
    t.boxes++;
    // Placed while its font was loading and never solved: the one kind of box
    // an open lays out afresh, width and size included (`solvePending`).
    if (row.auto === 'pending') t.pending++;
    if (row.fontFacts?.missing) {
      const f = fontsMissing.get(row.font) ?? { family: row.font, kind: row.fontFacts.kind, drawnIn: row.fontFacts.drawnIn, boxes: 0, lettered: 0, chapters: new Map(), first: null };
      f.boxes++;
      f.chapters.set(row.chapter, (f.chapters.get(row.chapter) ?? 0) + 1);
      if (row.rust?.lay) {
        f.lettered++;
        f.first ??= row.id;
      }
      fontsMissing.set(row.font, f);
    }
    if (!row.rust) continue;
    // A box with no text has no lines and no picture, but it is a box the
    // open can still grow (to the height one line of its font needs).
    const lettered = !!row.rust.lay;
    if (lettered) t.lettered++;
    const w = wk.get(row.id) ?? null;
    const c = changeOf({ stored: row, rust: row.rust, wk: w, font: row.fontFacts });
    if (c.compared) t.compared++;
    for (const k of ['x', 'w', 'size', 'shrank', 'grew', 'newlyFlagged', 'unflagged', 'lines', 'moved', 'missing', 'borrows']) if (c[k]) t[k]++;
    if (row.review) t.flaggedBefore++;
    if (row.rust.state.review) t.flaggedAfter++;
    if (c.dy !== 0) t.yMoved++;
    if (c.dy !== 0 && !c.grew) t.yAlone++;
    if (c.grew) {
      t.grewMax = Math.max(t.grewMax, c.dh);
      t.grewSum += c.dh;
    }
    if (c.blockDy != null && Math.abs(c.blockDy) > 2) t.movedOver2++;
    // Back under the browser: the stand-in's own run, and what Safari's check says.
    if (row.back) {
      t.back.run++;
      const a = row.rust.state;
      const b = row.back.state;
      if (b.h > a.h) t.back.grew++;
      if (b.x !== a.x) t.back.x++;
      if (b.w !== a.w) t.back.w++;
      if (b.size !== a.size) t.back.size++;
      if (b.review && !a.review) t.back.newlyFlagged++;
      if (!b.review && a.review) t.back.unflagged++;
    }
    // Only the containment check's flag: the solver's is read off its record
    // and is the same under either engine.
    if (c.flaggedBySafari != null && !c.dh && !c.missing) {
      const contained = !!row.rust.state.review?.stored;
      if (c.flaggedBySafari && !contained) t.safariBack.newlyFlagged++;
      if (!c.flaggedBySafari && contained) t.safariBack.unflagged++;
    }
    if (c.borrows) borrowing.push({ id: row.id, chapter: row.chapter, font: row.font, borrowed: row.fontFacts.borrowed, none: row.fontFacts.none, unread: row.fontFacts.unread });
    if (!c.any) continue;
    t.changed++;
    const causes = explain(row, c, w);
    const stale = (what) => causes.some((x) => x.what === what && x.rule === 'stale file');
    if (c.grew && stale('grew')) t.grewNotEngine++;
    if (c.newlyFlagged && stale('newlyFlagged')) t.newlyFlaggedNotEngine++;
    if (c.unflagged && stale('unflagged')) t.unflaggedNotEngine++;
    const unexplained = causes.filter((x) => x.cause == null && x.what !== 'geometry' && x.what !== 'shrank');
    if (unexplained.length) t.unexplained++;
    const before = guardedPath(data, `runs/ref-wk/base/png/${row.id}.png`);
    const hasBefore = existsSync(before);
    if (hasBefore) copyFileSync(before, `${out}/img/before/${row.id}.png`);
    changed.push({
      id: row.id, chapter: row.chapter, page: row.pageIndex + 1, mode: row.mode, font: row.font, size: row.size, bold: row.bold, italic: row.italic,
      stored: { x: row.x, y: row.y, w: row.w, h: row.h, size: row.size, review: row.review },
      after: row.rust.state,
      empty: !lettered,
      linesBefore: w?.lines ?? null, linesAfter: row.rust.lay?.lines ?? null, curve: !!row.rust.lay?.curve,
      change: c, causes, unexplained: unexplained.map((x) => x.what),
      before: hasBefore ? `img/before/${row.id}.png` : null,
      picture: existsSync(`${out}/img/after/${row.id}.png`) ? `img/after/${row.id}.png` : null,
      fontFacts: row.fontFacts,
      browser: row.browser?.state ?? null,
    });
  }
  for (const t of Object.values(chapters)) add(total, { ...t, mode: undefined, modeFrom: undefined, version: undefined, pages: undefined, open: undefined });
  for (const k of ['mode', 'modeFrom', 'version', 'pages', 'open']) delete total[k];

  const missingList = [...fontsMissing.values()].sort((a, b) => b.boxes - a.boxes || (a.family < b.family ? -1 : 1)).map((f) => ({
    family: f.family, kind: f.kind, drawnIn: f.drawnIn, boxes: f.boxes, withText: f.lettered,
    chapters: Object.fromEntries([...f.chapters].sort()),
    picture: f.first && existsSync(`${out}/img/after/${f.first}.png`) ? `img/after/${f.first}.png` : null,
    before: f.first && existsSync(guardedPath(data, `runs/ref-wk/base/png/${f.first}.png`)) ? `img/before/${f.first}.png` : null,
    first: f.first,
  }));
  for (const f of missingList) {
    if (f.before) copyFileSync(guardedPath(data, `runs/ref-wk/base/png/${f.first}.png`), `${out}/img/before/${f.first}.png`);
  }

  const totals = {
    run: { wasm: run.wasm, legacyMode: run.legacyMode, userFamilies: run.userFamilies, installedFamilies: run.installedFamilies, lastResort: run.lastResort, safariCases: run.wkCases },
    total, chapters,
    fontsToLoad: missingList, borrowing: borrowing.length,
    lettersAsked: run.lettersAsked, systemFacesServed: run.systemFacesServed,
  };
  writeFileSync(`${out}/totals.json`, JSON.stringify(totals, null, 2) + '\n');
  writeFileSync(`${out}/boxes.jsonl`, changed.map((c) => JSON.stringify(c)).join('\n') + (changed.length ? '\n' : ''));
  writeFileSync(`${out}/report.md`, markdown(totals, changed, borrowing));

  // The pictures at half their size (the exporter paints at two device pixels
  // to one of the page), for the one file, and laid out many to a sheet, for
  // looking through them quickly.
  const cache = new Map();
  const picture = async (rel) => {
    if (!rel) return null;
    if (!cache.has(rel)) cache.set(rel, await loadImage(readFileSync(`${out}/${rel}`)));
    return cache.get(rel);
  };
  const uris = new Map();
  for (const rel of new Set([...changed.flatMap((b) => [b.before, b.picture]), ...missingList.flatMap((f) => [f.before, f.picture])])) {
    const img = await picture(rel);
    if (!img) continue;
    const w = Math.max(1, Math.round(img.width / 2));
    const h = Math.max(1, Math.round(img.height / 2));
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    uris.set(rel, `data:image/png;base64,${c.toBuffer('image/png').toString('base64')}`);
  }
  writeFileSync(`${out}/report.html`, html(totals, changed, borrowing, uris));

  mkdirSync(`${out}/sheets`, { recursive: true });
  const CELL = { w: 330, h: 150, pad: 6, label: 16 };
  const ROWS = 8;
  const PAIRS = 2;
  const index = [];
  for (const g of groups(changed)) {
    for (let at = 0, page = 1; at < g.list.length; at += ROWS * PAIRS, page++) {
      const part = g.list.slice(at, at + ROWS * PAIRS);
      const rows = Math.ceil(part.length / PAIRS);
      const sheet = createCanvas(PAIRS * 2 * CELL.w, rows * (CELL.h + CELL.label));
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      ctx.font = '11px Helvetica';
      ctx.textBaseline = 'top';
      for (const [i, b] of part.entries()) {
        const x0 = (i % PAIRS) * 2 * CELL.w;
        const y0 = Math.floor(i / PAIRS) * (CELL.h + CELL.label);
        ctx.fillStyle = i % 2 ? '#eef3f8' : '#f6f6f6';
        ctx.fillRect(x0, y0, 2 * CELL.w, CELL.h + CELL.label);
        ctx.fillStyle = '#000000';
        ctx.fillText(`${at + i + 1}  ${b.id.slice(2)}  ${b.font}`.slice(0, 100), x0 + 4, y0 + 2);
        for (const [k, rel] of [b.before, b.picture].entries()) {
          const img = await picture(rel);
          if (!img) continue;
          const scale = Math.min((CELL.w - 2 * CELL.pad) / img.width, (CELL.h - 2 * CELL.pad) / img.height, 1);
          ctx.drawImage(img, x0 + k * CELL.w + CELL.pad, y0 + CELL.label + CELL.pad, img.width * scale, img.height * scale);
        }
      }
      const name = `sheets/${g.kind}-${String(page).padStart(2, '0')}.png`;
      writeFileSync(`${out}/${name}`, sheet.toBuffer('image/png'));
      index.push(`${name}: ${g.title}, boxes ${at + 1} to ${at + part.length} (left of each pair: Safari; right: Rust engine)`);
    }
  }
  writeFileSync(`${out}/sheets/index.txt`, index.join('\n') + '\n');
  return totals;
}

// ---- words ----
const DESIGN = [
  ['What the version number is', 'Every chapter file carries `typesetting.version`. It is 1 in every chapter written so far (or absent, which reads as 1), and until now nothing read it. From here on: **1** means the boxes were last fitted by the browser, **2** means they were last fitted by the Rust engine. It is the only thing in the file that changes meaning; no field is added.'],
  ['Opening a version 1 chapter with the Rust engine', 'The standing rule is applied in memory: no box changes its width, size or place; a height may grow; a box whose text no longer fits gets the review flag. The queue shows one notice, above the "needs review" list: how many boxes have new line breaks, how many are newly flagged, how many are no longer flagged, how many grew taller. A flagged box is in the "needs review" list as always. A box whose lines moved and that still fits is listed there too, as "Line breaks changed with the new text engine", until you answer the notice. So the boxes are stepped through with the list the app already has, and "Show first" on the notice goes to the first of them. A chapter the engine changes nothing in shows no notice.'],
  ['What is written, and when', 'Opening writes nothing. Leaving the chapter untouched writes nothing. Turning the engine off again puts every box back as the file has it. The file is written, with the version set to 2, the grown heights and the flags, on the first save one of your own edits causes, or when you press "Keep" on the notice. Never before. The version number is the only thing in the file that is new: which boxes had their lines moved is not stored.'],
  ['Going back to the browser engine', 'A version 2 chapter opens under the browser engine as any chapter does today: heights may grow, flags are checked again by the browser, and leaving the chapter saves it, as it always has. That save sets the version back to 1, so the Rust engine tells you again the next time. A build of the app from before this change reads a 2 as it reads a 1 and writes it back unchanged.'],
];

function summaryLines(t) {
  const lines = [];
  lines.push(`${t.total.boxes} boxes in ${Object.keys(t.chapters).length} chapters; ${t.total.lettered} have text (the others are counted for their rectangle and have no lines or picture); Safari's capture has ${t.total.compared} of those to compare lines and positions with.`);
  lines.push(`Width, size or horizontal position changed: **${t.total.x + t.total.w + t.total.size}**. Heights that shrank: **${t.total.shrank}**.`);
  lines.push(`Top edge moved: ${t.total.yMoved}, each a box that grew (a box grows about its vertical anchor: down from the top, both ways from the middle, up from the bottom). Top edge moved without the height growing: **${t.total.yAlone}**.`);
  lines.push(`Boxes that grew taller: **${t.total.grew}** (${t.total.grewNotEngine} of them not because of the engine: the stored height was already under what today's app gives the box on open). Largest growth ${px(t.total.grewMax)} px.`);
  lines.push(`Boxes newly flagged "needs review": **${t.total.newlyFlagged}** (${t.total.newlyFlaggedNotEngine} of them already overflow in Safari today and only lacked the flag in the file). Boxes no longer flagged: **${t.total.unflagged}** (${t.total.unflaggedNotEngine} of them pass Safari's check today as well).`);
  lines.push(`Boxes whose line breaks changed: **${t.total.lines}** of ${t.total.compared} compared.`);
  lines.push(`Boxes whose text block sits more than ${MOVED_PX} px from where Safari puts it: ${t.total.moved} (${t.total.movedOver2} by more than 2 px).`);
  lines.push(`Boxes set in a font this machine does not have: **${t.fontsToLoad.reduce((n, f) => n + f.boxes, 0)}** (${t.fontsToLoad.reduce((n, f) => n + f.withText, 0)} with text), in ${t.fontsToLoad.length} families (listed below: these are the font files to load). Boxes that borrow a letter from another font: ${t.total.borrows}.`);
  lines.push(`Boxes stored as placed but never laid out (\`pending\`), the one kind an open may lay out afresh: **${t.total.pending}**.`);
  lines.push(`Changes with no stated cause: **${t.total.unexplained}**.`);
  return lines;
}

function chapterTable(t) {
  const head = ['chapter', 'mode', 'boxes', 'with text', 'x/w/size', 'shrank', 'grew', 'max px', 'newly flagged', 'no longer', 'lines', 'moved', 'font missing', 'borrow', 'unexplained'];
  const rows = Object.entries(t.chapters).map(([name, c]) => [
    name, `${c.mode}${c.modeFrom === 'legacy' ? ' (legacy)' : ''}`, c.boxes, c.lettered, c.x + c.w + c.size, c.shrank, `${c.grew} (${c.grewNotEngine})`, px(c.grewMax),
    `${c.newlyFlagged} (${c.newlyFlaggedNotEngine})`, `${c.unflagged} (${c.unflaggedNotEngine})`, c.lines, c.moved, c.missing, c.borrows, c.unexplained,
  ]);
  const tt = t.total;
  rows.push(['**total**', '', tt.boxes, tt.lettered, tt.x + tt.w + tt.size, tt.shrank, `${tt.grew} (${tt.grewNotEngine})`, px(tt.grewMax), `${tt.newlyFlagged} (${tt.newlyFlaggedNotEngine})`, `${tt.unflagged} (${tt.unflaggedNotEngine})`, tt.lines, tt.moved, tt.missing, tt.borrows, tt.unexplained]);
  return { head, rows };
}

function openTable(t) {
  const head = ['chapter', 'version in file', 'marked unsaved by opening', 'after its fonts arrived', 'saves by opening', 'saves on leaving, untouched', 'saves by Keep', 'version Keep writes', 'version a save back under the browser writes'];
  const rows = Object.entries(t.chapters).map(([name, c]) => [
    name, c.version ?? 'none', c.open.savedAtOpen ? 'no' : 'YES', c.open.savedAfterFonts ? 'no' : 'YES', c.open.writesByOpening, c.open.writesOnLeave,
    c.open.writesOnKeep, c.open.versionOnKeep ?? '-', c.open.versionBack ?? 'not run (plain)',
  ]);
  return { head, rows };
}

// What the app's own notice says per chapter, beside this report's count of
// the same thing. The first three are the same question asked twice and have
// to agree. "New line breaks" are not: the app asks the engine that measured
// before the switch (in this run Skia, in the app WebKit), the report asks
// Safari's capture.
function noticeTable(t) {
  const head = ['chapter', 'notice shown', 'grew taller', 'newly flagged', 'no longer flagged', 'new line breaks (against the stand-in)', 'this report: grew', 'newly flagged', 'no longer', 'lines (against Safari)'];
  const rows = Object.entries(t.chapters).map(([name, c]) => {
    const n = c.open.notice;
    return [name, n && n.grew + n.flagged + n.cleared + n.relaid > 0 ? 'yes' : 'no', n?.grew ?? '-', n?.flagged ?? '-', n?.cleared ?? '-', n?.relaid ?? '-', c.grew, c.newlyFlagged, c.unflagged, c.lines];
  });
  return { head, rows };
}

function backTable(t) {
  const head = ['chapter', 'boxes re-opened by the stand-in', 'x/w/size', 'grew again', 'flag raised', 'flag cleared', 'Safari would raise', 'Safari would clear'];
  const rows = Object.entries(t.chapters).filter(([, c]) => c.lettered).map(([name, c]) => [name, c.back.run || 'not run (plain)', c.back.x + c.back.w + c.back.size, c.back.grew, c.back.newlyFlagged, c.back.unflagged, c.safariBack.newlyFlagged, c.safariBack.unflagged]);
  const b = t.total.back;
  rows.push(['**total**', b.run, b.x + b.w + b.size, b.grew, b.newlyFlagged, b.unflagged, t.total.safariBack.newlyFlagged, t.total.safariBack.unflagged]);
  return { head, rows };
}

const mdTable = ({ head, rows }) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function whatChanged(b) {
  const c = b.change;
  const parts = [];
  if (c.x || c.w || c.size) parts.push(`GEOMETRY x ${b.stored.x} to ${b.after.x}, w ${b.stored.w} to ${b.after.w}, size ${b.stored.size} to ${b.after.size}`);
  if (c.dh) parts.push(`height ${px(b.stored.h)} to ${px(b.after.h)} (${c.dh > 0 ? '+' : ''}${px(c.dh)} px)`);
  if (c.dy) parts.push(`top ${px(b.stored.y)} to ${px(b.after.y)}`);
  if (c.newlyFlagged) parts.push(`newly flagged: ${b.after.review.reason}, ${overflowWords(b.after.review.overflow)}`);
  if (c.unflagged) parts.push(`no longer flagged (was: ${b.stored.review.reason}, ${overflowWords(b.stored.review.overflow)})`);
  if (c.lines) parts.push(`lines ${b.linesBefore.length} to ${b.linesAfter.length}`);
  if (c.moved) parts.push(`block ${px(c.blockDy ?? 0)} px down, ${px(c.blockDx ?? 0)} px right`);
  return parts;
}

function groups(changed) {
  const of = {
    geometry: (b) => b.change.x || b.change.w || b.change.size,
    shrank: (b) => b.change.shrank,
    lines: (b) => b.change.lines,
    newlyFlagged: (b) => b.change.newlyFlagged,
    unflagged: (b) => b.change.unflagged,
    grew: (b) => b.change.grew,
    moved: (b) => b.change.moved && !b.change.grew && !b.change.dy,
  };
  const seen = new Set();
  const out = [];
  for (const [kind, title] of KINDS) {
    // Each box is shown once, under the first kind of change it has.
    const list = changed.filter((b) => of[kind](b) && !seen.has(b.id));
    for (const b of list) seen.add(b.id);
    out.push({ kind, title, count: changed.filter((b) => of[kind](b)).length, list });
  }
  return out;
}

function markdown(t, changed, borrowing) {
  const out = [];
  out.push('# What happens to the 13 chapters under the Rust text engine', '');
  out.push('Dry run on copies. Nothing here touched a chapter in the library.', '');
  out.push('## Totals', '', ...summaryLines(t).map((l) => `- ${l}`), '');
  out.push('## 1. What the app does when you open an old chapter', '');
  for (const [title, text] of DESIGN) out.push(`**${title}.** ${text}`, '');
  out.push('Measured on these chapters, with the switch on:', '', mdTable(openTable(t)), '');
  out.push('What the notice says for each chapter, read from the app\'s own count, beside this report\'s count:', '', mdTable(noticeTable(t)), '');
  out.push('## 2. Per chapter', '', 'A figure in brackets is the part that is not the engine: the file was already behind what the app does on open today.', '', mdTable(chapterTable(t)), '');
  out.push('## 3. Every box that changes', '');
  const unexplained = changed.filter((b) => b.unexplained.length);
  out.push(`### Unexplained (${unexplained.length})`, '', unexplained.length ? unexplained.map((b) => `- \`${b.id}\`: ${b.unexplained.join(', ')}`).join('\n') : 'None.', '');
  for (const g of groups(changed)) {
    out.push(`### ${g.title} (${g.count})`, '');
    if (!g.count) out.push('None.', '');
    if (g.count !== g.list.length) out.push(`${g.count - g.list.length} of them are shown above, under another heading.`, '');
    for (const b of g.list) {
      out.push(`#### \`${b.id}\` (page ${b.page}, ${b.font} ${px(b.size)} px${b.bold ? ' bold' : ''}${b.italic ? ' italic' : ''}, ${b.mode}${b.empty ? ', no text' : ''})`, '');
      out.push(...whatChanged(b).map((p) => `- ${p}`));
      for (const c of b.causes) out.push(`- cause of "${c.what}": ${c.cause ?? 'NOT EXPLAINED'}${c.rule ? ` [${c.rule}]` : ''}`);
      if (b.change.lines) out.push('', 'before:', '', '```', ...b.linesBefore, '```', '', 'after:', '', '```', ...b.linesAfter, '```');
      out.push('', b.empty ? 'No text: nothing to draw.' : `before: ${b.before ? `![before](${b.before})` : 'Safari\'s capture has no picture of this box'} after: ${b.picture ? `![after](${b.picture})` : 'not painted'}`, '');
    }
  }
  out.push('## 4. Fonts to load', '');
  if (!t.fontsToLoad.length) out.push('None: every family the chapters name is loaded or installed.', '');
  else {
    out.push('These families are named by a box and are neither among the loaded fonts nor installed on this Mac. The browser fetched them from Google Fonts; the Rust engine fetches nothing. Until the font file is loaded, the engine sets their boxes in the last-resort family.', '');
    out.push(mdTable({ head: ['family', 'kind', 'boxes', 'chapters', 'drawn in today', 'picture'], rows: t.fontsToLoad.map((f) => [f.family, f.kind, `${f.boxes} (${f.withText} with text)`, Object.entries(f.chapters).map(([c, n]) => `${c} (${n})`).join(', '), f.drawnIn, f.picture ? `![](${f.picture})` : '']) }), '');
  }
  out.push('## 5. Letters borrowed from another font', '', `${borrowing.length} boxes hold a letter their font has no glyph for.`, '');
  const fams = new Map();
  for (const b of borrowing) for (const x of b.borrowed) fams.set(x.family, (fams.get(x.family) ?? 0) + 1);
  if (fams.size) out.push(mdTable({ head: ['drawn from', 'boxes'], rows: [...fams].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) }), '');
  out.push(`Boxes with a letter no installed font has: ${borrowing.filter((b) => b.none.length).length}. Boxes with a letter whose font could not be read: ${borrowing.filter((b) => b.unread.length).length}.`, '');
  out.push('## 6. Going back: a chapter the Rust engine fitted, opened by the browser engine', '');
  out.push('The document as the Rust engine left it, opened again with the switch off. Measured with the stand-in browser (Skia in node, smart-mode chapters only). The last two columns are inferred from Safari\'s capture: boxes the engine flags and Safari\'s check passes, and the reverse, among the boxes whose height did not change.', '', mdTable(backTable(t)), '');
  out.push('## 7. How this was made', '');
  out.push(`- Engine: the wasm with sha256 \`${t.run.wasm}\`. Fonts: ${t.run.userFamilies} families of the user's, ${t.run.installedFamilies} installed families found on this Mac. Last resort: ${t.run.lastResort}.`);
  out.push(`- A chapter saved before it carried its own mode was opened as \`${t.run.legacyMode ?? 'n/a'}\`.`);
  out.push('- "Before" is the file (position, size, height, flag) and Safari\'s capture `runs/ref-wk/base` (lines, block position, its own overflow check, the picture). "After" is the app\'s own open path under the Rust engine, in node.');
  out.push('- The answers of the app\'s native side (a system font\'s bytes, which installed font has a letter) are re-made in node from the same rules; they decide only the boxes of sections 4 and 5.');
  out.push('- System faces handed to the engine: ' + (Object.entries(t.systemFacesServed).map(([f, s]) => `${f} (${Object.keys(s).join(', ')})`).join('; ') || 'none') + '.');
  out.push('');
  return out.join('\n');
}

function html(t, changed, borrowing, uris) {
  const img = (rel, alt) => (rel && uris.has(rel) ? `<img alt="${alt}" src="${uris.get(rel)}">` : `<span class="none">no picture</span>`);
  const table = ({ head, rows }) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  const parts = [];
  parts.push('<h1>What happens to the 13 chapters under the Rust text engine</h1>');
  parts.push('<p class="lead">Dry run on copies. Nothing here touched a chapter in the library.</p>');
  parts.push('<h2>Totals</h2><ul>', ...summaryLines(t).map((l) => `<li>${bold(l)}</li>`), '</ul>');
  parts.push('<h2>1. What the app does when you open an old chapter</h2>');
  for (const [title, text] of DESIGN) parts.push(`<p><b>${esc(title)}.</b> ${bold(text)}</p>`);
  parts.push('<p>Measured on these chapters, with the switch on:</p>', table(openTable(t)));
  parts.push('<p>What the notice says for each chapter, read from the app\'s own count, beside this report\'s count:</p>', table(noticeTable(t)));
  parts.push('<h2>2. Per chapter</h2><p>A figure in brackets is the part that is not the engine: the file was already behind what the app does on open today.</p>', table(chapterTable(t)));
  parts.push('<h2>3. Every box that changes</h2>');
  const unexplained = changed.filter((b) => b.unexplained.length);
  parts.push(`<h3>Unexplained (${unexplained.length})</h3>`, unexplained.length ? `<ul>${unexplained.map((b) => `<li><a href="#${esc(b.id)}"><code>${esc(b.id)}</code></a>: ${esc(b.unexplained.join(', '))}</li>`).join('')}</ul>` : '<p>None.</p>');
  for (const g of groups(changed)) {
    parts.push(`<h3>${esc(g.title)} (${g.count})</h3>`);
    if (!g.count) parts.push('<p>None.</p>');
    if (g.count !== g.list.length) parts.push(`<p>${g.count - g.list.length} of them are shown above, under another heading.</p>`);
    for (const b of g.list) {
      parts.push(`<section class="box" id="${esc(b.id)}"><h4><code>${esc(b.id)}</code> <span>page ${b.page}, ${esc(b.font)} ${px(b.size)} px${b.bold ? ' bold' : ''}${b.italic ? ' italic' : ''}, ${b.mode}${b.empty ? ', no text' : ''}</span></h4>`);
      parts.push(`<ul>${whatChanged(b).map((p) => `<li>${esc(p)}</li>`).join('')}${b.causes.map((c) => `<li class="${c.cause ? 'cause' : 'open'}">cause of "${esc(c.what)}": ${esc(c.cause ?? 'NOT EXPLAINED')}${c.rule ? ` <em>[${esc(c.rule)}]</em>` : ''}</li>`).join('')}</ul>`);
      if (b.change.lines) parts.push(`<div class="lines"><div><b>before</b><pre>${esc(b.linesBefore.join('\n'))}</pre></div><div><b>after</b><pre>${esc(b.linesAfter.join('\n'))}</pre></div></div>`);
      parts.push(b.empty ? '<p class="none">No text: nothing to draw.</p></section>' : `<div class="pics"><figure>${img(b.before, 'before')}<figcaption>before (Safari)</figcaption></figure><figure>${img(b.picture, 'after')}<figcaption>after (Rust engine)</figcaption></figure></div></section>`);
    }
  }
  parts.push('<h2>4. Fonts to load</h2>');
  if (!t.fontsToLoad.length) parts.push('<p>None: every family the chapters name is loaded or installed.</p>');
  else {
    parts.push('<p>These families are named by a box and are neither among the loaded fonts nor installed on this Mac. The browser fetched them from Google Fonts; the Rust engine fetches nothing. Until the font file is loaded, the engine sets their boxes in the last-resort family.</p>');
    for (const f of t.fontsToLoad) {
      parts.push(`<section class="box"><h4>${esc(f.family)} <span>${esc(f.kind)}, ${f.boxes} boxes (${f.withText} with text): ${esc(Object.entries(f.chapters).map(([c, n]) => `${c} (${n})`).join(', '))}; drawn in ${esc(f.drawnIn)} today</span></h4>`);
      parts.push(`<div class="pics"><figure>${img(f.before, 'before')}<figcaption>Safari, in the font itself</figcaption></figure><figure>${img(f.picture, 'after')}<figcaption>Rust engine today, in ${esc(f.drawnIn)} (<code>${esc(f.first ?? 'no box of it has text')}</code>)</figcaption></figure></div></section>`);
    }
  }
  parts.push('<h2>5. Letters borrowed from another font</h2>', `<p>${borrowing.length} boxes hold a letter their font has no glyph for.</p>`);
  const fams = new Map();
  for (const b of borrowing) for (const x of b.borrowed) fams.set(x.family, (fams.get(x.family) ?? 0) + 1);
  if (fams.size) parts.push(table({ head: ['drawn from', 'boxes'], rows: [...fams].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) }));
  parts.push(`<p>Boxes with a letter no installed font has: ${borrowing.filter((b) => b.none.length).length}. Boxes with a letter whose font could not be read: ${borrowing.filter((b) => b.unread.length).length}.</p>`);
  parts.push('<h2>6. Going back: a chapter the Rust engine fitted, opened by the browser engine</h2>');
  parts.push('<p>The document as the Rust engine left it, opened again with the switch off. Measured with the stand-in browser (Skia in node, smart-mode chapters only). The last two columns are inferred from Safari\'s capture: boxes the engine flags and Safari\'s check passes, and the reverse, among the boxes whose height did not change.</p>', table(backTable(t)));
  parts.push('<h2>7. How this was made</h2><ul>');
  parts.push(`<li>Engine: the wasm with sha256 <code>${esc(t.run.wasm)}</code>. Fonts: ${t.run.userFamilies} families of the user's, ${t.run.installedFamilies} installed families found on this Mac. Last resort: ${esc(t.run.lastResort)}.</li>`);
  parts.push(`<li>A chapter saved before it carried its own mode was opened as <code>${esc(t.run.legacyMode ?? 'n/a')}</code>.</li>`);
  parts.push('<li>"Before" is the file (position, size, height, flag) and Safari\'s capture <code>runs/ref-wk/base</code> (lines, block position, its own overflow check, the picture). "After" is the app\'s own open path under the Rust engine, in node.</li>');
  parts.push('<li>The answers of the app\'s native side (a system font\'s bytes, which installed font has a letter) are re-made in node from the same rules; they decide only the boxes of sections 4 and 5.</li>');
  parts.push(`<li>System faces handed to the engine: ${esc(Object.entries(t.systemFacesServed).map(([f, s]) => `${f} (${Object.keys(s).join(', ')})`).join('; ') || 'none')}.</li></ul>`);
  parts.push('<h2>Signed</h2><p class="sign">I have read the totals and looked at the changed boxes. Name: ______________________ Date: ____________</p>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>P9 dry run: old chapters under the Rust text engine</title>
<style>
body{font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#1c1c1c;max-width:1100px;margin:24px auto;padding:0 20px}
h1{font-size:26px}h2{margin-top:40px;border-bottom:1px solid #ccc;padding-bottom:4px}h3{margin-top:32px}
h4{margin:0 0 6px;font-size:14px}h4 span{font-weight:400;color:#555}
table{border-collapse:collapse;font-size:13px;margin:10px 0}th,td{border:1px solid #ccc;padding:3px 8px;text-align:right}th:first-child,td:first-child{text-align:left}
th{background:#f1f1f1}code{font-size:12px}.lead{color:#555}
.box{border:1px solid #ddd;border-radius:6px;padding:10px 12px;margin:12px 0}
.box ul{margin:4px 0 8px;padding-left:20px}.cause{color:#234}.open{color:#b00020;font-weight:600}
.pics{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0;background:#fff;border:1px solid #eee;padding:6px}
figure img{max-width:500px;max-height:360px;display:block;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}
figcaption{font-size:12px;color:#555;margin-top:4px}.none{display:inline-block;padding:20px;color:#888;font-size:12px}
.lines{display:flex;gap:24px}.lines pre{background:#f6f6f6;padding:6px 10px;margin:4px 0 8px;font-size:12px}
.sign{margin:30px 0 60px;font-size:16px}
</style></head><body>
${parts.join('\n')}
</body></html>
`;
}
