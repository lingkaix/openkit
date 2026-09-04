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

import { expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createVerifiedWorkspaceExport } from './storage/workspace-transfer-routes.js';
import {
  createWorkspaceDeletionClosure,
  WORKSPACE_DELETION_LEGAL_HOLD_OWNERS,
} from './workspace-deletion-evidence.js';
import {
  createWorkspaceDeletionRequest,
  readWorkspaceDeletionRequest,
  workspaceDeletionStagingRelativePath,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import {
  listActiveWorkspaceIdsForActor,
  recordWorkspaceOwnerMembership,
  resolveWorkspaceRole,
} from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { beginWorkspaceDeletion, completeWorkspaceDeletion } from './workspace-sharing.js';

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
    const workspace = store.createWorkspace('Legal hold fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
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
    const response = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
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
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('durably fences an active owner deletion request before later lifecycle effects', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-route-'));
  const coreDb = openCoreDb(dataRoot);
  const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
  const closeWorkspaceMcpSessions = vi.spyOn(workerMcpGateway, 'closeWorkspace');

  try {
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Deletion fixture');
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workerMcpGateway,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const thread = store.createThread(workspace.id, 'Deletion quiescence blocker');
    const timestamp = new Date().toISOString();
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: timestamp,
      id: 'session_workspace_deletion_blocker',
      message: null,
      status: 'busy',
      threadId: thread.id,
      updatedAt: timestamp,
      workspaceId: workspace.id,
    });

    const requestId = '00000000-0000-4000-8000-000000000010';
    const confirmation = `permanently-delete-workspace:${workspace.id}:1`;
    const response = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({ confirmation, expectedRegistryRevision: 1, requestId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(202);
    expect(closeWorkspaceMcpSessions).toHaveBeenCalledWith(workspace.id);
    expect(await response.json()).toEqual({
      deletion: {
        closureId: null,
        phase: 'fenced',
        recoveryExportId: null,
        requestId,
        retainedStaging: false,
        status: 'active',
        workspaceId: workspace.id,
      },
    });
    const requestRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      workspace.id,
      requestId
    );
    const requestPath = join(requestRoot, 'request.json');
    const requestRootStat = lstatSync(requestRoot);
    const requestStat = lstatSync(requestPath);
    const requestRecord = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>;

    expect(requestRootStat.isDirectory()).toBe(true);
    expect(requestRootStat.mode & 0o777).toBe(0o700);
    expect(requestStat.isFile()).toBe(true);
    expect(requestStat.mode & 0o777).toBe(0o600);
    expect(requestRecord).toMatchObject({
      confirmation,
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'user_local',
      phase: 'fenced',
      requestId,
      schemaVersion: 1,
      workspaceId: workspace.id,
    });
    expect(JSON.stringify(requestRecord)).not.toContain(dataRoot);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });

    const changedInput = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:2`,
        expectedRegistryRevision: 2,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(changedInput.status).toBe(409);
    expect(await changedInput.json()).toMatchObject({ code: 'idempotency_key_conflict' });

    const competingRequest = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation,
        expectedRegistryRevision: 1,
        requestId: '00000000-0000-4000-8000-000000000015',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(competingRequest.status).toBe(409);
    expect(await competingRequest.json()).toMatchObject({
      code: 'workspace_deletion_in_progress',
    });

    store.updateAgentSession('session_workspace_deletion_blocker', {
      status: 'closed',
      updatedAt: new Date().toISOString(),
    });
    closeWorkspaceMcpSessions.mockRejectedValueOnce(new Error('injected MCP cleanup failure'));
    const cleanupFailure = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({ confirmation, expectedRegistryRevision: 1, requestId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(cleanupFailure.status).toBe(409);
    expect(await cleanupFailure.json()).toMatchObject({ code: 'recovery_required' });
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(true);
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });
    const retry = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({ confirmation, expectedRegistryRevision: 1, requestId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await retry.json()).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted', workspaceId: workspace.id },
    });
  } finally {
    await workerMcpGateway.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it.each([
  ['scheduler recovery evidence', '00000000-0000-4000-8000-000000000027'],
  ['physical worker cleanup', '00000000-0000-4000-8000-000000000028'],
  ['approved apply plan', '00000000-0000-4000-8000-000000000029'],
] as const)('keeps deletion fenced while %s remains nonterminal', async (blocker, requestId) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-quiescence-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace(`${blocker} fixture`);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const timestamp = new Date().toISOString();
    if (blocker === 'scheduler recovery evidence') {
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref, backend_anchor_state, recovery_state
           ) VALUES (
             'lease_deletion_recovery', 'plan_deletion_recovery', ?,
             'thread_deletion_recovery', 'turn_deletion_recovery',
             'session_deletion_recovery', 'package_deletion_recovery',
             'pool_deletion_recovery', 'target_deletion_recovery', 'lost', ?, ?, ?, ?,
             0, 1, 'sandbox_deletion_recovery', 'unanchored', 'needs-evidence'
           )`
        )
        .run(workspace.id, timestamp, timestamp, timestamp, timestamp);
    } else if (blocker === 'physical worker cleanup') {
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state,
             physical_cleaned_at, created_at, updated_at
           ) VALUES (
             'lease_deletion_backend', ?, 'thread_deletion_backend',
             'turn_deletion_backend', 'session_deletion_backend',
             'package_deletion_backend', 'test', 'deployment_deletion_backend',
             'backend_deletion_backend', 'target_deletion_backend',
             '{"imageRef":"openkit/test:deletion"}', 'sandbox_deletion_backend',
             'server/runtime/deletion-backend',
             'complete', 'physical-cleaned', ?, ?, ?
           )`
        )
        .run(workspace.id, timestamp, timestamp, timestamp);
    } else {
      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(workspaceDb);
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

    const response = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe('fenced');
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_registry WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ revision: 1, status: 'active' });
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('terminates a pre-transition deletion request when its original owner is disabled at boot', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-disabled-boot-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Disabled owner deletion fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const requestId = '00000000-0000-4000-8000-000000000016';
    createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'user_local',
      requestId,
      workspaceId: workspace.id,
    });
    coreDb.sqlite.transaction(() => disableCanonicalUser(coreDb, 'user_local'))();
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
        ) VALUES ('user_admin', 'Admin', 'admin@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    const admin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_admin',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Live disabled owner deletion fixture');
    const deletingWorkspace = store.createWorkspace('Post-transition disabled owner fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: deletingWorkspace.id,
    });
    const requestId = '00000000-0000-4000-8000-000000000023';
    const deletingRequestId = '00000000-0000-4000-8000-000000000025';
    const deletingRequest = createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${deletingWorkspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'user_local',
      requestId: deletingRequestId,
      workspaceId: deletingWorkspace.id,
    });
    coreDb.sqlite.transaction(() =>
      beginWorkspaceDeletion({
        coreDb,
        expectedRegistryRevision: 1,
        originalOwnerUserId: 'user_local',
        workspaceId: deletingWorkspace.id,
      })
    )();
    writeWorkspaceDeletionRequest(dataRoot, { ...deletingRequest, phase: 'deleting' });
    const mutationAdmission = new WorkspaceMutationAdmission();
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'server',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
      workspaceMutationAdmission: mutationAdmission,
    });
    const releaseMutation = mutationAdmission.enter(workspace.id);
    if (!releaseMutation) {
      throw new Error('Expected the active Workspace mutation to be admitted.');
    }
    createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'user_local',
      requestId,
      workspaceId: workspace.id,
    });

    const responsePromise = app.request('https://openkit.test/api/app/users/user_local/disable', {
      body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000024' }),
      headers: {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
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
    expect(
      readWorkspaceDeletionRequest(dataRoot, deletingWorkspace.id, deletingRequestId).phase
    ).toBe('deleting');
    expect(mutationAdmission.isClosed(deletingWorkspace.id)).toBe(true);
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('keeps the mutation fence closed without rewriting conflicting deletion requests at boot', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-conflict-boot-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Conflicting deletion fixture');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
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
        originalOwnerUserId: 'user_local',
        requestId,
        workspaceId: workspace.id,
      });
    }
    coreDb.sqlite.transaction(() => disableCanonicalUser(coreDb, 'user_local'))();
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
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('restores registry-owned boot fences without relying on a nonterminal request', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-registry-boot-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const deletingWorkspace = store.createWorkspace('Deleting registry fixture');
    const deletedWorkspace = store.createWorkspace('Deleted registry fixture');
    for (const workspace of [deletingWorkspace, deletedWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
      coreDb.sqlite.transaction(() =>
        beginWorkspaceDeletion({
          coreDb,
          expectedRegistryRevision: 1,
          originalOwnerUserId: 'user_local',
          workspaceId: workspace.id,
        })
      )();
    }
    coreDb.sqlite.transaction(() =>
      completeWorkspaceDeletion({
        coreDb,
        expectedRegistryRevision: 2,
        originalOwnerUserId: 'user_local',
        workspaceId: deletedWorkspace.id,
      })
    )();
    const requestId = '00000000-0000-4000-8000-000000000030';
    const request = createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${deletedWorkspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'user_local',
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
      recoveryExportId: `wsexp_delete_${requestId}`,
      recoveryExportManifestDigest: 'export-digest',
      stagingRelativePath: workspaceDeletionStagingRelativePath(deletedWorkspace.id, requestId),
      terminalAuditEventId: 'workspace-delete-audit',
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
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it.each([
  'export',
  'closure',
  'staged-contradiction',
] as const)('handles the %s crash boundary without duplicating or committing contradictory state', async (crashPoint) => {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-workspace-deletion-${crashPoint}-resume-`));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace(`${crashPoint} crash fixture`);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const repositoryWorkspaceDb = (workspaceId: string) => {
      const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(workspaceDb);
      return workspaceDb;
    };
    const requestId = {
      export: '00000000-0000-4000-8000-000000000021',
      closure: '00000000-0000-4000-8000-000000000022',
      'staged-contradiction': '00000000-0000-4000-8000-000000000026',
    }[crashPoint];
    let request = createWorkspaceDeletionRequest(dataRoot, {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      originalOwnerUserId: 'user_local',
      requestId,
      workspaceId: workspace.id,
    });
    coreDb.sqlite.transaction(() =>
      beginWorkspaceDeletion({
        coreDb,
        expectedRegistryRevision: 1,
        originalOwnerUserId: 'user_local',
        workspaceId: workspace.id,
      })
    )();
    request = writeWorkspaceDeletionRequest(dataRoot, { ...request, phase: 'deleting' });
    const exportId = `wsexp_delete_${requestId}`;
    const exported = createVerifiedWorkspaceExport({
      authorityUserId: 'user_local',
      coreDb,
      dataRoot,
      exportId,
      repositoryWorkspaceDb,
      store,
      workspaceId: workspace.id,
    }).verified;
    if (crashPoint !== 'export') {
      request = writeWorkspaceDeletionRequest(dataRoot, {
        ...request,
        phase: 'exported',
        recoveryExportId: exportId,
        recoveryExportManifestDigest: exported.manifestDigest,
      });
      const closure = createWorkspaceDeletionClosure({
        closureId: `wsclose_delete_${requestId}`,
        coreDb,
        cutoffTimestamp: new Date().toISOString(),
        dataRoot,
        originalOwnerUserId: 'user_local',
        recoveryExportId: exportId,
        recoveryExportManifestDigest: exported.manifestDigest,
        repositoryWorkspaceDb,
        requestId,
        sourceRegistryRevision: 2,
        workspaceId: workspace.id,
      });
      if (crashPoint === 'staged-contradiction') {
        request = writeWorkspaceDeletionRequest(dataRoot, {
          ...request,
          closureDigest: closure.manifestDigest,
          closureId: closure.closureId,
          phase: 'closure-sealed',
        });
        request = writeWorkspaceDeletionRequest(dataRoot, {
          ...request,
          phase: 'staged',
          stagingRelativePath: workspaceDeletionStagingRelativePath(workspace.id, requestId),
        });
      }
    }
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      repositoryWorkspaceDb,
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });

    const response = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: request.confirmation,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    if (crashPoint === 'staged-contradiction') {
      expect(response.status).toBe(409);
      expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe('staged');
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
      recoveryExportId: exportId,
    });
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

