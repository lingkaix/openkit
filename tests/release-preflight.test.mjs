import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateReleasePreflight } from '../scripts/release-preflight.mjs';

const preflightScript = join(process.cwd(), 'scripts', 'release-preflight.mjs');

test('release preflight accepts product tags independently of private package versions', () => {
  const repoRoot = makeReleaseFixture({ packageVersion: '9.9.9' });

  const result = validateReleasePreflight({
    repoRoot,
    requireReleaseImageDigests: true,
    tag: 'v0.0.1',
  });

  assert.equal(result.version, '0.0.1');
  assert.deepEqual(result.releaseImages, ['app', 'worker-base', 'worker-codex']);
});

test('release preflight rejects a missing public release worker base', () => {
  const repoRoot = makeReleaseFixture({ includeReleaseWorkerBase: false });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /exactly one public release worker base/
  );
});

test('release preflight requires one explicitly anonymous public worker base', () => {
  const missingFlagRoot = makeReleaseFixture({ baseAnonymousPull: false });
  const invalidFlagRoot = makeReleaseFixture({ baseAnonymousPull: 'yes' });
  const leafFlagRoot = makeReleaseFixture({ leafAnonymousPull: true });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot: missingFlagRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /must declare anonymousPull: true/
  );
  assert.throws(
    () => validateReleasePreflight({ repoRoot: invalidFlagRoot, tag: 'v0.0.1' }),
    /anonymousPull must be a boolean/
  );
  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot: leafFlagRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /only the public release worker base/
  );
});

test('release preflight rejects a structural empty-declared-set worker base that declares workerContract', () => {
  const repoRoot = makeReleaseFixture({
    baseHasWorkerContract: true,
    includeReleaseWorkerBase: true,
  });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /workerContract/
  );
});

test('release preflight rejects more than one structural empty-declared-set worker base', () => {
  const repoRoot = makeReleaseFixture({
    includeReleaseWorkerBase: true,
    includeSecondReleaseWorkerBase: true,
  });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /empty declared|more than one|duplicate .*base/i
  );
});

test('release preflight rejects uppercase release tags and prerelease identifiers', () => {
  const repoRoot = makeReleaseFixture();

  for (const tag of ['V0.0.1', 'v0.0.1-RC.1', 'v0.0.1-Beta']) {
    assert.throws(
      () => validateReleasePreflight({ repoRoot, requireReleaseImageDigests: true, tag }),
      /Release tag must match/
    );
  }
});

test('release preflight rejects non-semantic release tags', () => {
  const repoRoot = makeReleaseFixture();

  for (const tag of ['v01.0.0', 'v0.0.1-', 'v0.0.1-rc..1', 'v0.0.1-01']) {
    assert.throws(() => validateReleasePreflight({ repoRoot, tag }), /Release tag must match/);
  }
});

test('release preflight can block stable tags while the first stable release is not admitted', () => {
  const repoRoot = makeReleaseFixture();

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requirePrerelease: true,
        tag: 'v0.0.1',
      }),
    /must identify a prerelease/
  );
  assert.doesNotThrow(() =>
    validateReleasePreflight({ repoRoot, requirePrerelease: true, tag: 'v0.0.1-rc.1' })
  );
});

test('release preflight CLI defaults to prerelease-only and digest-pinned release inputs', () => {
  const repoRoot = makeReleaseFixture();
  const prerelease = runPreflightCli(repoRoot, 'v0.0.1-rc.1');
  const stable = runPreflightCli(repoRoot, 'v0.0.1');
  const unpinned = runPreflightCli(
    makeReleaseFixture({ workerBaseImage: 'node:24-bookworm-slim' }),
    'v0.0.1-rc.1'
  );

  assert.equal(prerelease.status, 0, prerelease.stderr);
  assert.notEqual(stable.status, 0);
  assert.match(stable.stderr, /must identify a prerelease/);
  assert.notEqual(unpinned.status, 0);
  assert.match(unpinned.stderr, /must use a digest-pinned baseImage/);
});

test('release preflight rejects an unpinned release worker image', () => {
  const repoRoot = makeReleaseFixture({ workerBaseImage: 'node:24-bookworm-slim' });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /Release image worker-codex must use a digest-pinned baseImage/
  );
});

