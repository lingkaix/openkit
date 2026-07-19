import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordServerAuditEvent } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { type CommandRequestScope, FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { type InflightIdempotentCommand, runIdempotentCommand } from './idempotent-command.js';

describe('workspace-transaction idempotent commands', () => {
  it('separates concurrent commands by their complete explicit actor scope', async () => {
    const store = new FsStore();
    const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
    let executionCount = 0;

    const run = (actorId: string) =>
      runIdempotentCommand({
        command: 'task.start',
        execute: async () => {
          executionCount += 1;
          await Promise.resolve();
          return { id: `turn_${actorId}` };
        },
        inflightCommands,
        input: {},
        replay: () => {
          throw new Error('Unexpected command replay.');
        },
        requestId: 'shared-request-id',
        responseId: (result) => result.id,
        responseKind: 'turn',
        scope: { actorId, threadId: 'th_demo', workspaceId: 'ws_demo' },
        store,
      });

    await expect(Promise.all([run('user_1'), run('user_2')])).resolves.toEqual([
      { id: 'turn_user_1' },
      { id: 'turn_user_2' },
    ]);
    expect(executionCount).toBe(2);
  });

  it('commits Core authority, audit, and pointer receipt in one transaction', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-idempotent-command-'));
    const coreDb = openCoreDb(dataRoot);
    const store = new FsStore({ dataRoot });
    const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
    const scope: CommandRequestScope = { coreId: 'server', targetUserId: 'user_local' };

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const common = {
        command: 'user.disable' as const,
        coreDb,
        coreTransaction: true as const,
        inflightCommands,
        replay: (record: { response: { id: string } }) => ({ id: record.response.id }),
        responseId: (value: { id: string }) => value.id,
        responseKind: 'user' as const,
        scope,
        store,
      };
      const input = { userId: 'user_local' };

      const result = await runIdempotentCommand({
        ...common,
        execute: () => {
          coreDb.sqlite
            .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
            .run('2026-07-19T00:00:00.000Z', 'user_local');
          recordServerAuditEvent({
            action: 'user.disable',
            actor: { id: 'user_admin', kind: 'user' },
            auditEventId: 'aud_user_disable_1',
            coreDb,
            now: new Date('2026-07-19T00:00:00.000Z'),
            outcome: 'succeeded',
            resource: 'user:user_local',
            resourceRevision: 1,
            subject: { id: 'user_local', kind: 'user' },
            summary: 'User disabled.',
          });
          return { id: 'user_local' };
        },
        input,
        requestId: 'disable-user-1',
      });

      expect(result).toEqual({ id: 'user_local' });
      expect(
        coreDb.sqlite
          .prepare('SELECT status, disabled_at FROM users WHERE id = ?')
          .get('user_local')
      ).toEqual({ disabled_at: '2026-07-19T00:00:00.000Z', status: 'disabled' });
      expect(coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
        count: 1,
      });
      expect(coreDb.sqlite.prepare('SELECT response_id FROM idempotency_requests').get()).toEqual({
        response_id: 'user_local',
      });
      await expect(
        runIdempotentCommand({
          ...common,
          execute: () => {
            throw new Error('Replay must not execute the command again.');
          },
          input,
          requestId: 'disable-user-1',
        })
      ).resolves.toEqual({ id: 'user_local' });
      await expect(
        runIdempotentCommand({
          ...common,
          execute: () => ({ id: 'user_local' }),
          input: { changed: true, userId: 'user_local' },
          requestId: 'disable-user-1',
        })
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict', status: 409 });

      await expect(
        runIdempotentCommand({
          ...common,
          execute: () => {
            coreDb.sqlite
              .prepare("UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ?")
              .run('user_local');
            recordServerAuditEvent({
              action: 'user.disable.rollback',
              auditEventId: 'aud_user_disable_rollback',
              coreDb,
              outcome: 'failed',
              summary: 'Rolled back test event.',
            });
            return { id: 'user_local' };
          },
          input: { rollback: true, userId: 'user_local' },
          requestId: 'disable-user-rollback',
          responseId: () => null as unknown as string,
        })
      ).rejects.toThrow();
      expect(
        coreDb.sqlite.prepare('SELECT status FROM users WHERE id = ?').get('user_local')
      ).toEqual({ status: 'disabled' });
      expect(coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
        count: 1,
      });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
      ).toEqual({ count: 1 });
      expect(() =>
        store.recordCommandRequest(
          {
            command: 'user.disable',
            inputHash: 'sha256:test',
            requestId: 'ambiguous-owner',
            response: { id: 'user_local', kind: 'user' },
            scope: { coreId: 'server', workspaceId: 'ws_demo' },
          },
          coreDb
        )
      ).toThrow('must name exactly one Core, User, or Workspace owner');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('commits synchronous owners with receipts and rolls back incomplete commands', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-idempotent-command-'));
    const workspaceId = 'ws_test';
    const store = new FsStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);

    try {
      applyScopedMigrations(workspaceDb);
      const insertOwner = workspaceDb.sqlite.prepare(
        `INSERT INTO idempotency_requests (
          request_key,
          command_name,
          request_id,
          scope_json,
          input_hash,
          response_kind,
          response_id,
          response_json,
          created_at,
          expires_at
        ) VALUES ('test-owner:' || ?, 'knowledge.create', ?, '{}', 'test-owner-input', 'knowledge', ?, NULL, '2026-07-18T00:00:00.000Z', '9999-12-31T23:59:59.999Z')`
      );
      const getOwner = workspaceDb.sqlite.prepare(
        `SELECT response_id AS id
        FROM idempotency_requests
        WHERE request_key = 'test-owner:' || ?`
      );

      const scope: CommandRequestScope = { workspaceId };
      const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
      const common = {
        command: 'knowledge.create' as const,
        inflightCommands,
        replay: () => {
          throw new Error('Unexpected command replay.');
        },
        responseId: (result: { readonly id: string }) => result.id,
        responseKind: 'knowledge' as const,
        scope,
        store,
        workspaceDb,
        workspaceTransaction: true as const,
      };
      await expect(
        runIdempotentCommand({
          ...common,
          execute: () => {
            insertOwner.run('owner_committed', 'owner_committed', 'owner_committed');
            return { id: 'owner_committed' };
          },
          input: { id: 'owner_committed' },
          requestId: 'request_committed',
        })
      ).resolves.toEqual({ id: 'owner_committed' });
      expect(getOwner.get('owner_committed')).toEqual({ id: 'owner_committed' });
      expect(
        store.getCommandRequest('knowledge.create', 'request_committed', scope, workspaceDb)
      ).toMatchObject({ response: { id: 'owner_committed', kind: 'knowledge' } });

      const receiptWriter = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('Receipt write failed.');
      });

      try {
        await expect(
          runIdempotentCommand({
            ...common,
            execute: () => {
              insertOwner.run('owner_rolled_back', 'owner_rolled_back', 'owner_rolled_back');
              return { id: 'owner_rolled_back' };
            },
            input: { id: 'owner_rolled_back' },
            requestId: 'request_rolled_back',
          })
        ).rejects.toThrow('Receipt write failed.');
      } finally {
        receiptWriter.mockRestore();
      }

      expect.soft(getOwner.get('owner_rolled_back')).toBeUndefined();
      expect
        .soft(
          store.getCommandRequest('knowledge.create', 'request_rolled_back', scope, workspaceDb)
        )
        .toBeNull();

      let asynchronousExecuteInvoked = false;
      const asynchronousExecute = async () => {
        asynchronousExecuteInvoked = true;
        await Promise.resolve();
        insertOwner.run('owner_async', 'owner_async', 'owner_async');
        return { id: 'owner_async' };
      };
      const asynchronousError = await runIdempotentCommand({
        ...common,
        execute: asynchronousExecute as unknown as () => { id: string },
        input: { id: 'owner_async' },
        requestId: 'request_async',
      }).then(
        () => null,
        (error: unknown) => error
      );

      expect.soft(asynchronousError).toBeInstanceOf(Error);
      expect.soft(asynchronousExecuteInvoked).toBe(false);
      await Promise.resolve();
      expect.soft(getOwner.get('owner_async')).toBeUndefined();
      expect
        .soft(store.getCommandRequest('knowledge.create', 'request_async', scope, workspaceDb))
        .toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
