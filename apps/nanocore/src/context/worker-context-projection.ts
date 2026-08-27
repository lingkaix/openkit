import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadMaterialActiveDelivery } from '@openkit/app-api-schemas';

import {
  GoalSteeringAuthorityError,
  getPendingUserTurnRecord,
  type PendingUserTurnRecord,
  requireGoalSteeringSendProof,
} from '../goal-steering-authority.js';
import type { FsStore } from '../lib/store.js';
import { getGoalRecord } from '../runtime/goal-store.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import {
  assertCanonicalDirectory,
  readCanonicalTextFile,
} from '../storage/workspace-file-records.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';
import {
  readWorkerContextPackageTrace,
  verifyPortableWorkerContextPackageTrace,
  type WorkerContextPackageTrace,
} from './worker-context-package.js';

const IMPORTED_HISTORY_REQUEST_ID = /^import-lineage:sha256:[a-f0-9]{64}$/;

/** One fully verified trace paired with its owning Turn timestamp. */
export interface VerifiedWorkerContextTrace {
  /** Accepted Turn start time used by the S16 read-model ordering rule. */
  readonly startedAt: string;
  /** Immutable trace already accepted by the shared S39 verifier. */
  readonly trace: WorkerContextPackageTrace;
  /** Exact authority branch that fully verified the trace. */
  readonly verification: 'strict' | 'imported-history';
}

/** Derived Material revision identities exposed by the Thread read model. */
export interface ThreadMaterialTraceProjection {
  /** Latest verified revision seen by any accepted worker Turn. */
  readonly lastWorkerSeenRevisionId: string | null;
  /** Revision selected by the exact current accepted worker Turn. */
  readonly currentTurnRevisionId: string | null;
}

/** Existing authorities required to derive one Thread's worker Context Package read state. */
export interface WorkerContextProjectionInput {
  /** Core scheduler and backend-session owner. */
  readonly coreDb: CoreDb;
  /** Product Turn, Item, and AgentSession owner. */
  readonly store: FsStore;
  /** Workspace-owned Goal, Material, package, and steering owner. */
  readonly workspaceDb: WorkspaceDb;
  /** Thread whose immutable traces are inspected. */
  readonly threadId: string;
}

/**
 * Reads one strict accepted S39 digest without promoting imported or incomplete history.
 *
 * @param input Existing authorities plus the exact Turn to verify.
 * @returns Digest from the fully verified immutable Context Package trace.
 * @throws Error when the strict trace or any required authority is unavailable or contradictory.
 */
export function readStrictWorkerContextPackageDigest(
  input: WorkerContextProjectionInput & { readonly turnId: string }
): string {
  const workspaceId = input.workspaceDb.workspaceId;
  const workspaceRoot = resolveDataRootPath(input.workspaceDb.dataRoot, 'workspaces', workspaceId);

  return readWorkerContextPackageTrace({
    authorities: createWorkerContextPackageAuthorityReader(input),
    threadId: input.threadId,
    turnId: input.turnId,
    workspaceId,
    workspaceRoot,
  }).contextPackageDigest;
}

/** Verified projection of the single current Goal steering owner. */
export interface PendingGoalSteeringProjection {
  /** Exact pending owner retained until terminal cleanup. */
  readonly owner: PendingUserTurnRecord;
  /** Current state derived from the pending row and exact trace proof. */
  readonly state: 'queued' | 'applied';
  /** Whether only explicit follow-up or cancellation may consume the row. */
  readonly originalGoalTerminal: boolean;
}

/** Derived S16 fields added to the Thread Material read model. */
export interface ThreadMaterialContextProjection extends ThreadMaterialTraceProjection {
  /** Current pending delivery for this exact Material, if any. */
  readonly activeDelivery: ThreadMaterialActiveDelivery | null;
}

/**
 * Selects Material revision identities from already-verified S39 traces.
 *
 * @param input Material identity, exact current Turn, and verified trace set.
 * @returns Historical and current revision projections without persisting derived state.
 */
