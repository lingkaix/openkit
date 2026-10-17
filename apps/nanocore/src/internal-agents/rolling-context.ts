import { createHash } from 'node:crypto';
import type { Item } from '@openkit/protocol';
import { deriveEntityId } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import { assertInternalAgentContextFits } from './gateway-provider.js';
import {
  type AgentMessage,
  type AgentTool,
  type InternalAgentLogicalModel,
  type InternalAgentLoopInput,
  type InternalAgentProviderCall,
  InternalAgentProviderError,
  raceWithSignal,
} from './internal-agent-loop.js';
import { redactInternalAgentText } from './redaction.js';

type Turn = ReturnType<FsStore['getTurnById']>;
type Summary = Extract<Item, { type: 'context-summary' }>;

/** Inputs of the shared assembler; the existing role owns admission, source authority and Provider dispatch. */
export interface InternalAgentContextInput {
  readonly store: FsStore;
  readonly turn: Turn;
  readonly systemPrompt: string;
  /** Existing admitted resource/configuration facts, without credentials or provider-private state. */
  readonly environmentFacts?: unknown;
  readonly tools: readonly AgentTool[];
  readonly model: InternalAgentLogicalModel;
  readonly bounds: {
    readonly context: number | null | undefined;
    readonly output: number | null | undefined;
  };
  readonly requiredMessages: readonly AgentMessage[];
  /** Fixed admitted resource metadata stays before historical context on every dispatch. */
  readonly prefixMessages?: readonly AgentMessage[];
  readonly limits: InternalAgentLoopInput['limits'];
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  /** Verifies current dependent sources and returns the sorted canonical retrieval-evidence inventory digest. */
  readonly readEvidence: (items: readonly Item[]) => string;
  readonly callProvider: InternalAgentProviderCall;
}

