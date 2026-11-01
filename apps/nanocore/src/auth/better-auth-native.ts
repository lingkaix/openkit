import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { assertControlProductWriter } from '../storage/control-store-products.js';
import type { CoreDb } from '../storage/db.js';
import { account, session, users, verification } from '../storage/schema/better-auth/index.js';
import {
  BetterAuthNativeError,
  type ControlBetterAuthActor,
  type ControlBetterAuthInput,
  type ControlBetterAuthResult,
} from './better-auth-codecs.js';
import { isServerBootstrapComplete } from './bootstrap-token.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

/** Applies one configured SDK stage in the existing native Core savepoint, without async callbacks. */
export function applyControlBetterAuth(
  coreDb: CoreDb,
  input: ControlBetterAuthInput
): ControlBetterAuthResult {
  assertControlProductWriter(coreDb.sqlite);
  const db = coreDb.db;
  const actor = 'actor' in input ? input.actor : undefined;
  if (actor) {
    requireCurrentSession(coreDb, actor);
    const targetUser =
      'userId' in input
        ? input.userId
        : input.kind === 'credential-account-create'
          ? input.record.userId
          : undefined;
    if (targetUser !== undefined && targetUser !== actor.userId)
      throw new BetterAuthNativeError('session_invalid');
  }
  switch (input.kind) {
    case 'human-create':
      if (input.requireBootstrap && !isServerBootstrapComplete(coreDb))
        throw new BetterAuthNativeError('bootstrap_incomplete');
      return {
        kind: 'user',
        record: db.insert(users).values(input.record).returning().get() ?? null,
      };
    case 'credential-account-create':
      if (
        actor &&
        db
          .select()
          .from(account)
          .where(eq(account.userId, actor.userId))
          .limit(100)
          .all()
          .some((row) => row.providerId === 'credential' && row.password)
      )
        throw new BetterAuthNativeError('password_already_set');
      return {
        kind: 'account',
        record: db.insert(account).values(input.record).returning().get() ?? null,
      };
    case 'session-create':
      if (!isCanonicalUserActive(coreDb, input.record.userId))
        throw new BetterAuthNativeError('user_disabled');
      return {
        kind: 'session',
        record: db.insert(session).values(input.record).returning().get() ?? null,
      };
    case 'session-refresh':
      return {
        kind: 'session',
        record:
          db
            .update(session)
            .set({ expiresAt: input.expiresAt, updatedAt: input.updatedAt })
            .where(
              and(
                eq(session.token, input.token),
                input.requireUnexpired ? gte(session.expiresAt, new Date()) : undefined
              )
            )
            .returning()
            .get() ?? null,
      };
    case 'profile-update':
      return {
        kind: 'user',
        record:
          db
            .update(users)
            .set({
              displayName: input.displayName === undefined ? undefined : sql`${input.displayName}`,
              image: input.image === undefined ? undefined : sql`${input.image}`,
              updatedAt: input.updatedAt,
            })
            .where(eq(users.id, input.userId))
            .returning()
            .get() ?? null,
      };
    case 'account-password-update':
      if (actor) {
        const selected = db.select().from(account).where(eq(account.id, input.accountId)).get();
        if (
          !selected ||
          selected.userId !== actor.userId ||
          selected.providerId !== 'credential' ||
          !selected.password
        )
          throw new BetterAuthNativeError('credential_account_not_found');
      }
      return {
        kind: 'account',
        record:
          db
            .update(account)
            .set({ password: input.password, updatedAt: input.updatedAt })
            .where(
              and(
                eq(account.id, input.accountId),
                actor
                  ? and(eq(account.userId, actor.userId), eq(account.providerId, 'credential'))
                  : undefined
              )
            )
            .returning()
            .get() ?? null,
      };
    case 'user-passwords-update': {
      const result = db
        .update(account)
        .set({ password: input.password, updatedAt: input.updatedAt })
        .where(and(eq(account.userId, input.userId), eq(account.providerId, 'credential')))
        .run();
      return { kind: 'mutation', ...result };
    }
    case 'session-delete':
      return {
        kind: 'mutation',
        ...db
          .delete(session)
          .where(
            and(
              eq(session.token, input.token),
              input.requireExpired ? lt(session.expiresAt, new Date()) : undefined,
              actor ? eq(session.userId, actor.userId) : undefined
            )
          )
          .run(),
      };
    case 'user-sessions-delete':
      return {
        kind: 'mutation',
        ...db.delete(session).where(eq(session.userId, input.userId)).run(),
      };
    case 'expired-verifications-delete':
      return {
        kind: 'mutation',
        ...db.delete(verification).where(lt(verification.expiresAt, input.before)).run(),
      };
    case 'verification-delete':
      return {
        kind: 'mutation',
        ...db.delete(verification).where(eq(verification.identifier, input.identifier)).run(),
      };
    case 'user-mark-verified':
      return {
        kind: 'user',
        record:
          db
            .update(users)
            .set({ emailVerified: true, updatedAt: input.updatedAt })
            .where(eq(users.email, input.email))
            .returning()
            .get() ?? null,
      };
    case 'user-address-replace':
      return {
        kind: 'user',
        record:
          db
            .update(users)
            .set({
              email: input.nextEmail,
              emailVerified: input.emailVerified,
              updatedAt: input.updatedAt,
            })
            .where(eq(users.email, input.email))
            .returning()
            .get() ?? null,
      };
    case 'account-unlink': {
      const selected = db.select().from(account).where(eq(account.id, input.accountId)).get();
      // SDK deleteWithHooks does nothing if its previously selected row is already absent.
      if (!selected) return { kind: 'mutation', changes: 0, lastInsertRowid: 0 };
      const current = requireCurrentSession(coreDb, {
        userId: input.userId,
        sessionToken: input.sessionToken,
      });
      const now = Date.now();
      if (
        input.freshAgeSeconds !== 0 &&
        now - current.createdAt.getTime() >= input.freshAgeSeconds * 1000
      )
        throw new BetterAuthNativeError('session_not_fresh');
      if (selected.userId !== input.userId) throw new BetterAuthNativeError('account_not_found');
      const count = db
        .select({ n: sql<number>`count(*)` })
        .from(account)
        .where(eq(account.userId, input.userId))
        .get()!.n;
      if (count === 1 && !input.allowUnlinkingAll) throw new BetterAuthNativeError('last_account');
      return {
        kind: 'mutation',
        ...db.delete(account).where(eq(account.id, input.accountId)).run(),
      };
    }
  }
}

/** Repeats the original SDK session predicate at the effect after native preparation/FIFO waiting. */
function requireCurrentSession(coreDb: CoreDb, actor: ControlBetterAuthActor) {
  const current = coreDb.db
    .select()
    .from(session)
    .where(eq(session.token, actor.sessionToken))
    .get();
  if (!current || current.userId !== actor.userId || current.expiresAt.getTime() < Date.now())
    throw new BetterAuthNativeError('session_invalid');
  return current;
}
