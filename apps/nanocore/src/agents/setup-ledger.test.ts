import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { recordResolvedAgentSetup, requireResolvedAgentSetup } from './setup-ledger.js';
import type { ResolvedAgentSetup } from './setup-resolver.js';

/**
 * Creates a migrated workspace database for setup ledger tests.
 *
 * @returns Open workspace database.
 */
function createWorkspaceDb() {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-agent-setup-ledger-')),
    'user_1',
    'ws_1'
  );
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one resolved setup fixture.
 *
 * @returns Resolved agent setup.
 */
function resolvedSetup(): ResolvedAgentSetup {
  return {
    requiredFeatures: ['workspace.mount.fuse'],
    deployment: {
      mode: 'local',
      origin: 'agent-config',
      config: { command: 'codex', args: ['app-server', '--listen', 'stdio://'] },
    },
    origins: {
      runtime: 'agent-config',
      transport: 'adapter-defaults',
      deployment: 'agent-config',
      provider: 'server-providers',
    },
    provider: {
      model: 'openai/gpt-5.2',
      origin: 'server-providers',
      providerId: 'agent-openrouter',
      secretRef: 'vault:provider-openrouter',
    },
    runtime: {
      adapter: 'codex-app-server',
      kind: 'codex',
      version: '0.130.0',
    },
    transport: { kind: 'stdio', origin: 'adapter-defaults' },
    agent: { displayName: 'Codex Agent', id: 'agent_codex_host' },
  };
}

describe('resolved agent setup ledger', () => {
  it('persists and reads one workspace-scoped resolved setup record', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const record = recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_1',
        workspaceId: 'ws_1',
        turnId: 'turn_1',
        requestId: 'req_1',
        setup: resolvedSetup(),
        createdAt: '2026-07-06T00:00:00.000Z',
      });

      expect(record).toMatchObject({
        id: 'ras_1',
        workspaceId: 'ws_1',
        turnId: 'turn_1',
        requestId: 'req_1',
        agentId: 'agent_codex_host',
        providerId: 'agent-openrouter',
        runtimeKind: 'codex',
        runtimeAdapter: 'codex-app-server',
        requiredFeatures: ['workspace.mount.fuse'],
      });
      expect(requireResolvedAgentSetup(workspaceDb, 'ws_1', 'ras_1')).toEqual(record);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
