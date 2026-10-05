import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

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

/** One artifact notice used where a test needs an ordinary non-heartbeat request. */
const notice = {
  artifact: { path: '/openkit/artifacts/report.md', title: 'Worker report' },
  sequence: 1,
};

describe('WorkerControlClient', () => {
  it('strips additive acknowledgement fields before returning the accepted result', async () => {
    const fixture = createFetchFixture([
      {
        body: {
          schemaVersion: 2,
          accepted: true,
          diagnostics: [{ code: 'ok', message: 'accepted', futureNote: true }],
          futureNote: 'ignored',
        },
      },
    ]);
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      lineage,
      token: 'control',
      fetch: fixture.fetch,
    });
    await expect(
      client.recordFinalStatus({ sequence: 1, status: 'completed', stopReason: 'completed' })
    ).resolves.toEqual({
      schemaVersion: 2,
      accepted: true,
      diagnostics: [{ code: 'ok', message: 'accepted' }],
    });
  });

  it('contains throwing recorder callbacks without changing heartbeat transport outcomes', async () => {
    const fixture = createFetchFixture([
      { body: { accepted: true } },
      { ok: false, status: 403, body: { code: 'worker_control_lease_not_live' } },
    ]);
    const recordLifecycleFact = vi.fn(() => {
      throw new Error('recorder fault');
    });
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      lineage,
      token: 'control',
      fetch: fixture.fetch,
      recordLifecycleFact,
    });
    await expect(client.recordHeartbeat({ status: 'starting' })).resolves.toEqual({
      accepted: true,
    });
    await expect(client.recordHeartbeat({ status: 'running' })).rejects.toMatchObject({
      code: 'worker_control_lease_not_live',
    });
    expect(fixture.requests).toHaveLength(2);
    expect(recordLifecycleFact).toHaveBeenCalledTimes(4);
  });

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
      schemaVersion: 1,
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
      schemaVersion: 1,
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

    await expect(client.recordArtifactNotice(notice, controller.signal)).rejects.toBe(abortReason);
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
            text: async () => JSON.stringify({ accepted: true }),
          };
        },
        lineage,
        token: 'token_control_1',
      });
      client.enablePostLaunchRecovery();

      const pending = client.recordArtifactNotice(notice).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await vi.advanceTimersByTimeAsync(10_250);

      await expect(pending).resolves.toEqual({ value: { accepted: true } });
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not renew a pending event outage budget when independent heartbeats succeed', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const attempts: string[] = [];
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      lineage,
      token: 'control-fixture',
      fetch: async (url, init) => {
        if (url.endsWith('/heartbeat')) {
          return { ok: true, status: 200, text: async () => '{}' };
        }
        attempts.push(init.body);
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ code: 'worker_control_unavailable' }),
        };
      },
    });
    let outcome: unknown;
    let pending: Promise<void> | undefined;
    try {
      await client.recordHeartbeat({ status: 'starting' });
      client.enablePostLaunchRecovery();
      pending = client
        .appendEvent(
          {
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 0,
            event: { type: 'worker.ready', data: {} },
          },
          controller.signal
        )
        .then(
          (value) => {
            outcome = { value };
          },
          (error: unknown) => {
            outcome = { error };
          }
        );
      await delay(0);
      expect(attempts).toHaveLength(1);
      await client.recordHeartbeat({ status: 'running' });
      now = 300_001;
      await delay(300);
      expect(outcome).toMatchObject({
        error: { message: 'Worker control outage budget expired.' },
      });
      expect(attempts).toHaveLength(1);
    } finally {
      controller.abort();
      await pending;
      clock.mockRestore();
    }
  });

  it('reconnects with the same process key before replaying one blocked request', async () => {
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    let noticeAttempts = 0;
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
        noticeAttempts += 1;
        if (noticeAttempts <= 2) {
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
        return { ok: true, status: 200, text: async () => JSON.stringify({ accepted: true }) };
      },
      lineage,
      token: 'token_control_1',
    });
    await client.recordHeartbeat({ status: 'starting' });
    client.enablePostLaunchRecovery();
    await expect(
      Promise.all([client.recordArtifactNotice(notice), client.recordArtifactNotice(notice)])
    ).resolves.toEqual([{ accepted: true }, { accepted: true }]);

    const [
      initial,
      firstNotice,
      secondNotice,
      reconnect,
      replayedFirstNotice,
      replayedSecondNotice,
    ] = requests;
    expect(requests.map(({ path }) => path)).toEqual([
      '/worker-control/heartbeat',
      '/worker-control/artifacts',
      '/worker-control/artifacts',
      '/worker-control/heartbeat',
      '/worker-control/artifacts',
      '/worker-control/artifacts',
    ]);
    expect(reconnect?.body).toMatchObject({ lineage, operation: 'heartbeat', sequence: 1 });
    expect(replayedFirstNotice?.body).toEqual(firstNotice?.body);
    expect(replayedSecondNotice?.body).toEqual(secondNotice?.body);
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

  it('serializes reconnect proof behind an in-flight lease heartbeat without reusing its sequence', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heartbeatPending = false;
    let eventAttempts = 0;
    let reconnectAttempts = 0;
    let activeHeartbeats = 0;
    let maxActiveHeartbeats = 0;
    let reconnected = false;
    const acceptedSequences: number[] = [];
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      lineage,
      token: 'control-fixture',
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('/heartbeat')) {
          activeHeartbeats += 1;
          maxActiveHeartbeats = Math.max(maxActiveHeartbeats, activeHeartbeats);
          try {
            if (body.sequence === 1 && !body.reconnectKey) {
              heartbeatPending = true;
              await gate;
              return {
                ok: false,
                status: 503,
                text: async () => JSON.stringify({ code: 'worker_control_reconnect_required' }),
              };
            }
            if (body.reconnectKey) {
              reconnectAttempts += 1;
              reconnected = true;
            }
            expect(body.sequence).toBe(acceptedSequences.length);
            acceptedSequences.push(body.sequence);
            return { ok: true, status: 200, text: async () => '{}' };
          } finally {
            activeHeartbeats -= 1;
          }
        }
        eventAttempts += 1;
        return reconnected
          ? {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
            }
          : {
              ok: false,
              status: 503,
              text: async () => JSON.stringify({ code: 'worker_control_reconnect_required' }),
            };
      },
    });
    await client.recordHeartbeat({ status: 'starting' });
    client.enablePostLaunchRecovery();
    const heartbeat = client.recordHeartbeat({ status: 'running' });
    await vi.waitFor(() => expect(heartbeatPending).toBe(true));
    const event = client.appendEvent({
      kind: 'event',
      lineage,
      schemaVersion: 1,
      sequence: 0,
      event: { type: 'worker.ready', data: {} },
    });
    try {
      await vi.waitFor(() => expect(eventAttempts).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(maxActiveHeartbeats).toBe(1);
      expect(reconnectAttempts).toBe(0);
    } finally {
      release();
      await Promise.allSettled([heartbeat, event]);
    }
    await expect(heartbeat).resolves.toEqual({});
    await expect(event).resolves.toMatchObject({ accepted: true });
    expect(acceptedSequences).toEqual([0, 1]);
    expect(reconnectAttempts).toBe(1);
    expect(maxActiveHeartbeats).toBe(1);
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
          text: async () => JSON.stringify(path.endsWith('/artifacts') ? { accepted: true } : {}),
        };
      },
      lineage,
      token: 'token_control_1',
    });
    await client.recordHeartbeat({ status: 'starting' });
    client.enablePostLaunchRecovery();

    await expect(
      Promise.all([
        client.recordHeartbeat({ status: 'running' }),
        client.recordArtifactNotice(notice),
      ])
    ).resolves.toEqual([{}, { accepted: true }]);
    expect(reconnectAttempts).toBe(1);
  });
});
