import { AccessTokenIdSchema, AuditEventSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Originally standalone Catalog, Data Source, App-update, Server MCP, token and configuration outcomes; never arbitrary Audit actions. */
export const STANDALONE_AUDIT_STAGES = [
  'catalog.skill-import.admit',
  'catalog.skill-import',
  'catalog.skill-select.admit',
  'catalog.skill-select',
  'catalog.skill-pin.admit',
  'catalog.skill-pin',
  'catalog.skill-remove.admit',
  'catalog.skill-remove',
  'catalog.skill-purge.admit',
  'catalog.skill-purge',

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
  'workspace.credential-binding.update',
  'app.update.start',
  'app.update.start.handoff',
  'administration.server-mcp-create',
  'administration.server-mcp-stage-version',
  'administration.server-mcp-select-version',
  'administration.server-mcp-update-binding',
  'administration.server-mcp-remove',
  'catalog.shared-mcp-set-disabled',
  'scheduler.admission.retry',
  'scheduler.admission.cancel',
  'catalog.mcp-create',
  'catalog.mcp-stage-version',
  'catalog.mcp-remove',
  'catalog.mcp-select',
  'catalog.mcp-binding',
  'catalog.plugin-import',
  'auth.failure-threshold',
  'auth.bootstrap.consume',
  'auth.token.issue',
  'auth.token.revoke',
  'auth.token.rotate',
  'policy.write',
  'administration.configuration.apply',
  'mcp.server.lifecycle.degraded',
  'mcp.server.lifecycle.failed',
  'mcp.server.lifecycle.inactive',
  'mcp.server.lifecycle.ready',
  'mcp.server.lifecycle.starting',
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
    if (stage === 'auth.failure-threshold')
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
        event.resource === null &&
        event.actor === null &&
        event.subject === null &&
        event.agentId === null &&
        event.agentSessionId === null &&
        event.authentication === undefined &&
        event.policyInvocation === undefined &&
        event.policyWriteOutcome === undefined &&
        event.errorCode === null &&
        event.category === 'system' &&
        event.outcome === 'failed' &&
        event.severity === 'warning' &&
        event.summary === '{"kind":"bearer","keyKind":"source","window":900000,"count":100}'
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
    if (
      stage === 'mcp.server.lifecycle.inactive' ||
      stage === 'mcp.server.lifecycle.starting' ||
      stage === 'mcp.server.lifecycle.ready' ||
      stage === 'mcp.server.lifecycle.degraded' ||
      stage === 'mcp.server.lifecycle.failed'
    ) {
      const failed =
        stage === 'mcp.server.lifecycle.degraded' || stage === 'mcp.server.lifecycle.failed';
      return (
        (workspaceId === undefined
          ? event.actor?.kind === 'user' && typeof event.requestId === 'string'
          : event.workspaceId === workspaceId &&
            event.actor === null &&
            event.requestId === null) &&
        event.category === 'capability' &&
        event.resource?.startsWith('mcp-server:') === true &&
        event.resource.length > 'mcp-server:'.length &&
        event.resourceRevision === null &&
        event.outcome === (failed ? 'failed' : 'succeeded') &&
        event.severity === (failed ? 'warning' : 'info') &&
        event.errorCode === (failed ? 'mcp-server-unavailable' : null)
      );
    }
    if (
      stage === 'catalog.skill-import' ||
      stage === 'catalog.skill-import.admit' ||
      stage === 'catalog.skill-select' ||
      stage === 'catalog.skill-select.admit' ||
      stage === 'catalog.skill-pin' ||
      stage === 'catalog.skill-pin.admit' ||
      stage === 'catalog.skill-remove' ||
      stage === 'catalog.skill-remove.admit' ||
      stage === 'catalog.skill-purge' ||
      stage === 'catalog.skill-purge.admit'
    )
      return (
        workspaceId !== undefined &&
        event.workspaceId === workspaceId &&
        event.actor !== null &&
        typeof event.requestId === 'string' &&
        event.category === 'system' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        event.resource?.startsWith('skill:') === true
      );
    // The original Scheduler stages have no attributed actor and grant no fresh authority.
    if (stage === 'scheduler.admission.retry' || stage === 'scheduler.admission.cancel')
      return (
        workspaceId !== undefined &&
        event.workspaceId === workspaceId &&
        event.actor === null &&
        event.category === 'system' &&
        event.severity === 'info' &&
        event.threadId !== null &&
        (stage === 'scheduler.admission.cancel' || event.turnId !== null) &&
        event.itemId === null &&
        event.capabilityCallId === null &&
        event.permissionDecisionId === null &&
        event.vaultGrantId === null &&
        event.subject === null &&
        event.agentId === null &&
        event.agentSessionId === null &&
        event.resourceRevision === null &&
        event.errorCode === null &&
        event.authentication === undefined &&
        event.policyInvocation === undefined &&
        event.policyWriteOutcome === undefined &&
        event.resource?.startsWith('scheduler-admission:') === true &&
        event.resource.length > 'scheduler-admission:'.length &&
        event.outcome === (stage === 'scheduler.admission.retry' ? 'succeeded' : 'cancelled')
      );
    if (event.actor?.kind !== 'user') return false;
    if (
      stage === 'auth.token.issue' ||
      stage === 'auth.token.revoke' ||
      stage === 'auth.token.rotate'
    )
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
        event.subject === null &&
        event.agentId === null &&
        event.agentSessionId === null &&
        event.errorCode === null &&
        event.policyInvocation === undefined &&
        event.policyWriteOutcome === undefined &&
        event.category === 'system' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        event.resource?.startsWith('auth-token:') === true &&
        AccessTokenIdSchema.safeParse(event.resource.slice('auth-token:'.length)).success
      );
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
      stage === 'administration.server-mcp-remove' ||
      stage === 'catalog.shared-mcp-set-disabled'
    )
      return (
        workspaceId === undefined &&
        (stage === 'catalog.shared-mcp-set-disabled'
          ? WorkspaceIdSchema.safeParse(event.workspaceId).success
          : event.workspaceId === null) &&
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
    if (stage === 'workspace.credential-binding.update')
      return (
        workspaceId !== undefined &&
        event.workspaceId === workspaceId &&
        event.actor?.kind === 'user' &&
        event.category === 'system' &&
        event.outcome === 'succeeded' &&
        event.severity === 'info' &&
        typeof event.agentId === 'string' &&
        event.resource?.startsWith(`workspace-credential-binding:${event.agentId}:`) === true
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
