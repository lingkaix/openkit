import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ModelCatalog, ModelCatalogSchema } from '@openkit/config-schema';
import { parseJsoncObject } from './jsonc.js';
import type { ModelMetadataSource, ProviderProfile } from './providers-loader.js';
import { type UnknownConfigKey, unknownConfigKeys } from './unknown-config-keys.js';

/** Loads known deployment metadata and reports discarded descriptive keys; absence means no extension metadata. */
export function loadModelCatalog(
  dataRoot: string,
  reportUnknownKey?: (key: UnknownConfigKey, path: string) => void
): ModelCatalog {
  const path = join(dataRoot, 'config', 'model-catalog.jsonc');
  const raw = existsSync(path)
    ? parseJsoncObject(readFileSync(path, 'utf8'), path)
    : { schemaVersion: 1, providers: {} };
  const catalog = ModelCatalogSchema.parse(raw);
  for (const key of unknownConfigKeys('model-catalog', raw, catalog)) {
    reportUnknownKey?.(key, path);
  }
  return catalog;
}

/** Projects exact catalog entries beneath profile leaves without modifying authored inputs. */
export function extendProviderModelMetadata(
  profile: ProviderProfile,
  catalog: ModelCatalog
): ProviderProfile {
  const entries = catalog.providers[profile.vendor ?? profile.id]?.models;
  if (!entries || !profile.models.some((id) => entries[id] !== undefined)) return profile;
  const modelMetadataSources: NonNullable<ProviderProfile['modelMetadataSources']> = {};
  const modelMetadata = { ...profile.modelMetadata };
  for (const id of profile.models) {
    const extension = entries?.[id];
    const authored = profile.modelMetadata?.[id];
    const sources: Record<string, ModelMetadataSource> = {};
    for (const [metadata, source] of [
      [extension, 'deployment-extension'],
      [authored, 'profile-override'],
    ] as const) {
      for (const [key, value] of Object.entries(metadata ?? {})) {
        if (value === undefined) continue;
        if (key === 'limit' || key === 'cost' || key === 'modalities') {
          for (const [leaf, nested] of Object.entries(value)) {
            if (nested !== undefined) sources[`${key}.${leaf}`] = source;
          }
        } else sources[key] = source;
      }
    }
    modelMetadataSources[id] = sources;
    if (!extension) continue;
    const merged = { ...extension, ...authored };
    if (extension.limit || authored?.limit)
      merged.limit = { ...extension.limit, ...authored?.limit };
    if (extension.cost || authored?.cost) merged.cost = { ...extension.cost, ...authored?.cost };
    if (extension.modalities || authored?.modalities)
      merged.modalities = { ...extension.modalities, ...authored?.modalities };
    modelMetadata[id] = merged;
  }
  return { ...profile, modelMetadata, modelMetadataSources };
}
