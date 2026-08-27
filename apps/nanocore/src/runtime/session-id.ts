import { randomBytes } from 'node:crypto';

/**
 * Generates an RFC 9562 UUIDv7 value for product-visible AgentSessions.
 *
 * @param date Clock source used for the timestamp prefix.
 * @returns UUIDv7 string with the current millisecond timestamp.
 */
export function generateUuidV7(date = new Date()): string {
  const bytes = new Uint8Array(16);
  const timestamp = BigInt(date.getTime());
  const random = randomBytes(10);

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }

  bytes[6] = 0x70 | (random[0]! & 0x0f);
  bytes[7] = random[1]!;
  bytes[8] = 0x80 | (random[2]! & 0x3f);
  bytes.set(random.subarray(3), 9);

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}
