import {
  assertOperationNames,
  OPERATION_DEFINITIONS,
  operationToolName,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createAdministrationTools } from './administration/administration-tools.js';
import { createAdministrationConfigurationTools } from './administration/configuration-tools.js';
import {
  createAdministrationEnvironmentCandidateTools,
  createAdministrationEnvironmentTools,
} from './administration/environment-tools.js';
import { createAdministrationNanoHostRuntimeTargetTool } from './administration/nanohost-runtime-target-tool.js';
import type { Actor } from './auth/identity.js';
import { createAssistantHistory } from './internal-agents/assistant-history.js';
import { createAssistantSkillReadTool } from './internal-agents/assistant-skill-resources.js';
import { createAssistantTools } from './internal-agents/assistant-tools.js';
import type { AgentTool } from './internal-agents/internal-agent-loop.js';
import { createGoalTools } from './runtime/goal-coordinator.js';
import {
  OPENKIT_GENERATIVE_TOOL_OPERATIONS,
  OPENKIT_GENERATIVE_TOOLS,
} from './runtime/openkit-generative-mcp.js';
import { OPENKIT_WORK_TOOLS } from './runtime/openkit-work-mcp.js';
import { createCoordinatorTaskTool } from './runtime/task-admission.js';

function unused(): never {
  throw new Error('A declaration check must not execute a Tool or access its effect dependencies.');
}

/** Effect dependencies stay inaccessible while the real factories construct their declarations. */
function effectDependency<T extends object>(): T {
  return new Proxy({} as T, { get: unused });
}

const actor: Actor = { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' };
const lineage = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
};

function assistantTools(): readonly AgentTool[] {
  const history = createAssistantHistory({
    ...lineage,
    actor,
    store: effectDependency(),
    coreDb: effectDependency(),
  });
  return createAssistantTools({
    ...lineage,
    actorUserId: actor.userId,
    commandRequestId: '00000000-0000-4000-8000-000000000001',
    privateEntry: true,
    history: history.tool,
    skill: createAssistantSkillReadTool(unused),
    assertCurrent: unused,
    invoke: unused,
  }).tools;
}

function administrationTools(): readonly AgentTool[] {
  const candidateTools = createAdministrationEnvironmentCandidateTools({
    actor,
    administrationThreadId: lineage.threadId,
    administrationTurnId: lineage.turnId,
    prepare: unused,
  });
  return createAdministrationTools({
    requireCurrentAdministrator: unused,
    configurationTools: createAdministrationConfigurationTools(
      effectDependency(),
      effectDependency(),
      effectDependency()
    ),
    environmentTools: createAdministrationEnvironmentTools({
      actor,
      candidateTools,
      operations: effectDependency(),
    }),
    runtimeTargetTool: createAdministrationNanoHostRuntimeTargetTool({
      coreDb: undefined,
      mode: 'local',
      actor,
      lineage,
    }),
  });
}

function goalTools(): readonly AgentTool[] {
  type Input = Parameters<typeof createGoalTools>[0];
  // The factory reads the Goal before it creates closures. An absent Goal needs no other record reads, and no Tool is executed here.
  const db = {
    sqlite: {
      prepare(sql: string) {
        expect(sql).toMatch(/^SELECT payload_json FROM goals WHERE goal_id\s*=\s*\?$/);
        return { get: () => undefined };
      },
    },
  } as Input['db'];
  return createGoalTools({
    db,
    actor,
    goalId: 'goal_00000000-0000-7000-8000-000000000001',
    turnId: lineage.turnId,
    store: effectDependency(),
    services: effectDependency(),
    invoke: unused,
  });
}

function taskTools(): readonly AgentTool[] {
  return [
    createCoordinatorTaskTool({
      store: effectDependency(),
      coreDb: undefined,
      openWorkspace: unused,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: effectDependency(),
      startWorker: unused,
      goalId: 'goal_00000000-0000-7000-8000-000000000001',
      coordinatorTurnId: lineage.turnId,
    }),
  ];
}

describe('current operation and Tool names', () => {
  it.each([
    ['Assistant', assistantTools],
    ['Administration', administrationTools],
    ['Goal', goalTools],
    ['Task', taskTools],
    ['Worker', () => OPENKIT_WORK_TOOLS],
  ] as const)('checks actual %s Tool declarations', (_family, createTools) => {
    assertOperationNames(createTools().map((tool) => tool.name));
  });

  it('checks actual composed operations and internal Tool factory declarations together', () => {
    const tools = [...assistantTools(), ...administrationTools(), ...goalTools(), ...taskTools()];
    assertOperationNames([
      ...Object.keys(OPERATION_DEFINITIONS),
      ...tools.map((tool) => tool.name),
      ...OPENKIT_WORK_TOOLS.map((tool) => tool.name),
      ...Object.values(OPENKIT_GENERATIVE_TOOL_OPERATIONS),
    ]);
  });

  it('derives current Worker Generative wire names from their actual logical declarations', () => {
    for (const tool of OPENKIT_GENERATIVE_TOOLS) {
      const canonical = OPENKIT_GENERATIVE_TOOL_OPERATIONS[tool.name];
      expect(canonical).toBeDefined();
      expect(tool.name).toBe(operationToolName(canonical));
    }
  });
});
