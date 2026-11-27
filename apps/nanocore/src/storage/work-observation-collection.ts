import { isDeepStrictEqual } from 'node:util';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error-core.js';
import type { WorkObservationRecord } from './work-observations.js';

export const WORK_OBSERVATION_TRUNCATION_FEATURE = 'openkit.work-observations.truncation.v1';
export const NATIVE_OBSERVATION_BYTES = 65_536;
export const REAP_CALL_BYTES = 61_440;
// At most 512 escaped identity characters, a digest, summary, counter and two feature IDs.
export const TURN_OBSERVATION_CONTROL_BYTES = 4096;
const reapEnvelopeBytes = NATIVE_OBSERVATION_BYTES - REAP_CALL_BYTES;

export const ObservationTruncationSchema = z
  .strictObject({
    reason: z.enum(['unresolved-call-bytes', 'row-count', 'metadata-bytes', 'body-bytes']),
    omittedCount: z.int().positive(),
    firstOmittedSequence: z.int().positive(),
    lastOmittedSequence: z.int().positive(),
    tail: z.literal('unknown'),
  })
  .refine(
    (value) => value.lastOmittedSequence - value.firstOmittedSequence + 1 === value.omittedCount,
    { message: 'Observation omission count does not match its intake range' }
  );

export type ObservationTruncation = z.infer<typeof ObservationTruncationSchema>;

export const ObservationOmissionResultSchema = z.discriminatedUnion('disposition', [
  z.strictObject({ disposition: z.literal('truncated'), truncation: ObservationTruncationSchema }),
  z.strictObject({
    disposition: z.literal('closed'),
    truncation: ObservationTruncationSchema.nullable(),
  }),
]);

/** The original crossing identity and the retained SQL boundary are private to the deciding owner. */
export const ObservationCutoffSchema = z.strictObject({
  observationId: z.string().min(1).max(512),
  workerSequence: z.int().nonnegative().optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  retainedSequence: z.int().nonnegative(),
  summary: ObservationTruncationSchema,
});

/** A position conflict is independent of whether collection has sealed. */
export const OBSERVATION_POSITION_CONFLICT = {
  operation: 'observation',
  code: 'worker_control_sequence_conflict',
  message: 'Worker observation cannot claim another event position.',
  status: 409,
} as const;

/** A legacy owner record without a position needs independent proof of the original Core event. */
export function assertWorkObservationPosition(
  retained: unknown,
  sequence: number,
  confirmedLegacyReplay: boolean | undefined
): void {
  if (retained === sequence || (retained === undefined && confirmedLegacyReplay)) return;
  const { code, message, status } = OBSERVATION_POSITION_CONFLICT;
  throw new OperationError(code, message, status);
}

export const ObservationCounterSchema = z.strictObject({
  sequence: z.int().nonnegative(),
  intake: z.int().nonnegative(),
  callBytes: z.int().nonnegative(),
  callCount: z.int().nonnegative(),
});

/** Reserve bounded observation-owner metadata while preserving the ordinary Turn byte limit. */
export function fitsTurnWithObservationControl(
  record: Record<string, unknown>,
  bytes: number
): boolean {
  const { observationCounter, observationCutoff, requiredFeatures, ...ordinary } = record;
  if (
    !ObservationCounterSchema.optional().safeParse(observationCounter).success ||
    !ObservationCutoffSchema.optional().safeParse(observationCutoff).success
  )
    return false;
  const control = JSON.stringify({ observationCounter, observationCutoff, requiredFeatures });
  return (
    Buffer.byteLength(control) <= TURN_OBSERVATION_CONTROL_BYTES &&
    Buffer.byteLength(JSON.stringify(ordinary)) <= bytes
  );
}

type Call = { corr: string; type: string; name: string | null; ts: string };

export function reapCallChange(row: WorkObservationRecord) {
  if (row.type === 'model.observed' && row.corr) {
    const request = row.payload.direction === 'request';
    if (
      request ||
      (row.parent &&
        ['done', 'error', 'interrupted', 'truncated', 'failed'].includes(String(row.payload.event)))
    ) {
      return {
        key: JSON.stringify([row.type, row.corr, request ? row.id : row.parent]),
        correlation: row.corr,
        call: request ? { corr: row.corr, type: row.type, name: null, ts: row.ts } : null,
      };
    }
  }
  if (row.type !== 'runtime.observed') return;
  const { fact } = WorkerObservationDataSchema.parse(row.payload);
  if (fact.kind !== 'tool' || !fact.callRef) return;
  const corr = row.corr ?? fact.callRef;
  const key = JSON.stringify([row.type, corr]);
  if (['completed', 'failed', 'interrupted', 'closed'].includes(fact.phase ?? ''))
    return { key, correlation: corr, call: null };
  if (['started', 'running', 'updated'].includes(fact.phase ?? ''))
    return {
      key,
      correlation: corr,
      call: { corr, type: row.type, name: fact.toolName ?? null, ts: row.ts },
    };
}

export function mergeReapCall(previous: Call | undefined, next: Call | null): Call | null {
  return previous && next ? { ...next, name: previous.name ?? next.name, ts: previous.ts } : next;
}

