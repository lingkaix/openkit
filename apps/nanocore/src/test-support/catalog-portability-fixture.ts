/**
 * Test-only fixtures for retained catalog history and physical snapshot assertions.
 * Ordinary portable Workspace import is not a product capability.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  hashOpenKitTreeEntries,
  type PortableAgentResourceCatalog,
  type PortableSkillPayload,
  parseResourceCatalogDocument,
  type ResourceCatalogDocument,
} from '@openkit/config-schema';
import { compareCodeUnits } from '@openkit/protocol';
import { ensureCanonicalDirectory, publishCanonicalPath } from '@openkit/storage';
import { skillPayloadExportPath } from '../catalog/catalog-portability.js';
import { validateLightAppDefinitionCatalog } from '../catalog/resource-catalog.js';
import { writeFileAtomic } from '../storage/workspace-file-records.js';

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
    portable.skills.versions
      .filter((version) => version.contentState === 'retained')
      .map((version) => skillPayloadExportPath(version.entryId, version.digest))
  );
  for (const path of payloads.keys()) {
    if (!expectedPaths.has(path)) {
      throw new Error(`Unexpected Skill payload in export: ${path}`);
    }
  }
  for (const version of portable.skills.versions) {
    if (version.contentState === 'purged') continue;
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
      .sort((left, right) => compareCodeUnits(left.path, right.path));
    const retained = [...version.inventory].sort((left, right) =>
      compareCodeUnits(left.path, right.path)
    );
    if (JSON.stringify(inventory) !== JSON.stringify(retained)) {
      throw new Error(`Skill payload inventory mismatch: ${path}`);
    }
  }
  const catalog = parseResourceCatalogDocument({
    lightApps: {
      entries: portable.lightApps.entries.map(
        ({ sourceCurrentDigest: _sourceCurrentDigest, ...entry }) => ({
          ...entry,
          currentDigest: null,
        })
      ),
      pins: [],
      versions: portable.lightApps.versions,
    },
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
    scope: 'workspace',
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
  validateLightAppDefinitionCatalog({
    ...catalog,
    lightApps: {
      entries: portable.lightApps.entries.map(({ sourceCurrentDigest, ...entry }) => ({
        ...entry,
        currentDigest: sourceCurrentDigest,
      })),
      pins: portable.lightApps.pins,
      versions: portable.lightApps.versions,
    },
  });
  return catalog;
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
  validateLightAppDefinitionCatalog(catalog);
  const catalogDir = join(workspaceRoot, 'catalog');
  mkdirSync(join(catalogDir, 'skill-snapshots'), { recursive: true });
  mkdirSync(join(catalogDir, 'plugin-snapshots'), { recursive: true });
  mkdirSync(join(catalogDir, 'mcp-data'), { recursive: true });
  for (const payload of payloads) {
    const hex = payload.digest.slice('sha256:'.length);
    const target = join(catalogDir, 'skill-snapshots', payload.entryId, hex);
    const staged = `${target}.staging`;
    rmSync(staged, { force: true, recursive: true });
    ensureCanonicalDirectory(dirname(target), 0o777);
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
    rmSync(target, { force: true, recursive: true });
    publishCanonicalPath(staged, target);
  }
  writeFileAtomic(
    join(catalogDir, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    0o666 & ~process.umask()
  );
}
