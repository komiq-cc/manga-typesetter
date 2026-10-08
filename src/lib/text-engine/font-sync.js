// Keeps the Rust text engine's fonts in step with the app's.
//
// The engine measures only bytes it was handed (rust.js), and the app has
// three kinds of family (store `app.fonts`):
//
//   user     the bytes are the user's own files. Handed over as they are
//            registered and taken back as they are removed (fonts.js tells
//            whoever watches). A WOFF or WOFF2 file is decoded to a plain font
//            first, natively (`toSfnt`); where there is nobody to decode it -
//            a plain browser - the face cannot be used by this engine.
//   system   names only until a box uses one. The first question about a
//            family sends for its faces (`systemFace`), and it is not ready
//            until they are all in.
//   builtin  fetched from the network by the browser and by nobody else. This
//            engine has no bytes for them, so a built-in is a font the machine
//            does not have.
//
// Every name therefore resolves to one of three states:
//
//   ready     measured as itself.
//   arriving  will be measured as itself; its bytes are on the way. Until
//             then it is measured as the last resort, and the store keeps
//             that out of the document (`faceArriving`).
//   missing   the machine has no usable face for it. Measured as the last
//             resort (last-resort.js) for as long as that is true, and said
//             so in the editor.
//
// Nothing here imports the store or Tauri: the lists, the two ways of getting
// bytes and what to do when something lands are all handed in, which is what
// lets the same code run against the real engine with fixture fonts.
import { FACE_SLOTS } from '../data.js';
import { lastResortFamily } from './last-resort.js';

const TAG = (a, b, c, d) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const SFNT_TAGS = new Set([0x00010000, TAG(0x74, 0x72, 0x75, 0x65) /* true */, TAG(0x4f, 0x54, 0x54, 0x4f) /* OTTO */]);

/** What a font file is, by its first four bytes: 'sfnt', 'collection', 'woff', 'woff2' or 'unknown'. */
export function fontKind(bytes) {
  if (!bytes || bytes.byteLength < 4) return 'unknown';
  const tag = TAG(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (SFNT_TAGS.has(tag)) return 'sfnt';
  if (tag === TAG(0x74, 0x74, 0x63, 0x66)) return 'collection'; // ttcf
  if (tag === TAG(0x77, 0x4f, 0x46, 0x46)) return 'woff'; // wOFF
  if (tag === TAG(0x77, 0x4f, 0x46, 0x32)) return 'woff2'; // wOF2
  return 'unknown';
}

const asBytes = (data) =>
  data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);

// What `systemFace` answers with: four little-endian int32, one per slot in
// FACE_SLOTS order, then the file. A slot's number is the index of its face
// inside THIS file, or -1 when that slot's face is not in it. A collection
// (Helvetica Neue.ttc holds all four) therefore crosses once, and the engine
// keeps one copy of it for every face it gives.
export const SYSTEM_FACE_HEADER = FACE_SLOTS.length * 4;
export function readSystemFace(buffer) {
  const bytes = asBytes(buffer);
  if (bytes.byteLength <= SYSTEM_FACE_HEADER) throw new Error('system font: empty answer');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = [];
  FACE_SLOTS.forEach((slot, i) => {
    const index = view.getInt32(i * 4, true);
    if (index >= 0) faces.push({ slot, index });
  });
  return { faces, bytes: bytes.subarray(SYSTEM_FACE_HEADER) };
}

/**
 * @param {object} with
 * @param {object} with.engine the Rust adapter (rust.js)
 * @param {{ user: object[], system: object[] }} with.fonts the app's lists, read live
 * @param {string | null} with.os 'macos' | 'windows' | 'linux' | null (last-resort.js)
 * @param {((family: string, slot: string) => Promise<ArrayBuffer>) | null} [with.systemFace]
 *   bytes of one system face, as `readSystemFace` reads them; null where there
 *   are no system fonts to ask for (a plain browser)
 * @param {((bytes: Uint8Array) => Promise<ArrayBuffer | Uint8Array>) | null} [with.toSfnt]
 *   WOFF / WOFF2 to a plain font; null where nothing can decode one
 * @param {(family: string) => void} [with.onArrival] bytes that were on their
 *   way are in, or are known not to be coming: every measurement is stale
 */
