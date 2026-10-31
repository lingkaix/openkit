import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import {
  ApiCallError,
  parseWorkspaceSharingError,
} from '../../../packages/core-client/src/index.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  schedulerExecutionCorrelation,
} from './runtime/execution-attempt-records.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  openNanoHostAgentSessionBinding,
  settleNanoHostHarnessOperation,
} from './runtime/nanohost-harness-records.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { retrieveWorkspaceKnowledge } from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { WORKSPACE_BACKUP_POLICY } from './storage/workspace-backup.js';
import {
  readWorkspaceSnapshotMetadata,
  withVerifiedWorkspaceSnapshotSource,
} from './storage/workspace-backup-bundle.js';
import { recordTestAgentEnvironmentPackage } from './test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { testEntityId } from './test-support/entity-ids.js';
import {
  queueTestPreparedHarnessOperation,
  recordTestExecutionAttempt,
} from './test-support/execution-attempt.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from './test-support/native-environment.js';
import { operationRequest } from './test-support/operation-request.js';
import { WORKSPACE_DELETION_LEGAL_HOLD_OWNERS } from './workspace-deletion-evidence.js';
import * as deletionRequestOwner from './workspace-deletion-request.js';
import {
  createWorkspaceDeletionRequest,
  readWorkspaceDeletionRequest,
  workspaceDeletionStagingRelativePath,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import {
  ensureUserQuickChatWorkspace,
  listActiveWorkspaceIdsForActor,
  recordWorkspaceOwnerMembership,
  resolveWorkspaceMembershipRelation,
} from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { beginWorkspaceDeletion, completeWorkspaceDeletion } from './workspace-sharing.js';

it.each([
  'workspace',
  'server-admin',
] as const)('refuses personal home deletion before effects for a %s credential', async (scope) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-personal-deletion-'));
  const coreDb = openCoreDb(dataRoot);
  const gateway = createDefaultWorkerMcpGateway(coreDb);
  const close = vi.spyOn(gateway, 'closeWorkspace');
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    await ensureUserQuickChatWorkspace({ coreDb, store, userId });
    const workspaceId = quickChatWorkspaceIdForUser(userId);
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: userId,
      scope,
      workspaceIds: scope === 'workspace' ? [workspaceId] : [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const admission = new WorkspaceMutationAdmission();
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      workerMcpGateway: gateway,
      workspaceMutationAdmission: admission,
    });
    const headers = {
      authorization: `Bearer ${token.secret}`,
      'content-type': 'application/json',
    };
    const readable = await app.request(
      ...operationRequest('workspace.read', { workspaceId }, { headers })
    );
    expect(readable.status).toBe(200);
    // Preserve full retained authority and files, not only the directory's existence.
    const authority = () => [
      coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .get(workspaceId),
      coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
        .all(workspaceId),
    ];
    const homeRoot = join(dataRoot, 'workspaces', workspaceId);
    const homeBytes = () =>
      readdirSync(homeRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.endsWith('-shm'))
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
        .map((path) => [path, readFileSync(path)]);
    const beforeAuthority = authority();
    const beforeBytes = homeBytes();
    const requestId = randomUUID();
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId },
        {
          headers,
          method: 'POST',
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspaceId}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
        }
      )
    );
    expect(response.status).toBe(409);
    // Current API Projection owns the personal deletion code and absence of details.
    const error = await response.json();
    expect(error.code).toBe('personal_workspace_not_deletable');
    expect(error).not.toHaveProperty('details');
    expect(
      parseWorkspaceSharingError(new ApiCallError(response.status, error.message, error))
    ).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(admission.isClosed(workspaceId)).toBe(false);
    expect(authority()).toEqual(beforeAuthority);
    expect(homeBytes()).toEqual(beforeBytes);
    expect(
      existsSync(join(dataRoot, 'server', 'exports', 'workspace-deletions', workspaceId, requestId))
    ).toBe(false);
    expect(existsSync(join(dataRoot, 'server', 'exports', 'workspaces', workspaceId))).toBe(false);
  } finally {
    close.mockRestore();
    await gateway.close();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it.each([
  ['requested', false],
  ['fenced', false],
  ['requested', true],
] as const)('rechecks deletion authority in %s (personal=%s)', async (phase, personal) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-deletion-current-credential-'));
  const coreDb = openCoreDb(dataRoot);
  let gateway: ReturnType<typeof createDefaultWorkerMcpGateway> | undefined;
  let responsePromise: Promise<Response> | undefined;
  let releaseClose = () => {};
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    if (personal) await ensureUserQuickChatWorkspace({ coreDb, store, userId });
    const workspace = personal
      ? store.getWorkspace(quickChatWorkspaceIdForUser(userId))
      : await store.createWorkspace('Current deletion credential');
    if (!personal) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: workspace.id,
      });
    }
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: phase === 'requested' ? 'workspace' : 'server-admin',
      workspaceIds: phase === 'requested' ? [workspace.id] : [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const admission = new WorkspaceMutationAdmission();
    gateway = createDefaultWorkerMcpGateway(coreDb);
    const closeWorkspace = gateway.closeWorkspace.bind(gateway);
    const heldClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = vi.spyOn(gateway, 'closeWorkspace').mockImplementationOnce(async (id) => {
      await heldClose;
      await closeWorkspace(id);
    });
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workerMcpGateway: gateway,
      workspaceMutationAdmission: admission,
    });
    // Admission must be idle so the real public freeze reaches the awaited MCP boundary.
    const request = createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      requestId: randomUUID(),
      workspaceId: workspace.id,
    });
    if (phase === 'fenced') {
      writeWorkspaceDeletionRequest(dataRoot, { ...request, phase });
    }
    const before = readWorkspaceDeletionRequest(dataRoot, workspace.id, request.requestId);
    responsePromise = Promise.resolve(
      app.request(
        ...operationRequest(
          'workspace.delete',
          { workspaceId: workspace.id },
          {
            headers: { authorization: `Bearer ${token.secret}` },
            body: JSON.stringify({
              confirmation: request.confirmation,
              expectedRegistryRevision: request.expectedRegistryRevision,
              requestId: request.requestId,
            }),
          }
        )
      )
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(workspace.id), {
      timeout: 10_000,
    });
    revokeOpenKitAccessTokenRecord(coreDb, token.tokenId);
    releaseClose();
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'recovery_required' });
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, request.requestId)).toEqual(before);
    expect(admission.isClosed(workspace.id)).toBe(true);
    expect(
      coreDb.sqlite
        .prepare(
          'SELECT owner_user_id, status, revision FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(workspace.id)
    ).toEqual({
      owner_user_id: 'usr_00000000-0000-7000-8000-000000000001',
      status: 'active',
      revision: 1,
    });
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(true);
    expect(existsSync(join(dataRoot, 'server', 'exports', 'workspaces', workspace.id))).toBe(false);
  } finally {
    releaseClose();
    await responsePromise;
    await gateway?.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('resumes an exact fenced request after its registry transition without ordinary membership authority', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-deletion-fenced-restart-'));
  const coreDb = openCoreDb(dataRoot);
  const gateway = createDefaultWorkerMcpGateway(coreDb);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Fenced deletion restart');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const admission = new WorkspaceMutationAdmission();
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workerMcpGateway: gateway,
      workspaceMutationAdmission: admission,
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
    });
    const command = {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      expectedRegistryRevision: 1,
      requestId: randomUUID(),
    };
    const originalWrite = deletionRequestOwner.writeWorkspaceDeletionRequest;
    const phaseWrite = vi.spyOn(deletionRequestOwner, 'writeWorkspaceDeletionRequest');
    let interrupted = false;
    try {
      phaseWrite.mockImplementation((root, record) => {
        if (record.workspaceId === workspace.id && record.phase === 'exported') {
          interrupted = true;
          throw new Error('Injected failure after the real cut and Core transition.');
        }
        return originalWrite(root, record);
      });
      const interruptedResponse = await app.request(
        ...operationRequest(
          'workspace.delete',
          { workspaceId: workspace.id },
          {
            headers: { authorization: `Bearer ${token.secret}` },
            body: JSON.stringify(command),
          }
        )
      );
      expect(interruptedResponse.status).toBe(409);
      expect(await interruptedResponse.json()).toMatchObject({ code: 'recovery_required' });
    } finally {
      phaseWrite.mockRestore();
    }
    expect(interrupted).toBe(true);
    const request = readWorkspaceDeletionRequest(dataRoot, workspace.id, command.requestId);
    expect(request.phase).toBe('fenced');
    const backup = await readWorkspaceSnapshotMetadata({
      ...WORKSPACE_BACKUP_POLICY,
      dataRoot,
      workspaceId: workspace.id,
      backupId: request.recoveryBackupId!,
    });
    expect(request.recoveryBackupManifestDigest).toBe(backup.manifestDigest);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ status: 'deleting', revision: 2 });
    expect(
      resolveWorkspaceMembershipRelation(
        coreDb,
        workspace.id,
        'usr_00000000-0000-7000-8000-000000000001'
      )
    ).toBeNull();
    // The pre-transition cut digest remains binding after Core CAS and before phase publication.
    const backupRoot = join(
      dataRoot,
      'server',
      'backups',
      'workspaces',
      workspace.id,
      request.recoveryBackupId!
    );
    const backupBytes = () =>
      ['manifest.json', 'seal.json'].map((name) => [name, readFileSync(join(backupRoot, name))]);
    const beforeBackupBytes = backupBytes();
    const terminalFacts = () => [
      coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id),
      coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND request_id = ?'
        )
        .get(workspace.id, request.requestId),
      coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_id = ?')
        .get(request.requestId),
    ];
    const beforeTerminalFacts = terminalFacts();
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    expect(request.recoveryBackupManifestDigest).not.toBe(wrongDigest);
    const substituted = { ...request, recoveryBackupManifestDigest: wrongDigest };
    writeWorkspaceDeletionRequest(dataRoot, substituted);
    const retainedPath = join(
      dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      workspace.id,
      request.requestId,
      'request.json'
    );
    const substitutedBytes = readFileSync(retainedPath);
    const refused = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          headers: { authorization: `Bearer ${token.secret}` },
          body: JSON.stringify(command),
        }
      )
    );
    expect(refused.status).toBe(409);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, request.requestId)).toEqual(
      substituted
    );
    expect(readFileSync(retainedPath)).toEqual(substitutedBytes);
    expect(terminalFacts()).toEqual(beforeTerminalFacts);
    expect(backupBytes()).toEqual(beforeBackupBytes);
    expect(admission.isClosed(workspace.id)).toBe(true);
    writeWorkspaceDeletionRequest(dataRoot, request);
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          headers: { authorization: `Bearer ${token.secret}` },
          body: JSON.stringify({
            confirmation: request.confirmation,
            expectedRegistryRevision: request.expectedRegistryRevision,
            requestId: request.requestId,
          }),
        }
      )
    );
    expect(response.status).toBe(200);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, request.requestId)).toMatchObject({
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      phase: 'cleaned',
    });
    expect(admission.isClosed(workspace.id)).toBe(true);
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
  } finally {
    await closeRetrievalServices();
    await gateway.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('keeps every durable legal-hold schema in the deletion-owner inventory', () => {
  const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
  const schemaRoots = [
    join(repositoryRoot, 'apps', 'nanocore', 'src', 'storage', 'schema'),
    join(repositoryRoot, 'packages', 'app-api-schemas', 'src'),
  ];
  const carriers = schemaRoots
    .flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[])
        .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
        .filter((path) => readFileSync(join(root, path), 'utf8').includes("'legal-hold'"))
        .map((path) => relative(repositoryRoot, join(root, path)))
    )
    .sort();

  expect(carriers).toEqual([
    'apps/nanocore/src/storage/schema/evidence-bundles.ts',
    'packages/app-api-schemas/src/evidence-bundles.ts',
    'packages/app-api-schemas/src/workspace-sync.ts',
  ]);
  expect(WORKSPACE_DELETION_LEGAL_HOLD_OWNERS).toEqual([
    'evidence-bundle',
    'workspace-quarantine-record',
  ]);
});

