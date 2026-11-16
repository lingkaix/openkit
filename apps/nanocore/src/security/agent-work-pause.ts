import { TurnStartValidationError } from '../operation-error.js';

/** E1 containment refuses new execution; absent authored configuration preserves ordinary admission. */
export function assertAgentWorkNotPaused(paused: boolean | undefined): void {
  if (paused)
    throw new TurnStartValidationError(
      'agent_work_paused',
      'Agent work is paused by a server administrator.',
      503
    );
}
