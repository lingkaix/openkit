import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Actor } from '../auth/identity.js';
import type { CoreDb, UserDb } from '../storage/db.js';
import {
  appendMemorySuppression,
  assertMemoryPagesNotSuppressed,
  MemoryPageUnavailableError,
  readMemorySuppressions,
} from './memory-maintenance.js';
import { KnowledgeNotebook, NotebookError, validateNotebookFiles } from './notebook.js';
import {
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringFrontmatterField,
  stringListFrontmatterField,
} from './okf.js';
import { admitUserMemorySources } from './scoped-knowledge-sources.js';
import {
  pinScopedNotebook,
  resolveScopedNotebookOwner,
  ScopedNotebookAccessError,
} from './scoped-notebook-owner.js';
import { publishScopedNotebook } from './scoped-notebook-publication.js';

/** Internal direct-human self context. No caller-selected User, Worker context or output audience is admitted. */
export interface MemoryContext {
  readonly coreDb: CoreDb;
  readonly userDb: UserDb;
  readonly actor: Actor | undefined;
}

/** One explicit authored page change at an immutable Notebook base. Page text is a complete governed OKF document. */
interface MemoryPageChange {
  readonly requestId: string;
  readonly baseRevision: string;
  readonly pageId: string;
  readonly content: string;
  readonly summary: string;
}

/** Admitted self context plus the existing scoped publisher's native write dependencies. */
export type MemoryWriter = MemoryContext &
  Omit<Parameters<typeof publishScopedNotebook>[0], 'actor' | 'coreDb' | 'target' | 'userDb'>;

/** Resolves actual self authority before any owner path, page identity or content is inspected. */
export function admitMemoryContext(input: MemoryContext) {
  const context = {
    coreDb: input.coreDb,
    actor: input.actor ? { ...input.actor } : undefined,
    target: { kind: 'user' as const },
  };
  const owner = resolveScopedNotebookOwner(context);
  if (
    input.userDb.userId !== context.actor!.userId ||
    resolve(input.userDb.dataRoot) !== resolve(input.coreDb.dataRoot)
  )
    throw new ScopedNotebookAccessError();
  return { ...owner, context };
}

/** Restricts identities to safe nonreserved governed page paths, without permitting rename or raw Git paths. */
function pathFor(pageId: string): string {
  if (typeof pageId !== 'string') throw new NotebookError('invalid_request');
  const path = `${pageId}.md`;
  validateNotebookFiles({ [path]: '' }, true);
  if (parseOkfDocument({ path, content: '' }).document?.reserved)
    throw new NotebookError('invalid_request');
  return path;
}

