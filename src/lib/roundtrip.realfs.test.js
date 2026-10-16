// ===== The edit -> save -> reopen round trip, against a real filesystem =====
//
// library.realfs.test.js proves the bytes of a chapter's *images* survive the
// copy. This file asks the other half of the same question, and the one the
// user actually notices: does the WORK survive? A box moved, a line typed, a
// style changed, a page turned - all of it goes to disk through one debounced
// writer, and every route out of the editor is supposed to drain it.
//
// Everything here runs the real `library.svelte.js` over node:fs, the same way
// its sibling does, because the failures being pinned are failures of the
// save/flush wiring and an in-memory fsx cannot tell a flushed write from a
// dropped one.
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Metrics, for the one describe that lays text out (DET-3). Off everywhere
// else, which is what this environment answers without the mock: no canvas, so
// nothing measures and no box moves on its own.
const metrics = vi.hoisted(() => ({ on: false }));
vi.mock("./measure.js", async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => metrics.on,
}));

vi.mock("./fsx.js", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const live = new Set();
  let tmpSeq = 0;
  return {
    fsx: {
      async readDir(p) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
        }));
      },
      readTextFile: (p) => fs.readFile(p, "utf8"),
      writeTextFile: (p, c) => fs.writeFile(p, c, "utf8"),
      // The real one's shape, not a stand-in for it: a per-write unique temp
      // name (two writes to one path overlap routinely) and a live-set the
      // library's temp sweep asks before it deletes anything of this shape.
      async writeTextFileAtomic(p, c) {
        const tmp = `${p}.${++tmpSeq}.tmp`;
        live.add(tmp);
        try {
          await fs.writeFile(tmp, c, "utf8");
          await fs.rename(tmp, p);
        } finally {
          live.delete(tmp);
        }
      },
      liveTemps() {
        return new Set(live);
      },
      async readFile(p) {
        return new Uint8Array(await fs.readFile(p));
      },
      writeFile: (p, bytes) => fs.writeFile(p, bytes),
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      remove: (p) => fs.rm(p, { recursive: true, force: true }),
      async exists(p) {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      async join(...parts) {
        return path.join(...parts);
      },
      async homeDir() {
        return tmpdir();
      },
    },
  };
});

const {
  library,
  setRoot,
  createProject,
  createChapter,
  openChapter,
  closeChapter,
  flushBeforeLeaving,
  resetSaveFailures,
} = await import("./library.svelte.js");
const {
  app,
  applyDetection,
  addEmptyBox,
  nudgeBox,
  gotoPage,
  byId,
  flushSave,
  endEdit,
  settleEdits,
  cloneStyle,
  DOC_SAVE_MS,
} = await import("./store.svelte.js");
const { undo, history, initHistory } =
  await import("./editor/history.svelte.js");
const { switchHistoryPage } = await import("./editor/history-file.svelte.js");
const { setPageSwitchHook, boxText, setChapterTypesetMode } = await import("./store.svelte.js");
await import("./prefs.svelte.js");
const { typesetEnabled, setTypesetEnabled } = await import("./measure.js");
const { boxCandidate, placeBlock } = await import("./contain.js");
const { setLegacyTypeset } = await import("./data.js");

// ---------- fixtures ----------
const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
function pngBytes(w, h, level) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w);
    for (let x = 0; x < w; x++)
      row[1 + x] = y > h * 0.7 ? level : Math.round((x / w) * 255);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let root;
let srcDir;
const RAWS = ["raw-01.png", "raw-02.png", "raw-03.png"];

