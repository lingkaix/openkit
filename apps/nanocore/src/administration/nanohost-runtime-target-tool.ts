import type { OpenKitNanoHostConfig } from '@openkit/config-schema';

import type { CoreMode } from '../config/mode.js';
import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from '../runtime/nanohost-runtime-target.js';
import type { CoreDb } from '../storage/db.js';

/** Dependencies for the read-only NanoHost RuntimeTarget administration Tool. */
export interface CreateAdministrationNanoHostRuntimeTargetToolInput {
  /** Open Core database, when server storage is available. */
  readonly coreDb: CoreDb | undefined;
  /** Startup Core mode used by the public RuntimeTarget GET. */
  readonly mode: CoreMode;
  /** Startup NanoHost config used by the public RuntimeTarget GET. */
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'>;
}

/**
 * Creates the empty-input NanoHost RuntimeTarget readiness Tool.
 *
 * @param input Startup mode, config, and storage used by the public observation.
 * @returns One read-only Tool that cannot select a host.
 */
export function createAdministrationNanoHostRuntimeTargetTool(
  input: CreateAdministrationNanoHostRuntimeTargetToolInput
): AgentTool {
  return {
    name: 'nanohost.runtime-target',
    description:
      "Read the configured NanoHost execution-host RuntimeTarget readiness. NanoHost is not an LLM Provider. Input must be an empty object; this Tool cannot select a host, deployment, or scope. The result is Core's stored projection at observedAt, not a live host probe.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    execute: async (value) => observeRuntimeTarget(input, value),
  };
}

/** Returns the shared redacted observation or a typed scope/owner failure. */
function observeRuntimeTarget(
  input: CreateAdministrationNanoHostRuntimeTargetToolInput,
  value: unknown
): AgentToolResult {
  if (!isEmptyObject(value)) {
    return observationFailure(
      'nanohost_runtime_target_scope_rejected',
      'nanohost.runtime-target accepts only an empty object; the model cannot select a host.'
    );
  }
  const observation = readConfiguredNanoHostRuntimeTargetStatus({
    coreDb: input.coreDb,
    mode: input.mode,
    ...(input.nanoHostConfig ? { nanoHostConfig: input.nanoHostConfig } : {}),
  });
  if (!observation.ok) {
    return observationFailure(observation.code, observation.message);
  }
  return { content: [{ type: 'text', text: JSON.stringify(observation.status) }] };
}

/** Rejects any model-selected scope or non-object Tool input. */
function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** Encodes a redacted owner failure for the internal Agent loop. */
function observationFailure(code: string, message: string): AgentToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
    isError: true,
  };
}