test('release preflight rejects an unpinned app base image', () => {
  const repoRoot = makeReleaseFixture({ appBaseImage: 'node:24-bookworm-slim' });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /Release image app must use a digest-pinned baseImage/
  );
});

test('release preflight rejects a missing portable Skill input', () => {
  const repoRoot = makeReleaseFixture({ omitSkillManifest: true });

  assert.throws(
    () => validateReleasePreflight({ repoRoot, tag: 'v0.0.1' }),
    /Portable release input does not exist: skills\/openkit\/SKILL\.md/
  );
});

test('release preflight rejects a missing NanoHost distribution input', () => {
  const repoRoot = makeReleaseFixture({ omitNanoHostInstaller: true });

  assert.throws(
    () => validateReleasePreflight({ repoRoot, tag: 'v0.0.1-rc.1' }),
    /NanoHost release input does not exist: apps\/nanohost\/deploy\/install\.sh/
  );
});

test('release preflight rejects an incomplete or target-inconsistent OpenShell release', () => {
  const incompleteRoot = makeReleaseFixture({ omitNanoHostSupervisorArm64: true });
  const wrongTargetRoot = makeReleaseFixture({ nanoHostGatewayTarget: 'linux/amd64' });

  assert.throws(
    () => validateReleasePreflight({ repoRoot: incompleteRoot, tag: 'v0.0.1-rc.1' }),
    /linux\/arm64|supervisor|OpenShell release/i
  );
  assert.throws(
    () => validateReleasePreflight({ repoRoot: wrongTargetRoot, tag: 'v0.0.1-rc.1' }),
    /linux\/arm64|OpenShell release/i
  );
});

test('release preflight accepts a coherent OpenShell release update without a hard-coded version', () => {
  const commit = '1'.repeat(40);
  const repoRoot = makeReleaseFixture({
    nanoHostOpenShellVersion: '0.0.100',
    nanoHostSourceCommit: commit,
    nanoHostCargoRev: commit,
    nanoHostLockRev: commit,
  });

  assert.doesNotThrow(() => validateReleasePreflight({ repoRoot, tag: 'v0.1.0-rc.1' }));
});

test('release preflight rejects OpenShell release drift from Cargo and its lockfile', () => {
  for (const [label, options] of [
    ['Cargo source revision', { nanoHostCargoRev: '1'.repeat(40) }],
    ['Cargo lock revision', { nanoHostLockRev: '1'.repeat(40) }],
    ['Gateway archive', { nanoHostGatewayArchiveName: 'openshell-gateway-other.tar.gz' }],
  ]) {
    const repoRoot = makeReleaseFixture(options);
    assert.throws(
      () => validateReleasePreflight({ repoRoot, tag: 'v0.1.0-rc.1' }),
      /Cargo|revision|openshell-gateway-aarch64-unknown-linux-gnu|OpenShell release/i,
      `preflight accepted substituted ${label}`
    );
  }
});

test('release preflight requires one coherent promoted host manifest', () => {
  const missing = makeReleaseFixture({ omitHostManifest: true });
  const wrongDockerPath = makeReleaseFixture({ hostDockerPath: '/usr/local/bin/docker' });

  assert.throws(
    () => validateReleasePreflight({ repoRoot: missing, tag: 'v0.1.0-rc.1' }),
    /apps\/nanohost\/deploy\/host-manifest\.json/
  );
  assert.throws(
    () => validateReleasePreflight({ repoRoot: wrongDockerPath, tag: 'v0.1.0-rc.1' }),
    /host manifest|\/usr\/bin\/docker/i
  );
});

test('release preflight rejects deployment workers without a runtime', () => {
  const repoRoot = makeReleaseFixture({ omitWorkerRuntime: true });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /Worker image worker-codex is missing runtime/
  );
});

test('release preflight rejects deployment workers without a workerContract', () => {
  const repoRoot = makeReleaseFixture({ omitWorkerContract: true });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /Worker image worker-codex is missing workerContract/
  );
});

