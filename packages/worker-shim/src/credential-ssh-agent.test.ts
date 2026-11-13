import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSshAgentFrame } from './credential-ssh-agent.js';

// RFC 9987 sections 5 and 8; numeric constants do not come from the subject.
const LIMIT = 65_536;
const FAILURE = Buffer.from([0, 0, 0, 1, 5]);
const PRIVATE = 'synthetic-private-marker';

/** Build an independent network-order integer fixture. */
function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** Encode a fixture SSH string, not a subject implementation. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([uint32(bytes.length), bytes]);
}

/** Build one complete request or expected response. */
function frame(type: number, ...fields: Buffer[]): Buffer {
  const payload = Buffer.concat([Buffer.from([type]), ...fields]);
  return Buffer.concat([uint32(payload.length), payload]);
}

const KEY = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 17))]);
const SIGNATURE = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(64, 34))]);
const RSA_KEY = Buffer.concat([
  sshString('ssh-rsa'),
  sshString(Buffer.from([1, 0, 1])),
  sshString(Buffer.alloc(64, 51)),
]);
const DATA = Buffer.from([0, 255, 128, 65]);

/** Construct injected effects; no private key or signer exists in this oracle. */
function callbacks(signature = SIGNATURE) {
  return {
    identities: vi.fn(async () => [{ keyBlob: KEY, comment: 'synthetic-key' }]),
    sign: vi.fn(async (_request: { keyBlob: Buffer; data: Buffer; flags: number }) => signature),
  };
}

/** Build a native sign request with one explicit flags word. */
function signRequest(flags = 0, data = DATA, keyBlob = KEY): Buffer {
  return frame(13, sshString(keyBlob), sshString(data), uint32(flags));
}

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  logs = ['log', 'warn', 'error'].map((method) =>
    vi.spyOn(console, method as 'log').mockImplementation(() => {})
  );
});
afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe('SSH agent identities', () => {
  it('answers request 11 with identities answer 12 and length-prefixed public fields', async () => {
    const effects = callbacks();
    expect(await handleSshAgentFrame(Buffer.from([0, 0, 0, 1, 11]), effects)).toEqual(
      frame(12, uint32(1), sshString(KEY), sshString('synthetic-key'))
    );
    expect(effects.identities).toHaveBeenCalledExactlyOnceWith();
    expect(effects.sign).not.toHaveBeenCalled();
  });

  it('supports an empty list rather than returning generic success 6', async () => {
    const effects = { ...callbacks(), identities: vi.fn(() => []) };
    expect(await handleSshAgentFrame(frame(11), effects)).toEqual(
      Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0])
    );
    expect(effects.sign).not.toHaveBeenCalled();
  });

  it('preserves identity order and uses UTF-8 byte lengths for comments', async () => {
    const secondKey = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 51))]);
    const effects = {
      ...callbacks(),
      identities: vi.fn(() => [
        { keyBlob: KEY, comment: 'synthetic-é' },
        { keyBlob: secondKey, comment: '' },
      ]),
    };
    expect(await handleSshAgentFrame(frame(11), effects)).toEqual(
      frame(
        12,
        uint32(2),
        sshString(KEY),
        sshString('synthetic-é'),
        sshString(secondKey),
        sshString('')
      )
    );
  });

  it.each([
    null,
    {},
    [{ keyBlob: 'not-binary', comment: PRIVATE }],
    [{ keyBlob: Buffer.alloc(0), comment: 'synthetic-key' }],
    [{ keyBlob: KEY, comment: 7 }],
    [{ keyBlob: KEY, comment: '\u00e9'.repeat(33_000) }],
    [{ keyBlob: Buffer.alloc(LIMIT), comment: '' }],
  ])('refuses malformed or oversized identities atomically', async (value) => {
    const effects = { ...callbacks(), identities: vi.fn(() => value) };
    expect(await handleSshAgentFrame(frame(11), effects)).toEqual(FAILURE);
    expect(effects.sign).not.toHaveBeenCalled();
  });

  it('does not serialize an earlier identity when a later identity is malformed', async () => {
    const effects = {
      ...callbacks(),
      identities: vi.fn(() => [
        { keyBlob: KEY, comment: PRIVATE },
        { keyBlob: KEY, comment: 7 },
      ]),
    };
    expect(await handleSshAgentFrame(frame(11), effects)).toEqual(FAILURE);
  });

  it('accepts an exact maximum response payload and rejects one extra byte', async () => {
    // type + count + key length + key bytes + comment length + comment bytes.
    const comment = 'a'.repeat(LIMIT - 13 - KEY.length);
    const effects = { ...callbacks(), identities: vi.fn(() => [{ keyBlob: KEY, comment }]) };
    const answer = await handleSshAgentFrame(frame(11), effects);
    expect(answer).toEqual(frame(12, uint32(1), sshString(KEY), sshString(comment)));
    expect(answer.readUInt32BE(0)).toBe(LIMIT);
    expect(
      await handleSshAgentFrame(frame(11), {
        ...effects,
        identities: () => [{ keyBlob: KEY, comment: `${comment}a` }],
      })
    ).toEqual(FAILURE);
  });
});

