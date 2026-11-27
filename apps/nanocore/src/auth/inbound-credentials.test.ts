// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from './access-token-store.js';
import { createBetterAuth } from './better-auth.js';
import { createCredentialOperationImplementations } from './credential-operations.js';
import { actorFromSession } from './identity.js';
import { currentWorkspaceAuthority } from './operation-authorizer.js';

const BASE = 'http://localhost:3000';
const EXPIRY = '2999-01-01T00:00:00.000Z';

/** Actual SDK sessions, original Token writer and native public operation admission. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-inbound-management-'));
  const coreDb = createTestCoreDb(dataRoot);
  onTestFinished(() => disposeTestStore(dataRoot, coreDb));
  ensureLocalUser(coreDb);
  const auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  async function signUp(label: string) {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: label,
          email: `${label}@example.test`,
          password: 'synthetic-inbound-password',
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id === body.user.id).toBe(true);
    return {
      userId: body.user.id as string,
      email: `${label}@example.test`,
      cookie,
      sessionId: session!.session.id,
    };
  }
  const administrator = await signUp('inventory-administrator');
  const owner = await signUp('inventory-owner');
  const other = await signUp('inventory-other');
  createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: administrator.userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: EXPIRY,
  });
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Credential inventory boundary');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: owner.userId });
  const app = createApp({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    auth,
    nanoHostStorage: { state: 'unavailable', owner: 'nanohost', reason: 'disabled' },
  });
  const request = (id: string, input: Record<string, unknown>, user = owner) =>
    app.request(`/api/app/operations/${id}`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  async function issue(user = owner) {
    const response = await request(
      'token.create',
      {
        forMcpClient: true,
        ownerUserId: user.userId,
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: EXPIRY,
      },
      administrator
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { token: string; record: { tokenId: string } };
  }
  const read = (token: string) =>
    app.request(
      ...operationRequest(
        'workspace.read',
        { workspaceId: workspace.id },
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
  return {
    coreDb,
    app,
    store,
    auth,
    administrator,
    owner,
    other,
    workspace,
    dataRoot,
    request,
    issue,
    read,
  };
}

describe('E11 unified inbound credential management', () => {
  it('lists only owned Tokens and AuthSessions without material, and revokes the owned client rotation family as an ordinary human', async () => {
    const f = await fixture();
    const first = await f.issue();
    const independent = await f.issue();
    const rotation = await f.request(
      'token.rotate',
      { tokenId: first.record.tokenId, graceSeconds: 3600 },
      f.administrator
    );
    expect(rotation.status).toBe(200);
    const rotated = await rotation.json();
    const listed = await f.request('credential.list', {});
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(
      text.includes(first.token) || text.includes(independent.token) || text.includes(rotated.token)
    ).toBe(false);
    expect(/tokenHash|issuerRef|sessionToken|password|cookie/.test(text)).toBe(false);
    const items = JSON.parse(text).items as Array<{
      kind: string;
      id: string;
      current?: boolean;
      integrationId?: string;
    }>;
    expect(
      items
        .filter((item) => item.kind === 'access-token')
        .map((item) => item.id)
        .sort()
    ).toEqual([first.record.tokenId, independent.record.tokenId, rotated.record.tokenId].sort());
    expect(
      items.find((item) => item.kind === 'access-token' && item.id === first.record.tokenId)
        ?.integrationId
    ).toBe(first.record.tokenId);
    expect(items.filter((item) => item.kind === 'auth-session')).toEqual([
      expect.objectContaining({ id: f.owner.sessionId, current: true }),
    ]);
    expect(items.some((item) => item.id === f.other.sessionId)).toBe(false);
    expect(
      (await f.request('credential.revoke', { kind: 'auth-session', id: f.other.sessionId })).status
    ).toBe(404);
    expect(
      (
        await f.request('credential.revoke', {
          kind: 'access-token',
          id: f.administrator.sessionId,
        })
      ).status
    ).toBe(400);
    expect(
      (await f.request('credential.revoke', { kind: 'access-token', id: first.record.tokenId }))
        .status
    ).toBe(200);
    expect((await f.read(first.token)).status).toBe(401);
    expect((await f.read(rotated.token)).status).toBe(401);
    expect((await f.read(independent.token)).status).toBe(200);
    const adminList = await f.request('credential.list', {}, f.administrator);
    expect(adminList.status).toBe(200);
    expect(
      (await adminList.json()).items.some(
        (item: { id: string }) => item.id === independent.record.tokenId
      )
    ).toBe(true);
  }, 30_000);

  it('revokes its own current AuthSession by non-secret id through the original owner', async () => {
    const f = await fixture();
    const before = await f.request('credential.list', {});
    expect(before.status).toBe(200);
    const response = await f.request('credential.revoke', {
      kind: 'auth-session',
      id: f.owner.sessionId,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'revoked' });
    expect(
      await f.auth.api.getSession({ headers: new Headers({ cookie: f.owner.cookie }) })
    ).toBeNull();
    expect((await f.request('credential.list', {})).status).toBe(401);
    expect((await f.request('credential.list', {}, f.other)).status).toBe(200);
  }, 30_000);
  it.each(['owner', 'administrator'] as const)(
    'withdraws a captured real %s session at the native effect owner after served self-revocation',
    async (role) => {
      const f = await fixture();
      const headers = new Headers({ cookie: f[role].cookie, origin: BASE });
      const session = await f.auth.api.getSession({ headers });
      expect(session).not.toBeNull();
      const sibling = await f.auth.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify({ email: f[role].email, password: 'synthetic-inbound-password' }),
        })
      );
      expect(sibling.status).toBe(200);
      const siblingCookie = sibling.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const siblingSession = await f.auth.api.getSession({
        headers: new Headers({ cookie: siblingCookie }),
      });
      expect(siblingSession).not.toBeNull();
      const derived = resolveSessionDeploymentAdminTokenId(f.coreDb, session!.user.id);
      const actor = {
        ...actorFromSession(session!),
        ...(derived ? { adminTokenId: derived } : {}),
      };
      const read = () =>
        currentWorkspaceAuthority(
          f.coreDb,
          f.workspace.id,
          { kind: 'user', id: f[role].userId },
          'workspace.read',
          true,
          actor,
          { mutating: false }
        );
      expect(read()).toBe(role === 'administrator' ? 'administrator' : 'member');
      const revoked = await f.auth.handler(
        new Request(`${BASE}/api/auth/revoke-session`, {
          method: 'POST',
          headers: { cookie: f[role].cookie, origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify({ token: session!.session.token }),
        })
      );
      expect(revoked.status).toBe(200);
      expect(await f.auth.api.getSession({ headers })).toBeNull();
      expect(read()).toBeNull();
      const operations = createCredentialOperationImplementations({
        coreDb: f.coreDb,
        mode: 'server',
      });
      await expect(
        operations['credential.revoke'](
          { kind: 'auth-session', id: siblingSession!.session.id },
          {
            kind: 'public',
            actor,
            actorRef: { kind: 'user', id: f[role].userId },
            scope: { kind: 'user' },
          }
        )
      ).rejects.toMatchObject({ status: 401, code: 'session_invalid' });
      expect(
        await f.auth.api.getSession({ headers: new Headers({ cookie: siblingCookie }) })
      ).not.toBeNull();
    }
  );

  it('keeps Worker-run credential actions held while the Gateway writer is unavailable', async () => {
    const f = await fixture();
    const app = createApp({
      mode: 'server',
      coreDb: f.coreDb,
      store: f.store,
      dataRoot: f.dataRoot,
      auth: f.auth,
      agentManifests: [],
      openKitConfig: {},
    });
    const invoke = (operation: string, input: unknown, cookie = f.owner.cookie) =>
      app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    const result = await invoke('credential.list', {});
    expect(result.status).toBe(200);
    const inventory = await result.json();
    expect(inventory.items.some(({ kind }: { kind: string }) => kind === 'worker-run')).toBe(false);
    const id = 'tu_00000000-0000-7000-8000-000000000001';
    for (const cookie of [f.owner.cookie, f.other.cookie]) {
      const refused = await invoke('credential.revoke', { kind: 'worker-run', id }, cookie);
      expect(refused.status).toBe(404);
    }
    expect(f.store.listCommandRequests().some(({ command }) => command === 'turn.interrupt')).toBe(
      false
    );
  });
});
