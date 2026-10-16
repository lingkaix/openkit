import { describe, expect, it } from 'vitest';
import { OpenKitConfigSchema } from './server.js';

describe('Discord startup configuration', () => {
  const discord = { applicationId: '100000000000000001', publicKey: 'ab'.repeat(32) };

  it('retains the public Discord application identity without credential material', () => {
    expect(OpenKitConfigSchema.parse({ channels: { discord } })).toEqual({ channels: { discord } });
  });

  it('fails closed on malformed keys and unsupported channel authority', () => {
    expect(
      OpenKitConfigSchema.safeParse({ channels: { discord: { ...discord, publicKey: 'bad' } } })
        .success
    ).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({ channels: { discord: { ...discord, futureGrant: true } } })
        .success
    ).toBe(false);
    expect(OpenKitConfigSchema.safeParse({ channels: { slack: {} } }).success).toBe(false);
  });
});
