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
});
