// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { nonClosedSandboxAttempts } from '../runtime/idle-cleanup-records.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from '../runtime/nanohost-harness.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { createWorkerEnvironmentRuntimeEffects } from '../runtime/worker-environment-runtime-effects.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import type { WorkerGovernanceTurnExecutor } from '../runtime/worker-governance-turn-executor.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { createWorkerEnvironmentOperations } from '../worker-environments/worker-environment-operations.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './nanohost-transport-owner.js';

it('lists an admitted empty Worker inventory and treats an empty RuntimeTarget as available capacity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-k7-native-observation-'));
  const coreDb = openCoreDb(root);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const effect = vi.fn(async () => {
    throw new Error('No host effect expected');
  });
  const operations = createWorkerEnvironmentOperations({
    coreDb,
    store,
    runtimeEffects: createWorkerEnvironmentRuntimeEffects(
      {
        effect,
        route: vi.fn(async () => {
          throw new Error('No host route expected');
        }),
      },
      TEST_WORKER_RELEASE_IDENTITY
    ),
  });
  const context = { actor: { kind: 'local' as const, userId }, workspaceId };
  expect(() => operations.list(context, { limit: 10 })).toThrow(
    expect.objectContaining({ code: 'operation_storage_unavailable', status: 503 })
  );
  const native = await openAdmittedTestNanoHost(coreDb);
  expect(operations.list(context, { limit: 10 })).toEqual({ items: [], nextCursor: null });
  const empty = native.value.owner.read((sqlite) =>
    nonClosedSandboxAttempts(
      coreDb,
      'nanohost',
      {
        scope: {
          workspaceId,
          threadId: testEntityId('th', 'empty-target'),
          turnId: testEntityId('tu', 'empty-target'),
        },
        snapshotId: 'empty-target-package',
      },
      'empty-target',
      'a'.repeat(64),
      'empty-sandbox',
      { sqlite }
    )
  );
  expect(empty).toEqual({ state: 'ready', value: [] });
  const placement = {
    deploymentId: readDataRootLayoutMarker(root).deploymentId,
    identityId: 'empty-target',
    targetId: 'empty-target',
    observedAt: '2026-11-21T00:00:00.000Z',
  };
  await expect(
    transitionAdmittedNanoHostRuntimeTarget(native.value, { ...placement, kind: 'allocate' })
  ).resolves.toMatchObject({ state: 'ready', value: { connectionGeneration: 1 } });
  await expect(
    transitionAdmittedNanoHostRuntimeTarget(native.value, {
      ...placement,
      kind: 'ready',
      connectionGeneration: 1,
      physicalEpoch: 'a'.repeat(64),
      ready: true,
      freshEmpty: true,
      predecessorFenced: true,
    })
  ).resolves.toMatchObject({ state: 'ready' });
  const continuity = {
    workspaceId,
    threadId: testEntityId('th', 'empty-target'),
    agentSessionId: testEntityId('as', 'empty-target'),
    reuseAllowed: true,
  };
  const runtime = (
    owner: NonNullable<
      NonNullable<Parameters<typeof createConfiguredWorkerLifecycleRuntime>[0]>['nanoHostRecovery']
    >
  ) =>
    createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      nanoHostRecovery: owner,
    }).turnExecutor as WorkerGovernanceTurnExecutor;
  const executor = runtime({ owner: { state: 'ready', value: native.value.owner } });
  const backend = executor.executionBackend as WorkerGovernanceBackend;
  await expect(backend.prepareAgentSessionContinuity!(continuity)).resolves.toBe('absent');
  await expect(
    backend.prepareAgentSessionContinuity!({ ...continuity, reuseAllowed: false })
  ).resolves.toBe('absent');
  const unavailable = runtime({
    owner: { state: 'unavailable', owner: 'nanohost', reason: 'missing' },
  });
  await expect(
    (unavailable.executionBackend as WorkerGovernanceBackend).prepareAgentSessionContinuity!(
      continuity
    )
  ).rejects.toMatchObject({ code: 'operation_storage_unavailable', status: 503 });

  await createNanoHostHarnessRuntime(native.value.owner, {
    adapterId: 'codex',
    adapterVersion: '0.153.4',
    harnessBindingRef: 'idle-harness-binding',
    harnessCompatibilityKey: 'c'.repeat(64),
    harnessInstanceId: 'idle-harness',
    imageDigest: `sha256:${'d'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: 'idle-sandbox-binding',
    sandboxCompatibilityKey: 'b'.repeat(64),
    sandboxIntegrationBindingRef: 'idle-sandbox-integration',
    sandboxRuntimeId: 'idle-sandbox',
    runtimeTargetId: placement.targetId,
    timestamp: placement.observedAt,
  });
  const agentSessionRuntimeBindingId = 'idle-agent-session-binding';
  await openNanoHostAgentSessionBinding(native.value.owner, {
    workspaceId,
    threadId: continuity.threadId,
    agentSessionId: continuity.agentSessionId,
    agentSessionCompatibilityKey: 'e'.repeat(64),
    agentSessionRuntimeBindingId,
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'idle-harness',
    timestamp: placement.observedAt,
  });
  const recordNativeHandleDigest = vi.fn(async () => {});
  const corePrepare = vi.spyOn(coreDb.sqlite, 'prepare');
  try {
    await expect(
      backend.prepareAgentSessionContinuity!({
        ...continuity,
        reuseAllowed: false,
        recordNativeHandleDigest,
      })
    ).rejects.toMatchObject({ code: 'operation_storage_unavailable', status: 503 });
    expect(corePrepare).not.toHaveBeenCalled();
  } finally {
    corePrepare.mockRestore();
  }
  expect(recordNativeHandleDigest).not.toHaveBeenCalled();
  expect(
    native.value.owner.read((sqlite) =>
      sqlite.prepare('SELECT operation_state FROM harness_instance_records').pluck().get()
    )
  ).toEqual({ state: 'ready', value: 'idle' });

  const recheckAuthority = vi.fn(async () => {});
  const lineage = {
    workspaceId,
    threadId: continuity.threadId,
    agentSessionId: continuity.agentSessionId,
    turnId: testEntityId('tu', 'idle-login-replacement'),
    packageSnapshotId: 'untouched-login-package',
  };
  await expect(
    executor.credentialBindingOperation(
      store,
      {
        action: 'replace',
        coreAuthority: {
          workspaceId,
          revision: 'original-revision',
          requester: { kind: 'worker', actor: { kind: 'user', id: userId }, lineage },
        },
        workspaceId,
        threadId: continuity.threadId,
        planId: 'unread-login-plan',
        requestId: 'original-login-activation',
        loginReplacement: {
          context: {
            ...lineage,
            agentSessionRuntimeBindingId,
            leaseId: 'original-lease',
            turnSequence: 1,
            runtimeTargetId: placement.targetId,
            physicalEpoch: 'a'.repeat(64),
            connectionGeneration: 1,
          },
          nativeResume: {
            locator: testEntityId('as', 'prior-login-session'),
            digest: 'f'.repeat(64),
          },
          previousReceiptId: 'original-login-receipt',
          clearedLogin: { referenceId: null, lastLeftAt: {} },
        },
      },
      recheckAuthority
    )
  ).rejects.toMatchObject({ code: 'credential_binding_unavailable', status: 503 });
  expect(recheckAuthority).toHaveBeenCalledOnce();
  expect(effect).not.toHaveBeenCalled();
});
