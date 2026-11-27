import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import {
  type ArrowFunction,
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  ModuleKind,
  type Node,
  ScriptTarget,
  transpileModule,
} from 'typescript6';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNanoHostOwner } from '../app.js';

import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, serverStoragePath } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createNanoHostCoreReads } from '../storage/nanohost-core-reads.js';
import { nanoHostStoreDescriptor } from '../storage/nanohost-store-descriptor.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import {
  type AllocateNanoHostRuntimeTargetConnectionGenerationInput,
  getNanoHostRuntimeTarget,
  type RecordNanoHostRuntimeTargetConnectionCloseInput,
  readConfiguredNanoHostRuntimeTargetStatus,
  type UpsertNanoHostRuntimeTargetInput,
} from './nanohost-runtime-target.js';

const targetId = 'runtime-target-test';
const physicalEpochA = 'a'.repeat(64);
const physicalEpochB = 'b'.repeat(64);

type TargetOwner = ReturnType<typeof openNanoHostTestOwner>;

async function allocateTarget(
  owner: TargetOwner,
  input: AllocateNanoHostRuntimeTargetConnectionGenerationInput
) {
  const target = await owner.transition({ kind: 'allocate', ...input });
  if (!target) throw new Error('Original RuntimeTarget allocation has no result.');
  return target;
}

async function markTargetReady(owner: TargetOwner, input: UpsertNanoHostRuntimeTargetInput) {
  const {
    targetId,
    identityId,
    deploymentId,
    connectionGeneration,
    observedAt,
    physicalEpoch,
    predecessorFenced,
    ready,
    freshEmpty,
  } = input;
  const target = await owner.transition({
    kind: 'ready',
    targetId,
    identityId,
    deploymentId,
    connectionGeneration,
    observedAt,
    physicalEpoch,
    predecessorFenced,
    ready,
    freshEmpty,
  });
  if (!target) throw new Error('Original RuntimeTarget readiness has no result.');
  return target;
}

function closeTarget(owner: TargetOwner, input: RecordNanoHostRuntimeTargetConnectionCloseInput) {
  return owner.transition({ kind: 'close', ...input });
}

function restartTarget(owner: TargetOwner, observedAt: string) {
  return owner.transition({ kind: 'restart', observedAt });
}

