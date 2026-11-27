import { createHash, randomUUID } from 'node:crypto';
// openkit-test-platform: posix
import { once } from 'node:events';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { canonicalJsonText } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { WorkerCanonicalEventRecord } from '@openkit/worker-protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  type BootNanoHostCleanupOwners,
  bindBootNanoHostAttemptRecovery,
  cleanupNanoHostPreparation,
} from '../bootstrap/nanohost-recovery.js';
import { FsStore } from '../lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  inspectCoreHarnessConsumption,
  recordCoreHarnessConsumption,
  settleCoreIdleJournal,
} from '../runtime/core-journal-records.js';
import {
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithFence,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionGrantInDb,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import {
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  CORE_SCHEDULER_EXECUTION_DEFINITION,
  executionJournalProcessWitness,
  readExecutionJournalEndedStep,
  readExecutionJournalInvocation,
  readExecutionJournalRoot,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import { readConsumedIdleDelete } from '../runtime/execution-reconciler.js';
import type { ExecutionJournalIntent } from '../runtime/execution-step-journal.js';
import { requireHarnessLoginBinding } from '../runtime/harness-login-authority.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  runNanoHostAttemptRecoveryMaintenance,
} from '../runtime/nanohost-attempt-recovery.js';
import {
  nanoHostHarnessCompatibilityKey,
  nanoHostSandboxCompatibilityKey,
} from '../runtime/nanohost-compatibility.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
} from '../runtime/nanohost-effect-identity.js';
import {
  type AdmittedNanoHostHarnessTurnLifecycle,
  claimNanoHostIdleSandboxDrain,
  restoreNanoHostSandboxAdmissionIfSafe,
  type WriteNanoHostIdleSandboxLifecycle,
} from '../runtime/nanohost-harness.js';
import {
  deriveNanoHostAgentSessionCompatibilityKey,
  inspectNanoHostAgentSessionContinuity,
  inspectNanoHostIdleCloseConsumption,
} from '../runtime/nanohost-harness-records.js';
import {
  getNanoHostRuntimeTarget,
  NanoHostCleanupFencePendingError,
} from '../runtime/nanohost-runtime-target-records.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from '../runtime/nanohost-session-dispatch.js';
import {
  listWorkspaceRuntimeEvidence,
  recordWorkerBackendTeardownEvidence,
} from '../runtime/runtime-evidence.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import {
  getWorkerBackendSession,
  readNanoHostWorkerRouteBinding,
} from '../runtime/worker-backend-session-records.js';
import {
  getWorkerControlAcceptedFinalStatus,
  waitForWorkerControlFinalStatus,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import {
  acceptWorkerControlSequence,
  inspectNanoHostWorkerFinalSequences,
  workerFinalSequenceInputs,
} from '../runtime/worker-control-sequences.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  beginWorkerTurnJournalStep,
  endWorkerTurnJournalStep,
  prepareWorkerTurnJournalIntents,
  WorkerGovernanceTurnExecutor,
} from '../runtime/worker-governance-turn-executor.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  reserveWorkerStorageAttachment,
  workerStorageSchedulerRows,
} from '../runtime/worker-storage-binding-records.js';
import {
  releaseWorkerStorageAttachment,
  type WriteNanoHostStorageRelease,
} from '../runtime/worker-storage-bindings.js';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import {
  acceptWorkspaceBaseline,
  authorizeWorkspaceBaselineInitialization,
  preserveRawWorkspaceCapture,
  readWorkspaceCollection,
} from '../runtime/workspace-snapshot-chain.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import {
  createTestAgentSetup,
  recordTestAgentEnvironmentPackage,
} from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { createTestWorkspaceDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { commandInputHash } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  type NanoHostOwnerBinding,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { hashNanoHostRecoveryObservation } from './control-store-worker-protocol.js';
import {
  admitNanoHostWorkerFinalInDb,
  applyCoreNanoHostRecoveryReleaseInDb,
  closeNanoHostFailedStartInDb,
  commitCoreNanoHostOrphanAuditInDb,
  inspectAcceptedNanoHostFinalInDb,
  inspectCoreNanoHostOrphanAudit,
  inspectCoreNanoHostTerminalRelease,
  nanoHostTerminalReleaseWorkspaceStep,
  observeAcceptedNanoHostFinalInDb,
  releaseCoreNanoHostTerminalInDb,
  verifyNanoHostCleanupSubmitPlacement,
} from './core-journal-native.js';
import { openAdmittedWorkspaceReadDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  type NanoHostRecoveryLease,
  type NanoHostRecoveryMutation,
  type NanoHostWorkerRecoveryState,
  prepareNanoHostCleanupOccurrence,
  readNanoHostCleanupOnly,
  readNanoHostOrphanCleanup,
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
import {
  type ControlWorkerFinalStatusCommand,
  WorkerFinalStatusRefusal,
} from './worker-control-final-status-codecs.js';
import type { ControlWorkerHeartbeatCommand } from './worker-control-heartbeat-codecs.js';
import type { ControlWorkerRecordCommand } from './worker-control-record-codecs.js';
import { nativeProductScope } from './workspace-file-records.js';

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
        const [native, heartbeat, final, harness, db, record, storage, journal, protocol, idle] = await modules;
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
          if (command.kind === 'storage-release')
            return storage.applyControlWorkerStorageBinding({ sqlite }, command.input);
          if (command.kind === 'pinned-recovery') {
            const core = db.openCoreReadDb(command.dataRoot);
            const workspace = command.input.cleanupResult?.kind === 'workspace-cleaned'
              ? db.openAdmittedWorkspaceReadDb(command.dataRoot, command.input.lease.attempt.workspaceId)
              : null;
            try {
              const apply = () => core.sqlite.transaction(() => native.applyNanoHostRecoveryMutation(
                sqlite, command.input,
                (session) => journal.verifyNanoHostCleanupSubmitPlacement(core, sqlite, command.input.lease, session),
                {
                  readIdleDelete: (session) => idle.readConsumedIdleDelete(core, session),
                  verifyWorkspaceCleanup: (proof, session) =>
                    workspace !== null &&
                    native.matchesNanoHostCleanupInspection(workspace, proof, session, 'completed'),
                }
              )).deferred();
              return workspace ? workspace.sqlite.transaction(apply).deferred() : apply();
            } finally {
              workspace?.sqlite.close();
              core.sqlite.close();
            }
          }
          if (command.kind === 'retire-audited-orphan') {
            const core = db.openCoreReadDb(command.dataRoot);
            try {
              return core.sqlite.transaction(() => {
                const { input, audit } = command;
                const { session, proof } = native.readNanoHostRecoveryLease(sqlite, input.lease);
                return native.applyNanoHostAuditedOrphanRetirement(
                  sqlite, input, audit,
                  protocol.hashNanoHostRecoveryObservation({ lease: input.lease, session, proof }),
                  (original) => journal.verifyNanoHostCleanupSubmitPlacement(core, sqlite, input.lease, original),
                  (cleanup) => journal.inspectCoreNanoHostOrphanAudit(core, cleanup)
                );
              }).deferred();
            } finally {
              core.sqlite.close();
            }
          }
          if (['dispatch', 'mixed-harness', 'idle-sandbox', 'pinned-heartbeat', 'pinned-record'].includes(command.kind)) {
            const coreDb = db.openCoreReadDb(command.dataRoot);
            try {
              return coreDb.sqlite.transaction(() => {
                if (command.kind === 'pinned-heartbeat')
                  return heartbeat.applyControlWorkerHeartbeat({ sqlite, coreDb, input: command.input });
                if (command.kind === 'pinned-record')
                  return record.applyControlWorkerRecord({
                    sqlite, coreDb, input: command.input, observedAt: command.observedAt,
                  });
                return harness.applyControlHarnessLifecycle(
                  { sqlite }, command.input, { coreDb, idleSandbox: command.authority }
                );
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
          if (command.kind === 'component-physical')
            return native.applyNanoHostRecoveryMutation(sqlite, command.input, () => true);
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
          new URL('../../dist/storage/core-journal-native.js', import.meta.url).href,
          new URL('../../dist/storage/control-store-worker-protocol.js', import.meta.url).href,
          new URL('../../dist/runtime/execution-reconciler.js', import.meta.url).href,
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

/** Gives the fixture the backend identity used by the original fixed-effect request derivation. */
function setCleanupBackendId(f: Awaited<ReturnType<typeof fixture>>) {
  f.owner.setup((sqlite) =>
    sqlite
      .prepare('UPDATE worker_backend_sessions SET backend_session_id = ? WHERE attempt_id = ?')
      .run('nh-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb', attemptId)
  );
}

it('reopens the original recovery window, refuses changed process authority and adopts the exact next heartbeat', async () => {
  const f = await fixture();
  const setTargetEpoch = (epoch: string | null) => {
    const ready = Number(epoch !== null);
    f.owner.setup((sqlite) =>
      sqlite
        .prepare(`UPDATE nanohost_runtime_targets
          SET connection_generation = 2, ready = ?, fresh_empty = ?, physical_epoch = ?`)
        .run(ready, ready, epoch)
    );
  };
  setTargetEpoch(null);
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
  const exact = {
    ...reconnect,
    input: { ...reconnect.input, reconnectProcessKeyHash: processKeyHash },
  };
  await expect(f.send(exact)).rejects.toThrow('exact reconnect authority');
  setTargetEpoch('f'.repeat(64));
  await expect(f.send(exact)).rejects.toThrow('exact reconnect authority');
  setTargetEpoch(physicalEpoch);
  await expect(f.send(reconnect)).rejects.toThrow('exact reconnect authority');
  await expect(f.send({ ...exact, input: { ...exact.input, sequence: 3 } })).rejects.toThrow(
    'exact reconnect authority'
  );
  await expect(
    f.send({ ...exact, input: { ...exact.input, acceptedAt: expectedRecoveryDeadline } })
  ).rejects.toThrow('exact reconnect authority');
  expect(f.read().proof).toEqual(after.proof);
  await f.send(exact);
  expect(f.read().proof).toMatchObject({
    recoveryState: null,
    recoveryDeadline: null,
    lastWorkerSequence: 2,
  });
});

it('refuses a stale target before Native cleanup CAS and retains the exact physical result across reopen', async () => {
  const f = await fixture();
  setCleanupBackendId(f);
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
  const occurrence = prepareNanoHostCleanupOccurrence(original.session, second, 'sandbox.delete');
  await f.send({
    kind: 'component-physical',
    input: { ...pending, target: second, cleanupOccurrence: occurrence },
  });
  const waiting = f.read();
  expect(waiting.session.state).toBe('cleanup-pending');
  await f.send({
    kind: 'component-physical',
    input: {
      ...pending,
      expectedSession: waiting.session,
      expectedRecovery: waiting.proof,
      toState: 'physical-cleaned',
      target: second,
      cleanupResult: { kind: 'deleted', requestId: occurrence.deleteRequestId },
    },
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
  const third = getNanoHostRuntimeTarget(f.owner, targetId)!;
  expect(
    readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, third, () => true)
  ).toMatchObject({
    grant: lease.grant,
    cleanup: { connectionGeneration: 2, physicalEpoch, observedAt: classifiedAt },
    target: third,
  });
  expect(
    readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, third, () => false)
  ).toBeNull();
  expect(
    readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, second, () => true)
  ).toBeNull();
});

const lineage = { workspaceId, threadId, turnId, agentSessionId, packageSnapshotId: inputRef };
const original = { lease, requestId: null };
const binding = { sandboxBindingRef: bindingRef, lineage, tokenHash: 'a'.repeat(64) };

async function queuedSubmission(seedHarness = true) {
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
  if (seedHarness)
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

async function admitOriginal(prepareWorkspace = false, submitNative = true) {
  const f = await queuedSubmission(submitNative);
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
    requestedAgentId: submitNative ? 'agent_worker' : createTestAgentSetup().manifest.id,
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
  if (submitNative) await expect(dispatch()).rejects.toThrow('original admitted submission');
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
      authorityRefs: [
        entry.queueEntryId,
        commandInputHash({
          runtimeTargetId: targetId,
          identityId: getNanoHostRuntimeTarget(f.owner, targetId)!.identityId,
          deploymentId,
          physicalEpoch,
          connectionGeneration: 1,
          workspaceId,
          threadId,
          agentSessionId,
        }),
      ],
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
  if (!submitNative) return { f, root, core, store, actor, input, now, retained };
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

/** Uses the real FULL Native writer and only replaces the physical peer when a test injects a cut. */
function cleanupFixtureBoot(
  fixture: Awaited<ReturnType<typeof admitOriginal>>,
  ports: Partial<BootNanoHostCleanupOwners> = {}
) {
  const { f, root, core } = fixture;
  const read = f.owner.storage.owner.read;
  const write = (input: NanoHostRecoveryMutation) =>
    f.send({ kind: 'pinned-recovery', input, dataRoot: root });
  const reconcileAcceptedFinalStatus = vi.fn();
  const owners: BootNanoHostCleanupOwners = {
    isTurnExecutionActive: () => false,
    cleanupClaimedBackendSession: vi.fn(async () => {
      throw new Error('Unexpected physical contact.');
    }),
    restoreClaimedCleanupResult: vi.fn(),
    inspectIdleCleanup: vi.fn(),
    commitPhysicalTransition: async (input, authorize) => {
      if (authorize && !authorize())
        return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
      return { state: 'ready', value: await write(input) };
    },
    commitOrphanAudit: vi.fn(),
    commitOrphanRetirement: vi.fn(),
    ...ports,
  };
  const boot = bindBootNanoHostAttemptRecovery(
    {
      ...f.owner.storage.owner,
      readWorkerCompletion: read,
      afterWorkerControlAcknowledgement: async (next) => next(),
    } as NanoHostOwnerBinding,
    { coreDb: core, reconcileAcceptedFinalStatus },
    owners
  );
  return { boot, owners, write, reconcileAcceptedFinalStatus };
}

/** Reads the pre-claim admission from the original Core and Native fixture owners. */
function cleanupRequest({ core, f }: Awaited<ReturnType<typeof admitOriginal>>) {
  const lease = readRetainedNanoHostSubmission(core, attemptId)!.lease;
  const { session, proof } = readNanoHostRecoveryLease(f.owner.sqlite, lease);
  const {
    agentSessionId,
    backendSessionId,
    deploymentId,
    packageSnapshotId,
    runtimeTargetId,
    stagingDirectoryRef,
    transientProviderInstanceId,
  } = session;
  const identity = {
    agentSessionId,
    backendKind: 'openshell' as const,
    backendSessionId,
    deploymentId,
    packageSnapshotId,
    runtimeTargetId,
    stagingDirectoryRef,
    transientProviderInstanceId,
  };
  return {
    lease,
    session,
    proof,
    identity,
    target: getNanoHostRuntimeTarget(f.owner, targetId)!,
    firstOperation: 'sandbox.delete' as const,
    finalDecision: null,
    now: () => deadline,
    authorize: () => true,
  };
}

it.each(['acknowledged', 'lost'] as const)(
  'r1 grants first dispatch only from the one live claim ACK (%s)',
  async (ack) => {
    const fixture = await admitOriginal();
    const { f, core, root } = fixture;
    setCleanupBackendId(f);
    closeOriginalAttempt(core, () => classifiedAt);
    const request = cleanupRequest(fixture);
    const dispatch = vi.fn<BootNanoHostCleanupOwners['cleanupClaimedBackendSession']>(
      async (_, carriage) => {
        carriage.assertCurrent();
        const occurrence = prepareNanoHostCleanupOccurrence(
          request.session,
          request.target,
          request.firstOperation
        );
        carriage.admit({ kind: 'sandbox.delete', requestId: occurrence.deleteRequestId });
        throw new Error('Fault after first dispatch.');
      }
    );
    const first = cleanupFixtureBoot(fixture, {
      cleanupClaimedBackendSession: dispatch,
      commitPhysicalTransition: async (input) => {
        const value = await f.send({ kind: 'pinned-recovery', dataRoot: root, input });
        if (ack === 'lost' && input.toState === 'cleanup-pending')
          throw new Error('Lost FULL claim ACK.');
        return { state: 'ready', value };
      },
    });
    if (ack === 'lost')
      await expect(first.boot.claimCleanup(request)).resolves.toMatchObject({
        state: 'unavailable',
      });
    else
      await expect(first.boot.claimCleanup(request)).rejects.toThrow('Fault after first dispatch.');
    await f.owner.reopen();
    const reopened = cleanupFixtureBoot(fixture, { cleanupClaimedBackendSession: dispatch });
    await expect(reopened.boot.claimCleanup(cleanupRequest(fixture))).resolves.toMatchObject({
      state: 'unavailable',
    });
    await expect(reopened.boot.claimCleanup(request)).resolves.toMatchObject({
      state: 'unavailable',
    });
    expect(dispatch).toHaveBeenCalledTimes(ack === 'lost' ? 0 : 1);
    expect(
      readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, request.lease, request.target)
    ).toBeNull();
  }
);

/** Keeps the exact admitted final on Native until its real Core observer runs. */
async function admitNativeOnlyFinal(fixture: Awaited<ReturnType<typeof admitOriginal>>) {
  const { core, f } = fixture;
  setCleanupBackendId(f);
  markSchedulerExecutionAttemptClosing(core, {
    attemptId,
    cause: 'turn-cancelled',
    now: () => acceptedAt,
  });
  const command: ControlWorkerFinalStatusCommand = {
    ...binding,
    payload: {
      terminalData: { status: 'cancelled', stopReason: 'aborted', evidenceManifestDigests: {} },
      sequence: 1,
      acceptedAt,
      eventAcceptedAt: acceptedAt,
    },
  };
  const decision = core.sqlite
    .transaction(() =>
      f.owner.sqlite
        .transaction(() => admitNanoHostWorkerFinalInDb(core, command, f.owner.sqlite))
        .deferred()
    )
    .immediate();
  await f.send({
    kind: 'worker-final',
    original: readRetainedNanoHostSubmission(core, attemptId),
    input: command,
    decision,
  });
  const finalDecision = inspectAcceptedNanoHostFinalInDb(core, f.owner.sqlite, attemptId);
  if (finalDecision.state !== 'native-only')
    throw new Error('Missing the original Native-only final.');
  return { command, finalDecision };
}

it.each(['exists before cleanup', 'appears just before delivery'] as const)(
  'r1 preserves original Native-only capture without publishing or destroying it (%s)',
  async (order) => {
    const fixture = await admitOriginal(true);
    const { actor, core, f, root } = fixture;
    const store = fixture.store!;
    const workspace = createTestWorkspaceDb(root, workspaceId);
    onTestFinished(() => workspace.sqlite.close());
    await store.createThread(workspaceId, 'Native-only capture', threadId);
    await store.createTurn(workspaceId, threadId, 'Retain the original capture.', actor, null, {
      turnId,
    });
    const attached = attachOriginalStorage(f, actor.id, bindingRef);
    const workSlotRef = attached.currentWorkSlotRef!;
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
      retainedStorage: {
        storageRef: attached.storageRef,
        workSlotRef,
        attachmentGeneration: attached.attachmentGeneration,
      },
    });
    await store.updateTurn(turnId, { agentSessionId });
    const prepared = await recordTestAgentEnvironmentPackage(workspace, {
      suffix: 'native-only-cleanup-capture',
      triggerActor: actor,
      threadId,
      workspaceInputIds: [],
    });
    const extension = prepared.extensions!.openkit as { workerStorage: Record<string, unknown> };
    const pkg = AgentEnvironmentPackageSchema.parse({
      ...prepared,
      snapshotId: inputRef,
      scope: { ...prepared.scope, workspaceId, threadId, turnId, agentSessionId, requestId: null },
      extensions: {
        ...prepared.extensions,
        openkit: { ...extension, workerStorage: { ...extension.workerStorage, workSlotRef } },
      },
    });
    recordAgentEnvironmentPackageSnapshot(workspace, {
      environmentPackage: pkg,
      createdAt: created,
    });
    const sandboxCompatibilityKey = 'a'.repeat(64);
    f.owner.setup((sqlite) => {
      sqlite
        .prepare(
          'UPDATE sandbox_runtime_records SET sandbox_binding_ref=?, sandbox_compatibility_key=?'
        )
        .run(bindingRef, sandboxCompatibilityKey);
      sqlite.prepare('UPDATE worker_backend_sessions SET sandbox_binding_ref=?').run(bindingRef);
    });
    for (const intent of prepareWorkerTurnJournalIntents(
      workspace,
      pkg,
      requireSchedulerExecutionAttempt(core, attemptId),
      { backendKind: 'openshell', targetId, allocationRef: bindingRef }
    ))
      await store.writeWorkspaceExecutionJournalIntent(workspaceId, intent);
    const { finalDecision } = await admitNativeOnlyFinal(fixture);
    const request = cleanupRequest(fixture);
    const collectionId = `turn-end-${sha256Hex(inputRef)}`;
    const sandboxId = nanoHostSandboxIdFromBackendSessionId(request.session.backendSessionId);
    const identity = {
      ...lineage,
      storageRef: attached.storageRef,
      workSlot: workSlotRef,
      attachmentGeneration: attached.attachmentGeneration,
      scopeDigest: attached.scopeDigest,
      sandboxId,
      collectionId,
    };
    const bytes = Buffer.from('original capture bytes');
    const source = join(
      root,
      'workspaces',
      workspaceId,
      'evidence/backend/workspace-capture',
      collectionId,
      'complete'
    );
    const stage = async () => {
      const staging = join(root, 'server', 'runtime', 'r1-capture');
      mkdirSync(staging, { recursive: true });
      const path = join(staging, 'complete');
      writeFileSync(path, bytes);
      const head = { tree: 'a'.repeat(40), manifest: 'b'.repeat(40) };
      await preserveRawWorkspaceCapture({
        dataRoot: root,
        identity,
        result: {
          outcome: 'candidate',
          sha256: `sha256:${sha256Hex(bytes)}`,
          byteLength: bytes.length,
          head,
          previousHead: head,
          acceptedBase: head,
          unstable: false,
        },
        staged: { bytes, path },
        admission: new FileStorageAdmission(root, () => 0n),
      });
    };
    const send = vi.fn();
    const enqueue = vi.fn(async (effect: NanoHostSessionEffectRequest) => {
      effect.cleanupCarriage!.admit({ kind: 'bridge.close', requestId: effect.requestId! });
      const assertDelivery = await effect.beforeDelivery!();
      await stage();
      assertDelivery();
      send();
      throw new Error('Unexpected destructive delivery.');
    });
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: core,
      env: {},
      store,
      nanoHostRecovery: { owner: { state: 'ready', value: f.owner.storage.owner } },
      nanoHostSessionDispatch: {
        effect: enqueue,
      } as NanoHostSessionDispatch,
    });
    onTestFinished(() => runtime.executionReconciler.stop());
    const boot = cleanupFixtureBoot(fixture, {
      cleanupClaimedBackendSession: runtime.cleanupClaimedBackendSession,
    });
    if (order === 'exists before cleanup') await stage();
    let failure: unknown;
    try {
      await boot.boot.claimCleanup({ ...request, firstOperation: 'bridge.close', finalDecision });
    } catch (error) {
      failure = error;
    }
    expect(enqueue).toHaveBeenCalledTimes(order === 'exists before cleanup' ? 0 : 1);
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(source)).toEqual(bytes);
    expect(listWorkspaceReconciliationRecords(workspace, workspaceId)).toEqual([]);
    expect(readWorkspaceCollection(workspace, identity)).toBeNull();
    expect(failure).toBeInstanceOf(Error);
    expect(
      readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, request.lease, request.target)
    ).toBeNull();
  }
);

