import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  KnowledgeRetrievalTraceSchema,
  type ProductRetrievalTrace,
} from '@openkit/app-api-schemas';
import {
  formatReferenceUri,
  KnowledgeBaseIdSchema,
  KnowledgeOwnerScopeSchema,
  parseReferenceUri,
} from '@openkit/protocol';
import {
  type KnowledgeRetrievalAccess,
  readAuthorizedWorkspaceNotebookPages,
} from '../retrieval-knowledge-adapter.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { parseOkfDocument, stringListFrontmatterField, updateOkfFrontmatter } from './okf.js';

/** Reads all exact pages from one published commit, including reserved navigation. */
export function readPortableWorkspaceNotebookPages(workspaceRoot: string): {
  readonly notebookRevision: string;
  readonly nativeKnowledgePages: ReadonlyMap<string, string>;
} {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const revision = notebook.publishedRevision();
  const snapshot = notebook.readRevision(revision);
  return {
    notebookRevision: revision,
    nativeKnowledgePages: new Map(
      Object.entries(snapshot.files).map(([path, content]) => [`knowledge/pages/${path}`, content])
    ),
  };
}

/** Remints only owned scope and source fields; authored Markdown and other metadata remain intact. */
export function remintPortableWorkspaceNotebookPage(input: {
  readonly path: string;
  readonly content: string;
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly rewriteReferences: (references: readonly string[]) => readonly string[];
}): string {
  const parsed = parseOkfDocument({ path: input.path, content: input.content });
  if (!parsed.ok) throw new NotebookError('invalid_request');
  if (parsed.document.reserved) return input.content;
  const sourceReferences = stringListFrontmatterField(parsed.document, 'source_refs');
  if (sourceReferences === null) throw new NotebookError('invalid_request');
  const scope = KnowledgeOwnerScopeSchema.safeParse(parsed.document.frontmatter.scope);
  if (
    !scope.success ||
    scope.data.kind !== 'workspace' ||
    scope.data.workspaceId !== input.sourceWorkspaceId
  )
    throw new NotebookError('invalid_request');
  const rewritten = input.rewriteReferences(sourceReferences);
  const scopeChanged = input.sourceWorkspaceId !== input.targetWorkspaceId;
  const sourcesChanged = rewritten.some(
    (reference, index) => reference !== sourceReferences[index]
  );
  if (!scopeChanged && !sourcesChanged) return input.content;
  return updateOkfFrontmatter({
    path: input.path,
    content: input.content,
    updates: {
      ...(scopeChanged
        ? { scope: { kind: 'workspace', workspaceId: input.targetWorkspaceId } }
        : {}),
      ...(sourcesChanged ? { source_refs: [...rewritten] } : {}),
    },
  });
}

/** Computes exact page identity independently of Git commit identity. */
function pageDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Resolves a pinned page only when the supplied tree contains its exact source version. */
function pinnedNotebookPage(
  reference: string,
  files: Readonly<Record<string, string>>,
  scopeId: string
): string | null {
  const pin = parseReferenceUri(reference);
  if (!pin || pin.reference.scopeId !== scopeId || pin.contentDigest === undefined) return null;
  const content = files[`${pin.reference.objectId}.md`];
  if (content === undefined || pageDigest(content) !== pin.contentDigest)
    throw new Error('Portable Knowledge Page requires unavailable pinned source bytes.');
  return pin.reference.objectId;
}

