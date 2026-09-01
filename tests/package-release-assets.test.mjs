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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(rejectedRoot), false, 'corruption must fail before staging writes');

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

  const nanohostPath = join(repoRoot, 'nanohost-input');
  const gatewayPath = join(repoRoot, 'openshell-gateway');
  writeElf(nanohostPath, 183);
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

function writeElf(path, machine) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  writeFileSync(path, bytes, { mode: 0o755 });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
