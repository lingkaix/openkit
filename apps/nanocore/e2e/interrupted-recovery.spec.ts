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

describe('nanocore e2e interrupted recovery', () => {
  it('materializes interrupted checkpoints and preserves pending user turns after restart', async () => {
    harness = await startNanoCoreHarness();
    dataRootToRemove = harness.dataRoot;

    const workspaceId = 'ws_demo';
    const threadId = 'th_demo';
    const createResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/recovery/interrupted-worker`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    const created = (await createResponse.json()) as {
      checkpoint: { turnId: string; stage: string };
      pendingUserTurn: { requestId: string; queueMode: string };
    };

    expect(createResponse.status).toBe(200);
    expect(created.checkpoint.stage).toBe('running_worker');
    expect(created.pendingUserTurn.queueMode).toBe('safe_point_steering');

    const dataRoot = harness.dataRoot;
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot });

    const interruptedResponse = await fetch(
      `${harness.baseUrl}/api/app/recovery/interrupted-workers`
    );
    const interrupted = (await interruptedResponse.json()) as {
      items: Array<{ turnId: string; kind: string; replayInstruction: boolean; stage: string }>;
    };

    expect(interruptedResponse.status).toBe(200);
    expect(interrupted.items).toContainEqual(
      expect.objectContaining({
        kind: 'interrupted_worker_state',
        replayInstruction: false,
        stage: 'running_worker',
        turnId: created.checkpoint.turnId,
      })
    );

    const pendingResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/recovery/pending-user-turns`
    );
    const pending = (await pendingResponse.json()) as {
      items: Array<{ requestId: string; queueMode: string }>;
    };

    expect(pendingResponse.status).toBe(200);
    expect(pending.items).toContainEqual(
      expect.objectContaining({
        queueMode: 'safe_point_steering',
        requestId: created.pendingUserTurn.requestId,
      })
    );

    const clearResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/recovery/interrupted-worker/${created.checkpoint.turnId}/terminal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ terminalStage: 'completed' }),
      }
    );

    expect(clearResponse.status).toBe(200);
    await expect(clearResponse.json()).resolves.toEqual({ cleared: true });

    const clearedResponse = await fetch(`${harness.baseUrl}/api/app/recovery/interrupted-workers`);

    expect(clearedResponse.status).toBe(200);
    await expect(clearedResponse.json()).resolves.toEqual({ items: [] });
  });
});
