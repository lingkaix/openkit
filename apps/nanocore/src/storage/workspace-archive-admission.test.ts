import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const fixtures: Array<{ coreDb: ReturnType<typeof openCoreDb>; dataRoot: string }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await disposeTestStore(fixture.dataRoot, fixture.coreDb);
  }
});

/** Creates a real server-mode archive owner with an ordinary canonical-user session. */
async function archiveFixture(
  fileAdmission?: FileStorageAdmission,
  workspaceMutationAdmission = new WorkspaceMutationAdmission()
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-archive-admission-'));
  const coreDb = openCoreDb(dataRoot);
  fixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Archive admission');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: workspace.id,
  });
  const app = createApp({
    auth: {
      api: {
        getSession: async () => ({
          session: { id: 'archive_session' },
          user: { id: 'usr_00000000-0000-7000-8000-000000000001' },
        }),
      },
      handler: async () => Response.json({ status: 'auth-ok' }),
    },
    coreDb,
    dataRoot,
    ...(fileAdmission ? { fileAdmission } : {}),
    mode: 'server',
    store,
    workspaceMutationAdmission,
  });
  const token = (scope: 'workspace' | 'workspace-readonly' | 'server-admin') =>
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope,
      workspaceIds: scope === 'server-admin' ? [] : [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  return { app, coreDb, dataRoot, store, token, workspace, workspaceMutationAdmission };
}

/** Produces verified archive bytes through the retained download route, without fabricating archive authority. */
async function exportedArchive(fixture: Awaited<ReturnType<typeof archiveFixture>>) {
  // Only archive producers gain current administrator-session authority; import targets stay ordinary.
  fixture.token('server-admin');
  const response = await fixture.app.request(
    ...operationRequest(
      'workspace.export',
      { workspaceId: fixture.workspace.id },
      { method: 'POST' }
    )
  );
  expect(response.status).toBe(200);
  const { exportId } = (await response.json()) as { exportId: string };
  const path = `/api/app/workspaces/${fixture.workspace.id}/exports/${exportId}/archive`;
  const download = await fixture.app.request(path);
  expect(download.status).toBe(200);
  return { bytes: await download.arrayBuffer(), path };
}

/** Reads canonical registry and membership bytes so refusal cannot hide a durable import or owner change. */
function workspaceAuthority(fixture: Awaited<ReturnType<typeof archiveFixture>>) {
  return {
    members: fixture.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members ORDER BY workspace_id, user_id')
      .all(),
    registry: fixture.coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all(),
    workspaces: fixture.store.listWorkspaces(),
  };
}

describe('retained archive primary admission', () => {
  it('shares disk capacity admission across export publication', async () => {
    let availableBytes = 1_000_000_000n;
    const admission = new FileStorageAdmission(
      '.',
      () => 0n,
      () => availableBytes
    );
    const fixture = await archiveFixture(admission);
    await exportedArchive(fixture);
    const before = workspaceAuthority(fixture);
    // The existing App-owned reservation can consume capacity before the next transfer.
    const pending = admission.reserve({
      stagingBytes: availableBytes,
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    try {
      const exported = await fixture.app.request(
        ...operationRequest(
          'workspace.export',
          { workspaceId: fixture.workspace.id },
          { method: 'POST' }
        )
      );
      expect(exported.status).not.toBe(200);
      expect(workspaceAuthority(fixture)).toEqual(before);
    } finally {
      pending.release();
    }
    // Releasing a different request's unused capacity permits a fresh transfer.
    availableBytes = 1_000_000_000n;
    await exportedArchive(fixture);
  });

  it.each([
    'session',
    'administrator',
  ] as const)('fences retained %s download while its Workspace is closed', async (actor) => {
    const fixture = await archiveFixture();
    const archive = await exportedArchive(fixture);
    const headers =
      actor === 'administrator'
        ? { authorization: `Bearer ${fixture.token('server-admin').secret}` }
        : {};
    await fixture.workspaceMutationAdmission.close(fixture.workspace.id);
    const response = await fixture.app.request(`http://127.0.0.1${archive.path}`, { headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      protocolVersion: PROTOCOL_VERSION,
    });
    fixture.workspaceMutationAdmission.reopen(fixture.workspace.id);
    const resumed = await fixture.app.request(`http://127.0.0.1${archive.path}`, { headers });
    expect(resumed.status).toBe(200);
    expect(await resumed.arrayBuffer()).toEqual(archive.bytes);
  });
});
