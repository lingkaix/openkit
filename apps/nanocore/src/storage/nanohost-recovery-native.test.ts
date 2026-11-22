import { randomUUID } from 'node:crypto';
// openkit-test-platform: posix
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { canonicalJsonText } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { expect, it, onTestFinished, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { recordCoreHarnessConsumption } from '../runtime/core-journal-records.js';
import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionGrantInDb,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import {
  CORE_SCHEDULER_EXECUTION_DEFINITION,
  readExecutionJournalEndedStep,
  readExecutionJournalInvocation,
  readExecutionJournalRoot,
} from '../runtime/execution-journal.js';
import type { ExecutionJournalIntent } from '../runtime/execution-step-journal.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { listWorkspaceRuntimeEvidence } from '../runtime/runtime-evidence.js';
import {
  getWorkerBackendSession,
  readNanoHostWorkerRouteBinding,
} from '../runtime/worker-backend-session-records.js';
import {
  getWorkerControlAcceptedFinalStatus,
  waitForWorkerControlFinalStatus,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import {
  beginWorkerTurnJournalStep,
  endWorkerTurnJournalStep,
  prepareWorkerTurnJournalIntents,
  WorkerGovernanceTurnExecutor,
} from '../runtime/worker-governance-turn-executor.js';
import {
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  workerStorageSchedulerRows,
} from '../runtime/worker-storage-binding-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { createTestWorkspaceDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { commandInputHash } from './control-store-input.js';
import {
  admitNanoHostWorkerFinalInDb,
  inspectCoreNanoHostTerminalRelease,
  nanoHostTerminalReleaseWorkspaceStep,
  observeAcceptedNanoHostFinalInDb,
  releaseCoreNanoHostTerminalInDb,
} from './core-journal-native.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  type NanoHostRecoveryLease,
  type NanoHostRecoveryMutation,
  type NanoHostWorkerRecoveryState,
  readNanoHostPhysicalCleanupReceipt,
  readNanoHostRecoveryLease,
  verifyNanoHostTerminalDrainAndRevocation,
} from './nanohost-recovery-native.js';
import {
  nanoHostWorkerFinalDecisionFingerprint,
  readRetainedNanoHostSubmission,
} from './nanohost-submitted-lease.js';
import {
  inspectNanoHostWorkerBinding,
  nanoHostWorkerBindingLiveness,
  resolveAdmittedNanoHostFinalBinding,
  resolveAdmittedNanoHostWorkerBinding,
} from './nanohost-worker-binding.js';
import type { ControlWorkerFinalStatusCommand } from './worker-control-final-status-codecs.js';
import type { ControlWorkerHeartbeatCommand } from './worker-control-heartbeat-codecs.js';
import type { ControlWorkerRecordCommand } from './worker-control-record-codecs.js';

const created = '2026-11-21T00:00:00.000Z';
const startupDeadline = '2026-11-21T00:01:00.000Z';
const deadline = '2026-11-21T02:00:01.000Z';
const acceptedAt = '2026-11-21T00:00:01.000Z';
const classifiedAt = '2026-11-21T00:00:04.000Z';
const expectedRecoveryDeadline = '2026-11-21T00:05:04.000Z';
const attemptId = testEntityId('attempt', 'admitted-native-recovery');
const workspaceId = testEntityId('ws', 'admitted-native-recovery');
const threadId = testEntityId('th', 'admitted-native-recovery');
const turnId = testEntityId('tu', 'admitted-native-recovery');
const agentSessionId = testEntityId('as', 'admitted-native-recovery');
const deploymentId = testEntityId('dep', 'admitted-native-recovery');
const targetId = 'recovery-target';
const physicalEpoch = 'a'.repeat(64);
const processKeyHash = 'b'.repeat(43);
const inputRef = 'admitted-recovery-package';
const bindingRef = 'admitted-recovery-binding';
const operationId = commandInputHash({ attemptId, inputRef, operation: 'submit' });
const lease: NanoHostRecoveryLease = {
  grant: {
    execution: { owner: { kind: 'server' }, executionId: attemptId },
    attemptId,
    turnId,
    backendId: 'nanohost',
    bindingRef,
    inputRef,
    operationId,
    generation: '1',
    deadline,
  },
  attempt: {
    attemptId,
    workspaceId,
    threadId,
    turnId,
    agentSessionId,
    bindingRef,
    inputRef,
    operationId,
    queueEntryId: 'original-queue',
    backendId: 'nanohost',
    phase: 'open',
    disposition: 'accepted',
    preparationInputJson: '{}',
    deadline,
    terminalCause: null,
    outcomeRef: null,
    fenceRef: null,
    createdAt: created,
    updatedAt: created,
  },
};

async function fixture(mode: 'live' | 'queued' = 'live') {
  const owner = openNanoHostTestOwner();
  const target = { targetId, identityId: targetId, deploymentId, observedAt: created };
  await owner.transition({ kind: 'allocate', ...target });
  await owner.transition({
    kind: 'ready',
    ...target,
    connectionGeneration: 1,
    physicalEpoch,
    freshEmpty: true,
    ready: true,
    predecessorFenced: true,
  });
  owner.setup((sqlite) =>
    sqlite
      .prepare(`INSERT INTO worker_backend_sessions (
      attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
      backend_kind, deployment_id, backend_session_id, staging_directory_ref,
      workspace_handoff_state, state, created_at, updated_at, runtime_target_id,
      origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, worker_route_binding_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'openshell', ?, 'original-backend', 'original-staging',
              'complete', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        attemptId,
        workspaceId,
        threadId,
        turnId,
        agentSessionId,
        inputRef,
        deploymentId,
        mode === 'queued' ? 'materialized' : 'launching',
        created,
        created,
        targetId,
        physicalEpoch,
        '{"imageRef":"registry.example/worker"}',
        bindingRef,
        mode === 'queued'
          ? null
          : canonicalJsonText({
              version: 1,
              operationId,
              generation: '1',
              deadline,
              control: 'a'.repeat(64),
              inference: 'b'.repeat(64),
              capability: 'c'.repeat(64),
              harnessInstanceId: 'original-harness',
              harnessOperationId: 'd'.repeat(64),
              harnessSequence: 1,
            })
      )
  );
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.database);
    const modules = Promise.all(workerData.modules.map((url) => import(url)));
    parentPort.on('message', async (command) => {
      const sqlite = new Database(workerData.path, { fileMustExist: true });
      sqlite.pragma('synchronous = FULL');
      try {
        const [native, heartbeat, final, harness, db, record, storage] = await modules;
        const result = sqlite.transaction(() => {
          if (command.kind === 'storage-purge') {
            const coreDb = db.openCoreReadDb(command.dataRoot);
            try {
              return coreDb.sqlite.transaction(() =>
                storage.applyControlWorkerStorageBinding({ sqlite }, command.input, { coreDb })
              )();
            } finally {
              coreDb.sqlite.close();
            }
          }
          if (command.kind === 'submit')
            return native.applyNanoHostWorkerSubmission(sqlite, command.input);
          if (['dispatch', 'pinned-heartbeat', 'pinned-record'].includes(command.kind)) {
            const coreDb = db.openCoreReadDb(command.dataRoot);
            try {
              return coreDb.sqlite.transaction(() => {
                if (command.kind === 'pinned-heartbeat')
                  return heartbeat.applyControlWorkerHeartbeat({ sqlite, coreDb, input: command.input });
                if (command.kind === 'pinned-record')
                  return record.applyControlWorkerRecord({
                    sqlite, coreDb, input: command.input, observedAt: command.observedAt,
                  });
                return harness.applyControlHarnessLifecycle({ sqlite }, command.input, { coreDb });
              })();
            } finally {
              coreDb.sqlite.close();
            }
          }
          if (command.kind === 'worker-heartbeat')
            return heartbeat.applyControlWorkerHeartbeat({ sqlite, original: command.original, input: command.input });
          if (command.kind === 'worker-final')
            return final.applyControlWorkerFinalStatus({ sqlite, original: command.original, input: command.input, decision: command.decision });
          if (command.kind === 'initialize')
            return native.initializeNanoHostRecoveryLease(sqlite, command.lease, command.proof);
          if (command.kind === 'heartbeat')
            return native.recordNanoHostRecoveryHeartbeat(sqlite, command.lease, command.input);
          return native.applyNanoHostRecoveryMutation(sqlite, command.input);
        }).immediate();
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({ ok: false, message: error.message, code: error.code, status: error.status });
      } finally {
        sqlite.close();
      }
    });
  `,
    {
      eval: true,
      workerData: {
        path: owner.sqlite.name,
        database: createRequire(import.meta.url).resolve('better-sqlite3'),
        modules: [
          new URL('../../dist/storage/nanohost-recovery-native.js', import.meta.url).href,
          new URL('../../dist/storage/worker-control-heartbeat-native.js', import.meta.url).href,
          new URL('../../dist/storage/worker-control-final-status-native.js', import.meta.url).href,
          new URL('../../dist/storage/harness-lifecycle-native.js', import.meta.url).href,
          new URL('../../dist/storage/db.js', import.meta.url).href,
          new URL('../../dist/storage/worker-control-record-native.js', import.meta.url).href,
          new URL('../../dist/storage/worker-storage-binding-native.js', import.meta.url).href,
        ],
      },
    }
  );
  onTestFinished(async () => {
    await worker.terminate();
  });
  async function send(command: object) {
    const replied = once(worker, 'message');
    worker.postMessage(command);
    const [reply] = await replied;
    if (!reply.ok)
      throw Object.assign(new Error(reply.message), { code: reply.code, status: reply.status });
    return reply.result;
  }
  const startup: NanoHostWorkerRecoveryState = {
    version: 1,
    sessionCompatibilityKey: 'original-compatibility',
    startupDeadline,
    heartbeatTimeoutMs: 10_000,
    heartbeatDeadline: startupDeadline,
    lastAcceptedHeartbeatAt: null,
    lastWorkerSequence: null,
    workerProcessKeyHash: null,
    recoveryState: null,
    recoveryDeadline: null,
  };
  if (mode === 'live') {
    await send({ kind: 'initialize', lease, proof: startup });
    await send({ kind: 'heartbeat', lease, input: { sequence: 0, acceptedAt, processKeyHash } });
    await send({ kind: 'heartbeat', lease, input: { sequence: 1, acceptedAt } });
  }
  const read = () => readNanoHostRecoveryLease(owner.sqlite, lease);
  const mutate = (input: NanoHostRecoveryMutation) => send({ kind: 'mutation', input });
  return { owner, target, read, mutate, send };
}

it('reopens the original recovery window, refuses changed process authority and adopts the exact next heartbeat', async () => {
  const f = await fixture();
  const original = f.read();
  const arm = {
    lease,
    expectedSession: original.session,
    expectedRecovery: original.proof,
    kind: 'arm-reconnect',
    observedAt: classifiedAt,
    classifiedAt,
  } as const;
  await f.mutate(arm);
  await f.owner.reopen();
  const after = f.read();
  expect(after.proof).toMatchObject({
    recoveryState: 'awaiting-reconnect',
    recoveryDeadline: expectedRecoveryDeadline,
    lastWorkerSequence: 1,
  });
  await expect(f.mutate(arm)).rejects.toThrow('ownership changed');
  await f.mutate({
    ...arm,
    expectedRecovery: after.proof,
    classifiedAt: '2026-11-21T00:00:30.000Z',
    observedAt: '2026-11-21T00:00:30.000Z',
  });
  expect(f.read().proof).toEqual(after.proof);
  const reconnect = {
    kind: 'heartbeat',
    lease,
    input: {
      sequence: 2,
      acceptedAt: '2026-11-21T00:00:31.000Z',
      reconnectProcessKeyHash: 'c'.repeat(43),
    },
  };
  await expect(f.send(reconnect)).rejects.toThrow('exact reconnect authority');
  expect(f.read().proof).toEqual(after.proof);
  await f.send({
    ...reconnect,
    input: { ...reconnect.input, reconnectProcessKeyHash: processKeyHash },
  });
  expect(f.read().proof).toMatchObject({
    recoveryState: null,
    recoveryDeadline: null,
    lastWorkerSequence: 2,
  });
});

it('refuses a stale target before Native cleanup CAS and retains the exact physical result across reopen', async () => {
  const f = await fixture();
  const original = f.read();
  const first = getNanoHostRuntimeTarget(f.owner, targetId)!;
  const closing = { ...lease, attempt: { ...lease.attempt, phase: 'closing' as const } };
  const pending = {
    lease: closing,
    expectedSession: original.session,
    expectedRecovery: original.proof,
    kind: 'transition',
    toState: 'cleanup-pending',
    target: first,
    observedAt: classifiedAt,
  } as const;
  await f.owner.transition({ ...f.target, kind: 'allocate', observedAt: classifiedAt });
  await f.owner.transition({
    ...f.target,
    kind: 'ready',
    observedAt: classifiedAt,
    connectionGeneration: 2,
    physicalEpoch,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
  });
  await expect(f.mutate(pending)).rejects.toThrow('placement changed');
  expect(f.read()).toEqual(original);
  const second = getNanoHostRuntimeTarget(f.owner, targetId)!;
  await f.mutate({ ...pending, target: second });
  const waiting = f.read();
  expect(waiting.session.state).toBe('cleanup-pending');
  await f.mutate({
    ...pending,
    expectedSession: waiting.session,
    toState: 'physical-cleaned',
    target: second,
  });
  await f.owner.reopen();
  expect(f.read().session).toMatchObject({
    state: 'physical-cleaned',
    physicalCleanedAt: classifiedAt,
  });
  expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, second)).toMatchObject({
    grant: lease.grant,
    target: second,
    observedAt: classifiedAt,
  });
  expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, first)).toBeNull();
  await f.owner.transition({ ...f.target, kind: 'allocate', observedAt: classifiedAt });
  await f.owner.transition({
    ...f.target,
    kind: 'ready',
    observedAt: classifiedAt,
    connectionGeneration: 3,
    physicalEpoch,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
  });
  expect(
    readNanoHostPhysicalCleanupReceipt(
      f.owner.sqlite,
      closing,
      getNanoHostRuntimeTarget(f.owner, targetId)!
    )
  ).toBeNull();
});

