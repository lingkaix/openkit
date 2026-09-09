import type { ProcessDiagnosticsSample } from '@openkit/app-api-schemas';
import { resolveTelemetryConfiguration } from '../telemetry.js';

/** Optional clocks and env used to sample the current NanoCore process. */
export interface CreateProcessDiagnosticsSampleInput {
  /** Observation time; defaults to now. */
  now?: Date;
  /** Environment used for nested process.telemetry flags. */
  env?: NodeJS.ProcessEnv;
  /** Memory snapshot; defaults to the current process. */
  memory?: NodeJS.MemoryUsage;
  /** Process uptime in seconds; defaults to the current process. */
  uptimeSeconds?: number;
  /** Node version string; defaults to the current process. */
  nodeVersion?: string;
}

/**
 * Samples the current NanoCore process for authorized App Diagnostics.
 *
 * The projection is not persisted and is not a host-health or build-identity claim.
 *
 * @param input Optional clocks, memory, and env overrides for tests.
 * @returns Strict process sample including nested process.telemetry flags.
 */
export function createProcessDiagnosticsSample(
  input: CreateProcessDiagnosticsSampleInput = {}
): ProcessDiagnosticsSample {
  const memory = input.memory ?? process.memoryUsage();
  const telemetry = resolveTelemetryConfiguration(input.env ?? process.env);
  return {
    observedAt: (input.now ?? new Date()).toISOString(),
    nodeVersion: input.nodeVersion ?? process.version,
    uptimeSeconds: input.uptimeSeconds ?? process.uptime(),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    },
    telemetry: {
      enabled: telemetry.enabled,
      exportConfigured: telemetry.exportConfigured,
    },
  };
}