describe('SSH agent signing codec', () => {
  it.each([0, 2, 4])(
    'passes opaque binary key/data and admitted flags %i to the signer once',
    async (flags) => {
      // RFC 9987 section 5.6.1: flags 2 and 4 apply only to ssh-rsa keys.
      const keyBlob = flags === 0 ? KEY : RSA_KEY;
      const signature =
        flags === 0
          ? SIGNATURE
          : Buffer.concat([
              sshString(flags === 2 ? 'rsa-sha2-256' : 'rsa-sha2-512'),
              sshString(Buffer.alloc(64, 68)),
            ]);
      const effects = callbacks(signature);
      const answer = await handleSshAgentFrame(signRequest(flags, DATA, keyBlob), effects);
      expect(effects.sign).toHaveBeenCalledExactlyOnceWith({ keyBlob, data: DATA, flags });
      expect(effects.identities).not.toHaveBeenCalled();
      expect(answer).toEqual(frame(14, sshString(signature)));
      expect(answer.readUInt32BE(0)).toBe(answer.length - 4);
    }
  );

  it('permits empty sign data because SSH strings can be empty', async () => {
    const effects = callbacks();
    expect(await handleSshAgentFrame(signRequest(0, Buffer.alloc(0)), effects)).toEqual(
      frame(14, sshString(SIGNATURE))
    );
    expect(effects.sign).toHaveBeenCalledExactlyOnceWith({
      keyBlob: KEY,
      data: Buffer.alloc(0),
      flags: 0,
    });
  });

  it.each([1, 6, 8, 0xffff_ffff])(
    'refuses unsupported or conflicting flags %i before callback',
    async (flags) => {
      const effects = callbacks();
      expect(await handleSshAgentFrame(signRequest(flags), effects)).toEqual(FAILURE);
      expect(effects.sign).not.toHaveBeenCalled();
      expect(effects.identities).not.toHaveBeenCalled();
    }
  );

  it.each([null, undefined, Buffer.alloc(0), 'not-binary', Buffer.alloc(LIMIT)])(
    'turns denied, malformed or oversized signing results into failure 5',
    async (value) => {
      const effects = { ...callbacks(), sign: vi.fn(() => value) };
      expect(await handleSshAgentFrame(signRequest(), effects)).toEqual(FAILURE);
      expect(effects.sign).toHaveBeenCalledTimes(1);
      expect(effects.identities).not.toHaveBeenCalled();
    }
  );

  it('accepts the exact request payload limit', async () => {
    const data = Buffer.alloc(LIMIT - 13 - KEY.length, 68);
    const request = signRequest(0, data);
    expect(request.readUInt32BE(0)).toBe(LIMIT);
    const effects = callbacks();
    expect(await handleSshAgentFrame(request, effects)).toEqual(frame(14, sshString(SIGNATURE)));
    expect(effects.sign).toHaveBeenCalledExactlyOnceWith({ keyBlob: KEY, data, flags: 0 });
  });
});

describe('SSH frame refusal and effect isolation', () => {
  it.each([0, 5, 6, 12, 14, 17, 18, 19, 22, 27, 255])(
    'refuses unknown, response-only or unsupported mutation type %i',
    async (type) => {
      const effects = callbacks();
      expect(await handleSshAgentFrame(frame(type), effects)).toEqual(FAILURE);
      expect(effects.identities).not.toHaveBeenCalled();
      expect(effects.sign).not.toHaveBeenCalled();
    }
  );

  it.each([
    Buffer.alloc(0),
    Buffer.from([0]),
    Buffer.from([0, 0, 0]),
    uint32(0),
    Buffer.concat([uint32(2), Buffer.from([11])]),
    Buffer.concat([uint32(1), Buffer.from([11, 0])]),
    Buffer.concat([frame(11), frame(11)]),
    frame(11, Buffer.from([0])),
    Buffer.concat([uint32(LIMIT + 1), Buffer.from([11])]),
    Buffer.concat([uint32(0xffff_ffff), Buffer.from([11])]),
    frame(11, Buffer.alloc(LIMIT)),
    frame(13),
    frame(13, uint32(0xffff_ffff)),
    frame(13, sshString(KEY)),
    frame(13, sshString(KEY), uint32(0xffff_ffff)),
    frame(13, sshString(KEY), sshString(DATA)),
    frame(13, sshString(KEY), sshString(DATA), Buffer.from([0, 0, 0])),
    frame(13, sshString(KEY), sshString(DATA), uint32(0), Buffer.from([0])),
    frame(13, sshString(Buffer.alloc(0)), sshString(DATA), uint32(0)),
  ])('rejects malformed or oversized complete frames before effects: %#', async (request) => {
    const effects = callbacks();
    expect(await handleSshAgentFrame(request, effects)).toEqual(FAILURE);
    expect(effects.identities).not.toHaveBeenCalled();
    expect(effects.sign).not.toHaveBeenCalled();
  });

  it.each(['identities', 'sign'] as const)(
    '%s callback failure never escapes as diagnostic bytes',
    async (operation) => {
      for (const fail of [
        () => {
          throw new Error(PRIVATE);
        },
        async () => {
          throw new Error(PRIVATE);
        },
      ]) {
        const effects = callbacks();
        const injected = { ...effects, [operation]: vi.fn(fail) };
        const answer = await handleSshAgentFrame(
          operation === 'identities' ? frame(11) : signRequest(),
          injected
        );
        expect(answer).toEqual(FAILURE);
        expect(answer.includes(Buffer.from(PRIVATE))).toBe(false);
        expect(injected[operation]).toHaveBeenCalledTimes(1);
        expect(injected[operation === 'identities' ? 'sign' : 'identities']).not.toHaveBeenCalled();
      }
    }
  );
});
