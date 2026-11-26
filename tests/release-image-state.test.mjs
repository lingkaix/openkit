import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import { inspectReleaseImageState, resolveImageDigest } from '../scripts/release-image-state.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

test('anonymous Worker Common inspection preserves private-subject verification', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'openkit-anonymous-registry-test-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const config = join(fixture, 'authenticated');
  const probe = join(fixture, 'probe');
  mkdirSync(config);
  const access = join(config, 'private-subject-fixture');
  writeFileSync(access, '');

  writeFileSync(
    join(fixture, 'docker'),
    `#!/bin/sh
set -eu
if [ "$1" = logout ]; then
  rm "$DOCKER_CONFIG/private-subject-fixture"
  exit
fi
test "$1 $2 $3" = "buildx imagetools inspect"
test "$4" = "ghcr.io/notrucked/openkit-worker-common@${digest}"
test -d "$DOCKER_CONFIG"
test -z "$(ls -A "$DOCKER_CONFIG")"
printf '%s' "$DOCKER_CONFIG" > "$OPENKIT_TEST_PROBE"
printf '%s' '${digest}'
`,
    { mode: 0o700 }
  );
  writeFileSync(
    join(fixture, 'gh'),
    `#!/bin/sh
set -eu
test "$1 $2" = "attestation verify"
test "$3" = "oci://ghcr.io/notrucked/openkit-app@${digest}"
test -f "$DOCKER_CONFIG/private-subject-fixture"
`,
    { mode: 0o700 }
  );

  const imageState = new URL('../scripts/release-image-state.mjs', import.meta.url);
  const integrity = new URL('../scripts/verify-release-integrity.mjs', import.meta.url);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import assert from 'node:assert/strict';
       import { resolveAnonymousImageDigest } from ${JSON.stringify(imageState.href)};
       import { verifyCandidateSubjects } from ${JSON.stringify(integrity.href)};
       assert.equal(resolveAnonymousImageDigest('ghcr.io/notrucked/openkit-worker-common@${digest}'), '${digest}');
       assert.equal(verifyCandidateSubjects({
         subjects: '${digest.slice(7)}  ghcr.io/notrucked/openkit-app@${digest}',
         repository: 'notrucked/openkit',
         tag: 'v0.0.0',
         sha: '${'b'.repeat(40)}',
       }), 1);`,
      join(fixture, 'check.mjs'),
    ],
    {
      env: {
        PATH: `${fixture}${delimiter}${process.env.PATH}`,
        DOCKER_CONFIG: config,
        OPENKIT_TEST_PROBE: probe,
      },
    }
  );
  const anonymousConfig = readFileSync(probe, 'utf8');
  assert.notEqual(anonymousConfig, config);
  assert.equal(existsSync(anonymousConfig), false);
  assert.equal(existsSync(access), true);
});

test('registry inspection treats only a recognized missing manifest as absent', () => {
  const missingReference = 'ghcr.io/openkit/missing:v1';
  const missing = {
    status: 1,
    stderr: 'ERROR: ghcr.io/openkit/missing:v1: not found',
    stdout: '',
  };
  assert.equal(
    resolveImageDigest(missingReference, () => missing),
    ''
  );
  for (const interruption of [
    { status: null, signal: 'SIGTERM' },
    { status: 255, signal: null }, // Docker CLI reports a terminated Buildx plugin as exit 255.
  ]) {
    assert.throws(
      () => resolveImageDigest(missingReference, () => ({ ...missing, ...interruption })),
      /Unable to inspect.*not found/
    );
  }
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
