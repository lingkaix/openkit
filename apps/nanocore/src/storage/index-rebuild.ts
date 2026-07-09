import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';

import {
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA,
  isActiveOpenKitKnowledgePage,
  type KnowledgeConformance,
  type KnowledgeValidationError,
  type OkfDocument,
  parseOkfDocument,
  parseWorkspaceKnowledgeSchema,
  stringFrontmatterField,
  validateWorkspaceKnowledgeSchema,
  type WorkspaceKnowledgeSchema,
} from '../knowledge/okf.js';
import { resolveDataRootPath } from './fs-layout.js';

type SearchIndexKind = 'workspace' | 'thread' | 'knowledge' | 'artifact' | 'item';

/**
 * One derived search-index entry rebuilt from source records.
 */
export interface WorkspaceSearchIndexEntry {
  /** Indexed record kind. */
  kind: SearchIndexKind;
  /** Source record id. */
  id: string;
  /** Display title used by search results. */
  title: string;
  /** Workspace that owns the record. */
  workspaceId?: string;
  /** Thread lineage when present. */
  threadId?: string;
  /** Lower-level text searched by consumers. */
  searchText: string;
}

/**
 * Derived workspace search index file.
 */
export interface WorkspaceSearchIndex {
  /** Index schema version. */
  schemaVersion: 1;
  /** Workspace that owns the derived index. */
  workspaceId: string;
  /** Rebuild timestamp. */
  rebuiltAt: string;
  /** Derived search entries. */
  items: WorkspaceSearchIndexEntry[];
}

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
  /** Source-reference index schema version. */
  schemaVersion: 1;
  /** Workspace that owns the derived index. */
  workspaceId: string;
  /** Rebuild timestamp. */
  rebuiltAt: string;
  /** Source references declared by parseable file-backed knowledge pages. */
  references: WorkspaceKnowledgeSourceReference[];
}

/** Field that contributed a term to the full-text index. */
export type WorkspaceKnowledgeFullTextField = 'title' | 'body';

/** One full-text posting for a knowledge concept. */
export interface WorkspaceKnowledgeFullTextPosting {
  /** Bundle-relative concept id. */
  conceptId: string;
  /** Fields where the term appears. */
  fields: WorkspaceKnowledgeFullTextField[];
  /** Total occurrences across indexed fields. */
  occurrences: number;
}

/** One indexed full-text term and its knowledge-page postings. */
export interface WorkspaceKnowledgeFullTextTerm {
  /** Normalized indexed term. */
  term: string;
  /** Knowledge pages containing the term. */
  postings: WorkspaceKnowledgeFullTextPosting[];
}

/** Derived workspace knowledge full-text index file. */
export interface WorkspaceKnowledgeFullTextIndex {
  /** Full-text index schema version. */
  schemaVersion: 1;
  /** Workspace that owns the derived index. */
  workspaceId: string;
  /** Rebuild timestamp. */
  rebuiltAt: string;
  /** Tokenizer contract for this first-slice index. */
  tokenizer: 'unicode-simple-v1';
  /** Indexed terms and postings. */
  terms: WorkspaceKnowledgeFullTextTerm[];
}

/**
 * Input for rebuilding one workspace's derived indexes.
 */
export interface RebuildWorkspaceDerivedIndexesInput {
  /** Data root that owns the workspace. */
  dataRoot: string;
  /** User that owns the workspace. */
  userId: string;
  /** Workspace to rebuild. */
  workspaceId: string;
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
  /** Data root that owns the workspace. */
  dataRoot: string;
  /** User that owns the workspace. */
  userId: string;
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
  /** Derived full-text term index. */
  fullText: WorkspaceKnowledgeFullTextIndex;
}

/** Input for deterministic Knowledge Store retrieval. */
export interface RetrieveWorkspaceKnowledgeInput extends ReadWorkspaceKnowledgeDerivedIndexesInput {
  /** User query used to rank active Knowledge Store pages. */
  query: string;
  /** Maximum number of selected candidates. */
  limit?: number | undefined;
  /** Concepts that should be included when present and active. */
  pinnedConceptIds?: readonly string[] | undefined;
  /** Optional trace id for deterministic tests and route ownership. */
  traceId?: string | undefined;
  /** Optional timestamp source for deterministic tests. */
  now?: (() => string) | undefined;
}

