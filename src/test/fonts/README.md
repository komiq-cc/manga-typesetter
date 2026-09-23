# Real-font test fixtures

Fonts for the `realfont` test project (see `vite.config.js` and
`src/test/real-fonts.js`). They let the tests measure and draw text with real
advances, kerning, side bearings and vertical metrics instead of the
`chars x size x 0.55` stand-in the unit tests use.

| File | Registered as | Source | Licence |
|---|---|---|---|
| `ComicNeue-Regular.ttf` | `Comic Neue` | github.com/google/fonts `ofl/comicneue` | SIL OFL 1.1, `OFL-ComicNeue.txt` |
| `Bangers-Regular.ttf` | `Bangers` | github.com/google/fonts `ofl/bangers` | SIL OFL 1.1, `OFL-Bangers.txt` |
| `DejaVuSans.ttf`, `DejaVuSans-Oblique.ttf` | `DejaVu Sans` | DejaVu 2.35, as bundled with matplotlib | Bitstream Vera licence + public domain, `LICENSE_DEJAVU` |

Comic Neue is the app's fallback and default font, Bangers a narrow comic caps
face, DejaVu Sans a wide text face with a real oblique.

## Running

`npx vitest run` runs both projects. One lane only:

```sh
npx vitest run --project realfont
npx vitest run --project unit
```

A test file joins the real-font lane by its name: `*.realfont.test.js`. The
setup replaces `document` with one that can only make canvases, so these tests
switch the typesetting beta on (`setTypesetEnabled(true)`); with it off,
`layoutLines` needs a browser's DOM line layout.

## Limits

- Regular faces only (plus DejaVu's oblique). Bold is synthesised by Skia with
  the regular advances, so tests that measure widths use `bold: false`.
- None of these faces has Hangul, kana or CJK. With the app's CSS
  (`'Comic Neue', cursive`) Skia draws those as `.notdef` boxes about half an
  em wide, where a browser would fall back to a real CJK face about one em wide.
- Skia also sees the machine's installed fonts. Tests only name the families
  above, so results do not depend on the machine.
