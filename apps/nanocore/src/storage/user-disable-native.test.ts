// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, isRecord, UserIdSchema } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import {
  createOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { applyControlUserDisable } from '../auth/user-disable-native.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';
import { getCommandRequestRecordFromDb } from './command-request-records.js';
import { isControlNativeReceiptCommand } from './control-store-admission-codecs.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { isControlWorkerRequest } from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  ControlCoreSharingResultSchema,
  ControlCoreSharingSchema,
} from './workspace-sharing-codecs.js';

const fault = vi.hoisted(() => ({
  mode: '' as '' | 'ack' | 'request',
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  replyUserId: undefined as string | undefined,
  requests: [] as number[],
  inputs: [] as unknown[],
}));

// Delay only a real frame/reply on the existing Core-sharing channel. No storage result is made up.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message: unknown = args[0];
        if (isControlWorkerRequest(message) && message.operation === 'core-sharing') {
          fault.requests.push(message.id);
          fault.inputs.push(structuredClone(message.input));
          fault.worker = this;
          if (fault.mode === 'request') {
            fault.release = () => super.postMessage(...args);
            fault.arrived?.();
            return;
          }
        }
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        // A separate wire-corruption case changes only the target in a real committed reply.
        if (
          fault.replyUserId &&
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'core-sharing' &&
          isRecord(reply.result) &&
          reply.result.kind === 'user' &&
          isRecord(reply.result.value)
        )
          reply.result.value.userId = fault.replyUserId;
        if (
          fault.mode === 'ack' &&
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'core-sharing' &&
          fault.requests.includes(reply.id as number)
        ) {
          fault.release = () => super.emit(event, ...args);
          fault.arrived?.();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

/** Original Bootstrap, public Token and real Better Auth sign-in producers on an isolated root. */
async function fixture(otherUser = false) {
  await shutdownControlStoreWorkerClient();
  fault.mode = '';
  fault.requests.length = 0;
  fault.inputs.length = 0;
  fault.replyUserId = undefined;
  fault.release = undefined;
  fault.worker = undefined;
  const dataRoot = mkdtempSync(join(tmpdir(), 'user-disable-native-'));
  const coreDb = openCoreDb(dataRoot);
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    fault.mode = '';
    fault.release?.();
    fault.release = undefined;
    await Promise.allSettled(pending);
    try {
      await shutdownControlStoreWorkerClient();
    } finally {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
  applyMigrations(coreDb);
  const bootstrap = ensureServerBootstrapToken(coreDb);
  if (!bootstrap) throw new Error('Expected fresh Bootstrap owner.');
  writeServerBootstrapTokenEmission(dataRoot, bootstrap);
  const tokenOperations = createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
  const actorUserId = allocateEntityId('usr');
  let userId = actorUserId;
  const email = [randomUUID(), 'example.test'].join('@');
  const password = randomUUID();
  const owner = await tokenOperations['bootstrap.consume']({
    token: bootstrap.token,
    ownerUserId: userId,
    displayName: 'Disable owner',
    email,
    password,
    tokenExpiresAt: '2099-12-31T00:00:00.000Z',
  });
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: {
      kind: 'token',
      userId,
      tokenId: owner.record.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
    },
    actorRef: { kind: 'user', id: userId },
    scope: { kind: 'server' },
  };
  await tokenOperations['token.create'](
    { scope: 'server-admin', workspaceIds: [], expiresAt: '2099-12-31T00:00:00.000Z' },
    context
  );
  const baseURL = 'http://127.0.0.1:3000';
  const auth = createBetterAuth(coreDb, {
    env: { BETTER_AUTH_SECRET: randomUUID() + randomUUID() },
    mode: 'server',
    openKitConfig: { server: { publicBaseUrl: baseURL } },
  });
  const signIn = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  );
  expect(signIn.status).toBe(200);
  const session = coreDb.sqlite
    .prepare('SELECT id FROM session WHERE user_id=? LIMIT 1')
    .get(actorUserId) as { id: string } | undefined;
  if (!session) throw new Error('Expected actual Better Auth session record.');
  const localContext: AdmittedOperationContext = {
    ...context,
    actor: { kind: 'local', userId: actorUserId },
  };
  const sessionContext: AdmittedOperationContext = {
    ...context,
    actor: {
      kind: 'session',
      userId: actorUserId,
      sessionId: session.id,
      adminTokenId: owner.record.tokenId,
    },
  };
  if (otherUser) {
    const created = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: [randomUUID(), 'example.test'].join('@'),
          name: 'Disable target',
          password: randomUUID(),
        }),
      })
    );
    expect(created.status).toBe(200);
    const body: unknown = await created.json();
    if (!isRecord(body) || !isRecord(body.user) || typeof body.user.id !== 'string')
      throw new Error('Expected canonical Better Auth target identity.');
    userId = UserIdSchema.parse(body.user.id) as typeof actorUserId;
    for (let index = 0; index < 2; index += 1)
      createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-12-31T00:00:00.000Z',
      });
  }
  const store = new FsStore({ dataRoot });
  let hookCalls = 0;
  let hookFailure = false;
  const operations = createWorkspaceSharingOperationImplementations({
    coreDb,
    store,
    inflightCommands: new Map(),
    afterUserDisabled: async () => {
      hookCalls += 1;
      if (hookFailure) throw new Error('Expected post-commit hook failure.');
    },
  });
  const requestId = randomUUID();
  const scope = { coreId: 'server', actorId: actorUserId, targetUserId: userId };
  const invoke = (
    id = requestId,
    targetUserId = userId,
    entry: AdmittedOperationContext = context
  ) => operations['user.disable']({ targetUserId, requestId: id }, entry);
  const facts = (db: CoreDb = coreDb) => ({
    user: db.sqlite
      .prepare('SELECT status, disabled_at AS disabledAt FROM users WHERE id = ?')
      .get(userId) as { status: string; disabledAt: string | null },
    sessions: (
      db.sqlite.prepare('SELECT COUNT(*) AS count FROM session WHERE user_id = ?').get(userId) as {
        count: number;
      }
    ).count,
    tokens: listOpenKitAccessTokenRecords(db)
      .filter((record) => record.ownerUserId === userId)
      .map(({ tokenId, status, revokedAt }) => ({
        tokenKey: createHash('sha256').update(tokenId).digest('hex'),
        status,
        revokedAt,
      })),
    audits: listServerAuditEvents(db)
      .filter((event) => event.action === 'user.disable' && event.resource === `user:${userId}`)
      .map(({ id, action, actor, subject, requestId, resource, permissionDecisionId }) => ({
        id,
        action,
        actor,
        subject,
        requestId,
        resource,
        permissionDecisionId,
      })),
    receipt: getCommandRequestRecordFromDb(
      db,
      commandRequestKey('user.disable', requestId, scope),
      new Date().toISOString()
    ),
  });
  const hold = (mode: 'ack' | 'request') => {
    const arrived = new Promise<void>((resolve) => {
      fault.arrived = resolve;
    });
    fault.mode = mode;
    let published = false;
    const result = Promise.resolve()
      .then(() => invoke())
      .then(
        (value) => {
          published = true;
          return { ok: true as const, value };
        },
        (error: unknown) => ({ ok: false as const, error })
      );
    pending.push(result);
    return { arrived, result, published: () => published };
  };
  return {
    coreDb,
    dataRoot,
    userId,
    actorUserId,
    actorTokenId: owner.record.tokenId,
    contexts: { local: localContext, session: sessionContext },
    tokenOperations,
    store,
    failHook: () => {
      hookFailure = true;
    },
    context,
    requestId,
    scope,
    invoke,
    facts,
    hold,
    hooks: () => hookCalls,
  };
}

