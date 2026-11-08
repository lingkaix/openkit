import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { listOpenThreadPendingRequests, readPendingRequest } from '../runtime/pending-requests.js';
import * as runtimeEvidenceOwner from '../runtime/runtime-evidence.js';
import { importWorkspaceRuntimeEvidence } from '../runtime/runtime-evidence.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  recordTestAgentEnvironmentPackage,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './db.js';

const roots: string[] = [];
const databases: CoreDb[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

async function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-bounded-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, name, undefined, 'conversation', {
    visibility: 'workspace',
  });
  const app = createAppWithWorkspaceAuthority({
    store,
    dataRoot: root,
    agentManifests: [createTestAgentSetup({ agentId: 'agent_demo' }).manifest],
  });
  const coreDb = openCoreDb(root);
  databases.push(coreDb);
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const read = async (operation = 'thread.dashboard', input: unknown = selector) => {
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { response, body: await response.json() };
  };
  return { root, store, thread, app, coreDb, actor, selector, read };
}

it('reads the current step and latest plan without loading complete or sibling histories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-bounded-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Bounded dashboard');
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const first = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'First request', actor);
  const plan = await store.createItem({
    id: allocateEntityId('it'),
    owner: first.owner,
    threadId: thread.id,
    turnId: first.id,
    type: 'plan',
    title: 'Inspect the records',
    summary: null,
    steps: [{ id: 'first', title: 'Inspect the records', status: 'in_progress' }],
    status: 'completed',
    createdAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:00.000Z',
  });
  await store.completeTurn(first.id, {
    status: 'completed',
    completedAt: '2026-11-08T12:01:00.000Z',
  });
  const current = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Continue', actor, null, {
    startedAt: '2026-11-08T12:02:00.000Z',
  });
  const command = await store.createItem({
    id: allocateEntityId('it'),
    owner: current.owner,
    threadId: thread.id,
    turnId: current.id,
    type: 'command-execution',
    command: 'Inspect the selected records',
    cwd: '.',
    output: '',
    exitCode: null,
    durationMs: null,
    status: 'in_progress',
    createdAt: '2026-11-08T12:03:00.000Z',
    completedAt: null,
  });
  const app = createAppWithWorkspaceAuthority({
    store,
    dataRoot: root,
    agentManifests: [createTestAgentSetup({ agentId: 'agent_demo' }).manifest],
  });
  const broad = [
    'listThreadTurns',
    'listThreadItems',
    'listThreads',
    'listArtifacts',
    'listCommandRequests',
  ] as const;
  const reads = broad.map((name) =>
    vi.spyOn(store, name).mockImplementation(() => {
      throw new Error(`Dashboard must not call ${name}.`);
    })
  );
  const response = await app.request('/api/app/operations/thread.dashboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(32_768);
  expect(body.now).toMatchObject({
    turnId: current.id,
    status: 'running',
    step: {
      itemId: command.id,
      kind: 'command-execution',
      title: 'Inspect the selected records',
      startedAt: command.createdAt,
    },
  });
  expect(body.latestPlan).toMatchObject({ id: plan.id, turnId: first.id, type: 'plan' });
  expect(body.turns.every((turn: { items?: unknown[] }) => !turn.items?.length)).toBe(true);
  for (const read of reads) expect(read).not.toHaveBeenCalled();
});

