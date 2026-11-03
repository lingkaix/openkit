import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import { deriveEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import {
  ExpiredOccurrenceRangeSchema,
  findAcceptedRecurringOccurrenceForQueue,
  readRecurringOccurrence,
  readRecurringSchedule,
  recurringRequestId,
} from './recurring-records.js';
import {
  ControlSchedulerAdmissionSchema,
  ControlSchedulerAdmissionWireSchema,
} from './scheduler-admission-codecs.js';

const monthlyUtc = { zone: 'UTC' as const, dayOfMonth: 28, hour: 9, minute: 0, second: 0 };
const actor = {
  kind: 'automation' as const,
  id: testEntityId('auto', 'schedule'),
  responsibleUserId: testEntityId('usr', 'creator'),
};
const range = {
  id: testEntityId('range', 'range'),
  scheduleId: testEntityId('auto', 'schedule'),
  workspaceId: testEntityId('ws', 'workspace'),
  definitionRevision: 2,
  monthlyUtc,
  firstScheduledAt: '2027-01-28T09:00:00.000Z',
  lastScheduledAt: '2027-03-28T09:00:00.000Z',
  count: 3,
  snapshot: { threadId: testEntityId('th', 'thread'), actor, prompt: 'Inspect status', monthlyUtc },
  reason: 'deadline_elapsed',
  createdAt: '2027-04-28T09:00:00.000Z',
  terminalAt: '2027-04-28T09:00:00.000Z',
};

describe('retained recurring timing core', () => {
  it('validates exact monthly bounds, count, actor and old-rule snapshot without expansion', () => {
    expect(ExpiredOccurrenceRangeSchema.parse(range)).toEqual(range);
    for (const patch of [
      { count: 4 },
      { lastScheduledAt: '2027-03-29T09:00:00.000Z' },
      { firstScheduledAt: '2027-04-28T09:00:00.000Z' },
      { snapshot: { ...range.snapshot, monthlyUtc: { ...monthlyUtc, hour: 10 } } },
      { snapshot: { ...range.snapshot, monthlyUtc: undefined } },
      {
        snapshot: { ...range.snapshot, actor: { ...actor, id: testEntityId('auto', 'different') } },
      },
      { intervalSeconds: 5 },
      { requiredFeatures: ['unknown-monthly-semantics'] },
    ])
      expect(ExpiredOccurrenceRangeSchema.safeParse({ ...range, ...patch }).success).toBe(false);
  });

  it('keeps fixed ranges readable and refuses inaccurate fixed-duration coverage', () => {
    const { monthlyUtc: _rule, ...fixedRange } = range;
    const { monthlyUtc: _snapshotRule, ...snapshot } = range.snapshot;
    const fixed = {
      ...fixedRange,
      snapshot,
      intervalSeconds: 5,
      lastScheduledAt: '2027-01-28T09:00:10.000Z',
    };
    expect(ExpiredOccurrenceRangeSchema.parse(fixed)).toEqual(fixed);
    expect(ExpiredOccurrenceRangeSchema.safeParse({ ...fixed, count: 2 }).success).toBe(false);
  });

  it('refuses a monthly cursor that does not match the retained rule while tolerating annotations', () => {
    const schedule = {
      id: actor.id,
      workspaceId: testEntityId('ws', 'workspace'),
      name: 'Monthly',
      threadId: testEntityId('th', 'thread'),
      monthlyUtc,
      responsibleUserId: actor.responsibleUserId,
      actor,
      status: 'active',
      revision: 2,
      nextScheduledAt: '2027-04-28T09:00:00.000Z',
      greatestAccountedScheduledAt: range.lastScheduledAt,
      prompt: 'Inspect status',
      createdAt: range.createdAt,
      updatedAt: range.createdAt,
      deletedAt: null,
    };
    expect(
      readRecurringSchedule(JSON.stringify({ ...schedule, annotation: 'Descriptive only' }))
    ).toEqual(schedule);
    expect(() =>
      readRecurringSchedule(
        JSON.stringify({ ...schedule, nextScheduledAt: '2027-04-29T09:00:00.000Z' })
      )
    ).toThrow();
    expect(() =>
      readRecurringSchedule(
        JSON.stringify({ ...schedule, monthlyUtc: { ...monthlyUtc, zone: 'unknown' } })
      )
    ).toThrow();
    expect(() =>
      readRecurringSchedule(JSON.stringify({ ...schedule, requiredFeatures: ['future-cadence'] }))
    ).toThrow();
  });
});

const fixedSchedule = {
  id: actor.id,
  workspaceId: range.workspaceId,
  name: 'Every five seconds',
  threadId: range.snapshot.threadId,
  intervalSeconds: 5,
  prompt: 'Inspect status',
  agentId: 'agent_worker',
  profileId: 'profile_default',
  modelId: 'model_default',
  responsibleUserId: actor.responsibleUserId,
  actor,
  status: 'active',
  revision: 2,
  nextScheduledAt: '2027-05-28T09:00:05.000Z',
  greatestAccountedScheduledAt: '2027-05-28T09:00:00.000Z',
  createdAt: '2027-05-28T09:00:00.000Z',
  updatedAt: '2027-05-28T09:00:00.000Z',
  deletedAt: null,
};

const acceptedScheduledAt = '2027-05-28T09:00:00.000Z';
const acceptedRequestId = recurringRequestId(actor.id, acceptedScheduledAt);
const acceptedTurnId = deriveEntityId('tu', ['recurring', actor.id, acceptedScheduledAt]);
const acceptedRoots: MaterializedWorkspaceRoot[] = [
  {
    id: 'root',
    sourceKind: 'materialized-dir',
    sourcePath: '/tmp/workspace',
    workerPath: '/tmp/workspace',
    access: 'read-only',
  },
];
const acceptedOccurrence = {
  id: deriveEntityId('occ', [actor.id, acceptedScheduledAt]),
  scheduleId: actor.id,
  workspaceId: range.workspaceId,
  definitionRevision: 2,
  scheduledAt: acceptedScheduledAt,
  deadline: '2027-05-28T09:10:00.000Z',
  snapshot: {
    threadId: range.snapshot.threadId,
    actor,
    prompt: 'Inspect status',
    agentId: 'agent_worker',
    profileId: 'profile_default',
    modelId: 'model_default',
    monthlyUtc,
  },
  state: 'admission-accepted',
  attempts: [
    {
      number: 1,
      at: '2027-05-28T09:00:01.000Z',
      code: 'preparation_failed',
      summary: 'First attempt failed before admission.',
    },
    {
      number: 2,
      at: '2027-05-28T09:00:02.000Z',
      code: 'accepted',
      summary: 'Admission accepted.',
    },
  ],
  requestId: acceptedRequestId,
  queueEntryId: acceptedRequestId,
  turnId: acceptedTurnId,
  createdAt: '2027-05-28T09:00:00.000Z',
  terminalAt: null,
  resolvedPayload: {
    backendId: 'nanohost',
    requestedAgentId: 'agent_worker',
    profileRef: 'profile_default',
    modelId: 'model_default',
    workspaceCwd: '/tmp/workspace',
    workspaceRoots: acceptedRoots,
  },
};

describe('retained recurring record readers', () => {
  it('round-trips a complete fixed-interval schedule with its exact authored identity', () => {
    expect(readRecurringSchedule(JSON.stringify(fixedSchedule))).toEqual(fixedSchedule);
    expect(() =>
      readRecurringSchedule(
        JSON.stringify({
          ...fixedSchedule,
          actor: { ...actor, id: 'auto_0190a1b2-0000-7000-8000-000000000099' },
        })
      )
    ).toThrow('contradictory automation identity');
    expect(() =>
      readRecurringSchedule(
        JSON.stringify({ ...fixedSchedule, requiredFeatures: ['future-cadence'] })
      )
    ).toThrow();
  });

  it('round-trips a complete accepted occurrence with exact request identity, deadline and attempt order', () => {
    expect(readRecurringOccurrence(JSON.stringify(acceptedOccurrence))).toEqual(acceptedOccurrence);
    expect(recurringRequestId(acceptedOccurrence.scheduleId, acceptedOccurrence.scheduledAt)).toBe(
      acceptedOccurrence.requestId
    );
    expect(acceptedOccurrence.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
  });

  it('refuses occurrence request identity, deadline, snapshot and attempt-order contradictions', () => {
    for (const patch of [
      { requestId: '11111111-2222-4333-8444-555555555555' },
      { deadline: '2027-05-28T09:10:00.001Z' },
      { id: deriveEntityId('occ', [actor.id, '2027-06-28T09:00:00.000Z']) },
      { attempts: [acceptedOccurrence.attempts[1]] },
      {
        snapshot: {
          ...acceptedOccurrence.snapshot,
          actor: { ...actor, id: 'auto_0190a1b2-0000-7000-8000-000000000099' },
        },
      },
    ])
      expect(() =>
        readRecurringOccurrence(JSON.stringify({ ...acceptedOccurrence, ...patch }))
      ).toThrow('durable identity or attempt contract');
    expect(() =>
      readRecurringOccurrence(
        JSON.stringify({ ...acceptedOccurrence, requiredFeatures: ['future-cadence'] })
      )
    ).toThrow();
  });

  it('reads an accepted occurrence only through its exact scheduler admission', () => {
    const root = mkdtempSync(join(tmpdir(), 'recurring-records-'));
    const db = createTestCoreDb(root);
    try {
      db.sqlite
        .prepare(`INSERT INTO recurring_schedules
          (id, workspace_id, responsible_user_id, status, revision, next_scheduled_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          acceptedOccurrence.scheduleId,
          acceptedOccurrence.workspaceId,
          actor.responsibleUserId,
          'active',
          acceptedOccurrence.definitionRevision,
          Date.parse(acceptedScheduledAt),
          '{}'
        );
      db.sqlite
        .prepare(`INSERT INTO recurring_occurrences
          (id, schedule_id, workspace_id, scheduled_at, deadline, state, queue_entry_id, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          acceptedOccurrence.id,
          acceptedOccurrence.scheduleId,
          acceptedOccurrence.workspaceId,
          Date.parse(acceptedOccurrence.scheduledAt),
          Date.parse(acceptedOccurrence.deadline),
          acceptedOccurrence.state,
          acceptedOccurrence.queueEntryId,
          JSON.stringify(acceptedOccurrence)
        );
      createSchedulerAdmissionEntry(db, {
        backendId: acceptedOccurrence.resolvedPayload.backendId,
        queueEntryId: acceptedOccurrence.requestId,
        requestId: acceptedOccurrence.requestId,
        triggerActor: actor,
        workspaceId: acceptedOccurrence.workspaceId,
        threadId: acceptedOccurrence.snapshot.threadId,
        turnId: acceptedOccurrence.turnId,
        turnInput: acceptedOccurrence.snapshot.prompt,
        requestedAgentId: acceptedOccurrence.resolvedPayload.requestedAgentId,
        profileRef: acceptedOccurrence.resolvedPayload.profileRef,
        modelId: acceptedOccurrence.resolvedPayload.modelId,
        workspaceCwd: acceptedOccurrence.resolvedPayload.workspaceCwd,
        workspaceRoots: acceptedRoots,
        now: () => acceptedOccurrence.createdAt,
      });

      expect(findAcceptedRecurringOccurrenceForQueue(db, acceptedOccurrence.requestId)).toEqual(
        acceptedOccurrence
      );
      expect(findAcceptedRecurringOccurrenceForQueue(db, 'queue-entry-not-retained')).toBeNull();

      db.sqlite
        .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE queue_entry_id = ?')
        .run('Changed request bytes', acceptedOccurrence.requestId);
      expect(() =>
        findAcceptedRecurringOccurrenceForQueue(db, acceptedOccurrence.requestId)
      ).toThrow('contradicts its scheduler admission');
    } finally {
      closeTestCoreDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scheduler admission wire decoding', () => {
  const createAutomation = {
    workspaceId: acceptedOccurrence.workspaceId,
    name: 'Monthly',
    threadId: acceptedOccurrence.snapshot.threadId,
    monthlyUtc,
    prompt: 'Inspect status',
  };
  const schedulerEntry = {
    backendId: 'nanohost',
    queueEntryId: 'queue-wire-1',
    requestId: 'request-wire-1',
    triggerActor: { kind: 'user' as const, id: actor.responsibleUserId },
    serverAdminTokenId: null,
    workspaceCwd: '/tmp/workspace',
    workspaceRoots: acceptedRoots,
    workerStorageChoice: { kind: 'fresh' as const, goalId: null, taskId: null },
    workspaceId: acceptedOccurrence.workspaceId,
    threadId: acceptedOccurrence.snapshot.threadId,
    turnId: acceptedTurnId,
    turnInput: 'Inspect status',
    requestedAgentId: 'agent_worker',
    profileRef: 'profile_default',
    modelId: 'model_default',
    reasoningEffort: 'high' as const,
    timestamp: acceptedScheduledAt,
  };

  it('accepts every admitted definition mutation and queue entry variant', () => {
    for (const value of [
      {
        mode: 'definition',
        workspaceId: acceptedOccurrence.workspaceId,
        userId: actor.responsibleUserId,
        mutation: { action: 'create', id: actor.id, input: createAutomation },
        timestamp: acceptedScheduledAt,
      },
      {
        mode: 'definition',
        workspaceId: acceptedOccurrence.workspaceId,
        userId: actor.responsibleUserId,
        mutation: {
          action: 'update',
          id: actor.id,
          input: { expectedRevision: 2, status: 'paused' },
        },
        timestamp: acceptedScheduledAt,
      },
      {
        mode: 'definition',
        workspaceId: acceptedOccurrence.workspaceId,
        userId: actor.responsibleUserId,
        mutation: { action: 'delete', id: actor.id },
        timestamp: acceptedScheduledAt,
      },
      { mode: 'create', entry: schedulerEntry },
      { mode: 'deny', queueEntryId: schedulerEntry.queueEntryId, denialReason: 'invalid-request' },
      {
        mode: 'recurring-attempt',
        occurrenceId: acceptedOccurrence.id,
        definitionRevision: 2,
        preparation: { kind: 'recovery_required' },
        timestamp: acceptedScheduledAt,
      },
    ])
      expect(ControlSchedulerAdmissionSchema.safeParse(value).success).toBe(true);
    expect(
      ControlSchedulerAdmissionWireSchema.safeParse({
        byteLength: Buffer.byteLength(JSON.stringify(acceptedOccurrence)),
        turnId: acceptedTurnId,
      }).success
    ).toBe(true);
  });

  it('refuses an unknown discriminant and missing required admission fields', () => {
    const definition = {
      mode: 'definition',
      workspaceId: acceptedOccurrence.workspaceId,
      userId: actor.responsibleUserId,
      mutation: { action: 'create', id: actor.id, input: createAutomation },
      timestamp: acceptedScheduledAt,
    };
    for (const value of [
      { ...definition, mode: 'unknown' },
      { ...definition, mutation: { ...definition.mutation, action: 'archive' } },
      { ...definition, mutation: { action: 'create', id: actor.id } },
      { mode: 'create', entry: { ...schedulerEntry, turnId: undefined } },
      { mode: 'create', entry: { ...schedulerEntry, extra: 'not admitted' } },
      {
        mode: 'recurring-attempt',
        occurrenceId: acceptedOccurrence.id,
        definitionRevision: 2,
        preparation: { kind: 'unknown' },
        timestamp: acceptedScheduledAt,
      },
    ])
      expect(ControlSchedulerAdmissionSchema.safeParse(value).success).toBe(false);
    for (const value of [
      { byteLength: 0, turnId: acceptedTurnId },
      { byteLength: 42 },
      { byteLength: 42, turnId: null, extra: 'not admitted' },
    ])
      expect(ControlSchedulerAdmissionWireSchema.safeParse(value).success).toBe(false);
  });
});