it('commits the complete User session Token Audit receipt tuple with Main read-only before covering ACK', async () => {
  const f = await fixture();
  const before = f.facts();
  expect(before.user.status).toBe('active');
  expect(before.sessions).toBeGreaterThan(0);
  expect(before.tokens.length).toBeGreaterThan(1);
  expect(before.audits).toEqual([]);
  expect(before.receipt).toBeNull();
  f.coreDb.sqlite.pragma('query_only=ON');
  const held = f.hold('ack');
  const reached = await Promise.race([
    held.arrived.then(() => true),
    held.result.then(() => false),
  ]);
  if (!reached) {
    const outcome = await held.result;
    const code = !outcome.ok && isRecord(outcome.error) ? outcome.error.code : 'early-success';
    expect(code).toBe('waiting-native-ack');
  }
  expect(reached).toBe(true);
  expect(held.published()).toBe(false);
  expect(f.hooks()).toBe(0);
  const cold = openCoreDb(f.dataRoot);
  let committed: ReturnType<typeof f.facts>;
  try {
    committed = f.facts(cold);
    expect(committed.user.status).toBe('disabled');
    expect(committed.sessions).toBe(0);
    expect(committed.tokens.every((record) => record.status === 'revoked')).toBe(true);
    expect(committed.audits).toHaveLength(1);
    expect(committed.audits[0]).toMatchObject({
      actor: { kind: 'user', id: f.userId },
      subject: null,
      requestId: f.requestId,
      permissionDecisionId: null,
    });
    expect(committed.receipt?.response).toEqual({ kind: 'user', id: f.userId });
  } finally {
    cold.sqlite.close();
  }
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const result = await held.result;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected complete acknowledged disable.');
  expect(result.value).toEqual({ user: { ...committed.user, userId: f.userId } });
  expect(f.hooks()).toBe(1);
  expect(fault.requests).toHaveLength(1);
});

