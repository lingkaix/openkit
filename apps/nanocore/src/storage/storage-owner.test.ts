import { describe, expect, it } from 'vitest';
import {
  type StorageIntent,
  type StorageOccurrence,
  storageReceipt,
  storageRequestId,
} from './storage-owner.js';

const inbound: StorageOccurrence<'communication', 'channel.inbound'> = {
  deploymentId: 'dev',
  sourceOwner: 'communication',
  verb: 'channel.inbound',
  occurrenceKey: 'discord/message/é',
};

describe('storage request ID', () => {
  it('matches URL-namespace UUIDv5 over the UTF-8 canonical occurrence tuple', () => {
    expect(storageRequestId(inbound)).toBe('ae9812de-a416-5ec6-99bd-23acf0e6c7ee');
  });

  it('keeps semantic changes on the original ID for conflict detection', () => {
    const first: StorageIntent<'communication', 'channel.inbound', string> = {
      ...inbound,
      requestId: storageRequestId(inbound),
      target: 'first-target',
      expectedGeneration: 'first-generation',
      inputDigest: 'sha256:first',
    };
    const second = {
      ...first,
      target: 'second-target',
      expectedGeneration: 'second-generation',
      inputDigest: 'sha256:second',
    };
    expect(storageRequestId(first)).toBe(storageRequestId(second));
    expect(storageRequestId({ ...inbound, occurrenceKey: 'discord/message/other' })).not.toBe(
      storageRequestId(first)
    );
  });

  it('refuses an occurrence that has no canonical UTF-8 identity', () => {
    expect(() => storageRequestId({ ...inbound, occurrenceKey: '\ud800' })).toThrow();
  });
});

describe('storage receipt encoding', () => {
  const intent = {
    ...inbound,
    requestId: storageRequestId(inbound),
    target: 'first-target',
    expectedGeneration: 'first-generation',
    inputDigest: 'sha256:first',
  };
  const outcome = {
    disposition: 'applied',
    result: { decisionRef: 'pending:first' },
  } as const;

  it('matches the canonical UTF-8 receipt vector and ignores object member order', () => {
    const original = storageReceipt(intent, outcome);
    expect(original.receiptDigest).toBe(
      'sha256:19909137fcf6e8659f93cee2a2bd71a851927c7657e2994c32aea7cb862e93e6'
    );
    const reordered = {
      target: intent.target,
      inputDigest: intent.inputDigest,
      expectedGeneration: intent.expectedGeneration,
      requestId: intent.requestId,
      ...inbound,
    };
    expect(storageReceipt(reordered, outcome)).toStrictEqual(original);
  });

  it('binds the result and refusal to the original semantic request', () => {
    const digest = storageReceipt(intent, outcome).receiptDigest;
    for (const modified of [
      { ...intent, target: 'another-target' },
      { ...intent, expectedGeneration: null },
      { ...intent, inputDigest: 'sha256:changed' },
    ]) {
      expect(storageReceipt(modified, outcome).receiptDigest).not.toBe(digest);
    }
    expect(
      storageReceipt(intent, { disposition: 'refused', reason: 'policy' }).receiptDigest
    ).not.toBe(digest);
    expect(
      storageReceipt(intent, {
        disposition: 'applied',
        result: { decisionRef: 'pending:second' },
      }).receiptDigest
    ).not.toBe(digest);
  });

  it('rejects inconsistent identities and unsupported required data', () => {
    expect(() => storageReceipt({ ...intent, occurrenceKey: 'mismatch' }, outcome)).toThrow();
    expect(() => storageReceipt({ ...intent, expectedGeneration: undefined }, outcome)).toThrow();
  });
});
