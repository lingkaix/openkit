import type { AgentSessionStatus } from '@openkit/protocol';

/** Non-terminal AgentSession statuses defined in docs/core/protocol.md. */
export const CURRENT_AGENT_SESSION_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  'created',
  'initializing',
  'ready',
  'busy',
  'idle',
  'degraded',
]);

/** Returns whether one AgentSession status remains current for its Thread. */
export function isCurrentAgentSessionStatus(status: AgentSessionStatus): boolean {
  return CURRENT_AGENT_SESSION_STATUSES.has(status);
}
