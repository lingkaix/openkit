import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceDataSourceCatalog } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import type { AgentManifest, AuthoredAgentConfig } from '../agents/manifest.js';
import { requireResolvedAgentSetup } from '../agents/setup-ledger.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
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
 * @returns Agent manifest.
 */
function manifest(id: string): AgentManifest {
  return {
    adapter: 'custom-http',
    deployments: ['local'],
    displayName: id,
    id,
    kind: 'custom',
    runtime: 'custom',
    version: '0.0.2',
  };
}

/**
 * Creates a minimal authored agent config.
 *
 * @param id Agent id.
 * @returns Authored agent config.
 */
function agentConfig(id: string): AuthoredAgentConfig {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    runtime: {
      kind: 'codex',
      adapter: 'codex-app-server',
      version: '0.130.0',
    },
    mode: 'local',
    transport: { kind: 'stdio' },
    provider: {
      ref: 'agent-openrouter',
      model: 'openai/gpt-5.2',
    },
    deployment: {
      local: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
      remote: {
        endpointRef: 'env:REMOTE_AGENT',
      },
    },
    extensions: {},
  };
}

describe('startTurn orchestrator', () => {
  it('selects an agent before creating and starting a turn', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const handle = await startTurn({
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([]),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [manifest('agent_codex_host')],
      workspaceId: 'ws_demo',
    });

    expect(handle.turn.status).toBe('running');
    expect(handle.agent.id).toBe('agent_codex_host');
    expect(handle.readiness.status).toBe('ready');
    expect(turnExecutor.calls).toEqual([
      {
        context: { requestId: null, workspaceCwd: null, workspaceRoots: [] },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
  });

  it('uses a per-turn model override to select a compatible enabled agent', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const handle = await startTurn({
      input: 'Run tests',
      modelId: 'model_opencode',
      providerRegistry: new ProviderRegistry([]),
      store,
      threadId: 'th_demo',
      turnExecutor,
      agentManifests: [manifest('agent_codex_host'), manifest('agent_opencode_host')],
      workspaceId: 'ws_demo',
    });

    expect(handle.modelId).toBe('model_opencode');
    expect(handle.agent.id).toBe('agent_opencode_host');
    expect(turnExecutor.calls).toEqual([
      {
        context: { requestId: null, workspaceCwd: null, workspaceRoots: [] },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
  });

  it('fails before creating a turn when the model override is unknown', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    await expect(
      startTurn({
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
    store.getWorkspaceResources('ws_demo').models[0] = {
      id: 'model_codex',
      name: 'Codex',
      enabled: false,
      isDefault: true,
    };

    await expect(
      startTurn({
        input: 'Run tests',
        modelId: 'model_codex',
        providerRegistry: new ProviderRegistry([]),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [manifest('agent_codex_host')],
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('Model is disabled: model_codex.');
    expect(turnExecutor.calls).toEqual([]);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  });

  it('fails before creating a turn when no enabled agent supports the model override', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    store.getWorkspaceResources('ws_demo').agents = store
      .getWorkspaceResources('ws_demo')
      .agents.map((agent) =>
        agent.modelId === 'model_opencode' ? { ...agent, status: 'disabled' } : agent
      );

    await expect(
      startTurn({
        input: 'Run tests',
        modelId: 'model_opencode',
        providerRegistry: new ProviderRegistry([]),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [manifest('agent_codex_host'), manifest('agent_opencode_host')],
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
      public override createTurn(workspaceId: string, threadId: string, input: string) {
        sequence.push('store.createTurn');
        return super.createTurn(workspaceId, threadId, input);
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
      dependencies: {
        selectAgent: (defaults, override, manifests) => {
          sequence.push('selector.selectAgent');
          expect(defaults).toEqual({ defaultAgentId: 'agent_codex_host' });
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
        input: 'Run tests',
        providerRegistry: new ProviderRegistry([]),
        store,
        threadId: 'th_demo',
        turnExecutor,
        agentManifests: [manifest('agent_other')],
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow('Agent manifest not found: agent_codex_host.');
    expect(turnExecutor.calls).toEqual([]);
  });

  it('resolves setup for a selected authored agent config without changing turn execution', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const handle = await startTurn({
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
      agentConfigs: [agentConfig('agent_codex_host')],
      agentManifests: [manifest('agent_codex_host')],
      workspaceId: 'ws_demo',
    });

    expect(handle.agentSetup?.agent.id).toBe('agent_codex_host');
    expect(handle.agentSetup?.deployment.mode).toBe('local');
    expect(handle.agentSetup?.provider).toEqual({
      model: 'openai/gpt-5.2',
      origin: 'server-providers',
      providerId: 'agent-openrouter',
      secretRef: 'env:OPENROUTER_API_KEY',
    });
    expect(turnExecutor.calls).toEqual([
      {
        context: { requestId: null, workspaceCwd: null, workspaceRoots: [] },
        input: 'Run tests',
        turnId: handle.turn.id,
      },
    ]);
  });

  it('records resolved setup when a workspace setup ledger is provided', async () => {
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const workspaceDb = openWorkspaceDb(
      mkdtempSync(join(tmpdir(), 'openkit-orchestrator-setup-ledger-')),
      'user_local',
      'ws_demo'
    );
    applyScopedMigrations(workspaceDb);

    try {
      const handle = await startTurn({
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
        agentConfigs: [agentConfig('agent_codex_host')],
        agentManifests: [manifest('agent_codex_host')],
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
    const handle = await startTurn({
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
      agentConfigs: [
        {
          ...agentConfig('agent_codex_host'),
          sandbox: {
            backend: {
              allowedKinds: ['openshell'],
              preferred: 'openshell',
              requiredCapabilities: ['dynamic-network-policy'],
            },
          },
        },
      ],
      agentManifests: [manifest('agent_codex_host')],
      workspaceId: 'ws_demo',
    });

    expect(handle.agentSetup?.backend).toMatchObject({
      preferred: 'openshell',
      requiredCapabilities: ['dynamic-network-policy'],
    });
    expect(turnExecutor.calls[0]?.context?.backendRequirements).toEqual({
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
    const config: AuthoredAgentConfig = {
      ...agentConfig('agent_codex_host'),
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
      agentConfigs: [config],
      agentManifests: [manifest('agent_codex_host')],
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
          requestId: null,
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
    const config: AuthoredAgentConfig = {
      ...agentConfig('agent_codex_host'),
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
        agentConfigs: [config],
        agentManifests: [manifest('agent_codex_host')],
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
          requestId: null,
          sandboxBindingRef: 'lease-binding:orchestrator_1',
          workspaceCwd: null,
          workspaceRoots: [],
        },
        input: 'Run with lease binding',
        turnId: handle.turn.id,
      },
    ]);
  });
});
