import { isDeepStrictEqual } from 'node:util';

import type { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import type { WorkspaceDb } from '../storage/db.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import {
  type PolicyApprovalSourceDecision,
  recordProductPermissionDecision,
} from './permission-decisions.js';

/** Exact lifetime of one MCP proposed-effect Approval. */
export const MCP_APPROVAL_TTL_MS = 60 * 60 * 1_000;

/** Input for creating one policy approval gate. */
export interface CreatePolicyApprovalGateInput {
  /** Workspace-scope database that owns the permission decision. */
  workspaceDb: WorkspaceDb;
  /** App-local store that owns turn and approval records. */
  store: FsStore;
  /** Workspace that owns the gated turn. */
  workspaceId: string;
  /** Turn that should pause on approval. */
  turnId: string;
  /** Stable permission decision id. */
  decisionId: string;
  /** Stable approval request id. */
  approvalId: string;
  /** Stable approval item id. */
  approvalItemId: string;
  /** Product action requiring approval. */
  action: 'repo.push' | 'tool.use';
  /** Worker auto-grants preserve the active Turn; App requests complete their holder Turn. */
  autoAllowTurn?: 'complete' | 'continue';
  /** Deployment-selected mode; automatic grants are supported only for repo.push. */
  mode?: 'require_human_approval' | 'auto_allow';
  /** Machine-readable policy reason. */
  reasonCode: string;
  /** Approval title shown to the operator. */
  title: string;
  /** Approval description shown to the operator. */
  description: string;
  /** Redacted subject summary. */
  subjectSummary: unknown;
  /** Redacted resource summary. */
  resourceSummary: unknown;
  /** Redacted context summary. */
  contextSummary?: unknown;
  /** Creation time for deterministic tests. */
  now?: Date;
}

/** Result from creating one policy approval gate. */
export interface CreatePolicyApprovalGateResult {
  /** Created permission decision id. */
  decisionId: string;
  /** Created approval request id. */
  approvalId: string;
  /** Created approval item id. */
  approvalItemId: string;
}

/**
 * Records a policy grant or human approval gate using existing approval and Action Center records.
 *
 * @param input Approval gate input.
 * @returns Created record ids.
 * @throws Error when the Approval id is reserved for imported history or the Turn is not the exact running owner for a new Gate.
 */
export function createPolicyApprovalGate(
  input: CreatePolicyApprovalGateInput
): CreatePolicyApprovalGateResult {
  if (!isTargetIssuedEffectAuthority(input.approvalId)) {
    throw new Error('Approval id uses the reserved portable-import authority namespace.');
  }

  const autoAllow = input.mode === 'auto_allow';
  if (autoAllow && input.action !== 'repo.push') {
    throw new Error('Automatic policy approval is supported only for repo.push.');
  }
  const turn = input.store.getTurnById(input.turnId);
  if (
    turn.workspaceId !== input.workspaceId ||
    turn.status !== 'running' ||
    turn.humanGate !== null
  ) {
    throw new Error('Policy approval requires one exact running Turn owner.');
  }
  const createdAt = (input.now ?? new Date()).toISOString();
  const decisionId = input.decisionId;
  const approvalId = input.approvalId;
  const approvalItemId = input.approvalItemId;

  recordProductPermissionDecision({
    workspaceDb: input.workspaceDb,
    decisionId,
    ownerScope: 'workspace',
    workspaceId: input.workspaceId,
    policyEngineVersion: 'nanocore-approval-policy:v1',
    policySnapshotId: autoAllow ? 'repo_push:auto_allow:v1' : 'policy_snapshot_runtime',
    subjectSummary: input.subjectSummary,
    action: input.action,
    resourceSummary: input.resourceSummary,
    contextSummary: input.contextSummary ?? {
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: input.workspaceId,
    },
    result: autoAllow ? 'allow' : 'require_approval',
    reasonCode: autoAllow ? 'repo_push_auto_allowed' : input.reasonCode,
    enforcementPoint: 'policy.approval_gate',
    requiredApprovalKind: 'permission',
    approvalId,
    ...(input.now ? { now: input.now } : {}),
  });

  input.store.createApproval({
    id: approvalId,
    workspaceId: input.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    kind: 'permission',
    status: autoAllow ? 'granted' : 'pending',
    title: input.title,
    description: input.description,
    createdAt,
    resolvedAt: autoAllow ? createdAt : null,
  });
  input.store.createItem({
    id: approvalItemId,
    workspaceId: input.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'approval-request',
    status: 'completed',
    approvalRequestId: approvalId,
    title: input.title,
    description: input.description,
    kind: 'permission',
    createdAt,
    completedAt: createdAt,
  });
  if (autoAllow && input.autoAllowTurn === 'continue') {
    input.store.createItem({
      id: `it_policy_auto_grant_${approvalId}`,
      workspaceId: input.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-decision',
      actor: { kind: 'system', id: 'nanocore-repo-push-policy', responsibleUserId: null },
      causationId: approvalItemId,
      status: 'completed',
      approvalRequestId: approvalId,
      decision: 'granted',
      createdAt,
      completedAt: createdAt,
    });
    return { decisionId, approvalId, approvalItemId };
  }
  input.store.updateTurn(
    turn.id,
    autoAllow
      ? {
          status: 'completed',
          humanGate: null,
          completedAt: createdAt,
        }
      : {
          status: 'awaiting_human',
          humanGate: {
            kind: 'approval',
            approvalRequestId: approvalId,
            itemId: approvalItemId,
          },
        }
  );

  return { decisionId, approvalId, approvalItemId };
}

