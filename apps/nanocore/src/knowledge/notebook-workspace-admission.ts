import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ActorRef } from '@openkit/protocol';
import { workspaceIdForOwner } from '@openkit/protocol';
import { assertCanonicalDirectory } from '@openkit/storage';
import type { Actor } from '../auth/identity.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { canDiscloseThreadToAudience } from '../auth/thread-visibility.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { findWorkspaceConfig, type RuntimeConfigManager } from '../config/runtime-config.js';
import { verifyKnowledgeProposalWorkHistorySteps } from '../knowledge-source-authority.js';
import type { FsStore } from '../lib/store.js';
import { OperationError, WORKSPACE_ACCESS_DENIED } from '../operation-error.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';

import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { type KnowledgeNotebook, NotebookError } from './notebook.js';
import type { NotebookPublicationAdmission, NotebookUpdate } from './notebook-publication.js';
import {
  parseKnowledgePageSourceReference,
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
} from './okf.js';

import { assertSourcePointerEdit } from './source-pointers.js';

/** Current native owners needed at the final direct-human Workspace publication boundary. */
interface WorkspacePublicationAuthority {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
  readonly requestActor?: Actor;
  /** Trusted Worker/schedule entry rechecks its existing admission instead of inventing a human session. */
  readonly currentAuthority?: () => void;
  readonly actor: Extract<ActorRef, { kind: 'user' }>;
  readonly notebook: KnowledgeNotebook;
  /** Exact SQL-selected schema bytes for activated Workspace readers. */
  readonly scopeSchemaText: string;
  readonly request: NotebookUpdate;
}

/** Rechecks the existing current requester mutation predicate without Notebook or Source traversal. */
export function assertWorkspaceNotebookWrite(
  input: Pick<
    WorkspacePublicationAuthority,
    'coreDb' | 'requestActor' | 'currentAuthority' | 'actor'
  > & {
    readonly request: Pick<NotebookUpdate, 'workspaceId'>;
    readonly workspaceMutationAdmission?: WorkspaceMutationAdmission;
  }
): void {
  const { workspaceId } = input.request;
  input.currentAuthority?.();
  if (
    ('workspaceMutationAdmission' in input &&
      input.workspaceMutationAdmission!.isClosed(workspaceId)) ||
    (input.requestActor
      ? input.actor.id !== input.requestActor.userId ||
        !isWorkspaceOperationAuthorized(input.coreDb, input.requestActor, workspaceId, {
          mutating: true,
          policyOperation: 'knowledge.write',
        })
      : !input.currentAuthority)
  )
    throw new OperationError(
      WORKSPACE_ACCESS_DENIED.code,
      'Notebook publication access denied.',
      403
    );
}