function fileFrom(dir, name) {
  return {
    name,
    async arrayBuffer() {
      const buf = await readFile(join(dir, name));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mt-roundtrip-"));
  srcDir = join(root, "sources");
  await mkdir(srcDir, { recursive: true });
  for (let i = 0; i < RAWS.length; i++) {
    await writeFile(join(srcDir, RAWS[i]), pngBytes(400, 600, (i + 1) * 30));
  }
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

let caseSeq = 0;
beforeEach(async () => {
  closeChapter();
  resetSaveFailures();
  // The two hooks App.svelte installs on mount. Without them nothing records an
  // edit and nothing swaps a page's stack, so the history half of the round trip
  // would be testing a build the app never runs.
  initHistory();
  setPageSwitchHook(switchHistoryPage);
  const dir = join(root, `library-${++caseSeq}`);
  await mkdir(dir, { recursive: true });
  await setRoot(dir);
  library.projects = [];
});

const raws = () => RAWS.map((n) => fileFrom(srcDir, n));

// Three pages, with translated lines on the first two - the shape a chapter
// imported with a translations JSON actually has.
async function chapter() {
  const p = await createProject("Round trip");
  const c = await createChapter({
    projectId: p.id,
    number: 1,
    title: "Work",
    files: raws(),
    translations: [
      { lines: [{ n: 1, type: "dialogue", jp: "ああ", en: "" }] },
      { lines: [{ n: 1, type: "dialogue", jp: "いい", en: "" }] },
    ],
  });
  return { p, c };
}

const record = async (c) =>
  JSON.parse(await readFile(join(c.dir, "chapter.json"), "utf8"));
const translations = async (c) =>
  JSON.parse(await readFile(join(c.dir, "translations.json"), "utf8"));

// The document as the user would describe it: every box's identity, text and
// rectangle, page by page. What a reopen has to give back unchanged.
const shape = (pages) =>
  pages.map((pg) => ({
    id: pg.id,
    boxes: (pg.boxes ?? []).map((b) => ({
      id: b.id,
      lineN: b.lineN,
      text: b.text ?? null,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    })),
    lines: (pg.lines ?? []).map((l) => ({
      n: l.n,
      jp: l.jp ?? "",
      en: l.en ?? "",
    })),
  }));

// The detector's geometry is the one thing on a page that cannot be typed back
// in: a bubble's rectangle is where the Japanese sat, and once it is gone the
// only way to get it again is to run the engine again. So it has to reach the
// disk from every route that runs detection - and there is exactly one,
// `applyDetection`, shared by the single-page and whole-chapter menu entries in
// both chapter modes. Proven on the real filesystem, mode by mode, rather than
// assumed from the in-memory store tests.
describe.each(["typeset", "translate"])(
  "detected geometry survives the trip to disk in %s mode",
  (mode) => {
    it("is on disk after the autosave, in chapter.json and translations.json, and comes back on reopen", async () => {
      const p = await createProject("Detect");
      const c = await createChapter({
        projectId: p.id,
        number: 1,
        title: "Work",
        files: raws(),
        translations: [
          { lines: [{ n: 1, type: "dialogue", jp: "ああ", en: "Ah" }] },
        ],
        mode,
      });
      await openChapter(p.id, c.id);
      expect(app.chapterMode).toBe(mode);
      const pg = app.pages[0];
      // The engine's payload, quoted in the page's own space so nothing rescales.
      applyDetection(
        {
          img_width: pg.w,
          img_height: pg.h,
          panels: [[0, 0, pg.w, pg.h]],
          lines: [
            {
              n: 1,
              type: "dialogue",
              jp: "ああ",
              en: "",
              box: [10, 20, 110, 220],
              vertical: true,
              font_size: 24,
            },
            {
              n: 2,
              type: "sfx",
              jp: "ドン",
              en: "",
              box: [300, 400, 360, 520],
              vertical: true,
              font_size: 30,
            },
          ],
        },
        pg,
      );
      // The English typed against line 1 rides through the re-detection.
      expect(pg.lines.map((l) => l.en)).toEqual(["Ah", ""]);

      await flushSave();
      const rec = await record(c);
      expect(rec.pages[0].detect.panels).toEqual([[0, 0, pg.w, pg.h]]);
      expect(rec.pages[0].detect.boxes).toEqual([
        { n: 1, box: [10, 20, 110, 220], vertical: true, font_size: 24 },
        { n: 2, box: [300, 400, 360, 520], vertical: true, font_size: 30 },
      ]);
      const tl = await translations(c);
      expect(tl.pages[0].lines.map((l) => l.box)).toEqual([
        [10, 20, 110, 220],
        [300, 400, 360, 520],
      ]);

      expect(await flushBeforeLeaving("editor")).toBe(true);
      closeChapter();
      await openChapter(p.id, c.id);
      expect(app.pages[0].detect).toEqual(rec.pages[0].detect);
      closeChapter();
    });
  },
);

describe("an edit survives the trip to disk and back", () => {
  it("gives back the same boxes, text and geometry after a leave and reopen", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);

    // A box typed onto page 1, moved, and given text - the three edits the bug
    // report names, made the way the editor makes them.
    const id = addEmptyBox(120, 200);
    endEdit("Hello there");
    nudgeBox(id, 17, -9);
    settleEdits();

    const before = shape(app.pages);
    expect(before[0].boxes).toHaveLength(1);
    expect(before[0].boxes[0].text ?? before[0].lines.at(-1).en).toBe(
      "Hello there",
    );

    // The way out of the editor, exactly as the route takes it.
    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();

    await openChapter(p.id, c.id);
    expect(shape(app.pages)).toEqual(before);
    closeChapter();
  });

  it("writes the working translations.json beside chapter.json on every save", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);

    // Type a translation onto the imported line and place it.
    app.pages[0].lines[0].en = "Ahh.";
    const id = addEmptyBox(60, 60);
    endEdit("free");
    settleEdits();
    await flushSave();

    const t = await translations(c);
    const page1 = t.pages.find((x) => x.page === app.pages[0].id);
    expect(page1.lines.find((l) => l.n === 1).en).toBe("Ahh.");
    // The free-typed box reaches the file too - as its own line, since a box
    // typed on the canvas gets one.
    expect(page1.lines.some((l) => l.n < 0 && l.en === "free")).toBe(true);
    closeChapter();
  });

  it("keeps edits made on a page other than the first", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);

    gotoPage(2);
    const id = addEmptyBox(200, 300);
    endEdit("page three");
    settleEdits();

    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();

    const rec = await record(c);
    expect(rec.pages[2].boxes).toHaveLength(1);
    expect(rec.pages[0].boxes).toHaveLength(0);
  });

  it("does not lose an edit made while the previous save is still in flight", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);

    const id = addEmptyBox(100, 100);
    endEdit("first");
    settleEdits();
    const inFlight = flushSave();
    // The user keeps working while the disk is busy - the window the queue in
    // `saveOpenChapter` exists for.
    nudgeBox(id, 40, 40);
    settleEdits();
    await inFlight;
    await flushSave();

    const moved = { x: byId(id).x, y: byId(id).y };
    closeChapter();
    const rec = await record(c);
    expect(rec.pages[0].boxes[0].x).toBe(moved.x);
    expect(rec.pages[0].boxes[0].y).toBe(moved.y);
  });
});

