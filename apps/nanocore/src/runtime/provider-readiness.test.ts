import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayConfig } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentSetupResolverDependencies,
  resolveAgentSetup,
} from '../agents/setup-resolver.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import type { ExecutionBackend } from './execution-backend.js';
import { commandInputHash, type IdempotentCommandReceipt } from './idempotent-command.js';
import { startTurn } from './orchestrator.js';
import { observeTurnAdmission, startProductTurn } from './product-turn-start.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import type { TurnExecutor } from './types.js';
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';

/** Live supply sources consumed by the real setup resolver, without credential materialization. */
type ReadinessHooks = Pick<
  AgentSetupResolverDependencies,
  'providerCredentialConfigured' | 'subscriptionAccounts'
>;

/** Finite supply cases derived from the unavailable-member and ordered failover contracts. */
type SupplyCase =
  | 'missing-key'
  | 'unavailable-account'
  | 'dormant-backup'
  | 'healthy'
  | 'healthy-account'
  | 'enabled-backup';

const cleanups: Array<() => void> = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Creates one logical model and its current API-key or subscription supply. */
function supply(kind: SupplyCase) {
  const isSubscription = kind === 'unavailable-account' || kind === 'healthy-account';
  const keyAvailable = kind === 'healthy';
  const hasBackup = kind === 'dormant-backup' || kind === 'enabled-backup';
  const providerRegistry = new ProviderRegistry([
    {
      id: 'primary',
      displayName: 'Primary',
      models: ['openai/gpt-5.2'],
      ...(isSubscription
        ? {
            kind: 'oauth' as const,
            vendor: 'openai-codex',
            extensions: {
              openkit: { subscriptionAccount: { accountSlotId: 'readiness-fixture' } },
            },
          }
        : {
            kind: 'llm-gateway' as const,
            vendor: 'openai',
            baseUrl: 'https://inference.example.com/v1',
            secretRef: 'env:READINESS_FIXTURE_KEY',
          }),
    },
    ...(hasBackup
      ? [
          {
            id: 'backup',
            displayName: 'Backup',
            kind: 'custom' as const,
            baseUrl: 'https://backup.example.com/v1',
            models: ['openai/gpt-5.2'],
          },
        ]
      : []),
  ]);
  const gatewayConfig: GatewayConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: 'readiness-model',
    logicalModels: [
      {
        id: 'readiness-model',
        displayName: 'Readiness model',
        contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
        routing: { autoFailover: kind === 'enabled-backup' },
        routes: [
          { id: 'primary-route', providerProfileId: 'primary', providerModel: 'openai/gpt-5.2' },
          ...(hasBackup
            ? [{ id: 'backup-route', providerProfileId: 'backup', providerModel: 'openai/gpt-5.2' }]
            : []),
        ],
      },
    ],
    requiredFeatures: [],
  };
  const hooks: ReadinessHooks = {
    providerCredentialConfigured: vi.fn(() => keyAvailable),
    subscriptionAccounts: {
      gatewayUnavailableReason: vi.fn(() =>
        kind === 'healthy-account' ? null : 'subscription_account_logged_out'
      ),
    },
  };
  return { providerRegistry, gatewayConfig, hooks };
}