/** Reads only this test's isolated committed SQLite facts through a fresh connection. */
function coldFacts(f: Awaited<ReturnType<typeof fixture>>) {
  const db = openCoreDb(f.dataRoot);
  try {
    return f.facts(db);
  } finally {
    db.sqlite.close();
  }
}

it('keeps the full committed tuple after lost ACK without a hook, success or automatic repost', async () => {
  const f = await fixture(true);
  const held = f.hold('ack');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  const committed = coldFacts(f);
  expect(committed.user.status).toBe('disabled');
  expect(committed.sessions).toBe(0);
  expect(committed.tokens.every((record) => record.status === 'revoked')).toBe(true);
  expect(committed.audits).toHaveLength(1);
  expect(committed.audits[0]?.subject).toEqual({ kind: 'user', id: f.userId });
  expect(committed.receipt?.response).toEqual({ kind: 'user', id: f.userId });
  fault.release = undefined;
  await fault.worker?.terminate();
  expect((await held.result).ok).toBe(false);
  expect(held.published()).toBe(false);
  expect(f.hooks()).toBe(0);
  expect(fault.requests).toHaveLength(1);
  expect(coldFacts(f)).toEqual(committed);
  // The still-active actor explicitly retries the original receipt; there is no automatic resend.
  expect(await f.invoke()).toEqual({ user: { ...committed.user, userId: f.userId } });
  expect(fault.requests).toHaveLength(1);
  expect(f.hooks()).toBe(1);
});

it.each([
  ['audit_events', 'action'],
  ['idempotency_requests', 'command_name'],
] as const)(
  'rolls back User sessions Tokens Audit and receipt when the real %s insert fails',
  async (table, column) => {
    const f = await fixture(true);
    const before = coldFacts(f);
    // Deliberate SQLite fault on this scratch root, not a fabricated row, SQL owner or Worker result.
    f.coreDb.sqlite.exec(`CREATE TRIGGER fail_user_disable BEFORE INSERT ON ${table}
    WHEN NEW.${column}='user.disable' BEGIN SELECT RAISE(ABORT, 'user-disable-write-refusal'); END`);
    await expect(f.invoke()).rejects.toBeDefined();
    expect(coldFacts(f)).toEqual(before);
    expect(f.hooks()).toBe(0);
    expect(fault.requests).toHaveLength(1);
  }
);

