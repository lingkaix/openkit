import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ServerEvidenceBundleRecord,
  ServerEvidenceBundleRecordSchema,
} from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import {
  type ActorRef,
  canonicalJsonText,
  compareCodeUnits,
  deriveEntityId,
  type KernelAuditEvent,
  readRetainedV1,
} from '@openkit/protocol';
import { policyDigest, sha256CanonicalJson, sha256Hex } from '@openkit/protocol/digest';
import {
  buildWorkerCanonicalTerminalEventRecord,
  WorkerCanonicalTerminalEventDataSchema,
} from '@openkit/worker-protocol';
import {
  auditEventFromRow,
  prepareServerAuditEvent,
  recordServerAuditEvent,
} from '../audit-events.js';
import { validatePolicyDocument } from '../policy/statements.js';
import { findNamedAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  abandonCoreImageJournal,
  hasCoreIdleCleanupConsumption,
  isSandboxReleaseRefusalFenced,
  localCoreJournalIntent,
  readCoreHarnessConsumption,
  readSandboxReleaseRefusalOrder,
  sandboxReleaseRefusalExecutionId,
  settleCoreIdleJournal,
} from '../runtime/core-journal-records.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithoutEffects,
  EXECUTION_ATTEMPT_BUDGET_MS,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionGrantInDb,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from '../runtime/execution-attempt-records.js';
import {
  CORE_CONTAINMENT_EXECUTION_DEFINITION,
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
  CORE_SCHEDULER_EXECUTION_DEFINITION,
  commitKernelExecutionEvidenceInDb,
  decodeExecutionJournalIntent,
  decodeExecutionJournalSpan,
  encodeExecutionJournalValue,
  executionJournalProcessWitness,
  inspectKernelExecutionReleaseInDb,
  inspectKernelProofReceipt,
  readExecutionJournalEndedStep,
  readExecutionJournalInvocation,
  readExecutionJournalLinkedInspections,
  readExecutionJournalRoot,
  readKernelSchedulerGrantInDb,
  releaseKernelExecutionScopesInDb,
  schedulerPreparationClockAllowsOperation,
  settleExecutionJournalStep,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import type {
  EndedExecutionStep,
  ExecutionInvocationCarriage,
  ExecutionJournalExecution,
  ExecutionJournalIntent,
  ExecutionStepRef,
} from '../runtime/execution-step-journal.js';
import { nonClosedSandboxAttempts } from '../runtime/idle-cleanup-records.js';
import { nanoHostStartupDeadline } from '../runtime/nanohost-attempt-clocks.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
} from '../runtime/nanohost-effect-identity.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import {
  getWorkerBackendSession,
  getWorkerBackendSessionByPackage,
  readNanoHostSubmissionPlacement,
  readNanoHostWorkerLease,
  readNanoHostWorkerRouteBinding,
} from '../runtime/worker-backend-session-records.js';
import { isWorkerCancellationFinalCause } from '../runtime/worker-control-final-receipt.js';
import { getWorkerControlAcceptedFinalStatus } from '../runtime/worker-control-records.js';
import {
  inspectNanoHostWorkerFinalSequences,
  matchesAcceptedWorkerControlSequence,
} from '../runtime/worker-control-sequences.js';
import {
  type CoreSchedulerQueueEntry,
  requireSchedulerExecutionAttemptAdmissionContext,
} from '../scheduler-records.js';
import type {
  ExecutionGrant,
  ExecutionHandoff,
  ExecutionProofIntent,
  ExecutionProofReceipt,
  NanoHostCoreReads,
} from './control-kernel-port.js';
import type { KernelExecutionEvidence } from './control-kernel-proof-codecs.js';
import { commandInputHash } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import {
  type ControlCoreImageResult,
  type ControlCoreJournalInput,
  type ControlCoreNanoHostAcceptedFinalResult,
  ControlCoreNanoHostAcceptedFinalResultSchema,
  type ControlNanoHostFirstSubmissionInput,
  type ControlNanoHostFirstSubmissionResult,
  ControlNanoHostFirstSubmissionResultSchema,
  type ControlNanoHostMaterializationPreparationInput,
  type ControlNanoHostOrphanRetirementInput,
  type ControlNanoHostTerminalReleaseInput,
  CoreJournalRefusal,
  CoreNanoHostFinalIntakeSchema,
  readCoreJournalLineage,
  SECURITY_CONTAINMENT_LIMITS,
} from './core-journal-codecs.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { ExecutionAttemptRefusal } from './execution-attempt-codecs.js';
import {
  type NanoHostRecoveryLease,
  readNanoHostPhysicalCleanupReceipt,
} from './nanohost-recovery-native.js';
import {
  type NanoHostWorkerFinalDecision,
  nanoHostWorkerFinalDecisionFingerprint,
  readRetainedNanoHostSubmission,
} from './nanohost-submitted-lease.js';
import {
  inspectNanoHostWorkerBinding,
  matchesNanoHostWorkerLineage,
  nanoHostWorkerBindingLiveness,
  nanoHostWorkerCancellationFinalEligible,
  nanoHostWorkerLineage,
} from './nanohost-worker-binding.js';
import type { NativeRuntimePolicyPublication } from './runtime-policy-publication.js';
import { recordContainmentGapInDb } from './security-canary-audit-native.js';
import type {
  ControlStandaloneAuditInput,
  SecurityCanaryAuditObservation,
} from './standalone-audit-codecs.js';
import {
  type StorageDecision,
  type StorageReceiptLookup,
  type StorageResult,
  storageRequestId,
} from './storage-owner.js';
import {
  type ControlWorkerFinalStatusCommand,
  WorkerFinalStatusRefusal,
} from './worker-control-final-status-codecs.js';
import { requireCompleteBackendWorkspaceHandleHandoff } from './workspace-handoff-read.js';

function requireNanoHostEvidence<T>(result: StorageResult<'nanohost', T> | undefined): T {
  if (result?.state !== 'ready')
    throw new CoreJournalRefusal('Admitted NanoHost evidence is unavailable.');
  return result.value;
}

function requireCoreImageTarget(
  target: ControlCoreImageResult['target'],
  nanoHost?: NanoHostCoreReads
) {
  const admitted = requireNanoHostEvidence(nanoHost?.readTarget(target.targetId));
  if (
    !admitted?.predecessorFenced ||
    !admitted.ready ||
    !admitted.freshEmpty ||
    admitted.targetId !== target.targetId ||
    admitted.identityId !== target.identityId ||
    admitted.deploymentId !== target.deploymentId ||
    admitted.connectionGeneration !== target.connectionGeneration ||
    admitted.physicalEpoch !== target.physicalEpoch
  )
    throw new CoreJournalRefusal('Image execution provenance is unavailable.');
}

function imageTargetBinding(target: ControlCoreImageResult['target']): string {
  return `nanohost-target/v1:${target.deploymentId}:${target.targetId}:${target.connectionGeneration}:${target.physicalEpoch}`;
}

const imageTargetAuthorityPrefix = 'image-acquire-target/v1:';

function imageTargetAuthority({
  targetId,
  identityId,
  deploymentId,
  physicalEpoch,
}: ControlCoreImageResult['target']): string {
  // A re-admitted connection can return the original result from the same live Runtime Epoch.
  return (
    imageTargetAuthorityPrefix +
    commandInputHash({ targetId, identityId, deploymentId, physicalEpoch })
  );
}

/** Resolves the original acquisition by request ID, without granting permission to send it. */
export function readCoreImageAcquisitionRef(
  db: CoreDb,
  requestId: string
): ControlCoreImageResult['ref'] | null {
  const rows = db.sqlite
    .prepare(`SELECT s.execution_id, s.step_id FROM control_execution_steps s
      JOIN control_executions r ON r.id = s.execution_id
      WHERE r.definition_version = ?
        AND json_extract(s.invocation_json, '$.carriage.operation') = 'image.acquire'
        AND json_extract(s.invocation_json, '$.carriage.requestId') = ?
        AND json_extract(s.control_json, '$.kind') = 'resolve-setup'
      LIMIT 2`)
    .all(CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION, requestId) as {
    execution_id: string;
    step_id: string;
  }[];
  if (rows.length > 1) throw new CoreJournalRefusal('Original image invocation is ambiguous.');
  const row = rows[0];
  return row
    ? {
        execution: { owner: { kind: 'server' }, executionId: row.execution_id },
        stepId: row.step_id,
      }
    : null;
}

/** Settles an admitted result or inspects its original decision within the Core writer frame. */
export function applyControlCoreImageResult(
  db: CoreDb,
  { ref, settlement, target }: ControlCoreImageResult,
  nanoHost: NanoHostCoreReads | undefined
): string {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new CoreJournalRefusal('Image result requires the Core writer transaction.');
  requireCoreImageTarget(target, nanoHost);
  const occurrence = readCoreImageAcquisitionRef(db, settlement.requestId);
  if (!occurrence) throw new CoreJournalRefusal('Original image invocation is unavailable.');
  if (!isDeepStrictEqual(occurrence, ref))
    throw new CoreJournalRefusal('Original image invocation conflicts.', 'image_result_conflict');
  const original = readExecutionJournalInvocation(db, ref);
  const candidate = [
    `artifact/v1:${settlement.authoredArtifactId}:${settlement.authoredArtifactVersion}:${settlement.authoredContentDigest}`,
    `image-input/v1:${settlement.inputDigest}`,
  ];
  if (
    !isDeepStrictEqual(
      original.control.authorityRefs.filter((value) =>
        value.startsWith(imageTargetAuthorityPrefix)
      ),
      [imageTargetAuthority(target)]
    ) ||
    !isDeepStrictEqual(original.control.inputRefs, candidate) ||
    !isDeepStrictEqual(original.control.target, {
      backendKind: 'nanohost',
      targetId: target.targetId,
      allocationRef: null,
    })
  )
    throw new CoreJournalRefusal(
      'Image result conflicts with its admitted candidate or target.',
      'image_result_conflict'
    );

  const digest = commandInputHash(settlement);
  const success = settlement.outcome.kind === 'success';
  const state = success ? 'completed' : 'failed';
  const late = original.state === 'unknown' && original.control.outputRefs.length === 0;
  const consumeId = `${ref.stepId}:consume`;
  if (late) {
    const receipts = readExecutionJournalLinkedInspections(db, ref)
      .map(({ inspection }) => inspection)
      .filter((inspection) => inspection.control.kind === 'consume-receipt');
    if (receipts.length > 0) {
      const receipt = receipts[0]!;
      if (
        receipts.length !== 1 ||
        receipt.ref.execution.executionId !== ref.execution.executionId ||
        receipt.ref.stepId !== consumeId ||
        receipt.state !== state ||
        receipt.control.fingerprint !== digest ||
        !isDeepStrictEqual(receipt.control.outputRefs, [digest])
      )
        throw new CoreJournalRefusal('Image result replay conflicts.', 'image_result_conflict');
      return digest;
    }
  } else if (original.state !== 'intent') {
    if (original.state !== state || !isDeepStrictEqual(original.control.outputRefs, [digest]))
      throw new CoreJournalRefusal('Image result replay conflicts.', 'image_result_conflict');
    return digest;
  }

  let root = readExecutionJournalRoot(db, ref.execution);
  const row = db.sqlite
    .prepare('SELECT span_json FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
    .get(ref.execution.executionId, ref.stepId) as { span_json: string };
  let span = decodeExecutionJournalSpan(JSON.parse(row.span_json));
  const now = BigInt(Date.now()) * 1_000_000n;
  const earliestEnd = span.endTimeUnixNano ?? span.startTimeUnixNano;
  // biome-ignore lint/complexity/useMathMinMax: nanosecond clocks use bigint.
  const endedAt = now < earliestEnd ? earliestEnd : now;
  let decidingRef: ExecutionStepRef = ref;
  if (late) {
    // A result after abandonment acknowledges the receiver receipt and leaves the original hold.
    const consumeSpan = {
      ...span,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: root.span.spanId,
      name: 'image.acquire result reconciliation',
      startTimeUnixNano: endedAt,
      endTimeUnixNano: null,
      status: { code: 'UNSET' },
      attributes: [],
      events: [],
      links: [
        {
          traceId: span.traceId,
          spanId: span.spanId,
          flags: span.flags,
          attributes: [],
          droppedAttributesCount: 0,
        },
      ],
    } as const;
    decidingRef = writeExecutionJournalIntent(db, {
      execution: { ...root, span: { ...root.span, endTimeUnixNano: null } },
      stepId: consumeId,
      parentStepId: null,
      parent: null,
      inspectedStep: ref,
      carriage: original.carriage,
      control: {
        ...original.control,
        kind: 'consume-receipt',
        target: null,
        invocationId: `${original.control.invocationId}:consume`,
        outputRefs: [],
        fingerprint: digest,
        retryPermitted: false,
        deadlineUnixNano: null,
      },
      span: consumeSpan,
    }).ref;
    span = consumeSpan;
    root = readExecutionJournalRoot(db, ref.execution);
  }
  const closes = success && !late;
  settleExecutionJournalStep(db, {
    ref: decidingRef,
    expectedExecutionRevision: root.revision,
    state,
    outputRefs: [digest],
    span: { ...span, endTimeUnixNano: endedAt, status: { code: success ? 'OK' : 'ERROR' } },
    nextPhase: closes ? 'closed' : 'closing',
    terminalCause: root.terminalCause ?? (success ? null : 'Image acquisition failed.'),
    exclusionRefs: closes ? [] : root.exclusionRefs,
  });
  return digest;
}

/** Qualifies one Native anchor against the original Core preparation under pinned owner reads. */
export function requireCoreNanoHostMaterializationPreparation(
  db: CoreDb,
  input: ControlNanoHostMaterializationPreparationInput,
  readers: {
    readonly nanoHost: Pick<NanoHostCoreReads, 'readTarget'>;
    readonly readSelectedInput: (admission: CoreSchedulerQueueEntry) => boolean;
  }
) {
  if (!db.sqlite.inTransaction)
    throw new ExecutionAttemptRefusal('Native materialization requires its Core snapshot.');
  const attempt = requireSchedulerExecutionAttempt(db, input.attemptId);
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, attempt.attemptId);
  if (
    attempt.backendId !== 'nanohost' ||
    attempt.phase !== 'open' ||
    attempt.deadline !== null ||
    attempt.terminalCause !== null ||
    attempt.outcomeRef !== null ||
    attempt.fenceRef !== null ||
    admission.status !== 'admitted' ||
    attempt.queueEntryId !== input.queueEntryId ||
    admission.inputHash !== input.admissionHash ||
    !isDeepStrictEqual(admission.inputRef, input.selectedInput) ||
    attempt.workspaceId !== input.workspaceId ||
    attempt.threadId !== input.threadId ||
    attempt.turnId !== input.turnId ||
    attempt.agentSessionId !== input.agentSessionId ||
    attempt.inputRef !== input.inputRef ||
    attempt.bindingRef !== input.bindingRef
  )
    throw new ExecutionAttemptRefusal('Native materialization has no exact original Core claim.');

  const startupDeadline = nanoHostStartupDeadline(attempt);
  const observed = Date.parse(input.observedAt ?? new Date().toISOString());
  if (!(observed >= Date.parse(attempt.updatedAt) && observed < Date.parse(startupDeadline)))
    throw new ExecutionAttemptRefusal('Native materialization has no original startup allowance.');
  const operationId = attempt.operationId;
  const grant = db.sqlite
    .prepare('SELECT 1 FROM control_executions WHERE id = ?')
    .get(attempt.attemptId);
  if (
    grant ||
    attempt.disposition !== (operationId === null ? 'not_accepted' : 'accepted') ||
    !schedulerPreparationClockAllowsOperation(
      db,
      attempt.attemptId,
      {
        operationId,
        turnId: attempt.turnId,
        admissionHash: admission.inputHash,
        actor: admission.triggerActor,
        started: BigInt(Date.parse(attempt.createdAt)) * 1_000_000n,
        startupDeadline: BigInt(Date.parse(startupDeadline)) * 1_000_000n,
      },
      BigInt(observed) * 1_000_000n
    )
  )
    throw new ExecutionAttemptRefusal(
      'Native materialization has no acknowledged preparation operation.'
    );

  if (!readers.readSelectedInput(admission))
    throw new ExecutionAttemptRefusal(
      'Native materialization has no exact selected Workspace input.'
    );
  const result = readers.nanoHost.readTarget(input.target.targetId);
  const target = result.state === 'ready' ? result.value : null;
  if (
    !target?.predecessorFenced ||
    !target.ready ||
    !target.freshEmpty ||
    target.targetId !== input.target.targetId ||
    target.identityId !== input.target.identityId ||
    target.deploymentId !== input.target.deploymentId ||
    target.connectionGeneration !== input.target.connectionGeneration ||
    target.physicalEpoch !== input.target.physicalEpoch
  )
    throw new ExecutionAttemptRefusal('Native materialization has no exact Native placement.');
  return { attempt, preparationOperation: operationId, startupDeadline, target: input.target };
}

