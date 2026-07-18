import {
  AgentSessionReadModelSchema,
  type RuntimeConfigStaleSession,
} from '@openkit/app-api-schemas';

import { createRuntimeConfigStaleSession } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type {
  AgentSessionBackendControlSummary,
  AgentSessionReadModel,
  TurnExecutor,
} from './types.js';
import type {
  WorkerControlGateway,
  WorkerControlSessionSnapshot,
} from './worker-control-gateway.js';

/**
 * Finds one persisted agent session by id within a workspace.
 *
 * @param store Store that owns workspace session lineage.
 * @param workspaceId Workspace to search.
 * @param sessionId Agent session id to find.
 * @returns Matching persisted session, or null when absent.
 */
export function findStoredAgentSessionById(
  store: FsStore,
  workspaceId: string,
  sessionId: string
): ReturnType<FsStore['listThreadAgentSessions']>[number] | null {
  for (const thread of store.listThreads(workspaceId)) {
    const session = store
      .listThreadAgentSessions(workspaceId, thread.id)
      .find((candidate) => candidate.id === sessionId);

    if (session) {
      return session;
    }
  }

  return null;
}

/**
 * Returns the current thread-bound agent session read model.
 *
 * @param turnExecutor Runtime that owns the active session.
 * @param store Store that owns persisted session lineage.
 * @param workspaceId Workspace that owns the thread.
 * @param threadId Thread whose active session should be projected.
 * @param currentConfigVersion Current runtime config version.
 * @param workerControlGateway Live worker-control state owner.
 * @returns Enriched active session, or null when the runtime has none.
 */
export function getThreadAgentSession(
  turnExecutor: TurnExecutor,
  store: FsStore,
  workspaceId: string,
  threadId: string,
  currentConfigVersion: number,
  workerControlGateway: WorkerControlGateway
): AgentSessionReadModel | null {
  const session = turnExecutor.getAgentSession?.(store, workspaceId, threadId) ?? null;

  if (!session) {
    return null;
  }

  const storedSession = store
    .listThreadAgentSessions(workspaceId, threadId)
    .find((candidate) => candidate.id === session.id);
  const configVersion = storedSession?.configVersion ?? session.configVersion ?? null;
  const workspaceRoots = storedSession?.workspaceRoots ?? session.workspaceRoots ?? [];
  const controlSnapshot = resolveWorkerControlSnapshot(
    workerControlGateway,
    storedSession?.environmentPackageSnapshotId ?? null,
    session.id,
    workspaceId,
    threadId
  );

  return AgentSessionReadModelSchema.parse({
    ...session,
    backend: session.backend
      ? {
          ...session.backend,
          control: summarizeWorkerControlSession(controlSnapshot),
        }
      : null,
    configVersion,
    workspaceRoots,
    stale: configVersion !== null && configVersion < currentConfigVersion,
  });
}

/**
 * Resolves live worker-control state for one exact active-session lineage.
 *
 * @param workerControlGateway Live worker-control state owner.
 * @param packageSnapshotId Persisted active package snapshot id, when available.
 * @param agentSessionId Active agent session id.
 * @param workspaceId Workspace that owns the active session.
 * @param threadId Thread that owns the active session.
 * @returns Matching live control snapshot, or null when the exact lineage is unavailable.
 */
export function resolveWorkerControlSnapshot(
  workerControlGateway: WorkerControlGateway,
  packageSnapshotId: string | null,
  agentSessionId: string,
  workspaceId: string,
  threadId: string
): WorkerControlSessionSnapshot | null {
  const snapshot = packageSnapshotId
    ? workerControlGateway.getSessionSnapshot(packageSnapshotId)
    : workerControlGateway.getSessionSnapshotByAgentSessionId(agentSessionId);

  return snapshot?.agentSessionId === agentSessionId &&
    snapshot.workspaceId === workspaceId &&
    snapshot.threadId === threadId
    ? snapshot
    : null;
}

/**
 * Lists active sessions captured from an older runtime config snapshot.
 *
 * @param turnExecutor Runtime that owns active sessions.
 * @param store Store that owns workspaces, threads, and session lineage.
 * @param currentConfigVersion Current runtime config version.
 * @param workerControlGateway Live worker-control state owner.
 * @returns Stale-session status records for runtime config diagnostics.
 */
export function listStaleRuntimeConfigSessions(
  turnExecutor: TurnExecutor,
  store: FsStore,
  currentConfigVersion: number,
  workerControlGateway: WorkerControlGateway
): RuntimeConfigStaleSession[] {
  const staleSessions: RuntimeConfigStaleSession[] = [];

  for (const workspace of store.listWorkspaces()) {
    for (const thread of store.listThreads(workspace.id)) {
      const session = getThreadAgentSession(
        turnExecutor,
        store,
        workspace.id,
        thread.id,
        currentConfigVersion,
        workerControlGateway
      );

      if (!session?.stale) {
        continue;
      }

      const storedSession = store
        .listThreadAgentSessions(workspace.id, thread.id)
        .find((candidate) => candidate.id === session.id);

      staleSessions.push(
        createRuntimeConfigStaleSession({
          sessionId: session.id,
          threadId: thread.id,
          agentId: storedSession?.agentId ?? 'unknown',
          capturedVersion: session.configVersion,
          currentVersion: currentConfigVersion,
          reasons: ['runtime-config'],
        })
      );
    }
  }

  return staleSessions;
}

/**
 * Builds a product-safe summary from live worker-control state.
 *
 * @param snapshot Live control session snapshot.
 * @returns Compact control status, or null when no control session is active.
 */
function summarizeWorkerControlSession(
  snapshot: WorkerControlSessionSnapshot | null
): AgentSessionBackendControlSummary | null {
  if (!snapshot) {
    return null;
  }

  return {
    artifactNoticeCount: snapshot.artifacts.length,
    deliveredCommandCount: snapshot.commands.filter((command) => command.deliveredAt !== null)
      .length,
    heartbeat: snapshot.heartbeat
      ? {
          lastHeartbeatAt: snapshot.heartbeat.lastHeartbeatAt,
          sequence: snapshot.heartbeat.sequence,
          status: snapshot.heartbeat.status,
        }
      : null,
    queuedCommandCount: snapshot.commands.length,
  };
}