/** Opens real admission owners with an external runtime that can report capacity without effects. */
async function fixture(kind: SupplyCase) {
  const current = supply(kind);
  const manifest = createTestAgentSetup({ logicalModelId: 'readiness-model' }).manifest;
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-readiness-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  recordTestNativeRuntimeTarget(coreDb);
  cleanups.push(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const backend: ExecutionBackend = {
    id: 'readiness-backend',
    submit: vi.fn().mockRejectedValue(new Error('Unexpected backend submission.')),
    inspect: vi.fn().mockRejectedValue(new Error('Unexpected backend inspection.')),
    cancel: vi.fn().mockRejectedValue(new Error('Unexpected backend cancellation.')),
    release: vi.fn().mockRejectedValue(new Error('Unexpected backend release.')),
  };
  const prepare = vi
    .fn<NonNullable<TurnExecutor['prepareAgentSessionForTurn']>>()
    .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
  const execute = vi.fn<TurnExecutor['startTurn']>().mockResolvedValue(undefined);
  const executor: TurnExecutor = {
    executionBackend: backend,
    capabilities: {
      approvals: false,
      artifacts: false,
      interrupts: true,
      questions: false,
      workspaceConfig: true,
      workspaceKnowledgeEditing: true,
    },
    eventFamilies: ['turn.started'],
    prepareAgentSessionForTurn: prepare,
    startTurn: execute,
    interruptTurn: vi.fn().mockResolvedValue(undefined),
  };
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: null,
    agentManifests: [manifest],
    gatewayConfig: current.gatewayConfig,
    providerRegistry: current.providerRegistry,
  });
  const setup = () =>
    resolveAgentSetup(manifest, {
      gatewayConfig: current.gatewayConfig,
      providerRegistry: current.providerRegistry,
      ...current.hooks,
    });
  const admissions = () => coreDb.sqlite.prepare('SELECT * FROM scheduler_admission_entries').all();
  return {
    ...current,
    coreDb,
    store,
    manifest,
    backend,
    executor,
    prepare,
    execute,
    snapshot,
    setup,
    admissions,
  };
}

/** Readiness refusal must precede every external runtime operation. */
function expectNoRuntimeEffects(f: ReturnType<typeof fixture>) {
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.backend.submit).not.toHaveBeenCalled();
  expect(f.backend.inspect).not.toHaveBeenCalled();
  expect(f.backend.cancel).not.toHaveBeenCalled();
  expect(f.backend.release).not.toHaveBeenCalled();
}

/** Publishes a real queued request, pending Turn and command receipt for scheduler re-evaluation. */
async function enqueue(f: ReturnType<typeof fixture>) {
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: f.backend.id,
    modelId: null,
    profileRef: null,
    queueEntryId: 'queue_readiness',
    requestId: '00000000-0000-4000-8000-000000000301',
    requestedAgentId: f.manifest.id,
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-7f8d-8f63-56fe4f577045',
    turnInput: 'Recheck current provider supply.',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceCwd: null,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    workspaceRoots: [],
  });
  await f.store.createTurn(
    entry.workspaceId,
    entry.threadId,
    entry.turnInput,
    entry.triggerActor,
    null,
    {
      turnId: entry.turnId,
      status: 'pending',
      agentId: f.manifest.id,
      executorKind: 'worker',
      commandReceipt: commandReceipt({
        requestId: entry.requestId,
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        agentId: f.manifest.id,
        input: entry.turnInput,
      }),
    }
  );
}

/** Prepares the original command facts for the native Turn owner, before admission or dispatch. */
function commandReceipt(
  input: Parameters<typeof startProductTurn>[0]['input']
): IdempotentCommandReceipt {
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  };
  const createdAt = new Date().toISOString();
  return {
    key: commandRequestKey('turn.start', input.requestId, scope),
    command: 'turn.start',
    requestId: input.requestId,
    inputHash: commandInputHash(input),
    scope,
    responseKind: 'turn',
    createdAt,
    expiresAt: commandRequestExpiresAt(createdAt),
  };
}

