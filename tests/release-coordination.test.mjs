import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { premerge, validateMergeSnapshot } from '../scripts/ci-premerge.mjs';
import { publishTag, reconcileTriage } from '../scripts/release-coordinate.mjs';
import {
  command,
  commitAt,
  issueDelta,
  observeIssues,
  observeRun,
  publicText,
  requireOrigin,
  validateRun,
  validateShaReferences,
} from '../scripts/release-observe.mjs';
import { notesDraft, prepareRelease, previousIssues } from '../scripts/release-prepare.mjs';
import { candidateJobs } from '../scripts/release-publication-check.mjs';

test('exact-head premerge refuses changed source, main, missing ancestry or dirty inputs', () => {
  const valid = {
    sha: 'a'.repeat(40),
    branchSha: 'a'.repeat(40),
    expectedMain: 'b'.repeat(40),
    currentMain: 'b'.repeat(40),
    ancestor: true,
    clean: true,
  };
  assert.doesNotThrow(() => validateMergeSnapshot(valid));
  for (const change of [
    { branchSha: 'c'.repeat(40) },
    { currentMain: 'c'.repeat(40) },
    { ancestor: false },
    { clean: false },
  ])
    assert.throws(() => validateMergeSnapshot({ ...valid, ...change }));
});

/** Stand-in GitHub observations exercise the real completeness and rerun comparator. */
function runFixture() {
  const run = {
    id: 41,
    run_attempt: 2,
    repository: { full_name: 'example/openkit' },
    head_sha: 'a'.repeat(40),
    head_branch: 'topic',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/ci.yml',
  };
  const jobs = candidateJobs.map((name, i) => ({
    name,
    id: i + 1,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
  }));
  return {
    run,
    jobs,
    expected: { repository: 'example/openkit', sha: run.head_sha, branch: 'topic' },
  };
}

test('current CI proof refuses every absent, skipped, failed, duplicate and earlier-attempt required job', () => {
  const { run, jobs, expected } = runFixture();
  assert.equal(validateRun(run, jobs, expected).sha, run.head_sha);
  for (const job of jobs) {
    assert.throws(() =>
      validateRun(
        run,
        jobs.filter((j) => j !== job),
        expected
      )
    );
    assert.throws(() => validateRun(run, [...jobs, job], expected));
    for (const conclusion of ['skipped', 'failure', 'cancelled'])
      assert.throws(() =>
        validateRun(
          run,
          jobs.map((j) => (j === job ? { ...j, conclusion } : j)),
          expected
        )
      );
    assert.throws(() =>
      validateRun(
        run,
        jobs.map((j) => (j === job ? { ...j, run_attempt: 1 } : j)),
        expected
      )
    );
  }
  assert.throws(() => validateRun({ ...run, head_sha: 'b'.repeat(40) }, jobs, expected));
  assert.throws(() => validateRun({ ...run, event: 'pull_request' }, jobs, expected));
});

test('a rerun starting during retained CI observation invalidates the proof', () => {
  const { run, jobs, expected } = runFixture();
  let reads = 0;
  const read = (endpoint) =>
    endpoint.includes('/jobs?')
      ? [{ total_count: jobs.length, jobs }]
      : ++reads === 1
        ? run
        : { ...run, run_attempt: 3, status: 'in_progress' };
  assert.throws(() => observeRun({ ...expected, runId: run.id }, { read }), /attempt changed/);
});

test('issue collection follows all pages and never exposes account addresses in draft text', () => {
  const issue = (number, state = 'open') => ({
    number,
    state,
    title: `Issue ${number}`,
    updated_at: '2026-10-15T00:00:00Z',
    closed_at: null,
    labels: [],
  });
  const read = (endpoint, options) => {
    assert.equal(options.paginate, true);
    return endpoint.includes('/issues?')
      ? [[issue(1)], [issue(2, 'closed')]]
      : [[{ name: 'release-blocker' }]];
  };
  const snapshot = observeIssues('example/openkit', { read });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.issues.length, 2);
  assert.equal(snapshot.blockerLabelExists, true);
  assert.equal(
    publicText('Contact ' + 'account' + '@' + 'example.invalid'),
    'Contact [redacted-address]'
  );
  assert.throws(() => observeIssues('example/openkit', { read: () => ({ issues: [] }) }));
});

test('issue delta retains new, changed, reopened and missing findings without rewriting unchanged rows', () => {
  const previous = {
    issues: [
      { number: 1, state: 'open' },
      { number: 2, state: 'closed' },
      { number: 3, state: 'open' },
    ],
  };
  const current = {
    complete: true,
    issues: [
      { number: 1, state: 'open' },
      { number: 2, state: 'open' },
      { number: 4, state: 'open' },
    ],
  };
  assert.deepEqual(
    issueDelta(previous, current).map(({ number, change }) => ({ number, change })),
    [
      { number: 2, change: 'reopened' },
      { number: 4, change: 'new' },
      { number: 3, change: 'missing' },
    ]
  );
  assert.throws(() => issueDelta(previous, { ...current, complete: false }));
});

