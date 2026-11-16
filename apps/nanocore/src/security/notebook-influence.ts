import type { ActorRef } from '@openkit/protocol';
import type { KnowledgeNotebook } from '../knowledge/notebook.js';
import type { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import {
  contextIsExternallyInfluenced,
  readContextInfluenceTurn,
  receiveContextInfluence,
} from './context-influence.js';

/** Resolves revision provenance only from the exact inherited revision and the trusted writing context. */
export function notebookWriteInfluence(input: {
  readonly notebook: KnowledgeNotebook;
  readonly baseRevision: string;
  readonly producer: ActorRef;
  readonly store?: FsStore;
  readonly sourceTurnId?: string | null;
}): boolean {
  const inherited = contextIsExternallyInfluenced(
    input.notebook.inspectRevision(input.baseRevision).metadata
  );
  if (inherited) return true;
  return notebookWritingContextInfluence(input);
}

/** Reads only native invocation lineage; operation JSON cannot select the writing context. */
export function notebookOperationWritingContext(context: AdmittedOperationContext): {
  sourceTurnId?: string | null;
} {
  const sourceTurnId =
    context.kind === 'worker'
      ? context.lineage.turnId
      : context.kind === 'coordinator'
        ? context.turnId
        : context.delivery === 'model'
          ? context.queryContext?.turnId
          : undefined;
  // A remote model invocation has no local Turn; unknown provenance is restrictive, not a read refusal.
  return sourceTurnId
    ? { sourceTurnId }
    : context.delivery === 'model'
      ? { sourceTurnId: null }
      : {};
}

/** Resolves a first revision's provenance without inventing a clear inherited revision. */
export function notebookWritingContextInfluence(input: {
  readonly producer: ActorRef;
  readonly store?: FsStore;
  readonly sourceTurnId?: string | null;
}): boolean {
  if (input.sourceTurnId === null) return true;
  if (!input.sourceTurnId) return input.producer.kind !== 'user';
  if (!input.store) throw new Error('Notebook writing context is unavailable.');
  const turn = readContextInfluenceTurn(input.store, input.sourceTurnId);
  return (
    contextIsExternallyInfluenced(turn) ||
    (turn.agentSessionId != null &&
      contextIsExternallyInfluenced(input.store.getAgentSession(turn.agentSessionId)))
  );
}

/** Carries exact disclosed Notebook revision provenance into a local model invocation before its result returns. */
export async function receiveNotebookOperationDisclosure(
  context: AdmittedOperationContext,
  store: FsStore,
  notebook: KnowledgeNotebook,
  result: unknown
): Promise<void> {
  const { sourceTurnId } = notebookOperationWritingContext(context);
  if (!sourceTurnId) return; // A human browse or remote model has no local receiving execution.
  const revisions = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.availability === 'unavailable') return;
    for (const [key, entry] of Object.entries(record)) {
      if (
        [
          'notebookRevision',
          'revision',
          'baseRevision',
          'fromRevision',
          'candidateRevision',
        ].includes(key) &&
        typeof entry === 'string' &&
        /^[a-f0-9]{40}$/.test(entry)
      )
        revisions.add(entry);
      else if (entry && typeof entry === 'object') visit(entry);
    }
  };
  visit(result);
  // Source metadata and first-class Memory lists use the current selected Notebook without a revision in their output.
  if (!revisions.size) revisions.add(notebook.publishedRevision());
  const turn = readContextInfluenceTurn(store, sourceTurnId);
  for (const revision of revisions)
    await receiveContextInfluence(
      { store, outputThreadId: turn.threadId, outputTurnId: turn.id },
      notebook.inspectRevision(revision).metadata
    );
}