it('does not roll back or repost the complete tuple when the later original hook fails', async () => {
  const f = await fixture(true);
  f.failHook();
  await expect(f.invoke()).rejects.toThrow('Expected post-commit hook failure.');
  const committed = coldFacts(f);
  expect(committed.user.status).toBe('disabled');
  expect(committed.sessions).toBe(0);
  expect(committed.tokens.every((record) => record.status === 'revoked')).toBe(true);
  expect(committed.audits).toHaveLength(1);
  expect(committed.receipt?.response).toEqual({ kind: 'user', id: f.userId });
  expect(f.hooks()).toBe(1);
  expect(fault.requests).toHaveLength(1);
});

it('keeps repeated disable timestamps and one conditional Audit while retaining each original receipt', async () => {
  const f = await fixture(true);
  const first = await f.invoke();
  const firstFacts = coldFacts(f);
  const secondId = randomUUID();
  expect(await f.invoke(secondId)).toEqual(first);
  const secondFacts = coldFacts(f);
  expect(secondFacts).toEqual(firstFacts);
  expect(
    getCommandRequestRecordFromDb(
      f.coreDb,
      commandRequestKey('user.disable', secondId, f.scope),
      new Date().toISOString()
    )?.response
  ).toEqual({ kind: 'user', id: f.userId });
  expect(f.hooks()).toBe(2);
  expect(fault.requests).toHaveLength(2);
  expect(await f.invoke()).toEqual(first);
  expect(coldFacts(f)).toEqual(firstFacts);
  expect(fault.requests).toHaveLength(2);
  expect(f.hooks()).toBe(3);
});

it('coalesces identical in-flight requests but preserves the original per-invocation hook', async () => {
  const f = await fixture(true);
  const held = f.hold('request');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  const second = f.invoke();
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const first = await held.result;
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('Expected acknowledged first invocation.');
  expect(await second).toEqual(first.value);
  expect(fault.requests).toHaveLength(1);
  expect(coldFacts(f).audits).toHaveLength(1);
  expect(f.hooks()).toBe(2);
});

it('rechecks current presented administrator Token facts after Main preparation', async () => {
  const f = await fixture(true);
  const before = coldFacts(f);
  const held = f.hold('request');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  await f.tokenOperations['token.revoke']({ tokenId: f.actorTokenId }, f.context);
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const result = await held.result;
  expect(result.ok).toBe(false);
  expect(coldFacts(f)).toEqual(before);
  expect(f.hooks()).toBe(0);
  expect(fault.requests).toHaveLength(1);
});

it('rechecks target disability inside the tuple and does not produce a second change Audit', async () => {
  const f = await fixture(true);
  const held = f.hold('request');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  fault.mode = '';
  const secondId = randomUUID();
  const second = await f.invoke(secondId);
  const committed = coldFacts(f);
  expect(committed.audits).toHaveLength(1);
  expect(committed.audits[0]?.requestId).toBe(secondId);
  fault.release?.();
  fault.release = undefined;
  const first = await held.result;
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('Expected acknowledged unchanged disability.');
  expect(first.value).toEqual(second);
  expect(coldFacts(f).audits).toEqual(committed.audits);
  expect(coldFacts(f).tokens).toEqual(committed.tokens);
  expect(coldFacts(f).receipt?.response).toEqual({ kind: 'user', id: f.userId });
  expect(f.hooks()).toBe(2);
});