it('reuses Action Center request rows, exact blocking and rank facts after a later admission', async () => {
  const f = await fixture('Shared attention owner');
  const turn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    f.thread.id,
    'Read selected records',
    f.actor,
    null,
    { agentId: 'agent_demo' }
  );
  const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
  try {
    const requestId = crypto.randomUUID();
    await raiseRecordedPendingRequest(f.store, db.sqlite, {
      requestId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: f.thread.id,
      raisingTurnId: turn.id,
      requestItemId: allocateEntityId('it'),
      kind: 'approval',
      requesterKind: 'worker',
      agentId: 'agent_demo',
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
      approval: {
        kind: 'permission',
        title: 'Review the selected action',
        description: 'Read matching records.',
      },
      now: '2026-11-08T12:00:00.000Z',
    });
    await f.store.completeTurn(turn.id, {
      status: 'completed',
      completedAt: '2026-11-08T12:01:00.000Z',
    });
    expect(readPendingRequest(db.sqlite, requestId)).toMatchObject({
      state: 'pending',
      invalidatingEvent: null,
    });
    expect(listOpenThreadPendingRequests(db.sqlite, DEMO_WORKSPACE_ID, f.thread.id)).toHaveLength(
      1
    );
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const dashboard = await f.read();
    const actionCenter = await f.read('attention.list', { workspaceId: DEMO_WORKSPACE_ID });
    expect(dashboard.response.status).toBe(200);
    expect(actionCenter.response.status).toBe(200);
    const expected = actionCenter.body.items.filter(
      (row: { threadId?: string }) => row.threadId === f.thread.id
    );
    expect(dashboard.body.attention.items).toEqual(expected);
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({
      id: `approval:${requestId}`,
      blocking: true,
      turnsSince: 0,
    });
    frozen.mockRestore();
    await f.store.createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'Later admitted work', f.actor);
    const later = await f.read();
    expect(later.body.attention.items[0]).toMatchObject({
      id: `approval:${requestId}`,
      blocking: false,
      turnsSince: 1,
    });
  } finally {
    db.sqlite.close();
  }
});

it('projects only the last recorded environment observation and admitted model without raw evidence or liveness claims', async () => {
  const f = await fixture('Recorded environment');
  const turn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    f.thread.id,
    'Queued work',
    f.actor,
    null,
    { status: 'pending' }
  );
  createSchedulerAdmissionEntry(f.coreDb, {
    queueEntryId: crypto.randomUUID(),
    backendId: 'fixture-backend',
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: f.thread.id,
    turnId: turn.id,
    turnInput: 'Queued work',
    triggerActor: f.actor,
    requestedAgentId: 'agent_demo',
    modelId: 'recorded-model',
  });
  const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
  try {
    const row = {
      id: 'rte_dashboard_previous',
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: f.thread.id,
      turnId: turn.id,
      goalId: null,
      taskId: null,
      agentSessionId: null,
      backendType: 'private-backend-marker',
      backendVersion: null,
      placement: 'local' as const,
      phase: 'sandbox-create' as const,
      summary: 'Private raw evidence marker',
      policyDigest: null,
      workerImage: null,
      sandboxSummary: null,
      capabilitySummary: null,
      uploadManifest: [],
      downloadManifest: [],
      transcriptSummary: null,
      workspaceChangeSummary: null,
      controlSummary: null,
      outcome: 'succeeded' as const,
      exitCode: null,
      signal: null,
      stopReason: null,
      errorCode: null,
      errorMessage: null,
      redactedStdoutSummary: 'Private raw evidence marker',
      redactedStderrSummary: null,
      evidenceBundleIds: [],
      contentDigests: [],
      requiredFeatures: ['runtime.evidence.v1'],
      createdAt: '2026-11-08T12:00:00.000Z',
      startedAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:01.000Z',
      collectedAt: '2026-11-08T12:00:02.000Z',
    };
    importWorkspaceRuntimeEvidence(db, [
      row,
      {
        ...row,
        id: 'rte_dashboard_last',
        phase: 'teardown',
        createdAt: '2026-11-08T12:00:10.000Z',
        completedAt: '2026-11-08T12:00:11.000Z',
        collectedAt: '2026-11-08T12:00:12.000Z',
      },
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-08T12:00:32.000Z'));
    const result = await f.read();
    expect(result.response.status).toBe(200);
    expect(result.body.environment).toMatchObject({
      visibility: 'available',
      model: { id: 'recorded-model', source: 'scheduler-admission' },
      observation: {
        phase: 'teardown',
        outcome: 'succeeded',
        placement: 'local',
        observedAt: '2026-11-08T12:00:12.000Z',
        ageSeconds: 20,
      },
    });
    expect(result.body.environment.observation).not.toHaveProperty('status');
    expect(JSON.stringify(result.body)).not.toContain('Private raw evidence marker');
    expect(JSON.stringify(result.body)).not.toContain('private-backend-marker');
    const actual = policyKernel.evaluateAccess;
    vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
      actual(
        {
          ...policy,
          associations: policy.associations.map((association) => ({
            ...association,
            accessRights: association.accessRights.filter((right) => right !== 'ar:audit-read'),
          })),
        },
        request
      )
    );
    const observationRead = vi.spyOn(runtimeEvidenceOwner, 'readLatestThreadRuntimeObservation');
    const restricted = await f.read();
    expect(restricted.response.status).toBe(200);
    expect(restricted.body.now.turnId).toBe(turn.id);
    expect(restricted.body.environment).toMatchObject({
      observation: null,
      observationAvailability: 'restricted',
    });
    expect(observationRead).not.toHaveBeenCalled();
  } finally {
    db.sqlite.close();
  }
});

