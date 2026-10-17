import type { Item } from '@openkit/protocol';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createCompactingInternalAgentProvider } from './compacting-context.js';
import { assertInternalAgentContextFits } from './gateway-provider.js';
import {
  type AgentMessage,
  type InternalAgentProviderRequest,
  runInternalAgentLoop,
} from './internal-agent-loop.js';
import { internalContextDigest, internalContextSourceDigest } from './rolling-context.js';

const timestamp = '2026-10-17T00:00:00.000Z';
const model = { logicalModelId: 'knowledge-model', modelFamilyId: null, capabilities: [] };
const threshold = 10_000;
const limits = { maxModelTurns: 4, maxToolCalls: 3, deadlineMs: 10_000 };
const initial: AgentMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'Keep deployment paused. Decision pending. Page: page@revision.' },
  ],
};
const continuation =
  'Keep deployment paused. Decision pending. Page: page@revision. The inspect Tool returned observations; no publication occurred.';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Uses actual current-Turn Items; the external fake Provider owns only model output. */
function fixture(previous?: { store: FsStore; turn: ReturnType<FsStore['getTurnById']> }) {
  vi.stubEnv('OPENKIT_DATA_ROOT', '');
  const store = previous?.store ?? new FsStore();
  const workspace = previous
    ? { id: previous.turn.workspaceId }
    : store.createWorkspace('Compaction');
  const thread = previous
    ? { id: previous.turn.threadId }
    : store.createThread(workspace.id, 'Maintenance');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Maintain notebook.',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    { agentId: 'knowledge-manager', executorKind: 'assistant', startedAt: timestamp }
  );
  const committed = new Map<string, Item>();
  const commitMessages = (messages: readonly AgentMessage[]): Item[] => {
    const items: Item[] = [];
    for (const [index, message] of messages.entries()) {
      if (message.role === 'tool') continue;
      const text = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('');
      if (text) {
        const key = `message-${index}`;
        if (!committed.has(key)) {
          committed.set(
            key,
            store.createItem({
              id: allocateEntityId('it'),
              workspaceId: workspace.id,
              threadId: thread.id,
              turnId: turn.id,
              type: message.role === 'user' ? 'user-message' : 'assistant-message',
              status: 'completed',
              text,
              ...(message.role === 'user'
                ? { actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } }
                : {}),
              createdAt: timestamp,
              completedAt: timestamp,
            } as Item)
          );
        }
        items.push(committed.get(key)!);
      }
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        const result = messages.find(
          (candidate) => candidate.role === 'tool' && candidate.callId === part.callId
        );
        if (!result || result.role !== 'tool') throw new Error('Unaccepted Tool result.');
        if (!committed.has(part.callId)) {
          committed.set(
            part.callId,
            store.createItem({
              id: allocateEntityId('it'),
              workspaceId: workspace.id,
              threadId: thread.id,
              turnId: turn.id,
              type: 'tool-call',
              causationId: part.callId,
              status: result.isError ? 'failed' : 'completed',
              tool: part.name,
              server: null,
              arguments: part.arguments as Record<string, unknown>,
              result: JSON.stringify(result.content),
              error: result.isError ? 'Tool failed.' : null,
              durationMs: 1,
              createdAt: timestamp,
              completedAt: timestamp,
            })
          );
        }
        items.push(committed.get(part.callId)!);
      }
    }
    return items;
  };
  return { store, turn, commitMessages };
}

/** Complete assistant inference output admitted by the real bounded loop. */
function answer(text: string) {
  return {
    message: {
      role: 'assistant' as const,
      truncated: false,
      content: [{ type: 'text' as const, text }],
    },
  };
}

/** Requests one actual loop Tool execution with a correlated source record. */
function inspect(callId: string, includeText = true) {
  return {
    message: {
      role: 'assistant' as const,
      truncated: false,
      content: [
        ...(includeText ? [{ type: 'text' as const, text: 'Inspect before deciding.' }] : []),
        { type: 'toolCall' as const, name: 'knowledge.inspect', callId, arguments: {} },
      ],
    },
  };
}

/** The sole Tool returns a large first observation, then a small later observation. */
function tools() {
  let count = 0;
  return [
    {
      name: 'knowledge.inspect',
      description: 'Read bounded notebook observations.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({
        content: [
          {
            type: 'text' as const,
            text: ++count === 1 ? 'Observed source. '.repeat(450) : 'Later observation.',
          },
        ],
      }),
    },
  ];
}

/** Existing loop request, without a compaction field or second execution loop. */
function loopInput() {
  return {
    systemPrompt: 'Maintain the notebook within current authority.',
    model,
    messages: [initial],
    tools: tools(),
    limits,
    signal: new AbortController().signal,
  };
}

/** Current canonical summaries accepted by the existing Store. */
function summaries(f: ReturnType<typeof fixture>) {
  return f.store.getTurnById(f.turn.id).items.filter((item) => item.type === 'context-summary');
}

