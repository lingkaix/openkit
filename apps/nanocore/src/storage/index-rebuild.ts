import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  type KnowledgeRetrievalResponse,
  KnowledgeRetrievalResponseSchema,
  type KnowledgeRetrievalTrace,
  KnowledgeRetrievalTraceSchema,
  RetrieveKnowledgeRequestSchema,
} from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  formatReferenceUri,
  type PageReference,
  parseReferenceScope,
  type RetrievalTraceReference,
} from '@openkit/protocol';
import { assertScopeAdmitted, isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { unresolvedNotebookSubjects } from '../knowledge/conflicts.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import {
  projectWorkspaceKnowledgeIndexes,
  readKnowledgePageIds,
  verifiedKnowledgePageSourceReferences,
  type WorkspaceKnowledgeLinkEdge,
  type WorkspaceKnowledgeSourceReference,
  type WorkspaceKnowledgeValidationRecord,
} from '../knowledge/notebook-index-projection.js';
import {
  currentWorkspaceNotebookRead,
  readWorkspaceNotebookIndexSource,
  type WorkspaceNotebookRead,
} from '../knowledge/notebook-index-source.js';
import {
  type KnowledgePageReferenceProof,
  parseOkfDocument,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateKnowledgePageCandidate,
} from '../knowledge/okf.js';
import { readSourcePointers } from '../knowledge/source-pointers.js';
import { OperationError } from '../operation-error.js';
import {
  admitKnowledgeRetrieval,
  admitServerKnowledgeRetrieval,
  admitUserMemoryRetrieval,
  collectKnowledgeInventory,
  collectServerKnowledgeInventory,
  collectUserMemoryInventory,
  currentKnowledgeReferenceProofs,
  type KnowledgeRetrievalAccess,
  knowledgePageDelegated,
  knowledgePageReadable,
  knowledgeSourceReferencesReadable,
  prepareAuthorizedWorkspaceNotebookRead,
  readAuthorizedServerNotebookPages,
  readAuthorizedUserMemoryPages,
  readAuthorizedWorkspaceNotebookPages,
  resolveKnowledgeQueryContext,
  type UserMemoryRetrievalAccess,
} from '../retrieval-knowledge-adapter.js';
import { getRetrievalService } from '../retrieval-service.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import {
  resolveDataRootPath,
  serverKnowledgeRoot,
  userMemoryRoot,
  workspaceDbPath,
} from './fs-layout.js';
import { publishRetrievalTrace, readRetrievalTrace } from './retrieval-traces.js';
import {
  assertCanonicalDirectory,
  readAdmittedWorkspaceKnowledgeSelection,
  readCanonicalTextFile,
} from './workspace-file-records.js';

export type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';

/** Derived workspace knowledge link graph file. */
export interface WorkspaceKnowledgeLinkGraph {
  /** Canonical Git revision used for this rebuildable projection. */
  notebookRevision: string;
  /** Link graph schema version. */
  schemaVersion: 1;
  /** Workspace that owns the derived graph. */
  workspaceId: string;
  /** Rebuild timestamp. */
  rebuiltAt: string;
  /** Directed concept-link edges. */
  edges: WorkspaceKnowledgeLinkEdge[];
}

/** Derived workspace knowledge validation report file. */
export interface WorkspaceKnowledgeValidationIndex {
  /** Canonical Git revision used for this rebuildable projection. */
  notebookRevision: string;
  /** Validation index schema version. */
  schemaVersion: 1;
  /** Workspace that owns the derived report. */
  workspaceId: string;
  /** Rebuild timestamp. */
  rebuiltAt: string;
  /** Per-page validation records. */
  records: WorkspaceKnowledgeValidationRecord[];
}

/** Derived workspace knowledge source-reference index file. */
export interface WorkspaceKnowledgeSourceReferenceIndex {
  /** Canonical Git revision used for this rebuildable projection. */
  notebookRevision: string;
  /** Source-reference index schema version. */
  schemaVersion: 1;
  /** Workspace that owns the derived index. */
  workspaceId: string;
  /** Rebuild timestamp. */
  rebuiltAt: string;
  /** Source references declared by parseable file-backed knowledge pages. */
  references: WorkspaceKnowledgeSourceReference[];
}

/**
 * Input for rebuilding one workspace's derived indexes.
 */
export interface RebuildWorkspaceDerivedIndexesInput {
  /** Content-only bytes loaded before this synchronous derived projection. */
  notebookRead?: WorkspaceNotebookRead | undefined;
  /** Data root that owns the workspace. */
  dataRoot: string;
  /** Workspace to rebuild. */
  workspaceId: string;
  /** Optional server-selected retained published revision. */
  notebookRevision?: string | undefined;
  /** Optional timestamp source for deterministic tests. */
  now?: () => string;
}

/**
 * Result of rebuilding one workspace's derived indexes.
 */
export interface RebuildWorkspaceDerivedIndexesResult {
  /** Workspace that was rebuilt. */
  workspaceId: string;
  /** Search index path relative to the data root. */
  indexPath: string;
  /** Number of entries written to the search index. */
  itemCount: number;
  /** Existing index entries removed before rebuild. */
  removedEntries: string[];
}

/**
 * Input for reading one workspace's derived Knowledge Store indexes.
 */
export interface ReadWorkspaceKnowledgeDerivedIndexesInput {
  /** Content-only bytes loaded before this synchronous derived projection. */
  notebookRead?: WorkspaceNotebookRead | undefined;
  /** Optional server-selected retained published Notebook revision. */
  notebookRevision?: string | undefined;
  /** Data root that owns the workspace. */
  dataRoot: string;
  /** Workspace to read. */
  workspaceId: string;
}

/**
 * Derived Knowledge Store indexes exposed to product surfaces.
 */
export interface WorkspaceKnowledgeDerivedIndexes {
  /** Derived Markdown concept-link graph. */
  linkGraph: WorkspaceKnowledgeLinkGraph;
  /** Derived per-page validation report. */
  validation: WorkspaceKnowledgeValidationIndex;
  /** Derived per-page source-reference index. */
  sourceReferences: WorkspaceKnowledgeSourceReferenceIndex;
}

/** Input for deterministic Knowledge Store retrieval. */
export interface RetrieveWorkspaceKnowledgeInput extends ReadWorkspaceKnowledgeDerivedIndexesInput {
  /** Trusted current actor and source owners, never model input. */
  access: KnowledgeRetrievalAccess;
  /** Explicit state inspection; automatic callers remain active-only. */
  states?: readonly ('active' | 'draft' | 'archived' | 'superseded')[] | undefined;
  /** Server-owned product surface requesting retrieval. */
  caller: 'assistant' | 'task-mode' | 'app-api';
  /** User query used to rank active Knowledge Store pages. */
  query: string;
  /** Maximum number of selected candidates. */
  limit?: number | undefined;
  /** Concepts that should be included when present and active. */
  pinnedReferences?: readonly PageReference[] | undefined;
  /** Optional any-match governed type names; combined selectors intersect. */
  types?: readonly string[] | undefined;
  /** Exact declared tool/work-step identifiers on Rule, Effect or Objective pages. */
  appliesTo?: readonly string[] | undefined;
  /** Narrowing-only base selection; the current Workspace is the default. */
  sourceScope?: 'workspace' | 'server' | undefined;
  /** Optional trace id for deterministic tests and route ownership. */
  traceId?: string | undefined;
  /** Awaits caller accounting before the original final authority and eligibility checks. */
  beforeDisclosure?: ((result: KnowledgeRetrievalResponse) => void | Promise<void>) | undefined;
  /** Optional timestamp source for deterministic tests. */
  now?: (() => string) | undefined;
}

/** Explicit User Memory selection; trusted self/private query facts cannot be supplied by request payloads. */
export interface RetrieveUserMemoryInput
  extends Omit<RetrieveWorkspaceKnowledgeInput, 'access' | 'sourceScope' | 'caller'> {
  access: UserMemoryRetrievalAccess;
  caller: 'app-api' | 'assistant';
}

/** Selected Knowledge Store retrieval candidate. */
export interface WorkspaceKnowledgeRetrievalCandidate {
  /** Selected Knowledge Page id. */
  knowledgePageId: string;
  /** SHA-256 digest of the exact authoritative page bytes. */
  contentDigest: string;
  /** Deterministic retrieval score. */
  score: number;
  /** Source references declared by this page. */
  sourceReferences: string[];
}

