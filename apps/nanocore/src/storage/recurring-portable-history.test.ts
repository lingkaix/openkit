import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSqliteAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { type CoreDb, openCoreDb } from './db.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { deriveEntityId } from '@openkit/protocol';
import { applyMigrations } from './migrate.js';
import {
  exportRecurringPortableHistory,
  RECURRING_PORTABLE_CORE_TABLES,
  readRecurringPortableHistory,
  remapRecurringPortableHistory,
  validateRecurringPortableHistory,
} from './recurring-portable-history.js';
import { writeWorkspaceExportTree } from './workspace-export.js';
import { readPublishedTurnFileRecords } from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';
import { readWorkspacePortableFileState } from './workspace-portable-file-state.js';

describe('recurring portable history', () => {
  let localUserId: string;
  let dataRoot: string;
  let coreDb: CoreDb;
  let store: AutomationStore;
  let instant: string;
  let files: FsStore;
  let workspace: ReturnType<FsStore['createWorkspace']>;
  let thread: ReturnType<FsStore['createThread']>;
  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'recurrence-portable-'));
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    localUserId = ensureLocalUser(coreDb);
    files = new FsStore({ dataRoot });
    workspace = files.createWorkspace('Portable history');
    thread = files.createThread(workspace.id, 'Existing target');
    instant = '2026-10-16T00:00:00.000Z';
    store = new AutomationStore(coreDb, new WorkspaceMutationAdmission(), () => instant);
  });
  afterEach(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  function acceptedHistory(publish = true) {
    const schedule = store.createAutomation(localUserId, {
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Inspect',
      prompt: 'Retained exact input',
      intervalSeconds: 5,
    });
    store.updateAutomation(localUserId, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    const occurrence = store.collectScanCandidates(instant)[0]!;
    store.commitAttempt(occurrence.id, 2, {
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
      files.createTurn(
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
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'recurring_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual([...RECURRING_PORTABLE_CORE_TABLES].sort());
  });

  it('exports the whitelist graph with an actually retained canonical Turn', () => {
    const { schedule, occurrence } = acceptedHistory();
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

  it('retains a Turn reference only when the exact exported Thread owns it', () => {
    const { occurrence } = acceptedHistory();
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

  it('rewrites only admitted import-map identities and keeps source authority inert across repeated transfer', () => {
    const { schedule, occurrence } = acceptedHistory();
    const source = exportRecurringPortableHistory(coreDb, workspace.id, null, [
      { id: occurrence.turnId!, threadId: thread.id },
    ]);
    const maps = {
      workspaceId: testEntityId('ws', 'ws_target'),
      scheduleIds: new Map([[schedule.id, testEntityId('auto', 'auto_target')]]),
      occurrenceIds: new Map([[occurrence.id, deriveEntityId('occ', [testEntityId('auto', 'auto_target'), occurrence.scheduledAt])]]),
      rangeIds: new Map<string, string>(),
      threadIds: new Map([[thread.id, testEntityId('th', 'th_target')]]),
      turnIds: new Map([[occurrence.turnId!, testEntityId('tu', 'tu_target')]]),
    };
    const imported = remapRecurringPortableHistory(source, maps);
    expect(imported.schedules[0]).toMatchObject({
      id: testEntityId('auto', 'auto_target'),
      workspaceId: testEntityId('ws', 'ws_target'),
      threadId: testEntityId('th', 'th_target'),
      originScheduleId: schedule.id,
      originActor: schedule.actor,
      status: 'active',
    });
    expect(imported.occurrences[0]).toMatchObject({
      id: deriveEntityId('occ', [testEntityId('auto', 'auto_target'), occurrence.scheduledAt]),
      scheduleId: testEntityId('auto', 'auto_target'),
      workspaceId: testEntityId('ws', 'ws_target'),
      turnId: testEntityId('tu', 'tu_target'),
      originRequestId: occurrence.requestId,
      originQueueEntryId: occurrence.queueEntryId,
      originTurnId: occurrence.turnId,
      snapshot: { threadId: testEntityId('th', 'th_target'), originActor: schedule.actor },
    });
    expect(
      exportRecurringPortableHistory(undefined, testEntityId('ws', 'ws_target'), JSON.stringify(imported), [])
    ).toEqual(imported);
    expect(() => remapRecurringPortableHistory(source, { ...maps, turnIds: new Map() })).toThrow(
      'Turn import mapping'
    );
    for (const table of [
      'recurring_schedules',
      'recurring_occurrences',
      'recurring_expired_ranges',
      'scheduler_admission_entries',
    ])
      expect(
        coreDb.sqlite
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`)
          .get(testEntityId('ws', 'ws_target'))
      ).toEqual({ n: 0 });
  });

  it('refuses a reserved accepted Turn without published canonical evidence', () => {
    acceptedHistory(false);
    expect(() =>
      exportRecurringPortableHistory(coreDb, workspace.id, null, retainedTurns())
    ).toThrow('requires inspection');
  });

  it('imports the three-file graph as reminted inert history through the real snapshot reader', () => {
    const { schedule, occurrence } = acceptedHistory();
    const turns = retainedTurns();
    const history = exportRecurringPortableHistory(coreDb, workspace.id, null, turns);
    const verified = writeWorkspaceExportTree({
      exportRoot: join(dataRoot, 'portable-export'),
      exportId: testEntityId('wsexp', 'wsexp_recurring'),
      sourceDeploymentId: testEntityId('dep', 'dep_source'),
      createdAt: instant,
      workspace: files.getWorkspace(workspace.id),
      threads: [files.getThread(workspace.id, thread.id)],
      turns,
      itemRevisions: turns.flatMap((turn) => turn.items),
      artifacts: [],
      artifactReviews: [],
      threadMaterialBindings: [],
      workspaceMaterialRevisions: [],
      workspaceMaterials: [],
      agentSessions: [],
      turnEvents: turns.map((turn) => [turn.id, []]),
      knowledge: [],
      recurringHistory: history,
      auditEvents: listSqliteAuditEvents(coreDb.sqlite, workspace.id, true),
      portableFileState: readWorkspacePortableFileState(
        join(dataRoot, 'workspaces', workspace.id),
        {
          workspaceId: workspace.id,
          threads: [{ threadId: thread.id }],
          turns: turns.map((turn) => ({ threadId: turn.threadId, turnId: turn.id })),
        }
      ),
    });
    const imported = readWorkspaceImportSnapshot({
      verified,
      targetWorkspaceId: testEntityId('ws', 'ws_imported_recurring'),
    });
    const graph = JSON.parse(imported.portableFileState.recurringHistory!);
    expect(graph.schedules).toEqual([
      expect.objectContaining({
        id: expect.not.stringMatching(schedule.id),
        originScheduleId: schedule.id,
        workspaceId: testEntityId('ws', 'ws_imported_recurring'),
        originActor: schedule.actor,
        status: 'active',
      }),
    ]);
    expect(imported.turns).toHaveLength(1);
    expect(imported.turns[0]!.id).not.toBe(occurrence.turnId);
    expect(graph.occurrences).toEqual([
      expect.objectContaining({
        id: expect.not.stringMatching(occurrence.id),
        scheduleId: graph.schedules[0].id,
        originRequestId: occurrence.requestId,
        originQueueEntryId: occurrence.queueEntryId,
        originTurnId: occurrence.turnId,
        turnId: imported.turns[0]!.id,
        snapshot: expect.objectContaining({ threadId: imported.threads[0]!.id }),
      }),
    ]);
    expect(
      imported.auditEvents.find((event) => event.action === 'recurring.occurrence.terminal')
    ).toMatchObject({
      resource: graph.occurrences[0].id,
      actor: schedule.actor,
      requestId: occurrence.requestId,
      threadId: imported.threads[0]!.id,
      turnId: null,
      workspaceId: testEntityId('ws', 'ws_imported_recurring'),
    });
    expect(
      imported.auditEvents
        .filter((event) => event.action.startsWith('recurring.schedule.'))
        .every((event) => event.resource === graph.schedules[0].id)
    ).toBe(true);
    for (const table of [
      'recurring_schedules',
      'recurring_occurrences',
      'recurring_expired_ranges',
      'scheduler_admission_entries',
    ])
      expect(
        coreDb.sqlite
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`)
          .get(testEntityId('ws', 'ws_imported_recurring'))
      ).toEqual({ n: 0 });
  });

  it('rejects duplicate tuples, contradictory range arithmetic, overlapping coverage and attempt violations', () => {
    acceptedHistory();
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

  it('rejects origin ownership, missing graph references and contradictory accepted attempts', () => {
    acceptedHistory();
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

  it('rejects different occurrences claiming the same retained Turn', () => {
    const first = acceptedHistory();
    const second = acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, workspace.id, null, [
      { id: first.occurrence.turnId!, threadId: thread.id },
      { id: second.occurrence.turnId!, threadId: thread.id },
    ]);
    graph.occurrences[1]!.turnId = graph.occurrences[0]!.turnId;
    expect(() => validateRecurringPortableHistory(JSON.stringify(graph))).toThrow(
      'share one retained Turn'
    );
  });

  it('rejects exact range coverage of an already materialized individual instant', () => {
    acceptedHistory();
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

  it('preserves exact monthly rules and compact ranges as inert portable history', () => {
    instant = '2026-01-01T00:00:00.000Z';
    const monthlyUtc = { zone: 'UTC', dayOfMonth: 28, hour: 9, minute: 30, second: 0 } as const;
    const schedule = store.createAutomation(localUserId, {
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Monthly',
      prompt: 'Monthly input',
      monthlyUtc,
    });
    store.updateAutomation(localUserId, schedule.id, {
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

  it('rejects unsupported required semantics and reads descriptive additions without exporting them', () => {
    acceptedHistory();
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
