// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNC_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../../packages/core-client/src/index.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureLocalUser } from '../auth/identity.js';
import { createBootReadinessSnapshot } from '../bootstrap/readiness.js';
import { createOperationInvocation } from '../operation-invocation.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './filesystem-workspace-sync.js';
import { runIdempotentCommand } from './idempotent-command.js';
import { listWorkspaceApplyPlans } from './workspace-apply-plans.js';
import {
  listWorkspaceApplyResults,
  recordWorkspaceApplyResult,
} from './workspace-apply-results.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  listWorkspaceReconciliationRecords,
  recordWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import * as workspaceReviewApplication from './workspace-review-application.js';
import { decideWorkspaceSyncReview } from './workspace-review-application.js';
import { getWorkspaceSyncReview, recordWorkspaceSyncReview } from './workspace-sync-records.js';

const routes = [
  {
    id: 'sync.review-list',
    method: 'listWorkspaceSyncReviews',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/reviews',
  },
  {
    id: 'sync.review-read',
    method: 'getWorkspaceSyncReview',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/reviews/{reviewId}',
  },
  {
    id: 'sync.review-decide',
    method: 'submitWorkspaceSyncReviewDecision',
    verb: 'POST',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/reviews/{reviewId}/decision',
  },
  {
    id: 'sync.input-snapshot-list',
    method: 'listWorkspaceInputSnapshots',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/input-snapshots',
  },
  {
    id: 'sync.materialization-list',
    method: 'listWorkspaceMaterializationRecords',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/materialization-records',
  },
  {
    id: 'sync.backend-handle-list',
    method: 'listBackendWorkspaceHandles',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/backend-handles',
  },
  {
    id: 'sync.output-manifest-list',
    method: 'listWorkerOutputManifests',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/output-manifests',
  },
  {
    id: 'sync.change-set-list',
    method: 'listWorkspaceChangeSets',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/change-sets',
  },
  {
    id: 'sync.staged-review-list',
    method: 'listStagedWorkspaceReviews',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/staged-reviews',
  },
  {
    id: 'sync.apply-result-list',
    method: 'listWorkspaceApplyResults',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/apply-results',
  },
  {
    id: 'sync.apply-plan-list',
    method: 'listWorkspaceApplyPlans',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/apply-plans',
  },
  {
    id: 'sync.reconciliation-list',
    method: 'listWorkspaceReconciliationRecords',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/reconciliation-records',
  },
  {
    id: 'sync.recovery-decide',
    method: 'submitWorkspaceRecoveryDecision',
    verb: 'POST',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/reconciliation-records/{reconciliationRecordId}/decision',
  },
  {
    id: 'sync.quarantine-list',
    method: 'listWorkspaceQuarantineRecords',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/quarantine-records',
  },
  {
    id: 'sync.apply-result-read',
    method: 'getWorkspaceApplyResult',
    verb: 'GET',
    path: '/api/app/workspaces/{workspaceId}/workspace-sync/apply-results/{applyResultId}',
  },
] as const;

