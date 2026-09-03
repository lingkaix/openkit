import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackageSchema,
  type SessionWorkspaceMaterializationPlan,
  type WorkerSandboxAccess,
} from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import { ensureLocalUser } from '../auth/identity.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  resolveAgentEnvironmentPackage,
  resolveAgentSessionCompatibilityKey,
} from './agent-environment.js';
import { TurnStartValidationError } from './orchestrator.js';

const USER_TRIGGER_ACTOR = { kind: 'user', id: 'user_local' } as const satisfies ActorRef;
const AUTOMATION_TRIGGER_ACTOR = {
  kind: 'automation',
  id: 'automation_release',
  responsibleUserId: 'user_local',
} as const satisfies ActorRef;

/**
 * Creates one complete resolved setup for AEP contract tests.
 *
 * @param options Explicit manifest changes relevant to the test.
 * @returns Complete manifest and resolved logical model snapshot.
 */
function createTestSetup(
  options: {
    readonly adapter?: string;
    readonly credentialDeclarations?: AgentEnvironmentCredentialDeclaration[];
    readonly logicalModelId?: string;
    readonly mcpIds?: string[];
    readonly network?: WorkerSandboxAccess['network'];
    readonly requiredCapabilities?: Array<
      'backend-local-inference' | 'trusted-worker-inference-relay' | 'worker.runtime-provenance.v1'
    >;
    readonly runtimeBinaries?: Array<{ readonly id: string; readonly path: string }>;
    readonly skillIds?: string[];
  } = {}
): ResolvedAgentSetup {
  const adapter = options.adapter ?? 'codex';
  const logicalModelId = options.logicalModelId ?? 'reasoning';

  return {
    manifest: {
      defaultProfileId: 'default',
      displayName: 'Test Worker',
      id: 'agent_codex_host',
      mcp: (options.mcpIds ?? []).map((id) => ({ id })),
      models: {
        preferredLogicalModelId: logicalModelId,
        allowedLogicalModelIds: [logicalModelId],
      },
      requiredFeatures: [],
      profiles: [{ id: 'default', instructionsRef: adapter, skills: [], mcp: [] }],
      runtime: {
        adapter,
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'node', path: '/usr/local/bin/node' },
          { id: adapter, path: `/usr/local/bin/${adapter}` },
          ...(options.runtimeBinaries ?? []),
        ],
        image: {
          kind: 'reference',
          pullPolicy: 'never',
          ref: `registry.example.com/openkit/worker-${adapter}:test`,
        },
        kind: `${adapter}-runtime`,
        version: '1.0.0',
      },
      sandbox: {
        backend: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: options.requiredCapabilities ?? ['trusted-worker-inference-relay'],
        },
        credentialDeclarations: options.credentialDeclarations ?? [],
        filesystem: [],
        network: options.network ?? [],
      },
      schemaVersion: 1,
      skills: (options.skillIds ?? []).map((id) => ({ id })),
    },
    profileId: 'default',
    logicalModels: {
      preferredLogicalModelId: logicalModelId,
      allowed: [
        {
          id: logicalModelId,
          displayName: logicalModelId,
          capabilities: ['chat-completions', 'responses', 'tool-calling'],
          modelFamilyId: 'test-model-family',
          routes: [
            {
              id: 'primary',
              providerProfileId: 'agent-openrouter',
              providerModel: 'openai/gpt-5.1',
            },
          ],
        },
      ],
    },
  };
}

/**
 * Creates one product turn for AEP tests.
 *
 * @param input User-visible turn input.
 * @returns Accepted turn.
 */
function createTurnFixture(input: string) {
  const store = createDemoStore();
  return store.createTurn('ws_demo', 'th_demo', input, { kind: 'user', id: 'user_local' });
}

