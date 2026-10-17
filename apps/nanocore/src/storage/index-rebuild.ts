import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import {
  type KnowledgeRetrievalResponse,
  KnowledgeRetrievalResponseSchema,
  type KnowledgeRetrievalTrace,
  KnowledgeRetrievalTraceSchema,
  RetrieveKnowledgeRequestSchema,
} from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  type PageReference,
  parseReferenceScope,
  type RetrievalTraceReference,
} from '@openkit/protocol';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { readWorkspaceNotebookIndexSource } from '../knowledge/notebook-index-source.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  isActiveOpenKitKnowledgePage,
  type KnowledgeConformance,
  type KnowledgePageReferenceProof,
  type KnowledgeValidationError,
  knowledgeReferenceErrors,
  type OkfDocument,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  resolveRegisteredKnowledgeSourceReference,
  type ScopeKnowledgeSchema,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateKnowledgePageCandidate,
} from '../knowledge/okf.js';
import { OperationError } from '../operation-error.js';
import {
  admitKnowledgeRetrieval,
  admitUserMemoryRetrieval,
  collectKnowledgeInventory,
  collectUserMemoryInventory,
  currentKnowledgeReferenceProofs,
  type KnowledgeRetrievalAccess,
  knowledgePageConflicted,
  knowledgePageReadable,
  knowledgeSourceReferencesReadable,
  readAuthorizedUserMemoryPages,
  readAuthorizedWorkspaceNotebookPages,
  resolveKnowledgeQueryContext,
  type UserMemoryRetrievalAccess,
} from '../retrieval-knowledge-adapter.js';
import { getRetrievalService } from '../retrieval-service.js';
import { resolveDataRootPath } from './fs-layout.js';
import { publishRetrievalTrace, readRetrievalTrace } from './retrieval-traces.js';
import { assertCanonicalDirectory, readCanonicalTextFile } from './workspace-file-records.js';

export type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';

/** Directed Markdown link edge between knowledge concepts. */
export interface WorkspaceKnowledgeLinkEdge {
  /** Source concept id. */
  fromId: string;
  /** Raw Markdown link target. */
  target: string;
  /** Normalized target concept id. */
  toId: string;
  /** Whether the target concept exists in the same workspace bundle. */
  resolved: boolean;
}

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

/** Validation report for one file-backed knowledge page. */
export interface WorkspaceKnowledgeValidationRecord {
  /** Bundle-relative concept id. */
  conceptId: string;
  /** Knowledge page path relative to the workspace root. */
  path: string;
  /** SHA-256 digest of the exact authoritative page bytes. */
  contentDigest: string;
  /** Human-readable title when parseable. */
  title?: string;
  /** Highest conformance level reached by the page. */
  conformance: KnowledgeConformance;
  /** Whether the page declares itself active. */
  active: boolean;
  /** Whether the page entered active derived search indexes. */
  indexed: boolean;
  /** Validation and local-reference errors. */
  errors: KnowledgeValidationError[];
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

/** Source-reference classification in the derived Knowledge Store index. */
export type WorkspaceKnowledgeSourceReferenceKind =
  | 'registered-source'
  | 'workspace-knowledge'
  | 'external-reference';

/** Source reference declared by one file-backed knowledge page. */
export interface WorkspaceKnowledgeSourceReference {
  /** Bundle-relative concept id declaring the reference. */
  conceptId: string;
  /** Knowledge page path relative to the workspace root. */
  path: string;
  /** Raw source reference from the page frontmatter. */
  reference: string;
  /** Derived local or external reference class. */
  kind: WorkspaceKnowledgeSourceReferenceKind;
  /** Local target id when the reference uses a known local prefix. */
  targetId: string | null;
  /** Whether the local target resolves inside this workspace. */
  resolved: boolean;
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
  caller: 'assistant' | 'task-mode' | 'app-api' | 'internal-agent' | 'worker';
  /** User query used to rank active Knowledge Store pages. */
  query: string;
  /** Maximum number of selected candidates. */
  limit?: number | undefined;
  /** Concepts that should be included when present and active. */
  pinnedReferences?: readonly PageReference[] | undefined;
  /** Narrowing-only base selection; the current Workspace is the default. */
  sourceScope?: 'workspace' | 'server' | undefined;
  /** Optional trace id for deterministic tests and route ownership. */
  traceId?: string | undefined;
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
    | 'freshness_expired'
    | 'budget_exceeded'
    | 'source_unavailable';
}

/** Exact authoritative Knowledge Page selected for one Task worker Context Package. */
export interface ResolvedWorkspaceKnowledgeRetrievalPage {
  /** Exact selected Notebook commit, independent of page digest. */
  notebookRevision: string;
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
  kind: 'preference' | 'project-context' | 'task-summary';
}

/** Options for boot-time derived index rebuild scans. */
export interface RebuildExistingWorkspaceDerivedIndexesOptions {
  /** Optional timestamp source for deterministic tests. */
  now?: () => string;
}

/**
 * Rebuilds derived workspace indexes from file-backed source records.
 *
 * @param input Rebuild target and optional clock.
 * @returns Rebuild result with relative index path and counts.
 * @throws Error when the canonical workspace projection is missing.
 */
export function rebuildWorkspaceDerivedIndexes(
  input: RebuildWorkspaceDerivedIndexesInput
): RebuildWorkspaceDerivedIndexesResult {
  const workspaceRoot = resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId);
  const retiredWorkspacePath = join(workspaceRoot, 'workspace.json');
  const workspacePath = join(workspaceRoot, 'workspace-record.json');

