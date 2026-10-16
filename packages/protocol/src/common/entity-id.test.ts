import { describe, expect, it, vi } from 'vitest';
import {
  allocateEntityId,
  canonicalIdentifierName,
  deriveEntityId,
  ENTITY_KINDS,
  isEntityId,
} from './entity-id.js';

const turnId = 'tu_01890f3e-0000-7000-8000-000000000001';

describe('canonical entity identifiers', () => {
  it('allocates independent v7 ids with the admitted timestamp and variant for every kind', () => {
    for (const kind of ENTITY_KINDS) {
      const id = allocateEntityId(kind, new Date(0x01890f3e0000));
      expect(id).toMatch(
        new RegExp(`^${kind}_01890f3e-0000-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
      );
      expect(isEntityId(kind, id)).toBe(true);
      expect(isEntityId(kind === 'ws' ? 'th' : 'ws', id)).toBe(false);
    }
  });
  it('keeps independent identity unique in the same millisecond without claiming a total order', () => {
    const ids = Array.from({ length: 1024 }, () => allocateEntityId('ws', new Date(0)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(allocateEntityId('ws', new Date(1)).startsWith('ws_00000000-0001-7')).toBe(true);
    expect(allocateEntityId('ws', new Date(0)).startsWith('ws_00000000-0000-7')).toBe(true);
    expect(allocateEntityId('ws', new Date(0xffffffffffff)).startsWith('ws_ffffffff-ffff-7')).toBe(
      true
    );
  });
  it.each([
    new Date(-1),
    new Date(Number.NaN),
    new Date(0x1000000000000),
  ])('refuses an invalid UUID timestamp %s', (date) => {
    expect(() => allocateEntityId('ws', date)).toThrow();
  });
  it('propagates entropy failure rather than returning a weak or replacement identity', () => {
    const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('entropy unavailable');
    });
    try {
      expect(() => allocateEntityId('ws')).toThrow('entropy unavailable');
    } finally {
      entropy.mockRestore();
    }
  });
  it('derives the fixed UUIDv5 name without depending on a clock or process state', () => {
    // Reference fixed with Python stdlib uuid.uuid5 and the accepted it namespace, not this codec.
    expect(deriveEntityId('it', ['chat-user', turnId])).toBe(
      'it_2a5773ee-1d5e-51ee-8997-2a1b24dd6558'
    );
    expect(deriveEntityId('it', ['chat-user', turnId])).toBe(
      'it_2a5773ee-1d5e-51ee-8997-2a1b24dd6558'
    );
    expect(deriveEntityId('it', ['chat-answer', turnId])).not.toBe(
      deriveEntityId('it', ['chat-user', turnId])
    );
    expect(deriveEntityId('it', [turnId, 'chat-user'])).not.toBe(
      deriveEntityId('it', ['chat-user', turnId])
    );
  });
  it('retains the deletion-request recovery export identity with its complete immutable input', () => {
    const requestId = '0190f4c8-0000-4000-8000-000000000001';
    const id = deriveEntityId('wsexp', ['delete', requestId]);
    expect(id).toBe('wsexp_bff02f51-45bb-5e8f-9adb-4e4a3a55159a');
    expect(deriveEntityId('wsexp', ['delete', requestId])).toBe(id);
    expect(deriveEntityId('wsexp', ['delete', '0190f4c8-0000-4000-8000-000000000002'])).not.toBe(
      id
    );
    expect(isEntityId('wsexp', id)).toBe(true);
    expect(isEntityId('wsexp', `wsexp_delete_${requestId}`)).toBe(false);
  });
  it('matches every accepted namespace using an independent UUIDv5 reference', () => {
    for (const [kind, expected] of Object.entries(NAMESPACE_VECTORS)) {
      expect(
        deriveEntityId(kind as Parameters<typeof deriveEntityId>[0], ['reference', '🌍'.repeat(40)])
      ).toBe(`${kind}_${expected}`);
    }
  });
  it('uses complete recursive JCS names, including numeric-looking object keys and native types', () => {
    expect(
      canonicalIdentifierName({
        z: { b: 2, a: 1 },
        a: [1, '1', null, true, -0],
        '2': 'two',
        '10': 'ten',
      })
    ).toBe('{"10":"ten","2":"two","a":[1,"1",null,true,0],"z":{"a":1,"b":2}}');
    expect(deriveEntityId('cap', ['mcp', 'snapshot', 'server', 'operation', 1])).not.toBe(
      deriveEntityId('cap', ['mcp', 'snapshot', 'server', 'operation', '1'])
    );
    expect(deriveEntityId('tu', { b: [2, { z: 1, a: 0 }], a: 1 })).toBe(
      deriveEntityId('tu', { a: 1, b: [2, { a: 0, z: 1 }] })
    );
    expect(deriveEntityId('it', [' x '])).not.toBe(deriveEntityId('it', ['x']));
    expect(deriveEntityId('it', ['é'])).not.toBe(deriveEntityId('it', ['e\u0301']));
  });
  it.each([
    undefined,
    Number.NaN,
    Infinity,
    { x: undefined },
    [undefined],
    Array(1),
    new Date(),
    '\ud800',
    { '\udfff': 1 },
  ])('refuses values outside the canonical JSON domain', (name) => {
    expect(() => canonicalIdentifierName(name)).toThrow();
  });
  it.each([
    'named',
    'symbol',
  ] as const)('refuses ignored %s array members in an identifier name', (kind) => {
    const name = [1];
    Object.defineProperty(name, kind === 'named' ? 'extra' : Symbol('extra'), {
      value: 2,
      enumerable: true,
    });
    expect(() => canonicalIdentifierName(name)).toThrow();
  });

  it('rejects cycles rather than producing partial canonical bytes', () => {
    const value: unknown[] = [];
    value.push(value);
    expect(() => canonicalIdentifierName(value)).toThrow();
  });
  it('admits v5 only for the owner-declared kinds and never infers authority from a UUID', () => {
    for (const kind of ENTITY_KINDS) {
      const derived = `${kind}_01890f3e-0000-5000-8000-000000000001`;
      expect(isEntityId(kind, derived)).toBe(
        [
          'ws',
          'th',
          'tu',
          'it',
          'ar',
          'mat',
          'mrev',
          'arev',
          'kr',
          'cap',
          'aud',
          'pd',
          'krt',
          'wsexp',
        ].includes(kind)
      );
    }
  });
  it.each([
    'ws_old',
    'WS_01890f3e-0000-7000-8000-000000000001',
    'ws_01890F3E-0000-7000-8000-000000000001',
    'ws_01890f3e000070008000000000000001',
    'ws_01890f3e-0000-4000-8000-000000000001',
    'ws_01890f3e-0000-7000-c000-000000000001',
    ' ws_01890f3e-0000-7000-8000-000000000001',
    'ws_01890f3e-0000-7000-8000-000000000001\n',
    'ws_01890f3e-0000-7000-8000-000000000001/extra',
  ])('rejects noncanonical or wrong-version identifiers %s', (id) => {
    expect(isEntityId('ws', id)).toBe(false);
  });
});

const NAMESPACE_VECTORS = {
  wsexp: 'e93015e7-103e-580a-aa06-af89abbd402e',
  ws: '2a8ccba5-18ce-5efd-bbe0-6c02d144bcab',
  th: '8349ef16-494b-5dd6-83cd-1a0249344085',
  tu: '9b217f0e-0e3f-5268-9524-eb4eff3003ad',
  it: 'bcfa9c47-b421-5c73-9212-f4adb994cd0a',
  ar: '306ce47f-0cb7-56e3-b320-d4dd8a5596fb',
  mat: 'c0bf781d-ed55-5444-92d2-917b2d864f87',
  mrev: '6e1d53c8-fc8b-5d32-a604-f7e6512fa9fb',
  arev: 'a40208f9-65c3-5835-a9d9-62bd1f7bb702',
  kr: '3b07f200-5d22-5c31-8b49-5e968b4babb3',
  cap: 'f480d436-9bc1-5e40-982b-4704071b354b',
  aud: 'ba383b8c-5047-59df-84ad-af5a1190bdb5',
  pd: 'b244b688-0842-53d5-97cd-c9195190a373',
  krt: '2172f704-7721-5abd-8a53-8859739e521c',
};
