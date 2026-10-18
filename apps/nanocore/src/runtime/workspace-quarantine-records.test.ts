import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListWorkspaceQuarantineRecordsResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  importWorkspaceQuarantineRecords,
  listWorkspaceQuarantineRecords,
  recordWorkspaceQuarantineRecord,
} from './workspace-quarantine-records.js';

const timestamp = '2026-07-08T00:00:00.000Z';

describe('workspace quarantine records', () => {
  it('writes v1 and normalizes retained quarantine annotations without rewriting bytes', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-quarantine-'));
    let workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const original = recordWorkspaceQuarantineRecord(workspaceDb, workspaceQuarantineRecord());
      expect(
        workspaceDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM workspace_quarantine_records')
          .get()
      ).toEqual({ schemaVersion: 1 });
      const annotatedBytes = JSON.stringify({ ...original, futureAnnotation: 'retained' });
      workspaceDb.sqlite
        .prepare('UPDATE workspace_quarantine_records SET payload_json=?')
        .run(annotatedBytes);
      expect(listWorkspaceQuarantineRecords(workspaceDb, workspaceDb.workspaceId)).toEqual([
        original,
      ]);
      expect(
        workspaceDb.sqlite.prepare('SELECT payload_json FROM workspace_quarantine_records').get()
      ).toEqual({ payload_json: annotatedBytes });
      recordWorkspaceQuarantineRecord(workspaceDb, {
        ...workspaceQuarantineRecord(),
        resolution: 'retained',
        updatedAt: timestamp,
        resolvedAt: timestamp,
      });

      workspaceDb.sqlite.close();
      workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

      expect(
        ListWorkspaceQuarantineRecordsResponseSchema.parse({
          items: listWorkspaceQuarantineRecords(
            workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001'
          ),
        }).items
      ).toMatchObject([
        {
          id: 'wqr_1',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          lifecycleRecordIds: ['wrr_1', 'wom_1'],
          failureKind: 'digest_mismatch',
          storageRef: 'quarantine/workspace-sync/ghp_publicFixture',
          retentionClass: 'restricted-evidence',
          requiredHumanDecision: 'inspect_quarantined_output',
          resolution: 'retained',
          resolvedAt: timestamp,
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses an unknown quarantine version before malformed JSON or overwrite', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-quarantine-version-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      applyScopedMigrations(db);
      const record = recordWorkspaceQuarantineRecord(db, workspaceQuarantineRecord());
      db.sqlite
        .prepare('UPDATE workspace_quarantine_records SET schema_version=2,payload_json=?')
        .run('{');

      expect(() => listWorkspaceQuarantineRecords(db, db.workspaceId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        recordWorkspaceQuarantineRecord(db, {
          ...record,
          resolution: 'retained',
          resolvedAt: timestamp,
        })
      ).toThrow('Unsupported retained record format.');
      expect(() => importWorkspaceQuarantineRecords(db, [record])).toThrow(
        'Unsupported retained record format.'
      );
      expect(
        db.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion,payload_json,resolution FROM workspace_quarantine_records'
          )
          .get()
      ).toEqual({ schemaVersion: 2, payload_json: '{', resolution: 'pending' });
    } finally {
      db.sqlite.close();
    }
  });
});

/** Returns one product-safe workspace quarantine record. */
function workspaceQuarantineRecord() {
  return {
    id: 'wqr_1',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    lifecycleRecordIds: ['wrr_1', 'wom_1'],
    failureKind: 'digest_mismatch',
    storageRef: 'quarantine/workspace-sync/ghp_publicFixture',
    retentionClass: 'restricted-evidence',
    requiredHumanDecision: 'inspect_quarantined_output',
    resolution: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
  };
}
