// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash } from 'node:crypto';
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
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { importArtifactFile } from './artifact-file-commands.js';
import { commitArtifactVersionCommand } from './artifact-versions.js';
import { scopeAdmissionFailures } from './bootstrap/readiness.js';
import { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from './storage/artifacts/file-records.js';
import { openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const roots: string[] = [];
const databases: WorkspaceDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Hashes original bytes independently of the publication path. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Real exact-byte admission, canonical records and receipts; no HTTP registry substitute. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-version-command-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Version command');
  const thread = store.createThread(workspace.id, 'Shared version publication');
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  databases.push(db);
  const admission = new FileStorageAdmission(dataRoot, () => 0n);
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const context = {
    kind: 'public' as const,
    actor: { kind: 'session' as const, userId: actor.id },
    actorRef: actor,
    scope: { kind: 'thread' as const, workspaceId: workspace.id, threadId: thread.id },
  };
  const original = Buffer.from([0, 255, 128, 13, 10]);
  const imported = await importArtifactFile({
    store,
    workspaceDb: db,
    admission,
    inflightCommands,
    context,
    metadata: {
      workspaceId: workspace.id,
      requestId: 'import-binary-original',
      title: 'Original binary',
      mediaType: 'application/octet-stream',
      byteLength: original.length,
      contentDigest: digest(original),
    },
    source: Readable.from([original]),
    assertAuthorized: () => {},
  });
  const next = Buffer.from([255, 0, 128, 10, 13, 0]);
  const metadata = {
    workspaceId: workspace.id,
    threadId: thread.id,
    artifactId: imported.artifactId,
    expectedArtifactVersion: 1,
    requestId: 'commit-binary-next',
    title: 'Next binary',
    summary: null,
    mediaType: 'application/octet-stream',
    byteLength: next.length,
    contentDigest: digest(next),
  };
  const submit = (source = Readable.from([next]), assertAuthorized = () => {}, changed = {}) =>
    commitArtifactVersionCommand({
      store,
      workspaceDb: db,
      inflightCommands,
      context,
      command: 'artifact.version-file-commit',
      metadata: { ...metadata, ...changed },
      file: { source, admission },
      assertAuthorized,
    });
  const read = (version: number) =>
    readFileSync(
      artifactFilePayloadPath(
        join(dataRoot, 'workspaces', workspace.id),
        imported.artifactId,
        version
      )
    );
  return {
    dataRoot,
    store,
    workspace,
    thread,
    db,
    admission,
    inflightCommands,
    context,
    original,
    next,
    metadata,
    submit,
    read,
  };
}

/** A retry source whose first read is observable and must remain untouched on receipt replay. */
function forbiddenRetrySource() {
  const read = vi.fn();
  return {
    read,
    source: new Readable({
      read() {
        read();
        this.push(Buffer.from('changed retry bytes'));
        this.push(null);
      },
    }),
  };
}

/**
 * Validates one retained fault in a fresh admission lifetime without resetting process state.
 *
 * Copies exact authority, seeds an independent healthy sibling, and checks refusal and preservation.
 * Each copy has a new root identity, so later faults cannot reuse an earlier refusal.
 *
 * @param dataRoot Source fixture containing the injected fault.
 * @param workspaceId Owning Workspace that must be quarantined.
 * @returns Reopened Store and isolated root for additional native readback checks.
 */
function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  onTestFinished(() => rmSync(restartRoot, { recursive: true, force: true }));
  const seed = new FsStore({ dataRoot: restartRoot });
  const sibling = seed.createWorkspace('Healthy refusal control');
  const siblingThread = seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Records every directory, link target and file byte, including the absence of deleted entries. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else {
          entries[key] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
  const before = snapshot(refusedRoot);
  const reopened = new FsStore({ dataRoot: restartRoot });
  expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
    expect.objectContaining({ scope: 'workspace', id: workspaceId })
  );
  expect(() => reopened.getWorkspace(workspaceId)).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(() => reopened.createThread(workspaceId, 'Must remain refused')).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = reopened.createThread(sibling.id, 'Healthy sibling progress');
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  expect(snapshot(refusedRoot)).toEqual(before);
  expect(snapshot(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  return { store: reopened, dataRoot: restartRoot };
}

describe('exact Artifact version commands', () => {
  it('preserves exact originals when an inline version is followed by a binary version', async () => {
    const state = await fixture();
    const text = 'Exact inline revision.\r\n';
    await commitArtifactVersionCommand({
      store: state.store,
      workspaceDb: state.db,
      inflightCommands: state.inflightCommands,
      context: state.context,
      command: 'artifact.version-commit',
      metadata: {
        workspaceId: state.workspace.id,
        threadId: state.thread.id,
        artifactId: state.metadata.artifactId,
        expectedArtifactVersion: 1,
        requestId: 'commit-inline-between-binaries',
        title: 'Inline revision',
        summary: null,
        content: { format: 'text', body: text },
      },
      admission: state.admission,
      assertAuthorized: () => {},
    });
    const result = await state.submit(undefined, undefined, { expectedArtifactVersion: 2 });
    expect(result.artifact.version).toBe(3);
    expect(result.version.parentVersion).toBe(2);
    expect(state.read(1)).toEqual(state.original);
    expect(state.read(2)).toEqual(Buffer.from(text));
    expect(state.read(3)).toEqual(state.next);
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    expect(
      reopened.getArtifactVersion(state.workspace.id, state.metadata.artifactId, 2).artifact.content
    ).toEqual({ format: 'text', body: text });
    expect(reopened.getArtifactVersion(state.workspace.id, state.metadata.artifactId, 3)).toEqual(
      result
    );
  });
  it('refuses partial next-version authority before retry capture and after restart', async () => {
    const state = await fixture();
    const originalPath = artifactFilePayloadPath(
      join(state.dataRoot, 'workspaces', state.workspace.id),
      state.metadata.artifactId,
      1
    );
    mkdirSync(
      join(
        state.dataRoot,
        'workspaces',
        state.workspace.id,
        'artifacts',
        state.metadata.artifactId,
        'versions',
        '2'
      )
    );
    const retry = forbiddenRetrySource();
    await expect(state.submit(retry.source)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(retry.read).not.toHaveBeenCalled();
    expectLocalWorkspaceRefusal(state.dataRoot, state.workspace.id);
    expect(readFileSync(originalPath)).toEqual(state.original);
  });
  it('retains both binary originals and replays the historical result after another version advances', async () => {
    const state = await fixture();
    const accepted = await state.submit();
    expect(accepted.artifact.version).toBe(2);
    expect(accepted.version).toMatchObject({
      parentVersion: 1,
      actor,
      requestId: state.metadata.requestId,
    });
    expect(state.read(1)).toEqual(state.original);
    expect(state.read(2)).toEqual(state.next);
    expect(accepted.artifact.origin).toMatchObject({
      kind: 'imported',
      sourceDigest: digest(state.original),
    });
    const third = await commitArtifactVersionCommand({
      store: state.store,
      workspaceDb: state.db,
      admission: state.admission,
      inflightCommands: state.inflightCommands,
      context: state.context,
      command: 'artifact.version-commit',
      metadata: {
        workspaceId: state.workspace.id,
        artifactId: state.metadata.artifactId,
        threadId: state.thread.id,
        requestId: 'commit-third',
        expectedArtifactVersion: 2,
        title: 'Third inline',
        summary: 'Exact new text.',
        content: { format: 'text', body: '\uFEFFthird\r\n' },
      },
      assertAuthorized: () => {},
    });
    expect(third.artifact.version).toBe(3);
    const retry = forbiddenRetrySource();
    expect(await state.submit(retry.source)).toEqual(accepted);
    expect(retry.read).not.toHaveBeenCalled();
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    expect(reopened.getArtifactVersion(state.workspace.id, state.metadata.artifactId, 2)).toEqual(
      accepted
    );
    expect(reopened.getArtifact(state.workspace.id, state.metadata.artifactId).version).toBe(3);
    await expect(
      state.submit(Readable.from([state.next]), () => {}, { title: 'Changed retry input' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  });

  it('rejects a stale writer before reading its original or publishing a receipt', async () => {
    const state = await fixture();
    await state.submit();
    const retry = forbiddenRetrySource();
    await expect(
      state.submit(retry.source, () => {}, { requestId: 'stale-writer' })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(retry.read).not.toHaveBeenCalled();
    expect(
      state.store.listArtifactVersions(state.workspace.id, state.metadata.artifactId)
    ).toHaveLength(2);
  });

  it('rechecks current authorization after capture and preserves the original on refusal', async () => {
    const state = await fixture();
    let authorized = true;
    const source = Readable.from(
      (async function* () {
        yield state.next;
        authorized = false;
      })()
    );
    await expect(
      state.submit(source, () => {
        if (!authorized)
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      })
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    expect(state.store.getArtifact(state.workspace.id, state.metadata.artifactId).version).toBe(1);
    expect(state.read(1)).toEqual(state.original);
    expect(state.store.listCommandRequests()).toHaveLength(1);
    expect(state.store.listThreadTurns(state.workspace.id, state.thread.id)).toHaveLength(0);
  });

  it('retains a complete unacknowledged version after receipt failure and refuses recapture', async () => {
    const state = await fixture();
    const failure = vi.spyOn(state.store, 'recordCommandRequest').mockImplementation(() => {
      throw new Error('Receipt publication failed.');
    });
    await expect(state.submit()).rejects.toThrow('Receipt publication failed.');
    failure.mockRestore();
    expect(state.read(1)).toEqual(state.original);
    expect(state.read(2)).toEqual(state.next);
    const retry = forbiddenRetrySource();
    await expect(state.submit(retry.source)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(retry.read).not.toHaveBeenCalled();
    expect(state.store.getArtifact(state.workspace.id, state.metadata.artifactId).version).toBe(2);
  });
});
