import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  type WorkerSandboxAccess,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import {
  OpenShellWorkerGovernanceBackend,
  type OpenShellWorkerGovernanceClient,
} from './worker-governance-backend.js';
import { importWorkerTranscript } from './worker-transcript.js';

describe('OpenShellWorkerGovernanceBackend', () => {
  it('declares real OpenShell capabilities from the installed CLI version', async () => {
    const backend = new OpenShellWorkerGovernanceBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
    });

    expect(await backend.describeCapabilities()).toMatchObject({
      kind: 'openshell',
      version: '0.0.63',
      capabilities: expect.arrayContaining([
        'container',
        'filesystem-policy',
        'network-policy',
        'process-policy',
        'transcript-sink',
        'sidecar-control-endpoint',
        'sidecar-capability-endpoint',
        'provider-attachments',
        'nanocore-inference-upstream',
        'audit-export',
      ]),
    });
  });

  it('declares remote OpenShell transport capabilities for remote placement', async () => {
    const backend = new OpenShellWorkerGovernanceBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'a1-openshell',
      gatewayUrl: 'https://a1.example.com:17670',
      placement: 'remote',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
    });

    expect(await backend.describeCapabilities()).toMatchObject({
      kind: 'openshell',
      capabilities: expect.arrayContaining([
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ]),
    });
  });

  it('validates OpenKit sidecar control packages and rejects inference.local control endpoints', async () => {
    const backend = new OpenShellWorkerGovernanceBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
    });
    const validPackage = createOpenShellPackage();
    const invalidPackage = AgentEnvironmentPackageSchema.parse({
      ...validPackage,
      control: {
        ...validPackage.control,
        endpoint: {
          ...validPackage.control.endpoint,
          baseUrl: 'https://inference.local/v1/worker-control',
        },
      },
    });

    expect(await backend.validatePackage(validPackage)).toEqual([]);
    expect(await backend.validatePackage(invalidPackage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'openshell_control_endpoint_must_be_control_local',
          path: '$.control.endpoint.baseUrl',
        }),
        expect.objectContaining({
          code: 'openshell_control_must_not_use_inference_local',
          path: '$.control.endpoint.baseUrl',
        }),
      ])
    );
  });

  it('creates a sandbox materialization record without leaking backend-private or host-local details', async () => {
    const cli = new FakeOpenShellClient();
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'token_openshell_control_1',
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway,
    });
    const environmentPackage = createOpenShellPackage();

    const materialization = await backend.materialize(environmentPackage);
    const serialized = JSON.stringify(materialization);

    expect(cli.createSandboxCalls).toEqual([
      expect.objectContaining({
        command: environmentPackage.runtime.command.argv,
        env: expect.objectContaining({
          OPENKIT_AGENT_SESSION_ID: environmentPackage.scope.agentSessionId,
          OPENKIT_CONTROL_TOKEN: 'token_openshell_control_1',
          OPENKIT_PACKAGE_SNAPSHOT_ID: environmentPackage.snapshotId,
          OPENKIT_REQUEST_ID: environmentPackage.scope.requestId,
          OPENKIT_THREAD_ID: environmentPackage.scope.threadId,
          OPENKIT_TURN_ID: environmentPackage.scope.turnId,
          OPENKIT_WORKSPACE_ID: environmentPackage.scope.workspaceId,
        }),
        from: 'ghcr.io/openkit/codex-worker:test',
        gateway: 'openshell',
        labels: expect.objectContaining({
          'openkit.openshellMappingVersion': 'openshell-v2',
          'openkit.openshellSnapshotId': 'openshell-0.0.80-2026-07-11',
        }),
        name: `openkit-${environmentPackage.scope.agentSessionId}`,
        policyPath: expect.stringMatching(/policy\.yaml$/),
        uploads: [
          expect.objectContaining({
            targetPath: '/openkit/config/package.json',
          }),
        ],
      }),
    ]);
    expect(readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8')).toContain(
      'network_policies:'
    );
    expect(
      readFileSync(cli.createSandboxCalls[0]?.uploads?.[0]?.sourcePath ?? '', 'utf8')
    ).toContain(environmentPackage.snapshotId);
    expect(materialization).toMatchObject({
      backendKind: 'openshell',
      packageSnapshotId: environmentPackage.snapshotId,
      controlMode: 'sidecar',
      sandbox: {
        name: `openkit-${environmentPackage.scope.agentSessionId}`,
        source: 'ghcr.io/openkit/codex-worker:test',
        state: 'created',
      },
      backendStatus: {
        gatewayName: 'openshell',
        gatewayEndpoint: 'https://127.0.0.1:17670',
        health: 'ready',
        version: '0.0.63',
      },
    });
    expect(serialized).not.toContain('/Users/m5pro');
    expect(serialized).not.toContain('token_openshell_control_1');
    expect(serialized).not.toContain('containerId');
    expect(serialized).not.toContain('backendSessionId');
    expect(workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)).toMatchObject({
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
    });
  });

  it('shortens long OpenShell label values without changing package lineage', async () => {
    const cli = new FakeOpenShellClient();
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'token_openshell_control_1',
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway,
    });
    const basePackage = createOpenShellPackage();
    const longTurnId = 'turn_00000000-0000-4000-8000-00000000d105_5ceb30587b714d67';
    const longAgentSessionId = 'as_5ceb30587b714d67';
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...basePackage,
      snapshotId: `aepsnap_${longTurnId}_${longAgentSessionId}`,
      scope: {
        ...basePackage.scope,
        agentSessionId: longAgentSessionId,
        turnId: longTurnId,
      },
    });

    await backend.materialize(environmentPackage);

    const createCall = cli.createSandboxCalls[0];
    expect(createCall?.env?.OPENKIT_PACKAGE_SNAPSHOT_ID).toBe(environmentPackage.snapshotId);
    expect(readFileSync(createCall?.uploads?.[0]?.sourcePath ?? '', 'utf8')).toContain(
      environmentPackage.snapshotId
    );
    for (const value of Object.values(createCall?.labels ?? {})) {
      expect(value).toMatch(/^[a-zA-Z0-9_.-]{1,63}$/);
      expect(value.length).toBeLessThanOrEqual(63);
    }
    expect(createCall?.labels?.['openkit.packageSnapshotId']).not.toBe(
      environmentPackage.snapshotId
    );
  });

  it('passes scheduler-owned sandbox binding refs into worker control registration', async () => {
    const cli = new FakeOpenShellClient();
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => {
        throw new Error('random token generator should not run');
      },
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway,
    });
    const environmentPackage = createOpenShellPackage();

    await backend.materialize(environmentPackage, {
      sandboxBindingRef: 'lease-binding:openshell_1',
      workspaceRoots: [],
    });

    expect(cli.createSandboxCalls.at(-1)).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENKIT_CONTROL_TOKEN: 'lease-binding:openshell_1',
        }),
      })
    );
  });

  it('upserts OpenShell providers from backend-private credentials before sandbox creation', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialExpiresAt: '2026-07-05T01:00:00.000Z',
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
      ],
      workspaceRoots: [],
    });

    expect(cli.upsertProviderCalls).toEqual([
      {
        credentialExpiresAt: '2026-07-05T01:00:00.000Z',
        credentialKey: 'GITHUB_TOKEN',
        credentialValue: 'ghp_backend_secret',
        gateway: 'openshell',
        name: 'provider_github_read',
        providerType: 'github_mcp',
      },
    ]);
    expect(cli.createSandboxCalls[0]?.providers).toEqual(
      expect.arrayContaining(['provider_github_read'])
    );
    expect(JSON.stringify(cli.createSandboxCalls)).not.toContain('ghp_backend_secret');
  });

  it('uploads backend-private runtime file credentials without leaking them in materialization', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    const materialization = await backend.materialize(environmentPackage, {
      runtimeFileCredentials: [
        {
          credentialValue: '{"tokens":{"openai":"codex_backend_secret"}}',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ],
      workspaceRoots: [],
    });
    const upload = cli.createSandboxCalls[0]?.uploads?.find(
      (candidate) => candidate.targetPath === '/sandbox/.codex/auth.json'
    );

    expect(upload).toBeDefined();
    expect(readFileSync(upload?.sourcePath ?? '', 'utf8')).toBe(
      '{"tokens":{"openai":"codex_backend_secret"}}'
    );
    expect(JSON.stringify(materialization)).not.toContain('codex_backend_secret');
    expect(JSON.stringify(cli.createSandboxCalls)).not.toContain('codex_backend_secret');
  });

  it('merges backend-private runtime env credentials without leaking them in materialization', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    const materialization = await backend.materialize(environmentPackage, {
      runtimeEnvCredentials: [
        {
          credentialValue: 'legacy_env_backend_secret',
          targetEnvVarName: 'LEGACY_API_KEY',
        },
      ],
      workspaceRoots: [],
    });

    expect(cli.createSandboxCalls[0]?.env).toEqual(
      expect.objectContaining({ LEGACY_API_KEY: 'legacy_env_backend_secret' })
    );
    expect(JSON.stringify(materialization)).not.toContain('legacy_env_backend_secret');
  });

  it('uploads explicitly configured host Codex auth JSON when no runtime file overrides it', async () => {
    const cli = new FakeOpenShellClient();
    const authPath = join(mkdtempSync(join(tmpdir(), 'openkit-codex-auth-upload-')), 'auth.json');

    writeFileSync(authPath, '{"tokens":{"openai":"codex_host_secret"}}', 'utf8');

    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      codexAuthJsonPath: authPath,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(createOpenShellPackage(), {
      workspaceRoots: [],
    });

    const upload = cli.createSandboxCalls[0]?.uploads?.find(
      (candidate) => candidate.targetPath === '/sandbox/.codex/auth.json'
    );

    expect(upload).toBeDefined();
    expect(readFileSync(upload?.sourcePath ?? '', 'utf8')).toBe(
      '{"tokens":{"openai":"codex_host_secret"}}'
    );
    expect(JSON.stringify(cli.createSandboxCalls)).not.toContain('codex_host_secret');
  });

  it('allows Codex network endpoints in generated OpenShell policies', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(createOpenShellPackage(), {
      workspaceRoots: [],
    });

    const policy = readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8');

    expect(policy).toContain('chatgpt_backend_rest:');
    expect(policy).toContain('host: chatgpt.com');
    expect(policy).toContain('mcp_deepwiki:');
    expect(policy).toContain('host: mcp.deepwiki.com');
  });

  it('adds user-declared sandbox network and filesystem grants to generated OpenShell policies', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(
      createOpenShellPackage(undefined, {
        filesystem: [
          {
            access: 'read-write',
            id: 'npm_cache',
            purpose: 'Package cache',
            targetPath: '/sandbox/.cache/npm',
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
      }),
      {
        workspaceRoots: [],
      }
    );

    const policy = readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8');

    expect(policy).toContain('npm_registry:');
    expect(policy).toContain('path: /usr/bin/npm');
    expect(policy).toContain('host: registry.npmjs.org');
    expect(policy).toContain('access: read-write');
    expect(policy).toContain('    - /sandbox/.cache/npm');
  });

  it('preserves read-only workspace roots without a broad writable workspace grant', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(
      createOpenShellPackage([
        {
          access: 'read-only',
          id: 'vendor-sdk',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/vendor-sdk',
          workerPath: '/workspace/vendor-sdk',
        },
      ]),
      {
        workspaceRoots: [],
      }
    );

    const policy = readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8');
    const readWriteSection = policy.split('  read_write:')[1] ?? '';

    expect(policy).toContain('    - /workspace/vendor-sdk');
    expect(readWriteSection).not.toContain('    - /workspace\n');
    expect(readWriteSection).not.toContain('    - /workspace/vendor-sdk');
  });

  it('uses vault-backed Codex auth runtime-file uploads', async () => {
    const cli = new FakeOpenShellClient();
    const authPath = join(mkdtempSync(join(tmpdir(), 'openkit-codex-auth-upload-')), 'auth.json');

    writeFileSync(authPath, '{"tokens":{"openai":"codex_host_secret"}}', 'utf8');

    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      codexAuthJsonPath: authPath,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(createOpenShellPackage(), {
      runtimeFileCredentials: [
        {
          credentialValue: '{"tokens":{"openai":"codex_vault_secret"}}',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ],
      workspaceRoots: [],
    });

    const authUploads = cli.createSandboxCalls[0]?.uploads?.filter(
      (candidate) => candidate.targetPath === '/sandbox/.codex/auth.json'
    );

    expect(authUploads).toHaveLength(1);
    expect(readFileSync(authUploads?.[0]?.sourcePath ?? '', 'utf8')).toBe(
      '{"tokens":{"openai":"codex_vault_secret"}}'
    );
  });

  it('collects provider attachment evidence without backend-private credential values', async () => {
    const cli = new FakeOpenShellClient({
      providerOutputs: {
        provider_github_read:
          'Provider\n\n  Name: provider_github_read\n  Credential: ghp_backend_secret\n',
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
      ],
      workspaceRoots: [],
    });

    const evidence = await backend.collectEvidence(environmentPackage.snapshotId);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            packageSnapshotId: environmentPackage.snapshotId,
            provider: expect.objectContaining({
              preview: expect.stringContaining('provider_github_read'),
            }),
            providerInstanceId: 'provider_github_read',
            sandboxName: `openkit-${environmentPackage.scope.agentSessionId}`,
          }),
          kind: 'openshell.provider.attached',
        }),
      ])
    );
    expect(cli.getProviderCalls).toEqual(
      expect.arrayContaining([
        {
          gateway: 'openshell',
          name: 'provider_github_read',
        },
      ])
    );
    expect(JSON.stringify(evidence)).not.toContain('ghp_backend_secret');
  });

  it('normalizes provider refresh and detach evidence from redacted OpenShell output', async () => {
    const cli = new FakeOpenShellClient({
      providerOutputs: {
        provider_github_read:
          'Provider\n\n  Name: provider_github_read\n  Refresh: refreshed\n  Credential: ghp_backend_secret\n',
        provider_gitlab_read:
          'Provider\n\n  Name: provider_gitlab_read\n  Status: detached\n  Credential: glpat_backend_secret\n',
      },
      refreshStatusOutputs: {
        provider_github_read:
          'Refresh Status\n\n  Provider: provider_github_read\n  Status: refreshed\n  Credential: ghp_backend_secret\n',
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithTwoProviderAttachments();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
        {
          credentialKey: 'GITLAB_TOKEN',
          credentialValue: 'glpat_backend_secret',
          providerInstanceId: 'provider_gitlab_read',
          providerType: 'gitlab_mcp',
        },
      ],
      workspaceRoots: [],
    });

    const evidence = await backend.collectEvidence(environmentPackage.snapshotId);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            providerInstanceId: 'provider_github_read',
          }),
          kind: 'openshell.provider.refreshed',
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            providerInstanceId: 'provider_gitlab_read',
          }),
          kind: 'openshell.provider.detached',
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            providerInstanceId: 'provider_github_read',
            refreshStatus: expect.objectContaining({
              preview: expect.stringContaining('provider_github_read'),
            }),
          }),
          kind: 'openshell.provider.refresh_status',
        }),
      ])
    );
    expect(cli.getProviderRefreshStatusCalls).toEqual(
      expect.arrayContaining([
        {
          gateway: 'openshell',
          name: 'provider_github_read',
        },
      ])
    );
    expect(JSON.stringify(evidence)).not.toContain('ghp_backend_secret');
    expect(JSON.stringify(evidence)).not.toContain('glpat_backend_secret');
  });

  it('polls provider refresh status for active materialized sessions', async () => {
    const cli = new FakeOpenShellClient({
      refreshStatusOutputs: {
        provider_github_read:
          'Refresh Status\n\n  Provider: provider_github_read\n  Status: refreshed\n  Credential: ghp_backend_secret\n',
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
      ],
      workspaceRoots: [],
    });

    const evidence = await backend.collectProviderRefreshStatuses();

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            packageSnapshotId: environmentPackage.snapshotId,
            providerInstanceId: 'provider_github_read',
            refreshStatus: expect.objectContaining({
              preview: expect.stringContaining('provider_github_read'),
            }),
          }),
          kind: 'openshell.provider.refresh_status',
        }),
      ])
    );
    expect(cli.getProviderRefreshStatusCalls).toEqual(
      expect.arrayContaining([
        {
          gateway: 'openshell',
          name: 'provider_github_read',
        },
      ])
    );
    expect(JSON.stringify(evidence)).not.toContain('ghp_backend_secret');
  });

  it('redacts remote OpenShell gateway credentials from materialization records', async () => {
    const cli = new FakeOpenShellClient({ endpoint: 'https://a1.example.com:17670' });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'a1-openshell',
      gatewayInsecure: true,
      gatewayUrl: 'https://user:secret@a1.example.com:17670/private?token=raw#frag',
      placement: 'remote',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    const materialization = await backend.materialize(createRemoteOpenShellPackage());
    const serialized = JSON.stringify(materialization);

    expect(materialization.backendStatus).toMatchObject({
      gatewayEndpoint: 'https://a1.example.com:17670',
      gatewayName: 'openshell',
      health: 'ready',
    });
    expect(cli.createSandboxCalls[0]).toMatchObject({
      gateway: 'a1-openshell',
      gatewayEndpoint: 'https://user:secret@a1.example.com:17670/private?token=raw#frag',
      gatewayInsecure: true,
    });
    expect(serialized).not.toContain('user:secret');
    expect(serialized).not.toContain('token=raw');
    expect(serialized).not.toContain('/private');
    expect(cli.gatewayInfoCalls).toEqual([
      {
        gateway: 'a1-openshell',
        gatewayEndpoint: 'https://user:secret@a1.example.com:17670/private?token=raw#frag',
        gatewayInsecure: true,
      },
    ]);
  });

  it('fails closed when the configured remote gateway URL does not match the active gateway endpoint', async () => {
    const backend = new OpenShellWorkerGovernanceBackend({
      cli: new FakeOpenShellClient({ endpoint: 'https://other.example.com:17670' }),
      gatewayName: 'a1-openshell',
      gatewayUrl: 'https://a1.example.com:17670',
      placement: 'remote',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await expect(backend.materialize(createRemoteOpenShellPackage())).rejects.toThrow(
      'OpenShell preflight failed: configured gateway URL does not match active OpenShell gateway endpoint.'
    );
  });

  it('fails closed when local OpenShell doctor checks fail', async () => {
    const backend = new OpenShellWorkerGovernanceBackend({
      cli: new FakeOpenShellClient({
        doctor: {
          docker: null,
          error: 'Docker is unavailable.',
          ok: false,
        },
      }),
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await expect(backend.materialize(createOpenShellPackage())).rejects.toThrow(
      'OpenShell preflight failed: Docker is unavailable.'
    );
  });

  it('does not require local Docker doctor checks for remote OpenShell placement', async () => {
    const cli = new FakeOpenShellClient({
      doctor: {
        docker: null,
        error: 'Local Docker is unavailable.',
        ok: false,
      },
      endpoint: 'https://a1.example.com:17670',
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'a1-openshell',
      gatewayUrl: 'https://a1.example.com:17670',
      placement: 'remote',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await expect(backend.materialize(createRemoteOpenShellPackage())).resolves.toMatchObject({
      backendStatus: {
        gatewayEndpoint: 'https://a1.example.com:17670',
        health: 'ready',
      },
    });
    expect(cli.createSandboxCalls).toHaveLength(1);
  });

  it('uploads backend-private workspace bundles and extracts them before worker startup', async () => {
    const cli = new FakeOpenShellClient();
    const sourcePath = mkdtempSync(join(tmpdir(), 'openkit-openshell-workspace-source-'));
    const readonlySourcePath = mkdtempSync(join(tmpdir(), 'openkit-openshell-readonly-source-'));
    writeFileSync(join(sourcePath, 'README.md'), '# Workspace\n', 'utf8');
    writeFileSync(join(readonlySourcePath, 'notes.md'), '# Notes\n', 'utf8');
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const workspaceRoots: MaterializedWorkspaceRoot[] = [
      {
        access: 'read-write',
        id: 'repo',
        sourceKind: 'host-dir',
        sourcePath,
        workerPath: '/workspace/openkit',
      },
      {
        access: 'read-only',
        id: 'docs',
        sourceKind: 'host-dir',
        sourcePath: readonlySourcePath,
        workerPath: '/workspace/openkit/docs',
      },
    ];
    const environmentPackage = createOpenShellPackage(workspaceRoots);

    const materialization = await backend.materialize(environmentPackage, { workspaceRoots });

    const createCall = cli.createSandboxCalls[0];
    const workspaceUpload = createCall?.uploads?.find(
      (upload) => upload.targetPath === '/openkit/config/workspaces/repo.tar'
    );
    const readonlyUpload = createCall?.uploads?.find(
      (upload) => upload.targetPath === '/openkit/config/workspaces/docs.tar'
    );

    expect(workspaceUpload).toBeDefined();
    expect(workspaceUpload?.sourcePath).toMatch(/workspace-repo\.tar$/);
    expect(existsSync(workspaceUpload?.sourcePath ?? '')).toBe(true);
    expect(readonlyUpload).toBeDefined();
    expect(readonlyUpload?.sourcePath).toMatch(/workspace-docs\.tar$/);
    expect(existsSync(readonlyUpload?.sourcePath ?? '')).toBe(true);
    expect(createCall?.command).toEqual([
      'bash',
      '-lc',
      expect.stringContaining(
        "tar -xf '/openkit/config/workspaces/repo.tar' -C '/workspace/openkit/worktrees/main'"
      ),
    ]);
    expect(createCall?.command).toEqual([
      'bash',
      '-lc',
      expect.stringContaining(
        "tar -xf '/openkit/config/workspaces/docs.tar' -C '/workspace/openkit/inputs'"
      ),
    ]);
    expect(materialization.workspaceInputs).toEqual([
      expect.objectContaining({ id: 'repo', target: '/workspace/openkit/worktrees/main' }),
      expect.objectContaining({ id: 'docs', target: '/workspace/openkit/inputs' }),
    ]);
    expect(JSON.stringify(createCall)).not.toContain(sourcePath);
    expect(JSON.stringify(createCall)).not.toContain(readonlySourcePath);
  });

  it('uploads pre-materialized read-only workspace inputs without leaking host paths', async () => {
    const cli = new FakeOpenShellClient();
    const materializedPath = mkdtempSync(join(tmpdir(), 'openkit-openshell-materialized-input-'));
    writeFileSync(
      join(materializedPath, 'package.json'),
      '{"version":"worker-context-package-v1"}\n'
    );
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const workspaceRoots: MaterializedWorkspaceRoot[] = [
      {
        access: 'read-write',
        id: 'repo',
        sourceKind: 'host-dir',
        sourcePath: mkdtempSync(join(tmpdir(), 'openkit-openshell-materialized-repo-')),
        workerPath: '/workspace/openkit',
      },
      {
        access: 'read-only',
        id: 'context',
        sourceKind: 'materialized-dir',
        sourcePath: materializedPath,
        workerPath: '/openkit/context',
      },
    ];
    const environmentPackage = createOpenShellPackage(workspaceRoots);

    const materialization = await backend.materialize(environmentPackage, { workspaceRoots });

    const createCall = cli.createSandboxCalls[0];
    const contextUpload = createCall?.uploads?.find(
      (upload) => upload.targetPath === '/openkit/config/workspaces/context.tar'
    );

    expect(contextUpload).toBeDefined();
    expect(contextUpload?.sourcePath).toMatch(/workspace-context\.tar$/);
    expect(existsSync(contextUpload?.sourcePath ?? '')).toBe(true);
    expect(createCall?.command).toEqual([
      'bash',
      '-lc',
      expect.stringContaining(
        "tar -xf '/openkit/config/workspaces/context.tar' -C '/workspace/openkit/inputs'"
      ),
    ]);
    expect(materialization.workspaceInputs).toEqual([
      expect.objectContaining({ id: 'repo', target: '/workspace/openkit/worktrees/main' }),
      expect.objectContaining({ id: 'context', target: '/workspace/openkit/inputs' }),
    ]);
    expect(JSON.stringify(createCall)).not.toContain(materializedPath);
  });

  it('omits macOS extended attributes from workspace bundle archives', async () => {
    if (process.platform !== 'darwin') {
      return;
    }

    const cli = new FakeOpenShellClient();
    const sourcePath = mkdtempSync(join(tmpdir(), 'openkit-openshell-workspace-xattr-'));
    const readmePath = join(sourcePath, 'README.md');
    writeFileSync(readmePath, '# Workspace\n', 'utf8');

    try {
      execFileSync('xattr', ['-w', 'com.apple.provenance', 'openkit-test', readmePath], {
        stdio: 'ignore',
      });
    } catch {
      return;
    }

    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    await backend.materialize(environmentPackage, {
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath,
          workerPath: '/workspace/openkit',
        },
      ],
    });

    const workspaceUpload = cli.createSandboxCalls[0]?.uploads?.find(
      (upload) => upload.targetPath === '/openkit/config/workspaces/repo.tar'
    );
    const archiveStrings = execFileSync('strings', [workspaceUpload?.sourcePath ?? ''], {
      encoding: 'utf8',
    });

    expect(archiveStrings).not.toContain('LIBARCHIVE.xattr');
    expect(archiveStrings).not.toContain('SCHILY.xattr');
    expect(archiveStrings).not.toContain('com.apple.provenance');
  });

  it('does not upload legacy explicit host Codex auth files', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      codexConfigTomlPath: '/home/ubuntu/.codex/config.toml',
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(createOpenShellPackage());

    expect(cli.createSandboxCalls[0]?.uploads).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: '/sandbox/.codex/auth.json',
        }),
      ])
    );
    expect(cli.createSandboxCalls[0]?.uploads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: '/home/ubuntu/.codex/config.toml',
          targetPath: '/sandbox/.codex/config.toml',
        }),
      ])
    );
  });

  it('downloads transcript evidence and artifact candidates from a retained sandbox', async () => {
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellPackage(),
      snapshotId: 'pkg_pending',
    });
    const cli = new FakeOpenShellClient({
      downloads: {
        '/sandbox/openkit/session/artifacts.jsonl': `${JSON.stringify({
          schemaVersion: 1,
          kind: 'artifact',
          lineage: {
            workspaceId: environmentPackage.scope.workspaceId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            agentSessionId: environmentPackage.scope.agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
            requestId: environmentPackage.scope.requestId,
          },
          sequence: 3,
          artifact: {
            kind: 'report',
            mediaType: 'text/markdown',
            path: '/openkit/artifacts/report.md',
            title: 'Worker report',
          },
        })}\n`,
        '/sandbox/openkit/session/events.jsonl': `${JSON.stringify({
          schemaVersion: 1,
          kind: 'event',
          lineage: {
            workspaceId: environmentPackage.scope.workspaceId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            agentSessionId: environmentPackage.scope.agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
          },
          sequence: 0,
          event: {
            type: 'worker.ready',
            data: {},
          },
        })}\n`,
        '/sandbox/openkit/session/items.jsonl': `${JSON.stringify({
          schemaVersion: 1,
          kind: 'item',
          lineage: {
            workspaceId: environmentPackage.scope.workspaceId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            agentSessionId: environmentPackage.scope.agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
            requestId: environmentPackage.scope.requestId,
          },
          sequence: 1,
          item: {
            type: 'assistant-message',
            status: 'completed',
            text: 'OpenShell worker completed the task.',
          },
        })}\n`,
      },
    });
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'token_openshell_control_1',
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway,
    });
    const importStore = createDemoStore();
    importStore.createTurn(
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId,
      'Import worker transcript'
    );

    await backend.materialize(environmentPackage);

    await expect(backend.collectEvidence(environmentPackage.snapshotId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            events: expect.objectContaining({ bytes: expect.any(Number), records: 1 }),
            items: expect.objectContaining({ bytes: expect.any(Number), records: 1 }),
            artifacts: expect.objectContaining({ bytes: expect.any(Number), records: 1 }),
          }),
          kind: 'openshell.transcript.collected',
        }),
      ])
    );
    await expect(backend.collectArtifacts(environmentPackage.snapshotId)).resolves.toEqual([
      expect.objectContaining({
        id: `worker-artifact-${environmentPackage.snapshotId}-3`,
        mediaType: 'text/markdown',
        path: '/openkit/artifacts/report.md',
      }),
    ]);
    await expect(backend.collectTranscript(environmentPackage.snapshotId)).resolves.toMatchObject({
      artifactsJsonl: expect.stringContaining('/openkit/artifacts/report.md'),
      eventsJsonl: expect.stringContaining('worker.ready'),
      itemsJsonl: expect.stringContaining('OpenShell worker completed the task.'),
    });

    const transcript = await backend.collectTranscript(environmentPackage.snapshotId);
    const importResult = importWorkerTranscript(importStore, environmentPackage, transcript);

    expect(importResult).toMatchObject({
      itemIds: [expect.stringMatching(/^it_worker_/)],
      artifactIds: [expect.stringMatching(/^ar_worker_/)],
      diagnostics: [],
    });
  });

  it('downloads worker-session patch payloads referenced by workspace change manifests', async () => {
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellPackage(),
      snapshotId: 'pkg_workspace_patch',
    });
    const patchText = 'diff --git a/docs/report.md b/docs/report.md\n';
    const cli = new FakeOpenShellClient({
      downloads: {
        '/sandbox/openkit/session/workspace-changes.json': JSON.stringify({
          artifactIds: [],
          base: { commit: 'abc123', contentDigest: null },
          bundle: null,
          changedPaths: [{ binary: false, path: 'docs/report.md', status: 'modified' }],
          createdAt: '2026-06-16T00:00:00.000Z',
          evidenceRefs: [],
          head: { commit: 'def456', contentDigest: null },
          id: 'wcs_patch',
          inputSnapshotId: 'wis_patch',
          materializationRecordId: 'wmr_patch',
          patch: { bytes: 41, digest: 'sha256:patch', ref: 'worker-session://workspace.patch' },
          redaction: { notes: [], status: 'redacted' },
          resourceId: 'repo',
          strategy: 'git',
          workspaceId: environmentPackage.scope.workspaceId,
        }),
        '/sandbox/openkit/session/workspace.patch': patchText,
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);

    await expect(backend.collectWorkspaceChanges(environmentPackage.snapshotId)).resolves.toEqual([
      expect.objectContaining({
        changeSet: expect.objectContaining({ id: 'wcs_patch' }),
        patchPayload: {
          bytes: 41,
          digest: 'sha256:patch',
          mediaType: 'text/x-diff',
          text: patchText,
        },
      }),
    ]);
    expect(cli.downloadFileCalls.map((call) => call.sandboxPath)).toEqual(
      expect.arrayContaining([
        '/sandbox/openkit/session/workspace-changes.json',
        '/sandbox/openkit/session/workspace.patch',
      ])
    );
  });

  it('keeps the OpenShell sandbox after teardown when retention is enabled', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    await backend.materialize(environmentPackage);
    expect(cli.createSandboxCalls[0]?.noKeep).toBe(false);

    await expect(backend.teardown(environmentPackage.snapshotId)).resolves.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          sandboxName: `openkit-${environmentPackage.scope.agentSessionId}`,
        }),
        kind: 'openshell.teardown.completed',
      })
    );
    expect(cli.deleteSandboxCalls).toEqual([]);
  });

  it('detaches OpenShell providers during teardown for retained sandboxes', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
      ],
      workspaceRoots: [],
    });

    await backend.teardown(environmentPackage.snapshotId);

    expect(cli.detachProviderCalls).toEqual([
      {
        gateway: 'openshell',
        name: `openkit-${environmentPackage.scope.agentSessionId}`,
        provider: 'codex',
      },
      {
        gateway: 'openshell',
        name: `openkit-${environmentPackage.scope.agentSessionId}`,
        provider: 'provider_github_read',
      },
    ]);
    expect(cli.deleteSandboxCalls).toEqual([]);
  });

  it('retries transient OpenShell provider detach conflicts during teardown', async () => {
    const cli = new FakeOpenShellClient({
      detachFailures: [
        new Error(
          'OpenShell provider detach failed: sandbox was modified by another operation. Please retry the command.'
        ),
      ],
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      detachRetryDelayMs: 0,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
      ],
      workspaceRoots: [],
    });

    await expect(backend.teardown(environmentPackage.snapshotId)).resolves.toMatchObject({
      kind: 'openshell.teardown.completed',
    });
    expect(cli.detachProviderCalls).toHaveLength(3);
    expect(cli.detachProviderCalls[0]).toEqual(cli.detachProviderCalls[1]);
  });

  it('detaches active OpenShell providers whose vault grants were revoked', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithTwoProviderAttachments();

    await backend.materialize(environmentPackage, {
      providerCredentials: [
        {
          credentialKey: 'GITHUB_TOKEN',
          credentialValue: 'ghp_backend_secret',
          providerInstanceId: 'provider_github_read',
          providerType: 'github_mcp',
        },
        {
          credentialKey: 'GITLAB_TOKEN',
          credentialValue: 'glpat_backend_secret',
          providerInstanceId: 'provider_gitlab_read',
          providerType: 'gitlab_mcp',
        },
      ],
      workspaceRoots: [],
    });

    await backend.detachProvidersForRevokedGrants(['grant_github_read']);

    expect(cli.detachProviderCalls).toEqual([
      {
        gateway: 'openshell',
        name: `openkit-${environmentPackage.scope.agentSessionId}`,
        provider: 'provider_github_read',
      },
    ]);
    expect(cli.deleteSandboxCalls).toEqual([]);
  });

  it('deletes the OpenShell sandbox after collection when retention is disabled', async () => {
    const cli = new FakeOpenShellClient();
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: false,
      sandboxSource: 'ghcr.io/openkit/codex-worker:test',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    await backend.materialize(environmentPackage);
    expect(cli.createSandboxCalls[0]?.noKeep).toBe(false);

    await expect(backend.teardown(environmentPackage.snapshotId)).resolves.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          sandboxName: `openkit-${environmentPackage.scope.agentSessionId}`,
        }),
        kind: 'openshell.teardown.completed',
      })
    );
    expect(cli.deleteSandboxCalls).toEqual([
      {
        gateway: 'openshell',
        name: `openkit-${environmentPackage.scope.agentSessionId}`,
      },
    ]);
  });
});

