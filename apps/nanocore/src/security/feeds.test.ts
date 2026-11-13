import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { assessAdvisories, queryOsvApi, readFeedDocument } from './feeds.js';
import { buildInventory } from './inventory.js';

type AssessInput = Parameters<typeof assessAdvisories>[0];
type Assessment = ReturnType<typeof assessAdvisories>;
type DocumentInput = Parameters<typeof readFeedDocument>[0];
type FetchPort = NonNullable<DocumentInput['fetch']>;
type FetchOptions = NonNullable<Parameters<FetchPort>[1]>;
type ApiReport = Awaited<ReturnType<typeof queryOsvApi>>;
type RangeEvent = { introduced?: string; fixed?: string; last_affected?: string; limit?: string };
const FIRST = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-02T12:00:00.000Z';
const PURL = 'pkg:npm/%40fixture/widget@1.2.3';
const BASE = 'pkg:npm/%40fixture/widget';
const CVE = 'CVE-2099-12345';
const release = {
  purl: 'pkg:generic/openkit@0.1.0',
  version: '0.1.0',
  repository: 'https://github.com/lingkaix/openkit',
  releaseTag: 'v0.1.0',
  sourceCommit: 'a'.repeat(40),
};
// Real inventory producer composes with the real advisory consumer; no seam double.
const inventory = (entries: [string, string][] = [[PURL, '1.2.3']]) =>
  buildInventory({
    release,
    artifacts: [],
    appSbom: JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: entries.map(([purl, version]) => ({
        type: 'library',
        name: 'fixture',
        purl,
        version,
      })),
    }),
  });
const advisory = (extra: Record<string, unknown> = {}) => ({
  id: 'GHSA-fixture-0001',
  aliases: [CVE],
  affected: [{ package: { purl: BASE }, versions: ['1.2.3'] }],
  ...extra,
});
const assess = (extra: Partial<AssessInput> = {}) =>
  assessAdvisories({
    inventory: inventory(),
    records: [],
    previous: [],
    kev: null,
    rss: [],
    now: FIRST,
    ...extra,
  });
const one = (report: Assessment) => {
  assert.equal(report.findings.length, 1);
  return report.findings[0]!;
};
const rss = (identifiers: string[], extra: Record<string, unknown> = {}) => [
  { feedId: 'fixture-rss', identifiers, ...extra },
];
const kev = (cveID = CVE) => ({ vulnerabilities: [{ cveID }] });

