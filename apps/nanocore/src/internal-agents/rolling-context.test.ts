import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Item } from '@openkit/protocol';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import {
  type AgentMessage,
  type AgentTool,
  InternalAgentProviderError,
  type InternalAgentProviderRequest,
  type InternalAgentProviderResponse,
  runInternalAgentLoop,
} from './internal-agent-loop.js';
import { internalContextFailure, prepareInternalAgentContext } from './rolling-context.js';

type Turn = ReturnType<FsStore['getTurnById']>;
const roots: string[] = [];
const itemIdsByTurn = new Map<string, string[]>();
const timestamp = '2026-10-16T00:00:00.000Z';
// A single Turn fits, while four/eight-Turn histories still require advancing summary batches.
const contextLimit = 7_000;
const outputReserve = 512;
const summaryText =
  'Keep the deployment constraint. Decision is pending. Exact sources remain in history.';
const model = {
  logicalModelId: 'internal-role',
  modelFamilyId: null,
  capabilities: ['responses', 'tool-calling'],
};
const limits = { maxModelTurns: 40, maxToolCalls: 3, deadlineMs: 10_000 };
const currentMessage: AgentMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'Continue the pending decision with the deployment constraint.' },
  ],
};

afterEach(() => {
  itemIdsByTurn.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses real canonical records with equal timestamps and deliberately reverse-sorted Item ids. */
function fixture(historyTurns = 8, durable = false, failedSource = false) {
  const dataRoot = durable ? mkdtempSync(join(tmpdir(), 'internal-rolling-context-')) : '';
  if (dataRoot) roots.push(dataRoot);
  vi.stubEnv('OPENKIT_DATA_ROOT', '');
  const store = new FsStore(dataRoot ? { dataRoot } : {});
  const workspace = store.createWorkspace('Rolling context');
  const thread = store.createThread(workspace.id, 'Conversation', undefined, 'conversation', {
    visibility: 'private',
    privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const history: Item[] = [];
  for (let index = 0; index < historyTurns; index += 1) {
    const turn = admitTurn(store, workspace.id, thread.id);
    history.push(
      messageItem(store, turn, 'user-message', `Question ${index}: ${'q'.repeat(1_200)}`)
    );
    history.push(
      messageItem(store, turn, 'assistant-message', `Decision ${index}: ${'a'.repeat(1_200)}`)
    );
    store.updateTurn(turn.id, {
      status: failedSource ? 'failed' : 'completed',
      completedAt: timestamp,
      error: failedSource
        ? { code: 'source_work_failed', message: 'The source work needs a new explicit request.' }
        : null,
    });
  }
  const turn = admitTurn(store, workspace.id, thread.id);
  messageItem(
    store,
    turn,
    'user-message',
    currentMessage.content[0]!.type === 'text' ? currentMessage.content[0]!.text : 'Continue.'
  );
  return { dataRoot, store, workspace, thread, history, turn };
}

/** Creates an admitted internal Turn through the existing owner. */
function admitTurn(store: FsStore, workspaceId: string, threadId: string) {
  return store.createTurn(
    workspaceId,
    threadId,
    'Continue.',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    {
      agentId: 'quick-chat',
      executorKind: 'assistant',
      startedAt: new Date(
        Date.parse(timestamp) + store.listThreadTurns(workspaceId, threadId).length
      ).toISOString(),
    }
  );
}

/** Publishes one accepted message without inventing an identifier format. */
function messageItem(
  store: FsStore,
  turn: Turn,
  type: 'user-message' | 'assistant-message',
  text: string
) {
  const identities =
    itemIdsByTurn.get(turn.id) ?? [allocateEntityId('it'), allocateEntityId('it')].sort();
  itemIdsByTurn.set(turn.id, identities);
  return store.createItem({
    id: identities[type === 'user-message' ? 1 : 0]!,
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type,
    text,
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
    ...(type === 'user-message'
      ? { actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' } }
      : {}),
  } as Item);
}

/** Supplies a deterministic external Provider result; it does not simulate a product owner. */
function response(text = summaryText): InternalAgentProviderResponse {
  return { message: { role: 'assistant', content: [{ type: 'text', text }], truncated: false } };
}

/** Represents current dependent-source evidence admitted by the caller. */
function evidence(items: readonly Item[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(items.map((item) => item.id)))
    .digest('hex')}`;
}

/** Assembles through the public private-module seam with replaceable dependency faults. */
function input(
  f: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof prepareInternalAgentContext>[0]> = {}
) {
  return {
    store: f.store,
    turn: f.turn,
    systemPrompt: 'Preserve current user constraints and source boundaries.',
    tools: [] as readonly AgentTool[],
    model,
    bounds: { context: contextLimit, output: outputReserve },
    requiredMessages: [currentMessage],
    limits,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    readEvidence: evidence,
    ...overrides,
    callProvider: vi.fn(
      overrides.callProvider ?? (async (_call: InternalAgentProviderRequest) => response())
    ),
  };
}

/** Reads only canonical summary Items, never a process cache or provider continuation. */
function summaries(f: ReturnType<typeof fixture>) {
  return f.store
    .listThreadItems(f.workspace.id, f.thread.id)
    .filter((item) => item.type === 'context-summary');
}

/** Extracts readable transcript text for prior, finite order and authority assertions. */
function text(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    )
    .join('\n');
}

/** Inventories retained paths so an alternate durable context store cannot hide behind restart success. */
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? files(path).map((child) => join(entry.name, child))
        : [relative(root, path)];
    })
    .sort();
}

describe('source-bound internal rolling context', () => {
  it('projects existing context failures as actionable redacted Turn errors', () => {
    const error = new InternalAgentProviderError(
      'internal_agent_context_exceeded',
      'Private request and provider details.'
    );
    expect(internalContextFailure(error)).toEqual({
      code: 'internal_agent_context_exceeded',
      message:
        'The selected model context capacity was exceeded. Reduce input or retrieve a smaller excerpt.',
    });
  });

  it('uses complete canonical history in first-seen order when it fits, including after restart', async () => {
    const f = fixture(1, true);
    const before = f.store.listThreadItems(f.workspace.id, f.thread.id);
    const request = input(f);
    const prepared = await prepareInternalAgentContext(request);
    expect(f.store.getTurnById(f.turn.id).internalExecution).toEqual({
      roleId: f.turn.agentId,
      logicalModelId: model.logicalModelId,
      contextStrategy: 'rolling',
      threshold: contextLimit - outputReserve,
    });
    expect(request.callProvider).not.toHaveBeenCalled();
    expect(prepared.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(text(prepared.messages)).toContain('Question 0:');
    expect(text(prepared.messages).indexOf('Question 0:')).toBeLessThan(
      text(prepared.messages).indexOf('Decision 0:')
    );
    expect(prepared.messages.at(-1)).toEqual(currentMessage);
    f.store = new FsStore({ dataRoot: f.dataRoot });
    const restarted = input(f);
    expect((await prepareInternalAgentContext(restarted)).messages).toEqual(prepared.messages);
    expect(restarted.callProvider).not.toHaveBeenCalled();
    expect(f.store.listThreadItems(f.workspace.id, f.thread.id)).toEqual(before);
  });

  it('keeps canonical failure outcomes visible beside retained source Items', async () => {
    const f = fixture(1, false, true);
    const request = input(f);
    const prepared = await prepareInternalAgentContext(request);
    expect(request.callProvider).not.toHaveBeenCalled();
    expect(text(prepared.messages)).toContain('source_work_failed');
    expect(text(prepared.messages)).toContain('The source work needs a new explicit request.');
    expect(text(prepared.messages)).toContain('retained_turn_outcome');
    expect(prepared.messages.at(-1)).toEqual(currentMessage);
  });

  it('bootstraps large legacy history in bounded advancing batches and reuses canonical summaries after restart', async () => {
    const f = fixture(8, true);
    const paths = files(f.dataRoot);
    const requests: InternalAgentProviderRequest[] = [];
    const execute = vi.fn(async () => ({ content: [] }));
    const tool: AgentTool = {
      name: 'thread.history.read',
      description: 'Read exact retained conversation Items.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute,
    };
    const request = input(f, {
      tools: [tool],
      callProvider: vi.fn(async (call) => {
        requests.push(call);
        // Convert serialized UTF-8 bytes to the accepted local token estimate; byte caps have separate units.
        // This oracle does not call the production estimator and makes no exact-token claim.
        const requestBytes = Buffer.byteLength(
          JSON.stringify({
            systemPrompt: call.systemPrompt,
            tools: call.tools,
            messages: call.messages,
          })
        );
        const estimatedInputTokens = Math.ceil(requestBytes / 3) + 4_096;
        expect(estimatedInputTokens + outputReserve).toBeLessThan(contextLimit);
        expect(call.systemPrompt).toBe(request.systemPrompt);
        expect(call.tools).toEqual([
          { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
        ]);
        expect(text(call.messages)).toContain('openkit_context_summary_task');
        return response();
      }),
    });
    const prepared = await prepareInternalAgentContext(request);
    const accepted = summaries(f);
    expect(requests.length).toBeGreaterThan(1);
    expect(accepted).toHaveLength(requests.length);
    let boundary = 0;
    for (const summary of accepted) {
      expect(summary.sourceRange.itemCount).toBeGreaterThan(boundary);
      expect(summary.sourceRange.firstItemId).toBe(f.history[0]!.id);
      expect(summary.sourceRange.lastItemId).toBe(f.history[summary.sourceRange.itemCount - 1]!.id);
      expect(summary.sourceRange.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(summary.sourceRange.evidenceDigest).toBe(
        evidence(f.history.slice(0, summary.sourceRange.itemCount))
      );
      expect(summary.turnId).toBe(f.turn.id);
      expect(summary.strategy).toBe('rolling');
      expect(summary.logicalModelId).toBe(model.logicalModelId);
      boundary = summary.sourceRange.itemCount;
    }
    expect(prepared.limits.maxModelTurns).toBe(limits.maxModelTurns - requests.length);
    expect(prepared.limits.maxToolCalls).toBe(limits.maxToolCalls);
    expect(execute).not.toHaveBeenCalled();
    expect(prepared.messages.at(-1)).toEqual(currentMessage);
    expect(
      prepared.messages.some(
        (message) => message.role === 'assistant' && text([message]).includes(summaryText)
      )
    ).toBe(true);
    expect(
      f.store
        .listThreadItems(f.workspace.id, f.thread.id)
        .filter((item) => f.history.some((source) => source.id === item.id))
    ).toEqual(f.history);
    expect(files(f.dataRoot)).toEqual(paths);
    f.store = new FsStore({ dataRoot: f.dataRoot });
    const restarted = input(f, { tools: [tool] });
    expect((await prepareInternalAgentContext(restarted)).messages).toEqual(prepared.messages);
    expect(restarted.callProvider).not.toHaveBeenCalled();
    expect(summaries(f)).toEqual(accepted);
  });

  it('continues rolling after a later admission without replaying earlier producer calls', async () => {
    const f = fixture();
    await prepareInternalAgentContext(input(f));
    const previous = summaries(f).at(-1)!;
    messageItem(f.store, f.turn, 'assistant-message', 'Accepted ordinary answer.');
    f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: timestamp });
    for (let index = 0; index < 6; index += 1) {
      const turn = admitTurn(f.store, f.workspace.id, f.thread.id);
      messageItem(f.store, turn, 'user-message', `Later input ${index} ${'x'.repeat(1_600)}`);
      messageItem(f.store, turn, 'assistant-message', `Later answer ${index} ${'y'.repeat(1_600)}`);
      f.store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp });
    }
    f.turn = admitTurn(f.store, f.workspace.id, f.thread.id);
    const request = input(f);
    const prepared = await prepareInternalAgentContext(request);
    expect(request.callProvider).toHaveBeenCalled();
    expect(summaries(f).at(-1)!.sourceRange.itemCount).toBeGreaterThan(
      previous.sourceRange.itemCount
    );
    expect(text(request.callProvider.mock.calls[0]![0].messages)).toContain(previous.text);
    expect(prepared.messages.at(-1)).toEqual(currentMessage);
  });

  it.each([
    'source digest',
    'environment',
    'dependent evidence',
  ] as const)('refuses an invalid %s without using it to truncate history', async (fault) => {
    const f = fixture();
    await prepareInternalAgentContext(input(f));
    const latest = summaries(f).at(-1)!;
    if (fault === 'source digest')
      f.store.updateItem(latest.id, {
        sourceRange: { ...latest.sourceRange, sourceDigest: `sha256:${'0'.repeat(64)}` },
      });
    const request = input(f, {
      ...(fault === 'environment' ? { systemPrompt: 'A changed role environment.' } : {}),
      ...(fault === 'dependent evidence' ? { readEvidence: () => `sha256:${'0'.repeat(64)}` } : {}),
    });
    const before = summaries(f);
    await expect(prepareInternalAgentContext(request)).rejects.toMatchObject({
      code: 'internal_agent_context_exceeded',
    });
    expect(request.callProvider).not.toHaveBeenCalled();
    expect(summaries(f)).toEqual(before);
    expect(
      f.store
        .listThreadItems(f.workspace.id, f.thread.id)
        .filter((item) => f.history.some((source) => source.id === item.id))
    ).toEqual(f.history);
  });

  it('rechecks current source authority after production and accepts no revoked summary', async () => {
    const f = fixture();
    const denied = new Error('Current source authority was revoked.');
    let revoked = false;
    const request = input(f, {
      assertCurrent: () => {
        if (revoked) throw denied;
      },
      callProvider: vi.fn(async () => {
        revoked = true;
        return response();
      }),
    });
    await expect(prepareInternalAgentContext(request)).rejects.toBe(denied);
    expect(request.callProvider).toHaveBeenCalledTimes(1);
    expect(summaries(f)).toEqual([]);
  });

  it('propagates the producer failure and leaves its attempted boundary unadvanced', async () => {
    const f = fixture();
    const failure = new InternalAgentProviderError('provider_unavailable', 'Provider unavailable.');
    let attempts = 0;
    const request = input(f, {
      callProvider: vi.fn(async () => {
        attempts += 1;
        if (attempts === 2) throw failure;
        return response();
      }),
    });
    await expect(prepareInternalAgentContext(request)).rejects.toBe(failure);
    expect(attempts).toBe(2);
    expect(summaries(f)).toHaveLength(1);
    expect(summaries(f)[0]!.sourceRange.itemCount).toBeLessThan(f.history.length);
  });

  it('refuses dependent source changes during production before accepting a summary', async () => {
    const f = fixture();
    let changed = false;
    const request = input(f, {
      readEvidence: (items) => (changed ? `sha256:${'0'.repeat(64)}` : evidence(items)),
      callProvider: async () => {
        changed = true;
        return response();
      },
    });
    await expect(prepareInternalAgentContext(request)).rejects.toMatchObject({
      code: 'internal_agent_context_exceeded',
    });
    expect(request.callProvider).toHaveBeenCalledTimes(1);
    expect(summaries(f)).toEqual([]);
  });

  it('withholds dispatch when synchronous source verification crosses the admitted deadline', async () => {
    const f = fixture(1);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = input(f, {
      limits: { ...limits, deadlineMs: 10 },
      readEvidence: (items) => {
        now = 11;
        return evidence(items);
      },
    });
    await expect(prepareInternalAgentContext(request)).rejects.toMatchObject({
      code: 'internal_agent_context_deadline',
    });
    expect(request.callProvider).not.toHaveBeenCalled();
    expect(summaries(f)).toEqual([]);
  });

  it('ends a stalled summary at the same admitted deadline without accepting output', async () => {
    const f = fixture();
    const request = input(f, {
      limits: { ...limits, deadlineMs: 25 },
      callProvider: async () => new Promise<InternalAgentProviderResponse>(() => {}),
    });
    await expect(prepareInternalAgentContext(request)).rejects.toMatchObject({
      code: 'internal_agent_context_deadline',
    });
    expect(request.callProvider).toHaveBeenCalledTimes(1);
    expect(summaries(f)).toEqual([]);
  });

  it.each([
    'tool call',
    'truncated',
    'empty',
    'oversized',
    'nonreducing',
  ] as const)('rejects %s summary output before any Tool closure executes', async (kind) => {
    const f = fixture();
    const execute = vi.fn(async () => ({ content: [] }));
    const tool: AgentTool = {
      name: 'effect',
      description: 'A supplied Tool.',
      inputSchema: { type: 'object' },
      execute,
    };
    const output = response(
      kind === 'oversized'
        ? 'x'.repeat(65_537)
        : kind === 'nonreducing'
          ? 'x'.repeat(12_000)
          : kind === 'empty'
            ? ''
            : summaryText
    );
    const request = input(f, {
      tools: [tool],
      callProvider: vi.fn(async () => ({
        message: {
          ...output.message,
          truncated: kind === 'truncated',
          ...(kind === 'tool call'
            ? {
                content: [
                  {
                    type: 'toolCall' as const,
                    callId: 'effect-call',
                    name: 'effect',
                    arguments: {},
                  },
                ],
              }
            : {}),
        },
      })),
    });
    await expect(prepareInternalAgentContext(request)).rejects.toMatchObject({
      code: 'internal_agent_summary_invalid',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(summaries(f)).toEqual([]);
  });

  it('reserves the ordinary answer model turn and retains completed batches when the shared budget runs out', async () => {
    const f = fixture();
    const noSummaryBudget = input(f, { limits: { ...limits, maxModelTurns: 1 } });
    await expect(prepareInternalAgentContext(noSummaryBudget)).rejects.toMatchObject({
      code: 'internal_agent_context_exceeded',
    });
    expect(noSummaryBudget.callProvider).not.toHaveBeenCalled();
    const oneSummaryBudget = input(f, { limits: { ...limits, maxModelTurns: 2 } });
    await expect(prepareInternalAgentContext(oneSummaryBudget)).rejects.toMatchObject({
      code: 'internal_agent_context_exceeded',
    });
    expect(oneSummaryBudget.callProvider).toHaveBeenCalledTimes(1);
    expect(summaries(f)).toHaveLength(1);
  });

  it('passes only the remaining absolute deadline to the ordinary answer run', async () => {
    vi.useFakeTimers();
    const f = fixture(4);
    const request = input(f, {
      limits: { ...limits, deadlineMs: 100 },
      callProvider: vi.fn(async () => {
        await vi.advanceTimersByTimeAsync(35);
        return response();
      }),
    });
    const prepared = await prepareInternalAgentContext(request);
    expect(request.callProvider).toHaveBeenCalled();
    expect(prepared.limits.deadlineMs).toBeLessThanOrEqual(65);
    expect(prepared.limits.deadlineMs).toBeGreaterThan(0);
    const answer = vi.fn(async () => new Promise<InternalAgentProviderResponse>(() => {}));
    const pending = runInternalAgentLoop({ ...request, ...prepared }, answer);
    await vi.advanceTimersByTimeAsync(prepared.limits.deadlineMs);
    expect(await pending).toMatchObject({ kind: 'limit_reached', limit: 'deadline' });
    expect(answer).toHaveBeenCalledTimes(1);
  });
});
