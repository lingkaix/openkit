import type { Actor } from '../auth/identity.js';
import type { FsStore } from '../lib/store.js';
import {
  answerRecordedUserInput,
  raiseRecordedPendingRequest,
  requireUsableRecord,
  resolveCommandIntentApproval,
} from '../runtime/pending-request-flow.js';
import {
  listThreadPendingRequests,
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
  raise: (
    request: RaisePendingRequestInput,
    item?: Parameters<typeof raiseRecordedPendingRequest>[3]
  ) => Promise<PendingRequestRecord>;
  answer: (
    record: PendingRequestRecord,
    actor: Actor,
    answers: Readonly<Record<string, readonly [string]>>
  ) => Promise<PendingRequestRecord>;
  list: (threadId: string) => PendingRequestRecord[];
  requireUsable: (requestId: string, threadId: string) => PendingRequestRecord;
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
    raise: (request, item) =>
      raiseRecordedPendingRequest(input.store, workspaceDb.sqlite, request, item),
    /** Answers through the current authority owner while the caller's genuine raiser keeps admission busy. */
    answer: (record, actor, answers) =>
      answerRecordedUserInput(
        input.store,
        workspaceDb.sqlite,
        {
          requestId: record.requestId,
          workspaceId: input.workspaceId,
          threadId: record.threadId,
          answers,
        },
        actor.userId,
        input.coreDb,
        actor,
        { coreDb: input.coreDb, openWorkspace: (id) => openWorkspaceDb(input.coreDb.dataRoot, id) }
      ),
    /** Reads existing native request rows without exposing the fixture handle. */
    list: (threadId) => listThreadPendingRequests(workspaceDb.sqlite, input.workspaceId, threadId),
    /** Applies the existing canonical association guard before executor dispatch. */
    requireUsable: (requestId, threadId) =>
      requireUsableRecord(input.store, workspaceDb.sqlite, requestId, input.workspaceId, threadId),
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
