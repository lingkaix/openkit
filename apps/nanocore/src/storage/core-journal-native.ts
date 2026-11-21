import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ServerEvidenceBundleRecord,
  ServerEvidenceBundleRecordSchema,
} from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import {
  type ActorRef,
  compareCodeUnits,
  deriveEntityId,
  type KernelAuditEvent,
} from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { auditEventFromRow, recordServerAuditEvent } from '../audit-events.js';
import { validatePolicyDocument } from '../policy/statements.js';
import { abandonCoreImageJournal, settleCoreIdleJournal } from '../runtime/core-journal-records.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import {
  CORE_CONTAINMENT_EXECUTION_DEFINITION,
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  decodeExecutionJournalIntent,
  decodeExecutionJournalSpan,
  encodeExecutionJournalValue,
  executionJournalProcessWitness,
  readExecutionJournalInvocation,
  readExecutionJournalLinkedInspections,
  readExecutionJournalRoot,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import type { ExecutionStepRef } from '../runtime/execution-step-journal.js';
import type { NanoHostCoreReads } from './control-kernel-port.js';
import { commandInputHash } from './control-store-input.js';
import { assertControlProductWriter } from './control-store-products.js';
import {
  type ControlCoreImageResult,
  type ControlCoreJournalInput,
  CoreJournalRefusal,
  readCoreJournalLineage,
  SECURITY_CONTAINMENT_LIMITS,
} from './core-journal-codecs.js';
import type { CoreDb } from './db.js';
import type { NativeRuntimePolicyPublication } from './runtime-policy-publication.js';
import { recordContainmentGapInDb } from './security-canary-audit-native.js';
import type { StorageResult } from './storage-owner.js';

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

/** Decides one original Core journal tuple against current rows inside its savepoint and FULL commit. */
export function applyControlCoreJournal(
  db: CoreDb,
  input: ControlCoreJournalInput | ControlCoreImageResult,
  publication?: NativeRuntimePolicyPublication,
  nanoHost?: NanoHostCoreReads
): string | null {
  assertControlProductWriter(db.sqlite);
  if (input.kind === 'image-result') return applyControlCoreImageResult(db, input, nanoHost);
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
  // New idle effects require a covering Core reservation of the physical scope.
  throw new CoreJournalRefusal('Idle cleanup requires an original Core scope reservation.');
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
