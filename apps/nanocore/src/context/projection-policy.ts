import type { ItemType } from '@openkit/protocol';

/**
 * Current app-local projection policy version.
 */
export const LLM_PROJECTION_POLICY_VERSION = 1;

/**
 * Outcomes a projection policy may assign to one durable item.
 */
export const LLM_PROJECTION_OUTCOMES = [
  'model-visible',
  'summarized',
  'elided',
  'ui-only',
] as const;

/**
 * App-local item categories used by context projection policy.
 */
export const LLM_PROJECTION_ITEM_CATEGORIES = [
  'user',
  'assistant',
  'artifact',
  'approval',
  'diagnostic',
  'review',
  'goal',
  'tool',
  'knowledge',
  'handoff',
  'file-change',
] as const;

/**
 * Reasons an item may be excluded from provider-visible context.
 */
export const LLM_PROJECTION_EXCLUSION_REASONS = [
  'policy_excluded',
  'ui_only',
  'diagnostic_noise',
  'artifact_pointer',
  'approval_gate',
  'goal_state_not_needed',
  'review_context_not_needed',
  'empty_content',
  'sensitive_content',
  'unsupported_item_type',
] as const;

/**
 * Model-visible context outcome for one durable item.
 */
export type LlmProjectionOutcome = (typeof LLM_PROJECTION_OUTCOMES)[number];

/**
 * Projection category assigned to one durable item.
 */
export type LlmProjectionItemCategory = (typeof LLM_PROJECTION_ITEM_CATEGORIES)[number];

/**
 * Stable reason for excluding an item from provider-visible context.
 */
export type LlmProjectionExclusionReason = (typeof LLM_PROJECTION_EXCLUSION_REASONS)[number];

/**
 * Versioned app-local policy used by future item-to-LLM projection.
 */
export interface LlmProjectionPolicy {
  /** Policy version used to compare context package records over time. */
  readonly version: typeof LLM_PROJECTION_POLICY_VERSION;
  /** Default outcome when no item or category override applies. */
  readonly defaultOutcome: LlmProjectionOutcome;
  /** Optional category-level outcome overrides. */
  readonly categoryOutcomes?: Partial<Record<LlmProjectionItemCategory, LlmProjectionOutcome>>;
  /** Optional item-type-level outcome overrides. */
  readonly itemTypeOutcomes?: Partial<Record<ItemType, LlmProjectionOutcome>>;
}

/**
 * Input used to create one projection policy decision.
 */
export interface LlmProjectionPolicyDecisionInput {
  /** Durable item id from the thread log. */
  readonly itemId: string;
  /** Durable item type from the protocol item union. */
  readonly itemType: ItemType;
  /** Projection outcome selected for the item. */
  readonly outcome: LlmProjectionOutcome;
  /** Optional exclusion reason required for elided and UI-only outcomes. */
  readonly exclusionReason?: LlmProjectionExclusionReason;
}

/**
 * Recorded projection policy decision for one durable item.
 */
export interface LlmProjectionPolicyDecision {
  /** Durable item id from the thread log. */
  readonly itemId: string;
  /** Durable item type from the protocol item union. */
  readonly itemType: ItemType;
  /** Projection category derived from the item type. */
  readonly category: LlmProjectionItemCategory;
  /** Projection outcome selected for the item. */
  readonly outcome: LlmProjectionOutcome;
  /** Stable reason for excluding the item when required by the outcome. */
  readonly exclusionReason?: LlmProjectionExclusionReason;
}

const ITEM_TYPE_CATEGORY_MAP = {
  'user-message': 'user',
  'assistant-message': 'assistant',
  reasoning: 'review',
  'artifact-reference': 'artifact',
  'command-execution': 'diagnostic',
  'approval-request': 'approval',
  'approval-decision': 'approval',
  'user-input-request': 'approval',
  'user-input-response': 'user',
  'file-change': 'file-change',
  'tool-call': 'diagnostic',
  'agent-handoff': 'handoff',
  status: 'diagnostic',
  plan: 'goal',
  'knowledge-injection': 'knowledge',
} as const satisfies Record<ItemType, LlmProjectionItemCategory>;

/**
 * Classifies one durable item type into the app-local projection category set.
 *
 * @param itemType Durable item type from the protocol item union.
 * @returns Projection category used by context policies.
 */
export function classifyLlmProjectionItemCategory(itemType: ItemType): LlmProjectionItemCategory {
  return ITEM_TYPE_CATEGORY_MAP[itemType];
}

/**
 * Checks whether a projection outcome must carry an exclusion reason.
 *
 * @param outcome Projection outcome to inspect.
 * @returns True when the outcome excludes provider-visible item content.
 */
export function projectionOutcomeRequiresExclusionReason(outcome: LlmProjectionOutcome): boolean {
  return outcome === 'elided' || outcome === 'ui-only';
}

/**
 * Creates a recorded projection policy decision with required category and reason fields.
 *
 * @param input Policy decision input for one durable item.
 * @returns Normalized policy decision with a derived category.
 * @throws Error when an excluding outcome omits an exclusion reason.
 */
export function createLlmProjectionPolicyDecision(
  input: LlmProjectionPolicyDecisionInput
): LlmProjectionPolicyDecision {
  if (projectionOutcomeRequiresExclusionReason(input.outcome) && !input.exclusionReason) {
    throw new Error(`Projection outcome ${input.outcome} requires an exclusion reason.`);
  }

  return {
    itemId: input.itemId,
    itemType: input.itemType,
    category: classifyLlmProjectionItemCategory(input.itemType),
    outcome: input.outcome,
    ...(input.exclusionReason ? { exclusionReason: input.exclusionReason } : {}),
  };
}
