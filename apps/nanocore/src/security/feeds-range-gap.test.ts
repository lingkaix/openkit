import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assessAdvisories } from './feeds.js';
import { buildInventory } from './inventory.js';

// RANGE-GAP-API.md: one unassessable lower bound must not look like a clean non-match.
describe('E3 unassessable SEMVER lower bound', () => {
  it('invents no finding and reports the existing unsupported version/range gap', () => {
    const inventory = buildInventory({
      release: {
        purl: 'pkg:generic/openkit@0.1.0',
        version: '0.1.0',
        repository: 'https://github.com/lingkaix/openkit',
        releaseTag: 'v0.1.0',
        sourceCommit: 'a'.repeat(40),
      },
      artifacts: [],
      appSbom: JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        components: [
          { type: 'library', name: 'fixture', purl: 'pkg:npm/fixture@1.0.0', version: '1.0.0' },
        ],
      }),
    });
    const report = assessAdvisories({
      inventory,
      previous: [],
      kev: null,
      rss: [],
      now: '2026-11-01T00:00:00.000Z',
      records: [
        {
          id: 'GHSA-fixture-unassessed',
          affected: [
            {
              package: { purl: 'pkg:npm/fixture' },
              ranges: [{ type: 'SEMVER', events: [{ introduced: 'not-semver' }] }],
            },
          ],
        },
      ],
    });
    assert.equal(
      report.findings.length,
      0,
      'an unassessed version range cannot invent an affected finding'
    );
    assert.ok(
      report.gaps.some(
        (gap) => gap.kind === 'unsupported-version' || gap.kind === 'unsupported-range'
      ),
      'an unassessed mandatory SEMVER lower bound must remain visible, not a clean non-match'
    );
  });
});
