import { once } from 'node:events';
import { connect, createServer } from 'node:http2';
import { allocateEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { createOpenKitAccessTokenSecret, hashOpenKitAccessTokenSecret } from './access-token.js';
import type { AuthVariables } from './middleware.js';
import {
  admitNativeNanoHostTransportConnection,
  registerNanoHostTransportAdmissionRoutes,
} from './nanohost-transport-admission.js';
import { fenceNanoHostTransportAuthority } from './nanohost-transport-lifecycle.js';
import transportRevision from './nanohost-transport-revision.json' with { type: 'json' };
import { createNanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import { revokeNanoHostTransportTokenRecord } from './nanohost-transport-token-store.js';

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
 * @param nanoHost Admitted fixture owner.
 * @returns Issued secret plus identity and deployment ids.
 */
async function issueTransportToken(
  nanoHost: ReturnType<typeof openNanoHostTestOwner>,
  clock = new Date('2026-08-08T00:00:00.000Z')
): Promise<{
  deploymentId: string;
  identityId: string;
  secret: string;
}> {
  const identityId = 'integration_nanohost_primary';
  const deploymentId = 'deploy_primary';
  const secret = createOpenKitAccessTokenSecret();
  await nanoHost.storage.owner.transport({
    kind: 'enroll',
    record: {
      tokenId: allocateEntityId('nhtok'),
      tokenHash: hashOpenKitAccessTokenSecret(secret),
      deploymentId,
      expiresAt: new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      now: clock,
      ownerNanoHostIdentityId: identityId,
      responsibleServerAdminActorId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    },
  });
  return { deploymentId, identityId, secret };
}

describe('NanoHost transport production admission', () => {
  it('reports an unavailable admitted owner without verifying a token or allocating a generation', async () => {
    const unavailable = {
      state: 'unavailable',
      owner: 'nanohost',
      reason: 'recovery-required',
    } as const;
    const owner = {
      read: vi.fn(() => unavailable),
      transport: vi.fn(),
      harnessLifecycle: vi.fn(),
      transitionRuntimeTarget: vi.fn(),
    };
    const kernel = {
      reserveHolderIntent: vi.fn(),
      fenceNanoHostEpoch: vi.fn(),
      inspectNanoHostEpochFence: vi.fn(),
    };
    const app = new Hono<{ Variables: AuthVariables }>();
    registerNanoHostTransportAdmissionRoutes({
      app,
      coreDb: undefined,
      nativeStorage: { state: 'ready', value: { owner, kernel } },
      sessionAuthority: createNanoHostTransportSessionAuthority(),
    });
    const response = await app.request('/api/nanohost/transport/session/admit', {
      method: 'POST',
      headers: { authorization: 'Bearer okt_fixture', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'nanohost_transport_storage_unavailable',
    });
    expect(owner.read).toHaveBeenCalledOnce();
    expect(owner.transport).not.toHaveBeenCalled();
    expect(owner.transitionRuntimeTarget).not.toHaveBeenCalled();
  });

  it('requires the shared transport revision before allocation and accepts a matching native admission, then refuses its revoked Token after reopen', async () => {
    const nanoHost = openNanoHostTestOwner();
    const token = await issueTransportToken(nanoHost, new Date());
    const authority = createNanoHostTransportSessionAuthority();
    const app = new Hono<{ Variables: AuthVariables }>();
    registerNanoHostTransportAdmissionRoutes({
      app,
      nativeStorage: { state: 'ready', value: nanoHost.storage },
      sessionAuthority: authority,
    });
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
      const unauthorized = await post({}, 'unsupported', 'okt_FAKE_e430');
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
        expect(getNanoHostRuntimeTarget(nanoHost, token.identityId)).toBeNull();
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
      const stored = getNanoHostRuntimeTarget(nanoHost, token.identityId);
      expect(stored).toMatchObject({ identityId: token.identityId, connectionGeneration: 1 });
      expect(JSON.stringify(stored)).not.toContain('ignored');
      expect(JSON.stringify(stored)).not.toContain('body-cannot-select');

      const tokenId = accepted.body.tokenId;
      if (typeof tokenId !== 'string') throw new Error('Expected the original transport Token ID.');
      const revokedAt = new Date();
      await expect(
        revokeNanoHostTransportTokenRecord(nanoHost.storage, tokenId, { now: revokedAt })
      ).resolves.toMatchObject({ tokenId, status: 'revoked' });
      await fenceNanoHostTransportAuthority(
        nanoHost.storage,
        authority,
        token.identityId,
        revokedAt.toISOString()
      );
      expect(authority.authoritativeGeneration(token.identityId)).toBeNull();
      await authority.closeAllPhysicalConnections();
      client.destroy();
      await nanoHost.reopen();

      client = connect(`http://127.0.0.1:${address.port}`);
      const stale = await post({});
      expect(stale.status).toBe(401);
      expect(stale.body).toMatchObject({ code: 'nanohost_transport_admission_unauthorized' });
      expect(authority.authoritativeGeneration(token.identityId)).toBeNull();
      expect(getNanoHostRuntimeTarget(nanoHost, token.identityId)).toMatchObject({
        connectionGeneration: 1,
        ready: false,
      });
    } finally {
      await authority.closeAllPhysicalConnections();
      client?.destroy();
      server.close();
      await once(server, 'close');
      await shutdownControlStoreWorkerClient();
    }
  });

  it('rejects unauthenticated or missing native connection context before allocation', async () => {
    const nanoHost = openNanoHostTestOwner();

    try {
      const { secret } = await issueTransportToken(nanoHost);
      const authority = createNanoHostTransportSessionAuthority();

      const denied = await admitNativeNanoHostTransportConnection(nanoHost.storage, authority, {
        transportRevision: String(transportRevision),
        physicalConnection: null as never,
        secret: 'okt_FAKE_e430',
        targetId: 'runtime-target-primary',
        now: new Date('2026-08-08T00:00:00.000Z'),
      });

      expect(denied).toEqual({ ok: false, reason: 'unauthorized' });
      expect(authority.authoritativeGeneration('integration_nanohost_primary')).toBeNull();
      expect(getNanoHostRuntimeTarget(nanoHost, 'runtime-target-primary')).toBeNull();

      const missingContext = await admitNativeNanoHostTransportConnection(
        nanoHost.storage,
        authority,
        {
          transportRevision: String(transportRevision),
          physicalConnection: null as never,
          secret,
          targetId: 'runtime-target-primary',
          now: new Date('2026-08-08T00:01:00.000Z'),
        }
      );
      expect(missingContext).toEqual({ ok: false, reason: 'missing_connection_context' });
      expect(getNanoHostRuntimeTarget(nanoHost, 'runtime-target-primary')).toBeNull();
    } finally {
      await shutdownControlStoreWorkerClient();
    }
  });
});
