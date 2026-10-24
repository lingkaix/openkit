// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { createChannelServices } from '../channel-services.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  compactWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from '../evidence-bundles.js';
import { AutomationStore } from '../lib/automation-store.js';
import { cleanCancelledAdmissionTaskCheckpoints } from '../runtime/cancelled-admission-checkpoint-cleanup.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { pendingRequestItemId } from '../runtime/pending-requests.js';
import { upsertWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { writeHotDataRootBackup } from './data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import {
  parseWorkspaceBackupManifest,
  withVerifiedWorkspaceBackupBundle,
} from './workspace-backup-bundle.js';
import { nativeProductScope, readNativeTurnHistory } from './workspace-file-records.js';
import {
  runWorkspaceRecoveryCli,
  type WorkspaceRecoveryCliReport,
  WorkspaceRecoveryError,
} from './workspace-recovery-cli.js';

const workspaceId = DEMO_WORKSPACE_ID;
const release = { releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) };
const roots: string[] = [];
// Coordinator's release-policy addendum extends the callable stub without changing the binary grammar.
const runCli: (
  argv: readonly string[],
  write?: (line: string) => void,
  deps?: { releaseIdentityPath?: string }
) => Promise<WorkspaceRecoveryCliReport> = runWorkspaceRecoveryCli;

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Hashes fixture-owned bytes independently of the bundle parser. */
function sha(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Reads retained rows without creating or migrating an absent authority. */
function rows(path: string, table: string): unknown[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

/** Copies a stopped owner's actual files, preserving required modes and omitting empty directories. */
function copyInventory(source: string, target: string, relative = '') {
  const result: { path: string; bytes: number; sha256: string; mode: number }[] = [];
  for (const name of readdirSync(join(source, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    if (/^(indexes|logs|projections)(\/|$)/.test(path)) continue;
    const from = join(source, path);
    const stat = statSync(from);
    if (stat.isDirectory()) result.push(...copyInventory(source, target, path));
    else {
      expect(stat.isFile()).toBe(true);
      const to = join(target, path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o777);
      const bytes = readFileSync(to);
      result.push({ path, bytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 });
    }
  }
  return result;
}

/** Makes a sealed input through existing native and hot-backup owners, independently of D0 capture. */
async function fixture(channelHistory = false, unfinished = false) {
  const root = mkdtempSync(join(tmpdir(), 'd0-restore-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const core = openCoreDb(dataRoot);
  const ownerId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: ownerId });
  const credential = createOpenKitAccessTokenRecord(core, {
    ownerUserId: ownerId,
    scope: 'workspace',
    workspaceIds: [workspaceId],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  core.sqlite.close();
  const db = openWorkspaceDb(dataRoot, workspaceId);
  try {
    recordWorkspaceEvidenceBundle(db, {
      id: 'evb_expiring',
      workspaceId,
      threadId: null,
      goalId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'diagnostic',
      summary: 'Old diagnostic',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
      contentDigests: [],
      retentionClass: 'ephemeral-diagnostic',
      sensitivityClass: 'restricted',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: '2020-01-01T00:00:00.000Z',
    });
  } finally {
    db.sqlite.close();
  }
  let capturedTurnId: string | undefined;
  if (unfinished) {
    const turn = await store.createTurn(workspaceId, DEMO_THREAD_ID, 'Captured unfinished Turn', {
      kind: 'user',
      id: ownerId,
    });
    capturedTurnId = turn.id;
    expect(['completed', 'interrupted', 'cancelled', 'failed']).not.toContain(turn.status);
  }
  const pendingId = randomUUID();
  if (channelHistory) {
    const turn = await store.createTurn(workspaceId, DEMO_THREAD_ID, 'Historical channel request', {
      kind: 'user',
      id: ownerId,
    });
    const pendingDb = openWorkspaceDb(dataRoot, workspaceId);
    const now = new Date().toISOString();
    const itemId = pendingRequestItemId(pendingId, 'request');
    const questions = [
      {
        id: 'color',
        header: 'Color',
        question: 'Choose a color.',
        options: null,
        isOther: true,
        isSecret: false,
      },
    ];
    try {
      await raiseRecordedPendingRequest(
        store,
        pendingDb.sqlite,
        {
          requestId: pendingId,
          workspaceId,
          threadId: DEMO_THREAD_ID,
          raisingTurnId: turn.id,
          requestItemId: itemId,
          kind: 'user-input',
          requesterKind: 'person',
          responsibleUserId: ownerId,
          questions,
          questionDigest: 'd0-recovery-channel-question',
          now,
        },
        {
          id: itemId,
          owner: { kind: 'workspace', workspaceId },
          threadId: DEMO_THREAD_ID,
          turnId: turn.id,
          responsibleUserId: ownerId,
          type: 'user-input-request',
          status: 'completed',
          userInputRequestId: pendingId,
          prompt: 'Choose a color.',
          questions,
          createdAt: now,
          completedAt: now,
        }
      );
    } finally {
      pendingDb.sqlite.close();
    }
  }
  const channelQuery = {
    actor: { kind: 'session' as const, userId: ownerId },
    workspaceId,
    threadId: DEMO_THREAD_ID,
    pendingRequestId: pendingId,
  };
  // Exercise the actual channel admission owner without contacting an external transport.
  const inspectChannel = () => {
    const channelDb = openCoreDb(dataRoot);
    try {
      const channels = createChannelServices({
        coreDb: channelDb,
        store,
        mode: 'server',
        openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
        invokePending: async () => {
          throw new Error('An inspection must not dispatch a channel effect.');
        },
      });
      return channels.inspectPending(channelQuery);
    } finally {
      channelDb.sqlite.close();
    }
  };
  if (channelHistory)
    expect(inspectChannel()).toMatchObject({ status: 'available', responseAllowed: true });
  await shutdownControlStoreWorkerClient();
  const sourceDeploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId },
  });
  const parent = join(root, 'parent');
  await writeHotDataRootBackup({
    dataRoot,
    backupRoot: parent,
    backupId: allocateEntityId('drb'),
    sourceDeploymentId,
    startedAt: '2026-10-21T10:00:00.000Z',
    completedAt: '2026-10-21T10:00:00.000Z',
  });
  const bundleRoot = join(root, 'bundle');
  mkdirSync(bundleRoot, { mode: 0o700 });
  const inventory = copyInventory(join(parent, 'workspaces', workspaceId), bundleRoot);
  const sourceDb = new Database(workspaceDbPath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  let capturedRevision: number;
  try {
    capturedRevision = sourceDb
      .prepare('SELECT revision FROM control_workspaces WHERE id=?')
      .pluck()
      .get(workspaceId) as number;
  } finally {
    sourceDb.close();
  }
  const manifest = parseWorkspaceBackupManifest({
    format: 'openkit-workspace-backup',
    version: 1,
    purpose: 'backup',
    backupId: allocateEntityId('wsbak'),
    workspaceId,
    sourceDeploymentId,
    knowledgeBaseIds: [knowledgeBaseId],
    capturedRevision,
    priorMoves: [],
    release: { version: release.releaseTag, buildId: release.sourceCommit },
    requiredFeatures: [],
    databaseFormats: [{ path: 'db/workspace.sqlite', markers: { 'drizzle.workspace': 14 } }],
    capture: {
      startedAt: '2026-10-21T10:00:00.000Z',
      completedAt: '2026-10-21T10:00:00.000Z',
      consistency: 'quiescent',
    },
    inventory,
    inventoryDigest: sha(JSON.stringify(inventory)),
    coverage: {
      includedAuthorities: ['workspace-control', 'workspace-content', 'knowledge'],
      snapshotRoots: ['db', 'knowledge', 'evidence', 'config'],
      omittedProjections: ['indexes', 'logs', 'projections'],
      omittedVolumes: [],
      externalDependencies: [],
    },
    accounts: { ownerId, memberIds: [ownerId], privateAudienceRefs: [] },
  });
  const writeManifest = (value = manifest) => {
    const raw = JSON.stringify(value);
    writeFileSync(join(bundleRoot, 'manifest.json'), raw, { mode: 0o600 });
    writeFileSync(
      join(bundleRoot, 'seal.json'),
      JSON.stringify({
        format: 'openkit-workspace-backup-seal',
        version: 1,
        backupId: value.backupId,
        purpose: value.purpose,
        manifestDigest: sha(raw),
      }),
      { mode: 0o600 }
    );
  };
  writeManifest();
  const releaseIdentityPath = join(root, 'release-identity.json');
  writeFileSync(releaseIdentityPath, JSON.stringify(release), { mode: 0o600 });
  mkdirSync(join(root, 'staging'));
  await withVerifiedWorkspaceBackupBundle(
    {
      bundleRoot,
      stagingParent: join(root, 'staging'),
      admission: new FileStorageAdmission(root, () => 0n),
      expectedRelease: manifest.release,
      supportedDatabaseFormats: { 'drizzle.workspace': 14 },
    },
    async (verified) => {
      expect(verified.manifest).toEqual(manifest);
    }
  );
  const requestId = randomUUID();
  const argv = [
    'restore',
    '--data-root',
    dataRoot,
    '--bundle-root',
    bundleRoot,
    '--workspace-id',
    workspaceId,
    '--request-id',
    requestId,
  ];
  return {
    root,
    dataRoot,
    store,
    ownerId,
    credential,
    bundleRoot,
    manifest,
    writeManifest,
    releaseIdentityPath,
    requestId,
    argv,
    inspectChannel,
    capturedTurnId,
  };
}

/** Refusal oracles name the exact product code and reject disclosure or a success report. */
async function refuses(f: Awaited<ReturnType<typeof fixture>>, code: string, argv = f.argv) {
  const output: string[] = [];
  const error: unknown = await runCli(argv, (line) => output.push(line), f).catch(
    (value: unknown) => value
  );
  expect(error).toBeInstanceOf(WorkspaceRecoveryError);
  expect((error as WorkspaceRecoveryError).code).toBe(code);
  expect(output).toEqual([]);
  expect(String(error)).not.toContain(f.root);
}

describe('D0-2 same-deployment restore', () => {
  it('WM restore step 4: a captured unfinished Turn without a Pending Request is interrupted without replacement work', async () => {
    const f = await fixture(false, true);
    expect(f.capturedTurnId).toBeDefined();
    const dbPath = workspaceDbPath(f.dataRoot, workspaceId);
    expect(rows(dbPath, 'pending_requests')).toEqual([]);
    const beforeTurns = rows(dbPath, 'control_turns');
    const beforeAdmissions = rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries');
    const beforeAttempts = rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts');
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({
      disposition: 'restored',
      workspaceId,
    });
    const restored = readNativeTurnHistory(
      nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId }),
      f.capturedTurnId!
    )!.turn;
    expect(restored).toMatchObject({
      id: f.capturedTurnId,
      owner: { kind: 'workspace', workspaceId },
      threadId: DEMO_THREAD_ID,
      status: 'interrupted',
      completedAt: expect.any(String),
    });
    expect(rows(dbPath, 'control_turns')).toHaveLength(beforeTurns.length);
    expect(rows(dbPath, 'pending_requests')).toEqual([]);
    expect(rows(dbPath, 'control_executions')).toEqual([]);
    expect(rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries')).toEqual(beforeAdmissions);
    expect(rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts')).toEqual(beforeAttempts);
  }, 120_000);

  it.each([
    {
      history: 'absent',
      outcome: 'succeeded',
      decision: 'removable',
      reason: 'cancelled-admission',
    },
    {
      history: 'retained-turn',
      outcome: 'succeeded',
      decision: 'refused',
      reason: 'mismatched-turn-lineage',
    },
    { history: 'corrupt', outcome: 'blocked', decision: 'refused', reason: 'unreadable-history' },
  ] as const)('WM restore / scheduler maintenance: $history predecessor history preserves the global absence proof', async ({
    history,
    outcome,
    decision,
    reason,
  }) => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Healthy checkpoint-maintenance sibling');
    const thread = await f.store.createThread(sibling.id, 'Failed pre-admission Task');
    const identity = {
      workspaceId: sibling.id,
      threadId: thread.id,
      turnId: allocateEntityId('tu'),
    };
    const requestId = randomUUID();
    // The Turn is newer than the backup cut and survives restore only in the predecessor.
    if (history === 'retained-turn') {
      await f.store.createTurn(
        workspaceId,
        DEMO_THREAD_ID,
        'Retained contradictory Turn',
        { kind: 'user', id: f.ownerId },
        null,
        { turnId: identity.turnId }
      );
    }
    await shutdownControlStoreWorkerClient();
    const core = openCoreDb(f.dataRoot);
    const siblingDb = openWorkspaceDb(f.dataRoot, sibling.id);
    try {
      recordWorkspaceOwnerMembership({
        coreDb: core,
        workspaceId: sibling.id,
        ownerUserId: f.ownerId,
      });
      const queueEntryId = `restore-maintenance-${requestId}`;
      createSchedulerAdmissionEntry(core, {
        backendId: 'nanohost',
        queueEntryId,
        requestId,
        requestedAgentId: 'agent_codex_host',
        triggerActor: { kind: 'user', id: f.ownerId },
        turnInput: 'Cancelled before Turn publication.',
        ...identity,
      });
      cancelSchedulerAdmissionEntry(core, { queueEntryId, workspaceId: sibling.id });
      await openTestNativeWorkspace(siblingDb);
      await upsertWorkerCheckpoint(siblingDb, {
        ...identity,
        requestId,
        requestInputHash: `sha256:${requestId}`,
        stage: 'failed',
        stopReason: 'error',
        workerSessionId: null,
        goalId: null,
        taskId: null,
        iteration: 0,
        contextDigest: null,
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      siblingDb.sqlite.close();
      core.sqlite.close();
    }
    const backupRoot = join(f.root, 'checkpoint-backups');
    if (history === 'absent') {
      await expect(
        cleanCancelledAdmissionTaskCheckpoints({
          dataRoot: f.dataRoot,
          backupRoot,
          checkpoints: [identity],
        })
      ).resolves.toMatchObject({
        outcome: 'succeeded',
        rows: [{ ...identity, decision: 'removable', reason: 'cancelled-admission' }],
      });
    }
    // Enumerate only this finite fixture tree; recovery decides predecessor placement.
    const databasePaths = () =>
      readdirSync(f.root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name === 'workspace.sqlite')
        .map((entry) => join(entry.parentPath, entry.name));
    const databasePathsBefore = new Set(databasePaths());
    const canonicalRootsBefore = readdirSync(join(f.dataRoot, 'workspaces')).sort();
    const originalWorkspaceBytes = sha(readFileSync(workspaceDbPath(f.dataRoot, workspaceId)));
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({ disposition: 'restored' });
    const predecessors = databasePaths()
      .filter((path) => !databasePathsBefore.has(path))
      .filter((path) =>
        rows(path, 'control_workspaces').some(
          (row) => typeof row === 'object' && row !== null && 'id' in row && row.id === workspaceId
        )
      );
    expect(predecessors).toHaveLength(1);
    const predecessorDb = predecessors[0]!;
    expect(sha(readFileSync(predecessorDb))).toBe(originalWorkspaceBytes);
    expect(rows(predecessorDb, 'control_workspaces')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspaceId })])
    );
    if (history === 'retained-turn') {
      expect(rows(predecessorDb, 'control_turns')).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: identity.turnId })])
      );
      expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_turns')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: identity.turnId })])
      );
    }
    if (history === 'corrupt') {
      // Corrupt stopped retained metadata; production writers and constraints stay unchanged.
      const db = new Database(predecessorDb, { fileMustExist: true });
      try {
        db.pragma('ignore_check_constraints = ON');
        expect(
          db
            .prepare('UPDATE control_threads SET record_json = ? WHERE id = ?')
            .run('{', DEMO_THREAD_ID).changes
        ).toBe(1);
      } finally {
        db.close();
      }
    }
    const predecessorBytes = sha(readFileSync(predecessorDb));
    const siblingPath = workspaceDbPath(f.dataRoot, sibling.id);
    const checkpointsBefore = rows(siblingPath, 'worker_turn_checkpoints');
    const siblingTurnsBefore = rows(siblingPath, 'control_turns');
    const admissionsBefore = rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries');
    const attemptsBefore = rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts');
    const result = await cleanCancelledAdmissionTaskCheckpoints({
      dataRoot: f.dataRoot,
      backupRoot,
      checkpoints: [identity],
    });
    expect(result).toMatchObject({
      applied: false,
      backupRoot: null,
      outcome,
      removedCount: 0,
      rows: [{ ...identity, decision, reason }],
    });
    expect(rows(siblingPath, 'worker_turn_checkpoints')).toEqual(checkpointsBefore);
    expect(rows(siblingPath, 'control_turns')).toEqual(siblingTurnsBefore);
    expect(rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries')).toEqual(admissionsBefore);
    expect(rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts')).toEqual(attemptsBefore);
    expect(sha(readFileSync(predecessorDb))).toBe(predecessorBytes);
    expect(readdirSync(join(f.dataRoot, 'workspaces')).sort()).toEqual(canonicalRootsBefore);
    expect(existsSync(backupRoot)).toBe(false);
  }, 120_000);

  it('WM 377–381: current registry, membership, grants, restrictions, holds and expiry win over backup state', async () => {
    const f = await fixture();
    const core = openCoreDb(f.dataRoot);
    revokeOpenKitAccessTokenRecord(core, f.credential.tokenId);
    const currentOwner = allocateEntityId('usr');
    const changedAt = new Date().toISOString();
    core.sqlite.transaction(() => {
      core.sqlite
        .prepare(`INSERT INTO users
        (id, kind, display_name, email, email_verified, created_at, updated_at, status)
        VALUES (?, 'human', 'Current owner', ?, 0, ?, ?, 'active')`)
        .run(currentOwner, `${currentOwner}@example.invalid`, Date.now(), Date.now());
      core.sqlite
        .prepare(`INSERT INTO workspace_members
        (workspace_id,user_id,status,invitation_id,joined_at,removed_at,revision,created_at,updated_at)
        VALUES (?,?,'active',NULL,?,NULL,1,?,?)`)
        .run(workspaceId, currentOwner, changedAt, changedAt, changedAt);
      core.sqlite
        .prepare(`UPDATE workspace_registry SET owner_user_id=?, revision=revision+1, updated_at=?
        WHERE workspace_id=?`)
        .run(currentOwner, changedAt, workspaceId);
      core.sqlite
        .prepare(`UPDATE workspace_members SET status='removed', removed_at=?, revision=revision+1,
        updated_at=? WHERE workspace_id=? AND user_id=?`)
        .run(changedAt, changedAt, workspaceId, f.ownerId);
    })();
    core.sqlite.close();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      recordWorkspaceEvidenceBundle(db, {
        id: 'evb_current_hold',
        workspaceId,
        threadId: null,
        goalId: null,
        turnId: null,
        agentSessionId: null,
        backendType: null,
        sourceKind: 'legal-hold',
        summary: 'Current hold',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [],
        contentDigests: [],
        retentionClass: 'legal-hold',
        sensitivityClass: 'restricted',
        importStatus: 'collected',
        requiredFeatures: [],
        createdAt: new Date().toISOString(),
      });
      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb: db,
          workspaceId,
          olderThan: '2021-01-01T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
    } finally {
      db.sqlite.close();
    }
    const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc');
    const policy = managedThreadPolicy({
      workspaceId,
      threadId: DEMO_THREAD_ID,
      userId: f.ownerId,
    });
    const config = WorkspaceConfigSchema.parse({
      schemaVersion: 1,
      requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
      workspace: { name: 'Current restricted Workspace', policy: { mediation: policy } },
    });
    writeFileSync(configPath, JSON.stringify(config));
    const current = Object.fromEntries(
      ['workspace_registry', 'workspace_members', 'openkit_access_tokens'].map((table) => [
        table,
        rows(coreDbPath(f.dataRoot), table),
      ])
    );
    const safety = rows(workspaceDbPath(f.dataRoot, workspaceId), 'evidence_bundles');
    const output: string[] = [];
    const promise = runCli(f.argv, (line) => output.push(line), f);
    await expect(promise).resolves.toMatchObject({
      command: 'restore',
      disposition: 'restored',
      workspaceId,
      restrictedRecovery: false,
      capture: { backupId: f.manifest.backupId, sourceDeploymentId: f.manifest.sourceDeploymentId },
    });
    const report = await promise;
    for (const [table, expected] of Object.entries(current))
      expect(rows(coreDbPath(f.dataRoot), table)).toEqual(expected);
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'evidence_bundles')).toEqual(safety);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).workspace.policy.mediation).toEqual(policy);
    expect(output.map((line) => JSON.parse(line))).toEqual([report]);
    expect(output.join('')).not.toContain(f.root);
  }, 120_000);

  it('WM 377: a verified bundle from another deployment refuses deployment-mismatch before replacement', async () => {
    const f = await fixture();
    f.writeManifest({ ...f.manifest, sourceDeploymentId: allocateEntityId('dep') });
    const before = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    await refuses(f, 'deployment-mismatch');
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(before);
  }, 120_000);

  it('WM 381, 385, 389: lost safety without acknowledgement stays quarantined and creates no replacement', async () => {
    const f = await fixture();
    rmSync(workspaceDbPath(f.dataRoot, workspaceId));
    await refuses(f, 'safety-unproved');
    expect(existsSync(workspaceDbPath(f.dataRoot, workspaceId))).toBe(false);
    await expect(
      runCli(
        [
          'inspect',
          '--data-root',
          f.dataRoot,
          '--workspace-id',
          workspaceId,
          '--request-id',
          f.requestId,
        ],
        () => {},
        f
      )
    ).resolves.toMatchObject({
      command: 'inspect',
      disposition: 'quarantined',
      workspaceId,
      selection: { kind: 'admission', requestId: f.requestId },
    });
  }, 120_000);

  it('WM 385–387: acknowledged restricted recovery records the exact backup and bounded loss window', async () => {
    const f = await fixture(true);
    const core = openCoreDb(f.dataRoot);
    const instant = new Date().toISOString();
    const schedules = new AutomationStore(core, new WorkspaceMutationAdmission(), () => instant);
    const schedule = schedules.createAutomation(f.ownerId, {
      name: 'Current automation',
      workspaceId,
      threadId: DEMO_THREAD_ID,
      intervalSeconds: 60,
      prompt: 'Must not run after restricted recovery',
    });
    schedules.updateAutomation(f.ownerId, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    core.sqlite.close();
    rmSync(workspaceDbPath(f.dataRoot, workspaceId));
    const before = Date.now();
    const promise = runCli([...f.argv, '--acknowledge-lost-safety'], () => {}, f);
    await expect(promise).resolves.toMatchObject({
      disposition: 'restored',
      workspaceId,
      restrictedRecovery: {
        backupId: f.manifest.backupId,
        captureStartedAt: f.manifest.capture.startedAt,
      },
    });
    const report = await promise;
    expect(report.restrictedRecovery).not.toBe(false);
    if (report.restrictedRecovery === false)
      throw new Error('Restricted recovery was not reported.');
    expect(Date.parse(report.restrictedRecovery.lossDetectedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(report.restrictedRecovery.lossDetectedAt)).toBeLessThanOrEqual(Date.now());
    expect(rows(coreDbPath(f.dataRoot), 'recurring_schedules')).toEqual([
      expect.objectContaining({ id: schedule.id, status: 'paused', next_scheduled_at: null }),
    ]);
    expect(f.inspectChannel()).toMatchObject({ status: 'unavailable' });
    const audit = rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events');
    expect(
      audit.some(
        (row) =>
          JSON.stringify(row).includes(f.manifest.backupId) &&
          JSON.stringify(row).includes(
            report.restrictedRecovery === false ? '' : report.restrictedRecovery.captureStartedAt
          )
      )
    ).toBe(true);
  }, 120_000);

  it('WM 389 / exact-command restart: committed restore wins before rereading a subsequently damaged bundle', async () => {
    const f = await fixture();
    const first = runCli(f.argv, () => {}, f);
    await expect(first).resolves.toMatchObject({ disposition: 'restored', workspaceId });
    const committed = await first;
    writeFileSync(join(f.bundleRoot, 'manifest.json'), 'AFTER-COMMIT-DAMAGE');
    const before = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    await expect(runCli(f.argv, () => {}, f)).resolves.toEqual(committed);
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(before);
  }, 120_000);

  it('WM 389 / command identity: changed backup under the same request refuses request-conflict', async () => {
    const f = await fixture();
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({ disposition: 'restored' });
    f.writeManifest({ ...f.manifest, backupId: allocateEntityId('wsbak') });
    await refuses(f, 'request-conflict');
  }, 120_000);

  it.each([
    'releaseTag',
    'sourceCommit',
  ] as const)('WM 356, 379: a different installed %s refuses release-mismatch', async (field) => {
    const f = await fixture();
    writeFileSync(
      f.releaseIdentityPath,
      JSON.stringify({
        ...release,
        [field]: field === 'releaseTag' ? 'v0.1.0-rc.12' : '2'.repeat(40),
      })
    );
    await refuses(f, 'release-mismatch');
  }, 120_000);
});