const lineage = { workspaceId, threadId, turnId, agentSessionId, packageSnapshotId: inputRef };
const original = { lease, requestId: null };
const binding = { sandboxBindingRef: bindingRef, lineage, tokenHash: 'a'.repeat(64) };

async function queuedSubmission() {
  const f = await fixture('queued');
  const operationId = 'd'.repeat(64);
  const body = canonicalJsonText({
    aepRef: 'session-package',
    contextPackageId: 'context-package',
    contextRef: 'context',
    turnSequence: 0,
    leaseId: attemptId,
    packageSnapshotId: inputRef,
    turnId,
    deadline,
    workspaceId,
    threadId,
    agentSessionId,
    agentSessionRuntimeBindingId: 'session-binding',
    workerControlTokenHash: binding.tokenHash,
    inferenceTokenHash: 'b'.repeat(64),
    capabilityTokenHash: 'c'.repeat(64),
  });
  f.owner.setup((sqlite) => {
    sqlite
      .prepare(`INSERT INTO sandbox_runtime_records (
      sandbox_runtime_id,runtime_target_id,origin_physical_epoch,sandbox_binding_ref,
      sandbox_integration_binding_ref,sandbox_compatibility_key,image_digest,environment_class,
      max_open_sessions,max_harnesses,max_active_turns,lifecycle_state,health_state,drain_state,
      cleanup_state,created_at,updated_at
    ) VALUES ('sandbox',?,?,'sandbox-binding','sandbox-integration','compat','image','local',
      2,2,1,'open','ready','accepting','clean',?,?)`)
      .run(targetId, physicalEpoch, created, created);
    sqlite
      .prepare(`INSERT INTO harness_instance_records (
      harness_instance_id,sandbox_runtime_id,harness_binding_ref,harness_compatibility_key,
      runtime_family,adapter_id,adapter_version,protocol_version,capabilities_json,
      max_open_sessions,max_active_turns,open_session_count,active_turn_count,lifecycle_state,
      drain_state,next_sequence,operation_state,operation_id,operation_sequence,operation,
      command_body_json,command_fingerprint,created_at,updated_at
    ) VALUES ('harness','sandbox','harness-binding','compat','local','adapter','version',1,'[]',
      2,1,1,0,'open','accepting',1,'queued',?,1,'turn.start',?,?,?,?)`)
      .run(operationId, body, sha256Hex(body), created, created);
    sqlite
      .prepare(`INSERT INTO agent_session_runtime_bindings (
      agent_session_runtime_binding_id,harness_instance_id,agent_session_id,workspace_id,thread_id,
      agent_session_compatibility_key,effective_setup_generation,native_handle_state,
      lifecycle_state,next_turn_sequence,cleanup_state,created_at,updated_at,image_digest
    ) VALUES ('session-binding','harness',?,?,?,'compat',1,'ready','open',0,'clean',?,?,'image')`)
      .run(agentSessionId, workspaceId, threadId, created, created);
  });
  const input = {
    lease,
    placement: {
      workspaceId,
      threadId,
      agentSessionId,
      runtimeTargetId: targetId,
      identityId: targetId,
      deploymentId,
      physicalEpoch,
    },
    command: { harnessInstanceId: 'harness', operationId, sequence: 1 },
    observedAt: acceptedAt,
  };
  const submit = (arg = input) => f.send({ kind: 'submit', input: arg });
  return { ...f, input, submit };
}

