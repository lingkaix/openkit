import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AdministratorCleanupItemSchema,
  AdministratorCleanupSourceObservationSchema,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  setDefaultServerAdminTokenId,
} from '../auth/access-token-store.js';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { readRuntimeCleanupView } from './administrator-cleanup-view.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';
import {
  createWorkerStorageBinding,
  markWorkerStoragePurgePending,
  reserveWorkerStorageAttachment,
  settleWorkerStoragePurge,
} from './worker-storage-bindings.js';

const NOW = '2026-10-16T00:00:10.000Z';
const CREATED = '2026-10-16T00:00:00.000Z';
const SOURCES = [
  'execution-attempt',
  'backend-session',
  'agent-session-binding',
  'sandbox-runtime',
  'worker-storage',
] as const;
const TABLES = [
  'scheduler_execution_attempts',
  'worker_backend_sessions',
  'agent_session_runtime_bindings',
  'sandbox_runtime_records',
  'worker_storage_bindings',
] as const;
const OWNER_PATHS = [
  'docs/specs/20260703-durable_scheduler_design.md',
  'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'docs/specs/20260910-persistent_worker_volumes.md',
];
const PRIVATE = 'private-cleanup-canary';
const fixtures: Array<{ coreDb: CoreDb; dataRoot: string }> = [];