/** A transient admitted window; all durable truth remains in the existing Items and effect owners. */
export interface InternalAgentContext {
  readonly messages: readonly AgentMessage[];
  readonly limits: InternalAgentLoopInput['limits'];
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

/** Hashes a normalized known canonical representation without allocating a record identity. */
export function internalContextDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Derives stable Thread history using Turn order and the canonical first-seen per-Turn Item sequence. */
export function internalContextItems(store: Pick<FsStore, 'listThreadTurns'>, turn: Turn): Item[] {
  return store
    .listThreadTurns(turn.workspaceId, turn.threadId)
    .filter((candidate) => candidate.id !== turn.id)
    .sort(
      (left, right) =>
        (left.startedAt ?? '').localeCompare(right.startedAt ?? '') || compare(left.id, right.id)
    )
    .flatMap((candidate) =>
      candidate.items.filter(
        (item) =>
          item.type !== 'reasoning' &&
          item.type !== 'context-summary' &&
          ((item.type !== 'assistant-message' && item.type !== 'user-message') ||
            item.status === 'completed')
      )
    );
}

/** Binds canonical source Items; only cross-run rolling history also binds terminal Turn outcomes. */
export function internalContextSourceDigest(
  store: Pick<FsStore, 'getTurnById'>,
  items: readonly Item[],
  strategy: Summary['strategy'] = 'rolling'
): string {
  if (strategy === 'compaction') return internalContextDigest({ version: 1, sources: items });
  return internalContextDigest({
    version: 1,
    sources: items.map((item) => {
      const turn = store.getTurnById(item.turnId);
      return { item, turnOutcome: { status: turn.status, error: turn.error } };
    }),
  });
}

/** Exact visible body whose digest binds history search and range-read evidence. */
export function internalContextHistoryBody(item: Item): string {
  return item.type === 'user-message' || item.type === 'assistant-message'
    ? item.text
    : redactInternalAgentText(JSON.stringify(item));
}

/** Projects accepted history as inert observations; Tool records never execute or acquire instruction authority. */
export function internalContextMessage(item: Item): AgentMessage {
  const text =
    item.type === 'user-message' || item.type === 'assistant-message'
      ? redactInternalAgentText(item.text)
      : `<retained_item>${redactInternalAgentText(JSON.stringify(item))}</retained_item>`;
  return item.type === 'assistant-message'
    ? { role: 'assistant', content: [{ type: 'text', text }], truncated: false }
    : { role: 'user', content: [{ type: 'text', text }] };
}

/** Keeps canonical failure and interruption outcomes beside their exact source Items. */
function contextMessages(
  store: Pick<FsStore, 'getTurnById'>,
  items: readonly Item[]
): AgentMessage[] {
  const observedTurns = new Set<string>();
  return items.flatMap((item) => {
    const messages = [internalContextMessage(item)];
    const turn = store.getTurnById(item.turnId);
    if (!observedTurns.has(turn.id) && (turn.status !== 'completed' || turn.error)) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<retained_turn_outcome>${redactInternalAgentText(JSON.stringify({ turnId: turn.id, status: turn.status, error: turn.error }))}</retained_turn_outcome>`,
          },
        ],
      });
    }
    observedTurns.add(turn.id);
    return messages;
  });
}

/**
 * Reconstructs one bounded internal-role window from canonical history and verified summary Items.
 *
 * Capacity pressure may require several whole-prefix summary batches for retained unbounded history. Each batch uses the caller's ordinary Provider, fixed environment and remaining run budget. Only complete source-verified output becomes an Item; failures do not advance that batch. No Tool closure executes during summary production.
 *
 * @param input Existing role owner, physical fitting bounds and exact fresh required input.
 * @returns Window, remaining fuses and a current-source publication guard for the ordinary loop.
 * @throws InternalAgentProviderError for unsafe capacity, invalid summary output or deadline exhaustion; original source and Provider failures otherwise remain visible.
 */
export async function prepareInternalAgentContext(
  input: InternalAgentContextInput
): Promise<InternalAgentContext> {
  if (
    input.turn.agentSessionId ||
    ![
      'quick-chat',
      'assistant',
      'administration',
      'knowledge-manager',
      'goal-coordinator',
      'goal-orchestrator',
    ].includes(input.turn.agentId ?? '')
  )
    throw capacity();
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(input.limits.deadlineMs);
  const signal = AbortSignal.any([input.signal, deadline]);
  const environmentDigest = internalContextDigest({
    version: 1,
    strategy: 'rolling',
    systemPrompt: input.systemPrompt,
    tools: input.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    model: input.model,
    environmentFacts: input.environmentFacts,
  });
  const items = structuredClone(internalContextItems(input.store, input.turn));
  const sourceDigest = (sources: readonly Item[]) =>
    internalContextSourceDigest(input.store, sources);
  const originalSourceDigest = sourceDigest(items);
  let originalEvidenceDigest: string;
  try {
    input.assertCurrent();
    originalEvidenceDigest = input.readEvidence(items);
  } catch {
    throw capacity();
  }
  const assertDeadline = () => {
    if (signal.aborted || Date.now() - startedAt >= input.limits.deadlineMs) {
      if (input.signal.aborted) throw input.signal.reason;
      throw new InternalAgentProviderError(
        'internal_agent_context_deadline',
        'Internal Agent deadline elapsed.'
      );
    }
  };
  const assertCurrent = () => {
    assertDeadline();
    input.assertCurrent();
    const current = internalContextItems(input.store, input.turn);
    if (
      sourceDigest(current) !== originalSourceDigest ||
      input.readEvidence(current) !== originalEvidenceDigest
    )
      throw capacity();
    assertDeadline();
  };
  const fits = (messages: readonly AgentMessage[]) => {
    try {
      assertInternalAgentContextFits(
        { systemPrompt: input.systemPrompt, messages, tools: input.tools },
        input.bounds.context ?? undefined,
        input.bounds.output ?? undefined
      );
      return true;
    } catch (error) {
      if (
        error instanceof InternalAgentProviderError &&
        error.code === 'internal_agent_context_exceeded'
      )
        return false;
      throw error;
    }
  };
  const allSummaries = input.store
    .listThreadItems(input.turn.workspaceId, input.turn.threadId)
    .filter((item): item is Summary => item.type === 'context-summary');
  const summaries = new Map(allSummaries.map((item) => [item.id, item]));
  const validSummary = (summary: Summary, seen = new Set<string>()): boolean => {
    if (seen.has(summary.id)) return false;
    seen.add(summary.id);
    const producer = input.store.getTurnById(summary.turnId);
    const range = items.slice(0, summary.sourceRange.itemCount);
    if (
      summary.strategy !== 'rolling' ||
      summary.logicalModelId !== input.model.logicalModelId ||
      producer.agentSessionId ||
      producer.agentId !== input.turn.agentId ||
      summary.environmentDigest !== environmentDigest ||
      range.length !== summary.sourceRange.itemCount ||
      range[0]?.id !== summary.sourceRange.firstItemId ||
      range.at(-1)?.id !== summary.sourceRange.lastItemId ||
      sourceDigest(range) !== summary.sourceRange.sourceDigest ||
      input.readEvidence(range) !== summary.sourceRange.evidenceDigest
    )
      return false;
    if (summary.previousSummary) {
      const previous = summaries.get(summary.previousSummary.itemId);
      if (
        !previous ||
        internalContextDigest(previous) !== summary.previousSummary.digest ||
        previous.sourceRange.itemCount >= summary.sourceRange.itemCount ||
        !validSummary(previous, seen)
      )
        return false;
    }
    return true;
  };
  let summary: Summary | undefined;
  let boundary = 0;
  let usedModelTurns = 0;
  const assemble = () => [
    ...(input.prefixMessages ?? []),
    ...(summary ? [internalContextSummaryMessage(summary)] : []),
    ...contextMessages(input.store, items.slice(boundary)),
    ...input.requiredMessages,
  ];
  if (!fits(assemble())) {
    summary = allSummaries.sort(
      (left, right) =>
        right.sourceRange.itemCount - left.sourceRange.itemCount ||
        right.createdAt.localeCompare(left.createdAt) ||
        compare(right.id, left.id)
    )[0];
    if (summary) {
      try {
        if (!validSummary(summary)) throw capacity();
      } catch {
        throw capacity();
      }
      boundary = summary.sourceRange.itemCount;
    }
  }
  while (!fits(assemble())) {
    assertCurrent();
    if (
      usedModelTurns >= input.limits.maxModelTurns - 1 ||
      boundary >= items.length ||
      !fits([
        ...(input.prefixMessages ?? []),
        { role: 'assistant', content: [{ type: 'text', text: 'Continuation.' }], truncated: false },
        ...input.requiredMessages,
      ])
    )
      throw capacity();
    const requestFor = (end: number): AgentMessage[] => [
      ...(input.prefixMessages ?? []),
      ...(summary ? [internalContextSummaryMessage(summary)] : []),
      ...contextMessages(input.store, items.slice(boundary, end)),
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<openkit_context_summary_task>${JSON.stringify({
              firstItemId: items[0]!.id,
              lastItemId: items[end - 1]!.id,
              itemCount: end,
              maximumSummaryBytes: 65_536,
            })}</openkit_context_summary_task>`,
          },
        ],
      },
    ];
    // Serialized request size is monotonic for these whole-source prefixes.
    let low = boundary + 1;
    let high = items.length;
    let end = boundary;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      if (fits(requestFor(candidate))) {
        end = candidate;
        low = candidate + 1;
      } else high = candidate - 1;
    }
    if (end === boundary) throw capacity();
    const messages = requestFor(end);
    const beforeBytes = Buffer.byteLength(
      JSON.stringify([
        ...(summary ? [internalContextSummaryMessage(summary)] : []),
        ...contextMessages(input.store, items.slice(boundary, end)),
      ])
    );
    assertCurrent();
    const response = await raceWithSignal(
      input.callProvider({
        systemPrompt: input.systemPrompt,
        messages,
        tools: input.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
        model: input.model,
        signal,
      }),
      signal
    ).catch((error: unknown) => {
      if (deadline.aborted && !input.signal.aborted)
        throw new InternalAgentProviderError(
          'internal_agent_context_deadline',
          'Internal Agent deadline elapsed.'
        );
      throw error;
    });
    usedModelTurns += 1;
    assertCurrent();
    const message = response.message;
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    if (
      message.truncated ||
      message.role !== 'assistant' ||
      message.content.some((part) => part.type !== 'text') ||
      !text.trim() ||
      text.trim() === '<context_capacity_failure/>' ||
      Buffer.byteLength(text) > 65_536 ||
      redactInternalAgentText(text) !== text
    )
      throw invalidSummary();
    const prefix = items.slice(0, end);
    const sourceRange = {
      firstItemId: prefix[0]!.id,
      lastItemId: prefix.at(-1)!.id,
      itemCount: prefix.length,
      sourceDigest: sourceDigest(prefix),
      evidenceDigest: input.readEvidence(prefix),
    };
    const completedAt = new Date().toISOString();
    const next: Summary = {
      id: deriveEntityId('it', {
        kind: 'internal-context-summary',
        turnId: input.turn.id,
        environmentDigest,
        sourceRange,
      }),
      workspaceId: input.turn.workspaceId,
      threadId: input.turn.threadId,
      turnId: input.turn.id,
      type: 'context-summary',
      strategy: 'rolling',
      logicalModelId: input.model.logicalModelId,
      status: 'completed',
      text,
      environmentDigest,
      sourceRange,
      ...(summary
        ? { previousSummary: { itemId: summary.id, digest: internalContextDigest(summary) } }
        : {}),
      createdAt: completedAt,
      completedAt,
    };
    if (Buffer.byteLength(JSON.stringify([internalContextSummaryMessage(next)])) >= beforeBytes)
      throw invalidSummary();
    assertCurrent();
    const stored = input.store.createItem(next);
    if (stored.type !== 'context-summary') throw invalidSummary();
    summaries.set(stored.id, stored);
    summary = stored;
    boundary = end;
  }
  assertCurrent();
  return {
    messages: assemble(),
    limits: {
      ...input.limits,
      maxModelTurns: input.limits.maxModelTurns - usedModelTurns,
      deadlineMs: Math.max(1, input.limits.deadlineMs - (Date.now() - startedAt)),
    },
    signal,
    assertCurrent,
  };
}

