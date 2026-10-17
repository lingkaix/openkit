import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import type { UserDb } from '../storage/db.js';
import { assertMemoryPagesNotSuppressed, readMemorySuppressions } from './memory-maintenance.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import {
  type NotebookEdit,
  type NotebookPublicationDependencies,
  publishNotebook,
} from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import { parseOkfDocument, stringListFrontmatterField } from './okf.js';
import {
  pinScopedNotebook,
  resolveScopedNotebookOwner,
  ScopedNotebookAccessError,
  type ScopedNotebookContext,
} from './scoped-notebook-owner.js';

/** Only direct self edits and current deployment-administrator Server edits are joined; User inspection stays read-only. */
type WritableScopedNotebook = Omit<ScopedNotebookContext, 'target'> &
  (
    | { readonly target: { readonly kind: 'user' }; readonly userDb: UserDb }
    | { readonly target: { readonly kind: 'server' } }
  );

/** This foundation admits no Source-bearing content, including an edit that tries to remove unsupported provenance. */
function assertEmptySourceReferences(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('invalid_request');
    const references = stringListFrontmatterField(parsed.document, 'source_refs');
    if (
      (references === null &&
        (!parsed.document.reserved || Object.hasOwn(parsed.document.frontmatter, 'source_refs'))) ||
      (references?.length ?? 0) > 0
    )
      throw new NotebookError('invalid_request');
  }
}

/** Reads the existing scope schema; an unavailable retained notebook/schema is never initialized or replaced. */
function scopeSchema(notebookRoot: string): string {
  try {
    return readFileSync(join(notebookRoot, 'schema', 'scope-schema.yaml'), 'utf8');
  } catch {
    throw new NotebookError('recovery_required');
  }
}

/**
 * Joins authenticated native self/Server authority to the one existing publisher, Audit and receipt owners.
 *
 * This internal direct-human foundation accepts only empty source_refs and enforces current User suppression. Source disclosure, output audience and Agent delegation are not granted here and must be joined before broader operations exist.
 */
export async function publishScopedNotebook(
  input: WritableScopedNotebook & {
    readonly store: FsStore;
    readonly runtimeConfigManager: RuntimeConfigManager;
    readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
    readonly command?: NotebookPublicationDependencies['command'];
    /** Only the native Item-confirmed forget owner supplies this exact removal after grant consumption. */
    readonly confirmedForget?: {
      readonly requestId: string;
      readonly pageId: string;
      readonly baseRevision: string;
      readonly digest: string;
      readonly content: string;
    };
  },
  request: NotebookEdit
) {
  if (input.target.kind !== 'user' && input.target.kind !== 'server')
    throw new ScopedNotebookAccessError();
  const context = {
    coreDb: input.coreDb,
    actor: input.actor ? { ...input.actor } : undefined,
    target: { ...input.target },
  };
  const owner = resolveScopedNotebookOwner(context);
  const userDb = input.target.kind === 'user' && 'userDb' in input ? input.userDb : undefined;
  if (
    input.target.kind === 'user' &&
    (!userDb ||
      userDb.userId !== input.actor!.userId ||
      resolve(userDb.dataRoot) !== resolve(input.coreDb.dataRoot))
  )
    throw new NotebookError('invalid_request');
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const producer = { kind: 'user' as const, id: input.actor!.userId };
  return publishNotebook(
    {
      owner: userDb ? { kind: 'user', userDb } : { kind: 'server', coreDb: input.coreDb },
      store: input.store,
      inflightCommands: input.inflightCommands,
      notebook,
      producer,
      command: {
        name: input.command?.name ?? 'knowledge.notebook.update',
        input: input.command
          ? { request: input.command.input, ownerScope: owner.ownerScope }
          : { ...request, ownerScope: owner.ownerScope },
      },
      ...(input.confirmedForget
        ? {
            confirmedRemovals: {
              [`${input.confirmedForget.pageId}.md`]: input.confirmedForget.content,
            },
          }
        : {}),
      revalidate: () => {
        // Current identity/credential admission precedes every retained read and the publisher's final CAS.
        const currentFiles = pinScopedNotebook(context).read().files;
        const baseFiles = notebook.readRevision(request.baseRevision).files;
        const suppressions = userDb
          ? readMemorySuppressions(owner.notebookRoot, userDb.userId)
          : [];
        const forget = input.confirmedForget;
        const forgetPath = forget ? `${forget.pageId}.md` : null;
        if (
          forget &&
          (!userDb ||
            forget.requestId !== request.requestId ||
            forget.baseRevision !== request.baseRevision ||
            request.changes.length !== 1 ||
            request.changes[0]?.path !== forgetPath ||
            request.changes[0]?.content !== null ||
            baseFiles[forgetPath!] !== forget.content ||
            forget.digest !==
              `sha256:${createHash('sha256').update(forget.content).digest('hex')}` ||
            !suppressions.some(
              ({ id, payload }) =>
                id === forget.requestId &&
                payload.pageId === forget.pageId &&
                payload.lastRevision === forget.baseRevision &&
                payload.digest === forget.digest
            ))
        )
          throw new NotebookError('invalid_request');
        if (userDb)
          assertMemoryPagesNotSuppressed(
            owner.notebookRoot,
            userDb.userId,
            [
              ...Object.keys(currentFiles),
              ...Object.keys(baseFiles),
              ...request.changes.map(({ path }) => path),
            ].filter((path) => path !== forgetPath)
          );
        assertEmptySourceReferences(currentFiles);
        assertEmptySourceReferences(notebook.readRevision(request.baseRevision).files);
        assertEmptySourceReferences(
          Object.fromEntries(
            request.changes.flatMap(({ path, content }) =>
              content === null ? [] : [[path, content]]
            )
          )
        );
        const current = input.runtimeConfigManager.current();
        const maintenance = userDb
          ? current.userConfigs.find(({ userId }) => userId === userDb.userId)?.config
              .knowledgeMaintenance
          : current.openKitConfig.knowledgeMaintenance;
        return {
          scopeSchemaText: scopeSchema(owner.notebookRoot),
          reviewRequiredPageIds: maintenance?.reviewRequiredPageIds ?? [],
          registeredSources: new Map(),
          resolvedReferences: new Map(),
          suppressedPageIds: suppressions.map(({ payload }) => payload.pageId),
        };
      },
    },
    request
  );
}

/**
 * Reads bounded published history for internal native consumers, with current scope and empty-Source admission.
 *
 * This is not a public/model disclosure endpoint. Current audience, sensitivity and forget suppression remain required later joins; administrative User inspection grants no mutation route.
 */
export function readScopedNotebookHistory(
  input: ScopedNotebookContext & { readonly revision?: string; readonly limit?: number }
) {
  const context = {
    coreDb: input.coreDb,
    actor: input.actor ? { ...input.actor } : undefined,
    target: { ...input.target },
  };
  const owner = resolveScopedNotebookOwner(context);
  assertEmptySourceReferences(pinScopedNotebook(context).read().files);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const history = notebook.history({
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const scopeSchemaText = scopeSchema(owner.notebookRoot);
  for (const entry of history.revisions) {
    const revision = notebook.readRevision(entry.revision);
    assertEmptySourceReferences(revision.files);
    const checked = validateNotebookCandidate({
      ownerScope: owner.ownerScope,
      base: { files: {} },
      candidate: revision,
      scopeSchemaText,
      registeredSources: new Map(),
      resolvedReferences: new Map(),
    });
    if (checked.errors.length) throw new NotebookError('recovery_required');
  }
  resolveScopedNotebookOwner(context);
  return { ownerScope: owner.ownerScope, ...history };
}
