import {
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

  return betterAuth({
    baseURL,
    advanced: {
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
    },
    plugins: [
      {
        id: 'openkit-incomplete-bootstrap',
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
}
