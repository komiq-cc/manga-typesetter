# P3a report: the app can measure with the Rust engine, on the user's own fonts

Branch `tp/fonts`, on top of `190e201`. Nothing was pushed.

**[R]** marks what was run and observed in this work; **[N]** marks what was
not run. The desktop app itself was never started: everything about the real
Tauri window, the two new native commands over real IPC, Windows and Linux is
**[N]** and is what the manual check in section 9 is for.

With the preference at its default (`'browser'`) no font source is installed,
no engine is loaded, `fonts.js` keeps nothing extra, and every function answers
as before. Section 7 gives the evidence.

## 1. What was built, file by file

### The switch

- **`src/lib/prefs.svelte.js`**: the preference `textEngine`, `'browser'`
  (default) or `'rust'`, stored with the others. Anything else read from
  storage is `'browser'`. `setPref` and the load at import both call
  `useTextEngine`.
- **`src/lib/engine-switch.svelte.js`** (new): applies the preference.
  `engineSwitch` is the state the UI reads (`available`, `mode`, `phase`
  `'off' | 'starting' | 'on' | 'failed'`, `error`, `lastResort`).
  `useTextEngine(mode)` starts or leaves. Also `lettersMissing`,
  `boxesMissingLetters` and `whyFontMissing` for the notice. Everything that
  reaches outside (the wasm, Tauri, the font library, the OS) goes through one
  table of dependencies, so the unit tests stand in for all of it.
- **`src/lib/text-engine/wasm.js`** (new): finds the wasm with
  `import.meta.glob(..., { query: '?url', import: 'default', eager: true })`.
  A glob that matches nothing is an empty object, so the app builds and runs
  without the file; `engineWasmUrl` is then `null`.
- **`src/lib/SettingsModal.svelte`**: a "TEXT ENGINE (Experimental)" section in
  the Typesetting tab, one toggle and one line of status under it. Without the
  wasm the toggle is disabled and the line reads "Not in this build. The engine
  is built separately (`npm run build:engine`) ...". Nothing was added to the
  Inspector.

### The engine has the app's fonts

- **`src/lib/text-engine/rust.js`** (the adapter): `addFace(family, slot,
  bytes, index = 0)` now takes a face index; `addFaces(family, bytes,
  [{ slot, index }])` registers several faces of one file, the first with
  `addFont` and the rest with `addSiblingFace`, so a collection's bytes are
  held once, all or nothing; `removeFace(family, slot)` (the family goes with
  its last face); `facesOf(family)`.
- **`src/lib/text-engine/last-resort.js`** (new): the rule of section 3.
- **`src/lib/text-engine/font-sync.js`** (new): the engine's registry, kept in
  step with the app's lists. It imports neither the store nor Tauri; the lists,
  the two ways of getting bytes and the "something landed" callback are handed
  in. Every name resolves to one of three states: **ready** (measured as
  itself), **arriving** (bytes on the way; measured as the last resort
  meanwhile, and the store writes nothing from that), **missing** (measured as
  the last resort for as long as that is true).
  - User faces: TTF/OTF as they are; a `.ttc` the user dropped gives face 0;
    WOFF/WOFF2 goes to `toSfnt` first and is "arriving" until it is back.
    Where nothing can decode it (a plain browser) the face is unusable and the
    family, if it has no other usable face, is missing with the reason
    `'compressed'`.
  - System faces: nothing is sent for until a name is first asked about. All
    the family's files are collected first and registered together, so a
    family is never half there. A failed fetch makes the family missing, and
    the next scan gives it another try.
  - A user family and a system family of one name: the user's wins, as in the
    store's lookup.
  - `fallbackChain()` is the last resort alone. The comment on it marks the
    seam for coverage fallback.
- **`src/lib/fonts.js`**: `watchUserFaces(watcher)` reports every user face
  that arrives or leaves (`added` with its bytes, `removed`, `removedFamily`,
  `scanned`) before the relayout that follows; `fontsBooted()` resolves when
  the first restore and the first scan have both settled; `loadedFaceRecords()`
  gives the bytes of every face the session has loaded (from IndexedDB, plus
  the faces that loaded and could not be saved). With no watcher no bytes are
  kept or copied.
