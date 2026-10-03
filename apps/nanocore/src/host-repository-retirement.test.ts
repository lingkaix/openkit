import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('retired host repository routes', () => {
  it.each([
    ['GET', ''],
    ['GET', '/diagnostics'],
    ['PUT', '/default'],
    ['GET', '/git-push-records'],
    ['GET', '/git-push-records/gpr_retired'],
    ['POST', '/repo_default/git-push/approval'],
    ['POST', '/repo_default/git-push'],
  ])('leaves the authorized %s repositories%s route unavailable', async (method, suffix) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-retired-repository-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    try {
      const app = createApp({ coreDb, dataRoot, store });
      if (suffix === '/git-push-records/gpr_retired') {
        const db = openWorkspaceDb(dataRoot, 'ws_demo');
        try {
          applyScopedMigrations(db);
          // A real historical child proves base route ownership instead of opaque-child denial.
          const present = db.sqlite
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'git_push_records'"
            )
            .get();
          if (!present) {
            const ddl = readFileSync('drizzle/workspace/0000_setup.sql', 'utf8')
              .split('--> statement-breakpoint')
              .find((statement) =>
                statement.includes(['CREATE', 'TABLE', '`git_push_records`'].join(' '))
              );
            if (!ddl) throw new Error('Historical push record DDL is missing.');
            db.sqlite.exec(ddl);
          }
          db.sqlite
            .prepare(
              'INSERT INTO git_push_records (push_record_id, workspace_id, repository_resource_id, remote_summary, source_ref, target_branch, commit_ids_json, review_ids_json, outcome, created_at, updated_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              'gpr_retired',
              'ws_demo',
              'repo_default',
              'Historical vendor origin',
              'HEAD',
              'feature/retired',
              JSON.stringify(['a'.repeat(40)]),
              '[]',
              'pushed',
              '2026-10-01T00:00:00.000Z',
              '2026-10-01T00:00:00.000Z',
              '00000000-0000-4000-8000-000000000703'
            );
        } finally {
          db.sqlite.close();
        }
      }
      const response = await app.request(`/api/app/workspaces/ws_demo/repositories${suffix}`, {
        method,
        ...(method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('404 Not Found');
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
