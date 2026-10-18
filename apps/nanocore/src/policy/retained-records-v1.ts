import {
  AgentSessionIdSchema,
  AuditEventIdSchema,
  AutomationIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  PermissionDecisionIdSchema,
  PolicyDecisionV1Schema,
  PolicyInvocationV1Schema,
  PolicyWriteOutcomeV1Schema,
  RequestIdSchema,
  readRetainedV1,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  UserIdSchema,
  VaultGrantIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

// These retained cores are independent of current wire models. Extend version 1 only
// additively; a changed required meaning needs its own accepted format transition.
const actorV1 = z.union([
  z.object({ kind: z.literal('user'), id: UserIdSchema }),
  z.object({
    kind: z.enum(['agent', 'integration', 'system']),
    id: z.string().min(1),
    responsibleUserId: UserIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal('automation'),
    id: AutomationIdSchema,
    responsibleUserId: UserIdSchema.nullable(),
  }),
]);
const digestV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const notebookAdmissionV1 = z.object({
  ownerScope: z.union([
    z.object({ kind: z.literal('user'), userId: UserIdSchema }),
    z.object({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }),
    z.object({ kind: z.literal('server') }),
  ]),
  requestId: RequestIdSchema,
  inputDigest: digestV1,
  baseRevision: z.string().min(1).nullable(),
  candidateRevision: z.string().min(1),
  producer: actorV1,
  authority: z.union([
    z.object({ kind: z.literal('direct'), instructionReference: z.string().min(1) }),
    z.object({ kind: z.literal('proposal'), proposalId: z.string().min(1) }),
    z.object({
      kind: z.literal('delegated'),
      settingReference: z.string().min(1),
      settingDigest: digestV1,
    }),
  ]),
  sourceReferences: z.array(z.string().min(1)),
});
/** Frozen version-one Audit core for native and portable retained readers. */
export const AuditEventRetainedV1Schema = z.object({
  id: AuditEventIdSchema,
  workspaceId: WorkspaceIdSchema.nullable(),
  protocolVersion: z.string().min(1).optional(),
  threadId: ThreadIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  itemId: ItemIdSchema.nullable(),
  capabilityCallId: CapabilityCallIdSchema.nullable(),
  permissionDecisionId: PermissionDecisionIdSchema.nullable(),
  vaultGrantId: VaultGrantIdSchema.nullable(),
  requestId: RequestIdSchema.nullable(),
  actor: actorV1.nullable(),
  subject: actorV1.nullable(),
  agentId: z.string().min(1).nullable(),
  agentSessionId: AgentSessionIdSchema.nullable(),
  category: z.enum(['command', 'approval', 'capability', 'knowledge', 'artifact', 'system']),
  action: z.string().min(1),
  resource: z.string().min(1).nullable(),
  resourceRevision: z.number().int().positive().nullable(),
  notebookAdmission: notebookAdmissionV1.optional(),
  policyInvocation: PolicyInvocationV1Schema.optional(),
  policyWriteOutcome: PolicyWriteOutcomeV1Schema.optional(),
  outcome: z.enum(['succeeded', 'failed', 'denied', 'cancelled', 'unknown']),
  severity: z.enum(['info', 'warning', 'error']),
  summary: z.string().min(1),
  errorCode: z.string().min(1).nullable(),
  createdAt: TimestampSchema,
  occurredAt: TimestampSchema,
});
/** Frozen version-one PermissionDecision core for native and portable retained readers. */
export const PermissionDecisionRetainedV1Schema = z
  .object({
    decisionId: PermissionDecisionIdSchema,
    ownerScope: z.enum(['server', 'workspace', 'user']),
    workspaceId: WorkspaceIdSchema.nullable(),
    policyEngineVersion: z.string().min(1),
    policySnapshotId: z.string().min(1),
    subjectSummary: z.unknown(),
    action: z.string().min(1),
    resourceSummary: z.unknown(),
    contextSummary: z.unknown(),
    result: z.enum([
      'allow',
      'deny',
      'require_approval',
      'require_escalation',
      'defer',
      'not_applicable',
      'error',
    ]),
    reasonCode: z.string().min(1),
    enforcementPoint: z.string().min(1),
    mediation: PolicyDecisionV1Schema.optional(),
    requiredApprovalKind: z.string().min(1).nullable(),
    approvalId: z.string().min(1).nullable(),
    auditEventId: AuditEventIdSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .superRefine((decision, context) => {
    if (decision.mediation) {
      const mediation = decision.mediation;
      if (
        decision.enforcementPoint !== mediation.point ||
        decision.policySnapshotId !== mediation.policyRevision
      )
        context.addIssue({
          code: 'custom',
          message: 'PermissionDecision mediation identity is inconsistent.',
        });
      if (mediation.role === 'gate' && decision.approvalId)
        context.addIssue({
          code: 'custom',
          message: 'Participant gate decisions cannot claim an Approval winner.',
        });
      if (mediation.role === 'final' && mediation.kernel === null && decision.result !== 'error')
        context.addIssue({
          code: 'custom',
          message: 'An unavailable Kernel requires a final error result.',
        });
      if (
        (mediation.role === 'final' &&
          decision.result === 'allow' &&
          mediation.kernel?.effect !== 'allow') ||
        (mediation.consumedStatements.length > 0 &&
          (mediation.role !== 'final' ||
            decision.result !== 'allow' ||
            mediation.kernel?.effect !== 'allow'))
      )
        context.addIssue({
          code: 'custom',
          message: 'Only final combined and Kernel allow consumes uses.',
        });
      const references = mediation.consumedStatements.map(({ id, digest }) =>
        JSON.stringify([id, digest])
      );
      if (new Set(references).size !== references.length)
        context.addIssue({
          code: 'custom',
          message: 'Consumed statement references must be unique.',
        });
    }
    if (decision.result === 'require_approval' && !decision.requiredApprovalKind) {
      context.addIssue({
        code: 'custom',
        message: 'PermissionDecision requires its Approval kind.',
      });
    }
  });

/** Validates an Audit SQLite row's version before decoding its frozen version-one core. */
export function readAuditEventRowV1(input: unknown): z.infer<typeof AuditEventRetainedV1Schema> {
  const row = input as Record<string, unknown>;
  return readRetainedV1({ schemaVersion: row?.schema_version }, () => {
    return AuditEventRetainedV1Schema.parse({
      id: row.audit_event_id,
      workspaceId: row.workspace_id,
      protocolVersion: row.protocol_version ?? undefined,
      threadId: row.thread_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      capabilityCallId: row.capability_call_id,
      permissionDecisionId: row.permission_decision_id,
      vaultGrantId: row.vault_grant_id,
      requestId: row.request_id,
      actor: row.actor_json ? JSON.parse(String(row.actor_json)) : null,
      subject: row.subject_json ? JSON.parse(String(row.subject_json)) : null,
      agentId: row.agent_id,
      agentSessionId: row.agent_session_id,
      category: row.category,
      action: row.action,
      resource: row.resource,
      resourceRevision: row.resource_revision ?? null,
      ...(row.notebook_admission_json
        ? { notebookAdmission: JSON.parse(String(row.notebook_admission_json)) }
        : {}),
      ...(row.policy_invocation_json != null
        ? { policyInvocation: JSON.parse(String(row.policy_invocation_json)) }
        : {}),
      ...(row.policy_write_outcome_json != null
        ? { policyWriteOutcome: JSON.parse(String(row.policy_write_outcome_json)) }
        : {}),
      outcome: row.outcome,
      severity: row.severity,
      summary: row.summary,
      errorCode: row.error_code,
      createdAt: row.created_at,
      occurredAt: row.occurred_at,
    });
  });
}

/** Validates a PermissionDecision SQLite row's version before decoding its frozen version-one core. */
export function readPermissionDecisionRowV1(
  input: unknown
): z.infer<typeof PermissionDecisionRetainedV1Schema> {
  const row = input as Record<string, unknown>;
  return readRetainedV1({ schemaVersion: row?.schema_version }, () => {
    return PermissionDecisionRetainedV1Schema.parse({
      decisionId: row.decision_id,
      ownerScope: row.owner_scope,
      workspaceId: row.workspace_id,
      policyEngineVersion: row.policy_engine_version,
      policySnapshotId: row.policy_snapshot_id,
      subjectSummary: JSON.parse(String(row.subject_summary_json)),
      action: row.action,
      resourceSummary: JSON.parse(String(row.resource_summary_json)),
      contextSummary: JSON.parse(String(row.context_summary_json)),
      result: row.result,
      reasonCode: row.reason_code,
      enforcementPoint: row.enforcement_point,
      ...(row.mediation_json != null ? { mediation: JSON.parse(String(row.mediation_json)) } : {}),
      requiredApprovalKind: row.required_approval_kind,
      approvalId: row.approval_id,
      auditEventId: row.audit_event_id,
      createdAt: row.created_at,
    });
  });
}
