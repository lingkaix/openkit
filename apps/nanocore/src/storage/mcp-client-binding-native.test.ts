// openkit-test-platform: posix
// Pre-producer native E11 oracles. No calculator, constructed Actor, allowing Kernel or SQL grant.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { z } from 'zod';
import { createApp } from '../app.js';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureLocalUser } from '../auth/identity.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';

const BASE = 'http://localhost:3000';
const EXPIRY = '2999-01-01T00:00:00.000Z';
type OperationId = Parameters<typeof operationRequest>[0];
type TokenIssue = {
  token: string;
  record: {
    tokenId: string;
    ownerUserId: string;
    scope: string;
    workspaceIds: string[];
  };
};

async function fixture() {
  const dataRoot = mkdtempSync(joinPath(tmpdir(), 'openkit-e11-native-client-'));
  const coreDb = createTestCoreDb(dataRoot);
  onTestFinished(async () => await disposeTestStore(dataRoot, coreDb));
  // Fresh local identity is initialized by its ORIGINAL native owner, never an invented request Actor.
  await ensureLocalUser(coreDb);
  const auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  async function signUp(label: string) {
    const email = `${label}-${randomUUID()}@example.test`;
    const response = await auth.handler(
      new Request(BASE + '/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({
          name: label,
          email,
          password: 'synthetic-native-client-password',
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.user.id).toBe('string');
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie.length).toBeGreaterThan(0);
    // Original issuer-fixture bootstrap owner. All tested issuance still uses real token.create SDK admission.
    const bootstrap = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: body.user.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: EXPIRY,
    });
    return { userId: body.user.id as string, email, cookie, bootstrap };
  }
  const issuer = await signUp('issuer');
  const owner = await signUp('owner');
  const otherIssuer = await signUp('other-issuer');
  const store = createTestStore({ dataRoot });
  const app = createApp({ mode: 'server', coreDb, dataRoot, store, auth });
  const session = (user: typeof issuer) => ({ cookie: user.cookie });
  const bearer = (token: string) => ({ authorization: 'Bearer ' + token });
  const request = (id: OperationId, input: Record<string, unknown>, headers: HeadersInit) =>
    app.request(...operationRequest(id, {}, { headers, body: JSON.stringify(input) }));
  async function command<K extends OperationId>(
    id: K,
    input: Record<string, unknown>,
    headers: HeadersInit
  ): Promise<z.output<(typeof OPERATION_DEFINITIONS)[K]['outputSchema']>> {
    const response = await request(id, input, headers);
    expect(
      response.status,
      `${id}: ${response.status === OPERATION_DEFINITIONS[id].successStatus ? '' : await response.clone().text()}`
    ).toBe(OPERATION_DEFINITIONS[id].successStatus);
    return OPERATION_DEFINITIONS[id].outputSchema.parse(await response.json()) as z.output<
      (typeof OPERATION_DEFINITIONS)[K]['outputSchema']
    >;
  }
  const workspace = await command(
    'workspace.create',
    { name: 'Native shared client boundary', requestId: randomUUID() },
    session(issuer)
  );
  const outside = await command(
    'workspace.create',
    { name: 'Owner workspace outside Token binding', requestId: randomUUID() },
    session(owner)
  );
  async function join(user: typeof owner) {
    const invited = await command(
      'workspace.invitation-create',
      {
        workspaceId: workspace.id,
        inviteeEmail: user.email,
        requestId: randomUUID(),
      },
      session(issuer)
    );
    await command(
      'workspace.my-invitation-accept',
      {
        invitationId: invited.invitation.invitationId,
        expectedRevision: invited.invitation.revision,
        requestId: randomUUID(),
      },
      session(user)
    );
  }
  // Real native invitation/acceptance: no SQL membership or Policy allow is inserted.
  await join(owner);
  await join(otherIssuer);
  async function issue(
    patch: Record<string, unknown> = {},
    headers: HeadersInit = session(issuer)
  ): Promise<TokenIssue> {
    return (await command(
      'token.create',
      {
        ownerUserId: owner.userId,
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: EXPIRY,
        ...patch,
      },
      headers
    )) as TokenIssue;
  }
  const read = (token: string, workspaceId = workspace.id) =>
    request('workspace.read', { workspaceId }, bearer(token));
  function privateRecord(tokenId: string) {
    const record = getOpenKitAccessTokenRecord(coreDb, tokenId);
    expect(record).not.toBeNull();
    return record!;
  }
  function principal(tokenId: string) {
    const value = Reflect.get(privateRecord(tokenId), 'principalRef');
    expect(value).toMatchObject({
      kind: 'integration',
      id: expect.any(String),
    });
    expect(value.id.length).toBeGreaterThan(0);
    expect(value.id).not.toBe(owner.userId);
    return value as { kind: 'integration'; id: string };
  }
  async function message(token: string, method: string, params: unknown) {
    return await app.request(BASE + '/mcp', {
      method: 'POST',
      headers: {
        ...bearer(token),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method,
        params,
      }),
    });
  }
  async function nativeMcpEffect(
    token: TokenIssue,
    expected: { kind: 'integration' | 'user'; id: string }
  ) {
    const requestId = randomUUID();
    const name = 'Actual client Thread ' + requestId;
    const response = await message(token.token, 'tools/call', {
      name: 'openkit_call',
      arguments: {
        operation: 'thread.create',
        // Private Assistant entry intentionally reuses its existing timeline;
        // this oracle requests a distinct formal Workspace Thread effect.
        input: { workspaceId: workspace.id, requestId, name, visibility: 'workspace' },
      },
    });
    expect(response.status).toBe(200);
    const rpc = await response.json();
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).not.toBe(true);
    const rows = store.listThreads(workspace.id).filter((thread) => thread.name === name);
    expect(rows, `Actual MCP thread.create response: ${JSON.stringify(rpc)}`).toHaveLength(1);
    expect(store.getThread(workspace.id, rows[0]!.id).name).toBe(name);
    // ORIGINAL native separate request-Audit owner, queried through the actual existing reader.
    const audit = listServerAuditEvents(coreDb).find(
      (event) => event.action === 'remote-mcp.request' && event.requestId === requestId
    );
    expect(audit).toMatchObject({
      actor:
        expected.kind === 'integration'
          ? {
              kind: 'integration',
              id: expected.id,
              responsibleUserId: owner.userId,
            }
          : { kind: 'user', id: expected.id },
      authentication: {
        credentialKind: 'token',
        credentialId: token.record.tokenId,
      },
      resource: 'operation:thread.create',
      outcome: 'succeeded',
    });
    expect(JSON.stringify(audit)).not.toContain(token.token);
    // The actual command's native Audit must agree too, not merely its MCP envelope.
    const commands = await command(
      'audit.workspace-list',
      { workspaceId: workspace.id, limit: 100 },
      session(issuer)
    );
    expect(
      commands.auditEvents.find(
        (event) => event.action === 'thread.create' && event.requestId === requestId
      )
    ).toMatchObject({ actor: audit!.actor, threadId: rows[0]!.id, outcome: 'succeeded' });
    return audit!;
  }
  return {
    coreDb,
    auth,
    app,
    store,
    issuer,
    owner,
    otherIssuer,
    workspace,
    outside,
    session,
    bearer,
    request,
    command,
    issue,
    read,
    privateRecord,
    principal,
    message,
    nativeMcpEffect,
  };
}