class FakeOpenShellClient implements OpenShellWorkerGovernanceClient {
  public readonly createSandboxCalls: Parameters<
    OpenShellWorkerGovernanceClient['createSandbox']
  >[0][] = [];
  public readonly deleteSandboxCalls: Parameters<
    OpenShellWorkerGovernanceClient['deleteSandbox']
  >[0][] = [];
  public readonly detachProviderCalls: Parameters<
    OpenShellWorkerGovernanceClient['detachProvider']
  >[0][] = [];
  public readonly downloadFileCalls: Parameters<
    OpenShellWorkerGovernanceClient['downloadFile']
  >[0][] = [];
  public readonly gatewayInfoCalls: Array<{ gateway?: string }> = [];
  public readonly getProviderCalls: Array<{ gateway?: string; name: string }> = [];
  public readonly getProviderRefreshStatusCalls: Array<{ gateway?: string; name: string }> = [];
  public readonly upsertProviderCalls: Parameters<
    OpenShellWorkerGovernanceClient['upsertProvider']
  >[0][] = [];
  private readonly doctor: Awaited<ReturnType<OpenShellWorkerGovernanceClient['doctorCheck']>>;
  private readonly downloads: Record<string, string>;
  private readonly endpoint: string;
  private readonly detachFailures: Error[];
  private readonly providerOutputs: Record<string, string>;
  private readonly refreshStatusOutputs: Record<string, string>;

