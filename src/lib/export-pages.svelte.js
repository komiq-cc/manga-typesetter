import { withPageImages } from './page-images.js';

// Export text/geometry belongs to one moment. Image residency still belongs
// to the editor: minting or releasing a URL must update the live page.
const sources = new WeakMap();
const columns = new WeakMap();

export function snapshotExportPages(pages, longstrip = false) {
  const copies = pages.map((p) => {
    if (sources.has(p)) return p;
    const copy = {
      ...p,
      lines: $state.snapshot(p.lines),
      boxes: $state.snapshot(p.boxes),
      detect: $state.snapshot(p.detect),
    };
    sources.set(copy, p);
    return copy;
  });
  // Font settling can refit these boxes. Its strip bounds must come from the
  // same column, even when the editor changes the live layout or neighbours.
  for (const p of copies) if (!columns.has(p)) columns.set(p, longstrip ? copies : null);
  return copies;
}

// Undefined is a live page; null is an export of a paged document.
export const exportPageColumn = (p) => columns.get(p);

export function withExportPageImages(p, fn) {
  const source = sources.get(p);
  return withPageImages(source ?? p, () => {
    // A copied resident URL may have been evicted since the export started.
    // Only image handles come back from the live page, never text/geometry.
    if (source) {
      p.raw = source.raw;
      p.cleaned = source.cleaned;
    }
    return fn();
  });
}

export function setExportPageSize(p, w, h) {
  p.w = w;
  p.h = h;
  const source = sources.get(p);
  // Preserve the editor's lazy measurement without replacing a size it has
  // already resolved while the export was awaiting the image.
  if (source && !(source.w > 0 && source.h > 0)) {
    source.w = w;
    source.h = h;
  }
}
