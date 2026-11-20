import { describe, expect, it } from 'vitest';
import { type StorageIntent, type StorageOccurrence, storageRequestId } from './storage-owner.js';

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