it('r1 settles the already-admitted delete after the original Native-only final wins Core settlement', async () => {
  const fixture = await admitOriginal();
  const { core, f } = fixture;
  const { command, finalDecision } = await admitNativeOnlyFinal(fixture);
  const request = cleanupRequest(fixture);
  const dispatch = vi.fn<BootNanoHostCleanupOwners['cleanupClaimedBackendSession']>(
    async (_, carriage) => {
      expect(carriage.captureReadOnly).toBe(true);
      carriage.assertCurrent();
      const occurrence = prepareNanoHostCleanupOccurrence(
        request.session,
        request.target,
        request.firstOperation
      );
      carriage.admit({ kind: 'sandbox.delete', requestId: occurrence.deleteRequestId });
      expect(
        core.sqlite
          .transaction(() =>
            f.owner.sqlite
              .transaction(() => observeAcceptedNanoHostFinalInDb(core, command, f.owner.sqlite))
              .deferred()
          )
          .immediate()
      ).toMatchObject({ state: 'applied' });
      return { kind: 'deleted', requestId: occurrence.deleteRequestId };
    }
  );
  const boot = cleanupFixtureBoot(fixture, { cleanupClaimedBackendSession: dispatch });
  await expect(boot.boot.claimCleanup({ ...request, finalDecision })).resolves.toMatchObject({
    state: 'ready',
    value: { session: { state: 'physical-cleaned' }, observedAt: deadline },
  });
  expect(boot.reconcileAcceptedFinalStatus).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(inspectAcceptedNanoHostFinalInDb(core, f.owner.sqlite, attemptId).state).toBe('settled');
});

it('r1 refuses cold same-Epoch receipt and retirement without physical proof', async () => {
  const fixture = await admitOriginal();
  const { f, core } = fixture;
  setCleanupBackendId(f);
  closeOriginalAttempt(core, () => classifiedAt);
  const audit = vi.fn();
  const boot = cleanupFixtureBoot(fixture, { commitOrphanAudit: audit });
  const mutation = () => {
    const { lease, session, proof, target } = cleanupRequest(fixture);
    return {
      lease,
      expectedSession: session,
      expectedRecovery: proof,
      target,
      observedAt: deadline,
    };
  };
  await boot.write({ ...mutation(), kind: 'transition', toState: 'cleanup-pending' });
  await f.owner.reopen();
  const cold = mutation();
  expect(cold.expectedRecovery.cleanupOccurrence).toBeUndefined();
  await expect(
    boot.write({ ...cold, kind: 'transition', toState: 'physical-cleaned' })
  ).rejects.toThrow('exact original physical result');
  expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, cold.lease, cold.target)).toBeNull();
  await expect(boot.boot.commit({ ...cold, kind: 'retire-orphan' })).resolves.toMatchObject({
    state: 'unavailable',
  });
  expect(audit).not.toHaveBeenCalled();
  expect(
    core.sqlite
      .prepare(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
      )
      .pluck()
      .get()
  ).toBe(0);
  expect(cleanupRequest(fixture).session).toEqual(cold.expectedSession);
});

