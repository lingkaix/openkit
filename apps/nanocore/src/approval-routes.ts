import { isDeepStrictEqual } from 'node:util';

import {
  ApprovalRequestSchema,
  RespondToApprovalRequestSchema,
  TurnSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { apiErrorPayload, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { StructuredWorkerDelegationRequestSchema } from './internal-agents/delegation.js';
import type { FsStore } from './lib/store.js';
import {
  listPolicyApprovalSourceDecisions,
  type PolicyApprovalSourceDecision,
  type PolicyApprovalTerminalWinner,
  readPolicyApprovalTerminalWinner,
  recordProductPermissionDecision,
} from './policy/permission-decisions.js';
import {
  getGoalRecord,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './runtime/goal-store.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import {
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  parseWorkerCheckpointEvidence,
  updateWorkerCheckpoint,
  type WorkerCheckpointRecord,
} from './runtime/worker-checkpoints.js';
import {
  classifyClosedWorkerApprovalGate,
  clearWorkerCheckpointAfterTerminalState,
  hasExactActiveHumanGate,
  recoverWorkerCheckpointStopReason,
  requireWorkerCheckpointHumanCommandScope,
} from './runtime/worker-recovery.js';
import {
  completeSchedulerLeaseForTerminalTurn,
  listSchedulerSessionLeasesForTurn,
} from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/**
 * Registers the approval response lifecycle route.
 *
 * @param dependencies Hono app and concrete approval persistence and runtime dependencies.
 */
export function registerApprovalRoutes({
  app,
  coreDb,
  inflightCommands,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  app.post('/api/approvals/:approvalRequestId/respond', async (c) => {
    const parsed = RespondToApprovalRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      approvalRequestId: c.req.param('approvalRequestId'),
    });

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const input = parsed.data;
      const store = requestStore(c);
      const storedApproval = store.getApproval(input.approvalRequestId);
      const actor = { kind: 'user' as const, id: c.get('actor').userId };

      if (
        storedApproval.workspaceId !== input.workspaceId ||
        storedApproval.threadId !== input.threadId ||
        storedApproval.turnId !== input.turnId
      ) {
        throw new Error(`Approval request scope mismatch: ${input.approvalRequestId}`);
      }

      const commandScope = {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId,
        approvalRequestId: input.approvalRequestId,
      };
      const workerLeases = coreDb
        ? listSchedulerSessionLeasesForTurn(coreDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId: input.turnId,
          })
        : [];
      const approvalResponseReceipt = store.getCommandRequest(
        'approval.respond',
        input.requestId,
        commandScope
      );

      if (coreDb) {
        const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
        try {
          const workerCheckpoint = getWorkerCheckpoint(
            workspaceDb,
            input.workspaceId,
            input.threadId,
            input.turnId
          );
          let policySources: ReturnType<typeof listPolicyApprovalSourceDecisions>;
          try {
            policySources = listPolicyApprovalSourceDecisions(
              workspaceDb,
              input.workspaceId,
              input.approvalRequestId
            );
          } catch {
            throw taskGateRecoveryError('The policy approval source tuple is invalid.');
          }
          if (policySources.length > 1 || workerLeases.length > 1) {
            throw taskGateRecoveryError('The policy approval owner tuple is not unique.');
          }
          const policyApproval = policySources[0] ?? null;
          if (!policyApproval) {
            let orphanWinner: PolicyApprovalTerminalWinner | null;
            try {
              orphanWinner = readPolicyApprovalTerminalWinner(
                workspaceDb,
                input.workspaceId,
                input.approvalRequestId,
                input.threadId,
                input.turnId
              );
            } catch {
              throw taskGateRecoveryError('The policy approval terminal claim is invalid.');
            }
            if (orphanWinner) {
              throw taskGateRecoveryError('The policy approval winner has no exact source.');
            }
          }
          if (policyApproval && policyApproval.action !== 'repo.push') {
            throw taskGateRecoveryError('The policy approval action is not supported.');
          }
          const closedWorkerGate =
            workerLeases.length === 1
              ? classifyClosedWorkerApprovalGate(
                  store,
                  store.getTurn(input.workspaceId, input.threadId, input.turnId)
                )
              : null;
          if (policyApproval && (!workerCheckpoint || closedWorkerGate)) {
            const decisionItemId = `it_approval_decision_${
              workerLeases.length === 1 ? input.turnId : input.approvalRequestId
            }`;
            let approval: ReturnType<FsStore['getApproval']>;
            try {
              approval = await runIdempotentCommand({
                store,
                inflightCommands,
                command: 'approval.respond',
                requestId: input.requestId,
                scope: commandScope,
                input,
                responseKind: 'approval',
                execute: () => {
                  if (workerLeases.length === 1) {
                    if (!closedWorkerGate) {
                      throw taskGateRecoveryError(
                        'The worker approval Gate has no supported exact checkpoint.'
                      );
                    }
                    claimPolicyApprovalOutcome(workspaceDb, store, policyApproval, input, actor);
                    throw taskGateRecoveryError(
                      'The closed worker approval has no command receipt.'
                    );
                  }
                  return finishPolicyApprovalProjection(
                    store,
                    claimPolicyApprovalOutcome(workspaceDb, store, policyApproval, input, actor),
                    input,
                    decisionItemId
                  );
                },
                replay: (record) => {
                  if (
                    record.response.kind !== 'approval' ||
                    record.response.id !== input.approvalRequestId
                  ) {
                    throw taskGateRecoveryError(
                      'The policy approval receipt has no exact Approval owner.'
                    );
                  }
                  if (workerLeases.length === 1 && !closedWorkerGate) {
                    throw taskGateRecoveryError(
                      'The closed worker approval projection is incomplete.'
                    );
                  }
                  return finishPolicyApprovalProjection(
                    store,
                    claimPolicyApprovalOutcome(workspaceDb, store, policyApproval, input, actor),
                    input,
                    decisionItemId
                  );
                },
                responseId: (result) => result.id,
              });
            } catch (error) {
              if (error instanceof IdempotencyKeyConflictError) {
                throw error;
              }
              const receipt = store.getCommandRequest(
                'approval.respond',
                input.requestId,
                commandScope
              );
              let winner: PolicyApprovalTerminalWinner | null = null;
              try {
                winner = readPolicyApprovalTerminalWinner(
                  workspaceDb,
                  input.workspaceId,
                  input.approvalRequestId,
                  input.threadId,
                  input.turnId
                );
              } catch {
                throw taskGateRecoveryError(
                  'The policy approval terminal claim is incomplete or contradictory.'
                );
              }
              if (!receipt && winner?.requestId === input.requestId) {
                throw taskGateRecoveryError(
                  'The policy approval winner exists without its command receipt.'
                );
              }
              throw error;
            }

            if (workerCheckpoint && closedWorkerGate) {
              await clearWorkerApprovalGateCheckpoint(coreDb, store, workspaceDb, input);
            }
            return c.json(approval);
          }

          if (workerCheckpoint) {
            if (!policyApproval) {
              throw new TurnStartValidationError(
                'approvals_not_supported',
                'The Approval has no supported durable policy claim.',
                501
              );
            }
            let approval: ReturnType<FsStore['getApproval']>;
            try {
              approval = await runIdempotentCommand({
                store,
                inflightCommands,
                command: 'approval.respond',
                requestId: input.requestId,
                scope: commandScope,
                input,
                responseKind: 'approval',
                execute: () =>
                  closeWorkerApprovalGate(coreDb, store, workspaceDb, policyApproval, input, actor),
                replay: (record) =>
                  ApprovalRequestSchema.parse(store.getApproval(record.response.id)),
                responseId: (result) => result.id,
              });
            } catch (error) {
              if (error instanceof IdempotencyKeyConflictError) {
                throw error;
              }
              const currentCheckpoint = getWorkerCheckpoint(
                workspaceDb,
                input.workspaceId,
                input.threadId,
                input.turnId
              );
              if (!(error instanceof TurnStartValidationError) && currentCheckpoint) {
                throw taskGateRecoveryError('The worker approval receipt was not published.');
              }
              throw error;
            }
            await clearWorkerApprovalGateCheckpoint(coreDb, store, workspaceDb, input);
            return c.json(approval);
          }
          if (workerLeases.length > 0 && !approvalResponseReceipt) {
            throw taskGateRecoveryError(
              'The worker approval Gate has no supported exact checkpoint.'
            );
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return c.json(
        apiErrorPayload({
          code: 'approvals_not_supported',
          message: 'The Approval has no supported durable policy claim.',
        }),
        501
      );
    } catch (error) {
      return asCommandError(error, 'approval_response_failed');
    }
  });
}

/**
 * Claims or reuses the complete terminal PermissionDecision for one policy Approval.
 *
 * @param workspaceDb Workspace database containing the source decision and terminal winner.
 * @param store Product store containing the exact Approval Gate.
 * @param source Sole exact policy decision that opened the Approval.
 * @param input Exact Approval response command.
 * @param actor Authenticated human actor used only when creating the first winner.
 * @returns Complete terminal winner and its linked Audit attribution.
 * @throws A typed conflict, stale, or recovery error when this request is not the winner.
 */
function claimPolicyApprovalOutcome(
  workspaceDb: WorkspaceDb,
  store: FsStore,
  source: PolicyApprovalSourceDecision,
  input: {
    readonly approvalRequestId: string;
    readonly decision: 'granted' | 'denied';
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  },
  actor: { readonly id: string; readonly kind: 'user' }
): PolicyApprovalTerminalWinner {
  let winner: PolicyApprovalTerminalWinner | null;
  try {
    winner = readPolicyApprovalTerminalWinner(
      workspaceDb,
      input.workspaceId,
      input.approvalRequestId,
      input.threadId,
      input.turnId
    );
  } catch {
    throw taskGateRecoveryError(
      'The policy approval source or terminal claim is incomplete or contradictory.'
    );
  }

  const approval = store.getApproval(input.approvalRequestId);
  if (source.action !== 'repo.push' || source.requiredApprovalKind !== approval.kind) {
    throw taskGateRecoveryError('The policy approval source tuple is not exact.');
  }
  const sourceContext = source.contextSummary;
  if (
    !sourceContext ||
    typeof sourceContext !== 'object' ||
    Array.isArray(sourceContext) ||
    !('workspaceId' in sourceContext) ||
    sourceContext.workspaceId !== input.workspaceId ||
    !('threadId' in sourceContext) ||
    sourceContext.threadId !== input.threadId ||
    !('turnId' in sourceContext) ||
    sourceContext.turnId !== input.turnId
  ) {
    throw taskGateRecoveryError('The policy approval source context is not exact.');
  }

  if (!winner) {
    const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
    if (
      approval.status !== 'pending' ||
      approval.resolvedAt !== null ||
      !hasExactActiveHumanGate(store, turn) ||
      turn.humanGate.kind !== 'approval' ||
      turn.humanGate.approvalRequestId !== input.approvalRequestId
    ) {
      throw taskGateRecoveryError('The policy approval Gate is not exact and active.');
    }
    try {
      recordProductPermissionDecision({
        workspaceDb,
        decisionId: `pd_repo_push_${input.decision}_${input.approvalRequestId}`,
        ownerScope: 'workspace',
        workspaceId: input.workspaceId,
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_runtime',
        subjectSummary: source.subjectSummary,
        action: source.action,
        resourceSummary: source.resourceSummary,
        contextSummary: {
          ...sourceContext,
          requestId: input.requestId,
        },
        result: input.decision === 'granted' ? 'allow' : 'deny',
        reasonCode: input.decision === 'granted' ? 'repo_push_approved' : 'repo_push_denied',
        enforcementPoint: 'repo.push.approval_response',
        requiredApprovalKind: source.requiredApprovalKind,
        approvalId: input.approvalRequestId,
        auditActor: actor,
      });
    } catch {
      // The terminal unique index may have selected a concurrent request. Read and classify it.
    }

    try {
      winner = readPolicyApprovalTerminalWinner(
        workspaceDb,
        input.workspaceId,
        input.approvalRequestId,
        input.threadId,
        input.turnId
      );
    } catch {
      throw taskGateRecoveryError('The policy approval terminal claim is incomplete.');
    }
  }

  if (
    !winner ||
    winner.action !== source.action ||
    winner.requiredApprovalKind !== source.requiredApprovalKind ||
    !isDeepStrictEqual(winner.resourceSummary, source.resourceSummary) ||
    !isDeepStrictEqual(winner.subjectSummary, source.subjectSummary)
  ) {
    throw taskGateRecoveryError('The policy approval terminal claim does not match its source.');
  }

  if (winner.requestId !== input.requestId) {
    throw new TurnStartValidationError(
      'stale',
      'Another request already resolved the policy Approval.',
      409
    );
  }
  if ((winner.result === 'allow' ? 'granted' : 'denied') !== input.decision) {
    throw new IdempotencyKeyConflictError();
  }

  return winner;
}

/**
 * Completes only deterministic product projections from a proven policy Approval winner.
 *
 * @param store Product store containing the Approval, Item, Turn, event, and receipt projection.
 * @param winner Complete terminal PermissionDecision and linked AuditEvent.
 * @param input Exact Approval response command.
 * @param decisionItemId Deterministic decision Item identity for this Gate family.
 * @returns Current resolved Approval projection.
 * @throws A recovery error when any existing projection contradicts the winner.
 */
function finishPolicyApprovalProjection(
  store: FsStore,
  winner: PolicyApprovalTerminalWinner,
  input: {
    readonly approvalRequestId: string;
    readonly decision: 'granted' | 'denied';
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  },
  decisionItemId: string
): ReturnType<FsStore['getApproval']> {
  let approval = store.getApproval(input.approvalRequestId);
  if (
    approval.workspaceId !== input.workspaceId ||
    approval.threadId !== input.threadId ||
    approval.turnId !== input.turnId ||
    approval.kind !== winner.requiredApprovalKind
  ) {
    throw taskGateRecoveryError('The policy approval projection has invalid lineage.');
  }

  const decisionItems = store
    .listThreadItems(input.workspaceId, input.threadId)
    .filter((item) => item.type === 'approval-decision')
    .filter((item) => item.approvalRequestId === input.approvalRequestId);
  if (decisionItems.length > 1) {
    throw taskGateRecoveryError('The policy approval has multiple decision Items.');
  }
  const decisionItem = decisionItems[0];
  if (decisionItem) {
    if (
      decisionItem.id !== decisionItemId ||
      decisionItem.workspaceId !== input.workspaceId ||
      decisionItem.threadId !== input.threadId ||
      decisionItem.turnId !== input.turnId ||
      decisionItem.decision !== input.decision ||
      decisionItem.causationId !== winner.requestId ||
      decisionItem.createdAt !== winner.decidedAt ||
      decisionItem.completedAt !== winner.decidedAt ||
      !isDeepStrictEqual(decisionItem.actor, winner.actor)
    ) {
      throw taskGateRecoveryError('The policy approval decision Item contradicts its winner.');
    }
  } else {
    store.createItem({
      id: decisionItemId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      type: 'approval-decision',
      status: 'completed',
      actor: winner.actor,
      causationId: winner.requestId,
      approvalRequestId: input.approvalRequestId,
      decision: input.decision,
      createdAt: winner.decidedAt,
      completedAt: winner.decidedAt,
    });
  }

  if (approval.status === 'pending' && approval.resolvedAt === null) {
    approval = store.updateApproval(input.approvalRequestId, {
      status: input.decision,
      resolvedAt: winner.decidedAt,
    });
  } else if (approval.status !== input.decision || approval.resolvedAt !== winner.decidedAt) {
    throw taskGateRecoveryError('The policy Approval projection contradicts its winner.');
  }

  const stopReason = input.decision === 'denied' ? 'aborted' : 'completed';
  const terminalStatus = input.decision === 'denied' ? 'cancelled' : 'completed';
  let turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const exactActiveGate =
    turn.status === 'awaiting_human' &&
    turn.humanGate.kind === 'approval' &&
    turn.humanGate.approvalRequestId === input.approvalRequestId;
  const exactTerminalTurn =
    turn.status === terminalStatus &&
    turn.humanGate === null &&
    turn.completedAt === winner.decidedAt;
  if (!exactTerminalTurn) {
    if (!exactActiveGate) {
      throw taskGateRecoveryError('The policy Approval Turn contradicts its winner.');
    }
    turn = store.updateTurn(input.turnId, {
      status: terminalStatus,
      humanGate: null,
      completedAt: winner.decidedAt,
    });
  }

  const completedEvents = store
    .getTurnEvents(input.turnId)
    .filter((event) => event.event === 'turn.completed');
  if (completedEvents.length > 1) {
    throw taskGateRecoveryError('The policy Approval Turn has duplicate completion events.');
  }
  if (completedEvents.length === 1) {
    const event = completedEvents[0]!;
    if (
      event.requestId !== winner.requestId ||
      event.data.type !== 'turn-completed' ||
      event.data.stopReason !== stopReason ||
      !isDeepStrictEqual(event.data.turn, turn)
    ) {
      throw taskGateRecoveryError('The policy Approval completion event contradicts its winner.');
    }
  } else {
    store.emitTurnEvent(input.turnId, {
      event: 'turn.completed',
      requestId: winner.requestId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      data: { type: 'turn-completed', stopReason, turn },
    });
  }

  return ApprovalRequestSchema.parse(approval);
}

/**
 * Checks whether one checkpoint belongs to a direct Task worker envelope.
 *
 * @param checkpoint Stored checkpoint, or null.
 * @returns True only for the Task Mode shape with no Goal or Goal Task owner.
 */
function isDirectTaskCheckpoint(
  checkpoint: WorkerCheckpointRecord | null
): checkpoint is WorkerCheckpointRecord {
  return checkpoint !== null && checkpoint.goalId === null && checkpoint.taskId === null;
}

/**
 * Closes one worker approval Gate without resuming its worker executor.
 *
 * @param coreDb Core database containing scheduler and worker lineage.
 * @param store Product store containing the Approval, Turn, Session, Items, and receipts.
 * @param workspaceDb Workspace database containing the worker checkpoint.
 * @param source Sole exact policy decision that opened the Approval.
 * @param input Exact approval command input.
 * @param actor Authenticated human actor used only when creating the first winner.
 * @returns Resolved Approval owner.
 * @throws TurnStartValidationError when the Gate tuple is absent or contradictory.
 */
function closeWorkerApprovalGate(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  source: PolicyApprovalSourceDecision,
  input: {
    readonly approvalRequestId: string;
    readonly decision: 'granted' | 'denied';
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  },
  actor: { readonly id: string; readonly kind: 'user' }
): ReturnType<FsStore['getApproval']> {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  const goalId = checkpoint?.goalId ?? null;
  const taskId = checkpoint?.taskId ?? null;
  const goalTaskCheckpoint = goalId !== null && taskId !== null;
  if (
    !checkpoint?.workerSessionId ||
    (!isDirectTaskCheckpoint(checkpoint) && !goalTaskCheckpoint)
  ) {
    throw taskGateRecoveryError('The worker approval has no exact checkpoint.');
  }
  if (checkpoint.stage !== 'waiting_for_user' || checkpoint.stopReason !== 'ask_user') {
    throw taskGateRecoveryError('The worker approval checkpoint is not waiting.');
  }

  try {
    if (recoverWorkerCheckpointStopReason(coreDb, store, workspaceDb, checkpoint) !== 'ask_user') {
      throw new Error('Unexpected worker Gate outcome.');
    }
  } catch {
    throw taskGateRecoveryError('The worker approval has no exact active Gate.');
  }
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const gate = turn.humanGate;
  if (
    turn.status !== 'awaiting_human' ||
    gate?.kind !== 'approval' ||
    gate.approvalRequestId !== input.approvalRequestId
  ) {
    throw taskGateRecoveryError('The worker approval does not own the active Gate.');
  }
  const initiatingItem = turn.items.find((item) => item.id === `it_user_${turn.id}`);
  const contextAssembly = parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary);
  try {
    if (
      initiatingItem?.type !== 'user-message' ||
      initiatingItem.status !== 'completed' ||
      initiatingItem.workspaceId !== input.workspaceId ||
      initiatingItem.threadId !== input.threadId ||
      initiatingItem.turnId !== input.turnId ||
      !checkpoint.contextDigest
    ) {
      throw new Error('Worker input mismatch.');
    }
    const workerRequest = StructuredWorkerDelegationRequestSchema.parse(
      JSON.parse(initiatingItem.text)
    );
    if (
      isDirectTaskCheckpoint(checkpoint) &&
      commandInputHash(workerRequest) !== checkpoint.contextDigest
    ) {
      throw new Error('Worker input mismatch.');
    }
    if (
      goalTaskCheckpoint &&
      (!contextAssembly ||
        contextAssembly.contextDigest !== checkpoint.contextDigest ||
        JSON.stringify(contextAssembly.contextRefs) !== JSON.stringify(workerRequest.contextRefs))
    ) {
      throw new Error('Worker context mismatch.');
    }
  } catch {
    throw taskGateRecoveryError('The worker approval has no authoritative worker input.');
  }
  const evidence = parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary);
  let ownerScope: ReturnType<typeof requireWorkerCheckpointHumanCommandScope>;
  try {
    ownerScope = requireWorkerCheckpointHumanCommandScope(coreDb, checkpoint);
  } catch {
    throw taskGateRecoveryError('The worker approval has no exact human command identity.');
  }
  const ownerReceipt = store.getCommandRequest(
    goalTaskCheckpoint ? 'goal.step' : 'task.start',
    checkpoint.requestId,
    ownerScope,
    goalTaskCheckpoint ? workspaceDb : undefined
  );
  if (
    !evidence ||
    !ownerReceipt ||
    ownerReceipt.inputHash !== checkpoint.requestInputHash ||
    (goalTaskCheckpoint
      ? ownerReceipt.response.kind !== 'goal' || ownerReceipt.response.id !== checkpoint.goalId
      : ownerReceipt.response.kind !== 'turn' || ownerReceipt.response.id !== input.turnId)
  ) {
    throw taskGateRecoveryError('The worker approval has no exact mode-command receipt.');
  }
  if (goalTaskCheckpoint) {
    const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, goalId);
    const task = listGoalTasks(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId,
    }).find((candidate) => candidate.taskId === taskId);
    if (
      goal?.status !== 'awaiting_user' ||
      goal.currentTaskId !== taskId ||
      goal.terminalStopReason !== null ||
      task?.status !== 'running'
    ) {
      throw taskGateRecoveryError('The worker approval contradicts its Goal Task owner.');
    }
  }

  const currentApproval = store.getApproval(input.approvalRequestId);
  if (currentApproval.status !== 'pending') {
    throw taskGateRecoveryError('The worker approval is no longer pending.');
  }
  const winner = claimPolicyApprovalOutcome(workspaceDb, store, source, input, actor);
  const timestamp = winner.decidedAt;
  const decisionItemId = `it_approval_decision_${input.turnId}`;
  store.createItem({
    id: decisionItemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    type: 'approval-decision',
    status: 'completed',
    actor: winner.actor,
    causationId: winner.requestId,
    approvalRequestId: input.approvalRequestId,
    decision: input.decision,
    createdAt: timestamp,
    completedAt: timestamp,
  });
  store.updateAgentSession(checkpoint.workerSessionId, {
    status: input.decision === 'denied' ? 'interrupted' : 'idle',
    updatedAt: timestamp,
  });
  const expectedStopReason = input.decision === 'denied' ? 'aborted' : 'completed';
  const closedTurn = store.updateTurn(input.turnId, {
    status: input.decision === 'denied' ? 'cancelled' : 'completed',
    humanGate: null,
    completedAt: timestamp,
  });
  store.emitTurnEvent(input.turnId, {
    event: 'turn.completed',
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    data: { type: 'turn-completed', stopReason: expectedStopReason, turn: closedTurn },
  });
  const terminalCheckpoint = updateWorkerCheckpoint(workspaceDb, {
    authorityActor: turn.triggerActor,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    stage: expectedStopReason === 'aborted' ? 'aborted' : 'completed',
    stopReason: expectedStopReason,
    diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(
      {
        itemIds: [...new Set([...evidence.itemIds, decisionItemId])],
        artifactIds: evidence.artifactIds,
      },
      contextAssembly
    ),
  });
  const approval = ApprovalRequestSchema.parse(
    store.updateApproval(input.approvalRequestId, {
      status: input.decision,
      resolvedAt: timestamp,
    })
  );
  if (goalTaskCheckpoint) {
    workspaceDb.sqlite.transaction(() => {
      updateGoalTask(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId,
        taskId,
        status: 'ready',
        latestGateContextItemId: decisionItemId,
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId,
        status: 'running',
        currentTaskId: null,
        terminalStopReason: null,
      });
    })();
  }
  completeSchedulerLeaseForTerminalTurn(coreDb, TurnSchema.parse(closedTurn));
  try {
    if (
      recoverWorkerCheckpointStopReason(coreDb, store, workspaceDb, terminalCheckpoint) !==
      expectedStopReason
    ) {
      throw new Error('Unexpected terminal outcome.');
    }
  } catch {
    throw taskGateRecoveryError('The worker approval did not release scheduler ownership.');
  }
  return approval;
}

