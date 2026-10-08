import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';

import { ensureLocalUser } from '../auth/identity.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION } from '../lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { OperationError } from '../operation-error.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithFence,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import {
  getWorkerCheckpoint,
  listRecoverableWorkerCheckpoints,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import {
  classifyClosedWorkerApprovalGate,
  clearWorkerCheckpointAfterTerminalState,
  recoverWorkerCheckpointStopReason,
} from './worker-recovery.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

/**
 * Builds closeout tuples through real terminal publications and released attempt owners.
 * @param outcome Original decided worker outcome.
 * @param retained Whether failure closeout keeps its reusable Session idle.
 * @param options Optional publication fault/retry, execution observation, and App request identity.
 * @returns Retained owner tuple and database cleanup callback.
 */
function createCheckpointCloseoutFixture(
  outcome: 'failed' | 'completed' | 'interrupted',
  retained = true,
  options: {
    readonly repairSessionPublication?: boolean;
    readonly executionPublication?: 'before-closeout' | 'before-terminal';
    readonly requestId?: string;
  } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-checkpoint-closeout-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const store = createDemoStore({ dataRoot });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  const requestId = options.requestId ?? '00000000-0000-4000-8000-000000000501';
  const turn = store.createTurn('ws_demo', 'th_demo', 'Recover exact worker closeout', {
    kind: 'user',
    id: 'user_local',
  });
  const agentSessionId = 'as_checkpoint_closeout';
  store.updateTurn(turn.id, { agentId: 'agent_codex_host', agentSessionId });
  const createdAt = new Date().toISOString();
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup(),
    agentSessionId,
    backend: { kind: 'openshell' },
    createdAt,
    requestId,
    triggerActor: turn.triggerActor,
    turn: store.getTurnById(turn.id),
    turnInput: 'Recover exact worker closeout',
    workspaceRoots: [],
  });
  recordAgentEnvironmentPackageSnapshot(workspaceDb, { environmentPackage, createdAt });
  store.createAgentSession({
    id: agentSessionId,
    agentId: 'agent_codex_host',
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    status: 'busy',
    message: null,
    createdAt,
    updatedAt: createdAt,
    environmentPackageSnapshotId: environmentPackage.snapshotId,
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_checkpoint_closeout',
    requestId,
    triggerActor: turn.triggerActor,
    requestedAgentId: 'agent_codex_host',
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: 'Recover exact worker closeout',
  });
  const attempt = createSchedulerExecutionAttempt(coreDb, {
    entry,
    preparationInput: { admission: entry },
  });
  bindSchedulerExecutionAttemptSession(coreDb, { attemptId: attempt.attemptId, agentSessionId });
  finalizeSchedulerExecutionAttemptInput(coreDb, {
    attemptId: attempt.attemptId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: 'binding_checkpoint_closeout',
  });
  const submitted = recordSchedulerExecutionOperation(coreDb, {
    attemptId: attempt.attemptId,
    operationId: 'operation_checkpoint_closeout',
    submission: true,
  });
  const correlation = schedulerExecutionCorrelation(submitted);
  acceptSchedulerExecutionObservation(coreDb, {
    ...correlation,
    disposition: 'accepted',
    execution: 'terminal',
    outcomeRef: `turn:${turn.id}:${outcome}`,
    fenceRef: null,
  });
  markSchedulerExecutionAttemptClosing(coreDb, {
    attemptId: attempt.attemptId,
    cause: 'worker-final-status',
  });
  const completedAt = new Date().toISOString();
  const executionSession = store.getAgentSession(agentSessionId);
  const emit = store.emitTurnEvent.bind(store);
  /** Publishes the captured execution observation without changing the durable Session owner. */
  const publishExecution = () =>
    emit(
      turn.id,
      {
        event: 'agent.session.updated',
        data: { type: 'agent-session-updated', agentSession: executionSession },
        requestId,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  if (options.executionPublication === 'before-closeout') publishExecution();
  if (outcome === 'completed') store.updateTurn(turn.id, { status: 'completed', completedAt });
  // Success uses the same production helper's completed-outcome publication repair path.
  const terminalization = {
    agentSessionId,
    agentSessionRetained: retained,
    completedAt,
    outcome: outcome === 'interrupted' ? ('interrupted' as const) : ('failed' as const),
    errorCode: 'unsupported_gateway_feature',
    message: 'Choose a compatible model route and start a new Task.',
    requestId,
    store,
    turnId: turn.id,
  };
  if (options.repairSessionPublication) {
    const injectedFailure = new Error('Injected first AgentSession publication failure.');
    const publication = vi
      .spyOn(store, 'emitTurnEvent')
      .mockImplementation((id, event, admission) => {
        if (event.event === 'agent.session.updated') throw injectedFailure;
        return emit(id, event, admission);
      });
    try {
      expect(() => terminalizeGovernedWorkerTurn(terminalization)).toThrow(
        expect.objectContaining({ errors: [injectedFailure] })
      );
      const partialEvents = store.getTurnEvents(turn.id);
      expect(partialEvents.map((event) => event.event)).toEqual(
        options.executionPublication === 'before-closeout'
          ? ['agent.session.updated', 'turn.completed']
          : ['turn.completed']
      );
      const terminalBytes = JSON.stringify(partialEvents.at(-1));
      publication.mockRestore();
      terminalizeGovernedWorkerTurn(terminalization);
      expect(
        JSON.stringify(
          store.getTurnEvents(turn.id).find((event) => event.event === 'turn.completed')
        )
      ).toBe(terminalBytes);
    } finally {
      publication.mockRestore();
    }
  } else if (options.executionPublication === 'before-terminal') {
    // Insert the contradictory observation after the owner's idle write but before its terminal write.
    const publication = vi
      .spyOn(store, 'emitTurnEvent')
      .mockImplementation((id, event, admission) => {
        if (event.event === 'turn.completed') publishExecution();
        return emit(id, event, admission);
      });
    try {
      terminalizeGovernedWorkerTurn(terminalization);
    } finally {
      publication.mockRestore();
    }
  } else {
    terminalizeGovernedWorkerTurn(terminalization);
  }
  closeSchedulerExecutionAttemptWithFence(coreDb, {
    correlation,
    fenceRef: 'worker-backend:checkpoint-closeout',
    proof: {
      terminalHandoff: true,
      output: true,
      evidence: true,
      outsideWorkspaceCollection: true,
      integrationDrain: true,
      routesRevoked: true,
    },
  });
  const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    workerSessionId: agentSessionId,
    requestId,
    requestInputHash: 'sha256:checkpoint-closeout',
    stage:
      outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'aborted' : 'running_worker',
    stopReason: outcome === 'failed' ? 'error' : outcome === 'interrupted' ? 'aborted' : null,
    iteration: 0,
  });
  return {
    coreDb,
    workspaceDb,
    store,
    checkpoint,
    attempt,
    agentSessionId,
    close: () => {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    },
  };
}

