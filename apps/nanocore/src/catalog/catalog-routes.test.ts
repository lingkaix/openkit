import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetWorkspaceCatalogResponseSchema,
  ImportSkillResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

describe('resource catalog routes', () => {
  it('imports a Skill and returns the redacted Workspace catalog summary', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-resource-catalog-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Catalog workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const empty = await app.request(`/api/app/workspaces/${workspace.id}/catalog`);
      expect(empty.status).toBe(200);
      expect(GetWorkspaceCatalogResponseSchema.parse(await empty.json())).toMatchObject({
        candidates: [],
        mcp: [],
        plugins: [],
        revision: 0,
        skills: [],
      });

      const imported = await app.request(`/api/app/workspaces/${workspace.id}/catalog/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          activate: true,
          displayName: 'Repo guidelines',
          expectedRevision: 0,
          requestId: '00000000-0000-4000-8000-000000000001',
          tree: [
            {
              contentBase64: Buffer.from('# Hello\n', 'utf8').toString('base64'),
              kind: 'file',
              path: 'SKILL.md',
            },
          ],
        }),
      });
      expect(imported.status).toBe(201);
      const importedBody = ImportSkillResponseSchema.parse(await imported.json());
      expect(importedBody.entry.id).toBe('repo-guidelines');
      expect(importedBody.version.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const summary = await app.request(`/api/app/workspaces/${workspace.id}/catalog`);
      expect(GetWorkspaceCatalogResponseSchema.parse(await summary.json()).skills).toEqual([
        expect.objectContaining({
          currentDigest: importedBody.version.digest,
          displayName: 'Repo guidelines',
          id: 'repo-guidelines',
          pinDigest: null,
          versions: [expect.objectContaining({ digest: importedBody.version.digest })],
        }),
      ]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects a plugin upload path that escapes the staging root', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-resource-catalog-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Catalog workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const app = createApp({ coreDb, dataRoot, store });
    try {
      const escaped = await app.request(`/api/app/workspaces/${workspace.id}/catalog/plugins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 0,
          install: true,
          requestId: '00000000-0000-4000-8000-000000000002',
          tree: [
            {
              contentBase64: Buffer.from('x').toString('base64'),
              kind: 'file',
              path: '../../outside.txt',
            },
          ],
        }),
      });
      expect(escaped.status).toBe(400);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
