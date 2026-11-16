import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { signInSource } from '../auth/sign-in-limiter.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';

const sdkEnvironment = vi.hoisted(() => ({ production: false }));
vi.mock('@better-auth/core/env', async (load) => ({
  ...(await load<typeof import('@better-auth/core/env')>()),
  get isProduction() {
    return sdkEnvironment.production;
  },
}));

const roots: string[] = [];
const databases: CoreDb[] = [];

/** Uses the actual auth handler and isolated native Audit owner; no credential is retained by the test. */
function fixture(trustedProxyHops = 0) {
  const root = mkdtempSync(join(tmpdir(), 'sign-in-security-'));
  roots.push(root);
  const db = createTestCoreDb(root);
  databases.push(db);
  const userId = ensureLocalUser(db);
  createOpenKitAccessTokenRecord(db, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const auth = createBetterAuth(db, { openKitConfig: { auth: { trustedProxyHops } } });
  const signIn = (account: number, peer: string, forwarded?: string) =>
    auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(forwarded
            ? {
                'x-forwarded-for': forwarded,
                'x-real-ip': forwarded,
                'x-openkit-auth-source': forwarded,
              }
            : {}),
        },
        body: JSON.stringify({
          email: `account-${account}@unit.invalid`,
          password: 'invalid-test-password',
        }),
      }),
      peer
    );
  const events = () =>
    (
      db.sqlite
        .prepare(
          "SELECT summary FROM audit_events WHERE action = 'auth.failure-threshold' ORDER BY rowid"
        )
        .all() as { summary: string }[]
    ).map((row) => JSON.parse(row.summary));
  return { signIn, events, db, userId, auth };
}

afterEach(async () => {
  sdkEnvironment.production = false;
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of databases.splice(0)) closeTestCoreDb(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sign-in security boundaries', () => {
  it.each([
    [0, '203.0.113.1', '192.0.2.10'],
    [2, '198.51.100.2, 203.0.113.1, 10.0.0.1', '203.0.113.1'],
    [2, '203.0.113.1', '192.0.2.10'],
    [2, '203.0.113.1, invalid', '192.0.2.10'],
    [1, 'fe80::1%lo', '192.0.2.10'],
  ] as const)('selects a literal source with hops=%s and chain=%s', (hops, chain, expected) => {
    expect(
      signInSource(
        new Request('https://openkit.invalid', { headers: { 'x-forwarded-for': chain } }),
        '192.0.2.10',
        hops
      )
    ).toBe(expected);
  });

  it('preserves the SDK production sign-up limiter while overriding only the sign-in rule', async () => {
    sdkEnvironment.production = true;
    const f = fixture();
    const signUp = () =>
      f.auth.handler(
        new Request('http://localhost:3000/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        '198.18.3.1'
      );
    for (let n = 0; n < 3; n++) expect((await signUp()).status).toBe(400);
    const blocked = await signUp();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(f.events()).toEqual([]);
  });

  it('limits one account across transport peers with backoff and exactly one failure crossing', async () => {
    const f = fixture();
    for (let n = 1; n <= 10; n++) expect((await f.signIn(0, `192.0.2.${n}`)).status).toBe(401);
    const blocked = await f.signIn(0, '192.0.2.100');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(f.events()).toEqual([
      { kind: 'sign-in', keyKind: 'account', window: 900000, count: 10 },
    ]);
    expect((await f.signIn(1, '192.0.2.100')).status).toBe(401);
    const trigger = new SecurityTriggerStore(f.db);
    await trigger.enable({ kind: 'local', userId: f.userId });
    expect(
      (await trigger.readAudit()).events.filter(
        (event) => event.action === 'auth.failure-threshold'
      )
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'limits form-encoded sign-in across peers with SDK last-value semantics (duplicate=%s)',
    async (duplicate) => {
      const f = fixture();
      const signIn = (n: number) => {
        const body = new URLSearchParams();
        if (duplicate) body.append('email', [`decoy-${n}`, 'unit.invalid'].join('@'));
        body.append('email', ['form-account', 'unit.invalid'].join('@'));
        body.append('password', 'invalid-test-password');
        return f.auth.handler(
          new Request('http://localhost:3000/api/auth/sign-in/email', {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
              origin: 'http://localhost:3000',
            },
            body,
          }),
          `192.0.2.${n}`
        );
      };
      for (let n = 1; n <= 10; n++) expect((await signIn(n)).status).toBe(401);
      const blocked = await signIn(11);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(f.events()).toEqual([
        { kind: 'sign-in', keyKind: 'account', window: 900000, count: 10 },
      ]);
    }
  );

  it('uses the transport peer for source limiting and ignores forged forwarding headers by default', async () => {
    const f = fixture();
    for (let n = 0; n < 50; n++)
      expect((await f.signIn(n, '198.51.100.1', `203.0.113.${n + 1}`)).status).toBe(401);
    expect((await f.signIn(50, '198.51.100.1', '203.0.113.200')).status).toBe(429);
    expect(f.events()).toEqual([{ kind: 'sign-in', keyKind: 'source', window: 900000, count: 50 }]);
    expect((await f.signIn(51, '198.51.100.2')).status).toBe(401);
  });

  it('shares source protection across equivalent IPv4 and mapped IPv6 literals', async () => {
    const f = fixture();
    const peers = ['198.18.1.1', '::ffff:198.18.1.1', '::ffff:c612:101'];
    for (let n = 0; n < 50; n++)
      expect((await f.signIn(n, peers[n % peers.length]!)).status).toBe(401);
    expect((await f.signIn(50, '198.18.1.1')).status).toBe(429);
    expect(f.events()).toEqual([{ kind: 'sign-in', keyKind: 'source', window: 900000, count: 50 }]);
  });

  it('reserves account attempts before concurrent credential verification and releases the window after backoff', async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) => f.signIn(0, `198.18.2.${n + 1}`))
    );
    expect(results.filter((response) => response.status === 401)).toHaveLength(10);
    expect(results.filter((response) => response.status === 429)).toHaveLength(2);
    expect(f.events()).toEqual([
      { kind: 'sign-in', keyKind: 'account', window: 900000, count: 10 },
    ]);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 900001);
    expect((await f.signIn(0, '192.0.2.100')).status).toBe(401);
  });

  it('selects exactly the administrator configured hop from the right of the forwarding chain', async () => {
    const f = fixture(2);
    for (let n = 0; n < 50; n++)
      expect(
        (await f.signIn(n, `192.0.2.${n + 1}`, `198.51.100.${n + 1}, 203.0.113.90, 10.0.0.1`))
          .status
      ).toBe(401);
    expect(
      (await f.signIn(50, '192.0.2.100', '198.51.100.200, 203.0.113.90, 10.0.0.1')).status
    ).toBe(429);
    expect(
      (await f.signIn(51, '192.0.2.100', '198.51.100.200, 203.0.113.91, 10.0.0.1')).status
    ).toBe(401);
    expect(f.events()).toEqual([{ kind: 'sign-in', keyKind: 'source', window: 900000, count: 50 }]);
  });
});
