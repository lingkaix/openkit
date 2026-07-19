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
import { createTestAgentSetup } from '../test-support/agent-environment.js';
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
  options: Parameters<typeof createTestAgentSetup>[0] = { provider: null }
): AgentManifest {
  const setup = createTestAgentSetup(options);

  return {
    ...setup.manifest,
    displayName: id,
    id,
  };
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
      triggerActor: { kind: 'user', id: 'user_local' },
      agentId,
      agentManifests: [configuredManifest],
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([]),
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
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([]),
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
          agentSetup: { manifest: manifest('agent_codex_host'), provider: null },
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
        triggerActor: { kind: 'user', id: 'user_local' },
        agentManifests: [
          {
            ...manifest('agent_codex_host'),
            readiness: { status },
          },
        ],
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([]),
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

  it('blocks missing provider credentials before creating a turn or starting the executor', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
        triggerActor: { kind: 'user', id: 'user_local' },
        agentManifests: [manifest('agent_codex_host', {})],
        dependencies: { providerCredentialResolver: () => null },
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([
          {
            baseUrl: 'https://api.example.com/v1',
            displayName: 'Hosted',
            id: 'agent-openrouter',
            kind: 'direct',
            models: ['openai/gpt-5.2'],
            secretRef: 'vault://provider_hosted',
          },
        ]),
        store,
        threadId: 'th_demo',
        turnExecutor,
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'agent_not_ready',
      message: 'Agent agent_codex_host readiness is blocked.',
      status: 409,
    });
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('admits deferred manifest-owned worker credential validation as degraded', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const configuredManifest = manifest('agent_codex_host', {
      credentialDeclarations: [
        {
          id: 'hosted_api_key',
          targetEnvVarName: 'HOSTED_API_KEY',
          vaultGrantId: 'grant_hosted_api_key',
          visibility: 'runtime-env',
        },
      ],
      network: [
        {
          access: 'read-write',
          binaries: ['/usr/local/bin/codex'],
          host: 'api.example.com',
          id: 'hosted_api',
          port: 443,
          protocol: 'https',
          purpose: 'Use the selected provider.',
        },
      ],
    });
    const handle = await startTurn({
      triggerActor: { kind: 'user', id: 'user_local' },
      agentManifests: [configuredManifest],
      dependencies: { providerCredentialResolver: () => null },
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://api.example.com/v1',
          displayName: 'Hosted',
          id: 'agent-openrouter',
          kind: 'direct',
          models: ['openai/gpt-5.2'],
          readiness: { status: 'ready' },
        },
      ]),
      store,
      threadId: 'th_demo',
      turnExecutor,
      workspaceId: 'ws_demo',
    });

    expect(handle.readiness).toEqual({
      reasons: [
        'Provider agent-openrouter defers manifest-owned worker credential validation to turn-scoped AEP resolution.',
      ],
      status: 'degraded',
    });
    expect(turnExecutor.calls).toHaveLength(1);
  });

  it('rejects generic degraded readiness before creating a turn or starting the executor', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
        triggerActor: { kind: 'user', id: 'user_local' },
        agentManifests: [
          {
            ...manifest('agent_codex_host'),
            readiness: { message: 'Optional capability is unavailable.', status: 'degraded' },
          },
        ],
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([]),
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

  it('uses a per-turn model override to select a compatible enabled agent', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = new ProviderRegistry([
      {
        displayName: 'Worker Models',
        id: 'worker-models',
        kind: 'local',
        models: ['model_codex', 'model_opencode'],
      },
    ]);
    const codexManifest = manifest('agent_codex_host', {
      provider: {
        model: 'model_codex',
        origin: 'server-providers',
        providerId: 'worker-models',
        secretRef: null,
      },
    });
    const opencodeManifest = manifest('agent_opencode_host', {
      provider: {
        model: 'model_opencode',
        origin: 'server-providers',
        providerId: 'worker-models',
        secretRef: null,
      },
    });
    const handle = await startTurn({
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
    expect(turnExecutor.calls).toEqual([
      {
        context: {
          agentSetup: {
            manifest: opencodeManifest,
            provider: {
              model: 'model_opencode',
              origin: 'server-providers',
              providerId: 'worker-models',
              secretRef: null,
            },
          },
          requestId: null,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceCwd: null,
          workspaceRoots: [],
        },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
  });

  it('skips a disabled default manifest when another manifest can launch the requested model', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = new ProviderRegistry([
      {
        displayName: 'Worker Models',
        id: 'worker-models',
        kind: 'local',
        models: ['model_shared'],
      },
    ]);
    const provider = {
      model: 'model_shared',
      origin: 'server-providers' as const,
      providerId: 'worker-models',
      secretRef: null,
    };
    const disabledDefault = {
      ...manifest('agent_disabled_default', { provider }),
      readiness: { status: 'disabled' as const },
    };
    const readyAlternative = manifest('agent_ready_alternative', { provider });
    store.updateWorkspace('ws_demo', {
      defaults: { defaultAgentId: disabledDefault.id },
    });

    const handle = await startTurn({
      triggerActor: { kind: 'user', id: 'user_local' },
      agentManifests: [disabledDefault, readyAlternative],
      input: 'Run tests',
      modelId: 'model_shared',
      providerRegistry,
      store,
      threadId: 'th_demo',
      turnExecutor,
      workspaceId: 'ws_demo',
    });

    expect(handle.agent.id).toBe('agent_ready_alternative');
    expect(handle.turn.agentId).toBe('agent_ready_alternative');
  });

  it('rejects an explicit agent whose manifest provider does not support the model override', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = new ProviderRegistry([
      {
        displayName: 'Worker Models',
        id: 'worker-models',
        kind: 'local',
        models: ['model_codex', 'model_opencode'],
      },
    ]);
    const configuredManifests = [
      manifest('agent_codex_host', {
        provider: {
          model: 'model_codex',
          origin: 'server-providers',
          providerId: 'worker-models',
          secretRef: null,
        },
      }),
      manifest('agent_opencode_host', {
        provider: {
          model: 'model_opencode',
          origin: 'server-providers',
          providerId: 'worker-models',
          secretRef: null,
        },
      }),
    ];

    await expect(
      startTurn({
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

  it('fails before creating a turn when the model override is unknown', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
        triggerActor: { kind: 'user', id: 'user_local' },
        input: 'Run tests',
        modelId: 'model_missing',
        providerRegistry: new ProviderRegistry([]),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [manifest('agent_codex_host')],
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('Model not found: model_missing.');
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('fails before creating a turn when the model override is disabled', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = new ProviderRegistry([
      {
        displayName: 'Disabled Worker Models',
        id: 'worker-models',
        kind: 'local',
        models: ['model_codex'],
        readiness: { status: 'disabled' },
      },
    ]);

    await expect(
      startTurn({
        triggerActor: { kind: 'user', id: 'user_local' },
        input: 'Run tests',
        modelId: 'model_codex',
        providerRegistry,
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [
          manifest('agent_codex_host', {
            provider: {
              model: 'model_codex',
              origin: 'server-providers',
              providerId: 'worker-models',
              secretRef: null,
            },
          }),
        ],
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('Model is disabled: model_codex.');
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('fails before creating a turn when no enabled agent supports the model override', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const providerRegistry = new ProviderRegistry([
      {
        displayName: 'Worker Models',
        id: 'worker-models',
        kind: 'local',
        models: ['model_codex', 'model_opencode'],
      },
    ]);
    const codexOnlyOptions = {
      provider: {
        model: 'model_codex',
        origin: 'server-providers' as const,
        providerId: 'worker-models',
        secretRef: null,
      },
    };

    await expect(
      startTurn({
        triggerActor: { kind: 'user', id: 'user_local' },
        input: 'Run tests',
        modelId: 'model_opencode',
        providerRegistry,
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [
          manifest('agent_codex_host', codexOnlyOptions),
          manifest('agent_opencode_host', codexOnlyOptions),
        ],
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('No enabled agent supports model: model_opencode.');
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
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: {
        selectAgent: (defaults, override, manifests) => {
          sequence.push('selector.selectAgent');
          expect(defaults).toEqual({ defaultAgentId: null });
          expect(override).toEqual({});
          return manifests[0] ?? { error: { code: 'agent_not_configured', message: 'missing' } };
        },
      },
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([]),
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
        triggerActor: { kind: 'user', id: 'user_local' },
        agentId: 'agent_missing',
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([]),
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
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: { providerCredentialResolver: () => 'secret' },
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          vendor: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.2',
          secretRef: 'env:OPENROUTER_API_KEY',
        },
      ]),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [configuredManifest],
      workspaceId: 'ws_demo',
    });

    expect(handle.agentSetup?.manifest).toEqual(configuredManifest);
    expect(handle.agentSetup?.provider).toEqual({
      model: 'openai/gpt-5.2',
      origin: 'server-providers',
      providerId: 'agent-openrouter',
      secretRef: 'env:OPENROUTER_API_KEY',
    });
    expect(turnExecutor.calls).toEqual([
      {
        context: {
          agentSetup: {
            manifest: configuredManifest,
            provider: {
              model: 'openai/gpt-5.2',
              origin: 'server-providers',
              providerId: 'agent-openrouter',
              secretRef: 'env:OPENROUTER_API_KEY',
            },
          },
          requestId: null,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceCwd: null,
          workspaceRoots: [],
        },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
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
        triggerActor: { kind: 'user', id: 'user_local' },
        dependencies: { providerCredentialResolver: () => 'secret' },
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            vendor: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            defaultModel: 'openai/gpt-5.2',
            secretRef: 'env:OPENROUTER_API_KEY',
          },
        ]),
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
        providerId: 'agent-openrouter',
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
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: { providerCredentialResolver: () => 'secret' },
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          vendor: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.2',
          secretRef: 'env:OPENROUTER_API_KEY',
        },
      ]),
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
      triggerActor: { kind: 'user', id: 'user_local' },
      dependencies: { providerCredentialResolver: () => 'secret' },
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          vendor: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.2',
          secretRef: 'env:OPENROUTER_API_KEY',
        },
      ]),
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
          agentSetup: {
            manifest: config,
            provider: {
              model: 'openai/gpt-5.2',
              origin: 'server-providers',
              providerId: 'agent-openrouter',
              secretRef: 'env:OPENROUTER_API_KEY',
            },
          },
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
        triggerActor: { kind: 'user', id: 'user_local' },
        dependencies: { providerCredentialResolver: () => 'secret' },
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            vendor: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            defaultModel: 'openai/gpt-5.2',
            secretRef: 'env:OPENROUTER_API_KEY',
          },
        ]),
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
      triggerActor: { kind: 'user', id: 'user_local' },
      input: 'Run with lease binding',
      agentSessionId: 'as_orchestrator_1',
      providerRegistry: new ProviderRegistry([]),
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
          agentSetup: { manifest: manifest('agent_codex_host'), provider: null },
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
