import { posix } from 'node:path';
import { compareCodeUnits } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  isActiveOpenKitKnowledgePage,
  type KnowledgeConformance,
  type KnowledgeValidationError,
  knowledgeReferenceErrors,
  type OkfDocument,
  parseKnowledgePageSourceReference,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  resolveRegisteredKnowledgeSourceReference,
  type ScopeKnowledgeSchema,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateKnowledgePageCandidate,
} from './okf.js';

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

/** Content-only projection inputs; neither the current head nor caller authority is selected here. */
export interface NotebookIndexProjectionInput {
  readonly pages: ReadonlyMap<string, string>;
  readonly pageScopeId: string;
  readonly scopeSchemaText?: string | undefined;
  readonly registeredSources: ReadonlyMap<string, string | null>;
}

/** Reuses the one validation/reference/link implementation without reading or publishing an index. */
export function projectWorkspaceKnowledgeIndexes(input: NotebookIndexProjectionInput): {
  records: WorkspaceKnowledgeValidationRecord[];
  references: WorkspaceKnowledgeSourceReference[];
  edges: WorkspaceKnowledgeLinkEdge[];
} {
  return {
    records: buildKnowledgeValidationRecords(input),
    references: buildKnowledgeSourceReferences(input),
    edges: buildKnowledgeLinkEdges(input),
  };
}

/**
 * Reads Knowledge ids from one pinned Notebook tree.
 *
 * @param pages Exact page bytes from one Notebook revision.
 * @returns Knowledge ids available for canonical same-base Page references.
 */
export function readKnowledgePageIds(pages: ReadonlyMap<string, string>): Set<string> {
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

/** Checks only exact same-base page bytes in the selected Notebook tree; native retrieval still owns current access. */
export function verifiedKnowledgePageSourceReferences(
  references: readonly string[],
  pages: ReadonlyMap<string, string>,
  pageScopeId: string
): ReadonlySet<string> {
  return new Set(
    references.filter((reference) => {
      const parsed = parseKnowledgePageSourceReference(reference, pageScopeId);
      if (!parsed) return false;
      const content = pages.get(parsed.reference.objectId);
      return (
        content !== undefined &&
        (parsed.contentDigest === undefined ||
          `sha256:${sha256Hex(content)}` === parsed.contentDigest)
      );
    })
  );
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
  resolvedReferences?: ReadonlySet<string>,
  pageScopeId?: string
): boolean {
  if (stringListFrontmatterField(document, 'source_refs') === null) {
    return false;
  }

  return (
    knowledgeReferenceErrors(
      document,
      registeredSources,
      knowledgeIds,
      resolvedReferences,
      pageScopeId
    ).length === 0
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
 * @param pageScopeId Exact retained Workspace page collection.
 * @param resolvedReferences Page references verified against the exact selected tree.
 * @returns True only for an active, valid, directly user-authored Page.
 */
function isStaticKnowledgeIndexPage(
  document: OkfDocument,
  schema: ScopeKnowledgeSchema,
  registeredSources: ReadonlyMap<string, string | null>,
  knowledgeIds: ReadonlySet<string>,
  pageScopeId: string,
  resolvedReferences: ReadonlySet<string>
): boolean {
  return (
    stringFrontmatterField(document, 'review_state') === 'user-authored' &&
    isActiveOpenKitKnowledgePage(document, schema) &&
    sourceReferencesResolve(
      document,
      registeredSources,
      knowledgeIds,
      resolvedReferences,
      pageScopeId
    )
  );
}

/**
 * Builds validation report records for file-backed knowledge pages.
 *
 * @param input Exact pinned Page/Source bytes and proposed or current schema.
 * @returns Validation records for knowledge pages.
 */
function buildKnowledgeValidationRecords({
  pages,
  pageScopeId,
  scopeSchemaText,
  registeredSources,
}: NotebookIndexProjectionInput): WorkspaceKnowledgeValidationRecord[] {
  const knowledgeIds = readKnowledgePageIds(pages);
  const records: WorkspaceKnowledgeValidationRecord[] = [];

  for (const [knowledgePageId, content] of pages) {
    const path = `knowledge/pages/${knowledgePageId}.md`;
    const workspacePath = `knowledge/pages/${knowledgePageId}.md`;
    const contentDigest = `sha256:${sha256Hex(content)}`;
    const parsed = parseOkfDocument({ path, content });

    const report = validateKnowledgePageCandidate({
      pageScopeId,
      resolvedReferences: verifiedKnowledgePageSourceReferences(
        parsed.document ? (stringListFrontmatterField(parsed.document, 'source_refs') ?? []) : [],
        pages,
        pageScopeId
      ),
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

  return records.sort((left, right) => compareCodeUnits(left.conceptId, right.conceptId));
}

/**
 * Builds source-reference index records for parseable file-backed knowledge pages.
 *
 * @param input Exact pinned Page/Source bytes and proposed or current schema.
 * @returns Source-reference records declared by knowledge pages.
 */
function buildKnowledgeSourceReferences({
  pages,
  pageScopeId,
  registeredSources,
}: NotebookIndexProjectionInput): WorkspaceKnowledgeSourceReference[] {
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
    const resolvedReferences = verifiedKnowledgePageSourceReferences(
      sourceRefs,
      pages,
      pageScopeId
    );

    for (const reference of sourceRefs) {
      references.push(
        classifyKnowledgeSourceReference({
          conceptId,
          path: workspacePath,
          reference,
          registeredSources,
          knowledgeIds,
          pageScopeId,
          resolvedReferences,
        })
      );
    }
  }

  return references.sort((left, right) =>
    compareCodeUnits(
      `${left.conceptId}\u0000${left.reference}`,
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
  /** Exact current Workspace page collection. */
  pageScopeId: string;
  /** Page references verified against the exact selected tree. */
  resolvedReferences: ReadonlySet<string>;
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

  if (input.reference.startsWith('openkit:')) {
    const targetId =
      parseKnowledgePageSourceReference(input.reference, input.pageScopeId)?.reference.objectId ??
      null;

    return {
      conceptId: input.conceptId,
      path: input.path,
      reference: input.reference,
      kind: 'workspace-knowledge',
      targetId,
      resolved:
        targetId !== null &&
        input.knowledgeIds.has(targetId) &&
        input.resolvedReferences.has(input.reference),
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
      input.knowledgeIds,
      input.resolvedReferences,
      input.pageScopeId
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
 * @param input Exact pinned Page/Source bytes and proposed or current schema.
 * @returns Directed knowledge link edges.
 */
function buildKnowledgeLinkEdges({
  pages,
  pageScopeId,
  scopeSchemaText,
  registeredSources,
}: NotebookIndexProjectionInput): WorkspaceKnowledgeLinkEdge[] {
  const parsedSchema = scopeSchemaText ? parseScopeKnowledgeSchema(scopeSchemaText) : null;
  const schema = parsedSchema
    ? parsedSchema.ok
      ? parsedSchema.schema
      : null
    : DEFAULT_SCOPE_KNOWLEDGE_SCHEMA;
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
      !isStaticKnowledgeIndexPage(
        parsed.document,
        schema,
        registeredSources,
        knowledgeIds,
        pageScopeId,
        verifiedKnowledgePageSourceReferences(
          stringListFrontmatterField(parsed.document, 'source_refs') ?? [],
          pages,
          pageScopeId
        )
      )
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
    compareCodeUnits(`${left.fromId}\u0000${left.target}`, `${right.fromId}\u0000${right.target}`)
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