describe('agent environment package resolver', () => {
  it('requires one explicit container backend', () => {
    const turn = createTurnFixture('Use the repository');
    const common = {
      agentSetup: createTestSetup(),
      agentSessionId: 'session_1',
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    };

    expect(() => resolveAgentEnvironmentPackage(common)).toThrow(
      'Agent Environment Package resolution requires a container backend.'
    );
    expect(() =>
      resolveAgentEnvironmentPackage({ ...common, backend: { kind: 'host' } as never })
    ).toThrow('Host Agent Environment Package backends are not supported.');
  });

  it('projects the exact trigger actor into V2 scope without legacy identity fields', () => {
    const resolved = resolveAgentEnvironmentPackage({
      agentSetup: createTestSetup({ requiredCapabilities: ['backend-local-inference'] }),
      agentSessionId: 'session_actor_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_actor_1',
      triggerActor: AUTOMATION_TRIGGER_ACTOR,
      turn: createTurnFixture('Project exact actor'),
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.schemaVersion).toBe(4);
    expect(resolved.scope.triggerActor).toEqual(AUTOMATION_TRIGGER_ACTOR);
    expect(resolved.scope).not.toHaveProperty('userId');
    expect(resolved.scope).not.toHaveProperty('automationId');
    expect(resolved.scope).not.toHaveProperty('organizationId');
  });

  it('projects one resolved opaque manifest into the generic relay launch contract', () => {
    const turn = createTurnFixture('Run the opaque worker');
    const setupResult = resolveAgentSetup(createTestSetup({ adapter: 'future-adapter' }).manifest, {
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [
              {
                id: 'primary',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.1',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
          vendor: 'openrouter',
        },
      ]),
    });

    expect(setupResult.diagnostics).toEqual([]);
    if (!setupResult.setup) {
      throw new Error('Expected the opaque agent setup to resolve.');
    }

    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: setupResult.setup,
        agentSessionId: 'session_future_1',
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-07-18T00:00:00.000Z',
        requestId: 'req_future_1',
        turn,
        turnInput: 'Run the opaque worker',
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );

    expect(resolved.runtime).toMatchObject({
      binaries: setupResult.setup.manifest.runtime.binaries,
      command: { argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'] },
      image: {
        kind: 'reference',
        pullPolicy: 'never',
        ref: 'registry.example.com/openkit/worker-future-adapter:test',
      },
    });
    expect(resolved.control.adapter).toEqual({
      kind: 'openkit-worker-shim',
      targetRuntime: 'future-adapter',
    });
    expect(resolved.llm).toEqual({
      mode: 'gateway',
      preferredLogicalModelId: 'reasoning',
      routes: [
        expect.objectContaining({
          credentialVisibility: 'placeholder',
          model: 'reasoning',
          providerInstanceId: 'openkit-gateway',
        }),
      ],
    });
    expect(resolved.supply).not.toHaveProperty('binaries');
    expect(resolved.extensions.openkit).not.toHaveProperty('codexCommand');
    expect(resolved.extensions.openkit).not.toHaveProperty('resultMessagePath');
  });

  it('rejects retired remote Gateway topology inputs', () => {
    const turn = createTurnFixture('Run remotely');
    expect(() =>
      resolveAgentEnvironmentPackage({
        agentSetup: createTestSetup(),
        agentSessionId: 'session_remote_1',
        backend: {
          gatewayUrl: 'https://gateway.example.test',
          kind: 'openshell',
          placement: 'remote',
          workerControlBaseUrl: 'https://nanocore.example.test/api/worker-control',
        } as never,
        createdAt: '2026-07-18T00:00:00.000Z',
        requestId: 'req_remote_1',
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    ).toThrow();
  });

  it('preserves authored development grants with trusted inference and rejects incomplete provenance', () => {
    const turn = createTurnFixture('Reject authority conflict');
    const common = {
      agentSessionId: 'session_reject_1',
      backend: {
        kind: 'openshell' as const,
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_reject_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    };

    const resolved = resolveAgentEnvironmentPackage({
      ...common,
      agentSetup: createTestSetup({
        network: [
          {
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            id: 'github-git-read',
            port: 443,
            protocol: 'rest',
            purpose: 'Clone and fetch Git repositories',
            rules: [
              { method: 'GET', path: '/**/info/refs*' },
              { method: 'POST', path: '/**/git-upload-pack' },
            ],
            scope: 'session',
          },
        ],
        runtimeBinaries: [
          { id: 'git', path: '/usr/bin/git' },
          { id: 'codex-native', path: '/usr/local/lib/codex/bin/codex' },
        ],
      }),
    });

    expect(resolved.schemaVersion).toBe(4);
    expect(resolved.control).toMatchObject({
      mode: 'sandbox-integration',
      bindings: {
        inference: {
          pathPrefix: '/inference/',
          tokenRef: 'runtime://openkit/inference-token',
        },
      },
    });
    expect(resolved.llm).toEqual({
      mode: 'gateway',
      preferredLogicalModelId: 'reasoning',
      routes: [
        expect.objectContaining({
          credentialVisibility: 'placeholder',
          endpoint: {
            kind: 'openai-compatible',
            upstream: {
              baseUrlRef: 'openkit-gateway',
              kind: 'nanocore-gateway',
            },
          },
          providerInstanceId: 'openkit-gateway',
        }),
      ],
    });
    expect(resolved.credentials.declarations).toEqual([]);
    expect(resolved.policy.network?.rules).toEqual([
      {
        action: 'allow',
        binaries: ['/usr/bin/git'],
        host: 'github.com',
        id: 'github-git-read',
        port: 443,
        protocol: 'rest',
        purpose: 'Clone and fetch Git repositories',
        rules: [
          { method: 'GET', path: '/**/info/refs*' },
          { method: 'POST', path: '/**/git-upload-pack' },
        ],
        scope: 'session',
      },
    ]);
    const baseBuildSetup = createTestSetup();
    const buildSetup = {
      ...baseBuildSetup,
      manifest: {
        ...baseBuildSetup.manifest,
        runtime: {
          ...baseBuildSetup.manifest.runtime,
          image: {
            arguments: { NODE_VERSION: '24.16.0' },
            contextRef: 'build-context://empty/v1',
            egress: [{ host: 'registry.npmjs.org', port: 443 }],
            input: { content: 'FROM node:24.16.0', kind: 'dockerfile' as const },
            kind: 'build' as const,
            layerLimit: 128,
            outputLimitBytes: 21_474_836_480,
            timeLimitSeconds: 1800,
          },
        },
      },
    };
    expect(
      resolveAgentEnvironmentPackage({ ...common, agentSetup: buildSetup }).runtime.image
    ).toMatchObject({
      contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      contextRef: 'build-context://empty/v1',
      egress: [{ host: 'registry.npmjs.org', port: 443 }],
      kind: 'build',
      layerLimit: 128,
      outputLimitBytes: 21_474_836_480,
      timeLimitSeconds: 1800,
    });
    expect(() =>
      resolveAgentEnvironmentPackage({
        ...common,
        agentSetup: {
          ...buildSetup,
          manifest: {
            ...buildSetup.manifest,
            runtime: {
              ...buildSetup.manifest.runtime,
              image: {
                ...buildSetup.manifest.runtime.image,
                contextRef: 'workspace://build-context',
              },
            },
          },
        },
      })
    ).toThrow();
    expect(
      resolveAgentEnvironmentPackage({
        ...common,
        agentSetup: createTestSetup({
          requiredCapabilities: ['worker.runtime-provenance.v1'],
        }),
      }).backend.requiredCapabilities
    ).toEqual(
      expect.arrayContaining(['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'])
    );
  });

  it('resolves selected MCP supply without exposing its server topology', () => {
    const turn = createTurnFixture('Use static supply');
    const resolved = resolveAgentEnvironmentPackage({
      agentSetup: createTestSetup({
        mcpIds: ['github'],
        skillIds: ['repo-guidelines'],
      }),
      agentSessionId: 'session_supply_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_supply_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
      workspaceMcpServerCatalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'github',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 60_000,
            transport: {
              args: ['fixtures/echo.mjs'],
              command: 'node',
              environment: {},
              kind: 'stdio',
            },
          },
        ],
      },
    });

    expect(resolved.supply.skills).toEqual([expect.objectContaining({ id: 'repo-guidelines' })]);
    expect(resolved.supply.mcpServers).toEqual([
      expect.objectContaining({
        allowedTools: ['echo'],
        catalogDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        id: 'github',
        schemaPolicy: 'tracking',
      }),
    ]);
    expect(resolved.supply.mcpServers[0]).not.toHaveProperty('command');
    expect(resolved.supply.mcpServers[0]).not.toHaveProperty('transport');
    expect(resolved.supply.mcpServers[0]).not.toHaveProperty('credentialBindings');
    expect(resolved.capabilities).toEqual({
      mode: 'disabled',
      protocol: 'openkit-worker-capability-v1',
      routes: [],
    });
    expect(resolved).not.toHaveProperty('providers');
  });

  it('projects one prepared worker Context Package through the existing generated context slot', () => {
    const turn = createTurnFixture('Use the prepared Context Package');
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const resolved = resolveAgentEnvironmentPackage({
      agentSetup: createTestSetup(),
      agentSessionId: 'session_context_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      preparedContextPackage: {
        contentDigest,
        workspaceRoot: {
          access: 'read-only',
          id: `context_${turn.id}`,
          sourceKind: 'materialized-dir',
          sourcePath: '/private/context-package',
          workerPath: '/openkit/context',
        },
      },
      requestId: 'req_context_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.workspace.inputs).toEqual([
      {
        access: 'read-only',
        id: `context_${turn.id}`,
        kind: 'generated',
        materialization: {
          contentDigest,
          slotId: 'context',
          strategy: 'filesystem',
        },
        source: {
          kind: 'generated',
          pathRef: `threads/${turn.threadId}/turns/${turn.id}/context-package`,
        },
        target: '/openkit/context',
      },
    ]);
  });

  it('records catalog-resolved workspace lineage without inventing provider attachments', () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-aep-source-'));
    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
      cwd: repositoryPath,
    });
    execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, 'README.md'), '# AEP source\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryPath, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();
    const turn = createTurnFixture('Use catalog source');

    const resolved = resolveAgentEnvironmentPackage({
      agentSetup: createTestSetup(),
      agentSessionId: 'session_source_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_source_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: null,
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Main repository',
            id: 'main-repo',
            kind: 'git',
            locator: { defaultRef: 'main', url: 'https://github.com/openkit/openkit.git' },
            sensitivity: 'internal',
            status: 'active',
            vaultGrantRef: 'grant_github_read',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: repositoryPath,
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo: 'main-repo' },
    });

    expect(resolved.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      commit: baseCommit,
      sourceId: 'main-repo',
      sourceRef: 'main-repo',
      vaultGrantRef: 'grant_github_read',
    });
    expect(resolved).not.toHaveProperty('providers');
  });

  it('does not apply responsible-user identity to server-scoped Vault authority', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-direct-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';
    const declaration: AgentEnvironmentCredentialDeclaration = {
      id: 'anthropic_api_key',
      targetEnvVarName: 'ANTHROPIC_API_KEY',
      vaultGrantId: 'grant_anthropic_api_key',
      visibility: 'runtime-env',
    };
    const runtimeEnvCredentials: Array<{
      credentialValue: string;
      targetEnvVarName: string;
    }> = [];

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 21) });
    vaultUnlockState.backend().store({
      material: 'direct_secret_value',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_anthropic_api_key',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_anthropic_api_key',
      displayName: 'Anthropic API key',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_anthropic_api_key',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_anthropic_api_key',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_direct_1',
      vaultReferenceId: 'vault_anthropic_api_key',
    });

    try {
      const turn = createTurnFixture('Run Pi directly');
      const resolved = resolveAgentEnvironmentPackage({
        agentSetup: createTestSetup({
          adapter: 'pi',
          credentialDeclarations: [declaration],
          network: [
            {
              access: 'read-write',
              binaries: ['/usr/local/bin/node'],
              host: 'api.anthropic.com',
              id: 'anthropic-api',
              port: 443,
              protocol: 'rest',
            },
          ],
          logicalModelId: 'claude',
          requiredCapabilities: [],
        }),
        agentSessionId: 'session_direct_1',
        backend: {
          kind: 'openshell',
        },
        coreDb,
        createdAt: now,
        requestId: 'req_direct_1',
        runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
        turn,
        triggerActor: AUTOMATION_TRIGGER_ACTOR,
        vaultBackend: () => vaultUnlockState.backend(),
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      });

      expect(resolved.llm).toEqual({
        mode: 'gateway',
        preferredLogicalModelId: 'claude',
        routes: [
          expect.objectContaining({
            credentialVisibility: 'placeholder',
            model: 'claude',
            providerInstanceId: 'openkit-gateway',
          }),
        ],
      });
      expect(resolved.policy.network?.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            binaries: ['/usr/local/bin/node'],
            id: 'anthropic-api',
          }),
        ])
      );
      expect(resolved.vault.references[0]).not.toHaveProperty('providerInstanceId');
      expect(resolved.scope.triggerActor).toEqual(AUTOMATION_TRIGGER_ACTOR);
      expect(runtimeEnvCredentials).toEqual([
        {
          credentialValue: 'direct_secret_value',
          targetEnvVarName: 'ANTHROPIC_API_KEY',
        },
      ]);
      expect(JSON.stringify(resolved)).not.toContain('direct_secret_value');
      expect(listVaultInjectionPlans(coreDb)).toHaveLength(1);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('materializes a Workspace-bound credential requirement without exposing its value', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-workspace-binding-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';
    const runtimeEnvCredentials: string[] = [];

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 24) });
    vaultUnlockState.backend().store({
      material: 'workspace_github_secret',
      metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
      referenceId: 'vault_workspace_github',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_workspace_github',
      displayName: 'Workspace GitHub token',
      now: () => now,
      ownerScope: 'workspace',
      referenceId: 'vault_workspace_github',
      secretKind: 'provider-api-key',
      workspaceId: 'ws_demo',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_workspace_github',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'workspace',
      targetAgentId: 'agent_codex_host',
      targetAgentSessionId: 'session_workspace_binding',
      vaultReferenceId: 'vault_workspace_github',
      workspaceId: 'ws_demo',
    });

    try {
      const resolved = resolveAgentEnvironmentPackage({
        agentSetup: createTestSetup({
          credentialDeclarations: [
            {
              id: 'github_token',
              requirementId: 'github-token',
              targetEnvVarName: 'GITHUB_TOKEN',
              vaultGrantId: 'grant_workspace_github',
              visibility: 'runtime-env',
            },
          ],
          requiredCapabilities: [],
        }),
        agentSessionId: 'session_workspace_binding',
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: now,
        requestId: 'req_workspace_binding',
        runtimeEnvCredentialSink: (credential) =>
          runtimeEnvCredentials.push(credential.credentialValue),
        turn: createTurnFixture('Use the Workspace GitHub account'),
        triggerActor: USER_TRIGGER_ACTOR,
        vaultBackend: () => vaultUnlockState.backend(),
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      });

      expect(resolved.credentials.declarations).toEqual([
        expect.objectContaining({
          requirementId: 'github-token',
          vaultGrantId: 'grant_workspace_github',
        }),
      ]);
      expect(runtimeEnvCredentials).toEqual(['workspace_github_secret']);
      expect(JSON.stringify(resolved)).not.toContain('workspace_github_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('previews the exact compatibility key without Vault or credential effects', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-compatibility-preview-'));
    const coreDb = openCoreDb(dataRoot);
    const now = '2026-07-18T00:00:00.000Z';
    const turn = createTurnFixture('Preview compatibility without effects');
    const declaration: AgentEnvironmentCredentialDeclaration = {
      id: 'preview_api_key',
      targetEnvVarName: 'PREVIEW_API_KEY',
      vaultGrantId: 'grant_preview_api_key',
      visibility: 'runtime-env',
    };
    const agentSetup = createTestSetup({
      adapter: 'pi',
      credentialDeclarations: [declaration],
      network: [
        {
          access: 'read-write',
          binaries: ['/usr/local/bin/node'],
          host: 'api.example.invalid',
          id: 'preview-api',
          port: 443,
          protocol: 'rest',
        },
      ],
      logicalModelId: 'preview-model',
      requiredCapabilities: [],
    });
    let sinkCalls = 0;
    let vaultBackendCalls = 0;

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_preview_api_key',
      displayName: 'Preview API key',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_preview_api_key',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_preview_api_key',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_preview_1',
      vaultReferenceId: 'vault_preview_api_key',
    });

    try {
      const compatibilityKey = resolveAgentSessionCompatibilityKey({
        agentSessionId: 'session_preview_1',
        agentSetup,
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: now,
        requestId: 'req_preview_1',
        runtimeEnvCredentialSink: () => {
          sinkCalls += 1;
        },
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        vaultBackend: () => {
          vaultBackendCalls += 1;
          throw new Error('Compatibility preview must not resolve the Vault backend.');
        },
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      } as Parameters<typeof resolveAgentSessionCompatibilityKey>[0]);

      expect(compatibilityKey).toMatch(/^sha256:/);
      expect(sinkCalls).toBe(0);
      expect(vaultBackendCalls).toBe(0);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
      const keyForContextDigest = (character: string) => {
        const environmentPackage = resolveAgentEnvironmentPackage({
          agentSessionId: 'session_context_digest',
          agentSetup: createTestSetup(),
          backend: { kind: 'openshell' },
          createdAt: now,
          preparedContextPackage: {
            contentDigest: `sha256:${character.repeat(64)}`,
            workspaceRoot: {
              access: 'read-only',
              id: `context_${turn.id}`,
              sourceKind: 'materialized-dir',
              sourcePath: `/private/context-${character}`,
              workerPath: '/openkit/context',
            },
          },
          requestId: 'req_context_digest',
          turn,
          triggerActor: AUTOMATION_TRIGGER_ACTOR,
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        });
        return (
          environmentPackage.extensions.openkit as {
            sessionWorkspace: SessionWorkspaceMaterializationPlan;
          }
        ).sessionWorkspace.compatibilityKey.digest;
      };
      expect(keyForContextDigest('a')).toBe(keyForContextDigest('b'));
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies stale AEP authority before Vault resolution or injection side effects', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-vault-authority-'));
    const coreDb = openCoreDb(dataRoot);
    const now = '2026-07-18T00:00:00.000Z';
    let backendCalls = 0;
    const runtimeEnvCredentials: string[] = [];

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_stale_authority',
      displayName: 'Stale authority credential',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_stale_authority',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_stale_authority',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_stale_authority',
      vaultReferenceId: 'vault_stale_authority',
    });
    coreDb.sqlite
      .prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(Date.parse(now), 'user_local');

    try {
      let error: unknown;
      try {
        resolveAgentEnvironmentPackage({
          agentSetup: createTestSetup({
            credentialDeclarations: [
              {
                id: 'stale_authority',
                targetEnvVarName: 'STALE_AUTHORITY_SECRET',
                vaultGrantId: 'grant_stale_authority',
                visibility: 'runtime-env',
              },
            ],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/codex'],
                host: 'api.example.test',
                id: 'stale-authority-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_stale_authority',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: 'req_stale_authority',
          runtimeEnvCredentialSink: (credential) =>
            runtimeEnvCredentials.push(credential.credentialValue),
          turn: createTurnFixture('Reject stale Vault authority'),
          triggerActor: USER_TRIGGER_ACTOR,
          vaultBackend: () => {
            backendCalls += 1;
            throw new Error('Vault backend must not be resolved after authority loss.');
          },
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(TurnStartValidationError);
      expect(error).toMatchObject({ code: 'workspace_access_denied', status: 403 });
      expect(backendCalls).toBe(0);
      expect(runtimeEnvCredentials).toEqual([]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expectedError: 'Credential requirement binding must use a Workspace grant: scope_user',
      grantTarget: {},
      name: 'user',
      referenceScope: { ownerScope: 'user' as const, userId: 'user_other' },
      triggerActor: AUTOMATION_TRIGGER_ACTOR,
    },
    {
      expectedError: 'Credential requirement binding must use a Workspace grant: scope_workspace',
      grantTarget: {},
      name: 'workspace',
      referenceScope: { ownerScope: 'workspace' as const, workspaceId: 'ws_other' },
      triggerActor: USER_TRIGGER_ACTOR,
    },
    {
      expectedError: 'Vault grant targets a different agent: scope_agent',
      grantTarget: { targetAgentId: 'agent_other' },
      name: 'agent',
      referenceScope: { ownerScope: 'server' as const },
      triggerActor: USER_TRIGGER_ACTOR,
    },
    {
      expectedError: 'Vault grant targets an unproven capability: scope_capability',
      grantTarget: { targetCapabilityId: 'mcp.github.call_tool' },
      name: 'capability',
      referenceScope: { ownerScope: 'server' as const },
      triggerActor: USER_TRIGGER_ACTOR,
    },
  ])('rejects a mismatched $name credential grant before sinks or injection records', ({
    expectedError,
    grantTarget,
    name,
    referenceScope,
    triggerActor,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-aep-scope-${name}-`));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';
    const declarationId = `scope_${name}`;
    const referenceId = `vault_${declarationId}`;
    const grantId = `grant_${declarationId}`;
    const runtimeEnvCredentials: string[] = [];

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 23) });
    vaultUnlockState.backend().store({
      material: `secret_${name}`,
      metadata: referenceScope,
      referenceId,
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: `encrypted-file://server/vault/${referenceId}`,
      displayName: `${name} scope credential`,
      now: () => now,
      ...referenceScope,
      referenceId,
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId,
      lifetime: 'agent-session',
      now: () => now,
      ...referenceScope,
      ...grantTarget,
      targetAgentSessionId: 'session_scope_1',
      vaultReferenceId: referenceId,
    });

    try {
      expect(() =>
        resolveAgentEnvironmentPackage({
          agentSetup: createTestSetup({
            credentialDeclarations: [
              {
                id: declarationId,
                ...(name === 'user' || name === 'workspace'
                  ? { requirementId: `requirement_${name}` }
                  : {}),
                targetEnvVarName: 'SCOPE_SECRET',
                vaultGrantId: grantId,
                visibility: 'runtime-env',
              },
            ],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/codex'],
                host: 'api.example.test',
                id: 'scope-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_scope_1',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: `req_scope_${name}`,
          runtimeEnvCredentialSink: (credential) =>
            runtimeEnvCredentials.push(credential.credentialValue),
          turn: createTurnFixture(`Reject ${name} scope`),
          triggerActor,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow(expectedError);
      expect(runtimeEnvCredentials).toEqual([]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('writes no receipt when a credential sink fails after Vault resolution', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-direct-sink-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 22) });
    vaultUnlockState.backend().store({
      material: 'missing_sink_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_missing_sink',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_missing_sink',
      displayName: 'Missing sink credential',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_missing_sink',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_missing_sink',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_missing_sink',
      vaultReferenceId: 'vault_missing_sink',
    });

    try {
      const turn = createTurnFixture('Reject missing sink');
      expect(() =>
        resolveAgentEnvironmentPackage({
          agentSetup: createTestSetup({
            adapter: 'pi',
            credentialDeclarations: [
              {
                id: 'missing_sink',
                targetEnvVarName: 'ANTHROPIC_API_KEY',
                vaultGrantId: 'grant_missing_sink',
                visibility: 'runtime-env',
              },
            ],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/node'],
                host: 'api.anthropic.com',
                id: 'anthropic-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            logicalModelId: 'claude',
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_missing_sink',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: 'req_missing_sink',
          runtimeEnvCredentialSink: () => {
            throw new Error('credential sink failed');
          },
          turn,
          triggerActor: AUTOMATION_TRIGGER_ACTOR,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow('credential sink failed');
      expect(listVaultInjectionPlans(coreDb)).toHaveLength(1);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects retired backend-local inference inputs', () => {
    const turn = createTurnFixture('Reject backend-local inference');
    const common = {
      agentSessionId: 'session_backend_local_1',
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_backend_local_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    };

    expect(() =>
      resolveAgentEnvironmentPackage({
        ...common,
        agentSetup: createTestSetup({ requiredCapabilities: ['backend-local-inference'] }),
        backend: {
          inferenceBaseUrl: 'https://inference.local/v1',
          kind: 'openshell',
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        } as never,
      })
    ).toThrow();
  });

  it('preserves the manifest network grant exact binary scope', () => {
    const turn = createTurnFixture('Use a declared public endpoint');
    const setup = createTestSetup({
      network: [
        {
          host: 'docs.example.com',
          id: 'public-docs',
          port: 443,
          purpose: 'Read public documentation',
          binaries: ['/usr/local/bin/codex'],
        },
      ],
      requiredCapabilities: ['backend-local-inference'],
    });
    const resolved = resolveAgentEnvironmentPackage({
      agentSessionId: 'session_network_defaults_1',
      agentSetup: setup,
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_network_defaults_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.policy.network?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binaries: ['/usr/local/bin/codex'],
          id: 'public-docs',
        }),
      ])
    );
  });
});
