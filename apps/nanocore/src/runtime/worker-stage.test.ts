import type { StopReason } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import {
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
