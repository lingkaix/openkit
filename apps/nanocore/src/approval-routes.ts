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
  readPolicyApprovalDecision,
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
import type { TurnExecutor } from './runtime/types.js';
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
  turnExecutor,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly turnExecutor: TurnExecutor;
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
        const workspaceDb = repositoryWorkspaceDb(store, input.workspaceId);
        try {
          const workerCheckpoint = getWorkerCheckpoint(
            workspaceDb,
            input.workspaceId,
            input.threadId,
            input.turnId
          );
          const policyApproval = readPolicyApprovalDecision(
            workspaceDb,
            input.workspaceId,
            input.approvalRequestId
          );
          if (policyApproval && policyApproval.action !== 'repo.push') {
            throw taskGateRecoveryError('The policy approval action is not supported.');
          }
          if (policyApproval && !workerCheckpoint && workerLeases.length === 0) {
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
                  if (hasPolicyApprovalResponseEffect(store, workspaceDb, input)) {
                    throw taskGateRecoveryError(
                      'The policy approval response exists without its command receipt.'
                    );
                  }
                  const currentApproval = store.getApproval(input.approvalRequestId);
                  const currentTurn = store.getTurn(
                    input.workspaceId,
                    input.threadId,
                    input.turnId
                  );

                  if (
                    currentApproval.status !== 'pending' ||
                    !hasExactActiveHumanGate(store, currentTurn) ||
                    currentTurn.humanGate.kind !== 'approval' ||
                    currentTurn.humanGate.approvalRequestId !== input.approvalRequestId
                  ) {
                    throw taskGateRecoveryError(
                      'The policy approval Gate is not exact and active.'
                    );
                  }

                  recordPolicyApprovalOutcome(workspaceDb, policyApproval, input);

                  const timestamp = new Date().toISOString();
                  const updatedApproval = store.updateApproval(input.approvalRequestId, {
                    status: input.decision,
                    resolvedAt: timestamp,
                  });
                  store.createItem({
                    id: `it_approval_decision_${input.approvalRequestId}`,
                    workspaceId: input.workspaceId,
                    threadId: input.threadId,
                    turnId: input.turnId,
                    type: 'approval-decision',
                    status: 'completed',
                    approvalRequestId: input.approvalRequestId,
                    decision: input.decision,
                    createdAt: timestamp,
                    completedAt: timestamp,
                  });
                  const stopReason = input.decision === 'denied' ? 'aborted' : 'completed';
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
                    data: { type: 'turn-completed', stopReason, turn: closedTurn },
                  });

                  return ApprovalRequestSchema.parse(updatedApproval);
                },
                replay: (record) =>
                  ApprovalRequestSchema.parse(store.getApproval(record.response.id)),
                responseId: (result) => result.id,
              });
            } catch (error) {
              const receipt = store.getCommandRequest(
                'approval.respond',
                input.requestId,
                commandScope
              );
              if (!receipt && hasPolicyApprovalResponseEffect(store, workspaceDb, input)) {
                throw taskGateRecoveryError(
                  'The policy approval response exists without its command receipt.'
                );
              }
              throw error;
            }

            return c.json(approval);
          }

          if (workerCheckpoint) {
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
                  closeWorkerApprovalGate(coreDb, store, workspaceDb, input, policyApproval),
                replay: (record) =>
                  ApprovalRequestSchema.parse(store.getApproval(record.response.id)),
                responseId: (result) => result.id,
              });
            } catch (error) {
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

      if (storedApproval.status === 'pending' && !turnExecutor.capabilities.approvals) {
        return c.json(
          apiErrorPayload({
            code: 'approvals_not_supported',
            message: 'The active agent runtime does not support approvals.',
          }),
          501
        );
      }

      const approval = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'approval.respond',
        requestId: input.requestId,
        scope: commandScope,
        input,
        responseKind: 'approval',
        execute: async () => {
          const currentApproval = store.getApproval(input.approvalRequestId);

          if (currentApproval.status !== 'pending') {
            if (currentApproval.status !== input.decision) {
              throw new IdempotencyKeyConflictError();
            }

            return ApprovalRequestSchema.parse(currentApproval);
          }

          const updatedApproval = await turnExecutor.respondApproval?.(
            store,
            input.approvalRequestId,
            input.decision,
            { requestId: input.requestId }
          );

          if (!updatedApproval) {
            throw new Error('The active agent runtime cannot respond to approvals.');
          }

          return ApprovalRequestSchema.parse(updatedApproval);
        },
        replay: (record) => ApprovalRequestSchema.parse(store.getApproval(record.response.id)),
        responseId: (result) => result.id,
      });

      completeSchedulerLeaseForTerminalTurn(
        coreDb,
        TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, input.turnId))
      );

      return c.json(approval);
    } catch (error) {
      return asCommandError(error, 'approval_response_failed');
    }
  });
}

