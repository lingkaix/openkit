import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compactWorkspaceEvidenceBundles,
  listStoredWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
  readWorkObservationBody,
  stageWorkObservationChunk,
} from '../evidence-bundles.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { appendWorkObservation, readWorkObservations } from './work-observations.js';
import {
  createVerifiedWorkspaceExport,
  importVerifiedWorkspace,
} from './workspace-transfer-routes.js';

/** Opens the real Workspace evidence owner used by both production portability directions. */
function workspaceDb(dataRoot: string, workspaceId: string) {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(db);
  return db;
}

describe('work observation portable closure', () => {
  it('round-trips retained restricted originals through real storage with reminted publication closure', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-observations-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('user_local', 'Local user', 'local@example.com', false, 0, 0, 'human')"
      )
      .run();
    const store = new FsStore({ dataRoot });
    const demo = createDemoWorkspaceForUser('user_local');
    store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: demo.workspace.id,
    });
    const turn = store.createTurn(
      demo.workspace.id,
      demo.thread.id,
      'Observe work',
      { kind: 'user', id: 'user_local' },
      null,
      { captureCoverage: { scope: 'workspace', value: 'on' } }
    );
    const db = workspaceDb(dataRoot, demo.workspace.id);
    const bytes = Buffer.from('  exact original é\n\tfinal  ');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 17),
      storeDir: join(dataRoot, 'server', 'vault'),
    }).store({
      material: 'system_secret_export_canary',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_export_canary',
    });
    const systemSecretFile = readFileSync(
      join(dataRoot, 'server', 'vault', 'entries', 'vault_export_canary', '1.enc')
    );
    try {
      appendWorkObservation(db, {
        threadId: demo.thread.id,
        turnId: turn.id,
        observation: {
          id: 'model_response',
          type: 'model.observed',
          ts: '2026-09-22T00:00:00.000Z',
          obs: 'gateway',
          corr: 'call_1',
          payload: {
            attempt: 0,
            direction: 'response',
            event: 'text_end',
            runtimeOriginRef: null,
            content: { state: 'expected' },
          },
        },
        bodies: [{ id: 'body_1', bytes, mediaType: 'text/plain', boundary: 'assistant.text' }],
      });
      const sourceBundle = listStoredWorkspaceEvidenceBundles(db, demo.workspace.id)[0]!;
      expect(listWorkspaceEvidenceBundles(db, demo.workspace.id)).toEqual([]);
      expect(
        readWorkObservationBody(db, {
          bundleId: sourceBundle.id,
          threadId: demo.thread.id,
          turnId: turn.id,
          createdAt: sourceBundle.createdAt,
          sha256,
        })
      ).toEqual(bytes);
      stageWorkObservationChunk(db, {
        bundleId: 'evb_unpublished',
        threadId: demo.thread.id,
        turnId: turn.id,
        createdAt: '2026-09-22T00:00:01.000Z',
        sha256: createHash('sha256').update('xy').digest('hex'),
        totalBytes: 2,
        chunkCount: 2,
        chunkIndex: 0,
        byteOffset: 0,
        bytes: Buffer.from('x'),
      });
      const exported = createVerifiedWorkspaceExport({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        exportId: 'export_observations',
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: demo.workspace.id,
      });
      const verified = exported.verified;
      expect(
        verified.manifest.contentInventory.some((entry) =>
          readFileSync(
            join(
              dataRoot,
              'server',
              'exports',
              'workspaces',
              demo.workspace.id,
              'export_observations',
              entry.path
            )
          ).equals(systemSecretFile)
        )
      ).toBe(false);
      expect(
        verified.manifest.contentInventory.some((entry) =>
          readFileSync(
            join(
              dataRoot,
              'server',
              'exports',
              'workspaces',
              demo.workspace.id,
              'export_observations',
              entry.path
            )
          ).equals(bytes)
        )
      ).toBe(true);
      expect(verified.fileContents.get('records/evidence-bundles.jsonl')).not.toContain(
        'evb_unpublished'
      );
      const result = importVerifiedWorkspace({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        requestId: null,
        store,
        verified,
      });
      const targetWorkspaceId = result.importedWorkspaceId;
      const targetThread = store.listThreads(targetWorkspaceId)[0]!;
      const targetTurn = store.listThreadTurns(targetWorkspaceId, targetThread.id)[0]!;
      expect(targetWorkspaceId).not.toBe(demo.workspace.id);
      expect(targetThread.id).not.toBe(demo.thread.id);
      expect(targetTurn.id).not.toBe(turn.id);
      const importedDb = workspaceDb(dataRoot, targetWorkspaceId);
      try {
        const rows = readWorkObservations(importedDb, {
          threadId: targetThread.id,
          turnId: targetTurn.id,
        });
        expect(rows).toHaveLength(2);
        expect(rows[0]!.id).not.toBe('model_response');
        expect(rows[1]!.parent).toBe(rows[0]!.id);
        expect(rows[0]!.corr).toBe('call_1');
        const bundle = listStoredWorkspaceEvidenceBundles(importedDb, targetWorkspaceId)[0]!;
        expect(listWorkspaceEvidenceBundles(importedDb, targetWorkspaceId)).toEqual([]);
        expect(bundle.id).not.toBe(sourceBundle.id);
        expect(bundle.importStatus).toBe('promoted');
        expect(bundle.retentionClass).toBe(sourceBundle.retentionClass);
        expect(bundle.sensitivityClass).toBe(sourceBundle.sensitivityClass);
        expect(bundle.createdAt).toBe(sourceBundle.createdAt);
        expect(bundle.contentDigests).toEqual([sha256]);
        expect(bundle.rawEvidenceRefs).toEqual(sourceBundle.rawEvidenceRefs);
        expect(rows[1]!.refs?.[0]).toMatchObject({
          locator: bundle.id,
          scope: { workspaceId: targetWorkspaceId },
          digest: sha256,
        });
        expect(
          readWorkObservationBody(importedDb, {
            bundleId: bundle.id,
            threadId: targetThread.id,
            turnId: targetTurn.id,
            createdAt: bundle.createdAt,
            sha256,
          })
        ).toEqual(bytes);
        expect(
          existsSync(
            join(dataRoot, 'workspaces', targetWorkspaceId, 'evidence', 'backend', bundle.id)
          )
        ).toBe(true);
      } finally {
        importedDb.sqlite.close();
      }
      expect(store.getTurnCaptureCoverage(targetTurn.id)).toEqual({
        scope: 'workspace',
        value: 'on',
      });
      const restarted = new FsStore({ dataRoot });
      expect(restarted.getTurnCaptureCoverage(targetTurn.id)).toEqual({
        scope: 'workspace',
        value: 'on',
      });
      const reopenedDb = workspaceDb(dataRoot, targetWorkspaceId);
      try {
        const bundle = listStoredWorkspaceEvidenceBundles(reopenedDb, targetWorkspaceId)[0]!;
        expect(
          readWorkObservationBody(reopenedDb, {
            bundleId: bundle.id,
            threadId: targetThread.id,
            turnId: targetTurn.id,
            createdAt: bundle.createdAt,
            sha256,
          })
        ).toEqual(bytes);
      } finally {
        reopenedDb.sqlite.close();
      }
      const rawTurn = JSON.parse(
        readFileSync(
          join(
            dataRoot,
            'workspaces',
            targetWorkspaceId,
            'threads',
            targetThread.id,
            'turns',
            targetTurn.id,
            'turn.json'
          ),
          'utf8'
        )
      );
      expect(rawTurn.requiredFeatures).toContain('openkit.work-observations.v1');
      db.sqlite
        .prepare(
          "UPDATE evidence_bundles SET retention_class = 'legal-hold' WHERE evidence_bundle_id = ?"
        )
        .run(sourceBundle.id);
      const heldExport = createVerifiedWorkspaceExport({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        exportId: 'export_held_observations',
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: demo.workspace.id,
      });
      const heldImport = importVerifiedWorkspace({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        requestId: null,
        store,
        verified: heldExport.verified,
      });
      const heldDb = workspaceDb(dataRoot, heldImport.importedWorkspaceId);
      try {
        const heldBundle = listStoredWorkspaceEvidenceBundles(
          heldDb,
          heldImport.importedWorkspaceId
        )[0]!;
        expect(heldBundle.retentionClass).toBe('legal-hold');
        expect(
          readWorkObservationBody(heldDb, {
            bundleId: heldBundle.id,
            threadId: heldBundle.threadId!,
            turnId: heldBundle.turnId!,
            createdAt: heldBundle.createdAt,
            sha256,
          })
        ).toEqual(bytes);
      } finally {
        heldDb.sqlite.close();
      }
      db.sqlite
        .prepare(
          "UPDATE evidence_bundles SET retention_class = 'restricted-raw' WHERE evidence_bundle_id = ?"
        )
        .run(sourceBundle.id);
      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb: db,
          workspaceId: demo.workspace.id,
          olderThan: '2026-09-23T00:00:00.000Z',
        }).expiredCount
      ).toBe(2);
      const expiredExport = createVerifiedWorkspaceExport({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        exportId: 'export_expired_observations',
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: demo.workspace.id,
      });
      expect(
        expiredExport.verified.manifest.contentInventory.some((entry) =>
          readFileSync(
            join(
              dataRoot,
              'server',
              'exports',
              'workspaces',
              demo.workspace.id,
              'export_expired_observations',
              entry.path
            )
          ).equals(bytes)
        )
      ).toBe(false);
      const expiredImport = importVerifiedWorkspace({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        requestId: null,
        store,
        verified: expiredExport.verified,
      });
      const expiredDb = workspaceDb(dataRoot, expiredImport.importedWorkspaceId);
      try {
        const expiredBundle = listStoredWorkspaceEvidenceBundles(
          expiredDb,
          expiredImport.importedWorkspaceId
        )[0]!;
        expect(expiredBundle.importStatus).toBe('expired');
        expect(expiredBundle.rawEvidenceRefs).toEqual([]);
        expect(
          readWorkObservationBody(expiredDb, {
            bundleId: expiredBundle.id,
            threadId: expiredBundle.threadId!,
            turnId: expiredBundle.turnId!,
            createdAt: expiredBundle.createdAt,
            sha256,
          })
        ).toBeNull();
      } finally {
        expiredDb.sqlite.close();
      }
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
