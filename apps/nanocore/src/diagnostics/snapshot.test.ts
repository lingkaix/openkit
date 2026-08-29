import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentManifest } from '../agents/manifest.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDiagnosticsSnapshot } from './snapshot.js';

/**
 * Creates a minimal agent manifest for diagnostics tests.
 *
 * @returns Agent manifest.
 */
function agentManifest(): AgentManifest {
  return {
    adapter: 'custom-http',
    deployments: ['local'],
    displayName: 'Self Check Agent',
    id: 'agent_self_check',
    kind: 'custom',
    readiness: { status: 'ready' },
    runtime: 'custom',
    version: '0.0.2',
  };
}

describe('createDiagnosticsSnapshot', () => {
  it('aggregates mode, storage, migrations, providers, agents, and auth without secrets', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-diagnostics-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const snapshot = createDiagnosticsSnapshot({
      actor: { kind: 'local', userId: 'user_local' },
      coreDb,
      dataRoot,
      mode: 'local',
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://user:password@example.com/v1',
          displayName: 'Provider',
          id: 'provider',
          kind: 'direct',
          models: ['model'],
          secretRef: 'env:SECRET_TOKEN',
        },
      ]),
      agentManifests: [agentManifest()],
    });

    expect(snapshot).toMatchObject({
      auth: { mode: 'local' },
      dataRoot: 'configured',
      migrations: { applied: ['core_0000_setup'] },
      mode: 'local',
      providers: [{ baseUrl: 'https://example.com/v1', id: 'provider' }],
      agents: [{ id: 'agent_self_check', readiness: 'ready', reasons: [] }],
    });
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(snapshot)).not.toContain('user:password');

    coreDb.sqlite.close();
  });
});
