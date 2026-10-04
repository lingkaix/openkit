import { randomUUID } from 'node:crypto';
import {
  GOAL_OPERATION_DEFINITIONS,
  GoalRecordSchema,
  operationToolName,
} from '@openkit/app-api-schemas';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { authorizeWorkspace } from '../auth/operation-authorizer.js';
import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { assembleBuiltInSystemPrompt } from '../internal-agents/builtin-prompts.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import { type AgentTool, runInternalAgentLoop } from '../internal-agents/internal-agent-loop.js';
import { resolveInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import type { FsStore } from '../lib/store.js';
import { resolveLogicalModel } from '../llm/logical-models.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  type GoalOperationId,
  type GoalOwnerServices,
  goalActor,
  readGoalView,
} from './goal-owner.js';
import { proveFrozenDelivery } from './pending-requests.js';
import { recoverTaskTerminalFacts } from './task-terminal-fact.js';

/** Marker admission uses only ordinary Threads and Turns; no queue, timer or run record exists. */
export function considerGoal(
  store: FsStore,
  db: WorkspaceDb,
  goalId: string,
  mayAdmit: (actor: Actor) => boolean = () => true
): ReturnType<FsStore['createTurn']> | null {
  const goal = readGoalView(store, db, goalId).goal;
  if (
    !goal ||
    goal.disposition ||
    goal.changeRevision <= goal.consideredRevision ||
    store
      .listThreadTurns(goal.workspaceId, goal.threadId)
      .some((turn) => !isSealedTurnTerminal(turn.status))
  )
    return null;
  const actor: Actor = goalActor(goal);
  if (!mayAdmit(actor)) return null;
  // Ordinary admission owns its Pending Request freeze; do not hold a second SQL writer around it.
  const turn = store.createTurn(
    goal.workspaceId,
    goal.threadId,
    'Consider current Goal records',
    { kind: 'user', id: actor.userId },
    undefined,
    { turnId: `tu_goal_${randomUUID()}`, executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  db.sqlite
    .prepare(
      "UPDATE goals SET payload_json=json_set(payload_json, '$.consideredRevision', ?) WHERE goal_id=?"
    )
    .run(goal.changeRevision, goalId);
  return turn;
}
/** Existing Gateway and Task owners supplied by application assembly. */
export interface GoalCoordinatorOptions {
  readonly store: FsStore;
  readonly coreDb: CoreDb | undefined;
  readonly openWorkspace: (workspaceId: string) => WorkspaceDb;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  readonly taskTool: (goalId: string, turnId: string) => AgentTool;
  readonly services: () => GoalOwnerServices;
}
/** Table-derived Tools bind trusted identity to the existing admitted Coordinator Turn. */
export function createGoalTools(input: {
  readonly store: FsStore;
  readonly db: WorkspaceDb;
  readonly actor: Actor;
  readonly goalId: string;
  readonly turnId: string;
  readonly services: GoalOwnerServices;
  readonly invoke: ReturnType<typeof createOperationInvocation>;
}): AgentTool[] {
  const goal = readGoalView(input.store, input.db, input.goalId).goal!;
  return Object.entries(GOAL_OPERATION_DEFINITIONS)
    .filter(([, definition]) =>
      (definition.credentials as readonly string[]).includes('coordinator')
    )
    .map(([key, definition]) => {
      const { $schema: _schema, ...schema } = z.toJSONSchema(
        z
          .object(
            Object.fromEntries(
              Object.entries(definition.inputSchema.shape).filter(
                ([key]) => !['workspaceId', 'threadId', 'goalId', 'requestId'].includes(key)
              )
            ) as Record<string, z.ZodType>
          )
          .strict()
      ) as Record<string, unknown>;
      return {
        name: operationToolName(key),
        description: definition.description,
        inputSchema: schema,
        execute: async (args) => {
          try {
            const result = await input.invoke(key as GoalOperationId, args, {
              kind: 'coordinator',
              actor: input.actor,
              workspaceId: goal.workspaceId,
              threadId: goal.threadId,
              goalId: goal.goalId,
              turnId: input.turnId,
              requestId: randomUUID(),
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: error instanceof Error ? error.message : 'Goal operation failed.',
                },
              ],
              isError: true,
            };
          }
        },
      };
    });
}
/** Runs ordinary internal-agent Turns and owns their terminal closeout and wake opportunities. */
export function createGoalCoordinator(options: GoalCoordinatorOptions) {
  const active = new Set<string>();
  async function startTurn(store: FsStore, turnId: string): Promise<void> {
    if (active.has(turnId)) return;
    active.add(turnId);
    const turn = store.getTurnById(turnId);
    const db = options.openWorkspace(turn.workspaceId);
    const row = db.sqlite
      .prepare('SELECT goal_id FROM goals WHERE thread_id=?')
      .get(turn.threadId) as { goal_id: string } | undefined;
    try {
      if (!row) throw new Error('Coordinator Goal is unavailable.');
      const view = readGoalView(store, db, row.goal_id);
      const goal = view.goal!;
      const actor: Actor = goalActor(goal);
      if (
        !options.coreDb ||
        !authorizeWorkspace(options.coreDb, actor, goal.workspaceId, {
          policyOperation: 'workspace.write',
          mutating: true,
        })
      )
        throw new Error('Coordinator current authority is unavailable.');
      db.sqlite.transaction(() => {
        const current = readGoalView(store, db, goal.goalId).goal!;
        db.sqlite
          .prepare('UPDATE goals SET payload_json=? WHERE goal_id=?')
          .run(
            JSON.stringify({ ...current, consideredRevision: current.changeRevision }),
            goal.goalId
          );
      })();
      const snapshot = options.runtimeConfig();
      const workspaceConfig = findWorkspaceConfig(snapshot, goal.workspaceId)?.config;
      const userConfig = snapshot.userConfigs.find(
        (entry) => entry.userId === goal.responsibleUserId
      )?.config;
      const selection = resolveInternalRoleProfile({
        roleId: 'goal-orchestrator',
        workspaceId: goal.workspaceId,
        gatewayConfig: snapshot.gatewayConfig,
        profilesConfig: snapshot.internalRoleProfiles,
        providerRegistry: snapshot.providerRegistry,
        providerSubscriptionAccountManager: options.providerSubscriptionAccountManager,
        providerCredentialConfigured: options.providerCredentialConfigured,
        ...(workspaceConfig ? { workspaceConfig } : {}),
        ...(userConfig ? { userConfig } : {}),
      });
      if (
        !selection ||
        !selection.logicalModel.capabilities.includes('responses') ||
        !selection.logicalModel.capabilities.includes('tool-calling') ||
        !selection.logicalModel.contextManagement
      )
        throw new Error('Coordinator logical model is unavailable.');
      const systemPrompt = assembleBuiltInSystemPrompt('goal-orchestrator');
      const tools = [
        ...createGoalTools({
          store,
          db,
          actor,
          goalId: goal.goalId,
          turnId,
          services: options.services(),
          invoke: createOperationInvocation({
            coreDb: options.coreDb,
            store,
            goalServices: options.services(),
            repositoryWorkspaceDb: options.openWorkspace,
            inflightCommands: options.services().inflightCommands!,
            workspaceMutationAdmission: options.workspaceMutationAdmission,
          }),
        }),
        options.taskTool(goal.goalId, turnId),
      ];
      await withTurnModelCapture(
        { store, turn, workspaceDb: db, environment: { systemPrompt, tools } },
        async (capture) => {
          // Native acceptance of exact source input proves delivery, never grant consumption.
          proveFrozenDelivery(db.sqlite, turnId, new Date().toISOString());
          const exit = await runInternalAgentLoop(
            {
              systemPrompt,
              messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(view) }] }],
              tools,
              model: {
                logicalModelId: selection.logicalModel.id,
                capabilities: selection.logicalModel.capabilities,
                modelFamilyId: selection.logicalModel.modelFamilyId,
              },
              contextManagement: {
                ...selection.logicalModel.contextManagement!,
                authority: 'openkit',
              },
              limits: selection.profile?.limits ?? {
                maxModelTurns: 8,
                maxToolCalls: 24,
                deadlineMs: 120000,
              },
              signal: new AbortController().signal,
            },
            createInternalAgentGatewayProvider({
              capture,
              logicalModel: selection.logicalModel,
              resolveLogicalModel: (id) => {
                const current = options.runtimeConfig();
                return resolveLogicalModel(
                  current.gatewayConfig,
                  current.providerRegistry,
                  id,
                  options.providerSubscriptionAccountManager,
                  options.providerCredentialConfigured
                );
              },
              dispatcher: options.llmGatewayDispatcher,
              resolveGatewayProvider: options.resolveGatewayProvider,
              ...(options.providerSubscriptionAccountManager
                ? { providerSubscriptionAccountManager: options.providerSubscriptionAccountManager }
                : {}),
              promptCacheScope: { sessionId: `goal:${goal.goalId}`, workspaceId: goal.workspaceId },
              usageEndpoint: 'responses',
              callContext: {
                authorityActor: { kind: 'user', id: actor.userId },
                agentId: 'goal-coordinator',
                workspaceId: goal.workspaceId,
                family: 'llm',
                operation: 'goal.coordinate',
                capabilityId: 'inference.local.goal_coordinator',
                providerRef: null,
                requestId: null,
                serviceRef: 'llm-gateway',
                redactionClass: 'metadata-only',
                summary: 'Goal Coordinator Turn.',
              },
            })
          );
          if (exit.kind !== 'quiescent')
            throw new Error(
              `Coordinator Turn did not finish: ${exit.kind}${'code' in exit ? ` (${exit.code})` : ''}.`
            );
          const text = exit.messages
            .filter((message) => message.role === 'assistant')
            .flatMap((message) =>
              message.content
                .filter((content) => content.type === 'text')
                .map((content) => content.text)
            )
            .join('\n\n');
          if (text)
            store.createItem({
              id: `it_${randomUUID()}`,
              workspaceId: goal.workspaceId,
              threadId: goal.threadId,
              turnId,
              type: 'assistant-message',
              text,
              status: 'completed',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            });
        }
      );
      store.updateTurn(turnId, { status: 'completed', completedAt: new Date().toISOString() });
    } catch (error) {
      if (!isSealedTurnTerminal(store.getTurnById(turnId).status))
        store.updateTurn(turnId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: {
            code: 'goal_coordinator_failed',
            message: error instanceof Error ? error.message : 'Coordinator failed.',
          },
        });
    } finally {
      active.delete(turnId);
      db.sqlite.close();
    }
  }
  function wake(workspaceId: string, goalId: string): void {
    const db = options.openWorkspace(workspaceId);
    try {
      const turn = considerGoal(options.store, db, goalId, (actor) =>
        Boolean(
          options.coreDb &&
            authorizeWorkspace(options.coreDb, actor, workspaceId, {
              policyOperation: 'workspace.write',
              mutating: true,
            })
        )
      );
      if (turn) void startTurn(options.store, turn.id);
    } finally {
      db.sqlite.close();
    }
  }
  function terminal(turn: ReturnType<FsStore['getTurnById']>): void {
    const db = options.openWorkspace(turn.workspaceId);
    try {
      const rows = db.sqlite
        .prepare(
          'SELECT goal_id FROM goals WHERE thread_id=? UNION SELECT goal_id FROM goal_card_tasks WHERE thread_id=?'
        )
        .all(turn.threadId, turn.threadId) as { goal_id: string }[];
      for (const row of rows) wake(turn.workspaceId, row.goal_id);
    } finally {
      db.sqlite.close();
    }
  }
  function boot(): void {
    for (const workspace of options.store.listWorkspaces()) {
      const db = options.openWorkspace(workspace.id);
      try {
        recoverTaskTerminalFacts(options.store, db);
        for (const row of db.sqlite.prepare('SELECT payload_json FROM goals').all() as {
          payload_json: string;
        }[]) {
          const goal = GoalRecordSchema.parse(JSON.parse(row.payload_json));
          for (const turn of options.store.listThreadTurns(workspace.id, goal.threadId))
            if (
              turn.agentId === 'goal-coordinator' &&
              !isSealedTurnTerminal(turn.status) &&
              !active.has(turn.id)
            )
              options.store.updateTurn(turn.id, {
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: { code: 'core_restarted', message: 'Coordinator Turn ended at restart.' },
              });
          wake(workspace.id, goal.goalId);
        }
      } finally {
        db.sqlite.close();
      }
    }
  }
  return { wake, terminal, boot, startTurn };
}