/** Decides the ordinary NanoHost submit under the pinned Core, Native and Workspace owners. */
export function admitNanoHostFirstSubmissionInDb(
  coreDb: CoreDb,
  input: ControlNanoHostFirstSubmissionInput,
  readers: {
    readonly nanoHost: Parameters<typeof readNanoHostSubmissionPlacement>[0] | null;
    readonly workspace: WorkspaceDb | null;
  }
): ControlNanoHostFirstSubmissionResult {
  if (!coreDb.sqlite.inTransaction || coreDb.sqlite.readonly)
    throw new ExecutionAttemptRefusal('Execution grant requires the Core writer transaction.');
  return coreDb.sqlite.transaction(() => {
    const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
    const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, input.attemptId);
    const { attemptId, agentSessionId, inputRef, bindingRef, workspaceId, threadId, turnId } =
      attempt;
    if (attempt.backendId !== 'nanohost' || !agentSessionId || !inputRef || !bindingRef)
      throw new ExecutionAttemptRefusal('Submission has no finalized package or assigned binding.');
    const operationId = commandInputHash({ attemptId, inputRef, operation: 'submit' });
    const execution = { owner: { kind: 'server' as const }, executionId: attemptId };
    const original = readKernelSchedulerGrantInDb(coreDb, execution, operationId);
    if (
      original &&
      (original.deadline === null ||
        attempt.operationId !== operationId ||
        attempt.deadline !== original.deadline)
    )
      throw new ExecutionAttemptRefusal('Execution grant conflicts with its original operation.');

    const observedAt = input.observedAt ?? new Date().toISOString();
    const observed = Date.parse(observedAt);
    if (
      !original &&
      (admission.status !== 'admitted' ||
        !(
          observed >= Date.parse(attempt.updatedAt) &&
          observed < Date.parse(nanoHostStartupDeadline(attempt))
        ))
    )
      throw new ExecutionAttemptRefusal('Original execution clock or admission is unavailable.');
    // The original deadline recovers the first decision clock even when a replay arrives much later.
    const submittedAt =
      original && original.deadline
        ? Date.parse(original.deadline) - EXECUTION_ATTEMPT_BUDGET_MS
        : observed;
    const traceId = sha256Hex(attemptId).slice(0, 32);
    const rootSpan: ExecutionJournalIntent['span'] = {
      traceId,
      spanId: sha256Hex(`${attemptId}:submission`).slice(0, 16),
      flags: 0,
      name: 'NanoHost Worker submission',
      kind: 'INTERNAL',
      startTimeUnixNano: BigInt(Date.parse(attempt.createdAt)) * 1_000_000n,
      endTimeUnixNano: null,
      status: { code: 'UNSET' },
      attributes: [],
      droppedAttributesCount: 0,
      events: [],
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      instrumentationScope: {
        name: 'openkit.nanocore.runtime',
        attributes: [],
        droppedAttributesCount: 0,
      },
      resource: { attributes: [], droppedAttributesCount: 0 },
    };
    const storage = admission.workerStorageChoice;
    const placement = { ...input.placement, workspaceId, threadId, agentSessionId };
    const proposal: ExecutionJournalIntent = {
      execution: {
        ref: execution,
        definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
        workId: turnId,
        fingerprint: admission.inputHash,
        exclusionRefs: [
          `workspace:${workspaceId}`,
          `thread:${threadId}`,
          `turn:${turnId}`,
          `session:${agentSessionId}`,
          ...(storage?.kind === 'selected' ? [storage.storageRef] : []),
        ],
        span: rootSpan,
      },
      stepId: 'submit',
      parentStepId: null,
      parent: null,
      inspectedStep: null,
      carriage: { operation: 'submit', requestId: operationId, sequence: null, bindingRef },
      control: {
        definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
        kind: 'admit',
        target: {
          backendKind: 'nanohost',
          targetId: placement.runtimeTargetId,
          allocationRef: bindingRef,
        },
        workId: turnId,
        operationId,
        invocationId: operationId,
        attemptId,
        actor: admission.triggerActor,
        inputRefs: [inputRef],
        outputRefs: [],
        fingerprint: admission.inputHash,
        permittingDecisionRef: null,
        authorityRefs: [admission.queueEntryId, commandInputHash(placement)],
        retryDeclarationRef: null,
        retryPermitted: false,
        deadlineUnixNano: null,
        physicalFenceRefs: [],
      },
      span: {
        ...rootSpan,
        spanId: sha256Hex(operationId).slice(0, 16),
        parentSpanId: rootSpan.spanId,
        startTimeUnixNano: BigInt(submittedAt) * 1_000_000n,
      },
    };
    const { state } = recordSchedulerExecutionGrantInDb(
      coreDb,
      {
        attemptId,
        operationId,
        generation: String(placement.connectionGeneration),
        proposal,
        submission: true,
        now: () => observedAt,
      },
      (grant) => {
        const { nanoHost, workspace } = readers;
        if (
          !nanoHost ||
          workspace?.workspaceId !== workspaceId ||
          workspace.dataRoot !== coreDb.dataRoot
        )
          return false;
        try {
          const session = readNanoHostSubmissionPlacement(nanoHost, grant, placement);
          if (
            !session ||
            (!original &&
              isSandboxReleaseRefusalFenced(
                coreDb,
                sandboxReleaseRefusalExecutionId(
                  session.runtimeTargetId,
                  session.originPhysicalEpoch,
                  session.sandboxBindingRef
                )
              ))
          )
            return false;
          const pkg = findNamedAgentEnvironmentPackageSnapshot(
            workspace,
            workspaceId,
            agentSessionId,
            inputRef
          )?.snapshot;
          if (pkg?.scope.turnId !== turnId || pkg.scope.threadId !== threadId) return false;
          requireCompleteBackendWorkspaceHandleHandoff(workspace, pkg, {
            backendKind: session.backendKind,
            backendVersion: session.backendVersion,
            workerSessionId: session.backendSessionId,
          });
          return true;
        } catch {
          return false;
        }
      }
    );
    return ControlNanoHostFirstSubmissionResultSchema.parse({
      state,
      attempt: requireSchedulerExecutionAttempt(coreDb, attemptId),
    });
  })();
}

type FailedStartCoordinates = Pick<
  SchedulerExecutionAttemptRecord,
  'attemptId' | 'queueEntryId' | 'agentSessionId' | 'inputRef' | 'bindingRef'
>;

/** Closes the exact never-submitted attempt only after its pinned peer evidence agrees. */
export function closeNanoHostFailedStartInDb(
  db: CoreDb,
  input: FailedStartCoordinates & { readonly observedAt?: string },
  verifyNoEffects: (original: SchedulerExecutionAttemptRecord) => boolean
): SchedulerExecutionAttemptRecord {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new ExecutionAttemptRefusal('Failed-start closure requires the Core writer transaction.');
  return db.sqlite.transaction(() => {
    const attempt = requireSchedulerExecutionAttempt(db, input.attemptId);
    const admission = requireSchedulerExecutionAttemptAdmissionContext(db, attempt.attemptId);
    if (
      attempt.backendId !== 'nanohost' ||
      admission.status !== 'admitted' ||
      attempt.queueEntryId !== input.queueEntryId ||
      attempt.agentSessionId !== input.agentSessionId ||
      attempt.inputRef !== input.inputRef ||
      attempt.bindingRef !== input.bindingRef ||
      attempt.disposition !== 'not_accepted' ||
      attempt.operationId !== null ||
      attempt.deadline !== null ||
      attempt.outcomeRef !== null ||
      attempt.fenceRef !== null ||
      (attempt.terminalCause !== null && attempt.terminalCause !== 'turn-start-failed') ||
      (attempt.phase === 'closed' && attempt.terminalCause !== 'turn-start-failed')
    )
      throw new ExecutionAttemptRefusal(
        'Failed-start closure conflicts with the original attempt.'
      );
    const successor = db.sqlite
      .prepare(`SELECT 1 FROM scheduler_execution_attempts AS other
        JOIN scheduler_execution_attempts AS original ON original.attempt_id = ?
        WHERE other.attempt_id <> original.attempt_id AND (
          (other.turn_id = original.turn_id AND other.rowid > original.rowid) OR
          (other.agent_session_id = original.agent_session_id AND other.phase <> 'closed')
        ) LIMIT 1`)
      .get(attempt.attemptId);
    const grantRoot = db.sqlite
      .prepare('SELECT 1 FROM control_executions WHERE id = ?')
      .get(attempt.attemptId);
    if (successor || grantRoot)
      throw new ExecutionAttemptRefusal('Failed-start closure has competing execution authority.');

    // Unused-anchor inspection reads the closed phase. Refusal rolls back this uncommitted CAS.
    const closed = closeSchedulerExecutionAttemptWithoutEffects(db, {
      attemptId: attempt.attemptId,
      noOutstandingEffects: true,
      cause: 'turn-start-failed',
      ...(input.observedAt === undefined ? {} : { now: () => input.observedAt! }),
    });
    if (!verifyNoEffects(closed))
      throw new ExecutionAttemptRefusal('Failed-start closure has no positive peer proof.');
    return closed;
  })();
}

const orphanRetirementAction = 'scheduler.orphan-backend-retired';

type OrphanCleanup = Omit<ControlNanoHostOrphanRetirementInput, 'observedAt'>;

function originalOrphanAudit(db: CoreDb, cleanup: OrphanCleanup) {
  const attempt = requireSchedulerExecutionAttempt(db, cleanup.attemptId);
  if (
    attempt.backendId !== 'nanohost' ||
    attempt.phase !== 'closed' ||
    !attempt.agentSessionId ||
    attempt.inputRef !== cleanup.inputRef ||
    attempt.bindingRef !== cleanup.bindingRef
  )
    throw new ExecutionAttemptRefusal('Orphan Audit has no exact closed attempt.');
  const { workspaceId, threadId, turnId, agentSessionId } = attempt;
  const auditEventId = deriveEntityId('aud', [orphanRetirementAction, attempt.attemptId]);
  const requestId = storageRequestId({
    deploymentId: cleanup.target.deploymentId,
    sourceOwner: 'nanohost',
    verb: orphanRetirementAction,
    occurrenceKey: commandInputHash({
      cleanup,
      workspaceId,
      threadId,
      turnId,
      agentSessionId,
      operationId: attempt.operationId,
    }),
  });
  const fields = {
    auditEventId,
    requestId,
    action: orphanRetirementAction,
    category: 'system',
    outcome: 'succeeded',
    resource: `server:worker-backend-session:${attempt.attemptId}`,
    severity: 'warning',
    summary: 'Unowned worker backend session physically cleaned and retired.',
    workspaceId,
    threadId,
    turnId,
    agentSessionId,
  } as const;
  return { attempt, fields };
}

function inspectOrphanAudit(db: CoreDb, fields: ReturnType<typeof originalOrphanAudit>['fields']) {
  const row = db.sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
    .get(fields.auditEventId);
  if (!row) return null;
  const prior = auditEventFromRow(row);
  if (!prior.createdAt)
    throw new ExecutionAttemptRefusal('Orphan Audit has no original acknowledgement clock.');
  const expected = prepareServerAuditEvent({
    ...fields,
    coreDb: db,
    now: new Date(prior.createdAt),
  });
  if (canonicalJsonText(prior) !== canonicalJsonText(expected))
    throw new ExecutionAttemptRefusal('Orphan Audit conflicts with the original cleanup.');
  return {
    auditEventId: fields.auditEventId,
    requestId: fields.requestId,
    acceptedAt: prior.createdAt,
  };
}

/** Reads the original acknowledgement on a pinned Core reader for the dependent Native CAS. */
export function inspectCoreNanoHostOrphanAudit(db: CoreDb, cleanup: OrphanCleanup) {
  return inspectOrphanAudit(db, originalOrphanAudit(db, cleanup).fields);
}

