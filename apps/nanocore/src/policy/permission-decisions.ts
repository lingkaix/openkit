import { isDeepStrictEqual } from 'node:util';
import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  type ActorRef,
  type AuditEvent,
  allocateEntityId,
  isEntityId,
  type PolicyDecisionV1,
  PolicyDecisionV1Schema,
  type PolicyInvocationV1,
  PolicyInvocationV1Schema,
  PolicyStatementReferenceV1Schema,
  RequestIdSchema,
  TimestampSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';

import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import type { BootPolicyKernel } from '../bootstrap/policy.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { PermissionDecisionResult } from '../storage/schema/index.js';
import {
  PermissionDecisionRetainedV1Schema,
  projectPermissionDecision,
  readAuditEventRowV1,
  readPermissionDecisionRowV1,
} from './retained-records-v1.js';

/** Supported storage owner scopes for the first permission decision recorder. */
export type PermissionDecisionOwnerScope = 'server' | 'workspace' | 'user';

/** First durable policy snapshot id used by bounded worker-turn launches. */
export const WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID = 'worker_turn_launch_policy';

/** Input for recording one product-level permission decision. */
export interface RecordPermissionDecisionInput {
  /** Server-scope database handle when recording a server-owned decision. */
  coreDb?: CoreDb;
  /** Workspace-scope database handle when recording a workspace-owned decision. */
  workspaceDb?: WorkspaceDb;
  /** Stable decision id. */
  decisionId: string;
  /** Owner scope for this decision. */
  ownerScope: PermissionDecisionOwnerScope;
  /** Workspace id when this decision is workspace-scoped. */
  workspaceId?: string | null;
  /** Low-level policy-kernel decision being projected. */
  policyDecision: PolicyDecision;
  /** Policy engine and version label. */
  policyEngineVersion: string;
  /** Stable policy snapshot id. */
  policySnapshotId: string;
  /** Redacted subject summary. */
  subjectSummary: unknown;
  /** Product action or operation. */
  action: string;
  /** Redacted resource summary. */
  resourceSummary: unknown;
  /** Redacted context summary. */
  contextSummary: unknown;
  /** Enforcement point that produced this row. */
  enforcementPoint: string;
  /** Approval kind required when applicable. */
  requiredApprovalKind?: string | null;
  /** Linked approval id when present. */
  approvalId?: string | null;
  /** Linked audit event id when present. */
  auditEventId?: string | null;
  /** Actor stored on an automatically linked audit event when available. */
  auditActor?: AuditEvent['actor'];
  /** Creation time. */
  now?: Date;
}

/** Input for recording one already-mapped product permission decision. */
export interface RecordProductPermissionDecisionInput {
  /** Server-scope database handle when recording a server-owned decision. */
  coreDb?: CoreDb;
  /** Workspace-scope database handle when recording a workspace-owned decision. */
  workspaceDb?: WorkspaceDb;
  /** Stable decision id. */
  decisionId: string;
  /** Owner scope for this decision. */
  ownerScope: PermissionDecisionOwnerScope;
  /** Workspace id when this decision is workspace-scoped. */
  workspaceId?: string | null;
  /** Policy engine and version label. */
  policyEngineVersion: string;
  /** Stable policy snapshot id. */
  policySnapshotId: string;
  /** Redacted subject summary. */
  subjectSummary: unknown;
  /** Product action or operation. */
  action: string;
  /** Redacted resource summary. */
  resourceSummary: unknown;
  /** Redacted context summary. */
  contextSummary: unknown;
  /** Product-level permission decision result. */
  result: PermissionDecisionResult;
  /** Machine-readable reason code. */
  reasonCode: string;
  /** Enforcement point that produced this row. */
  enforcementPoint: string;
  /** Exact mediated evaluation, absent on specialized records. */
  mediation?: PolicyDecisionV1;
  /** Gate participant evidence published on this decision's existing linked Audit. */
  policyInvocation?: PolicyInvocationV1;
  /** Ephemeral limits consumed by this final allowing Workspace decision. */
  uses?: readonly { statement: PolicyDecisionV1['consumedStatements'][number]; limit: number }[];
  /** Approval kind required when applicable. */
  requiredApprovalKind?: string | null;
  /** Linked approval id when present. */
  approvalId?: string | null;
  /** Linked audit event id when present. */
  auditEventId?: string | null;
  /** Actor stored on an automatically linked audit event when available. */
  auditActor?: AuditEvent['actor'];
  /** Creation time. */
  now?: Date;
}

