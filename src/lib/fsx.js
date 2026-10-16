// ===== Filesystem facade =====
// Every library filesystem call goes through here. One seam to mock in tests,
// and the Tauri plugins stay lazily imported (same pattern as importer.js).

let fsMod = null;
let pathMod = null;
let coreMod = null;

async function fs() {
  if (!fsMod) fsMod = await import('@tauri-apps/plugin-fs');
  return fsMod;
}

async function path() {
  if (!pathMod) pathMod = await import('@tauri-apps/api/path');
  return pathMod;
}

// Temp names are unique per write. Two writes to one path can overlap (the
// debounced autosave and a flush both landing on chapter.json), and one
// clearing up after itself must never delete the other's half-written file.
let tmpSeq = 0;

// Every temp path that has been created and not yet renamed or removed.
//
// A rename-over is atomic, so a leftover `.tmp` beside a record can only mean a
// write that died between the two steps - litter, and the library sweeps it (see
// `sweepTemps` in library.svelte.js). But "leftover" is a claim about the past,
// and a sweep running while a write is in flight would see that write's temp
// file and delete the bytes out from under its own rename. So the sweep asks
// here first, and this is the only thing that can answer: the names are minted
// in this module and exist nowhere else until the rename lands.
const liveTemps = new Set();

// Is there a Tauri host to invoke commands on? Checked per call rather than
// remembered, and never assumed: the same code runs under `vite dev` in a plain
// browser and under the node test runner, and in both the answer is no.
const inTauri = () =>
  typeof globalThis !== 'undefined' && !!globalThis.window?.__TAURI_INTERNALS__;

// The parent directory of a path, by string. Both separators, because Windows
// hands back backslashes - the same fold `withinHome` does for the same reason.
function parentOf(p) {
  const i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
  return i > 0 ? String(p).slice(0, i) : '';
}

// Force the bytes (or the directory entry) to the actual device.
//
// The rename below makes the write ATOMIC - the target holds the old contents or
// the new, never a mix. It does not make it DURABLE: the temp file's bytes and
// the rename both sit in the page cache, and a power cut or a kernel panic in
// that window can replay the rename against a temp file whose data never landed,
// which is a chapter.json of the right length full of zeroes. Both halves are
// flushed instead: the file before the rename, the directory after it.
//
// Best-effort by construction. There is no filesystem plugin API for this, so it
// goes through a command of our own (`fsync_path` in src-tauri), and everywhere
// that command does not exist - the browser dev server, the test runner, an
// older shell - this is a no-op and the write is exactly as durable as it was
// before. A failure is never allowed to fail the write: the bytes are on their
// way to the disk either way, and refusing the save would be the larger harm.
//
// Bounded, and that bound is the whole of the freeze this used to be. `fsync(2)`
// on a wedged volume - a cloud-sync folder whose daemon has stopped answering, a
// network share that has gone away without dropping the mount - does not fail,
// it BLOCKS, for as long as the volume takes to come back. Every write here
// makes two of those calls, the autosave chain in library.svelte.js awaits them
// one save at a time, and an unbounded wait therefore stops the queue for good:
// the app goes on accepting edits and never writes another byte, with no error
// anywhere to say so.
//
// So a sync that has not answered inside `fsyncTimeoutMs` is abandoned and the
// write carries on WITHOUT it. What is given up is durability across a power cut
// in that window, which is what the platform was already refusing to provide.
// What is kept is the property that actually protects the file: the temp file
// plus the rename is atomic whether or not either half was flushed, so the
// target still holds the old contents or the new and never a mix. The abandoned
// call is left to finish on its own - there is no cancelling a syscall in
// flight - and its result is dropped.
const FSYNC_TIMEOUT_MS = 5000;
let fsyncTimeoutMs = FSYNC_TIMEOUT_MS;

// The seam for tests: the real bound is five seconds and no suite may wait it
// out. Returns the previous value so a test can put it back.
export function setFsyncTimeout(ms) {
  const was = fsyncTimeoutMs;
  fsyncTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : FSYNC_TIMEOUT_MS;
  return was;
}

const FSYNC_TIMED_OUT = Symbol('fsync-timeout');

// The filesystem plugin's refusal of a path outside its scope, as opposed to
// anything the disk itself said. "forbidden path: <path>" in release builds and
// the same words with a hint after them in debug ones.
const scopeRefused = (e) => /forbidden path/i.test(String(e?.message ?? e));

async function fsync(p) {
  if (!p || !inTauri()) return;
  let timer;
  try {
    if (!coreMod) coreMod = await import('@tauri-apps/api/core');
    const call = coreMod.invoke('fsync_path', { path: p });
    // The loser of the race is still a live promise. Without this, a rejection
    // arriving after the timeout has already been taken is an unhandled one.
    if (call && typeof call.catch === 'function') call.catch(() => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(FSYNC_TIMED_OUT), fsyncTimeoutMs);
    });
    await Promise.race([call, timeout]);
  } catch (e) {
    if (e === FSYNC_TIMED_OUT) {
      // Loud, because the write that follows is a degraded one and the volume
      // it is going to is in trouble. Never thrown: a stalled sync must not be
      // able to fail a save, let alone wedge the queue behind it.
      console.warn(
        `fsync did not answer within ${fsyncTimeoutMs}ms for ${p}; ` +
          'continuing without it (write is still atomic, not durable)',
      );
    }
    /* or: no such command, or the platform will not sync this handle; carry on */
  } finally {
    clearTimeout(timer);
  }
}