describe("the routes out of a chapter all drain the debounce", () => {
  it("writes what the debounce was holding when its timer fires", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    const id = addEmptyBox(90, 90);
    endEdit("debounced");
    nudgeBox(id, 5, 5);
    // Nothing is asked to save. The timer is the only thing that can write, and
    // this is the path every ordinary edit takes - the flushes are for the way
    // out. Real time rather than fake: the write behind the timer is a run of
    // real filesystem promises, and a fake clock resolves the timer without
    // waiting for them.
    await new Promise((r) => setTimeout(r, DOC_SAVE_MS + 400));
    const rec = await record(c);
    expect(rec.pages[0].boxes).toHaveLength(1);
    expect(app.saved).toBe(true);
    closeChapter();
  });

  it("flushes chapter A before chapter B takes the editor over", async () => {
    const p = await createProject("Two");
    const a = await createChapter({
      projectId: p.id,
      number: 1,
      title: "A",
      files: raws(),
    });
    const b = await createChapter({
      projectId: p.id,
      number: 2,
      title: "B",
      files: raws(),
    });

    await openChapter(p.id, a.id);
    const id = addEmptyBox(150, 150);
    endEdit("in chapter A");
    nudgeBox(id, 11, 3);
    settleEdits();
    const moved = { x: byId(id).x, y: byId(id).y };

    // Straight into the other chapter, with A's edits still inside the debounce.
    await openChapter(p.id, b.id);

    const recA = await record(a);
    expect(recA.pages[0].boxes).toHaveLength(1);
    expect(recA.pages[0].boxes[0].x).toBe(moved.x);
    expect(recA.pages[0].boxes[0].y).toBe(moved.y);
    // …and nothing of A's leaked into B.
    const recB = await record(b);
    expect(recB.pages.every((pg) => (pg.boxes ?? []).length === 0)).toBe(true);
    closeChapter();
  });

  it("keeps the undo stack across a close and a reopen", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    const id = addEmptyBox(70, 70);
    endEdit("undo me");
    settleEdits();
    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    // closeChapter's history teardown is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 20));

    const hist = JSON.parse(
      await readFile(join(c.dir, "logs", "history.json"), "utf8"),
    );
    expect(hist.version).toBe(1);
    expect(Object.keys(hist.pages)).not.toHaveLength(0);

    await openChapter(p.id, c.id);
    expect(history.canUndo).toBe(true);
    undo();
    expect(app.pages[0].boxes).toHaveLength(0);
    closeChapter();
  });

  it("saves an edit made on each of several pages before leaving", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    for (let i = 0; i < 3; i++) {
      gotoPage(i);
      const id = addEmptyBox(100 + i * 10, 100);
      endEdit(`page ${i}`);
      settleEdits();
    }
    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    const rec = await record(c);
    expect(rec.pages.map((pg) => pg.boxes.length)).toEqual([1, 1, 1]);
  });
});

