// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitAt } from '../scripts/release-observe.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(repoRoot, 'containers/images.json'), 'utf8'));
const identityImageIds = ['app', 'worker-common', 'worker-runtimes'];

/** Runs a real bounded process; the Docker executable alone is a recorder. */
function run(executable, args, cwd, env) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Snapshots the actual helper and its file inputs into a real, isolated committed context. */
function fixture(t) {
  const pinnedNode = readFileSync(join(repoRoot, '.node-version'), 'utf8').trim();
  assert.equal(process.versions.node, pinnedNode, 'run with the repository-pinned Node');
  const root = mkdtempSync(join(tmpdir(), 'openkit-docker-build-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const log = join(root, 'docker-argv.jsonl');
  mkdirSync(repo);
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.OPENKIT_TEST_DOCKER_ARGV, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
    { mode: 0o755 }
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    OPENKIT_TEST_DOCKER_ARGV: log,
    OPENKIT_SOURCE_COMMIT: '',
    OPENKIT_RELEASE_TAG: '',
  });
  const testImage = catalog.images.find((image) => image.id === 'test-env');
  assert.ok(testImage);
  const inputs = new Set([
    'scripts/docker/build-image.sh',
    'scripts/docker/test-image-tag.mjs',
    'containers/images.json',
    ...catalog.images.map((image) => image.dockerfile),
    testImage.smoke,
    'apps/web/package.json',
    'containers/test-env/browser-tools/package.json',
    'containers/test-env/browser-tools/package-lock.json',
    'scripts/install-security-tools.mjs',
    'scripts/security-tools.json',
    'scripts/retrieval-dictionary.py',
    'packages/retrieval-kernel/vendor/mecab-ipadic-2.7.0-20250920.tar.gz',
    'packages/retrieval-kernel/vendor/IPADIC-COPYING',
  ]);
  for (const relativePath of inputs) {
    const destination = join(repo, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repoRoot, relativePath), destination);
  }
  const git = (...args) => run('git', args, repo, env);
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Local build identity fixture',
    '-c',
    'user.email=identity-fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'Snapshot the actual local build helper inputs'
  );
  assert.equal(git('status', '--porcelain'), '');
  // The canonical source observer resolves an actual commit object, never a tag/digest surrogate.
  const sourceCommit = commitAt('HEAD', { cwd: repo });
  assert.equal(sourceCommit, git('rev-parse', 'HEAD'));
  return { repo, env, log, git, sourceCommit };
}

/** Invokes the unchanged shell entrypoint and observes its one external Docker argv. */
function build(f, imageId, { tag, sourceCommit = '', releaseTag = '' } = {}) {
  writeFileSync(f.log, '');
  run(
    'bash',
    [join(f.repo, 'scripts/docker/build-image.sh'), imageId, ...(tag ? [tag] : [])],
    f.repo,
    { ...f.env, OPENKIT_SOURCE_COMMIT: sourceCommit, OPENKIT_RELEASE_TAG: releaseTag }
  );
  const calls = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 1, 'one helper invocation must submit one build');
  assert.equal(calls[0][0], 'build');
  return calls[0];
}

/** Reads one Docker option without constraining unrelated flag ordering. */
function optionValues(argv, option) {
  return argv.flatMap((value, index) => {
    if (value === option) return [argv[index + 1]];
    return value.startsWith(`${option}=`) ? [value.slice(option.length + 1)] : [];
  });
}

/** Catalog paths and image tags are independent from source-identity assertions. */
function assertImageSelection(argv, image, tag = image.localTag) {
  assert.deepEqual(optionValues(argv, '-f'), [image.dockerfile]);
  assert.deepEqual(optionValues(argv, '-t'), [tag]);
  assert.deepEqual(optionValues(argv, '--target'), image.target ? [image.target] : []);
  assert.equal(argv.at(-1), image.context);
}

/** Image-identity transport owns two distinct build arguments, not an image-name convention. */
function assertIdentity(argv, sourceCommit, releaseTag) {
  const args = optionValues(argv, '--build-arg');
  for (const [key, expected] of [
    ['OPENKIT_SOURCE_COMMIT', sourceCommit],
    ['OPENKIT_RELEASE_TAG', releaseTag],
  ]) {
    const supplied = args.filter((value) => value.startsWith(`${key}=`));
    if (expected === '') {
      // Omission and an empty Docker ARG both preserve unknown/untagged identity.
      assert.ok(supplied.length <= 1, `${key} must not be supplied twice`);
      if (supplied.length === 1) assert.equal(supplied[0], `${key}=`);
    } else assert.deepEqual(supplied, [`${key}=${expected}`]);
  }
}

test('local image builds forward real Git or explicit candidate identity without changing test-env', async (t) => {
  const f = fixture(t);
  // Worker image owner: 20260721-worker_execution_environment_images.md, immutable build identity.
  for (const imageId of identityImageIds) {
    await t.test(`${imageId}: clean local source is known and untagged`, () => {
      assert.equal(f.git('status', '--porcelain'), '');
      const image = catalog.images.find((entry) => entry.id === imageId);
      assert.ok(image);
      const argv = build(f, imageId);
      assertImageSelection(argv, image);
      assertIdentity(argv, f.sourceCommit, '');
      assert.equal(f.git('status', '--porcelain'), '');
    });
  }
  writeFileSync(join(f.repo, 'uncommitted-source.txt'), 'Not part of the committed context.\n');
  assert.notEqual(f.git('status', '--porcelain'), '');
  assert.equal(commitAt('HEAD', { cwd: f.repo }), f.sourceCommit);
  for (const imageId of identityImageIds) {
    await t.test(`${imageId}: dirty source is not inferred from an image tag`, () => {
      const image = catalog.images.find((entry) => entry.id === imageId);
      assert.ok(image);
      const tag = `openkit/identity-regression:${f.sourceCommit}`;
      const argv = build(f, imageId, { tag });
      assertImageSelection(argv, image, tag);
      assertIdentity(argv, '', '');
    });
    await t.test(`${imageId}: explicit candidate inputs are forwarded unchanged`, () => {
      const image = catalog.images.find((entry) => entry.id === imageId);
      assert.ok(image);
      const releaseTag = 'v0.0.0-rc.1';
      const argv = build(f, imageId, { sourceCommit: f.sourceCommit, releaseTag });
      assertImageSelection(argv, image);
      assertIdentity(argv, f.sourceCommit, releaseTag);
    });
  }
  await t.test('test-env keeps only its canonical content-addressed build input', () => {
    const image = catalog.images.find((entry) => entry.id === 'test-env');
    assert.ok(image);
    const digest = run(
      process.execPath,
      [join(f.repo, 'scripts/docker/test-image-tag.mjs'), '--digest'],
      f.repo,
      f.env
    );
    const argv = build(f, 'test-env', { sourceCommit: f.sourceCommit, releaseTag: 'v0.0.0-rc.1' });
    assertImageSelection(argv, image);
    assert.deepEqual(optionValues(argv, '--build-arg'), [
      `OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST=${digest}`,
    ]);
  });
});