it('r1 refuses an absence proof for another backend before entering lifecycle cleanup', async () => {
  const fixture = await admitOriginal();
  const { f, core } = fixture;
  setCleanupBackendId(f);
  closeOriginalAttempt(core, () => classifiedAt);
  const siblingAttempt = 'r1-sibling-absence-attempt';
  f.owner.setup((sqlite) =>
    sqlite
      .prepare(`INSERT INTO worker_backend_sessions (
      attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
      backend_kind, deployment_id, backend_session_id, staging_directory_ref,
      workspace_handoff_state, state, created_at, updated_at, runtime_target_id,
      origin_physical_epoch, backend_lineage_json, sandbox_binding_ref
    ) SELECT ?, workspace_id, ?, ?, ?, 'r1-sibling-package', backend_kind, deployment_id,
      'nh-cccccccccccccccc-dddddddddddddddd', 'r1-sibling-staging',
      'complete', 'cleanup-pending', created_at, updated_at, runtime_target_id,
      origin_physical_epoch, backend_lineage_json, 'r1-sibling-binding'
      FROM worker_backend_sessions WHERE attempt_id=?`)
      .run(
        siblingAttempt,
        testEntityId('th', siblingAttempt),
        testEntityId('tu', siblingAttempt),
        testEntityId('as', siblingAttempt),
        attemptId
      )
  );
  const sibling = getWorkerBackendSession(f.owner, siblingAttempt)!;
  const lifecycle = vi.fn<BootNanoHostCleanupOwners['cleanupClaimedBackendSession']>(async () => {
    f.owner.setup((sqlite) =>
      sqlite
        .prepare("UPDATE worker_backend_sessions SET state='cleanup-failed' WHERE attempt_id=?")
        .run(siblingAttempt)
    );
    return { kind: 'fenced-absence', originPhysicalEpoch: physicalEpoch };
  });
  const boot = cleanupFixtureBoot(fixture, { cleanupClaimedBackendSession: lifecycle });
  const request = cleanupRequest(fixture);
  const occurrence = prepareNanoHostCleanupOccurrence(
    request.session,
    request.target,
    request.firstOperation
  );
  await boot.write({
    lease: request.lease,
    expectedSession: request.session,
    expectedRecovery: request.proof,
    target: request.target,
    observedAt: classifiedAt,
    kind: 'transition',
    toState: 'cleanup-pending',
    cleanupOccurrence: occurrence,
  });
  await f.owner.transition({ ...f.target, kind: 'allocate', observedAt: classifiedAt });
  await f.owner.transition({
    ...f.target,
    kind: 'ready',
    observedAt: classifiedAt,
    connectionGeneration: 2,
    physicalEpoch: 'b'.repeat(64),
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
  });
  const claim = cleanupRequest(fixture);
  const other = {
    ...claim.identity,
    agentSessionId: sibling.agentSessionId,
    backendSessionId: sibling.backendSessionId,
    packageSnapshotId: sibling.packageSnapshotId,
    stagingDirectoryRef: sibling.stagingDirectoryRef,
  };
  const positive = await boot.boot.settleClaimAbsence({ ...claim, identity: other });
  expect(lifecycle).not.toHaveBeenCalled();
  expect(getWorkerBackendSession(f.owner, siblingAttempt)).toEqual(sibling);
  expect(positive).toMatchObject({ state: 'unavailable' });
  expect(cleanupRequest(fixture).session).toEqual(claim.session);
});

it('r1 settles the already-consumed same-Epoch idle delete once and retires it with its original clock', async () => {
  const fixture = await admitOriginal();
  const { core, f, root, actor } = fixture;
  setCleanupBackendId(f);
  closeOriginalAttempt(core, () => classifiedAt);
  const before = cleanupRequest(fixture);
  const attempt = requireSchedulerExecutionAttempt(core, attemptId);
  const sandboxId = nanoHostSandboxIdFromBackendSessionId(before.session.backendSessionId);
  const requestId = createNanoHostEffectRequest(before.session, attemptId, 'sandbox.delete', {
    attemptId,
    sandboxId,
  }).requestId!;
  const rootSpan = {
    ...readExecutionJournalRoot(core, before.lease.grant.execution).span,
    endTimeUnixNano: null,
  };
  const control = {
    definitionVersion: CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
    kind: 'release' as const,
    target: { backendKind: 'openshell', targetId, allocationRef: bindingRef },
    workId: requestId,
    operationId: requestId,
    attemptId,
    invocationId: requestId,
    actor,
    inputRefs: [inputRef],
    outputRefs: [],
    fingerprint: commandInputHash({ requestId }),
    permittingDecisionRef: null,
    authorityRefs: [bindingRef],
    retryDeclarationRef: null,
    retryPermitted: false,
    deadlineUnixNano: null,
    physicalFenceRefs: [physicalEpoch],
  };
  const intent: ExecutionJournalIntent = {
    execution: {
      ref: { owner: { kind: 'server' }, executionId: `idle-cleanup:${requestId}` },
      definitionVersion: CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
      workId: requestId,
      fingerprint: control.fingerprint,
      exclusionRefs: [bindingRef],
      span: rootSpan,
    },
    stepId: `effect:${requestId}`,
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: { operation: 'sandbox.delete', requestId, sequence: null, bindingRef },
    control,
    span: {
      ...rootSpan,
      name: 'sandbox.delete',
      spanId: 'f'.repeat(16),
      parentSpanId: rootSpan.spanId,
    },
  };
  const processWitness = executionJournalProcessWitness();
  core.sqlite.transaction(() => {
    writeExecutionJournalIntent(core, intent, processWitness);
    settleCoreIdleJournal(
      core,
      intent,
      'completed',
      commandInputHash({ sandboxId, state: 'deleted' }),
      processWitness
    );
  })();
  const original = readConsumedIdleDelete(core, before.session)!;
  expect(original).toMatchObject({ kind: 'idle-deleted', requestId });
  f.owner.setup((sqlite) => {
    sqlite.prepare('DELETE FROM agent_session_runtime_bindings').run();
    sqlite.prepare('DELETE FROM harness_instance_records').run();
    sqlite.prepare('DELETE FROM sandbox_runtime_records').run();
  });
  const effect = vi.fn();
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb: core,
    env: {},
    nanoHostRecovery: {
      owner: { state: 'ready', value: f.owner.storage.owner },
      advanceIdleCleanup: effect,
    },
  });
  onTestFinished(() => runtime.executionReconciler.stop());
  const auditWrite = vi.fn<BootNanoHostCleanupOwners['commitOrphanAudit']>(async (input) => {
    const snapshot = cleanupRequest(fixture);
    const { session, proof, lease } = snapshot;
    const expected = { lease, expectedSession: session, expectedRecovery: proof };
    const originalCleanup = readNanoHostOrphanCleanup(
      f.owner.sqlite,
      expected,
      hashNanoHostRecoveryObservation({ lease, session, proof }),
      (candidate) => verifyNanoHostCleanupSubmitPlacement(core, f.owner.sqlite, lease, candidate)
    );
    core.sqlite.transaction(() =>
      commitCoreNanoHostOrphanAuditInDb(
        core,
        input,
        (_, cleanup) => canonicalJsonText(cleanup) === canonicalJsonText(originalCleanup)
      )
    )();
  });
  const boot = cleanupFixtureBoot(fixture, {
    inspectIdleCleanup: (identity) => runtime.executionReconciler.inspectIdleCleanup(identity),
    commitOrphanAudit: auditWrite,
    commitOrphanRetirement: async (input, audit) => ({
      state: 'ready',
      value: await f.send({ kind: 'retire-audited-orphan', dataRoot: root, input, audit }),
    }),
  });
  await boot.write({
    lease: before.lease,
    expectedSession: before.session,
    expectedRecovery: before.proof,
    target: before.target,
    observedAt: classifiedAt,
    kind: 'transition',
    toState: 'cleanup-pending',
  });
  const pending = cleanupRequest(fixture);
  const send = vi.fn();
  await expect(
    runtime.cleanupClaimedBackendSession(pending.identity, {
      target: pending.target,
      admit: send,
      assertCurrent: () => undefined,
    })
  ).resolves.toEqual(original);
  await expect(boot.boot.settleIdleClaimResult(pending)).resolves.toMatchObject({
    state: 'ready',
    value: { observedAt: original.observedAt },
  });
  await f.owner.reopen();
  const cleaned = cleanupRequest(fixture);
  await expect(
    boot.boot.commit({
      kind: 'retire-orphan',
      lease: cleaned.lease,
      expectedSession: cleaned.session,
      expectedRecovery: cleaned.proof,
      observedAt: original.observedAt,
    })
  ).resolves.toMatchObject({ state: 'ready', value: { state: 'cleaned' } });
  expect(auditWrite).toHaveBeenCalledOnce();
  expect(effect).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await f.owner.reopen();
  await expect(boot.boot.settleIdleClaimResult(cleanupRequest(fixture))).resolves.toMatchObject({
    state: 'ready',
    value: { observedAt: original.observedAt },
  });
  expect(readConsumedIdleDelete(core, cleaned.session)).toEqual(original);
  expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(attempt);
});

it('restores only the original cleanup result after a lost caller and independently reads the lost writer acknowledgement', async () => {
  const { core, f, root } = await admitOriginal();
  f.owner.setup((sqlite) =>
    sqlite
      .prepare('UPDATE worker_backend_sessions SET backend_session_id = ? WHERE attempt_id = ?')
      .run('nh-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb', attemptId)
  );
  markSchedulerExecutionAttemptClosing(core, {
    attemptId,
    cause: 'completed',
    now: () => acceptedAt,
  });
  const closing = readRetainedNanoHostSubmission(core, attemptId)!.lease;
  const target = getNanoHostRuntimeTarget(f.owner, targetId)!;
  const snapshot = () => readNanoHostRecoveryLease(f.owner.sqlite, closing);
  const transition = (
    toState: 'cleanup-pending' | 'cleanup-failed' | 'physical-cleaned',
    extra: object = {}
  ) => {
    const { session, proof } = snapshot();
    return {
      kind: 'transition' as const,
      toState,
      lease: closing,
      expectedSession: session,
      expectedRecovery: proof,
      observedAt: classifiedAt,
      target,
      ...extra,
    };
  };
  const write = (input: NanoHostRecoveryMutation) =>
    f.send({ kind: 'pinned-recovery', input, dataRoot: root });
  const occurrence = prepareNanoHostCleanupOccurrence(snapshot().session, target, 'bridge.close');
  await write(transition('cleanup-pending', { cleanupOccurrence: occurrence }));
  await write(transition('cleanup-failed'));
  await f.owner.reopen();
  await expect(write(transition('physical-cleaned'))).rejects.toThrow(
    'exact original physical result'
  );
  expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, target)).toBeNull();
  const cleanupClaimedBackendSession = vi.fn();
  const restoreClaimedCleanupResult = vi.fn(async (_session, pin, accept) => {
    expect(pin).toEqual(occurrence);
    await accept({ kind: 'deleted', requestId: occurrence.deleteRequestId });
  });
  const boot = bindBootNanoHostAttemptRecovery(
    f.owner.storage.owner as NanoHostOwnerBinding,
    {
      coreDb: core,
      reconcileAcceptedFinalStatus: vi.fn(),
    },
    {
      isTurnExecutionActive: () => false,
      cleanupClaimedBackendSession,
      restoreClaimedCleanupResult,
      inspectIdleCleanup: vi.fn(),
      commitPhysicalTransition: async (input) => {
        await write(input);
        throw new Error('Fault after the original Native receipt committed.');
      },
      commitOrphanAudit: vi.fn(),
      commitOrphanRetirement: vi.fn(),
    }
  );
  await expect(boot.restoreClaimResult(closing, () => classifiedAt)).resolves.toBeUndefined();
  expect(restoreClaimedCleanupResult).toHaveBeenCalledOnce();
  expect(cleanupClaimedBackendSession).not.toHaveBeenCalled();
  await f.owner.reopen();
  expect(readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, target)).toMatchObject({
    occurrence,
    cleanup: { connectionGeneration: 1, physicalEpoch, observedAt: classifiedAt },
  });
  await expect(boot.restoreClaimResult(closing, () => deadline)).rejects.toThrow();
  expect(restoreClaimedCleanupResult).toHaveBeenCalledOnce();
  await f.owner.transition({ ...f.target, kind: 'allocate', observedAt: deadline });
  await f.owner.transition({
    ...f.target,
    kind: 'ready',
    observedAt: deadline,
    connectionGeneration: 2,
    physicalEpoch,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
  });
  const current = getNanoHostRuntimeTarget(f.owner, targetId)!;
  expect(
    readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, closing, current, (session) =>
      verifyNanoHostCleanupSubmitPlacement(core, f.owner.sqlite, closing, session)
    )
  ).toMatchObject({
    target: current,
    occurrence,
    cleanup: { connectionGeneration: 1, physicalEpoch, observedAt: classifiedAt },
  });
});

