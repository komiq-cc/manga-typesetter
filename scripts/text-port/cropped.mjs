#!/usr/bin/env node
// For every case whose picture differs between two capture runs: is the old
// picture the new one, cropped?
//
//   node scripts/text-port/cropped.mjs <oldRunDir> <newRunDir>
//
// A change that only makes a box's canvas larger - a footprint grown to hold
// ink that was cut - must leave every pixel the old canvas had as it was and
// add pixels only outside it. This says so case by case: how far the canvas
// grew on each side (device px), how many pixels inside the old canvas are
// not the same (0 for a crop), and how much ink is new. It reads the two
// runs' `pixels.jsonl` and PNGs and writes nothing. A chapter's name is left
// out of what it prints. Exit 1 if any differing case is not a crop.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';

const [oldDir, newDir] = process.argv.slice(2);
const records = (dir) => new Map(readFileSync(join(dir, 'pixels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
const A = records(oldDir);
const B = records(newDir);
const px = async (dir, rec) => {
  const img = await loadImage(readFileSync(join(dir, rec.png)));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
};
let differing = 0;
let ok = 0;
const kinds = {};
for (const [id, a] of A) {
  const b = B.get(id);
  if (!b) { console.log('MISSING in new', id); continue; }
  const sameRec = JSON.stringify(a) === JSON.stringify(b);
  const bufA = readFileSync(join(oldDir, a.png));
  const bufB = readFileSync(join(newDir, b.png));
  if (sameRec && bufA.equals(bufB)) continue;
  differing++;
  const pa = await px(oldDir, a);
  const pb = await px(newDir, b);
  const ss = a.ss;
  const dx = Math.round((b.ox - a.ox) * ss);
  const dy = Math.round((b.oy - a.oy) * ss);
  let unlike = 0, worst = 0, outsideInk = 0, outsideAlpha = 0, insideAlphaA = 0, insideAlphaB = 0;
  for (let y = 0; y < pb.height; y++) {
    for (let x = 0; x < pb.width; x++) {
      const j = (y * pb.width + x) * 4;
      const ax = x - dx, ay = y - dy;
      if (ax < 0 || ay < 0 || ax >= pa.width || ay >= pa.height) {
        if (pb.data[j + 3]) { outsideInk++; outsideAlpha += pb.data[j + 3]; }
        continue;
      }
      const i = (ay * pa.width + ax) * 4;
      insideAlphaA += pa.data[i + 3];
      insideAlphaB += pb.data[j + 3];
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(pa.data[i + k] - pb.data[j + k]));
      if (d) { unlike++; if (d > worst) worst = d; }
    }
  }
  const grewOnly = dx >= 0 && dy >= 0 && pb.width - dx >= pa.width && pb.height - dy >= pa.height;
  const good = grewOnly && unlike === 0 && a.ss === b.ss;
  if (good) ok++;
  const sides = [dx > 0 ? 'left' : '', dy > 0 ? 'top' : '', pb.width - dx > pa.width ? 'right' : '', pb.height - dy > pa.height ? 'bottom' : ''].filter(Boolean).join('+');
  kinds[sides] = (kinds[sides] ?? 0) + 1;
  console.log(
    `${good ? 'CROP-OK ' : 'DEFECT  '} ${id.replace(/^c\.[^.]+__/, 'c.<chapter>__')}: canvas ${pa.width}x${pa.height} -> ${pb.width}x${pb.height}, grew ${sides} (left ${dx}, top ${dy}, right ${pb.width - dx - pa.width}, bottom ${pb.height - dy - pa.height} device px at ss ${ss});` +
    ` pixels unlike inside the old canvas: ${unlike}${unlike ? ` (worst ${worst})` : ''}; inked pixels outside it: ${outsideInk};` +
    ` ink (alpha sum) ${a.alphaSum} -> ${b.alphaSum} (+${(((b.alphaSum - a.alphaSum) / a.alphaSum) * 100).toFixed(3)}%)`,
  );
}
console.log(`cases: ${A.size}; differing: ${differing}; old-is-new-cropped: ${ok}; by side: ${JSON.stringify(kinds)}`);
process.exit(ok === differing ? 0 : 1);
