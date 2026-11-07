// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, isRecord } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
} from '../auth/access-token.js';
import {
  ControlAccessTokenLifecycleResultSchema,
  ControlAccessTokenLifecycleSchema,
} from '../auth/access-token-lifecycle-codecs.js';
import { applyControlAccessTokenLifecycle } from '../auth/access-token-lifecycle-native.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { createWorkspaceOperationImplementations } from '../workspace-operation-implementations.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const fault = vi.hoisted(() => ({
  kind: '' as '' | 'revoke' | 'rotate',
  mode: '' as '' | 'ack' | 'request',
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  requests: [] as number[],
  auditPosts: 0,
  collisionId: undefined as string | undefined,
  inputFields: [] as string[],
}));

// The real Worker executes every mutation. Only actual frames/replies can be delayed;
// the collision is a deliberate failed-insertion fault, never a fabricated storage result.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message: unknown = args[0];
        if (isRecord(message) && isRecord(message.input)) {
          if (
            message.operation === 'standalone-audit' &&
            message.input.stage === `auth.token.${fault.kind}`
          )
            fault.auditPosts += 1;
          if (
            message.operation === 'access-token-lifecycle' &&
            message.input.kind === fault.kind &&
            typeof message.id === 'number'
          ) {
            fault.requests.push(message.id);
            fault.inputFields = Object.keys(message.input);
            fault.worker = this;
            if (fault.collisionId && isRecord(message.input.successor)) {
              args[0] = {
                ...message,
                input: {
                  ...message.input,
                  successor: { ...message.input.successor, tokenId: fault.collisionId },
                },
              };
            }
            if (fault.mode === 'request') {
              fault.release = () => super.postMessage(...args);
              fault.arrived?.();
              return;
            }
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
          reply.operation === 'access-token-lifecycle' &&
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

const kinds = ['revoke', 'rotate'] as const;

async function fixture(kind: (typeof kinds)[number]) {
  await shutdownControlStoreWorkerClient();
  fault.kind = '';
  fault.mode = '';
  fault.requests.length = 0;
  fault.auditPosts = 0;
  fault.release = undefined;
  fault.worker = undefined;
  fault.collisionId = undefined;
  fault.inputFields = [];
  const dataRoot = mkdtempSync(join(tmpdir(), 'token-crud-native-'));
  const coreDb = openCoreDb(dataRoot);
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    fault.kind = '';
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
    displayName: 'Mutation owner',
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
  const target = await operations['token.create'](
    { scope: 'server-admin', workspaceIds: [], expiresAt: '2099-12-31T00:00:00.000Z' },
    context
  );
  const before = listOpenKitAccessTokenRecords(coreDb);
  const action = `auth.token.${kind}`;
  const beforeHistory = listServerAuditEvents(coreDb).filter((event) => event.action === action);
  const invoke = (tokenId = target.record.tokenId) =>
    kind === 'revoke'
      ? operations['token.revoke']({ tokenId }, context)
      : operations['token.rotate']({ tokenId, graceSeconds: 60 }, context);
  const hold = (mode: '' | 'ack' | 'request' = 'ack') => {
    const arrived = new Promise<void>((resolve) => {
      fault.arrived = resolve;
    });
    fault.kind = kind;
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
    context,
    owner,
    target,
    before,
    action,
    beforeHistory,
    invoke,
    hold,
  };
}

function facts(coreDb: CoreDb): string {
  return createHash('sha256')
    .update(JSON.stringify(listOpenKitAccessTokenRecords(coreDb)))
    .digest('hex');
}

it.each(kinds)(
  'canonical mutation %s commits with Main readonly before its ACK and later Audit',
  async (kind) => {
    const f = await fixture(kind);
    f.coreDb.sqlite.pragma('query_only=ON');
    const held = f.hold();
    const reached = await Promise.race([
      held.arrived.then(() => true),
      held.result.then(() => false),
    ]);
    if (!reached) {
      const outcome = await held.result;
      const code = !outcome.ok && isRecord(outcome.error) ? outcome.error.code : 'early-success';
      expect(code).toBe('waiting-native-canonical-ack');
    }
    expect(reached).toBe(true);
    expect(held.published()).toBe(false);
    expect(fault.auditPosts).toBe(0);
    const cold = openCoreDb(f.dataRoot);
    try {
      const records = listOpenKitAccessTokenRecords(cold);
      expect(getOpenKitAccessTokenRecord(cold, f.target.record.tokenId)?.status).toBe(
        kind === 'revoke' ? 'revoked' : 'rotated'
      );
      expect(records.length).toBe(f.before.length + (kind === 'rotate' ? 1 : 0));
      if (kind === 'rotate') {
        const successor = records.find(
          (record) => record.predecessorTokenId === f.target.record.tokenId
        );
        expect(successor?.status).toBe('active');
        expect(successor?.ownerUserId).toBe(f.target.record.ownerUserId);
        expect(successor?.expiresAt).toBe(f.target.record.expiresAt);
      }
      expect(listServerAuditEvents(cold).filter((event) => event.action === f.action)).toEqual(
        f.beforeHistory
      );
    } finally {
      cold.sqlite.close();
    }
    fault.mode = '';
    fault.release?.();
    fault.release = undefined;
    const outcome = await held.result;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected fully acknowledged mutation.');
    expect(fault.requests.length).toBe(1);
    expect(fault.auditPosts).toBe(1);
    expect(fault.inputFields.includes('secret')).toBe(false);
    expect(Object.keys(outcome.value.record).includes('tokenHash')).toBe(false);
    if (kind === 'rotate') {
      expect('rotatedRecord' in outcome.value).toBe(true);
      if (!('token' in outcome.value) || typeof outcome.value.token !== 'string')
        throw new Error('Expected original one-time rotation result.');
      expect((await verifyOpenKitAccessTokenRecord(f.coreDb, outcome.value.token))?.tokenId).toBe(
        outcome.value.record.tokenId
      );
    } else {
      expect(await verifyOpenKitAccessTokenRecord(f.coreDb, f.target.token)).toBeNull();
    }
  }
);

it.each(kinds)(
  'losing canonical %s ACK cannot publish success, later Audit or a repost',
  async (kind) => {
    const f = await fixture(kind);
    const held = f.hold();
    expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
      true
    );
    fault.release = undefined;
    await fault.worker?.terminate();
    expect((await held.result).ok).toBe(false);
    expect(held.published()).toBe(false);
    expect(fault.requests.length).toBe(1);
    expect(fault.auditPosts).toBe(0);
    const cold = openCoreDb(f.dataRoot);
    try {
      expect(getOpenKitAccessTokenRecord(cold, f.target.record.tokenId)?.status).toBe(
        kind === 'revoke' ? 'revoked' : 'rotated'
      );
      expect(listOpenKitAccessTokenRecords(cold).length).toBe(
        f.before.length + (kind === 'rotate' ? 1 : 0)
      );
      expect(listServerAuditEvents(cold).filter((event) => event.action === f.action)).toEqual(
        f.beforeHistory
      );
    } finally {
      cold.sqlite.close();
    }
  }
);

it('failed successor insertion rolls back the whole original rotation tuple', async () => {
  const f = await fixture('rotate');
  const before = facts(f.coreDb);
  fault.collisionId = f.owner.record.tokenId;
  const held = f.hold('');
  expect((await held.result).ok).toBe(false);
  expect(fault.requests.length).toBe(1);
  expect(fault.auditPosts).toBe(0);
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(facts(cold)).toBe(before);
    expect(getOpenKitAccessTokenRecord(cold, f.target.record.tokenId)?.status).toBe('active');
  } finally {
    cold.sqlite.close();
  }
});

