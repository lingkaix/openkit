import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentEnvironmentSnapshotReadError,
  listExportableAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
  snapshotDigest,
} from '../runtime/aep-snapshot-ledger.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';

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
