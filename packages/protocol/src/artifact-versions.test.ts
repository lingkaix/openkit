import { describe, expect, it } from 'vitest';
import {
  ArtifactFileContentSchema,
  ArtifactMediaTypeSchema,
  ArtifactSchema,
  ArtifactVersionRecordSchema,
  ArtifactVersionSchema,
  MAX_ARTIFACT_FILE_BYTES,
} from './models/artifact.js';

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

  it('enforces version-one mutation proof and allows subsequent versions to advance digest and request id', () => {
    const importedOrigin = {
      kind: 'imported' as const,
      sourceKind: 'direct-import' as const,
      sourceId: 'req_import_1',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      actor: version.actor,
      requestId: 'req_import_1',
      recordedAt: version.recordedAt,
    };
    const importedV1 = {
      id: version.artifactId,
      workspaceId: version.workspaceId,
      threadId: null,
      turnId: null,
      kind: 'file' as const,
      title: 'Dataset',
      status: 'ready' as const,
      summary: null,
      version: 1,
      content: { format: 'file' as const, mediaType: 'application/octet-stream', byteLength: 0 },
      contentDigest: importedOrigin.sourceDigest,
      lastMutationRequestId: 'req_import_1',
      origin: importedOrigin,
      createdAt: version.recordedAt,
      updatedAt: version.recordedAt,
    };
    expect(ArtifactSchema.parse(importedV1)).toEqual(importedV1);
    expect(
      ArtifactSchema.safeParse({ ...importedV1, lastMutationRequestId: 'req_other' }).success
    ).toBe(false);
    const importedV2 = {
      ...importedV1,
      version: 2,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      lastMutationRequestId: 'req_revision_2',
    };
    expect(ArtifactSchema.parse(importedV2)).toEqual(importedV2);
  });

  it('requires ArtifactVersionRecord producing facts to match retained turn-output and imported artifacts', () => {
    const turnOutputArtifact = {
      id: version.artifactId,
      workspaceId: version.workspaceId,
      threadId: version.threadId,
      turnId: version.turnId,
      kind: 'report' as const,
      title: 'Output',
      status: 'ready' as const,
      summary: null,
      version: 1,
      content: { format: 'markdown' as const, body: '# Report' },
      contentDigest: version.contentDigest,
      lastMutationRequestId: 'req_create',
      origin: {
        kind: 'turn-output' as const,
        threadId: version.threadId,
        turnId: version.turnId,
        requestId: 'req_create',
      },
      createdAt: version.recordedAt,
      updatedAt: version.recordedAt,
    };
    const turnCommit = {
      actor: version.actor,
      threadId: version.threadId,
      turnId: version.turnId,
    };
    expect(
      ArtifactVersionRecordSchema.parse({ artifact: turnOutputArtifact, version: turnCommit })
    ).toEqual({ artifact: turnOutputArtifact, version: turnCommit });
    expect(
      ArtifactVersionRecordSchema.safeParse({
        artifact: { ...turnOutputArtifact, version: 2, lastMutationRequestId: 'req_v2' },
        version: { actor: version.actor, threadId: null, turnId: null },
      }).success
    ).toBe(false);
    for (const badCommit of [
      { ...turnCommit, threadId: null },
      { ...turnCommit, turnId: null },
      { ...turnCommit, threadId: 'th_00000000-0000-7000-8000-000000000009' },
      { ...turnCommit, turnId: 'tu_00000000-0000-7000-8000-000000000009' },
    ]) {
      expect(
        ArtifactVersionRecordSchema.safeParse({
          artifact: turnOutputArtifact,
          version: badCommit,
        }).success
      ).toBe(false);
    }

    const importedArtifact = {
      ...turnOutputArtifact,
      threadId: null,
      turnId: null,
      origin: {
        kind: 'imported' as const,
        sourceKind: 'direct-import' as const,
        sourceId: 'req_create',
        sourceDigest: version.contentDigest,
        actor: version.actor,
        requestId: 'req_create',
        recordedAt: version.recordedAt,
      },
    };
    const importedCommit = { actor: version.actor, threadId: null, turnId: null };
    expect(
      ArtifactVersionRecordSchema.parse({ artifact: importedArtifact, version: importedCommit })
    ).toEqual({ artifact: importedArtifact, version: importedCommit });
    expect(
      ArtifactVersionRecordSchema.safeParse({
        artifact: { ...importedArtifact, updatedAt: '2026-10-18T00:00:00.000Z' },
        version: importedCommit,
      }).success
    ).toBe(false);
    expect(
      ArtifactVersionRecordSchema.safeParse({
        artifact: importedArtifact,
        version: {
          ...importedCommit,
          actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000009' },
        },
      }).success
    ).toBe(false);
    expect(
      ArtifactVersionRecordSchema.safeParse({
        artifact: importedArtifact,
        version: turnCommit,
      }).success
    ).toBe(false);
  });

  it('enforces file artifact byteLength bounds', () => {
    for (const byteLength of [0, MAX_ARTIFACT_FILE_BYTES]) {
      expect(
        ArtifactFileContentSchema.parse({
          format: 'file',
          mediaType: 'application/vnd.openkit+json',
          byteLength,
        }).byteLength
      ).toBe(byteLength);
    }
    for (const byteLength of [-1, 1.5, MAX_ARTIFACT_FILE_BYTES + 1]) {
      expect(
        ArtifactFileContentSchema.safeParse({
          format: 'file',
          mediaType: 'text/plain',
          byteLength,
        }).success
      ).toBe(false);
    }
  });

  it('enforces file artifact mediaType syntax and length bounds', () => {
    expect(ArtifactMediaTypeSchema.parse('application/vnd.openkit+json')).toBe(
      'application/vnd.openkit+json'
    );
    for (const mediaType of [
      '',
      'text',
      'text/plain; charset=utf-8',
      'text/ plain',
      `application/${'a'.repeat(244)}`,
    ]) {
      expect(ArtifactMediaTypeSchema.safeParse(mediaType).success).toBe(false);
    }
  });
});
