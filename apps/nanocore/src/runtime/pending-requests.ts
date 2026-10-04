import { isDeepStrictEqual } from 'node:util';
import {
  ApprovalRequestSchema,
  type Item,
  isSealedTurnTerminal,
  responsibleUserIdForActor,
  type TurnSchema,
} from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import type { CommandRequestRecord } from '../lib/store.js';
import { commandInputHash } from './idempotent-command.js';
import { mcpToolArgumentsContentDigest } from './mcp-tool-schema-snapshots.js';

type ApprovalRequest = import('zod').infer<typeof ApprovalRequestSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;

import type Database from 'better-sqlite3';

import { listExistingWorkspaceDatabaseScopes, openWorkspaceDb } from '../storage/db.js';

/** Pending requests one Thread may hold at once. */
export const PENDING_REQUEST_BOUND = 16;

/** Ready outcomes one delivering Turn may freeze. */
export const OUTCOME_DELIVERY_BOUND = 16;

/** Sentence carried in every pending tool result. */
export const PENDING_REQUEST_NEXT_STEP =
  'The outcome arrives on a later Turn. Do not call again to claim it.';

/** Creates the existing Core actor for pending-request publication and machine input. */
export function pendingRequestSystemActor(responsibleUserId: string | null): {
  kind: 'system';
  id: string;
  responsibleUserId: string | null;
} {
  return { kind: 'system', id: 'nanocore-pending-request', responsibleUserId };
}

/** Closed failure raised by a pending-request command before any record write. */
export class PendingRequestCommandError extends Error {
  /** Stable API error code. */
  public readonly code: string;

  /** HTTP status for the command failure. */
  public readonly status: number;

  /**
   * Creates one command failure.
   *
   * @param code Stable API code.
   * @param message Product-safe message.
   * @param status HTTP status.
   */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'PendingRequestCommandError';
    this.code = code;
    this.status = status;
  }
}

/** Identifies captured command intent independently of who requested it. */
export function isCommandIntentApproval(
  record: Pick<PendingRequestRecord, 'kind' | 'serverId' | 'governedIntent'>
): boolean {
  return record.kind === 'approval' && record.serverId === null && record.governedIntent !== null;
}

/** Ends only pending requests of the named Goal; granted intents remain for owner re-evaluation. */
export function invalidateGoalPendingRequests(
  sqlite: Database.Database,
  goalId: string,
  reason: string,
  actor: PendingRequestActor,
  now: string,
  plansOnly = false
): number {
  return sqlite.transaction(() => {
    const rows = sqlite
      .prepare(`SELECT ${SELECT_COLUMNS} FROM pending_requests WHERE state = 'pending'`)
      .all() as PendingRequestRow[];
    let count = 0;
    for (const row of rows) {
      const record = parsePendingRequestRow(row);
      if (
        !isCommandIntentApproval(record) ||
        record.governedIntent?.goalId !== goalId ||
        (plansOnly && record.governedIntent.operation !== 'goal.plan.approve')
      )
        continue;
      if (invalidatePendingRequest(sqlite, record.requestId, reason, actor, now)) count++;
    }
    return count;
  })();
}

/** Records a refused unclaimed command intent without rewriting its recorded grant. */
export function refuseCommandIntentGrant(
  sqlite: Database.Database,
  requestId: string,
  reason: string,
  now: string
): PendingRequestRecord | null {
  const changed = sqlite
    .prepare(
      `UPDATE pending_requests SET disposition = 'denied-not-executed', disposition_reason = ?, updated_at = ? WHERE request_id = ? AND state = 'resolved' AND resolution = 'granted' AND claim = 'unclaimed' AND disposition IS NULL AND server_id IS NULL AND governed_intent_json IS NOT NULL`
    )
    .run(reason, now, requestId);
  return changed.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
}

/** Who asked. */
export type PendingRequesterKind = 'worker' | 'assistant' | 'coordinator' | 'person';

/** Record kind. */
export type PendingRequestKind = 'approval' | 'user-input';

/** Lifecycle state. */
export type PendingRequestState = 'pending' | 'resolved' | 'ended';

/** Resolution written with the deciding actor. */
export type PendingRequestResolution = 'granted' | 'denied' | 'answered';

/** How an unresolved request ended. */
export type PendingRequestEnding = 'withdrawn' | 'invalidated';

/** Execution claim. */
export type PendingRequestClaim = 'unclaimed' | 'claimed' | 'finished';

/** Execution disposition. */
export type PendingRequestDisposition =
  | 'approved-executed'
  | 'denied-not-executed'
  | 'execution-error'
  | 'outcome-unknown';

/** Delivery of one final outcome. */
export type PendingRequestDelivery =
  | 'undelivered'
  | 'frozen'
  | 'delivered'
  | 'delivery-unknown'
  | 'closed-out';

/** Why a delivering Turn froze the outcome. */
export type PendingDeliveryCause = 'outcome' | 'carried';

/** Executor that may receive an outcome. */
export type PendingExecutorKind = 'worker' | 'assistant' | 'coordinator' | 'person';

/** Actor recorded on a decision or ending. */
export interface PendingRequestActor {
  /** Actor kind. */
  readonly kind: 'user' | 'system';
  /** Actor id. */
  readonly id: string;
}

/** Originating authorization captured with an agent call. */
export interface PendingAuthorizationContext {
  /** Thread that owned the call. */
  readonly threadId: string;
  /** Turn that raised the call. */
  readonly turnId: string;
  /** AgentSession that raised the call, when the requester is an agent. */
  readonly agentSessionId: string | null;
  /** Agent that raised the call. */
  readonly agentId: string | null;
  /** Responsible user. */
  readonly responsibleUserId: string;
  /** Package digest captured with the call. */
  readonly packageDigest: string | null;
  /** Policy decision captured with the call. */
  readonly policyDecisionId: string | null;
}

/** Qualified binding used to deduplicate a pending approval call. */
export interface PendingCallBinding {
  /** MCP or built-in server id. */
  readonly serverId: string;
  /** Catalog revision captured with the call. */
  readonly catalogRevision: string;
  /** Schema snapshot captured with the call. */
  readonly schemaSnapshotId: string;
  /** Tool name. */
  readonly toolName: string;
  /** Digest of the canonical arguments. */
  readonly argumentsDigest: string;
  /** Requesting agent. */
  readonly agentId: string;
  /** Responsible user. */
  readonly responsibleUserId: string;
}

/** Durable pending-request record. Items are communication only. */
export interface PendingRequestRecord {
  /** Request id. Approval ids and user-input ids share this field. */
  readonly requestId: string;
  /** Workspace. */
  readonly workspaceId: string;
  /** Thread. */
  readonly threadId: string;
  /** Turn that raised the request. */
  readonly raisingTurnId: string;
  /** Request Item id on the raising Turn. */
  readonly requestItemId: string;
  /** Approval or user-input. */
  readonly kind: PendingRequestKind;
  /** Who asked. */
  readonly requesterKind: PendingRequesterKind;
  /** Agent id when an agent asked. */
  readonly agentId: string | null;
  /** AgentSession id when an agent asked. */
  readonly agentSessionId: string | null;
  /** Responsible user. */
  readonly responsibleUserId: string;
  /** Lifecycle state. */
  readonly state: PendingRequestState;
  /** Resolution, absent until resolved. */
  readonly resolution: PendingRequestResolution | null;
  /** Deciding actor. */
  readonly decidingActor: PendingRequestActor | null;
  /** Non-secret credential identity retained so the effect owner can recheck revocation at claim. */
  readonly decidingActorContext: Actor | null;
  /** Decision or answer time. */
  readonly decidedAt: string | null;
  /** Answer map for a user-input resolution. */
  readonly answerMap: Readonly<Record<string, readonly [string]>> | null;
  /** Ending, absent until the request ends unresolved. */
  readonly ending: PendingRequestEnding | null;
  /** Invalidating event when the ending is invalidated. */
  readonly invalidatingEvent: string | null;
  /** Ending actor. */
  readonly endingActor: PendingRequestActor | null;
  /** Ending time. */
  readonly endedAt: string | null;
  /** Captured server id. */
  readonly serverId: string | null;
  /** Captured catalog revision. */
  readonly catalogRevision: string | null;
  /** Captured schema snapshot. */
  readonly schemaSnapshotId: string | null;
  /** Captured tool name. */
  readonly toolName: string | null;
  /** Canonical arguments JSON text. */
  readonly canonicalArgumentsJson: string | null;
  /** Arguments digest. */
  readonly argumentsDigest: string | null;
  /** Package digest. */
  readonly packageDigest: string | null;
  /** Policy decision id. */
  readonly policyDecisionId: string | null;
  /** Originating authorization context. */
  readonly authorizationContext: PendingAuthorizationContext | null;
  /** Exact governed-command intent for a command-intent approval. */
  readonly governedIntent: Readonly<Record<string, unknown>> | null;
  /** Questions for a user-input request. */
  readonly questions: readonly Readonly<Record<string, unknown>>[] | null;
  /** Approval projection kind. */
  readonly approvalKind: 'permission' | 'destructive-action' | null;
  /** Approval title. */
  readonly title: string | null;
  /** Approval description. */
  readonly description: string | null;
  /** Execution claim. */
  readonly claim: PendingRequestClaim;
  /** CapabilityCall id derived from the request id when claimed. */
  readonly executionCallId: string | null;
  /** Execution disposition. */
  readonly disposition: PendingRequestDisposition | null;
  /** Bounded reason for the disposition. */
  readonly dispositionReason: string | null;
  /** Bounded result held until delivery is proved. */
  readonly heldResult: unknown;
  /** Publication Turn, set once. */
  readonly publicationTurnId: string | null;
  /** Invalidation Turn for a command-intent grant, set once. */
  readonly invalidationTurnId: string | null;
  /** Delivery state. */
  readonly delivery: PendingRequestDelivery;
  /** Turn that froze or proved delivery. */
  readonly deliveryTurnId: string | null;
  /** Why that Turn froze the outcome. */
  readonly deliveryCause: PendingDeliveryCause | null;
  /** Creation time. */
  readonly createdAt: string;
  /** Update time. */
  readonly updatedAt: string;
}

