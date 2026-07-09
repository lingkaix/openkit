import { afterEach, describe, expect, it } from 'vitest';
import {
  answerUserInput,
  grantApproval,
  linkWorkspaceRepository,
  type NanoCoreHarness,
  readTurnEventsUntil,
  removeDataRoot,
  startNanoCoreHarness,
  startSimulatorTurn,
} from './_lib/harness.js';

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
  it('restarts against the same data root and exposes replayed state through app read models', async () => {
    harness = await startNanoCoreHarness();
    dataRootToRemove = harness.dataRoot;

    const workspaceId = 'ws_demo';
    const threadId = 'th_demo';
    await linkWorkspaceRepository(harness.baseUrl, harness.dataRoot, workspaceId);
    const turn = await startSimulatorTurn(
      harness.baseUrl,
      workspaceId,
      threadId,
      'Run restart replay verification.'
    );
    const turnId = String(turn.id);

    await readTurnEventsUntil(
      harness.baseUrl,
      workspaceId,
      threadId,
      turnId,
      (event) => event.event === 'approval.requested'
    );
    await grantApproval(harness.baseUrl, workspaceId, threadId, turnId, `ap_${turnId}`);
    await answerUserInput(harness.baseUrl, workspaceId, threadId, turnId, 'concise');
    await readTurnEventsUntil(
      harness.baseUrl,
      workspaceId,
      threadId,
      turnId,
      (event) => event.event === 'turn.completed'
    );

    const dataRoot = harness.dataRoot;
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot });

    const dashboardResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/dashboard`
    );
    const itemsResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/items`
    );
    const dashboard = (await dashboardResponse.json()) as {
      turns: Array<{ id: string; status: string }>;
      artifacts: Array<{ title: string }>;
    };
    const items = (await itemsResponse.json()) as {
      items: Array<{ turnId: string; type: string }>;
    };

    expect(dashboard.turns).toContainEqual(
      expect.objectContaining({ id: turnId, status: 'completed' })
    );
    expect(dashboard.artifacts).toContainEqual(
      expect.objectContaining({ title: 'Simulated protocol summary' })
    );
    expect(items.items).toContainEqual(
      expect.objectContaining({ turnId, type: 'artifact-reference' })
    );
  });
});
