import {
  AutomationIdSchema,
  readRetainedV1,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { ExternalTriggerCommandScopeSchema } from './command-request-codecs.js';
import {
  commandRequestKey,
  mapCommandRequestRow,
  writeCommandRequestRecordInDb,
} from './command-request-records.js';
import { commandInputHash } from './control-store-input.js';
import type { CoreDb } from './db.js';

/** Immutable event identity and lineage; the scheduler entry owns the accepted work. */
const ExternalTriggerAdmissionSchema = z.object({
  scheduleId: AutomationIdSchema,
  eventKey: z.string().min(1).max(1024),
  sourceTurnId: TurnIdSchema,
  queueEntryId: z.string().min(1),
});

/** Read projection of the original permanent Core command, not another receipt store. */
export type ExternalTriggerAdmission = z.infer<typeof ExternalTriggerAdmissionSchema>;

const EVENT_COMMAND = 'scheduler.external-trigger.admit' as const;
const SELECT_ADMISSION = `SELECT schema_version AS schemaVersion, request_key AS key,
  command_name AS command, request_id AS requestId, scope_json AS scopeJson,
  input_hash AS inputHash, response_kind AS responseKind, response_id AS responseId,
  response_json AS responseJson, created_at AS createdAt, expires_at AS expiresAt
  FROM idempotency_requests WHERE command_name = '${EVENT_COMMAND}'`;

/** Reads one retained event without changing its original poll or accepted work. */
export function findExternalTriggerAdmission(
  coreDb: CoreDb,
  scheduleId: string,
  eventKey: string
): ExternalTriggerAdmission | null {
  AutomationIdSchema.parse(scheduleId);
  ExternalTriggerAdmissionSchema.shape.eventKey.parse(eventKey);
  const row = coreDb.sqlite
    .prepare(
      `${SELECT_ADMISSION} AND json_extract(scope_json,'$.scheduleId') = ? AND json_extract(scope_json,'$.eventKey') = ?`
    )
    .get(scheduleId, eventKey);
  return row ? readAdmission(coreDb, row) : null;
}

/** Resolves an event from the existing queue owner without creating history. */
export function findExternalTriggerAdmissionForQueue(
  coreDb: CoreDb,
  queueEntryId: string
): ExternalTriggerAdmission | null {
  const row = coreDb.sqlite.prepare(`${SELECT_ADMISSION} AND response_id = ?`).get(queueEntryId);
  return row ? readAdmission(coreDb, row) : null;
}

/** The original scheduler savepoint owns the event command and queue together. */
export function insertExternalTriggerAdmission(
  coreDb: CoreDb,
  value: ExternalTriggerAdmission
): ExternalTriggerAdmission {
  const record = ExternalTriggerAdmissionSchema.parse(value);
  if (coreDb.scope !== 'core' || !coreDb.sqlite.inTransaction)
    throw new Error('External event commands require the scheduler admission Core transaction.');
  const existing = findExternalTriggerAdmission(coreDb, record.scheduleId, record.eventKey);
  if (existing) return existing;
  checkLineage(coreDb, record);
  const scope = ExternalTriggerCommandScopeSchema.parse({
    coreId: 'server',
    scheduleId: record.scheduleId,
    eventKey: record.eventKey,
    sourceTurnId: record.sourceTurnId,
  });
  writeCommandRequestRecordInDb(coreDb, {
    command: EVENT_COMMAND,
    key: commandRequestKey(EVENT_COMMAND, record.eventKey, scope),
    requestId: record.eventKey,
    scope,
    inputHash: commandInputHash(record),
    response: { kind: 'scheduler_entry', id: record.queueEntryId },
    createdAt: requireSchedulerAdmissionEntry(coreDb, record.queueEntryId).enqueuedAt,
    expiresAt: null,
  });
  return record;
}

/** Lists inert event history through the original schedule's Workspace attribution. */
export function listWorkspaceExternalTriggerAdmissions(
  coreDb: CoreDb,
  workspaceId: string
): ExternalTriggerAdmission[] {
  WorkspaceIdSchema.parse(workspaceId);
  const rows = coreDb.sqlite
    .prepare(`${SELECT_ADMISSION} AND json_extract(scope_json,'$.scheduleId') IN
      (SELECT id FROM recurring_schedules WHERE workspace_id = ?)
      ORDER BY json_extract(scope_json,'$.scheduleId'), json_extract(scope_json,'$.eventKey')`)
    .all(workspaceId);
  return rows.map((row) => readAdmission(coreDb, row));
}

/** Recomputes the full stored key and binding before exposing any event projection. */
function readAdmission(coreDb: CoreDb, value: unknown): ExternalTriggerAdmission {
  const command = mapCommandRequestRow(value as Parameters<typeof mapCommandRequestRow>[0]);
  const scope = ExternalTriggerCommandScopeSchema.parse(command.scope);
  const record = ExternalTriggerAdmissionSchema.parse({
    ...scope,
    queueEntryId: command.response.id,
  });
  if (
    command.command !== EVENT_COMMAND ||
    command.expiresAt !== null ||
    command.requestId !== record.eventKey ||
    command.key !== commandRequestKey(EVENT_COMMAND, command.requestId, command.scope) ||
    command.inputHash !== commandInputHash(record) ||
    command.response.kind !== 'scheduler_entry' ||
    command.response.conversationMetadata !== undefined ||
    command.response.steerMetadata !== undefined
  )
    throw new Error('The retained external-event command binding conflicts.');
  return checkLineage(coreDb, record);
}

/** Refuses contradictory Core lineage; the runtime owner proves canonical source Turns. */
function checkLineage(coreDb: CoreDb, record: ExternalTriggerAdmission): ExternalTriggerAdmission {
  const schedule = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, workspace_id FROM recurring_schedules WHERE id = ?'
    )
    .get(record.scheduleId) as { schemaVersion: unknown; workspace_id: string } | undefined;
  if (!schedule) throw new Error('External event command has no retained RecurringSchedule.');
  readRetainedV1(schedule, () => undefined);
  const entry = requireSchedulerAdmissionEntry(coreDb, record.queueEntryId);
  if (entry.workspaceId !== schedule.workspace_id)
    throw new Error('External event command contradicts its scheduler Workspace lineage.');
  return record;
}