test('admission collection refuses incomplete or stale triage and cannot erase an observed blocker label', () => {
  const snapshot = {
    complete: true,
    blockerLabelExists: true,
    sha256: 'a'.repeat(64),
    issues: [{ number: 1, state: 'open', labels: [] }],
  };
  const triage = {
    complete: true,
    reconciled: true,
    snapshotSha256: snapshot.sha256,
    issues: [
      {
        number: 1,
        state: 'open',
        applicable: true,
        blocker: false,
        owner: 'accepted-owner',
        disposition: 'deferred',
        disclosure: 'known issue',
      },
    ],
  };
  assert.equal(reconcileTriage(triage, snapshot).label, 'release-blocker');
  for (const change of [
    { issues: [] },
    { complete: false },
    { snapshotSha256: 'b'.repeat(64) },
    { issues: [...triage.issues, ...triage.issues] },
  ])
    assert.throws(() => reconcileTriage({ ...triage, ...change }, snapshot));
  assert.throws(() =>
    reconcileTriage(triage, {
      ...snapshot,
      issues: [{ ...snapshot.issues[0], labels: ['release-blocker'] }],
    })
  );
});

test('preparation imports existing authored issue rows and generates the two-section factual draft', () => {
  const previous = previousIssues(
    '| [#12](https://github.com/example/openkit/issues/12) | accepted owner | disclosed |\n'
  );
  assert.equal(previous.issues[0].number, 12);
  assert.equal(previous.issues[0].state, 'unobserved');
  const draft = notesDraft({
    commits: [{ sha: 'a'.repeat(40), subject: 'fix: accepted change' }],
    closedIssues: [{ number: 12, title: 'accepted issue' }],
    knownIssues: '- Retain the disclosed limitation.',
  });
  assert.match(draft, /## Changes since the previous candidate/);
  assert.match(draft, /Confirm that its change is included/);
  assert.match(draft, /## Known issues\n\n- Retain the disclosed limitation\./);
});

test('preparation validates real commit objects and refuses a hand-typed nonexistent SHA', () => {
  const head = commitAt('HEAD');
  assert.equal(validateShaReferences({ sha: head }), 1);
  assert.equal(validateShaReferences({ sha: head.toUpperCase() }), 1);
  assert.throws(() => validateShaReferences({ sha: 'f'.repeat(40) }));
  assert.throws(() => validateShaReferences({ sha: 'F'.repeat(40) }));
});

test('observation subprocesses stop at the declared deadline without exposing raw output', () => {
  assert.throws(
    () =>
      command(
        process.execPath,
        ['-e', 'console.log("private-output"); setInterval(() => {}, 1000)'],
        { timeout: 30 }
      ),
    (error) => error.message === `Release observation failed: ${process.execPath}`
  );
});

test('premerge uses only an ordinary exact-SHA fast-forward after successful fresh evidence', () => {
  const source = commitAt('HEAD');
  const calls = [];
  let changed = false;
  const run = (exe, args) => {
    calls.push([exe, ...args]);
    if (args[0] === 'remote') return 'https://github.com/example/openkit.git';
    if (args[0] === 'ls-remote') return `${changed ? 'b'.repeat(40) : source}\trefs/heads/topic`;
    return '';
  };
  const read = () => ({ object: { sha: source } });
  const observed = { sha: source, runId: 41, attempt: 2 };
  const observe = () => observed;
  premerge({ repository: 'example/openkit', branch: 'topic', runId: 41 }, { run, read, observe });
  assert.ok(!calls.some((c) => c.includes('push')));
  calls.length = 0;
  premerge(
    { repository: 'example/openkit', branch: 'topic', runId: 41, merge: true },
    { run, read, observe }
  );
  assert.deepEqual(
    calls.filter((c) => c.includes('push')),
    [['git', 'push', '--no-follow-tags', '--porcelain', 'origin', `${source}:refs/heads/main`]]
  );
  calls.length = 0;
  assert.throws(() =>
    premerge(
      { repository: 'example/openkit', branch: 'topic', runId: 41, merge: true },
      {
        run,
        read,
        observe: () => {
          changed = true;
          return observed;
        },
      }
    )
  );
  assert.ok(!calls.some((c) => c.includes('push')));
});

test('tag coordination refuses changed or failed admission before any tag effect', () => {
  const e = {
    repository: 'example/openkit',
    sha: commitAt('HEAD'),
    tag: 'v0.1.0-rc.99',
    identities: { state: 'unused' },
  };
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    if (args[1][0] === 'remote') return 'https://github.com/example/openkit.git';
    return '';
  };
  const collect = () => ({ evidence: e });
  assert.throws(() =>
    publishTag(e, {
      collect,
      run,
      admit: () => {
        throw Error('injected admission refusal');
      },
    })
  );
  assert.deepEqual(calls, []);
  assert.throws(() =>
    publishTag(e, {
      collect: () => ({ evidence: { ...e, sha: 'a'.repeat(40) } }),
      run,
      admit: () => ({ status: 'eligible' }),
    })
  );
  assert.deepEqual(calls, []);
  publishTag(e, { collect, run, admit: () => ({ status: 'eligible' }) });
  assert.deepEqual(
    calls.filter((c) => c[1][0] === 'tag' || c[1][0] === 'push'),
    [
      ['git', ['tag', e.tag, e.sha]],
      [
        'git',
        [
          'push',
          '--no-follow-tags',
          '--porcelain',
          'origin',
          `refs/tags/${e.tag}:refs/tags/${e.tag}`,
        ],
      ],
    ]
  );
});

test('a foreign or multiple push destination cannot inherit the fetch origin authority', () => {
  for (const push of [
    'https://github.com/outside/other.git',
    'https://github.com/example/openkit.git\nhttps://github.com/outside/other.git',
  ]) {
    assert.throws(() =>
      requireOrigin('example/openkit', {
        run: (_exe, args) =>
          args.includes('--push') ? push : 'https://github.com/example/openkit.git',
      })
    );
  }
});

test('legacy reconciliation retains repeated rows for one issue and refuses mixed repository identities', () => {
  const row = '| [#12](https://github.com/example/openkit/issues/12) | owner | disclosed |';
  const previous = previousIssues(`${row}\n${row}\n`);
  assert.equal(previous.issues.length, 1);
  assert.equal(previous.issues[0].recordRows.length, 2);
  assert.throws(() =>
    previousIssues(`${row}\n${row.replace('example/openkit', 'other/openkit')}\n`)
  );
});

test('preparation generates private facts from actual Git objects without changing the checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-release-prepare-'));
  const fixture = join(root, 'repository');
  mkdirSync(fixture);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture',
  };
  const git = (...args) => command('git', args, { cwd: fixture, env });
  git('init', '--initial-branch=fixture');
  mkdirSync(join(fixture, '.github/workflows'), { recursive: true });
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'release-notes'));
  writeFileSync(
    join(fixture, '.github/workflows/ci.yml'),
    'jobs:\n' +
      ['publish-container-images', 'github-release', 'verify-release']
        .map((id) => `  ${id}:\n    steps:\n      - run: node scripts/fixture.mjs\n`)
        .join('')
  );
  writeFileSync(join(fixture, 'scripts/fixture.mjs'), 'export const fixture = true;\n');
  writeFileSync(
    join(fixture, 'release-notes/v0.1.0-rc.6.md'),
    notesDraft({ commits: [], closedIssues: [], knownIssues: '- Retained fixture limitation.' })
  );
  git('add', '.');
  git('commit', '-m', 'fixture baseline');
  git('tag', 'v0.1.0-rc.6');
  git('commit', '--allow-empty', '-m', 'fixture source');
  const head = commitAt('HEAD', { cwd: fixture });
  const output = join(root, 'facts');
  const previous = { repository: 'example/openkit', issues: [] };
  const snapshot = {
    repository: previous.repository,
    complete: true,
    sha256: 'a'.repeat(64),
    issues: [],
  };
  try {
    const result = prepareRelease(
      {
        repository: previous.repository,
        tag: 'v0.1.0-rc.99',
        previousTag: 'v0.1.0-rc.6',
        previous,
        baselineSha: head,
        output,
        root: fixture,
      },
      { issues: () => snapshot, read: () => ({ published_at: '2026-10-14T00:00:00Z' }) }
    );
    assert.equal(result.sourceCommit, head);
    assert.equal(result.publicationInputsEqual, true);
    const facts = JSON.parse(readFileSync(join(output, 'preparation.json'), 'utf8'));
    assert.ok(facts.commits.length > 0);
    assert.ok(facts.commits.every((c) => commitAt(c.sha, { cwd: fixture }) === c.sha));
    assert.match(readFileSync(join(output, 'notes-draft.md'), 'utf8'), /## Known issues/);
    assert.throws(() => prepareRelease({ repository: 'other/openkit', previous }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit branch and tag pushes suppress configured annotated-tag following', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-push-boundary-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture',
  };
  const git = (...args) => command('git', args, { cwd: root, env });
  try {
    git('init', '--initial-branch=fixture');
    git('commit', '--allow-empty', '-m', 'fixture');
    git('tag', '-a', 'unrelated', '-m', 'unrelated');
    git('init', '--bare', join(root, 'remote.git'));
    git('remote', 'add', 'origin', join(root, 'remote.git'));
    git('config', 'push.followTags', 'true');
    git('push', '--no-follow-tags', '--porcelain', 'origin', 'HEAD:refs/heads/main');
    assert.equal(git('ls-remote', 'origin', 'refs/tags/*'), '');
    git('tag', 'selected');
    git(
      'push',
      '--no-follow-tags',
      '--porcelain',
      'origin',
      'refs/tags/selected:refs/tags/selected'
    );
    const refs = git('ls-remote', 'origin', 'refs/tags/*');
    assert.match(refs, /refs\/tags\/selected/);
    assert.doesNotMatch(refs, /unrelated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
