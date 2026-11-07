import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
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

import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  fenceNanoHostRuntimeTargetAfterRestart,
  getNanoHostRuntimeTarget,
  readConfiguredNanoHostRuntimeTargetStatus,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

const targetId = 'runtime-target-test';
const physicalEpochA = 'a'.repeat(64);
const physicalEpochB = 'b'.repeat(64);

describe('durable NanoHost RuntimeTarget authority', () => {
  it('accepts readiness only for an existing exact allocated generation and identity', async () => {
    const missingDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-ready-missing-')));
    applyMigrations(missingDb);
    await expect(
      upsertNanoHostRuntimeTarget(missingDb, {
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
    expect(getNanoHostRuntimeTarget(missingDb, targetId)).toBeNull();
    missingDb.sqlite.close();

    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-ready-exact-')));
    applyMigrations(coreDb);
    await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    const before = getNanoHostRuntimeTarget(coreDb, targetId);
    for (const conflicting of [
      { connectionGeneration: 2 },
      { connectionGeneration: 0 },
      { identityId: 'nanohost-other' },
      { deploymentId: 'deployment-other' },
    ]) {
      await expect(
        upsertNanoHostRuntimeTarget(coreDb, {
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
      expect(getNanoHostRuntimeTarget(coreDb, targetId)).toEqual(before);
    }
    coreDb.sqlite.close();
  });

  it('allocates generation one then durable successors without reuse or overflow', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-generation-'));
    let coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    const first = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
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
    coreDb.sqlite.close();

    coreDb = openCoreDb(dataRoot);
    const successor = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:01:00.000Z',
      targetId,
    });
    expect(successor.connectionGeneration).toBe(2);

    coreDb.sqlite
      .prepare('UPDATE nanohost_runtime_targets SET connection_generation = ? WHERE target_id = ?')
      .run(Number.MAX_SAFE_INTEGER, targetId);
    await expect(
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:02:00.000Z',
        targetId,
      })
    ).rejects.toThrow(/generation|overflow/i);
    expect(getNanoHostRuntimeTarget(coreDb, targetId)?.connectionGeneration).toBe(
      Number.MAX_SAFE_INTEGER
    );
    coreDb.sqlite.close();
  });

  it('fences only the exact current connection generation without changing its high-water mark', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-target-')));
    applyMigrations(coreDb);

    try {
      const initial = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:00.000Z',
        targetId,
      });
      await upsertNanoHostRuntimeTarget(coreDb, {
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
        recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: initial.connectionGeneration,
          closedGeneration: initial.connectionGeneration + 1,
          observedAt: '2026-08-10T00:00:03.000Z',
          targetId,
        })
      ).rejects.toThrow(/generation|current/i);
      await fenceNanoHostRuntimeTargetAfterRestart(coreDb, '2026-08-10T00:00:03.000Z');
      expect(getNanoHostRuntimeTarget(coreDb, targetId)).toMatchObject({
        connectionGeneration: initial.connectionGeneration,
        freshEmpty: false,
        predecessorFenced: true,
        ready: false,
        physicalEpoch: null,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves one physical Epoch across reconnect readiness and rejects a changed witness in one ready generation', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-epoch-')));
    applyMigrations(coreDb);
    try {
      const first = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:00.000Z',
        targetId,
      });
      const ready = await upsertNanoHostRuntimeTarget(coreDb, {
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
          await upsertNanoHostRuntimeTarget(coreDb, {
            ...ready,
            observedAt: '2026-08-10T00:00:02.000Z',
            physicalEpoch: physicalEpochA,
          })
        ).physicalEpoch
      ).toBe(physicalEpochA);
      await expect(
        upsertNanoHostRuntimeTarget(coreDb, {
          ...ready,
          observedAt: '2026-08-10T00:00:03.000Z',
          physicalEpoch: physicalEpochB,
        })
      ).rejects.toThrow(/physical Epoch changed/i);
      expect(getNanoHostRuntimeTarget(coreDb, targetId)?.physicalEpoch).toBe(physicalEpochA);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves successor readiness when a fenced predecessor closes late', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-stale-close-')));
    applyMigrations(coreDb);
    try {
      await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:00.000Z',
        targetId,
      });
      const successor = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:01.000Z',
        targetId,
      });
      const readySuccessor = await upsertNanoHostRuntimeTarget(coreDb, {
        ...successor,
        freshEmpty: true,
        observedAt: '2026-08-10T00:00:02.000Z',
        physicalEpoch: physicalEpochB,
        predecessorFenced: true,
        ready: true,
      });

      expect(
        await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: successor.connectionGeneration,
          closedGeneration: 1,
          observedAt: '2026-08-10T00:00:03.000Z',
          targetId,
        })
      ).toEqual(readySuccessor);
    } finally {
      coreDb.sqlite.close();
    }
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

    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-status-')));
    applyMigrations(coreDb);
    const config = {
      deploymentId: testEntityId('dep', 'deployment-test'),
      identityId: 'nanohost-test',
    };
    expect(readConfiguredNanoHostRuntimeTargetStatus({ coreDb, mode: 'server' })).toMatchObject({
      code: 'nanohost_transport_config_unavailable',
      ok: false,
    });
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({ coreDb, mode: 'server', nanoHostConfig: config })
    ).toMatchObject({ code: 'nanohost_runtime_target_not_found', ok: false });

    const allocated = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...config,
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId: config.identityId,
    });
    const unready = readConfiguredNanoHostRuntimeTargetStatus({
      coreDb,
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

    await upsertNanoHostRuntimeTarget(coreDb, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-08-10T00:00:01.000Z',
      physicalEpoch: physicalEpochA,
      predecessorFenced: true,
      ready: true,
    });
    const ready = readConfiguredNanoHostRuntimeTargetStatus({
      coreDb,
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

    coreDb.sqlite
      .prepare('UPDATE nanohost_runtime_targets SET deployment_id = ?')
      .run('deployment-other');
    expect(
      readConfiguredNanoHostRuntimeTargetStatus({ coreDb, mode: 'server', nanoHostConfig: config })
    ).toMatchObject({ code: 'nanohost_runtime_target_not_found', ok: false });
    coreDb.sqlite.close();
  });
});

