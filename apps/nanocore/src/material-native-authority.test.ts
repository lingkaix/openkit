import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonOperationId } from '@openkit/app-api-schemas';
import { allocateEntityId, deriveEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { createArtifactReview, getArtifactReview } from './artifact-reviews.js';
import { initializeDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import { readWorkerContextPackageTrace } from './context/worker-context-package.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import {
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  workerBackendLineageFromRuntimeImage,
} from './runtime/worker-backend-sessions.js';
import {
  createWorkerCheckpointContextDiagnostics,
  upsertWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import {
  acceptPreparedWorkerTurnContextPackage,
  prepareWorkerTurnContextPackage,
} from './runtime/worker-governance-turn-executor.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './runtime/workspace-materializer.js';
import { recordWorkspaceBackendHandoff } from './runtime/workspace-sync-records.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { selectQueuedThreadMaterialRevision } from './workspace-materials.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Computes the digest independently from the command and revision owners. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Real public invocation, native Store and private SQLite; no test transaction surrounds commands. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'material-native-authority-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  let store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Material commands');
  const thread = await store.createThread(workspace.id, 'Bound source');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  let db = openWorkspaceDb(root, workspace.id);
  let readOnlyMain = false;
  const entry = { kind: 'public', actor: { kind: 'session', userId } } as const;
  const compose = () =>
    createOperationInvocation({
      coreDb,
      store,
      dataRoot: root,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      repositoryWorkspaceDb: (id) => {
        const handle = openWorkspaceDb(root, id);
        if (readOnlyMain) {
          // Connection-local read authority: the real native worker's connection remains writable.
          handle.sqlite.pragma('query_only = ON');
          expect(handle.sqlite.pragma('query_only', { simple: true })).toBe(1);
        }
        return handle;
      },
    });
  let invoke = compose();
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeRetrievalServices();
    if (db.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    coreDb,
    workspace,
    thread,
    userId,
    get store() {
      return store;
    },
    get db() {
      return db;
    },
    call: <K extends JsonOperationId>(id: K, input: object) =>
      invoke(id, { workspaceId: workspace.id, ...input }, entry),
    readersOnly() {
      readOnlyMain = true;
    },
    snapshot() {
      return {
        materials: db.sqlite
          .prepare('SELECT * FROM workspace_materials ORDER BY material_id')
          .all(),
        revisions: db.sqlite
          .prepare('SELECT * FROM workspace_material_revisions ORDER BY revision_id')
          .all(),
        bindings: db.sqlite
          .prepare('SELECT * FROM thread_material_bindings ORDER BY thread_id, material_id')
          .all(),
        reviews: db.sqlite
          .prepare('SELECT * FROM artifact_reviews ORDER BY artifact_id, artifact_version')
          .all(),
        receipts: db.sqlite
          .prepare('SELECT * FROM idempotency_requests ORDER BY request_key')
          .all(),
      };
    },
    abortReceipt() {
      db.sqlite.exec(`CREATE TRIGGER refuse_material_receipt BEFORE INSERT ON idempotency_requests
        WHEN NEW.request_id = 'tested-command'
        BEGIN SELECT RAISE(ABORT, 'private fixture receipt abort'); END`);
    },
    allowReceipt() {
      db.sqlite.exec('DROP TRIGGER refuse_material_receipt');
    },
    async reopen() {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      store = new FsStore({ dataRoot: root });
      db = openWorkspaceDb(root, workspace.id);
      invoke = compose();
    },
  };
}

const commands = [
  'material.create',
  'material.revision-save',
  'material.bind',
  'material.unbind',
  'material.exclude',
  'material.restore',
  'evaluation.judgement-add',
  'material.range-correct',
] as const;

