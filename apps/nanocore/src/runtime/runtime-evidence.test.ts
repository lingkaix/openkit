import { createHash } from 'node:crypto';
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
  recordWorkerRuntimeProvenanceEvidence,
} from './runtime-evidence.js';

describe('runtime evidence', () => {
  it('records package-scoped transcript collection evidence idempotently', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-evidence-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const packageSnapshotId = 'aepsnap_runtime_provenance_1';
    const input = {
      packageSnapshotId,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      agentSessionId: 'as_demo',
      backendType: 'openshell',
      backendVersion: '0.0.80',
      placement: 'local' as const,
      summary:
        'Worker runtime provenance complete: 3 streams, 12 frames, 3 origins, 0 gateway calls.',
      evidenceBundleIds: ['evb_runtime_provenance_raw', 'evb_runtime_provenance_index'],
      contentDigests: ['sha256:raw', 'sha256:index'],
      outcome: 'succeeded' as const,
      collectedAt: '2026-07-13T00:00:00.000Z',
    };

    try {
      applyScopedMigrations(workspaceDb);

      const first = recordWorkerRuntimeProvenanceEvidence(workspaceDb, input);
      const replay = recordWorkerRuntimeProvenanceEvidence(workspaceDb, input);
      const expectedId = `rte_${createHash('sha256')
        .update(`worker-runtime-provenance:${packageSnapshotId}`)
        .digest('hex')
        .slice(0, 24)}`;

      expect(first).toMatchObject({
        id: expectedId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        agentSessionId: 'as_demo',
        backendType: 'openshell',
        backendVersion: '0.0.80',
        placement: 'local',
        phase: 'transcript-collection',
        summary: input.summary,
        transcriptSummary: input.summary,
        outcome: 'succeeded',
        evidenceBundleIds: input.evidenceBundleIds,
        contentDigests: input.contentDigests,
        requiredFeatures: ['runtime.evidence.v1', 'worker.runtime-provenance.v1'],
        createdAt: input.collectedAt,
        completedAt: input.collectedAt,
        collectedAt: input.collectedAt,
      });
      expect(replay).toEqual(first);
      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toEqual([first]);

      for (const divergent of [
        { ...input, contentDigests: ['sha256:divergent'] },
        { ...input, summary: 'Divergent worker runtime provenance summary.' },
      ]) {
        expect(() => recordWorkerRuntimeProvenanceEvidence(workspaceDb, divergent)).toThrow(
          /runtime evidence replay conflict/i
        );
      }
      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toEqual([first]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('strips unknown optional fields from imported runtime evidence', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-evidence-unknown-fields-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
