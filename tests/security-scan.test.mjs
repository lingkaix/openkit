import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { kevIds, findingsFromOsvSource, newSevereFindings, scanImage } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/security-scan.mjs')).href
);
const { assertReleaseFindingGate } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/security-findings.mjs')).href
);
const pins = JSON.parse(readFileSync(join(process.cwd(), 'scripts/security-tools.json'), 'utf8'));
const artifact = `sha256:${'a'.repeat(64)}`;
const location = 'synthetic/pnpm-lock.yaml';
const cve = 'CVE-2026-12345';
const purl = 'pkg:npm/security-fixture@1.0.0?source=PUBLIC_REGISTRY';
const knownCves = kevIds({
  catalogVersion: '2026.11.09',
  dateReleased: '2026-11-09T19:00:00.000Z',
  count: 1,
  vulnerabilities: [{ cveID: cve }],
});

/** Native OSV scanner source shape; numeric severity comes from its groups. */
function source({
  score = '7.2',
  id = 'GHSA-2345-6789-cfgh',
  aliases = [],
  fixed = false,
  summary = '',
  packagePurl = purl,
  ecosystem = 'npm',
  version = '1.0.0',
} = {}) {
  const vulnerability = {
    id,
    aliases,
    summary,
    affected: [
      {
        package: { name: 'security-fixture', ecosystem, purl: packagePurl },
        ranges: [
          {
            type: 'ECOSYSTEM',
            events: [{ introduced: '0' }, ...(fixed ? [{ fixed: '2.0.0' }] : [])],
          },
        ],
      },
    ],
  };
  return {
    packages: [
      {
        package: { name: 'security-fixture', version, ecosystem, purl: packagePurl },
        vulnerabilities: [vulnerability],
        groups: [{ ids: [id], aliases, ...(score == null ? {} : { max_severity: score }) }],
      },
    ],
  };
}

/** Exercise the public normalizer with an exact immutable artifact binding. */
function normalize(options = {}, context = {}) {
  return findingsFromOsvSource(source(options), { artifact, location, knownCves, ...context });
}

test('native numeric severities project the Development Security class boundaries', () => {
  for (const [score, expected] of [
    ['9.0', 'C'],
    ['10.0', 'C'],
    ['8.9', 'H'],
    ['7.0', 'H'],
    ['6.9', 'N'],
    ['0.0', 'N'],
    [null, 'H'],
  ]) {
    for (const fixed of [false, true]) {
      const findings = normalize({ score, fixed });
      assert.equal(findings.length, 1, 'One native advisory must remain one finding');
      const [finding] = findings;
      assert.equal(finding.class, expected, 'Native severity must determine urgency');
      assert.equal(finding.knownExploited, false, 'Severity alone must not assert exploitation');
      assert.equal(
        finding.fixAvailable,
        fixed,
        'Fix availability must remain independent of urgency'
      );
      assert.equal(finding.artifact, artifact, 'Finding must bind the exact scanned artifact');
      assert.deepEqual(
        finding.component,
        { purl, location },
        'Finding must preserve component coordinates'
      );
      assert.ok(
        typeof finding.id === 'string' && finding.id.length > 0,
        'Finding needs an identity'
      );
      assert.ok(
        finding.advisoryIds.includes('GHSA-2345-6789-cfgh'),
        'Finding must preserve the source advisory'
      );
    }
  }
});

test('only structured exploitation facts promote findings to K', () => {
  for (const fixed of [false, true]) {
    for (const options of [{ aliases: [cve] }, { id: 'MAL-2026-12345' }]) {
      const [finding] = normalize({ ...options, score: '0.1', fixed });
      assert.equal(finding.class, 'K', 'KEV or malicious-package identity must take priority');
      assert.equal(finding.knownExploited, true, 'Structured exploitation must remain explicit');
      assert.equal(finding.fixAvailable, fixed, 'A fix must not lower exploitation urgency');
    }
  }
  const [prose] = normalize({
    score: '7.2',
    summary: `RSS says exploited: ${cve}; MAL-2026-12345`,
  });
  assert.equal(prose.class, 'H', 'Prose must not become a structured exploitation fact');
  assert.equal(prose.knownExploited, false, 'RSS or prose must not set exploitation');
  const [unlisted] = normalize({ aliases: ['CVE-2026-54321'], score: '7.2' });
  assert.equal(unlisted.class, 'H', 'An unlisted CVE alias alone must not become K');
});

test('qualified operating-system and Node purls retain their exact version coordinates', () => {
  const osPurl = 'pkg:deb/debian/security-fixture@1.2.3-1?arch=amd64&distro=debian-12';
  for (const [packagePurl, ecosystem, version] of [
    [purl, 'npm', '1.0.0'],
    [osPurl, 'Debian:12', '1.2.3-1'],
  ]) {
    const [finding] = normalize({ packagePurl, ecosystem, version });
    assert.deepEqual(
      finding.component,
      { purl: packagePurl, location },
      'Normalization must preserve qualified package identity'
    );
  }
});

