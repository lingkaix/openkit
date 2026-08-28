import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateReleasePreflight } from '../scripts/release-preflight.mjs';

test('release preflight accepts matching package versions and digest-pinned release workers', () => {
  const repoRoot = makeReleaseFixture();

  const result = validateReleasePreflight({
    repoRoot,
    requireReleaseWorkerDigests: true,
    tag: 'v0.0.1',
  });

  assert.equal(result.version, '0.0.1');
  assert.deepEqual(result.releaseImages, ['app', 'worker-codex']);
});

test('release preflight accepts a structural release worker base with an empty declared runtime set', () => {
  const repoRoot = makeReleaseFixture({ includeReleaseWorkerBase: true });

  const result = validateReleasePreflight({
    repoRoot,
    requireReleaseWorkerDigests: true,
    tag: 'v0.0.1',
  });

  assert.equal(result.version, '0.0.1');
  assert.deepEqual(result.releaseImages, ['app', 'worker-base', 'worker-codex']);
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
        requireReleaseWorkerDigests: true,
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
        requireReleaseWorkerDigests: true,
        tag: 'v0.0.1',
      }),
    /empty declared|more than one|duplicate .*base/i
  );
});

test('release preflight rejects package versions that do not match the tag', () => {
  const repoRoot = makeReleaseFixture({ packageVersion: '0.0.2' });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseWorkerDigests: true,
        tag: 'v0.0.1',
      }),
    /Package version mismatch/
  );
});

test('release preflight ignores packages outside the release workspace roots', () => {
  const repoRoot = makeReleaseFixture();
  mkdirSync(join(repoRoot, 'ignored'), { recursive: true });
  writeJson(join(repoRoot, 'ignored', 'package.json'), {
    name: '@openkit/ignored-fixture',
    version: '9.9.9',
  });

  assert.doesNotThrow(() =>
    validateReleasePreflight({
      repoRoot,
      requireReleaseWorkerDigests: true,
      tag: 'v0.0.1',
    })
  );
});

test('release preflight rejects unpinned release worker base images', () => {
  const repoRoot = makeReleaseFixture({ workerBaseImage: 'node:24-bookworm-slim' });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseWorkerDigests: true,
        tag: 'v0.0.1',
      }),
    /must use a digest-pinned baseImage/
  );
});

test('release preflight rejects deployment workers without a runtime', () => {
  const repoRoot = makeReleaseFixture({ omitWorkerRuntime: true });

  assert.throws(
    () =>
      validateReleasePreflight({
        repoRoot,
        requireReleaseWorkerDigests: true,
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
        requireReleaseWorkerDigests: true,
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
        requireReleaseWorkerDigests: true,
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
        requireReleaseWorkerDigests: true,
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
        requireReleaseWorkerDigests: true,
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
 * @param {boolean} [options.includeReleaseWorkerBase] Whether to add one structural worker base with an empty declared runtime set.
 * @param {boolean} [options.includeSecondReleaseWorkerBase] Whether to add a second structural empty-declared-set worker base.
 * @param {string} [options.packageVersion] Version written into the workspace package.
 * @param {boolean} [options.omitWorkerContract] Whether to omit the deployment workerContract.
 * @param {boolean} [options.omitWorkerRuntime] Whether to omit the deployment worker runtime.
 * @param {boolean} [options.omitWorkerTarget] Whether to omit the worker Docker target.
 * @param {string} [options.workerBaseImage] Worker base image manifest value.
 * @param {unknown} [options.workerContract] Worker contract fixture value.
 * @param {unknown} [options.workerRuntime] Worker runtime fixture value.
 * @returns {string} Temporary repository root.
 */
function makeReleaseFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-release-preflight-'));
  const version = '0.0.1';
  const packageVersion = options.packageVersion ?? version;
  const workerBaseImage = options.workerBaseImage ?? 'node:24-bookworm-slim@sha256:abc123';
  const includeReleaseWorkerBase = options.includeReleaseWorkerBase === true;
  const includeSecondReleaseWorkerBase = options.includeSecondReleaseWorkerBase === true;

  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    private: true,
    version,
  });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");

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
        platforms: ['linux/amd64'],
        smoke: 'containers/app/smoke.sh',
        smokeCommand: 'openkit-app-smoke',
        localTag: 'openkit/app:dev',
      },
      ...(includeReleaseWorkerBase
        ? [
            makeReleaseWorkerBaseEntry({
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

/**
 * Builds one structural empty-declared-set release worker catalog entry that is not identified by a reserved id.
 *
 * @param {object} options Entry fields.
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
    ...(options.hasWorkerContract ? { workerContract: 'openkit-worker-v1' } : {}),
    baseImage: 'node:24-bookworm-slim@sha256:abc123',
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
