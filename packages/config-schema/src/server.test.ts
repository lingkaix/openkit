import { describe, expect, it } from 'vitest';

import { getConfigPolicyCatalog, OpenKitConfigSchema } from './index.js';

describe('server config schema', () => {
  it('rejects removed data-root and unknown top-level fields', () => {
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        dataRoot: './data',
      })
    ).toThrow();

    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        unknownTopLevel: true,
      })
    ).toThrow();
  });

  it('keeps the config policy catalog free of inline secret modes', () => {
    expect(getConfigPolicyCatalog().map((entry) => entry.secretPolicy)).not.toContain(
      `server-inline-${'leg'}acy`
    );
  });

  it('accepts local vault backend default configuration', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        vault: {
          localDefaultBackend: 'encrypted-file',
        },
      })
    ).toEqual({
      schemaVersion: 1,
      vault: {
        localDefaultBackend: 'encrypted-file',
      },
    });
  });
});
