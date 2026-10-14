import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPublication } from '../scripts/release-publication-check.mjs';

const sha = 'a'.repeat(40),
  hash = 'b'.repeat(64);
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
      publicationInputs: hash,
      revoked: false,
      cycleOpen: true,
    },
    assetSet: hash,
    publicationInputs: hash,
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
      ].map((name) => ({ name, conclusion: 'success', id: 1 })),
    },
    baseline: {
      tag: 'v0.1.0-rc.5',
      conclusion: 'success',
      runId: 2,
      publicationInputs: hash,
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
test('first covered prerelease passes a complete mechanical publication check', () => {
  assert.equal(checkPublication(evidence(), { now }).tag, 'v0.1.0-rc.6');
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
