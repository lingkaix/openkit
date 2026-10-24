import { join } from 'node:path';
import type { ProductRetrievalTrace } from '@openkit/app-api-schemas';
import {
  type Item,
  parseReferenceScope,
  type RetrievalTraceReference,
  RetrievalTraceReferenceSchema,
} from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import type { WorkspaceNotebookRead } from '../knowledge/notebook-index-source.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import {
  assertKnowledgeRetrievalSelectionReadable,
  assertKnowledgeRetrievalTraceReadable,
  prepareKnowledgeRetrievalTraceRead,
  resolveWorkspaceKnowledgeRetrievalPages,
} from '../storage/index-rebuild.js';
import { readThreadRetrievalTraces, readTurnRetrievalTraces } from '../storage/retrieval-traces.js';
import {
  type AssistantHistoryAuthority,
  assertConversationRetrievalTraceReadable,
} from './assistant-history.js';
import { internalContextDigest, internalContextSourceUnavailable } from './rolling-context.js';

/**
 * Verifies the current source dependencies of exact retained history and continuation summaries.
 *
 * The existing trace owner supplies its inventory and immutable known bytes. Current conversation and Knowledge owners prove authority and selected content revisions. A removed or changed trace changes the aggregate digest; no separate manifest or source ledger is retained.
 *
 * @param input Current actor, canonical source Items and their existing Workspace/Thread owner.
 * @returns The versioned content-free trace inventory digest after current source admission.
 */
export function readInternalContextEvidence(
  input: AssistantHistoryAuthority & {
    readonly store: FsStore;
    readonly coreDb: CoreDb;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly items: readonly Item[];
    readonly strategy?: 'rolling' | 'compaction';
    readonly notebookReads?: ReadonlyMap<string, WorkspaceNotebookRead> | undefined;
    /** KM queries alone verify their content-free-exclusion selection projection. */
    readonly knowledgeProjection?: 'selection';
    /** Trusted retained asking lineage for a query; maintenance defaults to its source Turn. */
    readonly retrievalContext?: { readonly threadId: string; readonly turnId?: string };
    /** Actual current Server credential from native query admission, never model input. */
    readonly serverKnowledgeActor?: Actor | undefined;
  }
): string {
  const { dataRoot, entries } = contextEvidenceInventory(input);
  for (const { reference, trace, access } of entries) {
    if ('sourceKind' in trace) {
      try {
        assertConversationRetrievalTraceReadable({ ...input, retrievalTraceRef: reference });
      } catch {
        throw internalContextSourceUnavailable('assertConversationRetrievalTraceReadable');
      }
    } else {
      const verifyKnowledge =
        input.strategy === 'compaction' && input.knowledgeProjection === 'selection'
          ? assertKnowledgeRetrievalSelectionReadable
          : assertKnowledgeRetrievalTraceReadable;
      try {
        verifyKnowledge({
          dataRoot,
          workspaceId: input.workspaceId,
          access: access(),
          retrievalTraceRef: reference,
          notebookRead: input.notebookReads?.get(`${reference.scopeId}/${reference.objectId}`),
        });
      } catch {
        throw internalContextSourceUnavailable(
          verifyKnowledge === assertKnowledgeRetrievalSelectionReadable
            ? 'assertKnowledgeRetrievalSelectionReadable'
            : 'assertKnowledgeRetrievalTraceReadable'
        );
      }
      try {
        if (
          resolveWorkspaceKnowledgeRetrievalPages({
            dataRoot,
            workspaceId: input.workspaceId,
            access: access(),
            retrievalTraceRef: reference,
            caller: trace.caller,
            notebookRead: input.notebookReads?.get(`${reference.scopeId}/${reference.objectId}`),
          }) === null
        )
          throw unavailable();
      } catch {
        throw internalContextSourceUnavailable('resolveWorkspaceKnowledgeRetrievalPages');
      }
    }
  }
  input.nativeAuthority?.assertCurrent();
  const canonical = entries.map(({ reference, trace }) => ({ reference, trace }));
  return internalContextDigest({ version: 1, entries: canonical });
}

