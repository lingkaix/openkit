import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KnowledgeNotebookDiffRequestSchema,
  KnowledgeNotebookHistoryRequestSchema,
  RestoreKnowledgeNotebookRequestSchema,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
import {
  admitMemoryContext,
  type MemoryContext,
  type MemoryWriter,
  memoryPageFacts,
} from './memory-lifecycle.js';
import {
  assertMemoryPagesNotSuppressed,
  MemoryPageUnavailableError,
} from './memory-maintenance.js';
import { KnowledgeNotebook, NotebookError, validateNotebookFiles } from './notebook.js';
import { boundedNotebookDiff } from './notebook-history.js';
import {
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  stringListFrontmatterField,
  validateScopeKnowledgeSchema,
} from './okf.js';
import { admitUserMemorySources } from './scoped-knowledge-sources.js';
import { publishScopedNotebook } from './scoped-notebook-publication.js';

const RestoreRequestSchema = RestoreKnowledgeNotebookRequestSchema.omit({
  confirmRemoval: true,
}).extend({ pageIds: RestoreKnowledgeNotebookRequestSchema.shape.pageIds.optional() });

type HistoryRequest = z.infer<typeof KnowledgeNotebookHistoryRequestSchema>;
type DiffRequest = z.infer<typeof KnowledgeNotebookDiffRequestSchema>;
type RestoreRequest = z.infer<typeof RestoreRequestSchema>;
type Change = { path: string; before: string | null; after: string | null };

/** Reads one current self-owned notebook without granting access to any other owner or Source. */
class AuthorizedMemoryHistory {
  readonly notebook: KnowledgeNotebook;

  constructor(readonly context: MemoryContext) {
    const owner = admitMemoryContext(context);
    this.notebook = new KnowledgeNotebook({
      repositoryPath: join(owner.notebookRoot, 'notebook.git'),
    });
  }

  /** Current suppression precedes historical bytes; current schema and personal admission precede disclosure. */
  read(revision: string, paths: readonly string[]): Readonly<Record<string, string>> {
    const owner = admitMemoryContext(this.context);
    assertMemoryPagesNotSuppressed(owner.notebookRoot, this.context.userDb.userId, paths);
    let schemaText: string;
    try {
      schemaText = readFileSync(join(owner.notebookRoot, 'schema', 'scope-schema.yaml'), 'utf8');
    } catch {
      throw new NotebookError('recovery_required');
    }
    const schema = parseScopeKnowledgeSchema(schemaText);
    if (!schema.ok) throw new NotebookError('recovery_required');
    const selected = this.notebook.readRevision(revision, paths);
    validateNotebookFiles(selected.files, true);
    for (const [path, content] of Object.entries(selected.files)) {
      const parsed = parseOkfDocument({ path, content });
      if (!parsed.ok) throw new NotebookError('recovery_required');
      if (parsed.document.reserved) {
        const sources = stringListFrontmatterField(parsed.document, 'source_refs');
        if (
          sources?.length ||
          (sources === null && Object.hasOwn(parsed.document.frontmatter, 'source_refs'))
        )
          throw new MemoryPageUnavailableError();
        continue;
      }
      if (!memoryPageFacts(path, content)) throw new MemoryPageUnavailableError();
      const report = validateScopeKnowledgeSchema(parsed.document, schema.schema, owner.ownerScope);
      if (report.conformance !== 'scope-schema-valid' || report.errors.length)
        throw new NotebookError('recovery_required');
    }
    try {
      admitUserMemorySources(this.context, selected.files);
    } catch (error) {
      if (error instanceof NotebookError && error.code === 'invalid_request')
        throw new MemoryPageUnavailableError();
      throw error;
    }
    admitMemoryContext(this.context);
    assertMemoryPagesNotSuppressed(owner.notebookRoot, this.context.userDb.userId, paths);
    return selected.files;
  }

