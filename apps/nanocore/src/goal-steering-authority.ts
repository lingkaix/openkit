import { createHash } from 'node:crypto';

import type { FsStore } from './lib/store.js';
import type { WorkspaceDb } from './storage/db.js';

/** Completed user input Item owned by one accepted steering send. */
type SteeringSourceItem = Extract<
  ReturnType<FsStore['listAllItems']>[number],
  { type: 'user-message' }
>;

/** Stable Goal steering authority failure codes. */
export type GoalSteeringAuthorityErrorCode =
  | 'conflict'
  | 'idempotency_key_conflict'
  | 'recovery_required'
  | 'stale';

/** Error raised when S16 steering authority cannot be read or changed safely. */
export class GoalSteeringAuthorityError extends Error {
  /** Stable App API error code. */
  public readonly code: GoalSteeringAuthorityErrorCode;
  /** HTTP status for every bounded authority failure. */
  public readonly status = 409;

  /**
   * Creates one Goal steering authority error.
   *
   * @param code Stable failure code.
   * @param message Product-safe failure summary.
   */
  public constructor(code: GoalSteeringAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'GoalSteeringAuthorityError';
    this.code = code;
  }
}

/** Exact input identity retained by one pending steering owner. */
export type PendingUserTurnInput =
  | { readonly kind: 'message' }
  | {
      readonly kind: 'material';
      readonly materialId: string;
      readonly revisionId: string;
      readonly contentDigest: string;
    };

/** First-writer terminal claimant kinds supported by S16. */
export type SteeringTerminalClaimKind = 'applied' | 'follow-up' | 'cancelled';

/** Immutable follow-up or cancellation result kinds. */
export type SteeringTerminalOutcomeState = 'follow-up' | 'cancelled';

/** One Thread-unique pending Goal steering owner. */
export interface PendingUserTurnRecord {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly pendingTurnId: string;
  readonly goalId: string;
  readonly activeTurnId: string;
  readonly requestId: string;
  readonly contentItemId: string;
  readonly inputKind: PendingUserTurnInput['kind'];
  readonly materialId: string | null;
  readonly revisionId: string | null;
  readonly contentDigest: string | null;
  readonly queueMode: 'safe_point_steering';
  readonly receivedAt: string;
  readonly terminalClaimKind: SteeringTerminalClaimKind | null;
  readonly terminalClaimId: string | null;
  readonly terminalClaimedAt: string | null;
}

/** Immutable history owner for one follow-up or cancellation. */
export interface SteeringTerminalOutcome {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly pendingTurnId: string;
  readonly outcomeId: string;
  readonly state: SteeringTerminalOutcomeState;
  readonly sendRequestId: string;
  readonly terminalRequestId: string;
  readonly contentItemId: string;
  readonly goalId: string;
  readonly activeTurnId: string;
  readonly inputKind: PendingUserTurnInput['kind'];
  readonly materialId: string | null;
  readonly revisionId: string | null;
  readonly contentDigest: string | null;
  readonly followUpTurnId: string | null;
  readonly followUpItemId: string | null;
  readonly acceptedAt: string;
}

/** Input for creating one accepted pending steering owner. */
export interface CreatePendingUserTurnRecordInput {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly goalId: string;
  readonly activeTurnId: string;
  readonly requestId: string;
  readonly input: PendingUserTurnInput;
  readonly receivedAt: string;
}

/** Deterministic identities created by one accepted send request. */
export interface PendingUserTurnIds {
  readonly pendingTurnId: string;
  readonly contentItemId: string;
}

/** Scope used to derive deterministic pending identities. */
export interface PendingUserTurnIdScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
}

/** Input for claiming one pending owner through its three-field fence. */
export interface ClaimPendingUserTurnRecordInput {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly pendingTurnId: string;
  readonly terminalClaimKind: SteeringTerminalClaimKind;
  readonly terminalClaimId: string;
  readonly terminalClaimedAt: string;
}

