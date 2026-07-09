import type { StopReason } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import {
  transitionWorkerTurnStage,
  WORKER_TURN_STAGES,
  type WorkerTurnStage,
  workerTurnStageForStopReason,
} from './worker-stage.js';

describe('worker turn stage model', () => {
  it('declares the initial app-local worker turn stages', () => {
    expect(WORKER_TURN_STAGES).toEqual([
      'preparing',
      'running_worker',
      'waiting_for_user',
      'reviewing',
      'verifying',
      'saving',
      'recovering',
      'completed',
      'failed',
      'aborted',
    ]);
  });

  it('allows valid initial worker turn transitions', () => {
    const transitions: Array<[WorkerTurnStage, WorkerTurnStage]> = [
      ['preparing', 'running_worker'],
      ['running_worker', 'waiting_for_user'],
      ['waiting_for_user', 'running_worker'],
      ['running_worker', 'reviewing'],
      ['reviewing', 'verifying'],
      ['verifying', 'saving'],
      ['saving', 'completed'],
      ['running_worker', 'recovering'],
      ['recovering', 'running_worker'],
      ['recovering', 'failed'],
      ['running_worker', 'aborted'],
    ];

    for (const [current, next] of transitions) {
      expect(transitionWorkerTurnStage(current, next)).toBe(next);
    }
  });

  it('rejects invalid transitions through the single transition helper', () => {
    expect(() => transitionWorkerTurnStage('preparing', 'completed')).toThrow(
      'Invalid worker turn stage transition: preparing -> completed'
    );
    expect(() => transitionWorkerTurnStage('completed', 'running_worker')).toThrow(
      'Invalid worker turn stage transition: completed -> running_worker'
    );
  });

  it('maps terminal protocol stop reasons to worker checkpoint stages', () => {
    const mappings: Array<[StopReason, WorkerTurnStage]> = [
      ['completed', 'completed'],
      ['aborted', 'aborted'],
      ['ask_user', 'waiting_for_user'],
      ['error', 'failed'],
      ['length', 'failed'],
      ['budget_exhausted', 'failed'],
    ];

    for (const [stopReason, stage] of mappings) {
      expect(workerTurnStageForStopReason(stopReason)).toBe(stage);
    }
  });
});