  public constructor(
    options: {
      doctor?: Awaited<ReturnType<OpenShellWorkerGovernanceClient['doctorCheck']>>;
      detachFailures?: Error[];
      downloads?: Record<string, string>;
      endpoint?: string;
      providerOutputs?: Record<string, string>;
      refreshStatusOutputs?: Record<string, string>;
    } = {}
  ) {
    this.doctor = options.doctor ?? {
      docker: 'ok (version 29.4.0)',
      ok: true,
    };
    this.detachFailures = [...(options.detachFailures ?? [])];
    this.downloads = options.downloads ?? {};
    this.endpoint = options.endpoint ?? 'https://127.0.0.1:17670';
    this.providerOutputs = options.providerOutputs ?? {};
    this.refreshStatusOutputs = options.refreshStatusOutputs ?? {};
  }

  public async version(): Promise<string> {
    return '0.0.63';
  }

  public async status(): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['status']>>> {
    return {
      gateway: 'openshell',
      server: this.endpoint,
      status: 'connected',
      version: '0.0.63',
    };
  }

  public async gatewayInfo(
    input: { gateway?: string } = {}
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['gatewayInfo']>>> {
    this.gatewayInfoCalls.push(input);

    return {
      endpoint: this.endpoint,
      gateway: 'openshell',
    };
  }

  public async doctorCheck(): Promise<
    Awaited<ReturnType<OpenShellWorkerGovernanceClient['doctorCheck']>>
  > {
    return this.doctor;
  }

  public async createSandbox(
    input: Parameters<OpenShellWorkerGovernanceClient['createSandbox']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['createSandbox']>>> {
    this.createSandboxCalls.push(input);

    return {
      name: input.name,
      stdout: 'sandbox created',
    };
  }

  public async upsertProvider(
    input: Parameters<OpenShellWorkerGovernanceClient['upsertProvider']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['upsertProvider']>>> {
    this.upsertProviderCalls.push(input);

    return { name: input.name };
  }

  public async getProvider(input: {
    gateway?: string;
    name: string;
  }): Promise<{ name: string; stdout: string }> {
    this.getProviderCalls.push(input);

    return {
      name: input.name,
      stdout: this.providerOutputs[input.name] ?? `Provider\n\n  Name: ${input.name}\n`,
    };
  }

  public async getProviderRefreshStatus(input: {
    gateway?: string;
    name: string;
  }): Promise<{ name: string; stdout: string }> {
    this.getProviderRefreshStatusCalls.push(input);

    return {
      name: input.name,
      stdout:
        this.refreshStatusOutputs[input.name] ?? `Refresh Status\n\n  Provider: ${input.name}\n`,
    };
  }

  public async detachProvider(
    input: Parameters<OpenShellWorkerGovernanceClient['detachProvider']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['detachProvider']>>> {
    this.detachProviderCalls.push(input);
    const failure = this.detachFailures.shift();

    if (failure) {
      throw failure;
    }

    return {
      stdout: 'detached',
    };
  }

  public async downloadFile(
    input: Parameters<OpenShellWorkerGovernanceClient['downloadFile']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['downloadFile']>>> {
    this.downloadFileCalls.push(input);

    if (input.destinationPath) {
      writeFileSync(input.destinationPath, this.downloads[input.sandboxPath] ?? '', 'utf8');
    }

    return {
      stdout: 'downloaded',
    };
  }

  public async deleteSandbox(
    input: Parameters<OpenShellWorkerGovernanceClient['deleteSandbox']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['deleteSandbox']>>> {
    this.deleteSandboxCalls.push(input);

    return {
      stdout: 'deleted',
    };
  }
}

function createOpenShellPackage(
  workspaceRoots: MaterializedWorkspaceRoot[] = [
    {
      access: 'read-write',
      id: 'repo',
      sourceKind: 'host-dir',
      sourcePath: '/Users/m5pro/Documents/AI/openkit',
      workerPath: '/workspace/openkit',
    },
  ],
  sandboxAccess?: WorkerSandboxAccess
): AgentEnvironmentPackage {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Materialize OpenShell backend');
  const agent = store.getAgent('ws_demo', 'agent_codex_host');

  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'as_openshell_1',
      userId: 'user_local',
      backend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_openshell_1',
      ...(sandboxAccess ? { sandboxAccess } : {}),
      turn,
      workspaceCwd: '/Users/m5pro/Documents/AI/openkit',
      workspaceRoots,
    })
  );
}

/**
 * Creates an OpenShell package that requires remote transport capabilities.
 *
 * @returns Remote OpenShell package fixture.
 */
function createRemoteOpenShellPackage(): AgentEnvironmentPackage {
  const environmentPackage = createOpenShellPackage();

  return AgentEnvironmentPackageSchema.parse({
    ...environmentPackage,
    backend: {
      ...environmentPackage.backend,
      requiredCapabilities: [
        ...environmentPackage.backend.requiredCapabilities,
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ],
      extensions: {
        openshell: {
          gatewayUrlRef: 'runtime://openshell/gateway-url',
          placement: 'remote',
          sandboxSource: 'ghcr.io/openkit/codex-worker:test',
        },
      },
    },
  });
}

/**
 * Creates an OpenShell package with one provider attachment.
 *
 * @returns OpenShell package fixture with a GitHub provider attachment.
 */
function createOpenShellPackageWithProviderAttachment(): AgentEnvironmentPackage {
  const environmentPackage = createOpenShellPackage();

  return AgentEnvironmentPackageSchema.parse({
    ...environmentPackage,
    providers: {
      providerProfiles: [
        ...environmentPackage.providers.providerProfiles,
        {
          category: 'mcp',
          displayName: 'GitHub MCP',
          id: 'github_mcp',
          kind: 'custom',
          models: ['github-mcp'],
        },
      ],
      providerInstances: [
        ...environmentPackage.providers.providerInstances,
        {
          displayName: 'GitHub Read MCP',
          id: 'provider_github_read',
          kind: 'custom',
          models: ['github-mcp'],
          profileId: 'github_mcp',
          secretRef: 'vault://vault_github_read',
          vaultRefIds: ['vault_github_read'],
          vendor: 'github',
        },
      ],
      attachments: [
        ...environmentPackage.providers.attachments,
        {
          id: 'attach_github_mcp',
          providerInstanceId: 'provider_github_read',
          vaultGrantIds: ['grant_github_read'],
        },
      ],
    },
  });
}

/**
 * Creates an OpenShell package with two provider attachments.
 *
 * @returns OpenShell package fixture with GitHub and GitLab provider attachments.
 */
function createOpenShellPackageWithTwoProviderAttachments(): AgentEnvironmentPackage {
  const environmentPackage = createOpenShellPackageWithProviderAttachment();

  return AgentEnvironmentPackageSchema.parse({
    ...environmentPackage,
    providers: {
      ...environmentPackage.providers,
      providerProfiles: [
        ...environmentPackage.providers.providerProfiles,
        {
          category: 'mcp',
          displayName: 'GitLab MCP',
          id: 'gitlab_mcp',
          kind: 'custom',
          models: ['gitlab-mcp'],
        },
      ],
      providerInstances: [
        ...environmentPackage.providers.providerInstances,
        {
          displayName: 'GitLab Read MCP',
          id: 'provider_gitlab_read',
          kind: 'custom',
          models: ['gitlab-mcp'],
          profileId: 'gitlab_mcp',
          secretRef: 'vault://vault_gitlab_read',
          vaultRefIds: ['vault_gitlab_read'],
          vendor: 'gitlab',
        },
      ],
      attachments: [
        ...environmentPackage.providers.attachments,
        {
          id: 'attach_gitlab_mcp',
          providerInstanceId: 'provider_gitlab_read',
          vaultGrantIds: ['grant_gitlab_read'],
        },
      ],
    },
  });
}