/** Selected Knowledge Store retrieval candidate. */
export interface WorkspaceKnowledgeRetrievalCandidate {
  /** Selected concept id. */
  conceptId: string;
  /** Human-readable title. */
  title: string;
  /** Knowledge page path relative to the workspace root. */
  path: string;
  /** Deterministic retrieval score. */
  score: number;
  /** Query terms matched by this page. */
  matchedTerms: string[];
  /** Source references declared by this page. */
  sourceReferences: string[];
}

/** Retrieval candidate excluded from the selected context budget. */
export interface WorkspaceKnowledgeRetrievalExclusion {
  /** Excluded concept id. */
  conceptId: string;
  /** Human-readable title. */
  title: string;
  /** Knowledge page path relative to the workspace root. */
  path: string;
  /** Deterministic exclusion reason. */
  reason: 'relevance_too_low' | 'budget_exceeded';
  /** Human-readable exclusion detail. */
  detail: string;
}

/** Persisted Knowledge Store retrieval trace. */
export interface WorkspaceKnowledgeRetrievalTrace {
  /** Trace id for the retrieval decision. */
  traceId: string;
  /** Workspace that owns the retrieval. */
  workspaceId: string;
  /** Query used to rank candidates. */
  query: string;
  /** Trace creation timestamp. */
  createdAt: string;
  /** Selected candidates in deterministic ranking order. */
  selected: WorkspaceKnowledgeRetrievalCandidate[];
  /** Excluded candidates with deterministic reasons. */
  excluded: WorkspaceKnowledgeRetrievalExclusion[];
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
  const workspaceRoot = resolveDataRootPath(
    input.dataRoot,
    'users',
    input.userId,
    'workspaces',
    input.workspaceId
  );
  const workspacePath = join(workspaceRoot, 'workspace.json');

  if (!existsSync(workspacePath)) {
    throw new Error(
      `Workspace projection is missing: ${toReportPath(input.dataRoot, workspacePath)}`
    );
  }

