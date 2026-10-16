// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { turnFilePayloadPath } from '../storage/workspace-file-records.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID } from '../test-support/local-user.js';
import { prepareTurnFileSourceInputs } from './turn-source-files.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Publishes real canonical Turn inputs; source names never choose a payload path. */
function fixture(body: Buffer, mediaType = 'text/plain') {
  const root = mkdtempSync(join(tmpdir(), 'turn-source-files-'));
  roots.push(root);
  const store = createDemoStore({ dataRoot: root });
  const workspace = store.listWorkspaces().find((candidate) => candidate.kind === 'code')!;
  const thread = store.createThread(workspace.id, 'Original source view');
  const source = join(root, 'original');
  writeFileSync(source, body);
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Inspect the selected original',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      fileInputs: [
        {
          name: '../../display-name',
          mediaType,
          sizeBytes: body.length,
          contentDigest: sha256(body),
        },
      ],
      filePayloadPaths: [source],
      fileWriteAdmission: new FileStorageAdmission(root, () => 0n),
    }
  );
  const workspaceRoot = join(root, 'workspaces', workspace.id);
  let allowed = true;
  const input = {
    workspaceRoot,
    turn,
    assertCurrent: () => {
      if (!allowed) throw new Error('Current source access was revoked.');
    },
  };
  return {
    input,
    body,
    path: turnFilePayloadPath(workspaceRoot, thread.id, turn.id, 0),
    root,
    revoke: () => {
      allowed = false;
    },
  };
}

it('keeps exact original identity and emits only the bounded UTF-8 preview', async () => {
  const state = fixture(Buffer.from('漢字'.repeat(40_000)));
  const [source] = await prepareTurnFileSourceInputs(state.input);
  expect(source!.source).toEqual({
    kind: 'turn-input',
    reference: {
      scopeId: `input/turn/${state.input.turn.workspaceId}/${state.input.turn.threadId}/${state.input.turn.id}`,
      objectId: '0',
    },
  });
  expect(source!.deliveredBytes.length).toBeLessThanOrEqual(2048);
  const delivered = new TextDecoder('utf-8', { fatal: true }).decode(source!.deliveredBytes);
  expect(delivered).toBe('漢字'.repeat(40_000).slice(0, delivered.length));
  expect(source!.projection).toMatchObject({
    kind: 'excerpt',
    representationDigest: sha256(state.body),
    representationByteLength: state.body.length,
    deliveredDigest: sha256(source!.deliveredBytes),
    truncated: true,
    availability: 'incomplete',
  });
  expect(source!.originalSnapshotPath).toBe('originals/turn-inputs/0/payload');
  expect(source!.packagePath).toBe('sources/turn-inputs/0.txt');
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of source!.open(new AbortController().signal)) {
    expect(chunk.length).toBeLessThanOrEqual(65_536);
    count += chunk.length;
    hash.update(chunk);
  }
  expect(count).toBe(state.body.length);
  expect(`sha256:${hash.digest('hex')}`).toBe(sha256(state.body));
});

it.each([
  Buffer.alloc(0),
  Buffer.from('\ufeffexact\r\noriginal\n'),
])('preserves exact small UTF-8 bytes including empty and BOM inputs', async (body) => {
  const state = fixture(body);
  const [source] = await prepareTurnFileSourceInputs(state.input);
  expect(Buffer.from(source!.deliveredBytes)).toEqual(body);
  expect(source!.projection).toMatchObject({
    kind: 'body',
    truncated: false,
    availability: 'available',
  });
});

it.each([
  'application/octet-stream',
  'text/plain',
])('uses a truthful descriptor for binary originals declared as %s', async (mediaType) => {
  const state = fixture(Buffer.from([0xff, 0x80, 0]), mediaType);
  const [source] = await prepareTurnFileSourceInputs(state.input);
  expect(source!.projection).toMatchObject({
    kind: 'descriptor',
    truncated: true,
    availability: 'unavailable',
    ranges: [],
  });
  const descriptor = JSON.parse(Buffer.from(source!.deliveredBytes).toString('utf8'));
  expect(descriptor).toMatchObject({
    status: 'unavailable',
    reason: mediaType === 'text/plain' ? 'invalid_utf8' : 'unsupported',
    originalDigest: sha256(state.body),
    byteLength: 3,
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of source!.open(new AbortController().signal)) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(state.body);
});

it('rechecks current authority before reopening an admitted source', async () => {
  const state = fixture(Buffer.from('original'));
  const [source] = await prepareTurnFileSourceInputs(state.input);
  state.revoke();
  await expect(source!.assertUnchanged()).rejects.toThrow(/revoked/);
  await expect(
    (async () => {
      for await (const _chunk of source!.open(new AbortController().signal)) {
        /* No bytes. */
      }
    })()
  ).rejects.toThrow(/revoked/);
});

it.each([
  'replacement',
  'symlink',
  'hardlink',
  'corrupt',
] as const)('refuses a %s original without a substitute body', async (kind) => {
  const state = fixture(Buffer.from('original'));
  const [source] = await prepareTurnFileSourceInputs(state.input);
  if (kind === 'hardlink') linkSync(state.path, join(state.root, 'other-owner'));
  else if (kind === 'corrupt') writeFileSync(state.path, 'changed!');
  else {
    rmSync(state.path);
    if (kind === 'symlink') symlinkSync(join(state.root, 'original'), state.path);
    else writeFileSync(state.path, state.body);
  }
  await expect(source!.assertUnchanged()).rejects.toThrow();
  await expect(
    (async () => {
      for await (const _chunk of source!.open(new AbortController().signal)) {
        /* No substitute bytes. */
      }
    })()
  ).rejects.toThrow();
});

it('closes a large source iterator when cancellation wins between chunks', async () => {
  const state = fixture(Buffer.alloc(256_000, 120));
  const [source] = await prepareTurnFileSourceInputs(state.input);
  const controller = new AbortController();
  const iterator = source!.open(controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value!.byteLength).toBe(65_536);
  controller.abort();
  await expect(iterator.next()).rejects.toThrow();
  // A fresh operation can still inspect the unchanged source; cancellation owns no authority mutation.
  await expect(source!.assertUnchanged()).resolves.toBeUndefined();
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
