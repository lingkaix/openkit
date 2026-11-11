import { randomUUID } from 'node:crypto';
import type { PolicyDecision } from '@openkit/policy-kernel';
import { deriveEntityId, isSealedTurnTerminal, workspaceIdForOwner } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { authorizeWorkspace, currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  createStructuredWorkerDelegationRequest,
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import { createTaskKnowledgePreparation } from '../knowledge-operations.js';
import type { FsStore } from '../lib/store.js';
import { scheduleThreadTitle } from '../llm/thread-title-schedule.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { OperationError } from '../operation-error.js';
import type { GoalTaskPolicyService } from '../policy/goal-task-policy.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { GoalCommandError } from './goal-error.js';
import { goalActor, readGoalView } from './goal-owner.js';
import {
  commandInputHash,
  type IdempotentCommandReceipt,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';
import { runWorkerTurnLoop } from './worker-turn-loop.js';

/** Ordinary Task worker starter supplied by existing product Turn assembly. */
export type TaskWorkerStarter = (input: {
  store: FsStore;
  /** Original Task command facts committed with the admitted Turn. */
  commandReceipt?: IdempotentCommandReceipt;
  triggerActor: { kind: 'user'; id: string };
  /** Native Task handoff cause supplied independently of the responsible actor. */
  triggerSource?: Awaited<ReturnType<FsStore['createTurn']>>['triggerSource'];
  requestActor: Actor;
  workspaceId: string;
  threadId: string;
  prompt: string;
  requestId: string;
  requestedAgentId: string;
  reservedTurnId: string;
  /** Called only after the ordinary scheduler has admitted and persisted this exact Task Turn. */
  onTurnCreated: (
    turn: Awaited<ReturnType<FsStore['createTurn']>>,
    agentSessionId: string | null
  ) => void | Promise<void>;
}) => Promise<Awaited<ReturnType<FsStore['createTurn']>>>;
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
    request: StructuredWorkerDelegationRequestSchema.omit({ reporting: true }),
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
  /** Native Policy composition; missing Goal authority never falls back to the Plan alone. */
  readonly goalTaskPolicy?: (db: WorkspaceDb, responsibleUserId: string) => GoalTaskPolicyService;
}): AgentTool {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(CoordinatorTaskInputSchema) as Record<
    string,
    unknown
  >;
  return {
    name: 'goal.task.dispatch',
    description:
      'Admit an ordinary bounded Task on current intent and the active Plan. Supply your explicit permitted-adjustment judgment and the exact intent/card revisions read. Return after ordinary Task Turn admission; do not wait for completion. A retained Plan/card citation alone is an unadmitted reservation with null admittedAt. On recovery_required inspect the existing Thread, checkpoint and scheduler owners; never automatically retry uncertain work.',
    inputSchema,
    execute: async (value) => {
      const input = CoordinatorTaskInputSchema.parse(value);
      const workerRequest = createStructuredWorkerDelegationRequest(input.request);
      const coordinator = options.store.getTurnById(options.coordinatorTurnId);
      const db = options.openWorkspace(workspaceIdForOwner(coordinator.owner));
      let receivingThreadId: string | undefined;
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
          throw new TurnStartValidationError(
            'task_admission_failed',
            'Current Task write authority is unavailable.'
          );
        const assertGoalTaskAdmission = () => {
          const current: { kernel?: PolicyDecision } = {};
          const human = currentWorkspaceAuthority(
            options.coreDb!,
            goal.workspaceId,
            { kind: 'user', id: actor.userId },
            'turn.run',
            true,
            actor,
            {
              dependencyFailure: 'throw',
              onEvaluation: ({ decision }) => {
                current.kernel = decision;
              },
            }
          );
          if (!human || !current.kernel || !options.goalTaskPolicy)
            throw new TurnStartValidationError(
              'task_admission_failed',
              'Current Goal Task Policy admission is unavailable.'
            );
          const admission = options.goalTaskPolicy(db, goal.responsibleUserId).evaluateAdmission({
            workspaceDb: db,
            goalId: goal.goalId,
            planVersionId: input.planVersionId,
            agentId: input.agentId,
            responsibleHumanId: goal.responsibleUserId,
            resources: workerRequest.resources.flatMap((value) =>
              value.kind === 'policy' ? [value.resource] : []
            ),
            humanKernel: current.kernel,
          });
          if (admission.kernel.effect !== 'allow')
            throw new TurnStartValidationError(
              'task_admission_failed',
              admission.domainAvailable
                ? 'The selected Task Worker or resources are outside the current Goal domain.'
                : 'No admitted Goal domain is available for this active Plan. Retry publication from its recorded Plan approval under current authority; if revoked or expired, propose and approve a replacement Plan.'
            );
        };
        // Refuse before creating a Task; asynchronous preparation must not preserve stale bounds.
        assertGoalTaskAdmission();
        const requestId = randomUUID();
        const threadId = deriveEntityId('th', ['task', requestId]);
        receivingThreadId = threadId;
        const prompt = serializeStructuredWorkerDelegationRequest(workerRequest);
        const turnId = deriveEntityId('tu', {
          command: 'task.start',
          actorId: actor.userId,
          workspaceId: goal.workspaceId,
          threadId,
          requestId,
        });
        const turn = await runIdempotentCommand<Awaited<ReturnType<FsStore['createTurn']>>>({
          store: options.store,
          inflightCommands: options.inflightCommands,
          command: 'task.start',
          requestId,
          scope: { actorId: actor.userId, workspaceId: goal.workspaceId, threadId },
          input: { input: prompt },
          responseKind: 'turn',
          responseId: (turn) => turn.id,
          execute: async (commandReceipt): Promise<Awaited<ReturnType<FsStore['createTurn']>>> => {
            const initialName = workerRequest.objective.slice(0, 100);
            await options.store.createThread(
              goal.workspaceId,
              initialName,
              threadId,
              'conversation',
              {
                visibility: 'workspace',
                threadSource: 'worker',
                parentThreadId: coordinator.threadId,
              }
            );
            scheduleThreadTitle({
              store: options.store,
              workspaceId: goal.workspaceId,
              threadId,
              initialName,
              sourceText: workerRequest.objective,
              actor: { kind: 'user', id: actor.userId },
            });
            let resolveAccepted!: (turn: Awaited<ReturnType<FsStore['createTurn']>>) => void;
            let rejectAccepted!: (reason: unknown) => void;
            const accepted = new Promise<Awaited<ReturnType<FsStore['createTurn']>>>(
              (resolve, reject) => {
                resolveAccepted = resolve;
                rejectAccepted = reject;
              }
            );
            const admittedDb = options.openWorkspace(goal.workspaceId);
            const workerScope = {
              dataRoot: admittedDb.dataRoot,
              workspaceId: admittedDb.workspaceId,
            };
            admittedDb.sqlite.close();
            const workerLoop = runWorkerTurnLoop({
              store: options.store,
              coreDb: options.coreDb!,
              triggerActor: { kind: 'user', id: actor.userId },
              requestActor: actor,
              workspaceDb: workerScope,
              workspaceId: goal.workspaceId,
              threadId,
              requestId,
              requestInputHash: commandInputHash({ input: prompt }),
              reviewRequired: false,
              prepare: async () => {
                const knowledgeSelectionInput = await createTaskKnowledgePreparation({
                  coreDb: options.coreDb,
                  store: options.store,
                  repositoryWorkspaceDb: options.openWorkspace,
                  workspaceMutationAdmission: options.workspaceMutationAdmission,
                })(
                  { workspaceId: goal.workspaceId, query: workerRequest.objective },
                  { actor, traceId: deriveEntityId('krt', requestId), threadId }
                );
                return {
                  delegationRequest: workerRequest,
                  contextPackageDigest: commandInputHash(workerRequest),
                  knowledgeSelectionInput,
                };
              },
              reservedTurnId: turnId,
              goalTaskAdmission: {
                goalId: goal.goalId,
                cardId: input.cardId,
                planVersionId: input.planVersionId,
                cardRevision: input.cardRevision,
                intentRevision: input.intentRevision,
                withinCurrentIntent: input.withinCurrentIntent,
                withinPermittedAdjustments: input.withinPermittedAdjustments,
                rationale: input.rationale,
              },
              reserveTurn: () => {
                assertGoalTaskAdmission();
                return { turnId };
              },
              startWorker: async ({ onAdmitted }) => {
                assertGoalTaskAdmission();
                const ended = await options.startWorker({
                  store: options.store,
                  commandReceipt,
                  triggerSource: { kind: 'handoff', summary: 'Task Worker handoff.' },
                  triggerActor: { kind: 'user', id: actor.userId },
                  requestActor: actor,
                  workspaceId: goal.workspaceId,
                  threadId,
                  prompt,
                  requestId,
                  requestedAgentId: input.agentId,
                  reservedTurnId: turnId,
                  onTurnCreated: async (created, agentSessionId) => {
                    await onAdmitted(created, agentSessionId);
                    resolveAccepted(created);
                  },
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
              .then(async () => {
                // Reuse ordinary Task closeout, including its required durable receipt predicate.
                const workerDb = options.openWorkspace(goal.workspaceId);
                try {
                  const checkpoint = getWorkerCheckpoint(
                    workerDb,
                    goal.workspaceId,
                    threadId,
                    turnId
                  );
                  if (checkpoint)
                    await classifyDirectTaskCheckpointAfterSchedulerRecovery({
                      coreDb: options.coreDb!,
                      store: options.store,
                      workspaceDb: workerDb,
                      checkpoint,
                    });
                } finally {
                  workerDb.sqlite.close();
                }
              })
              .catch(async (error) => {
                rejectAccepted(error);
                const ended = options.store
                  .listThreadTurns(goal.workspaceId, threadId)
                  .find((turn) => turn.id === turnId);
                if (ended && !isSealedTurnTerminal(ended.status))
                  await options.store.updateTurn(turnId, {
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: {
                      code: 'task_admission_failed',
                      message: error instanceof Error ? error.message : 'Task admission failed.',
                    },
                  });
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
                admittedAt: turn.startedAt ?? null,
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
              text: JSON.stringify({
                ...(receivingThreadId ? { threadId: receivingThreadId } : {}),
                ...(error instanceof TurnStartValidationError ||
                error instanceof GoalCommandError ||
                error instanceof OperationError
                  ? { code: error.code, message: error.message }
                  : {
                      code: 'task_admission_failed',
                      message:
                        'Task admission failed without a safe result. Inspect current Task records before a new request.',
                    }),
              }),
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
