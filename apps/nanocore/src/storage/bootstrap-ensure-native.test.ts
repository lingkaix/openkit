// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { isRecord } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
} from '../auth/access-token.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import {
  ControlBootstrapEnsureResultSchema,
  ControlBootstrapEnsureSchema,
} from '../auth/bootstrap-ensure-codecs.js';
import { applyControlBootstrapEnsure } from '../auth/bootstrap-ensure-native.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const fault = vi.hoisted(() => ({
  mode: '' as '' | 'ack' | 'request',
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  requestIds: [] as number[],
  inputFields: [] as string[],
  resultFields: [] as string[],
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const packet: unknown = args[0];
        if (
          isRecord(packet) &&
          packet.operation === 'bootstrap-ensure' &&
          typeof packet.id === 'number' &&
          isRecord(packet.input)
        ) {
          fault.requestIds.push(packet.id);
          fault.inputFields = Object.keys(packet.input);
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
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'bootstrap-ensure' &&
          fault.requestIds.includes(reply.id as number)
        ) {
          fault.resultFields = isRecord(reply.result) ? Object.keys(reply.result) : [];
          if (fault.mode === 'ack') {
            fault.release = () => super.emit(event, ...args);
            fault.arrived?.();
            return true;
          }
        }
        return super.emit(event, ...args);
      }
    },
  };
});