/** Filters published Memory states and literal Source grammar; current scope, Source and suppression checks remain separate. */
export function memoryPageFacts(path: string, content: string) {
  const parsed = parseOkfDocument({ path, content });
  if (!parsed.ok) throw new NotebookError('recovery_required');
  if (parsed.document.reserved) return null;
  const sensitivity = stringFrontmatterField(parsed.document, 'sensitivity');
  if (!sensitivity || !['public', 'normal', 'internal', 'confidential'].includes(sensitivity))
    return null;
  if (
    !['user-authored', 'delegated', 'accepted'].includes(
      stringFrontmatterField(parsed.document, 'review_state') ?? ''
    )
  )
    return null;
  const sources = stringListFrontmatterField(parsed.document, 'source_refs');
  if (
    !sources ||
    sources.some(
      (reference) => !resolveRegisteredKnowledgeSourceReference(reference, new Map()).targetId
    )
  )
    return null;
  return {
    id: parsed.document.conceptId,
    path,
    title: stringFrontmatterField(parsed.document, 'title'),
    sensitivity,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

/** Lists only currently authorized personally authored unsuppressed metadata after current literal Source admission. */
export function listMemoryPages(input: MemoryContext) {
  const owner = admitMemoryContext(input);
  const pinned = pinScopedNotebook(owner.context);
  const suppressed = new Set(
    readMemorySuppressions(owner.notebookRoot, input.userDb.userId).map(
      ({ payload }) => payload.pageId
    )
  );
  const pages = Object.entries(pinned.read().files).flatMap(([path, content]) => {
    if (suppressed.has(path.slice(0, -3))) return [];
    const facts = memoryPageFacts(path, content);
    if (facts) {
      try {
        admitUserMemorySources(input, { [path]: content });
      } catch (error) {
        if (error instanceof NotebookError && error.code === 'invalid_request') return [];
        throw error;
      }
    }
    return facts ? [facts] : [];
  });
  admitMemoryContext(input);
  return { notebookRevision: pinned.notebookRevision, pages };
}

/** Reads the current exact page only after self, suppression, authored state, sensitivity and current literal Source admission. */
export function readMemoryPage(input: MemoryContext, pageId: string) {
  const owner = admitMemoryContext(input);
  const path = pathFor(pageId);
  if (
    readMemorySuppressions(owner.notebookRoot, input.userDb.userId).some(
      (row) => row.payload.pageId === pageId
    )
  )
    return null;
  const pinned = pinScopedNotebook(owner.context);
  const content = pinned.read().files[path];
  if (content === undefined) return null;
  const facts = memoryPageFacts(path, content);
  if (facts) {
    try {
      admitUserMemorySources(input, { [path]: content });
    } catch (error) {
      if (error instanceof NotebookError && error.code === 'invalid_request') return null;
      throw error;
    }
  }
  admitMemoryContext(input);
  return facts ? { ...facts, notebookRevision: pinned.notebookRevision, content } : null;
}

/** Preserves the original exact command bytes while joining explicit human save/edit to the common scoped publisher. */
async function changeMemoryPage(input: MemoryWriter, change: MemoryPageChange, existing: boolean) {
  const request = { ...change };
  const owner = admitMemoryContext(input);
  const path = pathFor(request.pageId);
  assertMemoryPagesNotSuppressed(owner.notebookRoot, input.userDb.userId, [path]);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const base = notebook.readRevision(request.baseRevision).files[path];
  if ((base !== undefined) !== existing || (base !== undefined && !memoryPageFacts(path, base)))
    throw new NotebookError('invalid_request');
  validateNotebookFiles({ [path]: request.content }, true);
  if (!memoryPageFacts(path, request.content)) throw new NotebookError('invalid_request');
  if (base !== undefined) admitUserMemorySources(input, { [path]: base });
  admitUserMemorySources(input, { [path]: request.content });
  return publishScopedNotebook(
    { ...input, target: { kind: 'user' } },
    {
      requestId: request.requestId,
      baseRevision: request.baseRevision,
      changes: [{ path, content: request.content }],
      summary: request.summary,
    }
  );
}

/** Explicit save requires a new identity at its fixed base; a forgotten identity remains reserved. */
export function saveMemoryPage(input: MemoryWriter, change: MemoryPageChange) {
  return changeMemoryPage(input, change, false);
}

/** Explicit edit retains one published identity and uses the exact admitted base, never automatic rebase. */
export function editMemoryPage(input: MemoryWriter, change: MemoryPageChange) {
  return changeMemoryPage(input, change, true);
}

/**
 * Internal suppression primitive for the Item-confirmed forget owner, not a confirmation grant.
 *
 * It binds current exact revision/digest, retains no prose and makes the page unavailable before any later Git/index cleanup. Git/evidence/backup bytes remain separately retained; this is not physical erasure. The caller must bind the existing human grant before using this primitive.
 */
export function recordMemorySuppression(
  input: MemoryContext,
  request: {
    readonly requestId: string;
    readonly pageId: string;
    readonly notebookRevision: string;
    readonly digest: string;
  }
) {
  const owner = admitMemoryContext(input);
  pathFor(request.pageId);
  const rows = readMemorySuppressions(owner.notebookRoot, input.userDb.userId);
  const previous = rows.find((row) => row.id === request.requestId);
  if (previous) {
    if (
      previous.payload.pageId !== request.pageId ||
      previous.payload.lastRevision !== request.notebookRevision ||
      previous.payload.digest !== request.digest
    )
      throw new NotebookError('invalid_request');
    return previous;
  }
  if (rows.some((row) => row.payload.pageId === request.pageId))
    throw new MemoryPageUnavailableError();
  const page = readMemoryPage(input, request.pageId);
  if (!page || page.notebookRevision !== request.notebookRevision || page.digest !== request.digest)
    throw new NotebookError('conflict');
  admitMemoryContext(input);
  return appendMemorySuppression(owner.notebookRoot, {
    userId: input.userDb.userId,
    pageId: request.pageId,
    lastRevision: request.notebookRevision,
    digest: request.digest,
    requestId: request.requestId,
    actorId: input.actor!.userId,
    sourceFingerprints: admitUserMemorySources(input, { [`${page.id}.md`]: page.content })
      .sourceFingerprints,
  });
}
