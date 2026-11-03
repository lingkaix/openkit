// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yauzl';
import { testEntityId } from '../../test-support/entity-ids.js';
import {
  ensureArtifactFolderSnapshot,
  readArtifactFolderSnapshot,
} from './artifact-folder-cache.js';
import { FileStorageAdmission } from './file-admission.js';
import { artifactFilePayloadPath } from './file-records.js';
import { MAX_ZIP_EXPANDED_BYTES } from './zip-snapshot.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../../tests/fixtures/large-context/cases.json', import.meta.url),
    'utf8'
  )
) as { archives: Array<{ id: string; base64: string }> };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(rm).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates an exact retained original independently from the folder cache subject. */
async function original(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-folder-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspaces', 'workspace');
  const bytes = Buffer.from(corpus.archives.find((entry) => entry.id === id)!.base64, 'base64');
  const source = {
    workspaceRoot,
    artifactId: testEntityId('ar', 'zip-cache-source'),
    artifactVersion: 1,
    byteLength: bytes.length,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const path = artifactFilePayloadPath(workspaceRoot, source.artifactId, 1);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return {
    source,
    path,
    bytes,
    admission: new FileStorageAdmission(
      root,
      () => 0n,
      () => 20_000_000_000n
    ),
    assertAuthorized: () => {},
  };
}

describe('source-version ZIP folder cache', () => {
  it('publishes only a complete verified inventory and reuses it after reopening', async () => {
    const state = await original('valid-file');
    expect(await readArtifactFolderSnapshot(state)).toBeNull();
    const result = await ensureArtifactFolderSnapshot(state);
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(await readFile(join(result.root, file.relativePath))).toEqual(Buffer.from('123456789'));
    expect(await readFile(state.path)).toEqual(state.bytes);
    const reused = await readArtifactFolderSnapshot(state);
    expect(reused?.files).toEqual(result.files);
    expect(reused?.root).toBe(result.root);
    expect(await readdir(join(dirname(state.source.workspaceRoot), '.staging'))).toEqual([]);
  });

  it('refuses a corrupt cache and rebuilds without changing the original', async () => {
    const state = await original('valid-file');
    const first = await ensureArtifactFolderSnapshot(state);
    await writeFile(join(first.root, first.files[0]!.relativePath), 'changed');
    expect(await readArtifactFolderSnapshot(state)).toBeNull();
    const rebuilt = await ensureArtifactFolderSnapshot(state);
    expect(rebuilt.files).toEqual(first.files);
    expect(await readFile(state.path)).toEqual(state.bytes);
  });

  it('refuses an unlisted symlink and rebuilds only inside the source cache', async () => {
    const state = await original('valid-file');
    const first = await ensureArtifactFolderSnapshot(state);
    await symlink(state.path, join(first.root, 'unlisted-link'));
    expect(await readArtifactFolderSnapshot(state)).toBeNull();
    const rebuilt = await ensureArtifactFolderSnapshot(state);
    expect(await readdir(rebuilt.root)).toEqual(['note.txt']);
    expect(await readFile(state.path)).toEqual(state.bytes);
  });

  it('shares one extraction between concurrent callers that fit one capacity forecast', async () => {
    const state = await original('valid-file');
    // One build reserves staging 0 + extraction (the expanded-byte bound)
    // + derivative (the 32 MiB inventory bound plus 1 GiB of filesystem
    // overhead) + publication 0. This admission admits exactly one such
    // forecast, so a second concurrent extraction is refused by capacity.
    const oneForecastBytes =
      BigInt(MAX_ZIP_EXPANDED_BYTES) + 32n * 1024n * 1024n + 1024n * 1024n * 1024n;
    state.admission = new FileStorageAdmission(
      state.source.workspaceRoot,
      () => 0n,
      () => oneForecastBytes
    );
    const [first, second] = await Promise.all([
      ensureArtifactFolderSnapshot(state),
      ensureArtifactFolderSnapshot(state),
    ]);
    expect(second.files).toEqual(first.files);
    expect(second.directories).toEqual(first.directories);
    expect(second.representationDigest).toBe(first.representationDigest);
    const firstBytes = await Promise.all(
      first.files.map((entry) => readFile(join(first.root, entry.relativePath)))
    );
    const secondBytes = await Promise.all(
      second.files.map((entry) => readFile(join(second.root, entry.relativePath)))
    );
    expect(secondBytes).toEqual(firstBytes);
    expect(await readFile(state.path)).toEqual(state.bytes);
    expect(await readdir(join(dirname(state.source.workspaceRoot), '.staging'))).toEqual([]);
    expect(() => {
      state.admission
        .reserve({
          stagingBytes: 1n,
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: 0n,
        })
        .release();
    }).not.toThrow();
  });

  it('keeps reserved capacity when failed extraction cleanup is unproved', async () => {
    const state = await original('valid-file');
    state.admission = new FileStorageAdmission(
      state.source.workspaceRoot,
      () => 0n,
      () => 6_000_000_000n
    );
    let authorized = true;
    const actual = ZipFile.prototype.openReadStreamPromise;
    vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementationOnce(
      async function (entry, options) {
        const stream = await actual.call(this, entry, options);
        authorized = false;
        return stream;
      }
    );
    vi.mocked(rm).mockRejectedValue(new Error('Synthetic cleanup refusal.'));
    await expect(
      ensureArtifactFolderSnapshot({
        ...state,
        assertAuthorized: () => {
          if (!authorized) throw new Error('revoked');
        },
      })
    ).rejects.toThrow('requires cleanup');
    expect(() =>
      state.admission.reserve({
        stagingBytes: 1_000_000_000n,
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: 0n,
      })
    ).toThrow('Storage capacity is unavailable');
    expect(await readFile(state.path)).toEqual(state.bytes);
  });

  it('refuses a changed original even when a valid-looking folder remains', async () => {
    const state = await original('valid-file');
    await ensureArtifactFolderSnapshot(state);
    await writeFile(state.path, Buffer.alloc(state.bytes.length));
    await expect(readArtifactFolderSnapshot(state)).rejects.toThrow();
    await expect(ensureArtifactFolderSnapshot(state)).rejects.toThrow();
  });

  it('retains the exact original on hostile archive failure with no partial cache', async () => {
    const state = await original('traversal');
    await expect(ensureArtifactFolderSnapshot(state)).rejects.toThrow();
    expect(await readFile(state.path)).toEqual(state.bytes);
    expect(await readArtifactFolderSnapshot(state)).toBeNull();
    expect(await readdir(join(dirname(state.source.workspaceRoot), '.staging'))).toEqual([]);
  });

  it('rechecks authority after extraction and never exposes a revoked snapshot', async () => {
    const state = await original('valid-file');
    let authorized = true;
    const actual = ZipFile.prototype.openReadStreamPromise;
    vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementationOnce(
      async function (entry, options) {
        const stream = await actual.call(this, entry, options);
        authorized = false;
        return stream;
      }
    );
    await expect(
      ensureArtifactFolderSnapshot({
        ...state,
        assertAuthorized: () => {
          if (!authorized) throw new Error('revoked');
        },
      })
    ).rejects.toThrow('revoked');
    expect(await readArtifactFolderSnapshot(state)).toBeNull();
    expect(await readFile(state.path)).toEqual(state.bytes);
  });
});
