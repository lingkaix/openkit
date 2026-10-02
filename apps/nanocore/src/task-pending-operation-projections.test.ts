import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schemas from '@openkit/app-api-schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { createBootReadinessSnapshot } from './bootstrap/readiness.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import { readPendingRequest, validateCanonicalLoad } from './runtime/pending-requests.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real authority and durable requests; every differing audience/admission fact is explicit. */
function fixture(
  options: { privateThread?: boolean; responsibleUserId?: string; accepting?: boolean } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-pending-projections-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'user_foreign', kind, display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'user_local'"
    )
    .run();
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const thread = store.createThread(
    'ws_demo',
    'Projection',
    undefined,
    'conversation',
    options.privateThread
      ? { visibility: 'private', privateOwnerUserId: 'user_foreign' }
      : { visibility: 'workspace' }
  );
  const turn = store.createTurn('ws_demo', thread.id, 'Request input', {
    kind: 'user',
    id: options.responsibleUserId ?? 'user_local',
  });
  const db = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(db);
  const common = {
    workspaceId: 'ws_demo',
    threadId: thread.id,
    raisingTurnId: turn.id,
    responsibleUserId: options.responsibleUserId ?? 'user_local',
    now: turn.startedAt!,
  };
  store.createItem({
    id: 'it_ap_projection',
    workspaceId: 'ws_demo',
    threadId: thread.id,
    turnId: turn.id,
    type: 'approval-request',
    status: 'completed',
    approvalRequestId: 'ap_projection',
    kind: 'permission',
    title: 'Approve publication',
    description: 'Publish the exact captured intent.',
    decision: null,
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  raiseRecordedPendingRequest(store, db.sqlite, {
    ...common,
    requestId: 'ap_projection',
    requestItemId: 'it_ap_projection',
    kind: 'approval',
    requesterKind: 'person',
    governedIntent: { action: 'repo.push' },
    approval: {
      kind: 'permission',
      title: 'Approve publication',
      description: 'Publish the exact captured intent.',
    },
  });
  for (const [requestId, isSecret] of [
    ['ui_projection', false],
    ['ui_withdraw', false],
    ['ui_secret', true],
  ] as const) {
    const questions = [
      {
        id: 'path',
        header: 'Path',
        question: 'Which path?',
        options: null,
        isOther: true,
        isSecret,
      },
    ];
    store.createItem({
      id: `it_${requestId}`,
      ...common,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      userInputRequestId: requestId,
      prompt: 'Which path?',
      questions,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    raiseRecordedPendingRequest(store, db.sqlite, {
      ...common,
      requestId,
      requestItemId: `it_${requestId}`,
      kind: 'user-input',
      requesterKind: 'person',
      questions,
      questionDigest: `digest-${requestId}`,
    });
  }
  for (const requestId of ['ap_projection', 'ui_projection', 'ui_withdraw', 'ui_secret']) {
    expect(
      validateCanonicalLoad(
        readPendingRequest(db.sqlite, requestId)!,
        store.listThreadTurns('ws_demo', thread.id)
      ),
      requestId
    ).toBeNull();
  }
  db.sqlite.close();
  const appOptions = {
    coreDb,
    dataRoot,
    store,
    ...(options.accepting === false
      ? {
          getBootReadiness: () => ({
            ...createBootReadinessSnapshot(),
            acceptingProductWork: false,
          }),
        }
      : {}),
  };
  return {
    app: createApp(appOptions),
    coreDb,
    dataRoot,
    store,
    thread,
    turn,
    appOptions,
    close() {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Actual HTTP, schema-derived client and CLI catalog execution over the same owner records. */
async function projections(
  f: ReturnType<typeof fixture>,
  scope: 'workspace' | 'workspace-readonly' | 'server-admin' = 'workspace',
  workspaceIds: string[] = ['ws_demo']
) {
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: 'user_local',
    scope,
    workspaceIds: scope === 'server-admin' ? [] : workspaceIds,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }).secret;
  const app = createApp({ ...f.appOptions, mode: 'server' });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    headers,
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const { operationCatalog } = await import(
    new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
  );
  return {
    http: async (id: string, input: Record<string, unknown>) => {
      const { requestId, ...body } = input;
      const response = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: {
          ...headers,
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw { ...(result as object), status: response.status };
      return result;
    },
    client: (id: string, input: Record<string, unknown>) =>
      (client.operations as unknown as Record<string, (input: unknown) => Promise<unknown>>)[id]!(
        input
      ),
    cli: (id: string, input: Record<string, unknown>) => {
      const entry = operationCatalog.find((entry: { id: string }) => entry.id === id);
      expect(entry, id).toBeDefined();
      return entry.handler({ client }, entry.inputSchema.parse(input));
    },
  };
}

/** Complete logical inputs with one stable command identity per operation. */
function inputs(f: ReturnType<typeof fixture>) {
  const common = { workspaceId: 'ws_demo', threadId: f.thread.id };
  return {
    'conversation.targets': common,
    'conversation.navigation': { workspaceId: 'ws_demo' },
    'conversation.submit': {
      ...common,
      targetRef: 'internal-role:assistant',
      input: 'What is OpenKit?',
      requestId: '00000000-0000-4000-8000-000000000001',
    },
    'task.start': {
      ...common,
      input: 'Review this request',
      requestId: '00000000-0000-4000-8000-000000000002',
    },
    'attention.list': { workspaceId: 'ws_demo' },
    'approval.respond': {
      ...common,
      turnId: f.turn.id,
      approvalRequestId: 'ap_projection',
      decision: 'denied',
      requestId: '00000000-0000-4000-8000-000000000003',
    },
    'question.answer': {
      ...common,
      userInputRequestId: 'ui_projection',
      answers: { path: ['src'] },
      requestId: '00000000-0000-4000-8000-000000000004',
    },
    'pending-request.withdraw': {
      ...common,
      pendingRequestId: 'ui_withdraw',
      requestId: '00000000-0000-4000-8000-000000000005',
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('Task conversation and Pending Request definition projections', () => {
  it('keeps Approval opaque and answers and withdrawals on body Workspace and addressed Thread admission', () => {
    expect(schemas.PRODUCT_OPERATION_DEFINITIONS['approval.respond'].scope.kind).toBe(
      'opaque-child-workspace'
    );
    for (const id of ['question.answer', 'pending-request.withdraw'] as const) {
      expect(schemas.PRODUCT_OPERATION_DEFINITIONS[id].scope).toEqual({
        kind: 'body-workspace',
        field: 'workspaceId',
      });
      expect(schemas.PRODUCT_OPERATION_DEFINITIONS[id].target).toMatchObject({
        kind: 'addressed-thread',
        threadField: 'threadId',
      });
    }
  });
  it('declares all eight operations and removes handwritten projection entries', () => {
    const expected = [
      'conversation.targets',
      'conversation.navigation',
      'conversation.submit',
      'task.start',
      'attention.list',
      'approval.respond',
      'question.answer',
      'pending-request.withdraw',
    ];
    for (const id of expected)
      expect(Object.hasOwn(schemas.PRODUCT_OPERATION_DEFINITIONS, id), id).toBe(true);
    for (const path of [
      'skills/openkit-operations.mjs',
      'apps/nanocore/src/openapi.ts',
      'apps/nanocore/src/auth/operation-access.ts',
    ]) {
      const source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').replace(
        /policyOperation: ['"]approval\.respond['"]/g,
        ''
      );
      for (const id of expected)
        expect(source, `${path}: ${id}`).not.toMatch(
          new RegExp(`['"\x60]${id.replaceAll('.', '\\.')}['"\x60]`)
        );
    }
  });

  it.each([
    'workspace',
    'server-admin',
  ] as const)('preserves authorized request decisions and read results across HTTP client and CLI for %s', async (scope) => {
    const f = fixture(
      scope === 'server-admin' ? { privateThread: true, responsibleUserId: 'user_foreign' } : {}
    );
    try {
      const projectors = await projections(f, scope);
      const all = inputs(f);
      // The raising Turn remains running so decisions do not add a delivery Turn between reads.
      for (const [id, input] of Object.entries(all).filter(
        ([id]) => id !== 'conversation.submit' && id !== 'task.start'
      )) {
        const values = [];
        for (const project of Object.values(projectors)) values.push(await project(id, input));
        expect(values[1], id).toEqual(values[0]);
        expect(values[2], id).toEqual(values[0]);
      }
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        for (const id of ['ap_projection', 'ui_projection', 'ui_withdraw']) {
          const record = readPendingRequest(db.sqlite, id)!;
          expect(record.decidingActor?.id ?? record.endingActor?.id).toBe('user_local');
        }
      } finally {
        db.sqlite.close();
      }
    } finally {
      f.close();
    }
  });

  it('preserves unauthorized Workspace and foreign private Thread refusals across projections', async () => {
    const f = fixture({ privateThread: true });
    try {
      const projectors = await projections(f);
      for (const [id, input] of Object.entries(inputs(f))) {
        for (const project of Object.values(projectors)) {
          await expect(project(id, { ...input, workspaceId: 'ws_missing' })).rejects.toMatchObject({
            code: 'workspace_access_denied',
            status: 403,
          });
          if ('threadId' in input)
            await expect(project(id, input), id).rejects.toMatchObject({
              code: 'not_found',
              status: 404,
            });
        }
      }
      for (const id of ['conversation.navigation', 'attention.list']) {
        for (const project of Object.values(projectors)) {
          const result = (await project(id, { workspaceId: 'ws_demo' })) as { items: unknown[] };
          expect(JSON.stringify(result.items)).not.toContain(f.thread.id);
        }
      }
    } finally {
      f.close();
    }
  });

  it('preserves opaque Approval denial and body-scoped decision recovery in another authorized Workspace', async () => {
    const f = fixture();
    try {
      const other = f.store.createWorkspace('Other authorized Workspace');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'user_local',
        workspaceId: other.id,
      });
      const otherThread = f.store.createThread(other.id, 'Other visible Thread');
      const db = openWorkspaceDb(f.dataRoot, other.id);
      applyScopedMigrations(db);
      db.sqlite.close();
      const projectors = await projections(f, 'workspace', ['ws_demo', other.id]);
      for (const id of [
        'approval.respond',
        'question.answer',
        'pending-request.withdraw',
      ] as const) {
        for (const project of Object.values(projectors))
          await expect(
            project(id, { ...inputs(f)[id], workspaceId: other.id, threadId: otherThread.id })
          ).rejects.toMatchObject(
            id === 'approval.respond'
              ? { code: 'workspace_access_denied', status: 403 }
              : { code: 'recovery_required', status: 409 }
          );
      }
      const ownerDb = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        for (const id of ['ap_projection', 'ui_projection', 'ui_withdraw'])
          expect(readPendingRequest(ownerDb.sqlite, id)?.state).toBe('pending');
      } finally {
        ownerDb.sqlite.close();
      }
    } finally {
      f.close();
    }
  });

  it('preserves missing canonical-owner recovery through Approval-map and body Workspace admission', async () => {
    const f = fixture();
    try {
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      db.sqlite
        .prepare('DELETE FROM pending_requests WHERE request_id IN (?, ?, ?)')
        .run('ap_projection', 'ui_projection', 'ui_withdraw');
      db.sqlite.close();
      const projectors = await projections(f);
      for (const id of ['approval.respond', 'question.answer', 'pending-request.withdraw'] as const)
        for (const project of Object.values(projectors))
          await expect(project(id, inputs(f)[id])).rejects.toMatchObject({
            code: 'recovery_required',
            status: 409,
          });
    } finally {
      f.close();
    }
  });

  it('preserves missing Approval denial and body-scoped decision recovery without recording a command', async () => {
    const f = fixture();
    try {
      const beforeCommands = f.store.listCommandRequests();
      const projectors = await projections(f);
      const all = inputs(f);
      for (const [id, field] of [
        ['approval.respond', 'approvalRequestId'],
        ['question.answer', 'userInputRequestId'],
        ['pending-request.withdraw', 'pendingRequestId'],
      ] as const) {
        for (const project of Object.values(projectors))
          await expect(project(id, { ...all[id], [field]: 'missing-child' })).rejects.toMatchObject(
            id === 'approval.respond'
              ? { code: 'workspace_access_denied', status: 403 }
              : { code: 'recovery_required', status: 409 }
          );
      }
      expect(f.store.listCommandRequests()).toEqual(beforeCommands);
    } finally {
      f.close();
    }
  });

  it.each([
    'readonly',
    'closed admission',
  ] as const)('refuses every migrated mutation under %s before a protected write', async (condition) => {
    const f = fixture({ accepting: condition !== 'closed admission' });
    try {
      const projectors = await projections(
        f,
        condition === 'readonly' ? 'workspace-readonly' : 'workspace'
      );
      const before = f.store.listAllItems();
      const beforeCommands = f.store.listCommandRequests();
      for (const [id, input] of Object.entries(inputs(f)).filter(
        ([id]) =>
          !['conversation.targets', 'conversation.navigation', 'attention.list'].includes(id)
      )) {
        for (const project of Object.values(projectors))
          await expect(project(id, input)).rejects.toMatchObject(
            condition === 'readonly'
              ? { code: 'workspace_access_denied', status: 403 }
              : { code: 'product_work_unavailable', status: 503 }
          );
      }
      expect(f.store.listAllItems()).toEqual(before);
      expect(f.store.listCommandRequests()).toEqual(beforeCommands);
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        for (const id of ['ap_projection', 'ui_projection', 'ui_withdraw'])
          expect(readPendingRequest(db.sqlite, id)?.state).toBe('pending');
      } finally {
        db.sqlite.close();
      }
    } finally {
      f.close();
    }
  });

  it('refuses decisions by another ordinary member through the responsible-user owner', async () => {
    const f = fixture({ responsibleUserId: 'user_foreign' });
    try {
      const projectors = await projections(f);
      for (const [id, input] of Object.entries(inputs(f)).filter(([id]) =>
        ['approval.respond', 'question.answer', 'pending-request.withdraw'].includes(id)
      ))
        for (const project of Object.values(projectors))
          await expect(project(id, input), id).rejects.toMatchObject({
            code: 'workspace_access_denied',
            status: 403,
          });
    } finally {
      f.close();
    }
  });

  it('refuses a secret question before writing a resolution or command receipt', async () => {
    const f = fixture();
    try {
      const beforeCommands = f.store.listCommandRequests();
      const projectors = await projections(f);
      for (const project of Object.values(projectors))
        await expect(
          project('question.answer', {
            ...inputs(f)['question.answer'],
            userInputRequestId: 'ui_secret',
          })
        ).rejects.toMatchObject({ code: 'secret_input_not_supported', status: 400 });
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        expect(readPendingRequest(db.sqlite, 'ui_secret')?.state).toBe('pending');
      } finally {
        db.sqlite.close();
      }
      expect(f.store.listCommandRequests()).toEqual(beforeCommands);
    } finally {
      f.close();
    }
  });

  it.each([
    ['GET', '/api/app/workspaces/ws_demo/conversation-targets', 'conversation.targets'],
    ['GET', '/api/app/workspaces/ws_demo/conversations', 'conversation.navigation'],
    [
      'POST',
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      'conversation.submit',
    ],
    ['POST', '/api/app/workspaces/ws_demo/threads/th_demo/task', 'task.start'],
    ['GET', '/api/app/workspaces/ws_demo/action-center', 'attention.list'],
    ['POST', '/api/approvals/ap_projection/respond', 'approval.respond'],
    ['POST', '/api/user-input-requests/ui_projection/answer', 'question.answer'],
    ['POST', '/api/pending-requests/ui_withdraw/withdraw', 'pending-request.withdraw'],
  ] as const)('removes %s %s with HTTP 404 for an authenticated valid request', async (method, path, id) => {
    const f = fixture();
    try {
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      const app = createApp({ ...f.appOptions, mode: 'server' });
      const input = { ...inputs(f)[id] } as Record<string, unknown>;
      // These former strict body schemas received selectors from the path, not JSON.
      if (id === 'conversation.submit' || id === 'task.start') {
        delete input.workspaceId;
        delete input.threadId;
      }
      expect(
        (
          await app.request(path, {
            method,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
          })
        ).status
      ).toBe(404);
    } finally {
      f.close();
    }
  });
});
