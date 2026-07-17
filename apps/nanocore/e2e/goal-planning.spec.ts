import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('nanocore e2e goal planning', () => {
  it('creates, approves, supervises, and completes a deterministic Goal Mode plan without providers', async () => {
    harness = await startNanoCoreHarness({ useSimulator: false });

    const threadResponse = await fetch(`${harness.baseUrl}/api/workspaces/ws_demo/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Goal planning e2e',
        requestId: randomUUID(),
      }),
    });
    const thread = (await threadResponse.json()) as { id: string };

    expect(threadResponse.status).toBe(201);
    expect(thread.id).toMatch(/^th_/);

    const goalResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/threads/${thread.id}/goal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      }
    );

    expect(goalResponse.status).toBe(200);

    const planResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID() }),
      }
    );
    const planPayload = (await planResponse.json()) as {
      goal: { goalId: string; status: string };
      planItemId: string;
      plan: { tasks: readonly [{ taskId: string; title: string }] };
      status: string;
    };

    expect(planResponse.status).toBe(200);
    expect(planPayload).toMatchObject({
      status: 'awaiting_plan_approval',
      goal: { status: 'awaiting_plan_approval' },
      plan: { tasks: [{ taskId: 'task_1', title: 'Ship v0.0.6' }] },
    });

    const approveResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: randomUUID(),
          planItemId: planPayload.planItemId,
        }),
      }
    );

    expect(approveResponse.status).toBe(200);
    await expect(approveResponse.json()).resolves.toMatchObject({
      goal: {
        goalId: planPayload.goal.goalId,
        status: 'running',
        taskCounts: {
          ready: 1,
        },
      },
      readyTasks: [{ taskId: 'task_1', status: 'ready' }],
      startsWorkerTurn: false,
    });

    const summaryResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/threads/${thread.id}/goal`
    );

    expect(summaryResponse.status).toBe(200);
    await expect(summaryResponse.json()).resolves.toMatchObject({
      goal: {
        status: 'running',
        currentTask: null,
        taskCounts: {
          ready: 1,
          pending: 0,
        },
      },
    });

    const superviseResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/threads/${thread.id}/goal/test/supervise/step`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    );

    expect(superviseResponse.status).toBe(200);
    await expect(superviseResponse.json()).resolves.toMatchObject({
      goal: {
        status: 'completed',
        taskCounts: {
          completed: 1,
          ready: 0,
        },
        terminalState: {
          status: 'completed',
          stopReason: 'completed',
        },
      },
      task: {
        taskId: 'task_1',
        status: 'completed',
      },
      worker: {
        stopReason: 'completed',
        checkpointStage: 'completed',
      },
      review: {
        verdict: 'accept',
      },
      advance: {
        outcome: 'complete_goal',
        nextReadyTaskId: null,
      },
    });
  });
});