  const indexesRoot = join(workspaceRoot, 'indexes');
  const removedEntries = clearIndexDirectory(indexesRoot);
  const indexPath = join(indexesRoot, 'search.json');
  const rebuiltAt = input.now?.() ?? new Date().toISOString();
  const index: WorkspaceSearchIndex = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    items: buildSearchEntries(workspaceRoot, input.workspaceId),
  };
  const linkGraph: WorkspaceKnowledgeLinkGraph = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    edges: buildKnowledgeLinkEdges(workspaceRoot, input.workspaceId),
  };
  const validationIndex: WorkspaceKnowledgeValidationIndex = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    records: buildKnowledgeValidationRecords(workspaceRoot, input.workspaceId),
  };
  const sourceReferenceIndex: WorkspaceKnowledgeSourceReferenceIndex = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    references: buildKnowledgeSourceReferences(workspaceRoot, input.workspaceId),
  };
  const fullTextIndex: WorkspaceKnowledgeFullTextIndex = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    rebuiltAt,
    tokenizer: 'unicode-simple-v1',
    terms: buildKnowledgeFullTextTerms(workspaceRoot, input.workspaceId),
  };

  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
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
  writeFileSync(
    join(indexesRoot, 'knowledge-fts.json'),
    `${JSON.stringify(fullTextIndex, null, 2)}\n`
  );

  return {
    workspaceId: input.workspaceId,
    indexPath: toReportPath(input.dataRoot, indexPath),
    itemCount: index.items.length,
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
  const results: RebuildWorkspaceDerivedIndexesResult[] = [];
  const usersRoot = resolveDataRootPath(dataRoot, 'users');

  for (const userId of listDirectories(usersRoot)) {
    const workspacesRoot = resolveDataRootPath(dataRoot, 'users', userId, 'workspaces');

    for (const workspaceId of listDirectories(workspacesRoot)) {
      if (!existsSync(join(workspacesRoot, workspaceId, 'workspace.json'))) {
        continue;
      }

      results.push(
        rebuildWorkspaceDerivedIndexes({
          dataRoot,
          userId,
          workspaceId,
          ...(options.now ? { now: options.now } : {}),
        })
      );
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
    'users',
    input.userId,
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
    fullText: readJsonRecord(
      join(indexesRoot, 'knowledge-fts.json')
    ) as WorkspaceKnowledgeFullTextIndex,
  };
}

/**
 * Retrieves ranked Knowledge Store candidates and persists the selection trace.
 *
 * @param input Retrieval target and query.
 * @returns Persisted retrieval trace with selected and excluded candidates.
 * @throws Error when the canonical workspace projection is missing.
 */
export function retrieveWorkspaceKnowledge(
  input: RetrieveWorkspaceKnowledgeInput
): WorkspaceKnowledgeRetrievalTrace {
  const indexes = readWorkspaceKnowledgeDerivedIndexes(input);
  const queryTerms = [...new Set(tokenizeKnowledgeText(input.query))].sort();
  const pinnedConceptIds = new Set(input.pinnedConceptIds ?? []);
  const limit = input.limit ?? 5;
  const createdAt = input.now?.() ?? new Date().toISOString();
  const traceId = input.traceId ?? `krt_${createdAt.replaceAll(/\D/g, '')}`;
  const sourceReferencesByConcept = new Map<string, string[]>();
  const scores = new Map<string, number>();
  const matchedTerms = new Map<string, Set<string>>();

  for (const reference of indexes.sourceReferences.references) {
    const references = sourceReferencesByConcept.get(reference.conceptId) ?? [];

    references.push(reference.reference);
    sourceReferencesByConcept.set(reference.conceptId, references);
  }

  for (const term of indexes.fullText.terms) {
    if (!queryTerms.includes(term.term)) {
      continue;
    }

    for (const posting of term.postings) {
      const fieldScore = posting.fields.includes('title') ? 2 : 0;
      scores.set(
        posting.conceptId,
        (scores.get(posting.conceptId) ?? 0) + posting.occurrences + fieldScore
      );

      const terms = matchedTerms.get(posting.conceptId) ?? new Set<string>();

      terms.add(term.term);
      matchedTerms.set(posting.conceptId, terms);
    }
  }

  const candidates = indexes.validation.records
    .filter((record) => record.indexed)
    .map<WorkspaceKnowledgeRetrievalCandidate>((record) => {
      const pinnedScore = pinnedConceptIds.has(record.conceptId) ? 1000 : 0;

      return {
        conceptId: record.conceptId,
        title: record.title ?? record.conceptId,
        path: record.path,
        score: (scores.get(record.conceptId) ?? 0) + pinnedScore,
        matchedTerms: [...(matchedTerms.get(record.conceptId) ?? new Set<string>())].sort(),
        sourceReferences: [
          ...new Set(sourceReferencesByConcept.get(record.conceptId) ?? []),
        ].sort(),
      };
    })
    .sort(compareKnowledgeRetrievalCandidates);
  const selectedIds = new Set(
    candidates
      .filter((candidate) => candidate.score > 0 || pinnedConceptIds.has(candidate.conceptId))
      .slice(0, limit)
      .map((candidate) => candidate.conceptId)
  );
  const trace: WorkspaceKnowledgeRetrievalTrace = {
    traceId,
    workspaceId: input.workspaceId,
    query: input.query,
    createdAt,
    selected: candidates.filter((candidate) => selectedIds.has(candidate.conceptId)),
    excluded: candidates
      .filter((candidate) => !selectedIds.has(candidate.conceptId))
      .map((candidate) => ({
        conceptId: candidate.conceptId,
        title: candidate.title,
        path: candidate.path,
        reason:
          candidate.score <= 0 && !pinnedConceptIds.has(candidate.conceptId)
            ? 'relevance_too_low'
            : 'budget_exceeded',
        detail:
          candidate.score <= 0 && !pinnedConceptIds.has(candidate.conceptId)
            ? 'No query terms matched this candidate.'
            : 'Candidate exceeded the retrieval selection limit.',
      })),
  };

  appendKnowledgeRetrievalTrace(input, createdAt, trace);

  return trace;
}

/**
 * Orders retrieval candidates by score and stable identity fields.
 *
 * @param left Left candidate.
 * @param right Right candidate.
 * @returns Sort comparator result.
 */
function compareKnowledgeRetrievalCandidates(
  left: WorkspaceKnowledgeRetrievalCandidate,
  right: WorkspaceKnowledgeRetrievalCandidate
): number {
  return (
    right.score - left.score ||
    left.title.localeCompare(right.title) ||
    left.conceptId.localeCompare(right.conceptId)
  );
}

/**
 * Appends one retrieval trace to the monthly workspace trace ledger.
 *
 * @param input Retrieval target.
 * @param createdAt Trace timestamp.
 * @param trace Trace payload to persist.
 */
function appendKnowledgeRetrievalTrace(
  input: ReadWorkspaceKnowledgeDerivedIndexesInput,
  createdAt: string,
  trace: WorkspaceKnowledgeRetrievalTrace
): void {
  const tracePath = knowledgeRetrievalTraceLedgerPath(input, createdAt);

  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, `${JSON.stringify(trace)}\n`);
}