describe('provider readiness at Turn boundaries', () => {
  it.each([
    'missing-key',
    'unavailable-account',
    'dormant-backup',
  ] as const)('orchestrator refuses %s before creating a Turn or starting its executor', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().setup).toBeNull();
    const result = startTurn({
      ...f.hooks,
      gatewayConfig: f.gatewayConfig,
      providerRegistry: f.providerRegistry,
      agentManifests: [f.manifest],
      agentId: f.manifest.id,
      input: 'Use current supply.',
      store: f.store,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turnExecutor: f.executor,
    });
    await expect(result).rejects.toThrow(/logical model/i);
    expect(
      f.store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
    expectNoRuntimeEffects(f);
  });

  it.each([
    'missing-key',
    'unavailable-account',
    'dormant-backup',
  ] as const)('product admission refuses %s before durable admission', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().setup).toBeNull();
    const admitted = vi.fn(() => {
      throw new Error('Unexpected durable admission.');
    });
    const result = startProductTurn({
      ...f.hooks,
      coreDb: f.coreDb,
      store: f.store,
      snapshot: f.snapshot,
      turnExecutor: f.executor,
      workerPlacement: 'local',
      requestedAgentId: f.manifest.id,
      providerCredentialResolver: () => null,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      input: {
        requestId: '00000000-0000-4000-8000-000000000302',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        input: 'Use current supply.',
      },
      onTurnCreated: admitted,
    });
    await expect(result).rejects.toMatchObject({ code: 'agent_not_ready' });
    expect(admitted).not.toHaveBeenCalled();
    expect(f.admissions()).toEqual([]);
    expect(
      f.store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
    expectNoRuntimeEffects(f);
  });

  it.each([
    'missing-key',
    'unavailable-account',
    'dormant-backup',
  ] as const)('scheduler refuses %s before backend preparation', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().setup).toBeNull();
    await enqueue(f);
    const result = runSchedulerDispatchLoop({
      ...f.hooks,
      agentManifests: [f.manifest],
      coreDb: f.coreDb,
      executionBackend: f.backend,
      gatewayConfig: f.gatewayConfig,
      providerRegistry: f.providerRegistry,
      store: f.store,
      turnExecutor: f.executor,
    });
    await expect(result).rejects.toMatchObject({ code: 'agent_not_ready' });
    expectNoRuntimeEffects(f);
  });

  it.each([
    'healthy',
    'healthy-account',
    'enabled-backup',
  ] as const)('orchestrator starts with %s supply', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().diagnostics).toEqual([]);
    const result = await startTurn({
      ...f.hooks,
      gatewayConfig: f.gatewayConfig,
      providerRegistry: f.providerRegistry,
      agentManifests: [f.manifest],
      agentId: f.manifest.id,
      input: 'Use current supply.',
      store: f.store,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turnExecutor: f.executor,
    });
    expect(result.agentSetupDiagnostics).toEqual([]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    'healthy',
    'healthy-account',
    'enabled-backup',
  ] as const)('product admits %s supply before the controlled dispatch boundary', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().diagnostics).toEqual([]);
    const stopAfterAdmission = new Error('Stop at the admission boundary.');
    const admitted = vi.fn(() => {
      throw stopAfterAdmission;
    });
    await expect(
      startProductTurn({
        ...f.hooks,
        coreDb: f.coreDb,
        store: f.store,
        snapshot: f.snapshot,
        turnExecutor: f.executor,
        workerPlacement: 'local',
        requestedAgentId: f.manifest.id,
        providerCredentialResolver: () => null,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        input: {
          requestId: '00000000-0000-4000-8000-000000000303',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          input: 'Use current supply.',
        },
        onTurnCreated: admitted,
      })
    ).rejects.toBe(stopAfterAdmission);
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(f.admissions()).toHaveLength(1);
    expectNoRuntimeEffects(f);
  });

  it.each([
    'healthy',
    'healthy-account',
    'enabled-backup',
  ] as const)('scheduler reaches the backend capacity boundary with %s supply', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().diagnostics).toEqual([]);
    await enqueue(f);
    const result = await runSchedulerDispatchLoop({
      ...f.hooks,
      agentManifests: [f.manifest],
      coreDb: f.coreDb,
      executionBackend: f.backend,
      gatewayConfig: f.gatewayConfig,
      providerRegistry: f.providerRegistry,
      store: f.store,
      turnExecutor: f.executor,
    });
    expect(result.terminalResult).toEqual({ status: 'queued', reason: 'backend-busy' });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backend.submit).not.toHaveBeenCalled();
  });
});

