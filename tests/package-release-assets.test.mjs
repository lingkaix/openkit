import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { packageReleaseAssets } from '../scripts/package-release-assets.mjs';

test('release packager archives the complete Skill and writes its SHA-256', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'openkit-release-assets-'));
  writeFileSync(join(repoRoot, 'LICENSE'), 'fixture license\n');
  mkdirSync(join(repoRoot, 'skills', 'openkit', 'references'), { recursive: true });
  mkdirSync(join(repoRoot, 'skills', 'openkit', 'scripts'), { recursive: true });
  writeFileSync(join(repoRoot, 'skills', 'openkit', 'SKILL.md'), '# Fixture Skill\n');
  writeFileSync(join(repoRoot, 'skills', 'openkit', 'references', 'setup.md'), '# Setup\n');
  const cliPath = join(repoRoot, 'skills', 'openkit', 'scripts', 'openkit');
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  chmodSync(cliPath, 0o755);
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'release-test@openkit.local']);
  git(repoRoot, ['config', 'user.name', 'OpenKit Release Test']);
  git(repoRoot, ['add', 'LICENSE', 'skills/openkit']);
  git(repoRoot, ['commit', '-qm', 'fixture']);

  const outputDir = join(repoRoot, 'dist', 'release');
  const result = packageReleaseAssets({
    outputDir,
    ref: 'HEAD',
    repoRoot,
    tag: 'v0.1.0-rc.1',
  });
  const repeated = packageReleaseAssets({
    outputDir: join(repoRoot, 'dist', 'repeated'),
    ref: 'HEAD',
    repoRoot,
    tag: 'v0.1.0-rc.1',
  });
  const archive = readFileSync(result.archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const listed = spawnSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' });

  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), [
    'openkit-skill-v0.1.0-rc.1/',
    'openkit-skill-v0.1.0-rc.1/LICENSE',
    'openkit-skill-v0.1.0-rc.1/skills/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/SKILL.md',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/references/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/references/setup.md',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/scripts/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/scripts/openkit',
  ]);
  assert.equal(result.checksum, checksum);
  assert.equal(repeated.checksum, checksum);
  assert.equal(
    readFileSync(result.checksumPath, 'utf8'),
    `${checksum}  openkit-skill-v0.1.0-rc.1.tar.gz\n`
  );
  const extractDir = join(repoRoot, 'extract');
  mkdirSync(extractDir);
  const extracted = spawnSync('tar', ['-xzf', result.archivePath, '-C', extractDir], {
    encoding: 'utf8',
  });
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.notEqual(
    statSync(
      join(extractDir, 'openkit-skill-v0.1.0-rc.1', 'skills', 'openkit', 'scripts', 'openkit')
    ).mode & 0o111,
    0
  );
});