describe('Workspace synchronization operation cutover', () => {
  it.each(routes)('retires the authorized former $id binding', async ({ verb, path }) => {
    const f = fixture();
    const url = path
      .replace('{workspaceId}', 'ws_demo')
      .replace('{reviewId}', f.item.review.id)
      .replace('{applyResultId}', 'war_projection')
      .replace('{reconciliationRecordId}', 'wrr_projection');
    const response = await f.app.request(url, {
      method: verb,
      headers: { authorization: `Bearer ${f.issued.secret}` },
      ...(verb === 'POST'
        ? {
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${f.issued.secret}`,
            },
            body: JSON.stringify({
              requestId: 'retirement-proof',
              decision: path.includes('reconciliation') ? 'abandon' : 'rejected',
            }),
          }
        : {}),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('404 Not Found');
  });
});

/** Complete retained review fixture; no authority is supplied by transport helpers. */
function workspaceSyncReviewRouteItem(): Parameters<typeof recordWorkspaceSyncReview>[1]['item'] {
  const patchText = 'diff --git a/docs/sync.md b/docs/sync.md\n';
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

  return {
    artifactId: 'ar_workspace_review_route',
    changeSet: {
      artifactIds: ['ar_workspace_review_route'],
      base: { commit: 'abc123', contentDigest: null },
      bundle: null,
      changedPaths: [{ binary: false, path: 'docs/sync.md', status: 'modified' }],
      createdAt: '2026-07-06T00:00:00.000Z',
      evidenceRefs: [{ kind: 'worker', ref: 'turn_route_1' }],
      head: { commit: 'def456', contentDigest: null },
      id: 'wcs_route_1',
      inputSnapshotId: 'wis_route_1',
      materializationRecordId: 'wmr_route_1',
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'artifact://route-patch',
      },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: 'ws_demo',
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
    review: {
      actionCenterRowId: 'workspace-review:swr_route_1',
      changeSetId: 'wcs_route_1',
      createdAt: '2026-07-06T00:00:00.000Z',
      diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
      id: 'swr_route_1',
      riskSummary: '1 changed path staged for route import coverage.',
      staging: {
        branch: null,
        ref: 'staging://workspace/wcs_route_1',
        strategy: 'git_worktree',
      },
      status: 'pending',
      updatedAt: '2026-07-06T00:00:00.000Z',
      validation: [],
      workspaceId: 'ws_demo',
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});

/** Creates explicit current membership, persisted review and recovery rows, and bearer authority. */
function fixture(
  options: {
    readonly?: boolean;
    accepting?: boolean;
    administrator?: boolean;
    sessionAuth?: boolean;
  } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-projections-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  if (options.administrator)
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'user_foreign', kind, display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'user_local'"
      )
      .run();
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: options.administrator ? 'user_foreign' : 'user_local',
    workspaceId: 'ws_demo',
  });
  const db = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(db);
  const item = workspaceSyncReviewRouteItem();
  recordTestWorkspaceReviewMaterialization(db, item);
  recordWorkspaceSyncReview(db, { item });
  recordWorkspaceApplyResult(db, {
    requestId: 'seed-apply-result',
    result: {
      id: 'war_projection',
      workspaceId: 'ws_demo',
      reviewId: item.review.id,
      changeSetId: item.changeSet.id,
      status: 'applied',
      appliedPaths: [],
      skippedPaths: [],
      conflictRecords: [],
      verification: [],
      commitIds: [],
      appliedAt: item.review.createdAt,
    },
  });
  recordWorkspaceReconciliationRecord(db, {
    id: 'wrr_projection',
    workspaceId: 'ws_demo',
    triggerReason: 'manual',
    affectedRecordIds: [item.changeSet.materializationRecordId],
    backendHandleSummary: {},
    backendReachability: {
      status: 'unavailable',
      checkedAt: item.review.createdAt,
      detail: 'Unavailable',
    },
    collectedOutputManifestIds: [],
    evidenceBundleIds: [],
    stateBefore: 'requires-human',
    stateAfter: 'requires-human',
    quarantineRefs: [],
    requiredHumanDecision: 'inspect_recovery',
    retentionDecision: 'retain-backend',
    startedAt: item.review.createdAt,
    finishedAt: null,
  });
  const issued = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'user_local',
    scope: options.readonly
      ? 'workspace-readonly'
      : options.administrator
        ? 'server-admin'
        : 'workspace',
    workspaceIds: options.administrator ? [] : ['ws_demo'],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const mutationAdmission = new WorkspaceMutationAdmission();
  const app = createApp({
    coreDb,
    store,
    dataRoot,
    mode: 'server',
    ...(options.sessionAuth
      ? {
          openKitConfig: { server: { publicBaseUrl: 'http://localhost:3000' } },
          auth: createBetterAuth(coreDb, {
            mode: 'server',
            env: {
              BETTER_AUTH_SECRET: 'b8-test-auth-secret-at-least-32-characters',
              BETTER_AUTH_URL: 'http://localhost:3000',
            },
          }),
        }
      : {}),
    workspaceMutationAdmission: mutationAdmission,
    ...(options.accepting === false
      ? {
          getBootReadiness: () => ({
            ...createBootReadinessSnapshot(),
            acceptingProductWork: false,
          }),
        }
      : {}),
  });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${issued.secret}` };
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    headers,
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const http = (
    id: string,
    input: Record<string, unknown>,
    credentials: Record<string, string> = { authorization: headers.authorization }
  ) => {
    const { requestId, ...body } = input;
    return app.request(`/api/app/operations/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...credentials,
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify(body),
    });
  };
  const mcp = async (id: string, input: Record<string, unknown>) => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'call', arguments: { operation: id, input } },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    return {
      isError: body.result.isError ?? false,
      value: JSON.parse(body.result.content[0].text),
    };
  };
  const observed = () => ({
    review: getWorkspaceSyncReview(db, 'ws_demo', item.review.id),
    recovery: listWorkspaceReconciliationRecords(db, 'ws_demo'),
    plans: listWorkspaceApplyPlans(db, 'ws_demo'),
    results: listWorkspaceApplyResults(db, 'ws_demo'),
    receipts: store.listCommandRequests(),
  });
  cleanups.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { app, coreDb, db, store, item, http, mcp, client, observed, issued, mutationAdmission };
}

/** All complete selectors share the existing closed input schemas. */
function inputs() {
  return Object.fromEntries(
    Object.entries(SYNC_OPERATION_DEFINITIONS).map(([id, definition]) => [
      id,
      {
        workspaceId: 'ws_demo',
        ...('reviewId' in definition.inputSchema.shape ? { reviewId: 'swr_route_1' } : {}),
        ...('applyResultId' in definition.inputSchema.shape
          ? { applyResultId: 'war_projection' }
          : {}),
        ...('reconciliationRecordId' in definition.inputSchema.shape
          ? { reconciliationRecordId: 'wrr_projection' }
          : {}),
        ...(definition.mutating
          ? {
              requestId: `req-${id}`,
              decision: id === 'sync.review-decide' ? 'rejected' : 'abandon',
            }
          : {}),
      },
    ])
  );
}

/** Creates a real foreign-owned filesystem review with staged bytes and exact no-write observations. */
async function foreignFilesystemFixture() {
  const f = fixture({ administrator: true, sessionAuth: true });
  const targetRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-admin-target-'));
  const workerRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-admin-worker-'));
  const stagingRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-admin-staging-'));
  cleanups.push(() => {
    for (const root of [targetRoot, workerRoot, stagingRoot])
      rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(targetRoot, 'review.txt'), 'before\n');
  writeFileSync(join(workerRoot, 'review.txt'), 'after\n');
  const common = {
    createdAt: f.item.review.createdAt,
    resourceId: 'fs_admin',
    workspaceId: 'ws_demo',
  };
  const before = await createFilesystemSnapshotManifest({ ...common, rootPath: targetRoot });
  const after = await createFilesystemSnapshotManifest({ ...common, rootPath: workerRoot });
  const changeSet = buildFilesystemWorkspaceChangeSet({
    before,
    after,
    changeSetId: 'wcs_admin',
    createdAt: common.createdAt,
    inputSnapshotId: 'wis_admin',
    materializationRecordId: 'wmr_admin',
  });
  await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
  const item = {
    ...f.item,
    artifactId: 'ar_admin',
    changeSet,
    patchPayload: null,
    review: {
      ...f.item.review,
      id: 'swr_admin',
      actionCenterRowId: 'workspace-review:swr_admin',
      changeSetId: changeSet.id,
      staging: {
        branch: null,
        ref: 'filesystem-staging://swr_admin',
        strategy: 'filesystem_staging' as const,
      },
    },
  };
  recordTestWorkspaceReviewMaterialization(f.db, item);
  recordWorkspaceSyncReview(f.db, { item });
  recordFilesystemWorkspaceStagingRoot(f.db, {
    before,
    changeSetId: changeSet.id,
    createdAt: common.createdAt,
    reviewId: item.review.id,
    stagingRootPath: stagingRoot,
    targetRootPath: targetRoot,
    workspaceId: 'ws_demo',
  });
  const observedFilesystem = () => ({
    targetBytes: readFileSync(join(targetRoot, 'review.txt')),
    review: getWorkspaceSyncReview(f.db, 'ws_demo', item.review.id),
    plans: listWorkspaceApplyPlans(f.db, 'ws_demo').filter(
      (plan) => plan.reviewId === item.review.id
    ),
    results: listWorkspaceApplyResults(f.db, 'ws_demo').filter(
      (result) => result.reviewId === item.review.id
    ),
    receipts: f.store.listCommandRequests(),
  });
  return { ...f, filesystemItem: item, targetRoot, observedFilesystem };
}

/** Signs in through the real Web authentication route and returns the authenticated user's cookie. */
async function webSession(f: ReturnType<typeof fixture>) {
  const response = await f.app.request('http://localhost:3000/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({
      email: 'sync-admin@example.com',
      name: 'Sync administrator',
      password: 'test-password-123456',
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeTruthy();
  const body = await response.json();
  const userId: string = body.user.id;
  const session = await f.app.request('http://localhost:3000/api/auth/get-session', {
    headers: { cookie: cookie! },
  });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { id: userId } });
  return { userId, credentials: { cookie: cookie!, origin: 'http://localhost:3000' } };
}

/** Verifies that authentication and application preserve the foreign owner and every membership row. */
function workspaceOwnership(f: ReturnType<typeof fixture>) {
  return {
    owner: f.coreDb.sqlite
      .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
      .get('ws_demo'),
    members: f.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id')
      .all('ws_demo'),
  };
}

describe('Workspace synchronization native projections', () => {
  it.each([
    'sync.review-list',
    'sync.review-decide',
    'sync.recovery-decide',
  ])('propagates an unexpected admission exception for %s to the HTTP error handler', async (id) => {
    const f = fixture();
    const fault = new Error('b8-admission-fault');
    const errorHandler = vi.fn((error: Error) => {
      expect(error).toBe(fault);
      return new Response('Admission error handler', { status: 500 });
    });
    f.app.onError(errorHandler);
    vi.spyOn(f.mutationAdmission, 'isClosed').mockImplementation(() => {
      throw fault;
    });
    const before = f.observed();
    const response = await f.http(id, inputs()[id]!);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Admission error handler');
    expect(errorHandler).toHaveBeenCalledExactlyOnceWith(fault, expect.anything());
    expect(f.observed()).toEqual(before);
  });

  it.each([
    'bearer',
    'session',
  ] as const)('allows a trusted native administrator %s to apply a foreign Workspace review without membership', async (kind) => {
    const f = await foreignFilesystemFixture();
    const item = f.filesystemItem;
    const targetRoot = f.targetRoot;
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      store: f.store,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: f.mutationAdmission,
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.store.getDataRoot()!, workspaceId),
    });
    const actor =
      kind === 'bearer'
        ? {
            kind: 'token' as const,
            userId: 'user_local',
            tokenId: f.issued.record.tokenId,
            tokenScope: 'server-admin' as const,
            tokenWorkspaceIds: [],
          }
        : { kind: 'session' as const, userId: 'user_local', adminTokenId: f.issued.record.tokenId };
    const result = await invoke(
      'sync.review-decide',
      {
        workspaceId: 'ws_demo',
        reviewId: item.review.id,
        requestId: 'admin-apply',
        decision: 'accepted',
      },
      { kind: 'public', actor }
    );
    expect(result.review.status).toBe('accepted');
    expect(result.workspaceApplyResult).toMatchObject({ status: 'applied', commitIds: [] });
    expect(readFileSync(join(targetRoot, 'review.txt'), 'utf8')).toBe('after\n');
    expect(
      f.coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get('ws_demo')
    ).toMatchObject({ owner_user_id: 'user_foreign' });
  });

  it.each([
    'bearer',
    'session',
  ] as const)('authenticates an administrator %s over HTTP and applies the foreign Workspace without manufacturing membership', async (kind) => {
    const f = await foreignFilesystemFixture();
    const session = kind === 'session' ? await webSession(f) : null;
    const userId = session?.userId ?? 'user_local';
    const issued = session
      ? createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
        })
      : f.issued;
    const credentials = session?.credentials ?? { authorization: `Bearer ${issued.secret}` };
    const ownership = workspaceOwnership(f);
    expect(ownership.owner).toEqual({ owner_user_id: 'user_foreign' });
    expect(ownership.members).toEqual([expect.objectContaining({ user_id: 'user_foreign' })]);
    const owner = vi.spyOn(workspaceReviewApplication, 'decideWorkspaceSyncReview');
    const response = await f.http(
      'sync.review-decide',
      {
        workspaceId: 'ws_demo',
        reviewId: f.filesystemItem.review.id,
        requestId: 'http-admin-apply',
        decision: 'accepted',
      },
      credentials
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: { id: f.filesystemItem.review.id, workspaceId: 'ws_demo', status: 'accepted' },
      workspaceApplyResult: {
        reviewId: f.filesystemItem.review.id,
        workspaceId: 'ws_demo',
        status: 'applied',
        commitIds: [],
      },
    });
    expect(owner).toHaveBeenCalledOnce();
    expect(owner.mock.calls[0]?.[0]).toMatchObject({
      authorityActor: { kind: 'user', id: userId },
      requestActor:
        kind === 'bearer'
          ? { kind: 'token', userId, tokenId: issued.record.tokenId, tokenScope: 'server-admin' }
          : { kind: 'session', userId, adminTokenId: issued.record.tokenId },
    });
    const after = f.observedFilesystem();
    expect(after.targetBytes.toString()).toBe('after\n');
    expect(after.plans).toHaveLength(1);
    expect(after.results).toHaveLength(1);
    expect(after.receipts).toEqual([
      expect.objectContaining({
        command: 'workspace_sync.review.decide',
        requestId: 'http-admin-apply',
        scope: { workspaceId: 'ws_demo', reviewId: f.filesystemItem.review.id },
      }),
    ]);
    expect(workspaceOwnership(f)).toEqual(ownership);
  });

  it.each([
    'non-member bearer',
    'session without its last administrator token',
    'revoked administrator bearer',
  ] as const)('refuses a foreign Workspace apply over HTTP for a %s without changing protected state', async (condition) => {
    const f = await foreignFilesystemFixture();
    let credentials = { authorization: `Bearer ${f.issued.secret}` } as Record<string, string>;
    if (condition !== 'revoked administrator bearer') {
      const session = await webSession(f);
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: session.userId,
        scope: condition === 'non-member bearer' ? 'workspace' : 'server-admin',
        workspaceIds: condition === 'non-member bearer' ? ['ws_demo'] : [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      if (condition === 'non-member bearer') {
        credentials = { authorization: `Bearer ${issued.secret}` };
      } else {
        expect(
          f.coreDb.sqlite
            .prepare(
              "SELECT token_id FROM openkit_access_tokens WHERE owner_user_id = ? AND scope = 'server-admin' AND revoked_at IS NULL"
            )
            .all(session.userId)
        ).toHaveLength(1);
        revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
        credentials = session.credentials;
        // The cookie remains authenticated after losing its independently derived administrator authority.
        const authenticated = await f.app.request('http://localhost:3000/api/auth/get-session', {
          headers: credentials,
        });
        expect(authenticated.status).toBe(200);
        expect(await authenticated.json()).toMatchObject({ user: { id: session.userId } });
      }
    } else {
      revokeOpenKitAccessTokenRecord(f.coreDb, f.issued.record.tokenId);
    }
    const before = f.observedFilesystem();
    expect(before.targetBytes.toString()).toBe('before\n');
    expect(before.review?.review.status).toBe('pending');
    expect(before.plans).toEqual([]);
    expect(before.results).toEqual([]);
    expect(before.receipts).toEqual([]);
    const ownership = workspaceOwnership(f);
    const owner = vi.spyOn(workspaceReviewApplication, 'decideWorkspaceSyncReview');
    const response = await f.http(
      'sync.review-decide',
      {
        workspaceId: 'ws_demo',
        reviewId: f.filesystemItem.review.id,
        requestId: 'denied-http-admin-apply',
        decision: 'accepted',
      },
      credentials
    );
    const revoked = condition === 'revoked administrator bearer';
    expect(response.status).toBe(revoked ? 401 : 403);
    if (!revoked) expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(owner).not.toHaveBeenCalled();
    expect(f.observedFilesystem()).toEqual(before);
    expect(workspaceOwnership(f)).toEqual(ownership);
  });

  it.each([
    'bearer',
    'session',
  ] as const)('re-evaluates administrator %s authority at the filesystem effect after HTTP admission', async (kind) => {
    const f = await foreignFilesystemFixture();
    const session = kind === 'session' ? await webSession(f) : null;
    const issued = session
      ? createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: session.userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
        })
      : f.issued;
    const credentials = session?.credentials ?? { authorization: `Bearer ${issued.secret}` };
    const before = f.observedFilesystem();
    const ownership = workspaceOwnership(f);
    const enter = f.mutationAdmission.enter.bind(f.mutationAdmission);
    const admission = vi.spyOn(f.mutationAdmission, 'enter').mockImplementation((workspaceId) => {
      const release = enter(workspaceId);
      expect(release).not.toBeNull();
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      return release;
    });
    const owner = vi.spyOn(workspaceReviewApplication, 'decideWorkspaceSyncReview');
    const response = await f.http(
      'sync.review-decide',
      {
        workspaceId: 'ws_demo',
        reviewId: f.filesystemItem.review.id,
        requestId: 'effect-time-revocation',
        decision: 'accepted',
      },
      credentials
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(admission).toHaveBeenCalledExactlyOnceWith('ws_demo');
    expect(owner).toHaveBeenCalledOnce();
    expect(f.observedFilesystem()).toEqual(before);
    expect(workspaceOwnership(f)).toEqual(ownership);
  });

  it('reaches all fifteen owner outcomes through HTTP, Core Client, CLI and remote MCP with exact replay', async () => {
    const f = fixture();
    const { operationCatalog } = await import(
      new URL('../../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const ownedResponses: Record<string, unknown> = {
      'sync.review-list': { items: [f.item] },
      'sync.review-read': f.item,
      'sync.review-decide': {
        review: { id: f.item.review.id, status: 'rejected' },
        workspaceApplyResult: null,
      },
      'sync.input-snapshot-list': { items: [{ id: f.item.changeSet.inputSnapshotId }] },
      'sync.materialization-list': { items: [{ id: f.item.changeSet.materializationRecordId }] },
      'sync.backend-handle-list': {
        items: [{ id: `bwh_${f.item.changeSet.materializationRecordId}` }],
      },
      'sync.output-manifest-list': { items: [{ id: `wom_${f.item.changeSet.id}` }] },
      'sync.change-set-list': { items: [f.item.changeSet] },
      'sync.staged-review-list': { items: [{ id: f.item.review.id, status: 'rejected' }] },
      'sync.apply-result-list': { items: [{ id: 'war_projection', status: 'applied' }] },
      'sync.apply-plan-list': { items: [] },
      'sync.reconciliation-list': {
        items: [{ id: 'wrr_projection', stateAfter: 'requires-human' }],
      },
      'sync.recovery-decide': {
        reconciliationRecord: { id: 'wrr_projection', stateAfter: 'unrecoverable' },
      },
      'sync.quarantine-list': { items: [] },
      'sync.apply-result-read': { id: 'war_projection', status: 'applied' },
    };
    for (const [id, input] of Object.entries(inputs())) {
      const response = await f.http(id, input);
      expect(response.status, id).toBe(200);
      const expected = await response.json();
      expect(expected, id).toMatchObject(ownedResponses[id]);
      const after = f.observed();
      const method = f.client.operations[id as keyof typeof SYNC_OPERATION_DEFINITIONS] as (
        input: unknown
      ) => Promise<unknown>;
      expect(await method(input), id).toEqual(expected);
      const entry = operationCatalog.find((entry: { id: string }) => entry.id === id);
      expect(entry).toBeDefined();
      expect(() => entry.inputSchema.parse({ ...input, unknownField: true })).toThrow();
      expect(await entry.handler({ client: f.client }, entry.inputSchema.parse(input)), id).toEqual(
        expected
      );
      expect(await f.mcp(id, input), id).toEqual({ isError: false, value: expected });
      expect(f.observed(), id).toEqual(after);
    }
    expect(f.observed().review?.review.status).toBe('rejected');
    expect(f.observed().recovery[0]?.stateAfter).toBe('unrecoverable');
    expect(
      f.observed().receipts.filter((row) => row.command.startsWith('workspace_sync.'))
    ).toHaveLength(2);
  });

  it('replays a retained pre-cutover receipt with the exact original decision body', async () => {
    const f = fixture();
    const input = {
      requestId: 'retained-decision',
      decision: 'rejected' as const,
      message: 'Keep captured intent.',
    };
    await runIdempotentCommand({
      store: f.store,
      inflightCommands: new WeakMap(),
      command: 'workspace_sync.review.decide',
      requestId: input.requestId,
      scope: { workspaceId: 'ws_demo', reviewId: f.item.review.id },
      input,
      responseKind: 'workspace_sync_review',
      execute: () =>
        decideWorkspaceSyncReview({
          authorityActor: { kind: 'user', id: 'user_local' },
          coreDb: f.coreDb,
          decidedAt: f.item.review.createdAt,
          decision: input.decision,
          requestId: input.requestId,
          reviewId: f.item.review.id,
          store: f.store,
          workspaceDb: f.db,
          workspaceId: 'ws_demo',
        }),
      replay: () => {
        throw new Error('Unexpected seed replay');
      },
      responseId: (result) => result.review.id,
    });
    const before = f.observed();
    const response = await f.http('sync.review-decide', {
      workspaceId: 'ws_demo',
      reviewId: f.item.review.id,
      ...input,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: { id: f.item.review.id, status: 'rejected' },
    });
    expect(f.observed()).toEqual(before);
    const conflict = await f.http('sync.review-decide', {
      workspaceId: 'ws_demo',
      reviewId: f.item.review.id,
      ...input,
      message: 'Different captured intent.',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.observed()).toEqual(before);
  });

  it.each([
    'sync.review-decide',
    'sync.recovery-decide',
  ])('refuses changed-input replay for %s through HTTP and MCP without changing owner rows or receipts', async (id) => {
    const f = fixture();
    const input = { ...inputs()[id]!, message: 'Captured decision intent.' };
    const first = await f.http(id, input);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject(
      id === 'sync.review-decide'
        ? { review: { id: f.item.review.id, status: 'rejected' } }
        : { reconciliationRecord: { id: 'wrr_projection', stateAfter: 'unrecoverable' } }
    );
    const before = f.observed();
    const conflictingInput = { ...input, message: 'Changed decision intent.' };
    const conflict = await f.http(id, conflictingInput);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.observed()).toEqual(before);
    expect(await f.mcp(id, conflictingInput)).toMatchObject({
      isError: true,
      value: { code: 'idempotency_key_conflict' },
    });
    expect(f.observed()).toEqual(before);
  });

  it.each(
    ['sync.review-decide', 'sync.recovery-decide'].flatMap((id) =>
      ['readonly', 'closed readiness', 'missing child', 'deletion fence', 'revoked'].map(
        (condition) => ({ id, condition })
      )
    )
  )('denies $condition before $id changes its row or receipt', async ({ id, condition }) => {
    const f = fixture({
      readonly: condition === 'readonly',
      accepting: condition !== 'closed readiness',
    });
    const input = inputs()[id]!;
    if (condition === 'missing child') {
      if (id === 'sync.review-decide') input.reviewId = 'missing';
      else input.reconciliationRecordId = 'missing';
    }
    if (condition === 'deletion fence') await f.mutationAdmission.close('ws_demo');
    if (condition === 'revoked') {
      revokeOpenKitAccessTokenRecord(f.coreDb, f.issued.record.tokenId);
      const before = f.observed();
      expect((await f.http(id, input)).status).toBe(401);
      const revokedMcp = await f.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.issued.secret}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { operation: id, input } },
        }),
      });
      expect(revokedMcp.status).toBe(401);
      expect(revokedMcp.headers.get('www-authenticate')).toBe('Bearer');
      expect(f.observed()).toEqual(before);
      return;
    }
    const before = f.observed();
    const response = await f.http(id, input);
    const code =
      condition === 'closed readiness' ? 'product_work_unavailable' : 'workspace_access_denied';
    expect(response.status).toBe(condition === 'closed readiness' ? 503 : 403);
    expect(await response.json()).toMatchObject({ code });
    expect(await f.mcp(id, input)).toMatchObject({ isError: true, value: { code } });
    expect(f.observed()).toEqual(before);
  });
});