it('joins the original orphan Audit after a lost acknowledgement and refuses changed physical proof', async () => {
  const { core, f, root } = await admitOriginal();
  markSchedulerExecutionAttemptClosing(core, {
    attemptId,
    cause: 'completed',
    now: () => acceptedAt,
  });
  const closing = readRetainedNanoHostSubmission(core, attemptId)!.lease;
  const read = (lease: NanoHostRecoveryLease) => readNanoHostRecoveryLease(f.owner.sqlite, lease);
  const before = read(closing);
  await f.mutate({
    lease: closing,
    expectedSession: before.session,
    expectedRecovery: before.proof,
    kind: 'transition',
    toState: 'cleanup-pending',
    target: getNanoHostRuntimeTarget(f.owner, targetId)!,
    observedAt: classifiedAt,
  });
  // A real successor fence proves the original physical resource absent. Pending state alone grants no result.
  await f.owner.transition({ ...f.target, kind: 'allocate', observedAt: classifiedAt });
  await f.owner.transition({
    ...f.target,
    kind: 'ready',
    observedAt: classifiedAt,
    connectionGeneration: 2,
    physicalEpoch: 'b'.repeat(64),
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
  });
  const pending = read(closing);
  await f.send({
    kind: 'pinned-recovery',
    dataRoot: root,
    input: {
      lease: closing,
      expectedSession: pending.session,
      expectedRecovery: pending.proof,
      kind: 'transition',
      toState: 'physical-cleaned',
      target: getNanoHostRuntimeTarget(f.owner, targetId)!,
      observedAt: classifiedAt,
      cleanupResult: { kind: 'fenced-absence', originPhysicalEpoch: physicalEpoch },
    },
  });
  closeOriginalAttempt(core, () => classifiedAt);
  const terminal = requireSchedulerExecutionAttempt(core, attemptId);
  const closed = readRetainedNanoHostSubmission(core, attemptId)!.lease;
  const { session, proof } = read(closed);
  const input = {
    kind: 'retire-orphan',
    lease: closed,
    expectedSession: session,
    expectedRecovery: proof,
    observedAt: classifiedAt,
  } as const;
  const readOriginalCleanup = () =>
    readNanoHostOrphanCleanup(
      f.owner.sqlite,
      input,
      hashNanoHostRecoveryObservation({ lease: closed, session, proof }),
      (original) => verifyNanoHostCleanupSubmitPlacement(core, f.owner.sqlite, closed, original)
    );
  const original = readOriginalCleanup()!;
  let changeProof = true;
  const boot = bindBootNanoHostAttemptRecovery(
    f.owner.storage.owner as NanoHostOwnerBinding,
    {
      coreDb: core,
      reconcileAcceptedFinalStatus: vi.fn(),
    },
    {
      isTurnExecutionActive: () => false,
      cleanupClaimedBackendSession: vi.fn(),
      restoreClaimedCleanupResult: vi.fn(),
      inspectIdleCleanup: vi.fn(),
      commitPhysicalTransition: vi.fn(),
      commitOrphanAudit: vi.fn(async (decision) => {
        core.sqlite.transaction(() =>
          commitCoreNanoHostOrphanAuditInDb(
            core,
            decision,
            (_, cleanup) => canonicalJsonText(cleanup) === canonicalJsonText(readOriginalCleanup())
          )
        )();
        throw new Error('Fault after the original Core Audit committed.');
      }),
      commitOrphanRetirement: async (input, audit) => {
        if (changeProof) {
          changeProof = false;
          f.owner.setup((sqlite) =>
            sqlite
              .prepare(`UPDATE worker_backend_sessions
          SET worker_recovery_json = ? WHERE attempt_id = ?`)
              .run(canonicalJsonText({ ...proof, recoveryState: 'needs-evidence' }), attemptId)
          );
        }
        const value = await f.send({ kind: 'retire-audited-orphan', dataRoot: root, input, audit });
        return { state: 'ready', value };
      },
    }
  );
  await expect(f.mutate(input)).rejects.toThrow('original Core Audit decision');
  await expect(boot.commit(input)).rejects.toThrow(
    'matching original orphan Audit acknowledgement'
  );
  const audit = inspectCoreNanoHostOrphanAudit(core, original);
  expect(audit).toMatchObject({ acceptedAt: classifiedAt });
  expect(read(closed).session).toEqual(session);
  f.owner.setup((sqlite) =>
    sqlite
      .prepare('UPDATE worker_backend_sessions SET worker_recovery_json = ? WHERE attempt_id = ?')
      .run(canonicalJsonText(proof), attemptId)
  );
  await f.owner.reopen();
  await expect(
    f.send({
      kind: 'retire-audited-orphan',
      dataRoot: root,
      input,
      audit: { ...audit, requestId: 'another-audit-occurrence' },
    })
  ).rejects.toThrow('matching original orphan Audit acknowledgement');
  await expect(boot.commit({ ...input, observedAt: deadline })).resolves.toMatchObject({
    state: 'ready',
    value: { state: 'cleaned', updatedAt: classifiedAt },
  });
  expect(inspectCoreNanoHostOrphanAudit(core, original)).toEqual(audit);
  expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(terminal);
});

it('refuses a stale Native final before Core intake and preserves the valid cancellation replay', async () => {
  const { core, f, root, now, retained } = await admitOriginal();
  const append: WorkerCanonicalEventRecord = {
    schemaVersion: 1,
    kind: 'event',
    lineage,
    sequence: 7,
    event: {
      type: 'item.delta',
      data: { itemId: testEntityId('it', 'final-preflight-output'), delta: 'original output' },
    },
  };
  const write = (payload: ControlWorkerRecordCommand['payload']) =>
    f.send({
      kind: 'pinned-record',
      dataRoot: root,
      observedAt: acceptedAt,
      input: { ...binding, payload },
    });
  await expect(
    write({
      kind: 'sequence',
      operation: 'event_append',
      sequence: append.sequence,
      fingerprint: canonicalJsonText(append),
    })
  ).resolves.toMatchObject({ duplicate: false, nextExpectedSequence: 8 });
  await write({
    kind: 'record',
    operation: 'event_append',
    recordKey: '7',
    sequence: append.sequence,
    record: append,
    acceptedAt,
  });
  markSchedulerExecutionAttemptClosing(core, { attemptId, cause: 'turn-cancelled', now });
  const valid: ControlWorkerFinalStatusCommand = {
    ...binding,
    payload: {
      terminalData: { status: 'cancelled', stopReason: 'aborted', evidenceManifestDigests: {} },
      sequence: 8,
      acceptedAt,
      eventAcceptedAt: acceptedAt,
    },
  };
  const readNative = <T>(read: () => T) => f.owner.sqlite.transaction(read).deferred();
  const inspect = (input: ControlWorkerFinalStatusCommand) =>
    inspectNanoHostWorkerFinalSequences(f.owner, input.lineage, input.payload);
  const intake = (input: ControlWorkerFinalStatusCommand) =>
    core.sqlite
      .transaction(() =>
        readNative(() => admitNanoHostWorkerFinalInDb(core, input, f.owner.sqlite))
      )
      .immediate();
  const before = requireSchedulerExecutionAttempt(core, attemptId);
  const steps = () =>
    core.sqlite
      .prepare(
        "SELECT step_id FROM control_execution_steps WHERE execution_id=? AND step_id LIKE 'worker-final-%'"
      )
      .all(retained!.lease.grant.execution.executionId);
  const stale = await Promise.resolve()
    .then(() => intake({ ...valid, payload: { ...valid.payload, sequence: 6 } }))
    .catch((error: unknown) => error);
  expect(steps()).toEqual([]);
  expect(stale).toBeInstanceOf(WorkerFinalStatusRefusal);
  expect(stale).toMatchObject({
    code: 'worker_control_sequence_stale',
    message: 'Worker control event_append sequence is older than the latest accepted sequence: 6',
    status: 409,
  });
  expect(() => intake({ ...valid, payload: { ...valid.payload, sequence: 7 } })).toThrow(
    expect.objectContaining({ code: 'worker_control_sequence_conflict', status: 409 })
  );
  expect(() =>
    core.sqlite.transaction(() => admitNanoHostWorkerFinalInDb(core, valid, f.owner.sqlite))()
  ).toThrow(ControlProductPreconditionError);
  const { final: orphan } = workerFinalSequenceInputs(lineage, valid.payload);
  f.owner.setup((sqlite) => acceptWorkerControlSequence({ sqlite }, orphan));
  expect(() => intake(valid)).toThrow(ControlProductPreconditionError);
  f.owner.setup((sqlite) =>
    sqlite
      .prepare("DELETE FROM worker_control_sequence_fingerprints WHERE operation = 'final_status'")
      .run()
  );
  expect(steps()).toEqual([]);
  expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(before);
  expect(getWorkerControlAcceptedFinalStatus(f.owner, lineage)).toBeNull();

  const decision = intake(valid);
  expect(decision).toMatchObject({ kind: 'cancellation-decided', acceptedAt });
  // A Core intake survives an unknown Native settlement, but the unproved final stays held.
  expect(
    core.sqlite
      .transaction(() =>
        readNative(() => observeAcceptedNanoHostFinalInDb(core, valid, f.owner.sqlite))
      )
      .immediate()
  ).toEqual({ state: 'unknown' });
  const retry = {
    ...valid,
    payload: { ...valid.payload, acceptedAt: classifiedAt, eventAcceptedAt: classifiedAt },
  };
  expect(intake(retry)).toEqual(decision);
  expect(getWorkerControlAcceptedFinalStatus(f.owner, lineage)).toBeNull();

  const final = (input: ControlWorkerFinalStatusCommand, decision: ReturnType<typeof intake>) =>
    f.send({
      kind: 'worker-final',
      original: readRetainedNanoHostSubmission(core, attemptId),
      input,
      decision,
    });
  await expect(final(valid, decision)).resolves.toEqual({
    finalStatusDuplicate: false,
    eventDuplicate: false,
    nextFinalStatusSequence: 9,
    nextEventSequence: 9,
  });
  await f.owner.reopen();
  expect(readNative(() => inspect(retry))).toEqual({
    status: 'accepted',
    finalStatusDuplicate: true,
    eventDuplicate: true,
  });
  const replay = intake(retry);
  expect(replay).toEqual({ ...decision, kind: 'replay' });
  await expect(final(retry, replay)).resolves.toMatchObject({
    finalStatusDuplicate: true,
    eventDuplicate: true,
  });
  expect(getWorkerControlAcceptedFinalStatus(f.owner, lineage)).toMatchObject({
    acceptedAt,
    status: 'cancelled',
  });
  expect(
    f.owner.sqlite
      .prepare(
        "SELECT sequence, accepted_at AS acceptedAt FROM worker_control_records WHERE operation='event_append' ORDER BY sequence"
      )
      .all()
  ).toEqual([
    { sequence: 7, acceptedAt },
    { sequence: 8, acceptedAt },
  ]);
});

