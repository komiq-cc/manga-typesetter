// Where the app finds the Rust text engine's wasm.
//
// text-engine/js/generated/mt_text.wasm is a build product
// (`npm run build:engine`) and is not in the repository, so the app has to
// build and run without it. A glob is how Vite is asked for a file that may
// not be there: a plain `import ... ?url` of a missing file fails the build
// and the dev server both, a glob that matches nothing is an empty object.
// When the file is there it is emitted like any other asset and this is its
// URL, in `vite dev` and in `vite build` alike.
const found = import.meta.glob('../../../text-engine/js/generated/mt_text.wasm', { query: '?url', import: 'default', eager: true });

/** The wasm's URL in this build, or null when the build was made without it. */
export const engineWasmUrl = Object.values(found)[0] ?? null;

/** The wasm's bytes. Fetched from the app's own bundle, never from the network at large. */
export async function fetchEngineWasm(url = engineWasmUrl) {
  if (!url) throw new Error('this build has no text engine (run npm run build:engine before building the app)');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the text engine could not be read (${response.status})`);
  return response.arrayBuffer();
}
