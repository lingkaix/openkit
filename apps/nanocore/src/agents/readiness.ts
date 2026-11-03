import type { AgentManifest } from './manifest.js';

/**
 * Agent readiness status.
 */
export type AgentReadinessStatus = 'ready' | 'degraded' | 'blocked' | 'disabled' | 'unknown';

/**
 * Agent readiness result with operator-facing reasons.
 */
export interface AgentReadiness {
  /** Computed readiness status. */
  status: AgentReadinessStatus;
  /** Human-readable reasons for a non-ready state or the stored message of a declared state. */
  reasons: string[];
}

/**
 * Checks whether computed readiness permits worker launch.
 *
 * @param readiness Computed readiness result.
 * @returns True only for ready Agents.
 */
export function isAgentLaunchable(readiness: AgentReadiness): boolean {
  return readiness.status === 'ready';
}

/**
 * Computes agent readiness from manifest dependencies and provider registry state.
 *
 * A declared `ready` status reports its stored message, so projections that read
 * only reasons can name the proving evidence behind a ready Agent.
 *
 * @param manifest Agent manifest to evaluate.
 * @returns Agent readiness result.
 */
export function computeReadiness(manifest: AgentManifest): AgentReadiness {
  const declaredReadiness = manifest.readiness;
  if (
    declaredReadiness?.status === 'disabled' ||
    declaredReadiness?.status === 'blocked' ||
    declaredReadiness?.status === 'unknown'
  ) {
    return {
      reasons: declaredReadiness.message
        ? [declaredReadiness.message]
        : declaredReadiness.status === 'disabled'
          ? ['Agent is disabled.']
          : [],
      status: declaredReadiness.status,
    };
  }

  if (declaredReadiness?.status) {
    return {
      reasons: declaredReadiness.message ? [declaredReadiness.message] : [],
      status: declaredReadiness.status,
    };
  }

  return { reasons: [], status: 'ready' };
}
