import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { importArtifactFile } from './artifact-file-commands.js';
import { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from './storage/artifacts/file-records.js';
import { openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

const roots: string[] = [],
  databases: WorkspaceDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Domain admission is explicit; capture, canonical bytes, command concurrency and receipts are real. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-file-command-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot }),
    workspace = store.createWorkspace('File authority');
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(workspaceDb);
  applyScopedMigrations(workspaceDb);
  const admission = new FileStorageAdmission(dataRoot, () => 0n);
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const bytes = Buffer.from([0, 255, 128, 13, 10]),
    requestId = randomUUID();
  const metadata = {
    workspaceId: workspace.id,
    requestId,
    title: 'Original',
    mediaType: 'application/octet-stream',
    byteLength: bytes.length,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const submit = (actorId: string, source = Readable.from([bytes]), assertAuthorized = () => {}) =>
    importArtifactFile({
      store,
      workspaceDb,
      admission,
      inflightCommands,
      metadata,
      source,
      assertAuthorized,
      context: {
        kind: 'public',
        actor: { kind: 'session', userId: actorId },
        actorRef: { kind: 'user', id: actorId },
        scope: { kind: 'workspace', workspaceId: workspace.id },
      },
    });
  const read = (id: string) =>
    readFileSync(artifactFilePayloadPath(join(dataRoot, 'workspaces', workspace.id), id, 1));
  return { store, workspaceDb, metadata, bytes, submit, read };
}

it('namespaces the same request by actor, including concurrent callers with equal input', async () => {
  const f = fixture(),
    alice = allocateEntityId('usr'),
    bob = allocateEntityId('usr');
  const [a, b] = await Promise.all([f.submit(alice), f.submit(bob)]);
  expect(a.artifactId).not.toBe(b.artifactId);
  expect(f.read(a.artifactId)).toEqual(f.bytes);
  expect(f.read(b.artifactId)).toEqual(f.bytes);
  expect(f.store.getArtifact(f.metadata.workspaceId, a.artifactId).origin).toMatchObject({
    actor: { id: alice },
  });
  expect(f.store.getArtifact(f.metadata.workspaceId, b.artifactId).origin).toMatchObject({
    actor: { id: bob },
  });
  expect(f.store.listCommandRequests()).toHaveLength(2);
});
it('does not read changed retry bytes after an exact actor-owned receipt', async () => {
  const f = fixture(),
    actor = allocateEntityId('usr'),
    accepted = await f.submit(actor);
  const read = vi.fn();
  const source = new Readable({
    read() {
      read();
      this.push(Buffer.from('changed'));
      this.push(null);
    },
  });
  expect(await f.submit(actor, source)).toEqual(accepted);
  expect(read).not.toHaveBeenCalled();
  expect(f.read(accepted.artifactId)).toEqual(f.bytes);
});
it('rechecks revocation after streamed staging and permits an explicit corrected request', async () => {
  const f = fixture(),
    actor = allocateEntityId('usr');
  let authorized = true;
  const source = Readable.from(
    (async function* () {
      yield f.bytes;
      authorized = false;
    })()
  );
  const assertAuthorized = () => {
    if (!authorized)
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  };
  await expect(f.submit(actor, source, assertAuthorized)).rejects.toMatchObject({
    code: 'workspace_access_denied',
  });
  expect(f.store.listArtifacts(f.metadata.workspaceId)).toHaveLength(0);
  expect(f.store.listCommandRequests()).toHaveLength(0);
  authorized = true;
  expect((await f.submit(actor, Readable.from([f.bytes]), assertAuthorized)).artifactVersion).toBe(
    1
  );
});
it('retains an unacknowledged canonical tuple after receipt failure and refuses recapture as recovery_required', async () => {
  const f = fixture(),
    actor = allocateEntityId('usr');
  const failure = vi.spyOn(f.store, 'recordCommandRequest').mockImplementation(() => {
    throw new Error('Synthetic receipt failure.');
  });
  await expect(f.submit(actor)).rejects.toThrow('Synthetic receipt failure.');
  failure.mockRestore();
  expect(f.store.listArtifacts(f.metadata.workspaceId)).toHaveLength(1);
  expect(f.store.listCommandRequests()).toHaveLength(0);
  const read = vi.fn();
  const source = new Readable({
    read() {
      read();
      this.push(null);
    },
  });
  await expect(f.submit(actor, source)).rejects.toMatchObject({ code: 'recovery_required' });
  expect(read).not.toHaveBeenCalled();
});
