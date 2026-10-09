// Direct font and per-line ink measurements. No placement, positioned ink,
// blockY, baseline from a layout, or box geometry is an input here.
import { readFileSync } from 'node:fs';
import { guardedPath, sha256 } from './common.mjs';

export const metricKey = (style, text) => JSON.stringify([style.font, !!style.bold, !!style.italic, style.size, Number(style.letterSpacing) || 0, String(text)]);

export function readReferenceMetrics(data, path) {
  const source = JSON.parse(readFileSync(path, 'utf8'));
  if (source.schema !== 1 || source.engine !== 'system-webkit' || source.complete !== true || source.errors?.length) throw new Error('direct WebKit metrics are missing, incomplete or failed');
  for (const [file, digest] of Object.entries(source.sources ?? {})) {
    if (sha256(readFileSync(guardedPath(data, file))) !== digest) throw new Error(`direct WebKit metrics are stale: ${file}`);
  }
  if (!source.sources?.['fonts/fonts.json'] || !source.sources?.['corpus/layout.json'] || !source.sources?.['runs/ref-wk/base/layout.jsonl']) throw new Error('direct WebKit metrics have no source provenance');
  return new Map(source.records.map((r) => [r.key, r.metrics]));
}

export function directBlock(style, lines, measure) {
  if (!Array.isArray(lines) || !lines.length || !(style.size > 0)) return null;
  const records = lines.map((text) => measure(style, text));
  if (records.some((r, i) => !r?.font || (/\S/.test(lines[i]) && !r.ink))) return null;
  const font = records[0].font;
  if (records.some((r) => r.font.ascent !== font.ascent || r.font.descent !== font.descent)) return null;
  const values = [font.ascent, font.descent, ...records.flatMap((r, i) => /\S/.test(lines[i]) ? [r.ink.ascent, r.ink.descent] : [])];
  if (!values.every(Number.isFinite) || values.some((v) => v < 0)) return null;
  return { font, inks: records.map((r, i) => /\S/.test(lines[i]) ? r.ink : null), lineH: style.size * (style.lineHeight > 0 ? style.lineHeight : 1) };
}

// Decompose the centring rule into the line-box baseline and ink around it.
// With equal lines and line heights, a font-box change is rule3 and a change
// of glyph ink around the baseline is rule4. Neither reads the actual shift.
export function predictMiddle(wk, rust) {
  if (!wk || !rust || wk.inks.length !== rust.inks.length || Math.abs(wk.lineH - rust.lineH) > 1e-9) return null;
  const bounds = (m) => ({
    top: Math.min(...m.inks.flatMap((k, i) => k ? [i * m.lineH - k.ascent] : [])),
    bottom: Math.max(...m.inks.flatMap((k, i) => k ? [i * m.lineH + k.descent] : [])),
    baseline: (m.lineH + m.font.ascent - m.font.descent) / 2,
  });
  const a = bounds(wk);
  const b = bounds(rust);
  if (![a.top, a.bottom, a.baseline, b.top, b.bottom, b.baseline].every(Number.isFinite)) return null;
  const top = b.top - a.top;
  const bottom = b.bottom - a.bottom;
  const lineDy = a.baseline - b.baseline;
  const inkDy = -(top + bottom) / 2 || 0;
  return { top, bottom, lineDy, inkDy, predictedDy: lineDy + inkDy };
}
