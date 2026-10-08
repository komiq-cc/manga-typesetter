// The detached measuring canvas is made only when measure.js first loads.
export function createBrowserTextEngine() {
  const _c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const _ctx = _c ? _c.getContext('2d') : null;
  if (!_ctx) return null;
  const _fontSet = document.fonts;
  const ink = (m) => ({
    width: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
  });
  return {
    id: 'browser',
    advance(face, text) {
      _ctx.font = face.key;
      return _ctx.measureText(text).width;
    },
    fontBox(face) {
      _ctx.font = face.key;
      const m = _ctx.measureText('Hg');
      return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    },
    lineInk(face, text) {
      _ctx.font = face.key;
      _ctx.textAlign = 'left';
      _ctx.textBaseline = 'alphabetic';
      return ink(_ctx.measureText(text));
    },
    glyphInk(face, text) {
      _ctx.font = face.key;
      _ctx.textAlign = 'center';
      _ctx.textBaseline = 'middle';
      const m = _ctx.measureText(text);
      // The shared context is put back because fontBox reads the current baseline.
      _ctx.textAlign = 'left';
      _ctx.textBaseline = 'alphabetic';
      return ink(m);
    },
    // A removed document used to hand wrapping back to the greedy breaker too.
    get wrapPlain() {
      return browserPlainBreaker();
    },
    loading() {
      return _fontSet?.status === 'loading';
    },
    onFontsChange(cb) {
      if (typeof _fontSet?.addEventListener !== 'function') return;
      for (const ev of ['loading', 'loadingdone', 'loadingerror']) _fontSet.addEventListener(ev, cb);
      return () => {
        for (const ev of ['loading', 'loadingdone', 'loadingerror']) _fontSet.removeEventListener?.(ev, cb);
      };
    },
    faceReady: browserFaceReady,
  };
}

// Read the browser's own line breaks, including its rules for long words.
function wrapPlain(face, text, opts) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre-wrap;' +
    'word-break:break-word;overflow-wrap:break-word;box-sizing:content-box;padding:0;margin:0;border:0;' +
    `width:${Math.max(1, opts.width)}px;` +
    `font-family:${face.css};font-weight:${face.bold ? 700 : 400};` +
    `font-style:${face.italic ? 'italic' : 'normal'};font-size:${face.size}px;` +
    `line-height:${opts.lineHeight};letter-spacing:${opts.letterSpacing}px;text-transform:none;text-align:${opts.align};`;
  document.body.appendChild(el);
  const out = [];
  try {
    for (const para of text.split('\n')) {
      if (para === '') {
        out.push('');
        continue;
      }
      el.textContent = para;
      const node = el.firstChild;
      const range = document.createRange();
      let curTop = null;
      let start = 0;
      for (let i = 0; i < para.length;) {
        const cp = para.codePointAt(i);
        const charLen = cp > 0xffff ? 2 : 1;
        range.setStart(node, i);
        range.setEnd(node, i + charLen);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) {
          i += charLen;
          continue;
        }
        const top = Math.round(rect.top);
        if (curTop === null) curTop = top;
        else if (Math.abs(top - curTop) > 1) {
          const raw = para.slice(start, i).replace(/\s+$/, '');
          out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
          start = i;
          curTop = top;
        }
        i += charLen;
      }
      const raw = para.slice(start).replace(/\s+$/, '');
      out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
    }
  } finally {
    el.remove();
  }
  return out.length ? out : [''];
}

// Readiness used to ask the live font set even when there was no measuring
// canvas at import time. Keep that answer for a browser installed later too.
export function browserFaceReady(face) {
  const set = typeof document === 'undefined' ? null : document.fonts;
  if (typeof set?.check !== 'function') return true;
  try {
    if (set.check(face.key)) return true;
    set.load?.(face.key)?.catch?.(() => {});
    return false;
  } catch {
    return true;
  }
}

// Plain wrapping always consulted the live DOM, independently of the detached
// canvas. Some callers install one after measurement has already been imported.
export function browserPlainBreaker() {
  return typeof document === 'undefined' ? undefined : wrapPlain;
}
