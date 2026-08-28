import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectReleaseImageState, resolveImageDigest } from '../scripts/release-image-state.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

test('registry inspection treats only a recognized missing manifest as absent', () => {
  assert.equal(
    resolveImageDigest('ghcr.io/openkit/missing:v1', () => ({
      status: 1,
      stderr: 'ERROR: ghcr.io/openkit/missing:v1: not found',
      stdout: '',
    })),
    ''
  );
  assert.throws(
    () =>
      resolveImageDigest('ghcr.io/openkit/private:v1', () => ({
        status: 1,
        stderr: 'unauthorized: authentication required',
        stdout: '',
      })),
    /Unable to inspect.*unauthorized/
  );
  assert.throws(
    () =>
      resolveImageDigest('ghcr.io/openkit/app:v1', () => ({
        status: 1,
        stderr: 'dial tcp: lookup ghcr.io: no such host',
        stdout: '',
      })),
    /Unable to inspect.*no such host/
  );
});

test('registry inspection rejects malformed successful output', () => {
  assert.throws(
    () =>
      resolveImageDigest('ghcr.io/openkit/app:v1', () => ({
        status: 0,
        stderr: '',
        stdout: 'not-a-digest',
      })),
    /invalid digest/
  );
});

test('release image state admits a completely absent identity', () => {
  assert.deepEqual(
    inspectReleaseImageState({
      latestTag: 'latest',
      resolveDigest: () => '',
      shaTag: 'sha',
      versionTag: 'version',
      versionWithoutVTag: 'plain-version',
    }),
    { present: false, digest: '', latestBefore: '' }
  );
});

test('release image state reuses three matching immutable tags', () => {
  assert.deepEqual(
    inspectReleaseImageState({
      latestTag: 'latest',
      resolveDigest: (reference) => (reference === 'latest' ? '' : digest),
      shaTag: 'sha',
      versionTag: 'version',
      versionWithoutVTag: 'plain-version',
    }),
    { present: true, digest, latestBefore: '' }
  );
});

test('release image state rejects a partial identity and a reused source commit', () => {
  assert.throws(
    () =>
      inspectReleaseImageState({
        latestTag: 'latest',
        resolveDigest: (reference) => (reference === 'sha' ? digest : ''),
        shaTag: 'sha',
        versionTag: 'version',
        versionWithoutVTag: 'plain-version',
      }),
    /partial or conflicting.*commit without an existing source-revision tag/
  );
});