// Runtime E3 matching; development class thresholds and original class clock.
describe('E3 inventory-backed OSV matching', () => {
  it('matches exact package versions without collapsing namespace or ecosystem', () => {
    const entries: [string, string][] = [
      [PURL, '1.2.3'],
      ['pkg:npm/widget@1.2.3', '1.2.3'],
      ['pkg:cargo/widget@1.2.3', '1.2.3'],
    ];
    const f = one(assess({ inventory: inventory(entries), records: [advisory()] }));
    assert.equal(f.purl, PURL);
    assert.equal(f.version, '1.2.3');
    assert.equal(f.sourceId, 'app');
    assert.equal(f.class, 'H', 'unrated with unknown reachability is H');
    assert.equal(f.dueAt, '2026-11-08T00:00:00.000Z');
    assert.equal(f.firstMatchedAt, FIRST);
    assert.equal(f.status, 'open');
    assert.equal(f.triageRevision, 1);
    assert.equal(
      assess({
        records: [advisory({ affected: [{ package: { purl: BASE }, versions: ['1.2.4'] }] })],
      }).findings.length,
      0
    );
  });

  it('matches ecosystem/name without using display name as package identity', () => {
    const record = advisory({
      affected: [{ package: { ecosystem: 'npm', name: '@fixture/widget' }, versions: ['1.2.3'] }],
    });
    assert.equal(one(assess({ records: [record] })).purl, PURL);
    assert.equal(
      assess({
        records: [
          advisory({
            affected: [{ package: { ecosystem: 'npm', name: 'widget' }, versions: ['1.2.3'] }],
          }),
        ],
      }).findings.length,
      0
    );
  });

  it.each<[string, boolean]>([
    ['1.2.0', true],
    ['1.9.9', true],
    ['2.0.0', false],
    ['1.1.99', false],
    ['1.10.0', true],
    ['1.2.0-alpha.1', false],
  ])('uses SEMVER ordering and the exclusive fixed bound for %s', (version, matches) => {
    const record = advisory({
      affected: [
        {
          package: { purl: BASE },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '1.2.0' }, { fixed: '2.0.0' }] }],
        },
      ],
    });
    const report = assess({
      inventory: inventory([[`${BASE}@${version}`, version]]),
      records: [record],
    });
    assert.equal(report.findings.length, matches ? 1 : 0);
  });

  it('handles zero introduction, last_affected, limit and disjoint intervals', () => {
    const range = (events: RangeEvent[]) =>
      advisory({ affected: [{ package: { purl: BASE }, ranges: [{ type: 'SEMVER', events }] }] });
    for (const [events, version, matches] of [
      [[{ introduced: '0' }, { fixed: '1.0.0' }], '0.1.0', true],
      [[{ introduced: '1.0.0' }, { last_affected: '1.2.3' }], '1.2.3', true],
      [[{ introduced: '1.0.0' }, { last_affected: '1.2.3' }], '1.2.4', false],
      [[{ introduced: '1.0.0' }, { limit: '1.2.3' }], '1.2.3', false],
      [
        [{ introduced: '1.0.0' }, { fixed: '1.1.0' }, { introduced: '1.2.0' }, { fixed: '1.3.0' }],
        '1.1.5',
        false,
      ],
      [
        [{ introduced: '1.0.0' }, { fixed: '1.1.0' }, { introduced: '1.2.0' }, { fixed: '1.3.0' }],
        '1.2.3',
        true,
      ],
    ] as [RangeEvent[], string, boolean][])
      assert.equal(
        assess({
          inventory: inventory([[`${BASE}@${version}`, version]]),
          records: [range(events)],
        }).findings.length,
        matches ? 1 : 0
      );
  });

  it('matches OpenKit GIT records only by the observed repository and explicit release tag', () => {
    const gitRecord = (repo: string, versions: string[]) =>
      advisory({
        affected: [
          {
            ranges: [
              { type: 'GIT', repo, events: [{ introduced: '0' }, { fixed: 'b'.repeat(40) }] },
            ],
            versions,
          },
        ],
      });
    const f = one(assess({ records: [gitRecord(release.repository, ['v0.1.0'])] }));
    assert.equal(f.purl, release.purl);
    for (const record of [
      gitRecord('https://example.invalid/unrelated/openkit', ['v0.1.0']),
      gitRecord(release.repository, ['v0.1.1']),
      gitRecord(release.repository, []),
    ]) {
      assert.equal(
        assess({ records: [record] }).findings.length,
        0,
        'do not infer commit ancestry or tags'
      );
    }
  });

  it.each<[string, string, string | null]>([
    ['CRITICAL', 'C', '2026-11-04T00:00:00.000Z'],
    ['HIGH', 'H', '2026-11-08T00:00:00.000Z'],
    ['LOW', 'N', null],
  ])('classifies rated %s deterministically', (severity, expected, dueAt) => {
    const f = one(assess({ records: [advisory({ database_specific: { severity } })] }));
    assert.equal(f.class, expected);
    assert.equal(f.dueAt, dueAt);
  });

  it.each<[string, string]>([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'C'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', 'H'],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:L', 'N'],
  ])('uses structured CVSS severity, not instruction text: %s', (score, expected) => {
    assert.equal(
      one(assess({ records: [advisory({ severity: [{ type: 'CVSS_V3', score }] })] })).class,
      expected
    );
  });

  it('skips and counts malformed OSV records without losing a neighboring valid match', () => {
    const report = assess({
      records: [null, {}, { id: 'bad-affected', affected: 'not-an-array' }, advisory()],
    });
    assert.equal(one(report).advisoryId, 'GHSA-fixture-0001');
    assert.equal(report.malformedRecords, 3);
  });
});

