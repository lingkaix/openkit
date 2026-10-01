import { describe, expect, it } from 'vitest';
import { RuntimeConfigFileDeleteRequestSchema } from './runtime-config.js';

describe('Provider profile deletion command', () => {
  const command = {
    id: 'providers/exact.provider.jsonc',
    kind: 'provider',
    expectedRevision: 'exact-revision',
  };
  it('requires an existing revision, Provider kind and closed command semantics', () => {
    expect(RuntimeConfigFileDeleteRequestSchema.parse(command)).toEqual(command);
    for (const invalid of [
      { ...command, expectedRevision: undefined },
      { ...command, expectedRevision: null },
      { ...command, expectedRevision: '' },
      { ...command, kind: 'server' },
      { ...command, force: true },
    ])
      expect(RuntimeConfigFileDeleteRequestSchema.safeParse(invalid).success).toBe(false);
  });
});
