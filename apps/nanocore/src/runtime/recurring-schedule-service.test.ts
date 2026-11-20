import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AutomationHistoryResponseSchema } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationOperationImplementations } from '../automation-operations.js';
import { AutomationStore, stageRecurringQueueInput } from '../lib/automation-store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type {
  ControlWorkerCommand,
  ControlWorkerReply,
  ControlWorkerRequest,
} from '../storage/control-store-worker-protocol.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import type { RecurringPreparation } from '../storage/recurring-records.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  type RecurringScheduleService,
  startRecurringScheduleService,
} from './recurring-schedule-service.js';
import { recurringTurnPublicationIssue } from './recurring-turn-publication.js';
import { createSchedulerAdmissionOperationImplementations } from './scheduler-admission-operations.js';
import { readScheduledAdmissionText } from './scheduler-dispatch-input.js';

const owned: { root: string; db: CoreDb; services: RecurringScheduleService[] }[] = [];
const ready: Extract<RecurringPreparation, { kind: 'ready' }> = {
  kind: 'ready',
  payload: {
    backendId: 'test-backend',
    requestedAgentId: 'worker',
    profileRef: 'provider/main',
    modelId: 'exact-model',
    workspaceCwd: null,
    workspaceRoots: [],
  },
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recurrence-service-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  const localUserId = ensureLocalUser(db);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Recurring');
  const thread = await store.createThread(workspace.id, 'Target');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: localUserId,
  });
  let instant = '2026-10-16T00:00:00.000Z';
  const clock = () => instant;
  const schedules = new AutomationStore(db, clock);
  const created = await schedules.createAutomation(localUserId, {
    name: 'Poll',
    workspaceId: workspace.id,
    threadId: thread.id,
    intervalSeconds: 5,
    prompt: 'Inspect status',
  });
  const schedule = await schedules.updateAutomation(localUserId, created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: instant,
  });
  const services: RecurringScheduleService[] = [];
  owned.push({ root, db, services });
  const start = (
    prepare: (
      occurrence: Parameters<Parameters<typeof startRecurringScheduleService>[0]['prepare']>[0]
    ) => Promise<RecurringPreparation> = async () => structuredClone(ready),
    prepareKnowledgeMaintenance?: (instant: string) => void | Promise<void>,
    agentWorkPaused?: () => boolean
  ) => {
    const setTimer = vi.fn(() => 'timer');
    const clearTimer = vi.fn();
    const onError = vi.fn();
    const service = startRecurringScheduleService({
      schedules,
      store,
      prepare,
      ...(agentWorkPaused ? { agentWorkPaused } : {}),
      now: clock,
      setInterval: setTimer,
      clearInterval: clearTimer,
      onError,
      ...(prepareKnowledgeMaintenance ? { prepareKnowledgeMaintenance } : {}),
    });
    services.push(service);
    return { service, setTimer, clearTimer, onError };
  };
  return {
    root,
    db,
    store,
    schedules,
    schedule,
    workspace,
    thread,
    clock,
    start,
    setTime: (value: string) => {
      instant = value;
    },
  };
}
afterEach(async () => {
  for (const { root, db, services } of owned.splice(0)) {
    for (const service of services) service.stop();
    await disposeTestStore(root, db);
  }
});

async function deferredPublicationFixture() {
  const env = await fixture();
  const { db, schedule, store, schedules, start } = env;
  const { workspaceId, threadId, responsibleUserId } = schedule;
  const busy = await store.createTurn(workspaceId, threadId, 'Original active work.', {
    kind: 'user',
    id: responsibleUserId,
  });
  const prepare = vi.fn(async () => structuredClone(ready));
  const { service } = start(prepare);
  await service.runOnce();
  const occurrence = schedules.listHistory(schedule.id).items[0]!.record;
  expect(occurrence.publicationDeferred).toBe('thread_busy');
  const entry = requireSchedulerAdmissionEntry(db, occurrence.queueEntryId!);
  await store.completeTurn(busy.id, { status: 'completed', completedAt: new Date().toISOString() });
  return {
    ...env,
    service,
    prepare,
    entry,
    fixedTurns: () =>
      store.listThreadTurns(workspaceId, threadId).filter((turn) => turn.id === entry.turnId),
  };
}

function isFixedPublication(command: ControlWorkerCommand | undefined, turnId: string): boolean {
  return (
    command?.operation === 'products' &&
    command.transition.products.some(
      (product) => product.kind === 'turn' && product.record.id === turnId
    )
  );
}

async function expireDeferredPublication(scan: Promise<void>, delay = 30_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(delay);
  vi.useRealTimers();
  let finished = false;
  void scan.then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5_000 });
}

