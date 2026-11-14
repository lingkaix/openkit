import { randomUUID } from 'node:crypto';
import { readRetainedV1, TimestampSchema, UserIdSchema, writeRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';
import { auditEventFromRow } from '../audit-events.js';
import { evaluateOpenKitAccessTokenUsability } from '../auth/access-token.js';
import {
  getOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { getLocalUserId } from '../auth/identity.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { type SecurityItemKey, securityRequestId } from '../security/identifiers.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { CoreDb } from './db.js';
import {
  type ControlSecurityTrigger,
  type ControlSecurityTriggerResult,
  type SecurityAlarmRow,
  SecurityAlarmRowSchema,
  SecurityTriggerRefusal,
  type SecurityTriggerSnapshot,
} from './security-trigger-codecs.js';

const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(['off', 'on', 'stopping']),
    generation: Counter,
    enabler: UserIdSchema.nullable(),
    alarmCount: Counter.max(2),
  })
  .strict();
type State = z.infer<typeof StateSchema>;
const AlarmSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .uuid()
      .refine((id) => id[14] === '7'),
    generation: Counter.positive(),
    rule: z.enum(['R1', 'R8']),
    recipientCount: Counter,
    failure: z.literal('no-current-administrator').nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
type Alarm = z.infer<typeof AlarmSchema>;
type View = { state: State; alarms: Alarm[] };
type Row = Record<string, unknown>;

function retained<T>(row: unknown, decode: (row: Row) => T): T {
  try {
    return readRetainedV1(row as Row, () => decode(row as Row));
  } catch (error) {
    if (error instanceof SecurityTriggerRefusal) throw error;
    throw new SecurityTriggerRefusal('unsupported_retained_format');
  }
}
function recovery(): never {
  throw new SecurityTriggerRefusal('recovery_required');
}
const alarmColumns = `schema_version AS schemaVersion,id,enable_generation AS generation,
  rule,recipient_count AS recipientCount,failure,created_at AS createdAt`;

function readAlarm(db: CoreDb, row: unknown): Alarm {
  const alarm = retained(row, (value) => AlarmSchema.parse(value));
  if ((alarm.recipientCount === 0) !== (alarm.failure === 'no-current-administrator'))
    throw new SecurityTriggerRefusal('unsupported_retained_format');
  const count = db.sqlite
    .prepare(`SELECT COUNT(*) AS total,COUNT(DISTINCT recipient_user_id) AS recipients
    FROM security_trigger_outbox WHERE alarm_id=? AND occurrence_kind='initial' AND occurrence_n=1`)
    .get(alarm.id) as { total: number; recipients: number };
  if (count.total !== alarm.recipientCount || count.recipients !== alarm.recipientCount) recovery();
  return alarm;
}

/** Reads original tuples only. Absence/count mismatch is never repaired by a read or retry. */
function readState(db: CoreDb): View {
  const raw = db.sqlite
    .prepare(`SELECT schema_version AS schemaVersion,state,
    enable_generation AS generation,enabling_user_id AS enabler,expected_alarm_count AS alarmCount
    FROM security_trigger_state WHERE singleton=1`)
    .get();
  if (!raw) recovery();
  const state = retained(raw, (value) => StateSchema.parse(value));
  if (
    (state.state !== 'off' && (!state.enabler || state.generation === 0)) ||
    (state.generation === 0 && (state.enabler !== null || state.alarmCount !== 0)) ||
    (state.state === 'on' && state.alarmCount !== 0) ||
    (state.state === 'stopping' && state.alarmCount === 0)
  )
    recovery();
  const alarms = db.sqlite
    .prepare(`SELECT ${alarmColumns} FROM security_trigger_alarms
    WHERE enable_generation=? ORDER BY rule`)
    .all(state.generation)
    .map((row) => readAlarm(db, row));
  if (
    alarms.length !== state.alarmCount ||
    new Set(alarms.map((a) => a.rule)).size !== alarms.length
  )
    recovery();
  return { state, alarms };
}

