import { describe, expect, it } from 'vitest';

import { createTestAgentSetup } from '../test-support/agent-environment.js';
import type { AgentManifest } from './manifest.js';
import { computeReadiness, isAgentLaunchable } from './readiness.js';

/** Creates one current Agent manifest with optional readiness differences. */
function manifest(input: Partial<AgentManifest> = {}): AgentManifest {
  return { ...createTestAgentSetup().manifest, ...input };
}

describe('computeReadiness', () => {
  it('returns ready when the manifest does not declare a blocker', () => {
    expect(computeReadiness(manifest())).toEqual({ reasons: [], status: 'ready' });
  });

  it('returns ready when the manifest explicitly declares readiness', () => {
    expect(computeReadiness(manifest({ readiness: { status: 'ready' } }))).toEqual({
      reasons: [],
      status: 'ready',
    });
  });

  it('projects the stored message of a ready Agent', () => {
    expect(
      computeReadiness(
        manifest({ readiness: { message: 'Proved by an accepted turn.', status: 'ready' } })
      )
    ).toEqual({ reasons: ['Proved by an accepted turn.'], status: 'ready' });
  });

  it('keeps a ready Agent with a stored message launchable', () => {
    expect(
      isAgentLaunchable(
        computeReadiness(
          manifest({ readiness: { message: 'Proved by an accepted turn.', status: 'ready' } })
        )
      )
    ).toBe(true);
  });

  it.each([
    ['disabled', 'Disabled by operator.'],
    ['blocked', 'Runtime image is unavailable.'],
    ['unknown', 'Runtime availability has not been probed.'],
    ['degraded', 'Runtime is operating with reduced capacity.'],
  ] as const)('preserves declared %s readiness', (status, message) => {
    expect(computeReadiness(manifest({ readiness: { message, status } }))).toEqual({
      reasons: [message],
      status,
    });
  });

  it('does not probe runtime binaries from an Agent manifest', () => {
    expect(
      computeReadiness(
        manifest({ runtime: { ...manifest().runtime, adapter: 'future', kind: 'future' } })
      )
    ).toEqual({ reasons: [], status: 'ready' });
  });

  it('admits only ready Agent readiness', () => {
    expect(isAgentLaunchable({ reasons: [], status: 'ready' })).toBe(true);
    expect(
      isAgentLaunchable({
        reasons: ['Runtime is operating with reduced capacity.'],
        status: 'degraded',
      })
    ).toBe(false);
  });
});