/** Exportable workspace-scoped permission decision row. */
export interface ExportedWorkspacePermissionDecision {
  /** Stable permission decision id. */
  readonly decisionId: string;
  /** Storage ownership scope. */
  readonly ownerScope: 'workspace';
  /** Workspace that owns this decision. */
  readonly workspaceId: string;
  /** Policy engine and version label. */
  readonly policyEngineVersion: string;
  /** Stable policy snapshot id. */
  readonly policySnapshotId: string;
  /** Redacted subject summary. */
  readonly subjectSummary: unknown;
  /** Product action or operation. */
  readonly action: string;
  /** Redacted resource summary. */
  readonly resourceSummary: unknown;
  /** Redacted context summary. */
  readonly contextSummary: unknown;
  /** Product-level permission decision result. */
  readonly result: PermissionDecisionResult;
  /** Machine-readable reason code. */
  readonly reasonCode: string;
  /** Enforcement point that produced this row. */
  readonly enforcementPoint: string;
  /** Exact mediated evaluation when the producer supplies it. */
  readonly mediation?: PolicyDecisionV1 | undefined;
  /** Approval kind required when applicable. */
  readonly requiredApprovalKind: string | null;
  /** Linked approval id when present. */
  readonly approvalId: string | null;
  /** Linked audit event id when present. */
  readonly auditEventId: string | null;
  /** Creation time. */
  readonly createdAt: string;
}

/** Public server-scoped permission decision row. */
export interface ServerPermissionDecisionRecord {
  /** Stable permission decision id. */
  readonly decisionId: string;
  /** Storage ownership scope. */
  readonly ownerScope: 'server';
  /** Server decisions do not belong to a workspace. */
  readonly workspaceId: null;
  /** Policy engine and version label. */
  readonly policyEngineVersion: string;
  /** Stable policy snapshot id. */
  readonly policySnapshotId: string;
  /** Redacted subject summary. */
  readonly subjectSummary: unknown;
  /** Product action or operation. */
  readonly action: string;
  /** Redacted resource summary. */
  readonly resourceSummary: unknown;
  /** Redacted context summary. */
  readonly contextSummary: unknown;
  /** Product-level permission decision result. */
  readonly result: PermissionDecisionResult;
  /** Machine-readable reason code. */
  readonly reasonCode: string;
  /** Enforcement point that produced this row. */
  readonly enforcementPoint: string;
  /** Exact mediated evaluation when the producer supplies it. */
  readonly mediation?: PolicyDecisionV1 | undefined;
  /** Approval kind required when applicable. */
  readonly requiredApprovalKind: string | null;
  /** Linked approval id when present. */
  readonly approvalId: string | null;
  /** Linked audit event id when present. */
  readonly auditEventId: string | null;
  /** Creation time. */
  readonly createdAt: string;
}

interface PermissionDecisionRow {
  readonly schema_version: number;
  readonly decision_id: string;
  readonly owner_scope: string;
  readonly workspace_id: string | null;
  readonly policy_engine_version: string;
  readonly policy_snapshot_id: string;
  readonly subject_summary_json: string;
  readonly action: string;
  readonly resource_summary_json: string;
  readonly context_summary_json: string;
  readonly result: PermissionDecisionResult;
  readonly reason_code: string;
  readonly enforcement_point: string;
  readonly mediation_json: string | null;
  readonly required_approval_kind: string | null;
  readonly approval_id: string | null;
  readonly audit_event_id: string | null;
  readonly created_at: string;
}

/** Exact policy decision that opened one approval Gate. */
export interface PolicyApprovalSourceDecision {
  /** Product action that requires approval. */
  readonly action: string;
  /** Redacted context summary. */
  readonly contextSummary: unknown;
  /** Required Approval kind. */
  readonly requiredApprovalKind: string | null;
  /** Redacted resource summary. */
  readonly resourceSummary: unknown;
  /** Redacted subject summary. */
  readonly subjectSummary: unknown;
}

/** Complete terminal policy Approval winner and its authoritative Audit projection. */
export interface PolicyApprovalTerminalWinner {
  /** Product action decided by the winner. */
  readonly action: string;
  /** Human actor stored by the winning AuditEvent. */
  readonly actor: Extract<ActorRef, { kind: 'user' }>;
  /** Audit-owned decision time. */
  readonly decidedAt: string;
  /** Durable terminal permission decision id. */
  readonly decisionId: string;
  /** Required Approval kind copied from the source decision. */
  readonly requiredApprovalKind: string;
  /** Winning command request id. */
  readonly requestId: string;
  /** Redacted resource summary copied from the source decision. */
  readonly resourceSummary: unknown;
  /** Terminal result. */
  readonly result: 'allow' | 'deny';
  /** Redacted subject summary copied from the source decision. */
  readonly subjectSummary: unknown;
}

/**
 * Lists every source decision that claims to open one policy Approval.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the Approval.
 * @param approvalId Approval request id.
 * @returns Source decisions in stable creation order.
 */
export function listPolicyApprovalSourceDecisions(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  approvalId: string
): PolicyApprovalSourceDecision[] {
  const rows = workspaceDb.sqlite
    .prepare(`SELECT * FROM permission_decisions
      WHERE owner_scope = 'workspace' AND workspace_id = ?
        AND result = 'require_approval' AND approval_id = ?
      ORDER BY created_at, decision_id`)
    .all(workspaceId, approvalId);
  return rows.map((row) => {
    const decision = readPermissionDecisionRowV1(row);
    return {
      action: decision.action,
      contextSummary: decision.contextSummary,
      requiredApprovalKind: decision.requiredApprovalKind,
      resourceSummary: decision.resourceSummary,
      subjectSummary: decision.subjectSummary,
    };
  });
}

