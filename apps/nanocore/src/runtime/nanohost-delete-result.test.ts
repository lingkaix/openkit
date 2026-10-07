import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';
import {
  getWorkerBackendSession,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';

const sandboxId = 'nh-1111111111111111';
const backendSessionId = `${sandboxId}-2222222222222222`;
const leaseId = 'lease_backend_session';
const packageSnapshotId = 'aepsnap_backend_session';
const deletePath = '/api/nanohost/transport/effects/sandbox.delete';
const deleteInput = { backendSessionId, leaseId, packageSnapshotId, sandboxId };
// Fixed canonical input independently reproduces the existing factory's complete delete identity.
const requestId = createHash('sha256')
  .update(
    JSON.stringify({
      backendSessionId,
      input: deleteInput,
      leaseId,
      operation: 'sandbox.delete',
      packageSnapshotId,
    })
  )
  .digest('hex');
const retainedResult = { requestId, sandboxId, state: 'deleted' };

/** Composes real private routes, native connection admission, and durable scheduler/backend stores. */
async function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-delete-discard-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const target = {
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    targetId: 'nanohost-test',
  };
  let authority = createNanoHostTransportSessionAuthority();
  let dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
  let listener: ReturnType<typeof getRequestListener>;
  let physical: object | undefined;
  let generation = 0;
  let heldAcknowledgement: Promise<void> | undefined;
  let releaseAcknowledgement: (() => void) | undefined;
  let client: ReturnType<typeof connectHttp2>;
  const server = createHttp2Server((request, response) => {
    if (!physical) {
      physical = readNanoHostPhysicalConnectionContext(request)!;
      authority.admit({
        connectionGeneration: generation,
        identityId: target.identityId,
        physicalConnection: physical,
      });
    }
    void listener(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing delete fixture address.');
  const origin = `http://127.0.0.1:${address.port}`;
  /** Sends the exact JSON request through the production private endpoint. */
  const post = async (path: string, body: unknown, connection = client) => {
    const stream = connection.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
    });
    const response = once(stream, 'response');
    stream.end(JSON.stringify(body));
    const [headers] = await response;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { status: headers[':status'], body: Buffer.concat(chunks).toString() };
  };
  /** A fresh dispatcher and session authority model a new Core boot with empty process-local maps. */
  const boot = async () => {
    client?.destroy();
    releaseAcknowledgement?.();
    heldAcknowledgement = undefined;
    authority = createNanoHostTransportSessionAuthority();
    dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    physical = undefined;
    generation = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: new Date().toISOString(),
    }).connectionGeneration;
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use(`${deletePath}/result`, async (_context, next) => {
      await next();
      // Hold the real route response after admission so a physical close loses the acknowledgement.
      if (heldAcknowledgement) await heldAcknowledgement;
    });
    registerNanoHostSessionSemanticRoutes({ app, coreDb, dispatch, nanoHostConfig: target });
    registerNanoHostSessionEffectRoutes({ app, dispatch });
    listener = getRequestListener(app.fetch);
    client = connectHttp2(origin);
    expect(
      await post('/api/nanohost/transport/session/readiness', { physicalEpoch: 'a'.repeat(64) })
    ).toEqual({ status: 204, body: '' });
  };
  await boot();
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: 'user_local' },
    profileRef: 'profile_worker',
    queueEntryId: 'queue_backend_session',
    requestedAgentId: 'agent_codex_host',
    threadId: 'thread_backend_session',
    turnId: 'turn_backend_session',
    turnInput: 'Run worker',
    workspaceId: 'ws_demo',
    now: () => '2026-07-15T00:00:01.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: 'lease_backend_session',
    agentSessionId: 'as_backend_session',
    inputRef: 'aepsnap_backend_session',
    bindingRef: 'lease-binding:lease_backend_session',
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => '2026-07-15T00:00:02.000Z',
  });
  recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { kind: 'reference', imageRef: 'worker:test' },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: 'as_backend_session',
      backendKind: 'openshell',
      backendSessionId,
      deploymentId: target.deploymentId,
      packageSnapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${packageSnapshotId}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: 'thread_backend_session',
      turnId: 'turn_backend_session',
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-15T00:00:03.000Z',
    sandboxBindingRef: 'lease-binding:lease_backend_session',
  });
  /** Advances only the real existing backend lifecycle, without fabricating a result receipt. */
  const transition = (
    toState: 'cleanup-pending' | 'cleanup-failed' | 'physical-cleaned' | 'cleaned'
  ) => {
    const fromState = getWorkerBackendSession(coreDb, leaseId)!.state;
    transitionWorkerBackendSessionState(coreDb, { fromState, attemptId: leaseId, toState });
  };
  transition('cleanup-pending');
  return {
    boot,
    /** Admits a fresh physical Epoch without replacing the dispatcher's completed-result memory. */
    async successor(physicalEpoch: string) {
      authority.closePhysicalConnection(physical!);
      client.destroy();
      physical = undefined;
      generation = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: new Date().toISOString(),
      }).connectionGeneration;
      client = connectHttp2(origin);
      expect(await post('/api/nanohost/transport/session/readiness', { physicalEpoch })).toEqual({
        status: 204,
        body: '',
      });
    },
    /** Sends a real retained result while withholding its response until the predecessor closes. */
    sendDeleteWithLostAcknowledgement() {
      heldAcknowledgement = new Promise<void>((resolve) => {
        releaseAcknowledgement = resolve;
      });
      const stream = client.request({
        ':method': 'POST',
        ':path': `${deletePath}/result`,
        'content-type': 'application/json',
      });
      const headers: unknown[] = [];
      stream.on('response', (response) => {
        headers.push(response);
      });
      const closed = once(stream, 'close');
      stream.end(JSON.stringify(retainedResult));
      return { closed, headers };
    },
    coreDb,
    post,
    transition,
    get dispatch() {
      return dispatch;
    },
    get physical() {
      return physical!;
    },
    /** Uses a second, unadmitted native connection to exercise the real connection fence. */
    async wrongConnection() {
      const other = connectHttp2(origin);
      try {
        return await post(`${deletePath}/result`, retainedResult, other);
      } finally {
        other.destroy();
      }
    },
    async close() {
      client.destroy();
      releaseAcknowledgement?.();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('cleaned backend delete delivery discard', () => {
  it('discards a lost delete acknowledgement on a new Core boot without changing stores or blocking the next poll', async () => {
    const fixture = await createFixture();
    try {
      const pending = fixture.dispatch.effect({
        kind: 'sandbox.delete',
        input: deleteInput,
        requestId,
      });
      expect(await fixture.post(deletePath, {})).toEqual({
        status: 200,
        body: JSON.stringify({ ...deleteInput, requestId }),
      });
      const lostAcknowledgement = fixture.sendDeleteWithLostAcknowledgement();
      await expect(pending).resolves.toEqual({ sandboxId, state: 'deleted' });
      expect(lostAcknowledgement.headers).toEqual([]);
      fixture.transition('physical-cleaned');
      fixture.transition('cleaned');
      await fixture.boot();
      await lostAcknowledgement.closed;
      expect(lostAcknowledgement.headers).toEqual([]);
      const storedBefore = fixture.coreDb.sqlite.serialize();
      expect(
        await fixture.post(`${deletePath}/result`, { ...retainedResult, extra: true })
      ).toEqual({
        status: 204,
        body: '',
      });
      expect(fixture.coreDb.sqlite.serialize()).toEqual(storedBefore);
      expect(await fixture.post(deletePath, {})).toEqual({ status: 204, body: '' });
      // A new real command still owns the operation; discard introduced no pending expectation.
      const next = fixture.dispatch.effect({
        kind: 'sandbox.delete',
        input: deleteInput,
        requestId: 'd'.repeat(64),
      });
      expect((await fixture.post(deletePath, {})).status).toBe(200);
      expect(
        await fixture.post(`${deletePath}/result`, { ...retainedResult, requestId: 'd'.repeat(64) })
      ).toEqual({ status: 204, body: '' });
      await expect(next).resolves.toEqual({ sandboxId, state: 'deleted' });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { case: 'the same request', completedRequestId: requestId, successStatus: 409 },
    { case: 'another request', completedRequestId: 'b'.repeat(64), successStatus: 204 },
  ])('preserves an acknowledged delete failure when cleaned-row success answers $case', async ({
    completedRequestId,
    successStatus,
  }) => {
    const fixture = await createFixture();
    try {
      const pending = fixture.dispatch.effect({
        kind: 'sandbox.delete',
        input: deleteInput,
        requestId: completedRequestId,
      });
      const rejected = expect(pending).rejects.toThrow('effect_failed');
      expect((await fixture.post(deletePath, {})).status).toBe(200);
      const failure = { requestId: completedRequestId, failureCode: 'effect_failed' };
      expect(await fixture.post(`${deletePath}/result`, failure)).toEqual({
        status: 204,
        body: '',
      });
      await rejected;
      fixture.transition('cleanup-failed');
      await fixture.successor('c'.repeat(64));
      fixture.transition('cleanup-pending');
      fixture.transition('physical-cleaned');
      fixture.transition('cleaned');
      const before = fixture.coreDb.sqlite.serialize();
      expect((await fixture.post(`${deletePath}/result`, retainedResult)).status).toBe(
        successStatus
      );
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
      // The original failure remains the completed outcome and keeps its existing successor duplicate rules.
      expect(await fixture.post(`${deletePath}/result`, failure)).toEqual({
        status: 204,
        body: '',
      });
      expect((await fixture.post(`${deletePath}/result`, failure)).status).toBe(409);
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it('installs no completed receipt when discarding a cleaned-row result', async () => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      fixture.transition('cleaned');
      expect(await fixture.post(`${deletePath}/result`, retainedResult)).toEqual({
        status: 204,
        body: '',
      });
      fixture.coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET runtime_target_id = ? WHERE attempt_id = ?')
        .run('unavailable-correlation', leaseId);
      const before = fixture.coreDb.sqlite.serialize();
      expect((await fixture.post(`${deletePath}/result`, retainedResult)).status).toBe(409);
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it('permits correlated physical-cleaned delivery without treating it as prior dispatch or settlement', async () => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      await fixture.boot();
      const before = fixture.coreDb.sqlite.serialize();
      expect(await fixture.post(`${deletePath}/result`, retainedResult)).toEqual({
        status: 204,
        body: '',
      });
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
      expect(await fixture.post(deletePath, {})).toEqual({ status: 204, body: '' });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    'cleanup-pending',
    'cleanup-failed',
  ] as const)('rejects an unfinished %s row', async (state) => {
    const fixture = await createFixture();
    try {
      if (state === 'cleanup-failed') fixture.transition(state);
      await fixture.boot();
      const before = fixture.coreDb.sqlite.serialize();
      expect((await fixture.post(`${deletePath}/result`, retainedResult)).status).toBe(409);
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { sandboxId: 'nh-3333333333333333' },
    { state: 'absent' },
    { state: 'failed' },
    { requestId: 'f'.repeat(64) },
    { requestId: requestId.toUpperCase() },
    { failureCode: 'effect_failed' },
    { sandboxId: null },
  ])('rejects a malformed or uncorrelated retained result %j', async (change) => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      fixture.transition('cleaned');
      await fixture.boot();
      const before = fixture.coreDb.sqlite.serialize();
      expect(
        (await fixture.post(`${deletePath}/result`, { ...retainedResult, ...change })).status
      ).toBe(409);
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it('rejects wrong connections, operations, and foreign target or deployment lineage', async () => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      await fixture.boot();
      expect((await fixture.wrongConnection()).status).toBe(409);
      expect(
        (await fixture.post('/api/nanohost/transport/effects/bridge.close/result', retainedResult))
          .status
      ).toBe(409);
      for (const column of ['runtime_target_id', 'deployment_id']) {
        fixture.coreDb.sqlite
          .prepare(`UPDATE worker_backend_sessions SET ${column} = ? WHERE attempt_id = ?`)
          .run('foreign', leaseId);
        expect((await fixture.post(`${deletePath}/result`, retainedResult)).status).toBe(409);
        fixture.coreDb.sqlite
          .prepare(`UPDATE worker_backend_sessions SET ${column} = ? WHERE attempt_id = ?`)
          .run(column === 'runtime_target_id' ? 'nanohost-test' : 'deployment-test', leaseId);
      }
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ['backend_session_id', 'malformed'],
    ['backend_lineage_json', '{}'],
    ['package_snapshot_id', ''],
  ])('rejects unreadable or incomplete backend lineage %s', async (column, value) => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      fixture.coreDb.sqlite
        .prepare(`UPDATE worker_backend_sessions SET ${column} = ? WHERE attempt_id = ?`)
        .run(value, leaseId);
      const before = fixture.coreDb.sqlite.serialize();
      const body =
        column === 'package_snapshot_id'
          ? {
              ...retainedResult,
              requestId: createHash('sha256')
                .update(
                  JSON.stringify({
                    backendSessionId,
                    input: { ...deleteInput, packageSnapshotId: value },
                    leaseId,
                    operation: 'sandbox.delete',
                    packageSnapshotId: value,
                  })
                )
                .digest('hex'),
            }
          : retainedResult;
      expect((await fixture.post(`${deletePath}/result`, body)).status).toBe(409);
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it('keeps a contradictory live pending entry ahead of cleaned-row discard', async () => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      const pending = fixture.dispatch.effect({
        kind: 'sandbox.delete',
        input: deleteInput,
        requestId: 'b'.repeat(64),
      });
      expect((await fixture.post(deletePath, {})).status).toBe(200);
      expect((await fixture.post(`${deletePath}/result`, retainedResult)).status).toBe(400);
      expect(
        await fixture.post(`${deletePath}/result`, { ...retainedResult, requestId: 'b'.repeat(64) })
      ).toEqual({ status: 204, body: '' });
      await expect(pending).resolves.toEqual({ sandboxId, state: 'deleted' });
    } finally {
      await fixture.close();
    }
  });

  it('settles the existing result-only expectation instead of discarding its matching delivery', async () => {
    const fixture = await createFixture();
    try {
      fixture.transition('physical-cleaned');
      const pending = fixture.dispatch.expectResultOnly!([
        { kind: 'sandbox.delete', originPhysicalEpoch: 'a'.repeat(64), requestId },
      ]);
      expect(
        await fixture.post(`${deletePath}/result`, { ...retainedResult, extra: true })
      ).toEqual({
        status: 204,
        body: '',
      });
      await expect(pending).resolves.toEqual({
        kind: 'sandbox.delete',
        result: { sandboxId, state: 'deleted' },
      });
    } finally {
      await fixture.close();
    }
  });

  it('strips inert delete additions before pending delivery and completed replay identity', async () => {
    const fixture = await createFixture();
    try {
      const pending = fixture.dispatch.effect({
        kind: 'sandbox.delete',
        input: deleteInput,
        requestId,
      });
      expect((await fixture.post(deletePath, {})).status).toBe(200);
      expect(
        await fixture.post(`${deletePath}/result`, { ...retainedResult, extra: 'first' })
      ).toEqual({ status: 204, body: '' });
      await expect(pending).resolves.toEqual({ sandboxId, state: 'deleted' });
      const before = fixture.coreDb.sqlite.serialize();
      expect(
        await fixture.post(`${deletePath}/result`, { ...retainedResult, extra: 'replay' })
      ).toEqual({ status: 204, body: '' });
      expect(
        (await fixture.post(`${deletePath}/result`, { ...retainedResult, sandboxId: 'wrong' }))
          .status
      ).toBe(409);
      expect(fixture.coreDb.sqlite.serialize()).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { sandboxId: 'wrong' },
    { state: 'absent' },
    { sandboxId: undefined },
    { state: undefined },
  ])('validates delete success fields before resolving ordinary pending results %j', async (change) => {
    const fixture = await createFixture();
    try {
      const pending = fixture.dispatch.effect({
        kind: 'sandbox.delete',
        input: deleteInput,
        requestId,
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      expect((await fixture.post(deletePath, {})).status).toBe(200);
      expect(
        (await fixture.post(`${deletePath}/result`, { ...retainedResult, ...change })).status
      ).toBe(409);
      expect(settled).toBe(false);
      expect(await fixture.post(`${deletePath}/result`, retainedResult)).toEqual({
        status: 204,
        body: '',
      });
      await expect(pending).resolves.toEqual({ sandboxId, state: 'deleted' });
    } finally {
      await fixture.close();
    }
  });
});
