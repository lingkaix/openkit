import { createHash } from 'node:crypto';
import { canonicalJsonText } from './common/canonical-json.js';

/** Hashes exact bytes, or exact UTF-8 string bytes, without parsing or normalizing them. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hashes the shared canonical UTF-8 encoding; domain prefixes and result tags stay with callers. */
export function sha256CanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJsonText(value));
}