/** Fields supplied when a request is raised. */
export interface RaisePendingRequestInput {
  /** Request id. */
  readonly requestId: string;
  /** Workspace. */
  readonly workspaceId: string;
  /** Thread. */
  readonly threadId: string;
  /** Raising Turn. */
  readonly raisingTurnId: string;
  /** Request Item id. */
  readonly requestItemId: string;
  /** Kind. */
  readonly kind: PendingRequestKind;
  /** Requester. */
  readonly requesterKind: PendingRequesterKind;
  /** Agent id when an agent asked. */
  readonly agentId?: string | null;
  /** AgentSession id when an agent asked. */
  readonly agentSessionId?: string | null;
  /** Responsible user. */
  readonly responsibleUserId: string;
  /** Captured call binding for an agent approval. */
  readonly call?: {
    readonly serverId: string;
    readonly catalogRevision: string;
    readonly schemaSnapshotId: string;
    readonly toolName: string;
    readonly canonicalArgumentsJson: string;
    readonly argumentsDigest: string;
    readonly packageDigest: string | null;
    readonly policyDecisionId: string | null;
    readonly authorizationContext: PendingAuthorizationContext;
  };
  /** Exact governed-command intent. */
  readonly governedIntent?: Readonly<Record<string, unknown>> | null;
  /** User-input questions. */
  readonly questions?: readonly Readonly<Record<string, unknown>>[] | null;
  /** Canonical question payload used for deduplication. */
  readonly questionDigest?: string | null;
  /** Approval kind, title, and description. */
  readonly approval?: {
    readonly kind: 'permission' | 'destructive-action';
    readonly title: string;
    readonly description: string;
  };
  /** Creation time. */
  readonly now: string;
}

/** Result of raising a request. */
export interface RaisedPendingRequest {
  /** Stored record. */
  readonly record: PendingRequestRecord;
  /** False when an existing pending request matched the qualified binding. */
  readonly created: boolean;
}

/** Synchronous grant evaluation inside the claim transaction. */
export type GrantEvaluation =
  | { readonly outcome: 'claim' }
  | { readonly outcome: 'refuse'; readonly reason: string }
  | {
      readonly outcome: 'end';
      readonly event: string;
      readonly actor: PendingRequestActor;
    };

/** Result of the synchronous grant step. */
export interface GrantStepResult {
  /** What the compare-and-set recorded. */
  readonly applied: 'claimed' | 'refused' | 'ended' | 'lost';
  /** Record after the step. */
  readonly record: PendingRequestRecord;
}

interface PendingRequestRow {
  request_id: string;
  workspace_id: string;
  thread_id: string;
  raising_turn_id: string;
  request_item_id: string;
  kind: string;
  requester_kind: string;
  agent_id: string | null;
  agent_session_id: string | null;
  responsible_user_id: string;
  state: string;
  resolution: string | null;
  deciding_actor_kind: string | null;
  deciding_actor_id: string | null;
  deciding_actor_context_json: string | null;
  decided_at: string | null;
  answer_map_json: string | null;
  ending: string | null;
  invalidating_event: string | null;
  ending_actor_kind: string | null;
  ending_actor_id: string | null;
  ended_at: string | null;
  server_id: string | null;
  catalog_revision: string | null;
  schema_snapshot_id: string | null;
  tool_name: string | null;
  canonical_arguments_json: string | null;
  arguments_digest: string | null;
  package_digest: string | null;
  policy_decision_id: string | null;
  authorization_context_json: string | null;
  governed_intent_json: string | null;
  questions_json: string | null;
  approval_kind: string | null;
  title: string | null;
  description: string | null;
  claim: string;
  execution_call_id: string | null;
  disposition: string | null;
  disposition_reason: string | null;
  held_result_json: string | null;
  publication_turn_id: string | null;
  invalidation_turn_id: string | null;
  delivery: string;
  delivery_turn_id: string | null;
  delivery_cause: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  request_id, workspace_id, thread_id, raising_turn_id, request_item_id, kind, requester_kind,
  agent_id, agent_session_id, responsible_user_id, state, resolution, deciding_actor_kind,
  deciding_actor_id, deciding_actor_context_json, decided_at, answer_map_json, ending, invalidating_event, ending_actor_kind,
  ending_actor_id, ended_at, server_id, catalog_revision, schema_snapshot_id, tool_name,
  canonical_arguments_json, arguments_digest, package_digest, policy_decision_id,
  authorization_context_json, governed_intent_json, questions_json, approval_kind, title,
  description, claim, execution_call_id, disposition, disposition_reason, held_result_json,
  publication_turn_id, invalidation_turn_id, delivery, delivery_turn_id, delivery_cause,
  created_at, updated_at
`;

const KINDS = new Set<PendingRequestKind>(['approval', 'user-input']);
const REQUESTERS = new Set<PendingRequesterKind>(['worker', 'assistant', 'coordinator', 'person']);
const STATES = new Set<PendingRequestState>(['pending', 'resolved', 'ended']);
const RESOLUTIONS = new Set<PendingRequestResolution>(['granted', 'denied', 'answered']);
const ENDINGS = new Set<PendingRequestEnding>(['withdrawn', 'invalidated']);
const CLAIMS = new Set<PendingRequestClaim>(['unclaimed', 'claimed', 'finished']);
const DISPOSITIONS = new Set<PendingRequestDisposition>([
  'approved-executed',
  'denied-not-executed',
  'execution-error',
  'outcome-unknown',
]);
const DELIVERIES = new Set<PendingRequestDelivery>([
  'undelivered',
  'frozen',
  'delivered',
  'delivery-unknown',
  'closed-out',
]);
const CAUSES = new Set<PendingDeliveryCause>(['outcome', 'carried']);
const ACTOR_KINDS = new Set(['user', 'system']);
const APPROVAL_KINDS = new Set<'permission' | 'destructive-action'>([
  'permission',
  'destructive-action',
]);

/**
 * Derives the execution CapabilityCall id from a request id.
 *
 * @param requestId Pending request id.
 * @returns Stable call id.
 */
export function executionCallIdForRequest(requestId: string): string {
  return `cap_pending_${requestId}`;
}

/**
 * Item id for one publication role.
 *
 * @param requestId Pending request id.
 * @param role Publication role.
 * @returns Stable Item id.
 */
export function pendingRequestItemId(
  requestId: string,
  role:
    | 'request'
    | 'decision'
    | 'answer'
    | 'disposition'
    | 'disposition-status'
    | 'ending'
    | 'invalidation'
): string {
  switch (role) {
    case 'request':
      return `it_request_${requestId}`;
    case 'decision':
      return `it_approval_decision_${requestId}`;
    case 'answer':
      return `it_user_input_response_${requestId}`;
    case 'disposition':
      return `it_disposition_${requestId}`;
    case 'disposition-status':
      return `it_disposition_status_${requestId}`;
    case 'ending':
      return `it_ending_${requestId}`;
    case 'invalidation':
      return `it_invalidation_${requestId}`;
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
}

/**
 * Canonical JSON text with sorted object keys and preserved array order.
 *
 * @param value JSON value.
 * @returns Canonical JSON text.
 */
export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

/**
 * Reads one request. An unknown core value fails closed as recovery_required.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @returns Record, or null when the id is absent.
 */
export function readPendingRequest(
  sqlite: Database.Database,
  requestId: string
): PendingRequestRecord | null {
  const row = sqlite
    .prepare(`SELECT ${SELECT_COLUMNS} FROM pending_requests WHERE request_id = ?`)
    .get(requestId) as PendingRequestRow | undefined;
  return row ? parsePendingRequestRow(row) : null;
}

/**
 * Lists one Thread's requests in creation order.
 *
 * @param sqlite Workspace database.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @returns Records on that Thread.
 */
export function listThreadPendingRequests(
  sqlite: Database.Database,
  workspaceId: string,
  threadId: string
): PendingRequestRecord[] {
  const rows = sqlite
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM pending_requests
       WHERE workspace_id = ? AND thread_id = ?
       ORDER BY created_at ASC, request_id ASC`
    )
    .all(workspaceId, threadId) as PendingRequestRow[];
  return rows.flatMap((row) => {
    try {
      return [parsePendingRequestRow(row)];
    } catch {
      return [];
    }
  });
}

/**
 * Deletes one row after a later Item write fails. The request was never visible as raised.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 */
