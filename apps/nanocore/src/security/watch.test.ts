import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assessSecurityWatch } from './watch.js';

type WatchInput = Parameters<typeof assessSecurityWatch>[0];
type WatchReport = ReturnType<typeof assessSecurityWatch>;
const NOW = '2026-11-01T00:00:00.000Z';
const ago = (milliseconds: number) => new Date(Date.parse(NOW) - milliseconds).toISOString();
const check = (age: number = 0) => ({ lastStartedAt: ago(age), inFlight: false });
const feed = (
  kind: WatchInput['feeds'][number]['kind'],
  id: string,
  age: number
): WatchInput['feeds'][number] => ({
  id,
  kind,
  ...check(age),
  lastSuccessAt: ago(age),
  lastFailureAt: null,
});
const base = (extra: Partial<WatchInput> = {}): WatchInput => ({
  now: NOW,
  invocation: 'interval',
  state: 'on',
  delegationCurrent: true,
  inventory: check(),
  audit: check(),
  feeds: [],
  notices: { ...check(), outstanding: true },
  ...extra,
});
const dueFeeds = (report: WatchReport) => [...report.dueFeedIds].sort();
const status = (report: WatchReport, id: string) => {
  const found = report.feedReports.find((row) => row.id === id);
  assert.ok(found, 'configured feed retains a visible assessment');
  return found;
};

