// NEW-only supplement: native OSV package identities must survive CycloneDX projection.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { bomFromOsv } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/release-sbom.mjs')).href
);

// Minimal recorded native subject inventory from r14-recorded-osv-input.json.
const nodePurl = 'pkg:npm/%40agentclientprotocol/sdk@1.4.0?source=PUBLIC_REGISTRY';
const osPurl = 'pkg:deb/debian/adduser@3.134?arch=all&distro=bookworm';
function nativeReport() {
  return {
    results: [
      {
        source: {
          path: '/usr/local/lib/openkit/runtime-supply/node_modules/.package-lock.json',
          type: 'artifact',
        },
        packages: [
          {
            package: {
              name: '@agentclientprotocol/sdk',
              version: '1.4.0',
              ecosystem: 'npm',
              purl: nodePurl,
            },
          },
        ],
      },
      {
        source: { path: '/var/lib/dpkg/status', type: 'os' },
        packages: [
          {
            package: {
              name: 'adduser',
              os_package_name: 'adduser',
              version: '3.134',
              ecosystem: 'Debian:12',
              purl: osPurl,
            },
          },
        ],
      },
    ],
  };
}

/** Locate a projected identity without depending on generated references or component ordering. */
function component(bom, purl) {
  const matches = bom.components.filter((entry) => entry.purl === purl);
  assert.equal(matches.length, 1, 'Each exact package identity must have one component');
  return matches[0];
}

test('CycloneDX 1.6 preserves native Node and OS identities without ecosystem reconstruction', () => {
  for (const ecosystem of ['Debian:12', 'UnfamiliarDistribution:17']) {
    const report = nativeReport();
    report.results[1].packages[0].package.ecosystem = ecosystem;
    const bom = bomFromOsv(report);
    assert.equal(bom.bomFormat, 'CycloneDX', 'Projector must produce standard CycloneDX');
    assert.equal(bom.specVersion, '1.6', 'Projector must use the selected CycloneDX version');
    assert.equal(
      bom.components.length,
      2,
      'Native inventory must not become an empty successful export'
    );
    assert.equal(
      component(bom, nodePurl).version,
      '1.4.0',
      'Node version and scoped qualified purl must survive'
    );
    assert.equal(
      component(bom, osPurl).version,
      '3.134',
      'OS version and architecture/distro qualifiers must survive'
    );
  }
});

test('one purl groups source occurrences while qualified siblings remain separate', () => {
  const report = nativeReport();
  const repeated = structuredClone(report.results[1]);
  repeated.source.path = '/fixture/second-dpkg/status';
  report.results.push(repeated);
  const sibling = structuredClone(report.results[1]);
  const siblingPurl = osPurl.replace('arch=all', 'arch=amd64');
  sibling.packages[0].package.purl = siblingPurl;
  sibling.source.path = '/fixture/amd64-dpkg/status';
  report.results.push(sibling);
  const bom = bomFromOsv(report);
  assert.equal(
    bom.components.length,
    3,
    'Qualified sibling must not collapse into another architecture'
  );
  const grouped = component(bom, osPurl);
  const locations = grouped.evidence?.occurrences?.map((entry) => entry.location);
  assert.ok(
    Array.isArray(locations),
    'CycloneDX occurrence evidence must preserve native source locations'
  );
  assert.deepEqual(
    [...locations].sort(),
    ['/var/lib/dpkg/status', repeated.source.path].sort(),
    'Repeated identity must retain both occurrences'
  );
  assert.equal(
    component(bom, siblingPurl).version,
    '3.134',
    'Qualified sibling must retain its exact version'
  );
});

test('incomplete or contradictory native package coordinates refuse rather than disappear', () => {
  for (const change of [
    { purl: undefined },
    { purl: '' },
    { version: undefined },
    { version: '' },
    { version: '9.9.9' },
  ]) {
    // Leave the other package valid: refusal must not be replaced by a partial successful BOM.
    const report = nativeReport();
    Object.assign(report.results[1].packages[0].package, change);
    assert.throws(
      () => bomFromOsv(report),
      Error,
      'Missing or conflicting native identity must refuse'
    );
  }
});

test('missing or empty selected-artifact inventory refuses instead of emitting an empty BOM', () => {
  for (const report of [
    undefined,
    {},
    { results: [] },
    { results: [{ source: { path: '/fixture/empty', type: 'artifact' }, packages: [] }] },
  ]) {
    assert.throws(
      () => bomFromOsv(report),
      Error,
      'Absent selected-artifact inventory must refuse'
    );
  }
});
