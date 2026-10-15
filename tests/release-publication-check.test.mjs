// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseVersionTag } from '../scripts/release-preflight.mjs';
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
  const input = {
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
  input.baseline.repository = 'lingkaix/openkit';
  input.baseline.workflow = '.github/workflows/ci.yml';
  input.baseline.attempt = 1;
  input.baseline.event = 'push';
  input.baseline.ref = `refs/tags/${input.baseline.tag}`;
  input.baseline.resolvedTagSha = input.baseline.sha;
  for (const job of input.baseline.jobs) {
    job.runId = input.baseline.runId;
    job.attempt = input.baseline.attempt;
    job.sha = input.baseline.sha;
  }
  approveBaseline(input);
  return input;
}
/** A separate synthetic approval, never an authorization collected from a live workflow. */
function approveBaseline(input, kind = 'production-tag') {
  input.grant.baseline = { kind };
  for (const field of ['repository', 'tag', 'sha', 'workflow', 'runId', 'attempt'])
    input.grant.baseline[field] = input.baseline[field];
}
/** The exact real scratch tag grammar with isolated synthetic Git and run identities. */
function scratchEvidence() {
  const input = evidence();
  input.baseline.repository = 'notrucked/openkit';
  input.baseline.tag = 'v0.0.0-rc8-native.20261016.2';
  input.baseline.ref = `refs/tags/${input.baseline.tag}`;
  approveBaseline(input, 'scratch-rehearsal');
  return input;
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
test('the exact successful rc.8 scratch tag is admitted as a publication baseline', () => {
  assert.equal(checkPublication(scratchEvidence(), { now }).status, 'eligible');
});
for (const tag of [
  undefined,
  null,
  '',
  '0.0.0-rc8-native.20261016.2',
  'v00.0.0-rc8-native.20261016.2',
  'v00.0.0-rc.1',
  'v0.0.0-rc.01',
  'v0.0.0-rc8-native.20261016.02',
  'v0.0.0-RC8-native.20261016.2',
  'v0.0.0-rc8-native..20261016.2',
  'v0.0.0-',
  'v0.0.0-rc8-native.20261016.2.---.',
])
  test(`malformed publication baseline tag is refused: ${tag}`, () => {
    assert.throws(() => parseVersionTag(tag), /Release tag must match/);
    const input = evidence();
    input.baseline.tag = tag;
    assert.throws(
      () => checkPublication(input, { now }),
      /successful real-tag unchanged-publication baseline/
    );
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

test('native publication admission requires exact rendered App job names and both successful legs', () => {
  const native = repository();
  const file = path.join(native.root, '.github/workflows/ci.yml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8') +
      ['container-image-matrix', 'build-app-candidate', 'smoke-app-native', 'publish-app-image']
        .map((name) => `  ${name}:\n    steps:\n      - run: node scripts/release-notes.mjs\n`)
        .join('')
  );
  native.git('add', '.');
  native.git('commit', '-m', 'synthetic native publication baseline');
  const baseline = native.git('rev-parse', 'HEAD');
  writeFileSync(path.join(native.root, 'README.md'), 'New reviewed candidate.\n');
  native.git('add', '.');
  native.git('commit', '-m', 'synthetic exact candidate');
  const source = native.git('rev-parse', 'HEAD');
  const input = evidence();
  input.sha = input.review.sha = input.main.sha = input.candidate.sha = source;
  input.baseline.sha = baseline;
  input.baseline.tag = 'v0.0.0-rc8-native.20261016.2';
  input.baseline.repository = 'notrucked/openkit';
  input.baseline.ref = `refs/tags/${input.baseline.tag}`;
  input.baseline.resolvedTagSha = baseline;
  const fingerprint = publicationInputsAt(native.root, source).sha256;
  input.publicationInputs =
    input.grant.publicationInputs =
    input.baseline.publicationInputs =
      fingerprint;
  input.baseline.jobs.push(
    ...[
      'Build app candidate',
      'Smoke App native (linux/amd64)',
      'Smoke App native (linux/arm64)',
    ].map((name, i) => ({ name, id: 100 + i, conclusion: 'success' }))
  );
  for (const job of input.baseline.jobs) {
    job.runId = input.baseline.runId;
    job.attempt = input.baseline.attempt;
    job.sha = baseline;
  }
  approveBaseline(input, 'scratch-rehearsal');
  const check = (value) =>
    actualCheck(value, { repoRoot: native.root, now: new Date('2026-10-14T00:10:00Z') });
  assert.equal(check(input).status, 'eligible');
  for (const name of [
    'Build app candidate',
    'Smoke App native (linux/amd64)',
    'Smoke App native (linux/arm64)',
    'Publish app image',
  ]) {
    for (const change of ['missing', 'skipped', 'failure', 'duplicate', 'expanded-name']) {
      const bad = structuredClone(input);
      const index = bad.baseline.jobs.findIndex((job) => job.name === name);
      if (change === 'missing') bad.baseline.jobs.splice(index, 1);
      else if (change === 'duplicate') bad.baseline.jobs.push({ ...bad.baseline.jobs[index] });
      else if (change === 'expanded-name')
        bad.baseline.jobs[index].name += ' (unexpected matrix suffix...)';
      else bad.baseline.jobs[index].conclusion = change;
      assert.throws(
        () => check(bad),
        /successful real-tag unchanged-publication baseline/,
        `${name}: ${change}`
      );
    }
  }
});

test('an approved earlier real production tag remains a valid unchanged-publication baseline', () => {
  const input = evidence();
  input.baseline.tag = 'v0.0.9';
  input.baseline.ref = `refs/tags/${input.baseline.tag}`;
  approveBaseline(input);
  assert.equal(checkPublication(input, { now }).status, 'eligible');
});
for (const field of [
  'repository',
  'tag',
  'sha',
  'workflow',
  'runId',
  'attempt',
  'event',
  'ref',
  'resolvedTagSha',
])
  test(`baseline authority refuses missing observed ${field}`, () => {
    const input = scratchEvidence();
    delete input.baseline[field];
    assert.throws(() => checkPublication(input, { now }));
  });
for (const field of ['repository', 'tag', 'sha', 'workflow', 'runId', 'attempt']) {
  test(`baseline authority refuses missing approved ${field}`, () => {
    const input = scratchEvidence();
    delete input.grant.baseline[field];
    assert.throws(() => checkPublication(input, { now }), /approved publication baseline identity/);
  });
  test(`baseline authority refuses mismatched approved ${field}`, () => {
    const input = scratchEvidence();
    input.grant.baseline[field] = typeof input.grant.baseline[field] === 'number' ? 99 : 'other';
    assert.throws(() => checkPublication(input, { now }), /approved publication baseline identity/);
  });
}
for (const [name, change] of [
  [
    'missing approval',
    (e) => {
      delete e.grant.baseline;
    },
  ],
  [
    'missing approval kind',
    (e) => {
      delete e.grant.baseline.kind;
    },
  ],
  [
    'unknown approval kind',
    (e) => {
      e.grant.baseline.kind = 'unapproved';
    },
  ],
  [
    'wrong scratch owner',
    (e) => {
      e.baseline.repository = 'other/openkit';
      approveBaseline(e, 'scratch-rehearsal');
    },
  ],
  [
    'wrong scratch repository',
    (e) => {
      e.baseline.repository = 'notrucked/other';
      approveBaseline(e, 'scratch-rehearsal');
    },
  ],
  [
    'branch push',
    (e) => {
      e.baseline.ref = 'refs/heads/main';
    },
  ],
  [
    'manual run',
    (e) => {
      e.baseline.event = 'workflow_dispatch';
    },
  ],
  [
    'missing tag-push event',
    (e) => {
      delete e.baseline.event;
    },
  ],
  [
    'missing tag ref',
    (e) => {
      delete e.baseline.ref;
    },
  ],
  [
    'substituted tag',
    (e) => {
      e.baseline.tag = 'v0.0.0-other.1';
      e.baseline.ref = `refs/tags/${e.baseline.tag}`;
    },
  ],
  [
    'run source differs from the approved source',
    (e) => {
      e.baseline.sha = repo.head;
    },
  ],
  [
    'mismatched resolved source',
    (e) => {
      e.baseline.resolvedTagSha = 'c'.repeat(40);
    },
  ],
  [
    'missing resolved source',
    (e) => {
      delete e.baseline.resolvedTagSha;
    },
  ],
  [
    'stable scratch tag',
    (e) => {
      e.baseline.tag = 'v0.0.0';
      e.baseline.ref = 'refs/tags/v0.0.0';
      approveBaseline(e, 'scratch-rehearsal');
    },
  ],
  [
    'unapproved workflow',
    (e) => {
      e.baseline.workflow = '.github/workflows/other.yml';
      approveBaseline(e, 'scratch-rehearsal');
    },
  ],
  [
    'missing attempt',
    (e) => {
      delete e.baseline.attempt;
    },
  ],
  [
    'zero attempt',
    (e) => {
      e.baseline.attempt = 0;
      approveBaseline(e, 'scratch-rehearsal');
    },
  ],
  [
    'production approval for scratch',
    (e) => {
      approveBaseline(e);
    },
  ],
  [
    'scratch approval for production',
    (e) => {
      e.baseline.repository = 'lingkaix/openkit';
      approveBaseline(e, 'scratch-rehearsal');
    },
  ],
])
  test(`baseline authority refuses ${name}`, () => {
    const input = scratchEvidence();
    change(input);
    assert.throws(() => checkPublication(input, { now }), /approved publication baseline identity/);
  });
for (const approval of [null, [], true, 'approval', 7])
  test(`baseline authority refuses a non-object approval: ${JSON.stringify(approval)}`, () => {
    const input = scratchEvidence();
    input.grant.baseline = approval;
    assert.throws(() => checkPublication(input, { now }), /approved publication baseline identity/);
  });
test('baseline authority refuses an unknown approval field', () => {
  const input = scratchEvidence();
  input.grant.baseline.requiredApproval = 'engineer-only';
  assert.throws(() => checkPublication(input, { now }), /approved publication baseline identity/);
});
for (const field of ['runId', 'attempt', 'sha'])
  for (const change of ['missing', 'mismatched'])
    test(`baseline authority refuses ${change} required-job ${field}`, () => {
      const input = scratchEvidence();
      if (change === 'missing') delete input.baseline.jobs[0][field];
      else input.baseline.jobs[0][field] = field === 'sha' ? 'c'.repeat(40) : 99;
      assert.throws(
        () => checkPublication(input, { now }),
        /approved publication baseline identity/
      );
    });
