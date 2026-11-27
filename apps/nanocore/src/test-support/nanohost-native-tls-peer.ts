/** Isolated native TLS peer for the NanoHost Rust transport regression. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { serve } from '@hono/node-server';
import { allocateEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.js';
import { registerNanoHostTransportAdmissionRoutes } from '../auth/nanohost-transport-admission.js';
import { createNanoHostTransportSessionAuthority } from '../auth/nanohost-transport-session.js';
import { createOpenKitAccessTokenSecret } from '../auth/nanohost-transport-token.js';
import { enrollNanoHostTransportIdentity } from '../auth/nanohost-transport-token-store.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionSemanticRoutes,
} from '../runtime/nanohost-session-dispatch.js';
import { openCoreDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createNanoHostCoreReads } from '../storage/nanohost-core-reads.js';
import { openAdmittedTestNanoHost } from './admitted-nanohost.js';

const root = process.argv[2];
assert(root, 'Rust fixture must supply an isolated temporary directory.');
const certificateRole = process.argv[3] ?? 'server';
assert(certificateRole === 'server' || certificateRole === 'ca-as-leaf');
const certFile = join(root, 'certificate.pem');
// Every attempt creates its own key and Token; neither is a retained fixture.
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=OpenKit Fixture CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-keyout',
    join(root, 'ca-key.pem'),
    '-out',
    join(root, 'ca.pem'),
  ],
  { stdio: 'pipe' }
);
execFileSync(
  'openssl',
  [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(root, 'key.pem'),
    '-out',
    join(root, 'server.csr'),
  ],
  { stdio: 'pipe' }
);
writeFileSync(
  join(root, 'extensions.cnf'),
  `basicConstraints=critical,CA:${certificateRole === 'ca-as-leaf' ? 'TRUE' : 'FALSE'}\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n`
);
execFileSync(
  'openssl',
  [
    'x509',
    '-req',
    '-in',
    join(root, 'server.csr'),
    '-CA',
    join(root, 'ca.pem'),
    '-CAkey',
    join(root, 'ca-key.pem'),
    '-set_serial',
    '2',
    '-days',
    '1',
    '-extfile',
    join(root, 'extensions.cnf'),
    '-out',
    certFile,
  ],
  { stdio: 'pipe' }
);
const coreDb = openCoreDb(root);
applyMigrations(coreDb);
const identityId = 'nanohost-a';
const { deploymentId } = readDataRootLayoutMarker(root);
const nanoHostConfig = { identityId, deploymentId };
const now = new Date();
const nativeStorage = await openAdmittedTestNanoHost(coreDb);
const { readTarget } = createNanoHostCoreReads(nativeStorage.value.owner);
const token = await enrollNanoHostTransportIdentity(nativeStorage.value, {
  deploymentId,
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  now,
  ownerNanoHostIdentityId: identityId,
  responsibleServerAdminActorId: 'fixture-admin',
  secret: createOpenKitAccessTokenSecret(),
  tokenId: allocateEntityId('nhtok'),
});
const authority = createNanoHostTransportSessionAuthority();
const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
const app = new Hono<{ Variables: AuthVariables }>();
let negotiatedProtocol: string | false = false;
let requestCount = 0;
let tokenPresentationCount = 0;
app.use('*', async (context, next) => {
  requestCount += 1;
  if (context.req.header('authorization') !== undefined) tokenPresentationCount += 1;
  await next();
});
app.use('/api/nanohost/transport/session/readiness', async (context, next) => {
  await next();
  const observed = readTarget(identityId);
  assert.equal(observed.state, 'ready');
  const target = observed.value;
  assert(target);
  assert.equal(context.res.status, 204);
  assert.equal(target?.ready, true);
  assert.equal(target?.physicalEpoch, 'a'.repeat(64));
  assert.equal(negotiatedProtocol, 'h2');
  assert(target.connectionGeneration > 0);
  process.stdout.write(
    `${JSON.stringify({ ready: target.ready, generation: target.connectionGeneration })}\n`
  );
});
registerNanoHostTransportAdmissionRoutes({
  app,
  coreDb,
  nativeStorage,
  sessionAuthority: authority,
});
registerNanoHostSessionSemanticRoutes({
  app,
  coreDb,
  dispatch,
  nanoHostConfig,
  nativeStorage,
});
// Use the same native server factory and TLS options as index.ts, without allowHTTP1.
const server = serve({
  createServer: createSecureServer,
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: 0,
  serverOptions: { cert: readFileSync(certFile), key: readFileSync(join(root, 'key.pem')) },
});
server.on('secureConnection', (socket) => {
  negotiatedProtocol = socket.alpnProtocol;
});
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
// Only the captured child pipe carries the attempt-local credential.
process.stdout.write(
  `${JSON.stringify({ port: address.port, deploymentId, secret: token.secret })}\n`
);
// An explicit post-attempt query observes absence without a guessed wait or retained secrets.
createInterface({ input: process.stdin }).on('line', (line) => {
  assert.equal(line, 'observe');
  const observed = readTarget(identityId);
  assert.equal(observed.state, 'ready');
  process.stdout.write(
    `${JSON.stringify({ requestCount, tokenPresentationCount, targetExists: observed.value !== null })}\n`
  );
});
