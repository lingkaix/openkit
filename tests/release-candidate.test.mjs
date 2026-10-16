// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  candidateReference,
  imageIdentity,
  selectTag,
  validateCandidate,
  verifyIndex,
} from '../scripts/release-candidate.mjs';
import { publicationInputsAt } from '../scripts/release-publication-check.mjs';

/** A complete digest-only candidate, observed in the exact workflow run that produced it. */
function fixture() {
  const context = {
    repository: 'example/openkit',
    sha: 'a'.repeat(40),
    tag: 'v0.1.0-rc.99',
    inputs: 'b'.repeat(64),
    proof: { runId: 41, attempt: 2, jobId: 900 },
    image: {
      id: 'app',
      repository: 'openkit-app',
      kind: 'app',
      platforms: ['linux/amd64', 'linux/arm64'],
    },
  };
  const record = {
    schemaVersion: 1,
    repository: context.repository,
    sha: context.sha,
    tag: context.tag,
    inputs: context.inputs,
    provenance: { runId: 41, attempt: 2 },
    id: 'app',
    image: 'ghcr.io/example/openkit-app',
    digest: `sha256:${'c'.repeat(64)}`,
    platforms: context.image.platforms.map((platform, index) => {
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      return {
        platform,
        digest,
        labels: {
          'org.opencontainers.image.source': 'https://github.com/example/openkit',
          'org.opencontainers.image.revision': context.sha,
          'org.opencontainers.image.version': context.tag.slice(1),
        },
        appIdentity: { releaseTag: context.tag, sourceCommit: context.sha },
        smoke: { sha: context.sha, digest, conclusion: 'success' },
      };
    }),
  };
  return { record, context };
}

test('a complete exact-P candidate preserves the index and every platform digest', () => {
  const { record, context } = fixture();
  assert.equal(validateCandidate(record, context), record);
});

test('the registry index must contain precisely the recorded platform digests', () => {
  const { record } = fixture();
  const index = {
    manifests: record.platforms.map((p) => ({
      digest: p.digest,
      platform: { os: 'linux', architecture: p.platform.split('/')[1] },
    })),
  };
  assert.doesNotThrow(() => verifyIndex(record, index));
  for (const manifests of [
    [],
    index.manifests.slice(1),
    [...index.manifests, index.manifests[0]],
    [{ ...index.manifests[0], digest: `sha256:${'d'.repeat(64)}` }, index.manifests[1]],
  ])
    assert.throws(() => verifyIndex(record, { manifests }), /Candidate refused:/);
});

test('candidate selection requires one committed unused prerelease input and tolerates ordinary main', () => {
  assert.equal(selectTag({ notes: ['v0.1.0-rc.6'], tags: ['v0.1.0-rc.6'] }), '');
  assert.equal(selectTag({ notes: ['v0.1.0-rc.8'], tags: [] }), 'v0.1.0-rc.8');
  assert.throws(() => selectTag({ notes: ['v0.1.0-rc.8', 'v0.1.0-rc.9'], tags: [] }));
  assert.throws(() =>
    selectTag({ explicit: 'v0.1.0-rc.6', notes: ['v0.1.0-rc.6'], tags: ['v0.1.0-rc.6'] })
  );
});

test('only App candidate builds carry the embedded identity and all OCI metadata is deterministic', () => {
  const { context } = fixture();
  const input = { ...context, created: '2026-10-15T00:00:00Z' };
  const app = imageIdentity(input);
  assert.equal(
    app.args,
    `OPENKIT_RELEASE_TAG=${context.tag}\nOPENKIT_SOURCE_COMMIT=${context.sha}`
  );
  assert.equal(imageIdentity({ ...input, image: { ...context.image, kind: 'worker' } }).args, '');
  assert.equal(app.labels, imageIdentity(input).labels);
  assert.match(app.labels, /org.opencontainers.image.created=2026-10-15T00:00:00Z/);
});

test('candidate-only references cannot select any public release tag or Latest pointer', () => {
  const reference = candidateReference({
    image: 'ghcr.io/example/openkit-app',
    sha: 'a'.repeat(40),
    runId: 41,
    attempt: 2,
  });
  assert.match(reference, /:candidate-[a-f0-9]{40}-41-2$/);
  assert.doesNotMatch(reference, /:(?:v\d|\d|sha-|latest)/);
  assert.throws(() =>
    candidateReference({
      image: 'ghcr.io/example/openkit-app:latest',
      sha: 'a'.repeat(40),
      runId: 41,
      attempt: 2,
    })
  );
});