export function deletePendingRequest(sqlite: Database.Database, requestId: string): void {
  sqlite.prepare('DELETE FROM pending_requests WHERE request_id = ?').run(requestId);
}

/**
 * Raises a request or returns the pending duplicate. The seventeenth pending request fails before a write.
 *
 * @param sqlite Workspace database.
 * @param input Raise input.
 * @returns Created or matched record.
 */
export function raisePendingRequest(
  sqlite: Database.Database,
  input: RaisePendingRequestInput
): RaisedPendingRequest {
  const raise = sqlite.transaction(() => {
    const existing = preflightPendingRequest(sqlite, input);
    if (existing) return { record: existing, created: false };
    insertPendingRequest(sqlite, input);
    const created = readPendingRequest(sqlite, input.requestId);
    if (!created) {
      throw new PendingRequestCommandError(
        'recovery_required',
        'The pending request was not readable after its write.',
        409
      );
    }
    return { record: created, created: true };
  });
  return raise();
}

/** Checks duplicates and the per-Thread bound before any call admission or request write. */
export function preflightPendingRequest(
  sqlite: Database.Database,
  input: RaisePendingRequestInput
): PendingRequestRecord | null {
  const existing = readPendingRequest(sqlite, input.requestId);
  if (existing) {
    if (!sameRaiseIdentity(existing, input)) {
      throw new PendingRequestCommandError(
        'idempotency_key_conflict',
        'The request id was already used for a different pending request.',
        409
      );
    }
    return existing;
  }
  const pending = listThreadPendingRequests(sqlite, input.workspaceId, input.threadId).filter(
    (record) => record.state === 'pending'
  );
  const duplicate = pending.find((record) => sameQualifiedBinding(record, input));
  if (duplicate) return duplicate;
  if (pending.length >= PENDING_REQUEST_BOUND) {
    throw new PendingRequestCommandError(
      'request_limit_reached',
      'The Thread already has 16 pending requests.',
      409
    );
  }
  return null;
}

/**
 * Records a denial and, when the approval governs a call, denied-not-executed.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param actor Deciding user.
 * @param now Decision time.
 * @returns Updated record, or null when the compare-and-set lost.
 * @param decisionContext Non-secret credential identity used for current deciding authority.
 */
export function denyPendingRequest(
  sqlite: Database.Database,
  requestId: string,
  actor: PendingRequestActor,
  now: string,
  decisionContext?: Actor
): PendingRequestRecord | null {
  const deny = sqlite.transaction(() => {
    const current = readPendingRequest(sqlite, requestId);
    if (!current || current.state !== 'pending' || current.claim !== 'unclaimed') return null;
    const governsCall = current.kind === 'approval' && current.serverId !== null;
    const result = sqlite
      .prepare(
        `UPDATE pending_requests
         SET state = 'resolved', resolution = 'denied', deciding_actor_kind = ?, deciding_actor_id = ?,
             decided_at = ?, deciding_actor_context_json = ?, claim = 'unclaimed', disposition = ?, disposition_reason = ?, updated_at = ?
         WHERE request_id = ? AND state = 'pending' AND claim = 'unclaimed'`
      )
      .run(
        actor.kind,
        actor.id,
        now,
        decisionContext ? JSON.stringify(decisionContext) : null,
        governsCall ? 'denied-not-executed' : null,
        governsCall ? 'denied' : null,
        now,
        requestId
      );
    return result.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
  });
  return deny();
}

/**
 * Records an answer.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param actor Deciding user.
 * @param answers Answer map.
 * @param now Answer time.
 * @returns Updated record, or null when the compare-and-set lost.
 * @param decisionContext Non-secret credential identity used for current deciding authority.
 */
export function answerPendingRequest(
  sqlite: Database.Database,
  requestId: string,
  actor: PendingRequestActor,
  answers: Readonly<Record<string, readonly [string]>>,
  now: string,
  decisionContext?: Actor
): PendingRequestRecord | null {
  const answer = sqlite.transaction(() => {
    const result = sqlite
      .prepare(
        `UPDATE pending_requests
         SET state = 'resolved', resolution = 'answered', deciding_actor_kind = ?, deciding_actor_id = ?,
             decided_at = ?, deciding_actor_context_json = ?, answer_map_json = ?, updated_at = ?
         WHERE request_id = ? AND state = 'pending' AND claim = 'unclaimed' AND kind = 'user-input'`
      )
      .run(
        actor.kind,
        actor.id,
        now,
        decisionContext ? JSON.stringify(decisionContext) : null,
        JSON.stringify(answers),
        now,
        requestId
      );
    return result.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
  });
  return answer();
}

/**
 * Withdraws one unclaimed pending request.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param actor Ending actor.
 * @param now Ending time.
 * @returns Updated record, or null when the request was not an unclaimed pending request.
 */
export function withdrawPendingRequest(
  sqlite: Database.Database,
  requestId: string,
  actor: PendingRequestActor,
  now: string
): PendingRequestRecord | null {
  return endPendingRequest(sqlite, requestId, {
    ending: 'withdrawn',
    event: null,
    actor,
    now,
  });
}

/**
 * Ends one unclaimed pending request as invalidated.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param event Invalidating event.
 * @param actor Ending actor.
 * @param now Ending time.
 * @returns Updated record, or null when the compare-and-set lost.
 */
export function invalidatePendingRequest(
  sqlite: Database.Database,
  requestId: string,
  event: string,
  actor: PendingRequestActor,
  now: string
): PendingRequestRecord | null {
  return endPendingRequest(sqlite, requestId, { ending: 'invalidated', event, actor, now });
}

/**
 * Records a grant together with its claim or its non-execution. A failed authority check ends the request instead.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param actor Deciding actor.
 * @param now Decision time.
 * @param evaluate Synchronous re-evaluation. It must not commit this request.
 * @returns Applied step and the record.
 * @param decisionContext Non-secret credential identity used for current deciding authority.
 */
export function claimOrRefuseGrant(
  sqlite: Database.Database,
  requestId: string,
  actor: PendingRequestActor,
  now: string,
  evaluate: () => GrantEvaluation,
  decisionContext?: Actor
): GrantStepResult {
  const step = sqlite.transaction(() => {
    const current = readPendingRequest(sqlite, requestId);
    if (!current) {
      throw new PendingRequestCommandError(
        'recovery_required',
        'The pending request is missing.',
        409
      );
    }
    if (current.state !== 'pending' || current.claim !== 'unclaimed') {
      return { applied: 'lost' as const, record: current };
    }
    const evaluation = evaluate();
    if (evaluation.outcome === 'end') {
      const ended = endPendingRequest(sqlite, requestId, {
        ending: 'invalidated',
        event: evaluation.event,
        actor: evaluation.actor,
        now,
      });
      if (!ended)
        return {
          applied: 'lost' as const,
          record: readPendingRequest(sqlite, requestId) ?? current,
        };
      return { applied: 'ended' as const, record: ended };
    }
    if (evaluation.outcome === 'refuse') {
      const result = sqlite
        .prepare(
          `UPDATE pending_requests
           SET state = 'resolved', resolution = 'granted', deciding_actor_kind = ?, deciding_actor_id = ?,
               decided_at = ?, deciding_actor_context_json = ?, claim = 'unclaimed', disposition = 'denied-not-executed',
               disposition_reason = ?, updated_at = ?
           WHERE request_id = ? AND state = 'pending' AND claim = 'unclaimed'`
        )
        .run(
          actor.kind,
          actor.id,
          now,
          decisionContext ? JSON.stringify(decisionContext) : null,
          evaluation.reason,
          now,
          requestId
        );
      const record = readPendingRequest(sqlite, requestId) ?? current;
      return { applied: result.changes === 1 ? ('refused' as const) : ('lost' as const), record };
    }
    const callId = executionCallIdForRequest(requestId);
    const result = sqlite
      .prepare(
        `UPDATE pending_requests
         SET state = 'resolved', resolution = 'granted', deciding_actor_kind = ?, deciding_actor_id = ?,
             decided_at = ?, deciding_actor_context_json = ?, claim = 'claimed', execution_call_id = ?, updated_at = ?
         WHERE request_id = ? AND state = 'pending' AND claim = 'unclaimed'`
      )
      .run(
        actor.kind,
        actor.id,
        now,
        decisionContext ? JSON.stringify(decisionContext) : null,
        callId,
        now,
        requestId
      );
    const record = readPendingRequest(sqlite, requestId) ?? current;
    return { applied: result.changes === 1 ? ('claimed' as const) : ('lost' as const), record };
  });
  return step();
}

/**
 * Records a command-intent grant with claim left unclaimed.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param actor Deciding user.
 * @param now Decision time.
 * @returns Updated record, or null when the compare-and-set lost.
 * @param decisionContext Non-secret credential identity used for current deciding authority.
 */
export function grantCommandIntentRequest(
  sqlite: Database.Database,
  requestId: string,
  actor: PendingRequestActor,
  now: string,
  decisionContext?: Actor
): PendingRequestRecord | null {
  const grant = sqlite.transaction(() => {
    const result = sqlite
      .prepare(
        `UPDATE pending_requests
         SET state = 'resolved', resolution = 'granted', deciding_actor_kind = ?, deciding_actor_id = ?,
             decided_at = ?, deciding_actor_context_json = ?, updated_at = ?
         WHERE request_id = ? AND state = 'pending' AND claim = 'unclaimed' AND server_id IS NULL AND governed_intent_json IS NOT NULL`
      )
      .run(
        actor.kind,
        actor.id,
        now,
        decisionContext ? JSON.stringify(decisionContext) : null,
        now,
        requestId
      );
    return result.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
  });
  return grant();
}

