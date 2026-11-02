import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { insertExternalTriggerAdmission } from './external-trigger-admissions.js';
import { applyMigrations } from './migrate.js';
import {
  exportRecurringPortableHistory,
  RECURRING_PORTABLE_CORE_TABLES,
  readRecurringPortableHistory,
  validateRecurringPortableHistory,
} from './recurring-portable-history.js';
import { readPublishedTurnFileRecords } from './workspace-file-records.js';

describe('recurring portable history', () => {
  let localUserId: string;
  let dataRoot: string;
  let coreDb: CoreDb;
  let store: AutomationStore;
  let instant: string;
  let files: FsStore;
  let workspace: Awaited<ReturnType<FsStore['createWorkspace']>>;
  let thread: Awaited<ReturnType<FsStore['createThread']>>;
  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'recurrence-portable-'));
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    localUserId = ensureLocalUser(coreDb);
    files = new FsStore({ dataRoot });
    workspace = await files.createWorkspace('Portable history');
    thread = await files.createThread(workspace.id, 'Existing target');
    instant = '2026-10-16T00:00:00.000Z';
    store = new AutomationStore(coreDb, new WorkspaceMutationAdmission(), () => instant);
  });
  afterEach(async () => {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  async function acceptedHistory(publish = true) {
    const schedule = await store.createAutomation(localUserId, {
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Inspect',
      prompt: 'Retained exact input',
      intervalSeconds: 5,
    });
    await store.updateAutomation(localUserId, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    const occurrence = store.collectScanCandidates(instant)[0]!;
    await store.commitAttempt(occurrence.id, 2, {
      kind: 'ready',
      payload: {
        backendId: 'private-backend',
        requestedAgentId: 'historical-worker',
        profileRef: 'historical-profile',
        modelId: 'historical-model',
        workspaceRoots: [],
        workspaceCwd: '/private/host/workspace',
        reasoningEffort: 'high',
      },
    });
    const accepted = store.getOccurrence(occurrence.id);
    if (publish) {
      const entry = requireSchedulerAdmissionEntry(coreDb, accepted.queueEntryId!);
      await files.createTurn(
        entry.workspaceId,
        entry.threadId,
        entry.turnInput,
        entry.triggerActor,
        null,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: entry.requestedAgentId,
          executorKind: 'worker',
          reasoningEffort: entry.reasoningEffort,
        }
      );
      expect(
        readPublishedTurnFileRecords(dataRoot, workspace.id, thread.id, entry.turnId)
      ).not.toBeNull();
    }
    return { schedule, occurrence: accepted };
  }

  function retainedTurns() {
    return files.listThreadTurns(workspace.id, thread.id).flatMap((turn) => {
      const published = readPublishedTurnFileRecords(dataRoot, workspace.id, thread.id, turn.id);
      return published ? [published.turn] : [];
    });
  }

  it('explicitly accounts for every recurring Core history table', () => {
    const names = coreDb.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'recurring_%' OR name LIKE 'external_trigger_%') ORDER BY name"
      )
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual([...RECURRING_PORTABLE_CORE_TABLES].sort());
  });

  it('exports the whitelist graph with an actually retained canonical Turn', async () => {
    const { schedule, occurrence } = await acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    expect(graph.schedules).toEqual([
      expect.objectContaining({
        id: schedule.id,
        originScheduleId: schedule.id,
        originActor: schedule.actor,
        status: 'active',
      }),
    ]);
    expect(graph.occurrences).toEqual([
      expect.objectContaining({
        id: occurrence.id,
        originRequestId: occurrence.requestId,
        originQueueEntryId: occurrence.queueEntryId,
        originTurnId: occurrence.turnId,
        turnId: occurrence.turnId,
        resolvedSelection: {
          agentId: 'historical-worker',
          profileId: 'historical-profile',
          modelId: 'historical-model',
          reasoningEffort: 'high',
        },
      }),
    ]);
    expect(JSON.stringify(graph)).not.toContain('/private/host/workspace');
    expect(JSON.stringify(graph)).not.toContain('private-backend');
    expect(JSON.stringify(graph)).not.toContain('resolvedPayload');
    expect(graph.expiredRanges).toEqual([]);
    validateRecurringPortableHistory(JSON.stringify(graph));
  });

  it('retains a Turn reference only when the exact exported Thread owns it', async () => {
    const { occurrence } = await acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, [
      { id: occurrence.turnId!, threadId: thread.id },
    ]);
    expect(graph.occurrences[0]).toMatchObject({ turnId: occurrence.turnId });
    expect(() =>
      exportRecurringPortableHistory(coreDb, workspace.id, null, [
        { id: occurrence.turnId!, threadId: testEntityId('th', 'th_other') },
      ])
    ).toThrow();
  });

  it('preserves external event joins as remapped inert history without target queue authority', async () => {
    const { schedule, occurrence } = await acceptedHistory();
    const targetThread = await files.createThread(
      workspace.id,
      'Isolated case',
      undefined,
      'conversation',
      { visibility: 'workspace', threadSource: 'worker', parentThreadId: thread.id }
    );
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'private-backend',
      queueEntryId: 'external-case-queue',
      requestedAgentId: 'historical-worker',
      workspaceId: workspace.id,
      threadId: targetThread.id,
      turnId: testEntityId('tu', 'tu_external_case'),
      triggerActor: schedule.actor,
      turnInput: 'One explicit case brief',
    });
    const join = coreDb.sqlite.transaction(() =>
      insertExternalTriggerAdmission(coreDb, {
        scheduleId: schedule.id,
        eventKey: 'source/message-1',
        sourceTurnId: occurrence.turnId!,
        queueEntryId: entry.queueEntryId,
      })
    )();
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    expect(graph.schedules[0]!.externalAdmissions).toEqual([join]);
    expect(() =>
      readRecurringPortableHistory({
        ...graph,
        schedules: [{ ...graph.schedules[0], externalAdmissions: [join, join] }],
      })
    ).toThrow('repeats or contradicts');
  });

  it('refuses a reserved accepted Turn without published canonical evidence', async () => {
    await acceptedHistory(false);
    expect(() =>
      exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns())
    ).toThrow('requires inspection');
  });

  it('rejects duplicate tuples, contradictory range arithmetic, overlapping coverage and attempt violations', async () => {
    await acceptedHistory();
    instant = '2026-10-16T02:00:00.000Z';
    store.collectScanCandidates(instant);
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    expect(graph.expiredRanges.length).toBeGreaterThan(0);
    const invalid = structuredClone(graph);
    invalid.expiredRanges[0]!.count += 1;
    expect(() => validateRecurringPortableHistory(JSON.stringify(invalid))).toThrow();
    const duplicate = structuredClone(graph);
    duplicate.occurrences.push({ ...duplicate.occurrences[0]!, id: 'different-id' });
    expect(() => validateRecurringPortableHistory(JSON.stringify(duplicate))).toThrow();
    const overlap = structuredClone(graph);
    overlap.expiredRanges.push({ ...overlap.expiredRanges[0]!, id: 'different-range' });
    expect(() => validateRecurringPortableHistory(JSON.stringify(overlap))).toThrow();
    const attempt = structuredClone(graph);
    attempt.occurrences.find((row) => row.attempts.length > 0)!.attempts[0]!.number = 2;
    expect(() => validateRecurringPortableHistory(JSON.stringify(attempt))).toThrow();
  });

  it('rejects origin ownership, missing graph references and contradictory accepted attempts', async () => {
    await acceptedHistory();
    const source = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    const ownership = structuredClone(source);
    ownership.schedules[0]!.originActor.id = 'another-origin';
    expect(() => validateRecurringPortableHistory(JSON.stringify(ownership))).toThrow();
    const missing = structuredClone(source);
    missing.occurrences[0]!.scheduleId = 'missing-schedule';
    expect(() => validateRecurringPortableHistory(JSON.stringify(missing))).toThrow();
    const acceptedTwice = structuredClone(source);
    acceptedTwice.occurrences[0]!.attempts.push({
      ...acceptedTwice.occurrences[0]!.attempts[0]!,
      number: 2,
    });
    expect(() => validateRecurringPortableHistory(JSON.stringify(acceptedTwice))).toThrow();
    const turn = structuredClone(source);
    turn.occurrences[0]!.turnId = null;
    expect(() => validateRecurringPortableHistory(JSON.stringify(turn))).toThrow();
    expect(() =>
      readRecurringPortableHistory(source, {
        workspaceId: workspace.id,
        threadIds: new Set(),
        turns: new Map(),
      })
    ).toThrow('Thread reference');
  });

  it('rejects different occurrences claiming the same retained Turn', async () => {
    const first = await acceptedHistory();
    const firstThread = thread;
    thread = await files.createThread(workspace.id, 'Second target');
    const second = await acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, [
      readPublishedTurnFileRecords(
        dataRoot,
        workspace.id,
        firstThread.id,
        first.occurrence.turnId!
      )!.turn,
      readPublishedTurnFileRecords(dataRoot, workspace.id, thread.id, second.occurrence.turnId!)!
        .turn,
    ]);
    graph.occurrences[1]!.turnId = graph.occurrences[0]!.turnId;
    expect(() => validateRecurringPortableHistory(JSON.stringify(graph))).toThrow(
      'share one retained Turn'
    );
  });

  it('rejects exact range coverage of an already materialized individual instant', async () => {
    await acceptedHistory();
    instant = '2026-10-16T02:00:00.000Z';
    store.collectScanCandidates(instant);
    const source = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    const range = source.expiredRanges[0]!;
    range.firstScheduledAt = '2026-10-16T00:00:00.000Z';
    range.count += 1;
    expect(() => validateRecurringPortableHistory(JSON.stringify(source))).toThrow(
      'individual nominal instant'
    );
  });

  it('preserves exact monthly rules and compact ranges as inert portable history', async () => {
    instant = '2026-01-01T00:00:00.000Z';
    const monthlyUtc = { zone: 'UTC', dayOfMonth: 28, hour: 9, minute: 30, second: 0 } as const;
    const schedule = await store.createAutomation(localUserId, {
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Monthly',
      prompt: 'Monthly input',
      monthlyUtc,
    });
    await store.updateAutomation(localUserId, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: '2026-01-28T09:30:00.000Z',
    });
    instant = '2026-05-28T09:30:00.000Z';
    store.collectScanCandidates(instant);
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    expect(graph.schedules[0]).toMatchObject({ monthlyUtc });
    expect(graph.schedules[0]).not.toHaveProperty('intervalSeconds');
    expect(graph.expiredRanges).toEqual([
      expect.objectContaining({
        monthlyUtc,
        firstScheduledAt: '2026-01-28T09:30:00.000Z',
        lastScheduledAt: '2026-04-28T09:30:00.000Z',
        count: 4,
        snapshot: expect.objectContaining({ monthlyUtc }),
      }),
    ]);
    expect(graph.expiredRanges[0]).not.toHaveProperty('intervalSeconds');
    expect(graph.occurrences[0]).toMatchObject({
      scheduledAt: '2026-05-28T09:30:00.000Z',
      snapshot: expect.objectContaining({ monthlyUtc }),
      state: 'pending',
    });
    const count = structuredClone(graph);
    count.expiredRanges[0]!.count += 1;
    expect(() => validateRecurringPortableHistory(JSON.stringify(count))).toThrow();
    const snapshot = structuredClone(graph);
    snapshot.expiredRanges[0]!.snapshot.monthlyUtc!.dayOfMonth = 27;
    expect(() => validateRecurringPortableHistory(JSON.stringify(snapshot))).toThrow();
    const nominal = structuredClone(graph);
    nominal.occurrences[0]!.scheduledAt = '2026-05-27T09:30:00.000Z';
    expect(() => validateRecurringPortableHistory(JSON.stringify(nominal))).toThrow();
  });

  it('rejects unsupported required semantics and reads descriptive additions without exporting them', async () => {
    await acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns());
    expect(() =>
      validateRecurringPortableHistory(
        JSON.stringify({
          ...graph,
          requiredFeatures: ['unknown-authority'],
        })
      )
    ).toThrow();
    const inherited = JSON.stringify({ ...graph, futureDescription: 'ignored' });
    validateRecurringPortableHistory(inherited);
    const exported = exportRecurringPortableHistory(undefined, workspace.id, inherited, []);
    expect(exported).toEqual(graph);
  });
});
