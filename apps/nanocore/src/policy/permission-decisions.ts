import { randomUUID } from 'node:crypto';
import type { PolicyDecision } from '@openkit/policy-kernel';

import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import type { BootPolicyKernel } from '../bootstrap/policy.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { PermissionDecisionResult } from '../storage/schema/index.js';

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
  /** Approval kind required when applicable. */
  requiredApprovalKind?: string | null;
  /** Linked approval id when present. */
  approvalId?: string | null;
  /** Linked audit event id when present. */
  auditEventId?: string | null;
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
  readonly required_approval_kind: string | null;
  readonly approval_id: string | null;
  readonly audit_event_id: string | null;
  readonly created_at: string;
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

/** Input for recording one Goal Mode worker launch decision. */
export interface RecordGoalWorkerLaunchDecisionInput {
  /** Workspace-scope database handle. */
  workspaceDb: WorkspaceDb;
  /** Workspace that owns the worker launch. */
  workspaceId: string;
  /** Thread that owns the worker launch. */
  threadId: string;
  /** Goal that owns the worker launch. */
  goalId: string;
  /** Goal task being launched. */
  taskId: string;
  /** Enforcement point producing this row. */
  enforcementPoint: string;
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

  sqlite
    .prepare(
      `INSERT INTO permission_decisions (
        decision_id,
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
        required_approval_kind,
        approval_id,
        audit_event_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.decisionId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.policyEngineVersion,
      input.policySnapshotId,
      JSON.stringify(input.subjectSummary),
      input.action,
      JSON.stringify(input.resourceSummary),
      JSON.stringify(input.contextSummary),
      input.result,
      input.reasonCode,
      input.enforcementPoint,
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
      auditEventId,
      category: 'approval',
      errorCode: permissionAuditErrorCode(input),
      itemId: optionalStringField(input.contextSummary, 'itemId'),
      now,
      outcome: permissionAuditOutcome(input.result),
      permissionDecisionId: input.decisionId,
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
      auditEventId,
      category: 'approval',
      errorCode: permissionAuditErrorCode(input),
      itemId: optionalStringField(input.contextSummary, 'itemId'),
      coreDb: input.coreDb,
      now,
      outcome: permissionAuditOutcome(input.result),
      permissionDecisionId: input.decisionId,
      requestId: optionalStringField(input.contextSummary, 'requestId'),
      resource: `permission:${input.action}`,
      severity: permissionAuditSeverity(input.result),
      summary: `Permission decision ${input.result}: ${input.action}`,
      threadId: optionalStringField(input.contextSummary, 'threadId'),
      turnId: optionalStringField(input.contextSummary, 'turnId'),
    });
  }
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
  decisions: readonly ExportedWorkspacePermissionDecision[]
): void {
  for (const decision of decisions) {
    if (decision.ownerScope !== 'workspace' || !decision.workspaceId) {
      throw new Error('Workspace permission decision import record must be workspace-scoped.');
    }

    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO permission_decisions (
          decision_id,
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
          required_approval_kind,
          approval_id,
          audit_event_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.decisionId,
        decision.ownerScope,
        decision.workspaceId,
        decision.policyEngineVersion,
        decision.policySnapshotId,
        JSON.stringify(decision.subjectSummary),
        decision.action,
        JSON.stringify(decision.resourceSummary),
        JSON.stringify(decision.contextSummary),
        decision.result,
        decision.reasonCode,
        decision.enforcementPoint,
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
    ? `aud_${randomUUID()}`
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
  if (row.owner_scope !== 'workspace' || !row.workspace_id) {
    throw new Error('Exported permission decision row must be workspace-scoped.');
  }

  return {
    action: row.action,
    approvalId: row.approval_id,
    auditEventId: row.audit_event_id,
    contextSummary: JSON.parse(row.context_summary_json) as unknown,
    createdAt: row.created_at,
    decisionId: row.decision_id,
    enforcementPoint: row.enforcement_point,
    ownerScope: 'workspace',
    policyEngineVersion: row.policy_engine_version,
    policySnapshotId: row.policy_snapshot_id,
    reasonCode: row.reason_code,
    requiredApprovalKind: row.required_approval_kind,
    resourceSummary: JSON.parse(row.resource_summary_json) as unknown,
    result: row.result,
    subjectSummary: JSON.parse(row.subject_summary_json) as unknown,
    workspaceId: row.workspace_id,
  };
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
  if (row.owner_scope !== 'server' || row.workspace_id !== null) {
    throw new Error('Server permission decision row must be server-scoped.');
  }

  return {
    action: row.action,
    approvalId: row.approval_id,
    auditEventId: row.audit_event_id,
    contextSummary: JSON.parse(row.context_summary_json) as unknown,
    createdAt: row.created_at,
    decisionId: row.decision_id,
    enforcementPoint: row.enforcement_point,
    ownerScope: 'server',
    policyEngineVersion: row.policy_engine_version,
    policySnapshotId: row.policy_snapshot_id,
    reasonCode: row.reason_code,
    requiredApprovalKind: row.required_approval_kind,
    resourceSummary: JSON.parse(row.resource_summary_json) as unknown,
    result: row.result,
    subjectSummary: JSON.parse(row.subject_summary_json) as unknown,
    workspaceId: null,
  };
}

/**
 * Records one LLM gateway policy decision.
 *
 * @param input Gateway policy decision input.
 */
export function recordGatewayPolicyDecision(input: RecordGatewayPolicyDecisionInput): void {
  recordProductPermissionDecision({
    coreDb: input.coreDb,
    decisionId: `pd_${randomUUID()}`,
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
 * Records an allowed Goal Mode worker launch decision.
 *
 * @param input Worker launch decision input.
 */
export function recordGoalWorkerLaunchDecision(input: RecordGoalWorkerLaunchDecisionInput): void {
  recordProductPermissionDecision({
    workspaceDb: input.workspaceDb,
    decisionId: `pd_${randomUUID()}`,
    ownerScope: 'workspace',
    workspaceId: input.workspaceId,
    policyEngineVersion: 'nanocore-goal-worker-policy:v1',
    policySnapshotId: 'goal_worker_launch_policy',
    subjectSummary: { kind: 'nanocore', id: 'goal-coordinator' },
    action: 'runtime.launch',
    resourceSummary: {
      kind: 'goal-task-worker',
      goalId: input.goalId,
      taskId: input.taskId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    },
    contextSummary: { mode: 'goal' },
    result: 'allow',
    reasonCode: 'goal_worker_start_allowed',
    enforcementPoint: input.enforcementPoint,
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
    decisionId: `pd_${randomUUID()}`,
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
 * Records the boot policy kernel baseline allow and deny decisions.
 *
 * @param input Boot policy self-check recording input.
 */
export function recordBootPolicySelfCheckDecisions(
  input: RecordBootPolicySelfCheckDecisionsInput
): void {
  const coreApiRequest = {
    process: 'process:nanocore',
    operation: 'api.call',
    target: 'object:nanocore',
  };
  const vaultUseRequest = {
    process: 'process:nanocore',
    operation: 'vault.use',
    target: 'object:baseline-vault-secret',
  };

  recordPermissionDecision({
    coreDb: input.coreDb,
    decisionId: `${input.bootId}_policy_core_api_call`,
    ownerScope: 'server',
    policyDecision: input.kernel.evaluate(coreApiRequest),
    policyEngineVersion: 'policy-kernel:v1',
    policySnapshotId: 'policy_snapshot_boot_baseline',
    subjectSummary: { id: coreApiRequest.process, kind: 'process' },
    action: coreApiRequest.operation,
    resourceSummary: { id: coreApiRequest.target, kind: 'core-api' },
    contextSummary: { boot: true },
    enforcementPoint: 'boot.policy.self_check',
    ...(input.now ? { now: input.now } : {}),
  });
  recordPermissionDecision({
    coreDb: input.coreDb,
    decisionId: `${input.bootId}_policy_vault_use`,
    ownerScope: 'server',
    policyDecision: input.kernel.evaluate(vaultUseRequest),
    policyEngineVersion: 'policy-kernel:v1',
    policySnapshotId: 'policy_snapshot_boot_baseline',
    subjectSummary: { id: vaultUseRequest.process, kind: 'process' },
    action: vaultUseRequest.operation,
    resourceSummary: { id: vaultUseRequest.target, kind: 'vault-reference' },
    contextSummary: { boot: true },
    enforcementPoint: 'boot.policy.self_check',
    ...(input.now ? { now: input.now } : {}),
  });
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
