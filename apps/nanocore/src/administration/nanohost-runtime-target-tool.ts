import { ADMINISTRATION_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import type { CoreMode } from '../config/mode.js';
import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import { createOperationInvocation, OperationInvocationError } from '../operation-invocation.js';
import type { CoreDb } from '../storage/db.js';

/** Trusted dependencies for the configured RuntimeTarget read. */
export interface CreateAdministrationNanoHostRuntimeTargetToolInput {
  readonly coreDb: CoreDb | undefined;
  readonly mode: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'>;
  /** Authenticated administrator; never supplied by the model. */
  readonly actor: Actor;
  /** Actual private administration Turn supplied by entry assembly. */
  readonly lineage: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
  };
}

/** Derives the fixed administration read Tool and routes each call through native invocation. */
export function createAdministrationNanoHostRuntimeTargetTool(
  input: CreateAdministrationNanoHostRuntimeTargetToolInput
): AgentTool {
  const id = 'nanohost.runtime-target';
  const definition = ADMINISTRATION_OPERATION_DEFINITIONS[id];
  const invoke = createOperationInvocation(input);
  return {
    name: id,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.inputSchema),
    execute: async (value): Promise<AgentToolResult> => {
      try {
        const output = await invoke(id, value, { kind: 'public', actor: input.actor });
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          details: {
            operationId: id,
            actor: { kind: 'user', id: input.actor.userId },
            ...input.lineage,
          },
        };
      } catch (error) {
        if (!(error instanceof OperationInvocationError)) throw error;
        const code =
          error.code === 'invalid_request' || error.code === 'bound_input_conflict'
            ? 'nanohost_runtime_target_scope_rejected'
            : error.code;
        return {
          content: [{ type: 'text', text: JSON.stringify({ code, message: error.message }) }],
          isError: true,
        };
      }
    },
  };
}