  if (existsSync(retiredWorkspacePath)) {
    throw new Error(
      `Unsupported Workspace projection: ${toReportPath(input.dataRoot, retiredWorkspacePath)}`
    );
  }
  if (!existsSync(workspacePath)) {
    throw new Error(
      `Workspace projection is missing: ${toReportPath(input.dataRoot, workspacePath)}`
    );
  }

  const indexesRoot = join(workspaceRoot, 'indexes');
  const indexPath = join(indexesRoot, 'knowledge-validation.json');
  const rebuiltAt = input.now?.() ?? new Date().toISOString();
  const source = readWorkspaceNotebookIndexSource(workspaceRoot, input.notebookRevision);
  const linkGraph: WorkspaceKnowledgeLinkGraph = {
    notebookRevision: source.notebookRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    edges: buildKnowledgeLinkEdges(workspaceRoot, input.workspaceId, source.pages),
  };
  const validationIndex: WorkspaceKnowledgeValidationIndex = {
    notebookRevision: source.notebookRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    records: buildKnowledgeValidationRecords(workspaceRoot, input.workspaceId, source.pages),
  };
  const sourceReferenceIndex: WorkspaceKnowledgeSourceReferenceIndex = {
    notebookRevision: source.notebookRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    references: buildKnowledgeSourceReferences(workspaceRoot, input.workspaceId, source.pages),
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

/** One Workspace directory that has a canonical projection and no retired projection. */
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
    const workspaceRoot = join(workspacesRoot, workspaceId);

    if (existsSync(join(workspaceRoot, 'workspace.json'))) {
      throw new Error(`Unsupported Workspace projection: workspaces/${workspaceId}/workspace.json`);
    }
    if (!existsSync(join(workspaceRoot, 'workspace-record.json'))) {
      continue;
    }

    workspaces.push({ workspaceId, workspaceRoot });
  }

  return workspaces;
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
    if (!derivedIndexSetNeedsRebuild(workspace.workspaceRoot, workspace.workspaceId)) {
      continue;
    }

    results.push(
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        workspaceId: workspace.workspaceId,
        ...(options.now ? { now: options.now } : {}),
      })
    );
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