it('acknowledges RuntimeTarget allocation, readiness, close and restart with read-only Main and durable reopen', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-target-native-reopen-'));
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  coreDb.sqlite.pragma('query_only = ON');
  try {
    const first = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
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
    const ready = await upsertNanoHostRuntimeTarget(coreDb, {
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
    expect(getNanoHostRuntimeTarget(coreDb, targetId)).toEqual(ready);
    // Storage requires acknowledgement after the covering FULL commit, before reopen.
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    coreDb.sqlite.pragma('query_only = ON');
    expect(getNanoHostRuntimeTarget(coreDb, targetId)).toEqual(ready);
    const closed = await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
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
    const successor = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:03.000Z',
      targetId,
    });
    expect(successor.connectionGeneration).toBe(2);
    const readySuccessor = await upsertNanoHostRuntimeTarget(coreDb, {
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
    const fenced = await fenceNanoHostRuntimeTargetAfterRestart(coreDb, '2026-08-10T00:00:05.000Z');
    expect(fenced).toEqual({
      ...readySuccessor,
      ready: false,
      freshEmpty: false,
      physicalEpoch: null,
      observedAt: '2026-08-10T00:00:05.000Z',
    });
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    coreDb.sqlite.pragma('query_only = ON');
    expect(getNanoHostRuntimeTarget(coreDb, targetId)).toEqual(fenced);
  } finally {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('rolls back each complete RuntimeTarget tuple when the native SQL transition fails', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-target-native-rollback-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  try {
    const allocated = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:00:00.000Z',
      targetId,
    });
    const ready = await upsertNanoHostRuntimeTarget(coreDb, {
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
    coreDb.sqlite.exec(`CREATE TRIGGER reject_target_transition
      AFTER UPDATE ON nanohost_runtime_targets
      BEGIN SELECT RAISE(ABORT, 'injected RuntimeTarget transition failure'); END`);
    coreDb.sqlite.pragma('query_only = ON');
    const before = coreDb.sqlite.prepare('SELECT * FROM nanohost_runtime_targets').all();
    const transitions = [
      () =>
        allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
          deploymentId: 'deployment-test',
          identityId: 'nanohost-test',
          observedAt: '2026-08-10T00:00:02.000Z',
          targetId,
        }),
      () =>
        upsertNanoHostRuntimeTarget(coreDb, {
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
        recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: null,
          closedGeneration: allocated.connectionGeneration,
          observedAt: '2026-08-10T00:00:02.000Z',
          targetId,
        }),
      () => fenceNanoHostRuntimeTargetAfterRestart(coreDb, '2026-08-10T00:00:02.000Z'),
    ];
    for (const transition of transitions) {
      await expect(Promise.resolve().then(transition)).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      expect(getNanoHostRuntimeTarget(coreDb, targetId)).toEqual(ready);
      // The public projection omits last_fresh_ready_at; inspect it to prove whole-tuple rollback.
      expect(coreDb.sqlite.prepare('SELECT * FROM nanohost_runtime_targets').all()).toEqual(before);
    }
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec('DROP TRIGGER reject_target_transition');
    coreDb.sqlite.pragma('query_only = ON');
    expect(
      await fenceNanoHostRuntimeTargetAfterRestart(coreDb, '2026-08-10T00:00:03.000Z')
    ).toMatchObject({
      connectionGeneration: 1,
      predecessorFenced: true,
      ready: false,
      freshEmpty: false,
      physicalEpoch: null,
    });
  } finally {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
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
function evaluateRuntimeTargetBootFence(coreDb: CoreDb) {
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
  const nativeFence = vi.fn(fenceNanoHostRuntimeTargetAfterRestart);
  const bindings = {
    coreDb,
    dataRoot: coreDb.dataRoot,
    workspaceMutationAdmission: {},
    requireBootValue: (value: unknown) => value,
    restoreWorkspaceDeletionMutationAdmission: () => undefined,
    fenceNanoHostRuntimeTargetAfterRestart: nativeFence,
    discardAbandonedWorkspaceStaging: continuation,
  };
  const javascript = transpileModule(`const bootRecovery = ${run.getText(sourceFile)};`, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const bootRecovery = new Function(
    ...Object.keys(bindings),
    `${javascript}\nreturn bootRecovery;`
  )(...Object.values(bindings)) as () => Promise<unknown>;
  return {
    continuation,
    nativeFence,
    run: async () => {
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

/** Retains a valid target through its public owner and an actual close/reopen. */
async function retainBootTarget(fixture: ReturnType<typeof createTargetBootFixture>, ready = true) {
  const allocated = await allocateNanoHostRuntimeTargetConnectionGeneration(fixture.coreDb, {
    targetId: 'boot-target',
    identityId: 'boot-host',
    deploymentId: 'boot-deployment',
    observedAt: '2026-08-10T00:00:00.000Z',
  });
  await upsertNanoHostRuntimeTarget(fixture.coreDb, {
    ...allocated,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: '2026-08-10T00:00:01.000Z',
  });
  if (!ready) {
    await fenceNanoHostRuntimeTargetAfterRestart(fixture.coreDb, '2026-08-10T00:00:02.000Z');
  }
  await shutdownControlStoreWorkerClient();
  fixture.coreDb.sqlite.close();
  fixture.coreDb = openCoreDb(fixture.dataRoot);
}

describe('NanoCore boot RuntimeTarget fencing', () => {
  it('continues an empty boot without posting a native target mutation', async () => {
    const fixture = createTargetBootFixture();
    const boot = evaluateRuntimeTargetBootFence(fixture.coreDb);

    await boot.run();

    expect(boot.continuation).toHaveBeenCalledTimes(1);
    expect(boot.nativeFence).not.toHaveBeenCalled();
    expect(getNanoHostRuntimeTarget(fixture.coreDb, 'boot-target')).toBeNull();
  });

  it.each([true, false])(
    'awaits the native fence for a retained target with ready=%s',
    async (ready) => {
      const fixture = createTargetBootFixture();
      await retainBootTarget(fixture, ready);
      const before = getNanoHostRuntimeTarget(fixture.coreDb, 'boot-target');
      const boot = evaluateRuntimeTargetBootFence(fixture.coreDb);
      // The existing native posting hold delays the real acknowledgement, not a fabricated success.
      const resume = await getControlStoreWorkerClient().pauseForDataRootBackup();
      const running = boot.run();
      try {
        await vi.waitFor(() => expect(boot.nativeFence).toHaveBeenCalledTimes(1));
        await setImmediate();
        // Bootstrap Readiness: phase 8 finishes before product/listener admission.
        expect(boot.continuation).not.toHaveBeenCalled();
        expect(getNanoHostRuntimeTarget(fixture.coreDb, 'boot-target')).toEqual(before);
      } finally {
        resume();
        await running;
      }
      expect(boot.continuation).toHaveBeenCalledTimes(1);
      expect(getNanoHostRuntimeTarget(fixture.coreDb, 'boot-target')).toMatchObject({
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

  it('refuses continuation and preserves the target when native fencing fails', async () => {
    const fixture = createTargetBootFixture();
    await retainBootTarget(fixture);
    const before = getNanoHostRuntimeTarget(fixture.coreDb, 'boot-target');
    // Fault injection follows valid owner setup; no successful durable state is fabricated.
    fixture.coreDb.sqlite.exec(`CREATE TRIGGER reject_boot_fence
      AFTER UPDATE ON nanohost_runtime_targets
      BEGIN SELECT RAISE(ABORT, 'injected boot fence refusal'); END`);
    const boot = evaluateRuntimeTargetBootFence(fixture.coreDb);

    await expect(boot.run()).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });

    expect(boot.nativeFence).toHaveBeenCalledTimes(1);
    expect(boot.continuation).not.toHaveBeenCalled();
    expect(getNanoHostRuntimeTarget(fixture.coreDb, 'boot-target')).toEqual(before);
  });
});
