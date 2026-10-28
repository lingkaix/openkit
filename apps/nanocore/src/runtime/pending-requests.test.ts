import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJsonText } from '@openkit/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { readRetainedBodyBytes } from '../test-support/retained-body-observation.js';
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
  resolveCommandIntentApproval,
} from './pending-request-flow.js';
import {
  answerPendingRequest,
  deletePendingRequest,
  freezeReadyOutcomes,
  frozenPendingOutcomeInput,
  type PendingRequestRecord,
  pendingRequestItemId,
  proveFrozenDelivery,
  type RaisePendingRequestInput,
  raisePendingRequest,
  readPendingRequest,
  readPendingRequestLineage,
  releaseFrozenOutcomes,
  settleUnfinishedClaims,
  validateCanonicalLoad,
} from './pending-requests.js';
import { createDefaultWorkerMcpGateway, type WorkerMcpGateway } from './worker-mcp-gateway.js';

const NOW = '2026-09-30T00:00:00.000Z';

it('permits denial of a person command intent whose exact detail is unavailable', async () => {
  const { store, coreDb, dataRoot } = await openPendingApp();
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const actor = { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' };
  const turn = await store.createTurn(workspaceId, threadId, 'Exact destructive effect', {
    kind: 'user',
    id: actor.userId,
  });
  const db = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(db);
  try {
    const requestId = '00000000-0000-4000-8000-000000000938';
    const title = 'Confirm exact effect';
    const description = 'Complete detail is required to grant.';
    const record = await raiseRecordedPendingRequest(store, db.sqlite, {
      requestId,
      workspaceId,
      threadId,
      raisingTurnId: turn.id,
      requestItemId: pendingRequestItemId(requestId, 'request'),
      kind: 'approval',
      requesterKind: 'person',
      responsibleUserId: actor.userId,
      governedIntent: { operation: 'fixture', content: 'x'.repeat(APPROVAL_DETAIL_BYTES) },
      approval: { kind: 'destructive-action', title, description },
      now: NOW,
    });
    await store.createItem({
      id: record.requestItemId,
      owner: { kind: 'workspace', workspaceId: workspaceId },
      threadId,
      turnId: turn.id,
      type: 'approval-request',
      approvalRequestId: requestId,
      kind: 'destructive-action',
      title,
      description,
      status: 'completed',
      createdAt: NOW,
      completedAt: NOW,
    });
    expect(projectApprovalEffect({ record, store, coreDb, actor }).status).toBe('unavailable');
    await expect(
      resolveCommandIntentApproval({
        store,
        sqlite: db.sqlite,
        record,
        decision: 'granted',
        actor,
        coreDb,
      })
    ).rejects.toThrow('Exact effect unavailable; approval disabled');
    expect(
      await resolveCommandIntentApproval({
        store,
        sqlite: db.sqlite,
        record,
        decision: 'denied',
        actor,
        coreDb,
      })
    ).toMatchObject({
      resolution: 'denied',
      claim: 'unclaimed',
      executionCallId: null,
    });
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});

/**
 * Opens one local Core app whose workspace database can hold pending requests.
 *
 * @returns App, store, data root, and the actual simulator executor.
 */
async function openPendingApp(agentId?: string, workerMcpGateway?: WorkerMcpGateway) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-request-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000_000n);
  const executor = new SimulatedTurnExecutor({ coreDb, fileAdmission });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  recordTestNativeRuntimeTarget(coreDb);
  admitTestNativeEnvironment(
    coreDb,
    createTestAgentSetup({ ...(agentId ? { agentId } : {}) }).manifest
  );
  const app = createApp({
    fileAdmission,
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
    turnExecutor: executor,
  });
  return { app, coreDb, dataRoot, executor, store };
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    raisingTurnId: turnId,
    requestItemId: testEntityId('it', `it_${requestId}`),
    kind: 'approval',
    requesterKind: 'worker',
    agentId: 'agent_demo',
    responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId,
        agentSessionId: null,
        agentId: 'agent_demo',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        packageDigest: null,
        policyDecisionId: null,
      },
    },
    approval: { kind: 'permission', title: 'Approve echo', description: 'Allow one echo call.' },
    now: NOW,
  };
}

