import { TurnStartValidationError } from './orchestrator.js';

/**
 * Marks a pre-launch resolution failure that will recur for the same authored inputs.
 *
 * Capacity, unavailable catalogs or image evidence, storage, transport, and uncertain runtime effects must not use this type; those dependencies may recover without changing the admitted input.
 */
export class DeterministicAgentPreparationError extends TurnStartValidationError {
  /**
   * Creates an input-bound failure while preserving its existing public error projection.
   *
   * @param message Resolution diagnostic from the failing owner.
   * @param code Existing command error code.
   * @param status Existing command response status.
   */
  public constructor(message: string, code = 'turn_start_failed', status = 404) {
    super(code, message, status);
    this.name = 'DeterministicAgentPreparationError';
  }
}