describe('serialized recurring scanner', () => {
  it('holds scheduled Worker and Knowledge preparation while paused and resumes on the next scan', async () => {
    const { start, schedules, schedule } = await fixture();
    let paused = true;
    const prepare = vi.fn(async () => structuredClone(ready));
    const knowledge = vi.fn();
    const { service } = start(prepare, knowledge, () => paused);
    await service.runOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(knowledge).not.toHaveBeenCalled();
    expect(schedules.listHistory(schedule.id).items).toEqual([]);
    paused = false;
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(knowledge).toHaveBeenCalledTimes(1);
    expect(schedules.listHistory(schedule.id).items[0]!.record.state).toBe('admission-accepted');
  });

  it('refuses native admission if pause is set during asynchronous preparation', async () => {
    const { start, schedules, schedule, db } = await fixture();
    let paused = false;
    const { service } = start(
      async () => {
        paused = true;
        return structuredClone(ready);
      },
      undefined,
      () => paused
    );
    await service.runOnce();
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
    expect(
      schedules
        .listHistory(schedule.id)
        .items.every((item) => item.record.state !== 'admission-accepted')
    ).toBe(true);
  });

  it('commits one terminal attempt through the native owner while Main stays read-only', async () => {
    const { root, db, store, schedules, schedule, clock, start } = await fixture();
    const createTurn = vi.spyOn(store, 'createTurn');
    const prepare = vi.fn(async () => {
      db.sqlite.pragma('query_only = ON');
      return structuredClone(ready);
    });
    const { service } = start(prepare);
    await service.runOnce();
    const accepted = schedules.listHistory(schedule.id).items[0]!.record;
    expect(accepted).toMatchObject({
      state: 'admission-accepted',
      attempts: [{ number: 1, code: 'accepted' }],
    });
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 1 });
    expect(createTurn).toHaveBeenCalledTimes(1);

    service.stop();
    const reopenedDb = openCoreDb(root);
    const reopenedSchedules = new AutomationStore(reopenedDb, clock);
    const replayPreparation = vi.fn(async () => structuredClone(ready));
    const reopened = startRecurringScheduleService({
      schedules: reopenedSchedules,
      store,
      prepare: replayPreparation,
      now: clock,
      setInterval: () => 'reopened',
      clearInterval: () => {},
    });
    try {
      await reopened.runOnce();
      expect(reopenedSchedules.listHistory(schedule.id).items[0]!.record).toEqual(accepted);
      expect(
        reopenedDb.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
      ).toEqual({ n: 1 });
      expect(replayPreparation).not.toHaveBeenCalled();
      expect(createTurn).toHaveBeenCalledTimes(1);
    } finally {
      reopened.stop();
      reopenedDb.sqlite.close();
    }
  });

  it('uses one five-second timer and publishes the fixed pending Turn once after queue admission', async () => {
    const { db, store, schedules, schedule, start } = await fixture();
    const createTurn = vi.spyOn(store, 'createTurn');
    const { service, setTimer } = start();
    await service.runOnce();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(createTurn).toHaveBeenCalledTimes(1);
    expect(
      store.listThreadTurns(schedule.workspaceId, schedule.threadId)[0]?.triggerSource
    ).toEqual({
      kind: 'automation',
      summary: 'Recurring schedule admission.',
    });
    const occurrence = schedules.listHistory(schedule.id).items[0]!.record;
    expect(occurrence).toMatchObject({
      state: 'admission-accepted',
      snapshot: { actor: schedule.actor },
    });
    await service.runOnce();
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 1 });
  });

  it.each(['committed', 'unknown'] as const)(
    'uses a native busy refusal for one later publication attempt: %s',
    async (result) => {
      const { db, store, schedules, schedule, start } = await fixture();
      const { workspaceId, threadId, responsibleUserId } = schedule;
      const busy = await store.createTurn(workspaceId, threadId, 'Original active work.', {
        kind: 'user',
        id: responsibleUserId,
      });
      const publish = vi.spyOn(store, 'createTurn');
      const prepare = vi.fn(async () => structuredClone(ready));
      const { service, onError } = start(prepare);
      await service.runOnce();
      const accepted = schedules
        .listHistory(schedule.id)
        .items.find((item) => item.kind === 'occurrence')!.record;
      expect(accepted).toMatchObject({
        state: 'admission-accepted',
        publicationDeferred: 'thread_busy',
        attempts: [{ number: 1, code: 'accepted' }],
      });
      expect(onError).not.toHaveBeenCalled();
      const entry = requireSchedulerAdmissionEntry(db, accepted.queueEntryId!);
      expect(recurringTurnPublicationIssue(db, store, entry)).toBe('turn_missing');
      await expect(publish.mock.results[0]!.value).rejects.toMatchObject({
        code: 'thread_busy',
        cause: {
          commit: 'not-committed',
          domain: { operation: 'products', code: 'thread_busy' },
        },
      });
      await service.runOnce();
      expect(publish).toHaveBeenCalledTimes(1);

      await store.completeTurn(busy.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      if (result === 'unknown')
        publish.mockRejectedValueOnce(new ControlStoreWorkerError('unavailable', 'unknown'));
      await service.runOnce();
      await service.runOnce();
      expect(publish).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(schedules.getOccurrence(accepted.id)).not.toHaveProperty('publicationDeferred');
      expect(recurringTurnPublicationIssue(db, store, entry)).toBe(
        result === 'committed' ? null : 'turn_missing'
      );
      expect(store.listThreadTurns(workspaceId, threadId).map((turn) => turn.id)).toEqual(
        result === 'committed' ? [busy.id, entry.turnId] : [busy.id]
      );
    }
  );

  it.each([
    'deleted before consume',
    'deleted after consume',
    'busy after consume',
    'native busy rollback',
  ] as const)('rechecks deferred publication when the target is %s', async (change) => {
    const { db, store, schedules, schedule, start } = await fixture();
    const { workspaceId, threadId, responsibleUserId } = schedule;
    const create = store.createTurn.bind(store);
    const ordinary = () =>
      create(workspaceId, threadId, 'Ordinary active work.', {
        kind: 'user',
        id: responsibleUserId,
      });
    const finish = (id: string) =>
      store.completeTurn(id, { status: 'completed', completedAt: new Date().toISOString() });
    const revoke = () => schedules.deleteAutomation(responsibleUserId, schedule.id);
    const first = await ordinary();
    const prepare = vi.fn(async () => structuredClone(ready));
    const { service, onError } = start(prepare);
    await service.runOnce();
    const occurrence = schedules.listHistory(schedule.id).items[0]!.record;
    expect(occurrence.publicationDeferred).toBe('thread_busy');
    const entry = requireSchedulerAdmissionEntry(db, occurrence.queueEntryId!);
    await finish(first.id);

    let second: Awaited<ReturnType<typeof ordinary>> | undefined;
    const client = getControlStoreWorkerClient();
    const transition = client.transition.bind(client);
    const write = vi.spyOn(client, 'transition').mockImplementation(async (target, command) => {
      const result = await transition(target, command);
      if (
        'kind' in command &&
        command.kind === 'scheduler-work' &&
        command.input.mode === 'recurring-publication' &&
        command.input.action === 'consume-busy' &&
        result &&
        'kind' in result &&
        result.kind === 'occurrence' &&
        result.occurrence
      ) {
        if (change === 'deleted after consume') await revoke();
        if (change === 'busy after consume' && !second) second = await ordinary();
      }
      return result;
    });
    const publish = vi.spyOn(store, 'createTurn');
    try {
      if (change === 'deleted before consume') await revoke();
      if (change === 'native busy rollback') {
        publish.mockImplementationOnce(async (...args) => {
          second = await ordinary();
          return create(...args);
        });
      }
      await Promise.all([service.runOnce(), service.runOnce()]);
      expect(recurringTurnPublicationIssue(db, store, entry)).toBe('turn_missing');
      expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('queued');
      expect(publish).toHaveBeenCalledTimes(change === 'native busy rollback' ? 1 : 0);

      if (second) {
        expect(schedules.getOccurrence(occurrence.id).publicationDeferred).toBe('thread_busy');
        await finish(second.id);
      }
      await service.runOnce();
      await service.runOnce();

      const revoked = change.startsWith('deleted');
      expect(schedules.getAutomation(schedule.id).status).toBe(revoked ? 'deleted' : 'active');
      expect(recurringTurnPublicationIssue(db, store, entry)).toBe(revoked ? 'turn_missing' : null);
      expect(
        store.listThreadTurns(workspaceId, threadId).filter(({ id }) => id === entry.turnId)
      ).toHaveLength(revoked ? 0 : 1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      publish.mockRestore();
      write.mockRestore();
    }
  });

  it.each(['completes', 'hangs'] as const)(
    'orders definition changes while native deferred publication %s',
    async (publication) => {
      const { db, clock, store, schedules, schedule, start } = await fixture();
      const { workspaceId, threadId, responsibleUserId } = schedule;
      const busy = await store.createTurn(workspaceId, threadId, 'Original active work.', {
        kind: 'user',
        id: responsibleUserId,
      });
      const prepare = vi.fn(async () => structuredClone(ready));
      const { service, onError } = start(prepare);
      await service.runOnce();
      const occurrence = schedules.listHistory(schedule.id).items[0]!.record;
      expect(occurrence.publicationDeferred).toBe('thread_busy');
      const entry = requireSchedulerAdmissionEntry(db, occurrence.queueEntryId!);
      await store.completeTurn(busy.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const client = getControlStoreWorkerClient();
      const products = client.products.bind(client);
      const events: string[] = [];
      const write = vi
        .spyOn(client, 'products')
        .mockImplementation(async (database, transition, guard) => {
          if (
            transition.products.some(
              (product) => product.kind === 'turn' && product.record.id === entry.turnId
            )
          ) {
            entered.resolve();
            await resume.promise;
            await products(database, transition, guard);
            events.push('turn committed');
            return;
          }
          await products(database, transition, guard);
        });
      const scan = service.runOnce();
      let deletion: Promise<void> | undefined;
      let timedChanges: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([
          entered.promise,
          scan.then(() => {
            throw new Error('The scan ended before Workspace publication entered.');
          }),
        ]);
        const mutator = new AutomationStore(db, clock);
        if (publication === 'hangs') {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          try {
            timedChanges = Promise.allSettled([
              mutator.deleteAutomation(responsibleUserId, schedule.id),
              mutator.updateAutomation(responsibleUserId, schedule.id, {
                expectedRevision: schedule.revision,
                status: 'paused',
              }),
            ]);
            await vi.advanceTimersByTimeAsync(3_000);
            const refusal = {
              status: 'rejected',
              reason: {
                code: 'schedule_publication_in_progress',
                status: 409,
                details: { retryable: true },
              },
            };
            expect(await Promise.race([timedChanges, Promise.resolve(null)])).toMatchObject([
              refusal,
              refusal,
            ]);
          } finally {
            vi.useRealTimers();
          }
        } else {
          deletion = mutator.deleteAutomation(responsibleUserId, schedule.id).then(() => {
            events.push('schedule deleted');
          });
        }
        // A separate definition can commit through the same native Core writer.
        await mutator.createAutomation(responsibleUserId, {
          workspaceId,
          threadId,
          name: 'Unrelated schedule',
          intervalSeconds: 5,
          prompt: 'Inspect status',
        });
        expect(schedules.getAutomation(schedule.id).status).toBe('active');
        expect(recurringTurnPublicationIssue(db, store, entry)).toBe('turn_missing');
      } finally {
        resume.resolve();
        await scan;
        write.mockRestore();
        await deletion;
        await timedChanges;
      }
      if (publication === 'hangs') {
        expect(events).toEqual(['turn committed']);
        expect(schedules.getAutomation(schedule.id).status).toBe('active');
        await schedules.deleteAutomation(responsibleUserId, schedule.id);
      } else {
        expect(events).toEqual(['turn committed', 'schedule deleted']);
      }
      expect(schedules.getAutomation(schedule.id).status).toBe('deleted');
      expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('queued');
      expect(recurringTurnPublicationIssue(db, store, entry)).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    }
  );

  it('releases a held native receipt after the fixed Turn is proved committed', async () => {
    const { store, schedules, schedule, service, entry, fixedTurns, prepare } =
      await deferredPublicationFixture();
    const client = getControlStoreWorkerClient() as unknown as {
      pending: ReadonlyMap<number, { readonly command: ControlWorkerCommand }>;
      receive(value: ControlWorkerReply, host: unknown): void;
    };
    const receive = client.receive.bind(client);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const forwarded = Promise.withResolvers<void>();
    let captured = false;
    const reply = vi.spyOn(client, 'receive').mockImplementation((value, host) => {
      if (
        value.status === 'ok' &&
        value.operation === 'products' &&
        isFixedPublication(client.pending.get(value.id)?.command, entry.turnId)
      ) {
        captured = true;
        held.resolve();
        void release.promise.then(() => {
          receive(value, host);
          forwarded.resolve();
        });
        return;
      }
      receive(value, host);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const scan = service.runOnce();
    try {
      await held.promise;
      expect(fixedTurns()).toHaveLength(1);
      await expireDeferredPublication(scan);
      await schedules.deleteAutomation(schedule.responsibleUserId, schedule.id);
      expect(schedules.getAutomation(schedule.id).status).toBe('deleted');
      expect(fixedTurns()).toHaveLength(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(store.getTurnById(entry.turnId).status).toBe('pending');
    } finally {
      vi.useRealTimers();
      release.resolve();
      if (captured) await forwarded.promise;
      await scan;
      reply.mockRestore();
    }
  });

  it('prevents late deferred preparation from posting after the deadline', async () => {
    const { store, schedules, schedule, service, entry, fixedTurns } =
      await deferredPublicationFixture();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const prepare = store.prepareNativeTurnPendingAdmission.bind(store);
    const pause = vi
      .spyOn(store, 'prepareNativeTurnPendingAdmission')
      .mockImplementationOnce(async (...args) => {
        const prepared = await prepare(...args);
        entered.resolve();
        await resume.promise;
        return prepared;
      });
    const create = store.createTurn.bind(store);
    let original: Promise<unknown> | undefined;
    const turn = vi.spyOn(store, 'createTurn').mockImplementationOnce((...args) => {
      const pending = create(...args);
      original = pending.catch(() => undefined);
      return pending;
    });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const scan = service.runOnce();
    try {
      await entered.promise;
      await expireDeferredPublication(scan);
      await schedules.deleteAutomation(schedule.responsibleUserId, schedule.id);
      resume.resolve();
      await original;
      expect(
        post.mock.calls.some(([command]) =>
          isFixedPublication(command as ControlWorkerCommand, entry.turnId)
        )
      ).toBe(false);
      expect(fixedTurns()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      resume.resolve();
      await scan;
      await original;
      post.mockRestore();
      turn.mockRestore();
      pause.mockRestore();
    }
  });

  it.each(['consume-busy', 'defer-busy'] as const)(
    'releases publication ownership after reading back a committed %s with its receipt held',
    async (action) => {
      const { db, store, schedules, schedule, service, entry, fixedTurns } =
        await deferredPublicationFixture();
      const { workspaceId, threadId, responsibleUserId } = schedule;
      const client = getControlStoreWorkerClient() as unknown as {
        receive(value: ControlWorkerReply, host: unknown): void;
      };
      const receive = client.receive.bind(client);
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const forwarded = Promise.withResolvers<void>();
      let markerId: number | undefined;
      let consumeId: number | undefined;
      let captured = false;
      const send = Worker.prototype.postMessage;
      const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        ...args: Parameters<Worker['postMessage']>
      ) {
        const command = args[0] as ControlWorkerRequest;
        if (command.operation === 'transition' && 'content' in command && command.content) {
          const marker = JSON.parse(new TextDecoder().decode(command.content));
          if (marker.queueEntryId === entry.queueEntryId) {
            if (marker.action === action) markerId = command.id;
            if (marker.action === 'consume-busy') consumeId = command.id;
          }
        }
        Reflect.apply(send, this, args);
      });
      const reply = vi.spyOn(client, 'receive').mockImplementation((value, host) => {
        if (action === 'defer-busy' && value.status === 'ok' && value.id === consumeId) {
          void store
            .createTurn(workspaceId, threadId, 'Competing active work.', {
              kind: 'user',
              id: responsibleUserId,
            })
            .then(
              () => receive(value, host),
              (error: unknown) => {
                receive(value, host);
                held.reject(error);
              }
            );
          return;
        }
        if (value.status === 'ok' && value.id === markerId) {
          captured = true;
          held.resolve();
          void release.promise.then(() => {
            receive(value, host);
            forwarded.resolve();
          });
          return;
        }
        receive(value, host);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const scan = service.runOnce();
      try {
        await held.promise;
        expect(schedules.listHistory(schedule.id).items[0]!.record.publicationDeferred).toBe(
          action === 'consume-busy' ? undefined : 'thread_busy'
        );
        await expireDeferredPublication(scan, 31_000);
        if (action === 'consume-busy') {
          const cancel = createSchedulerAdmissionOperationImplementations({
            coreDb: db,
            store,
            repositoryWorkspaceDb: (id) => openWorkspaceDb(db.dataRoot, id),
          })['scheduler.cancel'];
          await expect(
            cancel(
              { workspaceId, queueEntryId: entry.queueEntryId },
              {
                kind: 'public',
                actor: { kind: 'local', userId: responsibleUserId },
                actorRef: { kind: 'user', id: responsibleUserId },
                scope: { kind: 'workspace', workspaceId },
                resolvedLineage: { workspaceId, ownerUserId: responsibleUserId },
              }
            )
          ).resolves.toEqual({ cancelled: true });
          expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('cancelled');
        } else {
          await schedules.deleteAutomation(responsibleUserId, schedule.id);
          expect(schedules.getAutomation(schedule.id).status).toBe('deleted');
          expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('queued');
        }
        release.resolve();
        await forwarded.promise;
        await service.runOnce();
        expect(
          post.mock.calls.some(([command]) =>
            isFixedPublication(command as ControlWorkerCommand, entry.turnId)
          )
        ).toBe(false);
        expect(fixedTurns()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
        release.resolve();
        if (captured) await forwarded.promise;
        await scan;
        reply.mockRestore();
        post.mockRestore();
      }
    }
  );

  it('includes the final idle recheck inside the schedule section in the deadline', async () => {
    const { store, schedules, schedule, service, entry, fixedTurns } =
      await deferredPublicationFixture();
    const enter = schedules.withSchedulePublication.bind(schedules);
    let inSection = false;
    let inspected = false;
    const section = vi
      .spyOn(schedules, 'withSchedulePublication')
      .mockImplementation((id, run, waitMs) =>
        enter(
          id,
          async () => {
            inSection = id === schedule.id;
            try {
              return await run();
            } finally {
              inSection = false;
            }
          },
          waitMs
        )
      );
    const read = store.readThreadNavigationFacts.bind(store);
    const idle = vi.spyOn(store, 'readThreadNavigationFacts').mockImplementation((...args) => {
      const facts = read(...args);
      if (inSection && !inspected) {
        inspected = true;
        vi.advanceTimersByTime(31_000);
      }
      return facts;
    });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      await service.runOnce();
      expect(inspected).toBe(true);
      expect(
        post.mock.calls.some(([command]) =>
          isFixedPublication(command as ControlWorkerCommand, entry.turnId)
        )
      ).toBe(false);
      expect(fixedTurns()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      post.mockRestore();
      idle.mockRestore();
      section.mockRestore();
    }
  });

  it('withdraws an exact native request held before posting by a backup', async () => {
    const { db, schedules, schedule, service, entry, fixedTurns } =
      await deferredPublicationFixture();
    const client = getControlStoreWorkerClient();
    const scope = nativeProductScope(db.dataRoot, {
      kind: 'workspace',
      workspaceId: entry.workspaceId,
    });
    const release = await client.pauseForDataRootBackup(`workspace:${scope.path}`);
    const write = client.products.bind(client);
    const entered = Promise.withResolvers<void>();
    let original: Promise<unknown> | undefined;
    const prepared = vi.spyOn(client, 'products').mockImplementationOnce((...args) => {
      const pending = write(...args);
      original = pending.catch((error: unknown) => error);
      entered.resolve();
      return pending;
    });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const scan = service.runOnce();
    try {
      await entered.promise;
      await expireDeferredPublication(scan);
      await expect(original).resolves.toMatchObject({ commit: 'not-committed' });
      release();
      await schedules.deleteAutomation(schedule.responsibleUserId, schedule.id);
      expect(
        post.mock.calls.some(([command]) =>
          isFixedPublication(command as ControlWorkerCommand, entry.turnId)
        )
      ).toBe(false);
      expect(fixedTurns()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      release();
      await scan;
      await original;
      post.mockRestore();
      prepared.mockRestore();
    }
  });

  it('shows the age of unproved posted delivery and still admits an unrelated schedule', async () => {
    const { db, store, schedules, schedule, service, entry, fixedTurns, clock } =
      await deferredPublicationFixture();
    const { workspaceId, responsibleUserId } = schedule;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = Worker.prototype.postMessage;
    let posts = 0;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      if (isFixedPublication(args[0] as ControlWorkerCommand, entry.turnId)) {
        posts += 1;
        held.resolve();
        void release.promise.then(() => Reflect.apply(send, this, args));
        return;
      }
      Reflect.apply(send, this, args);
    });
    const history = (includePublicationDiagnostics?: true) =>
      AutomationHistoryResponseSchema.parse(
        createAutomationOperationImplementations({ automationStore: schedules, coreDb: db, store })[
          'automation.history'
        ](
          {
            automationId: schedule.id,
            ...(includePublicationDiagnostics ? { includePublicationDiagnostics } : {}),
          },
          {
            kind: 'public',
            actor: { kind: 'local', userId: responsibleUserId },
            actorRef: { kind: 'user', id: responsibleUserId },
            scope: { kind: 'workspace', workspaceId },
            resolvedLineage: { workspaceId, ownerUserId: responsibleUserId },
          }
        )
      ).items[0]!.record;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const scan = service.runOnce();
    try {
      await held.promise;
      await expireDeferredPublication(scan);
      const currentHistory = history(true);
      expect(currentHistory).toMatchObject({
        publicationUncertainSince: clock(),
        publicationIssue: 'turn_missing',
        turnId: null,
      });
      const defaultHistory = history();
      expect(defaultHistory).not.toHaveProperty('publicationUncertainSince');
      expect(currentHistory).toEqual({
        ...defaultHistory,
        publicationUncertainSince: clock(),
      });
      expect(fixedTurns()).toHaveLength(0);
      const otherThread = await store.createThread(workspaceId, 'Unaffected Thread');
      const other = await schedules.createAutomation(responsibleUserId, {
        workspaceId,
        threadId: otherThread.id,
        name: 'Unaffected schedule',
        intervalSeconds: 5,
        prompt: 'Inspect status',
      });
      await schedules.updateAutomation(responsibleUserId, other.id, {
        expectedRevision: other.revision,
        status: 'active',
        scheduledAt: clock(),
      });
      await service.runOnce();
      expect(store.listThreadTurns(workspaceId, otherThread.id)).toHaveLength(1);
      expect(posts).toBe(1);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deletion = schedules
        .deleteAutomation(responsibleUserId, schedule.id)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(deletion).resolves.toMatchObject({ code: 'schedule_publication_in_progress' });
      vi.useRealTimers();
      release.resolve();
      await vi.waitFor(() => expect(fixedTurns()).toHaveLength(1), { timeout: 5_000 });
      await schedules.deleteAutomation(responsibleUserId, schedule.id);
      expect(history(true)).not.toHaveProperty('publicationUncertainSince');
      expect(posts).toBe(1);
    } finally {
      vi.useRealTimers();
      release.resolve();
      await scan;
      post.mockRestore();
    }
  });

  it('keeps healthy admission and maintenance running after an admitted cadence exhausts the UTC range', async () => {
    const { schedules, schedule, start, setTime } = await fixture();
    const paused = await schedules.updateAutomation(schedule.responsibleUserId, schedule.id, {
      expectedRevision: schedule.revision,
      status: 'paused',
    });
    const created = await schedules.createAutomation(schedule.responsibleUserId, {
      workspaceId: schedule.workspaceId,
      threadId: schedule.threadId,
      name: 'Long cadence',
      intervalSeconds: 250_000_000_000,
      prompt: 'Inspect status',
    });
    const active = await schedules.updateAutomation(schedule.responsibleUserId, created.id, {
      expectedRevision: created.revision,
      status: 'active',
      scheduledAt: '2026-10-16T00:00:00.000Z',
    });
    const [initial] = await schedules.collectScanCandidates('2026-10-16T00:00:00.000Z');
    expect(initial?.scheduleId).toBe(active.id);
    await schedules.commitAttempt(initial!.id, initial!.definitionRevision, structuredClone(ready));
    // This state is produced by admission and scan owners, without fabricating retained rows.
    const finalInstant = '9948-12-22T12:26:40.000Z';
    await schedules.updateAutomation(schedule.responsibleUserId, schedule.id, {
      expectedRevision: paused.revision,
      status: 'active',
      scheduledAt: finalInstant,
    });
    setTime(finalInstant);
    const prepare = vi.fn(
      async (): Promise<RecurringPreparation> => ({
        kind: 'failure',
        code: 'selection_unavailable',
      })
    );
    const maintenance = vi.fn();
    const { service, onError } = start(prepare, maintenance);
    await service.runOnce();
    const healthyHistory = schedules.listHistory(schedule.id).items;
    expect(
      healthyHistory.find(
        (item) => item.kind === 'occurrence' && item.record.scheduledAt === finalInstant
      )
    ).toMatchObject({
      record: { state: 'pending', attempts: [{ number: 1 }] },
    });
    expect(schedules.getAutomation(active.id).nextScheduledAt).toBeNull();
    expect(maintenance).toHaveBeenCalledTimes(1);
    // The exhausted successor is diagnosed once, not retried on every five-second scan.
    expect(onError).toHaveBeenCalledTimes(1);
    await service.runOnce();
    expect(
      schedules
        .listHistory(schedule.id)
        .items.find(
          (item) => item.kind === 'occurrence' && item.record.scheduledAt === finalInstant
        )
    ).toMatchObject({ record: { attempts: [{ number: 1 }, { number: 2 }] } });
    expect(maintenance).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping callbacks and retries a failure only on a later scan', async () => {
    const { schedules, schedule, start } = await fixture();
    const preparationEntered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let preparationIndex = 0;
    let release!: (value: RecurringPreparation) => void;
    const prepare = vi.fn(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
          preparationEntered[preparationIndex++]!.resolve();
        })
    );
    const { service } = start(prepare);
    const first = service.runOnce();
    expect(service.runOnce()).toBe(first);
    await preparationEntered[0]!.promise;
    expect(prepare).toHaveBeenCalledTimes(1);
    release({ kind: 'failure', code: 'selection_unavailable' });
    await first;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'pending',
      attempts: [{ code: 'selection_unavailable' }],
    });
    const second = service.runOnce();
    await preparationEntered[1]!.promise;
    expect(prepare).toHaveBeenCalledTimes(2);
    release({ kind: 'failure', code: 'selection_unavailable' });
    await second;
    const third = service.runOnce();
    await preparationEntered[2]!.promise;
    release({ kind: 'failure', code: 'selection_unavailable' });
    await third;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'admission-failed',
      attempts: [{ number: 1 }, { number: 2 }, { number: 3 }],
    });
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('rechecks the exact responsible membership after slow preparation without actor substitution', async () => {
    const { db, schedules, schedule, workspace, start } = await fixture();
    const preparationEntered = Promise.withResolvers<void>();
    let release!: (value: RecurringPreparation) => void;
    const prepare = vi.fn(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
          preparationEntered.resolve();
        })
    );
    const { service } = start(prepare);
    const scan = service.runOnce();
    await preparationEntered.promise;
    db.sqlite.transaction(() => {
      const timestamp = '2026-10-16T00:00:00.000Z';
      db.sqlite
        .prepare(`INSERT INTO users
        (id, display_name, email, email_verified, created_at, updated_at, kind)
        VALUES (?, 'Replacement', 'recurrence-replacement@example.com', false, ?, ?, 'human')`)
        .run(testEntityId('usr', 'user_replacement'), Date.parse(timestamp), Date.parse(timestamp));
      db.sqlite
        .prepare(`INSERT INTO workspace_members
        (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
        VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`)
        .run(
          workspace.id,
          testEntityId('usr', 'user_replacement'),
          timestamp,
          timestamp,
          timestamp
        );
      db.sqlite
        .prepare(`UPDATE workspace_registry SET owner_user_id = ?, revision = revision + 1, updated_at = ?
        WHERE workspace_id = ?`)
        .run(testEntityId('usr', 'user_replacement'), timestamp, workspace.id);
      db.sqlite
        .prepare(`UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
        WHERE workspace_id = ? AND user_id = ?`)
        .run(timestamp, timestamp, workspace.id, schedule.responsibleUserId);
    })();
    release(structuredClone(ready));
    await scan;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'pending',
      attempts: [{ code: 'authority_denied' }],
      snapshot: { actor: schedule.actor },
    });
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('expires when preparation crosses the original deadline without counting an outcome', async () => {
    const { db, schedules, schedule, setTime, start } = await fixture();
    const preparationEntered = Promise.withResolvers<void>();
    let release!: (value: RecurringPreparation) => void;
    const { service } = start(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
          preparationEntered.resolve();
        })
    );
    const scan = service.runOnce();
    await preparationEntered.promise;
    setTime('2026-10-16T00:10:00.000Z');
    release(structuredClone(ready));
    await scan;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'expired',
      attempts: [],
      resolvedPayload: null,
    });
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
  });

  it('lets pause win against a scanner awaiting preparation', async () => {
    const { db, schedules, schedule, start } = await fixture();
    const preparationEntered = Promise.withResolvers<void>();
    let release!: (value: RecurringPreparation) => void;
    const { service } = start(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
          preparationEntered.resolve();
        })
    );
    const scan = service.runOnce();
    await preparationEntered.promise;
    await schedules.updateAutomation(schedule.responsibleUserId, schedule.id, {
      expectedRevision: schedule.revision,
      status: 'paused',
    });
    release(structuredClone(ready));
    await scan;
    expect(schedules.listHistory(schedule.id).items[0]!.record.state).toBe('cancelled');
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
  });

  it('fences unknown preparation effects and does not retry them', async () => {
    const { schedules, schedule, start } = await fixture();
    const prepare = vi.fn(async () => {
      throw new Error('unknown owner effect');
    });
    const { service, onError } = start(prepare);
    await service.runOnce();
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'recovery_required',
      attempts: [],
    });
  });

  it('keeps unknown preparation fenced after current user authority is lost', async () => {
    const { db, schedules, schedule, start } = await fixture();
    const preparationEntered = Promise.withResolvers<void>();
    let rejectPreparation!: (error: Error) => void;
    const prepare = vi.fn(
      () =>
        new Promise<RecurringPreparation>((_resolve, reject) => {
          rejectPreparation = reject;
          preparationEntered.resolve();
        })
    );
    const { service, onError } = start(prepare);
    const scan = service.runOnce();
    await preparationEntered.promise;
    db.sqlite
      .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
      .run(schedule.actor.responsibleUserId);
    rejectPreparation(new Error('unknown preparation outcome'));
    await scan;
    const history = schedules.listHistory(schedule.id).items[0]!.record;
    expect(history).toMatchObject({ state: 'recovery_required', attempts: [] });
    db.sqlite
      .prepare("UPDATE users SET status = 'active' WHERE id = ?")
      .run(schedule.actor.responsibleUserId);
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(schedules.listHistory(schedule.id).items[0]!.record).toEqual(history);
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
  });

  it('honors the existing Workspace mutation fence before materialization', async () => {
    const { db, workspace, start } = await fixture();
    await getControlStoreWorkerClient().closeWorkspaceMutations(db.dataRoot, workspace.id);
    const prepare = vi.fn(async () => structuredClone(ready));
    const { service } = start(prepare);
    await service.runOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM recurring_occurrences').get()).toEqual({
      n: 0,
    });
  });
});

