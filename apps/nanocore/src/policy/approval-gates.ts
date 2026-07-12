import { randomUUID } from 'node:crypto';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { recordProductPermissionDecision } from './permission-decisions.js';

/** Input for creating one policy-originated approval gate. */
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
  decisionId?: string;
  /** Stable approval request id. */
  approvalId?: string;
  /** Stable approval item id. */
  approvalItemId?: string;
  /** Product action being gated. */
  action?: string;
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

/** Result from creating one policy-originated approval gate. */
export interface CreatePolicyApprovalGateResult {
  /** Created permission decision id. */
  decisionId: string;
  /** Created approval request id. */
  approvalId: string;
  /** Created approval item id. */
  approvalItemId: string;
}

/**
 * Creates a policy-originated approval gate using existing approval and Action Center records.
 *
 * @param input Approval gate input.
 * @returns Created record ids.
 */
export function createPolicyApprovalGate(
  input: CreatePolicyApprovalGateInput
): CreatePolicyApprovalGateResult {
  const turn = input.store.getTurnById(input.turnId);
  const createdAt = (input.now ?? new Date()).toISOString();
  const decisionId = input.decisionId ?? `pd_${randomUUID()}`;
  const approvalId = input.approvalId ?? `ap_${randomUUID()}`;
  const approvalItemId = input.approvalItemId ?? `it_${randomUUID()}`;

  recordProductPermissionDecision({
    workspaceDb: input.workspaceDb,
    decisionId,
    ownerScope: 'workspace',
    workspaceId: input.workspaceId,
    policyEngineVersion: 'nanocore-approval-policy:v1',
    policySnapshotId: 'policy_snapshot_runtime',
    subjectSummary: input.subjectSummary,
    action: input.action ?? 'policy.approval_required',
    resourceSummary: input.resourceSummary,
    contextSummary: input.contextSummary ?? {
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: input.workspaceId,
    },
    result: 'require_approval',
    reasonCode: input.reasonCode,
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
    status: 'pending',
    title: input.title,
    description: input.description,
    createdAt,
    resolvedAt: null,
  });
  input.store.createItem({
    id: approvalItemId,
    workspaceId: input.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'approval-request',
    status: 'in_progress',
    approvalRequestId: approvalId,
    title: input.title,
    description: input.description,
    kind: 'permission',
    createdAt,
    completedAt: null,
  });
  input.store.updateTurn(turn.id, {
    status: 'awaiting_human',
    humanGate: {
      kind: 'approval',
      approvalRequestId: approvalId,
      itemId: approvalItemId,
    },
  });

  return { decisionId, approvalId, approvalItemId };
}