it.each(
  commands
)('%s commits its full tuple and original receipt with Main restricted to reads', async (command) => {
  const f = await fixture();
  const { materialId } = await f.call('material.create', {
    requestId: 'seed-material',
    title: 'Original source',
    kind: 'text',
    sensitivity: 'internal',
  });
  const content = 'Original source\n';
  const { revisionId } = await f.call('material.revision-save', {
    materialId,
    requestId: 'seed-revision',
    expectedRevisionId: null,
    content,
    contentDigest: digest(content),
  });
  const threadId = f.thread.id;
  await f.call('material.bind', {
    materialId,
    threadId,
    requestId: 'seed-binding',
    expectedBindingState: 'not_bound',
  });
  if (command === 'material.bind') {
    await f.call('material.unbind', {
      materialId,
      threadId,
      requestId: 'seed-unbinding',
      expectedBindingState: 'bound',
    });
  }
  if (command === 'material.restore') {
    await f.call('material.exclude', {
      materialId,
      threadId,
      requestId: 'seed-exclusion',
      expectedBindingState: 'bound',
      expectedInclusionState: 'included',
      expectedQueuedRevisionId: revisionId,
    });
  }
  const target = {
    kind: 'material-range',
    materialId,
    revisionId,
    contentDigest: digest(content),
    start: 0,
    end: 8,
    originalText: 'Original',
  };
  const input = {
    'material.create': { title: 'New source', kind: 'text', sensitivity: 'internal' },
    'material.revision-save': {
      materialId,
      expectedRevisionId: revisionId,
      content: 'Revised source\n',
      contentDigest: digest('Revised source\n'),
    },
    'material.bind': { materialId, threadId, expectedBindingState: 'not_bound' },
    'material.unbind': { materialId, threadId, expectedBindingState: 'bound' },
    'material.exclude': {
      materialId,
      threadId,
      expectedBindingState: 'bound',
      expectedInclusionState: 'included',
      expectedQueuedRevisionId: revisionId,
    },
    'material.restore': {
      materialId,
      threadId,
      expectedBindingState: 'bound',
      expectedInclusionState: 'excluded',
    },
    'evaluation.judgement-add': {
      judgement: {
        kind: 'rate',
        target,
        choice: { value: 2, lowerBound: 1, upperBound: 3 },
        note: 'Human assessment',
      },
    },
    'material.range-correct': { target, replacementText: 'Corrected', decision: 'apply' },
  }[command];
  const request = { ...input, requestId: 'tested-command' };
  const before = f.snapshot();
  f.abortReceipt();
  await expect(f.call(command, request)).rejects.toThrow();
  expect(f.snapshot(), 'receipt abort rolls back every owned row').toEqual(before);
  await f.reopen();
  expect(f.snapshot(), 'no partial tuple survives cold reopen').toEqual(before);
  f.allowReceipt();
  f.readersOnly();
  const result = await Promise.allSettled([f.call(command, request)]);
  expect(result, 'the native writer must acknowledge without a Main write').toEqual([
    { status: 'fulfilled', value: expect.any(Object) },
  ]);
  if (result[0]!.status !== 'fulfilled') throw new Error('Missing acknowledged Material outcome');
  const response = result[0]!.value;
  const receipts = f.db.sqlite
    .prepare(
      'SELECT command_name, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
    )
    .all(request.requestId);
  const durableCommand = command === 'material.revision-save' ? 'material.save' : command;
  const expectedResponseKind =
    command === 'material.create'
      ? 'material'
      : command === 'material.revision-save'
        ? 'material_revision'
        : command === 'evaluation.judgement-add' || command === 'material.range-correct'
          ? 'evaluation_judgement'
          : 'thread_material_binding';
  const expectedResponseId =
    'revisionId' in response
      ? response.revisionId
      : 'materialId' in response
        ? response.materialId
        : request.requestId;
  expect(receipts).toEqual([
    {
      command_name: durableCommand,
      response_kind: expectedResponseKind,
      response_id: expectedResponseId,
    },
  ]);
  if (command === 'material.create') {
    expect(f.snapshot().materials).toHaveLength(before.materials.length + 1);
    expect(await f.call('material.read', { materialId: expectedResponseId })).toMatchObject({
      material: { title: 'New source', currentRevisionId: null },
    });
  } else if (command === 'material.revision-save' || command === 'material.range-correct') {
    const { material } = await f.call('material.read', { materialId });
    expect(material.currentRevisionId).not.toBe(revisionId);
    const { revision } = await f.call('material.revision-read', {
      materialId,
      revisionId: material.currentRevisionId,
    });
    expect(revision).toMatchObject({
      parentRevisionId: revisionId,
      content: command === 'material.range-correct' ? 'Corrected source\n' : 'Revised source\n',
    });
    expect(revision.contentDigest).toBe(digest(revision.content));
    if (command === 'material.range-correct') {
      expect(response).toMatchObject({
        judgement: {
          kind: 'correct',
          choice: {
            outcome: 'apply',
            resultingRevision: {
              materialId,
              revisionId: revision.revisionId,
              contentDigest: revision.contentDigest,
            },
          },
        },
      });
    }

    expect(f.snapshot().revisions).toHaveLength(before.revisions.length + 1);
    expect(
      f.db.sqlite
        .prepare(
          'SELECT latest_queued_revision_id FROM thread_material_bindings WHERE thread_id = ?'
        )
        .get(threadId)
    ).toEqual({ latest_queued_revision_id: revision.revisionId });
  } else if (command !== 'evaluation.judgement-add') {
    expect(
      f.db.sqlite
        .prepare(
          'SELECT binding_state, inclusion_state, latest_queued_revision_id FROM thread_material_bindings WHERE thread_id = ?'
        )
        .get(threadId)
    ).toEqual({
      binding_state: command === 'material.unbind' ? 'unbound' : 'bound',
      inclusion_state: command === 'material.exclude' ? 'excluded' : 'included',
      latest_queued_revision_id: command === 'material.unbind' ? null : revisionId,
    });
  }
  if (command === 'evaluation.judgement-add' || command === 'material.range-correct') {
    expect(await f.call('material.revision-read', { materialId, revisionId })).toMatchObject({
      revision: {
        content,
        judgements: [expect.objectContaining({ requestId: request.requestId, target })],
      },
    });
  }
  const acknowledged = f.snapshot();
  await f.reopen();
  expect(await f.call(command, request)).toEqual(response);
  expect(await f.call(command, request)).toEqual(response);
  expect(f.snapshot(), 'cold replay must not add a tuple or second receipt').toEqual(acknowledged);
  if (command === 'material.bind') {
    const other = await f.store.createThread(f.workspace.id, 'First binding');
    const freshRequest = {
      materialId,
      threadId: other.id,
      requestId: 'new-binding',
      expectedBindingState: 'not_bound',
    };
    expect(await f.call('material.bind', freshRequest)).toMatchObject({
      materialId,
      threadId: other.id,
      outcome: 'bound',
    });
    expect(
      f.db.sqlite
        .prepare(
          'SELECT latest_queued_revision_id FROM thread_material_bindings WHERE thread_id = ?'
        )
        .get(other.id)
    ).toEqual({ latest_queued_revision_id: revisionId });
    expect(
      f.db.sqlite
        .prepare(
          'SELECT response_id FROM idempotency_requests WHERE command_name = ? AND request_id = ?'
        )
        .all('material.bind', freshRequest.requestId)
    ).toEqual([{ response_id: materialId }]);
  }
});

