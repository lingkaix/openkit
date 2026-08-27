import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

import { SimulatedTurnExecutor } from '../lib/simulator.js';
import {
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  dispatchNanoHostHarnessOperation,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './turn-executor-factory.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceBackendSessionIdentity,
} from './worker-governance-backend.js';

/** Creates the durable deployment identity required by real executor construction. */
function createFactoryCoreDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-executor-factory-'));
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

const factoryCoreDb = createFactoryCoreDb();

/** Completes the compatibility inputs omitted by narrow backend test fixtures. */
function completeNanoHostPackage(input: {
  readonly [key: string]: unknown;
  readonly scope: Record<string, unknown>;
  readonly snapshotId: string;
  readonly workspace?: Record<string, unknown>;
}): AgentEnvironmentPackage {
  return {
    agent: { runtimeKind: 'codex' },
    backend: {},
    capabilities: {},
    control: {},
    credentials: {},
    llm: {},
    policy: {},
    providers: {},
    resources: {},
    runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
    schemaVersion: 3,
    supply: { services: [] },
    vault: {},
    ...input,
    scope: {
      triggerActor: { kind: 'user', id: 'user-factory' },
      ...input.scope,
    },
    workspace: {
      generatedFiles: [],
      inputs: [],
      outputs: [],
      root: '/workspace',
      ...input.workspace,
    },
  } as AgentEnvironmentPackage;
}