/** Retrieval candidate excluded from the selected context budget. */
export interface WorkspaceKnowledgeRetrievalExclusion {
  /** Excluded Knowledge Page id. */
  knowledgePageId: string;
  /** Exact page digest, or null when content may not be exposed. */
  contentDigest: string | null;
  /** Deterministic exclusion reason. */
  reason:
    | 'sensitive_content'
    | 'lower_conformance'
    | 'policy_excluded'
    | 'selector_mismatch'
    | 'freshness_expired'
    | 'budget_exceeded'
    | 'source_unavailable';
  /** Optional finite diagnosis; it grants no eligibility or access authority. */
  eligibilityReason?: KnowledgeRetrievalResponse['excluded'][number]['eligibilityReason'];
}

/** Exact authoritative Knowledge Page selected for one Task worker Context Package. */
export interface ResolvedWorkspaceKnowledgeRetrievalPage {
  /** Exact selected Notebook commit, independent of page digest. */
  notebookRevision: string;
  /** Exact retained default Knowledge Base that supplied the selected bytes. */
  knowledgeBaseId: string;
  /** Qualified identity retained through citations and current-byte resolution. */
  reference: PageReference;
  /** Selected Knowledge Page id. */
  knowledgePageId: string;
  /** SHA-256 digest of the exact authoritative page bytes. */
  contentDigest: string;
  /** Source references declared by the page in canonical retrieval order. */
  sourceRefs: string[];
  /** Exact authoritative UTF-8 Markdown bytes. */
  content: string;
  /** Human-readable page title from the verified authoritative bytes. */
  title: string;
  /** Markdown body from the verified authoritative bytes. */
  body: string;
  /** Existing App API projection kind, defaulted for native OKF pages. */
}

/** Options for boot-time derived index rebuild scans. */
export interface RebuildExistingWorkspaceDerivedIndexesOptions {
  /** Optional timestamp source for deterministic tests. */
  now?: () => string;
}

/**
 * Rebuilds derived Workspace indexes from native identity and Notebook source records.
 *
 * @param input Rebuild target and optional clock.
 * @returns Rebuild result with relative index path and counts.
 * @throws Error when the canonical workspace projection is missing.
 */
export function rebuildWorkspaceDerivedIndexes(
  input: RebuildWorkspaceDerivedIndexesInput
): RebuildWorkspaceDerivedIndexesResult {
  assertScopeAdmitted(input.dataRoot, 'workspace', input.workspaceId);
  const workspaceRoot = resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId);
  const retiredWorkspacePath = join(workspaceRoot, 'workspace.json');

  if (existsSync(retiredWorkspacePath)) {
    throw new Error(
      `Unsupported Workspace projection: ${toReportPath(input.dataRoot, retiredWorkspacePath)}`
    );
  }
  assertNativeWorkspaceRecord(input.dataRoot, input.workspaceId);

  const indexesRoot = join(workspaceRoot, 'indexes');
  const indexPath = join(indexesRoot, 'knowledge-validation.json');
  const rebuiltAt = input.now?.() ?? new Date().toISOString();
  const pageScopeId = currentKnowledgePageScope(input, 'workspace');
  const selection = readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, input.workspaceId);
  const source = readWorkspaceNotebookIndexSource(
    workspaceRoot,
    input.notebookRevision,
    undefined,
    input.notebookRead,
    selection
  );
  const projected = projectWorkspaceKnowledgeIndexes({
    pages: source.pages,
    pageScopeId,
    scopeSchemaText: readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, input.workspaceId)
      .scopeSchemaText,
    registeredSources: readRegisteredSources(workspaceRoot, input.workspaceId),
  });
  const linkGraph: WorkspaceKnowledgeLinkGraph = {
    notebookRevision: source.notebookRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    edges: projected.edges,
  };
  const validationIndex: WorkspaceKnowledgeValidationIndex = {
    notebookRevision: source.notebookRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    records: projected.records,
  };
  const sourceReferenceIndex: WorkspaceKnowledgeSourceReferenceIndex = {
    notebookRevision: source.notebookRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    references: projected.references,
  };
  const removedEntries = clearIndexDirectory(indexesRoot);

  writeFileSync(
    join(indexesRoot, 'knowledge-links.json'),
    `${JSON.stringify(linkGraph, null, 2)}\n`
  );
  writeFileSync(
    join(indexesRoot, 'knowledge-validation.json'),
    `${JSON.stringify(validationIndex, null, 2)}\n`
  );
  writeFileSync(
    join(indexesRoot, 'knowledge-source-refs.json'),
    `${JSON.stringify(sourceReferenceIndex, null, 2)}\n`
  );

  return {
    workspaceId: input.workspaceId,
    indexPath: toReportPath(input.dataRoot, indexPath),
    itemCount: validationIndex.records.length,
    removedEntries,
  };
}

/**
 * Rebuilds indexes for existing workspaces that have canonical projections.
 *
 * @param dataRoot Data root to scan.
 * @param options Optional rebuild options.
 * @returns Rebuild results for workspaces that were rebuilt.
 */
export function rebuildExistingWorkspaceDerivedIndexes(
  dataRoot: string,
  options: RebuildExistingWorkspaceDerivedIndexesOptions = {}
): RebuildWorkspaceDerivedIndexesResult[] {
  return listCanonicalWorkspaces(dataRoot).map((workspace) =>
    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: workspace.workspaceId,
      ...(options.now ? { now: options.now } : {}),
    })
  );
}

/** The three rebuildable non-lexical projections; the kernel owns all lexical state. */
const DERIVED_INDEX_FILES = [
  { name: 'knowledge-links.json', collection: 'edges' },
  { name: 'knowledge-validation.json', collection: 'records' },
  { name: 'knowledge-source-refs.json', collection: 'references' },
] as const;

/** One admitted Workspace directory whose native system record exists. */
interface CanonicalWorkspaceDirectory {
  /** Workspace id. */
  workspaceId: string;
  /** Absolute Workspace root. */
  workspaceRoot: string;
}

/**
 * Lists Workspace directories that boot and migration may rebuild.
 *
 * @param dataRoot Data root to scan.
 * @returns Canonical Workspace directories in stable order.
 * @throws Error when a directory still has the retired `workspace.json` projection.
 */
function listCanonicalWorkspaces(dataRoot: string): CanonicalWorkspaceDirectory[] {
  const workspacesRoot = resolveDataRootPath(dataRoot, 'workspaces');
  const workspaces: CanonicalWorkspaceDirectory[] = [];

  for (const workspaceId of listDirectories(workspacesRoot)) {
    if (!isScopeAdmitted(dataRoot, 'workspace', workspaceId)) continue;
    const workspaceRoot = join(workspacesRoot, workspaceId);

    if (existsSync(join(workspaceRoot, 'workspace.json'))) {
      throw new Error(`Unsupported Workspace projection: workspaces/${workspaceId}/workspace.json`);
    }
    // Unpublished staging directories have no admitted database; a present database must contain its exact native authority.
    if (!existsSync(workspaceDbPath(dataRoot, workspaceId))) continue;
    assertNativeWorkspaceRecord(dataRoot, workspaceId);
    workspaces.push({ workspaceId, workspaceRoot });
  }

  return workspaces;
}

/** Reads the native Workspace identity without migration, file fallback, pruning or an escaping SQL transaction. */
function assertNativeWorkspaceRecord(dataRoot: string, workspaceId: string): void {
  const path = workspaceDbPath(dataRoot, workspaceId);
  if (!existsSync(path)) throw new Error(`Native Workspace metadata is missing: ${workspaceId}`);
  const reader = openControlStoreProductReadHandle(path, {
    kind: 'workspace',
    workspaceId,
  });
  try {
    if (!reader.get('workspace', workspaceId))
      throw new Error(`Native Workspace metadata is missing: ${workspaceId}`);
  } finally {
    reader.close();
  }
}

/**
 * Reports whether a Workspace index set must be rebuilt before it can be kept.
 *
 * @param workspaceRoot Absolute Workspace root.
 * @param workspaceId Workspace id that must match each index file.
 * @returns True when the set is missing, unreadable, or structurally incompatible.
 */