export function projectVerifiedThreadMaterialTraces(input: {
  readonly materialId: string;
  readonly currentTurnId: string | null;
  readonly traces: readonly VerifiedWorkerContextTrace[];
}): ThreadMaterialTraceProjection {
  const traces = [...input.traces].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      right.trace.turnId.localeCompare(left.trace.turnId)
  );
  const revisionFor = (trace: WorkerContextPackageTrace | undefined): string | null =>
    trace?.materialSelections.find((selection) => selection.materialId === input.materialId)
      ?.revisionId ?? null;

  return {
    lastWorkerSeenRevisionId:
      traces.map(({ trace }) => revisionFor(trace)).find((revisionId) => revisionId !== null) ??
      null,
    currentTurnRevisionId: revisionFor(
      traces.find(
        ({ trace, verification }) =>
          verification === 'strict' && trace.turnId === input.currentTurnId
      )?.trace
    ),
  };
}

/**
 * Selects the unique verified trace containing one Goal steering Item.
 *
 * @param traces Fully verified traces from the owning Thread.
 * @param input Exact original Goal and steering Item lineage.
 * @returns The unique matching trace, or null when delivery has no trace proof.
 * @throws GoalSteeringAuthorityError when Item, Goal, Material, or uniqueness proof disagrees.
 */
export function selectVerifiedGoalSteeringTrace(
  traces: readonly WorkerContextPackageTrace[],
  input: Pick<
    PendingUserTurnRecord,
    'goalId' | 'contentItemId' | 'inputKind' | 'materialId' | 'revisionId' | 'contentDigest'
  >
): WorkerContextPackageTrace | null {
  const itemTraces = traces.filter(
    (trace) =>
      !IMPORTED_HISTORY_REQUEST_ID.test(trace.requestId) &&
      trace.includedItemIds.includes(input.contentItemId)
  );
  if (itemTraces.some((trace) => trace.goalId !== input.goalId)) {
    throw recoveryRequired('Goal steering delivery proof has contradictory Goal lineage.');
  }
  const matches = itemTraces.filter((trace) => trace.goalId === input.goalId);
  if (matches.length > 1) {
    throw recoveryRequired('Goal steering delivery proof is ambiguous.');
  }
  const matchingTrace = matches[0] ?? null;
  if (matchingTrace) {
    assertExactPendingMaterialSelection(input, matchingTrace);
  }
  return matchingTrace;
}

/**
 * Requires the unique fully verified trace containing one deterministic steering Item.
 *
 * @param input Existing authority owners plus the exact deterministic steering Item.
 * @returns The unique matching accepted trace whose Goal is historical authority.
 * @throws GoalSteeringAuthorityError when proof is absent, corrupt, ambiguous, or not Goal-owned.
 */
export function requireVerifiedGoalSteeringTrace(
  input: WorkerContextProjectionInput & {
    readonly contentItemId: string;
  }
): WorkerContextPackageTrace {
  const matches = readVerifiedThreadWorkerContextTraces(input)
    .filter(({ verification }) => verification === 'strict')
    .map(({ trace }) => trace)
    .filter((trace) => trace.includedItemIds.includes(input.contentItemId));
  if (matches.length === 0) {
    throw recoveryRequired('Goal steering delivery proof is unavailable.');
  }
  if (matches.length > 1) {
    throw recoveryRequired('Goal steering delivery proof is ambiguous.');
  }
  if (matches[0]!.goalId === null) {
    throw recoveryRequired('Goal steering delivery proof has no Goal lineage.');
  }
  return matches[0]!;
}