export function createFontSync({ engine, fonts, os = null, systemFace = null, toSfnt = null, onArrival = () => {} }) {
  // family -> Map(slot -> { state: 'ready' | 'decoding' | 'unusable', why })
  const user = new Map();
  // family -> { state: 'loading' | 'ready' | 'failed' }
  const system = new Map();
  // name -> { family, state }: what `resolve` last answered, until anything changes
  const cache = new Map();
  const flights = new Set();
  let systemSeen = null;
  let systemSeenLength = -1;
  let systemByName = new Map();
  // The last-resort family, once the engine has it; null until then.
  let resort = null;
  let disposed = false;

  const usable = (fam) => [...fam.values()].some((f) => f.state === 'ready');

  // The families a letter is looked for in when the face asked lacks it.
  //
  // THE SEAM for the next task: today this is the last resort alone, which is
  // a Latin face, so kana, Hangul and CJK in a face without them still come
  // out as `.notdef` and `engine.missing` reports them. Finding a system face
  // by coverage belongs here: ask the native side which installed family has
  // the code points `engine.missing` returned, send for it the way
  // `startSystem` does, and append its name to this list.
  function fallbackChain() {
    return resort ? [resort] : [];
  }

  function setResort(name) {
    if (resort === name) return;
    resort = name;
    cache.clear();
    engine.setFallbacks(fallbackChain());
  }

  // Which family is the last resort now (last-resort.js). A system family
  // chosen for it is sent for like any other; the one before it stands until
  // the new one is in, so there is no moment with a name nothing answers for.
  function relist() {
    const failed = (name) => system.get(name)?.state === 'failed';
    const pick = lastResortFamily({
      os,
      system: systemFace ? fonts.system.map((f) => f.name).filter((n) => !failed(n) || user.has(n)) : [],
      user: [...user].filter(([, fam]) => usable(fam)).map(([name]) => name),
    });
    if (pick && engine.hasFamily(pick.name) && stateOf(pick.name) === 'ready') {
      setResort(pick.name);
      return;
    }
    if (pick?.source === 'system' && !system.has(pick.name)) startSystem(pick.name);
    if (resort && (!engine.hasFamily(resort) || stateOf(resort) !== 'ready')) setResort(null);
  }

  // The system list is replaced wholesale by a scan. A family it no longer
  // lists has been uninstalled, and one that failed gets another try.
  function followSystemList() {
    const list = fonts.system;
    if (list === systemSeen && list.length === systemSeenLength) return false;
    systemSeen = list;
    systemSeenLength = list.length;
    systemByName = new Map(list.map((f) => [f.name, f]));
    for (const [name, rec] of [...system]) {
      if (systemByName.has(name) && rec.state !== 'failed') continue;
      system.delete(name);
      if (!user.has(name)) engine.removeFamily(name);
    }
    cache.clear();
    relist();
    return true;
  }

  function stateOf(name) {
    const mine = user.get(name);
    if (mine) {
      if (usable(mine)) return 'ready';
      return [...mine.values()].some((f) => f.state === 'decoding') ? 'arriving' : 'missing';
    }
    if (systemFace && systemByName.has(name)) {
      const rec = system.get(name);
      if (rec?.state === 'ready') return 'ready';
      return rec?.state === 'failed' ? 'missing' : 'arriving';
    }
    return 'missing';
  }

  function resolve(name) {
    followSystemList();
    let r = cache.get(name);
    if (r) return r;
    const state = stateOf(name);
    // The first question about a system family is what sends for it.
    if (state === 'arriving' && !user.has(name) && !system.has(name)) startSystem(name);
    r = { family: state === 'ready' ? name : resort, state };
    cache.set(name, r);
    return r;
  }

  function landed(name) {
    if (disposed) return;
    cache.clear();
    relist();
    onArrival(name);
  }

  function track(promise) {
    flights.add(promise);
    const done = () => flights.delete(promise);
    promise.then(done, done);
  }

  // Every file of the family first, then the engine: a family half registered
  // would measure its bold as a smeared regular until the rest came.
  async function fetchSystem(name, rec) {
    const entry = systemByName.get(name);
    const want = FACE_SLOTS.filter((s) => entry?.faces?.[s]);
    if (!want.length) throw new Error('no faces');
    const files = [];
    const got = new Set();
    for (const slot of want) {
      if (got.has(slot)) continue;
      const { faces, bytes } = readSystemFace(await systemFace(name, slot));
      const mine = faces.filter((f) => want.includes(f.slot) && !got.has(f.slot));
      if (!mine.some((f) => f.slot === slot)) throw new Error(`the answer for ${slot} does not hold it`);
      for (const f of mine) got.add(f.slot);
      files.push({ bytes, faces: mine });
    }
    // The user's own font took the name while these were on the way.
    if (system.get(name) !== rec || disposed) return false;
    try {
      for (const file of files) engine.addFaces(name, file.bytes, file.faces);
    } catch (error) {
      engine.removeFamily(name);
      throw error;
    }
    return true;
  }

  function startSystem(name) {
    const rec = { state: 'loading', error: '' };
    system.set(name, rec);
    track(
      fetchSystem(name, rec).then(
        (mine) => {
          if (!mine) return;
          rec.state = 'ready';
          landed(name);
        },
        (error) => {
          if (system.get(name) !== rec || disposed) return;
          rec.state = 'failed';
          rec.error = String(error?.message ?? error);
          landed(name);
        },
      ),
    );
  }

  // A user family and a system family of one name are one name to the engine,
  // and the user's own wins it, as it does in the store's lookup.
  function claimName(family) {
    if (!system.has(family)) return;
    system.delete(family);
    engine.removeFamily(family);
  }

  function register(family, slot, rec, bytes) {
    try {
      // A collection the user dropped has no face index in the app's model:
      // its first face is the one, as it is for the PostScript name (fonts.js).
      engine.addFace(family, slot, bytes, 0);
      rec.state = 'ready';
    } catch {
      engine.removeFace(family, slot);
      rec.state = 'unusable';
      rec.why = 'unreadable';
    }
  }

  return {
    /** A user face was registered, or replaced the one in its slot. */
    setUserFace(family, slot, data) {
      if (!FACE_SLOTS.includes(slot)) return;
      const bytes = asBytes(data);
      followSystemList();
      claimName(family);
      let fam = user.get(family);
      if (!fam) user.set(family, (fam = new Map()));
      const rec = { state: 'unusable', why: '' };
      fam.set(slot, rec);
      const kind = fontKind(bytes);
      if (kind === 'woff' || kind === 'woff2') {
        // The face that was in the slot is not the file the user now has there.
        engine.removeFace(family, slot);
        if (!toSfnt) {
          rec.why = 'compressed';
        } else {
          rec.state = 'decoding';
          const current = () => !disposed && user.get(family) === fam && fam.get(slot) === rec;
          // Asked now, not a tick later: whoever waits on `settled` right
          // after this call must find the decode already on its way.
          let decoded;
          try {
            decoded = Promise.resolve(toSfnt(bytes));
          } catch (error) {
            decoded = Promise.reject(error);
          }
          track(
            decoded
              .then(
                (sfnt) => {
                  if (!current()) return;
                  register(family, slot, rec, asBytes(sfnt));
                  landed(family);
                },
                () => {
                  if (!current()) return;
                  rec.state = 'unusable';
                  rec.why = 'unreadable';
                  landed(family);
                },
              ),
          );
        }
      } else {
        register(family, slot, rec, bytes);
      }
      cache.clear();
      relist();
    },
    removeUserFace(family, slot) {
      followSystemList();
      const fam = user.get(family);
      if (!fam?.delete(slot)) return;
      engine.removeFace(family, slot);
      if (!fam.size) user.delete(family);
      cache.clear();
      relist();
    },
    removeUserFamily(family) {
      followSystemList();
      if (!user.delete(family)) return;
      engine.removeFamily(family);
      cache.clear();
      relist();
    },

    /** The system list was replaced, or anything else the lists say changed. */
    refresh() {
      if (!followSystemList()) {
        cache.clear();
        relist();
      }
    },

    /** The family `name` is measured as right now: itself, or the last resort; null when there is neither. */
    nameFor(name) {
      return resolve(name).family;
    },
    /** False while `name` is measured as a stand-in for a face that is on its way. */
    ready(name) {
      return resolve(name).state !== 'arriving';
    },
    /** Whether the machine has no usable face for `name`. */
    missing(name) {
      return resolve(name).state === 'missing';
    },
    /**
     * Why a missing name is missing: 'compressed' (a WOFF file and nothing to
     * decode it), 'unreadable' (the engine refused the file), or 'absent'.
     */
    whyMissing(name) {
      if (resolve(name).state !== 'missing') return null;
      const mine = user.get(name);
      if (mine) return [...mine.values()].some((f) => f.why === 'compressed') ? 'compressed' : 'unreadable';
      return system.get(name)?.state === 'failed' ? 'unreadable' : 'absent';
    },
    lastResort() {
      followSystemList();
      return resort;
    },
    /** Resolves when nothing is on its way any more. */
    async settled() {
      while (flights.size) await Promise.allSettled([...flights]);
    },
    /** Takes everything this put into the engine back out. */
    dispose() {
      disposed = true;
      for (const name of new Set([...user.keys(), ...system.keys()])) engine.removeFamily(name);
      user.clear();
      system.clear();
      cache.clear();
      resort = null;
      engine.setFallbacks([]);
    },
    /** For tests and for looking: what is registered and how. */
    snapshot() {
      return {
        lastResort: resort,
        user: Object.fromEntries([...user].map(([name, fam]) => [name, Object.fromEntries([...fam].map(([slot, f]) => [slot, f.state]))])),
        system: Object.fromEntries([...system].map(([name, rec]) => [name, rec.state])),
      };
    },
  };
}