/**
 * Returns the monthly trace ledger path for Knowledge Store retrieval.
 *
 * @param input Retrieval target.
 * @param createdAt Trace timestamp.
 * @returns Absolute trace ledger path.
 */
function knowledgeRetrievalTraceLedgerPath(
  input: ReadWorkspaceKnowledgeDerivedIndexesInput,
  createdAt: string
): string {
  return resolveDataRootPath(
    input.dataRoot,
    'users',
    input.userId,
    'workspaces',
    input.workspaceId,
    'knowledge',
    'traces',
    `${createdAt.slice(0, 7).replace('-', '')}.jsonl`
  );
}

/**
 * Builds search entries from workspace projections and the temporary store snapshot.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Search index entries.
 */
function buildSearchEntries(
  workspaceRoot: string,
  workspaceId: string
): WorkspaceSearchIndexEntry[] {
  const entries: WorkspaceSearchIndexEntry[] = [];
  const workspace = readJsonRecord(join(workspaceRoot, 'workspace.json')) as {
    id: string;
    name?: string;
  };

  entries.push({
    kind: 'workspace',
    id: workspace.id,
    title: workspace.name ?? workspace.id,
    searchText: workspace.name ?? workspace.id,
  });
  entries.push(...readKnowledgePageEntries(workspaceRoot, workspaceId));
  entries.push(...readArtifactEntries(workspaceRoot, workspaceId));
  entries.push(...readThreadEntries(workspaceRoot, workspaceId));

  return entries;
}

/**
 * Reads file-backed artifacts into search entries.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Search entries for artifacts.
 */
function readArtifactEntries(
  workspaceRoot: string,
  workspaceId: string
): WorkspaceSearchIndexEntry[] {
  const artifactsRoot = join(workspaceRoot, 'artifacts');
  const entries: WorkspaceSearchIndexEntry[] = [];

  for (const artifactId of listDirectories(artifactsRoot)) {
    const artifactRoot = join(artifactsRoot, artifactId);
    const artifact = readJsonRecord(join(artifactRoot, 'artifact.json')) as Record<string, unknown>;

    if (stringField(artifact, 'workspaceId') !== workspaceId) {
      continue;
    }

    const id = stringField(artifact, 'id');
    const title = stringField(artifact, 'title');
    const summary = nullableStringField(artifact, 'summary') ?? '';
    const threadId = nullableStringField(artifact, 'threadId');
    const body = readArtifactContentBody(artifactRoot, artifact);

    entries.push({
      kind: 'artifact',
      id,
      title,
      workspaceId,
      ...(threadId ? { threadId } : {}),
      searchText: `${title}\n${summary}\n${body}`,
    });
  }

  return entries;
}

/**
 * Reads artifact content from projected files, falling back to the metadata snapshot body.
 *
 * @param artifactRoot Artifact root path.
 * @param artifact Artifact metadata record.
 * @returns Artifact body text for search indexing.
 */
function readArtifactContentBody(artifactRoot: string, artifact: Record<string, unknown>): string {
  const filesRoot = join(artifactRoot, 'files');

  for (const fileName of ['content.md', 'content.txt', 'content.json']) {
    const path = join(filesRoot, fileName);

    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }

  const content = artifact.content;

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return nullableStringField(content as Record<string, unknown>, 'body') ?? '';
  }

  return '';
}

/**
 * Reads file-backed knowledge pages into search entries.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Search entries for knowledge pages.
 */
