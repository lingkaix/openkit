import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  type CommunicationCredentials,
  createCommunicationCredentialOperationImplementations,
} from '../auth/credential-operations.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

async function withCore<T>(run: (db: ReturnType<typeof openCoreDb>) => Promise<T>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'communication-credential-'));
  const db = openCoreDb(dataRoot);
  try {
    applyMigrations(db);
    return await run(db);
  } finally {
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

describe('Communication credentials in the shared credential family', () => {
  it('keeps the kernel access-token inventory and revoke available when communication is missing', () =>
    withCore(async (coreDb) => {
      const userId = ensureLocalUser(coreDb);
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
      const operations = createCommunicationCredentialOperationImplementations({
        coreDb,
        mode: 'local',
        communicationCredentials: { readBinding: () => unavailable, unbind },
      });
      expect(operations['credential.list']({}, context).items).toEqual([
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
    }));

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
      expect(operations['credential.list']({}, context).items).toEqual([
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
