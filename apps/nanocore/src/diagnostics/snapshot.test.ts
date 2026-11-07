import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentManifest } from '../agents/manifest.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations, listAppliedMigrationIds } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createDiagnosticsSnapshot } from './snapshot.js';

/**
 * Creates a current authored manifest without changing the diagnostic identity or readiness oracle.
 *
 * @returns Agent manifest.
 */
const setupOptions = {
  adapter: 'custom-http',
  agentId: 'agent_self_check',
  displayName: 'Self Check Agent',
} as const;

function agentManifest(readiness?: AgentManifest['readiness']): AgentManifest {
  const manifest = createTestAgentSetup(setupOptions).manifest;
  return readiness ? { ...manifest, readiness } : manifest;
}

describe('createDiagnosticsSnapshot', () => {
  it('aggregates mode, storage, migrations, providers, agents, and auth without secrets', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-diagnostics-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      expect(listAppliedMigrationIds(coreDb)).toEqual([]);
      applyMigrations(coreDb);
      const snapshot = createDiagnosticsSnapshot({
        actor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID },
        coreDb,
        dataRoot,
        mode: 'local',
        providerRegistry: new ProviderRegistry([
          {
            baseUrl: 'https://user:password@example.com/v1',
            displayName: 'Provider',
            id: 'agent-openrouter',
            kind: 'custom',
            models: ['openai/gpt-5.2'],
            secretRef: 'env:SECRET_TOKEN',
          },
        ]),
        gatewayConfig: createTestGatewayConfig(setupOptions),
        agentManifests: [agentManifest({ status: 'ready' })],
      });

      expect(snapshot).toMatchObject({
        auth: { mode: 'local' },
        dataRoot: 'configured',
        migrations: {
          // Bootstrap requires applied-version evidence, not a fixed release inventory.
          applied: expect.arrayContaining([
            'core_0000_setup',
            'core_0001_concurrent_turn_capacity',
            'core_0002_durable_recurring_schedules',
            'core_0003_notebook_admission',
            'core_0004_equal_workspace_members',
            'core_0005_channel_notifications',
            'core_0006_external_trigger_admissions',
            'core_0007_discord_capture_origin',
            'core_0008_server_capability_usage',
            'core_0009_policy_audit_v1',
            'core_0010_retained_record_formats',
            'core_0011_audit_authentication',
            'core_0012_quarantined_workspace_retirement',
            'core_0013_control_store',
            'core_0014_execution_journal',
          ]),
        },
        mode: 'local',
        providers: [{ baseUrl: 'https://example.com/v1', id: 'agent-openrouter' }],
        agents: [{ id: 'agent_self_check', readiness: 'ready', reasons: [] }],
      });
      // The snapshot must preserve the complete public migration-owner observation.
      expect(snapshot.migrations.applied).toEqual(listAppliedMigrationIds(coreDb));
      expect(JSON.stringify(snapshot)).not.toContain(dataRoot);
      expect(JSON.stringify(snapshot)).not.toContain('SECRET_TOKEN');
      expect(JSON.stringify(snapshot)).not.toContain('user:password');
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('does not publish a declared ready value that setup has not checked', () => {
    const omitted = agentManifest();
    const declaredReady = agentManifest({ status: 'ready' });
    const unenforceable = {
      ...agentManifest(),
      resources: { sessions: 1 },
    };
    const snapshot = createDiagnosticsSnapshot({
      mode: 'local',
      providerRegistry: diagnosticsProviderRegistry(),
      agentManifests: [omitted, declaredReady, unenforceable],
    });

    expect(snapshot.agents.map((agent) => agent.readiness)).toEqual([
      'unknown',
      'unknown',
      'blocked',
    ]);
    expect(snapshot.agents[2]?.reasons.join('\n')).toMatch(/resource/i);
  });

  it('publishes ready for omitted readiness only after setup accepts the manifest', () => {
    const snapshot = createDiagnosticsSnapshot({
      mode: 'local',
      providerRegistry: diagnosticsProviderRegistry(),
      gatewayConfig: createTestGatewayConfig(setupOptions),
      agentManifests: [agentManifest()],
    });

    expect(snapshot.agents[0]).toMatchObject({ readiness: 'ready', reasons: [] });
  });

  it('does not publish ready for an omitted manifest that is missing a control binary', () => {
    const manifest = createTestAgentSetup().manifest;
    const unchecked = {
      ...manifest,
      runtime: {
        ...manifest.runtime,
        binaries: manifest.runtime.binaries.filter(
          (binary) => binary.path !== '/usr/local/bin/node'
        ),
      },
    };
    const snapshot = createDiagnosticsSnapshot({
      mode: 'local',
      providerRegistry: new ProviderRegistry([]),
      agentManifests: [unchecked],
    });

    expect(snapshot.agents[0]).toMatchObject({
      readiness: 'unknown',
      reasons: ['Agent readiness has not been established.'],
    });
  });

  it('blocks launch when a required control binary is missing', () => {
    const declaredReady = agentManifest({ status: 'ready' });
    declaredReady.runtime = {
      ...declaredReady.runtime,
      binaries: declaredReady.runtime.binaries.filter(
        (binary) => binary.path !== '/usr/local/bin/node'
      ),
    };
    const snapshot = createDiagnosticsSnapshot({
      mode: 'local',
      providerRegistry: diagnosticsProviderRegistry(),
      gatewayConfig: createTestGatewayConfig(setupOptions),
      agentManifests: [declaredReady],
    });

    expect(snapshot.agents[0]?.readiness).toBe('blocked');
    expect(snapshot.agents[0]?.reasons.join('\n')).toContain('node');
  });
});

/** Redacted provider supply used by readiness projections that do not open a database. */
function diagnosticsProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      baseUrl: 'https://example.com/v1',
      displayName: 'Provider',
      id: 'agent-openrouter',
      kind: 'custom',
      models: ['openai/gpt-5.2'],
    },
  ]);
}