/**
 * Claims an unclaimed command-intent grant for the governed command.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param now Claim time.
 * @returns Updated record, or null when the grant was not claimable.
 */
export function claimCommandIntentGrant(
  sqlite: Database.Database,
  requestId: string,
  now: string
): PendingRequestRecord | null {
  const claim = sqlite.transaction(() => {
    const callId = executionCallIdForRequest(requestId);
    const result = sqlite
      .prepare(
        `UPDATE pending_requests
         SET claim = 'claimed', execution_call_id = ?, updated_at = ?
         WHERE request_id = ? AND state = 'resolved' AND resolution = 'granted' AND claim = 'unclaimed'
           AND server_id IS NULL AND governed_intent_json IS NOT NULL AND disposition IS NULL`
      )
      .run(callId, now, requestId);
    return result.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
  });
  return claim();
}

/**
 * Finishes a claimed execution.
 *
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param disposition Terminal disposition.
 * @param reason Bounded reason.
 * @param heldResult Bounded result held until delivery is proved.
 * @param now Update time.
 * @returns Updated record, or null when the claim was not unfinished.
 */
export function finishPendingExecution(
  sqlite: Database.Database,
  requestId: string,
  disposition: Exclude<PendingRequestDisposition, 'denied-not-executed'>,
  reason: string | null,
  heldResult: unknown,
  now: string
): PendingRequestRecord | null {
  const finish = sqlite.transaction(() => {
    const result = sqlite
      .prepare(
        `UPDATE pending_requests
         SET claim = 'finished', disposition = ?, disposition_reason = ?, held_result_json = ?, updated_at = ?
         WHERE request_id = ? AND claim = 'claimed' AND disposition IS NULL`
      )
      .run(
        disposition,
        reason,
        heldResult === undefined ? null : JSON.stringify(heldResult),
        now,
        requestId
      );
    return result.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
  });
  return finish();
}

/**
 * Settles claimed unfinished executions to outcome-unknown. They are never executed again.
 *
 * @param sqlite Workspace database.
 * @param now Update time.
 * @returns Number of records settled.
 */
export function settleUnfinishedClaims(
  sqlite: Database.Database,
  now: string,
  usable: (record: PendingRequestRecord) => boolean = () => true
): number {
  const rows = sqlite
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM pending_requests WHERE claim = 'claimed' AND disposition IS NULL`
    )
    .all() as PendingRequestRow[];
  let changed = 0;
  for (const row of rows) {
    let record: PendingRequestRecord;
    try {
      record = parsePendingRequestRow(row);
    } catch {
      continue;
    }
    if (!usable(record)) continue;
    changed += sqlite
      .prepare(
        "UPDATE pending_requests SET claim = 'finished', disposition = 'outcome-unknown', disposition_reason = 'restart', updated_at = ? WHERE request_id = ? AND claim = 'claimed' AND disposition IS NULL"
      )
      .run(now, record.requestId).changes;
  }
  return changed;
}

/**
 * Freezes ready undelivered outcomes that match one executor, in readiness order, up to the bound.
 *
 * @param sqlite Workspace database.
 * @param input Admitting Turn.
 * @returns Records frozen into that Turn.
 */
export function freezeReadyOutcomes(
  sqlite: Database.Database,
  input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly executor: PendingExecutorKind;
    readonly agentId?: string | null;
    readonly cause: PendingDeliveryCause;
    readonly now: string;
    readonly usable?: (record: PendingRequestRecord) => boolean;
  }
): PendingRequestRecord[] {
  const limit = OUTCOME_DELIVERY_BOUND;
  const freeze = sqlite.transaction(() => {
    const ready = listThreadPendingRequests(sqlite, input.workspaceId, input.threadId)
      .filter(
        (record) =>
          record.requesterKind === input.executor &&
          (input.executor !== 'worker' || record.agentId === input.agentId) &&
          isReadyOutcome(record) &&
          (input.usable?.(record) ?? true)
      )
      .sort(compareReadiness);
    const selected = ready.slice(0, limit);
    for (const record of selected) {
      sqlite
        .prepare(
          `UPDATE pending_requests
           SET delivery = 'frozen', delivery_turn_id = ?, delivery_cause = ?,
               publication_turn_id = COALESCE(publication_turn_id, ?), updated_at = ?
           WHERE request_id = ? AND delivery = 'undelivered'`
        )
        .run(input.turnId, input.cause, input.turnId, input.now, record.requestId);
    }
    return selected.map((record) => readPendingRequest(sqlite, record.requestId) ?? record);
  });
  return freeze();
}

/** Builds structured native input from the delivering Turn's durable frozen associations, including references to its original publication. */
export function frozenPendingOutcomeInput(
  sqlite: Database.Database,
  turnId: string,
  triggerInput: string
): string {
  const rows = sqlite
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM pending_requests WHERE delivery = 'frozen' AND delivery_turn_id = ? ORDER BY COALESCE(decided_at, ended_at, created_at), request_id`
    )
    .all(turnId) as PendingRequestRow[];
  if (!rows.length) return triggerInput;
  const outcomes = rows.map(parsePendingRequestRow).map((record) => ({
    requestId: record.requestId,
    requestItemId: record.requestItemId,
    publicationTurnId: record.publicationTurnId,
    kind: record.kind,
    request: {
      title: record.title,
      description: record.description,
      questions: record.questions,
      call: record.serverId
        ? {
            serverId: record.serverId,
            toolName: record.toolName,
            arguments: JSON.parse(record.canonicalArgumentsJson!),
          }
        : null,
    },
    resolution: record.resolution,
    ending: record.ending,
    disposition: record.disposition,
    reason: record.dispositionReason ?? record.invalidatingEvent,
    answers: record.answerMap,
    result: record.heldResult,
  }));
  return JSON.stringify({ triggerInput, pendingOutcomes: outcomes });
}

/**
 * Returns frozen outcomes to undelivered and keeps the publication Turn.
 *
 * @param sqlite Workspace database.
 * @param turnId Turn that failed before delivery proof.
 * @param now Update time.
 * @returns Released records.
 */
