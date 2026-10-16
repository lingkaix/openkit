import {
  composeOperationTables,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  operationModelInput,
} from '@openkit/app-api-schemas';
import { z } from 'zod';
import type { AgentTool, ToolExecutionContext } from '../internal-agents/internal-agent-loop.js';
import { OperationError } from '../operation-error.js';

const definitions = composeOperationTables(
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  { 'generative-ui.publish': GENERATIVE_UI_OPERATION_DEFINITIONS['generative-ui.publish'] }
);

/** Closed native family admitted to an ordinary Assistant command. */
export type AssistantGenerativeOperationId = keyof typeof definitions;

/** Native invocation binds the admitted command and rechecks current authority for each call. */
export type AssistantGenerativeInvocation = (
  operationId: AssistantGenerativeOperationId,
  input: unknown,
  context: ToolExecutionContext
) => Promise<unknown>;

/**
 * Projects the fixed Kernel and native publication family for one admitted internal command.
 *
 * The supplied native invoker owns actor, Workspace, Thread, Turn and stable command identities. No Tool can select another entry scope or dispatch arbitrary operations. Renderer bytes stay in private details; the model receives publication references and safe owner outcomes.
 *
 * @param invoke Trusted native invocation bound by the command entry.
 * @returns Definition-derived Tools with no direct command bypass.
 */
export function createAssistantGenerativeTools(invoke: AssistantGenerativeInvocation): AgentTool[] {
  const ordered: AssistantGenerativeOperationId[] = [
    'kernel.apps.list',
    'kernel.apps.create',
    'kernel.apps.get',
    'kernel.schema.update',
    'kernel.apps.retire',
    'kernel.records.list',
    'kernel.records.get',
    'kernel.records.create',
    'kernel.records.update',
    'kernel.records.batch',
    'generative-ui.publish',
  ];
  return ordered.map((name): AgentTool => {
    const definition = definitions[name];
    const schema = operationModelInput(definition.inputSchema, [
      'workspaceId',
      'threadId',
      'turnId',
      'requestId',
    ]);
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' });
    return Object.freeze({
      name,
      description: definition.description,
      inputSchema,
      async execute(input: unknown, context: ToolExecutionContext) {
        context.signal.throwIfAborted();
        try {
          if (!Number.isSafeInteger(context.toolOccurrence) || context.toolOccurrence < 1)
            throw new OperationError(
              'invalid_request',
              'Accepted Tool occurrence is required.',
              400
            );
          const parsed = schema.safeParse(input);
          if (!parsed.success)
            throw new OperationError('invalid_request', 'Invalid operation input.', 400);
          const result = definition.outputSchema.safeParse(
            await invoke(name, parsed.data, context)
          );
          context.signal.throwIfAborted();
          if (!result.success) throw new Error('Invalid native operation output.');
          if (name === 'generative-ui.publish') {
            const presentation = GENERATIVE_UI_OPERATION_DEFINITIONS[
              'generative-ui.publish'
            ].outputSchema.parse(result.data);
            if (presentation.publication !== 'published')
              throw new OperationError(
                'recovery_required',
                'Presentation publication requires recovery.',
                409
              );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    presentationId: presentation.id,
                    itemId: presentation.itemId,
                    publication: presentation.publication,
                    source: presentation.source,
                    title: presentation.title,
                    nextStep:
                      'The view is published. Give a concise final summary without repeating its source text.',
                  }),
                },
              ],
              details: presentation,
            };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  error instanceof OperationError
                    ? { code: error.code, message: error.message }
                    : {
                        code: 'operation_failed',
                        message: 'Operation failed. Inspect the owner outcome before retrying.',
                      }
                ),
              },
            ],
          };
        }
      },
    });
  });
}
