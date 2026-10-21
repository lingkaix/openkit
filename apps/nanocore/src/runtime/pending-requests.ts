import { isDeepStrictEqual } from 'node:util';
import {
  ApprovalRequestSchema,
  type AssistantHandoff,
  AssistantHandoffSchema,
  deriveEntityId,
  type Item,
  ItemIdSchema,
  isSealedTurnTerminal,
  readRetainedV1,
  responsibleUserIdForActor,
  ThreadIdSchema,
  TurnIdSchema,
  type TurnSchema,
  UserInputQuestionSchema,
  WorkspaceIdSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { refuseScope } from '../bootstrap/readiness.js';
import { uuidv5 } from '../generative-kernel/uuid.js';
import type { CommandRequestRecord } from '../lib/store.js';
import { commandInputHash } from './idempotent-command.js';
import { mcpToolArgumentsContentDigest } from './mcp-tool-schema-snapshots.js';

type ApprovalRequest = import('zod').infer<typeof ApprovalRequestSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;

import type Database from 'better-sqlite3';

import {
  assertControlProductWriter,
  type PreparedControlEntry,
  readPreparedControlEntry,
  readProduct,
} from '../storage/control-store-products.js';
import {
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  type WorkspaceDb,
} from '../storage/db.js';
import { StoredItemPayloadV1Schema } from '../storage/retained-work-items-v1.js';

/** Fixed retained handoff meaning; current publisher and Approval admission remain separate. */
const StoredPendingAssistantHandoffV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task'),
      targetWorkspaceId: WorkspaceIdSchema,
      input: z.string().min(1).max(65536),
      agentId: z.string().min(1).optional(),
      modelId: z.string().min(1).optional(),
    })
    .strip(),
  z
    .object({
      kind: z.literal('goal'),
      targetWorkspaceId: WorkspaceIdSchema,
      intent: z.string().min(1).max(65536),
    })
    .strip(),
]);

/** Pending requests one Thread may hold at once. */
export const PENDING_REQUEST_BOUND = 16;

/** Ready outcomes one delivering Turn may freeze. */
export const OUTCOME_DELIVERY_BOUND = 16;

/** Sentence carried in every pending tool result. */
export const PENDING_REQUEST_NEXT_STEP =
  'The outcome arrives on a later Turn. Do not call again to claim it.';

/** Reads the complete frozen Assistant outcome name; its recorded order, nullable facts and strings stay exact. */
export function assistantPendingOutcomeSource(
  turn: Turn,
  records: readonly PendingRequestRecord[],
  responsibleUserId: string
) {
  return {
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    turnId: turn.id,
    responsibleUserId,
    input: records.map((record) => ({
      requestId: record.requestId,
      requestItemId: record.requestItemId,
      publicationTurnId: record.publicationTurnId,
      resolution: record.resolution,
      ending: record.ending,
      disposition: record.disposition,
      answerMap: record.answerMap,
      // An absent extension must not change an ordinary retained outcome's complete name.
      ...(record.assistantHandoff ? { assistantHandoff: record.assistantHandoff } : {}),
      decidedAt: record.decidedAt,
      endedAt: record.endedAt,
    })),
  };
}

/** Hashes the unchanged source tuple for its excluded request-correlation identity. */
export function assistantPendingOutcomeSourceHash(
  turn: Turn,
  records: readonly PendingRequestRecord[],
  responsibleUserId: string
): string {
  return commandInputHash(assistantPendingOutcomeSource(turn, records, responsibleUserId));
}

/** Derives the single receiving-work projection on an admitted Assistant outcome. */
export function assistantPendingHandoffResultItemId(
  turnId: string,
  result: 'task' | 'goal' | 'refused'
): string {
  return deriveEntityId('it', [`chat-${result}`, turnId]);
}