/**
 * Validates both Gate receipts and removes the completed worker checkpoint.
 *
 * @param coreDb Core database containing the released scheduler lease.
 * @param store Product store containing Gate and Task owners.
 * @param workspaceDb Workspace database containing the terminal checkpoint.
 * @param input Exact approval command input.
 * @throws TurnStartValidationError when any closeout owner is absent or contradictory.
 */
async function clearWorkerApprovalGateCheckpoint(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: {
    readonly approvalRequestId: string;
    readonly decision: 'granted' | 'denied';
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
): Promise<void> {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  const expectedStopReason = input.decision === 'denied' ? 'aborted' : 'completed';
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const closure = classifyClosedWorkerApprovalGate(store, turn);
  const evidence = checkpoint ? parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary) : null;
  const ownerReceipt = checkpoint
    ? store.getCommandRequest(
        checkpoint.goalId && checkpoint.taskId ? 'goal.step' : 'task.start',
        checkpoint.requestId,
        requireWorkerCheckpointHumanCommandScope(coreDb, checkpoint),
        checkpoint.goalId && checkpoint.taskId ? workspaceDb : undefined
      )
    : null;
  const gateReceipt = store.getCommandRequest('approval.respond', input.requestId, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    approvalRequestId: input.approvalRequestId,
  });
  let goalOwnerComplete = true;
  try {
    if (checkpoint?.goalId && checkpoint.taskId && closure) {
      const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, checkpoint.goalId);
      const task = listGoalTasks(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: checkpoint.goalId,
      }).find((candidate) => candidate.taskId === checkpoint.taskId);
      goalOwnerComplete =
        goal?.status === 'running' &&
        goal.currentTaskId === null &&
        goal.terminalStopReason === null &&
        task?.status === 'ready' &&
        task.latestGateContextItemId === closure.responseItemId;
    }
  } catch {
    goalOwnerComplete = false;
  }
  try {
    if (
      !checkpoint ||
      recoverWorkerCheckpointStopReason(coreDb, store, workspaceDb, checkpoint) !==
        expectedStopReason ||
      closure?.stopReason !== expectedStopReason ||
      !evidence?.itemIds.includes(closure.requestItemId) ||
      !evidence.itemIds.includes(closure.responseItemId) ||
      !ownerReceipt ||
      ownerReceipt.inputHash !== checkpoint.requestInputHash ||
      (checkpoint.goalId && checkpoint.taskId
        ? ownerReceipt.response.kind !== 'goal' || ownerReceipt.response.id !== checkpoint.goalId
        : ownerReceipt.response.kind !== 'turn' || ownerReceipt.response.id !== input.turnId) ||
      gateReceipt?.response.kind !== 'approval' ||
      gateReceipt.response.id !== input.approvalRequestId ||
      !goalOwnerComplete
    ) {
      throw new Error('Incomplete Gate closeout.');
    }
  } catch {
    throw taskGateRecoveryError('The worker approval closeout is incomplete.');
  }
  if (
    !(await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
    }))
  ) {
    throw taskGateRecoveryError('The worker approval checkpoint could not be cleared.');
  }
}

/**
 * Creates the typed fail-closed error for worker Gate contradictions.
 *
 * @param message Product-safe contradiction summary.
 * @returns Recovery-required route error.
 */
function taskGateRecoveryError(message: string): TurnStartValidationError {
  return new TurnStartValidationError('recovery_required', message, 409);
}
