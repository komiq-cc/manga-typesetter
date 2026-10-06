// ===== Colour conversions for the colour picker =====
//
// Pure helpers over the three spaces the picker shows:
//   - HSB/HSV: H in [0, 360), S in [0, 100], B in [0, 100]
//   - RGB: R, G, B in [0, 255]
//   - HEX: lowercase #rrggbb, the form every colour in a box style is stored in
//     (3-digit #rgb is accepted as input and expanded).

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} b
 * @returns {{ r: number, g: number, b: number }}
 */
export function hsbToRgb(h, s, b) {
  const normH = ((h % 360) + 360) % 360;
  const normS = clamp(s, 0, 100) / 100;
  const normB = clamp(b, 0, 100) / 100;

  const c = normB * normS;
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normB - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (normH < 60) [r1, g1, b1] = [c, x, 0];
  else if (normH < 120) [r1, g1, b1] = [x, c, 0];
  else if (normH < 180) [r1, g1, b1] = [0, c, x];
  else if (normH < 240) [r1, g1, b1] = [0, x, c];
  else if (normH < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{ h: number, s: number, b: number }}
 */
export function rgbToHsb(r, g, b) {
  const normR = clamp(r, 0, 255) / 255;
  const normG = clamp(g, 0, 255) / 255;
  const normB = clamp(b, 0, 255) / 255;

  const max = Math.max(normR, normG, normB);
  const min = Math.min(normR, normG, normB);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === normR) h = 60 * (((normG - normB) / delta) % 6);
    else if (max === normG) h = 60 * ((normB - normR) / delta + 2);
    else h = 60 * ((normR - normG) / delta + 4);
  }
  h = Math.round(((h % 360) + 360) % 360);
  if (h === 360) h = 0;

  return {
    h,
    s: max === 0 ? 0 : Math.round((delta / max) * 100),
    b: Math.round(max * 100),
  };
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string} lowercase #rrggbb
 */
export function rgbToHex(r, g, b) {
  const byte = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * @param {string} hex 3 or 6 hex digits, with or without the #
 * @returns {{ r: number, g: number, b: number } | null}
 */
export function hexToRgb(hex) {
  const committed = hexOnCommit(hex);
  if (!committed) return null;
  return {
    r: parseInt(committed.slice(1, 3), 16),
    g: parseInt(committed.slice(3, 5), 16),
    b: parseInt(committed.slice(5, 7), 16),
  };
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} b
 */
export function hsbToHex(h, s, b) {
  const rgb = hsbToRgb(h, s, b);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * The hex field while it is being typed in: only a full 6-digit value counts,
 * so "#12" on its way to "#123456" does not flash the swatch to #112222.
 * @param {string} text
 * @returns {string | null} lowercase #rrggbb
 */
export function hexOnInput(text) {
  const raw = String(text ?? '').trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toLowerCase()}` : null;
}

/**
 * The hex field on blur or Enter, where the 3-digit shorthand is accepted too.
 * @param {string} text
 * @returns {string | null} lowercase #rrggbb
 */
export function hexOnCommit(text) {
  const raw = String(text ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(raw)) return `#${[...raw].map((d) => d + d).join('').toLowerCase()}`;
  return null;
}

/**
 * Whether the text in a hex field cannot become a colour. Empty is not
 * invalid: it is a field somebody is about to type into.
 * @param {string} text
 */
export function hexInvalid(text) {
  const raw = String(text ?? '').trim();
  return raw !== '' && hexOnCommit(raw) === null;
}
