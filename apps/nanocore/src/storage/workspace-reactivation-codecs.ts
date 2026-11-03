import { WorkspaceBackupIdSchema } from '@openkit/app-api-schemas';
import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Finite selection for the three original stopped-reactivation SQL stages; proof bytes remain in Core. */
export const ControlRecoverySourceReactivationInputSchema = z.strictObject({
  stage: z.enum(['revoke', 'workspace', 'report']),
  workspaceId: WorkspaceIdSchema,
  backupId: WorkspaceBackupIdSchema,
  expectedRevision: z.number().int().positive().safe(),
  expectedCoreRevision: z.number().int().positive().safe(),
  proofHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
/** Original Core and Workspace decisions, never caller-supplied SQL or a publication grant. */
export type ControlRecoverySourceReactivationInput = z.infer<
  typeof ControlRecoverySourceReactivationInputSchema
>;
/** Only the original bounded recovery refusals cross the native channel. */
export const ControlRecoverySourceReactivationRefusalSchema = z
  .strictObject({
    operation: z.literal('recovery-source-reactivation'),
    code: z.enum(['recovery-required', 'request-conflict', 'workspace-unavailable']),
    message: z.string(),
    status: z.literal(409),
  })
  .refine((value) => value.message === `Workspace recovery refused: ${value.code}.`);
