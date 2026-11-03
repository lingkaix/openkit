import type {
  ControlWorkerDomainRefusal,
  ControlWorkerFailureCode,
} from './control-store-worker-protocol.js';

/** A refusal or uncertain result, never a substitute for the original SQL command receipt. */
export class ControlStoreWorkerError extends Error {
  /** Creates a redacted failure; unknown results require original-request inspection. */
  constructor(
    readonly code: ControlWorkerFailureCode,
    readonly commit: 'not-committed' | 'unknown',
    readonly domain?: ControlWorkerDomainRefusal
  ) {
    super('Control database writer operation failed.');
    this.name = 'ControlStoreWorkerError';
  }
}
