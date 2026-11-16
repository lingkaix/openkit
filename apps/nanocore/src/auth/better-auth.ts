import { isProduction as betterAuthProduction } from '@better-auth/core/env';
import {
  HumanCreationPasswordInputLimitSchema,
  HumanDisplayNameInputLimitSchema,
  HumanEmailInputLimitSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { resolveBindHost, resolveBindPort } from '../config/bind-host.js';
import type { CoreMode } from '../config/mode.js';
import type { OpenKitConfig } from '../config/openkit-config.js';
import { type CoreDb, getCoreDb } from '../storage/db.js';
import { commitBetterAuthStage, nativeBetterAuthAdapter } from './better-auth-adapter.js';
import { isServerBootstrapComplete } from './bootstrap-token.js';
import { createSignInLimiter, SIGN_IN_SOURCE_HEADER, signInSource } from './sign-in-limiter.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

const LOCAL_DEVELOPMENT_SECRET = 'openkit-local-development-secret-at-least-32-characters';

/** Today's refusal while server bootstrap has not been consumed. */
function refuseIncompleteServerBootstrap(): never {
  throw new APIError('FORBIDDEN', { message: 'Server bootstrap is incomplete.' });
}

/** Refuses oversized public fields before SDK native writes without changing its scalar/type policy. */
function enforceHumanInputLimits(input: { name?: unknown; email?: unknown }): void {
  for (const [value, schema] of [
    [input.name, HumanDisplayNameInputLimitSchema],
    [input.email, HumanEmailInputLimitSchema],
  ] as const) {
    if (typeof value !== 'string') continue;
    const result = schema.safeParse(value);
    if (!result.success)
      throw new APIError('BAD_REQUEST', {
        message: result.error.issues[0]?.message ?? 'Human input exceeds its declared limit.',
      });
  }
}

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
  /** Ensures product-owned personal scope before an active user's new session is recorded. */
  onActiveUserSession?: (userId: string) => Promise<void>;
}

