import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonText } from '@openkit/protocol';
import { z } from 'zod';
import { commandInputHash } from '../storage/control-store-input.js';
import {
  type ControlCoreIdleHarnessConsumptionInput,
  type CoreIdleHarnessConsumptionEvidence,
  CoreJournalRefusal,
} from '../storage/core-journal-codecs.js';
import type { CoreDb } from '../storage/db.js';
import {
  CORE_HARNESS_CONSUME_EXECUTION_DEFINITION,
  type CORE_WORKSPACE_RECOVERY_EXECUTION_DEFINITION,
  readExecutionJournalInvocation,
  readExecutionJournalLinkedInspections,
  readExecutionJournalRoot,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import type {
  ExecutionInvocation,
  ExecutionInvocationCarriage,
  ExecutionJournalExecution,
  ExecutionJournalIntent,
  ExecutionJournalSpan,
  ExecutionStepRef,
} from './execution-step-journal.js';

/** Builds only local Core acknowledgement/recovery decisions, never contact or retry authority. */
export function localCoreJournalIntent(input: {
  definitionVersion:
    | typeof CORE_HARNESS_CONSUME_EXECUTION_DEFINITION
    | typeof CORE_WORKSPACE_RECOVERY_EXECUTION_DEFINITION;
  executionId: string;
  stepId: string;
  workId: string;
  fingerprint: string;
  kind: 'admit' | 'consume-receipt' | 'inspect-cleanup';
  actorId: string;
  inputRefs: readonly string[];
  authorityRefs: readonly string[];
  carriage: ExecutionInvocationCarriage;
  timestamp: string;
  root?: ExecutionJournalExecution;
  inspected?: { ref: ExecutionStepRef; span: ExecutionJournalSpan };
}): ExecutionJournalIntent {
  const time = BigInt(Date.parse(input.timestamp)) * 1_000_000n;
  const digest = createHash('sha256').update(input.executionId).digest('hex');
  const rootSpan: ExecutionJournalIntent['span'] = input.root
    ? { ...input.root.span, endTimeUnixNano: null }
    : {
        traceId: digest.slice(0, 32),
        spanId: digest.slice(32, 48),
        flags: 0,
        name: input.definitionVersion,
        kind: 'INTERNAL',
        startTimeUnixNano: time,
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
  return {
    execution: {
      ref: { owner: { kind: 'server' }, executionId: input.executionId },
      definitionVersion: input.definitionVersion,
      workId: input.workId,
      fingerprint: input.root?.fingerprint ?? input.fingerprint,
      exclusionRefs: [],
      span: rootSpan,
    },
    stepId: input.stepId,
    parentStepId: null,
    parent: null,
    inspectedStep: input.inspected?.ref ?? null,
    control: {
      definitionVersion: input.definitionVersion,
      kind: input.kind,
      target: null,
      workId: input.workId,
      operationId: input.carriage.requestId,
      attemptId: null,
      invocationId: `${input.executionId}:${input.stepId}`,
      actor: { kind: 'system', id: input.actorId, responsibleUserId: null },
      inputRefs: input.inputRefs,
      outputRefs: [],
      fingerprint: input.fingerprint,
      permittingDecisionRef: null,
      authorityRefs: input.authorityRefs,
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    carriage: input.carriage,
    span: {
      ...rootSpan,
      spanId: createHash('sha256')
        .update(`${input.executionId}:${input.stepId}`)
        .digest('hex')
        .slice(0, 16),
      parentSpanId: rootSpan.spanId,
      name: input.kind,
      startTimeUnixNano: time < rootSpan.startTimeUnixNano ? rootSpan.startTimeUnixNano : time,
      links: input.inspected
        ? [
            {
              traceId: input.inspected.span.traceId,
              spanId: input.inspected.span.spanId,
              flags: input.inspected.span.flags,
              attributes: [],
              droppedAttributesCount: 0,
            },
          ]
        : [],
    },
  };
}

/** Exact immutable receiver result tuple; the consumer remains a journal authority reference. */
interface HarnessConsumptionKey {
  readonly harnessBindingRef: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly resultFingerprint: string;
}

function coreConsumptionExecutionId({
  harnessBindingRef,
  operationId,
  sequence,
}: HarnessConsumptionKey): string {
  return `consume-receipt:${commandInputHash([harnessBindingRef, operationId, sequence])}`;
}

/** Reads validated Core progress without changing the original receiver result. */
export function inspectCoreHarnessConsumption(db: CoreDb, key: HarnessConsumptionKey) {
  const executionId = coreConsumptionExecutionId(key);
  if (!db.sqlite.prepare('SELECT 1 FROM control_executions WHERE id = ?').get(executionId))
    return null;
  const execution = { owner: { kind: 'server' as const }, executionId };
  const root = readExecutionJournalRoot(db, execution);
  const step = readExecutionJournalInvocation(db, { execution, stepId: 'consume' });
  const consumer = step.control.authorityRefs[0];
  const acknowledged = root.span.endTimeUnixNano;
  if (
    !consumer ||
    acknowledged === null ||
    acknowledged % 1_000_000n !== 0n ||
    root.definitionVersion !== CORE_HARNESS_CONSUME_EXECUTION_DEFINITION ||
    root.workId !== key.operationId ||
    root.phase !== 'closed' ||
    root.openSteps.length !== 0 ||
    root.fingerprint !== commandInputHash({ ...key, consumer }) ||
    step.state !== 'completed' ||
    step.control.kind !== 'consume-receipt' ||
    step.control.fingerprint !== root.fingerprint ||
    !isDeepStrictEqual(step.control.authorityRefs, [consumer]) ||
    !isDeepStrictEqual(step.control.inputRefs, [key.resultFingerprint]) ||
    !isDeepStrictEqual(step.control.outputRefs, [key.resultFingerprint]) ||
    !isDeepStrictEqual(step.carriage, {
      operation: 'harness.consume',
      requestId: key.operationId,
      sequence: key.sequence,
      bindingRef: key.harnessBindingRef,
    })
  )
    throw new Error('NanoHost Harness retained consumer acknowledgement conflicts.');
  return {
    consumer,
    acknowledgedAt: new Date(Number(acknowledged / 1_000_000n)).toISOString(),
  };
}

export function readCoreHarnessConsumption(db: CoreDb, key: HarnessConsumptionKey): string | null {
  return inspectCoreHarnessConsumption(db, key)?.consumer ?? null;
}

/** Commits local consumption inside the native Harness transaction, after its exact authority checks. */
export function recordCoreHarnessConsumption(
  db: CoreDb,
  key: HarnessConsumptionKey,
  consumer: string,
  timestamp: string
): void {
  const previous = readCoreHarnessConsumption(db, key);
  if (previous !== null) {
    if (previous !== consumer)
      throw new Error('NanoHost Harness consumer acknowledgement replay conflicts.');
    return;
  }
  const fingerprint = commandInputHash({ ...key, consumer });
  const intent = localCoreJournalIntent({
    definitionVersion: CORE_HARNESS_CONSUME_EXECUTION_DEFINITION,
    executionId: coreConsumptionExecutionId(key),
    stepId: 'consume',
    workId: key.operationId,
    fingerprint,
    kind: 'consume-receipt',
    actorId: key.harnessBindingRef,
    inputRefs: [key.resultFingerprint],
    authorityRefs: [consumer],
    carriage: {
      operation: 'harness.consume',
      requestId: key.operationId,
      sequence: key.sequence,
      bindingRef: key.harnessBindingRef,
    },
    timestamp,
  });
  const execution = intent.execution.ref;
  const time = intent.span.startTimeUnixNano;
  writeExecutionJournalIntent(db, intent);
  settleExecutionJournalStep(db, {
    ref: { execution, stepId: intent.stepId },
    expectedExecutionRevision: readExecutionJournalRoot(db, execution).revision,
    state: 'completed',
    outputRefs: [key.resultFingerprint],
    span: { ...intent.span, endTimeUnixNano: time, status: { code: 'OK' } },
    nextPhase: 'closed',
    terminalCause: null,
    exclusionRefs: [],
  });
}

/** Acknowledges the exact idle result on Core while the Native predecessor remains pinned. */
export function recordCoreIdleHarnessConsumptionInDb(
  db: CoreDb,
  input: ControlCoreIdleHarnessConsumptionInput,
  readOriginal: (
    expected: CoreIdleHarnessConsumptionEvidence
  ) => CoreIdleHarnessConsumptionEvidence | null
) {
  if (!db.sqlite.inTransaction || db.sqlite.readonly)
    throw new CoreJournalRefusal('Idle Harness consumption requires the Core writer transaction.');
  const { key, consumer, observedAt } = input;
  const occupied = db.sqlite
    .prepare(`SELECT 1 FROM scheduler_execution_attempts
      WHERE agent_session_id=? AND (schema_version IS NOT 1 OR phase IS NOT 'closed') LIMIT 1`)
    .get(consumer.agentSessionId);
  if (occupied) throw new CoreJournalRefusal('Idle Harness consumption has a live Core attempt.');
  const expected = { key, consumer };
  if (!isDeepStrictEqual(readOriginal(expected), expected))
    throw new CoreJournalRefusal('Idle Harness consumption has no exact Native predecessor.');

  const original = inspectCoreHarnessConsumption(db, key);
  const serialized = canonicalJsonText(consumer);
  if (original) {
    if (original.consumer !== serialized)
      throw new CoreJournalRefusal('Idle Harness consumer acknowledgement replay conflicts.');
    return { state: 'inspect-original', receipt: { key, ...original } } as const;
  }
  const now = new Date(observedAt ?? Date.now()).toISOString();
  recordCoreHarnessConsumption(db, key, serialized, now);
  return {
    state: 'applied',
    receipt: { key, consumer: serialized, acknowledgedAt: now },
  } as const;
}

/** Proves the exact linked consumption of the original physical effect result. */
export function hasCoreIdleCleanupConsumption(db: CoreDb, original: ExecutionInvocation): boolean {
  if (
    original.control.outputRefs.length !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(original.control.outputRefs[0]!)
  )
    return false;
  return readExecutionJournalLinkedInspections(db, original.ref).some(
    ({ inspection }) =>
      inspection.state === 'completed' &&
      inspection.control.kind === 'consume-receipt' &&
      inspection.ref.execution.executionId === original.ref.execution.executionId &&
      inspection.ref.stepId === `${original.ref.stepId}:consume` &&
      inspection.control.operationId === original.carriage.requestId &&
      isDeepStrictEqual(inspection.control.inputRefs, original.control.outputRefs) &&
      isDeepStrictEqual(inspection.control.outputRefs, original.control.outputRefs)
  );
}

/** Settles the existing complete idle outcome plus linked consumption tuple on the deciding Core connection. */
export function settleCoreIdleJournal(
  db: CoreDb,
  intent: ExecutionJournalIntent,
  state: 'completed' | 'failed' | 'unknown',
  resultFingerprint: string | undefined,
  processWitness: string,
  candidateDigest?: string
): void {
  const resultRefs =
    resultFingerprint === undefined
      ? []
      : [resultFingerprint, ...(candidateDigest === undefined ? [] : [candidateDigest])];
  const ref = { execution: intent.execution.ref, stepId: intent.stepId };
  const original = readExecutionJournalInvocation(db, ref);
  if (
    !isDeepStrictEqual({ ...original.control, outputRefs: [] }, intent.control) ||
    !isDeepStrictEqual(original.carriage, intent.carriage)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup result does not match its admitted invocation.'
    );
  // A transport unknown without a receiver result remains immutable. A later real result
  // adds only linked consumption evidence and never releases that original exclusion.
  const lateResult =
    original.state === 'unknown' &&
    original.control.outputRefs.length === 0 &&
    resultFingerprint !== undefined;
  const consumeControl =
    resultFingerprint === undefined
      ? undefined
      : {
          ...intent.control,
          kind: 'consume-receipt' as const,
          target: null,
          invocationId: `${intent.control.invocationId}:consume`,
          inputRefs: [resultFingerprint],
          outputRefs: [],
          fingerprint: commandInputHash({
            operation: intent.carriage.requestId,
            resultFingerprint,
          }),
          deadlineUnixNano: null,
        };
  if (original.state !== 'intent') {
    if (
      !lateResult &&
      (original.state !== state || !isDeepStrictEqual(original.control.outputRefs, resultRefs))
    )
      throw new CoreJournalRefusal('Core idle cleanup result replay conflicts.');
    if (resultFingerprint === undefined) return;
    const present = db.sqlite
      .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
      .get(ref.execution.executionId, `${intent.stepId}:consume`);
    if (present) {
      const consumed = readExecutionJournalInvocation(db, {
        execution: ref.execution,
        stepId: `${intent.stepId}:consume`,
      });
      const linked = readExecutionJournalLinkedInspections(db, ref);
      if (
        consumed.state !== 'completed' ||
        !isDeepStrictEqual({ ...consumed.control, outputRefs: [] }, consumeControl) ||
        !isDeepStrictEqual(consumed.carriage, intent.carriage) ||
        !isDeepStrictEqual(consumed.control.outputRefs, [resultFingerprint]) ||
        !linked.some((entry) => entry.inspection.ref.stepId === consumed.ref.stepId)
      )
        throw new CoreJournalRefusal('Core idle cleanup retained consumption conflicts.');
      return;
    }
    if (!lateResult)
      throw new CoreJournalRefusal('Core idle cleanup atomic consumption is missing.');
  }
  const now = BigInt(Date.now()) * 1_000_000n;
  const endedAt = now < intent.span.startTimeUnixNano ? intent.span.startTimeUnixNano : now;
  const status = { code: state === 'completed' ? ('OK' as const) : ('ERROR' as const) };
  const consume: ExecutionJournalIntent | undefined =
    consumeControl === undefined
      ? undefined
      : {
          ...intent,
          stepId: `${intent.stepId}:consume`,
          parentStepId: null,
          parent: null,
          inspectedStep: ref,
          control: consumeControl,
          span: {
            ...intent.span,
            spanId: createHash('sha256')
              .update(`${intent.span.spanId}:consume`)
              .digest('hex')
              .slice(0, 16),
            parentSpanId: intent.execution.span.spanId,
            name: 'nanohost.idle-cleanup.consume-receipt',
            startTimeUnixNano: endedAt,
            links: [
              {
                traceId: intent.span.traceId,
                spanId: intent.span.spanId,
                flags: intent.span.flags,
                attributes: [],
                droppedAttributesCount: 0,
              },
            ],
          },
        };
  {
    const coreDb = db;
    let root = readExecutionJournalRoot(coreDb, ref.execution);
    if (!lateResult) {
      settleExecutionJournalStep(coreDb, {
        ref,
        expectedExecutionRevision: root.revision,
        state,
        outputRefs: resultRefs,
        span: { ...intent.span, endTimeUnixNano: endedAt, status },
        nextPhase: 'closing',
        terminalCause: state === 'completed' ? null : `idle-${state}`,
        exclusionRefs: root.exclusionRefs,
      });
    }
    if (consume !== undefined) {
      writeExecutionJournalIntent(coreDb, consume, processWitness);
      root = readExecutionJournalRoot(coreDb, ref.execution);
      settleExecutionJournalStep(coreDb, {
        ref: { execution: ref.execution, stepId: consume.stepId },
        expectedExecutionRevision: root.revision,
        state: 'completed',
        outputRefs: [resultFingerprint!],
        span: { ...consume.span, endTimeUnixNano: endedAt, status: { code: 'OK' } },
        nextPhase: state === 'completed' && !lateResult ? 'closed' : 'closing',
        terminalCause: state === 'completed' && !lateResult ? null : root.terminalCause,
        exclusionRefs: state === 'completed' && !lateResult ? [] : root.exclusionRefs,
      });
    }
  }
}
/** Ends an original image invocation without claiming a remote stop or release. */
export function abandonCoreImageJournal(
  db: CoreDb,
  ref: ExecutionStepRef,
  accepted: boolean
): void {
  const row = db.sqlite
    .prepare(`SELECT s.state, s.span_json, r.revision FROM control_execution_steps s
    JOIN control_executions r ON r.id = s.execution_id WHERE s.execution_id = ? AND s.step_id = ?`)
    .get(ref.execution.executionId, ref.stepId) as
    | { state: string; span_json: string; revision: number }
    | undefined;
  if (!row) throw new CoreJournalRefusal('Image invocation authority is missing.');
  const invocation = readExecutionJournalInvocation(db, ref);
  if (
    invocation.control.definitionVersion !== 'core-image-acquire/v1' ||
    invocation.carriage.operation !== 'image.acquire'
  )
    throw new CoreJournalRefusal('Image invocation authority is missing.');
  if (
    z.enum(['intent', 'completed', 'failed', 'unknown', 'cancelled']).parse(row.state) !== 'intent'
  )
    return;
  const span = JSON.parse(row.span_json);
  const now = BigInt(Date.now()) * 1_000_000n;
  const start = BigInt(span.startTimeUnixNano);
  settleExecutionJournalStep(db, {
    ref,
    expectedExecutionRevision: row.revision,
    state: accepted ? 'unknown' : 'cancelled',
    outputRefs: [],
    span: { ...span, endTimeUnixNano: now < start ? start : now, status: { code: 'ERROR' } },
    nextPhase: accepted ? 'closing' : 'closed',
    terminalCause: accepted
      ? 'Image acquisition outcome is unknown.'
      : 'Image acquisition was not delivered.',
    exclusionRefs: accepted
      ? [`native-image-invocation/v1:${ref.execution.executionId}:${ref.stepId}`]
      : [],
  });
}
