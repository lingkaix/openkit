// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  checkPublication as actualCheck,
  publicationInputsAt,
} from '../scripts/release-publication-check.mjs';

/** Actual local Git objects let false, missing and changed byte claims fail independently of fixtures. */
function repository({ moved = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-publication-git-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Lingkai.Xu',
    GIT_AUTHOR_EMAIL: '3234555+lingkaix@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Lingkai.Xu',
    GIT_COMMITTER_EMAIL: '3234555+lingkaix@users.noreply.github.com',
  };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '--initial-branch=main');
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(
    path.join(root, '.github/workflows/ci.yml'),
    'jobs:\n' +
      [
        'publish-container-images',
        'github-release',
        'verify-release',
        ...(moved
          ? ['candidate-plan', 'candidate-images', 'candidate-index', 'container-image-matrix']
          : []),
      ]
        .map((n) => `  ${n}:\n    steps:\n      - run: node scripts/release-notes.mjs\n`)
        .join('')
  );
  writeFileSync(
    path.join(root, 'scripts/release-notes.mjs'),
    "import './publication-helper.mjs';\n"
  );
  writeFileSync(path.join(root, 'scripts/publication-helper.mjs'), 'export const fixture = 1;\n');
  if (moved) {
    mkdirSync(path.join(root, 'containers/fixture'), { recursive: true });
    writeFileSync(
      path.join(root, 'containers/images.json'),
      JSON.stringify({
        images: [
          {
            id: 'fixture',
            release: true,
            dockerfile: 'containers/fixture/Dockerfile',
            smoke: 'containers/fixture/smoke.sh',
          },
        ],
      })
    );
    writeFileSync(path.join(root, 'containers/fixture/Dockerfile'), 'FROM scratch\n');
    writeFileSync(path.join(root, 'containers/fixture/smoke.sh'), 'exit 0\n');
    writeFileSync(path.join(root, '.dockerignore'), 'temp\n');
    writeFileSync(path.join(root, 'Caddyfile'), ':80\n');
    writeFileSync(path.join(root, 'scripts/retrieval-fixture.sh'), 'exit 0\n');
    mkdirSync(path.join(root, 'scripts/docker'));
    writeFileSync(
      path.join(root, 'scripts/publication-helper.mjs'),
      "export const smoke = 'scripts/docker/smoke-image.sh';\n"
    );
    writeFileSync(path.join(root, 'scripts/docker/smoke-image.sh'), 'exit 0\n');
  }
  git('add', '.');
  git('commit', '-m', 'synthetic proved baseline');
  const baseline = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'README.md'), 'Unrelated reviewed change.\n');
  git('add', '.');
  git('commit', '-m', 'synthetic candidate');
  const head = git('rev-parse', 'HEAD');
  return { root, baseline, head, git };
}

test('publication proof includes every moved job and image-construction input', () => {
  const r = repository({ moved: true });
  const proof = publicationInputsAt(r.root, r.head);
  for (const name of [
    'candidate-plan',
    'candidate-images',
    'candidate-index',
    'container-image-matrix',
  ])
    assert.ok(proof.jobs[name]);
  for (const file of [
    'containers/images.json',
    'containers/fixture/Dockerfile',
    'containers/fixture/smoke.sh',
    '.dockerignore',
    'Caddyfile',
    'scripts/retrieval-fixture.sh',
    'scripts/docker/smoke-image.sh',
  ])
    assert.ok(proof.files[file]);
  assert.deepEqual(proof.candidateImageIds, ['fixture']);
  for (const file of [
    'Caddyfile',
    'scripts/docker/smoke-image.sh',
    'containers/fixture/smoke.sh',
    'scripts/retrieval-fixture.sh',
    '.github/workflows/ci.yml',
  ]) {
    writeFileSync(
      path.join(r.root, file),
      `${r.git('show', `${r.head}:${file}`)}\n# changed construction input\n`
    );
    r.git('add', file);
    r.git('commit', '-m', 'change candidate construction');
    assert.notEqual(publicationInputsAt(r.root, r.git('rev-parse', 'HEAD')).sha256, proof.sha256);
  }
});

test('changing the candidate matrix producer invalidates publication proof', () => {
  const r = repository({ moved: true });
  const before = publicationInputsAt(r.root, r.head);
  const workflow = r.git('show', `${r.head}:.github/workflows/ci.yml`);
  writeFileSync(
    path.join(r.root, '.github/workflows/ci.yml'),
    workflow.replace(
      '  container-image-matrix:\n',
      '  container-image-matrix:\n    name: changed matrix\n'
    )
  );
  r.git('add', '.');
  r.git('commit', '-m', 'change candidate matrix producer');
  assert.notEqual(publicationInputsAt(r.root, r.git('rev-parse', 'HEAD')).sha256, before.sha256);
});