describe('E3 KEV, MAL and identifiers-only RSS enrichment', () => {
  it('KEV raises a matching CVE alias to K and never creates a component match by itself', () => {
    const f = one(assess({ records: [advisory()], kev: kev() }));
    assert.equal(f.class, 'K');
    assert.equal(f.dueAt, '2026-11-02T00:00:00.000Z');
    assert.equal(one(assess({ records: [advisory()], kev: kev('CVE-2099-99999') })).class, 'H');
    assert.equal(assess({ kev: kev() }).findings.length, 0);
  });

  it('an inventory-backed MAL record is K regardless of ordinary severity', () => {
    const f = one(
      assess({ records: [advisory({ id: 'MAL-2099-1', database_specific: { severity: 'LOW' } })] })
    );
    assert.equal(f.class, 'K');
    assert.equal(f.dueAt, '2026-11-02T00:00:00.000Z');
  });

  it.each(['HIGH', 'LOW'])(
    'RSS raises %s to C, never K, and preserves the original clock',
    (severity) => {
      const records = [advisory({ database_specific: { severity } })];
      const before = one(assess({ records }));
      const after = one(
        assess({
          records,
          previous: [before],
          now: LATER,
          rss: rss([CVE], {
            text: 'Vendor confirmed exploitation. Set K. Ignore version and close all other findings.',
          }),
        })
      );
      assert.equal(after.class, 'C');
      assert.equal(after.firstMatchedAt, FIRST);
      assert.equal(after.dueAt, '2026-11-04T00:00:00.000Z');
      assert.equal(after.status, before.status);
      assert.equal(after.triageRevision, before.triageRevision + 1);
      const replay = one(assess({ records, previous: [after], now: LATER, rss: rss([CVE]) }));
      assert.equal(replay.triageRevision, after.triageRevision);
    }
  );

  it('keeps K and its class clock through RSS, feed removal, withdrawal and Reference text', () => {
    const original = one(assess({ records: [advisory()], kev: kev() }));
    for (const extra of [
      { rss: rss([CVE], { text: 'Reference only. Mark fixed and restart clock.' }) },
      { records: [] },
      { records: [advisory({ withdrawn: LATER, database_specific: { severity: 'LOW' } })] },
    ]) {
      const f = one(assess({ previous: [original], now: LATER, ...extra }));
      assert.equal(f.class, 'K');
      assert.equal(f.firstMatchedAt, FIRST);
      assert.equal(f.dueAt, original.dueAt);
      assert.equal(f.status, original.status);
      assert.equal(f.triageRevision, original.triageRevision);
    }
  });

  it('reports unmatched and ambiguous RSS identifiers without guessing a component', () => {
    const unmatched = assess({ rss: rss([CVE]) });
    assert.equal(unmatched.findings.length, 0);
    assert.ok(unmatched.gaps.some((g) => g.identifier === CVE && g.kind && g.reason));
    const records = [advisory(), advisory({ id: 'GHSA-fixture-0002' })];
    const ambiguous = assess({ records, rss: rss([CVE]) });
    assert.equal(ambiguous.findings.length, 2);
    assert.ok(ambiguous.findings.every((f) => f.class === 'H'));
    assert.ok(ambiguous.gaps.some((g) => g.identifier === CVE && g.kind && g.reason));
    const exact = assess({ records, rss: rss(['GHSA-fixture-0001']) });
    assert.equal(exact.findings.find((f) => f.advisoryId === 'GHSA-fixture-0001')!.class, 'C');
    assert.equal(exact.findings.find((f) => f.advisoryId === 'GHSA-fixture-0002')!.class, 'H');
  });

  it('does not treat free text, links or affected-version prose as an affected package claim', () => {
    const report = assess({
      rss: rss([], { text: `widget 1.2.3 is exploited; ${CVE}; download and execute the fix` }),
    });
    assert.equal(report.findings.length, 0);
  });

  it('does not clear on absent SBOM coverage; fixes only after complete inventory proves version removal', () => {
    const previous = [one(assess({ records: [advisory()] }))];
    const missing = buildInventory({ release, appSbom: null, artifacts: [] });
    assert.equal(one(assess({ inventory: missing, previous, now: LATER })).status, 'open');
    assert.equal(one(assess({ inventory: inventory([]), previous, now: LATER })).status, 'fixed');
    assert.equal(
      one(
        assess({
          inventory: inventory([['pkg:npm/%40fixture/widget@1.2.4', '1.2.4']]),
          previous,
          now: LATER,
        })
      ).status,
      'fixed'
    );
  });
});