  /** Compares only published ancestors and admits both sides before returning paths or text. */
  diff(input: Pick<DiffRequest, 'baseRevision' | 'fromRevision' | 'pageIds'>): Change[] {
    admitMemoryContext(this.context);
    this.notebook.history({ revision: input.baseRevision, limit: 1 });
    this.notebook.history({ revision: input.fromRevision, limit: 1 });
    const base = this.notebook.inspectRevision(input.baseRevision).entries;
    const target = this.notebook.inspectRevision(input.fromRevision).entries;
    const paths =
      input.pageIds?.map((id) => `${id}.md`) ??
      [...new Set([...Object.keys(base), ...Object.keys(target)])]
        .filter((path) => base[path] !== target[path])
        .sort();
    if (paths.length > 256) throw new NotebookError('invalid_request');
    if (paths.some((path) => !Object.hasOwn(base, path) && !Object.hasOwn(target, path)))
      throw new MemoryPageUnavailableError();
    const before = this.read(
      input.baseRevision,
      paths.filter((path) => Object.hasOwn(base, path))
    );
    const after = this.read(
      input.fromRevision,
      paths.filter((path) => Object.hasOwn(target, path))
    );
    admitMemoryContext(this.context);
    return paths
      .filter((path) => before[path] !== after[path])
      .map((path) => ({
        path,
        before: before[path] ?? null,
        after: after[path] ?? null,
      }));
  }
}

/** Lists published Memory revisions, withholding all descriptive metadata for unavailable changed content. */
export function readMemoryHistory(input: MemoryContext, request: HistoryRequest) {
  const parsed = KnowledgeNotebookHistoryRequestSchema.safeParse(request);
  if (!parsed.success) throw new NotebookError('invalid_request');
  const history = new AuthorizedMemoryHistory(input);
  const notebookRevision = history.notebook.publishedRevision();
  const selected = history.notebook.history({
    ...(parsed.data.revision === undefined ? {} : { revision: parsed.data.revision }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  });
  const revisions = selected.revisions.map((entry) => {
    const identity = { revision: entry.revision, parentRevision: entry.parentRevision };
    try {
      const changedPaths = entry.parentRevision
        ? history
            .diff({ baseRevision: entry.parentRevision, fromRevision: entry.revision })
            .map(({ path }) => path)
        : Object.keys(
            history.read(
              entry.revision,
              Object.keys(history.notebook.inspectRevision(entry.revision).entries)
            )
          ).sort();
      return {
        ...identity,
        availability: 'available' as const,
        summary: entry.metadata.summary,
        producer: entry.metadata.producer,
        changedPaths,
      };
    } catch (error) {
      if (!(error instanceof MemoryPageUnavailableError)) throw error;
      return { ...identity, availability: 'unavailable' as const };
    }
  });
  admitMemoryContext(input);
  return { notebookRevision, revisions, nextRevision: selected.nextRevision };
}

/** Returns a bounded exact historical comparison; a restore preview must fit the complete display bound. */
export function diffMemoryHistory(input: MemoryContext, request: DiffRequest) {
  const parsed = KnowledgeNotebookDiffRequestSchema.safeParse(request);
  if (!parsed.success) throw new NotebookError('invalid_request');
  const history = new AuthorizedMemoryHistory(input);
  return {
    baseRevision: parsed.data.baseRevision,
    fromRevision: parsed.data.fromRevision,
    forRestore: parsed.data.forRestore === true,
    ...boundedNotebookDiff(history.diff(parsed.data), parsed.data.forRestore === true),
  };
}

/** Publishes selected historical text at the current fixed base; removal and suppressed identities cannot pass restore. */
export async function restoreMemoryHistory(input: MemoryWriter, request: RestoreRequest) {
  const parsed = RestoreRequestSchema.safeParse(request);
  if (!parsed.success) throw new NotebookError('invalid_request');
  const history = new AuthorizedMemoryHistory(input);
  const { changes } = boundedNotebookDiff(history.diff(parsed.data), true);
  if (changes.some(({ after }) => after === null)) throw new NotebookError('invalid_request');
  return publishScopedNotebook(
    {
      ...input,
      target: { kind: 'user' },
      command: { name: 'knowledge.notebook.restore', input: parsed.data },
    },
    {
      requestId: parsed.data.requestId,
      baseRevision: parsed.data.baseRevision,
      changes: changes.map(({ path, after }) => ({ path, content: after })),
      summary: parsed.data.summary,
    }
  );
}