/**
 * Validates the exact MCP denial ledger chain that owns one tool approval Gate.
 *
 * @param input Stored source decision and expected Product lineage.
 * @returns True only when the source, denied CapabilityCall, and terminal Audit agree exactly.
 */
export function isExactMcpApprovalSourceDecision(input: {
  readonly approvalCreatedAt: string;
  readonly source: PolicyApprovalSourceDecision;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): boolean {
  const {
    contextSummary: context,
    resourceSummary: resource,
    subjectSummary: subject,
  } = input.source;
  if (
    input.source.action !== 'tool.use' ||
    input.source.requiredApprovalKind !== 'permission' ||
    !isRecord(context) ||
    !isRecord(resource) ||
    !isRecord(subject) ||
    !hasExactKeys(context, [
      'agentSessionId',
      'capabilityCallId',
      'packageSnapshotId',
      'threadId',
      'turnId',
      'workspaceId',
    ]) ||
    !hasExactKeys(resource, [
      'agentId',
      'argumentsDigest',
      'catalogEntryRevision',
      'expiresAt',
      'kind',
      'responsibleUserId',
      'schemaSnapshotId',
      'serverId',
      'threadId',
      'toolName',
      'workspaceId',
    ]) ||
    typeof context.agentSessionId !== 'string' ||
    typeof context.capabilityCallId !== 'string' ||
    typeof context.packageSnapshotId !== 'string' ||
    context.workspaceId !== input.workspaceId ||
    context.threadId !== input.threadId ||
    context.turnId !== input.turnId ||
    resource.kind !== 'mcp-tool-call' ||
    resource.workspaceId !== input.workspaceId ||
    resource.threadId !== input.threadId ||
    !Number.isFinite(Date.parse(input.approvalCreatedAt)) ||
    !Number.isFinite(Date.parse(String(resource.expiresAt))) ||
    Date.parse(String(resource.expiresAt)) !==
      Date.parse(input.approvalCreatedAt) + MCP_APPROVAL_TTL_MS ||
    Date.parse(String(resource.expiresAt)) <= Date.now() ||
    ![
      resource.agentId,
      resource.argumentsDigest,
      resource.catalogEntryRevision,
      resource.expiresAt,
      resource.responsibleUserId,
      resource.schemaSnapshotId,
      resource.serverId,
      resource.toolName,
    ].every((value) => typeof value === 'string') ||
    !isDeepStrictEqual(subject, {
      agentId: resource.agentId,
      responsibleUserId: resource.responsibleUserId,
    })
  ) {
    return false;
  }

  return hasExactMcpDenial(input, context, resource);
}

/** Compares the existing denied MCP call and its atomic terminal audit to exact expected lineage. */
function hasExactMcpDenial(
  input: {
    readonly workspaceDb: WorkspaceDb;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
  },
  context: Record<string, unknown>,
  resource: Record<string, unknown>
): boolean {
  const rows = input.workspaceDb.sqlite
    .prepare(
      `SELECT
        call.call_id,
        call.workspace_id,
        call.thread_id,
        call.turn_id,
        call.item_id,
        call.agent_id,
        call.agent_session_id,
        call.package_snapshot_id,
        call.schema_snapshot_id,
        call.request_id,
        call.source_ids_json,
        call.capability_id,
        call.family,
        call.operation,
        call.provider_ref,
        call.service_ref,
        call.redaction_class,
        call.status,
        call.error_code,
        call.completed_at,
        audit.workspace_id AS audit_workspace_id,
        audit.thread_id AS audit_thread_id,
        audit.turn_id AS audit_turn_id,
        audit.item_id AS audit_item_id,
        audit.capability_call_id AS audit_capability_call_id,
        audit.request_id AS audit_request_id,
        audit.agent_id AS audit_agent_id,
        audit.agent_session_id AS audit_agent_session_id,
        audit.category AS audit_category,
        audit.action AS audit_action,
        audit.resource AS audit_resource,
        audit.outcome AS audit_outcome,
        audit.severity AS audit_severity,
        audit.error_code AS audit_error_code
      FROM capability_calls AS call
      LEFT JOIN audit_events AS audit
        ON audit.capability_call_id = call.call_id
       AND audit.action = 'capability.finish'
      WHERE call.call_id = ?`
    )
    .all(context.capabilityCallId as string) as Array<Record<string, string | null>>;
  const row = rows[0];
  return Boolean(
    rows.length === 1 &&
      row &&
      typeof context.capabilityCallId === 'string' &&
      context.capabilityCallId.startsWith('cap_mcp_') &&
      row.workspace_id === input.workspaceId &&
      row.thread_id === input.threadId &&
      row.turn_id === input.turnId &&
      typeof row.item_id === 'string' &&
      row.agent_id === resource.agentId &&
      row.agent_session_id === context.agentSessionId &&
      row.package_snapshot_id === context.packageSnapshotId &&
      row.schema_snapshot_id === resource.schemaSnapshotId &&
      row.request_id === null &&
      row.source_ids_json === '[]' &&
      row.capability_id === 'mcp.call_tool' &&
      row.family === 'mcp' &&
      row.operation === 'mcp.call_tool' &&
      row.provider_ref === resource.serverId &&
      row.service_ref === `mcp-tool:${resource.toolName}` &&
      row.redaction_class === 'metadata-only' &&
      row.status === 'denied' &&
      row.error_code === 'mcp-denied' &&
      row.completed_at !== null &&
      row.audit_workspace_id === row.workspace_id &&
      row.audit_thread_id === row.thread_id &&
      row.audit_turn_id === row.turn_id &&
      row.audit_item_id === row.item_id &&
      row.audit_capability_call_id === row.call_id &&
      row.audit_request_id === null &&
      row.audit_agent_id === row.agent_id &&
      row.audit_agent_session_id === row.agent_session_id &&
      row.audit_category === 'capability' &&
      row.audit_action === 'capability.finish' &&
      row.audit_resource === 'capability:mcp.call_tool' &&
      row.audit_outcome === 'denied' &&
      row.audit_severity === 'warning' &&
      row.audit_error_code === 'mcp-denied'
  );
}

/** Returns true for one plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Returns true when an object has exactly the expected keys. */
function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

/**
 * Verifies the exact denied selected-capability call and request receipt before a Worker Gate is actionable.
 * @param input Stored approval owner, current product scope and receipt store.
 * @returns Whether existing MCP or repository evidence proves the exact original worker request.
 */
export function isExactWorkerApprovalSourceDecision(
  input: Parameters<typeof isExactMcpApprovalSourceDecision>[0] & {
    readonly store: FsStore;
    readonly approvalId: string;
    readonly approvalItemId: string;
  }
): boolean {
  if (input.source.action === 'tool.use') return isExactMcpApprovalSourceDecision(input);
  const {
    contextSummary: context,
    resourceSummary: resource,
    subjectSummary: subject,
  } = input.source;
  if (
    input.source.action !== 'repo.push' ||
    input.source.requiredApprovalKind !== 'permission' ||
    !isRecord(context) ||
    !isRecord(resource) ||
    !isRecord(subject) ||
    !isRecord(context.worker) ||
    !hasExactKeys(context, [
      'commandTurnId',
      'requestId',
      'threadId',
      'turnId',
      'worker',
      'workspaceId',
    ]) ||
    !hasExactKeys(context.worker, [
      'agentId',
      'agentSessionId',
      'packageSnapshotId',
      'capabilityCallId',
    ]) ||
    !hasExactKeys(subject, ['kind', 'userId']) ||
    subject.kind !== 'user' ||
    typeof subject.userId !== 'string' ||
    !hasExactKeys(resource, [
      'kind',
      'workspaceId',
      'repositoryResourceId',
      'remoteIdentity',
      'remoteName',
      'sourceRef',
      'sourceCommit',
      'targetBranch',
      'commitIds',
      'remoteSummary',
    ]) ||
    context.workspaceId !== input.workspaceId ||
    context.threadId !== input.threadId ||
    context.turnId !== input.turnId ||
    typeof context.commandTurnId !== 'string' ||
    context.commandTurnId !== input.turnId ||
    resource.kind !== 'git-push-target' ||
    resource.workspaceId !== input.workspaceId ||
    resource.remoteName !== 'origin' ||
    !Object.values(context.worker).every(
      (value) => typeof value === 'string' && value.length > 0
    ) ||
    typeof context.requestId !== 'string' ||
    typeof resource.repositoryResourceId !== 'string' ||
    !Array.isArray(resource.commitIds) ||
    resource.commitIds.length === 0 ||
    resource.commitIds.at(-1) !== resource.sourceCommit
  )
    return false;
  const scope = {
    actorId: subject.userId,
    workspaceId: input.workspaceId,
    repositoryResourceId: resource.repositoryResourceId,
    threadId: input.threadId,
    turnId: context.commandTurnId,
  };
  const digest = commandInputHash({
    command: 'git_push.approval.request',
    ...scope,
    requestId: context.requestId,
  }).slice('sha256:'.length);
  if (
    input.approvalId !== `ap_repo_push_${digest}` ||
    input.approvalItemId !== `it_repo_push_${digest}`
  )
    return false;
  try {
    const turn = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);
    const session = input.store.getAgentSession(String(context.worker.agentSessionId));
    const approval = input.store.getApproval(input.approvalId);
    const item = input.store
      .listThreadItems(input.workspaceId, input.threadId)
      .find((candidate) => candidate.id === input.approvalItemId);
    if (
      turn.agentSessionId !== context.worker.agentSessionId ||
      session.environmentPackageSnapshotId !== context.worker.packageSnapshotId ||
      session.agentId !== context.worker.agentId ||
      session.workspaceId !== input.workspaceId ||
      session.threadId !== input.threadId ||
      approval.workspaceId !== input.workspaceId ||
      approval.threadId !== input.threadId ||
      approval.turnId !== input.turnId ||
      approval.createdAt !== input.approvalCreatedAt ||
      item?.type !== 'approval-request' ||
      item.approvalRequestId !== input.approvalId ||
      item.turnId !== input.turnId
    )
      return false;
  } catch {
    return false;
  }
  const receipt = input.store.getCommandRequest(
    'git_push.approval.request',
    context.requestId,
    scope
  );
  if (
    receipt?.response.kind !== 'approval' ||
    receipt.response.id !== `ap_repo_push_${digest}` ||
    receipt.inputHash !==
      commandInputHash({
        requestId: context.requestId,
        threadId: input.threadId,
        turnId: context.commandTurnId,
        sourceRef: resource.sourceRef,
        targetBranch: resource.targetBranch,
        commitIds: resource.commitIds,
      })
  )
    return false;
  return hasExactMcpDenial(
    input,
    { ...context, ...context.worker },
    {
      agentId: context.worker.agentId,
      schemaSnapshotId: null,
      serverId: 'openkit-repository',
      toolName: 'repository_push_request_approval',
    }
  );
}
