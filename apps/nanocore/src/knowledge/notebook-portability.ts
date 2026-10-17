import { createHash } from 'node:crypto';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { type KnowledgeNotebook, type NotebookCommitMetadata, NotebookError } from './notebook.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import {
  parseOkfDocument,
  stringListFrontmatterField,
  updateOkfFrontmatter,
  validateOpenKitKnowledgeProfile,
} from './okf.js';

const PAGE_PREFIX = 'knowledge/pages/';

/** Exact page-byte observation; an archived commit id is provenance, never target authority. */
export interface PortableNotebookPageProof {
  readonly revision: string;
  readonly contentDigest: string;
}

/** Complete current-page collection in the existing Workspace portable-file map shape. */
export interface PortableNotebookTree {
  readonly sourceRevision: string;
  readonly nativeKnowledgePages: ReadonlyMap<string, string>;
  readonly pageProofs: ReadonlyMap<string, PortableNotebookPageProof>;
}

/** SHA-256 of exact UTF-8 page bytes, independent of Git's object encoding. */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Reads a complete pinned published tree after checking the existing complete Git graph.
 * Unrelated retained graph corruption also refuses export; no candidate enters the returned tree.
 * Callers retain current disclosure, suppression and snapshot-fence duties.
 */
export function readPortableNotebookTree(input: {
  readonly notebook: KnowledgeNotebook;
}): PortableNotebookTree {
  const { publishedRevision } = input.notebook.validateRetainedGraph();
  const snapshot = input.notebook.readRevision(publishedRevision);
  const nativeKnowledgePages = new Map<string, string>();
  const pageProofs = new Map<string, PortableNotebookPageProof>();
  for (const path of Object.keys(snapshot.files).sort()) {
    const content = snapshot.files[path]!;
    nativeKnowledgePages.set(`${PAGE_PREFIX}${path}`, content);
    pageProofs.set(path.slice(0, -3), {
      revision: publishedRevision,
      contentDigest: contentDigest(content),
    });
  }
  return { sourceRevision: publishedRevision, nativeKnowledgePages, pageProofs };
}

/** Verifies one published-history page against actual Git bytes, without claiming current permission. */
export function verifyNotebookPageProof(input: {
  readonly notebook: KnowledgeNotebook;
  readonly revision: string;
  readonly pageId: string;
  readonly contentDigest: string;
}): string {
  // A matching page digest cannot authenticate corrupt commit/tree objects around that page.
  input.notebook.validateRetainedGraph();
  input.notebook.history({ revision: input.revision, limit: 1 });
  const path = `${input.pageId}.md`;
  const content = input.notebook.readRevision(input.revision, [path]).files[path]!;
  if (contentDigest(content) !== input.contentDigest) throw new NotebookError('invalid_request');
  return content;
}

/**
 * Rebuilds current pages as one fresh target Git notebook after reference reminting.
 * Archive proofs assert byte consistency only; no source Git object, historical decision or grant is imported.
 *
 * @param input Complete source pages/proofs, current target validation facts and fresh target command metadata.
 * @returns New target revision/proofs and source provenance for the shared import owner.
 * @throws NotebookError before initialization when source proofs or reminted content are invalid.
 */
export function importPortableNotebookTree(
  input: PortableNotebookTree & {
    readonly notebook: KnowledgeNotebook;
    readonly sourceOwnerScope: KnowledgeOwnerScope;
    readonly targetOwnerScope: KnowledgeOwnerScope;
    readonly rewriteSourceReferences: (
      references: readonly string[],
      pageId: string
    ) => readonly string[];
    readonly scopeSchemaText: string;
    readonly registeredSources: ReadonlyMap<string, string | null>;
    readonly resolvedReferences: ReadonlyMap<string, ReadonlySet<string>>;
    readonly metadata: NotebookCommitMetadata;
  }
): {
  readonly sourceRevision: string;
  readonly revision: string;
  readonly pageProofs: ReadonlyMap<string, PortableNotebookPageProof>;
} {
  const files: Record<string, string> = Object.create(null);
  try {
    // This validates the shape of an inert source commit claim, not its Git ancestry.
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sourceRevision))
      throw new NotebookError('invalid_request');
    if (input.nativeKnowledgePages.size !== input.pageProofs.size)
      throw new NotebookError('invalid_request');
    for (const [path, original] of input.nativeKnowledgePages) {
      if (!path.startsWith(PAGE_PREFIX) || !path.endsWith('.md') || typeof original !== 'string')
        throw new NotebookError('invalid_request');
      const bundlePath = path.slice(PAGE_PREFIX.length);
      const pageId = bundlePath.slice(0, -3);
      const proof = input.pageProofs.get(pageId);
      if (
        !proof ||
        proof.revision !== input.sourceRevision ||
        proof.contentDigest !== contentDigest(original)
      )
        throw new NotebookError('invalid_request');
      const parsed = parseOkfDocument({ path: bundlePath, content: original });
      if (!parsed.ok) throw new NotebookError('invalid_request');
      if (parsed.document.reserved) {
        files[bundlePath] = original;
        continue;
      }
      const sourceProfile = validateOpenKitKnowledgeProfile(
        parsed.document,
        input.sourceOwnerScope
      );
      const references = stringListFrontmatterField(parsed.document, 'source_refs');
      if (sourceProfile.conformance !== 'OpenKit-profile-valid' || references === null)
        throw new NotebookError('invalid_request');
      files[bundlePath] = updateOkfFrontmatter({
        path: bundlePath,
        content: original,
        updates: {
          scope: input.targetOwnerScope,
          source_refs: [...input.rewriteSourceReferences(references, pageId)],
        },
      });
    }
    if (!Object.hasOwn(files, 'index.md')) throw new NotebookError('invalid_request');
    const validation = validateNotebookCandidate({
      ownerScope: input.targetOwnerScope,
      base: { files: {} },
      candidate: { files },
      scopeSchemaText: input.scopeSchemaText,
      registeredSources: input.registeredSources,
      resolvedReferences: input.resolvedReferences,
    });
    const metadataReferences = [...new Set(input.metadata.sourceReferences)].sort();
    if (
      validation.errors.length > 0 ||
      validation.diagnosticsTruncated ||
      JSON.stringify(metadataReferences) !== JSON.stringify(validation.sourceReferences)
    )
      throw new NotebookError('invalid_request');
  } catch (error) {
    if (error instanceof NotebookError) throw error;
    throw new NotebookError('invalid_request');
  }
  // initialize owns path/UTF-8 validation and refuses an existing target before changing it.
  const revision = input.notebook.initialize({ files, metadata: input.metadata });
  const pageProofs = new Map<string, PortableNotebookPageProof>();
  for (const [path, content] of Object.entries(files)) {
    pageProofs.set(path.slice(0, -3), { revision, contentDigest: contentDigest(content) });
  }
  return { sourceRevision: input.sourceRevision, revision, pageProofs };
}
