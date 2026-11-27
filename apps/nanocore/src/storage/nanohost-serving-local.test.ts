// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { listNanoHostTransportTokenRecords } from '../auth/nanohost-transport-token-store.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from '../runtime/nanohost-harness.js';
import { readNanoHostMeasuredHarnessIdentity } from '../runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target-records.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import { readWorkerImageSettlement } from '../runtime/worker-image-settlements-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreReadDb } from './db.js';
import { ensureLayout } from './fs-layout.js';
import { ControlHarnessLifecycleInputSchema } from './harness-lifecycle-codecs.js';
import { createNanoHostCoreReads } from './nanohost-core-reads.js';
import {
  inspectNanoHostRuntimeTargetTransition,
  prepareNanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
  readPendingNanoHostEpochRetirement,
} from './nanohost-epoch-invalidation-native.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './nanohost-transport-owner.js';
import type { StorageResult } from './storage-owner.js';
import { ControlWorkerImageInputSchema } from './worker-image-codecs.js';

it('commits local Harness and image tuples without admitting mixed Core operations', async () => {
  const timestamp = '2026-11-21T00:00:00.000Z';
  const targetId = 'target-native';
  const physicalEpoch = 'f'.repeat(64);
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const harnessInstanceId = 'harness-native';
  const agentSessionRuntimeBindingId = 'binding-native';
  const inputs = [
    {
      kind: 'runtime.create',
      adapterId: 'codex',
      adapterVersion: 'fixture',
      harnessBindingRef: 'harness-binding',
      harnessCompatibilityKey: 'b'.repeat(64),
      harnessInstanceId,
      imageDigest,
      originPhysicalEpoch: physicalEpoch,
      runtimeTargetId: targetId,
      sandboxBindingRef: 'sandbox-binding',
      sandboxCompatibilityKey: 'c'.repeat(64),
      sandboxIntegrationBindingRef: 'sandbox-integration',
      sandboxRuntimeId: 'sandbox-runtime',
      timestamp,
    },
    {
      kind: 'session-binding.open',
      agentSessionCompatibilityKey: 'd'.repeat(64),
      agentSessionId: 'session-native',
      agentSessionRuntimeBindingId,
      effectiveSetupGeneration: 1,
      harnessInstanceId,
      threadId: 'thread-native',
      timestamp,
      workspaceId: 'workspace-native',
    },
  ].map((input) => ControlHarnessLifecycleInputSchema.nanoHostLocal.parse(input));
  const restore = { kind: 'sandbox.restore-admission', sandboxRuntimeId: 'sandbox-runtime' };
  expect(ControlHarnessLifecycleInputSchema.safeParse(restore).success).toBe(true);
  expect(ControlHarnessLifecycleInputSchema.nanoHostLocal.safeParse(restore).success).toBe(false);
  const image = {
    authoredArtifactId: 'ar_00000000-0000-7ce7-b2d8-9d02176fb5b5',
    authoredArtifactVersion: 1,
    authoredContentDigest: `sha256:${'b'.repeat(64)}`,
    inputDigest: `sha256:${'c'.repeat(64)}`,
    outcome: { kind: 'success', imageDigest },
  };
  const buildRequestId = '1'.repeat(64);
  const acquisitionRequestId = '2'.repeat(64);
  const build = ControlWorkerImageInputSchema.parse({
    kind: 'settlement',
    value: { ...image, operation: 'image.build', requestId: buildRequestId },
  });
  const acquisition = ControlWorkerImageInputSchema.parse({
    kind: 'settlement',
    value: { ...image, operation: 'image.acquire', requestId: acquisitionRequestId },
  });

  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-serving-local-'));
  const path = join(root, 'state.sqlite');
  try {
    const sqlite = new Database(path);
    try {
      migrate(drizzle(sqlite), {
        migrationsFolder: fileURLToPath(
          new URL('../../drizzle/extensions/nanohost/', import.meta.url)
        ),
      });
      const owner = { sqlite };
      const target = allocateNanoHostRuntimeTargetConnectionGeneration(owner, {
        deploymentId: 'deployment-native',
        identityId: 'identity-native',
        observedAt: timestamp,
        targetId,
      });
      upsertNanoHostRuntimeTarget(owner, {
        ...target,
        freshEmpty: true,
        physicalEpoch,
        predecessorFenced: true,
        ready: true,
      });
    } finally {
      sqlite.close();
    }
    const worker = new Worker(
      `
      const assert = require('node:assert/strict');
      const { workerData } = require('node:worker_threads');
      (async () => {
        const { applyControlHarnessLifecycle } = await import(workerData.handler);
        const { applyControlBackendSession } = await import(workerData.backendHandler);
        const { applyControlWorkerImage } = await import(workerData.imageHandler);
        const sqlite = new (require(workerData.sqlite))(workerData.path, { fileMustExist: true });
        try {
          sqlite.pragma('foreign_keys = ON');
          sqlite.pragma('synchronous = FULL');
          const owner = { sqlite };
          const applyHarness = input => sqlite.transaction(() =>
            applyControlHarnessLifecycle(owner, input)
          ).immediate();
          for (const input of workerData.inputs) assert.equal(applyHarness(input), null);
          assert.throws(() => applyHarness(workerData.restore), /transition precondition failed/);
          assert.throws(() => sqlite.transaction(() => applyControlBackendSession(owner, {
            kind: 'transition', attemptId: 'fixture-attempt', fromState: 'materializing', toState: 'launching',
          })).immediate(), /transition precondition failed/);
          const setup = workerData.inputs[0];
          for (const suffix of ['-later', '-accepting']) {
            assert.equal(applyHarness({
              ...setup,
              harnessBindingRef: setup.harnessBindingRef + suffix,
              harnessInstanceId: setup.harnessInstanceId + suffix,
              sandboxBindingRef: setup.sandboxBindingRef + suffix,
              sandboxIntegrationBindingRef: setup.sandboxIntegrationBindingRef + suffix,
              sandboxRuntimeId: setup.sandboxRuntimeId + suffix,
            }), null);
          }
          sqlite.transaction(() => {
            sqlite.prepare(
              "UPDATE sandbox_runtime_records SET drain_state='draining' WHERE sandbox_binding_ref IN (?, ?)"
            ).run(setup.sandboxBindingRef, setup.sandboxBindingRef + '-later');
          }).immediate();
          const applyImage = input => sqlite.transaction(() =>
            applyControlWorkerImage(owner, input)
          ).immediate();
          assert.equal(applyImage(workerData.build), null);
          assert.equal(applyImage(workerData.build), null);
          assert.throws(() => applyImage(workerData.acquisition), /transition precondition failed/);
        } finally {
          sqlite.close();
        }
      })().catch(error => { process.nextTick(() => { throw error; }); });
      `,
      {
        eval: true,
        workerData: {
          acquisition,
          backendHandler: new URL(
            '../../dist/storage/worker-backend-session-native.js',
            import.meta.url
          ).href,
          build,
          handler: new URL('../../dist/storage/harness-lifecycle-native.js', import.meta.url).href,
          imageHandler: new URL('../../dist/storage/worker-image-native.js', import.meta.url).href,
          inputs,
          path,
          restore,
          sqlite: createRequire(import.meta.url).resolve('better-sqlite3'),
        },
      }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`NanoHost fixture worker exited ${code}.`))
        );
      });
    } finally {
      await worker.terminate();
    }

    const reader = new Database(path, { fileMustExist: true, readonly: true });
    try {
      expect(
        readNanoHostMeasuredHarnessIdentity({ sqlite: reader }, agentSessionRuntimeBindingId)
      ).toBe(imageDigest);
      expect(readWorkerImageSettlement({ sqlite: reader }, buildRequestId)?.outcome).toEqual(
        image.outcome
      );
      expect(readWorkerImageSettlement({ sqlite: reader }, acquisitionRequestId)).toBeNull();

      const ready = <Value>(value: Value) => ({ state: 'ready', value }) as const;
      const observations = createNanoHostCoreReads({ read: (query) => ready(query(reader)) });
      expect(observations.readTarget(targetId)).toEqual(
        ready(expect.objectContaining({ targetId, physicalEpoch, ready: true }))
      );
      expect(observations.readBackendSession({ attemptId: 'absent-attempt' })).toEqual(ready(null));
      expect(observations.readBackendSession({ packageSnapshotId: 'absent-package' })).toEqual(
        ready(null)
      );
      expect(observations.readResident('sandbox-binding')).toEqual(
        ready({
          binding: 'sandbox-binding',
          origin: physicalEpoch,
          target: targetId,
          drain: 'draining',
        })
      );
      expect(observations.readResident('absent-binding')).toEqual(ready(null));
      expect(observations.listDrainingResidents(null, 1)).toEqual(
        ready({
          bindings: ['sandbox-binding'],
          next: 'sandbox-binding',
        })
      );
      expect(observations.listDrainingResidents('sandbox-binding', 1)).toEqual(
        ready({
          bindings: ['sandbox-binding-later'],
          next: null,
        })
      );
      const unavailable = { state: 'unavailable', owner: 'nanohost', reason: 'missing' } as const;
      const held = createNanoHostCoreReads({ read: () => unavailable });
      expect(held.readTarget(targetId)).toBe(unavailable);
      expect(held.listDrainingResidents(null, 1)).toBe(unavailable);
      expect(reader.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('uses the admitted FULL worker for Harness bindings and holds an old lifecycle across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-serving-worker-'));
  const worker = getControlStoreWorkerClient();
  let coreDb: ReturnType<typeof openCoreReadDb> | undefined;
  try {
    ensureLayout(root);
    const corePath = join(root, 'server/db/core.sqlite');
    await worker.open({
      database: `core:${corePath}`,
      path: corePath,
      create: true,
      initialize: 'core',
      productOwner: { kind: 'server' },
      dataRoot: root,
    });
    coreDb = openCoreReadDb(root);
    const table = coreDb.sqlite.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?"
    );
    for (const name of nanoHostStoreDescriptor.requiredTables) {
      expect(table.get(name)).toBeUndefined();
    }
    await expect(worker.provisionServerOwner(root, nanoHostStoreDescriptor)).resolves.toEqual({
      state: 'ready',
      owner: 'nanohost',
    });

    const bind = async () => {
      const bound = await worker.bindNanoHostOwner(
        root,
        {
          getWorkerBackendSession,
          listNanoHostTransportTokenRecords,
          prepareNanoHostRuntimeTargetTransition,
          readNanoHostEpochInvalidation,
          inspectNanoHostRuntimeTargetTransition,
          readPendingNanoHostEpochRetirement,
        },
        { enabled: () => true }
      );
      if (bound.state !== 'ready')
        throw new Error(`Expected the NanoHost owner, got ${bound.reason}.`);
      return bound.value;
    };
    const owner = await bind();
    const unexpectedEpochDecision = async (): Promise<never> => {
      throw new Error('A fresh target cannot retire a predecessor.');
    };
    const nativeStorage = {
      owner,
      kernel: {
        reserveHolderIntent: unexpectedEpochDecision,
        fenceNanoHostEpoch: unexpectedEpochDecision,
        inspectNanoHostEpochFence: unexpectedEpochDecision,
      },
    };
    const target = {
      targetId: 'joined-target',
      deploymentId: 'joined-deployment',
      identityId: 'joined-identity',
      observedAt: '2026-11-21T00:00:00.000Z',
    };
    const physicalEpoch = 'e'.repeat(64);
    await expect(
      transitionAdmittedNanoHostRuntimeTarget(nativeStorage, {
        kind: 'allocate',
        ...target,
      })
    ).resolves.toMatchObject({ state: 'ready', value: { connectionGeneration: 1 } });
    await expect(
      transitionAdmittedNanoHostRuntimeTarget(nativeStorage, {
        kind: 'ready',
        ...target,
        connectionGeneration: 1,
        predecessorFenced: true,
        ready: true,
        freshEmpty: true,
        physicalEpoch,
      })
    ).resolves.toMatchObject({ state: 'ready', value: { physicalEpoch, ready: true } });

    const selector = { workspaceId: 'joined-workspace', threadId: 'joined-thread' };
    const readThreadBinding = (bound: StorageResult<'nanohost', typeof owner>) => {
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostRecovery: { owner: bound },
      });
      const executor = runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend;
      };
      return () => executor.backend.readThreadAgentSessionBinding?.(selector);
    };
    const closed = readThreadBinding({
      state: 'unavailable',
      owner: 'nanohost',
      reason: 'disabled',
    });
    expect(closed).toThrow(expect.objectContaining({ code: 'operation_storage_unavailable' }));
    const readOriginal = readThreadBinding({ state: 'ready', value: owner });
    const harnessInstanceId = 'joined-harness';
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    await createNanoHostHarnessRuntime(owner, {
      adapterId: 'codex',
      adapterVersion: 'fixture',
      harnessBindingRef: 'joined-harness-binding',
      harnessCompatibilityKey: 'b'.repeat(64),
      harnessInstanceId,
      imageDigest,
      originPhysicalEpoch: physicalEpoch,
      runtimeTargetId: target.targetId,
      sandboxBindingRef: 'joined-sandbox-binding',
      sandboxCompatibilityKey: 'c'.repeat(64),
      sandboxIntegrationBindingRef: 'joined-sandbox-integration',
      sandboxRuntimeId: 'joined-sandbox',
      timestamp: target.observedAt,
    });
    expect(readOriginal()).toBeNull();
    const binding = {
      ...selector,
      agentSessionCompatibilityKey: 'd'.repeat(64),
      agentSessionId: 'joined-session',
      agentSessionRuntimeBindingId: 'joined-session-binding',
      effectiveSetupGeneration: 1,
      harnessInstanceId,
      timestamp: target.observedAt,
    };
    await openNanoHostAgentSessionBinding(owner, binding);
    expect(readOriginal()).toEqual({ agentSessionId: binding.agentSessionId });
    await worker.closeServerOwner(root, 'nanohost');
    expect(readOriginal).toThrow(
      expect.objectContaining({
        code: 'operation_storage_unavailable',
        status: 503,
      })
    );
    await expect(openNanoHostAgentSessionBinding(owner, binding)).rejects.toMatchObject({
      commit: 'not-committed',
    });
    const reopened = await bind();
    expect(readThreadBinding({ state: 'ready', value: reopened })()).toEqual({
      agentSessionId: binding.agentSessionId,
    });
    expect(readOriginal).toThrow(
      expect.objectContaining({ code: 'operation_storage_unavailable' })
    );
  } finally {
    coreDb?.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
  }
});
