/** Isolated native H2 authority for NanoHost Epoch outage regressions; never starts a runtime. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerHttp2Session } from 'node:http2';
import { createInterface } from 'node:readline';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.js';
import { registerNanoHostTransportAdmissionRoutes } from '../auth/nanohost-transport-admission.js';
import { createNanoHostTransportSessionAuthority } from '../auth/nanohost-transport-session.js';
import { createNanoHostTransportTokenRecord } from '../auth/nanohost-transport-token-store.js';
import { createNanoHostHarnessRuntime } from '../runtime/nanohost-harness-records.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from '../runtime/nanohost-session-dispatch.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';

const root = process.argv[2];
assert(root, 'Rust caller must supply an isolated temporary root.');
const identityId = 'nanohost-a';
const deploymentId = 'deployment-a';
const coreDb = openCoreDb(root);
applyMigrations(coreDb);
const now = new Date();
coreDb.sqlite
  .prepare(`INSERT INTO nanohost_integration_identities
  (identity_id, deployment_id, status, created_at) VALUES (?, ?, 'active', ?)`)
  .run(identityId, deploymentId, now.toISOString());
const token = createNanoHostTransportTokenRecord(coreDb, {
  deploymentId,
  // Authentication must outlive the real 300-second recovery observation, not decide its result.
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  now,
  ownerNanoHostIdentityId: identityId,
  responsibleServerAdminActorId: 'fixture-admin',
});
const sessionAuthority = createNanoHostTransportSessionAuthority();
const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority });
const app = new Hono<{ Variables: AuthVariables }>();
const polledPaths = new Map<number, Set<string>>();
const bindingRef = 'epoch-outage-integration';
let harnessDeclared = false;

/** Emits only value-free fixture observations, except the first captured-pipe credential. */
function emit(event: string, extra: Record<string, unknown> = {}): void {
  const target = getNanoHostRuntimeTarget(coreDb, identityId);
  process.stdout.write(
    `${JSON.stringify({
      event,
      ready: target?.ready ?? false,
      generation: target?.connectionGeneration ?? 0,
      physicalEpoch: target?.physicalEpoch ?? null,
      ...extra,
    })}\n`
  );
}

app.use('*', async (context, next) => {
  await next();
  if (context.res.status !== 204) return;
  if (context.req.path === '/api/nanohost/transport/session/readiness') {
    const target = getNanoHostRuntimeTarget(coreDb, identityId);
    assert(target?.ready && target.connectionGeneration > 0 && target.physicalEpoch);
    if (!harnessDeclared) {
      // Publish only synthetic metadata through its owner; no native launch or command is queued.
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: 'outage-fixture',
        harnessBindingRef: 'epoch-outage-harness-binding',
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: 'epoch-outage-harness',
        imageDigest: `sha256:${'c'.repeat(64)}`,
        originPhysicalEpoch: target.physicalEpoch,
        sandboxBindingRef: 'epoch-outage-sandbox-binding',
        sandboxCompatibilityKey: 'd'.repeat(64),
        sandboxIntegrationBindingRef: bindingRef,
        sandboxRuntimeId: 'epoch-outage-sandbox',
        runtimeTargetId: target.targetId,
        timestamp: new Date().toISOString(),
      });
      harnessDeclared = true;
    }
    emit('ready');
  } else if (
    context.req.path.startsWith('/api/nanohost/transport/effects/') &&
    !context.req.path.endsWith('/result') &&
    !context.req.path.endsWith('/input')
  ) {
    const target = getNanoHostRuntimeTarget(coreDb, identityId);
    assert(target?.ready, 'Effect polling must follow durable readiness.');
    const paths = polledPaths.get(target.connectionGeneration) ?? new Set<string>();
    const before = paths.size;
    paths.add(context.req.path);
    polledPaths.set(target.connectionGeneration, paths);
    // The initial/successor first-poll ambiguity window must end before fault injection.
    if (paths.size === 12 && before < 12) emit('poll-cycle');
  }
});
registerNanoHostTransportAdmissionRoutes({ app, coreDb, sessionAuthority });
registerNanoHostSessionEffectRoutes({ app, dispatch });
registerNanoHostSessionSemanticRoutes({
  app,
  coreDb,
  dispatch,
  nanoHostConfig: { identityId, deploymentId },
});
const server = serve({ createServer, fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
const sessions = new Set<ServerHttp2Session>();
server.on('session', (session: ServerHttp2Session) => {
  sessions.add(session);
  session.once('close', () => sessions.delete(session));
});
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
// The Rust parent captures this pipe; no raw credential reaches test logs or retained files.
emit('listening', { port, secret: token.secret, identityId, deploymentId, bindingRef });

for await (const command of createInterface({ input: process.stdin })) {
  if (command === 'outage') {
    const closed = once(server, 'close');
    const closingSessions = [...sessions];
    const physicalCloses = closingSessions.map((session) => once(session, 'close'));
    server.close();
    for (const session of closingSessions) session.destroy();
    // Server stop can precede H2 close observers; await the actual authority's physical event.
    await Promise.all([closed, ...physicalCloses]);
    assert.equal(getNanoHostRuntimeTarget(coreDb, identityId)?.ready, false);
    emit('outage');
  } else if (command === 'resume') {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    emit('resumed', { port });
  } else {
    assert.equal(command, 'observe', 'Only closed fixture commands are accepted.');
    emit('observation');
  }
}
server.close();
for (const session of sessions) session.destroy();
coreDb.sqlite.close();
