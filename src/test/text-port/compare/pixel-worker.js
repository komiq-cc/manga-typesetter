import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { loadAlpha, writeAssets } from './io.js';
import { alignImages, compareAlpha } from './images.js';

const { before, after, cases, out } = workerData;
const timings = { decode: 0, images: 0 };
const results = [];
try {
  for (const item of cases) {
    if (out) {
      await writeAssets(out, item, before, after);
      results.push({ images: item.images, image: item.image });
      continue;
    }
    let start = performance.now();
    const a = await loadAlpha(before, item.before);
    const b = await loadAlpha(after, item.after);
    timings.decode += performance.now() - start;
    start = performance.now();
    results.push(compareAlpha(alignImages(a, b, item.before, item.after, true)));
    timings.images += performance.now() - start;
  }
  parentPort.postMessage({ results, timings });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