/** Current eligibility reuses canonical Identity and owned usable administrator-Token owners. */
function administrator(db: CoreDb, userId: string, now: Date): boolean {
  if (!isCanonicalUserActive(db, userId)) return false;
  const user = db.sqlite.prepare('SELECT kind FROM users WHERE id=?').get(userId) as {
    kind: string;
  };
  if (user.kind === 'local') return getLocalUserId(db) === userId;
  if (user.kind !== 'human') throw new SecurityTriggerRefusal('unsupported_retained_format');
  return resolveSessionDeploymentAdminTokenId(db, userId, now) !== null;
}
function assertActor(
  db: CoreDb,
  actor: Extract<ControlSecurityTrigger, { action: 'enable' | 'stop' }>['actor'],
  now: Date
): void {
  let admitted = false;
  if (isCanonicalUserActive(db, actor.userId)) {
    const user = db.sqlite.prepare('SELECT kind FROM users WHERE id=?').get(actor.userId) as {
      kind: string;
    };
    if (user.kind !== 'local' && user.kind !== 'human')
      throw new SecurityTriggerRefusal('unsupported_retained_format');
    if (actor.kind === 'local') {
      admitted = user.kind === 'local' && getLocalUserId(db) === actor.userId;
    } else if (actor.kind === 'token' && actor.tokenId && actor.tokenScope === 'server-admin') {
      const token = getOpenKitAccessTokenRecord(db, actor.tokenId);
      admitted = Boolean(
        token &&
          token.ownerUserId === actor.userId &&
          token.scope === 'server-admin' &&
          token.workspaceIds.length === 0 &&
          !actor.tokenWorkspaceIds?.length &&
          evaluateOpenKitAccessTokenUsability(token, now).usable
      );
    } else if (actor.kind === 'session' && actor.sessionId) {
      const session = db.sqlite
        .prepare('SELECT user_id AS userId,expires_at AS expiresAt FROM session WHERE id=?')
        .get(actor.sessionId) as { userId: string; expiresAt: number } | undefined;
      const selected = resolveSessionDeploymentAdminTokenId(db, actor.userId, now);
      admitted = Boolean(
        session &&
          session.userId === actor.userId &&
          session.expiresAt > now.getTime() &&
          selected &&
          (!actor.adminTokenId || actor.adminTokenId === selected)
      );
    }
  }
  if (!admitted) throw new SecurityTriggerRefusal('forbidden');
}

/** Native runtime id, not a borrowed Protocol entity kind. Independent allocations stay UUIDv7. */
function newAlarmRunId(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
}
function keyFor(alarm: Alarm): SecurityItemKey {
  return [
    'gap',
    alarm.generation,
    alarm.rule === 'R1' ? 'monitoring-off' : 'lost-authority',
    alarm.id,
  ];
}

