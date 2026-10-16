import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import { readPortableWorkerContextPackageTrace } from './context/worker-context-package.js';
import { KnowledgeNotebook, NotebookError } from './knowledge/notebook.js';
import {
  type KnowledgePageReferenceProof,
  KnowledgePageValidationError,
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
} from './knowledge/okf.js';
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
 * Resolves source-only proof from exact published Git bytes and the existing source/work owners.
 *
 * @param input Exact notebook selection and current Source, Turn, Item, and S39 authorities.
 * @returns Exact Page and digest keyed source proofs; these never grant a human Review.
 */
export function resolveWorkspaceKnowledgeReferenceProofs(input: {
  /** Core scheduler and worker-session authority when available. */
  readonly coreDb: CoreDb | undefined;
  /** Product Page, Source, Turn, and Item owner. */
  readonly store: FsStore;
  /** Workspace S39 authority when available. */
  readonly workspaceDb: WorkspaceDb | undefined;
  /** Workspace that must own every referenced record. */
  readonly workspaceId: string;
  /** Exact published commit selected by this request, or current published at initial admission. */
  readonly notebookRevision?: string | undefined;
  /** Exact selected page identities; omission requests the full current notebook inventory. */
  readonly pageIds?: readonly string[] | undefined;
}): ReadonlyMap<string, KnowledgePageReferenceProof> {
  const referenceProofs = new Map<string, KnowledgePageReferenceProof>();
  const dataRoot = input.store.getDataRoot();
  if (!dataRoot) return referenceProofs;
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', input.workspaceId, 'knowledge', 'notebook.git'),
  });
  const revision = input.notebookRevision ?? notebook.publishedRevision();
  if (input.notebookRevision !== undefined) notebook.history({ revision, limit: 1 });
  const entries = notebook.inspectRevision(revision).entries;
  const ids = input.pageIds ?? Object.keys(entries).map((path) => path.slice(0, -3));
  const sources = new Map(
    input.store
      .listKnowledgeSources(input.workspaceId)
      .map((source) => [source.id, source.contentDigest])
  );
  const files = notebook.readRevision(
    revision,
    ids.filter((id) => Object.hasOwn(entries, `${id}.md`)).map((id) => `${id}.md`)
  ).files;
  for (const id of ids) {
    const path = `${id}.md`;
    if (!Object.hasOwn(entries, path)) continue;
    // Read-integrity failures are not source ineligibility and must remain explicit.
    const content = files[path]!;
    const parsed = parseOkfDocument({ path: `knowledge/pages/${path}`, content });
    if (!parsed.ok || parsed.document.reserved) continue;
    const references = stringListFrontmatterField(parsed.document, 'source_refs');
    if (!references) continue;
    const sourceReferences = [...new Set(references)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    );
    try {
      const verified = new Set(
        verifyKnowledgeProposalWorkHistory({
          ...input,
          sourceReferences,
          // Import evidence remains read-only history, never a decision for another publication.
          allowImportedHistory: Boolean(input.store.getWorkspace(input.workspaceId).importedFrom),
        }).verifiedExternalReferences
      );
      for (const reference of sourceReferences) {
        if (reference.startsWith('source:')) {
          const resolution = resolveRegisteredKnowledgeSourceReference(reference, sources);
          const source = resolution.targetId
            ? input.store.getKnowledgeSource(input.workspaceId, resolution.targetId)
            : null;
          const material = source
            ? input.store.readKnowledgeSourceMaterial(input.workspaceId, source.id)
            : null;
          if (
            !resolution.resolved ||
            !source ||
            material === null ||
            sha256(material) !== source.contentDigest
          )
            throw new KnowledgePageValidationError();
          verified.add(reference);
        } else if (reference.startsWith('knowledge:')) {
          const match = /^knowledge:([^@]+)(?:@(sha256:[a-f0-9]{64}))?$/.exec(reference);
          if (!match || !Object.hasOwn(entries, `${match[1]}.md`))
            throw new KnowledgePageValidationError();
          const source = notebook.readRevision(revision, [`${match[1]}.md`]).files[
            `${match[1]}.md`
          ]!;
          if (match[2] && sha256(source) !== match[2]) throw new KnowledgePageValidationError();
          verified.add(reference);
        } else if (!verified.has(reference)) throw new KnowledgePageValidationError();
      }
      referenceProofs.set(id, {
        contentDigest: sha256(content),
        knowledgePageId: id,
        sourceReferences,
        resolvedReferences: verified,
      });
    } catch (error) {
      if (error instanceof NotebookError) throw error;
      // Missing or contradictory current evidence supplies no source proof for these exact bytes.
    }
  }
  return referenceProofs;
}

/** Exact canonical UTF-8 content identity shared by source and page proof comparisons. */
function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
