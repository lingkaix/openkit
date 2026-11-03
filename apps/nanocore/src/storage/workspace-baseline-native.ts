import {
  acceptWorkspaceBaseline,
  authorizeWorkspaceBaselineInitialization,
} from '../runtime/workspace-snapshot-chain.js';
import type { WorkspaceDb } from './db.js';
import type { ControlWorkspaceBaseline } from './workspace-baseline-codecs.js';

/** Runs one original baseline stage inside the existing physical owner's savepoint. */
export function applyWorkspaceBaselineInDb(db: WorkspaceDb, input: ControlWorkspaceBaseline): void {
  if (input.action === 'initialize') authorizeWorkspaceBaselineInitialization(db, input.identity);
  else
    acceptWorkspaceBaseline(
      db,
      input.identity,
      input.head,
      input.expectedTree,
      input.acceptedCommit
    );
}
