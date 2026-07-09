import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEnvironmentPackage,
  AgentEnvironmentValidationDiagnostic,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { listInjectionPlans } from '../injection-plans.js';
import { listInjectionReceipts } from '../injection-receipts.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createVaultGrant } from '../vault-grants.js';
import { createVaultReference } from '../vault-references.js';
import { createVaultUnlockState } from '../vault-unlock-state.js';
import { listVaultUseRecords } from '../vault-use-records.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import type {
  WorkerGovernanceArtifactRecord,
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import type { WorkerTranscriptPayload } from './worker-transcript.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
} from './workspace-sync-records.js';

/**
 * Opens the migrated workspace database used by worker governance tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('WorkerGovernanceTurnExecutor', () => {
  it('imports worker transcript records and tears down the materialized backend session', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in OpenShell');
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_1',
      environmentBackend: {
        codexModel: 'gpt-5-codex',
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => completedAt,
    });

    await executor.startTurn(store, turn.id, 'Run in OpenShell', {
      requestId: 'req_governance_1',
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
    });

    expect(backend.calls).toEqual([
      'materialize',
      'launch',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'collectArtifacts',
      'teardown',
    ]);
    expect(backend.lastPackage?.extensions.openkit).toMatchObject({
      codexCommand: expect.arrayContaining(['--model', 'gpt-5-codex']),
      turnInput: 'Run in OpenShell',
    });
    expect(backend.lastPackage?.runtime.command.workingDirectory).toBe('/workspace/openkit');
    expect(backend.lastContext?.workspaceRoots).toEqual([
      expect.objectContaining({
        id: 'repo',
        sourcePath: '/Users/m5pro/Documents/AI/openkit',
        workerPath: '/workspace/openkit',
      }),
    ]);
    expect(store.getTurnById(turn.id)).toMatchObject({
      status: 'completed',
      completedAt,
    });
    expect(store.getAgentSession('as_governance_1')).toMatchObject({
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      status: 'idle',
    });
    expect(
      store
        .listThreadItems('ws_demo', 'th_demo')
        .filter((item) => item.type === 'assistant-message')
    ).toEqual([
      expect.objectContaining({
        text: 'Governed worker completed the task.',
        status: 'completed',
      }),
    ]);
    expect(store.listArtifacts('ws_demo')).toEqual([
      expect.objectContaining({
        title: 'Governed worker report',
        turnId: turn.id,
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^ar_workspace_changes_/),
        status: 'ready',
        title: 'Workspace changes ready for review',
        turnId: turn.id,
      }),
    ]);
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wis_/),
        resourceId: 'repo',
        strategy: 'git',
      }),
    ]);
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wmr_/),
        inputSnapshotId: expect.stringMatching(/^wis_/),
        materializedRootRef: '/workspace/openkit/worktrees/main',
        workerSessionId: expect.any(String),
      }),
    ]);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        workerSessionId: `aepsnap_${turn.id}_as_governance_1`,
      }),
    ]);
    expect(listWorkspaceChangeSets(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: 'wcs_1',
        materializationRecordId: expect.stringMatching(/^wmr_/),
      }),
    ]);
    expect(listWorkspaceSyncReviews(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        artifactId: expect.stringMatching(/^ar_workspace_changes_/),
        review: expect.objectContaining({ id: 'swr_1' }),
      }),
    ]);
    expect(
      requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        'ws_demo',
        `aepsnap_${turn.id}_as_governance_1`
      )
    ).toMatchObject({
      snapshotId: `aepsnap_${turn.id}_as_governance_1`,
      workspaceId: 'ws_demo',
      turnId: turn.id,
      agentSessionId: 'as_governance_1',
      agentId: 'agent_codex_host',
    });

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('passes user-declared sandbox access into the resolved worker package', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-sandbox-access-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with sandbox access');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_sandbox_access_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-06-16T00:00:00.000Z',
    });

    await executor.startTurn(store, turn.id, 'Run with sandbox access', {
      requestId: 'req_sandbox_access_1',
      sandboxAccess: {
        filesystem: [
          {
            access: 'read-write',
            id: 'tool_cache',
            purpose: 'Tool cache',
            targetPath: '/sandbox/.cache/tool',
          },
        ],
        network: [
          {
            host: 'registry.npmjs.org',
            id: 'npm_registry',
            port: 443,
            purpose: 'Install dependencies',
          },
        ],
      },
      workspaceRoots: [],
    });

    expect(backend.lastPackage?.policy.filesystem?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tool_cache',
          workerPath: '/sandbox/.cache/tool',
        }),
      ])
    );
    expect(backend.lastPackage?.policy.network?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: 'registry.npmjs.org',
          id: 'npm_registry',
          port: 443,
        }),
      ])
    );

    coreDb.sqlite.close();
  });

  it('marks backend workspace handles failed when teardown fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-fail-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in OpenShell');
    const backend = new FakeWorkerGovernanceBackend();
    backend.failTeardown = true;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_fail_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await expect(
      executor.startTurn(store, turn.id, 'Run in OpenShell', {
        requestId: 'req_teardown_fail_1',
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
    ).rejects.toThrow('teardown failed');

    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'failed',
        workerSessionId: `aepsnap_${turn.id}_as_teardown_fail_1`,
      }),
    ]);

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('passes workspace source catalog context into the resolved AEP snapshot', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-source-ref-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with source catalog');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_source_ref_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await executor.startTurn(store, turn.id, 'Run with source catalog', {
      requestId: 'req_source_ref_1',
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Main repository',
            id: 'repo_default',
            kind: 'git',
            locator: { repositoryResourceId: 'repo_default' },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo_default',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo_default: 'repo_default' },
    });

    expect(backend.lastPackage?.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      kind: 'git',
      locator: { repositoryResourceId: 'repo_default' },
      sourceId: 'repo_default',
      sourceRef: 'repo_default',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'repo_default',
          sourceId: 'repo_default',
        }),
      ])
    );
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'repo_default',
        }),
      ])
    );

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('persists remote-container workspace synchronization evidence through the same review path', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-remote-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in remote OpenShell');
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend({
      capabilities: [
        'container',
        'transcript-sink',
        'sidecar-control-endpoint',
        'sidecar-capability-endpoint',
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ],
      materializationStatus: {
        gatewayEndpoint: 'https://a1.example.com:17670',
        gatewayName: 'a1-openshell',
        health: 'ready',
        version: '0.0.63',
      },
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_remote_governance_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.example.com/api/worker-control',
        gatewayUrl: 'https://a1.example.com:17670',
        kind: 'openshell',
        placement: 'remote',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => completedAt,
    });

    await executor.startTurn(store, turn.id, 'Run in remote OpenShell', {
      requestId: 'req_remote_governance_1',
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
    });

    expect(backend.lastPackage?.backend.requiredCapabilities).toEqual(
      expect.arrayContaining([
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ])
    );
    expect(backend.lastPackage?.backend.extensions?.openshell).toMatchObject({
      gatewayUrlRef: 'runtime://openshell/gateway-url',
      placement: 'remote',
    });
    expect(JSON.stringify(backend.lastPackage)).not.toContain('https://a1.example.com:17670');
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        backend: expect.objectContaining({
          capabilitySummary: expect.arrayContaining(['remote-gateway', 'git-materialization']),
          kind: 'openshell',
        }),
      }),
    ]);
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        backendKind: 'openshell',
        readinessEvidence: expect.arrayContaining([
          { kind: 'backend.ready', ref: 'version:0.0.63' },
        ]),
      }),
    ]);
    expect(listWorkspaceSyncReviews(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        artifactId: expect.stringMatching(/^ar_workspace_changes_/),
        review: expect.objectContaining({ status: 'pending' }),
      }),
    ]);

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('passes scheduler-owned lineage into backend materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-binding-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with scheduler binding');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_unexpected_random_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await executor.startTurn(store, turn.id, 'Run with scheduler binding', {
      agentSessionId: 'as_governance_binding_1',
      requestId: 'req_governance_binding_1',
      sandboxBindingRef: 'lease-binding:executor_1',
      workspaceRoots: [],
    });

    expect(backend.lastContext?.sandboxBindingRef).toBe('lease-binding:executor_1');
    expect(backend.lastPackage?.scope.agentSessionId).toBe('as_governance_binding_1');
    expect(backend.lastPackage?.snapshotId).toBe(`aepsnap_${turn.id}_as_governance_binding_1`);
    expect(store.getAgentSession('as_governance_binding_1')).toMatchObject({
      id: 'as_governance_binding_1',
      status: 'idle',
    });

    coreDb.sqlite.close();
  });

  it('passes vault backend dependencies into worker package resolution', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-vault-grants-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 8) });
    vaultUnlockState.backend().store({
      material: 'ghp_governance_token',
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
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2099-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      policyDecisionId: 'pd_repo_read_1',
      targetAgentSessionId: 'as_governance_vault_1',
      vaultReferenceId: 'vault_github_read',
      now: () => timestamp,
    });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run GitHub MCP in OpenShell');
    const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
    store.upsertAgent('ws_demo', {
      ...baseAgent,
      config: {
        ...baseAgent.config,
        mcpServerIds: ['github'],
      },
    });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_vault_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      await executor.startTurn(store, turn.id, 'Run GitHub MCP in OpenShell', {
        requestId: 'req_governance_vault_1',
        workspaceRoots: [],
      });

      expect(backend.lastPackage?.vault.grants).toEqual([
        expect.objectContaining({
          expiresAt: '2099-07-05T01:00:00.000Z',
          id: 'grant_github_read',
        }),
      ]);
      expect(listInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          packageSnapshotId: backend.lastPackage?.snapshotId,
        }),
      ]);
      expect(listInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'as_governance_vault_1',
          grantId: 'grant_github_read',
        }),
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('ghp_governance_token');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('passes vault-backed runtime files into backend-private materialization context', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-runtime-file-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 10) });
    vaultUnlockState.backend().store({
      material: '{"tokens":{"openai":"codex_executor_secret"}}',
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
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-file'],
      grantId: 'grant_codex_auth_json',
      lifetime: 'agent-session',
      ownerScope: 'server',
      targetAgentSessionId: 'as_governance_runtime_file_1',
      vaultReferenceId: 'vault_codex_auth_json',
      now: () => timestamp,
    });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run Codex auth runtime file');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_runtime_file_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      await executor.startTurn(store, turn.id, 'Run Codex auth runtime file', {
        requestId: 'req_governance_runtime_file_1',
        workspaceRoots: [],
      });

      expect(backend.lastContext?.runtimeFileCredentials).toEqual([
        {
          credentialValue: '{"tokens":{"openai":"codex_executor_secret"}}',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_codex_auth_json',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('codex_executor_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

class FakeWorkerGovernanceBackend implements WorkerGovernanceBackend {
  public readonly calls: string[] = [];
  public failTeardown = false;
  public lastContext: Parameters<WorkerGovernanceBackend['materialize']>[1] | null = null;
  public lastPackage: AgentEnvironmentPackage | null = null;
  private readonly capabilities: string[];
  private readonly materializationStatus:
    | WorkerGovernanceMaterializationRecord['backendStatus']
    | undefined;

  public constructor(
    options: {
      capabilities?: string[];
      materializationStatus?: WorkerGovernanceMaterializationRecord['backendStatus'];
    } = {}
  ) {
    this.capabilities = options.capabilities ?? [
      'container',
      'transcript-sink',
      'sidecar-control-endpoint',
      'sidecar-capability-endpoint',
    ];
    this.materializationStatus = options.materializationStatus;
  }

  public async describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities> {
    return {
      capabilities: this.capabilities,
      dynamicCapabilities: [],
      kind: 'openshell',
      version: '0.0.63',
    };
  }

  public async validatePackage(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    context?: Parameters<WorkerGovernanceBackend['materialize']>[1]
  ): Promise<WorkerGovernanceMaterializationRecord> {
    this.calls.push('materialize');
    this.lastContext = context ?? null;
    this.lastPackage = environmentPackage;

    return {
      backendKind: 'openshell',
      command: {
        argv: environmentPackage.runtime.command.argv,
        workingDirectory: environmentPackage.runtime.command.workingDirectory,
      },
      controlMode: environmentPackage.control.mode,
      packageId: environmentPackage.packageId,
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      ...(this.materializationStatus ? { backendStatus: this.materializationStatus } : {}),
      workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
        access: input.access,
        id: input.id,
        kind: input.kind,
        target: sessionWorkspaceInputTarget(environmentPackage, input.id),
      })),
    };
  }

  public async launch(): Promise<WorkerGovernanceEvidenceRecord> {
    this.calls.push('launch');

    return {
      data: {},
      kind: 'fake.launch',
      timestamp: '2026-06-16T00:00:00.000Z',
    };
  }

  public async update(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  public async collectEvidence(): Promise<WorkerGovernanceEvidenceRecord[]> {
    this.calls.push('collectEvidence');

    return [];
  }

  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    this.calls.push('collectProviderRefreshStatuses');

    return [];
  }

  public async collectTranscript(): Promise<WorkerTranscriptPayload> {
    this.calls.push('collectTranscript');

    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    return {
      artifactsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'artifact',
        lineage: {
          workspaceId: this.lastPackage.scope.workspaceId,
          threadId: this.lastPackage.scope.threadId,
          turnId: this.lastPackage.scope.turnId,
          agentSessionId: this.lastPackage.scope.agentSessionId,
          packageSnapshotId: this.lastPackage.snapshotId,
          requestId: this.lastPackage.scope.requestId,
        },
        sequence: 2,
        artifact: {
          kind: 'report',
          mediaType: 'text/markdown',
          path: '/openkit/artifacts/report.md',
          title: 'Governed worker report',
        },
      })}\n`,
      itemsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'item',
        lineage: {
          workspaceId: this.lastPackage.scope.workspaceId,
          threadId: this.lastPackage.scope.threadId,
          turnId: this.lastPackage.scope.turnId,
          agentSessionId: this.lastPackage.scope.agentSessionId,
          packageSnapshotId: this.lastPackage.snapshotId,
          requestId: this.lastPackage.scope.requestId,
        },
        sequence: 1,
        item: {
          type: 'assistant-message',
          status: 'completed',
          text: 'Governed worker completed the task.',
        },
      })}\n`,
    };
  }

  public async collectWorkspaceChanges(): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    this.calls.push('collectWorkspaceChanges');

    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    const inputSnapshotId = `wis_${this.lastPackage.snapshotId}_repo`;
    const materializationRecordId = `wmr_${this.lastPackage.snapshotId}_repo`;

    return [
      {
        changeSet: {
          artifactIds: ['ar_patch'],
          base: { commit: 'abc123', contentDigest: null },
          bundle: null,
          changedPaths: [{ binary: false, path: 'docs/report.md', status: 'modified' }],
          createdAt: '2026-06-16T00:00:00.000Z',
          evidenceRefs: [{ kind: 'test', ref: 'ev_test' }],
          head: { commit: 'def456', contentDigest: null },
          id: 'wcs_1',
          inputSnapshotId,
          materializationRecordId,
          patch: { bytes: 1200, digest: 'sha256:patch', ref: 'artifact://patch' },
          redaction: { notes: [], status: 'redacted' },
          resourceId: 'repo',
          strategy: 'git',
          workspaceId: this.lastPackage.scope.workspaceId,
        },
        filesystemApply: null,
        patchPayload: {
          mediaType: 'text/x-diff',
          text: 'diff --git a/docs/report.md b/docs/report.md\n',
          digest: 'sha256:patch',
          bytes: 44,
        },
        review: {
          actionCenterRowId: 'workspace-review:swr_1',
          changeSetId: 'wcs_1',
          createdAt: '2026-06-16T00:00:00.000Z',
          diffSummary: { additions: 0, deletions: 0, filesChanged: 1 },
          id: 'swr_1',
          riskSummary: '1 changed paths staged for human review.',
          staging: {
            branch: 'openkit/review/swr_1',
            ref: 'staging://workspace/swr_1',
            strategy: 'git_worktree',
          },
          status: 'pending',
          updatedAt: '2026-06-16T00:00:00.000Z',
          validation: [{ command: 'test', ref: 'ev_test', status: 'passed' }],
          workspaceId: this.lastPackage.scope.workspaceId,
        },
      },
    ];
  }

  public async collectArtifacts(): Promise<WorkerGovernanceArtifactRecord[]> {
    this.calls.push('collectArtifacts');

    return [];
  }

  public async teardown(): Promise<WorkerGovernanceEvidenceRecord> {
    this.calls.push('teardown');

    if (this.failTeardown) {
      throw new Error('teardown failed');
    }

    return {
      data: {},
      kind: 'fake.teardown',
      timestamp: '2026-06-16T00:00:00.000Z',
    };
  }
}

/**
 * Reads the planned slot target for a package workspace input.
 *
 * @param environmentPackage Package carrying the OpenKit session workspace extension.
 * @param inputId Workspace input id.
 * @returns Worker-visible materialized target path.
 */
function sessionWorkspaceInputTarget(
  environmentPackage: AgentEnvironmentPackage,
  inputId: string
): string {
  const openkit = environmentPackage.extensions.openkit as
    | {
        sessionWorkspace?: {
          layout: { slots: Array<{ id: string; path: string }> };
          materialization: { inputs: Array<{ inputId: string; slotId: string }> };
        };
      }
    | undefined;
  const slotId = openkit?.sessionWorkspace?.materialization.inputs.find(
    (input) => input.inputId === inputId
  )?.slotId;
  const path = openkit?.sessionWorkspace?.layout.slots.find((slot) => slot.id === slotId)?.path;

  if (!path) {
    throw new Error(`session workspace target missing for input: ${inputId}`);
  }

  return path;
}
