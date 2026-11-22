import { describe, expect, it } from 'vitest';
import { computeBootReadinessSnapshot } from '../bootstrap/readiness.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { observeOperationalReadiness } from './readiness.js';

describe('operational readiness dimensions', () => {
  it.each([
    { sampledAt: '2026-10-14T00:00:00.000Z', state: 'ready', age: 259200000, freshEmpty: true },
    { sampledAt: '2026-10-11T00:00:00.000Z', state: 'ready', age: 0, freshEmpty: true },
    { sampledAt: '2026-10-10T00:00:00.000Z', state: 'unknown', age: null, freshEmpty: null },
  ])(
    'shows host observation age at $sampledAt without promoting future evidence',
    async ({ sampledAt, state, age, freshEmpty }) => {
      const observedAt = '2026-10-11T00:00:00.000Z';
      const nanoHostConfig = {
        identityId: 'nh_age',
        deploymentId: 'dep_00000000-0000-787c-af58-ea110715292e',
      };
      const result = await observeOperationalReadiness(
        {
          coreDb: undefined,
          mode: 'server',
          nanoHostConfig,
          readNanoHostTarget: (targetId) => ({
            state: 'ready',
            value: {
              ...nanoHostConfig,
              targetId,
              observedAt,
              connectionGeneration: 1,
              predecessorFenced: true,
              ready: true,
              freshEmpty: true,
              physicalEpoch: 'a'.repeat(64),
              slotCount: 1,
            },
          }),
        },
        computeBootReadinessSnapshot({ bootId: 'boot_stored_observation' }),
        () => Date.parse(sampledAt)
      );
      expect(result.executionHost).toEqual({
        state,
        observedAt,
        observationAgeMs: age,
        freshEmpty,
        liveProbe: false,
      });
      expect(result.maintenanceSafety).toEqual({ state: 'unknown', observation: null });
    }
  );

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
