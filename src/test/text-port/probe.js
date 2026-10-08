// Hosts supply the app's public exports and encode the returned pixels. This
// generator holds only one canvas at a time and does no host I/O.
export function pixelStats(image) {
  const { width, height, data } = image;
  let l = width, t = height, r = 0, b = 0, alphaSum = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = data[(y * width + x) * 4 + 3];
    alphaSum += alpha;
    if (alpha) {
      l = Math.min(l, x);
      t = Math.min(t, y);
      r = Math.max(r, x + 1);
      b = Math.max(b, y + 1);
    }
  }
  return { bbox: alphaSum ? [l, t, r, b] : null, alphaSum };
}
// `plain` says whether the installed measuring engine can break plain text
// here. A host without a DOM and without an engine breaker passes false (or
// the older `browser: false`), and those cases are written as skips.
export function* probe(app, kind, cases, { families, browser = true, plain = browser } = {}) {
  const known = new Set(families);
  for (const c of cases) {
    try {
      const family = c.font ?? c.box?.style.font ?? c.solve?.style.font;
      if (!known.has(family) || !app.fontByName(family)) throw new Error(`Font '${family}' is not registered in fonts.json and the store`);
      const style = c.box?.style ?? c.solve?.style;
      if (!plain && (c.mode === 'plain' || (kind !== 'metrics' && style?.shape === 'off'))) {
        const why = c.mode === 'plain' ? 'plain mode' : "shape: 'off'";
        yield { record: { id: c.id, skip: `${why} needs a browser DOM line breaker; node has only canvas` } };
        continue;
      }
      if (kind === 'metrics') {
        const s = { ...(c.style ?? c), font: c.font, bold: c.bold, italic: c.italic, size: c.size, letterSpacing: 0 };
        const text = c.text;
        yield { record: {
          id: c.id, adv: app.lineWidth(text, s, c.size), chars: app.charWidths(text, s, c.size),
          font: app.fontMetrics(s, c.size), ink: app.lineInk(text, s, c.size),
          glyphs: Object.fromEntries([...new Set([...text])].slice(0, 24).map((ch) => [ch, app.glyphInk(ch, s, c.size)])),
        } };
        continue;
      }
      app.setTypesetEnabled(c.mode === 'smart');
      if (kind === 'layout') {
        if (c.solve) {
          const answer = app.solveLayout(c.solve);
          if (!answer) throw new Error('solveLayout returned no answer');
          // The current solver calls this `reasons` (plural). Preserve the
          // returned array under the contract's singular `reason` field.
          const { size, x, y, w, h, lines, status } = answer;
          yield { record: { id: c.id, solve: { size, x, y, w, h, lines, status, reason: answer.reason ?? answer.reasons } } };
        } else {
          const cand = app.boxCandidate(c.box, c.box.text);
          const place = app.placeBlock(cand);
          if (!place) throw new Error('placeBlock returned no placement');
          const ink = app.boxInkRect(cand, place);
          yield { record: {
            id: c.id, lines: place.lines ?? null, lineX: place.lineX ?? null,
            blockY: place.blockY ?? null, blockH: place.blockH ?? null,
            baseY: place.baseY ?? null, lineH: place.lineH ?? null,
            curve: place.isCurve ? place.layout : null,
            ink: ink ? { l: ink.x, t: ink.y, r: ink.x + ink.w, b: ink.y + ink.h } : null,
            verdict: app.containBox(cand, place),
          } };
        }
        continue;
      }
      if (kind !== 'pixels') throw new Error(`Unknown corpus '${kind}'`);
      if (c.via === 'layer') {
        const layer = app.renderBoxLayer(c.box, c.page.w, c.page.h, undefined, c.page);
        if (!layer) {
          yield { record: { id: c.id, skip: 'renderBoxLayer returned null: box paints no pixels' } };
          continue;
        }
        const imageData = layer.imageData;
        yield { record: { id: c.id, png: `png/${c.id}.png`, left: layer.left, top: layer.top, cw: imageData.width, ch: imageData.height, ss: 1, ...pixelStats(imageData) }, imageData };
      } else {
        const { canvas, ox, oy, cw, ch, ss } = app.renderBoxTexture(c.box, c.page);
        const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        yield { record: { id: c.id, png: `png/${c.id}.png`, ox, oy, cw, ch, ss, ...pixelStats(image) }, canvas };
      }
    } catch (error) {
      yield { record: { id: c.id, error: error.message ?? String(error) } };
    }
  }
}
