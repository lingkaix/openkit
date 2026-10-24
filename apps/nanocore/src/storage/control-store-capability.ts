import {
  CapabilityCallIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  invalidateWorkerRawOutputProof,
  observeWorkerRawOutput,
  settleWorkerRawOutput,
  WorkerRawOutputAuthorityError,
} from '../runtime/worker-raw-output.js';
import type { WorkspaceDb } from './db.js';

const scope = {
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  callId: CapabilityCallIdSchema,
};
const ordinal = z.number().int().nonnegative().safe();
const position = z
  .object({
    attemptId: z.string().min(1).max(4096),
    partId: ordinal,
    field: z.enum(['text', 'tool-arguments', 'reasoning']),
    fromBytePosition: ordinal,
    bytePosition: ordinal,
  })
  .strict()
  .refine((value) => value.bytePosition >= value.fromBytePosition, {
    message: 'Raw output position precedes its source prefix.',
  });

/** Dormant native raw commands; call admission alone can initialize fresh proof. */
export const ControlCapabilityCommandInputSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('raw-observe'), ...scope, positions: z.array(position).min(1) })
    .strict(),
  z.object({ kind: z.literal('raw-settle'), ...scope, complete: z.boolean() }).strict(),
  z.object({ kind: z.literal('raw-invalidate'), ...scope }).strict(),
]);
/** Exact raw command admitted by the existing bounded native envelope. */
export type ControlCapabilityCommandInput = z.infer<typeof ControlCapabilityCommandInputSchema>;

/** Observation returns the final Turn aggregate and this command's total new charge. */
export const ControlCapabilityCommandResultSchema = z.union([
  z.object({ rawOutputBytes: ordinal, exhausted: z.boolean(), chargedBytes: ordinal }).strict(),
  z.null(),
]);
/** Settle and invalidate publish no result beyond the outer durable acknowledgement. */
export type ControlCapabilityCommandResult = z.infer<typeof ControlCapabilityCommandResultSchema>;

/** Applies raw proof on the supplied native transaction; nested deciding bodies use savepoints. */
export function applyControlCapabilityCommand(
  db: WorkspaceDb,
  value: ControlCapabilityCommandInput
): ControlCapabilityCommandResult {
  const input = ControlCapabilityCommandInputSchema.parse(value);
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new WorkerRawOutputAuthorityError();
  if (input.kind === 'raw-settle') {
    settleWorkerRawOutput(db, input, input.callId, input.complete);
    return null;
  }
  if (input.kind === 'raw-invalidate') {
    invalidateWorkerRawOutputProof(db, input, input.callId);
    return null;
  }
  let chargedBytes = 0;
  let final: ReturnType<typeof observeWorkerRawOutput> | undefined;
  for (const watermark of input.positions) {
    final = observeWorkerRawOutput(db, { ...input, ...watermark });
    chargedBytes += final.chargedBytes;
  }
  if (!final || !Number.isSafeInteger(chargedBytes)) throw new WorkerRawOutputAuthorityError();
  return { ...final, chargedBytes };
}
