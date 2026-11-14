// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type ActorRef, type AuditEvent, allocateEntityId } from '@openkit/protocol';
import { describe, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents, listWorkspaceAuditEvents } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { runOpenKitOperatorCli } from '../auth/admin-recovery.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from '../auth/bootstrap-token.js';
import { type Actor, actorFromSession } from '../auth/identity.js';
import { createCatalogOperationImplementations } from '../catalog/catalog-operations.js';
import { loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { securityRequestId } from '../security/identifiers.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createWorkspaceOperationImplementations } from '../workspace-operation-implementations.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

// Internal facade DTOs fixed by N2-NATIVE-API.md, not a new Core wire protocol.
type Cursor = { createdAt: string; auditEventId: string };
type Assessment = {
  auditEventId: string;
  createdAt: string;
  enableGeneration: number;
  action: string;
  actor: ActorRef | null;
  targetUserId: string | null;
  status: 'detected' | 'unsupported';
  rule: 'R1' | 'R1d' | null;
  notify: 'immediate' | 'daily' | null;
  missingFields: string[];
  recipientCount: number;
};
type EventNotice = {
  requestId: string;
  recipientUserId: string;
  key: ['event', string];
  rule: 'R1' | 'R1d';
  notify: 'immediate' | 'daily';
  occurrence: { kind: 'initial'; n: 1 };
  raised: boolean;
};
type DetectionStore = SecurityTriggerStore & {
  detectAudit(input?: {
    limit?: number;
  }): Promise<{ cursor: Cursor | null; scanned: number; detected: number; unsupported: number }>;
  readDetectionProgress(): Promise<{ cursor: Cursor | null; assessed: number }>;
  readDetections(input?: {
    after?: Cursor;
    limit?: number;
  }): Promise<{ events: Assessment[]; next: Cursor | null }>;
  readEventOutbox(): Promise<EventNotice[]>;
};
const EXPIRY = '2099-01-01T00:00:00.000Z';
const MISSING = new Set([
  'actor',
  'target-user',
  'successful-outcome',
  'token-id',
  'scope',
  'owner',
  'principal',
  'expiry',
  'changed-sections',
  'changed-keys',
  'full-diff-classification',
  'target-digest',
  'channel-kind',
  'binding-revision',
  'administrator-at-event',
  'kind',
  'key-kind',
  'window',
  'count',
  'status',
  'source',
  'bootstrap-actor-semantics',
]);
const NAMED = new Set([
  'auth.token.issue',
  'auth.token.revoke',
  'auth.token.rotate',
  'auth.admin-recovery.issue',
  'auth.bootstrap.consume',
  'administration.configuration.apply',
  'server.config.update',
  'policy.write',
  'user.disable',
  'app.update.start',
  'channel.pairing.bind',
  'channel.pairing.unbind',
  'auth.failure-threshold',
  'auth.revoked-credential-presented',
]);
const context = (
  actor: Actor,
  scope: AdmittedOperationContext['scope'] = { kind: 'server' }
): AdmittedOperationContext => ({
  kind: 'public',
  actor,
  actorRef: { kind: 'user', id: actor.userId },
  scope,
});
const cursor = (event: AuditEvent): Cursor => ({
  createdAt: event.createdAt,
  auditEventId: event.id,
});
const order = (a: Cursor, b: Cursor) =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.auditEventId < b.auditEventId
        ? -1
        : a.auditEventId > b.auditEventId
          ? 1
          : 0;
/** Observational original-owner SELECT, never an Audit producer: timestamps are NOT append authority. */
function appendAudit(f: Fixture): AuditEvent[] {
  const records = new Map(listServerAuditEvents(f.db).map((event) => [event.id, event]));
  const ids = f.db.sqlite
    .prepare('SELECT audit_event_id AS auditEventId FROM audit_events ORDER BY rowid')
    .all() as Array<{ auditEventId: string }>;
  return ids.map(({ auditEventId }) => {
    const event = records.get(auditEventId);
    assert.ok(
      event,
      'original typed Core Audit reader must cover each actual physical source position'
    );
    return event;
  });
}
const byRequest = <T extends { requestId: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
const noticeProjection = (row: EventNotice): EventNotice => ({
  requestId: row.requestId,
  recipientUserId: row.recipientUserId,
  key: row.key,
  rule: row.rule,
  notify: row.notify,
  occurrence: row.occurrence,
  raised: row.raised,
});

/** Call-through observations on the actual Worker instance; never substitute requests/replies/commits. */
function observeNative() {
  const sent = vi.spyOn(Worker.prototype, 'postMessage');
  const emitted = vi.spyOn(Worker.prototype, 'emit');
  const frame = (v: unknown): v is { operation: string; id: number; status?: string } =>
    typeof v === 'object' &&
    v !== null &&
    'operation' in v &&
    'id' in v &&
    typeof v.id === 'number';
  return {
    checkpoint() {
      return sent.mock.calls.length;
    },
    ack(since: number) {
      const requests = sent.mock.calls
        .map(([v], i) => ({ v, i }))
        .filter(({ v, i }) => i >= since && frame(v) && v.operation === 'security-trigger');
      assert.ok(requests.length > 0, 'detection must enter the ORIGINAL Core worker family');
      assert.ok(
        requests.some(
          ({ v, i }) =>
            frame(v) &&
            emitted.mock.calls.some(
              ([event, reply], j) =>
                event === 'message' &&
                frame(reply) &&
                reply.operation === 'security-trigger' &&
                reply.id === v.id &&
                reply.status === 'ok' &&
                emitted.mock.contexts[j] === sent.mock.contexts[i]
            )
        ),
        'actual matching success ACK, on the same real Worker, must precede facade completion/refusal'
      );
    },
    restore() {
      emitted.mockRestore();
      sent.mockRestore();
    },
  };
}

async function fixture() {
  await shutdownControlStoreWorkerClient();
  const trace = observeNative();
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-security-audit-detection-'));
  let coreDb = openCoreDb(dataRoot);
  async function close() {
    closeWorkspaceProductReadHandles(dataRoot);
    if (coreDb.sqlite.open && coreDb.sqlite.readonly) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  }
  onTestFinished(async () => {
    try {
      await close();
      rmSync(dataRoot, { recursive: true, force: true });
    } finally {
      trace.restore();
    }
  });
  applyMigrations(coreDb);
  return {
    dataRoot,
    trace,
    close,
    get db() {
      return coreDb;
    },
    get trigger() {
      return new SecurityTriggerStore(coreDb) as DetectionStore;
    },
    tokens() {
      return createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
    },
    async reopen() {
      await close();
      coreDb = openCoreDb(dataRoot);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function tokenActor(f: Fixture, secret: string): Promise<Actor> {
  const record = await verifyOpenKitAccessTokenRecord(f.db, secret);
  assert.ok(record, 'only the actual issuer/verifier supplies credential authority');
  return {
    kind: 'token',
    userId: record.ownerUserId,
    tokenId: record.tokenId,
    tokenScope: record.scope,
    tokenWorkspaceIds: record.workspaceIds,
  };
}
async function signup(f: Fixture, name: string) {
  const email = [randomUUID(), 'example.invalid'].join('@');
  const auth = createBetterAuth(f.db, {
    mode: 'local',
    env: { BETTER_AUTH_URL: 'https://auth.example.invalid' },
  });
  const created = await auth.api.signUpEmail({
    returnHeaders: true,
    body: { name, email, password: randomUUID() },
  });
  const cookie = created.headers
    .getSetCookie()
    .map((v) => v.split(';', 1)[0])
    .join('; ');
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.ok(session);
  return { actor: actorFromSession(session), email };
}
async function server(withBackup = true) {
  const f = await fixture();
  const bootstrap = await ensureServerBootstrapTokenForStartup(f.db);
  assert.ok(bootstrap);
  writeServerBootstrapTokenEmission(f.dataRoot, bootstrap);
  const owner = await f
    .tokens()
    ['bootstrap.consume']({
      token: bootstrap.token,
      ownerUserId: allocateEntityId('usr'),
      displayName: 'N2 enabling administrator',
      email: [randomUUID(), 'example.invalid'].join('@'),
      password: randomUUID(),
      tokenExpiresAt: EXPIRY,
    });
  const admin = await tokenActor(f, owner.token);
  if (!withBackup)
    return { f, admin, ownerTokenId: owner.record.tokenId, backup: null, backupEmail: null };
  const user = await signup(f, 'N2 independent administrator');
  const issued = await f
    .tokens()
    ['token.create'](
      {
        ownerUserId: user.actor.userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: EXPIRY,
      },
      context(admin)
    );
  return {
    f,
    admin,
    ownerTokenId: owner.record.tokenId,
    backup: await tokenActor(f, issued.token),
    backupEmail: user.email,
  };
}
function sharing(f: Fixture, store = new FsStore({ dataRoot: f.dataRoot })) {
  return createWorkspaceSharingOperationImplementations({
    coreDb: f.db,
    store,
    inflightCommands: new Map(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
}
async function disable(f: Fixture, actor: Actor, userId: string) {
  const requestId = randomUUID();
  await sharing(f)['user.disable']({ requestId, targetUserId: userId }, context(actor));
  const event = listServerAuditEvents(f.db).find(
    (e) => e.requestId === requestId && e.action === 'user.disable'
  );
  assert.ok(event, 'original User lifecycle must emit its actual structured Core Audit');
  assert.equal(event.outcome, 'succeeded');
  assert.equal(event.subject?.kind, 'user');
  assert.equal(event.subject?.id, userId);
  assert.deepEqual(event.actor, { kind: 'user', id: actor.userId });
  return event;
}
function expectedNotice(
  event: AuditEvent,
  recipientUserId: string,
  rule: 'R1' | 'R1d',
  notify: 'immediate' | 'daily'
): EventNotice {
  const key: ['event', string] = ['event', event.id];
  const occurrence = { kind: 'initial' as const, n: 1 as const };
  return {
    requestId: securityRequestId({ key, recipientUserId, occurrence }),
    recipientUserId,
    key,
    rule,
    notify,
    occurrence,
    raised: false,
  };
}

/** Reads only named assessment pages; reading may NEVER reset or advance the native detection cursor. */
async function assessments(f: Fixture, limit = 2): Promise<Assessment[]> {
  const before = await f.trigger.readDetectionProgress();
  const all: Assessment[] = [];
  let after: Cursor | undefined;
  for (let page = 0; page < 128; page++) {
    const result = await f.trigger.readDetections({ ...(after ? { after } : {}), limit });
    assert.ok(result.events.length <= limit);
    for (const event of result.events) {
      const key = { createdAt: event.createdAt, auditEventId: event.auditEventId };
      if (after) assert.ok(order(after, key) < 0);
      if (all.length)
        assert.ok(
          order({ createdAt: all.at(-1)!.createdAt, auditEventId: all.at(-1)!.auditEventId }, key) <
            0
        );
      all.push(event);
    }
    if (!result.next) {
      assert.deepEqual(await f.trigger.readDetectionProgress(), before);
      assert.equal(new Set(all.map((e) => e.auditEventId)).size, all.length);
      return all;
    }
    assert.ok(result.events.length > 0, 'a continuation must have a real persisted source row');
    const last = result.events.at(-1)!;
    assert.deepEqual(result.next, { createdAt: last.createdAt, auditEventId: last.auditEventId });
    after = result.next;
  }
  throw new Error('Bounded original assessment paging did not terminate.');
}

/** Actual source windows, native counts, exact compound progress, all recipients and ACKs agree. No crash/fault hook is invented. */
async function scanAll(
  f: Fixture,
  limit = 128,
  previous?: { cursor: Cursor | null; assessed: number }
) {
  const source = appendAudit(f);
  let progress = await f.trigger.readDetectionProgress();
  assert.deepEqual(progress, previous ?? { cursor: null, assessed: 0 });
  let offset = 0;
  if (progress.cursor) {
    const index = source.findIndex((event) => event.id === progress.cursor!.auditEventId);
    assert.ok(index >= 0);
    assert.deepEqual(
      cursor(source[index]!),
      progress.cursor,
      'public cursor still names the original native source'
    );
    offset = index + 1;
  }
  const totals = { scanned: 0, detected: 0, unsupported: 0 };
  while (offset + totals.scanned < source.length) {
    const window = source.slice(offset + totals.scanned, offset + totals.scanned + limit);
    const entry = f.trace.checkpoint();
    const result = await f.trigger.detectAudit(limit === 128 ? undefined : { limit });
    f.trace.ack(entry);
    assert.equal(result.scanned, window.length);
    assert.deepEqual(result.cursor, cursor(window.at(-1)!));
    assert.equal(
      result.detected + result.unsupported,
      window.filter((e) => NAMED.has(e.action)).length
    );
    const next = await f.trigger.readDetectionProgress();
    assert.deepEqual(next, {
      cursor: result.cursor,
      assessed: progress.assessed + result.detected + result.unsupported,
    });
    progress = next;
    totals.scanned += result.scanned;
    totals.detected += result.detected;
    totals.unsupported += result.unsupported;
  }
  const entry = f.trace.checkpoint();
  assert.deepEqual(await f.trigger.detectAudit({ limit }), {
    cursor: progress.cursor,
    scanned: 0,
    detected: 0,
    unsupported: 0,
  });
  f.trace.ack(entry);
  const events = await assessments(f);
  assert.equal(events.length, progress.assessed);
  assert.deepEqual(
    events.map((e) => e.auditEventId),
    source
      .filter((e) => NAMED.has(e.action))
      .sort((a, b) => order(cursor(a), cursor(b)))
      .map((e) => e.id),
    'assessment paging is chronological; native detection progress is append-owned'
  );
  for (const e of events) {
    const original = source.find((row) => row.id === e.auditEventId)!;
    assert.equal(e.createdAt, original.createdAt);
    assert.equal(e.action, original.action);
    assert.deepEqual(e.actor, original.actor ?? null);
    assert.equal(e.targetUserId, original.subject?.kind === 'user' ? original.subject.id : null);
    assert.equal(e.enableGeneration, 1);
    assert.equal(new Set(e.missingFields).size, e.missingFields.length);
    assert.ok(e.missingFields.every((field) => MISSING.has(field)));
    if (e.status === 'detected') assert.deepEqual(e.missingFields, []);
    else {
      assert.equal(e.status, 'unsupported');
      assert.ok(e.missingFields.length > 0);
      assert.equal(e.rule, null);
      assert.equal(e.notify, null);
      assert.equal(e.recipientCount, 0);
    }
  }
  const newlyScanned = new Set(source.slice(offset).map((event) => event.id));
  assert.equal(
    totals.detected,
    events.filter((e) => newlyScanned.has(e.auditEventId) && e.status === 'detected').length
  );
  assert.equal(
    totals.unsupported,
    events.filter((e) => newlyScanned.has(e.auditEventId) && e.status === 'unsupported').length
  );
  const notices = await f.trigger.readEventOutbox();
  assert.equal(
    notices.length,
    events.reduce((n, e) => n + e.recipientCount, 0)
  );
  assert.equal(new Set(notices.map((row) => row.requestId)).size, notices.length);
  return { source, events, notices, totals, progress };
}

function detected(
  events: Assessment[],
  source: AuditEvent,
  rule: 'R1' | 'R1d',
  notify: 'immediate' | 'daily',
  recipients: number
) {
  const event = events.find((row) => row.auditEventId === source.id);
  assert.ok(event);
  assert.equal(event.status, 'detected');
  assert.equal(event.rule, rule);
  assert.equal(event.notify, notify);
  assert.equal(event.recipientCount, recipients);
  assert.deepEqual(event.missingFields, []);
}
function assertR8(
  rows: Awaited<ReturnType<SecurityTriggerStore['readAlarms']>>,
  recipients: string[]
) {
  assert.deepEqual(rows.map((row) => row.recipientUserId).sort(), [...recipients].sort());
  for (const row of rows) {
    assert.equal(row.rule, 'R8');
    assert.equal(row.raised, false);
    assert.equal(row.key[0], 'gap');
    assert.deepEqual(row.occurrence, { kind: 'initial', n: 1 });
    assert.equal(
      row.requestId,
      securityRequestId({
        key: row.key,
        recipientUserId: row.recipientUserId,
        occurrence: row.occurrence,
      })
    );
  }
}

describe('N2 genuine native Core Audit assessment/outbox and durable compound progress', () => {
  it.each([{ daily: true }, { daily: false }])(
    'uses original distinct-User disable: responsible actor daily=$daily; exact source/recipient/cursor survives replay/reopen',
    async ({ daily }) => {
      const s = await server(),
        f = s.f;
      assert.ok(s.backup);
      const target = await signup(f, 'N2 disabled distinct User');
      await f.trigger.enable(s.admin);
      const source = await disable(f, daily ? s.admin : s.backup, target.actor.userId);
      if (daily)
        assert.equal(
          (await f.trigger.stop(s.admin)).state,
          'stopping',
          'authorized stopping still detects until original alarms complete'
        );
      const alarms = await f.trigger.readAlarms();
      const result = await scanAll(f);
      const notify = daily ? 'daily' : 'immediate';
      detected(result.events, source, 'R1d', notify, 1);
      assert.equal(result.totals.detected, 1);
      assert.deepEqual(result.notices.map(noticeProjection), [
        expectedNotice(source, s.admin.userId, 'R1d', notify),
      ]);
      assert.deepEqual(
        await f.trigger.readAlarms(),
        alarms,
        'event rows never mutate original R1/R8 alarm tuples'
      );
      const expected = structuredClone({
        events: result.events,
        notices: result.notices,
        progress: result.progress,
      });
      await f.reopen();
      assert.deepEqual(await f.trigger.readDetectionProgress(), expected.progress);
      assert.deepEqual(await assessments(f, 1), expected.events);
      assert.deepEqual(await f.trigger.readEventOutbox(), expected.notices);
      const entry = f.trace.checkpoint();
      assert.deepEqual(await f.trigger.detectAudit(), {
        cursor: expected.progress.cursor,
        scanned: 0,
        detected: 0,
        unsupported: 0,
      });
      f.trace.ack(entry);
      assert.deepEqual(await f.trigger.readEventOutbox(), expected.notices);
      assert.deepEqual(await f.trigger.readAlarms(), alarms);
    }
  );

  it('uses the full actual stopped-operator recovery/lock/envelope ceremony; one R1 yields ALL eligible actual administrators and derived initial identities', async () => {
    const s = await server(),
      f = s.f;
    assert.ok(s.backup);
    const recovered = await signup(f, 'N2 recovered different User');
    await f.trigger.enable(s.admin);
    await f.close();
    const outputRoot = mkdtempSync(join(tmpdir(), 'openkit-n2-owned-recovery-envelope-'));
    onTestFinished(() => rmSync(outputRoot, { recursive: true, force: true }));
    const output = join(outputRoot, 'issued-admin-token.json');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await runOpenKitOperatorCli([
      'admin',
      'recover-access',
      '--data-root',
      f.dataRoot,
      '--owner-user-id',
      recovered.actor.userId,
      '--expires-at',
      expiresAt,
      '--output',
      output,
      '--confirm',
      `issue-server-admin-token:${recovered.actor.userId}:${expiresAt}`,
    ]);
    assert.ok(statSync(output).isFile());
    assert.equal(
      statSync(output).mode & 0o777,
      0o600,
      'actual operator owner publishes its secure envelope; no hand credential or leaf Audit'
    );
    await f.reopen();
    const source = listServerAuditEvents(f.db).find(
      (e) => e.action === 'auth.admin-recovery.issue' && e.subject?.id === recovered.actor.userId
    );
    assert.ok(source);
    assert.equal(source.actor?.kind, 'system');
    assert.equal(source.actor?.id, 'openkit-operator');
    assert.equal(source.outcome, 'succeeded');
    const alarms = await f.trigger.readAlarms();
    const result = await scanAll(f);
    const recipients = [s.admin.userId, s.backup.userId, recovered.actor.userId];
    detected(result.events, source, 'R1', 'immediate', recipients.length);
    assert.equal(result.totals.detected, 1, 'one detected source, not one detection per recipient');
    assert.deepEqual(
      byRequest(result.notices.map(noticeProjection)),
      byRequest(recipients.map((id) => expectedNotice(source, id, 'R1', 'immediate')))
    );
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    await f.reopen();
    assert.deepEqual(await f.trigger.readDetectionProgress(), result.progress);
    assert.deepEqual(byRequest(await f.trigger.readEventOutbox()), byRequest(result.notices));
    const entry = f.trace.checkpoint();
    assert.deepEqual(await f.trigger.detectAudit(), {
      cursor: result.progress.cursor,
      scanned: 0,
      detected: 0,
      unsupported: 0,
    });
    f.trace.ack(entry);
    // Original operator's documented source clock, not Date/Worker mocking: a later REAL insert has an EARLIER original timestamp.
    assert.ok(result.progress.cursor);
    const lateClock = new Date(Date.parse(result.progress.cursor.createdAt) - 1);
    const lateExpiry = new Date(lateClock.getTime() + 60 * 60 * 1000).toISOString();
    const lateOutput = join(outputRoot, 'late-clock-issued-admin-token.json');
    const originalIds = new Set(result.source.map((event) => event.id));
    await f.close();
    await runOpenKitOperatorCli(
      [
        'admin',
        'recover-access',
        '--data-root',
        f.dataRoot,
        '--owner-user-id',
        recovered.actor.userId,
        '--expires-at',
        lateExpiry,
        '--output',
        lateOutput,
        '--confirm',
        `issue-server-admin-token:${recovered.actor.userId}:${lateExpiry}`,
      ],
      { now: () => new Date(lateClock.getTime()) }
    );
    assert.equal(statSync(lateOutput).mode & 0o777, 0o600);
    await f.reopen();
    const lateSource = listServerAuditEvents(f.db).find(
      (event) => !originalIds.has(event.id) && event.action === 'auth.admin-recovery.issue'
    );
    assert.ok(lateSource);
    assert.ok(lateSource.createdAt < result.progress.cursor.createdAt);
    const late = await scanAll(f, 1, result.progress);
    detected(late.events, lateSource, 'R1', 'immediate', recipients.length);
    assert.equal(late.totals.detected, 1);
    assert.deepEqual(
      late.progress.cursor,
      cursor(lateSource),
      'a public clock regression must not hide a later native append'
    );
    assert.deepEqual(
      byRequest(late.notices.map(noticeProjection)),
      byRequest([
        ...result.notices.map(noticeProjection),
        ...recipients.map((id) => expectedNotice(lateSource, id, 'R1', 'immediate')),
      ])
    );
    await f.reopen();
    assert.deepEqual(await f.trigger.readDetectionProgress(), late.progress);
    assert.deepEqual(await assessments(f, 1), late.events);
  });

  it('bounds native cursor windows by actual Core home, skips an opaque Workspace-linked unnamed Audit, never joins Workspace evidence, and diagnoses real Token issue without parsing history', async () => {
    const s = await server(),
      f = s.f;
    assert.ok(s.backupEmail);
    const store = new FsStore({ dataRoot: f.dataRoot });
    const workspaceApi = createWorkspaceOperationImplementations({
      coreDb: f.db,
      store,
      inflightCommands: new Map(),
    });
    const workspace = await workspaceApi['workspace.create'](
      { requestId: randomUUID(), name: 'N2 actual foreign evidence home' },
      context(s.admin, { kind: 'user' })
    );
    const linkedRequest = randomUUID();
    await sharing(f, store)['workspace.invitation-create'](
      { workspaceId: workspace.id, requestId: linkedRequest, inviteeEmail: s.backupEmail },
      context(s.admin, { kind: 'workspace', workspaceId: workspace.id })
    );
    const linked = listServerAuditEvents(f.db).find(
      (e) => e.requestId === linkedRequest && e.action === 'workspace.invitation.create'
    );
    assert.ok(linked);
    assert.equal(linked.workspaceId, workspace.id);
    assert.equal(NAMED.has(linked.action), false);
    const requestId = randomUUID();
    const catalog = createCatalogOperationImplementations({
      coreDb: f.db,
      dataRoot: f.dataRoot,
      store,
      inflightCommands: new Map(),
      repositoryWorkspaceDb: (id) => openWorkspaceDb(f.dataRoot, id),
    });
    await catalog['catalog.mcp-create'](
      {
        workspaceId: workspace.id,
        requestId,
        expectedRevision: loadWorkspaceResourceCatalog(f.dataRoot, workspace.id).revision,
        id: 'n2-workspace-only',
        displayName: 'N2 Workspace Audit witness',
        allowedTools: ['probe'],
        declaration: { kind: 'http', endpoint: 'https://fixture.example.invalid/mcp' },
      },
      context(s.admin, { kind: 'workspace', workspaceId: workspace.id })
    );
    const db = openWorkspaceDb(f.dataRoot, workspace.id);
    let workspaceAuditId: string;
    try {
      const event = listWorkspaceAuditEvents(db, workspace.id).find(
        (e) => e.requestId === requestId && e.action === 'catalog.mcp-create'
      );
      assert.ok(event);
      workspaceAuditId = event.id;
    } finally {
      db.sqlite.close();
    }
    const earlierAuditIds = new Set(listServerAuditEvents(f.db).map((event) => event.id));
    await f
      .tokens()
      ['token.create'](
        { scope: 'server-admin', workspaceIds: [], expiresAt: EXPIRY },
        context(s.admin)
      );
    const issuedAudits = listServerAuditEvents(f.db).filter(
      (event) => !earlierAuditIds.has(event.id) && event.action === 'auth.token.issue'
    );
    assert.equal(
      issuedAudits.length,
      1,
      'the actual issue producer owns this new source, without resource/summary/history parsing'
    );
    const tokenSource = issuedAudits[0]!;
    assert.ok(tokenSource.actor);
    await f.trigger.enable(s.admin);
    const result = await scanAll(f, 1);
    assert.ok(result.source.some((e) => e.id === linked.id));
    assert.equal(
      result.source.some((e) => e.id === workspaceAuditId),
      false
    );
    assert.equal(
      result.events.some(
        (e) => e.auditEventId === linked.id || e.auditEventId === workspaceAuditId
      ),
      false
    );
    const unsupported = result.events.find((e) => e.auditEventId === tokenSource.id);
    assert.ok(unsupported);
    assert.equal(unsupported.status, 'unsupported');
    assert.deepEqual(unsupported.missingFields, [
      'token-id',
      'scope',
      'owner',
      'principal',
      'expiry',
    ]);
    assert.deepEqual(unsupported.actor, tokenSource.actor);
    assert.equal(unsupported.rule, null);
    assert.equal(unsupported.notify, null);
    assert.equal(unsupported.recipientCount, 0);
    assert.equal(result.totals.detected, 0);
    assert.deepEqual(result.notices, []);
    await f.reopen();
    assert.deepEqual(await f.trigger.readDetectionProgress(), result.progress);
    assert.deepEqual(await assessments(f, 1), result.events);
  });

  it('first discovers real enabling-Token revocation in detectAudit: native R8 is ACKed before refusal and readonly progress never advances or repairs', async () => {
    const s = await server(),
      f = s.f;
    assert.ok(s.backup);
    await f.trigger.enable(s.admin);
    const before = await scanAll(f);
    await f.tokens()['token.revoke']({ tokenId: s.ownerTokenId }, context(s.backup));
    const entry = f.trace.checkpoint();
    await assert.rejects(() => f.trigger.detectAudit({ limit: 1 }));
    f.trace.ack(entry);
    const alarms = await f.trigger.readAlarms(); // BEFORE current(), which could independently discover/repair a loss.
    assertR8(alarms, [s.backup.userId]);
    assert.deepEqual(await f.trigger.readDetectionProgress(), before.progress);
    assert.deepEqual(await f.trigger.readEventOutbox(), before.notices);
    assert.equal((await f.trigger.current()).stoppingReason, 'lost-authority');
    await f.reopen();
    assert.deepEqual(await f.trigger.readDetectionProgress(), before.progress);
    assert.deepEqual(await f.trigger.readAlarms(), alarms);
    const again = f.trace.checkpoint();
    await assert.rejects(() => f.trigger.detectAudit());
    f.trace.ack(again);
    assert.deepEqual(
      await f.trigger.readAlarms(),
      alarms,
      'refusal/restart does not duplicate the original R8'
    );
  });

  it('uses actual last-administrator self-revocation: detect commits original zero-recipient failed R8 before any repairing current(), with no fake recipient or cursor advance', async () => {
    const s = await server(false),
      f = s.f;
    await f.trigger.enable(s.admin);
    await f.tokens()['token.revoke']({ tokenId: s.ownerTokenId }, context(s.admin));
    const entry = f.trace.checkpoint();
    await assert.rejects(() => f.trigger.detectAudit());
    f.trace.ack(entry);
    // Observational SELECT ONLY of the ORIGINAL N1 owner's durable failure tuple, before ANY facade read can mask a missing commit.
    // No SQL seed/delete/mutation, N2 private cursor query, new table/format or fake outcome is supplied.
    const failed = f.db.sqlite
      .prepare(
        'SELECT rule,recipient_count AS recipientCount,failure FROM security_trigger_alarms ORDER BY created_at,id'
      )
      .all();
    assert.deepEqual(failed, [
      { rule: 'R8', recipientCount: 0, failure: 'no-current-administrator' },
    ]);
    assert.deepEqual(await f.trigger.readDetectionProgress(), { cursor: null, assessed: 0 });
    assert.deepEqual(await f.trigger.readEventOutbox(), []);
    assert.deepEqual(await f.trigger.readAlarms(), []);
    const state = await f.trigger.current();
    assert.equal(state.state, 'stopping');
    assert.equal(state.failedOutcome, 'no-current-administrator');
    await f.reopen();
    assert.deepEqual(await f.trigger.readDetectionProgress(), { cursor: null, assessed: 0 });
    assert.equal((await f.trigger.current()).failedOutcome, 'no-current-administrator');
  });

  it('refuses off detection and invalid closed integer limits without a caller cursor/reset or durable progress change', async () => {
    const s = await server(false),
      f = s.f;
    const off = await f.trigger.readDetectionProgress();
    await assert.rejects(() => f.trigger.detectAudit());
    assert.deepEqual(await f.trigger.readDetectionProgress(), off);
    await f.trigger.enable(s.admin);
    const before = await f.trigger.readDetectionProgress();
    const notices = await f.trigger.readEventOutbox();
    for (const limit of [0, -1, 129, 1.5, Number.NaN]) {
      await assert.rejects(() => f.trigger.detectAudit({ limit }));
      await assert.rejects(() => f.trigger.readDetections({ limit }));
      assert.deepEqual(await f.trigger.readDetectionProgress(), before);
      assert.deepEqual(await f.trigger.readEventOutbox(), notices);
    }
  });
});
