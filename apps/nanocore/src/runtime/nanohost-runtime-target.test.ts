import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  fenceNanoHostRuntimeTargetAfterRestart,
  getNanoHostRuntimeTarget,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';

const targetId = 'runtime-target-test';

describe('durable NanoHost RuntimeTarget authority', () => {
  it('accepts readiness only for an existing exact allocated generation and identity', () => {
    const missingDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-ready-missing-')));
    applyMigrations(missingDb);
    expect(() =>
      upsertNanoHostRuntimeTarget(missingDb, {
        connectionGeneration: 1,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:01.000Z',
        predecessorFenced: true,
        ready: true,
        targetId,
      })
    ).toThrow(/configured|allocated|target/i);
    expect(getNanoHostRuntimeTarget(missingDb, targetId)).toBeNull();
    missingDb.sqlite.close();

    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-ready-exact-')));
    applyMigrations(coreDb);
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
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
      expect(() =>
        upsertNanoHostRuntimeTarget(coreDb, {
          connectionGeneration: 1,
          deploymentId: 'deployment-test',
          freshEmpty: true,
          identityId: 'nanohost-test',
          observedAt: '2026-08-10T00:00:01.000Z',
          predecessorFenced: true,
          ready: true,
          targetId,
          ...conflicting,
        })
      ).toThrow(/generation|identity|deployment/i);
      expect(getNanoHostRuntimeTarget(coreDb, targetId)).toEqual(before);
    }
    coreDb.sqlite.close();
  });

  it('allocates generation one then durable successors without reuse or overflow', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-generation-'));
    let coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    const first = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
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
    const successor = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'nanohost-test',
      observedAt: '2026-08-10T00:01:00.000Z',
      targetId,
    });
    expect(successor.connectionGeneration).toBe(2);

    coreDb.sqlite
      .prepare('UPDATE nanohost_runtime_targets SET connection_generation = ? WHERE target_id = ?')
      .run(Number.MAX_SAFE_INTEGER, targetId);
    expect(() =>
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:02:00.000Z',
        targetId,
      })
    ).toThrow(/generation|overflow/i);
    expect(getNanoHostRuntimeTarget(coreDb, targetId)?.connectionGeneration).toBe(
      Number.MAX_SAFE_INTEGER
    );
    coreDb.sqlite.close();
  });

  it('fences only the exact current connection generation without changing its high-water mark', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-nanohost-target-')));
    applyMigrations(coreDb);

    try {
      const initial = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:00.000Z',
        targetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        connectionGeneration: initial.connectionGeneration,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: 'nanohost-test',
        observedAt: '2026-08-10T00:00:02.000Z',
        predecessorFenced: true,
        ready: true,
        targetId,
      });
      expect(() =>
        recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: initial.connectionGeneration,
          closedGeneration: initial.connectionGeneration + 1,
          observedAt: '2026-08-10T00:00:03.000Z',
          targetId,
        })
      ).toThrow(/generation|current/i);
      fenceNanoHostRuntimeTargetAfterRestart(coreDb, '2026-08-10T00:00:03.000Z');
      expect(getNanoHostRuntimeTarget(coreDb, targetId)).toMatchObject({
        connectionGeneration: initial.connectionGeneration,
        freshEmpty: false,
        predecessorFenced: true,
        ready: false,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
