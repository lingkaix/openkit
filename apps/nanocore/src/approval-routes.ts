import {
  AnswerUserInputRequestSchema,
  ApprovalRequestSchema,
  PendingRequestOutcomeSchema,
  RespondToApprovalRequestSchema,
  WithdrawPendingRequestSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asCommandError, asInvalidRequestError } from './api-errors.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import type { StartedCapabilityCall } from './capability/usage-ledger.js';
import type { FsStore } from './lib/store.js';
import type { PreparedCapturedPendingCall } from './runtime/captured-pending-call.js';
import { admitCapturedPendingCall } from './runtime/captured-pending-call.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
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
  projectApprovalRequest,
  readPendingRequest,
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

/** Re-evaluates one captured call at grant time. Absent fields keep the route default. */
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
 * Registers approval response, user-input answer, and pending-request withdrawal.
 *
 * @param dependencies Hono app and the workspace database that owns pending requests.
 */
export function registerApprovalRoutes({
  app,
  coreDb,
  evaluateCapturedCall,
  executeCapturedCall,
  prepareCapturedCall,
  agentAuthority,
  inflightCommands,
  repositoryWorkspaceDb,
  requestStore,
  workerDelivery,
  assistantDelivery,
  coordinatorDelivery,
  goalTerminal,
  requestCommitted,
  requesterAuthority,
  checkCommandIntent,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
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
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly workerDelivery?: PendingWorkerDelivery;
  readonly assistantDelivery?: PendingWorkerDelivery;
  readonly coordinatorDelivery?: PendingWorkerDelivery;
  readonly goalTerminal?: PendingAdmissionDependencies['goalTerminal'];
  readonly requestCommitted?: PendingAdmissionDependencies['requestCommitted'];
  readonly requesterAuthority?: PendingAdmissionDependencies['requesterAuthority'];
  readonly checkCommandIntent?: PendingAdmissionDependencies['checkCommandIntent'];
}): void {
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

  app.post('/api/approvals/:approvalRequestId/respond', async (c) => {
    const parsed = RespondToApprovalRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      approvalRequestId: c.req.param('approvalRequestId'),
    });
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    const input = parsed.data;
    const store = requestStore(c);
    const actor = c.get('actor');
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
      return c.json(approval);
    } catch (error) {
      return asCommandError(error, 'approval_respond_failed');
    }
  });

  app.post('/api/user-input-requests/:userInputRequestId/answer', async (c) => {
    const parsed = AnswerUserInputRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      userInputRequestId: c.req.param('userInputRequestId'),
    });
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    const input = parsed.data;
    const store = requestStore(c);
    const actor = c.get('actor');
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
              actor as Actor,
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
      return c.json(outcome);
    } catch (error) {
      return asCommandError(error, 'user_input_answer_failed');
    }
  });

  app.post('/api/pending-requests/:pendingRequestId/withdraw', async (c) => {
    const parsed = WithdrawPendingRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      pendingRequestId: c.req.param('pendingRequestId'),
    });
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    const input = parsed.data;
    const store = requestStore(c);
    const actor = c.get('actor');
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
      return c.json(outcome);
    } catch (error) {
      return asCommandError(error, 'pending_request_withdraw_failed');
    }
  });
}

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
