import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { connect, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import type { AuthVariables } from './middleware.js';
import {
  admitNanoHostTransportConnection,
  registerNanoHostTransportAdmissionRoutes,
} from './nanohost-transport-admission.js';
import transportRevision from './nanohost-transport-revision.json' with { type: 'json' };
import { createNanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import { createNanoHostTransportTokenRecord } from './nanohost-transport-token-store.js';

/**
 * WP-2b R2 red: production NanoHost transport admission consumes token verify
 * and session authority (`admit` / `fencePredecessor` / `mayCarryWork`) on a
 * real admission path (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * Prefer fail-on-absence: production admission helpers and routes must exist
 * and gate successor work until the predecessor is fenced.
 */

/**
 * Issues one active NanoHost transport Token for admission fixtures.
 *
 * @param coreDb Core database handles.
 * @returns Issued secret plus identity and deployment ids.
 */
function issueTransportToken(
  coreDb: CoreDb,
  clock = new Date('2026-08-08T00:00:00.000Z')
): {
  deploymentId: string;
  identityId: string;
  secret: string;
} {
  const identityId = 'integration_nanohost_primary';
  const deploymentId = 'deploy_primary';
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_integration_identities (
        identity_id, deployment_id, status, created_at
      ) VALUES (?, ?, 'active', ?)`
    )
    .run(identityId, deploymentId, '2026-08-08T00:00:00.000Z');
  const issued = createNanoHostTransportTokenRecord(coreDb, {
    deploymentId,
    expiresAt: new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
    now: clock,
    ownerNanoHostIdentityId: identityId,
    responsibleServerAdminActorId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
  });
  return { deploymentId, identityId, secret: issued.secret };
}

describe('NanoHost transport production admission', () => {
  it('requires the shared transport revision before allocation and accepts a matching native admission', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-admit-reader-')));
    applyMigrations(coreDb);
    const token = issueTransportToken(coreDb, new Date());
    const authority = createNanoHostTransportSessionAuthority();
    const app = new Hono<{ Variables: AuthVariables }>();
    registerNanoHostTransportAdmissionRoutes({ app, coreDb, sessionAuthority: authority });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await app.fetch(
        new Request('http://nano/api/nanohost/transport/session/admit', {
          method: 'POST',
          headers: {
            authorization: request.headers.authorization ?? '',
            'content-type': 'application/json',
            ...(typeof request.headers['x-openkit-nanohost-transport-revision'] === 'string'
              ? {
                  'x-openkit-nanohost-transport-revision':
                    request.headers['x-openkit-nanohost-transport-revision'],
                }
              : {}),
          },
          body: Buffer.concat(chunks),
        }),
        { incoming: request }
      );
      response
        .writeHead(result.status, Object.fromEntries(result.headers))
        .end(await result.text());
    });
    let client: ReturnType<typeof connect> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing native admission address.');
      client = connect(`http://127.0.0.1:${address.port}`);
      const post = async (
        body: unknown,
        revision: string | null = String(transportRevision),
        secret = token.secret
      ) => {
        const request = client!.request({
          ':method': 'POST',
          ':path': '/',
          authorization: `Bearer ${secret}`,
          ...(revision === null ? {} : { 'x-openkit-nanohost-transport-revision': revision }),
        });
        let status: unknown;
        let revisionEcho: unknown;
        request.on('response', (headers) => {
          status = headers[':status'];
          revisionEcho = headers['x-openkit-nanohost-transport-revision'];
        });
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.end(JSON.stringify(body));
        await once(request, 'end');
        return {
          status,
          revisionEcho,
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        };
      };
      for (const body of [null, [], 'invalid']) expect((await post(body)).status).toBe(400);
      const unauthorized = await post(
        {},
        'unsupported',
        'okt_not_a_real_nanohost_transport_token_aaaaaaaaaaaa'
      );
      expect(unauthorized.status).toBe(401);
      for (const revision of [
        null,
        String(transportRevision + 1),
        'unsupported',
        `${transportRevision}, ${transportRevision}`,
      ]) {
        const refused = await post({}, revision);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'nanohost_protocol_mismatch' });
        expect(getNanoHostRuntimeTarget(coreDb, token.identityId)).toBeNull();
        expect(authority.authoritativeGeneration(token.identityId)).toBeNull();
      }
      const accepted = await post({
        note: 'ignored',
        identityId: 'body-cannot-select',
        connectionGeneration: 99,
        mayCarryWork: false,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.revisionEcho).toBe(String(transportRevision));
      expect(accepted.body).toMatchObject({
        identityId: token.identityId,
        deploymentId: token.deploymentId,
        connectionGeneration: 1,
        role: 'authoritative',
        mayCarryWork: true,
      });
      expect(accepted.body).not.toHaveProperty('note');
      const stored = getNanoHostRuntimeTarget(coreDb, token.identityId);
      expect(stored).toMatchObject({ identityId: token.identityId, connectionGeneration: 1 });
      expect(JSON.stringify(stored)).not.toContain('ignored');
      expect(JSON.stringify(stored)).not.toContain('body-cannot-select');
    } finally {
      client?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });

  it('rejects unauthenticated or missing native connection context before allocation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-admit-bad-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const { secret } = issueTransportToken(coreDb);
      const authority = createNanoHostTransportSessionAuthority();

      const denied = admitNanoHostTransportConnection(coreDb, authority, {
        transportRevision: String(transportRevision),
        physicalConnection: null as never,
        secret: 'okt_not_a_real_nanohost_transport_token_aaaaaaaaaaaa',
        targetId: 'runtime-target-primary',
        now: new Date('2026-08-08T00:00:00.000Z'),
      });

      expect(denied).toEqual({ ok: false, reason: 'unauthorized' });
      expect(authority.authoritativeGeneration('integration_nanohost_primary')).toBeNull();
      expect(getNanoHostRuntimeTarget(coreDb, 'runtime-target-primary')).toBeNull();

      const missingContext = admitNanoHostTransportConnection(coreDb, authority, {
        transportRevision: String(transportRevision),
        physicalConnection: null as never,
        secret,
        targetId: 'runtime-target-primary',
        now: new Date('2026-08-08T00:01:00.000Z'),
      });
      expect(missingContext).toEqual({ ok: false, reason: 'missing_connection_context' });
      expect(getNanoHostRuntimeTarget(coreDb, 'runtime-target-primary')).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });
});