it('fails closed on an actual lifecycle Audit whose original receipt was lost', async () => {
  const f = await fixture(true);
  await f.invoke();
  // Explicit retained corruption AFTER the actual canonical tuple producer committed.
  f.coreDb.sqlite
    .prepare('DELETE FROM idempotency_requests WHERE request_key=?')
    .run(commandRequestKey('user.disable', f.requestId, f.scope));
  const orphan = coldFacts(f);
  expect(orphan.receipt).toBeNull();
  await expect(f.invoke()).rejects.toMatchObject({ code: 'recovery_required' });
  expect(coldFacts(f)).toEqual(orphan);
  expect(f.hooks()).toBe(1);
});

it('keeps the original non-enumerating missing-target refusal without any tuple or hook', async () => {
  const f = await fixture(true);
  const before = coldFacts(f);
  await expect(f.invoke(randomUUID(), allocateEntityId('usr'))).rejects.toMatchObject({
    code: 'workspace_access_denied',
  });
  expect(coldFacts(f)).toEqual(before);
  expect(f.hooks()).toBe(0);
});

it('rejects a different target in an actual committed reply without a Main projection reread', async () => {
  const f = await fixture(true);
  fault.replyUserId = f.actorUserId;
  await expect(f.invoke()).rejects.toMatchObject({ code: 'recovery_required' });
  const committed = coldFacts(f);
  expect(committed.user.status).toBe('disabled');
  expect(committed.receipt?.response).toEqual({ kind: 'user', id: f.userId });
  expect(committed.audits).toHaveLength(1);
  expect(f.hooks()).toBe(0);
  expect(fault.requests).toHaveLength(1);
});

it('preserves unsupported retained receipt versions without overwrite or replayed effects', async () => {
  const f = await fixture(true);
  await f.invoke();
  const key = commandRequestKey('user.disable', f.requestId, f.scope);
  f.coreDb.sqlite
    .prepare('UPDATE idempotency_requests SET schema_version=99 WHERE request_key=?')
    .run(key);
  await expect(f.invoke()).rejects.toBeDefined();
  expect(
    f.coreDb.sqlite
      .prepare('SELECT schema_version AS version FROM idempotency_requests WHERE request_key=?')
      .get(key)
  ).toEqual({ version: 99 });
  expect(fault.requests).toHaveLength(1);
  expect(f.hooks()).toBe(1);
});

it('keeps expired native User receipts out of Main-owned pruning and prunes them only in native Core', async () => {
  const f = await fixture(true);
  await f.invoke();
  const key = commandRequestKey('user.disable', f.requestId, f.scope);
  // Age an already-produced real receipt, preserving its valid timestamp ordering and exact provenance.
  f.coreDb.sqlite
    .prepare('UPDATE idempotency_requests SET created_at=?, expires_at=? WHERE request_key=?')
    .run('2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', key);
  const count = () =>
    f.coreDb.sqlite
      .prepare('SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_key=?')
      .get(key);
  expect(count()).toEqual({ count: 1 });
  // A missing ordinary Main-owned lookup invokes its existing maintenance; it creates no fixture history.
  expect(
    f.store.getCommandRequest('workspace.retire-quarantined', randomUUID(), { coreId: 'server' })
  ).toBeNull();
  expect(count()).toEqual({ count: 1 });
  await f.invoke(randomUUID());
  expect(count()).toEqual({ count: 0 });
  expect(coldFacts(f).audits).toHaveLength(1);
});

it('keeps the closed User command and non-secret mutation reply shapes', async () => {
  const f = await fixture(true);
  const result = await f.invoke();
  const input = ControlCoreSharingSchema.parse(fault.inputs[0]);
  expect(input.command).toBe('user.disable');
  for (const key of ['secret', 'clock', 'role', 'sql']) {
    expect(ControlCoreSharingSchema.safeParse({ ...input, [key]: 'unexpected' }).success).toBe(
      false
    );
    expect(
      ControlCoreSharingSchema.safeParse({
        ...input,
        actor: { ...input.actor, [key]: 'unexpected' },
      }).success
    ).toBe(false);
    expect(
      ControlCoreSharingSchema.safeParse({
        ...input,
        request: { ...input.request, [key]: 'unexpected' },
      }).success
    ).toBe(false);
    expect(
      ControlCoreSharingResultSchema.safeParse({
        kind: 'user',
        value: { ...result.user, [key]: 'unexpected' },
      }).success
    ).toBe(false);
  }
  // Original public timestamp validation still occurs later; the private mutation snapshot adds no new retained format rule.
  expect(
    ControlCoreSharingResultSchema.safeParse({
      kind: 'user',
      value: { ...result.user, disabledAt: 'retained-non-ISO' },
    }).success
  ).toBe(true);
});

