// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, isRecord } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import {
  createOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
  listOwnedServerAdminAccessTokens,
} from '../auth/access-token-store.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { createWorkspaceOperationImplementations } from '../workspace-operation-implementations.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_VERSION,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { ControlServerAdminTokenDefaultSchema } from './server-admin-token-default-codecs.js';

const fault = vi.hoisted(() => ({
  mode: '' as '' | 'ack' | 'request',
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  requests: [] as number[],
}));

// Only an actual native frame/reply is delayed. No storage result is fabricated.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message: unknown = args[0];
        if (isControlWorkerRequest(message) && message.operation === 'server-admin-token-default') {
          fault.requests.push(message.id);
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
        if (
          fault.mode === 'ack' &&
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'server-admin-token-default' &&
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

/** Real public Bootstrap/token owners; no raw SQL or invented retained record initializes state. */
async function fixture() {
  await shutdownControlStoreWorkerClient();
  fault.mode = '';
  fault.requests.length = 0;
  fault.release = undefined;
  fault.worker = undefined;
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-admin-default-native-'));
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
  const operations = createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
  const userId = allocateEntityId('usr');
  const owner = await operations['bootstrap.consume']({
    token: bootstrap.token,
    ownerUserId: userId,
    displayName: 'Default owner',
    email: [randomUUID(), 'example.test'].join('@'),
    password: randomUUID(),
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
  await operations['token.create'](
    { scope: 'server-admin', workspaceIds: [], expiresAt: '2099-12-31T00:00:00.000Z' },
    context
  );
  const before = await operations['token.my-admin-list']({}, context);
  const target = before.items.find((item) => item.tokenId !== before.defaultTokenId);
  if (!target) throw new Error('Expected a usable non-fallback selection.');
  const selection = { ownerUserId: userId, tokenId: target.tokenId };
  const invoke = (tokenId = target.tokenId) =>
    operations['token.my-admin-default']({ tokenId }, context);
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
    operations,
    owner,
    context,
    userId,
    target,
    before,
    selection,
    invoke,
    hold,
  };
}

function tokenFacts(coreDb: CoreDb): string {
  return createHash('sha256')
    .update(JSON.stringify(listOpenKitAccessTokenRecords(coreDb)))
    .digest('hex');
}

it('commits the native default with Main read-only and waits for its covering ACK', async () => {
  const f = await fixture();
  const facts = tokenFacts(f.coreDb);
  const history = listServerAuditEvents(f.coreDb).length;
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
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(listOwnedServerAdminAccessTokens(cold, f.userId).defaultTokenId).toBe(f.target.tokenId);
    expect(tokenFacts(cold)).toBe(facts);
    expect(listServerAuditEvents(cold).length).toBe(history);
  } finally {
    cold.sqlite.close();
  }
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const result = await held.result;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected acknowledged selection.');
  expect(result.value).toEqual({ ...f.before, defaultTokenId: f.target.tokenId });
  expect(result.value.items.every((item) => !Object.hasOwn(item, 'issuerRef'))).toBe(true);
  expect(Object.keys(result.value.items[0] ?? {}).includes('secretHash')).toBe(false);
  expect(fault.requests.length).toBe(1);
});

it('never reports success or reposts after losing the committed default ACK', async () => {
  const f = await fixture();
  const held = f.hold('ack');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  fault.release = undefined;
  await fault.worker?.terminate();
  expect((await held.result).ok).toBe(false);
  expect(held.published()).toBe(false);
  expect(fault.requests.length).toBe(1);
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(listOwnedServerAdminAccessTokens(cold, f.userId).defaultTokenId).toBe(f.target.tokenId);
  } finally {
    cold.sqlite.close();
  }
});

it.each([
  'unknown',
  'foreign-owner',
  'workspace',
  'readonly',
  'expired',
  'revoked',
  'rotated',
] as const)('retains the original public invalid-selection400 for %s', async (kind) => {
  const f = await fixture();
  let tokenId: string = allocateEntityId('tok');
  if (kind === 'foreign-owner') {
    const userId = allocateEntityId('usr');
    const now = new Date();
    await getControlStoreWorkerClient().betterAuth(`core:${f.coreDb.sqlite.name}`, {
      kind: 'human-create',
      requireBootstrap: false,
      record: {
        id: userId,
        displayName: 'Other owner',
        email: [randomUUID(), 'example.test'].join('@'),
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        kind: 'human',
        status: 'active',
      },
    });
    tokenId = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-12-31T00:00:00.000Z',
    }).record.tokenId;
  } else if (kind === 'workspace' || kind === 'readonly') {
    const workspaces = createWorkspaceOperationImplementations({
      coreDb: f.coreDb,
      store: new FsStore({ dataRoot: f.dataRoot }),
      inflightCommands: new Map(),
    });
    const workspace = await workspaces['workspace.create'](
      { name: 'Scoped token fixture', requestId: randomUUID() },
      f.context
    );
    tokenId = (
      await f.operations['token.create'](
        {
          scope: kind === 'workspace' ? 'workspace' : 'workspace-readonly',
          workspaceIds: [workspace.id],
          expiresAt: '2099-12-31T00:00:00.000Z',
        },
        f.context
      )
    ).record.tokenId;
  } else if (kind === 'expired') {
    tokenId = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2001-01-01T00:00:00.000Z',
      now: new Date('2000-01-01T00:00:00.000Z'),
    }).record.tokenId;
  } else if (kind === 'revoked') {
    await f.operations['token.revoke']({ tokenId: f.target.tokenId }, f.context);
    tokenId = f.target.tokenId;
  } else if (kind === 'rotated') {
    await f.operations['token.rotate']({ tokenId: f.target.tokenId, graceSeconds: 0 }, f.context);
    tokenId = f.target.tokenId;
  }
  await expect(f.invoke(tokenId)).rejects.toMatchObject({ status: 400 });
  expect(listOwnedServerAdminAccessTokens(f.coreDb, f.userId).defaultTokenId).not.toBe(tokenId);
});