async function fixture() {
  await shutdownControlStoreWorkerClient();
  fault.mode = '';
  fault.release = undefined;
  fault.worker = undefined;
  fault.requestIds.length = 0;
  fault.inputFields = [];
  fault.resultFields = [];
  const dataRoot = mkdtempSync(join(tmpdir(), 'bootstrap-ensure-native-'));
  const coreDb = openCoreDb(dataRoot);
  const pending: Promise<unknown>[] = [];
  let emittedPath: string | undefined;
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
  const start = (mode: '' | 'ack' | 'request' = 'ack') => {
    const arrived = new Promise<void>((resolve) => {
      fault.arrived = resolve;
    });
    fault.mode = mode;
    let published = false;
    const result = Promise.resolve()
      .then(async () => {
        const issue = await ensureServerBootstrapTokenForStartup(coreDb);
        if (issue) emittedPath = writeServerBootstrapTokenEmission(dataRoot, issue).path;
        published = true;
        return issue;
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    pending.push(result);
    return { arrived, result, published: () => published };
  };
  return { dataRoot, coreDb, start, emittedPath: () => emittedPath };
}

function readSetting(db: ReturnType<typeof openCoreDb>) {
  const row = db.sqlite
    .prepare('SELECT value, schema_version AS schemaVersion FROM server_settings')
    .get() as { value: string; schemaVersion: number } | undefined;
  if (!row) return null;
  const value: unknown = JSON.parse(row.value);
  if (!isRecord(value)) throw new Error('Expected original Bootstrap setting object.');
  return { ...row, setting: value };
}
function settingDigest(db: ReturnType<typeof openCoreDb>) {
  return createHash('sha256')
    .update(JSON.stringify(readSetting(db)))
    .digest('hex');
}
function users(db: ReturnType<typeof openCoreDb>) {
  return (db.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
    .count;
}

it('startup ENSURE persists natively with Main readonly, awaiting covering ACK before file emission', async () => {
  const f = await fixture();
  expect(users(f.coreDb)).toBe(0);
  f.coreDb.sqlite.pragma('query_only=ON');
  const held = f.start();
  const reached = await Promise.race([
    held.arrived.then(() => true),
    held.result.then(() => false),
  ]);
  if (!reached) {
    const outcome = await held.result;
    const code = !outcome.ok && isRecord(outcome.error) ? outcome.error.code : 'early-success';
    expect(code).toBe('waiting-native-bootstrap-ack');
  }
  expect(reached).toBe(true);
  expect(held.published()).toBe(false);
  expect(f.emittedPath()).toBeUndefined();
  const cold = openCoreDb(f.dataRoot);
  let hash: unknown;
  let issuedAt: unknown;
  let expiresAt: unknown;
  try {
    const stored = readSetting(cold);
    expect(stored?.schemaVersion).toBe(1);
    expect(stored?.setting.consumedAt).toBeNull();
    expect(typeof stored?.setting.issuedAt).toBe('string');
    expect(typeof stored?.setting.expiresAt).toBe('string');
    hash = stored?.setting.tokenHash;
    issuedAt = stored?.setting.issuedAt;
    expiresAt = stored?.setting.expiresAt;
    expect(users(cold)).toBe(0);
  } finally {
    cold.sqlite.close();
  }
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const outcome = await held.result;
  expect(outcome.ok).toBe(true);
  if (!outcome.ok || !outcome.value) throw new Error('Expected acknowledged Bootstrap issuance.');
  expect(hashOpenKitAccessTokenSecret(outcome.value.token) === hash).toBe(true);
  expect(outcome.value.issuedAt === issuedAt).toBe(true);
  expect(outcome.value.expiresAt === expiresAt).toBe(true);
  expect(f.emittedPath() !== undefined && existsSync(f.emittedPath()!)).toBe(true);
  expect(fault.requestIds.length).toBe(1);
  expect(fault.inputFields).toEqual(['tokenHash']);
  expect(fault.resultFields.sort()).toEqual(['expiresAt', 'issuedAt']);
  expect(users(f.coreDb)).toBe(0);
});

it('lost committed ENSURE ACK cannot emit, publish a raw secret or automatically repost', async () => {
  const f = await fixture();
  const held = f.start();
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  fault.release = undefined;
  await fault.worker?.terminate();
  expect((await held.result).ok).toBe(false);
  expect(held.published()).toBe(false);
  expect(f.emittedPath()).toBeUndefined();
  expect(fault.requestIds.length).toBe(1);
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(readSetting(cold)?.setting.consumedAt).toBeNull();
    expect(users(cold)).toBe(0);
    // Existing valid pending state remains pending; lost ACK creates no recovery grant.
    expect(ensureServerBootstrapToken(cold)).toBeNull();
  } finally {
    cold.sqlite.close();
  }
});

it('existing valid pending setting is unchanged and emits no new secret', async () => {
  const f = await fixture();
  expect(ensureServerBootstrapToken(f.coreDb) !== null).toBe(true);
  const before = settingDigest(f.coreDb);
  const result = await f.start('').result;
  expect(result.ok && result.value === null).toBe(true);
  expect(settingDigest(f.coreDb)).toBe(before);
  expect(f.emittedPath()).toBeUndefined();
});

it('a canonical User suppresses ENSURE without creating a setting or implicit new User', async () => {
  const f = await fixture();
  ensureLocalUser(f.coreDb);
  const count = users(f.coreDb);
  expect(count).toBe(1);
  const result = await f.start('').result;
  expect(result.ok && result.value === null).toBe(true);
  expect(users(f.coreDb)).toBe(count);
  expect(readSetting(f.coreDb)).toBeNull();
  expect(f.emittedPath()).toBeUndefined();
});

it('native ENSURE rechecks a canonical User created after Main preparation', async () => {
  const f = await fixture();
  const held = f.start('request');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  ensureLocalUser(f.coreDb);
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const outcome = await held.result;
  expect(outcome.ok && outcome.value === null).toBe(true);
  expect(users(f.coreDb)).toBe(1);
  expect(readSetting(f.coreDb)).toBeNull();
  expect(f.emittedPath()).toBeUndefined();
});

it('native ENSURE rechecks a valid pending setting created after Main preparation', async () => {
  const f = await fixture();
  const held = f.start('request');
  expect(await Promise.race([held.arrived.then(() => true), held.result.then(() => false)])).toBe(
    true
  );
  expect(ensureServerBootstrapToken(f.coreDb) !== null).toBe(true);
  const before = settingDigest(f.coreDb);
  fault.mode = '';
  fault.release?.();
  fault.release = undefined;
  const outcome = await held.result;
  expect(outcome.ok && outcome.value === null).toBe(true);
  expect(settingDigest(f.coreDb)).toBe(before);
  expect(f.emittedPath()).toBeUndefined();
});

it('expired pending setting is reissued with the original TTL and unchanged empty-User phase', async () => {
  const f = await fixture();
  expect(
    ensureServerBootstrapToken(f.coreDb, {
      now: new Date('2000-01-01T00:00:00.000Z'),
      ttlMs: 1000,
    }) !== null
  ).toBe(true);
  const before = settingDigest(f.coreDb);
  const result = await f.start('').result;
  expect(result.ok && result.value !== null).toBe(true);
  expect(settingDigest(f.coreDb) === before).toBe(false);
  if (!result.ok || !result.value) throw new Error('Expected original expiry-driven reissue.');
  expect(Date.parse(result.value.expiresAt) - Date.parse(result.value.issuedAt)).toBe(86_400_000);
  expect(users(f.coreDb)).toBe(0);
});

it('unsupported retained setting version refuses without overwrite or file emission', async () => {
  const f = await fixture();
  expect(ensureServerBootstrapToken(f.coreDb) !== null).toBe(true);
  f.coreDb.sqlite.prepare('UPDATE server_settings SET schema_version = 2').run();
  const before = settingDigest(f.coreDb);
  expect((await f.start('').result).ok).toBe(false);
  expect(settingDigest(f.coreDb)).toBe(before);
  expect(f.emittedPath()).toBeUndefined();
});

it('separate emission failure retains committed pending ENSURE without rollback or repost', async () => {
  const f = await fixture();
  const expired = ensureServerBootstrapToken(f.coreDb, {
    now: new Date('2000-01-01T00:00:00.000Z'),
    ttlMs: 1000,
  });
  if (!expired) throw new Error('Expected original expired Bootstrap fixture.');
  const oldEmission = writeServerBootstrapTokenEmission(f.dataRoot, expired);
  const before = settingDigest(f.coreDb);
  // Existing destination is genuinely unwritable as a file, in this isolated original data root.
  rmSync(oldEmission.path);
  mkdirSync(oldEmission.path);
  const attempt = f.start('');
  expect((await attempt.result).ok).toBe(false);
  expect(attempt.published()).toBe(false);
  expect(f.emittedPath()).toBeUndefined();
  expect(fault.requestIds.length).toBe(1);
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(settingDigest(cold) === before).toBe(false);
    expect(readSetting(cold)?.setting.consumedAt).toBeNull();
    expect(ensureServerBootstrapToken(cold)).toBeNull();
    expect(users(cold)).toBe(0);
  } finally {
    cold.sqlite.close();
  }
});

it('prepared ENSURE owner preserves the original hash/metadata without a raw-secret result', async () => {
  const f = await fixture();
  const tokenHash = hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret());
  const issue = f.coreDb.sqlite.transaction(() =>
    applyControlBootstrapEnsure(f.coreDb, { tokenHash })
  )();
  expect(issue !== null).toBe(true);
  expect(Object.keys(issue ?? {}).sort()).toEqual(['expiresAt', 'issuedAt']);
  expect(readSetting(f.coreDb)?.setting.tokenHash === tokenHash).toBe(true);
  expect(users(f.coreDb)).toBe(0);
});