it.each(
  WORKSPACE_DELETION_LEGAL_HOLD_OWNERS
)('blocks deletion before effects for a legal hold owned by %s', async (owner) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-hold-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Legal hold fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    try {
      applyScopedMigrations(workspaceDb);
      const timestamp = new Date().toISOString();
      if (owner === 'evidence-bundle') {
        workspaceDb.sqlite
          .prepare(
            `INSERT INTO evidence_bundles (
                evidence_bundle_id, workspace_id, thread_id, goal_id, turn_id,
                agent_session_id, backend_type, source_kind, summary,
                raw_evidence_refs_json, redacted_evidence_refs_json, content_digests_json,
                retention_class, sensitivity_class, import_status, required_features_json, created_at
              ) VALUES (
                'ev_hold', ?, NULL, NULL, NULL, NULL, NULL, 'test', 'Legal hold',
                '[]', '[]', '[]', 'legal-hold', 'product-safe', 'verified', '[]', ?
              )`
          )
          .run(workspace.id, timestamp);
      } else {
        workspaceDb.sqlite
          .prepare(
            `INSERT INTO workspace_quarantine_records (
                quarantine_record_id, workspace_id, failure_kind, resolution,
                payload_json, created_at, updated_at, resolved_at
              ) VALUES ('quarantine_hold', ?, 'schema_failure', 'pending', ?, ?, ?, NULL)`
          )
          .run(
            workspace.id,
            JSON.stringify({
              id: 'quarantine_hold',
              workspaceId: workspace.id,
              lifecycleRecordIds: [],
              failureKind: 'schema_failure',
              storageRef: 'evidence/quarantine/quarantine_hold.json',
              retentionClass: 'legal-hold',
              requiredHumanDecision: 'Release legal hold.',
              resolution: 'pending',
              createdAt: timestamp,
              updatedAt: timestamp,
              resolvedAt: null,
            }),
            timestamp,
            timestamp
          );
      }
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const requestId =
      owner === 'evidence-bundle'
        ? '00000000-0000-4000-8000-000000000013'
        : '00000000-0000-4000-8000-000000000014';
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'workspace_deletion_blocked',
      details: {
        holdRecordIds: [owner === 'evidence-bundle' ? 'ev_hold' : 'quarantine_hold'],
      },
    });
    expect(
      existsSync(
        join(dataRoot, 'server', 'exports', 'workspace-deletions', workspace.id, requestId)
      )
    ).toBe(false);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('refuses running work before admission and preserves exact deletion retry after cleanup failure', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-route-'));
  const coreDb = openCoreDb(dataRoot);
  const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
  const closeWorkspaceMcpSessions = vi.spyOn(workerMcpGateway, 'closeWorkspace');

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Deletion fixture');
    const app = createApp({
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workerMcpGateway,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const thread = await store.createThread(
      workspace.id,
      'Deletion quiescence blocker',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001' }
    );
    const timestamp = new Date().toISOString();
    await store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: timestamp,
      id: testEntityId('as', 'session_workspace_deletion_blocker'),
      message: null,
      status: 'busy',
      threadId: thread.id,
      updatedAt: timestamp,
      workspaceId: workspace.id,
    });

    const requestId = '00000000-0000-4000-8000-000000000010';
    const confirmation = `permanently-delete-workspace:${workspace.id}:1`;
    const input = { confirmation, expectedRegistryRevision: 1, requestId };
    const remove = (value: typeof input = input) =>
      app.request(
        ...operationRequest(
          'workspace.delete',
          { workspaceId: workspace.id },
          {
            body: JSON.stringify(value),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
    const requestRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      workspace.id,
      requestId
    );
    const requestPath = join(requestRoot, 'request.json');
    const beforeRegistry = coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
      .get(workspace.id);
    const beforeReceipts = coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
    const beforeAudits = coreDb.sqlite.prepare('SELECT * FROM audit_events').all();
    const sourceRoot = join(dataRoot, 'workspaces', workspace.id);
    const sourceInode = lstatSync(sourceRoot).ino;
    const response = await remove();
    expect(response.status).toBe(409);
    const refusal = await response.json();
    expect(refusal).toMatchObject({
      code: 'workspace_blocked',
      details: {
        workspaceId: workspace.id,
        operation: 'delete',
        retryable: false,
        blockers: expect.any(Array),
      },
    });
    expect(refusal.details.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(refusal)).not.toContain(dataRoot);
    expect(closeWorkspaceMcpSessions).not.toHaveBeenCalled();
    expect(existsSync(requestRoot)).toBe(false);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual(beforeRegistry);
    expect(coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
      beforeReceipts
    );
    expect(coreDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual(beforeAudits);
    expect(lstatSync(sourceRoot).ino).toBe(sourceInode);
    expect(store.getThread(workspace.id, thread.id)).toEqual(thread);

    await store.updateAgentSession(testEntityId('as', 'session_workspace_deletion_blocker'), {
      status: 'closed',
      updatedAt: new Date().toISOString(),
    });
    closeWorkspaceMcpSessions.mockRejectedValueOnce(new Error('injected MCP cleanup failure'));
    const cleanupFailure = await remove();
    expect(cleanupFailure.status).toBe(409);
    expect(await cleanupFailure.json()).toMatchObject({ code: 'recovery_required' });
    expect(closeWorkspaceMcpSessions).toHaveBeenCalledExactlyOnceWith(workspace.id);
    expect(existsSync(sourceRoot)).toBe(true);
    expect(lstatSync(sourceRoot).ino).toBe(sourceInode);
    expect(store.getThread(workspace.id, thread.id)).toEqual(thread);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual(beforeRegistry);
    expect(coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
      beforeReceipts
    );
    expect(coreDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual(beforeAudits);

    const requestRootStat = lstatSync(requestRoot);
    const requestStat = lstatSync(requestPath);
    const requestRecord = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>;
    const retainedRequest = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    expect(requestRootStat.isDirectory()).toBe(true);
    expect(requestRootStat.mode & 0o777).toBe(0o700);
    expect(requestStat.isFile()).toBe(true);
    expect(requestStat.mode & 0o777).toBe(0o600);
    expect(requestRecord).toMatchObject({
      confirmation,
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      phase: 'requested',
      requestId,
      schemaVersion: 1,
      workspaceId: workspace.id,
      recoveryBackupId: expect.any(String),
    });
    expect(
      existsSync(
        join(
          dataRoot,
          'server',
          'backups',
          'workspaces',
          workspace.id,
          requestRecord.recoveryBackupId as string,
          'seal.json'
        )
      )
    ).toBe(false);
    expect(JSON.stringify(requestRecord)).not.toContain(dataRoot);
    const changedInput = await remove({
      confirmation: `permanently-delete-workspace:${workspace.id}:2`,
      expectedRegistryRevision: 2,
      requestId,
    });
    expect(changedInput.status).toBe(409);
    expect(await changedInput.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    const competingRequest = await remove({
      ...input,
      requestId: '00000000-0000-4000-8000-000000000015',
    });
    expect(competingRequest.status).toBe(409);
    expect(await competingRequest.json()).toMatchObject({ code: 'workspace_deletion_in_progress' });
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual(
      retainedRequest
    );
    expect(closeWorkspaceMcpSessions).toHaveBeenCalledTimes(1);

    const retry = await remove();
    expect(retry.status, await retry.clone().text()).toBe(200);
    const result = await retry.json();
    expect(result).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted', workspaceId: workspace.id },
    });
    expect(closeWorkspaceMcpSessions).toHaveBeenCalledTimes(2);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toMatchObject({
      originalOwnerUserId: requestRecord.originalOwnerUserId,
      recoveryBackupId: requestRecord.recoveryBackupId,
      phase: 'cleaned',
    });
    expect(
      coreDb.sqlite
        .prepare(
          'SELECT owner_user_id, status, revision FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(workspace.id)
    ).toEqual({ owner_user_id: requestRecord.originalOwnerUserId, status: 'deleted', revision: 3 });
    expect(
      coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_id = ?')
        .get(requestId)
    ).toEqual({ count: 1 });
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND request_id = ? AND outcome = 'succeeded'"
        )
        .get(workspace.id, requestId)
    ).toEqual({ count: 1 });
    const replay = await remove();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(closeWorkspaceMcpSessions).toHaveBeenCalledTimes(2);
    expect(
      coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_id = ?')
        .get(requestId)
    ).toEqual({ count: 1 });
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND request_id = ? AND outcome = 'succeeded'"
        )
        .get(workspace.id, requestId)
    ).toEqual({ count: 1 });
  } finally {
    await workerMcpGateway.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it.each([
  ['scheduler recovery evidence', '00000000-0000-4000-8000-000000000027'],
  ['physical worker cleanup', '00000000-0000-4000-8000-000000000028'],
  ['approved apply plan', '00000000-0000-4000-8000-000000000029'],
  ['idle ready native binding', '00000000-0000-4000-8000-000000000037'],
] as const)('refuses deletion while %s remains nonterminal', async (blocker, requestId) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-quiescence-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace(`${blocker} fixture`);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const timestamp = new Date().toISOString();
    let retainedPackage: { path: string; bytes: Buffer } | null = null;
    if (blocker === 'scheduler recovery evidence') {
      insertDeletionQuiescenceLease(coreDb, {
        recoveryState: 'needs-evidence',
        status: 'closing',
        suffix: 'deletion_recovery',
        workspaceId: workspace.id,
      });
    } else if (blocker === 'physical worker cleanup') {
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state,
             physical_cleaned_at, created_at, updated_at
           ) VALUES (
             'attempt_00000000-0000-7000-8000-000000000971', ?, 'th_00000000-0000-7000-8000-000000000971',
             'tu_00000000-0000-7578-82f0-b9b0663a3388', 'as_00000000-0000-7000-8000-000000000971',
             'package_deletion_backend', 'test', 'deployment_deletion_backend',
             'backend_deletion_backend', 'target_deletion_backend', ?,
             '{"imageRef":"openkit/test:deletion"}', 'sandbox_deletion_backend',
             'server/runtime/deletion-backend',
             'complete', 'physical-cleaned', ?, ?, ?
           )`
        )
        .run(workspace.id, 'a'.repeat(64), timestamp, timestamp, timestamp);
    } else if (blocker === 'idle ready native binding') {
      const suffix = 'deletion_idle_native';
      const thread = await store.createThread(workspace.id, 'Idle native resident');
      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      let environmentPackage: ReturnType<typeof recordTestAgentEnvironmentPackage>;
      try {
        applyScopedMigrations(workspaceDb);
        environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
          coreDb,
          suffix,
          threadId: thread.id,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          workspaceInputIds: [],
        });
      } finally {
        workspaceDb.sqlite.close();
      }
      await store.createAgentSession({
        id: environmentPackage.scope.agentSessionId,
        agentId: environmentPackage.agent.agentId,
        workspaceId: workspace.id,
        threadId: thread.id,
        environmentPackageSnapshotId: environmentPackage.snapshotId,
        status: 'idle',
        message: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const target = recordTestNativeRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        maxActiveTurns: 1,
        adapterId: 'codex',
        adapterVersion: 'test',
        harnessBindingRef: 'harness-binding-deletion-idle',
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: 'harness-deletion-idle',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: target.physicalEpoch!,
        sandboxBindingRef: 'sandbox-binding-deletion-idle',
        sandboxCompatibilityKey: 'c'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-deletion-idle',
        sandboxRuntimeId: 'sandbox-runtime-deletion-idle',
        runtimeTargetId: target.targetId,
        timestamp,
      });
      const binding = {
        agentSessionCompatibilityKey: 'd'.repeat(64),
        agentSessionId: environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: 'binding-deletion-idle',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-deletion-idle',
        threadId: thread.id,
        workspaceId: workspace.id,
      };
      openNanoHostAgentSessionBinding(coreDb, { ...binding, timestamp });
      const { harnessInstanceId, ...sessionOpen } = binding;
      queueTestPreparedHarnessOperation(coreDb, {
        body: { ...sessionOpen, adapterId: 'codex', resume: null },
        harnessInstanceId,
        operation: 'session.open',
        timestamp,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-deletion-idle',
      })!;
      expect(command).not.toBeNull();
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-deletion-idle',
        timestamp,
        result: {
          schemaVersion: 2,
          harnessInstanceId: command.harnessInstanceId,
          operationId: command.operationId,
          sequence: command.sequence,
          disposition: 'succeeded',
          body: {
            state: 'open',
            maxActiveTurns: 1,
            nativeHandleState: 'ready',
            nativeHandleDigest: 'a'.repeat(64),
          },
        },
      });
      const path = join(
        dataRoot,
        'workspaces',
        workspace.id,
        'runtime',
        'agent-sessions',
        environmentPackage.scope.agentSessionId,
        'aep-snapshots',
        `${environmentPackage.snapshotId}.json`
      );
      retainedPackage = { path, bytes: readFileSync(path) };
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state, native_handle_state FROM agent_session_runtime_bindings'
          )
          .get()
      ).toEqual({ lifecycle_state: 'open', native_handle_state: 'ready' });
    } else {
      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
        workspaceDb.sqlite
          .prepare(
            `INSERT INTO workspace_apply_plans (
               apply_plan_id, workspace_id, review_id, change_set_id, strategy,
               approval_state, payload_json, created_at, updated_at
             ) VALUES (
               'apply_plan_deletion', ?, 'review_deletion', 'change_deletion',
               'replace', 'approved', '{}', ?, ?
             )`
          )
          .run(workspace.id, timestamp, timestamp);
      } finally {
        workspaceDb.sqlite.close();
      }
    }
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });

    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(409);
    const refusal = await response.json();
    expect(refusal).toMatchObject({
      code: 'workspace_blocked',
      details: {
        workspaceId: workspace.id,
        operation: 'delete',
        retryable: false,
        blockers: expect.any(Array),
      },
    });
    expect(refusal.details.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(refusal)).not.toContain(dataRoot);
    if (retainedPackage) expect(readFileSync(retainedPackage.path)).toEqual(retainedPackage.bytes);
    expect(
      existsSync(
        join(dataRoot, 'server', 'exports', 'workspace-deletions', workspace.id, requestId)
      )
    ).toBe(false);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

function insertDeletionQuiescenceLease(
  coreDb: ReturnType<typeof openCoreDb>,
  input: {
    agentSessionId?: string;
    packageSnapshotId?: string;
    recoveryState: string;
    status: string;
    suffix: string;
    threadId?: string;
    turnId?: string;
    workspaceId: string;
  }
): {
  agentSessionId: string;
  packageSnapshotId: string;
  threadId: string;
  turnId: string;
} {
  const timestamp = new Date().toISOString();
  const threadId = input.threadId ?? testEntityId('th', `thread_${input.suffix}`);
  const turnId = input.turnId ?? testEntityId('tu', `turn_${input.suffix}`);
  const agentSessionId = input.agentSessionId ?? testEntityId('as', `session_${input.suffix}`);
  const packageSnapshotId = input.packageSnapshotId ?? `package_${input.suffix}`;
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${input.suffix}`,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceId: input.workspaceId,
    threadId,
    turnId,
    turnInput: 'Deletion quiescence fixture',
    requestedAgentId: 'agent_codex_host',
    now: () => timestamp,
  });
  const attempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `lease_${input.suffix}`),
    agentSessionId,
    inputRef: packageSnapshotId,
    bindingRef: `sandbox_${input.suffix}`,
    sessionCompatibilityKey: 'c'.repeat(64),
    operationId: `original:${input.suffix}`,
    now: () => timestamp,
  });
  markSchedulerExecutionAttemptClosing(coreDb, {
    attemptId: attempt.attemptId,
    cause:
      input.status === 'failed'
        ? 'turn-failed'
        : input.status === 'lost'
          ? 'restart-native-recovery'
          : 'native-liveness-expired',
    outcomeRef: `turn:${turnId}:failed`,
    now: () => timestamp,
  });
  coreDb.sqlite
    .prepare('UPDATE scheduler_execution_attempts SET recovery_state = ? WHERE attempt_id = ?')
    .run(input.recoveryState, attempt.attemptId);
  return { agentSessionId, packageSnapshotId, threadId, turnId };
}