test('foreign or malformed reports cannot masquerade as a clean native source', () => {
  for (const report of [null, {}, { results: [] }, { packages: null }, { packages: [{}] }]) {
    assert.throws(
      () => findingsFromOsvSource(report, { artifact, location, knownCves }),
      'Invalid native source must be refused'
    );
  }
  assert.deepEqual(
    findingsFromOsvSource({ packages: [] }, { artifact, location, knownCves }),
    [],
    'Valid empty native source must be clean'
  );
  const clean = source();
  clean.packages[0].vulnerabilities = [];
  clean.packages[0].groups = [];
  assert.deepEqual(
    findingsFromOsvSource(clean, { artifact, location, knownCves }),
    [],
    'Scanned package without vulnerabilities must be clean'
  );
});

test('lock-file gate blocks new severe matches, not unchanged artifact rebinding', () => {
  const [high] = normalize();
  for (const cls of ['K', 'C', 'H']) {
    const finding = { ...high, class: cls, knownExploited: cls === 'K' };
    assert.deepEqual(newSevereFindings([], [finding]), [finding], 'New severe match must block');
    assert.deepEqual(
      newSevereFindings([finding], [finding]),
      [],
      'Existing match must not block an unrelated change'
    );
    const rebound = { ...finding, artifact: `sha256:${'b'.repeat(64)}` };
    const report = [structuredClone(rebound)];
    assert.deepEqual(
      newSevereFindings([finding], report),
      [],
      'Artifact digest change alone must not create a new match'
    );
    assert.deepEqual(
      report,
      [rebound],
      'Existing matches must remain available in the scan report'
    );
  }
  const low = { ...high, class: 'N', knownExploited: false };
  assert.deepEqual(newSevereFindings([], [low]), [], 'New routine-class match must not block');
  assert.deepEqual(newSevereFindings([low], [high]), [high], 'A newly severe match must block');
  assert.deepEqual(newSevereFindings([high], []), [], 'Removed match must not block');
});

test('image admission includes installed npm findings with exact bindings and fails closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-image-admission-'));
  try {
    const executable = join(directory, 'osv-scanner');
    // Substitute only the external scanner observation. Admission and register predicates stay real.
    writeFileSync(
      executable,
      `#!${process.execPath}
import fs from 'node:fs';
if (process.argv[2] === '--version') {
  console.log('osv-scanner version: ${pins['osv-scanner'].version}');
} else {
  fs.writeFileSync(process.env.OBSERVED_ARGS, JSON.stringify(process.argv.slice(2)));
  process.stdout.write(fs.readFileSync(process.env.OBSERVATION, 'utf8'));
  process.exitCode = 1;
}
`
    );
    chmodSync(executable, 0o755);
    const observation = join(directory, 'report.json');
    const argsFile = join(directory, 'args.json');
    const config = join(directory, 'scanner.toml');
    writeFileSync(config, '');
    const npmPath = '/usr/local/lib/node_modules/security-fixture/package.json';
    const os = { source: { type: 'os', path: '/var/lib/dpkg/status' }, packages: [] };
    for (const platform of ['linux/amd64', 'linux/arm64']) {
      for (const options of [
        { score: '9.8', fixed: true },
        { aliases: [cve], fixed: true },
      ]) {
        const report = {
          results: [os, { ...source(options), source: { type: 'unknown', path: npmPath } }],
        };
        writeFileSync(observation, JSON.stringify(report));
        const context = {
          image: `registry.example/synthetic@${artifact}`,
          platform,
          knownCves,
          cwd: directory,
          config,
          env: { PATH: directory, OBSERVATION: observation, OBSERVED_ARGS: argsFile },
        };
        const findings = scanImage(context);
        const args = JSON.parse(readFileSync(argsFile, 'utf8'));
        assert.equal(args[args.indexOf('--x-plugins') + 1], 'javascript/packagejson');
        assert.ok(args.includes('--all-packages'));
        assert.deepEqual(
          findings,
          normalize(options, { location: `${platform}:${npmPath.slice(1)}` })
        );
        assert.throws(() => assertReleaseFindingGate({ findings, now: Date.now() }));

        for (const path of ['/usr/local/../package.json', 'relative/package.json', '/bad\0path']) {
          report.results[1].source.path = path;
          writeFileSync(observation, JSON.stringify(report));
          assert.throws(() => scanImage(context));
        }
        report.results[1].source = { type: 'unsupported', path: npmPath };
        writeFileSync(observation, JSON.stringify(report));
        assert.throws(() => scanImage(context));
        report.results = [{ ...source(options), source: { type: 'unknown', path: npmPath } }];
        writeFileSync(observation, JSON.stringify(report));
        assert.throws(() => scanImage(context), /operating-system inventory/u);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
