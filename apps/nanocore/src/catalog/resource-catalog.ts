import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  type CatalogProducer,
  digestMcpConfig,
  digestOpenKitTree,
  EMPTY_RESOURCE_CATALOG,
  hashOpenKitTreeEntries,
  type McpBindingRecord,
  type McpConfigVersionRecord,
  type McpValidatedDeclaration,
  McpValidatedDeclarationSchema,
  type OpenKitTreeEntry,
  type PluginInstallationRecord,
  type PluginVersionRecord,
  parseResourceCatalogDocument,
  type ResourceCatalogDocument,
  type SkillCandidateRecord,
  type SkillVersionRecord,
  type WorkspaceMcpServer,
  type WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';

import { ensureWorkspaceLayout } from '../storage/fs-layout.js';

/** Compare-and-set failure against the catalog revision. */
export class CatalogConflictError extends Error {
  public constructor(message = 'Resource catalog revision conflict.') {
    super(message);
    this.name = 'CatalogConflictError';
  }
}

/** Missing catalog resource. */
export class CatalogNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogNotFoundError';
  }
}

/** Catalog authority is missing or contradictory after publication. */
export class CatalogIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogIntegrityError';
  }
}

/** Catalog mutation requires deployment-admin host-execution authority. */
export class CatalogForbiddenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogForbiddenError';
  }
}

/** One API-submitted tree entry. */
export interface CatalogTreeFile {
  /** Base64 file bytes; omitted for directories. */
  readonly contentBase64?: string;
  /** Whether any executable bit should be retained. */
  readonly executable?: boolean;
  /** Directory or regular file. */
  readonly kind: 'directory' | 'file';
  /** Root-relative path. */
  readonly path: string;
}

/** Loads the Workspace catalog document, or the empty catalog when unpublished. */
export function loadWorkspaceResourceCatalog(
  dataRoot: string,
  workspaceId: string
): ResourceCatalogDocument {
  const path = catalogDocumentPath(dataRoot, workspaceId);
  if (existsSync(path)) {
    return parseResourceCatalogDocument(JSON.parse(readFileSync(path, 'utf8')));
  }
  if (catalogHasPublishedResidue(dataRoot, workspaceId)) {
    throw new CatalogIntegrityError('Workspace catalog authority is missing after publication.');
  }
  return EMPTY_RESOURCE_CATALOG;
}

/** Writes one catalog document after payloads exist, using compare-and-set revision. */
export function publishWorkspaceResourceCatalog(input: {
  readonly catalog: ResourceCatalogDocument;
  readonly dataRoot: string;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
  const current = existsSync(path)
    ? parseResourceCatalogDocument(JSON.parse(readFileSync(path, 'utf8')))
    : input.expectedRevision === 0
      ? EMPTY_RESOURCE_CATALOG
      : (() => {
          throw catalogHasPublishedResidue(input.dataRoot, input.workspaceId)
            ? new CatalogIntegrityError('Workspace catalog authority is missing after publication.')
            : new CatalogConflictError();
        })();
  if (current.revision !== input.expectedRevision) {
    throw new CatalogConflictError();
  }
  const next = parseResourceCatalogDocument({
    ...input.catalog,
    revision: current.revision + 1,
  });
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, next);
  return next;
}

/**
 * Imports one Skill directory as an inactive-or-current version depending on create semantics.
 *
 * @param input Workspace, identity, and tree.
 * @returns Updated catalog and version.
 */
