import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { recordWorkspaceApplyResult } from './workspace-apply-results.js';

describe('workspace apply results', () => {
  it('records one linked audit event when an apply result is stored', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-result-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceApplyResult(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000021',
        result: {
          appliedAt: '2026-07-05T00:00:00.000Z',
          appliedPaths: ['src/file.ts'],
          changeSetId: 'wcs_1',
          commitIds: [],
          conflictRecords: [],
          id: 'war_1',
          reviewId: 'swr_1',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });
      recordWorkspaceApplyResult(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000021',
        result: {
          appliedAt: '2026-07-05T00:00:00.000Z',
          appliedPaths: ['src/file.ts'],
          changeSetId: 'wcs_1',
          commitIds: [],
          conflictRecords: [],
          id: 'war_1',
          reviewId: 'swr_1',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });

      const audits = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE resource = ? ORDER BY created_at')
        .all('workspace-review:swr_1') as Array<Record<string, unknown>>;
      const evidenceBundles = workspaceDb.sqlite
        .prepare(
          `SELECT
            evidence_bundle_id,
            workspace_id,
            source_kind,
            summary,
            redacted_evidence_refs_json,
            content_digests_json,
            import_status
          FROM evidence_bundles
          ORDER BY created_at`
        )
        .all() as Array<Record<string, unknown>>;

      expect(audits).toEqual([
        expect.objectContaining({
          action: 'workspace.apply.finish',
          category: 'artifact',
          created_at: '2026-07-05T00:00:00.000Z',
          error_code: null,
          outcome: 'succeeded',
          request_id: '00000000-0000-4000-8000-000000000021',
          resource: 'workspace-review:swr_1',
          severity: 'info',
          summary: 'Workspace apply result applied: 1 applied path, 0 skipped paths, 0 conflicts',
          workspace_id: 'ws_demo',
        }),
      ]);
      expect(evidenceBundles).toEqual([
        expect.objectContaining({
          evidence_bundle_id: 'evb_workspace_apply_war_1',
          workspace_id: 'ws_demo',
          source_kind: 'workspace-apply-result',
          summary: 'Workspace apply result applied: 1 applied path, 0 skipped paths, 0 conflicts',
          redacted_evidence_refs_json: JSON.stringify([
            { kind: 'workspace-apply-result', ref: 'workspace-apply-result:war_1' },
            { kind: 'workspace-review', ref: 'workspace-review:swr_1' },
            { kind: 'workspace-change-set', ref: 'workspace-change-set:wcs_1' },
          ]),
          content_digests_json: JSON.stringify([]),
          import_status: 'promoted',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
