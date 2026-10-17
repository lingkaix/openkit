import { createHash } from 'node:crypto';
import {
  mkdtempSync as createTemporaryDirectory,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentEnvironmentSnapshotReadError,
  listExportableAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
  snapshotDigest,
} from '../runtime/aep-snapshot-ledger.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { turnFilePayloadPath } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from '../workspace-materials.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';

const roots: string[] = [];
/** Tracks fixture roots so database fixtures never survive their test. */
function mkdtempSync(prefix: string): string {
  const root = createTemporaryDirectory(prefix);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('worker Context Package authority reader', () => {
  it('reads the named AEP despite unrelated historical capture omissions and rejects selected corruption', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-authority-aep-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);

    try {
      const turn = store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Run worker',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null,
        { turnId: 'tu_00000000-0000-72cd-966c-00128857206d' }
      );
      const session = store.createAgentSession({
        id: 'as_00000000-0000-777a-9b6e-9393a5c0d8cf',
        agentId: 'agent_codex_host',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        status: 'busy',
        message: null,
        createdAt: turn.startedAt!,
        updatedAt: turn.startedAt!,
      });
      store.updateTurn(turn.id, { agentSessionId: session.id });
      const environmentPackage = resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: session.id,
        backend: { kind: 'openshell' },
        captureCoverage: { scope: 'server', value: 'off' },
        requestId: 'req_current',
        triggerActor: turn.triggerActor,
        turn,
        turnInput: 'Run worker',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: turn.startedAt!,
        environmentPackage,
      });
      store.updateAgentSession(session.id, {
        environmentPackageSnapshotId: environmentPackage.snapshotId,
      });
      const snapshotsRoot = join(
        dataRoot,
        'workspaces',
        'ws_00000000-0000-7000-8000-000000000001',
        'runtime',
        'agent-sessions',
        session.id,
        'aep-snapshots'
      );
      const selectedPath = join(snapshotsRoot, `${environmentPackage.snapshotId}.json`);
      const historicalPath = join(snapshotsRoot, 'aepsnap_historical.json');
      const selectedBytes = readFileSync(selectedPath, 'utf8');
      const historical = JSON.parse(selectedBytes);
      historical.snapshotId = 'aepsnap_historical';
      historical.snapshot.snapshotId = 'aepsnap_historical';
      delete historical.snapshot.observability.captureCoverage;
      historical.contentDigest = snapshotDigest(historical.snapshot);
      const historicalBytes = JSON.stringify(historical);
      writeFileSync(historicalPath, historicalBytes);
      const reader = createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb });

      let exportError: unknown;
      try {
        listExportableAgentEnvironmentPackageSnapshots(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001'
        );
      } catch (error) {
        exportError = error;
      }
      expect(exportError).toBeInstanceOf(AgentEnvironmentSnapshotReadError);
      expect(exportError).toMatchObject({ cause: expect.any(z.ZodError) });
      expect(exportError).toMatchObject({
        cause: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: ['observability', 'captureCoverage'] }),
          ]),
        },
      });
      expect(
        reader.readAgentEnvironmentPackage(
          'ws_00000000-0000-7000-8000-000000000001',
          record.snapshotId
        )
      ).toEqual(record.snapshot);
      // Historical delivery names its snapshot even after the reusable session pointer advances.
      store.updateAgentSession(session.id, { environmentPackageSnapshotId: 'aepsnap_later' });
      expect(
        reader.readAgentEnvironmentPackage(
          'ws_00000000-0000-7000-8000-000000000001',
          record.snapshotId
        )
      ).toEqual(record.snapshot);
      expect(
        reader.readAgentEnvironmentPackage(
          'ws_00000000-0000-7000-8000-000000000001',
          'aepsnap_missing'
        )
      ).toBeNull();
      expect(
        reader.readAgentEnvironmentPackage(
          'ws_00000000-0000-71f5-922f-6fd42f52f580',
          record.snapshotId
        )
      ).toBeNull();
      expect(readFileSync(selectedPath, 'utf8')).toBe(selectedBytes);
      expect(readFileSync(historicalPath, 'utf8')).toBe(historicalBytes);

      const invalidSelected = JSON.parse(selectedBytes);
      delete invalidSelected.snapshot.observability.captureCoverage;
      invalidSelected.contentDigest = snapshotDigest(invalidSelected.snapshot);
      writeFileSync(selectedPath, JSON.stringify(invalidSelected));
      expect(
        reader.readAgentEnvironmentPackage(
          'ws_00000000-0000-7000-8000-000000000001',
          record.snapshotId
        )
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects a Workspace database outside the product store lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-authority-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-71f5-922f-6fd42f52f580');

    try {
      expect(() =>
        createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb })
      ).toThrow('Worker Context Package authority owners have different scopes.');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/** Supplies retained inventory metadata; the map must independently read the actual source owner. */
function sourceInventory(
  source: WorkerContextPackageSourceFile['source']
): WorkerContextPackageSourceFile {
  const digest = `sha256:${'0'.repeat(64)}`;
  return {
    source,
    originalDigest: digest,
    byteLength: 0,
    mediaType: 'application/octet-stream',
    originalSnapshotPath: 'originals/source/payload',
    packagePath: 'sources/source.txt',
    projection: {
      kind: 'descriptor',
      sourceRevision: '1',
      representationId: 'fixture',
      representationDigest: digest,
      representationByteLength: 0,
      deliveredDigest: digest,
      ranges: [],
      byteLength: 0,
      truncated: true,
      availability: 'unavailable',
      originalSnapshotPath: 'originals/source/payload',
    },
  };
}