export function importWorkspaceSkill(input: {
  readonly activate: boolean;
  readonly baseCatalog?: ResourceCatalogDocument;
  readonly createdAt: string;
  readonly dataRoot: string;
  readonly displayName: string;
  readonly expectedRevision: number;
  readonly id?: string;
  readonly persist?: boolean;
  readonly producer: CatalogProducer;
  readonly tree: readonly CatalogTreeFile[];
  readonly workspaceId: string;
}): { catalog: ResourceCatalogDocument; version: SkillVersionRecord } {
  const current =
    input.baseCatalog ?? loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const entries = treeFilesToEntries(input.tree);
  const digest = hashOpenKitTreeEntries(entries);
  const id = input.id ?? skillIdFromDisplayName(input.displayName);
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  materializeSnapshot(
    join(layout.catalogSkillSnapshots, id, digest.slice('sha256:'.length)),
    entries
  );
  const version: SkillVersionRecord = {
    createdAt: input.createdAt,
    digest,
    digestFormat: 'openkit-tree-v1',
    entryId: id,
    inventory: inventoryFromEntries(entries),
    producer: input.producer,
    provenance: {
      baseDigest: null,
      pluginMemberKey: null,
      pluginVersionDigest: null,
      sourceCommit: null,
      sourceSubpath: null,
      uploadedSourceId: null,
    },
    publisherVersion: null,
  };
  const existing = current.skills.entries.find((entry) => entry.id === id);
  const nextEntries = existing
    ? current.skills.entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              currentDigest: input.activate ? digest : entry.currentDigest,
              displayName: input.displayName,
            }
          : entry
      )
    : [
        ...current.skills.entries,
        {
          availability: 'available' as const,
          currentDigest: input.activate ? digest : null,
          description: null,
          displayName: input.displayName,
          id,
        },
      ];
  const versions = current.skills.versions.some(
    (item) => item.entryId === id && item.digest === digest
  )
    ? current.skills.versions
    : [...current.skills.versions, version];
  const nextCatalog = parseResourceCatalogDocument({
    ...current,
    skills: { ...current.skills, entries: nextEntries, versions },
  });
  if (input.persist === false) {
    return { catalog: nextCatalog, version };
  }
  const catalog = publishWorkspaceResourceCatalog({
    catalog: nextCatalog,
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
  return { catalog, version };
}

/** Submits a Skill candidate without changing the current pointer. */
export function submitWorkspaceSkillCandidate(input: {
  readonly baseDigest: string | null;
  readonly createdAt: string;
  readonly dataRoot: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly producer: CatalogProducer;
  readonly summary: string;
  readonly tree: readonly CatalogTreeFile[];
  readonly workspaceId: string;
}): { candidate: SkillCandidateRecord; catalog: ResourceCatalogDocument } {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const entry = current.skills.entries.find((item) => item.id === input.entryId);
  if (!entry || entry.availability !== 'available') {
    throw new CatalogNotFoundError(`Skill not found: ${input.entryId}`);
  }
  const { version } = importWorkspaceSkill({
    activate: false,
    createdAt: input.createdAt,
    dataRoot: input.dataRoot,
    displayName: entry.displayName,
    expectedRevision: input.expectedRevision,
    id: input.entryId,
    producer: input.producer,
    tree: input.tree,
    workspaceId: input.workspaceId,
  });
  const published = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const candidate: SkillCandidateRecord = {
    baseDigest: input.baseDigest,
    candidateDigest: version.digest,
    createdAt: input.createdAt,
    disposition: 'proposed',
    entryId: input.entryId,
    evidenceRefs: [],
    id: `cand_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    producer: input.producer,
    summary: input.summary,
  };
  const catalog = publishWorkspaceResourceCatalog({
    catalog: {
      ...published,
      skills: { ...published.skills, candidates: [...published.skills.candidates, candidate] },
    },
    dataRoot: input.dataRoot,
    expectedRevision: published.revision,
    workspaceId: input.workspaceId,
  });
  return { candidate, catalog };
}

/** Promotes, rejects, or withdraws one proposed candidate. */
export function decideWorkspaceSkillCandidate(input: {
  readonly candidateId: string;
  readonly dataRoot: string;
  readonly decision: 'promoted' | 'rejected' | 'withdrawn';
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const candidate = current.skills.candidates.find((item) => item.id === input.candidateId);
  if (!candidate || candidate.disposition !== 'proposed') {
    throw new CatalogNotFoundError(`Skill candidate not found: ${input.candidateId}`);
  }
  if (
    input.decision === 'promoted' &&
    candidate.baseDigest !==
      current.skills.entries.find((entry) => entry.id === candidate.entryId)?.currentDigest
  ) {
    throw new CatalogConflictError('Skill candidate base no longer matches the current digest.');
  }
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      skills: {
        ...current.skills,
        candidates: current.skills.candidates.map((item) =>
          item.id === candidate.id ? { ...item, disposition: input.decision } : item
        ),
        entries:
          input.decision === 'promoted'
            ? current.skills.entries.map((entry) =>
                entry.id === candidate.entryId
                  ? { ...entry, currentDigest: candidate.candidateDigest }
                  : entry
              )
            : current.skills.entries,
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
}

/** Sets or clears one Workspace Skill pin. */
export function setWorkspaceSkillPin(input: {
  readonly dataRoot: string;
  readonly digest: string | null;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const pins =
    input.digest === null
      ? current.skills.pins.filter((pin) => pin.entryId !== input.entryId)
      : [
          ...current.skills.pins.filter((pin) => pin.entryId !== input.entryId),
          { digest: input.digest, entryId: input.entryId },
        ];
  return publishWorkspaceResourceCatalog({
    catalog: { ...current, skills: { ...current.skills, pins } },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
}

/** Selects the current Skill default digest. */
export function selectWorkspaceSkillDefault(input: {
  readonly dataRoot: string;
  readonly digest: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (
    !current.skills.versions.some(
      (version) => version.entryId === input.entryId && version.digest === input.digest
    )
  ) {
    throw new CatalogNotFoundError(`Skill version not found: ${input.digest}`);
  }
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      skills: {
        ...current.skills,
        entries: current.skills.entries.map((entry) =>
          entry.id === input.entryId ? { ...entry, currentDigest: input.digest } : entry
        ),
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
}

/** Creates an inactive MCP configuration version and optional binding. */
export function createWorkspaceMcpConfig(input: {
  readonly allowedTools?: readonly string[];
  readonly baseCatalog?: ResourceCatalogDocument;
  readonly createdAt: string;
  readonly dataRoot: string;
  readonly declaration: unknown;
  readonly displayName: string;
  readonly expectedRevision: number;
  readonly id?: string;
  readonly packageRootDigest?: string | null;
  readonly persist?: boolean;
  readonly pluginMemberKey?: string | null;
  readonly pluginVersionDigest?: string | null;
  readonly selectCurrent?: boolean;
  readonly stdioHostAuthorized?: boolean;
  readonly workspaceId: string;
}): { catalog: ResourceCatalogDocument; version: McpConfigVersionRecord } {
  const declaration = McpValidatedDeclarationSchema.parse(input.declaration);
  const packageRootDigest = input.packageRootDigest ?? null;
  const digest = digestMcpConfig(declaration, packageRootDigest);
  const id = input.id ?? skillIdFromDisplayName(input.displayName);
  if (id === 'openkit-generative') {
    throw new CatalogForbiddenError(
      'Catalog id openkit-generative is reserved for the built-in Worker MCP surface.'
    );
  }
  const current =
    input.baseCatalog ?? loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const existingBinding = current.mcp.bindings.find((item) => item.entryId === id);
  const entry = current.mcp.entries.find((item) => item.id === id);
  const currentVersion = current.mcp.versions.find(
    (item) => item.entryId === id && item.digest === entry?.currentVersionDigest
  );
  if (
    input.selectCurrent &&
    existingBinding?.enabled &&
    entry?.currentVersionDigest !== digest &&
    (declaration.kind === 'stdio' || currentVersion?.declaration.kind === 'stdio') &&
    !input.stdioHostAuthorized
  ) {
    throw new CatalogForbiddenError(
      'Selecting a new or changed stdio MCP configuration requires deployment-admin authority.'
    );
  }
  const version: McpConfigVersionRecord = {
    createdAt: input.createdAt,
    declaration,
    digest,
    digestFormat: 'openkit-mcp-config-v1',
    entryId: id,
    packageRootDigest,
    pluginVersionDigest: input.pluginVersionDigest ?? null,
    provenance: {
      pluginMemberKey: input.pluginMemberKey ?? null,
      sourceCommit: null,
      uploadedSourceId: null,
    },
    publisherLabel: null,
  };
  const currentVersionDigest = input.selectCurrent ? digest : (entry?.currentVersionDigest ?? null);
  const entries = entry
    ? current.mcp.entries.map((item) =>
        item.id === id ? { ...item, currentVersionDigest, displayName: input.displayName } : item
      )
    : [
        ...current.mcp.entries,
        {
          availability: 'available' as const,
          currentVersionDigest,
          displayName: input.displayName,
          id,
        },
      ];
  const versions = current.mcp.versions.some(
    (item) => item.entryId === id && item.digest === digest
  )
    ? current.mcp.versions
    : [...current.mcp.versions, version];
  const allowedTools = [...(input.allowedTools ?? [])];
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  const packageDataKey = existingBinding?.packageDataKey ?? `mcp_${id}`;
  mkdirSync(join(layout.catalogMcpData, packageDataKey), { recursive: true });
  const bindings =
    existingBinding || allowedTools.length === 0
      ? current.mcp.bindings
      : [
          ...current.mcp.bindings,
          {
            allowedTools,
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: false,
            entryId: id,
            packageDataKey,
            pinnedSchemaSnapshotId: null,
            revision: 1,
            schemaPolicy: 'tracking' as const,
            timeoutMs: 60_000,
          },
        ];
  const nextCatalog = parseResourceCatalogDocument({
    ...current,
    mcp: { bindings, entries, versions },
  });
  if (input.persist === false) {
    return { catalog: nextCatalog, version };
  }
  const catalog = publishWorkspaceResourceCatalog({
    catalog: nextCatalog,
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
  return { catalog, version };
}

/** Updates one MCP binding using compare-and-set binding revision. */
export function updateWorkspaceMcpBinding(input: {
  readonly binding: Omit<McpBindingRecord, 'entryId' | 'packageDataKey'> & {
    readonly packageDataKey?: string;
  };
  readonly dataRoot: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const existing = current.mcp.bindings.find((item) => item.entryId === input.entryId);
  if (existing && existing.revision !== input.binding.revision) {
    throw new CatalogConflictError('MCP binding revision conflict.');
  }
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  const packageDataKey =
    existing?.packageDataKey ?? input.binding.packageDataKey ?? `mcp_${input.entryId}`;
  mkdirSync(join(layout.catalogMcpData, packageDataKey), { recursive: true });
  const nextBinding: McpBindingRecord = {
    ...input.binding,
    entryId: input.entryId,
    packageDataKey,
    revision: (existing?.revision ?? 0) + 1,
  };
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      mcp: {
        ...current.mcp,
        bindings: [
          ...current.mcp.bindings.filter((item) => item.entryId !== input.entryId),
          nextBinding,
        ],
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
}

/** Selects one existing MCP configuration version as current. */
export function selectWorkspaceMcpVersion(input: {
  readonly dataRoot: string;
  readonly digest: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly stdioHostAuthorized?: boolean;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const version = current.mcp.versions.find(
    (item) => item.entryId === input.entryId && item.digest === input.digest
  );
  if (!version) {
    throw new CatalogNotFoundError(`MCP configuration version not found: ${input.digest}`);
  }
  const binding = current.mcp.bindings.find((item) => item.entryId === input.entryId);
  const entry = current.mcp.entries.find((item) => item.id === input.entryId);
  const currentVersion = current.mcp.versions.find(
    (item) => item.entryId === input.entryId && item.digest === entry?.currentVersionDigest
  );
  if (
    binding?.enabled &&
    entry?.currentVersionDigest !== input.digest &&
    (version.declaration.kind === 'stdio' || currentVersion?.declaration.kind === 'stdio') &&
    !input.stdioHostAuthorized
  ) {
    throw new CatalogForbiddenError(
      'Selecting a new or changed stdio MCP configuration requires deployment-admin authority.'
    );
  }
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      mcp: {
        ...current.mcp,
        entries: current.mcp.entries.map((item) =>
          item.id === input.entryId ? { ...item, currentVersionDigest: input.digest } : item
        ),
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
}

/** Imports one Agent Plugin package tree and optionally installs selected members. */
export function importWorkspacePlugin(input: {
  readonly createdAt: string;
  readonly dataRoot: string;
  readonly expectedRevision: number;
  readonly install: boolean;
  readonly producer: CatalogProducer;
  readonly selectedPackageKeys?: readonly string[];
  readonly treeRoot: string;
  readonly workspaceId: string;
}): { catalog: ResourceCatalogDocument; version: PluginVersionRecord } {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) {
    throw new CatalogConflictError();
  }
  const packageTree = digestOpenKitTree(input.treeRoot, {
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 4_096,
  });
  const parsed = parsePluginPackage(input.treeRoot);
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  const pluginId = parsed.id;
  materializeSnapshot(
    join(layout.catalogPluginSnapshots, pluginId, packageTree.digest.slice('sha256:'.length)),
    packageTree.entries
  );
  let catalog = current;
  const members: PluginVersionRecord['members'] = [];
  for (const skill of parsed.skills) {
    const imported = importWorkspaceSkill({
      activate: false,
      baseCatalog: catalog,
      createdAt: input.createdAt,
      dataRoot: input.dataRoot,
      displayName: skill.displayName,
      expectedRevision: input.expectedRevision,
      id: skill.id,
      persist: false,
      producer: input.producer,
      tree: skill.tree,
      workspaceId: input.workspaceId,
    });
    catalog = imported.catalog;
    members.push({
      catalogId: skill.id,
      kind: 'skill',
      packageKey: skill.packageKey,
      versionDigest: imported.version.digest,
    });
  }
  for (const mcp of parsed.mcp) {
    const created = createWorkspaceMcpConfig({
      baseCatalog: catalog,
      createdAt: input.createdAt,
      dataRoot: input.dataRoot,
      declaration: mcp.declaration,
      displayName: mcp.displayName,
      expectedRevision: input.expectedRevision,
      id: mcp.id,
      packageRootDigest: packageTree.digest,
      persist: false,
      pluginMemberKey: mcp.packageKey,
      pluginVersionDigest: packageTree.digest,
      workspaceId: input.workspaceId,
    });
    catalog = created.catalog;
    members.push({
      catalogId: mcp.id,
      kind: 'mcp',
      packageKey: mcp.packageKey,
      versionDigest: created.version.digest,
    });
  }
  const version: PluginVersionRecord = {
    createdAt: input.createdAt,
    digest: packageTree.digest,
    digestFormat: 'openkit-tree-v1',
    entryId: pluginId,
    members,
    provenance: { sourceCommit: null, uploadedSourceId: null },
    publisherLabel: parsed.publisherLabel,
  };
  const selectedPackageKeys = [
    ...(input.selectedPackageKeys ?? members.map((member) => member.packageKey)),
  ];
  const existingInstallation = catalog.plugins.installations.find(
    (item) => item.pluginId === pluginId
  );
  const installation: PluginInstallationRecord | undefined = input.install
    ? {
        memberOverrides: existingInstallation?.memberOverrides ?? [],
        pluginId,
        selectedPackageKeys,
        versionDigest: version.digest,
      }
    : undefined;
  catalog = publishWorkspaceResourceCatalog({
    catalog: {
      ...catalog,
      plugins: {
        entries: catalog.plugins.entries.some((entry) => entry.id === pluginId)
          ? catalog.plugins.entries.map((entry) =>
              entry.id === pluginId
                ? { ...entry, description: parsed.description, displayName: parsed.displayName }
                : entry
            )
          : [
              ...catalog.plugins.entries,
              {
                availability: 'available',
                description: parsed.description,
                displayName: parsed.displayName,
                id: pluginId,
              },
            ],
        installations: installation
          ? [
              ...catalog.plugins.installations.filter((item) => item.pluginId !== pluginId),
              installation,
            ]
          : catalog.plugins.installations,
        versions: catalog.plugins.versions.some(
          (item) => item.entryId === pluginId && item.digest === version.digest
        )
          ? catalog.plugins.versions
          : [...catalog.plugins.versions, version],
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
  return { catalog, version };
}

/** Projects enabled MCP bindings into the Gateway's effective catalog. */
export function projectEffectiveWorkspaceMcpCatalog(
  catalog: ResourceCatalogDocument
): WorkspaceMcpServerCatalog {
  const servers: WorkspaceMcpServer[] = [];
  for (const binding of catalog.mcp.bindings) {
    const entry = catalog.mcp.entries.find((item) => item.id === binding.entryId);
    const version = catalog.mcp.versions.find(
      (item) => item.entryId === binding.entryId && item.digest === entry?.currentVersionDigest
    );
    if (!entry || entry.availability !== 'available' || !version) {
      continue;
    }
    servers.push(effectiveMcpServer(binding, version));
  }
  return { schemaVersion: 1, servers };
}

/** Resolves one Skill snapshot directory for worker supply. */
export function skillSnapshotPath(
  dataRoot: string,
  workspaceId: string,
  entryId: string,
  digest: string
): string {
  const layout = ensureWorkspaceLayout(dataRoot, workspaceId);
  return join(layout.catalogSkillSnapshots, entryId, digest.slice('sha256:'.length));
}

/** Resolves the catalog.json path for one Workspace. */
export function catalogDocumentPath(dataRoot: string, workspaceId: string): string {
  return join(ensureWorkspaceLayout(dataRoot, workspaceId).catalog, 'catalog.json');
}

/** Returns true when snapshot or package-data files exist without catalog.json. */
function catalogHasPublishedResidue(dataRoot: string, workspaceId: string): boolean {
  const layout = ensureWorkspaceLayout(dataRoot, workspaceId);
  return (
    directoryContainsFiles(layout.catalogSkillSnapshots) ||
    directoryContainsFiles(layout.catalogPluginSnapshots) ||
    directoryContainsFiles(layout.catalogMcpData)
  );
}

/** Writes one validated API tree into a confined root. */
export function materializeCatalogTree(
  root: string,
  tree: readonly CatalogTreeFile[],
  bounds?: Parameters<typeof hashOpenKitTreeEntries>[1]
): OpenKitTreeEntry[] {
  const entries = treeFilesToEntries(tree);
  hashOpenKitTreeEntries(entries, bounds);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const path = join(root, entry.path);
    if (entry.kind === 0) {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.content ?? Buffer.alloc(0), { flag: 'wx' });
    if (entry.kind === 2) {
      chmodSync(path, 0o755);
    }
  }
  return entries;
}

/** Returns true when any regular file exists under root, ignoring incomplete `.staging` directories. */
function directoryContainsFiles(root: string): boolean {
  if (!existsSync(root)) {
    return false;
  }
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const metadata = statSync(path);
      if (metadata.isDirectory()) {
        if (!name.endsWith('.staging')) {
          pending.push(path);
        }
        continue;
      }
      if (metadata.isFile()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Replaces the Workspace MCP module with one effective Gateway catalog.
 *
 * @param input Data root, Workspace, and current effective servers.
 * @returns Published catalog document.
 */
export function replaceWorkspaceEffectiveMcpCatalog(input: {
  readonly catalog: WorkspaceMcpServerCatalog;
  readonly createdAt?: string;
  readonly dataRoot: string;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entries: ResourceCatalogDocument['mcp']['entries'] = [];
  const versions: ResourceCatalogDocument['mcp']['versions'] = [];
  const bindings: ResourceCatalogDocument['mcp']['bindings'] = [];
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  for (const server of input.catalog.servers) {
    if (server.id === 'openkit-generative') {
      throw new CatalogForbiddenError(
        'Catalog id openkit-generative is reserved for the built-in Worker MCP surface.'
      );
    }
    const declaration: McpValidatedDeclaration =
      server.transport.kind === 'stdio'
        ? {
            args: [...server.transport.args],
            command: server.transport.command,
            cwd: server.transport.cwd,
            environment: { ...server.transport.environmentValues },
            environmentSlots: { ...server.transport.environment },
            kind: 'stdio',
          }
        : {
            endpoint: server.transport.endpoint,
            headers: { ...server.transport.headers },
            kind: 'http',
          };
    const packageRootDigest = server.packageRootDigest ?? null;
    const digest = digestMcpConfig(declaration, packageRootDigest);
    const packageDataKey = `mcp_${server.id}`;
    mkdirSync(join(layout.catalogMcpData, packageDataKey), { recursive: true });
    entries.push({
      availability: 'available',
      currentVersionDigest: digest,
      displayName: server.id,
      id: server.id,
    });
    versions.push({
      createdAt,
      declaration,
      digest,
      digestFormat: 'openkit-mcp-config-v1',
      entryId: server.id,
      packageRootDigest,
      pluginVersionDigest: null,
      provenance: {
        pluginMemberKey: null,
        sourceCommit: null,
        uploadedSourceId: null,
      },
      publisherLabel: null,
    });
    bindings.push({
      allowedTools: [...server.allowedTools],
      approvalRequiredTools: [...server.approvalRequiredTools],
      credentialBindings: [...server.credentialBindings],
      deniedTools: [...server.deniedTools],
      enabled: server.enabled,
      entryId: server.id,
      packageDataKey,
      pinnedSchemaSnapshotId: server.pinnedSchemaSnapshotId,
      revision: 1,
      schemaPolicy: server.schemaPolicy,
      timeoutMs: server.timeoutMs,
    });
  }
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      mcp: { bindings, entries, versions },
    },
    dataRoot: input.dataRoot,
    expectedRevision: current.revision,
    workspaceId: input.workspaceId,
  });
}

/**
 * Builds the Gateway-facing MCP server from one version and binding.
 *
 * @param binding Current binding.
 * @param version Selected configuration version, including package-root identity.
 * @returns Effective server entry.
 */
function effectiveMcpServer(
  binding: McpBindingRecord,
  version: McpConfigVersionRecord
): WorkspaceMcpServer {
  const transport =
    version.declaration.kind === 'stdio'
      ? {
          args: [...version.declaration.args],
          command: version.declaration.command,
          cwd: version.declaration.cwd,
          environment: { ...version.declaration.environmentSlots },
          environmentValues: { ...version.declaration.environment },
          kind: 'stdio' as const,
        }
      : {
          endpoint: version.declaration.endpoint,
          headers: { ...version.declaration.headers },
          kind: 'http' as const,
        };
  return {
    allowedTools: [...binding.allowedTools],
    approvalRequiredTools: [...binding.approvalRequiredTools],
    credentialBindings: [...binding.credentialBindings],
    deniedTools: [...binding.deniedTools],
    enabled: binding.enabled,
    id: binding.entryId,
    packageRootDigest: version.packageRootDigest,
    pinnedSchemaSnapshotId: binding.pinnedSchemaSnapshotId,
    schemaPolicy: binding.schemaPolicy,
    timeoutMs: binding.timeoutMs,
    transport,
  };
}

/** Parses a local Agent Plugin package root. */
function parsePluginPackage(root: string): {
  description: string | null;
  displayName: string;
  id: string;
  mcp: Array<{
    declaration: McpValidatedDeclaration;
    displayName: string;
    id: string;
    packageKey: string;
  }>;
  publisherLabel: string | null;
  skills: Array<{ displayName: string; id: string; packageKey: string; tree: CatalogTreeFile[] }>;
} {
  const pluginJson = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as {
    description?: string;
    name?: string;
    version?: string;
  };
  const displayName = pluginJson.name ?? 'plugin';
  const id = skillIdFromDisplayName(displayName);
  const skillsRoot = join(root, 'skills');
  const skills: Array<{
    displayName: string;
    id: string;
    packageKey: string;
    tree: CatalogTreeFile[];
  }> = [];
  if (existsSync(skillsRoot)) {
    const names = readDirNames(skillsRoot);
    for (const name of names) {
      const skillRoot = join(skillsRoot, name);
      if (!existsSync(join(skillRoot, 'SKILL.md'))) {
        continue;
      }
      const collected = digestOpenKitTree(skillRoot).entries;
      skills.push({
        displayName: name,
        id: skillIdFromDisplayName(name),
        packageKey: `skills/${name}`,
        tree: collected.map((entry) => ({
          ...(entry.content ? { contentBase64: entry.content.toString('base64') } : {}),
          executable: entry.kind === 2,
          kind: entry.kind === 0 ? 'directory' : 'file',
          path: entry.path,
        })),
      });
    }
  }
  const mcp: Array<{
    declaration: McpValidatedDeclaration;
    displayName: string;
    id: string;
    packageKey: string;
  }> = [];
  const mcpJsonPath = join(root, 'mcp.json');
  if (existsSync(mcpJsonPath)) {
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    for (const [key, server] of Object.entries(mcpJson.mcpServers ?? {})) {
      mcp.push({
        declaration: pluginMcpDeclaration(server),
        displayName: key,
        id: skillIdFromDisplayName(key),
        packageKey: `mcp/${key}`,
      });
    }
  }
  return {
    description: pluginJson.description ?? null,
    displayName,
    id,
    mcp,
    publisherLabel: pluginJson.version ?? null,
    skills,
  };
}

/** Maps a public MCP declaration into the local validated transport. */
function pluginMcpDeclaration(server: Record<string, unknown>): McpValidatedDeclaration {
  if (typeof server.url === 'string' || typeof server.endpoint === 'string') {
    return McpValidatedDeclarationSchema.parse({
      endpoint: String(server.url ?? server.endpoint),
      headers: asStringRecord(server.headers),
      kind: 'http',
    });
  }
  return McpValidatedDeclarationSchema.parse({
    args: Array.isArray(server.args) ? server.args.map((value) => String(value)) : [],
    command: String(server.command ?? ''),
    cwd: typeof server.cwd === 'string' ? server.cwd : null,
    environment: asStringRecord(server.env ?? server.environment),
    kind: 'stdio',
  });
}

/** Converts submitted or collected files into hasher entries. */
function treeFilesToEntries(tree: readonly CatalogTreeFile[]): OpenKitTreeEntry[] {
  return tree.map((entry) => {
    if (entry.kind === 'directory') {
      return { kind: 0, path: entry.path };
    }
    const content = Buffer.from(entry.contentBase64 ?? '', 'base64');
    return { content, kind: entry.executable ? 2 : 1, path: entry.path };
  });
}

/** Builds retained inventory metadata. */
function inventoryFromEntries(
  entries: readonly OpenKitTreeEntry[]
): SkillVersionRecord['inventory'] {
  return entries.map((entry) => ({
    executable: entry.kind === 2,
    kind: entry.kind === 0 ? 'directory' : 'file',
    path: entry.path,
    sha256:
      entry.kind === 0
        ? null
        : `sha256:${createHash('sha256')
            .update(entry.content ?? Buffer.alloc(0))
            .digest('hex')}`,
    size: entry.kind === 0 ? 0 : (entry.content?.length ?? 0),
  }));
}

/** Writes one immutable snapshot directory. */
function materializeSnapshot(target: string, entries: readonly OpenKitTreeEntry[]): void {
  if (existsSync(target)) {
    return;
  }
  const staged = `${target}.staging`;
  rmSync(staged, { force: true, recursive: true });
  mkdirSync(staged, { recursive: true });
  try {
    for (const entry of entries) {
      const path = join(staged, entry.path);
      if (entry.kind === 0) {
        mkdirSync(path, { recursive: true });
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.content ?? Buffer.alloc(0), { flag: 'wx' });
      if (entry.kind === 2) {
        chmodSync(path, 0o755);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staged, target);
  } catch (error) {
    rmSync(staged, { force: true, recursive: true });
    throw error;
  }
}

/** Stable catalog id from a display name. */
function skillIdFromDisplayName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`Cannot derive a catalog id from name: ${value}`);
  }
  return normalized;
}

/** Reads direct child directory names. */
function readDirNames(path: string): string[] {
  return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory());
}

/** Coerces an unknown map into string records. */
function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

/** Atomically writes JSON. */
function writeJsonAtomic(path: string, value: unknown): void {
  const staged = `${path}.staging`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(staged, path);
}