describe('bounded current-run compaction', () => {
  it('compacts committed text and Tool pairs, then supplies the summary and later Items within the shared budget', async () => {
    const f = fixture();
    const calls: InternalAgentProviderRequest[] = [];
    let ordinary = 0;
    const provider = vi.fn(async (request: InternalAgentProviderRequest) => {
      calls.push(request);
      assertInternalAgentContextFits(request, 30_000, 512);
      if (request.tools.length === 0) return answer(continuation);
      ordinary += 1;
      return ordinary <= 2
        ? inspect(`call-${ordinary}`, ordinary !== 1)
        : answer('Decision remains pending.');
    });
    const run = loopInput();
    const wrapped = createCompactingInternalAgentProvider({
      ...f,
      compactThreshold: threshold,
      limits,
      assertCurrent: () => {},
      readEvidence: () => internalContextDigest([]),
      callProvider: provider,
    });
    expect((await runInternalAgentLoop(run, wrapped)).kind).toBe('quiescent');
    expect(provider).toHaveBeenCalledTimes(4);
    const [summary] = summaries(f);
    expect(summary).toMatchObject({
      strategy: 'compaction',
      logicalModelId: model.logicalModelId,
      text: continuation,
    });
    const sources = f.store.getTurnById(f.turn.id).items.slice(0, 2);
    expect(sources.map((item) => item.type)).toEqual(['user-message', 'tool-call']);
    expect(calls[1]!.messages).toHaveLength(3);
    expect(summary!.sourceRange).toEqual({
      firstItemId: sources[0]!.id,
      lastItemId: sources[1]!.id,
      itemCount: 2,
      sourceDigest: internalContextSourceDigest(f.store, sources, 'compaction'),
      evidenceDigest: internalContextDigest([]),
    });
    expect(calls[1]!.tools).toEqual([]);
    expect(calls[1]!.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(JSON.stringify(calls[1]!.messages)).toContain('page@revision');
    expect(JSON.stringify(calls[1]!.messages)).toContain('call-1');
    expect(JSON.stringify(calls[2]!.messages)).toContain(continuation);
    expect(calls[2]!.messages).toHaveLength(1);
    expect(JSON.stringify(calls[3]!.messages)).toContain('Later observation.');
    expect(JSON.stringify(calls[3]!.messages)).not.toContain('Observed source.');
    for (const call of [calls[0]!, calls[2]!, calls[3]!])
      expect(() => assertInternalAgentContextFits(call, threshold - 1, undefined)).not.toThrow();
    const digest = summary!.sourceRange.sourceDigest;
    f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: timestamp });
    expect(internalContextSourceDigest(f.store, sources, 'compaction')).toBe(digest);

    const next = fixture(f);
    const fresh = vi.fn(async () => answer('Fresh run.'));
    await runInternalAgentLoop(
      loopInput(),
      createCompactingInternalAgentProvider({
        ...next,
        compactThreshold: threshold,
        limits,
        assertCurrent: () => {},
        readEvidence: () => internalContextDigest([]),
        callProvider: fresh,
      })
    );
    expect(fresh.mock.calls).toHaveLength(1);
    expect(summaries(next)).toEqual([]);
  });

  it('rejects Tool-requesting summary output without advancing the canonical source boundary', async () => {
    const f = fixture();
    const provider = vi.fn(async () => inspect('call-1'));
    const result = await runInternalAgentLoop(
      loopInput(),
      createCompactingInternalAgentProvider({
        ...f,
        compactThreshold: threshold,
        limits,
        assertCurrent: () => {},
        readEvidence: () => internalContextDigest([]),
        callProvider: provider,
      })
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'internal_agent_summary_invalid' });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(summaries(f)).toEqual([]);
    expect(f.store.getTurnById(f.turn.id).items.at(-1)?.type).toBe('tool-call');
  });

  it('reserves an ordinary answer call and does not hide summary calls from the model-call ceiling', async () => {
    const f = fixture();
    const provider = vi.fn(async () => inspect('call-1'));
    const bound = { ...limits, maxModelTurns: 2 };
    const result = await runInternalAgentLoop(
      { ...loopInput(), limits: bound },
      createCompactingInternalAgentProvider({
        ...f,
        compactThreshold: threshold,
        limits: bound,
        assertCurrent: () => {},
        readEvidence: () => internalContextDigest([]),
        callProvider: provider,
      })
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'internal_agent_model_turns_exceeded' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(summaries(f)).toEqual([]);
  });

  it('rejects changed canonical source bytes before accepting the summary', async () => {
    const f = fixture();
    const provider = vi.fn(async (request: InternalAgentProviderRequest) => {
      if (request.tools.length) return inspect('call-1');
      const source = f.store.getTurnById(f.turn.id).items[0]!;
      f.store.updateItem(source.id, { text: 'Changed accepted constraint.' });
      return answer(continuation);
    });
    const result = await runInternalAgentLoop(
      loopInput(),
      createCompactingInternalAgentProvider({
        ...f,
        compactThreshold: threshold,
        limits,
        assertCurrent: () => {},
        readEvidence: () => internalContextDigest([]),
        callProvider: provider,
      })
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'internal_agent_context_exceeded' });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(summaries(f)).toEqual([]);
  });

  it('withholds a summary when current audience authority changes during production', async () => {
    const f = fixture();
    let allowed = true;
    const provider = vi.fn(async (request: InternalAgentProviderRequest) => {
      if (request.tools.length) return inspect('call-1');
      allowed = false;
      return answer(continuation);
    });
    const result = await runInternalAgentLoop(
      loopInput(),
      createCompactingInternalAgentProvider({
        ...f,
        compactThreshold: threshold,
        limits,
        assertCurrent: () => {
          if (!allowed) throw new Error('Audience revoked.');
        },
        readEvidence: () => internalContextDigest([]),
        callProvider: provider,
      })
    );
    expect(result).toMatchObject({ kind: 'failed' });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(summaries(f)).toEqual([]);
  });
});
