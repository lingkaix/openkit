import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

/** Creates one persisted running turn and busy agent session. */
function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-turn-failure-'));
  const store = createDemoStore({ dataRoot });
  const turn = store.createTurn('ws_demo', 'th_demo', 'Run governed worker', null, {
    turnId: 'turn_worker_failure',
  });
  store.createAgentSession({
    agentId: 'agent_codex_host',
    createdAt: turn.startedAt ?? '2026-07-15T00:00:00.000Z',
    id: 'as_worker_failure',
    message: null,
    status: 'busy',
    threadId: turn.threadId,
    updatedAt: turn.startedAt ?? '2026-07-15T00:00:00.000Z',
    workspaceId: turn.workspaceId,
  });
  return { dataRoot, store, turn };
}

/** Runs the shared governed-worker failure projection. */
function projectFailure(store: FsStore) {
  return terminalizeGovernedWorkerTurn({
    agentSessionId: 'as_worker_failure',
    completedAt: '2026-07-15T00:01:00.000Z',
    errorCode: 'worker_governance_restart_recovery',
    message: 'Worker execution stopped during NanoCore restart recovery.',
    outcome: 'failed',
    requestId: null,
    store,
    turnId: 'turn_worker_failure',
  });
}

/** Runs the shared governed-worker interruption projection. */
function projectInterruption(store: FsStore) {
  return terminalizeGovernedWorkerTurn({
    agentSessionId: 'as_worker_failure',
    completedAt: '2026-07-15T00:01:00.000Z',
    errorCode: 'worker_governance_restart_recovery',
    message: 'Worker execution was interrupted during NanoCore restart recovery.',
    outcome: 'interrupted',
    requestId: null,
    store,
    turnId: 'turn_worker_failure',
  });
}