it('rotation returns its original mutation snapshot, not a fresh Main projection', async () => {
  const f = await fixture('rotate');
  const held = f.hold();
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  const cold = openCoreDb(f.dataRoot);
  try {
    const successor = listOpenKitAccessTokenRecords(cold).find(
      (record) => record.predecessorTokenId === f.target.record.tokenId
    );
    if (!successor) throw new Error('Expected committed successor.');
    // A real canonical concurrent stage after COMMIT, before delivery of the mutation reply.
    revokeOpenKitAccessTokenRecord(cold, successor.tokenId);
    expect(getOpenKitAccessTokenRecord(cold, successor.tokenId)?.status).toBe('revoked');
    fault.mode = '';
    fault.release?.();
    fault.release = undefined;
    const outcome = await held.result;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected original successful rotation snapshot.');
    expect(outcome.value.record.status).toBe('active');
  } finally {
    cold.sqlite.close();
  }
});

it.each(kinds)(
  'preserves the original %s missing-token404 and does not emit a later Audit',
  async (kind) => {
    const f = await fixture(kind);
    fault.kind = kind;
    await expect(f.invoke(allocateEntityId('tok'))).rejects.toMatchObject({ status: 404 });
    expect(fault.auditPosts).toBe(0);
  }
);

it('rotation rechecks a target revoked after Main preparation', async () => {
  const f = await fixture('rotate');
  const held = f.hold('request');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  revokeOpenKitAccessTokenRecord(f.coreDb, f.target.record.tokenId);
  const before = facts(f.coreDb);
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const outcome = await held.result;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('Expected original invalid-rotation refusal.');
  expect(isRecord(outcome.error) && outcome.error.status === 404).toBe(true);
  expect(facts(f.coreDb)).toBe(before);
  expect(fault.auditPosts).toBe(0);
});

