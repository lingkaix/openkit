/**
 * Encodes a structured value as canonical JSON, omitting undefined object members only.
 * Domain selection and normalization belong to callers; exact retained bytes are never re-encoded.
 */
export function canonicalJsonText(value: unknown): string {
  return encodeCanonicalJson(value, true);
}

/** Encodes an identifier owner's complete JSON name without omitting any tuple member. */
export function canonicalIdentifierName(name: unknown): string {
  return encodeCanonicalJson(name, false);
}

/** Shares recursive JCS encoding while preserving the identifier owner's stricter input domain. */
function encodeCanonicalJson(input: unknown, omitUndefinedMembers: boolean): string {
  const ancestors = new Set<object>();
  function encode(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      if (/[\uD800-\uDFFF]/u.test(value))
        throw new TypeError('Canonical JSON must contain valid Unicode');
      return JSON.stringify(value);
    }
    if (typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object')
      throw new TypeError('Canonical JSON requires finite JSON values');
    if (ancestors.has(value)) throw new TypeError('Canonical JSON must not contain cycles');
    ancestors.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length !== 0)
        throw new TypeError('Canonical JSON has no symbol members');
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype)
          throw new TypeError('Canonical JSON requires plain arrays');
        if (
          Object.getOwnPropertyNames(value).some(
            (key) =>
              key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
          )
        )
          throw new TypeError('Canonical JSON arrays have no named members');
        const entries: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index))
            throw new TypeError('Canonical JSON arrays must not contain holes');
          entries.push(encode(value[index]));
        }
        return `[${entries.join(',')}]`;
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        throw new TypeError('Canonical JSON requires plain objects');
      }
      const object = value as Record<string, unknown>;
      const entries: string[] = [];
      // Emit sorted members directly: JSON.stringify(object) would reorder integer-looking keys.
      for (const key of Object.keys(object).sort()) {
        const encodedKey = encode(key);
        const member = object[key];
        if (member === undefined && omitUndefinedMembers) continue;
        entries.push(`${encodedKey}:${encode(member)}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(input);
}
