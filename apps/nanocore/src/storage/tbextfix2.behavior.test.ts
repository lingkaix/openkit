import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationTargetCatalogSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, type Item } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHumanAttention, readScopedHumanAttention } from '../action-center.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** Publishes real identity, Workspace and membership state without retained SQL fixtures. */
async function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tbextfix2-behavior-'));
  const coreDb = createTestCoreDb(root);
  const handles: WorkspaceDb[] = [];
  cleanups.push(() => disposeTestStore(root, ...handles, coreDb));
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root, knowledge: [] });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  return { root, coreDb, store, userId, handles };
}

/** Uses the existing scheduler/adoption builder; its external peer is not an installed-adapter qualification. */
async function liveWorkerFixture() {
  const f = await workspaceFixture();
  const manifest = createTestAgentSetup({
    adapter: 'codex',
    imageRef: `sha256:${'a'.repeat(64)}`,
    requiredCapabilities: ['trusted-worker-inference-relay'],
  }).manifest;
  manifest.runtime.version = '0.166.0';
  admitTestNativeEnvironment(f.coreDb, manifest);
  const admission = new WorkspaceMutationAdmission();
  const configuration = createInMemoryRuntimeConfigSnapshot({
    ...loadRuntimeConfig(f.root),
    agentManifests: [manifest],
    gatewayConfig: createTestGatewayConfig(),
    openKitConfig: { defaults: { defaultAgentId: manifest.id } },
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Independent availability fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
  });
  const native = await createNativeTaskAdmissionFixture(f.coreDb, f.store, {
    readRuntimeConfig: () => configuration,
    workspaceMutationAdmission: admission,
  });
  let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
  cleanups.push(async () => {
    await admitted?.cleanup();
    await native.restore();
  });
  const requestId = randomUUID();
  const turnId = allocateEntityId('tu');
  const actor = { kind: 'user', id: f.userId } as const;
  const scope = { workspaceId: DEMO_WORKSPACE_ID, threadId: DEMO_THREAD_ID, actorId: f.userId };
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    requestId,
    queueEntryId: `tbextfix2-original-${turnId}`,
    requestedAgentId: manifest.id,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: DEMO_THREAD_ID,
    turnId,
    turnInput: 'Original admitted Task',
    triggerActor: actor,
  });
  const timestamp = new Date().toISOString();
  // The original Store publisher owns the Turn and its command acknowledgement.
  await f.store.createTurn(entry.workspaceId, entry.threadId, entry.turnInput, actor, undefined, {
    turnId,
    status: 'pending',
    agentId: manifest.id,
    executorKind: 'worker',
    commandReceipt: {
      key: commandRequestKey('turn.start', requestId, scope),
      command: 'turn.start',
      requestId,
      scope,
      inputHash: commandInputHash({ queueEntryId: entry.queueEntryId, turnInput: entry.turnInput }),
      responseKind: 'turn',
      createdAt: timestamp,
      expiresAt: commandRequestExpiresAt(timestamp),
    },
  });
  const agentSessionId = allocateEntityId('as');
  admitted = await native.admitTurn(entry, {
    attemptId: testEntityId('attempt', `tbextfix2-${turnId}`),
    agentSessionId,
    candidateAgentSessionId: agentSessionId,
  });
  const app = createAppWithLocalIdentity({
    coreDb: f.coreDb,
    store: f.store,
    dataRoot: f.root,
    mode: 'server',
    workspaceMutationAdmission: admission,
    agentManifests: [manifest],
    gatewayConfig: configuration.gatewayConfig,
    providerRegistry: configuration.providerRegistry,
    openKitConfig: configuration.openKitConfig,
    turnExecutor: native.executor,
  });
  return { ...f, app, turnId, agentSessionId };
}

