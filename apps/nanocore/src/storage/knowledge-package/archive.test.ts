// openkit-test-platform: posix
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorageAdmission } from '../artifacts/file-admission.js';
import { createKnowledgePackageStaging, stageKnowledgePackage } from './archive.js';

const payload = Buffer.from([0, 255, 13, 10, 65, 128]);
let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'openkit-knowledge-package-archive-'));
  await writeFile(join(parent, 'original.bin'), payload);
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

/** Encodes actual tar members; Request supplies the real extraction byte stream. */
async function archiveRequest(
  entries: { name: string; bytes?: Buffer; type?: 'directory' | 'symlink'; linkname?: string }[]
): Promise<Request> {
  const archive = pack();
  for (const { bytes, ...header } of entries) archive.entry(header, bytes ?? Buffer.alloc(0));
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return new Request('http://localhost/package', {
    method: 'POST',
    headers: { 'content-type': 'application/x-tar' },
    body: new Uint8Array(Buffer.concat(chunks)),
  });
}

describe('Knowledge package request-private trees', () => {
  it('stages exact tar bytes privately and removes the caller-owned tree', async () => {
    const dataRoot = join(parent, 'data');
    const staging = await createKnowledgePackageStaging(dataRoot);
    const member = join(staging.root, 'raw/nested/original.bin');
    try {
      expect(dirname(staging.root)).toBe(join(dataRoot, 'server/files/workspace-archive-requests'));
      await stageKnowledgePackage(
        await archiveRequest([
          { name: 'raw/empty/', type: 'directory' },
          { name: 'raw/nested/original.bin', bytes: await readFile(join(parent, 'original.bin')) },
        ]),
        staging.root,
        new FileStorageAdmission(staging.root, () => 0n)
      );
      expect(await readFile(member)).toEqual(payload);
      for (const path of [
        dirname(staging.root),
        staging.root,
        join(staging.root, 'raw/empty'),
        dirname(member),
      ])
        expect((await stat(path)).mode & 0o777).toBe(0o700);
    } finally {
      await staging.remove();
    }
    for (const path of [dirname(member), staging.root])
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(parent, 'original.bin'))).toEqual(payload);
    await staging.remove();
    expect(await readdir(dirname(staging.root))).toEqual([]);
    expect(await readdir(dataRoot)).toEqual(['server']);
  });

  it('refuses tar links and preserves the source after caller cleanup', async () => {
    const dataRoot = join(parent, 'data');
    const staging = await createKnowledgePackageStaging(dataRoot);
    const member = join(staging.root, 'raw/nested/original.bin');
    try {
      await expect(
        stageKnowledgePackage(
          await archiveRequest([
            { name: 'raw/nested/original.bin', bytes: payload },
            {
              name: 'raw/nested/link.bin',
              type: 'symlink',
              linkname: join(parent, 'original.bin'),
            },
          ]),
          staging.root,
          new FileStorageAdmission(staging.root, () => 0n)
        )
      ).rejects.toThrow();
      expect(await readFile(member)).toEqual(payload);
      await expect(lstat(join(staging.root, 'raw/nested/link.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await staging.remove();
    }
    for (const path of [dirname(member), staging.root])
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(parent, 'original.bin'))).toEqual(payload);
    expect(await readdir(dataRoot)).toEqual(['server']);
  });
});
