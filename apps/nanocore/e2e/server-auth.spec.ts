import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';
import { cookieHeader, postJson } from './_lib/http.js';

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('nanocore e2e server auth', () => {
  it('signs up, signs in, calls protected routes, signs out, and returns typed 401', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });

    const signUpResponse = await postJson(`${harness.baseUrl}/api/auth/sign-up/email`, {
      email: 'server-auth@example.com',
      name: 'Server Auth',
      password: 'password123456',
    });
    expect(signUpResponse.status).toBe(200);

    const signInResponse = await postJson(`${harness.baseUrl}/api/auth/sign-in/email`, {
      email: 'server-auth@example.com',
      password: 'password123456',
    });
    expect(signInResponse.status).toBe(200);

    const cookie = cookieHeader(signInResponse);
    const workspacesResponse = await fetch(`${harness.baseUrl}/api/workspaces`, {
      headers: { cookie },
    });
    expect(workspacesResponse.status).toBe(200);

    const signOutResponse = await postJson(`${harness.baseUrl}/api/auth/sign-out`, {}, cookie);
    expect(signOutResponse.status).toBe(200);

    const afterSignOutResponse = await fetch(`${harness.baseUrl}/api/workspaces`, {
      headers: { cookie },
    });
    const afterSignOutBody = (await afterSignOutResponse.json()) as Record<string, unknown>;

    expect(afterSignOutResponse.status).toBe(401);
    expect(afterSignOutBody).toMatchObject({ code: 'core.auth.unauthenticated' });
  });

  it('persists accepted Workspace membership across restart and denies removed members', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });

    const ownerSignUp = await postJson(`${harness.baseUrl}/api/auth/sign-up/email`, {
      email: 'sharing-owner@example.com',
      name: 'Sharing Owner',
      password: 'password123456',
    });
    const editorSignUp = await postJson(`${harness.baseUrl}/api/auth/sign-up/email`, {
      email: 'sharing-editor@example.com',
      name: 'Sharing Editor',
      password: 'password123456',
    });
    expect([ownerSignUp.status, editorSignUp.status]).toEqual([200, 200]);

    const ownerCookie = cookieHeader(ownerSignUp);
    const editorCookie = cookieHeader(editorSignUp);
    const created = await postJson(
      `${harness.baseUrl}/api/workspaces`,
      {
        name: 'Restarted Shared Workspace',
        requestId: '10000000-0000-4000-8000-000000000001',
      },
      ownerCookie
    );
    const workspace = (await created.json()) as { id: string };
    expect(created.status).toBe(201);

    const invited = await postJson(
      `${harness.baseUrl}/api/app/workspaces/${workspace.id}/invitations`,
      {
        inviteeEmail: 'sharing-editor@example.com',
        proposedAccessLevel: 'editor',
        requestId: '10000000-0000-4000-8000-000000000002',
      },
      ownerCookie
    );
    const invitation = (await invited.json()) as {
      invitation: { invitationId: string; inviteeUserId: string; revision: number };
    };
    expect(invited.status).toBe(201);

    const discovered = await fetch(`${harness.baseUrl}/api/app/workspace-invitations`, {
      headers: { cookie: editorCookie },
    });
    const discoveredBody = (await discovered.json()) as {
      items: Array<{ invitationId: string; revision: number }>;
    };
    expect(discovered.status).toBe(200);
    expect(discoveredBody.items.map((item) => item.invitationId)).toContain(
      invitation.invitation.invitationId
    );

    const accepted = await postJson(
      `${harness.baseUrl}/api/app/workspace-invitations/${invitation.invitation.invitationId}/accept`,
      {
        expectedRevision: invitation.invitation.revision,
        requestId: '10000000-0000-4000-8000-000000000003',
      },
      editorCookie
    );
    expect(accepted.status).toBe(200);

    const dataRoot = harness.dataRoot;
    await harness.stop();
    harness = await startNanoCoreHarness({ coreMode: 'server', dataRoot });

    const editorWorkspaces = await fetch(`${harness.baseUrl}/api/app/workspaces`, {
      headers: { cookie: editorCookie },
    });
    const editorWorkspaceBody = (await editorWorkspaces.json()) as {
      items: Array<{ workspace: { id: string } }>;
    };
    expect(editorWorkspaces.status).toBe(200);
    expect(editorWorkspaceBody.items.map((item) => item.workspace.id)).toContain(workspace.id);

    const removed = await postJson(
      `${harness.baseUrl}/api/app/workspaces/${workspace.id}/members/${invitation.invitation.inviteeUserId}/remove`,
      {
        expectedRevision: 1,
        requestId: '10000000-0000-4000-8000-000000000004',
      },
      ownerCookie
    );
    expect(removed.status).toBe(200);

    const denied = await fetch(`${harness.baseUrl}/api/workspaces/${workspace.id}`, {
      headers: { cookie: editorCookie },
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });
});
