import { randomUUID } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { callbackFixture as fixture } from '../storage/test-support/better-auth-native.js';

describe('configured BetterAuth native writer', () => {
  it.each(['verify', 'replace-unverified', 'replace-verified'] as const)(
    'retains the signed callback stage: %s',
    async (branch) => {
      const f = await fixture();
      const user = await f.signUp();
      const replacement = `${randomUUID()}@example.test`;
      const token = await createEmailVerificationToken(
        f.context.secret,
        user.email.toUpperCase(),
        branch === 'verify' ? undefined : replacement,
        3600,
        branch === 'replace-verified' ? { requestType: 'change-email-verification' } : undefined
      );
      const response = await f.request(`/verify-email?token=${encodeURIComponent(token)}`);
      expect(response.status).toBe(200);
      const row = f.readEmailVerification(user.id);
      expect(row).toEqual({
        email: branch === 'verify' ? user.email : replacement,
        email_verified: branch === 'replace-unverified' ? 0 : 1,
      });
      expect(f.count('session')).toBe(branch === 'verify' ? 1 : 2);
    }
  );
});