/** Shared governed selection for the two currently admitted notebook sources; it supplies facts, never an answer. */
async function retrieveNotebookSelection(
  input: RetrieveWorkspaceKnowledgeInput,
  memory: boolean
): Promise<KnowledgeRetrievalResponse> {
  const admit = () => (memory ? admitUserMemoryRetrieval(input) : admitKnowledgeRetrieval(input));
  if (memory) admit();
  const queryContext = resolveKnowledgeQueryContext(input);
  if (!memory) admit();
  const normalized = RetrieveKnowledgeRequestSchema.parse({
    query: input.query,
    limit: input.limit,
    pinnedReferences: input.pinnedReferences,
    sourceScope: input.sourceScope,
    states: input.states,
  });
  const states = [...new Set(normalized.states)].sort(compareBytewise);
  if (input.caller !== 'app-api' && states.some((state) => state !== 'active'))
    throw new OperationError(
      'invalid_request',
      'Automatic Knowledge retrieval requires active state.',
      400
    );
  const sourceScope = memory
    ? `page/user/${input.access.requestActor!.userId}`
    : normalized.sourceScope === 'server'
      ? 'page/server'
      : `page/workspace/${input.workspaceId}`;
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
  if (normalized.sourceScope === 'server') {
    if (
      !input.access.coreDb ||
      !input.access.requestActor ||
      !isCurrentDeploymentAdministrator(input.access.coreDb, input.access.requestActor)
    )
      throw new OperationError('workspace_access_denied', 'Server Knowledge access denied.', 403);
    throw new OperationError('knowledge_retrieval_failed', 'Server Knowledge is unavailable.', 503);
  }
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
  const memoryPages = memory ? readAuthorizedUserMemoryPages(input) : undefined;
  const admittedPages = memoryPages ?? readAuthorizedWorkspaceNotebookPages(input);
  const notebookRevision = admittedPages.notebookRevision;
  const pinnedInput = { ...input, notebookRevision };
  const pinnedPages = new Map(admittedPages.pages.map((page) => [page.id, page.content]));
  const scopeSchemaText =
    memoryPages?.scopeSchemaText ?? readScopeKnowledgeSchemaText(workspaceRoot);
  const registeredSources =
    memoryPages?.registeredSources ?? readRegisteredSources(workspaceRoot, input.workspaceId);
  const expectedOwnerScope = memory
    ? { kind: 'user' as const, userId: input.access.requestActor!.userId }
    : undefined;
  const knowledgeIds = readKnowledgePageIds(pinnedPages);
  const service = getRetrievalService(
    input.dataRoot,
    memory
      ? resolveDataRootPath(input.dataRoot, 'users', input.access.requestActor!.userId)
      : workspaceRoot
  );
  await service.search({ mode: 'lexical', query: input.query, scopes: [], limit: 1 });
  const indexes = memory ? undefined : readWorkspaceKnowledgeDerivedIndexes(pinnedInput);
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

  const collect = () =>
    memory ? collectUserMemoryInventory(pinnedInput) : collectKnowledgeInventory(pinnedInput);
  const before = collect();
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
  const after = collect();
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
      const path = `memory/pages/${id}.md`;
      const document = parseOkfDocument({ path, content }).document!;
      const report = validateKnowledgePageCandidate({
        path,
        content,
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
      path: expectedPath,
      content,
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
      path: expectedPath,
      content,
      ...(scopeSchemaText ? { scopeSchemaText } : {}),
      registeredSources,
      knowledgeIds,
      ...(expectedOwnerScope ? { expectedOwnerScope } : {}),
      ...(referenceProof ? { resolvedReferences: referenceProof.resolvedReferences } : {}),
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
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest:
          memory || knowledgePageReadable(pinnedInput, candidate.knowledgePageId, content)
            ? contentDigest
            : null,
        reason: 'lower_conformance',
      });
      continue;
    }

    if (!memory && !knowledgePageReadable(pinnedInput, candidate.knowledgePageId, content)) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest: null,
        reason: 'policy_excluded',
      });
      continue;
    }
    const reviewState = stringFrontmatterField(document, 'review_state');

    if (
      validation.errors.length > 0 ||
      !states.includes(
        stringFrontmatterField(document, 'openkit_status') as (typeof states)[number]
      ) ||
      (!memory && knowledgePageConflicted(workspaceRoot, candidate.knowledgePageId)) ||
      (reviewState !== 'accepted' && reviewState !== 'user-authored') ||
      (reviewState === 'accepted' && !referenceProof)
    ) {
      excluded.push({
        knowledgePageId: candidate.knowledgePageId,
        contentDigest:
          memory || knowledgePageReadable(pinnedInput, candidate.knowledgePageId, content)
            ? contentDigest
            : null,
        reason: 'lower_conformance',
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

  admit();
  if (canonicalJson(before.view) !== canonicalJson(collect().view))
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

interface KnowledgeTraceReadInput {
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
  const sourceScope =
    trace.retrievalParameters.sourceScope === 'user'
      ? `page/user/${trace.queryContext.actor.kind === 'user' ? trace.queryContext.actor.id : ''}`
      : trace.retrievalParameters.sourceScope === 'server'
        ? 'page/server'
        : `page/workspace/${trace.queryContext.workspaceId}`;
  if (trace.sourceScope !== sourceScope) throw knowledgeTraceUnavailable();
  if (trace.retrievalParameters.sourceScope === 'user') {
    // Record inspection uses the addressed owner after current audience and self admission.
    if (sourceScope !== `page/user/${input.access.requestActor?.userId}`)
      throw knowledgeTraceUnavailable();
    admitUserMemoryRetrieval(target);
  }
  return trace;
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
  },
  reference: PageReference,
  serverId: string
): string | null {
  if (reference.scopeId.startsWith('page/user/')) {
    // Current self Memory is independent of Workspace import lineage; the trace reader still binds its Server.
    if (reference.scopeId !== `page/user/${input.access.requestActor?.userId}`)
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
  const importedFrom = input.access.store.getWorkspace(input.workspaceId).importedFrom;
  const crossDeploymentImport =
    importedFrom !== undefined && importedFrom.sourceDeploymentId !== serverId;
  if (crossDeploymentImport && reference.scopeId === 'page/server')
    throw knowledgeTraceUnavailable();
  if (reference.scopeId !== `page/workspace/${input.workspaceId}`) {
    if (
      reference.scopeId === 'page/server' &&
      input.access.coreDb &&
      input.access.requestActor &&
      isCurrentDeploymentAdministrator(input.access.coreDb, input.access.requestActor)
    )
      throw new OperationError(
        'knowledge_source_unavailable',
        'Knowledge trace source is unavailable.',
        503
      );
    throw knowledgeTraceUnavailable();
  }
  admitKnowledgeRetrieval(input);
  const workspaceRoot = resolveDataRootPath(input.dataRoot, 'workspaces', input.workspaceId);
  const current = readWorkspaceNotebookIndexSource(workspaceRoot, undefined, [reference.objectId]);
  const pinned =
    input.notebookRevision !== undefined && input.notebookRevision !== current.notebookRevision
      ? readWorkspaceNotebookIndexSource(workspaceRoot, input.notebookRevision, [
          reference.objectId,
        ])
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
  const references = [
    ...trace.selected.map((entry) => entry.reference),
    ...trace.excluded.map((entry) => entry.reference),
    ...trace.retrievalParameters.pinnedReferences,
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
  for (const entry of [...trace.selected, ...trace.excluded]) {
    if (trace.retrievalParameters.sourceScope === 'user') {
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
  const notebookRevision = trace.notebookRevision;
  const pinnedInput = { ...input, notebookRevision };
  if (trace.retrievalParameters.sourceScope === 'user') {
    admitUserMemoryRetrieval(input);
    if (
      trace.sourceScope !== `page/user/${input.access.requestActor!.userId}` ||
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
        ['stale', 'expired'].includes(stringFrontmatterField(document, 'freshness') ?? '')
      )
        throw knowledgeTraceUnavailable();
      const kind = stringFrontmatterField(document, 'openkit_entry_kind');
      pages.push({
        notebookRevision,
        reference: selected.reference,
        knowledgePageId: selected.reference.objectId,
        contentDigest: selected.contentDigest,
        sourceRefs,
        content,
        title: stringFrontmatterField(document, 'title')!,
        body: document.body.trim(),
        kind: kind === 'preference' || kind === 'task-summary' ? kind : 'project-context',
      });
    }
    admitUserMemoryRetrieval(input);
    return pages;
  }
  const referenceProofs = currentKnowledgeReferenceProofs(pinnedInput);
  const pinnedPages = readWorkspaceNotebookIndexSource(workspaceRoot, notebookRevision).pages;
  const scopeSchemaText = readScopeKnowledgeSchemaText(workspaceRoot);
  const registeredSources = readRegisteredSources(workspaceRoot, input.workspaceId);
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
      path,
      content,
      ...(scopeSchemaText ? { scopeSchemaText } : {}),
      registeredSources,
      knowledgeIds,
      ...(referenceProof ? { resolvedReferences: referenceProof.resolvedReferences } : {}),
    });
    const reviewState = document ? stringFrontmatterField(document, 'review_state') : null;
    const sensitivity = document ? stringFrontmatterField(document, 'sensitivity') : null;
    const freshness = document ? stringFrontmatterField(document, 'freshness') : null;
    const title = document ? stringFrontmatterField(document, 'title') : null;
    const entryKind = document ? stringFrontmatterField(document, 'openkit_entry_kind') : null;

    if (
      !parsed.ok ||
      !document ||
      validation.conformance !== 'scope-schema-valid' ||
      validation.errors.length > 0 ||
      document.conceptId !== selected.reference.objectId ||
      stringFrontmatterField(document, 'openkit_status') !== 'active' ||
      (reviewState !== 'accepted' && reviewState !== 'user-authored') ||
      (reviewState === 'accepted' && !referenceProof) ||
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
      reference: selected.reference,
      knowledgePageId: selected.reference.objectId,
      contentDigest,
      sourceRefs,
      content,
      title,
      body: document.body.trim(),
      kind:
        entryKind === 'preference' ||
        entryKind === 'project-context' ||
        entryKind === 'task-summary'
          ? entryKind
          : 'project-context',
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
 * Reads Knowledge ids from one pinned Notebook tree.
 *
 * @param pages Exact page bytes from one Notebook revision.
 * @returns Knowledge ids available for knowledge-prefixed references.
 */
function readKnowledgePageIds(pages: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set<string>();

  for (const [knowledgePageId, content] of pages) {
    const path = `knowledge/pages/${knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path, content });

    if (parsed.ok) {
      ids.add(
        stringFrontmatterField(parsed.document, 'openkit_entry_id') ??
          parsed.document.conceptId ??
          knowledgePageId
      );
    }
  }

  return ids;
}

/**
 * Reads registered Source ids and digests from the owning Workspace registry.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Registered Source ids and nullable digests for the Workspace.
 */
function readRegisteredSources(
  workspaceRoot: string,
  workspaceId: string
): Map<string, string | null> {
  const registryRoot = join(workspaceRoot, 'sources', 'registry');
  const sources = new Map<string, string | null>();

  for (const fileName of listFiles(registryRoot).filter((name) => name.endsWith('.json'))) {
    const source = readJsonRecord(join(registryRoot, fileName)) as Record<string, unknown>;

    if (stringField(source, 'workspaceId') === workspaceId) {
      sources.set(
        stringField(source, 'id'),
        typeof source.contentDigest === 'string' ? source.contentDigest : null
      );
    }
  }

  return sources;
}

/**
 * Returns whether source-prefixed references resolve to registered sources.
 *
 * @param document Parsed OKF document.
 * @param registeredSources Registered Source ids and digests for the Workspace.
 * @returns True when all source-prefixed references resolve.
 */
function sourceReferencesResolve(
  document: OkfDocument,
  registeredSources: ReadonlyMap<string, string | null>,
  knowledgeIds: ReadonlySet<string>,
  resolvedReferences?: ReadonlySet<string>
): boolean {
  if (stringListFrontmatterField(document, 'source_refs') === null) {
    return false;
  }

  return (
    knowledgeReferenceErrors(document, registeredSources, knowledgeIds, resolvedReferences)
      .length === 0
  );
}

/**
 * Returns whether one Page may enter proof-neutral persisted search projections.
 *
 * Accepted Pages require request-scoped Proposal/Review or import proof and are added only by the
 * governed retrieval owner; user-authored Pages can be indexed from their file-owned authority.
 *
 * @param document Parsed authoritative Page.
 * @param schema Current Workspace Knowledge schema.
 * @param registeredSources Current registered Source identities and digests.
 * @param knowledgeIds Current Workspace Knowledge identities.
 * @returns True only for an active, valid, directly user-authored Page.
 */
function isStaticKnowledgeIndexPage(
  document: OkfDocument,
  schema: ScopeKnowledgeSchema,
  registeredSources: ReadonlyMap<string, string | null>,
  knowledgeIds: ReadonlySet<string>
): boolean {
  return (
    stringFrontmatterField(document, 'review_state') === 'user-authored' &&
    isActiveOpenKitKnowledgePage(document, schema) &&
    sourceReferencesResolve(document, registeredSources, knowledgeIds)
  );
}

/**
 * Builds validation report records for file-backed knowledge pages.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Validation records for knowledge pages.
 */
function buildKnowledgeValidationRecords(
  workspaceRoot: string,
  workspaceId: string,
  pages: ReadonlyMap<string, string>
): WorkspaceKnowledgeValidationRecord[] {
  const scopeSchemaText = readScopeKnowledgeSchemaText(workspaceRoot);
  const registeredSources = readRegisteredSources(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pages);
  const records: WorkspaceKnowledgeValidationRecord[] = [];

  for (const [knowledgePageId, content] of pages) {
    const path = `knowledge/pages/${knowledgePageId}.md`;
    const workspacePath = `knowledge/pages/${knowledgePageId}.md`;
    const contentDigest = sha256Digest(content);
    const parsed = parseOkfDocument({ path, content });

    const report = validateKnowledgePageCandidate({
      path,
      content,
      ...(scopeSchemaText ? { scopeSchemaText } : {}),
      registeredSources,
      knowledgeIds,
    });
    const active = parsed.document?.frontmatter.openkit_status === 'active';
    const reviewState = parsed.document
      ? stringFrontmatterField(parsed.document, 'review_state')
      : null;
    const title = parsed.document ? stringFrontmatterField(parsed.document, 'title') : null;

    records.push({
      conceptId: parsed.document?.conceptId ?? knowledgePageId,
      path: workspacePath,
      contentDigest,
      ...(title ? { title } : {}),
      conformance: report.conformance,
      active,
      indexed:
        active &&
        reviewState === 'user-authored' &&
        report.conformance === 'scope-schema-valid' &&
        report.errors.length === 0,
      errors: report.errors,
    });
  }

  return records.sort((left, right) => left.conceptId.localeCompare(right.conceptId));
}

/**
 * Builds source-reference index records for parseable file-backed knowledge pages.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Source-reference records declared by knowledge pages.
 */
function buildKnowledgeSourceReferences(
  workspaceRoot: string,
  workspaceId: string,
  pages: ReadonlyMap<string, string>
): WorkspaceKnowledgeSourceReference[] {
  const registeredSources = readRegisteredSources(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pages);
  const references: WorkspaceKnowledgeSourceReference[] = [];

  for (const [knowledgePageId, content] of pages) {
    const path = `knowledge/pages/${knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path, content });
    const document = parsed.document;
    const sourceRefs = document ? stringListFrontmatterField(document, 'source_refs') : null;

    if (!document || sourceRefs === null) {
      continue;
    }

    const conceptId = document.conceptId ?? knowledgePageId;
    const workspacePath = `knowledge/pages/${knowledgePageId}.md`;

    for (const reference of sourceRefs) {
      references.push(
        classifyKnowledgeSourceReference({
          conceptId,
          path: workspacePath,
          reference,
          registeredSources,
          knowledgeIds,
        })
      );
    }
  }

  return references.sort((left, right) =>
    `${left.conceptId}\u0000${left.reference}`.localeCompare(
      `${right.conceptId}\u0000${right.reference}`
    )
  );
}

/**
 * Classifies one knowledge page source reference against local workspace indexes.
 *
 * @param input Reference and local target sets.
 * @returns Classified source-reference index record.
 */
function classifyKnowledgeSourceReference(input: {
  /** Concept id declaring the reference. */
  conceptId: string;
  /** Workspace-relative page path declaring the reference. */
  path: string;
  /** Raw source reference. */
  reference: string;
  /** Registered Workspace Source ids and digests. */
  registeredSources: ReadonlyMap<string, string | null>;
  /** File-backed workspace knowledge ids. */
  knowledgeIds: ReadonlySet<string>;
}): WorkspaceKnowledgeSourceReference {
  if (input.reference.startsWith('source:')) {
    const resolution = resolveRegisteredKnowledgeSourceReference(
      input.reference,
      input.registeredSources
    );

    return {
      conceptId: input.conceptId,
      path: input.path,
      reference: input.reference,
      kind: 'registered-source',
      ...resolution,
    };
  }

  if (input.reference.startsWith('knowledge:')) {
    const targetId = input.reference
      .slice('knowledge:'.length)
      .replace(/@sha256:[a-f0-9]{64}$/, '');

    return {
      conceptId: input.conceptId,
      path: input.path,
      reference: input.reference,
      kind: 'workspace-knowledge',
      targetId,
      resolved: input.knowledgeIds.has(targetId),
    };
  }

  const resolved =
    knowledgeReferenceErrors(
      {
        path: input.path,
        conceptId: input.conceptId,
        frontmatter: { source_refs: [input.reference] },
        body: '',
        reserved: false,
      },
      input.registeredSources,
      input.knowledgeIds
    ).length === 0;

  return {
    conceptId: input.conceptId,
    path: input.path,
    reference: input.reference,
    kind: 'external-reference',
    targetId: null,
    resolved,
  };
}

/**
 * Builds directed knowledge-page link edges from active Markdown bodies.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Directed knowledge link edges.
 */
function buildKnowledgeLinkEdges(
  workspaceRoot: string,
  workspaceId: string,
  pages: ReadonlyMap<string, string>
): WorkspaceKnowledgeLinkEdge[] {
  const schema = readScopeKnowledgeSchema(workspaceRoot);
  const registeredSources = readRegisteredSources(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pages);
  const conceptIds = readKnowledgePageConceptIds(pages);
  const edges: WorkspaceKnowledgeLinkEdge[] = [];

  if (!schema) {
    return edges;
  }

  for (const [knowledgePageId, content] of pages) {
    const path = `knowledge/pages/${knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path, content });

    if (
      !parsed.ok ||
      !isStaticKnowledgeIndexPage(parsed.document, schema, registeredSources, knowledgeIds)
    ) {
      continue;
    }

    const fromId = parsed.document.conceptId ?? knowledgePageId;

    for (const target of extractMarkdownLinkTargets(parsed.document.body)) {
      const toId = normalizeKnowledgeLinkTarget(parsed.document.conceptId, target);

      if (!toId) {
        continue;
      }

      edges.push({
        fromId,
        target,
        toId,
        resolved: conceptIds.has(toId),
      });
    }
  }

  return edges.sort((left, right) =>
    `${left.fromId}\u0000${left.target}`.localeCompare(`${right.fromId}\u0000${right.target}`)
  );
}

/**
 * Reads concept ids from one pinned Notebook tree.
 *
 * @param pages Exact page bytes from one Notebook revision.
 * @returns Concept ids available for Markdown link resolution.
 */
function readKnowledgePageConceptIds(pages: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set<string>();

  for (const [knowledgePageId, content] of pages) {
    const path = `knowledge/pages/${knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path, content });

    if (parsed.ok) {
      ids.add(parsed.document.conceptId ?? knowledgePageId);
    }
  }

  return ids;
}

/**
 * Extracts non-image Markdown link targets.
 *
 * @param body Markdown body text.
 * @returns Raw Markdown link targets.
 */
function extractMarkdownLinkTargets(body: string): string[] {
  const targets: string[] = [];
  const linkPattern = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

  for (const match of body.matchAll(linkPattern)) {
    if (match.index > 0 && body[match.index - 1] === '!') {
      continue;
    }

    const target = match[1];

    if (target) {
      targets.push(target);
    }
  }

  return targets;
}

/**
 * Normalizes an OKF Markdown link target to a bundle-relative concept id.
 *
 * @param fromConceptId Source concept id.
 * @param target Raw Markdown link target.
 * @returns Target concept id, or null for external and non-concept links.
 */
function normalizeKnowledgeLinkTarget(fromConceptId: string, target: string): string | null {
  if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return null;
  }

  const withoutHash = target.split('#')[0] ?? '';
  const withoutFragment = withoutHash.split('?')[0] ?? '';

  if (!withoutFragment) {
    return null;
  }

  const normalized = withoutFragment.startsWith('/')
    ? posix.normalize(withoutFragment.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromConceptId), withoutFragment));

  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  return normalized.endsWith('.md') ? normalized.slice(0, -'.md'.length) : normalized;
}