describe('E11 original native MCP client binding and issuer-chain consumers', () => {
  it('selects a distinct native Integration principal, attributes real MCP effects on behalf of its current owner, and keeps Token restrictions mandatory', async () => {
    const f = await fixture();
    const writer = await f.issue({ forMcpClient: true });
    const client = f.principal(writer.record.tokenId);
    expect(writer.record.ownerUserId).toBe(f.owner.userId);
    expect(Reflect.get(f.privateRecord(writer.record.tokenId), 'issuerRef')).toEqual({
      kind: 'user',
      id: f.issuer.userId,
    });
    const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, writer.token);
    expect(verified?.tokenId).toBe(writer.record.tokenId);
    expect(Reflect.get(verified!, 'principalRef')).toEqual(
      Reflect.get(f.privateRecord(writer.record.tokenId), 'principalRef')
    );
    expect((await f.read(writer.token)).status).toBe(200);
    await f.nativeMcpEffect(writer, client);
    // Owner really owns outside, but that cannot widen the authenticating Token's binding.
    expect((await f.read(writer.token, f.outside.id)).status).toBe(403);
    const readonly = await f.issue({
      forMcpClient: true,
      scope: 'workspace-readonly',
    });
    const other = f.principal(readonly.record.tokenId);
    expect(other.id).not.toBe(client.id);
    expect((await f.read(readonly.token)).status).toBe(200);
    const forbiddenName = 'Readonly must not create ' + randomUUID();
    expect(
      (
        await f.request(
          'thread.create',
          {
            workspaceId: f.workspace.id,
            name: forbiddenName,
            requestId: randomUUID(),
          },
          f.bearer(readonly.token)
        )
      ).status
    ).toBe(403);
    expect(
      f.store.listThreads(f.workspace.id).filter((thread) => thread.name === forbiddenName)
    ).toHaveLength(0);
    expect(
      (
        await f.request(
          'token.create',
          {
            ownerUserId: f.owner.userId,
            forMcpClient: true,
            scope: 'server-admin',
            workspaceIds: [],
            expiresAt: EXPIRY,
          },
          f.session(f.issuer)
        )
      ).status
    ).toBe(400);
    expect(
      (
        await f.request(
          'token.create',
          {
            ownerUserId: f.owner.userId,
            forMcpClient: true,
            principalId: f.owner.userId,
            scope: 'workspace',
            workspaceIds: [f.workspace.id],
            expiresAt: EXPIRY,
          },
          f.session(f.issuer)
        )
      ).status
    ).toBe(400);
    const members = await f.command(
      'workspace.member-list',
      { workspaceId: f.workspace.id },
      f.session(f.issuer)
    );
    const member = members.items.find((item: { userId: string }) => item.userId === f.owner.userId);
    expect(member).toBeDefined();
    await f.command(
      'workspace.member-remove',
      {
        workspaceId: f.workspace.id,
        targetUserId: f.owner.userId,
        expectedRevision: member!.revision,
        requestId: randomUUID(),
      },
      f.session(f.issuer)
    );
    // The User and its real administrator session still exist; the client cannot borrow that credential.
    expect(
      (
        await f.auth.api.getSession({
          headers: new Headers(f.session(f.owner)),
        })
      )?.user.id
    ).toBe(f.owner.userId);
    expect(
      (await f.request('workspace.read', { workspaceId: f.workspace.id }, f.session(f.owner)))
        .status
    ).toBe(200);
    expect((await f.read(writer.token)).status).toBe(403);
    expect((await f.read(readonly.token)).status).toBe(403);
    expect(
      (await f.request('workspace.read', { workspaceId: f.workspace.id }, f.session(f.issuer)))
        .status
    ).toBe(200);
  }, 30_000);

  it('preserves client identity across real rotation and stops a descendant at an actual ancestor Token revoke or disabled issuer User', async () => {
    const f = await fixture();
    const ancestor = await f.issue({
      ownerUserId: f.issuer.userId,
      scope: 'server-admin',
      workspaceIds: [],
    });
    expect(Reflect.get(f.privateRecord(ancestor.record.tokenId), 'issuerRef')).toEqual({
      kind: 'user',
      id: f.issuer.userId,
    });
    const intermediate = await f.issue(
      { ownerUserId: f.issuer.userId, scope: 'server-admin', workspaceIds: [] },
      f.bearer(ancestor.token)
    );
    const child = await f.issue({ forMcpClient: true }, f.bearer(intermediate.token));
    const principal = f.principal(child.record.tokenId);
    expect(Reflect.get(f.privateRecord(intermediate.record.tokenId), 'issuerRef')).toEqual({
      kind: 'token',
      id: ancestor.record.tokenId,
    });
    expect(Reflect.get(f.privateRecord(child.record.tokenId), 'issuerRef')).toEqual({
      kind: 'token',
      id: intermediate.record.tokenId,
    });
    expect((await f.read(child.token)).status).toBe(200);
    const rotated = (await f.command(
      'token.rotate',
      { tokenId: child.record.tokenId, graceSeconds: 0 },
      f.session(f.owner)
    )) as TokenIssue & { rotatedRecord: { tokenId: string } };
    expect(rotated.record.tokenId).not.toBe(child.record.tokenId);
    expect(rotated.rotatedRecord.tokenId).toBe(child.record.tokenId);
    expect(f.principal(rotated.record.tokenId)).toEqual(principal);
    expect(Reflect.get(f.privateRecord(rotated.record.tokenId), 'issuerRef')).toEqual({
      kind: 'token',
      id: intermediate.record.tokenId,
    });
    expect((await f.read(rotated.token)).status).toBe(200);
    await f.nativeMcpEffect(rotated, principal);
    await f.command('token.revoke', { tokenId: ancestor.record.tokenId }, f.session(f.issuer));
    expect((await f.read(rotated.token)).status).toBe(401);
    expect((await f.message(rotated.token, 'tools/list', {})).status).toBe(401);
    // Separate branch: a DIFFERENT issuer User becomes disabled while Token owner remains current.
    const userChild = await f.issue({ forMcpClient: true }, f.session(f.otherIssuer));
    f.principal(userChild.record.tokenId);
    expect(Reflect.get(f.privateRecord(userChild.record.tokenId), 'issuerRef')).toEqual({
      kind: 'user',
      id: f.otherIssuer.userId,
    });
    expect((await f.read(userChild.token)).status).toBe(200);
    await f.command(
      'user.disable',
      { targetUserId: f.otherIssuer.userId, requestId: randomUUID() },
      f.session(f.issuer)
    );
    expect((await f.read(userChild.token)).status).toBe(401);
    expect((await f.message(userChild.token, 'tools/list', {})).status).toBe(401);
    expect(
      (
        await f.auth.api.getSession({
          headers: new Headers(f.session(f.owner)),
        })
      )?.user.id
    ).toBe(f.owner.userId);
    const ownerControl = await f.issue();
    expect((await f.read(ownerControl.token)).status).toBe(200);
  }, 30_000);

  it('keeps genuine legacy NULL-principal/NULL-issuer and ordinary non-client Tokens on their existing User boundary', async () => {
    const f = await fixture();
    // The original Token owner builder supplies an actual retained legacy row, never a fabricated Actor.
    const legacy = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.owner.userId,
      scope: 'workspace',
      workspaceIds: [f.workspace.id],
      expiresAt: EXPIRY,
    });
    expect(Reflect.get(f.privateRecord(legacy.tokenId), 'issuerRef')).toBeNull();
    expect(Reflect.get(f.privateRecord(legacy.tokenId), 'principalRef')).toBeNull();
    const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, legacy.secret);
    expect(verified?.tokenId).toBe(legacy.tokenId);
    expect((await f.read(legacy.secret)).status).toBe(200);
    expect((await f.read(legacy.secret, f.outside.id)).status).toBe(403);
    await f.nativeMcpEffect(
      { token: legacy.secret, record: legacy.record },
      { kind: 'user', id: f.owner.userId }
    );
    const ordinary = await f.issue();
    expect(Reflect.get(f.privateRecord(ordinary.record.tokenId), 'principalRef')).toBeNull();
    expect(Reflect.get(f.privateRecord(ordinary.record.tokenId), 'issuerRef')).toEqual({
      kind: 'user',
      id: f.issuer.userId,
    });
    expect((await f.read(ordinary.token)).status).toBe(200);
    await f.nativeMcpEffect(ordinary, { kind: 'user', id: f.owner.userId });
  }, 30_000);
});
