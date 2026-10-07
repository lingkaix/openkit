import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { mcpToolArgumentsContentDigest } from './mcp-tool-schema-snapshots.js';
import { TurnStartValidationError } from './orchestrator.js';
import {
  APPROVAL_DETAIL_BYTES,
  approvalCardCopy,
  projectApprovalEffect,
} from './pending-request-disclosure.js';
import {
  installPendingRequestAdmission,
  raiseRecordedPendingRequest,
  recoverPendingRequestsAtBoot,
} from './pending-request-flow.js';
import {
  answerPendingRequest,
  canonicalJsonText,
  freezeReadyOutcomes,
  frozenPendingOutcomeInput,
  type PendingRequestRecord,
  pendingRequestItemId,
  proveFrozenDelivery,
  type RaisePendingRequestInput,
  raisePendingRequest,
  readPendingRequest,
  settleUnfinishedClaims,
  validateCanonicalLoad,
} from './pending-requests.js';
import { createDefaultWorkerMcpGateway, type WorkerMcpGateway } from './worker-mcp-gateway.js';

const NOW = '2026-09-30T00:00:00.000Z';

/**
 * Opens one local Core app whose workspace database can hold pending requests.
 *
 * @returns App, store, and data root.
 */
function openPendingApp(agentId?: string, workerMcpGateway?: WorkerMcpGateway) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-request-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  recordTestNativeRuntimeTarget(coreDb);
  admitTestNativeEnvironment(
    coreDb,
    createTestAgentSetup({ ...(agentId ? { agentId } : {}) }).manifest
  );
  const app = createApp({
    ...(agentId
      ? {
          agentManifests: [createTestAgentSetup({ agentId }).manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              displayName: 'Fixture',
              id: 'agent-openrouter',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        }
      : {}),
    coreDb,
    dataRoot,
    ...(workerMcpGateway ? { workerMcpGateway } : {}),
    store,
    turnExecutor: new SimulatedTurnExecutor({ coreDb }),
  });
  return { app, coreDb, dataRoot, store };
}

/**
 * Builds one captured worker approval raise.
 *
 * @param turnId Raising Turn.
 * @param requestId Request id.
 * @param digest Argument digest.
 * @returns Raise input.
 */
function approvalRaise(
  turnId: string,
  requestId: string,
  digest: string
): RaisePendingRequestInput {
  return {
    requestId,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    raisingTurnId: turnId,
    requestItemId: `it_${requestId}`,
    kind: 'approval',
    requesterKind: 'worker',
    agentId: 'agent_demo',
    responsibleUserId: 'user_local',
    call: {
      serverId: 'echo',
      catalogRevision: 'sha256:catalog',
      schemaSnapshotId: 'snap_1',
      toolName: 'echo',
      canonicalArgumentsJson: JSON.stringify({ message: digest }),
      argumentsDigest: mcpToolArgumentsContentDigest({ message: digest }),
      packageDigest: null,
      policyDecisionId: null,
      authorizationContext: {
        threadId: 'th_demo',
        turnId,
        agentSessionId: null,
        agentId: 'agent_demo',
        responsibleUserId: 'user_local',
        packageDigest: null,
        policyDecisionId: null,
      },
    },
    approval: { kind: 'permission', title: 'Approve echo', description: 'Allow one echo call.' },
    now: NOW,
  };
}

