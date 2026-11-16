import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActorRef, allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { recordServerAuditEvent } from '../audit-events.js';
import { securityRequestId } from '../security/identifiers.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { type SecurityAuditAction, SecurityAuditActionSchema } from './security-trigger-codecs.js';
import { applySecurityTriggerInDb, assessFacts } from './security-trigger-native.js';

const userId = allocateEntityId('usr');
const actor: ActorRef = { kind: 'user', id: userId };
const targetUserId = allocateEntityId('usr');
const detected = (rule: 'R1' | 'R1d' | 'E12', notify: 'immediate' | 'daily') => ({
  status: 'detected',
  rule,
  notify,
  missingFields: [],
});
const unsupported = (...missingFields: string[]) => ({
  status: 'unsupported',
  rule: null,
  notify: null,
  missingFields,
});

// Frozen rc.9 outcomes, independent of the production classifier's required-facts table.
const oldSucceeded: Record<
  SecurityAuditAction,
  ReturnType<typeof detected> | ReturnType<typeof unsupported>
> = {
  'auth.token.issue': unsupported('token-id', 'scope', 'owner', 'principal', 'expiry'),
  'auth.token.revoke': unsupported('token-id', 'scope'),
  'auth.token.rotate': unsupported('token-id', 'scope'),
  'auth.admin-recovery.issue': detected('R1', 'immediate'),
  'auth.bootstrap.consume': unsupported('bootstrap-actor-semantics'),
  'administration.configuration.apply': unsupported('changed-sections'),
  'server.config.update': unsupported('changed-keys'),
  'policy.write': unsupported('scope', 'full-diff-classification'),
  'user.disable': detected('R1d', 'daily'),
  'app.update.start': unsupported('target-digest'),
  'channel.pairing.bind': unsupported('channel-kind', 'binding-revision', 'administrator-at-event'),
  'channel.pairing.unbind': unsupported(
    'channel-kind',
    'binding-revision',
    'administrator-at-event'
  ),
  'auth.failure-threshold': unsupported('kind', 'key-kind', 'window', 'count'),
  'auth.revoked-credential-presented': unsupported('token-id', 'scope', 'status', 'source'),
  'security.canary': unsupported('status'),
  'security.honey-credential': unsupported('status'),
  'security.containment.gap': unsupported('status'),
};

it.each(SecurityAuditActionSchema.options)(
  'preserves the legacy succeeded/denied classification of %s',
  (action) => {
    expect(
      assessFacts(action, actor, targetUserId, 'succeeded', userId, 'Legacy human summary.')
    ).toEqual(oldSucceeded[action]);
    const denied = action.startsWith('security.')
      ? detected('E12', 'immediate')
      : action === 'auth.admin-recovery.issue' || action === 'user.disable'
        ? unsupported('successful-outcome')
        : oldSucceeded[action];
    expect(
      assessFacts(action, actor, targetUserId, 'denied', userId, 'Legacy human summary.')
    ).toEqual(denied);
  }
);

it('preserves existing missing actor/target/outcome and foreign-actor notification rules', () => {
  expect(assessFacts('user.disable', null, null, 'failed', userId, '{}')).toEqual(
    unsupported('actor', 'target-user', 'successful-outcome')
  );
  expect(assessFacts('auth.admin-recovery.issue', null, null, 'failed', userId, '{}')).toEqual(
    unsupported('actor', 'target-user', 'successful-outcome')
  );
  expect(assessFacts('auth.bootstrap.consume', null, null, 'succeeded', userId, '{}')).toEqual(
    unsupported('actor')
  );
  expect(
    assessFacts(
      'user.disable',
      { kind: 'user', id: targetUserId },
      targetUserId,
      'succeeded',
      userId,
      '{}'
    )
  ).toEqual(detected('R1d', 'immediate'));
});

const shapes = [
  {
    action: 'server.config.update',
    facts: { changedKeys: ['security.pauseAgentWork'] },
    rule: 'R1',
    notify: 'immediate',
    name: 'pause/unpause',
  },
  {
    action: 'server.config.update',
    facts: { changedKeys: ['server.publicBaseUrl'] },
    rule: 'R1d',
    notify: 'daily',
    name: 'ordinary config',
  },
  ...(['channel.pairing.bind', 'channel.pairing.unbind'] as const).flatMap((action) =>
    [false, true].map((administratorAtEvent) => ({
      action,
      facts: {
        channelKind: 'discord',
        userId,
        bindingRevision: randomUUID(),
        administratorAtEvent,
      },
      rule: administratorAtEvent ? 'R1' : 'R1d',
      notify: administratorAtEvent ? 'immediate' : 'daily',
      name: `administrator=${administratorAtEvent}`,
    }))
  ),
] as const;

