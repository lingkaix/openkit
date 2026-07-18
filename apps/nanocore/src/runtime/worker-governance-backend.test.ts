import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  type WorkerSandboxAccess,
} from '@openkit/config-schema';
import { WorkerCanonicalEventRecordSchema } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import type { OpenShellCellLifecycle } from './openshell-cell.js';
import type { OpenShellSandboxExecInput } from './openshell-cli.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import {
  OpenShellWorkerGovernanceBackend,
  type OpenShellWorkerGovernanceBackendOptions,
  type OpenShellWorkerGovernanceClient,
  type WorkerGovernanceMaterializationContext,
} from './worker-governance-backend.js';
import { importWorkerTranscript } from './worker-transcript.js';

/** Creates one OpenShell backend with an isolated private data root. */
function createTestOpenShellBackend(
  options: Omit<
    OpenShellWorkerGovernanceBackendOptions,
    'cellLifecycle' | 'dataRoot' | 'deploymentId'
  > & {
    cellLifecycle?: OpenShellCellLifecycle;
    dataRoot?: string;
    deploymentId?: string;
  }
): OpenShellWorkerGovernanceBackend {
  return new OpenShellWorkerGovernanceBackend({
    ...options,
    cellLifecycle: options.cellLifecycle ?? new FakeOpenShellCellLifecycle(),
    dataRoot: options.dataRoot ?? mkdtempSync(join(tmpdir(), 'openkit-openshell-backend-')),
    deploymentId: options.deploymentId ?? 'local',
  });
}

/** Deterministic disposable Cell lifecycle used by backend tests. */
class FakeOpenShellCellLifecycle implements OpenShellCellLifecycle {
  private activeOwner: string | null = null;

  private lastRecycledOwner: string | null = null;

  public readonly prepareCalls: string[] = [];

  public readonly recycleCalls: string[] = [];

  public readonly targetId: string;

  public prepareFailure: Error | null = null;

  public recycleFailure: Error | null = null;

  /**
   * Creates one fake lifecycle bound to a stable target id.
   *
   * @param targetId Non-secret Cell target binding.
   */
  public constructor(targetId = 'cell-test') {
    this.targetId = targetId;
  }

  /**
   * Records one Cell prepare.
   *
   * @param ownerId Durable backend session owner.
   */
  public async prepare(ownerId: string): Promise<void> {
    this.prepareCalls.push(ownerId);
    if (this.activeOwner !== null) {
      throw new Error('Fake OpenShell Cell already has an active owner.');
    }
    this.activeOwner = ownerId;
    if (this.prepareFailure) {
      throw this.prepareFailure;
    }
  }

  /**
   * Records one complete Cell recycle.
   *
   * @param ownerId Durable backend session owner.
   */
  public async recycle(ownerId: string): Promise<void> {
    this.recycleCalls.push(ownerId);
    if (this.recycleFailure) {
      throw this.recycleFailure;
    }
    if (this.activeOwner === null && this.lastRecycledOwner === ownerId) {
      return;
    }
    if (this.activeOwner !== ownerId) {
      throw new Error('Fake OpenShell Cell recycle owner does not match.');
    }
    this.activeOwner = null;
    this.lastRecycledOwner = ownerId;
  }
}

/** Recomputes the deployment-scoped sandbox id expected from the backend contract. */
function expectedOpenShellSandboxName(agentSessionId: string, deploymentId = 'local'): string {
  const deploymentLabel =
    deploymentId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 12) || 'deployment';
  const deploymentDigest = createHash('sha256').update(deploymentId).digest('hex').slice(0, 12);
  const sessionLabel = agentSessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 10);
  const sessionDigest = createHash('sha256').update(agentSessionId).digest('hex').slice(0, 12);
  return `oks-${deploymentLabel}-${deploymentDigest}-worker-${sessionLabel}-${sessionDigest}`;
}

