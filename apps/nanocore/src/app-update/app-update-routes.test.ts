import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppUpdateStatusResponse } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { listServerAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { PUBLIC_OPERATION_ACCESS } from '../auth/operation-access.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import type { AppUpdateHostCommand } from './host-request.js';
import type { AppUpdateHostResult, AppUpdateHostTransport } from './host-transport.js';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PREPARE_BODY = {
  expectedCurrentImageId: DIGEST,
  source: {
    appDigest: DIGEST,
    kind: 'release',
    sourceCommit: COMMIT,
    tag: 'v0.1.0',
  },
};

/**
 * Creates an in-process helper that pins receipts without host effects.
 *
 * @param now Clock used for prepare expiry.
 * @returns Host transport.
 */
function createMemoryTransport(now: () => number = Date.now): AppUpdateHostTransport {
  const receipts = new Map<string, AppUpdateStatusResponse>();

  return {
    async invoke(command: AppUpdateHostCommand): Promise<AppUpdateHostResult> {
      if (command.op === 'prepare') {
        const requestId = randomUUID();
        const status: AppUpdateStatusResponse = {
          candidateBoot: null,
          candidateImageId: null,
          completedAt: null,
          error: null,
          expectedCurrentImageId: command.expectedCurrentImageId,
          jobId: null,
          outcome: 'prepared',
          predicates: null,
          preparedAt: new Date(now()).toISOString(),
          previousAppRestored: null,
          previousBoot: null,
          previousImageId: null,
          requestId,
          source: command.source,
          stage: 'prepared',
          startedAt: null,
        };
        receipts.set(requestId, status);
        return { ok: true, status };
      }

      const receipt = receipts.get(command.requestId);
      if (!receipt) {
        return {
          ok: false,
          code: 'app_update_recovery_required',
          message: 'App-update receipt is missing.',
        };
      }
      if (command.op === 'status') {
        return { ok: true, status: receipt };
      }
      if (receipt.stage !== 'prepared') {
        return { ok: true, status: receipt };
      }
      if (now() - Date.parse(receipt.preparedAt) > 10 * 60 * 1000) {
        return {
          ok: false,
          code: 'app_update_expired',
          message: 'Prepared App-update receipt expired.',
        };
      }
      const started: AppUpdateStatusResponse = {
        ...receipt,
        jobId: `job_${receipt.requestId}`,
        outcome: 'running',
        stage: 'launching',
        startedAt: new Date(now()).toISOString(),
      };
      receipts.set(receipt.requestId, started);
      return { ok: true, status: started };
    },
  };
}

describe('app-update routes', () => {
  it('disables prepare when deployment configuration is absent', async () => {
    const app = createApp();
    const response = await app.request('/api/app/app-update/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PREPARE_BODY),
    });
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe('app_update_unconfigured');
  });

  it('keeps Core serving when configured App-update identity files are missing', async () => {
    const app = createApp({
      openKitConfig: {
        appUpdate: {
          host: '127.0.0.1',
          identityFile: '/no/such/openkit-app-update-identity',
          knownHostsFile: '/no/such/openkit-app-update-known-hosts',
          port: 22,
          user: 'openkit-update',
        },
      },
    });
    const response = await app.request('/api/app/app-update/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PREPARE_BODY),
    });
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe('app_update_unavailable');
    expect(body.message).not.toMatch(/no\/such/);
  });

  it('prepares a published-digest source and starts only that receipt', async () => {
    const app = createApp({ appUpdateHostTransport: createMemoryTransport() });
    const prepared = await app.request('/api/app/app-update/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PREPARE_BODY),
    });
    const review = (await prepared.json()) as {
      requestId: string;
      source: { appDigest: string; kind: string };
      stage: string;
    };

    expect(prepared.status).toBe(200);
    expect(review.stage).toBe('prepared');
    expect(review.source).toEqual(PREPARE_BODY.source);

    const started = await app.request('/api/app/app-update/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maintenanceConsent: true,
        requestId: review.requestId,
      }),
    });
    const status = (await started.json()) as { jobId: string; requestId: string; stage: string };

    expect(started.status).toBe(200);
    expect(status.requestId).toBe(review.requestId);
    expect(status.stage).toBe('launching');
    expect(status.jobId).toMatch(/^job_/);
  });

  it('refuses start for a missing receipt instead of creating a new execution', async () => {
    const app = createApp({ appUpdateHostTransport: createMemoryTransport() });
    const response = await app.request('/api/app/app-update/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maintenanceConsent: true,
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    });
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe('app_update_recovery_required');
  });

  it('keeps App-update operations off Worker and AEP catalogs', () => {
    for (const operationId of ['prepareAppUpdate', 'startAppUpdate', 'getAppUpdateStatus']) {
      expect(PUBLIC_OPERATION_ACCESS[operationId]).toMatchObject({
        authentication: 'deployment-admin',
        scope: 'server',
      });
    }
    expect(PUBLIC_OPERATION_ACCESS['POST /api/worker-control/app-update']).toBeUndefined();
    expect(PUBLIC_OPERATION_ACCESS.prepareAppUpdate?.authentication).not.toBe('gateway-actor');
  });

  it('rejects a non-admin session and a workspace-scoped token', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-update-auth-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    insertSessionUser(coreDb, 'user_app_update_member');
    const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    const startBody = JSON.stringify({
      maintenanceConsent: true,
      requestId: '11111111-1111-4111-8111-111111111111',
    });
    const sessionApp = createApp({
      appUpdateHostTransport: createMemoryTransport(),
      auth: createSignedInAuthStub('user_app_update_member'),
      coreDb,
      dataRoot,
      mode: 'server',
    });
    const tokenApp = createApp({
      appUpdateHostTransport: createMemoryTransport(),
      auth: createSignedOutAuthStub(),
      coreDb,
      dataRoot,
      mode: 'server',
    });

    try {
      const sessionDenied = await Promise.all([
        sessionApp.request('/api/app/app-update/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(PREPARE_BODY),
        }),
        sessionApp.request('/api/app/app-update/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: startBody,
        }),
        sessionApp.request('/api/app/app-update/11111111-1111-4111-8111-111111111111'),
      ]);
      const workspaceDenied = await Promise.all([
        tokenApp.request('/api/app/app-update/prepare', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${workspaceToken.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(PREPARE_BODY),
        }),
        tokenApp.request('/api/app/app-update/start', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${workspaceToken.secret}`,
            'content-type': 'application/json',
          },
          body: startBody,
        }),
        tokenApp.request('/api/app/app-update/11111111-1111-4111-8111-111111111111', {
          headers: { authorization: `Bearer ${workspaceToken.secret}` },
        }),
      ]);

      for (const response of [...sessionDenied, ...workspaceDenied]) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: 'app_update_forbidden' });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records authorized start before transport and a truthful handoff after the result', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-update-audit-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const inner = createMemoryTransport();
    let releaseStart: (() => void) | undefined;
    const transport: AppUpdateHostTransport = {
      async invoke(command) {
        if (command.op === 'start') {
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
        }
        return inner.invoke(command);
      },
    };
    const app = createApp({
      appUpdateHostTransport: transport,
      coreDb,
      dataRoot,
    });

    try {
      const prepared = await app.request('/api/app/app-update/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PREPARE_BODY),
      });
      const review = (await prepared.json()) as { requestId: string };
      const startPromise = app.request('/api/app/app-update/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          maintenanceConsent: true,
          requestId: review.requestId,
        }),
      });

      await expect
        .poll(() => listServerAuditEvents(coreDb).map((event) => event.action))
        .toEqual(['app.update.start']);
      expect(listServerAuditEvents(coreDb)[0]).toMatchObject({
        action: 'app.update.start',
        outcome: 'succeeded',
        requestId: review.requestId,
        summary: 'Authorized App-update start request was accepted.',
      });
      expect(listServerAuditEvents(coreDb)[0]?.summary).not.toMatch(/handed/);

      releaseStart?.();
      const started = await startPromise;
      expect(started.status).toBe(200);
      expect(listServerAuditEvents(coreDb).map((event) => event.action)).toEqual([
        'app.update.start',
        'app.update.start.handoff',
      ]);
      expect(listServerAuditEvents(coreDb)[1]).toMatchObject({
        action: 'app.update.start.handoff',
        outcome: 'succeeded',
        requestId: review.requestId,
        summary: 'App-update start host handoff returned a receipt.',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records a failed handoff after an unconfigured start instead of a succeeded host send', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-update-unconfigured-audit-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({
      appUpdateHostTransport: null,
      coreDb,
      dataRoot,
    });

    try {
      const response = await app.request('/api/app/app-update/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          maintenanceConsent: true,
          requestId: '11111111-1111-4111-8111-111111111111',
        }),
      });
      const events = listServerAuditEvents(coreDb);

      expect(response.status).toBe(503);
      expect(events.map((event) => ({ action: event.action, outcome: event.outcome }))).toEqual([
        { action: 'app.update.start', outcome: 'succeeded' },
        { action: 'app.update.start.handoff', outcome: 'failed' },
      ]);
      expect(events[1]).toMatchObject({
        errorCode: 'app_update_unconfigured',
        summary: 'App-update start host handoff did not return a receipt.',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

function createSignedOutAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async () => null,
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

function createSignedInAuthStub(userId: string): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({
        session: { id: `session_${userId}` },
        user: { id: userId },
      }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

function insertSessionUser(coreDb: CoreDb, userId: string): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind
        )
        VALUES (?, 'App Update Member', ?, false, ?, ?, 'human')`
    )
    .run(userId, `${userId}@example.com`, now, now);
}