/** Shares native admission and exact owned trace inputs before asynchronous content loading. */
function contextEvidenceInventory(input: Parameters<typeof readInternalContextEvidence>[0]) {
  input.nativeAuthority?.assertCurrent();
  const dataRoot = input.store.getDataRoot();
  if (!dataRoot || dataRoot !== input.coreDb.dataRoot) throw unavailable();
  const references =
    input.strategy === 'compaction' ? internalContextEvidenceReferences(input.items) : [];
  const runContext = { threadId: input.threadId, turnId: input.items[0]?.turnId };
  const contexts = [runContext, ...(input.retrievalContext ? [input.retrievalContext] : [])];
  const scopeFor = (context: { threadId: string; turnId?: string | undefined }) =>
    context.turnId === undefined
      ? `retrieval-trace/thread/${input.workspaceId}/${context.threadId}`
      : `retrieval-trace/turn/${input.workspaceId}/${context.threadId}/${context.turnId}`;
  if (
    input.strategy === 'compaction' &&
    references.some(
      (reference) => !contexts.some((context) => reference.scopeId === scopeFor(context))
    )
  )
    throw unavailable();
  const owners =
    input.strategy === 'compaction'
      ? contexts.filter(
          (context, index) =>
            contexts.findIndex((candidate) => scopeFor(candidate) === scopeFor(context)) ===
              index && references.some((reference) => reference.scopeId === scopeFor(context))
        )
      : [...new Set(input.items.map((item) => item.turnId))]
          .sort()
          .map((turnId) => ({ threadId: input.threadId, turnId }));
  const inventory = owners.flatMap((context) => {
    const turnId = context.turnId;
    try {
      if (turnId === undefined) {
        input.store.getThread(input.workspaceId, context.threadId);
        return readThreadRetrievalTraces(
          join(dataRoot, 'workspaces', input.workspaceId),
          input.workspaceId,
          context.threadId
        );
      }
      input.store.getTurn(input.workspaceId, context.threadId, turnId);
      return readTurnRetrievalTraces(
        join(dataRoot, 'workspaces', input.workspaceId),
        input.workspaceId,
        context.threadId,
        turnId
      );
    } catch {
      throw internalContextSourceUnavailable(
        turnId === undefined ? 'readThreadRetrievalTraces' : 'readTurnRetrievalTraces'
      );
    }
  });
  const entries = internalContextEvidenceEntries(input.items, inventory, input.strategy);
  return {
    dataRoot,
    entries: entries.map(({ reference, trace }) => ({
      reference,
      trace,
      access: () => ({
        store: input.store,
        coreDb: input.coreDb,
        actor: input.nativeAuthority?.actorRef ?? {
          kind: 'user' as const,
          id: input.actor!.userId,
        },
        ...((input.actor ?? input.nativeAuthority?.requestActor)
          ? { requestActor: input.actor ?? input.nativeAuthority?.requestActor }
          : {}),
        ...(input.serverKnowledgeActor ? { serverKnowledgeActor: input.serverKnowledgeActor } : {}),
        outputThreadId:
          input.strategy === 'compaction'
            ? contexts.find((context) => scopeFor(context) === reference.scopeId)!.threadId
            : input.threadId,
        outputTurnId: trace.queryContext.turnId,
      }),
    })),
  };
}