it('terminates ordinary Workspace authority and retains exact Core tombstone lineage', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-terminal-'));
  const workspaceBackupParent = mkdtempSync(join(tmpdir(), 'openkit-workspace-deletion-backup-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Terminal deletion fixture');
    const app = createApp({
      coreDb,
      dataRoot,
      mode: 'local',
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const priorExportResponse = await app.request(`/api/app/workspaces/${workspace.id}/export`, {
      method: 'POST',
    });
    expect(priorExportResponse.status, await priorExportResponse.clone().text()).toBe(200);
    const priorExport = (await priorExportResponse.json()) as { exportId: string };

    const now = Date.now();
    for (const [userId, email] of [
      ['user_member', 'member@example.com'],
      ['user_invitee', 'invitee@example.com'],
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
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, 'user_member', 'active', 'viewer', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(workspace.id, nowIso, nowIso, nowIso);
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_invitations (
          invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id,
          status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
        ) VALUES (
          'inv_workspace_deletion', ?, 'user_invitee', 'editor', 'user_local',
          'pending', '2099-01-01T00:00:00.000Z', NULL, NULL, NULL, 1, ?, ?
        )`
      )
      .run(workspace.id, nowIso, nowIso);
    const canonicalWorkspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const workspaceBackupRoot = join(workspaceBackupParent, 'workspace');
    cpSync(canonicalWorkspaceRoot, workspaceBackupRoot, { recursive: true });

    const requestId = '00000000-0000-4000-8000-000000000011';
    const response = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      deletion: {
        closureId: expect.any(String),
        phase: 'cleaned',
        recoveryExportId: expect.any(String),
        requestId,
        retainedStaging: false,
        status: 'deleted',
        workspaceId: workspace.id,
      },
    });
    const completedRequest = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    expect(completedRequest.recoveryExportId).toBe(`wsexp_delete_${requestId}`);
    expect(completedRequest.closureId).toBe(`wsclose_delete_${requestId}`);
    const workspaceExportsRoot = join(dataRoot, 'server', 'exports', 'workspaces', workspace.id);
    expect(existsSync(join(workspaceExportsRoot, priorExport.exportId))).toBe(false);
    expect(readdirSync(workspaceExportsRoot)).toEqual([completedRequest.recoveryExportId]);
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT owner_user_id, status, revision
           FROM workspace_registry WHERE workspace_id = ?`
        )
        .get(workspace.id)
    ).toEqual({ owner_user_id: 'user_local', revision: 3, status: 'deleted' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT status, access_level
           FROM workspace_members WHERE workspace_id = ? AND user_id = 'user_local'`
        )
        .get(workspace.id)
    ).toEqual({ access_level: 'editor', status: 'active' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT status, removed_at
           FROM workspace_members WHERE workspace_id = ? AND user_id = 'user_member'`
        )
        .get(workspace.id)
    ).toEqual({ removed_at: expect.any(String), status: 'removed' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT status, revoked_at
           FROM workspace_invitations WHERE invitation_id = 'inv_workspace_deletion'`
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
    expect(resolveWorkspaceRole(coreDb, workspace.id, 'user_local')).toBeNull();
    expect(listActiveWorkspaceIdsForActor(coreDb, 'user_local')).not.toContain(workspace.id);

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
    const unsafeCleanupReplay = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(unsafeCleanupReplay.status).toBe(409);
    expect(existsSync(cleanupSentinel)).toBe(true);
    writeFileSync(deletionRequestPath, `${JSON.stringify(completedRequest)}\n`);
    writeWorkspaceDeletionRequest(dataRoot, {
      ...completedRequest,
      cleanedAt: null,
      phase: 'deleted',
    });

    const deletionReplay = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
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
    const contradictoryCleanup = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(contradictoryCleanup.status).toBe(409);
    expect(existsSync(stagingRoot)).toBe(true);
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId).phase).toBe('deleted');

    rmSync(stagingRoot, { recursive: true });
    writeWorkspaceDeletionRequest(dataRoot, completedRequest);
    const contradictoryReplay = await app.request(`/api/app/workspaces/${workspace.id}/delete`, {
      body: JSON.stringify({
        confirmation: `permanently-delete-workspace:${workspace.id}:1`,
        expectedRegistryRevision: 1,
        requestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(contradictoryReplay.status).toBe(409);
    const activeWorkspaceIds = listActiveWorkspaceIdsForActor(coreDb, 'user_local');
    const contradictoryRecovery = await app.request(
      `/api/app/workspace-deletions/${workspace.id}/recover`,
      {
        body: JSON.stringify({
          deletionRequestId: requestId,
          requestId: '00000000-0000-4000-8000-000000000031',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(contradictoryRecovery.status).toBe(409);
    expect(listActiveWorkspaceIdsForActor(coreDb, 'user_local')).toEqual(activeWorkspaceIds);
    rmSync(canonicalWorkspaceRoot, { recursive: true });

    const reboundRequest = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    writeWorkspaceDeletionRequest(dataRoot, {
      ...reboundRequest,
      originalOwnerUserId: 'user_other',
    });
    const unboundRecovery = await app.request(
      `/api/app/workspace-deletions/${workspace.id}/recover`,
      {
        body: JSON.stringify({
          deletionRequestId: requestId,
          requestId: '00000000-0000-4000-8000-000000000017',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
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
    const activeBeforeManifestTamper = listActiveWorkspaceIdsForActor(coreDb, 'user_local');
    const exportManifestPath = join(
      workspaceExportsRoot,
      reboundRequest.recoveryExportId!,
      'openkit-workspace-export.json'
    );
    const exportManifestText = readFileSync(exportManifestPath, 'utf8');
    const exportManifest = JSON.parse(exportManifestText) as Record<string, unknown>;
    writeFileSync(
      exportManifestPath,
      `${JSON.stringify({ ...exportManifest, sourceDeploymentId: 'tampered' }, null, 2)}\n`
    );
    const tamperedExportRecovery = await app.request(
      `/api/app/workspace-deletions/${workspace.id}/recover`,
      {
        body: JSON.stringify({
          deletionRequestId: requestId,
          requestId: '00000000-0000-4000-8000-000000000032',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
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
      `/api/app/workspace-deletions/${workspace.id}/recover`,
      {
        body: JSON.stringify({
          deletionRequestId: requestId,
          requestId: '00000000-0000-4000-8000-000000000033',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(tamperedClosureRecovery.status).toBe(409);
    expect(listActiveWorkspaceIdsForActor(coreDb, 'user_local')).toEqual(
      activeBeforeManifestTamper
    );
    expect(readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId)).toEqual(reboundRequest);
    writeFileSync(closureManifestPath, closureManifestText);

    const unexpectedClosureFile = join(closureRoot, 'unexpected.txt');
    writeFileSync(unexpectedClosureFile, 'not inventoried');
    const extendedClosureRecovery = await app.request(
      `/api/app/workspace-deletions/${workspace.id}/recover`,
      {
        body: JSON.stringify({
          deletionRequestId: requestId,
          requestId: '00000000-0000-4000-8000-000000000018',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(extendedClosureRecovery.status).toBe(409);
    rmSync(unexpectedClosureFile);

    const recoveryRequestId = '00000000-0000-4000-8000-000000000012';
    const recoveryResponse = await app.request(
      `/api/app/workspace-deletions/${workspace.id}/recover`,
      {
        body: JSON.stringify({ deletionRequestId: requestId, requestId: recoveryRequestId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(recoveryResponse.status, await recoveryResponse.clone().text()).toBe(200);
    const recovered = (await recoveryResponse.json()) as {
      recovery: {
        sourceWorkspaceId: string;
        deletionRequestId: string;
        import: { importedWorkspaceId: string; collision: { status: string } };
      };
    };
    expect(recovered.recovery).toMatchObject({
      deletionRequestId: requestId,
      sourceWorkspaceId: workspace.id,
      import: { collision: { status: 'collides' } },
    });
    expect(recovered.recovery.import.importedWorkspaceId).not.toBe(workspace.id);
    expect(
      coreDb.sqlite
        .prepare('SELECT owner_user_id, status FROM workspace_registry WHERE workspace_id = ?')
        .get(recovered.recovery.import.importedWorkspaceId)
    ).toEqual({ owner_user_id: 'user_local', status: 'active' });
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT user_id, status, access_level FROM workspace_members
           WHERE workspace_id = ? ORDER BY user_id`
        )
        .all(recovered.recovery.import.importedWorkspaceId)
    ).toEqual([{ access_level: 'editor', status: 'active', user_id: 'user_local' }]);
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
    rmSync(workspaceBackupParent, { force: true, recursive: true });
  }
});