/** Remints dependent exact page pins from leaf bytes before hashing their referring pages. */
export function remintPortableWorkspaceNotebookPages(input: {
  readonly pages: ReadonlyMap<string, string>;
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly sourceKnowledgeBaseId: string;
  readonly targetKnowledgeBaseId: string;
  readonly rewriteReferences: (references: readonly string[]) => readonly string[];
}): {
  readonly pages: ReadonlyMap<string, string>;
  readonly referenceReplacements: ReadonlyMap<string, string>;
} {
  const sourceScope = `page/workspace/${input.sourceWorkspaceId}/${KnowledgeBaseIdSchema.parse(input.sourceKnowledgeBaseId)}`;
  const targetScope = `page/workspace/${input.targetWorkspaceId}/${KnowledgeBaseIdSchema.parse(input.targetKnowledgeBaseId)}`;
  const files = importedWorkspaceNotebookFiles(input.pages);
  const reminted = new Map<string, string>();
  const active = new Set<string>();
  const remint = (path: string): string => {
    const retained = reminted.get(path);
    if (retained !== undefined) return retained;
    if (active.has(path)) throw new Error('Portable Knowledge Page pins contain a cycle.');
    active.add(path);
    const content = remintPortableWorkspaceNotebookPage({
      ...input,
      path,
      content: files[path]!,
      rewriteReferences: (references) => {
        const rewritten = input.rewriteReferences(references);
        return references.map((reference, index) => {
          const pageId = pinnedNotebookPage(reference, files, sourceScope);
          return pageId === null
            ? rewritten[index]!
            : formatReferenceUri(
                { scopeId: targetScope, objectId: pageId },
                pageDigest(remint(`${pageId}.md`))
              );
        });
      },
    });
    reminted.set(path, content);
    active.delete(path);
    return content;
  };
  for (const path of Object.keys(files)) remint(path);
  return {
    pages: new Map([...reminted].map(([path, content]) => [`knowledge/pages/${path}`, content])),
    referenceReplacements: new Map(
      [...reminted].map(([path, content]) => [
        formatReferenceUri(
          { scopeId: sourceScope, objectId: path.slice(0, -3) },
          pageDigest(files[path]!)
        ),
        formatReferenceUri(
          { scopeId: targetScope, objectId: path.slice(0, -3) },
          pageDigest(content)
        ),
      ])
    ),
  };
}

/** Supplies only exact target-tree page pins to initial validation, with no Review or work grant. */
export function importedWorkspaceNotebookReferences(
  files: Readonly<Record<string, string>>,
  scopeId: string
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(files).map(([path, content]) => {
      const parsed = parseOkfDocument({ path, content });
      if (!parsed.ok) throw new NotebookError('invalid_request');
      const refs = stringListFrontmatterField(parsed.document, 'source_refs');
      if (refs === null && !parsed.document.reserved) throw new NotebookError('invalid_request');
      return [
        path.slice(0, -3),
        new Set(
          (refs ?? []).filter((reference) => pinnedNotebookPage(reference, files, scopeId) !== null)
        ),
      ];
    })
  );
}

/** Converts the existing archive page map into the new target Notebook's initial tree. */
export function importedWorkspaceNotebookFiles(
  pages: ReadonlyMap<string, string>
): Readonly<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  for (const [path, content] of pages) {
    if (!path.startsWith('knowledge/pages/')) throw new NotebookError('invalid_request');
    files[path.slice('knowledge/pages/'.length)] = content;
  }
  return files;
}

/** Checks the complete selected archive tree under current Source and output authority before export. */
export function assertPortableWorkspaceNotebookDisclosure(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly notebookRevision: string;
  readonly pages: ReadonlyMap<string, string>;
  readonly access: KnowledgeRetrievalAccess;
}): void {
  const pageIds = [...input.pages.keys()]
    .map((path) => path.slice('knowledge/pages/'.length, -3))
    .filter((id) => !['index', 'log'].includes(id.split('/').at(-1)!));
  const admitted = readAuthorizedWorkspaceNotebookPages({
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    notebookRevision: input.notebookRevision,
    pageIds,
    access: input.access,
  });
  for (const page of admitted.pages) {
    if (input.pages.get(`knowledge/pages/${page.path}`) !== page.content)
      throw new NotebookError('recovery_required');
  }
}

/** Binds reminted current-tree selections only after the target Notebook actually exists. */
export function bindImportedWorkspaceNotebookTraces(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly knowledgeBaseId: string;
  readonly traces: ReadonlyMap<string, ProductRetrievalTrace>;
}): ReadonlyMap<string, ProductRetrievalTrace> {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(input.workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const revision = notebook.publishedRevision();
  const { files } = notebook.readRevision(revision);
  return new Map(
    [...input.traces].map(([path, trace]) => {
      if (
        'sourceKind' in trace ||
        trace.sourceScope !==
          `page/workspace/${input.workspaceId}/${KnowledgeBaseIdSchema.parse(input.knowledgeBaseId)}`
      )
        return [path, trace];
      const bind = <
        T extends {
          reference: { objectId: string };
          contentDigest: string | null;
          revision: string | null;
        },
      >(
        entry: T
      ): T => {
        if (entry.contentDigest !== null) {
          const content = files[`${entry.reference.objectId}.md`];
          if (content === undefined || entry.contentDigest !== pageDigest(content))
            throw new NotebookError('invalid_request');
        }
        return { ...entry, revision: entry.revision === null ? null : revision };
      };
      return [
        path,
        KnowledgeRetrievalTraceSchema.parse({
          ...trace,
          notebookRevision: revision,
          selected: trace.selected.map(bind),
          excluded: trace.excluded.map(bind),
        }),
      ];
    })
  );
}
