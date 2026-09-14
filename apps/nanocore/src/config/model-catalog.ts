import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ModelCatalog,
  ModelCatalogSchema,
  type ProviderProfile,
} from '@openkit/config-schema';
import { parseJsoncObject } from './jsonc.js';

/** Loads the strict deployment extension catalog; absence means no extension metadata. */
export function loadModelCatalog(dataRoot: string): ModelCatalog {
  const path = join(dataRoot, 'config', 'model-catalog.jsonc');
  return ModelCatalogSchema.parse(
    existsSync(path)
      ? parseJsoncObject(readFileSync(path, 'utf8'), path)
      : { schemaVersion: 1, providers: {} }
  );
}

/** Projects exact catalog entries beneath profile leaves without modifying authored inputs. */
export function extendProviderModelMetadata(
  profile: ProviderProfile,
  catalog: ModelCatalog
): ProviderProfile {
  const entries = catalog.providers[profile.vendor ?? profile.id]?.models;
  if (!entries) return profile;
  const modelMetadata = { ...profile.modelMetadata };
  for (const id of profile.models) {
    const extension = entries[id];
    if (!extension) continue;
    const authored = profile.modelMetadata?.[id];
    const merged = { ...extension, ...authored };
    if (extension.limit || authored?.limit)
      merged.limit = { ...extension.limit, ...authored?.limit };
    if (extension.cost || authored?.cost) merged.cost = { ...extension.cost, ...authored?.cost };
    if (extension.modalities || authored?.modalities)
      merged.modalities = { ...extension.modalities, ...authored?.modalities };
    modelMetadata[id] = merged;
  }
  return { ...profile, modelMetadata };
}
