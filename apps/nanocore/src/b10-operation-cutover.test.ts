import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OperationId,
  workerEnvironmentActivationConfirmation,
} from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from './audit-events.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { computeBootReadinessSnapshot } from './bootstrap/readiness.js';
import { quickChatWorkspaceIdForUser } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import * as workerOwner from './worker-environments/worker-environment-operations.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const digest = `sha256:${'b'.repeat(64)}`;
const storageRef = `wst_${'a'.repeat(32)}`;
const requestId = '11111111-1111-4111-8111-111111111111';
const candidate = { artifactId: 'artifact_missing', artifactVersion: 1, contentDigest: digest };
const activation = {
  affectedStorage: [],
  configuration: { fileId: 'agents/codex.agent.jsonc', expectedRevision: digest },
  replaceNow: null,
  resolvedCandidate: candidate,
  target: { kind: 'agent', agentId: 'codex' },
};
const inputs = [
  ['GET', '/api/app/workspaces/ws_demo/worker-environments', {}],
  [
    'POST',
    '/api/app/workspaces/ws_demo/worker-environments/select',
    {
      storageRef,
      expectedRevision: 1,
      layoutDigest: digest,
      purpose: 'work',
      threadId: 'thread_missing',
    },
  ],
  ['GET', `/api/app/workspaces/ws_demo/worker-environments/${storageRef}/status`, {}],
  [
    'POST',
    `/api/app/workspaces/ws_demo/worker-environments/${storageRef}/purge`,
    {
      storageRef,
      requestId,
      expectedRevision: 1,
      confirmation: `purge-worker-environment:${storageRef}:1`,
    },
  ],
  [
    'POST',
    '/api/app/worker-environments/prepare',
    {
      mode: 'recover',
      administrationThreadId: 'thread_missing',
      requestId,
      recoverFrom: candidate,
    },
  ],
  [
    'POST',
    '/api/app/worker-environments/activate',
    {
      ...activation,
      requestId,
      confirmation: workerEnvironmentActivationConfirmation({
        ...activation,
        target: { kind: 'agent', agentId: 'codex' },
        image: { digest, environmentDefaults: { defaultsDigest: digest } },
      }),
    },
  ],
  [
    'POST',
    '/api/app/administration/configuration/apply',
    {
      requestId,
      candidate,
      confirmation: { action: 'administration.configuration.apply', contentDigest: digest },
    },
  ],
  [
    'POST',
    '/api/app/administration/conversation-turns',
    { requestId, input: 'Inspect configuration', threadId: 'thread_missing' },
  ],
  [
    'POST',
    '/api/app/app-update/prepare',
    {
      expectedCurrentImageId: digest,
      source: { kind: 'release', appDigest: digest, sourceCommit: 'a'.repeat(40), tag: 'v0.1.0' },
    },
  ],
  ['POST', '/api/app/app-update/start', { requestId, maintenanceConsent: true }],
  ['GET', `/api/app/app-update/${requestId}`, {}],
] as const;

describe('B10 retired routes', () => {
  it.each(inputs)('removes authorized %s %s without an alias', async (method, path, input) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b10-retirement-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    for (const workspace of store.listWorkspaces())
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
    const app = createApp({ coreDb, dataRoot, store });
    try {
      const response = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('404 Not Found');
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

/** Builds real credential and storage authority with a host spy that cannot perform external effects. */
function admittedFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b10-admission-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  for (const workspace of store.listWorkspaces())
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    tokenId: 'token_b10_admission',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let readiness = computeBootReadinessSnapshot({ bootId: 'boot_b10' });
  const host = vi.fn(async () => {
    throw new Error('Unexpected host effect.');
  });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    getBootReadiness: () => readiness,
    appUpdateHostTransport: { invoke: host },
  });
  return {
    coreDb,
    store,
    app,
    host,
    token,
    closeAdmission: () => {
      readiness = { ...readiness, acceptingProductWork: false };
    },
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
    http: (operation: OperationId, input: Record<string, unknown>) =>
      app.request(
        ...operationRequest(
          operation,
          {},
          {
            headers: { authorization: `Bearer ${token.secret}` },
            body: JSON.stringify(input),
          }
        )
      ),
    mcp: async (operation: OperationId, input: Record<string, unknown>) => {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.secret}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { operation, input } },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      return { isError: body.result.isError, ...JSON.parse(body.result.content[0].text) };
    },
  };
}

