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
  hostCheckEvidence,
  requireSuccess,
  runHostScript,
  writeHostProfileFixture,
} from './support/host/fixture-runner.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostSupportRoot = join(repoRoot, 'tests/support/host');
const manifestPath = join(repoRoot, 'apps/nanohost/deploy/host-manifest.json');
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

test('the host profile has the finite schema-2 capability set without machine pins', () => {
  const profile = JSON.parse(readFileSync(manifestPath));
  assert.equal(profile.schemaVersion, 2);
  assert.deepEqual(profile.architectures, ['amd64', 'arm64']);
  assert.deepEqual(
    profile.requirements.map((entry) => entry.id),
    [
      'platform',
      'systemd',
      'service-principal',
      'cgroup-v2',
      'namespaces',
      'seccomp',
      'containerd',
      'dockerd',
      'docker',
      'git',
      'slirp4netns',
      'docker-version',
      'git-version',
      'resolver',
      'libc',
      'ancestors',
    ]
  );
  assert.equal(profile.commands, undefined);
  assert.equal(profile.kernelRelease, undefined);
  assert.equal(profile.recommendation.scope, 'combined-small-deployment');
});

test('fixture provisioning stays idempotent and assertion shares the bundled capability comparator', () => {
  const bytes = readFileSync(manifestPath);
  const root = mkdtempSync(join(tmpdir(), 'openkit-host-profile-'));
  try {
    writeFileSync(join(root, 'manifest.json'), bytes);
    writeNodeSource(root);
    requireSuccess(runHostScript('provision.sh', root), 'first provision');
    const provisioned = treeDigest(root);
    requireSuccess(runHostScript('provision.sh', root), 'second provision');
    assert.equal(treeDigest(root), provisioned);
    const observations = writeHostProfileFixture(root, bytes);
    const observer = writeObservationStub(root, observations);
    const before = treeDigest(root);
    const result = runHostScript('assert.sh', root, { OPENKIT_HOST_FIXTURE_OBSERVER: observer });
    requireSuccess(result, 'matching capability fixture');
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.hardVerdict, 'requirements-met');
    assert.equal(evidence.profileDigest, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.stdout, `${JSON.stringify(evidence)}\n`);
    assert.equal(treeDigest(root), before, 'assertion wrote into fixture root');
    observations.requirements['docker-version'].version = 'Docker version 27.9.0, build abc1234';
    writeObservationStub(root, observations);
    const mismatch = runHostScript('assert.sh', root, { OPENKIT_HOST_FIXTURE_OBSERVER: observer });
    assert.notEqual(mismatch.status, 0);
    assert.equal(JSON.parse(mismatch.stdout).hardVerdict, 'requirements-unmet');
    observations.requirements['docker-version'].version = 'malformed version';
    writeObservationStub(root, observations);
    const unavailable = runHostScript('assert.sh', root, {
      OPENKIT_HOST_FIXTURE_OBSERVER: observer,
    });
    assert.notEqual(unavailable.status, 0);
    assert.equal(JSON.parse(unavailable.stdout).hardVerdict, 'cannot-check');
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  const evidence = hostCheckEvidence(readFileSync(manifestPath));
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
                OPENKIT_HOST_BUNDLE: '/opt/openkit/candidate',
                OPENKIT_SSH_CONTACT_LOG: contactPath,
                OPENKIT_SSH_STDOUT: evidence,
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
              OPENKIT_HOST_BUNDLE: '/opt/openkit/candidate',
              OPENKIT_SSH_CONTACT_LOG: contactPath,
              OPENKIT_SSH_STDOUT: evidence,
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
    'missing promoted product artifact apps/nanohost/deploy/host-manifest.json'
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

test('streamed remote assertion invokes only the selected bundled checker', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-host-assert-stream-'));
  try {
    writeFileSync(
      join(root, 'install.sh'),
      `#!/bin/sh\n[ "$1" = --check-host ] || exit 93\nprintf 'selected-bundle-checker\\n'\n`
    );
    const result = spawnSync('bash', ['-s', '--', 'remote', root], {
      cwd: root,
      encoding: 'utf8',
      input: readFileSync(join(hostSupportRoot, 'assert.sh')),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'selected-bundle-checker\n');
    assert.doesNotMatch(result.stderr, /ssh-alias\.sh|BASH_SOURCE/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
