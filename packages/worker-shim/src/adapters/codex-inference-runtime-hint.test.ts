import { describe, expect, it } from 'vitest';
import { codexInferenceRuntimeHintMapping } from './codex-inference-runtime-hint.js';

const readCodexInferenceRuntimeHint = codexInferenceRuntimeHintMapping.map;

/**
 * Constructs synthetic canonical Codex runtime metadata and its compatibility projections.
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
      readCodexInferenceRuntimeHint(fixture.headers, {
        client_metadata: fixture.clientMetadata,
        prompt_cache_key: 'runtime-native-cache-lineage',
      })
    ).toEqual({
      nativeCacheLineageId: 'runtime-native-cache-lineage',
      nativeSessionId: fixture.turnMetadata.session_id,
      nativeThreadId: fixture.turnMetadata.thread_id,
      nativeTurnId: fixture.turnMetadata.turn_id,
      runtimeFamily: 'codex',
      requestKind: 'turn',
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
      readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
    ).toEqual({
      nativeSessionId: fixture.turnMetadata.session_id,
      nativeThreadId: fixture.turnMetadata.thread_id,
      nativeTurnId: fixture.turnMetadata.turn_id,
      parentNativeThreadId: fixture.turnMetadata.parent_thread_id,
      runtimeFamily: 'codex',
      requestKind: 'turn',
      subagentKind: 'thread_spawn',
    });
  });

  it('normalizes custom Codex sub-agent labels without retaining the label', () => {
    const fixture = createCodexRuntimeHintFixture({ subagent_kind: 'other' }, 'private-role-name');

    const hint = readCodexInferenceRuntimeHint(fixture.headers, {
      client_metadata: fixture.clientMetadata,
    });

    expect(hint?.subagentKind).toBe('other');
    expect(JSON.stringify(hint)).not.toContain('private-role-name');
  });

  it('reads the 0.166 body-only tool inventory at the 16 KiB bound without retaining it', () => {
    // responses_metadata.rs keeps the inventory in client_metadata and omits it from headers.
    const fixture = createCodexRuntimeHintFixture();
    const inventory = {
      private_namespace: {
        name: 'private-namespace',
        functions: {
          private_tool: {
            name: 'private-tool',
            direct: true,
            code_mode_name: null,
            deferred: false,
            source: { kind: 'mcp', server_name: 'private-server' },
          },
        },
      },
    };
    fixture.turnMetadata.tool_namespaces_info = inventory;
    inventory.private_namespace.functions.private_tool.name += 'x'.repeat(
      16 * 1024 - JSON.stringify(fixture.turnMetadata).length
    );
    fixture.clientMetadata['x-codex-turn-metadata'] = JSON.stringify(fixture.turnMetadata);
    expect(fixture.clientMetadata['x-codex-turn-metadata']).toHaveLength(16 * 1024);

    const hint = readCodexInferenceRuntimeHint(fixture.headers, {
      client_metadata: fixture.clientMetadata,
      prompt_cache_key: 'runtime-native-cache-lineage',
    });

    // Runtime Call Origin permits only the normalized lineage fields in the ephemeral hint.
    expect(hint).toEqual({
      nativeCacheLineageId: 'runtime-native-cache-lineage',
      nativeSessionId: fixture.turnMetadata.session_id,
      nativeThreadId: fixture.turnMetadata.thread_id,
      nativeTurnId: fixture.turnMetadata.turn_id,
      runtimeFamily: 'codex',
      requestKind: 'turn',
    });
    expect(JSON.stringify(hint)).not.toContain('private-');
    expect(JSON.stringify(hint)).not.toContain('tool_namespaces_info');
  });

  it.each([
    ['session_id', 'different-session'],
    ['thread_id', 'different-thread'],
    ['turn_id', 'different-turn'],
    ['request_kind', 'prewarm'],
    ['parent_thread_id', 'different-parent'],
    ['subagent_kind', 'review'],
    ['sandbox_mode', 'read-only'],
  ])('rejects a conflicting %s in the direct metadata projection', (field, value) => {
    const fixture = createCodexRuntimeHintFixture(
      {
        parent_thread_id: 'native-parent',
        subagent_kind: 'thread_spawn',
        sandbox_mode: 'danger-full-access',
      },
      'collab_spawn'
    );
    fixture.headers.set(
      'x-codex-turn-metadata',
      JSON.stringify({ ...fixture.turnMetadata, [field]: value })
    );
    fixture.clientMetadata['x-codex-turn-metadata'] = JSON.stringify({
      ...fixture.turnMetadata,
      tool_namespaces_info: {},
    });

    expect(() =>
      readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
    ).toThrow('Worker inference runtime hint is invalid.');
  });

  it.each([
    'body',
    'header',
  ])('rejects %s metadata above the unchanged 16 KiB bound', (location) => {
    const fixture = createCodexRuntimeHintFixture();
    const encoded = JSON.stringify(fixture.turnMetadata);
    // Legal JSON whitespace makes the input oversized without a parse error masking the bound.
    const oversized = encoded + ' '.repeat(16 * 1024 + 1 - encoded.length);
    if (location === 'body') {
      fixture.clientMetadata['x-codex-turn-metadata'] = oversized;
    } else {
      // Headers trim surrounding whitespace, so place it inside the JSON object.
      fixture.headers.set('x-codex-turn-metadata', `{${' '.repeat(16 * 1024)}${encoded.slice(1)}`);
    }

    expect(() =>
      readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
    ).toThrow('Worker inference runtime hint is invalid.');
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
        readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
      ).toThrow('Worker inference runtime hint is invalid.');
    }
  });

  it('rejects present malformed canonical metadata instead of treating it as absent', () => {
    expect(() =>
      readCodexInferenceRuntimeHint(new Headers(), {
        client_metadata: { 'x-codex-turn-metadata': { thread_id: 'nested-object' } },
      })
    ).toThrow('Worker inference runtime hint is invalid.');
  });

  it('accepts only pinned worker Responses request kinds', () => {
    for (const requestKind of [undefined, 'unknown', 'memory']) {
      const fixture = createCodexRuntimeHintFixture({ request_kind: requestKind });

      expect(() =>
        readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
      ).toThrow('Worker inference runtime hint is invalid.');
    }

    for (const requestKind of ['turn', 'prewarm', 'compaction']) {
      const fixture = createCodexRuntimeHintFixture({ request_kind: requestKind });

      expect(
        readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
          ?.requestKind
      ).toBe(requestKind);
    }
  });

  it('accepts pinned internal memory-consolidation projections without a subagent kind', () => {
    const fixture = createCodexRuntimeHintFixture({}, 'memory_consolidation');

    expect(
      readCodexInferenceRuntimeHint(fixture.headers, { client_metadata: fixture.clientMetadata })
        ?.subagentKind
    ).toBe('memory_consolidation');
  });

  it('ignores ordinary provider metadata that is not a canonical runtime hint', () => {
    expect(
      readCodexInferenceRuntimeHint(new Headers({ 'x-client-request-id': 'provider-request-id' }), {
        client_metadata: { private: 'provider-metadata' },
        prompt_cache_key: 'untrusted-cache-key',
      })
    ).toBeUndefined();
  });
});
