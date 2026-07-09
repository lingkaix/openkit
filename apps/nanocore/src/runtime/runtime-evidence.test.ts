import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvidenceRecord } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  importWorkspaceRuntimeEvidence,
  listWorkspaceRuntimeEvidence,
} from './runtime-evidence.js';

describe('runtime evidence', () => {
  it('strips unknown optional fields from imported runtime evidence', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-evidence-unknown-fields-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      importWorkspaceRuntimeEvidence(workspaceDb, [
        {
          id: 'rte_imported_extra',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          goalId: null,
          taskId: null,
          agentSessionId: 'session_demo',
          backendType: 'openshell',
          backendVersion: '0.0.63',
          placement: 'local',
          phase: 'teardown',
          summary: 'Imported runtime evidence.',
          policyDigest: 'sha256:policy',
          workerImage: null,
          sandboxSummary: 'sandbox demo',
          capabilitySummary: 'worker turn',
          uploadManifest: [],
          downloadManifest: [],
          transcriptSummary: null,
          workspaceChangeSummary: null,
          controlSummary: null,
          outcome: 'succeeded',
          exitCode: 0,
          signal: null,
          stopReason: 'completed',
          errorCode: null,
          errorMessage: null,
          redactedStdoutSummary: null,
          redactedStderrSummary: null,
          evidenceBundleIds: [],
          contentDigests: ['sha256:runtime'],
          requiredFeatures: ['runtime.evidence.v1'],
          createdAt: '2026-07-01T00:00:00.000Z',
          startedAt: '2026-07-01T00:00:00.000Z',
          completedAt: '2026-07-01T00:00:01.000Z',
          collectedAt: '2026-07-01T00:00:02.000Z',
          futureOptionalNote: 'ignored by this reader',
        } as RuntimeEvidenceRecord,
      ]);

      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toEqual([
        expect.not.objectContaining({ futureOptionalNote: expect.anything() }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
