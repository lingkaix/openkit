/**
 * Keys of `WORKER_ADAPTERS` in `packages/worker-shim/src/adapter-registry.ts`.
 * The registry object is the release label set. This tuple is that same set so
 * Core telemetry can admit it without loading adapter implementations.
 */
export const RELEASE_ADAPTER_KINDS = ['codex', 'opencode', 'pi'] as const;

/** One id from {@link RELEASE_ADAPTER_KINDS}. */
export type ReleaseAdapterKind = (typeof RELEASE_ADAPTER_KINDS)[number];
