import { createHash } from 'node:crypto';

import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { WorkerControlClient, type WorkerControlFetch } from './control-client.js';

const lineage: WorkerLineage = {
  agentSessionId: 'as_control_1',
  packageSnapshotId: 'pkg_snapshot_1',
  requestId: 'req_control_1',
  threadId: 'th_demo',
  turnId: 'turn_demo',
  workspaceId: 'ws_demo',
};

/**
 * Creates a fake fetch implementation that records requests and returns queued responses.
 *
 * @param responses Responses returned for successive calls.
 * @returns Fake fetch function and captured requests.
 */
function createFetchFixture(
  responses: Array<{ body?: unknown; ok?: boolean; status?: number; text?: string }>
): {
  fetch: WorkerControlFetch;
  requests: Array<{ body: unknown; headers: Record<string, string>; url: string }>;
} {
  const requests: Array<{ body: unknown; headers: Record<string, string>; url: string }> = [];
  const fetch: WorkerControlFetch = async (url, init) => {
    requests.push({
      body: JSON.parse(String(init?.body ?? '{}')) as unknown,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ])
      ),
      url,
    });
    const response = responses.shift() ?? { body: {}, ok: true, status: 200 };

    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.text ?? JSON.stringify(response.body ?? null),
    };
  };

  return { fetch, requests };
}