describe('durable NanoHost RuntimeTarget authority', () => {
  it('accepts readiness only for an existing exact allocated generation and identity', async () => {
    const missing = openNanoHostTestOwner();
    await expect(
      markTargetReady(missing, {
        connectionGeneration: 1,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:01.000Z',
        physicalEpoch: physicalEpochA,
        predecessorFenced: true,
        ready: true,
        targetId,
      })
    ).rejects.toThrow(/configured|allocated|target/i);
    expect(getNanoHostRuntimeTarget(missing, targetId)).toBeNull();

    const owner = openNanoHostTestOwner();
    await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    const before = getNanoHostRuntimeTarget(owner, targetId);
    for (const conflicting of [
      { connectionGeneration: 2 },
      { connectionGeneration: 0 },
      { identityId: 'nanohost-other' },
      { deploymentId: 'deployment-other' },
    ]) {
      await expect(
        markTargetReady(owner, {
          connectionGeneration: 1,
          deploymentId: 'deployment-test',
          freshEmpty: true,
          identityId: 'nanohost-test',
          observedAt: '2026-08-10T00:00:01.000Z',
          physicalEpoch: physicalEpochA,
          predecessorFenced: true,
          ready: true,
          targetId,
          ...conflicting,
        })
      ).rejects.toThrow(/generation|identity|deployment/i);
      expect(getNanoHostRuntimeTarget(owner, targetId)).toEqual(before);
    }
  });

  it('allocates generation one then durable successors without reuse or overflow', async () => {
    const owner = openNanoHostTestOwner();

    const first = await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    expect(first).toMatchObject({
      connectionGeneration: 1,
      predecessorFenced: false,
      ready: false,
    });
    await owner.reopen();
    const successor = await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:01:00.000Z',
      targetId,
    });
    expect(successor.connectionGeneration).toBe(2);

    owner.setup((sqlite) =>
      sqlite
        .prepare(
          'UPDATE nanohost_runtime_targets SET connection_generation = ? WHERE target_id = ?'
        )
        .run(Number.MAX_SAFE_INTEGER, targetId)
    );
    await expect(
      allocateTarget(owner, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:02:00.000Z',
        targetId,
      })
    ).rejects.toThrow(/generation|overflow/i);
    expect(getNanoHostRuntimeTarget(owner, targetId)?.connectionGeneration).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('fences only the exact current connection generation without changing its high-water mark', async () => {
    const owner = openNanoHostTestOwner();

    const initial = await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    await markTargetReady(owner, {
      connectionGeneration: initial.connectionGeneration,
      deploymentId: 'deployment-test',
      freshEmpty: true,
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:02.000Z',
      physicalEpoch: physicalEpochA,
      predecessorFenced: true,
      ready: true,
      targetId,
    });
    await expect(
      closeTarget(owner, {
        authoritativeGeneration: initial.connectionGeneration,
        closedGeneration: initial.connectionGeneration + 1,
        observedAt: '2026-08-10T00:00:03.000Z',
        targetId,
      })
    ).rejects.toThrow(/generation|current/i);
    await restartTarget(owner, '2026-08-10T00:00:03.000Z');
    expect(getNanoHostRuntimeTarget(owner, targetId)).toMatchObject({
      connectionGeneration: initial.connectionGeneration,
      freshEmpty: false,
      predecessorFenced: true,
      ready: false,
      physicalEpoch: null,
    });
  });

  it('preserves one physical Epoch across reconnect readiness and rejects a changed witness in one ready generation', async () => {
    const owner = openNanoHostTestOwner();
    const first = await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    const ready = await markTargetReady(owner, {
      ...first,
      freshEmpty: true,
      observedAt: '2026-08-10T00:00:01.000Z',
      physicalEpoch: physicalEpochA,
      predecessorFenced: true,
      ready: true,
    });
    expect(ready.physicalEpoch).toBe(physicalEpochA);
    expect(
      (
        await markTargetReady(owner, {
          ...ready,
          observedAt: '2026-08-10T00:00:02.000Z',
          physicalEpoch: physicalEpochA,
        })
      ).physicalEpoch
    ).toBe(physicalEpochA);
    await expect(
      markTargetReady(owner, {
        ...ready,
        observedAt: '2026-08-10T00:00:03.000Z',
        physicalEpoch: physicalEpochB,
      })
    ).rejects.toThrow(/physical Epoch changed/i);
    expect(getNanoHostRuntimeTarget(owner, targetId)?.physicalEpoch).toBe(physicalEpochA);
  });

  it('preserves successor readiness when a fenced predecessor closes late', async () => {
    const owner = openNanoHostTestOwner();
    await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    const successor = await allocateTarget(owner, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:01.000Z',
      targetId,
    });
    const readySuccessor = await markTargetReady(owner, {
      ...successor,
      freshEmpty: true,
      observedAt: '2026-08-10T00:00:02.000Z',
      physicalEpoch: physicalEpochB,
      predecessorFenced: true,
      ready: true,
    });

    expect(
      await closeTarget(owner, {
        authoritativeGeneration: successor.connectionGeneration,
        closedGeneration: 1,
        observedAt: '2026-08-10T00:00:03.000Z',
        targetId,
      })
    ).toEqual(readySuccessor);
  });
});