function readKnowledgePageEntries(
  workspaceRoot: string,
  workspaceId: string
): WorkspaceSearchIndexEntry[] {
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const schema = readWorkspaceKnowledgeSchema(workspaceRoot);
  const registeredSourceIds = readRegisteredSourceIds(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pagesRoot);
  const entries: WorkspaceSearchIndexEntry[] = [];

  if (!schema) {
    return entries;
  }

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const content = readFileSync(path, 'utf8');
    const parsed = parseOkfDocument({ path, content });

    if (
      !parsed.ok ||
      !isActiveOpenKitKnowledgePage(parsed.document, schema) ||
      !sourceReferencesResolve(parsed.document, registeredSourceIds, knowledgeIds)
    ) {
      continue;
    }

    const id =
      stringFrontmatterField(parsed.document, 'openkit_entry_id') ??
      parsed.document.conceptId ??
      fileName.slice(0, -'.md'.length);
    const title = stringFrontmatterField(parsed.document, 'title') ?? id;

    entries.push({
      kind: 'knowledge',
      id,
      title,
      workspaceId,
      searchText: `${title}\n${parsed.document.body}`,
    });
  }

  return entries;
}

/**
 * Reads file-backed knowledge ids from workspace knowledge pages.
 *
 * @param pagesRoot Knowledge pages root.
 * @returns Knowledge ids available for knowledge-prefixed references.
 */
function readKnowledgePageIds(pagesRoot: string): Set<string> {
  const ids = new Set<string>();

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const parsed = parseOkfDocument({ path, content: readFileSync(path, 'utf8') });

    if (parsed.ok) {
      ids.add(
        stringFrontmatterField(parsed.document, 'openkit_entry_id') ??
          parsed.document.conceptId ??
          fileName.slice(0, -'.md'.length)
      );
    }
  }

  return ids;
}

/**
 * Reads registered knowledge source ids from the workspace source registry.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Registered source ids for the workspace.
 */
function readRegisteredSourceIds(workspaceRoot: string, workspaceId: string): Set<string> {
  const registryRoot = join(workspaceRoot, 'sources', 'registry');
  const sourceIds = new Set<string>();

  for (const fileName of listFiles(registryRoot).filter((name) => name.endsWith('.json'))) {
    const source = readJsonRecord(join(registryRoot, fileName)) as Record<string, unknown>;

    if (stringField(source, 'workspaceId') === workspaceId) {
      sourceIds.add(stringField(source, 'id'));
    }
  }

  return sourceIds;
}

/**
 * Returns whether source-prefixed references resolve to registered sources.
 *
 * @param document Parsed OKF document.
 * @param registeredSourceIds Registered source ids for the workspace.
 * @returns True when all source-prefixed references resolve.
 */
