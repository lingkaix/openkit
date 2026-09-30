import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { CodexRuntimeCapture } from './codex-runtime-capture.js';
import {
  type RuntimeCaptureInput,
  type RuntimeObservation,
  runtimeOriginRef,
  runtimeRef,
} from './runtime-capture.js';

/** Encodes complete native frames without transforming admitted content strings. */
function lines(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
/** Constructs the pinned first rollout metadata line for a reachable native thread. */
function meta(id: string, parent?: string, version = '0.153.4') {
  return {
    type: 'session_meta',
    payload: {
      id,
      session_id: 'root',
      cli_version: version,
      ...(parent
        ? {
            parent_thread_id: parent,
            source: {
              subagent: {
                thread_spawn: { parent_thread_id: parent, depth: parent === 'root' ? 1 : 2 },
              },
            },
          }
        : {}),
    },
  };
}
/** Installs one isolated source and a schema-validating observation receiver. */
async function fixture(value: 'off' | 'on') {
  const home = await mkdtemp(join(tmpdir(), 'codex-live-'));
  await mkdir(join(home, 'sessions'));
  const received: Array<{ record: RuntimeObservation; body?: Uint8Array }> = [];
  const input: RuntimeCaptureInput = {
    packageSnapshotId: 'aep_live',
    captureCoverage: { scope: 'task', value },
    credentialValues: ['secret-canary'],
    emit: async (record, body) => {
      received.push({
        record: WorkerObservationDataSchema.parse(record),
        ...(body ? { body: Buffer.from(body) } : {}),
      });
    },
  };
  return {
    home,
    input,
    received,
    path: (id: string) => join(home, 'sessions', `rollout-${id}.jsonl`),
  };
}

describe('incremental Codex capture', () => {
  it('retains a complete native ancestry fault as a gap without failing collection finalization', async () => {
    const f = await fixture('on');
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
      await capture.writeStdout(
        Buffer.from(
          lines({
            type: 'item.completed',
            item: {
              type: 'collab_tool_call',
              id: 'self-spawn',
              tool: 'spawn_agent',
              sender_thread_id: 'root',
              receiver_thread_ids: ['root'],
              status: 'completed',
            },
          })
        )
      );
      expect(
        f.received.some(
          ({ record }) =>
            record.fact.kind === 'coverage' &&
            record.fact.coverage === 'unavailable' &&
            record.fact.reason !== undefined
        )
      ).toBe(true);
      await capture.finalize();
      expect(f.received.some(({ record }) => record.fact.coverage === 'ended')).toBe(true);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('retains a gap when a reachable child rollout disappears after discovery', async () => {
    const f = await fixture('on');
    const childRef = runtimeOriginRef('aep_live', 'child');
    const childPath = f.path('child');
    let removedAfterOrigin = false;
    const capture = await CodexRuntimeCapture.create(
      {
        ...f.input,
        emit: async (record, body) => {
          await f.input.emit(record, body);
          if (
            !removedAfterOrigin &&
            record.fact.kind === 'origin' &&
            record.sourceRef === runtimeRef('rts', 'aep_live', 'child') &&
            record.fact.runtimeOriginRef === childRef
          ) {
            await rm(childPath);
            removedAfterOrigin = true;
          }
        },
      },
      f.home,
      '0.153.4'
    );
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await writeFile(
        childPath,
        lines(meta('child', 'root'), {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            channel: 'final',
            content: [{ type: 'output_text', text: 'vanishing child content' }],
          },
        })
      );
      await capture.writeStdout(
        Buffer.from(
          lines(
            { type: 'thread.started', thread_id: 'root' },
            {
              type: 'item.completed',
              item: {
                type: 'collab_tool_call',
                id: 'spawn-child',
                tool: 'spawn_agent',
                sender_thread_id: 'root',
                receiver_thread_ids: ['child'],
                status: 'completed',
              },
            }
          )
        )
      );
      expect(removedAfterOrigin).toBe(true);
      expect(
        f.received.some(
          ({ record }) =>
            record.fact.kind === 'coverage' &&
            record.fact.family === 'child-content' &&
            record.fact.coverage === 'unavailable' &&
            record.fact.reason !== undefined
        )
      ).toBe(true);
      await capture.finalize();
      expect(f.received.some(({ body }) => body)).toBe(false);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('does not tail a descendant through duplicated child ancestry', async () => {
    const f = await fixture('on');
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await writeFile(f.path('child'), lines(meta('child', 'root')));
      await writeFile(f.path('child-copy'), lines(meta('child', 'root')));
      await writeFile(
        f.path('grandchild'),
        lines(meta('grandchild', 'child'), {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            channel: 'final',
            content: [{ type: 'output_text', text: 'untrusted descendant body' }],
          },
        })
      );
      await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
      await capture.finalize();
      expect(
        f.received.some(
          ({ record }) =>
            record.fact.kind === 'coverage' &&
            record.fact.family === 'child-metadata' &&
            record.fact.coverage === 'unavailable' &&
            record.fact.reason === 'source-changed'
        )
      ).toBe(true);
      expect(
        f.received.filter(
          ({ record }) =>
            record.sourceRef === runtimeRef('rts', 'aep_live', 'grandchild') &&
            record.fact.kind !== 'coverage'
        )
      ).toEqual([]);
      expect(JSON.stringify(f.received)).not.toContain('untrusted descendant body');
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('fails the next stdout write after a timer-only required observation append fails', async () => {
    const f = await fixture('on');
    const childSourceRef = runtimeRef('rts', 'aep_live', 'child');
    let rejected = false;
    const capture = await CodexRuntimeCapture.create(
      {
        ...f.input,
        emit: async (record, body) => {
          if (!rejected && record.sourceRef === childSourceRef && record.fact.kind === 'origin') {
            rejected = true;
            throw new Error('injected timer observation append rejection');
          }
          await f.input.emit(record, body);
        },
      },
      f.home,
      '0.153.4'
    );
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
      await writeFile(f.path('child'), lines(meta('child', 'root')));
      await vi.waitFor(() => expect(rejected).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(
        capture.writeStdout(
          Buffer.from(
            lines({
              type: 'item.completed',
              item: { id: 'continued', type: 'agent_message', text: 'continued' },
            })
          )
        )
      ).rejects.toThrow('injected timer observation append rejection');
      expect(f.received.some(({ record }) => record.fact.reason === 'collector-failed')).toBe(
        false
      );
      await expect(capture.finalize()).rejects.toThrow(
        'injected timer observation append rejection'
      );
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it.each([
    'on',
    'off',
  ] as const)('retains nested child activity before quiet parent completion with capture %s', async (value) => {
    const f = await fixture(value);
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    const text = '  child outward 💡\n\n';
    const args = ' {"command":"read file"}  ';
    const result = '  exact result\n';
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await capture.writeStdout(
        Buffer.from(
          lines(
            { type: 'thread.started', thread_id: 'root' },
            {
              type: 'item.completed',
              item: {
                type: 'collab_tool_call',
                id: 'spawn-1',
                tool: 'spawn_agent',
                sender_thread_id: 'root',
                receiver_thread_ids: ['child'],
                status: 'completed',
                agents_states: { child: { status: 'running', message: null } },
              },
            }
          )
        )
      );
      // No subsequent parent stdout: periodic tailing must discover the child and grandchild.
      await writeFile(
        f.path('child'),
        lines(
          meta('child', 'root'),
          {
            type: 'response_item',
            payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: args },
          },
          {
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'call-1', output: result },
          },
          {
            type: 'response_item',
            payload: { type: 'reasoning', summary: [{ text: 'hidden-reasoning-canary' }] },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              channel: 'analysis',
              content: [{ type: 'output_text', text: 'hidden-analysis-canary' }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              channel: 'final',
              content: [{ type: 'output_text', text }],
            },
          }
        )
      );
      await writeFile(
        f.path('grandchild'),
        lines(meta('grandchild', 'child'), {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'grandchild answer' }],
          },
        })
      );
      await vi.waitFor(() =>
        expect(
          f.received.some(
            ({ record }) =>
              record.fact.runtimeOriginRef === runtimeOriginRef('aep_live', 'grandchild') &&
              record.fact.kind === 'assistant'
          )
        ).toBe(true)
      );
      const childRef = runtimeOriginRef('aep_live', 'child');
      expect(
        f.received
          .filter(
            ({ record }) =>
              record.fact.kind === 'origin' && record.fact.runtimeOriginRef === childRef
          )
          .map(({ record }) => record.fact.phase)
      ).not.toContain('completed');
      expect(
        f.received.some(
          ({ record }) =>
            record.fact.parentRuntimeOriginRef === childRef &&
            record.fact.runtimeOriginRef === runtimeOriginRef('aep_live', 'grandchild')
        )
      ).toBe(true);
      const tools = f.received.filter(
        ({ record, body }) =>
          record.fact.kind === 'tool' &&
          record.fact.runtimeOriginRef === childRef &&
          (value === 'off' || body !== undefined)
      );
      expect(tools.map(({ record }) => record.fact.phase)).toEqual(['started', 'completed']);
      expect(tools[0]?.record.fact.callRef).toBe(tools[1]?.record.fact.callRef);
      if (value === 'on') {
        expect(tools.map(({ body }) => Buffer.from(body!).toString())).toEqual([args, result]);
        expect(f.received.some(({ body }) => body && Buffer.from(body).toString() === text)).toBe(
          true
        );
      } else {
        expect(f.received.every(({ body }) => body === undefined)).toBe(true);
        expect(tools.every(({ record }) => record.content.state === 'off')).toBe(true);
      }
      expect(JSON.stringify(f.received)).not.toContain('hidden-');
      await capture.finalize();
      expect(f.received.some(({ record }) => record.fact.coverage === 'ended')).toBe(true);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('excludes pre-launch retained bodies and never turns wait receivers into children', async () => {
    const f = await fixture('on');
    await writeFile(
      f.path('root'),
      lines(meta('root'), {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'prior-turn-canary' },
      })
    );
    await writeFile(
      f.path('foreign'),
      lines(meta('foreign'), {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'foreign-canary' },
      })
    );
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      await appendFile(
        f.path('root'),
        lines({ type: 'event_msg', payload: { type: 'agent_message', message: 'current turn' } })
      );
      await capture.writeStdout(
        Buffer.from(
          lines(
            { type: 'thread.started', thread_id: 'root' },
            {
              type: 'item.completed',
              item: {
                id: 'wait-1',
                type: 'collab_tool_call',
                tool: 'wait',
                sender_thread_id: 'root',
                receiver_thread_ids: ['foreign'],
                status: 'completed',
              },
            }
          )
        )
      );
      await capture.finalize();
      const bodies = f.received
        .map(({ body }) => (body ? Buffer.from(body).toString() : ''))
        .join('|');
      expect(bodies).toContain('current turn');
      expect(bodies).not.toContain('canary');
      expect(
        f.received.some(({ record }) => record.fact.parentRuntimeOriginRef !== undefined)
      ).toBe(false);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('preserves empty/Unicode bodies, rejects credentials and reports partial or missing sources', async () => {
    const f = await fixture('on');
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      const bytes = Buffer.from(
        lines(
          { type: 'thread.started', thread_id: 'root' },
          { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: ' 💡\n ' } },
          { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '' } },
          {
            type: 'item.completed',
            item: { id: 'm3', type: 'agent_message', text: 'secret-canary' },
          },
          {
            type: 'item.completed',
            item: {
              id: 's1',
              type: 'collab_tool_call',
              tool: 'spawn_agent',
              sender_thread_id: 'root',
              receiver_thread_ids: ['missing'],
              status: 'completed',
            },
          }
        )
      );
      const split = bytes.indexOf(Buffer.from('💡')) + 2;
      await capture.writeStdout(bytes.subarray(0, split));
      await capture.writeStdout(bytes.subarray(split));
      await capture.writeStdout(Buffer.from('{"unfinished":'));
      await capture.finalize();
      expect(f.received.some(({ body }) => body && Buffer.from(body).toString() === ' 💡\n ')).toBe(
        true
      );
      expect(
        f.received.some(
          ({ record }) =>
            record.content.state === 'expected' &&
            record.content.bytes === 0 &&
            record.content.chunkCount === 0
        )
      ).toBe(true);
      expect(
        f.received.some(
          ({ record }) =>
            record.content.state === 'unavailable' &&
            record.content.reason === 'credential-excluded'
        )
      ).toBe(true);
      expect(f.received.some(({ record }) => record.fact.reason === 'partial-frame')).toBe(true);
      expect(f.received.some(({ record }) => record.fact.reason === 'source-missing')).toBe(true);
      expect(
        f.received.every(
          ({ body }) => !body || !Buffer.from(body).toString().includes('secret-canary')
        )
      ).toBe(true);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('does not re-admit copied ancestor history before the child-owned settings boundary', async () => {
    const f = await fixture('on');
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      const childMeta = meta('child', 'root');
      await writeFile(f.path('root'), lines(meta('root')));
      await writeFile(
        f.path('child'),
        lines(
          { ...childMeta, payload: { ...childMeta.payload, forked_from_id: 'root' } },
          {
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'copied-prior-turn-canary' },
          },
          meta('root'),
          { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'root' } },
          {
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'copied-parent-canary' },
          },
          { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'child' } },
          { type: 'event_msg', payload: { type: 'agent_message', message: 'new child content' } }
        )
      );
      await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
      await capture.finalize();
      expect(
        f.received.map(({ body }) => body && Buffer.from(body).toString()).filter(Boolean)
      ).toEqual(['new child content']);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('reports a removed reachable source after admitting its earlier complete content', async () => {
    const f = await fixture('on');
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await writeFile(
        f.path('child'),
        lines(meta('child', 'root'), {
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'before removal' },
        })
      );
      await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
      expect(
        f.received.some(({ body }) => body && Buffer.from(body).toString() === 'before removal')
      ).toBe(true);
      await rm(f.path('child'));
      await capture.finalize();
      expect(f.received.some(({ record }) => record.fact.reason === 'source-missing')).toBe(true);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });

  it('records a reachable version mismatch without admitting its body', async () => {
    const f = await fixture('on');
    const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
    try {
      await writeFile(f.path('root'), lines(meta('root')));
      await writeFile(
        f.path('child'),
        lines(meta('child', 'root', 'unsupported'), {
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'wrong-version-canary' },
        })
      );
      await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
      await capture.finalize();
      expect(f.received.some(({ record }) => record.fact.reason === 'version-mismatch')).toBe(true);
      expect(
        f.received.every(
          ({ body }) => !body || !Buffer.from(body).toString().includes('wrong-version-canary')
        )
      ).toBe(true);
    } finally {
      await capture.invalidate();
      await rm(f.home, { recursive: true, force: true });
    }
  });
});

it('restores resumed child parser eligibility at the pre-launch watermark without retaining history', async () => {
  const f = await fixture('on');
  const childMeta = meta('child', 'root');
  await writeFile(f.path('root'), lines(meta('root')));
  await writeFile(
    f.path('child'),
    lines(
      { ...childMeta, payload: { ...childMeta.payload, forked_from_id: 'root' } },
      { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'child' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'historical body' } }
    )
  );
  const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
  try {
    await appendFile(
      f.path('child'),
      lines({ type: 'event_msg', payload: { type: 'agent_message', message: 'fresh body' } })
    );
    await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
    await capture.finalize();
    expect(
      f.received.filter(({ body }) => body).map(({ body }) => Buffer.from(body!).toString())
    ).toEqual(['fresh body']);
    expect(f.received.some(({ record }) => record.fact.reason === 'source-missing')).toBe(false);
  } finally {
    await capture.invalidate();
    await rm(f.home, { recursive: true, force: true });
  }
});