it('binds only the exact queued submission and preserves the first startup clock across retry', async () => {
  const f = await queuedSubmission();
  await expect(
    f.submit({
      ...f.input,
      command: { ...f.input.command, sequence: 2 },
    })
  ).rejects.toThrow('exact queued command');
  expect(getWorkerBackendSession(f.owner, attemptId)?.state).toBe('materialized');
  expect(readNanoHostWorkerRouteBinding(f.owner, lease.grant)).toBeNull();
  await expect(f.submit()).resolves.toMatchObject({ state: 'launching' });
  await f.owner.reopen();
  const before = f.read();
  expect(before.proof).toMatchObject({
    startupDeadline: '2026-11-21T00:25:00.000Z',
    heartbeatDeadline: '2026-11-21T00:25:00.000Z',
    heartbeatTimeoutMs: 30_000,
    lastWorkerSequence: null,
  });
  expect(before.attempt).toMatchObject({
    workerControlTokenHash: binding.tokenHash,
    workerInferenceTokenHash: 'b'.repeat(64),
    workerCapabilityTokenHash: 'c'.repeat(64),
  });
  await f.submit({ ...f.input, observedAt: classifiedAt });
  expect(f.read()).toEqual(before);
});

function heartbeatPayload(): ControlWorkerHeartbeatCommand {
  return {
    ...binding,
    payload: {
      acceptedAt,
      request: {
        schemaVersion: 2,
        lineage,
        operation: 'heartbeat',
        sequence: 0,
        body: { status: 'starting', processKeyHash },
      },
    },
  };
}