describe("a style survives the trip to disk and back", () => {
  it("gives back every layer of a modern style unchanged", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    const id = addEmptyBox(100, 100);
    endEdit("styled");
    const b = byId(id);
    // Everything the new style schema carries, set to something that is not its
    // default - the whole point being that a default coming back would look like
    // a successful round trip while having lost the edit.
    b.style = cloneStyle({
      ...b.style,
      color: "#ff0055",
      fillOpacity: 0.8,
      blur: 2.5,
      gradient: {
        on: true,
        kind: "radial",
        angle: 45,
        cx: 0.25,
        cy: 0.75,
        radius: 1.5,
        scope: "line",
        stops: [
          { color: "#112233", pos: 0 },
          { color: "#445566", pos: 0.4 },
          { color: "#778899", pos: 1 },
        ],
      },
      pattern: {
        on: true,
        kind: "crosshatch",
        fg: "#010203",
        bg: "#fefdfc",
        scale: 2,
      },
      strokes: [
        { color: "#000000", width: 2, opacity: 0.5 },
        { color: "#00ff00", width: 6, opacity: 1 },
      ],
      shadows: [
        { x: 4, y: 5, blur: 6, color: "#123456", opacity: 0.25 },
        { x: -1, y: -2, blur: 0, color: "#654321", opacity: 1 },
      ],
      roughen: { on: true, amount: 9, detail: 0.2, seed: 42 },
    });
    settleEdits();
    const before = cloneStyle(b.style);

    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    await openChapter(p.id, c.id);
    expect(cloneStyle(app.pages[0].boxes[0].style)).toEqual(before);
    closeChapter();
  });

  it("keeps a box with no stroke and no shadow stroke-less and shadow-less", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    const id = addEmptyBox(100, 100);
    endEdit("bare");
    const b = byId(id);
    b.style = cloneStyle({ ...b.style, strokes: [], shadows: [] });
    settleEdits();

    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    await openChapter(p.id, c.id);
    // The default style has one white stroke. A reopen that hands it back is a
    // reopen that undid the user's edit.
    expect(app.pages[0].boxes[0].style.strokes).toEqual([]);
    expect(app.pages[0].boxes[0].style.shadows).toEqual([]);
    closeChapter();
  });
});