/** Retains the original redacted Audit before the Native owner may retire the physical anchor. */
export function commitCoreNanoHostOrphanAuditInDb(
  db: CoreDb,
  input: ControlNanoHostOrphanRetirementInput,
  verifyCleanup: (original: SchedulerExecutionAttemptRecord, cleanup: OrphanCleanup) => boolean
): {
  readonly state: 'applied' | 'inspect-original';
  readonly receipt: NonNullable<ReturnType<typeof inspectCoreNanoHostOrphanAudit>>;
} {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new ExecutionAttemptRefusal('Orphan Audit requires the Core writer transaction.');
  const { observedAt, ...cleanup } = input;
  const { attempt, fields } = originalOrphanAudit(db, cleanup);
  const prior = inspectOrphanAudit(db, fields);
  if (prior) return { state: 'inspect-original', receipt: prior };
  const now = observedAt === undefined ? new Date() : new Date(observedAt);
  if (!(now.getTime() >= Date.parse(cleanup.physicalCleanedAt)) || !verifyCleanup(attempt, cleanup))
    throw new ExecutionAttemptRefusal('Orphan Audit has no exact physical and Workspace proof.');
  recordServerAuditEvent({ ...fields, coreDb: db, now });
  return {
    state: 'applied',
    receipt: {
      auditEventId: fields.auditEventId,
      requestId: fields.requestId,
      acceptedAt: now.toISOString(),
    },
  };
}

type FinalCommand = ControlWorkerFinalStatusCommand;
type FinalNativeReader = Parameters<typeof inspectNanoHostWorkerBinding>[0];
/** Reads both immutable facts left by the Core failure close on one snapshot. */
export function readCoreWorkerFailureClose(db: CoreDb, attemptId: string) {
  return db.sqlite
    .transaction(() => {
      const attempt = requireSchedulerExecutionAttempt(db, attemptId);
      if (
        attempt.phase === 'open' ||
        (attempt.phase === 'closing' && isWorkerCancellationFinalCause(attempt.terminalCause)) ||
        hasCoreWorkerFinalIntake(db, attemptId)
      )
        return null;
      return attempt;
    })
    .deferred();
}

const finalIntakeStepId = 'worker-final-intake';

/** A retained final intake keeps generic failure writers off this exact attempt. It supplies no outcome. */
export function hasCoreWorkerFinalIntake(db: CoreDb, attemptId: string): boolean {
  return Boolean(
    db.sqlite
      .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
      .get(attemptId, finalIntakeStepId)
  );
}

function workerFinalBindingRefusal(
  reason: 'binding-not-found' | 'lineage-mismatch' | 'reconnect-required' | 'attempt-not-live'
): never {
  if (reason === 'binding-not-found')
    throw new WorkerFinalStatusRefusal(
      'worker_control_unauthorized',
      'Worker control request is missing a valid sandbox token.',
      401
    );
  if (reason === 'lineage-mismatch')
    throw new WorkerFinalStatusRefusal(
      'worker_control_lineage_mismatch',
      'Worker control request lineage does not match the durable lease binding.',
      403
    );
  if (reason === 'reconnect-required')
    throw new WorkerFinalStatusRefusal(
      'worker_control_reconnect_required',
      'Worker control session must reconnect after NanoCore restart.',
      503
    );
  throw new WorkerFinalStatusRefusal(
    'worker_control_lease_not_live',
    'Worker control request lease is not live.',
    403
  );
}

function workerFinalConflict(): never {
  throw new WorkerFinalStatusRefusal(
    'worker_control_sequence_conflict',
    'Worker final conflicts with its retained original.',
    409
  );
}

function readOriginalWorkerFinalBinding(
  db: CoreDb,
  sqlite: FinalNativeReader,
  input: FinalCommand
) {
  if (!sqlite.readonly)
    throw new CoreJournalRefusal('Worker final requires the admitted NanoHost reader.');
  const owner = { sqlite };
  const session = getWorkerBackendSessionByPackage(owner, input.lineage.packageSnapshotId);
  const original = session && readRetainedNanoHostSubmission(db, session.attemptId);
  if (!original) workerFinalBindingRefusal('binding-not-found');
  const native = inspectNanoHostWorkerBinding(sqlite, original, {
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    tokenHash: input.tokenHash,
    tokenFamily: 'worker-control',
  });
  if (native.status === 'rejected') workerFinalBindingRefusal(native.reason);
  return { native, grant: original.lease.grant };
}

/** Reads both independently accepted Native records and their exact stored sequence receipts. */
function hasExactNativeWorkerFinal(
  sqlite: FinalNativeReader,
  input: FinalCommand,
  decision: NanoHostWorkerFinalDecision
): boolean {
  const {
    lineage,
    payload: { sequence, terminalData },
  } = input;
  const event = buildWorkerCanonicalTerminalEventRecord({ data: terminalData, lineage, sequence });
  const rows = sqlite
    .prepare(`SELECT operation, schema_version AS schemaVersion,
    record_json AS recordJson, accepted_at AS acceptedAt
    FROM worker_control_records
    WHERE workspace_id=? AND thread_id=? AND turn_id=? AND agent_session_id=?
      AND package_snapshot_id=? AND request_id IS ? AND record_key=? AND sequence=?
      AND operation IN ('final_status', 'event_append') LIMIT 3`)
    .all(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null,
      String(sequence),
      sequence
    ) as {
    operation: string;
    schemaVersion: unknown;
    recordJson: string;
    acceptedAt: string;
  }[];
  const final = rows.find((row) => row.operation === 'final_status');
  const terminal = rows.find((row) => row.operation === 'event_append');
  return (
    rows.length === 2 &&
    final?.acceptedAt === decision.acceptedAt &&
    terminal?.acceptedAt === decision.eventAcceptedAt &&
    readRetainedV1(final, () =>
      isDeepStrictEqual(JSON.parse(final.recordJson), {
        ...terminalData,
        acceptedAt: decision.acceptedAt,
        sequence,
      })
    ) &&
    readRetainedV1(terminal, () => isDeepStrictEqual(JSON.parse(terminal.recordJson), event)) &&
    matchesAcceptedWorkerControlSequence(
      { sqlite },
      {
        lineage,
        operation: 'final_status',
        sequence,
        fingerprint: canonicalJsonText({ ...terminalData, lineage, sequence }),
      }
    ) === true &&
    matchesAcceptedWorkerControlSequence(
      { sqlite },
      {
        lineage,
        operation: 'event_append',
        sequence,
        fingerprint: canonicalJsonText(event),
      }
    ) === true
  );
}

function readCoreWorkerFinalIntake(
  db: CoreDb,
  grant: NanoHostWorkerFinalDecision['grant'],
  input: FinalCommand
): NanoHostWorkerFinalDecision | null {
  const ref = { execution: grant.execution, stepId: finalIntakeStepId };
  if (!hasCoreWorkerFinalIntake(db, grant.execution.executionId)) return null;
  const step = readExecutionJournalInvocation(db, ref);
  const [kind, acceptedAt, eventAcceptedAt] = step.control.outputRefs;
  if (
    step.state !== 'completed' ||
    step.control.kind !== 'observe' ||
    step.control.attemptId !== grant.attemptId ||
    step.control.operationId !== grant.operationId ||
    step.control.fingerprint !== nanoHostWorkerFinalDecisionFingerprint(input) ||
    !isDeepStrictEqual(step.control.authorityRefs, [commandInputHash(grant)]) ||
    !isDeepStrictEqual(step.carriage, {
      operation: finalIntakeStepId,
      requestId: grant.operationId,
      sequence: input.payload.sequence,
      bindingRef: grant.bindingRef,
    }) ||
    step.control.outputRefs.length !== 3
  )
    workerFinalConflict();
  const original = CoreNanoHostFinalIntakeSchema.parse({
    kind,
    acceptedAt,
    eventAcceptedAt,
    fingerprint: step.control.fingerprint,
  });
  return { ...original, grant };
}

function coreWorkerFinalProposal(
  db: CoreDb,
  decision: NanoHostWorkerFinalDecision,
  stepId: string,
  sequence: number
): ExecutionJournalIntent {
  const { grant, fingerprint, acceptedAt } = decision;
  const root = readExecutionJournalRoot(db, grant.execution);
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, grant.attemptId);
  const invocationId = `${grant.attemptId}:${stepId}`;
  const clock = BigInt(Date.parse(acceptedAt)) * 1_000_000n;
  return {
    execution: { ...root, span: { ...root.span, endTimeUnixNano: null } },
    stepId,
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: {
      operation: stepId,
      requestId: grant.operationId,
      sequence,
      bindingRef: grant.bindingRef,
    },
    control: {
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
      kind: 'observe',
      target: null,
      workId: grant.turnId,
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      invocationId,
      actor: admission.triggerActor,
      inputRefs: [],
      outputRefs: [],
      fingerprint,
      permittingDecisionRef: grant.operationId,
      authorityRefs: [commandInputHash(grant)],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    span: {
      ...root.span,
      name: stepId,
      spanId: sha256Hex(invocationId).slice(0, 16),
      parentSpanId: root.span.spanId,
      // biome-ignore lint/complexity/useMathMinMax: nanosecond clocks use bigint.
      startTimeUnixNano: clock >= root.span.startTimeUnixNano ? clock : root.span.startTimeUnixNano,
      endTimeUnixNano: null,
      status: { code: 'UNSET' },
      events: [],
      links: [],
    },
  };
}

/** Retains the first authenticated final intake and its clocks without accepting a Native result. */
export function admitNanoHostWorkerFinalInDb(
  db: CoreDb,
  input: FinalCommand,
  sqlite: FinalNativeReader
): NanoHostWorkerFinalDecision {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new ExecutionAttemptRefusal('Worker final requires the Core writer transaction.');
  return db.sqlite.transaction((): NanoHostWorkerFinalDecision => {
    const { native, grant } = readOriginalWorkerFinalBinding(db, sqlite, input);
    const { acceptedAt: now, eventAcceptedAt, terminalData, sequence } = input.payload;
    const observedAt = new Date(now).toISOString();
    if (grant.deadline <= observedAt) workerFinalBindingRefusal('attempt-not-live');
    const prior = readCoreWorkerFinalIntake(db, grant, input);
    if (getWorkerControlAcceptedFinalStatus({ sqlite }, input.lineage)) {
      if (!prior || !hasExactNativeWorkerFinal(sqlite, input, prior)) workerFinalConflict();
      return { ...prior, kind: 'replay' };
    }
    const live = nanoHostWorkerBindingLiveness(native, observedAt);
    const cancellation = nanoHostWorkerCancellationFinalEligible(sqlite, native, observedAt);
    if (prior) {
      const pendingOrdinary =
        prior.kind === 'decided' &&
        native.currentPlacement &&
        native.attempt.phase === 'closing' &&
        native.attempt.terminalCause === 'worker-final-status' &&
        native.attempt.fenceRef === null &&
        native.proof.recoveryState === null &&
        native.proof.heartbeatDeadline > observedAt;
      if (
        Date.parse(now) < Date.parse(prior.acceptedAt) ||
        !(pendingOrdinary || (prior.kind === 'cancellation-decided' && cancellation))
      )
        workerFinalBindingRefusal(live.status === 'rejected' ? live.reason : 'attempt-not-live');
      return prior;
    }
    if (live.status === 'rejected' && !cancellation) workerFinalBindingRefusal(live.reason);
    if (
      cancellation &&
      !(
        (terminalData.status === 'cancelled' || terminalData.status === 'interrupted') &&
        terminalData.stopReason === 'aborted'
      )
    )
      throw new WorkerFinalStatusRefusal(
        'worker_control_lease_not_live',
        'A closing cancelled Turn accepts only a cancellation or interruption final with aborted StopReason.',
        403
      );
    let sequences: ReturnType<typeof inspectNanoHostWorkerFinalSequences>;
    try {
      sequences = inspectNanoHostWorkerFinalSequences(
        { sqlite },
        input.lineage,
        native.attempt.terminalCause === 'observation_limit_reached'
          ? { ...input.payload, requireContinuous: true }
          : input.payload
      );
    } catch {
      throw new ControlProductPreconditionError();
    }
    if (sequences.status !== 'accepted')
      throw new WorkerFinalStatusRefusal(sequences.code, sequences.message, 409);
    // A retained final fingerprint requires the accepted final record checked above.
    if (sequences.finalStatusDuplicate) throw new ControlProductPreconditionError();

    const decision: NanoHostWorkerFinalDecision = {
      kind: cancellation ? 'cancellation-decided' : 'decided',
      grant,
      fingerprint: nanoHostWorkerFinalDecisionFingerprint(input),
      acceptedAt: now,
      eventAcceptedAt,
    };
    const proposal = coreWorkerFinalProposal(db, decision, finalIntakeStepId, sequence);
    const entry = writeExecutionJournalIntent(db, proposal);
    const attempt = markSchedulerExecutionAttemptClosing(db, {
      attemptId: grant.attemptId,
      cause: 'worker-final-status',
      now: () => now,
    });
    const root = readExecutionJournalRoot(db, grant.execution);
    settleExecutionJournalStep(db, {
      ref: entry.ref,
      expectedExecutionRevision: root.revision,
      state: 'completed',
      outputRefs: [decision.kind, decision.acceptedAt, decision.eventAcceptedAt],
      span: {
        ...proposal.span,
        endTimeUnixNano: proposal.span.startTimeUnixNano,
        status: { code: 'OK' },
      },
      nextPhase: 'closing',
      terminalCause: attempt.terminalCause,
      exclusionRefs: root.exclusionRefs,
    });
    return decision;
  })();
}

/** The receipt occurrence depends only on the session deployment and the original submit operation. */
function acceptedNanoHostFinalReceiptOccurrence(deploymentId: string, operationId: string) {
  return {
    deploymentId,
    sourceOwner: 'nanohost',
    verb: 'apply-execution-proof',
    occurrenceKey: `worker-final-accepted:${operationId}`,
  } as const;
}

/** The deterministic `worker-final-accepted` receipt identity for one original Core intake. */
function acceptedNanoHostFinalReceiptIntent(
  deploymentId: string,
  intake: NanoHostWorkerFinalDecision,
  sequence: number
) {
  const { grant } = intake;
  const proof = {
    kind: 'submission',
    disposition: 'accepted',
    evidence: {
      backendId: 'nanohost',
      ref: `native-final/v1:${grant.attemptId}:${sequence}`,
      digest: commandInputHash({
        fingerprint: intake.fingerprint,
        acceptedAt: intake.acceptedAt,
        eventAcceptedAt: intake.eventAcceptedAt,
      }),
    },
  } as const;
  const occurrence = acceptedNanoHostFinalReceiptOccurrence(deploymentId, grant.operationId);
  const intent: ExecutionProofIntent = {
    ...occurrence,
    requestId: storageRequestId(occurrence),
    target: grant,
    expectedGeneration: grant.generation,
    inputDigest: sha256CanonicalJson(proof),
  };
  return { proof, intent };
}

