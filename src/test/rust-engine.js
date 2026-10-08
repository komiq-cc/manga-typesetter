// For the `engine` test project (`*.engine.test.js`): the built wasm and the
// fixture fonts, read from disk. The wasm is a build product and is not in the
// repository, so a missing one is a failure that says how to make it - a lane
// that skipped would report green for an engine nobody ran.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRustTextEngine } from '../lib/text-engine/rust.js';

const wasmPath = fileURLToPath(new URL('../../text-engine/js/generated/mt_text.wasm', import.meta.url));

export function engineWasm() {
  if (!existsSync(wasmPath)) throw new Error(`${wasmPath} is missing: run npm run build:engine`);
  return readFileSync(wasmPath);
}

export const fixtureFont = (file) => readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)));

// Family names as the app's font list writes them (see real-fonts.js).
export const FIXTURE_FACES = [
  ['Comic Neue', 'regular', 'ComicNeue-Regular.ttf'],
  ['Bangers', 'regular', 'Bangers-Regular.ttf'],
  ['DejaVu Sans', 'regular', 'DejaVuSans.ttf'],
  ['DejaVu Sans', 'italic', 'DejaVuSans-Oblique.ttf'],
];

export async function rustEngine({ fixtures = true } = {}) {
  let engine;
  try {
    engine = await createRustTextEngine(engineWasm());
  } catch (error) {
    if (/ABI/.test(error.message)) throw new Error(`${error.message}: the wasm is stale, run npm run build:engine`);
    throw error;
  }
  if (fixtures) for (const [family, slot, file] of FIXTURE_FACES) engine.addFace(family, slot, fixtureFont(file));
  return engine;
}