/** Records the existing outer command receipt required by conversation checkpoint recovery. */
function recordCloseoutConversationReceipt(
  f: ReturnType<typeof createCheckpointCloseoutFixture>
): void {
  const { checkpoint, store } = f;
  store.recordCommandRequest({
    command: 'conversation.submit',
    requestId: checkpoint.requestId,
    inputHash: checkpoint.requestInputHash,
    scope: {
      actorId: 'user_local',
      workspaceId: checkpoint.workspaceId,
      threadId: checkpoint.threadId,
    },
    response: {
      kind: 'turn',
      id: checkpoint.turnId,
      conversationMetadata: {
        targetRef: 'new-task-worker',
        logicalModelId: null,
        receivingWorkspaceId: checkpoint.workspaceId,
        receivingThreadId: checkpoint.threadId,
        downstream: { kind: 'task', turnId: checkpoint.turnId },
        resultKind: 'worker-turn',
        status: 202,
      },
    },
  });
}

/**
 * Opens a migrated workspace database for worker recovery tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one exact runtime stream and matching native-origin row.
 *
 * @param lineage Authoritative outer worker lineage.
 * @param streamRef Safe synthetic stream reference.
 * @param sourceKind Primary or runtime-thread stream class.
 * @param record Exact pinned Codex JSON frame.
 * @param origin Restricted native-origin fields for the frame.
 * @returns Exact bytes, manifest row, and native-origin index row.
 */
function createRecoveryRuntimeStream(
  lineage: WorkerLineage,
  streamRef: string,
  sourceKind: 'primary' | 'runtime-thread',
  record: Record<string, unknown>,
  origin: Partial<WorkerRuntimeNativeOriginIndexEntry>
) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const entry = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
    adapterVersion: '0.153.4',
    byteLength: bytes.byteLength,
    byteOffset: 0,
    eventKind: record.type,
    frameSequence: 0,
    frameSha256: runtimeSha256(bytes),
    lineage,
    ...origin,
    parseStatus: 'parsed',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streamRef,
  });
  return {
    bytes,
    entry,
    manifest: {
      bytes: bytes.byteLength,
      captureStatus: 'complete' as const,
      frameCount: 1,
      sha256: runtimeSha256(bytes),
      sourceKind,
      stableTerminal: true,
      streamRef,
    },
  };
}