/** Observes the exact accepted Native final after FULL independently of intake, handoff and release. */
export function observeAcceptedNanoHostFinalInDb(
  db: CoreDb,
  input: FinalCommand,
  sqlite: FinalNativeReader
): ControlCoreNanoHostAcceptedFinalResult {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new ExecutionAttemptRefusal('Worker final requires the Core writer transaction.');
  return db.sqlite.transaction((): ControlCoreNanoHostAcceptedFinalResult => {
    const { native, grant } = readOriginalWorkerFinalBinding(db, sqlite, input);
    const intake = readCoreWorkerFinalIntake(db, grant, input);
    if (!intake) return { state: 'unknown' };
    const verifyNative = () => hasExactNativeWorkerFinal(sqlite, input, intake);
    const { proof, intent } = acceptedNanoHostFinalReceiptIntent(
      native.session.deploymentId,
      intake,
      input.payload.sequence
    );
    const original = inspectKernelProofReceipt(db, intent, true);
    if (original.state === 'settled')
      return verifyNative()
        ? ControlCoreNanoHostAcceptedFinalResultSchema.parse({
            state: 'inspect-original',
            receipt: original.receipt,
          })
        : { state: 'unknown' };
    if (original.state !== 'absent') return { state: original.state };
    const result = commitKernelExecutionEvidenceInDb(
      db,
      coreWorkerFinalProposal(db, intake, 'worker-final-accepted', input.payload.sequence),
      { version: 1, kind: 'submission', intent, proof },
      true,
      verifyNative,
      // The cancellation receipt observes the final envelope while the closing attempt
      // retains its original submission disposition and recovery clock.
      () =>
        intake.kind === 'cancellation-decided' ||
        acceptSchedulerExecutionObservation(db, {
          ...grant,
          disposition: 'accepted',
          execution: 'terminal',
          outcomeRef: null,
          fenceRef: null,
        }) !== null
    );
    return result.state === 'settled'
      ? ControlCoreNanoHostAcceptedFinalResultSchema.parse({
          state: 'applied',
          receipt: result.receipt,
        })
      : { state: result.state };
  })();
}

/** Why K8b recovery holds an accepted Native final instead of handing it to closeout. */
export type NanoHostAcceptedFinalHold = 'missing' | 'duplicate' | 'conflict' | 'unknown';

/** The original proof that one accepted Native final carries across restart. */
interface NanoHostAcceptedFinalProof {
  readonly grant: NanoHostWorkerFinalDecision['grant'];
  /** Lineage as carried by the accepted canonical terminal event. */
  readonly lineage: ControlWorkerFinalStatusCommand['lineage'];
  readonly sandboxBindingRef: string;
  readonly sequence: number;
  /** Original Core intake fingerprint, which binds the historical route hash and terminal data. */
  readonly fingerprint: string;
  /** Fingerprints held by the two Native sequence receipts. */
  readonly finalFingerprint: string;
  readonly eventFingerprint: string;
  readonly acceptedAt: string;
  readonly eventAcceptedAt: string;
  /** Original physical session placement. The guarded re-read compares it in its own snapshot. */
  readonly session: {
    readonly runtimeTargetId: string;
    readonly deploymentId: string;
    readonly originPhysicalEpoch: string;
    readonly backendSessionId: string;
  };
}

/** Lineage columns of one Native record or sequence receipt. */
interface NativeLineageColumns {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string | null;
}

function hasNativeLineageColumns(
  row: NativeLineageColumns,
  lineage: ControlWorkerFinalStatusCommand['lineage']
): boolean {
  return (
    row.workspaceId === lineage.workspaceId &&
    row.threadId === lineage.threadId &&
    row.turnId === lineage.turnId &&
    row.requestId === (lineage.requestId ?? null)
  );
}

/** Opening sets revision 1, and each step insert and each settlement add one. A gap is unknown history. */
function hasCompleteExecutionHistory(
  db: CoreDb,
  execution: NanoHostWorkerFinalDecision['grant']['execution']
): boolean {
  const { revision } = readExecutionJournalRoot(db, execution);
  const { steps, ended } = db.sqlite
    .prepare(`SELECT COUNT(*) AS steps, COALESCE(SUM(state <> 'intent'), 0) AS ended
    FROM control_execution_steps WHERE execution_id=?`)
    .get(execution.executionId) as { steps: number; ended: number };
  return revision === 1 + steps + ended;
}

/**
 * The Core submission retains its runtime target and the digest of its exact placement (`authorityRefs[1]`).
 * The digest uses the original grant generation and origin Epoch, so a successor Epoch keeps the readback.
 */
function hasOriginalSubmissionPlacement(
  db: CoreDb,
  sqlite: FinalNativeReader,
  grant: NanoHostWorkerFinalDecision['grant'],
  lineage: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly agentSessionId: string;
  },
  session: NanoHostAcceptedFinalProof['session']
): boolean {
  const step = db.sqlite
    .prepare(
      'SELECT step_id AS stepId FROM control_execution_steps WHERE execution_id=? AND invocation_id=?'
    )
    .get(grant.execution.executionId, grant.operationId) as { stepId: string } | undefined;
  if (!step) return false;
  const submit = readExecutionJournalInvocation(db, {
    execution: grant.execution,
    stepId: step.stepId,
  });
  const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
  if (
    !target ||
    submit.control.target?.targetId !== session.runtimeTargetId ||
    target.deploymentId !== session.deploymentId
  )
    return false;
  const placement = {
    runtimeTargetId: session.runtimeTargetId,
    identityId: target.identityId,
    deploymentId: session.deploymentId,
    physicalEpoch: session.originPhysicalEpoch,
    connectionGeneration: Number(grant.generation),
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    agentSessionId: lineage.agentSessionId,
  };
  return (
    submit.control.authorityRefs.length === 2 &&
    submit.control.authorityRefs[1] === commandInputHash(placement)
  );
}

/** Verifies that a retained physical result belongs to the original submitted operation. */
export function verifyNanoHostCleanupSubmitPlacement(
  db: CoreDb,
  sqlite: FinalNativeReader,
  lease: NanoHostRecoveryLease,
  session: NanoHostAcceptedFinalProof['session']
): boolean {
  const original = readRetainedNanoHostSubmission(db, lease.grant.attemptId);
  return (
    original !== null &&
    isDeepStrictEqual(original.lease, lease) &&
    hasCompleteExecutionHistory(db, lease.grant.execution) &&
    hasOriginalSubmissionPlacement(
      db,
      sqlite,
      lease.grant,
      nanoHostWorkerLineage(original),
      session
    )
  );
}

/** The verified commitment that K8b hands to the guarded closeout read. */
export type NanoHostAcceptedFinalCommitment = NanoHostAcceptedFinalProof & {
  readonly state: 'settled';
  readonly receipt: Extract<
    StorageReceiptLookup<ExecutionProofReceipt>,
    { state: 'settled' }
  >['receipt'];
};

/**
 * One inspect-only K8b readback of an accepted Native final.
 * `settled` is the only result that permits closeout. `native-only` means that the Native pair matches the
 * original Core intake and that complete Core history proves the `worker-final-accepted` receipt absent.
 */
export type NanoHostAcceptedFinalReadback =
  | NanoHostAcceptedFinalCommitment
  | (NanoHostAcceptedFinalProof & { readonly state: 'native-only'; readonly receipt: null })
  | { readonly state: 'held'; readonly reason: NanoHostAcceptedFinalHold };

/**
 * Joins the original accepted Native final to its original Core intake and receipt without writing.
 * Recovery never calls the deciding observer, which commits a receipt on absence. Missing, duplicate,
 * unreadable or contradictory proof holds.
 *
 * @param db Core snapshot that holds the original submitted grant, intake and receipt.
 * @param sqlite Admitted read-only NanoHost snapshot.
 * @param attemptId Original submitted attempt.
 */
export function inspectAcceptedNanoHostFinalInDb(
  db: CoreDb,
  sqlite: FinalNativeReader,
  attemptId: string
): NanoHostAcceptedFinalReadback {
  const held = (reason: NanoHostAcceptedFinalHold) => ({ state: 'held', reason }) as const;
  if (!sqlite.readonly) return held('unknown');
  try {
    const inspect = () =>
      db.sqlite
        .transaction((): NanoHostAcceptedFinalReadback => {
          const original = readRetainedNanoHostSubmission(db, attemptId);
          const route =
            original && readNanoHostWorkerRouteBinding({ sqlite }, original.lease.grant);
          if (!original || !route) return held('missing');
          const { grant } = original.lease;
          const expected = nanoHostWorkerLineage(original);
          const records = sqlite
            .prepare(`SELECT record_key AS recordKey, sequence, schema_version AS schemaVersion,
          record_json AS recordJson, accepted_at AS acceptedAt
          FROM worker_control_records
          WHERE workspace_id=? AND thread_id=? AND turn_id=? AND agent_session_id=?
            AND package_snapshot_id=? AND request_id IS ? AND operation='final_status'`)
            .all(
              expected.workspaceId,
              expected.threadId,
              expected.turnId,
              expected.agentSessionId,
              expected.packageSnapshotId,
              expected.requestId ?? null
            ) as {
            recordKey: string;
            sequence: number;
            schemaVersion: unknown;
            recordJson: string;
            acceptedAt: string;
          }[];
          if (records.length === 0) return held('missing');
          if (records.length !== 1) return held('duplicate');
          const [final] = records as [(typeof records)[number]];
          const { sequence } = final;
          // Uniqueness is checked at the original terminal sequence, then its lineage and canonical key.
          const events = sqlite
            .prepare(`SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
          request_id AS requestId, record_key AS recordKey, schema_version AS schemaVersion,
          record_json AS recordJson, accepted_at AS acceptedAt FROM worker_control_records
          WHERE agent_session_id=? AND package_snapshot_id=? AND operation='event_append'
            AND sequence=?`)
            .all(
              expected.agentSessionId,
              expected.packageSnapshotId,
              sequence
            ) as (NativeLineageColumns & {
            recordKey: string;
            schemaVersion: unknown;
            recordJson: string;
            acceptedAt: string;
          })[];
          if (events.length === 0) return held('missing');
          if (events.length !== 1) return held('duplicate');
          const [terminal] = events as [(typeof events)[number]];
          if (
            !hasNativeLineageColumns(terminal, expected) ||
            terminal.recordKey !== String(sequence)
          )
            return held('conflict');
          // The Native pair verifier below rechecks both records, both receipts and both clocks.
          const {
            acceptedAt: _acceptedAt,
            sequence: _sequence,
            ...terminalData
          } = readRetainedV1(final, () => JSON.parse(final.recordJson)) as Record<string, unknown>;
          const event = readRetainedV1(terminal, () => JSON.parse(terminal.recordJson)) as {
            readonly lineage?: ControlWorkerFinalStatusCommand['lineage'];
          };
          if (
            final.recordKey !== String(sequence) ||
            !event.lineage ||
            !matchesNanoHostWorkerLineage(original, event.lineage)
          )
            return held('conflict');
          // The carried lineage and the historical control route hash rebuild the original intake fingerprint.
          const command: FinalCommand = {
            lineage: event.lineage,
            sandboxBindingRef: original.lease.attempt.bindingRef,
            tokenHash: route.control,
            payload: {
              terminalData: WorkerCanonicalTerminalEventDataSchema.parse(terminalData),
              sequence,
              acceptedAt: final.acceptedAt,
              eventAcceptedAt: terminal.acceptedAt,
            },
          };
          const { native } = readOriginalWorkerFinalBinding(db, sqlite, command);
          const session = {
            runtimeTargetId: native.session.runtimeTargetId,
            deploymentId: native.session.deploymentId,
            originPhysicalEpoch: native.session.originPhysicalEpoch,
            backendSessionId: native.session.backendSessionId,
          };
          // The receipt key uses the session deployment, so the original submission placement comes first.
          if (!hasOriginalSubmissionPlacement(db, sqlite, grant, expected, session))
            return held('conflict');
          const intake = readCoreWorkerFinalIntake(db, grant, command);
          if (!intake) return held('missing');
          if (!hasExactNativeWorkerFinal(sqlite, command, intake)) return held('conflict');
          // Both Native sequence receipts must carry the original lineage, not only its fingerprints.
          const receipts = sqlite
            .prepare(`SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
          request_id AS requestId FROM worker_control_sequence_fingerprints
          WHERE agent_session_id=? AND package_snapshot_id=? AND sequence=?
            AND operation IN ('final_status', 'event_append')`)
            .all(
              expected.agentSessionId,
              expected.packageSnapshotId,
              sequence
            ) as NativeLineageColumns[];
          if (
            receipts.length !== 2 ||
            !receipts.every((row) => hasNativeLineageColumns(row, expected))
          )
            return held('conflict');
          const { intent } = acceptedNanoHostFinalReceiptIntent(
            session.deploymentId,
            intake,
            sequence
          );
          // Absence counts only when the retained steps account for every revision of the execution.
          const receipt = inspectKernelProofReceipt(
            db,
            intent,
            hasCompleteExecutionHistory(db, grant.execution)
          );
          if (receipt.state !== 'settled' && receipt.state !== 'absent') return held(receipt.state);
          const { terminalData: data } = command.payload;
          const proof: NanoHostAcceptedFinalProof = {
            grant,
            lineage: command.lineage,
            sandboxBindingRef: command.sandboxBindingRef,
            sequence,
            fingerprint: intake.fingerprint,
            finalFingerprint: canonicalJsonText({ ...data, lineage: command.lineage, sequence }),
            eventFingerprint: canonicalJsonText(
              buildWorkerCanonicalTerminalEventRecord({ data, lineage: command.lineage, sequence })
            ),
            acceptedAt: intake.acceptedAt,
            eventAcceptedAt: intake.eventAcceptedAt,
            session,
          };
          return receipt.state === 'settled'
            ? { ...proof, state: 'settled', receipt: receipt.receipt }
            : { ...proof, state: 'native-only', receipt: null };
        })
        .deferred();
    // One deferred Native read transaction pins every Native record and receipt of this readback.
    return sqlite.inTransaction ? inspect() : sqlite.transaction(inspect).deferred();
  } catch (error) {
    if (error instanceof WorkerFinalStatusRefusal) return held('conflict');
    return held('unknown');
  }
}

/**
 * K8b: a missing Native final counts as absent only when no other accepted-final evidence survives.
 * That evidence is a canonical terminal event, its sequence receipt, or the original Core
 * `worker-final-accepted` receipt. A Core intake alone is a genuine crash before Native FULL.
 * The receipt key uses the session deployment, so the original submit placement and complete Core
 * history come first. Without them the receipt absence is not proved, and this returns true.
 *
 * @param db Core snapshot that holds the original submitted grant and its receipt steps.
 * @param sqlite Admitted NanoHost snapshot of the original session.
 * @param attemptId Original submitted attempt.
 * @param session Candidate Native coordinates of the original session.
 * @returns Whether accepted-final evidence survives, or its absence is unproved, without its Native final.
 */