function derivedIndexSetNeedsRebuild(workspaceRoot: string, workspaceId: string): boolean {
  const indexesRoot = join(workspaceRoot, 'indexes');
  const metadata = lstatSync(indexesRoot, { throwIfNoEntry: false });

  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    return true;
  }

  assertCanonicalDirectory(indexesRoot);
  const allEntries = readdirSync(indexesRoot, { withFileTypes: true });
  if (
    allEntries.some(
      (entry) => entry.name === 'retrieval' && (!entry.isDirectory() || entry.isSymbolicLink())
    )
  )
    return true;
  const entries = allEntries.filter((entry) => entry.name !== 'retrieval');

  if (entries.some((entry) => !entry.isFile())) {
    return true;
  }

  const names = entries.map((entry) => entry.name).sort();
  const expectedNames = DERIVED_INDEX_FILES.map((file) => file.name).sort();

  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    return true;
  }

  for (const file of DERIVED_INDEX_FILES) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(readCanonicalTextFile(join(indexesRoot, file.name)));
    } catch {
      return true;
    }

    if (!isJsonObject(parsed)) {
      return true;
    }
    if (
      parsed.schemaVersion !== 1 ||
      parsed.workspaceId !== workspaceId ||
      typeof parsed.notebookRevision !== 'string'
    ) {
      return true;
    }
    if (!Array.isArray(parsed[file.collection])) {
      return true;
    }
  }

  return false;
}

/**
 * Reports whether a parsed JSON value is a non-array object.
 *
 * @param value Parsed JSON value.
 * @returns True when the value is a JSON object.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds derived indexes at boot only when a Workspace set is missing or invalid.
 *
 * Keeps the three regular non-lexical JSON projections with matching schema and Workspace ids.
 * The separately owned `retrieval/` directory is preserved. Other children cause a rebuild.
 * This structural check does not compare metadata rows with canonical content.
 *
 * @param dataRoot Data root to scan.
 * @param options Optional rebuild options.
 * @returns Rebuild results for workspaces whose index sets were rebuilt.
 * @throws Error when a rebuild hits an unsupported projection, a symbolic link, or another rebuild failure.
 */
export function rebuildInvalidExistingWorkspaceDerivedIndexes(
  dataRoot: string,
  options: RebuildExistingWorkspaceDerivedIndexesOptions = {}
): RebuildWorkspaceDerivedIndexesResult[] {
  const results: RebuildWorkspaceDerivedIndexesResult[] = [];

  for (const workspace of listCanonicalWorkspaces(dataRoot)) {
    try {
      if (!derivedIndexSetNeedsRebuild(workspace.workspaceRoot, workspace.workspaceId)) continue;
      results.push(
        rebuildWorkspaceDerivedIndexes({
          dataRoot,
          workspaceId: workspace.workspaceId,
          ...(options.now ? { now: options.now } : {}),
        })
      );
    } catch {
      refuseScope(dataRoot, { scope: 'workspace', id: workspace.workspaceId, check: 'index' });
    }
  }

  return results;
}

/**
 * Rebuilds and reads the derived Knowledge Store indexes for one workspace.
 *
 * @param input Rebuild target.
 * @returns Fresh derived Knowledge Store indexes.
 */
export function readWorkspaceKnowledgeDerivedIndexes(
  input: ReadWorkspaceKnowledgeDerivedIndexesInput
): WorkspaceKnowledgeDerivedIndexes {
  rebuildWorkspaceDerivedIndexes(input);

  const indexesRoot = resolveDataRootPath(
    input.dataRoot,
    'workspaces',
    input.workspaceId,
    'indexes'
  );

  return {
    linkGraph: readJsonRecord(
      join(indexesRoot, 'knowledge-links.json')
    ) as WorkspaceKnowledgeLinkGraph,
    validation: readJsonRecord(
      join(indexesRoot, 'knowledge-validation.json')
    ) as WorkspaceKnowledgeValidationIndex,
    sourceReferences: readJsonRecord(
      join(indexesRoot, 'knowledge-source-refs.json')
    ) as WorkspaceKnowledgeSourceReferenceIndex,
  };
}

/**
 * Retrieves ranked Knowledge candidates and publishes a trace when querying Thread context exists.
 *
 * @param input Retrieval target and query.
 * @returns Fresh selection of current verified bytes and an optional qualified trace reference.
 * @throws Error when the canonical workspace projection is missing.
 */
export async function retrieveWorkspaceKnowledge(
  input: RetrieveWorkspaceKnowledgeInput
): Promise<KnowledgeRetrievalResponse> {
  return retrieveNotebookSelection(input, false);
}

/** Selects current self Memory through the existing Kernel and trace owner, with a separate User corpus and limit. */
export async function retrieveUserMemory(
  input: RetrieveUserMemoryInput
): Promise<KnowledgeRetrievalResponse> {
  return retrieveNotebookSelection(input, true);
}