/** Inserts a reviewed rc.10 tuple directly; no candidate detection writer creates its expected decision. */
function reservedRecord(shape: (typeof shapes)[number]) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-reader-reservation-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  const recipient = ensureLocalUser(db);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const originalActor = { kind: 'user' as const, id: recipient };
  const source = recordServerAuditEvent({
    coreDb: db,
    action: shape.action,
    actor: originalActor,
    subject: shape.action.startsWith('channel.') ? originalActor : null,
    outcome: 'succeeded',
    summary: JSON.stringify({
      ...shape.facts,
      ...(shape.action.startsWith('channel.') ? { userId: recipient } : {}),
    }),
  });
  const { position } = db.sqlite
    .prepare('SELECT rowid AS position FROM audit_events WHERE audit_event_id=?')
    .get(source.id) as { position: number };
  const requestId = securityRequestId({
    key: ['event', source.id],
    recipientUserId: recipient,
    occurrence: { kind: 'initial', n: 1 },
  });
  db.sqlite.transaction(() => {
    db.sqlite
      .prepare(
        `INSERT INTO security_trigger_audit_assessments (schema_version,audit_event_id,source_rowid,created_at,enable_generation,action,actor_json,target_user_id,outcome,responsible_user_id,status,rule,notify,missing_fields_json,recipient_count) VALUES (1,?,?,?,?,?,?,?,'succeeded',?,'detected',?,?,'[]',1)`
      )
      .run(
        source.id,
        position,
        source.createdAt,
        1,
        shape.action,
        JSON.stringify(originalActor),
        source.subject?.id ?? null,
        recipient,
        shape.rule,
        shape.notify
      );
    db.sqlite
      .prepare(
        `INSERT INTO security_trigger_outbox (request_id,schema_version,audit_event_id,key_json,recipient_user_id,occurrence_kind,occurrence_n,raised,created_at) VALUES (?,1,?,?,?,'initial',1,0,?)`
      )
      .run(requestId, source.id, JSON.stringify(['event', source.id]), recipient, source.createdAt);
    db.sqlite
      .prepare(
        'UPDATE security_trigger_audit_progress SET cursor_rowid=?,cursor_created_at=?,cursor_audit_event_id=?,assessed_count=1 WHERE singleton=1'
      )
      .run(position, source.createdAt, source.id);
  })();
  const read = () =>
    db.sqlite.transaction(() =>
      applySecurityTriggerInDb(db, { action: 'detections', limit: 128 })
    )();
  return { db, read, source, recipient };
}

it.each(shapes)('accepts the rc.10 assessment and original outbox for $action ($name)', (shape) => {
  const f = reservedRecord(shape);
  expect(f.read()).toMatchObject({
    kind: 'detections',
    events: [
      {
        auditEventId: f.source.id,
        action: shape.action,
        status: 'detected',
        rule: shape.rule,
        notify: shape.notify,
        missingFields: [],
        recipientCount: 1,
      },
    ],
  });
  const outbox = f.db.sqlite.transaction(() =>
    applySecurityTriggerInDb(f.db, { action: 'event-outbox' })
  )();
  expect(outbox).toMatchObject({
    kind: 'event-outbox',
    rows: [{ recipientUserId: f.recipient, rule: shape.rule, notify: shape.notify }],
  });
});

it.each(['rule', 'notify', 'actor', 'source-facts', 'missing-recipient'] as const)(
  'refuses a tampered reserved record: %s',
  (tamper) => {
    const f = reservedRecord(shapes[0]);
    if (tamper === 'rule')
      f.db.sqlite.prepare("UPDATE security_trigger_audit_assessments SET rule='R1d'").run();
    if (tamper === 'notify')
      f.db.sqlite.prepare("UPDATE security_trigger_audit_assessments SET notify='daily'").run();
    if (tamper === 'actor')
      f.db.sqlite
        .prepare('UPDATE security_trigger_audit_assessments SET actor_json=?')
        .run(JSON.stringify(actor));
    if (tamper === 'source-facts')
      f.db.sqlite
        .prepare('UPDATE audit_events SET summary=? WHERE audit_event_id=?')
        .run(JSON.stringify({ changedKeys: ['server.publicBaseUrl'] }), f.source.id);
    if (tamper === 'missing-recipient')
      f.db.sqlite.prepare('DELETE FROM security_trigger_outbox').run();
    expect(f.read).toThrow();
  }
);

it.each(['not JSON', 'null', '[]', '{}', '{"changedKeys":[]}', '{"changedKeys":[1]}'])(
  'keeps absent/malformed config facts unsupported: %s',
  (summary) => {
    expect(assessFacts('server.config.update', actor, null, 'succeeded', userId, summary)).toEqual(
      unsupported('changed-keys')
    );
  }
);
