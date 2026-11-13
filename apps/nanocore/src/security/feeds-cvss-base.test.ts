import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assessAdvisories } from './feeds.js';

const PURL = 'pkg:npm/%40fixture/widget@1.2.3';
// Pure public input observations, not durable state or a scoring-library expected value.
const inventory: Parameters<typeof assessAdvisories>[0]['inventory'] = {
  components: [{ sourceId: 'app', purl: PURL, version: '1.2.3' }],
  coverage: [{ sourceId: 'app', status: 'complete', reason: '' }],
};

// Expected classes are fixed by FIRST base scores and the development-security owner.
// CVSS-BASE-ORACLE.md records official formulas/reference observations and source hashes.
describe('E3 FIRST-defined CVSS v2/v4 base classes', () => {
  it.each<[string, string, string]>([
    ['CVSS_V2', 'AV:N/AC:L/Au:N/C:C/I:C/A:C', 'C'], // FIRST base 10.0
    ['CVSS_V2', 'AV:N/AC:L/Au:N/C:P/I:P/A:P', 'H'], // FIRST base 7.5
    ['CVSS_V4', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H', 'C'], // FIRST base 10.0
    ['CVSS_V4', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N', 'N'], // FIRST base 0.0
  ])(
    'classifies supported %s vector %s as %s without an unsupported-vector gap',
    (type, score, expected) => {
      const report = assessAdvisories({
        inventory,
        previous: [],
        kev: null,
        rss: [],
        now: '2026-11-01T00:00:00.000Z',
        records: [
          {
            id: 'GHSA-fixture-severity',
            severity: [{ type, score }],
            affected: [{ package: { purl: 'pkg:npm/%40fixture/widget' }, versions: ['1.2.3'] }],
          },
        ],
      });
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0]!.class, expected);
      assert.equal(
        report.gaps.length,
        0,
        'a valid FIRST base vector is supported, not an unsupported-vector assessment gap'
      );
    }
  );
});
