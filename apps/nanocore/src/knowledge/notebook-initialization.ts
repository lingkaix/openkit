import { join } from 'node:path';
import type { ActorRef, KnowledgeNotebookAdmission } from '@openkit/protocol';
import {
  recordServerAuditEvent,
  recordUserAuditEvent,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import type { CoreDb, UserDb, WorkspaceDb } from '../storage/db.js';
import { writeFileAtomic } from '../storage/workspace-file-records.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook, NotebookError } from './notebook.js';
import type { NotebookPublicationAdmission } from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';

/** Actual native creation or import attribution; page bytes cannot supply these facts. */
export interface NotebookInitialization {
  readonly requestId: string;
  readonly producer: Extract<ActorRef, { kind: 'user' }>;
  readonly instructionReference: string;
}

/**
 * Creates the first content revision inside an unpublished Workspace staging root.
 *
 * The existing Workspace publisher owns staging cleanup and final directory publication. This function never repairs an existing repository or reads a predecessor page directory.
 */
export function initializeWorkspaceNotebook(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly initialization: NotebookInitialization;
  readonly files?: Readonly<Record<string, string>>;
  readonly revalidate: () => NotebookPublicationAdmission;
}): string {
  if (input.workspaceDb.workspaceId !== input.workspaceId)
    throw new NotebookError('invalid_request');
  return initializeNotebook({
    notebookRoot: join(input.workspaceRoot, 'knowledge'),
    owner: { kind: 'workspace', workspaceDb: input.workspaceDb },
    initialization: input.initialization,
    ...(input.files === undefined ? {} : { files: input.files }),
    revalidate: input.revalidate,
  });
}

/** Reuses one validation/Git/Audit boundary for native fresh-scope creation; callers own staging and current admission. */
export function initializeNotebook(input: {
  readonly notebookRoot: string;
  readonly owner:
    | { readonly kind: 'workspace'; readonly workspaceDb: WorkspaceDb }
    | { readonly kind: 'user'; readonly userDb: UserDb }
    | { readonly kind: 'server'; readonly coreDb: CoreDb };
  readonly initialization: NotebookInitialization;
  readonly files?: Readonly<Record<string, string>>;
  readonly revalidate: () => NotebookPublicationAdmission;
}): string {
  const ownerScope =
    input.owner.kind === 'workspace'
      ? { kind: 'workspace' as const, workspaceId: input.owner.workspaceDb.workspaceId }
      : input.owner.kind === 'user'
        ? { kind: 'user' as const, userId: input.owner.userDb.userId }
        : { kind: 'server' as const };
  const files = { 'index.md': DEFAULT_NOTEBOOK_INDEX, ...input.files };
  const authority = {
    kind: 'direct',
    instructionReference: input.initialization.instructionReference,
  } as const;
  const inputDigest = commandInputHash({ ownerScope, files, authority });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(input.notebookRoot, 'notebook.git'),
  });
  const admission = input.revalidate();
  const validation = validateNotebookCandidate({
    ...admission,
    ownerScope,
    base: { files: {} },
    candidate: { files },
  });
  if (validation.errors.length) throw new NotebookError('invalid_request');
  let evidence: KnowledgeNotebookAdmission | undefined;
  const audit = (action: string): void => {
    if (!evidence) throw new NotebookError('recovery_required');
    const event = {
      requestId: input.initialization.requestId,
      actor: input.initialization.producer,
      category: 'knowledge' as const,
      action,
      outcome: 'succeeded' as const,
      resource: `knowledge-notebook:${evidence.candidateRevision}`,
      notebookAdmission: evidence,
      summary: 'Initial notebook publication evidence retained.',
    };
    if (input.owner.kind === 'workspace')
      recordWorkspaceAuditEvent({
        ...event,
        workspaceDb: input.owner.workspaceDb,
        workspaceId: input.owner.workspaceDb.workspaceId,
      });
    else if (input.owner.kind === 'user')
      recordUserAuditEvent({ ...event, userDb: input.owner.userDb });
    else recordServerAuditEvent({ ...event, coreDb: input.owner.coreDb });
  };
  const revision = notebook.initialize({
    files,
    metadata: {
      summary: `Initialize ${input.owner.kind === 'workspace' ? 'Workspace' : input.owner.kind === 'user' ? 'User' : 'Server'} notebook`,
      changeRequest: { requestId: input.initialization.requestId, inputDigest },
      producer: input.initialization.producer,
      authority,
      sourceReferences: [...validation.sourceReferences],
    },
    beforePublish: (candidateRevision) => {
      const current = input.revalidate();
      const checked = validateNotebookCandidate({
        ...current,
        ownerScope,
        base: { files: {} },
        candidate: { files },
      });
      if (
        checked.errors.length ||
        current.scopeSchemaText !== admission.scopeSchemaText ||
        JSON.stringify(checked.sourceReferences) !== JSON.stringify(validation.sourceReferences)
      )
        throw new NotebookError('invalid_request');
      evidence = {
        ownerScope,
        requestId: input.initialization.requestId,
        inputDigest,
        baseRevision: null,
        candidateRevision,
        producer: input.initialization.producer,
        authority,
        sourceReferences: [...checked.sourceReferences],
      };
      audit('knowledge.notebook.admit');
    },
  });
  audit('knowledge.notebook.initialize');
  writeFileAtomic(
    join(input.notebookRoot, 'schema', 'scope-schema.yaml'),
    admission.scopeSchemaText
  );
  return revision;
}