describe('OpenShellWorkerGovernanceBackend', () => {
  it('declares real OpenShell capabilities from the installed CLI version', async () => {
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
    });

    expect(await backend.describeCapabilities()).toMatchObject({
      kind: 'openshell',
      version: '0.0.80',
      capabilities: expect.arrayContaining([
        'container',
        'filesystem-policy',
        'network-policy',
        'process-policy',
        'transcript-sink',
        'worker-control',
        'nanocore-inference-upstream',
        'trusted-worker-inference-relay',
        'worker.runtime-provenance.v1',
        'audit-export',
      ]),
    });
    expect((await backend.describeCapabilities()).capabilities).not.toContain('control-relay');
    expect((await backend.describeCapabilities()).capabilities).not.toContain(
      'sidecar-control-endpoint'
    );
    expect((await backend.describeCapabilities()).capabilities).not.toContain(
      'sidecar-capability-endpoint'
    );
    expect((await backend.describeCapabilities()).capabilities).not.toContain(
      'provider-attachments'
    );
    expect((await backend.describeCapabilities()).capabilities).not.toContain('remote-gateway');
  });

  it('declares remote transport capabilities and durable placement for a remote Cell', async () => {
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'a1-openkit',
      gatewayUrl: 'https://127.0.0.1:17670',
      placement: 'remote',
    });
    const environmentPackage = createOpenShellPackage([]);

    expect((await backend.describeCapabilities()).capabilities).toEqual(
      expect.arrayContaining([
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ])
    );
    expect(backend.planSession(environmentPackage).backendTarget).toMatchObject({
      gatewayEndpoint: 'https://127.0.0.1:17670',
      gatewayName: 'a1-openkit',
      placement: 'remote',
    });
  });

  it('rejects capability claims from any OpenShell version other than the pinned target', async () => {
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient({ version: '0.0.81' }),
      gatewayName: 'openshell',
    });

    await expect(backend.describeCapabilities()).rejects.toThrow('requires exactly 0.0.80');
  });

  it('validates direct NanoCore control packages and rejects inference.local control endpoints', async () => {
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
    });
    const basePackage = createOpenShellPackage();
    const validPackage = AgentEnvironmentPackageSchema.parse({
      ...basePackage,
      capabilities: {
        mode: 'disabled',
        protocol: 'openkit-worker-capability-v1',
        routes: [],
      },
      control: {
        ...basePackage.control,
        adapter: {
          ...basePackage.control.adapter,
          targetTransport: 'outbound-https',
        },
        auth: {
          credentialVisibility: 'environment',
          kind: 'sandbox-session-token',
          tokenRef: 'runtime://openkit/control-token',
        },
        channels: {
          artifacts: 'batch',
          commands: true,
          events: 'batch',
          heartbeats: true,
          logs: 'summary-only',
        },
        commands: ['interrupt'],
        endpoint: {
          baseUrl: 'https://nanocore.local/api/worker-control',
          implementation: 'direct-nanocore',
          kind: 'direct-url',
          required: true,
        },
        mode: 'direct-nanocore',
      },
    });
    const invalidPackage = AgentEnvironmentPackageSchema.parse({
      ...validPackage,
      control: {
        ...validPackage.control,
        endpoint: {
          ...validPackage.control.endpoint,
          baseUrl: 'https://inference.local/api/worker-control',
        },
      },
    });

    expect(await backend.validatePackage(validPackage)).toEqual([]);
    const diagnostics = await backend.validatePackage(invalidPackage);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'openshell_control_must_not_use_inference_local',
          path: '$.control.endpoint.baseUrl',
        }),
      ])
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'openshell_control_endpoint_must_be_control_local'
    );
  });

  it('creates a sandbox materialization record without leaking backend-private or host-local details', async () => {
    const cli = new FakeOpenShellClient();
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-session-data-'));
    const workspaceRoot = createGitWorkspace('openkit-openshell-session-workspace-');
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'token_openshell_control_1',
    });
    const backend = createTestOpenShellBackend({
      cli,
      dataRoot,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const workspaceRoots = [
      {
        access: 'read-write' as const,
        id: 'repo',
        sourceKind: 'host-dir' as const,
        sourcePath: workspaceRoot,
        workerPath: '/workspace/openkit',
      },
    ];
    const environmentPackage = createOpenShellPackage(workspaceRoots);

    const identity = backend.planSession(environmentPackage);
    expect(cli.createSandboxCalls).toEqual([]);
    expect(cli.statusCalls).toEqual([]);
    expect(existsSync(join(dataRoot, identity.stagingDirectoryRef))).toBe(false);
    const materialization = await backend.materialize(environmentPackage, {
      runtimeFileCredentials: [
        {
          credentialValue: 'runtime_secret_value',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ],
      workspaceRoots,
    });
    const serialized = JSON.stringify(materialization);

    expect(cli.createSandboxCalls).toEqual([
      expect.objectContaining({
        command: expect.any(Array),
        env: expect.objectContaining({
          OPENKIT_AGENT_SESSION_ID: environmentPackage.scope.agentSessionId,
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
          'openkit.openshellMappingVersion': 'openshell-v5',
          'openkit.openshellSnapshotId': 'openshell-0.0.80-2026-07-11',
        }),
        name: expectedOpenShellSandboxName(environmentPackage.scope.agentSessionId),
        policyPath: expect.stringMatching(/policy\.yaml$/),
        providers: [],
        uploads: expect.arrayContaining([
          expect.objectContaining({
            targetPath: '/openkit/config/package.json',
          }),
        ]),
      }),
    ]);
    expect(readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8')).toContain(
      'network_policies:'
    );
    expect(
      readFileSync(cli.createSandboxCalls[0]?.uploads?.[0]?.sourcePath ?? '', 'utf8')
    ).toContain(environmentPackage.snapshotId);
    const sessionDirectory = dirname(cli.createSandboxCalls[0]?.uploads?.[0]?.sourcePath ?? '');
    const sessionsRoot = join(dataRoot, 'server', 'runtime', 'worker-backend-sessions');
    expect(relative(sessionsRoot, sessionDirectory)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(statSync(sessionDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(cli.createSandboxCalls[0]?.policyPath ?? '').mode & 0o777).toBe(0o600);
    for (const upload of cli.createSandboxCalls[0]?.uploads ?? []) {
      expect(statSync(upload.sourcePath).mode & 0o777).toBe(0o600);
    }
    expect(identity).toEqual({
      agentSessionId: environmentPackage.scope.agentSessionId,
      backendKind: 'openshell',
      backendSessionId: expectedOpenShellSandboxName(environmentPackage.scope.agentSessionId),
      backendTarget: {
        cellTargetId: 'cell-test',
        gatewayEndpoint: null,
        gatewayName: 'openshell',
        placement: 'local',
      },
      deploymentId: 'local',
      packageSnapshotId: environmentPackage.snapshotId,
      stagingDirectoryRef: relative(dataRoot, sessionDirectory),
      transientProviderInstanceId: null,
    });
    expect(cli.execSandboxCalls).toEqual([]);
    expect(materialization).toMatchObject({
      backendKind: 'openshell',
      packageSnapshotId: environmentPackage.snapshotId,
      controlMode: 'direct-nanocore',
      sandbox: {
        name: expectedOpenShellSandboxName(environmentPackage.scope.agentSessionId),
        source: 'ghcr.io/openkit/codex-worker:test',
        state: 'created',
      },
      backendStatus: {
        gatewayName: 'openshell',
        gatewayEndpoint: 'https://127.0.0.1:17670',
        health: 'ready',
        version: '0.0.80',
      },
    });
    expect(serialized).not.toContain('/Users/m5pro');
    expect(serialized).not.toContain('token_openshell_control_1');
    expect(serialized).not.toContain('containerId');
    expect(serialized).not.toContain('backendSessionId');
    const sandboxCommand = cli.createSandboxCalls[0]?.command.join(' ') ?? '';
    expect(sandboxCommand).toContain('--dry-run');
    expect(sandboxCommand).not.toContain('openkit-worker-sidecar');
    expect(sandboxCommand).not.toContain('wait -n');
    expect(sandboxCommand).not.toContain("'env' '-u' 'OPENKIT_CONTROL_TOKEN'");
    expect(cli.createSandboxCalls[0]?.env).not.toHaveProperty('OPENKIT_CONTROL_RELAY_UPSTREAM');
    expect(workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)).toMatchObject({
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
    });

    await backend.launch(materialization);
    expect(cli.execSandboxCalls).toEqual([
      expect.objectContaining({
        gateway: 'openshell',
        name: expectedOpenShellSandboxName(environmentPackage.scope.agentSessionId),
      }),
    ]);
    expect(cli.execSandboxCalls[0]?.command.join(' ')).toContain('openkit-codex-shim');
  });

  it('delegates launch through a detached sandbox shell without interpolating worker argv', async () => {
    let releaseLauncher!: () => void;
    const launcherExited = new Promise<void>((resolve) => {
      releaseLauncher = resolve;
    });
    const cli = new FakeOpenShellClient({ execSandboxGate: launcherExited });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_detached_launch',
      }),
    });
    const environmentPackage = createOpenShellPackage([]);
    const literalArgument = `literal $HOME; $(touch /tmp/openkit-must-not-run) ' " \\`;
    environmentPackage.runtime.command.argv.push(literalArgument);
    const workerArgv = [...environmentPackage.runtime.command.argv];
    const materialization = await backend.materialize(environmentPackage);
    let launchSettled = false;
    const launch = backend.launch(materialization).then((evidence) => {
      launchSettled = true;
      return evidence;
    });

    try {
      await vi.waitFor(() => expect(cli.execSandboxCalls).toHaveLength(1));
      const delegatedArgv = cli.execSandboxCalls[0]?.command ?? [];
      const launcherScript = delegatedArgv[2] ?? '';

      expect(delegatedArgv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
      expect(launcherScript).toMatch(/\bsetsid "\$@"/);
      expect(launcherScript).toContain('</dev/null');
      expect(launcherScript).toContain('>/dev/null');
      expect(launcherScript).toContain('2>&1');
      expect(launcherScript).toMatch(/&\s*$/);
      expect(launcherScript).not.toContain(literalArgument);
      expect(delegatedArgv[3]).toEqual(expect.any(String));
      expect(delegatedArgv.slice(4)).toEqual(workerArgv);
      await Promise.resolve();
      expect(launchSettled).toBe(false);
    } finally {
      releaseLauncher();
      await launch;
    }

    expect(launchSettled).toBe(true);
  });

  it('invalidates all same-process access after durable session cleanup', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient();
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-direct-cleanup-'));
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'token_openshell_direct_cleanup',
    });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      dataRoot,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const environmentPackage = createOpenShellPackage([]);
    const identity = backend.planSession(environmentPackage);
    const materialization = await backend.materialize(environmentPackage);

    await expect(backend.cleanupSession(identity)).resolves.toBeUndefined();

    expect(workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)).toBeNull();
    expect(cellLifecycle.recycleCalls).toEqual([identity.backendSessionId]);
    expect(existsSync(join(dataRoot, identity.stagingDirectoryRef))).toBe(false);
    await expect(backend.launch(materialization)).rejects.toThrow('materialized session not found');
    await expect(backend.collectEvidence(environmentPackage.snapshotId)).rejects.toThrow(
      'materialized session not found'
    );
    await expect(backend.cleanupSession(identity)).resolves.toBeUndefined();
    expect(cellLifecycle.recycleCalls).toEqual([
      identity.backendSessionId,
      identity.backendSessionId,
    ]);
  });

  it('restores an exact durable OpenShell session as read-only without creating or launching work', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-restored-session-'));
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const environmentPackage = createOpenShellPackage([]);
    const cli = new FakeOpenShellClient({
      downloads: {
        '/sandbox/openkit/session/events.jsonl': '{"type":"worker.ready"}\n',
        '/sandbox/openkit/session/items.jsonl': '{"kind":"item"}\n',
      },
    });
    const originalBackend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      dataRoot,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_restore_original',
      }),
    });
    const identity = originalBackend.planSession(environmentPackage);
    const materialization = await originalBackend.materialize(environmentPackage);
    const createCallCount = cli.createSandboxCalls.length;
    const prepareCallCount = cellLifecycle.prepareCalls.length;
    const restoredBackend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      dataRoot,
      gatewayName: 'openshell',
    });

    await expect(
      restoredBackend.restoreSession(environmentPackage, identity)
    ).resolves.toBeUndefined();
    await expect(restoredBackend.collectTranscript(environmentPackage.snapshotId)).resolves.toEqual(
      expect.objectContaining({
        eventsJsonl: '{"type":"worker.ready"}\n',
        itemsJsonl: '{"kind":"item"}\n',
      })
    );
    await expect(restoredBackend.launch(materialization)).rejects.toThrow(
      'read-only restored session'
    );
    await expect(
      restoredBackend.cleanupSession({
        ...identity,
        backendSessionId: 'wrong-sandbox',
      })
    ).rejects.toThrow('does not match its deployment-owned lineage');
    await expect(restoredBackend.cleanupSession(identity)).resolves.toBeUndefined();

    expect(cli.createSandboxCalls).toHaveLength(createCallCount);
    expect(cli.execSandboxCalls).toHaveLength(0);
    expect(cellLifecycle.prepareCalls).toHaveLength(prepareCallCount);
    expect(cellLifecycle.recycleCalls).toEqual([identity.backendSessionId]);
    expect(existsSync(join(dataRoot, identity.stagingDirectoryRef))).toBe(false);
  });

  it('rejects restoring an OpenShell session with non-transient provider credentials', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({ cli, gatewayName: 'openshell' });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await expect(
      backend.restoreSession(environmentPackage, backend.planSession(environmentPackage))
    ).rejects.toThrow('cannot restore a session with non-transient provider attachments');

    expect(cli.createSandboxCalls).toEqual([]);
    expect(cli.upsertProviderCalls).toEqual([]);
  });

  it('restores a missing staging directory without a speculative preflight', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-restored-missing-'));
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient(),
      dataRoot,
      gatewayName: 'openshell',
    });
    const environmentPackage = createOpenShellPackage([]);

    await expect(
      backend.restoreSession(environmentPackage, backend.planSession(environmentPackage))
    ).resolves.toBeUndefined();
  });

  it('rejects a conflicting restored OpenShell identity before any external effect', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-restored-conflict-'));
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      dataRoot,
      gatewayName: 'openshell',
    });
    const environmentPackage = createOpenShellPackage([]);
    const identity = backend.planSession(environmentPackage);

    await expect(
      backend.restoreSession(environmentPackage, {
        ...identity,
        backendSessionId: 'wrong-sandbox',
      })
    ).rejects.toThrow('does not match its deployment-owned lineage');

    expect(cli.statusCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
    expect(cli.execSandboxCalls).toEqual([]);
  });

  it('prepares the disposable Cell before OpenShell gateway preflight', async () => {
    const order: string[] = [];
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const originalPrepare = cellLifecycle.prepare.bind(cellLifecycle);
    cellLifecycle.prepare = async (ownerId) => {
      order.push('cell:prepare');
      await originalPrepare(ownerId);
    };
    const cli = new FakeOpenShellClient();
    const originalStatus = cli.status.bind(cli);
    vi.spyOn(cli, 'status').mockImplementation(async (input) => {
      order.push('openshell:status');
      return originalStatus(input);
    });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_cell_prepare_order',
      }),
    });
    const environmentPackage = createOpenShellPackage([]);

    await backend.materialize(environmentPackage);

    expect(order.slice(0, 2)).toEqual(['cell:prepare', 'openshell:status']);
    expect(cellLifecycle.prepareCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
  });

  it('recycles the complete Cell after sandbox creation fails', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient({ createSandboxFailure: new Error('create failed') });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_cell_create_failure',
      }),
    });
    const environmentPackage = createOpenShellPackage([]);

    await expect(backend.materialize(environmentPackage)).rejects.toThrow('create failed');

    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
  });

  it('recycles the Cell when prepare fails after taking lifecycle ownership', async () => {
    const prepareFailure = new Error('cell prepare failed');
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    cellLifecycle.prepareFailure = prepareFailure;
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
    });
    const environmentPackage = createOpenShellPackage([]);

    await expect(backend.materialize(environmentPackage)).rejects.toBe(prepareFailure);

    expect(cellLifecycle.prepareCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
    expect(cli.statusCalls).toEqual([]);
  });

  it('preserves prepare and recycle failures after lifecycle ownership begins', async () => {
    const prepareFailure = new Error('cell prepare failed');
    const recycleFailure = new Error('cell recycle failed');
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    cellLifecycle.prepareFailure = prepareFailure;
    cellLifecycle.recycleFailure = recycleFailure;
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
    });
    const environmentPackage = createOpenShellPackage([]);
    const error = await backend.materialize(environmentPackage).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([prepareFailure, recycleFailure]);
    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
  });

  it('uses whole-Cell recycle as the physical cleanup proof', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_cell_cleanup',
      }),
    });
    const environmentPackage = createOpenShellPackage([]);
    const identity = backend.planSession(environmentPackage);

    await backend.materialize(environmentPackage);
    await backend.cleanupSession(identity);

    expect(cellLifecycle.recycleCalls).toEqual([identity.backendSessionId]);
  });

  it('keeps process access revoked when whole-Cell recycle fails', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    cellLifecycle.recycleFailure = new Error('cell recycle failed');
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_cell_cleanup_failure',
      }),
    });
    const environmentPackage = createOpenShellPackage([]);
    const identity = backend.planSession(environmentPackage);
    const materialization = await backend.materialize(environmentPackage);

    await expect(backend.cleanupSession(identity)).rejects.toThrow(
      'durable session cleanup failed'
    );
    await expect(backend.launch(materialization)).rejects.toThrow('materialized session not found');
    expect(cellLifecycle.recycleCalls).toEqual([identity.backendSessionId]);
  });

  it('rejects cleanup manifests whose staging reference escapes the private session root', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
    });
    const environmentPackage = createOpenShellPackage([]);
    const identity = backend.planSession(environmentPackage);

    await expect(
      backend.cleanupSession({
        ...identity,
        stagingDirectoryRef: '../outside',
      })
    ).rejects.toThrow('does not match its deployment-owned lineage');
  });

  it('rejects same-deployment cleanup manifests retargeted to another physical session', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({ cli, gatewayName: 'openshell' });
    const environmentPackage = createOpenShellPackage([]);
    const otherPackage = AgentEnvironmentPackageSchema.parse({
      ...environmentPackage,
      snapshotId: 'aepsnap_other_physical_session',
      scope: { ...environmentPackage.scope, agentSessionId: 'as_other_physical_session' },
    });
    const identity = backend.planSession(environmentPackage);
    const otherIdentity = backend.planSession(otherPackage);

    await expect(
      backend.cleanupSession({
        ...identity,
        backendSessionId: otherIdentity.backendSessionId,
        transientProviderInstanceId: otherIdentity.transientProviderInstanceId,
      })
    ).rejects.toThrow('does not match its deployment-owned lineage');
  });

  it('rejects cleanup manifests for a remote OpenShell placement', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
    });
    const identity = backend.planSession(createOpenShellPackage([]));

    await expect(
      backend.cleanupSession({
        ...identity,
        backendTarget: { ...identity.backendTarget, placement: 'remote' },
      })
    ).rejects.toThrow('does not match its deployment-owned lineage');
    expect(cellLifecycle.recycleCalls).toEqual([]);
  });

  it('cleans a durable session only from a fresh backend bound to the exact Cell target', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-restart-cleanup-'));
    const hostCellLifecycle = new FakeOpenShellCellLifecycle();
    const materializeCli = new FakeOpenShellClient();
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_restart_cleanup_1');
    const materializingBackend = createTestOpenShellBackend({
      cellLifecycle: hostCellLifecycle,
      cli: materializeCli,
      dataRoot,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_restart_cleanup_token',
      }),
    });
    const identity = materializingBackend.planSession(environmentPackage);

    await materializingBackend.materialize(environmentPackage);
    expect(existsSync(join(dataRoot, identity.stagingDirectoryRef))).toBe(true);

    const mismatchedRecoveryBackend = createTestOpenShellBackend({
      cellLifecycle: new FakeOpenShellCellLifecycle('cell-other-host'),
      cli: new FakeOpenShellClient(),
      dataRoot,
      gatewayName: 'changed-after-restart',
      gatewayUrl: 'https://changed.example.invalid:17670',
    });

    await expect(mismatchedRecoveryBackend.cleanupSession(identity)).rejects.toThrow(
      'does not match its deployment-owned lineage'
    );
    expect(hostCellLifecycle.recycleCalls).toEqual([]);

    const recoveryCli = new FakeOpenShellClient();
    const recoveringBackend = createTestOpenShellBackend({
      cellLifecycle: hostCellLifecycle,
      cli: recoveryCli,
      dataRoot,
      gatewayName: 'openshell',
    });

    const reorderedIdentity = {
      transientProviderInstanceId: identity.transientProviderInstanceId,
      stagingDirectoryRef: identity.stagingDirectoryRef,
      packageSnapshotId: identity.packageSnapshotId,
      deploymentId: identity.deploymentId,
      backendTarget: identity.backendTarget,
      backendSessionId: identity.backendSessionId,
      backendKind: identity.backendKind,
      agentSessionId: identity.agentSessionId,
    };
    await expect(recoveringBackend.cleanupSession(reorderedIdentity)).resolves.toBeUndefined();
    await expect(recoveringBackend.cleanupSession(identity)).resolves.toBeUndefined();

    expect(hostCellLifecycle.recycleCalls).toEqual([
      identity.backendSessionId,
      identity.backendSessionId,
    ]);
    expect(existsSync(join(dataRoot, identity.stagingDirectoryRef))).toBe(false);
  });

  it('isolates gateway artifacts and staging cleanup between deployments', async () => {
    const cellLifecycleA = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient();
    const dataRootA = mkdtempSync(join(tmpdir(), 'openkit-openshell-deployment-a-'));
    const dataRootB = mkdtempSync(join(tmpdir(), 'openkit-openshell-deployment-b-'));
    const environmentPackage = createTrustedRelayOpenShellPackage('as_shared_lineage');
    const backendA = createTestOpenShellBackend({
      cellLifecycle: cellLifecycleA,
      cli,
      dataRoot: dataRootA,
      deploymentId: 'deployment-a',
      gatewayName: 'shared-gateway',
      workerControlGateway: new WorkerControlGateway({ createToken: () => 'token-a' }),
    });
    const backendB = createTestOpenShellBackend({
      cli,
      dataRoot: dataRootB,
      deploymentId: 'deployment-b',
      gatewayName: 'shared-gateway',
      workerControlGateway: new WorkerControlGateway({ createToken: () => 'token-b' }),
    });
    const identityA = backendA.planSession(environmentPackage);
    const identityB = backendB.planSession(environmentPackage);

    expect(identityA.backendSessionId).not.toBe(identityB.backendSessionId);
    expect(identityA.transientProviderInstanceId).not.toBe(identityB.transientProviderInstanceId);
    await backendA.materialize(environmentPackage);
    await backendB.materialize(environmentPackage);
    expect(cli.ensureProviderProfileCalls.map((call) => call.id)).toEqual([
      expect.stringMatching(/^okp-deployment-a-7a6d80f2bb6e-worker-inference-/),
      expect.stringMatching(/^okp-deployment-b-ff7fde2ae4ac-worker-inference-/),
    ]);
    expect(existsSync(join(dataRootA, identityA.stagingDirectoryRef))).toBe(true);
    expect(existsSync(join(dataRootB, identityB.stagingDirectoryRef))).toBe(true);

    await expect(backendA.cleanupSession(identityB)).rejects.toThrow(
      'does not match its deployment-owned lineage'
    );
    await backendA.cleanupSession(identityA);
    expect(cellLifecycleA.recycleCalls).toEqual([identityA.backendSessionId]);
    expect(existsSync(join(dataRootA, identityA.stagingDirectoryRef))).toBe(false);
    expect(existsSync(join(dataRootB, identityB.stagingDirectoryRef))).toBe(true);
  });

  it('shortens long OpenShell label values without changing package lineage', async () => {
    const cli = new FakeOpenShellClient();
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'token_openshell_control_1',
    });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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

  it('keeps lossy agent-session slugs collision-free in sandbox ids', () => {
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient(),
      gatewayName: 'openshell',
    });
    const base = createOpenShellPackage([]);
    const first = AgentEnvironmentPackageSchema.parse({
      ...base,
      snapshotId: 'aepsnap_collision_colon',
      scope: { ...base.scope, agentSessionId: 'as_a:b' },
    });
    const second = AgentEnvironmentPackageSchema.parse({
      ...base,
      snapshotId: 'aepsnap_collision_slash',
      scope: { ...base.scope, agentSessionId: 'as_a/b' },
    });

    expect(backend.planSession(first).backendSessionId).not.toBe(
      backend.planSession(second).backendSessionId
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
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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

  it('rejects non-transient provider attachments before provider or sandbox effects', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackageWithProviderAttachment();

    await expect(
      backend.materialize(environmentPackage, {
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
      })
    ).rejects.toThrow('does not allow non-transient provider attachments');
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('rejects attachment-only packages instead of silently dropping the provider', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const declaredPackage = createOpenShellPackageWithProviderAttachment();
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...declaredPackage,
      credentials: { declarations: [] },
    });

    await expect(backend.materialize(environmentPackage)).rejects.toThrow(
      'does not allow non-transient provider attachments'
    );
    await expect(
      backend.restoreSession(environmentPackage, backend.planSession(environmentPackage))
    ).rejects.toThrow('cannot restore a session with non-transient provider attachments');
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('uploads backend-private runtime file credentials without leaking them in materialization', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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

  it('does not accept a non-contract host Codex auth upload option', async () => {
    const cli = new FakeOpenShellClient();
    const authPath = join(mkdtempSync(join(tmpdir(), 'openkit-codex-auth-upload-')), 'auth.json');

    writeFileSync(authPath, '{"tokens":{"openai":"codex_host_secret"}}', 'utf8');

    const backendOptions = {
      cellLifecycle: new FakeOpenShellCellLifecycle(),
      cli,
      codexAuthJsonPath: authPath,
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-codex-auth-backend-')),
      deploymentId: 'local',
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    };
    const backend = new OpenShellWorkerGovernanceBackend(backendOptions);

    await backend.materialize(createOpenShellPackage(), {
      workspaceRoots: [],
    });

    const upload = cli.createSandboxCalls[0]?.uploads?.find(
      (candidate) => candidate.targetPath === '/sandbox/.codex/auth.json'
    );

    expect(upload).toBeUndefined();
    expect(JSON.stringify(cli.createSandboxCalls)).not.toContain('codex_host_secret');
  });

  it('materializes exactly the AEP network allowlist', async () => {
    const cli = new FakeOpenShellClient();
    const legacyBackendOptions = {
      cli,
      extraNetworkEndpoints: [
        {
          access: 'read-write' as const,
          binaries: ['/usr/local/bin/codex'],
          host: 'api.example.com',
          name: 'custom_direct_api',
          port: 443,
          protocol: 'rest' as const,
        },
      ],
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    };
    const backend = createTestOpenShellBackend(legacyBackendOptions);

    await backend.materialize(
      createOpenShellPackage(undefined, {
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
      { workspaceRoots: [] }
    );

    const policy = readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8');
    const endpointNames = Array.from(
      policy.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\n {4}name:/gm),
      (match) => match[1]
    );

    expect(endpointNames).toEqual(['openkit_worker_control', 'npm_registry']);
  });

  it('materializes distinct verified relay providers without direct credentials or egress', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient();
    const configDirectory = mkdtempSync(join(tmpdir(), 'openkit-relay-codex-config-'));
    const configPath = join(configDirectory, 'config.toml');
    const controlTokens = ['relay_token_one', 'relay_token_two'];

    writeFileSync(configPath, 'model_provider = "direct"\n', 'utf8');
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => controlTokens.shift() ?? 'unexpected_relay_token',
    });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      codexConfigTomlPath: configPath,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const firstPackage = createTrustedRelayOpenShellPackage('as_relay_backend_1');
    const secondPackage = createTrustedRelayOpenShellPackage('as_relay_backend_2');

    await backend.materialize(firstPackage);
    const firstProfilePath = cli.ensureProviderProfileCalls[0]?.path ?? '';
    const firstProfileText = readFileSync(firstProfilePath, 'utf8');
    const firstProfileMode = statSync(firstProfilePath).mode & 0o777;
    const firstPolicyText = readFileSync(cli.createSandboxCalls[0]?.policyPath ?? '', 'utf8');
    await backend.cleanupSession(backend.planSession(firstPackage));
    await backend.materialize(secondPackage);

    expect(cli.providersV2EnabledCalls).toEqual([
      { gateway: 'openshell' },
      { gateway: 'openshell' },
    ]);
    expect(cli.ensureProviderProfileCalls).toHaveLength(2);
    const relayProfileIds = cli.ensureProviderProfileCalls.map((call) => call.id);
    const relayProfileId = relayProfileIds[0] ?? '';

    expect(relayProfileId).toMatch(/^okp-local-25bf8e1a2393-worker-inference-[0-9a-f]{16}$/);
    expect(new Set(relayProfileIds)).toEqual(new Set([relayProfileId]));
    for (const [index, call] of cli.ensureProviderProfileCalls.entries()) {
      expect(call).toMatchObject({
        gateway: 'openshell',
        id: relayProfileId,
        path: expect.stringMatching(/worker-inference-provider-profile\.json$/),
      });
      const profile = JSON.parse(
        index === 0 ? firstProfileText : readFileSync(call.path, 'utf8')
      ) as Record<string, unknown>;
      expect(index === 0 ? firstProfileMode : statSync(call.path).mode & 0o777).toBe(0o600);

      expect(profile).toEqual({
        binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
        category: 'inference',
        credentials: [
          {
            auth_style: 'bearer',
            description: 'Package-bound scheduler lease token',
            env_vars: ['OPENKIT_WORKER_INFERENCE_TOKEN'],
            header_name: 'Authorization',
            name: 'session_token',
            query_param: '',
            required: true,
          },
        ],
        description: 'Package-bound NanoCore worker inference relay',
        display_name: 'OpenKit Worker Inference',
        endpoints: [
          {
            enforcement: 'enforce',
            host: 'nanocore.local',
            port: 443,
            protocol: 'rest',
            rules: [
              {
                allow: {
                  method: 'POST',
                  path: '/api/worker-inference/v1/chat/completions',
                },
              },
              {
                allow: {
                  method: 'POST',
                  path: '/api/worker-inference/v1/responses',
                },
              },
            ],
          },
        ],
        id: relayProfileId,
        inference_capable: false,
      });
      expect(JSON.stringify(profile)).not.toContain('access');
      expect(JSON.stringify(profile)).not.toContain('relay_token_one');
      expect(JSON.stringify(profile)).not.toContain('relay_token_two');
    }
    expect(cli.upsertProviderCalls).toEqual([
      expect.objectContaining({
        credentialKey: 'OPENKIT_WORKER_INFERENCE_TOKEN',
        credentialValue: 'relay_token_one',
        providerType: relayProfileId,
      }),
      expect.objectContaining({
        credentialKey: 'OPENKIT_WORKER_INFERENCE_TOKEN',
        credentialValue: 'relay_token_two',
        providerType: relayProfileId,
      }),
    ]);
    expect(cli.operations).toEqual([
      `profile:${relayProfileId}`,
      expect.stringMatching(/^provider:oki-local-25bf8e1a2393-worker-inference-/),
      expect.stringMatching(/^sandbox:oks-local-25bf8e1a2393-worker-/),
      `profile:${relayProfileId}`,
      expect.stringMatching(/^provider:oki-local-25bf8e1a2393-worker-inference-/),
      expect.stringMatching(/^sandbox:oks-local-25bf8e1a2393-worker-/),
    ]);
    const relayProviderNames = cli.upsertProviderCalls.map((call) => call.name);

    expect(relayProviderNames[0]).toMatch(/^oki-local-25bf8e1a2393-worker-inference-[0-9a-f]{16}$/);
    expect(relayProviderNames[1]).toMatch(/^oki-local-25bf8e1a2393-worker-inference-[0-9a-f]{16}$/);
    expect(relayProviderNames[0]).not.toBe(relayProviderNames[1]);
    expect(cli.createSandboxCalls.map((call) => call.providers)).toEqual([
      [relayProviderNames[0]],
      [relayProviderNames[1]],
    ]);
    expect(cli.createSandboxCalls[0]?.env).not.toHaveProperty('OPENKIT_WORKER_INFERENCE_TOKEN');
    const uploadTargets = cli.createSandboxCalls[0]?.uploads?.map((upload) => upload.targetPath);

    expect(uploadTargets).not.toContain('/sandbox/.codex/auth.json');
    expect(uploadTargets).not.toContain('/sandbox/.codex/config.toml');
    const policy = firstPolicyText;

    expect(policy).not.toContain('openkit_worker_inference');
    expect(policy).not.toContain('chatgpt.com');
    expect(policy).not.toContain('mcp.deepwiki.com');
    expect(policy).not.toContain('api.example.com');
    expect(policy).not.toContain('relay_token_one');

    await backend.cleanupSession(backend.planSession(secondPackage));

    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(firstPackage).backendSessionId,
      backend.planSession(secondPackage).backendSessionId,
    ]);
    expect(workerControlGateway.getSessionSnapshot(firstPackage.snapshotId)).toBeNull();
    expect(workerControlGateway.getSessionSnapshot(secondPackage.snapshotId)).toBeNull();
  });

  it('fails before control registration when immutable relay profile setup fails', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const profileFailure = new Error('profile collision');
    const cli = new FakeOpenShellClient({ ensureProviderProfileFailure: profileFailure });
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'relay_profile_failure_token',
    });
    const registerSession = vi.spyOn(workerControlGateway, 'registerSession');
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_profile_failure_1');

    await expect(backend.materialize(environmentPackage)).rejects.toBe(profileFailure);
    expect(cli.ensureProviderProfileCalls).toHaveLength(1);
    expect(existsSync(dirname(cli.ensureProviderProfileCalls[0]?.path ?? ''))).toBe(false);
    expect(registerSession).not.toHaveBeenCalled();
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
  });

  it('rejects backend-private direct credentials for verified relay packages', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_direct_credential_token',
      }),
    });

    const directCredentialContexts: WorkerGovernanceMaterializationContext[] = [
      {
        providerCredentials: [
          {
            credentialKey: 'OPENAI_API_KEY',
            credentialValue: 'direct_provider_secret',
            providerInstanceId: 'direct-provider',
            providerType: 'generic',
          },
        ],
        workspaceRoots: [],
      },
      {
        runtimeEnvCredentials: [
          { credentialValue: 'direct_env_secret', targetEnvVarName: 'OPENAI_API_KEY' },
        ],
        workspaceRoots: [],
      },
      {
        runtimeFileCredentials: [
          {
            credentialValue: 'direct_file_secret',
            targetPath: '/sandbox/.codex/auth.json',
          },
        ],
        workspaceRoots: [],
      },
    ];

    for (const [index, context] of directCredentialContexts.entries()) {
      await expect(
        backend.materialize(
          createTrustedRelayOpenShellPackage(`as_relay_direct_credential_${index + 1}`),
          context
        )
      ).rejects.toThrow(
        context.providerCredentials
          ? 'does not allow non-transient provider attachments'
          : 'does not allow backend-private direct credentials'
      );
    }
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('returns cleanup ownership after bounded sandbox creation times out', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient({
      createSandboxFailure: new Error('OpenShell command timed out after 120000ms.'),
    });
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'relay_create_failure_token',
    });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_create_failure_1');

    await expect(backend.materialize(environmentPackage)).rejects.toThrow(
      'timed out after 120000ms'
    );
    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
    expect(workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)).toBeNull();
  });

  it('preserves creation and cleanup failures while revoking the relay session', async () => {
    const createFailure = new Error('sandbox create failed');
    const recycleFailure = new Error('Cell recycle failed');
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    cellLifecycle.recycleFailure = recycleFailure;
    const cli = new FakeOpenShellClient({ createSandboxFailure: createFailure });
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'relay_failed_cleanup_token',
    });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_failed_cleanup_1');
    const error = await backend.materialize(environmentPackage).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([createFailure, recycleFailure]);
    expect(workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)).toBeNull();
  });

  it('revokes teardown tokens, attempts every cleanup, and permits cleanup retry', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    cellLifecycle.recycleFailure = new Error('Cell recycle failed');
    const cli = new FakeOpenShellClient();
    const workerControlGateway = new WorkerControlGateway({
      createToken: () => 'relay_teardown_failure_token',
    });
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway,
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_teardown_failure_1');
    const identity = backend.planSession(environmentPackage);

    await backend.materialize(environmentPackage);
    await expect(backend.cleanupSession(identity)).rejects.toThrow(
      'durable session cleanup failed'
    );
    expect(workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)).toBeNull();
    expect(cellLifecycle.recycleCalls).toEqual([identity.backendSessionId]);

    cellLifecycle.recycleFailure = null;
    await expect(backend.cleanupSession(identity)).resolves.toBeUndefined();
    expect(cellLifecycle.recycleCalls).toEqual([
      identity.backendSessionId,
      identity.backendSessionId,
    ]);
  });

  it('rejects duplicate active relay materialization before rotating its provider', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_duplicate_token',
      }),
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_duplicate_1');

    await backend.materialize(environmentPackage);
    await expect(backend.materialize(environmentPackage)).rejects.toThrow('already materialized');
    expect(cli.upsertProviderCalls).toHaveLength(1);
    expect(cli.createSandboxCalls).toHaveLength(1);
  });

  it('rejects concurrent materialization of the same relay package', async () => {
    let releaseCreate: (() => void) | null = null;
    const createSandboxGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const cli = new FakeOpenShellClient({ createSandboxGate });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_concurrent_token',
      }),
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_concurrent_1');
    const firstMaterialization = backend.materialize(environmentPackage);

    await vi.waitFor(() => expect(cli.createSandboxCalls).toHaveLength(1));
    const secondMaterialization = backend.materialize(environmentPackage);
    const secondExpectation = expect(secondMaterialization).rejects.toThrow('already materialized');

    releaseCreate?.();
    await firstMaterialization;
    await secondExpectation;

    expect(cli.upsertProviderCalls).toHaveLength(1);
    expect(cli.createSandboxCalls).toHaveLength(1);
  });

  it('rejects an incompatible gateway before verified relay materialization', async () => {
    const cli = new FakeOpenShellClient({ gatewayVersion: '0.0.63' });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_gateway_version_token',
      }),
    });

    await expect(
      backend.materialize(createTrustedRelayOpenShellPackage('as_relay_gateway_version_1'))
    ).rejects.toThrow('requires exactly 0.0.80');
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it.each([
    {
      caseName: 'disabled',
      providersV2Enabled: false,
      providersV2EnabledFailure: undefined,
    },
    {
      caseName: 'unset',
      providersV2Enabled: null,
      providersV2EnabledFailure: undefined,
    },
    {
      caseName: 'malformed',
      providersV2Enabled: true,
      providersV2EnabledFailure: new Error('OpenShell global settings are malformed.'),
    },
  ])('rejects a verified relay when providers v2 is $caseName before runtime side effects', async ({
    providersV2Enabled,
    providersV2EnabledFailure,
  }) => {
    const cli = new FakeOpenShellClient({
      providersV2Enabled,
      ...(providersV2EnabledFailure ? { providersV2EnabledFailure } : {}),
    });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_provider_v2_preflight_token',
      }),
    });

    await expect(
      backend.materialize(createTrustedRelayOpenShellPackage('as_relay_provider_v2_preflight_1'))
    ).rejects.toThrow(/global settings|providers[_ ]v2/i);
    expect(cli.providersV2EnabledCalls).toEqual([{ gateway: 'openshell' }]);
    expect(cli.ensureProviderProfileCalls).toEqual([]);
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('rejects a verified relay when the target gateway version is unavailable', async () => {
    const cli = new FakeOpenShellClient({ gatewayVersion: null });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_missing_gateway_version_token',
      }),
    });

    await expect(
      backend.materialize(createTrustedRelayOpenShellPackage('as_relay_missing_version_1'))
    ).rejects.toThrow('requires an OpenShell gateway version');
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('rejects a verified relay without worker-control token registration', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
    });

    await expect(
      backend.materialize(createTrustedRelayOpenShellPackage('as_relay_missing_control_1'))
    ).rejects.toThrow('worker control gateway is required');
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('does not clean up a relay provider before token registration permits its upsert', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'unused_relay_token',
      }),
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_auth_none_1');
    const packageWithoutTokenAuth = {
      ...environmentPackage,
      control: {
        ...environmentPackage.control,
        auth: { credentialVisibility: 'none', kind: 'none' },
      },
    } as AgentEnvironmentPackage;

    await expect(backend.materialize(packageWithoutTokenAuth)).rejects.toThrow(
      'requires a worker control registration token'
    );
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('rejects non-canonical relay network rules at the backend boundary', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_network_bypass_token',
      }),
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_network_bypass_1');
    const bypassPackage = {
      ...environmentPackage,
      policy: {
        ...environmentPackage.policy,
        network: {
          ...environmentPackage.policy.network,
          rules: [
            ...(environmentPackage.policy.network?.rules ?? []),
            {
              access: 'read-write',
              action: 'allow',
              binaries: ['/usr/local/bin/codex'],
              host: 'control.local',
              id: 'codex-control-bypass',
              port: 3000,
              protocol: 'rest',
            },
          ],
        },
      },
    } as AgentEnvironmentPackage;

    await expect(backend.materialize(bypassPackage)).rejects.toThrow(
      'non-canonical trusted relay network rule'
    );
    expect(cli.upsertProviderCalls).toEqual([]);
    expect(cli.createSandboxCalls).toEqual([]);
  });

  it('adds user-declared sandbox network and filesystem grants to generated OpenShell policies', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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

    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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

  it('collects transient relay provider evidence without its credential value', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_evidence_token',
      }),
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_evidence_1');
    const providerInstanceId = backend.planSession(environmentPackage).transientProviderInstanceId;

    if (!providerInstanceId) {
      throw new Error('Trusted relay test fixture requires a transient provider.');
    }
    vi.spyOn(cli, 'getProvider').mockResolvedValue({
      name: providerInstanceId,
      stdout: `Provider\n\n  Name: ${providerInstanceId}\n  Credential: relay_evidence_token\n`,
    });
    await backend.materialize(environmentPackage);

    const evidence = await backend.collectEvidence(environmentPackage.snapshotId);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            packageSnapshotId: environmentPackage.snapshotId,
            provider: expect.objectContaining({
              preview: expect.stringContaining(providerInstanceId),
            }),
            providerInstanceId,
            sandboxName: expectedOpenShellSandboxName(environmentPackage.scope.agentSessionId),
          }),
          kind: 'openshell.provider.attached',
        }),
      ])
    );
    expect(cli.getProvider).toHaveBeenCalledWith({
      gateway: 'openshell',
      name: providerInstanceId,
    });
    expect(JSON.stringify(evidence)).not.toContain('relay_evidence_token');
  });

  it('polls provider refresh status for active materialized sessions', async () => {
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'relay_refresh_token',
      }),
    });
    const environmentPackage = createTrustedRelayOpenShellPackage('as_relay_refresh_1');
    const providerInstanceId = backend.planSession(environmentPackage).transientProviderInstanceId;

    if (!providerInstanceId) {
      throw new Error('Trusted relay test fixture requires a transient provider.');
    }
    vi.spyOn(cli, 'getProviderRefreshStatus').mockResolvedValue({
      name: providerInstanceId,
      stdout: `Refresh Status\n\n  Provider: ${providerInstanceId}\n  Credential: relay_refresh_token\n`,
    });
    await backend.materialize(environmentPackage);

    const evidence = await backend.collectProviderRefreshStatuses();

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            packageSnapshotId: environmentPackage.snapshotId,
            providerInstanceId,
            refreshStatus: expect.objectContaining({
              preview: expect.stringContaining(providerInstanceId),
            }),
          }),
          kind: 'openshell.provider.refresh_status',
        }),
      ])
    );
    expect(cli.getProviderRefreshStatus).toHaveBeenCalledWith({
      gateway: 'openshell',
      name: providerInstanceId,
    });
    expect(JSON.stringify(evidence)).not.toContain('relay_refresh_token');
  });

  it('rejects direct OpenShell gateway URLs containing credentials or path state', () => {
    expect(() =>
      createTestOpenShellBackend({
        cli: new FakeOpenShellClient(),
        gatewayName: 'a1-openshell',
        gatewayUrl: 'https://user:secret@a1.example.com:17670/private?token=raw#frag',
      })
    ).toThrow('credential-free HTTP(S) origin');
  });

  it('fails closed when the configured gateway URL does not match the active gateway endpoint', async () => {
    const backend = createTestOpenShellBackend({
      cli: new FakeOpenShellClient({ endpoint: 'https://other.example.com:17670' }),
      gatewayName: 'a1-openshell',
      gatewayUrl: 'https://a1.example.com:17670',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await expect(backend.materialize(createOpenShellPackage())).rejects.toThrow(
      'OpenShell preflight failed: configured gateway URL does not match active OpenShell gateway endpoint.'
    );
  });

  it('accepts a remote Gateway reached through a differently addressed operator tunnel', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli: new FakeOpenShellClient({ endpoint: 'http://127.0.0.1:17670' }),
      gatewayName: 'a1-openshell',
      gatewayUrl: 'http://127.0.0.1:27670',
      placement: 'remote',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_remote_tunnel',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    await expect(backend.materialize(environmentPackage)).resolves.toMatchObject({
      backendStatus: { health: 'ready' },
    });
    await backend.cleanupSession(backend.planSession(environmentPackage));
    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
  });

  it('uploads backend-private workspace bundles and extracts them before worker startup', async () => {
    const cli = new FakeOpenShellClient();
    const sourcePath = createGitWorkspace('openkit-openshell-workspace-source-');
    const readonlySourcePath = mkdtempSync(join(tmpdir(), 'openkit-openshell-readonly-source-'));
    writeFileSync(join(readonlySourcePath, 'notes.md'), '# Notes\n', 'utf8');
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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
      'openkit-codex-shim',
      '--package',
      '/openkit/config/package.json',
      '--dry-run',
    ]);
    await backend.launch(materialization);
    expect(cli.execSandboxCalls[0]?.command.slice(4)).toEqual([
      'bash',
      '-lc',
      expect.stringContaining(
        "tar -xf '/openkit/config/workspaces/repo.tar' -C '/workspace/openkit/worktrees/main'"
      ),
    ]);
    expect(cli.execSandboxCalls[0]?.command.slice(4)).toEqual([
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
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const workspaceRoots: MaterializedWorkspaceRoot[] = [
      {
        access: 'read-write',
        id: 'repo',
        sourceKind: 'host-dir',
        sourcePath: createGitWorkspace('openkit-openshell-materialized-repo-'),
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
      'openkit-codex-shim',
      '--package',
      '/openkit/config/package.json',
      '--dry-run',
    ]);
    await backend.launch(materialization);
    expect(cli.execSandboxCalls[0]?.command.slice(4)).toEqual([
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

    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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
    const backend = createTestOpenShellBackend({
      cli,
      codexConfigTomlPath: '/home/ubuntu/.codex/config.toml',
      gatewayName: 'openshell',
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
            requestId: environmentPackage.scope.requestId,
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
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
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
    expect(Object.keys(transcript).sort()).toEqual(['artifactsJsonl', 'eventsJsonl', 'itemsJsonl']);
    expect(transcript).not.toHaveProperty('runtimeProvenance');
    const acceptedLiveEvents = (transcript.eventsJsonl ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => WorkerCanonicalEventRecordSchema.parse(JSON.parse(line)));
    const importResult = importWorkerTranscript(importStore, environmentPackage, transcript, {
      acceptedLiveEvents,
    });

    expect(importResult).toMatchObject({
      itemIds: [expect.stringMatching(/^it_worker_/), 'it_artifact_ar_worker_tu_1_3'],
      artifactIds: [expect.stringMatching(/^ar_worker_/)],
      diagnostics: [],
    });
  });

  it('treats a stock OpenShell missing optional transcript file as absent', async () => {
    const environmentPackage = createOpenShellPackage();
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);
    const downloadFile = cli.downloadFile.bind(cli);
    vi.spyOn(cli, 'downloadFile').mockImplementation(async (input) => {
      if (input.sandboxPath === '/sandbox/openkit/session/artifacts.jsonl') {
        throw new Error(
          "OpenShell sandbox download failed: realpath: /sandbox/openkit/session/artifacts.jsonl: No such file or directory\nfailed to resolve sandbox source path '/sandbox/openkit/session/artifacts.jsonl'\nssh probe exited with status exit status: 1"
        );
      }
      return downloadFile(input);
    });

    await expect(backend.collectTranscript(environmentPackage.snapshotId)).resolves.toMatchObject({
      artifactsJsonl: '',
    });
  });

  it.each([
    ['gateway transport', 'OpenShell sandbox download failed: connection refused'],
    ['sandbox permission', 'OpenShell sandbox download failed: permission denied'],
    ['download timeout', 'OpenShell command timed out after 120000ms.'],
    ['sandbox unavailable', 'OpenShell sandbox download failed: sandbox not found'],
    [
      'conflicting missing source',
      "OpenShell sandbox download failed: realpath: /sandbox/openkit/session/artifacts.jsonl: No such file or directory\nfailed to resolve sandbox source path '/sandbox/openkit/session/artifacts.jsonl'\nssh probe exited with status exit status: 1",
    ],
  ] as const)('propagates %s failures while collecting optional sandbox files', async (_label, message) => {
    const environmentPackage = createOpenShellPackage();
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);
    vi.spyOn(cli, 'downloadFile').mockRejectedValueOnce(new Error(message));

    const error = await backend
      .collectWorkspaceChanges(environmentPackage.snapshotId)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });

  it('reports an exact missing required runtime provenance file', async () => {
    const environmentPackage = createTrustedRelayOpenShellPackage('as_runtime_provenance_missing');
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);
    enableRuntimeProvenanceCollection(environmentPackage);
    const downloadFile = cli.downloadFile.bind(cli);
    vi.spyOn(cli, 'downloadFile').mockImplementation(async (input) => {
      if (input.sandboxPath === '/sandbox/openkit/session/runtime/raw-streams.json') {
        throw new Error(
          "OpenShell sandbox download failed: realpath: /sandbox/openkit/session/runtime/raw-streams.json: No such file or directory\nfailed to resolve sandbox source path '/sandbox/openkit/session/runtime/raw-streams.json'\nssh probe exited with status exit status: 1"
        );
      }
      return downloadFile(input);
    });

    await expect(backend.collectTranscript(environmentPackage.snapshotId)).resolves.toMatchObject({
      runtimeProvenance: {
        diagnostics: [
          {
            code: 'runtime_provenance_file_missing',
            message: 'A required runtime provenance file could not be collected.',
            path: '/openkit/session/runtime/raw-streams.json',
          },
        ],
        manifestPath: null,
        missingPaths: ['/openkit/session/runtime/raw-streams.json'],
        nativeOriginIndexPath: null,
        rawStreamPaths: {},
      },
    });
  });

  it.each([
    ['gateway transport', 'OpenShell sandbox download failed: connection refused'],
    ['gateway authentication', 'OpenShell sandbox download failed: authentication failed'],
    ['download timeout', 'OpenShell command timed out after 120000ms.'],
    ['sandbox unreachable', 'OpenShell sandbox download failed: sandbox not found'],
  ])('propagates %s failures while collecting runtime provenance', async (_label, message) => {
    const environmentPackage = createTrustedRelayOpenShellPackage(
      'as_runtime_provenance_download_failure'
    );
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);
    enableRuntimeProvenanceCollection(environmentPackage);
    const downloadFile = cli.downloadFile.bind(cli);
    vi.spyOn(cli, 'downloadFile').mockImplementation(async (input) => {
      if (input.sandboxPath === '/sandbox/openkit/session/runtime/raw-streams.json') {
        throw new Error(message);
      }
      return downloadFile(input);
    });

    await expect(backend.collectTranscript(environmentPackage.snapshotId)).rejects.toThrow(message);
    expect(cellLifecycle.recycleCalls).toEqual([]);
  });

  it('collects declared runtime provenance as bounded session-owned files without raw payload text', async () => {
    const environmentPackage = createTrustedRelayOpenShellPackage('as_runtime_provenance_collect');
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const rawCanary = 'runtime-raw-canary-'.repeat(65_536);
    const manifest = JSON.stringify({
      adapterVersion: '0.144.1',
      captureStatus: 'complete',
      lineage,
      primaryStreamRef: 'stream-0000.jsonl',
      runtimeFamily: 'codex',
      schemaVersion: 1,
      streams: [
        {
          bytes: rawCanary.length,
          captureStatus: 'complete',
          frameCount: 1,
          sha256: `sha256:${'a'.repeat(64)}`,
          sourceKind: 'primary',
          stableTerminal: true,
          streamRef: 'stream-0000.jsonl',
        },
        {
          bytes: 3,
          captureStatus: 'complete',
          frameCount: 1,
          sha256: `sha256:${'b'.repeat(64)}`,
          sourceKind: 'runtime-thread',
          stableTerminal: true,
          streamRef: 'stream-0001.jsonl',
        },
      ],
    });
    const cli = new FakeOpenShellClient({
      downloads: {
        '/sandbox/openkit/session/runtime/native-origin-index.jsonl':
          '{"streamRef":"stream-0000.jsonl","nativeThreadId":"native-thread-canary"}\n',
        '/sandbox/openkit/session/runtime/raw-streams.json': manifest,
        '/sandbox/openkit/session/runtime/raw/stream-0000.jsonl': rawCanary,
        '/sandbox/openkit/session/runtime/raw/stream-0001.jsonl': '{}\n',
      },
    });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);
    enableRuntimeProvenanceCollection(environmentPackage);
    const transcript = (await backend.collectTranscript(
      environmentPackage.snapshotId
    )) as unknown as {
      runtimeProvenance?: {
        diagnostics: Array<{ code: string; message: string; path: string }>;
        manifestPath: string;
        missingPaths: string[];
        nativeOriginIndexPath: string;
        rawStreamPaths: Record<string, string>;
      };
    };
    const runtimeProvenance = transcript.runtimeProvenance;

    expect(runtimeProvenance).toEqual({
      diagnostics: [],
      manifestPath: expect.any(String),
      missingPaths: [],
      nativeOriginIndexPath: expect.any(String),
      rawStreamPaths: {
        'stream-0000.jsonl': expect.any(String),
        'stream-0001.jsonl': expect.any(String),
      },
    });
    const sessionDirectory = dirname(cli.createSandboxCalls[0]?.uploads?.[0]?.sourcePath ?? '');
    const collectedPaths = [
      runtimeProvenance?.manifestPath,
      runtimeProvenance?.nativeOriginIndexPath,
      ...Object.values(runtimeProvenance?.rawStreamPaths ?? {}),
    ];
    expect(collectedPaths.every((path) => path?.startsWith(sessionDirectory))).toBe(true);
    expect(readFileSync(runtimeProvenance?.manifestPath ?? '', 'utf8')).toBe(manifest);
    expect(readFileSync(runtimeProvenance?.rawStreamPaths['stream-0000.jsonl'] ?? '', 'utf8')).toBe(
      rawCanary
    );
    expect(JSON.stringify(transcript)).not.toContain(rawCanary);
    expect(JSON.stringify(transcript)).not.toContain('native-thread-canary');
    expect(cli.downloadFileCalls.map((call) => call.sandboxPath)).toEqual(
      expect.arrayContaining([
        '/sandbox/openkit/session/runtime/raw-streams.json',
        '/sandbox/openkit/session/runtime/raw/stream-0000.jsonl',
        '/sandbox/openkit/session/runtime/raw/stream-0001.jsonl',
        '/sandbox/openkit/session/runtime/native-origin-index.jsonl',
      ])
    );
  });

  it('rejects an oversized runtime provenance manifest before parsing or collecting its files', async () => {
    const environmentPackage = createTrustedRelayOpenShellPackage(
      'as_runtime_provenance_manifest_limit'
    );
    const cli = new FakeOpenShellClient({
      downloads: {
        '/sandbox/openkit/session/runtime/raw-streams.json': ' '.repeat(1024 * 1024 + 1),
      },
    });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);
    enableRuntimeProvenanceCollection(environmentPackage);
    const transcript = await backend.collectTranscript(environmentPackage.snapshotId);

    expect(transcript.runtimeProvenance).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'runtime_provenance_manifest_size_exceeded' })],
      nativeOriginIndexPath: null,
      rawStreamPaths: {},
    });
    expect(
      cli.downloadFileCalls
        .map((call) => call.sandboxPath)
        .filter((path) => path.includes('/runtime/'))
    ).toEqual(['/sandbox/openkit/session/runtime/raw-streams.json']);
  });

  it('downloads worker-session patch payloads referenced by workspace change manifests', async () => {
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellPackage(),
      snapshotId: 'pkg_workspace_patch',
    });
    const patchText = [
      'diff --git a/docs/report.md b/docs/report.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/report.md',
      '@@ -0,0 +1,3 @@',
      '+- Root finding',
      '+- First child finding',
      '+- Second child finding',
      '',
    ].join('\n');
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
          patch: {
            bytes: Buffer.byteLength(patchText, 'utf8'),
            digest: 'sha256:patch',
            ref: 'worker-session://workspace.patch',
          },
          redaction: { notes: [], status: 'redacted' },
          resourceId: 'repo',
          strategy: 'git',
          workspaceId: environmentPackage.scope.workspaceId,
        }),
        '/sandbox/openkit/session/workspace.patch': patchText,
      },
    });
    const backend = createTestOpenShellBackend({
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });

    await backend.materialize(environmentPackage);

    await expect(backend.collectWorkspaceChanges(environmentPackage.snapshotId)).resolves.toEqual([
      expect.objectContaining({
        changeSet: expect.objectContaining({ id: 'wcs_patch' }),
        patchPayload: {
          bytes: Buffer.byteLength(patchText, 'utf8'),
          digest: 'sha256:patch',
          mediaType: 'text/x-diff',
          text: patchText,
        },
        review: expect.objectContaining({
          diffSummary: { additions: 3, deletions: 0, filesChanged: 1 },
        }),
      }),
    ]);
    expect(cli.downloadFileCalls.map((call) => call.sandboxPath)).toEqual(
      expect.arrayContaining([
        '/sandbox/openkit/session/workspace-changes.json',
        '/sandbox/openkit/session/workspace.patch',
      ])
    );
  });

  it('recycles the OpenShell Cell after collection', async () => {
    const cellLifecycle = new FakeOpenShellCellLifecycle();
    const cli = new FakeOpenShellClient();
    const backend = createTestOpenShellBackend({
      cellLifecycle,
      cli,
      gatewayName: 'openshell',
      workerControlGateway: new WorkerControlGateway({
        createToken: () => 'token_openshell_control_1',
      }),
    });
    const environmentPackage = createOpenShellPackage();

    await backend.materialize(environmentPackage);
    expect(cli.createSandboxCalls[0]?.noKeep).toBe(false);

    await expect(
      backend.cleanupSession(backend.planSession(environmentPackage))
    ).resolves.toBeUndefined();
    expect(cellLifecycle.recycleCalls).toEqual([
      backend.planSession(environmentPackage).backendSessionId,
    ]);
  });
});

