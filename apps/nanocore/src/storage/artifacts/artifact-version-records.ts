import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ArtifactVersionRecord,
  ArtifactVersionRecordSchema,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import {
  ActorRefReaderSchema,
  ArtifactReaderSchema,
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  measureCanonicalFile,
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
  const raw = readRetainedV1(JSON.parse(readCanonicalTextFile(path)), (record) => record) as {
    artifact?: { content?: { format?: unknown } };
  };
  const payload =
    raw?.artifact?.content?.format === 'file'
      ? null
      : readCanonicalFile(join(dirname(path), 'payload'));
  const record = parseArtifactVersionDescriptor(raw, payload);
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
  }
  return record;
}

/** Parses the shared physical descriptor against its exact inline bytes; file callers verify original bytes separately. */
export function parseArtifactVersionDescriptor(
  value: unknown,
  payload: Uint8Array | null
): ArtifactVersionRecord {
  const raw = readRetainedV1(value, (record) => record) as {
    artifact?: Record<string, unknown> & {
      content?: Record<string, unknown>;
    };
    version?: Record<string, unknown>;
  };
  const content = raw.artifact?.content;
  if (!content || typeof content !== 'object' || Object.hasOwn(content, 'body'))
    throw new Error('The Artifact version descriptor must not embed original bytes.');
  if (content.format !== 'file' && payload === null)
    throw new Error('The retained Artifact original is unavailable.');
  const record = ArtifactVersionRecordSchema.parse({
    ...raw,
    version: { ...raw.version, actor: ActorRefReaderSchema.parse(raw.version?.actor) },
    artifact: ArtifactReaderSchema.parse({
      ...raw.artifact,
      content:
        content.format === 'file'
          ? content
          : {
              ...content,
              body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload!),
            },
    }),
  });
  if (
    record.artifact.content.format !== 'file' &&
    `sha256:${createHash('sha256').update(payload!).digest('hex')}` !==
      record.artifact.contentDigest
  )
    throw new Error('The retained Artifact original failed integrity verification.');
  return record;
}

/** Writes exact content and its real descriptor inside an already private version directory. */
export function stageArtifactVersionRecord(
  versionRoot: string,
  input: ArtifactVersionRecord,
  payloadPath?: string
): void {
  const record = ArtifactVersionRecordSchema.parse(input);
  const { artifact } = record;
  if (artifact.content.format === 'file' && !payloadPath)
    throw new Error('Artifact file publication requires its admitted original.');
  if (artifact.content.format !== 'file' && payloadPath)
    throw new Error('Inline Artifact publication cannot replace its admitted content.');
  ensureCanonicalDirectory(versionRoot);
  const payload = join(versionRoot, 'payload');
  if (payloadPath) publishCanonicalPath(payloadPath, payload);
  else if (artifact.content.format !== 'file') writeFileAtomic(payload, artifact.content.body);
  const measured = measureCanonicalFile(payload);
  if (
    measured.contentDigest !== artifact.contentDigest ||
    (artifact.content.format === 'file' && measured.byteLength !== artifact.content.byteLength)
  )
    throw new Error('The retained Artifact original failed integrity verification.');
  const descriptor = writeRetainedV1({
    ...record,
    artifact: {
      ...artifact,
      content:
        artifact.content.format === 'file' ? artifact.content : { format: artifact.content.format },
    },
  });
  writeFileAtomic(join(versionRoot, 'version-record.json'), `${JSON.stringify(descriptor)}\n`);
}

/** Publishes one immutable later version, with its original and metadata in one staged directory. */
export function publishArtifactVersionRecord(input: {
  readonly workspaceRoot: string;
  readonly record: ArtifactVersionRecord;
  readonly payloadPath?: string;
}): void {
  const record = ArtifactVersionRecordSchema.parse(input.record);
  const path = artifactVersionRecordPath(
    input.workspaceRoot,
    record.artifact.id,
    record.artifact.version
  );
  if (existsSync(dirname(path))) throw new Error('The immutable Artifact version already exists.');
  const stagingRoot = join(dirname(input.workspaceRoot), '.staging');
  ensureCanonicalDirectory(stagingRoot);
  const stage = mkdtempSync(join(stagingRoot, 'artifact-version-'));
  try {
    stageArtifactVersionRecord(stage, record, input.payloadPath);
    ensureCanonicalDirectory(dirname(dirname(path)));
    publishCanonicalPath(stage, dirname(path));
  } finally {
    rmSync(stage, { recursive: true, force: true });
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
