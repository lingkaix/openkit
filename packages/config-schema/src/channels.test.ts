import { describe, expect, it } from 'vitest';
import { OpenKitConfigSchema } from './server.js';

describe('Discord startup configuration', () => {
  const server = { publicBaseUrl: 'https://openkit.invalid' };
  const discord = { applicationId: '100000000000000001', publicKey: 'ab'.repeat(32) };

  it('retains the public Discord application identity without credential material', () => {
    expect(OpenKitConfigSchema.parse({ channels: { discord }, server })).toEqual({
      channels: { discord },
      server,
    });
  });

  it('requires a trusted public HTTPS App origin for channel link-back', () => {
    expect(OpenKitConfigSchema.safeParse({ channels: { discord } }).success).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({
        channels: { discord },
        server: { publicBaseUrl: 'http://openkit.invalid' },
      }).success
    ).toBe(false);
  });

  it('fails closed on malformed keys and unsupported channel authority', () => {
    expect(
      OpenKitConfigSchema.safeParse({
        channels: { discord: { ...discord, publicKey: 'bad' } },
        server,
      }).success
    ).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({
        channels: { discord: { ...discord, futureGrant: true } },
        server,
      }).success
    ).toBe(false);
    expect(OpenKitConfigSchema.safeParse({ channels: { slack: {} }, server }).success).toBe(false);
  });
});
