import { distanceTransform } from './distance.js';

export function alphaBbox(alpha, width, height) {
  let l = width;
  let t = height;
  let r = 0;
  let b = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!alpha[y * width + x]) continue;
    l = Math.min(l, x);
    t = Math.min(t, y);
    r = Math.max(r, x + 1);
    b = Math.max(b, y + 1);
  }
  return r ? [l, t, r, b] : null;
}

function origin(record) {
  const ss = record.ss;
  if (!(ss > 0) || !Number.isFinite(ss)) throw new Error('Invalid image supersampling');
  const layer = record.left !== undefined || record.top !== undefined;
  const x = layer ? record.left : -record.ox;
  const y = layer ? record.top : -record.oy;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Missing or invalid image origin');
  const deviceX = x * ss;
  const deviceY = y * ss;
  if (!Number.isFinite(deviceX) || !Number.isFinite(deviceY)) throw new Error('Invalid device image origin');
  return { x: deviceX, y: deviceY, ss, layer };
}

export function alignImages(a, b, recordA, recordB, crop = false) {
  const oa = origin(recordA);
  const ob = origin(recordB);
  if (oa.ss !== ob.ss || oa.layer !== ob.layer) throw new Error('Incompatible image coordinate systems or supersampling');
  const dx = ob.x - oa.x;
  const dy = ob.y - oa.y;
  if (Math.abs(dx - Math.round(dx)) > 1e-8 || Math.abs(dy - Math.round(dy)) > 1e-8) throw new Error('Image origins do not share a device-pixel grid');
  const bx = Math.round(dx);
  const by = Math.round(dy);
  let minX = Math.min(0, bx);
  let minY = Math.min(0, by);
  let maxX = Math.max(a.width, bx + b.width);
  let maxY = Math.max(a.height, by + b.height);
  // Preserve the original full-alignment safety bound even when transparent
  // space can be cropped away, including two empty pictures far apart.
  if ((maxX - minX) * (maxY - minY) > 100000000) {
    throw new Error('Aligned image exceeds 100 million pixels');
  }
  if (crop) {
    const boxes = [a.bbox === undefined ? alphaBbox(a.alpha, a.width, a.height) : a.bbox,
      b.bbox === undefined ? alphaBbox(b.alpha, b.width, b.height) : b.bbox];
    const bounds = boxes.flatMap((box, i) => box ? [[box[0] + (i ? bx : 0), box[1] + (i ? by : 0), box[2] + (i ? bx : 0), box[3] + (i ? by : 0)]] : []);
    if (bounds.length) {
      minX = Math.min(...bounds.map(box => box[0])) - 1;
      minY = Math.min(...bounds.map(box => box[1])) - 1;
      maxX = Math.max(...bounds.map(box => box[2])) + 1;
      maxY = Math.max(...bounds.map(box => box[3])) + 1;
    } else {
      maxX = minX + 1;
      maxY = minY + 1;
    }
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width * height > 100000000) throw new Error('Aligned image exceeds 100 million pixels');
  const before = new Uint8Array(width * height);
  const after = new Uint8Array(width * height);
  function place(image, dest, x, y) {
    const left = Math.max(0, -x);
    const right = Math.min(image.width, width - x);
    for (let row = Math.max(0, -y); row < Math.min(image.height, height - y); row++) {
      if (right > left) dest.set(image.alpha.subarray(row * image.width + left, row * image.width + right), (row + y) * width + x + left);
    }
  }
  place(a, before, -minX, -minY);
  place(b, after, bx - minX, by - minY);
  return { before, after, width, height, offset: { x: oa.x + minX, y: oa.y + minY } };
}

export function compareAlpha(aligned) {
  const { before, after, width, height } = aligned;
  let intersection = 0;
  let union = 0;
  let support = 0;
  let sum = 0;
  let xorCount = 0;
  const xor = new Uint8Array(before.length);
  for (let i = 0; i < before.length; i++) {
    const a = before[i] >= 128;
    const b = after[i] >= 128;
    if (a && b) intersection++;
    if (a || b) union++;
    if (before[i] || after[i]) {
      support++;
      sum += Math.abs(before[i] - after[i]);
    }
    if (a !== b) {
      xor[i] = 1;
      xorCount++;
    }
  }
  const bboxA = alphaBbox(before, width, height);
  const bboxB = alphaBbox(after, width, height);
  const bboxDelta = !bboxA && !bboxB ? 0 : !bboxA || !bboxB ? Infinity : Math.max(...bboxA.map((edge, i) => Math.abs(edge - bboxB[i])));
  let thick = 0;
  if (xorCount) for (const distance of distanceTransform(xor, width, height)) thick = Math.max(thick, 2 * distance);
  return { bboxDelta, iou: union ? intersection / union : 1, meanAbs: support ? sum / support : 0, thick,
    bboxBefore: bboxA, bboxAfter: bboxB, xorCount, support, width, height, offset: aligned.offset };
}

export function heatMap({ before, after }) {
  const rgba = new Uint8ClampedArray(before.length * 4);
  for (let i = 0; i < before.length; i++) {
    const delta = Math.abs(before[i] - after[i]);
    const xor = (before[i] >= 128) !== (after[i] >= 128);
    // Threshold disagreement is magenta; alpha-only disagreement is yellow.
    rgba[i * 4] = delta || xor ? 255 : 0;
    rgba[i * 4 + 1] = xor ? 0 : 210;
    rgba[i * 4 + 2] = xor ? 255 : 0;
    rgba[i * 4 + 3] = xor ? 128 + Math.round(delta * 127 / 255) : delta;
  }
  return rgba;
}
