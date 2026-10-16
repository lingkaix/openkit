// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FileByteAdmission, FileStorageAdmission } from './file-admission.js';
import { stageArtifactPayload } from './file-payload.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Builds one isolated real filesystem, without a Store or product acceptance stand-in. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-payload-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspaces', 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const admission = new FileStorageAdmission(root, () => 0n);
  const reservation = admission.reserve({
    stagingBytes: 1_000_000n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 1_000_000n,
  });
  return { root, workspaceRoot, reservation };
}

/** Identity over original bytes, independent of the staging implementation. */
function digest(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('private streamed Artifact payloads', () => {
  it.each([
    [
      'empty',
      Buffer.alloc(0),
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ],
    [
      'binary',
      Buffer.from('00ffc328800a', 'hex'),
      'sha256:39948221138e963424a7cdbd1659e745f52303800b3954b845a13ca723c0133e',
    ],
  ])('retains the exact frozen %s original without decoding', async (_name, bytes, sha256) => {
    const state = await fixture();
    const staged = await stageArtifactPayload({
      ...state,
      source: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      expectedByteLength: bytes.length,
      expectedDigest: sha256,
    });
    expect(await readFile(staged.path)).toEqual(bytes);
    expect(staged.byteLength).toBe(bytes.length);
    expect(staged.contentDigest).toBe(sha256);
    await staged.remove();
    state.reservation.release();
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
  });

  it.each([
    'short',
    'long',
    'digest',
  ])('refuses %s metadata and removes incomplete private staging', async (fault) => {
    const state = await fixture();
    const bytes = Buffer.from('actual file');
    await expect(
      stageArtifactPayload({
        ...state,
        source: Readable.from([bytes]),
        expectedByteLength: bytes.length + (fault === 'short' ? 1 : fault === 'long' ? -1 : 0),
        expectedDigest: digest(fault === 'digest' ? Buffer.from('changed file') : bytes),
      })
    ).rejects.toThrow('file byte');
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
    state.reservation.release();
  });

  it('counts separate file streams against the same submission limit before writing', async () => {
    const state = await fixture();
    const submission = new FileByteAdmission();
    submission.consume(999_999_999);
    await expect(
      stageArtifactPayload({
        ...state,
        source: Readable.from([Buffer.from('xx')]),
        expectedByteLength: 2,
        expectedDigest: digest(Buffer.from('xx')),
        submission,
      })
    ).rejects.toThrow('byte limit');
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
    state.reservation.release();
  });

  it('aborts a live stream and removes partial bytes', async () => {
    const state = await fixture();
    const controller = new AbortController();
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(65_536));
      },
    });
    const capture = stageArtifactPayload({
      ...state,
      source,
      expectedByteLength: 1_000_000,
      expectedDigest: digest(Buffer.alloc(0)),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(capture).rejects.toThrow();
    expect(source.destroyed).toBe(true);
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
    state.reservation.release();
  });

  it('refuses a symbolic-link staging root without writing to its target', async () => {
    const state = await fixture();
    const outside = join(state.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(state.root, 'workspaces', '.staging'));
    await expect(
      stageArtifactPayload({
        ...state,
        source: Readable.from([]),
        expectedByteLength: 0,
        expectedDigest: digest(Buffer.alloc(0)),
      })
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    state.reservation.release();
  });
});
