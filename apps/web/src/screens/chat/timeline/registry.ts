import type { ItemType } from '@openkit/protocol';
import type { RegistryRow } from './types';

/**
 * Entry kinds that are not protocol Item types.
 * `assistant-message` and `status` stay the Item rows (final message; error and warning).
 * The earlier-message and info-status rows are separate so each spec row has one disclosure pair.
 */
export const NON_ITEM_ENTRY_KINDS = [
  'assistant-message-earlier',
  'status-info',
  'run-trigger',
  'run-outcome',
  'run-queued',
  'runtime-activity',
  'phase-marker',
  'environment',
  'policy-attribute',
  'thread-event',
  'held-message',
  'digest-line',
] as const;

export type NonItemEntryKind = (typeof NON_ITEM_ENTRY_KINDS)[number];

export type EntryKind = ItemType | NonItemEntryKind;

function row(
  voice: RegistryRow['voice'],
  work: RegistryRow['work'],
  full: RegistryRow['full'],
  compression: RegistryRow['compression'],
  attention: RegistryRow['attention'],
  links: RegistryRow['links'],
  copyKey: RegistryRow['copyKey'],
  produced: boolean
): RegistryRow {
  return { voice, work, full, compression, attention, links, copyKey, produced };
}

/**
 * One row per entry kind. Item types are exhaustive via `satisfies Record<EntryKind, RegistryRow>`.
 * Disclosure values are the two lens columns. Context picks a row; it does not invent a third policy.
 */
export const TIMELINE_REGISTRY = {
  'user-message': row('human', 'shown', 'shown', 'none', 'none', ['none'], 'user-message', true),
  'assistant-message': row(
    'claim',
    'shown',
    'shown',
    'none',
    'none',
    ['none'],
    'assistant-message',
    true
  ),
  'assistant-message-earlier': row(
    'claim',
    'folded',
    'shown',
    'R5',
    'ambient',
    ['none'],
    'assistant-message-earlier',
    true
  ),
  plan: row('claim', 'folded', 'shown', 'R6', 'ambient', ['none'], 'plan', true),
  reasoning: row('process', 'hidden', 'shown', 'none', 'none', ['none'], 'reasoning', true),
  'context-summary': row(
    'derived',
    'hidden',
    'marker',
    'none',
    'none',
    ['inspector'],
    'context-summary',
    true
  ),
  'knowledge-injection': row(
    'fact',
    'folded',
    'row',
    'R7',
    'none',
    ['knowledge'],
    'knowledge-injection',
    true
  ),
  'tool-call': row(
    'process',
    'counted',
    'row',
    'R2-R4',
    'none',
    ['audit-call', 'connection', 'gateway'],
    'tool-call',
    true
  ),
  'command-execution': row(
    'process',
    'counted',
    'row',
    'R2-R4',
    'none',
    ['full-body'],
    'command-execution',
    true
  ),
  'file-change': row('process', 'counted', 'grouped', 'R2', 'none', ['none'], 'file-change', true),
  'artifact-reference': row(
    'output',
    'card',
    'card',
    'none',
    'none',
    ['output-version'],
    'artifact-reference',
    true
  ),
  'approval-request': row(
    'decision',
    'card',
    'card',
    'R8',
    'interrupt-if-blocking',
    ['attention', 'audit-call', 'exact-effect'],
    'approval-request',
    true
  ),
  // TW2: the spec draws the request, the decision, and the disposition as one card.
  'approval-decision': row(
    'decision',
    'card',
    'card',
    'R8',
    'ambient',
    ['attention', 'audit-call'],
    'approval-decision',
    true
  ),
  'user-input-request': row(
    'decision',
    'card',
    'card',
    'R8',
    'interrupt-if-blocking',
    ['attention'],
    'user-input-request',
    true
  ),
  'user-input-response': row(
    'decision',
    'card',
    'card',
    'R8',
    'ambient',
    ['attention'],
    'user-input-response',
    true
  ),
  'agent-handoff': row('fact', 'shown', 'shown', 'none', 'none', ['task'], 'agent-handoff', true),
  status: row('fact', 'shown', 'shown', 'none', 'ambient', ['fix'], 'status', true),
  'status-info': row(
    'fact',
    'conditional',
    'shown',
    'none',
    'none',
    ['knowledge-diff'],
    'status-info',
    true
  ),
  'generative-ui-reference': row(
    'output',
    'shown',
    'shown',
    'none',
    'none',
    ['none'],
    'generative-ui-reference',
    true
  ),
  'run-trigger': row('fact', 'shown', 'shown', 'none', 'none', ['source'], 'run-trigger', true),
  'run-outcome': row(
    'fact',
    'shown',
    'shown',
    'never',
    'interrupt',
    ['audit-run', 'fix'],
    'run-outcome',
    true
  ),
  'run-queued': row(
    'fact',
    'conditional',
    'conditional',
    'none',
    'ambient',
    ['none'],
    'run-queued',
    true
  ),
  'runtime-activity': row(
    'claim',
    'hidden',
    'grouped',
    'none',
    'none',
    ['inspector'],
    'runtime-activity',
    true
  ),
  // TB2: no phase-marker read on thread.dashboard or thread.items.
  'phase-marker': row(
    'claim',
    'hidden',
    'hidden',
    'none',
    'none',
    ['inspector'],
    'phase-marker',
    false
  ),
  // TB4: last sandbox observation is not on today's dashboard.
  environment: row(
    'fact',
    'conditional',
    'shown',
    'none',
    'ambient',
    ['inspector', 'gateway'],
    'environment',
    false
  ),
  // TB7: policy badges need PermissionDecision lineage this read does not carry.
  'policy-attribute': row(
    'fact',
    'hidden',
    'badge',
    'none',
    'none',
    ['audit-call', 'connection'],
    'policy-attribute',
    false
  ),
  // TB2: no thread-event record on today's reads.
  'thread-event': row('fact', 'shown', 'shown', 'none', 'none', ['none'], 'thread-event', false),
  // After v0.1.0. Today's reads have no held message.
  'held-message': row('human', 'shown', 'shown', 'never', 'none', ['none'], 'held-message', false),
  // TB4: the digest is computed by the server.
  'digest-line': row('fact', 'shown', 'shown', 'none', 'none', ['source'], 'digest-line', false),
} as const satisfies Record<EntryKind, RegistryRow>;

/** Registry row for a kind. The `satisfies` clause already requires every kind. */
export function registryRow(kind: EntryKind): RegistryRow {
  return TIMELINE_REGISTRY[kind];
}