test('a new Git commit with an identical tree invalidates the old platform records before index publication', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-candidate-new-p-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture',
  };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '--initial-branch=fixture');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'containers'));
  const image = fixture().context.image;
  writeFileSync(
    join(root, 'containers/images.json'),
    JSON.stringify({ images: [{ ...image, release: true }] })
  );
  writeFileSync(join(root, 'scripts/fixture.mjs'), 'export const fixture = true;\n');
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    'jobs:\n' +
      ['publish-container-images', 'github-release', 'verify-release']
        .map((n) => `  ${n}:\n    steps:\n      - run: node scripts/fixture.mjs\n`)
        .join('')
  );
  git('add', '.');
  git('commit', '-m', 'fixture source P');
  const oldP = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  git('commit', '--allow-empty', '-m', 'new P with identical product bytes');
  const newP = git('rev-parse', 'HEAD');
  assert.notEqual(oldP, newP);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
  const inputs = publicationInputsAt(root, newP).sha256;
  assert.equal(inputs, publicationInputsAt(root, oldP).sha256);
  const directory = join(root, 'observations');
  mkdirSync(directory);
  for (const p of fixture().record.platforms)
    writeFileSync(
      join(directory, `app-${p.platform.split('/')[1]}.json`),
      JSON.stringify({
        ...p,
        repository: 'example/openkit',
        sha: oldP,
        tag: 'v0.1.0-rc.99',
        inputs,
        id: 'app',
        provenance: { runId: 41, attempt: 2 },
      })
    );
  const log = join(root, 'calls.log');
  writeFileSync(
    join(root, 'docker'),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALLS, 'unexpected registry effect');\nprocess.exit(7);\n`,
    { mode: 0o755 }
  );
  const script = new URL('../scripts/release-candidate.mjs', import.meta.url).pathname;
  const result = spawnSync(
    process.execPath,
    [script, 'index', '--id', 'app', '--tag', 'v0.1.0-rc.99', '--directory', directory],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'example/openkit',
        GITHUB_SHA: newP,
        GITHUB_RUN_ID: '41',
        GITHUB_RUN_ATTEMPT: '2',
        CALLS: log,
      },
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform provenance/);
  assert.equal(existsSync(log), false);
});

for (const platform of ['linux/amd64', 'linux/arm64'])
  for (const fail of [false, 'base', 'derivation'])
    test(`actual candidate platform driver ${fail ? `refuses failed ${fail}` : 'records successful'} ${platform} digest smoke`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'openkit-candidate-driver-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const digest = `sha256:${'d'.repeat(64)}`;
      const log = join(directory, 'calls.log');
      const output = join(directory, 'observations');
      writeFileSync(
        join(directory, 'docker'),
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({args, platform:process.env.DOCKER_DEFAULT_PLATFORM, from:args[0]==='build'?fs.readFileSync(require('node:path').join(args.at(-1),'Dockerfile'),'utf8').split('\\n')[0]:undefined})+'\\n');
if (args[0] === 'run' && (process.env.FAIL_SMOKE === 'base' || (process.env.FAIL_SMOKE === 'derivation' && args.some(a=>a.startsWith('openkit/worker-common-derived-smoke:'))))) process.exit(42);
if (args[0] === 'image') console.log(JSON.stringify([{Config:{Labels:{
'org.opencontainers.image.source':'https://github.com/example/openkit',
'org.opencontainers.image.revision':process.env.GITHUB_SHA,
'org.opencontainers.image.version':'0.1.0-rc.99'}}}]));
`,
        { mode: 0o755 }
      );
      const result = spawnSync(
        process.execPath,
        [
          'scripts/release-candidate.mjs',
          'platform',
          '--id',
          'worker-common',
          '--tag',
          'v0.1.0-rc.99',
          '--platform',
          platform,
          '--digest',
          digest,
          '--directory',
          output,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'example/openkit',
            GITHUB_SHA: sha,
            GITHUB_RUN_ID: '41',
            GITHUB_RUN_ATTEMPT: '2',
            CALLS: log,
            FAIL_SMOKE: fail || '0',
          },
        }
      );
      assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
      assert.ok(
        existsSync(log),
        `Candidate driver must reach the smoke path: ${result.stdout}${result.stderr}`
      );
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const argv = calls.map((c) => c.args);
      assert.deepEqual(argv.filter((args) => args[0] === 'run')[0], [
        'run',
        '--rm',
        '--network=none',
        `ghcr.io/example/openkit-worker-common@${digest}`,
        'openkit-worker-common-base-smoke',
      ]);
      assert.equal(calls.find((c) => c.args[0] === 'run').platform, platform);
      if (fail !== 'base') {
        assert.equal(
          calls.find((c) => c.args[0] === 'build').from,
          `FROM ghcr.io/example/openkit-worker-common@${digest}`
        );
        assert.equal(argv.filter((args) => args[0] === 'run').length, 2);
        assert.ok(
          argv.filter((args) => args[0] === 'run').every((args) => args.includes('--network=none'))
        );
      }
      const file = join(output, `worker-common-${platform.split('/')[1]}.json`);
      assert.equal(existsSync(file), !fail);
      if (!fail)
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).smoke, {
          sha,
          digest,
          conclusion: 'success',
        });
      assert.ok(
        !argv.some((args) => args.includes('create') || args.includes('--tag')),
        'a platform build/smoke cannot promote tags'
      );
    });

