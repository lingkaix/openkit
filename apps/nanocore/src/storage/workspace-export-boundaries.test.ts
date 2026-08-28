// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { loadWorkspaceFileRecords } from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

const timestamp = '2026-07-12T00:00:00.000Z';

/** Returns a Better Auth test double for one signed-in canonical user. */
function authForUser(userId: string): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({ session: { id: `session_${userId}` }, user: { id: userId } }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/** Returns the smallest complete workspace export input. */
function minimalExportInput(
  exportRoot: string,
  workspaceId = 'ws_demo',
  exportId = 'wsexp_demo'
): Parameters<typeof writeWorkspaceExportTree>[0] {
  return {
    exportRoot,
    exportId,
    sourceDeploymentId: 'dep_source',
    createdAt: timestamp,
    workspace: {
      id: workspaceId,
      name: 'Boundary workspace',
      kind: 'general',
      status: 'active',
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    threads: [],
    turns: [],
    knowledge: [],
    itemRevisions: [],
    artifacts: [],
    artifactReviews: [],
    threadMaterialBindings: [],
    workspaceMaterialRevisions: [],
    workspaceMaterials: [],
    agentSessions: [],
    turnEvents: [],
  };
}

/** Returns one valid source record for export-boundary tests. */
function knowledgeSource(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'ws_demo',
    kind: 'document',
    title: 'Boundary source',
    uri: null,
    contentDigest: 'sha256:source',
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Creates a file-backed route store containing the legacy demo workspace. */
function createBoundaryStore(dataRoot: string): FsStore {
  const store = new FsStore({ dataRoot });
  const demo = createDemoWorkspaceForUser('user_local');
  store.importWorkspaceSnapshot({
    workspace: demo.workspace,
    threads: [demo.thread],
    knowledge: demo.knowledge,
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  });
  return store;
}

describe('workspace export filesystem boundaries', () => {
  it('rejects unsafe knowledge source and material ids before writing outside the export', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-source-boundary-'));
    const unsafeId = '../../../outside-source';

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(join(parent, 'source-export')),
        knowledgeSources: [knowledgeSource(unsafeId)],
      })
    ).toThrow(/safe path segment/i);

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(join(parent, 'material-export')),
        knowledgeSourceMaterials: [{ sourceId: unsafeId, content: 'must stay contained' }],
      })
    ).toThrow(/safe path segment/i);
    expect(existsSync(join(parent, 'outside-source', 'content.txt'))).toBe(false);
  });

  it('rejects an unsafe persisted source id before reading material outside the export', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-import-source-boundary-'));
    const exportRoot = join(parent, 'export');
    const safeId = 'ks_safe';
    const unsafeId = '../../../outside-source';
    writeWorkspaceExportTree({
      ...minimalExportInput(exportRoot),
      knowledgeSources: [knowledgeSource(safeId)],
    });

    const sourcePath = join(exportRoot, 'records', 'knowledge-sources.jsonl');
    const sourceText = `${JSON.stringify(knowledgeSource(unsafeId))}\n`;
    writeFileSync(sourcePath, sourceText);
    const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contentDigest: string;
      contentInventory: Array<{ path: string; digest: string; bytes: number }>;
    };
    const sourceEntry = manifest.contentInventory.find(
      (entry) => entry.path === 'records/knowledge-sources.jsonl'
    );
    if (!sourceEntry) {
      throw new Error('Expected knowledge source inventory entry.');
    }
    sourceEntry.bytes = Buffer.byteLength(sourceText);
    sourceEntry.digest = `sha256:${createHash('sha256').update(sourceText).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const outsideMaterial = join(parent, 'outside-source', 'content.txt');
    mkdirSync(dirname(outsideMaterial), { recursive: true });
    writeFileSync(outsideMaterial, 'external material');

    expect(() =>
      readWorkspaceImportSnapshot({
        verified: verifyWorkspaceExportTree({ exportRoot }),
        targetWorkspaceId: 'ws_imported',
      })
    ).toThrow(/safe path segment/i);
  });

  it('requires a fresh real export directory so stale files cannot leak', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-fresh-root-'));
    const emptyRoot = join(parent, 'empty-export');
    mkdirSync(emptyRoot);

    expect(() => writeWorkspaceExportTree(minimalExportInput(emptyRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(emptyRoot)).toBe(true);

    const exportRoot = join(parent, 'export');
    mkdirSync(join(exportRoot, 'records'), { recursive: true });
    writeFileSync(join(exportRoot, 'records', 'knowledge-proposals.jsonl'), '{"stale":true}\n');
    const staleArtifact = join(exportRoot, 'artifacts', 'ar_stale', 'files', 'content.md');
    mkdirSync(dirname(staleArtifact), { recursive: true });
    writeFileSync(staleArtifact, 'stale artifact');

    expect(() => writeWorkspaceExportTree(minimalExportInput(exportRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(join(exportRoot, 'records', 'workspace.json'))).toBe(false);

    const target = join(parent, 'symlink-target');
    mkdirSync(target);
    const linkedRoot = join(parent, 'linked-export');
    symlinkSync(target, linkedRoot);
    expect(() => writeWorkspaceExportTree(minimalExportInput(linkedRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(join(target, 'records', 'workspace.json'))).toBe(false);
  });

  it('removes a partial export tree when writing fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-failed-write-'));
    const exportRoot = join(parent, 'export');

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(exportRoot),
        knowledgeSourceMaterials: [{ sourceId: 'ks_missing', content: 'partial content' }],
      })
    ).toThrow(/references missing source/i);
    expect(existsSync(exportRoot)).toBe(false);
  });

  it('rejects symlink and non-directory verifier roots before reading a manifest', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-verify-root-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const linkedRoot = join(parent, 'linked-export');
    symlinkSync(exportRoot, linkedRoot);
    const fileRoot = join(parent, 'not-a-directory');
    writeFileSync(fileRoot, 'not a directory');

    expect(() => verifyWorkspaceExportTree({ exportRoot: linkedRoot })).toThrow(
      /Export root must be a real directory/
    );
    expect(() => verifyWorkspaceExportTree({ exportRoot: fileRoot })).toThrow(
      /Export root must be a real directory/
    );
  });

  it('rejects a manifest whose content digest does not cover its inventory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-manifest-digest-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { contentDigest: string };

    manifest.contentDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyWorkspaceExportTree({ exportRoot })).toThrow(/content digest/i);
  });

  it('returns the exact file contents and manifest digest checked by one verification', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-verified-contents-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const verified = verifyWorkspaceExportTree({ exportRoot }) as ReturnType<
      typeof verifyWorkspaceExportTree
    > & {
      fileContents?: ReadonlyMap<string, string>;
      manifestDigest?: string;
    };
    const workspacePath = join(exportRoot, 'records', 'workspace.json');
    const manifestText = readFileSync(join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE), 'utf8');

    expect(verified.fileContents?.get('records/workspace.json')).toBe(
      readFileSync(workspacePath, 'utf8')
    );
    expect(verified.manifestDigest).toBe(
      `sha256:${createHash('sha256').update(manifestText).digest('hex')}`
    );
  });

  it('does not remove external staging through a linked workspaces directory', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-staging-link-'));
    const external = mkdtempSync(join(tmpdir(), 'openkit-workspace-staging-external-'));
    const marker = join(external, '.staging', 'keep.txt');
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, 'keep');
    symlinkSync(external, join(dataRoot, 'workspaces'));

    expect(() => loadWorkspaceFileRecords(dataRoot, 'user_local')).toThrow();
    expect(readFileSync(marker, 'utf8')).toBe('keep');
  });
});

describe('workspace export route boundaries', () => {
  it('fails closed when a worker-backed Turn has no S39 trace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-s39-'));
    const store = createBoundaryStore(dataRoot);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Export an untraced worker Turn', {
      kind: 'user',
      id: 'user_local',
    });
    const session = store.createAgentSession({
      id: 'as_export_missing_trace',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'busy',
      message: null,
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    store.updateTurn(turn.id, { agentSessionId: session.id });
    const app = createApp({ dataRoot, store });
    app.onError((error) => new Response(error.message, { status: 500 }));

    const response = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Worker Context Package coverage is incomplete.');
    expect(readdirSync(join(dataRoot, 'server', 'exports', 'workspaces', 'ws_demo'))).toEqual([]);
  });
});

describe('workspace import route handles', () => {
  it.each([
    ['dry-run', 'sourceWorkspaceId'],
    ['dry-run', 'exportId'],
    ['import', 'sourceWorkspaceId'],
    ['import', 'exportId'],
  ] as const)('rejects %s when the requested %s disagrees with the manifest', async (route, field) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-handle-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const requestedWorkspaceId = field === 'sourceWorkspaceId' ? 'ws_wrong_handle' : 'ws_demo';
    const requestedExportId = field === 'exportId' ? 'wsexp_wrong_handle' : exported.exportId;
    const originalRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      'ws_demo',
      exported.exportId
    );
    const requestedRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      requestedWorkspaceId,
      requestedExportId
    );
    mkdirSync(dirname(requestedRoot), { recursive: true });
    renameSync(originalRoot, requestedRoot);

    const response = await app.request(
      route === 'dry-run' ? '/api/app/workspace-imports/dry-run' : '/api/app/workspace-imports',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceWorkspaceId: requestedWorkspaceId,
          exportId: requestedExportId,
        }),
      }
    );

    expect(response.status).toBe(400);
  });

  it('skips an orphan final workspace path when choosing a collision id', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-orphan-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const orphanRoot = join(dataRoot, 'workspaces', 'ws_imported_ws_demo');
    mkdirSync(orphanRoot, { recursive: true });
    writeFileSync(join(orphanRoot, 'orphan.txt'), 'keep');

    const response = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId: exported.exportId }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ importedWorkspaceId: 'ws_imported_ws_demo_2' });
    expect(readFileSync(join(orphanRoot, 'orphan.txt'), 'utf8')).toBe('keep');
  });

  it('skips a workspace id owned anywhere else in the deployment', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-registry-'));
    const store = createBoundaryStore(dataRoot);
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id,
            display_name,
            email,
            email_verified,
            created_at,
            updated_at,
            kind
          )
           VALUES
             ('user_local', 'Local', 'local@example.com', false, ?, ?, 'human'),
             ('user_other', 'Other', 'other@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: 'ws_demo',
      });
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_other',
        workspaceId: 'ws_imported_ws_demo',
      });
      const app = createApp({ coreDb, dataRoot, store });
      const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
        method: 'POST',
      });
      const exported = (await exportResponse.json()) as { exportId: string };

      const response = await app.request('/api/app/workspace-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId: exported.exportId }),
      });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ importedWorkspaceId: 'ws_imported_ws_demo_2' });
      expect(
        coreDb.sqlite
          .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
          .get('ws_imported_ws_demo')
      ).toEqual({ owner_user_id: 'user_other' });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('workspace portable authority boundaries', () => {
  it('imports only target ownership while source authority remains non-authorizing history', async () => {
    const sourceDataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-authority-source-'));
    const targetDataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-authority-target-'));
    const sourceCoreDb = openCoreDb(sourceDataRoot);
    const targetCoreDb = openCoreDb(targetDataRoot);

    try {
      applyMigrations(sourceCoreDb);
      applyMigrations(targetCoreDb);
      const now = Date.now();
      const users = [
        ['user_source_owner', 'Source owner'],
        ['user_source_active', 'Source active member'],
        ['user_source_removed', 'Source removed member'],
        ['user_target_importer', 'Target importer'],
      ] as const;
      for (const coreDb of [sourceCoreDb, targetCoreDb]) {
        const insertUser = coreDb.sqlite.prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind
          ) VALUES (?, ?, ?, false, ?, ?, 'human')`
        );
        for (const [userId, displayName] of users) {
          insertUser.run(userId, displayName, `${userId}@example.com`, now, now);
        }
      }

      const sourceStore = new FsStore({ dataRoot: sourceDataRoot });
      const sourceWorkspace = sourceStore.createWorkspace('Portable authority source');
      recordWorkspaceOwnerMembership({
        coreDb: sourceCoreDb,
        ownerUserId: 'user_source_owner',
        workspaceId: sourceWorkspace.id,
      });
      const insertMember = sourceCoreDb.sqlite.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`
      );
      insertMember.run(
        sourceWorkspace.id,
        'user_source_active',
        'active',
        'editor',
        timestamp,
        null,
        timestamp,
        timestamp
      );
      insertMember.run(
        sourceWorkspace.id,
        'user_source_removed',
        'removed',
        'viewer',
        timestamp,
        timestamp,
        timestamp,
        timestamp
      );
      sourceCoreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, proposed_access_level,
            inviter_user_id, status, expires_at, accepted_at, declined_at, revoked_at,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, 'viewer', ?, 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
        )
        .run(
          'inv_source_importer',
          sourceWorkspace.id,
          'user_target_importer',
          'user_source_owner',
          '2099-01-01T00:00:00.000Z',
          timestamp,
          timestamp
        );
      sourceCoreDb.sqlite
        .prepare(
          `INSERT INTO session (
            id, expires_at, token, created_at, updated_at, user_id
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          'session_source_authority',
          Date.parse('2099-01-01T00:00:00.000Z'),
          'source-session-token',
          now,
          now,
          'user_source_owner'
        );
      createOpenKitAccessTokenRecord(sourceCoreDb, {
        expiresAt: '2099-01-01T00:00:00.000Z',
        ownerUserId: 'user_source_owner',
        scope: 'workspace',
        tokenId: 'token_source_authority',
        workspaceIds: [sourceWorkspace.id],
      });
      const sourceApp = createApp({
        auth: authForUser('user_source_owner'),
        coreDb: sourceCoreDb,
        dataRoot: sourceDataRoot,
        mode: 'server',
        store: sourceStore,
      });
      const exportResponse = await sourceApp.request(
        `/api/app/workspaces/${sourceWorkspace.id}/export`,
        { method: 'POST' }
      );
      expect(exportResponse.status, await exportResponse.clone().text()).toBe(200);
      const exported = (await exportResponse.json()) as { exportId: string };
      const sourceExportRoot = join(
        sourceDataRoot,
        'server',
        'exports',
        'workspaces',
        sourceWorkspace.id,
        exported.exportId
      );
      const targetExportRoot = join(
        targetDataRoot,
        'server',
        'exports',
        'workspaces',
        sourceWorkspace.id,
        exported.exportId
      );
      mkdirSync(dirname(targetExportRoot), { recursive: true });
      renameSync(sourceExportRoot, targetExportRoot);

      const targetStore = new FsStore({ dataRoot: targetDataRoot });
      const targetApp = createApp({
        auth: authForUser('user_target_importer'),
        coreDb: targetCoreDb,
        dataRoot: targetDataRoot,
        mode: 'server',
        store: targetStore,
      });
      const importResponse = await targetApp.request('/api/app/workspace-imports', {
        body: JSON.stringify({
          exportId: exported.exportId,
          requestId: '00000000-0000-4000-8000-000000000008',
          sourceWorkspaceId: sourceWorkspace.id,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(importResponse.status, await importResponse.clone().text()).toBe(200);
      const imported = (await importResponse.json()) as { importedWorkspaceId: string };

      expect(
        targetCoreDb.sqlite
          .prepare(
            `SELECT workspace_id AS workspaceId, user_id AS userId, status,
                    access_level AS accessLevel
             FROM workspace_members
             ORDER BY workspace_id, user_id`
          )
          .all()
      ).toEqual([
        {
          accessLevel: 'editor',
          status: 'active',
          userId: 'user_target_importer',
          workspaceId: imported.importedWorkspaceId,
        },
      ]);
      expect(
        targetCoreDb.sqlite
          .prepare(
            `SELECT workspace_id AS workspaceId, owner_user_id AS ownerUserId
             FROM workspace_registry
             ORDER BY workspace_id`
          )
          .all()
      ).toEqual([
        { ownerUserId: 'user_target_importer', workspaceId: imported.importedWorkspaceId },
      ]);
      expect(
        targetCoreDb.sqlite.prepare('SELECT invitation_id FROM workspace_invitations').all()
      ).toEqual([]);
      expect(targetCoreDb.sqlite.prepare('SELECT id FROM session').all()).toEqual([]);
      expect(
        targetCoreDb.sqlite.prepare('SELECT token_id FROM openkit_access_tokens').all()
      ).toEqual([]);
      expect(
        currentWorkspaceAuthority(
          targetCoreDb,
          imported.importedWorkspaceId,
          { id: 'user_source_owner', kind: 'user' },
          'workspace.read',
          true
        )
      ).toBeNull();
    } finally {
      sourceCoreDb.sqlite.close();
      targetCoreDb.sqlite.close();
    }
  });
});