it('inspects durable acceptance after an unknown commit result and never submits it again', async () => {
  const { db, schedules, schedule, start } = await fixture();
  const original = schedules.commitAttempt.bind(schedules);
  let loseResult = true;
  vi.spyOn(schedules, 'commitAttempt').mockImplementation(async (...input) => {
    const accepted = await original(...input);
    if (loseResult) {
      loseResult = false;
      throw new Error('commit acknowledgement lost');
    }
    return accepted;
  });
  const prepare = vi.fn(async () => structuredClone(ready));
  const { service, onError } = start(prepare);
  await service.runOnce();
  await service.runOnce();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
    state: 'admission-accepted',
    attempts: [{ number: 1, code: 'accepted' }],
  });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 1,
  });
});

it('uses the first staged recurring choices when the writer restarts before Core acceptance', async () => {
  const { root, schedules, schedule, clock } = await fixture();
  const occurrence = (await schedules.collectScanCandidates(clock()))[0]!;
  const inputRef = await stageRecurringQueueInput(root, occurrence, ready);
  await shutdownControlStoreWorkerClient();
  const reopened = openCoreDb(root);
  const reopenedSchedules = new AutomationStore(reopened, clock);
  const prepare = vi.fn(async () => ({
    kind: 'ready' as const,
    payload: { ...ready.payload, modelId: 'new-model' },
  }));
  const onError = vi.fn();
  const service = startRecurringScheduleService({
    schedules: reopenedSchedules,
    store: createTestStore({ dataRoot: root }),
    prepare,
    now: clock,
    onError,
    setInterval: () => 'timer',
    clearInterval: () => {},
  });
  try {
    await service.runOnce();
    const accepted = reopenedSchedules.listHistory(schedule.id).items[0]!.record;
    expect(prepare).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(accepted).toMatchObject({
      state: 'admission-accepted',
      inputRef,
      resolvedPayload: ready.payload,
    });
    expect(requireSchedulerAdmissionEntry(reopened, accepted.queueEntryId!)).toMatchObject({
      inputRef,
      modelId: ready.payload.modelId,
    });
  } finally {
    service.stop();
    reopened.sqlite.close();
  }
});

