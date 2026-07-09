import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  listWorkspaceSyncEvidenceBundles,
  recordWorkspaceSyncEvidenceBundle,
} from './workspace-sync-evidence-bundles.js';

const timestamp = '2026-07-08T00:00:00.000Z';

describe('workspace sync evidence bundles', () => {
  it('records durable workspace synchronization evidence linkage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-evidence-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceSyncEvidenceBundle(workspaceDb, workspaceSyncEvidenceBundle());
      recordWorkspaceSyncEvidenceBundle(workspaceDb, {
        ...workspaceSyncEvidenceBundle(),
        evidenceBundleIds: ['evb_workspace_materialization_wmr_1', 'evb_workspace_review_swr_1'],
      });

      expect(listWorkspaceSyncEvidenceBundles(workspaceDb, 'ws_demo')).toMatchObject([
        {
          id: 'wseb_1',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_1', 'wom_1'],
          evidenceBundleIds: ['evb_workspace_materialization_wmr_1', 'evb_workspace_review_swr_1'],
          backendEvidenceRefs: [{ kind: 'backend.openshell', ref: 'session/session_1/output' }],
          redactedEvidenceManifest: [
            {
              kind: 'worker-log',
              ref: 'evidence/workspace-sync/wseb_1/log',
              digest: 'sha256:log',
              bytes: 42,
            },
          ],
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

/** Returns one product-safe workspace sync evidence bundle. */
function workspaceSyncEvidenceBundle() {
  return {
    id: 'wseb_1',
    workspaceId: 'ws_demo',
    lifecycleRecordIds: ['wrr_1', 'wom_1'],
    evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
    backendEvidenceRefs: [{ kind: 'backend.openshell', ref: 'session/session_1/output' }],
    redactedEvidenceManifest: [
      {
        kind: 'worker-log',
        ref: 'evidence/workspace-sync/wseb_1/log',
        digest: 'sha256:log',
        bytes: 42,
      },
    ],
    contentDigests: ['sha256:bundle'],
    retentionClass: 'workspace-audit',
    createdAt: timestamp,
  };
}