describe('configured NanoHost RuntimeTarget redacted status', () => {
  it('returns ready, unready, and missing results with the stored physicalEpoch', async () => {
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({ coreDb: undefined, mode: 'local' })
    ).toMatchObject({ code: 'nanohost_transport_admin_server_mode_required', ok: false });
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({ coreDb: undefined, mode: 'server' })
    ).toMatchObject({ code: 'nanohost_transport_storage_unavailable', ok: false });

    const owner = openNanoHostTestOwner();
    const readNanoHostTarget = createNanoHostCoreReads(owner.storage.owner).readTarget;
    const config = {
      deploymentId: testEntityId('dep', 'deployment-test'),
      identityId: 'nanohost-test',
    };
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({
        coreDb: undefined,
        readNanoHostTarget,
        mode: 'server',
      })
    ).toMatchObject({
      code: 'nanohost_transport_config_unavailable',
      ok: false,
    });
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({
        coreDb: undefined,
        readNanoHostTarget,
        mode: 'server',
        nanoHostConfig: config,
      })
    ).toMatchObject({ code: 'nanohost_runtime_target_not_found', ok: false });

    expect(
      readConfiguredNanoHostRuntimeTargetStatus({
        coreDb: owner,
        mode: 'server',
        nanoHostConfig: config,
        readNanoHostTarget: () => ({ state: 'unavailable', owner: 'nanohost', reason: 'missing' }),
      })
    ).toMatchObject({ code: 'nanohost_transport_storage_unavailable', ok: false });

    const allocated = await allocateTarget(owner, {
      ...config,
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId: config.identityId,
    });
    const unready = readConfiguredNanoHostRuntimeTargetStatus({
      coreDb: undefined,
      readNanoHostTarget,
      mode: 'server',
      nanoHostConfig: config,
    });
    expect(unready).toEqual({
      ok: true,
      status: {
        connectionGeneration: allocated.connectionGeneration,
        deploymentId: config.deploymentId,
        freshEmpty: false,
        identityId: config.identityId,
        observedAt: '2026-08-10T00:00:00.000Z',
        physicalEpoch: null,
        predecessorFenced: false,
        ready: false,
      },
    });

    await markTargetReady(owner, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-08-10T00:00:01.000Z',
      physicalEpoch: physicalEpochA,
      predecessorFenced: true,
      ready: true,
    });
    const ready = readConfiguredNanoHostRuntimeTargetStatus({
      coreDb: undefined,
      readNanoHostTarget,
      mode: 'server',
      nanoHostConfig: config,
    });
    expect(ready).toEqual({
      ok: true,
      status: {
        connectionGeneration: allocated.connectionGeneration,
        deploymentId: config.deploymentId,
        freshEmpty: true,
        identityId: config.identityId,
        observedAt: '2026-08-10T00:00:01.000Z',
        physicalEpoch: physicalEpochA,
        predecessorFenced: true,
        ready: true,
      },
    });
    expect(JSON.stringify(ready)).toContain('physicalEpoch');
    expect(JSON.stringify(ready)).toContain(physicalEpochA);

    owner.setup((sqlite) =>
      sqlite
        .prepare('UPDATE nanohost_runtime_targets SET deployment_id = ?')
        .run('deployment-other')
    );
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({
        coreDb: undefined,
        readNanoHostTarget,
        mode: 'server',
        nanoHostConfig: config,
      })
    ).toMatchObject({ code: 'nanohost_runtime_target_not_found', ok: false });
  });
});

it('acknowledges RuntimeTarget allocation, readiness, close and restart with read-only Main and durable reopen', async () => {
  const owner = openNanoHostTestOwner();
  expect(owner.sqlite.readonly).toBe(true);
  const first = await allocateTarget(owner, {
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    observedAt: '2026-08-10T00:00:00.000Z',
    targetId,
  });
  expect(first).toMatchObject({
    connectionGeneration: 1,
    ready: false,
    freshEmpty: false,
    predecessorFenced: false,
    physicalEpoch: null,
  });
  const ready = await markTargetReady(owner, {
    connectionGeneration: first.connectionGeneration,
    deploymentId: first.deploymentId,
    identityId: first.identityId,
    targetId: first.targetId,
    freshEmpty: true,
    observedAt: '2026-08-10T00:00:01.000Z',
    physicalEpoch: physicalEpochA,
    predecessorFenced: true,
    ready: true,
  });
  expect(getNanoHostRuntimeTarget(owner, targetId)).toEqual(ready);
  // Storage requires acknowledgement after the covering FULL commit, before reopen.
  await owner.reopen();
  expect(getNanoHostRuntimeTarget(owner, targetId)).toEqual(ready);
  const closed = await closeTarget(owner, {
    authoritativeGeneration: null,
    closedGeneration: first.connectionGeneration,
    observedAt: '2026-08-10T00:00:02.000Z',
    targetId,
  });
  // NanoHost Runtime And Transport: readiness loss clears the Epoch in the same tuple.
  expect(closed).toEqual({
    ...ready,
    ready: false,
    freshEmpty: false,
    physicalEpoch: null,
    observedAt: '2026-08-10T00:00:02.000Z',
  });
  const successor = await allocateTarget(owner, {
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    observedAt: '2026-08-10T00:00:03.000Z',
    targetId,
  });
  expect(successor.connectionGeneration).toBe(2);
  const readySuccessor = await markTargetReady(owner, {
    connectionGeneration: successor.connectionGeneration,
    deploymentId: successor.deploymentId,
    identityId: successor.identityId,
    targetId: successor.targetId,
    freshEmpty: true,
    observedAt: '2026-08-10T00:00:04.000Z',
    physicalEpoch: physicalEpochB,
    predecessorFenced: true,
    ready: true,
  });
  const fenced = await restartTarget(owner, '2026-08-10T00:00:05.000Z');
  expect(fenced).toEqual({
    ...readySuccessor,
    ready: false,
    freshEmpty: false,
    physicalEpoch: null,
    observedAt: '2026-08-10T00:00:05.000Z',
  });
  await owner.reopen();
  expect(getNanoHostRuntimeTarget(owner, targetId)).toEqual(fenced);
});