it('keeps a pending occurrence on hold when its selected Workspace input is missing', async () => {
  const { root, db, workspace, schedules, clock, start } = await fixture();
  const occurrence = (await schedules.collectScanCandidates(clock()))[0]!;
  const inputRef = await stageRecurringQueueInput(root, occurrence, ready);
  const pending = await schedules.commitAttempt(
    occurrence.id,
    occurrence.definitionRevision,
    ready,
    () => ({ kind: 'failure', code: 'selection_unavailable' }),
    inputRef
  );
  expect(pending).toMatchObject({ state: 'pending', inputRef, resolvedPayload: ready.payload });
  await shutdownControlStoreWorkerClient();
  const owner = openWorkspaceDb(root, workspace.id);
  try {
    expect(
      owner.sqlite
        .prepare('DELETE FROM workspace_work_inputs WHERE input_id = ?')
        .run(inputRef.inputId).changes
    ).toBe(1);
    const prepare = vi.fn(async () => structuredClone(ready));
    const { service, onError } = start(prepare);
    await service.runOnce();

    expect(
      owner.sqlite
        .prepare('SELECT 1 FROM workspace_work_inputs WHERE input_id = ?')
        .get(inputRef.inputId)
    ).toBeUndefined();
    expect(schedules.getOccurrence(occurrence.id)).toEqual(pending);
    expect(db.sqlite.prepare('SELECT 1 FROM scheduler_admission_entries').get()).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'recovery_required' }));
  } finally {
    owner.sqlite.close();
  }
});

