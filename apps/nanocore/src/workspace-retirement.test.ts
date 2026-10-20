// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from './bootstrap/readiness.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  markWorkerStorageAttachmentUnknown,
  reserveWorkerStorageAttachment,
} from './runtime/worker-storage-bindings.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import * as databases from './storage/db.js';
import { workspaceDbPath } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { createWorkspaceDeletionRequest } from './workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const OPERATION = 'workspace.retire-quarantined';
const ADMIN = testEntityId('usr', 'retirement-administrator');
const NOW = '2026-10-20T00:00:00.000Z';
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** Inventories every entry without following links; inode identity detects replacement and hard-link loss. */
function retainedTree(root: string): unknown[] {
  if (!existsSync(root)) return [];
  const entries: unknown[] = [];
  const visit = (relative: string) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    entries.push({
      relative,
      mode: stat.mode,
      ino: stat.ino,
      nlink: stat.nlink,
      value: stat.isSymbolicLink()
        ? readlinkSync(path)
        : stat.isFile()
          ? readFileSync(path).toString('base64')
          : null,
    });
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
  };
  visit('.');
  return entries;
}

/** Composes native HTTP, current credentials, real Core, file Store and the existing mutation gate. */
function fixture(fault: 'corrupt' | 'missing' | 'records' | 'index' | 'healthy' = 'corrupt') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'retained-retirement-'));
  const coreDb = databases.openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Retirement administrator', 'retirement@example.invalid', 0, 1, 1, 'human', 'active')"
    )
    .run(ADMIN);
  const store = new FsStore({ dataRoot });
  const workspaceId = store.createWorkspace('Retained private canary').id;
  const siblingId = store.createWorkspace('Healthy sibling').id;
  for (const id of [workspaceId, siblingId])
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: id, ownerUserId: FIXTURE_LOCAL_USER_ID });
  coreDb.sqlite
    .prepare(`INSERT INTO workspace_invitations (
    invitation_id, workspace_id, invitee_user_id, inviter_user_id, status, expires_at, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'pending', '2999-01-01T00:00:00.000Z', 1, ?, ?)`)
    .run(
      testEntityId('inv', 'retirement-pending-invitation'),
      workspaceId,
      ADMIN,
      FIXTURE_LOCAL_USER_ID,
      NOW,
      NOW
    );
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: ADMIN,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const member = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'workspace',
    workspaceIds: [workspaceId, siblingId],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const admission = new WorkspaceMutationAdmission();
  const gateway = createDefaultWorkerMcpGateway(coreDb);
  const executor = new SimulatedTurnExecutor();
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    workspaceMutationAdmission: admission,
    workerMcpGateway: gateway,
    turnExecutor: executor,
  });
  disposals.push(async () => {
    await gateway.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const db = databases.openWorkspaceDb(dataRoot, workspaceId);
  try {
    db.sqlite
      .prepare(`INSERT INTO evidence_bundles (
      evidence_bundle_id, workspace_id, thread_id, goal_id, turn_id, agent_session_id, backend_type,
      source_kind, summary, raw_evidence_refs_json, redacted_evidence_refs_json, content_digests_json,
      retention_class, sensitivity_class, import_status, required_features_json, created_at
    ) VALUES ('ev_retirement_hold', ?, NULL, NULL, NULL, NULL, NULL, 'test', 'Retained hold', '[]', '[]', '[]', 'legal-hold', 'product-safe', 'verified', '[]', ?)`)
      .run(workspaceId, NOW);
    db.sqlite
      .prepare(`INSERT INTO workspace_quarantine_records (
      quarantine_record_id, workspace_id, failure_kind, resolution, payload_json, created_at, updated_at, resolved_at
    ) VALUES ('quarantine_retirement_hold', ?, 'schema_failure', 'pending', ?, ?, ?, NULL)`)
      .run(
        workspaceId,
        JSON.stringify({
          id: 'quarantine_retirement_hold',
          workspaceId,
          lifecycleRecordIds: [],
          failureKind: 'schema_failure',
          storageRef: 'evidence/quarantine/retained.json',
          retentionClass: 'legal-hold',
          requiredHumanDecision: 'Release legal hold.',
          resolution: 'pending',
          createdAt: NOW,
          updatedAt: NOW,
          resolvedAt: null,
        }),
        NOW,
        NOW
      );
  } finally {
    db.sqlite.close();
  }
  // Opaque retained material is not an invented product record or a replacement hold authority.
  const opaque = join(workspaceRoot, 'evidence', 'retained-opaque');
  mkdirSync(opaque, { recursive: true });
  writeFileSync(join(opaque, 'original.bin'), Buffer.from([0, 255, 1, 128]));
  if (fault === 'missing') rmSync(workspaceDbPath(dataRoot, workspaceId));
  if (fault === 'corrupt')
    writeFileSync(
      workspaceDbPath(dataRoot, workspaceId),
      'Unreadable Workspace authority; never an empty hold inventory.'
    );
  if (fault === 'records')
    writeFileSync(join(workspaceRoot, 'workspace-record.json'), '{invalid canonical envelope');
  if (fault === 'index')
    refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'index' });
  databases.verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
    FsStore.validateFileAuthority(dataRoot)
  );
  expect(isScopeAdmitted(dataRoot, 'workspace', workspaceId)).toBe(
    fault === 'healthy' || fault === 'index'
  );
  expect(isScopeAdmitted(dataRoot, 'workspace', siblingId)).toBe(true);
  // Add opaque links after the real admission check; the command must not traverse or change them.
  linkSync(join(opaque, 'original.bin'), join(opaque, 'hardlink.bin'));
  symlinkSync('original.bin', join(opaque, 'relative-link'));
  const request = {
    workspaceId,
    requestId: randomUUID(),
    expectedRegistryRevision: 1,
    confirmation: `retire-quarantined-workspace:${workspaceId}:1`,
  };
  const call = (operation: string, input: Record<string, unknown> = {}, secret = admin.secret) =>
    app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        ...(typeof input.requestId === 'string' ? { 'x-openkit-request-id': input.requestId } : {}),
      },
      body: JSON.stringify(input),
    });
  return {
    dataRoot,
    coreDb,
    store,
    workspaceId,
    siblingId,
    workspaceRoot,
    admin,
    member,
    admission,
    gateway,
    executor,
    app,
    request,
    call,
  };
}

