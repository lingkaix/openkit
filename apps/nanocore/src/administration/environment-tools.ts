import { createHash } from 'node:crypto';
import type {
  GetWorkerEnvironmentStatusResponse,
  ListWorkerEnvironmentsQuery,
  ListWorkerEnvironmentsResponse,
} from '@openkit/app-api-schemas';
import {
  type PrepareWorkerEnvironmentRequest,
  PrepareWorkerEnvironmentRequestSchema,
  type PrepareWorkerEnvironmentResponse,
} from '@openkit/app-api-schemas';
import { z } from 'zod';

import type { Actor } from '../auth/identity.js';
import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import type { AdministrationEnvironmentTools } from './administration-tools.js';

/** Existing read operations needed by the administration environment Tool adapter. */
export interface AdministrationEnvironmentReadOperations {
  list(
    context: { readonly actor: Actor; readonly workspaceId: string },
    input: ListWorkerEnvironmentsQuery
  ): ListWorkerEnvironmentsResponse;
  status(
    context: { readonly actor: Actor; readonly workspaceId: string },
    input: { readonly storageRef: string }
  ): Promise<GetWorkerEnvironmentStatusResponse>;
}

/** Dependencies for the fixed Worker environment Tool adapter. */
export interface CreateAdministrationEnvironmentToolsInput {
  readonly actor: Actor;
  readonly operations: AdministrationEnvironmentReadOperations;
  readonly prepareTool: AgentTool;
}

/** Creates the exact list, status, and owner-supplied prepare Tool sequence. */
export function createAdministrationEnvironmentTools(
  input: CreateAdministrationEnvironmentToolsInput
): AdministrationEnvironmentTools {
  if (input.prepareTool.name !== 'worker_environment.prepare') {
    throw new Error('Administration prepare Tool identity is invalid.');
  }
  return [
    {
      name: 'worker_environment.list',
      description:
        'List a bounded page of retained Worker environments currently visible to the administrator in one exact Workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceId: { type: 'string', minLength: 1 },
          after: { type: 'string', pattern: '^wst_[a-f0-9]{32}$' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['workspaceId'],
      },
      execute: async (value) =>
        operationResult(() => {
          const args = value as { workspaceId: string; after?: string; limit?: number };
          return input.operations.list(
            { actor: input.actor, workspaceId: args.workspaceId },
            { ...(args.after ? { after: args.after } : {}), limit: args.limit ?? 50 }
          );
        }),
    },
    {
      name: 'worker_environment.status',
      description:
        'Inspect current Core and host status for one exact retained Worker environment in one exact Workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceId: { type: 'string', minLength: 1 },
          storageRef: { type: 'string', pattern: '^wst_[a-f0-9]{32}$' },
        },
        required: ['workspaceId', 'storageRef'],
      },
      execute: async (value) =>
        operationResult(() => {
          const args = value as { workspaceId: string; storageRef: string };
          return input.operations.status(
            { actor: input.actor, workspaceId: args.workspaceId },
            { storageRef: args.storageRef }
          );
        }),
    },
    input.prepareTool,
  ];
}

/** Creates a preparation Tool bound to its actual private Turn, with no model-selected authority. */
export function createAdministrationEnvironmentPrepareTool(input: {
  readonly actor: Actor;
  readonly administrationThreadId: string;
  readonly administrationTurnId: string;
  readonly prepare: (
    context: { actor: Actor; administrationTurnId: string },
    request: PrepareWorkerEnvironmentRequest
  ) => Promise<PrepareWorkerEnvironmentResponse>;
}): AgentTool {
  const schema = z.discriminatedUnion('mode', [
    PrepareWorkerEnvironmentRequestSchema.options[0].omit({
      administrationThreadId: true,
      requestId: true,
    }),
    PrepareWorkerEnvironmentRequestSchema.options[1].omit({
      administrationThreadId: true,
      requestId: true,
    }),
  ]);
  return {
    name: 'worker_environment.prepare',
    description:
      'Prepare or recover an immutable Worker environment candidate for human review. This never activates, interrupts, or mounts work.',
    inputSchema: z.toJSONSchema(schema),
    execute: async (value, context) =>
      operationResult(async () => {
        const parsed = schema.safeParse(value);
        if (!parsed.success)
          throw Object.assign(new Error('Invalid preparation input.'), { code: 'invalid_request' });
        const digest = createHash('sha256')
          .update(JSON.stringify([input.actor.userId, input.administrationTurnId, context.callId]))
          .digest('hex');
        const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        return input.prepare(
          { actor: input.actor, administrationTurnId: input.administrationTurnId },
          {
            ...parsed.data,
            administrationThreadId: input.administrationThreadId,
            requestId,
          }
        );
      }),
  };
}

async function operationResult(
  operation: () => unknown | Promise<unknown>
): Promise<AgentToolResult> {
  try {
    const result = await operation();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const record = asRecord(error);
    const failure = safeOperationFailure(record?.code);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: failure.code,
            message: failure.message,
          }),
        },
      ],
      isError: true,
    };
  }
}

function safeOperationFailure(code: unknown): { readonly code: string; readonly message: string } {
  if (
    code === 'recovery_required' ||
    code === 'thread_busy' ||
    code === 'revision_conflict' ||
    code === 'candidate_conflict'
  ) {
    return {
      code,
      message: 'Preparation requires current candidate and execution-state inspection.',
    };
  }
  if (code === 'invalid_request') {
    return { code, message: 'The Worker environment request is invalid.' };
  }
  if (code === 'not_found') {
    return { code, message: 'The Worker environment is unavailable.' };
  }
  if (code === 'unavailable') {
    return { code, message: 'The Worker environment dependency is unavailable.' };
  }
  if (code === 'workspace_access_denied') {
    return { code, message: 'Workspace access denied.' };
  }
  return {
    code: 'worker_environment_failed',
    message: 'The Worker environment operation failed.',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
