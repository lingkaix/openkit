import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  ResourceCatalogDocumentViewSchema,
  ResourceCatalogIdSchema,
  type SkillCandidateRecord,
  SkillCandidateRecordSchema,
  SkillEntryRecordSchema,
  type SkillVersionRecord,
  SkillVersionRecordSchema,
  type WorkspaceMcpServer,
  type WorkspaceMcpServerCatalog,
  WorkspaceMcpServerSchema,
} from '@openkit/config-schema';
import { parseDocument } from 'yaml';
import type { ZodError } from 'zod';

import { ensureWorkspaceLayout } from '../storage/fs-layout.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  publishCanonicalPath,
  syncCanonicalDirectory,
  syncCanonicalTree,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';

/** Compare-and-set failure against the catalog revision. */
export class CatalogConflictError extends Error {
  public constructor(message = 'Resource catalog revision conflict.') {
    super(message);
    this.name = 'CatalogConflictError';
  }
}

/** Structural validation failure for a proposed MCP binding, excluding retained-record reads. */
export class McpBindingValidationError extends Error {
  /** Request-derived effective-entry validation detail for the update-binding route. */
  public readonly validationError: ZodError;

  public constructor(validationError: ZodError) {
    super('Invalid MCP binding.', { cause: validationError });
    this.name = 'McpBindingValidationError';
    this.validationError = validationError;
  }
}

/** Invalid authored catalog supply, including unsupported plugin declarations and unrepresentable ids. */
export class CatalogInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogInputError';
  }
}

/** Missing catalog resource. */
export class CatalogNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogNotFoundError';
  }
}