/** Shared governed selection for the admitted notebook sources; it supplies facts, never an answer. */
async function retrieveNotebookSelection(
  input: RetrieveWorkspaceKnowledgeInput,
  memory: boolean
): Promise<KnowledgeRetrievalResponse> {
  const server = !memory && input.sourceScope === 'server';
  const admit = () =>
    memory
      ? admitUserMemoryRetrieval(input)
      : server
        ? admitServerKnowledgeRetrieval(input)
        : admitKnowledgeRetrieval(input);
  if (memory) admit();
  const queryContext = resolveKnowledgeQueryContext(input);
  if (!memory) admit();
  const normalized = RetrieveKnowledgeRequestSchema.parse({
    query: input.query,
    limit: input.limit,
    pinnedReferences: input.pinnedReferences,
    types: input.types,
    appliesTo: input.appliesTo,
    sourceScope: input.sourceScope,
    states: input.states,
  });
  const states = [...new Set(normalized.states)].sort(compareBytewise);
  const filters = {
    ...(normalized.types === undefined
      ? {}
      : { types: [...new Set(normalized.types)].sort(compareBytewise) }),
    ...(normalized.appliesTo === undefined
      ? {}
      : { appliesTo: [...new Set(normalized.appliesTo)].sort(compareBytewise) }),
  };
  if (input.caller !== 'app-api' && states.some((state) => state !== 'active'))
    throw new OperationError(
      'invalid_request',
      'Automatic Knowledge retrieval requires active state.',
      400
    );
  const sourceScope = currentKnowledgePageScope(
    input,
    memory ? 'user' : server ? 'server' : 'workspace'
  );
  if (
    memory &&
    (normalized.sourceScope !== undefined || !['app-api', 'assistant'].includes(input.caller))
  )
    throw new OperationError('invalid_request', 'Invalid Memory retrieval caller or source.', 400);
  if (normalized.pinnedReferences.some((reference) => reference.scopeId !== sourceScope))
    throw new OperationError(
      'invalid_request',
      'Knowledge pin is outside the selected source.',
      400
    );
  if (!queryContext.threadId && (input.caller !== 'app-api' || input.access.actor.kind !== 'user'))
    throw new OperationError(
      'invalid_request',
      'This Knowledge caller requires querying Thread context.',
      400
    );
  const normalizedPinnedReferences = [
    ...new Map(
      normalized.pinnedReferences.map((reference) => [reference.objectId, reference])
    ).values(),
  ].sort((a, b) => compareBytewise(a.objectId, b.objectId));
  const pinnedPageIds = new Set(normalizedPinnedReferences.map((reference) => reference.objectId));
  const limit = normalized.limit;
  const createdAt = input.now?.() ?? new Date().toISOString();
  const traceId = input.traceId ?? allocateEntityId('krt');
  const workspaceRoot = resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId);
  const notebookRead =
    memory || server ? undefined : await prepareAuthorizedWorkspaceNotebookRead(input);
  const preparedInput = {
    ...input,
    notebookRevision: notebookRead?.selected.revision ?? input.notebookRevision,
    notebookRead,
  };
  const scopedPages = memory
    ? readAuthorizedUserMemoryPages(input)
    : server
      ? readAuthorizedServerNotebookPages(input)
      : undefined;
  const admittedPages = scopedPages ?? readAuthorizedWorkspaceNotebookPages(preparedInput);
  const notebookRevision = admittedPages.notebookRevision;
  const pinnedInput = { ...preparedInput, notebookRevision };
  const pinnedPages = new Map(admittedPages.pages.map((page) => [page.id, page.content]));
  const conflictNotebook = new KnowledgeNotebook({
    ...(notebookRead ? { selectedRevision: notebookRead.selection.head.notebookCommit } : {}),
    repositoryPath: join(
      memory
        ? userMemoryRoot(input.dataRoot, input.access.actor.id)
        : server
          ? serverKnowledgeRoot(input.dataRoot)
          : join(workspaceRoot, 'knowledge'),
      'notebook.git'
    ),
  });
  const conflictSubjects = unresolvedNotebookSubjects(
    (await conflictNotebook.readRevisionAsync(await conflictNotebook.publishedRevisionAsync()))
      .files,
    sourceScope
  );
  const scopeSchemaText =
    scopedPages?.scopeSchemaText ??
    readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, input.workspaceId).scopeSchemaText;
  const registeredSources =
    scopedPages?.registeredSources ??
    new Map(
      [...(notebookRead?.sources?.values() ?? [])].map(({ source }) => [
        source.id,
        source.contentDigest,
      ])
    );
  const expectedOwnerScope = memory
    ? { kind: 'user' as const, userId: input.access.requestActor!.userId }
    : server
      ? { kind: 'server' as const }
      : undefined;
  const knowledgeIds = readKnowledgePageIds(pinnedPages);
  const service = getRetrievalService(
    input.dataRoot,
    memory
      ? resolveDataRootPath(input.dataRoot, 'users', input.access.requestActor!.userId)
      : server
        ? resolveDataRootPath(input.dataRoot, 'server')
        : workspaceRoot
  );
  await service.search({ mode: 'lexical', query: input.query, scopes: [], limit: 1 });
  const indexes = memory || server ? undefined : readWorkspaceKnowledgeDerivedIndexes(pinnedInput);
  const sourceReferencesByConcept = new Map<string, string[]>();
  const scores = new Map<string, number>();
  const addressedIds = new Set(normalizedPinnedReferences.map((reference) => reference.objectId));

  for (const reference of indexes?.sourceReferences.references ??
    admittedPages.pages.flatMap(({ id, content }) =>
      (
        stringListFrontmatterField(
          parseOkfDocument({ path: `${id}.md`, content }).document!,
          'source_refs'
        ) ?? []
      ).map((reference) => ({ conceptId: id, reference }))
    )) {
    const references = sourceReferencesByConcept.get(reference.conceptId) ?? [];

    references.push(reference.reference);
    sourceReferencesByConcept.set(reference.conceptId, references);
  }

  const collect = async () => {
    if (!memory && !server)
      pinnedInput.notebookRead = await prepareAuthorizedWorkspaceNotebookRead(pinnedInput);
    return memory
      ? collectUserMemoryInventory(pinnedInput)
      : server
        ? collectServerKnowledgeInventory(pinnedInput)
        : collectKnowledgeInventory(pinnedInput);
  };
  const before = await collect();
  await service.publish(before.view, await service.inspect(before.view.scope));
  const matches = await service.search({
    mode: 'lexical',
    query: input.query,
    scopes: [before.view],
    limit: 1000,
  });
  if (!matches.complete || !matches.coverage.enumeration_complete)
    throw new OperationError(
      'knowledge_retrieval_failed',
      'Knowledge retrieval is incomplete.',
      503
    );
  const after = await collect();
  if (canonicalJson(before.view) !== canonicalJson(after.view))
    throw new OperationError(
      'knowledge_retrieval_failed',
      'Knowledge eligibility changed during retrieval.',
      409
    );
  const referenceProofs = after.referenceProofs;
  for (const hit of matches.hits) {
    const admitted = before.view.documents.find((document) => document.key.id === hit.key.id);
    if (
      !admitted ||
      hit.key.namespace !== (memory ? 'memory' : 'knowledge') ||
      hit.revision !== admitted.revision ||
      hit.digest !== admitted.digest ||
      canonicalJson(hit.provenance) !== canonicalJson(admitted.metadata)
    )
      throw new OperationError(
        'recovery_required',
        'Knowledge projection disagrees with canonical records.',
        409
      );
    addressedIds.add(hit.key.id);
    scores.set(hit.key.id, Math.max(scores.get(hit.key.id) ?? 0, hit.score ?? 0));
  }

  const validationRecords =
    indexes?.validation.records ??
    admittedPages.pages.map(({ id, content, contentDigest }) => {
      const path = `${memory ? 'memory' : 'knowledge'}/pages/${id}.md`;
      const document = parseOkfDocument({ path, content }).document!;
      const report = validateKnowledgePageCandidate({
        pageScopeId: sourceScope,
        path,
        content,
        resolvedReferences: verifiedKnowledgePageSourceReferences(
          stringListFrontmatterField(document, 'source_refs') ?? [],
          pinnedPages,
          sourceScope
        ),
        scopeSchemaText: scopeSchemaText!,
        expectedOwnerScope: expectedOwnerScope!,
        registeredSources,
        knowledgeIds,
      });
      const active = stringFrontmatterField(document, 'openkit_status') === 'active';
      return {
        conceptId: id,
        path,
        contentDigest,
        title: stringFrontmatterField(document, 'title') ?? undefined,
        conformance: report.conformance,
        errors: report.errors,
        active,
        indexed:
          active &&
          stringFrontmatterField(document, 'review_state') === 'user-authored' &&
          report.conformance === 'scope-schema-valid' &&
          !report.errors.length,
      };
    });
  const validationByConcept = new Map(
    validationRecords.map((record) => [record.conceptId, record] as const)
  );
  const candidates = [...addressedIds]
    .map((knowledgePageId) => ({
      knowledgePageId,
      pinned: pinnedPageIds.has(knowledgePageId),
      score: scores.get(knowledgePageId) ?? 0,
    }))
    .sort(compareKnowledgeRetrievalCandidates);
  const selected: WorkspaceKnowledgeRetrievalCandidate[] = [];
  const excluded: WorkspaceKnowledgeRetrievalExclusion[] = [];

  const pageReadable = (id: string, content: string) =>
    memory ||
    (server
      ? readAuthorizedServerNotebookPages({ ...pinnedInput, pageIds: [id] }).pages[0]?.content ===
        content
      : knowledgePageReadable(pinnedInput, id, content));
  for (const candidate of candidates) {
    const record = validationByConcept.get(candidate.knowledgePageId);

    if (!record) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: null,
        reason: 'source_unavailable',
      });
      continue;
    }

    const expectedPath = `${memory ? 'memory' : 'knowledge'}/pages/${candidate.knowledgePageId}.md`;

    if (record.path !== expectedPath) {
      throw new OperationError(
        'recovery_required',
        'Knowledge projection requires a rebuild.',
        409
      );
    }

    const content = pinnedPages.get(candidate.knowledgePageId) ?? null;
    if (content === null) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: null,
        reason: 'source_unavailable',
      });
      continue;
    }

    const contentDigest = sha256Digest(content);
    const parsed = parseOkfDocument({ path: expectedPath, content });
    const document = parsed.document;
    const indexValidation = validateKnowledgePageCandidate({
      pageScopeId: sourceScope,
      path: expectedPath,
      content,
      resolvedReferences: verifiedKnowledgePageSourceReferences(
        document ? (stringListFrontmatterField(document, 'source_refs') ?? []) : [],
        pinnedPages,
        sourceScope
      ),
      ...(scopeSchemaText ? { scopeSchemaText } : {}),
      registeredSources,
      knowledgeIds,
      ...(expectedOwnerScope ? { expectedOwnerScope } : {}),
    });
    const sourceReferences = document
      ? [...new Set(stringListFrontmatterField(document, 'source_refs') ?? [])].sort(
          compareBytewise
        )
      : [];
    const referenceProof = matchingKnowledgeReferenceProof(
      referenceProofs,
      candidate.knowledgePageId,
      contentDigest,
      sourceReferences
    );
    const validation = validateKnowledgePageCandidate({
      pageScopeId: sourceScope,
      path: expectedPath,
      content,
      ...(scopeSchemaText ? { scopeSchemaText } : {}),
      registeredSources,
      knowledgeIds,
      ...(expectedOwnerScope ? { expectedOwnerScope } : {}),
      resolvedReferences: new Set([
        ...verifiedKnowledgePageSourceReferences(sourceReferences, pinnedPages, sourceScope),
        ...(referenceProof?.resolvedReferences ?? []),
      ]),
    });
    const projectedSourceReferences = [
      ...new Set(sourceReferencesByConcept.get(candidate.knowledgePageId) ?? []),
    ].sort(compareBytewise);
    const active = document?.frontmatter.openkit_status === 'active';
    const staticallyIndexed =
      active &&
      stringFrontmatterField(document, 'review_state') === 'user-authored' &&
      indexValidation.conformance === 'scope-schema-valid' &&
      indexValidation.errors.length === 0;
    const title = document ? stringFrontmatterField(document, 'title') : null;

    if (
      record.contentDigest !== contentDigest ||
      record.conformance !== indexValidation.conformance ||
      record.active !== active ||
      record.indexed !== staticallyIndexed ||
      (record.title ?? null) !== title ||
      canonicalJson(record.errors) !== canonicalJson(indexValidation.errors) ||
      (document &&
        (document.conceptId !== candidate.knowledgePageId ||
          !sameStrings(sourceReferences, projectedSourceReferences))) ||
      (!document && projectedSourceReferences.length > 0)
    ) {
      throw new OperationError(
        'recovery_required',
        'Knowledge projection requires a rebuild.',
        409
      );
    }

    const sensitivity = document ? stringFrontmatterField(document, 'sensitivity') : null;

    if (sensitivity === 'restricted' || (!memory && sensitivity === 'confidential')) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: null,
        reason: 'sensitive_content',
      });
      continue;
    }

    if (!parsed.ok || !document || validation.conformance !== 'scope-schema-valid') {
      const readable = pageReadable(candidate.knowledgePageId, content);
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: readable ? contentDigest : null,
        reason: 'lower_conformance',
        ...(readable
          ? {
              eligibilityReason:
                !parsed.ok || !document
                  ? ('parse_invalid' as const)
                  : ('scope_conformance_failed' as const),
            }
          : {}),
      });
      continue;
    }

    if (!pageReadable(candidate.knowledgePageId, content)) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: null,
        reason: 'policy_excluded',
      });
      continue;
    }
    const reviewState = stringFrontmatterField(document, 'review_state');

    // Apply conflict exclusion to active facts while preserving explicit non-active inspection.
    const eligibilityReason =
      (validation.errors.length > 0 && 'validation_errors') ||
      (stringFrontmatterField(document, 'openkit_status') === 'active' &&
        ['Claim', 'Observation'].includes(stringFrontmatterField(document, 'type') ?? '') &&
        stringFrontmatterField(document, 'conflict_status') === 'unresolved' &&
        'active_conflict_unresolved') ||
      (!states.includes(
        stringFrontmatterField(document, 'openkit_status') as (typeof states)[number]
      ) &&
        'state_not_selected') ||
      (stringFrontmatterField(document, 'openkit_status') === 'active' &&
        conflictSubjects.has(
          formatReferenceUri({ scopeId: sourceScope, objectId: candidate.knowledgePageId })
        ) &&
        'active_conflict_unresolved') ||
      (reviewState !== 'accepted' &&
        reviewState !== 'user-authored' &&
        !(
          reviewState === 'delegated' &&
          knowledgePageDelegated(
            pinnedInput,
            candidate.knowledgePageId,
            content,
            memory ? 'user' : server ? 'server' : 'workspace'
          )
        ) &&
        'review_state_ineligible') ||
      ((reviewState === 'accepted' || reviewState === 'delegated') &&
        !referenceProof &&
        'reference_proof_missing_or_mismatch');
    if (eligibilityReason) {
      const readable = pageReadable(candidate.knowledgePageId, content);
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: readable ? contentDigest : null,
        reason: 'lower_conformance',
        ...(readable ? { eligibilityReason } : {}),
      });
      continue;
    }

    const freshness = stringFrontmatterField(document, 'freshness');

    if (freshness === 'stale' || freshness === 'expired') {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest,
        reason: 'freshness_expired',
      });
      continue;
    }

    // Metadata narrows already governed candidates, including pins, before the result budget.
    const type = stringFrontmatterField(document, 'type');
    const appliesTo = stringListFrontmatterField(document, 'applies_to') ?? [];
    if (
      (filters.types && !filters.types.includes(type ?? '')) ||
      (filters.appliesTo &&
        (!['Rule', 'Effect', 'Objective'].includes(type ?? '') ||
          !filters.appliesTo.some((identifier) => appliesTo.includes(identifier))))
    ) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest,
        reason: 'selector_mismatch',
      });
      continue;
    }

    if (selected.length >= limit) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest,
        reason: 'budget_exceeded',
      });
      continue;
    }

    selected.push({
      knowledgePageId: candidate.knowledgePageId,
      contentDigest,
      score: candidate.score,
      sourceReferences,
    });
  }

  const request = {
    query: input.query,
    ...filters,
    limit,
    pinnedReferences: normalizedPinnedReferences,
    states,
    sourceScope: memory ? 'user' : (normalized.sourceScope ?? 'workspace'),
  };
  const referenceFor = (knowledgePageId: string): PageReference => ({
    scopeId: sourceScope,
    objectId: knowledgePageId,
  });
  const metadata = {
    queryContext,
    sourceScope,
    notebookRevision,
    caller: input.caller,
    requestDigest: sha256Digest(
      canonicalJson({ queryContext, sourceScope, caller: input.caller, request })
    ),
    retrievalParameters: {
      ...filters,
      limit,
      pinnedReferences: normalizedPinnedReferences,
      states,
      sourceScope: memory ? 'user' : (normalized.sourceScope ?? 'workspace'),
    },
    createdAt,
  };
  const result = KnowledgeRetrievalResponseSchema.parse({
    ...metadata,
    workspaceId: input.workspaceId,
    selected: selected.map(({ knowledgePageId, ...facts }) => ({
      ...facts,
      reference: referenceFor(knowledgePageId),
      revision: notebookRevision,
    })),
    excluded: excluded.map(({ knowledgePageId, ...facts }) => ({
      ...facts,
      reference: referenceFor(knowledgePageId),
      revision: notebookRevision,
      sourceReferences:
        facts.contentDigest === null
          ? []
          : [...new Set(sourceReferencesByConcept.get(knowledgePageId) ?? [])].sort(
              compareBytewise
            ),
    })),
  });

  await input.beforeDisclosure?.(result);
  admit();
  if (canonicalJson(before.view) !== canonicalJson((await collect()).view))
    throw new OperationError(
      'knowledge_retrieval_failed',
      'Knowledge eligibility changed during retrieval.',
      409
    );
  if (canonicalJson(queryContext) !== canonicalJson(resolveKnowledgeQueryContext(input)))
    throw new OperationError('knowledge_retrieval_failed', 'Knowledge query context changed.', 409);
  if (queryContext.threadId) {
    const reference: RetrievalTraceReference = {
      scopeId: queryContext.turnId
        ? `retrieval-trace/turn/${input.workspaceId}/${queryContext.threadId}/${queryContext.turnId}`
        : `retrieval-trace/thread/${input.workspaceId}/${queryContext.threadId}`,
      objectId: traceId,
    };
    const trace = KnowledgeRetrievalTraceSchema.parse({
      ...metadata,
      traceId,
      selected: result.selected.map(({ score: _score, ...evidence }) => evidence),
      excluded: result.excluded,
    });
    publishRetrievalTrace(workspaceRoot, reference, trace);
    result.retrievalTraceRef = reference;
  }
  return result;
}