export const fsx = {
  // The sweep's seam - see `liveTemps`.
  liveTemps() {
    return new Set(liveTemps);
  },
  async readDir(p) {
    return (await fs()).readDir(p);
  },
  async readTextFile(p) {
    return (await fs()).readTextFile(p);
  },
  async writeTextFile(p, contents) {
    return (await fs()).writeTextFile(p, contents);
  },
  // The record files are rewritten every 800ms while the user types, and a
  // crash or a power cut partway through a plain write leaves truncated JSON -
  // which the scan reports as "Unreadable" and openChapter refuses, losing the
  // whole chapter's typesetting. Written to a temp file and renamed over the
  // target instead: rename within a directory is atomic on the filesystems this
  // app targets, so the target only ever holds the old contents or the new.
  //
  // The temp file is the target's own path plus a suffix, so it is a file, in
  // the same directory, by construction - never a directory, and the scan only
  // ever looks at directory entries, so a leftover cannot be mistaken for a
  // project or a chapter. It is removed on any failure regardless.
  async writeTextFileAtomic(p, contents) {
    // Claimed before the first await, not after it. A sweep that ran in the
    // window between them would see a name this write is about to create and
    // count it as somebody else's leftover - and the module import above is a
    // real await on the first call.
    const tmp = `${p}.${++tmpSeq}.tmp`;
    liveTemps.add(tmp);
    try {
      const m = await fs();
      await m.writeTextFile(tmp, contents);
      // Before the rename, never after: see `fsync`.
      await fsync(tmp);
      await m.rename(tmp, p);
      liveTemps.delete(tmp);
      await fsync(parentOf(p));
    } catch (e) {
      try {
        await (await fs()).remove(tmp);
      } catch {
        /* it may never have been created; the original is intact either way */
      }
      throw e;
    } finally {
      liveTemps.delete(tmp);
    }
  },
  async readFile(p) {
    return (await fs()).readFile(p);
  },
  async writeFile(p, bytes) {
    return (await fs()).writeFile(p, bytes);
  },
  // The binary twin, which is also what exports go through - and an export's
  // destination is one the user picked in a save dialog, which can be anywhere.
  // The dialog grants the scope that ONE file and nothing beside it, so outside
  // the home directory (an external volume, a network share) the temp sibling
  // is refused while the file itself is allowed, and the atomic write failed
  // every time with nothing saved. In that one case, and only that one, the
  // file is written in place - not atomically, which for a file the user just
  // chose to replace costs a re-export at worst. The case is a scope refusal of
  // the temp name, and the write that follows can only succeed when the target
  // carries a grant of its own. Library records never get here - they live
  // inside the scope, so their temp siblings are allowed, and a target the
  // scope refuses is refused again below. A disk error on the temp file is not
  // a scope refusal and still fails the write with the target untouched.
  async writeFileAtomic(p, bytes) {
    // Claimed before the first await - same reasoning as writeTextFileAtomic.
    const tmp = `${p}.${++tmpSeq}.tmp`;
    liveTemps.add(tmp);
    try {
      const m = await fs();
      try {
        await m.writeFile(tmp, bytes);
      } catch (e) {
        if (!scopeRefused(e)) throw e;
        liveTemps.delete(tmp);
        await m.writeFile(p, bytes);
        await fsync(p);
        return;
      }
      await fsync(tmp);
      await m.rename(tmp, p);
      liveTemps.delete(tmp);
      await fsync(parentOf(p));
    } catch (e) {
      try {
        await (await fs()).remove(tmp);
      } catch {
        /* it may never have been created; the original is intact either way */
      }
      throw e;
    } finally {
      liveTemps.delete(tmp);
    }
  },
  async mkdir(p) {
    return (await fs()).mkdir(p, { recursive: true });
  },
  async remove(p) {
    return (await fs()).remove(p, { recursive: true });
  },
  async trash(p) {
    if (!inTauri()) throw new Error('Moving to the trash needs the desktop app');
    if (!coreMod) coreMod = await import('@tauri-apps/api/core');
    return coreMod.invoke('trash_path', { path: p });
  },
  async rename(from, to) {
    return (await fs()).rename(from, to);
  },
  async exists(p) {
    return (await fs()).exists(p);
  },
  async join(...parts) {
    return (await path()).join(...parts);
  },
  // The webview URL for a file on disk, served by Tauri's asset protocol: the
  // renderer streams the bytes straight from the filesystem, with no IPC copy
  // and no blob held in JS memory. Null wherever there is no Tauri host (vite
  // dev in a plain browser, the test runner), and callers fall back to reading
  // the bytes themselves. The protocol's scope mirrors the fs scope - see the
  // note in src-tauri/capabilities/default.json.
  async assetUrl(p) {
    if (!inTauri()) return null;
    if (!coreMod) coreMod = await import('@tauri-apps/api/core');
    return coreMod.convertFileSrc(p);
  },
  async homeDir() {
    return (await path()).homeDir();
  },
  // Where app-wide data lives - the brush library, and anything else that
  // belongs to the install rather than to a project. On every platform this
  // sits inside the home directory, so it is already inside the one filesystem
  // scope this app is granted (see src-tauri/capabilities/default.json).
  //
  // Null wherever there is no Tauri host, which is `assetUrl`'s convention
  // above rather than `homeDir`'s: this is a path the plugin resolves by IPC,
  // so in the browser dev server and the test runner the real call throws a
  // TypeError about `__TAURI_INTERNALS__` rather than failing as a filesystem
  // call would. Callers get an answer they can test instead of an exception
  // from inside a dynamic import.
  async appDataDir() {
    if (!inTauri()) return null;
    return (await path()).appDataDir();
  },
};
