import { AuditEventSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Originally standalone Catalog, App-update and Server MCP stages; never arbitrary Audit actions. */
export const STANDALONE_AUDIT_STAGES = [
  'catalog.skill-candidate-decide.admit',
  'catalog.skill-candidate-withdraw.admit',
  'catalog.skill-candidate-submit.admit',
  'catalog.skill-candidate-submit',
  'catalog.skill-candidate-decide',
  'catalog.skill-candidate-withdraw',
  'catalog.light-app-import',
  'catalog.light-app-history-import',
  'catalog.light-app-select',
  'catalog.light-app-pin',
  'app.update.start',
  'app.update.start.handoff',
  'administration.server-mcp-create',
  'administration.server-mcp-stage-version',
  'administration.server-mcp-select-version',
  'administration.server-mcp-update-binding',
  'administration.server-mcp-remove',
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
    if (event.action !== stage || event.notebookAdmission !== undefined) return false;
    if (
      stage === 'catalog.light-app-import' ||
      stage === 'catalog.light-app-history-import' ||
      stage === 'catalog.light-app-select' ||
      stage === 'catalog.light-app-pin'
    )
      return (
        workspaceId !== undefined &&
        event.workspaceId === workspaceId &&
        event.actor !== null &&
        typeof event.requestId === 'string' &&
        event.category === 'system' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        event.resourceRevision === null &&
        (stage === 'catalog.light-app-import'
          ? /^light-app-definition:sha256:[0-9a-f]{64}$/.test(event.resource ?? '') &&
            (event.actor.kind === 'user' ||
              event.actor.kind === 'agent' ||
              event.actor.kind === 'system')
          : event.resource === `light-app-definition:${workspaceId}`)
      );
    if (event.actor?.kind !== 'user') return false;
    if (
      stage === 'administration.server-mcp-create' ||
      stage === 'administration.server-mcp-stage-version' ||
      stage === 'administration.server-mcp-select-version' ||
      stage === 'administration.server-mcp-update-binding' ||
      stage === 'administration.server-mcp-remove'
    )
      return (
        workspaceId === undefined &&
        event.workspaceId === null &&
        event.category === 'system' &&
        event.severity === 'info' &&
        typeof event.requestId === 'string' &&
        (event.outcome === 'unknown'
          ? /^mcp-command:sha256:[0-9a-f]{64}$/.test(event.resource ?? '')
          : event.outcome === 'succeeded' && event.resource?.startsWith('catalog_mcp:') === true)
      );
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
      (stage === 'catalog.skill-candidate-submit.admit'
        ? /^skill:[^@]+@sha256:[0-9a-f]{64}$/.test(event.resource ?? '')
        : event.resource?.startsWith('skill-candidate:') === true)
    );
  });
/** Closed internal publication input, not an authorization proof or a public format. */
export type ControlStandaloneAuditInput = z.infer<typeof ControlStandaloneAuditInputSchema>;
