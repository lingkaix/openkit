// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  expectedNodeSource,
  requireSuccess,
  runHostScript,
} from './support/host/fixture-runner.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostSupportRoot = join(repoRoot, 'tests/support/host');
const manifestPath = join(repoRoot, 'tests/support/host/manifest.json');
const expectedManifest = {
  architecture: 'aarch64',
  cgroupMode: 'unified-v2',
  commands: {
    bash: {
      path: '/usr/bin/bash',
      version: 'GNU bash, version 5.2.21(1)-release (aarch64-unknown-linux-gnu)',
    },
    curl: {
      path: '/usr/bin/curl',
      version:
        'curl 8.5.0 (aarch64-unknown-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.10',
    },
    docker: { path: '/usr/bin/docker', version: 'Docker version 29.6.1, build 8900f1d' },
    node: { path: '/usr/bin/node', version: 'v24.18.0' },
    sha256sum: { path: '/usr/bin/sha256sum', version: 'sha256sum (GNU coreutils) 9.4' },
    slirp4netns: {
      path: '/usr/bin/slirp4netns',
      sha256: '4211dca7736aeb6fdd055350c8138d095d3dc5170f2ebf2a68fed5cdd4372f1c',
      version: 'slirp4netns version 1.2.1',
    },
    sudo: { path: '/usr/bin/sudo', version: 'Sudo version 1.9.15p5' },
    systemctl: { path: '/usr/bin/systemctl', version: 'systemd 255 (255.4-1ubuntu8.17)' },
    tar: { path: '/usr/bin/tar', version: 'tar (GNU tar) 1.35' },
    timeout: { path: '/usr/bin/timeout', version: 'timeout (GNU coreutils) 9.4' },
  },
  containerRuntime: 'docker',
  initSystem: 'systemd',
  kernelRelease: '6.17.0-1020-oracle',
  schemaVersion: 1,
};
const expectedManifestKeys = [
  'architecture',
  'cgroupMode',
  'commands',
  'containerRuntime',
  'initSystem',
  'kernelRelease',
  'schemaVersion',
];
const expectedCommandKeys = [
  'bash',
  'curl',
  'docker',
  'node',
  'sha256sum',
  'slirp4netns',
  'sudo',
  'systemctl',
  'tar',
  'timeout',
];

/** Returns one deterministic path-and-content digest for a fixture tree. */
function treeDigest(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else paths.push(path);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const localPath = relative(root, path);
    hash.update(localPath);
    hash.update('\0');
    if (lstatSync(path).isSymbolicLink()) hash.update(readlinkSync(path));
    else hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Creates the frozen pre-provision Node source in one fake host root. */
function writeNodeSource(fixtureRoot) {
  const sourcePath = join(fixtureRoot, 'home', expectedNodeSource.relativePath);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, '#!/bin/sh\nexit 0\n');
  chmodSync(sourcePath, 0o755);
  return sourcePath;
}

/** Writes one executable fixture observation without changing manifest bytes. */
function writeObservationStub(fixtureRoot, observations) {
  const observerPath = join(fixtureRoot, 'observe-host');
  const json = JSON.stringify(observations).replaceAll("'", "'\\''");
  writeFileSync(observerPath, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
  chmodSync(observerPath, 0o755);
  return observerPath;
}

/** Returns a value observably unequal to one admitted scalar. */
function mismatchedScalar(value) {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  return `${value}-mismatch`;
}

test('the host manifest has the exact finite vocabulary', () => {
  assert.ok(
    existsSync(manifestPath),
    'missing H1-A product artifact tests/support/host/manifest.json'
  );
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));

  assert.deepEqual(manifest, expectedManifest);
});

