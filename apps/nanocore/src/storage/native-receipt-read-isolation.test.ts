import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { createTestStore } from '../test-support/store.js';
import { createThread } from '../thread-routes.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';

/** Captures both reader outcomes so one contention failure cannot hide the other. */
function attempt<T>(name: string, read: () => T) {
  try {
    return { name, status: 'fulfilled' as const, value: read() };
  } catch (reason) {
    const error = reason as { code?: string; message?: string };
    return {
      name,
      status: 'rejected' as const,
      reason: `${error.code ?? 'unknown'}: ${error.message ?? String(reason)}`,
    };
  }
}

it('reads a native Workspace receipt and global inventory while a writer holds the database', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-receipt-reader-'));
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Receipt reader isolation');
  const actorId = testEntityId('usr', 'native-receipt-reader');
  const input = {
    workspaceId: workspace.id,
    requestId: '0190f4c8-0000-7000-8000-000000000503',
    name: 'Committed receipt',
    visibility: 'workspace' as const,
  };
  const scope = { actorId, workspaceId: workspace.id };
  const thread = await createThread(input, { store, inflightCommands: new WeakMap() }, actorId);
  const expectedReceipt = store.getCommandRequest('thread.create', input.requestId, scope);
  if (!expectedReceipt) throw new Error('The genuine Thread producer did not commit its receipt.');
  expect(expectedReceipt).toMatchObject({
    key: commandRequestKey('thread.create', input.requestId, scope),
    command: 'thread.create',
    requestId: input.requestId,
    scope,
    inputHash: commandInputHash(input),
    response: { kind: 'thread', id: thread.id },
  });
  expect(Date.parse(expectedReceipt.expiresAt) - Date.parse(expectedReceipt.createdAt)).toBe(
    7 * 24 * 60 * 60 * 1000
  );

  const path = workspaceDbPath(dataRoot, workspace.id);
  const blocker = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    if (blocker.sqlite.inTransaction) blocker.sqlite.exec('ROLLBACK');
    if (blocker.sqlite.open) blocker.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  blocker.sqlite.exec('BEGIN IMMEDIATE');

  const contender = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrowError(
      expect.objectContaining({ code: 'SQLITE_BUSY' })
    );
  } finally {
    contender.close();
  }

  const committedState = {
    bytes: readFileSync(path),
    schema: blocker.sqlite
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      )
      .all(),
    schemaVersion: blocker.sqlite.pragma('schema_version', { simple: true }),
  };
  const prepare = Database.prototype.prepare;
  let activeRead: 'global inventory' | 'lookup' | undefined;
  const observedReads: Array<{
    readonly: boolean;
    operation: 'global inventory' | 'lookup';
    queryOnly: unknown;
  }> = [];
  const observer = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (this.name === path && activeRead !== undefined && /^\s*SELECT\b/i.test(sql)) {
      observedReads.push({
        operation: activeRead,
        readonly: this.readonly,
        queryOnly: this.pragma('query_only', { simple: true }),
      });
    }
    return prepare.call(this, sql) as Database.Statement;
  });
  const observe = <T>(name: 'global inventory' | 'lookup', read: () => T) => {
    activeRead = name;
    try {
      return attempt(name, read);
    } finally {
      activeRead = undefined;
    }
  };
  const attempts = (() => {
    try {
      return [
        observe('lookup', () => store.getCommandRequest('thread.create', input.requestId, scope)),
        observe('global inventory', () => store.listCommandRequests()),
      ];
    } finally {
      observer.mockRestore();
    }
  })();

  expect(attempts).toEqual([
    { name: 'lookup', status: 'fulfilled', value: expectedReceipt },
    { name: 'global inventory', status: 'fulfilled', value: [expectedReceipt] },
  ]);
  expect(new Set(observedReads.map(({ operation }) => operation))).toEqual(
    new Set(['lookup', 'global inventory'])
  );
  expect(
    observedReads.map(({ operation, readonly, queryOnly }) => ({
      operation,
      readonly,
      queryOnly,
    }))
  ).toEqual(observedReads.map(({ operation }) => ({ operation, readonly: true, queryOnly: 1 })));
  expect(blocker.sqlite.inTransaction).toBe(true);
  expect({
    bytes: readFileSync(path),
    schema: blocker.sqlite
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      )
      .all(),
    schemaVersion: blocker.sqlite.pragma('schema_version', { simple: true }),
  }).toEqual(committedState);
});
