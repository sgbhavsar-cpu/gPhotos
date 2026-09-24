import { describe, it, expect } from 'vitest';
import { splitStoragesByExistence } from '../../src/renderer/src/services/storageValidation';

const storage = (name: string) =>
  ({ id: name, name, localMirrorRoot: 'C:\\M', networkSourcePath: 'X', lastSynced: '2026-01-01', totalItems: 5 }) as any;

describe('splitStoragesByExistence', () => {
  it('does not prune a storage whose first check was a transient false (re-checks before believing it)', async () => {
    const calls: Record<string, number> = {};
    const flaky = async (p: string) => { calls[p] = (calls[p] || 0) + 1; return calls[p] > 1; }; // false once, then true
    const { valid, removed } = await splitStoragesByExistence([storage('A')], flaky);
    expect(valid.map((s) => s.name)).toEqual(['A']);
    expect(removed).toEqual([]);
  }, 10000);

  it('still prunes a storage whose folder is really gone (false both times)', async () => {
    const { valid, removed } = await splitStoragesByExistence([storage('A'), storage('B')], async (p) => !p.endsWith('\\B'));
    expect(valid.map((s) => s.name)).toEqual(['A']);
    expect(removed.map((s) => s.name)).toEqual(['B']);
  }, 10000);

  it('never prunes a storage that has never synced', async () => {
    const fresh = { ...storage('N'), lastSynced: undefined, totalItems: 0 };
    const { valid } = await splitStoragesByExistence([fresh], async () => false);
    expect(valid).toHaveLength(1);
  });
});