test('fixture provisions twice and the shared assertion rejects every observation mismatch', async (t) => {
  assert.ok(
    existsSync(manifestPath),
    'missing H1-A product artifact tests/support/host/manifest.json'
  );
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), expectedManifestKeys);
  assert.deepEqual(Object.keys(manifest.commands).sort(), expectedCommandKeys);

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-host-manifest-'));
  try {
    writeFileSync(join(fixtureRoot, 'manifest.json'), manifestBytes);
    const nodeSourcePath = writeNodeSource(fixtureRoot);
    requireSuccess(runHostScript('provision.sh', fixtureRoot), 'first provision failed');
    const nodeTargetPath = join(fixtureRoot, 'usr/bin/node');
    assert.equal(lstatSync(nodeTargetPath).isSymbolicLink(), true);
    assert.equal(resolve(dirname(nodeTargetPath), readlinkSync(nodeTargetPath)), nodeSourcePath);
    const firstState = treeDigest(fixtureRoot);
    requireSuccess(runHostScript('provision.sh', fixtureRoot), 'second provision failed');
    assert.equal(treeDigest(fixtureRoot), firstState, 'second provision changed fake-remote state');
    const observerPath = writeObservationStub(fixtureRoot, manifest);
    const matchingAssertion = runHostScript('assert.sh', fixtureRoot, {
      OPENKIT_HOST_FIXTURE_OBSERVER: observerPath,
    });
    assert.equal(
      matchingAssertion.status,
      0,
      `matching host assertion failed\nstdout:\n${matchingAssertion.stdout}\nstderr:\n${matchingAssertion.stderr}`
    );

    const scalarCases = expectedManifestKeys
      .filter((key) => key !== 'commands')
      .map((key) => ({ label: key, path: [key], value: mismatchedScalar(manifest[key]) }));
    const commandCases = expectedCommandKeys.flatMap((command) =>
      Object.keys(manifest.commands[command]).map((field) => ({
        label: `${command}.${field}`,
        path: ['commands', command, field],
        value: `${manifest.commands[command][field]}-mismatch`,
      }))
    );
    assert.equal(scalarCases.length, 6);
    assert.equal(commandCases.length, 21);
    for (const mismatch of [...scalarCases, ...commandCases]) {
      await t.test(mismatch.label, () => {
        const observations = structuredClone(manifest);
        if (mismatch.path.length === 1) observations[mismatch.path[0]] = mismatch.value;
        else observations[mismatch.path[0]][mismatch.path[1]][mismatch.path[2]] = mismatch.value;
        writeObservationStub(fixtureRoot, observations);
        const result = runHostScript('assert.sh', fixtureRoot, {
          OPENKIT_HOST_FIXTURE_OBSERVER: observerPath,
        });
        assert.notEqual(result.status, 0, `host assertion accepted ${mismatch.label} mismatch`);
      });
    }
    assert.deepEqual(readFileSync(join(fixtureRoot, 'manifest.json')), manifestBytes);
    const expectedDigest = createHash('sha256').update(manifestBytes).digest('hex');
    assert.equal(matchingAssertion.stdout, `manifestDigest=${expectedDigest}\n`);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('provision and assertion accept only the frozen SSH alias table', async (t) => {
  const acceptedAliases = ['a', 'a1', 'a-b', 'a'.repeat(63)];
  const rejectedAliases = [
    { args: [], label: 'absent' },
    { args: ['a', 'a1'], label: 'second argument' },
    { args: ['-x'], label: 'option' },
    { args: ['A'], label: 'uppercase' },
    { args: ['a_b'], label: 'underscore' },
    { args: ['a.b'], label: 'dot' },
    { args: ['1a'], label: 'leading digit' },
    { args: ['a'.repeat(64)], label: '64 characters' },
  ];
  const stubRoot = mkdtempSync(join(tmpdir(), 'openkit-host-ssh-'));
  const contactPath = join(stubRoot, 'contact');
  const sshPath = join(stubRoot, 'ssh');
  const manifestDigest = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  writeFileSync(
    sshPath,
    `#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r _; do :; done
printf '%s\\n' "\${1-}" >> "\${OPENKIT_SSH_CONTACT_LOG:?}"
printf '%s\\n' "\${OPENKIT_SSH_STDOUT-}"
`
  );
  chmodSync(sshPath, 0o755);

  try {
    for (const scriptName of ['provision.sh', 'assert.sh']) {
      for (const alias of acceptedAliases) {
        await t.test(
          `${scriptName} accepts ${alias.length === 63 ? '63 lowercase characters' : alias}`,
          () => {
            rmSync(contactPath, { force: true });
            const result = spawnSync('bash', [join(hostSupportRoot, scriptName), alias], {
              cwd: repoRoot,
              encoding: 'utf8',
              env: {
                ...process.env,
                OPENKIT_SSH_CONTACT_LOG: contactPath,
                OPENKIT_SSH_STDOUT: `manifestDigest=${manifestDigest}`,
                PATH: `${stubRoot}:${process.env.PATH}`,
              },
            });
            assert.equal(
              result.status,
              0,
              `${scriptName} rejected accepted alias ${alias}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
            );
            assert.deepEqual(readFileSync(contactPath, 'utf8').trim().split('\n'), [alias]);
          }
        );
      }
      for (const rejected of rejectedAliases) {
        await t.test(`${scriptName} rejects ${rejected.label}`, () => {
          rmSync(contactPath, { force: true });
          const result = spawnSync('bash', [join(hostSupportRoot, scriptName), ...rejected.args], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
              ...process.env,
              OPENKIT_SSH_CONTACT_LOG: contactPath,
              OPENKIT_SSH_STDOUT: `manifestDigest=${manifestDigest}`,
              PATH: `${stubRoot}:${process.env.PATH}`,
            },
          });
          assert.notEqual(result.status, 0, `${scriptName} accepted ${rejected.label}`);
          assert.equal(
            existsSync(contactPath),
            false,
            `${scriptName} contacted SSH for ${rejected.label}`
          );
        });
      }
    }
  } finally {
    rmSync(stubRoot, { force: true, recursive: true });
  }
});

test('Node provisioning fails closed on every frozen source and existing-target mismatch', async (t) => {
  assert.ok(
    existsSync(manifestPath),
    'missing H1-A product artifact tests/support/host/manifest.json'
  );
  const manifestBytes = readFileSync(manifestPath);
  const cases = [
    {
      env: { OPENKIT_HOST_FIXTURE_NODE_SOURCE_VERSION: 'v24.18.0-mismatch' },
      label: 'source version',
    },
    {
      env: {
        OPENKIT_HOST_FIXTURE_NODE_SOURCE_SHA256: `${expectedNodeSource.digest.slice(0, -1)}0`,
      },
      label: 'source SHA-256',
    },
    { label: 'source executable absent', removeSource: true },
    { label: 'existing non-matching target', writeTarget: true },
  ];

  for (const mismatch of cases) {
    await t.test(mismatch.label, () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-host-node-rule-'));
      try {
        writeFileSync(join(fixtureRoot, 'manifest.json'), manifestBytes);
        const sourcePath = writeNodeSource(fixtureRoot);
        if (mismatch.removeSource) rmSync(sourcePath);
        if (mismatch.writeTarget) {
          const targetPath = join(fixtureRoot, 'usr/bin/node');
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, 'do not replace\n');
        }
        const before = treeDigest(fixtureRoot);
        const result = runHostScript('provision.sh', fixtureRoot, mismatch.env);
        assert.notEqual(result.status, 0, `provision accepted ${mismatch.label} mismatch`);
        assert.equal(
          treeDigest(fixtureRoot),
          before,
          `provision mutated ${mismatch.label} fixture`
        );
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });
  }
});

test('streamed remote provisioning reaches the Node source fail-closed boundary', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'openkit-host-provision-stream-'));
  const isolatedCwd = join(runRoot, 'cwd');
  const emptyHome = join(runRoot, 'home');
  mkdirSync(isolatedCwd);
  mkdirSync(emptyHome);
  try {
    const result = spawnSync('bash', ['-s', '--', 'remote', join(runRoot, 'node'), 'v24.18.0'], {
      cwd: isolatedCwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: emptyHome },
      input: readFileSync(join(hostSupportRoot, 'provision.sh')),
    });
    assert.equal(result.status, 1, `unexpected streamed provision status: ${result.status}`);
    assert.match(result.stderr, /Node source is not executable\./u);
    assert.doesNotMatch(result.stderr, /ssh-alias\.sh|BASH_SOURCE/u);
  } finally {
    rmSync(runRoot, { force: true, recursive: true });
  }
});

test('streamed remote assertion reaches the host fact-collection command', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'openkit-host-assert-stream-'));
  const isolatedCwd = join(runRoot, 'cwd');
  const emptyHome = join(runRoot, 'home');
  mkdirSync(isolatedCwd);
  mkdirSync(emptyHome);
  try {
    const result = spawnSync('bash', ['-x', '-s', '--', 'remote', 'e30='], {
      cwd: isolatedCwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: emptyHome },
      input: readFileSync(join(hostSupportRoot, 'assert.sh')),
    });
    assert.match(
      result.stderr,
      /^\+\+ \/usr\/bin\/node -e /mu,
      `streamed assertion did not attempt host fact collection\nstderr:\n${result.stderr}`
    );
    assert.doesNotMatch(result.stderr, /ssh-alias\.sh|BASH_SOURCE/u);
  } finally {
    rmSync(runRoot, { force: true, recursive: true });
  }
});