it.each(kinds)(
  'unsupported retained target format refuses canonical %s without overwrite',
  async (kind) => {
    const f = await fixture(kind);
    f.coreDb.sqlite
      .prepare('UPDATE openkit_access_tokens SET schema_version = 2 WHERE token_id = ?')
      .run(f.target.record.tokenId);
    await expect(f.invoke()).rejects.toBeDefined();
    expect(
      f.coreDb.sqlite
        .prepare('SELECT schema_version, status FROM openkit_access_tokens WHERE token_id = ?')
        .get(f.target.record.tokenId)
    ).toEqual({ schema_version: 2, status: 'active' });
  }
);

it.each(['expired', 'rotated-with-grace'] as const)(
  'rotation preserves original404 for an existing %s target',
  async (state) => {
    const f = await fixture('rotate');
    let tokenId = f.target.record.tokenId;
    if (state === 'expired') {
      tokenId = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: f.target.record.ownerUserId,
        scope: 'server-admin',
        workspaceIds: [],
        now: new Date('2000-01-01T00:00:00.000Z'),
        expiresAt: '2001-01-01T00:00:00.000Z',
      }).record.tokenId;
    } else {
      await f.operations['token.rotate']({ tokenId, graceSeconds: 60 }, f.context);
      expect((await verifyOpenKitAccessTokenRecord(f.coreDb, f.target.token))?.tokenId).toBe(
        tokenId
      );
    }
    const before = facts(f.coreDb);
    fault.kind = 'rotate';
    await expect(f.invoke(tokenId)).rejects.toMatchObject({ status: 404 });
    expect(facts(f.coreDb)).toBe(before);
    expect(fault.auditPosts).toBe(0);
  }
);

it('a fresh repeated revoke preserves its original revocation timestamp and separate Audits', async () => {
  const f = await fixture('revoke');
  const first = await f.invoke();
  const second = await f.invoke();
  expect(first.record.revokedAt).not.toBeNull();
  expect(second.record.revokedAt).toBe(first.record.revokedAt);
  expect(listOpenKitAccessTokenRecords(f.coreDb).length).toBe(f.before.length);
  expect(listServerAuditEvents(f.coreDb).filter((event) => event.action === f.action).length).toBe(
    f.beforeHistory.length + 2
  );
});

it('prepared SQL owner keeps the original pair and returns no plaintext material', async () => {
  const f = await fixture('rotate');
  const secret = createOpenKitAccessTokenSecret();
  const successor = {
    tokenId: allocateEntityId('tok'),
    tokenHash: hashOpenKitAccessTokenSecret(secret),
  };
  const result = rotateOpenKitAccessTokenRecord(f.coreDb, f.target.record.tokenId, {
    graceSeconds: 60,
    successor,
  });
  expect(result?.record.tokenId).toBe(successor.tokenId);
  expect(result?.rotatedRecord.status).toBe('rotated');
  expect(Object.keys(result ?? {}).includes('secret')).toBe(false);
  expect((await verifyOpenKitAccessTokenRecord(f.coreDb, secret))?.tokenId).toBe(successor.tokenId);
});

