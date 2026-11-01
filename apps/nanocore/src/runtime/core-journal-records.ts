import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { commandInputHash } from '../storage/control-store-input.js';
import { CoreJournalRefusal } from '../storage/core-journal-codecs.js';
import type { CoreDb } from '../storage/db.js';
import {
  readExecutionJournalInvocation,
  readExecutionJournalLinkedInspections,
  readExecutionJournalRoot,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import type { ExecutionJournalIntent, ExecutionStepRef } from './execution-step-journal.js';
/** Settles the existing complete idle outcome plus linked consumption tuple on the deciding Core connection. */
export function settleCoreIdleJournal(
  db: CoreDb,
  intent: ExecutionJournalIntent,
  state: 'completed' | 'failed' | 'unknown',
  resultFingerprint: string | undefined,
  processWitness: string
): void {
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
      (original.state !== state ||
        !isDeepStrictEqual(
          original.control.outputRefs,
          resultFingerprint === undefined ? [] : [resultFingerprint]
        ))
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
        outputRefs: resultFingerprint === undefined ? [] : [resultFingerprint],
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
