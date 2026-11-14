// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createApp } from '../app.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
  rotateOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import type { CoreDb } from './db.js';

const BASE = 'http://localhost:3000';
const EXPIRY = '2999-01-01T00:00:00.000Z';

/** Read the actual private projection without requiring the not-yet-produced field at compile time. */
function issuerRef(record: unknown): unknown {
  return record !== null && typeof record === 'object'
    ? Reflect.get(record, 'issuerRef')
    : undefined;
}

/** SELECT only: OLD lacks the additive column, so its field is undefined rather than a SQL error. */
function rawIssuer(db: CoreDb, tokenId: string): unknown {
  const row = db.sqlite
    .prepare('SELECT * FROM openkit_access_tokens WHERE token_id = ?')
    .get(tokenId) as Record<string, unknown> | undefined;
  return row?.issuer_ref_json;
}

/** Use the same real User/Workspace/Token owners as the native issuance fixture, with real SDK sessions. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e11-issuer-'));
  const coreDb = createTestCoreDb(dataRoot);
  onTestFinished(() => disposeTestStore(dataRoot, coreDb));
  ensureLocalUser(coreDb);
  const auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  async function signUp(label: string) {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({
          name: label,
          email: `${label}@example.test`,
          password: 'synthetic-native-issuer-password',
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.user?.id === 'string').toBe(true);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie.length > 0).toBe(true);
    return { userId: body.user.id as string, cookie };
  }
  const issuer = await signUp('issuer');
  const owner = await signUp('owner');
  expect(issuer.userId === owner.userId).toBe(false);
  // Existing owner bootstrap builder, not a fabricated Kernel/admin flag or SQL grant.
  const administrator = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: issuer.userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: EXPIRY,
  });
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Native issuer target');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: owner.userId });
  // An unattributed owner-built row models retained NULL; no issuer is guessed from ownership.
  const legacy = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: owner.userId,
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
    expiresAt: EXPIRY,
  });
  const app = createApp({ mode: 'server', coreDb, dataRoot, store, auth });
  const headers = new Headers({ cookie: issuer.cookie });
  const session = await auth.api.getSession({ headers });
  expect(session?.user.id === issuer.userId).toBe(true);
  expect(typeof session?.session.id === 'string').toBe(true);
  const input = {
    ownerUserId: owner.userId,
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
    expiresAt: EXPIRY,
  };
  async function issue(
    credentials: HeadersInit = { cookie: issuer.cookie },
    patch: Record<string, unknown> = {}
  ) {
    const response = await app.request(
      ...operationRequest(
        'token.create',
        {},
        {
          headers: credentials,
          body: JSON.stringify({ ...input, ...patch }),
        }
      )
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.record?.tokenId === 'string' && typeof body.token === 'string').toBe(true);
    return body as { record: { tokenId: string; ownerUserId: string }; token: string };
  }
  return { coreDb, auth, app, issuer, owner, administrator, legacy, session, input, issue };
}

function expectStoredIssuer(db: CoreDb, tokenId: string, expected: unknown) {
  const record = getOpenKitAccessTokenRecord(db, tokenId);
  expect(record !== null).toBe(true);
  // Intended OLD: undefined on the actual existing private record, not missing-module collection.
  expect(issuerRef(record)).toEqual(expected);
  const raw = rawIssuer(db, tokenId);
  if (expected === null) {
    expect(raw).toBeNull();
  } else {
    expect(typeof raw === 'string').toBe(true);
    expect(JSON.parse(String(raw))).toEqual(expected);
  }
}

describe('E11 native Token issuer producer', () => {
  it('records the actual authenticated User issuer rather than the different Token owner', async () => {
    const f = await fixture();
    const issued = await f.issue();
    expect(issued.record.ownerUserId).toBe(f.owner.userId);
    const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, issued.token);
    expect(verified?.tokenId).toBe(issued.record.tokenId);
    const expected = { kind: 'user', id: f.issuer.userId };
    expectStoredIssuer(f.coreDb, issued.record.tokenId, expected);
    expect(issuerRef(verified)).toEqual(expected);
  });

  it('records a session as its actual User and keeps the ordinary child usable after real logout', async () => {
    const f = await fixture();
    const issued = await f.issue();
    const logout = await f.auth.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie: f.issuer.cookie, origin: BASE, 'content-type': 'application/json' },
        body: '{}',
      })
    );
    expect(logout.status).toBe(200);
    expect(
      (await f.auth.api.getSession({ headers: new Headers({ cookie: f.issuer.cookie }) })) === null
    ).toBe(true);
    const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, issued.token);
    expect(verified?.tokenId).toBe(issued.record.tokenId);
    const expected = { kind: 'user', id: f.issuer.userId };
    expectStoredIssuer(f.coreDb, issued.record.tokenId, expected);
    expect(issuerRef(verified)).toEqual(expected);
    expect(issuerRef(verified)).not.toEqual({ kind: 'session', id: f.session!.session.id });
    expect(issuerRef(verified)).not.toEqual({ kind: 'token', id: f.administrator.tokenId });
  });

  it('records the actual authenticated bearer Token id, not its owner User', async () => {
    const f = await fixture();
    const authenticated = await verifyOpenKitAccessTokenRecord(f.coreDb, f.administrator.secret);
    expect(authenticated?.tokenId).toBe(f.administrator.tokenId);
    const issued = await f.issue({ authorization: `Bearer ${f.administrator.secret}` });
    const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, issued.token);
    expect(verified?.tokenId).toBe(issued.record.tokenId);
    const expected = { kind: 'token', id: f.administrator.tokenId };
    expectStoredIssuer(f.coreDb, issued.record.tokenId, expected);
    expect(issuerRef(verified)).toEqual(expected);
  });

  it.each(['native-prepared', 'legacy-secret'] as const)(
    'preserves the original issuer rather than predecessor or rotator through %s rotation',
    async (path) => {
      const f = await fixture();
      const original = await f.issue();
      let successorId: string;
      let successorSecret: string;
      if (path === 'native-prepared') {
        const rotator = await f.issue(undefined, {
          ownerUserId: f.owner.userId,
          scope: 'server-admin',
          workspaceIds: [],
        });
        const response = await f.app.request(
          ...operationRequest(
            'token.rotate',
            {},
            {
              headers: { authorization: `Bearer ${rotator.token}` },
              body: JSON.stringify({ tokenId: original.record.tokenId, graceSeconds: 0 }),
            }
          )
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rotatedRecord?.tokenId).toBe(original.record.tokenId);
        successorId = body.record.tokenId;
        successorSecret = body.token;
      } else {
        // Join the native owner before the existing legacy public store mutation; never bypass a live writer.
        await shutdownControlStoreWorkerClient();
        const rotated = rotateOpenKitAccessTokenRecord(f.coreDb, original.record.tokenId, {
          graceSeconds: 0,
        });
        expect(rotated !== null).toBe(true);
        successorId = rotated!.tokenId;
        successorSecret = rotated!.secret;
      }
      expect(successorId === original.record.tokenId).toBe(false);
      expect(getOpenKitAccessTokenRecord(f.coreDb, successorId)?.predecessorTokenId).toBe(
        original.record.tokenId
      );
      const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, successorSecret);
      expect(verified?.tokenId).toBe(successorId);
      const expected = { kind: 'user', id: f.issuer.userId };
      expectStoredIssuer(f.coreDb, successorId, expected);
      expectStoredIssuer(f.coreDb, original.record.tokenId, expected);
      expect(issuerRef(verified)).toEqual(expected);
      expect(issuerRef(verified)).not.toEqual({ kind: 'token', id: original.record.tokenId });
    }
  );

  it('keeps unattributed legacy NULL ordinary Tokens usable without guessing or backfilling an issuer', async () => {
    const f = await fixture();
    const before = rawIssuer(f.coreDb, f.legacy.tokenId);
    const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, f.legacy.secret);
    expect(verified?.tokenId).toBe(f.legacy.tokenId);
    expectStoredIssuer(f.coreDb, f.legacy.tokenId, null);
    expect(issuerRef(verified)).toBeNull();
    expect(rawIssuer(f.coreDb, f.legacy.tokenId)).toBe(before);
  });

  it('rejects caller-supplied issuerRef before any native Token issue while valid authenticated issue still works', async () => {
    const f = await fixture();
    const control = await f.issue();
    expect(control.record.ownerUserId).toBe(f.owner.userId);
    const before = listOpenKitAccessTokenRecords(f.coreDb).length;
    const response = await f.app.request(
      ...operationRequest(
        'token.create',
        {},
        {
          headers: { cookie: f.issuer.cookie },
          body: JSON.stringify({
            ...f.input,
            issuerRef: { kind: 'token', id: f.administrator.tokenId },
          }),
        }
      )
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('invalid_request');
    expect(listOpenKitAccessTokenRecords(f.coreDb)).toHaveLength(before);
  });
});