/**
 * Reads and validates the sole terminal winner for one policy Approval.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the Approval.
 * @param approvalId Approval request id.
 * @param threadId Thread lineage required on the winning AuditEvent.
 * @param turnId Turn lineage required on the winning AuditEvent.
 * @returns Complete terminal winner, or null when no terminal row exists.
 * @throws Error when a terminal row or its linked AuditEvent is incomplete or contradictory.
 */
export function readPolicyApprovalTerminalWinner(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  approvalId: string,
  threadId: string,
  turnId: string
): PolicyApprovalTerminalWinner | null {
  const rows = workspaceDb.sqlite
    .prepare(`SELECT * FROM permission_decisions
      WHERE owner_scope = 'workspace' AND workspace_id = ?
        AND approval_id = ? AND result IN ('allow', 'deny')`)
    .all(workspaceId, approvalId) as PermissionDecisionRow[];

  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error('Policy Approval has multiple terminal permission decisions.');
  }

  const decision = readPermissionDecisionRowV1(rows[0]);
  const auditRow = workspaceDb.sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
    .get(decision.auditEventId);
  const audit = auditRow ? readAuditEventRowV1(auditRow) : null;
  if (
    !decision.auditEventId ||
    !audit ||
    audit.id !== decision.auditEventId ||
    audit.permissionDecisionId !== decision.decisionId ||
    audit.workspaceId !== workspaceId ||
    audit.threadId !== threadId ||
    audit.turnId !== turnId ||
    audit.action !== 'permission.decision' ||
    audit.resource !== `permission:${decision.action}` ||
    audit.outcome !== (decision.result === 'allow' ? 'succeeded' : 'denied') ||
    !decision.requiredApprovalKind ||
    !audit.actor ||
    !audit.requestId ||
    !audit.occurredAt
  ) {
    throw new Error('Policy Approval terminal decision has incomplete Audit linkage.');
  }
  if (audit.actor.kind !== 'user') {
    throw new Error('Policy Approval terminal Audit actor must be a user.');
  }
  return {
    action: decision.action,
    actor: audit.actor,
    decidedAt: TimestampSchema.parse(audit.occurredAt),
    decisionId: decision.decisionId,
    requiredApprovalKind: decision.requiredApprovalKind,
    requestId: RequestIdSchema.parse(audit.requestId),
    resourceSummary: decision.resourceSummary,
    result: decision.result as 'allow' | 'deny',
    subjectSummary: decision.subjectSummary,
  };
}

/** Input for recording one LLM gateway policy decision. */
export interface RecordGatewayPolicyDecisionInput {
  /** Server-scope database handle. */
  coreDb: CoreDb;
  /** Gateway action evaluated. */
  action: 'llm.gateway.chat_completions' | 'llm.gateway.responses';
  /** Provider selected for routing, when known. */
  providerId?: string | null;
  /** Product-level permission decision result. */
  result: 'allow' | 'deny';
  /** Machine-readable reason code. */
  reasonCode: 'gateway_allowed' | 'gateway_disabled' | 'gateway_provider_not_allowed';
  /** OpenAI-compatible route being handled. */
  route: '/v1/chat/completions' | '/v1/responses';
  /** Creation time. */
  now?: Date;
}

/** Input for recording one worker-turn launch decision. */
export interface RecordWorkerTurnLaunchDecisionInput {
  /** Workspace-scope database handle. */
  workspaceDb: WorkspaceDb;
  /** Workspace that owns the worker launch. */
  workspaceId: string;
  /** Thread that owns the worker launch. */
  threadId: string;
  /** Worker turn being launched. */
  turnId: string;
  /** Goal associated with the worker launch, when any. */
  goalId?: string | null;
  /** Goal task associated with the worker launch, when any. */
  taskId?: string | null;
  /** Creation time. */
  now?: Date;
}

/** Input for recording boot policy self-check decisions. */
export interface RecordBootPolicySelfCheckDecisionsInput {
  /** Server-scope database handle. */
  coreDb: CoreDb;
  /** Boot id that owns these decisions. */
  bootId: string;
  /** Loaded policy kernel. */
  kernel: BootPolicyKernel;
  /** Creation time. */
  now?: Date;
}

/**
 * Records one immutable product-level permission decision row.
 *
 * @param input Permission decision record input.
 */
