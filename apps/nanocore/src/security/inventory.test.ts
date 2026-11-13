import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { buildInventory } from './inventory.js';

type Input = Parameters<typeof buildInventory>[0];
type Report = ReturnType<typeof buildInventory>;
type Artifact = Input['artifacts'][number];

// Runtime Security E2. Assertion-preserving setup migration of the frozen external oracle.
const release = {
  purl: 'pkg:generic/openkit@0.1.0',
  version: '0.1.0',
  repository: 'https://github.com/lingkaix/openkit',
  releaseTag: 'v0.1.0',
  sourceCommit: 'a'.repeat(40),
};
const component = (purl: string | undefined, version: string | undefined) => ({
  type: 'library',
  name: 'fixture-only',
  purl,
  version,
});
const sbom = (components: readonly unknown[]) =>
  JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const input = (extra: Partial<Input> = {}): Input => ({
  release,
  appSbom: null,
  artifacts: [],
  ...extra,
});
const coverage = (report: Report, id: string) => {
  const rows = report.coverage.filter((row) => row.sourceId === id);
  assert.equal(rows.length, 1, `one coverage observation for ${id}`);
  return rows[0]!;
};
const gap = (report: Report, id: string, status: Report['coverage'][number]['status']) => {
  const row = coverage(report, id);
  assert.equal(row.status, status);
  assert.equal(typeof row.reason, 'string');
  assert.ok(row.reason.trim().length > 0, 'coverage gap has its reason');
};
const identities = (report: Report, id: string) =>
  report.components
    .filter((c) => c.sourceId === id)
    .map((c) => [c.purl, c.version])
    .sort();
const artifact = (sbomText: string, extra: Partial<Artifact> = {}): Artifact => ({
  sourceId: 'worker-a',
  kind: 'worker',
  official: true,
  filename: 'worker-a.sbom.json',
  sbom: sbomText,
  sha256sums: `${digest(sbomText)}  worker-a.sbom.json\n`,
  ...extra,
});

describe('E2 inventory coverage and exact package identities', () => {
  it('keeps the observed release even when every SBOM is missing', () => {
    const report = buildInventory(input());
    assert.deepEqual(identities(report, 'release'), [[release.purl, release.version]]);
    assert.equal(coverage(report, 'release').status, 'complete');
    const observed = report.components.find((c) => c.sourceId === 'release')!;
    assert.equal(observed.repository, release.repository);
    assert.equal(observed.releaseTag, release.releaseTag);
    gap(report, 'app', 'unavailable');
  });

  it('distinguishes missing SBOM from a present, valid, empty SBOM', () => {
    const missing = buildInventory(input());
    const empty = buildInventory(input({ appSbom: sbom([]) }));
    gap(missing, 'app', 'unavailable');
    assert.equal(coverage(empty, 'app').status, 'complete');
    assert.deepEqual(identities(missing, 'app'), []);
    assert.deepEqual(identities(empty, 'app'), []);
  });

  it('preserves ecosystem, scope, qualifiers, subpath and exact version', () => {
    const packages: [string, string][] = [
      ['pkg:npm/%40fixture/widget@1.2.3', '1.2.3'],
      ['pkg:npm/widget@1.2.3', '1.2.3'],
      ['pkg:cargo/widget@1.2.3', '1.2.3'],
      ['pkg:deb/debian/libfixture@1.2.3-1?arch=arm64&distro=debian-12', '1.2.3-1'],
      ['pkg:generic/bundle@1.2.3#lib/fixture', '1.2.3'],
    ];
    const report = buildInventory(
      input({ appSbom: sbom(packages.map(([p, v]) => component(p, v))) })
    );
    assert.deepEqual(identities(report, 'app'), packages.sort());
    assert.equal(coverage(report, 'app').status, 'complete');
  });

  it('does not invent identities for malformed, absent or conflicting package fields', () => {
    const report = buildInventory(
      input({
        appSbom: sbom([
          component('pkg:npm/valid@1.2.3', '1.2.3'),
          component(undefined, '1.2.3'),
          component('not-a-purl', '1.2.3'),
          component('pkg:npm/conflict@1.2.3', '9.9.9'),
          component('pkg:npm/no-version', undefined),
        ]),
      })
    );
    assert.deepEqual(identities(report, 'app'), [['pkg:npm/valid@1.2.3', '1.2.3']]);
    gap(report, 'app', 'incomplete');
  });

  it('admits verified worker and NanoHost SBOMs, not derived image claims', () => {
    const body = sbom([component('pkg:cargo/fixture@2.0.0', '2.0.0')]);
    const report = buildInventory(
      input({
        artifacts: [
          artifact(body),
          artifact(body, { sourceId: 'host-a', kind: 'nanohost' }),
          artifact(body, { sourceId: 'derived', official: false }),
        ],
      })
    );
    for (const id of ['worker-a', 'host-a']) {
      assert.equal(coverage(report, id).status, 'complete');
      assert.deepEqual(identities(report, id), [['pkg:cargo/fixture@2.0.0', '2.0.0']]);
    }
    gap(report, 'derived', 'not-covered');
    assert.deepEqual(identities(report, 'derived'), []);
  });

  it.each<[string, (body: string) => Partial<Artifact>]>([
    ['absent checksum', (_body) => ({ sha256sums: null })],
    ['wrong digest', (_body) => ({ sha256sums: `${'0'.repeat(64)}  worker-a.sbom.json\n` })],
    ['different attachment', (body) => ({ sha256sums: `${digest(body)}  other.sbom.json\n` })],
    [
      'same basename in another directory',
      (body) => ({ sha256sums: `${digest(body)}  nested/worker-a.sbom.json\n` }),
    ],
    ['changed exact bytes', (body) => ({ sbom: `${body}\n` })],
    ['missing SBOM', (_body) => ({ sbom: null })],
  ])('refuses unverified artifact bytes: %s', (_name, damage) => {
    const body = sbom([component('pkg:npm/fixture@1.0.0', '1.0.0')]);
    const report = buildInventory(input({ artifacts: [artifact(body, damage(body))] }));
    assert.deepEqual(identities(report, 'worker-a'), []);
    const row = coverage(report, 'worker-a');
    assert.notEqual(row.status, 'complete');
    assert.ok(row.reason?.trim(), 'verification failure is visible');
  });

  it('reports malformed SBOMs as a gap rather than successful empty coverage', () => {
    for (const body of [
      '{',
      '{}',
      JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: null }),
    ]) {
      const report = buildInventory(input({ appSbom: body }));
      assert.notEqual(coverage(report, 'app').status, 'complete');
      assert.ok(coverage(report, 'app').reason?.trim());
      assert.deepEqual(identities(report, 'app'), []);
    }
  });

  it('states all unsupported extension gaps without claiming package coverage', () => {
    const report = buildInventory(input({ appSbom: sbom([]) }));
    for (const id of ['mcp', 'skills', 'light-apps', 'plugins']) {
      gap(report, id, 'not-covered');
      assert.deepEqual(identities(report, id), []);
    }
  });
});
