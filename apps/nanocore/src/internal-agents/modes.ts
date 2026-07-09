import { QUICK_CHAT_AGENT_ID } from './quick-chat.js';
import { WORKER_COORDINATOR_AGENT_ID } from './tools.js';
import type { InternalAgentMode } from './types.js';

/**
 * Product-facing work modes recognized by NanoCore v0.0.5.
 */
export const OPENKIT_WORK_MODES = [
  'chat',
  'automation',
  'plan',
  'review',
  'organize',
  'delegation',
] as const satisfies readonly InternalAgentMode[];

/**
 * Product work mode name.
 */
export type OpenKitWorkMode = (typeof OPENKIT_WORK_MODES)[number];

/**
 * Internal agent implementation target used in mode routing paths.
 */
export type InternalAgentModePathTarget =
  | 'quick-chat'
  | 'worker-coordinator'
  | 'context-packager'
  | 'task-evaluator'
  | 'knowledge-manager'
  | 'selected-worker';

/**
 * Implementation node kind in a mode routing path.
 */
export type InternalAgentModePathNodeKind = 'internal-agent' | 'worker-runtime';

/**
 * Role played by one implementation node inside a mode path.
 */
export type InternalAgentModePathRole =
  | 'primary'
  | 'routing'
  | 'context'
  | 'execution'
  | 'review'
  | 'knowledge';

/**
 * One explicit implementation node for a product work mode.
 */
export interface InternalAgentModePathNode {
  /** Implementation node kind. */
  readonly kind: InternalAgentModePathNodeKind;
  /** Role this node plays in the user-facing mode. */
  readonly role: InternalAgentModePathRole;
  /** Internal agent id or selected worker runtime placeholder. */
  readonly target: InternalAgentModePathTarget;
}

/**
 * Explicit product-mode to implementation-path mapping.
 */
export const INTERNAL_AGENT_MODE_PATHS = {
  chat: [{ kind: 'internal-agent', role: 'primary', target: QUICK_CHAT_AGENT_ID }],
  automation: [
    { kind: 'internal-agent', role: 'primary', target: WORKER_COORDINATOR_AGENT_ID },
    { kind: 'worker-runtime', role: 'execution', target: 'selected-worker' },
  ],
  plan: [
    { kind: 'internal-agent', role: 'primary', target: 'context-packager' },
    { kind: 'internal-agent', role: 'routing', target: WORKER_COORDINATOR_AGENT_ID },
  ],
  review: [{ kind: 'internal-agent', role: 'primary', target: 'task-evaluator' }],
  organize: [
    { kind: 'internal-agent', role: 'primary', target: 'knowledge-manager' },
    { kind: 'internal-agent', role: 'context', target: 'context-packager' },
  ],
  delegation: [
    { kind: 'internal-agent', role: 'routing', target: WORKER_COORDINATOR_AGENT_ID },
    { kind: 'internal-agent', role: 'context', target: 'context-packager' },
    { kind: 'worker-runtime', role: 'execution', target: 'selected-worker' },
    { kind: 'internal-agent', role: 'review', target: 'task-evaluator' },
    { kind: 'internal-agent', role: 'knowledge', target: 'knowledge-manager' },
  ],
} as const satisfies Record<OpenKitWorkMode, readonly InternalAgentModePathNode[]>;

/**
 * Returns the explicit implementation path for one product work mode.
 *
 * @param mode Product work mode.
 * @returns Implementation path for that mode.
 */
export function getInternalAgentPathForMode(
  mode: OpenKitWorkMode
): readonly InternalAgentModePathNode[] {
  return INTERNAL_AGENT_MODE_PATHS[mode];
}