it('rolls back each complete RuntimeTarget tuple when the native SQL transition fails', async () => {
  const owner = openNanoHostTestOwner();
  const allocated = await allocateTarget(owner, {
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    observedAt: '2026-08-10T00:00:00.000Z',
    targetId,
  });
  const ready = await markTargetReady(owner, {
    connectionGeneration: allocated.connectionGeneration,
    deploymentId: allocated.deploymentId,
    identityId: allocated.identityId,
    targetId: allocated.targetId,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    observedAt: '2026-08-10T00:00:01.000Z',
    physicalEpoch: physicalEpochA,
  });
  // Deliberate failure after valid owner setup; no successful durable state is fabricated.
  owner.setup((sqlite) =>
    sqlite.exec(`CREATE TRIGGER reject_target_transition
      AFTER UPDATE ON nanohost_runtime_targets
      BEGIN SELECT RAISE(ABORT, 'injected RuntimeTarget transition failure'); END`)
  );
  expect(owner.sqlite.readonly).toBe(true);
  const before = owner.sqlite.prepare('SELECT * FROM nanohost_runtime_targets').all();
  const transitions = [
    () =>
      allocateTarget(owner, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:02.000Z',
        targetId,
      }),
    () =>
      markTargetReady(owner, {
        connectionGeneration: ready.connectionGeneration,
        deploymentId: ready.deploymentId,
        identityId: ready.identityId,
        targetId: ready.targetId,
        freshEmpty: true,
        predecessorFenced: true,
        ready: true,
        physicalEpoch: physicalEpochA,
        observedAt: '2026-08-10T00:00:02.000Z',
      }),
    () =>
      closeTarget(owner, {
        authoritativeGeneration: null,
        closedGeneration: allocated.connectionGeneration,
        observedAt: '2026-08-10T00:00:02.000Z',
        targetId,
      }),
    () => restartTarget(owner, '2026-08-10T00:00:02.000Z'),
  ];
  for (const transition of transitions) {
    await expect(Promise.resolve().then(transition)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_TRIGGER',
    });
    expect(getNanoHostRuntimeTarget(owner, targetId)).toEqual(ready);
    // The public projection omits last_fresh_ready_at; inspect it to prove whole-tuple rollback.
    expect(owner.sqlite.prepare('SELECT * FROM nanohost_runtime_targets').all()).toEqual(before);
  }
  owner.setup((sqlite) => sqlite.exec('DROP TRIGGER reject_target_transition'));
  expect(await restartTarget(owner, '2026-08-10T00:00:03.000Z')).toMatchObject({
    connectionGeneration: 1,
    predecessorFenced: true,
    ready: false,
    freshEmpty: false,
    physicalEpoch: null,
  });
});

/** Reads the process entrypoint without starting its unrelated process owners. */
function readEntrypointSource(): string {
  return readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
}

/**
 * Executes the actual recovery phase through its first post-fence continuation.
 * The entrypoint has no import-safe boot API.
 * Extraction observes its hidden pre-listen responsibility without starting unrelated process owners.
 * Native target discovery, deciding SQL and acknowledgement remain real.
 */
