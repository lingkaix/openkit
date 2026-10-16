import { join } from 'node:path';
import type { Item } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
} from '../storage/index-rebuild.js';
import { readTurnRetrievalTraces } from '../storage/retrieval-traces.js';
import { assertConversationRetrievalTraceReadable } from './assistant-history.js';
import { InternalAgentProviderError } from './internal-agent-loop.js';
import { internalContextDigest } from './rolling-context.js';

/**
 * Verifies the current source dependencies of exact retained history and continuation summaries.
 *
 * The existing trace owner supplies its inventory and immutable known bytes. Current conversation and Knowledge owners prove authority and selected content revisions. A removed or changed trace changes the aggregate digest; no separate manifest or source ledger is retained.
 *
 * @param input Current actor, canonical source Items and their existing Workspace/Thread owner.
 * @returns The versioned content-free trace inventory digest after current source admission.
 */
export function readInternalContextEvidence(input: {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly actor: Actor;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly items: readonly Item[];
}): string {
  const dataRoot = input.store.getDataRoot();
  if (!dataRoot || dataRoot !== input.coreDb.dataRoot) throw unavailable();
  const entries = [...new Set(input.items.map((item) => item.turnId))]
    .sort()
    .flatMap((turnId) =>
      readTurnRetrievalTraces(
        join(dataRoot, 'workspaces', input.workspaceId),
        input.workspaceId,
        input.threadId,
        turnId
      )
    );
  for (const { reference, trace } of entries) {
    if ('sourceKind' in trace) {
      assertConversationRetrievalTraceReadable({ ...input, retrievalTraceRef: reference });
    } else {
      const access = {
        store: input.store,
        coreDb: input.coreDb,
        actor: { kind: 'user' as const, id: input.actor.userId },
        requestActor: input.actor,
        outputThreadId: input.threadId,
        outputTurnId: trace.queryContext.turnId,
      };
      assertKnowledgeRetrievalTraceReadable({
        dataRoot,
        workspaceId: input.workspaceId,
        access,
        retrievalTraceRef: reference,
      });
      if (
        resolveWorkspaceKnowledgeRetrievalPages({
          dataRoot,
          workspaceId: input.workspaceId,
          access,
          retrievalTraceRef: reference,
          caller: trace.caller,
        }) === null
      )
        throw unavailable();
    }
  }
  return internalContextDigest({ version: 1, entries });
}

function unavailable(): InternalAgentProviderError {
  return new InternalAgentProviderError(
    'internal_agent_context_exceeded',
    'Required internal context source evidence is unavailable.'
  );
}
