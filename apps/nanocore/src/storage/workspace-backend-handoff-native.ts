import type { WorkspaceDb } from './db.js';
import type {
  ControlWorkspaceBackendHandoff,
  ControlWorkspaceBackendHandoffResult,
} from './workspace-backend-handoff-codecs.js';
import {
  recordWorkspaceInputSnapshot,
  recordWorkspaceMaterializationRecord,
} from './workspace-materialization-records.js';

/** Publishes the original five-family tuple inside the physical owner's existing savepoint. */
export function applyWorkspaceBackendHandoffInDb(
  workspaceDb: WorkspaceDb,
  input: ControlWorkspaceBackendHandoff
): ControlWorkspaceBackendHandoffResult {
  return {
    inputSnapshots: input.inputSnapshots.map((snapshot) =>
      recordWorkspaceInputSnapshot(workspaceDb, snapshot)
    ),
    materializationRecords: input.materializationRecords.map((record) =>
      recordWorkspaceMaterializationRecord(workspaceDb, record)
    ),
  };
}
