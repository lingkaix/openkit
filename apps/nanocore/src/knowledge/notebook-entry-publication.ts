import type { KnowledgeEntrySchema } from '@openkit/protocol';
import type { z } from 'zod';
import { commandInputHash, IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import {
  parseOwnedKnowledgeEntry,
  serializeUserAuthoredKnowledgePage,
  updateUserAuthoredKnowledgePage,
} from '../storage/workspace-file-records.js';
import { NotebookError, validateNotebookFiles } from './notebook.js';
import {
  type NotebookPublicationAdmission,
  type NotebookPublicationDependencies,
  type NotebookUpdate,
  publishWorkspaceNotebook,
  readWorkspaceNotebookAdmissionRevision,
  readWorkspaceNotebookAdmissions,
} from './notebook-publication.js';

type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/** Existing entry commands are convenience projections of the one fixed-base notebook publisher. */
export type NotebookEntryEdit = {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly baseRevision: string;
} & (
  | {
      readonly operation: 'knowledge.create';
      readonly knowledgePageId: string;
      readonly kind: KnowledgeEntry['kind'];
      readonly title: string;
      readonly content: string;
      readonly sourceReferences?: readonly string[] | undefined;
    }
  | {
      readonly operation: 'knowledge.update';
      readonly knowledgeEntryId: string;
      readonly title?: string | undefined;
      readonly content?: string | undefined;
    }
);

/** Current authority is checked before reading content and again through the ordinary publisher. */
interface EntryPublicationDependencies
  extends Omit<NotebookPublicationDependencies, 'command' | 'revalidate'> {
  readonly revalidate: (request: NotebookUpdate) => NotebookPublicationAdmission;
}

/** Publishes one existing command with its original receipt identity and exact historical response. */
export async function publishWorkspaceNotebookEntry(
  dependencies: EntryPublicationDependencies,
  edit: NotebookEntryEdit
): Promise<KnowledgeEntry> {
  const { operation, ...commandInput } = edit;
  const id = edit.operation === 'knowledge.create' ? edit.knowledgePageId : edit.knowledgeEntryId;
  const path = `${id}.md`;
  validateNotebookFiles({ [path]: '' }, true);
  if (['index.md', 'log.md'].includes(path.split('/').at(-1)!))
    throw new NotebookError('invalid_request');
  const request: NotebookUpdate = {
    workspaceId: edit.workspaceId,
    requestId: edit.requestId,
    baseRevision: edit.baseRevision,
    changes: [],
    summary: `${operation === 'knowledge.create' ? 'Create' : 'Update'} Knowledge page ${id}`,
  };
  dependencies.revalidate(request);
  const command = { name: operation, input: commandInput };
  const bound = { ...dependencies, command };
  let timestamp: string | undefined;
  // Service timestamps are recovered only from the exact previously admitted candidate.
  // Missing completion evidence still fails in the common publisher; it never becomes success here.
  for (const prior of readWorkspaceNotebookAdmissions(bound, request, 'knowledge.notebook.admit')) {
    if (prior.inputDigest !== commandInputHash(commandInput))
      throw new IdempotencyKeyConflictError();
    const candidate = readWorkspaceNotebookAdmissionRevision(bound, request, prior);
    const content = candidate.files[path];
    if (content === undefined) throw new NotebookError('recovery_required');
    const retained = parseOwnedKnowledgeEntry(path, id, content);
    const recorded = operation === 'knowledge.create' ? retained.createdAt : retained.updatedAt;
    if (timestamp !== undefined && timestamp !== recorded)
      throw new NotebookError('recovery_required');
    timestamp = recorded;
  }
  timestamp ??= new Date().toISOString();
  const base = dependencies.notebook.inspectRevision(edit.baseRevision);
  let bytes: string;
  if (edit.operation === 'knowledge.create') {
    if (base.entries[path]) throw new NotebookError('invalid_request');
    bytes = serializeUserAuthoredKnowledgePage(
      {
        id,
        kind: edit.kind,
        title: edit.title,
        content: edit.content,
        ...(edit.sourceReferences ? { sourceReferences: [...edit.sourceReferences] } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: edit.workspaceId }
    );
  } else {
    if (!base.entries[path]) throw new NotebookError('invalid_request');
    const previous = dependencies.notebook.readRevision(base.revision, [path]).files[path]!;
    const entry = parseOwnedKnowledgeEntry(path, id, previous);
    bytes = updateUserAuthoredKnowledgePage(path, previous, {
      ...entry,
      title: edit.title ?? entry.title,
      content: edit.content ?? entry.content,
      updatedAt: timestamp,
    });
  }
  const normalized = { ...request, changes: [{ path, content: bytes }] };
  const publication = await publishWorkspaceNotebook(
    { ...bound, revalidate: () => dependencies.revalidate(normalized) },
    normalized
  );
  dependencies.revalidate(normalized);
  const published = dependencies.notebook.readRevision(publication.notebookRevision, [path]);
  return parseOwnedKnowledgeEntry(path, id, published.files[path]!);
}
