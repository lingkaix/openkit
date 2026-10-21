import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductTurnSchema, SseEventEnvelopeSchema, workspaceIdForOwner } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

/** Creates one persisted running turn and busy AgentSession. */
async function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-turn-failure-'));
  const store = await createDemoStore({ dataRoot });
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Run governed worker',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    {
      turnId: 'tu_00000000-0000-7cfa-813c-d5549b2b9ef9',
    }
  );
  await store.createAgentSession({
    agentId: 'agent_codex_host',
    createdAt: turn.startedAt ?? '2026-07-15T00:00:00.000Z',
    id: 'as_00000000-0000-770e-a08d-6c9479c1d1f5',
    message: null,
    status: 'busy',
    threadId: turn.threadId,
    updatedAt: turn.startedAt ?? '2026-07-15T00:00:00.000Z',
    workspaceId: workspaceIdForOwner(turn.owner),
  });
  return { dataRoot, store, turn };
}

/** Runs the shared governed-worker failure projection. */
async function projectFailure(store: FsStore) {
  return await terminalizeGovernedWorkerTurn({
    agentSessionId: 'as_00000000-0000-770e-a08d-6c9479c1d1f5',
    completedAt: '2026-07-15T00:01:00.000Z',
    errorCode: 'worker_governance_restart_recovery',
    message: 'Worker execution stopped during NanoCore restart recovery.',
    outcome: 'failed',
    requestId: null,
    store,
    turnId: 'tu_00000000-0000-7cfa-813c-d5549b2b9ef9',
  });
}

/** Runs the shared governed-worker interruption projection. */
async function projectInterruption(store: FsStore) {
  return await terminalizeGovernedWorkerTurn({
    agentSessionId: 'as_00000000-0000-770e-a08d-6c9479c1d1f5',
    completedAt: '2026-07-15T00:01:00.000Z',
    errorCode: 'worker_governance_restart_recovery',
    message: 'Worker execution was interrupted during NanoCore restart recovery.',
    outcome: 'interrupted',
    requestId: null,
    store,
    turnId: 'tu_00000000-0000-7cfa-813c-d5549b2b9ef9',
  });
}

