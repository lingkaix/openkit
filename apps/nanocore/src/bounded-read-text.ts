import { Buffer } from 'node:buffer';

/** Exact UTF-8 head or tail, without a partial code point or invented text. */
export function previewUtf8(encoded: Buffer, side: 'head' | 'tail', maximum: number): string {
  if (encoded.byteLength <= maximum) return encoded.toString('utf8');
  let selected =
    side === 'head' ? encoded.subarray(0, maximum) : encoded.subarray(encoded.length - maximum);
  for (;;) {
    try {
      return new TextDecoder('utf8', { fatal: true }).decode(selected);
    } catch {
      selected = side === 'head' ? selected.subarray(0, -1) : selected.subarray(1);
    }
  }
}

/** Bounded descriptive header text includes UTF-8 and JSON escaping in its byte allowance. */
export function boundedJsonText(value: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum < 2)
    throw new RangeError('Invalid JSON text bound.');
  const encoded = Buffer.from(value);
  let limit = Math.min(maximum, encoded.byteLength);
  for (;;) {
    const text = previewUtf8(encoded, 'head', limit);
    if (Buffer.byteLength(JSON.stringify(text)) <= maximum) return text;
    limit = Math.floor(limit * 0.75);
  }
}