export function hasSurvivingNanoHostFinalEvidence(
  db: CoreDb,
  sqlite: FinalNativeReader,
  attemptId: string,
  session: NanoHostAcceptedFinalProof['session']
): boolean {
  const original = readRetainedNanoHostSubmission(db, attemptId);
  if (!original) return true;
  const lineage = nanoHostWorkerLineage(original);
  const { agentSessionId, packageSnapshotId } = lineage;
  const terminal = (column: string) => `CASE WHEN json_valid(${column})
    THEN json_extract(${column}, '$.event.type') END IN ('turn.completed', 'turn.failed')`;
  if (
    sqlite
      .prepare(`SELECT 1 FROM worker_control_records
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='event_append'
        AND ${terminal('record_json')}
      UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='event_append'
        AND ${terminal('fingerprint')}`)
      .get(agentSessionId, packageSnapshotId, agentSessionId, packageSnapshotId)
  )
    return true;
  const { grant } = original.lease;
  if (
    !hasOriginalSubmissionPlacement(db, sqlite, grant, lineage, session) ||
    !hasCompleteExecutionHistory(db, grant.execution)
  )
    return true;
  return !!db.sqlite
    .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
    .get(
      grant.execution.executionId,
      storageRequestId(
        acceptedNanoHostFinalReceiptOccurrence(session.deploymentId, grant.operationId)
      )
    );
}

/**
 * K8b: the final decision that one recovery close consumes. `native-only` is the proved Native-only final.
 * `absent` is a proved absence: no final record or final receipt of the original session survives, and
 * no other accepted-final evidence survives under the original placement and complete Core history.
 */
export type NanoHostFinalCloseDecision =
  | Extract<NanoHostAcceptedFinalReadback, { readonly state: 'native-only' }>
  | { readonly state: 'absent' };

/**
 * Recomputes the close decision from one Core snapshot and one admitted Native snapshot.
 * Settled, contradictory or unreadable proof returns `held`.
 *
 * @param db Core snapshot that holds the original submitted grant, intake and receipt.
 * @param sqlite Admitted read-only NanoHost snapshot.
 * @param attemptId Original submitted attempt.
 * @param session Native coordinates of the original session.
 */
export function readNanoHostFinalCloseDecision(
  db: CoreDb,
  sqlite: FinalNativeReader,
  attemptId: string,
  session: NanoHostAcceptedFinalProof['session']
): NanoHostFinalCloseDecision | { readonly state: 'held' } {
  const readback = inspectAcceptedNanoHostFinalInDb(db, sqlite, attemptId);
  if (readback.state === 'native-only') return readback;
  if (readback.state !== 'held' || readback.reason !== 'missing') return { state: 'held' };
  const original = readRetainedNanoHostSubmission(db, attemptId);
  if (!original) return { state: 'held' };
  const { agentSessionId, packageSnapshotId } = nanoHostWorkerLineage(original);
  const final = sqlite
    .prepare(`SELECT 1 FROM worker_control_records
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='final_status'
      UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='final_status'`)
    .get(agentSessionId, packageSnapshotId, agentSessionId, packageSnapshotId);
  return final || hasSurvivingNanoHostFinalEvidence(db, sqlite, attemptId, session)
    ? { state: 'held' }
    : { state: 'absent' };
}

/** Reads the exact currently live route under the admitted Core and Native snapshots. */
export function captureSecurityCanaryAuditObservation(
  coreDb: CoreDb,
  native: CoreDb['sqlite'],
  lineage: NonNullable<ControlStandaloneAuditInput['canaryLineage']>,
  authenticatedCapabilityHash?: string
): SecurityCanaryAuditObservation | null {
  if (!coreDb.sqlite.inTransaction || !native.readonly || !native.inTransaction) return null;
  try {
    const owner = { sqlite: native };
    const session = getWorkerBackendSessionByPackage(owner, lineage.packageSnapshotId);
    if (!session) return null;
    const original = readRetainedNanoHostSubmission(coreDb, session.attemptId);
    if (!original) return null;
    const binding = inspectNanoHostWorkerBinding(native, original, {
      sandboxBindingRef: session.sandboxBindingRef,
      lineage,
      ...(authenticatedCapabilityHash === undefined
        ? {}
        : { tokenFamily: 'capability', tokenHash: authenticatedCapabilityHash }),
    });
    if (
      binding.status !== 'accepted' ||
      nanoHostWorkerBindingLiveness(binding, new Date().toISOString()).status !== 'accepted'
    )
      return null;

    const { grant, attempt } = original.lease;
    const route = readNanoHostWorkerRouteBinding(owner, grant);
    const target = getNanoHostRuntimeTarget(owner, session.runtimeTargetId);
    if (!route || !target) return null;
    return {
      attemptId: attempt.attemptId,
      sandboxBindingRef: session.sandboxBindingRef,
      observationHash: commandInputHash({
        grant,
        queueEntryId: attempt.queueEntryId,
        lineage,
        session,
        route,
        target,
        recovery: binding.proof,
      }),
    };
  } catch {
    return null;
  }
}

const terminalReleaseStepId = 'worker-terminal-release';
type TerminalReleaseInput = ControlNanoHostTerminalReleaseInput;

const workerHandoffSteps = [
  ['terminal', 'terminal-publication', 'terminal-publication', 'worker.terminal-publication'],
  ['output', 'output', 'collect', 'worker.collect.publication'],
  ['evidence', 'evidence', 'collect', 'worker.collect.transcript'],
  ['collection', 'outside-workspace-collection', 'collect', 'worker.collect.capture'],
] as const;

/** Names and hashes an immutable Workspace occurrence without carrying transcript or artifact bytes. */
export function nanoHostTerminalReleaseWorkspaceStep(
  ended: EndedExecutionStep,
  carriage: ExecutionInvocationCarriage
): { readonly stepId: string; readonly digest: string } {
  const digest = sha256CanonicalJson(
    JSON.parse(
      encodeExecutionJournalValue({
        ref: ended.ref,
        state: ended.state,
        control: ended.control,
        carriage,
        endedAt: ended.span.endTimeUnixNano,
      })
    )
  );
  return { stepId: ended.ref.stepId, digest: `sha256:${digest}` };
}

function readTerminalReleaseWorkspace(
  db: CoreDb,
  workspace: WorkspaceDb,
  input: TerminalReleaseInput,
  lease: NanoHostRecoveryLease
) {
  const { attempt, grant } = lease;
  const owner = { kind: 'workspace' as const, workspaceId: attempt.workspaceId };
  const execution = { owner, executionId: input.workspaceExecutionId };
  const root = readExecutionJournalRoot(workspace, execution);
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, attempt.attemptId);
  if (
    workspace.dataRoot !== db.dataRoot ||
    workspace.workspaceId !== attempt.workspaceId ||
    root.definitionVersion !== WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION ||
    root.workId !== grant.turnId ||
    root.phase !== 'closed' ||
    root.openSteps.length !== 0 ||
    root.exclusionRefs.length !== 0 ||
    root.fingerprint !==
      commandInputHash({
        turnId: grant.turnId,
        attemptId: grant.attemptId,
        bindingRef: grant.bindingRef,
        packageSnapshotId: grant.inputRef,
      })
  )
    throw new CoreJournalRefusal('Original Workspace release is unresolved.');
  const inspect = (
    key: keyof TerminalReleaseInput['workspaceSteps'],
    kind: EndedExecutionStep['control']['kind'],
    operation: string
  ) => {
    const expected = input.workspaceSteps[key];
    const ref = { execution, stepId: expected.stepId };
    const ended = readExecutionJournalEndedStep(workspace, ref);
    const invocation = readExecutionJournalInvocation(workspace, ref);
    if (
      ended.state !== 'completed' ||
      ended.control.kind !== kind ||
      ended.control.attemptId !== grant.attemptId ||
      ended.control.workId !== grant.turnId ||
      !isDeepStrictEqual(ended.control.actor, admission.triggerActor) ||
      !isDeepStrictEqual(ended.control.authorityRefs, [
        grant.turnId,
        attempt.agentSessionId,
        grant.attemptId,
      ]) ||
      invocation.carriage.operation !== operation ||
      nanoHostTerminalReleaseWorkspaceStep(ended, invocation.carriage).digest !== expected.digest
    )
      throw new CoreJournalRefusal('Original Workspace release step conflicts.');
    return { ended, carriage: invocation.carriage };
  };
  const handoffs = workerHandoffSteps.map(([key, kind, stepKind, operation]): ExecutionHandoff => {
    const { ended, carriage } = inspect(key, stepKind, operation);
    if (
      carriage.bindingRef !== grant.bindingRef ||
      !isDeepStrictEqual(ended.control.inputRefs, [grant.turnId, grant.inputRef])
    )
      throw new CoreJournalRefusal('Original Workspace handoff binding conflicts.');
    return {
      kind,
      owner,
      ref: `workspace-step/v1:${owner.workspaceId}:${execution.executionId}:${ended.ref.stepId}`,
      digest: input.workspaceSteps[key].digest,
    };
  });
  const release = inspect('release', 'release', 'worker.release');
  if (
    release.carriage.bindingRef !== grant.bindingRef ||
    !isDeepStrictEqual(release.ended.control.outputRefs, [input.fenceRef])
  )
    throw new CoreJournalRefusal('Original Workspace release fence conflicts.');
  const consume = inspect('consume', 'consume-receipt', 'turn.start');
  const [fingerprint] = consume.ended.control.inputRefs;
  if (
    !fingerprint ||
    !consume.carriage.bindingRef ||
    consume.carriage.sequence === null ||
    !isDeepStrictEqual(consume.ended.control.inputRefs, [fingerprint]) ||
    !isDeepStrictEqual(consume.ended.control.outputRefs, [fingerprint])
  )
    throw new CoreJournalRefusal('Original Workspace consume acknowledgement conflicts.');
  const consumer = readCoreHarnessConsumption(db, {
    harnessBindingRef: consume.carriage.bindingRef,
    operationId: consume.carriage.requestId,
    sequence: consume.carriage.sequence,
    resultFingerprint: fingerprint,
  });
  if (
    !consumer ||
    !isDeepStrictEqual(JSON.parse(consumer), {
      workspaceId: attempt.workspaceId,
      turnId: grant.turnId,
      executionId: execution.executionId,
      stepId: consume.ended.ref.stepId,
    })
  )
    throw new CoreJournalRefusal('Original Core consume acknowledgement is unavailable.');
  return { handoffs, consume: consume.carriage };
}

function terminalReleaseProposal(
  db: CoreDb,
  grant: ExecutionGrant,
  root: ExecutionJournalExecution,
  input: TerminalReleaseInput,
  revision: number
): ExecutionJournalIntent {
  const span = { ...root.span, endTimeUnixNano: null, status: { code: 'UNSET' as const } };
  const invocationId = `${grant.attemptId}:${terminalReleaseStepId}`;
  const fingerprint = commandInputHash(input);
  // The closed root's mutable revision, exclusions and diagnostic end clock do not enter replay.
  return {
    execution: {
      ref: root.ref,
      definitionVersion: root.definitionVersion,
      workId: root.workId,
      fingerprint: root.fingerprint,
      exclusionRefs: [],
      span,
    },
    stepId: terminalReleaseStepId,
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: {
      operation: terminalReleaseStepId,
      requestId: grant.operationId,
      sequence: null,
      bindingRef: grant.bindingRef,
    },
    control: {
      definitionVersion: root.definitionVersion,
      kind: 'release',
      target: null,
      workId: grant.turnId,
      operationId: grant.operationId,
      invocationId,
      attemptId: grant.attemptId,
      actor: requireSchedulerExecutionAttemptAdmissionContext(db, grant.attemptId).triggerActor,
      inputRefs: [fingerprint],
      outputRefs: [],
      fingerprint,
      permittingDecisionRef: grant.operationId,
      authorityRefs: [String(revision)],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    span: {
      ...span,
      name: terminalReleaseStepId,
      spanId: sha256Hex(invocationId).slice(0, 16),
      parentSpanId: span.spanId,
    },
  };
}

/** Inspects the stable release proposal against the original completed step without releasing again. */
export function inspectCoreNanoHostTerminalRelease(
  db: CoreDb,
  input: TerminalReleaseInput
): StorageReceiptLookup<ExecutionStepRef> {
  const original = readRetainedNanoHostSubmission(db, input.attemptId);
  if (!original) return { state: 'unknown' };
  const { grant } = original.lease;
  const ref = { execution: grant.execution, stepId: terminalReleaseStepId };
  if (
    !db.sqlite
      .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
      .get(ref.execution.executionId, ref.stepId)
  )
    return { state: 'absent' };
  const step = readExecutionJournalInvocation(db, ref);
  const [revision] = step.control.authorityRefs;
  if (!revision || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)))
    return { state: 'conflict' };
  const root = readExecutionJournalRoot(db, grant.execution);
  const proposal = terminalReleaseProposal(db, grant, root, input, Number(revision));
  return inspectKernelExecutionReleaseInDb(db, proposal, grant, Number(revision));
}

function commitTerminalReleaseEvidence(
  db: CoreDb,
  input: TerminalReleaseInput,
  lease: NanoHostRecoveryLease,
  handoffs: readonly ExecutionHandoff[],
  physicalDigest: string
): StorageDecision<ExecutionStepRef> {
  const { grant } = lease;
  const root = readExecutionJournalRoot(db, grant.execution);
  const proposal = terminalReleaseProposal(db, grant, root, input, root.revision);
  const fence = {
    kind: 'fence' as const,
    fence: { backendId: 'nanohost', ref: input.fenceRef, digest: physicalDigest },
    coveredScopeRefs: input.coveredScopeRefs,
  };
  const evidence = [
    ...handoffs.map((handoff) => ({
      kind: 'handoff' as const,
      handoff,
    })),
    { kind: 'fence' as const, proof: fence },
  ];
  for (const fact of evidence) {
    const occurrence = {
      deploymentId: input.target.deploymentId,
      sourceOwner: fact.kind === 'handoff' ? 'workspace' : 'nanohost',
      verb: 'apply-execution-proof',
      occurrenceKey: `worker-terminal-release:${grant.operationId}:${fact.kind === 'handoff' ? fact.handoff.kind : 'fence'}`,
    } as const;
    const intent: ExecutionProofIntent = {
      ...occurrence,
      requestId: storageRequestId(occurrence),
      target: grant,
      expectedGeneration: grant.generation,
      inputDigest: sha256CanonicalJson(fact.kind === 'handoff' ? fact.handoff : fact.proof),
    };
    const retained: KernelExecutionEvidence = { version: 1, intent, ...fact };
    const kind =
      fact.kind === 'fence'
        ? 'fence'
        : fact.handoff.kind === 'terminal-publication'
          ? 'terminal-publication'
          : 'collect';
    // The admitted peer readers already verified each fact in this same deciding savepoint.
    const result = commitKernelExecutionEvidenceInDb(
      db,
      {
        ...proposal,
        stepId: intent.requestId,
        carriage: { ...proposal.carriage, operation: kind, requestId: intent.requestId },
        control: { ...proposal.control, kind },
        span: { ...proposal.span, spanId: sha256Hex(intent.requestId).slice(0, 16) },
      },
      retained,
      true,
      () => true
    );
    if (result.state !== 'settled') return { state: result.state };
  }
  const revision = readExecutionJournalRoot(db, grant.execution).revision;
  return releaseKernelExecutionScopesInDb(
    db,
    terminalReleaseProposal(db, grant, root, input, revision),
    grant,
    revision,
    () => true
  );
}