it('does not activate User-disable receipts for Workspace or User stores', () => {
  expect(isControlNativeReceiptCommand('user.disable', 'core')).toBe(true);
  expect(isControlNativeReceiptCommand('user.disable', 'workspace')).toBe(false);
  expect(isControlNativeReceiptCommand('user.disable', 'user')).toBe(false);
});

it('refuses the complete native tuple owner on a Main SQLite connection', async () => {
  const f = await fixture(true);
  await f.invoke();
  const input = ControlCoreSharingSchema.parse(fault.inputs[0]);
  if (input.command !== 'user.disable') throw new Error('Expected User-disable native input.');
  const before = coldFacts(f);
  expect(() => applyControlUserDisable(f.coreDb, input)).toThrow();
  expect(coldFacts(f)).toEqual(before);
});

it.each(['local', 'session'] as const)(
  'keeps the admitted %s credential form on the complete native User tuple',
  async (kind) => {
    const f = await fixture(true);
    const result = await f.invoke(f.requestId, f.userId, f.contexts[kind]);
    const committed = coldFacts(f);
    expect(result).toEqual({ user: { ...committed.user, userId: f.userId } });
    expect(committed.sessions).toBe(0);
    expect(committed.tokens.every((record) => record.status === 'revoked')).toBe(true);
    expect(committed.audits).toHaveLength(1);
    expect(committed.receipt?.response).toEqual({ kind: 'user', id: f.userId });
    expect(f.hooks()).toBe(1);
  }
);

it('refuses a real second Main Core connection with mismatched root metadata before any native frame or effect', async () => {
  const f = await fixture(true);
  const otherRoot = mkdtempSync(join(tmpdir(), 'user-disable-other-core-'));
  const other = openCoreDb(otherRoot);
  onTestFinished(() => {
    if (other.sqlite.open) other.sqlite.close();
    rmSync(otherRoot, { recursive: true, force: true });
  });
  applyMigrations(other);
  // Deliberate binding fault between two real Core databases, not fake SQL, history or an HTTP exploit.
  const misbound: CoreDb = { ...other, dataRoot: f.dataRoot };
  let hooks = 0;
  const operations = createWorkspaceSharingOperationImplementations({
    coreDb: misbound,
    store: f.store,
    inflightCommands: new Map(),
    afterUserDisabled: () => {
      hooks += 1;
    },
  });
  const before = coldFacts(f);
  await expect(
    operations['user.disable']({ targetUserId: f.userId, requestId: f.requestId }, f.context)
  ).rejects.toBeDefined();
  expect(fault.requests).toHaveLength(0);
  expect(coldFacts(f)).toEqual(before);
  expect(other.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });
  expect(other.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()).toEqual({
    count: 0,
  });
  expect(hooks).toBe(0);
});

it('does not infer session administrator authority from unpresented owned Tokens without its authenticated projection', async () => {
  const f = await fixture(true);
  if (f.contexts.session.actor.kind !== 'session') throw new Error('Expected real session actor.');
  const { adminTokenId: _projection, ...actor } = f.contexts.session.actor;
  const before = coldFacts(f);
  await expect(
    f.invoke(f.requestId, f.userId, { ...f.contexts.session, actor })
  ).rejects.toMatchObject({ code: 'deployment_admin_required' });
  expect(coldFacts(f)).toEqual(before);
  expect(f.hooks()).toBe(0);
});
