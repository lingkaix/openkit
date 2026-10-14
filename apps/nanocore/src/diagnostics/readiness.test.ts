import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBootReadinessSnapshot } from '../bootstrap/readiness.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { observeOperationalReadiness } from './readiness.js';

describe('operational readiness dimensions', () => {
  it('shows the age of stored host readiness without treating freshEmpty as maintenance safety', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-host-age-'));
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const observedAt = '2026-10-11T00:00:00.000Z';
    const nanoHostConfig = { identityId: 'nh_age', deploymentId: 'dep_age' };
    try {
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...nanoHostConfig,
        targetId: nanoHostConfig.identityId,
        observedAt,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...nanoHostConfig,
        targetId: nanoHostConfig.identityId,
        observedAt,
        connectionGeneration: 1,
        predecessorFenced: true,
        ready: true,
        freshEmpty: true,
        physicalEpoch: 'a'.repeat(64),
      });
      const result = observeOperationalReadiness(
        { coreDb, mode: 'server', nanoHostConfig },
        computeBootReadinessSnapshot({ bootId: 'boot_stored_observation' }),
        () => Date.parse('2026-10-14T00:00:00.000Z')
      );
      expect(result.executionHost).toEqual({
        state: 'ready',
        observedAt,
        observationAgeMs: 259200000,
        freshEmpty: true,
        liveProbe: false,
      });
      expect(result.maintenanceSafety).toEqual({ state: 'unknown', observation: null });
    } finally {
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps service availability separate from blocked work and unknown maintenance safety', async () => {
    const boot = computeBootReadinessSnapshot({
      bootId: 'boot_readiness_dimensions',
      subsystems: {
        storage: {
          state: 'failed',
          reasons: [
            {
              code: 'storage.unavailable',
              message: 'Storage unavailable.',
              blocks: ['product_work'],
            },
          ],
        },
      },
    });
    const app = createApp({ bootReadiness: boot });
    const response = await app.request(...operationRequest('diagnostics.app', {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readiness: {
        serviceAvailability: 'available',
        productWork: 'blocked',
        update: { state: 'unconfigured', qualification: 'prepare-required' },
        maintenanceSafety: { state: 'unknown', observation: null },
        executionHost: {
          state: 'unconfigured',
          observedAt: null,
          observationAgeMs: null,
          liveProbe: false,
        },
      },
    });
  });

  it('preserves completed index rebuild as information on a ready service', async () => {
    const boot = computeBootReadinessSnapshot({
      bootId: 'boot_index_information',
      subsystems: {
        storage: {
          state: 'ready',
          reasons: [
            { code: 'storage.index-rebuilt', message: 'Rebuilt one index set.', blocks: [] },
          ],
        },
      },
    });
    const app = createApp({ bootReadiness: boot });
    const response = await app.request(...operationRequest('diagnostics.app', {}));
    expect(await response.json()).toMatchObject({
      boot: { overall: 'ready', acceptingProductWork: true },
      readiness: { productWork: 'ready' },
    });
  });
});