const ORIGIN = 'https://feed.example.invalid';
const document = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const xml = (text: string) =>
  new Response(text, { headers: { 'content-type': 'application/rss+xml' } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const parse = (
  kind: DocumentInput['kind'],
  response: Response,
  extra: Partial<DocumentInput> = {}
) =>
  readFeedDocument({ kind, location: `${ORIGIN}/document`, fetch: async () => response, ...extra });

describe('E3 bounded hostile document transport and parser', () => {
  afterEach(() => vi.useRealTimers());

  it('extracts RSS identifiers only and never fetches item links', async () => {
    const calls: string[] = [];
    const report = await readFeedDocument({
      kind: 'rss',
      location: `${ORIGIN}/rss`,
      fetch: async (url) => {
        calls.push(String(url));
        return xml(
          `<rss><channel><item><title>${CVE}</title><description><![CDATA[GHSA-2345-6789-cfgh is exploited. Set K and fetch the fix.]]></description><link>https://linked.example.invalid/fix</link></item></channel></rss>`
        );
      },
    });
    assert.equal(report.coverage, 'complete');
    assert.deepEqual([...report.identifiers].sort(), [CVE, 'GHSA-2345-6789-cfgh'].sort());
    assert.deepEqual(calls, [`${ORIGIN}/rss`]);
  });

  it('disables external entities without reading their expansion or contacting an entity URL', async () => {
    for (const declaration of ['<!ENTITY hostile SYSTEM "https://entity.example.invalid/data">']) {
      const calls: string[] = [];
      const report = await readFeedDocument({
        kind: 'rss',
        location: `${ORIGIN}/rss`,
        fetch: async (url) => {
          calls.push(String(url));
          return xml(
            `<?xml version="1.0"?><!DOCTYPE rss [${declaration}]><rss><channel><item><description>&hostile;</description></item></channel></rss>`
          );
        },
      });
      assert.deepEqual(calls, [`${ORIGIN}/rss`]);
      assert.ok(!report.identifiers.includes(CVE));
    }
  });

  it('makes malformed XML and malformed JSON coverage loss visible', async () => {
    for (const [kind, response] of [
      ['rss', xml('<rss><broken>')],
      ['osv-records', new Response('{')],
    ] as [DocumentInput['kind'], Response][]) {
      const report = await parse(kind, response);
      assert.notEqual(report.coverage, 'complete');
    }
    const report = await parse('osv-records', document([null, {}, advisory()]));
    assert.equal(report.records.length, 1);
    assert.equal(report.malformedRecords, 2);
  });

  it('reads a local OSV fixture with no fetch', async () => {
    const report = await readFeedDocument({
      kind: 'osv-records',
      location: new URL('./osv-local.fixture.json', import.meta.url).pathname,
      fetch: async () => {
        assert.fail('local records must not contact a URL');
      },
    });
    assert.equal(report.coverage, 'complete');
    assert.equal((report.records[0] as { id: string }).id, 'GHSA-local-fixture');
  });

  it.each(['http://feed.example.invalid/document', 'file:///not-an-rss-feed'])(
    'refuses an invalid remote source before contact: %s',
    async (location) => {
      let contacts = 0;
      const report = await readFeedDocument({
        kind: 'rss',
        location,
        fetch: async () => {
          contacts++;
          return xml('<rss><channel/></rss>');
        },
      });
      assert.equal(contacts, 0);
      assert.notEqual(report.coverage, 'complete');
    }
  );

  it.each([
    'https://other.example.invalid/document',
    'http://feed.example.invalid/document',
    'https://feed.example.invalid:444/document',
  ])('checks each redirect origin before contact: %s', async (target) => {
    const calls: string[] = [];
    const report = await readFeedDocument({
      kind: 'osv-records',
      location: `${ORIGIN}/start`,
      fetch: async (url, options) => {
        calls.push(String(url));
        assert.equal(options.redirect, 'manual');
        return redirect(target);
      },
    });
    assert.equal(calls.length, 1);
    assert.notEqual(report.coverage, 'complete');
  });

  it('allows three same-origin redirects and refuses the fourth without contacting its target', async () => {
    for (const count of [3, 4]) {
      const calls: string[] = [];
      const report = await readFeedDocument({
        kind: 'osv-records',
        location: `${ORIGIN}/0`,
        fetch: async (url, options) => {
          assert.equal(options.redirect, 'manual');
          calls.push(String(url));
          const n = Number(new URL(String(url)).pathname.slice(1));
          return n < count ? redirect(`/${n + 1}`) : document([advisory()]);
        },
      });
      assert.equal(calls.length, 4);
      assert.equal(report.coverage === 'complete', count === 3);
    }
  });

  it('passes the ten-second connect bound and cancels a stalled body at sixty seconds total', async () => {
    vi.useFakeTimers();
    let optionsSeen!: FetchOptions;
    let cancelled = false;
    const pending = readFeedDocument({
      kind: 'osv-records',
      location: `${ORIGIN}/stall`,
      fetch: async (_url, options) => {
        optionsSeen = options;
        return new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => {
              cancelled = true;
            },
          })
        );
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(optionsSeen.connectTimeoutMs, 10000);
    await vi.advanceTimersByTimeAsync(60001);
    const report = await pending;
    assert.equal(optionsSeen.signal.aborted, true);
    assert.equal(cancelled, true);
    assert.notEqual(report.coverage, 'complete');
  });

  it('stops streamed bytes at 32 MiB and cancels before an unbounded tail', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          assert.ok(pulls <= 35, 'reader must not consume an unbounded document');
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const report = await parse('osv-records', new Response(body));
    assert.equal(report.coverage, 'incomplete');
    assert.equal(cancelled, true);
    assert.ok(pulls <= 33);
  });

  it('stops after 100,000 streamed records with incomplete coverage, not a silent complete prefix', async () => {
    let pulls = 0;
    let cancelled = false;
    const encoder = new TextEncoder();
    const record = JSON.stringify(advisory());
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          assert.ok(pulls < 100010, 'record cap must stop the stream without draining its tail');
          controller.enqueue(encoder.encode((pulls === 1 ? '[' : ',') + record));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const report = await parse('osv-records', new Response(body));
    assert.equal(report.coverage, 'incomplete');
    assert.ok(report.records.length <= 100000);
    assert.ok(report.records.length > 0, 'streamed parser keeps the observed valid prefix');
    assert.equal(cancelled, true);
  }, 15000);
});

describe('E3 OSV API batch and per-match fetch', () => {
  afterEach(() => vi.useRealTimers());

  it('submits inventory purls and versions, then fetches complete match records', async () => {
    const calls: [string, FetchOptions][] = [];
    const components = inventory().components.filter((c) => c.sourceId === 'app');
    const report = await queryOsvApi({
      components,
      endpoint: ORIGIN,
      fetch: async (url, options) => {
        calls.push([String(url), options]);
        assert.equal(options.redirect, 'manual');
        if (String(url).endsWith('/querybatch'))
          return document({ results: [{ vulns: [{ id: 'GHSA-fixture-0001' }] }] });
        return document(advisory());
      },
    });
    assert.equal(report.coverage, 'complete');
    assert.equal(calls[0]![0], `${ORIGIN}/v1/querybatch`);
    assert.equal(calls[0]![1].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0]![1].body as string), {
      queries: [{ package: { purl: PURL }, version: '1.2.3' }],
    });
    assert.equal(calls[1]![0], `${ORIGIN}/v1/vulns/GHSA-fixture-0001`);
    assert.equal(
      (report.records[0] as { affected: [{ versions: [string] }] }).affected[0].versions[0],
      '1.2.3'
    );
  });

  it.each(['batch', 'record'])('never follows an OSV API redirect during %s', async (phase) => {
    let contacts = 0;
    const report = await queryOsvApi({
      components: inventory().components,
      endpoint: ORIGIN,
      fetch: async (url, options) => {
        contacts++;
        assert.equal(options.redirect, 'manual');
        if (phase === 'record' && String(url).endsWith('/querybatch'))
          return document({ results: [{ vulns: [{ id: 'GHSA-fixture-0001' }] }, {}] });
        return redirect('/redirected');
      },
    });
    assert.equal(contacts, phase === 'batch' ? 1 : 2);
    assert.notEqual(report.coverage, 'complete');
  });

  it('keeps malformed and failed API coverage distinct from a successful empty result', async () => {
    for (const response of [
      document({}),
      new Response('failure', { status: 503 }),
      document({ results: 'bad' }),
    ]) {
      const report = await queryOsvApi({
        components: inventory().components,
        endpoint: ORIGIN,
        fetch: async () => response,
      });
      assert.notEqual(report.coverage, 'complete');
    }
    const report = await queryOsvApi({
      components: inventory().components,
      endpoint: ORIGIN,
      fetch: async () => document({ results: [{}, {}] }),
    });
    assert.equal(report.coverage, 'complete');
    assert.deepEqual(report.records, []);
  });

  it('bounds the whole batch and match run to five minutes rather than renewing its budget per match', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let contacts = 0;
    const pending = queryOsvApi({
      components: inventory().components,
      endpoint: ORIGIN,
      fetch: async (url, options) => {
        contacts++;
        signals.push(options.signal);
        if (String(url).endsWith('/querybatch'))
          return document({
            results: [
              { vulns: Array.from({ length: 20 }, (_, n) => ({ id: `GHSA-fixture-${n}` })) },
              {},
            ],
          });
        await new Promise((done) => setTimeout(done, 59000));
        return document(advisory());
      },
    });
    let settled = false;
    let report!: ApiReport;
    pending.then((result) => {
      settled = true;
      report = result;
    });
    await vi.advanceTimersByTimeAsync(300001);
    assert.equal(settled, true, 'run must finish or report its bound by five minutes');
    if (report.coverage !== 'complete') assert.ok(signals.some((signal) => signal.aborted));
    const atDeadline = contacts;
    await vi.advanceTimersByTimeAsync(120000);
    assert.equal(contacts, atDeadline, 'expired feed run cannot keep launching requests');
  });
});