export function releaseFrozenOutcomes(
  sqlite: Database.Database,
  turnId: string,
  now: string
): PendingRequestRecord[] {
  const release = sqlite.transaction(() => {
    const rows = sqlite
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM pending_requests
         WHERE delivery = 'frozen' AND delivery_turn_id = ?`
      )
      .all(turnId) as PendingRequestRow[];
    sqlite
      .prepare(
        `UPDATE pending_requests
         SET delivery = 'undelivered', delivery_turn_id = NULL, delivery_cause = NULL, updated_at = ?
         WHERE delivery = 'frozen' AND delivery_turn_id = ?`
      )
      .run(now, turnId);
    return rows.map(
      (row) => readPendingRequest(sqlite, row.request_id) ?? parsePendingRequestRow(row)
    );
  });
  return release();
}

/**
 * Proves delivery and clears the held result.
 *
 * @param sqlite Workspace database.
 * @param turnId Turn that proved delivery.
 * @param now Update time.
 * @returns Delivered records.
 */
export function proveFrozenDelivery(
  sqlite: Database.Database,
  turnId: string,
  now: string
): PendingRequestRecord[] {
  return moveFrozenDelivery(sqlite, turnId, 'delivered', true, now);
}

/**
 * Records delivery-unknown. The outcome is not resubmitted.
 *
 * @param sqlite Workspace database.
 * @param turnId Turn whose proof is unknown.
 * @param now Update time.
 * @returns Records marked delivery-unknown.
 */
export function markFrozenDeliveryUnknown(
  sqlite: Database.Database,
  turnId: string,
  now: string
): PendingRequestRecord[] {
  return moveFrozenDelivery(sqlite, turnId, 'delivery-unknown', false, now);
}

/**
 * Ends a Thread's pending requests and closes out every selected undelivered outcome on one publication Turn.
 *
 * @param sqlite Workspace database.
 * @param input Archive closeout.
 * @returns Records whose publication belongs on the closeout Turn.
 */
export function applyPendingCloseout(
  sqlite: Database.Database,
  input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly closeoutTurnId: string;
    readonly actor: PendingRequestActor;
    readonly now: string;
    readonly usable?: (record: PendingRequestRecord) => boolean;
    readonly invalidatingEvent?: (record: PendingRequestRecord) => string;
  }
): PendingRequestRecord[] {
  const apply = sqlite.transaction(() => {
    const records = listThreadPendingRequests(sqlite, input.workspaceId, input.threadId).filter(
      (record) => input.usable?.(record) ?? true
    );
    if (records.some((record) => record.claim === 'claimed' && record.disposition === null)) {
      throw new PendingRequestCommandError(
        'request_executing',
        'A pending request execution is still claimed.',
        409
      );
    }
    const published: PendingRequestRecord[] = [];
    for (const record of records) {
      if (record.state === 'pending' && record.claim === 'unclaimed') {
        endPendingRequest(sqlite, record.requestId, {
          ending: 'invalidated',
          event: input.invalidatingEvent?.(record) ?? 'thread-archived',
          actor: input.actor,
          now: input.now,
        });
      }
      const current = readPendingRequest(sqlite, record.requestId) ?? record;
      if (
        isCommandIntentApproval(current) &&
        current.resolution === 'granted' &&
        current.claim === 'unclaimed' &&
        current.disposition === null
      ) {
        sqlite
          .prepare(
            `UPDATE pending_requests
             SET disposition = 'denied-not-executed', disposition_reason = ?,
                 invalidation_turn_id = COALESCE(invalidation_turn_id, ?), updated_at = ?
             WHERE request_id = ? AND claim = 'unclaimed' AND disposition IS NULL`
          )
          .run(
            input.invalidatingEvent?.(record) ?? 'thread-archived',
            input.closeoutTurnId,
            input.now,
            current.requestId
          );
      }
      const next = readPendingRequest(sqlite, record.requestId) ?? current;
      const outstandingInvalidation =
        next.disposition === 'denied-not-executed' &&
        isCommandIntentApproval(next) &&
        next.resolution === 'granted' &&
        next.invalidationTurnId === null;
      if (outstandingInvalidation) {
        sqlite
          .prepare(
            `UPDATE pending_requests
             SET invalidation_turn_id = ?, updated_at = ?
             WHERE request_id = ? AND invalidation_turn_id IS NULL`
          )
          .run(input.closeoutTurnId, input.now, next.requestId);
      }
      if (
        next.delivery === 'undelivered' &&
        isFinalOutcome(readPendingRequest(sqlite, next.requestId) ?? next)
      ) {
        sqlite
          .prepare(
            `UPDATE pending_requests
             SET delivery = 'closed-out', publication_turn_id = COALESCE(publication_turn_id, ?), updated_at = ?
             WHERE request_id = ? AND delivery = 'undelivered'`
          )
          .run(input.closeoutTurnId, input.now, next.requestId);
      }
      const stored = readPendingRequest(sqlite, record.requestId);
      if (
        stored &&
        (stored.publicationTurnId === input.closeoutTurnId ||
          stored.invalidationTurnId === input.closeoutTurnId)
      ) {
        published.push(stored);
      }
    }
    return published;
  });
  return apply();
}

/**
 * Returns whether an outcome is final and ready to deliver or close out.
 *
 * @param record Pending request.
 * @returns True when delivery may freeze or close out the outcome.
 */
export function isReadyOutcome(record: PendingRequestRecord): boolean {
  if (record.delivery !== 'undelivered') return false;
  return isFinalOutcome(record);
}

/**
 * Returns whether the record has a final outcome.
 *
 * @param record Pending request.
 * @returns True for an answer, denial, ending, recorded agent grant, or a command-intent grant.
 */
export function isFinalOutcome(record: PendingRequestRecord): boolean {
  if (record.state === 'ended') return true;
  if (record.state !== 'resolved' || record.resolution === null) return false;
  if (record.resolution === 'denied' || record.resolution === 'answered') return true;
  if (isCommandIntentApproval(record)) return true;
  return record.disposition !== null;
}

/**
 * Projects an ApprovalRequest from the record. User-input has no approval projection.
 *
 * @param record Pending request.
 * @returns Approval projection, or null when the record is not an approval.
 */
export function projectApprovalRequest(record: PendingRequestRecord): ApprovalRequest | null {
  if (record.kind !== 'approval' || !record.approvalKind || !record.title || !record.description) {
    return null;
  }
  return ApprovalRequestSchema.parse({
    id: record.requestId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    turnId: record.raisingTurnId,
    kind: record.approvalKind,
    status: approvalStatusForRecord(record),
    title: record.title,
    description: record.description,
    createdAt: record.createdAt,
    resolvedAt: record.decidedAt ?? record.endedAt,
  });
}

/**
 * Loads approval projections from workspace databases. One unreadable record does not reject the workspace.
 *
 * @param dataRoot Data root.
 * @returns Approval projections.
 */
export function loadApprovalProjections(
  dataRoot: string,
  turns: readonly Turn[] = [],
  receipts: readonly CommandRequestRecord[] = []
): ApprovalRequest[] {
  const approvals: ApprovalRequest[] = [];
  for (const scope of listExistingWorkspaceDatabaseScopes(dataRoot)) {
    const db = openWorkspaceDb(dataRoot, scope.workspaceId);
    try {
      if (!pendingRequestTableExists(db.sqlite)) continue;
      const rows = db.sqlite
        .prepare(`SELECT ${SELECT_COLUMNS} FROM pending_requests WHERE kind = 'approval'`)
        .all() as PendingRequestRow[];
      for (const row of rows) {
        try {
          const record = parsePendingRequestRow(row);
          const threadTurns = turns.filter((turn) => turn.workspaceId === record.workspaceId);
          if (validateCanonicalLoad(record, threadTurns, receipts)) continue;
          const approval = projectApprovalRequest(record);
          if (approval) approvals.push(approval);
        } catch {
          // One bad record stays inspect-only. The rest of the workspace remains usable.
        }
      }
    } finally {
      db.sqlite.close();
    }
  }
  return approvals;
}

/** Canonical-load failure. */
export interface CanonicalLoadFailure {
  /** Request that failed. */
  readonly requestId: string;
  /** Failure reason. */
  readonly reason: string;
}

/**
 * Validates one record against its Items and Turns. A claimed record without a disposition is the restart case.
 *
 * @param record Authoritative record.
 * @param turns Turns on the same Thread.
 * @returns Failure, or null when the record is usable.
 */
export function validateCanonicalLoad(
  record: PendingRequestRecord,
  turns: readonly Turn[],
  receipts: readonly CommandRequestRecord[] = []
): CanonicalLoadFailure | null {
  const raising = turns.find((turn) => turn.id === record.raisingTurnId);
  if (
    !raising ||
    raising.workspaceId !== record.workspaceId ||
    raising.threadId !== record.threadId
  ) {
    return { requestId: record.requestId, reason: 'raising-turn-lineage' };
  }
  const items = turns.flatMap((turn) => turn.items);
  const requestItems = items.filter(
    (item) => item.id === record.requestItemId || requestItemMatches(item, record)
  );
  if (
    requestItems.length !== 1 ||
    requestItems[0]?.id !== record.requestItemId ||
    !requestItemMatches(requestItems[0], record) ||
    requestItems[0]?.turnId !== record.raisingTurnId
  ) {
    return { requestId: record.requestId, reason: 'request-item-lineage' };
  }
  if (
    (['worker', 'coordinator'].includes(record.requesterKind) && !record.agentId) ||
    (record.requesterKind === 'coordinator' &&
      (record.agentSessionId !== null || !isCommandIntentApproval(record))) ||
    (record.requesterKind === 'person' && record.agentId)
  ) {
    return { requestId: record.requestId, reason: 'parties' };
  }
  const request = requestItems[0]!;
  if (
    request.workspaceId !== record.workspaceId ||
    request.threadId !== record.threadId ||
    (record.requesterKind !== 'coordinator' &&
      responsibleUserIdForActor(raising.triggerActor) !== record.responsibleUserId) ||
    (record.requesterKind === 'coordinator' &&
      (raising.agentId !== record.agentId || Boolean(raising.agentSessionId))) ||
    (request.type === 'approval-request' &&
      (record.kind !== 'approval' ||
        request.kind !== record.approvalKind ||
        request.title !== record.title ||
        request.description !== record.description)) ||
    (request.type === 'user-input-request' &&
      (record.kind !== 'user-input' ||
        request.responsibleUserId !== record.responsibleUserId ||
        !isDeepStrictEqual(request.questions, record.questions)))
  ) {
    return { requestId: record.requestId, reason: 'request-parties-content' };
  }
  if (record.serverId !== null) {
    const context = record.authorizationContext;
    if (
      !record.toolName ||
      !record.catalogRevision ||
      !record.schemaSnapshotId ||
      !record.canonicalArgumentsJson ||
      !record.argumentsDigest ||
      !context ||
      context.threadId !== record.threadId ||
      context.turnId !== record.raisingTurnId ||
      context.agentId !== record.agentId ||
      context.agentSessionId !== record.agentSessionId ||
      context.responsibleUserId !== record.responsibleUserId ||
      context.packageDigest !== record.packageDigest ||
      context.policyDecisionId !== record.policyDecisionId
    )
      return { requestId: record.requestId, reason: 'captured-authorization-binding' };
    try {
      const args = JSON.parse(record.canonicalArgumentsJson) as unknown;
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        canonicalJsonText(args) !== record.canonicalArgumentsJson ||
        mcpToolArgumentsContentDigest(args as Record<string, unknown>) !== record.argumentsDigest
      )
        return { requestId: record.requestId, reason: 'captured-arguments' };
    } catch {
      return { requestId: record.requestId, reason: 'captured-arguments' };
    }
  }
  if (
    record.decidingActorContext &&
    record.decidingActorContext.userId !== record.decidingActor?.id
  )
    return { requestId: record.requestId, reason: 'deciding-credential-actor' };
  const policyGrant =
    record.kind === 'approval' &&
    record.resolution === 'granted' &&
    record.decidingActor?.kind === 'system' &&
    record.decidingActor.id === 'nanocore-repo-push-policy';
  if (
    record.resolution &&
    (!record.decidedAt ||
      !record.decidingActor ||
      (!policyGrant &&
        (record.decidingActor.kind !== 'user' ||
          !record.decidingActor.id ||
          (record.decidingActor.id !== record.responsibleUserId && !record.decidingActorContext))))
  )
    return { requestId: record.requestId, reason: 'resolution-actor' };
  if (
    (record.kind === 'approval' && record.resolution === 'answered') ||
    (record.kind === 'user-input' && record.resolution && record.resolution !== 'answered')
  )
    return { requestId: record.requestId, reason: 'resolution-kind' };
  if (record.resolution !== 'answered' && record.answerMap !== null)
    return { requestId: record.requestId, reason: 'answer-without-resolution' };
  if (record.resolution === 'answered') {
    const ids = (record.questions ?? []).map((question) => question.id);
    const answers = record.answerMap;
    if (
      !answers ||
      new Set(ids).size !== ids.length ||
      ids.length === 0 ||
      Object.keys(answers).length !== ids.length ||
      ids.some(
        (id) =>
          typeof id !== 'string' ||
          !Array.isArray(answers[id]) ||
          answers[id]!.length !== 1 ||
          typeof answers[id]![0] !== 'string' ||
          !answers[id]![0].trim()
      ) ||
      record.questions?.some((question) => question.isSecret)
    )
      return { requestId: record.requestId, reason: 'answer-content' };
  }
  if (
    record.ending &&
    (!record.endingActor ||
      !record.endedAt ||
      (record.ending === 'invalidated' && !record.invalidatingEvent))
  )
    return { requestId: record.requestId, reason: 'ending-content' };
  if (
    record.state === 'pending' &&
    (record.decidingActor ||
      record.decidedAt ||
      record.endingActor ||
      record.endedAt ||
      record.claim !== 'unclaimed' ||
      record.executionCallId ||
      record.delivery !== 'undelivered')
  )
    return { requestId: record.requestId, reason: 'pending-combination' };
  if (
    (record.resolution === 'denied' || record.resolution === 'answered') &&
    record.claim !== 'unclaimed'
  )
    return { requestId: record.requestId, reason: 'unclaimed-resolution' };
  if (
    record.resolution === 'granted' &&
    !isCommandIntentApproval(record) &&
    !policyGrant &&
    record.claim === 'unclaimed' &&
    record.disposition !== 'denied-not-executed'
  )
    return { requestId: record.requestId, reason: 'agent-grant-unclaimed' };
  if (
    record.claim === 'finished' &&
    !['approved-executed', 'execution-error', 'outcome-unknown'].includes(record.disposition ?? '')
  )
    return { requestId: record.requestId, reason: 'finished-disposition' };
  if (
    record.claim !== 'unclaimed' &&
    (record.resolution !== 'granted' ||
      record.executionCallId !== executionCallIdForRequest(record.requestId))
  )
    return { requestId: record.requestId, reason: 'claim-association' };
  if (!isFinalOutcome(record) && record.delivery !== 'undelivered')
    return { requestId: record.requestId, reason: 'not-ready-delivery' };
  for (const receipt of receipts) {
    if (Date.parse(receipt.expiresAt) <= Date.now()) continue;
    const target =
      receipt.scope.approvalRequestId ??
      receipt.scope.userInputRequestId ??
      receipt.scope.pendingRequestId;
    if (target !== record.requestId) continue;
    let expected: unknown;
    if (
      receipt.command === 'approval.respond' &&
      record.resolution &&
      record.resolution !== 'answered'
    )
      expected = {
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        turnId: record.raisingTurnId,
        approvalRequestId: record.requestId,
        requestId: receipt.requestId,
        decision: record.resolution,
      };
    else if (receipt.command === 'user_input.answer' && record.resolution === 'answered')
      expected = {
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        userInputRequestId: record.requestId,
        requestId: receipt.requestId,
        answers: record.answerMap,
      };
    else if (receipt.command === 'pending_request.withdraw' && record.ending === 'withdrawn')
      expected = {
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        pendingRequestId: record.requestId,
        requestId: receipt.requestId,
      };
    else if (
      ['approval.respond', 'user_input.answer', 'pending_request.withdraw'].includes(
        receipt.command
      )
    )
      return { requestId: record.requestId, reason: 'receipt-winner' };
    if (
      expected &&
      (receipt.response.id !== record.requestId || receipt.inputHash !== commandInputHash(expected))
    )
      return { requestId: record.requestId, reason: 'receipt-winner' };
  }
  if (record.state === 'pending' && (record.resolution || record.ending || record.disposition)) {
    return { requestId: record.requestId, reason: 'pending-has-outcome' };
  }
  if (record.state === 'resolved' && (!record.resolution || record.ending)) {
    return { requestId: record.requestId, reason: 'resolution' };
  }
  if (record.state === 'ended' && (!record.ending || record.resolution)) {
    return { requestId: record.requestId, reason: 'ending' };
  }
  if (record.claim === 'claimed' && record.disposition !== null) {
    return { requestId: record.requestId, reason: 'claimed-finished' };
  }
  if (record.claim === 'finished' && record.disposition === null) {
    return { requestId: record.requestId, reason: 'finished-without-disposition' };
  }
  if (record.state === 'ended' && record.claim !== 'unclaimed') {
    return { requestId: record.requestId, reason: 'ended-claim' };
  }
  if (
    (record.delivery === 'frozen' ||
      record.delivery === 'delivered' ||
      record.delivery === 'delivery-unknown') &&
    !record.deliveryTurnId
  ) {
    return { requestId: record.requestId, reason: 'delivery-turn' };
  }
  if (
    (record.delivery === 'undelivered' || record.delivery === 'closed-out') &&
    record.deliveryTurnId
  ) {
    return { requestId: record.requestId, reason: 'delivery-turn' };
  }
  if (
    (record.delivery === 'frozen' || record.delivery === 'delivered') &&
    record.publicationTurnId === null
  ) {
    return { requestId: record.requestId, reason: 'publication-phase' };
  }
  const deliveryTurn = record.deliveryTurnId
    ? turns.find((turn) => turn.id === record.deliveryTurnId)
    : undefined;
  if (
    record.deliveryTurnId &&
    (!deliveryTurn ||
      deliveryTurn.threadId !== record.threadId ||
      deliveryTurn.workspaceId !== record.workspaceId ||
      (!policyGrant &&
        (deliveryTurn.id === record.raisingTurnId ||
          !deliveryTurn.startedAt ||
          Date.parse(deliveryTurn.startedAt) <
            Date.parse(record.decidedAt ?? record.endedAt ?? record.createdAt))))
  ) {
    return { requestId: record.requestId, reason: 'delivery-association' };
  }
  if (
    deliveryTurn &&
    !policyGrant &&
    (record.requesterKind === 'worker'
      ? deliveryTurn.agentId !== record.agentId
      : record.requesterKind === 'coordinator'
        ? deliveryTurn.agentId !== record.agentId || Boolean(deliveryTurn.agentSessionId)
        : record.requesterKind === 'assistant'
          ? deliveryTurn.agentId !== 'quick-chat' || Boolean(deliveryTurn.agentSessionId)
          : Boolean(deliveryTurn.agentId || deliveryTurn.agentSessionId))
  ) {
    return { requestId: record.requestId, reason: 'delivery-executor' };
  }
  const decisionItems = items.filter(
    (item) => item.type === 'approval-decision' && item.approvalRequestId === record.requestId
  );
  if (decisionItems.length > 1) return { requestId: record.requestId, reason: 'two-resolutions' };
  for (const item of decisionItems) {
    if (item.type !== 'approval-decision') continue;
    if (item.threadId !== record.threadId) {
      return { requestId: record.requestId, reason: 'decision-thread' };
    }
    if (!record.publicationTurnId || item.turnId !== record.publicationTurnId) {
      return { requestId: record.requestId, reason: 'decision-publication' };
    }
    if (
      item.id !== (policyGrant ? item.id : pendingRequestItemId(record.requestId, 'decision')) ||
      item.causationId !== record.requestItemId ||
      item.actor.kind !== record.decidingActor?.kind ||
      item.actor.id !== record.decidingActor?.id ||
      item.decision !== record.resolution ||
      item.decidedAt !== record.decidedAt
    )
      return { requestId: record.requestId, reason: 'decision-content' };
    if (record.state === 'pending') {
      return { requestId: record.requestId, reason: 'item-ahead-of-record' };
    }
  }
  const answerItems = items.filter(
    (item) => item.type === 'user-input-response' && item.userInputRequestId === record.requestId
  );
  if (answerItems.length > 1) return { requestId: record.requestId, reason: 'two-resolutions' };
  for (const item of answerItems) {
    if (item.type !== 'user-input-response') continue;
    if (
      item.id !== pendingRequestItemId(record.requestId, 'answer') ||
      item.causationId !== record.requestItemId ||
      item.actor.id !== record.decidingActor?.id ||
      !isDeepStrictEqual(item.answers, record.answerMap) ||
      item.answeredAt !== record.decidedAt ||
      item.workspaceId !== record.workspaceId ||
      item.threadId !== record.threadId
    )
      return { requestId: record.requestId, reason: 'answer-content' };
    if (!record.publicationTurnId || item.turnId !== record.publicationTurnId) {
      return { requestId: record.requestId, reason: 'answer-publication' };
    }
  }
  const publicationInProgress =
    record.delivery === 'closed-out' &&
    turns.some(
      (turn) =>
        turn.id === record.publicationTurnId &&
        !turn.agentId &&
        !turn.agentSessionId &&
        turn.triggerSource?.kind === 'system-input' &&
        !isSealedTurnTerminal(turn.status)
    );
  if (record.publicationTurnId) {
    const publication = turns.find((turn) => turn.id === record.publicationTurnId);
    if (
      !publication ||
      publication.workspaceId !== record.workspaceId ||
      publication.threadId !== record.threadId ||
      (!policyGrant && publication.id === record.raisingTurnId)
    )
      return { requestId: record.requestId, reason: 'publication-turn-lineage' };
    if (
      (record.delivery === 'delivered' ||
        (record.delivery === 'closed-out' && !publicationInProgress)) &&
      ((record.kind === 'approval' && record.resolution && decisionItems.length !== 1) ||
        (record.resolution === 'answered' && answerItems.length !== 1))
    )
      return { requestId: record.requestId, reason: 'publication-incomplete' };
  } else if (record.delivery === 'closed-out')
    return { requestId: record.requestId, reason: 'closeout-publication' };
  const roles = ['disposition', 'disposition-status', 'ending', 'invalidation'] as const;
  for (const role of roles) {
    const id = pendingRequestItemId(record.requestId, role);
    const matching = items.filter(
      (item) =>
        item.id === id ||
        (item.causationId === record.requestItemId &&
          (role === 'disposition'
            ? item.type === 'tool-call'
            : item.type === 'status' &&
              item.title ===
                (role === 'invalidation'
                  ? 'Grant invalidated'
                  : role === 'disposition-status'
                    ? 'Call not executed'
                    : record.ending === 'withdrawn'
                      ? 'Request withdrawn'
                      : 'Request ended')))
    );
    const expectedTurnId =
      role === 'invalidation' ? record.invalidationTurnId : record.publicationTurnId;
    const expected =
      !policyGrant &&
      (role === 'invalidation'
        ? isCommandIntentApproval(record) &&
          record.resolution === 'granted' &&
          record.disposition === 'denied-not-executed'
        : role === 'ending'
          ? record.ending !== null
          : !isCommandIntentApproval(record) &&
            (role === 'disposition-status'
              ? record.disposition === 'denied-not-executed'
              : record.disposition !== null && record.disposition !== 'denied-not-executed'));
    if (
      matching.length > 1 ||
      matching.some(
        (item) =>
          !expected ||
          !expectedTurnId ||
          item.id !== id ||
          item.turnId !== expectedTurnId ||
          item.workspaceId !== record.workspaceId ||
          item.threadId !== record.threadId ||
          item.causationId !== record.requestItemId
      )
    )
      return { requestId: record.requestId, reason: `${role}-publication` };
    if (matching[0]) {
      const item = matching[0];
      if (
        role === 'disposition' &&
        (item.type !== 'tool-call' ||
          item.tool !== record.toolName ||
          item.server !== record.serverId ||
          item.result !== record.disposition ||
          item.error !==
            (record.disposition === 'approved-executed' ? null : record.dispositionReason))
      )
        return { requestId: record.requestId, reason: 'disposition-content' };
      if (
        role !== 'disposition' &&
        (item.type !== 'status' ||
          item.summary !==
            (role === 'ending'
              ? (record.invalidatingEvent ?? record.ending)
              : `denied-not-executed: ${record.dispositionReason ?? record.invalidatingEvent ?? 'refused'}`))
      )
        return { requestId: record.requestId, reason: `${role}-content` };
    }
    if (
      expected &&
      role !== 'invalidation' &&
      ['delivered', 'closed-out'].includes(record.delivery) &&
      !publicationInProgress &&
      matching.length !== 1
    )
      return { requestId: record.requestId, reason: `${role}-incomplete` };
    if (role === 'invalidation' && record.invalidationTurnId) {
      const invalidation = turns.find((turn) => turn.id === record.invalidationTurnId);
      if (
        !expected ||
        !invalidation ||
        invalidation.workspaceId !== record.workspaceId ||
        invalidation.threadId !== record.threadId ||
        invalidation.id === record.raisingTurnId ||
        (invalidation.id === record.publicationTurnId &&
          !(
            record.delivery === 'closed-out' &&
            record.deliveryTurnId === null &&
            invalidation.triggerSource?.kind === 'system-input'
          )) ||
        invalidation.agentId ||
        invalidation.agentSessionId ||
        (['completed', 'failed', 'cancelled', 'interrupted'].includes(invalidation.status) &&
          matching.length !== 1)
      )
        return { requestId: record.requestId, reason: 'invalidation-turn' };
    }
  }
  return null;
}

/**
 * Infers the executor of a Turn from its agent binding. Core-local and Assistant Turns are distinguished by the caller.
 *
 * @param turn Turn.
 * @returns Worker when the Turn names an AgentSession, otherwise null.
 */
export function executorKindForTurn(turn: Turn): PendingExecutorKind | null {
  if (turn.agentId === 'goal-coordinator' && !turn.agentSessionId) return 'coordinator';
  return turn.agentSessionId || (turn.agentId && turn.agentId !== 'quick-chat')
    ? 'worker'
    : turn.agentId === 'quick-chat'
      ? 'assistant'
      : null;
}

/**
 * Returns whether a pending request blocks the Thread.
 *
 * @param record Pending request.
 * @param turns Turns on the Thread in admission order.
 * @returns True when the request is pending, its raising Turn is terminal, and no later Turn has started.
 */
export function isBlockingPendingRequest(
  record: PendingRequestRecord,
  turns: readonly Turn[]
): boolean {
  if (record.state !== 'pending') return false;
  const raisingIndex = turns.findIndex((turn) => turn.id === record.raisingTurnId);
  const raising = raisingIndex >= 0 ? turns[raisingIndex] : undefined;
  if (!raising) return false;
  if (raising.status === 'pending' || raising.status === 'running') return false;
  return !turns.slice(raisingIndex + 1).length;
}

function endPendingRequest(
  sqlite: Database.Database,
  requestId: string,
  input: {
    readonly ending: PendingRequestEnding;
    readonly event: string | null;
    readonly actor: PendingRequestActor;
    readonly now: string;
  }
): PendingRequestRecord | null {
  const result = sqlite
    .prepare(
      `UPDATE pending_requests
       SET state = 'ended', ending = ?, invalidating_event = ?, ending_actor_kind = ?,
           ending_actor_id = ?, ended_at = ?, updated_at = ?
       WHERE request_id = ? AND state = 'pending' AND claim = 'unclaimed'`
    )
    .run(
      input.ending,
      input.event,
      input.actor.kind,
      input.actor.id,
      input.now,
      input.now,
      requestId
    );
  return result.changes === 1 ? readPendingRequest(sqlite, requestId) : null;
}

function moveFrozenDelivery(
  sqlite: Database.Database,
  turnId: string,
  delivery: 'delivered' | 'delivery-unknown',
  clearResult: boolean,
  now: string
): PendingRequestRecord[] {
  const move = sqlite.transaction(() => {
    const rows = sqlite
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM pending_requests
         WHERE delivery = 'frozen' AND delivery_turn_id = ?`
      )
      .all(turnId) as PendingRequestRow[];
    sqlite
      .prepare(
        `UPDATE pending_requests
         SET delivery = ?, held_result_json = CASE WHEN ? = 1 THEN NULL ELSE held_result_json END, updated_at = ?
         WHERE delivery = 'frozen' AND delivery_turn_id = ?`
      )
      .run(delivery, clearResult ? 1 : 0, now, turnId);
    return rows.map((row) => readPendingRequest(sqlite, row.request_id)!).filter(Boolean);
  });
  return move();
}

