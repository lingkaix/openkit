import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseOpenShellRelease, validateReleasePreflight } from '../scripts/release-preflight.mjs';

const preflightScript = join(process.cwd(), 'scripts', 'release-preflight.mjs');

test('release preflight accepts product tags independently of private package versions', () => {
  const repoRoot = makeReleaseFixture({ packageVersion: '9.9.9' });

  const result = validateReleasePreflight({
    repoRoot,
    requireReleaseImageDigests: true,
    tag: 'v0.0.1',
  });

  assert.equal(result.version, '0.0.1');
  assert.deepEqual(result.releaseImages, ['app', 'worker-base', 'worker-runtimes']);
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
    /Release image worker-runtimes must use a digest-pinned baseImage/
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

test('release preflight rejects a missing administrator executable', () => {
  const repoRoot = makeReleaseFixture({ omitCli: true });
  assert.throws(
    () => validateReleasePreflight({ repoRoot, tag: 'v0.0.1' }),
    /Portable release input does not exist: skills\/openkit-ops\/scripts\/openkit/
  );
});

test('release preflight rejects a non-executable administrator CLI', () => {
  const repoRoot = makeReleaseFixture();
  chmodSync(join(repoRoot, 'skills', 'openkit-ops', 'scripts', 'openkit'), 0o644);
  assert.throws(() => validateReleasePreflight({ repoRoot, tag: 'v0.0.1' }), /must be executable/);
});

test('release preflight rejects a missing operations Skill input', () => {
  const repoRoot = makeReleaseFixture({ omitOpsSkillManifest: true });

  assert.throws(
    () => validateReleasePreflight({ repoRoot, tag: 'v0.0.1' }),
    /Portable release input does not exist: skills\/openkit-ops\/SKILL\.md/
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

for (const [field, mutate] of [
  [
    'archive name',
    (release) => {
      release.gateway.targets['linux/arm64'].archive.name = 'other-gateway.tar.gz';
      release.gateway.targets['linux/arm64'].executable.derivedFrom =
        release.gateway.targets['linux/arm64'].archive.name;
    },
  ],
  [
    'executable name',
    (release) => {
      release.gateway.targets['linux/arm64'].executable.name = 'other-gateway';
    },
  ],
  [
    'archive derivation',
    (release) => {
      release.gateway.targets['linux/arm64'].executable.derivedFrom = 'other-gateway.tar.gz';
    },
  ],
  [
    'license source',
    (release) => {
      release.redistribution.license.sourcePath = 'OTHER-LICENSE';
    },
  ],
  [
    'notices source',
    (release) => {
      release.redistribution.notices.sourcePath = 'OTHER-NOTICES';
    },
  ],
]) {
  test(`OpenShell release parser rejects substituted ${field}`, () => {
    const release = makeOpenShellRelease();
    assert.deepEqual(parseOpenShellRelease(JSON.stringify(release)), release);
    mutate(release);

    assert.throws(() => parseOpenShellRelease(JSON.stringify(release)), {
      name: 'Error',
      message: 'OpenShell release metadata is invalid.',
    });
  });
}

test('release preflight requires one coherent capability host profile', () => {
  const missing = makeReleaseFixture({ omitHostManifest: true });
  const wrongDockerPath = makeReleaseFixture({ hostDockerPath: '/usr/local/bin/docker' });

  assert.throws(
    () => validateReleasePreflight({ repoRoot: missing, tag: 'v0.1.0-rc.1' }),
    /apps\/nanohost\/deploy\/host-manifest\.json/
  );
  assert.throws(
    () => validateReleasePreflight({ repoRoot: wrongDockerPath, tag: 'v0.1.0-rc.1' }),
    /host profile|\/usr\/bin\/docker/i
  );
});

test('release preflight rejects deployment workers without runtimes', () => {
  const repoRoot = makeReleaseFixture({ omitWorkerRuntimes: true });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /Worker image worker-runtimes is missing runtimes/
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
    /Worker image worker-runtimes is missing workerContract/
  );
});

test('release preflight rejects malformed worker runtime sets', () => {
  const repoRoot = makeReleaseFixture({ workerRuntimes: [] });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseImageDigests: true,
        tag: 'v0.0.1',
      }),
    /runtimes must be a non-empty array/
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
    /Worker image worker-runtimes is missing target/
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
 * @param {boolean} [options.omitSkillManifest] Whether to omit the public Skill manifest.
 * @param {boolean} [options.omitOpsSkillManifest] Whether to omit the operations Skill manifest.
 * @param {boolean} [options.omitWorkerContract] Whether to omit the deployment workerContract.
 * @param {boolean} [options.omitWorkerRuntimes] Whether to omit the deployment worker runtime.
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
 * @param {unknown} [options.workerRuntimes] Worker runtime fixture value.
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
  mkdirSync(join(root, 'skills', 'openkit-ops', 'scripts'), { recursive: true });
  if (!options.omitOpsSkillManifest) {
    writeFileSync(join(root, 'skills', 'openkit-ops', 'SKILL.md'), '# Fixture operations Skill\n');
  }
  if (!options.omitCli) {
    const cliPath = join(root, 'skills', 'openkit-ops', 'scripts', 'openkit');
    writeFileSync(cliPath, '#!/usr/bin/env node\n');
    chmodSync(cliPath, 0o755);
  }

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
    const profile = JSON.parse(
      readFileSync(join(process.cwd(), 'apps/nanohost/deploy/host-manifest.json'), 'utf8')
    );
    if (options.hostDockerPath)
      profile.requirements.find((entry) => entry.id === 'docker-version').predicate.path =
        options.hostDockerPath;
    writeJson(join(root, 'apps/nanohost/deploy/host-manifest.json'), profile);
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

  for (const image of ['app', 'worker-runtimes']) {
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
        id: 'worker-runtimes',
        repository: 'openkit-worker-runtimes',
        dockerfile: 'containers/worker-runtimes/Dockerfile',
        context: '.',
        kind: 'worker',
        ...(options.omitWorkerRuntimes
          ? {}
          : { runtimes: options.workerRuntimes ?? ['codex', 'pi', 'opencode', 'deepseek'] }),
        release: true,
        ...(options.leafAnonymousPull ? { anonymousPull: true } : {}),
        ...(options.omitWorkerContract
          ? {}
          : { workerContract: options.workerContract ?? 'openkit-worker-v1' }),
        baseImage: workerBaseImage,
        ...(options.omitWorkerTarget ? {} : { target: 'worker-runtimes' }),
        platforms: ['linux/amd64'],
        smoke: 'containers/worker-runtimes/smoke.sh',
        smokeCommand: 'openkit-worker-runtimes-smoke',
        localTag: 'openkit/worker-runtimes:dev',
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
    schemaVersion: 2,
    version,
    source: { commit },
    gateway: {
      targets: Object.fromEntries(
        ['amd64', 'arm64'].map((architecture) => {
          const target = `linux/${architecture}`;
          const name = `openshell-gateway-${architecture === 'amd64' ? 'x86_64' : 'aarch64'}-unknown-linux-gnu.tar.gz`;
          return [
            target,
            {
              archive: {
                name:
                  architecture === 'arm64' ? (options.nanoHostGatewayArchiveName ?? name) : name,
                target:
                  architecture === 'arm64' ? (options.nanoHostGatewayTarget ?? target) : target,
                sha256: checksum,
              },
              executable: { name: 'openshell-gateway', derivedFrom: name, sha256: checksum },
            },
          ];
        })
      ),
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

test('release preflight rejects empty, scalar, blank and duplicate declared runtime sets', () => {
  for (const runtimes of [[], 'codex', [''], ['codex', 'codex'], ['codex', 7]]) {
    const repoRoot = makeReleaseFixture({ workerRuntimes: runtimes });
    assert.throws(
      () => validateReleasePreflight({ repoRoot, tag: 'v0.0.1' }),
      /runtimes must be a non-empty array/
    );
  }
});

test('release preflight rejects retired leaf ids and singular runtime metadata', () => {
  for (const removed of ['worker-codex', 'worker-opencode', 'worker-pi', 'runtime']) {
    const repoRoot = makeReleaseFixture();
    const path = join(repoRoot, 'containers', 'images.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const deployment = manifest.images.find((image) => image.id === 'worker-runtimes');
    if (removed === 'runtime') deployment.runtime = 'codex';
    else {
      deployment.id = removed;
      deployment.target = removed;
    }
    writeJson(path, manifest);
    assert.throws(() => validateReleasePreflight({ repoRoot, tag: 'v0.0.1' }), /retired/);
  }
});

for (const target of ['linux/amd64', 'linux/arm64']) {
  test(`release preflight requires exact Gateway identities for ${target}`, () => {
    const repoRoot = makeReleaseFixture();
    assert.doesNotThrow(() => validateReleasePreflight({ repoRoot, tag: 'v0.1.0-rc.1' }));
    const path = join(repoRoot, 'apps/nanohost/openshell/release.json');
    const release = JSON.parse(readFileSync(path, 'utf8'));
    for (const mutate of [
      (pin) => {
        delete pin.gateway.targets[target];
      },
      (pin) => {
        pin.gateway.targets[target].archive.sha256 = 'COORDINATOR-PROBE-NEEDED';
      },
      (pin) => {
        pin.gateway.targets[target].executable.sha256 = 'COORDINATOR-PROBE-NEEDED';
      },
      (pin) => {
        pin.gateway.targets[target].archive.target = 'linux/other';
      },
    ]) {
      const invalid = structuredClone(release);
      mutate(invalid);
      writeJson(path, invalid);
      assert.throws(
        () => validateReleasePreflight({ repoRoot, tag: 'v0.1.0-rc.1' }),
        /OpenShell release/
      );
    }
  });
}
