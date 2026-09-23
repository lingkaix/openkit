import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listStoredWorkspaceEvidenceBundles,
  readWorkObservationBody,
  stageWorkObservationChunk,
} from '../evidence-bundles.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
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
  it('publishes reminted observations through real storage, preserves coverage after restart, and never exports restricted originals', () => {
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
        [...verified.fileContents.values()].some((text) => text.includes(bytes.toString()))
      ).toBe(false);
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
      const importedDb = workspaceDb(dataRoot, targetWorkspaceId);
      try {
        const rows = readWorkObservations(importedDb, {
          threadId: targetThread.id,
          turnId: targetTurn.id,
        });
        expect(rows).toHaveLength(2);
        expect(rows[1]!.parent).toBe(rows[0]!.id);
        expect(rows[0]!.corr).toBe('call_1');
        const bundle = listStoredWorkspaceEvidenceBundles(importedDb, targetWorkspaceId)[0]!;
        expect(bundle.importStatus).toBe('expired');
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
        ).toBeNull();
        expect(
          existsSync(
            join(dataRoot, 'workspaces', targetWorkspaceId, 'evidence', 'backend', bundle.id)
          )
        ).toBe(false);
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
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