it('prepared ENSURE owner preserves the original valid-pending refusal', async () => {
  const f = await fixture();
  expect(ensureServerBootstrapToken(f.coreDb) !== null).toBe(true);
  const before = settingDigest(f.coreDb);
  const result = f.coreDb.sqlite.transaction(() =>
    applyControlBootstrapEnsure(f.coreDb, {
      tokenHash: hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret()),
    })
  )();
  expect(result).toBeNull();
  expect(settingDigest(f.coreDb)).toBe(before);
});

it('ENSURE native leaf refuses application outside the covering Core transaction', async () => {
  const f = await fixture();
  expect(() =>
    applyControlBootstrapEnsure(f.coreDb, {
      tokenHash: hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret()),
    })
  ).toThrow();
  expect(readSetting(f.coreDb)).toBeNull();
});

it('ENSURE codecs reject secret, clock, TTL, role and SQL fields', async () => {
  const input = { tokenHash: hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret()) };
  expect(ControlBootstrapEnsureSchema.safeParse(input).success).toBe(true);
  for (const extra of [
    { token: 'unexpected' },
    { now: '2099-01-01T00:00:00.000Z' },
    { ttlMs: 1 },
    { role: 'administrator' },
    { sql: 'unexpected' },
  ])
    expect(ControlBootstrapEnsureSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  const result = { issuedAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-02T00:00:00.000Z' };
  expect(ControlBootstrapEnsureResultSchema.safeParse(result).success).toBe(true);
  expect(ControlBootstrapEnsureResultSchema.safeParse(null).success).toBe(true);
  expect(
    ControlBootstrapEnsureResultSchema.safeParse({ ...result, token: 'unexpected' }).success
  ).toBe(false);
  expect(
    ControlBootstrapEnsureResultSchema.safeParse({ ...result, tokenHash: input.tokenHash }).success
  ).toBe(false);
});

it('malformed supported setting refuses without overwrite or file emission', async () => {
  const f = await fixture();
  expect(ensureServerBootstrapToken(f.coreDb) !== null).toBe(true);
  f.coreDb.sqlite.prepare("UPDATE server_settings SET value = '{}' ").run();
  const before = settingDigest(f.coreDb);
  expect((await f.start('').result).ok).toBe(false);
  expect(settingDigest(f.coreDb)).toBe(before);
  expect(f.emittedPath()).toBeUndefined();
});
