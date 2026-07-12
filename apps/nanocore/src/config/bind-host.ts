import type { CoreMode } from './mode.js';
import type { OpenKitConfig } from './openkit-config.js';

/**
 * Environment shape used by bind-host resolution.
 */
interface BindHostEnv {
  /** Optional host override for the HTTP listener. */
  OPENKIT_BIND_HOST?: string;
  /** Optional port override for the HTTP listener. */
  PORT?: string;
}

/**
 * Resolves the HTTP bind host for NanoCore.
 *
 * @param env Environment variables to inspect.
 * @param mode Resolved NanoCore runtime mode.
 * @param config Loaded operator configuration.
 * @returns Bind host. Local mode defaults to loopback.
 */
export function resolveBindHost(
  env: BindHostEnv,
  mode: CoreMode,
  config: Pick<OpenKitConfig, 'server'> = {}
): string {
  if (env.OPENKIT_BIND_HOST) {
    return env.OPENKIT_BIND_HOST;
  }

  return config.server?.bind?.host ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0');
}

/**
 * Resolves the HTTP listener port.
 *
 * @param env Environment variables to inspect.
 * @param config Loaded operator configuration.
 * @returns Valid listener port.
 * @throws Error when the environment port is not an integer in the TCP port range.
 */
export function resolveBindPort(
  env: BindHostEnv,
  config: Pick<OpenKitConfig, 'server'> = {}
): number {
  const value = env.PORT === undefined ? (config.server?.bind?.port ?? 3000) : Number(env.PORT);

  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return value;
}
