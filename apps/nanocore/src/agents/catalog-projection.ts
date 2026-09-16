import { AgentSchema } from '@openkit/protocol';
import type { z } from 'zod';

import type { AgentManifest } from './manifest.js';
import { computeReadiness } from './readiness.js';

/** Product-visible catalog entry projected from a current AgentManifest. */
export type ProjectedAgentCatalogEntry = z.infer<typeof AgentSchema>;

/**
 * Projects one current AgentManifest into a product catalog entry.
 *
 * Absent authored readiness stays unknown with a null check time. Launch-time
 * computeReadiness defaults are not treated as checked health. Authored role is
 * omitted, so kind is null. Private commands, env, paths, and raw readiness
 * messages are not copied.
 *
 * @param manifest Current server AgentManifest.
 * @returns Protocol catalog entry for Workspace-visible selection.
 */
export function projectAgentCatalogEntry(manifest: AgentManifest): ProjectedAgentCatalogEntry {
  const readiness = computeReadiness(manifest);

  return AgentSchema.parse({
    capabilities: [],
    defaultProfileId: manifest.defaultProfileId ?? null,
    health: {
      checkedAt: null,
      message: null,
      status: 'unknown',
    },
    id: manifest.id,
    kind: null,
    modelId: manifest.models.preferredLogicalModelId,
    name: manifest.displayName,
    profiles: (manifest.profiles ?? []).map((profile) => ({
      capabilityIds: [],
      displayName: profile.id,
      id: profile.id,
      instructionsRef: null,
      modelId: profile.preferredLogicalModelId ?? null,
      skillIds: profile.skills.map((skill) => skill.id),
    })),
    sandboxSummary: null,
    skillIds: (manifest.skills ?? []).map((skill) => skill.id),
    status: readiness.status === 'disabled' ? 'disabled' : 'enabled',
  });
}

/**
 * Projects the current server AgentManifest snapshot into catalog entries.
 *
 * Workspace launch pins do not filter this roster. Unavailable and unready
 * entries remain present.
 *
 * @param manifests Current runtimeConfig agentManifests.
 * @returns Catalog entries in snapshot order.
 */
export function projectAgentCatalogEntries(
  manifests: readonly AgentManifest[]
): ProjectedAgentCatalogEntry[] {
  return manifests.map(projectAgentCatalogEntry);
}