function insertDeletionQuiescenceBackend(
  coreDb: ReturnType<typeof openCoreDb>,
  input: {
    agentSessionId: string;
    packageSnapshotId: string;
    physicalCleanedAt: string | null;
    state: string;
    suffix: string;
    threadId: string;
    turnId: string;
    workspaceId: string;
  }
): void {
  const timestamp = new Date().toISOString();
  coreDb.sqlite
    .prepare(
      `INSERT INTO worker_backend_sessions (
         attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
         package_snapshot_id, backend_kind, deployment_id, backend_session_id,
         runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
         staging_directory_ref, workspace_handoff_state, state,
         physical_cleaned_at, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, ?,
         '{"imageRef":"openkit/test:deletion"}', ?, ?,
         'complete', ?, ?, ?, ?
       )`
    )
    .run(
      testEntityId('attempt', `lease_${input.suffix}`),
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.agentSessionId,
      input.packageSnapshotId,
      `deployment_${input.suffix}`,
      `backend_${input.suffix}`,
      `target_${input.suffix}`,
      'a'.repeat(64),
      `sandbox_${input.suffix}`,
      `server/runtime/${input.suffix}`,
      input.state,
      input.physicalCleanedAt,
      timestamp,
      timestamp
    );
}

/**
 * Models completed closeout before testing deletion's independent retained cleanup evidence check.
 * This backend double owns no physical process, output stream or live route; all six modeled barriers settle.
 * Malformed private rows are introduced only after this exact fence, never used to manufacture its proof.
 */
