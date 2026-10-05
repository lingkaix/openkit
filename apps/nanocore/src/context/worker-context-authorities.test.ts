import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);

    try {
      const turn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Run worker',
        { kind: 'user', id: 'user_local' },
        null,
        { turnId: 'tu_current' }
      );
      const session = store.createAgentSession({
        id: 'as_current',
        agentId: 'agent_codex_host',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
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
        'ws_demo',
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

      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_demo')).toThrow(
        /captureCoverage/
      );
      expect(reader.readAgentEnvironmentPackage('ws_demo', record.snapshotId)).toEqual(
        record.snapshot
      );
      // Historical delivery names its snapshot even after the reusable session pointer advances.
      store.updateAgentSession(session.id, { environmentPackageSnapshotId: 'aepsnap_later' });
      expect(reader.readAgentEnvironmentPackage('ws_demo', record.snapshotId)).toEqual(
        record.snapshot
      );
      expect(reader.readAgentEnvironmentPackage('ws_demo', 'aepsnap_missing')).toBeNull();
      expect(reader.readAgentEnvironmentPackage('ws_other', record.snapshotId)).toBeNull();
      expect(readFileSync(selectedPath, 'utf8')).toBe(selectedBytes);
      expect(readFileSync(historicalPath, 'utf8')).toBe(historicalBytes);

      const invalidSelected = JSON.parse(selectedBytes);
      delete invalidSelected.snapshot.observability.captureCoverage;
      invalidSelected.contentDigest = snapshotDigest(invalidSelected.snapshot);
      writeFileSync(selectedPath, JSON.stringify(invalidSelected));
      expect(reader.readAgentEnvironmentPackage('ws_demo', record.snapshotId)).toBeNull();
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_other');

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
