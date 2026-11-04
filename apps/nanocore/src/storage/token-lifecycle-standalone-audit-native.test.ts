// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, isRecord } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { listOpenKitAccessTokenRecords } from '../auth/access-token-store.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { isControlWorkerRequest } from './control-store-worker-protocol.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { ControlStandaloneAuditInputSchema } from './standalone-audit-codecs.js';

const fault = vi.hoisted(() => ({
  stage: '',
  held: undefined as (() => void) | undefined,
  arrived: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  requests: [] as Array<{ id: number; input: unknown }>,
}));

// Keep the actual native owner and its real committed reply. Only delivery of that
// one reply is held or lost; no storage result, SQL, history or ACK is fabricated.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message: unknown = args[0];
        if (
          isControlWorkerRequest(message) &&
          message.operation === 'standalone-audit' &&
          message.input.stage === fault.stage
        ) {
          fault.requests.push({ id: message.id, input: structuredClone(message.input) });
          fault.worker = this;
        }
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'standalone-audit' &&
          reply.result === null &&
          fault.requests.some((request) => request.id === reply.id) &&
          fault.stage
        ) {
          fault.held = () => {
            super.emit(event, ...args);
          };
          fault.arrived?.();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const stages = ['auth.token.issue', 'auth.token.revoke', 'auth.token.rotate'] as const;

/** Bootstrap and canonical token setup use their public owners, never raw SQL. */
async function fixture(stage: (typeof stages)[number]) {
  await shutdownControlStoreWorkerClient();
  fault.stage = '';
  fault.requests.length = 0;
  fault.held = undefined;
  fault.worker = undefined;
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-later-audit-'));
  const coreDb = openCoreDb(dataRoot);
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    fault.stage = '';
    fault.held?.();
    await Promise.allSettled(pending);
    try {
      await shutdownControlStoreWorkerClient();
    } finally {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
  applyMigrations(coreDb);
  const issued = ensureServerBootstrapToken(coreDb);
  if (!issued) throw new Error('Expected fresh isolated bootstrap');
  writeServerBootstrapTokenEmission(dataRoot, issued);
  const operations = createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
  const userId = allocateEntityId('usr');
  const owner = await operations['bootstrap.consume']({
    token: issued.token,
    ownerUserId: userId,
    displayName: 'Audit fixture owner',
    email: [randomUUID(), 'example.test'].join('@'),
    password: randomUUID(),
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
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
  const create = () =>
    operations['token.create'](
      { scope: 'server-admin', workspaceIds: [], expiresAt: '2099-01-01T00:00:00.000Z' },
      context
    );
  const predecessor = stage === 'auth.token.issue' ? undefined : await create();
  const before = listOpenKitAccessTokenRecords(coreDb);
  const beforeHistory = listServerAuditEvents(coreDb).filter((row) => row.action === stage);
  const invoke = () =>
    stage === 'auth.token.issue'
      ? create()
      : stage === 'auth.token.revoke'
        ? operations['token.revoke']({ tokenId: predecessor?.record.tokenId ?? '' }, context)
        : operations['token.rotate'](
            { tokenId: predecessor?.record.tokenId ?? '', graceSeconds: 60 },
            context
          );
  const arrived = new Promise<void>((resolve) => {
    fault.arrived = resolve;
  });
  fault.stage = stage;
  let published = false;
  const result = Promise.resolve()
    .then(invoke)
    .then(
      (value) => {
        published = true;
        return { ok: true as const, value };
      },
      () => ({ ok: false as const })
    );
  pending.push(result);
  return {
    coreDb,
    dataRoot,
    owner,
    context,
    predecessor,
    before,
    beforeHistory,
    arrived,
    result,
    published: () => published,
  };
}

it.each(
  stages
)('%s waits for the real covering ACK after its unchanged canonical mutation', async (stage) => {
  const f = await fixture(stage);
  const reached = await Promise.race([f.arrived.then(() => true), f.result.then(() => false)]);
  expect(reached).toBe(true);
  expect(f.published()).toBe(false);
  expect(fault.requests.length).toBe(1);
  const tokens = listOpenKitAccessTokenRecords(f.coreDb);
  if (stage === 'auth.token.issue') expect(tokens.length).toBe(f.before.length + 1);
  if (stage === 'auth.token.revoke')
    expect(tokens.find((row) => row.tokenId === f.predecessor?.record.tokenId)?.status).toBe(
      'revoked'
    );
  if (stage === 'auth.token.rotate') {
    expect(tokens.length).toBe(f.before.length + 1);
    expect(tokens.find((row) => row.tokenId === f.predecessor?.record.tokenId)?.status).toBe(
      'rotated'
    );
    expect(tokens.some((row) => row.predecessorTokenId === f.predecessor?.record.tokenId)).toBe(
      true
    );
  }
  const input = ControlStandaloneAuditInputSchema.parse(fault.requests[0]?.input);
  const event = input.event;
  expect(event.action).toBe(stage);
  expect(event.category).toBe('system');
  expect(event.outcome).toBe('succeeded');
  expect(event.severity).toBe('info');
  expect(event.actor?.kind === 'user' && event.actor.id === f.context.actor.userId).toBe(true);
  expect(event.authentication !== undefined).toBe(true);
  for (const key of [
    'workspaceId',
    'threadId',
    'turnId',
    'itemId',
    'capabilityCallId',
    'permissionDecisionId',
    'vaultGrantId',
    'requestId',
    'resourceRevision',
    'subject',
    'agentId',
    'agentSessionId',
  ] as const)
    expect(event[key]).toBe(null);
  expect(JSON.stringify(input).includes(f.owner.token)).toBe(false);
  expect('tokenHash' in event || 'token' in event).toBe(false);
  const misses = [
    { ...input, workspaceId: allocateEntityId('ws') },
    { ...input, stage: 'auth.token.other' },
    { ...input, event: { ...event, actor: null } },
    { ...input, event: { ...event, actor: { kind: 'system', id: 'server' } } },
    { ...input, event: { ...event, action: 'auth.bootstrap.consume' } },
    { ...input, event: { ...event, requestId: randomUUID() } },
    { ...input, event: { ...event, permissionDecisionId: randomUUID() } },
    { ...input, event: { ...event, resourceRevision: 1 } },
    { ...input, event: { ...event, resource: 'auth-token:' } },
    { ...input, event: { ...event, outcome: 'failed' } },
    { ...input, event: { ...event, token: 'must-not-cross' } },
  ];
  for (const miss of misses)
    expect(ControlStandaloneAuditInputSchema.safeParse(miss).success).toBe(false);
  fault.stage = '';
  fault.held?.();
  const result = await f.result;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(event.resource === `auth-token:${result.value.record.tokenId}`).toBe(true);
  if (stage !== 'auth.token.revoke') {
    const secret = 'token' in result.value ? result.value.token : undefined;
    expect(typeof secret).toBe('string');
    if (typeof secret === 'string') expect(JSON.stringify(input).includes(secret)).toBe(false);
  }
  const rows = listServerAuditEvents(f.coreDb).filter((row) => row.action === stage);
  expect(rows.length).toBe(f.beforeHistory.length + 1);
  expect(
    rows.some(
      (row) =>
        row.id === event.id &&
        row.summary === event.summary &&
        row.resource === event.resource &&
        row.createdAt === event.createdAt
    )
  ).toBe(true);
  await shutdownControlStoreWorkerClient();
  f.coreDb.sqlite.close();
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(listServerAuditEvents(cold).some((row) => row.id === event.id)).toBe(true);
    expect(listOpenKitAccessTokenRecords(cold).length).toBe(tokens.length);
  } finally {
    cold.sqlite.close();
  }
}, 30_000);

it.each(
  stages
)('%s does not report success or repost when its real committed ACK is lost', async (stage) => {
  const f = await fixture(stage);
  expect(await Promise.race([f.arrived.then(() => true), f.result.then(() => false)])).toBe(true);
  expect(f.published()).toBe(false);
  const count = fault.requests.length;
  fault.held = undefined;
  await fault.worker?.terminate();
  const result = await f.result;
  expect(result.ok).toBe(false);
  expect(fault.requests.length).toBe(count);
  fault.stage = '';
  await shutdownControlStoreWorkerClient();
  f.coreDb.sqlite.close();
  const cold = openCoreDb(f.dataRoot);
  try {
    expect(listServerAuditEvents(cold).filter((row) => row.action === stage).length).toBe(
      f.beforeHistory.length + 1
    );
    expect(fault.requests.length).toBe(count);
  } finally {
    cold.sqlite.close();
  }
}, 30_000);