describe('scheduler to orchestrator readiness handoff', () => {
  it.each([
    'healthy',
    'healthy-account',
  ] as const)('rechecks %s supply after preparation and before executor start', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().diagnostics).toEqual([]);
    await enqueue(f);
    f.prepare.mockImplementation(async (_store, input) => {
      if (kind === 'healthy')
        vi.mocked(f.hooks.providerCredentialConfigured!).mockReturnValue(false);
      else
        vi.mocked(f.hooks.subscriptionAccounts!.gatewayUnavailableReason).mockReturnValue(
          'subscription_account_logged_out'
        );
      return {
        agentSessionId: input.freshAgentSessionId,
        currentAgentSession: null,
        replacementRequired: false,
        sessionCompatibilityKey: `sha256:${'a'.repeat(64)}`,
      };
    });
    const result = runSchedulerDispatchLoop({
      ...f.hooks,
      agentManifests: [f.manifest],
      coreDb: f.coreDb,
      executionBackend: f.backend,
      gatewayConfig: f.gatewayConfig,
      providerRegistry: f.providerRegistry,
      store: f.store,
      turnExecutor: f.executor,
    });
    await expect(result).rejects.toThrow(/logical model/i);
    expect(f.setup().setup).toBeNull();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backend.submit).not.toHaveBeenCalled();
  });
});

describe('product admission to queued dispatch readiness handoff', () => {
  it.each([
    'healthy',
    'healthy-account',
  ] as const)('rechecks %s supply after admission without preparing the backend', async (kind) => {
    const f = await fixture(kind);
    expect(f.setup().diagnostics).toEqual([]);
    const prepared = Promise.withResolvers<void>();
    f.prepare.mockImplementation(async () => {
      prepared.resolve();
      throw new WorkerGovernanceCapacityUnavailableError();
    });
    const input = {
      requestId: '00000000-0000-4000-8000-000000000304',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      input: 'Recheck supply after admission.',
    };
    const receipt = commandReceipt(input);
    let originalTurnId: string | undefined;
    const observed = observeTurnAdmission({
      execute: (admit) =>
        startProductTurn({
          ...f.hooks,
          coreDb: f.coreDb,
          store: f.store,
          snapshot: f.snapshot,
          turnExecutor: f.executor,
          workerPlacement: 'local',
          requestedAgentId: f.manifest.id,
          providerCredentialResolver: () => null,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          input,
          commandReceipt: receipt,
          onTurnCreated: (turn) => {
            expect(turn.status).toBe('pending');
            expect(turn.agentSessionId ?? null).toBeNull();
            originalTurnId = turn.id;
            admit(turn);
            if (kind === 'healthy')
              vi.mocked(f.hooks.providerCredentialConfigured!).mockReturnValue(false);
            else
              vi.mocked(f.hooks.subscriptionAccounts!.gatewayUnavailableReason).mockReturnValue(
                'subscription_account_logged_out'
              );
          },
        }),
      settled: () => {},
      failed: () => {},
    });
    // Accepted queue ownership survives a later execution failure; it is not a terminal handle.
    const accepted = await observed.accepted;
    expect(accepted.id).toBe(originalTurnId);
    const originalReceipt = f.store.getCommandRequest('turn.start', input.requestId, receipt.scope);
    expect(originalReceipt).toMatchObject({
      requestId: input.requestId,
      inputHash: receipt.inputHash,
      response: { kind: 'turn', id: accepted.id },
    });
    const outcome = await Promise.race([
      observed.execution.then(
        () => ({ boundary: 'unexpected-success' as const }),
        (error: unknown) => ({ boundary: 'terminal' as const, error })
      ),
      prepared.promise.then(() => ({ boundary: 'backend-preparation' as const })),
    ]);
    // Let the invoked scheduler settle before closing its real database, including the red path.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome.boundary).toBe('terminal');
    if (outcome.boundary !== 'terminal') throw new Error('Readiness reached backend preparation.');
    expect(outcome.error).toMatchObject({
      code: 'agent_not_ready',
      message: expect.stringMatching(/logical model/i),
    });
    expect(f.store.getTurn(input.workspaceId, input.threadId, accepted.id)).toMatchObject({
      id: accepted.id,
      status: 'failed',
      error: { code: 'worker_preparation_failed' },
    });
    expect(f.admissions()).toMatchObject([
      { turn_id: accepted.id, request_id: input.requestId, workspace_id: input.workspaceId },
    ]);
    expect(f.store.getCommandRequest('turn.start', input.requestId, receipt.scope)).toEqual(
      originalReceipt
    );
    expect(f.setup().setup).toBeNull();
    expectNoRuntimeEffects(f);
  });
});
