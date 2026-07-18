import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;
let dataRootToRemove: string | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
  }

  if (dataRootToRemove) {
    await removeDataRoot(dataRootToRemove);
    dataRootToRemove = null;
  }
});

describe('nanocore e2e local restart replay', () => {
  it('restarts against the same data root and exposes durable thread state through app read models', async () => {
    harness = await startNanoCoreHarness();
    dataRootToRemove = harness.dataRoot;

    const workspaceId = 'ws_demo';
    const threadResponse = await fetch(`${harness.baseUrl}/api/workspaces/${workspaceId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Restart replay e2e', requestId: randomUUID() }),
    });
    const thread = (await threadResponse.json()) as { id: string; name: string };

    expect(threadResponse.status).toBe(201);

    const dataRoot = harness.dataRoot;
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot });

    const dashboardResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${workspaceId}/threads/${thread.id}/dashboard`
    );
    const dashboard = (await dashboardResponse.json()) as {
      thread: { id: string; name: string };
      turns: unknown[];
      artifacts: unknown[];
    };

    expect(dashboardResponse.status).toBe(200);
    expect(dashboard).toMatchObject({
      thread: { id: thread.id, name: 'Restart replay e2e' },
      turns: [],
      artifacts: [],
    });
  });
});
