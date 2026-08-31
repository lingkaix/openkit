import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceDataSourceCatalog } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { AgentManifest } from '../agents/manifest.js';
import { requireResolvedAgentSetup } from '../agents/setup-ledger.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore, seedDemoWorkspace } from '../test-support/demo-store.js';
import { startTurn } from './orchestrator.js';
import type { TurnExecutor, TurnStartRuntimeContext } from './types.js';

class RecordingTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    artifacts: false,
    interrupts: true,
    questions: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
  };
  public readonly eventFamilies = ['turn.started'] as const;
  public readonly calls: Array<{
    context: TurnStartRuntimeContext | undefined;
    input: string;
    turnId: string;
  }> = [];

  /**
   * Records the turn start call.
   *
   * @param _store Store passed by the orchestrator.
   * @param turnId Turn id passed by the orchestrator.
   * @param input User input passed by the orchestrator.
   */
  public async startTurn(
    _store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    this.calls.push({ context, input, turnId });
  }

  /**
   * No-op interrupt implementation for the test executor.
   */
  public async interruptTurn(): Promise<void> {}
}

/**
 * Creates a minimal agent manifest.
 *
 * @param id Agent id.
 * @param options Explicit setup differences required by the test.
 * @returns Agent manifest.
 */
function manifest(
  id: string,
  options: Parameters<typeof createTestAgentSetup>[0] = {}
): AgentManifest {
  const setup = createTestAgentSetup(options);

  return {
    ...setup.manifest,
    displayName: id,
    id,
  };
}

/** Builds a valid logical Gateway catalog with caller-chosen public model ids. */
function gatewayConfigFor(...logicalModelIds: string[]) {
  return {
    schemaVersion: 1 as const,
    enabled: true,
    defaultLogicalModelId: logicalModelIds[0] ?? null,
    logicalModels: logicalModelIds.map((id) => ({
      id,
      displayName: id,
      routes: [
        {
          id: `${id}-route`,
          providerProfileId: 'agent-openrouter',
          providerModel: 'openai/gpt-5.2',
        },
      ],
    })),
    requiredFeatures: [],
  };
}

/** Provider supply paired with the standard logical Gateway test route. */
function localProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Test inference provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
}

