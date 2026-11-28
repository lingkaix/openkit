import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentManifest } from '../agents/manifest.js';
import { isAgentLaunchable } from '../agents/readiness.js';
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
            baseUrl: ['https:/', '/user:password@example.com/v1'].join(''),
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
          applied: expect.arrayContaining(['core_0000_baseline']),
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

  it('keeps a disabled Agent disabled when model supply is missing', () => {
    const declaredReason = 'Operator disabled this Agent.';
    const enabled = createTestAgentSetup({
      agentId: 'agent_enabled',
      displayName: 'Enabled Agent',
    }).manifest;
    const disabled = {
      ...createTestAgentSetup({
        agentId: 'agent_disabled',
        displayName: 'Disabled Agent',
      }).manifest,
      readiness: { message: declaredReason, status: 'disabled' as const },
    };
    const snapshot = createDiagnosticsSnapshot({
      mode: 'local',
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://example.com/v1',
          displayName: 'Hosted',
          id: 'agent-openrouter',
          kind: 'direct',
          models: ['openai/gpt-5.2'],
          secretRef: 'env:OPENROUTER_API_KEY',
        },
      ]),
      providerCredentialConfigured: () => false,
      gatewayConfig: createTestGatewayConfig(),
      agentManifests: [disabled, enabled],
    });
    const disabledAgent = snapshot.agents.find((agent) => agent.id === 'agent_disabled');
    const enabledAgent = snapshot.agents.find((agent) => agent.id === 'agent_enabled');

    expect(disabledAgent).toMatchObject({ readiness: 'disabled', reasons: [declaredReason] });
    expect(enabledAgent?.readiness).toBe('blocked');
    expect(enabledAgent?.reasons.join('\n')).toMatch(/no eligible model supply/);
    expect(enabledAgent?.reasons.join('\n')).not.toMatch(/does not allow logical model/);
    expect(
      isAgentLaunchable({
        status: 'disabled',
        reasons: disabledAgent!.reasons,
      })
    ).toBe(false);
    expect(
      isAgentLaunchable({
        status: 'blocked',
        reasons: enabledAgent!.reasons,
      })
    ).toBe(false);
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