it.each(['changed snapshot prompt', 'missing accepted source'] as const)(
  'holds the accepted recurring input on %s after a live schedule edit',
  async (fault) => {
    const { db, store, schedules, schedule, start } = await fixture();
    const { service } = start();
    await service.runOnce();
    service.stop();
    const occurrence = schedules.listHistory(schedule.id).items[0]!.record;
    expect(occurrence.state).toBe('admission-accepted');
    const entry = requireSchedulerAdmissionEntry(db, occurrence.queueEntryId!);
    const paused = await schedules.updateAutomation(schedule.responsibleUserId, schedule.id, {
      expectedRevision: schedule.revision,
      status: 'paused',
    });
    await schedules.updateAutomation(schedule.responsibleUserId, schedule.id, {
      expectedRevision: paused.revision,
      prompt: 'A later schedule revision.',
    });

    expect(readScheduledAdmissionText(db, entry)).toBe(occurrence.snapshot.prompt);
    expect(recurringTurnPublicationIssue(db, store, entry)).toBeNull();
    const corruption =
      fault === 'changed snapshot prompt'
        ? db.sqlite.prepare(
            "UPDATE recurring_occurrences SET record_json = json_set(record_json, '$.snapshot.prompt', 'Contradictory original prompt') WHERE queue_entry_id = ?"
          )
        : db.sqlite.prepare('DELETE FROM recurring_occurrences WHERE queue_entry_id = ?');
    expect(corruption.run(entry.queueEntryId).changes).toBe(1);

    expect(readScheduledAdmissionText(db, entry)).toBeNull();
    expect(recurringTurnPublicationIssue(db, store, entry)).toBe('turn_contradictory');
  }
);

