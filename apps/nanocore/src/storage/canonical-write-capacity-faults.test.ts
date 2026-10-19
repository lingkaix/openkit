import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from './canonical-write-capacity.js';
import { appendCanonicalTextFile, writeFileAtomic } from './workspace-file-records.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    writeSync: vi.fn(actual.writeSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'capacity-fault-'));
  roots.push(root);
  const target = join(root, 'record');
  writeFileSync(target, 'prior\n');
  const admission = new FileStorageAdmission(
    root,
    () => 100n,
    () => 100n + 65536n + 3n
  );
  return { root, target, admission };
}
/** Reuses the retained publication child; the parent owns cleanup of only its new roots. */
function contentProbe(phase: string, root?: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/test-support/pending-publication-crash.ts',
      'artifact-commit',
      phase,
      ...(root ? [root] : []),
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  const lines = result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const retainedRoot = lines[0]?.dataRoot as string | undefined;
  if (!root && retainedRoot) roots.push(retainedRoot);
  return { result, value: lines.at(-1), initial: lines[0], root: retainedRoot };
}

it('publishes no Artifact reference when the process dies before immutable content synchronization', () => {
  const crashed = contentProbe('before-sync');
  expect(crashed.result.status, crashed.result.stderr).toBe(23);
  expect(crashed.value).toMatchObject({
    checkpoint: 'before-content-sync',
    contentSynchronized: false,
  });
  const cold = contentProbe('inspect', crashed.root);
  expect(cold.result.status, cold.result.stderr).toBe(0);
  expect(cold.value.state).toEqual(crashed.initial.before);
}, 90_000);

it('refuses failed content synchronization without exposing a reference or cache candidate', () => {
  const failed = contentProbe('sync-failure');
  expect(failed.result.status, failed.result.stderr).toBe(0);
  expect(failed.value).toMatchObject({
    checkpoint: 'content-sync-failure',
    contentSynchronized: false,
  });
  expect(failed.value.result).toBeUndefined();
  expect(failed.value.failure).toEqual(expect.any(String));
  expect(failed.value.live).toEqual(failed.initial.before);
  expect(failed.value.cold).toEqual(failed.initial.before);
}, 90_000);

it('leaves only unreferenced synchronized content when the process dies before the owning receipt', () => {
  const crashed = contentProbe('before-receipt');
  expect(crashed.result.status, crashed.result.stderr).toBe(23);
  expect(crashed.value).toMatchObject({ checkpoint: 'before-receipt', contentSynchronized: true });
  const cold = contentProbe('inspect', crashed.root);
  expect(cold.result.status, cold.result.stderr).toBe(0);
  expect(cold.value.state).toEqual(crashed.initial.before);
}, 90_000);

it('does not expose an immutable reference or cache candidate after a receipt commit failure', () => {
  const failed = contentProbe('receipt-failure');
  expect(failed.result.status, failed.result.stderr).toBe(0);
  expect(failed.value).toMatchObject({ checkpoint: 'before-receipt', contentSynchronized: true });
  expect(failed.value.result).toBeUndefined();
  expect(failed.value.failure).toEqual(expect.any(String));
  expect.soft(failed.value.live).toEqual(failed.initial.before);
  expect.soft(failed.value.cold).toEqual(failed.initial.before);
}, 90_000);

it('resolves a committed Artifact reference to exact cold bytes after losing its acknowledgement', () => {
  const crashed = contentProbe('after-commit');
  expect(crashed.result.status, crashed.result.stderr).toBe(23);
  expect(crashed.value).toMatchObject({ checkpoint: 'result-ready', contentSynchronized: true });
  expect(crashed.value.failure).toBeUndefined();
  expect(crashed.value.result.artifactVersion).toBe(1);
  const cold = contentProbe('inspect', crashed.root);
  expect(cold.result.status, cold.result.stderr).toBe(0);
  const state = cold.value.state;
  expect(state.artifacts).toHaveLength(crashed.initial.before.artifacts.length + 1);
  expect(state.artifacts).toContainEqual({
    id: crashed.value.result.artifactId,
    version: 1,
    contentDigest: `sha256:${createHash('sha256').update(Buffer.from('00ff800d0a', 'hex')).digest('hex')}`,
  });
  expect(state.payload.hex).toBe('00ff800d0a');
  expect(state.receipts).toEqual([
    expect.objectContaining({
      response_kind: 'artifact',
      response_id: crashed.value.result.artifactId,
    }),
  ]);
  const replay = contentProbe('replay', crashed.root);
  expect(replay.result.status, replay.result.stderr).toBe(0);
  expect(replay.value.result).toEqual(crashed.value.result);
  expect(replay.value.cold).toEqual(state);
}, 90_000);

const writes = { stagingBytes: 3n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n };
it('releases a refused temporary write only after actual cleanup is proved', () => {
  const f = fixture();
  vi.mocked(writeFileSync).mockImplementationOnce(() => {
    throw new Error('Synthetic write failure.');
  });
  expect(() =>
    withCanonicalFileWriteAdmission(f.admission, () => writeFileAtomic(f.target, 'new'))
  ).toThrow('Synthetic write failure.');
  expect(readFileSync(f.target, 'utf8')).toBe('prior\n');
  expect(readdirSync(f.root)).toEqual(['record']);
  const reservation = f.admission.reserve(writes);
  reservation.release();
});
it('retains capacity after denied temporary cleanup and preserves the prior record', () => {
  const f = fixture();
  vi.mocked(writeFileSync).mockImplementationOnce(() => {
    throw new Error('Synthetic write failure.');
  });
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw new Error('Synthetic cleanup failure.');
  });
  expect(() =>
    withCanonicalFileWriteAdmission(f.admission, () => writeFileAtomic(f.target, 'new'))
  ).toThrow('Synthetic cleanup failure.');
  expect(readFileSync(f.target, 'utf8')).toBe('prior\n');
  expect(readdirSync(f.root).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
  expect(() => f.admission.reserve(writes)).toThrow('capacity');
});
it('retains an incomplete append and its unused capacity under the existing recovery owner', () => {
  const f = fixture();
  const actual = vi.mocked(writeSync).getMockImplementation()!;
  // The first real short write is injected at the descriptor crossing, then the next write fails.
  vi.mocked(writeSync)
    .mockImplementationOnce(((fd: number, bytes: Uint8Array, offset: number) =>
      actual(fd, bytes, offset, 1)) as typeof writeSync)
    .mockImplementationOnce(() => {
      throw new Error('Synthetic append failure.');
    });
  expect(() =>
    withCanonicalFileWriteAdmission(f.admission, () => appendCanonicalTextFile(f.target, 'new'))
  ).toThrow('Synthetic append failure.');
  expect(readFileSync(f.target, 'utf8')).toBe('prior\nn');
  expect(() => f.admission.reserve(writes)).toThrow('capacity');
});