/**
 * Imports one minimal valid retained runtime forest for checkpoint recovery tests.
 *
 * @param workspaceDb Workspace database that owns the retained provenance.
 * @returns Outer turn id plus stable raw evidence paths and original stream bytes.
 */
async function createRetainedRecoveryProvenance(workspaceDb: WorkspaceDb) {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Recover retained runtime provenance', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      }),
      agentSessionId: 'as_recovery_provenance',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_recovery_provenance',
      triggerActor: { kind: 'user', id: 'user_demo' },
      turn,
      turnInput: 'Recover retained runtime provenance',
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: '2026-07-13T00:00:01.000Z',
    environmentPackage,
  });
  const lineage: WorkerLineage = {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId ?? null,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
  const nativeThreadId = '019f0000-0000-7000-8000-000000000101';
  const nativeSessionId = '019f0000-0000-7000-8000-000000000110';
  const streams = [
    createRecoveryRuntimeStream(
      lineage,
      'stream-0000.jsonl',
      'primary',
      { thread_id: nativeThreadId, type: 'thread.started' },
      { nativeThreadId }
    ),
    createRecoveryRuntimeStream(
      lineage,
      'stream-0001.jsonl',
      'runtime-thread',
      {
        payload: {
          cwd: '/private/runtime-provenance',
          id: nativeThreadId,
          session_id: nativeSessionId,
          source: 'exec',
          timestamp: '2026-07-13T00:00:00.000Z',
        },
        timestamp: '2026-07-13T00:00:00.000Z',
        type: 'session_meta',
      },
      { nativeSessionId, nativeThreadId }
    ),
  ];
  const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-recovery-provenance-capture-'));
  const rawStreamsRoot = join(captureRoot, 'raw');
  const streamManifestPath = join(captureRoot, 'raw-streams.json');
  const nativeOriginIndexPath = join(captureRoot, 'native-origin-index.jsonl');
  const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
    adapterVersion: '0.153.4',
    captureStatus: 'complete',
    lineage,
    primaryStreamRef: 'stream-0000.jsonl',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streams: streams.map((stream) => stream.manifest),
  });
  mkdirSync(rawStreamsRoot, { recursive: true });
  writeFileSync(streamManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    nativeOriginIndexPath,
    `${streams.map((stream) => JSON.stringify(stream.entry)).join('\n')}\n`
  );
  for (const stream of streams) {
    writeFileSync(join(rawStreamsRoot, stream.manifest.streamRef), stream.bytes);
  }
  const workspaceRoot = join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId);
  const imported = await importWorkerRuntimeProvenance({
    backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
    capture: { nativeOriginIndexPath, rawStreamsRoot, streamManifestPath },
    collectedAt: '2026-07-13T00:00:02.000Z',
    environmentPackage,
    workspaceDb,
    workspaceRoot,
  });
  expect(imported.complete).toBe(true);
  const stableStreamPath = join(
    workspaceRoot,
    'evidence',
    'backend',
    imported.rawBundleId,
    'raw',
    streams[0].manifest.streamRef
  );
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    stableStreamBytes: streams[0].bytes,
    stableStreamPath,
    turnId: turn.id,
  };
}