type Fixture = ReturnType<typeof fixture>;

/** Reads Core authority, not a content projection or a response-derived expectation. */
function registry(f: Fixture) {
  return f.coreDb.sqlite
    .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
    .get(f.workspaceId);
}

/** Keeps the native Core rows byte-for-byte, including unknown outcomes and storage associations. */
function rows(f: Fixture, table: string) {
  return f.coreDb.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

/** Creates existing runtime facts without launching a Worker or claiming an external effect. */
function retainRuntimeFences(f: Fixture) {
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'retirement-queue',
    triggerActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    workspaceId: f.workspaceId,
    threadId: testEntityId('th', 'retirement-thread'),
    turnId: testEntityId('tu', 'retirement-turn'),
    turnInput: 'Retained private runtime input',
    requestedAgentId: 'agent_retirement',
    now: () => NOW,
  });
  recordTestExecutionAttempt(f.coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'retirement-attempt'),
    agentSessionId: testEntityId('as', 'retirement-session'),
    inputRef: 'retained-package',
    bindingRef: 'retained-binding',
    sessionCompatibilityKey: 'b'.repeat(64),
    operationId: 'retained-uncertain-submission',
    now: () => NOW,
  });
  f.coreDb.sqlite
    .prepare(`INSERT INTO nanohost_runtime_targets (
    target_id, identity_id, deployment_id, connection_generation, predecessor_fenced, ready, fresh_empty, observed_at, slot_count
  ) VALUES ('retirement-target', 'retirement-identity', 'retirement-deployment', 1, 1, 1, 1, ?, 1)`)
    .run(NOW);
  const layout = {
    family: 'openkit-worker',
    version: '1',
    uid: 1000,
    gid: 1000,
    workingDirectory: '/tmp/openkit-bootstrap',
    platform: { architecture: 'amd64', os: 'linux' },
    targets: [{ target: '/workspace' }],
  };
  for (const state of ['reserved', 'attached', 'unknown']) {
    const binding = createWorkerStorageBinding(f.coreDb, {
      deploymentId: 'retirement-deployment',
      runtimeTargetId: 'retirement-target',
      workspaceId: f.workspaceId,
      layout,
      now: NOW,
    });
    const reserved = reserveWorkerStorageAttachment(f.coreDb, {
      authorizeContributor: () => true,
      expectedRevision: binding.revision,
      layout,
      purpose: 'work',
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
      storageRef: binding.storageRef,
      threadId: testEntityId('th', `retirement-${state}`),
      workspaceId: f.workspaceId,
      agentSessionId: testEntityId('as', `retirement-${state}`),
      runtimeTargetId: 'retirement-target',
      now: NOW,
    });
    if (state === 'attached')
      activateWorkerStorageAttachment(f.coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'retained-sandbox',
        storageRef: reserved.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
        now: NOW,
      });
    if (state === 'unknown')
      markWorkerStorageAttachmentUnknown(f.coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        storageRef: reserved.storageRef,
        now: NOW,
      });
  }
  const tables = [
    'scheduler_execution_attempts',
    'scheduler_admission_entries',
    'worker_storage_bindings',
    'worker_storage_contributors',
    'nanohost_runtime_targets',
  ];
  return () => Object.fromEntries(tables.map((table) => [table, rows(f, table)]));
}

