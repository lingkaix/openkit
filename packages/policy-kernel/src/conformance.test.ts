import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { type AccessRequest, evaluateAccess, type PolicyState } from './index.js';

const FIXTURE_PATH = new URL('../conformance/ngac-subset.json', import.meta.url);
const FIXTURE_SCHEMA_VERSION = 'policy-kernel-ngac-subset-conformance-v1';

interface ConformanceFixture {
  readonly schemaVersion: string;
  readonly cases: readonly ConformanceCase[];
}

interface ConformanceCase {
  readonly name: string;
  readonly policy: PolicyState;
  readonly request: AccessRequest;
  readonly expected: {
    readonly effect: 'allow' | 'deny';
    readonly reasonCode: string;
    readonly matchedAssociations: readonly string[];
    readonly matchedProhibitions: readonly string[];
  };
}

/**
 * Reads the NGAC subset conformance fixture.
 *
 * @returns Parsed conformance fixture.
 */
function readConformanceFixture(): ConformanceFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ConformanceFixture;
}

describe('NGAC subset conformance fixtures', () => {
  const fixture = readConformanceFixture();

  it('uses the current fixture schema version', () => {
    expect(fixture.schemaVersion).toBe(FIXTURE_SCHEMA_VERSION);
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.name} evaluates as expected`, () => {
      const decision = evaluateAccess(testCase.policy, testCase.request);

      expect(decision.effect).toBe(testCase.expected.effect);
      expect(decision.reasons[0]?.code).toBe(testCase.expected.reasonCode);
      expect(decision.trace.matchedAssociations).toEqual(testCase.expected.matchedAssociations);
      expect(decision.trace.matchedProhibitions).toEqual(testCase.expected.matchedProhibitions);
    });
  }
});