/** Commits the ordinary terminal Worker's exact scoped release from its pinned peer evidence. */
export function releaseCoreNanoHostTerminalInDb(
  db: CoreDb,
  input: TerminalReleaseInput,
  readers: {
    readonly workspace: WorkspaceDb;
    readonly native: Parameters<typeof readNanoHostPhysicalCleanupReceipt>[0];
    readonly verifyDrainAndRevocation: (lease: NanoHostRecoveryLease) => boolean;
  }
): StorageDecision<ExecutionStepRef> {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new ExecutionAttemptRefusal(
      'Worker terminal release requires the Core writer transaction.'
    );
  const prior = inspectCoreNanoHostTerminalRelease(db, input);
  if (prior.state !== 'absent') return prior;
  const original = readRetainedNanoHostSubmission(db, input.attemptId);
  if (!original || !readers.native.readonly) return { state: 'unknown' };
  const { lease } = original;
  const { grant, attempt } = lease;
  const allowedScopes = [
    `workspace:${attempt.workspaceId}`,
    `thread:${attempt.threadId}`,
    `turn:${attempt.turnId}`,
    `session:${attempt.agentSessionId}`,
  ];
  if (
    attempt.phase !== 'closed' ||
    attempt.disposition !== 'accepted' ||
    attempt.fenceRef !== input.fenceRef ||
    new Set(input.coveredScopeRefs).size !== input.coveredScopeRefs.length ||
    input.coveredScopeRefs.some((scope) => !allowedScopes.includes(scope))
  )
    return { state: 'conflict' };
  return db.sqlite.transaction((): StorageDecision<ExecutionStepRef> => {
    const target = getNanoHostRuntimeTarget({ sqlite: readers.native }, input.target.targetId);
    const physical =
      target &&
      readNanoHostPhysicalCleanupReceipt(readers.native, lease, target, (session) =>
        verifyNanoHostCleanupSubmitPlacement(db, readers.native, lease, session)
      );
    if (
      !target ||
      !physical ||
      physical.session.state !== 'cleaned' ||
      physical.session.workspaceHandoffState !== 'complete' ||
      target.identityId !== input.target.identityId ||
      target.deploymentId !== input.target.deploymentId ||
      target.connectionGeneration !== input.target.connectionGeneration ||
      target.physicalEpoch !== input.target.physicalEpoch ||
      input.fenceRef !== `worker-backend:${grant.attemptId}:${physical.observedAt}`
    )
      return { state: 'unknown' };
    const native = readNanoHostWorkerLease({ sqlite: readers.native }, grant, attempt);
    const workspace = readTerminalReleaseWorkspace(db, readers.workspace, input, lease);
    if (
      !native ||
      native.binding.harnessOperationId !== workspace.consume.requestId ||
      native.binding.harnessSequence !== workspace.consume.sequence ||
      !readers.verifyDrainAndRevocation(lease)
    )
      return { state: 'unknown' };
    const digest = commandInputHash({
      grant,
      backendSessionId: physical.session.backendSessionId,
      target: input.target,
      cleanedAt: physical.observedAt,
      coveredScopeRefs: input.coveredScopeRefs,
    });
    return commitTerminalReleaseEvidence(db, input, lease, workspace.handoffs, digest);
  })();
}

const containmentEvidenceAction = 'security.containment-evidence';

function containmentEvidenceAuditId(evidenceId: string): string {
  return deriveEntityId('aud', [containmentEvidenceAction, evidenceId]);
}

/** Reads the exact redacted handoff for the independent Server work publisher. */
export function readContainmentEvidenceHandoff(
  db: CoreDb,
  evidenceId: string
): ServerEvidenceBundleRecord | null {
  const row = db.sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id=?')
    .get(containmentEvidenceAuditId(evidenceId));
  if (!row) return null;
  const event = auditEventFromRow(row);
  const evidence = event.kernelEvidence;
  if (
    event.action !== containmentEvidenceAction ||
    event.workspaceId !== null ||
    evidence?.kind !== containmentEvidenceAction ||
    evidence.evidenceId !== evidenceId
  )
    throw new CoreJournalRefusal('Original containment evidence conflicts.');
  return ServerEvidenceBundleRecordSchema.parse({
    id: evidenceId,
    owner: { kind: 'server' },
    threadId: event.threadId,
    turnId: event.turnId,
    agentSessionId: event.agentSessionId,
    goalId: null,
    backendType: evidence.backendType,
    sourceKind: evidence.sourceKind,
    summary: event.summary,
    rawEvidenceRefs: [],
    redactedEvidenceRefs: evidence.redactedEvidenceRefs,
    contentDigests: evidence.contentDigests,
    retentionClass: 'workspace-audit',
    sensitivityClass: 'restricted',
    importStatus: 'collected',
    requiredFeatures: [],
    createdAt: event.createdAt,
  });
}

type ContainmentAuditEvidence = Extract<
  NonNullable<KernelAuditEvent['kernelEvidence']>,
  { kind: 'security.containment-evidence' }
>;
type ContainmentEvidenceFacts = Pick<
  ServerEvidenceBundleRecord,
  'id' | 'threadId' | 'turnId' | 'agentSessionId' | 'summary' | 'createdAt'
> &
  Pick<
    ContainmentAuditEvidence,
    'backendType' | 'sourceKind' | 'redactedEvidenceRefs' | 'contentDigests'
  >;

/** Keeps the kernel decision independent of the destination EvidenceBundle publisher. */
function appendContainmentEvidenceHandoff(
  db: CoreDb,
  actor: ActorRef,
  facts: ContainmentEvidenceFacts
): void {
  const now = new Date(facts.createdAt);
  recordServerAuditEvent({
    coreDb: db,
    auditEventId: containmentEvidenceAuditId(facts.id),
    action: containmentEvidenceAction,
    actor,
    category: 'system',
    outcome: 'succeeded',
    workspaceId: null,
    threadId: facts.threadId,
    turnId: facts.turnId,
    agentSessionId: facts.agentSessionId,
    resource: `evidence:${facts.id}`,
    summary: facts.summary,
    now,
    occurredAt: now,
    kernelEvidence: {
      kind: containmentEvidenceAction,
      evidenceId: facts.id,
      sourceKind: facts.sourceKind,
      backendType: facts.backendType,
      redactedEvidenceRefs: facts.redactedEvidenceRefs,
      contentDigests: facts.contentDigests,
    },
  });
}

type IdleCleanupIntent = Extract<ControlCoreJournalInput, { kind: 'idle-intent' }>;

function requireIdleDeletePredecessor(
  db: CoreDb,
  input: IdleCleanupIntent,
  sandboxId: string
): void {
  const request = createNanoHostEffectRequest(input.identity, input.attemptId, 'bridge.close', {
    attemptId: input.attemptId,
    sandboxId,
  });
  const ref: ExecutionStepRef = {
    execution: { owner: { kind: 'server' }, executionId: `idle-cleanup:${request.requestId}` },
    stepId: `effect:${request.requestId}`,
  };
  const present = db.sqlite
    .prepare('SELECT 1 FROM control_executions WHERE id = ?')
    .get(ref.execution.executionId);
  // The original direct delete is permitted when there is no bridge occurrence to continue.
  if (!present && !input.predecessor) return;
  const refusal = 'Idle cleanup predecessor changed before delete admission.';
  if (!present || !input.predecessor || !isDeepStrictEqual(input.predecessor.ref, ref))
    throw new CoreJournalRefusal(refusal);
  const root = readExecutionJournalRoot(db, ref.execution);
  const previous = readExecutionJournalInvocation(db, ref);
  if (
    root.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION ||
    root.workId !== request.requestId ||
    root.revision !== input.predecessor.revision ||
    root.phase !== 'closed' ||
    previous.state !== 'completed' ||
    previous.carriage.operation !== 'bridge.close' ||
    previous.carriage.requestId !== request.requestId ||
    previous.carriage.bindingRef !== input.sandboxBindingRef ||
    previous.control.attemptId !== input.attemptId ||
    previous.control.target?.targetId !== input.identity.runtimeTargetId ||
    previous.control.target.allocationRef !== input.sandboxBindingRef ||
    !previous.control.physicalFenceRefs.includes(input.originPhysicalEpoch) ||
    !isDeepStrictEqual(previous.control.actor, input.package.triggerActor) ||
    !hasCoreIdleCleanupConsumption(db, previous)
  )
    throw new CoreJournalRefusal(refusal);
}

/** Reserves the original closed resident's physical scope against one pinned Native snapshot. */
export function reserveCoreIdleCleanupInDb(
  db: CoreDb,
  input: IdleCleanupIntent,
  native: CoreDb['sqlite'] | undefined
): string {
  if (!db.sqlite.inTransaction || db.sqlite.readonly || !native?.readonly || !native.inTransaction)
    throw new CoreJournalRefusal('Idle cleanup requires an original Core scope reservation.');

  const intent = decodeExecutionJournalIntent(input.intentJson);
  const attempt = requireSchedulerExecutionAttempt(db, input.attemptId);
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, input.attemptId);
  const nanoHost = { sqlite: native };
  const anchor = getWorkerBackendSession(nanoHost, input.attemptId);
  const target = getNanoHostRuntimeTarget(nanoHost, input.identity.runtimeTargetId);
  const identity = anchor && {
    agentSessionId: anchor.agentSessionId,
    backendKind: anchor.backendKind,
    backendSessionId: anchor.backendSessionId,
    deploymentId: anchor.deploymentId,
    packageSnapshotId: anchor.packageSnapshotId,
    runtimeTargetId: anchor.runtimeTargetId,
    stagingDirectoryRef: anchor.stagingDirectoryRef,
    transientProviderInstanceId: anchor.transientProviderInstanceId,
  };
  if (
    attempt.phase !== 'closed' ||
    !attempt.fenceRef ||
    attempt.backendId !== input.backendId ||
    !anchor ||
    !isDeepStrictEqual(identity, input.identity) ||
    anchor.workspaceId !== attempt.workspaceId ||
    anchor.threadId !== attempt.threadId ||
    anchor.turnId !== attempt.turnId ||
    anchor.agentSessionId !== attempt.agentSessionId ||
    anchor.packageSnapshotId !== attempt.inputRef ||
    anchor.sandboxBindingRef !== attempt.bindingRef ||
    anchor.originPhysicalEpoch !== input.originPhysicalEpoch ||
    !target?.predecessorFenced ||
    !target.ready ||
    !target.freshEmpty ||
    target.deploymentId !== anchor.deploymentId ||
    target.physicalEpoch !== input.originPhysicalEpoch ||
    !/^[0-9a-f]{64}$/.test(input.originPhysicalEpoch)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup has no exact closed resident provenance or current Epoch.'
    );
  if (
    input.package.workspaceId !== anchor.workspaceId ||
    input.package.threadId !== anchor.threadId ||
    input.package.turnId !== anchor.turnId ||
    input.package.agentSessionId !== anchor.agentSessionId ||
    input.package.snapshotId !== anchor.packageSnapshotId ||
    !isDeepStrictEqual(input.package.triggerActor, admission.triggerActor) ||
    !isDeepStrictEqual(intent.control.actor, admission.triggerActor)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup immutable package actor or physical lineage conflicts.'
    );

  const { operation, requestId } = intent.carriage;
  const cleanup = operation === 'bridge.close' || operation === 'sandbox.delete';
  const sandboxId = nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId);
  const resident = native
    .prepare(`SELECT sandbox_runtime_id AS id, drain_state AS drain FROM sandbox_runtime_records
      WHERE sandbox_binding_ref = ? AND runtime_target_id = ? AND origin_physical_epoch = ?
      AND ('nh-' || substr(sandbox_compatibility_key, 1, 16)) = ?`)
    .get(input.sandboxBindingRef, target.targetId, input.originPhysicalEpoch, sandboxId) as
    | { id: string; drain: string }
    | undefined;
  if (
    !resident ||
    (cleanup && resident.drain !== 'draining') ||
    (input.sandboxId !== undefined && input.sandboxId !== sandboxId) ||
    nonClosedSandboxAttempts(
      db,
      input.backendId,
      { scope: input.package, snapshotId: input.package.snapshotId },
      target.targetId,
      input.originPhysicalEpoch,
      sandboxId,
      nanoHost
    ).length !== 0 ||
    native
      .prepare(`SELECT 1 FROM harness_instance_records h WHERE h.sandbox_runtime_id = ?
        AND (h.schema_version <> 1 OR h.active_turn_count <> 0
          OR h.operation_state NOT IN ('idle', 'settled')
          OR EXISTS (SELECT 1 FROM agent_session_runtime_bindings b
            WHERE b.harness_instance_id = h.harness_instance_id
            AND (b.schema_version <> 1 OR b.current_turn_id IS NOT NULL
              OR b.current_attempt_id IS NOT NULL))) LIMIT 1`)
      .get(resident.id)
  )
    throw new CoreJournalRefusal('Core idle cleanup resident is stale or has live work.');

  const expectedKind =
    operation === 'bridge.close'
      ? 'inspect-cleanup'
      : operation === 'sandbox.delete'
        ? 'release'
        : 'collect';
  if (
    intent.execution.ref.owner.kind !== 'server' ||
    intent.execution.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION ||
    (!cleanup && operation !== 'workspace.collect' && operation !== 'file.export') ||
    intent.control.kind !== expectedKind ||
    intent.execution.ref.executionId !== `idle-cleanup:${requestId}` ||
    intent.execution.workId !== requestId ||
    intent.stepId !== `effect:${requestId}` ||
    intent.control.operationId !== requestId ||
    intent.carriage.bindingRef !== input.sandboxBindingRef ||
    intent.control.attemptId !== input.attemptId ||
    intent.control.target?.allocationRef !== input.sandboxBindingRef ||
    intent.control.target.targetId !== target.targetId ||
    !isDeepStrictEqual(intent.execution.exclusionRefs, [
      input.sandboxBindingRef,
      input.originPhysicalEpoch,
    ]) ||
    !intent.control.authorityRefs.includes(anchor.sandboxBindingRef) ||
    !intent.control.physicalFenceRefs.includes(input.originPhysicalEpoch) ||
    intent.control.deadlineUnixNano === null ||
    intent.control.deadlineUnixNano <= BigInt(Date.now()) * 1_000_000n ||
    (cleanup &&
      requestId !==
        createNanoHostEffectRequest(input.identity, input.attemptId, operation, {
          attemptId: input.attemptId,
          sandboxId,
        }).requestId)
  )
    throw new CoreJournalRefusal('Core idle cleanup intent conflicts with its original scope.');
  if (
    db.sqlite
      .prepare('SELECT 1 FROM control_executions WHERE id = ?')
      .get(intent.execution.ref.executionId)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup key already exists; inspect retained result only.',
      'idle_cleanup_result_only'
    );
  if (operation === 'sandbox.delete') requireIdleDeletePredecessor(db, input, sandboxId);
  else if (input.predecessor)
    throw new CoreJournalRefusal('Idle cleanup predecessor changed before delete admission.');

  return encodeExecutionJournalValue(writeExecutionJournalIntent(db, intent, input.processWitness));
}

