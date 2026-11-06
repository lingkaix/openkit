import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuditEvent, compareCodeUnits, type WorkspaceRecordSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  listServerAuditEvents,
  listWorkspaceAuditEvents,
  recordServerAuditEvent,
  recordWorkspaceAuditEvent,
} from './audit-events.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { recordUsage, startCapabilityCall } from './capability/usage-ledger.js';
import { AutomationStore } from './lib/automation-store.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { managedThreadPolicy } from './test-support/resource-policy.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
} from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const OWNER_ID = 'usr_00000000-0000-7000-8000-000000000001';
const TOKEN_EXPIRY = '2999-01-01T00:00:00.000Z';

type AuditPage = {
  workspaceId: string;
  auditEvents: AuditEvent[];
  nextCursor: string | null;
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/**
 * Creates real local identity, Workspace membership, Thread and Audit owners for one public read.
 *
 * @param workspaceNames Addressed Workspaces to create for the fixture.
 * @returns App, Core, Store, Workspace handles and current read Tokens.
 */
async function createFixture(workspaceNames: readonly string[] = ['Audit pagination']) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-audit-workspace-pagination-'));
  const store = createTestStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  const workspaces: import('zod').infer<typeof WorkspaceRecordSchema>[] = [];
  const workspaceDbs = new Map<string, ReturnType<typeof createTestWorkspaceDb>>();
  const seedEvents = new Map<string, AuditEvent[]>();
  for (const name of workspaceNames) {
    const workspace = await store.createWorkspace(name);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: OWNER_ID,
      workspaceId: workspace.id,
    });
    workspaces.push(workspace);
    const workspaceDb = createTestWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(workspaceDb);
    workspaceDbs.set(workspace.id, workspaceDb);
    seedEvents.set(workspace.id, listWorkspaceAuditEvents(workspaceDb, workspace.id));
  }
  const app = createApp({
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
    coreDb,
    dataRoot,
    mode: 'server',
    store,
  });
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const ownerHeaders = bearer(coreDb, OWNER_ID, workspaceIds);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    for (const workspaceDb of workspaceDbs.values()) closeTestCoreDb(workspaceDb);
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    app,
    coreDb,
    dataRoot,
    ownerHeaders,
    seedEvents,
    store,
    workspace: workspaces[0]!,
    workspaceDbs,
    workspaces,
  };
}

/**
 * Issues one current read Token without adding a credential file or account.
 *
 * @param coreDb Core database that owns Token records.
 * @param userId Active Workspace member.
 * @param workspaceIds Addressed Workspaces admitted to the token.
 * @returns Bearer header map.
 */
function bearer(
  coreDb: ReturnType<typeof createTestCoreDb>,
  userId: string,
  workspaceIds: readonly string[]
): { authorization: string } {
  const token = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: userId,
    scope: 'workspace-readonly',
    workspaceIds: [...workspaceIds],
  });
  return { authorization: `Bearer ${token.secret}` };
}

/**
 * Records one real Workspace Audit row through the existing owner.
 *
 * @param fixture Active fixture.
 * @param input Exact fixture identity, timestamp and lineage.
 * @returns Recorded protocol Audit event.
 */
function recordAudit(
  fixture: Fixture,
  input: {
    readonly key: string;
    readonly workspaceId?: string;
    readonly createdAt: string;
    readonly threadId?: string | null;
    readonly summary?: string;
    readonly action?: string;
  }
): AuditEvent {
  const workspaceId = input.workspaceId ?? fixture.workspace.id;
  const workspaceDb = fixture.workspaceDbs.get(workspaceId);
  if (!workspaceDb) throw new Error('Fixture Workspace database is unavailable.');
  return recordWorkspaceAuditEvent({
    workspaceDb,
    workspaceId,
    auditEventId: testEntityId('aud', input.key),
    action: input.action ?? 'workspace.inspect',
    outcome: 'succeeded',
    summary: input.summary ?? `Audit fixture ${input.key}.`,
    threadId: input.threadId ?? null,
    now: new Date(input.createdAt),
  });
}

/**
 * Calls the public operation without a future candidate or a fabricated route.
 *
 * @param fixture Active fixture.
 * @param body Exact request input.
 * @param headers Current authenticated caller.
 * @returns HTTP response and parsed JSON body.
 */
