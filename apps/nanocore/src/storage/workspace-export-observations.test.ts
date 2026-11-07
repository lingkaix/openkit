import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import {
  compactWorkspaceEvidenceBundles,
  listStoredWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
  readWorkObservationBody,
  stageWorkObservationChunk,
} from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { digestLlmSystemPrompt } from '../llm/system-prompt-digest.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { appendRecoveredTurnObservation } from './work-observation-recovery.js';
import { appendWorkObservation, readWorkObservations } from './work-observations.js';
import { verifyWorkspaceExportTree, WORKSPACE_EXPORT_MANIFEST_FILE } from './workspace-export.js';
import { createVerifiedWorkspaceExport } from './workspace-transfer-routes.js';

/** Opens the real Workspace evidence owner used by both production portability directions. */
function workspaceDb(dataRoot: string, workspaceId: string) {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(db);
  return db;
}

describe('work observation portable closure', () => {
  it('recovers implicit callRef and explicit runtime corr before archive download', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-runtime-joins-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Runtime joins');
    const thread = await store.createThread(workspace.id, 'Runtime joins');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      'Portable runtime recovery',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { captureCoverage: { scope: 'workspace', value: 'off' } }
    );
    const db = workspaceDb(dataRoot, workspace.id);
    const owner = { threadId: thread.id, turnId: turn.id };
    try {
      const agentSetup = createTestAgentSetup();
      const session = await store.createAgentSession({
        id: 'as_00000000-0000-73ad-ab4c-ebd551f7a576',
        agentId: agentSetup.manifest.id,
        workspaceId: workspace.id,
        threadId: thread.id,
        status: 'idle',
        message: null,
        createdAt: turn.startedAt!,
        updatedAt: turn.startedAt!,
      });
      const environmentPackage = await resolveAgentEnvironmentPackage({
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
      await recordAgentEnvironmentPackageSnapshot(db, {
        createdAt: turn.startedAt!,
        environmentPackage,
      });
      await store.updateAgentSession(session.id, {
        environmentPackageSnapshotId: environmentPackage.snapshotId,
      });
      for (const [index, corr] of [undefined, 'explicit-runtime-group'].entries()) {
        await appendWorkObservation(db, {
          ...owner,
          bodies: [],
          observation: {
            id: `runtime_${index}`,
            type: 'runtime.observed',
            obs: 'worker-shim',
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
      const terminal = await terminalizeGovernedWorkerTurn({
        agentSessionId: null,
        completedAt: turn.startedAt!,
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during NanoCore restart recovery.',
        outcome: 'interrupted',
        requestId: null,
        store,
        turnId: turn.id,
      });
      const reap = await appendRecoveredTurnObservation(db, terminal, 'anchored-cleanup')!;
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
      const exported = await createVerifiedWorkspaceExport({
        fileAdmission: new FileStorageAdmission(dataRoot, () => 0n),
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        authorityUserId: 'usr_00000000-0000-7000-8000-000000000001',
        coreDb,
        dataRoot,
        exportId: testEntityId('wsexp', 'export_runtime_joins'),
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: workspace.id,
      });
      const app = createApp({ coreDb, dataRoot, store });
      const archive = await app.request(
        `/api/app/workspaces/${workspace.id}/exports/${exported.verified.manifest.id}/archive`
      );
      expect(archive.status).toBe(200);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([null, 'ws_00000000-0000-7f9c-aa14-53566c621405'])(
    'validates env.bound source owner (%s)',
    async (foreignOwner) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-environment-'));
      const coreDb = openCoreDb(dataRoot);
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = new FsStore({ dataRoot });
      const demo = createDemoWorkspaceForUser('usr_00000000-0000-7000-8000-000000000001');
      await store.importWorkspaceSnapshot({
        ...notebookImportFixture({ workspaceId: demo.workspace.id, knowledge: [] }),
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
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: demo.workspace.id,
      });
      const turn = await store.createTurn(
        demo.workspace.id,
        demo.thread.id,
        'Portable environment',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null,
        { captureCoverage: { scope: 'workspace', value: 'off' } }
      );
      const db = workspaceDb(dataRoot, demo.workspace.id);
      const environment = {
        version: '0.0.0',
        workspaceId: demo.workspace.id,
        assistantSkillAdmission: {
          catalogRevision: 17,
          skills: [
            {
              skillId: 'historical-source-skill',
              versionId: `sha256:${'c'.repeat(64)}`,
              contentDigest: `sha256:${'c'.repeat(64)}`,
            },
          ],
        },
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
        await appendWorkObservation(db, {
          threadId: demo.thread.id,
          turnId: turn.id,
          observation: {
            id: `env:${turn.id}`,
            type: 'env.bound',
            ts: turn.startedAt!,
            obs: 'nanocore',
            ret: 'turn-evidence',
            payload: { ...environment, workspaceId: demo.workspace.id },
          },
          bodies: [],
        });
        // Publish the actual Core-local terminal before selecting its retained archive fixture.
        await store.completeTurn(turn.id, { status: 'interrupted', completedAt: turn.startedAt! });
        const reapRow = db.sqlite
          .prepare(
            "SELECT record_json FROM control_work_observations WHERE turn_id=? AND json_extract(record_json,'$.type')='turn.reap'"
          )
          .get(turn.id) as { record_json: string };
        const retainedReap = JSON.parse(reapRow.record_json);
        // This test supplies historical recovery bytes; the live native terminal guard remains unchanged.
        db.sqlite
          .prepare(
            "UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND json_extract(record_json,'$.type')='turn.reap'"
          )
          .run(
            JSON.stringify({
              ...retainedReap,
              corr: 'recovery-group',
              parent: `env:${turn.id}`,
              payload: recovery,
            }),
            turn.id
          );
        const exported = await createVerifiedWorkspaceExport({
          fileAdmission: new FileStorageAdmission(dataRoot, () => 0n),
          requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
          authorityUserId: 'usr_00000000-0000-7000-8000-000000000001',
          coreDb,
          dataRoot,
          exportId: testEntityId('wsexp', 'export_environment'),
          repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
          store,
          workspaceId: demo.workspace.id,
        });
        expect(loadWorkspaceResourceCatalog(dataRoot, demo.workspace.id).skills.entries).toEqual(
          []
        );
        const observationFile = [...exported.verified.fileContents.keys()].find((path) =>
          path.endsWith('/observations.jsonl')
        )!;
        if (foreignOwner !== null) {
          // Corrupt the private portable input after a valid export, leaving the live source intact.
          const exportRoot = join(
            dataRoot,
            'server',
            'exports',
            'workspaces',
            demo.workspace.id,
            exported.verified.manifest.id
          );
          const lines = exported.verified.fileContents.get(observationFile)!.split('\n');
          const retained = JSON.parse(lines[0]!);
          expect(retained.type).toBe('env.bound');
          retained.payload.workspaceId = foreignOwner;
          lines[0] = JSON.stringify(retained);
          const text = lines.join('\n');
          writeFileSync(join(exportRoot, observationFile), text);
          const manifest = JSON.parse(exported.verified.manifestText) as {
            contentDigest: string;
            contentInventory: Array<{ path: string; bytes: number; digest: string }>;
          };
          const entry = manifest.contentInventory.find((row) => row.path === observationFile)!;
          entry.bytes = Buffer.byteLength(text);
          entry.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
          manifest.contentDigest = `sha256:${createHash('sha256')
            .update(JSON.stringify(manifest.contentInventory))
            .digest('hex')}`;
          writeFileSync(
            join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE),
            `${JSON.stringify(manifest, null, 2)}\n`
          );
          exported.verified = verifyWorkspaceExportTree({ exportRoot });
          expect(
            JSON.parse(exported.verified.fileContents.get(observationFile)!.split('\n')[0]!).payload
              .workspaceId
          ).toBe(foreignOwner);
        }
        expect(
          JSON.parse(exported.verified.fileContents.get(observationFile)!.split('\n')[0]!).payload
            .assistantSkillAdmission
        ).toEqual(environment.assistantSkillAdmission);
        const app = createApp({ coreDb, dataRoot, store });
        const archive = await app.request(
          `/api/app/workspaces/${demo.workspace.id}/exports/${exported.verified.manifest.id}/archive`
        );
        expect(archive.status).toBe(200);
        const bytes = await archive.arrayBuffer();
        expect(Array.from(new Uint8Array(bytes).subarray(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
        expect(
          readWorkObservations(db, { threadId: demo.thread.id, turnId: turn.id })[0]?.payload
        ).toEqual(environment);
      } finally {
        db.sqlite.close();
        coreDb.sqlite.close();
      }
    }
  );

  it('exports retained restricted originals through publication, hold, and expiry', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-observations-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const demo = createDemoWorkspaceForUser('usr_00000000-0000-7000-8000-000000000001');
    await store.importWorkspaceSnapshot({
      ...notebookImportFixture({ workspaceId: demo.workspace.id, knowledge: [] }),
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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: demo.workspace.id,
    });
    const turn = await store.createTurn(
      demo.workspace.id,
      demo.thread.id,
      'Observe work',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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
      referenceId: 'vault_00000000-0000-701e-8fe9-0839eee2173c',
    });
    const systemSecretFile = readFileSync(
      join(
        dataRoot,
        'server',
        'vault',
        'entries',
        'vault_00000000-0000-701e-8fe9-0839eee2173c',
        '1.enc'
      )
    );
    try {
      await appendWorkObservation(db, {
        threadId: demo.thread.id,
        turnId: turn.id,
        observation: {
          id: 'model_response',
          type: 'model.observed',
          ts: '2026-09-22T00:00:00.000Z',
          obs: 'llm-gateway',
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
      const exported = await createVerifiedWorkspaceExport({
        fileAdmission: new FileStorageAdmission(dataRoot, () => 0n),
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        authorityUserId: 'usr_00000000-0000-7000-8000-000000000001',
        coreDb,
        dataRoot,
        exportId: testEntityId('wsexp', 'export_observations'),
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
              verified.manifest.id,
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
              verified.manifest.id,
              entry.path
            )
          ).equals(bytes)
        )
      ).toBe(true);
      expect(
        [...verified.binaryFileContents.values()].some((value) => Buffer.from(value).equals(bytes))
      ).toBe(true);
      expect(verified.fileContents.get('records/evidence-bundles.jsonl')).not.toContain(
        'evb_unpublished'
      );
      db.sqlite
        .prepare(
          "UPDATE evidence_bundles SET retention_class = 'legal-hold' WHERE evidence_bundle_id = ?"
        )
        .run(sourceBundle.id);
      const heldExport = await createVerifiedWorkspaceExport({
        fileAdmission: new FileStorageAdmission(dataRoot, () => 0n),
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        authorityUserId: 'usr_00000000-0000-7000-8000-000000000001',
        coreDb,
        dataRoot,
        exportId: testEntityId('wsexp', 'export_held_observations'),
        repositoryWorkspaceDb: (id) => workspaceDb(dataRoot, id),
        store,
        workspaceId: demo.workspace.id,
      });
      expect(
        [...heldExport.verified.binaryFileContents.values()].some((value) =>
          Buffer.from(value).equals(bytes)
        )
      ).toBe(true);
      expect(heldExport.verified.fileContents.get('records/evidence-bundles.jsonl')).toContain(
        'legal-hold'
      );
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
      const expiredExport = await createVerifiedWorkspaceExport({
        fileAdmission: new FileStorageAdmission(dataRoot, () => 0n),
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        authorityUserId: 'usr_00000000-0000-7000-8000-000000000001',
        coreDb,
        dataRoot,
        exportId: testEntityId('wsexp', 'export_expired_observations'),
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
              expiredExport.verified.manifest.id,
              entry.path
            )
          ).equals(bytes)
        )
      ).toBe(false);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
