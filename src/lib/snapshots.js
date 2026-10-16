// Earlier chapter.json bytes, never a reconstruction from the editor's state.
// The record's own timestamp identifies a version, so reopening an unchanged
// chapter cannot fill the shelf with twenty copies of the same document.
import { fsx } from './fsx.js';

const NAME = /^(\d{8}T\d{9}Z)--([a-z-]+)\.json(?![\s\S])/;
const now = () => new Date().toISOString();

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
  const stamp = stampOf(record);
  const dir = await folder(chapterDir);
  const names = await namesIn(dir);
  if (names.some((name) => name.startsWith(`${stamp}--`))) return null;
  await fsx.mkdir(dir);
  const name = `${stamp}--${reason}.json`;
  await fsx.writeTextFileAtomic(await fsx.join(dir, name), text);
  // Only our own file names are pruned. A stray file in logs is still the
  // user's, and a failed prune must reach restore's caller just like a failed
  // snapshot write: before-restore is the one snapshot we may not give up.
  const newest = [...names, name].sort().reverse();
  for (const old of newest.slice(20)) await fsx.remove(await fsx.join(dir, old));
  return name;
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
