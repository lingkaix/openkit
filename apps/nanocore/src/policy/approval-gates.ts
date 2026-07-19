import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { recordProductPermissionDecision } from './permission-decisions.js';

/** Input for creating one Git push policy approval gate. */
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

/** Result from creating one Git push policy approval gate. */
export interface CreatePolicyApprovalGateResult {
  /** Created permission decision id. */
  decisionId: string;
  /** Created approval request id. */
  approvalId: string;
  /** Created approval item id. */
  approvalItemId: string;
}

/**
 * Creates a Git push policy approval gate using existing approval and Action Center records.
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

  const turn = input.store.getTurnById(input.turnId);
  if (
    turn.workspaceId !== input.workspaceId ||
    turn.status !== 'running' ||
    turn.humanGate !== null
  ) {
    throw new Error('Git push approval requires one exact running Turn owner.');
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
    policySnapshotId: 'policy_snapshot_runtime',
    subjectSummary: input.subjectSummary,
    action: 'repo.push',
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
    status: 'completed',
    approvalRequestId: approvalId,
    title: input.title,
    description: input.description,
    kind: 'permission',
    createdAt,
    completedAt: createdAt,
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
