import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { requireCompleteBackendWorkspaceHandleHandoff } from '../storage/workspace-handoff-read.js';
import { ControlWorkspaceTakeoverSchema } from '../storage/workspace-takeover-codecs.js';
import type { NanoHostExecutionAttemptRecord } from './nanohost-attempt-records.js';

/** Preserves per-handle ACKs and rechecks current disposition before any external cleanup. */
export async function publishWorkspaceTakeoverEvaluation(
  db: WorkspaceDb,
  attempt: NanoHostExecutionAttemptRecord,
  environmentPackage: AgentEnvironmentPackage,
  timestamp: string,
  physicallyCleaned: boolean
): Promise<boolean> {
  const handles = requireCompleteBackendWorkspaceHandleHandoff(db, environmentPackage);
  const scope = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId });
  const client = getControlStoreWorkerClient();
  const database = `workspace:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const facts = {
    attempt: {
      attemptId: attempt.attemptId,
      workspaceId: attempt.workspaceId,
      phase: attempt.phase,
      terminalCause: attempt.terminalCause,
    },
    environmentPackage,
    timestamp,
    physicallyCleaned,
  };
  // Main supplies candidate keys only. Every stage revalidates the complete handoff and current rows.
  for (const handle of handles) {
    await client.workspaceTakeover(
      database,
      ControlWorkspaceTakeoverSchema.parse({ action: 'handle', ...facts, handleId: handle.id })
    );
  }
  return client.workspaceTakeover(
    database,
    ControlWorkspaceTakeoverSchema.parse({ action: 'disposition', ...facts })
  );
}