/** Scope used to derive one terminal command's deterministic identities. */
export interface SteeringTerminalIdScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly pendingTurnId: string;
  readonly terminalRequestId: string;
}

/** Deterministic identities reserved by one terminal command. */
export interface SteeringTerminalIds {
  readonly outcomeId: string;
  readonly followUpTurnId: string;
  readonly followUpItemId: string;
}

/** Input for committing one terminal outcome after caller-owned proof verification. */
export interface CompleteSteeringTerminalOutcomeInput extends SteeringTerminalIdScope {
  readonly state: SteeringTerminalOutcomeState;
}

/** Input for deleting one exactly applied pending owner. */
export interface DeleteAppliedPendingUserTurnRecordInput {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly pendingTurnId: string;
  readonly contextPackageId: string;
}

const PENDING_SELECT = `SELECT
  workspace_id AS workspaceId,
  thread_id AS threadId,
  pending_turn_id AS pendingTurnId,
  goal_id AS goalId,
  active_turn_id AS activeTurnId,
  request_id AS requestId,
  content_item_id AS contentItemId,
  input_kind AS inputKind,
  material_id AS materialId,
  revision_id AS revisionId,
  content_digest AS contentDigest,
  queue_mode AS queueMode,
  received_at AS receivedAt,
  terminal_claim_kind AS terminalClaimKind,
  terminal_claim_id AS terminalClaimId,
  terminal_claimed_at AS terminalClaimedAt
FROM pending_user_turn_records`;

const OUTCOME_SELECT = `SELECT
  workspace_id AS workspaceId,
  thread_id AS threadId,
  pending_turn_id AS pendingTurnId,
  outcome_id AS outcomeId,
  state,
  send_request_id AS sendRequestId,
  terminal_request_id AS terminalRequestId,
  content_item_id AS contentItemId,
  goal_id AS goalId,
  active_turn_id AS activeTurnId,
  input_kind AS inputKind,
  material_id AS materialId,
  revision_id AS revisionId,
  content_digest AS contentDigest,
  follow_up_turn_id AS followUpTurnId,
  follow_up_item_id AS followUpItemId,
  accepted_at AS acceptedAt
FROM steering_terminal_outcomes`;

/**
 * Derives the exact pending Turn and content Item identities for one send request.
 *
 * @param scope Immutable command scope.
 * @returns Deterministic pending owner identities.
 */
export function derivePendingUserTurnIds(scope: PendingUserTurnIdScope): PendingUserTurnIds {
  const values = [scope.workspaceId, scope.threadId, scope.requestId];
  return {
    pendingTurnId: deterministicId('tu_pending', values),
    contentItemId: deterministicId('it_steering', values),
  };
}

/**
 * Derives immutable owner and follow-up identities for one terminal request.
 *
 * @param scope Immutable terminal command scope.
 * @returns Deterministic outcome, Turn, and Item identities.
 */
export function deriveSteeringTerminalIds(scope: SteeringTerminalIdScope): SteeringTerminalIds {
  const values = [scope.workspaceId, scope.threadId, scope.pendingTurnId, scope.terminalRequestId];
  return {
    outcomeId: deterministicId('sto', values),
    followUpTurnId: deterministicId('tu_follow_up', values),
    followUpItemId: deterministicId('it_follow_up', values),
  };
}

/**
 * Verifies one owner's exact Item/Turn lineage and any live pending send receipt.
 *
 * Terminal outcomes remain self-contained after the original send receipt reaches normal expiry.
 *
 * @param workspaceDb Open Workspace database that owns any live receipt.
 * @param store App-local Item and Turn owner.
 * @param owner Pending row or immutable terminal outcome being projected.
 * @returns Exact completed source Item.
 * @throws GoalSteeringAuthorityError when Item/Turn lineage or a required pending receipt is unsafe.
 */
