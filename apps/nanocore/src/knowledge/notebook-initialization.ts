import { join } from 'node:path';
import type { ActorRef, KnowledgeNotebookAdmission } from '@openkit/protocol';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import type { WorkspaceDb } from '../storage/db.js';
import { writeFileAtomic } from '../storage/workspace-file-records.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook, NotebookError } from './notebook.js';
import type { NotebookPublicationAdmission } from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import { parseOkfDocument } from './okf.js';

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
export function initializeWorkspaceNotebook(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly initialization: NotebookInitialization;
  readonly files?: Readonly<Record<string, string>>;
  readonly revalidate: () => NotebookPublicationAdmission;
}): string {
  const ownerScope = { kind: 'workspace', workspaceId: input.workspaceId } as const;
  const files = initialNotebookFiles(input.files ?? {});
  // System attribution is only for the unchanged service seed, never authored content or navigation.
  if (
    input.initialization.producer.kind !== 'user' &&
    (input.initialization.producer.kind !== 'system' ||
      input.initialization.producer.id !== 'notebook-initializer' ||
      input.initialization.producer.responsibleUserId !== null ||
      Object.keys(files).length !== 1 ||
      files['index.md'] !== DEFAULT_NOTEBOOK_INDEX)
  )
    throw new NotebookError('invalid_request');
  const authority = {
    kind: 'direct',
    instructionReference: input.initialization.instructionReference,
  } as const;
  const inputDigest = commandInputHash({ ownerScope, files, authority });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(input.workspaceRoot, 'knowledge', 'notebook.git'),
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
    recordWorkspaceAuditEvent({
      workspaceDb: input.workspaceDb,
      workspaceId: input.workspaceId,
      requestId: input.initialization.requestId,
      actor: input.initialization.producer,
      category: 'knowledge',
      action,
      outcome: 'succeeded',
      resource: `knowledge-notebook:${evidence.candidateRevision}`,
      notebookAdmission: evidence,
      summary: 'Initial notebook publication evidence retained.',
    });
  };
  const revision = notebook.initialize({
    files,
    metadata: {
      summary: 'Initialize Workspace notebook',
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
    join(input.workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'),
    admission.scopeSchemaText
  );
  return revision;
}
