import { AuditEventSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Originally standalone Skill decision admission commits; never an arbitrary Audit action. */
export const STANDALONE_AUDIT_STAGES = [
  'catalog.skill-candidate-decide.admit',
  'catalog.skill-candidate-withdraw.admit',
] as const;
/** One original prepared Audit, bound to its exact existing Workspace and admitted stage. */
export const ControlStandaloneAuditInputSchema = z
  .strictObject({
    workspaceId: WorkspaceIdSchema,
    stage: z.enum(STANDALONE_AUDIT_STAGES),
    event: AuditEventSchema.strict().extend({
      createdAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    }),
  })
  .refine(
    ({ workspaceId, stage, event }) =>
      event.workspaceId === workspaceId &&
      event.action === stage &&
      event.actor?.kind === 'user' &&
      event.outcome === 'succeeded' &&
      event.resource?.startsWith('skill-candidate:') === true &&
      event.notebookAdmission === undefined
  );
/** Closed internal publication input, not an authorization proof or a public format. */
export type ControlStandaloneAuditInput = z.infer<typeof ControlStandaloneAuditInputSchema>;
