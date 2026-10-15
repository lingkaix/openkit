import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitAt } from '../scripts/release-observe.mjs';
import {
  localDocker,
  localTarget,
  postPublicationSmoke,
  verifyLocalBinding,
  verifyLocalIdentity,
} from '../scripts/release-post-smoke.mjs';
import { canonical, sha } from '../scripts/release-safety.mjs';

const source = commitAt('HEAD');
const tag = 'v0.1.0-rc.99';
const repository = 'example/openkit';
const digest = `sha256:${'a'.repeat(64)}`;
const platformDigest = `sha256:${'b'.repeat(64)}`;
const imageId = `sha256:${'c'.repeat(64)}`;
const image = 'ghcr.io/example/openkit';
const labels = {
  'org.opencontainers.image.source': `https://github.com/${repository}`,
  'org.opencontainers.image.revision': source,
  'org.opencontainers.image.version': tag.slice(1),
};
const published = {
  id: 'app',
  prerelease: true,
  image,
  digest,
  platforms: [{ platform: 'linux/amd64', digest: platformDigest }],
  tags: [`${image}:${tag}`, `${image}:sha-${source.slice(0, 12)}`],
};
const identity = {
  repository,
  tag,
  source,
  published,
  local: { imageId, platform: 'linux/amd64', labels, repoDigests: [`${image}@${digest}`] },
  build: { releaseTag: tag, sourceCommit: source },
};

test('post-publication smoke refuses remote URLs and unbound or stopped containers', () => {
  assert.equal(localTarget('http://127.0.0.1:4321'), 'http://127.0.0.1:4321');
  for (const url of [
    'http://host.invalid',
    'http://localhost/path',
    'http://user:secret@localhost',
    'file:///tmp',
  ])
    assert.throws(() => localTarget(url));
  const state = {
    running: true,
    ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '4321' }] },
  };
  assert.doesNotThrow(() => verifyLocalBinding('http://127.0.0.1:4321', state));
  for (const bad of [
    { ...state, running: false },
    { ...state, ports: {} },
    { ...state, ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '9999' }] } },
  ])
    assert.throws(() => verifyLocalBinding('http://127.0.0.1:4321', bad));
  assert.throws(() => verifyLocalBinding('https://localhost:4321', state));
});

test('Docker observations reject remote hosts and contexts and pin a local socket without inherited overrides', () => {
  for (const host of ['ssh://host.invalid', 'tcp://127.0.0.1:2375', 'http://host.invalid', '']) {
    assert.throws(() => localDocker(() => host, { DOCKER_HOST: host }));
    assert.throws(() => localDocker(() => host, { DOCKER_CONTEXT: 'selected' }));
  }
  const calls = [];
  const docker = localDocker(
    (...call) => {
      calls.push(call);
      return '';
    },
    { DOCKER_HOST: 'unix:///run/fixture.sock', SENTINEL: 'retained' }
  );
  docker(['inspect', 'fixture']);
  assert.deepEqual(calls, [
    [
      'docker',
      ['--host', 'unix:///run/fixture.sock', 'inspect', 'fixture'],
      { env: { SENTINEL: 'retained' } },
    ],
  ]);
});

test('identity joins exact source, tag, index and selected platform without confusing image IDs', () => {
  assert.equal(verifyLocalIdentity(identity).platformDigest, platformDigest);
  for (const change of [
    { source: 'f'.repeat(40) },
    { tag: 'v0.1.0-rc.98' },
    { local: { ...identity.local, repoDigests: [] } },
    { local: { ...identity.local, labels: {} } },
    { published: { ...published, platforms: [] } },
    { build: { ...identity.build, sourceCommit: 'f'.repeat(40) } },
  ])
    assert.throws(() => verifyLocalIdentity({ ...identity, ...change }));
});

