import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertOperationNames,
  OPERATION_DEFINITIONS,
  operationToolName,
} from '@openkit/app-api-schemas';
import { AgentEnvironmentCapabilitiesSchema } from '@openkit/config-schema';
import ts from 'typescript';
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
import { OPENKIT_WORK_TOOL_DEFINITIONS, OPENKIT_WORK_TOOLS } from './runtime/openkit-work-mcp.js';
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
        expect(sql).toMatch(
          /^SELECT schema_version AS schemaVersion,payload_json FROM goals WHERE goal_id\s*=\s*\?$/
        );
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

function capabilityNames(): string[] {
  const enabled = AgentEnvironmentCapabilitiesSchema.options.find(
    (option) => option.shape.mode.value === 'enabled'
  );
  if (!enabled || enabled.shape.routes.type !== 'tuple') {
    throw new Error('Enabled Worker capability routes must expose their declared tuple.');
  }
  return enabled.shape.routes.def.items.map((route) => route.value);
}

/** Removes syntax-only wrappers without evaluating an expression. */
function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

/** Finds an ordinary lexical binding without following imports or evaluating its initializer. */
function localBinding(value: ts.Identifier) {
  for (let scope: ts.Node | undefined = value.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.text
      );
      if (parameter) return parameter;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === value.text)
        return statement;
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.text
      );
      if (declaration) return declaration;
    }
  }
  return undefined;
}

/** Reads a literal or one ordinary lexical const binding; computed and imported values stay with runtime admission. */
function authoredName(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (!ts.isIdentifier(value)) return undefined;
  const binding = localBinding(value);
  if (
    !binding ||
    !ts.isVariableDeclaration(binding) ||
    !binding.initializer ||
    !ts.isVariableDeclarationList(binding.parent) ||
    !(binding.parent.flags & ts.NodeFlags.Const)
  )
    return undefined;
  const initializer = unwrap(binding.initializer);
  return ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
}