for (const [name, mutate] of [
  [
    'wrong repository',
    (r) => {
      r.repository = 'foreign/openkit';
    },
  ],
  [
    'wrong image coordinate',
    (r) => {
      r.image = 'ghcr.io/foreign/openkit-app';
    },
  ],
  [
    'wrong OCI source',
    (r) => {
      r.platforms[0].labels['org.opencontainers.image.source'] =
        'https://github.com/foreign/openkit';
    },
  ],
  [
    'wrong revision',
    (r) => {
      r.platforms[0].labels['org.opencontainers.image.revision'] = 'd'.repeat(40);
    },
  ],
  [
    'changed P even when publication inputs and tree are unchanged',
    (_r, c) => {
      c.sha = 'd'.repeat(40);
    },
  ],
  [
    'wrong intended tag',
    (r) => {
      r.tag = 'v0.1.0-rc.100';
    },
  ],
  [
    'wrong run',
    (r) => {
      r.provenance.runId++;
    },
  ],
  [
    'stale attempt',
    (r) => {
      r.provenance.attempt--;
    },
  ],
  [
    'missing observed job proof',
    (_r, c) => {
      c.proof = null;
    },
  ],
  [
    'changed unproved inputs',
    (r) => {
      r.inputs = 'd'.repeat(64);
    },
  ],
  [
    'missing platform',
    (r) => {
      r.platforms.pop();
    },
  ],
  [
    'duplicate platform',
    (r) => {
      r.platforms[1] = structuredClone(r.platforms[0]);
    },
  ],
  [
    'extra platform',
    (r) => {
      r.platforms.push(structuredClone(r.platforms[0]));
    },
  ],
  [
    'missing digest',
    (r) => {
      delete r.platforms[0].digest;
    },
  ],
  [
    'mismatched smoke digest',
    (r) => {
      r.platforms[0].smoke.digest = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'missing App identity',
    (r) => {
      delete r.platforms[0].appIdentity;
    },
  ],
  [
    'wrong App source',
    (r) => {
      r.platforms[0].appIdentity.sourceCommit = 'd'.repeat(40);
    },
  ],
  [
    'wrong App tag',
    (r) => {
      r.platforms[0].appIdentity.releaseTag = 'v0.1.0-rc.100';
    },
  ],
  [
    'missing smoke',
    (r) => {
      delete r.platforms[0].smoke;
    },
  ],
  [
    'failed smoke',
    (r) => {
      r.platforms[0].smoke.conclusion = 'failure';
    },
  ],
  [
    'smoke on another P',
    (r) => {
      r.platforms[0].smoke.sha = 'd'.repeat(40);
    },
  ],
  [
    'malformed index digest',
    (r) => {
      r.digest = 'candidate';
    },
  ],
])
  test(`candidate refuses ${name} before promotion`, () => {
    const { record, context } = fixture();
    mutate(record, context);
    assert.throws(() => validateCandidate(record, context), /Candidate refused:/);
  });