/** Resolves only the retained default collection after its caller admits the current owner. */
function currentKnowledgePageScope(
  input: { dataRoot: string; workspaceId: string; access?: KnowledgeRetrievalAccess },
  kind: 'workspace' | 'server' | 'user'
): string {
  if (kind === 'user') {
    const userId = input.access?.requestActor?.userId;
    if (!userId) throw knowledgeTraceUnavailable();
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: input.dataRoot,
      scope: { kind, userId },
    });
    return `page/user/${userId}/${knowledgeBaseId}`;
  }
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: input.dataRoot,
    scope: kind === 'server' ? { kind } : { kind, workspaceId: input.workspaceId },
  });
  return kind === 'server'
    ? `page/server/${knowledgeBaseId}`
    : `page/workspace/${input.workspaceId}/${knowledgeBaseId}`;
}

interface KnowledgeTraceReadInput {
  notebookRead?: WorkspaceNotebookRead | undefined;
  dataRoot: string;
  workspaceId: string;
  access: KnowledgeRetrievalAccess;
  retrievalTraceRef: RetrievalTraceReference;
}

/** One canonical reader binds file identity, containing audience and current Server before projection. */
function readAdmittedKnowledgeTrace(input: KnowledgeTraceReadInput): KnowledgeRetrievalTrace {
  const scope = parseReferenceScope(input.retrievalTraceRef.scopeId);
  if (!scope || scope.family !== 'retrieval-trace' || scope.workspaceId !== input.workspaceId)
    throw knowledgeTraceUnavailable();
  const target = {
    ...input,
    access: {
      ...input.access,
      outputThreadId: scope.threadId,
      outputTurnId: scope.kind === 'turn' ? scope.turnId : undefined,
    },
  };
  const context = resolveKnowledgeQueryContext(target);
  admitKnowledgeRetrieval(target);
  const trace = readRetrievalTrace(
    resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId),
    input.retrievalTraceRef
  );
  if (!trace)
    throw new OperationError('knowledge_retrieval_failed', 'Knowledge trace is unavailable.', 503);
  if (trace.queryContext.serverId !== context.serverId) throw knowledgeTraceUnavailable();
  if (
    trace.retrievalParameters.sourceScope === 'user' &&
    (trace.queryContext.actor.kind !== 'user' ||
      trace.queryContext.actor.id !== input.access.requestActor?.userId)
  )
    throw knowledgeTraceUnavailable();
  if (trace.retrievalParameters.sourceScope === 'user') {
    // Record inspection uses the addressed owner after current audience and self admission.
    admitUserMemoryRetrieval(target);
  } else if (trace.retrievalParameters.sourceScope === 'server') {
    admitServerKnowledgeRetrieval(target);
  }
  if (
    trace.sourceScope !== currentKnowledgePageScope(target, trace.retrievalParameters.sourceScope)
  )
    throw knowledgeTraceUnavailable();
  return trace;
}

