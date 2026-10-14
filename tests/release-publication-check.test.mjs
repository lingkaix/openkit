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
function repository() {
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
      ['publish-container-images', 'github-release', 'verify-release']
        .map((n) => `  ${n}:\n    steps:\n      - run: node scripts/release-notes.mjs\n`)
        .join('')
  );
  writeFileSync(
    path.join(root, 'scripts/release-notes.mjs'),
    "import './publication-helper.mjs';\n"
  );
  writeFileSync(path.join(root, 'scripts/publication-helper.mjs'), 'export const fixture = 1;\n');
  git('add', '.');
  git('commit', '-m', 'synthetic proved baseline');
  const baseline = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'README.md'), 'Unrelated reviewed change.\n');
  git('add', '.');
  git('commit', '-m', 'synthetic candidate');
  const head = git('rev-parse', 'HEAD');
  return { root, baseline, head, git };
}
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
