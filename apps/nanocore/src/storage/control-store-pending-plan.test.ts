import { describe, expect, it } from 'vitest';
import {
  CONTROL_PENDING_PLAN_BYTES,
  type ControlPendingPlanGroup,
  encodeControlPendingPlan,
} from './control-store-pending-plan.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';

const workspaceId = 'ws_01a00000-0000-7000-8000-000000000001';
const header = {
  workspaceId,
  operation: 'pending-boot' as const,
  threadId: null,
  inputs: `sha256:${'0'.repeat(64)}`,
};

/** One settlement group of `count` census sources. */
function settlement(count: number, offset = 0): ControlPendingPlanGroup {
  return {
    kind: 'pending',
    input: {
      input: {
        action: 'settle-unfinished',
        workspaceId,
        now: '2026-11-26T00:00:00.000Z',
        expected: Array.from({ length: count }, (_, index) => ({
          requestId: `ap_bound_${String(offset + index).padStart(8, '0')}`,
          sourceHash: `sha256:${'1'.repeat(64)}`,
        })),
      },
      products: [],
      entries: [],
      receipt: null,
    },
  };
}

describe('grouped Pending plan bounds', () => {
  it('refuses one group over its existing frame bound locally, before staging', () => {
    expect(() => encodeControlPendingPlan(header, [settlement(12_000)])).toThrow(
      ControlProductPreconditionError
    );
    expect(encodeControlPendingPlan(header, [settlement(4_096)]).byteLength).toBeGreaterThan(0);
  });

  it('refuses a whole plan over its measured Workspace bound locally, before staging', () => {
    const groups = Array.from({ length: 80 }, (_, index) => settlement(4_096, index * 4_096));
    expect(() => encodeControlPendingPlan(header, groups)).toThrow(ControlProductPreconditionError);
    expect(encodeControlPendingPlan(header, groups.slice(0, 8)).byteLength).toBeLessThan(
      CONTROL_PENDING_PLAN_BYTES
    );
  });
});
