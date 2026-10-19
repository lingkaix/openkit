import { RETAINED_FORMAT_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { OpenKitConfigSchema } from './server.js';

describe('Discord startup configuration', () => {
  const server = { publicBaseUrl: 'https://openkit.invalid' };
  const discord = { applicationId: '100000000000000001', publicKey: 'ab'.repeat(32) };

  it('retains the public Discord application identity without credential material', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        channels: { discord },
        server,
      })
    ).toEqual({
      schemaVersion: RETAINED_FORMAT_VERSION,
      channels: { discord },
      server,
    });
  });

  it('requires a trusted public HTTPS App origin for channel link-back', () => {
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        channels: { discord },
      }).success
    ).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        channels: { discord },
        server: { publicBaseUrl: 'http://openkit.invalid' },
      }).success
    ).toBe(false);
  });

  it('fails closed on malformed keys and unsupported channel authority', () => {
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        channels: { discord: { ...discord, publicKey: 'bad' } },
        server,
      }).success
    ).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        channels: { discord: { ...discord, futureGrant: true } },
        server,
      }).success
    ).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        channels: { slack: {} },
        server,
      }).success
    ).toBe(false);
  });
});