describe('WorkerControlClient', () => {
  it('sends heartbeat and artifact notices with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { heartbeat: { status: 'running' } } },
      { body: { artifact: { artifactId: 'worker-artifact-1' } } },
    ]);
    const client = new WorkerControlClient({
      fetch,
      lineage,
      token: 'token_control_1',
      baseUrl: '/worker-control',
    });

    await client.recordHeartbeat({ message: 'Worker running.', status: 'running' });
    await client.recordArtifactNotice({
      artifact: {
        mediaType: 'text/markdown',
        path: '/openkit/artifacts/report.md',
        title: 'Worker report',
      },
      sequence: 2,
    });

    expect(requests).toEqual([
      expect.objectContaining({
        body: {
          body: {
            message: 'Worker running.',
            processKeyHash: expect.any(String),
            status: 'running',
          },
          lineage,
          operation: 'heartbeat',
          schemaVersion: 2,
          sequence: 0,
        },
        headers: expect.objectContaining({ authorization: 'Bearer token_control_1' }),
        url: '/worker-control/heartbeat',
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          artifact: expect.objectContaining({ title: 'Worker report' }),
          lineage,
          sequence: 2,
        }),
        headers: expect.objectContaining({ authorization: 'Bearer token_control_1' }),
        url: '/worker-control/artifacts',
      }),
    ]);
  });

  it('returns polled commands as untrusted records', async () => {
    const { fetch, requests } = createFetchFixture([
      {
        body: {
          commands: [
            {
              argv: ['pwd'],
              commandId: 'term_1',
              kind: 'terminal-command',
            },
          ],
        },
      },
    ]);
    const client = new WorkerControlClient({
      fetch,
      lineage,
      token: 'token_control_1',
      baseUrl: '/worker-control/',
    });

    const poll = await client.pollCommands();

    expect(poll.commands).toEqual([
      expect.objectContaining({ commandId: 'term_1', kind: 'terminal-command' }),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/worker-control/commands/poll');
  });

  it('posts interrupt acknowledgements with bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([{ body: { acknowledged: true } }]);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch,
      lineage,
      token: 'token_control_1',
    });

    await client.acknowledgeCommand('interrupt_1');

    expect(requests).toEqual([
      {
        body: { commandId: 'interrupt_1', lineage },
        headers: {
          authorization: 'Bearer token_control_1',
          'content-type': 'application/json',
        },
        url: '/worker-control/commands/ack',
      },
    ]);
  });

  it('appends canonical events with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { accepted: true, diagnostics: [], nextExpectedSequence: 4, schemaVersion: 2 } },
    ]);
    const client = new WorkerControlClient({
      fetch,
      lineage,
      token: 'token_control_1',
      baseUrl: '/worker-control',
    });
    const record: WorkerCanonicalEventRecord = {
      event: {
        data: {
          delta: 'hello',
          itemId: 'candidate_item_1',
        },
        type: 'item.delta',
      },
      kind: 'event',
      lineage,
      schemaVersion: 2,
      sequence: 3,
    };

    await expect(client.appendEvent(record)).resolves.toMatchObject({
      accepted: true,
      nextExpectedSequence: 4,
    });
    expect(requests).toEqual([
      expect.objectContaining({
        body: { lineage, record },
        headers: expect.objectContaining({ authorization: 'Bearer token_control_1' }),
        url: '/worker-control/events/append',
      }),
    ]);
  });

  it.each([
    {
      expectedCode: 'worker_control_invalid_response',
      label: 'an empty response',
      response: { text: '' },
    },
    {
      expectedCode: 'worker_control_invalid_response',
      label: 'an empty object',
      response: { body: {} },
    },
    {
      expectedCode: 'worker_control_invalid_response',
      label: 'malformed JSON',
      response: { text: '{' },
    },
    {
      expectedCode: 'worker_control_not_accepted',
      label: 'an explicit rejection',
      response: { body: { accepted: false, diagnostics: [], schemaVersion: 2 } },
    },
  ])('rejects canonical event append with $label', async ({ expectedCode, response }) => {
    const { fetch, requests } = createFetchFixture([response]);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch,
      lineage,
      token: 'token_control_1',
    });
    const record: WorkerCanonicalEventRecord = {
      event: {
        data: { status: 'running' },
        type: 'worker.heartbeat',
      },
      kind: 'event',
      lineage,
      schemaVersion: 2,
      sequence: 3,
    };

    await expect(client.appendEvent(record)).rejects.toMatchObject({
      code: expectedCode,
      status: 200,
    });
    expect(requests).toHaveLength(1);
  });

  it('posts final status as a canonical control envelope', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { accepted: true, diagnostics: [], nextExpectedSequence: 5, schemaVersion: 2 } },
    ]);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch,
      lineage,
      token: 'token_control_1',
    });

    await expect(
      client.recordFinalStatus({
        diagnostics: { stderr: 'Product-safe failure summary.' },
        evidenceManifestDigests: { runtime: 'sha256:runtime' },
        sequence: 4,
        status: 'failed',
        stopReason: 'Codex process exited with code 7.',
      })
    ).resolves.toMatchObject({ accepted: true, nextExpectedSequence: 5 });
    expect(requests).toEqual([
      {
        body: {
          body: {
            diagnostics: { stderr: 'Product-safe failure summary.' },
            evidenceManifestDigests: { runtime: 'sha256:runtime' },
            status: 'failed',
            stopReason: 'Codex process exited with code 7.',
          },
          lineage,
          operation: 'final_status',
          schemaVersion: 2,
          sequence: 4,
        },
        headers: {
          authorization: 'Bearer token_control_1',
          'content-type': 'application/json',
        },
        url: '/worker-control/final-status',
      },
    ]);
  });

  it.each([
    {
      expectedCode: 'worker_control_invalid_response',
      label: 'an empty response',
      response: { text: '' },
    },
    {
      expectedCode: 'worker_control_invalid_response',
      label: 'an empty object',
      response: { body: {} },
    },
    {
      expectedCode: 'worker_control_invalid_response',
      label: 'malformed JSON',
      response: { text: '{' },
    },
    {
      expectedCode: 'worker_control_not_accepted',
      label: 'an explicit rejection',
      response: { body: { accepted: false, diagnostics: [], schemaVersion: 2 } },
    },
  ])('rejects final status delivery with $label', async ({ expectedCode, response }) => {
    const { fetch, requests } = createFetchFixture([response, response, response]);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch,
      lineage,
      token: 'token_control_1',
    });

    await expect(
      client.recordFinalStatus({
        sequence: 4,
        status: 'completed',
        stopReason: 'completed',
      })
    ).rejects.toMatchObject({ code: expectedCode, status: 200 });
    expect(requests).toHaveLength(1);
  });

  it('retries an ambiguous final status failure with the exact same envelope', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const ambiguousFailure = new TypeError('socket closed after request write');
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch: async (_url, init) => {
        requests.push(init.body);
        if (requests.length === 1) {
          throw ambiguousFailure;
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              accepted: true,
              diagnostics: [],
              nextExpectedSequence: 5,
              schemaVersion: 2,
            }),
        };
      },
      lineage,
      token: 'token_control_1',
    });
    client.enablePostLaunchRecovery();

    try {
      const delivery = client.recordFinalStatus({
        sequence: 4,
        status: 'completed',
        stopReason: 'completed',
      });
      await vi.advanceTimersByTimeAsync(250);

      await expect(delivery).resolves.toMatchObject({ accepted: true, nextExpectedSequence: 5 });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a definitive final status conflict', async () => {
    const { fetch, requests } = createFetchFixture([
      {
        body: { code: 'worker_control_final_status_conflict', message: 'Payload changed.' },
        ok: false,
        status: 409,
      },
      { body: { accepted: true, diagnostics: [], schemaVersion: 2 } },
    ]);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch,
      lineage,
      token: 'token_control_1',
    });

    await expect(
      client.recordFinalStatus({
        sequence: 4,
        status: 'completed',
        stopReason: 'completed',
      })
    ).rejects.toThrow('worker_control_final_status_conflict');
    expect(requests).toHaveLength(1);
  });

  it('does not start a request after the supervisor signal is already aborted', async () => {
    const controller = new AbortController();
    const abortReason = new Error('supervisor already stopped');
    let fetchCalls = 0;
    controller.abort(abortReason);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, text: async () => '{}' };
      },
      lineage,
      token: 'token_control_1',
    });

    await expect(client.pollCommands(controller.signal)).rejects.toBe(abortReason);
    expect(fetchCalls).toBe(0);
  });

  it('raises product-safe errors for rejected control requests', async () => {
    const { fetch } = createFetchFixture([
      {
        body: { code: 'worker_control_unauthorized', message: 'Token rejected.' },
        ok: false,
        status: 401,
      },
    ]);
    const client = new WorkerControlClient({
      fetch,
      lineage,
      token: 'bad',
      baseUrl: '/worker-control',
    });

    await expect(client.recordHeartbeat({ status: 'running' })).rejects.toThrowError(
      'Worker control request failed: worker_control_unauthorized'
    );
  });

  it('retries a post-launch request timeout inside the shared outage budget', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    try {
      const client = new WorkerControlClient({
        baseUrl: '/worker-control',
        fetch: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Promise(() => undefined);
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ commands: [] }),
          };
        },
        lineage,
        token: 'token_control_1',
      });
      client.enablePostLaunchRecovery();

      const poll = client.pollCommands().then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await vi.advanceTimersByTimeAsync(10_250);

      await expect(poll).resolves.toEqual({ value: { commands: [] } });
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects with the same process key before replaying one blocked request', async () => {
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    let pollAttempts = 0;
    let reconnected = false;
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch: async (url, init) => {
        const path = url;
        const body = JSON.parse(init.body) as Record<string, unknown>;

        requests.push({ body, path });
        if (path.endsWith('/heartbeat')) {
          if (body.sequence !== 0) {
            reconnected = true;
          }
          return { ok: true, status: 200, text: async () => '{}' };
        }
        pollAttempts += 1;
        if (pollAttempts <= 2) {
          return {
            ok: false,
            status: 503,
            text: async () =>
              JSON.stringify({
                code: 'worker_control_reconnect_required',
                diagnostics: [],
                message: 'Reconnect before retrying.',
                retryable: true,
              }),
          };
        }
        if (!reconnected) {
          return {
            ok: false,
            status: 409,
            text: async () => JSON.stringify({ code: 'request_replayed_before_reconnect' }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ commands: [] }) };
      },
      lineage,
      token: 'token_control_1',
    });
    await client.recordHeartbeat({ status: 'starting' });
    client.enablePostLaunchRecovery();
    await expect(Promise.all([client.pollCommands(), client.pollCommands()])).resolves.toEqual([
      { commands: [] },
      { commands: [] },
    ]);

    const [initial, firstPoll, secondPoll, reconnect, replayedFirstPoll, replayedSecondPoll] =
      requests;
    expect(requests.map(({ path }) => path)).toEqual([
      '/worker-control/heartbeat',
      '/worker-control/commands/poll',
      '/worker-control/commands/poll',
      '/worker-control/heartbeat',
      '/worker-control/commands/poll',
      '/worker-control/commands/poll',
    ]);
    expect(reconnect?.body).toMatchObject({ lineage, operation: 'heartbeat', sequence: 1 });
    expect(replayedFirstPoll?.body).toEqual(firstPoll?.body);
    expect(replayedSecondPoll?.body).toEqual(secondPoll?.body);
    const processKeyHash = (initial!.body.body as { processKeyHash?: unknown }).processKeyHash;
    const reconnectKey = reconnect?.body.reconnectKey;

    expect(processKeyHash).toEqual(expect.any(String));
    expect(reconnectKey).toEqual(expect.any(String));
    expect(
      createHash('sha256')
        .update(Buffer.from(String(reconnectKey), 'base64url'))
        .digest('base64url')
    ).toBe(processKeyHash);
  });

  it('shares one reconnect heartbeat with a simultaneously blocked heartbeat', async () => {
    let reconnectAttempts = 0;
    let reconnected = false;
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch: async (url, init) => {
        const path = url;
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (path.endsWith('/heartbeat') && body.sequence === 0) {
          return { ok: true, status: 200, text: async () => '{}' };
        }
        if (path.endsWith('/heartbeat') && body.reconnectKey) {
          reconnectAttempts += 1;
          if (reconnectAttempts > 1) {
            return {
              ok: false,
              status: 409,
              text: async () => JSON.stringify({ code: 'worker_control_identity_conflict' }),
            };
          }
          reconnected = true;
          return { ok: true, status: 200, text: async () => '{}' };
        }
        if (!reconnected) {
          return {
            ok: false,
            status: 503,
            text: async () =>
              JSON.stringify({
                code: 'worker_control_reconnect_required',
                message: 'Reconnect before retrying.',
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(path.endsWith('/commands/poll') ? { commands: [] } : {}),
        };
      },
      lineage,
      token: 'token_control_1',
    });
    await client.recordHeartbeat({ status: 'starting' });
    client.enablePostLaunchRecovery();

    await expect(
      Promise.all([client.recordHeartbeat({ status: 'running' }), client.pollCommands()])
    ).resolves.toEqual([{}, { commands: [] }]);
    expect(reconnectAttempts).toBe(1);
  });
});