it('does not accept into a private Thread owned by another responsible user', async () => {
  const { store, schedules, schedule, workspace, thread, start } = await fixture();
  const original = store.getThread.bind(store);
  vi.spyOn(store, 'getThread').mockImplementation((workspaceId, threadId) =>
    workspaceId === workspace.id && threadId === thread.id
      ? {
          ...original(workspaceId, threadId),
          visibility: 'private',
          privateOwnerUserId: testEntityId('usr', 'user_other'),
        }
      : original(workspaceId, threadId)
  );
  const prepare = vi.fn(async () => structuredClone(ready));
  const { service } = start(prepare);
  await service.runOnce();
  expect(prepare).not.toHaveBeenCalled();
  expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
    state: 'pending',
    attempts: [{ code: 'authority_denied' }],
  });
});

it('holds mutation admission through bounded preparation so backup waits for the scanner to leave', async () => {
  const { db, workspace, start } = await fixture();
  const preparationEntered = Promise.withResolvers<void>();
  let release!: (value: RecurringPreparation) => void;
  const { service } = start(
    () =>
      new Promise<RecurringPreparation>((resolve) => {
        release = resolve;
        preparationEntered.resolve();
      })
  );
  const scan = service.runOnce();
  await preparationEntered.promise;
  let closed = false;
  const closing = getControlStoreWorkerClient()
    .closeWorkspaceMutations(db.dataRoot, workspace.id)
    .then(() => {
      closed = true;
    });
  await Promise.resolve();
  expect(closed).toBe(false);
  release(structuredClone(ready));
  await scan;
  await closing;
  expect(closed).toBe(true);
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
});