async function closeDeletionQuiescenceAttempt(
  coreDb: ReturnType<typeof openCoreDb>,
  suffix: string
): Promise<void> {
  const attempt = markSchedulerExecutionAttemptClosing(coreDb, {
    attemptId: testEntityId('attempt', `lease_${suffix}`),
    cause: 'turn-failed',
  });
  const correlation = schedulerExecutionCorrelation(attempt);
  const proof = {
    terminalHandoff: true,
    output: true,
    evidence: true,
    outsideWorkspaceCollection: true,
    integrationDrain: true,
    routesRevoked: true,
  } as const;
  const released = await new SimulatedTurnExecutor({ coreDb }).release({ ...correlation, proof });
  closeSchedulerExecutionAttemptWithFence(coreDb, {
    correlation,
    proof,
    fenceRef: released.fenceRef!,
  });
}

it('lets deletion proceed for five closed failed attempts with exact fences and matching cleaned backend proof', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-cleaned-failed-'));
  const coreDb = openCoreDb(dataRoot);
  const requestId = '00000000-0000-4000-8000-000000000030';
  const physicalCleanedAt = '2026-09-10T00:00:00.000Z';
  const suffixes = [
    'cleaned_failed_1',
    'cleaned_failed_2',
    'cleaned_failed_3',
    'cleaned_failed_4',
    'cleaned_failed_5',
  ];

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Failed cleaned lease fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    for (const suffix of suffixes) {
      const lineage = insertDeletionQuiescenceLease(coreDb, {
        recoveryState: 'needs-evidence',
        status: 'failed',
        suffix,
        workspaceId: workspace.id,
      });
      insertDeletionQuiescenceBackend(coreDb, {
        ...lineage,
        physicalCleanedAt,
        state: 'cleaned',
        suffix,
        workspaceId: workspace.id,
      });
      await closeDeletionQuiescenceAttempt(coreDb, suffix);
    }
    const app = createApp({
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });

    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted', workspaceId: workspace.id },
    });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT phase, recovery_state AS recoveryState, fence_ref AS fenceRef
           FROM scheduler_execution_attempts
           WHERE attempt_id IN (${suffixes.map(() => '?').join(', ')})
           ORDER BY rowid`
        )
        .all(...suffixes.map((suffix) => testEntityId('attempt', `lease_${suffix}`)))
    ).toEqual(
      suffixes.map((suffix) => ({
        recoveryState: 'needs-evidence',
        phase: 'closed',
        fenceRef: `self-check:${testEntityId('attempt', `lease_${suffix}`)}`,
      }))
    );
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT state, physical_cleaned_at AS physicalCleanedAt
           FROM worker_backend_sessions
           WHERE attempt_id IN (${suffixes.map(() => '?').join(', ')})
           ORDER BY rowid`
        )
        .all(...suffixes.map((suffix) => testEntityId('attempt', `lease_${suffix}`)))
    ).toEqual(suffixes.map(() => ({ physicalCleanedAt, state: 'cleaned' })));
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('refuses deletion when one of five failed attempts remains closing without release proof', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-sibling-unproved-'));
  const coreDb = openCoreDb(dataRoot);
  const requestId = '00000000-0000-4000-8000-000000000037';
  const physicalCleanedAt = '2026-09-10T00:00:00.000Z';
  const suffixes = ['sibling_1', 'sibling_2', 'sibling_3', 'sibling_4', 'sibling_unproved'];

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Sibling unproved lease fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    for (const suffix of suffixes) {
      const lineage = insertDeletionQuiescenceLease(coreDb, {
        recoveryState: 'needs-evidence',
        status: 'failed',
        suffix,
        workspaceId: workspace.id,
      });
      if (suffix !== 'sibling_unproved') {
        insertDeletionQuiescenceBackend(coreDb, {
          ...lineage,
          physicalCleanedAt,
          state: 'cleaned',
          suffix,
          workspaceId: workspace.id,
        });
        await closeDeletionQuiescenceAttempt(coreDb, suffix);
      }
    }
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });

    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(409);
    const refusal = await response.json();
    expect(refusal).toMatchObject({
      code: 'workspace_blocked',
      details: {
        workspaceId: workspace.id,
        operation: 'delete',
        retryable: false,
        blockers: expect.any(Array),
      },
    });
    expect(refusal.details.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(refusal)).not.toContain(dataRoot);
    expect(
      existsSync(
        join(dataRoot, 'server', 'exports', 'workspace-deletions', workspace.id, requestId)
      )
    ).toBe(false);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT phase, recovery_state AS recoveryState, fence_ref AS fenceRef
           FROM scheduler_execution_attempts
           WHERE attempt_id IN (${suffixes.map(() => '?').join(', ')})
           ORDER BY rowid`
        )
        .all(...suffixes.map((suffix) => testEntityId('attempt', `lease_${suffix}`)))
    ).toEqual(
      suffixes.map((suffix) => ({
        recoveryState: 'needs-evidence',
        phase: suffix === 'sibling_unproved' ? 'closing' : 'closed',
        fenceRef:
          suffix === 'sibling_unproved'
            ? null
            : `self-check:${testEntityId('attempt', `lease_${suffix}`)}`,
      }))
    );
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it.each([
  {
    backend: 'missing' as const,
    leaseStatus: 'failed',
    name: 'a closed failed needs-evidence attempt has no backend row',
    requestId: '00000000-0000-4000-8000-000000000031',
    suffix: 'missing_backend',
  },
  {
    backend: 'mismatched-thread' as const,
    leaseStatus: 'failed',
    name: 'a closed failed needs-evidence attempt has mismatched thread lineage',
    requestId: '00000000-0000-4000-8000-000000000032',
    suffix: 'mismatch_thread',
  },
  {
    backend: 'physical-cleaned' as const,
    leaseStatus: 'failed',
    name: 'a closed failed needs-evidence attempt is only physical-cleaned',
    requestId: '00000000-0000-4000-8000-000000000033',
    suffix: 'physical_cleaned',
  },
  {
    backend: 'cleaned-without-timestamp' as const,
    leaseStatus: 'failed',
    name: 'a closed failed needs-evidence attempt is cleaned without physical_cleaned_at',
    requestId: '00000000-0000-4000-8000-000000000034',
    suffix: 'cleaned_no_ts',
  },
  {
    backend: 'cleaned' as const,
    leaseStatus: 'lost',
    name: 'a closing unknown attempt has matching cleaned backend proof',
    requestId: '00000000-0000-4000-8000-000000000035',
    suffix: 'lost_cleaned',
  },
  {
    backend: 'cleaned' as const,
    leaseStatus: 'stale',
    name: 'a closing expired attempt has matching cleaned backend proof',
    requestId: '00000000-0000-4000-8000-000000000036',
    suffix: 'stale_cleaned',
  },
])('refuses deletion when $name', async (fixture) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-unproved-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace(`${fixture.suffix} fixture`);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const lineage = insertDeletionQuiescenceLease(coreDb, {
      recoveryState: 'needs-evidence',
      status: fixture.leaseStatus,
      suffix: fixture.suffix,
      workspaceId: workspace.id,
    });
    // Establish an intact private cleanup observation before any deliberate corruption.
    insertDeletionQuiescenceBackend(coreDb, {
      ...lineage,
      physicalCleanedAt: new Date().toISOString(),
      state: 'cleaned',
      suffix: fixture.suffix,
      workspaceId: workspace.id,
    });
    if (fixture.leaseStatus === 'failed') {
      await closeDeletionQuiescenceAttempt(coreDb, fixture.suffix);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT phase, fence_ref AS fenceRef, disposition, terminal_cause AS cause FROM scheduler_execution_attempts WHERE attempt_id = ?'
          )
          .get(testEntityId('attempt', `lease_${fixture.suffix}`))
      ).toEqual({
        phase: 'closed',
        fenceRef: `self-check:${testEntityId('attempt', `lease_${fixture.suffix}`)}`,
        disposition: 'unknown',
        cause: 'turn-failed',
      });
    }
    if (fixture.backend === 'missing') {
      coreDb.sqlite
        .prepare('DELETE FROM worker_backend_sessions WHERE attempt_id = ?')
        .run(testEntityId('attempt', `lease_${fixture.suffix}`));
    } else if (fixture.backend === 'mismatched-thread') {
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET thread_id = ? WHERE attempt_id = ?')
        .run(
          testEntityId('th', `thread_other_${fixture.suffix}`),
          testEntityId('attempt', `lease_${fixture.suffix}`)
        );
    } else if (fixture.backend === 'physical-cleaned') {
      coreDb.sqlite
        .prepare(
          "UPDATE worker_backend_sessions SET state = 'physical-cleaned' WHERE attempt_id = ?"
        )
        .run(testEntityId('attempt', `lease_${fixture.suffix}`));
    } else if (fixture.backend === 'cleaned-without-timestamp') {
      coreDb.sqlite
        .prepare(
          'UPDATE worker_backend_sessions SET physical_cleaned_at = NULL WHERE attempt_id = ?'
        )
        .run(testEntityId('attempt', `lease_${fixture.suffix}`));
    }
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });

    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId: fixture.requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(409);
    const refusal = await response.json();
    expect(refusal).toMatchObject({
      code: 'workspace_blocked',
      details: {
        workspaceId: workspace.id,
        operation: 'delete',
        retryable: false,
        blockers: expect.any(Array),
      },
    });
    expect(refusal.details.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(refusal)).not.toContain(dataRoot);
    expect(
      existsSync(
        join(dataRoot, 'server', 'exports', 'workspace-deletions', workspace.id, fixture.requestId)
      )
    ).toBe(false);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT phase, recovery_state AS recoveryState
           FROM scheduler_execution_attempts
           WHERE attempt_id = ?`
        )
        .get(testEntityId('attempt', `lease_${fixture.suffix}`))
    ).toEqual({
      recoveryState: 'needs-evidence',
      phase: fixture.leaseStatus === 'failed' ? 'closed' : 'closing',
    });
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('terminates a pre-transition deletion request when its original owner is disabled at boot', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-disabled-boot-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Disabled owner deletion fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const requestId = '00000000-0000-4000-8000-000000000016';
    createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      requestId,
      workspaceId: workspace.id,
    });
    coreDb.sqlite.transaction(() =>
      disableCanonicalUser(coreDb, 'usr_00000000-0000-7000-8000-000000000001')
    )();
    const mutationAdmission = new WorkspaceMutationAdmission();

    createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workspaceMutationAdmission: mutationAdmission,
    });

    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe('blocked');
    expect(mutationAdmission.isClosed(workspace.id)).toBe(false);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('terminates a pre-transition deletion request when its owner is disabled in the running app', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-disabled-live-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('usr_00000000-0000-768a-8658-44c33d82c1f5', 'Admin', 'admin@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    const admin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Live disabled owner deletion fixture');
    const deletingWorkspace = await store.createWorkspace('Post-transition disabled owner fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: deletingWorkspace.id,
    });
    const requestId = '00000000-0000-4000-8000-000000000023';
    const deletingRequestId = '00000000-0000-4000-8000-000000000025';
    const mutationAdmission = new WorkspaceMutationAdmission();
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workspaceMutationAdmission: mutationAdmission,
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
    });
    const originalWrite = deletionRequestOwner.writeWorkspaceDeletionRequest;
    const phaseWrite = vi.spyOn(deletionRequestOwner, 'writeWorkspaceDeletionRequest');
    let interrupted = false;
    try {
      phaseWrite.mockImplementation((root, record) => {
        const retained = originalWrite(root, record);
        if (retained.workspaceId === deletingWorkspace.id && retained.phase === 'exported') {
          interrupted = true;
          throw new Error('Injected failure after the genuine post-transition phase.');
        }
        return retained;
      });
      const stopped = await app.request(
        ...operationRequest(
          'workspace.delete',
          { workspaceId: deletingWorkspace.id },
          {
            headers: { authorization: `Bearer ${admin.secret}` },
            body: JSON.stringify({
              confirmation: `permanently-delete-workspace:${deletingWorkspace.id}:1`,
              expectedRegistryRevision: 1,
              requestId: deletingRequestId,
            }),
          }
        )
      );
      expect(stopped.status).toBe(409);
      expect(await stopped.json()).toMatchObject({ code: 'recovery_required' });
    } finally {
      phaseWrite.mockRestore();
    }
    expect(interrupted).toBe(true);
    const deletingRequest = readWorkspaceDeletionRequest(
      dataRoot,
      deletingWorkspace.id,
      deletingRequestId
    );
    expect(deletingRequest.phase).toBe('exported');
    const backup = await readWorkspaceSnapshotMetadata({
      ...WORKSPACE_BACKUP_POLICY,
      dataRoot,
      workspaceId: deletingWorkspace.id,
      backupId: deletingRequest.recoveryBackupId!,
    });
    expect(deletingRequest.recoveryBackupManifestDigest).toBe(backup.manifestDigest);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(deletingWorkspace.id)
    ).toEqual({ status: 'deleting', revision: 2 });
    const releaseMutation = mutationAdmission.enter(workspace.id);
    if (!releaseMutation) {
      throw new Error('Expected the active Workspace mutation to be admitted.');
    }
    createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      requestId,
      workspaceId: workspace.id,
    });

    const responsePromise = app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: 'usr_00000000-0000-7000-8000-000000000001' },
        {
          body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000024' }),
          headers: {
            authorization: `Bearer ${admin.secret}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        }
      )
    );
    try {
      await vi.waitFor(() => expect(mutationAdmission.isClosed(workspace.id)).toBe(true));
      expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe(
        'requested'
      );
    } finally {
      releaseMutation();
    }
    const response = await responsePromise;

    expect(response.status, await response.clone().text()).toBe(200);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe('blocked');
    expect(mutationAdmission.isClosed(workspace.id)).toBe(false);
    expect(readWorkspaceDeletionRequest(dataRoot, deletingWorkspace.id, deletingRequestId)).toEqual(
      deletingRequest
    );
    expect(mutationAdmission.isClosed(deletingWorkspace.id)).toBe(true);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('keeps the mutation fence closed without rewriting conflicting deletion requests at boot', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-conflict-boot-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Conflicting deletion fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const requestIds = [
      '00000000-0000-4000-8000-000000000019',
      '00000000-0000-4000-8000-000000000020',
    ];
    for (const requestId of requestIds) {
      createWorkspaceDeletionRequest(dataRoot, {
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        createdAt: new Date().toISOString(),
        expectedRegistryRevision: 1,
        originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
        requestId,
        workspaceId: workspace.id,
      });
    }
    coreDb.sqlite.transaction(() =>
      disableCanonicalUser(coreDb, 'usr_00000000-0000-7000-8000-000000000001')
    )();
    const mutationAdmission = new WorkspaceMutationAdmission();

    createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workspaceMutationAdmission: mutationAdmission,
    });

    expect(
      requestIds.map(
        (requestId) => readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase
      )
    ).toEqual(['requested', 'requested']);
    expect(mutationAdmission.isClosed(workspace.id)).toBe(true);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('restores registry-owned boot fences without relying on a nonterminal request', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-registry-boot-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const deletingWorkspace = await store.createWorkspace('Deleting registry fixture');
    const deletedWorkspace = await store.createWorkspace('Deleted registry fixture');
    for (const workspace of [deletingWorkspace, deletedWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: workspace.id,
      });
      coreDb.sqlite.transaction(() =>
        beginWorkspaceDeletion({
          coreDb,
          expectedRegistryRevision: 1,
          originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          workspaceId: workspace.id,
        })
      )();
    }
    coreDb.sqlite.transaction(() =>
      completeWorkspaceDeletion({
        coreDb,
        expectedRegistryRevision: 2,
        originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: deletedWorkspace.id,
      })
    )();
    const requestId = '00000000-0000-4000-8000-000000000030';
    const request = createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${deletedWorkspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      requestId,
      workspaceId: deletedWorkspace.id,
    });
    writeWorkspaceDeletionRequest(dataRoot, {
      ...request,
      cleanedAt: new Date().toISOString(),
      closureDigest: 'closure-digest',
      closureId: `wsclose_delete_${requestId}`,
      commandReceiptKey: 'workspace-delete-receipt',
      phase: 'cleaned',
      recoveryBackupId: allocateEntityId('wsbak'),
      recoveryBackupManifestDigest: 'export-digest',
      stagingRelativePath: workspaceDeletionStagingRelativePath(deletedWorkspace.id, requestId),
      terminalAuditEventId: testEntityId('aud', 'workspace-delete-audit'),
    });
    const mutationAdmission = new WorkspaceMutationAdmission();

    createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workspaceMutationAdmission: mutationAdmission,
    });

    expect(mutationAdmission.isClosed(deletingWorkspace.id)).toBe(true);
    expect(mutationAdmission.isClosed(deletedWorkspace.id)).toBe(true);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it.each([
  'export',
  'closure',
  'staged-contradiction',
] as const)('handles the %s crash boundary without duplicating or committing contradictory state', async (crashPoint) => {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-workspace-deletion-${crashPoint}-resume-`));
  const backupParent = mkdtempSync(join(tmpdir(), 'openkit-deletion-before-cut-'));
  const coreDb = openCoreDb(dataRoot);
  const originalWrite = deletionRequestOwner.writeWorkspaceDeletionRequest;
  const phaseWrite = vi.spyOn(deletionRequestOwner, 'writeWorkspaceDeletionRequest');
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace(`${crashPoint} crash fixture`);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const canonicalRoot = join(dataRoot, 'workspaces', workspace.id);
    const originalRoot = join(backupParent, 'workspace');
    cpSync(canonicalRoot, originalRoot, { recursive: true });
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
    });
    const requestId = {
      export: '00000000-0000-4000-8000-000000000021',
      closure: '00000000-0000-4000-8000-000000000022',
      'staged-contradiction': '00000000-0000-4000-8000-000000000026',
    }[crashPoint];
    const input = {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      expectedRegistryRevision: 1,
      requestId,
    };
    const remove = () =>
      app.request(
        ...operationRequest(
          'workspace.delete',
          { workspaceId: workspace.id },
          { body: JSON.stringify(input) }
        )
      );
    const stopPhase = {
      export: 'exported',
      closure: 'closure-sealed',
      'staged-contradiction': 'staged',
    }[crashPoint];
    let injected = false;
    // The real public delete produces and retains the cut before this one-shot return fault.
    phaseWrite.mockImplementation((root, record) => {
      const retained = originalWrite(root, record);
      if (!injected && retained.phase === stopPhase) {
        injected = true;
        throw new Error('Injected failure after retaining the genuine deletion phase.');
      }
      return retained;
    });
    await remove();
    phaseWrite.mockRestore();
    expect(injected).toBe(true);
    const request = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    expect(request.phase).toBe(stopPhase);
    expect(request.recoveryBackupId).toEqual(expect.any(String));
    const backup = await readWorkspaceSnapshotMetadata({
      ...WORKSPACE_BACKUP_POLICY,
      dataRoot,
      workspaceId: workspace.id,
      backupId: request.recoveryBackupId!,
    });
    expect(backup.manifestDigest).toBe(request.recoveryBackupManifestDigest);
    const wrongBackupId = allocateEntityId('wsbak');
    writeWorkspaceDeletionRequest(dataRoot, { ...request, recoveryBackupId: wrongBackupId });
    const wrongBinding = await remove();
    expect(wrongBinding.status).toBe(409);
    expect(
      existsSync(join(dataRoot, 'server', 'backups', 'workspaces', workspace.id, wrongBackupId))
    ).toBe(false);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual({
      ...request,
      recoveryBackupId: wrongBackupId,
    });
    writeWorkspaceDeletionRequest(dataRoot, request);
    if (crashPoint === 'staged-contradiction')
      cpSync(originalRoot, canonicalRoot, { recursive: true });
    const response = await remove();
    if (crashPoint === 'staged-contradiction') {
      expect(response.status).toBe(409);
      expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual(request);
      expect(existsSync(canonicalRoot)).toBe(true);
      expect(existsSync(join(dataRoot, request.stagingRelativePath!))).toBe(true);
      expect(
        coreDb.sqlite
          .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
          .get(workspace.id)
      ).toEqual({ revision: 2, status: 'deleting' });
      return;
    }
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ deletion: { phase: 'cleaned' } });
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toMatchObject({
      closureId: `wsclose_delete_${requestId}`,
      recoveryBackupId: request.recoveryBackupId,
      recoveryBackupManifestDigest: backup.manifestDigest,
    });
    expect(
      (
        await readWorkspaceSnapshotMetadata({
          ...WORKSPACE_BACKUP_POLICY,
          dataRoot,
          workspaceId: workspace.id,
          backupId: request.recoveryBackupId!,
        })
      ).manifestDigest
    ).toBe(backup.manifestDigest);
  } finally {
    phaseWrite.mockRestore();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
    rmSync(backupParent, { force: true, recursive: true });
  }
});

