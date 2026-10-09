#!/usr/bin/env node
// Are two captures of ONE engine the same pictures? PNG bytes cannot say: each
// host has its own encoder. This decodes both and compares pixel for pixel.
//
//   node scripts/text-port/same-pixels.mjs <runA> <runB> [--data <dir>]
//   e.g. new/r4 new/r4-wk
//
// A picture whose style asks the host's canvas for something (a shadow, a
// blur, a motion blur, a pattern tile, a clip mask, or the PSD layer path,
// which downscales with the host's blit) may differ between hosts and is only
// counted. Every other picture is the engine's own pixels and must be equal:
// the exit code is 1 when one is not.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const at = args.indexOf('--data');
const data = resolve(at >= 0 ? args.splice(at, 2)[1] : (process.env.TP_DATA ?? 'tp-data'));
const [A, B] = args;
if (!A || !B) {
  console.error('usage: same-pixels.mjs <runA> <runB> [--data <dir>]');
  process.exit(2);
}
const corpus = JSON.parse(readFileSync(resolve(data, 'corpus/pixels.json'), 'utf8'));
const cases = new Map((Array.isArray(corpus) ? corpus : (corpus.cases ?? Object.values(corpus))).map((c) => [c.id, c]));

// What a case asks of the host's canvas, or '' when it asks nothing.
export function hostSteps(c) {
  const s = c?.box?.style ?? {};
  const steps = [];
  if (s.shadows?.length) steps.push('shadow');
  if (s.blur) steps.push('blur');
  if (s.motionBlur?.on) steps.push('motion blur');
  if (s.pattern?.on) steps.push('pattern');
  if (s.clip?.on) steps.push('clip');
  if (c?.via === 'layer') steps.push('layer');
  return steps.join(', ');
}
async function pixels(run, file) {
  const image = await loadImage(readFileSync(resolve(data, 'runs', run, 'png', file)));
  const canvas = createCanvas(image.width, image.height);
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  return { w: image.width, h: image.height, d: g.getImageData(0, 0, image.width, image.height).data };
}
const tally = { own: 0, ownEqual: 0, host: 0, hostEqual: 0 };
const unequal = [];
const byStep = {};
for (const file of readdirSync(resolve(data, 'runs', A, 'png')).sort()) {
  const id = file.replace(/\.png$/, '');
  const steps = hostSteps(cases.get(id));
  const a = await pixels(A, file);
  const b = await pixels(B, file);
  let max = 0;
  let count = 0;
  const sized = a.w === b.w && a.h === b.h;
  if (sized) {
    for (let i = 0; i < a.d.length; i++) {
      const d = Math.abs(a.d[i] - b.d[i]);
      if (d) {
        count++;
        if (d > max) max = d;
      }
    }
  }
  const equal = sized && count === 0;
  if (steps) {
    tally.host++;
    if (equal) tally.hostEqual++;
    const row = (byStep[steps] ??= { n: 0, equal: 0, max: 0, otherSize: 0 });
    row.n++;
    if (equal) row.equal++;
    if (!sized) row.otherSize++;
    row.max = Math.max(row.max, max);
  } else {
    tally.own++;
    if (equal) tally.ownEqual++;
    else unequal.push(`${id}: ${sized ? `${count} channels, largest ${max}` : `${a.w}x${a.h} against ${b.w}x${b.h}`}`);
  }
}
console.log(`${A} against ${B}`);
console.log(`the engine's own pixels: ${tally.ownEqual} of ${tally.own} pictures equal`);
console.log(`with a host-canvas step: ${tally.hostEqual} of ${tally.host} equal`);
for (const [steps, row] of Object.entries(byStep).sort()) {
  console.log(`  ${steps}: ${row.equal} of ${row.n} equal, largest difference ${row.max}${row.otherSize ? `, ${row.otherSize} of another size` : ''}`);
}
for (const line of unequal.slice(0, 40)) console.log(`NOT EQUAL ${line}`);
process.exit(unequal.length ? 1 : 0);
