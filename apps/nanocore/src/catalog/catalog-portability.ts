import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AGENT_RESOURCE_CATALOG_FEATURE,
  digestOpenKitTree,
  hashOpenKitTreeEntries,
  type PortableAgentResourceCatalog,
  type PortableCatalogTreeFile,
  type PortableSkillPayload,
  parsePortableAgentResourceCatalog,
  parsePortableSkillPayload,
  parseResourceCatalogDocument,
  type ResourceCatalogDocument,
} from '@openkit/config-schema';

import { loadWorkspaceResourceCatalog, skillSnapshotPath } from './resource-catalog.js';

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
    payloads: catalog.skills.versions.map((version) => {
      const snapshot = skillSnapshotPath(dataRoot, workspaceId, version.entryId, version.digest);
      if (!existsSync(snapshot)) {
        throw new Error(`Skill snapshot missing for export: ${version.entryId} ${version.digest}`);
      }
      const tree = digestOpenKitTree(snapshot);
      if (tree.digest !== version.digest) {
        throw new Error(
          `Skill snapshot digest mismatch for export: ${version.entryId} ${version.digest}`
        );
      }
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

/**
 * Reconstructs an inactive target catalog from a verified portable projection.
 *
 * @param portable Whitelist catalog from the export.
 * @param payloads Retained Skill payloads keyed by export path.
 * @returns Catalog document with no live defaults, pins, installations, or MCP bindings.
 * @throws Error when a retained payload is missing, extra, or disagrees with its digest.
 */
export function reconstructImportedWorkspaceCatalog(
  portable: PortableAgentResourceCatalog,
  payloads: ReadonlyMap<string, PortableSkillPayload>
): ResourceCatalogDocument {
  const expectedPaths = new Set(
    portable.skills.versions.map((version) =>
      skillPayloadExportPath(version.entryId, version.digest)
    )
  );
  for (const path of payloads.keys()) {
    if (!expectedPaths.has(path)) {
      throw new Error(`Unexpected Skill payload in export: ${path}`);
    }
  }
  for (const version of portable.skills.versions) {
    const path = skillPayloadExportPath(version.entryId, version.digest);
    const payload = payloads.get(path);
    if (!payload) {
      throw new Error(`Missing Skill payload in export: ${path}`);
    }
    if (payload.entryId !== version.entryId || payload.digest !== version.digest) {
      throw new Error(`Skill payload identity mismatch: ${path}`);
    }
    const digest = hashOpenKitTreeEntries(
      payload.tree.map((entry) =>
        entry.kind === 'directory'
          ? { kind: 0 as const, path: entry.path }
          : {
              content: Buffer.from(entry.contentBase64 ?? '', 'base64'),
              kind: entry.executable ? (2 as const) : (1 as const),
              path: entry.path,
            }
      )
    );
    if (digest !== version.digest) {
      throw new Error(`Skill payload digest mismatch: ${path}`);
    }
    const inventory = payload.tree
      .map((entry) => ({
        executable: entry.kind === 'file' && entry.executable === true,
        kind: entry.kind,
        path: entry.path,
        sha256:
          entry.kind === 'directory'
            ? null
            : `sha256:${createHash('sha256')
                .update(Buffer.from(entry.contentBase64 ?? '', 'base64'))
                .digest('hex')}`,
        size:
          entry.kind === 'directory' ? 0 : Buffer.from(entry.contentBase64 ?? '', 'base64').length,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const retained = [...version.inventory].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    if (JSON.stringify(inventory) !== JSON.stringify(retained)) {
      throw new Error(`Skill payload inventory mismatch: ${path}`);
    }
  }
  return parseResourceCatalogDocument({
    mcp: {
      bindings: [],
      entries: portable.mcp.entries.map((entry) => ({
        ...entry,
        currentVersionDigest: null,
      })),
      versions: [],
    },
    plugins: {
      entries: portable.plugins.entries,
      installations: [],
      versions: portable.plugins.versions,
    },
    revision: 1,
    schemaVersion: 1,
    skills: {
      candidates: [],
      entries: portable.skills.entries.map((entry) => ({
        availability: entry.availability,
        currentDigest: null,
        description: entry.description,
        displayName: entry.displayName,
        id: entry.id,
      })),
      pins: [],
      versions: portable.skills.versions,
    },
  });
}

/**
 * Writes reconstructed catalog metadata and Skill snapshots under one Workspace root.
 *
 * @param workspaceRoot Staged Workspace root.
 * @param catalog Inactive reconstructed catalog.
 * @param payloads Verified Skill payloads.
 */
export function writeImportedWorkspaceCatalog(
  workspaceRoot: string,
  catalog: ResourceCatalogDocument,
  payloads: readonly PortableSkillPayload[]
): void {
  const catalogDir = join(workspaceRoot, 'catalog');
  mkdirSync(join(catalogDir, 'skill-snapshots'), { recursive: true });
  mkdirSync(join(catalogDir, 'plugin-snapshots'), { recursive: true });
  mkdirSync(join(catalogDir, 'mcp-data'), { recursive: true });
  for (const payload of payloads) {
    const hex = payload.digest.slice('sha256:'.length);
    const target = join(catalogDir, 'skill-snapshots', payload.entryId, hex);
    const staged = `${target}.staging`;
    rmSync(staged, { force: true, recursive: true });
    mkdirSync(staged, { recursive: true });
    for (const entry of payload.tree) {
      const path = join(staged, entry.path);
      if (entry.kind === 'directory') {
        mkdirSync(path, { recursive: true });
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(entry.contentBase64 ?? '', 'base64'));
      if (entry.executable) {
        chmodSync(path, 0o755);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true, recursive: true });
    renameSync(staged, target);
  }
  writeFileSync(join(catalogDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
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
