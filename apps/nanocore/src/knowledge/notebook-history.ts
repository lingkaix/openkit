import { join } from 'node:path';
import {
  type KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  KNOWLEDGE_NOTEBOOK_DIFF_TEXT_LIMIT_BYTES,
  RestoreKnowledgeNotebookResponseSchema,
} from '@openkit/app-api-schemas';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import {
  type KnowledgeRetrievalAccess,
  readAuthorizedWorkspaceNotebookPages,
} from '../retrieval-knowledge-adapter.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { humanPageBytes, publishWorkspaceNotebook } from './notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';

/** Existing native authority and publication dependencies; no history-owned state is retained. */
type Dependencies = Pick<
  OperationInvocationDependencies,
  | 'store'
  | 'coreDb'
  | 'repositoryWorkspaceDb'
  | 'inflightCommands'
  | 'runtimeConfigManager'
  | 'workspaceMutationAdmission'
>;
type Handlers = Pick<
  FamilyImplementations<typeof KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS>,
  'knowledge.notebook.history' | 'knowledge.notebook.diff' | 'knowledge.notebook.restore'
>;
type Selection = {
  baseRevision: string;
  fromRevision: string;
  pageIds?: readonly string[] | undefined;
};
type Change = { path: string; before: string | null; after: string | null };

/** Bound display text without changing retained bytes or using a partial destructive confirmation. */
export function boundedNotebookDiff(changes: Change[], requireComplete: boolean) {
  const bytes = changes.reduce(
    (size, { before, after }) =>
      size + Buffer.byteLength(before ?? '') + Buffer.byteLength(after ?? ''),
    0
  );
  const truncated = bytes > KNOWLEDGE_NOTEBOOK_DIFF_TEXT_LIMIT_BYTES;
  if (truncated && requireComplete)
    throw new OperationError(
      'invalid_request',
      'Selected Notebook diff exceeds the 64 KiB display limit. Select fewer pages.',
      400
    );
  let remaining = KNOWLEDGE_NOTEBOOK_DIFF_TEXT_LIMIT_BYTES;
  const prefix = (text: string | null): string | null => {
    if (text === null) return null;
    const bytes = Buffer.from(text);
    let end = Math.min(bytes.length, remaining);
    // An output prefix must end between UTF-8 code points, not inside continuation bytes.
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    remaining -= end;
    return bytes.subarray(0, end).toString('utf8');
  };
  return {
    truncated,
    changes: truncated
      ? changes.map(({ path, before, after }) => ({
          path,
          before: prefix(before),
          after: prefix(after),
        }))
      : changes,
  };
}

/** One immutable inventory pair, with bodies obtained only through the current canonical reader. */
class AuthorizedHistory {
  constructor(
    readonly notebook: KnowledgeNotebook,
    readonly dataRoot: string,
    readonly workspaceId: string,
    readonly access: KnowledgeRetrievalAccess
  ) {
    this.read(notebook.publishedRevision(), []);
  }

  /** Read each selected existing path under current source and destination authority. */
  private read(revision: string, paths: readonly string[]): Map<string, string> {
    const result = readAuthorizedWorkspaceNotebookPages({
      dataRoot: this.dataRoot,
      workspaceId: this.workspaceId,
      access: this.access,
      notebookRevision: revision,
      pageIds: paths.map((path) => path.slice(0, -3)),
    });
    if (
      result.pages.reduce((size, page) => size + Buffer.byteLength(page.content), 0) >
      32 * 1024 * 1024
    )
      throw new NotebookError('invalid_request');
    return new Map(result.pages.map(({ path, content }) => [path, content]));
  }

  /** Compare published ancestry only; an unpublished Proposal commit is never a history target. */
  diff(input: Selection, forRestore = false): Change[] {
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
      throw new OperationError('workspace_access_denied', 'Knowledge page is unavailable.', 403);
    const before = this.read(
      input.baseRevision,
      paths.filter((path) => Object.hasOwn(base, path))
    );
    const after = this.read(
      input.fromRevision,
      paths.filter((path) => Object.hasOwn(target, path))
    );
    return paths
      .filter((path) => before.get(path) !== after.get(path))
      .map((path) => {
        const target = after.get(path);
        return {
          path,
          before: before.get(path) ?? null,
          after:
            target === undefined
              ? null
              : forRestore
                ? humanPageBytes(path, target, this.workspaceId)
                : target,
        };
      });
  }

