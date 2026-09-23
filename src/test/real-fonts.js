// Setup for the `realfont` test project (vite.config.js), and for nothing else.
//
// The app measures text with a 2D canvas it makes when measure.js is first
// imported (`document.createElement('canvas')` at module load). Under node
// there is no `document`, so every measurement falls back to a stand-in of
// `chars x size x 0.55`, and that is what the `unit` project tests with. This
// file runs before any test module in the `realfont` project is imported, and
// gives measure.js - and the exporter, which draws with the same kind of canvas
// - a real one: @napi-rs/canvas (Skia), with the fixture fonts in ./fonts
// registered under the family names the app's own font list uses.
//
// Deliberately imports nothing from the app. A module a setup file imports is
// loaded before the test file's `vi.mock` calls exist and cannot be mocked
// afterwards, and the balloon tests in this lane mock `page-pixels.js`.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

// Family name as the app writes it in CSS (see BUILTIN_FONTS in data.js), and
// the files that make it up. Only the faces listed here exist: a bold or italic
// request for a family without that face is synthesised by Skia (same advances,
// emboldened or slanted outlines), so tests that care about advances use
// `bold: false`. See README.md beside the fonts.
const REAL_FONTS = {
  'Comic Neue': ['ComicNeue-Regular.ttf'],
  Bangers: ['Bangers-Regular.ttf'],
  'DejaVu Sans': ['DejaVuSans.ttf', 'DejaVuSans-Oblique.ttf'],
};

for (const [family, files] of Object.entries(REAL_FONTS)) {
  if (GlobalFonts.has(family)) continue; // same worker, second test file
  for (const file of files) {
    const path = fileURLToPath(new URL(`./fonts/${file}`, import.meta.url));
    if (!GlobalFonts.registerFromPath(path, family)) {
      throw new Error(`realfont setup: could not register ${path} as '${family}'`);
    }
  }
}

// The smallest `document` that serves: canvases, and a loud failure for any
// other element. The one other element the layout code asks for is the hidden
// <div> `wrapLinesDOM` wraps text in when the typesetting beta is off, and that
// needs a real browser's line layout - a quiet stand-in here would test
// something the app never does. Tests in this lane turn the beta on.
globalThis.document = {
  createElement(tag) {
    if (String(tag).toLowerCase() === 'canvas') return createCanvas(300, 150);
    throw new Error(
      `realfont lane: document.createElement('${tag}') needs a browser DOM. ` +
        'Only <canvas> exists here; call setTypesetEnabled(true) so layoutLines uses the shaped breaker.',
    );
  },
};
