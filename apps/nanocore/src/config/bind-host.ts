import type { CoreMode } from './mode.js';

/**
 * Environment shape used by bind-host resolution.
 */
export interface BindHostEnv {
  /** Optional host override for the HTTP listener. */
  OPENKIT_BIND_HOST?: string;
}

/**
 * Resolves the HTTP bind host for NanoCore.
 *
 * @param env Environment variables to inspect.
 * @param mode Resolved NanoCore runtime mode.
 * @returns Bind host. Local mode defaults to loopback.
 */
export function resolveBindHost(env: BindHostEnv, mode: CoreMode): string {
  if (env.OPENKIT_BIND_HOST) {
    return env.OPENKIT_BIND_HOST;
  }

  return mode === 'local' ? '127.0.0.1' : '0.0.0.0';
}
