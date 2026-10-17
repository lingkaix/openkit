import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ArtifactVersionRecord, ArtifactVersionRecordSchema } from '@openkit/protocol';
import {
  ActorRefReaderSchema,
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  publishCanonicalPath,
  readCanonicalFile,
  readCanonicalTextFile,
  writeFileAtomic,
} from '../workspace-file-records.js';
import { artifactFilePayloadPath, verifyArtifactFilePayload } from './file-records.js';

/** Resolves the canonical immutable record beside its exact original payload. */
export function artifactVersionRecordPath(
  workspaceRoot: string,
  artifactId: string,
  version: number
): string {
  return join(
    dirname(artifactFilePayloadPath(workspaceRoot, artifactId, version)),
    'version-record.json'
  );
}

/** Reads only the selected retained record; no current-head or synthetic-history fallback exists. */
export function readArtifactVersionRecord(
  workspaceRoot: string,
  artifactId: string,
  version: number
): ArtifactVersionRecord {
  const path = artifactVersionRecordPath(workspaceRoot, artifactId, version);
  let parent = dirname(path);
  for (let level = 0; level < 5; level += 1) {
    assertCanonicalDirectory(parent);
    parent = dirname(parent);
  }
  const raw = JSON.parse(readCanonicalTextFile(path));
  if (raw?.formatVersion !== 1)
    throw new Error('The Artifact version record format is unsupported.');
  const content = raw?.artifact?.content;
  if (!content || typeof content !== 'object' || Object.hasOwn(content, 'body'))
    throw new Error('The Artifact version descriptor must not embed original bytes.');
  const payload =
    content.format === 'file' ? null : readCanonicalFile(join(dirname(path), 'payload'));
  const origin = raw.artifact.origin;
  const normalizedOrigin =
    origin?.kind === 'imported'
      ? {
          kind: origin.kind,
          sourceKind: origin.sourceKind,
          sourceId: origin.sourceId,
          sourceDigest: origin.sourceDigest,
          actor: ActorRefReaderSchema.parse(origin.actor),
          requestId: origin.requestId,
          recordedAt: origin.recordedAt,
        }
      : origin;
  const record = ArtifactVersionRecordSchema.parse({
    ...raw,
    version: { ...raw.version, actor: ActorRefReaderSchema.parse(raw.version?.actor) },
    artifact: {
      ...raw.artifact,
      origin: normalizedOrigin,
      content:
        content.format === 'file'
          ? content
          : {
              ...content,
              body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload!),
            },
    },
  });
  if (record.artifact.id !== artifactId || record.artifact.version !== version)
    throw new Error('The retained Artifact version identity is contradictory.');
  if (record.artifact.content.format === 'file') {
    verifyArtifactFilePayload({
      workspaceRoot,
      artifactId,
      version,
      byteLength: record.artifact.content.byteLength,
      contentDigest: record.artifact.contentDigest,
    });
  } else if (
    `sha256:${createHash('sha256').update(payload!).digest('hex')}` !==
    record.artifact.contentDigest
  )
    throw new Error('The retained Artifact original failed integrity verification.');
  return record;
}

/** Publishes one immutable version, staging streamed originals and metadata together when supplied. */
export function publishArtifactVersionRecord(input: {
  readonly workspaceRoot: string;
  readonly record: ArtifactVersionRecord;
  readonly payloadPath?: string;
}): void {
  const record = ArtifactVersionRecordSchema.parse(input.record);
  const { artifact } = record;
  const path = artifactVersionRecordPath(input.workspaceRoot, artifact.id, artifact.version);
  if (existsSync(path)) throw new Error('The immutable Artifact version already exists.');
  const descriptor = {
    formatVersion: 1,
    ...record,
    artifact: {
      ...artifact,
      content:
        artifact.content.format === 'file' ? artifact.content : { format: artifact.content.format },
    },
  };
  if (input.payloadPath || artifact.content.format !== 'file') {
    const stagingRoot = join(dirname(input.workspaceRoot), '.staging');
    ensureCanonicalDirectory(stagingRoot);
    const stage = mkdtempSync(join(stagingRoot, 'artifact-version-'));
    try {
      if (input.payloadPath) publishCanonicalPath(input.payloadPath, join(stage, 'payload'));
      else if (artifact.content.format !== 'file')
        writeFileAtomic(join(stage, 'payload'), artifact.content.body);
      writeFileAtomic(join(stage, 'version-record.json'), `${JSON.stringify(descriptor)}\n`);
      ensureCanonicalDirectory(dirname(dirname(path)));
      publishCanonicalPath(stage, dirname(path));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } else {
    if (artifact.content.format === 'file')
      verifyArtifactFilePayload({
        workspaceRoot: input.workspaceRoot,
        artifactId: artifact.id,
        version: artifact.version,
        byteLength: artifact.content.byteLength,
        contentDigest: artifact.contentDigest,
      });
    writeFileAtomic(path, `${JSON.stringify(descriptor)}\n`);
  }
}

/** Removes only an unacknowledged newly published version during handled local compensation. */
export function rollbackArtifactVersionRecord(
  workspaceRoot: string,
  artifactId: string,
  version: number
): void {
  rmSync(dirname(artifactVersionRecordPath(workspaceRoot, artifactId, version)), {
    recursive: true,
    force: true,
  });
}
