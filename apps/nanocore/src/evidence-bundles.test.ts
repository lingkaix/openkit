import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('accepts exact stable-id replays and rejects divergent content', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const record = {
      id: 'evb_runtime_provenance_replay',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: null,
      turnId: 'turn_demo',
      agentSessionId: 'as_demo',
      backendType: 'openshell',
      sourceKind: 'worker-runtime-provenance-index',
      summary: 'Verified worker runtime provenance index.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
      ],
      contentDigests: ['sha256:index'],
      retentionClass: 'turn-evidence' as const,
      sensitivityClass: 'product-safe' as const,
      importStatus: 'promoted' as const,
      requiredFeatures: ['worker.runtime-provenance.v1'],
      createdAt: '2026-07-13T00:00:00.000Z',
    };

    try {
      applyScopedMigrations(workspaceDb);

      const first = recordWorkspaceEvidenceBundle(workspaceDb, record);
      const replay = recordWorkspaceEvidenceBundle(workspaceDb, record);

      expect(replay).toEqual(first);
      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([first]);
      expect(() =>
        recordWorkspaceEvidenceBundle(workspaceDb, {
          ...record,
          contentDigests: ['sha256:divergent'],
        })
      ).toThrow(/evidence bundle replay conflict/i);
      expect(() =>
        recordWorkspaceEvidenceBundle(workspaceDb, {
          ...record,
          summary: 'Divergent worker runtime provenance index.',
        })
      ).toThrow(/evidence bundle replay conflict/i);
      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([first]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('hides runtime provenance raw refs without changing other restricted projections', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-projection-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_runtime_provenance_raw',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: null,
        turnId: 'turn_demo',
        agentSessionId: 'as_demo',
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-raw',
        summary: 'Restricted worker runtime provenance capture.',
        rawEvidenceRefs: [
          { kind: 'worker-runtime-provenance-manifest', ref: 'raw-streams.json' },
          { kind: 'worker-runtime-provenance-stream', ref: 'raw/stream-0000.jsonl' },
        ],
        redactedEvidenceRefs: [],
        contentDigests: ['sha256:manifest', 'sha256:stream'],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: '2026-07-13T00:00:00.000Z',
      });
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_existing_restricted_turn',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: null,
        turnId: 'turn_demo',
        agentSessionId: 'as_demo',
        backendType: 'openshell',
        sourceKind: 'worker-turn',
        summary: 'Existing restricted worker turn evidence.',
        rawEvidenceRefs: [{ kind: 'turn-log', ref: 'restricted://turn-log' }],
        redactedEvidenceRefs: [{ kind: 'turn', ref: 'turn_demo' }],
        contentDigests: ['sha256:turn'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: '2026-07-13T00:00:01.000Z',
      });

      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          id: 'evb_runtime_provenance_raw',
          rawEvidenceRefs: [],
        }),
        expect.objectContaining({
          id: 'evb_existing_restricted_turn',
          rawEvidenceRefs: [{ kind: 'turn-log', ref: 'restricted://turn-log' }],
          redactedEvidenceRefs: [{ kind: 'turn', ref: 'turn_demo' }],
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('expires old ephemeral diagnostic evidence without deleting governed records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-compaction-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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

  it('rejects compaction outside the open Workspace database lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-lineage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      expect(() =>
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: 'ws_other',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toThrow('Evidence bundle compaction has different Workspace lineage.');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('expires restricted runtime provenance without removing its normalized index', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-expiry-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const rawBundleId = 'evb_runtime_provenance_raw_expired';
    const indexBundleId = 'evb_runtime_provenance_index_retained';
    const rawRoot = join(workspaceRoot, 'evidence', 'backend', rawBundleId);
    const indexPath = join(
      workspaceRoot,
      'evidence',
      'bundles',
      indexBundleId,
      'runtime-origin-index.jsonl'
    );

    try {
      applyScopedMigrations(workspaceDb);
      mkdirSync(join(rawRoot, 'raw'), { recursive: true });
      mkdirSync(join(indexPath, '..'), { recursive: true });
      writeFileSync(join(rawRoot, 'raw-streams.json'), '{"schemaVersion":1}\n');
      writeFileSync(join(rawRoot, 'raw', 'stream-0000.jsonl'), '{"type":"thread.started"}\n');
      writeFileSync(indexPath, '{"runtimeOriginRef":"rto_demo"}\n');
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: rawBundleId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: null,
        turnId: 'turn_demo',
        agentSessionId: 'as_demo',
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-raw',
        summary: 'Restricted worker runtime provenance capture.',
        rawEvidenceRefs: [
          { kind: 'worker-runtime-provenance-manifest', ref: 'raw-streams.json' },
          { kind: 'worker-runtime-provenance-stream', ref: 'raw/stream-0000.jsonl' },
        ],
        redactedEvidenceRefs: [],
        contentDigests: ['sha256:manifest', 'sha256:stream'],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: indexBundleId,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: null,
        turnId: 'turn_demo',
        agentSessionId: 'as_demo',
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-index',
        summary: 'Product-safe worker runtime provenance index.',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
        ],
        contentDigests: ['sha256:index'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: '2026-07-01T00:00:00.000Z',
      });

      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: 'ws_demo',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
      expect(existsSync(rawRoot)).toBe(false);
      expect(readFileSync(indexPath, 'utf8')).toBe('{"runtimeOriginRef":"rto_demo"}\n');
      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: rawBundleId, importStatus: 'expired' }),
          expect.objectContaining({ id: indexBundleId, importStatus: 'promoted' }),
        ])
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('quarantines imported evidence bundles with unknown evidence kinds', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-kind-quarantine-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
          rawEvidenceRefs: [
            { kind: 'worker-runtime-provenance-manifest', ref: 'raw-streams.json' },
            {
              kind: 'worker-runtime-provenance-native-index',
              ref: 'native-origin-index.jsonl',
            },
            { kind: 'worker-runtime-provenance-stream', ref: 'raw/stream-0000.jsonl' },
          ],
          redactedEvidenceRefs: [
            { kind: 'workspace', ref: 'ws_demo' },
            { kind: 'item', ref: 'item_demo' },
            { kind: 'agent-session', ref: 'as_demo' },
            { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
          ],
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