/** Reads and fully verifies every accepted trace file present in one Thread. */
function readVerifiedThreadWorkerContextTraces(
  input: WorkerContextProjectionInput
): VerifiedWorkerContextTrace[] {
  const workspaceId = input.workspaceDb.workspaceId;
  const workspaceRoot = resolveDataRootPath(input.workspaceDb.dataRoot, 'workspaces', workspaceId);
  const turns = input.store.listThreadTurns(workspaceId, input.threadId);
  const turnsWithTrace = turns.filter((turn) =>
    existsSync(
      join(workspaceRoot, 'threads', input.threadId, 'turns', turn.id, 'context-package.json')
    )
  );
  const admitted = listSchedulerAdmissionEntriesForWorkspace(input.coreDb, {
    workspaceId,
    statuses: ['admitted'],
  }).filter((entry) => entry.threadId === input.threadId);
  if (
    turns.some(
      (turn) =>
        turn.agentSessionId != null && !turnsWithTrace.some((candidate) => candidate.id === turn.id)
    ) ||
    admitted.some((entry) => !turnsWithTrace.some((turn) => turn.id === entry.turnId))
  ) {
    throw recoveryRequired(
      'An accepted worker Turn or admitted scheduler entry lacks its Context Package trace.'
    );
  }
  if (turnsWithTrace.length === 0) {
    return [];
  }

  try {
    const authorities = createWorkerContextPackageAuthorityReader(input);
    return turnsWithTrace.map((turn) => {
      const path = join(
        workspaceRoot,
        'threads',
        input.threadId,
        'turns',
        turn.id,
        'context-package.json'
      );
      for (const directory of [
        workspaceRoot,
        join(workspaceRoot, 'threads'),
        join(workspaceRoot, 'threads', input.threadId),
        join(workspaceRoot, 'threads', input.threadId, 'turns'),
        join(workspaceRoot, 'threads', input.threadId, 'turns', turn.id),
      ]) {
        assertCanonicalDirectory(directory);
      }
      const trace = JSON.parse(readCanonicalTextFile(path)) as WorkerContextPackageTrace;
      if (
        trace.workspaceId !== workspaceId ||
        trace.threadId !== input.threadId ||
        trace.turnId !== turn.id
      ) {
        throw new Error('Worker Context Package trace path lineage mismatch.');
      }
      const verified = verifyPortableWorkerContextPackageTrace({
        authorities,
        trace,
        workspaceRoot,
      });
      if (!turn.startedAt) {
        throw new Error('Worker Context Package Turn lacks its start time.');
      }
      return { startedAt: turn.startedAt, ...verified };
    });
  } catch {
    throw recoveryRequired('Worker Context Package authority is inconsistent.');
  }
}

/**
 * Projects the current pending Goal steering owner from existing durable proof only.
 *
 * @param input Existing authority owners and Thread scope.
 * @returns Verified queued or applied state, or null when no pending owner exists.
 * @throws GoalSteeringAuthorityError when the owner or downstream proof is contradictory.
 */
export function readPendingGoalSteeringProjection(
  input: WorkerContextProjectionInput
): PendingGoalSteeringProjection | null {
  const pending = getPendingUserTurnRecord(
    input.workspaceDb,
    input.workspaceDb.workspaceId,
    input.threadId
  );
  return pending
    ? projectPendingGoalSteering(
        input,
        pending,
        readVerifiedThreadWorkerContextTraces(input)
          .filter(({ verification }) => verification === 'strict')
          .map(({ trace }) => trace)
      )
    : null;
}

/**
 * Derives the S16 worker-seen and active-delivery fields for one bound Material.
 *
 * @param input Existing authority owners, Thread scope, and bound Material identity.
 * @returns Three read-only fields backed only by current durable owners.
 * @throws GoalSteeringAuthorityError when a trace or pending owner is contradictory.
 */
export function projectThreadMaterialContext(
  input: WorkerContextProjectionInput & { readonly materialId: string }
): ThreadMaterialContextProjection {
  const verifiedTraces = readVerifiedThreadWorkerContextTraces(input);
  const nonTerminalTurns = input.store
    .listThreadTurns(input.workspaceDb.workspaceId, input.threadId)
    .filter(
      (turn) =>
        turn.status === 'pending' || turn.status === 'running' || turn.status === 'awaiting_human'
    );
  if (nonTerminalTurns.length > 1) {
    throw recoveryRequired('The Thread has ambiguous non-terminal Turn authority.');
  }
  const currentTurnId = verifiedTraces.some(
    ({ trace, verification }) =>
      verification === 'strict' && trace.turnId === nonTerminalTurns[0]?.id
  )
    ? (nonTerminalTurns[0]?.id ?? null)
    : null;
  const traceProjection = projectVerifiedThreadMaterialTraces({
    materialId: input.materialId,
    currentTurnId,
    traces: verifiedTraces,
  });
  const pending = getPendingUserTurnRecord(
    input.workspaceDb,
    input.workspaceDb.workspaceId,
    input.threadId
  );
  const delivery = pending
    ? projectPendingGoalSteering(
        input,
        pending,
        verifiedTraces
          .filter(({ verification }) => verification === 'strict')
          .map(({ trace }) => trace)
      )
    : null;

  return {
    ...traceProjection,
    activeDelivery:
      delivery?.owner.inputKind === 'material' && delivery.owner.materialId === input.materialId
        ? materialDelivery(delivery)
        : null,
  };
}

