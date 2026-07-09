import { z } from 'zod';

import { AuthoredAgentConfigSchema } from './agent.js';
import type { ConfigCatalogKind } from './policy.js';
import { ProviderProfileSchema } from './provider.js';
import { OpenKitConfigSchema } from './server.js';
import { WorkspaceDataSourceCatalogSchema } from './source-catalog.js';
import { WorkspaceConfigSchema } from './workspace.js';

/**
 * JSON Schema catalog entry.
 */
export interface ConfigSchemaCatalogEntry {
  /** Config kind represented by this entry. */
  kind: ConfigCatalogKind;
  /** User-visible schema title. */
  title: string;
  /** JSON Schema document generated from the package-owned Zod schema. */
  schema: Record<string, unknown>;
}

/**
 * Returns JSON Schema catalog entries for editor hints.
 *
 * @returns JSON Schema catalog entries.
 */
export function getConfigSchemaCatalog(): ConfigSchemaCatalogEntry[] {
  return [
    {
      kind: 'server',
      title: 'OpenKit server config',
      schema: z.toJSONSchema(OpenKitConfigSchema) as Record<string, unknown>,
    },
    {
      kind: 'provider',
      title: 'OpenKit provider profile',
      schema: z.toJSONSchema(ProviderProfileSchema) as Record<string, unknown>,
    },
    {
      kind: 'agent',
      title: 'OpenKit agent config',
      schema: z.toJSONSchema(AuthoredAgentConfigSchema) as Record<string, unknown>,
    },
    {
      kind: 'workspace',
      title: 'OpenKit workspace config',
      schema: z.toJSONSchema(WorkspaceConfigSchema) as Record<string, unknown>,
    },
    {
      kind: 'data-source',
      title: 'OpenKit workspace data source catalog',
      schema: z.toJSONSchema(WorkspaceDataSourceCatalogSchema) as Record<string, unknown>,
    },
  ];
}