/** Orders retirement and fences ingress on the original live Sandbox before the admitted Native drain. */
function recordSandboxReleaseRefusal(
  db: CoreDb,
  input: Extract<ControlCoreJournalInput, { kind: 'sandbox-release-refusal' }>,
  native: CoreDb['sqlite'] | undefined
): string {
  if (!native?.readonly || !native.inTransaction)
    throw new CoreJournalRefusal('Sandbox release refusal has no admitted Native peer.');
  const target = getNanoHostRuntimeTarget({ sqlite: native }, input.target.targetId);
  const { targetId, physicalEpoch } = input.target;
  const { sandboxBindingRef } = input;
  if (
    !target?.predecessorFenced ||
    !target.ready ||
    !target.freshEmpty ||
    target.identityId !== input.target.identityId ||
    target.deploymentId !== input.target.deploymentId ||
    target.connectionGeneration !== input.target.connectionGeneration ||
    target.physicalEpoch !== physicalEpoch
  )
    throw new CoreJournalRefusal('Sandbox release refusal has no current Host authority.');
  const executionId = sandboxReleaseRefusalExecutionId(targetId, physicalEpoch, sandboxBindingRef);
  if (readSandboxReleaseRefusalOrder(db, executionId)) return executionId;

  const sandbox = native
    .prepare(`SELECT sandbox_runtime_id AS id,
        lifecycle_state AS lifecycle, health_state AS health, drain_state AS drain,
        cleanup_state AS cleanup
      FROM sandbox_runtime_records WHERE sandbox_integration_binding_ref = ?
        AND runtime_target_id = ? AND origin_physical_epoch = ? AND sandbox_binding_ref = ?`)
    .get(input.integrationBindingRef, targetId, physicalEpoch, sandboxBindingRef) as
    | {
        id: string;
        lifecycle: string;
        health: string;
        drain: string;
        cleanup: string;
      }
    | undefined;
  if (!sandbox)
    throw new CoreJournalRefusal('Sandbox release refusal has no exact current binding.');

  const definition = CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION;
  const requestId = executionId.slice('sandbox-release-refusal:'.length);
  const stepId = 'fence';
  if (
    sandbox.lifecycle !== 'open' ||
    sandbox.health !== 'ready' ||
    sandbox.drain !== 'accepting' ||
    sandbox.cleanup !== 'clean'
  )
    throw new CoreJournalRefusal('Sandbox release refusal cannot order a different retirement.');

  const intent = localCoreJournalIntent({
    definitionVersion: definition,
    executionId,
    stepId,
    workId: sandboxBindingRef,
    fingerprint: requestId,
    kind: 'fence',
    actorId: 'nanohost-release-refusal',
    inputRefs: [],
    authorityRefs: [sandbox.id],
    carriage: {
      operation: 'sandbox.release-refusal',
      requestId,
      sequence: null,
      bindingRef: sandboxBindingRef,
    },
    timestamp: new Date().toISOString(),
  });
  writeExecutionJournalIntent(db, {
    ...intent,
    control: {
      ...intent.control,
      target: { backendKind: 'openshell', targetId, allocationRef: sandboxBindingRef },
      physicalFenceRefs: [physicalEpoch],
    },
  });
  return executionId;
}

/** Decides one original Core journal tuple against current rows inside its savepoint and FULL commit. */
export function applyControlCoreJournal(
  db: CoreDb,
  input: ControlCoreJournalInput | ControlCoreImageResult,
  publication?: NativeRuntimePolicyPublication,
  nanoHost?: NanoHostCoreReads,
  idleCleanupNative?: CoreDb['sqlite']
): string | null {
  assertControlProductWriter(db.sqlite);
  if (input.kind === 'image-result') return applyControlCoreImageResult(db, input, nanoHost);
  if (input.kind === 'sandbox-release-refusal')
    return recordSandboxReleaseRefusal(db, input, idleCleanupNative);
  if (
    input.kind === 'containment-inspect' ||
    input.kind === 'containment-intent' ||
    input.kind === 'containment-check' ||
    input.kind === 'containment-settle' ||
    input.kind === 'containment-cancel' ||
    input.kind === 'containment-outcome' ||
    input.kind === 'containment-review' ||
    input.kind === 'containment-stop' ||
    input.kind === 'containment-stop-outcome'
  ) {
    return applyContainmentJournal(db, input, publication, nanoHost);
  }
  if (input.kind === 'image-abandon') {
    abandonCoreImageJournal(db, input.ref, input.accepted);
    return null;
  }
  const intent = decodeExecutionJournalIntent(input.intentJson);
  if (intent.execution.ref.owner.kind !== 'server')
    throw new CoreJournalRefusal('Core journal owner conflicts.');
  if (input.kind === 'idle-settle') {
    if (intent.execution.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION)
      throw new CoreJournalRefusal(
        'Core idle cleanup result does not match its admitted invocation.'
      );
    if (
      input.candidateDigest !== undefined &&
      (intent.carriage.operation !== 'workspace.collect' || input.resultFingerprint === undefined)
    )
      throw new CoreJournalRefusal('Core capture outcome has no original collection result.');
    settleCoreIdleJournal(
      db,
      intent,
      input.state,
      input.resultFingerprint,
      input.processWitness,
      input.candidateDigest
    );
    return null;
  }
  if (input.kind === 'image-intent') {
    requireCoreImageTarget(input.target, nanoHost);
    if (
      intent.execution.definitionVersion !== CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION ||
      intent.control.kind !== 'resolve-setup' ||
      intent.carriage.operation !== 'image.acquire' ||
      intent.carriage.bindingRef !== imageTargetBinding(input.target) ||
      intent.control.target?.targetId !== input.target.targetId ||
      intent.control.authorityRefs.some((value) => value.startsWith(imageTargetAuthorityPrefix))
    )
      throw new CoreJournalRefusal('Image execution provenance is unavailable.');
    if (readCoreImageAcquisitionRef(db, intent.carriage.requestId))
      throw new CoreJournalRefusal(
        'Image intent already exists; only result reconciliation is permitted.'
      );
    return encodeExecutionJournalValue(
      writeExecutionJournalIntent(
        db,
        {
          ...intent,
          control: {
            ...intent.control,
            authorityRefs: [...intent.control.authorityRefs, imageTargetAuthority(input.target)],
          },
        },
        input.processWitness
      )
    );
  }
  return reserveCoreIdleCleanupInDb(db, input, idleCleanupNative);
}

type ContainmentInput = Extract<
  ControlCoreJournalInput,
  {
    kind:
      | 'containment-inspect'
      | 'containment-intent'
      | 'containment-check'
      | 'containment-settle'
      | 'containment-cancel'
      | 'containment-outcome'
      | 'containment-review'
      | 'containment-stop'
      | 'containment-stop-outcome';
  }
>;