it('accepts liveness only for a new Native heartbeat sequence and rejects conflicting replay', async () => {
  const f = await queuedSubmission();
  await f.submit();
  const input = heartbeatPayload();
  const heartbeat = (command: ControlWorkerHeartbeatCommand) =>
    f.send({ kind: 'worker-heartbeat', original, input: command });
  await expect(heartbeat(input)).resolves.toMatchObject({
    duplicate: false,
    nextExpectedSequence: 1,
  });
  await f.owner.reopen();
  const first = f.read().proof;
  await expect(
    heartbeat({
      ...input,
      payload: { ...input.payload, acceptedAt: classifiedAt },
    })
  ).resolves.toMatchObject({ duplicate: true, nextExpectedSequence: 1 });
  expect(f.read().proof).toEqual(first);
  await expect(
    heartbeat({
      ...input,
      payload: {
        ...input.payload,
        request: {
          ...input.payload.request,
          body: { ...input.payload.request.body, message: 'different' },
        },
      },
    })
  ).rejects.toThrow('already accepted with different content');
  expect(f.read().proof).toEqual(first);

  const observed = inspectNanoHostWorkerBinding(f.owner.sqlite, original, binding);
  expect(observed.status).toBe('accepted');
  if (observed.status === 'accepted')
    expect(nanoHostWorkerBindingLiveness(observed, classifiedAt).status).toBe('accepted');
  expect(
    inspectNanoHostWorkerBinding(f.owner.sqlite, original, {
      ...binding,
      tokenHash: 'b'.repeat(64),
    })
  ).toMatchObject({ status: 'rejected', reason: 'binding-not-found' });
  expect(
    inspectNanoHostWorkerBinding(f.owner.sqlite, original, {
      ...binding,
      lineage: { ...lineage, requestId: 'another-request' },
    })
  ).toMatchObject({ status: 'rejected', reason: 'lineage-mismatch' });
  const closing = inspectNanoHostWorkerBinding(
    f.owner.sqlite,
    {
      ...original,
      lease: { ...lease, attempt: { ...lease.attempt, phase: 'closing' } },
    },
    binding
  );
  expect(closing.status).toBe('accepted');
  if (closing.status === 'accepted')
    expect(nanoHostWorkerBindingLiveness(closing, classifiedAt)).toMatchObject({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
});

it('requires the exact Core final decision and replays only the same retained Native final', async () => {
  const f = await queuedSubmission();
  await f.submit();
  const input: ControlWorkerFinalStatusCommand = {
    ...binding,
    payload: {
      terminalData: { status: 'completed', stopReason: 'end_turn', evidenceManifestDigests: {} },
      sequence: 0,
      acceptedAt,
      eventAcceptedAt: acceptedAt,
    },
  };
  const decision = {
    kind: 'decided',
    grant: lease.grant,
    fingerprint: nanoHostWorkerFinalDecisionFingerprint(input),
    acceptedAt,
    eventAcceptedAt: acceptedAt,
  };
  const decided = {
    ...original,
    lease: {
      ...lease,
      attempt: { ...lease.attempt, phase: 'closing', terminalCause: 'worker-final-status' },
    },
  };
  const final = (args: object) =>
    f.send({ kind: 'worker-final', original: decided, input, decision, ...args });
  await expect(
    final({ decision: { ...decision, fingerprint: 'other-occurrence' } })
  ).rejects.toThrow('precondition failed');
  await expect(final({ decision: null })).rejects.toThrow('precondition failed');
  expect(getWorkerControlAcceptedFinalStatus(f.owner, lineage)).toBeNull();
  await expect(final({})).resolves.toMatchObject({
    finalStatusDuplicate: false,
    eventDuplicate: false,
  });
  await f.owner.reopen();
  const settled = getWorkerControlAcceptedFinalStatus(f.owner, lineage);
  expect(settled).toMatchObject({ status: 'completed', acceptedAt });
  const closed = {
    ...decided,
    lease: { ...decided.lease, attempt: { ...decided.lease.attempt, phase: 'closed' } },
  };
  await expect(
    final({ original: closed, decision: { ...decision, kind: 'replay' } })
  ).resolves.toMatchObject({ finalStatusDuplicate: true, eventDuplicate: true });
  const changed = { ...input, payload: { ...input.payload, sequence: 1 } };
  await expect(
    final({
      original: closed,
      input: changed,
      decision: {
        ...decision,
        kind: 'replay',
        fingerprint: nanoHostWorkerFinalDecisionFingerprint(changed),
      },
    })
  ).rejects.toThrow('exact final-status replay');
  expect(getWorkerControlAcceptedFinalStatus(f.owner, lineage)).toEqual(settled);
  f.owner.setup((sqlite) =>
    sqlite.prepare("DELETE FROM worker_control_records WHERE operation='event_append'").run()
  );
  await expect(
    final({ original: closed, decision: { ...decision, kind: 'replay' } })
  ).rejects.toThrow('exact final-status replay');
  expect(
    f.owner.sqlite
      .prepare("SELECT 1 FROM worker_control_records WHERE operation='event_append'")
      .get()
  ).toBeUndefined();
});

async function admitOriginal(prepareWorkspace = false) {
  const f = await queuedSubmission();
  const root = mkdtempSync(join(tmpdir(), 'nanohost-original-binding-'));
  const core = openCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  applyMigrations(core);
  const userId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: userId });
  const actor = { kind: 'user' as const, id: userId };
  const store = prepareWorkspace ? new FsStore({ dataRoot: root }) : null;
  await store
    ?.importWorkspaceSnapshot({
      workspace: {
        id: workspaceId,
        name: 'Native Closeout',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: created,
        updatedAt: created,
      },
      notebookInitialization: {
        requestId: randomUUID(),
        producer: actor,
        instructionReference: 'fixture:native-closeout',
      },
      threads: [],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    })
    .catch((cause: unknown) => {
      throw new Error('Publish exact test Workspace.', { cause });
    });
  const entry = createSchedulerAdmissionEntry(core, {
    queueEntryId: 'native-join-queue',
    backendId: 'nanohost',
    triggerActor: actor,
    workspaceId,
    threadId,
    turnId,
    inputRef: schedulerFixtureInput(workspaceId, turnId, 'Inspect the original Native binding.'),
    requestedAgentId: 'agent_worker',
  });
  const now = () => created;
  createSchedulerExecutionAttempt(core, { entry, attemptId, preparationInput: {}, now });
  bindSchedulerExecutionAttemptSession(core, { attemptId, agentSessionId, now });
  finalizeSchedulerExecutionAttemptInput(core, { attemptId, inputRef, bindingRef, now });
  expect(readRetainedNanoHostSubmission(core, attemptId)).toBeNull();
  const dispatch = () =>
    f.send({
      kind: 'dispatch',
      dataRoot: root,
      input: {
        kind: 'operation.dispatch',
        sandboxIntegrationBindingRef: 'sandbox-integration',
        observedAt: acceptedAt,
      },
    });
  await expect(dispatch()).rejects.toThrow('original admitted submission');
  expect(getWorkerBackendSession(f.owner, attemptId)?.state).toBe('materialized');

  const span = {
    traceId: '1'.repeat(32),
    spanId: '1'.repeat(16),
    flags: 1,
    name: 'original submit',
    kind: 'INTERNAL' as const,
    startTimeUnixNano: BigInt(Date.parse(created)) * 1_000_000n,
    endTimeUnixNano: null,
    status: { code: 'UNSET' as const },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: {
      name: 'nanohost-k8-fixture',
      attributes: [],
      droppedAttributesCount: 0,
    },
    resource: { attributes: [], droppedAttributesCount: 0 },
  };
  const intent: ExecutionJournalIntent = {
    execution: {
      ref: lease.grant.execution,
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
      workId: turnId,
      fingerprint: entry.inputHash,
      exclusionRefs: [`workspace:${workspaceId}`, `thread:${threadId}`, `turn:${turnId}`],
      span,
    },
    stepId: 'original-native-submission',
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: { operation: 'submit', requestId: 'submit-once', sequence: null, bindingRef },
    control: {
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
      kind: 'admit',
      target: { backendKind: 'nanohost', targetId, allocationRef: null },
      workId: turnId,
      operationId,
      attemptId,
      invocationId: operationId,
      actor,
      inputRefs: [inputRef],
      outputRefs: [],
      fingerprint: 'b'.repeat(64),
      permittingDecisionRef: null,
      authorityRefs: [],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    span: { ...span, spanId: '2'.repeat(16), parentSpanId: span.spanId },
  };
  const grant = core.sqlite.transaction(() =>
    recordSchedulerExecutionGrantInDb(
      core,
      {
        proposal: intent,
        attemptId,
        operationId,
        generation: '1',
        submission: true,
        now: () => acceptedAt,
      },
      () => true
    )
  )().grant;
  const retained = readRetainedNanoHostSubmission(core, attemptId);
  expect(retained?.lease.grant).toEqual(grant);
  expect(retained).toBeTruthy();
  const input = { sandboxBindingRef: bindingRef, lineage };
  expect(resolveAdmittedNanoHostWorkerBinding(core, f.owner.sqlite, input, acceptedAt)).toEqual({
    status: 'rejected',
    reason: 'binding-not-found',
  });
  f.owner.setup((sqlite) =>
    sqlite.prepare('UPDATE nanohost_runtime_targets SET connection_generation = 2').run()
  );
  await expect(dispatch()).rejects.toThrow();
  expect(getWorkerBackendSession(f.owner, attemptId)?.state).toBe('materialized');
  expect(readNanoHostWorkerRouteBinding(f.owner, grant)).toBeNull();
  f.owner.setup((sqlite) =>
    sqlite.prepare('UPDATE nanohost_runtime_targets SET connection_generation = 1').run()
  );
  const previousOperationId = '9'.repeat(64);
  const previousResult = (maxActiveTurns: number) =>
    canonicalJsonText({
      schemaVersion: 2,
      harnessInstanceId: f.input.command.harnessInstanceId,
      operationId: previousOperationId,
      sequence: 0,
      disposition: 'succeeded',
      body: {
        state: 'open',
        nativeHandleState: 'pending',
        nativeHandleDigest: null,
        maxActiveTurns,
      },
    });
  const retainPreviousResult = (bytes: string) =>
    f.owner.setup((sqlite) =>
      sqlite
        .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
        .run(bytes, sha256Hex(bytes))
    );
  retainPreviousResult(previousResult(1));
  await expect(dispatch()).resolves.toBeNull();
  const consumed = previousResult(2);
  core.sqlite.transaction(() =>
    recordCoreHarnessConsumption(
      core,
      {
        harnessBindingRef: 'harness-binding',
        operationId: previousOperationId,
        sequence: 0,
        resultFingerprint: sha256Hex(consumed),
      },
      canonicalJsonText({ workspaceId, turnId, executionId: 'open-execution', stepId: 'open' }),
      acceptedAt
    )
  )();
  await expect(dispatch()).rejects.toThrow('retained consumer acknowledgement conflicts');
  expect(getWorkerBackendSession(f.owner, attemptId)?.state).toBe('materialized');
  expect(readNanoHostWorkerRouteBinding(f.owner, grant)).toBeNull();
  retainPreviousResult(consumed);
  await expect(dispatch()).resolves.toMatchObject({
    operation: 'turn.start',
    operationId: f.input.command.operationId,
    sequence: f.input.command.sequence,
  });
  await expect(dispatch()).resolves.toBeNull();
  return { f, root, core, store, actor, input, now, retained };
}

it.each(['accepted', 'expired', 'unavailable'] as const)(
  'handles the exact Native completion observation within the original deadline (%s)',
  async (outcome) => {
    const { f, core, retained } = await admitOriginal();
    const originalDeadline = Date.parse(retained!.lease.grant.deadline);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(originalDeadline - 30);
      let observations = 0;
      const wait = waitForWorkerControlFinalStatus(
        core,
        { attemptId, lineage: { ...lineage, requestId: null } },
        (query) => {
          observations += 1;
          if (outcome === 'unavailable' || observations > 2)
            return { state: 'unavailable', owner: 'nanohost', reason: 'disabled' };
          if (observations === 1 || outcome === 'expired') return { state: 'pending' };
          return { state: 'ready', value: query(f.owner.sqlite) };
        }
      ).then(
        (value) => value,
        (error: unknown) => (error as Error).message
      );
      if (outcome === 'unavailable') {
        await expect(wait).resolves.toBe('NanoHost completion storage is unavailable.');
        expect(observations).toBe(1);
        return;
      }
      if (outcome === 'accepted')
        f.owner.setup((sqlite) =>
          writeWorkerControlAcceptedRecord(
            { sqlite },
            {
              acceptedAt,
              lineage: { ...lineage, requestId: null },
              operation: 'final_status',
              record: { sequence: 9, status: 'completed', stopReason: 'completed' },
              recordKey: '9',
              sequence: 9,
            }
          )
        );
      vi.setSystemTime(originalDeadline);
      if (outcome === 'accepted')
        await expect(wait).resolves.toEqual({
          acceptedAt,
          status: 'completed',
          stopReason: 'completed',
        });
      else await expect(wait).resolves.toBe('Worker lease expired before durable final status.');
      expect(observations).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }
);

it('resolves App and Gateway bindings from the retained Core grant and the admitted Native proof', async () => {
  const { core, f, input, now, root, retained } = await admitOriginal();
  expect(
    resolveAdmittedNanoHostWorkerBinding(core, f.owner.sqlite, input, acceptedAt)
  ).toMatchObject({ status: 'accepted', attempt: { attemptId } });
  expect(resolveAdmittedNanoHostFinalBinding(core, f.owner.sqlite, input, acceptedAt)).toEqual({
    status: 'accepted',
    replayOnly: false,
  });
  const heartbeat = (input: ControlWorkerHeartbeatCommand) =>
    f.send({ kind: 'pinned-heartbeat', dataRoot: root, input });
  await expect(heartbeat(heartbeatPayload())).resolves.toMatchObject({
    duplicate: false,
    nextExpectedSequence: 1,
  });
  const sequence = {
    ...binding,
    payload: {
      kind: 'sequence',
      operation: 'supply_refresh_ack',
      sequence: 0,
      fingerprint: canonicalJsonText({
        lineage,
        sequence: 0,
        refreshId: 'refresh',
        status: 'applied',
      }),
    },
  } satisfies ControlWorkerRecordCommand;
  const record = (input: ControlWorkerRecordCommand) =>
    f.send({ kind: 'pinned-record', dataRoot: root, input, observedAt: classifiedAt });
  await expect(record({ ...sequence, tokenHash: 'b'.repeat(64) })).rejects.toMatchObject({
    code: 'worker_control_unauthorized',
    status: 401,
  });
  await expect(
    record({ ...sequence, lineage: { ...lineage, requestId: 'another-request' } })
  ).rejects.toMatchObject({ code: 'worker_control_lineage_mismatch', status: 403 });
  const first = heartbeatPayload();
  const running = {
    ...first.payload.request,
    sequence: 1,
    body: { status: 'running' as const },
  };
  await expect(
    heartbeat({ ...first, payload: { acceptedAt, request: running } })
  ).resolves.toMatchObject({ duplicate: false, nextExpectedSequence: 2 });
  const arm = f.read();
  expect(arm.proof.lastWorkerSequence).toBe(1);
  await f.mutate({
    kind: 'arm-reconnect',
    lease: retained!.lease,
    expectedSession: arm.session,
    expectedRecovery: arm.proof,
    classifiedAt,
    observedAt: classifiedAt,
  });
  await expect(record(sequence)).rejects.toMatchObject({
    code: 'worker_control_reconnect_required',
    status: 503,
  });
  await expect(
    heartbeat({
      ...first,
      payload: {
        acceptedAt: classifiedAt,
        reconnectProcessKeyHash: processKeyHash,
        request: { ...running, sequence: 2 },
      },
    })
  ).resolves.toMatchObject({ duplicate: false, nextExpectedSequence: 3 });
  await expect(record(sequence)).resolves.toEqual({
    kind: 'sequence',
    duplicate: false,
    nextExpectedSequence: 1,
  });
  const readReceipts = () =>
    f.owner.sqlite
      .prepare(`SELECT record_json, accepted_at FROM worker_control_records
      WHERE operation = 'supply_refresh_ack'`)
      .all();
  expect(readReceipts()).toEqual([]);
  const receipt = {
    ...binding,
    payload: {
      kind: 'record',
      operation: 'supply_refresh_ack',
      recordKey: '0',
      sequence: 0,
      acceptedAt: classifiedAt,
      record: {
        sequence: 0,
        refreshId: 'refresh',
        status: 'applied',
        message: null,
        acknowledgedAt: classifiedAt,
      },
    },
  } satisfies ControlWorkerRecordCommand;
  await expect(record(receipt)).resolves.toEqual({ kind: 'record' });
  await f.owner.reopen();
  await expect(record(sequence)).resolves.toMatchObject({ duplicate: true });
  await expect(record(receipt)).resolves.toEqual({ kind: 'record' });
  expect(readReceipts()).toEqual([
    { record_json: JSON.stringify(receipt.payload.record), accepted_at: classifiedAt },
  ]);
  markSchedulerExecutionAttemptClosing(core, { attemptId, cause: 'turn-cancelled', now });
  await expect(record(sequence)).rejects.toMatchObject({
    code: 'worker_control_lease_not_live',
    status: 403,
  });
  expect(resolveAdmittedNanoHostWorkerBinding(core, f.owner.sqlite, input, acceptedAt)).toEqual({
    status: 'rejected',
    reason: 'attempt-not-live',
  });
  expect(resolveAdmittedNanoHostFinalBinding(core, f.owner.sqlite, input, acceptedAt)).toEqual({
    status: 'accepted',
    replayOnly: false,
    cancellationOnly: true,
  });
});

it.each(['completed', 'lost-result', 'contradictory-result'] as const)(
  'uses the original Workspace cleanup result for the Native release receipt (%s)',
  async (outcome) => {
    const { actor, core, f, root, store: fixtureStore } = await admitOriginal(true);
    const store = fixtureStore!;
    const workspace = createTestWorkspaceDb(root, workspaceId);
    onTestFinished(() => workspace.sqlite.close());
    await expect(
      store.createThread(workspaceId, 'Original closeout', threadId)
    ).resolves.toMatchObject({ id: threadId });
    await expect(
      store.createTurn(workspaceId, threadId, 'Complete the original cleanup.', actor, null, {
        turnId,
      })
    ).resolves.toMatchObject({ id: turnId });
    await store.createAgentSession({
      agentId: 'agent_worker',
      createdAt: created,
      environmentPackageSnapshotId: inputRef,
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId,
      updatedAt: created,
      workspaceId,
    });
    await store.updateTurn(turnId, { agentSessionId });
    const prepared = await recordTestAgentEnvironmentPackage(workspace, {
      suffix: 'native-live-closeout',
      triggerActor: actor,
      workspaceInputIds: [],
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...prepared,
      snapshotId: inputRef,
      scope: { ...prepared.scope, workspaceId, threadId, turnId, agentSessionId, requestId: null },
    });
    const session = f.read().session;
    const intents = prepareWorkerTurnJournalIntents(
      workspace,
      environmentPackage,
      requireSchedulerExecutionAttempt(core, attemptId),
      { backendKind: 'openshell', targetId, allocationRef: bindingRef }
    );
    for (const intent of intents) {
      await expect(
        store.writeWorkspaceExecutionJournalIntent(workspaceId, intent)
      ).resolves.toMatchObject({ state: 'intent' });
    }
    markSchedulerExecutionAttemptClosing(core, {
      attemptId,
      cause: 'turn-completed',
      now: () => classifiedAt,
    });
    const retained = readRetainedNanoHostSubmission(core, attemptId)!;
    const target = getNanoHostRuntimeTarget(f.owner, targetId)!;
    const commit = vi.fn(async (mutation: NanoHostRecoveryMutation) => {
      if (mutation.kind === 'finish-cleanup')
        expect(listWorkspaceRuntimeEvidence(workspace, workspaceId)).toContainEqual(
          expect.objectContaining({ phase: 'teardown', turnId, completedAt: classifiedAt })
        );
      return { state: 'ready' as const, value: await f.mutate(mutation) };
    });
    const cleanupSession = vi.fn(async () => {
      if (outcome === 'lost-result') throw new Error('original cleanup acknowledgement lost');
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: { cleanupSession } as unknown as WorkerGovernanceBackend,
      coreDb: core,
      readNanoHostEnvironment: (read) => ({ state: 'ready', value: read(f.owner.sqlite) }),
      commitNanoHostCloseout: commit,
      now: () => classifiedAt,
    });
    const lifecycle = {
      identity: { ...session, backendKind: 'openshell' as const },
      physicalCleanedAt: null,
      session,
      workspaceHandoffState: session.workspaceHandoffState,
    };
    const clean = () =>
      // biome-ignore lint/complexity/useLiteralKeys: Exercise the existing owner closeout entry directly.
      executor['cleanupBackendLifecycle'](store, lifecycle, workspace, environmentPackage, {
        kind: 'openshell',
        capabilities: [],
        dynamicCapabilities: [],
      });
    if (outcome === 'contradictory-result') {
      const settle = store.settleWorkspaceExecutionJournalStep.bind(store);
      vi.spyOn(store, 'settleWorkspaceExecutionJournalStep').mockImplementation(
        (id, input, consume) => settle(id, { ...input, outputRefs: ['another-backend'] }, consume)
      );
    }
    if (outcome === 'completed') {
      await expect(clean()).resolves.toBeUndefined();
      expect(
        commit.mock.calls.map(([stage]) =>
          stage.kind === 'transition' ? stage.toState : stage.kind
        )
      ).toEqual(['cleanup-pending', 'physical-cleaned', 'finish-cleanup']);
      await f.owner.reopen();
      expect(
        readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, retained.lease, target)
      ).toMatchObject({
        grant: retained.lease.grant,
        session: { state: 'cleaned', backendSessionId: session.backendSessionId },
        observedAt: classifiedAt,
      });
    } else {
      await expect(clean()).rejects.toThrow(
        outcome === 'lost-result'
          ? 'original cleanup acknowledgement lost'
          : 'cleanup requires recovery'
      );
      expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, retained.lease, target)).toBeNull();
      await expect(clean()).rejects.toThrow('cleanup requires recovery');
    }
    expect(cleanupSession).toHaveBeenCalledExactlyOnceWith(lifecycle.identity);
    expect(
      commit.mock.calls.every(
        ([mutation]) => canonicalJsonText(mutation.lease) === canonicalJsonText(retained.lease)
      )
    ).toBe(true);
  }
);