/** Prepares immutable facts only; the original synchronous reader still decides admission. */
export async function prepareInternalContextEvidenceRead(
  input: Parameters<typeof readInternalContextEvidence>[0],
  signal: AbortSignal
): Promise<ReadonlyMap<string, WorkspaceNotebookRead>> {
  const { dataRoot, entries } = contextEvidenceInventory(input);
  const notebookReads = new Map<string, WorkspaceNotebookRead>();
  for (const { reference, trace, access } of entries) {
    if ('sourceKind' in trace) continue;
    if (parseReferenceScope(trace.sourceScope)?.kind !== 'workspace') continue;
    signal.throwIfAborted();
    const prepared = await prepareKnowledgeRetrievalTraceRead({
      dataRoot,
      workspaceId: input.workspaceId,
      access: access(),
      retrievalTraceRef: reference,
    }).catch(() => {
      signal.throwIfAborted();
      throw unavailable();
    });
    signal.throwIfAborted();
    if (prepared) notebookReads.set(`${reference.scopeId}/${reference.objectId}`, prepared);
  }
  return notebookReads;
}

/** Extracts only retrieval references retained in completed canonical Tool results. */
export function internalContextEvidenceReferences(
  items: readonly Item[]
): RetrievalTraceReference[] {
  const references = new Map<string, RetrievalTraceReference>();
  for (const item of items) {
    if (
      item.type === 'tool-call' &&
      (item.status === 'completed' || item.status === 'failed') &&
      item.result
    )
      mapInternalContextEvidenceReferences(item.result, (reference) => {
        references.set(`${reference.scopeId}\0${reference.objectId}`, reference);
        return reference;
      });
  }
  return [...references.values()].sort(
    (left, right) =>
      left.scopeId.localeCompare(right.scopeId) || left.objectId.localeCompare(right.objectId)
  );
}

/** Projects generated references in structured Tool-result text, retaining every unchanged byte. */
export function mapInternalContextEvidenceReferences(
  result: string,
  project: (reference: RetrievalTraceReference) => RetrievalTraceReference
): string {
  const rewriteText = (text: string): string => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return text;
    }
    return rewrite(value) ? JSON.stringify(value) : text;
  };
  const rewrite = (value: unknown): boolean => {
    let changed = false;
    if (Array.isArray(value)) {
      for (const entry of value) changed = rewrite(entry) || changed;
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const [key, entry] of Object.entries(record)) {
        if (key === 'retrievalTraceRef') {
          const reference = RetrievalTraceReferenceSchema.parse(entry);
          const projected = project(reference);
          if (
            projected.scopeId !== reference.scopeId ||
            projected.objectId !== reference.objectId
          ) {
            record[key] = projected;
            changed = true;
          }
        } else if (key === 'text' && typeof entry === 'string') {
          const text = rewriteText(entry);
          if (text !== entry) {
            record[key] = text;
            changed = true;
          }
        } else changed = rewrite(entry) || changed;
      }
    }
    return changed;
  };
  return rewriteText(result);
}

/** Selects the existing trace inventory bound to a source range; compaction excludes later reads. */
export function internalContextEvidenceEntries(
  items: readonly Item[],
  inventory: readonly {
    readonly reference: RetrievalTraceReference;
    readonly trace: ProductRetrievalTrace;
  }[],
  strategy: 'rolling' | 'compaction' = 'rolling'
): Array<{ reference: RetrievalTraceReference; trace: ProductRetrievalTrace }> {
  const turns = new Set(items.map((item) => item.turnId));
  const required = new Set(
    internalContextEvidenceReferences(strategy === 'compaction' ? items : []).map(
      (reference) => `${reference.scopeId}\0${reference.objectId}`
    )
  );
  const entries = inventory.filter(({ reference, trace }) =>
    strategy === 'compaction'
      ? required.has(`${reference.scopeId}\0${reference.objectId}`)
      : trace.queryContext.turnId && turns.has(trace.queryContext.turnId)
  );
  if (strategy === 'compaction' && entries.length !== required.size) throw unavailable();
  return [...entries].sort(
    (left, right) =>
      (left.trace.queryContext.turnId ?? '').localeCompare(right.trace.queryContext.turnId ?? '') ||
      left.reference.objectId.localeCompare(right.reference.objectId)
  );
}

function unavailable() {
  return internalContextSourceUnavailable('readInternalContextEvidence');
}