class FakeOpenShellClient implements OpenShellWorkerGovernanceClient {
  public readonly operations: string[] = [];
  /** Gateway targets inspected for the global providers v2 preflight. */
  public readonly providersV2EnabledCalls: Array<{
    gateway?: string;
    gatewayEndpoint?: string;
  }> = [];
  public readonly createSandboxCalls: Parameters<
    OpenShellWorkerGovernanceClient['createSandbox']
  >[0][] = [];
  public readonly execSandboxCalls: OpenShellSandboxExecInput[] = [];
  public readonly downloadFileCalls: Parameters<
    OpenShellWorkerGovernanceClient['downloadFile']
  >[0][] = [];
  public readonly gatewayInfoCalls: Array<{ gateway?: string }> = [];
  public readonly statusCalls: Array<{
    gateway?: string;
    gatewayEndpoint?: string;
  }> = [];
  public readonly getProviderCalls: Array<{ gateway?: string; name: string }> = [];
  public readonly getProviderRefreshStatusCalls: Array<{ gateway?: string; name: string }> = [];
  public readonly upsertProviderCalls: Parameters<
    OpenShellWorkerGovernanceClient['upsertProvider']
  >[0][] = [];
  public readonly ensureProviderProfileCalls: Parameters<
    OpenShellWorkerGovernanceClient['ensureProviderProfile']
  >[0][] = [];
  private readonly createSandboxGate: Promise<void> | null;
  private readonly createSandboxFailure: Error | null;
  private readonly downloads: Record<string, string>;
  private readonly endpoint: string;
  private readonly ensureProviderProfileFailure: Error | null;
  private readonly execSandboxGate: Promise<void> | null;
  private readonly gatewayVersion: string | null;
  private readonly providersV2EnabledFailure: Error | null;
  private readonly providersV2EnabledValue: boolean | null;
  private readonly openShellVersion: string;