it('keeps a physical cleanup receipt fenced until the original Workspace handoff completes', async () => {
  const f = await fixture();
  f.owner.setup((sqlite) =>
    sqlite
      .prepare(
        "UPDATE worker_backend_sessions SET workspace_handoff_state = 'pending' WHERE attempt_id = ?"
      )
      .run(attemptId)
  );
  const target = getNanoHostRuntimeTarget(f.owner, targetId)!;
  const closing = { ...lease, attempt: { ...lease.attempt, phase: 'closing' as const } };
  const expected = () => {
    const { session, proof } = f.read();
    return {
      lease: closing,
      expectedSession: session,
      expectedRecovery: proof,
      observedAt: classifiedAt,
    };
  };
  await f.mutate({ ...expected(), kind: 'transition', toState: 'cleanup-pending', target });
  await f.mutate({ ...expected(), kind: 'transition', toState: 'physical-cleaned', target });
  await expect(f.mutate({ ...expected(), kind: 'finish-cleanup' })).rejects.toThrow(
    'Workspace handoff'
  );
  expect(f.read().session.state).toBe('physical-cleaned');
  await f.mutate({ ...expected(), kind: 'workspace-handoff' });
  await expect(f.mutate({ ...expected(), kind: 'finish-cleanup' })).resolves.toMatchObject({
    state: 'cleaned',
  });
  await f.owner.reopen();
  expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, target)).toMatchObject({
    observedAt: classifiedAt,
  });
});

