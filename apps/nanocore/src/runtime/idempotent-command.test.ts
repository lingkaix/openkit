import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { listOpenKitAccessTokenRecords } from '../auth/access-token-store.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { type CommandRequestScope, FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';
import { type InflightIdempotentCommand, runIdempotentCommand } from './idempotent-command.js';

describe('workspace-transaction idempotent commands', () => {
  it('separates concurrent commands by their complete explicit actor scope', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-actor-command-scope-'));
    const pending: Promise<unknown>[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let ending = false;
    onTestFinished(async () => {
      ending = true;
      release.resolve();
      await Promise.allSettled(pending);
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const setup = createDemoStore({ dataRoot });
    pending.push(setup);
    const store = await setup;
    if (ending) return;
    const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
    const actorA = 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b';
    const actorB = 'usr_00000000-0000-7a71-a8b1-dcc65a83481f';
    const errorA = new Error('Actor A refused before an effect.');
    const errorB = new Error('Actor B refused before an effect.');
    const scope = {
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    };
    const originalTurns = store.listThreadTurns(scope.workspaceId, scope.threadId);
    let executionCount = 0;

    const run = (actorId: string) =>
      runIdempotentCommand<{ id: string }>({
        command: 'task.start',
        execute: async () => {
          executionCount += 1;
          if (actorId === actorA) {
            entered.resolve();
            await release.promise;
            throw errorA;
          }
          throw errorB;
        },
        inflightCommands,
        input: {},
        replay: () => {
          throw new Error('Unexpected command replay.');
        },
        requestId: 'shared-request-id',
        responseId: (result) => result.id,
        responseKind: 'turn',
        scope: { ...scope, actorId },
        store,
      });

    const first = run(actorA);
    pending.push(first);
    const firstOutcome = Promise.allSettled([first]);
    await Promise.race([
      entered.promise,
      firstOutcome.then(() => {
        throw new Error('First command settled before its held callback.');
      }),
    ]);
    if (ending) return;
    const second = run(actorB);
    pending.push(second);
    const [secondOutcome] = await Promise.allSettled([second]);
    if (ending) return;
    expect(secondOutcome?.status).toBe('rejected');
    expect(secondOutcome?.status === 'rejected' && secondOutcome.reason).toBe(errorB);
    expect(executionCount).toBe(2);
    release.resolve();
    const [firstResult] = await firstOutcome;
    if (ending) return;
    expect(firstResult?.status).toBe('rejected');
    expect(firstResult?.status === 'rejected' && firstResult.reason).toBe(errorA);
    for (const actorId of [actorA, actorB]) {
      expect(
        store.getCommandRequest('task.start', 'shared-request-id', { ...scope, actorId })
      ).toBeNull();
    }
    expect(store.listThreadTurns(scope.workspaceId, scope.threadId)).toEqual(originalTurns);
  });

  it('preserves the original User receipt committed before model work without a later rewrite', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-20T12:00:00.000Z');
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-user-original-receipt-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot });
    const userId = testEntityId('usr', 'original-user-receipt');
    const turnId = testEntityId('tu', 'original-user-receipt');
    const requestId = randomUUID();
    const userDb = openUserDb(dataRoot, userId);
    try {
      applyScopedMigrations(userDb);
      let original: unknown;
      const read = () => userDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
      const result = await runIdempotentCommand<{ turnId: string }>({
        store,
        receiptDb: userDb,
        inflightCommands: new WeakMap(),
        command: 'knowledge.maintain',
        requestId,
        scope: { userId, actorId: userId },
        input: { instructions: 'Keep this original receipt.' },
        responseKind: 'turn',
        responseId: (result) => result.turnId,
        replay: () => {
          throw new Error('Fresh work must not replay.');
        },
        execute: async (receipt) => {
          const { responseKind, ...originalReceipt } = receipt;
          await store.commitScopedNotebookStage(userDb, {
            kind: 'receipt',
            receipt: { ...originalReceipt, response: { kind: responseKind, id: turnId } },
          });
          original = read();
          userDb.sqlite.exec(
            "CREATE TRIGGER refuse_receipt_rewrite BEFORE UPDATE ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'original receipt must not be rewritten'); END"
          );
          // Model work finishes later, but does not own another receipt or reset its expiry.
          vi.setSystemTime('2026-10-20T12:05:00.000Z');
          return { turnId };
        },
      });
      expect(result).toEqual({ turnId });
      expect(read()).toEqual(original);
      expect(read()).toHaveLength(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('commits Core authority, audit, and pointer receipt in one transaction', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-idempotent-command-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      // Use the real Bootstrap producer and the real native User command owner,
      // not a generic callback impersonating a now worker-owned command.
      const bootstrap = ensureServerBootstrapToken(coreDb);
      if (!bootstrap) throw new Error('Expected isolated Bootstrap admission.');
      writeServerBootstrapTokenEmission(dataRoot, bootstrap);
      const userId = allocateEntityId('usr');
      const owner = await createAccessTokenOperationImplementations({ coreDb, mode: 'server' })[
        'bootstrap.consume'
      ]({
        token: bootstrap.token,
        ownerUserId: userId,
        displayName: 'Native Core tuple owner',
        email: [randomUUID(), 'example.test'].join('@'),
        password: randomUUID(),
        tokenExpiresAt: '2099-12-31T00:00:00.000Z',
      });
      const store = new FsStore({ dataRoot });
      const context: AdmittedOperationContext = {
        kind: 'public',
        actor: {
          kind: 'token',
          userId,
          tokenId: owner.record.tokenId,
          tokenScope: 'server-admin',
          tokenWorkspaceIds: [],
        },
        actorRef: { kind: 'user', id: userId },
        scope: { kind: 'server' },
      };
      const scope: CommandRequestScope = {
        coreId: 'server',
        actorId: userId,
        targetUserId: userId,
      };
      const operations = createWorkspaceSharingOperationImplementations({
        coreDb,
        store,
        inflightCommands: new Map(),
      });
      const requestId = randomUUID();
      const input = { targetUserId: userId, requestId };
      const auditCount = () =>
        (
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as {
            count: number;
          }
        ).count;
      const receiptCount = () =>
        (
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get() as {
            count: number;
          }
        ).count;
      const user = () =>
        coreDb.sqlite
          .prepare('SELECT status, disabled_at AS disabledAt FROM users WHERE id=?')
          .get(userId);
      const tokenStatus = () =>
        listOpenKitAccessTokenRecords(coreDb).find(
          (record) => record.tokenId === owner.record.tokenId
        )?.status;
      const initialAudits = auditCount();
      expect(user()).toEqual({ status: 'active', disabledAt: null });
      expect(tokenStatus()).toBe('active');
      expect(receiptCount()).toBe(0);

      const legacyExecute = vi.fn(() => ({ id: userId }));
      await expect(
        runIdempotentCommand({
          command: 'user.disable',
          coreDb,
          coreTransaction: true,
          inflightCommands: new WeakMap(),
          replay: (record) => ({ id: record.response.id }),
          responseId: (value: { id: string }) => value.id,
          responseKind: 'user',
          scope,
          store,
          execute: legacyExecute,
          input,
          requestId: randomUUID(),
        })
      ).rejects.toThrow(
        'Native product commands must commit their whole tuple in the database worker.'
      );
      expect(legacyExecute).not.toHaveBeenCalled();

      // Fail the REAL native receipt insert after the real User/Token/Audit
      // effects. The complete original tuple must roll back, without fake rows.
      coreDb.sqlite.exec(`CREATE TRIGGER native_tuple_receipt_failure BEFORE INSERT ON idempotency_requests
        BEGIN SELECT RAISE(ABORT, 'Private receipt failure'); END`);
      await expect(
        operations['user.disable']({ targetUserId: userId, requestId: randomUUID() }, context)
      ).rejects.toThrow();
      coreDb.sqlite.exec('DROP TRIGGER native_tuple_receipt_failure');
      expect(user()).toEqual({ status: 'active', disabledAt: null });
      expect(tokenStatus()).toBe('active');
      expect(auditCount()).toBe(initialAudits);
      expect(receiptCount()).toBe(0);

      const result = await operations['user.disable'](input, context);
      expect(result.user).toMatchObject({ userId, status: 'disabled' });
      if (!result.user.disabledAt) throw new Error('Expected the original disabled timestamp.');
      expect(new Date(result.user.disabledAt).toISOString()).toBe(result.user.disabledAt);
      expect(user()).toEqual({ status: 'disabled', disabledAt: result.user.disabledAt });
      expect(tokenStatus()).toBe('revoked');
      expect(auditCount()).toBe(initialAudits + 1);
      expect(receiptCount()).toBe(1);
      const receipt = store.getCommandRequest('user.disable', requestId, scope, coreDb);
      expect(receipt?.response).toEqual({ kind: 'user', id: userId });
      if (!receipt) throw new Error('Expected the original native Core pointer receipt.');
      await expect(operations['user.disable'](input, context)).resolves.toEqual(result);
      expect(auditCount()).toBe(initialAudits + 1);
      expect(receiptCount()).toBe(1);

      // This closed public command has no alternate legal payload for the same
      // target-scoped key. Corrupt ONLY the hash of its actually committed row
      // to exercise the real retained-conflict refusal, not an off-domain command
      // or fabricated accepted history. It must neither replay nor rewrite it.
      const conflictingHash = `sha256:${'f'.repeat(64)}`;
      coreDb.sqlite
        .prepare('UPDATE idempotency_requests SET input_hash=? WHERE request_key=?')
        .run(conflictingHash, receipt.key);
      await expect(operations['user.disable'](input, context)).rejects.toMatchObject({
        code: 'idempotency_key_conflict',
        status: 409,
      });
      expect(user()).toEqual({ status: 'disabled', disabledAt: result.user.disabledAt });
      expect(tokenStatus()).toBe('revoked');
      expect(auditCount()).toBe(initialAudits + 1);
      expect(receiptCount()).toBe(1);
      expect(
        coreDb.sqlite
          .prepare('SELECT input_hash FROM idempotency_requests WHERE request_key=?')
          .get(receipt.key)
      ).toEqual({ input_hash: conflictingHash });
      expect(() =>
        store.recordCommandRequest(
          {
            command: 'user.disable',
            inputHash: 'sha256:test',
            requestId: 'ambiguous-owner',
            response: { id: userId, kind: 'user' },
            scope: { coreId: 'server', workspaceId: testEntityId('ws', 'ambiguous-owner') },
          },
          coreDb
        )
      ).toThrow('must name exactly one Core, User, Workspace, or App owner');
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('commits synchronous owners with receipts and rolls back incomplete commands', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-idempotent-command-'));
    const workspaceId = 'ws_00000000-0000-796a-8af7-97608a790532';
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
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
        ) VALUES ('test-owner:' || ?, 'workspace_sync.review.decide', ?, '{}', 'test-owner-input', 'knowledge', ?, NULL, '2026-07-18T00:00:00.000Z', '9999-12-31T23:59:59.999Z')`
      );
      const getOwner = workspaceDb.sqlite.prepare(
        `SELECT response_id AS id
        FROM idempotency_requests
        WHERE request_key = 'test-owner:' || ?`
      );

      const scope: CommandRequestScope = { workspaceId };
      const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
      // Exercise the generic Main receipt transaction using the remaining Review command name.
      // This isolated SQL owner tests transaction completion, not Review admission or Git effects.
      const common = {
        command: 'workspace_sync.review.decide' as const,
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
      const nativeExecute = vi.fn(() => ({ id: 'native_must_not_execute' }));
      const beforeNativeRefusal = workspaceDb.sqlite
        .prepare('SELECT * FROM idempotency_requests ORDER BY request_key')
        .all();
      await expect(
        runIdempotentCommand({
          ...common,
          command: 'catalog.skill-import',
          requestId: 'native_skill_transaction_refused',
          input: { id: 'native_must_not_execute' },
          execute: nativeExecute,
        })
      ).rejects.toThrow(
        'Native product commands must commit their whole tuple in the database worker.'
      );
      expect(nativeExecute).not.toHaveBeenCalled();
      expect(
        workspaceDb.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all()
      ).toEqual(beforeNativeRefusal);

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
        store.getCommandRequest(
          'workspace_sync.review.decide',
          'request_committed',
          scope,
          workspaceDb
        )
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
          store.getCommandRequest(
            'workspace_sync.review.decide',
            'request_rolled_back',
            scope,
            workspaceDb
          )
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
        .soft(
          store.getCommandRequest(
            'workspace_sync.review.decide',
            'request_async',
            scope,
            workspaceDb
          )
        )
        .toBeNull();
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
