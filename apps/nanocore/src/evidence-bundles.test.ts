import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceBundleRecord } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import {
  compactWorkspaceEvidenceBundles,
  importWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from './evidence-bundles.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

/** An old restricted bundle eligible for physical compaction. */
function restrictedBundle(workspaceId: string, id: string): EvidenceBundleRecord {
  return {
    id,
    workspaceId,
    threadId: null,
    goalId: null,
    turnId: null,
    agentSessionId: null,
    backendType: null,
    sourceKind: 'work-observation-body',
    summary: 'Restricted evidence.',
    rawEvidenceRefs: [{ kind: 'work-observation-body', ref: 'raw/content' }],
    redactedEvidenceRefs: [],
    contentDigests: [],
    retentionClass: 'restricted-raw',
    sensitivityClass: 'restricted',
    importStatus: 'promoted',
    requiredFeatures: [],
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('evidence bundles', () => {
  it.each([
    'record',
    'import',
  ] as const)('refuses the shared digest namespace at %s admission and preserves canonical bytes', (admission) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-namespace-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const bytes = Buffer.from('Canonical content shared by retained records.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const namespace = join(
      dataRoot,
      'workspaces',
      workspaceDb.workspaceId,
      'evidence',
      'backend',
      'sha256'
    );
    const path = join(namespace, digest);

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      mkdirSync(namespace, { recursive: true });
      writeFileSync(path, bytes);
      const record = restrictedBundle(workspaceDb.workspaceId, 'sha256');
      expect
        .soft(() => {
          if (admission === 'record') recordWorkspaceEvidenceBundle(workspaceDb, record);
          else importWorkspaceEvidenceBundles(workspaceDb, [record]);
        })
        .toThrow(/reserved evidence bundle id/i);
      expect
        .soft(
          compactWorkspaceEvidenceBundles({
            workspaceDb,
            workspaceId: workspaceDb.workspaceId,
            olderThan: '2026-07-02T00:00:00.000Z',
          })
        )
        .toEqual({ expiredCount: 0 });
      expect(existsSync(path) ? readFileSync(path) : null).toEqual(bytes);
      expect(workspaceDb.sqlite.prepare('SELECT * FROM evidence_bundles').all()).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'promoted',
    'expired',
  ] as const)('refuses a retained %s namespace collision before deleting bytes or updating any row', (status) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-preflight-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const backend = join(dataRoot, 'workspaces', workspaceDb.workspaceId, 'evidence', 'backend');
    const bytes = Buffer.from('Republished canonical content.');
    const path = join(backend, 'sha256', createHash('sha256').update(bytes).digest('hex'));
    const ordinaryPath = join(backend, 'evb_first', 'raw', 'content');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      recordWorkspaceEvidenceBundle(
        workspaceDb,
        restrictedBundle(workspaceDb.workspaceId, 'evb_first')
      );
      recordWorkspaceEvidenceBundle(
        workspaceDb,
        restrictedBundle(workspaceDb.workspaceId, 'evb_collision')
      );
      // Seed a predecessor row without passing through current admission.
      workspaceDb.sqlite
        .prepare(
          "UPDATE evidence_bundles SET evidence_bundle_id = 'sha256', import_status = ? WHERE evidence_bundle_id = 'evb_collision'"
        )
        .run(status);
      mkdirSync(join(backend, 'sha256'), { recursive: true });
      mkdirSync(join(ordinaryPath, '..'), { recursive: true });
      writeFileSync(path, bytes);
      writeFileSync(ordinaryPath, 'Ordinary restricted bytes.');
      const before = workspaceDb.sqlite
        .prepare('SELECT * FROM evidence_bundles ORDER BY evidence_bundle_id')
        .all();

      expect
        .soft(() =>
          compactWorkspaceEvidenceBundles({
            workspaceDb,
            workspaceId: workspaceDb.workspaceId,
            olderThan: '2026-07-02T00:00:00.000Z',
          })
        )
        .toThrow(/reserved evidence bundle id/i);
      expect.soft(existsSync(path) ? readFileSync(path) : null).toEqual(bytes);
      expect
        .soft(existsSync(ordinaryPath) ? readFileSync(ordinaryPath, 'utf8') : null)
        .toBe('Ordinary restricted bytes.');
      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM evidence_bundles ORDER BY evidence_bundle_id')
          .all()
      ).toEqual(before);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('does not delete bytes again for an already-expired restricted bundle', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-repeat-compaction-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const root = join(
      dataRoot,
      'workspaces',
      workspaceDb.workspaceId,
      'evidence',
      'backend',
      'evb_expired'
    );
    const path = join(root, 'raw', 'content');
    const input = {
      workspaceDb,
      workspaceId: workspaceDb.workspaceId,
      olderThan: '2026-07-02T00:00:00.000Z',
    };

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      recordWorkspaceEvidenceBundle(
        workspaceDb,
        restrictedBundle(workspaceDb.workspaceId, 'evb_expired')
      );
      mkdirSync(join(root, 'raw'), { recursive: true });
      writeFileSync(path, 'Original bytes.');
      expect(compactWorkspaceEvidenceBundles(input)).toEqual({ expiredCount: 1 });
      expect(existsSync(root)).toBe(false);
      const expired = workspaceDb.sqlite.prepare('SELECT * FROM evidence_bundles').all();
      mkdirSync(join(root, 'raw'), { recursive: true });
      writeFileSync(path, 'Later bytes.');

      expect(compactWorkspaceEvidenceBundles(input)).toEqual({ expiredCount: 0 });
      expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe('Later bytes.');
      expect(workspaceDb.sqlite.prepare('SELECT * FROM evidence_bundles').all()).toEqual(expired);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('accepts exact stable-id replays and rejects divergent content', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const record = {
      id: 'evb_runtime_provenance_replay',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      goalId: null,
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

      const first = recordWorkspaceEvidenceBundle(workspaceDb, record);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT schema_version FROM evidence_bundles WHERE evidence_bundle_id = ?')
          .get(record.id)
      ).toEqual({ schema_version: 1 });
      const replay = recordWorkspaceEvidenceBundle(workspaceDb, record);

      expect(replay).toEqual(first);
      expect(
        listWorkspaceEvidenceBundles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([first]);
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
      expect(
        listWorkspaceEvidenceBundles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([first]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unknown retained evidence format before replay or JSON decode', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const record = {
      id: 'evb_runtime_provenance_replay',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      goalId: null,
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
      backendType: 'openshell',
      sourceKind: 'worker-runtime-provenance-index',
      summary: 'Verified worker runtime provenance index.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
      ],
      contentDigests: ['sha256:index'],
      retentionClass: 'ephemeral-diagnostic' as const,
      sensitivityClass: 'product-safe' as const,
      importStatus: 'promoted' as const,
      requiredFeatures: ['worker.runtime-provenance.v1'],
      createdAt: '2026-07-13T00:00:00.000Z',
    };

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

      recordWorkspaceEvidenceBundle(workspaceDb, record);
      workspaceDb.sqlite
        .prepare(
          "UPDATE evidence_bundles SET schema_version = 2, raw_evidence_refs_json = 'invalid-json' WHERE evidence_bundle_id = ?"
        )
        .run(record.id);
      expect(() => recordWorkspaceEvidenceBundle(workspaceDb, record)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => listWorkspaceEvidenceBundles(workspaceDb, record.workspaceId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: record.workspaceId,
          olderThan: '2026-07-14T00:00:00.000Z',
        })
      ).toThrow('Unsupported retained record format.');
      expect(
        workspaceDb.sqlite
          .prepare(
            'SELECT schema_version, raw_evidence_refs_json FROM evidence_bundles WHERE evidence_bundle_id = ?'
          )
          .get(record.id)
      ).toEqual({ schema_version: 2, raw_evidence_refs_json: 'invalid-json' });
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('hides runtime provenance raw refs without changing other restricted projections', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-projection-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_runtime_provenance_raw',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: null,
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: null,
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
        backendType: 'openshell',
        sourceKind: 'worker-turn',
        summary: 'Existing restricted worker turn evidence.',
        rawEvidenceRefs: [{ kind: 'turn-log', ref: 'restricted://turn-log' }],
        redactedEvidenceRefs: [{ kind: 'turn', ref: 'tu_00000000-0000-77e3-bfde-66477d556f64' }],
        contentDigests: ['sha256:turn'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: '2026-07-13T00:00:01.000Z',
      });

      expect(
        listWorkspaceEvidenceBundles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([
        expect.objectContaining({
          id: 'evb_runtime_provenance_raw',
          rawEvidenceRefs: [],
        }),
        expect.objectContaining({
          id: 'evb_existing_restricted_turn',
          rawEvidenceRefs: [{ kind: 'turn-log', ref: 'restricted://turn-log' }],
          redactedEvidenceRefs: [{ kind: 'turn', ref: 'tu_00000000-0000-77e3-bfde-66477d556f64' }],
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('expires old ephemeral diagnostic evidence without deleting governed records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-compaction-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: 'evb_old_ephemeral',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
        goalId: null,
        turnId: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 0 });

      const bundles = listWorkspaceEvidenceBundles(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      expect(() =>
        compactWorkspaceEvidenceBundles({
          workspaceDb,
          workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toThrow('Evidence bundle compaction has different Workspace lineage.');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('expires restricted runtime provenance without removing its normalized index', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-expiry-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001');
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
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      mkdirSync(join(rawRoot, 'raw'), { recursive: true });
      mkdirSync(join(indexPath, '..'), { recursive: true });
      writeFileSync(join(rawRoot, 'raw-streams.json'), '{"schemaVersion":1}\n');
      writeFileSync(join(rawRoot, 'raw', 'stream-0000.jsonl'), '{"type":"thread.started"}\n');
      writeFileSync(indexPath, '{"runtimeOriginRef":"rto_demo"}\n');
      recordWorkspaceEvidenceBundle(workspaceDb, {
        id: rawBundleId,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: null,
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: null,
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          olderThan: '2026-07-02T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
      expect(existsSync(rawRoot)).toBe(false);
      expect(readFileSync(indexPath, 'utf8')).toBe('{"runtimeOriginRef":"rto_demo"}\n');
      expect(
        listWorkspaceEvidenceBundles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual(
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

      importWorkspaceEvidenceBundles(workspaceDb, [
        {
          id: 'evb_imported_known',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            { kind: 'workspace', ref: 'ws_00000000-0000-7000-8000-000000000001' },
            { kind: 'item', ref: 'item_demo' },
            { kind: 'agent-session', ref: 'as_00000000-0000-7860-9e37-d1a60b30c856' },
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

      expect(
        listWorkspaceEvidenceBundles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

      importWorkspaceEvidenceBundles(workspaceDb, [
        {
          id: 'evb_imported_extra',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: null,
          sourceKind: 'manual',
          summary: 'Imported evidence with a future optional field.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [
            { kind: 'workspace', ref: 'ws_00000000-0000-7000-8000-000000000001' },
          ],
          contentDigests: ['sha256:extra'],
          retentionClass: 'workspace-audit',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: ['evidence.bundle.v1'],
          createdAt: '2026-07-01T00:00:00.000Z',
          futureOptionalNote: 'ignored by this reader',
        } as unknown as Parameters<typeof importWorkspaceEvidenceBundles>[1][number],
      ]);

      expect(
        listWorkspaceEvidenceBundles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.not.objectContaining({ futureOptionalNote: expect.anything() })]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
