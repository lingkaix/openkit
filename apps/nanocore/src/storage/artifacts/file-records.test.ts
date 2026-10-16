// openkit-test-platform: posix
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { allocateEntityId, type ArtifactSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { publishArtifactFileRecord } from '../workspace-file-records.js';
import { FileStorageAdmission } from './file-admission.js';
import { stageArtifactPayload } from './file-payload.js';
import {
  artifactFilePayloadPath,
  readArtifactFilePayload,
  readArtifactFileText,
  verifyArtifactFilePayload,
} from './file-records.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Publishes a small exact original through the real stream and canonical durability owners. */
async function fixture(bytes = Buffer.from('00ffc328800a', 'hex')) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-file-record-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const workspaceRoot = join(root, 'workspaces', workspaceId);
  await mkdir(workspaceRoot, { recursive: true });
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const admission = new FileStorageAdmission(root, () => 0n);
  const reservation = admission.reserve({
    stagingBytes: 12n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 12n,
  });
  const staged = await stageArtifactPayload({
    workspaceRoot,
    reservation,
    source: Readable.from([bytes]),
    expectedByteLength: bytes.length,
    expectedDigest: contentDigest,
  });
  const identity = { workspaceRoot, artifactId: allocateEntityId('ar'), version: 1 };
  const artifact: z.infer<typeof ArtifactSchema> = {
    id: identity.artifactId,
    workspaceId,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Exact file',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'file', mediaType: 'application/octet-stream', byteLength: bytes.length },
    contentDigest,
    lastMutationRequestId: 'import',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'import',
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: 'import',
      recordedAt: '2026-10-16T00:00:00.000Z',
    },
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
  };
  publishArtifactFileRecord({ workspaceRoot, artifact, payloadPath: staged.path });
  await staged.remove();
  reservation.release();
  return { ...identity, artifact, bytes, byteLength: bytes.length, contentDigest };
}

describe('immutable Artifact payload files', () => {
  it('preserves exact UTF-8 and BOM bytes in a complete bounded text representation', async () => {
    const state = await fixture(Buffer.from('\uFEFF界\n', 'utf8'));
    const text = readArtifactFileText({ ...state, maximumBytes: state.byteLength });
    expect(text).toBe('\uFEFF界\n');
    expect(Buffer.from(text!, 'utf8')).toEqual(state.bytes);
    expect(readArtifactFileText({ ...state, maximumBytes: state.byteLength - 1 })).toBeNull();
  });
  it('does not replace invalid original bytes with lossy editable text', async () => {
    const state = await fixture();
    expect(readArtifactFileText({ ...state, maximumBytes: 2048 })).toBeNull();
    expect(() => readArtifactFileText({ ...state, maximumBytes: 16_777_217 })).toThrow(
      'processor limit'
    );
    expect(
      await readFile(artifactFilePayloadPath(state.workspaceRoot, state.artifactId, state.version))
    ).toEqual(state.bytes);
  });

  it('streams exactly the published original and refuses a second writer', async () => {
    const state = await fixture();
    const chunks: Buffer[] = [];
    for await (const chunk of readArtifactFilePayload(state)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(state.bytes);
    expect(() => verifyArtifactFilePayload(state)).not.toThrow();
    expect(() =>
      publishArtifactFileRecord({
        workspaceRoot: state.workspaceRoot,
        artifact: state.artifact,
        payloadPath: 'unused',
      })
    ).toThrow('already exists');
    expect(
      await readFile(artifactFilePayloadPath(state.workspaceRoot, state.artifactId, 1))
    ).toEqual(state.bytes);
  });

  it('refuses corrupt bytes before returning a readable stream', async () => {
    const state = await fixture();
    await writeFile(
      artifactFilePayloadPath(state.workspaceRoot, state.artifactId, 1),
      Buffer.alloc(6)
    );
    expect(() => readArtifactFilePayload(state)).toThrow('integrity');
  });

  it('refuses a missing version instead of substituting another version', async () => {
    const state = await fixture();
    expect(() => readArtifactFilePayload({ ...state, version: 2 })).toThrow();
  });

  it('refuses a symbolic-link leaf before exposing any bytes', async () => {
    const state = await fixture();
    const path = artifactFilePayloadPath(state.workspaceRoot, state.artifactId, 1);
    const outside = join(state.workspaceRoot, 'outside');
    await writeFile(outside, state.bytes);
    await rm(path);
    await symlink(outside, path);
    expect(() => readArtifactFilePayload(state)).toThrow();
  });

  it('refuses a FIFO without waiting for a writer', async () => {
    const state = await fixture();
    const path = artifactFilePayloadPath(state.workspaceRoot, state.artifactId, 1);
    await rm(path);
    expect(spawnSync('mkfifo', [path], { timeout: 2000 }).status).toBe(0);
    // A separate process makes a blocking-open regression bounded and observable.
    const source = fileURLToPath(new URL('./file-records.ts', import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import {readArtifactFilePayload} from ${JSON.stringify(source)};
       try{readArtifactFilePayload(${JSON.stringify(state)});process.exit(1);}catch{process.exit(0);}`,
      ],
      { timeout: 5000, stdio: 'pipe' }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });

  it.each([
    '../escape',
    'a/b',
    'a\\b',
    '.',
    '..',
    '\0',
  ])('refuses unsafe Artifact path input %j', (id) => {
    expect(() => artifactFilePayloadPath('/root', id, 1)).toThrow('identity');
  });
});
