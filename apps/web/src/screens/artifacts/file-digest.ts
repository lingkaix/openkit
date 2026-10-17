import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Hashes exact file bytes in bounded slices without decoding or allocating a whole-file ArrayBuffer. */
export async function sha256ArtifactFile(file: Blob): Promise<string> {
  const hash = sha256.create();
  const chunkBytes = 65_536;
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const end = Math.min(file.size, offset + chunkBytes);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (bytes.byteLength !== end - offset)
        throw new Error('The selected file could not be read.');
      hash.update(bytes);
      if ((offset + chunkBytes) % (4 * 1024 * 1024) === 0) {
        // Yield to browser events during a large-file integrity pass.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return `sha256:${bytesToHex(hash.digest())}`;
  } finally {
    hash.destroy();
  }
}
