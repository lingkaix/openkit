import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { type CoreDb, openCoreDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import {
  exportRecurringPortableHistory,
  RECURRING_PORTABLE_CORE_TABLES,
  remapRecurringPortableHistory,
  validateRecurringPortableHistory,
} from './recurring-portable-history.js';

describe('recurring portable history', () => {
  let dataRoot: string;
  let coreDb: CoreDb;
  let store: AutomationStore;
  let instant: string;
  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'recurrence-portable-'));
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    instant = '2026-10-16T00:00:00.000Z';
    store = new AutomationStore(coreDb, new WorkspaceMutationAdmission(), () => instant);
  });
  afterEach(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  function acceptedHistory() {
    const schedule = store.createAutomation(LOCAL_USER_ID, {
      workspaceId: 'ws_source',
      threadId: 'th_source',
      name: 'Inspect',
      prompt: 'Retained exact input',
      intervalSeconds: 5,
    });
    store.updateAutomation(LOCAL_USER_ID, schedule.id, {
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
      },
    });
    return { schedule, occurrence: store.getOccurrence(occurrence.id) };
  }

  it('explicitly accounts for every recurring Core history table', () => {
    const names = coreDb.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'recurring_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual([...RECURRING_PORTABLE_CORE_TABLES].sort());
  });

  it('exports a whitelist graph and labels an unpublished reserved Turn as origin only', () => {
    const { schedule, occurrence } = acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, 'ws_source', null, []);
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
        turnId: null,
        turnExists: false,
        resolvedSelection: {
          agentId: 'historical-worker',
          profileId: 'historical-profile',
          modelId: 'historical-model',
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
    const graph = exportRecurringPortableHistory(coreDb, 'ws_source', null, [
      { id: occurrence.turnId!, threadId: 'th_source' },
    ]);
    expect(graph.occurrences[0]).toMatchObject({ turnId: occurrence.turnId, turnExists: true });
    expect(() =>
      exportRecurringPortableHistory(coreDb, 'ws_source', null, [
        { id: occurrence.turnId!, threadId: 'th_other' },
      ])
    ).toThrow();
  });

  it('rewrites only admitted import-map identities and keeps source authority inert across repeated transfer', () => {
    const { schedule, occurrence } = acceptedHistory();
    const source = exportRecurringPortableHistory(coreDb, 'ws_source', null, [
      { id: occurrence.turnId!, threadId: 'th_source' },
    ]);
    const maps = {
      workspaceId: 'ws_target',
      scheduleIds: new Map([[schedule.id, 'auto_target']]),
      occurrenceIds: new Map([[occurrence.id, 'occ_target']]),
      rangeIds: new Map<string, string>(),
      threadIds: new Map([['th_source', 'th_target']]),
      turnIds: new Map([[occurrence.turnId!, 'tu_target']]),
    };
    const imported = remapRecurringPortableHistory(source, maps);
    expect(imported.schedules[0]).toMatchObject({
      id: 'auto_target',
      workspaceId: 'ws_target',
      threadId: 'th_target',
      originScheduleId: schedule.id,
      originActor: schedule.actor,
      status: 'active',
    });
    expect(imported.occurrences[0]).toMatchObject({
      id: 'occ_target',
      scheduleId: 'auto_target',
      workspaceId: 'ws_target',
      turnId: 'tu_target',
      originRequestId: occurrence.requestId,
      originQueueEntryId: occurrence.queueEntryId,
      originTurnId: occurrence.turnId,
      snapshot: { threadId: 'th_target', originActor: schedule.actor },
    });
    expect(
      exportRecurringPortableHistory(undefined, 'ws_target', JSON.stringify(imported), [])
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
          .get('ws_target')
      ).toEqual({ n: 0 });
  });

  it('rejects duplicate tuples, contradictory range arithmetic, overlapping coverage and attempt violations', () => {
    acceptedHistory();
    instant = '2026-10-16T02:00:00.000Z';
    store.collectScanCandidates(instant);
    const graph = exportRecurringPortableHistory(coreDb, 'ws_source', null, []);
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

  it('rejects unsupported required semantics and reads descriptive additions without exporting them', () => {
    acceptedHistory();
    const graph = exportRecurringPortableHistory(coreDb, 'ws_source', null, []);
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
    const exported = exportRecurringPortableHistory(undefined, 'ws_source', inherited, []);
    expect(exported).toEqual(graph);
  });
});