/**
 * Creates Better Auth with Core Drizzle reads and acknowledged native mutation stages.
 *
 * @param coreDb Core database handles to bind.
 * @param options Resolved startup mode, config, and environment.
 * @returns Better Auth server instance.
 * @throws Error when server mode has no strong deployment secret or active-user scope setup fails.
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

  const trustedOrigins = [...(config.server?.cors?.origins ?? [])];
  const browserOrigins = [new URL(baseURL).origin, ...trustedOrigins];

  const limiter = createSignInLimiter(coreDb);
  const auth = betterAuth({
    baseURL,
    rateLimit: {
      enabled: true,
      storage: 'memory',
      // The SDK otherwise enables only in production and limits sign-in to 3 per 10 seconds.
      customRules: {
        '/sign-in/*': { window: 900, max: 50 },
        // Preserve the SDK's production limits on other authentication routes.
        ...(!betterAuthProduction ? { '/**': false as const } : {}),
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [SIGN_IN_SOURCE_HEADER], ipv6Subnet: 128 },
      trustedProxyHeaders: false,
      database: {
        generateId: ({ model }) => {
          // Better Auth uses logical names; the adapter can also pass the configured table name.
          switch (model) {
            case 'user':
            case 'users':
              return allocateEntityId('usr');
            case 'session':
            case 'sessions':
              return allocateEntityId('auth');
            case 'account':
            case 'accounts':
              return allocateEntityId('acct');
            case 'verification':
            case 'verifications':
              return allocateEntityId('verif');
            default:
              throw new Error('Authentication model has no identifier owner.');
          }
        },
      },
    },
    database: nativeBetterAuthAdapter(coreDb, mode === 'server'),
    databaseHooks: {
      account: {
        delete: {
          before: async (account, context) => {
            const current = context?.context.session;
            if (!current)
              throw new APIError('UNAUTHORIZED', { message: 'Unauthorized', code: 'UNAUTHORIZED' });
            await commitBetterAuthStage(coreDb, {
              kind: 'account-unlink',
              accountId: account.id,
              userId: current.user.id,
              sessionToken: current.session.token,
              freshAgeSeconds: context.context.sessionConfig.freshAge,
              allowUnlinkingAll:
                context.context.options.account?.accountLinking?.allowUnlinkingAll ?? false,
            });
            // The SDK ignores deleteAccount's return. Suppress its default writer only after FULL ACK.
            return false;
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (mode === 'server' && !isServerBootstrapComplete(coreDb)) {
              refuseIncompleteServerBootstrap();
            }
            enforceHumanInputLimits(user);
          },
        },
        update: {
          before: async (user) => {
            // Keep SDK session admission first and do not revalidate retained email on a profile edit.
            enforceHumanInputLimits({ name: user.name });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (!isCanonicalUserActive(coreDb, session.userId)) {
              throw new APIError('FORBIDDEN', { message: 'User is disabled.' });
            }
            await options.onActiveUserSession?.(session.userId);
          },
        },
      },
    },
    emailAndPassword: {
      disableSignUp: config.auth?.signup?.enabled === false,
      enabled: true,
      // Creation is bounded below; verification must still accept retained passwords.
      maxPasswordLength: Number.MAX_SAFE_INTEGER,
    },
    plugins: [
      {
        id: 'openkit-auth-inputs',
        hooks: {
          before: [
            {
              matcher: (context) => context.path === '/sign-up/email',
              handler: createAuthMiddleware(async () => {
                // disableSignUp rejects inside the route, before the user-create hook.
                if (mode === 'server' && !isServerBootstrapComplete(coreDb)) {
                  refuseIncompleteServerBootstrap();
                }
              }),
            },
            {
              matcher: (context) =>
                // Server-only setPassword has no public path in the hook context.
                context.path === undefined ||
                ['/sign-up/email', '/change-password', '/reset-password'].includes(context.path),
              handler: createAuthMiddleware(async (context) => {
                const value =
                  context.path === '/sign-up/email'
                    ? context.body?.password
                    : context.body?.newPassword;
                if (typeof value !== 'string') return;
                const result = HumanCreationPasswordInputLimitSchema.safeParse(value);
                if (!result.success)
                  throw new APIError('BAD_REQUEST', {
                    message: result.error.issues[0]?.message ?? 'New password is too long.',
                    code: 'PASSWORD_TOO_LONG',
                  });
              }),
            },
          ],
        },
      },
      {
        id: 'openkit-configured-origins',
        init: (context) => {
          // The SDK recomputes ambient origins on its shared context before each HTTP request.
          // Keep the operator snapshot fixed, including while another request awaits its body.
          Object.defineProperty(context, 'trustedOrigins', {
            enumerable: true,
            get: () => [...browserOrigins],
            set: () => {
              // SDK recomputation cannot replace the validated deployment snapshot.
            },
          });
        },
      },
    ],
    secret,
    trustedOrigins,
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
        status: {
          type: ['active', 'disabled'],
          required: false,
          defaultValue: 'active',
          input: false,
        },
        disabledAt: {
          type: 'string',
          required: false,
          input: false,
        },
      },
    },
  });
  const handle = auth.handler;
  return Object.assign(auth, {
    /** Supplies the SDK only a transport-derived source, with explicit administrator proxy trust. */
    async handler(request: Request, peerAddress?: string): Promise<Response> {
      const source = signInSource(request, peerAddress, config.auth?.trustedProxyHops ?? 0);
      const headers = new Headers(request.headers);
      headers.delete(SIGN_IN_SOURCE_HEADER);
      headers.delete('x-forwarded-for');
      headers.delete('x-real-ip');
      headers.delete('forwarded');
      // An unavailable transport peer shares a conservative bucket, never an SDK limiter bypass.
      headers.set(SIGN_IN_SOURCE_HEADER, source ?? '0.0.0.0');
      const trusted = new Request(request, { headers });
      const signIn =
        new URL(trusted.url).pathname.replace(/\/+$/, '') === '/api/auth/sign-in/email';
      const account = signIn ? await limiter.account(trusted) : null;
      const retryAfter = signIn ? limiter.admit(account) : null;
      if (retryAfter !== null)
        return Response.json(
          { message: 'Too many requests. Please try again later.' },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      const response = await handle(trusted);
      if (signIn && response.status === 401) await limiter.failure(account, source);
      if (response.status === 429 && !response.headers.has('retry-after')) {
        response.headers.set('Retry-After', response.headers.get('x-retry-after') ?? '900');
      }
      return response;
    },
  });
}