describe('Independent TB-EXT items 6 and 7 regressions', () => {
  it('W1 denies readonly caller live-steer availability while the same writable target remains available', async () => {
    const f = await liveWorkerFixture();
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const writable = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: expiry,
    });
    const readonly = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace-readonly',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: expiry,
    });
    const target = { workspaceId: DEMO_WORKSPACE_ID, threadId: DEMO_THREAD_ID };
    const before = f.store.getTurnById(f.turnId);
    const writableResponse = await f.app.request(
      ...operationRequest('conversation.targets', target, {
        headers: { authorization: `Bearer ${writable.secret}` },
      })
    );
    expect(writableResponse.status).toBe(200);
    const writableCatalog = ConversationTargetCatalogSchema.parse(await writableResponse.json());
    const writableTarget = writableCatalog.targets.find((row) => row.kind === 'running-worker');
    // TB-EXT item 6: do not fix the negative by disabling every qualified target.
    expect(writableTarget).toMatchObject({
      threadId: DEMO_THREAD_ID,
      activeTurnId: f.turnId,
      steerAvailability: 'available',
      steerUnavailableReason: null,
    });
    const readonlyResponse = await f.app.request(
      ...operationRequest('conversation.targets', target, {
        headers: { authorization: `Bearer ${readonly.secret}` },
      })
    );
    expect(readonlyResponse.status).toBe(200);
    const readonlyCatalog = ConversationTargetCatalogSchema.parse(await readonlyResponse.json());
    const readonlyTarget = readonlyCatalog.targets.find(
      (row) => row.targetRef === writableTarget!.targetRef
    );
    expect(readonlyTarget).toMatchObject({
      kind: 'running-worker',
      threadId: DEMO_THREAD_ID,
    });
    const positiveAgain = await f.app.request(
      ...operationRequest('conversation.targets', target, {
        headers: { authorization: `Bearer ${writable.secret}` },
      })
    );
    expect(positiveAgain.status).toBe(200);
    const stillLive = ConversationTargetCatalogSchema.parse(await positiveAgain.json());
    expect(
      stillLive.targets.find((row) => row.targetRef === writableTarget!.targetRef)
    ).toMatchObject({ activeTurnId: f.turnId, steerAvailability: 'available' });
    const denied = await f.app.request(
      ...operationRequest(
        'task.steer',
        { ...target, turnId: f.turnId },
        {
          headers: { authorization: `Bearer ${readonly.secret}` },
          body: JSON.stringify({ requestId: randomUUID(), input: 'Do not admit this instruction' }),
        }
      )
    );
    expect(denied.status).toBe(403);
    expect(f.store.getTurnById(f.turnId)).toEqual(before);
    // TB-EXT item 6: current turn.run admission precedes runtime support, including credential write restrictions.
    expect(
      readonlyTarget!.steerAvailability,
      'A caller refused by task.steer must not be offered available live input'
    ).not.toBe('available');
    expect(readonlyTarget!.steerUnavailableReason).toEqual(expect.any(String));
    expect(readonlyTarget!.steerUnavailableReason!.length).toBeGreaterThan(0);
    expect(JSON.stringify(readonlyTarget)).not.toContain(f.agentSessionId);
  }, 30_000);

  it('W2 clips the actual question to an exact prefix including leading U+FEFF within 1024 JSON bytes', async () => {
    const f = await workspaceFixture();
    const workspaceDb = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
    f.handles.push(workspaceDb);
    const thread = await f.store.createThread(DEMO_WORKSPACE_ID, 'Exact question prefix');
    const actor = { kind: 'user', id: f.userId } as const;
    const turn = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      thread.id,
      'Original Task input',
      actor,
      null,
      { agentId: 'agent_demo', startedAt: '2026-11-11T10:00:00.000Z' }
    );
    const requestId = randomUUID();
    const original = `\uFEFF${'a'.repeat(1100)}`;
    const questions = [
      {
        id: 'exact-prefix',
        header: 'Not the question text',
        question: original,
        options: [{ label: 'Continue', description: 'Not the question text either' }],
        isOther: true,
        isSecret: false,
      },
    ];
    const requestedAt = '2026-11-11T10:05:00.000Z';
    const item: Extract<Item, { type: 'user-input-request' }> = {
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: f.userId,
      userInputRequestId: requestId,
      prompt: 'Generic metadata is not the source question.',
      questions,
      createdAt: requestedAt,
      completedAt: requestedAt,
    };
    await raiseRecordedPendingRequest(
      f.store,
      workspaceDb.sqlite,
      {
        requestId,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        raisingTurnId: turn.id,
        requestItemId: item.id,
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: f.userId,
        questions,
        questionDigest: commandInputHash(questions),
        now: requestedAt,
      },
      item
    );
    const retainedItem = f.store.getTurnById(turn.id).items.find((row) => row.id === item.id);
    expect(retainedItem?.type).toBe('user-input-request');
    if (retainedItem?.type !== 'user-input-request') throw new Error('Missing real request Item');
    const retained = retainedItem.questions[0]!.question;
    expect(retained).toBe(original);
    expect(Buffer.byteLength(JSON.stringify(retained))).toBeGreaterThan(1024);
    const viewer = { kind: 'local', userId: f.userId } as const;
    const input = {
      store: f.store,
      coreDb: f.coreDb,
      workspaceDb,
      workspaceId: DEMO_WORKSPACE_ID,
      actor: viewer,
      administratorEligible: isCurrentDeploymentAdministrator(f.coreDb, viewer),
    };
    const full = readHumanAttention({
      ...input,
      repositoryWorkspaceDb: () => openWorkspaceDb(f.root, DEMO_WORKSPACE_ID),
    }).items.find((row) => row.id === `question:${requestId}`);
    const scoped = readScopedHumanAttention({ ...input, threadIds: [thread.id] }).items.find(
      (row) => row.id === `question:${requestId}`
    );
    expect(full).toMatchObject({ threadId: thread.id, turnId: turn.id, itemId: item.id });
    expect(scoped).toBeDefined();
    expect(scoped!.questionSummary).toEqual(full!.questionSummary);
    const summary = full!.questionSummary;
    expect(summary).not.toBeNull();
    expect(summary!.truncated).toBe(true);
    expect(summary!.text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(summary!.text))).toBeLessThanOrEqual(1024);
    // TB-EXT item 7: clipping preserves actual Unicode/whitespace; it cannot rewrite the source prefix.
    expect(
      retained.startsWith(summary!.text),
      'Clipped text must be an exact prefix of the retained question, including its leading U+FEFF'
    ).toBe(true);
    expect(summary!.text.startsWith('\uFEFF')).toBe(true);
  }, 30_000);
});