function insertPendingRequest(sqlite: Database.Database, input: RaisePendingRequestInput): void {
  sqlite
    .prepare(
      `INSERT INTO pending_requests (
         request_id, workspace_id, thread_id, raising_turn_id, request_item_id, kind, requester_kind,
         agent_id, agent_session_id, responsible_user_id, state, resolution, deciding_actor_kind,
         deciding_actor_id, deciding_actor_context_json, decided_at, answer_map_json, ending, invalidating_event, ending_actor_kind,
         ending_actor_id, ended_at, server_id, catalog_revision, schema_snapshot_id, tool_name,
         canonical_arguments_json, arguments_digest, package_digest, policy_decision_id,
         authorization_context_json, governed_intent_json, questions_json, approval_kind, title,
         description, claim, execution_call_id, disposition, disposition_reason, held_result_json,
         publication_turn_id, invalidation_turn_id, delivery, delivery_turn_id, delivery_cause,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', NULL, NULL, NULL, NULL,
         NULL, NULL, 'undelivered', NULL, NULL, ?, ?
       )`
    )
    .run(
      input.requestId,
      input.workspaceId,
      input.threadId,
      input.raisingTurnId,
      input.requestItemId,
      input.kind,
      input.requesterKind,
      input.agentId ?? null,
      input.agentSessionId ?? null,
      input.responsibleUserId,
      input.call?.serverId ?? null,
      input.call?.catalogRevision ?? null,
      input.call?.schemaSnapshotId ?? null,
      input.call?.toolName ?? null,
      input.call?.canonicalArgumentsJson ?? null,
      input.call?.argumentsDigest ?? input.questionDigest ?? null,
      input.call?.packageDigest ?? null,
      input.call?.policyDecisionId ?? null,
      input.call ? JSON.stringify(input.call.authorizationContext) : null,
      input.governedIntent ? JSON.stringify(input.governedIntent) : null,
      input.questions ? JSON.stringify(input.questions) : null,
      input.approval?.kind ?? null,
      input.approval?.title ?? null,
      input.approval?.description ?? null,
      input.now,
      input.now
    );
}