/** Metadata remains retained but its exact installed payload is unavailable. */
export class CatalogContentUnavailableError extends CatalogNotFoundError {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogContentUnavailableError';
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

/** Exact reference causes that prevent physical Skill content deletion. */
export class CatalogRetentionError extends Error {
  public constructor(public readonly references: readonly string[]) {
    super(`Skill content is retained: ${references.join(', ')}`);
    this.name = 'CatalogRetentionError';
  }
}

/** Authenticated decision lineage supplied by the existing Audit owner before publication. */
export type SkillCandidateDecisionContext = NonNullable<SkillCandidateRecord['decision']>;

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

/** Reads the catalog within its owner so normal mutations preserve descriptive history. */
function readWorkspaceResourceCatalog(
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

/** Loads a validated known-core catalog projection, or the empty catalog when unpublished. */
export function loadWorkspaceResourceCatalog(
  dataRoot: string,
  workspaceId: string
): ResourceCatalogDocument {
  return ResourceCatalogDocumentViewSchema.parse(
    readWorkspaceResourceCatalog(dataRoot, workspaceId)
  );
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
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return ResourceCatalogDocumentViewSchema.parse(next);
}

/**
 * Imports one Skill directory as an inactive-or-current version depending on create semantics.
 * Reuses immutable metadata for identical bytes; provenance describes only the first admission.
 *
 * @param input Workspace, identity, and tree.
 * @returns Updated catalog and version.
 */
export function importWorkspaceSkill(input: {
  readonly activate: boolean;
  readonly baseCatalog?: ResourceCatalogDocument;
  readonly baseDigest?: string | null;
  readonly createdAt: string;
  readonly dataRoot: string;
  readonly displayName: string;
  readonly expectedRevision: number;
  readonly id?: string;
  readonly persist?: boolean;
  readonly pluginMemberKey?: string | null;
  readonly pluginVersionDigest?: string | null;
  readonly producer: CatalogProducer;
  readonly sourceSubpath?: string | null;
  readonly uploadedSourceId?: string | null;
  readonly tree: readonly CatalogTreeFile[];
  readonly workspaceId: string;
}): { catalog: ResourceCatalogDocument; version: SkillVersionRecord } {
  const current =
    input.baseCatalog ?? readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  SkillEntryRecordSchema.shape.displayName.parse(input.displayName);
  const entries = treeFilesToEntries(input.tree);
  const digest = hashOpenKitTreeEntries(entries);
  validateSkillTree(
    entries,
    input.pluginMemberKey?.startsWith('skills/')
      ? input.pluginMemberKey.slice('skills/'.length)
      : undefined
  );
  const id = ResourceCatalogIdSchema.parse(input.id ?? skillIdFromDisplayName(input.displayName));
  const existing = current.skills.entries.find((entry) => entry.id === id);
  if (existing?.availability === 'removed') throw new CatalogNotFoundError(`Skill removed: ${id}`);
  if (
    input.baseDigest &&
    !current.skills.versions.some((item) => item.entryId === id && item.digest === input.baseDigest)
  ) {
    throw new CatalogNotFoundError(`Skill base version not found: ${input.baseDigest}`);
  }
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  const retainedVersion = current.skills.versions.find(
    (item) => item.entryId === id && item.digest === digest
  );
  const version: SkillVersionRecord = retainedVersion
    ? { ...retainedVersion, contentState: 'retained' }
    : {
        contentState: 'retained',
        createdAt: input.createdAt,
        digest,
        digestFormat: 'openkit-tree-v1',
        entryId: id,
        inventory: inventoryFromEntries(entries),
        producer: input.producer,
        provenance: {
          baseDigest: input.baseDigest ?? null,
          pluginMemberKey: input.pluginMemberKey ?? null,
          pluginVersionDigest: input.pluginVersionDigest ?? null,
          sourceCommit: null,
          sourceSubpath: input.sourceSubpath ?? null,
          uploadedSourceId: input.uploadedSourceId ?? null,
        },
        publisherVersion: null,
      };
  if (!retainedVersion) SkillVersionRecordSchema.parse(version);
  const snapshotPath = join(layout.catalogSkillSnapshots, id, digest.slice('sha256:'.length));
  if (existsSync(snapshotPath)) verifySkillSnapshot(input, version);
  materializeSnapshot(snapshotPath, entries);
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
  const versions = retainedVersion
    ? current.skills.versions.map((item) => (item === retainedVersion ? version : item))
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
  // Public results use the known-field projection; retained annotations stay in catalog storage.
  return {
    catalog,
    version: catalog.skills.versions.find((item) => item.entryId === id && item.digest === digest)!,
  };
}

/** Submits a Skill candidate without changing the current pointer. */
export function submitWorkspaceSkillCandidate(input: {
  readonly baseDigest: string | null;
  readonly createdAt: string;
  readonly dataRoot: string;
  readonly entryId: string;
  readonly evidenceRefs?: readonly string[];
  readonly expectedRevision: number;
  readonly producer: CatalogProducer;
  readonly summary: string;
  readonly submitter?: CatalogProducer;
  readonly tree: readonly CatalogTreeFile[];
  readonly uploadedSourceId?: string | null;
  readonly workspaceId: string;
}): { candidate: SkillCandidateRecord; catalog: ResourceCatalogDocument } {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  SkillCandidateRecordSchema.shape.summary.parse(input.summary);
  const evidenceRefs = SkillCandidateRecordSchema.shape.evidenceRefs.parse(
    input.evidenceRefs ?? []
  );
  const submitter = SkillCandidateRecordSchema.shape.submitter.parse(
    input.submitter ?? input.producer
  );
  const entry = current.skills.entries.find((item) => item.id === input.entryId);
  if (entry?.availability === 'removed' || (!entry && input.baseDigest !== null)) {
    throw new CatalogNotFoundError(`Skill not found: ${input.entryId}`);
  }
  if (entry && input.baseDigest === null)
    throw new CatalogInputError('An existing Skill requires an exact candidate base digest.');
  const candidateId = `cand_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const imported = importWorkspaceSkill({
    activate: false,
    baseCatalog: current,
    baseDigest: input.baseDigest,
    createdAt: input.createdAt,
    dataRoot: input.dataRoot,
    displayName: entry?.displayName ?? input.entryId,
    expectedRevision: input.expectedRevision,
    id: input.entryId,
    persist: false,
    producer: input.producer,
    tree: input.tree,
    uploadedSourceId: input.uploadedSourceId ?? null,
    workspaceId: input.workspaceId,
  });
  const candidate: SkillCandidateRecord = {
    baseDigest: input.baseDigest,
    candidateDigest: imported.version.digest,
    createdAt: input.createdAt,
    decision: null,
    disposition: 'proposed',
    entryId: input.entryId,
    evidenceRefs,
    id: candidateId,
    producer: input.producer,
    summary: input.summary,
    submitter,
  };
  const catalog = publishWorkspaceResourceCatalog({
    catalog: {
      ...imported.catalog,
      skills: {
        ...imported.catalog.skills,
        candidates: [...imported.catalog.skills.candidates, candidate],
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
  return { candidate, catalog };
}

/** Promotes, rejects, or withdraws one proposed candidate. */
export function decideWorkspaceSkillCandidate(input: {
  readonly candidateId: string;
  readonly dataRoot: string;
  readonly decision: 'promoted' | 'rejected' | 'withdrawn';
  readonly decisionContext: SkillCandidateDecisionContext;
  readonly configurationOwner?: boolean;
  readonly expectedCurrentDigest?: string | null;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  if (!input.decisionContext)
    throw new CatalogIntegrityError(
      'Skill candidate decisions require exact actor and Audit lineage.'
    );
  const candidate = current.skills.candidates.find((item) => item.id === input.candidateId);
  if (!candidate || candidate.disposition !== 'proposed') {
    throw new CatalogNotFoundError(`Skill candidate not found: ${input.candidateId}`);
  }
  if (
    input.decision === 'withdrawn' &&
    !input.configurationOwner &&
    (candidate.submitter?.id !== input.decisionContext.actor.id ||
      candidate.submitter?.kind !== input.decisionContext.actor.kind)
  ) {
    throw new CatalogForbiddenError(
      'Only the submitting actor or configuration owner can withdraw a Skill candidate.'
    );
  }
  const entry = current.skills.entries.find((item) => item.id === candidate.entryId);
  if (
    Object.hasOwn(input, 'expectedCurrentDigest') &&
    entry?.currentDigest !== input.expectedCurrentDigest
  )
    throw new CatalogConflictError('Skill current digest conflict.');
  if (
    input.decision === 'promoted' &&
    candidate.baseDigest !==
      current.skills.entries.find((entry) => entry.id === candidate.entryId)?.currentDigest
  ) {
    throw new CatalogConflictError('Skill candidate base no longer matches the current digest.');
  }
  if (input.decision === 'promoted') {
    if (entry?.availability !== 'available')
      throw new CatalogNotFoundError(`Skill not found: ${candidate.entryId}`);
    const version = current.skills.versions.find(
      (item) => item.entryId === candidate.entryId && item.digest === candidate.candidateDigest
    );
    if (!version)
      throw new CatalogNotFoundError(`Skill version not found: ${candidate.candidateDigest}`);
    verifySkillSnapshot(input, version);
  }
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      skills: {
        ...current.skills,
        candidates: current.skills.candidates.map((item) =>
          item.id === candidate.id
            ? { ...item, decision: input.decisionContext, disposition: input.decision }
            : item
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
  readonly expectedPinDigest?: string | null;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  const entry = current.skills.entries.find((item) => item.id === input.entryId);
  if (!entry) throw new CatalogNotFoundError(`Skill not found: ${input.entryId}`);
  const prior = current.skills.pins.find((pin) => pin.entryId === input.entryId)?.digest ?? null;
  if (Object.hasOwn(input, 'expectedPinDigest') && prior !== input.expectedPinDigest)
    throw new CatalogConflictError('Skill pin digest conflict.');
  if (input.digest !== null) {
    const version = current.skills.versions.find(
      (item) => item.entryId === input.entryId && item.digest === input.digest
    );
    if (entry.availability !== 'available' || !version)
      throw new CatalogNotFoundError(`Skill version not found: ${input.entryId}/${input.digest}`);
    verifySkillSnapshot(input, version);
  }
  const pins =
    input.digest === null
      ? current.skills.pins.filter((pin) => pin.entryId !== input.entryId)
      : [
          ...current.skills.pins.filter((pin) => pin.entryId !== input.entryId),
          {
            ...current.skills.pins.find((pin) => pin.entryId === input.entryId),
            digest: input.digest,
            entryId: input.entryId,
          },
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
  readonly expectedCurrentDigest?: string | null;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  const entry = current.skills.entries.find((item) => item.id === input.entryId);
  if (
    Object.hasOwn(input, 'expectedCurrentDigest') &&
    entry?.currentDigest !== input.expectedCurrentDigest
  )
    throw new CatalogConflictError('Skill current digest conflict.');
  const version = current.skills.versions.find(
    (item) => item.entryId === input.entryId && item.digest === input.digest
  );
  if (entry?.availability !== 'available' || !version) {
    throw new CatalogNotFoundError(`Skill version not found: ${input.digest}`);
  }
  verifySkillSnapshot(input, version);
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

/** Reads and verifies the exact retained Skill tree without source lookup or selection changes. */
export function readWorkspaceSkillSnapshot(input: {
  readonly dataRoot: string;
  readonly digest: string;
  readonly entryId: string;
  readonly workspaceId: string;
}) {
  const catalog = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const version = catalog.skills.versions.find(
    (item) => item.entryId === input.entryId && item.digest === input.digest
  );
  if (!version)
    throw new CatalogNotFoundError(`Skill version not found: ${input.entryId}/${input.digest}`);
  return { entries: verifySkillSnapshot(input, version), version };
}

/** Rejects missing, unsafe or changed retained content before selection or disclosure. */
function verifySkillSnapshot(
  input: { readonly dataRoot: string; readonly workspaceId: string },
  version: SkillVersionRecord
): readonly OpenKitTreeEntry[] {
  if (version.contentState === 'purged')
    throw new CatalogContentUnavailableError(
      `Skill content was purged: ${version.entryId}/${version.digest}`
    );
  const path = skillSnapshotPath(
    input.dataRoot,
    input.workspaceId,
    version.entryId,
    version.digest
  );
  if (!existsSync(path))
    throw new CatalogContentUnavailableError(
      `Skill content unavailable: ${version.entryId}/${version.digest}`
    );
  try {
    assertCanonicalDirectory(dirname(path));
    const tree = digestOpenKitTree(path);
    if (tree.digest !== version.digest) throw new Error('Digest mismatch.');
    const inventory = inventoryFromEntries(tree.entries);
    if (
      inventory.length !== version.inventory.length ||
      inventory.some(
        (row) =>
          !version.inventory.some(
            (retained) =>
              row.path === retained.path &&
              row.kind === retained.kind &&
              row.sha256 === retained.sha256 &&
              row.size === retained.size &&
              row.executable === retained.executable
          )
      )
    )
      throw new Error('Inventory mismatch.');
    return tree.entries;
  } catch {
    throw new CatalogIntegrityError(
      `Skill snapshot integrity failed: ${version.entryId}/${version.digest}`
    );
  }
}

/** Blocks future selection while retaining exact history, pins and snapshot bytes. */
export function removeWorkspaceSkill(input: {
  readonly dataRoot: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  if (!current.skills.entries.some((entry) => entry.id === input.entryId))
    throw new CatalogNotFoundError(`Skill not found: ${input.entryId}`);
  return publishWorkspaceResourceCatalog({
    catalog: {
      ...current,
      skills: {
        ...current.skills,
        entries: current.skills.entries.map((entry) =>
          entry.id === input.entryId
            ? { ...entry, availability: 'removed', currentDigest: null }
            : entry
        ),
      },
    },
    dataRoot: input.dataRoot,
    expectedRevision: input.expectedRevision,
    workspaceId: input.workspaceId,
  });
}

/** Purges only after complete reference admission by the existing external retention owners. */
export function purgeWorkspaceSkillVersion(input: {
  readonly dataRoot: string;
  readonly digest: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly retainedReferences: readonly string[] | null;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) throw new CatalogConflictError();
  if (
    !current.skills.versions.some(
      (version) => version.entryId === input.entryId && version.digest === input.digest
    )
  )
    throw new CatalogNotFoundError(`Skill version not found: ${input.entryId}/${input.digest}`);
  const references = [...(input.retainedReferences ?? ['retention_authority_unavailable'])];
  if (
    current.skills.entries.some(
      (entry) => entry.id === input.entryId && entry.currentDigest === input.digest
    )
  )
    references.push(`skill_default:${input.entryId}`);
  if (
    current.skills.pins.some((pin) => pin.entryId === input.entryId && pin.digest === input.digest)
  )
    references.push(`skill_pin:${input.entryId}`);
  for (const candidate of current.skills.candidates) {
    if (
      candidate.entryId === input.entryId &&
      candidate.disposition === 'proposed' &&
      (candidate.baseDigest === input.digest || candidate.candidateDigest === input.digest)
    )
      references.push(`skill_candidate:${candidate.id}`);
  }
  for (const version of current.plugins.versions) {
    if (
      version.members.some(
        (member) =>
          member.kind === 'skill' &&
          member.catalogId === input.entryId &&
          member.versionDigest === input.digest
      )
    )
      references.push(`plugin_version:${version.entryId}/${version.digest}`);
  }
  if (references.length > 0) throw new CatalogRetentionError(references);
  const path = skillSnapshotPath(input.dataRoot, input.workspaceId, input.entryId, input.digest);
  try {
    ensureCanonicalDirectory(dirname(path), 0o777);
    rmSync(path, { force: true, recursive: true });
    syncCanonicalDirectory(dirname(path));
    return publishWorkspaceResourceCatalog({
      catalog: {
        ...current,
        skills: {
          ...current.skills,
          versions: current.skills.versions.map((version) =>
            version.entryId === input.entryId && version.digest === input.digest
              ? { ...version, contentState: 'purged' }
              : version
          ),
        },
      },
      dataRoot: input.dataRoot,
      expectedRevision: input.expectedRevision,
      workspaceId: input.workspaceId,
    });
  } catch {
    // The receipt owner retains admitted intent; a new request must inspect any unacknowledged deletion.
    throw new CatalogIntegrityError(
      'Skill purge could not acknowledge content deletion and catalog publication.'
    );
  }
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
    throw new CatalogForbiddenError('Catalog id is reserved for a built-in Worker MCP surface.');
  }
  const current =
    input.baseCatalog ?? readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
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
    mcp: { ...current.mcp, bindings, entries, versions },
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

/** Validates one MCP binding against its current transport before compare-and-set publication. */
export function updateWorkspaceMcpBinding(input: {
  readonly binding: Omit<McpBindingRecord, 'entryId' | 'packageDataKey'> & {
    readonly packageDataKey?: string;
  };
  readonly dataRoot: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly workspaceId: string;
}): ResourceCatalogDocument {
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const existing = current.mcp.bindings.find((item) => item.entryId === input.entryId);
  if (current.revision !== input.expectedRevision) {
    throw new CatalogConflictError();
  }
  if (existing && existing.revision !== input.binding.revision) {
    throw new CatalogConflictError('MCP binding revision conflict.');
  }
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  const packageDataKey =
    existing?.packageDataKey ?? input.binding.packageDataKey ?? `mcp_${input.entryId}`;
  mkdirSync(join(layout.catalogMcpData, packageDataKey), { recursive: true });
  const nextBinding: McpBindingRecord = {
    ...existing,
    ...input.binding,
    entryId: input.entryId,
    packageDataKey,
    revision: (existing?.revision ?? 0) + 1,
  };
  const currentDigest = current.mcp.entries.find(
    (entry) => entry.id === input.entryId
  )?.currentVersionDigest;
  const version = current.mcp.versions.find(
    (candidate) => candidate.entryId === input.entryId && candidate.digest === currentDigest
  );
  if (version) {
    const parsed = WorkspaceMcpServerSchema.safeParse(effectiveMcpServer(nextBinding, version));
    if (!parsed.success) {
      throw new McpBindingValidationError(parsed.error);
    }
  }
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
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
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
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (current.revision !== input.expectedRevision) {
    throw new CatalogConflictError();
  }
  const packageTree = digestOpenKitTree(input.treeRoot, {
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 4_096,
  });
  const parsed = parsePluginPackage(packageTree.entries);
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
      pluginMemberKey: skill.packageKey,
      pluginVersionDigest: packageTree.digest,
      producer: input.producer,
      sourceSubpath: skill.packageKey,
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
        ...existingInstallation,
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
        ...catalog.plugins,
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
  const current = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entries: ResourceCatalogDocument['mcp']['entries'] = [];
  const versions: ResourceCatalogDocument['mcp']['versions'] = [];
  const bindings: ResourceCatalogDocument['mcp']['bindings'] = [];
  const layout = ensureWorkspaceLayout(input.dataRoot, input.workspaceId);
  for (const server of input.catalog.servers) {
    if (server.id === 'openkit-generative') {
      throw new CatalogForbiddenError('Catalog id is reserved for a built-in Worker MCP surface.');
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
      mcp: { ...current.mcp, bindings, entries, versions },
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

/** Parses the captured package bytes; source mutation cannot change admitted members. */
function parsePluginPackage(packageEntries: readonly OpenKitTreeEntry[]): {
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
  const readJson = (path: string, required: boolean): Record<string, unknown> | null => {
    const entry = packageEntries.find((item) => item.path === path);
    if (!entry) {
      if (required) throw new CatalogInputError(`Agent Plugin requires ${path}.`);
      return null;
    }
    if (entry.kind === 0)
      throw new CatalogInputError(`Agent Plugin ${path} must be a regular file.`);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.content));
    } catch {
      throw new CatalogInputError(`Agent Plugin ${path} must contain valid UTF-8 JSON.`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new CatalogInputError(`Agent Plugin ${path} must contain an object.`);
    return value as Record<string, unknown>;
  };
  const pluginJson = readJson('plugin.json', true)!;
  for (const field of ['name', 'description', 'version']) {
    if (
      pluginJson[field] !== undefined &&
      (typeof pluginJson[field] !== 'string' || pluginJson[field].length === 0)
    )
      throw new CatalogInputError(`Agent Plugin ${field} must be a non-empty string.`);
  }
  const displayName = (pluginJson.name as string | undefined) ?? 'plugin';
  const id = skillIdFromDisplayName(displayName);
  const skills: Array<{
    displayName: string;
    id: string;
    packageKey: string;
    tree: CatalogTreeFile[];
  }> = [];
  for (const root of packageEntries.filter((entry) =>
    /^skills\/[^/]+\/SKILL\.md$/.test(entry.path)
  )) {
    const name = root.path.split('/')[1]!;
    const prefix = `skills/${name}/`;
    const entries = packageEntries
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    // Validate every component before any package or component payload becomes canonical.
    hashOpenKitTreeEntries(entries);
    validateSkillTree(entries, name);
    skills.push({
      displayName: name,
      id: skillIdFromDisplayName(name),
      packageKey: `skills/${name}`,
      tree: entries.map((entry) => ({
        ...(entry.content ? { contentBase64: entry.content.toString('base64') } : {}),
        executable: entry.kind === 2,
        kind: entry.kind === 0 ? 'directory' : 'file',
        path: entry.path,
      })),
    });
  }
  const mcp: Array<{
    declaration: McpValidatedDeclaration;
    displayName: string;
    id: string;
    packageKey: string;
  }> = [];
  const mcpJson = readJson('mcp.json', false);
  const servers = mcpJson?.mcpServers ?? {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers))
    throw new CatalogInputError('Agent Plugin mcpServers must contain an object.');
  for (const [key, server] of Object.entries(servers)) {
    if (server === null || typeof server !== 'object' || Array.isArray(server))
      throw new CatalogInputError('Agent Plugin MCP declarations must contain objects.');
    mcp.push({
      declaration: pluginMcpDeclaration(server as Record<string, unknown>),
      displayName: key,
      id: skillIdFromDisplayName(key),
      packageKey: `mcp/${key}`,
    });
  }
  return {
    description: (pluginJson.description as string | undefined) ?? null,
    displayName,
    id,
    mcp,
    publisherLabel: (pluginJson.version as string | undefined) ?? null,
    skills,
  };
}

/** Maps a public MCP declaration into the local validated transport. */
function pluginMcpDeclaration(server: Record<string, unknown>): McpValidatedDeclaration {
  if (typeof server.url === 'string' || typeof server.endpoint === 'string') {
    if (Object.hasOwn(server, 'auth')) {
      throw new CatalogInputError(
        'Upstream OAuth connection required; NanoCore OAuth onboarding and refresh are not implemented'
      );
    }
    if (Object.hasOwn(server, 'query')) {
      throw new CatalogInputError('MCP HTTP query options are unsupported.');
    }
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

/** Validates authored Skill metadata without changing payload bytes or granting tool authority. */
function validateSkillTree(entries: readonly OpenKitTreeEntry[], expectedName?: string): void {
  const root = entries.find((entry) => entry.path === 'SKILL.md');
  if (!root || root.kind === 0)
    throw new CatalogInputError('Skill admission requires a root SKILL.md regular file.');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(root.content);
  } catch {
    throw new CatalogInputError('Skill SKILL.md must contain valid UTF-8.');
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter)
    throw new CatalogInputError('Skill SKILL.md requires Agent Skills YAML frontmatter.');
  const document = parseDocument(frontmatter[1]!);
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new CatalogInputError('Skill SKILL.md has invalid YAML frontmatter.');
  let metadata: unknown;
  try {
    metadata = document.toJS();
  } catch {
    throw new CatalogInputError('Skill SKILL.md has invalid YAML frontmatter.');
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new CatalogInputError('Skill SKILL.md requires a metadata mapping.');
  const header = metadata as Record<string, unknown>;
  if (
    typeof header.name !== 'string' ||
    header.name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(header.name)
  )
    throw new CatalogInputError('Skill SKILL.md requires a valid Agent Skills name.');
  if (expectedName !== undefined && header.name !== expectedName)
    throw new CatalogInputError('Skill SKILL.md name must match its package directory.');
  if (
    typeof header.description !== 'string' ||
    header.description.trim().length === 0 ||
    header.description.length > 1_024
  )
    throw new CatalogInputError(
      'Skill SKILL.md requires a description of 1 through 1024 characters.'
    );
  if (header.license !== undefined && typeof header.license !== 'string')
    throw new CatalogInputError('Skill SKILL.md license must be a string.');
  if (
    header.compatibility !== undefined &&
    (typeof header.compatibility !== 'string' ||
      header.compatibility.length === 0 ||
      header.compatibility.length > 500)
  )
    throw new CatalogInputError(
      'Skill SKILL.md compatibility must contain 1 through 500 characters.'
    );
  if (
    header.metadata !== undefined &&
    (header.metadata === null ||
      typeof header.metadata !== 'object' ||
      Array.isArray(header.metadata) ||
      Object.values(header.metadata).some((value) => typeof value !== 'string'))
  )
    throw new CatalogInputError('Skill SKILL.md metadata must map string keys to string values.');
  if (header['allowed-tools'] !== undefined && typeof header['allowed-tools'] !== 'string')
    throw new CatalogInputError('Skill SKILL.md allowed-tools must be a string.');
}

/** Forms the actual tree, including ancestors that materialization must create, before shared validation. */
function treeFilesToEntries(tree: readonly CatalogTreeFile[]): OpenKitTreeEntry[] {
  const entries: OpenKitTreeEntry[] = tree.map((entry) => {
    if (entry.kind === 'directory') {
      return { kind: 0, path: entry.path };
    }
    const content = Buffer.from(entry.contentBase64 ?? '', 'base64');
    return { content, kind: entry.executable ? 2 : 1, path: entry.path };
  });
  const directories = new Set(
    entries.filter((entry) => entry.kind === 0).map((entry) => entry.path)
  );
  for (const entry of tree) {
    const segments = entry.path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/');
      if (!directories.has(path)) {
        directories.add(path);
        // A file at this path remains a duplicate, which the shared validator rejects.
        entries.push({ kind: 0, path });
      }
    }
  }
  return entries;
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
    // A visible snapshot can be the result of a failed post-rename acknowledgement.
    syncCanonicalTree(target);
    syncCanonicalDirectory(dirname(target));
    return;
  }
  const staged = `${target}.staging`;
  rmSync(staged, { force: true, recursive: true });
  ensureCanonicalDirectory(dirname(target), 0o777);
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
    publishCanonicalPath(staged, target);
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
    throw new CatalogInputError(`Cannot derive a catalog id from name: ${value}`);
  }
  return normalized;
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
