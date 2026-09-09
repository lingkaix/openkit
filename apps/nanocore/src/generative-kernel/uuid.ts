import { createHash } from 'node:crypto';

/** RFC 4122 URL namespace UUID bytes. */
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

/**
 * Computes a RFC 4122 UUID v5 over one name and namespace.
 *
 * @param name Name bytes interpreted as UTF-8.
 * @param namespace Namespace UUID bytes, defaulting to the URL namespace.
 * @returns Canonical lowercase UUID string.
 */
export function uuidv5(name: string, namespace: Buffer = URL_NAMESPACE): string {
  const hash = createHash('sha1').update(namespace).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Parses one canonical UUID into 16 namespace bytes.
 *
 * @param value Canonical UUID string.
 * @returns Namespace bytes for a subsequent UUID v5.
 */
export function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

/**
 * Allocates the Kernel app identity for one create request.
 *
 * @param workspaceId Owning Workspace id.
 * @param requestId Caller request id.
 * @returns Deterministic app UUID.
 */
export function allocateAppId(workspaceId: string, requestId: string): string {
  return uuidv5(`openkit:kernel.apps.create:${workspaceId}:${requestId}`);
}

/**
 * Allocates one Kernel record identity for a create or batch entry.
 *
 * @param appId Owning app UUID.
 * @param requestId Caller request id.
 * @param entryIndex Standalone creates use 0; batch entries use their index.
 * @param kind Create versus batch allocation name.
 * @returns Deterministic record UUID.
 */
export function allocateRecordId(
  appId: string,
  requestId: string,
  entryIndex: number,
  kind: 'create' | 'batch'
): string {
  const name =
    kind === 'batch'
      ? `kernel.records.batch:${requestId}:${entryIndex}`
      : `kernel.records.create:${requestId}:${entryIndex}`;
  return uuidv5(name, uuidBytes(appId));
}
