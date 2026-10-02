import { randomUUID } from 'node:crypto';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { authorizeWorkspace } from '../auth/operation-authorizer.js';
import {
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import type { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-invocation.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { goalActor, readGoalView } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import {
  commandInputHash,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './idempotent-command.js';
import { clearWorkerCheckpoint } from './worker-checkpoints.js';
import { runWorkerTurnLoop } from './worker-turn-loop.js';

/** Ordinary Task worker starter supplied by existing product Turn assembly. */
export type TaskWorkerStarter = (input: {
  store: FsStore;
  triggerActor: { kind: 'user'; id: string };
  requestActor: Actor;
  workspaceId: string;
  threadId: string;
  prompt: string;
  requestId: string;
  requestedAgentId: string;
  reservedTurnId: string;
  onTurnCreated: (turn: ReturnType<FsStore['createTurn']>) => void;
}) => Promise<ReturnType<FsStore['createTurn']>>;
/** Task inputs contain current read citations, never a second per-Task proposal. */
const CoordinatorTaskInputSchema = z
  .object({
    cardId: z.string().min(1),
    planVersionId: z.string().min(1),
    cardRevision: z.number().int().nonnegative(),
    intentRevision: z.number().int().nonnegative(),
    withinCurrentIntent: z.boolean(),
    withinPermittedAdjustments: z.boolean(),
    rationale: z.string().min(1),
    agentId: z.string().min(1),
    request: StructuredWorkerDelegationRequestSchema,
  })
  .strict();
/** Uses ordinary Task preparation, reservation, scheduler, checkpoint and worker ownership. */
export function createCoordinatorTaskTool(options: {
  readonly store: FsStore;
  readonly coreDb: CoreDb | undefined;
  readonly openWorkspace: (workspaceId: string) => WorkspaceDb;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  readonly startWorker: TaskWorkerStarter;
  readonly goalId: string;
  readonly coordinatorTurnId: string;
}): AgentTool {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(CoordinatorTaskInputSchema) as Record<
    string,
    unknown
  >;
  return {
    name: 'task_start',
    description:
      'Admit an ordinary bounded Task on current intent and the active Plan. Supply your explicit permitted-adjustment judgment and the exact intent/card revisions read. Return after admission; do not wait for completion.',
    inputSchema,
    execute: async (value) => {
      const input = CoordinatorTaskInputSchema.parse(value);
      const coordinator = options.store.getTurnById(options.coordinatorTurnId);
      const db = options.openWorkspace(coordinator.workspaceId);
      try {
        const goal = readGoalView(options.store, db, options.goalId).goal;
        if (
          !goal ||
          goal.threadId !== coordinator.threadId ||
          coordinator.agentId !== 'goal-coordinator' ||
          coordinator.agentSessionId ||
          coordinator.status !== 'running'
        )
          throw new Error('Current Coordinator Turn authority is unavailable.');
        const actor: Actor = goalActor(goal);
        if (
          !options.coreDb ||
          !authorizeWorkspace(options.coreDb, actor, goal.workspaceId, {
            mutating: true,
            policyOperation: 'workspace.write',
          })
        )
          throw new Error('Current Task write authority is unavailable.');
        const requestId = randomUUID();
        const threadId = `th_task_${requestId}`;
        const prompt = serializeStructuredWorkerDelegationRequest(input.request);
        const turnId = `turn_${requestId}_${commandInputHash({ command: 'task.start', actorId: actor.userId, workspaceId: goal.workspaceId, threadId, requestId }).slice(-16)}`;
        const turn = await runIdempotentCommand({
          store: options.store,
          inflightCommands: options.inflightCommands,
          command: 'task.start',
          requestId,
          scope: { actorId: actor.userId, workspaceId: goal.workspaceId, threadId },
          input: { input: prompt },
          responseKind: 'turn',
          responseId: (turn) => turn.id,
          execute: async () => {
            options.store.createThread(
              goal.workspaceId,
              input.request.objective.slice(0, 100),
              threadId
            );
            let resolveAccepted!: (turn: ReturnType<FsStore['createTurn']>) => void;
            let rejectAccepted!: (reason: unknown) => void;
            const accepted = new Promise<ReturnType<FsStore['createTurn']>>((resolve, reject) => {
              resolveAccepted = resolve;
              rejectAccepted = reject;
            });
            const workerDb = options.openWorkspace(goal.workspaceId);
            const workerLoop = runWorkerTurnLoop({
              coreDb: options.coreDb!,
              triggerActor: { kind: 'user', id: actor.userId },
              requestActor: actor,
              workspaceDb: workerDb,
              workspaceId: goal.workspaceId,
              threadId,
              requestId,
              requestInputHash: commandInputHash({ input: prompt }),
              reviewRequired: false,
              prepare: async () => {
                const knowledgeSelectionInput = await createOperationInvocation({
                  coreDb: options.coreDb,
                  store: options.store,
                  repositoryWorkspaceDb: options.openWorkspace,
                  inflightCommands: options.inflightCommands,
                  workspaceMutationAdmission: options.workspaceMutationAdmission,
                })(
                  'knowledge.context.prepare',
                  { workspaceId: goal.workspaceId, query: input.request.objective },
                  { kind: 'task', actor, traceId: `krt_${requestId}` }
                );
                return {
                  delegationRequest: input.request,
                  contextPackageDigest: commandInputHash(input.request),
                  knowledgeSelectionInput,
                };
              },
              reserveTurn: () => {
                reserveGoalTask(
                  options.store,
                  workerDb,
                  { ...input, goalId: goal.goalId },
                  threadId
                );
                return { turnId };
              },
              startWorker: async () => {
                const ended = await options.startWorker({
                  store: options.store,
                  triggerActor: { kind: 'user', id: actor.userId },
                  requestActor: actor,
                  workspaceId: goal.workspaceId,
                  threadId,
                  prompt,
                  requestId,
                  requestedAgentId: input.agentId,
                  reservedTurnId: turnId,
                  onTurnCreated: resolveAccepted,
                });
                return { workerSessionId: ended.agentSessionId ?? null };
              },
              awaitWorker: () => {
                const ended = options.store.getTurnById(turnId);
                return {
                  stopReason:
                    ended.status === 'completed'
                      ? 'completed'
                      : ended.status === 'interrupted'
                        ? 'aborted'
                        : 'error',
                  itemIds: ended.items.map((item) => item.id),
                  artifactIds: ended.items.flatMap((item) =>
                    item.type === 'artifact-reference' ? [item.artifactId] : []
                  ),
                };
              },
            });
            void workerLoop
              .catch((error) => {
                rejectAccepted(error);
                const ended = options.store
                  .listThreadTurns(goal.workspaceId, threadId)
                  .find((turn) => turn.id === turnId);
                if (ended && !isSealedTurnTerminal(ended.status))
                  options.store.updateTurn(turnId, {
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: {
                      code: 'task_admission_failed',
                      message: error instanceof Error ? error.message : 'Task admission failed.',
                    },
                  });
              })
              .finally(() => {
                clearWorkerCheckpoint(workerDb, goal.workspaceId, threadId, turnId);
                workerDb.sqlite.close();
              });
            return await accepted;
          },
          replay: (receipt) => options.store.getTurnById(receipt.response.id),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                threadId,
                turnId: turn.id,
                planVersionId: input.planVersionId,
                cardRevision: input.cardRevision,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Task admission failed.',
            },
          ],
          isError: true,
        };
      } finally {
        db.sqlite.close();
      }
    },
  };
}