it('includes admitted linked Task attention in a Goal while excluding unrelated and private Task sources', async () => {
  const f = await fixture('Goal attention');
  const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
  try {
    const { executeGoalOperation } = await import('../runtime/goal-owner.js');
    const created = await executeGoalOperation(
      'goal.create',
      {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        intent: 'Inspect related Task decisions',
      },
      { actor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID } },
      f.store,
      db
    );
    const goal = created.goal!;
    await executeGoalOperation(
      'goal.cancel',
      {
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: goal.threadId,
        goalId: goal.goalId,
        requestId: crypto.randomUUID(),
        expectedRevision: goal.changeRevision,
        reason: 'Read-only scope fixture',
      },
      { actor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID } },
      f.store,
      db
    );
    const raised: string[] = [];
    const taskIds: string[] = [];
    for (const kind of ['linked', 'unrelated', 'private'] as const) {
      const task = await f.store.createThread(
        DEMO_WORKSPACE_ID,
        `${kind} Task`,
        undefined,
        'conversation',
        kind === 'private'
          ? {
              visibility: 'private',
              privateOwnerUserId: allocateEntityId('usr'),
            }
          : { visibility: 'workspace' }
      );
      taskIds.push(task.id);
      const turn = await f.store.createTurn(
        DEMO_WORKSPACE_ID,
        task.id,
        'Inspect records',
        f.actor,
        null,
        { agentId: 'agent_demo' }
      );
      const requestId = crypto.randomUUID();
      raised.push(requestId);
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: task.id,
        raisingTurnId: turn.id,
        requestItemId: allocateEntityId('it'),
        kind: 'approval',
        requesterKind: 'worker',
        agentId: 'agent_demo',
        responsibleUserId: FIXTURE_LOCAL_USER_ID,
        approval: {
          kind: 'permission',
          title: `${kind} decision`,
          description: 'Review the recorded effect.',
        },
        now: '2026-11-08T12:00:00.000Z',
      });
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: '2026-11-08T12:01:00.000Z',
      });
      if (kind !== 'unrelated') {
        // Retained link fixture proves the attention relationship only, never Task execution admission.
        const link = {
          goalId: goal.goalId,
          cardId: `${kind}-card`,
          threadId: task.id,
          planVersionId: 'recorded-plan',
          cardRevision: 1,
        };
        db.sqlite
          .prepare(
            'INSERT INTO goal_card_tasks(schema_version,thread_id,goal_id,card_id,payload_json) VALUES(1,?,?,?,?)'
          )
          .run(task.id, goal.goalId, link.cardId, JSON.stringify(link));
      }
    }
    const scopedApp = createAppWithWorkspaceAuthority({
      store: f.store,
      coreDb: f.coreDb,
      dataRoot: f.root,
      mode: 'server',
      agentManifests: [createTestAgentSetup({ agentId: 'agent_demo' }).manifest],
      auth: {
        api: { getSession: async () => ({ user: { id: FIXTURE_LOCAL_USER_ID } }) },
        handler: async () => new Response(null, { status: 404 }),
      },
    });
    const readScope = async (operation: string, threadId?: string) => {
      const response = await scopedApp.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...(threadId ? { threadId } : {}) }),
      });
      return { response, body: await response.json() };
    };
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const dashboard = await readScope('thread.dashboard', goal.threadId);
    expect(dashboard.response.status).toBe(200);
    const center = await readScope('attention.list');
    const expected = center.body.items.filter(
      (row: { id: string }) => row.id === `approval:${raised[0]}`
    );
    expect(expected).toHaveLength(1);
    expect(dashboard.body.attention.items).toEqual(expected);
    expect(dashboard.body.attention.items[0]).toMatchObject({
      threadId: taskIds[0],
      blocking: true,
    });
    expect(JSON.stringify(dashboard.body)).not.toContain('private decision');
    expect(JSON.stringify(dashboard.body)).not.toContain(`approval:${raised[1]}`);
    frozen.mockRestore();
    db.sqlite.prepare('DELETE FROM goal_card_tasks WHERE thread_id=?').run(taskIds[0]);
    const unlinked = await readScope('thread.dashboard', goal.threadId);
    expect(unlinked.response.status).toBe(200);
    expect(unlinked.body.attention.items).toEqual([]);
  } finally {
    db.sqlite.close();
  }
});