describe('S39 exact source owner map', () => {
  it('reads actual Artifact version, retained Material revision and immutable Turn ordinal without head substitution', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 's39-source-authorities-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    try {
      const admission = new FileStorageAdmission(dataRoot, () => 0n);
      const original = Buffer.from([0, 255, 1]);
      const originalDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`;
      const stage = join(dataRoot, 'private-input');
      writeFileSync(stage, original);
      const otherStage = join(dataRoot, 'private-other-input');
      writeFileSync(otherStage, original);
      const turn = store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Read original',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null,
        {
          turnId: 'tu_00000000-0000-7000-8000-0000000003ff',
          fileInputs: [
            {
              name: 'source.bin',
              mediaType: 'application/octet-stream',
              sizeBytes: original.byteLength,
              contentDigest: originalDigest,
            },
            {
              name: 'other.bin',
              mediaType: 'application/octet-stream',
              sizeBytes: original.byteLength,
              contentDigest: originalDigest,
            },
          ],
          filePayloadPaths: [stage, otherStage],
          fileWriteAdmission: admission,
        }
      );
      const timestamp = turn.startedAt!;
      const artifactText = '# Source artifact\n';
      const artifactDigest = `sha256:${createHash('sha256').update(artifactText).digest('hex')}`;
      store.createArtifact({
        id: 'ar_00000000-0000-7000-8000-0000000003eb',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        kind: 'file',
        title: 'Source',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'markdown', body: artifactText },
        contentDigest: artifactDigest,
        lastMutationRequestId: 'artifact_create',
        origin: {
          kind: 'turn-output',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          requestId: 'artifact_create',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const material = createWorkspaceMaterial(workspaceDb, {
        acceptedAt: timestamp,
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        kind: 'text',
        requestId: 'material_create',
        sensitivity: 'internal',
        title: 'Source',
      });
      const materialText = 'Original revision';
      const materialDigest = `sha256:${createHash('sha256').update(materialText).digest('hex')}`;
      const revision = saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: timestamp,
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        content: materialText,
        contentDigest: materialDigest,
        expectedRevisionId: null,
        materialId: material.materialId,
        requestId: 'material_first',
      });
      const later = 'Later revision';
      saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: timestamp,
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        content: later,
        contentDigest: `sha256:${createHash('sha256').update(later).digest('hex')}`,
        expectedRevisionId: revision.revisionId,
        materialId: material.materialId,
        requestId: 'material_second',
      });
      const reader = createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb });
      const artifact = sourceInventory({
        kind: 'artifact',
        reference: { scopeId: 'artifact/workspace/ws_00000000-0000-7000-8000-000000000001', objectId: 'ar_00000000-0000-7000-8000-0000000003eb' },
        artifactVersion: 1,
      });
      expect(reader.readSourceFile!(artifact)).toEqual({
        originalDigest: artifactDigest,
        byteLength: Buffer.byteLength(artifactText),
        mediaType: 'text/markdown',
      });
      expect(
        reader.readSourceFile!({
          ...artifact,
          source: { ...artifact.source, kind: 'artifact', artifactVersion: 2 },
        })
      ).toBeNull();
      expect(
        reader.readSourceFile!(
          sourceInventory({
            kind: 'material',
            reference: { scopeId: 'material/workspace/ws_00000000-0000-7000-8000-000000000001', objectId: material.materialId },
            revisionId: revision.revisionId,
          })
        )
      ).toEqual({
        originalDigest: materialDigest,
        byteLength: Buffer.byteLength(materialText),
        mediaType: 'text/plain',
      });
      const input = sourceInventory({
        kind: 'turn-input',
        reference: { scopeId: 'input/turn/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001/tu_00000000-0000-7000-8000-0000000003ff', objectId: '0' },
      });
      expect(reader.readSourceFile!(input)).toEqual({
        originalDigest,
        byteLength: original.byteLength,
        mediaType: 'application/octet-stream',
      });
      expect(
        reader.readSourceFile!(
          sourceInventory({
            kind: 'turn-input',
            reference: { scopeId: 'input/turn/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001/tu_00000000-0000-7000-8000-0000000003ff', objectId: '2' },
          })
        )
      ).toBeNull();
      expect(
        reader.readSourceFile!(
          sourceInventory({
            kind: 'artifact',
            reference: { scopeId: 'artifact/workspace/ws_00000000-0000-7000-8000-000000000402', objectId: 'ar_00000000-0000-7000-8000-0000000003eb' },
            artifactVersion: 1,
          })
        )
      ).toBeNull();
      // An addressed proof scans only that ordinal. Whole-trace admission still checks every selected source.
      writeFileSync(
        turnFilePayloadPath(join(dataRoot, 'workspaces/ws_00000000-0000-7000-8000-000000000001'), 'th_00000000-0000-7000-8000-000000000001', turn.id, 1),
        Buffer.from([0, 254, 1])
      );
      expect(reader.readSourceFile!(input)).toEqual({
        originalDigest,
        byteLength: original.byteLength,
        mediaType: 'application/octet-stream',
      });
      expect(
        reader.readSourceFile!(
          sourceInventory({
            kind: 'turn-input',
            reference: { scopeId: 'input/turn/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001/tu_00000000-0000-7000-8000-0000000003ff', objectId: '1' },
          })
        )
      ).toBeNull();
      writeFileSync(
        turnFilePayloadPath(join(dataRoot, 'workspaces/ws_00000000-0000-7000-8000-000000000001'), 'th_00000000-0000-7000-8000-000000000001', turn.id, 0),
        Buffer.from([0, 254, 1])
      );
      expect(reader.readSourceFile!(input)).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
