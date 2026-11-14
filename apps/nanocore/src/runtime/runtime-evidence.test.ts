import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvidenceRecord } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const packageSnapshotId = 'aepsnap_runtime_provenance_1';
    const input = runtimeProvenanceInput(packageSnapshotId);

    try {
      applyScopedMigrations(workspaceDb);

      const first = recordWorkerRuntimeProvenanceEvidence(workspaceDb, input);
      const retained = workspaceDb.sqlite.prepare('SELECT * FROM runtime_evidence').get();
      expect(retained).toMatchObject({ schema_version: 1 });
      const replay = recordWorkerRuntimeProvenanceEvidence(workspaceDb, input);
      const expectedId = `rte_${createHash('sha256')
        .update(`worker-runtime-provenance:${packageSnapshotId}`)
        .digest('hex')
        .slice(0, 24)}`;

      expect(first).toMatchObject({
        id: expectedId,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
        backendType: 'openshell',
        backendVersion: '0.0.80',
        placement: 'local',
        phase: 'transcript-collection',
        summary: input.summary,
        transcriptSummary: input.summary,
        policyDigest: input.policyDigest,
        outcome: 'succeeded',
        evidenceBundleIds: input.evidenceBundleIds,
        contentDigests: input.contentDigests,
        requiredFeatures: ['runtime.evidence.v1', 'worker.runtime-provenance.v1'],
        createdAt: input.collectedAt,
        completedAt: input.collectedAt,
        collectedAt: input.collectedAt,
      });
      expect(replay).toEqual(first);
      expect(workspaceDb.sqlite.prepare('SELECT * FROM runtime_evidence').get()).toEqual(retained);
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([first]);

      for (const divergent of [
        { ...input, policyDigest: `sha256:${'b'.repeat(64)}` },
        { ...input, contentDigests: ['sha256:divergent'] },
        { ...input, summary: 'Divergent worker runtime provenance summary.' },
      ]) {
        expect(() => recordWorkerRuntimeProvenanceEvidence(workspaceDb, divergent)).toThrow(
          /runtime evidence replay conflict/i
        );
      }
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([first]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('strips unknown optional fields from imported runtime evidence', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-evidence-unknown-fields-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      importWorkspaceRuntimeEvidence(workspaceDb, [
        {
          id: 'rte_imported_extra',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          goalId: null,
          taskId: null,
          agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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

      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.not.objectContaining({ futureOptionalNote: expect.anything() })]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

/** Builds native provenance metadata without reading a Worker or Provider. */
function runtimeProvenanceInput(packageSnapshotId: string) {
  return {
    packageSnapshotId,
    policyDigest: `sha256:${'a'.repeat(64)}`,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
    agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
}

it('refuses an unknown runtime evidence row version before malformed JSON or retained replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retained-runtime-evidence-'));
  const input = runtimeProvenanceInput('aepsnap_retained_runtime');
  const db = openWorkspaceDb(root, input.workspaceId);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const record = recordWorkerRuntimeProvenanceEvidence(db, input);
  db.sqlite
    .prepare("UPDATE runtime_evidence SET schema_version=2, upload_manifest_json='{invalid'")
    .run();
  const before = db.sqlite.prepare('SELECT * FROM runtime_evidence').get();
  expect(() => listWorkspaceRuntimeEvidence(db, input.workspaceId)).toThrow(
    'Unsupported retained record format'
  );
  expect(() => recordWorkerRuntimeProvenanceEvidence(db, input)).toThrow(
    'Unsupported retained record format'
  );
  expect(() => importWorkspaceRuntimeEvidence(db, [record])).toThrow(
    'Unsupported retained record format'
  );
  expect(db.sqlite.prepare('SELECT * FROM runtime_evidence').get()).toEqual(before);
});