function sourceReferencesResolve(
  document: OkfDocument,
  registeredSourceIds: ReadonlySet<string>,
  knowledgeIds: ReadonlySet<string>
): boolean {
  if (!Array.isArray(document.frontmatter.source_refs)) {
    return false;
  }

  return knowledgeReferenceErrors(document, registeredSourceIds, knowledgeIds).length === 0;
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
  workspaceId: string
): WorkspaceKnowledgeValidationRecord[] {
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const schema = readWorkspaceKnowledgeSchema(workspaceRoot);
  const registeredSourceIds = readRegisteredSourceIds(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pagesRoot);
  const records: WorkspaceKnowledgeValidationRecord[] = [];

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const workspacePath = `knowledge/pages/${fileName}`;
    const parsed = parseOkfDocument({ path, content: readFileSync(path, 'utf8') });

    if (!parsed.document) {
      records.push({
        conceptId: fileName.slice(0, -'.md'.length),
        path: workspacePath,
        conformance: 'invalid',
        active: false,
        indexed: false,
        errors: parsed.errors,
      });
      continue;
    }

    if (!parsed.ok) {
      const title = stringFrontmatterField(parsed.document, 'title');

      records.push({
        conceptId: parsed.document.conceptId,
        path: workspacePath,
        ...(title ? { title } : {}),
        conformance: 'invalid',
        active: parsed.document.frontmatter.status === 'active',
        indexed: false,
        errors: parsed.errors,
      });
      continue;
    }

    const report = validateWorkspaceKnowledgeSchema(
      parsed.document,
      schema ?? DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA
    );
    const schemaErrors: KnowledgeValidationError[] = schema
      ? []
      : [
          {
            code: 'workspace_schema.unavailable',
            message: 'Workspace knowledge schema is missing or invalid.',
          },
        ];
    const conformance: KnowledgeConformance =
      !schema && report.conformance === 'Workspace-schema-valid'
        ? 'OpenKit-profile-valid'
        : report.conformance;
    const referenceErrors = knowledgeReferenceErrors(
      parsed.document,
      registeredSourceIds,
      knowledgeIds
    );
    const active = parsed.document.frontmatter.status === 'active';
    const title = stringFrontmatterField(parsed.document, 'title');

    records.push({
      conceptId: parsed.document.conceptId,
      path: workspacePath,
      ...(title ? { title } : {}),
      conformance,
      active,
      indexed: active && conformance === 'Workspace-schema-valid' && referenceErrors.length === 0,
      errors: [...report.errors, ...schemaErrors, ...referenceErrors],
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
  workspaceId: string
): WorkspaceKnowledgeSourceReference[] {
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const registeredSourceIds = readRegisteredSourceIds(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pagesRoot);
  const references: WorkspaceKnowledgeSourceReference[] = [];

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const parsed = parseOkfDocument({ path, content: readFileSync(path, 'utf8') });
    const document = parsed.document;
    const sourceRefs = document?.frontmatter.source_refs;

    if (!document || !Array.isArray(sourceRefs)) {
      continue;
    }

    const conceptId = document.conceptId ?? fileName.slice(0, -'.md'.length);
    const workspacePath = `knowledge/pages/${fileName}`;

    for (const reference of sourceRefs) {
      references.push(
        classifyKnowledgeSourceReference({
          conceptId,
          path: workspacePath,
          reference,
          registeredSourceIds,
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
  /** Registered workspace source ids. */
  registeredSourceIds: ReadonlySet<string>;
  /** File-backed workspace knowledge ids. */
  knowledgeIds: ReadonlySet<string>;
}): WorkspaceKnowledgeSourceReference {
  if (input.reference.startsWith('source:')) {
    const targetId = input.reference.slice('source:'.length);

    return {
      conceptId: input.conceptId,
      path: input.path,
      reference: input.reference,
      kind: 'registered-source',
      targetId,
      resolved: input.registeredSourceIds.has(targetId),
    };
  }

  if (input.reference.startsWith('knowledge:')) {
    const targetId = input.reference.slice('knowledge:'.length);

    return {
      conceptId: input.conceptId,
      path: input.path,
      reference: input.reference,
      kind: 'workspace-knowledge',
      targetId,
      resolved: input.knowledgeIds.has(targetId),
    };
  }

  return {
    conceptId: input.conceptId,
    path: input.path,
    reference: input.reference,
    kind: 'external-reference',
    targetId: null,
    resolved: isValidExternalKnowledgeReference(input.reference),
  };
}

/**
 * Builds a deterministic full-text term index for active file-backed knowledge pages.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Indexed terms and postings.
 */
function buildKnowledgeFullTextTerms(
  workspaceRoot: string,
  workspaceId: string
): WorkspaceKnowledgeFullTextTerm[] {
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const schema = readWorkspaceKnowledgeSchema(workspaceRoot);
  const registeredSourceIds = readRegisteredSourceIds(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pagesRoot);
  const terms = new Map<
    string,
    Map<
      string,
      {
        fields: Set<WorkspaceKnowledgeFullTextField>;
        occurrences: number;
      }
    >
  >();

  if (!schema) {
    return [];
  }

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const parsed = parseOkfDocument({ path, content: readFileSync(path, 'utf8') });

    if (
      !parsed.ok ||
      !isActiveOpenKitKnowledgePage(parsed.document, schema) ||
      !sourceReferencesResolve(parsed.document, registeredSourceIds, knowledgeIds)
    ) {
      continue;
    }

    const conceptId = parsed.document.conceptId ?? fileName.slice(0, -'.md'.length);
    const title = stringFrontmatterField(parsed.document, 'title') ?? conceptId;

    addKnowledgeFullTextTerms(terms, conceptId, 'title', title);
    addKnowledgeFullTextTerms(terms, conceptId, 'body', parsed.document.body);
  }

  return [...terms.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([term, postings]) => ({
      term,
      postings: [...postings.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([conceptId, posting]) => ({
          conceptId,
          fields: [...posting.fields].sort(),
          occurrences: posting.occurrences,
        })),
    }));
}

/**
 * Adds one text field's tokens to a full-text term map.
 *
 * @param terms Mutable term map.
 * @param conceptId Concept id that owns the text.
 * @param field Field that supplied the text.
 * @param text Text to tokenize.
 */
function addKnowledgeFullTextTerms(
  terms: Map<
    string,
    Map<string, { fields: Set<WorkspaceKnowledgeFullTextField>; occurrences: number }>
  >,
  conceptId: string,
  field: WorkspaceKnowledgeFullTextField,
  text: string
): void {
  for (const term of tokenizeKnowledgeText(text)) {
    let postings = terms.get(term);

    if (!postings) {
      postings = new Map();
      terms.set(term, postings);
    }

    const posting = postings.get(conceptId) ?? { fields: new Set(), occurrences: 0 };

    posting.fields.add(field);
    posting.occurrences += 1;
    postings.set(conceptId, posting);
  }
}

/**
 * Tokenizes text for the first-slice deterministic full-text index.
 *
 * @param text Text to tokenize.
 * @returns Lowercase Unicode word tokens.
 */
function tokenizeKnowledgeText(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
}

/**
 * Validates local source and knowledge references in one OKF document.
 *
 * @param document Parsed OKF document.
 * @param registeredSourceIds Registered source ids for the workspace.
 * @param knowledgeIds Knowledge ids available for knowledge-prefixed references.
 * @returns Local reference validation errors.
 */
function knowledgeReferenceErrors(
  document: OkfDocument,
  registeredSourceIds: ReadonlySet<string>,
  knowledgeIds: ReadonlySet<string>
): KnowledgeValidationError[] {
  const sourceRefs = document.frontmatter.source_refs;

  if (!Array.isArray(sourceRefs)) {
    return [];
  }

  return sourceRefs.flatMap((reference) => {
    if (reference.startsWith('source:')) {
      return registeredSourceIds.has(reference.slice('source:'.length))
        ? []
        : [
            {
              code: 'reference.unresolved_source',
              field: 'source_refs',
              message: `Knowledge source reference ${reference} does not resolve.`,
            },
          ];
    }

    if (reference.startsWith('knowledge:')) {
      return knowledgeIds.has(reference.slice('knowledge:'.length))
        ? []
        : [
            {
              code: 'reference.unresolved_knowledge',
              field: 'source_refs',
              message: `Knowledge reference ${reference} does not resolve.`,
            },
          ];
    }

    if (!isValidExternalKnowledgeReference(reference)) {
      return [
        {
          code: 'reference.invalid_external',
          field: 'source_refs',
          message: `External knowledge source reference ${reference} must be an http or https URL.`,
        },
      ];
    }

    return [];
  });
}

/**
 * Returns whether an external knowledge source reference is syntactically valid.
 *
 * @param reference External source reference.
 * @returns True when the reference is an HTTP(S) URL.
 */
function isValidExternalKnowledgeReference(reference: string): boolean {
  try {
    const url = new URL(reference);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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
  workspaceId: string
): WorkspaceKnowledgeLinkEdge[] {
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const schema = readWorkspaceKnowledgeSchema(workspaceRoot);
  const registeredSourceIds = readRegisteredSourceIds(workspaceRoot, workspaceId);
  const knowledgeIds = readKnowledgePageIds(pagesRoot);
  const conceptIds = readKnowledgePageConceptIds(pagesRoot);
  const edges: WorkspaceKnowledgeLinkEdge[] = [];

  if (!schema) {
    return edges;
  }

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const parsed = parseOkfDocument({ path, content: readFileSync(path, 'utf8') });

    if (
      !parsed.ok ||
      !isActiveOpenKitKnowledgePage(parsed.document, schema) ||
      !sourceReferencesResolve(parsed.document, registeredSourceIds, knowledgeIds)
    ) {
      continue;
    }

    const fromId = parsed.document.conceptId ?? fileName.slice(0, -'.md'.length);

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
 * Reads file-backed concept ids from workspace knowledge pages.
 *
 * @param pagesRoot Knowledge pages root.
 * @returns Concept ids available for Markdown link resolution.
 */
function readKnowledgePageConceptIds(pagesRoot: string): Set<string> {
  const ids = new Set<string>();

  for (const fileName of listFiles(pagesRoot).filter((name) => name.endsWith('.md'))) {
    if (fileName === 'index.md' || fileName === 'log.md') {
      continue;
    }

    const path = join(pagesRoot, fileName);
    const parsed = parseOkfDocument({ path, content: readFileSync(path, 'utf8') });

    if (parsed.ok) {
      ids.add(parsed.document.conceptId ?? fileName.slice(0, -'.md'.length));
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
function readWorkspaceKnowledgeSchema(workspaceRoot: string): WorkspaceKnowledgeSchema | null {
  const schemaPath = join(workspaceRoot, 'knowledge', 'schema', 'workspace-schema.yaml');

  if (!existsSync(schemaPath)) {
    return DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA;
  }

  const parsed = parseWorkspaceKnowledgeSchema(readFileSync(schemaPath, 'utf8'));

  return parsed.ok ? parsed.schema : null;
}

/**
 * Reads thread, turn, and item projections into search entries.
 *
 * @param workspaceRoot Workspace root path.
 * @param workspaceId Workspace id.
 * @returns Search entries.
 */
function readThreadEntries(
  workspaceRoot: string,
  workspaceId: string
): WorkspaceSearchIndexEntry[] {
  const threadsRoot = join(workspaceRoot, 'threads');
  const entries: WorkspaceSearchIndexEntry[] = [];

  for (const threadId of listDirectories(threadsRoot)) {
    const thread = readJsonRecord(join(threadsRoot, threadId, 'thread.json')) as {
      id: string;
      name?: string;
      preview?: string;
    };
    const title = thread.name ?? thread.id;

    entries.push({
      kind: 'thread',
      id: thread.id,
      title,
      workspaceId,
      threadId: thread.id,
      searchText: `${title}\n${thread.preview ?? ''}`,
    });

    for (const turnId of listDirectories(join(threadsRoot, threadId, 'turns'))) {
      const turnRoot = join(threadsRoot, threadId, 'turns', turnId);
      const turn = readJsonRecord(join(turnRoot, 'turn.json')) as { id: string; input?: string };

      entries.push({
        kind: 'item',
        id: turn.id,
        title: turn.input ?? turn.id,
        workspaceId,
        threadId: thread.id,
        searchText: turn.input ?? turn.id,
      });

      for (const item of readJsonl(join(turnRoot, 'items.jsonl'))) {
        const id = stringField(item, 'id');
        const title = nullableStringField(item, 'text') ?? nullableStringField(item, 'title') ?? id;

        entries.push({
          kind: 'item',
          id,
          title,
          workspaceId,
          threadId: thread.id,
          searchText: [
            nullableStringField(item, 'text'),
            nullableStringField(item, 'title'),
            nullableStringField(item, 'description'),
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
    }
  }

  return entries;
}

/**
 * Removes existing derived-index files before rebuild.
 *
 * @param indexesRoot Derived index directory.
 * @returns Removed direct child names.
 */
function clearIndexDirectory(indexesRoot: string): string[] {
  mkdirSync(indexesRoot, { recursive: true });
  const removedEntries = readdirSync(indexesRoot).sort();

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
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Reads newline-delimited JSON records.
 *
 * @param path JSONL file path.
 * @returns Parsed JSON object records.
 */
function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Lists direct child directories in stable order.
 *
 * @param path Parent directory path.
 * @returns Directory names.
 */
function listDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path)
    .filter((name) => statSync(join(path, name)).isDirectory())
    .sort();
}

/**
 * Lists direct child files in stable order.
 *
 * @param path Parent directory path.
 * @returns File names.
 */
function listFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path)
    .filter((name) => statSync(join(path, name)).isFile())
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
 * Reads an optional string field from a record.
 *
 * @param record Source record.
 * @param field Field name.
 * @returns String field value, or null when absent.
 */
function nullableStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];

  return typeof value === 'string' && value.length > 0 ? value : null;
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
