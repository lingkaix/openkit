import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { listServerAuditEvents } from '../audit-events.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createOpenKitAccessTokenRecord } from './access-token-store.js';
import type { BetterAuthServer } from './middleware.js';
import { createNanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import {
  createNanoHostTransportTokenRecord,
  revokeNanoHostTransportTokenRecord,
  verifyNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/**
 * WP-2b R1 red: NanoHost enroll/issue/rotate App API safe-sink contract.
 *
 * Contract: Enrollment And One-Time Delivery — prove named slot write, return
 * only redacted metadata, fail closed when the sink write is unproved
 * (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 */

const OWNER_SESSION_HEADER = 'x-openkit-test-owner-session';

/** Creates a narrow Better Auth test double that recognizes only the explicit owner header. */
function ownerSessionAuth(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) =>
        headers.get(OWNER_SESSION_HEADER) === '1'
          ? {
              session: { id: 'session_owner' },
              user: { id: 'user_owner' },
            }
          : null,
    },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/**
 * Inserts the canonical owner user used by direct access-token fixtures.
 *
 * @param coreDb Core database handles.
 */
function insertTokenOwnerUser(coreDb: CoreDb): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO users (
        id,
        display_name,
        email,
        email_verified,
        image,
        created_at,
        updated_at,
        kind,
        last_seen_at
      )
       VALUES ('user_owner', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL)`
    )
    .run(now, now);
}

/** Builds the single configured NanoHost projection used by route-flow tests. */
function configuredNanoHost(slotRoot: string) {
  return {
    bind: { host: '127.0.0.1', port: 4318 },
    credentialRef: 'nanohost-transport:primary',
    credentialSlots: {
      A: {
        companionPath: join(slotRoot, 'A.meta'),
        secretPath: join(slotRoot, 'A.token'),
      },
      B: {
        companionPath: join(slotRoot, 'B.meta'),
        secretPath: join(slotRoot, 'B.token'),
      },
    },
    deploymentId: 'deploy_primary',
    identityId: 'integration_nanohost_primary',
    rendezvousUrl: 'https://nanocore.example:8443',
  };
}

describe('NanoHost transport App API safe-sink routes', () => {
  it('observes only the configured RuntimeTarget and preserves fail-closed boundaries', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-runtime-target-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-runtime-target-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const configuredApp = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: { nanohost: config },
      });
      const adminHeaders = { authorization: `Bearer ${admin.secret}` };

      for (const boundary of [
        {
          name: 'non-server',
          response: await createApp({
            mode: 'local',
            turnExecutor: new SimulatedTurnExecutor(),
          }).request('/api/app/nanohost/runtime-target'),
          status: 404,
        },
        {
          name: 'missing-storage',
          response: await createApp({
            auth: ownerSessionAuth(),
            mode: 'server',
            openKitConfig: { nanohost: config },
            turnExecutor: new SimulatedTurnExecutor(),
          }).request('/api/app/nanohost/runtime-target', {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }),
          status: 503,
        },
        {
          name: 'missing-config',
          response: await createApp({ auth: ownerSessionAuth(), coreDb, mode: 'server' }).request(
            '/api/app/nanohost/runtime-target',
            { headers: adminHeaders }
          ),
          status: 503,
        },
        {
          name: 'wrong-actor',
          response: await configuredApp.request('/api/app/nanohost/runtime-target', {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }),
          status: 403,
        },
        {
          name: 'absent-target',
          response: await configuredApp.request('/api/app/nanohost/runtime-target', {
            headers: adminHeaders,
          }),
          status: 404,
        },
      ]) {
        expect(boundary.response.status, boundary.name).toBe(boundary.status);
      }

      const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        targetId: config.identityId,
        identityId: config.identityId,
        deploymentId: config.deploymentId,
        observedAt: '2026-08-15T01:02:02.000Z',
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        targetId: config.identityId,
        identityId: config.identityId,
        deploymentId: config.deploymentId,
        connectionGeneration: allocated.connectionGeneration,
        predecessorFenced: true,
        ready: true,
        freshEmpty: true,
        observedAt: '2026-08-15T01:02:03.000Z',
      });

      const response = await configuredApp.request('/api/app/nanohost/runtime-target', {
        headers: adminHeaders,
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual({
        identityId: config.identityId,
        deploymentId: config.deploymentId,
        connectionGeneration: allocated.connectionGeneration,
        predecessorFenced: true,
        ready: true,
        freshEmpty: true,
        observedAt: '2026-08-15T01:02:03.000Z',
      });

      for (const mismatch of [
        {
          column: 'identity_id',
          name: 'identity-mismatch',
          value: 'integration_nanohost_stale',
        },
        { column: 'deployment_id', name: 'deployment-mismatch', value: 'deploy_stale' },
      ]) {
        coreDb.sqlite
          .prepare(`UPDATE nanohost_runtime_targets SET ${mismatch.column} = ?`)
          .run(mismatch.value);
        const mismatchResponse = await configuredApp.request('/api/app/nanohost/runtime-target', {
          headers: adminHeaders,
        });
        const mismatchBody = (await mismatchResponse.json()) as Record<string, unknown>;
        expect
          .soft(
            {
              code: mismatchBody.code,
              leakedMismatch: JSON.stringify(mismatchBody).includes(mismatch.value),
              status: mismatchResponse.status,
            },
            mismatch.name
          )
          .toEqual({
            code: 'nanohost_runtime_target_not_found',
            leakedMismatch: false,
            status: 404,
          });
        coreDb.sqlite
          .prepare(`UPDATE nanohost_runtime_targets SET ${mismatch.column} = ?`)
          .run(mismatch.column === 'identity_id' ? config.identityId : config.deploymentId);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('enrolls with a proved named-slot write and returns no raw okt_ secret', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-ok-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: { nanohost: configuredNanoHost(slotRoot) },
      });
      const sink = {
        secretPath: join(slotRoot, 'A.token'),
        companionPath: join(slotRoot, 'A.meta'),
      };

      const response = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body).not.toHaveProperty('token');
      expect(JSON.stringify(body)).not.toMatch(/okt_/);
      expect(body).toMatchObject({
        identityId: 'integration_nanohost_primary',
        deploymentId: 'deploy_primary',
        targetSlot: 'A',
        slotResult: { slot: 'A', status: 'written', issuanceGeneration: 1 },
      });
      expect(readFileSync(sink.secretPath, 'utf8')).toMatch(/^okt_/);
      expect(statSync(sink.secretPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(sink.companionPath, 'utf8')).toContain('issuance_generation=1');
      expect(statSync(sink.companionPath).mode & 0o777).toBe(0o600);
      expect(
        coreDb.sqlite
          .prepare('SELECT identity_id, deployment_id, status FROM nanohost_integration_identities')
          .all()
      ).toEqual([
        {
          deployment_id: 'deploy_primary',
          identity_id: 'integration_nanohost_primary',
          status: 'active',
        },
      ]);

      const duplicate = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      expect(duplicate.status).toBe(409);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('enroll refuses an occupied slot without overwriting it', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-occupied-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-occupied-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const occupiedSecret = 'okt_occupied_enroll_secret_aaaaaaaaaaaaaaaaaaaaaa';
      const occupiedCompanion = [
        'token_id=tok_occupied',
        'issuance_generation=1',
        'identity_id=integration_nanohost_primary',
        'deployment_id=deploy_primary',
        '',
      ].join('\n');
      writeFileSync(join(slotRoot, 'A.token'), occupiedSecret, { mode: 0o600 });
      writeFileSync(join(slotRoot, 'A.meta'), occupiedCompanion, { mode: 0o600 });
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: { nanohost: configuredNanoHost(slotRoot) },
      });
      const response = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(readFileSync(join(slotRoot, 'A.token'), 'utf8')).toBe(occupiedSecret);
      expect(readFileSync(join(slotRoot, 'A.meta'), 'utf8')).toBe(occupiedCompanion);
      expect(
        coreDb.sqlite.prepare('SELECT identity_id FROM nanohost_integration_identities').all()
      ).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed on enroll when the sink write is unproved and leaves no usable token', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-fail-'));
    const blocked = join(dataRoot, 'blocked-as-file');
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      writeFileSync(blocked, 'not-a-directory');
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: {
          nanohost: {
            ...configuredNanoHost(dataRoot),
            credentialSlots: {
              ...configuredNanoHost(dataRoot).credentialSlots,
              A: {
                secretPath: join(blocked, 'A.token'),
                companionPath: join(blocked, 'A.meta'),
              },
            },
          },
        },
      });

      const response = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      const rows = coreDb.sqlite
        .prepare('SELECT token_id, status FROM nanohost_transport_tokens')
        .all() as Array<{ status: string; token_id: string }>;

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(body)).not.toMatch(/okt_/);
      expect(body).not.toHaveProperty('token');
      for (const row of rows) {
        expect(row.status).not.toBe('active');
        const record = coreDb.sqlite
          .prepare('SELECT token_hash FROM nanohost_transport_tokens WHERE token_id = ?')
          .get(row.token_id) as { token_hash: string };
        // Hash-only row remains; verification of any secret must fail once revoked.
        expect(record.token_hash).toMatch(/^sha256:/);
      }
      expect(rows.every((row) => row.status === 'revoked') || rows.length === 0).toBe(true);
      expect(
        coreDb.sqlite.prepare('SELECT identity_id FROM nanohost_integration_identities').all()
      ).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('issues and rotates without returning raw okt_ and proves the declared slot write', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-issue-rotate-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-issue-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        nanohostTransportSessionAuthority: createNanoHostTransportSessionAuthority(),
        openKitConfig: { nanohost: configuredNanoHost(slotRoot) },
      });

      const enrolled = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      expect(enrolled.status).toBe(201);
      const enrollBody = (await enrolled.json()) as {
        record: { tokenId: string };
      };

      // Revoke the enrollment token so a later issue can create a fresh usable secret.
      await app.request(`/api/app/nanohost/tokens/${enrollBody.record.tokenId}/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${admin.secret}` },
      });

      const issueSink = {
        secretPath: join(slotRoot, 'A.token'),
        companionPath: join(slotRoot, 'A.meta'),
      };
      const issued = await app.request('/api/app/nanohost/tokens', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const issueBody = (await issued.json()) as Record<string, unknown> & {
        record: { tokenId: string };
        slotResult: { issuanceGeneration: number; slot: string; status: string };
      };

      expect(issued.status).toBe(201);
      expect(issueBody).not.toHaveProperty('token');
      expect(JSON.stringify(issueBody)).not.toMatch(/okt_/);
      expect(issueBody.slotResult).toMatchObject({
        slot: 'A',
        status: 'written',
      });
      expect(readFileSync(issueSink.secretPath, 'utf8')).toMatch(/^okt_/);
      const issuedSecret = readFileSync(issueSink.secretPath, 'utf8');
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, issuedSecret, {
          now: new Date('2026-08-08T00:00:00.000Z'),
        })?.tokenId
      ).toBe(issueBody.record.tokenId);

      const syntheticAdmission = await app.request('/api/nanohost/transport/session/admit', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issuedSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(syntheticAdmission.status).toBe(409);
      await expect(syntheticAdmission.json()).resolves.toMatchObject({
        code: 'nanohost_transport_admission_missing_connection_context',
      });

      const rotateSink = {
        secretPath: join(slotRoot, 'B.token'),
        companionPath: join(slotRoot, 'B.meta'),
      };
      const rotated = await app.request(
        `/api/app/nanohost/tokens/${issueBody.record.tokenId}/rotate`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${admin.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            overlapSeconds: 60,
          }),
        }
      );
      const rotateBody = (await rotated.json()) as Record<string, unknown>;

      expect(rotated.status).toBe(200);
      expect(rotateBody).not.toHaveProperty('token');
      expect(JSON.stringify(rotateBody)).not.toMatch(/okt_/);
      expect(rotateBody).toMatchObject({
        targetSlot: 'B',
        slotResult: { slot: 'B', status: 'written' },
      });
      expect(readFileSync(rotateSink.secretPath, 'utf8')).toMatch(/^okt_/);
      expect(statSync(rotateSink.secretPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(rotateSink.companionPath, 'utf8')).toContain('token_id=');

      const rotatedSecret = readFileSync(rotateSink.secretPath, 'utf8');
      const rotateTokenId = (rotateBody as { record: { tokenId: string } }).record.tokenId;
      const syntheticSuccessor = await app.request('/api/nanohost/transport/session/admit', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rotatedSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(syntheticSuccessor.status).toBe(409);
      expect(existsSync(issueSink.secretPath)).toBe(true);

      const abort = await app.request(`/api/app/nanohost/tokens/${rotateTokenId}/rotation/abort`, {
        method: 'POST',
        headers: { authorization: `Bearer ${admin.secret}` },
      });
      expect(abort.status).toBe(200);
      expect(existsSync(issueSink.secretPath)).toBe(true);
      expect(existsSync(rotateSink.secretPath)).toBe(false);

      const decommission = await app.request('/api/app/nanohost/decommission', {
        method: 'POST',
        headers: { authorization: `Bearer ${admin.secret}` },
      });
      expect(decommission.status).toBe(200);
      expect(existsSync(issueSink.secretPath)).toBe(false);
      expect(existsSync(rotateSink.secretPath)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records one redacted decommission audit event with identity, Token lineage, actor, deployment, result, and time', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-decommission-audit-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-decommission-audit-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        nanohostTransportSessionAuthority: createNanoHostTransportSessionAuthority(),
        openKitConfig: { nanohost: config },
      });
      const headers = {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      };
      const enrolled = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const enrolledBody = (await enrolled.json()) as { record: { tokenId: string } };
      expect(enrolled.status).toBe(201);
      const predecessorSlotSecret = readFileSync(config.credentialSlots.A.secretPath, 'utf8');

      const rotated = await app.request(
        `/api/app/nanohost/tokens/${enrolledBody.record.tokenId}/rotate`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ overlapSeconds: 60 }),
        }
      );
      const rotatedBody = (await rotated.json()) as {
        record: { predecessorTokenId: string | null; tokenId: string };
      };
      expect(rotated.status).toBe(200);
      expect(rotatedBody.record.predecessorTokenId).toBe(enrolledBody.record.tokenId);
      const successorSlotSecret = readFileSync(config.credentialSlots.B.secretPath, 'utf8');
      const revokePredecessor = await app.request(
        `/api/app/nanohost/tokens/${enrolledBody.record.tokenId}/revoke`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${admin.secret}` },
        }
      );
      expect(revokePredecessor.status).toBe(200);
      const retainedTokens = coreDb.sqlite
        .prepare(
          `SELECT token_id, predecessor_token_id, token_hash
           FROM nanohost_transport_tokens
           WHERE owner_nanohost_identity_id = ? AND deployment_id = ?
           ORDER BY token_id`
        )
        .all(config.identityId, config.deploymentId) as Array<{
        predecessor_token_id: string | null;
        token_hash: string;
        token_id: string;
      }>;
      expect(retainedTokens).toHaveLength(2);
      const foreignDeploymentToken = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: 'deploy_foreign',
        expiresAt: '2026-09-08T00:00:00.000Z',
        ownerNanoHostIdentityId: config.identityId,
        responsibleServerAdminActorId: 'user_owner',
      });
      const foreignIdentityToken = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: config.deploymentId,
        expiresAt: '2026-09-08T00:00:00.000Z',
        ownerNanoHostIdentityId: 'integration_nanohost_foreign',
        responsibleServerAdminActorId: 'user_owner',
      });
      expect(
        revokeNanoHostTransportTokenRecord(coreDb, foreignDeploymentToken.tokenId)?.status
      ).toBe('revoked');
      expect(revokeNanoHostTransportTokenRecord(coreDb, foreignIdentityToken.tokenId)?.status).toBe(
        'revoked'
      );
      const foreignTokenHashes = coreDb.sqlite
        .prepare(
          `SELECT token_hash
           FROM nanohost_transport_tokens
           WHERE token_id IN (?, ?)
           ORDER BY token_id`
        )
        .all(foreignDeploymentToken.tokenId, foreignIdentityToken.tokenId) as Array<{
        token_hash: string;
      }>;
      expect(foreignTokenHashes).toHaveLength(2);

      const decommission = await app.request('/api/app/nanohost/decommission', {
        method: 'POST',
        headers: { authorization: `Bearer ${admin.secret}` },
      });
      const decommissionBody = (await decommission.json()) as {
        identityId: string;
        revokedTokenCount: number;
        status: string;
      };
      expect(decommission.status).toBe(200);
      expect(decommissionBody).toEqual({
        identityId: config.identityId,
        revokedTokenCount: 1,
        status: 'decommissioned',
      });

      const decommissionEvents = listServerAuditEvents(coreDb).filter(
        (event) => event.action === 'nanohost.transport.decommission'
      );
      expect(decommissionEvents).toHaveLength(1);
      const event = decommissionEvents[0];
      expect(event).toMatchObject({
        action: 'nanohost.transport.decommission',
        actor: { kind: 'user', id: 'user_owner' },
        category: 'system',
        outcome: 'succeeded',
        resource: `nanohost-transport-identity:${config.identityId}`,
        severity: 'info',
        workspaceId: null,
      });
      expect(event?.summary).toContain(config.identityId);
      expect(event?.summary).toContain(config.deploymentId);
      expect(event?.summary).toContain('newly revoked 1');
      expect(event?.summary).toContain('retained lineage count=2');
      expect(event?.summary).not.toContain(foreignDeploymentToken.tokenId);
      expect(event?.summary).not.toContain(foreignIdentityToken.tokenId);
      for (const record of retainedTokens) {
        expect(event?.summary).toContain(
          `${record.token_id}<-${record.predecessor_token_id ?? 'root'}`
        );
      }
      expect(Number.isNaN(Date.parse(event?.occurredAt ?? ''))).toBe(false);

      const auditJson = JSON.stringify(decommissionEvents);
      const sensitiveValues = [
        predecessorSlotSecret,
        successorSlotSecret,
        admin.secret,
        foreignDeploymentToken.secret,
        foreignIdentityToken.secret,
        ...retainedTokens.flatMap((record) => [
          record.token_hash,
          record.token_hash.replace(/^sha256:/, ''),
        ]),
        ...foreignTokenHashes.flatMap((record) => [
          record.token_hash,
          record.token_hash.replace(/^sha256:/, ''),
        ]),
      ];
      expect(sensitiveValues.some((value) => auditJson.includes(value))).toBe(false);
      expect(auditJson).not.toContain(slotRoot);
      expect(existsSync(config.credentialSlots.A.secretPath)).toBe(false);
      expect(existsSync(config.credentialSlots.B.secretPath)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { failure: 'database' as const },
    { failure: 'second-slot-clear' as const },
  ])('does not record succeeded decommission audit when $failure fails', async ({ failure }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-nanohost-decommission-${failure}-`));
    const slotRoot = mkdtempSync(join(tmpdir(), `openkit-nanohost-decommission-${failure}-slots-`));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        nanohostTransportSessionAuthority: createNanoHostTransportSessionAuthority(),
        openKitConfig: { nanohost: config },
      });
      const headers = {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      };
      const enrolled = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      expect(enrolled.status).toBe(201);

      if (failure === 'database') {
        coreDb.sqlite.exec(
          `CREATE TRIGGER test_fail_nanohost_decommission
             BEFORE UPDATE OF status ON nanohost_transport_tokens
             WHEN NEW.status = 'revoked'
             BEGIN
               SELECT RAISE(ABORT, 'forced decommission database failure');
             END`
        );
      } else {
        mkdirSync(config.credentialSlots.B.secretPath);
      }

      const decommission = await app.request('/api/app/nanohost/decommission', {
        method: 'POST',
        headers: { authorization: `Bearer ${admin.secret}` },
      });
      expect(decommission.status).toBeGreaterThanOrEqual(400);
      expect(
        listServerAuditEvents(coreDb).filter(
          (event) =>
            event.action === 'nanohost.transport.decommission' && event.outcome === 'succeeded'
        )
      ).toEqual([]);

      const identity = coreDb.sqlite
        .prepare('SELECT status FROM nanohost_integration_identities WHERE identity_id = ?')
        .get(config.identityId) as { status: string };
      const token = coreDb.sqlite.prepare('SELECT status FROM nanohost_transport_tokens').get() as {
        status: string;
      };
      if (failure === 'database') {
        expect(identity.status).toBe('active');
        expect(token.status).toBe('active');
        expect(existsSync(config.credentialSlots.A.secretPath)).toBe(true);
      } else {
        expect(identity.status).toBe('decommissioned');
        expect(token.status).toBe('revoked');
        expect(existsSync(config.credentialSlots.A.secretPath)).toBe(false);
        expect(existsSync(config.credentialSlots.B.secretPath)).toBe(true);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed on issue when the sink write is unproved', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-issue-fail-'));
    const blocked = join(dataRoot, 'blocked-as-file');
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      writeFileSync(blocked, 'not-a-directory');
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: {
          nanohost: {
            ...configuredNanoHost(dataRoot),
            credentialSlots: {
              ...configuredNanoHost(dataRoot).credentialSlots,
              B: {
                secretPath: join(blocked, 'B.token'),
                companionPath: join(blocked, 'B.meta'),
              },
            },
          },
        },
      });

      const response = await app.request('/api/app/nanohost/tokens', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'B',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      const rows = coreDb.sqlite
        .prepare('SELECT status FROM nanohost_transport_tokens')
        .all() as Array<{ status: string }>;

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body).not.toHaveProperty('token');
      expect(JSON.stringify(body)).not.toMatch(/okt_/);
      expect(rows.every((row) => row.status === 'revoked')).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { lineage: 'identity-only', otherDeployment: true, otherIdentity: false },
    { lineage: 'deployment-only', otherDeployment: false, otherIdentity: true },
  ] as const)('rejects enrollment when $lineage token history exists without the identity row', async ({
    otherDeployment,
    otherIdentity,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-orphan-tokens-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-orphan-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const retained = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: otherDeployment ? 'deploy_other' : config.deploymentId,
        expiresAt: '2026-09-08T00:00:00.000Z',
        ownerNanoHostIdentityId: otherIdentity ? 'integration_nanohost_other' : config.identityId,
        responsibleServerAdminActorId: 'user_owner',
      });
      const historyBefore = coreDb.sqlite
        .prepare(
          `SELECT token_id, status, owner_nanohost_identity_id, deployment_id
             FROM nanohost_transport_tokens ORDER BY token_id`
        )
        .all();
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: { nanohost: config },
      });
      const response = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(body)).not.toMatch(/okt_/);
      expect(
        coreDb.sqlite.prepare('SELECT identity_id FROM nanohost_integration_identities').all()
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT token_id, status, owner_nanohost_identity_id, deployment_id
               FROM nanohost_transport_tokens ORDER BY token_id`
          )
          .all()
      ).toEqual(historyBefore);
      expect(historyBefore).toEqual([
        {
          deployment_id: otherDeployment ? 'deploy_other' : config.deploymentId,
          owner_nanohost_identity_id: otherIdentity
            ? 'integration_nanohost_other'
            : config.identityId,
          status: 'active',
          token_id: retained.tokenId,
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rotation replaces occupied opposite-slot revoked material with the fresh Token', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-rotate-occupied-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-rotate-occupied-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        nanohostTransportSessionAuthority: createNanoHostTransportSessionAuthority(),
        openKitConfig: { nanohost: config },
      });
      const enrolled = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      expect(enrolled.status).toBe(201);
      const enrollBody = (await enrolled.json()) as { record: { tokenId: string } };
      const occupiedSecret = 'okt_revoked_opposite_slot_secret_aaaaaaaaaaaaaaaa';
      const occupiedCompanion = [
        'token_id=tok_revoked_opposite',
        'issuance_generation=1',
        `identity_id=${config.identityId}`,
        `deployment_id=${config.deploymentId}`,
        '',
      ].join('\n');
      writeFileSync(join(slotRoot, 'B.token'), occupiedSecret, { mode: 0o600 });
      writeFileSync(join(slotRoot, 'B.meta'), occupiedCompanion, { mode: 0o600 });

      const rotated = await app.request(
        `/api/app/nanohost/tokens/${enrollBody.record.tokenId}/rotate`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${admin.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ overlapSeconds: 60 }),
        }
      );
      const rotateBody = (await rotated.json()) as {
        record: { tokenId: string };
        targetSlot: string;
      };

      expect(rotated.status).toBe(200);
      expect(JSON.stringify(rotateBody)).not.toMatch(/okt_/);
      expect(rotateBody.targetSlot).toBe('B');
      expect(rotateBody.record.tokenId).not.toBe(enrollBody.record.tokenId);
      expect(readFileSync(join(slotRoot, 'B.token'), 'utf8')).toMatch(/^okt_/);
      expect(readFileSync(join(slotRoot, 'B.token'), 'utf8')).not.toBe(occupiedSecret);
      expect(readFileSync(join(slotRoot, 'B.meta'), 'utf8')).toContain(
        `token_id=${rotateBody.record.tokenId}`
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('re-enrolls the exact retained identity and preserves created_at with a fresh Token', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-reenroll-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-reenroll-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        nanohostTransportSessionAuthority: createNanoHostTransportSessionAuthority(),
        openKitConfig: { nanohost: config },
      });
      const headers = {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      };
      const enroll = () =>
        app.request('/api/app/nanohost/enroll', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            targetSlot: 'A',
            expiresAt: '2026-09-08T00:00:00.000Z',
          }),
        });

      const first = await enroll();
      expect(first.status).toBe(201);
      const firstTokenId = ((await first.json()) as { record: { tokenId: string } }).record.tokenId;
      const original = coreDb.sqlite
        .prepare(
          `SELECT identity_id, deployment_id, status, created_at, decommissioned_at
           FROM nanohost_integration_identities`
        )
        .get() as {
        created_at: string;
        decommissioned_at: string | null;
        deployment_id: string;
        identity_id: string;
        status: string;
      };

      const decommissioned = await app.request('/api/app/nanohost/decommission', {
        method: 'POST',
        headers,
      });
      expect(decommissioned.status).toBe(200);

      const reenrolled = await enroll();
      const reenrollBody = (await reenrolled.json()) as { record: { tokenId: string } };
      expect(reenrolled.status).toBe(201);
      expect(reenrollBody.record.tokenId).not.toBe(firstTokenId);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT identity_id, deployment_id, status, created_at, decommissioned_at
             FROM nanohost_integration_identities`
          )
          .all()
      ).toEqual([
        {
          created_at: original.created_at,
          decommissioned_at: null,
          deployment_id: config.deploymentId,
          identity_id: config.identityId,
          status: 'active',
        },
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT token_id, status FROM nanohost_transport_tokens ORDER BY issued_at, token_id`
          )
          .all()
      ).toEqual([
        { status: 'revoked', token_id: firstTokenId },
        { status: 'active', token_id: reenrollBody.record.tokenId },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('enrollment transaction-failure cleanup refuses a companion rewritten to another Token', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-catch-'));
    const slotRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-enroll-catch-slots-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const config = configuredNanoHost(slotRoot);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_integration_identities (
            identity_id, deployment_id, status, created_at, decommissioned_at
          ) VALUES (?, ?, 'decommissioned', ?, ?)`
        )
        .run(
          'integration_nanohost_other',
          config.deploymentId,
          '2026-01-01T00:00:00.000Z',
          '2026-02-01T00:00:00.000Z'
        );
      const foreignCompanion = [
        'token_id=tok_foreign',
        'issuance_generation=1',
        `identity_id=${config.identityId}`,
        `deployment_id=${config.deploymentId}`,
        '',
      ].join('\n');
      const originalTransaction = coreDb.sqlite.transaction.bind(coreDb.sqlite);
      coreDb.sqlite.transaction = ((fn: () => unknown) =>
        originalTransaction(() => {
          writeFileSync(join(slotRoot, 'A.meta'), foreignCompanion, { mode: 0o600 });
          return fn();
        })) as typeof coreDb.sqlite.transaction;

      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
        openKitConfig: { nanohost: config },
      });
      const response = await app.request('/api/app/nanohost/enroll', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(body)).not.toMatch(/okt_/);
      expect(existsSync(join(slotRoot, 'A.token'))).toBe(true);
      expect(existsSync(join(slotRoot, 'A.meta'))).toBe(true);
      expect(readFileSync(join(slotRoot, 'A.meta'), 'utf8')).toBe(foreignCompanion);
      expect(
        coreDb.sqlite
          .prepare(`SELECT identity_id, deployment_id, status FROM nanohost_integration_identities`)
          .all()
      ).toEqual([
        {
          deployment_id: config.deploymentId,
          identity_id: 'integration_nanohost_other',
          status: 'decommissioned',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
