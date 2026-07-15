import { type CreateAppOptions, createApp as createNanoCoreApp } from '../app.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';

export type { CreateAppOptions } from '../app.js';

/**
 * Creates a NanoCore app with an explicit deterministic executor for unit tests.
 *
 * @param options Production app options, including an optional executor override.
 * @returns NanoCore app configured for deterministic unit tests.
 */
export function createApp(options: CreateAppOptions = {}): ReturnType<typeof createNanoCoreApp> {
  return createNanoCoreApp({ turnExecutor: new SimulatedTurnExecutor(), ...options });
}
