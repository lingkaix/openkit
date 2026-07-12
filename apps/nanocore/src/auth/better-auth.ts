import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { resolveBindHost, resolveBindPort } from '../config/bind-host.js';
import type { CoreMode } from '../config/mode.js';
import type { OpenKitConfig } from '../config/openkit-config.js';
import { type CoreDb, getCoreDb } from '../storage/db.js';
import * as betterAuthSchema from '../storage/schema/better-auth/index.js';

const LOCAL_DEVELOPMENT_SECRET = 'openkit-local-development-secret-at-least-32-characters';

/**
 * Resolves the Better Auth secret for one deployment mode.
 *
 * @param env Process environment containing the optional deployment secret.
 * @param mode Resolved deployment mode.
 * @returns Deployment secret or the local-only development fallback.
 * @throws Error when server mode has no strong deployment secret.
 */
export function resolveBetterAuthSecret(env: NodeJS.ProcessEnv, mode: CoreMode): string {
  const secret = env.BETTER_AUTH_SECRET ?? LOCAL_DEVELOPMENT_SECRET;

  if (mode === 'server' && (!env.BETTER_AUTH_SECRET || secret.trim().length < 32)) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters in server mode.');
  }

  return secret;
}

/**
 * Startup inputs owned by the NanoCore Better Auth adapter.
 */
interface CreateBetterAuthOptions {
  /** Environment overrides for deployment secrets and URL settings. */
  env?: NodeJS.ProcessEnv;
  /** Resolved deployment mode. */
  mode?: CoreMode;
  /** Startup operator config used for public URL, CORS, and sign-up policy. */
  openKitConfig?: OpenKitConfig;
}

/**
 * Creates a Better Auth instance backed by the Core Drizzle database.
 *
 * @param coreDb Core database handles to bind.
 * @param options Resolved startup mode, config, and environment.
 * @returns Better Auth server instance.
 * @throws Error when server mode has no strong deployment secret.
 */
export function createBetterAuth(
  coreDb: CoreDb = getCoreDb(),
  options: CreateBetterAuthOptions = {}
) {
  const env = options.env ?? process.env;
  const mode = options.mode ?? 'local';
  const config = options.openKitConfig ?? {};
  const secret = resolveBetterAuthSecret(env, mode);
  let baseURL = env.BETTER_AUTH_URL ?? config.server?.publicBaseUrl;

  if (!baseURL) {
    const bindHost = resolveBindHost(env, mode, config);
    const reachableHost =
      bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost === '::' ? '::1' : bindHost;
    const urlHost = reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost;
    baseURL = `http://${urlHost}:${resolveBindPort(env, config)}`;
  }

  return betterAuth({
    baseURL,
    database: drizzleAdapter(coreDb.db, {
      provider: 'sqlite',
      schema: betterAuthSchema,
    }),
    emailAndPassword: {
      disableSignUp: config.auth?.signup?.enabled === false,
      enabled: true,
    },
    secret,
    trustedOrigins: readTrustedOrigins(env, config),
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
 * @param config Loaded operator config.
 * @returns Trusted origins for browser auth requests.
 */
function readTrustedOrigins(env: NodeJS.ProcessEnv, config: OpenKitConfig): string[] {
  if (env.BETTER_AUTH_TRUSTED_ORIGINS === undefined) {
    return [...(config.server?.cors?.origins ?? [])];
  }

  return env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