/** The stand-in driver observes only named public artifacts and selected Docker fields; it has no deployment authority. */
for (const outcome of [
  'passed',
  'publication',
  'mutating',
  'changed-read',
  'timeout',
  'malformed',
  'stopped',
  'docker-remote',
]) {
  test(`scripted smoke driver records ${outcome} without deployment effects or private transcripts`, () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-release-smoke-'));
    const output = join(root, 'proof');
    const calls = [];
    const retained = { count: 3 };
    const params = {
      repository,
      tag,
      sha: source,
      runId: 41,
      container: 'openkit',
      reads: [{ operation: 'catalog.list', input: {}, sha256: sha(canonical(retained)) }],
    };
    const run = (exe, args, options = {}) => {
      calls.push([exe, args]);
      if (exe === 'git') return `${source}\trefs/tags/${tag}`;
      if (exe === 'gh') {
        const dest = args[args.indexOf('--dir') + 1];
        mkdirSync(dest, { recursive: true });
        if (args[0] === 'release') {
          const name = `openkit-ops-skill-${tag}.tar.gz`;
          writeFileSync(join(dest, name), 'skill');
          writeFileSync(join(dest, 'SHA256SUMS'), `${sha('skill')}  ${name}\n`);
        } else writeFileSync(join(dest, 'app.json'), JSON.stringify(published));
        return '';
      }
      if (exe === 'docker') {
        if (args[0] === 'context')
          return outcome === 'docker-remote' ? 'ssh://host.invalid' : 'unix:///var/run/docker.sock';
        assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
        assert.equal(options.env.DOCKER_CONTEXT, undefined);
        assert.equal(options.env.DOCKER_HOST, undefined);
        const field = args[args.indexOf('--format') + 1];
        return {
          '{{.State.Running}}': outcome === 'stopped' ? 'false' : 'true',
          '{{json .NetworkSettings.Ports}}': JSON.stringify({
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '4321' }],
          }),
          '{{.Image}}': imageId,
          '{{.Os}}/{{.Architecture}}': 'linux/amd64',
          '{{json .Config.Labels}}': JSON.stringify(labels),
          '{{json .RepoDigests}}': JSON.stringify([`${image}@${digest}`]),
        }[field];
      }
      assert.equal(options.timeout, 30000);
      assert.equal(options.env.OPENKIT_NANOCORE_URL, 'http://127.0.0.1:4321');
      if (outcome === 'timeout') throw Error('injected timeout');
      if (outcome === 'malformed') return 'private malformed bytes';
      const operation = args[3];
      if (args[2] === 'describe')
        return JSON.stringify({ ok: true, data: { mutating: outcome === 'mutating' } });
      const data =
        operation === 'diagnostics.app'
          ? { build: identity.build }
          : outcome === 'changed-read'
            ? {}
            : retained;
      return JSON.stringify({ ok: true, operation, data });
    };
    try {
      const invoke = () =>
        postPublicationSmoke(
          { target: 'http://127.0.0.1:4321', params, output },
          {
            run,
            publication: () => {
              if (outcome === 'publication') throw Error('injected publication failure');
            },
            verifySkill: () => ({ cliPath: join(root, 'cli') }),
          }
        );
      if (outcome === 'passed') assert.equal(invoke().outcome, 'passed');
      else assert.throws(invoke, (error) => !error.message.includes('private malformed bytes'));
      const evidence = readFileSync(join(output, 'post-publication-smoke.json'), 'utf8');
      if (outcome === 'docker-remote') {
        assert.ok(
          !calls.some(
            ([exe, args]) =>
              exe === 'docker' && args.includes('inspect') && !args.includes('context')
          )
        );
        assert.ok(!calls.some(([exe]) => exe === process.execPath));
      }
      assert.equal(JSON.parse(evidence).outcome, outcome === 'passed' ? 'passed' : 'failed');
      assert.ok(!evidence.includes('private malformed bytes'));
      assert.ok(!evidence.includes('4321'));
      assert.ok(
        !calls.some(
          ([exe, args]) =>
            exe === 'docker' &&
            args.some((a) => ['run', 'stop', 'rm', 'restart', '{{json .Config.Env}}'].includes(a))
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('loopback bindings preserve address family and replace localhost with the concrete proved address', () => {
  const ipv4 = { running: true, ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '4321' }] } };
  assert.throws(() => verifyLocalBinding('http://[::1]:4321', ipv4));
  assert.equal(verifyLocalBinding('http://localhost:4321', ipv4), 'http://127.0.0.1:4321');
  const ipv6 = { running: true, ports: { '8080/tcp': [{ HostIp: '::', HostPort: '4321' }] } };
  assert.throws(() => verifyLocalBinding('http://127.0.0.1:4321', ipv6));
  assert.equal(verifyLocalBinding('http://localhost:4321', ipv6), 'http://[::1]:4321');
});