export function requireGoalSteeringSendProof(
  workspaceDb: WorkspaceDb,
  store: FsStore,
  owner: PendingUserTurnRecord | SteeringTerminalOutcome
): SteeringSourceItem {
  const sendRequestId = 'requestId' in owner ? owner.requestId : owner.sendRequestId;
  const receivedAt = 'receivedAt' in owner ? owner.receivedAt : undefined;
  let turn: ReturnType<FsStore['getTurn']>;

  try {
    turn = store.getTurn(owner.workspaceId, owner.threadId, owner.activeTurnId);
  } catch {
    throw authorityError('recovery_required', 'The original steering Turn is missing.');
  }

  const item = turn.items.find((candidate) => candidate.id === owner.contentItemId);
  const materialLineageValid =
    owner.inputKind === 'message'
      ? owner.materialId === null && owner.revisionId === null && owner.contentDigest === null
      : Boolean(owner.materialId && owner.revisionId && owner.contentDigest);
  if (
    !item ||
    item.type !== 'user-message' ||
    item.workspaceId !== owner.workspaceId ||
    item.threadId !== owner.threadId ||
    item.turnId !== owner.activeTurnId ||
    item.status !== 'completed' ||
    (item.parentItemId ?? null) !== null ||
    item.causationId !== sendRequestId ||
    item.completedAt === null ||
    item.createdAt !== item.completedAt ||
    (receivedAt !== undefined && item.createdAt !== receivedAt) ||
    !materialLineageValid
  ) {
    throw authorityError('recovery_required', 'The original steering Item lineage is invalid.');
  }

  const receipt = store.getCommandRequest(
    'goal.steering.send',
    sendRequestId,
    { workspaceId: owner.workspaceId, threadId: owner.threadId },
    workspaceDb
  );
  if (!receipt) {
    if (!('requestId' in owner)) {
      return item;
    }
    throw authorityError('recovery_required', 'The original steering send receipt is invalid.');
  }
  if (
    receipt.command !== 'goal.steering.send' ||
    receipt.requestId !== sendRequestId ||
    Object.keys(receipt.scope).length !== 2 ||
    receipt.scope.workspaceId !== owner.workspaceId ||
    receipt.scope.threadId !== owner.threadId ||
    receipt.response.kind !== 'pending_user_turn' ||
    receipt.response.id !== owner.pendingTurnId ||
    receipt.response.conversationMetadata !== undefined
  ) {
    throw authorityError('recovery_required', 'The original steering send receipt is invalid.');
  }
  return item;
}

/**
 * Creates the one pending owner for a Thread.
 *
 * @param workspaceDb Open Workspace database.
 * @param input Accepted send lineage and exact input identity.
 * @returns Newly created pending owner.
 * @throws GoalSteeringAuthorityError when another owner, terminal proof, or receipt gap exists.
 */
