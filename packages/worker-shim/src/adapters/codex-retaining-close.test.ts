// openkit-test-platform: posix

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexCloseRollout, requireCodexCloseHistory } from './codex-retaining-close.js';

const THREAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const terminal = { id: 'turn-one', input: 'prompt', status: 'completed', texts: ['answer'] };
const frames = [
  {
    ordinal: 0,
    type: 'session_meta',
    payload: { id: THREAD, history_mode: 'paginated', cli_version: '0.160.0' },
  },
  { ordinal: 1, type: 'turn_context', payload: { turn_id: terminal.id } },
  {
    ordinal: 2,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'prompt' }],
      internal_chat_message_metadata_passthrough: {
        turn_id: terminal.id,
        content_item_kinds: ['user.text'],
      },
    },
  },
  {
    ordinal: 3,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
      internal_chat_message_metadata_passthrough: {
        turn_id: terminal.id,
        content_item_kinds: ['unknown'],
      },
    },
  },
  {
    ordinal: 4,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: terminal.id, last_agent_message: 'answer' },
  },
];
const history = {
  thread: {
    id: THREAD,
    historyMode: 'paginated',
    turns: [
      {
        id: terminal.id,
        status: 'completed',
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
          { type: 'agentMessage', text: 'answer' },
        ],
      },
    ],
  },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Encodes the exact retained native JSONL prefix for the qualification oracle. */