async function listAudit(
  fixture: Fixture,
  body: Record<string, unknown>,
  headers: Record<string, string> = fixture.ownerHeaders
): Promise<{ response: Response; body: unknown }> {
  const response = await fixture.app.request(
    ...operationRequest('audit.workspace-list', body, { headers })
  );
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

/**
 * Computes the normative descending `(createdAt, id)` order without asking the future candidate.
 *
 * @param events Retained events with known timestamps and ids.
 * @returns Expected descending total order.
 */
function expectedDescending(events: readonly AuditEvent[]): AuditEvent[] {
  return [...events].sort(
    (left, right) =>
      compareCodeUnits(right.createdAt ?? '', left.createdAt ?? '') ||
      compareCodeUnits(right.id, left.id)
  );
}

/** Projects stable ids for exact order assertions. */
function eventIds(events: readonly AuditEvent[]): string[] {
  return events.map((event) => event.id);
}

/** Parses a successful page without casting future fields into existence. */
function page(body: unknown): AuditPage {
  return body as AuditPage;
}

/** Requires one stable invalid-request refusal with no selected event summary leakage. */
async function expectInvalidRequest(
  result: { response: Response; body: unknown },
  privateValues: readonly string[] = []
): Promise<void> {
  expect(result.response.status).toBe(400);
  expect(result.body).toMatchObject({ code: 'invalid_request' });
  const serialized = JSON.stringify(result.body);
  for (const value of privateValues) expect(serialized).not.toContain(value);
}

describe('audit.workspace-list pagination', () => {
  it('returns the full legal Workspace and Core recurring history in descending order', async () => {
    const fixture = await createFixture();
    const shared = await fixture.store.createThread(
      fixture.workspace.id,
      'Shared audit thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const privateThread = await fixture.store.createThread(
      fixture.workspace.id,
      'Owner private audit thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: OWNER_ID }
    );
    const four = recordAudit(fixture, {
      key: 'c1-four',
      createdAt: '2099-01-01T00:00:04.000Z',
      threadId: shared.id,
      summary: 'Shared audit four.',
    });
    const three = recordAudit(fixture, {
      key: 'c1-three',
      createdAt: '2099-01-01T00:00:03.000Z',
      threadId: shared.id,
      summary: 'Shared audit three.',
    });
    const two = recordAudit(fixture, {
      key: 'c1-two',
      createdAt: '2099-01-01T00:00:02.000Z',
      threadId: shared.id,
      summary: 'Shared audit two.',
    });
    const privateEvent = recordAudit(fixture, {
      key: 'c1-private',
      createdAt: '2099-01-01T00:00:00.500Z',
      threadId: privateThread.id,
      summary: 'Owner private audit.',
    });
    const schedules = new AutomationStore(
      fixture.coreDb,
      new WorkspaceMutationAdmission(),
      () => '2099-01-01T00:00:02.500Z'
    );
    const schedule = await schedules.createAutomation(OWNER_ID, {
      workspaceId: fixture.workspace.id,
      threadId: shared.id,
      name: 'Recurring audit fixture',
      prompt: 'Inspect audit history.',
      intervalSeconds: 60,
    });
    const recurring = listServerAuditEvents(fixture.coreDb).find(
      (event) => event.action === 'recurring.schedule.create' && event.resource === schedule.id
    );
    expect(recurring).toBeDefined();
    const seed = fixture.seedEvents.get(fixture.workspace.id)!;
    const ownerExpected = expectedDescending([...seed, four, three, two, privateEvent, recurring!]);

    const ownerResult = await listAudit(fixture, { workspaceId: fixture.workspace.id });
    expect(ownerResult.response.status).toBe(200);
    expect(page(ownerResult.body).workspaceId).toBe(fixture.workspace.id);
    expect(eventIds(page(ownerResult.body).auditEvents)).toEqual(eventIds(ownerExpected));
    expect(page(ownerResult.body).nextCursor).toBeNull();
  });

  it('walks tied timestamps with finite limits, omitted-limit remainder and a terminal null', async () => {
    const fixture = await createFixture();
    const shared = await fixture.store.createThread(
      fixture.workspace.id,
      'Paged audit thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const events = [
      recordAudit(fixture, {
        key: 'c2-five',
        createdAt: '2099-01-01T00:00:05.000Z',
        threadId: shared.id,
      }),
      recordAudit(fixture, {
        key: 'c2-four',
        createdAt: '2099-01-01T00:00:04.000Z',
        threadId: shared.id,
      }),
      recordAudit(fixture, {
        key: 'c2-four-tie',
        createdAt: '2099-01-01T00:00:04.000Z',
        threadId: shared.id,
      }),
      recordAudit(fixture, {
        key: 'c2-three',
        createdAt: '2099-01-01T00:00:03.000Z',
        threadId: shared.id,
      }),
      recordAudit(fixture, {
        key: 'c2-two',
        createdAt: '2099-01-01T00:00:02.000Z',
        threadId: shared.id,
      }),
    ];
    const expected = expectedDescending([
      ...fixture.seedEvents.get(fixture.workspace.id)!,
      ...events,
    ]);
    const collected: AuditEvent[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 10; index += 1) {
      const result = await listAudit(fixture, {
        workspaceId: fixture.workspace.id,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.response.status).toBe(200);
      const current = page(result.body);
      expect(current.auditEvents.length).toBeGreaterThan(0);
      expect(current.auditEvents.length).toBeLessThanOrEqual(2);
      collected.push(...current.auditEvents);
      if (current.nextCursor === null) break;
      expect(typeof current.nextCursor).toBe('string');
      cursor = current.nextCursor;
    }
    expect(eventIds(collected)).toEqual(eventIds(expected));
    expect(collected).toHaveLength(expected.length);
    expect(new Set(eventIds(collected)).size).toBe(expected.length);

    const first = await listAudit(fixture, { workspaceId: fixture.workspace.id, limit: 2 });
    expect(first.response.status).toBe(200);
    expect(typeof page(first.body).nextCursor).toBe('string');
    const remainder = await listAudit(fixture, {
      workspaceId: fixture.workspace.id,
      cursor: page(first.body).nextCursor,
    });
    expect(remainder.response.status).toBe(200);
    expect(page(remainder.body).nextCursor).toBeNull();
    expect(eventIds(page(remainder.body).auditEvents)).toEqual(eventIds(expected.slice(2)));

    const larger = await listAudit(fixture, { workspaceId: fixture.workspace.id, limit: 100 });
    expect(larger.response.status).toBe(200);
    expect(page(larger.body).nextCursor).toBeNull();
    expect(eventIds(page(larger.body).auditEvents)).toEqual(eventIds(expected));
  });

  it('refuses malformed, invalid and cross-Workspace continuations without leakage', async () => {
    const fixture = await createFixture(['Audit pagination A', 'Audit pagination B']);
    const firstWorkspace = fixture.workspaces[0]!;
    const secondWorkspace = fixture.workspaces[1]!;
    const firstEvent = recordAudit(fixture, {
      key: 'c4-first',
      workspaceId: firstWorkspace.id,
      createdAt: '2099-01-01T00:00:02.000Z',
      summary: 'First Workspace audit summary.',
    });
    const firstOlder = recordAudit(fixture, {
      key: 'c4-first-older',
      workspaceId: firstWorkspace.id,
      createdAt: '2099-01-01T00:00:01.000Z',
      summary: 'First Workspace older audit summary.',
    });
    const secondEvent = recordAudit(fixture, {
      key: 'c4-second',
      workspaceId: secondWorkspace.id,
      createdAt: '2099-01-01T00:00:01.000Z',
      summary: 'Second Workspace audit summary.',
    });
    const firstPage = await listAudit(fixture, { workspaceId: firstWorkspace.id, limit: 1 });
    expect(firstPage.response.status).toBe(200);
    const cursor = page(firstPage.body).nextCursor;
    expect(typeof cursor).toBe('string');
    expect(eventIds(page(firstPage.body).auditEvents)).toEqual([firstEvent.id]);

    for (const limit of [0, -1, 1.5, '2']) {
      await expectInvalidRequest(
        await listAudit(fixture, { workspaceId: firstWorkspace.id, limit }),
        [firstEvent.summary, firstOlder.summary, secondEvent.summary]
      );
    }
    await expectInvalidRequest(
      await listAudit(fixture, {
        workspaceId: firstWorkspace.id,
        cursor: 'not-a-cursor',
      }),
      [firstEvent.summary, firstOlder.summary, secondEvent.summary]
    );
    await expectInvalidRequest(
      await listAudit(fixture, {
        workspaceId: secondWorkspace.id,
        limit: 1,
        cursor,
      }),
      [firstEvent.summary, firstOlder.summary, secondEvent.summary]
    );
  });

  it('re-evaluates current Thread visibility before page formation and skips hidden rows', async () => {
    const fixture = await createFixture();
    const managed = await fixture.store.createThread(
      fixture.workspace.id,
      'Managed audit thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const ordinary = await fixture.store.createThread(
      fixture.workspace.id,
      'Ordinary audit thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    let policy = managedThreadPolicy({
      workspaceId: fixture.workspace.id,
      threadId: managed.id,
      userId: OWNER_ID,
      operations: ['thread.read'],
    });
    fixture.store.setWorkspaceResourcePolicyProjection((workspaceId) =>
      workspaceId === fixture.workspace.id ? policy : null
    );
    const managedFour = recordAudit(fixture, {
      key: 'c5-managed-four',
      createdAt: '2099-01-01T00:00:04.000Z',
      threadId: managed.id,
    });
    const managedThree = recordAudit(fixture, {
      key: 'c5-managed-three',
      createdAt: '2099-01-01T00:00:03.000Z',
      threadId: managed.id,
    });
    const managedTwo = recordAudit(fixture, {
      key: 'c5-managed-two',
      createdAt: '2099-01-01T00:00:02.000Z',
      threadId: managed.id,
    });
    const ordinaryOne = recordAudit(fixture, {
      key: 'c5-ordinary-one',
      createdAt: '2099-01-01T00:00:01.000Z',
      threadId: ordinary.id,
    });
    const seed = fixture.seedEvents.get(fixture.workspace.id)!;
    const remainingExpected = expectedDescending([ordinaryOne, ...seed]);

    const firstPage = await listAudit(fixture, { workspaceId: fixture.workspace.id, limit: 2 });
    expect(firstPage.response.status).toBe(200);
    expect(eventIds(page(firstPage.body).auditEvents)).toEqual([managedFour.id, managedThree.id]);
    const cursor = page(firstPage.body).nextCursor;
    expect(typeof cursor).toBe('string');

    policy = {
      ...policy,
      statements: policy.statements.filter((statement) => statement.kind === 'managed-boundary'),
    };
    fixture.store.setWorkspaceResourcePolicyProjection((workspaceId) =>
      workspaceId === fixture.workspace.id ? policy : null
    );

    const remaining: AuditEvent[] = [];
    let nextCursor: string | null = cursor;
    while (nextCursor) {
      const result = await listAudit(fixture, {
        workspaceId: fixture.workspace.id,
        limit: 2,
        cursor: nextCursor,
      });
      expect(result.response.status).toBe(200);
      const current = page(result.body);
      remaining.push(...current.auditEvents);
      nextCursor = current.nextCursor;
    }
    expect(eventIds(remaining)).toEqual(eventIds(remainingExpected));
    expect(
      remaining.some((event) => [managedFour.id, managedThree.id, managedTwo.id].includes(event.id))
    ).toBe(false);

    const refresh = await listAudit(fixture, { workspaceId: fixture.workspace.id });
    expect(refresh.response.status).toBe(200);
    expect(page(refresh.body).nextCursor).toBeNull();
    expect(eventIds(page(refresh.body).auditEvents)).toEqual(eventIds(remainingExpected));
  });

  it('shows a newer insert on refresh but not retroactively on later pages', async () => {
    const fixture = await createFixture();
    const shared = await fixture.store.createThread(
      fixture.workspace.id,
      'Refresh audit thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const four = recordAudit(fixture, {
      key: 'c6-four',
      createdAt: '2099-01-01T00:00:04.000Z',
      threadId: shared.id,
    });
    const three = recordAudit(fixture, {
      key: 'c6-three',
      createdAt: '2099-01-01T00:00:03.000Z',
      threadId: shared.id,
    });
    const two = recordAudit(fixture, {
      key: 'c6-two',
      createdAt: '2099-01-01T00:00:02.000Z',
      threadId: shared.id,
    });
    const one = recordAudit(fixture, {
      key: 'c6-one',
      createdAt: '2099-01-01T00:00:01.000Z',
      threadId: shared.id,
    });
    const seed = fixture.seedEvents.get(fixture.workspace.id)!;
    const firstPage = await listAudit(fixture, { workspaceId: fixture.workspace.id, limit: 2 });
    expect(firstPage.response.status).toBe(200);
    expect(eventIds(page(firstPage.body).auditEvents)).toEqual([four.id, three.id]);
    const cursor = page(firstPage.body).nextCursor;
    expect(typeof cursor).toBe('string');

    const newer = recordAudit(fixture, {
      key: 'c6-newer',
      createdAt: '2099-01-01T00:00:05.000Z',
      threadId: shared.id,
    });
    const later: AuditEvent[] = [];
    let nextCursor: string | null = cursor;
    while (nextCursor) {
      const result = await listAudit(fixture, {
        workspaceId: fixture.workspace.id,
        limit: 2,
        cursor: nextCursor,
      });
      expect(result.response.status).toBe(200);
      const current = page(result.body);
      later.push(...current.auditEvents);
      nextCursor = current.nextCursor;
    }
    expect(eventIds(later)).toEqual(eventIds(expectedDescending([two, one, ...seed])));
    expect(later.some((event) => event.id === newer.id)).toBe(false);

    const refresh = await listAudit(fixture, { workspaceId: fixture.workspace.id });
    expect(refresh.response.status).toBe(200);
    expect(page(refresh.body).nextCursor).toBeNull();
    expect(eventIds(page(refresh.body).auditEvents)).toEqual(
      eventIds(expectedDescending([newer, four, three, two, one, ...seed]))
    );
  });

  it('paginates audit.server-list, permission.workspace-list, permission.server-list, and usage.read', async () => {
    const fixture = await createFixture();
    const adminToken = createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: TOKEN_EXPIRY,
      ownerUserId: OWNER_ID,
      scope: 'server-admin',
      workspaceIds: [],
    }).secret;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    recordServerAuditEvent({
      coreDb: fixture.coreDb,
      auditEventId: testEntityId('aud', 'srv-1'),
      action: 'server.config.update',
      outcome: 'succeeded',
      summary: 'Server audit one.',
      now: new Date('2099-01-01T00:00:01.000Z'),
    });
    recordServerAuditEvent({
      coreDb: fixture.coreDb,
      auditEventId: testEntityId('aud', 'srv-2'),
      action: 'server.config.update',
      outcome: 'succeeded',
      summary: 'Server audit two.',
      now: new Date('2099-01-01T00:00:02.000Z'),
    });

    const srvAudit1 = await (
      await fixture.app.request(
        ...operationRequest('audit.server-list', { limit: 1 }, { headers: adminHeaders })
      )
    ).json();
    expect(srvAudit1.auditEvents).toHaveLength(1);
    expect(typeof srvAudit1.nextCursor).toBe('string');
    const srvAudit2 = await (
      await fixture.app.request(
        ...operationRequest(
          'audit.server-list',
          { cursor: srvAudit1.nextCursor },
          { headers: adminHeaders }
        )
      )
    ).json();
    expect(srvAudit2.auditEvents.length).toBeGreaterThanOrEqual(1);
    expect(srvAudit2.nextCursor).toBeNull();

    const workspaceDb = fixture.workspaceDbs.get(fixture.workspace.id)!;
    await recordProductPermissionDecision({
      workspaceDb,
      workspaceId: fixture.workspace.id,
      ownerScope: 'workspace',
      decisionId: testEntityId('pd', 'ws-1'),
      action: 'runtime.launch',
      contextSummary: {},
      enforcementPoint: 'worker.launch',
      policyEngineVersion: 'nanocore-worker-policy:v1',
      policySnapshotId: 'worker_turn_launch_policy',
      reasonCode: 'allowed',
      resourceSummary: { kind: 'worker-turn' },
      result: 'allow',
      subjectSummary: { kind: 'user', id: OWNER_ID },
      now: new Date('2099-01-01T00:00:01.000Z'),
    });
    await recordProductPermissionDecision({
      workspaceDb,
      workspaceId: fixture.workspace.id,
      ownerScope: 'workspace',
      decisionId: testEntityId('pd', 'ws-2'),
      action: 'runtime.launch',
      contextSummary: {},
      enforcementPoint: 'worker.launch',
      policyEngineVersion: 'nanocore-worker-policy:v1',
      policySnapshotId: 'worker_turn_launch_policy',
      reasonCode: 'allowed',
      resourceSummary: { kind: 'worker-turn' },
      result: 'allow',
      subjectSummary: { kind: 'user', id: OWNER_ID },
      now: new Date('2099-01-01T00:00:02.000Z'),
    });

    const wsPerm1 = await (
      await fixture.app.request(
        ...operationRequest(
          'permission.workspace-list',
          { workspaceId: fixture.workspace.id, limit: 1 },
          { headers: fixture.ownerHeaders }
        )
      )
    ).json();
    expect(wsPerm1.permissionDecisions).toHaveLength(1);
    expect(typeof wsPerm1.nextCursor).toBe('string');
    const wsPerm2 = await (
      await fixture.app.request(
        ...operationRequest(
          'permission.workspace-list',
          { workspaceId: fixture.workspace.id, cursor: wsPerm1.nextCursor },
          { headers: fixture.ownerHeaders }
        )
      )
    ).json();
    expect(wsPerm2.permissionDecisions.length).toBeGreaterThanOrEqual(1);
    expect(wsPerm2.nextCursor).toBeNull();

    await recordProductPermissionDecision({
      coreDb: fixture.coreDb,
      ownerScope: 'server',
      decisionId: testEntityId('pd', 'srv-1'),
      action: 'llm.gateway.chat_completions',
      contextSummary: {},
      enforcementPoint: 'llm.gateway.policy',
      policyEngineVersion: 'nanocore-gateway-policy:v1',
      policySnapshotId: 'runtime_config_gateway_policy',
      reasonCode: 'allowed',
      resourceSummary: { kind: 'llm-provider' },
      result: 'allow',
      subjectSummary: { kind: 'user', id: OWNER_ID },
      now: new Date('2099-01-01T00:00:01.000Z'),
    });
    await recordProductPermissionDecision({
      coreDb: fixture.coreDb,
      ownerScope: 'server',
      decisionId: testEntityId('pd', 'srv-2'),
      action: 'llm.gateway.chat_completions',
      contextSummary: {},
      enforcementPoint: 'llm.gateway.policy',
      policyEngineVersion: 'nanocore-gateway-policy:v1',
      policySnapshotId: 'runtime_config_gateway_policy',
      reasonCode: 'allowed',
      resourceSummary: { kind: 'llm-provider' },
      result: 'allow',
      subjectSummary: { kind: 'user', id: OWNER_ID },
      now: new Date('2099-01-01T00:00:02.000Z'),
    });

    const srvPerm1 = await (
      await fixture.app.request(
        ...operationRequest('permission.server-list', { limit: 1 }, { headers: adminHeaders })
      )
    ).json();
    expect(srvPerm1.permissionDecisions).toHaveLength(1);
    expect(typeof srvPerm1.nextCursor).toBe('string');
    const srvPerm2 = await (
      await fixture.app.request(
        ...operationRequest(
          'permission.server-list',
          { cursor: srvPerm1.nextCursor },
          { headers: adminHeaders }
        )
      )
    ).json();
    expect(srvPerm2.permissionDecisions.length).toBeGreaterThanOrEqual(1);
    expect(srvPerm2.nextCursor).toBeNull();

    for (const key of ['call-1', 'call-2'] as const) {
      const started = await startCapabilityCall({
        workspaceDb,
        workspaceId: fixture.workspace.id,
        authorityActor: { kind: 'user', id: OWNER_ID },
        capabilityId: 'storage.workspace_export',
        family: 'storage',
        operation: 'workspace.export.write',
        providerRef: 'nanocore-storage',
        serviceRef: 'workspace-export',
        redactionClass: 'metadata-only',
        now: new Date(key === 'call-1' ? '2099-01-01T00:00:01.000Z' : '2099-01-01T00:00:02.000Z'),
      });
      await recordUsage({
        workspaceDb,
        call: started,
        now: new Date(key === 'call-1' ? '2099-01-01T00:00:01.500Z' : '2099-01-01T00:00:02.500Z'),
        records: [
          {
            category: 'storage',
            unit: 'files',
            quantity: 1,
            source: 'workspace-export-inventory',
            providerRef: 'nanocore-storage',
          },
        ],
      });
    }

    const usage1 = await (
      await fixture.app.request(
        ...operationRequest(
          'usage.read',
          { workspaceId: fixture.workspace.id, limit: 1 },
          { headers: fixture.ownerHeaders }
        )
      )
    ).json();
    expect(usage1.capabilityCalls).toHaveLength(1);
    expect(usage1.usageRecords).toHaveLength(1);
    expect(typeof usage1.nextCursor).toBe('string');

    const usage2 = await (
      await fixture.app.request(
        ...operationRequest(
          'usage.read',
          { workspaceId: fixture.workspace.id, cursor: usage1.nextCursor },
          { headers: fixture.ownerHeaders }
        )
      )
    ).json();
    expect(usage2.capabilityCalls.length).toBeGreaterThanOrEqual(1);
    expect(usage2.usageRecords.length).toBeGreaterThanOrEqual(1);
    expect(usage2.nextCursor).toBeNull();
  });
});