describe('governed worker turn failure projection', () => {
  it('repairs a decided delivery_unknown failure after a cold restart without changing its outcome', async () => {
    const { dataRoot, store, turn } = await createFixture();
    await store.updateTurn(turn.id, {
      status: 'failed',
      completedAt: '2026-07-15T00:00:30.000Z',
      error: { code: 'delivery_unknown', message: 'Outcome delivery could not be proved.' },
    });
    const decided = store.getTurnById(turn.id);
    const restarted = new FsStore({ dataRoot });
    await projectFailure(restarted);
    await projectFailure(restarted);
    expect(restarted.getTurnById(turn.id)).toEqual(decided);
    expect(restarted.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      status: 'failed',
      message: decided.error!.message,
    });
    expect(
      restarted.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
    expect(
      restarted.getTurnEvents(turn.id).filter((event) => event.event === 'agent.session.updated')
    ).toHaveLength(1);
  });

  it('retains the first normalized explanation in cold reads, lists and terminal events', async () => {
    const { dataRoot, store, turn } = await createFixture();
    const explanation = {
      code: 'git_fetch_http_refused',
      stage: 'workspace_materialization',
      operation: 'git.fetch',
      dependency: 'git_remote',
      producer: 'worker-shim',
      observedAt: '2026-09-22T00:00:00.000Z',
      basis: 'direct_observation',
      subprocess: 'exit',
      httpStatus: 403,
      enforcement: 'unavailable',
      evidence: { availability: 'partial', outputTruncated: false },
    } as const;
    await terminalizeGovernedWorkerTurn({
      agentSessionId: 'as_00000000-0000-770e-a08d-6c9479c1d1f5',
      completedAt: '2026-09-22T00:00:01.000Z',
      errorCode: 'worker_governance_turn_failed',
      message: 'Repository HTTP refusal; attribution unavailable.',
      explanation,
      outcome: 'failed',
      requestId: null,
      store,
      turnId: turn.id,
    });
    const cold = new FsStore({ dataRoot });
    // Restart repair cannot replace the original diagnostic with a generic cleanup error.
    await projectFailure(cold);
    expect(cold.getTurnById(turn.id).error?.explanation).toEqual(explanation);
    expect(
      ProductTurnSchema.parse(
        cold.listThreadTurns(workspaceIdForOwner(turn.owner), turn.threadId)[0]
      ).error?.explanation
    ).toEqual(explanation);
    const events = cold.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed');
    expect(events).toHaveLength(1);
    expect(SseEventEnvelopeSchema.parse(events[0])).toMatchObject({
      data: { turn: { error: { explanation } } },
    });
    expect(JSON.stringify({ turn: cold.getTurnById(turn.id), events })).not.toContain(
      'canary-secret'
    );
  });

  it('treats a missing pre-anchor turn as an idempotent no-op', async () => {
    const store = await createDemoStore();

    expect(await projectFailure(store)).toEqual({ status: 'missing' });
  });

  it('fails an existing turn when its AgentSession was not durably created', async () => {
    const store = await createDemoStore();
    await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Crash before session write',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      {
        turnId: 'tu_00000000-0000-7cfa-813c-d5549b2b9ef9',
      }
    );

    expect(await projectFailure(store)).toMatchObject({ status: 'failed' });
    expect(store.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      status: 'failed',
    });
    expect(
      store
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it('interrupts an anchored turn and session exactly once after restart cleanup', async () => {
    const { dataRoot, store } = await createFixture();

    expect(await projectInterruption(store)).toMatchObject({ status: 'interrupted' });
    expect(await projectInterruption(new FsStore({ dataRoot }))).toMatchObject({
      status: 'interrupted',
    });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      error: {
        code: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during NanoCore restart recovery.',
      },
      status: 'interrupted',
    });
    expect(reloaded.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: 'Worker execution was interrupted during NanoCore restart recovery.',
      status: 'interrupted',
    });
    expect(
      reloaded
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'aborted'
        )
    ).toHaveLength(1);
  });

  it('fails closed when product-store reads fail for reasons other than not-found', async () => {
    const { store } = await createFixture();
    const turnRead = vi.spyOn(store, 'getTurnById').mockImplementation(() => {
      throw new Error('turn store is corrupt');
    });

    await expect(projectFailure(store)).rejects.toThrow('turn store is corrupt');
    turnRead.mockRestore();

    const sessionRead = vi.spyOn(store, 'getAgentSession').mockImplementation(() => {
      throw new Error('AgentSession store is corrupt');
    });
    await expect(projectFailure(store)).rejects.toThrow('AgentSession store is corrupt');
    sessionRead.mockRestore();
  });

  it('preserves a durable successful terminal event when the turn row is still running', async () => {
    const { dataRoot, store, turn } = await createFixture();
    const completed = {
      ...turn,
      completedAt: '2026-07-15T00:00:30.000Z',
      error: null,
      status: 'completed' as const,
    };
    store.emitTurnEvent(turn.id, {
      data: { stopReason: 'completed', turn: completed, type: 'turn-completed' },
      event: 'turn.completed',
      requestId: null,
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: workspaceIdForOwner(turn.owner),
    });

    expect(await projectFailure(store)).toMatchObject({ status: 'completed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById(turn.id)).toMatchObject({
      completedAt: '2026-07-15T00:00:30.000Z',
      error: null,
      status: 'completed',
    });
    expect(
      reloaded
        .getTurnEvents(turn.id)
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toEqual([]);
  });

  it('fails a running turn and session exactly once across store reloads', async () => {
    const { dataRoot, store } = await createFixture();

    expect(await projectFailure(store)).toMatchObject({ status: 'failed' });
    expect(await projectFailure(new FsStore({ dataRoot }))).toMatchObject({ status: 'failed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      error: {
        code: 'worker_governance_restart_recovery',
        message: 'Worker execution stopped during NanoCore restart recovery.',
      },
      status: 'failed',
    });
    expect(reloaded.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: 'Worker execution stopped during NanoCore restart recovery.',
      status: 'failed',
    });
    expect(
      reloaded
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it('preserves a completed turn and does not fail its session', async () => {
    const { dataRoot, store } = await createFixture();
    const completed = await store.updateTurn('tu_00000000-0000-7cfa-813c-d5549b2b9ef9', {
      completedAt: '2026-07-15T00:00:30.000Z',
      error: null,
      status: 'completed',
    });
    await store.updateAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5', {
      message: null,
      status: 'idle',
      updatedAt: '2026-07-15T00:00:30.000Z',
    });
    store.emitTurnEvent(completed.id, {
      data: { stopReason: 'completed', turn: completed, type: 'turn-completed' },
      event: 'turn.completed',
      requestId: null,
      threadId: completed.threadId,
      turnId: completed.id,
      workspaceId: workspaceIdForOwner(completed.owner),
    });

    expect(await projectFailure(store)).toMatchObject({ status: 'completed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      error: null,
      status: 'completed',
    });
    expect(reloaded.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: null,
      status: 'idle',
    });
    expect(
      reloaded
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toEqual([]);
  });

  it('repairs missing success events for an already completed turn exactly once', async () => {
    const { dataRoot, store } = await createFixture();
    await store.updateAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5', {
      message: null,
      status: 'idle',
      updatedAt: '2026-07-15T00:00:30.000Z',
    });
    await store.updateTurn('tu_00000000-0000-7cfa-813c-d5549b2b9ef9', {
      completedAt: '2026-07-15T00:00:30.000Z',
      error: null,
      status: 'completed',
    });

    expect(await projectFailure(store)).toMatchObject({ status: 'completed' });
    expect(await projectFailure(new FsStore({ dataRoot }))).toMatchObject({ status: 'completed' });

    const events = new FsStore({ dataRoot }).getTurnEvents(
      'tu_00000000-0000-7cfa-813c-d5549b2b9ef9'
    );
    expect(
      events.filter(
        (event) =>
          event.event === 'agent.session.updated' &&
          event.data.type === 'agent-session-updated' &&
          event.data.agentSession.status === 'idle'
      )
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.event === 'turn.completed' &&
          event.data.type === 'turn-completed' &&
          event.data.stopReason === 'completed'
      )
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.event === 'turn.completed' &&
          event.data.type === 'turn-completed' &&
          event.data.stopReason === 'error'
      )
    ).toEqual([]);
  });

  it.each([
    'completed',
    'interrupted',
    'cancelled',
    'failed',
  ] as const)('preserves an authoritative %s turn instead of replacing its outcome', async (status) => {
    const { dataRoot, store } = await createFixture();
    const originalError =
      status === 'failed'
        ? { code: 'original_product_failure', message: 'Preserve the original failure.' }
        : null;

    await store.updateTurn('tu_00000000-0000-7cfa-813c-d5549b2b9ef9', {
      completedAt: '2026-07-15T00:00:30.000Z',
      error: originalError,
      status,
    });
    await store.updateAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5', {
      message: 'Authoritative terminal session state.',
      status: 'idle',
      updatedAt: '2026-07-15T00:00:30.000Z',
    });

    expect(await projectFailure(store)).toMatchObject({ status });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      error: originalError,
      status,
    });
    expect(reloaded.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: 'Authoritative terminal session state.',
      status: 'idle',
    });
    expect(
      reloaded
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toEqual([]);
  });

  it('repairs session and terminal-event projections after the failed turn write persisted', async () => {
    const { dataRoot, store } = await createFixture();
    const sessionWrite = vi.spyOn(store, 'updateAgentSession').mockImplementation(() => {
      throw new Error('AgentSession store unavailable');
    });

    await expect(projectFailure(store)).rejects.toThrow(AggregateError);
    sessionWrite.mockRestore();
    expect(
      new FsStore({ dataRoot }).getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
    ).toMatchObject({
      error: { code: 'worker_governance_restart_recovery' },
      status: 'failed',
    });

    expect(await projectFailure(new FsStore({ dataRoot }))).toMatchObject({ status: 'failed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: 'Worker execution stopped during NanoCore restart recovery.',
      status: 'failed',
    });
    expect(
      reloaded
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it.each([
    'worker_governance_restart_recovery',
    'unsupported_gateway_feature',
  ])('repairs a missing terminal event after a cold retry of %s without replacing its diagnostic', async (errorCode) => {
    const { dataRoot, store } = await createFixture();
    const originalError = {
      code: errorCode,
      message:
        errorCode === 'unsupported_gateway_feature'
          ? 'The Gateway cannot preserve the requested features for the selected model route. Choose a compatible model route and start a new Task.'
          : 'Worker execution stopped during NanoCore restart recovery.',
    };
    const completedAt = '2026-07-15T00:00:45.000Z';
    const emitTurnEvent = store.emitTurnEvent.bind(store);
    const terminalEventWrite = vi
      .spyOn(store, 'emitTurnEvent')
      .mockImplementation((turnId, event) => {
        if (event.event === 'turn.completed') {
          throw new Error('terminal event store unavailable');
        }
        return emitTurnEvent(turnId, event);
      });

    await expect(
      terminalizeGovernedWorkerTurn({
        agentSessionId: 'as_00000000-0000-770e-a08d-6c9479c1d1f5',
        completedAt,
        errorCode,
        message: originalError.message,
        outcome: 'failed',
        requestId: null,
        store,
        turnId: 'tu_00000000-0000-7cfa-813c-d5549b2b9ef9',
      })
    ).rejects.toThrow(AggregateError);
    terminalEventWrite.mockRestore();

    const partial = new FsStore({ dataRoot });
    expect(partial.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      completedAt,
      error: originalError,
      status: 'failed',
    });
    expect(partial.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      status: 'failed',
    });
    expect(
      partial
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter((event) => event.event === 'turn.completed')
    ).toEqual([]);

    expect(await projectFailure(partial)).toMatchObject({ status: 'failed' });
    const repaired = new FsStore({ dataRoot });
    expect(repaired.getTurnById('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')).toMatchObject({
      completedAt,
      error: originalError,
      status: 'failed',
    });
    expect(repaired.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: originalError.message,
      status: 'failed',
    });
    const terminalEvents = repaired
      .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
      .filter((event) => event.event === 'turn.completed');
    expect(terminalEvents).toHaveLength(1);
    expect(SseEventEnvelopeSchema.parse(terminalEvents[0])).toMatchObject({
      data: {
        type: 'turn-completed',
        stopReason: 'error',
        turn: { completedAt, error: originalError, status: 'failed' },
      },
    });
    await projectFailure(repaired);
    expect(
      new FsStore({ dataRoot })
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter((event) => event.event === 'turn.completed')
    ).toEqual(terminalEvents);
  });

  it('repairs a partial normal worker failure during restart without replacing its error', async () => {
    const { dataRoot, store } = await createFixture();
    await store.updateTurn('tu_00000000-0000-7cfa-813c-d5549b2b9ef9', {
      completedAt: '2026-07-15T00:00:45.000Z',
      error: {
        code: 'worker_governance_turn_failed',
        message: 'The original worker execution failed.',
      },
      status: 'failed',
    });

    expect(await projectFailure(store)).toMatchObject({
      error: {
        code: 'worker_governance_turn_failed',
        message: 'The original worker execution failed.',
      },
      status: 'failed',
    });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getAgentSession('as_00000000-0000-770e-a08d-6c9479c1d1f5')).toMatchObject({
      message: 'The original worker execution failed.',
      status: 'failed',
    });
    expect(
      reloaded
        .getTurnEvents('tu_00000000-0000-7cfa-813c-d5549b2b9ef9')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
