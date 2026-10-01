import { describe, expect, it } from 'vitest';
import { REASONING_ATTRIBUTION_LIMIT, ReasoningAttribution } from './reasoning-attribution.js';

const member = { providerId: 'profile-a', modelId: 'native-model' };

describe('reasoning attribution bounds', () => {
  it('stays bounded under sustained traffic and evicts the least recently used identity', () => {
    const association = new ReasoningAttribution();
    for (let index = 0; index < REASONING_ATTRIBUTION_LIMIT; index++)
      association.record(`rs_${index}`, member);
    expect(association.matches('rs_0', member)).toBe(true);
    association.record('rs_next', member);
    expect(association.matches('rs_1', member)).toBe(false);
    expect(association.matches('rs_0', member)).toBe(true);
    for (let index = 0; index < REASONING_ATTRIBUTION_LIMIT * 4; index++) {
      association.record(`rs_sustained_${index}`, member);
      expect(association.size).toBe(REASONING_ATTRIBUTION_LIMIT);
    }
    expect(association.matches('rs_0', member)).toBe(false);
    expect(association.matches(`rs_sustained_${REASONING_ATTRIBUTION_LIMIT * 4 - 1}`, member)).toBe(
      true
    );
  });
  it('never attributes misses and makes conflicting producers unattributed', () => {
    const association = new ReasoningAttribution();
    expect(association.matches('external', member)).toBe(false);
    expect(association.size).toBe(0);
    association.record('conflict', member);
    association.record('conflict', { ...member, providerId: 'different-account' });
    expect(association.matches('conflict', member)).toBe(false);
    association.record('conflict', member);
    expect(association.matches('conflict', member)).toBe(false);
    expect(association.size).toBe(1);
  });
});
