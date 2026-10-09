// A 2D canvas for the `dom` lane, where jsdom has none: `getContext('2d')`
// answers null there, and a component that paints would throw on its first
// frame. This one draws nothing and remembers nothing but sizes; a test that
// cares what was painted stands in for the painter instead (`vi.mock`) and
// reads what it was asked. What it does keep honest is the thing the
// components' memory rules are about: `width` and `height` are real, so
// "handed its pixels back" can be read off the element.
//
// Installed on the prototype and taken off again, so a file that does not ask
// for it sees jsdom as it is.
const noop = () => {};
const image = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) });

function context(canvas) {
  const own = {
    canvas,
    getImageData: (x, y, w, h) => image(w, h),
    createImageData: (w, h) => image(w, h),
    measureText: (text) => ({ width: String(text).length * 10, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({ setTransform: noop }),
  };
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => ((t[k] = v), true),
  });
}

export function installFakeCanvas() {
  const proto = globalThis.HTMLCanvasElement.prototype;
  const before = { getContext: proto.getContext, toDataURL: proto.toDataURL, toBlob: proto.toBlob, revoke: URL.revokeObjectURL };
  const made = new WeakMap();
  proto.getContext = function (kind) {
    if (kind !== '2d') return null;
    if (!made.has(this)) made.set(this, context(this));
    return made.get(this);
  };
  proto.toDataURL = () => 'data:,';
  // No `toBlob`, so a component that encodes takes the path it keeps for a
  // host without one and its result is there on the next line, not a task
  // later; and a URL it then hands back is handed to something.
  proto.toBlob = undefined;
  URL.revokeObjectURL ??= noop;
  return () => {
    proto.getContext = before.getContext;
    proto.toDataURL = before.toDataURL;
    proto.toBlob = before.toBlob;
    URL.revokeObjectURL = before.revoke;
  };
}
