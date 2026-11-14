import { randomUUID } from 'node:crypto';
import {
  type ActorRef,
  type AuditEvent,
  AuditEventSchema,
  readRetainedV1,
  TimestampSchema,
  UserIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import { auditEventFromRow } from '../audit-events.js';
import { evaluateOpenKitAccessTokenUsability } from '../auth/access-token.js';
import {
  getOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { getLocalUserId } from '../auth/identity.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import {
  type SecurityItemKey,
  securityRequestId,
  securityThreadId,
} from '../security/identifiers.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { CoreDb } from './db.js';
import {
  type SecurityThreadDestination,
  SecurityThreadDestinationSchema,
} from './security-thread-destination-codecs.js';
import {
  type ControlSecurityTrigger,
  type ControlSecurityTriggerResult,
  type SecurityAlarmRow,
  SecurityAlarmRowSchema,
  type SecurityAuditAction,
  SecurityAuditActionSchema,
  type SecurityAuditAssessment,
  SecurityAuditAssessmentSchema,
  type SecurityAuditCursor,
  type SecurityAuditMissingField,
  type SecurityEventOutboxRow,
  SecurityEventOutboxRowSchema,
  SecurityTriggerRefusal,
  type SecurityTriggerSnapshot,
} from './security-trigger-codecs.js';
import { resolvePersonalWorkspaceIdInDb } from './workspace-owner-records.js';

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

/** One current eligibility owner for original alarms and new native event obligations. */
function currentAdministrators(db: CoreDb, now: Date): string[] {
  return (
    db.sqlite.prepare("SELECT id FROM users WHERE status='active' ORDER BY id").all() as {
      id: string;
    }[]
  )
    .filter(({ id }) => administrator(db, id, now))
    .map(({ id }) => id);
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
  const recipients = currentAdministrators(db, now);
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

const outboxColumns = `schema_version AS schemaVersion,request_id AS requestId,
  alarm_id AS alarmId,key_json AS keyJson,recipient_user_id AS recipientUserId,
  occurrence_kind AS occurrenceKind,occurrence_n AS occurrenceN,raised`;
function readAlarmRow(
  db: CoreDb,
  raw: unknown,
  originals = new Map<string, Alarm>()
): SecurityAlarmRow {
  return retained(raw, (row) => {
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
  });
}
function readAlarmRows(db: CoreDb): SecurityAlarmRow[] {
  readState(db);
  const rows = db.sqlite
    .prepare(`SELECT ${outboxColumns} FROM security_trigger_outbox
    WHERE alarm_id IS NOT NULL AND raised=0 ORDER BY created_at,request_id LIMIT 128`)
    .all();
  const originals = new Map<string, Alarm>();
  return rows.map((raw) => readAlarmRow(db, raw, originals));
}
function readAlarmRequest(db: CoreDb, requestId: string): SecurityAlarmRow {
  const raw = db.sqlite
    .prepare(`SELECT ${outboxColumns} FROM security_trigger_outbox WHERE request_id=?`)
    .get(requestId);
  if (!raw) recovery();
  return readAlarmRow(db, raw);
}

const ProgressRecord = z
  .object({
    schemaVersion: z.literal(1),
    sourceRowId: Counter.positive().nullable(),
    createdAt: TimestampSchema.nullable(),
    auditEventId: z.string().min(1).nullable(),
    assessed: Counter,
  })
  .strict();
type Progress = z.infer<typeof ProgressRecord>;
const AssessmentRecord = SecurityAuditAssessmentSchema.extend({
  schemaVersion: z.literal(1),
  sourceRowId: Counter.positive(),
  responsibleUserId: UserIdSchema,
  outcome: AuditEventSchema.shape.outcome,
});
type Assessment = z.infer<typeof AssessmentRecord>;
const assessmentColumns = `schema_version AS schemaVersion,audit_event_id AS auditEventId,
  source_rowid AS sourceRowId,created_at AS createdAt,enable_generation AS enableGeneration,
  action,actor_json AS actorJson,target_user_id AS targetUserId,outcome,
  responsible_user_id AS responsibleUserId,status,rule,notify,missing_fields_json AS missingFieldsJson,
  recipient_count AS recipientCount`;

const requiredFacts: Record<SecurityAuditAction, readonly SecurityAuditMissingField[]> = {
  'user.disable': ['actor', 'target-user', 'successful-outcome'],
  'auth.admin-recovery.issue': ['actor', 'target-user', 'successful-outcome'],
  'auth.token.issue': ['token-id', 'scope', 'owner', 'principal', 'actor', 'expiry'],
  'auth.token.revoke': ['token-id', 'scope', 'actor'],
  'auth.token.rotate': ['token-id', 'scope', 'actor'],
  'auth.bootstrap.consume': [],
  'administration.configuration.apply': ['changed-sections', 'actor'],
  'server.config.update': ['changed-keys', 'actor'],
  'policy.write': ['scope', 'full-diff-classification', 'actor'],
  'app.update.start': ['target-digest', 'actor'],
  'channel.pairing.bind': [
    'channel-kind',
    'target-user',
    'binding-revision',
    'actor',
    'administrator-at-event',
  ],
  'channel.pairing.unbind': [
    'channel-kind',
    'target-user',
    'binding-revision',
    'actor',
    'administrator-at-event',
  ],
  'auth.failure-threshold': ['kind', 'key-kind', 'window', 'count'],
  'auth.revoked-credential-presented': ['token-id', 'scope', 'status', 'source'],
};

/** Only admitted original facts are available; resources/summaries/current records are not history. */
function assessFacts(
  action: SecurityAuditAction,
  actor: ActorRef | null,
  targetUserId: string | null,
  outcome: AuditEvent['outcome'],
  responsibleUserId: string
): Pick<SecurityAuditAssessment, 'status' | 'rule' | 'notify' | 'missingFields'> {
  const missingFields: SecurityAuditMissingField[] =
    action === 'auth.bootstrap.consume'
      ? [actor === null ? 'actor' : 'bootstrap-actor-semantics']
      : requiredFacts[action].filter((field) => {
          if (field === 'actor') return actor === null;
          if (field === 'target-user') return targetUserId === null;
          if (field === 'successful-outcome') return outcome !== 'succeeded';
          return true;
        });
  if (missingFields.length)
    return { status: 'unsupported', rule: null, notify: null, missingFields };
  if (action === 'auth.admin-recovery.issue')
    return { status: 'detected', rule: 'R1', notify: 'immediate', missingFields };
  if (action !== 'user.disable') return recovery();
  return {
    status: 'detected',
    rule: 'R1d',
    notify: actor?.kind === 'user' && actor.id === responsibleUserId ? 'daily' : 'immediate',
    missingFields,
  };
}

function readAssessment(db: CoreDb, raw: unknown): Assessment {
  return retained(raw, (row) => {
    const { actorJson, missingFieldsJson, ...fields } = row;
    const value = AssessmentRecord.parse({
      ...fields,
      actor: actorJson === null ? null : JSON.parse(z.string().parse(actorJson)),
      missingFields: JSON.parse(z.string().parse(missingFieldsJson)),
    });
    const original = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE rowid=?')
      .get(value.sourceRowId);
    if (!original) recovery();
    const source = auditEventFromRow(original as Row);
    if (
      source.id !== value.auditEventId ||
      source.createdAt !== value.createdAt ||
      source.action !== value.action ||
      source.outcome !== value.outcome ||
      JSON.stringify(source.actor ?? null) !== JSON.stringify(value.actor) ||
      (source.subject?.kind === 'user' ? source.subject.id : null) !== value.targetUserId
    )
      recovery();
    const decision = assessFacts(
      value.action,
      value.actor,
      value.targetUserId,
      value.outcome,
      value.responsibleUserId
    );
    if (
      decision.status !== value.status ||
      decision.rule !== value.rule ||
      decision.notify !== value.notify ||
      JSON.stringify(decision.missingFields) !== JSON.stringify(value.missingFields) ||
      (value.status === 'unsupported' && value.recipientCount !== 0) ||
      (value.rule === 'R1d' && value.recipientCount !== 1) ||
      (value.rule === 'R1' && value.recipientCount === 0)
    )
      recovery();
    return value;
  });
}
function assessmentProjection(record: Assessment): SecurityAuditAssessment {
  const {
    schemaVersion: _version,
    sourceRowId: _position,
    responsibleUserId: _responsible,
    outcome: _outcome,
    ...value
  } = record;
  return value;
}

/** Includes zero-row loss: returning an empty outbox must not hide an original owed recipient. */
function validateEventCounts(db: CoreDb): void {
  const mismatch = db.sqlite
    .prepare(`SELECT a.audit_event_id FROM security_trigger_audit_assessments a
    LEFT JOIN security_trigger_outbox o ON o.audit_event_id=a.audit_event_id
    GROUP BY a.audit_event_id,a.recipient_count
    HAVING COUNT(o.request_id)<>a.recipient_count OR COUNT(DISTINCT o.recipient_user_id)<>a.recipient_count LIMIT 1`)
    .get();
  const orphan = db.sqlite
    .prepare(`SELECT o.request_id FROM security_trigger_outbox o
    LEFT JOIN security_trigger_audit_assessments a ON a.audit_event_id=o.audit_event_id
    WHERE o.audit_event_id IS NOT NULL AND (a.audit_event_id IS NULL OR o.alarm_id IS NOT NULL
    OR o.occurrence_kind<>'initial' OR o.occurrence_n<>1) LIMIT 1`)
    .get();
  if (mismatch || orphan) recovery();
}
function progressCursor(progress: Progress): SecurityAuditCursor | null {
  if (progress.sourceRowId === null) return null;
  if (progress.createdAt === null || progress.auditEventId === null) return recovery();
  return { createdAt: progress.createdAt, auditEventId: progress.auditEventId };
}
function readProgress(db: CoreDb): Progress {
  const raw = db.sqlite
    .prepare(`SELECT schema_version AS schemaVersion,cursor_rowid AS sourceRowId,
    cursor_created_at AS createdAt,cursor_audit_event_id AS auditEventId,assessed_count AS assessed
    FROM security_trigger_audit_progress WHERE singleton=1`)
    .get();
  if (!raw) recovery();
  const progress = retained(raw, (value) => ProgressRecord.parse(value));
  if (
    (progress.sourceRowId === null) !== (progress.createdAt === null) ||
    (progress.sourceRowId === null) !== (progress.auditEventId === null)
  )
    recovery();
  const count = db.sqlite
    .prepare(`SELECT COUNT(*) AS total,MAX(source_rowid) AS last
    FROM security_trigger_audit_assessments`)
    .get() as { total: number; last: number | null };
  if (
    count.total !== progress.assessed ||
    (count.last !== null && count.last > (progress.sourceRowId ?? 0))
  )
    recovery();
  if (progress.sourceRowId !== null) {
    const original = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE rowid=?')
      .get(progress.sourceRowId);
    if (!original) recovery();
    const source = auditEventFromRow(original as Row);
    if (source.id !== progress.auditEventId || source.createdAt !== progress.createdAt) recovery();
  }
  validateEventCounts(db);
  return progress;
}

function readDetections(
  db: CoreDb,
  input: Extract<ControlSecurityTrigger, { action: 'detections' }>
): ControlSecurityTriggerResult {
  readProgress(db);
  const after = input.after;
  const rows = after
    ? db.sqlite
        .prepare(`SELECT ${assessmentColumns} FROM security_trigger_audit_assessments
      WHERE created_at>? OR (created_at=? AND audit_event_id>?) ORDER BY created_at,audit_event_id LIMIT ?`)
        .all(after.createdAt, after.createdAt, after.auditEventId, input.limit)
    : db.sqlite
        .prepare(`SELECT ${assessmentColumns} FROM security_trigger_audit_assessments
      ORDER BY created_at,audit_event_id LIMIT ?`)
        .all(input.limit);
  const events = rows.map((row) => assessmentProjection(readAssessment(db, row)));
  const last = events.at(-1);
  return {
    kind: 'detections',
    events,
    next:
      last && events.length === input.limit
        ? { createdAt: last.createdAt, auditEventId: last.auditEventId }
        : null,
  };
}
function readEventOutbox(db: CoreDb): SecurityEventOutboxRow[] {
  readProgress(db);
  const rows = db.sqlite
    .prepare(`SELECT ${outboxColumns},audit_event_id AS auditEventId
    FROM security_trigger_outbox WHERE audit_event_id IS NOT NULL AND raised=0
    ORDER BY created_at,request_id LIMIT 128`)
    .all();
  const originals = new Map<string, Assessment>();
  return rows.map((raw) =>
    retained(raw, (row) => {
      if (
        typeof row.auditEventId !== 'string' ||
        row.alarmId !== null ||
        typeof row.keyJson !== 'string' ||
        ![0, 1].includes(row.raised as number)
      )
        return recovery();
      let original = originals.get(row.auditEventId);
      if (!original) {
        const source = db.sqlite
          .prepare(`SELECT ${assessmentColumns} FROM security_trigger_audit_assessments
        WHERE audit_event_id=?`)
          .get(row.auditEventId);
        if (!source) recovery();
        original = readAssessment(db, source);
        originals.set(row.auditEventId, original);
      }
      if (original.status !== 'detected') return recovery();
      const value = SecurityEventOutboxRowSchema.parse({
        requestId: row.requestId,
        recipientUserId: row.recipientUserId,
        key: JSON.parse(row.keyJson),
        rule: original.rule,
        notify: original.notify,
        occurrence: { kind: row.occurrenceKind, n: row.occurrenceN },
        raised: row.raised === 1,
      });
      if (
        value.key[1] !== original.auditEventId ||
        (value.rule === 'R1d' && value.recipientUserId !== original.responsibleUserId) ||
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

/** Append source, assessment, all recipients and cursor advance stay in the original savepoint. */
function detectAudit(
  db: CoreDb,
  input: Extract<ControlSecurityTrigger, { action: 'audit-detect' }>,
  view: View,
  now: Date
): ControlSecurityTriggerResult {
  const before = readProgress(db);
  const responsibleUserId = view.state.enabler;
  if (!responsibleUserId) return recovery();
  // A timestamp is an original fact, not append authority: late earlier-clock inserts still count.
  const rows = db.sqlite
    .prepare('SELECT rowid AS sourceRowId,* FROM audit_events WHERE rowid>? ORDER BY rowid LIMIT ?')
    .all(before.sourceRowId ?? 0, input.limit) as Row[];
  let detected = 0,
    unsupported = 0;
  let progress = before;
  for (const raw of rows) {
    const { sourceRowId, ...sourceRow } = raw;
    if (!Counter.positive().safeParse(sourceRowId).success) recovery();
    const source = auditEventFromRow(sourceRow);
    const createdAt = TimestampSchema.parse(source.createdAt);
    const action = SecurityAuditActionSchema.safeParse(source.action);
    if (action.success) {
      const actor = source.actor ?? null;
      const targetUserId = source.subject?.kind === 'user' ? source.subject.id : null;
      const decision = assessFacts(
        action.data,
        actor,
        targetUserId,
        source.outcome,
        responsibleUserId
      );
      const recipients =
        decision.status === 'unsupported'
          ? []
          : decision.rule === 'R1'
            ? currentAdministrators(db, now)
            : [responsibleUserId];
      if (decision.status === 'detected' && recipients.length === 0) recovery();
      db.sqlite
        .prepare(`INSERT INTO security_trigger_audit_assessments
        (schema_version,audit_event_id,source_rowid,created_at,enable_generation,action,actor_json,target_user_id,
        outcome,responsible_user_id,status,rule,notify,missing_fields_json,recipient_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          writeRetainedV1({}).schemaVersion,
          source.id,
          sourceRowId as number,
          createdAt,
          view.state.generation,
          action.data,
          actor === null ? null : JSON.stringify(actor),
          targetUserId,
          source.outcome,
          responsibleUserId,
          decision.status,
          decision.rule,
          decision.notify,
          JSON.stringify(decision.missingFields),
          recipients.length
        );
      const key: ['event', string] = ['event', source.id];
      const occurrence = { kind: 'initial' as const, n: 1 };
      for (const recipientUserId of recipients) {
        db.sqlite
          .prepare(`INSERT INTO security_trigger_outbox
          (request_id,schema_version,audit_event_id,key_json,recipient_user_id,occurrence_kind,occurrence_n,raised,created_at)
          VALUES (?,?,?,?,?,?,?,0,?)`)
          .run(
            securityRequestId({ key, recipientUserId, occurrence }),
            writeRetainedV1({}).schemaVersion,
            source.id,
            JSON.stringify(key),
            recipientUserId,
            occurrence.kind,
            occurrence.n,
            input.timestamp
          );
      }
      if (decision.status === 'detected') detected++;
      else unsupported++;
    }
    progress = {
      ...progress,
      sourceRowId: sourceRowId as number,
      createdAt,
      auditEventId: source.id,
    };
  }
  if (rows.length) {
    const assessed = before.assessed + detected + unsupported;
    if (!Number.isSafeInteger(assessed)) recovery();
    const changed = db.sqlite
      .prepare(`UPDATE security_trigger_audit_progress SET cursor_rowid=?,cursor_created_at=?,
      cursor_audit_event_id=?,assessed_count=? WHERE singleton=1 AND cursor_rowid IS ?
      AND cursor_created_at IS ? AND cursor_audit_event_id IS ? AND assessed_count=?`)
      .run(
        progress.sourceRowId,
        progress.createdAt,
        progress.auditEventId,
        assessed,
        before.sourceRowId,
        before.createdAt,
        before.auditEventId,
        before.assessed
      );
    if (changed.changes !== 1) throw new ControlProductPreconditionError();
    progress = readProgress(db);
  }
  return {
    kind: 'audit-detection',
    cursor: progressCursor(progress),
    scanned: rows.length,
    detected,
    unsupported,
  };
}

const DestinationRecord = SecurityThreadDestinationSchema.extend({ schemaVersion: z.literal(1) });
const destinationColumns = `schema_version AS schemaVersion,recipient_user_id AS recipientUserId,
  generation,workspace_id AS workspaceId,thread_id AS threadId,source_request_id AS sourceRequestId,status`;
function readDestinationRow(db: CoreDb, raw: unknown): SecurityThreadDestination {
  const { schemaVersion: _version, ...destination } = retained(raw, (value) =>
    DestinationRecord.parse(value)
  );
  if (
    securityThreadId(destination.recipientUserId, destination.generation) !==
      destination.threadId ||
    readAlarmRequest(db, destination.sourceRequestId).recipientUserId !==
      destination.recipientUserId
  )
    recovery();
  return destination;
}
function readDestination(db: CoreDb, threadId: string): SecurityThreadDestination | null {
  const raw = db.sqlite
    .prepare(`SELECT ${destinationColumns} FROM security_thread_destinations WHERE thread_id=?`)
    .get(threadId);
  return raw ? readDestinationRow(db, raw) : null;
}
function assertDestinationRecipient(db: CoreDb, recipientUserId: string, now: Date): string {
  if (!administrator(db, recipientUserId, now)) throw new SecurityTriggerRefusal('forbidden');
  return resolvePersonalWorkspaceIdInDb(db, recipientUserId);
}
/** An actual owed alarm supplies the fixed alarm grant; native assignment never accepts caller IDs. */
function reserveDestination(
  db: CoreDb,
  requestId: string,
  now: Date
): ControlSecurityTriggerResult {
  const source = readAlarmRequest(db, requestId);
  if (source.raised) throw new SecurityTriggerRefusal('forbidden');
  const workspaceId = assertDestinationRecipient(db, source.recipientUserId, now);
  const raw = db.sqlite
    .prepare(`SELECT ${destinationColumns} FROM security_thread_destinations
    WHERE recipient_user_id=? ORDER BY generation DESC LIMIT 1`)
    .get(source.recipientUserId);
  if (raw) {
    const destination = readDestinationRow(db, raw);
    if (destination.workspaceId !== workspaceId) recovery();
    return { kind: 'destination', destination, fresh: false };
  }
  // This subcut allocates only the initial generation. Archive rollover belongs to the later Raise.
  const generation = 1;
  const threadId = securityThreadId(source.recipientUserId, generation);
  db.sqlite
    .prepare(`INSERT INTO security_thread_destinations
    (schema_version,recipient_user_id,generation,workspace_id,thread_id,source_request_id,status,created_at)
    VALUES (?,?,?,?,?,?,'reserved',?)`)
    .run(
      writeRetainedV1({}).schemaVersion,
      source.recipientUserId,
      generation,
      workspaceId,
      threadId,
      requestId,
      now.toISOString()
    );
  const destination = readDestination(db, threadId);
  if (!destination) recovery();
  return { kind: 'destination', destination, fresh: true };
}
/** Original Workspace ACK precedes this progress transition; it does not mark an alarm raised. */
function readyDestination(
  db: CoreDb,
  requestId: string,
  threadId: string,
  now: Date
): ControlSecurityTriggerResult {
  const destination = readDestination(db, threadId);
  if (!destination || destination.sourceRequestId !== requestId) recovery();
  const source = readAlarmRequest(db, requestId);
  if (source.raised) throw new SecurityTriggerRefusal('forbidden');
  if (assertDestinationRecipient(db, destination.recipientUserId, now) !== destination.workspaceId)
    recovery();
  if (destination.status === 'reserved') {
    const changed = db.sqlite
      .prepare(`UPDATE security_thread_destinations SET status='ready'
      WHERE thread_id=? AND source_request_id=? AND status='reserved'`)
      .run(threadId, requestId);
    if (changed.changes !== 1) throw new ControlProductPreconditionError();
  }
  return { kind: 'destination', destination: { ...destination, status: 'ready' }, fresh: false };
}

/** Executes only inside the existing Core control worker's product savepoint and covering FULL ACK. */
export function applySecurityTriggerInDb(
  db: CoreDb,
  input: ControlSecurityTrigger
): ControlSecurityTriggerResult {
  if (db.scope !== 'core' || !db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  // Caller timestamps describe the original observation; they never move credential expiry backwards.
  const now = new Date();
  if (input.action === 'detection-progress') {
    const progress = readProgress(db);
    return {
      kind: 'detection-progress',
      cursor: progressCursor(progress),
      assessed: progress.assessed,
    };
  }
  if (input.action === 'detections') return readDetections(db, input);
  if (input.action === 'event-outbox') return { kind: 'event-outbox', rows: readEventOutbox(db) };
  if (input.action === 'alarms') return { kind: 'alarms', rows: readAlarmRows(db) };
  if (input.action === 'alarm-read')
    return { kind: 'alarm', row: readAlarmRequest(db, input.requestId) };
  if (input.action === 'destination-read')
    return { kind: 'destination-read', destination: readDestination(db, input.threadId) };
  if (input.action === 'destination-reserve') return reserveDestination(db, input.requestId, now);
  if (input.action === 'destination-ready')
    return readyDestination(db, input.requestId, input.threadId, now);
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
  if (input.action === 'audit-detect') {
    if (!current.delegationCurrent) return { kind: 'audit-unavailable', snapshot: current };
    return detectAudit(db, input, view, now);
  }
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