test('offline admission refuses a missing candidate index even when every prior gate passed', () => {
  const r = repository({ moved: true });
  const input = evidence();
  const proof = publicationInputsAt(r.root, r.head);
  input.sha = input.review.sha = input.main.sha = input.candidate.sha = r.head;
  input.baseline.sha = r.baseline;
  input.publicationInputs =
    input.grant.publicationInputs =
    input.baseline.publicationInputs =
      proof.sha256;
  assert.throws(
    () => actualCheck(input, { repoRoot: r.root, now: new Date('2026-10-14T00:10:00Z') }),
    /candidate run and jobs/
  );
  input.candidate.jobs.push({ name: 'Candidate index (fixture)', id: 999, conclusion: 'success' });
  assert.equal(
    actualCheck(input, { repoRoot: r.root, now: new Date('2026-10-14T00:10:00Z') }).status,
    'eligible'
  );
});
const repo = repository(),
  sha = repo.head,
  hash = 'b'.repeat(64),
  publicationHash = publicationInputsAt(repo.root, repo.baseline).sha256;
function checkPublication(input, options) {
  return actualCheck(input, { ...options, repoRoot: repo.root });
}
/** Complete synthetic observations, never a live authorization source. */
function evidence() {
  return {
    repository: 'lingkaix/openkit',
    tag: 'v0.1.0-rc.6',
    sha,
    observedAt: '2026-10-14T00:00:00Z',
    validUntil: '2026-10-14T01:00:00Z',
    grant: {
      reference: 'synthetic-engineer-grant',
      repository: 'lingkaix/openkit',
      firstTag: 'v0.1.0-rc.6',
      assetSet: hash,
      publicationInputs: publicationHash,
      revoked: false,
      cycleOpen: true,
    },
    assetSet: hash,
    publicationInputs: publicationHash,
    review: { sha, reference: 'synthetic-review' },
    main: { sha, contained: true },
    candidate: {
      sha,
      conclusion: 'success',
      gate: 'release-gate',
      event: 'push',
      ref: 'refs/heads/main',
      runId: 1,
      attempt: 1,
      jobs: [
        'L0-L2 static, unit, contract',
        'L3 NanoCore e2e',
        'L5 smoke',
        'Workspace portability source',
        'Workspace portability target',
        'L5 app-image stopped-server recovery',
        'NanoHost installer fixed-path gate',
        'Smoke worker-common (linux/amd64)',
        'Smoke worker-common (linux/arm64)',
        'Smoke worker-runtimes (linux/amd64)',
        'Smoke worker-runtimes (linux/arm64)',
      ].map((name) => ({ name, conclusion: 'success', id: 1 })),
    },
    baseline: {
      sha: repo.baseline,
      tag: 'v0.1.0-rc.5',
      conclusion: 'success',
      runId: 2,
      publicationInputs: publicationHash,
      jobs: [
        'Publish app image',
        'Publish worker-common image',
        'Publish worker-runtimes image',
        'Publish GitHub Release',
        'Verify published release',
      ].map((name) => ({ name, conclusion: 'success', id: 2 })),
    },
    identities: { state: 'unused', tagUnused: true, imagesUnused: true },
    triage: { label: 'release-blocker', reconciled: true, complete: true, issues: [] },
    flags: { prerelease: true, githubLatest: false, ghcrLatest: false },
  };
}
const now = new Date('2026-10-14T00:30:00Z');
for (const name of evidence().candidate.jobs.map((job) => job.name)) {
  for (const state of ['absent', 'skipped', 'failure', 'duplicate'])
    test(`pre-tag refuses ${name}: ${state}`, () => {
      const input = evidence();
      const job = input.candidate.jobs.find((entry) => entry.name === name);
      if (state === 'absent')
        input.candidate.jobs = input.candidate.jobs.filter((entry) => entry !== job);
      else if (state === 'duplicate') input.candidate.jobs.push({ ...job });
      else job.conclusion = state;
      assert.throws(() => checkPublication(input, { now }));
    });
}
test('first covered prerelease passes a complete mechanical publication check', () => {
  assert.equal(checkPublication(evidence(), { now }).tag, 'v0.1.0-rc.6');
});
test('self-consistent false publication fingerprints cannot prove repository bytes', () => {
  const input = evidence();
  input.publicationInputs =
    input.grant.publicationInputs =
    input.baseline.publicationInputs =
      'f'.repeat(64);
  assert.throws(() => checkPublication(input, { now }));
});
for (const key of Object.keys(evidence()))
  test(`pre-tag refuses absent ${key}`, () => {
    const input = evidence();
    delete input[key];
    assert.throws(() => checkPublication(input, { now }));
  });
