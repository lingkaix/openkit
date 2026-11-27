import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sha256Hex } from '@openkit/protocol/digest';
import { afterEach, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { refuseScope, settleWorkspaceRecoveryScope } from '../bootstrap/readiness.js';
import { readFrozenSchedulerInput } from '../runtime/scheduler-dispatch-frozen-input.js';
import { stageSchedulerStartInput } from '../runtime/scheduler-input-staging.js';
import {
  type CoreSchedulerQueueEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { admitCoreScheduler } from './control-store-admission.js';
import { SchedulerAdmissionTransitionError } from './control-store-admission-codecs.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { isControlWorkerReply, isControlWorkerRequest } from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { readWorkspaceQueueInput } from './workspace-queue-inputs.js';

const roots: string[] = [];
const handles: CoreDb[] = [];
const timestamp = '2026-11-02T00:00:00.000Z';
const originalText = '  Preserve this original admission.\nInspect it after uncertainty. 🚀  ';

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
  const workspace = openWorkspaceDb(root, workspaceId);
  try {
    applyScopedMigrations(workspace);
  } finally {
    workspace.sqlite.close();
  }
  db.sqlite.pragma('query_only = ON');
  return { db, root, userId, workspaceId };
}

/** Fixes original command identity and exact instruction bytes before native publication. */
async function command(f: ReturnType<typeof fixture>, index: number) {
  const scope = {
    workspaceId: f.workspaceId,
    threadId: testEntityId('th', `scheduler-native-decider-${index}`),
    turnId: testEntityId('tu', `scheduler-native-decider-${index}`),
  };
  const requestId = `request-native-decider-${index}`;
  const inputRef = await stageSchedulerStartInput(f.root, scope, requestId, originalText);
  return {
    mode: 'create' as const,
    entry: {
      backendId: 'nanohost',
      queueEntryId: `queue-native-decider-${index}`,
      requestId,
      requestedAgentId: 'agent_worker',
      timestamp,
      triggerActor: { kind: 'user' as const, id: f.userId },
      ...scope,
      inputRef,
    },
  };
}

it('admits only one of two competing requests for the final native queue slot', async () => {
  const f = fixture();
  const retained: CoreSchedulerQueueEntry[] = [];
  // Durable Scheduler Design: Admission And Launch fixes the default queued bound at 20.
  for (let index = 0; index < 19; index += 1) {
    const result = await admitCoreScheduler(f.db, await command(f, index));
    expect(result.kind).toBe('queue');
    if (result.kind !== 'queue') throw new Error('Native admission omitted its queue entry.');
    retained.push(result.entry);
  }

  const candidates = [await command(f, 19), await command(f, 20)];
  const publish = Promise.withResolvers<void>();
  let preparing = 0;
  const prepare = async (candidate: (typeof candidates)[number]) => {
    preparing += 1;
    if (preparing === candidates.length) publish.resolve();
    await publish.promise;
    return candidate;
  };
  const decisions = await Promise.allSettled(
    candidates.map((candidate) =>
      admitCoreScheduler(f.db, candidate, prepare).finally(() => publish.resolve())
    )
  );
  expect(preparing).toBe(2);
  expect(decisions.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
  const winner = decisions.findIndex(({ status }) => status === 'fulfilled');
  const loser = decisions.findIndex(({ status }) => status === 'rejected');
  const committed = requireSchedulerAdmissionEntry(f.db, candidates[winner].entry.queueEntryId);
  expect(decisions[winner]).toEqual({
    status: 'fulfilled',
    value: { kind: 'queue', entry: committed },
  });
  expect(decisions[loser]).toEqual({
    status: 'rejected',
    reason: expect.any(SchedulerAdmissionTransitionError),
  });
  expect(decisions[loser]).toMatchObject({ reason: { reason: 'queue-full' } });
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([...retained, committed]);
  expect(() =>
    requireSchedulerAdmissionEntry(f.db, candidates[loser].entry.queueEntryId)
  ).toThrow();
  const replay = await admitCoreScheduler(f.db, candidates[winner]);
  expect(replay).toEqual({ kind: 'queue', entry: committed });
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([...retained, committed]);
});

it('rechecks current authority after native open and refuses admission without a row', async () => {
  const f = fixture();
  const candidate = await command(f, 0);
  const client = getControlStoreWorkerClient();
  const nativeOpen = client.open.bind(client);
  const posted = vi.spyOn(client, 'transition');
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
  // Control Store: current same-database authority decides in the native transaction.
  await expect(admitCoreScheduler(f.db, candidate)).rejects.toMatchObject({
    code: 'workspace_access_denied',
    status: 403,
  });
  expect(authorityChanged).toBe(true);
  expect(opened).toHaveBeenCalledOnce();
  expect(
    posted.mock.calls.filter(
      ([database, transition]) =>
        database === `core:${f.db.sqlite.name}` &&
        'kind' in transition &&
        transition.kind === 'scheduler-work'
    )
  ).toHaveLength(1);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([]);
  expect(() => requireSchedulerAdmissionEntry(f.db, candidate.entry.queueEntryId)).toThrow();
});

it('refuses frozen admission when an original member disappears at the native post', async () => {
  const f = fixture();
  const scope = {
    workspaceId: f.workspaceId,
    threadId: testEntityId('th', 'frozen-native-admission'),
    turnId: testEntityId('tu', 'frozen-native-admission'),
  };
  const stage = async (inputId: string, text: string) =>
    getControlStoreWorkerClient().stageWorkspaceQueueInput(f.root, {
      ...scope,
      originalInvocationId: scope.turnId,
      input: {
        owner: { kind: 'workspace', workspaceId: scope.workspaceId },
        inputId,
        digest: sha256Hex(text),
      },
      text,
    });
  const first = await stage('frozen-first', 'First original');
  const second = await stage('frozen-second', 'Second original');
  const manifest = JSON.stringify(
    [first, second].map(({ inputId, digest }) => ({ inputId, digest }))
  );
  const inputRef = await stage(scope.turnId, manifest);
  expect(readFrozenSchedulerInput(f.root, scope, inputRef)).toEqual([
    { input: first, text: 'First original' },
    { input: second, text: 'Second original' },
  ]);

  const post = Worker.prototype.postMessage;
  let removed = 0;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
    const request: unknown = args[0];
    if (
      isControlWorkerRequest(request) &&
      request.operation === 'transition' &&
      request.database === `core:${f.db.sqlite.name}` &&
      'kind' in request.transition &&
      request.transition.kind === 'scheduler-work'
    ) {
      const workspace = openWorkspaceDb(f.root, f.workspaceId);
      try {
        removed += workspace.sqlite
          .prepare('DELETE FROM workspace_work_inputs WHERE input_id = ?')
          .run(second.inputId).changes;
      } finally {
        workspace.sqlite.close();
      }
    }
    return post.apply(this, args);
  });

  const queueEntryId = 'queue-frozen-native-admission';
  await expect(
    admitCoreScheduler(f.db, {
      mode: 'create',
      entry: {
        ...scope,
        backendId: 'nanohost',
        queueEntryId,
        requestId: 'request-frozen-native-admission',
        requestedAgentId: 'agent_worker',
        timestamp,
        triggerActor: { kind: 'user', id: f.userId },
        inputRef,
      },
    })
  ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
  expect(removed).toBe(1);
  expect(readWorkspaceQueueInput(f.root, scope, inputRef)).toEqual({
    text: manifest,
    originalInvocationId: scope.turnId,
  });
  expect(readWorkspaceQueueInput(f.root, scope, first)).toEqual({
    text: 'First original',
    originalInvocationId: scope.turnId,
  });
  expect(readFrozenSchedulerInput(f.root, scope, inputRef)).toBeNull();
  expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([]);
  expect(() => requireSchedulerAdmissionEntry(f.db, queueEntryId)).toThrow();
});

it('refuses native admission after Workspace recovery with the ordinary input intact', async () => {
  const f = fixture();
  const candidate = await command(f, 0);
  const { inputRef, requestId, queueEntryId } = candidate.entry;
  const workspace = openWorkspaceDb(f.root, f.workspaceId);
  workspace.sqlite.pragma('query_only = ON');
  const recovery = { scope: 'workspace', id: f.workspaceId, check: 'recovery' } as const;
  const prepare = vi.fn((original: typeof candidate) => {
    refuseScope(f.root, recovery);
    return original;
  });
  try {
    await expect(admitCoreScheduler(f.db, candidate, prepare)).rejects.toMatchObject({
      code: 'recovery_required',
      status: 409,
    });
    expect(prepare).toHaveBeenCalledOnce();
    const original = workspace.sqlite
      .prepare(
        'SELECT input_digest AS digest, input_bytes AS bytes, invocation_id AS invocation FROM workspace_work_inputs WHERE input_id = ?'
      )
      .get(inputRef.inputId);
    expect(original).toEqual({
      digest: inputRef.digest,
      bytes: Buffer.from(originalText),
      invocation: requestId,
    });
    expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([]);
    expect(() => requireSchedulerAdmissionEntry(f.db, queueEntryId)).toThrow();
  } finally {
    workspace.sqlite.close();
    if (prepare.mock.calls.length)
      settleWorkspaceRecoveryScope({ dataRoot: f.root, failure: recovery });
  }
});

it('keeps a lost native scheduler reply unknown without retry and inspects the original after cold reopen', async () => {
  const f = fixture();
  const client = getControlStoreWorkerClient();
  const candidate = await command(f, 0);
  let schedulerPosts = 0;
  let submitted: { readonly id: number; readonly worker: Worker } | undefined;
  let committedReply: CoreSchedulerQueueEntry | undefined;
  let termination: Promise<number> | undefined;
  const post = Worker.prototype.postMessage;
  const emit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
    const request: unknown = args[0];
    if (
      isControlWorkerRequest(request) &&
      request.operation === 'transition' &&
      request.database === `core:${f.db.sqlite.name}` &&
      'kind' in request.transition &&
      request.transition.kind === 'scheduler-work'
    ) {
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
      reply.operation === 'transition'
    ) {
      // The actual worker emits success only after outer FULL COMMIT; lose that original reply.
      if (reply.result !== null && 'kind' in reply.result && reply.result.kind === 'queue')
        committedReply = reply.result.entry;
      termination = this.terminate();
      return true;
    }
    return emit.call(this, event, ...args);
  });
  const original = admitCoreScheduler(f.db, candidate).catch((error: unknown) => error);
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
  expect(readWorkspaceQueueInput(f.root, retained, retained.inputRef)).toEqual({
    text: originalText,
    originalInvocationId: candidate.entry.requestId,
  });
  expect(listQueuedSchedulerAdmissionEntries(reopened)).toEqual([retained]);
  expect(schedulerPosts).toBe(1);
});
