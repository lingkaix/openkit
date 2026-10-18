/** Entity kinds owned by Core Protocol. Selectors, request ids and native runtime ids are excluded. */
export const ENTITY_KINDS = [
  'usr',
  'ws',
  'th',
  'tu',
  'it',
  'ar',
  'mat',
  'mrev',
  'arev',
  'kr',
  'as',
  'auto',
  'occ',
  'range',
  'auth',
  'acct',
  'verif',
  'tok',
  'nhtok',
  'inv',
  'cap',
  'pd',
  'use',
  'aud',
  'dep',
  'kb',
  'ks',
  'ko',
  'kc',
  'kf',
  'krt',
  'attempt',
  'wst',
  'vault',
  'grant',
  'vu',
  'cand',
  'col',
  'fld',
  'pres',
  'wsexp',
  'drb',
] as const;

/** A known OpenKit entity prefix, never an allocation or access grant. */
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** Canonical identifier text for a known entity kind. */
export type EntityId<Kind extends EntityKind = EntityKind> = `${Kind}_${string}`;

// Fixed UUIDv5(URL namespace, UTF-8 "openkit:entity-kind:<prefix>") from Core Protocol.
const DERIVED_NAMESPACES = {
  occ: 'fc01b827-9017-53dc-b41b-387a2110d905',
  tok: 'e87fb49e-00c1-53f3-adbd-a5cf0de72bcc',
  ws: '41710f31-94f8-5e51-9589-1744ce75680d',
  th: '1ea1147f-0d1a-5ae4-ba03-7ba2cd6a0eea',
  tu: '946f39c9-520d-5df2-985f-afaf05790c9d',
  it: '585ca877-60b4-584f-a217-02b4aea5c651',
  ar: 'fbb6ef57-8026-536c-aa29-0892c321c113',
  mat: '68a8d824-718c-5c44-831a-3292e9846783',
  mrev: 'c027bad1-40fa-5b1e-a480-421753232801',
  arev: '59bffd58-b464-5c91-917f-a066bc9ce605',
  kr: '5e78300b-9458-5519-b104-d47e32923804',
  cap: 'b447467a-3e9c-5e36-b988-7b4961a0d817',
  aud: 'c3d8713d-557b-5bf8-aa9c-a28bf50775d4',
  pd: 'bcf1702a-4e6a-59c6-86ac-75352a8fc41d',
  krt: '32a06e66-912c-53a4-b9d2-85b0a9edfe0b',
  wsexp: 'd8e266d0-77a0-5e91-b599-de82740626ff',
} as const;
/** Kinds with a declared UUIDv5 producer; the allocating owner still controls the complete name. */
export type DerivedEntityKind = keyof typeof DERIVED_NAMESPACES;

const kinds = new Set<string>(ENTITY_KINDS);
/** Returns the canonical kind rule for schemas and their generated JSON Schema projection. */
export function entityIdPattern(kind: EntityKind): RegExp {
  if (!kinds.has(kind)) throw new TypeError('Unknown entity kind');
  const version = Object.hasOwn(DERIVED_NAMESPACES, kind) ? '[57]' : '7';
  // The final negative lookahead rejects every trailing character, including a final newline.
  return new RegExp(
    `^${kind}_[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])`
  );
}

/** Checks canonical text only at a boundary that already names the expected kind. */
export function isEntityId<Kind extends EntityKind>(
  kind: Kind,
  value: unknown
): value is EntityId<Kind> {
  return kinds.has(kind) && typeof value === 'string' && entityIdPattern(kind).test(value);
}

/**
 * Allocates one independent RFC 9562 UUIDv7. The record owner calls once at creation and retains it.
 * The 48-bit timestamp layout is the former AgentSession codec, shared with browser-safe entropy.
 * Equal milliseconds and reversed clocks deliberately carry no total-order guarantee.
 */
