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

// How many names `resolve` keeps an answer for. A chapter names a handful of
// fonts; this is room for many chapters' worth before anything is forgotten.
const RESOLVED_MAX = 256;

const asBytes = (data) =>
  data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);

// What `systemFace` answers with (src-tauri/src/system_fonts.rs, `FACE_HEADER`),
// every number little-endian:
//
//    0  u32      the version of this layout, SYSTEM_FACE_VERSION
//    4  i32 x 4  one per slot in FACE_SLOTS order: the index of that slot's
//                face inside THIS file, or -1 when its face is not in it
//   20  u8 x 8   the file's id, opaque
//   28  u64      the file's length in bytes
//   36  u32      flags; bit 0: the file follows
//   40  ...      the file, when bit 0 is set
//
// The slots are why a collection crosses once for a family: Helvetica Neue.ttc
// holds all four of its faces, and the engine keeps one copy for all of them.
// The id is why it crosses once for every family in it: the question carries
// the ids of the files the engine holds (`known`), and the answer for one of
// those is the header alone.
export const SYSTEM_FACE_VERSION = 2;
export const SYSTEM_FACE_HEADER = 40;
export function readSystemFace(buffer) {
  const all = asBytes(buffer);
  if (all.byteLength < 4) throw new Error('system font: empty answer');
  const view = new DataView(all.buffer, all.byteOffset, all.byteLength);
  const version = view.getUint32(0, true);
  // Another layout is not guessed at: a font read at the wrong offset is a
  // font that fails to parse at best.
  if (version !== SYSTEM_FACE_VERSION) throw new Error(`system font: answer of version ${version}, and this reads version ${SYSTEM_FACE_VERSION}`);
  if (all.byteLength < SYSTEM_FACE_HEADER) throw new Error('system font: empty answer');
  const faces = [];
  FACE_SLOTS.forEach((slot, i) => {
    const index = view.getInt32(4 + i * 4, true);
    if (index >= 0) faces.push({ slot, index });
  });
  const file = [...all.subarray(20, 28)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const size = Number(view.getBigUint64(28, true));
  if (!(view.getUint32(36, true) & 1)) return { faces, file, size, bytes: null };
  const bytes = all.subarray(SYSTEM_FACE_HEADER);
  if (!bytes.byteLength || bytes.byteLength !== size) throw new Error('system font: the answer does not hold the file it says it does');
  return { faces, file, size, bytes };
}

/**
 * @param {object} with
 * @param {object} with.engine the Rust adapter (rust.js)
 * @param {{ user: object[], system: object[] }} with.fonts the app's lists, read live
 * @param {string | null} with.os 'macos' | 'windows' | 'linux' | null (last-resort.js)
 * @param {((family: string, slot: string, known: string[]) => Promise<ArrayBuffer>) | null} [with.systemFace]
 *   the file of one system face, as `readSystemFace` reads it; `known` is the
 *   ids of the files the engine holds, which need not be sent again. Null
 *   where there are no system fonts to ask for (a plain browser)
 * @param {((bytes: Uint8Array) => Promise<ArrayBuffer | Uint8Array>) | null} [with.toSfnt]
 *   WOFF / WOFF2 to a plain font; null where nothing can decode one
 * @param {(family: string) => void} [with.onArrival] bytes that were on their
 *   way are in, or are known not to be coming: every measurement is stale
 */
export function createFontSync({ engine, fonts, os = null, systemFace = null, toSfnt = null, onArrival = () => {} }) {
  // family -> Map(slot -> { state: 'ready' | 'decoding' | 'unusable', why })
  const user = new Map();
  // family -> { state: 'loading' | 'ready' | 'failed', seen }
  const system = new Map();
  // System families the engine still holds as they were before a scan found
  // their files moved, and that have no record above any more (`followSystemList`).
  const stale = new Set();
  // name -> { family, state }: what `resolve` last answered, until anything
  // changes. The names are whatever the documents say, a new set with every
  // chapter opened, and nothing here hears of a chapter closing: so it is
  // kept to RESOLVED_MAX names and emptied when it reaches them. An answer is
  // cheap to work out again and working it out twice changes nothing - what
  // was sent for is remembered in `system`, not here.
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
    // No box need name the last resort, so nobody else would ask again for
    // one whose files moved; it stands as it was until the new bytes are in.
    if (pick && stale.has(pick.name) && !system.has(pick.name)) startSystem(pick.name);
    if (pick && engine.hasFamily(pick.name) && measurable(pick.name)) {
      setResort(pick.name);
      return;
    }
    if (pick?.source === 'system' && !system.has(pick.name)) startSystem(pick.name);
    if (resort && (!engine.hasFamily(resort) || !measurable(resort))) setResort(null);
  }

  // What a list entry says of the files behind a family, as far as this side
  // can know it: the scan's fingerprint of them (`stamp`, see system_fonts.rs)
  // and which faces there are. Two scans that agree on both found the same
  // files; the engine's copy of them is still the font.
  const filesSeen = (entry) => `${entry?.stamp ?? ''}|${FACE_SLOTS.filter((s) => entry?.faces?.[s]).join(',')}`;

  // The system list is replaced wholesale by a scan. A family it no longer
  // lists has been uninstalled, and one that failed gets another try. One
  // whose files moved - a bold installed where there was none, a font updated
  // in place - is forgotten too, and sent for again the next time it is asked
  // about: the webview is already drawing the new files, and bytes kept from
  // before would measure a font nobody sees. What the engine holds of such a
  // family stays until the new bytes replace it (`fetchSystem`), so the last
  // resort is never measured as nothing while it is re-read.
  function followSystemList() {
    const list = fonts.system;
    if (list === systemSeen && list.length === systemSeenLength) return false;
    systemSeen = list;
    systemSeenLength = list.length;
    systemByName = new Map(list.map((f) => [f.name, f]));
    for (const [name, rec] of [...system]) {
      const entry = systemByName.get(name);
      if (entry && rec.state !== 'failed' && rec.seen === filesSeen(entry)) continue;
      system.delete(name);
      if (entry && rec.state === 'ready') stale.add(name);
      else if (!user.has(name)) engine.removeFamily(name);
    }
    for (const name of [...stale]) {
      if (systemByName.has(name)) continue;
      stale.delete(name);
      engine.removeFamily(name);
    }
    cache.clear();
    relist();
    return true;
  }

  // Ready is a statement about the whole family, not about one face of it: a
  // user family is arriving for as long as ANY of its faces is still being
  // decoded, however many are already in. The engine synthesises a bold from
  // the regular, so with the regular in and the bold on its way a bold box
  // would be measured, and written, as that smear - and the fits only grow, so
  // the excess stays when the real bold lands. Asked per family rather than
  // per style on purpose: which face a style gets is the engine's rule (slant
  // first, then weight), and a second copy of it here could disagree with it,
  // where "nothing of this family is still on its way" cannot write early.
  function stateOf(name) {
    const mine = user.get(name);
    if (mine) {
      if ([...mine.values()].some((f) => f.state === 'decoding')) return 'arriving';
      return usable(mine) ? 'ready' : 'missing';
    }
    if (systemFace && systemByName.has(name)) {
      const rec = system.get(name);
      if (rec?.state === 'ready') return 'ready';
      return rec?.state === 'failed' ? 'missing' : 'arriving';
    }
    return 'missing';
  }

  // Whether the engine can measure `name` as itself at this moment, ready or
  // not: a user family with one face in while another is decoded can.
  // So can a system family that is to be read again because its files moved:
  // the engine still has it as it was.
  function measurable(name) {
    const mine = user.get(name);
    return mine ? usable(mine) : stale.has(name) || stateOf(name) === 'ready';
  }

  function resolve(name) {
    followSystemList();
    let r = cache.get(name);
    if (r) return r;
    const state = stateOf(name);
    // The first question about a system family is what sends for it.
    if (state === 'arriving' && !user.has(name) && !system.has(name)) startSystem(name);
    // What is shown while a family arrives is its own face when it has one,
    // which is nearer the truth than the last resort; nothing is written from
    // either (`ready`).
    r = { family: measurable(name) ? name : resort, state };
    if (cache.size >= RESOLVED_MAX) cache.clear();
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
      const answer = readSystemFace(await systemFace(name, slot, engine.files()));
      const mine = answer.faces.filter((f) => want.includes(f.slot) && !got.has(f.slot));
      if (!mine.some((f) => f.slot === slot)) throw new Error(`the answer for ${slot} does not hold it`);
      for (const f of mine) got.add(f.slot);
      files.push({ slot, file: answer.file, bytes: answer.bytes, faces: mine });
    }
    // A file that was not sent because the engine held it has to be held
    // still: the family it was held for may have gone while the others were
    // on their way. Asked for again, this time saying nothing is known, so it
    // comes; each round turns at least one such file into bytes, so it ends.
    for (;;) {
      const gone = files.filter((f) => !f.bytes && !engine.hasFile(f.file));
      if (!gone.length) break;
      for (const f of gone) {
        const answer = readSystemFace(await systemFace(name, f.slot, []));
        if (!answer.bytes) throw new Error(`the file for ${f.slot} was not sent`);
        f.file = answer.file;
        f.bytes = answer.bytes;
      }
    }
    // The user's own font took the name while these were on the way.
    if (system.get(name) !== rec || disposed) return false;
    // New faces in first, then what is left of the old: a file the family had
    // before its files moved, and still has, is held through the change by
    // the faces being replaced, so it is not sent for a second time.
    const before = stale.delete(name) ? engine.facesOf(name) : [];
    for (const f of files) engine.addFaces(name, f.bytes, f.faces, f.file);
    // A slot the family no longer has must not outlive the file it came from.
    for (const slot of before) if (!got.has(slot)) engine.removeFace(name, slot);
    return true;
  }

  function startSystem(name) {
    const rec = { state: 'loading', error: '', seen: filesSeen(systemByName.get(name)) };
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
          // Nothing of it is left to be measured as itself: not half of what
          // was being registered, and not the faces from before its files moved.
          stale.delete(name);
          engine.removeFamily(name);
          landed(name);
        },
      ),
    );
  }

  // A user family and a system family of one name are one name to the engine,
  // and the user's own wins it, as it does in the store's lookup.
  function claimName(family) {
    const held = stale.delete(family);
    if (!system.delete(family) && !held) return;
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
    /**
     * A user face was registered, or replaced the one in its slot. `data` is
     * null for a face the app has loaded but has no bytes of to give (its save
     * failed before anybody was here to take them): it is the user's, so the
     * name is theirs, and it is unusable until the file is added again.
     */
    setUserFace(family, slot, data) {
      if (!FACE_SLOTS.includes(slot)) return;
      const bytes = data == null ? null : asBytes(data);
      followSystemList();
      claimName(family);
      let fam = user.get(family);
      if (!fam) user.set(family, (fam = new Map()));
      const rec = { state: 'unusable', why: '' };
      fam.set(slot, rec);
      const kind = bytes ? fontKind(bytes) : 'none';
      if (!bytes) {
        engine.removeFace(family, slot);
        rec.why = 'unsaved';
      } else if (kind === 'woff' || kind === 'woff2') {
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
            decoded.then(
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
     * decode it), 'unsaved' (the app has the face but no bytes of it to give),
     * 'unreadable' (the engine refused the file), or 'absent'.
     */
    whyMissing(name) {
      if (resolve(name).state !== 'missing') return null;
      const mine = user.get(name);
      if (mine) return ['compressed', 'unsaved'].find((why) => [...mine.values()].some((f) => f.why === why)) ?? 'unreadable';
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
      for (const name of new Set([...user.keys(), ...system.keys(), ...stale])) engine.removeFamily(name);
      user.clear();
      system.clear();
      stale.clear();
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
        // How many names have an answer kept for them.
        resolved: cache.size,
      };
    },
  };
}