export function serializedCallBytes(call: Call | null | undefined): number {
  return call ? Buffer.byteLength(JSON.stringify(call)) : 0;
}

/** Check both budgets with actual Turn identity and prospective timestamp. The envelope reserves
 * the largest owner vocabulary and all sequence/count widths even before a cutoff exists. */
export function fitsReap(
  turnId: string,
  lastObservedTs: string,
  callBytes: number,
  callCount: number
): boolean {
  const arrayBytes = 2 + callBytes + Math.max(0, callCount - 1);
  if (arrayBytes > REAP_CALL_BYTES) return false;
  return (
    Buffer.byteLength(
      JSON.stringify({
        id: `turn.reap:${turnId}`,
        type: 'turn.reap',
        v: 1,
        seq: Number.MAX_SAFE_INTEGER,
        turnId,
        ts: '9999-12-31T23:59:59.999Z',
        obs: 'nanocore',
        ret: 'turn-evidence',
        payload: {
          reason: 'observation_limit_reached',
          lastObservedTs,
          unresolvedCalls: [],
          inferredBy: 'pending-request-publication',
          truncation: {
            reason: 'unresolved-call-bytes',
            omittedCount: Number.MAX_SAFE_INTEGER,
            firstOmittedSequence: Number.MAX_SAFE_INTEGER,
            lastOmittedSequence: Number.MAX_SAFE_INTEGER,
            tail: 'unknown',
          },
        },
      })
    ) -
      2 <=
    reapEnvelopeBytes
  );
}

export function omission(position: number): ObservationTruncation {
  return {
    reason: 'unresolved-call-bytes',
    omittedCount: 1,
    firstOmittedSequence: position,
    lastOmittedSequence: position,
    tail: 'unknown',
  };
}

/** Prove the declared logical prefix even when old physical rows include the omitted suffix. */
export function assertReapObservationPrefix(
  rows: Iterable<WorkObservationRecord>,
  summary: ObservationTruncation | undefined,
  reap: WorkObservationRecord | undefined,
  live: boolean | undefined,
  retainedSequence?: number
): void {
  if (live && reap) throw new Error('A live Turn cannot carry a terminal observation reap');
  if (!summary) return;
  if (!live && !reap) throw new Error('A terminal Turn lacks its required observation reap');
  let position = 0;
  let sequence = 0;
  let callBytes = 0;
  let prefixTimestamp: string | null = null;
  let matchingBoundaryTimestamp = reap?.payload.lastObservedTs === null;
  const calls = new Map<string, Call>();
  const retained = summary.firstOmittedSequence - 1;
  for (const row of rows) {
    sequence += 1;
    if (row.seq !== sequence) throw new Error('Invalid retained observation truncation sequence');
    if (row.type === 'turn.reap') continue;
    if (row.type !== 'content.published') {
      position++;
      const inPrefix = position <= retained;
      if (retainedSequence !== undefined) {
        const retainedInSql = row.seq <= retainedSequence;
        if (retainedInSql !== inPrefix)
          throw new Error('Invalid retained observation truncation boundary');
      }
      if (
        !inPrefix &&
        (position !== summary.firstOmittedSequence || summary.reason !== 'unresolved-call-bytes')
      )
        continue;
      const change = reapCallChange(row);
      const previous = change ? calls.get(change.key) : undefined;
      const next = change ? mergeReapCall(previous, change.call) : null;
      const nextBytes = callBytes + serializedCallBytes(next) - serializedCallBytes(previous);
      const nextCount = calls.size - Number(previous !== undefined) + Number(next !== null);
      if (!inPrefix) {
        if (fitsReap(row.turnId, row.ts, nextBytes, nextCount))
          throw new Error('The first historically omitted observation fits the reap bound');
        continue;
      }
      if (!fitsReap(row.turnId, row.ts, nextBytes, nextCount))
        throw new Error('Retained observation prefix exceeds its reap bound');
      if (change) {
        if (next) calls.set(change.key, next);
        else calls.delete(change.key);
        callBytes = nextBytes;
      }
      // Only the last primary row and its following companions can define the prefix clock.
      matchingBoundaryTimestamp = false;
    }
    if (position <= retained) {
      if (retainedSequence === undefined || row.seq <= retainedSequence) prefixTimestamp = row.ts;
      matchingBoundaryTimestamp ||= row.ts === reap?.payload.lastObservedTs;
    }
  }
  const historical = position === summary.lastOmittedSequence;
  if (
    (position !== retained && !historical) ||
    (retainedSequence !== undefined && retainedSequence > sequence)
  )
    throw new Error('Invalid retained observation truncation prefix');
  if (!reap) return;
  if (
    !isDeepStrictEqual(reap.payload.unresolvedCalls, [...calls.values()]) ||
    (retainedSequence !== undefined || historical
      ? reap.payload.lastObservedTs !== prefixTimestamp
      : !matchingBoundaryTimestamp)
  )
    throw new Error('Reap contradicts its retained observation prefix');
}
