import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerAdmissionEntry,
  type SchedulerAdmissionEntryRecord,
} from '../scheduler-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { isControlWorkerReply, isControlWorkerRequest } from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { SchedulerAdmissionTransitionError } from './scheduler-admission-codecs.js';
import { publishSchedulerAdmission } from './scheduler-admission-publication.js';

const roots: string[] = [];
const handles: CoreDb[] = [];
const timestamp = '2026-11-02T00:00:00.000Z';

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates current authority through its owners before making the Main Core handle query-only. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-native-deciders-'));
  roots.push(root);
  const db = openCoreDb(root);
  handles.push(db);
  applyMigrations(db);
  const userId = ensureLocalUser(db);
  const workspaceId = testEntityId('ws', 'scheduler-native-deciders');
  recordWorkspaceOwnerMembership({ coreDb: db, workspaceId, ownerUserId: userId });
  db.sqlite.pragma('query_only = ON');
  return { db, root, userId, workspaceId };
}

/** Fixes original command identity and exact instruction bytes before native publication. */
function command(f: ReturnType<typeof fixture>, index: number) {
  return {
    mode: 'create' as const,
    entry: {
      backendId: 'nanohost',
      queueEntryId: `queue-native-decider-${index}`,
      requestId: `request-native-decider-${index}`,
      requestedAgentId: 'agent_worker',
      timestamp,
      triggerActor: { kind: 'user' as const, id: f.userId },
      workspaceId: f.workspaceId,
      threadId: testEntityId('th', `scheduler-native-decider-${index}`),
      turnId: testEntityId('tu', `scheduler-native-decider-${index}`),
      turnInput: '  Preserve this original admission.\nInspect it after uncertainty. 🚀  ',
    },
  };
}

it('refuses the twenty-first native admission without a row while Main is query-only', async () => {
  const f = fixture();
  const retained: SchedulerAdmissionEntryRecord[] = [];
  // Durable Scheduler Design: Admission And Launch fixes the default queued bound at 20.
  for (let index = 0; index < 20; index += 1) {
    const result = await publishSchedulerAdmission(f.db, command(f, index));
    expect(result.kind).toBe('queue');
    if (result.kind !== 'queue') throw new Error('Native admission omitted its queue entry.');
    retained.push(result.entry);
  }
  const candidate = command(f, 20);
  const refused = publishSchedulerAdmission(f.db, candidate);
  await expect(refused).rejects.toBeInstanceOf(SchedulerAdmissionTransitionError);
  await expect(refused).rejects.toMatchObject({ reason: 'queue-full' });
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual(retained);
  expect(() => requireSchedulerAdmissionEntry(f.db, candidate.entry.queueEntryId)).toThrow();
  const replay = await publishSchedulerAdmission(f.db, command(f, 0));
  expect(replay).toEqual({ kind: 'queue', entry: retained[0] });
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual(retained);
});

it('rechecks current authority after native open and refuses admission without a row', async () => {
  const f = fixture();
  const client = getControlStoreWorkerClient();
  const nativeOpen = client.open.bind(client);
  const posted = vi.spyOn(client, 'schedulerAdmission');
  let authorityChanged = false;
  const opened = vi.spyOn(client, 'open').mockImplementation(async (input) => {
    await nativeOpen(input);
    const authority = openCoreDb(f.root);
    try {
      authorityChanged =
        authority.sqlite.transaction(
          () => disableCanonicalUser(authority, f.userId, new Date(timestamp))?.changed ?? false
        )() === true;
    } finally {
      authority.sqlite.close();
    }
  });
  const candidate = command(f, 0);
  // Control Store: current same-database authority decides in the native transaction.
  await expect(publishSchedulerAdmission(f.db, candidate)).rejects.toMatchObject({
    code: 'workspace_access_denied',
    status: 403,
  });
  expect(authorityChanged).toBe(true);
  expect(opened).toHaveBeenCalledOnce();
  expect(posted).toHaveBeenCalledOnce();
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([]);
  expect(() => requireSchedulerAdmissionEntry(f.db, candidate.entry.queueEntryId)).toThrow();
});

it('keeps a lost native scheduler reply unknown without retry and inspects the original after cold reopen', async () => {
  const f = fixture();
  const client = getControlStoreWorkerClient();
  const candidate = command(f, 0);
  let schedulerPosts = 0;
  let submitted: { readonly id: number; readonly worker: Worker } | undefined;
  let committedReply: SchedulerAdmissionEntryRecord | undefined;
  let termination: Promise<number> | undefined;
  const post = Worker.prototype.postMessage;
  const emit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
    const request: unknown = args[0];
    if (isControlWorkerRequest(request) && request.operation === 'scheduler-admission') {
      schedulerPosts += 1;
      submitted = { id: request.id, worker: this };
    }
    return post.apply(this, args);
  });
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const reply = args[0];
    if (
      termination === undefined &&
      event === 'message' &&
      submitted?.worker === this &&
      isControlWorkerReply(reply) &&
      reply.id === submitted.id &&
      reply.status === 'ok' &&
      reply.operation === 'scheduler-admission'
    ) {
      // The actual worker emits success only after outer FULL COMMIT; lose that original reply.
      if (reply.result.kind === 'queue') committedReply = reply.result.entry;
      termination = this.terminate();
      return true;
    }
    return emit.call(this, event, ...args);
  });
  const original = publishSchedulerAdmission(f.db, candidate).catch((error: unknown) => error);
  await expect(original).resolves.toMatchObject({
    name: ControlStoreWorkerError.name,
    code: 'unavailable',
    commit: 'unknown',
  });
  expect(termination).toBeDefined();
  await termination;
  expect(schedulerPosts).toBe(1);
  expect(getControlStoreWorkerClient()).toBe(client);
  expect(committedReply).toBeDefined();
  const retained = requireSchedulerAdmissionEntry(f.db, candidate.entry.queueEntryId);
  const { timestamp: enqueuedAt, ...expected } = candidate.entry;
  expect(retained).toMatchObject({ ...expected, enqueuedAt, status: 'queued' });
  expect(retained).toEqual(committedReply);

  // Control Store: unknown acknowledgement permits original inspection, never automatic replay.
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const reopened = openCoreDb(f.root);
  handles.push(reopened);
  reopened.sqlite.pragma('query_only = ON');
  expect(requireSchedulerAdmissionEntry(reopened, candidate.entry.queueEntryId)).toEqual(retained);
  expect(listQueuedSchedulerAdmissionEntries(reopened)).toEqual([retained]);
  expect(schedulerPosts).toBe(1);
});
