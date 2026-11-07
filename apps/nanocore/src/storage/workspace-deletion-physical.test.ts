// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  createWorkspaceDeletionClosure,
  existingWorkspaceDeletionClosureRoot,
  verifyWorkspaceDeletionClosure,
} from '../workspace-deletion-evidence.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { beginWorkspaceDeletion, getWorkspaceRegistryLifecycleFact } from '../workspace-sharing.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const physical = vi.hoisted(() => ({
  root: '',
  failAfterWrite: '',
  failure: undefined as Error | undefined,
  descriptors: new Map<number, string>(),
  writes: [] as string[],
}));

// Both domain production and Storage byte work remain real. A selected failed
// acknowledgement occurs after the actual write, never instead of its effect.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const descriptor = actual.openSync(...args);
      physical.descriptors.set(descriptor, String(args[0]));
      return descriptor;
    },
    closeSync(descriptor: number) {
      actual.closeSync(descriptor);
      physical.descriptors.delete(descriptor);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      actual.writeFileSync(...args);
      const path =
        typeof args[0] === 'number' ? physical.descriptors.get(args[0])! : String(args[0]);
      if (physical.root && path.startsWith(`${physical.root}/`)) {
        physical.writes.push(relative(physical.root, path));
        if (path === physical.failAfterWrite) throw physical.failure;
      }
    },
  };
});

const disposals: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  physical.root = '';
  physical.failAfterWrite = '';
  physical.failure = undefined;
  physical.writes.length = 0;
  await shutdownControlStoreWorkerClient();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

const recordPaths = [
  'records/core-workspace-registry.jsonl',
  'records/core-workspace-memberships.jsonl',
  'records/core-workspace-invitations.jsonl',
  'records/core-audit-events.jsonl',
  'records/workspace-audit-events.jsonl',
  'records/permission-decisions.jsonl',
  'records/vault-use.jsonl',
  'records/usage-aggregates.jsonl',
  'records/evidence-manifests.jsonl',
  'records/recurring-history.jsonl',
].sort();
const retainedBytes = Buffer.from([0, 255, 128, 13, 10, 0, 254]);

/** Hash independently from the manifest producer, including exact newlines. */
function digest(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Observe the completed retained tree through actual files without modifying it. */
function files(root: string): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry): [string, Buffer] => {
        const path = join(entry.parentPath, entry.name);
        return [relative(root, path), readFileSync(path)];
      })
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
}