export function allocateEntityId<Kind extends EntityKind>(
  kind: Kind,
  date = new Date()
): EntityId<Kind> {
  if (!kinds.has(kind)) throw new TypeError('Unknown entity kind');
  const milliseconds = date.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    throw new RangeError('UUIDv7 timestamp must be an unsigned 48-bit integer');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(milliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return `${kind}_${formatUuid(bytes)}`;
}

/**
 * Encodes an allocating owner's complete immutable JSON name as RFC 8785 JCS text.
 * Reject non-JSON values instead of omitting them and silently changing the derivation tuple.
 */
export function canonicalIdentifierName(name: unknown): string {
  const ancestors = new Set<object>();
  function encode(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      if (/[\uD800-\uDFFF]/u.test(value))
        throw new TypeError('Identifier names must contain valid Unicode');
      return JSON.stringify(value);
    }
    if (typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object')
      throw new TypeError('Identifier names must be finite JSON values');
    if (ancestors.has(value)) throw new TypeError('Identifier names must not contain cycles');
    ancestors.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length !== 0)
        throw new TypeError('JSON names have no symbol members');
      if (Array.isArray(value)) {
        if (
          Object.keys(value).some(
            (key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length
          )
        )
          throw new TypeError('JSON arrays have no named members');
        const entries: string[] = [];
        for (let index = 0; index < value.length; index += 1) entries.push(encode(value[index]));
        return `[${entries.join(',')}]`;
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        throw new TypeError('Identifier names must contain only JSON objects');
      }
      const object = value as Record<string, unknown>;
      // Write sorted members directly: JSON.stringify(object) would reorder integer-looking keys.
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${encode(key)}:${encode(object[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(name);
}

/** Derives the shared UUIDv5 encoding of an owner's declared JSON name, without random or clock inputs. */
export function deriveEntityId<Kind extends DerivedEntityKind>(
  kind: Kind,
  name: unknown
): EntityId<Kind> {
  if (!Object.hasOwn(DERIVED_NAMESPACES, kind))
    throw new TypeError('Entity kind has no owned derivation');
  const namespace = DERIVED_NAMESPACES[kind].replaceAll('-', '');
  const nameBytes = new TextEncoder().encode(canonicalIdentifierName(name));
  const input = new Uint8Array(16 + nameBytes.length);
  for (let index = 0; index < 16; index += 1)
    input[index] = Number.parseInt(namespace.slice(index * 2, index * 2 + 2), 16);
  input.set(nameBytes, 16);
  const bytes = sha1(input).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return `${kind}_${formatUuid(bytes)}`;
}

/** Formats the 16 UUID bytes without case conversion or a second wire codec. */
function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Rotates one SHA-1 word, with JavaScript bitwise operations retaining its low 32 bits. */
function rotate(word: number, bits: number): number {
  return (word << bits) | (word >>> (32 - bits));
}

/**
 * Synchronous SHA-1 for UUIDv5 only. It provides stable identity, never secret or integrity authority.
 * Web Crypto digest is asynchronous; existing allocation owners need synchronous browser-safe names.
 */
function sha1(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(input.length) * 8n);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Int32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getInt32(offset + index * 4);
    for (let index = 16; index < 80; index += 1)
      words[index] = rotate(
        words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!,
        1
      );
    let [a, b, c, d, e] = state as [number, number, number, number, number];
    for (let index = 0; index < 80; index += 1) {
      const f =
        index < 20
          ? (b & c) | (~b & d)
          : index < 40
            ? b ^ c ^ d
            : index < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d;
      const k =
        index < 20 ? 0x5a827999 : index < 40 ? 0x6ed9eba1 : index < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotate(a, 5) + f + e + k + words[index]!) | 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    const block = [a, b, c, d, e];
    for (let index = 0; index < 5; index += 1) state[index] = (state[index]! + block[index]!) | 0;
  }
  const output = new Uint8Array(20);
  const result = new DataView(output.buffer);
  for (let index = 0; index < 5; index += 1) result.setInt32(index * 4, state[index]!);
  return output;
}