export function createPendingUserTurnRecord(
  workspaceDb: WorkspaceDb,
  input: CreatePendingUserTurnRecordInput
): PendingUserTurnRecord {
  assertWorkspace(workspaceDb, input.workspaceId);
  const ids = derivePendingUserTurnIds(input);
  const existing = readPending(workspaceDb, input.workspaceId, input.threadId);

  if (existing) {
    if (existing.requestId !== input.requestId) {
      throw authorityError('conflict', 'This Thread already has a pending steering input.');
    }
    if (!matchesPendingInput(existing, input, ids)) {
      throw authorityError(
        'idempotency_key_conflict',
        'The steering request already owns different input or lineage.'
      );
    }
    throw authorityError(
      'recovery_required',
      'The steering owner exists without its completed command replay path.'
    );
  }
  if (readOutcome(workspaceDb, input.workspaceId, input.threadId, ids.pendingTurnId)) {
    throw authorityError(
      'recovery_required',
      'A terminal steering outcome already owns this send request identity.'
    );
  }

  const material =
    input.input.kind === 'material'
      ? input.input
      : { materialId: null, revisionId: null, contentDigest: null };
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO pending_user_turn_records (
        workspace_id, thread_id, pending_turn_id, goal_id, active_turn_id,
        request_id, content_item_id, input_kind, material_id, revision_id, content_digest,
        queue_mode, received_at, terminal_claim_kind, terminal_claim_id, terminal_claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'safe_point_steering', ?, NULL, NULL, NULL)`
    )
    .run(
      input.workspaceId,
      input.threadId,
      ids.pendingTurnId,
      input.goalId,
      input.activeTurnId,
      input.requestId,
      ids.contentItemId,
      input.input.kind,
      material.materialId,
      material.revisionId,
      material.contentDigest,
      input.receivedAt
    );

  return requirePending(workspaceDb, input.workspaceId, input.threadId, ids.pendingTurnId);
}

/**
 * Reads one Thread's pending steering owner and rejects terminal half-state coexistence.
 *
 * @param workspaceDb Open Workspace database.
 * @param workspaceId Owning Workspace.
 * @param threadId Owning Thread.
 * @returns Pending owner, or null when the Thread has none.
 * @throws GoalSteeringAuthorityError when matching terminal proof also exists.
 */
export function getPendingUserTurnRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string
): PendingUserTurnRecord | null {
  assertWorkspace(workspaceDb, workspaceId);
  const pending = readPending(workspaceDb, workspaceId, threadId);
  if (pending && readOutcome(workspaceDb, workspaceId, threadId, pending.pendingTurnId) !== null) {
    throw authorityError(
      'recovery_required',
      'Pending steering input coexists with its terminal outcome.'
    );
  }
  return pending;
}

/**
 * Claims one pending owner with the first-writer three-field fence.
 *
 * @param workspaceDb Open Workspace database.
 * @param input Exact pending and claimant identity.
 * @returns Claimed owner, including the winner's original timestamp on replay.
 * @throws GoalSteeringAuthorityError when the owner is absent, contradictory, or already claimed.
 */
export function claimPendingUserTurnRecord(
  workspaceDb: WorkspaceDb,
  input: ClaimPendingUserTurnRecordInput
): PendingUserTurnRecord {
  const pending = requirePending(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.pendingTurnId
  );
  assertNoMatchingOutcome(workspaceDb, pending);

  if (pending.terminalClaimKind !== null) {
    if (
      pending.terminalClaimKind === input.terminalClaimKind &&
      pending.terminalClaimId === input.terminalClaimId
    ) {
      return pending;
    }
    throw authorityError('conflict', 'Another terminal claimant already owns this input.');
  }

  const result = workspaceDb.sqlite
    .prepare(
      `UPDATE pending_user_turn_records
       SET terminal_claim_kind = ?, terminal_claim_id = ?, terminal_claimed_at = ?
       WHERE workspace_id = ? AND thread_id = ? AND pending_turn_id = ?
         AND terminal_claim_kind IS NULL AND terminal_claim_id IS NULL
         AND terminal_claimed_at IS NULL`
    )
    .run(
      input.terminalClaimKind,
      input.terminalClaimId,
      input.terminalClaimedAt,
      input.workspaceId,
      input.threadId,
      input.pendingTurnId
    );
  if (result.changes !== 1) {
    const winner = requirePending(
      workspaceDb,
      input.workspaceId,
      input.threadId,
      input.pendingTurnId
    );
    if (
      winner.terminalClaimKind === input.terminalClaimKind &&
      winner.terminalClaimId === input.terminalClaimId
    ) {
      return winner;
    }
    throw authorityError('conflict', 'Another terminal claimant won this input.');
  }

  return requirePending(workspaceDb, input.workspaceId, input.threadId, input.pendingTurnId);
}

/**
 * Deletes an applied pending owner inside the caller's accepted-trace transaction.
 *
 * @param workspaceDb Open Workspace database already in the final transaction.
 * @param input Exact applied claim identity.
 * @throws GoalSteeringAuthorityError when the claim or authority tuple is unsafe.
 * @throws Error when called outside the caller-owned Workspace transaction.
 */
export function deleteAppliedPendingUserTurnRecord(
  workspaceDb: WorkspaceDb,
  input: DeleteAppliedPendingUserTurnRecordInput
): void {
  requireCallerTransaction(workspaceDb);
  const pending = requirePending(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.pendingTurnId
  );
  assertNoMatchingOutcome(workspaceDb, pending);
  if (
    pending.terminalClaimKind !== 'applied' ||
    pending.terminalClaimId !== input.contextPackageId ||
    pending.terminalClaimedAt === null
  ) {
    throw authorityError('conflict', 'The applied cleanup does not own this pending input.');
  }
  deleteExactPending(workspaceDb, pending);
}

/**
 * Commits one immutable terminal outcome and deletes its exact pending owner.
 *
 * The caller must verify any deterministic follow-up Turn and Item before invoking this function,
 * and must write the body-free command receipt before the surrounding transaction commits.
 *
 * @param workspaceDb Open Workspace database already in the final transaction.
 * @param input Exact terminal request and result kind.
 * @returns Newly inserted immutable outcome.
 * @throws GoalSteeringAuthorityError when the pending claim or durable tuple is unsafe.
 * @throws Error when called outside the caller-owned Workspace transaction.
 */
export function completeSteeringTerminalOutcome(
  workspaceDb: WorkspaceDb,
  input: CompleteSteeringTerminalOutcomeInput
): SteeringTerminalOutcome {
  requireCallerTransaction(workspaceDb);
  const pending = requirePending(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.pendingTurnId
  );
  assertNoMatchingOutcome(workspaceDb, pending);
  if (pending.requestId === input.terminalRequestId) {
    throw authorityError(
      'idempotency_key_conflict',
      'Terminal and send request identities must be distinct.'
    );
  }
  const ids = deriveSteeringTerminalIds(input);
  const expectedClaimId =
    input.state === 'follow-up' ? ids.followUpTurnId : input.terminalRequestId;
  if (
    pending.terminalClaimKind !== input.state ||
    pending.terminalClaimId !== expectedClaimId ||
    pending.terminalClaimedAt === null
  ) {
    throw authorityError('conflict', 'The terminal request does not own this pending input.');
  }
  const followUpTurnId = input.state === 'follow-up' ? ids.followUpTurnId : null;
  const followUpItemId = input.state === 'follow-up' ? ids.followUpItemId : null;

  try {
    workspaceDb.sqlite
      .prepare(
        `INSERT INTO steering_terminal_outcomes (
          workspace_id, thread_id, pending_turn_id, outcome_id, state,
          send_request_id, terminal_request_id, content_item_id, goal_id, active_turn_id,
          input_kind, material_id, revision_id, content_digest,
          follow_up_turn_id, follow_up_item_id, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pending.workspaceId,
        pending.threadId,
        pending.pendingTurnId,
        ids.outcomeId,
        input.state,
        pending.requestId,
        input.terminalRequestId,
        pending.contentItemId,
        pending.goalId,
        pending.activeTurnId,
        pending.inputKind,
        pending.materialId,
        pending.revisionId,
        pending.contentDigest,
        followUpTurnId,
        followUpItemId,
        pending.terminalClaimedAt
      );
  } catch (error) {
    if (
      (error as { readonly code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      getSteeringTerminalOutcomeByRequestId(
        workspaceDb,
        pending.workspaceId,
        pending.threadId,
        input.terminalRequestId
      ) !== null
    ) {
      throw authorityError(
        'idempotency_key_conflict',
        'The terminal request already owns a different pending steering input.'
      );
    }
    throw error;
  }
  deleteExactPending(workspaceDb, pending);

  const outcome = readOutcome(workspaceDb, input.workspaceId, input.threadId, input.pendingTurnId);
  if (!outcome) {
    throw authorityError('recovery_required', 'The terminal outcome insert did not persist.');
  }
  return outcome;
}

/**
 * Reads one immutable terminal outcome and rejects pending-owner coexistence.
 *
 * @param workspaceDb Open Workspace database.
 * @param workspaceId Owning Workspace.
 * @param threadId Owning Thread.
 * @param pendingTurnId Original pending owner identity.
 * @returns Immutable outcome, or null when none exists.
 * @throws GoalSteeringAuthorityError when the original pending owner still coexists.
 */
export function getSteeringTerminalOutcome(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  pendingTurnId: string
): SteeringTerminalOutcome | null {
  assertWorkspace(workspaceDb, workspaceId);
  const outcome = readOutcome(workspaceDb, workspaceId, threadId, pendingTurnId);
  if (outcome && readPending(workspaceDb, workspaceId, threadId)?.pendingTurnId === pendingTurnId) {
    throw authorityError(
      'recovery_required',
      'Terminal steering outcome coexists with its pending owner.'
    );
  }
  return outcome;
}

/**
 * Reads the one immutable terminal outcome owned by a Thread-scoped terminal request.
 *
 * @param workspaceDb Open Workspace database.
 * @param workspaceId Owning Workspace.
 * @param threadId Owning Thread.
 * @param terminalRequestId Terminal command request identity.
 * @returns Immutable outcome, or null when the request has no outcome.
 * @throws GoalSteeringAuthorityError when the original pending owner still coexists.
 */
export function getSteeringTerminalOutcomeByRequestId(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  terminalRequestId: string
): SteeringTerminalOutcome | null {
  assertWorkspace(workspaceDb, workspaceId);
  const outcome =
    (workspaceDb.sqlite
      .prepare(
        `${OUTCOME_SELECT} WHERE workspace_id = ? AND thread_id = ? AND terminal_request_id = ?`
      )
      .get(workspaceId, threadId, terminalRequestId) as SteeringTerminalOutcome | undefined) ??
    null;
  if (
    outcome &&
    readPending(workspaceDb, workspaceId, threadId)?.pendingTurnId === outcome.pendingTurnId
  ) {
    throw authorityError(
      'recovery_required',
      'Terminal steering outcome coexists with its pending owner.'
    );
  }
  return outcome;
}

/** Reads one pending row without cross-owner validation. @param workspaceDb Open database. @param workspaceId Workspace id. @param threadId Thread id. @returns Stored row or null. */
function readPending(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string
): PendingUserTurnRecord | null {
  return (
    (workspaceDb.sqlite
      .prepare(`${PENDING_SELECT} WHERE workspace_id = ? AND thread_id = ?`)
      .get(workspaceId, threadId) as PendingUserTurnRecord | undefined) ?? null
  );
}

/** Reads one outcome row without cross-owner validation. @param workspaceDb Open database. @param workspaceId Workspace id. @param threadId Thread id. @param pendingTurnId Pending id. @returns Stored row or null. */
function readOutcome(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  pendingTurnId: string
): SteeringTerminalOutcome | null {
  return (
    (workspaceDb.sqlite
      .prepare(`${OUTCOME_SELECT} WHERE workspace_id = ? AND thread_id = ? AND pending_turn_id = ?`)
      .get(workspaceId, threadId, pendingTurnId) as SteeringTerminalOutcome | undefined) ?? null
  );
}

/** Requires one exact pending identity. @param workspaceDb Open database. @param workspaceId Workspace id. @param threadId Thread id. @param pendingTurnId Pending id. @returns Exact pending row. */
function requirePending(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  pendingTurnId: string
): PendingUserTurnRecord {
  assertWorkspace(workspaceDb, workspaceId);
  const pending = readPending(workspaceDb, workspaceId, threadId);
  if (!pending) {
    if (readOutcome(workspaceDb, workspaceId, threadId, pendingTurnId)) {
      throw authorityError(
        'recovery_required',
        'The pending owner is absent after a terminal effect; replay must use its receipt.'
      );
    }
    throw authorityError('stale', 'The pending steering input does not exist.');
  }
  if (pending.pendingTurnId !== pendingTurnId) {
    throw authorityError('conflict', 'Another pending steering input owns this Thread.');
  }
  return pending;
}

/** Rejects a pending-plus-outcome half-state. @param workspaceDb Open database. @param pending Pending owner. */
function assertNoMatchingOutcome(workspaceDb: WorkspaceDb, pending: PendingUserTurnRecord): void {
  if (readOutcome(workspaceDb, pending.workspaceId, pending.threadId, pending.pendingTurnId)) {
    throw authorityError(
      'recovery_required',
      'Pending steering input coexists with its terminal outcome.'
    );
  }
}

/** Deletes one exact claimed pending row. @param workspaceDb Open database in a transaction. @param pending Exact pending owner. */
function deleteExactPending(workspaceDb: WorkspaceDb, pending: PendingUserTurnRecord): void {
  const result = workspaceDb.sqlite
    .prepare(
      `DELETE FROM pending_user_turn_records
       WHERE workspace_id = ? AND thread_id = ? AND pending_turn_id = ?
         AND terminal_claim_kind = ? AND terminal_claim_id = ? AND terminal_claimed_at = ?`
    )
    .run(
      pending.workspaceId,
      pending.threadId,
      pending.pendingTurnId,
      pending.terminalClaimKind,
      pending.terminalClaimId,
      pending.terminalClaimedAt
    );
  if (result.changes !== 1) {
    throw authorityError('recovery_required', 'The claimed pending owner changed before cleanup.');
  }
}

/** Checks one create request against an existing owner. @param pending Existing owner. @param input Proposed create input. @param ids Derived identities. @returns True for the exact same owner tuple. */
function matchesPendingInput(
  pending: PendingUserTurnRecord,
  input: CreatePendingUserTurnRecordInput,
  ids: PendingUserTurnIds
): boolean {
  const material = input.input.kind === 'material' ? input.input : null;
  return (
    pending.pendingTurnId === ids.pendingTurnId &&
    pending.contentItemId === ids.contentItemId &&
    pending.goalId === input.goalId &&
    pending.activeTurnId === input.activeTurnId &&
    pending.inputKind === input.input.kind &&
    pending.materialId === (material?.materialId ?? null) &&
    pending.revisionId === (material?.revisionId ?? null) &&
    pending.contentDigest === (material?.contentDigest ?? null)
  );
}

/** Requires the explicit caller-owned final Workspace transaction. @param workspaceDb Open database. */
function requireCallerTransaction(workspaceDb: WorkspaceDb): void {
  if (!workspaceDb.sqlite.inTransaction) {
    throw new Error('Goal steering finalization requires a caller Workspace transaction.');
  }
}

/** Rejects cross-Workspace database use. @param workspaceDb Open database. @param workspaceId Requested Workspace. */
function assertWorkspace(workspaceDb: WorkspaceDb, workspaceId: string): void {
  if (workspaceDb.workspaceId !== workspaceId) {
    throw authorityError('stale', 'The steering owner is not in the requested Workspace.');
  }
}

/** Derives one stable non-secret identity. @param prefix Resource prefix. @param scope Immutable scope. @returns Stable identity. */
function deterministicId(prefix: string, scope: readonly string[]): string {
  return `${prefix}_${createHash('sha256')
    .update(JSON.stringify(scope), 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

/** Creates one typed authority failure. @param code Stable code. @param message Failure summary. @returns Typed error. */
function authorityError(
  code: GoalSteeringAuthorityErrorCode,
  message: string
): GoalSteeringAuthorityError {
  return new GoalSteeringAuthorityError(code, message);
}
