import {
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  operationModelInput,
} from '@openkit/app-api-schemas';
import { type AssistantHandoff, AssistantHandoffSchema } from '@openkit/protocol';
import { z } from 'zod';
import { uuidv5 } from '../generative-kernel/uuid.js';
import { OperationError } from '../operation-error.js';
import type { AgentTool, AgentToolResult } from './internal-agent-loop.js';
import { redactInternalAgentText } from './redaction.js';

/** Finite Core identities retain their native owner until that internal family is cut over. */
const NATIVE_TOOLS = [
  ['kernel.apps.search', 'kernel.apps.list'],
  ['kernel.apps.create', 'kernel.apps.create'],
  ['kernel.apps.read', 'kernel.apps.get'],
  ['kernel.schema.update', 'kernel.schema.update'],
  ['kernel.apps.delete', 'kernel.apps.retire'],
  ['kernel.records.search', 'kernel.records.list'],
  ['kernel.records.read', 'kernel.records.get'],
  ['kernel.records.create', 'kernel.records.create'],
  ['kernel.records.update', 'kernel.records.update'],
  ['kernel.records.dispatch', 'kernel.records.batch'],
  ['generative.ui.create', 'generative-ui.publish'],
] as const;

/** Creates the complete fixed Assistant set; proposed work has no downstream effect before human selection. */
export function createAssistantTools(input: {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly privateEntry: boolean;
  readonly history: AgentTool;
  readonly skill: AgentTool;
  readonly assertCurrent: () => void;
  readonly invoke: (id: JsonOperationId, value: unknown, signal: AbortSignal) => Promise<unknown>;
}) {
  let occurrence = 0;
  let handoff: AssistantHandoff | null = null;
  const observe = (value: unknown, isError = false): AgentToolResult => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 65536 || redactInternalAgentText(text) !== text)
      return {
        isError: true,
        content: [{ type: 'text', text: '{"code":"tool_result_unavailable"}' }],
      };
    return { isError, content: [{ type: 'text', text }] };
  };
  const native = (name: string, id: JsonOperationId, propose?: 'task' | 'goal'): AgentTool => {
    const definition = OPERATION_DEFINITIONS[id];
    const schema = operationModelInput(definition.inputSchema, [
      'workspaceId',
      'threadId',
      'turnId',
      'requestId',
      'originThreadId',
    ]);
    const targetsGoal = name.startsWith('goal.') && !propose;
    const modelSchema = propose
      ? schema.safeExtend({ targetWorkspaceId: z.string().min(1).optional() }).strict()
      : targetsGoal
        ? schema
            .safeExtend({
              targetThreadId:
                'threadId' in definition.inputSchema.shape
                  ? definition.inputSchema.shape.threadId
                  : z.never(),
            })
            .strict()
        : schema.strict();
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(modelSchema, { io: 'input' });
    return {
      name,
      description: propose
        ? 'Propose exact shared work for human confirmation. No work starts until the user confirms this payload.'
        : definition.description,
      inputSchema,
      async execute(value, context) {
        context.signal.throwIfAborted();
        try {
          input.assertCurrent();
          const parsed = modelSchema.safeParse(value);
          if (!parsed.success) return observe({ code: 'invalid_tool_input' }, true);
          const requestId = uuidv5(
            JSON.stringify({
              kind: 'assistant-tool-command',
              turnId: input.turnId,
              occurrence: ++occurrence,
              name,
            })
          );
          if (propose) {
            if (handoff) return observe({ code: 'handoff_already_proposed' }, true);
            const { targetWorkspaceId, workerStorageChoice, ...work } = parsed.data;
            if (workerStorageChoice !== undefined)
              return observe(
                {
                  code: 'storage_selection_unavailable',
                  message: 'Select retained storage through explicit Worker submission.',
                },
                true
              );
            handoff = AssistantHandoffSchema.parse({
              kind: propose,
              targetWorkspaceId: targetWorkspaceId ?? input.workspaceId,
              ...work,
            });
            return observe({ code: 'handoff_confirmation_required', handoff });
          }
          const { targetThreadId, ...nativeInput } = parsed.data;
          const result = await input.invoke(
            id,
            {
              ...nativeInput,
              ...('workspaceId' in definition.inputSchema.shape
                ? { workspaceId: input.workspaceId }
                : {}),
              ...('requestId' in definition.inputSchema.shape ? { requestId } : {}),
              ...('threadId' in definition.inputSchema.shape
                ? { threadId: targetsGoal ? targetThreadId : input.threadId }
                : {}),
              ...('turnId' in definition.inputSchema.shape ? { turnId: input.turnId } : {}),
            },
            context.signal
          );
          context.signal.throwIfAborted();
          input.assertCurrent();
          return observe(result);
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          return observe(
            {
              code: error instanceof OperationError ? error.code : 'tool_unavailable',
              message:
                definition.mutating && !propose
                  ? 'Inspect the current owner before retrying. A missing result does not prove that no effect occurred.'
                  : 'The current owner did not return an admitted Tool result.',
            },
            true
          );
        }
      },
    };
  };
  const memory = (name: string): AgentTool => ({
    name,
    description:
      'Current-user Memory operation. Requires the private entry and the scoped Memory owner.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_value, context) {
      context.signal.throwIfAborted();
      input.assertCurrent();
      return observe(
        { code: input.privateEntry ? 'memory_unavailable' : 'private_entry_required' },
        true
      );
    },
  });
  return {
    tools: [
      native('workspace.state.read', 'workspace.dashboard'),
      input.history,
      native('knowledge.search', 'knowledge.retrieval'),
      native('workspace.create', 'workspace.create'),
      native('task.start', 'task.start', 'task'),
      native('goal.create', 'goal.create', 'goal'),
      native('goal.intent.revise', 'goal.intent.revise'),
      native('goal.card.create', 'goal.card.create'),
      native('goal.card.edit', 'goal.card.edit'),
      native('goal.card.cancel', 'goal.card.cancel'),
      ...[
        'memory.page.read',
        'memory.page.create',
        'memory.page.update',
        'memory.page.delete',
        'memory.page.propose',
      ].map(memory),
      input.skill,
      ...NATIVE_TOOLS.map(([name, id]) => native(name, id)),
    ],
    /** Reads only the transient proposal; its pending owner is published after successful model completion. */
    proposedHandoff: () => handoff,
  };
}
