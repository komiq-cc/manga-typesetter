// Earlier chapter.json bytes, never a reconstruction from the editor's state.
// The record's own timestamp identifies a version, so reopening an unchanged
// chapter cannot fill the shelf with twenty copies of the same document.
import { fsx } from './fsx.js';

const NAME = /^(\d{8}T\d{9}Z)--([a-z-]+)\.json(?![\s\S])/;
const now = () => new Date().toISOString();

// File names come from records and directory listings, neither of which is a
// path grant. In particular, garbage collection must never resolve a name
// outside previous-cleaned, even when a record has been edited by hand.
const isPlainFileName = (name) =>
  typeof name === 'string' &&
  name.trim().length > 0 &&
  !name.includes('/') &&
  !name.includes('\\') &&
  name !== '.' &&
  name !== '..';

export function isSnapshotName(name) {
  return typeof name === 'string' && NAME.test(name);
}

// A hand-edited or foreign record can carry any `updatedAt`, and an Invalid
// Date throws on toISOString - which would refuse the before-restore snapshot
// and with it the restore. Such a record is stamped with the time it was seen.
function stampOf(record) {
  const at = new Date(record?.updatedAt ?? now());
  return (Number.isNaN(at.getTime()) ? new Date() : at).toISOString().replace(/[-:.]/g, '');
}

const folder = (chapterDir) => fsx.join(chapterDir, 'logs', 'snapshots');

async function namesIn(dir) {
  if (!(await fsx.exists(dir))) return [];
  return (await fsx.readDir(dir))
    .filter((e) => e.isFile && isSnapshotName(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function takeSnapshot(chapterDir, text, record, reason) {
  if (typeof reason !== 'string' || !/^[a-z-]+(?![\s\S])/.test(reason)) {
    throw new Error('Invalid snapshot reason');
  }
  let stamp = stampOf(record);
  const dir = await folder(chapterDir);
  const names = await namesIn(dir);
  const taken = (st) => names.find((name) => name.startsWith(`${st}--`));
  const same = taken(stamp);
  if (same) {
    // The same `updatedAt` is the same version only when the bytes agree too.
    // A tool that rewrites chapter.json and leaves the stamp alone produced a
    // different document under an old name; refusing to keep it would make
    // every later required snapshot fail on it. It is filed under the time it
    // was seen instead (one millisecond on until the name is free).
    let shelved = null;
    try {
      shelved = await fsx.readTextFile(await fsx.join(dir, same));
    } catch {
      /* unreadable: treat as different, and keep this copy */
    }
    if (shelved === text) return null;
    let at = Date.now();
    do stamp = stampOf({ updatedAt: new Date(at++).toISOString() });
    while (taken(stamp));
  }
  await fsx.mkdir(dir);
  const name = `${stamp}--${reason}.json`;
  await fsx.writeTextFileAtomic(await fsx.join(dir, name), text);
  // Only our own file names are pruned. A stray file in logs is still the
  // user's, and a failed prune must reach the caller just like a failed write:
  // restore and destructive source edits require a retained undo snapshot.
  // The one just written always stays. Its stamp is the record's own time,
  // which can be older than everything on the shelf - an outside edit that
  // kept an old `updatedAt`, a clock set back - and pruning by stamp alone
  // would delete the copy this call exists to keep. The others go oldest first.
  let pruned = false;
  try {
    for (const old of names.slice(19)) {
      await fsx.remove(await fsx.join(dir, old));
      pruned = true;
    }
  } finally {
    if (pruned) await prunePreviousCleaned(chapterDir);
  }
  return name;
}

// A required undo point, including the version already on the shelf when the
// timestamp dedupes. Compare bytes: a hand edit can reuse updatedAt for a
// different document, and returning that older name would promise a false undo.
export async function requireSnapshot(chapterDir, text, record, reason) {
  try {
    let name = await takeSnapshot(chapterDir, text, record, reason);
    const dir = await folder(chapterDir);
    if (!name) {
      for (const existing of await namesIn(dir)) {
        try {
          if (await fsx.readTextFile(await fsx.join(dir, existing)) === text) {
            name = existing;
            break;
          }
        } catch {
          /* One unreadable file must not hide a readable exact copy. */
        }
      }
    }
    if (!name || !(await fsx.exists(await fsx.join(dir, name)))) {
      throw new Error('The current chapter could not be retained');
    }
    return name;
  } catch (e) {
    throw new Error(`Could not keep an undo snapshot (${reason}): ${e?.message ?? e}`);
  }
}

// A kept raster can go only after the last document that names it has gone.
// Read the live record as well as every remaining snapshot; if any one cannot
// be read, the safe answer is to keep everything. This is housekeeping, never
// a reason to fail the snapshot, and its only removal targets are plain files
// directly inside previous-cleaned.
async function prunePreviousCleaned(chapterDir) {
  try {
    const previous = await fsx.join(chapterDir, 'logs', 'previous-cleaned');
    if (!(await fsx.exists(previous))) return;
    // Fix the candidates before reading references, so a file newly kept by
    // another operation during the scan is never swept by this older pass.
    const candidates = await fsx.readDir(previous);
    const needed = new Set();
    const collect = (text) => {
      const record = JSON.parse(text);
      if (!Array.isArray(record.pages)) throw new Error('Unreadable chapter pages');
      for (const pg of record.pages) {
        if (isPlainFileName(pg.cleaned)) needed.add(pg.cleaned);
      }
    };
    collect(await fsx.readTextFile(await fsx.join(chapterDir, 'chapter.json')));
    const dir = await folder(chapterDir);
    for (const name of await namesIn(dir)) {
      collect(await fsx.readTextFile(await fsx.join(dir, name)));
    }
    for (const entry of candidates) {
      if (!entry.isFile || !isPlainFileName(entry.name) || needed.has(entry.name)) continue;
      await fsx.remove(await fsx.join(previous, entry.name));
    }
  } catch {
    /* Best-effort: uncertainty keeps the files, never discards their bytes. */
  }
}

export async function listSnapshots(chapterDir) {
  const dir = await folder(chapterDir);
  const snapshots = [];
  for (const name of await namesIn(dir)) {
    try {
      const record = JSON.parse(await fsx.readTextFile(await fsx.join(dir, name)));
      if (!Array.isArray(record.pages)) continue;
      const [, stamp, reason] = NAME.exec(name);
      const at = new Date(stamp.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/,
        '$1-$2-$3T$4:$5:$6.$7Z',
      )).toISOString();
      snapshots.push({
        name,
        at,
        reason,
        pages: record.pages.length,
        boxes: record.pages.reduce((sum, pg) => sum + (pg.boxes?.length ?? 0), 0),
      });
    } catch {
      /* A damaged snapshot does not hide the readable ones beside it. */
    }
  }
  return snapshots;
}