  public constructor(
    options: {
      createSandboxGate?: Promise<void>;
      createSandboxFailure?: Error;
      downloads?: Record<string, string>;
      endpoint?: string;
      ensureProviderProfileFailure?: Error;
      execSandboxGate?: Promise<void>;
      gatewayVersion?: string | null;
      /** Error raised while reading the global providers v2 setting. */
      providersV2EnabledFailure?: Error;
      /** Parsed global providers v2 setting, where null means unset. */
      providersV2Enabled?: boolean | null;
      version?: string;
    } = {}
  ) {
    this.createSandboxGate = options.createSandboxGate ?? null;
    this.createSandboxFailure = options.createSandboxFailure ?? null;
    this.downloads = options.downloads ?? {};
    this.endpoint = options.endpoint ?? 'https://127.0.0.1:17670';
    this.ensureProviderProfileFailure = options.ensureProviderProfileFailure ?? null;
    this.execSandboxGate = options.execSandboxGate ?? null;
    this.gatewayVersion =
      options.gatewayVersion === null
        ? null
        : (options.gatewayVersion ?? options.version ?? '0.0.80');
    this.providersV2EnabledFailure = options.providersV2EnabledFailure ?? null;
    this.providersV2EnabledValue =
      options.providersV2Enabled === undefined ? true : options.providersV2Enabled;
    this.openShellVersion = options.version ?? '0.0.80';
  }