describe('pending requests', () => {
  it('retains historical captured argument bytes through reopen, validation and qualified replay', async () => {
    const { coreDb, store, dataRoot } = await openPendingApp();
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    const turn = await store.createTurn(
      workspaceId,
      threadId,
      'Retain captured arguments',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      },
      null,
      { agentId: 'agent_demo' }
    );
    let db = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(db);
    const args = { nested: { z: 'last', a: 'first' }, 10: 'ten', 2: 'two' };
    // Captured pre-switch canonical JSON uses ECMAScript enumeration for integer-looking keys.
    const historical = '{"2":"two","10":"ten","nested":{"a":"first","z":"last"}}';
    const historicalDigest = `sha256:${createHash('sha256').update(historical).digest('hex')}`;
    const base = approvalRaise(turn.id, 'ap_retained_argument_bytes', 'initial');
    const input = {
      ...base,
      call: {
        ...base.call!,
        canonicalArgumentsJson: canonicalJsonText(args),
        argumentsDigest: mcpToolArgumentsContentDigest(args),
      },
    };
    try {
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
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
      await raiseRecordedPendingRequest(store, db.sqlite, input);
      await shutdownControlStoreWorkerClient();
      // Restore a captured historical preimage on this owner's valid record, retaining all identities.
      db.sqlite
        .prepare(`UPDATE pending_requests SET canonical_arguments_json = ?, arguments_digest = ?
        WHERE request_id = ?`)
        .run(historical, historicalDigest, input.requestId);
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, workspaceId);
      const retained = readPendingRequest(db.sqlite, input.requestId)!;
      expect(
        validateCanonicalLoad(retained, store.listThreadTurns(workspaceId, threadId))
      ).toBeNull();
      expect(retained).toMatchObject({
        canonicalArgumentsJson: historical,
        argumentsDigest: historicalDigest,
      });
      expect(raisePendingRequest(db.sqlite, input)).toMatchObject({
        created: false,
        record: { requestId: input.requestId },
      });
      const changed = { ...args, 2: 'changed' };
      expect(() =>
        raisePendingRequest(db.sqlite, {
          ...input,
          call: {
            ...input.call,
            canonicalArgumentsJson: canonicalJsonText(changed),
            argumentsDigest: mcpToolArgumentsContentDigest(changed),
          },
        })
      ).toThrow(expect.objectContaining({ code: 'idempotency_key_conflict' }));
      // Schema Evolution, Canonical Structured Values And Exact Bytes preserves the original proof.
      expect(
        db.sqlite
          .prepare('SELECT canonical_arguments_json, arguments_digest FROM pending_requests')
          .all()
      ).toEqual([{ canonical_arguments_json: historical, arguments_digest: historicalDigest }]);
    } finally {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('retains v1 handoff meaning and original annotations across replay and reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-request-v1-'));
    onTestFinished(() => rmSync(dataRoot, { force: true, recursive: true }));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const db = openWorkspaceDb(dataRoot, workspaceId);
    const input = {
      workspaceId,
      threadId: testEntityId('th', 'pending_v1_thread'),
      raisingTurnId: testEntityId('tu', 'pending_v1_turn'),
      requestId: 'uq_retained_v1',
      requestItemId: pendingRequestItemId('uq_retained_v1', 'request'),
      kind: 'user-input',
      requesterKind: 'assistant',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      questions: [{ id: 'q', question: 'Start the selected work?' }],
      assistantHandoff: {
        kind: 'task',
        targetWorkspaceId: workspaceId,
        input: 'Keep the exact selected work.',
        agentId: 'agent_fixture',
        modelId: 'model_fixture',
      },
      now: NOW,
    } satisfies RaisePendingRequestInput;
    let retainedRow: unknown;
    try {
      applyScopedMigrations(db);
      expect(raisePendingRequest(db.sqlite, input).created).toBe(true);
      expect(
        db.sqlite.prepare('SELECT schema_version AS schemaVersion FROM pending_requests').get()
      ).toEqual({ schemaVersion: 1 });
      db.sqlite
        .prepare('UPDATE pending_requests SET assistant_handoff_json = ? WHERE request_id = ?')
        .run(
          JSON.stringify({
            ...input.assistantHandoff,
            description: 'Retained handoff annotation.',
          }),
          input.requestId
        );
      retainedRow = db.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,
        assistant_handoff_json FROM pending_requests`)
        .get();
      expect(raisePendingRequest(db.sqlite, input)).toMatchObject({
        created: false,
        record: { assistantHandoff: input.assistantHandoff },
      });
      expect(readPendingRequest(db.sqlite, input.requestId)?.assistantHandoff).toEqual(
        input.assistantHandoff
      );
    } finally {
      db.sqlite.close();
    }
    const reopened = openWorkspaceDb(dataRoot, workspaceId);
    try {
      expect(readPendingRequest(reopened.sqlite, input.requestId)?.assistantHandoff).toEqual(
        input.assistantHandoff
      );
      expect(
        reopened.sqlite
          .prepare(`SELECT schema_version AS schemaVersion,
        assistant_handoff_json FROM pending_requests`)
          .get()
      ).toEqual(retainedRow);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('refuses an unknown request version before JSON, direct mutation or bulk delivery effects', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-request-version-'));
    onTestFinished(() => rmSync(dataRoot, { force: true, recursive: true }));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const db = openWorkspaceDb(dataRoot, workspaceId);
    const requestId = 'uq_unknown_version';
    const deliveryTurnId = testEntityId('tu', 'pending_unknown_delivery');
    try {
      applyScopedMigrations(db);
      raisePendingRequest(db.sqlite, {
        requestId,
        workspaceId,
        threadId: testEntityId('th', 'pending_unknown_thread'),
        raisingTurnId: testEntityId('tu', 'pending_unknown_turn'),
        requestItemId: pendingRequestItemId(requestId, 'request'),
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        questions: [{ id: 'q', question: 'Keep the retained request unchanged?' }],
        now: NOW,
      });
      db.sqlite
        .prepare(`UPDATE pending_requests SET schema_version = 2, questions_json = '{',
        delivery = 'frozen', delivery_turn_id = ? WHERE request_id = ?`)
        .run(deliveryTurnId, requestId);
      db.sqlite.exec(`CREATE TRIGGER refuse_unsupported_pending_update BEFORE UPDATE ON pending_requests
        BEGIN SELECT RAISE(FAIL, 'Unsupported request reached an UPDATE'); END`);
      db.sqlite.exec(`CREATE TRIGGER refuse_unsupported_pending_delete BEFORE DELETE ON pending_requests
        BEGIN SELECT RAISE(FAIL, 'Unsupported request reached a DELETE'); END`);

      expect(() => readPendingRequest(db.sqlite, requestId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => readPendingRequestLineage(db.sqlite, requestId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => deletePendingRequest(db.sqlite, requestId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        answerPendingRequest(
          db.sqlite,
          requestId,
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          { q: ['Yes'] },
          NOW
        )
      ).toThrow('Unsupported retained record format.');
      expect(() => releaseFrozenOutcomes(db.sqlite, deliveryTurnId, NOW)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => proveFrozenDelivery(db.sqlite, deliveryTurnId, NOW)).toThrow(
        'Unsupported retained record format.'
      );
      expect(
        db.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, state, delivery,
        questions_json FROM pending_requests`)
          .get()
      ).toEqual({
        schemaVersion: 2,
        state: 'pending',
        delivery: 'frozen',
        questions_json: '{',
      });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    'denied',
    'withdrawn',
  ] as const)('refuses oversized exact effect before grant and still permits %s', async (ending) => {
    const { app, coreDb, store, dataRoot } = await openPendingApp('agent_demo');
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Unclassified effect',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_missing_disclosure', 'large'.repeat(120000));
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: input.workspaceId },
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
      await raiseRecordedPendingRequest(store, db.sqlite, input);
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

  it('freezes only sixteen complete outcomes and retains large multibyte values across restart', async () => {
    const { coreDb, dataRoot, store } = await openPendingApp();
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    const question = '多字节🙂"\\'.repeat(20000);
    const answer = 'large answer "\\🙂'.repeat(600000);
    const trigger = 'original trigger 多🙂"\\';
    try {
      const turn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Collect outcomes',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null,
        { agentId: 'agent_demo' }
      );
      for (let index = 0; index < 17; index++) {
        const requestId = `uq_count_${String(index).padStart(2, '0')}`;
        // Stopped retained-record fixture; this does not claim native admission or execution.
        await shutdownControlStoreWorkerClient();
        raisePendingRequest(db.sqlite, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          raisingTurnId: turn.id,
          requestId,
          requestItemId: testEntityId('it', `it_${requestId}`),
          kind: 'user-input',
          requesterKind: 'worker',
          agentId: 'agent_demo',
          responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
            { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
            { q: [index === 0 ? answer : 'Small'] },
            NOW
          )
        ).not.toBeNull();
      }
      expect(
        freezeReadyOutcomes(db.sqlite, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: testEntityId('tu', 'delivery_count'),
          executor: 'worker',
          agentId: 'agent_demo',
          cause: 'carried',
          now: NOW,
        })
      ).toHaveLength(16);
      const bytes = frozenPendingOutcomeInput(
        db.sqlite,
        testEntityId('tu', 'delivery_count'),
        trigger
      );
      const value = JSON.parse(bytes);
      expect(value.triggerInput).toBe(trigger);
      expect(value.pendingOutcomes).toHaveLength(16);
      expect(value.pendingOutcomes[0].request.questions[0].question).toBe(question);
      expect(value.pendingOutcomes[0].answers.q).toEqual([answer]);
      expect(readPendingRequest(db.sqlite, 'uq_count_16')?.delivery).toBe('undelivered');
      db.sqlite.close();
      const reopened = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(
          frozenPendingOutcomeInput(reopened.sqlite, testEntityId('tu', 'delivery_count'), trigger)
        ).toBe(bytes);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      if (db.sqlite.open) db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects only complete canonical detail within the inclusive UTF-8 boundary', async () => {
    const { store, coreDb, dataRoot } = await openPendingApp();
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const turn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Preview boundary',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null
      );
      const input = approvalRaise(turn.id, 'ap_detail_boundary', '');
      // Stopped retained-record fixture; this does not claim native admission or execution.
      await shutdownControlStoreWorkerClient();
      const record = raisePendingRequest(db.sqlite, input).record;
      const preview = (message: string, userId = 'usr_00000000-0000-7000-8000-000000000001') =>
        projectApprovalEffect({
          record: { ...record, canonicalArgumentsJson: JSON.stringify({ message }) },
          store,
          coreDb,
          actor: {
            kind: userId === 'usr_00000000-0000-7000-8000-000000000001' ? 'local' : 'session',
            userId,
          },
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
          `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Shared viewer', 'viewer@example.invalid', 0, ?, ?, 'human', 'active')`
        )
        .run(testEntityId('usr', 'another-user'), Date.now(), Date.now());
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES ('ws_00000000-0000-7000-8000-000000000001', ?, 'active', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(testEntityId('usr', 'another-user'), NOW, NOW, NOW);
      expect(preview('not for this viewer', testEntityId('usr', 'another-user'))).toMatchObject({
        status: 'unavailable',
      });
      const privateThread = await store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'Private source',
        undefined,
        'conversation',
        { visibility: 'private', privateOwnerUserId: testEntityId('usr', 'another-user') }
      );
      expect(
        projectApprovalEffect({
          record: { ...record, threadId: privateThread.id },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        })
      ).toMatchObject({ status: 'unavailable' });
      expect(
        coreDb.sqlite
          .prepare(
            "UPDATE workspace_members SET status = 'removed', removed_at = '2026-10-01T00:00:00.000Z', updated_at = '2026-10-01T00:00:00.000Z', revision = 2 WHERE user_id = ?"
          )
          .run(testEntityId('usr', 'another-user')).changes
      ).toBe(1);
      expect(
        projectApprovalEffect({
          record: { ...record, responsibleUserId: testEntityId('usr', 'another-user') },
          store,
          coreDb,
          actor: { kind: 'session', userId: testEntityId('usr', 'another-user') },
        })
      ).toMatchObject({ status: 'unavailable' });
      expect(
        projectApprovalEffect({
          record: { ...record, serverId: null, governedIntent: null },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        })
      ).toMatchObject({ status: 'unavailable' });

      expect(
        projectApprovalEffect({
          record: { ...record, canonicalArgumentsJson: '{' },
          store,
          coreDb,
          actor: { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' },
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

  it('does not settle or publish a contradictory request at boot', async () => {
    const { coreDb, store, dataRoot } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Broken request',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    // Stopped retained-record fixture; this does not claim native admission or execution.
    await shutdownControlStoreWorkerClient();
    const record = raisePendingRequest(
      db.sqlite,
      approvalRaise(turn.id, 'ap_broken_boot', 'broken')
    ).record;
    // Exclude the live native writer before constructing this retained corruption.
    await shutdownControlStoreWorkerClient();
    db.sqlite
      .prepare(
        "UPDATE pending_requests SET state = 'resolved', resolution = 'granted', deciding_actor_kind = 'user', deciding_actor_id = 'usr_00000000-0000-7000-8000-000000000001', decided_at = ?, claim = 'claimed', execution_call_id = ? WHERE request_id = ?"
      )
      .run(NOW, 'cap_00000000-0000-71cc-8b29-e0da8c534fd7', record.requestId);
    const before = db.sqlite
      .prepare('SELECT * FROM pending_requests WHERE request_id = ?')
      .get(record.requestId);
    await recoverPendingRequestsAtBoot(store, {
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
  ] as const)('isolates canonical pending request contradiction: %s', async (fault) => {
    const { coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Canonical request',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      await store.createItem({
        id: 'it_00000000-0000-7135-b73e-1a5d0ba8b860',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      const valid = await raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ap_canonical',
        requestItemId: 'it_00000000-0000-7135-b73e-1a5d0ba8b860',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        approval: {
          kind: 'permission',
          title: 'Canonical request',
          description: 'One exact command.',
        },
        governedIntent: { operation: 'canonical-test' },
        now: NOW,
      });
      const turns = store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      );
      expect(validateCanonicalLoad(valid, turns)).toBeNull();
      let broken = valid;
      if (fault === 'missing-item')
        broken = { ...valid, requestItemId: 'it_00000000-0000-7073-8596-45dc5f23bd0f' };
      if (fault === 'request-content') broken = { ...valid, title: 'Different captured request' };
      if (fault === 'pending-claim')
        broken = {
          ...valid,
          claim: 'claimed',
          executionCallId: 'cap_00000000-0000-7335-b155-428d9d7247c8',
        };
      if (fault === 'foreign-actor')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-74fc-a033-596a76f1bff7' },
          decidedAt: NOW,
        };
      if (fault === 'denied-claim')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          decidedAt: NOW,
          claim: 'claimed',
          executionCallId: 'cap_00000000-0000-7335-b155-428d9d7247c8',
        };
      if (fault === 'finished-refusal')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'granted',
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          decidedAt: NOW,
          claim: 'finished',
          disposition: 'denied-not-executed',
        };
      if (fault === 'unnamed-decision' || fault === 'foreign-decision-content') {
        const item = {
          id: 'it_00000000-0000-7de5-8c97-f7a0180b82a4',
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          type: 'approval-decision' as const,
          status: 'completed' as const,
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-74fc-a033-596a76f1bff7' },
          causationId: 'it_00000000-0000-7135-b73e-1a5d0ba8b860',
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
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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
  ] as const)('isolates the owner canonical publication fixture: %s', async (fault) => {
    const { coreDb, store } = await openPendingApp();
    const raising = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Canonical captured request',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(raising.id, 'ap_publication_matrix', 'matrix');
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: input.workspaceId },
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
      const pending = await raiseRecordedPendingRequest(store, db.sqlite, input);
      const decision = {
        id: pendingRequestItemId(input.requestId, 'decision'),
        owner: { kind: 'workspace', workspaceId: input.workspaceId },
        threadId: input.threadId,
        turnId: 'tu_00000000-0000-7718-9293-4265e25b9375',
        type: 'approval-decision' as const,
        status: 'completed' as const,
        actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
        causationId: input.requestItemId,
        approvalRequestId: input.requestId,
        decision: 'denied' as const,
        decidedAt: NOW,
        createdAt: NOW,
        completedAt: NOW,
      };
      const publication = {
        ...raising,
        id: 'tu_00000000-0000-7718-9293-4265e25b9375',
        startedAt: NOW,
        status: 'failed' as const,
        completedAt: NOW,
        items: [decision],
      };
      const later = {
        ...raising,
        id: 'tu_00000000-0000-74b0-bdbf-68b899d25dc2',
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
      const turns = [
        ...store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        ),
        publication,
        later,
      ];
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
        publication.items.push({ ...decision, id: 'it_00000000-0000-772c-851f-fd16f7495d48' });
      if (fault === 'two-turns') later.items.push({ ...decision, turnId: later.id });
      if (fault === 'foreign-thread')
        publication.items[0] = { ...decision, threadId: 'th_00000000-0000-7856-9931-7f8680874d49' };
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
  ] as const)('rejects a contradictory captured authorization binding: %s', async (fault) => {
    const { coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Captured source',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_binding', 'binding');
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      const record = await raiseRecordedPendingRequest(store, db.sqlite, input);
      const turns = store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      );
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
                    ? { responsibleUserId: 'usr_00000000-0000-7ed5-9b62-226e0a66887f' }
                    : fault === 'turn'
                      ? { turnId: 'tu_00000000-0000-7f7b-9b65-51065b0acd8c' }
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
    const { coreDb, dataRoot, store, app } = await openPendingApp('agent_demo');
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Unreadable request',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_unreadable', 'unreadable');
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await raiseRecordedPendingRequest(store, db.sqlite, input);
      // Exclude the live native writer before constructing this retained corruption.
      await shutdownControlStoreWorkerClient();
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET authorization_context_json = '{invalid' WHERE request_id = ?"
        )
        .run(input.requestId);
      const response = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        }),
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
    const { coreDb, store, dataRoot, app } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Broken request',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    // Stopped retained-record fixture; this does not claim native admission or execution.
    await shutdownControlStoreWorkerClient();
    const record = raisePendingRequest(
      db.sqlite,
      approvalRaise(turn.id, 'ap_broken_boot', 'broken')
    ).record;
    // Exclude the live native writer before constructing this retained corruption.
    await shutdownControlStoreWorkerClient();
    db.sqlite
      .prepare(
        "UPDATE pending_requests SET state = 'resolved', resolution = 'granted', deciding_actor_kind = 'user', deciding_actor_id = 'usr_00000000-0000-7000-8000-000000000001', decided_at = ?, claim = 'claimed', execution_call_id = ? WHERE request_id = ?"
      )
      .run(NOW, 'cap_00000000-0000-71cc-8b29-e0da8c534fd7', record.requestId);
    const before = db.sqlite
      .prepare('SELECT * FROM pending_requests WHERE request_id = ?')
      .get(record.requestId);
    await store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const response = await app.request(
      ...operationRequest(
        'thread.archive',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
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
  ] as const)('isolates canonical pending request contradiction: %s', async (fault) => {
    const { coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Canonical request',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      await store.createItem({
        id: 'it_00000000-0000-7135-b73e-1a5d0ba8b860',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      const valid = await raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ap_canonical',
        requestItemId: 'it_00000000-0000-7135-b73e-1a5d0ba8b860',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        approval: {
          kind: 'permission',
          title: 'Canonical request',
          description: 'One exact command.',
        },
        governedIntent: { operation: 'canonical-test' },
        now: NOW,
      });
      const turns = store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      );
      expect(validateCanonicalLoad(valid, turns)).toBeNull();
      let broken = valid;
      if (fault === 'missing-item')
        broken = { ...valid, requestItemId: 'it_00000000-0000-7073-8596-45dc5f23bd0f' };
      if (fault === 'request-content') broken = { ...valid, title: 'Different captured request' };
      if (fault === 'pending-claim')
        broken = {
          ...valid,
          claim: 'claimed',
          executionCallId: 'cap_00000000-0000-7335-b155-428d9d7247c8',
        };
      if (fault === 'foreign-actor')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-74fc-a033-596a76f1bff7' },
          decidedAt: NOW,
        };
      if (fault === 'denied-claim')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'denied',
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          decidedAt: NOW,
          claim: 'claimed',
          executionCallId: 'cap_00000000-0000-7335-b155-428d9d7247c8',
        };
      if (fault === 'finished-refusal')
        broken = {
          ...valid,
          state: 'resolved',
          resolution: 'granted',
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          decidedAt: NOW,
          claim: 'finished',
          disposition: 'denied-not-executed',
        };
      if (fault === 'unnamed-decision' || fault === 'foreign-decision-content') {
        const item = {
          id: 'it_00000000-0000-7de5-8c97-f7a0180b82a4',
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          type: 'approval-decision' as const,
          status: 'completed' as const,
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-74fc-a033-596a76f1bff7' },
          causationId: 'it_00000000-0000-7135-b73e-1a5d0ba8b860',
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
          decidingActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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
    const { coreDb, store, app } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Two requests',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      for (const id of ['good', 'bad']) {
        await store.createItem({
          id: testEntityId('it', `it_attention_${id}`),
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          threadId: 'th_00000000-0000-7000-8000-000000000001',
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
        await raiseRecordedPendingRequest(store, db.sqlite, {
          requestId: `ap_attention_${id}`,
          requestItemId: testEntityId('it', `it_attention_${id}`),
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          raisingTurnId: turn.id,
          kind: 'approval',
          requesterKind: 'person',
          responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
          approval: {
            kind: 'permission',
            title: 'Attention request',
            description: 'One exact command.',
          },
          governedIntent: { operation: id },
          now: NOW,
        });
      }
      // Exclude the live native writer before constructing this retained corruption.
      await shutdownControlStoreWorkerClient();
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET request_item_id='it_00000000-0000-7073-8596-45dc5f23bd0f' WHERE request_id='ap_attention_bad'"
        )
        .run();
      const response = await app.request(
        ...operationRequest(
          'attention.list',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          undefined
        )
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
    const { app, coreDb, dataRoot, store } = await openPendingApp();
    store.setLiveCaptureCoverage({ scope: 'server', value: 'off' });
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Host publication',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    const now = new Date().toISOString();
    const createTurn = store.createTurn.bind(store);
    const clock = vi.spyOn(store, 'createTurn').mockImplementation(async (...args) => {
      if (args[5]?.executorKind !== 'person') return createTurn(...args);
      const decidedAt = readPendingRequest(db.sqlite, 'ap_person_late')!.decidedAt!;
      const itemTime = new Date(Date.parse(decidedAt) + 1).toISOString();
      const itemClock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(itemTime);
      try {
        return await createTurn(args[0], args[1], args[2], args[3], args[4], {
          ...args[5],
          startedAt: decidedAt,
        });
      } finally {
        itemClock.mockRestore();
      }
    });
    try {
      await store.createItem({
        id: 'it_00000000-0000-7a55-b4f2-9c2a5ec7c086',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await raiseRecordedPendingRequest(store, db.sqlite, {
        requestId: 'ap_person_late',
        requestItemId: 'it_00000000-0000-7a55-b4f2-9c2a5ec7c086',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        approval: {
          kind: 'permission',
          title: 'Host push',
          description: 'Publish the approved commit.',
        },
        governedIntent: { operation: 'host-push' },
        now,
      });
      // Exclude the live native writer before constructing this retained corruption.
      await shutdownControlStoreWorkerClient();
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET state='resolved', resolution='granted', deciding_actor_kind='user', deciding_actor_id='usr_00000000-0000-7000-8000-000000000001', decided_at=? WHERE request_id='ap_person_late'"
        )
        .run(now);
      expect(
        validateCanonicalLoad(
          readPendingRequest(db.sqlite, 'ap_person_late')!,
          store.listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
        )
      ).toBeNull();
      await store.updateTurn(turn.id, { status: 'completed', completedAt: now });
      const decision = readPendingRequest(db.sqlite, 'ap_person_late')!;
      expect(decision.delivery).toBe('delivered');
      expect(decision.publicationTurnId).not.toBe(turn.id);
      if (cause !== 'archive') {
        const busy = await store.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'Unrelated work',
          {
            kind: 'user',
            id: 'usr_00000000-0000-7000-8000-000000000001',
          }
        );
        // Exclude the live native writer before constructing this retained corruption.
        await shutdownControlStoreWorkerClient();
        db.sqlite
          .prepare(
            "UPDATE pending_requests SET disposition='denied-not-executed', disposition_reason='membership-revoked' WHERE request_id='ap_person_late'"
          )
          .run();
        const refused = await app.request(
          ...operationRequest(
            'thread.archive',
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
            },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
                requestId: '00000000-0000-4000-8000-000000000761',
              }),
            }
          )
        );
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: 'thread_busy' });
        if (cause === 'boot') store.setTurnAdmissionHooks(null);
        await store.updateTurn(busy.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        if (cause === 'boot')
          await recoverPendingRequestsAtBoot(store, {
            openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
          });
      } else {
        const archived = await app.request(
          ...operationRequest(
            'thread.archive',
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
            },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
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
          (item) =>
            item.type === 'status' && item.causationId === 'it_00000000-0000-7a55-b4f2-9c2a5ec7c086'
        )
      ).toHaveLength(1);
      expect(
        store
          .getTurnById(decision.publicationTurnId!)
          .items.filter((item) => item.type === 'status')
      ).toHaveLength(0);
      const original = store.getTurnById(decision.publicationTurnId!);
      expect(original.items[0]!.createdAt).not.toBe(original.startedAt);
      expect(store.getTurnCaptureCoverage(original.id)).toEqual({ scope: 'server', value: 'off' });
      const scope = nativeProductScope(dataRoot, original.owner);
      // Snapshot native revisions, immutable bytes and terminal envelopes before replay.
      const snapshot = () => {
        const turns = db.sqlite.prepare('SELECT * FROM control_turns ORDER BY id').all();
        const entries = db.sqlite
          .prepare('SELECT * FROM control_product_entries ORDER BY turn_id,kind,sequence')
          .all() as Array<{ content_json: string }>;
        const bytes = entries.map((row) => {
          const content = JSON.parse(row.content_json);
          return readRetainedBodyBytes(scope.contentMount.root, content);
        });
        return { turns, entries, bytes };
      };
      const before = snapshot();
      const reopened = new FsStore({ dataRoot });
      reopened.setLiveCaptureCoverage({ scope: 'server', value: 'on' });
      for (let attempt = 0; attempt < 2; attempt++) {
        await recoverPendingRequestsAtBoot(reopened, {
          openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
        });
        expect(snapshot()).toEqual(before);
        expect(reopened.getTurnById(original.id)).toEqual(original);
        expect(reopened.getTurnById(publication.id)).toEqual(publication);
        expect(reopened.getTurnCaptureCoverage(original.id)).toEqual({
          scope: 'server',
          value: 'off',
        });
        expect(readPendingRequest(db.sqlite, 'ap_person_late')).toMatchObject({
          publicationTurnId: original.id,
          invalidationTurnId: publication.id,
          delivery: 'delivered',
        });
      }
      // Contradictory authority must stay inspect-only rather than borrow retained Item content.
      await shutdownControlStoreWorkerClient();
      db.sqlite
        .prepare("UPDATE pending_requests SET decided_at=? WHERE request_id='ap_person_late'")
        .run('2026-10-01T00:00:00.000Z');
      const contradicted = readPendingRequest(db.sqlite, 'ap_person_late')!;
      expect(
        validateCanonicalLoad(
          contradicted,
          reopened.listThreadTurns(contradicted.workspaceId, contradicted.threadId)
        )
      ).not.toBeNull();
      await recoverPendingRequestsAtBoot(reopened, {
        openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
      });
      await expect(
        resolveCommandIntentApproval({
          store: reopened,
          sqlite: db.sqlite,
          record: contradicted,
          decision: 'denied',
          coreDb,
          actor: { kind: 'local', userId: contradicted.responsibleUserId },
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(readPendingRequest(db.sqlite, 'ap_person_late')).toEqual(contradicted);
      expect(snapshot()).toEqual(before);
    } finally {
      clock.mockRestore();
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
  ] as const)('contains delivery and native bookkeeping failures at %s with fault %s', async (site, fault) => {
    const { coreDb, dataRoot, store } = await openPendingApp('agent_demo');
    let submissions = 0;
    let lookup: ReturnType<typeof vi.spyOn> | undefined;
    let outcomeTurnId: string | undefined;
    const settled = Promise.withResolvers<void>();
    const attempted = Promise.withResolvers<void>();
    const releaseFault = Promise.withResolvers<void>();
    const logged = vi.spyOn(console, 'error').mockImplementation((message) => {
      if (
        String(message).startsWith('Outcome delivery for Turn ') ||
        String(message).startsWith('Could not fail outcome Turn ')
      )
        settled.resolve();
    });
    const dependencies = {
      openWorkspace: (workspaceId: string) => openWorkspaceDb(dataRoot, workspaceId),
    };
    let nativeAttempts = 0;
    const apply = store.applyPendingRequestCommand.bind(store);
    const nativeWrite = vi
      .spyOn(store, 'applyPendingRequestCommand')
      .mockImplementation(async (...args) => {
        const command = args[1];
        if (
          'turnId' in command &&
          command.turnId === outcomeTurnId &&
          (command.action === 'delivery-release' || command.action === 'delivery-unknown')
        ) {
          nativeAttempts++;
          if (nativeAttempts === 1) {
            attempted.resolve();
            await releaseFault.promise;
          }
          if (fault === 'permanent' || nativeAttempts === 1)
            throw new Error('Native delivery bookkeeping unavailable');
        }
        return apply(...args);
      });
    const complete = store.completeTurn.bind(store);
    const terminal = vi.spyOn(store, 'completeTurn').mockImplementation(async (...args) => {
      if (args[0] === outcomeTurnId && fault === 'permanent')
        throw new Error('Native terminal bookkeeping unavailable');
      const result = await complete(...args);
      if (args[0] === outcomeTurnId) settled.resolve();
      return result;
    });
    const workerDelivery = {
      async startTurn(_store: FsStore, turnId: string) {
        outcomeTurnId = turnId;
        submissions++;
        if (fault === 'refusal-release')
          throw new TurnStartValidationError('agent_not_found', 'Agent is unavailable.', 409);
        throw new Error('Native submission result unknown');
      },
    };
    installPendingRequestAdmission(store, {
      ...dependencies,
      ...(site === 'terminal-barrier' ? { workerDelivery } : {}),
    });
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Delivery failure',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_delivery_failure', 'failure');
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await raiseRecordedPendingRequest(store, db.sqlite, input);
      // Exclude the live native writer before constructing this retained corruption.
      await shutdownControlStoreWorkerClient();
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET state='resolved', resolution='denied', disposition='denied-not-executed', deciding_actor_kind='user', deciding_actor_id='usr_00000000-0000-7000-8000-000000000001', decided_at=? WHERE request_id=?"
        )
        .run(NOW, input.requestId);
      await store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
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
      if (fault !== 'initial-lookup') {
        await attempted.promise;
        expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe('frozen');
        expect(store.getTurnById(outcomeTurnId!).status).toBe('pending');
        releaseFault.resolve();
      }
      await settled.promise;
      expect(outcomeTurnId).toBeDefined();
      // Slow-stage observations share stderr; this oracle owns delivery messages, not other owners.
      const deliveryLogs = logged.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' &&
          (message.startsWith('Outcome delivery for Turn ') ||
            message.startsWith('Recording the outcome delivery result failed for Turn '))
      );
      expect(deliveryLogs.some((call) => String(call[0]).includes(outcomeTurnId!))).toBe(true);
      if (fault === 'initial-lookup') {
        expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe('frozen');
        expect(store.getTurnById(outcomeTurnId!).status).toBe('pending');
        expect(deliveryLogs[0]?.[0]).toBe(
          `Outcome delivery for Turn ${outcomeTurnId} failed before submission; leaving it for boot resume.`
        );
      } else if (fault !== 'permanent') {
        const refused = fault === 'refusal-release';
        expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe(
          refused ? 'undelivered' : 'delivery-unknown'
        );
        expect(store.getTurnById(outcomeTurnId!)).toMatchObject({
          status: 'failed',
          error: { code: refused ? 'agent_not_found' : 'delivery_unknown' },
        });
        expect(deliveryLogs[0]?.[0]).toBe(
          `Recording the outcome delivery result failed for Turn ${outcomeTurnId}.`
        );
      } else {
        expect(readPendingRequest(db.sqlite, input.requestId)?.delivery).toBe('frozen');
        expect(store.getTurnById(outcomeTurnId!).status).toBe('pending');
      }
      expect(nativeAttempts).toBe(fault === 'initial-lookup' ? 0 : 2);
      expect(
        nativeWrite.mock.calls.some(([, command]) => command.action === 'delivery-prove')
      ).toBe(false);
      if (fault === 'transient') {
        const later = await store.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'Later user message',
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          null,
          { agentId: 'agent_demo' }
        );
        await store.updateTurn(later.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        installPendingRequestAdmission(store, { ...dependencies, workerDelivery });
      }
      expect(submissions).toBe(fault === 'initial-lookup' ? 0 : 1);
    } finally {
      releaseFault.resolve();
      nativeWrite.mockRestore();
      terminal.mockRestore();
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
    const { coreDb, dataRoot, store } = await openPendingApp('agent_demo');
    const dependencies = {
      openWorkspace: (workspaceId: string) => openWorkspaceDb(dataRoot, workspaceId),
    };
    installPendingRequestAdmission(store, dependencies);
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Pending boot admission',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_boot_queue', 'boot');
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await raiseRecordedPendingRequest(store, db.sqlite, input);
      // Exclude the live native writer before constructing this retained corruption.
      await shutdownControlStoreWorkerClient();
      db.sqlite
        .prepare(
          "UPDATE pending_requests SET state='resolved', resolution='denied', disposition='denied-not-executed', deciding_actor_kind='user', deciding_actor_id='usr_00000000-0000-7000-8000-000000000001', decided_at=? WHERE request_id=?"
        )
        .run(NOW, input.requestId);
      await store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
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
      const settled = Promise.withResolvers<void>();
      const publish = store.publishPendingRequestServiceTurn.bind(store);
      const closeout = vi
        .spyOn(store, 'publishPendingRequestServiceTurn')
        .mockImplementation(async (...args) => {
          const result = await publish(...args);
          if (readPendingRequest(db.sqlite, input.requestId)?.delivery === 'closed-out')
            settled.resolve();
          return result;
        });
      onTestFinished(() => closeout.mockRestore());
      const workerDelivery = {
        async startTurn(_store: FsStore, turnId: string) {
          submissions++;
          if (mode === 'agent-removed')
            throw new TurnStartValidationError('agent_not_found', 'Agent is unavailable.', 409);
          await store.applyPendingRequestCommand(input.workspaceId, {
            action: 'delivery-prove',
            workspaceId: input.workspaceId,
            turnId,
            now: new Date().toISOString(),
          });
          settled.resolve();
        },
      };
      installPendingRequestAdmission(store, {
        ...dependencies,
        workerDelivery,
        agentAuthority: () => mode === 'accepted',
      });
      await settled.promise;
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

  it('closes a removed Agent request at the active Turn terminal barrier', async () => {
    const { coreDb, dataRoot, store } = await openPendingApp();
    let current = true;
    installPendingRequestAdmission(store, {
      coreDb,
      agentAuthority: () => current,
      openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
    });
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Request while busy',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      const input = approvalRaise(turn.id, 'ap_agent_barrier', 'barrier');
      await store.createItem({
        id: input.requestItemId,
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await raiseRecordedPendingRequest(store, db.sqlite, input);
      current = false;
      await store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
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

  it('deduplicates an identical call, separates changed arguments, and stops at 16', async () => {
    const { coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Raise approvals',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      // Stopped retained-record fixture; this does not claim native admission or execution.
      await shutdownControlStoreWorkerClient();
      const first = raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_same', 'digest-a'));
      expect(() =>
        raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_same', 'changed-same-id'))
      ).toThrow(/different pending request/);
      // Stopped retained-record fixture; this does not claim native admission or execution.
      await shutdownControlStoreWorkerClient();
      const repeat = raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_other', 'digest-a'));
      // Stopped retained-record fixture; this does not claim native admission or execution.
      await shutdownControlStoreWorkerClient();
      const changed = raisePendingRequest(
        db.sqlite,
        approvalRaise(turn.id, 'ap_changed', 'digest-b')
      );
      expect(first.created).toBe(true);
      expect(repeat).toMatchObject({ created: false, record: { requestId: 'ap_same' } });
      expect(changed).toMatchObject({ created: true, record: { requestId: 'ap_changed' } });
      for (let index = 0; index < 14; index += 1) {
        // Stopped retained-record fixture; this does not claim native admission or execution.
        await shutdownControlStoreWorkerClient();
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

  // Real delivery setup shares gate CPU; the grant, no execution and one Turn remain the oracle.
  it.each([
    'echo',
    'openkit-repository',
  ])('grants a retained %s call whose tool left the supply without executing it and admits one delivering Turn', async (serverId) => {
    const gateway = createDefaultWorkerMcpGateway();
    const callTool = vi.spyOn(gateway, 'callTool');
    const listTools = vi.spyOn(gateway, 'listTools');
    const { app, coreDb, executor, store } = await openPendingApp('agent_demo', gateway);
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Raise one approval',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { agentId: 'agent_demo' }
    );
    await store.createItem({
      id: testEntityId('it', 'it_ap_supply'),
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: 'th_00000000-0000-7000-8000-000000000001',
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
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
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
      await raiseRecordedPendingRequest(store, db.sqlite, raised);
    } finally {
      db.sqlite.close();
    }
    await store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const started = Promise.withResolvers<{ turnId: string; completion: Promise<void> }>();
    const startTurn = executor.startTurn.bind(executor);
    let completion: Promise<void> | undefined;
    let deliveredInput: unknown;
    const execution = vi.spyOn(executor, 'startTurn').mockImplementation((...args) => {
      const inputDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        deliveredInput = JSON.parse(
          frozenPendingOutcomeInput(inputDb.sqlite, args[1], 'approval outcome')
        );
      } finally {
        inputDb.sqlite.close();
      }
      completion = startTurn(...args);
      started.resolve({ turnId: args[1], completion });
      return completion;
    });
    try {
      const responseInput = {
        decision: 'granted',
        requestId: '00000000-0000-4000-8000-000000000701',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      };
      const response = await app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: 'ap_supply' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(responseInput),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const responseBody = await response.json();
      expect(responseBody).toMatchObject({ id: 'ap_supply', status: 'granted' });
      const recorded = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(readPendingRequest(recorded.sqlite, 'ap_supply')).toMatchObject({
          state: 'resolved',
          resolution: 'granted',
          disposition: 'execution-error',
          dispositionReason: 'tool-left-supply',
          claim: 'finished',
          executionCallId: expect.any(String),
        });
        expect(callTool).not.toHaveBeenCalled();
        expect(listTools).not.toHaveBeenCalled();
        const executionCallId = readPendingRequest(recorded.sqlite, 'ap_supply')!.executionCallId;
        const originalExecutionRows = recorded.sqlite
          .prepare('SELECT * FROM capability_calls')
          .all();
        expect(originalExecutionRows).toEqual([
          expect.objectContaining({
            call_id: executionCallId,
            request_id: responseInput.requestId,
            turn_id: turn.id,
            status: 'failed',
          }),
        ]);
        expect(recorded.sqlite.prepare('SELECT * FROM usage_records').all()).toEqual([]);
        const decision = recorded.sqlite
          .prepare(
            'SELECT result, context_summary_json FROM permission_decisions WHERE approval_id = ?'
          )
          .get('ap_supply') as { result: string; context_summary_json: string };
        expect(decision.result).toBe('deny');
        expect(JSON.parse(decision.context_summary_json)).toMatchObject({
          capabilityCallId: executionCallId,
          upstreamContacted: false,
        });
        const replay = await app.request(
          ...operationRequest(
            'approval.respond',
            { approvalRequestId: 'ap_supply' },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(responseInput),
            }
          )
        );
        expect(replay.status, await replay.clone().text()).toBe(200);
        expect(await replay.json()).toEqual(responseBody);
        expect(readPendingRequest(recorded.sqlite, 'ap_supply')!.executionCallId).toBe(
          executionCallId
        );
        expect(recorded.sqlite.prepare('SELECT * FROM capability_calls').all()).toEqual(
          originalExecutionRows
        );
        expect(recorded.sqlite.prepare('SELECT * FROM usage_records').all()).toEqual([]);
        expect(callTool).not.toHaveBeenCalled();
        expect(listTools).not.toHaveBeenCalled();
      } finally {
        recorded.sqlite.close();
      }
      // Admission does not await asynchronous Context Package publication or delivering execution.
      const observed = await started.promise;
      expect(observed.turnId).not.toBe(turn.id);
      await observed.completion;
      await vi.waitFor(() => {
        const deliveredTurn = store
          .listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .find((candidate) => candidate.id !== turn.id);
        expect(deliveredTurn?.status).toBe('completed');
        expect(
          coreDb.sqlite
            .prepare('SELECT phase FROM scheduler_execution_attempts WHERE turn_id = ?')
            .get(deliveredTurn!.id)
        ).toEqual({ phase: 'closed' });
      });
      const outcome = store
        .listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .find((candidate) => candidate.id !== turn.id);
      expect(outcome?.id).toBe(observed.turnId);
      expect(execution).toHaveBeenCalledOnce();
      expect(outcome, outcome?.error?.message).toMatchObject({
        status: 'completed',
        triggerSource: { kind: 'approval-resolution' },
      });
      const delivered = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(readPendingRequest(delivered.sqlite, 'ap_supply')).toMatchObject({
        delivery: 'delivered',
        deliveryTurnId: outcome!.id,
      });
      delivered.sqlite.close();
      expect(
        outcome?.items.filter(
          (item) => item.id === pendingRequestItemId('ap_supply', 'disposition')
        )
      ).toEqual([
        expect.objectContaining({
          type: 'tool-call',
          turnId: outcome!.id,
          id: pendingRequestItemId('ap_supply', 'disposition'),
          causationId: testEntityId('it', 'it_ap_supply'),
          server: serverId,
          tool: serverId === 'echo' ? 'echo' : 'repository_push',
          result: 'execution-error',
          error: 'tool-left-supply',
          arguments: null,
        }),
      ]);
      expect(deliveredInput).toMatchObject({
        pendingOutcomes: [
          {
            requestId: 'ap_supply',
            requestItemId: testEntityId('it', 'it_ap_supply'),
            publicationTurnId: outcome!.id,
            resolution: 'granted',
            disposition: 'execution-error',
            reason: 'tool-left-supply',
          },
        ],
      });
    } finally {
      await completion?.catch(() => undefined);
      execution.mockRestore();
      coreDb.sqlite.close();
    }
  }, 60_000);

  it('answers once, rejects a changed map and a secret question before a write, and withdraws', async () => {
    const { app, coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Ask',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
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
      const pathRequestItem = await store.createItem({
        id: 'it_00000000-0000-730f-baa3-bbcbde464aaa',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        userInputRequestId: 'ui_path',
        prompt: 'Which path?',
        questions: [question],
        createdAt: NOW,
        completedAt: NOW,
      });
      await raiseRecordedPendingRequest(
        store,
        db.sqlite,
        {
          requestId: 'ui_path',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          raisingTurnId: turn.id,
          requestItemId: 'it_00000000-0000-730f-baa3-bbcbde464aaa',
          kind: 'user-input',
          requesterKind: 'assistant',
          responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
          questions: [question],
          questionDigest: 'digest-path',
          now: NOW,
        },
        pathRequestItem
      );
      const secretRequestItem = await store.createItem({
        id: 'it_00000000-0000-7c53-9f67-b4db2e48a984',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        userInputRequestId: 'ui_secret',
        prompt: 'Secret?',
        questions: [{ ...question, id: 'secret', isSecret: true }],
        createdAt: NOW,
        completedAt: NOW,
      });
      await raiseRecordedPendingRequest(
        store,
        db.sqlite,
        {
          requestId: 'ui_secret',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          raisingTurnId: turn.id,
          requestItemId: 'it_00000000-0000-7c53-9f67-b4db2e48a984',
          kind: 'user-input',
          requesterKind: 'assistant',
          responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
          questions: [{ ...question, id: 'secret', isSecret: true }],
          questionDigest: 'digest-secret',
          now: NOW,
        },
        secretRequestItem
      );
    } finally {
      db.sqlite.close();
    }
    await store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const secret = await app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: 'ui_secret' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userInputRequestId: 'ui_secret',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            requestId: '00000000-0000-4000-8000-000000000703',
            answers: { path: ['left'] },
            futureSafeField: 'ignored-command-metadata',
          }),
        }
      )
    );
    expect(answered.status, await answered.clone().text()).toBe(200);
    const persisted = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
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
    const recorded = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
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

  it('settles an unfinished claim to outcome-unknown and does not execute it again', async () => {
    const { coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Claim',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      // Stopped retained-record fixture; this does not claim native admission or execution.
      await shutdownControlStoreWorkerClient();
      raisePendingRequest(db.sqlite, approvalRaise(turn.id, 'ap_crash', 'digest-crash'));
      // Exclude the live native writer before constructing this retained corruption.
      await shutdownControlStoreWorkerClient();
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
    const { app, coreDb, store } = await openPendingApp();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Busy',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
    );
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      await store.createItem({
        id: testEntityId('it', 'it_ap_archive'),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await raiseRecordedPendingRequest(
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
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000706',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          }),
        }
      )
    );
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({ code: 'thread_busy' });
    expect(
      store.getThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ).status
    ).not.toBe('archived');
    await store.updateTurn(turn.id, { status: 'completed', completedAt: NOW });
    const archived = await app.request(
      ...operationRequest(
        'thread.archive',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000707',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          }),
        }
      )
    );
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(
      store.getThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ).status
    ).toBe('archived');
    const recorded = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
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

  it('keeps a contradictory request inspect-only and a sibling request decidable after reload', async () => {
    const { coreDb, dataRoot, store } = await openPendingApp('agent_demo');
    const goodTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Good',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const other = await store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Other');
    const otherTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      other.id,
      'Other',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(db);
    try {
      await store.createItem({
        id: testEntityId('it', 'it_ap_good'),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
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
      await store.createItem({
        id: 'it_00000000-0000-70b9-a8af-9e7514095096',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
      await raiseRecordedPendingRequest(
        store,
        db.sqlite,
        approvalRaise(goodTurn.id, 'ap_good', 'digest-good')
      );
      await raiseRecordedPendingRequest(store, db.sqlite, {
        ...approvalRaise(otherTurn.id, 'ap_bad', 'digest-bad'),
        threadId: other.id,
        requestItemId: 'it_00000000-0000-70b9-a8af-9e7514095096',
        call: {
          ...approvalRaise(otherTurn.id, 'ap_bad', 'digest-bad').call!,
          authorizationContext: {
            threadId: other.id,
            turnId: otherTurn.id,
            agentSessionId: null,
            agentId: 'agent_demo',
            responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
            packageDigest: null,
            policyDecisionId: null,
          },
        },
      });
    } finally {
      db.sqlite.close();
    }
    await store.updateTurn(otherTurn.id, { status: 'completed', completedAt: NOW });
    const decision = {
      owner: otherTurn.owner,
      threadId: other.id,
      turnId: otherTurn.id,
      type: 'approval-decision' as const,
      status: 'completed' as const,
      actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      causationId: 'req_bad_decision',
      approvalRequestId: 'ap_bad',
      decision: 'granted' as const,
      decidedAt: NOW,
      createdAt: NOW,
      completedAt: NOW,
    };
    await store.createItem(
      { ...decision, id: 'it_00000000-0000-75e0-a0f5-4cc89dcbc3d9' },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    await store.createItem(
      {
        ...decision,
        id: 'it_00000000-0000-7a9d-8492-cb28e485aef7',
        causationId: 'req_bad_decision_2',
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    const bad = readPendingRequest(
      openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001').sqlite,
      'ap_bad'
    );
    expect(
      validateCanonicalLoad(
        bad!,
        store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', other.id)
      )?.reason
    ).toBe('two-resolutions');
    await store.updateTurn(goodTurn.id, { status: 'completed', completedAt: NOW });
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

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