describe('startTurn orchestrator', () => {
  it.each([
    'agent_pi',
    'agent_fourth_runtime',
  ])('starts opaque manifest agent %s without a duplicate Store catalog entry', async (agentId) => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const configuredManifest = manifest(agentId);
    const handle = await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
      agentId,
      agentManifests: [configuredManifest],
      input: 'Run tests',
      providerRegistry: localProviderRegistry(),
      store,
      threadId: 'th_demo',
      turnExecutor,
      workspaceId: 'ws_demo',
    });

    expect(handle.agent).toBe(configuredManifest);
    expect(handle.turn.agentId).toBe(agentId);
  });

  it('selects an agent before creating and starting a turn', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const handle = await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      input: 'Run tests',
      providerRegistry: localProviderRegistry(),
      store,
      threadId: 'th_demo',
      triggerActor: {
        kind: 'automation',
        id: 'automation_orchestrator_test',
        responsibleUserId: null,
      },
      turnExecutor,
      agentManifests: [manifest('agent_codex_host')],
      workspaceId: 'ws_demo',
    });

    expect(handle.turn.status).toBe('running');
    expect(handle.turn.triggerActor).toEqual({
      kind: 'automation',
      id: 'automation_orchestrator_test',
      responsibleUserId: null,
    });
    expect(handle.agent.id).toBe('agent_codex_host');
    expect(handle.readiness.status).toBe('ready');
    expect(turnExecutor.calls).toEqual([
      {
        context: {
          agentSetup: expect.objectContaining({
            manifest: manifest('agent_codex_host'),
            profileId: 'default',
          }),
          requestId: null,
          triggerActor: {
            kind: 'automation',
            id: 'automation_orchestrator_test',
            responsibleUserId: null,
          },
          workspaceCwd: null,
          workspaceRoots: [],
        },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
  });

  it.each([
    'disabled',
    'blocked',
    'unknown',
  ] as const)('rejects %s agent readiness before creating a turn or starting the executor', async (status) => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
        gatewayConfig: createTestGatewayConfig(),
        defaultAgentId: 'agent_codex_host',
        triggerActor: { kind: 'user', id: 'user_local' },
        agentManifests: [
          {
            ...manifest('agent_codex_host'),
            readiness: { status },
          },
        ],
        input: 'Run tests',
        providerRegistry: localProviderRegistry(),
        store,
        threadId: 'th_demo',
        turnExecutor,
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'agent_not_ready',
      message: `Agent agent_codex_host readiness is ${status}.`,
      status: 409,
    });
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('rejects generic degraded readiness before creating a turn or starting the executor', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
        gatewayConfig: createTestGatewayConfig(),
        defaultAgentId: 'agent_codex_host',
        triggerActor: { kind: 'user', id: 'user_local' },
        agentManifests: [
          {
            ...manifest('agent_codex_host'),
            readiness: { message: 'Optional capability is unavailable.', status: 'degraded' },
          },
        ],
        input: 'Run tests',
        providerRegistry: localProviderRegistry(),
        store,
        threadId: 'th_demo',
        turnExecutor,
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'agent_not_ready',
      message: 'Agent agent_codex_host readiness is degraded.',
      status: 409,
    });
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('applies a per-turn model override only to the explicitly selected Agent', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = localProviderRegistry();
    const codexManifest = {
      ...manifest('agent_codex_host'),
      models: { preferredLogicalModelId: 'model_codex', allowedLogicalModelIds: ['model_codex'] },
    };
    const opencodeManifest = {
      ...manifest('agent_opencode_host'),
      models: {
        preferredLogicalModelId: 'model_opencode',
        allowedLogicalModelIds: ['model_opencode'],
      },
    };
    const handle = await startTurn({
      agentId: 'agent_opencode_host',
      gatewayConfig: gatewayConfigFor('model_codex', 'model_opencode'),
      triggerActor: { kind: 'user', id: 'user_local' },
      input: 'Run tests',
      modelId: 'model_opencode',
      providerRegistry,
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [codexManifest, opencodeManifest],
      workspaceId: 'ws_demo',
    });

    expect(handle.modelId).toBe('model_opencode');
    expect(handle.agent.id).toBe('agent_opencode_host');
    expect(handle.turn.agentId).toBe('agent_opencode_host');
    expect(turnExecutor.calls[0]).toMatchObject({
      context: {
        agentSetup: {
          manifest: opencodeManifest,
          profileId: 'default',
          logicalModels: { preferredLogicalModelId: 'model_opencode' },
        },
      },
      input: 'Run tests',
      turnId: handle.turn.id,
    });
  });

  it('does not use a model override to bypass a disabled default Agent', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = localProviderRegistry();
    const models = {
      preferredLogicalModelId: 'model_shared',
      allowedLogicalModelIds: ['model_shared'],
    };
    const disabledDefault = {
      ...manifest('agent_disabled_default'),
      models,
      readiness: { status: 'disabled' as const },
    };
    const readyAlternative = { ...manifest('agent_ready_alternative'), models };
    await expect(
      startTurn({
        defaultAgentId: 'agent_disabled_default',
        gatewayConfig: gatewayConfigFor('model_shared'),
        triggerActor: { kind: 'user', id: 'user_local' },
        agentManifests: [disabledDefault, readyAlternative],
        input: 'Run tests',
        modelId: 'model_shared',
        providerRegistry,
        store,
        threadId: 'th_demo',
        turnExecutor,
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({ code: 'agent_not_ready', status: 409 });
  });

  it('rejects an explicit agent whose manifest provider does not support the model override', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = localProviderRegistry();
    const configuredManifests = [
      {
        ...manifest('agent_codex_host'),
        models: { preferredLogicalModelId: 'model_codex', allowedLogicalModelIds: ['model_codex'] },
      },
      {
        ...manifest('agent_opencode_host'),
        models: {
          preferredLogicalModelId: 'model_opencode',
          allowedLogicalModelIds: ['model_opencode'],
        },
      },
    ];

    await expect(
      startTurn({
        gatewayConfig: gatewayConfigFor('model_codex', 'model_opencode'),
        triggerActor: { kind: 'user', id: 'user_local' },
        agentId: 'agent_codex_host',
        agentManifests: configuredManifests,
        input: 'Run tests',
        modelId: 'model_opencode',
        providerRegistry,
        store,
        threadId: 'th_demo',
        turnExecutor,
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('Agent agent_codex_host does not support model override: model_opencode.');
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('runs selector, creates the turn, then starts the executor in order', async () => {
    const sequence: string[] = [];
    const store = new (class extends FsStore {
      /**
       * Records turn creation order.
       */
      public override createTurn(
        workspaceId: string,
        threadId: string,
        input: string,
        triggerActor: ActorRef
      ) {
        sequence.push('store.createTurn');
        return super.createTurn(workspaceId, threadId, input, triggerActor);
      }
    })();
    seedDemoWorkspace(store);
    const turnExecutor = new (class extends RecordingTurnExecutor {
      /**
       * Records executor startup order.
       */
      public override async startTurn(
        store: FsStore,
        turnId: string,
        input: string
      ): Promise<void> {
        sequence.push('executor.startTurn');
        await super.startTurn(store, turnId, input);
      }
    })();

    await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: {
        selectAgent: (defaults, override, manifests) => {
          sequence.push('selector.selectAgent');
          expect(defaults).toEqual({ defaultAgentId: 'agent_codex_host' });
          expect(override).toEqual({});
          return manifests[0] ?? { error: { code: 'agent_not_configured', message: 'missing' } };
        },
      },
      input: 'Run tests',
      providerRegistry: localProviderRegistry(),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [manifest('agent_codex_host')],
      workspaceId: 'ws_demo',
    });

    expect(sequence).toEqual(['selector.selectAgent', 'store.createTurn', 'executor.startTurn']);
  });

  it('fails before creating a turn when selected agent is missing', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
        gatewayConfig: createTestGatewayConfig(),
        defaultAgentId: 'agent_codex_host',
        triggerActor: { kind: 'user', id: 'user_local' },
        agentId: 'agent_missing',
        input: 'Run tests',
        providerRegistry: localProviderRegistry(),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [manifest('agent_other')],
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('Agent manifest not found: agent_missing.');
    expect(turnExecutor.calls).toEqual([]);
  });

  it('resolves setup for a selected authored agent config without changing turn execution', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const configuredManifest = manifest('agent_codex_host', {});
    const handle = await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: { providerCredentialResolver: () => 'secret' },
      input: 'Run tests',
      providerRegistry: localProviderRegistry(),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [configuredManifest],
      workspaceId: 'ws_demo',
    });

    expect(handle.agentSetup?.manifest).toEqual(configuredManifest);
    expect(handle.agentSetup?.logicalModels.preferredLogicalModelId).toBe('openai/gpt-5.2');
    expect(turnExecutor.calls[0]).toMatchObject({
      context: {
        agentSetup: { manifest: configuredManifest, profileId: 'default' },
      },
      input: 'Run tests',
      turnId: handle.turn.id,
    });
  });

  it('records resolved setup when a workspace setup ledger is provided', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const configuredManifest = manifest('agent_codex_host', {});
    const workspaceDb = openWorkspaceDb(
      mkdtempSync(join(tmpdir(), 'openkit-orchestrator-setup-ledger-')),
      'user_local',
      'ws_demo'
    );
    applyScopedMigrations(workspaceDb);

    try {
      const handle = await startTurn({
        gatewayConfig: createTestGatewayConfig(),
        defaultAgentId: 'agent_codex_host',
        triggerActor: { kind: 'user', id: 'user_local' },
        dependencies: { providerCredentialResolver: () => 'secret' },
        input: 'Run tests',
        providerRegistry: localProviderRegistry(),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [configuredManifest],
        agentSetupWorkspaceDb: workspaceDb,
        workspaceId: 'ws_demo',
      });

      expect(handle.agentSetupRecordId).toBe(`ras_${handle.turn.id}`);
      expect(
        requireResolvedAgentSetup(workspaceDb, 'ws_demo', `ras_${handle.turn.id}`)
      ).toMatchObject({
        id: `ras_${handle.turn.id}`,
        workspaceId: 'ws_demo',
        turnId: handle.turn.id,
        requestId: null,
        agentId: 'agent_codex_host',
        logicalModelId: 'openai/gpt-5.2',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('passes authored backend requirements into the executor start context', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const configuredManifest = manifest('agent_codex_host', {
      requiredCapabilities: ['dynamic-network-policy'],
    });
    const handle = await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: { providerCredentialResolver: () => 'secret' },
      input: 'Run tests',
      providerRegistry: localProviderRegistry(),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [configuredManifest],
      workspaceId: 'ws_demo',
    });

    expect(handle.agentSetup?.manifest.sandbox?.backend).toEqual({
      allowedKinds: ['openshell'],
      preferred: 'openshell',
      requiredCapabilities: ['dynamic-network-policy'],
    });
    expect(turnExecutor.calls[0]?.context?.agentSetup?.manifest.sandbox?.backend).toEqual({
      allowedKinds: ['openshell'],
      preferred: 'openshell',
      requiredCapabilities: ['dynamic-network-policy'],
    });
  });

  it('passes authored workspace source refs into the executor start context', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'main-repo',
          kind: 'git',
          displayName: 'Main repository',
          locator: { repositoryResourceId: 'repo_default' },
          access: 'read-write',
          sensitivity: 'internal',
          allowedSlotKinds: ['worktree'],
          status: 'active',
        },
      ],
    });
    const config: AgentManifest = {
      ...manifest('agent_codex_host', {}),
      workspace: {
        inputs: [
          {
            id: 'repo_root',
            sourceRef: 'main-repo',
            target: 'repo',
          },
        ],
      },
    };

    const handle = await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: { providerCredentialResolver: () => 'secret' },
      input: 'Run tests',
      providerRegistry: localProviderRegistry(),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [config],
      workspaceDataSourceCatalog: catalog,
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo_root',
          sourceKind: 'host-dir',
          sourcePath: '/repo',
          workerPath: '/workspace/repo',
        },
      ],
      workspaceId: 'ws_demo',
    });

    expect(turnExecutor.calls).toEqual([
      {
        context: {
          agentSetup: expect.objectContaining({ manifest: config, profileId: 'default' }),
          requestId: null,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceCwd: null,
          workspaceDataSourceCatalog: catalog,
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo_root',
              sourceKind: 'host-dir',
              sourcePath: '/repo',
              workerPath: '/workspace/repo',
            },
          ],
          workspaceSourceRefs: { repo_root: 'main-repo' },
        },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
  });

  it('blocks authored workspace source refs before creating a turn when the catalog source is missing', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const config: AgentManifest = {
      ...manifest('agent_codex_host', {}),
      workspace: {
        inputs: [
          {
            id: 'repo_root',
            sourceRef: 'missing-repo',
            target: 'repo',
          },
        ],
      },
    };

    await expect(
      startTurn({
        gatewayConfig: createTestGatewayConfig(),
        defaultAgentId: 'agent_codex_host',
        triggerActor: { kind: 'user', id: 'user_local' },
        dependencies: { providerCredentialResolver: () => 'secret' },
        input: 'Run tests',
        providerRegistry: localProviderRegistry(),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [config],
        workspaceDataSourceCatalog: parseWorkspaceDataSourceCatalog({
          schemaVersion: 1,
          sources: [],
        }),
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo_root',
            sourceKind: 'host-dir',
            sourcePath: '/repo',
            workerPath: '/workspace/repo',
          },
        ],
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'workspace_data_source_blocked',
      message: 'Workspace data source not found: missing-repo',
      status: 409,
    });
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('passes scheduler lease lineage into the executor start context', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const handle = await startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
      input: 'Run with lease binding',
      agentSessionId: 'as_orchestrator_1',
      providerRegistry: localProviderRegistry(),
      sandboxBindingRef: 'lease-binding:orchestrator_1',
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [manifest('agent_codex_host')],
      workspaceId: 'ws_demo',
    });

    expect(turnExecutor.calls).toEqual([
      {
        context: {
          agentSessionId: 'as_orchestrator_1',
          agentSetup: expect.objectContaining({
            manifest: manifest('agent_codex_host'),
            profileId: 'default',
          }),
          requestId: null,
          sandboxBindingRef: 'lease-binding:orchestrator_1',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceCwd: null,
          workspaceRoots: [],
        },
        input: 'Run with lease binding',
        turnId: handle.turn.id,
      },
    ]);
  });
});