/** Range annotation remains model-visible untrusted context and gives exact history retrieval endpoints. */
export function internalContextSummaryMessage(summary: Summary): AgentMessage {
  return {
    role: 'assistant',
    truncated: false,
    content: [
      {
        type: 'text',
        text: `<context_summary>${JSON.stringify({
          summaryItemId: summary.id,
          workspaceId: summary.workspaceId,
          threadId: summary.threadId,
          strategy: summary.strategy,
          logicalModelId: summary.logicalModelId,
          sourceRange: summary.sourceRange,
          text: summary.text,
          exactHistory:
            'Use thread.history.read with this source range to retrieve original Items.',
        })}</context_summary>`,
      },
    ],
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function capacity(): InternalAgentProviderError {
  return new InternalAgentProviderError(
    'internal_agent_context_exceeded',
    'Required internal Agent history cannot fit with verified source continuity.'
  );
}
function invalidSummary(): InternalAgentProviderError {
  return new InternalAgentProviderError(
    'internal_agent_summary_invalid',
    'The continuation summary was incomplete or did not reduce the verified window.'
  );
}

/** Projects only closed context failures into existing durable Turn diagnostics. */
export function internalContextFailure(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof InternalAgentProviderError)) return null;
  const messages: Record<string, string> = {
    internal_agent_context_exceeded: 'Required history cannot fit with verified source continuity.',
    internal_agent_context_unavailable: 'The selected model has no usable context bounds.',
    internal_agent_summary_invalid:
      'Continuation summary production failed. Its source boundary did not advance.',
    internal_agent_model_turns_exceeded:
      'The admitted model-call budget expired before a bounded answer could complete.',
    internal_agent_context_deadline:
      'The admitted deadline expired during continuation summary production.',
  };
  const message = messages[error.code];
  return message ? { code: error.code, message } : null;
}