  /** Redact metadata when the commit's complete changed disclosure closure is unavailable now. */
  history(input: { revision?: string | undefined; limit?: number | undefined }) {
    const notebookRevision = this.notebook.publishedRevision();
    const history = this.notebook.history({
      ...(input.revision ? { revision: input.revision } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    const revisions = history.revisions.map((revision) => {
      const identity = { revision: revision.revision, parentRevision: revision.parentRevision };
      try {
        let changedPaths: string[];
        if (revision.parentRevision) {
          changedPaths = this.diff({
            baseRevision: revision.parentRevision,
            fromRevision: revision.revision,
          }).map(({ path }) => path);
        } else {
          changedPaths = Object.keys(
            this.notebook.inspectRevision(revision.revision).entries
          ).sort();
          this.read(revision.revision, changedPaths);
        }
        return {
          ...identity,
          availability: 'available' as const,
          summary: revision.metadata.summary,
          producer: revision.metadata.producer,
          changedPaths,
        };
      } catch (error) {
        if (!(error instanceof OperationError) || error.status !== 403) throw error;
        return { ...identity, availability: 'unavailable' as const };
      }
    });
    // Source denial may redact one row; current Workspace denial still refuses the whole response.
    this.read(notebookRevision, []);
    return { notebookRevision, revisions, nextRevision: history.nextRevision };
  }
}

/** Join ordinary public history, diff and restore to current readers and the common publisher. */
export function createNotebookHistoryOperations(
  dependencies: Dependencies,
  failure: (error: unknown) => never
): Handlers {
  const { store, coreDb } = dependencies;
  const open = (workspaceId: string, context: AdmittedOperationContext) => {
    const dataRoot = store?.getDataRoot();
    if (!store || !coreDb || !dataRoot)
      throw new OperationError('recovery_required', 'Notebook storage is unavailable.', 503);
    return new AuthorizedHistory(
      new KnowledgeNotebook({
        repositoryPath: join(dataRoot, 'workspaces', workspaceId, 'knowledge', 'notebook.git'),
      }),
      dataRoot,
      workspaceId,
      {
        store,
        coreDb,
        actor: context.actorRef,
        requestActor: publicOperationActor(context),
        outputThreadId: context.queryContext?.threadId,
        outputTurnId: context.queryContext?.turnId,
      }
    );
  };
  const run = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      return failure(error);
    }
  };
  return {
    'knowledge.notebook.history': async (input, context) =>
      run(() => open(input.workspaceId, context).history(input)),
    'knowledge.notebook.diff': async (input, context) =>
      run(() => ({
        baseRevision: input.baseRevision,
        fromRevision: input.fromRevision,
        forRestore: input.forRestore === true,
        ...boundedNotebookDiff(
          open(input.workspaceId, context).diff(input, input.forRestore),
          input.forRestore === true
        ),
      })),
    'knowledge.notebook.restore': async (input, context) =>
      run(async () => {
        const history = open(input.workspaceId, context);
        const { changes } = boundedNotebookDiff(history.diff(input, true), true);
        const actor = context.actorRef;
        const {
          runtimeConfigManager,
          workspaceMutationAdmission,
          repositoryWorkspaceDb,
          inflightCommands,
        } = dependencies;
        if (
          !store ||
          !coreDb ||
          !runtimeConfigManager ||
          !workspaceMutationAdmission ||
          !repositoryWorkspaceDb ||
          !inflightCommands ||
          actor.kind !== 'user'
        )
          throw new OperationError(
            'workspace_access_denied',
            'Notebook publication access denied.',
            403
          );
        const request = {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          baseRevision: input.baseRevision,
          summary: input.summary,
          changes: changes.map(({ path, after }) => ({ path, content: after })),
        };
        const confirmedRemovals = Object.fromEntries(
          changes
            .filter(
              (change) => input.confirmRemoval && change.after === null && change.before !== null
            )
            .map(({ path, before }) => [path, before!])
        );
        const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
        try {
          return RestoreKnowledgeNotebookResponseSchema.parse(
            await publishWorkspaceNotebook(
              {
                command: { name: 'knowledge.notebook.restore', input },
                store,
                workspaceDb,
                notebook: history.notebook,
                producer: actor,
                actor,
                inflightCommands,
                confirmedRemovals,
                revalidate: () => {
                  // Current source access applies to removed old bytes as well as restored target bytes.
                  history.diff(input, true);
                  return readWorkspaceNotebookAdmission({
                    store,
                    coreDb,
                    workspaceDb,
                    notebook: history.notebook,
                    request,
                    requestActor: publicOperationActor(context),
                    actor,
                    runtimeConfigManager,
                    workspaceMutationAdmission,
                  });
                },
              },
              request
            )
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      }),
  };
}