it.each(['revoked', 'disabled'] as const)(
  'decides current %s facts after the selection is prepared',
  async (kind) => {
    const f = await fixture();
    const held = f.hold('request');
    expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
      true
    );
    if (kind === 'revoked') {
      await f.operations['token.revoke']({ tokenId: f.target.tokenId }, f.context);
    } else {
      // The actual User owner keeps disable, lifecycle Audit and receipt in its original Core tuple.
      const operations = createWorkspaceSharingOperationImplementations({
        coreDb: f.coreDb,
        store: new FsStore({ dataRoot: f.dataRoot }),
        inflightCommands: new Map(),
      });
      await operations['user.disable'](
        { targetUserId: f.userId, requestId: randomUUID() },
        f.context
      );
    }
    fault.mode = '';
    fault.release?.();
    fault.release = undefined;
    const result = await held.result;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected current eligibility refusal.');
    expect(isRecord(result.error) && result.error.status === 400).toBe(true);
    expect(held.published()).toBe(false);
  }
);

it('does not overwrite an unsupported future-version retained default', async () => {
  const f = await fixture();
  await f.invoke();
  // Deliberate corruption only after the real owner published the original retained record.
  const key = (
    f.coreDb.sqlite
      .prepare('SELECT key FROM server_settings WHERE json_extract(value, ?) = ?')
      .get('$.tokenId', f.target.tokenId) as { key: string }
  ).key;
  f.coreDb.sqlite.prepare('UPDATE server_settings SET schema_version = 2 WHERE key = ?').run(key);
  const retained = f.coreDb.sqlite
    .prepare('SELECT value, schema_version FROM server_settings WHERE key = ?')
    .get(key);
  await expect(f.invoke()).rejects.toBeDefined();
  expect(
    f.coreDb.sqlite
      .prepare('SELECT value, schema_version FROM server_settings WHERE key = ?')
      .get(key)
  ).toEqual(retained);
});

it('preserves original supported-v1 malformed-setting fallback and explicit repair', async () => {
  const f = await fixture();
  await f.invoke();
  const key = (
    f.coreDb.sqlite
      .prepare('SELECT key FROM server_settings WHERE json_extract(value, ?) = ?')
      .get('$.tokenId', f.target.tokenId) as { key: string }
  ).key;
  f.coreDb.sqlite.prepare('UPDATE server_settings SET value = ? WHERE key = ?').run('{', key);
  expect(listOwnedServerAdminAccessTokens(f.coreDb, f.userId).defaultTokenId).toBe(
    f.before.defaultTokenId
  );
  expect((await f.invoke()).defaultTokenId).toBe(f.target.tokenId);
  expect(
    f.coreDb.sqlite
      .prepare('SELECT value, schema_version FROM server_settings WHERE key = ?')
      .get(key)
  ).toEqual({ value: JSON.stringify({ tokenId: f.target.tokenId }), schema_version: 1 });
});

it('preserves an owned rotated predecessor as a valid default inside its original grace', async () => {
  const f = await fixture();
  await f.operations['token.rotate']({ tokenId: f.target.tokenId, graceSeconds: 60 }, f.context);
  expect((await f.invoke()).defaultTokenId).toBe(f.target.tokenId);
});

it('closes packet fields/results and refuses a different physical scope before posting', async () => {
  const f = await fixture();
  const packet = {
    version: CONTROL_WORKER_VERSION,
    id: 9001,
    operation: 'server-admin-token-default',
    database: 'core:fixture',
    input: f.selection,
  };
  expect(isControlWorkerRequest(packet)).toBe(true);
  for (const input of [
    { ...f.selection, ownerUserId: '' },
    { ...f.selection, tokenId: '' },
    { ...f.selection, workspaceId: allocateEntityId('ws') },
    { ...f.selection, role: 'administrator' },
    { ...f.selection, sql: 'unexpected' },
    { ...f.selection, secret: 'unexpected' },
  ]) {
    expect(ControlServerAdminTokenDefaultSchema.safeParse(input).success).toBe(false);
    expect(isControlWorkerRequest({ ...packet, input })).toBe(false);
  }
  const reply = {
    version: CONTROL_WORKER_VERSION,
    id: 9001,
    status: 'ok',
    operation: packet.operation,
  };
  expect(isControlWorkerReply({ ...reply, result: true })).toBe(true);
  expect(isControlWorkerReply({ ...reply, result: false })).toBe(true);
  for (const result of [null, {}, 'true', 1])
    expect(isControlWorkerReply({ ...reply, result })).toBe(false);
  const otherScope = { ...f.coreDb, scope: 'workspace' } as unknown as CoreDb;
  await expect(
    getControlStoreWorkerClient().serverAdminTokenDefault(otherScope, f.selection)
  ).rejects.toBeDefined();
  expect(fault.requests.length).toBe(0);
});
