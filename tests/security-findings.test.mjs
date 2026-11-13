// R13 release-finding gate oracle (draft). Development Security §Release gate: every K or C finding
// in the candidate needs a current `mitigated` record, a reviewed `not_affected` record, or an
// unexpired `accepted` record the engineer decided — whether or not a fix exists. `open` and expired
// records fail; `fixed` means the finding is absent, never an excuse for one that still matches. Only
// K and C gate the release. Every record, alias and ref below is synthetic.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { assertReleaseFindingGate, releaseFindingRecord } = await import(
  pathToFileURL(join(root, 'scripts/security-findings.mjs')).href
);

const NOW = Date.parse('2027-03-15T00:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const artifact = `sha256:${'a'.repeat(64)}`;
const otherArtifact = `sha256:${'b'.repeat(64)}`;
const component = { purl: 'pkg:npm/synthetic@1.0.0', location: 'pnpm-lock.yaml' };
const advisoryIds = ['GHSA-aaaa-bbbb-cccc'];
const binding = {
  id: 'OSV-2027-0001',
  artifact,
  component,
  advisoryIds,
  class: 'K',
  knownExploited: true,
};
const F = (overrides = {}) => ({ ...binding, fixAvailable: false, ...overrides });
const R = (overrides = {}) => ({
  ...binding,
  status: 'open',
  openedAt: iso(NOW - 5 * DAY),
  dueAt: iso(NOW + DAY),
  reachability: { judgment: 'unknown', evidence: [] },
  decider: { id: 'engineer-alias', role: 'engineer' },
  links: ['synthetic:advisory'],
  ...overrides,
});
const A = (overrides = {}) =>
  R({
    status: 'accepted',
    decision: { at: iso(NOW - 10 * DAY), reviewAt: iso(NOW + 30 * DAY), reason: 'synthetic' },
    ...overrides,
  });
const G = (findings, records) => ({ findings, register: { schemaVersion: 1, records }, now: NOW });
const admitted = (options, label) =>
  assert.doesNotThrow(() => assertReleaseFindingGate(options), label);
const refused = (options, label) =>
  assert.throws(() => assertReleaseFindingGate(options), Error, label);
const reach = (overrides = {}) => ({
  judgment: 'unreachable',
  evidence: ['synthetic:vex'],
  author: 'analyst-alias',
  reviewer: 'reviewer-alias',
  ...overrides,
});

// NEW-only supplement: public release records carry urgent identifiers, never private dispositions.
test('public release record includes approved present C identifiers without private values', () => {
  const finding = F({ class: 'C', knownExploited: false });
  const record = A({
    class: 'C',
    knownExploited: false,
    decision: { at: iso(NOW - DAY), reviewAt: iso(NOW + DAY), reason: 'private-reason-fixture' },
    decider: { id: 'private-engineer-fixture', role: 'engineer' },
    reachability: { judgment: 'unknown', evidence: ['private-evidence-fixture'] },
    links: ['private-reference-fixture'],
  });
  const markdown = releaseFindingRecord(G([finding], [record]));
  assert.equal(typeof markdown, 'string', 'Public record must be Markdown text');
  for (const id of advisoryIds)
    assert.ok(markdown.includes(id), 'Approved present urgent advisory must remain public');
  for (const value of [
    'private-reason-fixture',
    'private-engineer-fixture',
    'private-evidence-fixture',
    'private-reference-fixture',
  ])
    assert.equal(
      markdown.includes(value),
      false,
      'Public record must exclude private record values'
    );
  assert.throws(
    () => releaseFindingRecord(G([finding], [R({ class: 'C', knownExploited: false })])),
    Error,
    'Public record generation must retain the finding admission gate'
  );
});

test('public release record retains prior C identifiers when the current scan reports H', () => {
  const finding = F({ class: 'H', knownExploited: false });
  const record = A({ class: 'C', knownExploited: false });
  const markdown = releaseFindingRecord(G([finding], [record]));
  assert.equal(typeof markdown, 'string', 'Public record must be Markdown text');
  for (const id of advisoryIds)
    assert.ok(
      markdown.includes(id),
      'A current lower scan class must not erase prior urgent identifiers'
    );
});

test('an open record never admits a K or C finding, with or without a fix', () => {
  for (const cls of ['K', 'C'])
    for (const fix of [false, true])
      refused(G([F({ class: cls, fixAvailable: fix })], [R({ class: cls })]), `open ${cls}`);
});

test('a current mitigation is admitted and an expired or uncontrolled one is refused', () => {
  const control = (value) => ({ at: iso(NOW - 2 * DAY), reviewAt: iso(NOW + DAY), control: value });
  const commit = control({ commit: 'c'.repeat(40) });
  const setting = control({ setting: 'switch-disabled' });
  for (const cls of ['K', 'C'])
    for (const fix of [false, true]) {
      const found = F({ class: cls, fixAvailable: fix });
      const m = (decision) => R({ class: cls, status: 'mitigated', decision });
      const check = (decision, label) => refused(G([found], [m(decision)]), `${label} ${cls}`);
      admitted(G([found], [m(commit)]), `commit ${cls}`);
      admitted(G([found], [m(setting)]), `setting ${cls}`);
      check({ ...commit, reviewAt: iso(NOW) }, 'current review');
      check({ ...commit, reviewAt: iso(NOW - DAY) }, 'past review');
      check(control({ commit: 'c'.repeat(39) }), 'short commit');
      check(control({ setting: '' }), 'empty setting');
      check(control(undefined), 'no control');
    }
});

test('a reviewed not_affected record is admitted and an unreviewed one is refused', () => {
  const vex = { at: iso(NOW - DAY), reviewAt: iso(NOW + 30 * DAY) };
  const justification = 'vulnerable_code_not_in_execute_path';
  for (const cls of ['K', 'C'])
    for (const fix of [false, true]) {
      const found = F({ class: cls, fixAvailable: fix });
      const v = (overrides = {}) =>
        R({
          class: cls,
          status: 'not_affected',
          ...overrides,
          decision: { ...vex, justification, ...overrides.decision },
        });
      const check = (overrides, label) => refused(G([found], [v(overrides)]), `${label} ${cls}`);
      admitted(G([found], [v({ reachability: reach() })]), `reviewed ${cls}`);
      check({ reachability: reach({ reviewer: 'analyst-alias' }) }, 'same reviewer');
      check({ reachability: reach({ evidence: [] }) }, 'no evidence');
      check({ reachability: reach({ reviewer: undefined }) }, 'no reviewer');
      check({ decision: { ...vex, justification: undefined } }, 'no justification');
      check({ decision: { ...vex, justification: 'synthetic_unknown' } }, 'unknown VEX');
      check({ reachability: reach(), decision: { reviewAt: iso(NOW) } }, 'VEX review expires now');
      check(
        { reachability: reach(), decision: { reviewAt: iso(NOW - DAY) } },
        'VEX review already expired'
      );
    }
});

test('an unexpired engineer acceptance is admitted and every other decider is refused', () => {
  const at = NOW - 10 * DAY;
  const reason = 'synthetic';
  for (const cls of ['K', 'C'])
    for (const fix of [false, true]) {
      const found = F({ class: cls, fixAvailable: fix });
      const a = (overrides = {}) =>
        R({
          class: cls,
          status: 'accepted',
          ...overrides,
          decision: { at: iso(at), reviewAt: iso(at + 30 * DAY), reason, ...overrides.decision },
        });
      const check = (overrides, label) => refused(G([found], [a(overrides)]), `${label} ${cls}`);
      admitted(G([found], [a()]), `engineer ${cls}`);
      for (const role of ['maintainer', 'agent'])
        check({ decider: { id: 'decider-alias', role } }, `${role} decider`);
      check({ decision: { reviewAt: iso(NOW) } }, 'expires now');
      check({ decision: { reviewAt: iso(at + 91 * DAY) } }, 'beyond 90 days');
      check({ decision: { reason: undefined } }, 'no reason');
      check({ decision: { at: iso(NOW + DAY) } }, 'future decision');
    }
  const bound = A({ decision: { at: iso(at), reviewAt: iso(at + 90 * DAY), reason } });
  admitted(G([F()], [bound]), 'exact 90-day bound');
});

test('shared advisory identity requires independent clearance for each released platform', () => {
  // Development Security gates every K/C finding; the approved export binds each exact artifact/component.
  const first = { artifact, component: { ...component, location: 'image/linux-amd64' } };
  const second = {
    artifact: otherArtifact,
    component: { ...component, location: 'image/linux-arm64' },
  };
  const findings = [F(first), F(second)];
  const records = [A(first), A(second)];
  admitted(G(findings, records), 'Independently scoped acceptances must clear both platforms');
  refused(G(findings, [records[0]]), 'First platform clearance must not clear its sibling');
  refused(G(findings, [records[1]]), 'Second platform clearance must not clear its sibling');
  refused(
    G(findings, [...records, R(first)]),
    'Conflicting rows for the same exact binding must refuse'
  );
});

test('a fixed record never excuses a finding that is still present', () => {
  for (const cls of ['K', 'C'])
    for (const fix of [false, true]) {
      const found = F({ class: cls, fixAvailable: fix });
      refused(G([found], [R({ class: cls, status: 'fixed' })]), `fixed ${cls}`);
    }
  admitted(G([], [R({ status: 'fixed' })]), 'fixed without a finding');
});

test('the release gate covers K and C only', () => {
  for (const cls of ['H', 'N'])
    for (const records of [[], [R({ class: cls, status: 'open', knownExploited: false })]])
      admitted(G([F({ class: cls, knownExploited: false })], records), `${cls} outside gate`);
});

test('dormant or absent records admit nothing for K or C', () => {
  for (const cls of ['K', 'C']) {
    refused({ findings: [F({ class: cls })], now: NOW }, `absent register ${cls}`);
    refused(G([F({ class: cls })], []), `empty register ${cls}`);
  }
  admitted(G([], []), 'no findings, empty register');
  admitted({ findings: [], now: NOW }, 'no findings, no register');
});

test('a record binds exactly one artifact, component and advisory set', () => {
  const check = (overrides, label) => refused(G([F()], [{ ...A(), ...overrides }]), label);
  admitted(G([F()], [A()]), 'exact binding');
  check({ artifact: otherArtifact }, 'other artifact digest');
  check({ component: { ...component, location: 'app/package-lock.json' } }, 'other location');
  check({ component: { ...component, purl: 'pkg:npm/other@1.0.0' } }, 'other purl');
  check({ advisoryIds: ['GHSA-dddd-eeee-ffff'] }, 'other advisory set');
});

test('unknown vocabulary is refused rather than defaulted', () => {
  refused(G([F({ class: 'X' })], [A({ class: 'X' })]), 'unknown finding class');
  refused(G([F()], [{ ...A(), status: 'deferred' }]), 'unknown status');
  const version = { findings: [F()], register: { schemaVersion: 2, records: [A()] }, now: NOW };
  refused(version, 'unknown register schema version');
  refused(G([F()], [{ ...A(), openedAt: '2027-03-14' }]), 'non-canonical date');
  refused(
    G([F({ artifact: 'sha256:nothex' })], [A({ artifact: 'sha256:nothex' })]),
    'malformed artifact'
  );
});