function evaluateRuntimeTargetBootFence(coreDb: CoreDb, beforeFence?: Promise<void>) {
  const sourceFile = createSourceFile(
    'index.ts',
    readEntrypointSource(),
    ScriptTarget.Latest,
    true
  );
  let run: ArrowFunction | undefined;
  const visit = (node: Node): void => {
    if (isObjectLiteralExpression(node)) {
      const phaseName = node.properties.find(
        (property) =>
          isPropertyAssignment(property) &&
          property.name.getText(sourceFile) === 'name' &&
          isStringLiteral(property.initializer) &&
          property.initializer.text === 'scheduler-restart-recovery'
      );
      if (phaseName) {
        const property = node.properties.find(
          (property) =>
            isPropertyAssignment(property) && property.name.getText(sourceFile) === 'run'
        );
        if (property && isPropertyAssignment(property) && isArrowFunction(property.initializer)) {
          run = property.initializer;
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!run) throw new Error('Scheduler restart phase was not found in the NanoCore entrypoint.');
  const boundary = new Error('Reached post-fence boot continuation.');
  const continuation = vi.fn(() => {
    throw boundary;
  });
  const fenceEntered = Promise.withResolvers<void>();
  const nativeFence = vi.fn(
    async (...args: Parameters<typeof transitionAdmittedNanoHostRuntimeTarget>) => {
      fenceEntered.resolve();
      await beforeFence;
      return transitionAdmittedNanoHostRuntimeTarget(...args);
    }
  );
  const bindings = {
    coreDb,
    dataRoot: coreDb.dataRoot,
    requireBootValue: (value: unknown) => value,
    restoreWorkspaceDeletionMutationAdmission: () => undefined,
    getControlStoreWorkerClient,
    prepareNanoHostOwner,
    nanoHostStoreDescriptor,
    freshCoreInitialization: false,
    nanoHostStorage: { state: 'unavailable', owner: 'nanohost', reason: 'missing' },
    transitionAdmittedNanoHostRuntimeTarget: nativeFence,
    discardAbandonedWorkspaceStaging: continuation,
  };
  const javascript = transpileModule(`const bootRecovery = ${run.getText(sourceFile)};`, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const [bootRecovery, selectedStorage] = new Function(
    ...Object.keys(bindings),
    `${javascript}\nreturn [bootRecovery, () => nanoHostStorage];`
  )(...Object.values(bindings)) as [
    () => Promise<unknown>,
    () => Awaited<ReturnType<typeof prepareNanoHostOwner>>,
  ];
  return {
    continuation,
    fenceEntered: fenceEntered.promise,
    nativeFence,
    selectedStorage,
    run: async () => {
      if (!coreDb.sqlite.open) throw new Error('Core database was not initialized.');
      const { path, contentMount } = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
      await getControlStoreWorkerClient().open({
        database: `core:${path}`,
        path,
        dataRoot: coreDb.dataRoot,
        create: false,
        initialize: 'core',
        productOwner: { kind: 'server' },
        contentMount,
      });
      try {
        await bootRecovery();
      } catch (error) {
        if (error !== boundary) throw error;
      }
    },
  };
}

const targetBootFixtures: Array<{ coreDb: CoreDb; dataRoot: string }> = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const fixture of targetBootFixtures.splice(0)) {
    if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

/** Opens genuine empty Core authority for the boot composition tests. */
function createTargetBootFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-target-fence-'));
  const fixture = { coreDb: openCoreDb(dataRoot), dataRoot };
  targetBootFixtures.push(fixture);
  applyMigrations(fixture.coreDb);
  return fixture;
}

/** Retains a valid target through its acknowledged owner and an actual close/reopen. */
async function retainBootTarget(fixture: ReturnType<typeof createTargetBootFixture>, ready = true) {
  const { value: owner } = await openAdmittedTestNanoHost(fixture.coreDb);
  const configured = {
    targetId: 'boot-target',
    identityId: 'boot-host',
    deploymentId: readDataRootLayoutMarker(fixture.dataRoot).deploymentId,
    observedAt: '2026-08-10T00:00:00.000Z',
  };
  await expect(
    transitionAdmittedNanoHostRuntimeTarget(owner, { kind: 'allocate', ...configured })
  ).resolves.toMatchObject({ state: 'ready', value: { connectionGeneration: 1 } });
  if (ready)
    await expect(
      transitionAdmittedNanoHostRuntimeTarget(owner, {
        kind: 'ready',
        ...configured,
        connectionGeneration: 1,
        ready: true,
        freshEmpty: true,
        predecessorFenced: true,
        physicalEpoch: 'a'.repeat(64),
      })
    ).resolves.toMatchObject({ state: 'ready', value: { ready: true } });
  await shutdownControlStoreWorkerClient();
}

function readBootTarget(dataRoot: string) {
  const path = serverStoragePath(dataRoot, 'nanohost');
  if (!existsSync(path)) return null;
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return getNanoHostRuntimeTarget({ sqlite }, 'boot-target');
  } finally {
    sqlite.close();
  }
}

describe('NanoCore boot RuntimeTarget fencing', () => {
  it('continues an empty boot without posting a native target mutation', async () => {
    const fixture = createTargetBootFixture();
    const boot = evaluateRuntimeTargetBootFence(fixture.coreDb);

    await boot.run();

    expect(boot.continuation).toHaveBeenCalledTimes(1);
    expect(boot.nativeFence).not.toHaveBeenCalled();
    expect(readBootTarget(fixture.dataRoot)).toBeNull();
  });

  it.each([true, false])(
    'awaits the native fence for a retained target with ready=%s',
    async (ready) => {
      const fixture = createTargetBootFixture();
      await retainBootTarget(fixture, ready);
      const before = readBootTarget(fixture.dataRoot);
      const gate = Promise.withResolvers<void>();
      const boot = evaluateRuntimeTargetBootFence(fixture.coreDb, gate.promise);
      const running = boot.run();
      try {
        await Promise.race([
          boot.fenceEntered,
          running.then(() => {
            throw new Error('The boot phase continued without fencing its retained target.');
          }),
        ]);
        await setImmediate();
        // Bootstrap Readiness: phase 8 finishes before product/listener admission.
        expect(boot.continuation).not.toHaveBeenCalled();
        expect(readBootTarget(fixture.dataRoot)).toEqual(before);
      } finally {
        gate.resolve();
        await running;
      }
      expect(boot.continuation).toHaveBeenCalledTimes(1);
      expect(readBootTarget(fixture.dataRoot)).toMatchObject({
        connectionGeneration: before?.connectionGeneration,
        ready: false,
        freshEmpty: false,
        physicalEpoch: null,
      });
    }
  );

  it('refuses continuation when target discovery cannot read Core authority', async () => {
    const fixture = createTargetBootFixture();
    const boot = evaluateRuntimeTargetBootFence(fixture.coreDb);
    fixture.coreDb.sqlite.close();

    await expect(boot.run()).rejects.toThrow();

    expect(boot.continuation).not.toHaveBeenCalled();
    expect(boot.nativeFence).not.toHaveBeenCalled();
  });

  it('holds NanoHost and preserves the target when native fencing fails', async () => {
    const fixture = createTargetBootFixture();
    await retainBootTarget(fixture);
    const before = readBootTarget(fixture.dataRoot);
    const gate = Promise.withResolvers<void>();
    const boot = evaluateRuntimeTargetBootFence(fixture.coreDb, gate.promise);
    const running = boot.run();
    try {
      await Promise.race([
        boot.fenceEntered,
        running.then(() => {
          throw new Error('The boot phase continued without fencing its retained target.');
        }),
      ]);
      // Inject only after storage admission, so the real original UPDATE reaches the fault.
      const sqlite = new Database(serverStoragePath(fixture.dataRoot, 'nanohost'), {
        fileMustExist: true,
      });
      try {
        sqlite.exec(`CREATE TRIGGER reject_boot_fence
          AFTER UPDATE ON nanohost_runtime_targets
          BEGIN SELECT RAISE(ABORT, 'injected boot fence refusal'); END`);
      } finally {
        sqlite.close();
      }
    } finally {
      gate.resolve();
      await running;
    }

    expect(boot.nativeFence).toHaveBeenCalledTimes(1);
    expect(boot.continuation).toHaveBeenCalledTimes(1);
    expect(boot.selectedStorage()).toMatchObject({ state: 'unavailable', owner: 'nanohost' });
    expect(readBootTarget(fixture.dataRoot)).toEqual(before);
  });
});
