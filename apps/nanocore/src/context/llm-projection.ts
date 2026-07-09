import { createHash } from 'node:crypto';
import type { ItemSchema } from '@openkit/protocol';
import type { z } from 'zod';

import type { OpenAICompatibleChatMessage } from '../llm/openai-compatible-client.js';
import {
  classifyLlmProjectionItemCategory,
  createLlmProjectionPolicyDecision,
  type LlmProjectionExclusionReason,
  type LlmProjectionItemCategory,
  type LlmProjectionOutcome,
  type LlmProjectionPolicy,
  type LlmProjectionPolicyDecision,
  projectionOutcomeRequiresExclusionReason,
} from './projection-policy.js';

type Item = z.infer<typeof ItemSchema>;

/**
 * Provider-visible projection result produced from durable item history.
 */
export interface LlmProjectionResult {
  /** Projection policy version used for this context package. */
  readonly policyVersion: LlmProjectionPolicy['version'];
  /** Deterministic digest for the provider-visible context package. */
  readonly contextPackageDigest: string;
  /** Provider-ready messages generated from visible or summarized items. */
  readonly providerMessages: readonly OpenAICompatibleChatMessage[];
  /** Durable item ids included in provider-visible context. */
  readonly includedItemIds: readonly string[];
  /** Durable items excluded from provider-visible context with policy reasons. */
  readonly excludedItems: readonly LlmProjectionPolicyDecision[];
  /** Policy decisions for every input item in order. */
  readonly decisions: readonly LlmProjectionPolicyDecision[];
}

/**
 * Supported record attachment targets for projected context packages.
 */
export type ContextPackageAttachmentTargetKind = 'internal-agent' | 'worker-turn';

/**
 * Target record that may reference a context package digest.
 */
export interface ContextPackageAttachmentTarget {
  /** App-local record type that owns the context package reference. */
  readonly targetKind: ContextPackageAttachmentTargetKind;
  /** App-local target record id. */
  readonly targetId: string;
}

/**
 * Durable context package record shape for projected LLM context.
 */
export interface ContextPackageRecord extends ContextPackageAttachmentTarget {
  /** Deterministic context package digest. */
  readonly digest: string;
  /** Projection policy version used for the package. */
  readonly policyVersion: LlmProjectionPolicy['version'];
  /** Durable item ids included in provider-visible context. */
  readonly includedItemIds: readonly string[];
  /** Durable item ids excluded from provider-visible context. */
  readonly excludedItemIds: readonly string[];
}

/**
 * Projects durable OpenKit item history into provider-visible LLM messages.
 *
 * @param items Durable thread item history in chronological order.
 * @param policy Projection policy that separates model-visible, summarized, elided, and UI-only items.
 * @returns Provider-visible messages plus inclusion and exclusion records.
 */
export function convertToLlm(
  items: readonly Item[],
  policy: LlmProjectionPolicy
): LlmProjectionResult {
  const providerMessages: OpenAICompatibleChatMessage[] = [];
  const includedItemIds: string[] = [];
  const excludedItems: LlmProjectionPolicyDecision[] = [];
  const decisions: LlmProjectionPolicyDecision[] = [];

  for (const item of items) {
    const category = classifyLlmProjectionItemCategory(item.type);
    const outcome = resolveProjectionOutcome(policy, item.type, category);
    const decision = createLlmProjectionPolicyDecision({
      itemId: item.id,
      itemType: item.type,
      outcome,
      ...(projectionOutcomeRequiresExclusionReason(outcome)
        ? { exclusionReason: defaultExclusionReason(category, outcome) }
        : {}),
    });

    decisions.push(decision);

    if (outcome === 'model-visible' || outcome === 'summarized') {
      providerMessages.push(projectItemToProviderMessage(item, outcome));
      includedItemIds.push(item.id);
    } else {
      excludedItems.push(decision);
    }
  }

  const contextPackageDigest = createContextPackageDigest({
    policyVersion: policy.version,
    providerMessages,
    includedItemIds,
    excludedItems,
  });

  return {
    policyVersion: policy.version,
    contextPackageDigest,
    providerMessages,
    includedItemIds,
    excludedItems,
    decisions,
  };
}

/**
 * Creates a durable context package record from a projection result.
 *
 * @param result Projection result with digest and item id lists.
 * @param target Target record that should reference this context package.
 * @returns Context package record ready for app-local storage.
 */
export function createContextPackageRecord(
  result: LlmProjectionResult,
  target: ContextPackageAttachmentTarget
): ContextPackageRecord {
  return {
    digest: result.contextPackageDigest,
    policyVersion: result.policyVersion,
    includedItemIds: [...result.includedItemIds],
    excludedItemIds: result.excludedItems.map((item) => item.itemId),
    targetKind: target.targetKind,
    targetId: target.targetId,
  };
}

/**
 * Creates a deterministic SHA-256 digest for a projected context package.
 *
 * @param value Context package value to hash.
 * @returns Prefixed context package digest.
 */
