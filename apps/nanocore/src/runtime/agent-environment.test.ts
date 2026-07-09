import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { listInjectionPlans } from '../injection-plans.js';
import { listInjectionReceipts } from '../injection-receipts.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createVaultGrant } from '../vault-grants.js';
import { createVaultReference } from '../vault-references.js';
import { createVaultUnlockState } from '../vault-unlock-state.js';
import { listVaultUseRecords } from '../vault-use-records.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';

describe('agent environment package resolver', () => {
  it('rejects package resolution without an explicit container backend', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use the repository');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');

    expect(() =>
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_1',
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_1',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    ).toThrow('Agent Environment Package resolution requires a container backend.');
  });

  it('rejects host backend targets even when explicitly requested', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject host backend');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');

    expect(() =>
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_1',
        backend: { kind: 'host' } as never,
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: null,
        turn,
        workspaceCwd: null,
        workspaceRoots: [],
      })
    ).toThrow('Host Agent Environment Package backends are not supported.');
  });

  it('resolves an OpenShell package with sidecar control and sandbox-local inference routing', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run OpenShell mode');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_openshell_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_openshell_1',
        turn,
        turnInput: 'Run OpenShell mode',
        workspaceCwd: null,
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/Users/m5pro/Documents/AI/openkit',
            workerPath: '/workspace/openkit',
          },
        ],
      })
    );
    const serialized = JSON.stringify(resolved);

    expect(resolved.runtime.image).toMatchObject({
      kind: 'container-image',
      ref: 'ghcr.io/openkit/codex-worker:test',
    });
    expect(resolved.runtime.command).toMatchObject({
      argv: ['openkit-codex-shim', '--package', '/openkit/config/package.json'],
      workingDirectory: '/workspace/openkit',
    });
    expect(resolved.workspace.inputs[0]?.materialization).toEqual({
      changeSetManifestPath: '/openkit/session/workspace-changes.json',
      strategy: 'git',
    });
    expect(resolved.extensions.openkit).toMatchObject({
      turnInput: 'Run OpenShell mode',
      resultMessagePath: '/openkit/session/final-message.txt',
      codexCommand: [
        'codex',
        'exec',
        '--json',
        '--output-last-message',
        '/openkit/session/final-message.txt',
        '--cd',
        '/workspace/openkit/worktrees/main',
        '--dangerously-bypass-approvals-and-sandbox',
        'Run OpenShell mode',
      ],
    });
    const sessionWorkspace = (
      resolved.extensions.openkit as {
        sessionWorkspace?: {
          compatibilityKey: { digest: string };
          decision: { kind: string };
          layout: { root: string; slots: Array<{ id: string; path: string }> };
          materialization: { inputs: Array<{ inputId: string; slotId: string }> };
        };
      }
    ).sessionWorkspace;
    expect(sessionWorkspace).toMatchObject({
      compatibilityKey: {
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      decision: { kind: 'create' },
      layout: {
        root: '/workspace/openkit',
        slots: expect.arrayContaining([
          expect.objectContaining({
            id: 'main-worktree',
            path: '/workspace/openkit/worktrees/main',
          }),
          expect.objectContaining({ id: 'turn-inputs', path: '/workspace/openkit/inputs' }),
          expect.objectContaining({ id: 'session', path: '/openkit/session' }),
          expect.objectContaining({ id: 'context', path: '/openkit/context' }),
          expect.objectContaining({ id: 'instructions', path: '/openkit/instructions' }),
        ]),
      },
      materialization: {
        inputs: [expect.objectContaining({ inputId: 'repo', slotId: 'main-worktree' })],
      },
    });
    expect(resolved.control).toMatchObject({
      mode: 'sidecar',
      endpoint: {
        baseUrl: 'https://control.local/v1/worker-control',
        implementation: 'openkit-sidecar',
      },
      relay: {
        fallback: 'transcript-sink',
        kind: 'outbound-websocket',
        upstream: 'https://nanocore.local/api/worker-control',
      },
    });
    expect(resolved.control.auth).toMatchObject({
      credentialVisibility: 'none',
      kind: 'sandbox-session-token',
      tokenRef: 'runtime://openkit/control-token',
    });
    expect(resolved.capabilities).toMatchObject({
      mode: 'sidecar',
      endpoint: {
        baseUrl: 'https://capability.local/v1',
        implementation: 'openkit-sidecar',
      },
      routes: [
        expect.objectContaining({ family: 'knowledge.search' }),
        expect.objectContaining({ family: 'knowledge.read' }),
        expect.objectContaining({ family: 'knowledge.proposal' }),
        expect.objectContaining({ family: 'artifact.read' }),
        expect.objectContaining({ family: 'diagnostic.read' }),
      ],
    });
    expect(resolved.llm.routes[0]?.endpoint).toMatchObject({
      upstream: {
        kind: 'nanocore-gateway',
      },
      workerBaseUrl: 'https://inference.local/v1',
    });
    expect(resolved.providers).toMatchObject({
      providerProfiles: [
        {
          id: 'codex',
          kind: 'oauth',
          displayName: 'Codex',
        },
      ],
      providerInstances: [
        {
          id: 'codex',
          profileId: 'codex',
          vendor: 'codex',
          displayName: 'Codex',
          kind: 'oauth',
        },
      ],
      attachments: [
        {
          id: 'attach_codex',
          providerInstanceId: 'codex',
          binaryIds: ['codex'],
        },
      ],
    });
    expect(resolved.policy.filesystem).toMatchObject({
      default: 'deny',
      enforcement: 'openshell',
    });
    expect(resolved.policy.snapshotId).toBe(WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID);
    expect(resolved.backend).toMatchObject({
      allowedKinds: ['openshell'],
      preferred: 'openshell',
      requiredCapabilities: expect.arrayContaining([
        'container',
        'transcript-sink',
        'sidecar-control-endpoint',
        'sidecar-capability-endpoint',
        'nanocore-inference-upstream',
      ]),
    });
    expect(serialized).not.toContain('/Users/m5pro');
  });

  it('records catalog-resolved workspace source lineage in the AEP snapshot', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use catalog source');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_catalog_source_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_catalog_source_1',
        turn,
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
            sourcePath: '/Users/m5pro/Documents/AI/openkit',
            workerPath: '/workspace/openkit',
          },
        ],
        workspaceSourceRefs: { repo: 'main-repo' },
      })
    );

    expect(resolved.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      kind: 'git',
      locator: { defaultRef: 'main', url: 'https://github.com/openkit/openkit.git' },
      sourceId: 'main-repo',
      sourceRef: 'main-repo',
      vaultGrantRef: 'grant_github_read',
    });
  });

  it('normalizes user-declared sandbox filesystem and network access into policy intent', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run sandbox policy');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');

    const resolved = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'session_sandbox_policy_1',
      backend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-07-05T00:00:00.000Z',
      requestId: 'req_sandbox_policy_1',
      sandboxAccess: {
        filesystem: [
          {
            access: 'read-write',
            id: 'build_cache',
            purpose: 'Build cache',
            scope: 'session',
            targetPath: '/sandbox/.cache/build',
          },
        ],
        network: [
          {
            access: 'read-write',
            binaries: ['/usr/bin/npm'],
            host: 'registry.npmjs.org',
            id: 'npm_registry',
            port: 443,
            protocol: 'rest',
            purpose: 'Install package dependencies',
          },
        ],
      },
      turn,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.policy.process).toMatchObject({
      default: 'allow',
      enforcement: 'openshell',
    });
    expect(resolved.policy.filesystem?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: 'read-write',
          id: 'openkit-working-directory',
          workerPath: '/workspace/repo',
        }),
        expect.objectContaining({
          access: 'read-write',
          id: 'build_cache',
          purpose: 'Build cache',
          scope: 'session',
          workerPath: '/sandbox/.cache/build',
        }),
      ])
    );
    expect(resolved.policy.network?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: 'read-write',
          binaries: ['/usr/bin/npm'],
          host: 'registry.npmjs.org',
          id: 'npm_registry',
          port: 443,
          protocol: 'rest',
          purpose: 'Install package dependencies',
        }),
      ])
    );
  });

  it('resolves worker Skill and MCP supply through the NanoCore catalog', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run catalog supply');
    const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
    const agent = {
      ...baseAgent,
      skillIds: ['repo-guidelines'],
      config: {
        ...baseAgent.config,
        mcpServerIds: ['github'],
      },
    } as typeof baseAgent;
    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_supply_catalog_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_supply_catalog_1',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );

    expect(resolved.supply.skills).toEqual([
      expect.objectContaining({
        allowedRuntimeAdapters: ['codex'],
        id: 'repo-guidelines',
        integrity: { sha256: 'sha256-repo-guidelines-v1' },
        materialization: expect.objectContaining({ kind: 'filesystem-copy' }),
        reviewStatus: 'approved',
        sourceRef: 'server:skills/repo-guidelines',
      }),
    ]);
    expect(resolved.supply.mcpServers).toEqual([
      expect.objectContaining({
        allowedTools: ['repos.get', 'issues.list'],
        approvalRequiredTools: ['issues.list'],
        id: 'github',
        providerInstanceIds: ['provider_github_read'],
        materialization: expect.objectContaining({ kind: 'generated-config' }),
        reviewStatus: 'approved',
        secretRefIds: ['vault_github_read'],
        transport: 'stdio',
        vaultGrantIds: ['grant_github_read'],
        toolSchemas: [
          expect.objectContaining({
            inputSchema: expect.objectContaining({
              required: ['owner', 'repo'],
            }),
            name: 'repos.get',
          }),
          expect.objectContaining({
            inputSchema: expect.objectContaining({
              required: ['owner', 'repo'],
            }),
            name: 'issues.list',
          }),
        ],
      }),
    ]);
    expect(resolved.providers.providerInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider_github_read',
          profileId: 'github_mcp',
          vaultRefIds: ['vault_github_read'],
        }),
      ])
    );
    expect(resolved.providers.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'attach_github_mcp',
          providerInstanceId: 'provider_github_read',
          vaultGrantIds: ['grant_github_read'],
        }),
      ])
    );
    expect(resolved.vault).toMatchObject({
      references: [
        {
          id: 'vault_github_read',
          kind: 'secret-ref',
          providerInstanceId: 'provider_github_read',
        },
      ],
      grants: [
        {
          id: 'grant_github_read',
          scope: 'turn',
          vaultRefId: 'vault_github_read',
        },
      ],
    });
    expect(JSON.stringify(resolved.supply)).not.toContain('GITHUB_TOKEN');
    expect(JSON.stringify(resolved.vault)).not.toContain('GITHUB_TOKEN');
  });

  it('derives OpenShell MCP provider attachment from durable vault grants', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-vault-grant-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';
    const providerCredentials: Array<{
      credentialExpiresAt: string | undefined;
      credentialKey: string;
      providerInstanceId: string;
      providerType: string;
    }> = [];

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    vaultUnlockState.backend().store({
      material: 'ghp_vault_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => now,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2026-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      policyDecisionId: 'pd_repo_read_1',
      targetAgentSessionId: 'session_supply_catalog_1',
      vaultReferenceId: 'vault_github_read',
      now: () => now,
    });

    try {
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Run catalog supply');
      const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
      const agent = {
        ...baseAgent,
        config: {
          ...baseAgent.config,
          mcpServerIds: ['github'],
        },
      } as typeof baseAgent;
      const resolved = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agent,
          agentSessionId: 'session_supply_catalog_1',
          backend: {
            controlRelayUpstream: 'https://nanocore.local/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
          },
          coreDb,
          createdAt: now,
          providerCredentialSink: (credential) => {
            providerCredentials.push({
              credentialExpiresAt: credential.credentialExpiresAt,
              credentialKey: credential.credentialKey,
              providerInstanceId: credential.providerInstanceId,
              providerType: credential.providerType,
            });
          },
          requestId: 'req_supply_catalog_1',
          turn,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      );
      const serialized = JSON.stringify(resolved);

      expect(resolved.vault.grants).toEqual([
        expect.objectContaining({
          expiresAt: '2026-07-05T01:00:00.000Z',
          id: 'grant_github_read',
          scope: 'turn',
          vaultRefId: 'vault_github_read',
        }),
      ]);
      expect(resolved.vault.references).toEqual([
        expect.objectContaining({
          id: 'vault_github_read',
          secretRef: 'vault://vault_github_read',
        }),
      ]);
      expect(resolved.providers.providerProfiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'okp-local-github-mcp-v1',
            displayName: 'GitHub MCP',
          }),
        ])
      );
      expect(resolved.providers.providerInstances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'provider_github_read',
            profileId: 'okp-local-github-mcp-v1',
          }),
        ])
      );
      expect(providerCredentials).toEqual([
        {
          credentialExpiresAt: '2026-07-05T01:00:00.000Z',
          credentialKey: 'GITHUB_TOKEN',
          providerInstanceId: 'provider_github_read',
          providerType: 'okp-local-github-mcp-v1',
        },
      ]);
      expect(resolved.providers.providerProfiles).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'github_mcp',
          }),
        ])
      );
      expect(listInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          backendCapabilityRequirement: 'sandbox-provider:okp-local-github-mcp-v1',
          injectionVisibility: 'backend-provider',
          packageSnapshotId: resolved.snapshotId,
        }),
      ]);
      expect(listInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'session_supply_catalog_1',
          expiresAt: '2026-07-05T01:00:00.000Z',
          grantId: 'grant_github_read',
        }),
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          outcome: 'succeeded',
          receiptId: expect.stringContaining('receipt_'),
          resolvingPath: 'grant',
          vaultReferenceId: 'vault_github_read',
        }),
      ]);
      expect(serialized).not.toContain('ghp_vault_token');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires policy and session binding for durable GitHub read providers', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-github-read-policy-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run catalog supply');
    const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
    const agent = {
      ...baseAgent,
      config: {
        ...baseAgent.config,
        mcpServerIds: ['github'],
      },
    } as typeof baseAgent;

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 11) });
    vaultUnlockState.backend().store({
      material: 'ghp_vault_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => now,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2026-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      targetAgentSessionId: 'other_session',
      vaultReferenceId: 'vault_github_read',
      now: () => now,
    });

    try {
      expect(() =>
        resolveAgentEnvironmentPackage({
          agent,
          agentSessionId: 'session_supply_catalog_1',
          backend: {
            controlRelayUpstream: 'https://nanocore.local/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
          },
          coreDb,
          createdAt: now,
          providerCredentialSink: () => {},
          requestId: 'req_supply_catalog_1',
          turn,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow('Vault grant targets a different agent session: github_mcp_read');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires backend-provider permission for durable GitHub read providers', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-github-read-decision-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run catalog supply');
    const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
    const agent = {
      ...baseAgent,
      config: {
        ...baseAgent.config,
        mcpServerIds: ['github'],
      },
    } as typeof baseAgent;

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 12) });
    vaultUnlockState.backend().store({
      material: 'ghp_vault_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => now,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-file'],
      expiresAt: '2026-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      targetAgentSessionId: 'session_supply_catalog_1',
      vaultReferenceId: 'vault_github_read',
      now: () => now,
    });

    try {
      expect(() =>
        resolveAgentEnvironmentPackage({
          agent,
          agentSessionId: 'session_supply_catalog_1',
          backend: {
            controlRelayUpstream: 'https://nanocore.local/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
          },
          coreDb,
          createdAt: now,
          providerCredentialSink: () => {},
          requestId: 'req_supply_catalog_1',
          turn,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow('Vault grant must allow backend-provider injection: github_mcp_read');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('attaches GitHub read provider for read-only Git data sources without GitHub MCP', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-github-read-source-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Read private repository');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 13) });
    vaultUnlockState.backend().store({
      material: 'ghp_read_only_source_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => now,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2026-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      policyDecisionId: 'pd_repo_read_1',
      targetAgentSessionId: 'session_private_repo_1',
      vaultReferenceId: 'vault_github_read',
      now: () => now,
    });

    try {
      const resolved = resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_private_repo_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        coreDb,
        createdAt: now,
        providerCredentialSink: () => {},
        requestId: 'req_private_repo_1',
        turn,
        vaultBackend: () => vaultUnlockState.backend(),
        workspaceCwd: '/workspace/repo',
        workspaceDataSourceCatalog: {
          schemaVersion: 1,
          sources: [
            {
              access: 'read-only',
              allowedSlotKinds: ['input'],
              displayName: 'Private repository',
              id: 'private-repo',
              kind: 'git',
              locator: { defaultRef: 'main', url: 'https://github.com/openkit/private.git' },
              sensitivity: 'confidential',
              status: 'active',
              vaultGrantRef: 'grant_github_read',
            },
          ],
        },
        workspaceRoots: [
          {
            access: 'read-only',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/Users/m5pro/private',
            workerPath: '/workspace/private',
          },
        ],
        workspaceSourceRefs: { repo: 'private-repo' },
      });
      const serialized = JSON.stringify(resolved);

      expect(resolved.workspace.inputs[0]?.source).toMatchObject({
        sourceRef: 'private-repo',
        vaultGrantRef: 'grant_github_read',
      });
      expect(resolved.providers.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerInstanceId: 'provider_github_read',
            vaultGrantIds: ['grant_github_read'],
          }),
        ])
      );
      expect(serialized).not.toContain('ghp_read_only_source_token');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('derives Codex auth runtime-file injection from durable vault grants', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-runtime-file-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';
    const runtimeFileCredentials: Array<{ credentialValue: string; targetPath: string }> = [];

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 9) });
    vaultUnlockState.backend().store({
      material: '{"tokens":{"openai":"codex_runtime_file_secret"}}',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_codex_auth_json',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_codex_auth_json',
      displayName: 'Codex auth JSON',
      ownerScope: 'server',
      referenceId: 'vault_codex_auth_json',
      secretKind: 'codex-auth-json',
      now: () => now,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-file'],
      expiresAt: '2026-07-05T01:00:00.000Z',
      grantId: 'grant_codex_auth_json',
      lifetime: 'agent-session',
      ownerScope: 'server',
      targetAgentSessionId: 'session_runtime_file_1',
      vaultReferenceId: 'vault_codex_auth_json',
      now: () => now,
    });

    try {
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Run Codex with auth file');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');
      const resolved = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agent,
          agentSessionId: 'session_runtime_file_1',
          backend: {
            controlRelayUpstream: 'https://nanocore.local/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
          },
          coreDb,
          createdAt: now,
          requestId: 'req_runtime_file_1',
          runtimeFileCredentialSink: (credential) => runtimeFileCredentials.push(credential),
          turn,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      );
      const serialized = JSON.stringify(resolved);

      expect(resolved.vault.references).toEqual([
        expect.objectContaining({
          id: 'vault_codex_auth_json',
          secretRef: 'vault://vault_codex_auth_json',
        }),
      ]);
      expect(resolved.vault.grants).toEqual([
        expect.objectContaining({
          expiresAt: '2026-07-05T01:00:00.000Z',
          id: 'grant_codex_auth_json',
          scope: 'agent-session',
          vaultRefId: 'vault_codex_auth_json',
        }),
      ]);
      expect(listInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_codex_auth_json',
          injectionVisibility: 'runtime-file',
          packageSnapshotId: resolved.snapshotId,
          targetPath: '/sandbox/.codex/auth.json',
        }),
      ]);
      expect(listInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'session_runtime_file_1',
          grantId: 'grant_codex_auth_json',
        }),
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_codex_auth_json',
          outcome: 'succeeded',
          resolvingPath: 'grant',
          vaultReferenceId: 'vault_codex_auth_json',
        }),
      ]);
      expect(runtimeFileCredentials).toEqual([
        {
          credentialValue: '{"tokens":{"openai":"codex_runtime_file_secret"}}',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ]);
      expect(serialized).not.toContain('codex_runtime_file_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('resolves generic worker credential declarations without serializing secret values', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-generic-credentials-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';
    const providerCredentials: Array<{ credentialKey: string; credentialValue: string }> = [];
    const runtimeFileCredentials: Array<{ credentialValue: string; targetPath: string }> = [];
    const runtimeEnvCredentials: Array<{ credentialValue: string; targetEnvVarName: string }> = [];

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 14) });
    for (const [referenceId, material] of [
      ['vault_foo_api', 'foo_provider_secret'],
      ['vault_bar_file', '{"bar":"file_secret"}'],
      ['vault_legacy_env', 'legacy_env_secret'],
    ] as const) {
      vaultUnlockState.backend().store({
        material,
        metadata: { ownerScope: 'server' },
        referenceId,
      });
      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        backendLocator: `encrypted-file://server/vault/${referenceId}`,
        displayName: referenceId,
        ownerScope: 'server',
        referenceId,
        secretKind: 'worker-credential',
        now: () => now,
      });
      createVaultGrant(coreDb, {
        allowedInjectionPaths:
          referenceId === 'vault_foo_api'
            ? ['backend-provider']
            : referenceId === 'vault_bar_file'
              ? ['runtime-file']
              : ['runtime-env'],
        grantId: referenceId.replace('vault_', 'grant_'),
        lifetime: 'agent-session',
        ownerScope: 'server',
        targetAgentSessionId: 'session_generic_credentials_1',
        vaultReferenceId: referenceId,
        now: () => now,
      });
    }

    try {
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Run generic credentials');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');
      const resolved = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agent,
          agentSessionId: 'session_generic_credentials_1',
          backend: {
            controlRelayUpstream: 'https://nanocore.local/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
          },
          coreDb,
          createdAt: now,
          credentialDeclarations: [
            {
              id: 'foo_api',
              provider: {
                credentialKey: 'FOO_API_KEY',
                instanceId: 'provider_foo_api',
                profileId: 'okp-local-foo-api-v1',
                type: 'generic',
              },
              vaultGrantId: 'grant_foo_api',
              visibility: 'sandbox-provider',
            },
            {
              id: 'bar_file',
              targetPath: '/sandbox/.config/bar/credentials.json',
              vaultGrantId: 'grant_bar_file',
              visibility: 'runtime-file',
            },
            {
              id: 'legacy_env',
              targetEnvVarName: 'LEGACY_API_KEY',
              vaultGrantId: 'grant_legacy_env',
              visibility: 'runtime-env',
            },
          ],
          providerCredentialSink: (credential) => {
            providerCredentials.push({
              credentialKey: credential.credentialKey,
              credentialValue: credential.credentialValue,
            });
          },
          requestId: 'req_generic_credentials_1',
          runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
          runtimeFileCredentialSink: (credential) => runtimeFileCredentials.push(credential),
          turn,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      );
      const serialized = JSON.stringify(resolved);

      expect(resolved.credentials.declarations.map((declaration) => declaration.id)).toEqual([
        'foo_api',
        'bar_file',
        'legacy_env',
      ]);
      expect(providerCredentials).toEqual([
        { credentialKey: 'FOO_API_KEY', credentialValue: 'foo_provider_secret' },
      ]);
      expect(runtimeFileCredentials).toEqual([
        {
          credentialValue: '{"bar":"file_secret"}',
          targetPath: '/sandbox/.config/bar/credentials.json',
        },
      ]);
      expect(runtimeEnvCredentials).toEqual([
        { credentialValue: 'legacy_env_secret', targetEnvVarName: 'LEGACY_API_KEY' },
      ]);
      expect(listInjectionPlans(coreDb)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grantId: 'grant_foo_api',
            injectionVisibility: 'backend-provider',
            targetEnvVarName: 'FOO_API_KEY',
          }),
          expect.objectContaining({
            grantId: 'grant_bar_file',
            injectionVisibility: 'runtime-file',
            targetPath: '/sandbox/.config/bar/credentials.json',
          }),
          expect.objectContaining({
            grantId: 'grant_legacy_env',
            injectionVisibility: 'runtime-env',
            targetEnvVarName: 'LEGACY_API_KEY',
          }),
        ])
      );
      expect(listInjectionReceipts(coreDb)).toHaveLength(3);
      expect(listVaultUseRecords(coreDb)).toHaveLength(3);
      expect(serialized).not.toContain('foo_provider_secret');
      expect(serialized).not.toContain('file_secret');
      expect(serialized).not.toContain('legacy_env_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails credential declaration resolution before recording injection state when a sink is missing', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-missing-sink-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 15) });
    vaultUnlockState.backend().store({
      material: 'missing_sink_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_missing_sink',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_missing_sink',
      displayName: 'Missing sink',
      ownerScope: 'server',
      referenceId: 'vault_missing_sink',
      secretKind: 'worker-credential',
      now: () => now,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_missing_sink',
      lifetime: 'agent-session',
      ownerScope: 'server',
      targetAgentSessionId: 'session_missing_sink_1',
      vaultReferenceId: 'vault_missing_sink',
      now: () => now,
    });

    try {
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Run missing sink');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');

      expect(() =>
        resolveAgentEnvironmentPackage({
          agent,
          agentSessionId: 'session_missing_sink_1',
          backend: {
            controlRelayUpstream: 'https://nanocore.local/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
          },
          coreDb,
          createdAt: now,
          credentialDeclarations: [
            {
              id: 'missing_env_sink',
              targetEnvVarName: 'MISSING_ENV_SECRET',
              vaultGrantId: 'grant_missing_sink',
              visibility: 'runtime-env',
            },
          ],
          requestId: 'req_missing_sink_1',
          turn,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow('Runtime-env credential sink is required for declaration: missing_env_sink');
      expect(listInjectionPlans(coreDb)).toEqual([]);
      expect(listInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects worker Skill and MCP supply outside the NanoCore catalog', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject catalog bypass');
    const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
    const agent = {
      ...baseAgent,
      skillIds: ['unknown-skill'],
      config: {
        ...baseAgent.config,
        mcpServerIds: ['unknown-mcp'],
      },
    } as typeof baseAgent;

    expect(() =>
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_supply_catalog_reject_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_supply_catalog_reject_1',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    ).toThrow('Worker supply catalog entry not found: skill:unknown-skill');
  });

  it('adds a configured OpenShell Codex model to the one-shot worker command', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run OpenShell mode');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_openshell_model_1',
        backend: {
          codexModel: 'gpt-5-codex',
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_openshell_model_1',
        turn,
        turnInput: 'Run OpenShell mode',
        workspaceCwd: null,
        workspaceRoots: [],
      })
    );

    expect(resolved.extensions.openkit).toMatchObject({
      codexCommand: [
        'codex',
        'exec',
        '--json',
        '--output-last-message',
        '/openkit/session/final-message.txt',
        '--cd',
        agent.config.workspaceRoot,
        '--model',
        'gpt-5-codex',
        '--dangerously-bypass-approvals-and-sandbox',
        'Run OpenShell mode',
      ],
    });
  });

  it('resolves a remote OpenShell package with remote placement metadata and transport capabilities', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run remote OpenShell mode');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_remote_openshell_1',
        backend: {
          controlRelayUpstream: 'https://nanocore.example.com/api/worker-control',
          gatewayUrl: 'https://a1.example.com:17670',
          kind: 'openshell',
          placement: 'remote',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_remote_openshell_1',
        turn,
        turnInput: 'Run remote OpenShell mode',
        workspaceCwd: '/Users/m5pro/Documents/AI/openkit',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/Users/m5pro/Documents/AI/openkit',
            workerPath: '/workspace/openkit',
          },
        ],
      })
    );
    const serialized = JSON.stringify(resolved);

    expect(resolved.runtime.command.workingDirectory).toBe('/workspace/openkit');
    expect(resolved.control.relay?.upstream).toBe(
      'https://nanocore.example.com/api/worker-control'
    );
    expect(resolved.backend.requiredCapabilities).toEqual(
      expect.arrayContaining([
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ])
    );
    expect(resolved.backend.extensions?.openshell).toMatchObject({
      gatewayUrlRef: 'runtime://openshell/gateway-url',
      placement: 'remote',
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
    });
    expect(serialized).not.toContain('https://a1.example.com:17670');
    expect(serialized).not.toContain('/Users/m5pro');
  });

  it('merges authored backend capability requirements into the package backend envelope', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with authored backend requirements');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const resolved = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'as_backend_requirements',
      backend: {
        controlRelayUpstream: 'https://nanocore.example.com/api/worker-control',
        kind: 'openshell',
        placement: 'remote',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      backendRequirements: {
        allowedKinds: ['openshell'],
        preferred: 'openshell',
        requiredCapabilities: ['dynamic-network-policy', 'dynamic-provider-attach'],
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_backend_requirements',
      turn,
      turnInput: 'Run with authored backend requirements',
      workspaceCwd: '/Users/m5pro/Documents/AI/openkit',
      workspaceRoots: [],
    });

    expect(resolved.backend.requiredCapabilities).toEqual(
      expect.arrayContaining(['dynamic-network-policy', 'dynamic-provider-attach'])
    );
    expect(resolved.backend.preferred).toBe('openshell');
    expect(resolved.backend.allowedKinds).toEqual(['openshell']);
  });
});
