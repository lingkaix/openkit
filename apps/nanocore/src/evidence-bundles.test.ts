import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compactWorkspaceEvidenceBundles,
  importWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from './evidence-bundles.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

describe('evidence bundles', () => {
  it('expires old ephemeral diagnostic evidence without deleting governed records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-compaction-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_old_ephemeral',
        workspaceId: 'ws_demo',
        threadId: null,
        goalId: null,
        turnId: null,
        agentSessionId: null,
        backendType: 'openshell',
        sourceKind: 'runtime-diagnostic',
        summary: 'Old runtime diagnostic evidence.',
        rawEvidenceRefs: [{ kind: 'openshell-log', ref: 'restricted://old-log' }],
        redactedEvidenceRefs: [{ kind: 'heartbeat', ref: 'hb_1' }],
        contentDigests: ['sha256:old'],
        retentionClass: 'ephemeral-diagnostic',
        sensitivityClass: 'restricted',
        importStatus: 'collected',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_old_turn',
        workspaceId: 'ws_demo',
        threadId: 'th_1',
        goalId: null,
        turnId: 'turn_1',
        agentSessionId: null,
        backendType: 'openshell',
        sourceKind: 'worker-turn',
        summary: 'Old turn evidence stays governed.',
        rawEvidenceRefs: [{ kind: 'turn-log', ref: 'restricted://turn-log' }],
        redactedEvidenceRefs: [{ kind: 'artifact', ref: 'artifact_1' }],
        contentDigests: ['sha256:turn'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_legal_hold',
        workspaceId: 'ws_demo',
        threadId: null,
        goalId: null,
        turnId: null,
        agentSessionId: null,
        backendType: null,
        sourceKind: 'legal-hold',
        summary: 'Legal hold evidence stays intact.',
        rawEvidenceRefs: [{ kind: 'hold-log', ref: 'restricted://hold-log' }],
        redactedEvidenceRefs: [{ kind: 'hold', ref: 'hold_1' }],
        contentDigests: ['sha256:hold'],
        retentionClass: 'legal-hold',
        sensitivityClass: 'restricted',
        importStatus: 'collected',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: '2026-07-01T00:00:00.000Z',
      });

      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: 'ws_demo',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: 'ws_demo',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 0 });

      const bundles = listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo');

      expect(bundles).toHaveLength(3);
      expect(bundles).toContainEqual(
        expect.objectContaining({
          id: 'evb_old_ephemeral',
          importStatus: 'expired',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [],
          contentDigests: ['sha256:old'],
        })
      );
      expect(bundles).toContainEqual(
        expect.objectContaining({
          id: 'evb_legal_hold',
          importStatus: 'collected',
          rawEvidenceRefs: [{ kind: 'hold-log', ref: 'restricted://hold-log' }],
          redactedEvidenceRefs: [{ kind: 'hold', ref: 'hold_1' }],
        })
      );
      expect(bundles).toContainEqual(
        expect.objectContaining({
          id: 'evb_old_turn',
          importStatus: 'promoted',
          rawEvidenceRefs: [{ kind: 'turn-log', ref: 'restricted://turn-log' }],
          redactedEvidenceRefs: [{ kind: 'artifact', ref: 'artifact_1' }],
        })
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('quarantines imported evidence bundles with unknown evidence kinds', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-kind-quarantine-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      importWorkspaceEvidenceBundles(workspaceDb, [
        {
          id: 'evb_imported_known',
          workspaceId: 'ws_demo',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: null,
          sourceKind: 'manual',
          summary: 'Known imported evidence.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [{ kind: 'workspace', ref: 'ws_demo' }],
          contentDigests: ['sha256:known'],
          retentionClass: 'workspace-audit',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: ['evidence.bundle.v1'],
          createdAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'evb_imported_unknown',
          workspaceId: 'ws_demo',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: 'future-backend',
          sourceKind: 'future-backend',
          summary: 'Unknown imported evidence.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [{ kind: 'future.backend.trace', ref: 'trace_1' }],
          contentDigests: ['sha256:unknown'],
          retentionClass: 'workspace-audit',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: ['evidence.bundle.v1'],
          createdAt: '2026-07-01T00:00:01.000Z',
        },
      ]);

      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          id: 'evb_imported_known',
          importStatus: 'promoted',
        }),
        expect.objectContaining({
          id: 'evb_imported_unknown',
          importStatus: 'quarantined',
          redactedEvidenceRefs: [{ kind: 'future.backend.trace', ref: 'trace_1' }],
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('strips unknown optional fields from imported evidence bundles', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-unknown-fields-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      importWorkspaceEvidenceBundles(workspaceDb, [
        {
          id: 'evb_imported_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: null,
          sourceKind: 'manual',
          summary: 'Imported evidence with a future optional field.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [{ kind: 'workspace', ref: 'ws_demo' }],
          contentDigests: ['sha256:extra'],
          retentionClass: 'workspace-audit',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: ['evidence.bundle.v1'],
          createdAt: '2026-07-01T00:00:00.000Z',
          futureOptionalNote: 'ignored by this reader',
        } as unknown as Parameters<typeof importWorkspaceEvidenceBundles>[1][number],
      ]);

      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([
        expect.not.objectContaining({ futureOptionalNote: expect.anything() }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
