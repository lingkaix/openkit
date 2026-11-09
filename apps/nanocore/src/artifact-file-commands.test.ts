// openkit-test-platform: posix
// The contract inventories preserve raw symbolic-link targets under the POSIX contract.
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type ActorRef, allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitArtifactVersionCommand, importArtifactFile } from './artifact-file-commands.js';
import { scopeAdmissionFailures } from './bootstrap/readiness.js';
import type { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from './storage/artifacts/file-records.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { createTestStore } from './test-support/store.js';

describe('artifact file command contract', () => {
  const roots: string[] = [];
  const databases: WorkspaceDb[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Hashes caller bytes independently of the publication path. */
  function digest(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }

  /** The original SQL error and its safe native projection both prove a refused receipt INSERT. */
  function receiptSqlFailed(error: unknown): boolean {
    return error instanceof ControlStoreWorkerError
      ? error.code === 'sql-failed' && error.commit === 'not-committed'
      : error instanceof Error && 'code' in error && error.code === 'SQLITE_ERROR';
  }

  /** A retry source whose consumption is directly observable on the caller-owned stream. */
  function observableSource(bytes: Buffer) {
    let consumed = false;
    return {
      consumed: () => consumed,
      source: new Readable({
        read() {
          consumed = true;
          this.push(bytes);
          this.push(null);
        },
      }),
    };
  }

  /** Records paths, link targets and retained bytes, including deleted or added entries. */
  function snapshotTree(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else if (entry.isFile() && key === join('db', 'workspace.sqlite-shm')) {
          // SQLite's WAL-index is transient; canonical records and content are owned by storage.
          entries[key] = 'sqlite-wal-index';
        } else {
          entries[key] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  /**
   * Reopens a faulty root under a fresh admission and proves that only its Workspace is refused.
   *
   * Seeds a healthy sibling, copies exact authority into an independent root, then checks refusal,
   * preserved inventories on both source and copy, and durable sibling progress after reopen.
   */
  async function expectQuarantinedWorkspace(dataRoot: string, workspaceId: string) {
    const restartRoot = mkdtempSync(join(tmpdir(), 'artifact-contract-quarantine-'));
    roots.push(restartRoot);
    const seed = createTestStore({ dataRoot: restartRoot });
    const sibling = await seed.createWorkspace('Healthy sibling');
    const siblingThread = await seed.createThread(sibling.id, 'Retained sibling thread');
    const siblingRecord = seed.getWorkspace(sibling.id);
    await shutdownControlStoreWorkerClient();
    cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

    const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
    const before = snapshotTree(refusedRoot);
    const reopened = createTestStore({ dataRoot: restartRoot });
    expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
      expect.objectContaining({ scope: 'workspace', id: workspaceId })
    );
    expect(() => reopened.getWorkspace(workspaceId)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    await expect(reopened.createThread(workspaceId, 'Must remain refused')).rejects.toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(reopened.getWorkspace(sibling.id)).toEqual(siblingRecord);
    expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
    const progress = await reopened.createThread(sibling.id, 'Healthy sibling progress');
    expect(createTestStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
      progress
    );
    expect(snapshotTree(refusedRoot)).toEqual(before);
    expect(snapshotTree(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  }

  /** Real exact-byte storage, receipts, admission, and independent state for each case. */
  async function contractFixture() {
    const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-contract-'));
    roots.push(dataRoot);
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Contract workspace');
    const thread = await store.createThread(workspace.id, 'Contract thread');
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    databases.push(db);
    const admission = new FileStorageAdmission(dataRoot, () => 0n);
    const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
    const actor = allocateEntityId('usr');
    const context = {
      kind: 'public' as const,
      actor: { kind: 'session' as const, userId: actor },
      actorRef: { kind: 'user' as const, id: actor },
      scope: { kind: 'thread' as const, workspaceId: workspace.id, threadId: thread.id },
    };
    const original = Buffer.from([0, 255, 128, 13, 10]);
    const next = Buffer.from([255, 0, 128, 10, 13, 0]);
    const importMetadata = {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      title: 'Contract original',
      mediaType: 'application/octet-stream',
      byteLength: original.length,
      contentDigest: digest(original),
    };
    const submitImport = (
      actorId = actor,
      source: Readable = Readable.from([original]),
      assertAuthorized: () => void = () => {},
      target: FsStore = store,
      actorRef: ActorRef = { kind: 'user', id: actorId },
      workspaceDb: WorkspaceDb = db
    ) =>
      importArtifactFile({
        store: target,
        workspaceDb,
        admission,
        inflightCommands,
        metadata: importMetadata,
        source,
        assertAuthorized,
        context: {
          ...context,
          actor: { kind: 'session', userId: actorId },
          actorRef,
        },
      });
    const submitVersion = (
      artifactId: string,
      expectedArtifactVersion: number,
      requestId: string,
      source: Readable = Readable.from([next]),
      assertAuthorized: () => void = () => {},
      changed: { title?: string; summary?: string | null } = {},
      actorRef: ActorRef = { kind: 'user', id: actor },
      workspaceDb: WorkspaceDb = db
    ) =>
      commitArtifactVersionCommand({
        store,
        workspaceDb,
        inflightCommands,
        context: { ...context, actorRef },
        command: 'artifact.version-file-commit',
        metadata: {
          workspaceId: workspace.id,
          threadId: thread.id,
          artifactId,
          expectedArtifactVersion,
          requestId,
          title: changed.title ?? 'Contract next',
          summary: changed.summary ?? null,
          mediaType: 'application/octet-stream',
          byteLength: next.length,
          contentDigest: digest(next),
        },
        file: { source, admission },
        assertAuthorized,
      });
    const submitInline = (
      artifactId: string,
      input: {
        expectedArtifactVersion: number;
        requestId: string;
        title: string;
        summary: string | null;
        body: string;
      }
    ) =>
      commitArtifactVersionCommand({
        store,
        workspaceDb: db,
        inflightCommands,
        context,
        command: 'artifact.version-commit',
        metadata: {
          workspaceId: workspace.id,
          threadId: thread.id,
          artifactId,
          expectedArtifactVersion: input.expectedArtifactVersion,
          requestId: input.requestId,
          title: input.title,
          summary: input.summary,
          content: { format: 'text', body: input.body },
        },
        admission,
        assertAuthorized: () => {},
      });
    const readVersion = (artifactId: string, version: number) =>
      readFileSync(
        artifactFilePayloadPath(join(dataRoot, 'workspaces', workspace.id), artifactId, version)
      );
    return {
      dataRoot,
      store,
      workspace,
      thread,
      db,
      actor,
      original,
      next,
      submitImport,
      submitVersion,
      submitInline,
      readVersion,
    };
  }

  it('creates distinct concurrent imports with exact bytes and two receipts for equal actor-namespaced requests', async () => {
    const state = await contractFixture();
    const alice = allocateEntityId('usr');
    const bob = allocateEntityId('usr');
    const [a, b] = await Promise.all([state.submitImport(alice), state.submitImport(bob)]);
    expect(a.artifactId).not.toBe(b.artifactId);
    expect(state.readVersion(a.artifactId, 1)).toEqual(state.original);
    expect(state.readVersion(b.artifactId, 1)).toEqual(state.original);
    expect(state.store.getArtifact(state.workspace.id, a.artifactId).origin).toMatchObject({
      actor: { id: alice },
    });
    expect(state.store.getArtifact(state.workspace.id, b.artifactId).origin).toMatchObject({
      actor: { id: bob },
    });
    expect(state.store.listCommandRequests(state.workspace.id)).toHaveLength(2);
  });

  it('returns the accepted import result for an exact replay without consuming changed source bytes', async () => {
    const state = await contractFixture();
    const accepted = await state.submitImport();
    const retry = observableSource(Buffer.from('changed retry bytes'));
    expect(await state.submitImport(state.actor, retry.source)).toEqual(accepted);
    expect(retry.consumed()).toBe(false);
    expect(state.readVersion(accepted.artifactId, 1)).toEqual(state.original);
  });

  it('publishes neither an Artifact nor a receipt after streamed revocation and accepts a corrected request', async () => {
    const state = await contractFixture();
    let authorized = true;
    const source = Readable.from(
      (async function* () {
        yield state.original;
        authorized = false;
      })()
    );
    const assertAuthorized = () => {
      if (!authorized)
        throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
    };
    await expect(state.submitImport(state.actor, source, assertAuthorized)).rejects.toMatchObject({
      code: 'workspace_access_denied',
    });
    expect(state.store.listArtifacts(state.workspace.id)).toHaveLength(0);
    expect(state.store.listCommandRequests(state.workspace.id)).toHaveLength(0);
    authorized = true;
    expect(
      (await state.submitImport(state.actor, Readable.from([state.original]), assertAuthorized))
        .artifactVersion
    ).toBe(1);
  });

  it('retains an unacknowledged import tuple and refuses recapture before and after reopen', async () => {
    const state = await contractFixture();
    // A non-constraint SQLite error retains the original unknown tuple; a definite
    // constraint refusal has a separate rollback contract and is not this scenario.
    state.db.sqlite.exec(`CREATE TRIGGER interrupt_import_receipt BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name='artifact.import' BEGIN SELECT json('not-json'); END`);
    await expect(state.submitImport()).rejects.toSatisfy(receiptSqlFailed);
    state.db.sqlite.exec('DROP TRIGGER interrupt_import_receipt');
    expect(state.store.listArtifacts(state.workspace.id)).toHaveLength(1);
    expect(state.store.listCommandRequests(state.workspace.id)).toHaveLength(0);

    const reopened = createTestStore({ dataRoot: state.dataRoot });
    expect(reopened.listArtifacts(state.workspace.id)).toHaveLength(1);
    expect(reopened.listCommandRequests(state.workspace.id)).toHaveLength(0);
    const retry = observableSource(Buffer.from('changed retry bytes'));
    await expect(
      state.submitImport(state.actor, retry.source, () => {}, reopened)
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(retry.consumed()).toBe(false);
  });

  it('keeps exact bytes across binary, inline and binary versions and reopens with exact lineage', async () => {
    const state = await contractFixture();
    const imported = await state.submitImport();
    const inline = 'Exact middle revision.\r\n';
    await state.submitInline(imported.artifactId, {
      expectedArtifactVersion: 1,
      requestId: randomUUID(),
      title: 'Inline middle',
      summary: null,
      body: inline,
    });
    const result = await state.submitVersion(
      imported.artifactId,
      2,
      randomUUID(),
      Readable.from([state.next])
    );
    expect(result.artifact.version).toBe(3);
    expect(result.version.parentVersion).toBe(2);
    expect(state.readVersion(imported.artifactId, 1)).toEqual(state.original);
    expect(state.readVersion(imported.artifactId, 2)).toEqual(Buffer.from(inline));
    expect(state.readVersion(imported.artifactId, 3)).toEqual(state.next);
    const reopened = createTestStore({ dataRoot: state.dataRoot });
    expect(
      reopened.getArtifactVersion(state.workspace.id, imported.artifactId, 2).artifact.content
    ).toEqual({ format: 'text', body: inline });
    expect(reopened.getArtifactVersion(state.workspace.id, imported.artifactId, 3)).toEqual(result);
  });

  it('refuses partial next-version authority before capture and quarantines only that Workspace', async () => {
    const state = await contractFixture();
    const imported = await state.submitImport();
    mkdirSync(
      join(
        state.dataRoot,
        'workspaces',
        state.workspace.id,
        'artifacts',
        imported.artifactId,
        'versions',
        '2'
      ),
      { recursive: true }
    );
    const retry = observableSource(Buffer.from('unreached retry bytes'));
    await expect(
      state.submitVersion(imported.artifactId, 1, randomUUID(), retry.source)
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(retry.consumed()).toBe(false);
    await expectQuarantinedWorkspace(state.dataRoot, state.workspace.id);
    expect(state.readVersion(imported.artifactId, 1)).toEqual(state.original);
  });

  it('replays a historical version after a head advance and conflicts on changed input', async () => {
    const state = await contractFixture();
    const imported = await state.submitImport();
    const commitRequestId = randomUUID();
    const accepted = await state.submitVersion(imported.artifactId, 1, commitRequestId);
    expect(accepted.artifact.version).toBe(2);
    expect(accepted.version).toMatchObject({
      parentVersion: 1,
      actor: { kind: 'user', id: state.actor },
      requestId: commitRequestId,
    });
    expect(state.readVersion(imported.artifactId, 1)).toEqual(state.original);
    expect(state.readVersion(imported.artifactId, 2)).toEqual(state.next);
    expect(accepted.artifact.origin).toMatchObject({
      kind: 'imported',
      sourceDigest: digest(state.original),
    });
    const third = await state.submitInline(imported.artifactId, {
      expectedArtifactVersion: 2,
      requestId: randomUUID(),
      title: 'Third inline',
      summary: 'Exact new text.',
      body: '\uFEFFthird\r\n',
    });
    expect(third.artifact.version).toBe(3);
    const retry = observableSource(Buffer.from('changed retry bytes'));
    expect(
      await state.submitVersion(imported.artifactId, 1, accepted.version.requestId, retry.source)
    ).toEqual(accepted);
    expect(retry.consumed()).toBe(false);
    const reopened = createTestStore({ dataRoot: state.dataRoot });
    expect(reopened.getArtifactVersion(state.workspace.id, imported.artifactId, 2)).toEqual(
      accepted
    );
    expect(reopened.getArtifact(state.workspace.id, imported.artifactId).version).toBe(3);
    await expect(
      state.submitVersion(
        imported.artifactId,
        1,
        accepted.version.requestId,
        undefined,
        undefined,
        { title: 'Changed retry input' }
      )
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  });

  it('rejects a stale expected head before source consumption without creating a version', async () => {
    const state = await contractFixture();
    const imported = await state.submitImport();
    await state.submitVersion(imported.artifactId, 1, randomUUID());
    const retry = observableSource(Buffer.from('unreached retry bytes'));
    await expect(
      state.submitVersion(imported.artifactId, 1, randomUUID(), retry.source)
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(retry.consumed()).toBe(false);
    expect(state.store.listArtifactVersions(state.workspace.id, imported.artifactId)).toHaveLength(
      2
    );
  });

  it('preserves the prior original and receipt with an empty new Turn inventory after revocation', async () => {
    const state = await contractFixture();
    const imported = await state.submitImport();
    let authorized = true;
    const source = Readable.from(
      (async function* () {
        yield state.next;
        authorized = false;
      })()
    );
    await expect(
      state.submitVersion(imported.artifactId, 1, randomUUID(), source, () => {
        if (!authorized)
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      })
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    expect(state.store.getArtifact(state.workspace.id, imported.artifactId).version).toBe(1);
    expect(state.readVersion(imported.artifactId, 1)).toEqual(state.original);
    expect(state.store.listCommandRequests(state.workspace.id)).toHaveLength(1);
    expect(state.store.listThreadTurns(state.workspace.id, state.thread.id)).toHaveLength(0);
  });

  /** Awaits one rejection so the owner class and its exact public facts stay independently assertable. */
  async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
    return run().then(
      () => undefined,
      (error: unknown) => error
    );
  }

  it('refuses both file commands before any effect when the actor has no responsible user', async () => {
    const state = await contractFixture();
    const unowned: ActorRef = {
      kind: 'agent',
      id: 'agent_contract_unowned',
      responsibleUserId: null,
    };

    const importSource = observableSource(state.original);
    const importAuthorized = vi.fn();
    const importFailure = await rejectionOf(() =>
      state.submitImport(state.actor, importSource.source, importAuthorized, state.store, unowned)
    );
    expect(importFailure).toBeInstanceOf(OperationError);
    expect(importFailure).toMatchObject({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      status: 403,
    });
    expect(importSource.consumed()).toBe(false);
    expect(importAuthorized).not.toHaveBeenCalled();
    expect(state.store.listArtifacts(state.workspace.id)).toEqual([]);
    expect(state.store.listCommandRequests(state.workspace.id)).toEqual([]);
    expect(state.store.listThreadTurns(state.workspace.id, state.thread.id)).toEqual([]);

    const imported = await state.submitImport();
    const versionsBefore = state.store.listArtifactVersions(
      state.workspace.id,
      imported.artifactId
    );
    const receiptsBefore = state.store.listCommandRequests(state.workspace.id);
    const versionSource = observableSource(state.next);
    const versionAuthorized = vi.fn();
    const versionFailure = await rejectionOf(() =>
      state.submitVersion(
        imported.artifactId,
        1,
        randomUUID(),
        versionSource.source,
        versionAuthorized,
        {},
        unowned
      )
    );
    expect(versionFailure).toBeInstanceOf(OperationError);
    expect(versionFailure).toMatchObject({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      status: 403,
    });
    expect(versionSource.consumed()).toBe(false);
    expect(versionAuthorized).not.toHaveBeenCalled();
    expect(state.store.getArtifact(state.workspace.id, imported.artifactId).version).toBe(1);
    expect(state.store.listArtifactVersions(state.workspace.id, imported.artifactId)).toEqual(
      versionsBefore
    );
    expect(state.store.listCommandRequests(state.workspace.id)).toEqual(receiptsBefore);
    expect(state.store.listThreadTurns(state.workspace.id, state.thread.id)).toEqual([]);
  });

  it('refuses both file commands before any effect when workspaceDb belongs to another Workspace', async () => {
    const state = await contractFixture();
    const otherWorkspaceId = allocateEntityId('ws');
    const otherDb = openWorkspaceDb(state.dataRoot, otherWorkspaceId);
    applyScopedMigrations(otherDb, undefined, 'pre-knowledge');
    databases.push(otherDb);

    const importSource = observableSource(state.original);
    const importAuthorized = vi.fn();
    const importFailure = await rejectionOf(() =>
      state.submitImport(
        state.actor,
        importSource.source,
        importAuthorized,
        state.store,
        undefined,
        otherDb
      )
    );
    expect(importFailure).toBeInstanceOf(OperationError);
    expect(importFailure).toMatchObject({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      status: 403,
    });
    expect(importSource.consumed()).toBe(false);
    expect(importAuthorized).not.toHaveBeenCalled();
    expect(state.store.listArtifacts(state.workspace.id)).toEqual([]);
    expect(state.store.listCommandRequests(state.workspace.id)).toEqual([]);
    expect(state.store.listThreadTurns(state.workspace.id, state.thread.id)).toEqual([]);

    const imported = await state.submitImport();
    const versionsBefore = state.store.listArtifactVersions(
      state.workspace.id,
      imported.artifactId
    );
    const receiptsBefore = state.store.listCommandRequests(state.workspace.id);
    const versionSource = observableSource(state.next);
    const versionAuthorized = vi.fn();
    const versionFailure = await rejectionOf(() =>
      state.submitVersion(
        imported.artifactId,
        1,
        randomUUID(),
        versionSource.source,
        versionAuthorized,
        {},
        undefined,
        otherDb
      )
    );
    expect(versionFailure).toBeInstanceOf(OperationError);
    expect(versionFailure).toMatchObject({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      status: 403,
    });
    expect(versionSource.consumed()).toBe(false);
    expect(versionAuthorized).not.toHaveBeenCalled();
    expect(state.store.getArtifact(state.workspace.id, imported.artifactId).version).toBe(1);
    expect(state.store.listArtifactVersions(state.workspace.id, imported.artifactId)).toEqual(
      versionsBefore
    );
    expect(state.store.listCommandRequests(state.workspace.id)).toEqual(receiptsBefore);
    expect(state.store.listThreadTurns(state.workspace.id, state.thread.id)).toEqual([]);
  });

  it('retains both version originals after receipt failure and refuses recapture', async () => {
    const state = await contractFixture();
    const imported = await state.submitImport();
    const commitRequestId = randomUUID();
    state.db.sqlite.exec(`CREATE TRIGGER interrupt_version_receipt BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name='artifact.version-file-commit' AND NEW.request_id='${commitRequestId}'
      BEGIN SELECT json('not-json'); END`);
    await expect(state.submitVersion(imported.artifactId, 1, commitRequestId)).rejects.toSatisfy(
      receiptSqlFailed
    );
    state.db.sqlite.exec('DROP TRIGGER interrupt_version_receipt');
    expect(state.readVersion(imported.artifactId, 1)).toEqual(state.original);
    expect(state.readVersion(imported.artifactId, 2)).toEqual(state.next);
    const retry = observableSource(Buffer.from('changed retry bytes'));
    await expect(
      state.submitVersion(imported.artifactId, 1, commitRequestId, retry.source)
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(retry.consumed()).toBe(false);
    expect(state.store.getArtifact(state.workspace.id, imported.artifactId).version).toBe(2);
  });
});