it('prepared SQL owner rolls back predecessor update when successor insertion fails', async () => {
  const f = await fixture('rotate');
  const before = facts(f.coreDb);
  expect(() =>
    rotateOpenKitAccessTokenRecord(f.coreDb, f.target.record.tokenId, {
      graceSeconds: 60,
      successor: {
        tokenId: f.owner.record.tokenId,
        tokenHash: hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret()),
      },
    })
  ).toThrow();
  expect(facts(f.coreDb)).toBe(before);
});

it.each(['workspace', 'workspace-readonly'] as const)(
  'prepared SQL owner inherits the original %s owner, bindings and expiry',
  async (scope) => {
    const f = await fixture('rotate');
    const workspaces = createWorkspaceOperationImplementations({
      coreDb: f.coreDb,
      store: new FsStore({ dataRoot: f.dataRoot }),
      inflightCommands: new Map(),
    });
    const workspace = await workspaces['workspace.create'](
      { name: 'Scoped rotation fixture', requestId: randomUUID() },
      f.context
    );
    const target = await f.operations['token.create'](
      { scope, workspaceIds: [workspace.id], expiresAt: '2099-12-31T00:00:00.000Z' },
      f.context
    );
    const successor = {
      tokenId: allocateEntityId('tok'),
      tokenHash: hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret()),
    };
    const result = rotateOpenKitAccessTokenRecord(f.coreDb, target.record.tokenId, {
      graceSeconds: 60,
      successor,
    });
    for (const record of [result?.record, result?.rotatedRecord]) {
      expect(record?.ownerUserId).toBe(target.record.ownerUserId);
      expect(record?.scope).toBe(scope);
      expect(record?.workspaceIds).toEqual([workspace.id]);
      expect(record?.expiresAt).toBe(target.record.expiresAt);
    }
    expect(result?.record.predecessorTokenId).toBe(target.record.tokenId);
    expect(Object.keys(result ?? {}).includes('secret')).toBe(false);
  }
);

it('native leaf refuses application outside its covering Core transaction', async () => {
  const f = await fixture('revoke');
  const before = facts(f.coreDb);
  expect(() =>
    applyControlAccessTokenLifecycle(f.coreDb, { kind: 'revoke', tokenId: f.target.record.tokenId })
  ).toThrow();
  expect(facts(f.coreDb)).toBe(before);
});

it('closes mutation inputs and returns only original non-secret record snapshots', async () => {
  const f = await fixture('rotate');
  const successor = {
    tokenId: allocateEntityId('tok'),
    tokenHash: hashOpenKitAccessTokenSecret(f.target.token),
  };
  const input = { kind: 'rotate', tokenId: f.target.record.tokenId, graceSeconds: 60, successor };
  expect(ControlAccessTokenLifecycleSchema.safeParse(input).success).toBe(true);
  for (const bad of [
    { ...input, kind: 'issue' },
    { ...input, graceSeconds: -1 },
    { ...input, successor: { ...successor, secret: 'unexpected' } },
    { ...input, now: '2099-01-01T00:00:00.000Z' },
    { ...input, role: 'administrator' },
    { ...input, sql: 'unexpected' },
  ])
    expect(ControlAccessTokenLifecycleSchema.safeParse(bad).success).toBe(false);
  const result = {
    kind: 'rotate',
    value: {
      tokenId: f.target.record.tokenId,
      record: f.target.record,
      rotatedRecord: f.target.record,
    },
  };
  expect(ControlAccessTokenLifecycleResultSchema.safeParse(result).success).toBe(true);
  expect(
    ControlAccessTokenLifecycleResultSchema.safeParse({
      ...result,
      value: { ...result.value, secret: 'unexpected' },
    }).success
  ).toBe(false);
});
