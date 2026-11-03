import {
  WorkspaceReconciliationRecordSchema,
  WorkspaceRecoveryDecisionSchema,
} from '@openkit/app-api-schemas';
import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';

const identity = { workspaceId: z.string().min(1), reconciliationRecordId: z.string().min(1) };
/** Exact original command facts; the original mutation and receipt retain separate FULL stages. */
export const ControlWorkspaceRecoveryDecisionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('decide'),
      ...identity,
      decision: WorkspaceRecoveryDecisionSchema,
      decidedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('receipt'),
      ...identity,
      receipt: z
        .object({
          key: z.string().min(1),
          command: z.literal('workspace_sync.recovery.decide'),
          requestId: z.string().min(1),
          scope: z.object(identity).strict(),
          inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          responseKind: z.literal('workspace_sync_review'),
          createdAt: TimestampSchema,
          expiresAt: TimestampSchema,
        })
        .strict(),
    })
    .strict(),
]);
/** One existing recovery command family, never generic SQL or carried authority. */
export type ControlWorkspaceRecoveryDecision = z.infer<
  typeof ControlWorkspaceRecoveryDecisionSchema
>;
/** The original public record or the separate receipt acknowledgement. */
export const ControlWorkspaceRecoveryDecisionResultSchema =
  WorkspaceReconciliationRecordSchema.nullable();
const codes = ['missing', 'terminal', 'capture_source', 'no_manifest', 'record_invalid'] as const;
/** Fixed owned refusal categories; SQL diagnostics never cross this boundary. */
export const ControlWorkspaceRecoveryDecisionRefusalSchema = z
  .object({
    operation: z.literal('workspace-recovery-decision'),
    code: z.enum(codes),
    message: z.literal('Workspace recovery decision was refused.'),
    status: z.union([z.literal(404), z.literal(409)]),
  })
  .strict()
  .refine((value) => value.status === (value.code === 'capture_source' ? 409 : 404));
/** Exact original domain refusal identity, not a new error contract. */
export class WorkspaceRecoveryDecisionRefusal extends Error {
  constructor(readonly code: (typeof codes)[number]) {
    super(code);
  }
}