/** Loads the complete inventory already owned by a currently admitted Workspace trace read. */
export async function prepareKnowledgeRetrievalTraceRead(input: KnowledgeTraceReadInput) {
  const trace = readAdmittedKnowledgeTrace(input);
  if (parseReferenceScope(trace.sourceScope)?.kind !== 'workspace') return undefined;
  if (trace.notebookRevision === null) throw knowledgeTraceUnavailable();
  const prepared = await prepareAuthorizedWorkspaceNotebookRead({
    ...input,
    notebookRevision: trace.notebookRevision,
  });
  // Trace validation owns reserved Page blobs as well as the ordinary query inventory.
  const notebook = prepared.notebook;
  const paths = Object.keys(prepared.selected.entries).filter(
    (path) => !Object.hasOwn(prepared.selected.files, path)
  );
  const extra = await notebook.readRevisionAsync(trace.notebookRevision, paths);
  const selected = { ...prepared.selected, files: { ...prepared.selected.files, ...extra.files } };
  const current = prepared.current.revision === selected.revision ? selected : prepared.current;
  return { ...prepared, current, selected };
}

/** A failed reference check never discloses the failed source identity. */
function knowledgeTraceUnavailable(): OperationError {
  return new OperationError(
    'workspace_access_denied',
    'Knowledge trace or source is unavailable.',
    403
  );
}

/** Resolves one current reference for either metadata admission or selected-byte materialization. */
function currentKnowledgeReferenceContent(
  input: {
    dataRoot: string;
    workspaceId: string;
    access: KnowledgeRetrievalAccess;
    notebookRevision?: string | undefined;
    notebookRead?: WorkspaceNotebookRead | undefined;
  },
  reference: PageReference,
  serverId: string
): string | null {
  const scope = parseReferenceScope(reference.scopeId);
  if (!scope || scope.family !== 'page') throw knowledgeTraceUnavailable();
  if (scope.kind === 'user') {
    // Current self Memory is independent of Workspace import lineage; the trace reader still binds its Server.
    if (reference.scopeId !== currentKnowledgePageScope(input, 'user'))
      throw knowledgeTraceUnavailable();
    try {
      return (
        readAuthorizedUserMemoryPages({ ...input, pageIds: [reference.objectId] }).pages[0]
          ?.content ?? null
      );
    } catch (error) {
      if (error instanceof OperationError && error.status === 403)
        throw knowledgeTraceUnavailable();
      throw error;
    }
  }
  // The selected trace's originating Server controls authority, not the Workspace's import history.
  if (scope.kind === 'server' && serverId !== resolveKnowledgeQueryContext(input).serverId)
    throw knowledgeTraceUnavailable();
  if (scope.kind === 'server') {
    if (reference.scopeId !== currentKnowledgePageScope(input, 'server'))
      throw knowledgeTraceUnavailable();
    try {
      return (
        readAuthorizedServerNotebookPages({ ...input, pageIds: [reference.objectId] }).pages[0]
          ?.content ?? null
      );
    } catch (error) {
      if (error instanceof OperationError && error.status === 403)
        throw knowledgeTraceUnavailable();
      throw error;
    }
  }
  if (reference.scopeId !== currentKnowledgePageScope(input, 'workspace'))
    throw knowledgeTraceUnavailable();
  admitKnowledgeRetrieval(input);
  const workspaceRoot = resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId);
  const selection = readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, input.workspaceId);
  const prepared = currentWorkspaceNotebookRead(input.notebookRead, workspaceRoot, selection);
  const currentRead =
    prepared && Object.hasOwn(prepared.current.files, `${reference.objectId}.md`)
      ? prepared
      : undefined;
  const current = readWorkspaceNotebookIndexSource(
    workspaceRoot,
    undefined,
    [reference.objectId],
    currentRead,
    selection
  );
  const pinnedRead =
    prepared &&
    prepared.selected.revision === input.notebookRevision &&
    Object.hasOwn(prepared.selected.files, `${reference.objectId}.md`)
      ? prepared
      : undefined;
  const pinned =
    input.notebookRevision !== undefined && input.notebookRevision !== current.notebookRevision
      ? readWorkspaceNotebookIndexSource(
          workspaceRoot,
          input.notebookRevision,
          [reference.objectId],
          pinnedRead,
          selection
        )
      : current;
  if (!pinned.pages.has(reference.objectId)) return null;
  // Retained bytes prove selection; current sensitivity still controls trace disclosure.
  const currentContent = current.pages.get(reference.objectId);
  if (currentContent !== undefined) {
    const currentDocument = parseOkfDocument({
      path: `knowledge/pages/${reference.objectId}.md`,
      content: currentContent,
    });
    const sensitivity = currentDocument.document
      ? stringFrontmatterField(currentDocument.document, 'sensitivity')
      : null;
    if (
      !currentDocument.ok ||
      sensitivity === null ||
      sensitivity === 'restricted' ||
      sensitivity === 'confidential'
    )
      throw knowledgeTraceUnavailable();
  }
  let selected: ReturnType<typeof readAuthorizedWorkspaceNotebookPages>;
  try {
    selected = readAuthorizedWorkspaceNotebookPages({
      ...input,
      pageIds: [reference.objectId],
    });
  } catch (error) {
    if (error instanceof OperationError && error.code === 'workspace_access_denied')
      throw knowledgeTraceUnavailable();
    throw error;
  }
  const content = selected.pages[0]?.content ?? null;
  if (content === null) return null;
  const document = parseOkfDocument({
    path: `knowledge/pages/${reference.objectId}.md`,
    content,
  }).document;
  const sensitivity = document ? stringFrontmatterField(document, 'sensitivity') : null;
  if (
    sensitivity === 'restricted' ||
    sensitivity === 'confidential' ||
    !knowledgePageReadable(input, reference.objectId, content)
  )
    throw knowledgeTraceUnavailable();
  return content;
}

/** Admits the full trace projection, including exclusions and pins, before read or ordinary export. */
export function assertKnowledgeRetrievalTraceReadable(
  input: KnowledgeTraceReadInput
): KnowledgeRetrievalTrace {
  return assertKnowledgeTraceProjectionReadable(input, 'full');
}

/** Verifies the KM selection projection, whose exclusions contain no digest or Source metadata. */
export function assertKnowledgeRetrievalSelectionReadable(input: KnowledgeTraceReadInput): void {
  assertKnowledgeTraceProjectionReadable(input, 'selection');
}

