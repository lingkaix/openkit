import { AuditEventSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Originally standalone Catalog admission and App-update stages; never arbitrary Audit actions. */
export const STANDALONE_AUDIT_STAGES = [
  'catalog.skill-candidate-decide.admit',
  'catalog.skill-candidate-withdraw.admit',
  'app.update.start',
  'app.update.start.handoff',
] as const;
/** One original prepared Audit, bound to its exact existing scope and admitted stage. */
export const ControlStandaloneAuditInputSchema = z
  .strictObject({
    workspaceId: WorkspaceIdSchema.optional(),
    stage: z.enum(STANDALONE_AUDIT_STAGES),
    event: AuditEventSchema.strict().extend({
      createdAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    }),
  })
  .refine(({ workspaceId, stage, event }) => {
    if (
      event.action !== stage ||
      event.actor?.kind !== 'user' ||
      event.notebookAdmission !== undefined
    )
      return false;
    if (stage === 'app.update.start' || stage === 'app.update.start.handoff')
      return (
        workspaceId === undefined &&
        event.workspaceId === null &&
        event.category === 'system' &&
        typeof event.requestId === 'string' &&
        event.resource === `app-update:${event.requestId}` &&
        (stage === 'app.update.start'
          ? event.outcome === 'succeeded' && event.severity === 'info'
          : (event.outcome === 'succeeded' && event.severity === 'info') ||
            (event.outcome === 'failed' &&
              event.severity === 'error' &&
              event.errorCode !== undefined))
      );
    return (
      workspaceId !== undefined &&
      event.workspaceId === workspaceId &&
      event.outcome === 'succeeded' &&
      event.resource?.startsWith('skill-candidate:') === true
    );
  });
/** Closed internal publication input, not an authorization proof or a public format. */
export type ControlStandaloneAuditInput = z.infer<typeof ControlStandaloneAuditInputSchema>;