/** Rechecks the original authorization and disclosure owners; native callers carry Main's current non-retained Review facts. */
export function readWorkspaceNotebookAdmission(
  input: WorkspacePublicationAuthority &
    (
      | {
          readonly runtimeConfigManager: Pick<RuntimeConfigManager, 'current'>;
          readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
        }
      | { readonly reviewRequiredPageIds: readonly string[] }
    )
): NotebookPublicationAdmission {
  const steps = readWorkspaceNotebookAdmissionSteps(input);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Runs the same complete owner predicate in released contributions for native preparation. */
export function* readWorkspaceNotebookAdmissionSteps(
  input: WorkspacePublicationAuthority &
    (
      | {
          readonly runtimeConfigManager: Pick<RuntimeConfigManager, 'current'>;
          readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
        }
      | { readonly reviewRequiredPageIds: readonly string[] }
    )
): Generator<void, NotebookPublicationAdmission, void> {
  const { workspaceId } = input.request;
  assertWorkspaceNotebookWrite(input);
  const workspace = input.store.getWorkspace(workspaceId);
  const reviewRequiredPageIds =
    'reviewRequiredPageIds' in input
      ? [...input.reviewRequiredPageIds]
      : (findWorkspaceConfig(input.runtimeConfigManager.current(), workspaceId)?.config.workspace
          .knowledgeMaintenance?.reviewRequiredPageIds ?? []);

  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: input.coreDb.dataRoot,
    scope: { kind: 'workspace', workspaceId },
  });
  const pageScopeId = `page/workspace/${workspaceId}/${knowledgeBaseId}`;
  const workspaceRoot = join(input.coreDb.dataRoot, 'workspaces', workspaceId);
  for (const path of [
    workspaceRoot,
    join(workspaceRoot, 'knowledge'),
    join(workspaceRoot, 'knowledge', 'schema'),
  ])
    assertCanonicalDirectory(path);
  const scopeSchemaText = input.scopeSchemaText;
  const sourceRecords = new Map(
    input.store.listKnowledgeSources(workspaceId).map((source) => [source.id, source])
  );
  const registeredSources = new Map(
    [...sourceRecords].map(([id, source]) => [id, source.contentDigest])
  );
  const base = input.notebook.inspectRevision(input.request.baseRevision);
  const changes = new Map(input.request.changes.map(({ path, content }) => [path, content]));
  const resolvedReferences = new Map<string, ReadonlySet<string>>();
  const visited = new Set<string>();
  const active = new Set<string>();

  const permitThreadDisclosure = (threadId: string): void => {
    const thread = input.store.getThread(workspaceId, threadId);
    if (thread.visibility === 'workspace' && canDiscloseThreadToAudience(input.store, thread, null))
      return;
    // The personal Workspace has one fixed private audience under its existing owner-only membership contract.
    if (workspace.kind === 'personal' && thread.privateOwnerUserId === input.actor.id) return;
    throw new OperationError(
      WORKSPACE_ACCESS_DENIED.code,
      'Notebook source disclosure denied.',
      403
    );
  };
  const checkPage = function* (
    path: string,
    content: string,
    baseOnly = false
  ): Generator<void, void, void> {
    // A removed page uses its original dependency graph; candidate edits use the resulting tree.
    const key = `${baseOnly ? 'base' : 'candidate'}:${path}`;
    if (visited.has(key)) return;
    if (active.has(key)) throw new NotebookError('invalid_request');
    active.add(key);
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('invalid_request');
    const references = stringListFrontmatterField(parsed.document, 'source_refs');
    if (references === null && !parsed.document.reserved)
      throw new NotebookError('invalid_request');
    const refs = references ?? [];
    const external = (yield* verifyKnowledgeProposalWorkHistorySteps({
      coreDb: input.coreDb,
      workspaceDb: input.workspaceDb,
      store: input.store,
      workspaceId,
      sourceReferences: refs,
    })).verifiedExternalReferences;
    const resolved = new Set(external);
    for (const reference of refs) {
      if (reference.startsWith('source:')) {
        const resolution = resolveRegisteredKnowledgeSourceReference(reference, registeredSources);
        const source = resolution.targetId ? sourceRecords.get(resolution.targetId) : undefined;
        if (!resolution.resolved || !source) throw new NotebookError('invalid_request');
        if (source.originatingThreadId) permitThreadDisclosure(source.originatingThreadId);
        resolved.add(reference);
      } else if (reference.startsWith('openkit:')) {
        const parsedReference = parseKnowledgePageSourceReference(reference, pageScopeId);
        if (!parsedReference) throw new NotebookError('invalid_request');
        const sourcePath = `${parsedReference.reference.objectId}.md`;
        const changed = changes.get(sourcePath);
        const sourceContent =
          !baseOnly && changes.has(sourcePath)
            ? changed
            : base.entries[sourcePath]
              ? input.notebook.readRevision(base.revision, [sourcePath]).files[sourcePath]
              : undefined;
        if (
          typeof sourceContent !== 'string' ||
          (parsedReference.contentDigest !== undefined &&
            parsedReference.contentDigest !==
              `sha256:${createHash('sha256').update(sourceContent).digest('hex')}`)
        )
          throw new NotebookError('invalid_request');
        const sourceDocument = parseOkfDocument({ path: sourcePath, content: sourceContent });
        if (
          !sourceDocument.ok ||
          ['restricted', 'confidential'].includes(
            String(sourceDocument.document.frontmatter.sensitivity)
          )
        )
          throw new OperationError(
            WORKSPACE_ACCESS_DENIED.code,
            'Notebook source disclosure denied.',
            403
          );
        yield* checkPage(sourcePath, sourceContent, baseOnly);
        resolved.add(reference);
      } else if (reference.startsWith('turn:')) {
        const turn = yield* input.store.getTurnByIdSteps(reference.slice('turn:'.length));
        if (workspaceIdForOwner(turn.owner) !== workspaceId || !resolved.has(reference))
          throw new NotebookError('invalid_request');
        permitThreadDisclosure(turn.threadId);
      } else if (!resolved.has(reference)) {
        throw new NotebookError('invalid_request');
      }
    }
    active.delete(key);
    visited.add(key);
    resolvedReferences.set(path.slice(0, -3), resolved);
  };
  // A summary edit admits the Source itself, even when its supporting source_refs list is empty.
  for (const { path, content } of input.request.changes) {
    yield;
    if (!path.startsWith('@sources/')) continue;
    const id = path.slice('@sources/'.length, -3);
    const source = sourceRecords.get(id);
    const original = input.notebook.readSourcePointers(base.revision)[id];
    if (!source || original === undefined || content === null)
      throw new NotebookError('invalid_request');
    try {
      assertSourcePointerEdit(original, content);
    } catch (error) {
      if (!(error instanceof NotebookError) || error.code !== 'invalid_request') throw error;
      // Preserve the existing native category before ordinary candidate validation runs.
      throw new NotebookError('invalid_request', undefined, ['notebook.invalid_source_edit']);
    }
    if (source.originatingThreadId) permitThreadDisclosure(source.originatingThreadId);
  }
  // Deletion and its replay still require current access to the exact removed bytes and Sources.
  for (const { path, content } of input.request.changes) {
    yield;
    if (content !== null || !base.entries[path]) continue;
    const previous = input.notebook.readRevision(base.revision, [path]).files[path];
    if (previous !== undefined) yield* checkPage(path, previous, true);
  }
  for (const { path, content } of input.request.changes)
    if (content !== null) yield* checkPage(path, content);
  return {
    pageScopeId,
    scopeSchemaText,
    registeredSources,
    resolvedReferences,
    reviewRequiredPageIds,
  };
}