for (const [name, change] of [
  [
    'stable',
    (e) => {
      e.tag = 'v0.1.0';
    },
  ],
  [
    'earlier tag',
    (e) => {
      e.tag = 'v0.1.0-rc.5';
    },
  ],
  [
    'ended release cycle',
    (e) => {
      e.grant.cycleOpen = false;
    },
  ],
  [
    'revoked grant',
    (e) => {
      e.grant.revoked = true;
    },
  ],
  [
    'wrong repository',
    (e) => {
      e.repository = 'other/repo';
    },
  ],
  [
    'changed publication implementation input',
    (e) => {
      e.publicationInputs = 'c'.repeat(64);
    },
  ],
  [
    'changed assets',
    (e) => {
      e.assetSet = 'c'.repeat(64);
    },
  ],
  [
    'stale evidence',
    (e) => {
      e.validUntil = e.observedAt;
    },
  ],
  [
    'future evidence',
    (e) => {
      e.observedAt = '2026-10-15T00:00:00Z';
    },
  ],
  [
    'wrong candidate commit',
    (e) => {
      e.candidate.sha = 'c'.repeat(40);
    },
  ],
  [
    'missing candidate job',
    (e) => {
      e.candidate.jobs.pop();
    },
  ],
  [
    'skipped candidate job',
    (e) => {
      e.candidate.jobs[0].conclusion = 'skipped';
    },
  ],
  [
    'missing baseline job',
    (e) => {
      e.baseline.jobs.pop();
    },
  ],
  [
    'unreviewed P',
    (e) => {
      e.review.reference = '';
    },
  ],
  [
    'outside main',
    (e) => {
      e.main.contained = false;
    },
  ],
  [
    'used identity',
    (e) => {
      e.identities.imagesUnused = false;
    },
  ],
  [
    'unreconciled labels',
    (e) => {
      e.triage.reconciled = false;
    },
  ],
  [
    'blocker',
    (e) => {
      e.triage.issues.push({ number: 243, blocker: true, applicable: true, state: 'open' });
    },
  ],
  [
    'undisclosed known issue',
    (e) => {
      e.triage.issues.push({
        number: 243,
        blocker: false,
        applicable: true,
        state: 'open',
        disposition: 'defer',
      });
    },
  ],
  [
    'Latest',
    (e) => {
      e.flags.ghcrLatest = true;
    },
  ],
])
  test(`pre-tag refuses ${name}`, () => {
    const input = evidence();
    change(input);
    assert.throws(() => checkPublication(input, { now }));
  });

test('declared freshness longer than one hour is admitted for the exact commit', () => {
  const input = evidence();
  input.validUntil = '2026-10-15T00:00:00Z';
  assert.equal(checkPublication(input, { now }).status, 'eligible');
});
test('changed transitive publication bytes refuse even when all snapshot hashes agree', () => {
  writeFileSync(
    path.join(repo.root, 'scripts/publication-helper.mjs'),
    'export const fixture = 2;\n'
  );
  repo.git('add', '.');
  repo.git('commit', '-m', 'synthetic changed publication implementation');
  const input = evidence(),
    changed = repo.git('rev-parse', 'HEAD');
  input.sha = input.candidate.sha = input.review.sha = input.main.sha = changed;
  const actual = publicationInputsAt(repo.root, changed);
  assert.notEqual(actual.sha256, publicationHash);
  input.publicationInputs =
    input.grant.publicationInputs =
    input.baseline.publicationInputs =
      actual.sha256;
  assert.throws(() => checkPublication(input, { now }), /actual repository publication inputs/);
});
test('missing repository commit and missing baseline identity cannot prove publication inputs', () => {
  assert.throws(
    () => publicationInputsAt(repo.root, 'f'.repeat(40)),
    /repository publication proof/
  );
  const input = evidence();
  delete input.baseline.sha;
  assert.throws(() => checkPublication(input, { now }), /publication proof exact commit/);
});
