import { join } from 'node:path';
import { ensureCanonicalDirectory, readCanonicalFile } from '@openkit/storage';
import { z } from 'zod';
import { writeFileAtomic } from '../storage/canonical-write-capacity.js';

type BackendId = 'sherpa-onnx-asr' | 'llama-cpp' | 'apple-native';

const BackendStateSchema = z
  .object({
    enabled: z.boolean(),
    selectedModelId: z.string().min(1),
    threads: z.number().int().min(1).max(8),
    licenseAcceptedAt: z.string().min(1),
  })
  .strict();

const LocalAiStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    backends: z
      .object({
        'sherpa-onnx-asr': BackendStateSchema.optional(),
        'llama-cpp': BackendStateSchema.optional(),
        'apple-native': BackendStateSchema.optional(),
      })
      .strict(),
  })
  .strict();

/** Persisted enablement for one backend. */
export type LocalBackendState = z.infer<typeof BackendStateSchema>;

/** Persisted local-ai state. Absence means every backend is disabled. */
export type LocalAiState = z.infer<typeof LocalAiStateSchema>;

/** Server file directory for local model assets and settings. */
export function localAiRoot(dataRoot: string): string {
  return join(dataRoot, 'server', 'files', 'local-ai');
}

/** A retained file could not be admitted; callers must not substitute disabled defaults. */
export class LocalAiStateError extends Error {
  public constructor(
    public readonly code:
      | 'local_ai_state_unsupported'
      | 'local_ai_state_corrupt'
      | 'local_ai_state_unreadable',
    options?: ErrorOptions
  ) {
    super(
      `Local AI state could not be admitted (${code}); retained state.json is preserved.`,
      options
    );
    this.name = 'LocalAiStateError';
  }
}

/** Reads retained enablement; only an absent initial file means all backends are disabled. */
export function readLocalAiState(dataRoot: string): LocalAiState {
  let bytes: Buffer;
  try {
    bytes = readCanonicalFile(join(localAiRoot(dataRoot), 'state.json'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { schemaVersion: 1, backends: {} };
    throw new LocalAiStateError('local_ai_state_unreadable', { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    // Parser diagnostics can contain retained bytes; report only the bounded classification.
    throw new LocalAiStateError('local_ai_state_corrupt');
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1)
    throw new LocalAiStateError('local_ai_state_unsupported');
  const parsed = LocalAiStateSchema.safeParse(value);
  if (!parsed.success) throw new LocalAiStateError('local_ai_state_corrupt');
  return parsed.data;
}

/** Replace valid settings only after admitting any retained predecessor. */
export function writeLocalAiState(dataRoot: string, state: LocalAiState): void {
  const parsed = LocalAiStateSchema.safeParse(state);
  if (!parsed.success) throw new LocalAiStateError('local_ai_state_corrupt');
  // Prevent a caller holding old/default settings from overwriting corrupt or newer state.
  readLocalAiState(dataRoot);
  const root = localAiRoot(dataRoot);
  ensureCanonicalDirectory(root);
  writeFileAtomic(join(root, 'state.json'), `${JSON.stringify(parsed.data)}\n`);
}

/** One backend record, or undefined when that backend has never been enabled. */
export function backendState(
  state: LocalAiState,
  backendId: BackendId
): LocalBackendState | undefined {
  return state.backends[backendId];
}