/** Derives one pending state after verifying its send receipt, Item, Goal, and trace effects. */
function projectPendingGoalSteering(
  input: WorkerContextProjectionInput,
  pending: PendingUserTurnRecord,
  traces: readonly WorkerContextPackageTrace[]
): PendingGoalSteeringProjection {
  requireGoalSteeringSendProof(input.workspaceDb, input.store, pending);
  const goal = getGoalRecord(
    input.workspaceDb,
    pending.workspaceId,
    pending.threadId,
    pending.goalId
  );
  if (!goal) {
    throw recoveryRequired('The original Goal steering owner is missing.');
  }
  const matchingTrace = selectVerifiedGoalSteeringTrace(traces, pending);
  const claimedTrace = traces.find((trace) => trace.contextPackageId === pending.terminalClaimId);
  if (claimedTrace && claimedTrace !== matchingTrace) {
    throw recoveryRequired('Goal steering delivery claim has contradictory trace proof.');
  }

  let state: PendingGoalSteeringProjection['state'] = 'queued';
  if (matchingTrace) {
    if (
      pending.terminalClaimKind !== 'applied' ||
      pending.terminalClaimId !== matchingTrace.contextPackageId
    ) {
      throw recoveryRequired('Goal steering trace is not owned by the applied claim.');
    }
    state = 'applied';
  }

  const hasFollowUpEffect = input.store
    .listThreadTurns(pending.workspaceId, pending.threadId)
    .some(
      (turn) =>
        turn.id === pending.terminalClaimId ||
        turn.items.some((item) => item.parentItemId === pending.contentItemId)
    );
  if (hasFollowUpEffect) {
    throw recoveryRequired('Goal steering follow-up effect coexists with pending delivery.');
  }

  return {
    owner: pending,
    state,
    originalGoalTerminal:
      goal.status === 'completed' ||
      goal.status === 'blocked' ||
      goal.status === 'aborted' ||
      goal.status === 'failed',
  };
}

/** Verifies the exact optional Material tuple carried by one applied steering trace. */
function assertExactPendingMaterialSelection(
  pending: Pick<PendingUserTurnRecord, 'inputKind' | 'materialId' | 'revisionId' | 'contentDigest'>,
  trace: WorkerContextPackageTrace
): void {
  if (pending.inputKind === 'message') {
    return;
  }
  const selection = trace.materialSelections.find(
    (candidate) => candidate.materialId === pending.materialId
  );
  if (
    !selection ||
    selection.revisionId !== pending.revisionId ||
    selection.contentDigest !== pending.contentDigest ||
    selection.inclusionReason !== 'goal_steering'
  ) {
    throw recoveryRequired('Goal steering Material delivery proof is inconsistent.');
  }
}

/** Converts one verified Material pending owner into its closed public shape. */
function materialDelivery(projection: PendingGoalSteeringProjection): ThreadMaterialActiveDelivery {
  const owner = projection.owner;
  if (!owner.materialId || !owner.revisionId || !owner.contentDigest) {
    throw recoveryRequired('Goal steering Material authority is incomplete.');
  }
  return {
    state: projection.state,
    pendingTurnId: owner.pendingTurnId,
    requestId: owner.requestId,
    contentItemId: owner.contentItemId,
    goalId: owner.goalId,
    activeTurnId: owner.activeTurnId,
    materialId: owner.materialId,
    revisionId: owner.revisionId,
    contentDigest: owner.contentDigest,
  };
}

/** Creates the product-safe fail-closed error used by S16 read projections. */
function recoveryRequired(message: string): GoalSteeringAuthorityError {
  return new GoalSteeringAuthorityError('recovery_required', message);
}
