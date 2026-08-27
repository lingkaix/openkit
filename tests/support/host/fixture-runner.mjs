import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(hostRoot, '../../..');

/** Frozen Node source used by the host provisioning fixtures. */
export const expectedNodeSource = {
  digest: '6bf69d0eda41a12030d5f28d958cd09ce323bc0c13f1ab4d8bb426933aa08812',
  relativePath: '.local/share/mise/installs/node/24.18.0/bin/node',
  version: 'v24.18.0',
};

/**
 * Runs one host command through its bounded fixture surface.
 *
 * @param {string} scriptName Host script filename.
 * @param {string} fixtureRoot Disposable fixture root.
 * @param {NodeJS.ProcessEnv} [extraEnv] Additional fixture environment values.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Completed command result.
 */
export function runHostScript(scriptName, fixtureRoot, extraEnv = {}) {
  return spawnSync('bash', [join(hostRoot, scriptName), 'fixture'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENKIT_HOST_FIXTURE_ROOT: fixtureRoot,
      OPENKIT_HOST_MANIFEST: join(fixtureRoot, 'manifest.json'),
      OPENKIT_HOST_FIXTURE_NODE_SOURCE_SHA256: expectedNodeSource.digest,
      OPENKIT_HOST_FIXTURE_NODE_SOURCE_VERSION: expectedNodeSource.version,
      ...extraEnv,
    },
  });
}

/**
 * Requires one successful fixture command and returns its trimmed stdout.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result Completed command result.
 * @param {string} label Failure label.
 * @returns {string} Trimmed standard output.
 */
export function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}