describe('pending requests', () => {
  it.each([
    'denied',
    'withdrawn',
  ] as const)('refuses oversized exact effect before grant and still permits %s', async (ending) => {
    const { app, coreDb, store, dataRoot } = openPendingApp('agent_demo');
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Unclassified effect',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_missing_disclosure', 'large'.repeat(120000));
      store.createItem({
        id: input.requestItemId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, input);
      const response = await app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: input.requestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              turnId: turn.id,
              decision: 'granted',
              requestId: '00000000-0000-4000-8000-000000000941',
              previewAvailable: true,
            }),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'approval_preview_unavailable' });
      expect(readPendingRequest(db.sqlite, input.requestId)).toMatchObject({
        state: 'pending',
        claim: 'unclaimed',
        executionCallId: null,
      });
      expect(db.sqlite.prepare('SELECT count(*) AS count FROM capability_calls').get()).toEqual({
        count: 0,
      });
      const end = await app.request(
        ...operationRequest(
          ending === 'denied' ? 'approval.respond' : 'pending-request.withdraw',
          ending === 'denied'
            ? { approvalRequestId: input.requestId }
            : { pendingRequestId: input.requestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              ...(ending === 'denied'
                ? { turnId: turn.id, decision: 'denied' }
                : { pendingRequestId: input.requestId }),
              requestId: '00000000-0000-4000-8000-000000000942',
            }),
          }
        )
      );
      expect(end.status, await end.clone().text()).toBe(200);
      expect(readPendingRequest(db.sqlite, input.requestId)).toMatchObject(
        ending === 'denied' ? { resolution: 'denied' } : { ending: 'withdrawn' }
      );
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('freezes only sixteen complete outcomes and retains large multibyte values across restart', () => {
    const { coreDb, dataRoot, store } = openPendingApp();
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    const question = '多字节🙂"\\'.repeat(20000);
    const answer = 'large answer "\\🙂'.repeat(600000);
    const trigger = 'original trigger 多🙂"\\';
    try {
      const turn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Collect outcomes',
        { kind: 'user', id: 'user_local' },
        null,
        { agentId: 'agent_demo' }
      );
      for (let index = 0; index < 17; index++) {
        const requestId = `uq_count_${String(index).padStart(2, '0')}`;
        raisePendingRequest(db.sqlite, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          raisingTurnId: turn.id,
          requestId,
          requestItemId: `it_${requestId}`,
          kind: 'user-input',
          requesterKind: 'worker',
          agentId: 'agent_demo',
          responsibleUserId: 'user_local',
          questions: [
            {
              id: 'q',
              header: 'Question',
              question: index === 0 ? question : 'Small',
              options: [],
            },
          ],
          now: NOW,
        });
        expect(
          answerPendingRequest(
            db.sqlite,
            requestId,
            { kind: 'user', id: 'user_local' },
            { q: [index === 0 ? answer : 'Small'] },
            NOW
          )
        ).not.toBeNull();
      }
      expect(
        freezeReadyOutcomes(db.sqlite, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'delivery_count',
          executor: 'worker',
          agentId: 'agent_demo',
          cause: 'carried',
          now: NOW,
        })
      ).toHaveLength(16);
      const bytes = frozenPendingOutcomeInput(db.sqlite, 'delivery_count', trigger);
      const value = JSON.parse(bytes);
      expect(value.triggerInput).toBe(trigger);
      expect(value.pendingOutcomes).toHaveLength(16);
      expect(value.pendingOutcomes[0].request.questions[0].question).toBe(question);
      expect(value.pendingOutcomes[0].answers.q).toEqual([answer]);
      expect(readPendingRequest(db.sqlite, 'uq_count_16')?.delivery).toBe('undelivered');
      db.sqlite.close();
      const reopened = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(frozenPendingOutcomeInput(reopened.sqlite, 'delivery_count', trigger)).toBe(bytes);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      if (db.sqlite.open) db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects only complete canonical detail within the inclusive UTF-8 boundary', () => {
    const { store, coreDb, dataRoot } = openPendingApp();
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const turn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Preview boundary',
        { kind: 'user', id: 'user_local' },
        null
      );
      const input = approvalRaise(turn.id, 'ap_detail_boundary', '');
      const record = raisePendingRequest(db.sqlite, input).record;
      const preview = (message: string, userId = 'user_local') =>
        projectApprovalEffect({
          record: { ...record, canonicalArgumentsJson: JSON.stringify({ message }) },
          store,
          coreDb,
          actor: { kind: userId === 'user_local' ? 'local' : 'session', userId },
        });
      const empty = preview('');
      expect(empty.status).toBe('available');
      if (empty.status !== 'available') throw new Error('Missing empty preview');
      const room = APPROVAL_DETAIL_BYTES - Buffer.byteLength(empty.detail);
      const boundary = preview('a'.repeat(room));
      expect(boundary.status).toBe('available');
      if (boundary.status !== 'available') throw new Error('Missing inclusive boundary');
      expect(Buffer.byteLength(boundary.detail)).toBe(APPROVAL_DETAIL_BYTES);
      expect(preview('a'.repeat(room + 1))).toMatchObject({ status: 'unavailable' });
      expect(preview('多'.repeat(Math.floor(room / 3)) + 'a'.repeat(room % 3))).toMatchObject({
        status: 'available',
      });
      expect(preview('"'.repeat(Math.floor(room / 2) + 1))).toMatchObject({
        status: 'unavailable',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES ('another-user', 'Shared viewer', 'viewer@example.invalid', 0, ?, ?, 'human', 'active')`
        )
        .run(Date.now(), Date.now());
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES ('ws_demo', 'another-user', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(NOW, NOW, NOW);
      expect(preview('not for this viewer', 'another-user')).toMatchObject({
        status: 'unavailable',
      });
      const privateThread = store.createThread(
        'ws_demo',
        'Private source',
        undefined,
        'conversation',
        { visibility: 'private', privateOwnerUserId: 'another-user' }
      );
      expect(
        projectApprovalEffect({
          record: { ...record, threadId: privateThread.id },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'user_local' },
        })
      ).toMatchObject({ status: 'unavailable' });
      coreDb.sqlite
        .prepare(
          "UPDATE workspace_members SET status = 'removed', removed_at = '2026-10-01T00:00:00.000Z', updated_at = '2026-10-01T00:00:00.000Z', revision = 2 WHERE user_id = 'another-user'"
        )
        .run();
      expect(
        projectApprovalEffect({
          record: { ...record, responsibleUserId: 'another-user' },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'another-user' },
        })
      ).toMatchObject({ status: 'unavailable' });
      expect(
        projectApprovalEffect({
          record: { ...record, serverId: null, governedIntent: null },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'user_local' },
        })
      ).toMatchObject({ status: 'unavailable' });

      expect(
        projectApprovalEffect({
          record: { ...record, canonicalArgumentsJson: '{' },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'user_local' },
        })
      ).toEqual({ status: 'unavailable', reason: 'Complete captured effect could not be loaded.' });
      const summary = approvalCardCopy('🙂'.repeat(2000), '多'.repeat(2000));
      expect(Buffer.byteLength(`${summary.title}\n${summary.description}`)).toBeLessThanOrEqual(
        2048
      );
      expect(summary.title).toMatch(/^Summary:/);
      expect(record.canonicalArgumentsJson).toBe(input.call!.canonicalArgumentsJson);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not settle or publish a contradictory request at boot', () => {
    const { coreDb, store, dataRoot } = openPendingApp();
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Broken request',
      { kind: 'user', id: 'user_local' },
      null
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    const record = raisePendingRequest(
      db.sqlite,
      approvalRaise(turn.id, 'ap_broken_boot', 'broken')
    ).record;
    db.sqlite
      .prepare(
        "UPDATE pending_requests SET state = 'resolved', resolution = 'granted', deciding_actor_kind = 'user', deciding_actor_id = 'user_local', decided_at = ?, claim = 'claimed', execution_call_id = ? WHERE request_id = ?"
      )
      .run(NOW, 'cap_pending_ap_broken_boot', record.requestId);
    const before = db.sqlite
      .prepare('SELECT * FROM pending_requests WHERE request_id = ?')
      .get(record.requestId);
    recoverPendingRequestsAtBoot(store, {
      openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
    });
    expect(
      db.sqlite.prepare('SELECT * FROM pending_requests WHERE request_id = ?').get(record.requestId)
    ).toEqual(before);
    expect(
      store.listAllItems().filter((item) => item.causationId === record.requestItemId)
    ).toHaveLength(0);
    db.sqlite.close();
    coreDb.sqlite.close();
  });

  it.each([
    'missing-item',
    'foreign-actor',
    'request-content',
    'pending-claim',
    'denied-claim',
    'finished-refusal',
    'unnamed-decision',
    'foreign-decision-content',
  ] as const)('isolates canonical pending request contradiction: %s', (fault) => {
    const { coreDb, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Canonical request', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      store.createItem({
        id: 'it_canonical',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: 'ap_canonical',
        title: 'Canonical request',
        description: 'One exact command.',
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      const valid = raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ap_canonical',
        requestItemId: 'it_canonical',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'user_local',
        approval: {
          kind: 'permission',
          title: 'Canonical request',
          description: 'One exact command.',
        },
        governedIntent: { operation: 'canonical-test' },
        now: NOW,
      });
      const turns = store.listThreadTurns('ws_demo', 'th_demo');
      expect(validateCanonicalLoad(valid, turns)).toBeNull();
      let broken = valid;
      if (fault === 'missing-item') broken = { ...valid, requestItemId: 'it_nonexistent' };
      if (fault === 'request-content') broken = { ...valid, title: 'Different captured request' };
      if (fault === 'pending-claim')
        broken = { ...valid, claim: 'claimed', executionCallId: 'cap_unowned' };
      if (fault === 'foreign-actor')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'user_intruder' },
          decidedAt: NOW,
        };
      if (fault === 'denied-claim')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'user_local' },
          decidedAt: NOW,
          claim: 'claimed',
          executionCallId: 'cap_unowned',
        };
      if (fault === 'finished-refusal')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'granted',
          decidingActor: { kind: 'user', id: 'user_local' },
          decidedAt: NOW,
          claim: 'finished',
          disposition: 'denied-not-executed',
        };
      if (fault === 'unnamed-decision' || fault === 'foreign-decision-content') {
        const item = {
          id: 'it_decision_ap_canonical',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          type: 'approval-decision' as const,
          status: 'completed' as const,
          actor: { kind: 'user' as const, id: 'user_intruder' },
          causationId: 'it_canonical',
          approvalRequestId: 'ap_canonical',
          decision: 'granted' as const,
          decidedAt: NOW,
          createdAt: NOW,
          completedAt: NOW,
        };
        turns[0] = { ...turns[0]!, items: [...turns[0]!.items, item] };
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'user_local' },
          decidedAt: NOW,
          publicationTurnId: fault === 'unnamed-decision' ? null : turn.id,
        };
      }
      expect(validateCanonicalLoad(broken, turns)).toMatchObject({ requestId: valid.requestId });
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'two-resolutions',
    'two-turns',
    'foreign-thread',
    'wrong-executor',
    'item-ahead',
  ] as const)('isolates the owner canonical publication fixture: %s', (fault) => {
    const { coreDb, store } = openPendingApp();
    const raising = store.createTurn(
      'ws_demo',
      'th_demo',
      'Canonical captured request',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(raising.id, 'ap_publication_matrix', 'matrix');
      store.createItem({
        id: input.requestItemId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: raising.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      const pending = raiseRecordedPendingRequest(store, db.sqlite, input);
      const decision = {
        id: pendingRequestItemId(input.requestId, 'decision'),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: 'tu_publication',
        type: 'approval-decision' as const,
        status: 'completed' as const,
        actor: { kind: 'user' as const, id: 'user_local' },
        causationId: input.requestItemId,
        approvalRequestId: input.requestId,
        decision: 'denied' as const,
        decidedAt: NOW,
        createdAt: NOW,
        completedAt: NOW,
      };
      const publication = {
        ...raising,
        id: 'tu_publication',
        startedAt: NOW,
        status: 'failed' as const,
        completedAt: NOW,
        items: [decision],
      };
      const later = {
        ...raising,
        id: 'tu_delivery',
        startedAt: NOW,
        status: 'running' as const,
        items: [] as (typeof decision)[],
      };
      const valid = {
        ...pending,
        state: 'resolved' as const,
        resolution: 'denied' as const,
        decidingActor: decision.actor,
        decidedAt: NOW,
        publicationTurnId: publication.id,
        deliveryTurnId: later.id,
        delivery: 'frozen' as const,
        deliveryCause: 'carried' as const,
      };
      const turns = [...store.listThreadTurns('ws_demo', 'th_demo'), publication, later];
      expect(validateCanonicalLoad(valid, turns)).toBeNull();
      expect(
        validateCanonicalLoad(valid, turns, [
          {
            key: 'expired-key',
            command: 'approval.respond',
            requestId: 'expired-receipt',
            scope: {
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              approvalRequestId: input.requestId,
            },
            inputHash: 'expired-conflict',
            response: { id: input.requestId, status: 'granted' },
            createdAt: NOW,
            expiresAt: '2000-01-01T00:00:00.000Z',
          },
        ])
      ).toBeNull();
      let broken: PendingRequestRecord = valid;
      if (fault === 'two-resolutions')
        publication.items.push({ ...decision, id: 'it_extra_decision' });
      if (fault === 'two-turns') later.items.push({ ...decision, turnId: later.id });
      if (fault === 'foreign-thread')
        publication.items[0] = { ...decision, threadId: 'th_foreign' };
      if (fault === 'wrong-executor') later.agentId = 'agent_foreign';
      if (fault === 'item-ahead') broken = { ...pending, publicationTurnId: publication.id };
      expect(validateCanonicalLoad(broken, turns)).not.toBeNull();
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'user',
    'turn',
    'package',
    'missing',
    'arguments-digest',
  ] as const)('rejects a contradictory captured authorization binding: %s', (fault) => {
    const { coreDb, store } = openPendingApp();
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Captured source',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_binding', 'binding');
      store.createItem({
        id: input.requestItemId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      const record = raiseRecordedPendingRequest(store, db.sqlite, input);
      const turns = store.listThreadTurns('ws_demo', 'th_demo');
      expect(validateCanonicalLoad(record, turns)).toBeNull();
      const context = record.authorizationContext!;
      const broken = {
        ...record,
        ...(fault === 'arguments-digest' ? { argumentsDigest: 'sha256:incorrect' } : {}),
        authorizationContext:
          fault === 'missing'
            ? null
            : fault === 'arguments-digest'
              ? context
              : {
                  ...context,
                  ...(fault === 'user'
                    ? { responsibleUserId: 'user_foreign' }
                    : fault === 'turn'
                      ? { turnId: 'tu_foreign' }
                      : { packageDigest: 'sha256:foreign' }),
                },
      };
      expect(validateCanonicalLoad(broken, turns)).not.toBeNull();
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects an unreadable canonical request as inspect-only in the Thread dashboard', async () => {
    const { coreDb, dataRoot, store, app } = openPendingApp('agent_demo');
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Unreadable request',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_unreadable', 'unreadable');
      store.createItem({
        id: input.requestItemId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, input);
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET authorization_context_json = '{invalid' WHERE request_id = ?"
        )
        .run(input.requestId);
      const response = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws_demo', threadId: 'th_demo' }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()).pendingRequests).toContainEqual({
        requestId: input.requestId,
        state: 'inspect-only',
        resolution: null,
        ending: null,
        disposition: null,
      });
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not mutate a contradictory request during archive closeout', async () => {
    const { coreDb, store, dataRoot, app } = openPendingApp();
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Broken request',
      { kind: 'user', id: 'user_local' },
      null
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    const record = raisePendingRequest(
      db.sqlite,
      approvalRaise(turn.id, 'ap_broken_boot', 'broken')
    ).record;
    db.sqlite
      .prepare(
        "UPDATE pending_requests SET state = 'resolved', resolution = 'granted', deciding_actor_kind = 'user', deciding_actor_id = 'user_local', decided_at = ?, claim = 'claimed', execution_call_id = ? WHERE request_id = ?"
      )
      .run(NOW, 'cap_pending_ap_broken_boot', record.requestId);
    const before = db.sqlite
      .prepare('SELECT * FROM pending_requests WHERE request_id = ?')
      .get(record.requestId);
    store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const response = await app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000769',
          }),
        }
      )
    );
    expect(response.status).toBe(200);
    expect(
      db.sqlite.prepare('SELECT * FROM pending_requests WHERE request_id = ?').get(record.requestId)
    ).toEqual(before);
    expect(
      store.listAllItems().filter((item) => item.causationId === record.requestItemId)
    ).toHaveLength(0);
    db.sqlite.close();
    coreDb.sqlite.close();
  });

  it.each([
    'missing-item',
    'foreign-actor',
    'request-content',
    'pending-claim',
    'denied-claim',
    'finished-refusal',
    'unnamed-decision',
    'foreign-decision-content',
  ] as const)('isolates canonical pending request contradiction: %s', (fault) => {
    const { coreDb, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Canonical request', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      store.createItem({
        id: 'it_canonical',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: 'ap_canonical',
        title: 'Canonical request',
        description: 'One exact command.',
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      const valid = raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ap_canonical',
        requestItemId: 'it_canonical',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'user_local',
        approval: {
          kind: 'permission',
          title: 'Canonical request',
          description: 'One exact command.',
        },
        governedIntent: { operation: 'canonical-test' },
        now: NOW,
      });
      const turns = store.listThreadTurns('ws_demo', 'th_demo');
      expect(validateCanonicalLoad(valid, turns)).toBeNull();
      let broken = valid;
      if (fault === 'missing-item') broken = { ...valid, requestItemId: 'it_nonexistent' };
      if (fault === 'request-content') broken = { ...valid, title: 'Different captured request' };
      if (fault === 'pending-claim')
        broken = { ...valid, claim: 'claimed', executionCallId: 'cap_unowned' };
      if (fault === 'foreign-actor')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'user_intruder' },
          decidedAt: NOW,
        };
      if (fault === 'denied-claim')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'user_local' },
          decidedAt: NOW,
          claim: 'claimed',
          executionCallId: 'cap_unowned',
        };
      if (fault === 'finished-refusal')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'granted',
          decidingActor: { kind: 'user', id: 'user_local' },
          decidedAt: NOW,
          claim: 'finished',
          disposition: 'denied-not-executed',
        };
      if (fault === 'unnamed-decision' || fault === 'foreign-decision-content') {
        const item = {
          id: 'it_decision_ap_canonical',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          type: 'approval-decision' as const,
          status: 'completed' as const,
          actor: { kind: 'user' as const, id: 'user_intruder' },
          causationId: 'it_canonical',
          approvalRequestId: 'ap_canonical',
          decision: 'granted' as const,
          decidedAt: NOW,
          createdAt: NOW,
          completedAt: NOW,
        };
        turns[0] = { ...turns[0]!, items: [...turns[0]!.items, item] };
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'user_local' },
          decidedAt: NOW,
          publicationTurnId: fault === 'unnamed-decision' ? null : turn.id,
        };
      }
      expect(validateCanonicalLoad(broken, turns)).toMatchObject({ requestId: valid.requestId });
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('offers no attention action for a missing request Item and keeps a valid sibling actionable', async () => {
    const { coreDb, store, app } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Two requests', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      for (const id of ['good', 'bad']) {
        store.createItem({
          id: `it_attention_${id}`,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          type: 'approval-request',
          status: 'completed',
          approvalRequestId: `ap_attention_${id}`,
          title: 'Attention request',
          description: 'One exact command.',
          kind: 'permission',
          createdAt: NOW,
          completedAt: NOW,
        });
        raiseRecordedPendingRequest(store, db.sqlite, {
          requestId: `ap_attention_${id}`,
          requestItemId: `it_attention_${id}`,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          raisingTurnId: turn.id,
          kind: 'approval',
          requesterKind: 'person',
          responsibleUserId: 'user_local',
          approval: {
            kind: 'permission',
            title: 'Attention request',
            description: 'One exact command.',
          },
          governedIntent: { operation: id },
          now: NOW,
        });
      }
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET request_item_id='it_nonexistent' WHERE request_id='ap_attention_bad'"
        )
        .run();
      const response = await app.request(
        ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      const rows = body.items ?? body.rows;
      expect(
        rows
          .find((row: { id: string }) => row.id === 'approval:ap_attention_good')
          .actions.some((action: { kind: string }) => action.kind === 'grant_approval')
      ).toBe(true);
      expect(
        rows
          .find((row: { id: string }) => row.id === 'approval:ap_attention_bad')
          ?.actions.filter((action: { kind: string }) =>
            ['grant_approval', 'deny_approval', 'withdraw_request'].includes(action.kind)
          ) ?? []
      ).toHaveLength(0);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'archive',
    'barrier',
    'boot',
  ] as const)('publishes a delivered person grant invalidation on its own completed Turn: %s', async (cause) => {
    const { app, coreDb, dataRoot, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Host publication', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    const now = new Date().toISOString();
    try {
      store.createItem({
        id: 'it_person_late',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: 'ap_person_late',
        title: 'Host push',
        description: 'Publish the approved commit.',
        kind: 'permission',
        createdAt: now,
        completedAt: now,
      });
      raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ap_person_late',
        requestItemId: 'it_person_late',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'user_local',
        approval: {
          kind: 'permission',
          title: 'Host push',
          description: 'Publish the approved commit.',
        },
        governedIntent: { operation: 'host-push' },
        now,
      });
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET state='resolved', resolution='granted', deciding_actor_kind='user', deciding_actor_id='user_local', decided_at=? WHERE request_id='ap_person_late'"
        )
        .run(now);
      expect(
        validateCanonicalLoad(
          readPendingRequest(db.sqlite, 'ap_person_late')!,
          store.listThreadTurns('ws_demo', 'th_demo')
        )
      ).toBeNull();
      store.updateTurn(turn.id, { status: 'completed', completedAt: now });
      const decision = readPendingRequest(db.sqlite, 'ap_person_late')!;
      expect(decision.delivery).toBe('delivered');
      expect(decision.publicationTurnId).not.toBe(turn.id);
      if (cause !== 'archive') {
        const busy = store.createTurn('ws_demo', 'th_demo', 'Unrelated work', {
          kind: 'user',
          id: 'user_local',
        });
        db.sqlite
          .prepare(
            "UPDATE pending_requests SET disposition='denied-not-executed', disposition_reason='membership-revoked' WHERE request_id='ap_person_late'"
          )
          .run();
        const refused = await app.request(
          ...operationRequest(
            'thread.archive',
            { workspaceId: 'ws_demo', threadId: 'th_demo' },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: 'ws_demo',
                threadId: 'th_demo',
                requestId: '00000000-0000-4000-8000-000000000761',
              }),
            }
          )
        );
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: 'thread_busy' });
        if (cause === 'boot') store.setTurnAdmissionHooks(null);
        store.updateTurn(busy.id, { status: 'completed', completedAt: new Date().toISOString() });
        if (cause === 'boot')
          recoverPendingRequestsAtBoot(store, {
            openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
          });
      } else {
        const archived = await app.request(
          ...operationRequest(
            'thread.archive',
            { workspaceId: 'ws_demo', threadId: 'th_demo' },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: 'ws_demo',
                threadId: 'th_demo',
                requestId: '00000000-0000-4000-8000-000000000762',
              }),
            }
          )
        );
        expect(archived.status).toBe(200);
      }
      const invalidated = readPendingRequest(db.sqlite, 'ap_person_late')!;
      expect(invalidated).toMatchObject({
        resolution: 'granted',
        claim: 'unclaimed',
        disposition: 'denied-not-executed',
        delivery: 'delivered',
        publicationTurnId: decision.publicationTurnId,
      });
      expect(invalidated.invalidationTurnId).not.toBeNull();
      expect(invalidated.invalidationTurnId).not.toBe(decision.publicationTurnId);
      const publication = store.getTurnById(invalidated.invalidationTurnId!);
      expect(publication.status).toBe('completed');
      expect(
        publication.items.filter(
          (item) => item.type === 'status' && item.causationId === 'it_person_late'
        )
      ).toHaveLength(1);
      expect(
        store
          .getTurnById(decision.publicationTurnId!)
          .items.filter((item) => item.type === 'status')
      ).toHaveLength(0);
      recoverPendingRequestsAtBoot(store, {
        openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
      });
      expect(
        store.getTurnById(publication.id).items.filter((item) => item.type === 'status')
      ).toHaveLength(1);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['terminal-barrier', 'permanent'],
    ['boot-resume', 'permanent'],
    ['terminal-barrier', 'transient'],
    ['boot-resume', 'transient'],
    ['terminal-barrier', 'refusal-release'],
    ['boot-resume', 'initial-lookup'],
  ] as const)('contains delivery and Workspace opener failures at %s with fault %s', async (site, fault) => {
    const { coreDb, dataRoot, store } = openPendingApp('agent_demo');
    let unavailable = false;
    const recovers = fault !== 'permanent';
    let submissions = 0;
    let lookup: ReturnType<typeof vi.spyOn> | undefined;
    let outcomeTurnId: string | undefined;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dependencies = {
      openWorkspace: (workspaceId: string) => {
        if (unavailable) {
          if (recovers) unavailable = false;
          throw new Error('Workspace unavailable during delivery');
        }
        return openWorkspaceDb(dataRoot, workspaceId);
      },
    };
    const workerDelivery = {
      async startTurn(_store: FsStore, turnId: string) {
        outcomeTurnId = turnId;
        submissions++;
        unavailable = true;
        if (fault === 'refusal-release')
          throw new TurnStartValidationError('agent_not_found', 'Agent is unavailable.', 409);
        throw new Error('Native submission result unknown');
      },
    };
    installPendingRequestAdmission(store, {
      ...dependencies,
      ...(site === 'terminal-barrier' ? { workerDelivery } : {}),
    });
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Delivery failure',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_delivery_failure', 'failure');
      store.createItem({
        id: input.requestItemId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, input);
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET state='resolved', resolution='denied', disposition='denied-not-executed', deciding_actor_kind='user', deciding_actor_id='user_local', decided_at=? WHERE request_id=?"
        )
        .run(NOW, input.requestId);
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
      if (site === 'boot-resume') {
        if (fault === 'initial-lookup') {
          outcomeTurnId = readPendingRequest(db.sqlite, input.requestId)!.deliveryTurnId!;
          const getTurn = store.getTurnById.bind(store);
          let reads = 0;
          lookup = vi.spyOn(store, 'getTurnById').mockImplementation((id) => {
            // The census reads the pending Turn first; the next lookup belongs to detached delivery.
            if (id === outcomeTurnId && ++reads === 2)
              throw new Error('Outcome Turn lookup unavailable');
            return getTurn(id);
          });
        }
        installPendingRequestAdmission(store, { ...dependencies, workerDelivery });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(outcomeTurnId).toBeDefined();
      expect(logged.mock.calls.some((call) => String(call[0]).includes(outcomeTurnId!))).toBe(true);
      if (fault === 'initial-lookup') {
        expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe('frozen');
        expect(store.getTurnById(outcomeTurnId!).status).toBe('pending');
        expect(logged.mock.calls[0]?.[0]).toBe(
          `Outcome delivery for Turn ${outcomeTurnId} failed before submission; leaving it for boot resume.`
        );
      } else if (recovers) {
        const refused = fault === 'refusal-release';
        expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe(
          refused ? 'undelivered' : 'delivery-unknown'
        );
        expect(store.getTurnById(outcomeTurnId!)).toMatchObject({
          status: 'failed',
          error: { code: refused ? 'agent_not_found' : 'delivery_unknown' },
        });
        expect(logged.mock.calls[0]?.[0]).toBe(
          `Recording the outcome delivery result failed for Turn ${outcomeTurnId}.`
        );
      } else {
        expect(store.getTurnById(outcomeTurnId!).status).toBe('pending');
      }
      if (fault === 'transient') {
        const later = store.createTurn(
          'ws_demo',
          'th_demo',
          'Later user message',
          { kind: 'user', id: 'user_local' },
          null,
          { agentId: 'agent_demo' }
        );
        store.updateTurn(later.id, { status: 'completed', completedAt: new Date().toISOString() });
        installPendingRequestAdmission(store, { ...dependencies, workerDelivery });
      }
      expect(submissions).toBe(fault === 'initial-lookup' ? 0 : 1);
    } finally {
      unavailable = false;
      lookup?.mockRestore();
      logged.mockRestore();
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'accepted',
    'agent-removed',
  ] as const)('submits a pending frozen boot admission once when its worker service is installed: %s', async (mode) => {
    const { coreDb, dataRoot, store } = openPendingApp('agent_demo');
    const dependencies = {
      openWorkspace: (workspaceId: string) => openWorkspaceDb(dataRoot, workspaceId),
    };
    installPendingRequestAdmission(store, dependencies);
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Pending boot admission',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_boot_queue', 'boot');
      store.createItem({
        id: input.requestItemId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, input);
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET state='resolved', resolution='denied', disposition='denied-not-executed', deciding_actor_kind='user', deciding_actor_id='user_local', decided_at=? WHERE request_id=?"
        )
        .run(NOW, input.requestId);
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
      const admitted = readPendingRequest(db.sqlite, input.requestId)!;
      expect(admitted.delivery).toBe('frozen');
      expect(
        JSON.parse(
          frozenPendingOutcomeInput(db.sqlite, admitted.deliveryTurnId!, 'original trigger')
        )
      ).toMatchObject({
        triggerInput: 'original trigger',
        pendingOutcomes: [
          {
            request: {
              title: input.approval!.title,
              description: input.approval!.description,
              questions: null,
              call: {
                serverId: input.call!.serverId,
                toolName: input.call!.toolName,
                arguments: JSON.parse(input.call!.canonicalArgumentsJson),
              },
            },
          },
        ],
      });
      expect(store.getTurnById(admitted.deliveryTurnId!).status).toBe('pending');
      let submissions = 0;
      const workerDelivery = {
        async startTurn(_store: FsStore, turnId: string) {
          submissions++;
          if (mode === 'agent-removed')
            throw new TurnStartValidationError('agent_not_found', 'Agent is unavailable.', 409);
          proveFrozenDelivery(db.sqlite, turnId, new Date().toISOString());
        },
      };
      installPendingRequestAdmission(store, {
        ...dependencies,
        workerDelivery,
        agentAuthority: () => mode === 'accepted',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(submissions).toBe(1);
      expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe(
        mode === 'accepted' ? 'delivered' : 'closed-out'
      );
      installPendingRequestAdmission(store, { ...dependencies, workerDelivery });
      expect(submissions).toBe(1);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('closes a removed Agent request at the active Turn terminal barrier', () => {
    const { coreDb, dataRoot, store } = openPendingApp();
    let current = true;
    installPendingRequestAdmission(store, {
      coreDb,
      agentAuthority: () => current,
      openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
    });
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Request while busy',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_agent_barrier', 'barrier');
      store.createItem({
        id: input.requestItemId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: input.requestId,
        title: input.approval!.title,
        description: input.approval!.description,
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, input);
      current = false;
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
      const record = readPendingRequest(db.sqlite, input.requestId)!;
      expect(record).toMatchObject({
        state: 'ended',
        ending: 'invalidated',
        invalidatingEvent: 'agent-authority-revoked',
        delivery: 'closed-out',
      });
      const publication = store.getTurnById(record.publicationTurnId!);
      expect(publication).toMatchObject({ status: 'completed', agentId: null });
      expect(publication.items).toHaveLength(1);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('deduplicates an identical call, separates changed arguments, and stops at 16', () => {
    const { coreDb, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Raise approvals', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const first = raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_same', 'digest-a'));
      expect(() =>
        raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_same', 'changed-same-id'))
      ).toThrow(/different pending request/);
      const repeat = raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_other', 'digest-a'));
      const changed = raisePendingRequest(
        db.sqlite,
        approvalRaise(turn.id, 'ap_changed', 'digest-b')
      );
      expect(first.created).toBe(true);
      expect(repeat).toMatchObject({ created: false, record: { requestId: 'ap_same' } });
      expect(changed).toMatchObject({ created: true, record: { requestId: 'ap_changed' } });
      for (let index = 0; index < 14; index += 1) {
        raisePendingRequest(
          db.sqlite,
          approvalRaise(turn.id, `ap_bound_${index}`, `digest-${index}`)
        );
      }
      expect(() =>
        raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_seventeenth', 'digest-last'))
      ).toThrow(/request_limit_reached|16 pending requests/);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'echo',
    'openkit-repository',
  ])('grants a retained %s call whose tool left the supply without executing it and admits one delivering Turn', async (serverId) => {
    const gateway = createDefaultWorkerMcpGateway();
    const callTool = vi.spyOn(gateway, 'callTool');
    const listTools = vi.spyOn(gateway, 'listTools');
    const { app, coreDb, store } = openPendingApp('agent_demo', gateway);
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Raise one approval',
      { kind: 'user', id: 'user_local' },
      null,
      { agentId: 'agent_demo' }
    );
    store.createItem({
      id: 'it_ap_supply',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: 'ap_supply',
      title: 'Approve echo',
      description: 'Allow one echo call.',
      kind: 'permission',
      createdAt: NOW,
      completedAt: NOW,
    });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      const raised = approvalRaise(turn.id, 'ap_supply', 'digest-supply');
      if (serverId === 'openkit-repository') {
        const args = {
          resourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000702',
          sourceRef: 'HEAD',
          targetBranch: 'feature/retired',
          commitIds: ['a'.repeat(40)],
        };
        raised.call = {
          ...raised.call!,
          serverId,
          toolName: 'repository_push',
          canonicalArgumentsJson: canonicalJsonText(args),
          argumentsDigest: mcpToolArgumentsContentDigest(args),
          catalogRevision:
            'sha256:760fdb6951f11b512c6e556739733aec40036c3a57167b4985947dd0408b46b5',
          schemaSnapshotId:
            'sha256:760fdb6951f11b512c6e556739733aec40036c3a57167b4985947dd0408b46b5',
        };
      }
      raiseRecordedPendingRequest(store, db.sqlite, raised);
    } finally {
      db.sqlite.close();
    }
    store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const response = await app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: 'ap_supply' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision: 'granted',
            requestId: '00000000-0000-4000-8000-000000000701',
            threadId: 'th_demo',
            turnId: turn.id,
            workspaceId: 'ws_demo',
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'ap_supply', status: 'granted' });
    const recorded = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    try {
      expect(readPendingRequest(recorded.sqlite, 'ap_supply')).toMatchObject({
        resolution: 'granted',
        disposition: 'denied-not-executed',
        dispositionReason: 'tool-left-supply',
        claim: 'unclaimed',
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(listTools).not.toHaveBeenCalled();
      expect(recorded.sqlite.prepare('SELECT * FROM capability_calls').all()).toEqual([]);
    } finally {
      recorded.sqlite.close();
    }
    await vi.waitFor(() => {
      const deliveredTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((candidate) => candidate.id !== turn.id);
      expect(deliveredTurn?.status).toBe('completed');
      expect(
        coreDb.sqlite
          .prepare('SELECT phase FROM scheduler_execution_attempts WHERE turn_id = ?')
          .get(deliveredTurn!.id)
      ).toEqual({ phase: 'closed' });
    });
    const outcome = store
      .listThreadTurns('ws_demo', 'th_demo')
      .find((candidate) => candidate.id !== turn.id);
    expect(outcome, outcome?.error?.message).toMatchObject({
      status: 'completed',
      triggerSource: { kind: 'approval-resolution' },
    });
    const delivered = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    expect(readPendingRequest(delivered.sqlite, 'ap_supply')).toMatchObject({
      delivery: 'delivered',
      deliveryTurnId: outcome!.id,
    });
    delivered.sqlite.close();
    expect(outcome?.items.some((item) => item.type === 'status')).toBe(true);
    coreDb.sqlite.close();
  });

  it('answers once, rejects a changed map and a secret question before a write, and withdraws', async () => {
    const { app, coreDb, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Ask', { kind: 'user', id: 'user_local' });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    const question = {
      id: 'path',
      header: 'Path',
      question: 'Which path?',
      options: null,
      isOther: true,
      isSecret: false,
    };
    try {
      store.createItem({
        id: 'it_ui_path',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId: 'user_local',
        userInputRequestId: 'ui_path',
        prompt: 'Which path?',
        questions: [question],
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ui_path',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        raisingTurnId: turn.id,
        requestItemId: 'it_ui_path',
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: 'user_local',
        questions: [question],
        questionDigest: 'digest-path',
        now: NOW,
      });
      store.createItem({
        id: 'it_ui_secret',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId: 'user_local',
        userInputRequestId: 'ui_secret',
        prompt: 'Secret?',
        questions: [{ ...question, id: 'secret', isSecret: true }],
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ui_secret',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        raisingTurnId: turn.id,
        requestItemId: 'it_ui_secret',
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: 'user_local',
        questions: [{ ...question, id: 'secret', isSecret: true }],
        questionDigest: 'digest-secret',
        now: NOW,
      });
    } finally {
      db.sqlite.close();
    }
    store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const secret = await app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: 'ui_secret' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userInputRequestId: 'ui_secret',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000702',
            answers: { secret: ['hidden'] },
          }),
        }
      )
    );
    expect(secret.status).toBe(400);
    await expect(secret.json()).resolves.toMatchObject({ code: 'secret_input_not_supported' });
    const answered = await app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: 'ui_path' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userInputRequestId: 'ui_path',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000703',
            answers: { path: ['left'] },
            futureSafeField: 'ignored-command-metadata',
          }),
        }
      )
    );
    expect(answered.status, await answered.clone().text()).toBe(200);
    const persisted = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    expect(
      JSON.stringify(persisted.sqlite.prepare('SELECT * FROM pending_requests').all())
    ).not.toContain('ignored-command-metadata');
    persisted.sqlite.close();
    const again = await app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: 'ui_path' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userInputRequestId: 'ui_path',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000704',
            answers: { path: ['right'] },
          }),
        }
      )
    );
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
    const withdrawn = await app.request(
      ...operationRequest(
        'pending-request.withdraw',
        { pendingRequestId: 'ui_secret' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pendingRequestId: 'ui_secret',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000705',
          }),
        }
      )
    );
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    await expect(withdrawn.json()).resolves.toMatchObject({
      requestId: 'ui_secret',
      state: 'ended',
      ending: 'withdrawn',
    });
    const recorded = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    try {
      expect(readPendingRequest(recorded.sqlite, 'ui_secret')).toMatchObject({
        state: 'ended',
        ending: 'withdrawn',
      });
    } finally {
      recorded.sqlite.close();
    }
    coreDb.sqlite.close();
  });

  it('settles an unfinished claim to outcome-unknown and does not execute it again', () => {
    const { coreDb, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Claim', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_crash', 'digest-crash'));
      db.sqlite
        .prepare(
          `UPDATE pending_requests
           SET state = 'resolved', resolution = 'granted', claim = 'claimed', disposition = NULL
           WHERE request_id = ?`
        )
        .run('ap_crash');
      expect(settleUnfinishedClaims(db.sqlite, NOW)).toBe(1);
      expect(readPendingRequest(db.sqlite, 'ap_crash')).toMatchObject({
        claim: 'finished',
        disposition: 'outcome-unknown',
        dispositionReason: 'restart',
      });
      expect(settleUnfinishedClaims(db.sqlite, NOW)).toBe(0);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('refuses archive while a Turn is running and a request is pending, then closes an idle Thread out', async () => {
    const { app, coreDb, store } = openPendingApp();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Busy', { kind: 'user', id: 'user_local' });
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      store.createItem({
        id: 'it_ap_archive',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: 'ap_archive',
        title: 'Approve echo',
        description: 'Allow one echo call.',
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(
        store,
        db.sqlite,
        approvalRaise(turn.id, 'ap_archive', 'digest-archive')
      );
    } finally {
      db.sqlite.close();
    }
    const busy = await app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000706',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
          }),
        }
      )
    );
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({ code: 'thread_busy' });
    expect(store.getThread('ws_demo', 'th_demo').status).not.toBe('archived');
    store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const archived = await app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000707',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
          }),
        }
      )
    );
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(store.getThread('ws_demo', 'th_demo').status).toBe('archived');
    const recorded = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    try {
      expect(readPendingRequest(recorded.sqlite, 'ap_archive')).toMatchObject({
        state: 'ended',
        ending: 'invalidated',
      });
    } finally {
      recorded.sqlite.close();
    }
    coreDb.sqlite.close();
  });

  it('keeps a contradictory request inspect-only and a sibling request decidable after reload', () => {
    const { coreDb, dataRoot, store } = openPendingApp('agent_demo');
    const goodTurn = store.createTurn('ws_demo', 'th_demo', 'Good', {
      kind: 'user',
      id: 'user_local',
    });
    const other = store.createThread('ws_demo', 'Other');
    const otherTurn = store.createTurn('ws_demo', other.id, 'Other', {
      kind: 'user',
      id: 'user_local',
    });
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(db);
    try {
      store.createItem({
        id: 'it_ap_good',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: goodTurn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: 'ap_good',
        title: 'Approve echo',
        description: 'Allow one echo call.',
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      store.createItem({
        id: 'it_ap_bad',
        workspaceId: 'ws_demo',
        threadId: other.id,
        turnId: otherTurn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: 'ap_bad',
        title: 'Approve echo',
        description: 'Allow one echo call.',
        kind: 'permission',
        createdAt: NOW,
        completedAt: NOW,
      });
      raiseRecordedPendingRequest(
        store,
        db.sqlite,
        approvalRaise(goodTurn.id, 'ap_good', 'digest-good')
      );
      raiseRecordedPendingRequest(store, db.sqlite, {
        ...approvalRaise(otherTurn.id, 'ap_bad', 'digest-bad'),
        threadId: other.id,
        requestItemId: 'it_ap_bad',
        call: {
          ...approvalRaise(otherTurn.id, 'ap_bad', 'digest-bad').call!,
          authorizationContext: {
            threadId: other.id,
            turnId: otherTurn.id,
            agentSessionId: null,
            agentId: 'agent_demo',
            responsibleUserId: 'user_local',
            packageDigest: null,
            policyDecisionId: null,
          },
        },
      });
    } finally {
      db.sqlite.close();
    }
    store.updateTurn(otherTurn.id, { status: 'completed', completedAt: NOW });
    const decision = {
      workspaceId: 'ws_demo' as const,
      threadId: other.id,
      turnId: otherTurn.id,
      type: 'approval-decision' as const,
      status: 'completed' as const,
      actor: { kind: 'user' as const, id: 'user_local' },
      causationId: 'req_bad_decision',
      approvalRequestId: 'ap_bad',
      decision: 'granted' as const,
      decidedAt: NOW,
      createdAt: NOW,
      completedAt: NOW,
    };
    store.createItem(
      { ...decision, id: 'it_bad_decision_1' },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    store.createItem(
      { ...decision, id: 'it_bad_decision_2', causationId: 'req_bad_decision_2' },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    const bad = readPendingRequest(openWorkspaceDb(dataRoot, 'ws_demo').sqlite, 'ap_bad');
    expect(validateCanonicalLoad(bad!, store.listThreadTurns('ws_demo', other.id))?.reason).toBe(
      'two-resolutions'
    );
    store.updateTurn(goodTurn.id, { status: 'completed', completedAt: NOW });
    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getApproval('ap_good').status).toBe('pending');
    expect(() => reloaded.getApproval('ap_bad')).toThrow(/not found/i);
    coreDb.sqlite.close();
  });
});

// This fixture supplies confirmed image evidence; the pending delivery owner still runs unchanged.
vi.mock('./agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