// E3/E4 fixed intervals only. No runner, native state, timers, writes or retry policy.
describe('E3/E4 pure cadence and independent notice/watch assessment', () => {
  it('uses the exact daily boundary for inventory matching and both OSV kinds', () => {
    const before = assessSecurityWatch(
      base({
        inventory: check(86399999),
        feeds: [feed('osv-api', 'api', 86399999), feed('osv-records', 'records', 86399999)],
      })
    );
    assert.equal(before.dueInventory, false);
    assert.deepEqual(dueFeeds(before), []);
    const due = assessSecurityWatch(
      base({
        inventory: check(86400000),
        feeds: [feed('osv-api', 'api', 86400000), feed('osv-records', 'records', 86400000)],
      })
    );
    assert.equal(due.dueInventory, true);
    assert.deepEqual(dueFeeds(due), ['api', 'records']);
  });

  it('uses the exact one-hour boundary for KEV and operator-selected RSS', () => {
    const before = assessSecurityWatch(
      base({ feeds: [feed('kev', 'kev', 3599999), feed('rss', 'rss', 3599999)] })
    );
    assert.deepEqual(dueFeeds(before), []);
    const due = assessSecurityWatch(
      base({ feeds: [feed('kev', 'kev', 3600000), feed('rss', 'rss', 3600000)] })
    );
    assert.deepEqual(dueFeeds(due), ['kev', 'rss']);
  });

  it('keeps healthy slow-completion polls within the original 3,600-second start interval', () => {
    const signal = { ...feed('kev', 'slow-success', 3600000), lastSuccessAt: ago(3540000) };
    const report = assessSecurityWatch(base({ feeds: [signal] }));
    assert.deepEqual(dueFeeds(report), ['slow-success']);
    assert.equal(status(report, 'slow-success').stale, false);
  });

  it('uses exactly 300 seconds for both audit watch and outstanding notice drain', () => {
    const before = assessSecurityWatch(
      base({ audit: check(299999), notices: { ...check(299999), outstanding: true } })
    );
    assert.equal(before.dueAudit, false);
    assert.equal(before.dueNoticeDrain, false);
    const due = assessSecurityWatch(
      base({ audit: check(300000), notices: { ...check(300000), outstanding: true } })
    );
    assert.equal(due.dueAudit, true);
    assert.equal(due.dueNoticeDrain, true);
  });

  it.each(['boot', 'enable'] as const)(
    'checks due sources at %s without resetting their original check times',
    (invocation) => {
      const facts = base({
        invocation,
        inventory: check(86400000),
        audit: check(300000),
        feeds: [feed('kev', 'signal', 3600000)],
      });
      const before = structuredClone(facts);
      const result = assessSecurityWatch(facts);
      assert.equal(result.dueInventory, true);
      assert.equal(result.dueAudit, true);
      assert.deepEqual(dueFeeds(result), ['signal']);
      assert.deepEqual(facts, before);
    }
  );

  it.each<[WatchInput['invocation'], boolean]>([
    ['boot', true],
    ['enable', false],
  ])(
    'does not force fresh feeds early at %s; boot alone forces an outstanding drain',
    (invocation, drain) => {
      const report = assessSecurityWatch(base({ invocation, feeds: [feed('kev', 'fresh', 1)] }));
      assert.equal(report.dueInventory, false);
      assert.deepEqual(dueFeeds(report), []);
      assert.equal(report.dueNoticeDrain, drain);
    }
  );

  it.each<[WatchInput['state'], boolean, boolean]>([
    ['on', true, true],
    ['stopping', true, true],
    ['off', true, false],
    ['on', false, false],
    ['stopping', false, false],
    ['off', false, false],
  ])(
    'separates detection eligibility from drain for state %s and current delegation %s',
    (state, delegationCurrent, detect) => {
      const report = assessSecurityWatch(
        base({
          state,
          delegationCurrent,
          inventory: check(86400000),
          audit: check(300000),
          feeds: [feed('rss', 'signal', 3600000)],
          notices: { ...check(300000), outstanding: true },
        })
      );
      assert.equal(report.dueInventory, detect);
      assert.equal(report.dueAudit, detect);
      assert.deepEqual(dueFeeds(report), detect ? ['signal'] : []);
      assert.equal(
        report.dueNoticeDrain,
        true,
        'drain evaluation is not a grant to deliver suspended ordinary notices'
      );
    }
  );

  it.each(['boot', 'interval'] as const)(
    'does not create a notice-drain job with no outstanding recipient notices at %s',
    (invocation) => {
      const report = assessSecurityWatch(
        base({
          invocation,
          state: 'off',
          notices: { lastStartedAt: null, inFlight: false, outstanding: false },
        })
      );
      assert.equal(report.dueNoticeDrain, false);
    }
  );

  it('a slow in-flight feed cannot hide due audit, drain, inventory or another feed', () => {
    const slow = { ...feed('osv-api', 'slow', 172800000), inFlight: true };
    const report = assessSecurityWatch(
      base({
        inventory: check(86400000),
        audit: check(300000),
        feeds: [slow, feed('kev', 'healthy', 3600000)],
        notices: { ...check(300000), outstanding: true },
      })
    );
    assert.deepEqual(dueFeeds(report), ['healthy']);
    assert.equal(report.dueInventory, true);
    assert.equal(report.dueAudit, true);
    assert.equal(report.dueNoticeDrain, true);
    assert.equal(status(report, 'slow').stale, true);
  });

  it('in-flight suppression is local to its own audit, inventory or drain lane', () => {
    const first = assessSecurityWatch(
      base({
        inventory: { ...check(86400000), inFlight: true },
        audit: { ...check(300000), inFlight: true },
        notices: { ...check(300000), outstanding: true },
      })
    );
    assert.equal(first.dueInventory, false);
    assert.equal(first.dueAudit, false);
    assert.equal(first.dueNoticeDrain, true);
    const second = assessSecurityWatch(
      base({
        audit: check(300000),
        notices: { ...check(300000), outstanding: true, inFlight: true },
      })
    );
    assert.equal(second.dueAudit, true);
    assert.equal(second.dueNoticeDrain, false);
  });

  it('first evaluation checks unobserved work without inventing feeds or report timestamps', () => {
    const signal: WatchInput['feeds'][number] = {
      id: 'new-signal',
      kind: 'kev',
      lastStartedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      inFlight: false,
    };
    const report = assessSecurityWatch(
      base({
        invocation: 'boot',
        inventory: { lastStartedAt: null, inFlight: false },
        audit: { lastStartedAt: null, inFlight: false },
        feeds: [signal],
      })
    );
    assert.equal(report.dueInventory, true);
    assert.equal(report.dueAudit, true);
    assert.deepEqual(dueFeeds(report), ['new-signal']);
    assert.equal(status(report, 'new-signal').lastSuccessAt, null);
    assert.equal(status(report, 'new-signal').stale, true);
    assert.equal(status(report, 'new-signal').failed, false);
    assert.deepEqual(dueFeeds(assessSecurityWatch(base({ invocation: 'enable' }))), []);
  });

  it('a recent failure or in-flight request cannot relabel an old success as fresh', () => {
    const signal = {
      ...feed('rss', 'failed', 3600001),
      lastStartedAt: ago(1),
      lastFailureAt: ago(1),
      inFlight: true,
    };
    const report = assessSecurityWatch(
      base({ state: 'off', delegationCurrent: false, feeds: [signal] })
    );
    assert.deepEqual(status(report, 'failed'), {
      id: 'failed',
      lastSuccessAt: ago(3600001),
      lastFailureAt: ago(1),
      stale: true,
      failed: true,
    });
  });

  it('shows a later success as fresh without erasing historical failure', () => {
    const signal = { ...feed('kev', 'recovered', 1), lastFailureAt: ago(2000) };
    const report = assessSecurityWatch(base({ feeds: [signal] }));
    assert.deepEqual(status(report, 'recovered'), {
      id: 'recovered',
      lastSuccessAt: ago(1),
      lastFailureAt: ago(2000),
      stale: false,
      failed: false,
    });
  });
});