it('does not report a watermarked child as current-Turn activity without new source bytes', async () => {
  const f = await fixture('on');
  await writeFile(f.path('root'), lines(meta('root')));
  await writeFile(
    f.path('child'),
    lines(meta('child', 'root'), {
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'earlier Turn only' },
    })
  );
  const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
  try {
    await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
    await capture.finalize();
    const childRef = runtimeOriginRef('aep_live', 'child');
    expect(f.received.filter(({ record }) => record.fact.runtimeOriginRef === childRef)).toEqual(
      []
    );
    expect(
      f.received.every(
        ({ body }) => !body || !Buffer.from(body).toString().includes('earlier Turn only')
      )
    ).toBe(true);
  } finally {
    await capture.invalidate();
    await rm(f.home, { recursive: true, force: true });
  }
});

it('treats all anonymous outward message fields as one credential-admission unit', async () => {
  const f = await fixture('on');
  const capture = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
  try {
    await writeFile(f.path('root'), lines(meta('root')));
    await writeFile(
      f.path('child'),
      lines(meta('child', 'root'), {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'secret-' },
            { type: 'output_text', text: 'canary' },
          ],
        },
      })
    );
    await capture.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
    await capture.finalize();
    expect(f.received.some(({ body }) => body)).toBe(false);
    expect(
      f.received.some(
        ({ record }) =>
          record.content.state === 'unavailable' && record.content.reason === 'credential-excluded'
      )
    ).toBe(true);
  } finally {
    await capture.invalidate();
    await rm(f.home, { recursive: true, force: true });
  }
});

it('trusts an App Server rollout only when create is given that cli_version', async () => {
  const f = await fixture('on');
  const mismatched = await CodexRuntimeCapture.create(f.input, f.home, '0.153.4');
  try {
    await writeFile(f.path('root'), lines(meta('root', undefined, '0.159.2')));
    await mismatched.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
    await mismatched.finalize();
    expect(
      f.received.some(
        ({ record }) => record.fact.kind === 'coverage' && record.fact.reason === 'version-mismatch'
      )
    ).toBe(true);
  } finally {
    await mismatched.invalidate();
  }
  f.received.length = 0;
  const matched = await CodexRuntimeCapture.create(f.input, f.home, '0.159.2');
  try {
    await matched.writeStdout(Buffer.from(lines({ type: 'thread.started', thread_id: 'root' })));
    await matched.finalize();
    expect(
      f.received.some(
        ({ record }) => record.fact.kind === 'coverage' && record.fact.reason === 'version-mismatch'
      )
    ).toBe(false);
  } finally {
    await matched.invalidate();
    await rm(f.home, { recursive: true, force: true });
  }
});
