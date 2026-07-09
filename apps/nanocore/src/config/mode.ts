import { z } from 'zod';

/**
 * Closed NanoCore runtime modes.
 */
export const CoreModeSchema = z.enum(['local', 'server']);

/**
 * NanoCore runtime mode.
 */
export type CoreMode = z.infer<typeof CoreModeSchema>;

/**
 * Minimal config shape needed to resolve NanoCore mode.
 */
export interface CoreModeConfig {
  /** File-backed mode value. */
  mode?: CoreMode | undefined;
}

/**
 * Environment shape used by mode resolution.
 */
export interface CoreModeEnv {
  /** Optional environment override for NanoCore mode. */
  OPENKIT_CORE_MODE?: string;
}

/**
 * Boot-time configuration error with a stable machine-readable code.
 */
export class BootConfigError extends Error {
  /** Stable error code for boot diagnostics and tests. */
  public readonly code: string;

  /**
   * Creates one typed boot configuration error.
   *
   * @param code Stable error code.
   * @param message Human-readable boot failure message.
   */
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'BootConfigError';
    this.code = code;
  }
}

/**
 * Resolves NanoCore mode with env > config > local precedence.
 *
 * @param env Environment variables to inspect.
 * @param config File-backed OpenKit config.
 * @returns Resolved NanoCore mode.
 * @throws BootConfigError when OPENKIT_CORE_MODE is not local or server.
 */
export function resolveMode(env: CoreModeEnv, config: CoreModeConfig): CoreMode {
  const envMode = env.OPENKIT_CORE_MODE;

  if (envMode !== undefined && envMode !== '') {
    const parsed = CoreModeSchema.safeParse(envMode);

    if (!parsed.success) {
      throw new BootConfigError(
        'invalid_core_mode',
        `Invalid OPENKIT_CORE_MODE "${envMode}". Expected "local" or "server".`
      );
    }

    return parsed.data;
  }

  return config.mode ?? 'local';
}
