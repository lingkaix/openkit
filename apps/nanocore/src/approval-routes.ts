import {
  ApprovalRequestSchema,
  RespondToApprovalRequestSchema,
  TurnSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { apiErrorPayload, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import {
  readPolicyApprovalDecision,
  recordProductPermissionDecision,
} from './policy/permission-decisions.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { TurnExecutor } from './runtime/types.js';
import { completeSchedulerLeaseForTerminalTurn } from './scheduler-records.js';
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

      if (coreDb) {
        const workspaceDb = repositoryWorkspaceDb(store, input.workspaceId);
        try {
          const policyApproval =
            readPolicyApprovalDecision(
              workspaceDb,
              input.workspaceId,
              input.approvalRequestId,
              'repo.push'
            ) ??
            readPolicyApprovalDecision(
              workspaceDb,
              input.workspaceId,
              input.approvalRequestId,
              'mcp.call'
            );

          if (policyApproval) {
            const policyResult = input.decision === 'granted' ? 'allow' : 'deny';
            const oppositePolicyResult = policyResult === 'allow' ? 'deny' : 'allow';
            const approval = await runIdempotentCommand({
              store,
              inflightCommands,
              command: 'approval.respond',
              requestId: input.requestId,
              scope: commandScope,
              input,
              responseKind: 'approval',
              execute: () => {
                const currentApproval = store.getApproval(input.approvalRequestId);

                if (
                  currentApproval.status !== 'pending' &&
                  currentApproval.status !== input.decision
                ) {
                  throw new IdempotencyKeyConflictError();
                }

                const oppositeDecision = readPolicyApprovalDecision(
                  workspaceDb,
                  input.workspaceId,
                  input.approvalRequestId,
                  policyApproval.action,
                  oppositePolicyResult
                );

                if (oppositeDecision) {
                  throw new IdempotencyKeyConflictError();
                }

                const existingDecision = readPolicyApprovalDecision(
                  workspaceDb,
                  input.workspaceId,
                  input.approvalRequestId,
                  policyApproval.action,
                  policyResult
                );

                if (!existingDecision) {
                  recordProductPermissionDecision({
                    workspaceDb,
                    decisionId: `pd_${
                      policyApproval.action === 'mcp.call' ? 'mcp_call' : 'repo_push'
                    }_${input.decision}_${input.approvalRequestId}`,
                    ownerScope: 'workspace',
                    workspaceId: input.workspaceId,
                    policyEngineVersion: 'nanocore-approval-policy:v1',
                    policySnapshotId: 'policy_snapshot_runtime',
                    subjectSummary: policyApproval.subjectSummary,
                    action: policyApproval.action,
                    resourceSummary: policyApproval.resourceSummary,
                    contextSummary: {
                      ...((policyApproval.contextSummary ?? {}) as Record<string, unknown>),
                      requestId: input.requestId,
                    },
                    result: policyResult,
                    reasonCode:
                      policyApproval.action === 'mcp.call'
                        ? input.decision === 'granted'
                          ? 'mcp_call_approved'
                          : 'mcp_call_denied'
                        : input.decision === 'granted'
                          ? 'repo_push_approved'
                          : 'repo_push_denied',
                    enforcementPoint:
                      policyApproval.action === 'mcp.call'
                        ? 'mcp.call.approval_response'
                        : 'repo.push.approval_response',
                    approvalId: input.approvalRequestId,
                  });
                }

                const timestamp = currentApproval.resolvedAt ?? new Date().toISOString();
                const updatedApproval =
                  currentApproval.status === input.decision && currentApproval.resolvedAt
                    ? currentApproval
                    : store.updateApproval(input.approvalRequestId, {
                        status: input.decision,
                        resolvedAt: timestamp,
                      });
                const decisionItemId = `it_approval_decision_${input.approvalRequestId}`;
                const existingItem = store
                  .listThreadItems(input.workspaceId, input.threadId)
                  .find((item) => item.id === decisionItemId);

                if (existingItem) {
                  if (
                    existingItem.type !== 'approval-decision' ||
                    existingItem.workspaceId !== input.workspaceId ||
                    existingItem.threadId !== input.threadId ||
                    existingItem.turnId !== input.turnId ||
                    existingItem.approvalRequestId !== input.approvalRequestId ||
                    existingItem.decision !== input.decision
                  ) {
                    throw new IdempotencyKeyConflictError();
                  }
                } else {
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
                }

                const currentTurn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
                if (
                  currentTurn.status === 'awaiting_human' &&
                  currentTurn.humanGate.kind === 'approval' &&
                  currentTurn.humanGate.approvalRequestId === input.approvalRequestId
                ) {
                  store.updateTurn(input.turnId, { status: 'running', humanGate: null });
                }

                return ApprovalRequestSchema.parse(updatedApproval);
              },
              replay: (record) =>
                ApprovalRequestSchema.parse(store.getApproval(record.response.id)),
              responseId: (result) => result.id,
            });

            return c.json(approval);
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
