import { join } from 'node:path';
import {
  type ActorRef,
  type KnowledgeNotebookAdmission,
  parseReferenceScope,
} from '@openkit/protocol';
import {
  prepareAuditEvent,
  recordServerAuditEvent,
  recordUserAuditEvent,
} from '../audit-events.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from '../storage/canonical-write-capacity.js';
import {
  prepareControlKnowledgeAuthorityTransfer,
  prepareWorkspaceKnowledgeSelection,
} from '../storage/control-store-knowledge.js';
import type { CoreDb, UserDb, WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { syncCanonicalTreeAsync, writeFileAtomic } from '../storage/workspace-file-records.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook, NotebookError } from './notebook.js';
import type { NotebookPublicationAdmission } from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import { parseOkfDocument } from './okf.js';
import { decodeSourcePointer } from './source-pointers.js';

/** Native User attribution or the exact service-owned empty seed; page bytes cannot supply these facts. */
export interface NotebookInitialization {
  readonly requestId: string;
  readonly producer:
    | Extract<ActorRef, { kind: 'user' }>
    | {
        readonly kind: 'system';
        readonly id: 'notebook-initializer';
        readonly responsibleUserId: null;
      };
  readonly instructionReference: string;
}

/** Prepares only fresh input navigation; published Git history and materialized directories are never repaired. */
function initialNotebookFiles(
  supplied: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  let index = supplied['index.md'];
  if (index === undefined) {
    const paths = Object.keys(supplied).sort();
    const pages = paths
      .filter((path) => !path.includes('/') && path.endsWith('.md') && path !== 'log.md')
      .map((path) => [path.slice(0, -3), path] as const);
    const directories = [
      ...new Set(paths.filter((path) => path.includes('/')).map((path) => path.split('/')[0]!)),
    ]
      .sort()
      .map((name) => [name, `${name}/`] as const);
    const links = [...pages, ...directories].map(
      ([title, target]) =>
        `* [${title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')}](<${encodeURI(target)}>)`
    );
    index =
      links.length === 0
        ? DEFAULT_NOTEBOOK_INDEX
        : `---\nokf_version: "0.2"\n---\n# Knowledge\n\n${links.join('\n')}\n`;
  } else {
    const parsed = parseOkfDocument({ path: 'index.md', content: index });
    if (!parsed.ok) throw new NotebookError('invalid_request');
    if (parsed.document.frontmatter.okf_version === undefined)
      index = `---\nokf_version: "0.2"\n---\n${index}`;
    else if (parsed.document.frontmatter.okf_version !== '0.2')
      throw new NotebookError('invalid_request');
  }
  return { ...supplied, 'index.md': index };
}

/**
 * Creates the first content revision inside an unpublished Workspace staging root.
 *
 * The existing Workspace publisher owns staging cleanup and final directory publication. This function never repairs an existing repository or reads a predecessor page directory.
 */
export async function initializeWorkspaceNotebook(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly initialization: NotebookInitialization;
  readonly files?: Readonly<Record<string, string>>;
  readonly sourcePointers?: Readonly<Record<string, string>>;
  readonly revalidate: () => NotebookPublicationAdmission;
  readonly fileWriteAdmission?: FileStorageAdmission;
}): Promise<string> {
  if (input.workspaceDb.workspaceId !== input.workspaceId)
    throw new NotebookError('invalid_request');
  const prepare = () =>
    prepareNotebookInitialization({
      notebookRoot: join(input.workspaceRoot, 'knowledge'),
      owner: { kind: 'workspace', workspaceDb: input.workspaceDb },
      initialization: input.initialization,
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.sourcePointers === undefined ? {} : { sourcePointers: input.sourcePointers }),
      revalidate: input.revalidate,
    });
  const prepared = input.fileWriteAdmission
    ? withCanonicalFileWriteAdmission(input.fileWriteAdmission, prepare)
    : prepare();
  const pageScope = parseReferenceScope(prepared.admission.pageScopeId ?? '');
  if (
    pageScope?.family !== 'page' ||
    pageScope.kind !== 'workspace' ||
    pageScope.workspaceId !== input.workspaceId
  )
    throw new NotebookError('invalid_request');
  await syncCanonicalTreeAsync(join(input.workspaceRoot, 'knowledge', 'notebook.git'));
  const head = await prepareWorkspaceKnowledgeSelection({
    db: input.workspaceDb,
    workspaceRoot: input.workspaceRoot,
    notebook: prepared.notebook,
    knowledgeBaseId: pageScope.knowledgeBaseId,
    notebookCommit: prepared.revision,
    schemaText: prepared.admission.scopeSchemaText,
  });
  const latest = input.revalidate();
  if (latest.scopeSchemaText !== prepared.admission.scopeSchemaText)
    throw new NotebookError('conflict');
  applyScopedMigrations(
    input.workspaceDb,
    prepareControlKnowledgeAuthorityTransfer({
      db: input.workspaceDb,
      heads: [head],
      proposals: [],
      initialAudits: prepared.audits,
    })
  );
  const project = () =>
    writeFileAtomic(
      join(input.workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'),
      prepared.admission.scopeSchemaText
    );
  if (input.fileWriteAdmission) withCanonicalFileWriteAdmission(input.fileWriteAdmission, project);
  else project();
  return prepared.revision;
}

