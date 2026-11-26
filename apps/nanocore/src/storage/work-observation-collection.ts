import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import type { WorkObservationRecord } from './work-observations.js';

export const WORK_OBSERVATION_TRUNCATION_FEATURE = 'openkit.work-observations.truncation.v1';
export const NATIVE_OBSERVATION_BYTES = 65_536;
export const REAP_CALL_BYTES = 61_440;
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
  observationId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  retainedSequence: z.int().nonnegative(),
  summary: ObservationTruncationSchema,
});

export const ObservationCounterSchema = z.strictObject({
  sequence: z.int().nonnegative(),
  intake: z.int().nonnegative(),
  callBytes: z.int().nonnegative(),
  callCount: z.int().nonnegative(),
});

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
