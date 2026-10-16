import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { fromBufferPromise } from 'yauzl';
import { SkillSourceInputError, validateSkillSourceSubpath } from './skill-source.js';

const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_REGULAR_FILES = 1_000;
const MAX_ARCHIVE_ENTRIES = 10_000;

/** Bounded original archive bytes, staged without extraction or filesystem authority. */
export interface StagedSkillArchiveEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly executable: boolean;
  readonly content: Buffer;
}

/** Reads only Skill-supported archive forms. The acquisition owner converts all errors to safe errors. */
export async function readSkillArchive(
  bytes: Buffer,
  format: 'zip' | 'tar' | 'gzip'
): Promise<readonly StagedSkillArchiveEntry[]> {
  const entries: StagedSkillArchiveEntry[] = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  let regularFiles = 0;
  const reserve = (name: string, kind: 'file' | 'directory', size: number) => {
    const path = kind === 'directory' && name.endsWith('/') ? name.slice(0, -1) : name;
    validateSkillSourceSubpath(path);
    if (/^[a-z]:/iu.test(path) || paths.has(path) || paths.size >= MAX_ARCHIVE_ENTRIES)
      throw new SkillSourceInputError();
    if (!Number.isSafeInteger(size) || size < 0 || (kind === 'directory' && size !== 0))
      throw new SkillSourceInputError();
    paths.add(path);
    if (kind === 'file') {
      regularFiles += 1;
      expandedBytes += size;
      if (regularFiles > MAX_REGULAR_FILES || expandedBytes > MAX_EXPANDED_BYTES)
        throw new SkillSourceInputError();
    }
    return path;
  };
  const readContent = async (stream: AsyncIterable<Uint8Array>, expected: number) => {
    const chunks: Buffer[] = [];
    let actual = 0;
    for await (const chunk of stream) {
      actual += chunk.byteLength;
      if (actual > expected) throw new SkillSourceInputError();
      chunks.push(Buffer.from(chunk));
    }
    if (actual !== expected) throw new SkillSourceInputError();
    return Buffer.concat(chunks, actual);
  };

  if (format === 'zip') {
    const archive = await fromBufferPromise(bytes, {
      strictFileNames: true,
      decodeStrings: true,
      validateEntrySizes: true,
    });
    try {
      if (archive.entryCount > MAX_ARCHIVE_ENTRIES) throw new SkillSourceInputError();
      for await (const entry of archive.eachEntry()) {
        // ZIP supports CP437 names too. UTF-8 declarations must decode without replacement.
        if (entry.generalPurposeBitFlag & 0x800)
          new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw);
        for (const field of entry.extraFields) {
          if (field.id === 0x7075 && field.data.length >= 5)
            new TextDecoder('utf-8', { fatal: true }).decode(field.data.subarray(5));
        }
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & 0xf000;
        const directory =
          entry.fileName.endsWith('/') ||
          type === 0x4000 ||
          (entry.externalFileAttributes & 0x10) !== 0;
        if (type !== 0 && type !== 0x4000 && type !== 0x8000) throw new SkillSourceInputError();
        if (directory && type === 0x8000) throw new SkillSourceInputError();
        const kind = directory ? 'directory' : 'file';
        const path = reserve(entry.fileName, kind, entry.uncompressedSize);
        const stream = await archive.openReadStreamPromise(entry);
        const content = await readContent(stream, entry.uncompressedSize);
        if (crc32(content) !== entry.crc32) throw new SkillSourceInputError();
        entries.push({
          path,
          kind,
          executable: !directory && (mode & 0o111) !== 0,
          content,
        });
      }
    } finally {
      archive.close();
    }
    return entries;
  }

  // Latin1 preserves the base/GNU header's original filename bytes for strict UTF-8 decoding.
  const options: Parameters<typeof extract>[0] & { filenameEncoding: string } = {
    filenameEncoding: 'latin1',
  };
  const archive = extract(options);
  let inflatedBytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      inflatedBytes += chunk.byteLength;
      // Includes TAR framing and extended headers, bounding metadata-only compressed archives too.
      callback(inflatedBytes > MAX_EXPANDED_BYTES ? new SkillSourceInputError() : null, chunk);
    },
  });
  const source = Readable.from([bytes]);
  const feeding =
    format === 'gzip'
      ? pipeline(source, createGunzip(), bounded, archive)
      : pipeline(source, bounded, archive);
  // Consume concurrently with the pipeline; retain its failure until both sides are settled.
  void feeding.catch(() => {});
  try {
    for await (const stream of archive) {
      const { header } = stream;
      if (header.type !== 'file' && header.type !== 'directory') throw new SkillSourceInputError();
      if (header.linkname) throw new SkillSourceInputError();
      // tar-stream does not reconstruct sparse payloads; packed extents are not original file bytes.
      if (
        header.pax &&
        typeof header.pax === 'object' &&
        Object.keys(header.pax).some(
          (key) => key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize'
        )
      )
        throw new SkillSourceInputError();
      const paxPath =
        header.pax && typeof header.pax === 'object' && 'path' in header.pax
          ? header.pax.path
          : undefined;
      if (paxPath !== undefined && typeof paxPath !== 'string') throw new SkillSourceInputError();
      // tar-stream decodes PAX values internally. Refuse its ambiguous replacement result.
      if (paxPath?.includes('\uFFFD')) throw new SkillSourceInputError();
      const name =
        paxPath ??
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.from(header.name, 'latin1')
        );
      const kind = header.type === 'directory' ? 'directory' : 'file';
      const path = reserve(name, kind, header.size ?? 0);
      entries.push({
        path,
        kind,
        executable: kind === 'file' && ((header.mode ?? 0) & 0o111) !== 0,
        content: await readContent(stream, header.size ?? 0),
      });
    }
    await feeding;
    return entries;
  } catch (error) {
    archive.destroy(new SkillSourceInputError());
    await feeding.catch(() => {});
    throw error;
  }
}
