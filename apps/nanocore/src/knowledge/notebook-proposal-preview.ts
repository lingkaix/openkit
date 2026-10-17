import { join } from 'node:path';
import {
  KNOWLEDGE_PROPOSAL_PREVIEW_CHUNK_UNITS,
  KNOWLEDGE_PROPOSAL_PREVIEW_RESPONSE_BYTES,
  type ReadKnowledgeProposalRequest,
  type ReadKnowledgeProposalResponse,
  ReadKnowledgeProposalResponseSchema,
} from '@openkit/app-api-schemas';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { type OperationImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';

/** Current publication/source owners reused only for a read; this feature retains no state. */
type Dependencies = Pick<
  OperationInvocationDependencies,
  | 'coreDb'
  | 'store'
  | 'repositoryWorkspaceDb'
  | 'runtimeConfigManager'
  | 'workspaceMutationAdmission'
>;

/** Exact saved candidate preview, joined to the existing operation catalog and current human admission. */
export function createKnowledgeProposalPreviewOperationImplementations(
  dependencies: Dependencies
): Pick<OperationImplementations, 'knowledge.proposal.read'> {
  return {
    'knowledge.proposal.read': (input, context) => {
      const {
        coreDb,
        store,
        runtimeConfigManager,
        workspaceMutationAdmission,
        repositoryWorkspaceDb,
      } = dependencies;
      const dataRoot = store?.getDataRoot();
      const actor = context.actorRef;
      const requestActor = publicOperationActor(context);
      if (
        !coreDb ||
        !store ||
        !dataRoot ||
        !runtimeConfigManager ||
        !workspaceMutationAdmission ||
        !repositoryWorkspaceDb
      )
        throw new OperationError(
          'operation_storage_unavailable',
          'Proposal preview is unavailable.',
          503
        );
      if (actor.kind !== 'user' || actor.id !== requestActor.userId)
        throw new OperationError('workspace_access_denied', 'Proposal preview access denied.', 403);
      const proposal = store.getKnowledgeProposal(input.proposalId);
      if (!proposal || proposal.workspaceId !== input.workspaceId)
        throw new OperationError('workspace_access_denied', 'Proposal preview access denied.', 403);
      const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
      try {
        // This verifier owns the exact saved document, retained candidate ref and fixed-base change set.
        const saved = proposal;
        const proposalDigest = store.knowledgeProposalDigest(input.workspaceId, input.proposalId);
        const notebook = new KnowledgeNotebook({
          repositoryPath: join(
            dataRoot,
            'workspaces',
            input.workspaceId,
            'knowledge',
            'notebook.git'
          ),
        });
        if (notebook.publishedRevision() !== saved.baseRevision)
          throw new OperationError(
            'conflict',
            'Saved Proposal base is stale. Create a new Proposal.',
            409
          );
        const paths = saved.changes?.map(({ path }) => path) ?? [`${saved.knowledgePageId}.md`];
        const before = notebook.readRevision(saved.baseRevision).files;
        const candidate = notebook.readRevision(saved.candidateRevision);
        const after = candidate.files;
        // Admit both complete versions before disclosing even an inventory or a single selected path.
        for (const files of [before, after])
          readWorkspaceNotebookAdmission({
            store,
            coreDb,
            workspaceDb,
            notebook,
            actor,
            requestActor,
            runtimeConfigManager,
            workspaceMutationAdmission,
            request: {
              workspaceId: input.workspaceId,
              requestId: candidate.metadata.changeRequest.requestId,
              baseRevision: saved.baseRevision,
              summary: saved.rationale,
              changes: paths.map((path) => ({ path, content: files[path] ?? null })),
            },
          });
        const tuple = {
          proposalId: saved.id,
          proposalDigest,
          baseRevision: saved.baseRevision,
          candidateRevision: saved.candidateRevision,
          paths,
        };
        return projectKnowledgeProposalPreview(tuple, before, after, input);
      } catch (error) {
        if (error instanceof OperationError) throw error;
        if (error instanceof NotebookError && error.code === 'invalid_request')
          throw new OperationError(
            'workspace_access_denied',
            'Proposal or Source is unavailable.',
            403
          );
        throw new OperationError(
          'recovery_required',
          'Saved Proposal evidence is unavailable.',
          503
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    },
  };
}

/** Shared exact candidate inventory/chunks; current owner admission runs before this inert projection. */
export function projectKnowledgeProposalPreview(
  tuple: Pick<
    ReadKnowledgeProposalResponse,
    'proposalId' | 'proposalDigest' | 'baseRevision' | 'candidateRevision' | 'paths'
  >,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  input: Pick<ReadKnowledgeProposalRequest, 'path' | 'offset'>
): ReadKnowledgeProposalResponse {
  const paths = tuple.paths;
  if (input.path === undefined) return ReadKnowledgeProposalResponseSchema.parse(tuple);
  if (!paths.includes(input.path))
    throw new OperationError('invalid_request', 'Path is not in the saved Proposal.', 400);
  // The shared cursor counts Unicode code points, so shifted surrogate pairs cannot prevent progress.
  const oldText = before[input.path] === undefined ? null : Array.from(before[input.path]!);
  const newText = after[input.path] === undefined ? null : Array.from(after[input.path]!);
  const offset = input.offset;
  const maximum = Math.max(oldText?.length ?? 0, newText?.length ?? 0);
  if (offset > maximum)
    throw new OperationError('invalid_request', 'Proposal offset exceeds both versions.', 400);
  // At most two UTF-16 units per code point keeps each version within the public chunk bound.
  let end = offset + Math.min(KNOWLEDGE_PROPOSAL_PREVIEW_CHUNK_UNITS / 2, maximum - offset);
  let response: ReadKnowledgeProposalResponse;
  do {
    response = {
      ...tuple,
      path: input.path,
      before: oldText === null ? null : oldText.slice(offset, end).join(''),
      after: newText === null ? null : newText.slice(offset, end).join(''),
      nextOffset: end < maximum ? end : null,
    };
    if (Buffer.byteLength(JSON.stringify(response)) < KNOWLEDGE_PROPOSAL_PREVIEW_RESPONSE_BYTES)
      break;
    end = offset + Math.floor((end - offset) / 2);
    if (end === offset)
      throw new OperationError(
        'invalid_request',
        'Proposal inventory exceeds the preview response bound.',
        400
      );
  } while (end > offset);
  return ReadKnowledgeProposalResponseSchema.parse(response);
}