/** Current admission follows the bytes exposed by the chosen projection; full reads stay strict. */
function assertKnowledgeTraceProjectionReadable(
  input: KnowledgeTraceReadInput,
  projection: 'full' | 'selection'
): KnowledgeRetrievalTrace {
  const trace = readAdmittedKnowledgeTrace(input);
  if (trace.notebookRevision === null) throw knowledgeTraceUnavailable();
  const target = {
    notebookRevision: trace.notebookRevision,
    ...input,
    access: {
      ...input.access,
      outputThreadId: trace.queryContext.threadId,
      outputTurnId: trace.queryContext.turnId,
    },
  };
  const entries = projection === 'full' ? [...trace.selected, ...trace.excluded] : trace.selected;
  const references = [
    ...entries.map((entry) => entry.reference),
    ...(projection === 'full' ? trace.retrievalParameters.pinnedReferences : []),
  ];
  for (const reference of references) {
    if (reference.scopeId !== trace.sourceScope) throw knowledgeTraceUnavailable();
    if (currentKnowledgeReferenceContent(target, reference, trace.queryContext.serverId) === null)
      throw new OperationError(
        'knowledge_source_unavailable',
        'Knowledge trace source is unavailable.',
        503
      );
  }
  for (const entry of entries) {
    if (
      trace.retrievalParameters.sourceScope === 'user' ||
      trace.retrievalParameters.sourceScope === 'server'
    ) {
      const content = currentKnowledgeReferenceContent(
        target,
        entry.reference,
        trace.queryContext.serverId
      );
      const document =
        content === null
          ? null
          : parseOkfDocument({ path: `${entry.reference.objectId}.md`, content }).document;
      if (
        content === null ||
        !document ||
        entry.revision !== trace.notebookRevision ||
        (entry.contentDigest !== null && entry.contentDigest !== sha256Digest(content)) ||
        !sameStrings(
          entry.sourceReferences,
          [...new Set(stringListFrontmatterField(document, 'source_refs') ?? [])].sort(
            compareBytewise
          )
        )
      )
        throw knowledgeTraceUnavailable();
      continue;
    }
    if (
      !knowledgeSourceReferencesReadable(target, entry.reference.objectId, entry.sourceReferences)
    )
      throw knowledgeTraceUnavailable();
  }
  return trace;
}

/**
 * Resolves one Task-owned retrieval trace to its exact current Knowledge Page bytes.
 *
 * @param input Data root, workspace, and persisted retrieval-trace identity.
 * @returns Selected pages in persisted order, or null when a selected page file is missing.
 * @throws Error when trace lineage or authoritative page evidence is contradictory.
 */
export function resolveWorkspaceKnowledgeRetrievalPages(input: {
  /** Data root that owns the workspace. */
  dataRoot: string;
  /** Workspace expected to own the retrieval trace and pages. */
  workspaceId: string;
  /** Complete immutable content; current native admission still decides this read. */
  notebookRead?: WorkspaceNotebookRead | undefined;
  /** Persisted governed retrieval trace to resolve. */
  retrievalTraceRef?: RetrievalTraceReference;
  /** Fresh server-owned selection permits threadless reads without fabricating a trace. */
  selection?: KnowledgeRetrievalResponse;
  /** Server-owned caller expected on the retrieval trace. */
  caller: RetrieveWorkspaceKnowledgeInput['caller'];
  /** Fresh source and destination authorization for exact-byte disclosure. */
  access: KnowledgeRetrievalAccess;
}): ResolvedWorkspaceKnowledgeRetrievalPage[] | null {
  const workspaceRoot = resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId);
  admitKnowledgeRetrieval(input);
  const context = resolveKnowledgeQueryContext(input);
  if (Boolean(input.retrievalTraceRef) === Boolean(input.selection))
    throw new Error('Exactly one Knowledge selection or trace reference is required.');
  let trace: KnowledgeRetrievalResponse | KnowledgeRetrievalTrace;
  if (input.retrievalTraceRef) {
    const scope = parseReferenceScope(input.retrievalTraceRef.scopeId);
    if (
      !scope ||
      scope.family !== 'retrieval-trace' ||
      scope.workspaceId !== input.workspaceId ||
      scope.threadId !== context.threadId ||
      (scope.kind === 'turn' && scope.turnId !== context.turnId)
    )
      throw new OperationError('workspace_access_denied', 'Knowledge trace audience denied.', 403);
    trace = readAdmittedKnowledgeTrace({ ...input, retrievalTraceRef: input.retrievalTraceRef });
  } else {
    trace = KnowledgeRetrievalResponseSchema.parse(input.selection);
  }
  if (
    trace.queryContext.workspaceId !== input.workspaceId ||
    trace.queryContext.serverId !== context.serverId ||
    trace.caller !== input.caller ||
    (trace.queryContext.threadId && trace.queryContext.threadId !== context.threadId)
  )
    throw new Error('Knowledge retrieval trace lineage is contradictory.');

  if (trace.notebookRevision === null) throw knowledgeTraceUnavailable();
  const selectedScope = parseReferenceScope(trace.sourceScope);
  if (!selectedScope || selectedScope.family !== 'page') throw knowledgeTraceUnavailable();
  const knowledgeBaseId = selectedScope.knowledgeBaseId;
  const notebookRevision = trace.notebookRevision;
  const pinnedInput = { ...input, notebookRevision };
  if (
    trace.retrievalParameters.sourceScope === 'user' ||
    trace.retrievalParameters.sourceScope === 'server'
  ) {
    const server = trace.retrievalParameters.sourceScope === 'server';
    const admit = () =>
      server ? admitServerKnowledgeRetrieval(input) : admitUserMemoryRetrieval(input);
    admit();
    if (
      trace.sourceScope !== currentKnowledgePageScope(input, server ? 'server' : 'user') ||
      trace.queryContext.threadId !== context.threadId
    )
      throw knowledgeTraceUnavailable();
    const pages: ResolvedWorkspaceKnowledgeRetrievalPage[] = [];
    for (const selected of trace.selected) {
      if (
        selected.reference.scopeId !== trace.sourceScope ||
        selected.revision !== notebookRevision
      )
        throw knowledgeTraceUnavailable();
      const content = currentKnowledgeReferenceContent(
        pinnedInput,
        selected.reference,
        context.serverId
      );
      if (content === null) return null;
      const document = parseOkfDocument({ path: `${selected.reference.objectId}.md`, content })
        .document!;
      const sourceRefs = [
        ...new Set(stringListFrontmatterField(document, 'source_refs') ?? []),
      ].sort(compareBytewise);
      if (
        sha256Digest(content) !== selected.contentDigest ||
        !sameStrings(sourceRefs, selected.sourceReferences) ||
        stringFrontmatterField(document, 'openkit_status') !== 'active' ||
        (!['accepted', 'user-authored'].includes(
          stringFrontmatterField(document, 'review_state') ?? ''
        ) &&
          !(
            stringFrontmatterField(document, 'review_state') === 'delegated' &&
            knowledgePageDelegated(
              pinnedInput,
              selected.reference.objectId,
              content,
              server ? 'server' : 'user'
            )
          )) ||
        ['stale', 'expired'].includes(stringFrontmatterField(document, 'freshness') ?? '')
      )
        throw knowledgeTraceUnavailable();
      pages.push({
        notebookRevision,
        knowledgeBaseId,
        reference: selected.reference,
        knowledgePageId: selected.reference.objectId,
        contentDigest: selected.contentDigest,
        sourceRefs,
        content,
        title: stringFrontmatterField(document, 'title')!,
        body: document.body.trim(),
      });
    }
    admit();
    return pages;
  }
  if (trace.sourceScope !== currentKnowledgePageScope(input, 'workspace'))
    throw knowledgeTraceUnavailable();
  const selection = readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, input.workspaceId);
  const candidate = currentWorkspaceNotebookRead(input.notebookRead, workspaceRoot, selection);
  const prepared =
    candidate?.selected.revision === notebookRevision &&
    Object.keys(candidate.selected.entries).every((path) =>
      Object.hasOwn(candidate.selected.files, path)
    )
      ? candidate
      : undefined;
  pinnedInput.notebookRead = prepared;
  const referenceProofs = currentKnowledgeReferenceProofs(pinnedInput);
  const pinnedPages = readWorkspaceNotebookIndexSource(
    workspaceRoot,
    notebookRevision,
    undefined,
    prepared,
    selection
  ).pages;
  const scopeSchemaText = readAdmittedWorkspaceKnowledgeSelection(
    workspaceRoot,
    input.workspaceId
  ).scopeSchemaText;
  const registeredSources = prepared?.sources
    ? new Map([...prepared.sources.values()].map(({ source }) => [source.id, source.contentDigest]))
    : readRegisteredSources(workspaceRoot, input.workspaceId);
  const knowledgeIds = readKnowledgePageIds(pinnedPages);
  const pages: ResolvedWorkspaceKnowledgeRetrievalPage[] = [];

  for (const selected of trace.selected) {
    if (selected.reference.scopeId !== trace.sourceScope || selected.revision !== notebookRevision)
      throw new Error('Knowledge selection source is contradictory.');
    const path = `knowledge/pages/${selected.reference.objectId}.md`;
    const content = currentKnowledgeReferenceContent(
      pinnedInput,
      selected.reference,
      context.serverId
    );
    if (content === null) {
      return null;
    }

    const parsed = parseOkfDocument({ path, content });
    const document = parsed.document;
    const sourceRefs = document
      ? [...new Set(stringListFrontmatterField(document, 'source_refs') ?? [])].sort(
          compareBytewise
        )
      : [];
    const contentDigest = sha256Digest(content);
    const referenceProof = matchingKnowledgeReferenceProof(
      referenceProofs,
      selected.reference.objectId,
      contentDigest,
      sourceRefs
    );
    const validation = validateKnowledgePageCandidate({
      pageScopeId: trace.sourceScope,
      path,
      content,
      ...(scopeSchemaText ? { scopeSchemaText } : {}),
      registeredSources,
      knowledgeIds,
      resolvedReferences: new Set([
        ...verifiedKnowledgePageSourceReferences(sourceRefs, pinnedPages, trace.sourceScope),
        ...(referenceProof?.resolvedReferences ?? []),
      ]),
    });
    const reviewState = document ? stringFrontmatterField(document, 'review_state') : null;
    const sensitivity = document ? stringFrontmatterField(document, 'sensitivity') : null;
    const freshness = document ? stringFrontmatterField(document, 'freshness') : null;
    const title = document ? stringFrontmatterField(document, 'title') : null;

    if (
      !parsed.ok ||
      !document ||
      validation.conformance !== 'scope-schema-valid' ||
      validation.errors.length > 0 ||
      document.conceptId !== selected.reference.objectId ||
      stringFrontmatterField(document, 'openkit_status') !== 'active' ||
      (reviewState !== 'accepted' &&
        reviewState !== 'user-authored' &&
        !(
          reviewState === 'delegated' &&
          knowledgePageDelegated(pinnedInput, selected.reference.objectId, content)
        )) ||
      ((reviewState === 'accepted' || reviewState === 'delegated') && !referenceProof) ||
      sensitivity === 'restricted' ||
      sensitivity === 'confidential' ||
      freshness === 'stale' ||
      freshness === 'expired' ||
      title === null ||
      contentDigest !== selected.contentDigest ||
      !sameStrings(sourceRefs, selected.sourceReferences)
    ) {
      throw new Error('Knowledge retrieval trace no longer matches authoritative pages.');
    }

    pages.push({
      notebookRevision,
      knowledgeBaseId,
      reference: selected.reference,
      knowledgePageId: selected.reference.objectId,
      contentDigest,
      sourceRefs,
      content,
      title,
      body: document.body.trim(),
    });
  }

  return pages;
}

