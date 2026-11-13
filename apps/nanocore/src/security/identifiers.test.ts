import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { securityPublicationIds, securityRequestId, securityThreadId } from './identifiers.js';

type RequestInput = Parameters<typeof securityRequestId>[0];
const USER = 'usr_00000000-0000-7000-8000-000000000001';
const OTHER_USER = 'usr_00000000-0000-7000-8000-000000000002';
const FINDING: ['finding', string, string, string] = [
  'finding',
  'fixture-feed',
  'pkg:npm/%40fixture/widget@1.2.3',
  'GHSA-fixture-0001',
];
const REQUEST = '65e6aa17-401f-542f-846c-f3f385cf98ce';
const input = (extra: Partial<RequestInput> = {}): RequestInput => ({
  key: [...FINDING],
  recipientUserId: USER,
  occurrence: { kind: 'initial', n: 1 },
  ...extra,
});
// Literal vectors are independently computed from E4 JSON bytes with Python RFC UUIDv5.
// No expected value is imported from security/identifiers.ts or computed by its helpers.
describe('E4 pure deterministic owner-declared security identifiers', () => {
  it.each<[RequestInput['key'], string]>([
    [FINDING, REQUEST],
    [['event', 'aud_00000000-0000-7000-8000-000000000003'], '4bfa783b-7242-5de1-a56c-f011a26bf857'],
    [['gap', 1, 'feed-failed', 'run-fixture-1'], '2faeb390-18ab-5334-814c-dc81b10f1cfc'],
    [
      ['finding', 'fixture-é', 'pkg:npm/caf%C3%A9@1.0.0', 'GHSA-fixture-0001'],
      'd9745793-21eb-5eda-9489-658c917ebf4c',
    ],
  ])('derives the exact URL-namespace request UUID for owner key %j', (key, expected) => {
    assert.equal(securityRequestId(input({ key } as unknown as Partial<RequestInput>)), expected);
  });

  it.each<[RequestInput['occurrence']['kind'], string]>([
    ['reopen', 'bd99b78e-6775-526a-9bdc-52d9a8dc0bcc'],
    ['reminder', 'e4c09aff-89f8-5f1e-9590-ab3f7bf42e78'],
    ['renotice', 'cd93e4d9-99ac-507c-82ee-4500aa51f69a'],
    ['conflict', '18371338-3b31-5050-b58f-29a81ebfe322'],
  ])('preserves exact occurrence kind %s in the declared request name', (kind, expected) => {
    assert.equal(securityRequestId(input({ occurrence: { kind, n: 1 } })), expected);
  });

  it('uses the assigned occurrence number without allocating or advancing it', () => {
    const assigned = input({ occurrence: { kind: 'initial', n: 2 } });
    const before = structuredClone(assigned);
    assert.equal(securityRequestId(assigned), '4ba77035-1bfd-5f83-a42a-d41ddb73b258');
    assert.equal(securityRequestId(assigned), '4ba77035-1bfd-5f83-a42a-d41ddb73b258');
    assert.deepEqual(assigned, before);
  });

  it('constructs owner JSON order independently of caller object insertion order', () => {
    const reordered: RequestInput = {
      occurrence: { n: 1, kind: 'initial' },
      recipientUserId: USER,
      key: [...FINDING],
    };
    assert.equal(securityRequestId(reordered), REQUEST);
  });

  it('retains every distinguishing finding, event and gap name member', () => {
    const base = securityRequestId(input());
    for (const key of [
      ['finding', 'another-feed', FINDING[2], FINDING[3]],
      ['finding', FINDING[1], 'pkg:npm/%40fixture/widget@1.2.4', FINDING[3]],
      ['finding', FINDING[1], FINDING[2], 'GHSA-fixture-0002'],
    ])
      assert.notEqual(securityRequestId(input({ key } as unknown as Partial<RequestInput>)), base);
    assert.notEqual(securityRequestId(input({ recipientUserId: OTHER_USER })), base);
    assert.notEqual(
      securityRequestId(input({ key: ['event', 'aud-fixture-1'] })),
      securityRequestId(input({ key: ['event', 'aud-fixture-2'] }))
    );
    const gap = ['gap', 1, 'feed-failed', 'run-fixture-1'];
    for (const key of [
      ['gap', 2, 'feed-failed', 'run-fixture-1'],
      ['gap', 1, 'cursor-gap', 'run-fixture-1'],
      ['gap', 1, 'feed-failed', 'run-fixture-2'],
    ]) {
      assert.notEqual(
        securityRequestId(input({ key } as unknown as Partial<RequestInput>)),
        securityRequestId(input({ key: gap as RequestInput['key'] }))
      );
    }
  });

  it('preserves opaque text without Unicode normalization, trimming or case folding', () => {
    const key = ['finding', 'fixture-é', FINDING[2], FINDING[3]];
    const base = securityRequestId(input({ key } as unknown as Partial<RequestInput>));
    for (const feedId of ['fixture-e\u0301', 'FIXTURE-é', ' fixture-é']) {
      assert.notEqual(
        securityRequestId(input({ key: ['finding', feedId, FINDING[2], FINDING[3]] })),
        base
      );
    }
  });

  it.each<[string, number, string]>([
    [USER, 1, 'th_38908ae2-a852-5184-85da-1c3317f16356'],
    [USER, 2, 'th_15e98430-89ae-5a3c-a59f-3fa5e11f8383'],
    [OTHER_USER, 1, 'th_537ddf31-a96d-58b2-b19d-b90896c40459'],
  ])(
    'uses the shared entity owner for recipient %s Thread generation %s',
    (recipient, generation, expected) => {
      assert.equal(securityThreadId(recipient, generation), expected);
    }
  );

  it('derives both Turn roles and all three Item roles from their exact declared tuples', () => {
    const expected = {
      raiseTurnId: 'tu_1eb3941e-7f5f-5cb1-844d-1645b7289b4c',
      statusTurnId: 'tu_83f70cb9-af98-579e-a28a-173e03188f65',
      reportItemId: 'it_1304bd77-0fa2-58e2-9662-5192973a18ae',
      requestItemId: 'it_20349998-ddab-52d5-b9dd-4b6bed4ca2b0',
      statusItemId: 'it_aac4d086-eff0-59d3-9329-b0eac8a44500',
    };
    assert.deepEqual(securityPublicationIds(REQUEST), expected);
    assert.deepEqual(securityPublicationIds(REQUEST), expected);
    const next = securityPublicationIds('4ba77035-1bfd-5f83-a42a-d41ddb73b258');
    for (const field of Object.keys(expected) as (keyof typeof expected)[])
      assert.notEqual(next[field], expected[field]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid assigned occurrence/generation %s rather than inventing one',
    (n) => {
      assert.throws(() =>
        securityRequestId(
          input({ occurrence: { kind: 'initial', n } } as unknown as Partial<RequestInput>)
        )
      );
      assert.throws(() =>
        securityRequestId(input({ key: ['gap', n as number, 'feed-failed', 'run-fixture-1'] }))
      );
      assert.throws(() => securityThreadId(USER, n as number));
    }
  );

  it('refuses unsupported occurrence/key discriminants and malformed tuple shapes', () => {
    assert.throws(() =>
      securityRequestId(
        input({ occurrence: { kind: 'repeat' as RequestInput['occurrence']['kind'], n: 1 } })
      )
    );
    for (const key of [
      ['unknown', 'x'],
      ['event'],
      ['event', 'a', 'b'],
      ['finding', 'feed', 'purl'],
      ['gap', 1, 'feed-failed'],
    ]) {
      assert.throws(() => securityRequestId(input({ key } as unknown as Partial<RequestInput>)));
    }
  });
});
