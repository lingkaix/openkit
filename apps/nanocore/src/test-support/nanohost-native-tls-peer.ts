/** Isolated native TLS peer for the NanoHost Rust transport regression. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.js';
import { registerNanoHostTransportAdmissionRoutes } from '../auth/nanohost-transport-admission.js';
import { createNanoHostTransportSessionAuthority } from '../auth/nanohost-transport-session.js';
import { createNanoHostTransportTokenRecord } from '../auth/nanohost-transport-token-store.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionSemanticRoutes,
} from '../runtime/nanohost-session-dispatch.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';

const root = process.argv[2];
assert(root, 'Rust fixture must supply an isolated temporary directory.');
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
  'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n'
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
const deploymentId = 'deployment-a';
const now = new Date();
coreDb.sqlite
  .prepare(`INSERT INTO nanohost_integration_identities
  (identity_id, deployment_id, status, created_at) VALUES (?, ?, 'active', ?)`)
  .run(identityId, deploymentId, now.toISOString());
const token = createNanoHostTransportTokenRecord(coreDb, {
  deploymentId,
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  now,
  ownerNanoHostIdentityId: identityId,
  responsibleServerAdminActorId: 'fixture-admin',
});
const authority = createNanoHostTransportSessionAuthority();
const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
const app = new Hono<{ Variables: AuthVariables }>();
let negotiatedProtocol: string | false = false;
app.use('/api/nanohost/transport/session/readiness', async (context, next) => {
  await next();
  const target = getNanoHostRuntimeTarget(coreDb, identityId);
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
registerNanoHostTransportAdmissionRoutes({ app, coreDb, sessionAuthority: authority });
registerNanoHostSessionSemanticRoutes({
  app,
  coreDb,
  dispatch,
  nanoHostConfig: { identityId, deploymentId },
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
process.stdout.write(`${JSON.stringify({ port: address.port, secret: token.secret })}\n`);
