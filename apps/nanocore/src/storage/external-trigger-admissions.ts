import { AutomationIdSchema, TurnIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb } from './db.js';

/** Immutable event identity and lineage; the scheduler entry owns the accepted work. */
const ExternalTriggerAdmissionSchema = z.object({
  scheduleId: AutomationIdSchema,
  eventKey: z.string().min(1).max(1024),
  sourceTurnId: TurnIdSchema,
  queueEntryId: z.string().min(1),
});

/** Retained join between a scheduled poll's source event and its ordinary Worker admission. */
export type ExternalTriggerAdmission = z.infer<typeof ExternalTriggerAdmissionSchema>;

const SELECT_ADMISSION = `SELECT schedule_id AS scheduleId, event_key AS eventKey,
  source_turn_id AS sourceTurnId, queue_entry_id AS queueEntryId
  FROM external_trigger_admissions`;

/** Reads one retained event without changing its original poll or accepted work. */
export function findExternalTriggerAdmission(
  coreDb: CoreDb,
  scheduleId: string,
  eventKey: string
): ExternalTriggerAdmission | null {
  AutomationIdSchema.parse(scheduleId);
  ExternalTriggerAdmissionSchema.shape.eventKey.parse(eventKey);
  const row = coreDb.sqlite
    .prepare(`${SELECT_ADMISSION} WHERE schedule_id = ? AND event_key = ?`)
    .get(scheduleId, eventKey);
  return row ? readAdmission(coreDb, row) : null;
}

/** Inserts within the queue owner's Core transaction; duplicate keys retain their original lineage. */
export function insertExternalTriggerAdmission(
  coreDb: CoreDb,
  value: ExternalTriggerAdmission
): ExternalTriggerAdmission {
  const record = ExternalTriggerAdmissionSchema.parse(value);
  if (!coreDb.sqlite.inTransaction)
    throw new Error('ExternalTriggerAdmission requires the scheduler admission Core transaction.');
  const existing = findExternalTriggerAdmission(coreDb, record.scheduleId, record.eventKey);
  if (existing) return existing;
  readAdmission(coreDb, record);
  coreDb.sqlite
    .prepare(`INSERT INTO external_trigger_admissions
    (schedule_id, event_key, source_turn_id, queue_entry_id) VALUES (?, ?, ?, ?)`)
    .run(record.scheduleId, record.eventKey, record.sourceTurnId, record.queueEntryId);
  return record;
}

/** Lists inert event history through the owning schedule's Workspace attribution. */
export function listWorkspaceExternalTriggerAdmissions(
  coreDb: CoreDb,
  workspaceId: string
): ExternalTriggerAdmission[] {
  WorkspaceIdSchema.parse(workspaceId);
  const rows = coreDb.sqlite
    .prepare(`SELECT event.schedule_id AS scheduleId, event.event_key AS eventKey,
    event.source_turn_id AS sourceTurnId, event.queue_entry_id AS queueEntryId
    FROM external_trigger_admissions event
    INNER JOIN recurring_schedules schedule ON schedule.id = event.schedule_id
    WHERE schedule.workspace_id = ? ORDER BY event.schedule_id, event.event_key`)
    .all(workspaceId);
  return rows.map((row) => readAdmission(coreDb, row));
}

/** Refuses missing or contradictory Core lineage; the runtime owner proves canonical source Turns. */
function readAdmission(coreDb: CoreDb, value: unknown): ExternalTriggerAdmission {
  const record = ExternalTriggerAdmissionSchema.parse(value);
  const schedule = coreDb.sqlite
    .prepare('SELECT workspace_id FROM recurring_schedules WHERE id = ?')
    .get(record.scheduleId) as { workspace_id: string } | undefined;
  if (!schedule) throw new Error('ExternalTriggerAdmission has no retained RecurringSchedule.');
  const entry = requireSchedulerAdmissionEntry(coreDb, record.queueEntryId);
  if (entry.workspaceId !== schedule.workspace_id)
    throw new Error('ExternalTriggerAdmission contradicts its scheduler Workspace lineage.');
  return record;
}
