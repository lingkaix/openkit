import { AuditEventSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Originally standalone Catalog, Data Source, App-update, Server MCP and configuration outcomes; never arbitrary Audit actions. */
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
  'data_source_catalog.authority.update',
  'app.update.start',
  'app.update.start.handoff',
  'administration.server-mcp-create',
  'administration.server-mcp-stage-version',
  'administration.server-mcp-select-version',
  'administration.server-mcp-update-binding',
  'administration.server-mcp-remove',
  'catalog.mcp-create',
  'catalog.mcp-stage-version',
  'catalog.mcp-remove',
  'catalog.mcp-select',
  'catalog.mcp-binding',
  'catalog.plugin-import',
  'auth.bootstrap.consume',
  'policy.write',
  'administration.configuration.apply',
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
    if (stage === 'auth.bootstrap.consume')
      return (
        workspaceId === undefined &&
        event.workspaceId === null &&
        event.threadId === null &&
        event.turnId === null &&
        event.itemId === null &&
        event.capabilityCallId === null &&
        event.permissionDecisionId === null &&
        event.vaultGrantId === null &&
        event.requestId === null &&
        event.resourceRevision === null &&
        event.actor === null &&
        event.subject === null &&
        event.agentId === null &&
        event.agentSessionId === null &&
        event.authentication === undefined &&
        event.category === 'system' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        event.resource?.startsWith('auth-token:') === true
      );
    if (event.actor?.kind !== 'user') return false;
    if (stage === 'policy.write' || stage === 'administration.configuration.apply') {
      if (
        workspaceId !== undefined ||
        event.workspaceId !== null ||
        typeof event.requestId !== 'string' ||
        event.category !== 'system' ||
        event.severity !== 'info' ||
        event.threadId !== null ||
        event.turnId !== null ||
        event.itemId !== null ||
        event.capabilityCallId !== null ||
        event.agentId !== null ||
        event.agentSessionId !== null ||
        event.subject !== null ||
        event.resourceRevision !== null ||
        event.errorCode !== null ||
        event.vaultGrantId !== null ||
        event.authentication !== undefined ||
        event.policyInvocation !== undefined
      )
        return false;
      if (stage === 'policy.write') {
        const outcome = event.policyWriteOutcome;
        return (
          event.resource === 'policy:server' &&
          typeof event.permissionDecisionId === 'string' &&
          outcome !== undefined &&
          outcome.decider.kind === 'human' &&
          outcome.decider.id === event.actor.id &&
          outcome.validation === 'valid' &&
          outcome.persistedRevision !== null &&
          event.outcome ===
            (outcome.outcome === 'active'
              ? 'succeeded'
              : outcome.outcome === 'unknown'
                ? 'unknown'
                : 'failed')
        );
      }
      return (
        event.policyWriteOutcome === undefined &&
        (event.outcome === 'succeeded' || event.outcome === 'failed') &&
        ((event.resource?.startsWith('provider:') === true &&
          event.resource.length > 'provider:'.length &&
          event.permissionDecisionId === null) ||
          (event.resource === 'gateway:gateway' && event.permissionDecisionId === null) ||
          (event.resource?.startsWith('agent:') === true &&
            event.resource.length > 'agent:'.length))
      );
    }
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
    if (
      stage === 'catalog.mcp-create' ||
      stage === 'catalog.mcp-stage-version' ||
      stage === 'catalog.mcp-remove' ||
      stage === 'catalog.mcp-select' ||
      stage === 'catalog.mcp-binding' ||
      stage === 'catalog.plugin-import'
    )
      return (
        workspaceId !== undefined &&
        event.workspaceId === workspaceId &&
        typeof event.requestId === 'string' &&
        event.category === 'command' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        typeof event.resourceRevision === 'number' &&
        event.resource?.startsWith(stage === 'catalog.plugin-import' ? 'plugin:' : 'mcp:') === true
      );
    if (stage === 'data_source_catalog.authority.update')
      return (
        workspaceId !== undefined &&
        event.workspaceId === workspaceId &&
        event.category === 'system' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        event.resource?.startsWith('data-source-catalog:') === true
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
