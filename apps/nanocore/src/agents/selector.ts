import type { AgentManifest } from './manifest.js';

/**
 * Workspace-level agent defaults.
 */
export interface AgentSelectionDefaults {
  /** Default agent id stored on the workspace. */
  defaultAgentId?: string | null;
}

/**
 * Per-request agent override.
 */
export interface AgentSelectionOverride {
  /** Explicit agent id requested by the caller. */
  agentId?: string | null;
}

/**
 * Agent selection error.
 */
export interface AgentSelectionError {
  /** Stable error code. */
  code: 'agent_not_found' | 'agent_not_configured';
  /** Human-readable error message. */
  message: string;
}

/**
 * Agent selection result.
 */
export type AgentSelectionResult = AgentManifest | { error: AgentSelectionError };

/**
 * Selects an agent manifest from request override, workspace defaults, or first manifest.
 *
 * @param defaults Workspace-level defaults.
 * @param override Per-request override.
 * @param manifests Available agent manifests.
 * @returns Selected agent manifest or selection error.
 */
export function selectAgent(
  defaults: AgentSelectionDefaults,
  override: AgentSelectionOverride,
  manifests: AgentManifest[]
): AgentSelectionResult {
  const selectedAgentId = override.agentId ?? defaults.defaultAgentId ?? manifests[0]?.id;

  if (!selectedAgentId) {
    return {
      error: {
        code: 'agent_not_configured',
        message: 'No agent manifests are configured.',
      },
    };
  }

  const agent = manifests.find((manifest) => manifest.id === selectedAgentId);

  if (!agent) {
    return {
      error: {
        code: 'agent_not_found',
        message: `Agent manifest not found: ${selectedAgentId}.`,
      },
    };
  }

  return agent;
}
