import { describe, expect, it } from 'vitest';
import { readWorkerInferenceRuntimeHint } from './worker-inference-runtime-hint.js';

/**
 * Creates pinned Codex 0.153.4 runtime metadata and its compatibility projections.
 *
 * @param overrides Optional canonical metadata overrides.
 * @param subagentHeader Optional native sub-agent compatibility header.
 * @returns Request headers and body metadata accepted by the runtime-hint reader.
 */
function createCodexRuntimeHintFixture(
  overrides: Record<string, unknown> = {},
  subagentHeader?: string
): {
  readonly clientMetadata: Record<string, string>;
  readonly headers: Headers;
  readonly turnMetadata: Record<string, unknown>;
} {
  const turnMetadata = {
    request_kind: 'turn',
    session_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e01',
    thread_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e02',
    turn_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e03',
    ...overrides,
  };
  const encoded = JSON.stringify(turnMetadata);
  const clientMetadata: Record<string, string> = {
    session_id: String(turnMetadata.session_id),
    thread_id: String(turnMetadata.thread_id),
    turn_id: String(turnMetadata.turn_id),
    'x-codex-turn-metadata': encoded,
  };
  const headers = new Headers({
    'session-id': String(turnMetadata.session_id),
    'thread-id': String(turnMetadata.thread_id),
    'x-client-request-id': String(turnMetadata.thread_id),
    'x-codex-turn-metadata': encoded,
  });

  if (typeof turnMetadata.parent_thread_id === 'string') {
    clientMetadata['x-codex-parent-thread-id'] = turnMetadata.parent_thread_id;
    headers.set('x-codex-parent-thread-id', turnMetadata.parent_thread_id);
  }
  if (subagentHeader) {
    clientMetadata['x-openai-subagent'] = subagentHeader;
    headers.set('x-openai-subagent', subagentHeader);
  }

  return { clientMetadata, headers, turnMetadata };
}

describe('worker inference runtime hints', () => {
  it('reads one canonical Codex root hint and its native cache lineage', () => {
    const fixture = createCodexRuntimeHintFixture();

    expect(
      readWorkerInferenceRuntimeHint(
        fixture.headers,
        {
          client_metadata: fixture.clientMetadata,
          prompt_cache_key: 'runtime-native-cache-lineage',
        },
        'codex'
      )
    ).toEqual({
      nativeCacheLineageId: 'runtime-native-cache-lineage',
      nativeSessionId: fixture.turnMetadata.session_id,
      nativeThreadId: fixture.turnMetadata.thread_id,
      nativeTurnId: fixture.turnMetadata.turn_id,
      runtimeFamily: 'codex',
    });
  });

  it('normalizes pinned Codex sub-agent and parent projections', () => {
    const fixture = createCodexRuntimeHintFixture(
      {
        parent_thread_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e04',
        subagent_kind: 'thread_spawn',
      },
      'collab_spawn'
    );

    expect(
      readWorkerInferenceRuntimeHint(
        fixture.headers,
        { client_metadata: fixture.clientMetadata },
        'codex'
      )
    ).toEqual({
      nativeSessionId: fixture.turnMetadata.session_id,
      nativeThreadId: fixture.turnMetadata.thread_id,
      nativeTurnId: fixture.turnMetadata.turn_id,
      parentNativeThreadId: fixture.turnMetadata.parent_thread_id,
      runtimeFamily: 'codex',
      subagentKind: 'thread_spawn',
    });
  });

  it('normalizes custom Codex sub-agent labels without retaining the label', () => {
    const fixture = createCodexRuntimeHintFixture({ subagent_kind: 'other' }, 'private-role-name');

    const hint = readWorkerInferenceRuntimeHint(
      fixture.headers,
      { client_metadata: fixture.clientMetadata },
      'codex'
    );

    expect(hint?.subagentKind).toBe('other');
    expect(JSON.stringify(hint)).not.toContain('private-role-name');
  });

  it('rejects malformed or conflicting Codex compatibility projections', () => {
    const malformed = createCodexRuntimeHintFixture();
    malformed.clientMetadata['x-codex-turn-metadata'] = '{';
    const mismatchedThread = createCodexRuntimeHintFixture();
    mismatchedThread.headers.set('x-client-request-id', 'different-thread');
    const mismatchedParent = createCodexRuntimeHintFixture(
      {
        parent_thread_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e04',
        subagent_kind: 'thread_spawn',
      },
      'review'
    );

    for (const fixture of [malformed, mismatchedThread, mismatchedParent]) {
      expect(() =>
        readWorkerInferenceRuntimeHint(
          fixture.headers,
          { client_metadata: fixture.clientMetadata },
          'codex'
        )
      ).toThrow('Worker inference runtime hint is invalid.');
    }
  });

  it('rejects present malformed canonical metadata instead of treating it as absent', () => {
    expect(() =>
      readWorkerInferenceRuntimeHint(
        new Headers(),
        { client_metadata: { 'x-codex-turn-metadata': { thread_id: 'nested-object' } } },
        'codex'
      )
    ).toThrow('Worker inference runtime hint is invalid.');
  });

  it('accepts only pinned worker Responses request kinds', () => {
    for (const requestKind of [undefined, 'unknown', 'memory']) {
      const fixture = createCodexRuntimeHintFixture({ request_kind: requestKind });

      expect(() =>
        readWorkerInferenceRuntimeHint(
          fixture.headers,
          { client_metadata: fixture.clientMetadata },
          'codex'
        )
      ).toThrow('Worker inference runtime hint is invalid.');
    }

    for (const requestKind of ['turn', 'prewarm', 'compaction']) {
      const fixture = createCodexRuntimeHintFixture({ request_kind: requestKind });

      expect(
        readWorkerInferenceRuntimeHint(
          fixture.headers,
          { client_metadata: fixture.clientMetadata },
          'codex'
        )?.nativeThreadId
      ).toBe(fixture.turnMetadata.thread_id);
    }
  });

  it('accepts pinned internal memory-consolidation projections without a subagent kind', () => {
    const fixture = createCodexRuntimeHintFixture({}, 'memory_consolidation');

    expect(
      readWorkerInferenceRuntimeHint(
        fixture.headers,
        { client_metadata: fixture.clientMetadata },
        'codex'
      )?.subagentKind
    ).toBe('memory_consolidation');
  });

  it('ignores ordinary provider metadata that is not a canonical runtime hint', () => {
    expect(
      readWorkerInferenceRuntimeHint(
        new Headers({ 'x-client-request-id': 'provider-request-id' }),
        {
          client_metadata: { private: 'provider-metadata' },
          prompt_cache_key: 'untrusted-cache-key',
        },
        'codex'
      )
    ).toBeUndefined();
  });
});