test('release packager and shared verifier prove the reproducible NanoHost arm64 asset', () => {
  const fixture = makeNanoHostReleaseFixture();
  const firstOutput = join(fixture.repoRoot, 'dist', 'first');
  const secondOutput = join(fixture.repoRoot, 'dist', 'second');
  const input = {
    binaryPath: fixture.nanohostPath,
    gatewayArchivePath: fixture.gatewayArchivePath,
    openshellLicensePath: fixture.openshellLicensePath,
    openshellNoticesPath: fixture.openshellNoticesPath,
  };

  packageReleaseAssets({
    nanohost: input,
    outputDir: firstOutput,
    ref: 'HEAD',
    repoRoot: fixture.repoRoot,
    tag: 'v0.1.0-rc.1',
  });
  packageReleaseAssets({
    nanohost: input,
    outputDir: secondOutput,
    ref: 'HEAD',
    repoRoot: fixture.repoRoot,
    tag: 'v0.1.0-rc.1',
  });

  const archiveName = 'openkit-nanohost-v0.1.0-rc.1-linux-arm64.tar.gz';
  const firstArchive = join(firstOutput, archiveName);
  const secondArchive = join(secondOutput, archiveName);
  assert.deepEqual(readFileSync(firstArchive), readFileSync(secondArchive));
  assert.deepEqual(
    [...readFileSync(firstArchive).subarray(0, 10)],
    [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03]
  );

  const listed = spawnSync('tar', ['-tzf', firstArchive], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const prefix = 'openkit-nanohost-v0.1.0-rc.1-linux-arm64';
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), [
    `${prefix}/`,
    `${prefix}/MANIFEST.json`,
    `${prefix}/SHA256SUMS`,
    `${prefix}/install.sh`,
    `${prefix}/licenses/`,
    `${prefix}/licenses/openkit-LICENSE`,
    `${prefix}/licenses/openshell-LICENSE`,
    `${prefix}/licenses/openshell-THIRD-PARTY-NOTICES`,
    `${prefix}/nanohost`,
    `${prefix}/openkit-nanohost.service`,
    `${prefix}/openshell-gateway`,
  ]);
  const portableChecksums = readFileSync(join(firstOutput, 'SHA256SUMS'), 'utf8')
    .trim()
    .split('\n');
  assert.deepEqual(
    portableChecksums.map((line) => line.slice(66)).sort(),
    [archiveName, 'openkit-skill-v0.1.0-rc.1.tar.gz'].sort()
  );

  const verifier = join(process.cwd(), 'scripts', 'verify-nanohost-release.mjs');
  assert.ok(existsSync(verifier), 'shared NanoHost release verifier must exist');
  const stagingRoot = join(fixture.repoRoot, 'verified-stage');
  const verified = spawnSync(
    process.execPath,
    [
      verifier,
      '--archive',
      firstArchive,
      '--checksum-file',
      join(firstOutput, 'SHA256SUMS'),
      '--destdir',
      stagingRoot,
      '--repo-root',
      fixture.repoRoot,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /staged-only/);

  const corruptOutput = join(fixture.repoRoot, 'dist', 'corrupt');
  mkdirSync(corruptOutput);
  const corruptArchive = join(corruptOutput, archiveName);
  copyFileSync(firstArchive, corruptArchive);
  copyFileSync(join(firstOutput, 'SHA256SUMS'), join(corruptOutput, 'SHA256SUMS'));
  const corruptBytes = Buffer.from(readFileSync(firstArchive));
  corruptBytes[Math.floor(corruptBytes.length / 2)] ^= 0xff;
  writeFileSync(corruptArchive, corruptBytes);
  const rejectedRoot = join(fixture.repoRoot, 'rejected-stage');
  const rejected = spawnSync(
    process.execPath,
    [
      verifier,
      '--archive',
      corruptArchive,
      '--checksum-file',
      join(corruptOutput, 'SHA256SUMS'),
      '--destdir',
      rejectedRoot,
      '--repo-root',
      fixture.repoRoot,
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(rejectedRoot), false, 'corruption must fail before staging writes');

  const substitutedOutput = join(fixture.repoRoot, 'dist', 'pin-substituted');
  mkdirSync(substitutedOutput);
  const substitutedArchive = join(substitutedOutput, archiveName);
  substituteBundlePin(firstArchive, substitutedArchive, prefix);
  const substitutedDigest = createHash('sha256')
    .update(readFileSync(substitutedArchive))
    .digest('hex');
  writeFileSync(
    join(substitutedOutput, 'SHA256SUMS'),
    readFileSync(join(firstOutput, 'SHA256SUMS'), 'utf8').replace(
      new RegExp(`[a-f0-9]{64}  ${archiveName.replaceAll('.', '\\.')}\\n`, 'u'),
      `${substitutedDigest}  ${archiveName}\n`
    )
  );
  const substitutedRoot = join(fixture.repoRoot, 'pin-substituted-stage');
  const substituted = spawnSync(
    process.execPath,
    [
      verifier,
      '--archive',
      substitutedArchive,
      '--checksum-file',
      join(substitutedOutput, 'SHA256SUMS'),
      '--destdir',
      substitutedRoot,
      '--repo-root',
      fixture.repoRoot,
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(substituted.status, 0);
  assert.match(substituted.stderr, /OpenShell pin/i);
  assert.equal(
    existsSync(substitutedRoot),
    false,
    'a self-consistent substituted bundle pin must fail before staging writes'
  );

  const wrongArchitecture = join(fixture.repoRoot, 'wrong-architecture');
  writeElf(wrongArchitecture, 62);
  assert.throws(
    () =>
      packageReleaseAssets({
        nanohost: { ...input, binaryPath: wrongArchitecture },
        outputDir: join(fixture.repoRoot, 'dist', 'wrong-architecture'),
        ref: 'HEAD',
        repoRoot: fixture.repoRoot,
        tag: 'v0.1.0-rc.1',
      }),
    /AArch64|arm64/
  );
});

test('NanoHost packager projects the promoted Docker and slirp4netns identities', () => {
  const packaged = packageNanoHostFixture();
  const extractedRoot = extractArchive(packaged.archive, packaged.prefix);
  const generatedManifest = readFileSync(join(extractedRoot, 'MANIFEST.json'), 'utf8');
  const hostManifest = JSON.parse(
    readFileSync(join(packaged.fixture.repoRoot, 'apps/nanohost/deploy/host-manifest.json'), 'utf8')
  );
  for (const expected of [
    hostManifest.commands.docker.version,
    hostManifest.commands.slirp4netns.version,
    hostManifest.commands.slirp4netns.sha256,
  ]) {
    assert.match(generatedManifest, new RegExp(escapeRegExp(expected), 'u'));
  }
  const mutationDir = join(packaged.fixture.repoRoot, 'dist', 'host-identity-substitution');
  mkdirSync(mutationDir);
  const mutatedArchive = join(mutationDir, packaged.archiveName);
  rewriteArchive(packaged.archive, mutatedArchive, packaged.prefix, {
    mutateRoot(root) {
      const manifestPath = join(root, 'MANIFEST.json');
      writeFileSync(
        manifestPath,
        readFileSync(manifestPath, 'utf8').replace(
          hostManifest.commands.docker.version,
          `${hostManifest.commands.docker.version}-mismatch`
        )
      );
      refreshInnerChecksums(root);
    },
  });
  const result = runVerifierWithFreshChecksum(
    join(process.cwd(), 'scripts', 'verify-nanohost-release.mjs'),
    mutatedArchive,
    packaged.archiveName,
    packaged.fixture.repoRoot,
    join(packaged.fixture.repoRoot, 'stage-host-identity-substitution')
  );
  assert.notEqual(result.status, 0, 'verifier accepted a substituted generated host identity');
  assert.match(result.stderr, /host manifest|prerequisite|identity/i);
});

test('NanoHost packager rejects incomplete and non-executable ELF64 AArch64 headers', () => {
  const fixture = makeNanoHostReleaseFixture();
  const input = nanoHostInput(fixture);
  const cases = [
    ['ET_REL', (bytes) => withUInt16(bytes, 16, 1)],
    ['truncated header', (bytes) => bytes.subarray(0, 63)],
    ['invalid ELF identity version', (bytes) => withByte(bytes, 6, 0)],
    ['invalid ELF version', (bytes) => withUInt32(bytes, 20, 0)],
    ['invalid ELF header size', (bytes) => withUInt16(bytes, 52, 0)],
  ];
  for (const [label, mutate] of cases) {
    const malformed = join(fixture.repoRoot, `malformed-${label.replaceAll(' ', '-')}`);
    writeFileSync(malformed, mutate(readFileSync(fixture.nanohostPath)), { mode: 0o755 });
    assert.throws(
      () =>
        packageReleaseAssets({
          nanohost: { ...input, binaryPath: malformed },
          outputDir: join(fixture.repoRoot, 'dist', `malformed-${label.replaceAll(' ', '-')}`),
          ref: 'HEAD',
          repoRoot: fixture.repoRoot,
          tag: 'v0.1.0-rc.1',
        }),
      /ELF|executable|ET_EXEC|ET_DYN/i,
      label
    );
  }
});

test('shared NanoHost verifier rejects noncanonical tar and gzip metadata', () => {
  const packaged = packageNanoHostFixture();
  const verifier = join(process.cwd(), 'scripts', 'verify-nanohost-release.mjs');
  const reordered = canonicalArchiveMembers(packaged.prefix);
  [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
  for (const [label, mutation, assertMutation] of [
    ['numeric uid', { owner: 123 }, (archive) => assert.match(archiveMetadata(archive), /123\/0/u)],
    ['numeric gid', { group: 456 }, (archive) => assert.match(archiveMetadata(archive), /0\/456/u)],
    [
      'Unix-epoch mtime',
      { mtime: 1 },
      (archive) => assert.match(archiveMetadata(archive), /1970-01-01 00:00:01/u),
    ],
    ['gzip header', { gzipOs: 0 }, (archive) => assert.equal(readFileSync(archive)[9], 0)],
    [
      'directory mode',
      { mutateRoot: (root) => chmodSync(join(root, 'licenses'), 0o700) },
      (archive) => assert.equal(archiveMode(archive, packaged.prefix, 'licenses'), 0o700),
    ],
    [
      'file mode',
      { mutateRoot: (root) => chmodSync(join(root, 'install.sh'), 0o644) },
      (archive) => assert.equal(archiveMode(archive, packaged.prefix, 'install.sh'), 0o644),
    ],
    [
      'member order',
      { members: reordered },
      (archive) => assert.equal(archiveMembers(archive)[2], `${packaged.prefix}/SHA256SUMS`),
    ],
  ]) {
    const mutationDir = join(packaged.fixture.repoRoot, 'dist', label.replaceAll(' ', '-'));
    mkdirSync(mutationDir);
    const mutatedArchive = join(mutationDir, packaged.archiveName);
    rewriteArchive(packaged.archive, mutatedArchive, packaged.prefix, mutation);
    assertMutation(mutatedArchive);
    const result = runVerifierWithFreshChecksum(
      verifier,
      mutatedArchive,
      packaged.archiveName,
      packaged.fixture.repoRoot,
      join(packaged.fixture.repoRoot, `stage-${label.replaceAll(' ', '-')}`)
    );
    assert.notEqual(result.status, 0, `verifier accepted wrong ${label}`);
    assert.match(result.stderr, /archive|metadata|gzip|owner|mtime/i);
  }
});

test('shared NanoHost verifier rejects a malformed packaged executable', () => {
  const packaged = packageNanoHostFixture();
  const mutationDir = join(packaged.fixture.repoRoot, 'dist', 'malformed-verifier');
  mkdirSync(mutationDir);
  const mutatedArchive = join(mutationDir, packaged.archiveName);
  rewriteArchive(packaged.archive, mutatedArchive, packaged.prefix, {
    mutateRoot(root) {
      const path = join(root, 'nanohost');
      writeFileSync(path, withUInt16(readFileSync(path), 16, 1), { mode: 0o755 });
      refreshInnerChecksums(root);
    },
  });
  const extracted = extractArchive(mutatedArchive, packaged.prefix);
  assert.equal(readFileSync(join(extracted, 'nanohost')).readUInt16LE(16), 1);
  rmSync(dirname(extracted), { force: true, recursive: true });
  const result = runVerifierWithFreshChecksum(
    join(process.cwd(), 'scripts', 'verify-nanohost-release.mjs'),
    mutatedArchive,
    packaged.archiveName,
    packaged.fixture.repoRoot,
    join(packaged.fixture.repoRoot, 'stage-malformed-verifier')
  );
  assert.notEqual(result.status, 0, 'verifier accepted an ET_REL NanoHost payload');
  assert.match(result.stderr, /ELF|executable|ET_EXEC|ET_DYN/i);
});

test('shared NanoHost verifier rejects substituted checkout-owned bytes', () => {
  const packaged = packageNanoHostFixture();
  const verifier = join(process.cwd(), 'scripts', 'verify-nanohost-release.mjs');
  for (const [member, label] of [
    ['install.sh', 'installer'],
    ['openkit-nanohost.service', 'service-unit'],
    ['licenses/openkit-LICENSE', 'OpenKit-license'],
  ]) {
    const mutationDir = join(packaged.fixture.repoRoot, 'dist', `substituted-${label}`);
    mkdirSync(mutationDir);
    const mutatedArchive = join(mutationDir, packaged.archiveName);
    rewriteArchive(packaged.archive, mutatedArchive, packaged.prefix, {
      mutateRoot(root) {
        writeFileSync(
          join(root, member),
          Buffer.concat([readFileSync(join(root, member)), Buffer.from('\n')])
        );
        refreshInnerChecksums(root);
      },
    });
    const result = runVerifierWithFreshChecksum(
      verifier,
      mutatedArchive,
      packaged.archiveName,
      packaged.fixture.repoRoot,
      join(packaged.fixture.repoRoot, `stage-substituted-${label}`)
    );
    assert.notEqual(result.status, 0, `verifier accepted substituted ${label}`);
    assert.match(result.stderr, /checkout|differs/i);
  }
});

function nanoHostInput(fixture) {
  return {
    binaryPath: fixture.nanohostPath,
    gatewayArchivePath: fixture.gatewayArchivePath,
    openshellLicensePath: fixture.openshellLicensePath,
    openshellNoticesPath: fixture.openshellNoticesPath,
  };
}

function packageNanoHostFixture() {
  const fixture = makeNanoHostReleaseFixture();
  const outputDir = join(fixture.repoRoot, 'dist', 'release');
  packageReleaseAssets({
    nanohost: nanoHostInput(fixture),
    outputDir,
    ref: 'HEAD',
    repoRoot: fixture.repoRoot,
    tag: 'v0.1.0-rc.1',
  });
  const archiveName = 'openkit-nanohost-v0.1.0-rc.1-linux-arm64.tar.gz';
  return {
    archive: join(outputDir, archiveName),
    archiveName,
    fixture,
    prefix: archiveName.slice(0, -'.tar.gz'.length),
  };
}

function makeNanoHostReleaseFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-release-'));
  mkdirSync(join(repoRoot, 'skills', 'openkit', 'scripts'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps', 'nanohost', 'deploy'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps', 'nanohost', 'openshell-pin'), { recursive: true });
  writeFileSync(join(repoRoot, 'LICENSE'), 'OpenKit license fixture\n');
  writeFileSync(join(repoRoot, 'skills', 'openkit', 'SKILL.md'), '# Fixture Skill\n');
  const cliPath = join(repoRoot, 'skills', 'openkit', 'scripts', 'openkit');
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  chmodSync(cliPath, 0o755);
  writeFileSync(
    join(repoRoot, 'apps', 'nanohost', 'deploy', 'openkit-nanohost.service'),
    '[Service]\nExecStart=/usr/lib/openkit/nanohost\n'
  );
  const fixtureInstaller = join(repoRoot, 'apps', 'nanohost', 'deploy', 'install.sh');
  const productionInstaller = join(process.cwd(), 'apps', 'nanohost', 'deploy', 'install.sh');
  if (existsSync(productionInstaller)) {
    copyFileSync(productionInstaller, fixtureInstaller);
  } else {
    writeFileSync(fixtureInstaller, '#!/bin/sh\nexit 99\n');
  }
  chmodSync(fixtureInstaller, 0o755);
  writeFileSync(
    join(repoRoot, 'apps', 'nanohost', 'deploy', 'host-manifest.json'),
    `${JSON.stringify(
      {
        architecture: 'aarch64',
        cgroupMode: 'unified-v2',
        commands: {
          docker: { path: '/usr/bin/docker', version: 'Docker fixture version' },
          slirp4netns: {
            path: '/usr/bin/slirp4netns',
            version: 'slirp4netns fixture version',
            sha256: '1'.repeat(64),
          },
        },
        containerRuntime: 'docker',
        initSystem: 'systemd',
        kernelRelease: 'fixture-kernel',
        schemaVersion: 1,
      },
      null,
      2
    )}\n`
  );

  const nanohostPath = join(repoRoot, 'nanohost-input');
  const gatewayPath = join(repoRoot, 'openshell-gateway');
  writeElf(nanohostPath, 183, { type: 3 });
  writeElf(gatewayPath, 183);
  const gatewayArchivePath = join(repoRoot, 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz');
  const archived = spawnSync(
    'tar',
    ['-czf', gatewayArchivePath, '-C', repoRoot, 'openshell-gateway'],
    {
      encoding: 'utf8',
    }
  );
  assert.equal(archived.status, 0, archived.stderr);

  const openshellLicensePath = join(repoRoot, 'openshell-LICENSE-input');
  const openshellNoticesPath = join(repoRoot, 'openshell-THIRD-PARTY-NOTICES-input');
  writeFileSync(openshellLicensePath, 'OpenShell license fixture\n');
  writeFileSync(openshellNoticesPath, 'OpenShell notices fixture\n');
  const checksum = (path) =>
    `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  const commit = '8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032';
  const pin = {
    source: { tag: 'v0.0.99', commit },
    artifacts: [
      {
        kind: 'gateway-executable',
        name: 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz',
        representation: 'release-archive',
        platform: 'linux/arm64',
        checksum: checksum(gatewayArchivePath),
        tag: 'v0.0.99',
        commit,
      },
      {
        kind: 'gateway-executable',
        name: 'openshell-gateway',
        representation: 'extracted-executable',
        platform: 'linux/arm64',
        derivedFrom: 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz',
        checksum: checksum(gatewayPath),
        tag: 'v0.0.99',
        commit,
      },
      {
        kind: 'redistribution-license',
        name: 'LICENSE',
        representation: 'source-file',
        sourcePath: 'LICENSE',
        bundlePath: 'licenses/openshell-LICENSE',
        checksum: checksum(openshellLicensePath),
        tag: 'v0.0.99',
        commit,
      },
      {
        kind: 'redistribution-notices',
        name: 'THIRD-PARTY-NOTICES',
        representation: 'source-file',
        sourcePath: 'THIRD-PARTY-NOTICES',
        bundlePath: 'licenses/openshell-THIRD-PARTY-NOTICES',
        checksum: checksum(openshellNoticesPath),
        tag: 'v0.0.99',
        commit,
      },
    ],
  };
  writeFileSync(
    join(repoRoot, 'apps', 'nanohost', 'openshell-pin', 'manifest.md'),
    `# OpenShell Pin Manifest\n\n\`\`\`json\n${JSON.stringify(pin, null, 2)}\n\`\`\`\n`
  );

  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'release-test@openkit.local']);
  git(repoRoot, ['config', 'user.name', 'OpenKit Release Test']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'fixture']);
  return {
    gatewayArchivePath,
    nanohostPath,
    openshellLicensePath,
    openshellNoticesPath,
    repoRoot,
  };
}