/** The loaded owner identity, not a packet's document or revision, admits these exact bytes. */
function applyContainmentJournal(
  db: CoreDb,
  input: ContainmentInput,
  publication: NativeRuntimePolicyPublication | undefined,
  nanoHost?: NanoHostCoreReads
): string | null {
  const document = validatePolicyDocument(input.policy);
  const revision = policyDigest(document);
  if (publication?.state !== 'active' || publication.identity?.serverRevision !== revision)
    throw new CoreJournalRefusal('Current containment Policy is unavailable.');
  if (input.kind === 'containment-stop-outcome') {
    const original = readExecutionJournalInvocation(db, input.ref);
    if (
      original.control.kind !== 'release' ||
      !original.control.attemptId ||
      original.control.definitionVersion !== 'containment'
    )
      throw new CoreJournalRefusal('Containment cleanup lost its original intent.');
    const attempt = requireSchedulerExecutionAttempt(db, original.control.attemptId);
    const anchor = requireNanoHostEvidence(
      nanoHost?.readBackendSession({ attemptId: attempt.attemptId })
    );
    if (
      !anchor ||
      attempt.operationId !== original.control.operationId ||
      original.carriage.requestId !== attempt.operationId ||
      !original.control.inputRefs.includes(`package:${attempt.inputRef}`) ||
      original.control.target?.targetId !== anchor.runtimeTargetId ||
      original.control.target?.allocationRef !== anchor.sandboxBindingRef ||
      !original.control.physicalFenceRefs.includes(anchor.originPhysicalEpoch)
    )
      throw new CoreJournalRefusal('Containment cleanup lost its original physical owner.');
    const resident = requireNanoHostEvidence(nanoHost?.readResident(anchor.sandboxBindingRef));
    const proved = !resident && anchor.state === 'cleaned' && anchor.physicalCleanedAt !== null;
    const root = readExecutionJournalRoot(db, original.ref.execution);
    if (original.state !== 'intent') {
      // Late original proof links an inspection; an immutable unknown outcome never becomes a retry.
      if (
        original.state === 'unknown' &&
        proved &&
        !db.sqlite
          .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
          .get(input.ref.execution.executionId, 'inspect-stop')
      ) {
        const rawSpan = db.sqlite
          .prepare(
            'SELECT span_json AS span FROM control_execution_steps WHERE execution_id=? AND step_id=?'
          )
          .get(input.ref.execution.executionId, input.ref.stepId) as { span: string };
        const previousSpan = decodeExecutionJournalSpan(JSON.parse(rawSpan.span));
        const span = {
          ...root.span,
          spanId: randomBytes(8).toString('hex'),
          name: 'containment cleanup inspection',
          endTimeUnixNano: null,
          links: [
            {
              traceId: previousSpan.traceId,
              spanId: previousSpan.spanId,
              flags: previousSpan.flags,
              attributes: [],
              droppedAttributesCount: 0,
            },
          ],
        };
        const inspection = writeExecutionJournalIntent(db, {
          execution: { ...root, span: { ...root.span, endTimeUnixNano: null } },
          stepId: 'inspect-stop',
          parentStepId: null,
          control: {
            ...original.control,
            kind: 'inspect-cleanup',
            invocationId: randomUUID(),
            outputRefs: [],
          },
          parent: null,
          carriage: original.carriage,
          inspectedStep: original.ref,
          span,
        });
        settleExecutionJournalStep(db, {
          ref: inspection.ref,
          expectedExecutionRevision: readExecutionJournalRoot(db, original.ref.execution).revision,
          state: 'completed',
          outputRefs: [
            `scheduler-attempt:${attempt.attemptId}`,
            `native-cleanup:${anchor.attemptId}@${anchor.physicalCleanedAt}`,
          ],
          span: {
            ...span,
            endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
            status: { code: 'OK' },
          },
          nextPhase: 'open',
          terminalCause: null,
          exclusionRefs: root.exclusionRefs,
        });
      }
      return encodeExecutionJournalValue(original);
    }
    const row = db.sqlite
      .prepare(
        'SELECT span_json AS span FROM control_execution_steps WHERE execution_id=? AND step_id=?'
      )
      .get(input.ref.execution.executionId, input.ref.stepId) as { span: string };
    settleExecutionJournalStep(db, {
      ref: original.ref,
      expectedExecutionRevision: root.revision,
      state: proved ? 'completed' : 'unknown',
      outputRefs: [
        `scheduler-attempt:${attempt.attemptId}`,
        ...(proved
          ? [`native-cleanup:${anchor.attemptId}@${anchor.physicalCleanedAt}`]
          : ['gap:physical-stop-unproved']),
      ],
      span: {
        ...decodeExecutionJournalSpan(JSON.parse(row.span)),
        endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        status: { code: proved ? 'OK' : 'ERROR' },
      },
      nextPhase: 'open',
      terminalCause: null,
      exclusionRefs: root.exclusionRefs,
    });
    if (!proved)
      recordContainmentGapInDb(
        db,
        'control-unknown',
        attempt.workspaceId,
        original.control.workId,
        original.control.actor.kind === 'system' ? original.control.actor.responsibleUserId : null
      );
    return encodeExecutionJournalValue(readExecutionJournalInvocation(db, input.ref));
  }
  if (input.kind === 'containment-review') {
    const original = readExecutionJournalInvocation(db, { ...input.ref, stepId: 'quarantine' });
    applyContainmentJournal(
      db,
      { kind: 'containment-settle', policy: document, ref: { ...input.ref, stepId: 'quarantine' } },
      publication
    );
    const review = readExecutionJournalInvocation(db, { ...input.ref, stepId: 'review' });
    if (
      review.control.kind !== 'human-wait' ||
      review.control.workId !== original.control.workId ||
      review.control.deadlineUnixNano === null
    )
      throw new CoreJournalRefusal('Containment review provenance is unavailable.');
    const actionGapId = `containment-action-gap-${policyDigest(input.ref.execution)}`;
    const completedStop = db.sqlite
      .prepare(
        "SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id IN ('stop','inspect-stop') AND state='completed' LIMIT 1"
      )
      .get(input.ref.execution.executionId);
    if (
      !completedStop &&
      (original.control.deadlineUnixNano === null ||
        original.control.deadlineUnixNano <= BigInt(Date.now()) * 1_000_000n ||
        original.clock.processWitness !== executionJournalProcessWitness()) &&
      !readContainmentEvidenceHandoff(db, actionGapId)
    ) {
      const actor = original.control.actor;
      const auditId = recordContainmentGapInDb(
        db,
        'control-unknown',
        null,
        original.control.workId,
        actor.kind === 'system' ? actor.responsibleUserId : null
      );
      appendContainmentEvidenceHandoff(db, actor, {
        id: actionGapId,
        threadId: null,
        turnId: null,
        agentSessionId: null,
        backendType: null,
        sourceKind: 'security-containment-gap',
        summary:
          'Original action authority elapsed or its clock is unavailable. Inspect original operation outcomes. Quarantine remains; this gap grants no new effect.',
        redactedEvidenceRefs: [
          { kind: 'audit', ref: original.control.workId },
          { kind: 'policy', ref: revision },
          ...(auditId ? [{ kind: 'audit' as const, ref: auditId }] : []),
        ],
        contentDigests: [],
        createdAt: new Date().toISOString(),
      });
    }
    if (
      review.state !== 'intent' ||
      review.control.deadlineUnixNano > BigInt(Date.now()) * 1_000_000n
    )
      return null;
    const evidenceId = `containment-review-${policyDigest(input.ref.execution)}`;
    if (readContainmentEvidenceHandoff(db, evidenceId)) return null;
    const author = original.control.actor;
    const id = recordContainmentGapInDb(
      db,
      'review-overdue',
      null,
      original.control.workId,
      author.kind === 'system' ? author.responsibleUserId : null
    );
    appendContainmentEvidenceHandoff(db, author, {
      id: evidenceId,
      threadId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'security-containment-review',
      summary:
        'The review deadline elapsed without recorded human review. Quarantine remains. Missing or saturated notice evidence is a gap.',
      redactedEvidenceRefs: [
        { kind: 'audit', ref: original.control.workId },
        { kind: 'policy', ref: revision },
        ...(id ? [{ kind: 'audit' as const, ref: id }] : []),
      ],
      contentDigests: [],
      createdAt: new Date().toISOString(),
    });
    return id;
  }
  if (input.kind === 'containment-outcome') {
    const original = readExecutionJournalInvocation(db, input.ref);
    if (
      original.control.definitionVersion !== 'containment' ||
      original.control.kind !== 'cancel' ||
      !original.control.attemptId ||
      original.carriage.operation !== 'turn.interrupt'
    )
      throw new CoreJournalRefusal('Containment outcome has no original cancellation.');
    const attempt = requireSchedulerExecutionAttempt(db, original.control.attemptId);
    if (
      attempt.operationId !== original.control.operationId ||
      attempt.bindingRef !== original.carriage.bindingRef ||
      !original.control.inputRefs.includes(`package:${attempt.inputRef}`)
    )
      throw new CoreJournalRefusal('Containment outcome conflicts with its original attempt.');
    // An interrupt ACK is not stop proof. The scheduler and physical owners retain all barriers.
    const root = readExecutionJournalRoot(db, original.ref.execution);
    if (original.state === 'intent') {
      const stored = db.sqlite
        .prepare(
          'SELECT span_json AS span FROM control_execution_steps WHERE execution_id=? AND step_id=?'
        )
        .get(input.ref.execution.executionId, input.ref.stepId) as { span: string };
      settleExecutionJournalStep(db, {
        ref: original.ref,
        expectedExecutionRevision: root.revision,
        state: 'unknown',
        outputRefs: [
          `scheduler-attempt:${attempt.attemptId}`,
          `phase:${attempt.phase}`,
          `disposition:${attempt.disposition}`,
          ...(attempt.outcomeRef ? [attempt.outcomeRef] : []),
          ...(attempt.fenceRef ? [attempt.fenceRef] : []),
        ],
        span: {
          ...decodeExecutionJournalSpan(JSON.parse(stored.span)),
          endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
          status: {
            code: 'ERROR',
            description: 'Original cancellation requires outcome inspection.',
          },
        },
        nextPhase: 'open',
        terminalCause: null,
        exclusionRefs: root.exclusionRefs,
      });
    }
    return encodeExecutionJournalValue(readExecutionJournalInvocation(db, input.ref));
  }
  if (input.kind === 'containment-settle') {
    const original = readExecutionJournalInvocation(db, input.ref);
    const control = original.control;
    const references = control.inputRefs.filter((ref) => ref.startsWith('lineage:'));
    if (
      control.definitionVersion !== 'containment' ||
      control.kind !== 'fence' ||
      original.carriage.operation !== 'policy.write' ||
      control.actor.kind !== 'system' ||
      control.actor.id !== 'security.containment' ||
      !control.actor.responsibleUserId ||
      references.length !== 1
    )
      throw new Error('Containment requires its original exact invocation.');
    const lineage = readCoreJournalLineage(control.inputRefs);
    const userId = control.actor.responsibleUserId;
    const expected = {
      id: original.ref.execution.executionId,
      kind: 'permission',
      state: 'active',
      effect: 'prohibit',
      grant: { kind: 'ordinary' },
      author: { kind: 'human', id: userId },
      authority: { kind: 'human', userId },
      authoredAt: new Date(Number(original.clock.admittedUnixNano / 1_000_000n)).toISOString(),
      scope: {
        subjects: [
          {
            kind: 'process',
            workspaceId: lineage.workspaceId,
            threadId: lineage.threadId,
            turnId: lineage.turnId,
          },
        ],
        actions: [...new Set([...Object.keys(PRODUCT_OPERATION_ACCESS_RIGHTS), 'tool.use'])].sort(
          compareCodeUnits
        ),
        resources: [
          {
            kind: 'container',
            container: {
              owner: { kind: 'workspace', workspaceId: lineage.workspaceId },
              kind: 'workspace',
              id: lineage.workspaceId,
            },
          },
        ],
      },
      lifetime: { anchor: { owner: { kind: 'server' }, kind: 'quarantine', id: control.workId } },
    };
    const actual = document.statements.find((statement) => statement.id === expected.id);
    if (!actual || policyDigest(actual) !== policyDigest(expected))
      throw new CoreJournalRefusal('The exact committed quarantine receipt is unavailable.');
    if (original.state === 'completed') return encodeExecutionJournalValue(original);
    if (original.state !== 'intent')
      throw new CoreJournalRefusal('An unknown original outcome requires inspection, not replay.');
    const row = db.sqlite
      .prepare(`SELECT r.revision,r.exclusion_refs_json AS exclusions,s.span_json AS span FROM control_executions r
      JOIN control_execution_steps s ON s.execution_id=r.id WHERE r.id=? AND s.step_id=?`)
      .get(input.ref.execution.executionId, input.ref.stepId) as {
      revision: number;
      exclusions: string;
      span: string;
    };
    settleExecutionJournalStep(db, {
      ref: input.ref,
      expectedExecutionRevision: row.revision,
      state: 'completed',
      outputRefs: [`policy:${revision}`, `quarantine:${expected.id}`],
      span: {
        ...decodeExecutionJournalSpan(JSON.parse(row.span)),
        endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        status: { code: 'OK' },
      },
      nextPhase: 'open',
      terminalCause: null,
      exclusionRefs: JSON.parse(row.exclusions),
    });
    return encodeExecutionJournalValue(readExecutionJournalInvocation(db, input.ref));
  }
  // Automatic containment stays disabled in v0.2.0. Acknowledge effect requests
  // without admitting them, while retaining inspection and the closeout paths above.
  if (input.kind !== 'containment-inspect') return null;

  const currentTargets = new Set<string>();
  const currentWorkspace = new Map<string, Set<string>>();
  for (const statement of document.statements) {
    if (
      statement.kind !== 'permission' ||
      statement.state !== 'active' ||
      statement.effect !== 'prohibit' ||
      statement.lifetime.anchor.kind !== 'quarantine'
    )
      continue;
    for (const subject of statement.scope.subjects) {
      if (subject.kind !== 'process')
        throw new CoreJournalRefusal('Quarantine scope is uncertain.');
      const key = policyDigest(subject);
      currentTargets.add(key);
      const targets = currentWorkspace.get(subject.workspaceId) ?? new Set<string>();
      targets.add(key);
      currentWorkspace.set(subject.workspaceId, targets);
    }
  }
  const now = new Date();
  const windowStart =
    Math.floor(now.getTime() / (SECURITY_CONTAINMENT_LIMITS.windowSeconds * 1000)) *
    SECURITY_CONTAINMENT_LIMITS.windowSeconds *
    1000;
  const admissions = db.sqlite
    .prepare(`SELECT decision_id AS id,context_summary_json AS context FROM permission_decisions
    WHERE enforcement_point='security.containment@admit' AND result='allow' AND created_at>=? ORDER BY created_at LIMIT ?`)
    .all(new Date(windowStart).toISOString(), SECURITY_CONTAINMENT_LIMITS.cumulativeServer + 1) as {
    id: string;
    context: string;
  }[];
  if (admissions.length > SECURITY_CONTAINMENT_LIMITS.cumulativeServer)
    throw new CoreJournalRefusal('Containment admission census exceeds its static bound.');
  const accepted = admissions.map((row) => {
    const context = JSON.parse(row.context) as {
      executionId: string;
      workspaceId: string;
      process: string;
      sensorAuditEventId: string;
      template: string;
    };
    if (!context.executionId || !context.workspaceId || !context.process)
      throw new CoreJournalRefusal('Containment capacity history is uncertain.');
    const original = readExecutionJournalInvocation(db, {
      execution: { owner: { kind: 'server' }, executionId: context.executionId },
      stepId: 'quarantine',
    });
    if (
      original.control.definitionVersion !== CORE_CONTAINMENT_EXECUTION_DEFINITION ||
      original.control.permittingDecisionRef !== row.id ||
      original.control.workId !== context.sensorAuditEventId ||
      !original.control.inputRefs.includes(`workspace:${context.workspaceId}`) ||
      !original.control.inputRefs.includes(`process:${context.process}`) ||
      !original.control.authorityRefs.includes(context.template)
    )
      throw new CoreJournalRefusal('Containment capacity history is uncertain.');
    return context;
  });
  const windowNano = BigInt(windowStart) * 1_000_000n;
  // Clock rows and conservative root candidates form an independent reverse census.
  // Diagnostic span time can only add a candidate/refusal; it never grants spare capacity.
  const roots = db.sqlite
    .prepare(`SELECT id FROM control_executions WHERE definition_version='containment'
    AND CAST(json_extract(span_json,'$.startTimeUnixNano') AS INTEGER)>=? LIMIT ?`)
    .all(windowNano, SECURITY_CONTAINMENT_LIMITS.cumulativeServer + 1) as { id: string }[];
  const clocks = db.sqlite
    .prepare(`SELECT execution_id AS id FROM control_execution_steps
    WHERE json_extract(control_json,'$.definitionVersion')='containment' AND json_extract(control_json,'$.kind')='fence'
    AND CAST(json_extract(invocation_json,'$.clock.admittedUnixNano') AS INTEGER)>=? LIMIT ?`)
    .all(windowNano, SECURITY_CONTAINMENT_LIMITS.cumulativeServer + 1) as { id: string }[];
  if (
    roots.length > SECURITY_CONTAINMENT_LIMITS.cumulativeServer ||
    clocks.length > SECURITY_CONTAINMENT_LIMITS.cumulativeServer
  )
    throw new CoreJournalRefusal('Containment reverse census exceeds its static bound.');
  const acceptedIds = new Set(accepted.map((entry) => entry.executionId));
  for (const id of new Set([...roots, ...clocks].map((row) => row.id))) {
    const original = readExecutionJournalInvocation(db, {
      execution: { owner: { kind: 'server' }, executionId: id },
      stepId: 'quarantine',
    });
    if (
      original.control.definitionVersion !== CORE_CONTAINMENT_EXECUTION_DEFINITION ||
      !acceptedIds.has(id)
    )
      throw new CoreJournalRefusal('An original containment admission decision is missing.');
  }
  const pending = db.sqlite
    .prepare(`SELECT execution_id AS executionId,control_json AS control FROM control_execution_steps
    WHERE json_extract(control_json,'$.definitionVersion')='containment' AND json_extract(control_json,'$.kind')='fence'
    AND state IN ('intent','unknown') LIMIT ?`)
    .all(SECURITY_CONTAINMENT_LIMITS.pendingServer + 1) as {
    executionId: string;
    control: string;
  }[];
  if (pending.length > SECURITY_CONTAINMENT_LIMITS.pendingServer)
    throw new CoreJournalRefusal('Containment pending census exceeds its static bound.');
  const pendingTargets = new Map<string, string>();
  for (const row of pending) {
    const control = JSON.parse(row.control) as { inputRefs: string[] };
    const workspace = control.inputRefs.find((ref) => ref.startsWith('workspace:'))?.slice(10);
    const process = control.inputRefs.find((ref) => ref.startsWith('process:'))?.slice(8);
    if (!workspace || !process)
      throw new CoreJournalRefusal('Containment pending scope is uncertain.');
    pendingTargets.set(process, workspace);
  }
  const { workspaceId } = input;
  const usage = {
    currentServer: currentTargets.size,
    currentWorkspace: workspaceId ? (currentWorkspace.get(workspaceId)?.size ?? 0) : 0,
    cumulativeServer: new Set(accepted.map((entry) => entry.process)).size,
    cumulativeWorkspace: workspaceId
      ? new Set(
          accepted
            .filter((entry) => entry.workspaceId === workspaceId)
            .map((entry) => entry.process)
        ).size
      : 0,
    pendingServer: pendingTargets.size,
    pendingWorkspace: workspaceId
      ? [...pendingTargets.values()].filter((id) => id === workspaceId).length
      : 0,
    windowStart: new Date(windowStart).toISOString(),
  };
  const workspaces = new Set([
    ...currentWorkspace.keys(),
    ...accepted.map((entry) => entry.workspaceId),
    ...pendingTargets.values(),
  ]);
  if (
    workspaces.size >
    SECURITY_CONTAINMENT_LIMITS.currentServer +
      SECURITY_CONTAINMENT_LIMITS.cumulativeServer +
      SECURITY_CONTAINMENT_LIMITS.pendingServer
  )
    throw new CoreJournalRefusal('Containment review scope exceeds its static bound.');
  return JSON.stringify({
    ...usage,
    workspaces: [...workspaces].sort().map((id) => ({
      workspaceId: id,
      current: currentWorkspace.get(id)?.size ?? 0,
      cumulative: new Set(
        accepted.filter((entry) => entry.workspaceId === id).map((entry) => entry.process)
      ).size,
      pending: [...pendingTargets.values()].filter((ws) => ws === id).length,
    })),
  });
}