/** Computes the canonical prefixed SHA-256 digest for retained runtime bytes. */
function runtimeSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('worker recovery materialization', () => {
  it('recovers Subject A: failed Turn with a live-closeout retained idle AgentSession', () => {
    const f = createCheckpointCloseoutFixture('failed');
    try {
      expect(f.store.getTurnById(f.checkpoint.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'unsupported_gateway_feature' },
      });
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('idle');
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe('error');
    } finally {
      f.close();
    }
  });

  it('recovers Subject B: completed Turn with an AgentSession closed after its terminal event', () => {
    const f = createCheckpointCloseoutFixture('completed');
    try {
      const terminal = f.store
        .getTurnEvents(f.checkpoint.turnId)
        .find((event) => event.event === 'turn.completed')!;
      f.store.updateAgentSession(f.agentSessionId, {
        status: 'closed',
        updatedAt: new Date(Date.parse(terminal.timestamp) + 1000).toISOString(),
      });
      expect(f.checkpoint).toMatchObject({ stage: 'running_worker', stopReason: null });
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe('completed');
    } finally {
      f.close();
    }
  });

  it.each([
    ['failed', 'error'],
    ['completed', 'completed'],
  ] as const)('recovers %s publication repair after a real failed write and owner retry', (outcome, stopReason) => {
    const f = createCheckpointCloseoutFixture(outcome, false, { repairSessionPublication: true });
    try {
      expect(
        f.store
          .getTurnEvents(f.checkpoint.turnId)
          .map((event) => `${event.sequence}:${event.event}`)
      ).toEqual(['1:turn.completed', '2:agent.session.updated']);
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe(stopReason);
      const reloaded = createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, reloaded, f.workspaceDb, f.checkpoint)
      ).toBe(stopReason);
    } finally {
      f.close();
    }
  });

  it.each([
    ['repaired closeout', true, false],
    ['ordinary closeout before terminal', false, true],
    ['ordinary closeout after terminal', false, false],
  ] as const)('preserves recovery_required for a later nonterminal publication after %s', async (_scenario, repairSessionPublication, beforeTerminal) => {
    const f = createCheckpointCloseoutFixture('completed', false, {
      repairSessionPublication,
      executionPublication: beforeTerminal ? 'before-terminal' : undefined,
    });
    try {
      const { checkpoint, store } = f;
      if (!beforeTerminal) {
        const session = store
          .getTurnEvents(checkpoint.turnId)
          .find((event) => event.data.type === 'agent-session-updated')!;
        if (session.data.type !== 'agent-session-updated')
          throw new Error('Missing fixture closeout publication.');
        store.emitTurnEvent(
          checkpoint.turnId,
          {
            event: 'agent.session.updated',
            data: {
              type: 'agent-session-updated',
              agentSession: { ...session.data.agentSession, status: 'busy' },
            },
            requestId: checkpoint.requestId,
            workspaceId: checkpoint.workspaceId,
            threadId: checkpoint.threadId,
            turnId: checkpoint.turnId,
          },
          ALREADY_DECIDED_PUBLICATION_ADMISSION
        );
      }
      recordCloseoutConversationReceipt(f);
      const cold = createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      expect(cold.getAgentSession(f.agentSessionId).status).toBe('idle');
      expect(
        cold
          .getTurnEvents(checkpoint.turnId)
          .map((event) =>
            event.data.type === 'agent-session-updated'
              ? `${event.sequence}:${event.data.agentSession.status}`
              : `${event.sequence}:${event.event}`
          )
      ).toEqual(
        repairSessionPublication
          ? ['1:turn.completed', '2:idle', '3:busy']
          : beforeTerminal
            ? ['1:idle', '2:busy', '3:turn.completed']
            : ['1:idle', '2:turn.completed', '3:busy']
      );
      const result = await classifyDirectTaskCheckpointAfterSchedulerRecovery({
        coreDb: f.coreDb,
        workspaceDb: f.workspaceDb,
        store: cold,
        checkpoint,
      }).catch((error: Error) => error.message);
      expect({
        result,
        checkpoint: getWorkerCheckpoint(
          f.workspaceDb,
          checkpoint.workspaceId,
          checkpoint.threadId,
          checkpoint.turnId
        ),
      }).toEqual({
        result: 'Worker AgentSession publication contradicts its checkpoint lineage.',
        checkpoint,
      });
    } finally {
      f.close();
    }
  });

  it.each([
    false,
    true,
  ])('accepts an earlier execution publication before closeout with repair=%s', (repairSessionPublication) => {
    const f = createCheckpointCloseoutFixture('completed', false, {
      repairSessionPublication,
      executionPublication: 'before-closeout',
    });
    try {
      const cold = createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      expect(
        cold
          .getTurnEvents(f.checkpoint.turnId)
          .map((event) =>
            event.data.type === 'agent-session-updated'
              ? `${event.sequence}:${event.data.agentSession.status}`
              : `${event.sequence}:${event.event}`
          )
      ).toEqual(
        repairSessionPublication
          ? ['1:busy', '2:turn.completed', '3:idle']
          : ['1:busy', '2:idle', '3:turn.completed']
      );
      expect(recoverWorkerCheckpointStopReason(f.coreDb, cold, f.workspaceDb, f.checkpoint)).toBe(
        'completed'
      );
    } finally {
      f.close();
    }
  });

  it.each([
    'changed completion timestamp',
    'changed message',
    'changed sandbox summary',
    'duplicate closeout publication',
    'changed terminal completion',
    'unsupported success reason',
  ] as const)('rejects an unproved reordered repair with %s', (scenario) => {
    const f = createCheckpointCloseoutFixture('completed', false, {
      repairSessionPublication: true,
    });
    try {
      const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
      const terminal = events[0]!;
      const session = events[1]!;
      if (terminal.data.type !== 'turn-completed' || session.data.type !== 'agent-session-updated')
        throw new Error('Missing repaired fixture publications.');
      switch (scenario) {
        case 'changed completion timestamp':
          session.data.agentSession.updatedAt = new Date(
            Date.parse(session.timestamp) - 1000
          ).toISOString();
          break;
        case 'changed message':
          session.data.agentSession.message = 'A different decided message.';
          break;
        case 'changed sandbox summary':
          session.data.agentSession.sandboxSummary = {
            access: 'none',
            workspaceRootRefs: [],
            summary: 'A different projection.',
          };
          break;
        case 'duplicate closeout publication':
          events.push({ ...session, sequence: session.sequence + 1 });
          break;
        case 'changed terminal completion':
          terminal.data.turn.completedAt = new Date(
            Date.parse(session.data.agentSession.updatedAt) - 1000
          ).toISOString();
          break;
        case 'unsupported success reason':
          terminal.data.stopReason = 'length';
          break;
      }
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(() =>
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toThrow('Worker AgentSession publication contradicts its checkpoint lineage.');
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it.each([
    'failed',
    'completed',
  ] as const)('requires recovery when both %s publications name the same wrong request', async (outcome) => {
    const f = createCheckpointCloseoutFixture(outcome);
    try {
      const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
      for (const event of events) event.requestId = '00000000-0000-4000-8000-000000000502';
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(() =>
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toThrow('Worker product terminal event contradicts its command owner.');
      recordCloseoutConversationReceipt(f);
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb: f.coreDb,
          store: f.store,
          workspaceDb: f.workspaceDb,
          checkpoint: f.checkpoint,
        })
      ).rejects.toThrow('Worker product terminal event contradicts its command owner.');
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          f.checkpoint.workspaceId,
          f.checkpoint.threadId,
          f.checkpoint.turnId
        )
      ).toEqual(f.checkpoint);
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it.each([
    'failed',
    'completed',
  ] as const)('joins %s publications to a projected non-UUID command request', (outcome) => {
    const f = createCheckpointCloseoutFixture(outcome, true, {
      requestId: 'req_checkpoint_closeout',
    });
    try {
      expect(f.store.getTurnEvents(f.checkpoint.turnId)[0]?.requestId).not.toBe(
        f.checkpoint.requestId
      );
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe(outcome === 'failed' ? 'error' : 'completed');
    } finally {
      f.close();
    }
  });

  it('keeps ordinary completed closeout distinct from an earlier busy AgentSession publication', () => {
    const f = createCheckpointCloseoutFixture('completed');
    try {
      const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
      const session = events.find((event) => event.data.type === 'agent-session-updated')!;
      if (session.data.type !== 'agent-session-updated')
        throw new Error('Missing fixture AgentSession publication.');
      session.data.agentSession.status = 'busy';
      session.data.agentSession.updatedAt = session.data.agentSession.createdAt;
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe('completed');
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it.each([
    ['failed', false, 'failed', 'error'],
    ['interrupted', false, 'interrupted', 'aborted'],
    ['interrupted', true, 'idle', 'aborted'],
    ['completed', true, 'idle', 'completed'],
  ] as const)('recovers %s closeout with retention=%s and published %s', (outcome, retained, status, stopReason) => {
    const f = createCheckpointCloseoutFixture(outcome, retained);
    try {
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe(status);
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe(stopReason);
    } finally {
      f.close();
    }
  });

  it.each([
    ['failed', false],
    ['completed', false],
    ['failed', true],
    ['completed', true],
  ] as const)('finishes the conversation checkpoint through its existing owner after %s closeout with publication repair=%s', async (outcome, repairSessionPublication) => {
    const f = createCheckpointCloseoutFixture(outcome, !repairSessionPublication, {
      repairSessionPublication,
    });
    try {
      const { checkpoint, store } = f;
      const terminal = store
        .getTurnEvents(checkpoint.turnId)
        .find((event) => event.event === 'turn.completed')!;
      if (outcome === 'completed')
        store.updateAgentSession(f.agentSessionId, {
          status: 'closed',
          updatedAt: new Date(Date.parse(terminal.timestamp) + 1000).toISOString(),
        });
      recordCloseoutConversationReceipt(f);
      const before = JSON.stringify({
        turn: store.getTurnById(checkpoint.turnId),
        session: store.getAgentSession(f.agentSessionId),
        events: store.getTurnEvents(checkpoint.turnId),
        attempts: f.coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all(),
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb: f.coreDb,
          workspaceDb: f.workspaceDb,
          store,
          checkpoint,
        })
      ).resolves.toBe('complete');
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          checkpoint.workspaceId,
          checkpoint.threadId,
          checkpoint.turnId
        )
      ).toBeNull();
      expect(listRecoverableWorkerCheckpoints(f.workspaceDb, checkpoint.workspaceId)).toEqual([]);
      expect(
        JSON.stringify({
          turn: store.getTurnById(checkpoint.turnId),
          session: store.getAgentSession(f.agentSessionId),
          events: store.getTurnEvents(checkpoint.turnId),
          attempts: f.coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all(),
        })
      ).toBe(before);
    } finally {
      f.close();
    }
  });

  const closeoutContradiction = 'Worker generic closeout contradicts its canonical StopReason.';
  const publicationContradiction =
    'Worker AgentSession publication contradicts its checkpoint lineage.';
  const incompleteExecution = 'Worker checkpoint has no complete execution closeout.';
  const missingTerminal = 'Worker checkpoint has no exact product terminal event.';
  it.each([
    ['Turn status disagrees', closeoutContradiction],
    ['terminal Turn status disagrees', closeoutContradiction],
    ['no terminal event', missingTerminal],
    ['duplicate terminal event', missingTerminal],
    [
      'checkpoint StopReason disagrees with terminal event',
      'Worker checkpoint contradicts its product terminal event.',
    ],
    ['attempt still open', incompleteExecution],
    ['attempt has no fence', incompleteExecution],
    ['attempt has no operation', incompleteExecution],
    ['impossible published AgentSession', closeoutContradiction],
    ['AgentSession changed before terminal', closeoutContradiction],
    ['AgentSession changed at terminal', closeoutContradiction],
    ['post-terminal publication changes the decided completion', publicationContradiction],
    ['AgentSession publication has later timestamp', publicationContradiction],
    ['AgentSession publication missing for retained failure', closeoutContradiction],
    ['AgentSession publication has wrong owner', publicationContradiction],
    ['AgentSession publication has wrong agent', publicationContradiction],
    ['AgentSession publication has wrong Thread', publicationContradiction],
    ['AgentSession publication has wrong request', publicationContradiction],
    [
      'terminal event has wrong Turn',
      'Worker product terminal event contradicts its checkpoint lineage.',
    ],
    ['checkpoint has wrong AgentSession', 'Worker checkpoint has no exact AgentSession owner.'],
    ['checkpoint has wrong request', 'Worker scheduler admission contradicts its command owner.'],
  ])('fails closed when %s', (scenario, expectedError) => {
    const f = createCheckpointCloseoutFixture('failed');
    const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
    const terminal = events.find((event) => event.data.type === 'turn-completed')!;
    const session = events.find((event) => event.data.type === 'agent-session-updated')!;
    if (terminal.data.type !== 'turn-completed' || session.data.type !== 'agent-session-updated')
      throw new Error('Fixture lacks production terminal publications.');
    let checkpoint = f.checkpoint;
    try {
      switch (scenario) {
        case 'Turn status disagrees':
          vi.spyOn(f.store, 'getTurn').mockReturnValue({
            ...f.store.getTurnById(checkpoint.turnId),
            status: 'completed',
          });
          break;
        case 'terminal Turn status disagrees':
          terminal.data.turn.status = 'completed';
          break;
        case 'no terminal event':
          events.splice(events.indexOf(terminal), 1);
          break;
        case 'duplicate terminal event':
          events.push(structuredClone(terminal));
          break;
        case 'checkpoint StopReason disagrees with terminal event':
          checkpoint = { ...checkpoint, stage: 'aborted', stopReason: 'aborted' };
          break;
        case 'attempt still open':
          f.coreDb.sqlite.prepare("UPDATE scheduler_execution_attempts SET phase = 'open'").run();
          break;
        case 'attempt has no fence':
          f.coreDb.sqlite.prepare('UPDATE scheduler_execution_attempts SET fence_ref = NULL').run();
          break;
        case 'attempt has no operation':
          f.coreDb.sqlite
            .prepare('UPDATE scheduler_execution_attempts SET operation_id = NULL')
            .run();
          break;
        case 'impossible published AgentSession':
          session.data.agentSession.status = 'busy';
          break;
        case 'AgentSession changed before terminal':
        case 'AgentSession changed at terminal':
          f.store.updateAgentSession(f.agentSessionId, {
            status: 'closed',
            updatedAt: new Date(
              Date.parse(terminal.timestamp) -
                (scenario === 'AgentSession changed before terminal' ? 1 : 0)
            ).toISOString(),
          });
          break;
        case 'post-terminal publication changes the decided completion':
          session.sequence = terminal.sequence + 1;
          session.timestamp = new Date(Date.parse(terminal.timestamp) + 1000).toISOString();
          session.data.agentSession.updatedAt = session.timestamp;
          break;
        case 'AgentSession publication has later timestamp':
          session.timestamp = new Date(Date.parse(terminal.timestamp) + 1).toISOString();
          break;
        case 'AgentSession publication missing for retained failure':
          events.splice(events.indexOf(session), 1);
          break;
        case 'AgentSession publication has wrong owner':
          session.data.agentSession.id = 'as_foreign';
          break;
        case 'AgentSession publication has wrong agent':
          session.data.agentSession.agentId = 'agent_foreign';
          break;
        case 'AgentSession publication has wrong Thread':
          session.data.agentSession.threadId = 'th_foreign';
          break;
        case 'AgentSession publication has wrong request':
          session.requestId = '00000000-0000-4000-8000-000000000502';
          break;
        case 'terminal event has wrong Turn':
          terminal.data.turn.id = 'turn_foreign';
          break;
        case 'checkpoint has wrong AgentSession':
          checkpoint = { ...checkpoint, workerSessionId: 'as_foreign' };
          break;
        case 'checkpoint has wrong request':
          checkpoint = { ...checkpoint, requestId: '00000000-0000-4000-8000-000000000502' };
          break;
      }
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(() =>
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, checkpoint)
      ).toThrow(expectedError);
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          f.checkpoint.workspaceId,
          f.checkpoint.threadId,
          f.checkpoint.turnId
        )
      ).toEqual(f.checkpoint);
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it.each([
    ['granted', 'completed', 'completed'],
    ['denied', 'interrupted', 'aborted'],
  ] as const)('classifies a %s human worker approval after a policy grant and terminal closeout', (decision, turnStatus, stopReason) => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Close a worker approval', {
      id: 'user_local',
      kind: 'user',
    });
    // A prior policy grant is durable evidence, not the later human Gate response.
    const policyApproval = store.createApproval({
      createdAt: '2026-09-03T00:00:00.000Z',
      description: 'Automatically approve publication.',
      id: 'ap_policy_push',
      kind: 'permission',
      resolvedAt: '2026-09-03T00:00:00.000Z',
      status: 'granted',
      threadId: turn.threadId,
      title: 'Approve push',
      turnId: turn.id,
      workspaceId: turn.workspaceId,
    });
    store.createItem({
      approvalRequestId: policyApproval.id,
      completedAt: policyApproval.createdAt,
      createdAt: policyApproval.createdAt,
      description: policyApproval.description,
      id: 'it_policy_request',
      kind: policyApproval.kind,
      status: 'completed',
      threadId: turn.threadId,
      title: policyApproval.title,
      turnId: turn.id,
      type: 'approval-request',
      workspaceId: turn.workspaceId,
    });
    store.createItem({
      actor: { id: 'nanocore-repo-push-policy', kind: 'system', responsibleUserId: null },
      approvalRequestId: policyApproval.id,
      causationId: 'it_policy_request',
      completedAt: policyApproval.createdAt,
      createdAt: policyApproval.createdAt,
      decision: 'granted',
      id: 'it_policy_decision',
      decidedAt: policyApproval.createdAt,
      status: 'completed',
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-decision',
      workspaceId: turn.workspaceId,
    });
    const approval = store.createApproval({
      createdAt: '2026-09-04T00:00:00.000Z',
      description: 'Approve the exact worker effect.',
      id: `ap_worker_${decision}`,
      kind: 'permission',
      resolvedAt: null,
      status: 'pending',
      threadId: turn.threadId,
      title: 'Approve worker effect',
      turnId: turn.id,
      workspaceId: turn.workspaceId,
    });
    const request = store.createItem({
      approvalRequestId: approval.id,
      completedAt: '2026-09-04T00:00:00.000Z',
      createdAt: '2026-09-04T00:00:00.000Z',
      description: approval.description,
      id: `it_worker_${decision}_request`,
      kind: approval.kind,
      status: 'completed',
      threadId: turn.threadId,
      title: approval.title,
      turnId: turn.id,
      type: 'approval-request',
      workspaceId: turn.workspaceId,
    });
    const response = store.createItem({
      actor: { id: 'user_local', kind: 'user' },
      approvalRequestId: approval.id,
      causationId: '00000000-0000-4000-8000-000000000401',
      completedAt: '2026-09-04T00:01:00.000Z',
      createdAt: '2026-09-04T00:01:00.000Z',
      decision,
      id: `it_worker_${decision}_decision`,
      decidedAt: '2026-09-04T00:01:00.000Z',
      status: 'completed',
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-decision',
      workspaceId: turn.workspaceId,
    });
    store.updateApproval(approval.id, {
      resolvedAt: '2026-09-04T00:01:00.000Z',
      status: decision,
    });
    const closedTurn = store.updateTurn(turn.id, {
      completedAt: '2026-09-04T00:01:00.000Z',
      status: turnStatus,
    });
    store.emitTurnEvent(turn.id, {
      data: { stopReason, turn: closedTurn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId: '00000000-0000-4000-8000-000000000401',
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: turn.workspaceId,
    });

    expect(classifyClosedWorkerApprovalGate(store, closedTurn)).toEqual({
      requestItemId: request.id,
      responseItemId: response.id,
      responseRequestId: '00000000-0000-4000-8000-000000000401',
      stopReason,
    });
  });

  it('cleans checkpoints only after terminal worker state is durably saved', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_completed',
        requestId: 'req_turn_completed',
        requestInputHash: 'sha256:turn_completed',
        stage: 'completed',
        iteration: 4,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_running',
        requestId: 'req_turn_running',
        requestInputHash: 'sha256:turn_running',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_running',
        })
      ).toBe(false);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_running')).not.toBeNull();
      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_completed',
        })
      ).toBe(true);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_completed')).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses to clear a matching session when required provenance was never retained', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Missing retained runtime provenance', {
        kind: 'user',
        id: 'user_local',
      });
      const environmentPackage = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agentSetup: createTestAgentSetup({
            requiredCapabilities: [
              'trusted-worker-inference-relay',
              'worker.runtime-provenance.v1',
            ],
          }),
          agentSessionId: 'as_recovery_provenance_missing',
          backend: { kind: 'openshell' },
          createdAt: '2026-07-13T00:00:00.000Z',
          requestId: 'req_recovery_provenance_missing',
          triggerActor: { kind: 'user', id: 'user_demo' },
          turn,
          turnInput: 'Missing retained runtime provenance',
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      );
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-13T00:00:01.000Z',
        environmentPackage,
      });
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        iteration: 1,
        now: () => '2026-07-13T00:00:03.000Z',
        requestId: `req_${turn.id}`,
        requestInputHash: `sha256:${turn.id}`,
        stage: 'completed',
        threadId: 'th_demo',
        turnId: turn.id,
        workerSessionId: environmentPackage.scope.agentSessionId,
        workspaceId: 'ws_demo',
      });

      await expect(
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          threadId: 'th_demo',
          turnId: turn.id,
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow('Required retained runtime provenance is missing.');
      await expect(
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          threadId: 'th_demo',
          turnId: turn.id,
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'recovery_retry_failed', status: 400 });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', turn.id)).toEqual(checkpoint);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('re-verifies retained required provenance before clearing a terminal checkpoint', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const retained = await createRetainedRecoveryProvenance(workspaceDb);
      const checkpoint = () =>
        upsertWorkerCheckpoint(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: retained.turnId,
          requestId: `req_${retained.turnId}`,
          requestInputHash: `sha256:${retained.turnId}`,
          stage: 'completed',
          iteration: 1,
          workerSessionId: retained.agentSessionId,
          now: () => '2026-07-13T00:00:03.000Z',
        });
      const clear = () =>
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: retained.turnId,
        });

      checkpoint();
      await expect(clear()).resolves.toBe(true);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', retained.turnId)).toBeNull();

      checkpoint();
      writeFileSync(
        retained.stableStreamPath,
        Buffer.concat([retained.stableStreamBytes, Buffer.from('tampered')])
      );
      await expect.soft(clear()).rejects.toThrow(/provenance/i);
      await expect.soft(clear()).rejects.toBeInstanceOf(OperationError);
      await expect
        .soft(clear())
        .rejects.toMatchObject({ code: 'recovery_retry_failed', status: 400 });
      expect
        .soft(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', retained.turnId))
        .not.toBeNull();

      checkpoint();
      writeFileSync(retained.stableStreamPath, retained.stableStreamBytes);
      unlinkSync(retained.stableStreamPath);
      await expect.soft(clear()).rejects.toThrow(/provenance/i);
      await expect.soft(clear()).rejects.toBeInstanceOf(OperationError);
      await expect
        .soft(clear())
        .rejects.toMatchObject({ code: 'recovery_retry_failed', status: 400 });
      expect
        .soft(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', retained.turnId))
        .not.toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
