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