describe('B10 admission and family errors', () => {
  it('gates all eight mutations through HTTP and MCP before receipts, private Threads or host effects change', async () => {
    const f = admittedFixture();
    const quickChatId = quickChatWorkspaceIdForUser('user_local');
    const beforeThreads = f.store.listThreads(quickChatId);
    const beforeAudit = listServerAuditEvents(f.coreDb).filter((event) =>
      event.action.startsWith('app.update.')
    );
    f.closeAdmission();
    try {
      for (const [operation, input] of [
        ['worker-environment.purge', { ...inputs[3][2], workspaceId: 'ws_demo' }],
        [
          'worker-environment.prepare',
          {
            administrationThreadId: 'thread_missing',
            requestId,
            configuration: { fileId: 'agents/codex.agent.jsonc', expectedRevision: digest },
            declaration: { kind: 'reference', ref: digest, pullPolicy: 'never' },
            target: { kind: 'agent', agentId: 'codex' },
          },
        ],
        [
          'worker-environment.recover',
          { administrationThreadId: 'thread_missing', requestId, recoverFrom: candidate },
        ],
        ['worker-environment.activate', inputs[5][2]],
        ['administration.configuration-apply', inputs[6][2]],
        ['administration.conversation-submit', inputs[7][2]],
        ['app-update.prepare', inputs[8][2]],
        ['app-update.start', inputs[9][2]],
      ] as const) {
        const http = await f.http(operation, input);
        expect(http.status, operation).toBe(503);
        await expect(http.json()).resolves.toMatchObject({ code: 'product_work_unavailable' });
        expect(await f.mcp(operation, input)).toMatchObject({
          isError: true,
          status: 503,
          code: 'product_work_unavailable',
        });
        expect(f.host).not.toHaveBeenCalled();
        expect(
          listServerAuditEvents(f.coreDb).filter((event) => event.action.startsWith('app.update.'))
        ).toEqual(beforeAudit);
        expect(f.store.listThreads(quickChatId)).toEqual(beforeThreads);
        expect(
          f.store.getCommandRequest('worker_environment.purge', requestId, {
            workspaceId: 'ws_demo',
          })
        ).toBeNull();
        expect(
          f.store.getCommandRequest('conversation.submit', requestId, {
            actorId: 'user_local',
            workspaceId: quickChatId,
            threadId: 'thread_missing',
          })
        ).toBeNull();
      }
    } finally {
      f.close();
    }
  });

  it('refuses model-mediated App update before host handoff and start audit publication', async () => {
    const f = admittedFixture();
    try {
      for (const [operation, input] of [
        ['app-update.prepare', inputs[8][2]],
        ['app-update.start', inputs[9][2]],
        ['app-update.status', { requestId }],
      ] as const) {
        expect(await f.mcp(operation, input)).toMatchObject({
          isError: true,
          status: 403,
          code: 'unsupported_operation',
        });
        expect(f.host).not.toHaveBeenCalled();
        expect(
          listServerAuditEvents(f.coreDb).filter((event) => event.action.startsWith('app.update.'))
        ).toEqual([]);
      }
    } finally {
      f.close();
    }
  });

  it('preserves a known Worker owner refusal through HTTP and MCP and lets unknown faults escape', async () => {
    const actual = workerOwner.createWorkerEnvironmentOperations;
    let failure: Error = new workerOwner.WorkerEnvironmentOperationError(
      'revision_conflict',
      'Retained environment revision changed.'
    );
    vi.spyOn(workerOwner, 'createWorkerEnvironmentOperations').mockImplementation(
      (dependencies) => ({
        ...actual(dependencies),
        list: () => {
          throw failure;
        },
      })
    );
    const f = admittedFixture();
    try {
      const response = await f.http('worker-environment.list', { workspaceId: 'ws_demo' });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'revision_conflict',
        message: failure.message,
      });
      expect(await f.mcp('worker-environment.list', { workspaceId: 'ws_demo' })).toMatchObject({
        isError: true,
        status: 409,
        code: 'revision_conflict',
        message: failure.message,
      });
      failure = new Error('CANARY_B10_NATIVE: Unexpected owner fault at /private/native/worker.');
      const unknown = await f.http('worker-environment.list', { workspaceId: 'ws_demo' });
      expect(unknown.status).toBe(500);
      const body = await unknown.text();
      expect(body).toBe('Internal Server Error');
      expect(body).not.toContain('CANARY_B10_NATIVE');
      expect(body).not.toContain(failure.message);
      expect(body).not.toContain('/private/native/worker');
      const mcp = await f.mcp('worker-environment.list', { workspaceId: 'ws_demo' });
      expect(mcp).toEqual({
        isError: true,
        code: 'operation_failed',
        message: 'Operation failed. Inspect the owner outcome before retrying.',
      });
      expect(JSON.stringify(mcp)).not.toContain('CANARY_B10_NATIVE');
      expect(JSON.stringify(mcp)).not.toContain(failure.message);
      expect(JSON.stringify(mcp)).not.toContain('/private/native/worker');
      expect(f.host).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });
});
