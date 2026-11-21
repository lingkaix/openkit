import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId, canonicalJsonText } from '@openkit/protocol';
import { policyDigest, sha256CanonicalJson } from '@openkit/protocol/digest';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { runKernelRepair } from '../llm/kernel-repair-composition.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { validatePolicyDocument } from '../policy/statements.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import type {
  ExecutionGrant,
  ExecutionInputProof,
  ExecutionProofIntent,
  SelectedExecutionInput,
} from '../storage/control-kernel-port.js';
import type { KernelExecutionEvidence } from '../storage/control-kernel-proof-codecs.js';
import { controlStoreFor } from '../storage/control-store.js';
import { commandInputHash } from '../storage/control-store-input.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  ControlCoreImageResultSchema,
  ControlCoreNanoHostFinalDecisionSchema,
  ControlCoreNanoHostFinalInputSchema,
  ControlNanoHostFirstSubmissionInputSchema,
} from '../storage/core-journal-codecs.js';
import {
  admitNanoHostFirstSubmissionInDb,
  admitNanoHostWorkerFinalInDb,
  applyControlCoreImageResult,
  observeAcceptedNanoHostFinalInDb,
  readCoreImageAcquisitionRef,
} from '../storage/core-journal-native.js';
import { openCoreDb, openWorkspaceDb, serverStoragePath } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createNanoHostCoreReads } from '../storage/nanohost-core-reads.js';
import {
  nanoHostWorkerFinalDecisionFingerprint,
  readRetainedNanoHostSubmission,
} from '../storage/nanohost-submitted-lease.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import { storageRequestId } from '../storage/storage-owner.js';
import type { ControlWorkerFinalStatusCommand } from '../storage/worker-control-final-status-codecs.js';
import { applyWorkspaceBackendHandoffInDb } from '../storage/workspace-backend-handoff-native.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { createVaultReference, revokeVaultReference } from '../vault/vault-references.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { publishCoreJournal } from './core-journal-owner.js';
import {
  readCoreHarnessConsumption,
  recordCoreHarnessConsumption,
} from './core-journal-records.js';
import {
  acceptSchedulerExecutionObservation,
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  EXECUTION_ATTEMPT_BUDGET_MS,
  finalizeSchedulerExecutionAttemptInput,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionGrantInDb,
  requireSchedulerExecutionAttempt,
} from './execution-attempt-records.js';
import {
  admitKernelInputInDb,
  admitKernelSchedulerGrantInDb,
  admitRepairCallEntryInDb,
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  CORE_REPAIR_EXECUTION_DEFINITION,
  CORE_SCHEDULER_EXECUTION_DEFINITION,
  commitKernelExecutionEvidenceInDb,
  commitKernelInputProofInDb,
  commitRepairReservationStep,
  commitRepairTerminalAuditInDb,
  createExecutionStepJournalReader,
  encodeExecutionJournalValue,
  executionJournalProcessWitness,
  inspectKernelInputDisposition,
  inspectKernelInputProofInDb,
  inspectKernelProofReceipt,
  inspectRepairReservationStep,
  kernelSchedulerScopeIsHeld,
  readExecutionJournalRoot,
  readKernelSchedulerGrantInDb,
  releaseKernelExecutionScopesInDb,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import type {
  ExecutionJournalAdmission,
  ExecutionJournalIntent,
  ExecutionJournalSettlement,
  ExecutionJournalSpan,
} from './execution-step-journal.js';
import {
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-session-records.js';
import { writeWorkerControlAcceptedRecord } from './worker-control-records.js';
import { acceptWorkerControlSequence } from './worker-control-sequences.js';
import { withPreparedWorkerSubmission } from './worker-governance-turn-executor.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';

// These contracts require the real migration and implementation tracked in docs/changes/202610201240000000-core_execution_journal/plan.md.
// Until then, typecheck only: unavailable methods or tables are blockers, not behavioral RED.
// No readiness skip or substitute journal is permitted; ordinary producer ordering/atomicity needs its own crossing.

/** Exercises every retained AnyValue kind without converting bigint or narrowing span metadata. */
function openSpan(id: number): ExecutionJournalSpan & { endTimeUnixNano: null } {
  const time = BigInt(Date.now()) * 1_000_000n + 123n;
  return {
    traceId: '1'.repeat(32),
    spanId: id.toString(16).padStart(16, '0'),
    traceState: 'vendor=journal-fixture',
    flags: 1,
    name: 'administrative image preparation',
    kind: 'INTERNAL',
    startTimeUnixNano: time,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [
      { key: 'empty', value: { type: 'empty' } },
      { key: 'text', value: { type: 'string', value: 'bounded diagnostic' } },
      { key: 'flag', value: { type: 'boolean', value: false } },
      { key: 'minimum', value: { type: 'int', value: -9_223_372_036_854_775_808n } },
      { key: 'maximum', value: { type: 'int', value: 9_223_372_036_854_775_807n } },
      { key: 'unsafe-number', value: { type: 'int', value: 9_007_199_254_740_993n } },
      { key: 'double-one', value: { type: 'double', value: 1.0 } },
      { key: 'binary', value: { type: 'bytes', value: [0, 128, 255] } },
      {
        key: 'nested',
        value: {
          type: 'array',
          value: [
            { type: 'int', value: 1n },
            { type: 'kvlist', value: [{ key: 'item', value: { type: 'boolean', value: true } }] },
          ],
        },
      },
    ],
    droppedAttributesCount: 2,
    events: [
      { timeUnixNano: time + 1n, name: 'first', attributes: [], droppedAttributesCount: 1 },
      { timeUnixNano: time + 2n, name: 'second', attributes: [], droppedAttributesCount: 0 },
    ],
    droppedEventsCount: 3,
    links: [
      {
        traceId: '2'.repeat(32),
        spanId: '2'.repeat(16),
        traceState: 'vendor=linked',
        flags: 1,
        attributes: [{ key: 'ordinal', value: { type: 'int', value: 2n } }],
        droppedAttributesCount: 4,
      },
      {
        traceId: '3'.repeat(32),
        spanId: '3'.repeat(16),
        flags: 0,
        attributes: [],
        droppedAttributesCount: 0,
      },
    ],
    droppedLinksCount: 5,
    instrumentationScope: {
      name: 'openkit.independent-journal-fixture',
      version: '1',
      schemaUrl: 'https://opentelemetry.io/schemas/1.36.0',
      attributes: [{ key: 'scope', value: { type: 'bytes', value: [128] } }],
      droppedAttributesCount: 6,
    },
    resource: {
      schemaUrl: 'https://opentelemetry.io/schemas/1.36.0',
      attributes: [{ key: 'service.name', value: { type: 'string', value: 'journal-fixture' } }],
      droppedAttributesCount: 7,
    },
  };
}

/** Supplies explicit primitive inputs, not actor authorization, receiver proof or an administrative producer. */
function journalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-execution-journal-'));
  let db = openCoreDb(root);
  onTestFinished(() => {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  const execution: ExecutionJournalAdmission = {
    ref: { owner: { kind: 'server' }, executionId: 'independent-image-preparation' },
    definitionVersion: 'core-image-acquire/v1',
    workId: testEntityId('tu', 'journal-primitive-work'),
    fingerprint: 'a'.repeat(64),
    exclusionRefs: ['fixture:retained-exclusion:v1'],
    span: openSpan(1),
  };
  const deadline = BigInt(Date.now() + 60_000) * 1_000_000n + 789n;
  return {
    root,
    execution,
    get db() {
      return db;
    },
    get reader() {
      return createExecutionStepJournalReader(db, { kind: 'server' });
    },
    reopen() {
      db.sqlite.close();
      db = openCoreDb(root);
    },
    intent(id = 1): ExecutionJournalIntent {
      return {
        execution,
        stepId: `step-${id}`,
        parentStepId: null,
        parent: null,
        inspectedStep: null,
        carriage: {
          operation: 'image.acquire',
          requestId: id.toString(16).padStart(64, '0'),
          sequence: null,
          bindingRef: null,
        },
        control: {
          definitionVersion: execution.definitionVersion,
          kind: 'resolve-setup',
          target: {
            backendKind: 'nanohost',
            targetId: 'fixture-selected-target',
            allocationRef: null,
          },
          workId: execution.workId,
          operationId: null,
          attemptId: null,
          invocationId: `independent-invocation-${id}`,
          actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
          inputRefs: ['fixture:immutable-image-input:v1'],
          outputRefs: [],
          fingerprint: 'b'.repeat(64),
          permittingDecisionRef: null,
          authorityRefs: ['fixture:admitted-authority:v1'],
          retryDeclarationRef: null,
          retryPermitted: false,
          deadlineUnixNano: deadline,
          physicalFenceRefs: [],
        },
        span: { ...openSpan(id + 1), parentSpanId: execution.span.spanId },
      };
    },
  };
}

/** Selects the actual persisted revision; a prepared end is not a receipt or an effect result. */
async function ending(
  fixture: ReturnType<typeof journalFixture>,
  intent: ExecutionJournalIntent,
  state: ExecutionJournalSettlement['state'] = 'completed'
): Promise<ExecutionJournalSettlement> {
  const execution = await fixture.reader.readExecution(intent.execution.ref);
  return {
    ref: { execution: intent.execution.ref, stepId: intent.stepId },
    expectedExecutionRevision: execution.revision,
    state,
    outputRefs: ['fixture:retained-result:v1'],
    span: {
      ...intent.span,
      endTimeUnixNano: intent.span.startTimeUnixNano + 123_456_789n,
      status:
        state === 'unknown'
          ? { code: 'ERROR', description: 'Effect outcome remains unknown.' }
          : { code: 'OK' },
      attributes:
        state === 'unknown'
          ? [
              ...intent.span.attributes,
              { key: 'openkit.outcome.uncertain', value: { type: 'boolean', value: true } },
            ]
          : intent.span.attributes,
    },
    nextPhase: 'open',
    terminalCause: null,
    exclusionRefs: intent.execution.exclusionRefs,
  };
}

describe('persisted execution journal contracts', () => {
  it.each(['ordinary', 'cancellation'] as const)(
    'retains %s NanoHost final intake and observes only the independently accepted final',
    async (mode) => {
      const f = journalFixture();
      const native = openNanoHostTestOwner();
      const workspaceId = testEntityId('ws', 'final-intake');
      const threadId = testEntityId('th', 'final-intake');
      const turnId = testEntityId('tu', 'final-intake');
      const agentSessionId = testEntityId('as', 'final-intake');
      const tokenHash = 'c'.repeat(64);
      const sandboxBindingRef = 'sandbox-final-intake';
      const packageSnapshotId = 'package-final-intake';
      const userId = ensureLocalUser(f.db);
      const triggerActor = { kind: 'user' as const, id: userId };
      recordWorkspaceOwnerMembership({ coreDb: f.db, workspaceId, ownerUserId: userId });
      const entry = createSchedulerAdmissionEntry(f.db, {
        queueEntryId: 'final-intake-queue',
        backendId: 'nanohost',
        workspaceId,
        threadId,
        turnId,
        triggerActor,
        inputRef: schedulerFixtureInput(workspaceId, turnId, 'Complete the original final.'),
        requestedAgentId: 'agent_worker',
      });
      const attempt = submitTestNanoHostWorkerLease(
        f.db,
        entry,
        sandboxBindingRef,
        {
          agentSessionId,
          packageSnapshotId,
          workerControlTokenHash: tokenHash,
          workerCapabilityTokenHash: 'd'.repeat(64),
          workerInferenceTokenHash: 'e'.repeat(64),
        },
        { nativePath: native.sqlite.name }
      );
      const {
        lease: { grant },
      } = readRetainedNanoHostSubmission(f.db, attempt.attemptId)!;
      const clock = (ms: number) => new Date(Date.parse(attempt.createdAt) + ms).toISOString();
      const lineage = {
        workspaceId,
        threadId,
        turnId,
        agentSessionId,
        packageSnapshotId,
        requestId: null,
      };
      const input: ControlWorkerFinalStatusCommand = {
        lineage,
        sandboxBindingRef,
        tokenHash,
        payload: {
          terminalData:
            mode === 'ordinary'
              ? { status: 'completed', stopReason: 'end_turn', evidenceManifestDigests: {} }
              : { status: 'cancelled', stopReason: 'aborted', evidenceManifestDigests: {} },
          sequence: 3,
          acceptedAt: clock(1000),
          eventAcceptedAt: clock(1001),
        },
      };
      const decide = async (command = input) =>
        ControlCoreNanoHostFinalDecisionSchema.parse(
          f.db.sqlite
            .transaction(() =>
              admitNanoHostWorkerFinalInDb(
                f.db,
                ControlCoreNanoHostFinalInputSchema.parse(command),
                native.sqlite
              )
            )
            .immediate()
        );
      const observe = (command = input) =>
        f.db.sqlite
          .transaction(() =>
            observeAcceptedNanoHostFinalInDb(
              f.db,
              ControlCoreNanoHostFinalInputSchema.parse(command),
              native.sqlite
            )
          )
          .immediate();
      const history = () => ({
        attempt: requireSchedulerExecutionAttempt(f.db, attempt.attemptId),
        roots: f.db.sqlite.prepare('SELECT * FROM control_executions ORDER BY id').all(),
        steps: f.db.sqlite
          .prepare('SELECT * FROM control_execution_steps ORDER BY execution_id, ordinal')
          .all(),
      });
      const cause = mode === 'ordinary' ? 'worker-final-status' : 'turn-cancelled';
      if (mode === 'cancellation') {
        markSchedulerExecutionAttemptClosing(f.db, {
          attemptId: attempt.attemptId,
          cause,
          now: () => clock(500),
        });
        const before = history();
        await expect(
          decide({
            ...input,
            payload: {
              ...input.payload,
              terminalData: {
                status: 'completed',
                stopReason: 'end_turn',
                evidenceManifestDigests: {},
              },
            },
          })
        ).rejects.toMatchObject({ code: 'worker_control_lease_not_live' });
        expect(history()).toEqual(before);
      }
      await expect(decide()).resolves.toEqual({
        kind: mode === 'ordinary' ? 'decided' : 'cancellation-decided',
        grant,
        fingerprint: nanoHostWorkerFinalDecisionFingerprint(input),
        acceptedAt: clock(1000),
        eventAcceptedAt: clock(1001),
      });
      const accepted = history();
      expect(accepted.attempt).toMatchObject({
        phase: 'closing',
        terminalCause: cause,
        disposition: 'unknown',
      });
      expect(observe()).toEqual({ state: 'unknown' });
      expect(history()).toEqual(accepted);

      const root = await f.reader.readExecution(grant.execution);
      const releaseDraft = f.intent();
      const releaseIntent: ExecutionJournalIntent = {
        ...releaseDraft,
        execution: { ...root, span: { ...root.span, endTimeUnixNano: null } },
        stepId: 'release-with-intake-only',
        control: {
          ...releaseDraft.control,
          definitionVersion: root.definitionVersion,
          kind: 'release',
          operationId: grant.operationId,
          attemptId: attempt.attemptId,
          workId: turnId,
        },
        span: { ...releaseDraft.span, traceId: root.span.traceId, parentSpanId: root.span.spanId },
      };
      const release = f.db.sqlite.transaction(() =>
        releaseKernelExecutionScopesInDb(f.db, releaseIntent, grant, root.revision, () => true)
      )();
      expect(release).toEqual({ state: 'unknown' });
      expect(kernelSchedulerScopeIsHeld(f.db, [`turn:${turnId}`])).toBe(true);
      expect(history()).toEqual(accepted);

      f.reopen();
      await native.reopen();
      const retry = {
        ...input,
        payload: { ...input.payload, acceptedAt: clock(3000), eventAcceptedAt: clock(3001) },
      };
      await expect(decide(retry)).resolves.toEqual({
        kind: mode === 'ordinary' ? 'decided' : 'cancellation-decided',
        grant,
        fingerprint: nanoHostWorkerFinalDecisionFingerprint(input),
        acceptedAt: clock(1000),
        eventAcceptedAt: clock(1001),
      });
      await expect(
        decide({ ...retry, payload: { ...retry.payload, sequence: 4 } })
      ).rejects.toMatchObject({ code: 'worker_control_sequence_conflict' });
      await expect(
        decide({
          ...retry,
          payload: {
            ...retry.payload,
            terminalData:
              mode === 'ordinary'
                ? { status: 'cancelled', stopReason: 'aborted', evidenceManifestDigests: {} }
                : { status: 'completed', stopReason: 'end_turn', evidenceManifestDigests: {} },
          },
        })
      ).rejects.toMatchObject({ code: 'worker_control_sequence_conflict' });
      await expect(
        decide({ ...retry, sandboxBindingRef: 'different-binding' })
      ).rejects.toMatchObject({ code: 'worker_control_unauthorized' });
      await expect(decide({ ...retry, tokenHash: '9'.repeat(64) })).rejects.toMatchObject({
        code: 'worker_control_unauthorized',
      });
      const nativeGrant = native.sqlite
        .prepare('SELECT worker_route_binding_json FROM worker_backend_sessions WHERE attempt_id=?')
        .pluck()
        .get(attempt.attemptId) as string;
      const setNativeGrant = (json: string) =>
        native.setup((sqlite) =>
          sqlite
            .prepare(
              'UPDATE worker_backend_sessions SET worker_route_binding_json=? WHERE attempt_id=?'
            )
            .run(json, attempt.attemptId)
        );
      setNativeGrant(canonicalJsonText({ ...JSON.parse(nativeGrant), generation: '2' }));
      await expect(decide(retry)).rejects.toThrow(
        'NanoHost recovery has no original native lease.'
      );
      setNativeGrant(nativeGrant);
      expect(history()).toEqual(accepted);

      const { sequence, terminalData, acceptedAt, eventAcceptedAt } = input.payload;
      const event = buildWorkerCanonicalTerminalEventRecord({
        data: terminalData,
        lineage,
        sequence,
      });
      native.setup((sqlite) =>
        writeWorkerControlAcceptedRecord(
          { sqlite },
          {
            operation: 'final_status',
            lineage,
            sequence,
            recordKey: String(sequence),
            record: { ...terminalData, acceptedAt, sequence },
            acceptedAt,
          }
        )
      );
      expect(observe()).toEqual({ state: 'unknown' });
      expect(history()).toEqual(accepted);
      native.setup((sqlite) => {
        const owner = { sqlite };
        acceptWorkerControlSequence(owner, {
          lineage,
          operation: 'final_status',
          sequence,
          fingerprint: canonicalJsonText({ ...terminalData, lineage, sequence }),
        });
        acceptWorkerControlSequence(owner, {
          lineage,
          operation: 'event_append',
          sequence,
          fingerprint: canonicalJsonText(event),
        });
        writeWorkerControlAcceptedRecord(owner, {
          lineage,
          operation: 'event_append',
          sequence,
          recordKey: String(sequence),
          record: event,
          acceptedAt: eventAcceptedAt,
        });
      });
      const applied = observe();
      expect(applied).toMatchObject({ state: 'applied', receipt: { disposition: 'applied' } });
      if (applied.state !== 'applied') throw new Error('Expected Core acceptance.');
      const settled = history();
      f.reopen();
      await native.reopen();
      expect(inspectKernelProofReceipt(f.db, applied.receipt.intent, true)).toEqual({
        state: 'settled',
        receipt: applied.receipt,
      });
      expect(observe(retry)).toEqual({ state: 'inspect-original', receipt: applied.receipt });
      await expect(decide(retry)).resolves.toMatchObject({
        kind: 'replay',
        acceptedAt: clock(1000),
        eventAcceptedAt: clock(1001),
      });
      expect(history()).toEqual(settled);
      expect(settled.attempt).toMatchObject({
        phase: 'closing',
        terminalCause: cause,
        disposition: 'accepted',
      });
      expect(kernelSchedulerScopeIsHeld(f.db, [`turn:${turnId}`])).toBe(true);
      native.setup((sqlite) =>
        sqlite.prepare("DELETE FROM worker_control_records WHERE operation='event_append'").run()
      );
      expect(observe(retry)).toEqual({ state: 'unknown' });
      expect(history()).toEqual(settled);
    }
  );

  it('decides the first NanoHost submission from both owners and inspects a lost ACK without redispatch', async () => {
    const f = journalFixture();
    const workspaceId = testEntityId('ws', 'first-submission');
    const workspace = openWorkspaceDb(f.root, workspaceId);
    onTestFinished(() => workspace.sqlite.close());
    applyScopedMigrations(workspace);
    f.db.sqlite.pragma('synchronous = FULL');
    const userId = ensureLocalUser(f.db);
    const triggerActor = { kind: 'user' as const, id: userId };
    recordWorkspaceOwnerMembership({ coreDb: f.db, workspaceId, ownerUserId: userId });
    const pkg = await recordTestAgentEnvironmentPackage(workspace, {
      suffix: 'first_submit',
      triggerActor,
      workspaceInputIds: ['repo'],
    });
    const { agentSessionId, threadId, turnId } = pkg.scope;
    const createdAt = '2026-11-20T08:00:00.000Z';
    const observedAt = '2026-11-20T08:00:05.000Z';
    const firstDeadline = '2026-11-20T10:00:05.000Z';
    const now = () => createdAt;
    const inputRef = pkg.snapshotId;
    const bindingRef = 'sandbox-binding-first-submit';
    const attemptId = testEntityId('attempt', 'first-submit');
    const operationId = commandInputHash({ attemptId, inputRef, operation: 'submit' });
    const entry = createSchedulerAdmissionEntry(f.db, {
      backendId: 'nanohost',
      queueEntryId: 'first-submit-queue',
      requestedAgentId: pkg.agent.agentId,
      triggerActor,
      workspaceId,
      threadId,
      turnId,
      inputRef: schedulerFixtureInput(workspaceId, turnId, 'Submit the original Work input.'),
      now,
    });
    createSchedulerExecutionAttempt(f.db, { entry, attemptId, preparationInput: {}, now });
    bindSchedulerExecutionAttemptSession(f.db, { attemptId, agentSessionId, now });
    const attempt = finalizeSchedulerExecutionAttemptInput(f.db, {
      attemptId,
      inputRef,
      bindingRef,
      now,
    });
    const native = openNanoHostTestOwner();
    const placement = {
      runtimeTargetId: 'first-submit-target',
      identityId: 'first-submit-identity',
      deploymentId: readDataRootLayoutMarker(f.root).deploymentId,
      physicalEpoch: 'a'.repeat(64),
      connectionGeneration: 1,
    };
    const target = {
      targetId: placement.runtimeTargetId,
      identityId: placement.identityId,
      deploymentId: placement.deploymentId,
    };
    await native.transition({ kind: 'allocate', ...target, observedAt: createdAt });
    await native.transition({
      kind: 'ready',
      ...target,
      connectionGeneration: placement.connectionGeneration,
      physicalEpoch: placement.physicalEpoch,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      observedAt: createdAt,
    });
    const physical = {
      backendKind: 'openshell',
      backendVersion: '0.0.80',
      workerSessionId: 'sandbox-first-submit',
    };
    const input = { attemptId, observedAt, placement };
    const submit = (command = input) =>
      f.db.sqlite
        .transaction(() =>
          admitNanoHostFirstSubmissionInDb(
            f.db,
            ControlNanoHostFirstSubmissionInputSchema.parse(command),
            { nanoHost: native, workspace }
          )
        )
        .immediate();
    const history = () => ({
      attempts: f.db.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY attempt_id')
        .all(),
      roots: f.db.sqlite.prepare('SELECT * FROM control_executions ORDER BY id').all(),
      steps: f.db.sqlite
        .prepare('SELECT * FROM control_execution_steps ORDER BY execution_id, ordinal')
        .all(),
    });
    const before = history();
    const refused = (command = input) => {
      expect(() => submit(command)).toThrow('The original execution grant is unavailable.');
      expect(history()).toEqual(before);
    };
    refused(); // No physical backend record.
    native.setup((sqlite) => {
      const owner = { sqlite };
      recordWorkerBackendSessionMaterializing(
        f.db,
        {
          identity: {
            agentSessionId,
            backendKind: physical.backendKind,
            backendSessionId: physical.workerSessionId,
            deploymentId: placement.deploymentId,
            packageSnapshotId: inputRef,
            runtimeTargetId: placement.runtimeTargetId,
            stagingDirectoryRef: 'first-submit/staging',
            transientProviderInstanceId: null,
          },
          backendVersion: physical.backendVersion,
          backendLineage: { kind: 'reference', imageRef: 'test-image' },
          lineage: { workspaceId, threadId, turnId },
          sandboxBindingRef: bindingRef,
          now,
        },
        { owner, attempt }
      );
      transitionWorkerBackendSessionState(owner, {
        attemptId,
        fromState: 'materializing',
        toState: 'materialized',
        now,
      });
      markWorkerBackendWorkspaceHandoffComplete(owner, { attemptId, now });
    });
    refused(); // Native's completed handoff alone cannot prove Workspace rows.
    const inputSnapshots = buildWorkspaceInputSnapshots({
      backendCapabilities: ['trusted-worker-inference-relay'],
      backendKind: physical.backendKind,
      createdAt,
      environmentPackage: pkg,
    });
    workspace.sqlite
      .transaction(() =>
        applyWorkspaceBackendHandoffInDb(workspace, {
          workspaceId,
          inputSnapshots,
          materializationRecords: buildWorkspaceMaterializationRecords({
            createdAt,
            inputSnapshots,
            materialization: {
              backendKind: physical.backendKind,
              backendStatus: { health: 'ready', version: physical.backendVersion },
              packageSnapshotId: inputRef,
              requiredCapabilities: pkg.backend.requiredCapabilities,
              sandbox: { name: physical.workerSessionId, state: 'created' },
              workspaceInputs: pkg.workspace.inputs.map(({ id, target }) => ({ id, target })),
            },
          }),
        })
      )
      .immediate();
    refused({ ...input, placement: { ...placement, connectionGeneration: 2 } });
    expect(() => submit({ ...input, observedAt: '2026-11-20T08:25:00.000Z' })).toThrow(
      'Original execution clock or admission is unavailable.'
    );
    expect(history()).toEqual(before);
    const first = submit();
    expect(first).toMatchObject({
      state: 'admitted-now',
      attempt: {
        attemptId,
        agentSessionId,
        inputRef,
        bindingRef,
        operationId,
        deadline: firstDeadline,
      },
    });
    expect(readRetainedNanoHostSubmission(f.db, attemptId)?.lease.grant).toMatchObject({
      operationId,
      generation: '1',
      deadline: firstDeadline,
    });
    const execution = { owner: { kind: 'server' as const }, executionId: attemptId };
    expect(await f.reader.readExecution(execution)).toMatchObject({
      fingerprint: entry.inputHash,
      workId: turnId,
      exclusionRefs: [
        `workspace:${workspaceId}`,
        `thread:${threadId}`,
        `turn:${turnId}`,
        `session:${agentSessionId}`,
      ],
    });
    expect(await f.reader.readEndedSteps(execution)).toMatchObject([
      {
        ref: { execution, stepId: 'submit' },
        control: {
          kind: 'admit',
          actor: triggerActor,
          inputRefs: [inputRef],
          invocationId: operationId,
        },
        span: { startTimeUnixNano: BigInt(Date.parse(observedAt)) * 1_000_000n },
      },
    ]);
    const retained = history();
    f.reopen();
    await native.reopen();
    native.setup((sqlite) =>
      transitionWorkerBackendSessionState(
        { sqlite },
        { attemptId, fromState: 'materialized', toState: 'launching', now: () => observedAt }
      )
    );
    expect(submit({ ...input, observedAt: '2026-11-20T10:01:00.000Z' })).toEqual({
      state: 'inspect-original',
      attempt: first.attempt,
    });
    const dispatch = vi.fn(async () => undefined);
    await expect(
      withPreparedWorkerSubmission(
        {
          coreDb: f.db,
          attemptId,
          inputRef,
          bindingRef,
          now: () => '2026-11-20T10:01:00.000Z',
          native: {
            admit: async ({ observedAt }) =>
              submit({ ...input, observedAt: observedAt ?? input.observedAt }),
          },
        },
        dispatch
      )
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(() =>
      submit({ ...input, placement: { ...placement, physicalEpoch: 'b'.repeat(64) } })
    ).toThrow('Execution grant conflicts with its original operation.');
    expect(history()).toEqual(retained);
  });

  it.each(['intent', 'unknown'] as const)(
    'acknowledges an exact image outcome on the original %s acquisition and inspects it after reopen',
    async (initialState) => {
      const f = journalFixture();
      onTestFinished(shutdownControlStoreWorkerClient);
      let { value: native } = await openAdmittedTestNanoHost(f.db);
      const identity = {
        targetId: 'fixture-selected-target',
        identityId: 'fixture-selected-target',
        deploymentId: readDataRootLayoutMarker(f.root).deploymentId,
      };
      const target = { ...identity, connectionGeneration: 1, physicalEpoch: 'c'.repeat(64) };
      const admit = async (selectedTarget: typeof target) => {
        const observedAt = new Date().toISOString();
        await expect(
          transitionAdmittedNanoHostRuntimeTarget(native, {
            ...identity,
            kind: 'allocate',
            observedAt,
          })
        ).resolves.toMatchObject({
          state: 'ready',
          value: { connectionGeneration: selectedTarget.connectionGeneration },
        });
        await expect(
          transitionAdmittedNanoHostRuntimeTarget(native, {
            ...selectedTarget,
            kind: 'ready',
            observedAt,
            ready: true,
            freshEmpty: true,
            predecessorFenced: true,
          })
        ).resolves.toMatchObject({ state: 'ready', value: { ready: true } });
      };
      await admit(target);
      const candidate = {
        authoredArtifactId: testEntityId('ar', 'original-image'),
        authoredArtifactVersion: 1,
        authoredContentDigest: `sha256:${'d'.repeat(64)}`,
        inputDigest: `sha256:${'e'.repeat(64)}`,
      } as const;
      const draft = f.intent();
      const bindingRef = `nanohost-target/v1:${target.deploymentId}:${target.targetId}:1:${target.physicalEpoch}`;
      const intent: ExecutionJournalIntent = {
        ...draft,
        execution: {
          ...draft.execution,
          exclusionRefs: [
            `native-image-invocation/v1:${draft.execution.ref.executionId}:${draft.stepId}`,
          ],
        },
        carriage: { ...draft.carriage, bindingRef },
        control: {
          ...draft.control,
          authorityRefs: [`turn/v1:${draft.execution.workId}`, bindingRef],
          inputRefs: [
            `artifact/v1:${candidate.authoredArtifactId}:1:${candidate.authoredContentDigest}`,
            `image-input/v1:${candidate.inputDigest}`,
          ],
        },
      };
      const ref = { execution: intent.execution.ref, stepId: intent.stepId };
      const admission = {
        kind: 'image-intent' as const,
        intentJson: encodeExecutionJournalValue(intent),
        processWitness: executionJournalProcessWitness(),
        target,
      };
      await expect(publishCoreJournal(f.db, admission)).resolves.toContain(
        intent.control.invocationId
      );
      if (initialState === 'unknown')
        await publishCoreJournal(f.db, { kind: 'image-abandon', ref, accepted: true });

      const settlement = {
        ...candidate,
        requestId: intent.carriage.requestId,
        operation: 'image.acquire',
        outcome:
          initialState === 'intent'
            ? { kind: 'success', imageDigest: `sha256:${'f'.repeat(64)}` }
            : { kind: 'failure', failureCode: 'effect_failed' },
      } as const;
      const submit = (value = settlement, selectedTarget = target, original = ref) =>
        f.db.sqlite
          .transaction(() =>
            applyControlCoreImageResult(
              f.db,
              ControlCoreImageResultSchema.parse({
                kind: 'image-result',
                ref: original,
                settlement: value,
                target: selectedTarget,
              }),
              createNanoHostCoreReads(native.owner)
            )
          )
          .immediate();

      const digest = commandInputHash(settlement);
      expect(submit()).toBe(digest);
      const root = await f.reader.readExecution(ref.execution);
      const steps = await f.reader.readEndedSteps(ref.execution);
      expect(root).toMatchObject(
        initialState === 'intent'
          ? { phase: 'closed', exclusionRefs: [] }
          : {
              phase: 'closing',
              exclusionRefs: [
                `native-image-invocation/v1:${ref.execution.executionId}:${ref.stepId}`,
              ],
            }
      );
      expect(steps).toHaveLength(initialState === 'intent' ? 1 : 2);
      expect(steps[0]).toMatchObject({
        state: initialState === 'intent' ? 'completed' : 'unknown',
        control: { outputRefs: initialState === 'intent' ? [digest] : [] },
      });
      if (initialState === 'unknown')
        expect(await f.reader.readLinkedInspections(ref)).toMatchObject([
          {
            inspectedStep: ref,
            inspection: {
              state: 'failed',
              control: { outputRefs: [digest], kind: 'consume-receipt' },
            },
          },
        ]);

      await shutdownControlStoreWorkerClient();
      f.reopen();
      ({ value: native } = await openAdmittedTestNanoHost(f.db));
      const inspected = readCoreImageAcquisitionRef(f.db, settlement.requestId);
      expect(inspected).toEqual(ref);
      expect(readCoreImageAcquisitionRef(f.db, '0'.repeat(64))).toBeNull();
      expect(submit(settlement, target, inspected!)).toBe(digest);
      expect(() =>
        submit({
          ...settlement,
          outcome: { kind: 'success', imageDigest: `sha256:${'9'.repeat(64)}` },
        })
      ).toThrow(expect.objectContaining({ reasonCode: 'image_result_conflict' }));
      expect(() => submit({ ...settlement, inputDigest: `sha256:${'8'.repeat(64)}` })).toThrow(
        expect.objectContaining({ reasonCode: 'image_result_conflict' })
      );
      expect(() => submit(settlement, { ...target, identityId: 'different-identity' })).toThrow(
        'Image execution provenance is unavailable.'
      );
      expect(() => submit(settlement, target, { ...ref, stepId: 'wrong-step' })).toThrow(
        expect.objectContaining({ reasonCode: 'image_result_conflict' })
      );
      await expect(publishCoreJournal(f.db, admission)).rejects.toThrow(
        'only result reconciliation'
      );
      const reconnected = { ...target, connectionGeneration: 2 };
      await admit(reconnected);
      expect(submit(settlement, reconnected, inspected!)).toBe(digest);
      expect(() => submit()).toThrow('Image execution provenance is unavailable.');
      expect(await f.reader.readExecution(ref.execution)).toEqual(root);
      expect(await f.reader.readEndedSteps(ref.execution)).toEqual(steps);
    }
  );

  it('round-trips exact typed root, invocation and ended span without a Workspace', async () => {
    expect(CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION).toBe('core-image-acquire/v1');
    const f = journalFixture();
    const intent = f.intent();
    const admitted = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, intent)
    );
    expect(admitted.control).toStrictEqual(intent.control);
    expect(admitted.carriage).toStrictEqual(intent.carriage);
    expect(admitted.clock.processWitness).not.toBe('');
    expect(typeof admitted.clock.admittedUnixNano).toBe('bigint');
    expect(typeof admitted.clock.admittedMonotonicNano).toBe('bigint');
    expect(admitted.remainingMs).toBeGreaterThan(0);
    expect(admitted.remainingMs).toBeLessThanOrEqual(60_001);
    expect(await f.reader.readExecution(intent.execution.ref)).toMatchObject({
      span: intent.execution.span,
      openSteps: [admitted.ref],
    });
    const outcome = await ending(f, intent);
    const ended = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, outcome)
    );
    expect(ended.span).toStrictEqual(outcome.span);
    expect(ended.rootSpanId).toBe(intent.execution.span.spanId);
    expect(ended.control).toStrictEqual({ ...intent.control, outputRefs: outcome.outputRefs });
    f.reopen();
    expect(await f.reader.readEndedSteps(intent.execution.ref)).toStrictEqual([ended]);
    expect(await f.reader.readEndedSteps(intent.execution.ref)).toStrictEqual([ended]);
    expect(await f.reader.readInvocation(admitted.ref)).toMatchObject({
      state: 'completed',
      clock: admitted.clock,
      remainingMs: 0,
    });
    expect(await f.reader.readExecution(intent.execution.ref)).toMatchObject({
      span: intent.execution.span,
      openSteps: [],
    });
    expect(
      readdirSync(f.root, { recursive: true }).filter((path) => String(path).endsWith('.sqlite'))
    ).toEqual([join('server', 'db', 'core.sqlite')]);
  });

  it('refuses changed input under the original invocation without changing its retained authority', async () => {
    const f = journalFixture();
    const intent = f.intent();
    const first = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, intent)
    );
    const before = await f.reader.readExecution(intent.execution.ref);
    expect(() =>
      controlStoreFor(f.db.sqlite).write(() =>
        writeExecutionJournalIntent(f.db, {
          ...intent,
          control: { ...intent.control, fingerprint: 'c'.repeat(64) },
        })
      )
    ).toThrow();
    expect(await f.reader.readExecution(intent.execution.ref)).toStrictEqual(before);
    const after = await f.reader.readInvocation(first.ref);
    expect(after.control).toStrictEqual(first.control);
    expect(after.clock).toStrictEqual(first.clock);
    expect(after.remainingMs).toBeLessThanOrEqual(first.remainingMs);
    expect(await f.reader.readEndedSteps(intent.execution.ref)).toEqual([]);
  });

  it('retains concurrent per-step targets and conditions settlement on the current execution revision', async () => {
    const f = journalFixture();
    const first = f.intent();
    const second = f.intent(2);
    const local = { ...second, control: { ...second.control, target: null } };
    const a = controlStoreFor(f.db.sqlite).write(() => writeExecutionJournalIntent(f.db, first));
    const b = controlStoreFor(f.db.sqlite).write(() => writeExecutionJournalIntent(f.db, local));
    f.reopen();
    const currentSteps = (await f.reader.readExecution(first.execution.ref)).openSteps;
    expect(currentSteps).toHaveLength(2);
    expect(currentSteps).toEqual(expect.arrayContaining([a.ref, b.ref]));
    expect((await f.reader.readInvocation(a.ref)).control.target).toEqual(first.control.target);
    expect((await f.reader.readInvocation(b.ref)).control.target).toBeNull();
    const endA = await ending(f, first);
    const staleB = await ending(f, local);
    controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, {
        ...endA,
        nextPhase: 'closing',
        terminalCause: 'authority-revoked',
      })
    );
    expect(() =>
      controlStoreFor(f.db.sqlite).write(() => settleExecutionJournalStep(f.db, staleB))
    ).toThrow();
    expect((await f.reader.readInvocation(b.ref)).state).toBe('intent');
    expect((await f.reader.readExecution(first.execution.ref)).openSteps).toEqual([b.ref]);
    f.reopen();
    const currentB = await ending(f, local);
    controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, {
        ...currentB,
        nextPhase: 'closing',
        terminalCause: 'late-observation',
      })
    );
    expect(await f.reader.readExecution(first.execution.ref)).toMatchObject({
      openSteps: [],
      phase: 'closing',
      terminalCause: 'late-observation',
    });
    expect(await f.reader.readEndedSteps(first.execution.ref)).toHaveLength(2);
  });

  function schedulerGrantFixture(createdAt?: string) {
    const f = journalFixture();
    const workspaceId = testEntityId('ws', 'original-grant');
    const userId = ensureLocalUser(f.db);
    const actor = { kind: 'user' as const, id: userId };
    recordWorkspaceOwnerMembership({ coreDb: f.db, workspaceId, ownerUserId: userId });
    const entry = createSchedulerAdmissionEntry(f.db, {
      queueEntryId: 'original-grant-queue',
      backendId: 'nanohost',
      triggerActor: actor,
      workspaceId,
      threadId: testEntityId('th', 'original-grant'),
      turnId: f.execution.workId,
      inputRef: schedulerFixtureInput(
        workspaceId,
        f.execution.workId,
        'Original preparation grant'
      ),
      requestedAgentId: 'agent_worker',
    });
    const attempt = createSchedulerExecutionAttempt(f.db, {
      entry,
      preparationInput: {},
      ...(createdAt === undefined ? {} : { now: () => createdAt }),
    });
    const operationId = 'original-preparation-grant';
    const draft = f.intent();
    const execution = {
      ...draft.execution,
      ref: { owner: { kind: 'server' as const }, executionId: attempt.attemptId },
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
      fingerprint: entry.inputHash,
    };
    const proposal: ExecutionJournalIntent = {
      ...draft,
      execution,
      control: {
        ...draft.control,
        kind: 'admit',
        actor,
        definitionVersion: execution.definitionVersion,
        attemptId: attempt.attemptId,
        operationId,
        invocationId: operationId,
      },
    };
    const reserve = (
      qualified: boolean,
      generation = 'original-generation',
      originalProposal = proposal,
      options: { submission?: boolean; now?: () => string } = {}
    ) =>
      f.db.sqlite.transaction(() =>
        recordSchedulerExecutionGrantInDb(
          f.db,
          {
            ...options,
            proposal: originalProposal,
            attemptId: attempt.attemptId,
            operationId: originalProposal.control.operationId!,
            generation,
          },
          () => qualified
        )
      )();
    const next = (id: string, scopes = execution.exclusionRefs): ExecutionJournalIntent => ({
      ...proposal,
      stepId: id,
      execution: { ...execution, exclusionRefs: scopes },
      control: { ...proposal.control, invocationId: id, operationId: id, deadlineUnixNano: null },
    });
    return { f, attempt, execution, operationId, proposal, reserve, next };
  }

  it('decides the original operation and retained grant atomically and inspects lost acknowledgement', () => {
    const { f, attempt, execution, operationId, proposal, reserve } = schedulerGrantFixture();
    expect(() => reserve(false)).toThrow('The original execution grant is unavailable.');
    expect(requireSchedulerExecutionAttempt(f.db, attempt.attemptId).operationId).toBeNull();
    expect(readKernelSchedulerGrantInDb(f.db, execution.ref, operationId)).toBeNull();
    const first = reserve(true);
    expect(first).toMatchObject({
      state: 'admitted-now',
      grant: {
        operationId,
        deadline: null,
        preparationStep: { execution: execution.ref, stepId: proposal.stepId },
      },
    });
    expect(requireSchedulerExecutionAttempt(f.db, attempt.attemptId)).toMatchObject({
      operationId,
      disposition: 'unknown',
    });
    f.reopen();
    expect(reserve(false)).toEqual({ state: 'inspect-original', grant: first.grant });
    expect(() => reserve(true, 'successor-generation')).toThrow(
      'Execution grant conflicts with its original operation.'
    );
    expect(() =>
      reserve(true, 'original-generation', { ...proposal, stepId: 'substituted-step' })
    ).toThrow('Execution grant conflicts with its original operation.');
    expect(() =>
      reserve(true, 'original-generation', {
        ...proposal,
        carriage: { ...proposal.carriage, operation: 'different-preparation' },
      })
    ).toThrow('Execution grant conflicts with its original operation.');
    expect(() =>
      reserve(true, 'original-generation', {
        ...proposal,
        execution: { ...execution, fingerprint: 'substituted-work' },
      })
    ).toThrow('Execution grant conflicts with the admitted work.');
  });

  it('refuses new grants after the attempt preparation budget or proposed step deadline expires', () => {
    const stale = schedulerGrantFixture(
      new Date(Date.now() - EXECUTION_ATTEMPT_BUDGET_MS - 1_000).toISOString()
    );
    expect(() => stale.reserve(true)).toThrow(
      'Original execution clock is unavailable or expired.'
    );
    expect(
      requireSchedulerExecutionAttempt(stale.f.db, stale.attempt.attemptId).operationId
    ).toBeNull();
    const live = schedulerGrantFixture();
    expect(() =>
      live.reserve(true, 'original-generation', {
        ...live.proposal,
        control: { ...live.proposal.control, deadlineUnixNano: 1n },
      })
    ).toThrow('Original execution clock is unavailable or expired.');
    expect(live.reserve(true).state).toBe('admitted-now');
  });

  it('does not renew the original submission clock and still inspects its expired grant', () => {
    const { f, attempt, proposal: draft, reserve, next } = schedulerGrantFixture();
    const inputRef = 'immutable-package';
    const bindingRef = 'original-binding';
    const operationId = commandInputHash({
      attemptId: attempt.attemptId,
      inputRef,
      operation: 'submit',
    });
    bindSchedulerExecutionAttemptSession(f.db, {
      attemptId: attempt.attemptId,
      agentSessionId: testEntityId('as', 'original-submission'),
    });
    finalizeSchedulerExecutionAttemptInput(f.db, {
      attemptId: attempt.attemptId,
      inputRef,
      bindingRef,
    });
    const proposal: ExecutionJournalIntent = {
      ...draft,
      carriage: { operation: 'submit', requestId: operationId, sequence: null, bindingRef },
      control: { ...draft.control, operationId, invocationId: operationId, inputRefs: [inputRef] },
    };
    const first = reserve(true, 'original-generation', proposal, { submission: true });
    expect(first.state).toBe('admitted-now');
    expect(
      acceptSchedulerExecutionObservation(f.db, {
        ...first.grant,
        disposition: 'accepted',
        execution: 'running',
        outcomeRef: null,
        fenceRef: null,
      })?.disposition
    ).toBe('accepted');
    const monotonic = process.hrtime.bigint();
    const elapsed = vi
      .spyOn(process.hrtime, 'bigint')
      .mockReturnValue(monotonic + BigInt(EXECUTION_ATTEMPT_BUDGET_MS + 1_000) * 1_000_000n);
    try {
      expect(() => reserve(true, 'original-generation', next('late-within-wall-clock'))).toThrow(
        'Original execution clock is unavailable or expired.'
      );
    } finally {
      elapsed.mockRestore();
    }
    const later = () => new Date(Date.parse(first.grant.deadline!) + 1).toISOString();
    f.reopen();
    expect(
      reserve(false, 'original-generation', proposal, { submission: true, now: later })
    ).toEqual({ state: 'inspect-original', grant: first.grant });
    expect(readRetainedNanoHostSubmission(f.db, attempt.attemptId)?.lease.grant).toEqual(
      first.grant
    );
    expect(() =>
      reserve(true, 'successor-generation', proposal, { submission: true, now: later })
    ).toThrow('Execution grant conflicts with its original operation.');
    expect(() =>
      reserve(true, 'original-generation', next('late-operation'), { now: later })
    ).toThrow('Original execution clock is unavailable or expired.');
    expect(requireSchedulerExecutionAttempt(f.db, attempt.attemptId).operationId).toBe(
      first.grant.operationId
    );
  });

  it('does not commit an applied receipt after the native attempt rejects a contradictory observation', () => {
    const { f, attempt, proposal, reserve } = schedulerGrantFixture();
    const { grant } = reserve(true);
    const observe = (disposition: 'accepted' | 'not_accepted') => {
      const proof = {
        kind: 'submission' as const,
        disposition,
        evidence: {
          backendId: grant.backendId,
          ref: `event-${disposition}`,
          digest: 'a'.repeat(64),
        },
      };
      const occurrence = {
        deploymentId: 'fixture',
        sourceOwner: grant.backendId,
        verb: 'apply-execution-proof' as const,
        occurrenceKey: disposition,
      };
      const intent = {
        ...occurrence,
        target: grant,
        requestId: storageRequestId(occurrence),
        expectedGeneration: grant.generation,
        inputDigest: sha256CanonicalJson(proof),
      };
      const result = f.db.sqlite.transaction(() =>
        commitKernelExecutionEvidenceInDb(
          f.db,
          { ...proposal, control: { ...proposal.control, kind: 'observe' } },
          { version: 1, kind: 'submission', intent, proof },
          true,
          () => true,
          (observation) =>
            acceptSchedulerExecutionObservation(f.db, {
              ...grant,
              disposition: observation.proof.disposition,
              execution: 'unknown',
              outcomeRef: null,
              fenceRef: null,
            }) !== null
        )
      )();
      return { result, intent };
    };
    expect(observe('accepted').result.state).toBe('settled');
    const rejected = observe('not_accepted');
    expect(rejected.result.state).toBe('unknown');
    f.reopen();
    expect(inspectKernelProofReceipt(f.db, rejected.intent, true).state).toBe('absent');
    expect(requireSchedulerExecutionAttempt(f.db, attempt.attemptId).disposition).toBe('accepted');
  });

  it('retains newly verified scopes and blocks another attempt from binding their session', () => {
    const { f, attempt, execution, proposal, reserve, next } = schedulerGrantFixture();
    const { grant } = reserve(true);
    expect(
      acceptSchedulerExecutionObservation(f.db, {
        ...grant,
        disposition: 'accepted',
        execution: 'running',
        outcomeRef: null,
        fenceRef: null,
      })?.disposition
    ).toBe('accepted');
    const volume = 'volume:resolved-at-placement';
    const nextGrant = reserve(true, 'original-generation', next('new-writer', [volume]));
    expect(nextGrant.state).toBe('admitted-now');
    f.reopen();
    expect(readExecutionJournalRoot(f.db, execution.ref).exclusionRefs).toEqual([
      ...execution.exclusionRefs,
      volume,
    ]);

    const session = testEntityId('as', 'retained-session');
    const formerAttempt = testEntityId('attempt', 'previous-session-writer');
    const previousExecution = {
      ...execution,
      ref: { ...execution.ref, executionId: formerAttempt },
      workId: testEntityId('tu', 'previous-session-writer'),
      exclusionRefs: [`session:${session}`],
    };
    const previous = {
      ...proposal,
      execution: previousExecution,
      control: {
        ...proposal.control,
        invocationId: 'previous-allocation',
        operationId: 'previous-allocation',
        workId: previousExecution.workId,
        attemptId: formerAttempt,
      },
    };
    expect(
      f.db.sqlite.transaction(() =>
        admitKernelSchedulerGrantInDb(
          f.db,
          previous,
          {
            ...grant,
            execution: previousExecution.ref,
            attemptId: formerAttempt,
            turnId: previousExecution.workId,
            operationId: 'previous-allocation',
            deadline: null,
            preparationStep: { execution: previousExecution.ref, stepId: previous.stepId },
          },
          () => true
        )
      )().state
    ).toBe('settled');
    f.reopen();
    expect(() =>
      bindSchedulerExecutionAttemptSession(f.db, {
        attemptId: attempt.attemptId,
        agentSessionId: session,
      })
    ).toThrow('Selected AgentSession has an unresolved writer.');
    expect(requireSchedulerExecutionAttempt(f.db, attempt.attemptId).agentSessionId).toBeNull();
  });

  it('uses independent original input obligations for equal bytes and reopens their linked proofs', () => {
    const fixture = journalFixture();
    const execution: ExecutionJournalAdmission = {
      ...fixture.execution,
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
    };
    const attemptId = testEntityId('attempt', 'equal-input-attempt');
    const step = (
      id: number,
      kind: ExecutionJournalIntent['control']['kind']
    ): ExecutionJournalIntent => {
      const base = fixture.intent(id);
      return {
        ...base,
        execution,
        control: {
          ...base.control,
          kind,
          definitionVersion: execution.definitionVersion,
          attemptId,
          operationId: 'original-operation',
        },
      };
    };
    const selected: SelectedExecutionInput = {
      input: {
        owner: { kind: 'workspace', workspaceId: testEntityId('ws', 'input-owner') },
        inputId: 'first-input',
        digest: 'a'.repeat(64),
      },
      order: 0,
      originalInvocationId: 'workspace-first-input',
      grant: {
        execution: execution.ref,
        attemptId,
        backendId: 'nanohost',
        bindingRef: 'original-binding',
        inputRef: 'original-package',
        operationId: 'original-operation',
        turnId: execution.workId,
        generation: 'original-generation',
        deadline: '2026-11-21T10:00:00.000Z',
      },
    };
    const proposal = step(1, 'admit');
    const grantProposal = {
      ...proposal,
      control: { ...proposal.control, invocationId: selected.grant.operationId },
    };
    const retainGrant = (grant: ExecutionGrant, current = true) =>
      fixture.db.sqlite.transaction(() =>
        admitKernelSchedulerGrantInDb(fixture.db, grantProposal, grant, () => current)
      )();
    expect(retainGrant(selected.grant, false)).toEqual({ state: 'unknown' });
    expect(() =>
      fixture.db.sqlite.transaction(() =>
        writeExecutionJournalIntent(fixture.db, {
          ...grantProposal,
          carriage: {
            ...grantProposal.carriage,
            kernelGrant: {
              version: 1,
              grant: selected.grant,
              requestDigest: 'a'.repeat(64),
              submission: false,
            },
          },
        })
      )()
    ).toThrow('requires its verifying native writer');
    expect(retainGrant(selected.grant)).toEqual({ state: 'settled', receipt: selected.grant });
    fixture.reopen();
    expect(
      readKernelSchedulerGrantInDb(fixture.db, execution.ref, selected.grant.operationId)
    ).toEqual(selected.grant);
    expect(retainGrant({ ...selected.grant, generation: 'successor-generation' })).toEqual({
      state: 'conflict',
    });
    expect(retainGrant(selected.grant, false)).toEqual({
      state: 'settled',
      receipt: selected.grant,
    });
    const sibling: SelectedExecutionInput = {
      ...selected,
      input: { ...selected.input, inputId: 'second-input' },
      order: 1,
      originalInvocationId: 'workspace-second-input',
    };
    const admit = (id: number, input: SelectedExecutionInput, authorized = true) =>
      fixture.db.sqlite.transaction(() =>
        admitKernelInputInDb(fixture.db, step(id, 'admit'), input, () => authorized)
      )();
    expect(admit(2, selected, false)).toEqual({ state: 'unknown' });
    const first = admit(2, selected);
    const second = admit(3, sibling);
    if (first.state !== 'settled' || second.state !== 'settled')
      throw new Error('Input fixture did not commit.');
    expect(first.receipt).not.toEqual(second.receipt);
    expect(admit(2, selected)).toEqual(first);
    expect(admit(2, { ...selected, input: { ...selected.input, digest: 'b'.repeat(64) } })).toEqual(
      { state: 'conflict' }
    );

    const evidence = {
      backendId: 'nanohost',
      ref: 'original-receiver-observation',
      digest: 'a'.repeat(64),
    };
    const consumed: ExecutionInputProof = {
      kind: 'intake',
      finding: 'consumed',
      obligation: first.receipt,
      selected,
      boundary: 'receiver-read-back',
      evidence,
    };
    const occurrence = {
      deploymentId: 'fixture-deployment',
      sourceOwner: 'nanohost',
      verb: 'apply-execution-proof',
      occurrenceKey: 'original-receiver-proof',
    } as const;
    const intentFor = (
      proof: ExecutionInputProof,
      occurrenceKey: string = occurrence.occurrenceKey
    ): ExecutionProofIntent => {
      const key = { ...occurrence, occurrenceKey };
      return {
        ...key,
        requestId: storageRequestId(key),
        target: proof.selected.grant,
        expectedGeneration: proof.selected.grant.generation,
        inputDigest: sha256CanonicalJson(proof),
      };
    };
    const settle = (id: number, intent: ExecutionProofIntent, proof: ExecutionInputProof) =>
      fixture.db.sqlite.transaction(() =>
        commitKernelInputProofInDb(
          fixture.db,
          {
            ...step(id, 'observe'),
            inspectedStep: proof.obligation,
            span: {
              ...step(id, 'observe').span,
              links: [
                {
                  traceId: execution.span.traceId,
                  spanId: step(proof.obligation.stepId === first.receipt.stepId ? 2 : 3, 'admit')
                    .span.spanId,
                  flags: 0,
                  attributes: [],
                  droppedAttributesCount: 0,
                },
              ],
            },
          },
          intent,
          proof,
          true,
          () => true
        )
      )();

    const submission = { kind: 'submission', disposition: 'unknown', evidence: null } as const;
    const submissionKey = { ...occurrence, occurrenceKey: 'withheld-create-reply' };
    const submissionIntent = {
      ...submissionKey,
      requestId: storageRequestId(submissionKey),
      target: selected.grant,
      expectedGeneration: selected.grant.generation,
      inputDigest: sha256CanonicalJson(submission),
    };
    const applySubmission = vi.fn(() => true);
    const admitObservation = () =>
      fixture.db.sqlite.transaction(() =>
        commitKernelExecutionEvidenceInDb(
          fixture.db,
          step(8, 'observe'),
          {
            version: 1,
            kind: 'submission',
            intent: submissionIntent,
            proof: submission,
          },
          true,
          () => true,
          applySubmission
        )
      )();
    const observed = admitObservation();
    expect(observed.state).toBe('settled');
    expect(admitObservation()).toEqual(observed);
    expect(applySubmission).toHaveBeenCalledTimes(1);
    expect(inspectKernelProofReceipt(fixture.db, submissionIntent, false)).toEqual(observed);

    const misdirected = { ...consumed, selected: sibling };
    expect(settle(4, intentFor(misdirected), misdirected)).toEqual({ state: 'conflict' });
    const stale = {
      ...consumed,
      selected: { ...selected, grant: { ...selected.grant, generation: 'successor' } },
    };
    expect(settle(4, intentFor(stale), stale)).toEqual({ state: 'conflict' });
    const intent = intentFor(consumed);
    expect(
      settle(
        4,
        { ...intent, target: { ...intent.target, deadline: '2026-11-21T12:00:00.000Z' } },
        consumed
      )
    ).toEqual({ state: 'conflict' });
    const receipt = settle(4, intent, consumed);
    expect(receipt.state).toBe('settled');
    const changedProof = { ...consumed, evidence: { ...evidence, digest: 'c'.repeat(64) } };
    expect(settle(4, intentFor(changedProof), changedProof)).toEqual({ state: 'conflict' });

    const unknown: ExecutionInputProof = { ...consumed, finding: 'unknown', evidence: null };
    expect(settle(5, intentFor(unknown, 'late-unknown'), unknown).state).toBe('settled');
    fixture.reopen();
    expect(inspectKernelInputDisposition(fixture.db, first.receipt)).toBe('consumed');
    expect(inspectKernelInputDisposition(fixture.db, second.receipt)).toBe('unknown');
    expect(inspectKernelInputProofInDb(fixture.db, intent, false)).toEqual(receipt);

    const accepted: ExecutionInputProof = {
      ...consumed,
      finding: 'accepted',
      obligation: second.receipt,
      selected: sibling,
    };
    expect(settle(6, intentFor(accepted, 'sibling-accepted'), accepted).state).toBe('settled');
    expect(inspectKernelInputDisposition(fixture.db, second.receipt)).toBe('accepted');
    const notSubmitted: ExecutionInputProof = {
      kind: 'non-submission',
      reason: 'removed-before-processing',
      obligation: second.receipt,
      selected: sibling,
      boundary: 'receiver-read-back',
      evidence: { ...evidence, ref: 'original-removal' },
    };
    expect(settle(7, intentFor(notSubmitted, 'removed-unprocessed'), notSubmitted).state).toBe(
      'settled'
    );
    expect(inspectKernelInputDisposition(fixture.db, second.receipt)).toBe('non-submission');
    const contradictsIntake: ExecutionInputProof = {
      ...notSubmitted,
      reason: 'refused-before-contact',
      boundary: 'before-provider-contact',
      evidence: { ...evidence, ref: 'contradictory-refusal' },
    };
    expect(
      settle(9, intentFor(contradictsIntake, 'contradictory-refusal'), contradictsIntake).state
    ).toBe('settled');
    expect(inspectKernelInputDisposition(fixture.db, second.receipt)).toBe('unknown');
    expect(inspectKernelInputDisposition(fixture.db, first.receipt)).toBe('consumed');

    expect(() =>
      fixture.db.sqlite
        .prepare(`UPDATE control_execution_steps
      SET invocation_json=json_set(invocation_json, '$.carriage.kernelInput.proof.finding', 'accepted')
      WHERE execution_id=? AND step_id=?`)
        .run(execution.ref.executionId, intent.requestId)
    ).toThrow('Execution step identity is immutable');
    expect(inspectKernelInputProofInDb(fixture.db, intent, true)).toEqual(receipt);
  });

  const scopedReleaseProofOrderingScenarios = [
    'fence',
    'handoff',
    'fence with an unrelated unknown volume',
    'fence with a disjoint volume writer still in flight',
    'fence with an unbounded unknown writer',
    'fence with an unbounded writer still in flight',
  ] as const;
  it.each(scopedReleaseProofOrderingScenarios)(
    'applies scoped release when %s commits first',
    (first) => {
      const fixture = journalFixture();
      const root: ExecutionJournalAdmission = {
        ...fixture.execution,
        definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
        exclusionRefs: ['turn:original', 'volume:still-writable'],
      };
      const grant: ExecutionGrant = {
        attemptId: testEntityId('attempt', 'scoped-release'),
        backendId: 'nanohost',
        bindingRef: 'original-binding',
        inputRef: 'original-package',
        operationId: 'original-release',
        execution: root.ref,
        turnId: root.workId,
        generation: 'original-generation',
        deadline: '2026-11-21T10:00:00.000Z',
      };
      const proposed = (
        id: number,
        kind: ExecutionJournalIntent['control']['kind']
      ): ExecutionJournalIntent => {
        const base = fixture.intent(id);
        return {
          ...base,
          execution: root,
          control: {
            ...base.control,
            kind,
            definitionVersion: root.definitionVersion,
            attemptId: grant.attemptId,
            operationId: grant.operationId,
          },
        };
      };
      const handoffKinds = [
        'terminal-publication',
        'output',
        'evidence',
        'outside-workspace-collection',
      ] as const;
      const unboundedWriter =
        first === 'fence with an unbounded unknown writer' ||
        first === 'fence with an unbounded writer still in flight';
      const disjointWriter =
        first === 'fence with an unrelated unknown volume' ||
        first === 'fence with a disjoint volume writer still in flight';
      const lateWriter = first.endsWith('still in flight');
      const materialize = proposed(22, 'materialize');
      const writer = {
        ...materialize,
        control: {
          ...materialize.control,
          operationId: unboundedWriter ? 'outstanding-create' : grant.operationId,
          target: disjointWriter
            ? { backendKind: 'nanohost', targetId: 'volume:still-writable', allocationRef: null }
            : null,
        },
      };
      const settleWriterUnknown = () => {
        const current = readExecutionJournalRoot(fixture.db, root.ref);
        settleExecutionJournalStep(fixture.db, {
          ref: { execution: root.ref, stepId: writer.stepId },
          expectedExecutionRevision: current.revision,
          state: 'unknown',
          outputRefs: [],
          span: {
            ...writer.span,
            endTimeUnixNano: writer.span.startTimeUnixNano,
            status: { code: 'ERROR' },
          },
          nextPhase: current.phase,
          terminalCause: current.terminalCause,
          exclusionRefs: current.exclusionRefs,
        });
      };
      fixture.db.sqlite.transaction(() => {
        const operations = [grant.operationId, ...handoffKinds.map((kind) => `original-${kind}`)];
        if (unboundedWriter) operations.push(writer.control.operationId);
        for (const [index, operationId] of operations.entries()) {
          const step = proposed(10 + index, 'admit');
          expect(
            admitKernelSchedulerGrantInDb(
              fixture.db,
              { ...step, control: { ...step.control, operationId, invocationId: operationId } },
              { ...grant, operationId },
              () => true
            ).state
          ).toBe('settled');
        }
        const cancel = proposed(1, 'cancel');
        if (unboundedWriter || disjointWriter) {
          writeExecutionJournalIntent(fixture.db, writer);
          if (!lateWriter) settleWriterUnknown();
        }
        const opened = writeExecutionJournalIntent(fixture.db, cancel);
        const { revision } = readExecutionJournalRoot(fixture.db, root.ref);
        settleExecutionJournalStep(fixture.db, {
          ref: opened.ref,
          expectedExecutionRevision: revision,
          state: 'completed',
          outputRefs: [],
          span: {
            ...cancel.span,
            endTimeUnixNano: cancel.span.startTimeUnixNano,
            status: { code: 'OK' },
          },
          nextPhase: 'closing',
          terminalCause: 'user-cancelled',
          exclusionRefs: root.exclusionRefs,
        });
      })();
      const intentFor = (
        key: string,
        sourceOwner: string,
        value: unknown,
        operation = grant.operationId
      ): ExecutionProofIntent => {
        const occurrence = {
          deploymentId: 'fixture-deployment',
          sourceOwner,
          verb: 'apply-execution-proof',
          occurrenceKey: key,
        } as const;
        return {
          ...occurrence,
          requestId: storageRequestId(occurrence),
          target: { ...grant, operationId: operation },
          expectedGeneration: grant.generation,
          inputDigest: sha256CanonicalJson(value),
        };
      };
      const record = (
        id: number,
        evidence: Exclude<KernelExecutionEvidence, { kind: 'submission' }>
      ) => {
        const kind =
          evidence.kind === 'fence'
            ? 'fence'
            : evidence.handoff.kind === 'terminal-publication'
              ? 'terminal-publication'
              : 'collect';
        const proposal = proposed(id, kind);
        return fixture.db.sqlite.transaction(() =>
          commitKernelExecutionEvidenceInDb(
            fixture.db,
            {
              ...proposal,
              control: {
                ...proposal.control,
                operationId: evidence.intent.target.operationId,
              },
            },
            evidence,
            true,
            () => true
          )
        )();
      };
      const fences = (
        scope: string,
        operation = grant.operationId
      ): Extract<KernelExecutionEvidence, { kind: 'fence' }> => {
        const proof = {
          kind: 'fence',
          fence: { backendId: grant.backendId, ref: `native:${scope}`, digest: 'a'.repeat(64) },
          coveredScopeRefs: [scope],
        } as const;
        return {
          version: 1,
          kind: 'fence',
          intent: intentFor(`${operation}:${scope}`, grant.backendId, proof, operation),
          proof: { ...proof, coveredScopeRefs: [...proof.coveredScopeRefs] },
        };
      };
      const addHandoffs = () => {
        for (const [index, kind] of handoffKinds.entries()) {
          const handoff = {
            kind,
            owner: { kind: 'workspace', workspaceId: testEntityId('ws', 'handoff-owner') },
            ref: `workspace:${kind}`,
            digest: 'b'.repeat(64),
          } as const;
          expect(
            record(3 + index, {
              version: 1,
              kind: 'handoff',
              intent: intentFor(kind, 'workspace', handoff, `original-${kind}`),
              handoff,
            }).state
          ).toBe('settled');
        }
      };
      const partial = proposed(7, 'release');
      const release = (intent: ExecutionJournalIntent, revision: number, eligible = true) =>
        fixture.db.sqlite.transaction(() =>
          releaseKernelExecutionScopesInDb(fixture.db, intent, grant, revision, () => eligible)
        )();

      if (first !== 'handoff') expect(record(2, fences('turn:original')).state).toBe('settled');
      else addHandoffs();
      const before = readExecutionJournalRoot(fixture.db, root.ref);
      const fence = fences('turn:original');
      expect(
        record(2, {
          ...fence,
          intent: {
            ...fence.intent,
            target: { ...grant, operationId: 'unadmitted-operation' },
          },
        })
      ).toEqual({ state: 'conflict' });
      expect(release(partial, before.revision)).toEqual({ state: 'unknown' });
      if (first !== 'handoff') addHandoffs();
      else expect(record(2, fences('turn:original')).state).toBe('settled');

      expect(release(partial, before.revision)).toEqual({ state: 'conflict' });
      const current = readExecutionJournalRoot(fixture.db, root.ref);
      if (unboundedWriter) {
        const decision = release(partial, current.revision);
        if (lateWriter) fixture.db.sqlite.transaction(settleWriterUnknown)();
        fixture.reopen();
        expect(kernelSchedulerScopeIsHeld(fixture.db, ['turn:original'])).toBe(true);
        expect(readExecutionJournalRoot(fixture.db, root.ref).exclusionRefs).toEqual(
          root.exclusionRefs
        );
        expect(decision).toEqual({ state: 'unknown' });
        expect(record(8, fences('turn:original', writer.control.operationId)).state).toBe(
          'settled'
        );
        expect(
          release(partial, readExecutionJournalRoot(fixture.db, root.ref).revision).state
        ).toBe('settled');
        fixture.reopen();
        expect(kernelSchedulerScopeIsHeld(fixture.db, ['turn:original'])).toBe(false);
        expect(kernelSchedulerScopeIsHeld(fixture.db, ['volume:still-writable'])).toBe(true);
        return;
      }
      expect(release(partial, current.revision, false)).toEqual({ state: 'unknown' });
      const partialReceipt = release(partial, current.revision);
      expect(partialReceipt.state).toBe('settled');
      if (lateWriter) fixture.db.sqlite.transaction(settleWriterUnknown)();
      fixture.reopen();
      expect(release(partial, current.revision, false)).toEqual(partialReceipt);
      expect(release(partial, current.revision + 1, false)).toEqual({ state: 'conflict' });
      expect(
        release(
          {
            ...partial,
            carriage: { ...partial.carriage, operation: 'changed-release' },
          },
          current.revision,
          false
        )
      ).toEqual({ state: 'conflict' });
      expect(readExecutionJournalRoot(fixture.db, root.ref)).toMatchObject({
        phase: 'closing',
        terminalCause: 'user-cancelled',
        exclusionRefs: ['volume:still-writable'],
      });
      expect(kernelSchedulerScopeIsHeld(fixture.db, ['volume:still-writable'])).toBe(true);
      expect(kernelSchedulerScopeIsHeld(fixture.db, ['turn:original', 'volume:disjoint'])).toBe(
        false
      );
      expect(record(8, fences('volume:still-writable')).state).toBe('settled');
      if (disjointWriter) {
        expect(
          release(proposed(9, 'release'), readExecutionJournalRoot(fixture.db, root.ref).revision)
            .state
        ).toBe('settled');
        expect(readExecutionJournalRoot(fixture.db, root.ref)).toMatchObject({
          phase: 'closed',
          exclusionRefs: [],
        });
        return;
      }
      const diagnostic = proposed(21, 'observe');
      const open = fixture.db.sqlite.transaction(() =>
        writeExecutionJournalIntent(fixture.db, diagnostic)
      )();
      const pending = readExecutionJournalRoot(fixture.db, root.ref);
      const final = proposed(9, 'release');
      expect(release(final, pending.revision)).toEqual({ state: 'unknown' });
      expect(readExecutionJournalRoot(fixture.db, root.ref).exclusionRefs).toEqual([
        'volume:still-writable',
      ]);
      const ended = {
        ref: open.ref,
        expectedExecutionRevision: pending.revision,
        outputRefs: [],
        state: 'completed' as const,
        span: {
          ...diagnostic.span,
          endTimeUnixNano: diagnostic.span.startTimeUnixNano,
          status: { code: 'OK' as const },
        },
        terminalCause: 'late-diagnostic',
        exclusionRefs: pending.exclusionRefs,
      };
      expect(() =>
        fixture.db.sqlite.transaction(() =>
          settleExecutionJournalStep(fixture.db, { ...ended, nextPhase: 'open' })
        )()
      ).toThrow('A closing Core scheduler execution cannot reopen.');
      fixture.db.sqlite.transaction(() =>
        settleExecutionJournalStep(fixture.db, { ...ended, nextPhase: 'closing' })
      )();
      const closeRevision = readExecutionJournalRoot(fixture.db, root.ref).revision;
      const finalReceipt = release(final, closeRevision);
      expect(finalReceipt.state).toBe('settled');
      fixture.reopen();
      expect(release(final, closeRevision, false)).toEqual(finalReceipt);
      expect(readExecutionJournalRoot(fixture.db, root.ref)).toMatchObject({
        phase: 'closed',
        terminalCause: 'user-cancelled',
        exclusionRefs: [],
      });
    }
  );

  it('preserves the image reconciliation outcome when its earlier abandonment cause differs', () => {
    const f = journalFixture();
    const original = f.intent();
    const reconciliation = f.intent(2);
    f.db.sqlite.transaction(() => {
      const finish = (proposal: ExecutionJournalIntent, cause: string) => {
        const invocation = writeExecutionJournalIntent(f.db, proposal);
        settleExecutionJournalStep(f.db, {
          ref: invocation.ref,
          expectedExecutionRevision: readExecutionJournalRoot(f.db, f.execution.ref).revision,
          state: 'failed',
          outputRefs: [],
          span: {
            ...proposal.span,
            endTimeUnixNano: proposal.span.startTimeUnixNano,
            status: { code: 'ERROR' },
          },
          nextPhase: 'closing',
          terminalCause: cause,
          exclusionRefs: f.execution.exclusionRefs,
        });
      };
      finish(original, 'Original image acquisition abandoned.');
      finish(
        {
          ...reconciliation,
          control: { ...reconciliation.control, kind: 'consume-receipt' },
        },
        'Original image acquisition outcome remains unknown.'
      );
    })();
    f.reopen();
    expect(readExecutionJournalRoot(f.db, f.execution.ref).terminalCause).toBe(
      'Original image acquisition outcome remains unknown.'
    );
  });

  it('keys a consumed receipt by the original binding, operation and sequence', () => {
    const f = journalFixture();
    const tuple = {
      harnessBindingRef: 'original-binding',
      operationId: 'original-operation',
      sequence: 1,
      resultFingerprint: 'a'.repeat(64),
    };
    const consumer = 'workspace:original-consumer';
    const commit = (key: typeof tuple, owner: string) =>
      controlStoreFor(f.db.sqlite).write(() =>
        recordCoreHarnessConsumption(f.db, key, owner, new Date().toISOString())
      );
    commit(tuple, consumer);
    commit(tuple, consumer);
    f.reopen();
    expect(readCoreHarnessConsumption(f.db, tuple)).toBe(consumer);
    expect(() =>
      readCoreHarnessConsumption(f.db, { ...tuple, resultFingerprint: 'b'.repeat(64) })
    ).toThrow('retained consumer acknowledgement conflicts');
    expect(() => commit(tuple, 'workspace:changed-consumer')).toThrow(
      'consumer acknowledgement replay conflicts'
    );
  });

  it('keeps a nested unknown child immutable when the parent completes and late inspection is linked', async () => {
    const f = journalFixture();
    const parent = f.intent();
    const parentInvocation = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, parent)
    );
    const child: ExecutionJournalIntent = {
      ...f.intent(2),
      parentStepId: parent.stepId,
      parent: { ref: parentInvocation.ref, deadlineUnixNano: parent.control.deadlineUnixNano },
      span: { ...openSpan(3), parentSpanId: parent.span.spanId },
    };
    const childInvocation = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, child)
    );
    const unknownInput = await ending(f, child, 'unknown');
    const unknown = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, unknownInput)
    );
    const completedParent = await ending(f, parent);
    const endedParent = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, completedParent)
    );
    const inspectionInput = f.intent(3);
    const inspection: ExecutionJournalIntent = {
      ...inspectionInput,
      inspectedStep: childInvocation.ref,
      control: { ...inspectionInput.control, kind: 'inspect-cleanup' },
      carriage: { ...inspectionInput.carriage, operation: 'image.inspect' },
      span: {
        ...openSpan(4),
        parentSpanId: f.execution.span.spanId,
        links: [
          {
            traceId: unknown.span.traceId,
            spanId: unknown.span.spanId,
            flags: 1,
            attributes: [],
            droppedAttributesCount: 0,
          },
        ],
      },
    };
    controlStoreFor(f.db.sqlite).write(() => writeExecutionJournalIntent(f.db, inspection));
    const inspectionEnd = await ending(f, inspection);
    const inspected = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, inspectionEnd)
    );
    f.reopen();
    expect(await f.reader.readLinkedInspections(childInvocation.ref)).toStrictEqual([
      { inspectedStep: childInvocation.ref, inspection: inspected },
    ]);
    expect(await f.reader.readEndedSteps(parent.execution.ref)).toStrictEqual([
      endedParent,
      unknown,
      inspected,
    ]);
    expect(
      (await f.reader.readEndedSteps(parent.execution.ref)).find(
        (step) => step.ref.stepId === child.stepId
      )
    ).toStrictEqual(unknown);
    expect(await f.reader.readInvocation(childInvocation.ref)).toMatchObject({
      state: 'unknown',
      parent: child.parent,
      remainingMs: 0,
      control: { deadlineUnixNano: child.control.deadlineUnixNano },
    });
    const rewrite = await ending(f, child);
    expect(() =>
      controlStoreFor(f.db.sqlite).write(() => settleExecutionJournalStep(f.db, rewrite))
    ).toThrow();
    expect((await f.reader.readExecution(parent.execution.ref)).exclusionRefs).toEqual(
      f.execution.exclusionRefs
    );
    expect(
      (await f.reader.readEndedSteps(parent.execution.ref)).find(
        (step) => step.ref.stepId === child.stepId
      )
    ).toStrictEqual(unknown);
  });

  it.each([false, true])(
    'runs kernel repair with Server work absent, revoked=%s',
    async (revoked) => {
      const fixture = journalFixture();
      const coreDb = fixture.db;
      const userId = ensureLocalUser(coreDb);
      const requestActor = { kind: 'local' as const, userId };
      const actor = { kind: 'user' as const, id: userId };
      const principal = { kind: 'human' as const, id: userId };
      const server = { owner: { kind: 'server' }, kind: 'server', id: 'server' } as const;
      const allocationRef = 'repair-allocation';
      const policy = validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          {
            id: allocationRef,
            kind: 'permission',
            state: 'active',
            effect: 'allow',
            author: principal,
            authority: { kind: 'human', userId },
            authoredAt: new Date().toISOString(),
            scope: {
              subjects: [principal],
              actions: ['repair.model-call'],
              resources: [{ kind: 'container', container: server }],
            },
            lifetime: { anchor: server },
            grant: {
              kind: 'repair.model-call',
              scope: 'server',
              unit: 'model-call',
              window: 'utc-day',
            },
          },
        ],
      });
      const decisionId = allocateEntityId('pd');
      const permission = {
        coreDb,
        ownerScope: 'server' as const,
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: policyDigest(policy),
        subjectSummary: principal,
        result: 'allow' as const,
        reasonCode: 'granted',
        auditActor: actor,
      };
      try {
        await recordProductPermissionDecision({
          ...permission,
          decisionId: allocateEntityId('pd'),
          action: 'workspace.configure',
          resourceSummary: { policyRevision: policyDigest(policy) },
          contextSummary: { operation: 'policy.write' },
          enforcementPoint: 'policy.write@decide',
        });
        await recordProductPermissionDecision({
          ...permission,
          decisionId,
          action: 'repair.model-call',
          resourceSummary: { route: 'primary' },
          contextSummary: { operation: 'repair.model-call' },
          enforcementPoint: 'repair.model-call@admit',
        });
        const backend = createEncryptedFileVaultBackend({
          masterKey: Buffer.alloc(32, 9),
          storeDir: join(fixture.root, 'server', 'vault'),
        });
        const referenceId = allocateEntityId('vault');
        backend.store({
          referenceId,
          material: 'private fixture value',
          metadata: { ownerScope: 'server' },
        });
        await createVaultReference(coreDb, {
          referenceId,
          ownerScope: 'server',
          displayName: 'Repair provider fixture',
          secretKind: 'provider-api-key',
          backendKind: 'encrypted-file',
          backendLocator: `encrypted-file://server/vault/${referenceId}`,
        });

        const runtime = createRuntimeConfigManager({
          dataRoot: fixture.root,
          initialSnapshot: createInMemoryRuntimeConfigSnapshot({
            dataRoot: fixture.root,
            openKitConfig: { policy: { mediation: policy } },
            providerRegistry: new ProviderRegistry([
              {
                id: 'repair-provider',
                displayName: 'Repair fixture',
                vendor: 'openai',
                kind: 'direct',
                models: ['gpt-5.1'],
                secretRef: `vault://${referenceId}`,
              },
            ]),
            gatewayConfig: {
              schemaVersion: 1,
              enabled: true,
              logicalModels: [
                {
                  id: 'repair-model',
                  displayName: 'Repair model',
                  contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
                  routes: [
                    {
                      id: 'primary',
                      providerProfileId: 'repair-provider',
                      providerModel: 'gpt-5.1',
                    },
                  ],
                },
              ],
            },
          }),
        });
        await runtime.bindNativePolicyPublication(coreDb);
        const draft = fixture.intent(1);
        const entry: ExecutionJournalIntent = {
          ...draft,
          execution: {
            ...draft.execution,
            definitionVersion: CORE_REPAIR_EXECUTION_DEFINITION,
          },
          control: {
            ...draft.control,
            definitionVersion: CORE_REPAIR_EXECUTION_DEFINITION,
            kind: 'admit',
            actor,
            permittingDecisionRef: decisionId,
            attemptId: 'original-repair',
            authorityRefs: ['role:repair'],
          },
        };
        const linkedSpan = (id: number, predecessor: ExecutionJournalSpan) => ({
          ...openSpan(id),
          parentSpanId: entry.execution.span.spanId,
          links: [
            {
              traceId: predecessor.traceId,
              spanId: predecessor.spanId,
              flags: 0,
              attributes: [],
              droppedAttributesCount: 0,
            },
          ],
        });
        const reservedSpan = linkedSpan(30, entry.span);
        const callId = allocateEntityId('cap');
        const contact = vi.fn();
        const path = serverStoragePath(fixture.root, 'server-work');
        expect(existsSync(path)).toBe(false);
        const run = () =>
          runKernelRepair({
            coreDb,
            runtimeConfig: () => runtime.current(),
            vaultBackend: () => backend,
            actor: requestActor,
            logicalModelId: 'repair-model',
            signal: new AbortController().signal,
            admission: { callId, routeRef: 'primary', allocationRef, inputDigest: 'a'.repeat(64) },
            entry,
            reserve: (intent) => ({
              ...entry,
              stepId: 'prepare-reserve',
              inspectedStep: intent.target.entryStep,
              control: { ...entry.control, kind: 'reserve', invocationId: intent.requestId },
              span: reservedSpan,
            }),
            terminal: (reservation) => ({
              ...entry,
              stepId: 'prepare-terminal',
              inspectedStep: reservation.result.step,
              control: { ...entry.control, kind: 'terminal-publication' },
              span: linkedSpan(31, reservedSpan),
            }),
            attempt: async ({ execution }, transport) => {
              if (revoked) await revokeVaultReference(coreDb, { referenceId });
              await transport.finalRequestAdmission({
                payload: { input: 'fixture' },
                contextWindowTokens: 1000,
                outputReserveTokens: 10,
              });
              contact();
              execution.commit();
              return { disposition: 'succeeded', reply: 'repaired', inputTokens: 2 };
            },
          });
        const result = await run();
        const steps = await fixture.reader.readEndedSteps(entry.execution.ref);
        expect(steps.map(({ control }) => control.kind)).toEqual([
          'admit',
          'reserve',
          'terminal-publication',
        ]);
        if (revoked) {
          expect(result).toMatchObject({
            state: 'ready',
            value: { state: 'refused', reason: 'vault' },
          });
          expect(contact).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({
            state: 'ready',
            value: { state: 'succeeded', reply: 'repaired' },
          });
          await expect(run()).resolves.toMatchObject({
            state: 'ready',
            value: { state: 'terminal' },
          });
          expect(contact).toHaveBeenCalledTimes(1);
        }
        const retained = listServerAuditEvents(coreDb).filter(
          (event) => event.action === 'repair.model-call'
        );
        expect(retained).toEqual([
          expect.objectContaining({
            actor,
            permissionDecisionId: decisionId,
            outcome: revoked ? 'failed' : 'succeeded',
          }),
        ]);
        expect(existsSync(path)).toBe(false);
      } finally {
        await shutdownControlStoreWorkerClient();
      }
    }
  );

  it('deducts one repair slot and atomically settles the original terminal Audit', async () => {
    const f = journalFixture();
    const allocation = {
      kind: 'repair.model-call',
      scope: 'server',
      unit: 'model-call',
      window: 'utc-day',
      limit: 1,
    } as const;
    const prepare = (n: number) => {
      const draft = f.intent(n);
      const execution = {
        ...draft.execution,
        ref: { ...draft.execution.ref, executionId: `repair-${n}` },
        definitionVersion: CORE_REPAIR_EXECUTION_DEFINITION,
      };
      const entry: ExecutionJournalIntent = {
        ...draft,
        execution,
        control: {
          ...draft.control,
          definitionVersion: execution.definitionVersion,
          kind: 'admit',
          attemptId: `repair-attempt-${n}`,
          permittingDecisionRef: testEntityId('pd', `repair-decision-${n}`),
          authorityRefs: ['role:repair'],
        },
        carriage: { ...draft.carriage, operation: 'repair.model-call' },
      };
      const choice = {
        callId: `repair-call-${n}`,
        routeRef: 'route:repair',
        allocationRef: 'allocation:server',
        policyRevision: `sha256:${'b'.repeat(64)}`,
        inputDigest: 'a'.repeat(64),
      };
      const open = (qualified: boolean) =>
        controlStoreFor(f.db.sqlite).write(() =>
          admitRepairCallEntryInDb(f.db, entry, choice, () => qualified)
        );
      expect(open(false)).toEqual({ state: 'unknown' });
      const admitted = open(true);
      if (admitted.state !== 'settled')
        throw new Error('Fixture did not admit the original repair.');
      expect(open(false)).toEqual(admitted);
      const intent = admitted.receipt;
      const proposal: ExecutionJournalIntent = {
        ...entry,
        stepId: `reserve-${n}`,
        inspectedStep: intent.target.entryStep,
        control: { ...entry.control, kind: 'reserve', invocationId: intent.requestId },
        span: {
          ...openSpan(n + 20),
          parentSpanId: execution.span.spanId,
          links: [
            {
              traceId: entry.span.traceId,
              spanId: entry.span.spanId,
              flags: 0,
              attributes: [],
              droppedAttributesCount: 0,
            },
          ],
        },
      };
      return { intent, proposal, entry, choice };
    };
    const prepared = [prepare(1), prepare(2)] as const;
    const [{ intent: original, proposal: originalProposal, entry, choice }] = prepared;
    f.reopen();
    const admit = (draft = entry, input = choice, qualified = true) =>
      controlStoreFor(f.db.sqlite).write(() =>
        admitRepairCallEntryInDb(f.db, draft, input, () => qualified)
      );
    expect(admit(entry, choice, false)).toEqual({ state: 'settled', receipt: original });
    expect(
      admit({
        ...entry,
        execution: {
          ...entry.execution,
          ref: { ...entry.execution.ref, executionId: 'substituted-repair' },
        },
        stepId: 'substituted-entry',
        control: {
          ...entry.control,
          attemptId: 'substituted-attempt',
          invocationId: 'substituted-invocation',
        },
      })
    ).toEqual({ state: 'conflict' });
    const otherActor = { kind: 'user' as const, id: testEntityId('usr', 'different-repair-user') };
    expect(admit({ ...entry, control: { ...entry.control, actor: otherActor } })).toEqual({
      state: 'conflict',
    });
    expect(admit(entry, { ...choice, routeRef: 'route:replacement' })).toEqual({
      state: 'conflict',
    });
    expect(admit(entry, { ...choice, inputDigest: 'c'.repeat(64) })).toEqual({ state: 'conflict' });
    expect(
      f.db.sqlite.prepare('SELECT 1 FROM control_executions WHERE id=?').get('substituted-repair')
    ).toBeUndefined();
    expect(
      controlStoreFor(f.db.sqlite).write(() =>
        commitRepairReservationStep(f.db, original, originalProposal, () => null, true)
      )
    ).toEqual({ state: 'unknown' });
    expect(
      controlStoreFor(f.db.sqlite).write(() =>
        commitRepairReservationStep(
          f.db,
          original,
          originalProposal,
          () => ({
            allocationRef: original.target.allocationRef,
            policyRevision: `sha256:${'c'.repeat(64)}`,
            allocation,
          }),
          true
        )
      )
    ).toEqual({ state: 'unknown' });
    expect(inspectRepairReservationStep(f.db, original, true)).toEqual({ state: 'absent' });
    const results = await Promise.all(
      prepared.map(async ({ intent, proposal }) =>
        controlStoreFor(f.db.sqlite).write(() =>
          commitRepairReservationStep(
            f.db,
            intent,
            proposal,
            (entry) => ({
              allocationRef: entry.target.allocationRef,
              policyRevision: entry.expectedGeneration,
              allocation,
            }),
            true
          )
        )
      )
    );
    const winner = results[0];
    expect(winner).toMatchObject({ state: 'reserved-now' });
    expect(results[1]).toEqual({ state: 'refused', reason: 'budget' });

    f.reopen();
    expect(inspectRepairReservationStep(f.db, original, true)).toEqual({
      ...winner,
      state: 'reserved',
    });
    expect(
      inspectRepairReservationStep(f.db, { ...original, inputDigest: 'changed' }, true)
    ).toEqual({ state: 'conflict' });
    expect(inspectRepairReservationStep(f.db, prepared[1]!.intent, false)).toEqual({
      state: 'refused',
      reason: 'budget',
    });
    const endedBeforeTerminal = await f.reader.readEndedSteps(original.target.entryStep.execution);
    expect(endedBeforeTerminal.map(({ control }) => control.kind)).toEqual(['admit', 'reserve']);
    if (winner?.state !== 'reserved-now') throw new Error('Repair fixture did not reserve.');
    const { reservation } = winner;
    const reserveSpan = prepared[0]!.proposal.span;
    const terminal: ExecutionJournalIntent = {
      ...prepared[0]!.proposal,
      stepId: 'candidate-terminal',
      inspectedStep: reservation.result.step,
      control: { ...prepared[0]!.proposal.control, kind: 'terminal-publication' },
      span: {
        ...openSpan(50),
        parentSpanId: prepared[0]!.proposal.execution.span.spanId,
        links: [
          {
            traceId: reserveSpan.traceId,
            spanId: reserveSpan.spanId,
            flags: 0,
            attributes: [],
            droppedAttributesCount: 0,
          },
        ],
      },
    };
    const outcome = { disposition: 'unknown', inputTokens: 18 } as const;
    const settle = (draft = terminal) =>
      f.db.sqlite.transaction(() =>
        commitRepairTerminalAuditInDb(f.db, reservation, draft, outcome)
      )();
    const contradictory = [
      { ...terminal, control: { ...terminal.control, actor: otherActor } },
      { ...terminal, control: { ...terminal.control, attemptId: 'substituted-attempt' } },
      {
        ...terminal,
        control: {
          ...terminal.control,
          permittingDecisionRef: testEntityId('pd', 'different-repair-decision'),
        },
      },
      { ...terminal, execution: prepared[1]!.proposal.execution },
      { ...terminal, inspectedStep: original.target.entryStep },
    ];
    for (const draft of contradictory) expect(settle(draft)).toEqual({ state: 'conflict' });
    f.db.sqlite.exec(`CREATE TRIGGER fixture_refuse_terminal BEFORE INSERT ON control_execution_steps
      WHEN NEW.step_id LIKE 'repair-terminal:%' BEGIN SELECT RAISE(ABORT, 'fixture refuse terminal'); END`);
    expect(settle).toThrow('fixture refuse terminal');
    expect(listServerAuditEvents(f.db)).toEqual([]);
    expect(inspectRepairReservationStep(f.db, original, false).state).toBe('reserved');
    f.db.sqlite.exec('DROP TRIGGER fixture_refuse_terminal');

    const recorded = settle();
    expect(recorded.state).toBe('settled');
    expect(settle()).toEqual(recorded);
    const divergent = f.db.sqlite.transaction(() =>
      commitRepairTerminalAuditInDb(f.db, reservation, terminal, {
        disposition: 'succeeded',
        inputTokens: 18,
      })
    )();
    expect(divergent).toEqual({ state: 'conflict' });
    f.reopen();
    if (recorded.state !== 'settled') throw new Error('Fixture did not persist terminal Audit.');
    expect(settle()).toEqual(recorded);
    for (const draft of contradictory) expect(settle(draft)).toEqual({ state: 'conflict' });
    expect(inspectRepairReservationStep(f.db, original, false)).toEqual({
      state: 'terminal',
      auditEventId: recorded.receipt,
    });
    expect(listServerAuditEvents(f.db)).toEqual([
      expect.objectContaining({
        id: recorded.receipt,
        action: 'repair.model-call',
        outcome: 'unknown',
        resource: `repair-call:${original.target.callId}`,
        permissionDecisionId: terminal.control.permittingDecisionRef,
      }),
    ]);
    const terminalStep = await f.reader.readInvocation({
      execution: original.target.entryStep.execution,
      stepId: `repair-terminal:${original.requestId}`,
    });
    expect(terminalStep.carriage.repairTerminal).toEqual({ version: 1, outcome });
    expect(terminalStep.control.outputRefs).toContain(recorded.receipt);

    const originalReserve = await f.reader.readInvocation(reservation.result.step);
    const midnight = new Date(Number(originalReserve.clock.admittedUnixNano / 1_000_000n));
    midnight.setUTCHours(24, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(midnight);
      const reserve = ({ intent, proposal }: ReturnType<typeof prepare>) =>
        controlStoreFor(f.db.sqlite).write(() =>
          commitRepairReservationStep(
            f.db,
            intent,
            proposal,
            (originalEntry) => ({
              allocationRef: originalEntry.target.allocationRef,
              policyRevision: originalEntry.expectedGeneration,
              allocation,
            }),
            true
          )
        );
      const nextDay = reserve(prepare(3));
      if (nextDay.state !== 'reserved-now') throw new Error('The UTC allowance did not roll over.');
      const { execution, stepId } = nextDay.reservation.result.step;
      const trigger = f.db.sqlite
        .prepare("SELECT sql FROM sqlite_schema WHERE name='control_execution_steps_settle_once'")
        .pluck()
        .get();
      if (typeof trigger !== 'string') throw new Error('Fixture needs the immutable step trigger.');
      f.db.sqlite.transaction(() => {
        f.db.sqlite.exec('DROP TRIGGER control_execution_steps_settle_once');
        f.db.sqlite
          .prepare(`UPDATE control_execution_steps
            SET invocation_json=json_set(invocation_json, '$.clock.admittedUnixNano', 'unreadable')
            WHERE execution_id=? AND step_id=?`)
          .run(execution.executionId, stepId);
        f.db.sqlite.exec(trigger);
      })();
      f.reopen();
      expect(f.db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      const blocked = prepare(4);
      expect(reserve(blocked)).toEqual({ state: 'unknown' });
      expect(inspectRepairReservationStep(f.db, blocked.intent, true)).toEqual({ state: 'absent' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads original intent after a fresh process opens Core without granting a restarted allowance', () => {
    const f = journalFixture();
    const intent = f.intent();
    const original = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, intent)
    );
    expect(original.remainingMs).toBeGreaterThan(0);
    f.db.sqlite.close();
    const source = `
      import { openCoreDb } from ${JSON.stringify(new URL('../storage/db.ts', import.meta.url).href)};
      import { createExecutionStepJournalReader } from ${JSON.stringify(new URL('./execution-journal.ts', import.meta.url).href)};
      const db = openCoreDb(process.argv[1]);
      try {
        const reader = createExecutionStepJournalReader(db, { kind: 'server' });
        const ref = { execution: { owner: { kind: 'server' }, executionId: process.argv[2] }, stepId: process.argv[3] };
        const invocation = await reader.readInvocation(ref);
        console.log(JSON.stringify({ state: invocation.state, remainingMs: invocation.remainingMs, clock: invocation.clock, deadline: invocation.control.deadlineUnixNano }, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      } finally { db.sqlite.close(); }
    `;
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        source,
        f.root,
        intent.execution.ref.executionId,
        intent.stepId,
      ],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 15_000 }
    );
    expect(JSON.parse(output)).toEqual({
      state: 'intent',
      remainingMs: 0,
      clock: {
        processWitness: original.clock.processWitness,
        admittedUnixNano: original.clock.admittedUnixNano.toString(),
        admittedMonotonicNano: original.clock.admittedMonotonicNano.toString(),
      },
      deadline: original.control.deadlineUnixNano?.toString(),
    });
  });
});
