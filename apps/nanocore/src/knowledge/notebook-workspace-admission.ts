import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ActorRef } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { findWorkspaceConfig, type RuntimeConfigManager } from '../config/runtime-config.js';
import { verifyKnowledgeProposalWorkHistory } from '../knowledge-source-authority.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  assertCanonicalDirectory,
  readCanonicalTextFile,
} from '../storage/workspace-file-records.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { type KnowledgeNotebook, NotebookError } from './notebook.js';
import type { NotebookPublicationAdmission, NotebookUpdate } from './notebook-publication.js';
import {
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
} from './okf.js';

/** Current native owners needed at the final direct-human Workspace publication boundary. */
interface WorkspacePublicationAuthority {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
  readonly requestActor?: Actor;
  /** Trusted Worker/schedule entry rechecks its existing admission instead of inventing a human session. */
  readonly currentAuthority?: () => void;
  readonly actor: Extract<ActorRef, { kind: 'user' }>;
  readonly runtimeConfigManager: Pick<RuntimeConfigManager, 'current'>;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  readonly notebook: KnowledgeNotebook;
  readonly request: NotebookUpdate;
}

/** Rechecks current scope and exact source disclosure; a caller's private read grant is not a shared publication grant. */
export function readWorkspaceNotebookAdmission(
  input: WorkspacePublicationAuthority
): NotebookPublicationAdmission {
  const { workspaceId } = input.request;
  input.currentAuthority?.();
  if (
    input.workspaceMutationAdmission.isClosed(workspaceId) ||
    (input.requestActor ? input.actor.id !== input.requestActor.userId || !isWorkspaceOperationAuthorized(input.coreDb, input.requestActor, workspaceId, {
      mutating: true,
      policyOperation: 'knowledge.write',
    }) : !input.currentAuthority)
  )
    throw new OperationError('workspace_access_denied', 'Notebook publication access denied.', 403);
  const workspace = input.store.getWorkspace(workspaceId);
  const reviewRequiredPageIds =
    findWorkspaceConfig(input.runtimeConfigManager.current(), workspaceId)?.config.workspace
      .knowledgeMaintenance?.reviewRequiredPageIds ?? [];

  const workspaceRoot = join(input.coreDb.dataRoot, 'workspaces', workspaceId);
  for (const path of [
    workspaceRoot,
    join(workspaceRoot, 'knowledge'),
    join(workspaceRoot, 'knowledge', 'schema'),
  ])
    assertCanonicalDirectory(path);
  const scopeSchemaText = readCanonicalTextFile(
    join(workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml')
  );
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
    if (thread.visibility === 'workspace') return;
    // The personal Workspace has one fixed private audience under its existing owner-only membership contract.
    if (workspace.kind === 'personal' && thread.privateOwnerUserId === input.actor.id) return;
    throw new OperationError('workspace_access_denied', 'Notebook source disclosure denied.', 403);
  };
  const checkPage = (path: string, content: string): void => {
    if (visited.has(path)) return;
    if (active.has(path)) throw new NotebookError('invalid_request');
    active.add(path);
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('invalid_request');
    const references = stringListFrontmatterField(parsed.document, 'source_refs');
    if (references === null && !parsed.document.reserved)
      throw new NotebookError('invalid_request');
    const refs = references ?? [];
    const external = verifyKnowledgeProposalWorkHistory({
      coreDb: input.coreDb,
      workspaceDb: input.workspaceDb,
      store: input.store,
      workspaceId,
      sourceReferences: refs,
    }).verifiedExternalReferences;
    const resolved = new Set(external);
    for (const reference of refs) {
      if (reference.startsWith('source:')) {
        const resolution = resolveRegisteredKnowledgeSourceReference(reference, registeredSources);
        const source = resolution.targetId ? sourceRecords.get(resolution.targetId) : undefined;
        if (!resolution.resolved || !source) throw new NotebookError('invalid_request');
        if (source.originatingThreadId) permitThreadDisclosure(source.originatingThreadId);
        const material = input.store.readKnowledgeSourceMaterial(workspaceId, source.id);
        if (
          material === null ||
          `sha256:${createHash('sha256').update(material).digest('hex')}` !== source.contentDigest
        )
          throw new NotebookError('recovery_required');
        resolved.add(reference);
      } else if (reference.startsWith('knowledge:')) {
        const match = /^knowledge:([^@]+)(?:@(sha256:[a-f0-9]{64}))?$/.exec(reference);
        if (!match) throw new NotebookError('invalid_request');
        const sourcePath = `${match[1]}.md`;
        const changed = changes.get(sourcePath);
        const sourceContent = changes.has(sourcePath)
          ? changed
          : base.entries[sourcePath]
            ? input.notebook.readRevision(base.revision, [sourcePath]).files[sourcePath]
            : undefined;
        if (
          typeof sourceContent !== 'string' ||
          (match[2] &&
            match[2] !== `sha256:${createHash('sha256').update(sourceContent).digest('hex')}`)
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
            'workspace_access_denied',
            'Notebook source disclosure denied.',
            403
          );
        checkPage(sourcePath, sourceContent);
        resolved.add(reference);
      } else if (reference.startsWith('turn:')) {
        const turn = input.store.getTurnById(reference.slice('turn:'.length));
        if (turn.workspaceId !== workspaceId || !resolved.has(reference))
          throw new NotebookError('invalid_request');
        permitThreadDisclosure(turn.threadId);
      } else if (!resolved.has(reference)) {
        throw new NotebookError('invalid_request');
      }
    }
    active.delete(path);
    visited.add(path);
    resolvedReferences.set(path.slice(0, -3), resolved);
  };
  for (const { path, content } of input.request.changes)
    if (content !== null) checkPage(path, content);
  return { scopeSchemaText, registeredSources, resolvedReferences, reviewRequiredPageIds };
}
