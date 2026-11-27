/** Native Core listener for the idle Harness App replacement regression. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Http2ServerRequest } from 'node:http2';
import { createInterface } from 'node:readline';
import { serve } from '@hono/node-server';
import { allocateEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.js';
import { registerNanoHostTransportAdmissionRoutes } from '../auth/nanohost-transport-admission.js';
import { createNanoHostTransportSessionAuthority } from '../auth/nanohost-transport-session.js';
import { createOpenKitAccessTokenSecret } from '../auth/nanohost-transport-token.js';
import { enrollNanoHostTransportIdentity } from '../auth/nanohost-transport-token-store.js';
import { createNanoHostHarnessRuntime } from '../runtime/nanohost-harness.js';
import { dispatchNanoHostHarnessOperation } from '../runtime/nanohost-harness-records.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from '../runtime/nanohost-session-dispatch.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openCoreReadDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createNanoHostCoreReads } from '../storage/nanohost-core-reads.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { openAdmittedTestNanoHost, reopenAdmittedTestNanoHost } from './admitted-nanohost.js';

const [root, successorPort] = process.argv.slice(2);
assert(root);
const coreDb = successorPort === undefined ? openCoreDb(root) : openCoreReadDb(root);
const identityId = 'nanohost-a';
const { deploymentId } = readDataRootLayoutMarker(root);
const nanoHostConfig = { identityId, deploymentId };
const now = new Date();
const releaseIdentity = { sourceCommit: 'a'.repeat(40), releaseTag: 'v0.1.0' };
if (successorPort === undefined) {
  applyMigrations(coreDb);
} else {
  const scope = nativeProductScope(root, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${scope.path}`,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
}
const nativeStorage =
  successorPort === undefined
    ? await openAdmittedTestNanoHost(coreDb)
    : await reopenAdmittedTestNanoHost(coreDb);
const { readTarget } = createNanoHostCoreReads(nativeStorage.value.owner);
const observeTarget = () => {
  const observed = readTarget(identityId);
  assert.equal(observed.state, 'ready');
  return observed.value;
};
let secret: string | undefined;
if (successorPort === undefined) {
  const token = await enrollNanoHostTransportIdentity(nativeStorage.value, {
    deploymentId,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    now,
    ownerNanoHostIdentityId: identityId,
    responsibleServerAdminActorId: 'fixture-admin',
    secret: createOpenKitAccessTokenSecret(),
    tokenId: allocateEntityId('nhtok'),
  });
  secret = token.secret;
} else {
  const restart = await transitionAdmittedNanoHostRuntimeTarget(nativeStorage.value, {
    kind: 'restart',
    observedAt: now.toISOString(),
  });
  assert.equal(restart.state, 'ready');
}

const emit = (observation: object) => process.stdout.write(`${JSON.stringify(observation)}\n`);
const authority = createNanoHostTransportSessionAuthority();
const pollCanDispatch = Promise.withResolvers<void>();
const closeCanPublish = Promise.withResolvers<void>();
const originalAdmit = authority.admit;
if (successorPort === undefined) {
  // Hold the real close publisher until the resident poll observes the shutdown boundary.
  authority.admit = (input) =>
    originalAdmit({
      ...input,
      onClose: async (closed) => {
        assert.equal(authority.mayCarryWork(input.physicalConnection), false);
        pollCanDispatch.resolve();
        await closeCanPublish.promise;
        await input.onClose?.(closed);
      },
    });
}

const app = new Hono<{ Variables: AuthVariables }>();
if (successorPort === undefined) {
  app.use('/api/nanohost/transport/session/readiness', async (context, next) => {
    await next();
    assert.equal(context.res.status, 204);
    const target = observeTarget();
    assert(target?.physicalEpoch);
    await createNanoHostHarnessRuntime(nativeStorage.value.owner, {
      adapterId: 'codex',
      adapterVersion: '0.166.0',
      harnessBindingRef: 'app-replacement-harness-binding',
      harnessCompatibilityKey: 'b'.repeat(64),
      harnessInstanceId: 'app-replacement-harness',
      imageDigest: `sha256:${'f'.repeat(64)}`,
      originPhysicalEpoch: target.physicalEpoch,
      sandboxBindingRef: 'app-replacement-sandbox-binding',
      sandboxCompatibilityKey: 'a'.repeat(64),
      sandboxIntegrationBindingRef: 'app-replacement-idle-sandbox',
      sandboxRuntimeId: 'app-replacement-sandbox',
      runtimeTargetId: identityId,
      timestamp: new Date().toISOString(),
    });
  });
}
let polls = 0;
app.use('/worker-control/harness/poll', async (context, next) => {
  const poll = ++polls;
  if (successorPort === undefined && poll === 2) {
    const incoming = (context.env as { incoming: Http2ServerRequest }).incoming;
    emit({ poll: 'in-flight' });
    await pollCanDispatch.promise;
    await next();
    emit({ poll: 'during-shutdown', streamDestroyed: incoming.stream.destroyed });
    return;
  }
  await next();
  // A second successor poll proves the same shim received the first reply.
  if (poll === (successorPort === undefined ? 1 : 2)) {
    assert.equal(context.res.status, 204, 'the resident Harness has no queued work');
    const target = observeTarget();
    assert(target?.ready);
    emit({
      generation: target.connectionGeneration,
      epoch: target.physicalEpoch,
      predecessorFenced: target.predecessorFenced,
    });
  }
});
registerNanoHostTransportAdmissionRoutes({
  app,
  coreDb,
  nativeStorage,
  sessionAuthority: authority,
});
const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
registerNanoHostSessionEffectRoutes({ app, dispatch });
registerNanoHostSessionSemanticRoutes({
  app,
  coreDb,
  dispatch,
  nanoHostConfig,
  nativeStorage,
  nativeHarnessLifecycle: {
    async dispatch(query) {
      // This fixture carries only idle polls. Use the original binding and queue
      // lookup on the admitted reader, which refuses any actual dispatch write.
      const observed = nativeStorage.value.owner.read((sqlite) =>
        dispatchNanoHostHarnessOperation(coreDb, query, { owner: { sqlite } })
      );
      assert.equal(observed.state, 'ready');
      assert.equal(observed.value, null, 'the resident Harness has no queued work');
      return observed.value;
    },
    async settle() {
      throw new Error('The idle Harness fixture does not settle operations.');
    },
  },
  releaseIdentity,
});
const server = serve({
  createServer,
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: Number(successorPort ?? 0),
});
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');

const commands = createInterface({ input: process.stdin });
commands.on('line', (line) => {
  assert.equal(line, 'publish-close');
  closeCanPublish.resolve();
});
process.once('SIGTERM', async () => {
  const listenerClosed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await authority.closeAllPhysicalConnections();
  await listenerClosed;
  const target = observeTarget();
  assert(target);
  emit({ stopped: true, ready: target.ready, generation: target.connectionGeneration });
  coreDb.sqlite.close();
  await shutdownControlStoreWorkerClient();
  commands.close();
  process.stdin.destroy();
});
// The attempt-local credential is available only to the Rust caller's private pipe.
emit({ port: address.port, deploymentId, secret });