- **`src-tauri/src/system_fonts.rs`**: the scan now remembers, per family and
  slot, the file and the index of the face in it. Several faces fold into one
  slot (Thin, Light, Regular, Medium are all `regular`), and the one remembered
  is the one CSS font matching would draw for weight 400 or 700 at normal
  width, because the webview still paints. The new command
  `system_font_face(family, slot)` answers with a raw `tauri::ipc::Response`:
  a 16-byte header (four little-endian `i32`, one per slot: the index of that
  slot's face in this file, or -1) and then the file. A collection therefore
  crosses once. Paths and indices stay on the Rust side; the list the frontend
  receives is unchanged.
- **`src-tauri/src/font_decode.rs`** (new): `font_to_sfnt` takes a WOFF or
  WOFF2 file as the raw body of the call and answers with the sfnt, through
  `wuff`, off the main thread.
- **`src-tauri/src/lib.rs`**: the two commands registered.
- **`src-tauri/Cargo.toml`, `Cargo.lock`**: `wuff = "0.2.9"`, the only new
  crate. Its Brotli and zlib decoders were already in the tree. `wuff` is an
  edition-2024 crate, so `rust-version` moves from 1.77.2 to 1.85.

### The store and measuring

- **`src/lib/store.svelte.js`**: `setFontSource({ nameFor, ready, missing })`,
  the one hook. `fontNameFor` and `fontMissing` ask it when it is there and
  answer exactly as before when it is not. New: `measuredFontFor(name)`,
  `missingFonts(pages)`. `faceReady` is false, and `reviewBox`, `refitBox`,
  `autoFitBoxTo`, `fitBoxNow` do nothing, while the box's face is arriving;
  `autoFitBox` remembers the box and the fit is done on the relayout that
  follows the arrival.
- **`src/lib/measure.js`**: the face an engine is asked for is named through
  `measuredFontFor`. It is still synchronous and its stand-in branches are
  untouched.

The unknown-name hole from P4 is closed by those two together: the layout
memo's key is the CSS family (`fontCssFor`, through `fontNameFor`) and the
family the engine is asked for is `measuredFontFor`, and with a font source
installed both come from the same answer. So an unknown name is never
answered from another family's numbers.

One limit, stated plainly: the hole is closed wherever the app installs the
engine, because the font source is always installed with it. The bare adapter
used without the app's font source (the P4 tests, the capture harness) still
behaves as `src/lib/measure.engine.test.js` pins it. That test was left as it
is, comment included.

### "Font missing" is visible, with either engine

- **`src/lib/font-menu.js`**: `fontCaveat(name)` gives `'font missing'`, `'not
  in menus'` or nothing. `Inspector.svelte`, `Queue.svelte` and
  `BulkStylePanel.svelte` show it beside the family a box is set in, so a
  hidden family and an absent one no longer read the same.
- **`src/lib/FontNotice.svelte`** (new), in the Text Queue under the review
  list: "N fonts missing", opening to one row per family with its box count
  and what it is set in instead; a click goes to the first box. It clears when
  the font is loaded. With the Rust engine on it also lists boxes holding
  letters no loaded face has. No dialog was added.

### Shared engine files

`text-engine/src/abi.rs`, `engine.rs` and `text-engine/js/engine.mjs` were not
changed: the low-level loader already had `addFont(data, faceIndex)` and
`addSiblingFace`. Nothing under `text-engine/src/paint*`, `js/paint.mjs`,
`parity/paint*`, `scripts/text-port/` or `src/test/text-port/` was touched.

## 2. Startup order

`App.svelte` imports `prefs.svelte.js`, which applies what it finds on import,
before `restoreFonts()` and `scanSystemFonts()` are called on mount. With the
preference on:

1. **The gate.** The browser engine stays installed and the store is told no
   face is ready. From here nothing writes a size or a height into the
   document: a box placed now is `pending`, a fit asked for now is held. What
   is on screen is the browser's layout, written nowhere.
2. **The wasm**, fetched from the app's own bundle and compiled, once per
   session however often the switch is flipped. A failure is not remembered.
3. **The app's own lists**: the wait for `fontsBooted()`, so the user's
   library is out of IndexedDB and the system scan is back.
4. **The user's faces**: every loaded face is handed to the engine, then
   whatever `fonts.js` reported in the meantime, in order, each face once.
5. **The last resort**: chosen, sent for if it is a system family, registered.
6. **On**: the engine is installed, the store is told how names resolve, and
   everything is laid out once (`noteFontsChanged`).

So geometry is written once, by the Rust engine, not once by each. A system
family other than the last resort is not part of this: its bytes are sent for
the first time a box uses it, and its boxes wait as in step 1.

Turning it off puts back whatever was measuring before, removes the font
source, empties the registry and lays everything out again. Turned off while
starting, nothing of the engine is left and the held fits are done by the
browser.

## 3. The last-resort rule

`src/lib/text-engine/last-resort.js`, tested in `last-resort.test.js`:

| OS | families, in order |
| --- | --- |
| macOS | Helvetica Neue, Helvetica, Arial |
| Windows | Segoe UI, Arial |
| Linux | DejaVu Sans, Liberation Sans, Noto Sans |

1. The first family of the OS's list that is installed.
2. Otherwise the user's family that sorts first by name.
3. Otherwise the system family that sorts first by name.
4. Otherwise none.

An OS that cannot be named tries the three lists in the order above. Outside
Tauri there are no system faces, so the rule starts at step 2. With no last
resort the engine is not installed at all: measuring is the stand-in it is
wherever there is no engine, and nothing is written from it. A system family
that could not be read is skipped, and the next candidate is taken.

## 4. What differs between the two settings, and why

1. **The numbers.** Line breaks and auto-fitted sizes come from the Rust
   engine, which is the point. Turning the switch on, or off, lays the open
   chapter out again, so auto-fitted boxes can change size. The chapter is not
   marked with the engine that laid it out.
2. **Every built-in font is a missing font.** The built-ins are web fonts the
   browser fetches; the engine has no bytes for them and may not fetch any. So
   with the switch on a box set in a built-in, **the default `Comic Neue`
   included**, is measured in the last resort, drawn in the last resort
   (drawing follows the same name, so what is seen is what was measured), and
   listed as missing. Settings says so while the switch is on. This is the
   largest visible change, and it lasts until the bytes of those families
   reach the engine some permitted way.
3. **An unknown name** is set in the last resort, not in `Comic Neue`
   (`FALLBACK_FONT`), for the same reason.
4. **A PSD export** names the last resort for a missing family, since it
   reads the same resolution.
5. **System fonts arrive late.** The first box to use a system family sends
   for its file. Until it lands the box is shown in the last resort's layout
   and nothing is written; a box placed then is `pending`.
6. **Fits are held** while the engine starts and while a face is arriving.
7. **A WOFF/WOFF2 user font in a plain browser** is a missing font with the
   reason shown in the notice. In the desktop app it is decoded natively.
8. **A `.ttc` the user dropped** is measured as its face 0. What the browser
   draws from a collection handed to `FontFace` is its own choice and was not
   compared.
9. **A family that is both a built-in and installed** is measured from the
   installed file while the browser still draws the web font of that name. If
   the two are different versions they can disagree.
10. **Letters no font has** are listed only with the Rust engine. A browser
    substitutes a system font silently and tells nobody.
11. **No font at all** (a plain browser, empty library): no engine is
    installed and text is laid out by estimate, where the browser setting
    would have measured in its own default font.

## 5. What is not done

- **Coverage fallback.** The chain is the last resort alone, a Latin face on
  every OS list. Kana, Hangul and CJK in a face without them are measured as
  empty boxes and reported by `engine.missing`. The seam is `fallbackChain()`
  in `font-sync.js`.
- **Variable font instances.** Nothing here selects an instance of a
  variable font.
- **PostScript names from the engine.** `fonts.js` still parses them itself.
- **PSD.** Untouched apart from item 4 above, which follows from the shared
  name resolution.
- **Bytes for the built-in fonts** (section 4, item 2).
- No size limit on a system font file sent to the webview.
- `package-flow`'s own font status is untouched.
- `src/lib/measure.engine.test.js` still pins the bare adapter's old
  behaviour, and its comment is now out of date for the app.
- No release workflow was changed (section 6).

## 6. Release build

`tauri.conf.json` runs `npm run build` before a build, unchanged. For the wasm
to be in the bundle, `npm run build:engine` has to run before that, which
needs `rustup target add wasm32-unknown-unknown`. Neither
`.github/workflows/release.yml` nor `dev-build.yml` does either today, so a
release built by them carries no wasm and the switch reads "Not in this
build". That is a safe default, and it means the feature does not ship until
those two steps are added. I did not add them.

`ci.yml` runs `npm test` without building the engine, and the engine lane
fails by design when the wasm is absent. That was already so after P4; there
are two more files in that lane now.

The wasm is 1,840,027 bytes in this build. `wuff` needs Rust 1.85 or newer;
the workflows install `stable`.

## 7. Test results

All of this was run on this Mac (macOS, rustc 1.96.0, node 26) **[R]**.

| check | result |
| --- | --- |
| `./node_modules/.bin/vitest run`, whole suite, wasm built | 87 files passed, 1 skipped; 2,790 tests passed, 7 skipped. Before this work: 78 files, 2,679 tests, the same 1 and 7 skipped |
| by lane | unit 76 files / 2,647; dom 2 / 11; realfont 5 passed, 1 skipped / 74 passed, 7 skipped; engine 4 / 58 |
| engine lane with the wasm moved aside | the two new engine files fail with "mt_text.wasm is missing: run npm run build:engine"; the new unit and dom files (7 files, 94 tests) pass without it |
| `cargo test` in `src-tauri` | 274 passed, 0 failed (10 of them in `system_fonts`, 3 in `font_decode`) |
| `npm run build` with the wasm | succeeds; `dist/assets/mt_text-DlfDhhMZ.wasm` is emitted |
| `npm run build` without the wasm | succeeds; no wasm in `dist` |
| default mode unchanged: `node scripts/text-port/capture-node.mjs --data <tp-data> --run p3a-check`, at commit `ecec78e`, clean tree | 64,718 metrics, 17,538 layout, 3,732 pixel cases, 0 errors. `metrics.jsonl`, `layout.jsonl` and `pixels.jsonl` are byte-identical to `runs/ref-sk/base` (`cmp`), and so are all 3,401 PNGs (`diff -rq`, no difference). The `p3a-check` run was deleted afterwards |
| `cargo clippy --all-targets -- -D warnings` in `src-tauri` | two `unnecessary_map_or` errors, both in `src/brush/score.rs`, a file this branch does not touch; nothing in the files it does. With the local clippy 1.96 that lint fails the command as CI runs it, with or without this branch |

Two things happened on the way that are worth knowing:

- A mutation check: with the store's "face arriving" guard switched off, four
  of the switch tests fail. With the "hand over once" fix removed, its test
  fails. Both were put back.
- One run of the whole suite, made while `cargo test` was compiling beside it
  (load average about 75), had one failure: the first case of
  `prefs-text-engine.test.js` timed out at 5 s on its first import of the
  store. The file passed alone three times. Its first import now happens in a
  `beforeAll` with room, and the whole suite passed after that on a quiet
  machine. I did not reproduce the timeout a second time, so "fixed" is an
  inference from the cause, not an observation.

Not run **[N]**: the desktop app; `system_font_face` and `font_to_sfnt` over
real IPC (the raw request body in particular is as the Tauri 2 API documents
it, and untried); anything on Windows or Linux, including the scan's file
choice there and the Rust tests that read the machine's own fonts; the app in
a plain browser (`vite dev` was not opened).

## 8. Tests added

No existing test file was edited.

| file | lane | what it covers |
| --- | --- | --- |
| `src/lib/text-engine/last-resort.test.js` | unit | the rule, per OS |
| `src/lib/text-engine/font-sync.test.js` | unit | the registry against a fake engine: the three states, WOFF decoding and its failures, lazy system faces, collections, a name both lists have, the last resort and the next one when the first cannot be read |
| `src/lib/engine-switch.test.js` | unit | wasm absent; on and off; wasm loaded once; failure and retry; off while starting; the gate; `pending` placement; every way a user face arrives or leaves; system faces; the unknown-name hole; the missing list; letters missing |
| `src/lib/prefs-text-engine.test.js` | unit | the preference stored, applied, applied at launch |
| `src/lib/fonts-watch.test.js` | unit | what `fonts.js` tells a watcher, the bytes read back, the boot promise |
| `src/lib/font-menu.test.js` | unit | the menu's word for a missing and for a hidden family |
| `src/lib/FontNotice.dom.test.js` | dom | the notice: absent when nothing is missing, the count and rows, the jump to the first box, clearing when the font is loaded |
| `src/lib/text-engine/font-sync.engine.test.js` | engine | the real adapter: a face by index out of a collection built in memory, bytes shared, `removeFace`, the fallback chain |
| `src/lib/engine-switch.engine.test.js` | engine | the switch through the store and `fonts.js` with the real wasm and fixture fonts |
| `src-tauri/src/system_fonts.rs` | cargo | slot ranking, the header, a real scan, the last-resort families on this machine read face by face |
| `src-tauri/src/font_decode.rs` | cargo | WOFF and WOFF2 written by hand in the test, and refusals |

Helpers: `src/test/fake-rust-engine.js`, `src/test/font-collection.js`. No
font file was added; no code fetches a font.

## 9. Manual check, in the desktop app [N: not run by me]

Before: `rustup target add wasm32-unknown-unknown`, `npm run build:engine`,
then `npm run tauri dev`.

1. **Default.** Settings, Typesetting, TEXT ENGINE: the toggle is off and the
   line starts "Off: text is measured by the browser". Open a chapter you
   know. Nothing should look different from the main build.
2. **On.** Turn the toggle on. The line should pass through "Starting" to
   "On. ... is set in Helvetica Neue" (on a Mac). No toast. If it reads "Could
   not start", the text after the dash is the error to send back.
3. **A chapter set in your own fonts.** Line breaks should stay close to what
   they were; an auto-fitted box may change size by a little. Nothing should
   jump twice.
4. **Built-ins.** A box in `Comic Neue` or any other built-in should now be
   drawn in Helvetica Neue, its font menu should read "(font missing)", and
   the Text Queue should show "N fonts missing" under the review list. Open
   it: one row per family, with a count; a click selects the first box.
5. **A system font.** Show a system family in the Font Library, set a box in
   it. For a moment the box is laid out in the last resort, then settles in
   its own face. Try one that lives in a `.ttc` (Helvetica Neue, Avenir Next)
   in bold and italic.
6. **A WOFF2 font.** Add a `.woff2` to the Font Library and set a box in it.
   It should measure as itself and not be listed as missing. This is the only
   check of `font_to_sfnt` over real IPC.
7. **Missing, then loaded.** Open a chapter that names a font you do not
   have. It is in the notice. Add the font: the row should go and the boxes
   should be set in it, without reopening the chapter.
8. **Remove** a user font in use: its boxes fall to the last resort and the
   family appears in the notice.
9. **Restart with the switch on.** Open the same chapter. It should come up
   as it was left, with no visible second layout. Note whether merely opening
   it marks the chapter as changed; I could not observe that.
10. **Off.** Turn the toggle off. Built-ins draw as themselves again, the
    notice lists only families that are really absent, and the layout is the
    browser's.
11. **Without the wasm.** Move `text-engine/js/generated` aside and restart
    `npm run tauri dev`: the toggle is disabled and the line says why. Put it
    back afterwards.

Things I would look at hardest: step 6 (the raw request body), step 5 on a
collection, and step 9.

## 10. Commits

```
153533b test(fonts): the preference tests pay for the first import outside any one case
ecec78e test(fonts): the font registry against the real engine, and what fonts.js tells a watcher
1aa1e44 fix(fonts): a face that arrives while the engine starts is handed over once
6c8fb25 feat(fonts): a WOFF or WOFF2 face is decoded natively for the rust engine
6d8c69b feat(fonts): a system face's file can be asked for, as raw bytes
4a2a1ad feat(fonts): a missing font says so, in the font menus and once for the whole chapter
066599b feat(fonts): a switch for who measures text, off by default
32b1b4b feat(fonts): the rust engine's fonts are kept in step with the app's
30572fd feat(fonts): the last-resort family is chosen by one fixed rule per OS
a92b7e3 feat(text): the rust adapter takes a face out of a collection, and gives one face back
```

Plus the commit that adds this report. None has a `Co-Authored-By` line or any
other trailer. Nothing was pushed.