test('release preflight rejects non-string worker runtime metadata', () => {
  const repoRoot = makeReleaseFixture({ workerRuntime: [] });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /runtime must be a non-empty string/
  );
});

test('release preflight rejects non-string worker contract metadata', () => {
  const repoRoot = makeReleaseFixture({ workerContract: [] });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /workerContract must be a non-empty string/
  );
});

test('release preflight rejects worker images without an explicit build target', () => {
  const repoRoot = makeReleaseFixture({ omitWorkerTarget: true });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /Worker image worker-codex is missing target/
  );
});

/**
 * Creates a small release-shaped repository fixture.
 *
 * @param {object} [options] Fixture options.
 * @param {boolean} [options.baseHasWorkerContract] Whether the structural empty-declared-set base also declares workerContract.
 * @param {unknown} [options.baseAnonymousPull] Anonymous-pull fixture value for the structural base.
 * @param {boolean} [options.includeReleaseWorkerBase] Whether to add one structural worker base with an empty declared runtime set.
 * @param {boolean} [options.includeSecondReleaseWorkerBase] Whether to add a second structural empty-declared-set worker base.
 * @param {boolean} [options.leafAnonymousPull] Whether the deployment leaf incorrectly declares anonymous pull.
 * @param {string} [options.appBaseImage] App base image manifest value.
 * @param {string} [options.packageVersion] Version written into the workspace package.
 * @param {boolean} [options.omitSkillManifest] Whether to omit the Skill manifest.
 * @param {boolean} [options.omitWorkerContract] Whether to omit the deployment workerContract.
 * @param {boolean} [options.omitWorkerRuntime] Whether to omit the deployment worker runtime.
 * @param {boolean} [options.omitWorkerTarget] Whether to omit the worker Docker target.
 * @param {boolean} [options.omitNanoHostInstaller] Whether to omit the NanoHost installer.
 * @param {string} [options.nanoHostSourceCommit] OpenShell source commit.
 * @param {string} [options.nanoHostOpenShellVersion] OpenShell release version.
 * @param {string} [options.nanoHostGatewayTarget] Gateway release target.
 * @param {string} [options.nanoHostCargoRev] Cargo dependency revision.
 * @param {string} [options.nanoHostLockRev] Cargo lockfile revision.
 * @param {boolean} [options.omitNanoHostSupervisorArm64] Whether to omit the arm64 Supervisor digest.
 * @param {string} [options.nanoHostGatewayArchiveName] Gateway release archive name.
 * @param {boolean} [options.omitHostManifest] Whether to omit the promoted execution-host manifest.
 * @param {string} [options.hostDockerPath] Docker path projected by the promoted manifest.
 * @param {string} [options.workerBaseImage] Worker base image manifest value.
 * @param {unknown} [options.workerContract] Worker contract fixture value.
 * @param {unknown} [options.workerRuntime] Worker runtime fixture value.
 * @returns {string} Temporary repository root.
 */
function makeReleaseFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-release-preflight-'));
  const version = '0.0.1';
  const packageVersion = options.packageVersion ?? version;
  const digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const appBaseImage = options.appBaseImage ?? `node:24-bookworm-slim@sha256:${digest}`;
  const workerBaseImage = options.workerBaseImage ?? `node:24-bookworm-slim@sha256:${digest}`;
  const includeReleaseWorkerBase = options.includeReleaseWorkerBase !== false;
  const includeSecondReleaseWorkerBase = options.includeSecondReleaseWorkerBase === true;

  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    private: true,
    version,
  });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  writeFileSync(join(root, 'LICENSE'), 'fixture license\n');
  mkdirSync(join(root, 'skills', 'openkit', 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills', 'openkit', 'scripts'), { recursive: true });
  if (!options.omitSkillManifest) {
    writeFileSync(join(root, 'skills', 'openkit', 'SKILL.md'), '# Fixture Skill\n');
  }
  writeFileSync(join(root, 'skills', 'openkit', 'agents', 'openai.yaml'), 'interface: fixture\n');
  const cliPath = join(root, 'skills', 'openkit', 'scripts', 'openkit');
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  chmodSync(cliPath, 0o755);

  mkdirSync(join(root, 'apps', 'nanohost', 'deploy'), { recursive: true });
  mkdirSync(join(root, 'apps', 'nanohost', 'openshell'), { recursive: true });
  writeFileSync(
    join(root, 'apps', 'nanohost', 'deploy', 'openkit-nanohost.service'),
    '[Service]\nExecStart=/usr/lib/openkit/nanohost\n'
  );
  if (!options.omitNanoHostInstaller) {
    const installer = join(root, 'apps', 'nanohost', 'deploy', 'install.sh');
    writeFileSync(installer, '#!/bin/sh\nexit 0\n');
    chmodSync(installer, 0o755);
  }
  if (!options.omitHostManifest) {
    writeJson(join(root, 'apps', 'nanohost', 'deploy', 'host-manifest.json'), {
      architecture: 'aarch64',
      cgroupMode: 'unified-v2',
      commands: {
        docker: {
          path: options.hostDockerPath ?? '/usr/bin/docker',
          version: 'Docker fixture version',
        },
        slirp4netns: {
          path: '/usr/bin/slirp4netns',
          sha256: '1'.repeat(64),
          version: 'slirp4netns fixture version',
        },
      },
      containerRuntime: 'docker',
      initSystem: 'systemd',
      kernelRelease: 'fixture-kernel',
      schemaVersion: 1,
    });
  }
  const release = makeOpenShellRelease(options);
  writeJson(join(root, 'apps', 'nanohost', 'openshell', 'release.json'), release);
  const cargoRev = options.nanoHostCargoRev ?? release.source.commit;
  const lockRev = options.nanoHostLockRev ?? cargoRev;
  writeFileSync(
    join(root, 'apps', 'nanohost', 'Cargo.toml'),
    `[dependencies]\nopenshell-sdk = { git = "https://github.com/NVIDIA/OpenShell.git", rev = "${cargoRev}" }\n`
  );
  writeFileSync(
    join(root, 'apps', 'nanohost', 'Cargo.lock'),
    `[[package]]\nname = "openshell-sdk"\nversion = "0.0.0"\nsource = "git+https://github.com/NVIDIA/OpenShell.git?rev=${lockRev}#${lockRev}"\n`
  );

  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  writeJson(join(root, 'apps', 'web', 'package.json'), {
    name: '@openkit/web',
    version: packageVersion,
  });
  mkdirSync(join(root, 'packages', 'protocol'), { recursive: true });
  writeJson(join(root, 'packages', 'protocol', 'package.json'), {
    name: '@openkit/protocol',
    version,
  });

  for (const image of ['app', 'worker-codex']) {
    mkdirSync(join(root, 'containers', image), { recursive: true });
    writeFileSync(join(root, 'containers', image, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(root, 'containers', image, 'smoke.sh'), '#!/usr/bin/env bash\n');
  }
  if (includeReleaseWorkerBase || includeSecondReleaseWorkerBase) {
    mkdirSync(join(root, 'containers', 'workers'), { recursive: true });
    writeFileSync(join(root, 'containers', 'workers', 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(
      join(root, 'containers', 'workers', 'openkit-worker-common-base-smoke.sh'),
      '#!/usr/bin/env bash\n'
    );
  }

  writeJson(join(root, 'containers', 'images.json'), {
    schemaVersion: 1,
    registry: 'ghcr.io',
    images: [
      {
        id: 'app',
        repository: 'openkit-app',
        dockerfile: 'containers/app/Dockerfile',
        context: '.',
        kind: 'app',
        release: true,
        baseImage: appBaseImage,
        platforms: ['linux/amd64'],
        smoke: 'containers/app/smoke.sh',
        smokeCommand: 'openkit-app-smoke',
        localTag: 'openkit/app:dev',
      },
      ...(includeReleaseWorkerBase
        ? [
            makeReleaseWorkerBaseEntry({
              anonymousPull: options.baseAnonymousPull ?? true,
              hasWorkerContract: options.baseHasWorkerContract === true,
              id: 'worker-base',
              repository: 'openkit-worker-base',
              target: 'worker-base',
            }),
          ]
        : []),
      ...(includeSecondReleaseWorkerBase
        ? [
            makeReleaseWorkerBaseEntry({
              anonymousPull: true,
              id: 'worker-extension-base',
              repository: 'openkit-worker-extension-base',
              target: 'worker-extension-base',
            }),
          ]
        : []),
      {
        id: 'worker-codex',
        repository: 'openkit-worker-codex',
        dockerfile: 'containers/worker-codex/Dockerfile',
        context: '.',
        kind: 'worker',
        ...(options.omitWorkerRuntime ? {} : { runtime: options.workerRuntime ?? 'codex' }),
        release: true,
        ...(options.leafAnonymousPull ? { anonymousPull: true } : {}),
        ...(options.omitWorkerContract
          ? {}
          : { workerContract: options.workerContract ?? 'openkit-worker-v1' }),
        baseImage: workerBaseImage,
        ...(options.omitWorkerTarget ? {} : { target: 'worker-codex' }),
        platforms: ['linux/amd64'],
        smoke: 'containers/worker-codex/smoke.sh',
        smokeCommand: 'openkit-worker-codex-smoke',
        localTag: 'openkit/worker-codex:dev',
      },
    ],
  });

  return root;
}

function makeOpenShellRelease(options = {}) {
  const checksum = '0'.repeat(64);
  const commit = options.nanoHostSourceCommit ?? '8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032';
  const version = options.nanoHostOpenShellVersion ?? '0.0.99';
  return {
    schemaVersion: 1,
    version,
    source: { commit },
    gateway: {
      archive: {
        name:
          options.nanoHostGatewayArchiveName ??
          'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz',
        target: options.nanoHostGatewayTarget ?? 'linux/arm64',
        sha256: checksum,
      },
      executable: {
        name: 'openshell-gateway',
        derivedFrom: 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz',
        sha256: checksum,
      },
    },
    supervisor: {
      repository: 'ghcr.io/nvidia/openshell/supervisor',
      platformDigests: {
        'linux/amd64': `sha256:${'1'.repeat(64)}`,
        ...(options.omitNanoHostSupervisorArm64
          ? {}
          : { 'linux/arm64': `sha256:${'2'.repeat(64)}` }),
      },
    },
    redistribution: {
      license: {
        sourcePath: 'LICENSE',
        bundlePath: 'licenses/openshell-LICENSE',
        sha256: checksum,
      },
      notices: {
        sourcePath: 'THIRD-PARTY-NOTICES',
        bundlePath: 'licenses/openshell-THIRD-PARTY-NOTICES',
        sha256: checksum,
      },
    },
  };
}

/**
 * Builds one structural empty-declared-set release worker catalog entry that is not identified by a reserved id.
 *
 * @param {object} options Entry fields.
 * @param {boolean} options.anonymousPull Whether the base must be anonymously pullable.
 * @param {boolean} [options.hasWorkerContract] Whether to declare workerContract on the base.
 * @param {string} options.id Catalog id.
 * @param {string} options.repository Image repository.
 * @param {string} options.target Docker target.
 * @returns {object} Catalog image entry.
 */
function makeReleaseWorkerBaseEntry(options) {
  return {
    id: options.id,
    repository: options.repository,
    dockerfile: 'containers/workers/Dockerfile',
    target: options.target,
    context: '.',
    kind: 'worker',
    release: true,
    anonymousPull: options.anonymousPull,
    ...(options.hasWorkerContract ? { workerContract: 'openkit-worker-v1' } : {}),
    baseImage:
      'node:24-bookworm-slim@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    platforms: ['linux/amd64'],
    smoke: 'containers/workers/openkit-worker-common-base-smoke.sh',
    smokeCommand: 'openkit-worker-common-base-smoke',
    localTag: `openkit/${options.id}:dev`,
  };
}

/**
 * Writes JSON with stable formatting.
 *
 * @param {string} path Target path.
 * @param {unknown} value JSON value.
 */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Runs the real release-preflight CLI against one isolated fixture. */
function runPreflightCli(repoRoot, tag) {
  return spawnSync(process.execPath, [preflightScript, '--repo-root', repoRoot, '--tag', tag], {
    encoding: 'utf8',
  });
}
