import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE } from './workspace-archive.js';

const fixtures: Array<{ coreDb: ReturnType<typeof openCoreDb>; dataRoot: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.coreDb.sqlite.close();
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

/** Creates a real server-mode archive owner with an ordinary canonical-user session. */
function archiveFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-archive-admission-'));
  const coreDb = openCoreDb(dataRoot);
  fixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Archive admission');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: workspace.id });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const app = createApp({
    auth: {
      api: {
        getSession: async () => ({
          session: { id: 'archive_session' },
          user: { id: 'user_local' },
        }),
      },
      handler: async () => Response.json({ status: 'auth-ok' }),
    },
    coreDb,
    dataRoot,
    mode: 'server',
    store,
    workspaceMutationAdmission,
  });
  const token = (scope: 'workspace' | 'workspace-readonly' | 'server-admin') =>
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope,
      workspaceIds: scope === 'server-admin' ? [] : [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  return { app, coreDb, dataRoot, store, token, workspace, workspaceMutationAdmission };
}

/** Produces verified archive bytes through the retained download route, without fabricating archive authority. */
async function exportedArchive(fixture: ReturnType<typeof archiveFixture>) {
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
function workspaceAuthority(fixture: ReturnType<typeof archiveFixture>) {
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
  it.each([
    ['workspace', 'import-dry-run'],
    ['workspace', 'import'],
    ['workspace-readonly', 'import-dry-run'],
    ['workspace-readonly', 'import'],
  ] as const)('refuses %s bearer foreign archive %s before staging or ownership changes', async (scope, operation) => {
    const source = archiveFixture();
    const archive = await exportedArchive(source);
    const target = archiveFixture();
    const credential = target.token(scope);
    const before = workspaceAuthority(target);
    const staging = join(target.dataRoot, 'server', 'files', 'workspace-archive-requests');
    expect(existsSync(staging)).toBe(false);
    const response = await target.app.request(
      `http://127.0.0.1/api/app/workspace-archives/${operation}`,
      {
        body: archive.bytes,
        headers: {
          authorization: `Bearer ${credential.secret}`,
          'content-type': WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE,
          'x-openkit-request-id': '00000000-0000-4000-8000-000000000015',
        },
        method: 'POST',
      }
    );
    // Observe effect absence even on a vulnerable revision that returns success.
    const after = workspaceAuthority(target);
    const staged = existsSync(staging);
    expect({
      status: response.status,
      body: await response.json(),
      staged,
      authority: after,
    }).toEqual({
      status: 403,
      body: {
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
        protocolVersion: PROTOCOL_VERSION,
      },
      staged: false,
      authority: before,
    });
  });

  it.each([
    'session',
    'administrator',
  ] as const)('fences retained %s download while its Workspace is closed', async (actor) => {
    const fixture = archiveFixture();
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

  it.each([
    'session',
    'administrator',
  ] as const)('preserves %s foreign archive dry-run and import', async (actor) => {
    const source = archiveFixture();
    const archive = await exportedArchive(source);
    const target = archiveFixture();
    const headers = {
      ...(actor === 'administrator'
        ? { authorization: `Bearer ${target.token('server-admin').secret}` }
        : {}),
      'content-type': WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE,
      'x-openkit-request-id': '00000000-0000-4000-8000-000000000016',
    };
    const before = workspaceAuthority(target);
    const dryRun = await target.app.request(
      'http://127.0.0.1/api/app/workspace-archives/import-dry-run',
      { body: archive.bytes.slice(0), headers, method: 'POST' }
    );
    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({
      mode: 'dry-run',
      sourceWorkspaceId: source.workspace.id,
    });
    expect(workspaceAuthority(target)).toEqual(before);
    const imported = await target.app.request(
      'http://127.0.0.1/api/app/workspace-archives/import',
      { body: archive.bytes, headers, method: 'POST' }
    );
    expect(imported.status).toBe(200);
    const result = (await imported.json()) as { mode: string; importedWorkspaceId: string };
    expect(result.mode).toBe('imported');
    expect(target.store.getWorkspace(result.importedWorkspaceId)).not.toBeNull();
    expect(
      target.coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get(result.importedWorkspaceId)
    ).toEqual({ owner_user_id: 'user_local' });
    expect(
      target.coreDb.sqlite
        .prepare(
          'SELECT user_id, status, access_level FROM workspace_members WHERE workspace_id = ?'
        )
        .all(result.importedWorkspaceId)
    ).toEqual([{ user_id: 'user_local', status: 'active', access_level: 'editor' }]);
  });
});