export function recordPermissionDecision(input: RecordPermissionDecisionInput): void {
  recordProductPermissionDecision({
    ...(input.coreDb ? { coreDb: input.coreDb } : {}),
    ...(input.workspaceDb ? { workspaceDb: input.workspaceDb } : {}),
    decisionId: input.decisionId,
    ownerScope: input.ownerScope,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    policyEngineVersion: input.policyEngineVersion,
    policySnapshotId: input.policySnapshotId,
    subjectSummary: input.subjectSummary,
    action: input.action,
    resourceSummary: input.resourceSummary,
    contextSummary: input.contextSummary,
    result: mapPolicyEffect(input.policyDecision.effect),
    reasonCode: input.policyDecision.reasons[0]?.code ?? 'unknown',
    enforcementPoint: input.enforcementPoint,
    ...(input.requiredApprovalKind ? { requiredApprovalKind: input.requiredApprovalKind } : {}),
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.auditEventId ? { auditEventId: input.auditEventId } : {}),
    ...(input.auditActor ? { auditActor: input.auditActor } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Records one immutable product-level permission decision row.
 *
 * @param input Product permission decision record input.
 */
export function recordProductPermissionDecision(input: RecordProductPermissionDecisionInput): void {
  if (input.result === 'require_approval' && !input.requiredApprovalKind) {
    throw new Error('require_approval permission decisions require requiredApprovalKind.');
  }

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const sqlite = permissionDecisionDb(input);
  const auditEventId = permissionDecisionAuditEventId(input);
  const retained = writeRetainedV1(input);
  const mediation = PermissionDecisionRetainedV1Schema.parse({
    ...input,
    mediation:
      input.mediation === undefined ? undefined : PolicyDecisionV1Schema.parse(input.mediation),
    workspaceId: input.workspaceId ?? null,
    requiredApprovalKind: input.requiredApprovalKind ?? null,
    approvalId: input.approvalId ?? null,
    auditEventId,
    createdAt,
  }).mediation;
  if (mediation && input.enforcementPoint !== `${mediation.operation}@${mediation.stage}`)
    throw new Error('PermissionDecision enforcement point projection is inconsistent.');
  const policyInvocation =
    input.policyInvocation === undefined
      ? undefined
      : PolicyInvocationV1Schema.parse(input.policyInvocation);
  if (
    policyInvocation &&
    (mediation?.role !== 'gate' ||
      policyInvocation.mode !== 'gate' ||
      input.auditEventId ||
      !auditEventId ||
      policyInvocation.operation !== mediation.operation ||
      policyInvocation.stage !== mediation.stage ||
      policyInvocation.policyRevision !== input.policySnapshotId ||
      policyInvocation.authorizationRevision !== mediation.authorizationRevision ||
      policyInvocation.proposalDigest !== mediation.proposalDigest ||
      !isDeepStrictEqual(policyInvocation.binding, mediation.binding) ||
      !isDeepStrictEqual(policyInvocation.subject, mediation.subject) ||
      policyInvocation.capabilityCallId !==
        optionalStringField(input.contextSummary, 'capabilityCallId'))
  )
    throw new Error('Gate Policy invocation must match its decision and atomic linked Audit.');
  const uses =
    input.uses === undefined
      ? []
      : z
          .array(
            z
              .object({
                statement: PolicyStatementReferenceV1Schema,
                limit: z.number().int().positive(),
              })
              .strict()
          )
          .min(1)
          .parse(input.uses);
  if (uses.length || (mediation?.consumedStatements.length ?? 0)) {
    if (
      input.ownerScope !== 'workspace' ||
      !input.workspaceDb ||
      input.workspaceId !== input.workspaceDb.workspaceId ||
      mediation?.role !== 'final' ||
      input.result !== 'allow' ||
      mediation.kernel?.effect !== 'allow' ||
      input.auditEventId ||
      (mediation.subject.process !== null &&
        mediation.subject.process.workspaceId !== input.workspaceId)
    )
      throw new Error(
        'Finite Policy uses require a final Workspace allow and atomic linked Audit.'
      );
    const requested = uses
      .map(({ statement }) => JSON.stringify([statement.id, statement.digest]))
      .sort();
    const consumed = mediation.consumedStatements
      .map(({ id, digest }) => JSON.stringify([id, digest]))
      .sort();
    if (
      new Set(requested).size !== requested.length ||
      JSON.stringify(requested) !== JSON.stringify(consumed)
    )
      throw new Error('Consumed Policy statements must exactly match requested finite-use limits.');
  }

  const publish = sqlite.transaction(() => {
    for (const { statement, limit } of uses) {
      if (readPolicyStatementUseCount(input.workspaceDb!, statement) >= limit)
        throw new Error('Policy statement use limit is exhausted.');
    }
    sqlite
      .prepare(
        `INSERT INTO permission_decisions (
          decision_id,
          schema_version,
          owner_scope,
          workspace_id,
          policy_engine_version,
          policy_snapshot_id,
          subject_summary_json,
          action,
          resource_summary_json,
          context_summary_json,
          result,
          reason_code,
          enforcement_point,
          mediation_json,
          required_approval_kind,
          approval_id,
          audit_event_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.decisionId,
        retained.schemaVersion,
        input.ownerScope,
        input.workspaceId ?? null,
        input.policyEngineVersion,
        input.policySnapshotId,
        JSON.stringify(mediation ? null : input.subjectSummary),
        input.action,
        JSON.stringify(input.resourceSummary),
        JSON.stringify(input.contextSummary),
        input.result,
        input.reasonCode,
        mediation ? '' : input.enforcementPoint,
        mediation === undefined ? null : JSON.stringify(mediation),
        input.requiredApprovalKind ?? null,
        input.approvalId ?? null,
        auditEventId,
        createdAt
      );

    if (
      input.ownerScope === 'workspace' &&
      input.workspaceDb &&
      input.workspaceId &&
      auditEventId &&
      !input.auditEventId
    ) {
      recordWorkspaceAuditEvent({
        action: 'permission.decision',
        actor: input.auditActor ?? null,
        auditEventId,
        category: 'approval',
        capabilityCallId: optionalStringField(input.contextSummary, 'capabilityCallId'),
        errorCode: permissionAuditErrorCode(input),
        itemId: optionalStringField(input.contextSummary, 'itemId'),
        now,
        outcome: permissionAuditOutcome(input.result),
        permissionDecisionId: input.decisionId,
        ...(policyInvocation === undefined ? {} : { policyInvocation }),
        requestId: optionalStringField(input.contextSummary, 'requestId'),
        resource: `permission:${input.action}`,
        severity: permissionAuditSeverity(input.result),
        summary: `Permission decision ${input.result}: ${input.action}`,
        threadId: optionalStringField(input.contextSummary, 'threadId'),
        turnId: optionalStringField(input.contextSummary, 'turnId'),
        workspaceDb: input.workspaceDb,
        workspaceId: input.workspaceId,
      });
    }
    if (input.ownerScope === 'server' && input.coreDb && auditEventId && !input.auditEventId) {
      recordServerAuditEvent({
        action: 'permission.decision',
        actor: input.auditActor ?? null,
        auditEventId,
        category: 'approval',
        capabilityCallId: optionalStringField(input.contextSummary, 'capabilityCallId'),
        errorCode: permissionAuditErrorCode(input),
        itemId: optionalStringField(input.contextSummary, 'itemId'),
        coreDb: input.coreDb,
        now,
        outcome: permissionAuditOutcome(input.result),
        permissionDecisionId: input.decisionId,
        ...(policyInvocation === undefined ? {} : { policyInvocation }),
        requestId: optionalStringField(input.contextSummary, 'requestId'),
        resource: `permission:${input.action}`,
        severity: permissionAuditSeverity(input.result),
        summary: `Permission decision ${input.result}: ${input.action}`,
        threadId: optionalStringField(input.contextSummary, 'threadId'),
        turnId: optionalStringField(input.contextSummary, 'turnId'),
      });
    }
  });
  if (uses.length) publish.immediate();
  else publish();
}

/** Counts exact statement consumption from immutable final allows in this Workspace owner. */
export function readPolicyStatementUseCount(
  workspaceDb: WorkspaceDb,
  reference: PolicyDecisionV1['consumedStatements'][number]
): number {
  const statement = PolicyStatementReferenceV1Schema.parse(reference);
  const rows = workspaceDb.sqlite
    .prepare(`SELECT * FROM permission_decisions
    WHERE owner_scope = 'workspace' AND workspace_id = ? AND result = 'allow'`)
    .all(workspaceDb.workspaceId);
  return rows
    .map(readPermissionDecisionRowV1)
    .filter(
      ({ mediation }) =>
        mediation?.role === 'final' &&
        mediation.kernel?.effect === 'allow' &&
        mediation.consumedStatements.some(
          ({ id, digest }) => id === statement.id && digest === statement.digest
        )
    ).length;
}

/** Exact final decision facts supplied only by the existing effect's native dispatch owner. */
export interface PolicyUseDecision {
  readonly decisionId: string;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  readonly authorizationRevision: string;
}

/** Checks this effect's own atomic consumption without granting another use or changing records. */
export function policyStatementUsedByDecision(
  workspaceDb: WorkspaceDb,
  reference: PolicyDecisionV1['consumedStatements'][number],
  expected: PolicyUseDecision
): boolean {
  const statement = PolicyStatementReferenceV1Schema.parse(reference);
  const row = workspaceDb.sqlite
    .prepare(
      "SELECT * FROM permission_decisions WHERE decision_id = ? AND owner_scope = 'workspace' AND workspace_id = ?"
    )
    .get(expected.decisionId, workspaceDb.workspaceId);
  if (!row) return false;
  const decision = readPermissionDecisionRowV1(row);
  const mediation = decision.mediation;
  if (
    decision.result !== 'allow' ||
    decision.policySnapshotId !== expected.policyRevision ||
    mediation?.role !== 'final' ||
    mediation.stage !== 'decide' ||
    mediation.kernel?.effect !== 'allow' ||
    mediation.proposalDigest !== expected.proposalDigest ||
    mediation.authorizationRevision !== expected.authorizationRevision ||
    !mediation.consumedStatements.some(
      ({ id, digest }) => id === statement.id && digest === statement.digest
    )
  )
    return false;
  const auditRow = workspaceDb.sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
    .get(decision.auditEventId);
  if (!auditRow) return false;
  const audit = readAuditEventRowV1(auditRow);
  return (
    audit.permissionDecisionId === decision.decisionId &&
    audit.workspaceId === workspaceDb.workspaceId &&
    audit.action === 'permission.decision' &&
    audit.outcome === 'succeeded' &&
    audit.resource === `permission:${decision.action}` &&
    audit.capabilityCallId === optionalStringField(decision.contextSummary, 'capabilityCallId') &&
    (mediation.subject.process === null ||
      (audit.threadId === mediation.subject.process.threadId &&
        audit.turnId === mediation.subject.process.turnId))
  );
}

/**
 * Lists workspace-scoped permission decisions for export.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable permission decisions in oldest-first order.
 */
export function listExportableWorkspacePermissionDecisions(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportedWorkspacePermissionDecision[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          decision_id,
          schema_version,
          owner_scope,
          workspace_id,
          policy_engine_version,
          policy_snapshot_id,
          subject_summary_json,
          action,
          resource_summary_json,
          context_summary_json,
          result,
          reason_code,
          enforcement_point,
          mediation_json,
          required_approval_kind,
          approval_id,
          audit_event_id,
          created_at
        FROM permission_decisions
        WHERE owner_scope = 'workspace' AND workspace_id = ?
        ORDER BY created_at ASC, decision_id ASC`
      )
      .all(workspaceId) as PermissionDecisionRow[]
  ).map(mapPermissionDecisionRow);
}

/**
 * Lists server-scoped permission decisions.
 *
 * @param coreDb Open server-scope database handle.
 * @returns Server permission decisions in oldest-first order.
 */
export function listServerPermissionDecisions(coreDb: CoreDb): ServerPermissionDecisionRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `SELECT
          decision_id,
          schema_version,
          owner_scope,
          workspace_id,
          policy_engine_version,
          policy_snapshot_id,
          subject_summary_json,
          action,
          resource_summary_json,
          context_summary_json,
          result,
          reason_code,
          enforcement_point,
          mediation_json,
          required_approval_kind,
          approval_id,
          audit_event_id,
          created_at
        FROM permission_decisions
        WHERE owner_scope = 'server'
        ORDER BY created_at ASC, decision_id ASC`
      )
      .all() as PermissionDecisionRow[]
  ).map(mapServerPermissionDecisionRow);
}

/**
 * Replays imported workspace permission decisions without emitting new audit rows.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param decisions Permission decision rows to replay.
 */
export function importWorkspacePermissionDecisions(
  workspaceDb: WorkspaceDb,
  decisions: readonly unknown[]
): void {
  for (const source of decisions) {
    const decision = PermissionDecisionRetainedV1Schema.parse(projectPermissionDecision(source));
    const retained = writeRetainedV1(decision);
    if (decision.ownerScope !== 'workspace' || !decision.workspaceId) {
      throw new Error('Workspace permission decision import record must be workspace-scoped.');
    }

    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO permission_decisions (
          decision_id,
          schema_version,
          owner_scope,
          workspace_id,
          policy_engine_version,
          policy_snapshot_id,
          subject_summary_json,
          action,
          resource_summary_json,
          context_summary_json,
          result,
          reason_code,
          enforcement_point,
          mediation_json,
          required_approval_kind,
          approval_id,
          audit_event_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.decisionId,
        retained.schemaVersion,
        decision.ownerScope,
        decision.workspaceId,
        decision.policyEngineVersion,
        decision.policySnapshotId,
        JSON.stringify(decision.mediation ? null : decision.subjectSummary),
        decision.action,
        JSON.stringify(decision.resourceSummary),
        JSON.stringify(decision.contextSummary),
        decision.result,
        decision.reasonCode,
        decision.mediation ? '' : decision.enforcementPoint,
        decision.mediation === undefined ? null : JSON.stringify(decision.mediation),
        decision.requiredApprovalKind,
        decision.approvalId,
        decision.auditEventId,
        decision.createdAt
      );
  }
}

/**
 * Returns the audit event id linked to a permission decision row.
 *
 * @param input Permission decision input.
 * @returns Linked audit event id when one should be stored.
 */
function permissionDecisionAuditEventId(
  input: RecordProductPermissionDecisionInput
): string | null {
  if (input.auditEventId) {
    return input.auditEventId;
  }

  return input.ownerScope === 'workspace' || input.ownerScope === 'server'
    ? allocateEntityId('aud')
    : null;
}

/**
 * Maps a permission result to audit outcome.
 *
 * @param result Permission decision result.
 * @returns Audit outcome.
 */
function permissionAuditOutcome(
  result: PermissionDecisionResult
): 'succeeded' | 'failed' | 'denied' | 'cancelled' {
  if (result === 'deny') {
    return 'denied';
  }

  return result === 'error' ? 'failed' : 'succeeded';
}

/**
 * Maps a permission result to audit severity.
 *
 * @param result Permission decision result.
 * @returns Audit severity.
 */
function permissionAuditSeverity(result: PermissionDecisionResult): 'info' | 'warning' | 'error' {
  if (result === 'allow' || result === 'not_applicable') {
    return 'info';
  }

  return result === 'error' ? 'error' : 'warning';
}

/**
 * Returns the stable error code for failed permission audit rows.
 *
 * @param input Permission decision input.
 * @returns Error code when the audit outcome is failed.
 */
function permissionAuditErrorCode(input: RecordProductPermissionDecisionInput): string | null {
  return input.result === 'error' ? input.reasonCode : null;
}

/**
 * Reads an optional string field from a redacted summary object.
 *
 * @param value Summary value.
 * @param field Field name.
 * @returns String field value when present.
 */
function optionalStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

/**
 * Maps one permission decision storage row to the export shape.
 *
 * @param row Permission decision storage row.
 * @returns Exportable workspace permission decision.
 */
function mapPermissionDecisionRow(row: PermissionDecisionRow): ExportedWorkspacePermissionDecision {
  const decision = readPermissionDecisionRowV1(row);
  if (decision.ownerScope !== 'workspace' || !decision.workspaceId) {
    throw new Error('Exported permission decision row must be workspace-scoped.');
  }
  return { ...decision, ownerScope: 'workspace', workspaceId: decision.workspaceId };
}

/**
 * Maps one permission decision storage row to the server public shape.
 *
 * @param row Permission decision storage row.
 * @returns Public server permission decision.
 */
function mapServerPermissionDecisionRow(
  row: PermissionDecisionRow
): ServerPermissionDecisionRecord {
  const decision = readPermissionDecisionRowV1(row);
  if (decision.ownerScope !== 'server' || decision.workspaceId !== null) {
    throw new Error('Server permission decision row must be server-scoped.');
  }
  return { ...decision, ownerScope: 'server', workspaceId: null };
}

/**
 * Records one LLM gateway policy decision.
 *
 * @param input Gateway policy decision input.
 */
export function recordGatewayPolicyDecision(input: RecordGatewayPolicyDecisionInput): void {
  recordProductPermissionDecision({
    coreDb: input.coreDb,
    decisionId: allocateEntityId('pd'),
    ownerScope: 'server',
    policyEngineVersion: 'nanocore-gateway-policy:v1',
    policySnapshotId: 'runtime_config_gateway_policy',
    subjectSummary: { kind: 'gateway-client', id: 'openai-compatible' },
    action: input.action,
    resourceSummary: { kind: 'llm-provider', providerId: input.providerId ?? null },
    contextSummary: { route: input.route },
    result: input.result,
    reasonCode: input.reasonCode,
    enforcementPoint: 'llm.gateway.policy',
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Records an allowed worker-turn launch decision.
 *
 * @param input Worker-turn launch decision input.
 */
export function recordWorkerTurnLaunchDecision(input: RecordWorkerTurnLaunchDecisionInput): void {
  recordProductPermissionDecision({
    workspaceDb: input.workspaceDb,
    decisionId: allocateEntityId('pd'),
    ownerScope: 'workspace',
    workspaceId: input.workspaceId,
    policyEngineVersion: 'nanocore-worker-policy:v1',
    policySnapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
    subjectSummary: { kind: 'nanocore', id: 'worker-coordinator' },
    action: 'runtime.launch',
    resourceSummary: {
      kind: 'worker-turn',
      turnId: input.turnId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
    },
    contextSummary: { mode: input.goalId ? 'goal' : 'task' },
    result: 'allow',
    reasonCode: 'worker_turn_start_allowed',
    enforcementPoint: 'runtime.worker_turn_loop.start',
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Selects the database that owns one permission decision row.
 *
 * @param input Product permission decision record input.
 * @returns SQLite handle that owns the row.
 * @throws Error when the required database handle is absent.
 */
function permissionDecisionDb(input: RecordProductPermissionDecisionInput): CoreDb['sqlite'] {
  if (input.ownerScope === 'workspace') {
    if (!input.workspaceDb) {
      throw new Error('Workspace-scoped permission decisions require workspaceDb.');
    }

    return input.workspaceDb.sqlite;
  }

  if (input.ownerScope === 'user') {
    throw new Error('User-scoped permission decisions are not wired yet.');
  }

  if (!input.coreDb) {
    throw new Error('Server-scoped permission decisions require coreDb.');
  }

  return input.coreDb.sqlite;
}

/**
 * Records independent boot baseline decisions once per retained boot/action correlation.
 * Exact retry verifies immutable facts and linked Audit; ambiguity fails closed.
 *
 * @param input Boot policy self-check recording input.
 */
export function recordBootPolicySelfCheckDecisions(
  input: RecordBootPolicySelfCheckDecisionsInput
): void {
  const requests = [
    { operation: 'api.call', target: 'object:nanocore', resourceKind: 'core-api' },
    {
      operation: 'vault.use',
      target: 'object:baseline-vault-secret',
      resourceKind: 'vault-reference',
    },
  ] as const;
  // Both decisions and Audit share this existing Core authority and rollback boundary.
  input.coreDb.sqlite.transaction(() => {
    const bootRows = input.coreDb.sqlite
      .prepare(`SELECT * FROM permission_decisions
      WHERE owner_scope = 'server' AND enforcement_point = 'boot.policy.self_check'
      `)
      .all() as PermissionDecisionRow[];
    const existingRows = bootRows.filter(
      (row) =>
        optionalStringField(readPermissionDecisionRowV1(row).contextSummary, 'bootId') ===
        input.bootId
    );
    if (existingRows.length !== 0 && existingRows.length !== requests.length)
      throw new Error('Boot policy self-check record is contradictory.');
    for (const request of requests) {
      const process = 'process:nanocore';
      const policyDecision = input.kernel.evaluate({
        process,
        operation: request.operation,
        target: request.target,
      });
      const existing = existingRows.filter((row) => row.action === request.operation);
      if (existingRows.length > 0 && existing.length !== 1)
        throw new Error('Boot policy self-check record is contradictory.');
      const row = existing[0];
      if (row) {
        const linkedAudit = input.coreDb.sqlite
          .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
          .get(row.audit_event_id) as Record<string, unknown> | undefined;
        if (linkedAudit) {
          try {
            readAuditEventRowV1(linkedAudit);
          } catch {
            // Boot owns the pair's corruption diagnostic; a failed retained read still blocks retry.
            throw new Error('Boot policy self-check record is contradictory.');
          }
        }
        // Compare the known immutable core and leave additive storage columns untouched.
        const expectedAudit = {
          audit_event_id: row.audit_event_id,
          permission_decision_id: row.decision_id,
          workspace_id: null,
          protocol_version: null,
          thread_id: null,
          turn_id: null,
          item_id: null,
          capability_call_id: null,
          vault_grant_id: null,
          request_id: null,
          actor_json: null,
          subject_json: null,
          agent_id: null,
          agent_session_id: null,
          category: 'approval',
          action: 'permission.decision',
          resource: `permission:${request.operation}`,
          resource_revision: null,
          outcome: permissionAuditOutcome(row.result),
          severity: permissionAuditSeverity(row.result),
          summary: `Permission decision ${row.result}: ${request.operation}`,
          error_code: null,
          created_at: row.created_at,
          occurred_at: row.created_at,
        };
        if (
          !isEntityId('pd', row.decision_id) ||
          row.decision_id.split('_')[1]?.[14] !== '7' ||
          row.workspace_id !== null ||
          row.policy_engine_version !== 'policy-kernel:v1' ||
          row.policy_snapshot_id !== 'policy_snapshot_boot_baseline' ||
          row.result !== mapPolicyEffect(policyDecision.effect) ||
          row.reason_code !== (policyDecision.reasons[0]?.code ?? 'unknown') ||
          row.required_approval_kind !== null ||
          row.approval_id !== null ||
          optionalStringField(JSON.parse(row.subject_summary_json), 'id') !== process ||
          optionalStringField(JSON.parse(row.subject_summary_json), 'kind') !== 'process' ||
          optionalStringField(JSON.parse(row.resource_summary_json), 'id') !== request.target ||
          optionalStringField(JSON.parse(row.resource_summary_json), 'kind') !==
            request.resourceKind ||
          JSON.parse(row.context_summary_json).boot !== true ||
          !isEntityId('aud', row.audit_event_id) ||
          !linkedAudit ||
          Object.entries(expectedAudit).some(([key, value]) => linkedAudit[key] !== value)
        )
          throw new Error('Boot policy self-check record is contradictory.');
        continue;
      }
      recordPermissionDecision({
        coreDb: input.coreDb,
        decisionId: allocateEntityId('pd'),
        ownerScope: 'server',
        policyDecision,
        policyEngineVersion: 'policy-kernel:v1',
        policySnapshotId: 'policy_snapshot_boot_baseline',
        subjectSummary: { id: process, kind: 'process' },
        action: request.operation,
        resourceSummary: { id: request.target, kind: request.resourceKind },
        contextSummary: { boot: true, bootId: input.bootId },
        enforcementPoint: 'boot.policy.self_check',
        ...(input.now ? { now: input.now } : {}),
      });
    }
  })();
}

/**
 * Maps low-level policy-kernel effects into first-slice product decision results.
 *
 * @param effect Low-level policy effect.
 * @returns Product permission decision result.
 */
function mapPolicyEffect(effect: PolicyDecision['effect']): PermissionDecisionResult {
  return effect;
}