it('owns one scanner across distinct Core handles for the same data root', async () => {
  const { root, store, start } = await fixture();
  const first = start();
  await first.service.runOnce();
  const otherDb = openCoreDb(root);
  let duplicate: RecurringScheduleService | undefined;
  try {
    expect(() => {
      duplicate = startRecurringScheduleService({
        schedules: new AutomationStore(otherDb),
        store,
        prepare: async () => structuredClone(ready),
        setInterval: () => 'duplicate',
        clearInterval: () => {},
      });
    }).toThrow('Recurring scanner already owns this Core');
  } finally {
    duplicate?.stop();
    first.service.stop();
    otherDb.sqlite.close();
  }
});

it('reconciles an already accepted queue without attempting initial file publication again', async () => {
  const { db, schedules, schedule, store, clock, start } = await fixture();
  const occurrence = (await schedules.collectScanCandidates(clock()))[0]!;
  const accepted = (await schedules.commitAttempt(occurrence.id, 2, structuredClone(ready)))!;
  // Reuse the owner's exact-replay fixture: accepted attempt evidence stays intact.
  db.sqlite
    .prepare('UPDATE recurring_occurrences SET state = ?, record_json = ? WHERE id = ?')
    .run(
      'pending',
      JSON.stringify({ ...accepted, state: 'pending', terminalAt: null }),
      occurrence.id
    );
  const create = vi.spyOn(store, 'createTurn');
  const { service } = start();
  await service.runOnce();
  expect(schedules.getOccurrence(occurrence.id)).toMatchObject({ state: 'admission-accepted' });
  expect(create).not.toHaveBeenCalled();
  expect(store.listThreadTurns(schedule.workspaceId, schedule.threadId)).toEqual([]);
});

it('prepares Knowledge maintenance after Worker candidates and contains callback failures on empty scans', async () => {
  const { store, start } = await fixture();
  const events: string[] = [];
  const createTurn = store.createTurn.bind(store);
  vi.spyOn(store, 'createTurn').mockImplementation((...input) => {
    events.push('worker');
    return createTurn(...input);
  });
  const failure = new Error('Knowledge maintenance preparation is unavailable.');
  const prepareKnowledgeMaintenance = vi.fn(async (instant: string) => {
    expect(instant).toBe('2026-10-16T00:00:00.000Z');
    events.push('knowledge');
    if (events.length === 2) throw failure;
  });
  const { service, onError, setTimer } = start(undefined, prepareKnowledgeMaintenance);
  await service.runOnce();
  expect(events).toEqual(['worker', 'knowledge']);
  expect(onError).toHaveBeenCalledWith(failure);
  await service.runOnce();
  expect(events).toEqual(['worker', 'knowledge', 'knowledge']);
  expect(prepareKnowledgeMaintenance).toHaveBeenCalledTimes(2);
  expect(setTimer).toHaveBeenCalledTimes(1);
});