it('claims and rolls back only the exact admitted Native Sandbox and original drain', async () => {
  const { f, core, root, now } = await admitOriginal(true);
  const sandboxCompatibilityKey = 'a'.repeat(64);
  f.owner.setup((sqlite) => {
    sqlite
      .prepare('UPDATE sandbox_runtime_records SET sandbox_compatibility_key=?')
      .run(sandboxCompatibilityKey);
    sqlite
      .prepare('UPDATE worker_backend_sessions SET backend_session_id=?')
      .run(`nh-${sandboxCompatibilityKey.slice(0, 16)}-${'b'.repeat(16)}`);
    sqlite.prepare("UPDATE harness_instance_records SET operation_state='settled'").run();
  });
  const target = getNanoHostRuntimeTarget(f.owner, targetId)!;
  const write: WriteNanoHostIdleSandboxLifecycle = async (input, authority) => {
    expect(await f.send({ kind: 'idle-sandbox', dataRoot: root, input, authority })).toBeNull();
  };
  const incoming = {
    workspaceId,
    threadId,
    turnId: testEntityId('tu', 'native-idle-drain-successor'),
    packageSnapshotId: inputRef,
    backendId: 'nanohost',
  };
  const claim = {
    sandboxRuntimeId: 'sandbox',
    sandboxBindingRef: 'sandbox-binding',
    sandboxCompatibilityKey,
    runtimeTargetId: targetId,
    originPhysicalEpoch: physicalEpoch,
    physicalAbsent: false,
    timestamp: acceptedAt,
    incoming,
    bindings: [
      {
        agentSessionId,
        agentSessionRuntimeBindingId: 'session-binding',
        harnessInstanceId: 'harness',
        harnessBindingRef: 'harness-binding',
        harnessCompatibilityKey: 'compat',
        lifecycleState: 'open',
        nativeHandleDigest: null,
      },
    ],
  };
  const drain = () => [
    f.owner.sqlite.prepare('SELECT drain_state FROM sandbox_runtime_records').pluck().get(),
    f.owner.sqlite.prepare('SELECT drain_state FROM harness_instance_records').pluck().get(),
  ];
  const submit = (snapshot = target, input = claim) =>
    claimNanoHostIdleSandboxDrain(core, input, { write, authority: { target: snapshot } });
  await expect(submit()).rejects.toThrow('changed before drain claim');
  expect(drain()).toEqual(['accepting', 'accepting']);
  closeOriginalAttempt(core, now);
  await expect(
    submit({ ...target, connectionGeneration: target.connectionGeneration + 1 })
  ).rejects.toThrow('changed before drain claim');
  f.owner.setup((sqlite) =>
    sqlite
      .prepare('UPDATE worker_backend_sessions SET agent_session_id=?')
      .run(testEntityId('as', 'foreign-idle-drain-session'))
  );
  await expect(submit()).rejects.toThrow('lacks the original Core backend admission');
  expect(drain()).toEqual(['accepting', 'accepting']);
  f.owner.setup((sqlite) =>
    sqlite.prepare('UPDATE worker_backend_sessions SET agent_session_id=?').run(agentSessionId)
  );
  await submit();
  expect(drain()).toEqual(['draining', 'draining']);

  const restore = (snapshot = target, claimedAt = claim.timestamp) =>
    restoreNanoHostSandboxAdmissionIfSafe(
      core,
      { sandboxRuntimeId: claim.sandboxRuntimeId },
      {
        write,
        authority: {
          target: snapshot,
          rollback: { sandboxBindingRef: claim.sandboxBindingRef, claimedAt },
        },
      }
    );
  await restore(target, created);
  expect(drain()).toEqual(['draining', 'draining']);
  f.owner.setup((sqlite) =>
    sqlite.prepare("UPDATE harness_instance_records SET operation_state='unknown'").run()
  );
  await restore();
  expect(drain()).toEqual(['draining', 'draining']);
  f.owner.setup((sqlite) =>
    sqlite.prepare("UPDATE harness_instance_records SET operation_state='settled'").run()
  );
  await f.owner.reopen();
  await restore();
  expect(drain()).toEqual(['accepting', 'accepting']);

  f.owner.setup((sqlite) =>
    sqlite
      .prepare('UPDATE nanohost_runtime_targets SET connection_generation=2, physical_epoch=?')
      .run('f'.repeat(64))
  );
  const successor = getNanoHostRuntimeTarget(f.owner, targetId)!;
  await expect(submit(successor)).rejects.toThrow('changed before drain claim');
  await submit(successor, { ...claim, physicalAbsent: true });
  await restore(successor);
  expect(drain()).toEqual(['draining', 'draining']);
});

function closeOriginalAttempt(core: ReturnType<typeof openCoreDb>, now: () => string) {
  const closing = markSchedulerExecutionAttemptClosing(core, {
    attemptId,
    cause: 'completed',
    now,
  });
  closeSchedulerExecutionAttemptWithFence(core, {
    correlation: schedulerExecutionCorrelation(closing),
    proof: {
      terminalHandoff: true,
      output: true,
      evidence: true,
      outsideWorkspaceCollection: true,
      integrationDrain: true,
      routesRevoked: true,
    },
    fenceRef: 'fixture-idle-release',
    now,
  });
}

function attachOriginalStorage(
  f: Awaited<ReturnType<typeof admitOriginal>>['f'],
  responsibleUserId: string,
  sandboxBindingRef: string
) {
  let attached!: ReturnType<typeof activateWorkerStorageAttachment>;
  f.owner.setup((sqlite) => {
    const owner = { sqlite };
    const layout = {
      family: 'openkit-worker',
      version: '1',
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'amd64' as const, os: 'linux' as const },
      targets: [{ target: '/workspace' }],
    };
    const idle = createWorkerStorageBinding(owner, {
      deploymentId,
      runtimeTargetId: targetId,
      workspaceId,
      layout,
      now: created,
    });
    const reserved = reserveWorkerStorageAttachment(owner, {
      storageRef: idle.storageRef,
      expectedRevision: idle.revision,
      workspaceId,
      layout,
      purpose: 'work',
      goalId: null,
      taskId: null,
      threadId,
      agentSessionId,
      responsibleUserId,
      runtimeTargetId: targetId,
      authorizeContributor: () => true,
      now: created,
    });
    attached = activateWorkerStorageAttachment(owner, {
      storageRef: reserved.storageRef,
      expectedRevision: reserved.revision,
      attachmentGeneration: reserved.attachmentGeneration,
      sandboxBindingRef,
      targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      now: created,
    });
  });
  return attached;
}

it('releases only the cleaned Sandbox attachment and exact revision on the admitted Native owner', async () => {
  const { f, core, actor } = await admitOriginal();
  const attached = attachOriginalStorage(f, actor.id, 'sandbox-binding');
  const original = {
    attachmentGeneration: attached.attachmentGeneration,
    cleanupProved: true,
    expectedRevision: attached.revision,
    sandboxBindingRef: 'sandbox-binding',
    storageRef: attached.storageRef,
  };
  const write: WriteNanoHostStorageRelease = (input) => f.send({ kind: 'storage-release', input });
  const release = (input = original) => releaseWorkerStorageAttachment(core, input, write);
  await expect(release({ ...original, cleanupProved: false })).rejects.toThrow(
    'cleanup is not proved'
  );
  await expect(release({ ...original, sandboxBindingRef: 'other-sandbox' })).rejects.toThrow(
    'does not match'
  );
  await expect(release({ ...original, expectedRevision: attached.revision - 1 })).rejects.toThrow();
  expect(getWorkerStorageBinding(f.owner, { storageRef: original.storageRef })).toEqual(attached);
  await expect(release()).resolves.toMatchObject({
    storageRef: original.storageRef,
    state: 'idle',
    revision: original.expectedRevision + 1,
    attachmentGeneration: original.attachmentGeneration,
    currentSandboxBindingRef: null,
  });
});

