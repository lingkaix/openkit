import {
  RuntimeConfigStatusSchema,
  SetupDiagnosticsResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { isAgentLaunchable } from '../agents/readiness.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createSetupDiagnostics } from './setup.js';

describe('createSetupDiagnostics', () => {
  it('keeps Provider secret references redacted without making them Agent readiness inputs', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://FAKE_user:FAKE_sk-secret@example.com/v1',
        displayName: 'Hosted',
        id: 'agent-openrouter',
        kind: 'custom',
        models: ['openai/gpt-5.2'],
        secretRef: 'vault://vault_00000000-0000-7ac5-af56-0e09bc289ac0',
      },
    ]);

    const diagnostics = createSetupDiagnostics({
      agentManifests: [createTestAgentSetup().manifest],
      dataRoot: '/tmp/openkit-test',
      gatewayConfig: createTestGatewayConfig(),
      mode: 'local',
      openKitConfig: {},
      providerRegistry: registry,
      runtimeConfig: {
        currentVersion: 1,
        lastFailedReload: null,
        lastReload: null,
        loadedAt: '2026-01-01T00:00:00.000Z',
        pendingRestart: [],
        nanoHostTurnCapacity: { desired: 4, effective: null },
        staleSessions: [],
      },
    });

    expect(diagnostics.providers).toEqual([
      expect.objectContaining({
        id: 'agent-openrouter',
        secret: {
          configured: true,
          marker: 'secret-ref',
          ref: 'vault://vault_00000000-0000-7ac5-af56-0e09bc289ac0',
        },
      }),
    ]);
    expect(diagnostics.agents[0]?.readiness).toEqual({
      reasons: [],
      status: 'ready',
    });
    expect(diagnostics.server.dataRoot).toBe('configured');
    const status = SetupDiagnosticsResponseSchema.parse(diagnostics).runtimeConfig;
    expect(status.nanoHostTurnCapacity).toEqual({ desired: 4, effective: null });
    expect(RuntimeConfigStatusSchema.parse(status)).not.toHaveProperty('nanoHostTurnCapacity');
    expect(JSON.stringify(diagnostics)).not.toContain('/tmp/openkit-test');
    expect(JSON.stringify(diagnostics)).not.toContain('sk-secret');
  });

  it('projects the stored readiness message of a ready Agent', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        displayName: 'Hosted',
        id: 'agent-openrouter',
        kind: 'custom',
        models: ['openai/gpt-5.2'],
        secretRef: 'env:OPENROUTER_API_KEY',
      },
    ]);

    const diagnostics = createSetupDiagnostics({
      agentManifests: [
        {
          ...createTestAgentSetup().manifest,
          readiness: { message: 'Proved by an accepted turn.', status: 'ready' },
        },
      ],
      dataRoot: '/tmp/openkit-test',
      gatewayConfig: createTestGatewayConfig(),
      mode: 'local',
      openKitConfig: {},
      providerRegistry: registry,
      runtimeConfig: {
        currentVersion: 1,
        lastFailedReload: null,
        lastReload: null,
        loadedAt: '2026-01-01T00:00:00.000Z',
        pendingRestart: [],
        staleSessions: [],
      },
    });

    expect(diagnostics.agents[0]?.readiness).toEqual({
      reasons: ['Proved by an accepted turn.'],
      status: 'ready',
    });
  });

  it('keeps a disabled Agent disabled when model supply is missing and blocks an enabled Agent', () => {
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
    const diagnostics = SetupDiagnosticsResponseSchema.parse(
      createSetupDiagnostics({
        agentManifests: [disabled, enabled],
        dataRoot: null,
        gatewayConfig: createTestGatewayConfig(),
        mode: 'local',
        openKitConfig: {},
        providerCredentialConfigured: () => false,
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
        runtimeConfig: {
          currentVersion: 1,
          lastFailedReload: null,
          lastReload: null,
          loadedAt: '2026-01-01T00:00:00.000Z',
          pendingRestart: [],
          staleSessions: [],
        },
      })
    );
    const disabledAgent = diagnostics.agents.find((agent) => agent.id === 'agent_disabled');
    const enabledAgent = diagnostics.agents.find((agent) => agent.id === 'agent_enabled');

    expect(disabledAgent?.readiness).toEqual({ reasons: [declaredReason], status: 'disabled' });
    expect(disabledAgent?.setup.status).toBe('disabled');
    expect(
      disabledAgent?.setup.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
    ).toMatch(/no eligible model supply/);
    expect(enabledAgent?.readiness.status).toBe('blocked');
    expect(enabledAgent?.setup.status).toBe('blocked');
    expect(enabledAgent?.readiness.reasons.join('\n')).toMatch(/no eligible model supply/);
    expect(enabledAgent?.readiness.reasons.join('\n')).not.toMatch(/does not allow logical model/);
    expect(isAgentLaunchable(disabledAgent!.readiness)).toBe(false);
    expect(isAgentLaunchable(enabledAgent!.readiness)).toBe(false);
  });
});