/**
 * Reads the workspace knowledge schema used by derived index rebuilds.
 *
 * @param workspaceRoot Workspace root path.
 * @returns Parsed schema, default schema when absent, or null for invalid schema files.
 */
function readScopeKnowledgeSchema(workspaceRoot: string): ScopeKnowledgeSchema | null {
  const content = readScopeKnowledgeSchemaText(workspaceRoot);

  if (!content) {
    return DEFAULT_SCOPE_KNOWLEDGE_SCHEMA;
  }

  const parsed = parseScopeKnowledgeSchema(content);

  return parsed.ok ? parsed.schema : null;
}

/** Reads the exact workspace Knowledge schema text when present. */
function readScopeKnowledgeSchemaText(workspaceRoot: string): string | undefined {
  const schemaPath = join(workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml');
  return existsSync(schemaPath) ? readCanonicalTextFile(schemaPath) : undefined;
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
 * Lists direct child files in stable order.
 *
 * @param path Parent directory path.
 * @returns File names.
 */
function listFiles(path: string): string[] {
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
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Reads a required string field from a record.
 *
 * @param record Source record.
 * @param field Field name.
 * @returns String field value.
 * @throws Error when the field is missing or not a string.
 */
function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected string field ${field}.`);
  }

  return value;
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
