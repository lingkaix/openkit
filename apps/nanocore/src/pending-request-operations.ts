import type { PENDING_REQUEST_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { ApprovalRequestSchema, PendingRequestOutcomeSchema } from '@openkit/protocol';
import { z } from 'zod';
import { publishedErrorMessage } from './api-errors.js';
import type { Actor } from './auth/identity.js';
import type { StartedCapabilityCall } from './capability/usage-ledger.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import type { FsStore } from './lib/store.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import type { PreparedCapturedPendingCall } from './runtime/captured-pending-call.js';
import { admitCapturedPendingCall } from './runtime/captured-pending-call.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import {
  answerRecordedUserInput,
  type PendingAdmissionDependencies,
  type PendingWorkerDelivery,
  requireUsableRecord,
  respondRecordedApproval,
  withdrawRecordedPendingRequest,
} from './runtime/pending-request-flow.js';
import {
  PendingRequestCommandError,
  type PendingRequestRecord,
  preflightPendingRequest,
  projectApprovalRequest,
  readPendingRequest,
  readPendingRequestLineage,
} from './runtime/pending-requests.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/** Executes one captured approval call inside the approval response. */
export type CapturedPendingCallExecutor = (
  record: PendingRequestRecord,
  actor: Actor,
  workspaceDb: WorkspaceDb,
  prepared?: PreparedCapturedPendingCall,
  executionCall?: StartedCapabilityCall
) => Promise<{
  readonly disposition: 'approved-executed' | 'execution-error' | 'outcome-unknown';
  readonly reason: string | null;
  readonly result: unknown;
}>;

/** Re-evaluates one captured call at grant time. Absent fields keep the existing owner default. */
export type CapturedPendingCallEvaluator = (
  record: PendingRequestRecord,
  sqlite: import('better-sqlite3').Database,
  prepared?: PreparedCapturedPendingCall
) => {
  readonly membership?: boolean;
  readonly agentAuthority?: boolean;
  readonly toolInSupply: boolean;
  readonly schemaCurrent: boolean;
  readonly policyAllows: boolean;
  readonly credentialsValid: boolean;
};

/**
 * Joins approval response, user-input answer, and withdrawal to their existing command owners.
 *
 * @param dependencies Authenticated store, captured-call and delivery owners, and the Workspace database.
 */