/** Original alarm, all original recipient rows and stopping state share the existing savepoint. */
function insertAlarm(
  db: CoreDb,
  view: View,
  rule: 'R1' | 'R8',
  timestamp: string,
  now: Date
): View {
  if (view.alarms.some((a) => a.rule === rule)) return view;
  if (view.state.state === 'off') throw new ControlProductPreconditionError();
  const recipients = (
    db.sqlite.prepare("SELECT id FROM users WHERE status='active' ORDER BY id").all() as {
      id: string;
    }[]
  )
    .filter(({ id }) => administrator(db, id, now))
    .map(({ id }) => id);
  const alarm: Alarm = {
    schemaVersion: writeRetainedV1({}).schemaVersion,
    id: newAlarmRunId(),
    generation: view.state.generation,
    rule,
    recipientCount: recipients.length,
    failure: recipients.length ? null : 'no-current-administrator',
    createdAt: timestamp,
  };
  db.sqlite
    .prepare(`INSERT INTO security_trigger_alarms
    (id,schema_version,enable_generation,rule,recipient_count,failure,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(
      alarm.id,
      alarm.schemaVersion,
      alarm.generation,
      alarm.rule,
      alarm.recipientCount,
      alarm.failure,
      alarm.createdAt
    );
  const key = keyFor(alarm);
  for (const recipientUserId of recipients) {
    const occurrence = { kind: 'initial' as const, n: 1 };
    const requestId = securityRequestId({ key, recipientUserId, occurrence });
    db.sqlite
      .prepare(`INSERT INTO security_trigger_outbox
      (request_id,schema_version,alarm_id,key_json,recipient_user_id,occurrence_kind,occurrence_n,raised,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`)
      .run(
        requestId,
        writeRetainedV1({}).schemaVersion,
        alarm.id,
        JSON.stringify(key),
        recipientUserId,
        occurrence.kind,
        occurrence.n,
        timestamp
      );
  }
  const changed = db.sqlite
    .prepare(`UPDATE security_trigger_state SET state='stopping',expected_alarm_count=expected_alarm_count+1
    WHERE singleton=1 AND enable_generation=? AND expected_alarm_count=? AND state IN ('on','stopping')`)
    .run(view.state.generation, view.state.alarmCount);
  if (changed.changes !== 1) throw new ControlProductPreconditionError();
  return readState(db);
}

function checkCurrent(db: CoreDb, timestamp: string, now: Date): View {
  let view = readState(db);
  if (
    view.state.state !== 'off' &&
    !view.alarms.some((a) => a.rule === 'R8') &&
    !administrator(db, view.state.enabler!, now)
  )
    view = insertAlarm(db, view, 'R8', timestamp, now);
  return view;
}
function snapshot(db: CoreDb, view: View, now: Date): SecurityTriggerSnapshot {
  const lost = view.alarms.some((a) => a.rule === 'R8');
  return {
    state: view.state.state,
    enableGeneration: view.state.generation,
    enablingUserId: view.state.enabler,
    delegationCurrent:
      view.state.state !== 'off' && !lost && administrator(db, view.state.enabler!, now),
    stoppingReason:
      view.state.state === 'stopping' ? (lost ? 'lost-authority' : 'monitoring-off') : null,
    failedOutcome: view.alarms.find((a) => a.failure)?.failure ?? null,
  };
}

function readAlarmRows(db: CoreDb): SecurityAlarmRow[] {
  readState(db);
  const rows = db.sqlite
    .prepare(`SELECT schema_version AS schemaVersion,request_id AS requestId,
    alarm_id AS alarmId,key_json AS keyJson,recipient_user_id AS recipientUserId,
    occurrence_kind AS occurrenceKind,occurrence_n AS occurrenceN,raised
    FROM security_trigger_outbox WHERE alarm_id IS NOT NULL AND raised=0 ORDER BY created_at,request_id LIMIT 128`)
    .all() as Row[];
  const originals = new Map<string, Alarm>();
  return rows.map((raw) =>
    retained(raw, (row) => {
      if (
        typeof row.alarmId !== 'string' ||
        typeof row.keyJson !== 'string' ||
        ![0, 1].includes(row.raised as number)
      )
        throw new TypeError('Invalid alarm row.');
      let alarm = originals.get(row.alarmId);
      if (!alarm) {
        const original = db.sqlite
          .prepare(`SELECT ${alarmColumns} FROM security_trigger_alarms WHERE id=?`)
          .get(row.alarmId);
        if (!original) recovery();
        alarm = readAlarm(db, original);
        originals.set(alarm.id, alarm);
      }
      const value = SecurityAlarmRowSchema.parse({
        requestId: row.requestId,
        recipientUserId: row.recipientUserId,
        rule: alarm.rule,
        key: JSON.parse(row.keyJson),
        occurrence: { kind: row.occurrenceKind, n: row.occurrenceN },
        raised: row.raised === 1,
      });
      if (
        JSON.stringify(value.key) !== JSON.stringify(keyFor(alarm)) ||
        securityRequestId({
          key: value.key,
          recipientUserId: value.recipientUserId,
          occurrence: value.occurrence,
        }) !== value.requestId
      )
        recovery();
      return value;
    })
  );
}

/** Executes only inside the existing Core control worker's product savepoint and covering FULL ACK. */
export function applySecurityTriggerInDb(
  db: CoreDb,
  input: ControlSecurityTrigger
): ControlSecurityTriggerResult {
  if (db.scope !== 'core' || !db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  // Caller timestamps describe the original observation; they never move credential expiry backwards.
  const now = new Date();
  if (input.action === 'alarms') return { kind: 'alarms', rows: readAlarmRows(db) };
  if (input.action === 'enable' || input.action === 'stop') assertActor(db, input.actor, now);
  let view = checkCurrent(db, input.timestamp, now);
  if (input.action === 'enable' && view.state.state === 'off') {
    if (view.state.generation === Number.MAX_SAFE_INTEGER) recovery();
    const changed = db.sqlite
      .prepare(`UPDATE security_trigger_state SET state='on',enable_generation=enable_generation+1,
      enabling_user_id=?,expected_alarm_count=0 WHERE singleton=1 AND state='off' AND enable_generation=?`)
      .run(input.actor.userId, view.state.generation);
    if (changed.changes !== 1) throw new ControlProductPreconditionError();
    view = readState(db);
  } else if (input.action === 'stop' && view.state.state !== 'off') {
    view = insertAlarm(db, view, 'R1', input.timestamp, now);
  }
  const current = snapshot(db, view, now);
  if (input.action !== 'audit') return { kind: 'state', snapshot: current };
  if (!current.delegationCurrent) return { kind: 'audit-unavailable', snapshot: current };
  // Server is the physical Core Audit home, not workspace_id IS NULL. Opaque links remain original facts.
  const after = input.after;
  const rows = (
    after
      ? db.sqlite
          .prepare(`SELECT * FROM audit_events
    WHERE created_at>? OR (created_at=? AND audit_event_id>?) ORDER BY created_at,audit_event_id LIMIT ?`)
          .all(after.createdAt, after.createdAt, after.auditEventId, input.limit)
      : db.sqlite
          .prepare('SELECT * FROM audit_events ORDER BY created_at,audit_event_id LIMIT ?')
          .all(input.limit)
  ) as Row[];
  const last = rows.at(-1);
  return {
    kind: 'audit',
    events: rows.map(auditEventFromRow),
    next:
      rows.length === input.limit && last
        ? { createdAt: last.created_at as string, auditEventId: last.audit_event_id as string }
        : null,
  };
}