/** Derives the receiving tuple from the immutable admitted outcome, never from model correlation. */
export function assistantPendingHandoffIds(
  outcomeScope: ReturnType<typeof assistantPendingOutcomeSource>
) {
  const sourceHash = commandInputHash(outcomeScope);
  return {
    requestId: uuidv5(JSON.stringify({ kind: 'assistant-handoff-request', sourceHash })),
    threadId: deriveEntityId('th', outcomeScope),
    turnId: deriveEntityId('tu', outcomeScope),
  };
}

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
  if (!readPendingRequest(sqlite, requestId)) return null;
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
  /** Exact Assistant work awaiting human selection, never an authorization grant. */
  readonly assistantHandoff: AssistantHandoff | null;
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
  /** Exact work proposed by the Assistant under independent current authority. */
  readonly assistantHandoff?: AssistantHandoff | null;
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
  schemaVersion: unknown;
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
  assistant_handoff_json: string | null;
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
  schema_version AS schemaVersion,
  request_id, workspace_id, thread_id, raising_turn_id, request_item_id, kind, requester_kind,
  agent_id, agent_session_id, responsible_user_id, state, resolution, deciding_actor_kind,
  deciding_actor_id, deciding_actor_context_json, decided_at, answer_map_json, ending, invalidating_event, ending_actor_kind,
  ending_actor_id, ended_at, server_id, catalog_revision, schema_snapshot_id, tool_name,
  canonical_arguments_json, arguments_digest, package_digest, policy_decision_id,
  authorization_context_json, governed_intent_json, questions_json, assistant_handoff_json, approval_kind, title,
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
  return deriveEntityId('cap', ['pending', requestId]);
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
  return deriveEntityId('it', [requestId, role]);
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
  const row = sqlite
    .prepare('SELECT schema_version AS schemaVersion FROM pending_requests WHERE request_id = ?')
    .get(requestId);
  if (row) {
    // Compensation can remove unreadable fresh payloads, but never a different retained format.
    readRetainedV1(row, () =>
      sqlite.prepare('DELETE FROM pending_requests WHERE request_id = ?').run(requestId)
    );
  }
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
  if (
    input.assistantHandoff &&
    (input.kind !== 'user-input' || input.requesterKind !== 'assistant')
  )
    throw new PendingRequestCommandError(
      'invalid_request',
      'Only an Assistant user-input request can retain a handoff selection.',
      400
    );
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
    if (!readPendingRequest(sqlite, requestId)) return null;
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
    if (!readPendingRequest(sqlite, requestId)) return null;
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
    if (!readPendingRequest(sqlite, requestId)) return null;
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
    if (!readPendingRequest(sqlite, requestId)) return null;
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
      assistantHandoff: record.assistantHandoff,
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
    const records = rows.map(parsePendingRequestRow);
    sqlite
      .prepare(
        `UPDATE pending_requests
         SET delivery = 'undelivered', delivery_turn_id = NULL, delivery_cause = NULL, updated_at = ?
         WHERE delivery = 'frozen' AND delivery_turn_id = ?`
      )
      .run(now, turnId);
    return records.map((record) => readPendingRequest(sqlite, record.requestId) ?? record);
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
 * Loads approval projections from Workspace databases; malformed individual rows remain inspect-only.
 * Unreadable required SQL authority quarantines its Workspace without returning empty admitted authority.
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
    let db: ReturnType<typeof openBootVerifiedWorkspaceDb> | undefined;
    try {
      db = openBootVerifiedWorkspaceDb(dataRoot, scope.workspaceId);
      if (!pendingRequestTableExists(db.sqlite))
        throw new Error('Required Pending Request authority is missing.');
      const rows = db.sqlite
        .prepare(`SELECT ${SELECT_COLUMNS} FROM pending_requests WHERE kind = 'approval'`)
        .all() as PendingRequestRow[];
      for (const row of rows) {
        try {
          const record = parsePendingRequestRow(row);
          const threadTurns = turns.filter(
            (turn) => workspaceIdForOwner(turn.owner) === record.workspaceId
          );
          if (validateCanonicalLoad(record, threadTurns, receipts)) continue;
          const approval = projectApprovalRequest(record);
          if (approval) approvals.push(approval);
        } catch {
          // One bad record stays inspect-only. The rest of the workspace remains usable.
        }
      }
    } catch {
      refuseScope(dataRoot, { scope: 'workspace', id: scope.workspaceId, check: 'database' });
    } finally {
      db?.sqlite.close();
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
    workspaceIdForOwner(raising.owner) !== record.workspaceId ||
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
  if (
    record.assistantHandoff &&
    (record.kind !== 'user-input' ||
      record.requesterKind !== 'assistant' ||
      raising.agentId !== 'quick-chat' ||
      raising.agentSessionId)
  )
    return { requestId: record.requestId, reason: 'handoff-producer' };
  const request = requestItems[0]!;
  // A captured agent's accountable human can differ from a later Turn's triggering administrator.
  // The exact Policy source and subject are revalidated before claim; historical load checks the requesting Worker/Session and captured context without current Goal state.
  const capturedWorkerParties =
    record.kind === 'approval' &&
    record.requesterKind === 'worker' &&
    record.serverId !== null &&
    record.policyDecisionId !== null &&
    record.agentSessionId !== null &&
    raising.agentId === record.agentId &&
    raising.agentSessionId === record.agentSessionId;
  if (
    workspaceIdForOwner(request.owner) !== record.workspaceId ||
    request.threadId !== record.threadId ||
    (record.requesterKind !== 'coordinator' &&
      !capturedWorkerParties &&
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
        !isDeepStrictEqual(request.questions, record.questions) ||
        !isDeepStrictEqual(request.assistantHandoff ?? null, record.assistantHandoff)))
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
      workspaceIdForOwner(deliveryTurn.owner) !== record.workspaceId ||
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
      workspaceIdForOwner(item.owner) !== record.workspaceId ||
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
      workspaceIdForOwner(publication.owner) !== record.workspaceId ||
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
          workspaceIdForOwner(item.owner) !== record.workspaceId ||
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
        workspaceIdForOwner(invalidation.owner) !== record.workspaceId ||
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
 * @returns The existing Pending requester executor, or null for work that receives no Pending outcomes.
 */
export function executorKindForTurn(turn: Turn): PendingExecutorKind | null {
  if (turn.agentId === 'goal-coordinator' && !turn.agentSessionId) return 'coordinator';
  // KM query work owns a separate bounded role run; it is neither a Worker nor the Chat requester.
  if (turn.agentId === 'knowledge-manager' && !turn.agentSessionId) return null;
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
  if (!readPendingRequest(sqlite, requestId)) return null;
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
    const records = rows.map(parsePendingRequestRow);
    sqlite
      .prepare(
        `UPDATE pending_requests
         SET delivery = ?, held_result_json = CASE WHEN ? = 1 THEN NULL ELSE held_result_json END, updated_at = ?
         WHERE delivery = 'frozen' AND delivery_turn_id = ?`
      )
      .run(delivery, clearResult ? 1 : 0, now, turnId);
    return records.map((record) => readPendingRequest(sqlite, record.requestId)!).filter(Boolean);
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
         authorization_context_json, governed_intent_json, questions_json, assistant_handoff_json, approval_kind, title,
         description, claim, execution_call_id, disposition, disposition_reason, held_result_json,
         publication_turn_id, invalidation_turn_id, delivery, delivery_turn_id, delivery_cause,
         created_at, updated_at, schema_version
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', NULL, NULL, NULL, NULL,
         NULL, NULL, 'undelivered', NULL, NULL, ?, ?, ?
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
      input.assistantHandoff
        ? JSON.stringify(AssistantHandoffSchema.parse(input.assistantHandoff))
        : null,
      input.approval?.kind ?? null,
      input.approval?.title ?? null,
      input.approval?.description ?? null,
      input.now,
      input.now,
      writeRetainedV1({}).schemaVersion
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
    canonicalJsonText(record.governedIntent) === canonicalJsonText(input.governedIntent ?? null) &&
    canonicalJsonText(record.assistantHandoff) === canonicalJsonText(input.assistantHandoff ?? null)
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

/** Orders current Pending outcomes by their existing readiness time and exact request identity. */
export function compareReadiness(left: PendingRequestRecord, right: PendingRequestRecord): number {
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
  return readRetainedV1(row, () => {
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
      row.delivery_cause === null
        ? null
        : closedValue(CAUSES, row.delivery_cause, 'delivery_cause');
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
      assistantHandoff:
        row.assistant_handoff_json === null
          ? null
          : StoredPendingAssistantHandoffV1Schema.parse(parseJson(row.assistant_handoff_json)),
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
  });
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
    .prepare(
      'SELECT schema_version AS schemaVersion, workspace_id, thread_id FROM pending_requests WHERE request_id = ?'
    )
    .get(requestId) as
    | { schemaVersion: unknown; workspace_id: string; thread_id: string }
    | undefined;
  return row
    ? readRetainedV1(row, () => ({ workspaceId: row.workspace_id, threadId: row.thread_id }))
    : null;
}

/** Exact non-secret deciding identity; current authority stays with the Main effect owner. */
const PendingDecisionContextSchema = z
  .object({
    kind: z.enum(['local', 'session', 'token']),
    userId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
    adminTokenId: z.string().min(1).optional(),
  })
  .strict()
  .transform(
    (value): Actor => ({
      kind: value.kind,
      userId: value.userId,
      ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
      ...(value.tokenId !== undefined ? { tokenId: value.tokenId } : {}),
      ...(value.tokenScope !== undefined ? { tokenScope: value.tokenScope } : {}),
      ...(value.tokenWorkspaceIds !== undefined
        ? { tokenWorkspaceIds: value.tokenWorkspaceIds }
        : {}),
      ...(value.adminTokenId !== undefined ? { adminTokenId: value.adminTokenId } : {}),
    })
  );
/** Original Pending deciding/ending actor, not a delegated authorization callback. */
const PendingNativeActorSchema = z
  .object({ kind: z.enum(['user', 'system']), id: z.string().min(1) })
  .strict();
/** Captured call attribution retains the existing exact owner fields. */
const PendingAuthorizationContextSchema = z
  .object({
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    agentSessionId: z.string().min(1).nullable(),
    agentId: z.string().min(1).nullable(),
    responsibleUserId: z.string().min(1),
    packageDigest: z.string().nullable(),
    policyDecisionId: z.string().nullable(),
  })
  .strict();
/** Closed creation fields; governed intent remains the existing effect owner's exact JSON object. */
const NativeRaisePendingRequestSchema = z
  .object({
    requestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    raisingTurnId: TurnIdSchema,
    requestItemId: ItemIdSchema,
    kind: z.enum(['approval', 'user-input']),
    requesterKind: z.enum(['worker', 'assistant', 'coordinator', 'person']),
    agentId: z.string().min(1).nullable().optional(),
    agentSessionId: z.string().min(1).nullable().optional(),
    responsibleUserId: z.string().min(1),
    call: z
      .object({
        serverId: z.string().min(1),
        catalogRevision: z.string().min(1),
        schemaSnapshotId: z.string().min(1),
        toolName: z.string().min(1),
        canonicalArgumentsJson: z.string(),
        argumentsDigest: z.string().min(1),
        packageDigest: z.string().nullable(),
        policyDecisionId: z.string().nullable(),
        authorizationContext: PendingAuthorizationContextSchema,
      })
      .strict()
      .optional(),
    governedIntent: z.record(z.string(), z.json()).nullable().optional(),
    assistantHandoff: AssistantHandoffSchema.nullable().optional(),
    questions: z.array(UserInputQuestionSchema.strict()).nullable().optional(),
    questionDigest: z.string().nullable().optional(),
    approval: z
      .object({
        kind: z.enum(['permission', 'destructive-action']),
        title: z.string(),
        description: z.string(),
      })
      .strict()
      .optional(),
    now: z.string().datetime(),
  })
  .strict()
  .transform((value): RaisePendingRequestInput => {
    const {
      agentId,
      agentSessionId,
      call,
      governedIntent,
      assistantHandoff,
      questions,
      questionDigest,
      approval,
      ...required
    } = value;
    return {
      ...required,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
      ...(call !== undefined ? { call } : {}),
      ...(governedIntent !== undefined ? { governedIntent } : {}),
      ...(assistantHandoff !== undefined ? { assistantHandoff } : {}),
      ...(questions !== undefined ? { questions } : {}),
      ...(questionDigest !== undefined ? { questionDigest } : {}),
      ...(approval !== undefined ? { approval } : {}),
    };
  });
/** A Main-selected usable record is admitted only while its complete current source still matches. */
const PendingExpectedSourceSchema = z
  .object({ requestId: z.string().min(1), sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();
const nativePendingScope = {
  workspaceId: WorkspaceIdSchema,
  expected: z.array(PendingExpectedSourceSchema).optional(),
};
const nativePendingThread = { ...nativePendingScope, threadId: ThreadIdSchema };
const nativePendingRequest = {
  ...nativePendingThread,
  requestId: z.string().min(1),
  now: z.string().datetime(),
};
const nativePendingDecision = {
  ...nativePendingRequest,
  actor: PendingNativeActorSchema,
  decisionContext: PendingDecisionContextSchema.optional(),
};
/** Closed transient Pending commands; no callback, arbitrary SQL, sibling handle, or raw result response crosses this boundary. */
export const ControlPendingCommandInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('raise'),
      ...nativePendingThread,
      input: NativeRaisePendingRequestSchema,
    })
    .strict(),
  z.object({ action: z.literal('deny'), ...nativePendingDecision }).strict(),
  z
    .object({
      action: z.literal('answer'),
      ...nativePendingDecision,
      answers: z.record(z.string(), z.tuple([z.string()])),
    })
    .strict(),
  z
    .object({
      action: z.literal('withdraw'),
      ...nativePendingRequest,
      actor: PendingNativeActorSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('invalidate'),
      ...nativePendingRequest,
      actor: PendingNativeActorSchema,
      event: z.string().min(1),
    })
    .strict(),
  z.object({ action: z.literal('grant-command'), ...nativePendingDecision }).strict(),
  z.object({ action: z.literal('claim'), ...nativePendingDecision }).strict(),
  z.object({ action: z.literal('claim-command'), ...nativePendingRequest }).strict(),
  z
    .object({
      action: z.literal('refuse-command'),
      ...nativePendingRequest,
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      ...nativePendingRequest,
      disposition: z.enum(['approved-executed', 'execution-error', 'outcome-unknown']),
      reason: z.string().nullable(),
      heldResult: z.json().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('settle-unfinished'),
      ...nativePendingScope,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery-prove'),
      ...nativePendingScope,
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery-release'),
      ...nativePendingScope,
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery-unknown'),
      ...nativePendingScope,
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('freeze'),
      ...nativePendingThread,
      turnId: TurnIdSchema,
      executor: z.enum(['worker', 'assistant', 'coordinator', 'person']),
      agentId: z.string().min(1).nullable().optional(),
      cause: z.enum(['outcome', 'carried']),
      now: z.string().datetime(),
      expectedSelection: z.array(z.string().min(1)).max(OUTCOME_DELIVERY_BOUND),
      expectedThreadCensus: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      action: z.literal('closeout'),
      ...nativePendingThread,
      closeoutTurnId: TurnIdSchema,
      expectedThreadCensus: z.array(z.string().min(1)),
      actor: PendingNativeActorSchema,
      now: z.string().datetime(),
      invalidatingEvents: z
        .array(z.object({ requestId: z.string().min(1), event: z.string().min(1) }).strict())
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('associate-invalidation'),
      ...nativePendingThread,
      requestIds: z.array(z.string().min(1)).min(1),
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
]);
/** One bounded native Pending family command, not a generic work-resource operation. */
export type ControlPendingCommandInput = z.infer<typeof ControlPendingCommandInputSchema>;
/** Responses carry only affected identities and the existing CAS outcome; captured input/results stay in their owner. */
export const ControlPendingCommandResultSchema = z
  .object({
    requestIds: z.array(z.string().min(1)),
    applied: z.enum(['claimed', 'refused', 'ended', 'lost']).nullable(),
    created: z.boolean().nullable(),
  })
  .strict();
/** Small Pending acknowledgement after its enclosing native transaction commits. */
export type ControlPendingCommandResult = z.infer<typeof ControlPendingCommandResultSchema>;

/** Native-local immutable Item proof retained separately from new product writes. */
export interface PreparedControlPendingCommand {
  readonly entries: readonly PreparedControlEntry[];
  readonly dependencies: readonly {
    readonly entry: PreparedControlEntry;
    readonly revision: number;
    readonly contentJson: string;
  }[];
}

/** Checks the latest actual SQL descriptor without reading immutable files inside the transaction. */
function pendingPreparedItem(db: WorkspaceDb, entry: PreparedControlEntry): Item {
  const row = db.sqlite
    .prepare(
      "SELECT schema_version,turn_id,sequence,revision,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
    )
    .get(entry.id) as
    | {
        schema_version: number;
        turn_id: string;
        sequence: number;
        revision: number;
        content_json: string;
      }
    | undefined;
  if (
    !row ||
    row.schema_version !== 1 ||
    row.turn_id !== entry.input.turnId ||
    row.sequence !== entry.input.sequence ||
    row.revision !== entry.input.expectedRevision + 1 ||
    !isDeepStrictEqual(JSON.parse(row.content_json), entry.input.content)
  )
    pendingNativeConflict('The Pending Item descriptor changed after immutable preparation.');
  return readRetainedV1(readPreparedControlEntry(entry), StoredItemPayloadV1Schema.parse);
}

/** Compares decided rows with their actual request, original publication and invalidation Items. */
function assertPendingPreparedProjection(
  db: WorkspaceDb,
  record: PendingRequestRecord,
  prepared: PreparedControlPendingCommand,
  now: string
): void {
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const relevant = new Set([
    record.requestItemId,
    ...(
      ['decision', 'answer', 'disposition', 'disposition-status', 'ending', 'invalidation'] as const
    ).map((role) => pendingRequestItemId(record.requestId, role)),
  ]);
  const items = new Map<string, Item>();
  const newIds = new Set(
    prepared.entries.filter((entry) => entry.input.kind === 'item').map((entry) => entry.id)
  );
  for (const entry of [
    ...prepared.entries,
    ...prepared.dependencies.map((dependency) => dependency.entry),
  ]) {
    if (entry.input.kind !== 'item') continue;
    const payload = readRetainedV1(
      readPreparedControlEntry(entry),
      StoredItemPayloadV1Schema.parse
    );
    if (
      !relevant.has(entry.id) &&
      payload.causationId !== record.requestItemId &&
      !('approvalRequestId' in payload && payload.approvalRequestId === record.requestId) &&
      !('userInputRequestId' in payload && payload.userInputRequestId === record.requestId)
    )
      continue;
    if (items.has(entry.id))
      pendingNativeConflict('The Pending Item proof contains duplicate identities.');
    items.set(entry.id, pendingPreparedItem(db, entry));
  }
  const turnIds = new Set(
    [
      record.raisingTurnId,
      record.publicationTurnId,
      record.invalidationTurnId,
      record.deliveryTurnId,
    ].filter((id): id is string => id !== null)
  );
  const turns = [...turnIds].map((id) => {
    const metadata = readProduct(db.sqlite, owner, 'turn', id)?.record;
    if (!metadata || metadata.threadId !== record.threadId)
      pendingNativeConflict('The Pending publication Turn has different native lineage.');
    return {
      ...metadata,
      items: [...items.values()].filter((item) => item.turnId === id),
    } as unknown as Turn;
  });
  const failure = validateCanonicalLoad(record, turns);
  if (failure)
    pendingNativeConflict(
      `The decided Pending tuple has invalid canonical Items: ${failure.reason}.`
    );
  const expected: Item[] = [];
  if (record.publicationTurnId)
    expected.push(...renderPendingOutcomeItems([record], record.publicationTurnId, now));
  if (record.invalidationTurnId && record.invalidationTurnId !== record.publicationTurnId)
    expected.push(renderPendingInvalidationItem(record, record.invalidationTurnId, now));
  const expectedIds = new Set([record.requestItemId, ...expected.map((item) => item.id)]);
  for (const item of expected) {
    const actual = items.get(item.id);
    if (!actual)
      pendingNativeConflict('The decided Pending tuple is missing its exact projected Item.');
    const clock = newIds.has(item.id) ? now : actual.createdAt;
    const expectedAtClock =
      item.id === pendingRequestItemId(record.requestId, 'invalidation')
        ? renderPendingInvalidationItem(record, item.turnId, clock)
        : renderPendingOutcomeItems([record], item.turnId, clock).find(
            (candidate) => candidate.id === item.id
          );
    if (
      !expectedAtClock ||
      !isDeepStrictEqual(
        StoredItemPayloadV1Schema.parse(actual),
        StoredItemPayloadV1Schema.parse(expectedAtClock)
      )
    )
      pendingNativeConflict('The decided Pending tuple does not match its exact projected Item.');
  }
  for (const item of items.values())
    if (!expectedIds.has(item.id))
      pendingNativeConflict('The Pending tuple contains an unexpected projected Item.');
}

/** Fails a native source/selection race before any Pending mutation. */
function pendingNativeConflict(message: string): never {
  throw new PendingRequestCommandError('conflict', message, 409);
}

/** Runs the existing synchronous deciding body on the supplied native handle and savepoint, after prepared products/Items have been applied. No file I/O, Main authority callback, await, COMMIT, or sibling database is used. */
export function applyControlPendingCommand(
  db: WorkspaceDb,
  value: ControlPendingCommandInput,
  prepared: PreparedControlPendingCommand = { entries: [], dependencies: [] }
): ControlPendingCommandResult {
  assertControlProductWriter(db.sqlite);
  const command = ControlPendingCommandInputSchema.parse(value);
  if (db.scope !== 'workspace' || command.workspaceId !== db.workspaceId)
    pendingNativeConflict('The Pending command names a different Workspace owner.');
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  for (const dependency of prepared.dependencies) {
    const row = db.sqlite
      .prepare(
        "SELECT revision,content_json FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(dependency.entry.input.turnId, dependency.entry.id) as
      | { revision: number; content_json: string }
      | undefined;
    if (!row || row.revision !== dependency.revision || row.content_json !== dependency.contentJson)
      pendingNativeConflict('A retained Pending Item changed after preparation.');
  }
  if (!readProduct(db.sqlite, owner, 'workspace', db.workspaceId))
    pendingNativeConflict('The Pending Workspace owner is missing.');
  const thread = (threadId: string) => {
    const current = readProduct(db.sqlite, owner, 'thread', threadId);
    if (!current) pendingNativeConflict('The Pending Thread owner is missing.');
    return current.record;
  };
  const turn = (turnId: string, threadId?: string) => {
    const current = readProduct(db.sqlite, owner, 'turn', turnId);
    if (!current || (threadId !== undefined && current.record.threadId !== threadId))
      pendingNativeConflict('The Pending Turn does not belong to its Thread.');
    thread(current.record.threadId as string);
    return current.record;
  };
  if ('threadId' in command) thread(command.threadId);
  const scoped = (record: PendingRequestRecord): PendingRequestRecord => {
    if (
      record.workspaceId !== command.workspaceId ||
      ('threadId' in command && record.threadId !== command.threadId)
    )
      pendingNativeConflict('The Pending request does not belong to the command scope.');
    turn(record.raisingTurnId, record.threadId);
    return record;
  };
  const expectedIds = new Set<string>();
  for (const expected of command.expected ?? []) {
    if (expectedIds.has(expected.requestId))
      pendingNativeConflict('The Pending source list has duplicate identities.');
    expectedIds.add(expected.requestId);
    const current = readPendingRequest(db.sqlite, expected.requestId);
    if (!current || commandInputHash(scoped(current)) !== expected.sourceHash)
      pendingNativeConflict('The Pending request changed after preparation.');
  }
  const selection = () => {
    if (command.expected === undefined)
      pendingNativeConflict('The Pending selection requires its exact usable sources.');
    return (record: PendingRequestRecord) => expectedIds.has(record.requestId);
  };
  const requireRequest = (requestId: string) => {
    const current = readPendingRequest(db.sqlite, requestId);
    if (!current) pendingNativeConflict('The Pending request is missing.');
    return scoped(current);
  };
  const result = (
    records: readonly PendingRequestRecord[],
    applied: ControlPendingCommandResult['applied'] = null,
    created: boolean | null = null
  ): ControlPendingCommandResult => {
    const affected = new Set([...records.map((record) => record.requestId), ...expectedIds]);
    for (const requestId of affected) {
      const current = readPendingRequest(db.sqlite, requestId);
      if (!current) pendingNativeConflict('The decided Pending request is missing.');
      assertPendingPreparedProjection(
        db,
        current,
        prepared,
        command.action === 'raise' ? command.input.now : command.now
      );
    }
    return { requestIds: records.map((record) => record.requestId), applied, created };
  };
  if (command.action === 'freeze' || command.action === 'closeout') {
    const census = listThreadPendingRequests(db.sqlite, command.workspaceId, command.threadId)
      .map((record) => record.requestId)
      .sort();
    if (
      new Set(command.expectedThreadCensus).size !== command.expectedThreadCensus.length ||
      !isDeepStrictEqual(census, [...command.expectedThreadCensus].sort())
    )
      pendingNativeConflict('The current native Thread request census differs from preparation.');
  }
  if (
    'decisionContext' in command &&
    command.decisionContext &&
    command.decisionContext.userId !== command.actor.id
  )
    pendingNativeConflict('The Pending deciding identity does not match its actor.');

  switch (command.action) {
    case 'raise': {
      const input = command.input;
      if (input.workspaceId !== command.workspaceId || input.threadId !== command.threadId)
        pendingNativeConflict('The raised request does not match its command scope.');
      if (thread(input.threadId).status !== 'active')
        pendingNativeConflict('The request Thread no longer admits new requests.');
      const raising = turn(input.raisingTurnId, input.threadId);
      const candidate = [
        ...prepared.entries,
        ...prepared.dependencies.map((dependency) => dependency.entry),
      ].find(
        (entry) =>
          entry.input.kind === 'item' &&
          entry.id === input.requestItemId &&
          entry.input.turnId === input.raisingTurnId
      );
      const row = db.sqlite
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=? ORDER BY revision DESC LIMIT 1"
        )
        .get(input.raisingTurnId, input.requestItemId) as { content_json: string } | undefined;
      if (
        !candidate ||
        !row ||
        !isDeepStrictEqual(JSON.parse(row.content_json), candidate.input.content)
      )
        pendingNativeConflict('The raised request requires its exact native request Item.');
      const item = readRetainedV1(
        readPreparedControlEntry(candidate),
        StoredItemPayloadV1Schema.parse
      );
      if (
        item.id !== input.requestItemId ||
        item.turnId !== input.raisingTurnId ||
        item.threadId !== input.threadId ||
        !isDeepStrictEqual(item.owner, owner)
      )
        pendingNativeConflict('The request Item has different native lineage.');
      const raised = raisePendingRequest(db.sqlite, input);
      if (raised.record.requestId !== input.requestId)
        pendingNativeConflict(
          'A different pending request already owns this qualified request binding.'
        );
      if (raised.created) {
        const failure = validateCanonicalLoad(raised.record, [
          { ...raising, items: [item] } as unknown as Turn,
        ]);
        if (failure)
          pendingNativeConflict(
            `The raised request has invalid canonical lineage: ${failure.reason}.`
          );
      }
      return result([raised.record], null, raised.created);
    }
    case 'deny': {
      if (requireRequest(command.requestId).kind !== 'approval')
        pendingNativeConflict('Only an approval can receive a denial.');
      const changed = denyPendingRequest(
        db.sqlite,
        command.requestId,
        command.actor,
        command.now,
        command.decisionContext
      );
      return result(changed ? [changed] : [], changed ? null : 'lost');
    }
    case 'answer': {
      const current = requireRequest(command.requestId);
      const ids = (current.questions ?? []).map((question) => question.id);
      if (
        current.kind !== 'user-input' ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        Object.keys(command.answers).length !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !command.answers[id]?.[0]?.trim()) ||
        current.questions?.some((question) => question.isSecret)
      )
        pendingNativeConflict('The answer does not match the exact non-secret Pending questions.');
      const changed = answerPendingRequest(
        db.sqlite,
        command.requestId,
        command.actor,
        command.answers,
        command.now,
        command.decisionContext
      );
      return result(changed ? [changed] : [], changed ? null : 'lost');
    }
    case 'withdraw':
    case 'invalidate': {
      requireRequest(command.requestId);
      const changed =
        command.action === 'withdraw'
          ? withdrawPendingRequest(db.sqlite, command.requestId, command.actor, command.now)
          : invalidatePendingRequest(
              db.sqlite,
              command.requestId,
              command.event,
              command.actor,
              command.now
            );
      return result(changed ? [changed] : [], changed ? 'ended' : 'lost');
    }
    case 'grant-command': {
      const current = requireRequest(command.requestId);
      if (!isCommandIntentApproval(current))
        pendingNativeConflict('The request is not a governed command intent.');
      const changed = grantCommandIntentRequest(
        db.sqlite,
        command.requestId,
        command.actor,
        command.now,
        command.decisionContext
      );
      return result(changed ? [changed] : [], changed ? null : 'lost');
    }
    case 'claim': {
      const current = requireRequest(command.requestId);
      if (
        current.kind !== 'approval' ||
        current.serverId === null ||
        isCommandIntentApproval(current)
      )
        pendingNativeConflict('Only a captured call uses the external execution reservation.');
      const step = claimOrRefuseGrant(
        db.sqlite,
        command.requestId,
        command.actor,
        command.now,
        () =>
          thread(current.threadId).status === 'active'
            ? { outcome: 'claim' }
            : { outcome: 'end', event: 'thread-archived', actor: command.actor },
        command.decisionContext
      );
      return result([step.record], step.applied);
    }
    case 'claim-command': {
      const current = requireRequest(command.requestId);
      if (thread(current.threadId).status !== 'active')
        pendingNativeConflict('The request Thread no longer admits command consumption.');
      const changed = claimCommandIntentGrant(db.sqlite, command.requestId, command.now);
      return result(changed ? [changed] : [], changed ? 'claimed' : 'lost');
    }
    case 'refuse-command': {
      requireRequest(command.requestId);
      const changed = refuseCommandIntentGrant(
        db.sqlite,
        command.requestId,
        command.reason,
        command.now
      );
      return result(changed ? [changed] : [], changed ? 'refused' : 'lost');
    }
    case 'finish': {
      requireRequest(command.requestId);
      const changed = finishPendingExecution(
        db.sqlite,
        command.requestId,
        command.disposition,
        command.reason,
        command.heldResult,
        command.now
      );
      return result(changed ? [changed] : [], changed ? null : 'lost');
    }
    case 'settle-unfinished': {
      const usable = selection();
      const selected = [...expectedIds]
        .map(requireRequest)
        .filter((record) => record.claim === 'claimed' && record.disposition === null);
      settleUnfinishedClaims(db.sqlite, command.now, usable);
      return result(selected);
    }
    case 'delivery-prove':
    case 'delivery-release':
    case 'delivery-unknown': {
      const deliveryTurn = turn(command.turnId);
      const rows = db.sqlite
        .prepare(
          "SELECT request_id FROM pending_requests WHERE delivery='frozen' AND delivery_turn_id=?"
        )
        .all(command.turnId) as { request_id: string }[];
      for (const row of rows) {
        const record = requireRequest(row.request_id);
        if (record.threadId !== deliveryTurn.threadId)
          pendingNativeConflict('The frozen request belongs to a different delivery Thread.');
      }
      return result(
        command.action === 'delivery-prove'
          ? proveFrozenDelivery(db.sqlite, command.turnId, command.now)
          : command.action === 'delivery-release'
            ? releaseFrozenOutcomes(db.sqlite, command.turnId, command.now)
            : markFrozenDeliveryUnknown(db.sqlite, command.turnId, command.now)
      );
    }
    case 'freeze': {
      const usable = selection();
      const delivering = turn(command.turnId, command.threadId);
      const executor = executorKindForTurn(delivering as unknown as Turn) ?? 'person';
      if (
        thread(command.threadId).status !== 'active' ||
        executor !== command.executor ||
        (command.executor === 'worker' && delivering.agentId !== (command.agentId ?? null))
      )
        pendingNativeConflict('The delivering Turn does not match its current native executor.');
      const selected = listThreadPendingRequests(db.sqlite, command.workspaceId, command.threadId)
        .filter(
          (record) =>
            usable(record) &&
            record.requesterKind === command.executor &&
            (command.executor !== 'worker' || record.agentId === command.agentId) &&
            isReadyOutcome(record)
        )
        .sort(compareReadiness)
        .slice(0, OUTCOME_DELIVERY_BOUND);
      if (
        !isDeepStrictEqual(
          selected.map((record) => record.requestId),
          command.expectedSelection
        ) ||
        selected.some((record) => record.raisingTurnId === command.turnId)
      )
        pendingNativeConflict('The current native outcome selection differs from preparation.');
      return result(
        freezeReadyOutcomes(db.sqlite, {
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          executor: command.executor,
          agentId: command.agentId ?? null,
          cause: command.cause,
          now: command.now,
          usable,
        })
      );
    }
    case 'closeout': {
      const usable = selection();
      turn(command.closeoutTurnId, command.threadId);
      const reasons = new Map<string, string>();
      for (const item of command.invalidatingEvents ?? []) {
        if (!expectedIds.has(item.requestId) || reasons.has(item.requestId))
          pendingNativeConflict('The closeout event does not match its selected source.');
        reasons.set(item.requestId, item.event);
      }
      return result(
        applyPendingCloseout(db.sqlite, {
          ...command,
          usable,
          invalidatingEvent: (record) => reasons.get(record.requestId) ?? 'thread-archived',
        })
      );
    }
    case 'associate-invalidation': {
      turn(command.turnId, command.threadId);
      if (new Set(command.requestIds).size !== command.requestIds.length)
        pendingNativeConflict('The invalidation association has duplicate requests.');
      const selected = command.requestIds.map(requireRequest);
      for (const record of selected) {
        if (
          !isCommandIntentApproval(record) ||
          record.resolution !== 'granted' ||
          record.claim !== 'unclaimed' ||
          record.disposition !== 'denied-not-executed' ||
          (record.invalidationTurnId !== null && record.invalidationTurnId !== command.turnId)
        )
          pendingNativeConflict('The request no longer admits this invalidation association.');
      }
      for (const record of selected)
        db.sqlite
          .prepare(
            'UPDATE pending_requests SET invalidation_turn_id = ?, updated_at = ? WHERE request_id = ? AND invalidation_turn_id IS NULL'
          )
          .run(command.turnId, command.now, record.requestId);
      return result(selected);
    }
  }
}

/** Renders only the existing Pending outcome Items from decided canonical rows; it performs no Store or SQL effect. */
export function renderPendingOutcomeItems(
  records: readonly PendingRequestRecord[],
  turnId: string,
  now: string
): Item[] {
  const items: Item[] = [];
  for (const record of records) {
    if (record.publicationTurnId && record.publicationTurnId !== turnId) {
      if (record.invalidationTurnId === turnId)
        items.push(renderPendingInvalidationItem(record, turnId, now));
      continue;
    }
    const base = {
      owner: { kind: 'workspace' as const, workspaceId: record.workspaceId },
      threadId: record.threadId,
      turnId,
      status: 'completed' as const,
      createdAt: now,
      completedAt: now,
    };
    if (record.kind === 'approval' && record.resolution && record.decidingActor?.kind === 'user') {
      items.push({
        ...base,
        id: pendingRequestItemId(record.requestId, 'decision'),
        type: 'approval-decision',
        actor: { kind: 'user', id: record.decidingActor.id },
        causationId: record.requestItemId,
        approvalRequestId: record.requestId,
        decision: record.resolution === 'denied' ? 'denied' : 'granted',
        decidedAt: record.decidedAt ?? now,
      });
    }
    if (
      record.resolution === 'answered' &&
      record.answerMap &&
      record.decidingActor?.kind === 'user'
    ) {
      items.push({
        ...base,
        id: pendingRequestItemId(record.requestId, 'answer'),
        type: 'user-input-response',
        actor: { kind: 'user', id: record.decidingActor.id },
        causationId: record.requestItemId,
        userInputRequestId: record.requestId,
        answers: Object.fromEntries(
          Object.entries(record.answerMap).map(([key, value]) => [key, [value[0]] as [string]])
        ),
        answeredAt: record.decidedAt ?? now,
      });
    }
    if (!isCommandIntentApproval(record) && record.disposition === 'denied-not-executed') {
      items.push({
        ...base,
        id: pendingRequestItemId(record.requestId, 'disposition-status'),
        type: 'status',
        level: 'warning',
        title: 'Call not executed',
        summary: `denied-not-executed: ${record.dispositionReason ?? 'refused'}`,
        causationId: record.requestItemId,
      });
    } else if (
      !isCommandIntentApproval(record) &&
      record.disposition &&
      record.serverId &&
      record.toolName
    ) {
      items.push({
        ...base,
        id: pendingRequestItemId(record.requestId, 'disposition'),
        type: 'tool-call',
        tool: record.toolName,
        server: record.serverId,
        arguments: null,
        result: record.disposition,
        error: record.disposition === 'approved-executed' ? null : record.dispositionReason,
        durationMs: 0,
        causationId: record.requestItemId,
      });
    }
    if (record.ending) {
      items.push({
        ...base,
        id: pendingRequestItemId(record.requestId, 'ending'),
        type: 'status',
        level: 'info',
        title: record.ending === 'withdrawn' ? 'Request withdrawn' : 'Request ended',
        summary: record.invalidatingEvent ?? record.ending,
        causationId: record.requestItemId,
      });
    }
    if (record.invalidationTurnId === turnId) {
      items.push(renderPendingInvalidationItem(record, turnId, now));
    }
  }
  return items;
}

/** Renders the separate, once-associated command-grant invalidation fact. */
export function renderPendingInvalidationItem(
  record: PendingRequestRecord,
  turnId: string,
  now: string
): Item {
  return {
    id: pendingRequestItemId(record.requestId, 'invalidation'),
    owner: { kind: 'workspace', workspaceId: record.workspaceId },
    threadId: record.threadId,
    turnId,
    status: 'completed',
    createdAt: now,
    completedAt: now,
    type: 'status',
    level: 'warning',
    title: 'Grant invalidated',
    summary: `denied-not-executed: ${record.dispositionReason ?? record.invalidatingEvent ?? 'invalidated'}`,
    causationId: record.requestItemId,
  };
}
