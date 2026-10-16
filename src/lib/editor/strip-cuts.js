// ===== Where a longstrip chapter is cut into files =====
//
// The pages a webtoon arrives as are not the pages it ships as. The source
// slices are whatever the raw came cut into; the delivered slices are whatever
// the target site wants (a few thousand pixels of height each), and the two have
// nothing to do with one another. So the exporter re-cuts the column - and the
// only thing it must never do is cut through lettering. A seam through art is
// invisible; a seam through a speech balloon's text is the one defect a reader
// cannot un-see, and it cannot be fixed downstream.
//
// This file is that decision and nothing else: no canvas, no store, no images.
// It takes the geometry of the chapter and returns the y positions to cut at, in
// strip pixels, which is the space `stripOffsets(pages)` answers in at zoom 1 -
// the same space the stitched export canvas works in.

import { stripOffsets, boxPaintedStripSpan, meshReach, turnedSpan } from './strip.js';

// How much clear space a cut must leave above and below any lettering. A cut
// that grazes a box's edge is as bad as one through it: the glyph outlines,
// shadows and roughening all overflow the box rect (see `layoutBox` in
// exporter.js), and this module cannot measure text - it has no fonts and no
// DOM. The pad is the allowance for that overflow as much as it is breathing
// room, which is why it is generous rather than tight.
export const CUT_PAD = 48;

// A slice may run short of the target - the cut moved up to clear a box - but
// not to nothing, and it may run long, but not so long the site rejects it.
// Both are expressed against the target rather than in pixels so they scale with
// whatever the user asked for.
export const MIN_SLICE_RATIO = 0.25;
export const MAX_SLICE_RATIO = 2;

// What the export dialog offers as a slice height, in strip (page) pixels. The
// default is what the big webtoon sites settle around; the floor and ceiling are
// there because a number typed into a box is a number, and a 20px or 2,000,000px
// target is a chapter of confetti or one file no reader can load.
export const SLICE_H_DEFAULT = 8000;
export const SLICE_H_MIN = 1000;
export const SLICE_H_MAX = 20000;

// The vertical extent a box actually occupies on its page, which is not `box.y`
// and `box.y + box.h` the moment the box is rotated. Rotation is stored as
// `style.rotation` in degrees and the editor (and `paintBoxOnPage`) pivots
// around the box CENTRE, so the axis-aligned bound of the rotated rect is the
// projection of both of its axes onto the vertical: |sin|·w + |cos|·h. A box
// turned 90° is as tall as it is wide, and a cut planned off `box.h` would run
// straight through it.
//
// Flips are ignored on purpose: mirroring a rect around its own centre leaves
// its bounds exactly where they were.
export function boxSpanY(box) {
  const y = box?.y ?? 0;
  const w = Math.max(0, box?.w ?? 0);
  const h = Math.max(0, box?.h ?? 0);
  const rot = box?.style?.rotation || 0;
  if (!rot) return { top: y, bottom: y + h };
  const a = (rot * Math.PI) / 180;
  const half = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
  const cy = y + h / 2;
  return { top: cy - half, bottom: cy + half };
}

// The stretch of the strip a box keeps a cut out of, in its own page's
// coordinates: its frame and the pad around it (`boxSpanY`), and past that
// anything it paints further. The pad is an allowance for paint over the
// frame's edge, and a box can paint further than any allowance: a mesh carries
// the whole picture off its frame - a box at 7800 bent 100 px down painted
// across a cut planned clear at 8000 - and so can a long shadow, a smear, or
// glyphs the check measured outside the box. So the band also holds what the
// box paints as the slices pick their boxes by it (`boxPaintedStripSpan`: the
// style's reach and the overflow the check measured), and the frame carried
// through the mesh (`warpExtent`) with the pad around that. A box whose paint
// is inside its pad keeps the band it always had.
export function boxCutSpan(box, pad = CUT_PAD) {
  const frame = boxSpanY(box);
  const painted = boxPaintedStripSpan(box);
  let top = Math.min(frame.top - pad, painted.top);
  let bottom = Math.max(frame.bottom + pad, painted.bottom);
  const bent = meshSpanY(box);
  if (bent) {
    top = Math.min(top, bent.top - pad);
    bottom = Math.max(bottom, bent.bottom + pad);
  }
  return { top, bottom };
}

// A warped box's frame as the mesh leaves it, mirrored and turned about the
// box's centre as the picture is (`meshReach`), as a vertical span on its
// page. Null for a box with no mesh that moves anything.
function meshSpanY(box) {
  const m = meshReach(box);
  return m ? turnedSpan(box, m) : null;
}

// Every stretch of the strip a cut may not land in, in strip coordinates, sorted
// and merged so that no two of them touch or overlap.
//
// Merging is what makes the walk below finite: against disjoint bands, stepping
// past a band's bottom edge lands in clear space by construction, so a cut needs
// at most one move rather than a loop of them. Two balloons a few pixels apart
// are one band here, and correctly so - the gap between them is not somewhere a
// cut can go.
export function forbiddenBands(pages, pad = CUT_PAD) {
  const { tops } = stripOffsets(pages);
  const raw = [];
  (pages ?? []).forEach((p, i) => {
    for (const box of p?.boxes ?? []) {
      const { top, bottom } = boxCutSpan(box, pad);
      raw.push({ top: tops[i] + top, bottom: tops[i] + bottom });
    }
  });
  raw.sort((a, b) => a.top - b.top);
  const merged = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (last && b.top <= last.bottom) last.bottom = Math.max(last.bottom, b.bottom);
    else merged.push({ top: b.top, bottom: b.bottom });
  }
  return merged;
}

