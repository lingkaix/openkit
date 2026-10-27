import type { Actor } from '../auth/identity.js';
import type { FsStore } from '../lib/store.js';
import {
  raiseRecordedPendingRequest,
  resolveCommandIntentApproval,
} from '../runtime/pending-request-flow.js';
import {
  type PendingRequestRecord,
  type RaisePendingRequestInput,
  readPendingRequest,
} from '../runtime/pending-requests.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';

/** Owns the Pending store handle while exposing only real domain operations and records to tests. */
export function createPendingRequestFixture(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceId: string;
}): {
  raise: (request: RaisePendingRequestInput) => Promise<PendingRequestRecord>;
  resolveCommandIntentApproval: (request: {
    record: PendingRequestRecord;
    decision: 'granted' | 'denied';
    actor: Actor;
  }) => Promise<PendingRequestRecord>;
  read: (requestId: string) => PendingRequestRecord | null;
  close: () => void;
} {
  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);
  return {
    /** Publishes an explicitly supplied Pending request through its native owner. */
    raise: (request: Parameters<typeof raiseRecordedPendingRequest>[2]) =>
      raiseRecordedPendingRequest(input.store, workspaceDb.sqlite, request),
    /** Resolves the exact supplied human request with the caller's current actor. */
    resolveCommandIntentApproval: (
      request: Pick<
        Parameters<typeof resolveCommandIntentApproval>[0],
        'record' | 'decision' | 'actor'
      >
    ) =>
      resolveCommandIntentApproval({
        ...request,
        store: input.store,
        coreDb: input.coreDb,
        sqlite: workspaceDb.sqlite,
      }),
    /** Reads the canonical Pending record without exposing its database handle. */
    read: (requestId: string) => readPendingRequest(workspaceDb.sqlite, requestId),
    /** Releases the fixture's owner handle before the caller disposes its root. */
    close: () => workspaceDb.sqlite.close(),
  };
}