function sameRaiseIdentity(record: PendingRequestRecord, input: RaisePendingRequestInput): boolean {
  return (
    record.workspaceId === input.workspaceId &&
    record.threadId === input.threadId &&
    record.raisingTurnId === input.raisingTurnId &&
    record.kind === input.kind &&
    record.requesterKind === input.requesterKind &&
    record.responsibleUserId === input.responsibleUserId &&
    record.agentId === (input.agentId ?? null) &&
    record.argumentsDigest === (input.call?.argumentsDigest ?? input.questionDigest ?? null) &&
    canonicalJsonText(record.governedIntent) === canonicalJsonText(input.governedIntent ?? null)
  );
}

function sameQualifiedBinding(
  record: PendingRequestRecord,
  input: RaisePendingRequestInput
): boolean {
  if (record.threadId !== input.threadId || record.kind !== input.kind) return false;
  if (input.kind === 'user-input') {
    return (
      record.agentId === (input.agentId ?? null) &&
      record.argumentsDigest !== null &&
      record.argumentsDigest === (input.questionDigest ?? null)
    );
  }
  if (!input.call || !record.serverId) return false;
  return (
    record.serverId === input.call.serverId &&
    record.catalogRevision === input.call.catalogRevision &&
    record.schemaSnapshotId === input.call.schemaSnapshotId &&
    record.toolName === input.call.toolName &&
    record.argumentsDigest === input.call.argumentsDigest &&
    record.agentId === (input.agentId ?? null) &&
    record.responsibleUserId === input.responsibleUserId
  );
}