  public async version(): Promise<string> {
    return this.openShellVersion;
  }

  public async status(
    input: { gateway?: string; gatewayEndpoint?: string } = {}
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['status']>>> {
    this.statusCalls.push(input);
    return {
      gateway: 'openshell',
      server: this.endpoint,
      status: 'connected',
      version: this.gatewayVersion,
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

  /**
   * Reads the configured global providers v2 state for backend preflight tests.
   *
   * @param input Gateway target selected by the backend.
   * @returns True, false, or null when the setting is unset.
   */
  public async providersV2Enabled(
    input: { gateway?: string; gatewayEndpoint?: string } = {}
  ): Promise<boolean | null> {
    this.providersV2EnabledCalls.push(input);
    if (this.providersV2EnabledFailure) {
      throw this.providersV2EnabledFailure;
    }
    return this.providersV2EnabledValue;
  }

  public async createSandbox(
    input: Parameters<OpenShellWorkerGovernanceClient['createSandbox']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['createSandbox']>>> {
    this.createSandboxCalls.push(input);
    this.operations.push(`sandbox:${input.name}`);
    await this.createSandboxGate;

    if (this.createSandboxFailure) {
      throw this.createSandboxFailure;
    }

    return {
      name: input.name,
      stdout: 'sandbox created',
    };
  }

  public async execSandbox(input: OpenShellSandboxExecInput) {
    this.execSandboxCalls.push(input);
    await this.execSandboxGate;
    return { exitCode: 0, stderr: '', stdout: 'worker completed' };
  }

  public async upsertProvider(
    input: Parameters<OpenShellWorkerGovernanceClient['upsertProvider']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['upsertProvider']>>> {
    this.upsertProviderCalls.push(input);
    this.operations.push(`provider:${input.name}`);

    return { name: input.name };
  }

  public async ensureProviderProfile(
    input: Parameters<OpenShellWorkerGovernanceClient['ensureProviderProfile']>[0]
  ): Promise<Awaited<ReturnType<OpenShellWorkerGovernanceClient['ensureProviderProfile']>>> {
    this.ensureProviderProfileCalls.push(input);
    this.operations.push(`profile:${input.id}`);
    if (this.ensureProviderProfileFailure) {
      throw this.ensureProviderProfileFailure;
    }

    return { id: input.id };
  }

  public async getProvider(input: {
    gateway?: string;
    name: string;
  }): Promise<{ name: string; stdout: string }> {
    this.getProviderCalls.push(input);

    return {
      name: input.name,
      stdout: `Provider\n\n  Name: ${input.name}\n`,
    };
  }

  public async getProviderRefreshStatus(input: {
    gateway?: string;
    name: string;
  }): Promise<{ name: string; stdout: string }> {
    this.getProviderRefreshStatusCalls.push(input);

    return {
      name: input.name,
      stdout: `Refresh Status\n\n  Provider: ${input.name}\n`,
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
}

/**
 * Creates one temporary Git workspace with a valid immutable HEAD.
 *
 * @param prefix Temporary-directory prefix.
 * @returns Repository root path.
 */
function createGitWorkspace(prefix: string): string {
  const repositoryPath = mkdtempSync(join(tmpdir(), prefix));

  execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
    cwd: repositoryPath,
  });
  execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
  writeFileSync(join(repositoryPath, 'README.md'), '# Workspace\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
  execFileSync('git', ['commit', '-m', 'initial'], {
    cwd: repositoryPath,
    stdio: 'ignore',
  });

  return repositoryPath;
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
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
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
 * Enables runtime-provenance collection after materialization.
 *
 * @param environmentPackage Materialized trusted-relay package retained by the backend fixture.
 */
function enableRuntimeProvenanceCollection(environmentPackage: AgentEnvironmentPackage): void {
  environmentPackage.backend.requiredCapabilities.push('worker.runtime-provenance.v1');
  if (!environmentPackage.control.transcript) {
    throw new Error('Runtime provenance test fixture requires a transcript declaration.');
  }
  environmentPackage.control.transcript.runtimeProvenance = {
    maxStreamCount: 64,
    maxTotalBytes: 256 * 1024 * 1024,
    nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
    rawStreamsRoot: '/openkit/session/runtime/raw',
    streamManifestPath: '/openkit/session/runtime/raw-streams.json',
  };
}

/**
 * Creates one relay-required OpenShell package with immutable provider selection.
 *
 * @param agentSessionId Agent session id used to derive unique package lineage.
 * @returns Relay-required OpenShell package fixture.
 */
function createTrustedRelayOpenShellPackage(agentSessionId: string): AgentEnvironmentPackage {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Materialize trusted inference relay');
  const agent = store.getAgent('ws_demo', 'agent_codex_host');

  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent,
      agentSessionId,
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      backendRequirements: {
        allowedKinds: ['openshell'],
        preferred: 'openshell',
        requiredCapabilities: ['trusted-worker-inference-relay'],
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      providerSelection: {
        model: 'openai/gpt-5.2',
        providerId: 'agent-openrouter',
      },
      requestId: `req_${agentSessionId}`,
      turn,
      userId: 'user_local',
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
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
    credentials: {
      declarations: [
        {
          id: 'github_mcp_read',
          provider: {
            credentialKey: 'GITHUB_TOKEN',
            instanceId: 'provider_github_read',
            profileId: 'github_mcp',
            type: 'github_mcp',
          },
          vaultGrantId: 'grant_github_read',
          visibility: 'sandbox-provider',
        },
      ],
    },
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
