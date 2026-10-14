import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import { readPortableWorkerContextPackageTrace } from './context/worker-context-package.js';
import { type KnowledgePageReferenceProof, KnowledgePageValidationError } from './knowledge/okf.js';
import type { FsStore } from './lib/store.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { resolveDataRootPath } from './storage/fs-layout.js';

/** Exact completed-work evidence accepted from one Knowledge source request. */
export interface KnowledgeProposalWorkHistoryVerification {
  /** Exact non-Knowledge references already verified by their owning domains. */
  readonly verifiedExternalReferences: readonly string[];
}

/**
 * Verifies the sole completed-work reference shape against current Turn, Item, and S39 owners.
 *
 * @param input Knowledge source references and existing owner handles.
 * @returns Exact references safe to pass through the Knowledge Store boundary.
 * @throws KnowledgePageValidationError when any claimed completed-work owner is absent or changed.
 */
export function verifyKnowledgeProposalWorkHistory(input: {
  /** Allows imported-history proof only while reading an already accepted imported Page. */
  readonly allowImportedHistory?: boolean | undefined;
  /** Core scheduler and worker-session authority when available. */
  readonly coreDb: CoreDb | undefined;
  /** Closed normalized references carried by the Knowledge record. */
  readonly sourceReferences: readonly string[];
  /** Product Turn and Item owner. */
  readonly store: FsStore;
  /** Workspace S39 authority when available. */
  readonly workspaceDb: WorkspaceDb | undefined;
  /** Workspace that must own every completed-work record. */
  readonly workspaceId: string;
}): KnowledgeProposalWorkHistoryVerification {
  const workReferences = input.sourceReferences.filter((reference) =>
    /^(?:turn|item|context-package):/.test(reference)
  );
  if (workReferences.length === 0) {
    return {
      verifiedExternalReferences: [],
    };
  }

  const turnReferences = workReferences.filter((reference) => reference.startsWith('turn:'));
  const itemReferences = workReferences.filter((reference) => reference.startsWith('item:'));
  const contextReferences = workReferences.filter((reference) =>
    reference.startsWith('context-package:')
  );
  if (
    workReferences.length !== 3 ||
    turnReferences.length !== 1 ||
    itemReferences.length !== 1 ||
    contextReferences.length !== 1 ||
    !input.coreDb ||
    !input.workspaceDb
  ) {
    throw new KnowledgePageValidationError();
  }

  const turnId = turnReferences[0]!.slice('turn:'.length);
  const itemId = itemReferences[0]!.slice('item:'.length);
  const contextMatch = /^context-package:([^@]+)@(ctxpkg_sha256_[a-f0-9]{64})$/.exec(
    contextReferences[0]!
  );
  try {
    if (!contextMatch || contextMatch[1] !== turnId) {
      throw new Error('Completed-work reference lineage does not match.');
    }
    const turn = input.store.getTurnById(turnId);
    if (turn.workspaceId !== input.workspaceId || turn.status !== 'completed') {
      throw new Error('Completed-work Turn is not eligible.');
    }

    const finalAssistantItem = input.store
      .listThreadItems(input.workspaceId, turn.threadId)
      .filter(
        (item) =>
          item.turnId === turn.id &&
          item.type === 'assistant-message' &&
          item.status === 'completed'
      )
      .at(-1);
    if (!finalAssistantItem || finalAssistantItem.id !== itemId) {
      throw new Error('Completed-work Item is not the final assistant result.');
    }

    const { trace, verification } = readPortableWorkerContextPackageTrace({
      authorities: createWorkerContextPackageAuthorityReader({
        coreDb: input.coreDb,
        store: input.store,
        workspaceDb: input.workspaceDb,
      }),
      workspaceId: input.workspaceId,
      threadId: turn.threadId,
      turnId,
      workspaceRoot: resolveDataRootPath(
        input.workspaceDb.dataRoot,
        'workspaces',
        input.workspaceId
      ),
    });
    if (
      (verification !== 'strict' && !input.allowImportedHistory) ||
      trace.goalId !== null ||
      trace.taskId !== null ||
      trace.knowledgeSelectionInput === null ||
      trace.contextPackageDigest !== contextMatch[2]
    ) {
      throw new Error('Completed-work Context Package is not an exact direct-Task trace.');
    }
  } catch {
    throw new KnowledgePageValidationError();
  }

  return {
    verifiedExternalReferences: workReferences,
  };
}

/**
 * Resolves current Page-bound source proof from the existing Proposal, Review, and source owners.
 *
 * @param input Existing Proposal, Review, Page, Turn, Item, and S39 authorities.
 * @returns Exact Page and digest keyed proofs whose current owner tuples remain coherent.
 */
export function resolveWorkspaceKnowledgeReferenceProofs(input: {
  /** Core scheduler and worker-session authority when available. */
  readonly coreDb: CoreDb | undefined;
  /** Product Proposal, Review, Page, Turn, and Item owner. */
  readonly store: FsStore;
  /** Workspace S39 authority when available. */
  readonly workspaceDb: WorkspaceDb | undefined;
  /** Workspace that must own every referenced record. */
  readonly workspaceId: string;
}): ReadonlyMap<string, KnowledgePageReferenceProof> {
  const referenceProofs = new Map<string, KnowledgePageReferenceProof>();

  for (const proposal of input.store.listKnowledgeProposals(input.workspaceId)) {
    const review = input.store.getKnowledgeProposalReviewDecision(proposal.id);
    if (!review || review.decision !== 'accepted') {
      continue;
    }

    try {
      const verification = verifyKnowledgeProposalWorkHistory({
        coreDb: input.coreDb,
        sourceReferences: proposal.sourceReferences,
        store: input.store,
        workspaceDb: input.workspaceDb,
        workspaceId: input.workspaceId,
      });
      const proof = input.store.projectKnowledgeProposalReferenceProof(
        input.workspaceId,
        review.reviewId,
        verification.verifiedExternalReferences
      );
      referenceProofs.set(proof.knowledgePageId, proof);
    } catch {
      // An incoherent owner tuple remains excluded by normal Knowledge validation.
    }
  }

  if (input.store.getWorkspace(input.workspaceId).importedFrom) {
    for (const entry of input.store.getWorkspaceResources(input.workspaceId).knowledge) {
      if (referenceProofs.has(entry.id)) {
        continue;
      }
      try {
        const verification = verifyKnowledgeProposalWorkHistory({
          allowImportedHistory: true,
          coreDb: input.coreDb,
          sourceReferences: entry.sourceReferences ?? [],
          store: input.store,
          workspaceDb: input.workspaceDb,
          workspaceId: input.workspaceId,
        });
        const proof = input.store.projectImportedKnowledgePageReferenceProof(
          input.workspaceId,
          entry.id,
          verification.verifiedExternalReferences
        );
        referenceProofs.set(proof.knowledgePageId, proof);
      } catch {
        // Imported Pages remain excluded when their reminted current owners do not verify.
      }
    }
  }

  return referenceProofs;
}