it('compares the current Core Scheduler rows before purging the exact Native association', async () => {
  const f = await fixture();
  const root = mkdtempSync(join(tmpdir(), 'openkit-m2-purge-'));
  const core = openCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  applyMigrations(core);
  const userId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({
    coreDb: core,
    workspaceId,
    ownerUserId: userId,
    now: new Date(created),
  });
  let storageRef = '';
  f.owner.setup((sqlite) => {
    storageRef = createWorkerStorageBinding(
      { sqlite },
      {
        deploymentId,
        runtimeTargetId: targetId,
        workspaceId,
        now: created,
        layout: {
          family: 'openkit-worker',
          version: '1',
          uid: 1000,
          gid: 1000,
          workingDirectory: '/workspace',
          platform: { architecture: 'amd64', os: 'linux' },
          targets: [{ target: '/workspace' }],
        },
      }
    ).storageRef;
  });
  const idle = getWorkerStorageBinding(f.owner, { storageRef })!;
  const earlier = workerStorageSchedulerRows(core, storageRef, workspaceId);
  expect(earlier).toEqual([]);
  const mark = () =>
    f.send({
      kind: 'storage-purge',
      dataRoot: root,
      input: {
        kind: 'purge-pending',
        storageRef,
        expectedRevision: idle.revision,
        schedulerRows: earlier,
        now: created,
      },
    });
  const entry = createSchedulerAdmissionEntry(core, {
    queueEntryId: 'after-purge-absence',
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: userId },
    workspaceId,
    threadId,
    turnId,
    inputRef: schedulerFixtureInput(workspaceId, turnId, 'Retain the exact Worker storage.'),
    requestedAgentId: 'agent_worker',
    workerStorageChoice: {
      kind: 'selected',
      expectedRevision: idle.revision,
      storageRef,
      purpose: 'work',
      goalId: null,
      taskId: null,
    },
  });
  expect(workerStorageSchedulerRows(core, storageRef, workspaceId)).toHaveLength(1);
  await expect(mark()).rejects.toMatchObject({ code: 'purge_blocked' });
  expect(getWorkerStorageBinding(f.owner, { storageRef })).toEqual(idle);
  core.sqlite
    .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
    .run(entry.queueEntryId);
  await expect(mark()).resolves.toMatchObject({
    state: 'purge-pending',
    revision: idle.revision + 1,
  });
  await f.send({
    kind: 'storage-purge',
    dataRoot: root,
    input: {
      kind: 'purge-settle',
      storageRef,
      expectedRevision: idle.revision + 1,
      outcome: 'unknown',
      now: classifiedAt,
    },
  });
  await f.owner.reopen();
  expect(getWorkerStorageBinding(f.owner, { storageRef })).toMatchObject({
    state: 'unknown',
    revision: idle.revision + 2,
  });
});

