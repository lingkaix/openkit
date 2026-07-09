import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { type CoreDb, getCoreDb } from '../storage/db.js';
import * as betterAuthSchema from '../storage/schema/better-auth/index.js';

const LOCAL_DEVELOPMENT_SECRET = 'openkit-local-development-secret-at-least-32-characters';

/**
 * Creates a Better Auth instance backed by the Core Drizzle database.
 *
 * @param coreDb Core database handles to bind.
 * @returns Better Auth server instance.
 */
export function createBetterAuth(coreDb: CoreDb = getCoreDb()) {
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:3000',
    database: drizzleAdapter(coreDb.db, {
      provider: 'sqlite',
      schema: betterAuthSchema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    secret: process.env.BETTER_AUTH_SECRET ?? LOCAL_DEVELOPMENT_SECRET,
    trustedOrigins: readTrustedOrigins(process.env),
    user: {
      modelName: 'users',
      fields: {
        name: 'displayName',
        emailVerified: 'emailVerified',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
      additionalFields: {
        kind: {
          type: ['local', 'human'],
          required: false,
          defaultValue: 'human',
          input: false,
        },
        lastSeenAt: {
          type: 'string',
          required: false,
          input: false,
        },
      },
    },
  });
}

/**
 * Reads comma-separated Better Auth browser origins from the environment.
 *
 * @param env Process environment.
 * @returns Trusted origins for browser auth requests.
 */
function readTrustedOrigins(env: NodeJS.ProcessEnv): string[] {
  return (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
