import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  type CommunicationCredentials,
  createCommunicationCredentialOperationImplementations,
  createCredentialOperationImplementations,
} from '../auth/credential-operations.js';
import { createOperationInvocation } from '../operation-composition.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import * as controlStore from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

async function withCore<T>(run: (db: ReturnType<typeof openCoreDb>) => Promise<T>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'communication-credential-'));
  const db = openCoreDb(dataRoot);
  try {
    applyMigrations(db);
    return await run(db);
  } finally {
    await controlStore.shutdownControlStoreWorkerClient();
    db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

describe('Communication credentials in the shared credential family', () => {
  it.each(['default', 'selected'] as const)(
    'keeps the Kernel inventory and revoke available in the %s composition with Communication unavailable',
    (composition) =>
      withCore(async (coreDb) => {
        const userId = ensureLocalUser(coreDb);
        expect(
          coreDb.sqlite
            .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get('discord_account_bindings')
        ).toBeUndefined();
        const { tokenId } = createOpenKitAccessTokenRecord(coreDb, {
          ownerUserId: userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        const context = { kind: 'public', actor: { kind: 'local', userId } } as const;
        const unavailable = {
          state: 'unavailable',
          owner: 'communication',
          reason: 'missing',
        } as const;
        const unbind = vi.fn(async () => unavailable);
        const owners = { coreDb, mode: 'local' as const };
        const operations =
          composition === 'default'
            ? createCredentialOperationImplementations(owners)
            : createCommunicationCredentialOperationImplementations({
                ...owners,
                communicationCredentials: { readBinding: () => unavailable, unbind },
              });
        expect((await operations['credential.list']({}, context)).items).toEqual([
          expect.objectContaining({ kind: 'access-token', id: tokenId }),
        ]);
        await expect(
          operations['credential.revoke'](
            {
              kind: 'discord-pairing',
              id: randomUUID(),
            },
            context
          )
        ).rejects.toMatchObject({ code: 'channel_storage_unavailable', status: 503 });
        expect(unbind).not.toHaveBeenCalled();
        await expect(
          operations['credential.revoke'](
            {
              kind: 'access-token',
              id: tokenId,
            },
            context
          )
        ).resolves.toEqual({ status: 'revoked' });
        expect(getOpenKitAccessTokenRecord(coreDb, tokenId)?.status).toBe('revoked');
      })
  );

  it('forwards the exact selected revision and presented actor to unbind', () =>
    withCore(async (coreDb) => {
      const userId = ensureLocalUser(coreDb);
      const revision = randomUUID();
      const context = { kind: 'public', actor: { kind: 'local', userId } } as const;
      const readBinding = vi.fn<CommunicationCredentials['readBinding']>(() => ({
        state: 'ready',
        value: { revision, pairedAt: Date.now() },
      }));
      const unbind = vi.fn<CommunicationCredentials['unbind']>(async () => ({
        state: 'ready',
        value: undefined,
      }));
      const operations = createCommunicationCredentialOperationImplementations({
        coreDb,
        mode: 'local',
        communicationCredentials: { readBinding, unbind },
      });
      expect((await operations['credential.list']({}, context)).items).toEqual([
        expect.objectContaining({ kind: 'discord-pairing', id: revision }),
      ]);
      await expect(
        operations['credential.revoke'](
          {
            kind: 'discord-pairing',
            id: randomUUID(),
          },
          context
        )
      ).rejects.toMatchObject({ code: 'credential_not_found' });
      expect(unbind).not.toHaveBeenCalled();
      await expect(
        operations['credential.revoke'](
          {
            kind: 'discord-pairing',
            id: revision,
          },
          context
        )
      ).resolves.toEqual({ status: 'revoked' });
      expect(unbind).toHaveBeenCalledExactlyOnceWith({
        actor: context.actor,
        bindingRevision: revision,
      });
    }));
});

/** Supplies the exact current Core administrator for a Server credential operation. */
function serverAdministrator(coreDb: CoreDb) {
  const userId = ensureLocalUser(coreDb);
  const { tokenId } = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return {
    kind: 'public',
    actor: { kind: 'token', userId, tokenScope: 'server-admin', tokenId },
    delivery: 'human',
  } as const;
}

/** Models a ready owner's existing redacted read result. */
function readyTransportTokens(userId: string) {
  return {
    state: 'ready',
    value: [
      {
        tokenId: allocateEntityId('nhtok'),
        ownerNanoHostIdentityId: 'fixture-nanohost',
        tokenType: 'nanohost-transport',
        scope: 'nanohost-transport',
        deploymentId: allocateEntityId('dep'),
        status: 'active',
        issuedAt: '2025-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        revokedAt: null,
        predecessorTokenId: null,
        rotationOverlapExpiresAt: null,
        responsibleServerAdminActorId: userId,
        lastUsedAt: null,
        lastUsedChannel: null,
        lastUsedSource: null,
      },
    ],
  } as const;
}

describe('Independently admitted credential owners', () => {
  it.each(['default', 'composed'] as const)(
    'keeps authorized Core inventory when the NanoHost reader is omitted from the %s path',
    (path) =>
      withCore(async (coreDb) => {
        const context = serverAdministrator(coreDb);
        const prepare = coreDb.sqlite.prepare.bind(coreDb.sqlite);
        const observe = vi.spyOn(coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
          if (/\bFROM\s+nanohost_transport_tokens\b/i.test(sql)) {
            throw new Error('The retired Core NanoHost token table was read.');
          }
          return prepare(sql);
        });
        const owners = { coreDb, mode: 'server' as const };
        try {
          const inventory =
            path === 'default'
              ? await createCredentialOperationImplementations(owners)['credential.list'](
                  {},
                  context
                )
              : await createOperationInvocation({
                  ...owners,
                  communicationCredentialBinding: {},
                })('credential.list', {}, context);
          expect(inventory).toEqual({
            canManageServerCredentials: true,
            items: [expect.objectContaining({ kind: 'access-token', id: context.actor.tokenId })],
          });
        } finally {
          observe.mockRestore();
        }
      })
  );

  it('holds omitted Communication while listing the independently ready NanoHost and Core credentials', () =>
    withCore(async (coreDb) => {
      const context = serverAdministrator(coreDb);
      const ready = readyTransportTokens(context.actor.userId);
      const listNanoHostTransportTokens = vi.fn(() => ready);
      const invoke = createOperationInvocation({
        coreDb,
        mode: 'server',
        communicationCredentialBinding: { listNanoHostTransportTokens },
      });
      const inventory = await invoke('credential.list', {}, context);
      expect(inventory.items).toEqual([
        expect.objectContaining({ kind: 'access-token', id: context.actor.tokenId }),
        { kind: 'nanohost-transport', id: ready.value[0].tokenId, record: ready.value[0] },
      ]);
      expect(listNanoHostTransportTokens).toHaveBeenCalledTimes(1);
      await expect(
        invoke('credential.revoke', { kind: 'discord-pairing', id: randomUUID() }, context)
      ).rejects.toMatchObject({ code: 'channel_storage_unavailable', status: 503 });
      expect(listNanoHostTransportTokens).toHaveBeenCalledTimes(1);
    }));

  it('holds NanoHost revoke before writer contact when only its reader is admitted', () =>
    withCore(async (coreDb) => {
      const caller = serverAdministrator(coreDb);
      const context = {
        ...caller,
        actorRef: { kind: 'user', id: caller.actor.userId },
        scope: { kind: 'server' },
      } as const;
      const ready = readyTransportTokens(context.actor.userId);
      const writer = vi
        .spyOn(controlStore, 'getControlStoreWorkerClient')
        .mockImplementation(() => {
          throw new Error('NanoHost revoke contacted the legacy writer.');
        });
      try {
        const operations = createCommunicationCredentialOperationImplementations({
          coreDb,
          mode: 'server',
          listNanoHostTransportTokens: () => ready,
        });
        await expect(
          operations['credential.revoke'](
            { kind: 'nanohost-transport', id: ready.value[0].tokenId },
            context
          )
        ).rejects.toMatchObject({ code: 'nanohost_transport_storage_unavailable', status: 503 });
        expect(writer).not.toHaveBeenCalled();
      } finally {
        writer.mockRestore();
      }
    }));

  it('waits for the admitted NanoHost revoke handoff for the original token and actor', () =>
    withCore(async (coreDb) => {
      const context = serverAdministrator(coreDb);
      const tokenId = allocateEntityId('nhtok');
      const entered = Promise.withResolvers<void>();
      const acknowledgement = Promise.withResolvers<void>();
      const revokeNanoHostTransportToken = vi.fn(async () => {
        entered.resolve();
        await acknowledgement.promise;
      });
      const invoke = createOperationInvocation({
        coreDb,
        mode: 'server',
        communicationCredentialBinding: { revokeNanoHostTransportToken },
      });
      const result = invoke(
        'credential.revoke',
        { kind: 'nanohost-transport', id: tokenId },
        context
      );
      const completed = vi.fn();
      const observed = result.then(completed);
      try {
        await Promise.race([entered.promise, result]);
        await setImmediate();
        expect(revokeNanoHostTransportToken).toHaveBeenCalledExactlyOnceWith(
          tokenId,
          expect.objectContaining({
            actor: context.actor,
            recheckAdmission: expect.any(Function),
          })
        );
        expect(completed).not.toHaveBeenCalled();
      } finally {
        acknowledgement.resolve();
        await observed;
      }
      await expect(result).resolves.toEqual({ status: 'revoked' });
    }));
});
