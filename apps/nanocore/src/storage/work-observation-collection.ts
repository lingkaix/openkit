import { isDeepStrictEqual } from 'node:util';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error-core.js';
import type { ControlProductOwner } from './control-store-product-records.js';
import type { WorkObservationDraft, WorkObservationRecord } from './work-observations.js';

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

const MAX_OBSERVATION_UNITS = 4_096;
const MAX_OBSERVATION_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVATION_BODY_BYTES = 64 * 1024 * 1024;

const ObservationBudgetSchema = z.strictObject({
  units: z.int().nonnegative(),
  metadataBytes: z.int().nonnegative(),
  bodyBytes: z.int().nonnegative(),
});
type ObservationBudget = z.infer<typeof ObservationBudgetSchema>;

export const EMPTY_OBSERVATION_BUDGET: ObservationBudget = {
  units: 0,
  metadataBytes: 0,
  bodyBytes: 0,
};

export const ObservationCounterSchema = z.strictObject({
  sequence: z.int().nonnegative(),
  intake: z.int().nonnegative(),
  callBytes: z.int().nonnegative(),
  callCount: z.int().nonnegative(),
  budget: ObservationBudgetSchema.optional(),
  rawProvenance: z
    .strictObject({
      id: z.string().min(1).max(512),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.int().nonnegative(),
    })
    .optional(),
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

const RetainedBodySchema = z.object({
  id: z.string(),
  bytes: z.int().nonnegative(),
  mediaType: z.string(),
  boundary: z.string(),
  sha256: z.string(),
  bundleId: z.string(),
});

/** One model declaration reserves a slot for either its publication or its known failure. */
export function reservedModelGap(
  parent: WorkObservationRecord,
  reason: unknown
): WorkObservationDraft {
  return {
    id: `${parent.id}:publication`,
    parent: parent.id,
    type: 'model.capture-gap',
    ts: parent.ts,
    obs: parent.obs,
    ...(parent.corr === undefined ? {} : { corr: parent.corr }),
    ...(parent.refs === undefined ? {} : { refs: parent.refs }),
    ret: 'turn-evidence',
    payload: {
      direction: parent.payload.direction,
      event: parent.payload.event,
      attempt: parent.payload.attempt,
      content: { state: 'unavailable', reason },
    },
  };
}

export function isObservationCompanion(row: WorkObservationRecord): boolean {
  return (
    row.type === 'content.published' ||
    (row.type === 'model.capture-gap' &&
      row.parent !== undefined &&
      row.id === `${row.parent}:publication`)
  );
}

/** Counts the original declaration once, including the largest possible companion and its upload slots. */
export function chargeObservation(
  budget: ObservationBudget,
  row: WorkObservationRecord,
  bytes = Buffer.byteLength(JSON.stringify(row)),
  owner?: ControlProductOwner
): ObservationBudget {
  let chunks = 0;
  let bodies: z.infer<typeof RetainedBodySchema>[] = [];
  if (row.type === 'model.observed' && row.payload.bodies !== undefined)
    bodies = z.array(RetainedBodySchema).parse(row.payload.bodies);
  if (row.type === 'runtime.observed') {
    const content = WorkerObservationDataSchema.parse(row.payload).content;
    if (content.state === 'expected') {
      chunks = content.chunkCount;
      bodies = [
        {
          id: 'content',
          bytes: content.bytes,
          mediaType: content.mediaType,
          boundary: content.boundary,
          sha256: content.sha256.slice('sha256:'.length),
          bundleId: `evb_work_${'0'.repeat(64)}`,
        },
      ];
    }
  }
  // A future companion can land at any ordinary position. Reserve the widest sequence and scope
  // spelling that it can use. Native callers supply the exact owner.
  let publicationBytes = bodies.length
    ? Buffer.byteLength(
        JSON.stringify({
          v: 1,
          id: `${row.id}:publication`,
          type: 'content.published',
          turnId: row.turnId,
          seq: MAX_OBSERVATION_UNITS,
          ts: row.ts,
          obs: row.obs,
          parent: row.id,
          ret: 'turn-evidence',
          refs: bodies.map((body) => ({
            kind: 'evidence-bundle',
            scope:
              owner?.kind === 'server'
                ? { owner: 'server', pathClass: 'backend' }
                : {
                    workspaceId: owner?.workspaceId ?? 'ws_00000000-0000-7000-8000-000000000001',
                    pathClass: 'backend',
                  },
            locator: body.bundleId,
            digest: body.sha256,
            edge: 'publication',
          })),
          payload: { bodies },
        })
      )
    : 0;
  if (bodies.length && row.type === 'model.observed')
    publicationBytes = Math.max(
      publicationBytes,
      Buffer.byteLength(
        JSON.stringify({
          ...reservedModelGap(row, 'credential-excluded'),
          v: 1,
          turnId: row.turnId,
          seq: MAX_OBSERVATION_UNITS,
        })
      )
    );
  if (publicationBytes > NATIVE_OBSERVATION_BYTES)
    throw new Error('Observation publication metadata exceeds the native bound');
  return {
    units: budget.units + 1 + chunks + Number(bodies.length > 0),
    metadataBytes: budget.metadataBytes + bytes + publicationBytes,
    bodyBytes: bodies.reduce((total, body) => total + body.bytes, budget.bodyBytes),
  };
}

export function observationBudgetLimit(
  budget: ObservationBudget
): ObservationTruncation['reason'] | undefined {
  if (budget.units > MAX_OBSERVATION_UNITS) return 'row-count';
  if (budget.metadataBytes > MAX_OBSERVATION_METADATA_BYTES) return 'metadata-bytes';
  if (budget.bodyBytes > MAX_OBSERVATION_BODY_BYTES) return 'body-bytes';
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

export function omission(
  position: number,
  reason: ObservationTruncation['reason'] = 'unresolved-call-bytes'
): ObservationTruncation {
  return {
    reason,
    omittedCount: 1,
    firstOmittedSequence: position,
    lastOmittedSequence: position,
    tail: 'unknown',
  };
}

/** Prove the declared logical prefix even when old physical rows include the omitted suffix. */
export function assertReapObservationPrefix(
  rows: Iterable<{ record: WorkObservationRecord; bytes?: number }>,
  summary: ObservationTruncation | undefined,
  reap: WorkObservationRecord | undefined,
  live: boolean | undefined,
  native?: { readonly retainedSequence?: number | undefined; readonly owner: ControlProductOwner }
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
  let budget = EMPTY_OBSERVATION_BUDGET;
  const retainedSequence = native?.retainedSequence;
  for (const { record: row, bytes } of rows) {
    sequence += 1;
    if (row.seq !== sequence) throw new Error('Invalid retained observation truncation sequence');
    if (row.type === 'turn.reap') continue;
    if (!isObservationCompanion(row)) {
      position++;
      const inPrefix = position <= retained;
      if (retainedSequence !== undefined) {
        const retainedInSql = row.seq <= retainedSequence;
        if (retainedInSql !== inPrefix)
          throw new Error('Invalid retained observation truncation boundary');
      }
      if (!inPrefix && position !== summary.firstOmittedSequence) continue;
      if (summary.reason !== 'unresolved-call-bytes') {
        budget = chargeObservation(budget, row, bytes, native?.owner);
        const reason = observationBudgetLimit(budget);
        // Portable rows omit private native headers. Only the native reader can prove the
        // original UTF-8 crossing when older retained rows include an omitted suffix.
        const measuredCrossing = summary.reason !== 'metadata-bytes' || bytes !== undefined;
        if ((!inPrefix && measuredCrossing && reason !== summary.reason) || (inPrefix && reason))
          throw new Error('Invalid retained observation budget boundary');
      }
      const change = reapCallChange(row);
      const previous = change ? calls.get(change.key) : undefined;
      const next = change ? mergeReapCall(previous, change.call) : null;
      const nextBytes = callBytes + serializedCallBytes(next) - serializedCallBytes(previous);
      const nextCount = calls.size - Number(previous !== undefined) + Number(next !== null);
      if (!inPrefix) {
        if (
          summary.reason === 'unresolved-call-bytes' &&
          fitsReap(row.turnId, row.ts, nextBytes, nextCount)
        )
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
