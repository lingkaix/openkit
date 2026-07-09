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

/**
 * Creates a small release-shaped repository fixture.
 *
 * @param {object} [options] Fixture options.
 * @param {string} [options.packageVersion] Version written into the workspace package.
 * @param {string} [options.workerBaseImage] Worker base image manifest value.
 * @returns {string} Temporary repository root.
 */
function makeReleaseFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-release-preflight-'));
  const version = '0.0.1';
  const packageVersion = options.packageVersion ?? version;
  const workerBaseImage = options.workerBaseImage ?? 'node:24-bookworm-slim@sha256:abc123';

  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    private: true,
    version,
  });
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'mcp'\n  - 'packages/*'\n"
  );

  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  writeJson(join(root, 'apps', 'web', 'package.json'), {
    name: '@openkit/web',
    version: packageVersion,
  });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeJson(join(root, 'mcp', 'package.json'), {
    name: '@openkit/mcp',
    version,
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
      {
        id: 'worker-codex',
        repository: 'openkit-worker-codex',
        dockerfile: 'containers/worker-codex/Dockerfile',
        context: '.',
        kind: 'worker',
        runtime: 'codex',
        release: true,
        workerContract: 'openkit-worker-v1',
        baseImage: workerBaseImage,
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
 * Writes JSON with stable formatting.
 *
 * @param {string} path Target path.
 * @param {unknown} value JSON value.
 */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
