import {
  AGENT_RESOURCE_CATALOG_FEATURE,
  type PortableAgentResourceCatalog,
  type PortableCatalogTreeFile,
  type PortableSkillPayload,
  parsePortableAgentResourceCatalog,
  parsePortableSkillPayload,
} from '@openkit/config-schema';

import { loadWorkspaceResourceCatalog, readWorkspaceSkillSnapshot } from './resource-catalog.js';

/** Inventory path for the portable catalog projection. */
export const AGENT_RESOURCE_CATALOG_EXPORT_PATH = 'records/agent-resource-catalog.json';

/** Required feature emitted on every Workspace export from this implementation. */
export const WORKSPACE_EXPORT_CATALOG_FEATURE = AGENT_RESOURCE_CATALOG_FEATURE;

/** Captured Skill payload plus its export-relative path. */
export interface CapturedSkillPayload {
  /** Export-relative payload path. */
  readonly path: string;
  /** Retained Skill tree. */
  readonly payload: PortableSkillPayload;
}

/** Projected catalog plus retained Skill payloads for one Workspace export. */
export interface WorkspaceCatalogExportProjection {
  /** Strict whitelist catalog projection. */
  readonly catalog: PortableAgentResourceCatalog;
  /** Retained Skill trees keyed by export path. */
  readonly payloads: readonly CapturedSkillPayload[];
}

/**
 * Builds the portable catalog projection for one Workspace.
 *
 * @param dataRoot Canonical data root.
 * @param workspaceId Workspace that owns the catalog.
 * @returns Whitelist catalog plus retained Skill payloads.
 * @throws Error when a retained Skill version is missing its snapshot bytes.
 */
export function projectWorkspaceCatalogExport(
  dataRoot: string,
  workspaceId: string
): WorkspaceCatalogExportProjection {
  const catalog = loadWorkspaceResourceCatalog(dataRoot, workspaceId);
  const portable = parsePortableAgentResourceCatalog({
    lightApps: {
      entries: catalog.lightApps.entries.map(({ currentDigest, ...entry }) => ({
        ...entry,
        sourceCurrentDigest: currentDigest,
      })),
      pins: catalog.lightApps.pins,
      versions: catalog.lightApps.versions,
    },
    mcp: {
      entries: catalog.mcp.entries.map(({ currentVersionDigest: _current, ...entry }) => entry),
      versions: catalog.mcp.versions.map((version) => ({
        contentUnavailable: true as const,
        createdAt: version.createdAt,
        digest: version.digest,
        digestFormat: version.digestFormat,
        entryId: version.entryId,
        pluginVersionDigest: version.pluginVersionDigest,
        provenance: version.provenance,
        publisherLabel: version.publisherLabel,
      })),
    },
    plugins: {
      entries: catalog.plugins.entries,
      versions: catalog.plugins.versions,
    },
    schemaVersion: 1,
    skills: {
      candidates: catalog.skills.candidates,
      entries: catalog.skills.entries.map((entry) => ({
        availability: entry.availability,
        description: entry.description,
        displayName: entry.displayName,
        id: entry.id,
        sourceCurrentDigest: entry.currentDigest,
      })),
      pins: catalog.skills.pins,
      versions: catalog.skills.versions,
    },
  });
  return {
    catalog: portable,
    payloads: catalog.skills.versions
      .filter((version) => version.contentState === 'retained')
      .map((version) => {
        const tree = readWorkspaceSkillSnapshot({
          dataRoot,
          digest: version.digest,
          entryId: version.entryId,
          workspaceId,
        });
        return {
          path: skillPayloadExportPath(version.entryId, version.digest),
          payload: {
            digest: version.digest,
            entryId: version.entryId,
            tree: tree.entries.map(treeEntryToPortable),
          },
        };
      }),
  };
}

/** Empty portable catalog written when a Workspace has never published resources. */
export function emptyPortableAgentResourceCatalog(): PortableAgentResourceCatalog {
  return parsePortableAgentResourceCatalog({
    mcp: { entries: [], versions: [] },
    plugins: { entries: [], versions: [] },
    schemaVersion: 1,
    skills: { candidates: [], entries: [], pins: [], versions: [] },
  });
}

/** Reads one portable catalog document from export bytes. */
export function readPortableAgentResourceCatalog(text: string): PortableAgentResourceCatalog {
  return parsePortableAgentResourceCatalog(JSON.parse(text));
}

/** Reads one Skill payload from export bytes. */
export function readPortableSkillPayload(text: string): PortableSkillPayload {
  return parsePortableSkillPayload(JSON.parse(text));
}

/** Export-relative path for one retained Skill tree. */
export function skillPayloadExportPath(entryId: string, digest: string): string {
  return `skill-payloads/${entryId}/${digest.slice('sha256:'.length)}.json`;
}

/** Converts one hashed tree entry into the portable Skill payload shape. */
function treeEntryToPortable(entry: {
  readonly content?: Buffer;
  readonly kind: 0 | 1 | 2;
  readonly path: string;
}): PortableCatalogTreeFile {
  if (entry.kind === 0) {
    return { kind: 'directory', path: entry.path };
  }
  return {
    contentBase64: (entry.content ?? Buffer.alloc(0)).toString('base64'),
    executable: entry.kind === 2,
    kind: 'file',
    path: entry.path,
  };
}