/**
 * Selects one exact Page-bound proof without allowing references from another Page to leak in.
 *
 * @param proofs Current request-scoped proof map.
 * @param knowledgePageId Exact candidate Page identity.
 * @param contentDigest Exact current canonical Page digest.
 * @param sourceReferences Exact current Page references.
 * @returns Matching proof, or null when any part of the tuple differs.
 */
function matchingKnowledgeReferenceProof(
  proofs: ReadonlyMap<string, KnowledgePageReferenceProof> | undefined,
  knowledgePageId: string,
  contentDigest: string,
  sourceReferences: readonly string[]
): KnowledgePageReferenceProof | null {
  const proof = proofs?.get(knowledgePageId);
  if (
    !proof ||
    proof.knowledgePageId !== knowledgePageId ||
    proof.contentDigest !== contentDigest ||
    !sameStrings(proof.sourceReferences, sourceReferences) ||
    !sameStrings([...proof.resolvedReferences].sort(compareBytewise), sourceReferences)
  ) {
    return null;
  }
  return proof;
}

/**
 * Orders retrieval candidates by score and stable identity fields.
 *
 * @param left Left candidate.
 * @param right Right candidate.
 * @returns Sort comparator result.
 */
function compareKnowledgeRetrievalCandidates(
  left: { readonly knowledgePageId: string; readonly pinned: boolean; readonly score: number },
  right: { readonly knowledgePageId: string; readonly pinned: boolean; readonly score: number }
): number {
  return (
    Number(right.pinned) - Number(left.pinned) ||
    right.score - left.score ||
    compareBytewise(left.knowledgePageId, right.knowledgePageId)
  );
}

/** Serializes JSON with recursively bytewise-sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

/** Recursively sorts object keys while preserving array order. */
function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareBytewise(left, right))
        .map(([key, entry]) => [key, sortCanonicalValue(entry)])
    );
  }
  return value;
}

/** Computes a prefixed lowercase SHA-256 digest over exact UTF-8 text. */
function sha256Digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Compares two strings by their exact UTF-8 byte order. */
function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Returns whether two already-normalized string arrays are identical. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Reads current Source identities and digests from the sole published Notebook pointer tree.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Registered Source ids and nullable digests for the Workspace.
 */
function readRegisteredSources(
  workspaceRoot: string,
  workspaceId: string
): Map<string, string | null> {
  return new Map(
    [
      ...readSourcePointers(
        {
          dataRoot: resolve(workspaceRoot, '../..'),
          ownerScope: { kind: 'workspace', workspaceId },
        },
        undefined,
        readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, workspaceId)
      ).values(),
    ].map(({ source }) => [source.id, source.contentDigest])
  );
}

/**
 * Removes existing derived-index files before rebuild.
 *
 * @param indexesRoot Derived index directory.
 * @returns Removed direct child names.
 */
function clearIndexDirectory(indexesRoot: string): string[] {
  if (!lstatSync(indexesRoot, { throwIfNoEntry: false })) {
    mkdirSync(indexesRoot);
  }
  assertCanonicalDirectory(indexesRoot);

  const entries = readdirSync(indexesRoot, { withFileTypes: true });
  const linkedEntry = entries.find((entry) => entry.isSymbolicLink());

  if (linkedEntry) {
    throw new Error(
      `Canonical directory must not contain a symbolic link: ${join(indexesRoot, linkedEntry.name)}.`
    );
  }

  const removedEntries = entries
    .filter((entry) => entry.name !== 'retrieval')
    .map((entry) => entry.name)
    .sort();

  for (const entry of removedEntries) {
    rmSync(join(indexesRoot, entry), { recursive: true, force: true });
  }

  return removedEntries;
}

/**
 * Reads one required JSON record.
 *
 * @param path JSON file path.
 * @returns Parsed JSON value.
 */
function readJsonRecord(path: string): unknown {
  return JSON.parse(readCanonicalTextFile(path));
}

/**
 * Lists direct child directories in stable order.
 *
 * @param path Parent directory path.
 * @returns Directory names.
 */
function listDirectories(path: string): string[] {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    return [];
  }
  assertCanonicalDirectory(path);

  const entries = readdirSync(path, { withFileTypes: true });
  const linkedEntry = entries.find((entry) => entry.isSymbolicLink());

  if (linkedEntry) {
    throw new Error(
      `Canonical directory must not contain a symbolic link: ${join(path, linkedEntry.name)}.`
    );
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Converts a data-root path to a portable report path.
 *
 * @param dataRoot Data root.
 * @param path Path under the data root.
 * @returns Slash-separated relative path.
 */
function toReportPath(dataRoot: string, path: string): string {
  return relative(dataRoot, path).split(sep).join('/');
}
