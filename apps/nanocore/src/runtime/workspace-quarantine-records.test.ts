import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListWorkspaceQuarantineRecordsResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  listWorkspaceQuarantineRecords,
  recordWorkspaceQuarantineRecord,
} from './workspace-quarantine-records.js';

const timestamp = '2026-07-08T00:00:00.000Z';

describe('workspace quarantine records', () => {
  it('records durable quarantine decisions for workspace synchronization recovery', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-quarantine-'));
    let workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceQuarantineRecord(workspaceDb, workspaceQuarantineRecord());
      recordWorkspaceQuarantineRecord(workspaceDb, {
        ...workspaceQuarantineRecord(),
        resolution: 'retained',
        updatedAt: timestamp,
        resolvedAt: timestamp,
      });

      workspaceDb.sqlite.close();
      workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

      expect(
        ListWorkspaceQuarantineRecordsResponseSchema.parse({
          items: listWorkspaceQuarantineRecords(workspaceDb, 'ws_demo'),
        }).items
      ).toMatchObject([
        {
          id: 'wqr_1',
          workspaceId: 'ws_demo',
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
    }
  });
});

/** Returns one product-safe workspace quarantine record. */
function workspaceQuarantineRecord() {
  return {
    id: 'wqr_1',
    workspaceId: 'ws_demo',
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
