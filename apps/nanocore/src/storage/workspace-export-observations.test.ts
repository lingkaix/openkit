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
import { digestLlmSystemPrompt } from '../llm/system-prompt-digest.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { appendRecoveredTurnObservation } from './work-observation-recovery.js';
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
  it('preserves runtime recovery joins inside two reminted archive import groups', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-runtime-joins-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('user_local', 'Local user', 'local@example.com', false, 0, 0, 'human')"
      )
      .run();
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Runtime joins');
    const thread = store.createThread(workspace.id, 'Runtime joins');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Portable runtime recovery',
      { kind: 'user', id: 'user_local' },
      null,
      { captureCoverage: { scope: 'workspace', value: 'off' } }
    );
    const db = workspaceDb(dataRoot, workspace.id);
    const owner = { threadId: thread.id, turnId: turn.id };
    try {
      const agentSetup = createTestAgentSetup();
      const session = store.createAgentSession({
        id: 'as_portable_runtime',
        agentId: agentSetup.manifest.id,
        workspaceId: workspace.id,
        threadId: thread.id,
        status: 'idle',
        message: null,
        createdAt: turn.startedAt!,
        updatedAt: turn.startedAt!,
      });
      const environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'workspace', value: 'off' },
        agentSetup,
        agentSessionId: session.id,
        triggerActor: turn.triggerActor,
        backend: { kind: 'openshell' },
        requestId: 'portable-runtime',
        turn,
        turnInput: 'Portable runtime recovery',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      recordAgentEnvironmentPackageSnapshot(db, {
        createdAt: turn.startedAt!,
        environmentPackage,
      });
      store.updateAgentSession(session.id, {
        environmentPackageSnapshotId: environmentPackage.snapshotId,
      });
      for (const [index, corr] of [undefined, 'explicit-runtime-group'].entries()) {
        appendWorkObservation(db, {
          ...owner,
          bodies: [],
          observation: {
            id: `runtime_${index}`,
            type: 'runtime.observed',
            obs: 'sidecar',
            ts: turn.startedAt!,
            ...(corr === undefined ? {} : { corr }),
            payload: {
              observationId: `runtime_${index}`,
              sourceRef: `source_${index}`,
              sourceSequence: index + 1,
              observedAt: turn.startedAt!,
              fact: {
                kind: 'tool',
                runtimeOriginRef: null,
                callRef: index === 0 ? 'runtime-call-source' : 'runtime-explicit-call-source',
                phase: 'started',
                toolName: 'example.read',
              },
              content: { state: 'off' },
            },
          },
        });
      }
      const terminal = terminalizeGovernedWorkerTurn({
        agentSessionId: null,
        completedAt: turn.startedAt!,
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during NanoCore restart recovery.',
        outcome: 'interrupted',
        requestId: null,
        store,
        turnId: turn.id,
      });
      const reap = appendRecoveredTurnObservation(db, terminal, 'anchored-cleanup')!;
      const sourceRows = readWorkObservations(db, owner);
      expect(sourceRows[0]).not.toHaveProperty('corr');
      expect(reap.payload.unresolvedCalls).toEqual([
        {
          corr: 'runtime-call-source',
          type: 'runtime.observed',
          name: 'example.read',
          ts: turn.startedAt,
        },
        {
          corr: 'explicit-runtime-group',
          type: 'runtime.observed',
          name: 'example.read',
          ts: turn.startedAt,
        },
      ]);
      createVerifiedWorkspaceExport({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        exportId: 'export_runtime_joins',
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: workspace.id,
      });
      const app = createApp({ coreDb, dataRoot, store });
      const archive = await app.request(
        `/api/app/workspaces/${workspace.id}/exports/export_runtime_joins/archive`
      );
      expect(archive.status).toBe(200);
      const bytes = await archive.arrayBuffer();
      const groupKeys: string[] = [];
      const importedCallRefs: string[] = [];
      for (const requestId of [
        '00000000-0000-4000-8000-000000000062',
        '00000000-0000-4000-8000-000000000063',
      ]) {
        const response = await app.request('/api/app/workspace-archives/import', {
          method: 'POST',
          headers: {
            'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
            'x-openkit-request-id': requestId,
          },
          body: bytes,
        });
        const result = await response.text();
        expect(response.status, result).toBe(200);
        const { importedWorkspaceId } = JSON.parse(result) as { importedWorkspaceId: string };
        const importedThread = store.listThreads(importedWorkspaceId)[0]!;
        const importedTurn = store.listThreadTurns(importedWorkspaceId, importedThread.id)[0]!;
        const importedDb = workspaceDb(dataRoot, importedWorkspaceId);
        try {
          const rows = readWorkObservations(importedDb, {
            threadId: importedThread.id,
            turnId: importedTurn.id,
          });
          expect(rows).toHaveLength(3);
          const fact = rows[0]!.payload.fact as { callRef: string };
          expect(fact.callRef).toMatch(/^rtc_/);
          expect(fact.callRef).not.toBe('runtime-call-source');
          expect(rows[2]?.payload).toEqual(reap.payload);
          const unresolved = rows[2]!.payload.unresolvedCalls as { corr: string }[];
          expect(unresolved[0]?.corr).toBe(rows[0]?.corr);
          expect(rows[0]?.corr).toBe('runtime-call-source');
          expect(unresolved[1]?.corr).toBe(rows[1]?.corr);
          expect(rows[1]?.corr).toBe('explicit-runtime-group');
          expect(rows.every((row) => row.turnId === importedTurn.id)).toBe(true);
          groupKeys.push(JSON.stringify([importedWorkspaceId, importedTurn.id, rows[0]?.corr]));
          importedCallRefs.push(fact.callRef);
        } finally {
          importedDb.sqlite.close();
        }
      }
      expect(new Set(groupKeys).size).toBe(2);
      expect(new Set(importedCallRefs).size).toBe(2);
      expect(readWorkObservations(db, owner)).toEqual(sourceRows);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([null, 'ws_foreign'])('validates env.bound source owner (%s)', async (foreignOwner) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-environment-'));
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
      'Portable environment',
      { kind: 'user', id: 'user_local' },
      null,
      { captureCoverage: { scope: 'workspace', value: 'off' } }
    );
    const db = workspaceDb(dataRoot, demo.workspace.id);
    const environment = {
      version: '0.0.0',
      workspaceId: foreignOwner ?? demo.workspace.id,
      systemPromptDigest: digestLlmSystemPrompt({
        endpoint: 'responses',
        request: { instructions: 'Portable system prompt' },
      }),
      tools: [
        { name: 'example.read', inputSchemaDigest: 'a'.repeat(64) },
        { name: 'example.write', inputSchemaDigest: 'b'.repeat(64) },
      ],
    };
    const recovery = {
      reason: 'restart',
      lastObservedTs: turn.startedAt,
      unresolvedCalls: [{ corr: 'call_1', type: 'model', name: null, ts: turn.startedAt! }],
      inferredBy: 'core-recovery',
    };
    try {
      appendWorkObservation(db, {
        threadId: demo.thread.id,
        turnId: turn.id,
        observation: {
          id: `env:${turn.id}`,
          type: 'env.bound',
          ts: turn.startedAt!,
          obs: 'core',
          ret: 'turn-evidence',
          payload: environment,
        },
        bodies: [],
      });
      appendWorkObservation(db, {
        threadId: demo.thread.id,
        turnId: turn.id,
        observation: {
          id: `reap:${turn.id}`,
          type: 'turn.reap',
          ts: turn.startedAt!,
          obs: 'core',
          corr: 'recovery-group',
          ret: 'turn-evidence',
          payload: recovery,
        },
        bodies: [],
      });
      const exported = createVerifiedWorkspaceExport({
        authorityUserId: 'user_local',
        coreDb,
        dataRoot,
        exportId: 'export_environment',
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: demo.workspace.id,
      });
      const app = createApp({ coreDb, dataRoot, store });
      const archive = await app.request(
        `/api/app/workspaces/${demo.workspace.id}/exports/export_environment/archive`
      );
      expect(archive.status).toBe(200);
      const bytes = await archive.arrayBuffer();
      expect(Array.from(new Uint8Array(bytes).subarray(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
      const workspaceIds = store.listWorkspaces().map((workspace) => workspace.id);
      const imported = await app.request('/api/app/workspace-archives/import', {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
          'x-openkit-request-id': '00000000-0000-4000-8000-000000000061',
        },
        body: bytes,
      });
      const result = await imported.text();
      if (foreignOwner !== null) {
        expect(imported.status, result).toBe(400);
        expect(() =>
          importVerifiedWorkspace({
            authorityUserId: 'user_local',
            coreDb,
            dataRoot,
            requestId: null,
            store,
            verified: exported.verified,
          })
        ).toThrow('Portable env.bound belongs to another workspace: ws_foreign');
        expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(workspaceIds);
        expect(
          readWorkObservations(db, { threadId: demo.thread.id, turnId: turn.id })[0]?.payload
        ).toEqual(environment);
        return;
      }
      expect(imported.status, result).toBe(200);
      const { importedWorkspaceId } = JSON.parse(result) as { importedWorkspaceId: string };
      expect(importedWorkspaceId).not.toBe(demo.workspace.id);
      expect(store.getWorkspace(importedWorkspaceId).importedFrom).toEqual({
        sourceDeploymentId: exported.verified.manifest.sourceDeploymentId,
        sourceWorkspaceId: demo.workspace.id,
        exportCreatedAt: exported.verified.manifest.exportCreatedAt,
        manifestDigest: exported.verified.manifestDigest,
      });
      const thread = store.listThreads(importedWorkspaceId)[0]!;
      const importedTurn = store.listThreadTurns(importedWorkspaceId, thread.id)[0]!;
      const importedDb = workspaceDb(dataRoot, importedWorkspaceId);
      try {
        const rows = readWorkObservations(importedDb, {
          threadId: thread.id,
          turnId: importedTurn.id,
        });
        expect(rows).toHaveLength(2);
        expect(rows[0]?.payload).toEqual({ ...environment, workspaceId: importedWorkspaceId });
        expect(rows[0]?.id).not.toBe(`env:${turn.id}`);
        expect(rows[0]?.turnId).toBe(importedTurn.id);
        expect(rows[1]?.payload).toEqual(recovery);
        expect(rows[1]?.corr).toBe('recovery-group');
      } finally {
        importedDb.sqlite.close();
      }
      expect(
        readWorkObservations(db, { threadId: demo.thread.id, turnId: turn.id })[0]?.payload
      ).toEqual(environment);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

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