/** Reads authored Tool descriptors and projection arguments without importing source modules or executing factories. */
function authoredOperationNames(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const wrappers = new Map<ts.VariableDeclaration, number>();
  const calls: ts.CallExpression[] = [];
  const projections = new Set(['operationToolName']);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === 'operationToolName')
        projections.add(binding.name.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(
        node.properties.flatMap((property) => {
          if (ts.isSpreadAssignment(property)) return [];
          const key = property.name;
          return ts.isIdentifier(key) || ts.isStringLiteralLike(key)
            ? [[key.text, property] as const]
            : [];
        })
      );
      if (fields.has('inputSchema') && (fields.has('description') || fields.has('execute'))) {
        const property = fields.get('name');
        const expression =
          property &&
          (ts.isPropertyAssignment(property)
            ? property.initializer
            : ts.isShorthandPropertyAssignment(property)
              ? property.name
              : undefined);
        const name = authoredName(expression);
        if (name !== undefined) names.push(name);
        else if (expression) {
          const value = unwrap(expression);
          const parameter = ts.isIdentifier(value) ? localBinding(value) : undefined;
          if (parameter && ts.isParameter(parameter)) {
            const factory = parameter.parent;
            // This current wrapper returns the descriptor directly; no general return-flow interpretation is needed.
            if (
              ts.isArrowFunction(factory) &&
              !ts.isBlock(factory.body) &&
              unwrap(factory.body) === node &&
              ts.isVariableDeclaration(factory.parent) &&
              ts.isVariableDeclarationList(factory.parent.parent) &&
              factory.parent.parent.flags & ts.NodeFlags.Const
            ) {
              wrappers.set(factory.parent, factory.parameters.indexOf(parameter));
            }
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && projections.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'operationToolName'))
    ) {
      for (const argument of node.arguments) {
        const name = authoredName(argument);
        if (name !== undefined) names.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const call of calls) {
    if (!ts.isIdentifier(call.expression)) continue;
    const binding = localBinding(call.expression);
    const position =
      binding && ts.isVariableDeclaration(binding) ? wrappers.get(binding) : undefined;
    if (position === undefined) continue;
    const name = authoredName(call.arguments[position]);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Tests and fixture code are not product Tool producers. All other current source files participate without a family list. */
function currentAuthoredOperationNames(): string[] {
  const root = dirname(fileURLToPath(import.meta.url));
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !/\.(?:test(?:-d)?|spec)\.ts$/.test(file))
    .filter(
      (file) =>
        !relative(root, file)
          .split(sep)
          .some((part) => ['fixtures', '__fixtures__', '__tests__', 'test-support'].includes(part))
    )
    .sort()
    .flatMap((file) => authoredOperationNames(readFileSync(file, 'utf8'), file));
}

describe('current operation and Tool names', () => {
  it('rejects a newly added private Tool descriptor without a factory or family list entry', () => {
    const source = `
      const KM_TOOL_NAME = 'knowledge_ask';
      export function createPrivateTools() {
        return [{ name: KM_TOOL_NAME, description: 'Ask', inputSchema: {}, execute() {} }];
      }
    `;
    expect(() =>
      assertOperationNames(authoredOperationNames(source, 'new-private-factory.ts'))
    ).toThrow('Invalid operation name: knowledge_ask');
  });

  it('checks authored names forwarded by a local Tool wrapper parameter', () => {
    const source = `
      const tool = (name: string, key: string, execute: unknown): AgentTool => ({
        name, description: 'Notebook update', inputSchema: {}, execute,
      });
      tool('knowledge.notebook-workspace.update', 'script', run);
      tool('knowledge.notebook.update', 'summary', run);
      tool('knowledge_bad', 'summary', run);
    `;
    const names = authoredOperationNames(source, 'local-wrapper.ts');
    expect(names).toEqual([
      'knowledge.notebook-workspace.update',
      'knowledge.notebook.update',
      'knowledge_bad',
    ]);
    expect(() => assertOperationNames(names)).toThrow('Invalid operation name: knowledge_bad');
  });

  it('reads descriptor arrays, constants and projection arguments while excluding opaque names and accounting labels', () => {
    const source = `
      import { operationToolName as project } from '@openkit/app-api-schemas';
      const TOOL_NAME = 'knowledge.ask';
      const vendorName = configuration.name;
      const tools = [
        { name: TOOL_NAME, description: 'Ask', inputSchema: {} },
        { name: 'knowledge.tell', inputSchema: {}, execute() {} },
        { name: vendorName, description: 'External', inputSchema: {} },
      ];
      const usage = { name: 'inference.local.quick_chat', description: 'Accounting' };
      project('knowledge.health-check');
    `;
    expect(authoredOperationNames(source, 'unlisted-factory.ts')).toEqual([
      'knowledge.ask',
      'knowledge.tell',
      'knowledge.health-check',
    ]);
  });

  it('checks authored names across every current product source file with the composed operation names', () => {
    assertOperationNames([
      ...Object.keys(OPERATION_DEFINITIONS),
      ...currentAuthoredOperationNames(),
    ]);
  });

  it.each([
    ['Assistant', assistantTools],
    ['Administration', administrationTools],
    ['Goal', goalTools],
    ['Task', taskTools],
    ['Worker', () => OPENKIT_WORK_TOOL_DEFINITIONS],
  ] as const)('checks actual %s Tool declarations', (_family, createTools) => {
    assertOperationNames(createTools().map((tool) => tool.name));
  });

  it('checks actual composed operations and internal Tool factory declarations together', () => {
    const tools = [...assistantTools(), ...administrationTools(), ...goalTools(), ...taskTools()];
    assertOperationNames([
      ...Object.keys(OPERATION_DEFINITIONS),
      ...tools.map((tool) => tool.name),
      ...OPENKIT_WORK_TOOL_DEFINITIONS.map((tool) => tool.name),
      ...Object.values(OPENKIT_GENERATIVE_TOOL_OPERATIONS),
      ...capabilityNames(),
    ]);
  });

  it('checks the current Worker MCP capability declarations', () => {
    assertOperationNames(capabilityNames());
  });

  it('derives current Worker Work wire descriptors from their actual canonical declarations', () => {
    expect(OPENKIT_WORK_TOOLS).toEqual(
      OPENKIT_WORK_TOOL_DEFINITIONS.map((tool) => ({
        ...tool,
        name: operationToolName(tool.name),
      }))
    );
  });

  it('derives current Worker Generative wire names from their actual logical declarations', () => {
    for (const tool of OPENKIT_GENERATIVE_TOOLS) {
      const canonical = OPENKIT_GENERATIVE_TOOL_OPERATIONS[tool.name];
      if (canonical === undefined) throw new Error(`Unmapped Worker Generative Tool: ${tool.name}`);
      expect(tool.name).toBe(operationToolName(canonical));
    }
  });
});