/** Builds current identity, Token, Workspace and NanoHost authority through their real owners. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'administrator-cleanup-'));
  const coreDb = openCoreDb(dataRoot);
  fixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  coreDb.sqlite.pragma('journal_mode = WAL');
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_cleanup', ownerUserId: 'user_local' });
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES ('admin_cleanup', 'Administrator', 'cleanup@example.invalid', 0, 0, 0, 'human', 'active')`
    )
    .run();
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'admin_cleanup',
    scope: 'server-admin',
    workspaceIds: [],
    now: new Date(CREATED),
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'admin_cleanup',
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
  };
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment_cleanup',
    identityId: 'identity_cleanup',
    targetId: 'target_cleanup',
    observedAt: CREATED,
  });
  upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: CREATED,
  });
  return { coreDb, dataRoot, actor, token };
}

/** Creates an exact prepared attempt without launching a Worker or opening Workspace content. */
function attempt(coreDb: CoreDb, id = 'attempt_001') {
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${id}`,
    triggerActor: { kind: 'user', id: 'user_local' },
    workspaceId: 'ws_cleanup',
    threadId: `thread_${id}`,
    turnId: `turn_${id}`,
    turnInput: PRIVATE,
    requestedAgentId: 'agent_cleanup',
    now: () => CREATED,
  });
  return recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: id,
    agentSessionId: `session_${id}`,
    inputRef: `package_${id}`,
    bindingRef: `binding_${id}`,
    sessionCompatibilityKey: 'b'.repeat(64),
    now: () => CREATED,
  });
}

/** Composes each actual Core record producer; physical effects are never requested. */
function populate(coreDb: CoreDb) {
  const execution = attempt(coreDb);
  recordWorkerBackendSessionMaterializing(coreDb, {
    identity: {
      agentSessionId: execution.agentSessionId!,
      backendKind: 'openshell',
      backendSessionId: PRIVATE,
      deploymentId: 'deployment_cleanup',
      packageSnapshotId: execution.inputRef!,
      runtimeTargetId: 'target_cleanup',
      stagingDirectoryRef: `server/runtime/${PRIVATE}`,
    },
    lineage: {
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
    },
    backendLineage: { kind: 'reference', imageRef: `registry.example/${PRIVATE}` },
    sandboxBindingRef: execution.bindingRef!,
    now: () => CREATED,
  });
  createNanoHostHarnessRuntime(coreDb, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: 'harness_cleanup',
    harnessBindingRef: 'harness_binding_cleanup',
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: 'sandbox_binding_cleanup',
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: 'integration_cleanup',
    sandboxRuntimeId: 'sandbox_cleanup',
    runtimeTargetId: 'target_cleanup',
    timestamp: CREATED,
  });
  openNanoHostAgentSessionBinding(coreDb, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: execution.agentSessionId!,
    agentSessionRuntimeBindingId: 'binding_cleanup',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness_cleanup',
    threadId: execution.threadId,
    workspaceId: execution.workspaceId,
    timestamp: CREATED,
  });
  const storage = createWorkerStorageBinding(coreDb, {
    deploymentId: 'deployment_cleanup',
    runtimeTargetId: 'target_cleanup',
    workspaceId: 'ws_cleanup',
    now: CREATED,
    layout: {
      family: 'worker',
      version: '1',
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'amd64', os: 'linux' },
      targets: [{ target: '/workspace' }],
    },
  });
  return { execution, storage };
}

/** Calls the runtime seam with trusted context and fixed public ceilings. */
async function read(input: ReturnType<typeof fixture>, maxEntries = 100, maxBytes = 262144) {
  const result = await readRuntimeCleanupView({
    coreDb: input.coreDb,
    actor: input.actor,
    now: new Date(NOW),
    maxEntries,
    maxBytes,
  });
  for (const item of result.items) expect(AdministratorCleanupItemSchema.parse(item)).toEqual(item);
  for (const source of result.sources)
    expect(AdministratorCleanupSourceObservationSchema.parse(source)).toEqual(source);
  return result;
}

/** Captures all persisted Core rows independently of the projected field whitelist. */
function rows(coreDb: CoreDb) {
  const tables = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => ({
    name,
    rows: coreDb.sqlite
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
      .all(),
  }));
}

/** Captures file identities and bytes, including unexpected discoveries or cleanup results. */
function files(root: string, directory = root): Array<[string, string]> {
  return readdirSync(directory)
    .sort()
    .flatMap((name): Array<[string, string]> => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? files(root, path)
        : [[relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex')]];
    });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const entry of fixtures.splice(0)) {
    if (entry.coreDb.sqlite.open) entry.coreDb.sqlite.close();
    rmSync(entry.dataRoot, { recursive: true, force: true });
  }
});

describe('administrator runtime cleanup view', () => {
  it('declares all five empty runtime sources without inferring cleanup certainty', async () => {
    const result = await read(fixture());
    expect(result).toEqual({
      observedAt: NOW,
      items: [],
      sources: SOURCES.map((source) => ({
        source,
        availability: 'available',
        incomplete: false,
        reasons: [],
      })),
      incomplete: false,
    });
  });

  it('projects all five actual producers with source identity, original timestamps and no private material', async () => {
    const input = fixture();
    const { execution, storage } = populate(input.coreDb);
    const result = await read(input);
    expect(result.sources.map((source) => source.source)).toEqual(SOURCES);
    expect(result.items.map((item) => item.source)).toEqual(SOURCES);
    expect(result.items.map((item) => item.sourceOwner)).toEqual(OWNER_PATHS);
    expect(
      result.items.every((item) => item.observedAt === NOW && item.sourceUpdatedAt === CREATED)
    ).toBe(true);
    expect(result.items[0]?.target).toMatchObject({
      attemptId: execution.attemptId,
      workspaceId: 'ws_cleanup',
      threadId: execution.threadId,
      turnId: execution.turnId,
      agentSessionId: execution.agentSessionId,
    });
    expect(result.items[1]?.target).toMatchObject({ attemptId: execution.attemptId });
    expect(result.items[2]?.target).toMatchObject({
      agentSessionRuntimeBindingId: 'binding_cleanup',
      agentSessionId: execution.agentSessionId,
    });
    expect(result.items[3]?.target).toMatchObject({
      sandboxRuntimeId: 'sandbox_cleanup',
      runtimeTargetId: 'target_cleanup',
    });
    expect(result.items[4]?.target).toMatchObject({
      storageRef: storage.storageRef,
      workspaceId: 'ws_cleanup',
      runtimeTargetId: 'target_cleanup',
    });
    expect(result.items[0]?.state).toMatchObject({ phase: 'open', disposition: 'not_accepted' });
    expect(result.items[1]?.state).toMatchObject({
      state: 'materializing',
      workspaceHandoffState: 'pending',
      physicalCleanedAt: null,
      physicalEpochRelation: 'same',
    });
    expect(result.items[2]?.state).toMatchObject({
      lifecycleState: 'opening',
      cleanupState: 'clean',
    });
    expect(result.items[3]?.state).toMatchObject({
      lifecycleState: 'open',
      healthState: 'ready',
      drainState: 'accepting',
      cleanupState: 'clean',
      physicalEpochRelation: 'same',
    });
    expect(result.items[4]?.state).toMatchObject({
      state: 'idle',
      revision: 1,
      purgedAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toMatch(
      /(?:stagingDirectoryRef|preparationInputJson|backendSessionId|imageDigest|scopeDigest|targetsJson|nativeHandleDigest|terminalCause)/
    );
    expect(result.incomplete).toBe(false);
  });

  it('does not substitute row timestamps or observation time for absent source cleanup proof', async () => {
    const input = fixture();
    populate(input.coreDb);
    const result = await read(input);
    for (const item of result.items) {
      expect(item.evidence).toEqual({ kind: 'unknown', reason: 'missing' });
      expect(item.nextInspection).toEqual({
        kind: 'source-record',
        sourceOwner: item.sourceOwner,
        target: item.target,
      });
    }
    expect(result.incomplete).toBe(false);
  });

  it('records backend physical cleanup with its original proof timestamp and exact source target', async () => {
    const input = fixture();
    const { execution } = populate(input.coreDb);
    transitionWorkerBackendSessionState(input.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'materializing',
      toState: 'cleanup-pending',
      now: () => CREATED,
    });
    transitionWorkerBackendSessionState(input.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'cleanup-pending',
      toState: 'physical-cleaned',
      now: () => CREATED,
    });
    transitionWorkerBackendSessionState(input.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
      now: () => NOW,
    });
    const result = await read(input);
    const backend = result.items.find((item) => item.source === 'backend-session')!;
    expect(backend.sourceUpdatedAt).toBe(NOW);
    expect(backend.state).toEqual({
      state: 'cleaned',
      workspaceHandoffState: 'pending',
      physicalCleanedAt: CREATED,
      physicalEpochRelation: 'same',
    });
    expect(backend.evidence).toEqual({
      kind: 'recorded',
      recordedAt: CREATED,
      reference: backend.target,
    });
    expect(result.items.find((item) => item.source === 'execution-attempt')?.state).toEqual({
      phase: 'open',
      disposition: 'not_accepted',
    });
  });

  it('keeps contradictory backend state and proof explicit instead of inferring cleanup', async () => {
    const input = fixture();
    populate(input.coreDb);
    input.coreDb.sqlite
      .prepare('UPDATE worker_backend_sessions SET physical_cleaned_at = ?')
      .run(CREATED);
    const result = await read(input);
    const backend = result.items.find((item) => item.source === 'backend-session')!;
    expect(backend.state).toMatchObject({ state: 'materializing', physicalCleanedAt: CREATED });
    expect(backend.evidence).toEqual({ kind: 'unknown', reason: 'contradictory' });
  });

  it('preserves stale Epoch uncertainty when current connection readiness is lost', async () => {
    const input = fixture();
    populate(input.coreDb);
    recordNanoHostRuntimeTargetConnectionClose(input.coreDb, {
      targetId: 'target_cleanup',
      closedGeneration: 1,
      authoritativeGeneration: null,
      observedAt: NOW,
    });
    const result = await read(input);
    for (const source of ['backend-session', 'sandbox-runtime']) {
      const item = result.items.find((entry) => entry.source === source)!;
      expect(item.state).toMatchObject({ physicalEpochRelation: 'unknown' });
      expect(item.evidence).toEqual({ kind: 'unknown', reason: 'stale' });
    }
    expect(result.incomplete).toBe(false);
  });

  it('preserves a recorded historical backend cleanup receipt after current readiness is lost', async () => {
    const input = fixture();
    const { execution } = populate(input.coreDb);
    transitionWorkerBackendSessionState(input.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'materializing',
      toState: 'cleanup-pending',
      now: () => CREATED,
    });
    transitionWorkerBackendSessionState(input.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'cleanup-pending',
      toState: 'physical-cleaned',
      now: () => CREATED,
    });
    recordNanoHostRuntimeTargetConnectionClose(input.coreDb, {
      targetId: 'target_cleanup',
      closedGeneration: 1,
      authoritativeGeneration: null,
      observedAt: NOW,
    });
    const result = await read(input);
    const backend = result.items.find((item) => item.source === 'backend-session')!;
    expect(backend.state).toMatchObject({
      state: 'physical-cleaned',
      physicalCleanedAt: CREATED,
      physicalEpochRelation: 'unknown',
    });
    expect(backend.evidence).toEqual({
      kind: 'recorded',
      recordedAt: CREATED,
      reference: backend.target,
    });
  });

  it('reports a different freshly admitted physical Epoch without manufacturing cleanup proof', async () => {
    const input = fixture();
    populate(input.coreDb);
    const successor = allocateNanoHostRuntimeTargetConnectionGeneration(input.coreDb, {
      targetId: 'target_cleanup',
      identityId: 'identity_cleanup',
      deploymentId: 'deployment_cleanup',
      observedAt: NOW,
    });
    upsertNanoHostRuntimeTarget(input.coreDb, {
      ...successor,
      physicalEpoch: 'e'.repeat(64),
      freshEmpty: true,
      predecessorFenced: true,
      ready: true,
      observedAt: NOW,
    });
    const result = await read(input);
    for (const source of ['backend-session', 'sandbox-runtime']) {
      const item = result.items.find((entry) => entry.source === source)!;
      expect(item.state).toMatchObject({ physicalEpochRelation: 'different' });
      expect(item.evidence.kind).toBe('unknown');
    }
  });

  it('records retained-storage purge only from the exact settled purge timestamp', async () => {
    const input = fixture();
    const { storage } = populate(input.coreDb);
    const pending = markWorkerStoragePurgePending(input.coreDb, {
      storageRef: storage.storageRef,
      expectedRevision: storage.revision,
      now: CREATED,
      authorizePurge: () =>
        Boolean(requireCurrentDeploymentAdmin(input.coreDb, input.actor, new Date(NOW))),
      hasSurvivingReferences: () =>
        Boolean(
          input.coreDb.sqlite
            .prepare('SELECT 1 FROM worker_storage_contributors WHERE storage_ref = ? LIMIT 1')
            .get(storage.storageRef)
        ),
    });
    const settled = settleWorkerStoragePurge(input.coreDb, {
      storageRef: storage.storageRef,
      expectedRevision: pending.revision,
      outcome: 'purged',
      now: CREATED,
    });
    input.coreDb.sqlite
      .prepare('UPDATE worker_storage_bindings SET updated_at = ? WHERE storage_ref = ?')
      .run(NOW, storage.storageRef);
    const result = await read(input);
    const item = result.items.find((entry) => entry.source === 'worker-storage')!;
    expect(item.state).toEqual({ state: 'purged', revision: settled.revision, purgedAt: CREATED });
    expect(item.sourceUpdatedAt).toBe(NOW);
    expect(item.evidence).toEqual({
      kind: 'recorded',
      recordedAt: CREATED,
      reference: item.target,
    });
  });

  it.each([
    'ordinary',
    'readonly',
    'disabled',
    'revoked',
    'expired',
  ] as const)('refuses %s authority before enumerating any runtime source', async (kind) => {
    const input = fixture();
    populate(input.coreDb);
    if (kind === 'ordinary' || kind === 'readonly') {
      const scope = kind === 'readonly' ? 'workspace-readonly' : 'workspace';
      const issued = createOpenKitAccessTokenRecord(input.coreDb, {
        ownerUserId: 'admin_cleanup',
        scope,
        workspaceIds: ['ws_cleanup'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      input.actor = {
        kind: 'token',
        userId: 'admin_cleanup',
        tokenId: issued.tokenId,
        tokenScope: scope,
      };
    } else if (kind === 'disabled') {
      input.coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled' WHERE id = 'admin_cleanup'")
        .run();
    } else if (kind === 'revoked') {
      revokeOpenKitAccessTokenRecord(input.coreDb, input.token.tokenId, new Date(NOW));
    } else {
      input.coreDb.sqlite
        .prepare('UPDATE openkit_access_tokens SET expires_at = ? WHERE token_id = ?')
        .run(CREATED, input.token.tokenId);
    }
    const prepare = vi.spyOn(input.coreDb.sqlite, 'prepare');
    await expect(async () => read(input)).rejects.toBeInstanceOf(DeploymentAdminRequiredError);
    expect(
      prepare.mock.calls.filter(([sql]) => TABLES.some((table) => sql.includes(table)))
    ).toEqual([]);
  });

  it('rechecks a previously successful administrator instead of retaining admission', async () => {
    const input = fixture();
    populate(input.coreDb);
    expect((await read(input)).items).toHaveLength(5);
    revokeOpenKitAccessTokenRecord(input.coreDb, input.token.tokenId, new Date(NOW));
    await expect(async () => read(input)).rejects.toBeInstanceOf(DeploymentAdminRequiredError);
  });

  it('uses the current selected administrator Token for a session without manufacturing membership', async () => {
    const input = fixture();
    populate(input.coreDb);
    expect(
      setDefaultServerAdminTokenId(
        input.coreDb,
        input.actor.userId,
        input.token.tokenId,
        new Date(NOW)
      )
    ).toBe(true);
    input.actor = { kind: 'session', userId: input.actor.userId };
    expect((await read(input)).items).toHaveLength(5);
    expect(
      input.coreDb.sqlite
        .prepare("SELECT * FROM workspace_members WHERE user_id = 'admin_cleanup'")
        .all()
    ).toEqual([]);
    revokeOpenKitAccessTokenRecord(input.coreDb, input.token.tokenId, new Date(NOW));
    await expect(async () => read(input)).rejects.toBeInstanceOf(DeploymentAdminRequiredError);
  });

  it('fails the operation when current authority storage is missing', async () => {
    const input = fixture();
    input.coreDb.sqlite.exec('DROP TABLE openkit_access_tokens');
    await expect(async () => read(input)).rejects.toThrow();
  });

  it.each(TABLES)('keeps independent source observations when %s is unavailable', async (table) => {
    const input = fixture();
    populate(input.coreDb);
    input.coreDb.sqlite.exec(`ALTER TABLE ${table} RENAME TO unavailable_${table}`);
    const result = await read(input);
    const source = SOURCES[TABLES.indexOf(table)];
    expect(result.sources.find((entry) => entry.source === source)).toEqual({
      source,
      availability: 'unavailable',
      incomplete: true,
      reasons: ['source_unavailable'],
    });
    expect(result.items.some((item) => item.source === source)).toBe(false);
    expect(result.items.some((item) => item.source !== source)).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(`unavailable_${table}`);
  });

  it('withholds malformed required identity and unknown owner state without leaking invalid rows', async () => {
    const input = fixture();
    populate(input.coreDb);
    input.coreDb.sqlite.prepare("UPDATE worker_backend_sessions SET thread_id = ''").run();
    input.coreDb.sqlite
      .prepare('UPDATE agent_session_runtime_bindings SET lifecycle_state = ?')
      .run(PRIVATE);
    const result = await read(input);
    for (const source of ['backend-session', 'agent-session-binding']) {
      expect(result.sources.find((entry) => entry.source === source)).toMatchObject({
        availability: 'unavailable',
        incomplete: true,
        reasons: ['source_unavailable'],
      });
      expect(result.items.some((item) => item.source === source)).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it('withholds identifiers when required source Workspace authority is absent', async () => {
    const input = fixture();
    populate(input.coreDb);
    input.coreDb.sqlite
      .prepare("DELETE FROM workspace_registry WHERE workspace_id = 'ws_cleanup'")
      .run();
    const result = await read(input);
    for (const source of [
      'execution-attempt',
      'backend-session',
      'agent-session-binding',
      'worker-storage',
    ]) {
      expect(result.items.some((item) => item.source === source)).toBe(false);
      expect(result.sources.find((entry) => entry.source === source)).toMatchObject({
        availability: 'unavailable',
        incomplete: true,
        reasons: ['source_unavailable'],
      });
    }
    expect(result.items.map((item) => item.source)).toEqual(['sandbox-runtime']);
  });

  it('keeps non-content observations of a deleting Workspace without reopening it', async () => {
    const input = fixture();
    populate(input.coreDb);
    input.coreDb.sqlite
      .prepare(
        "UPDATE workspace_registry SET status = 'deleting' WHERE workspace_id = 'ws_cleanup'"
      )
      .run();
    const before = rows(input.coreDb);
    const result = await read(input);
    expect(result.items).toHaveLength(5);
    expect(rows(input.coreDb)).toEqual(before);
  });

  it('withholds contributed storage whose current private-source audience cannot be proved from Core records', async () => {
    const input = fixture();
    const { storage: empty } = populate(input.coreDb);
    const store = createDemoStore({ dataRoot: input.dataRoot });
    const workspace = store.listWorkspaces().find((entry) => entry.kind === 'code')!;
    recordWorkspaceOwnerMembership({
      coreDb: input.coreDb,
      workspaceId: workspace.id,
      ownerUserId: 'user_local',
    });
    const thread = store.createThread(
      workspace.id,
      PRIVATE,
      'private_cleanup_source',
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_local' }
    );
    const restricted = createWorkerStorageBinding(input.coreDb, {
      deploymentId: 'deployment_cleanup',
      runtimeTargetId: 'target_cleanup',
      workspaceId: workspace.id,
      now: CREATED,
      layout: empty.layout,
    });
    reserveWorkerStorageAttachment(input.coreDb, {
      agentSessionId: 'private_storage_session',
      authorizeContributor: (contributor) =>
        isThreadIdVisible(
          store,
          contributor.workspaceId,
          contributor.threadId,
          contributor.responsibleUserId
        ),
      expectedRevision: restricted.revision,
      layout: restricted.layout,
      purpose: 'work',
      responsibleUserId: 'user_local',
      runtimeTargetId: restricted.runtimeTargetId,
      storageRef: restricted.storageRef,
      threadId: thread.id,
      workspaceId: workspace.id,
      now: CREATED,
    });
    const before = files(input.dataRoot);
    const result = await read(input);
    expect(JSON.stringify(result)).not.toContain(restricted.storageRef);
    expect(JSON.stringify(result)).not.toContain(thread.id);
    expect(result.sources.find((source) => source.source === 'worker-storage')).toMatchObject({
      availability: 'unavailable',
      incomplete: true,
      reasons: ['source_unavailable'],
    });
    expect(files(input.dataRoot)).toEqual(before);
  });

  it('retains stable global source and opaque identity order with one count budget', async () => {
    const input = fixture();
    populate(input.coreDb);
    attempt(input.coreDb, 'attempt_003');
    attempt(input.coreDb, 'attempt_002');
    const first = await read(input, 2);
    const second = await read(input, 2);
    expect(first).toEqual(second);
    expect(first.items.map((item) => item.target)).toEqual([
      expect.objectContaining({ attemptId: 'attempt_001' }),
      expect.objectContaining({ attemptId: 'attempt_002' }),
    ]);
    expect(
      first.sources.every((source) => source.incomplete && source.reasons.includes('count_limit'))
    ).toBe(true);
    expect(first.incomplete).toBe(true);
  });

  it('distinguishes exact count coverage from a sentinel proving omitted entries', async () => {
    const input = fixture();
    attempt(input.coreDb);
    const exact = await read(input, 1);
    expect(exact.items).toHaveLength(1);
    expect(exact.sources[0]?.reasons).not.toContain('count_limit');
    attempt(input.coreDb, 'attempt_002');
    const truncated = await read(input, 1);
    expect(truncated.items).toHaveLength(1);
    expect(truncated.sources[0]).toMatchObject({ incomplete: true, reasons: ['count_limit'] });
  });

  it('consumes no more than the count budget plus its sentinel and stops after proved truncation', async () => {
    const input = fixture();
    populate(input.coreDb);
    for (let index = 2; index <= 25; index += 1)
      attempt(input.coreDb, `attempt_${String(index).padStart(3, '0')}`);
    const prepare = input.coreDb.sqlite.prepare.bind(input.coreDb.sqlite);
    let consumed = 0;
    const selected = new Set<string>();
    vi.spyOn(input.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      const table = TABLES.find((name) =>
        new RegExp(`\\b(?:FROM|JOIN)\\s+${name}\\b`, 'i').test(sql)
      );
      if (!table) return statement;
      selected.add(table);
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...parameters: unknown[]) => {
        const result = all(...parameters);
        consumed += result.length;
        return result;
      });
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...parameters: unknown[]) => {
        const result = get(...parameters);
        if (result) consumed += 1;
        return result;
      });
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, 'iterate').mockImplementation(function* (...parameters: unknown[]) {
        for (const row of iterate(...parameters)) {
          consumed += 1;
          yield row;
        }
      });
      return statement;
    });
    const result = await read(input, 2);
    expect(result.items).toHaveLength(2);
    expect(consumed).toBeLessThanOrEqual(3);
    expect(selected).toEqual(new Set(['scheduler_execution_attempts']));
    expect(
      result.sources
        .slice(1)
        .every((source) => source.incomplete && source.reasons.includes('count_limit'))
    ).toBe(true);
  });

  it('rejects internal budgets above the fixed public ceilings', async () => {
    const input = fixture();
    await expect(async () => read(input, 101)).rejects.toThrow();
    await expect(async () => read(input, 100, 262145)).rejects.toThrow();
  });

  it('counts the complete UTF-8 fragment and coverage flags without cutting identity fields', async () => {
    const input = fixture();
    attempt(input.coreDb, `attempt_${'界'.repeat(150)}`);
    const complete = await read(input);
    const completeBytes = Buffer.byteLength(JSON.stringify(complete), 'utf8');
    expect(completeBytes).toBeGreaterThan(JSON.stringify(complete).length);
    expect(await read(input, 100, completeBytes)).toEqual(complete);
    const truncated = await read(input, 100, completeBytes - 1);
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8')).toBeLessThanOrEqual(
      completeBytes - 1
    );
    expect(truncated.items).toEqual([]);
    expect(truncated.sources[0]).toMatchObject({ incomplete: true, reasons: ['byte_limit'] });
    expect(truncated.incomplete).toBe(true);
  });

  it('refuses a byte budget that cannot contain even the five-source metadata', async () => {
    await expect(async () => read(fixture(), 100, 1)).rejects.toThrow();
  });

  it('does not mutate SQLite or files, including unknown cleanup records and inert filesystem entries', async () => {
    const input = fixture();
    populate(input.coreDb);
    input.coreDb.sqlite.prepare("UPDATE worker_storage_bindings SET state = 'unknown'").run();
    input.coreDb.sqlite
      .prepare(
        "UPDATE sandbox_runtime_records SET cleanup_state = 'unknown', health_state = 'unknown'"
      )
      .run();
    writeFileSync(join(input.dataRoot, 'orphan-cleanup-canary'), PRIVATE);
    const beforeRows = rows(input.coreDb);
    const beforeFiles = files(input.dataRoot);
    input.coreDb.sqlite.pragma('query_only = ON');
    const result = await read(input);
    expect(result.items.find((item) => item.source === 'worker-storage')?.state).toMatchObject({
      state: 'unknown',
    });
    expect(rows(input.coreDb)).toEqual(beforeRows);
    expect(files(input.dataRoot)).toEqual(beforeFiles);
  });

  it('reads current canonical records after reopening instead of using a retained summary', async () => {
    const input = fixture();
    populate(input.coreDb);
    await read(input);
    input.coreDb.sqlite.close();
    input.coreDb = openCoreDb(input.dataRoot);
    fixtures[fixtures.length - 1]!.coreDb = input.coreDb;
    input.coreDb.sqlite
      .prepare("UPDATE worker_backend_sessions SET state = 'cleanup-failed', updated_at = ?")
      .run(NOW);
    const result = await read(input);
    expect(result.items.find((item) => item.source === 'backend-session')).toMatchObject({
      sourceUpdatedAt: NOW,
      state: { state: 'cleanup-failed', workspaceHandoffState: 'pending' },
    });
  });

  it('preserves actual source state and timestamp tuples during a concurrent owner transition', async () => {
    const input = fixture();
    const { execution } = populate(input.coreDb);
    const concurrent = openCoreDb(input.dataRoot);
    const prepare = input.coreDb.sqlite.prepare.bind(input.coreDb.sqlite);
    let changed = false;
    try {
      const probe = vi.spyOn(input.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
        if (!changed && /\bFROM\s+scheduler_execution_attempts\b/i.test(sql)) {
          changed = true;
          transitionWorkerBackendSessionState(concurrent, {
            attemptId: execution.attemptId,
            fromState: 'materializing',
            toState: 'cleanup-pending',
            now: () => NOW,
          });
        }
        return prepare(sql);
      });
      const during = await read(input);
      expect(changed).toBe(true);
      const backend = during.items.find((item) => item.source === 'backend-session');
      expect(backend).toBeDefined();
      expect([
        { sourceUpdatedAt: CREATED, state: 'materializing' },
        { sourceUpdatedAt: NOW, state: 'cleanup-pending' },
      ]).toContainEqual({ sourceUpdatedAt: backend?.sourceUpdatedAt, state: backend?.state.state });
      probe.mockRestore();
      expect(
        (await read(input)).items.find((item) => item.source === 'backend-session')
      ).toMatchObject({
        sourceUpdatedAt: NOW,
        state: { state: 'cleanup-pending', workspaceHandoffState: 'pending' },
      });
    } finally {
      concurrent.sqlite.close();
    }
  });
});