/**
 * Records the exact policy result owned by one Approval response.
 *
 * @param workspaceDb Workspace database containing policy decisions.
 * @param policyApproval Existing require-approval decision that owns the Gate.
 * @param input Exact Approval response command.
 * @throws TurnStartValidationError when any policy outcome already exists.
 */
function recordPolicyApprovalOutcome(
  workspaceDb: WorkspaceDb,
  policyApproval: NonNullable<ReturnType<typeof readPolicyApprovalDecision>>,
  input: {
    readonly approvalRequestId: string;
    readonly decision: 'granted' | 'denied';
    readonly requestId: string;
    readonly workspaceId: string;
  }
): void {
  const result = input.decision === 'granted' ? 'allow' : 'deny';
  if (
    readPolicyApprovalDecision(
      workspaceDb,
      input.workspaceId,
      input.approvalRequestId,
      'repo.push',
      'allow'
    ) ||
    readPolicyApprovalDecision(
      workspaceDb,
      input.workspaceId,
      input.approvalRequestId,
      'repo.push',
      'deny'
    )
  ) {
    throw taskGateRecoveryError('The policy approval already has a durable outcome.');
  }
  recordProductPermissionDecision({
    workspaceDb,
    decisionId: `pd_repo_push_${input.decision}_${input.approvalRequestId}`,
    ownerScope: 'workspace',
    workspaceId: input.workspaceId,
    policyEngineVersion: 'nanocore-approval-policy:v1',
    policySnapshotId: 'policy_snapshot_runtime',
    subjectSummary: policyApproval.subjectSummary,
    action: 'repo.push',
    resourceSummary: policyApproval.resourceSummary,
    contextSummary: {
      ...((policyApproval.contextSummary ?? {}) as Record<string, unknown>),
      requestId: input.requestId,
    },
    result,
    reasonCode: input.decision === 'granted' ? 'repo_push_approved' : 'repo_push_denied',
    enforcementPoint: 'repo.push.approval_response',
    approvalId: input.approvalRequestId,
  });
}

/**
 * Detects whether a policy approval response has any durable effect without a receipt.
 *
 * @param store Product store containing the Approval, Turn, Items, and command ledger.
 * @param workspaceDb Workspace database containing policy outcomes.
 * @param input Exact policy approval response command.
 * @returns True when retry must fail closed instead of repairing or replaying.
 */
function hasPolicyApprovalResponseEffect(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: {
    readonly approvalRequestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
): boolean {
  const approval = store.getApproval(input.approvalRequestId);
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const decisionItem = store
    .listThreadItems(input.workspaceId, input.threadId)
    .find(
      (item) =>
        item.type === 'approval-decision' && item.approvalRequestId === input.approvalRequestId
    );

  return (
    approval.status !== 'pending' ||
    approval.resolvedAt !== null ||
    decisionItem !== undefined ||
    readPolicyApprovalDecision(
      workspaceDb,
      input.workspaceId,
      input.approvalRequestId,
      'repo.push',
      'allow'
    ) !== null ||
    readPolicyApprovalDecision(
      workspaceDb,
      input.workspaceId,
      input.approvalRequestId,
      'repo.push',
      'deny'
    ) !== null ||
    !hasExactActiveHumanGate(store, turn) ||
    turn.humanGate.kind !== 'approval' ||
    turn.humanGate.approvalRequestId !== input.approvalRequestId
  );
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
 * @param input Exact approval command input.
 * @param policyApproval Optional policy owner for a policy-backed Gate.
 * @returns Resolved Approval owner.
 * @throws TurnStartValidationError when the Gate tuple is absent or contradictory.
 */
function closeWorkerApprovalGate(
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
  },
  policyApproval: NonNullable<ReturnType<typeof readPolicyApprovalDecision>> | null
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
  const ownerReceipt = store.getCommandRequest(
    goalTaskCheckpoint ? 'goal.step' : 'task.start',
    checkpoint.requestId,
    {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    },
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
  if (policyApproval) {
    recordPolicyApprovalOutcome(workspaceDb, policyApproval, input);
  }
  const timestamp = new Date().toISOString();
  const decisionItemId = `it_approval_decision_${input.turnId}`;
  store.createItem({
    id: decisionItemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    type: 'approval-decision',
    status: 'completed',
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
        {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
        },
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