/** Refusal must come from a registered operation, never from its absent route. */
async function expectRefused(response: Response, statuses = [400, 403, 409]) {
  expect(statuses, await response.clone().text()).toContain(response.status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toMatchObject({ code: expect.any(String) });
}

/** The exact owner grammar makes retained retirement distinct from deletion or capacity release. */
async function expectRetired(f: Fixture, response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    retirement: {
      workspaceId: f.workspaceId,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      registryRevision: 2,
      status: 'retired',
      dataRetained: true,
      storageReclaimed: false,
    },
  });
  return body;
}

describe('retained-only quarantine retirement: native operation and Core authority', () => {
  it('CONTROL: current administrator and member reach baseline authority and the healthy sibling makes progress', async () => {
    const f = fixture();
    const response = await f.call('workspace.access-recovery-read', { workspaceId: f.siblingId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recovery: {
        workspaceId: f.siblingId,
        registryRevision: 1,
        ownerUserId: FIXTURE_LOCAL_USER_ID,
      },
    });
    const members = await f.call(
      'workspace.member-list',
      { workspaceId: f.siblingId },
      f.member.secret
    );
    expect(members.status).toBe(200);
    const db = databases.openBootVerifiedWorkspaceDb(f.dataRoot, f.siblingId);
    try {
      db.sqlite.exec(
        "CREATE TABLE retirement_sibling_control (value TEXT); INSERT INTO retirement_sibling_control VALUES ('progress')"
      );
      expect(db.sqlite.prepare('SELECT value FROM retirement_sibling_control').pluck().get()).toBe(
        'progress'
      );
    } finally {
      db.sqlite.close();
    }
    expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
      scope: 'workspace',
      id: f.workspaceId,
      check: 'database',
    });
  });

  it.each([
    'corrupt',
    'missing',
  ] as const)('CONTROL: ordinary deletion cannot bypass %s hold authority', async (fault) => {
    const f = fixture(fault);
    const before = registry(f);
    const tree = retainedTree(f.workspaceRoot);
    await expectRefused(
      await f.call('workspace.delete', {
        ...f.request,
        confirmation: `permanently-delete-workspace:${f.workspaceId}:1`,
      }),
      [409]
    );
    expect(registry(f)).toEqual(before);
    expect(retainedTree(f.workspaceRoot)).toEqual(tree);
    expect(
      existsSync(join(f.dataRoot, 'server', 'exports', 'workspace-deletions', f.workspaceId))
    ).toBe(false);
  });

  it.each([
    'corrupt',
    'missing',
    'records',
  ] as const)('retires %s authority without opening content, altering any retained entry or releasing runtime fences', async (fault) => {
    const f = fixture(fault);
    const runtime = retainRuntimeFences(f);
    const beforeRuntime = runtime();
    const tree = retainedTree(f.workspaceRoot);
    const exports = retainedTree(join(f.dataRoot, 'server', 'exports'));
    const members = rows(f, 'workspace_members');
    const invitations = rows(f, 'workspace_invitations');
    const open = vi.spyOn(databases, 'openWorkspaceDb');
    const bootOpen = vi.spyOn(databases, 'openBootVerifiedWorkspaceDb');
    const content = vi.spyOn(f.store, 'getWorkspace');
    const listing = vi.spyOn(f.store, 'listWorkspaces');
    const submit = vi.spyOn(f.executor, 'submit');
    const release = vi.spyOn(f.executor, 'release');
    const response = await f.call(OPERATION, f.request);
    expect(open).not.toHaveBeenCalled();
    expect(bootOpen).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(listing).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(runtime()).toEqual(beforeRuntime);
    expect(retainedTree(f.workspaceRoot)).toEqual(tree);
    expect(retainedTree(join(f.dataRoot, 'server', 'exports'))).toEqual(exports);
    expect(rows(f, 'workspace_members')).toEqual(members);
    expect(rows(f, 'workspace_invitations')).toEqual(invitations);
    await expectRetired(f, response);
    expect(registry(f)).toMatchObject({
      status: 'retired',
      revision: 2,
      owner_user_id: FIXTURE_LOCAL_USER_ID,
    });
    expect(f.admission.isClosed(f.workspaceId)).toBe(true);
    expect(f.admission.enter(f.workspaceId)).toBeNull();
    const sibling = await f.call(
      'workspace.member-list',
      { workspaceId: f.siblingId },
      f.member.secret
    );
    expect(sibling.status).toBe(200);
  });

  it('rejects an original owner without administrator authority before disclosing a quarantined target', async () => {
    const f = fixture();
    const before = registry(f);
    await expectRefused(await f.call(OPERATION, f.request, f.member.secret), [403]);
    await expectRefused(
      await f.call(
        OPERATION,
        { ...f.request, workspaceId: testEntityId('ws', 'retirement-absent') },
        f.member.secret
      ),
      [403]
    );
    expect(registry(f)).toEqual(before);
  });

  it.each([
    'healthy',
    'index',
  ] as const)('refuses %s scope rather than treating index degradation as authority quarantine', async (fault) => {
    const f = fixture(fault);
    const before = registry(f);
    await expectRefused(await f.call(OPERATION, f.request), [409]);
    expect(registry(f)).toEqual(before);
    expect(f.admission.isClosed(f.workspaceId)).toBe(false);
  });

  it.each([
    'revision',
    'confirmation',
    'missing-registry',
    'deletion-owned',
  ] as const)('refuses %s without a retirement receipt or authority change', async (conflict) => {
    const f = fixture();
    const request = { ...f.request };
    if (conflict === 'revision') {
      request.expectedRegistryRevision = 2;
      request.confirmation = `retire-quarantined-workspace:${f.workspaceId}:2`;
    }
    if (conflict === 'confirmation')
      request.confirmation = `permanently-delete-workspace:${f.workspaceId}:1`;
    if (conflict === 'missing-registry') {
      request.workspaceId = testEntityId('ws', 'retirement-absent');
      request.confirmation = `retire-quarantined-workspace:${request.workspaceId}:1`;
    }
    if (conflict === 'deletion-owned')
      createWorkspaceDeletionRequest(f.dataRoot, {
        workspaceId: f.workspaceId,
        requestId: randomUUID(),
        originalOwnerUserId: FIXTURE_LOCAL_USER_ID,
        initiatingUserId: FIXTURE_LOCAL_USER_ID,
        expectedRegistryRevision: 1,
        confirmation: `permanently-delete-workspace:${f.workspaceId}:1`,
        createdAt: NOW,
      });
    const before = registry(f);
    const receipts = rows(f, 'idempotency_requests');
    const tree = retainedTree(f.workspaceRoot);
    await expectRefused(
      await f.call(OPERATION, request),
      conflict === 'missing-registry' ? [403, 404, 409] : [400, 409]
    );
    expect(registry(f)).toEqual(before);
    expect(rows(f, 'idempotency_requests')).toEqual(receipts);
    expect(retainedTree(f.workspaceRoot)).toEqual(tree);
  });

  it('collapses duplicate delivery, retains the original audit/receipt, and conflicts on changed input or a second request', async () => {
    const f = fixture();
    const beforeAudit = rows(f, 'audit_events');
    const responses = await Promise.all([
      f.call(OPERATION, f.request),
      f.call(OPERATION, f.request),
    ]);
    const result = await expectRetired(f, responses[0]!);
    expect(await expectRetired(f, responses[1]!)).toEqual(result);
    const audit = rows(f, 'audit_events');
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(JSON.stringify(audit.at(-1))).toContain(f.workspaceId);
    expect(JSON.stringify(audit.at(-1))).toContain(f.request.requestId);
    expect(JSON.stringify(audit.at(-1))).toContain(ADMIN);
    expect(rows(f, 'idempotency_requests')).toHaveLength(1);
    const receipts = rows(f, 'idempotency_requests');
    await expectRetired(f, await f.call(OPERATION, f.request));
    await expectRefused(
      await f.call(OPERATION, {
        ...f.request,
        expectedRegistryRevision: 2,
        confirmation: `retire-quarantined-workspace:${f.workspaceId}:2`,
      }),
      [409]
    );
    await expectRefused(
      await f.call(OPERATION, {
        ...f.request,
        workspaceId: f.siblingId,
        confirmation: `retire-quarantined-workspace:${f.siblingId}:1`,
      }),
      [409]
    );
    await expectRefused(await f.call(OPERATION, { ...f.request, requestId: randomUUID() }), [409]);
    expect(rows(f, 'audit_events')).toEqual(audit);
    expect(rows(f, 'idempotency_requests')).toEqual(receipts);
    expect(registry(f)).toMatchObject({ revision: 2, status: 'retired' });
  });

  it.each([
    'missing-receipt',
    'missing-audit',
    'contradictory-registry',
    'expired-receipt',
  ] as const)('fails closed on %s instead of applying retirement again', async (fault) => {
    const f = fixture();
    await expectRetired(f, await f.call(OPERATION, f.request));
    if (fault === 'missing-receipt') f.coreDb.sqlite.exec('DELETE FROM idempotency_requests');
    if (fault === 'missing-audit') f.coreDb.sqlite.exec('DELETE FROM audit_events');
    if (fault === 'contradictory-registry')
      f.coreDb.sqlite
        .prepare('UPDATE workspace_registry SET revision = revision + 1 WHERE workspace_id = ?')
        .run(f.workspaceId);
    if (fault === 'expired-receipt')
      f.coreDb.sqlite.exec(
        "UPDATE idempotency_requests SET expires_at = '2000-01-01T00:00:00.000Z'"
      );
    const before = registry(f);
    const audit = rows(f, 'audit_events');
    await expectRefused(await f.call(OPERATION, f.request), [409]);
    expect(registry(f)).toEqual(before);
    expect(rows(f, 'audit_events')).toEqual(audit);
  });

  it.each([
    'audit_events',
    'idempotency_requests',
  ] as const)('rolls back all Core retirement authority when %s insertion fails, then permits the original request', async (table) => {
    const f = fixture();
    const before = registry(f);
    const audit = rows(f, 'audit_events');
    const receipts = rows(f, 'idempotency_requests');
    f.coreDb.sqlite.exec(
      `CREATE TEMP TRIGGER refuse_retirement_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'retirement fault injection'); END`
    );
    const response = await f.call(OPERATION, f.request);
    // A missing route does not prove transaction rollback. The retry below must reach success too.
    await expectRefused(response, [409, 500]);
    expect(registry(f)).toEqual(before);
    expect(rows(f, 'audit_events')).toEqual(audit);
    expect(rows(f, 'idempotency_requests')).toEqual(receipts);
    f.coreDb.sqlite.exec('DROP TRIGGER refuse_retirement_insert');
    await expectRetired(f, await f.call(OPERATION, f.request));
  });

  it.each([
    'settle',
    'revoke',
    'revision',
  ] as const)('closes and drains ordinary mutations and late publishers, then rechecks %s', async (outcome) => {
    const f = fixture();
    const leave = f.admission.enter(f.workspaceId)!;
    const leavePublisher = f.admission.enterLatePublisher(f.workspaceId, 'worker-turn-closeout')!;
    let settled = false;
    const pending = Promise.resolve(f.call(OPERATION, f.request)).then((response) => {
      settled = true;
      return response;
    });
    try {
      await vi.waitFor(() => expect(f.admission.isClosed(f.workspaceId)).toBe(true), {
        timeout: 1000,
      });
      expect(settled).toBe(false);
      expect(registry(f)).toMatchObject({ status: 'active', revision: 1 });
      const siblingLeave = f.admission.enter(f.siblingId);
      expect(siblingLeave).not.toBeNull();
      siblingLeave?.();
      leave();
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === 'revoke') revokeOpenKitAccessTokenRecord(f.coreDb, f.admin.tokenId);
      if (outcome === 'revision')
        f.coreDb.sqlite
          .prepare('UPDATE workspace_registry SET revision = 2 WHERE workspace_id = ?')
          .run(f.workspaceId);
      leavePublisher();
      const response = await pending;
      if (outcome === 'settle') await expectRetired(f, response);
      else {
        await expectRefused(response, [401, 403, 409]);
        expect(registry(f)).toMatchObject({
          status: 'active',
          revision: outcome === 'revision' ? 2 : 1,
        });
        expect(rows(f, 'idempotency_requests')).toEqual([]);
      }
    } finally {
      leave();
      leavePublisher();
      await pending;
    }
  });

  it('exposes bounded quarantine and retirement metadata without content listing, paths or private material', async () => {
    const f = fixture();
    const content = vi.spyOn(f.store, 'getWorkspace');
    const listing = vi.spyOn(f.store, 'listWorkspaces');
    const open = vi.spyOn(databases, 'openWorkspaceDb');
    for (const status of ['active', 'retired'] as const) {
      if (status === 'retired') await expectRetired(f, await f.call(OPERATION, f.request));
      const response = await f.call('administration.cleanup-read');
      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as { items: Array<{ target: Record<string, unknown> }> };
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262144);
      expect(body.items.length).toBeLessThanOrEqual(100);
      expect(text).not.toContain(f.dataRoot);
      expect(text).not.toContain('Retained private canary');
      expect(content).not.toHaveBeenCalled();
      expect(listing).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(body.items.find((item) => item.target.workspaceId === f.workspaceId)).toMatchObject({
        source: 'workspace-registry',
        target: { kind: 'workspace-registry', workspaceId: f.workspaceId },
        state:
          status === 'active'
            ? {
                registryStatus: 'active',
                registryRevision: 1,
                quarantineCheck: 'database',
                retirement: null,
              }
            : {
                registryStatus: 'retired',
                registryRevision: 2,
                retirement: { dataRetained: true, storageReclaimed: false },
              },
      });
    }
  });
});