it('uses current Item revisions for step completion and latest plan without embedding large text', async () => {
  const f = await fixture('Current revisions');
  const turn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    f.thread.id,
    'Inspect the records',
    f.actor
  );
  const item = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: f.thread.id,
    turnId: turn.id,
    type: 'command-execution',
    command: 'Inspect selected records',
    cwd: '.',
    output: '',
    exitCode: null,
    durationMs: null,
    status: 'in_progress',
    createdAt: '2026-11-08T12:00:00.000Z',
    completedAt: null,
  });
  const plan = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: f.thread.id,
    turnId: turn.id,
    type: 'plan',
    title: 'Initial plan',
    summary: null,
    steps: [],
    status: 'completed',
    createdAt: '2026-11-08T12:00:01.000Z',
    completedAt: '2026-11-08T12:00:01.000Z',
  });
  expect((await f.read()).body.now.step.itemId).toBe(item.id);
  await f.store.updateItem(item.id, {
    status: 'completed',
    output: 'Large output marker '.repeat(8000),
    exitCode: 0,
    completedAt: '2026-11-08T12:00:02.000Z',
  });
  await f.store.updateItem(plan.id, { title: 'Revised plan', summary: '界\\"'.repeat(20000) });
  const result = await f.read();
  expect(result.response.status).toBe(200);
  expect(result.body.now).toMatchObject({ step: null, stepsReportedLive: null });
  expect(result.body.latestPlan).toMatchObject({ id: plan.id, type: 'plan' });
  expect(JSON.stringify(result.body.latestPlan)).toContain('Revised plan');
  expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(32768);
  expect(JSON.stringify(result.body)).not.toContain('Large output marker');
  expect(result.body.turns[0].items).toEqual([]);
});

it('uses the exact retained package model preference and refuses a package from another Turn', async () => {
  const f = await fixture('Recorded model package');
  const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
  try {
    const pkg = await recordTestAgentEnvironmentPackage(db, {
      coreDb: f.coreDb,
      suffix: 'dashboard-model',
      triggerActor: f.actor,
      threadId: f.thread.id,
      workspaceInputIds: [],
    });
    await f.store.createAgentSession({
      id: pkg.scope.agentSessionId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: f.thread.id,
      agentId: pkg.agent.agentId,
      status: 'busy',
      message: null,
      environmentPackageSnapshotId: pkg.snapshotId,
      createdAt: '2026-11-08T12:00:00.000Z',
      updatedAt: '2026-11-08T12:00:00.000Z',
    });
    await f.store.createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'Recorded preference', f.actor, null, {
      turnId: pkg.scope.turnId,
      agentSessionId: pkg.scope.agentSessionId,
      agentId: pkg.agent.agentId,
    });
    const result = await f.read();
    expect(result.response.status).toBe(200);
    expect(result.body.environment.model).toEqual({
      id: pkg.llm.preferredLogicalModelId,
      source: 'package-preference',
    });
    const { recordAgentEnvironmentPackageSnapshot } = await import(
      '../runtime/aep-snapshot-ledger.js'
    );
    const foreign = {
      ...pkg,
      snapshotId: `${pkg.snapshotId}_foreign`,
      scope: { ...pkg.scope, turnId: allocateEntityId('tu') },
    };
    recordAgentEnvironmentPackageSnapshot(db, {
      environmentPackage: foreign,
      createdAt: '2026-11-08T12:02:00.000Z',
    });
    await f.store.updateAgentSession(pkg.scope.agentSessionId, {
      environmentPackageSnapshotId: foreign.snapshotId,
    });
    const later = await f.read();
    expect(later.response.status).toBe(200);
    expect(later.body.environment.model).toBeNull();
    expect(later.body.environment.observation).toBeNull();
  } finally {
    db.sqlite.close();
  }
});

