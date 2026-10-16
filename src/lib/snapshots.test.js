import { describe, it, expect } from 'vitest';
import { isSnapshotName } from './snapshots.js';

describe('isSnapshotName', () => {
  it('refuses traversal and names outside the snapshot shape', () => {
    for (const name of ['../x', 'a/b', 'x.json']) expect(isSnapshotName(name)).toBe(false);
  });
});