function writeElf(path, machine, options = {}) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(options.type ?? 2, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  writeFileSync(path, bytes, { mode: 0o755 });
}

function extractArchive(archive, prefix) {
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-nanohost-extract-'));
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporary], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  return join(temporary, prefix);
}

function refreshInnerChecksums(root) {
  const checksumPath = join(root, 'SHA256SUMS');
  const names = readFileSync(checksumPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => line.slice(66));
  writeFileSync(
    checksumPath,
    `${names
      .map(
        (name) =>
          `${createHash('sha256')
            .update(readFileSync(join(root, name)))
            .digest('hex')}  ${name}`
      )
      .join('\n')}\n`
  );
}

function rewriteArchive(sourceArchive, targetArchive, prefix, options = {}) {
  const root = extractArchive(sourceArchive, prefix);
  const temporary = join(root, '..');
  try {
    options.mutateRoot?.(root);
    const tarPath = join(temporary, 'mutated.tar');
    const members = options.members ?? canonicalArchiveMembers(prefix);
    const archived = spawnSync(
      'tar',
      [
        '--format=gnu',
        '--no-recursion',
        `--mtime=@${options.mtime ?? 0}`,
        `--owner=${options.owner ?? 0}`,
        `--group=${options.group ?? 0}`,
        '--numeric-owner',
        '-cf',
        tarPath,
        '--',
        ...members,
      ],
      { cwd: temporary, encoding: 'utf8' }
    );
    assert.equal(archived.status, 0, archived.stderr);
    const compressed = spawnSync('gzip', ['-n', '-9', '-c', tarPath], { encoding: null });
    assert.equal(compressed.status, 0, compressed.stderr?.toString());
    const bytes = Buffer.from(compressed.stdout);
    if (options.gzipOs !== undefined) bytes[9] = options.gzipOs;
    writeFileSync(targetArchive, bytes);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

function canonicalArchiveMembers(prefix) {
  return [
    prefix,
    `${prefix}/licenses`,
    'MANIFEST.json',
    'SHA256SUMS',
    'install.sh',
    'licenses/openkit-LICENSE',
    'licenses/openshell-LICENSE',
    'licenses/openshell-THIRD-PARTY-NOTICES',
    'nanohost',
    'openkit-nanohost.service',
    'openshell-gateway',
  ].map((name, index) => (index < 2 ? name : `${prefix}/${name}`));
}

function archiveMembers(archive) {
  const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.trimEnd().split('\n');
}

function archiveMetadata(archive) {
  const listed = spawnSync('tar', ['--numeric-owner', '--full-time', '--utc', '-tvzf', archive], {
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout;
}

function archiveMode(archive, prefix, member) {
  const root = extractArchive(archive, prefix);
  try {
    return statSync(join(root, member)).mode & 0o777;
  } finally {
    rmSync(dirname(root), { force: true, recursive: true });
  }
}

function runVerifierWithFreshChecksum(verifier, archive, archiveName, repoRoot, destdir) {
  const checksumFile = `${archive}.SHA256SUMS`;
  writeFileSync(
    checksumFile,
    `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archiveName}\n`
  );
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--archive',
      archive,
      '--checksum-file',
      checksumFile,
      '--destdir',
      destdir,
      '--repo-root',
      repoRoot,
    ],
    { encoding: 'utf8' }
  );
}

function withByte(bytes, offset, value) {
  const copy = Buffer.from(bytes);
  copy[offset] = value;
  return copy;
}

function withUInt16(bytes, offset, value) {
  const copy = Buffer.from(bytes);
  copy.writeUInt16LE(value, offset);
  return copy;
}

function withUInt32(bytes, offset, value) {
  const copy = Buffer.from(bytes);
  copy.writeUInt32LE(value, offset);
  return copy;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function substituteBundlePin(sourceArchive, targetArchive, prefix) {
  rewriteArchive(sourceArchive, targetArchive, prefix, {
    mutateRoot(root) {
      const gatewayPath = join(root, 'openshell-gateway');
      const gateway = Buffer.from(readFileSync(gatewayPath));
      gateway[32] ^= 0xff;
      writeFileSync(gatewayPath, gateway);
      const manifestPath = join(root, 'MANIFEST.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.openshellPin.gateway.sha256 = createHash('sha256').update(gateway).digest('hex');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      refreshInnerChecksums(root);
    },
  });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