it('preserves private Thread ownership only through the exact current deletion recovery backup', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-private-deletion-backup-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const ownerUserId = 'usr_00000000-0000-7000-8000-000000000001';
    const privateOwnerUserId = testEntityId('usr', 'deletion-private-history-owner');
    const now = Date.now();
    coreDb.sqlite
      .prepare(`INSERT INTO users (
      id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
    ) VALUES (?, 'Private owner', 'private-owner@example.test', false, ?, ?, 'human', 'active', NULL)`)
      .run(privateOwnerUserId, now, now);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Private deletion backup');
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: workspace.id });
    const privateThread = await store.createThread(
      workspace.id,
      'Private history',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId }
    );
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
    });
    const requestId = '00000000-0000-4000-8000-000000000974';
    const deleted = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            requestId,
            expectedRegistryRevision: 1,
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
          }),
        }
      )
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toMatchObject({ deletion: { phase: 'cleaned' } });
    const request = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    const backup = await readWorkspaceSnapshotMetadata({
      ...WORKSPACE_BACKUP_POLICY,
      dataRoot,
      workspaceId: workspace.id,
      backupId: request.recoveryBackupId!,
    });
    const wrongRequest = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            deletionRequestId: '00000000-0000-4000-8000-000000000975',
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(wrongRequest.status).toBe(409);
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual(request);
    expect(
      (
        await readWorkspaceSnapshotMetadata({
          ...WORKSPACE_BACKUP_POLICY,
          dataRoot,
          workspaceId: workspace.id,
          backupId: request.recoveryBackupId!,
        })
      ).manifestDigest
    ).toBe(backup.manifestDigest);
    const recoveryRequestId = randomUUID();
    const recover = () =>
      app.request(
        ...operationRequest(
          'workspace.deleted-recover',
          { workspaceId: workspace.id },
          { body: JSON.stringify({ deletionRequestId: requestId, requestId: recoveryRequestId }) }
        )
      );
    const recovered = await recover();
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    const result = await recovered.json();
    expect(result).toMatchObject({
      command: 'restore',
      disposition: 'restored',
      workspaceId: workspace.id,
    });
    expect(JSON.stringify(result)).not.toContain(privateThread.id);
    expect(store.getThread(workspace.id, privateThread.id)).toEqual(
      expect.objectContaining({ id: privateThread.id, visibility: 'private', privateOwnerUserId })
    );
    const replay = await recover();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(
      (
        await readWorkspaceSnapshotMetadata({
          ...WORKSPACE_BACKUP_POLICY,
          dataRoot,
          workspaceId: workspace.id,
          backupId: request.recoveryBackupId!,
        })
      ).manifestDigest
    ).toBe(backup.manifestDigest);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('retains a Thread-owned retrieval trace in the verified operational deletion recovery backup', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-retrieval-trace-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Deletion retrieval trace fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const thread = await store.createThread(workspace.id, 'Deletion trace owner');
    const repositoryWorkspaceDb = (workspaceId: string) => {
      const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(workspaceDb);
      return workspaceDb;
    };
    const app = createApp({
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      coreDb,
      dataRoot,
      mode: 'local',
      repositoryWorkspaceDb,
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const notebookResponse = await app.request(
      ...operationRequest('knowledge.notebook.list', { workspaceId: workspace.id })
    );
    expect(notebookResponse.status, await notebookResponse.clone().text()).toBe(200);
    const { notebookRevision } = await notebookResponse.json();
    const pageResponse = await app.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: workspace.id,
          baseRevision: notebookRevision,
          requestId: '00000000-0000-4000-8000-000000000904',
          path: 'deletion-recovery-trace' + '.md',
          content: serializeKnowledgePageFixture(
            {
              title: 'Deletion recovery trace',
              content: 'Retain this retrieval trace in the verified recovery export.',
              sourceReferences: [],
              createdAt: '2026-10-19T00:00:00.000Z',
              updatedAt: '2026-10-19T00:00:00.000Z',
            },
            { kind: 'workspace', workspaceId: workspace.id }
          ),
          summary: 'Publish explicit full-page fixture',
        },
        { headers: { 'x-openkit-request-id': '00000000-0000-4000-8000-000000000904' } }
      )
    );
    expect(pageResponse.status, await pageResponse.clone().text()).toBe(200);
    expect((await pageResponse.json()).changedPageIds).toEqual(['deletion-recovery-trace']);
    const page = { id: 'deletion-recovery-trace' };
    const traceId = 'krt_00000000-0000-7c9e-a8c7-f3f6e7618033';
    const retrieval = await retrieveWorkspaceKnowledge({
      access: {
        store,
        coreDb,
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        outputThreadId: thread.id,
      },
      caller: 'task-mode',
      dataRoot,
      pinnedReferences: [
        {
          scopeId: `page/workspace/${workspace.id}/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'workspace', workspaceId: workspace.id } })}`,
          objectId: page.id,
        },
      ],
      query: 'Deletion recovery trace',
      traceId,
      workspaceId: workspace.id,
    });
    expect(retrieval.retrievalTraceRef).toEqual({
      scopeId: `retrieval-trace/thread/${workspace.id}/${thread.id}`,
      objectId: traceId,
    });
    const traceRelativePath = `threads/${thread.id}/retrieval-traces/${traceId}.json`;
    const sourceTrace = JSON.parse(
      readFileSync(join(dataRoot, 'workspaces', workspace.id, traceRelativePath), 'utf8')
    );
    const unboundRequestId = '00000000-0000-4000-8000-000000000903';
    const requestId = '00000000-0000-4000-8000-000000000902';
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const deleted = await response.json();
    expect(deleted).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted', workspaceId: workspace.id },
    });
    const deletion = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    expect(deletion).toMatchObject({
      phase: 'cleaned',
      recoveryBackupId: deleted.deletion.recoveryBackupId,
      recoveryBackupManifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const unboundRecovery = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({ deletionRequestId: unboundRequestId, requestId: randomUUID() }),
        }
      )
    );
    expect(unboundRecovery.status).toBe(409);
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual(deletion);
    const exportedTrace = await withVerifiedWorkspaceSnapshotSource(
      {
        ...WORKSPACE_BACKUP_POLICY,
        dataRoot,
        source: {
          kind: 'local-snapshot',
          workspaceId: workspace.id,
          backupId: deletion.recoveryBackupId!,
        },
        stagingParent: join(dataRoot, 'server', 'backups'),
        admission: new FileStorageAdmission(dataRoot, () => 0n),
        expectedRelease: {
          version: 'source',
          buildId: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        },
      },
      async (bundle) => {
        expect(bundle.manifestDigest).toBe(deletion.recoveryBackupManifestDigest);
        expect(bundle.manifest.inventory.map((entry) => entry.path)).toContain(traceRelativePath);
        const chunks: Uint8Array[] = [];
        for await (const chunk of bundle.readFile(traceRelativePath)) chunks.push(chunk);
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
    );
    expect(exportedTrace).toEqual(sourceTrace);
    expect(JSON.stringify(exportedTrace)).not.toContain('"score"');
  } finally {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('terminates ordinary Workspace authority and retains exact Core tombstone lineage', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-terminal-'));
  const workspaceBackupParent = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-backup-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Terminal deletion fixture');
    const app = createApp({
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const priorExportResponse = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: workspace.id },
        {
          method: 'POST',
        }
      )
    );
    expect(priorExportResponse.status, await priorExportResponse.clone().text()).toBe(200);
    const priorExport = (await priorExportResponse.json()) as { exportId: string };

    // Deletion's exact operational backup must preserve private owners without granting the caller private access.
    const privateThread = await store.createThread(
      workspace.id,
      'Private recovery history',
      undefined,
      'administration',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const now = Date.now();
    for (const [userId, email] of [
      ['usr_00000000-0000-7d56-82f8-ec994b63859b', 'member@example.com'],
      ['usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'invitee@example.com'],
    ] as const) {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
          ) VALUES (?, ?, ?, false, ?, ?, 'human', 'active', NULL)`
        )
        .run(userId, userId, email, now, now);
    }
    const nowIso = new Date(now).toISOString();
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, 'usr_00000000-0000-7d56-82f8-ec994b63859b', 'active', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(workspace.id, nowIso, nowIso, nowIso);
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_invitations (
          invitation_id, workspace_id, invitee_user_id, inviter_user_id,
          status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
        ) VALUES (
          'inv_00000000-0000-74df-bb9f-c7268d65b989', ?, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'usr_00000000-0000-7000-8000-000000000001',
          'pending', '2099-01-01T00:00:00.000Z', NULL, NULL, NULL, 1, ?, ?
        )`
      )
      .run(workspace.id, nowIso, nowIso);
    expect(privateThread.privateOwnerUserId).toBe('usr_00000000-0000-7000-8000-000000000001');
    const canonicalWorkspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const workspaceBackupRoot = join(workspaceBackupParent, 'workspace');
    cpSync(canonicalWorkspaceRoot, workspaceBackupRoot, { recursive: true });

    const requestId = '00000000-0000-4000-8000-000000000011';
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const deleted = await response.json();
    expect(deleted).toEqual({
      deletion: {
        closureId: expect.any(String),
        phase: 'cleaned',
        recoveryBackupId: expect.any(String),
        requestId,
        retainedStaging: false,
        status: 'deleted',
        workspaceId: workspace.id,
      },
    });
    const completedRequest = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    expect(completedRequest.recoveryBackupId).toBe(deleted.deletion.recoveryBackupId);
    expect(completedRequest.closureId).toBe(`wsclose_delete_${requestId}`);
    const workspaceExportsRoot = join(dataRoot, 'server', 'exports', 'workspaces', workspace.id);
    expect(existsSync(join(workspaceExportsRoot, priorExport.exportId))).toBe(false);
    const workspaceBackupsRoot = join(dataRoot, 'server', 'backups', 'workspaces', workspace.id);
    expect(readdirSync(workspaceBackupsRoot).filter((entry) => entry !== 'objects')).toEqual([
      completedRequest.recoveryBackupId,
    ]);
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT owner_user_id, status, revision
           FROM workspace_registry WHERE workspace_id = ?`
        )
        .get(workspace.id)
    ).toEqual({
      owner_user_id: 'usr_00000000-0000-7000-8000-000000000001',
      revision: 3,
      status: 'deleted',
    });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT status
           FROM workspace_members WHERE workspace_id = ? AND user_id = 'usr_00000000-0000-7000-8000-000000000001'`
        )
        .get(workspace.id)
    ).toEqual({ status: 'active' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT status, removed_at
           FROM workspace_members WHERE workspace_id = ? AND user_id = 'usr_00000000-0000-7d56-82f8-ec994b63859b'`
        )
        .get(workspace.id)
    ).toEqual({ removed_at: expect.any(String), status: 'removed' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT status, revoked_at
           FROM workspace_invitations WHERE invitation_id = 'inv_00000000-0000-74df-bb9f-c7268d65b989'`
        )
        .get()
    ).toEqual({ revoked_at: expect.any(String), status: 'revoked' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE workspace_id = ? AND request_id = ? AND outcome = 'succeeded'`
        )
        .get(workspace.id, requestId)
    ).toEqual({ count: 1 });
    expect(
      coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_id = ?')
        .get(requestId)
    ).toEqual({ count: 1 });
    expect(
      resolveWorkspaceMembershipRelation(
        coreDb,
        workspace.id,
        'usr_00000000-0000-7000-8000-000000000001'
      )
    ).toBeNull();
    expect(
      listActiveWorkspaceIdsForActor(coreDb, 'usr_00000000-0000-7000-8000-000000000001')
    ).not.toContain(workspace.id);

    const deletionRequestPath = join(
      dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      workspace.id,
      requestId,
      'request.json'
    );
    const cleanupSentinel = join(dataRoot, 'server', 'deletion-cleanup-sentinel');
    writeFileSync(cleanupSentinel, 'must survive');
    writeFileSync(
      deletionRequestPath,
      `${JSON.stringify({
        ...completedRequest,
        cleanedAt: null,
        phase: 'deleted',
        stagingRelativePath: 'server',
      })}\n`
    );
    const unsafeCleanupReplay = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(unsafeCleanupReplay.status).toBe(409);
    expect(existsSync(cleanupSentinel)).toBe(true);
    writeFileSync(deletionRequestPath, `${JSON.stringify(completedRequest)}\n`);
    writeWorkspaceDeletionRequest(dataRoot, {
      ...completedRequest,
      cleanedAt: null,
      phase: 'deleted',
    });

    const deletionReplay = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(deletionReplay.status, await deletionReplay.clone().text()).toBe(200);
    expect(await deletionReplay.json()).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted', workspaceId: workspace.id },
    });

    const stagingRoot = join(dataRoot, completedRequest.stagingRelativePath!);
    cpSync(workspaceBackupRoot, stagingRoot, { recursive: true });
    cpSync(workspaceBackupRoot, canonicalWorkspaceRoot, { recursive: true });
    writeWorkspaceDeletionRequest(dataRoot, {
      ...completedRequest,
      cleanedAt: null,
      phase: 'deleted',
    });
    const contradictoryCleanup = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(contradictoryCleanup.status).toBe(409);
    expect(existsSync(stagingRoot)).toBe(true);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe('deleted');

    rmSync(stagingRoot, { recursive: true });
    writeWorkspaceDeletionRequest(dataRoot, completedRequest);
    const contradictoryReplay = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(contradictoryReplay.status).toBe(409);
    const activeWorkspaceIds = listActiveWorkspaceIdsForActor(
      coreDb,
      'usr_00000000-0000-7000-8000-000000000001'
    );
    const contradictoryRecovery = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            deletionRequestId: requestId,
            requestId: '00000000-0000-4000-8000-000000000031',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(contradictoryRecovery.status).toBe(409);
    expect(
      listActiveWorkspaceIdsForActor(coreDb, 'usr_00000000-0000-7000-8000-000000000001')
    ).toEqual(activeWorkspaceIds);
    rmSync(canonicalWorkspaceRoot, { recursive: true });

    const reboundRequest = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    writeWorkspaceDeletionRequest(dataRoot, {
      ...reboundRequest,
      originalOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
    });
    const unboundRecovery = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            deletionRequestId: requestId,
            requestId: '00000000-0000-4000-8000-000000000017',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(unboundRecovery.status).toBe(409);
    writeWorkspaceDeletionRequest(dataRoot, reboundRequest);

    const closureRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspace-closures',
      workspace.id,
      reboundRequest.closureId!
    );
    const activeBeforeManifestTamper = listActiveWorkspaceIdsForActor(
      coreDb,
      'usr_00000000-0000-7000-8000-000000000001'
    );
    const exportManifestPath = join(
      workspaceBackupsRoot,
      reboundRequest.recoveryBackupId!,
      'manifest.json'
    );
    const exportManifestText = readFileSync(exportManifestPath, 'utf8');
    const exportManifest = JSON.parse(exportManifestText) as Record<string, unknown>;
    writeFileSync(
      exportManifestPath,
      `${JSON.stringify({ ...exportManifest, sourceDeploymentId: 'tampered' }, null, 2)}\n`
    );
    const tamperedExportRecovery = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            deletionRequestId: requestId,
            requestId: '00000000-0000-4000-8000-000000000032',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(tamperedExportRecovery.status).toBe(409);
    writeFileSync(exportManifestPath, exportManifestText);

    const closureManifestPath = join(closureRoot, 'workspace-closure.json');
    const closureManifestText = readFileSync(closureManifestPath, 'utf8');
    const closureManifest = JSON.parse(closureManifestText) as Record<string, unknown>;
    writeFileSync(
      closureManifestPath,
      `${JSON.stringify({ ...closureManifest, sourceDeploymentId: 'tampered' }, null, 2)}\n`
    );
    const tamperedClosureRecovery = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            deletionRequestId: requestId,
            requestId: '00000000-0000-4000-8000-000000000033',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(tamperedClosureRecovery.status).toBe(409);
    expect(
      listActiveWorkspaceIdsForActor(coreDb, 'usr_00000000-0000-7000-8000-000000000001')
    ).toEqual(activeBeforeManifestTamper);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual(reboundRequest);
    writeFileSync(closureManifestPath, closureManifestText);

    const unexpectedClosureFile = join(closureRoot, 'unexpected.txt');
    writeFileSync(unexpectedClosureFile, 'not inventoried');
    const extendedClosureRecovery = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            deletionRequestId: requestId,
            requestId: '00000000-0000-4000-8000-000000000018',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(extendedClosureRecovery.status).toBe(409);
    rmSync(unexpectedClosureFile);

    const recoveryRequestId = '00000000-0000-4000-8000-000000000012';
    const recoveryResponse = await app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({ deletionRequestId: requestId, requestId: recoveryRequestId }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(recoveryResponse.status, await recoveryResponse.clone().text()).toBe(200);
    const recovered = await recoveryResponse.json();
    expect(recovered).toMatchObject({
      command: 'restore',
      disposition: 'restored',
      workspaceId: workspace.id,
      selection: { kind: 'admission', requestId: recoveryRequestId },
      restrictedRecovery: false,
      nextAction: 'none',
    });
    expect(
      coreDb.sqlite
        .prepare('SELECT owner_user_id, status FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ owner_user_id: 'usr_00000000-0000-7000-8000-000000000001', status: 'active' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT user_id, status FROM workspace_members
           WHERE workspace_id = ? ORDER BY user_id`
        )
        .all(workspace.id)
    ).toEqual([
      { status: 'active', user_id: 'usr_00000000-0000-7000-8000-000000000001' },
      { status: 'removed', user_id: 'usr_00000000-0000-7d56-82f8-ec994b63859b' },
    ]);
    expect(store.getThread(workspace.id, privateThread.id)?.privateOwnerUserId).toBe(
      privateThread.privateOwnerUserId
    );
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { force: true, recursive: true });
    rmSync(workspaceBackupParent, { force: true, recursive: true });
  }
});