it('uses the same exact current Artifact Review rows as Action Center', async () => {
  const f = await fixture('Artifact Review source');
  const turn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    f.thread.id,
    'Publish output',
    f.actor,
    null,
    { agentId: 'agent_demo' }
  );
  const { createHash } = await import('node:crypto');
  const { createArtifactReview } = await import('../artifact-reviews.js');
  const artifact = await f.store.createArtifact({
    id: allocateEntityId('ar'),
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: f.thread.id,
    turnId: turn.id,
    kind: 'summary',
    title: 'Selected output',
    summary: 'Review these exact bytes',
    status: 'ready',
    version: 1,
    content: { format: 'markdown', body: 'Selected output bytes' },
    contentDigest: `sha256:${createHash('sha256').update('Selected output bytes').digest('hex')}`,
    lastMutationRequestId: 'dashboard-review',
    origin: {
      kind: 'turn-output',
      threadId: f.thread.id,
      turnId: turn.id,
      requestId: 'dashboard-review',
    },
    createdAt: '2026-11-08T12:00:00.000Z',
    updatedAt: '2026-11-08T12:00:00.000Z',
  });
  const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
  try {
    const review = createArtifactReview(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      contentDigest: artifact.contentDigest,
      sourceThreadId: f.thread.id,
      sourceTurnId: turn.id,
      sourceAgentId: 'agent_demo',
      materialProposal: null,
      createdAt: '2026-11-08T12:00:00.000Z',
    });
    const result = await f.read();
    const center = await f.read('attention.list', { workspaceId: DEMO_WORKSPACE_ID });
    expect(result.response.status).toBe(200);
    expect(center.response.status).toBe(200);
    const rows = center.body.items.filter(
      (row: { id: string }) => row.id === `artifact-review:${review.reviewId}`
    );
    expect(rows).toHaveLength(1);
    expect(result.body.attention.items).toEqual(rows);
    expect(result.body.artifacts).toMatchObject([{ id: artifact.id }]);
  } finally {
    db.sqlite.close();
  }
});

it('keeps exact approval effects when they fit and refuses oversized detail without losing attention', async () => {
  const f = await fixture('Bounded exact decision detail');
  const turn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    f.thread.id,
    'Review effects',
    f.actor,
    null,
    { agentId: 'agent_demo' }
  );
  const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
  try {
    const requestIds: string[] = [];
    for (const size of [128, 40_000]) {
      const requestId = crypto.randomUUID();
      requestIds.push(requestId);
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: f.thread.id,
        raisingTurnId: turn.id,
        requestItemId: allocateEntityId('it'),
        kind: 'approval',
        requesterKind: 'worker',
        agentId: 'agent_demo',
        responsibleUserId: FIXTURE_LOCAL_USER_ID,
        governedIntent: { operation: 'fixture.exact-effect', content: 'x'.repeat(size) },
        approval: {
          kind: 'permission',
          title: 'Review exact effect',
          description: 'Inspect the effect.',
        },
        now: '2026-11-08T12:00:00.000Z',
      });
    }
    const result = await f.read();
    expect(result.response.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(32768);
    const small = result.body.pendingRequests.find(
      (row: { requestId: string }) => row.requestId === requestIds[0]
    );
    expect(small.approvalEffect.status).toBe('available');
    expect(JSON.parse(small.approvalEffect.detail)).toEqual({
      operation: 'fixture.exact-effect',
      content: 'x'.repeat(128),
    });
    const large = result.body.pendingRequests.find(
      (row: { requestId: string }) => row.requestId === requestIds[1]
    );
    expect(large.approvalEffect).toEqual({
      status: 'unavailable',
      reason: 'Complete exact effect exceeds the dashboard detail limit.',
    });
    expect(result.body.attention.items.map((row: { id: string }) => row.id).sort()).toEqual(
      requestIds.map((id) => `approval:${id}`).sort()
    );
    expect(readPendingRequest(db.sqlite, requestIds[1]!)!.governedIntent!.content).toBe(
      'x'.repeat(40_000)
    );
  } finally {
    db.sqlite.close();
  }
});