/** Prepares real package bytes and owner records; backend materialization evidence is fixture input. */
async function preparedMaterial() {
  const f = await fixture();
  const { materialId } = await f.call('material.create', {
    requestId: 'source',
    title: 'Worker source',
    kind: 'text',
    sensitivity: 'internal',
  });
  const content = 'Original source\n';
  const { revisionId } = await f.call('material.revision-save', {
    materialId,
    requestId: 'source-revision',
    expectedRevisionId: null,
    content,
    contentDigest: digest(content),
  });
  await f.call('material.bind', {
    materialId,
    threadId: f.thread.id,
    requestId: 'bind-worker',
    expectedBindingState: 'not_bound',
  });
  const requestId = 'worker-context';
  const workerRequest = JSON.stringify({
    schemaVersion: 1,
    objective: 'Review the source.',
    acceptanceCriteria: ['Review the exact original.'],
    contextRefs: [{ kind: 'workspace', id: f.workspace.id }],
    resources: [],
    expectedArtifacts: [],
    constraints: { maxContextTokens: 12000, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Review source' }],
    reviewPolicy: { required: true, reviewers: ['human'], instructions: 'Review the proposal.' },
    escalationConditions: [],
    reviewContext: null,
  });
  const actor = { kind: 'user', id: f.userId } as const;
  const created = await f.store.createTurn(f.workspace.id, f.thread.id, workerRequest, actor);
  const agentSessionId = allocateEntityId('as');
  const timestamp = created.startedAt!;
  const now = () => timestamp;
  const agentSetup = createTestAgentSetup();
  await f.store.createAgentSession({
    id: agentSessionId,
    agentId: agentSetup.manifest.id,
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    status: 'ready',
    message: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const turn = await f.store.updateTurn(created.id, {
    agentId: agentSetup.manifest.id,
    agentSessionId,
  });
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
    deploymentId: 'fixture-deployment',
    identityId: 'fixture-host',
    observedAt: timestamp,
    targetId: 'fixture-target',
  });
  upsertNanoHostRuntimeTarget(f.coreDb, {
    ...target,
    freshEmpty: true,
    observedAt: timestamp,
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    triggerActor: actor,
    profileRef: 'profile_worker',
    queueEntryId: `queue_${turn.id}`,
    requestId,
    requestedAgentId: agentSetup.manifest.id,
    threadId: f.thread.id,
    turnId: turn.id,
    turnInput: workerRequest,
    workspaceId: f.workspace.id,
    now,
  });
  const attemptId = allocateEntityId('attempt');
  const bindingRef = `fixture-binding:${turn.id}`;
  recordTestExecutionAttempt(f.coreDb, {
    entry,
    attemptId,
    agentSessionId,
    inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
    bindingRef,
    sessionCompatibilityKey: 'fixture-context',
    now,
  });
  const checkpoint = upsertWorkerCheckpoint(f.db, {
    // S39 retains historical Goal/Task lineage without requiring a still-live Goal owner.
    goalId: 'goal_material_context',
    taskId: 'task_material_context',
    iteration: 0,
    requestId,
    requestInputHash: commandInputHash({}),
    stage: 'preparing',
    threadId: f.thread.id,
    turnId: turn.id,
    workspaceId: f.workspace.id,
    diagnosticsSummary: createWorkerCheckpointContextDiagnostics({
      contextDigest: commandInputHash(workerRequest),
      contextRefs: [],
      knowledgeSelectionInput: null,
    }),
  });
  const admission = new FileStorageAdmission(f.root, () => 0n);
  const preparedContext = await prepareWorkerTurnContextPackage(
    f.coreDb,
    f.db,
    f.store,
    checkpoint,
    {
      agentSessionId,
      workerRequest,
      requestId,
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: turn.id,
    },
    admission
  );
  const resolvedPackage = resolveAgentEnvironmentPackage({
    coreDb: f.coreDb,
    agentSetup,
    agentSessionId,
    triggerActor: actor,
    backend: { kind: 'openshell' },
    createdAt: timestamp,
    requestId,
    turn,
    turnInput: workerRequest,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
    preparedContextPackage: preparedContext.preparedContextPackage,
  });
  const environmentPackage = {
    ...resolvedPackage,
    scope: { ...resolvedPackage.scope, itemId: deriveEntityId('it', ['task-user', turn.id]) },
  };
  await f.store.updateAgentSession(agentSessionId, {
    environmentPackageSnapshotId: environmentPackage.snapshotId,
  });
  await f.store.createItem({
    id: deriveEntityId('it', ['task-user', turn.id]),
    owner: { kind: 'workspace', workspaceId: f.workspace.id },
    threadId: f.thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: workerRequest,
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  });
  await recordAgentEnvironmentPackageSnapshot(f.db, { environmentPackage, createdAt: timestamp });
  const backendSessionId = `fixture-session-${agentSessionId}`;
  recordWorkerBackendSessionMaterializing(f.coreDb, {
    identity: {
      agentSessionId,
      backendKind: 'openshell',
      backendSessionId,
      deploymentId: 'fixture-deployment',
      packageSnapshotId: environmentPackage.snapshotId,
      runtimeTargetId: 'fixture-target',
      stagingDirectoryRef: `staging/${agentSessionId}`,
      transientProviderInstanceId: null,
    },
    backendVersion: '1.0.0',
    backendLineage: workerBackendLineageFromRuntimeImage(environmentPackage.runtime.image),
    lineage: { workspaceId: f.workspace.id, threadId: f.thread.id, turnId: turn.id },
    sandboxBindingRef: bindingRef,
    now,
  });
  const snapshots = buildWorkspaceInputSnapshots({
    backendKind: 'openshell',
    backendCapabilities: environmentPackage.backend.requiredCapabilities,
    createdAt: timestamp,
    environmentPackage,
  });
  const materializations = buildWorkspaceMaterializationRecords({
    createdAt: timestamp,
    inputSnapshots: snapshots,
    materialization: {
      backendKind: 'openshell',
      packageSnapshotId: environmentPackage.snapshotId,
      workspaceInputs: environmentPackage.workspace.inputs.map(({ id, target }) => ({
        id,
        target,
      })),
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      backendStatus: { health: 'ready', version: '1.0.0' },
      sandbox: { name: backendSessionId, state: 'created' },
    },
  });
  recordWorkspaceBackendHandoff(f.db, snapshots, materializations);
  markWorkerBackendWorkspaceHandoffComplete(f.coreDb, { attemptId, now });
  return {
    f,
    materialId,
    revisionId,
    content,
    turn,
    admission,
    environmentPackage,
    preparedContext,
    accept: () =>
      Promise.resolve().then(() =>
        acceptPreparedWorkerTurnContextPackage({
          coreDb: f.coreDb,
          store: f.store,
          workspaceDb: f.db,
          environmentPackage,
          preparedContext,
        })
      ),
    verify: () =>
      readWorkerContextPackageTrace({
        authorities: createWorkerContextPackageAuthorityReader({
          coreDb: f.coreDb,
          store: f.store,
          workspaceDb: f.db,
        }),
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        turnId: turn.id,
        workspaceRoot: preparedContext.workspaceRoot,
      }),
  };
}

it('accepts a Material proposal with revision, pointer, every bound queue, Review and original receipt in the native writer', async () => {
  const p = await preparedMaterial();
  const { f, materialId, revisionId } = p;
  await p.accept();
  expect(p.verify().materialSelections).toMatchObject([{ materialId, revisionId }]);
  const second = await f.store.createThread(f.workspace.id, 'Excluded subscriber');
  await f.call('material.bind', {
    materialId,
    threadId: second.id,
    requestId: 'bind-second',
    expectedBindingState: 'not_bound',
  });
  await f.call('material.exclude', {
    materialId,
    threadId: second.id,
    requestId: 'exclude-second',
    expectedBindingState: 'bound',
    expectedInclusionState: 'included',
    expectedQueuedRevisionId: revisionId,
  });
  const proposalContent = 'Reviewed proposal\n';
  const artifactId = allocateEntityId('ar');
  const recordedAt = p.turn.startedAt!;
  await f.store.createArtifact({
    id: artifactId,
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    turnId: p.turn.id,
    kind: 'report',
    title: 'Proposal',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body: proposalContent },
    contentDigest: digest(proposalContent),
    lastMutationRequestId: 'proposal',
    origin: {
      kind: 'turn-output',
      threadId: f.thread.id,
      turnId: p.turn.id,
      requestId: 'proposal',
    },
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
  await createArtifactReview(f.db, {
    artifactId,
    artifactVersion: 1,
    contentDigest: digest(proposalContent),
    sourceThreadId: f.thread.id,
    sourceTurnId: p.turn.id,
    sourceAgentId: p.environmentPackage.agent.agentId,
    materialProposal: {
      materialId,
      baseRevisionId: revisionId,
      baseContentDigest: digest(p.content),
    },
    createdAt: recordedAt,
  });
  const request = {
    artifactId,
    artifactVersion: 1,
    decision: 'accepted',
    requestId: 'tested-command',
  };
  const before = f.snapshot();
  f.abortReceipt();
  await expect(f.call('artifact.review.decide', request)).rejects.toThrow();
  expect(
    f.snapshot(),
    'receipt abort retains the pending Review and all original Material state'
  ).toEqual(before);
  await f.reopen();
  expect(f.snapshot()).toEqual(before);
  f.allowReceipt();
  f.readersOnly();
  const result = await Promise.allSettled([f.call('artifact.review.decide', request)]);
  expect(result, 'the complete accepted proposal must need no Main writer').toEqual([
    { status: 'fulfilled', value: expect.any(Object) },
  ]);
  if (result[0]!.status !== 'fulfilled') throw new Error('Missing proposal acknowledgement');
  const review = getArtifactReview(f.db, artifactId, 1);
  expect(review).toMatchObject({
    decision: 'accepted',
    appliedMaterialRevisionId: expect.any(String),
  });
  expect(
    f.db.sqlite
      .prepare(
        'SELECT decision_request_id FROM artifact_reviews WHERE artifact_id = ? AND artifact_version = ?'
      )
      .get(artifactId, 1)
  ).toEqual({ decision_request_id: request.requestId });
  const appliedRevisionId = review.appliedMaterialRevisionId!;
  expect(await f.call('material.read', { materialId })).toMatchObject({
    material: { currentRevisionId: appliedRevisionId },
  });
  expect(
    await f.call('material.revision-read', { materialId, revisionId: appliedRevisionId })
  ).toMatchObject({
    revision: {
      parentRevisionId: revisionId,
      content: proposalContent,
      contentDigest: digest(proposalContent),
    },
  });
  expect(f.snapshot().revisions).toHaveLength(before.revisions.length + 1);
  expect(
    f.db.sqlite
      .prepare(
        'SELECT latest_queued_revision_id, inclusion_state FROM thread_material_bindings ORDER BY inclusion_state'
      )
      .all()
  ).toEqual([
    { latest_queued_revision_id: appliedRevisionId, inclusion_state: 'excluded' },
    { latest_queued_revision_id: appliedRevisionId, inclusion_state: 'included' },
  ]);
  expect(
    f.db.sqlite
      .prepare(
        'SELECT command_name, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
      )
      .all(request.requestId)
  ).toEqual([
    {
      command_name: 'artifact.review.decide',
      response_kind: 'artifact_review',
      response_id: review.reviewId,
    },
  ]);
  const acknowledged = f.snapshot();
  await f.reopen();
  expect(await f.call('artifact.review.decide', request)).toEqual(result[0]!.value);
  expect(f.snapshot()).toEqual(acknowledged);
});

it('clears the verified Material queue once in the native writer and replays after cold reopen', async () => {
  const p = await preparedMaterial();
  const { f } = p;
  const selected = selectQueuedThreadMaterialRevision(f.db, f.thread.id);
  expect(selected).toMatchObject({ materialId: p.materialId, revisionId: p.revisionId });
  const receipts = f.snapshot().receipts;
  f.db.sqlite.pragma('query_only = ON');
  const accepted = await Promise.allSettled([p.accept()]);
  // The real strict reader proves publication/verification reached the consumption boundary.
  expect(p.verify().materialSelections).toMatchObject([
    { materialId: p.materialId, revisionId: p.revisionId },
  ]);
  expect(accepted, 'verified queue consumption must need no Main writer').toEqual([
    { status: 'fulfilled', value: expect.any(Object) },
  ]);
  if (accepted[0]!.status !== 'fulfilled') throw new Error('Missing package acceptance');
  expect(selectQueuedThreadMaterialRevision(f.db, f.thread.id)).toBeNull();
  const cleared = f.snapshot();
  expect(cleared.receipts, 'queue consumption does not invent a command receipt').toEqual(receipts);
  await f.reopen();
  f.db.sqlite.pragma('query_only = ON');
  expect(await p.accept()).toEqual(accepted[0]!.value);
  expect(await p.accept()).toEqual(accepted[0]!.value);
  expect(f.snapshot(), 'replay preserves the same cleared queue and original receipt set').toEqual(
    cleared
  );
  f.db.sqlite.pragma('query_only = OFF');
  const latestContent = 'A later revision\n';
  const later = await f.call('material.revision-save', {
    materialId: p.materialId,
    requestId: 'later-save',
    expectedRevisionId: p.revisionId,
    content: latestContent,
    contentDigest: digest(latestContent),
  });
  f.db.sqlite.pragma('query_only = ON');
  expect(await p.accept()).toEqual(accepted[0]!.value);
  expect(selectQueuedThreadMaterialRevision(f.db, f.thread.id)).toMatchObject({
    revisionId: later.revisionId,
    bindingMutationRequestId: 'later-save',
  });
});
