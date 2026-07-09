import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';

/**
 * Creates one migrated workspace database for AEP snapshot ledger tests.
 *
 * @returns Open workspace database.
 */
function createWorkspaceDb() {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-aep-snapshot-ledger-')),
    'user_1',
    'ws_1'
  );
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('AEP snapshot ledger', () => {
  it('persists a redacted workspace-owned AEP snapshot record', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent: {
          id: 'agent_codex_host',
          name: 'Codex Agent',
          kind: 'coder',
          status: 'enabled',
          modelId: null,
          skillIds: [],
          profiles: [
            {
              id: 'default',
              displayName: 'Default',
              instructionsRef: null,
              modelId: null,
              skillIds: [],
              capabilityIds: [],
            },
          ],
          defaultProfileId: 'default',
          capabilities: [],
          sandboxSummary: null,
          config: {
            adapterType: 'codex',
            command: null,
            baseUrl: null,
            workspaceRoot: '/workspace',
            environment: {},
            capabilities: [],
          },
        },
        agentSessionId: 'as_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'openkit/worker-codex:dev',
        },
        requestId: 'req_1',
        turn: {
          id: 'turn_1',
          workspaceId: 'ws_1',
          threadId: 'th_1',
          items: [],
          status: 'running',
          humanGate: null,
          error: null,
          configVersion: null,
          startedAt: '2026-07-06T00:00:00.000Z',
          completedAt: null,
          durationMs: null,
        },
        turnInput: 'Run tests',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      })
    );

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });

      expect(record).toMatchObject({
        snapshotId: environmentPackage.snapshotId,
        workspaceId: 'ws_1',
        turnId: 'turn_1',
        agentSessionId: 'as_1',
        agentId: 'agent_codex_host',
        packageId: environmentPackage.packageId,
      });
      expect(record.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(record.snapshot)).not.toContain('sk-');
      expect(
        requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId)
      ).toEqual(record);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
