import { randomUUID } from 'node:crypto';
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

describe('nanocore e2e server workspace scoping', () => {
  it('keeps user-created workspaces scoped to the authenticated user', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });

    const firstCookie = await signUpAndCookie(harness.baseUrl, 'scope-a@example.com', 'Scope A');
    const secondCookie = await signUpAndCookie(harness.baseUrl, 'scope-b@example.com', 'Scope B');

    const createResponse = await postJson(
      `${harness.baseUrl}/api/workspaces`,
      { name: 'User A private workspace', requestId: randomUUID() },
      firstCookie
    );
    const createdWorkspace = (await createResponse.json()) as { id: string; name: string };
    const secondListResponse = await fetch(`${harness.baseUrl}/api/workspaces`, {
      headers: { cookie: secondCookie },
    });
    const secondList = (await secondListResponse.json()) as { items: Array<{ id: string }> };
    const secondGetResponse = await fetch(
      `${harness.baseUrl}/api/workspaces/${createdWorkspace.id}`,
      {
        headers: { cookie: secondCookie },
      }
    );
    const secondGetBody = (await secondGetResponse.json()) as { code: string };

    expect(createResponse.status).toBe(201);
    expect(secondList.items.map((workspace) => workspace.id)).not.toContain(createdWorkspace.id);
    expect(secondGetResponse.status).toBe(403);
    expect(secondGetBody.code).toBe('core.auth.scope_forbidden');
  });
});

/**
 * Creates a server-mode user and returns the session cookie.
 */
async function signUpAndCookie(baseUrl: string, email: string, name: string): Promise<string> {
  const response = await postJson(`${baseUrl}/api/auth/sign-up/email`, {
    email,
    name,
    password: 'password123456',
  });

  expect(response.status).toBe(200);

  return cookieHeader(response);
}
