import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
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
function createFetchFixture(responses: Array<{ body: unknown; ok?: boolean; status?: number }>): {
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
      text: async () => JSON.stringify(response.body),
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
      baseUrl: 'https://nanocore.local/api/worker-control',
    });

    await client.recordHeartbeat({ message: 'Worker running.', sequence: 1, status: 'running' });
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
        body: expect.objectContaining({ lineage, sequence: 1, status: 'running' }),
        headers: expect.objectContaining({ authorization: 'Bearer token_control_1' }),
        url: 'https://nanocore.local/api/worker-control/heartbeat',
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          artifact: expect.objectContaining({ title: 'Worker report' }),
          lineage,
          sequence: 2,
        }),
        headers: expect.objectContaining({ authorization: 'Bearer token_control_1' }),
        url: 'https://nanocore.local/api/worker-control/artifacts',
      }),
    ]);
  });

  it('polls commands and reports terminal results', async () => {
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
      { body: { terminalResult: { commandId: 'term_1', exitCode: 0 } } },
    ]);
    const client = new WorkerControlClient({
      fetch,
      lineage,
      token: 'token_control_1',
      baseUrl: 'https://nanocore.local/api/worker-control/',
    });

    const poll = await client.pollCommands();
    await client.recordTerminalResult({
      durationMs: 5,
      exitCode: 0,
      stderr: '',
      stdout: '/workspace/repo\n',
      terminalCommandId: 'term_1',
    });

    expect(poll.commands).toEqual([
      expect.objectContaining({ commandId: 'term_1', kind: 'terminal-command' }),
    ]);
    expect(requests.at(0)?.url).toBe('https://nanocore.local/api/worker-control/commands/poll');
    expect(requests.at(1)).toMatchObject({
      body: expect.objectContaining({
        exitCode: 0,
        lineage,
        terminalCommandId: 'term_1',
      }),
      url: 'https://nanocore.local/api/worker-control/terminal-results',
    });
  });

  it('posts interrupt acknowledgements with bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([{ body: { acknowledged: true } }]);
    const client = new WorkerControlClient({
      baseUrl: 'https://nanocore.local/api/worker-control',
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
        url: 'https://nanocore.local/api/worker-control/commands/ack',
      },
    ]);
  });

  it('appends canonical events with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { accepted: true, diagnostics: [], nextExpectedSequence: 4, schemaVersion: 1 } },
    ]);
    const client = new WorkerControlClient({
      fetch,
      lineage,
      token: 'token_control_1',
      baseUrl: 'https://nanocore.local/api/worker-control',
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
        url: 'https://nanocore.local/api/worker-control/events/append',
      }),
    ]);
  });

  it('does not start a request after the supervisor signal is already aborted', async () => {
    const controller = new AbortController();
    const abortReason = new Error('supervisor already stopped');
    let fetchCalls = 0;
    controller.abort(abortReason);
    const client = new WorkerControlClient({
      baseUrl: 'https://nanocore.local/api/worker-control',
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, text: async () => '{}' };
      },
      lineage,
      signal: controller.signal,
      token: 'token_control_1',
    });

    await expect(client.pollCommands()).rejects.toBe(abortReason);
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
      baseUrl: 'https://nanocore.local/api/worker-control',
    });

    await expect(client.recordHeartbeat({ sequence: 1, status: 'running' })).rejects.toThrowError(
      'Worker control request failed: worker_control_unauthorized'
    );
  });
});