it.each(['reusable', 'live sibling'] as const)(
  'uses the admitted same-Epoch idle close only on a drained resident (%s)',
  async (scenario) => {
    const { f, core, root, store: fixtureStore, actor, now } = await admitOriginal(true);
    const store = fixtureStore!;
    const workspace = createTestWorkspaceDb(root, workspaceId);
    onTestFinished(() => workspace.sqlite.close());
    await store.createThread(workspaceId, 'Retained resident', threadId);
    await store.createTurn(workspaceId, threadId, 'Original Turn', actor, null, { turnId });
    const attached = attachOriginalStorage(f, actor.id, bindingRef);
    const workSlotRef = attached.currentWorkSlotRef!;
    const retainedStorage = {
      storageRef: attached.storageRef,
      attachmentGeneration: attached.attachmentGeneration,
      workSlotRef,
    };
    const original = await recordTestAgentEnvironmentPackage(workspace, {
      suffix: 'idle-harness-close',
      triggerActor: actor,
      threadId,
      workspaceInputIds: [],
    });
    const extensions = original.extensions!.openkit as {
      workerStorage: Record<string, unknown>;
    };
    const pkg = AgentEnvironmentPackageSchema.parse({
      ...original,
      snapshotId: inputRef,
      scope: { ...original.scope, workspaceId, threadId, turnId, agentSessionId, requestId: null },
      extensions: {
        ...original.extensions,
        openkit: { ...extensions, workerStorage: { ...extensions.workerStorage, workSlotRef } },
      },
    });
    const nativeHandleDigest = 'd'.repeat(64);
    await store.createAgentSession({
      id: agentSessionId,
      workspaceId,
      threadId,
      agentId: pkg.agent.agentId,
      environmentPackageSnapshotId: inputRef,
      nativeHandleDigest,
      retainedStorage,
      status: 'idle',
      message: null,
      createdAt: created,
      updatedAt: created,
    });
    recordAgentEnvironmentPackageSnapshot(workspace, {
      environmentPackage: pkg,
      createdAt: created,
    });
    closeOriginalAttempt(core, now);

    const sandboxKey = nanoHostSandboxCompatibilityKey(pkg);
    const harnessKey = nanoHostHarnessCompatibilityKey(pkg);
    const sessionKey = agentSessionCompatibilityKeyFromPackage(pkg);
    const sandboxId = `nh-${sandboxKey.slice(0, 16)}`;
    expect(pkg.runtime.image.kind).toBe('reference');
    if (pkg.runtime.image.kind !== 'reference')
      throw new Error('Expected original reference image.');
    const imageRef = pkg.runtime.image.ref;
    f.owner.setup((sqlite) => {
      sqlite
        .prepare(
          'UPDATE sandbox_runtime_records SET sandbox_binding_ref=?, sandbox_compatibility_key=?'
        )
        .run(bindingRef, sandboxKey);
      sqlite
        .prepare(`UPDATE harness_instance_records SET harness_compatibility_key=?, adapter_id=?,
        adapter_version=?, max_open_sessions=8, operation_state='idle', operation_id=NULL,
        operation_sequence=NULL, operation=NULL, command_body_json=NULL, command_fingerprint=NULL,
        result_json=NULL, result_fingerprint=NULL`)
        .run(harnessKey, pkg.control.adapter.targetRuntime, pkg.agent.runtimeVersion);
      sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings SET agent_session_compatibility_key=?, native_handle_digest=?,
           runtime_env_check_versions_json='[]', inference_loopback_credential_digest=?,
           capability_loopback_credential_digest=?`
        )
        .run(
          deriveNanoHostAgentSessionCompatibilityKey({
            adapterId: pkg.control.adapter.targetRuntime,
            adapterVersion: pkg.agent.runtimeVersion,
            harnessCompatibilityKey: harnessKey,
            sessionCompatibilityKey: sessionKey,
            threadId,
          }),
          nativeHandleDigest,
          '2'.repeat(64),
          '3'.repeat(64)
        );
      sqlite
        .prepare(`UPDATE worker_backend_sessions SET backend_session_id=?, staging_directory_ref=?,
        backend_lineage_json=?`)
        .run(
          `${sandboxId}-${sha256Hex(inputRef).slice(0, 16)}`,
          `server/runtime/worker-backend-sessions/${inputRef}`,
          JSON.stringify({ imageRef })
        );
    });
    const admitted = await openAdmittedTestNanoHost(core);
    onTestFinished(shutdownControlStoreWorkerClient);
    mutateAdmittedTestNanoHost(core, (sqlite) => {
      sqlite.prepare('ATTACH DATABASE ? AS original').run(f.owner.sqlite.name);
      sqlite.exec(`INSERT INTO nanohost_runtime_targets SELECT * FROM original.nanohost_runtime_targets;
        INSERT INTO worker_backend_sessions SELECT * FROM original.worker_backend_sessions;
        INSERT INTO sandbox_runtime_records SELECT * FROM original.sandbox_runtime_records;
        INSERT INTO harness_instance_records SELECT * FROM original.harness_instance_records;
        INSERT INTO agent_session_runtime_bindings SELECT * FROM original.agent_session_runtime_bindings;
        INSERT INTO worker_storage_bindings SELECT * FROM original.worker_storage_bindings;
        INSERT INTO worker_storage_contributors SELECT * FROM original.worker_storage_contributors;`);
    });
    const owner = admitted.value.owner;
    const readNative = <Value>(read: Parameters<typeof owner.read<Value>>[0]) =>
      readAdmittedTestNanoHost(core, read);
    expect(
      readNative((sqlite) =>
        inspectNanoHostAgentSessionContinuity(
          core,
          {
            workspaceId,
            threadId,
            agentSessionId,
            agentSessionCompatibilityKey: sessionKey,
          },
          { sqlite }
        )
      )
    ).toMatchObject({ reusable: true, nativeHandleDigest });

    const collection = {
      storageRef: attached.storageRef,
      attachmentGeneration: attached.attachmentGeneration,
      workspaceId,
      threadId,
      agentSessionId,
      turnId,
      scopeDigest: attached.scopeDigest,
      workSlot: workSlotRef,
      sandboxId,
      packageSnapshotId: inputRef,
      collectionId: `successor-${createHash('sha256').update(inputRef).digest('hex')}`,
    };
    const head = { tree: 'a'.repeat(40), manifest: 'b'.repeat(40) };
    const baseline = { ...collection, collectionId: 'baseline' };
    authorizeWorkspaceBaselineInitialization(workspace, baseline);
    acceptWorkspaceBaseline(workspace, baseline, head, head.tree);

    const queued = Promise.withResolvers<void>();
    const harness = owner.harnessTurnLifecycle;
    const lifecycle: AdmittedNanoHostHarnessTurnLifecycle = {
      ...harness,
      queue: async (input) => {
        const sequence = await harness.queue(input);
        queued.resolve();
        return sequence;
      },
      acknowledge: vi.fn(harness.acknowledge),
    };
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: core,
      env: {},
      store,
      nanoHostRecovery: {
        owner: { state: 'ready', value: owner },
        harnessTurnLifecycle: lifecycle,
        idleSandbox: {
          writeIdleHarnessDrain: async (input, authority) => {
            await owner.writeIdleHarnessDrain(input, authority);
            if (scenario !== 'live sibling' || input.kind !== 'sandbox.claim-idle-drain') return;
            // An occupied sibling appears after the initial census, while the caller awaits ACK.
            mutateAdmittedTestNanoHost(core, (sqlite) => {
              sqlite
                .prepare(`INSERT INTO agent_session_runtime_bindings
                (agent_session_runtime_binding_id,harness_instance_id,agent_session_id,workspace_id,thread_id,
                 agent_session_compatibility_key,effective_setup_generation,native_handle_state,
                 lifecycle_state,next_turn_sequence,cleanup_state,current_attempt_id,current_turn_id,created_at,updated_at,image_digest)
                VALUES ('live-sibling','harness',?,?,?,'compat',1,'ready','active',1,'clean',
                  'live-sibling-attempt',?,?,?,'image')`)
                .run(
                  testEntityId('as', 'idle-close-sibling'),
                  workspaceId,
                  testEntityId('th', 'idle-close-sibling'),
                  testEntityId('tu', 'idle-close-sibling'),
                  created,
                  created
                );
              sqlite
                .prepare(
                  'UPDATE harness_instance_records SET active_turn_count=1, open_session_count=2'
                )
                .run();
            });
          },
          releaseStorage: owner.releaseIdleSandboxStorage,
        },
      },
    });
    const backend = (runtime.turnExecutor as WorkerGovernanceTurnExecutor)
      .executionBackend as WorkerGovernanceBackend & {
      restoreSession(pkg: typeof original, attemptId: string): void;
      sessions: Map<string, unknown>;
      evictIncompatibleIdleSandbox(pkg: typeof original): Promise<unknown>;
      effect(
        identity: unknown,
        attemptId: string,
        operation: string
      ): Promise<Record<string, unknown>>;
      deleteSandbox(): Promise<void>;
    };
    backend.restoreSession(pkg, attemptId);
    backend.sessions.delete(inputRef);
    const effect = vi
      .spyOn(backend, 'effect')
      .mockImplementation(async (_identity, id, operation) => {
        expect([id, operation]).toEqual([attemptId, 'workspace.collect']);
        expect(listWorkspaceReconciliationRecords(workspace, workspaceId)).toContainEqual(
          expect.objectContaining({
            id: `wrr_capture_${collection.collectionId}`,
            stateAfter: 'requires-human',
          })
        );
        return { outcome: 'no_new_head', unstable: false };
      });
    let replay: Parameters<typeof runtime.acceptNanoHostHarnessResult>[0];
    const deleteSandbox = vi.spyOn(backend, 'deleteSandbox').mockImplementation(async () => {
      // Physical retirement follows the live consumer. Replay the Native result with no waiter.
      await runtime.acceptNanoHostHarnessResult(replay);
    });
    const successor = AgentEnvironmentPackageSchema.parse({
      ...pkg,
      snapshotId: 'successor-idle-harness',
      scope: { ...pkg.scope, threadId: testEntityId('th', 'idle-close-successor') },
    });
    const eviction = backend.evictIncompatibleIdleSandbox(successor);
    const reached = await Promise.race([
      queued.promise.then(() => 'queued' as const),
      eviction.then(
        () => 'complete' as const,
        (error: unknown) => error
      ),
    ]);
    if (reached !== 'queued') {
      if (scenario === 'reusable') throw reached;
      expect(reached).toBeInstanceOf(NanoHostCleanupFencePendingError);
      expect(effect).not.toHaveBeenCalled();
      expect(lifecycle.acknowledge).not.toHaveBeenCalled();
      expect(deleteSandbox).not.toHaveBeenCalled();
      expect(
        readNative((sqlite) =>
          sqlite
            .prepare(
              "SELECT lifecycle_state FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id='live-sibling'"
            )
            .pluck()
            .get()
        )
      ).toBe('active');
      return;
    }
    const sandboxIntegrationBindingRef = 'sandbox-integration';
    const command = await lifecycle.dispatch({ sandboxIntegrationBindingRef });
    expect(command).toMatchObject({
      operation: 'session.close',
      body: { agentSessionId, agentSessionRuntimeBindingId: 'session-binding' },
    });
    const carried = await runtime.acceptNanoHostHarnessCommand(command!);
    expect(carried).toEqual(command);
    expect(readWorkspaceCollection(workspace, collection)).toMatchObject({
      result: { outcome: 'no_new_head', credentialCheck: 'passed' },
    });
    const result = {
      schemaVersion: 2 as const,
      operationId: command!.operationId,
      sequence: command!.sequence,
      harnessInstanceId: command!.harnessInstanceId,
      disposition: 'succeeded' as const,
      body: { state: 'closed', privateState: 'absent', childState: 'absent' },
    };
    replay = result;
    const input = { result, sandboxIntegrationBindingRef, timestamp: acceptedAt };
    const inspected = readNative((sqlite) =>
      inspectNanoHostIdleCloseConsumption(core, input, { sqlite })
    )!;
    expect(await lifecycle.settle(input)).toBe('settled');
    expect(await lifecycle.settle(input)).toBe('replayed');
    await runtime.acceptNanoHostHarnessResult(result);
    expect(inspectCoreHarnessConsumption(core, inspected.key)).toEqual({
      consumer: inspected.consumer,
      acknowledgedAt: acceptedAt,
    });
    await eviction;
    expect(reached, 'A live sibling must refuse before any Harness command is queued.').toBe(
      scenario === 'reusable' ? 'queued' : 'refused'
    );
    expect(effect).toHaveBeenCalledTimes(1);
    expect(lifecycle.acknowledge).toHaveBeenCalledTimes(1);
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(
      readNative((sqlite) =>
        getWorkerStorageBinding({ sqlite }, { storageRef: attached.storageRef })
      )?.state
    ).toBe('idle');
  }
);

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

it('reads the exact pending private Login consumer on the admitted Native grant', async () => {
  const { core, f } = await admitOriginal();
  const context = {
    ...lineage,
    agentSessionRuntimeBindingId: 'session-binding',
    leaseId: attemptId,
    turnSequence: 0,
    runtimeTargetId: targetId,
    physicalEpoch,
    connectionGeneration: 1,
  };
  const publish = vi.fn();
  const decide = () =>
    core.sqlite
      .transaction(() =>
        f.owner.sqlite
          .transaction(() => {
            const integration = requireHarnessLoginBinding(core, context, acceptedAt, f.owner);
            publish(integration);
            return integration;
          })
          .deferred()
      )
      .immediate();
  expect(decide()).toBe('sandbox-integration');
  expect(publish).toHaveBeenCalledExactlyOnceWith('sandbox-integration');
  expect(() =>
    requireHarnessLoginBinding(core, { ...context, connectionGeneration: 2 }, acceptedAt, f.owner)
  ).toThrow('Native Login consumer binding is unavailable.');
  const { heartbeatDeadline } = f.read().proof;
  expect(() => requireHarnessLoginBinding(core, context, heartbeatDeadline, f.owner)).toThrow(
    'Native Login consumer binding is unavailable.'
  );

  markSchedulerExecutionAttemptClosing(core, { attemptId, cause: 'turn-cancelled' });
  publish.mockClear();
  expect(() => decide()).toThrow('Native Login consumer binding is unavailable.');
  expect(publish).not.toHaveBeenCalled();
});

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

it.each(['completed', 'lost-result', 'contradictory-result', 'admitted-openings'] as const)(
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
    let admitted = outcome === 'admitted-openings' ? await openAdmittedTestNanoHost(core) : null;
    if (admitted) {
      onTestFinished(shutdownControlStoreWorkerClient);
      // The component fixture provides the original admitted submission bytes for the shared writer.
      mutateAdmittedTestNanoHost(core, (sqlite) => {
        sqlite.prepare('ATTACH DATABASE ? AS original').run(f.owner.sqlite.name);
        sqlite.exec(`INSERT INTO nanohost_runtime_targets SELECT * FROM original.nanohost_runtime_targets;
          INSERT INTO worker_backend_sessions SELECT * FROM original.worker_backend_sessions;`);
      });
    }
    const commit = vi.fn(async (mutation: NanoHostRecoveryMutation) => {
      if (mutation.kind === 'finish-cleanup')
        expect(listWorkspaceRuntimeEvidence(workspace, workspaceId)).toContainEqual(
          expect.objectContaining({ phase: 'teardown', turnId, completedAt: classifiedAt })
        );
      if (admitted && mutation.kind !== 'retire-orphan') {
        const owner = admitted.value.owner;
        if (
          mutation.kind === 'transition' &&
          mutation.cleanupResult?.kind === 'workspace-cleaned'
        ) {
          const proof = mutation.cleanupResult;
          const journal = readExecutionJournalInvocation(workspace, proof.step);
          const base = intents[0]!;
          const otherAttempt = testEntityId('attempt', 'another-cleanup-proof');
          const substituted = {
            ...base,
            stepId: `${base.stepId}:another-cleanup-proof`,
            control: {
              ...journal.control,
              attemptId: otherAttempt,
              invocationId: `${proof.invocationId}:another-attempt`,
              outputRefs: [],
            },
            carriage: journal.carriage,
            span: { ...base.span, spanId: sha256Hex(otherAttempt).slice(0, 16) },
          };
          await store.writeWorkspaceExecutionJournalIntent(workspaceId, substituted);
          const root = readExecutionJournalRoot(workspace, proof.step.execution);
          await store.settleWorkspaceExecutionJournalStep(workspaceId, {
            ref: { execution: proof.step.execution, stepId: substituted.stepId },
            expectedExecutionRevision: root.revision,
            state: 'completed',
            span: {
              ...substituted.span,
              endTimeUnixNano: substituted.span.startTimeUnixNano,
              status: { code: 'OK' },
            },
            nextPhase: root.phase,
            terminalCause: root.terminalCause,
            exclusionRefs: root.exclusionRefs,
            outputRefs: [session.backendSessionId],
          });
          expect(
            await owner.classifyRecovery({
              ...mutation,
              cleanupResult: {
                ...proof,
                step: { ...proof.step, stepId: substituted.stepId },
                invocationId: substituted.control.invocationId,
              },
            })
          ).toMatchObject({ state: 'unavailable' });
          expect(
            owner.read((sqlite) =>
              readNanoHostPhysicalCleanupReceipt(sqlite, retained.lease, target)
            )
          ).toEqual({ state: 'ready', value: null });
          const path = workspace.sqlite.name;
          const original = `${path}.original-cleanup-proof`;
          let replaced = false;
          const post = Worker.prototype.postMessage;
          const replaceOpening = vi
            .spyOn(Worker.prototype, 'postMessage')
            .mockImplementation(function (
              this: Worker,
              ...args: Parameters<Worker['postMessage']>
            ) {
              const request = args[0];
              if (
                request?.operation === 'nanohost-owner' &&
                request.mutation?.kind === 'recovery-classification' &&
                request.mutation.input.classification?.toState === 'physical-cleaned'
              ) {
                expect(request.mutation.input.workspaceIdentity).toBeTypeOf('string');
                renameSync(path, original);
                replaced = true;
                copyFileSync(original, path);
              }
              return post.apply(this, args);
            });
          try {
            expect(await owner.classifyRecovery(mutation)).toMatchObject({ state: 'unavailable' });
            expect(replaced).toBe(true);
          } finally {
            replaceOpening.mockRestore();
            if (replaced) {
              rmSync(path, { force: true });
              renameSync(original, path);
            }
          }
          expect(
            owner.read((sqlite) =>
              readNanoHostPhysicalCleanupReceipt(sqlite, retained.lease, target)
            )
          ).toEqual({ state: 'ready', value: null });
          const ack = await owner.classifyRecovery(mutation);
          expect(ack.state).toBe('ready');
          return {
            state: 'unavailable' as const,
            owner: 'nanohost' as const,
            reason: 'recovery-required' as const,
          };
        }
        return owner.classifyRecovery(mutation);
      }
      return {
        state: 'ready' as const,
        value: await f.send({
          kind: 'pinned-recovery',
          dataRoot: root,
          input: mutation,
        }),
      };
    });
    const cleanupSession = vi.fn(async () => {
      if (outcome === 'lost-result') throw new Error('original cleanup acknowledgement lost');
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: { cleanupSession } as unknown as WorkerGovernanceBackend,
      coreDb: core,
      readNanoHostEnvironment: (read) =>
        admitted
          ? admitted.value.owner.read(read)
          : { state: 'ready', value: read(f.owner.sqlite) },
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
    if (outcome === 'completed' || outcome === 'admitted-openings') {
      if (admitted) {
        await expect(clean()).rejects.toThrow('cleanup requires recovery');
        await shutdownControlStoreWorkerClient();
        admitted = await openAdmittedTestNanoHost(core);
        expect(
          admitted.value.owner.read((sqlite) =>
            readNanoHostPhysicalCleanupReceipt(sqlite, retained.lease, target)
          )
        ).toMatchObject({
          state: 'ready',
          value: { observedAt: classifiedAt, session: { state: 'physical-cleaned' } },
        });
      }
      await expect(clean()).resolves.toBeUndefined();
      expect(
        commit.mock.calls.map(([stage]) =>
          stage.kind === 'transition' ? stage.toState : stage.kind
        )
      ).toEqual(['cleanup-pending', 'physical-cleaned', 'finish-cleanup']);
      let receipt: ReturnType<typeof readNanoHostPhysicalCleanupReceipt>;
      if (admitted) {
        await shutdownControlStoreWorkerClient();
        const reopened = await openAdmittedTestNanoHost(core);
        const readback = reopened.value.owner.read((sqlite) =>
          readNanoHostPhysicalCleanupReceipt(sqlite, retained.lease, target)
        );
        expect(readback.state).toBe('ready');
        receipt = readback.state === 'ready' ? readback.value : null;
      } else {
        await f.owner.reopen();
        receipt = readNanoHostPhysicalCleanupReceipt(f.owner.sqlite, retained.lease, target);
      }
      expect(receipt).toMatchObject({
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

it.each([
  [
    'admits only one original cleanup request for a closed preparation without a grant',
    'duplicate',
  ],
  ['restores the original no-grant preparation result through the closed Boot census', 'reopen'],
  ['rechecks the exclusive original preparation claim before dispatch', 'sibling'],
  ['keeps a prior overlapping preparation ahead of the original cleanup claim', 'sibling-first'],
] as const)('%s', async (_title, cut) => {
  const f = await fixture('queued');
  setCleanupBackendId(f);
  f.owner.setup((sqlite) =>
    sqlite
      .prepare(
        `UPDATE worker_backend_sessions SET state='materializing', workspace_handoff_state='pending' WHERE attempt_id=?`
      )
      .run(attemptId)
  );
  const root = mkdtempSync(join(tmpdir(), 'openkit-unused-preparation-'));
  const core = openCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  applyMigrations(core);
  const userId = ensureLocalUser(core);
  const actor = { kind: 'user' as const, id: userId };
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: userId });
  const store = new FsStore({ dataRoot: root });
  await store.importWorkspaceSnapshot({
    workspace: {
      id: workspaceId,
      name: 'Unused preparation',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: created,
      updatedAt: created,
    },
    notebookInitialization: {
      requestId: randomUUID(),
      producer: actor,
      instructionReference: 'fixture:unused-preparation',
    },
    threads: [],
    turns: [],
    knowledge: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  });
  await store.createThread(workspaceId, 'Original preparation', threadId);
  const turn = await store.createTurn(
    workspaceId,
    threadId,
    'Prepare the original binding.',
    actor,
    null,
    { turnId }
  );
  expect(turn.id).toBe(turnId);
  const workspace = createTestWorkspaceDb(root, workspaceId);
  onTestFinished(() => workspace.sqlite.close());
  const pkg = await recordTestAgentEnvironmentPackage(workspace, {
    suffix: 'unused-prepare',
    triggerActor: actor,
    workspaceInputIds: [],
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    ...pkg,
    snapshotId: inputRef,
    runtime: {
      ...pkg.runtime,
      image: { kind: 'reference', ref: 'registry.example/worker', pullPolicy: 'if-not-present' },
    },
    scope: { ...pkg.scope, workspaceId, threadId, turnId, agentSessionId, requestId: null },
  });
  await recordAgentEnvironmentPackageSnapshot(workspace, {
    createdAt: created,
    environmentPackage,
  });
  const entry = createSchedulerAdmissionEntry(core, {
    queueEntryId: 'unused-preparation-queue',
    backendId: 'nanohost',
    triggerActor: actor,
    workspaceId,
    threadId,
    turnId,
    inputRef: schedulerFixtureInput(workspaceId, turnId, 'Prepare the original binding.'),
    requestedAgentId: environmentPackage.agent.agentId,
  });
  const now = () => classifiedAt;
  createSchedulerExecutionAttempt(core, { entry, attemptId, preparationInput: {}, now });
  bindSchedulerExecutionAttemptSession(core, { attemptId, agentSessionId, now });
  finalizeSchedulerExecutionAttemptInput(core, { attemptId, inputRef, bindingRef, now });
  const admitted = await openAdmittedTestNanoHost(core);
  onTestFinished(shutdownControlStoreWorkerClient);
  mutateAdmittedTestNanoHost(core, (sqlite) => {
    sqlite.prepare('ATTACH DATABASE ? AS original').run(f.owner.sqlite.name);
    sqlite.exec(`INSERT INTO nanohost_runtime_targets SELECT * FROM original.nanohost_runtime_targets;
      INSERT INTO worker_backend_sessions SELECT * FROM original.worker_backend_sessions;`);
  });
  const owner = admitted.value.owner;
  const closed = core.sqlite
    .transaction(() =>
      closeNanoHostFailedStartInDb(
        core,
        {
          attemptId,
          agentSessionId,
          bindingRef,
          inputRef,
          queueEntryId: entry.queueEntryId,
          observedAt: classifiedAt,
        },
        (original) => {
          const anchor = owner.read(
            (sqlite) => readNanoHostCleanupOnly(sqlite, original)?.session.state
          );
          return anchor.state === 'ready' && anchor.value === 'materializing';
        }
      )
    )
    .immediate();
  const before = () => owner.read((sqlite) => readNanoHostCleanupOnly(sqlite, closed));
  const first = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const frames: string[] = [];
  const dispatch = vi.fn<BootNanoHostCleanupOwners['cleanupClaimedBackendSession']>(
    async (_identity, carriage) => {
      const state = before();
      if (state.state !== 'ready' || !state.value?.proof?.occurrence)
        throw new Error('Unused preparation claim is missing.');
      const { deleteRequestId } = state.value.proof.occurrence;
      expect(state.value.session.state).toBe('cleanup-pending');
      ready.resolve();
      await first.promise;
      carriage.assertCurrent();
      carriage.admit({ kind: 'sandbox.delete', requestId: deleteRequestId });
      frames.push(deleteRequestId);
      if (cut === 'reopen')
        throw new Error('Original preparation cleanup result did not reach Core.');
      return { kind: 'deleted', requestId: deleteRequestId };
    }
  );
  const cleanup = (authorize = () => true) =>
    cleanupNanoHostPreparation(
      core,
      owner,
      closed,
      () => 'sandbox.delete',
      dispatch,
      authorize,
      now
    );
  expect(readRetainedNanoHostSubmission(core, attemptId)).toBeNull();
  await expect(cleanup(() => false)).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  const createSibling = async () => {
    await store.completeTurn(
      turnId,
      { status: 'failed', completedAt: classifiedAt },
      { stopReason: 'error' }
    );
    const siblingTurnId = testEntityId('tu', 'competing-unused-preparation');
    await store.createTurn(workspaceId, threadId, 'Later attempt', actor, null, {
      turnId: siblingTurnId,
    });
    const siblingEntry = createSchedulerAdmissionEntry(core, {
      queueEntryId: 'competing-preparation-queue',
      backendId: 'nanohost',
      triggerActor: actor,
      workspaceId,
      threadId,
      turnId: siblingTurnId,
      inputRef: schedulerFixtureInput(workspaceId, siblingTurnId, 'Later attempt'),
      requestedAgentId: environmentPackage.agent.agentId,
    });
    const sibling = createSchedulerExecutionAttempt(core, {
      entry: siblingEntry,
      preparationInput: {},
      now,
    });
    return bindSchedulerExecutionAttemptSession(core, {
      attemptId: sibling.attemptId,
      agentSessionId,
      now,
    });
  };
  if (cut === 'sibling-first') {
    const bound = await createSibling();
    const original = before();
    await expect(cleanup()).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(before()).toEqual(original);
    expect(original).toMatchObject({
      state: 'ready',
      value: { session: { state: 'materializing', physicalCleanedAt: null }, proof: null },
    });
    expect(requireSchedulerExecutionAttempt(core, bound.attemptId)).toEqual(bound);
    return;
  }
  const winner = cleanup();
  try {
    await Promise.race([
      ready.promise,
      winner.then(() => {
        throw new Error('First cleanup never entered.');
      }),
    ]);
    await expect(cleanup()).rejects.toThrow();
    expect(frames).toEqual([]);
    if (cut === 'duplicate') {
      const pending = before();
      await expect(owner.firstSubmission({ attemptId, observedAt: classifiedAt })).rejects.toThrow(
        'Execution authority was revoked before the operation.'
      );
      expect(readRetainedNanoHostSubmission(core, attemptId)).toBeNull();
      expect(before()).toEqual(pending);
      expect(frames).toEqual([]);
    }
    if (cut === 'sibling') {
      const bound = await createSibling();
      first.resolve();
      await expect(winner).rejects.toThrow();
      expect(frames).toEqual([]);
      expect(requireSchedulerExecutionAttempt(core, bound.attemptId)).toEqual(bound);
      expect(before()).toMatchObject({
        state: 'ready',
        value: { session: { state: 'cleanup-pending', physicalCleanedAt: null } },
      });
      return;
    }
  } finally {
    first.resolve();
  }
  if (cut === 'reopen') {
    await expect(winner).rejects.toThrow('Original preparation cleanup result did not reach Core.');
    expect(before()).toMatchObject({
      state: 'ready',
      value: { session: { state: 'cleanup-failed', physicalCleanedAt: null } },
    });
    expect(frames).toHaveLength(1);
    await shutdownControlStoreWorkerClient();
    const reopened = await openAdmittedTestNanoHost(core);
    const reopenedOwner = reopened.value.owner;
    const scope = nativeProductScope(root, { kind: 'workspace', workspaceId });
    await getControlStoreWorkerClient().open({
      database: `workspace:${scope.path}`,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const original = reopenedOwner.read((sqlite) => readNanoHostCleanupOnly(sqlite, closed));
    if (original.state !== 'ready' || !original.value?.proof?.occurrence)
      throw new Error('Reopened preparation lacks its original claim.');
    const occurrence = original.value.proof.occurrence;
    const register = vi.fn<BootNanoHostCleanupOwners['restoreClaimedCleanupResult']>(
      async (session, pin, accept) => {
        expect(session).toEqual(original.value!.session);
        expect(pin).toEqual(occurrence);
        await expect(accept({ kind: 'deleted', requestId: 'another-request' })).rejects.toThrow();
        expect(reopenedOwner.read((sqlite) => readNanoHostCleanupOnly(sqlite, closed))).toEqual(
          original
        );
        await accept({ kind: 'deleted', requestId: occurrence.deleteRequestId });
      }
    );
    const physical = vi.fn();
    const boot = bindBootNanoHostAttemptRecovery(
      reopenedOwner,
      { coreDb: core, reconcileAcceptedFinalStatus: vi.fn() },
      {
        isTurnExecutionActive: () => false,
        cleanupClaimedBackendSession: physical,
        restoreClaimedCleanupResult: register,
        inspectIdleCleanup: vi.fn(),
        commitPhysicalTransition: vi.fn(),
        commitOrphanAudit: vi.fn(),
        commitOrphanRetirement: vi.fn(),
      }
    );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: core,
      env: {},
      store,
      nanoHostRecovery: { owner: { state: 'ready', value: reopenedOwner } },
    });
    onTestFinished(() => runtime.executionReconciler.stop());
    const input = {
      admittedNanoHostRecovery: { state: 'ready', value: boot },
      executionBackend: (runtime.turnExecutor as WorkerGovernanceTurnExecutor).executionBackend,
      now,
      projectRecoveredTurn: vi.fn(),
      reconcileExecutions: vi.fn(),
      cleanupPreparation: runtime.cleanupPreparation!,
      cleanupBackendSession: physical,
      prepareBackendCleanup: () => false,
      restoreBackendSession: vi.fn(),
    } as const;
    const startup = await classifyNanoHostAttemptsAfterRestart(core, input);
    await register.mock.results[0]?.value;
    expect(startup).toEqual({ failedAttemptIds: [] });
    expect(register).toHaveBeenCalledOnce();
    expect(reopenedOwner.read((sqlite) => readNanoHostCleanupOnly(sqlite, closed))).toMatchObject({
      state: 'ready',
      value: {
        session: { state: 'physical-cleaned', physicalCleanedAt: classifiedAt },
        proof: { occurrence, physicalCleanup: { observedAt: classifiedAt } },
      },
    });
    await runNanoHostAttemptRecoveryMaintenance(core, { ...input, now: () => deadline });
    await runNanoHostAttemptRecoveryMaintenance(core, { ...input, now: () => deadline });
    expect(reopenedOwner.read((sqlite) => readNanoHostCleanupOnly(sqlite, closed))).toMatchObject({
      state: 'ready',
      value: {
        session: { state: 'cleaned', workspaceHandoffState: 'complete' },
        proof: { occurrence, physicalCleanup: { observedAt: classifiedAt } },
      },
    });
    expect(listWorkspaceRuntimeEvidence(workspace, workspaceId)).toEqual([
      expect.objectContaining({ phase: 'teardown', completedAt: classifiedAt }),
    ]);
    expect(physical).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(closed);
    return;
  }
  await expect(winner).resolves.toMatchObject({
    state: 'physical-cleaned',
    physicalCleanedAt: classifiedAt,
  });
  const readback = before();
  expect(readback).toMatchObject({
    state: 'ready',
    value: { proof: { physicalCleanup: { observedAt: classifiedAt } } },
  });
  expect(frames).toHaveLength(1);
  await expect(cleanup()).resolves.toMatchObject({
    state: 'physical-cleaned',
    physicalCleanedAt: classifiedAt,
  });
  expect(frames).toHaveLength(1);
  expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(closed);
});

it('holds contradictory preparation cleanup coordinates and releases the original historical receipt', async () => {
  const { f, core, root, store: fixtureStore, retained, actor } = await admitOriginal(true, false);
  const store = fixtureStore!;
  const { grant } = retained!.lease;
  const workspace = createTestWorkspaceDb(root, workspaceId);
  onTestFinished(() => workspace.sqlite.close());
  await store.createThread(workspaceId, 'Granted preparation', threadId);
  await store.createTurn(workspaceId, threadId, 'Original preparation', actor, null, { turnId });
  await store.completeTurn(
    turnId,
    { status: 'failed', completedAt: classifiedAt },
    { stopReason: 'error' }
  );
  const prepared = await recordTestAgentEnvironmentPackage(workspace, {
    suffix: 'granted-unused-preparation',
    triggerActor: actor,
    workspaceInputIds: [],
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    ...prepared,
    snapshotId: inputRef,
    scope: { ...prepared.scope, workspaceId, threadId, turnId, agentSessionId, requestId: null },
  });
  await recordAgentEnvironmentPackageSnapshot(workspace, {
    createdAt: created,
    environmentPackage,
  });
  setCleanupBackendId(f);
  f.owner.setup((sqlite) =>
    sqlite
      .prepare(
        "UPDATE worker_backend_sessions SET workspace_handoff_state='pending' WHERE attempt_id=?"
      )
      .run(attemptId)
  );
  const closing = await markSchedulerExecutionAttemptClosing(core, {
    attemptId,
    cause: 'turn-start-failed',
    outcomeRef: `turn:${turnId}:failed`,
    now: () => classifiedAt,
  });
  const firstTarget = getNanoHostRuntimeTarget(f.owner, targetId)!;
  expect(grant.generation).toBe('1');
  expect(firstTarget).toMatchObject({ connectionGeneration: 1, physicalEpoch });
  const admitted = await openAdmittedTestNanoHost(core);
  const owner = admitted.value.owner;
  onTestFinished(shutdownControlStoreWorkerClient);
  mutateAdmittedTestNanoHost(core, (sqlite) => {
    sqlite.prepare('ATTACH DATABASE ? AS original').run(f.owner.sqlite.name);
    sqlite.exec(`INSERT INTO nanohost_runtime_targets SELECT * FROM original.nanohost_runtime_targets;
      INSERT INTO worker_backend_sessions SELECT * FROM original.worker_backend_sessions;`);
  });
  expect(
    readAdmittedTestNanoHost(core, (sqlite) => readNanoHostWorkerRouteBinding({ sqlite }, grant))
  ).toBeNull();
  const cleanup = (finish = false) =>
    cleanupNanoHostPreparation(
      core,
      owner,
      closing,
      () => 'sandbox.delete',
      async (_identity, carriage) => {
        const original = readAdmittedTestNanoHost(core, (sqlite) =>
          readNanoHostCleanupOnly(sqlite, closing)
        );
        const requestId = original?.proof?.occurrence?.deleteRequestId;
        if (!requestId) throw new Error('The original preparation cleanup claim is absent.');
        carriage.admit({ kind: 'sandbox.delete', requestId });
        return { kind: 'deleted', requestId };
      },
      () => true,
      () => classifiedAt,
      finish
    );
  await expect(cleanup()).resolves.toMatchObject({ state: 'physical-cleaned' });
  recordWorkerBackendTeardownEvidence(workspace, {
    workspaceId,
    threadId,
    turnId,
    agentSessionId,
    packageSnapshotId: inputRef,
    placement: 'local',
    backendType: 'openshell',
    backendVersion: null,
    workerImage: environmentPackage.runtime.image.ref,
    outcome: 'succeeded',
    completedAt: classifiedAt,
  });
  await expect(cleanup(true)).resolves.toMatchObject({
    state: 'cleaned',
    workspaceHandoffState: 'complete',
  });
  const proof = readAdmittedTestNanoHost(
    core,
    (sqlite) => readNanoHostCleanupOnly(sqlite, closing)?.proof
  )!;
  const receipt = proof.physicalCleanup!;
  expect(receipt).toEqual({ connectionGeneration: 1, physicalEpoch, observedAt: classifiedAt });
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb: core,
    env: {},
    store,
    nanoHostRecovery: { owner: { state: 'ready', value: owner } },
  });
  onTestFinished(() => runtime.executionReconciler.stop());
  const backend = (runtime.turnExecutor as WorkerGovernanceTurnExecutor).executionBackend;
  const fenceRef = `worker-backend:${attemptId}:${classifiedAt}`;
  const release = () =>
    backend.release({
      ...schedulerExecutionCorrelation(closing),
      proof: {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      },
    });
  const workspaceReader = openAdmittedWorkspaceReadDb(root, workspaceId);
  onTestFinished(() => workspaceReader.sqlite.close());
  const originalRoot = readExecutionJournalRoot(core, grant.execution);
  const coreRelease = (coordinate: typeof receipt) =>
    readAdmittedTestNanoHost(core, (native) =>
      core.sqlite
        .transaction(() =>
          applyCoreNanoHostRecoveryReleaseInDb(
            core,
            {
              attemptId,
              target: {
                targetId,
                identityId: firstTarget.identityId,
                deploymentId,
                connectionGeneration: coordinate.connectionGeneration,
                physicalEpoch: coordinate.physicalEpoch,
              },
              fenceRef,
              coveredScopeRefs: originalRoot.exclusionRefs,
              recoveryExpectedRevision: originalRoot.revision,
            },
            { native, workspace: workspaceReader }
          )
        )
        .immediate()
    );
  const releaseCount = () =>
    core.sqlite
      .prepare(`SELECT count(*) FROM control_execution_steps
        WHERE execution_id=? AND step_id='worker-terminal-release'`)
      .pluck()
      .get(grant.execution.executionId);
  const setReceipt = (coordinate: typeof receipt) =>
    mutateAdmittedTestNanoHost(core, (sqlite) =>
      sqlite
        .prepare('UPDATE worker_backend_sessions SET worker_recovery_json=? WHERE attempt_id=?')
        .run(canonicalJsonText({ ...proof, physicalCleanup: coordinate }), attemptId)
    );
  const contradict = async (coordinate: typeof receipt) => {
    setReceipt(coordinate);
    // The request mirrors the altered receipt. The independent original grant and target still decide.
    expect(coreRelease(coordinate)).toEqual({ state: 'unknown' });
    expect(readExecutionJournalRoot(core, grant.execution)).toEqual(originalRoot);
    expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(closing);
    expect(releaseCount()).toBe(0);
    await expect(release()).resolves.toMatchObject({ state: 'pending', fenceRef: null });
  };
  await expect(release()).resolves.toMatchObject({ state: 'released', fenceRef });
  await contradict({ ...receipt, connectionGeneration: 2 });
  await contradict({ ...receipt, physicalEpoch: 'e'.repeat(64) });
  // Move only the independent target. The receipt keeps the original generation and Epoch.
  mutateAdmittedTestNanoHost(core, (sqlite) =>
    sqlite
      .prepare('UPDATE nanohost_runtime_targets SET connection_generation=2 WHERE target_id=?')
      .run(targetId)
  );
  expect(
    readAdmittedTestNanoHost(core, (sqlite) => getNanoHostRuntimeTarget({ sqlite }, targetId))
  ).toMatchObject({ connectionGeneration: 2, physicalEpoch });
  await contradict({ ...receipt, physicalEpoch: 'e'.repeat(64) });
  await contradict({ ...receipt, connectionGeneration: 2, physicalEpoch: 'e'.repeat(64) });
  setReceipt(receipt);
  await expect(release()).resolves.toMatchObject({ state: 'released', fenceRef });
  const settled = coreRelease(receipt);
  expect(settled.state).toBe('settled');
  expect(coreRelease(receipt)).toEqual(settled);
  expect(releaseCount()).toBe(1);
  expect(requireSchedulerExecutionAttempt(core, attemptId)).toMatchObject({ phase: 'closed' });
  expect(readExecutionJournalRoot(core, grant.execution).exclusionRefs).toEqual([]);
});

it('keeps a physical cleanup receipt fenced until the original Workspace handoff completes', async () => {
  const f = await fixture();
  setCleanupBackendId(f);
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
  const occurrence = prepareNanoHostCleanupOccurrence(f.read().session, target, 'sandbox.delete');
  await f.send({
    kind: 'component-physical',
    input: {
      ...expected(),
      kind: 'transition',
      toState: 'cleanup-pending',
      target,
      cleanupOccurrence: occurrence,
    },
  });
  await f.send({
    kind: 'component-physical',
    input: {
      ...expected(),
      kind: 'transition',
      toState: 'physical-cleaned',
      target,
      cleanupResult: { kind: 'deleted', requestId: occurrence.deleteRequestId },
    },
  });
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

it.each([
  [
    'retries the exact terminal release after Workspace ACK and admits only the qualified next Turn',
    false,
  ],
  ['returns the same real backend fence before and after reconnect, then releases Core once', true],
] as const)('%s', async (_title, useRealBackend) => {
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
    f.owner.sqlite
      .transaction(() => admitNanoHostWorkerFinalInDb(core, finalInput, f.owner.sqlite))
      .deferred()
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
  let target = getNanoHostRuntimeTarget(f.owner, targetId)!;
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
      value: await f.send({ kind: 'pinned-recovery', dataRoot: root, input: mutation }),
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
  if (useRealBackend) {
    f.owner.setup((sqlite) =>
      sqlite.prepare("UPDATE agent_session_runtime_bindings SET cleanup_state='clean'").run()
    );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: core,
      env: {},
      store,
      nanoHostRecovery: {
        owner: { state: 'ready', value: f.owner.storage.owner },
        releaseTerminalScopes,
      },
    });
    onTestFinished(() => runtime.executionReconciler.stop());
    const configured = runtime.turnExecutor as WorkerGovernanceTurnExecutor;
    const request = {
      ...schedulerExecutionCorrelation(requireSchedulerExecutionAttempt(core, attemptId)),
      proof: {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      },
    };
    const original = await configured.executionBackend.release(request);
    expect(original).toMatchObject({ state: 'released', fenceRef: originalFence });
    expect(requireSchedulerExecutionAttempt(core, attemptId).phase).toBe('closing');
    expect(releaseTerminalScopes).not.toHaveBeenCalled();
    const nextGeneration = target.connectionGeneration + 1;
    await f.owner.transition({ ...f.target, kind: 'allocate', observedAt: cleanedAt });
    await f.owner.transition({
      ...f.target,
      kind: 'ready',
      observedAt: cleanedAt,
      connectionGeneration: nextGeneration,
      physicalEpoch,
      ready: true,
      freshEmpty: true,
      predecessorFenced: true,
    });
    await f.owner.reopen();
    target = getNanoHostRuntimeTarget(f.owner, targetId)!;
    expect(target).toMatchObject({ connectionGeneration: nextGeneration, physicalEpoch });
    await expect(configured.executionBackend.release(request)).resolves.toEqual(original);
    expect(place).toThrow('Execution placement has an unresolved writer.');
    await expect(
      // biome-ignore lint/complexity/useLiteralKeys: Exercise the production terminal closeout path.
      configured['releaseTerminalAttempt'](store, attemptId, pkg)
    ).resolves.toBeUndefined();
    expect(releaseTerminalScopes).toHaveBeenCalledExactlyOnceWith(attemptId, originalFence);
    expect(requireSchedulerExecutionAttempt(core, attemptId)).toMatchObject({
      phase: 'closed',
      fenceRef: originalFence,
    });
    expect(place()).toMatchObject({ turnId: successorTurn, phase: 'open' });
    return;
  }
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
  // The original receipt stays at generation 1 when the same peer reconnects before the retry.
  const physicalReceipt = readNanoHostRecoveryLease(f.owner.sqlite, original).proof.physicalCleanup;
  expect(physicalReceipt).toMatchObject({ connectionGeneration: target.connectionGeneration });
  f.owner.setup((sqlite) =>
    sqlite
      .prepare(
        'UPDATE nanohost_runtime_targets SET connection_generation = connection_generation + 1'
      )
      .run()
  );
  target = getNanoHostRuntimeTarget(f.owner, targetId)!;
  await expect(close()).resolves.toBeUndefined();
  expect(readNanoHostRecoveryLease(f.owner.sqlite, original).proof.physicalCleanup).toEqual(
    physicalReceipt
  );
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
