import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assessAdvisories } from './feeds.js';
import { buildInventory } from './inventory.js';

type PackageObservation = readonly [purl: string, version: string];

/** Creates only transient inventory observations through the actual public producer. */
function inventory(packages: readonly PackageObservation[]) {
  return buildInventory({
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
      components: packages.map(([purl, version]) => ({
        type: 'library',
        name: 'fixture',
        purl,
        version,
      })),
    }),
  });
}

describe('E3 accepted per-assessment projection bound', () => {
  it('bounds one 1 MiB advisory ID across 64 matched versions, reports incomplete, and preserves an earlier finding', () => {
    // ASSESSMENT-BOUND-API.md: accepted option A fixes this existing release bound.
    const ceiling = 32 * 1024 * 1024;
    const priorPurl = 'pkg:npm/retained-fixture@1.2.3';
    const priorId = 'GHSA-fixture-prior';
    const first = assessAdvisories({
      inventory: inventory([[priorPurl, '1.2.3']]),
      records: [
        {
          id: priorId,
          database_specific: { severity: 'HIGH' },
          affected: [{ package: { purl: 'pkg:npm/retained-fixture' }, versions: ['1.2.3'] }],
        },
      ],
      previous: [],
      kev: null,
      rss: [],
      now: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(
      first.findings.length,
      1,
      'valid earlier finding is publicly produced, not fabricated'
    );
    const earlier = structuredClone(first.findings[0]!);
    assert.equal(earlier.firstMatchedAt, '2026-11-01T00:00:00.000Z');
    assert.equal(earlier.class, 'H');
    assert.equal(earlier.status, 'open');

    const versions = Array.from({ length: 64 }, (_, index) => `1.0.${index}`);
    const packages: PackageObservation[] = versions.map((version) => [
      `pkg:npm/amplify-fixture@${version}`,
      version,
    ]);
    packages.push([priorPurl, '1.2.3']);
    const currentInventory = inventory(packages);
    assert.equal(
      currentInventory.components.filter((component) => component.sourceId === 'app').length,
      65
    );
    assert.ok(
      currentInventory.components.some(
        (component) => component.purl === priorPurl && component.version === '1.2.3'
      )
    );
    assert.equal(
      currentInventory.coverage.find((source) => source.sourceId === 'app')?.status,
      'complete'
    );

    const advisoryId = 'A'.repeat(1024 * 1024);
    const records = [
      {
        id: advisoryId,
        affected: [
          {
            package: { purl: 'pkg:npm/amplify-fixture' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }],
          },
        ],
      },
    ];
    const inputBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
    assert.equal(Buffer.byteLength(advisoryId, 'ascii'), 1024 * 1024);
    assert.ok(inputBytes < ceiling, 'valid OSV input stays below the accepted document ceiling');

    const result = assessAdvisories({
      inventory: currentInventory,
      records,
      previous: first.findings,
      kev: null,
      rss: [],
      now: '2026-11-02T00:00:00.000Z',
    });
    assert.deepEqual(
      result.findings.find(
        (finding) => finding.advisoryId === priorId && finding.purl === priorPurl
      ),
      earlier,
      'a present component does not request a fixed transition; preserve the entire earlier finding'
    );
    const outputBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    console.info(
      `[assessment-bound] inputBytes=${inputBytes} outputBytes=${outputBytes} findings=${result.findings.length} gaps=${result.gaps.length}`
    );
    assert.ok(
      outputBytes <= ceiling,
      `per-assessment projection exceeds 32 MiB: observed ${outputBytes} bytes`
    );
    assert.ok(
      result.gaps.some((gap) => gap.kind === 'incomplete'),
      'stopped projection reports the existing explicit incomplete gap'
    );
  });
});