function createContextPackageDigest(value: unknown): string {
  return `ctxpkg_sha256_${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

/**
 * Serializes JSON-like data with stable object key ordering.
 *
 * @param value Value to serialize.
 * @returns Deterministic JSON string.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

/**
 * Resolves the projection outcome for one item from policy overrides.
 *
 * @param policy Projection policy to apply.
 * @param itemType Durable item type.
 * @param category Derived projection category.
 * @returns Projection outcome selected for the item.
 */
function resolveProjectionOutcome(
  policy: LlmProjectionPolicy,
  itemType: Item['type'],
  category: LlmProjectionItemCategory
): LlmProjectionOutcome {
  return (
    policy.itemTypeOutcomes?.[itemType] ??
    policy.categoryOutcomes?.[category] ??
    policy.defaultOutcome
  );
}

/**
 * Chooses a stable exclusion reason for one excluding policy decision.
 *
 * @param category Projection category being excluded.
 * @param outcome Excluding projection outcome.
 * @returns Stable exclusion reason.
 */
function defaultExclusionReason(
  category: LlmProjectionItemCategory,
  outcome: LlmProjectionOutcome
): LlmProjectionExclusionReason {
  if (outcome === 'ui-only') {
    if (category === 'diagnostic') {
      return 'diagnostic_noise';
    }
    return 'ui_only';
  }
  if (category === 'artifact') {
    return 'artifact_pointer';
  }
  if (category === 'approval') {
    return 'approval_gate';
  }
  if (category === 'goal') {
    return 'goal_state_not_needed';
  }
  if (category === 'review') {
    return 'review_context_not_needed';
  }

  return 'policy_excluded';
}

/**
 * Converts one included item into a provider-visible message.
 *
 * @param item Durable item to project.
 * @param outcome Projection outcome selected for the item.
 * @returns Provider-compatible chat message.
 */
function projectItemToProviderMessage(
  item: Item,
  outcome: Extract<LlmProjectionOutcome, 'model-visible' | 'summarized'>
): OpenAICompatibleChatMessage {
  if (outcome === 'model-visible') {
    if (item.type === 'user-message') {
      return { role: 'user', content: item.text };
    }
    if (item.type === 'assistant-message') {
      return { role: 'assistant', content: item.text };
    }
  }

  return { role: 'developer', content: summarizeItemForProvider(item) };
}

/**
 * Creates provider-visible summary text for one non-message item.
 *
 * @param item Durable item to summarize.
 * @returns Provider-visible summary text.
 */
function summarizeItemForProvider(item: Item): string {
  switch (item.type) {
    case 'user-message':
      return `User message ${item.id}:\n${item.text}`;
    case 'assistant-message':
      return `Assistant message ${item.id}:\n${item.text}`;
    case 'reasoning':
      return joinNonEmpty([`Review ${item.id}:`, ...item.summary, ...item.content]);
    case 'artifact-reference':
      return joinNonEmpty([`Artifact ${item.artifactId}: ${item.title}`, item.summary ?? null]);
    case 'command-execution':
      return joinNonEmpty([
        `Command ${item.id}: ${item.command}`,
        `cwd: ${item.cwd}`,
        item.output,
        item.exitCode === null ? null : `exitCode: ${item.exitCode}`,
      ]);
    case 'approval-request':
      return joinNonEmpty([
        `Approval required ${item.approvalRequestId}: ${item.title}`,
        item.description,
      ]);
    case 'approval-decision':
      return `Approval decision ${item.approvalRequestId}: ${item.decision}`;
    case 'user-input-request':
      return joinNonEmpty([
        `User input requested ${item.userInputRequestId}:`,
        item.prompt,
        ...item.questions.map((question) => question.question),
      ]);
    case 'user-input-response':
      return joinNonEmpty([
        `User input response ${item.userInputRequestId}:`,
        JSON.stringify(item.answers),
      ]);
    case 'file-change':
      return `File change ${item.changeKind}: ${item.path}`;
    case 'tool-call':
      return joinNonEmpty([
        `Tool call ${item.tool}`,
        item.server ? `server: ${item.server}` : null,
        item.result,
        item.error ? `error: ${item.error}` : null,
      ]);
    case 'agent-handoff':
      return joinNonEmpty([`Agent handoff ${item.fromAgentId} -> ${item.toAgentId}`, item.reason]);
    case 'status':
      return joinNonEmpty([`Status ${item.level}: ${item.title}`, item.summary]);
    case 'plan':
      return joinNonEmpty([
        `Goal ${item.id}: ${item.title}`,
        item.summary,
        ...item.steps.map((step) => `- ${step.title}: ${step.status}`),
      ]);
    case 'knowledge-injection':
      return joinNonEmpty([
        `Knowledge injection ${item.id}:`,
        item.summary,
        item.policySummary,
        `knowledgeEntryIds: ${item.knowledgeEntryIds.join(', ')}`,
      ]);
    default:
      return assertNever(item);
  }
}

/**
 * Joins non-empty summary lines with newlines.
 *
 * @param lines Summary lines that may include null, undefined, or empty values.
 * @returns Newline-delimited summary.
 */
function joinNonEmpty(lines: readonly (string | null | undefined)[]): string {
  return lines.filter((line): line is string => Boolean(line?.trim())).join('\n');
}

/**
 * Fails compilation when a new protocol item type is not handled.
 *
 * @param value Unreachable item value.
 * @returns Never returns.
 */
function assertNever(value: never): never {
  throw new Error(`Unsupported projection item: ${JSON.stringify(value)}`);
}