// The band a y falls strictly inside. Strictly, because a cut sitting exactly on
// a band edge is already the answer "clear by exactly one pad" and needs no
// move - moving it would be a move to where it already is.
function bandAt(bands, y) {
  for (const b of bands) {
    if (y <= b.top) return null; // sorted: nothing further down can contain y
    if (y < b.bottom) return b;
  }
  return null;
}

// Plan the whole chapter's cuts.
//
// Returns `{ cuts, warnings }` where `cuts` is the boundaries of the output
// files - `[0, y1, y2, …, total]`, so slice n is `cuts[n]..cuts[n+1]` and there
// is one fewer file than there are numbers. A chapter with no height at all
// returns no cuts rather than a zero-height slice.
//
// The walk: from the previous cut, the ideal next one is `targetHeight` below
// it. If that lands in clear space it is taken as-is. If it lands in a band the
// cut MOVES, and which way it moves is the whole policy:
//
//   · UP to the band's top, by preference. Up shortens the current slice and
//     lengthens the next, which is the harmless direction - the reader sees the
//     same column either way and no file grows.
//   · DOWN past the band's bottom when up would leave a runt: a cut less than
//     MIN_SLICE_RATIO of the target below the previous one is a sliver of a
//     file, and a site that pages by image would show it as a flash.
//   · Neither, when the bands are dense enough that up is a runt and down is
//     past MAX_SLICE_RATIO of the target. Then the cut goes to whichever band
//     edge is nearer the ideal - the least-bad file size, still not through
//     lettering.
//   · Through the lettering, only when the band is taller than the widest slice
//     allowed AND its top is already at or above the previous cut - i.e. the
//     previous cut is itself that band's top and there is nowhere left to
//     retreat to. One 3000px box against a 1000px target does that, and so does
//     a run of boxes packed close enough to fuse into 3000px of band: either way
//     there is no clear pixel to cut at, so the ideal position is taken and the
//     caller is told, by name, that this one file has a seam through its text.
export function planStripCuts(pages, targetHeight, pad = CUT_PAD) {
  const { total } = stripOffsets(pages);
  const warnings = [];
  if (!(total > 0)) return { cuts: [], warnings };
  // A nonsense target is one file, not an infinite loop of them.
  if (!(targetHeight > 0) || !isFinite(targetHeight)) {
    return { cuts: [0, Math.round(total)], warnings };
  }

  const bands = forbiddenBands(pages, pad);
  const minSlice = targetHeight * MIN_SLICE_RATIO;
  const maxSlice = targetHeight * MAX_SLICE_RATIO;
  const cuts = [0];
  let prev = 0;

  // Whole pixels, always. Two consecutive slices are drawn from the same page
  // at `tops[i] - y0`, and a fractional y0 would resample the art differently on
  // each side of the seam - the one place in this app where a half-pixel is
  // visible as a line across the page. The `prev + 1` floor is not cosmetic: it
  // is what guarantees the walk terminates when a rounded cut would otherwise
  // land back on the one before it.
  const push = (y) => {
    const v = Math.max(Math.round(y), prev + 1);
    cuts.push(v);
    prev = v;
  };

  // `total` is a hard stop rather than a candidate: a strip is finite and the
  // tail is whatever is left, however short.
  const end = Math.round(total);
  while (prev < total) {
    const ideal = prev + targetHeight;
    if (ideal >= total) {
      if (end > prev) cuts.push(end);
      prev = end;
      break;
    }
    const band = bandAt(bands, ideal);
    if (!band) {
      push(ideal);
      continue;
    }
    const up = band.top;
    const down = band.bottom;
    const upOk = up >= prev + minSlice;
    const downOk = down <= prev + maxSlice;
    if (upOk) push(up);
    else if (downOk) push(down);
    else if (up > prev) {
      // Dense: both directions are out of bounds, so take the smaller lie.
      push(ideal - up <= down - ideal ? up : down);
    } else {
      // The band already started at or above the previous cut and does not end
      // within a legal slice - the lettering here is taller than any file may
      // be. Nothing clears it.
      warnings.push({ y: Math.round(ideal), reason: 'lettering-taller-than-slice' });
      push(ideal);
    }
    // A band running off the end of the strip can push a cut past it; the tail
    // is the end of the chapter and there is nothing below it to slice.
    if (prev >= end) {
      cuts[cuts.length - 1] = end;
      // …and if that collapses the tail onto the cut above it, there is no file
      // between them to write.
      if (cuts.length > 1 && cuts[cuts.length - 2] >= end) cuts.pop();
      prev = end;
      break;
    }
  }
  return { cuts, warnings };
}
