import { join } from 'node:path';
import { ensureCanonicalDirectory, readCanonicalTextFile } from '@openkit/storage';
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

/** Reads state.json. A missing or unreadable file is disabled. */
export function readLocalAiState(dataRoot: string): LocalAiState {
  try {
    const parsed = LocalAiStateSchema.safeParse(
      JSON.parse(readCanonicalTextFile(join(localAiRoot(dataRoot), 'state.json')))
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Absent state is disabled.
  }
  return { schemaVersion: 1, backends: {} };
}

/** Replaces state.json. */
export function writeLocalAiState(dataRoot: string, state: LocalAiState): void {
  const root = localAiRoot(dataRoot);
  ensureCanonicalDirectory(root);
  writeFileAtomic(join(root, 'state.json'), `${JSON.stringify(state)}\n`);
}

/** One backend record, or undefined when that backend has never been enabled. */
export function backendState(
  state: LocalAiState,
  backendId: BackendId
): LocalBackendState | undefined {
  return state.backends[backendId];
}
