import type { StorageAccess, StorageResult, StorageService } from '@openkit/storage';
import { STORAGE_LIMITS } from '@openkit/storage';
import type { SourcePointer } from './source-pointers.js';

/** Current trusted native admission is evaluated for every Storage request, never retained as a grant. */
export interface SourceByteAccess {
  readonly storage: StorageService;
  readonly admit: () => StorageAccess | null;
}

/** Reads one bounded exact raw range through the shared backend; a pointer never grants its own access. */
export async function readSourceByteRange(
  input: SourceByteAccess & {
    readonly pointer: SourcePointer;
    readonly offset: number;
    readonly length: number;
  }
): Promise<StorageResult<Uint8Array>> {
  if (input.pointer.fields.contentRef.availability !== 'available')
    return { status: 'unavailable', reason: 'missing', reference: input.pointer.fields.contentRef };
  const access = input.admit();
  if (!access) return { status: 'denied' };
  const result = await input.storage.read({
    access,
    content: {
      reference: input.pointer.fields.contentRef,
      byteLength: input.pointer.fields.byteLength,
      mediaType: input.pointer.fields.mediaType,
    },
    offset: input.offset,
    length: input.length,
  });
  if (result.status !== 'ok') return result;
  if (!input.admit()) return { status: 'denied' };
  return { status: 'ok', value: Buffer.from(result.value.data, 'base64') };
}

/** Existing text tools admit only bounded exact UTF-8; larger or binary originals remain byte-readable. */
export async function readSourceText(
  input: SourceByteAccess & {
    readonly pointer: SourcePointer;
  }
): Promise<StorageResult<string>> {
  if (input.pointer.fields.byteLength > 2 * 1024 * 1024) return { status: 'resource-limited' };
  const chunks: Uint8Array[] = [];
  // Storage verifies the whole content identity even for a zero-length original.
  let offset = 0;
  do {
    const result = await readSourceByteRange({
      ...input,
      offset,
      length: Math.min(STORAGE_LIMITS.chunkBytes, input.pointer.fields.byteLength - offset),
    });
    if (result.status !== 'ok') return result;
    chunks.push(result.value);
    offset += result.value.byteLength;
    if (offset < input.pointer.fields.byteLength && result.value.byteLength === 0)
      return {
        status: 'unavailable',
        reason: 'changed',
        reference: input.pointer.fields.contentRef,
      };
  } while (offset < input.pointer.fields.byteLength);
  try {
    return {
      status: 'ok',
      value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks)
      ),
    };
  } catch {
    return {
      status: 'unavailable',
      reason: 'unsupported',
      reference: input.pointer.fields.contentRef,
    };
  }
}