function encode(value: unknown[] = frames): Buffer {
  return Buffer.from(value.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
}

describe('Codex retaining close context proof', () => {
  it('R2 reconciles earlier Turn messages as well as the settled last Turn', () => {
    const earlier = structuredClone(history.thread.turns[0]!);
    earlier.id = 'earlier-turn';
    const barrier = { thread: { ...history.thread, turns: [earlier, ...history.thread.turns] } };
    const prefix = frames.slice(1).map((frame) => ({
      ...frame,
      payload: {
        ...frame.payload,
        turn_id: 'earlier-turn',
        ...(frame.payload.internal_chat_message_metadata_passthrough
          ? {
              internal_chat_message_metadata_passthrough: {
                ...frame.payload.internal_chat_message_metadata_passthrough,
                turn_id: 'earlier-turn',
              },
            }
          : {}),
      },
    }));
    const environment = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>native prelude</environment_context>' },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: 'earlier-turn',
          content_item_kinds: ['environments.environment_context'],
        },
      },
    };
    const retained = [frames[0], environment, ...prefix, ...frames.slice(1)].map(
      (frame, ordinal) => ({
        ...frame,
        ordinal,
      })
    );
    expect(() =>
      requireCodexCloseHistory(barrier, encode(retained), THREAD, terminal)
    ).not.toThrow();
    const corrupt = retained.map((frame) =>
      frame.payload.internal_chat_message_metadata_passthrough?.turn_id === 'earlier-turn'
        ? {
            ...frame,
            payload: {
              ...frame.payload,
              content: [
                {
                  type: frame.payload.role === 'user' ? 'input_text' : 'output_text',
                  text: 'changed earlier context',
                },
              ],
            },
          }
        : frame
    );
    expect(() => requireCodexCloseHistory(barrier, encode(corrupt), THREAD, terminal)).toThrow();
    const extraItem = {
      ordinal: retained.length,
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'extra-call',
        name: 'extra_tool',
        arguments: '{}',
      },
    };
    expect(() =>
      requireCodexCloseHistory(barrier, encode([...retained, extraItem]), THREAD, terminal)
    ).toThrow(/unqualified/);
  });

  it('requires an explicit raw terminal rather than an implicit completed history Turn', () => {
    expect(() => requireCodexCloseHistory(history, encode(), THREAD, terminal)).not.toThrow();
    expect(() =>
      requireCodexCloseHistory(history, encode(frames.slice(0, 4)), THREAD, terminal)
    ).toThrow(/raw completed terminal/);
  });

  it.each([
    { thread: { ...history.thread, id: 'sibling' } },
    { thread: { ...history.thread, historyMode: 'legacy' } },
    { thread: { ...history.thread, turns: [] } },
    {
      thread: { ...history.thread, turns: [{ ...history.thread.turns[0], status: 'interrupted' }] },
    },
    {
      thread: {
        ...history.thread,
        turns: [{ ...history.thread.turns[0], items: [{ type: 'agentMessage', text: 'changed' }] }],
      },
    },
  ])('refuses a mismatched read-barrier history %j', (value) => {
    expect(() => requireCodexCloseHistory(value, encode(), THREAD, terminal)).toThrow();
  });

  it.each(['missing', 'changed'])('refuses %s retained assistant context', (mode) => {
    const retained = frames.flatMap((frame) => {
      if (frame.payload.role !== 'assistant') return [frame];
      if (mode === 'missing') return [];
      return [
        {
          ...frame,
          payload: { ...frame.payload, content: [{ type: 'output_text', text: 'wrong' }] },
        },
      ];
    });
    expect(() => requireCodexCloseHistory(history, encode(retained), THREAD, terminal)).toThrow(
      /retained assistant context/
    );
  });

  it('refuses malformed retained assistant text instead of coercing it', () => {
    const expected = { ...terminal, texts: ['17'] };
    const barrier = structuredClone(history);
    barrier.thread.turns[0]!.items[1] = { type: 'agentMessage', text: '17' };
    const retained = frames.map((frame) => {
      if (frame.payload.role === 'assistant')
        return {
          ...frame,
          payload: { ...frame.payload, content: [{ type: 'output_text', text: 17 }] },
        };
      if (frame.payload.type === 'task_complete')
        return { ...frame, payload: { ...frame.payload, last_agent_message: '17' } };
      return frame;
    });
    expect(() => requireCodexCloseHistory(barrier, encode(retained), THREAD, expected)).toThrow(
      /retained assistant context/
    );
  });

  it('refuses later context-changing work and duplicate terminals', () => {
    expect(() =>
      requireCodexCloseHistory(
        history,
        encode([...frames, { type: 'turn_context', payload: { turn_id: 'next-turn' } }]),
        THREAD,
        terminal
      )
    ).toThrow(/context advanced/);
    expect(() =>
      requireCodexCloseHistory(history, encode([...frames, frames[4]]), THREAD, terminal)
    ).toThrow(/raw completed terminal/);
  });

  it.each([
    'legacy',
    'torn',
    'malformed',
    'missing-prefix',
    'invalid-utf8',
    'unsupported-frame',
    'compacted',
    'orphaned-checkpoint',
  ])('refuses unqualified retained bytes: %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-close-proof-'));
    roots.push(root);
    const path = join(root, 'rollout.jsonl');
    let bytes = encode();
    if (mode === 'legacy')
      bytes = encode([
        { ...frames[0], payload: { ...frames[0].payload, history_mode: 'legacy' } },
        ...frames.slice(1),
      ]);
    if (mode === 'torn') bytes = bytes.subarray(0, bytes.length - 1);
    if (mode === 'malformed') bytes = Buffer.concat([bytes, Buffer.from('broken\n')]);
    if (mode === 'missing-prefix') bytes = encode([frames[0], frames[3]]);
    if (mode === 'invalid-utf8') bytes = Buffer.concat([bytes, Buffer.from([0xff, 0x0a])]);
    if (mode === 'unsupported-frame' || mode === 'compacted' || mode === 'orphaned-checkpoint')
      bytes = encode([
        ...frames,
        {
          ordinal: frames.length,
          type:
            mode === 'unsupported-frame'
              ? 'unknown-core'
              : mode === 'compacted'
                ? 'compacted'
                : 'world_state',
          payload: { full: false, state: {} },
        },
      ]);
    await writeFile(path, bytes);
    await expect(readCodexCloseRollout(path, THREAD)).rejects.toThrow();
  });

  it('reads only a complete bounded exact retained prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-close-proof-'));
    roots.push(root);
    const path = join(root, 'rollout.jsonl');
    await writeFile(path, encode());
    expect(await readCodexCloseRollout(path, THREAD)).toEqual(encode());
    await expect(readCodexCloseRollout(path, 'sibling')).rejects.toThrow(/identity/);
  });
});
