import { getCurrentAuthContext } from '@better-auth/core/context';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { isRecord } from '@openkit/protocol';
import { createAdapterFactory } from 'better-auth/adapters';
import { APIError } from 'better-auth/api';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import * as schema from '../storage/schema/better-auth/index.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  BETTER_AUTH_REFUSALS,
  BetterAuthNativeError,
  type ControlBetterAuthActor,
  type ControlBetterAuthInput,
  ControlBetterAuthInputSchema,
} from './better-auth-codecs.js';

/** One awaited SDK SQL stage; the existing Core physical owner owns all preparation and acknowledgement. */
export async function commitBetterAuthStage(coreDb: CoreDb, input: ControlBetterAuthInput) {
  const context = await getCurrentAuthContext().catch(() => null);
  const authenticated =
    context?.method === 'POST' &&
    ((input.kind === 'profile-update' && context.path === '/update-user') ||
      (input.kind === 'account-password-update' && context.path === '/change-password') ||
      (input.kind === 'user-sessions-delete' &&
        ['/change-password', '/revoke-sessions'].includes(context.path ?? '')) ||
      (input.kind === 'session-delete' &&
        ['/revoke-session', '/revoke-other-sessions'].includes(context.path ?? '')));
  const virtualPassword =
    input.kind === 'credential-account-create' &&
    context?.method === 'POST' &&
    context.path === 'virtual:' &&
    context.context.session;
  let actor: ControlBetterAuthActor | undefined;
  if (authenticated || virtualPassword) {
    const current = context?.context.session;
    if (!current)
      throw new APIError('UNAUTHORIZED', { message: 'Unauthorized', code: 'UNAUTHORIZED' });
    actor = { userId: current.user.id, sessionToken: current.session.token };
  }
  const admitted = ControlBetterAuthInputSchema.parse({
    ...input,
    ...(actor ? { actor } : {}),
    ...(input.kind === 'session-delete' && context?.method === 'GET'
      ? { requireExpired: true }
      : {}),
    ...(input.kind === 'session-refresh' && context?.method === 'GET'
      ? { requireUnexpired: true }
      : {}),
  });
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  try {
    await client.open({
      database,
      path: scope.path,
      create: false,
      initialize: 'core',
      dataRoot: coreDb.dataRoot,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    return await client.betterAuth(database, admitted);
  } catch (error) {
    if (!(error instanceof BetterAuthNativeError)) throw error;
    const refusal = BETTER_AUTH_REFUSALS[error.code];
    throw new APIError(
      refusal.status === 403
        ? 'FORBIDDEN'
        : refusal.status === 401
          ? 'UNAUTHORIZED'
          : 'BAD_REQUEST',
      { message: refusal.message, ...('apiCode' in refusal ? { code: refusal.apiCode } : {}) }
    );
  }
}

/** Reuses SDK input/default/ID/output conversion while replacing every configured mutation, not its reads. */
export function nativeBetterAuthAdapter(coreDb: CoreDb, requireBootstrap: boolean) {
  const readFactory = drizzleAdapter(coreDb.db, { provider: 'sqlite', schema });
  const unsupported = () => {
    throw new Error('Authentication mutation has no configured owner.');
  };
  const mutationFactory = createAdapterFactory({
    config: {
      adapterId: 'drizzle',
      adapterName: 'Drizzle Adapter',
      supportsUUIDs: false,
      supportsJSON: false,
      supportsArrays: false,
      transaction: false,
      customTransformOutput: ({ data, fieldAttributes }) =>
        fieldAttributes.type === 'date' && data !== null && data !== undefined
          ? new Date(data)
          : data,
    },
    adapter: () => ({
      findOne: unsupported,
      findMany: unsupported,
      count: unsupported,
      create: async <T extends Record<string, unknown>>({
        model,
        data,
      }: {
        model: string;
        data: T;
      }) => {
        const input =
          model === 'users'
            ? { kind: 'human-create', record: data, requireBootstrap }
            : model === 'session'
              ? { kind: 'session-create', record: data }
              : model === 'account'
                ? { kind: 'credential-account-create', record: data }
                : unsupported();
        const result = await commitBetterAuthStage(
          coreDb,
          ControlBetterAuthInputSchema.parse(input)
        );
        // The SDK factory owns the generic selected/output mapping; this wire returns the exact table row.
        return result.kind === 'mutation' || result.record === null
          ? unsupported()
          : (result.record as unknown as T);
      },
      update: async <T>({
        model,
        where,
        update: value,
      }: {
        model: string;
        where: Parameters<typeof predicate>[0];
        update: T;
      }) => {
        if (!isRecord(value)) return unsupported();
        const update = value;
        const keys = Object.keys(update).filter((key) => update[key] !== undefined);
        const exact = (allowed: string[]) => keys.every((key) => allowed.includes(key));
        let input: unknown;
        if (model === 'session' && exact(['expiresAt', 'updatedAt'])) {
          input = { kind: 'session-refresh', token: predicate(where, 'token'), ...update };
        } else if (model === 'users' && exact(['displayName', 'image', 'updatedAt'])) {
          input = { kind: 'profile-update', userId: predicate(where, 'id'), ...update };
        } else if (model === 'users' && exact(['email', 'emailVerified', 'updatedAt'])) {
          const email = predicate(where, 'email');
          input =
            update.email === undefined
              ? { kind: 'user-mark-verified', email, updatedAt: update.updatedAt }
              : {
                  kind: 'user-address-replace',
                  email,
                  nextEmail: update.email,
                  emailVerified: update.emailVerified,
                  updatedAt: update.updatedAt,
                };
          if (update.email === undefined && update.emailVerified !== true) unsupported();
        } else if (model === 'account' && exact(['password', 'updatedAt'])) {
          input = { kind: 'account-password-update', accountId: predicate(where, 'id'), ...update };
        } else return unsupported();
        const result = await commitBetterAuthStage(
          coreDb,
          ControlBetterAuthInputSchema.parse(input)
        );
        return result.kind === 'mutation' ? unsupported() : (result.record as T | null);
      },
      updateMany: async ({ model, where, update }) => {
        if (
          model !== 'account' ||
          Object.keys(update).some((key) => !['password', 'updatedAt'].includes(key))
        )
          return unsupported();
        if (where.length !== 2) return unsupported();
        const userId = predicate(
          where.filter((item) => item.field === 'userId'),
          'userId'
        );
        if (
          predicate(
            where.filter((item) => item.field === 'providerId'),
            'providerId'
          ) !== 'credential'
        )
          return unsupported();
        const result = await commitBetterAuthStage(
          coreDb,
          ControlBetterAuthInputSchema.parse({ kind: 'user-passwords-update', userId, ...update })
        );
        // The configured SDK ignores this return; its adapter interface declares an affected-row count.
        if (result.kind !== 'mutation') return unsupported();
        return result.changes;
      },
      delete: async ({ model, where }) => {
        const input =
          model === 'session'
            ? { kind: 'session-delete', token: predicate(where, 'token') }
            : model === 'verification'
              ? { kind: 'verification-delete', identifier: predicate(where, 'identifier') }
              : unsupported(); // Account deletion is owned by the existing before hook with its original endpoint facts.
        await commitBetterAuthStage(coreDb, ControlBetterAuthInputSchema.parse(input));
      },
      deleteMany: async ({ model, where }) => {
        const input =
          model === 'session'
            ? { kind: 'user-sessions-delete', userId: predicate(where, 'userId') }
            : model === 'verification'
              ? {
                  kind: 'expired-verifications-delete',
                  before: predicate(where, 'expiresAt', 'lt'),
                }
              : unsupported();
        const result = await commitBetterAuthStage(
          coreDb,
          ControlBetterAuthInputSchema.parse(input)
        );
        return result.kind === 'mutation' ? result.changes : unsupported();
      },
      consumeOne: unsupported,
    }),
  });
  return (options: Parameters<typeof readFactory>[0]) => {
    const reads = readFactory(options);
    const writes = mutationFactory(options);
    const adapter: typeof reads = {
      ...reads,
      create: writes.create,
      update: writes.update,
      updateMany: writes.updateMany,
      delete: writes.delete,
      deleteMany: writes.deleteMany,
      consumeOne: writes.consumeOne,
      // The SDK's existing as-is transaction has separate commits; it must receive this adapter.
      transaction: async (callback) => callback(adapter),
    };
    return adapter;
  };
}

/** Classifies one exact configured predicate locally; no generic predicate crosses the wire. */
function predicate(
  where: {
    field: string;
    value: unknown;
    operator?: string | undefined;
    connector?: string | undefined;
    mode?: string | undefined;
  }[],
  field: string,
  operator = 'eq'
): unknown {
  const item = where[0];
  if (
    where.length !== 1 ||
    item?.field !== field ||
    (item.operator ?? 'eq') !== operator ||
    (item.connector ?? 'AND') !== 'AND' ||
    (item.mode ?? 'sensitive') !== 'sensitive'
  ) {
    throw new Error('Authentication predicate has no configured owner.');
  }
  return item.value;
}
