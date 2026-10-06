import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  getWorkspaceApplyResult,
  listExportableWorkspaceApplyResults,
  type RecordWorkspaceApplyResultInput,
  recordWorkspaceApplyResult,
} from './workspace-apply-results.js';

describe('workspace apply results', () => {
  it('normalizes retained verification additions and preserves exact replay bytes after reopening', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-apply-result-extensions-'));
    let db = openWorkspaceDb(dataRoot, 'ws_demo');
    const input: RecordWorkspaceApplyResultInput = {
      requestId: 'request_apply_extensions',
      result: {
        id: 'war_extensions',
        workspaceId: 'ws_demo',
        reviewId: 'swr_extensions',
        changeSetId: 'wcs_extensions',
        status: 'conflicted',
        appliedPaths: ['src/applied.ts'],
        skippedPaths: ['src/conflict.ts'],
        conflictRecords: ['Changed since staging'],
        verification: [{ command: 'pnpm test', status: 'passed', ref: null }],
        commitIds: [],
        appliedAt: '2026-07-05T00:00:00.000Z',
      },
    };
    try {
      applyScopedMigrations(db);
      recordWorkspaceApplyResult(db, input);
      const verification = JSON.stringify(
        input.result.verification.map((item) => ({
          ...item,
          futureAnnotation: { note: 'retained verification' },
        })),
        null,
        2
      );
      db.sqlite
        .prepare('UPDATE workspace_apply_results SET verification_json = ?')
        .run(verification);
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(getWorkspaceApplyResult(db, 'ws_demo', input.result.id)).toEqual(input.result);
      expect(listExportableWorkspaceApplyResults(db, 'ws_demo')).toEqual([
        { ...input.result, requestId: input.requestId },
      ]);
      expect(recordWorkspaceApplyResult(db, input)).toEqual(input.result);
      expect(
        db.sqlite.prepare('SELECT verification_json FROM workspace_apply_results').get()
      ).toEqual({
        verification_json: verification,
      });
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(getWorkspaceApplyResult(db, 'ws_demo', input.result.id)).toEqual(input.result);
      for (const invalid of [
        [{ ...input.result.verification[0], status: 'future', futureAnnotation: true }],
        [{ ...input.result.verification[0], command: '', futureAnnotation: true }],
      ]) {
        db.sqlite
          .prepare('UPDATE workspace_apply_results SET verification_json = ?')
          .run(JSON.stringify(invalid));
        expect(() => getWorkspaceApplyResult(db, 'ws_demo', input.result.id)).toThrow();
      }
      db.sqlite
        .prepare('UPDATE workspace_apply_results SET verification_json = ?, status = ?')
        .run(verification, 'future');
      expect(() => getWorkspaceApplyResult(db, 'ws_demo', input.result.id)).toThrow();
      db.sqlite
        .prepare('UPDATE workspace_apply_results SET status = ?, conflict_records_json = ?')
        .run(
          'conflicted',
          JSON.stringify([{ message: 'not a known conflict string', futureAnnotation: true }])
        );
      expect(() => getWorkspaceApplyResult(db, 'ws_demo', input.result.id)).toThrow();
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('records one linked audit event when an apply result is stored', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-result-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
            retention_class,
            sensitivity_class,
            import_status,
            required_features_json
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
          retention_class: 'workspace-audit',
          sensitivity_class: 'product-safe',
          import_status: 'promoted',
          required_features_json: JSON.stringify(['evidence.bundle.v1']),
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a replay when an existing apply result id has any different payload', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-result-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const baseline = {
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
    } satisfies RecordWorkspaceApplyResultInput;

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceApplyResult(workspaceDb, baseline);

      const conflicts: readonly RecordWorkspaceApplyResultInput[] = [
        { ...baseline, requestId: '00000000-0000-4000-8000-000000000022' },
        { ...baseline, result: { ...baseline.result, appliedAt: '2026-07-05T00:00:01.000Z' } },
        { ...baseline, result: { ...baseline.result, appliedPaths: ['src/other.ts'] } },
        { ...baseline, result: { ...baseline.result, changeSetId: 'wcs_2' } },
        { ...baseline, result: { ...baseline.result, commitIds: ['abc123'] } },
        { ...baseline, result: { ...baseline.result, conflictRecords: ['conflict'] } },
        { ...baseline, result: { ...baseline.result, reviewId: 'swr_2' } },
        { ...baseline, result: { ...baseline.result, skippedPaths: ['src/file.ts'] } },
        { ...baseline, result: { ...baseline.result, status: 'blocked' } },
        {
          ...baseline,
          result: {
            ...baseline.result,
            verification: [{ command: 'pnpm test', ref: null, status: 'passed' }],
          },
        },
      ];

      for (const conflict of conflicts) {
        expect(() => recordWorkspaceApplyResult(workspaceDb, conflict)).toThrow(/conflict/i);
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
