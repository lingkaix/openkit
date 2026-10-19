import { constants, createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract, pack } from 'tar-stream';
import type { FileStorageAdmission } from '../artifacts/file-admission.js';
import { MAX_ARTIFACT_FILE_BYTES } from '../artifacts/file-admission.js';
import type { KnowledgePackageLimits } from './format.js';
import { isKnowledgePackagePath, type KnowledgePackageManifest } from './manifest.js';

/** One bounded uncompressed carrier; the directory manifest remains its sole retained format. */
export const KNOWLEDGE_PACKAGE_MEDIA_TYPE = 'application/x-tar';
/** Includes authored content, originals, manifest and physical directory entries. */
export const KNOWLEDGE_PACKAGE_LIMITS: KnowledgePackageLimits = {
  maxEntries: 10_000,
  maxBytes: 8_589_934_592,
};

/** Uses the existing boot-cleaned archive request namespace; staging is never content authority. */
export async function createKnowledgePackageStaging(dataRoot: string) {
  const parent = join(dataRoot, 'server', 'files', 'workspace-archive-requests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'knowledge-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** Extracts regular files into request-private staging before any native destination is touched. */
export async function stageKnowledgePackage(
  request: Request,
  directory: string,
  admission: FileStorageAdmission
): Promise<void> {
  if (
    request.headers.get('content-type')?.split(';')[0] !== KNOWLEDGE_PACKAGE_MEDIA_TYPE ||
    !request.body
  )
    throw new Error('A streamed Knowledge package is required.');
  const archive = extract();
  const paths = new Set<string>();
  let bytes = 0;
  let framing = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      framing += chunk.byteLength;
      callback(
        framing > KNOWLEDGE_PACKAGE_LIMITS.maxBytes + 16_777_216
          ? new Error('Knowledge package stream exceeds its limit.')
          : null,
        chunk
      );
    },
  });
  const feeding = pipeline(
    Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>),
    bounded,
    archive
  );
  void feeding.catch(() => {});
  try {
    for await (const stream of archive) {
      const { header } = stream;
      const directoryEntry = header.type === 'directory';
      const path =
        directoryEntry && header.name.endsWith('/') ? header.name.slice(0, -1) : header.name;
      const size = header.size ?? 0;
      const key = path.toLowerCase();
      bytes += size;
      if (
        (header.type !== 'file' && !directoryEntry) ||
        header.linkname ||
        (header.pax &&
          Object.keys(header.pax).some(
            (name) => name.startsWith('GNU.sparse.') || name === 'SCHILY.realsize'
          )) ||
        !(directoryEntry
          ? isKnowledgePackagePath(`${path}/member.md`)
          : path === 'manifest.json' || isKnowledgePackagePath(path)) ||
        paths.has(key) ||
        paths.size >= KNOWLEDGE_PACKAGE_LIMITS.maxEntries ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_ARTIFACT_FILE_BYTES ||
        (directoryEntry && size !== 0) ||
        bytes > KNOWLEDGE_PACKAGE_LIMITS.maxBytes
      )
        throw new Error('Invalid Knowledge package archive member.');
      paths.add(key);
      const reservation = admission.reserve({
        stagingBytes: BigInt(size),
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: 65_536n,
      });
      try {
        const target = join(directory, path);
        await mkdir(directoryEntry ? target : dirname(target), { recursive: true, mode: 0o700 });
        if (directoryEntry) {
          for await (const _chunk of stream) throw new Error('Package directory has bytes.');
        } else {
          const file = await open(
            target,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600
          );
          let written = 0;
          try {
            for await (const chunk of stream) {
              if (!(chunk instanceof Uint8Array)) throw new Error('Invalid package byte chunk.');
              written += chunk.byteLength;
              if (written > size) throw new Error('Package member exceeds its declared size.');
              reservation.assertAvailable();
              await file.writeFile(chunk);
              reservation.recordWritten(chunk.byteLength);
            }
            if (written !== size) throw new Error('Package member is truncated.');
          } finally {
            await file.close();
          }
        }
      } finally {
        reservation.release();
      }
    }
    await feeding;
  } catch (error) {
    archive.destroy(error as Error);
    await feeding.catch(() => {});
    throw error;
  }
}

/** Packs the verified private tree with bounded reads; response cancellation closes the producer. */
export function knowledgePackageArchive(
  directory: string,
  manifest: KnowledgePackageManifest
): Readable {
  const archive = pack();
  const produce = async () => {
    for (const path of ['manifest.json', ...manifest.contentInventory.map((entry) => entry.path)]) {
      const { size } = await stat(join(directory, path));
      if (archive.destroyed) return;
      const file = createReadStream(join(directory, path), { highWaterMark: 65_536 });
      try {
        await pipeline(file, archive.entry({ name: path, size, mode: 0o600, mtime: new Date(0) }));
      } finally {
        file.destroy();
      }
    }
    archive.finalize();
  };
  void produce().catch((error) => archive.destroy(error));
  const chunks = async function* () {
    // Tar headers and padding are small fragments. Bound disclosure checks to byte chunks,
    // not framing fragments, without increasing the existing 64 KiB disclosure window.
    let buffer = Buffer.allocUnsafe(65_536);
    let length = 0;
    try {
      for await (const chunk of archive) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid package byte chunk.');
        let offset = 0;
        while (offset < chunk.byteLength) {
          const copied = Math.min(buffer.byteLength - length, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + copied), length);
          length += copied;
          offset += copied;
          if (length === buffer.byteLength) {
            yield buffer;
            buffer = Buffer.allocUnsafe(65_536);
            length = 0;
          }
        }
      }
      if (length > 0) yield buffer.subarray(0, length);
    } finally {
      archive.destroy();
    }
  };
  const result = Readable.from(chunks(), { objectMode: false, highWaterMark: 65_536 });
  // Cancellation can precede the generator's first read, before its finally block exists.
  result.once('close', () => archive.destroy());
  return result;
}
