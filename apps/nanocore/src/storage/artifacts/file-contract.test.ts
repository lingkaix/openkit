import { ArtifactContentSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

describe('exact Artifact file representation', () => {
  it('represents an empty arbitrary-byte original without a text body', () => {
    expect(
      ArtifactContentSchema.safeParse({
        format: 'file',
        mediaType: 'application/octet-stream',
        byteLength: 0,
      }).success
    ).toBe(true);
  });
});