/** Reach deleting state and retained evidence through their real owning operations. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'nanocore-deletion-physical-'));
  disposals.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  disposals.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  const ownerId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Retained closure physical boundary');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: ownerId, workspaceId: workspace.id });
  const thread = await store.createThread(workspace.id, 'Retained evidence owner');
  const turn = await store.createTurn(workspace.id, thread.id, 'Retain evidence', {
    kind: 'user',
    id: ownerId,
  });
  await store.completeTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
  const evidenceId = 'evb_deletion_physical';
  const evidenceDb = openWorkspaceDb(dataRoot, workspace.id);
  try {
    applyScopedMigrations(evidenceDb);
    retainWorkObservationBody(evidenceDb, {
      bundleId: evidenceId,
      threadId: thread.id,
      turnId: turn.id,
      createdAt: '2026-10-06T00:00:00.000Z',
      sha256: createHash('sha256').update(retainedBytes).digest('hex'),
      bytes: retainedBytes,
    });
  } finally {
    evidenceDb.sqlite.close();
  }
  const before = getWorkspaceRegistryLifecycleFact(coreDb, workspace.id)!;
  const registry = coreDb.sqlite
    .transaction(() =>
      beginWorkspaceDeletion({
        coreDb,
        workspaceId: workspace.id,
        originalOwnerUserId: ownerId,
        expectedRegistryRevision: before.registryRevision,
      })
    )
    .immediate();
  let selectedDb: WorkspaceDb | undefined;
  const input = {
    coreDb,
    dataRoot,
    repositoryWorkspaceDb: (workspaceId: string) => {
      selectedDb = openWorkspaceDb(dataRoot, workspaceId);
      return selectedDb;
    },
    workspaceId: workspace.id,
    requestId: '00000000-0000-4000-8000-000000000001',
    originalOwnerUserId: ownerId,
    sourceRegistryRevision: registry.registryRevision,
    closureId: 'wsclose_physical',
    cutoffTimestamp: '2026-10-06T00:00:00.000Z',
    recoveryBackupId: allocateEntityId('wsbak'),
    recoveryBackupManifestDigest: digest('independently selected backup manifest'),
  };
  const root = join(
    dataRoot,
    'server',
    'exports',
    'workspace-closures',
    workspace.id,
    input.closureId
  );
  const source = join(
    dataRoot,
    'workspaces',
    workspace.id,
    'evidence',
    'backend',
    evidenceId,
    'raw',
    'content'
  );
  physical.root = root;
  return { input, root, source, evidenceId, registry, selectedDb: () => selectedDb };
}

// Audit/Usage/Evidence Records, Workspace Deletion Closure: manifest-last,
// complete exact inventory, immutable verification and owner-only failed-root cleanup.
describe('deletion closure real domain and Storage composition', () => {
  it('seals exact retained bytes and inventory privately, then verifies without changing source or registry', async () => {
    const f = await fixture();
    const result = createWorkspaceDeletionClosure(f.input);
    expect(f.selectedDb()!.sqlite.open).toBe(false);
    expect(
      existingWorkspaceDeletionClosureRoot(f.input.dataRoot, f.input.workspaceId, f.input.closureId)
    ).toBe(f.root);
    const observed = files(f.root);
    const rawManifest = observed['workspace-closure.json']!;
    expect(rawManifest.at(-1)).toBe(10);
    const manifest = JSON.parse(rawManifest.toString());
    expect(
      Object.keys(observed)
        .filter((path) => path.startsWith('records/'))
        .sort()
    ).toEqual(recordPaths);
    const inventory = Object.entries(observed)
      .filter(([path]) => path !== 'workspace-closure.json')
      .map(([path, content]) => ({ path, bytes: content.length, digest: digest(content) }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    expect(manifest.contentInventory).toEqual(inventory);
    expect(manifest.contentDigest).toBe(digest(JSON.stringify(inventory)));
    expect(result.manifestDigest).toBe(digest(rawManifest));
    expect(observed[`evidence/${f.evidenceId}/raw/content`]).toEqual(retainedBytes);
    expect(readFileSync(f.source)).toEqual(retainedBytes);
    const registryRows = observed['records/core-workspace-registry.jsonl']!.toString()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0]).toMatchObject({
      workspace_id: f.input.workspaceId,
      status: 'deleting',
      revision: f.registry.registryRevision,
    });
    expect(physical.writes.at(-1)).toBe('workspace-closure.json');
    expect(new Set(physical.writes)).toEqual(new Set(Object.keys(observed)));
    for (const entry of readdirSync(f.root, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      expect(lstatSync(path).mode & 0o777).toBe(entry.isDirectory() ? 0o700 : 0o600);
    }
    expect(verifyWorkspaceDeletionClosure({ ...f.input, closureRoot: f.root })).toEqual(result);
    expect(verifyWorkspaceDeletionClosure({ ...f.input, closureRoot: f.root })).toEqual(result);
    expect(files(f.root)).toEqual(observed);
    expect(getWorkspaceRegistryLifecycleFact(f.input.coreDb, f.input.workspaceId)).toEqual(
      f.registry
    );
  });

  it.each(['records/core-workspace-registry.jsonl', 'workspace-closure.json'])(
    'removes only the selected unsealed root after a real %s write fails',
    async (path) => {
      const f = await fixture();
      const sibling = join(f.root, '..', 'retained-sibling');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'retained'), retainedBytes);
      const failure = new Error('injected closure write acknowledgement failure');
      physical.failAfterWrite = join(f.root, path);
      physical.failure = failure;
      expect(() => createWorkspaceDeletionClosure(f.input)).toThrow(failure);
      expect(physical.writes).toContain(path);
      expect(existsSync(f.root)).toBe(false);
      expect(readFileSync(join(sibling, 'retained'))).toEqual(retainedBytes);
      expect(readFileSync(f.source)).toEqual(retainedBytes);
      expect(f.selectedDb()!.sqlite.open).toBe(false);
      expect(getWorkspaceRegistryLifecycleFact(f.input.coreDb, f.input.workspaceId)).toEqual(
        f.registry
      );
    }
  );
});