describe('governed worker turn failure projection', () => {
  it('treats a missing pre-anchor turn as an idempotent no-op', () => {
    const store = createDemoStore();

    expect(projectFailure(store)).toEqual({ status: 'missing' });
  });

  it('fails an existing turn when its agent session was not durably created', () => {
    const store = createDemoStore();
    store.createTurn('ws_demo', 'th_demo', 'Crash before session write', null, {
      turnId: 'turn_worker_failure',
    });

    expect(projectFailure(store)).toMatchObject({ status: 'failed' });
    expect(store.getTurnById('turn_worker_failure')).toMatchObject({ status: 'failed' });
    expect(
      store
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it('interrupts an anchored turn and session exactly once after restart cleanup', () => {
    const { dataRoot, store } = createFixture();

    expect(projectInterruption(store)).toMatchObject({ status: 'interrupted' });
    expect(projectInterruption(new FsStore({ dataRoot }))).toMatchObject({
      status: 'interrupted',
    });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('turn_worker_failure')).toMatchObject({
      error: {
        code: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during NanoCore restart recovery.',
      },
      status: 'interrupted',
    });
    expect(reloaded.getAgentSession('as_worker_failure')).toMatchObject({
      message: 'Worker execution was interrupted during NanoCore restart recovery.',
      status: 'interrupted',
    });
    expect(
      reloaded
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'aborted'
        )
    ).toHaveLength(1);
  });

  it('fails closed when product-store reads fail for reasons other than not-found', () => {
    const { store } = createFixture();
    const turnRead = vi.spyOn(store, 'getTurnById').mockImplementation(() => {
      throw new Error('turn store is corrupt');
    });

    expect(() => projectFailure(store)).toThrow('turn store is corrupt');
    turnRead.mockRestore();

    const sessionRead = vi.spyOn(store, 'getAgentSession').mockImplementation(() => {
      throw new Error('agent session store is corrupt');
    });
    expect(() => projectFailure(store)).toThrow('agent session store is corrupt');
    sessionRead.mockRestore();
  });

  it('preserves a durable successful terminal event when the turn row is still running', () => {
    const { dataRoot, store, turn } = createFixture();
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
      workspaceId: turn.workspaceId,
    });

    expect(projectFailure(store)).toMatchObject({ status: 'completed' });

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

  it('fails a running turn and session exactly once across store reloads', () => {
    const { dataRoot, store } = createFixture();

    expect(projectFailure(store)).toMatchObject({ status: 'failed' });
    expect(projectFailure(new FsStore({ dataRoot }))).toMatchObject({ status: 'failed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('turn_worker_failure')).toMatchObject({
      error: {
        code: 'worker_governance_restart_recovery',
        message: 'Worker execution stopped during NanoCore restart recovery.',
      },
      status: 'failed',
    });
    expect(reloaded.getAgentSession('as_worker_failure')).toMatchObject({
      message: 'Worker execution stopped during NanoCore restart recovery.',
      status: 'failed',
    });
    expect(
      reloaded
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it('preserves a completed turn and does not fail its session', () => {
    const { dataRoot, store } = createFixture();
    const completed = store.updateTurn('turn_worker_failure', {
      completedAt: '2026-07-15T00:00:30.000Z',
      error: null,
      status: 'completed',
    });
    store.updateAgentSession('as_worker_failure', {
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
      workspaceId: completed.workspaceId,
    });

    expect(projectFailure(store)).toMatchObject({ status: 'completed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('turn_worker_failure')).toMatchObject({
      error: null,
      status: 'completed',
    });
    expect(reloaded.getAgentSession('as_worker_failure')).toMatchObject({
      message: null,
      status: 'idle',
    });
    expect(
      reloaded
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toEqual([]);
  });

  it('repairs missing success events for an already completed turn exactly once', () => {
    const { dataRoot, store } = createFixture();
    store.updateAgentSession('as_worker_failure', {
      message: null,
      status: 'idle',
      updatedAt: '2026-07-15T00:00:30.000Z',
    });
    store.updateTurn('turn_worker_failure', {
      completedAt: '2026-07-15T00:00:30.000Z',
      error: null,
      status: 'completed',
    });

    expect(projectFailure(store)).toMatchObject({ status: 'completed' });
    expect(projectFailure(new FsStore({ dataRoot }))).toMatchObject({ status: 'completed' });

    const events = new FsStore({ dataRoot }).getTurnEvents('turn_worker_failure');
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
  ] as const)('preserves an authoritative %s turn instead of replacing its outcome', (status) => {
    const { dataRoot, store } = createFixture();
    const originalError =
      status === 'failed'
        ? { code: 'original_product_failure', message: 'Preserve the original failure.' }
        : null;

    store.updateTurn('turn_worker_failure', {
      completedAt: '2026-07-15T00:00:30.000Z',
      error: originalError,
      status,
    });
    store.updateAgentSession('as_worker_failure', {
      message: 'Authoritative terminal session state.',
      status: 'idle',
      updatedAt: '2026-07-15T00:00:30.000Z',
    });

    expect(projectFailure(store)).toMatchObject({ status });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getTurnById('turn_worker_failure')).toMatchObject({
      error: originalError,
      status,
    });
    expect(reloaded.getAgentSession('as_worker_failure')).toMatchObject({
      message: 'Authoritative terminal session state.',
      status: 'idle',
    });
    expect(
      reloaded
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toEqual([]);
  });

  it('repairs session and terminal-event projections after the failed turn write persisted', () => {
    const { dataRoot, store } = createFixture();
    const sessionWrite = vi.spyOn(store, 'updateAgentSession').mockImplementation(() => {
      throw new Error('agent session store unavailable');
    });

    expect(() => projectFailure(store)).toThrow(AggregateError);
    sessionWrite.mockRestore();
    expect(new FsStore({ dataRoot }).getTurnById('turn_worker_failure')).toMatchObject({
      error: { code: 'worker_governance_restart_recovery' },
      status: 'failed',
    });

    expect(projectFailure(new FsStore({ dataRoot }))).toMatchObject({ status: 'failed' });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getAgentSession('as_worker_failure')).toMatchObject({
      message: 'Worker execution stopped during NanoCore restart recovery.',
      status: 'failed',
    });
    expect(
      reloaded
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it('repairs a missing terminal event after turn and session writes persisted', () => {
    const { dataRoot, store } = createFixture();
    const emitTurnEvent = store.emitTurnEvent.bind(store);
    const terminalEventWrite = vi
      .spyOn(store, 'emitTurnEvent')
      .mockImplementation((turnId, event) => {
        if (event.event === 'turn.completed') {
          throw new Error('terminal event store unavailable');
        }
        return emitTurnEvent(turnId, event);
      });

    expect(() => projectFailure(store)).toThrow(AggregateError);
    terminalEventWrite.mockRestore();

    const partial = new FsStore({ dataRoot });
    expect(partial.getTurnById('turn_worker_failure')).toMatchObject({ status: 'failed' });
    expect(partial.getAgentSession('as_worker_failure')).toMatchObject({ status: 'failed' });
    expect(
      partial
        .getTurnEvents('turn_worker_failure')
        .filter((event) => event.event === 'turn.completed')
    ).toEqual([]);

    expect(projectFailure(partial)).toMatchObject({ status: 'failed' });
    expect(
      new FsStore({ dataRoot })
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });

  it('repairs a partial normal worker failure during restart without replacing its error', () => {
    const { dataRoot, store } = createFixture();
    store.updateTurn('turn_worker_failure', {
      completedAt: '2026-07-15T00:00:45.000Z',
      error: {
        code: 'worker_governance_turn_failed',
        message: 'The original worker execution failed.',
      },
      status: 'failed',
    });

    expect(projectFailure(store)).toMatchObject({
      error: {
        code: 'worker_governance_turn_failed',
        message: 'The original worker execution failed.',
      },
      status: 'failed',
    });

    const reloaded = new FsStore({ dataRoot });
    expect(reloaded.getAgentSession('as_worker_failure')).toMatchObject({
      message: 'The original worker execution failed.',
      status: 'failed',
    });
    expect(
      reloaded
        .getTurnEvents('turn_worker_failure')
        .filter(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'error'
        )
    ).toHaveLength(1);
  });
});
