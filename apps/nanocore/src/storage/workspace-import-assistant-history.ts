import { createHash } from 'node:crypto';
import {
  type ConversationRetrievalTrace,
  ConversationRetrievalTraceSchema,
  type ProductRetrievalTrace,
} from '@openkit/app-api-schemas';
import {
  type Item,
  ItemSchema,
  parseReferenceScope,
  type RetrievalTraceReference,
  RetrievalTraceReferenceSchema,
  type ThreadSchema,
  TurnSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import {
  internalContextEvidenceEntries,
  mapInternalContextEvidenceReferences,
} from '../internal-agents/internal-context-evidence.js';
import {
  internalContextDigest,
  internalContextHistoryBody,
  internalContextRange,
  internalContextSourceDigest,
} from '../internal-agents/rolling-context.js';
import { retrievalTraceRelativePath } from './retrieval-traces.js';
import {
  parseWorkspaceRetrievalTraceFile,
  serializeWorkspaceRetrievalTrace,
} from './workspace-portable-file-state.js';

type Turn = z.infer<typeof TurnSchema>;
type Thread = z.infer<typeof ThreadSchema>;

/** Existing import facts needed only by Assistant history and summary proof reconstruction. */
interface AssistantHistoryImportContext {
  readonly files: ReadonlyMap<string, string>;
  readonly report: { readonly exportedWorkspaceId: string };
  readonly targetWorkspaceId: string;
  readonly targetServerId?: string;
  readonly itemLineage: ReadonlyMap<string, Item>;
  readonly itemIds: ReadonlyMap<string, string>;
  readonly threadIds: ReadonlyMap<string, string>;
  readonly turnIds: ReadonlyMap<string, string>;
}

/** Canonical owner projections at the import stage concerned. */
interface AssistantHistoryCanonical {
  readonly turns: readonly Turn[];
  readonly itemRevisions: readonly Item[];
}

/** Remints only in-package causal parents; external lineage supplies no authority. */
export function remintAssistantThreadParents(
  threads: Thread[],
  threadIds: ReadonlyMap<string, string>
): void {
  const targets = new Set(threadIds.values());
  for (const thread of threads) {
    const parent = thread.parentThreadId;
    if (!parent) continue;
    const mapped = threadIds.get(parent);
    if (mapped) thread.parentThreadId = mapped;
    else if (targets.has(parent))
      throw new Error('Unresolved source Thread parent collides with a target Thread.');
  }
}

/** Rewrites exact summary endpoints before later source-proof reconciliation. */
export function remintAssistantSummaryItem(item: Item, itemIds: ReadonlyMap<string, string>) {
  if (item.type !== 'context-summary') return {};
  return {
    sourceRange: {
      ...item.sourceRange,
      firstItemId: requiredMapValue(itemIds, item.sourceRange.firstItemId, 'Item'),
      lastItemId: requiredMapValue(itemIds, item.sourceRange.lastItemId, 'Item'),
    },
    ...(item.previousSummary
      ? {
          previousSummary: {
            ...item.previousSummary,
            itemId: requiredMapValue(itemIds, item.previousSummary.itemId, 'Item'),
          },
        }
      : {}),
  };
}

/** Validates one original conversation trace and remints its exact sources, range and cursor. */
export function importAssistantHistoryTrace(input: {
  readonly context: AssistantHistoryImportContext;
  readonly sourceTrace: ConversationRetrievalTrace;
  readonly sourceReference: RetrievalTraceReference;
  readonly targetReference: RetrievalTraceReference;
  readonly targetThreadId: string;
  readonly targetTurnId: string | undefined;
  readonly sourceTurnRecords: readonly Turn[];
  readonly targetCanonical: AssistantHistoryCanonical;
  readonly targetItems: ReadonlyMap<string, Item>;
  readonly files: Map<string, ProductRetrievalTrace>;
  readonly references: Map<string, RetrievalTraceReference>;
}): void {
  const {
    context,
    sourceTrace,
    sourceReference,
    targetReference,
    targetThreadId,
    targetTurnId,
    sourceTurnRecords,
    targetCanonical,
    targetItems,
    files,
    references,
  } = input;
  const selected = sourceTrace.selected.map((entry) => {
    const sourceItem = context.itemLineage.get(entry.reference.itemId);
    if (
      !sourceItem ||
      sourceItem.type === 'reasoning' ||
      sourceItem.type === 'context-summary' ||
      sourceItem.workspaceId !== entry.reference.workspaceId ||
      sourceItem.threadId !== entry.reference.threadId ||
      sourceItem.turnId !== entry.reference.turnId ||
      entry.reference.workspaceId !== context.report.exportedWorkspaceId ||
      entry.revision !==
        `sha256:${createHash('sha256').update(JSON.stringify(sourceItem)).digest('hex')}` ||
      entry.digest !==
        `sha256:${createHash('sha256').update(internalContextHistoryBody(sourceItem)).digest('hex')}`
    )
      throw new Error('Portable conversation trace does not match its canonical Item.');
    const targetId = requiredMapValue(context.itemIds, sourceItem.id, 'Item');
    const targetItem = targetItems.get(targetId);
    if (!targetItem || targetItem.type === 'reasoning' || targetItem.type === 'context-summary')
      throw new Error('Portable conversation trace has no reminted Item.');
    return {
      reference: {
        workspaceId: targetItem.workspaceId,
        threadId: targetItem.threadId,
        turnId: targetItem.turnId,
        itemId: targetItem.id,
      },
      revision: `sha256:${createHash('sha256').update(JSON.stringify(targetItem)).digest('hex')}`,
      digest: `sha256:${createHash('sha256').update(internalContextHistoryBody(targetItem)).digest('hex')}`,
    };
  });
  let retrievalParameters = sourceTrace.retrievalParameters;
  if (retrievalParameters.mode === 'range') {
    const sourceRange = retrievalParameters.range;
    const { items: sourceItems, strategy } = importedContextRange(
      sourceTurnRecords,
      sourceRange.threadId,
      sourceTrace.queryContext.turnId,
      sourceRange.firstItemId,
      sourceRange.lastItemId,
      sourceRange.sourceDigest
    );
    if (
      sourceRange.sourceDigest !==
      internalContextSourceDigest(
        {
          getTurnById: (id) =>
            requiredMapValue(new Map(sourceTurnRecords.map((turn) => [turn.id, turn])), id, 'Turn'),
        },
        sourceItems,
        strategy
      )
    )
      throw new Error('Portable exact history range is contradictory.');
    const rangeThreadId = requiredMapValue(context.threadIds, sourceRange.threadId, 'Thread');
    const firstItemId = requiredMapValue(context.itemIds, sourceRange.firstItemId, 'Item');
    const lastItemId = requiredMapValue(context.itemIds, sourceRange.lastItemId, 'Item');
    const { items: targetRange } = importedContextRange(
      targetCanonical.turns,
      rangeThreadId,
      targetTurnId!,
      firstItemId,
      lastItemId,
      sourceRange.sourceDigest,
      strategy
    );
    retrievalParameters = {
      ...retrievalParameters,
      range: {
        threadId: rangeThreadId,
        firstItemId,
        lastItemId,
        sourceDigest: internalContextSourceDigest(
          {
            getTurnById: (id) =>
              requiredMapValue(
                new Map(targetCanonical.turns.map((turn) => [turn.id, turn])),
                id,
                'Turn'
              ),
          },
          targetRange,
          strategy
        ),
      },
      ...(retrievalParameters.cursor
        ? {
            cursor: {
              ...retrievalParameters.cursor,
              itemId: requiredMapValue(context.itemIds, retrievalParameters.cursor.itemId, 'Item'),
            },
          }
        : {}),
    };
  }
  const targetTrace = ConversationRetrievalTraceSchema.parse({
    ...sourceTrace,
    queryContext: {
      ...sourceTrace.queryContext,
      serverId: context.targetServerId,
      workspaceId: context.targetWorkspaceId,
      threadId: targetThreadId,
      turnId: targetTurnId,
    },
    selected,
    retrievalParameters,
  });
  const targetPath = retrievalTraceRelativePath(targetReference);
  parseWorkspaceRetrievalTraceFile(
    targetPath,
    serializeWorkspaceRetrievalTrace(targetTrace),
    context.targetWorkspaceId
  );
  const key = `${sourceReference.scopeId}\0${sourceReference.objectId}`;
  if (references.has(key) || files.has(targetPath))
    throw new Error('Portable retrieval trace identity is duplicated.');
  references.set(key, targetReference);
  files.set(targetPath, targetTrace);
}

/** Rebinds derived conversation evidence after all canonical owner remints, retaining exact source history. */
export function reconcileImportedAssistantContext(
  context: AssistantHistoryImportContext,
  canonical: AssistantHistoryCanonical,
  traces: Map<string, ProductRetrievalTrace>,
  sourceTurns: readonly Turn[]
) {
  const sourceTurnMap = new Map(sourceTurns.map((turn) => [turn.id, turn]));
  const targetTurnMap = new Map(canonical.turns.map((turn) => [turn.id, turn]));
  const sourceEvidence = [...context.files]
    .filter(([path]) =>
      /^workspace-files\/threads\/[^/]+\/(?:turns\/[^/]+\/)?retrieval-traces\/[^/]+\.json$/.test(
        path
      )
    )
    .map(([path, text]) =>
      parseWorkspaceRetrievalTraceFile(
        path.slice('workspace-files/'.length),
        text,
        context.report.exportedWorkspaceId
      )
    );
  const evidenceDigest = (
    items: readonly Item[],
    entries: typeof sourceEvidence,
    strategy: 'rolling' | 'compaction'
  ) =>
    internalContextDigest({
      version: 1,
      entries: internalContextEvidenceEntries(items, entries, strategy),
    });
  const compactionTurns = new Set(
    canonical.turns
      .filter((turn) =>
        turn.items.some((item) => item.type === 'context-summary' && item.strategy === 'compaction')
      )
      .map((turn) => turn.id)
  );
  const remintEvidence = (item: Item) =>
    compactionTurns.has(item.turnId) ? remintToolEvidence(item, context) : item;
  canonical = {
    itemRevisions: canonical.itemRevisions.map(remintEvidence),
    turns: canonical.turns.map((turn) => ({
      ...turn,
      items: turn.items.map(remintEvidence),
    })),
  };
  const currentItems = new Map(canonical.itemRevisions.map((item) => [item.id, item]));
  // Work Resource import can change a Worker input's owned representation after initial trace reminting.
  for (const [path, trace] of traces) {
    if (!('sourceKind' in trace)) continue;
    const selected = trace.selected.map((entry) => {
      const item = requiredMapValue(currentItems, entry.reference.itemId, 'Item');
      return {
        ...entry,
        revision: internalContextDigest(item),
        digest: `sha256:${createHash('sha256').update(internalContextHistoryBody(item)).digest('hex')}`,
      };
    });
    let retrievalParameters = trace.retrievalParameters;
    if (retrievalParameters.mode === 'range') {
      const range = retrievalParameters.range;
      const { items, strategy } = importedContextRange(
        canonical.turns,
        range.threadId,
        trace.queryContext.turnId,
        range.firstItemId,
        range.lastItemId,
        range.sourceDigest
      );
      retrievalParameters = {
        ...retrievalParameters,
        range: {
          ...range,
          sourceDigest: internalContextSourceDigest(
            { getTurnById: (id) => requiredMapValue(targetTurnMap, id, 'Turn') },
            items,
            strategy
          ),
        },
      };
    }
    traces.set(
      path,
      ConversationRetrievalTraceSchema.parse({ ...trace, selected, retrievalParameters })
    );
  }
  const targetEvidence = [...traces].map(([path, trace]) =>
    parseWorkspaceRetrievalTraceFile(
      path,
      serializeWorkspaceRetrievalTrace(trace),
      context.targetWorkspaceId
    )
  );
  const updated = new Map<string, Item>();
  const sourceSummaries = [...context.itemLineage.values()]
    .filter(
      (item): item is Extract<Item, { type: 'context-summary' }> => item.type === 'context-summary'
    )
    .sort((left, right) => left.sourceRange.itemCount - right.sourceRange.itemCount);
  for (const source of sourceSummaries) {
    const { items: originals } = importedContextRange(
      sourceTurns,
      source.threadId,
      source.turnId,
      source.sourceRange.firstItemId,
      source.sourceRange.lastItemId,
      source.sourceRange.sourceDigest,
      source.strategy
    );
    if (
      originals.length !== source.sourceRange.itemCount ||
      source.sourceRange.sourceDigest !==
        internalContextSourceDigest(
          { getTurnById: (id) => requiredMapValue(sourceTurnMap, id, 'Turn') },
          originals,
          source.strategy
        ) ||
      source.sourceRange.evidenceDigest !==
        evidenceDigest(originals, sourceEvidence, source.strategy)
    )
      throw new Error('Portable continuation summary source proof is contradictory.');
    const item = requiredMapValue(
      currentItems,
      requiredMapValue(context.itemIds, source.id, 'Item'),
      'Item'
    );
    if (item.type !== 'context-summary')
      throw new Error('Portable continuation summary kind changed.');
    // Verify the original chain before a changed target order can retain an unusable proof.
    let previousSummary = item.previousSummary;
    if (source.previousSummary) {
      const originalPrevious = requiredMapValue(
        context.itemLineage,
        source.previousSummary.itemId,
        'Item'
      );
      if (source.previousSummary.digest !== internalContextDigest(originalPrevious))
        throw new Error('Portable continuation summary predecessor is contradictory.');
      const previous = requiredMapValue(
        updated,
        requiredMapValue(context.itemIds, originalPrevious.id, 'Item'),
        'Summary'
      );
      previousSummary = { itemId: previous.id, digest: internalContextDigest(previous) };
    }
    const { items: range } = importedContextRange(
      canonical.turns,
      item.threadId,
      item.turnId,
      item.sourceRange.firstItemId,
      item.sourceRange.lastItemId,
      item.sourceRange.sourceDigest,
      item.strategy
    );
    if (
      range.length !== originals.length ||
      range.some((candidate, index) => candidate.id !== context.itemIds.get(originals[index]!.id))
    ) {
      // A changed canonical order cannot authorize reuse of the source summary; retain its stale proof for safe refusal.
      updated.set(item.id, item);
      continue;
    }
    updated.set(
      item.id,
      ItemSchema.parse({
        ...item,
        sourceRange: {
          ...item.sourceRange,
          sourceDigest: internalContextSourceDigest(
            { getTurnById: (id) => requiredMapValue(targetTurnMap, id, 'Turn') },
            range,
            item.strategy
          ),
          evidenceDigest: evidenceDigest(range, targetEvidence, item.strategy),
        },
        ...(previousSummary ? { previousSummary } : {}),
      })
    );
  }
  const itemRevisions = canonical.itemRevisions.map((item) => updated.get(item.id) ?? item);
  const turns = canonical.turns.map((turn) =>
    TurnSchema.parse({ ...turn, items: turn.items.map((item) => updated.get(item.id) ?? item) })
  );
  return { itemRevisions, turns };
}

/** Remints generated trace references in structured Tool results; arbitrary text stays unchanged. */
function remintToolEvidence(item: Item, context: AssistantHistoryImportContext): Item {
  if (item.type !== 'tool-call' || !item.result || !['completed', 'failed'].includes(item.status))
    return item;
  const result = mapInternalContextEvidenceReferences(item.result, (reference) => {
    const scope = parseReferenceScope(reference.scopeId);
    if (
      !scope ||
      scope.family !== 'retrieval-trace' ||
      scope.kind !== 'turn' ||
      scope.workspaceId !== context.report.exportedWorkspaceId
    )
      throw new Error('Portable Tool result trace owner is contradictory.');
    return RetrievalTraceReferenceSchema.parse({
      scopeId: `retrieval-trace/turn/${context.targetWorkspaceId}/${requiredMapValue(context.threadIds, scope.threadId, 'Thread')}/${requiredMapValue(context.turnIds, scope.turnId, 'Turn')}`,
      objectId: reference.objectId,
    });
  });
  return result === item.result ? item : { ...item, result };
}

/** Reconstructs the same exact source range during portable reminting without opening another store. */
function importedContextRange(
  turns: readonly Turn[],
  threadId: string,
  queryTurnId: string,
  firstItemId: string,
  lastItemId: string,
  sourceDigest: string,
  strategy?: 'rolling' | 'compaction'
): ReturnType<typeof internalContextRange> {
  const query = turns.find((turn) => turn.id === queryTurnId);
  if (!query) throw new Error('Portable exact history query Turn is missing.');
  return internalContextRange(
    {
      listThreadTurns: (workspaceId, selectedThreadId) =>
        turns.filter(
          (turn) => turn.workspaceId === workspaceId && turn.threadId === selectedThreadId
        ),
      getTurnById: (id) => {
        const turn = turns.find((turn) => turn.id === id);
        if (!turn) throw new Error('Portable exact history source Turn is missing.');
        return turn;
      },
    },
    query,
    { threadId, firstItemId, lastItemId, sourceDigest },
    strategy
  );
}

/** Resolves only references admitted by the existing import identity maps. */
function requiredMapValue<T>(records: ReadonlyMap<string, T>, sourceId: string, label: string): T {
  const record = records.get(sourceId);
  if (record === undefined)
    throw new Error(`${label} references missing exported state: ${sourceId}`);
  return record;
}
