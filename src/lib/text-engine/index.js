import { createBrowserGlyphPainter } from './browser-painter.js';

// Engines are plain objects, and every method is synchronous:
//   id: string
//   advance(face, text): number, one shaped run without letter spacing
//   fontBox(face): { ascent, descent }, unvalidated font metrics
//   lineInk(face, text): { width, left, right, ascent, descent }, left/alphabetic
//   glyphInk(face, text): the same metrics, anchored centre/middle
//   wrapPlain(face, text, { width, lineHeight, letterSpacing, align }): string[]
//     Optional: without it, use the live browser DOM or the greedy breaker.
//   loading(): boolean, fallback measurements must not be kept while true
//   onFontsChange(cb): called when usable faces change; may return an unsubscribe
//   faceReady(face): boolean, may start loading the face
// A face is { key, name, bold, italic, size, css }. The key stays the CSS font
// shorthand so swapping the implementation does not change the memo's identity.
// Ink left/right are the engine's bounding-box distances from the anchor;
// measure.js applies the left sign, spacing and alignment as it always has.
let engine = null;
const listeners = new Set();
export function textEngine() {
  return engine;
}
export function setTextEngine(e) {
  engine = e;
  for (const cb of listeners) cb(e);
}
export function onTextEngineChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Painting needs only the context it is handed, even where measurement has no
// engine. Jobs carry plain data; the painter owns the platform's paint objects.
// A painter is `{ paint(ctx, job) }`, and may say `maxSide`: the longest side,
// in device pixels, of what it will paint for one job. One that says nothing
// has no such limit (a canvas draws text of any extent); the Rust engine's
// does (rust-painter.js), and a canvas sized for it must be within it.
let painter = createBrowserGlyphPainter();
export function glyphPainter() {
  return painter;
}
export function setGlyphPainter(p) {
  painter = p;
}