/** Reuses one validation/Git/Audit boundary for native fresh-scope creation; callers own staging and current admission. */
export function initializeNotebook(
  input: Parameters<typeof prepareNotebookInitialization>[0]
): string {
  const prepared = prepareNotebookInitialization(input);
  const audit = (event: (typeof prepared.audits)[number]) => {
    if (input.owner.kind === 'workspace') throw new NotebookError('invalid_request');
    const facts = {
      auditEventId: event.id,
      requestId: event.requestId,
      actor: event.actor,
      category: event.category,
      action: event.action,
      outcome: event.outcome,
      resource: event.resource,
      notebookAdmission: event.notebookAdmission!,
      summary: event.summary,
      now: new Date(event.createdAt),
      occurredAt: new Date(event.occurredAt),
    };
    if (input.owner.kind === 'user') recordUserAuditEvent({ ...facts, userDb: input.owner.userDb });
    else recordServerAuditEvent({ ...facts, coreDb: input.owner.coreDb });
  };
  audit(prepared.audits[0]!);
  prepared.notebook.publishInitialRevision(prepared.revision);
  audit(prepared.audits[1]!);
  writeFileAtomic(
    join(input.notebookRoot, 'schema', 'scope-schema.yaml'),
    prepared.admission.scopeSchemaText
  );
  return prepared.revision;
}

/** Prepares original initial history and Audit facts without publishing mutable authority. */
function prepareNotebookInitialization(input: {
  readonly notebookRoot: string;
  readonly owner:
    | { readonly kind: 'workspace'; readonly workspaceDb: WorkspaceDb }
    | { readonly kind: 'user'; readonly userDb: UserDb }
    | { readonly kind: 'server'; readonly coreDb: CoreDb };
  readonly initialization: NotebookInitialization;
  readonly files?: Readonly<Record<string, string>>;
  readonly sourcePointers?: Readonly<Record<string, string>>;
  readonly revalidate: () => NotebookPublicationAdmission;
}) {
  const ownerScope =
    input.owner.kind === 'workspace'
      ? { kind: 'workspace' as const, workspaceId: input.owner.workspaceDb.workspaceId }
      : input.owner.kind === 'user'
        ? { kind: 'user' as const, userId: input.owner.userDb.userId }
        : { kind: 'server' as const };
  const files = initialNotebookFiles(input.files ?? {});
  // System attribution is only for the unchanged service seed, never authored content or navigation.
  if (
    input.initialization.producer.kind !== 'user' &&
    (input.initialization.producer.kind !== 'system' ||
      input.initialization.producer.id !== 'notebook-initializer' ||
      input.initialization.producer.responsibleUserId !== null ||
      Object.keys(input.sourcePointers ?? {}).length !== 0 ||
      Object.keys(files).length !== 1 ||
      files['index.md'] !== DEFAULT_NOTEBOOK_INDEX)
  )
    throw new NotebookError('invalid_request');
  const authority = {
    kind: 'direct',
    instructionReference: input.initialization.instructionReference,
  } as const;
  const inputDigest = commandInputHash({
    ownerScope,
    files,
    sourcePointers: input.sourcePointers ?? {},
    authority,
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(input.notebookRoot, 'notebook.git'),
  });
  const admission = input.revalidate();
  const pageScope = parseReferenceScope(admission.pageScopeId ?? '');
  const sources = new Map(
    Object.entries(input.sourcePointers ?? {}).map(([id, content]) => {
      if (pageScope?.family !== 'page') throw new NotebookError('invalid_request');
      const pointer = decodeSourcePointer({
        ownerScope,
        knowledgeBaseId: pageScope.knowledgeBaseId,
        scopeSchemaText: admission.scopeSchemaText,
        id,
        content,
      });
      return [id, pointer.source.contentDigest];
    })
  );
  if (
    sources.size !== admission.registeredSources.size ||
    [...sources].some(([id, digest]) => admission.registeredSources.get(id) !== digest)
  )
    throw new NotebookError('invalid_request');
  const validation = validateNotebookCandidate({
    ...admission,
    ownerScope,
    base: { files: {} },
    candidate: { files },
  });
  if (validation.errors.length) throw new NotebookError('invalid_request');
  let evidence: KnowledgeNotebookAdmission | undefined;
  const audits: ReturnType<typeof prepareAuditEvent>[] = [];
  const audit = (action: string): void => {
    if (!evidence) throw new NotebookError('recovery_required');
    audits.push(
      prepareAuditEvent({
        requestId: input.initialization.requestId,
        actor: input.initialization.producer,
        category: 'knowledge',
        action,
        outcome: 'succeeded',
        workspaceId: ownerScope.kind === 'workspace' ? ownerScope.workspaceId : null,
        resource: `knowledge-notebook:${evidence.candidateRevision}`,
        notebookAdmission: evidence,
        summary: 'Initial notebook publication evidence retained.',
      })
    );
  };
  const revision = notebook.prepareInitialRevision({
    files,
    ...(input.sourcePointers === undefined ? {} : { sourcePointers: input.sourcePointers }),
    metadata: {
      summary: `Initialize ${input.owner.kind === 'workspace' ? 'Workspace' : input.owner.kind === 'user' ? 'User' : 'Server'} notebook`,
      changeRequest: { requestId: input.initialization.requestId, inputDigest },
      producer: input.initialization.producer,
      authority,
      sourceReferences: [...validation.sourceReferences],
    },
  });
  {
    const candidateRevision = revision;
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
  }
  audit('knowledge.notebook.initialize');
  return { notebook, revision, audits, admission };
}
