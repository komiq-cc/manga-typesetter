// Lower envelope of parabolas, Felzenszwalb-Huttenlocher. Skip infinite
// sites to avoid Infinity - Infinity corrupting the envelope intersections.
function transform1d(f, n, out, sites, edges) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (!Number.isFinite(f[q])) continue;
    let s = -Infinity;
    while (k >= 0) {
      const p = sites[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * (q - p));
      if (s > edges[k]) break;
      k--;
    }
    sites[++k] = q;
    edges[k] = k === 0 ? -Infinity : s;
    edges[k + 1] = Infinity;
  }
  if (k < 0) { out.fill(Infinity, 0, n); return; }
  let site = 0;
  for (let q = 0; q < n; q++) {
    while (edges[site + 1] < q) site++;
    const delta = q - sites[site];
    out[q] = delta * delta + f[sites[site]];
  }
}

// Distance to the nearest background pixel center, including a one-pixel
// exterior border. Return Euclidean distances, not chamfer approximations.
export function distanceTransform(mask, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || mask.length !== width * height) throw new Error('Invalid mask dimensions');
  const w = width + 2;
  const h = height + 2;
  const grid = new Float64Array(w * h);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) grid[(y + 1) * w + x + 1] = mask[y * width + x] ? Infinity : 0;
  const length = Math.max(w, h);
  const f = new Float64Array(length);
  const out = new Float64Array(length);
  const sites = new Int32Array(length);
  const edges = new Float64Array(length + 1);
  for (let y = 0; y < h; y++) {
    f.set(grid.subarray(y * w, (y + 1) * w));
    transform1d(f, w, out, sites, edges);
    grid.set(out.subarray(0, w), y * w);
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    transform1d(f, h, out, sites, edges);
    for (let y = 0; y < h; y++) grid[y * w + x] = out[y];
  }
  const result = new Float64Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) result[y * width + x] = Math.sqrt(grid[(y + 1) * w + x + 1]);
  return result;
}