export function createPendingRequestOperationImplementations({
  coreDb,
  evaluateCapturedCall,
  executeCapturedCall,
  prepareCapturedCall,
  agentAuthority,
  inflightCommands,
  repositoryWorkspaceDb,
  store,
  workerDelivery,
  assistantDelivery,
  coordinatorDelivery,
  goalTerminal,
  requestCommitted,
  requesterAuthority,
  checkCommandIntent,
}: {
  readonly coreDb: CoreDb | undefined;
  readonly evaluateCapturedCall?: CapturedPendingCallEvaluator;
  readonly executeCapturedCall?: CapturedPendingCallExecutor;
  readonly agentAuthority?: (record: PendingRequestRecord) => boolean;
  readonly prepareCapturedCall?: (
    record: PendingRequestRecord,
    workspaceDb: WorkspaceDb,
    actor: Actor
  ) => Promise<PreparedCapturedPendingCall>;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly store: FsStore;
  readonly workerDelivery?: PendingWorkerDelivery;
  readonly assistantDelivery?: PendingWorkerDelivery;
  readonly coordinatorDelivery?: PendingWorkerDelivery;
  readonly goalTerminal?: PendingAdmissionDependencies['goalTerminal'];
  readonly requestCommitted?: PendingAdmissionDependencies['requestCommitted'];
  readonly requesterAuthority?: PendingAdmissionDependencies['requesterAuthority'];
  readonly checkCommandIntent?: PendingAdmissionDependencies['checkCommandIntent'];
}) {
  const admission = (): PendingAdmissionDependencies => ({
    ...(coreDb ? { coreDb } : {}),
    ...(agentAuthority ? { agentAuthority } : {}),
    openWorkspace: repositoryWorkspaceDb,
    ...(workerDelivery ? { workerDelivery } : {}),
    ...(assistantDelivery ? { assistantDelivery } : {}),
    ...(coordinatorDelivery ? { coordinatorDelivery } : {}),
    ...(goalTerminal ? { goalTerminal } : {}),
    ...(requestCommitted ? { requestCommitted } : {}),
    ...(requesterAuthority ? { requesterAuthority } : {}),
    ...(checkCommandIntent ? { checkCommandIntent } : {}),
  });

  // Native credential admission excludes Worker contexts before these public-only joins.
  return {
    'approval.respond': async (input, context) => {
      const actor = context.actor as Actor;
      try {
        const approval = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'approval.respond',
          requestId: input.requestId,
          scope: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId: input.turnId,
            approvalRequestId: input.approvalRequestId,
          },
          input,
          responseKind: 'approval',
          execute: async () => {
            const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
            try {
              const current = readPendingRequest(workspaceDb.sqlite, input.approvalRequestId);
              if (!current) {
                throw new PendingRequestCommandError(
                  'recovery_required',
                  'The pending request is missing.',
                  409
                );
              }
              if (
                current.workspaceId !== input.workspaceId ||
                current.threadId !== input.threadId ||
                current.raisingTurnId !== input.turnId
              ) {
                throw new PendingRequestCommandError(
                  'invalid_request',
                  'Approval request scope mismatch.',
                  400
                );
              }
              let prepared: PreparedCapturedPendingCall | undefined;
              let executionCall: StartedCapabilityCall | undefined;
              const record = await respondRecordedApproval({
                store,
                sqlite: workspaceDb.sqlite,
                workspaceId: input.workspaceId,
                threadId: input.threadId,
                approvalRequestId: input.approvalRequestId,
                decision: input.decision,
                actorId: actor.userId,
                coreDb,
                requestActor: actor,
                dependencies: admission(),
                admitExecution: () => {
                  executionCall = admitCapturedPendingCall(current, workspaceDb, input.requestId);
                },
                ...(prepareCapturedCall
                  ? {
                      prepare: async () => {
                        prepared = await prepareCapturedCall(current, workspaceDb, actor);
                      },
                    }
                  : {}),
                ...(executeCapturedCall
                  ? {
                      execute: (record: PendingRequestRecord) =>
                        executeCapturedCall(record, actor, workspaceDb, prepared, executionCall),
                    }
                  : {}),
                ...(evaluateCapturedCall
                  ? { evaluate: () => evaluateCapturedCall(current, workspaceDb.sqlite, prepared) }
                  : {}),
              });
              const projected = projectApprovalRequest(record);
              if (!projected) {
                throw new PendingRequestCommandError(
                  'recovery_required',
                  'The approval projection is missing.',
                  409
                );
              }
              return ApprovalRequestSchema.parse(projected);
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          replay: () => {
            const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
            try {
              const record = requireUsableRecord(
                store,
                workspaceDb.sqlite,
                input.approvalRequestId,
                input.workspaceId,
                input.threadId
              );
              const projected = record ? projectApprovalRequest(record) : null;
              if (!projected) {
                throw new PendingRequestCommandError(
                  'recovery_required',
                  'The approval projection is missing.',
                  409
                );
              }
              return ApprovalRequestSchema.parse(projected);
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          responseId: (result) => result.id,
        });
        return approval;
      } catch (error) {
        throw pendingCommandFailure(error, 'approval_respond_failed');
      }
    },

    'question.answer': async (input, context) => {
      const actor = context.actor as Actor;
      try {
        const outcome = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'user_input.answer',
          requestId: input.requestId,
          scope: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            userInputRequestId: input.userInputRequestId,
          },
          input,
          responseKind: 'pending_request',
          execute: () => {
            const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
            try {
              const record = answerRecordedUserInput(
                store,
                workspaceDb.sqlite,
                {
                  requestId: input.userInputRequestId,
                  workspaceId: input.workspaceId,
                  threadId: input.threadId,
                  answers: input.answers,
                },
                actor.userId,
                coreDb,
                actor,
                admission()
              );
              return PendingRequestOutcomeSchema.parse(outcomeOf(record));
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          replay: () => {
            const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
            try {
              const record = requireUsableRecord(
                store,
                workspaceDb.sqlite,
                input.userInputRequestId,
                input.workspaceId,
                input.threadId
              );
              if (!record) {
                throw new PendingRequestCommandError(
                  'recovery_required',
                  'The pending request is missing.',
                  409
                );
              }
              return PendingRequestOutcomeSchema.parse(outcomeOf(record));
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          responseId: (result) => result.requestId,
        });
        return outcome;
      } catch (error) {
        throw pendingCommandFailure(error, 'user_input_answer_failed');
      }
    },

    'pending-request.withdraw': async (input, context) => {
      const actor = context.actor as Actor;
      try {
        const outcome = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'pending_request.withdraw',
          requestId: input.requestId,
          scope: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            pendingRequestId: input.pendingRequestId,
          },
          input,
          responseKind: 'pending_request',
          execute: () => {
            const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
            try {
              const record = withdrawRecordedPendingRequest(
                store,
                workspaceDb.sqlite,
                input.pendingRequestId,
                input.workspaceId,
                input.threadId,
                actor.userId,
                admission(),
                actor
              );
              return PendingRequestOutcomeSchema.parse(outcomeOf(record));
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          replay: () => {
            const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
            try {
              const record = requireUsableRecord(
                store,
                workspaceDb.sqlite,
                input.pendingRequestId,
                input.workspaceId,
                input.threadId
              );
              if (!record) {
                throw new PendingRequestCommandError(
                  'recovery_required',
                  'The pending request is missing.',
                  409
                );
              }
              return PendingRequestOutcomeSchema.parse(outcomeOf(record));
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          responseId: (result) => result.requestId,
        });
        return outcome;
      } catch (error) {
        throw pendingCommandFailure(error, 'pending_request_withdraw_failed');
      }
    },
  } satisfies Pick<OperationImplementations, keyof typeof PENDING_REQUEST_OPERATION_DEFINITIONS>;
}

/** Projects only the shared record’s public decision outcome. */
function outcomeOf(record: PendingRequestRecord) {
  return {
    requestId: record.requestId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    state: record.state,
    resolution: record.resolution,
    ending: record.ending,
  };
}

/** Preserves the command owner's typed refusal and its previous fallback code and status. */
function pendingCommandFailure(error: unknown, code: string): OperationError {
  if (
    error instanceof PendingRequestCommandError ||
    error instanceof IdempotencyKeyConflictError ||
    error instanceof KernelCommandError ||
    error instanceof TurnStartValidationError ||
    error instanceof KnowledgePageValidationError
  )
    return new OperationError(error.code, error.message, error.status, { cause: error });
  if (error instanceof OperationError) return error;
  if (
    error instanceof StoreRecordNotFoundError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError
  )
    return new OperationError(code, publishedErrorMessage(error), 404, { cause: error });
  throw error;
}

/** Selected-Workspace minimal Pending lineage; DB lifetime ends before the admission result escapes. */
export function readPendingOperationLineage(
  repositoryWorkspaceDb: (workspaceId: string) => import('./storage/db.js').WorkspaceDb,
  store: FsStore,
  workspaceId: string,
  childId: string
) {
  const db = repositoryWorkspaceDb(workspaceId);
  try {
    return (
      readPendingRequestLineage(db.sqlite, childId) ??
      store.getApprovalProjectionLineage(workspaceId, childId)
    );
  } finally {
    db.sqlite.close();
  }
}

/** Pending-owned Tool preflight translates only its known command refusal; capability framing remains with the Worker entry. */
export function preflightPendingToolRequest(
  ...args: Parameters<typeof preflightPendingRequest>
): ReturnType<typeof preflightPendingRequest> {
  try {
    return preflightPendingRequest(...args);
  } catch (error) {
    if (error instanceof PendingRequestCommandError)
      throw new OperationError(error.code, error.message, error.status, { cause: error });
    throw error;
  }
}