it('retries the exact terminal release after Workspace ACK and admits only the qualified next Turn', async () => {
  const { actor, core, f, root, store: fixtureStore, retained } = await admitOriginal(true);
  const store = fixtureStore!;
  const workspace = createTestWorkspaceDb(root, workspaceId);
  onTestFinished(() => workspace.sqlite.close());
  await store.createThread(workspaceId, 'Terminal release', threadId);
  const turn = await store.createTurn(workspaceId, threadId, 'Original Turn', actor, null, {
    turnId,
  });
  await store.createAgentSession({
    agentId: 'agent_worker',
    createdAt: created,
    environmentPackageSnapshotId: inputRef,
    id: agentSessionId,
    message: null,
    status: 'busy',
    threadId,
    updatedAt: created,
    workspaceId,
  });
  await store.updateTurn(turnId, { agentSessionId });
  const prepared = await recordTestAgentEnvironmentPackage(workspace, {
    suffix: 'native-terminal-release',
    triggerActor: actor,
    workspaceInputIds: [],
  });
  const pkg = AgentEnvironmentPackageSchema.parse({
    ...prepared,
    snapshotId: inputRef,
    scope: { ...prepared.scope, workspaceId, threadId, turnId, agentSessionId, requestId: null },
  });
  const [materialize, terminal, release] = prepareWorkerTurnJournalIntents(
    workspace,
    pkg,
    retained!.lease.attempt,
    { backendKind: 'openshell', targetId, allocationRef: bindingRef }
  );
  for (const intent of [materialize!, terminal!, release!])
    await store.writeWorkspaceExecutionJournalIntent(workspaceId, intent);
  await endWorkerTurnJournalStep(store, workspace, materialize!, 'completed');
  const collect = async (operation: string) => {
    const intent = await beginWorkerTurnJournalStep(store, workspace, turnId, 'collect', {
      operation,
      requestId: turnId,
      sequence: null,
      bindingRef,
    });
    await endWorkerTurnJournalStep(store, workspace, intent, 'completed');
    return intent;
  };
  const evidence = await collect('worker.collect.transcript');
  const collection = await collect('worker.collect.capture');
  const output = await collect('worker.collect.publication');
  const consumeKey = {
    harnessBindingRef: 'harness-binding',
    operationId: f.input.command.operationId,
    sequence: f.input.command.sequence,
    resultFingerprint: 'd'.repeat(64),
  };
  const consume: ExecutionJournalIntent = {
    ...materialize!,
    stepId: 'release-consume',
    carriage: {
      operation: 'turn.start',
      requestId: consumeKey.operationId,
      sequence: consumeKey.sequence,
      bindingRef: consumeKey.harnessBindingRef,
    },
    control: {
      ...materialize!.control,
      kind: 'consume-receipt',
      invocationId: 'release-consume',
      inputRefs: [consumeKey.resultFingerprint],
    },
    span: { ...materialize!.span, spanId: 'd'.repeat(16) },
  };
  await store.writeWorkspaceExecutionJournalIntent(workspaceId, consume);
  const execution = release!.execution.ref;
  core.sqlite.transaction(() =>
    recordCoreHarnessConsumption(
      core,
      consumeKey,
      JSON.stringify({
        workspaceId,
        turnId,
        executionId: execution.executionId,
        stepId: consume.stepId,
      }),
      acceptedAt
    )
  )();
  await endWorkerTurnJournalStep(store, workspace, consume, 'completed', [
    consumeKey.resultFingerprint,
  ]);

  const { grant } = retained!.lease;
  const finalInput: ControlWorkerFinalStatusCommand = {
    ...binding,
    payload: {
      terminalData: { status: 'completed', stopReason: 'end_turn', evidenceManifestDigests: {} },
      sequence: 2,
      acceptedAt,
      eventAcceptedAt: acceptedAt,
    },
  };
  const finalDecision = core.sqlite.transaction(() =>
    admitNanoHostWorkerFinalInDb(core, finalInput, f.owner.sqlite)
  )();
  await f.send({
    kind: 'worker-final',
    original: readRetainedNanoHostSubmission(core, attemptId)!,
    input: finalInput,
    decision: finalDecision,
  });
  expect(
    core.sqlite.transaction(() =>
      observeAcceptedNanoHostFinalInDb(core, finalInput, f.owner.sqlite)
    )()
  ).toMatchObject({ state: 'applied' });
  const closing = readRetainedNanoHostSubmission(core, attemptId)!.lease;
  const target = getNanoHostRuntimeTarget(f.owner, targetId)!;
  const cleanedAt = new Date().toISOString();
  const originalFence = `worker-backend:${attemptId}:${cleanedAt}`;
  const coveredScopeRefs = [...readExecutionJournalRoot(core, grant.execution).exclusionRefs];
  const backendRelease = vi.fn(
    async (input: Parameters<WorkerGovernanceBackend['release']>[0]) => ({
      ...input,
      state: 'released' as const,
      fenceRef: originalFence,
    })
  );
  const descriptor = (intent: ExecutionJournalIntent) => {
    const ref = { execution, stepId: intent.stepId };
    return nanoHostTerminalReleaseWorkspaceStep(
      readExecutionJournalEndedStep(workspace, ref),
      readExecutionJournalInvocation(workspace, ref).carriage
    );
  };
  const decide = (originalAttemptId: string, fenceRef: string) => {
    expect(originalAttemptId).toBe(attemptId);
    expect(fenceRef).toBe(originalFence);
    expect(readExecutionJournalRoot(workspace, execution)).toMatchObject({ phase: 'closed' });
    const input = {
      attemptId: originalAttemptId,
      fenceRef,
      target: {
        targetId: target.targetId,
        identityId: target.identityId,
        deploymentId: target.deploymentId,
        connectionGeneration: target.connectionGeneration,
        physicalEpoch,
      },
      workspaceExecutionId: execution.executionId,
      coveredScopeRefs,
      workspaceSteps: {
        terminal: descriptor(terminal!),
        output: descriptor(output),
        evidence: descriptor(evidence),
        collection: descriptor(collection),
        consume: descriptor(consume),
        release: descriptor(release!),
      },
    };
    const result = core.sqlite
      .transaction(() =>
        releaseCoreNanoHostTerminalInDb(core, input, {
          workspace,
          native: f.owner.sqlite,
          verifyDrainAndRevocation: (original) =>
            verifyNanoHostTerminalDrainAndRevocation(f.owner.sqlite, original),
        })
      )
      .immediate();
    if (result.state !== 'settled')
      throw new Error(`Exact Native terminal release is held (${result.state}).`);
    expect(inspectCoreNanoHostTerminalRelease(core, input)).toEqual(result);
  };
  const releaseTerminalScopes = vi.fn(async (id: string, fence: string) => decide(id, fence));
  const executor = new WorkerGovernanceTurnExecutor({
    backend: {
      release: backendRelease,
      cleanupSession: async () => {},
    } as unknown as WorkerGovernanceBackend,
    coreDb: core,
    readNanoHostEnvironment: f.owner.storage.owner.read,
    releaseTerminalScopes,
    commitNanoHostCloseout: async (mutation) => ({
      state: 'ready',
      value: await f.mutate(mutation),
    }),
    now: () => cleanedAt,
  });
  const { session } = readNanoHostRecoveryLease(f.owner.sqlite, closing);
  // biome-ignore lint/complexity/useLiteralKeys: Exercise the original cleanup and Workspace evidence writer.
  await executor['cleanupBackendLifecycle'](
    store,
    {
      identity: { ...session, backendKind: 'openshell' },
      physicalCleanedAt: null,
      session,
      workspaceHandoffState: session.workspaceHandoffState,
    },
    workspace,
    pkg,
    { kind: 'openshell', capabilities: [], dynamicCapabilities: [] }
  );
  f.owner.setup((sqlite) => {
    sqlite.prepare("UPDATE harness_instance_records SET operation_state='settled'").run();
    sqlite.prepare("UPDATE agent_session_runtime_bindings SET cleanup_state='pending'").run();
  });
  // biome-ignore lint/complexity/useLiteralKeys: Exercise the original product terminal publication.
  await executor['completeTurn'](store, turn, agentSessionId, null);
  expect(store.getTurnById(turnId).status).toBe('completed');
  const successorTurn = testEntityId('tu', 'native-release-successor');
  const nextEntry = createSchedulerAdmissionEntry(core, {
    backendId: 'nanohost',
    queueEntryId: 'native-release-successor',
    workspaceId,
    threadId,
    turnId: successorTurn,
    inputRef: schedulerFixtureInput(workspaceId, successorTurn, 'Next Turn'),
    triggerActor: actor,
    requestedAgentId: pkg.agent.agentId,
  });
  const place = () =>
    createSchedulerExecutionAttempt(core, { entry: nextEntry, preparationInput: {} });
  const close = () =>
    // biome-ignore lint/complexity/useLiteralKeys: The live and restart owner share this closeout entry.
    executor['releaseTerminalAttempt'](store, attemptId, pkg);
  expect(place).toThrow('Execution placement has an unresolved writer.');
  await expect(close()).rejects.toThrow('Exact Native terminal release is held (unknown).');
  expect(releaseTerminalScopes).toHaveBeenCalledExactlyOnceWith(attemptId, originalFence);
  expect(requireSchedulerExecutionAttempt(core, attemptId)).toMatchObject({
    phase: 'closed',
    fenceRef: originalFence,
  });
  expect(place).toThrow('Execution placement has an unresolved writer.');
  f.owner.setup((sqlite) =>
    sqlite.prepare("UPDATE agent_session_runtime_bindings SET cleanup_state='clean'").run()
  );
  await f.owner.reopen();
  const original = readRetainedNanoHostSubmission(core, attemptId)!.lease;
  const verify = () => verifyNanoHostTerminalDrainAndRevocation(f.owner.sqlite, original);
  expect(verify()).toBe(true);
  expect(
    verifyNanoHostTerminalDrainAndRevocation(f.owner.sqlite, {
      ...original,
      attempt: { ...original.attempt, phase: 'closing' },
    })
  ).toBe(false);
  f.owner.setup((sqlite) =>
    sqlite.prepare('UPDATE agent_session_runtime_bindings SET current_attempt_id=?').run(attemptId)
  );
  expect(verify()).toBe(false);
  f.owner.setup((sqlite) =>
    sqlite.prepare('UPDATE agent_session_runtime_bindings SET current_attempt_id=NULL').run()
  );
  await expect(close()).resolves.toBeUndefined();
  expect(place()).toMatchObject({ turnId: successorTurn, phase: 'open' });
  await expect(close()).resolves.toBeUndefined();
  expect(backendRelease).toHaveBeenCalledTimes(1);
  expect(releaseTerminalScopes.mock.calls).toEqual([
    [attemptId, originalFence],
    [attemptId, originalFence],
    [attemptId, originalFence],
  ]);
  expect(resolveAdmittedNanoHostWorkerBinding(core, f.owner.sqlite, binding)).toEqual({
    status: 'rejected',
    reason: 'attempt-not-live',
  });
});
