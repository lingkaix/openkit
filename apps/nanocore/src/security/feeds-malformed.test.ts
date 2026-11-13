import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assessAdvisories, readFeedDocument } from './feeds.js';
import { buildInventory } from './inventory.js';

const PURL = 'pkg:npm/%40fixture/widget@1.2.3';
const VALID_ID = 'GHSA-fixture-neighbor';
const malformed = { id: 'GHSA-fixture-malformed', affected: [null] };
const valid = {
  id: VALID_ID,
  affected: [{ package: { purl: 'pkg:npm/%40fixture/widget' }, versions: ['1.2.3'] }],
};
const inventory = () =>
  buildInventory({
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
      components: [{ type: 'library', name: 'widget', purl: PURL, version: '1.2.3' }],
    }),
  });
const assess = (records: unknown[]) =>
  assessAdvisories({
    inventory: inventory(),
    records,
    previous: [],
    kev: null,
    rss: [],
    now: '2026-11-01T00:00:00.000Z',
  });
const recordIds = (records: readonly unknown[]) =>
  records.map((record) => (record as { id: string }).id);
const findingIdentities = (report: ReturnType<typeof assessAdvisories>) =>
  report.findings.map((finding) => [finding.purl, finding.advisoryId]);

// Runtime Security E3: malformed records are skipped and counted; valid neighbors survive.
describe('E3 malformed OSV affected child, not unsupported valid ranges', () => {
  it('skips/counts a null affected child at the real document parser and preserves its valid neighbor through assessment', async () => {
    const report = await readFeedDocument({
      kind: 'osv-records',
      location: 'https://feed.example.invalid/fixture',
      fetch: async () =>
        new Response(JSON.stringify([malformed, valid]), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    assert.equal(report.malformedRecords, 1);
    assert.deepEqual(recordIds(report.records), [VALID_ID]);
    const assessed = assess(report.records);
    assert.deepEqual(findingIdentities(assessed), [[PURL, VALID_ID]]);
  });

  it('skips/counts the same malformed core at the public pure assessor without losing a valid finding', () => {
    const report = assess([malformed, valid]);
    assert.equal(report.malformedRecords, 1);
    assert.deepEqual(findingIdentities(report), [[PURL, VALID_ID]]);
  });
});