describe('createConfiguredTurnExecutor', () => {
  it('exposes NanoHost as the sole production runtime selector', () => {
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });

    expect((runtime as unknown as { runtimeTargetKind?: string }).runtimeTargetKind).toBe(
      'nanohost'
    );
    expect(runtime).not.toHaveProperty('placement');
    expect(runtime.turnExecutor).not.toHaveProperty('environmentBackend');
  });

  it('projects OpenShell version 0.0.99 from the NanoHost backend capability observation', async () => {
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: {
          describeCapabilities(): Promise<{
            readonly kind: string;
            readonly version?: string | null;
          }>;
        };
      }
    ).backend;

    await expect(backend.describeCapabilities()).resolves.toMatchObject({
      kind: 'openshell',
      version: '0.0.99',
    });
  });

  it('keeps NanoHost session construction on the configured runtime target', () => {
    const source = readFileSync(new URL('./turn-executor-factory.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('upsertNanoHostRuntimeTarget(');
    expect(source).not.toContain('allocateNanoHostRuntimeTargetConnectionGeneration(');
    const backendSource = source
      .split('class NanoHostWorkerGovernanceBackend')[1]
      ?.split('function sessionMatchesRuntimeImage')[0];
    expect(backendSource).toBeDefined();
    expect(backendSource).not.toContain('throw nanoHostSessionUnavailable()');
    const materializeSource = backendSource
      ?.split('public async materialize(')[1]
      ?.split('/** Opens the exact worker bridge')[0];
    const launchSource = backendSource
      ?.split('public async launch(')[1]
      ?.split('/** Validates an immutable update')[0];
    const transcriptSource = backendSource
      ?.split('public async collectTranscript(')[1]
      ?.split('/** Returns workspace-change candidates')[0];
    const workspaceSource = backendSource
      ?.split('public async collectWorkspaceChanges(')[1]
      ?.split('/** Dispatches one fixed effect')[0];
    const cleanupSource = backendSource
      ?.split('public async cleanupSession(')[1]
      ?.split('/** Acquires or builds the immutable image')[0];
    expect(materializeSource).toBeDefined();
    expect(launchSource).toBeDefined();
    expect(transcriptSource).toBeDefined();
    expect(workspaceSource).toBeDefined();
    expect(cleanupSource).toBeDefined();

    const imageBuild = materializeSource?.indexOf("'image.build'") ?? -1;
    const sandboxCreate = materializeSource?.indexOf("'sandbox.create'") ?? -1;
    const contextRefCarriage = materializeSource?.indexOf('contextRef: image.contextRef') ?? -1;
    const referenceImport = materializeSource?.indexOf("'reference.import'") ?? -1;
    const prepareImports = materializeSource?.indexOf('prepareNanoHostContextPackageImports') ?? -1;
    expect(imageBuild).toBeGreaterThanOrEqual(0);
    expect(contextRefCarriage).toBeGreaterThan(imageBuild);
    expect(contextRefCarriage).toBeLessThan(sandboxCreate);
    expect(sandboxCreate).toBeGreaterThanOrEqual(0);
    expect(prepareImports).toBeGreaterThan(sandboxCreate);
    expect(referenceImport).toBeGreaterThan(sandboxCreate);
    expect(referenceImport).toBeGreaterThan(prepareImports);
    expect(materializeSource).toContain('for (const file of fileInventory)');
    expect(materializeSource).toContain('this.restoreSharedHarness(');
    expect(materializeSource).toContain('await this.effect(identity, leaseId');
    for (const requiredImportOwner of [
      'fileInventory',
      'contentDigest',
      'byteLength',
      'relativePath',
      'body',
    ]) {
      expect(materializeSource).toContain(requiredImportOwner);
    }
    expect(launchSource).toContain("'bridge.open'");
    const effectSource = backendSource?.split('private async effect(')[1];
    expect(effectSource).toContain('stableNanoHostEffectJson');
    expect(effectSource).toContain('operation');
    expect(effectSource).toContain("operation === 'bridge.open'");
    for (const bootstrapField of [
      'harnessBindingRef',
      'harnessReady',
      'session.open',
      'final_status',
      'processGroupAbsent',
    ]) {
      expect(backendSource).toContain(bootstrapField);
    }
    expect(materializeSource).not.toContain('workerControlToken');
    expect(materializeSource).not.toContain('workerInferenceToken');
    expect(launchSource).not.toContain('workerControlToken');
    expect(launchSource).not.toContain('workerInferenceToken');
    expect(backendSource).toContain('acceptHarnessCommand');
    expect(backendSource?.indexOf('final_status')).toBeLessThan(
      backendSource?.indexOf("'file.export'") ?? -1
    );
    for (const collectionSource of [transcriptSource, workspaceSource]) {
      expect(collectionSource).toContain('await this.effect(');
      expect(collectionSource).toContain("'file.export'");
      for (const field of ['slot', 'relativePath', 'maxByteLength']) {
        expect(collectionSource).toContain(field);
      }
      expect(collectionSource).toContain('terminalBarrierProved');
      const exportCommand = collectionSource?.indexOf("'file.export'") ?? -1;
      expect(collectionSource?.indexOf('sha256', exportCommand)).toBeGreaterThan(exportCommand);
      expect(collectionSource?.indexOf('byteLength', exportCommand)).toBeGreaterThan(exportCommand);
    }
    for (const field of ['slot', 'relativePath', 'sha256', 'byteLength']) {
      expect(materializeSource).toContain(field);
    }
    expect(cleanupSource?.indexOf("'bridge.close'")).toBeLessThan(
      cleanupSource?.indexOf("'sandbox.delete'") ?? -1
    );
    expect(backendSource).not.toMatch(/\b(?:readFile|writeFile|copyFile|fetch)\s*\(/);
  });

  it('treats an absent optional workspace-change manifest as no changes', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return { state: 'absent' };
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          readonly sessions: Map<string, unknown>;
        };
      }
    ).backend;
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_optional_workspace_changes', 'identity_optional_workspace_changes',
                     'deployment_optional_workspace_changes', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-22T00:00:00.000Z');
      const packageSnapshotId = 'aepsnap_optional_workspace_changes';
      const environmentPackage = completeNanoHostPackage({
        extensions: {
          openkit: {
            sessionWorkspace: {
              layout: {
                slots: [{ access: 'read-write', id: 'turn-output', path: '/openkit/session' }],
              },
            },
          },
        },
        scope: {
          agentSessionId: 'as_optional_workspace_changes',
          threadId: 'thread_optional_workspace_changes',
          turnId: 'turn_optional_workspace_changes',
          workspaceId: 'workspace_optional_workspace_changes',
        },
        snapshotId: packageSnapshotId,
        workspace: {
          outputs: [
            {
              id: 'workspace-changes',
              path: '/openkit/session',
              registerAsArtifacts: false,
              retention: 'sync-on-turn-end',
            },
          ],
        },
      });
      const identity = backend.planSession(environmentPackage);
      backend.sessions.set(packageSnapshotId, {
        environmentPackage,
        identity,
        leaseId: 'lease_optional_workspace_changes',
        terminalInspectionComplete: true,
      });

      await expect(backend.collectWorkspaceChanges(packageSnapshotId, true)).resolves.toEqual([]);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        input: {
          presence: 'optional',
          relativePath: 'workspace-changes.json',
          slot: 'turn-output',
        },
        kind: 'file.export',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies a fresh AgentSession before lease acquisition when RuntimeTarget is missing', async () => {
    const coreDb = createFactoryCoreDb();
    const store = createDemoStore();
    const turn = store.updateTurn(
      store.createTurn(
        'ws_demo',
        'th_demo',
        'Require configured NanoHost readiness',
        { kind: 'user', id: 'user_local' },
        null
      ).id,
      { agentId: 'agent_codex_host' }
    );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as-missing-runtime-target',
          requestId: 'req-missing-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not close a predecessor or acquire a lease while RuntimeTarget is unready', async () => {
    const coreDb = createFactoryCoreDb();
    const firstGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-unready-admission',
      identityId: 'identity-unready-admission',
      observedAt: '2026-08-21T00:00:00.000Z',
      targetId: 'target-unready-admission',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...firstGeneration,
      freshEmpty: true,
      predecessorFenced: true,
      ready: true,
      observedAt: '2026-08-21T00:00:01.000Z',
    });
    createNanoHostHarnessRuntime(coreDb, {
      adapterId: 'codex',
      adapterVersion: '0.144.1',
      harnessBindingRef: 'harness-binding-unready-admission',
      harnessInstanceId: 'harness-unready-admission',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      sandboxBindingRef: 'sandbox-binding-unready-admission',
      sandboxCompatibilityKey: 'b'.repeat(64),
      sandboxRuntimeId: 'sandbox-runtime-unready-admission',
      runtimeTargetId: 'target-unready-admission',
      timestamp: '2026-08-21T00:00:01.000Z',
    });
    openNanoHostAgentSessionBinding(coreDb, {
      agentSessionCompatibilityKey: 'c'.repeat(64),
      agentSessionId: 'as-unready-predecessor',
      agentSessionRuntimeBindingId: 'binding-unready-predecessor',
      effectiveSetupGeneration: 1,
      harnessInstanceId: 'harness-unready-admission',
      threadId: 'th_demo',
      timestamp: '2026-08-21T00:00:01.000Z',
      workspaceId: 'ws_demo',
    });
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-unready-admission',
      identityId: 'identity-unready-admission',
      observedAt: '2026-08-21T00:00:02.000Z',
      targetId: 'target-unready-admission',
    });
    const store = createDemoStore();
    const turn = store.updateTurn(
      store.createTurn(
        'ws_demo',
        'th_demo',
        'Do not close before readiness',
        { kind: 'user', id: 'user_local' },
        null
      ).id,
      { agentId: 'agent_codex_host' }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:01.000Z',
      environmentPackageSnapshotId: 'aepsnap-unready-predecessor',
      id: 'as-unready-predecessor',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'d'.repeat(64)}`,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:01.000Z',
      workspaceId: turn.workspaceId,
      workspaceRoots: [],
    });
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as-after-unready-predecessor',
          requestId: 'req-unready-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
      expect(store.getAgentSession('as-unready-predecessor').status).toBe('idle');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get('as-unready-predecessor')
      ).toEqual({ lifecycleState: 'opening' });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT operation_state AS operationState FROM harness_instance_records WHERE harness_instance_id = ?'
          )
          .get('harness-unready-admission')
      ).toEqual({ operationState: 'idle' });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('prepares a fresh AgentSession when the sole RuntimeTarget is ready and unbound', async () => {
    const coreDb = createFactoryCoreDb();
    const generation = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-ready-admission',
      identityId: 'identity-ready-admission',
      observedAt: '2026-08-21T00:00:00.000Z',
      targetId: 'target-ready-admission',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...generation,
      freshEmpty: true,
      predecessorFenced: true,
      ready: true,
      observedAt: '2026-08-21T00:00:01.000Z',
    });
    const store = createDemoStore();
    const turn = store.updateTurn(
      store.createTurn(
        'ws_demo',
        'th_demo',
        'Admit against ready NanoHost',
        { kind: 'user', id: 'user_local' },
        null
      ).id,
      { agentId: 'agent_codex_host' }
    );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as-ready-runtime-target',
          requestId: 'req-ready-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).resolves.toEqual({
        agentSessionId: 'as-ready-runtime-target',
        currentAgentSession: null,
        replacementRequired: false,
        sessionCompatibilityKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('restores every sibling AgentSession binding after a NanoCore restart', () => {
    const coreDb = createFactoryCoreDb();
    const sandboxCompatibilityKey = 'a'.repeat(64);
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_factory_restore', 'identity_factory_restore', 'deployment_factory_restore', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-factory-restore',
        harnessInstanceId: 'harness-factory-restore',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-factory-restore',
        sandboxCompatibilityKey,
        sandboxRuntimeId: 'sandbox-runtime-factory-restore',
        runtimeTargetId: 'target_factory_restore',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      for (const suffix of ['one', 'two']) {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: suffix === 'one' ? 'b'.repeat(64) : 'c'.repeat(64),
          agentSessionId: `agent-session-${suffix}`,
          agentSessionRuntimeBindingId: `agent-session-binding-${suffix}`,
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-factory-restore',
          threadId: `thread-${suffix}`,
          timestamp: '2026-08-21T00:00:00.000Z',
          workspaceId: 'workspace-factory-restore',
        });
      }
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            restoreSharedHarness(
              compatibilityKey: string,
              runtimeTargetId: string
            ): { readonly bindings: Map<string, unknown> } | null;
          };
        }
      ).backend;

      expect(
        [
          ...backend.restoreSharedHarness(sandboxCompatibilityKey, 'target_factory_restore')!
            .bindings,
        ]
          .map(([agentSessionId]) => agentSessionId)
          .sort()
      ).toEqual(['agent-session-one', 'agent-session-two']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('maps the owning SessionCompatibilityKey to exact reusable NanoHost continuity', async () => {
    const coreDb = createFactoryCoreDb();
    const sessionCompatibilityKey = `sha256:${'a'.repeat(64)}`;
    const runtimeCompatibilityKey = deriveNanoHostAgentSessionCompatibilityKey({
      sessionCompatibilityKey,
      threadId: 'thread-continuity-key',
    });
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_continuity_key', 'identity_continuity_key', 'deployment_continuity_key', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-continuity-key',
        harnessInstanceId: 'harness-continuity-key',
        imageDigest: `sha256:${'b'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-continuity-key',
        sandboxCompatibilityKey: 'c'.repeat(64),
        sandboxRuntimeId: 'sandbox-runtime-continuity-key',
        runtimeTargetId: 'target_continuity_key',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: runtimeCompatibilityKey,
        agentSessionId: 'as-continuity-key',
        agentSessionRuntimeBindingId: 'binding-continuity-key',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-continuity-key',
        threadId: 'thread-continuity-key',
        timestamp: '2026-08-21T00:00:00.000Z',
        workspaceId: 'workspace-continuity-key',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          adapterId: 'codex',
          agentSessionCompatibilityKey: runtimeCompatibilityKey,
          agentSessionId: 'as-continuity-key',
          agentSessionRuntimeBindingId: 'binding-continuity-key',
          effectiveSetupGeneration: 1,
          threadId: 'thread-continuity-key',
          workspaceId: 'workspace-continuity-key',
        },
        harnessInstanceId: 'harness-continuity-key',
        operation: 'session.open',
        timestamp: '2026-08-21T00:00:01.000Z',
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        harnessBindingRef: 'harness-binding-continuity-key',
        nextExpectedSequence: 0,
        timestamp: '2026-08-21T00:00:02.000Z',
      });
      if (!command) {
        throw new Error('Expected the continuity fixture session.open command.');
      }
      settleNanoHostHarnessOperation(coreDb, {
        harnessBindingRef: 'harness-binding-continuity-key',
        result: {
          body: {
            maxActiveTurns: 1,
            nativeHandleDigest: 'd'.repeat(64),
            nativeHandleState: 'ready',
            state: 'open',
          },
          disposition: 'succeeded',
          operationId: command.operationId,
          schemaVersion: 1,
          sequence: command.sequence,
        },
        timestamp: '2026-08-21T00:00:03.000Z',
      });
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend;
        }
      ).backend;
      const input = {
        agentSessionCompatibilityKey: sessionCompatibilityKey,
        agentSessionId: 'as-continuity-key',
        reuseAllowed: true,
        threadId: 'thread-continuity-key',
        workspaceId: 'workspace-continuity-key',
      } as const;

      await expect(backend.prepareAgentSessionContinuity?.(input)).resolves.toBe('reusable');
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          agentSessionCompatibilityKey: `sha256:${'e'.repeat(64)}`,
        })
      ).resolves.toBe('replacement-required');
      upsertSchedulerWorkerPool(coreDb, {
        allowedBackendKinds: ['openshell'],
        allowedPlacements: ['local'],
        allowedWorkspaceScopes: ['local'],
        budgetClass: 'interactive',
        currentAdmittedSessionCount: 0,
        currentQueueDepth: 1,
        defaultTimeoutMs: 900_000,
        healthSummary: 'ready',
        maxConcurrentSessions: 1,
        poolId: 'pool_continuity_commit',
        queueLimit: 20,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        capacityClass: 'local',
        concurrencyCeiling: 1,
        inUseCount: 0,
        observationSource: 'configured',
        observedAt: '2026-08-21T00:00:04.000Z',
        poolId: 'pool_continuity_commit',
        queueDepth: 1,
        targetId: 'target_continuity_commit',
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 1,
        healthState: 'healthy',
        lastProbeAt: '2026-08-21T00:00:04.000Z',
        nextProbeAt: '2026-08-21T00:01:04.000Z',
        targetId: 'target_continuity_commit',
      });
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: 'profile_worker',
        queueEntryId: 'queue_continuity_commit',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: input.threadId,
        turnId: 'turn-continuity-commit',
        turnInput: 'Commit exact continuity',
        triggerActor: { kind: 'user', id: 'user-continuity-commit' },
        workspaceId: input.workspaceId,
      });
      const dispatch = dispatchNextSchedulerEntry(coreDb, {
        agentSessionId: input.agentSessionId,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        leaseId: 'lease-continuity-commit',
        planId: 'plan-continuity-commit',
        sandboxBindingRef: 'lease-binding:continuity-commit',
        schedulerEpoch: 1,
        sessionCompatibilityKey,
        startupTimeoutMs: 120_000,
      });
      expect(dispatch.status).toBe('dispatched');
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          admissionAgentSessionId: input.agentSessionId,
          admissionLeaseId: 'lease-continuity-commit',
        })
      ).resolves.toBe('reusable');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get('as-continuity-key')
      ).toEqual({ lifecycleState: 'open' });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['definite delete', false],
    ['uncertain delete', true],
  ] as const)('%s updates the durable Sandbox even without a process-local session', async (_, uncertain) => {
    const coreDb = createFactoryCoreDb();
    const operations: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        operations.push(request.kind);
        if (uncertain && request.kind === 'sandbox.delete') {
          throw new Error('NanoHost sandbox delete outcome is unknown.');
        }
        return {};
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_absent_cleanup', 'identity_absent_cleanup', 'deployment_absent_cleanup', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease_absent_cleanup';
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_absent_cleanup',
          threadId: 'thread_absent_cleanup',
          turnId: 'turn_absent_cleanup',
          workspaceId: 'workspace_absent_cleanup',
        },
        snapshotId: 'aepsnap_absent_cleanup',
      });
      const identity = backend.planSession(environmentPackage);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-absent-cleanup',
        harnessInstanceId: 'harness-absent-cleanup',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        sandboxBindingRef: identity.backendSessionId,
        sandboxCompatibilityKey: `${identity.backendSessionId.slice(3)}${'b'.repeat(48)}`,
        sandboxRuntimeId: 'sandbox-runtime-absent-cleanup',
        runtimeTargetId: 'target_absent_cleanup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });

      const cleanup = runtime.cleanupBackendSession(identity);
      if (uncertain) {
        await expect(cleanup).rejects.toThrow(/unknown/i);
      } else {
        await expect(cleanup).resolves.toBeUndefined();
      }

      const sandbox = coreDb.sqlite
        .prepare(
          `SELECT lifecycle_state AS lifecycleState, health_state AS healthState,
                  drain_state AS drainState, cleanup_state AS cleanupState
           FROM sandbox_runtime_records WHERE sandbox_runtime_id = 'sandbox-runtime-absent-cleanup'`
        )
        .get();
      if (uncertain) {
        expect(sandbox).not.toEqual({
          cleanupState: 'clean',
          drainState: 'accepting',
          healthState: 'ready',
          lifecycleState: 'open',
        });
      } else {
        expect(sandbox).toBeUndefined();
      }
      expect(operations).toEqual(['bridge.close', 'sandbox.delete']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('settles one poll-first unknown fence only after strictly later fresh-ready proof', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const resultOnlyRejectors: Array<(error: Error) => void> = [];
    let resultOnlyRegistrations = 0;
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return {};
      },
      expectResultOnly() {
        resultOnlyRegistrations += 1;
        return new Promise<never>((_, reject) => resultOnlyRejectors.push(reject));
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_post_fence', 'identity_post_fence',
                     'deployment_post_fence', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const initialRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const initialBackend = (
        initialRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      initialBackend.requireLeaseId = () => 'lease_post_fence';
      const identity = initialBackend.planSession(
        completeNanoHostPackage({
          scope: {
            agentSessionId: 'as_post_fence',
            threadId: 'thread_post_fence',
            turnId: 'turn_post_fence',
            workspaceId: 'workspace_post_fence',
          },
          snapshotId: 'aepsnap_post_fence',
        })
      );
      expect(identity.backendSessionId).toMatch(/^nh-[0-9a-f]{16}$/);
      const sandboxCompatibilityKey = `${identity.backendSessionId.slice(3)}${'c'.repeat(48)}`;
      expect(identity.backendSessionId).toBe(`nh-${sandboxCompatibilityKey.slice(0, 16)}`);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-post-fence',
        harnessInstanceId: 'harness-post-fence',
        imageDigest: `sha256:${'1'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-post-fence',
        sandboxCompatibilityKey,
        sandboxRuntimeId: 'sandbox-runtime-post-fence',
        runtimeTargetId: identity.runtimeTargetId,
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease_post_fence', 'workspace_post_fence', 'thread_post_fence',
             'turn_post_fence', ?, ?, 'openshell', ?, ?, ?, '{}',
             'lease-binding:post-fence', ?, 'pending', 'cleanup-pending', ?, ?
           )`
        )
        .run(
          identity.agentSessionId,
          identity.packageSnapshotId,
          identity.deploymentId,
          identity.backendSessionId,
          identity.runtimeTargetId,
          identity.stagingDirectoryRef,
          '2026-08-21T00:00:00.000Z',
          '2026-08-21T00:00:00.000Z'
        );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 0 });
      expect(identity.backendSessionId).not.toBe('sandbox-binding-post-fence');
      expect('lease-binding:post-fence').not.toBe('sandbox-binding-post-fence');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-post-fence-sibling',
        harnessInstanceId: 'harness-post-fence-sibling',
        imageDigest: `sha256:${'3'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-post-fence-sibling',
        sandboxCompatibilityKey: '4'.repeat(64),
        sandboxRuntimeId: 'sandbox-runtime-post-fence-sibling',
        runtimeTargetId: identity.runtimeTargetId,
        timestamp: '2026-08-21T00:00:00.000Z',
      });

      initialRuntime.prepareBackendCleanup(identity);
      const initialCleanup = initialRuntime.cleanupBackendSession(identity);
      resultOnlyRejectors[0]?.(
        new Error('NanoHost accepted effect outcome is unknown; successor connection fenced.')
      );
      await expect(initialCleanup).rejects.toThrow(/unknown/i);
      const fenced = coreDb.sqlite
        .prepare(
          `SELECT s.lifecycle_state AS sandboxLifecycleState,
                  s.health_state AS healthState, s.drain_state AS sandboxDrainState,
                  s.cleanup_state AS cleanupState, s.updated_at AS updatedAt,
                  h.lifecycle_state AS harnessLifecycleState,
                  h.drain_state AS harnessDrainState
           FROM sandbox_runtime_records s
           JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id
           WHERE s.sandbox_runtime_id = 'sandbox-runtime-post-fence'`
        )
        .get() as Record<string, unknown> & { readonly updatedAt: string };
      expect(fenced).toEqual({
        cleanupState: 'unknown',
        harnessDrainState: 'draining',
        harnessLifecycleState: 'failed',
        healthState: 'unknown',
        sandboxDrainState: 'draining',
        sandboxLifecycleState: 'failed',
        updatedAt: fenced.updatedAt,
      });

      const restartedRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const restartedBackend = (
        restartedRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      restartedBackend.requireLeaseId = () => 'lease_post_fence';

      for (const mismatchedIdentity of [
        { ...identity, runtimeTargetId: 'target_post_fence_missing' },
        { ...identity, deploymentId: 'deployment_post_fence_mismatch' },
      ]) {
        expect(() => restartedRuntime.prepareBackendCleanup(mismatchedIdentity)).toThrow();
        expect(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
      }

      coreDb.sqlite.pragma('foreign_keys = OFF');
      try {
        coreDb.sqlite
          .prepare('DELETE FROM nanohost_runtime_targets WHERE target_id = ?')
          .run(identity.runtimeTargetId);
        expect(() => restartedRuntime.prepareBackendCleanup(identity)).toThrow();
        expect(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
      } finally {
        coreDb.sqlite
          .prepare(
            `INSERT INTO nanohost_runtime_targets (
               target_id, identity_id, deployment_id, connection_generation,
               predecessor_fenced, ready, fresh_empty, observed_at, slot_count
             ) VALUES ('target_post_fence', 'identity_post_fence',
                       'deployment_post_fence', 1, 1, 1, 1, ?, 1)`
          )
          .run('2026-08-21T00:00:00.000Z');
        coreDb.sqlite.pragma('foreign_keys = ON');
      }

      for (const [column, invalidValue, restoredValue] of [
        ['lifecycle_state', 'open', 'failed'],
        ['health_state', 'ready', 'unknown'],
        ['drain_state', 'accepting', 'draining'],
      ] as const) {
        coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records SET ${column} = ?
             WHERE sandbox_runtime_id = 'sandbox-runtime-post-fence'`
          )
          .run(invalidValue);
        expect(() => restartedRuntime.prepareBackendCleanup(identity)).toThrow(/contradictory/i);
        expect(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
        coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records SET ${column} = ?
             WHERE sandbox_runtime_id = 'sandbox-runtime-post-fence'`
          )
          .run(restoredValue);
      }

      for (const [observedOffsetMs, predecessorFenced, ready, freshEmpty] of [
        [-1, 1, 1, 1],
        [0, 1, 1, 1],
        [1, 0, 1, 1],
        [1, 1, 0, 1],
        [1, 1, 1, 0],
      ] as const) {
        coreDb.sqlite
          .prepare(
            `UPDATE nanohost_runtime_targets
             SET predecessor_fenced = ?, ready = ?, fresh_empty = ?, observed_at = ?
             WHERE target_id = ?`
          )
          .run(
            predecessorFenced,
            ready,
            freshEmpty,
            new Date(new Date(fenced.updatedAt).getTime() + observedOffsetMs).toISOString(),
            identity.runtimeTargetId
          );
        const rejectorIndex = resultOnlyRejectors.length;
        restartedRuntime.prepareBackendCleanup(identity);
        const rejectedCleanup = restartedRuntime.cleanupBackendSession(identity);
        resultOnlyRejectors[rejectorIndex]?.(new Error('Old result-only cleanup was rebuilt.'));
        await expect(rejectedCleanup).rejects.toThrow();
        expect.soft(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT lifecycle_state AS lifecycleState, cleanup_state AS cleanupState
               FROM sandbox_runtime_records
               WHERE sandbox_runtime_id = 'sandbox-runtime-post-fence'`
            )
            .get()
        ).toEqual({ cleanupState: 'unknown', lifecycleState: 'failed' });
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
      }

      coreDb.sqlite
        .prepare(
          `UPDATE nanohost_runtime_targets
           SET predecessor_fenced = 1, ready = 1, fresh_empty = 1, observed_at = ?,
               last_fresh_ready_at = ?
           WHERE target_id = ?`
        )
        .run(
          new Date(new Date(fenced.updatedAt).getTime() + 1).toISOString(),
          new Date(new Date(fenced.updatedAt).getTime() + 1).toISOString(),
          identity.runtimeTargetId
        );
      const freshRejectorIndex = resultOnlyRejectors.length;
      restartedRuntime.prepareBackendCleanup(identity);
      const freshCleanup = restartedRuntime.cleanupBackendSession(identity);
      resultOnlyRejectors[freshRejectorIndex]?.(new Error('Old result-only cleanup was rebuilt.'));
      await expect(freshCleanup).resolves.toBeUndefined();

      expect(resultOnlyRegistrations).toBe(1);
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT h.harness_instance_id AS harnessInstanceId,
                    s.sandbox_runtime_id AS sandboxRuntimeId
             FROM harness_instance_records h
             JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
             ORDER BY h.harness_instance_id`
          )
          .all()
      ).toEqual([
        {
          harnessInstanceId: 'harness-post-fence-sibling',
          sandboxRuntimeId: 'sandbox-runtime-post-fence-sibling',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('findDurableSandboxBinding keeps exact projection, uniqueness, worker binding, and AgentSession lineage', () => {
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_lookup', 'identity_lookup', 'deployment_lookup', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            findDurableSandboxBinding(
              identity: WorkerGovernanceBackendSessionIdentity
            ): { readonly sandboxBindingRef: string } | null;
          };
        }
      ).backend;
      const projectingPrefix = 'a'.repeat(16);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-lookup-a',
        harnessInstanceId: 'harness-lookup-a',
        imageDigest: `sha256:${'1'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-lookup-a',
        sandboxCompatibilityKey: `${projectingPrefix}${'c'.repeat(48)}`,
        sandboxRuntimeId: 'sandbox-runtime-lookup-a',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      const nonProjectingIdentity: WorkerGovernanceBackendSessionIdentity = {
        agentSessionId: 'as_lookup_none',
        backendKind: 'openshell',
        backendSessionId: `nh-${projectingPrefix.slice(0, 15)}b`,
        deploymentId: 'deployment_lookup',
        packageSnapshotId: 'aepsnap_lookup_none',
        runtimeTargetId: 'target_lookup',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_none',
        transientProviderInstanceId: null,
      };
      expect(backend.findDurableSandboxBinding(nonProjectingIdentity)).toBeNull();

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-lookup-dup',
        harnessInstanceId: 'harness-lookup-dup',
        imageDigest: `sha256:${'2'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-lookup-dup',
        sandboxCompatibilityKey: `${projectingPrefix}${'d'.repeat(48)}`,
        sandboxRuntimeId: 'sandbox-runtime-lookup-dup',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      expect(() =>
        backend.findDurableSandboxBinding({
          ...nonProjectingIdentity,
          agentSessionId: 'as_lookup_ambiguous',
          backendSessionId: `nh-${projectingPrefix}`,
          packageSnapshotId: 'aepsnap_lookup_ambiguous',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_ambiguous',
        })
      ).toThrow('NanoHost cleanup lineage matches more than one durable Sandbox.');

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-lookup-worker',
        harnessInstanceId: 'harness-lookup-worker',
        imageDigest: `sha256:${'3'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-lookup-worker',
        sandboxCompatibilityKey: 'b'.repeat(64),
        sandboxRuntimeId: 'sandbox-runtime-lookup-worker',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease_lookup_worker', 'workspace_lookup', 'thread_lookup_worker',
             'turn_lookup_worker', 'as_lookup_worker', 'aepsnap_lookup_worker', 'openshell',
             'deployment_lookup', 'nh-1111111111111111', 'target_lookup', '{}',
             'sandbox-binding-lookup-worker',
             'server/runtime/worker-backend-sessions/aepsnap_lookup_worker',
             'pending', 'cleanup-pending', ?, ?
           )`
        )
        .run('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
      const workerIdentity: WorkerGovernanceBackendSessionIdentity = {
        ...nonProjectingIdentity,
        agentSessionId: 'as_lookup_worker',
        backendSessionId: `nh-${'e'.repeat(16)}`,
        packageSnapshotId: 'aepsnap_lookup_worker',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_worker',
      };
      expect(backend.findDurableSandboxBinding(workerIdentity)?.sandboxBindingRef).toBe(
        'sandbox-binding-lookup-worker'
      );

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-lookup-agent',
        harnessInstanceId: 'harness-lookup-agent',
        imageDigest: `sha256:${'4'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-lookup-agent',
        sandboxCompatibilityKey: '9'.repeat(64),
        sandboxRuntimeId: 'sandbox-runtime-lookup-agent',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'e'.repeat(64),
        agentSessionId: 'as_lookup_agent',
        agentSessionRuntimeBindingId: 'binding-lookup-agent',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-lookup-agent',
        threadId: 'thread_lookup_agent',
        timestamp: '2026-08-21T00:00:00.000Z',
        workspaceId: 'workspace_lookup',
      });
      const agentIdentity: WorkerGovernanceBackendSessionIdentity = {
        ...nonProjectingIdentity,
        agentSessionId: 'as_lookup_agent',
        backendSessionId: `nh-${'f'.repeat(16)}`,
        packageSnapshotId: 'aepsnap_lookup_agent',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_agent',
      };
      expect(backend.findDurableSandboxBinding(agentIdentity)?.sandboxBindingRef).toBe(
        'sandbox-binding-lookup-agent'
      );
      expect(() =>
        backend.findDurableSandboxBinding({
          ...agentIdentity,
          runtimeTargetId: 'target_lookup_missing',
        })
      ).toThrow('NanoHost cleanup lineage does not match the requested runtime owner.');
      expect(() =>
        backend.findDurableSandboxBinding({
          ...agentIdentity,
          deploymentId: 'deployment_lookup_mismatch',
        })
      ).toThrow('NanoHost cleanup lineage does not match the requested runtime owner.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('widens a Harness-unknown operation to the owning Sandbox reuse fence', () => {
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_harness_unknown', 'identity_harness_unknown', 'deployment_harness_unknown', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-unknown',
        harnessInstanceId: 'harness-unknown',
        imageDigest: `sha256:${'c'.repeat(64)}`,
        sandboxBindingRef: 'sandbox-binding-unknown',
        sandboxCompatibilityKey: 'd'.repeat(64),
        sandboxRuntimeId: 'sandbox-runtime-unknown',
        runtimeTargetId: 'target_harness_unknown',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-unknown',
        operation: 'harness.drain',
        timestamp: '2026-08-21T00:00:01.000Z',
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        harnessBindingRef: 'harness-binding-unknown',
        nextExpectedSequence: 0,
        timestamp: '2026-08-21T00:00:02.000Z',
      });
      if (!command) {
        throw new Error('Expected one dispatched Harness command.');
      }

      markNanoHostHarnessOperationUnknown(coreDb, {
        harnessBindingRef: 'harness-binding-unknown',
        operationId: command.operationId,
        timestamp: '2026-08-21T00:00:03.000Z',
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lifecycle_state AS lifecycleState, health_state AS healthState,
                    drain_state AS drainState, cleanup_state AS cleanupState
             FROM sandbox_runtime_records WHERE sandbox_runtime_id = 'sandbox-runtime-unknown'`
          )
          .get()
      ).not.toEqual({
        cleanupState: 'clean',
        drainState: 'accepting',
        healthState: 'ready',
        lifecycleState: 'open',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keys shared Sandboxes by static isolation inputs, not Turn Context bytes', () => {
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES ('target_factory_compatibility', 'identity_factory_compatibility', 'deployment_factory_compatibility', 1, 1, 1, 1, ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend;
        }
      ).backend;
      const packageFor = (
        turnId: string,
        overrides: {
          readonly actorId?: string;
          readonly mountLabel?: string;
          readonly sensitivity?: string;
        } = {}
      ) =>
        ({
          agent: { runtimeKind: 'codex' },
          backend: {},
          capabilities: {},
          control: {},
          credentials: {},
          llm: {},
          policy: {},
          providers: {},
          resources: {},
          runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
          schemaVersion: 3,
          scope: {
            agentSessionId: `agent-session-${turnId}`,
            threadId: `thread-${turnId}`,
            triggerActor: { kind: 'user', id: overrides.actorId ?? 'user-compatible' },
            turnId,
            workspaceId: 'workspace-compatible',
          },
          snapshotId: `snapshot-${turnId}`,
          supply: { services: [] },
          vault: {},
          workspace: {
            generatedFiles: [
              {
                access: 'read-only',
                contentRef: `agent-environment-package://snapshot-${turnId}`,
                id: 'agent-environment-package',
                target: '/openkit/agent-environment-package.json',
              },
            ],
            inputs: [
              {
                access: 'read-only',
                id: `context_${turnId}`,
                kind: 'generated',
                materialization: {
                  contentDigest: turnId.repeat(64).slice(0, 64),
                  slotId: 'context',
                  strategy: 'filesystem',
                },
                source: {
                  kind: 'generated',
                  pathRef: `threads/thread-${turnId}/turns/${turnId}/context-package`,
                },
                target: '/openkit/context',
              },
              {
                access: 'read-only',
                id: 'workspace-source',
                kind: 'directory',
                mount: { label: overrides.mountLabel ?? 'primary' },
                source: {
                  kind: 'workspace-dir',
                  pathRef: 'workspace-root://source',
                  sensitivity: overrides.sensitivity ?? 'internal',
                },
                target: '/workspace/inputs/source',
              },
            ],
            outputs: [],
            root: '/workspace',
          },
        }) as AgentEnvironmentPackage;
      const keyFor = (environmentPackage: AgentEnvironmentPackage) =>
        backend.planSession(environmentPackage).backendSessionId;
      const baseline = keyFor(packageFor('a'));

      expect(keyFor(packageFor('b'))).toBe(baseline);
      expect(keyFor(packageFor('c', { actorId: 'user-other' }))).not.toBe(baseline);
      expect(keyFor(packageFor('d', { mountLabel: 'secondary' }))).not.toBe(baseline);
      expect(keyFor(packageFor('e', { sensitivity: 'restricted' }))).not.toBe(baseline);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not fall back to the bounded-turn worker command owner for NanoHost', async () => {
    const coreDb = createFactoryCoreDb();
    try {
      const workerControlGateway = new WorkerControlGateway({
        now: () => '2026-08-12T00:00:00.000Z',
      });
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway,
      });
      const store = createDemoStore();
      const turn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Interrupt the configured worker',
        { kind: 'user', id: 'user_local' },
        null,
        { turnId: 'turn_factory_interrupt' }
      );
      const agentSessionId = 'as_factory_interrupt';
      const packageSnapshotId = 'aepsnap_factory_interrupt';
      store.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: turn.startedAt ?? '2026-08-12T00:00:00.000Z',
        environmentPackageSnapshotId: packageSnapshotId,
        id: agentSessionId,
        message: null,
        status: 'busy',
        threadId: turn.threadId,
        updatedAt: turn.startedAt ?? '2026-08-12T00:00:00.000Z',
        workspaceId: turn.workspaceId,
      });
      store.updateTurn(turn.id, { agentSessionId });
      const priorPackageSnapshotId = `${packageSnapshotId}_prior`;
      workerControlGateway.registerSession({
        scope: {
          agentSessionId,
          requestId: null,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        },
        snapshotId: priorPackageSnapshotId,
      } as AgentEnvironmentPackage);
      workerControlGateway.registerSession({
        scope: {
          agentSessionId,
          requestId: null,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        },
        snapshotId: packageSnapshotId,
      } as AgentEnvironmentPackage);

      await expect(
        runtime.turnExecutor.interruptTurn(store, turn.id, {
          requestId: 'req_factory_interrupt',
        })
      ).rejects.toThrow('materialized session');

      expect(workerControlGateway.getSessionSnapshot(priorPackageSnapshotId)?.commands).toEqual([]);
      expect(workerControlGateway.getSessionSnapshot(packageSnapshotId)?.commands).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('deletes a created sandbox directly when context preparation fails before bridge admission', async () => {
    const packageSnapshotId = 'aepsnap_factory_pre_bridge_failure';
    const operations: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        operations.push(request.kind);
        if (request.kind === 'image.acquire') {
          return { digest: `sha256:${'a'.repeat(64)}` };
        }
        if (request.kind === 'sandbox.create') {
          return { sandboxId: 'nanohost-as_factory_pre_bridge_failure' };
        }
        if (request.kind === 'sandbox.delete') {
          throw new Error('NanoHost sandbox delete outcome is cleanup-required.');
        }
        if (request.kind === 'bridge.close') {
          throw new Error('NanoHost bridge identity mismatch.');
        }
        throw new Error(`Unexpected NanoHost effect ${request.kind}.`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    factoryCoreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (
           target_id, identity_id, deployment_id, connection_generation,
           predecessor_fenced, ready, fresh_empty, observed_at, slot_count
         ) VALUES (?, ?, ?, 1, 1, 1, 1, ?, 1)`
      )
      .run(
        'target_factory_pre_bridge_failure',
        'identity_factory_pre_bridge_failure',
        'deployment_factory_pre_bridge_failure',
        '2026-08-10T00:00:00.000Z'
      );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          requireLeaseId(packageSnapshotId: string): string;
        };
      }
    ).backend;
    backend.requireLeaseId = () => 'lease_factory_pre_bridge_failure';
    const environmentPackage = completeNanoHostPackage({
      policy: {
        filesystem: { default: 'deny', rules: [] },
        network: { default: 'deny', enforcement: 'openshell', rules: [] },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_pre_bridge_failure',
      },
      runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
      scope: {
        agentSessionId: 'as_factory_pre_bridge_failure',
        threadId: 'thread_factory_pre_bridge_failure',
        turnId: 'turn_factory_pre_bridge_failure',
        workspaceId: 'ws_factory_pre_bridge_failure',
      },
      snapshotId: packageSnapshotId,
      workspace: {
        inputs: [
          {
            access: 'read-only',
            id: 'context_turn_factory_pre_bridge_failure',
            kind: 'generated',
            source: {
              kind: 'generated',
              pathRef:
                'threads/thread_factory_pre_bridge_failure/turns/turn_factory_pre_bridge_failure/context-package',
            },
            target: '/openkit/context',
          },
        ],
      },
    });
    const identity = backend.planSession(environmentPackage);

    await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
      'NanoHost Context Package lineage or private root is invalid.'
    );
    await expect(runtime.cleanupBackendSession(identity)).rejects.toThrow('cleanup-required');
    expect(operations).toEqual(['image.acquire', 'sandbox.create', 'sandbox.delete']);
    expect(operations).not.toContain('bridge.open');
    expect(operations).not.toContain('bridge.close');
  });

  it('uses an exact preloaded deployment digest with the newest lease and no acquisition', async () => {
    const coreDb = createFactoryCoreDb();
    const packageSnapshotId = 'aepsnap_factory_newest_lease';
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        throw new Error('first NanoHost effect reached');
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES (?, ?, ?, 1, 1, 1, 1, ?, 1)`
        )
        .run(
          'target_factory_newest_lease',
          'identity_factory_newest_lease',
          'deployment_factory_newest_lease',
          '2026-08-10T00:00:00.000Z'
        );
      const insertLease = coreDb.sqlite.prepare(
        `INSERT INTO scheduler_session_leases (
           lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
           package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
           heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
           sandbox_binding_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?)`
      );
      for (const [leaseId, acquiredAt] of [
        ['lease_z_older', '2026-08-10T00:00:00.000Z'],
        ['lease_a_current', '2026-08-10T00:00:01.000Z'],
        ['lease_b_current', '2026-08-10T00:00:01.000Z'],
      ] as const) {
        insertLease.run(
          leaseId,
          `plan_${leaseId}`,
          'ws_factory_newest_lease',
          'thread_factory_newest_lease',
          'turn_factory_newest_lease',
          'as_factory_newest_lease',
          packageSnapshotId,
          'pool_factory_newest_lease',
          'target_factory_newest_lease',
          acquiredAt,
          '2026-08-10T00:15:00.000Z',
          '2026-08-10T00:00:30.000Z',
          '2026-08-10T00:02:00.000Z',
          `binding:${leaseId}`
        );
      }

      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend;
        }
      ).backend;
      const deploymentDigest = `sha256:${'d'.repeat(64)}`;
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: deploymentDigest },
        },
        scope: {
          agentSessionId: 'as_factory_newest_lease',
          threadId: 'thread_factory_newest_lease',
          turnId: 'turn_factory_newest_lease',
          workspaceId: 'ws_factory_newest_lease',
        },
        snapshotId: packageSnapshotId,
      });

      await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
        'first NanoHost effect reached'
      );
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        input: { imageDigest: deploymentDigest, leaseId: 'lease_b_current' },
        kind: 'sandbox.create',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('derives deterministic distinct DNS-1123 sandbox identities before sandbox creation', async () => {
    const coreDb = createFactoryCoreDb();
    const sandboxCreates: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') {
          return { digest: `sha256:${'b'.repeat(64)}` };
        }
        if (request.kind === 'sandbox.create') {
          sandboxCreates.push(request);
          throw new Error('first sandbox.create reached');
        }
        throw new Error(`Unexpected NanoHost effect ${request.kind}.`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, observed_at, slot_count
           ) VALUES (?, ?, ?, 1, 1, 1, 1, ?, 1)`
        )
        .run(
          'target_factory_dns_sandbox',
          'identity_factory_dns_sandbox',
          'deployment_factory_dns_sandbox',
          '2026-08-10T00:00:00.000Z'
        );
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease_factory_dns_sandbox';
      const sandboxIds: string[] = [];
      const policy = {
        filesystem: {
          default: 'deny',
          rules: [
            { access: 'read-only', workerPath: '/workspace/vendor-sdk' },
            { access: 'read-write', workerPath: '/sandbox/.cache/npm' },
          ],
        },
        network: {
          default: 'deny',
          enforcement: 'openshell',
          rules: [
            {
              access: 'read-only',
              action: 'allow',
              binaries: ['/usr/bin/curl'],
              host: 'api.example.com',
              id: 'artifact-api',
              port: 443,
              protocol: 'rest',
            },
          ],
        },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_dns_sandbox',
      };

      for (const [agentSessionId, snapshotId] of [
        ['as_wp5_gate_r3', 'aepsnap_factory_dns_lower'],
        ['AS_WP5_GATE_R3', 'aepsnap_factory_dns_upper'],
      ] as const) {
        const environmentPackage = completeNanoHostPackage({
          policy,
          runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
          scope: {
            agentSessionId,
            threadId: `thread_${snapshotId}`,
            turnId: `turn_${snapshotId}`,
            workspaceId: `ws_${snapshotId}`,
          },
          snapshotId,
        });
        const firstPlan = backend.planSession(environmentPackage);
        const secondPlan = backend.planSession(environmentPackage);
        expect(secondPlan.backendSessionId).toBe(firstPlan.backendSessionId);

        await expect(
          backend.materialize(environmentPackage, { workspaceRoots: [] })
        ).rejects.toThrow('first sandbox.create reached');
        const sandboxCreate = sandboxCreates.at(-1);
        expect(sandboxCreate?.input).toEqual({
          backendSessionId: firstPlan.backendSessionId,
          imageDigest: `sha256:${'b'.repeat(64)}`,
          leaseId: 'lease_factory_dns_sandbox',
          packageSnapshotId: snapshotId,
          policy: {
            filesystem: {
              includeWorkdir: true,
              readOnly: [
                '/usr',
                '/lib',
                '/proc',
                '/dev/urandom',
                '/app',
                '/etc',
                '/var/log',
                '/workspace/vendor-sdk',
              ],
              readWrite: ['/sandbox', '/tmp', '/dev/null', '/sandbox/.cache/npm'],
            },
            landlock: { compatibility: 'best_effort' },
            networkMiddlewares: {},
            networkPolicies: {
              artifact_api: {
                binaries: [{ path: '/usr/bin/curl' }],
                endpoints: [
                  {
                    access: 'read-only',
                    enforcement: 'enforce',
                    host: 'api.example.com',
                    port: 443,
                    protocol: 'rest',
                  },
                ],
                name: 'artifact_api',
              },
            },
            process: { runAsGroup: 'sandbox', runAsUser: 'sandbox' },
            version: 1,
          },
          sandboxId: firstPlan.backendSessionId,
        });
        expect(sandboxCreate?.kind).toBe('sandbox.create');
        expect(firstPlan.backendSessionId.length).toBeLessThanOrEqual(19);
        expect(firstPlan.backendSessionId).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
        sandboxIds.push(firstPlan.backendSessionId);
      }

      expect(new Set(sandboxIds).size).toBe(sandboxIds.length);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps the deterministic self-check executor override outside production selection', () => {
    const executor = createConfiguredTurnExecutor({
      coreDb: factoryCoreDb,
      env: { OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1' },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(SimulatedTurnExecutor);
  });
});