function approvalStatusForRecord(record: PendingRequestRecord): ApprovalRequest['status'] {
  if (record.ending === 'withdrawn') return 'withdrawn';
  if (record.ending === 'invalidated') return 'expired';
  if (record.resolution === 'granted') return 'granted';
  if (record.resolution === 'denied') return 'denied';
  return 'pending';
}

function compareReadiness(left: PendingRequestRecord, right: PendingRequestRecord): number {
  const leftTime = left.decidedAt ?? left.endedAt ?? left.createdAt;
  const rightTime = right.decidedAt ?? right.endedAt ?? right.createdAt;
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  return left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0;
}

function requestItemMatches(item: Item, record: PendingRequestRecord): boolean {
  if (item.type === 'approval-request') return item.approvalRequestId === record.requestId;
  if (item.type === 'user-input-request') return item.userInputRequestId === record.requestId;
  return false;
}

function pendingRequestTableExists(sqlite: Database.Database): boolean {
  return Boolean(
    sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_requests'`)
      .get()
  );
}

function parsePendingRequestRow(row: PendingRequestRow): PendingRequestRecord {
  const kind = closedValue(KINDS, row.kind, 'kind');
  const requesterKind = closedValue(REQUESTERS, row.requester_kind, 'requester_kind');
  const state = closedValue(STATES, row.state, 'state');
  const resolution =
    row.resolution === null ? null : closedValue(RESOLUTIONS, row.resolution, 'resolution');
  const ending = row.ending === null ? null : closedValue(ENDINGS, row.ending, 'ending');
  const claim = closedValue(CLAIMS, row.claim, 'claim');
  const disposition =
    row.disposition === null ? null : closedValue(DISPOSITIONS, row.disposition, 'disposition');
  const delivery = closedValue(DELIVERIES, row.delivery, 'delivery');
  const deliveryCause =
    row.delivery_cause === null ? null : closedValue(CAUSES, row.delivery_cause, 'delivery_cause');
  const approvalKind =
    row.approval_kind === null
      ? null
      : closedValue(APPROVAL_KINDS, row.approval_kind, 'approval_kind');
  return {
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    raisingTurnId: row.raising_turn_id,
    requestItemId: row.request_item_id,
    kind,
    requesterKind,
    agentId: row.agent_id,
    agentSessionId: row.agent_session_id,
    responsibleUserId: row.responsible_user_id,
    state,
    resolution,
    decidingActor: actorFrom(row.deciding_actor_kind, row.deciding_actor_id),
    decidingActorContext: parseDecisionContext(row.deciding_actor_context_json),
    decidedAt: row.decided_at,
    answerMap: parseAnswerMap(row.answer_map_json),
    ending,
    invalidatingEvent: row.invalidating_event,
    endingActor: actorFrom(row.ending_actor_kind, row.ending_actor_id),
    endedAt: row.ended_at,
    serverId: row.server_id,
    catalogRevision: row.catalog_revision,
    schemaSnapshotId: row.schema_snapshot_id,
    toolName: row.tool_name,
    canonicalArgumentsJson: row.canonical_arguments_json,
    argumentsDigest: row.arguments_digest,
    packageDigest: row.package_digest,
    policyDecisionId: row.policy_decision_id,
    authorizationContext: parseObject(
      row.authorization_context_json
    ) as PendingAuthorizationContext | null,
    governedIntent: parseObject(row.governed_intent_json),
    questions: parseQuestions(row.questions_json),
    approvalKind,
    title: row.title,
    description: row.description,
    claim,
    executionCallId: row.execution_call_id,
    disposition,
    dispositionReason: row.disposition_reason,
    heldResult: row.held_result_json === null ? null : parseJson(row.held_result_json),
    publicationTurnId: row.publication_turn_id,
    invalidationTurnId: row.invalidation_turn_id,
    delivery,
    deliveryTurnId: row.delivery_turn_id,
    deliveryCause,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actorFrom(kind: string | null, id: string | null): PendingRequestActor | null {
  if (kind === null && id === null) return null;
  if (kind === null || id === null || !ACTOR_KINDS.has(kind)) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request actor is not a closed core value.',
      409
    );
  }
  return { kind: kind as 'user' | 'system', id };
}

function closedValue<T extends string>(allowed: Set<T>, value: string, field: string): T {
  if (!allowed.has(value as T)) {
    throw new PendingRequestCommandError(
      'recovery_required',
      `The pending request ${field} is not a closed core value.`,
      409
    );
  }
  return value as T;
}

function parseAnswerMap(value: string | null): Readonly<Record<string, readonly [string]>> | null {
  if (value === null) return null;
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request answer map is not readable.',
      409
    );
  }
  return parsed as Record<string, readonly [string]>;
}

function parseQuestions(value: string | null): readonly Readonly<Record<string, unknown>>[] | null {
  if (value === null) return null;
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request questions are not readable.',
      409
    );
  }
  return parsed as Readonly<Record<string, unknown>>[];
}

function parseObject(value: string | null): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request object is not readable.',
      409
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request JSON is not readable.',
      409
    );
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalJsonValue(child)])
  );
}

/** Validates retained non-secret credential identity before it can re-enter current authorization. */
function parseDecisionContext(bytes: string | null): Actor | null {
  const value = parseObject(bytes);
  if (!value) return null;
  if (
    !['local', 'session', 'token'].includes(String(value.kind)) ||
    typeof value.userId !== 'string' ||
    !value.userId ||
    (value.tokenScope !== undefined &&
      !['server-admin', 'workspace', 'workspace-readonly'].includes(String(value.tokenScope))) ||
    (value.tokenId !== undefined && typeof value.tokenId !== 'string') ||
    (value.adminTokenId !== undefined && typeof value.adminTokenId !== 'string') ||
    (value.tokenWorkspaceIds !== undefined &&
      (!Array.isArray(value.tokenWorkspaceIds) ||
        !value.tokenWorkspaceIds.every((id) => typeof id === 'string')))
  )
    throw new PendingRequestCommandError(
      'recovery_required',
      'Invalid deciding credential context.',
      409
    );
  return {
    kind: value.kind as Actor['kind'],
    userId: value.userId,
    ...(typeof value.tokenId === 'string' ? { tokenId: value.tokenId } : {}),
    ...(typeof value.tokenScope === 'string'
      ? { tokenScope: value.tokenScope as NonNullable<Actor['tokenScope']> }
      : {}),
    ...(Array.isArray(value.tokenWorkspaceIds)
      ? { tokenWorkspaceIds: value.tokenWorkspaceIds as string[] }
      : {}),
    ...(typeof value.adminTokenId === 'string' ? { adminTokenId: value.adminTokenId } : {}),
  };
}

/** Reads only opaque-child lineage for admission, without loading captured arguments or changing request state. */
export function readPendingRequestLineage(
  sqlite: Database.Database,
  requestId: string
): { workspaceId: string; threadId: string } | null {
  const row = sqlite
    .prepare('SELECT workspace_id, thread_id FROM pending_requests WHERE request_id = ?')
    .get(requestId) as { workspace_id: string; thread_id: string } | undefined;
  return row ? { workspaceId: row.workspace_id, threadId: row.thread_id } : null;
}