// DET-3. The line breaker is the chapter's, saved in its chapter.json, so the
// same file lays out the same way on a machine whose preference says otherwise.
describe("the chapter's typesetting survives the trip to disk and back", () => {
  const LONG =
    "We have to get out of here before the whole building comes down on top of every one of us";
  const breaks = (pg) =>
    pg.boxes.map((b) => placeBlock(boxCandidate(b, boxText(b, pg))).lines.map((l) => l.text ?? l));
  const heights = (pg) => pg.boxes.map((b) => ({ y: b.y, h: b.h }));

  beforeEach(() => {
    metrics.on = true;
  });
  afterEach(() => {
    metrics.on = false;
    setTypesetEnabled(false);
    setLegacyTypeset("plain");
  });
  // A chapter.json as a build before the field wrote it, or with the field it
  // is given.
  const withField = async (c, typesetting) => {
    const rec = await record(c);
    if (typesetting === undefined) delete rec.typesetting;
    else rec.typesetting = typesetting;
    await writeFile(join(c.dir, "chapter.json"), JSON.stringify(rec));
  };

  it("breaks the lines and sizes the boxes the same when reopened", async () => {
    const { p, c } = await chapter();
    expect((await record(c)).typesetting).toEqual({ mode: "smart", version: 1 });
    await openChapter(p.id, c.id);
    expect(app.typesetting.mode).toBe("smart");
    const id = addEmptyBox(200, 300);
    endEdit(LONG);
    settleEdits();
    const pg = app.pages[0];
    const smart = breaks(pg);
    const geometry = heights(pg);
    // The test means something only if the two breakers disagree here.
    setTypesetEnabled(false);
    expect(breaks(pg)).not.toEqual(smart);
    setTypesetEnabled(true);

    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    await openChapter(p.id, c.id);
    expect(app.typesetting.mode).toBe("smart");
    expect(typesetEnabled()).toBe(true);
    expect(breaks(app.pages[0])).toEqual(smart);
    expect(heights(app.pages[0])).toEqual(geometry);
    expect(byId(id)).toBeTruthy();
    closeChapter();
  });

  // A chapter from before the field was laid out with this machine's switch as
  // it stood then - `legacyTypesetting()`, which prefs.svelte.js freezes from
  // the stored blob (back-compat.test.js pins that reading). The open path is
  // what is tested here.
  it("opens a chapter from before the field smart where the beta was saved on, and stamps it", async () => {
    const { p, c } = await chapter();
    await withField(c, undefined);
    setLegacyTypeset("smart");
    await openChapter(p.id, c.id);
    expect(app.typesetting).toEqual({ mode: "smart", version: 1 });
    expect(typesetEnabled()).toBe(true);
    // The first save writes the field, and from then on the file answers.
    addEmptyBox(200, 300);
    endEdit("stamp");
    settleEdits();
    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    expect((await record(c)).typesetting).toEqual({ mode: "smart", version: 1 });
    setLegacyTypeset("plain");
    await openChapter(p.id, c.id);
    expect(app.typesetting.mode).toBe("smart");
    closeChapter();
  });

  // The line breaking is each box's. A chapter laid out with the old switch
  // off - its field says so, or it has none and this machine had the beta off -
  // opens 'smart' with every box given the plain wrap it was drawn with: the
  // same breaks and the same boxes as the plain chapter, and nothing written.
  for (const [name, field, legacy] of [
    ["saved plain", { mode: "plain", version: 1 }, "smart"],
    ["from before the field, laid out plain here", undefined, "plain"],
  ]) {
    it(`opens a chapter ${name} as smart, with its boxes plain, moving and writing nothing`, async () => {
      const { p, c } = await chapter();
      await openChapter(p.id, c.id);
      addEmptyBox(200, 300);
      endEdit(LONG);
      settleEdits();
      expect(await flushBeforeLeaving("editor")).toBe(true);
      closeChapter();
      await withField(c, field);
      setLegacyTypeset(legacy);
      const onDisk = await readFile(join(c.dir, "chapter.json"), "utf8");
      // What the old switch drew: the chapter opened plain, wholesale.
      await openChapter(p.id, c.id);
      setChapterTypesetMode("plain");
      const plainBreaks = breaks(app.pages[0]);
      const plainBoxes = heights(app.pages[0]);
      closeChapter();
      await writeFile(join(c.dir, "chapter.json"), onDisk);

      await openChapter(p.id, c.id);
      expect(app.typesetting).toEqual({ mode: "smart", version: 1 });
      expect(typesetEnabled()).toBe(true);
      const pg = app.pages[0];
      expect(pg.boxes[0].style).toMatchObject({ shape: "off", hyphenate: false });
      // The balloon is the limit a solved box grows to, which the old switch
      // never turned off: it stays as the file has it.
      expect(pg.boxes[0].style.balloon).toBe(JSON.parse(onDisk).pages[0].boxes[0].style.balloon);
      expect(breaks(pg)).toEqual(plainBreaks);
      expect(heights(pg)).toEqual(plainBoxes);
      expect(app.saved).toBe(true);
      closeChapter();
      expect(await readFile(join(c.dir, "chapter.json"), "utf8")).toBe(onDisk);
    });
  }

  it("lets the field win over this machine's answer whenever it is there", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    addEmptyBox(200, 300);
    endEdit(LONG);
    settleEdits();
    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    // The field says plain and this machine says smart: the boxes open plain.
    setLegacyTypeset("smart");
    await withField(c, { mode: "plain", version: 1 });
    await openChapter(p.id, c.id);
    expect(app.typesetting.mode).toBe("smart");
    expect(app.pages[0].boxes[0].style.shape).toBe("off");
    closeChapter();
    // The field says smart and this machine says plain: the boxes keep theirs.
    setLegacyTypeset("plain");
    await withField(c, { mode: "smart", version: 1 });
    await openChapter(p.id, c.id);
    expect(app.typesetting.mode).toBe("smart");
    expect(app.pages[0].boxes[0].style.shape).toBe("auto");
    closeChapter();
  });

  it("saves the chapter's breaker, switched wholesale, with the chapter", async () => {
    const { p, c } = await chapter();
    await openChapter(p.id, c.id);
    expect(app.typesetting.mode).toBe("smart");
    setChapterTypesetMode("plain");
    expect(typesetEnabled()).toBe(false);
    expect(await flushBeforeLeaving("editor")).toBe(true);
    closeChapter();
    expect((await record(c)).typesetting).toEqual({ mode: "plain", version: 1 });
  });

  it("leaves the store untouched when called with no chapter open", () => {
    closeChapter();
    expect(app.chapterRef).toBe(null);
    const beforeTypesetting = { ...app.typesetting };
    const beforeFonts = app.fontsVersion;
    app.saved = true;
    const beforeEnabled = typesetEnabled();

    setChapterTypesetMode(beforeTypesetting.mode === "smart" ? "plain" : "smart");

    expect(app.chapterRef).toBe(null);
    expect(app.typesetting).toEqual(beforeTypesetting);
    expect(app.fontsVersion).toBe(beforeFonts);
    expect(app.saved).toBe(true);
    expect(typesetEnabled()).toBe(beforeEnabled);
  });
});
