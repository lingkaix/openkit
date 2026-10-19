import { describe, expect, it } from 'vitest';
import { ArtifactVersionSchema } from './models/artifact.js';

const version = {
  artifactId: 'ar_00000000-0000-7000-8000-000000000001',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  artifactVersion: 2,
  parentVersion: 1,
  title: 'Revised output',
  summary: null,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
  requestId: 'version-commit',
  recordedAt: '2026-10-17T00:00:00.000Z',
};

describe('Artifact version lineage', () => {
  it('requires an exact predecessor and complete work lineage beyond version one', () => {
    expect(ArtifactVersionSchema.parse(version)).toEqual(version);
    for (const change of [
      { parentVersion: null },
      { parentVersion: 2 },
      { threadId: null },
      { threadId: null, turnId: null },
    ]) {
      expect(ArtifactVersionSchema.safeParse({ ...version, ...change }).success).toBe(false);
    }
    expect(
      ArtifactVersionSchema.parse({
        ...version,
        artifactVersion: 1,
        parentVersion: null,
        threadId: null,
        turnId: null,
        annotation: 'ignored descriptive addition',
      })
    ).not.toHaveProperty('annotation');
  });
});
