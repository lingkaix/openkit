import { type ActorRef, responsibleUserIdForActor } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { requireUsableRecord } from '../runtime/pending-request-flow.js';
import {
  assistantPendingHandoffIds,
  assistantPendingHandoffResultItemId,
  assistantPendingOutcomeSourceHash,
  listThreadPendingRequests,
} from '../runtime/pending-requests.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';

/** Verifies receipt-free Task provenance from existing canonical owners; this grants no current execution authority. */
export function readAssistantTaskHandoffSource(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  receiving: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly requestId: string | null;
    readonly requestInputHash?: string;
    readonly modelId?: string | null;
    readonly triggerActor?: ActorRef;
    readonly turnInput?: string;
  }
) {
  let sourceDb: WorkspaceDb | undefined;
  try {
    if (!receiving.requestId) return null;
    const thread = store.getThread(receiving.workspaceId, receiving.threadId);
    const worker = store.getTurnById(receiving.turnId);
    const userId = responsibleUserIdForActor(worker.triggerActor);
    if (
      !userId ||
      worker.workspaceId !== receiving.workspaceId ||
      worker.threadId !== receiving.threadId ||
      thread.threadSource !== 'worker' ||
      !thread.parentThreadId ||
      thread.visibility !== 'workspace' ||
      (receiving.triggerActor &&
        commandInputHash(receiving.triggerActor) !== commandInputHash(worker.triggerActor))
    )
      return null;
    const sourceWorkspace = store
      .listWorkspaces()
      .find((workspace) =>
        store.listThreads(workspace.id).some((candidate) => candidate.id === thread.parentThreadId)
      );
    if (!sourceWorkspace) return null;
    sourceDb =
      sourceWorkspace.id === receiving.workspaceId
        ? workspaceDb
        : openWorkspaceDb(workspaceDb.dataRoot, sourceWorkspace.id);
    if (sourceDb !== workspaceDb) applyScopedMigrations(sourceDb);
    const records = listThreadPendingRequests(
      sourceDb.sqlite,
      sourceWorkspace.id,
      thread.parentThreadId
    );
    for (const record of records) {
      const proposed = record.assistantHandoff;
      if (
        record.requesterKind !== 'assistant' ||
        record.delivery !== 'delivered' ||
        record.deliveryCause !== 'outcome' ||
        proposed?.kind !== 'task' ||
        proposed.targetWorkspaceId !== receiving.workspaceId ||
        record.resolution !== 'answered' ||
        record.answerMap?.handoff?.[0] !== 'Confirm exact handoff' ||
        !record.deliveryTurnId ||
        record.responsibleUserId !== userId
      )
        continue;
      const source = store.getTurn(
        sourceWorkspace.id,
        thread.parentThreadId,
        record.deliveryTurnId
      );
      const result = source.items.find(
        (item) => item.id === assistantPendingHandoffResultItemId(source.id)
      );
      if (
        source.status !== 'completed' ||
        source.agentId !== 'quick-chat' ||
        source.agentSessionId ||
        responsibleUserIdForActor(source.triggerActor) !== userId ||
        result?.type !== 'status' ||
        result.status !== 'completed' ||
        result.causationId !== receiving.turnId ||
        (proposed.agentId && proposed.agentId !== worker.agentId) ||
        (proposed.modelId &&
          receiving.modelId !== undefined &&
          proposed.modelId !== receiving.modelId)
      )
        continue;
      const associated = records.filter(
        (candidate) =>
          candidate.deliveryTurnId === source.id && candidate.requesterKind === 'assistant'
      );
      for (const candidate of associated)
        requireUsableRecord(
          store,
          sourceDb.sqlite,
          candidate.requestId,
          sourceWorkspace.id,
          thread.parentThreadId
        );
      const sourceInputHash = assistantPendingOutcomeSourceHash(source, associated, userId);
      const ids = assistantPendingHandoffIds(sourceInputHash);
      if (
        receiving.requestId !== ids.requestId ||
        receiving.threadId !== ids.threadId ||
        receiving.turnId !== ids.turnId ||
        (receiving.requestInputHash && receiving.requestInputHash !== sourceInputHash)
      )
        continue;
      if (
        receiving.turnInput &&
        (JSON.parse(receiving.turnInput) as { objective?: unknown }).objective !== proposed.input
      )
        continue;
      return { sourceInputHash, sourceTurnId: source.id };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (sourceDb && sourceDb !== workspaceDb) sourceDb.sqlite.close();
  }
}
