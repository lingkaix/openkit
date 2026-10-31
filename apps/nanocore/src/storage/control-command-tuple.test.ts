import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { listSqliteAuditEvents, prepareAuditEventStatement } from '../audit-events.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { call, createOwners } from '../test-support/knowledge-proposal-authority.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  getCommandRequestRecordFromDb,
  prepareControlCommandRequestStatement,
} from './command-request-records.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';

it('composes an original receipt and Audit atomically and preserves them after native acknowledgement and reopen', async () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  const targetRoot = mkdtempSync(join(tmpdir(), 'control-command-tuple-'));
  let sourceDb: WorkspaceDb | undefined;
  let targetDb: WorkspaceDb | undefined;
  const client = getControlStoreWorkerClient();
  onTestFinished(async () => {
    await client.shutdown();
    if (sourceDb?.sqlite.open) sourceDb.sqlite.close();
    if (targetDb?.sqlite.open) targetDb.sqlite.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(targetRoot, { recursive: true, force: true });
  });
  const source = await createOwners((cleanup) => cleanups.push(cleanup));
  const requestId = randomUUID();
  const result = await call(source, 'knowledge.notebook.create', {
    requestId,
    baseRevision: source.notebook.publishedRevision(),
    path: 'receipt-evidence.md',
    content: serializeKnowledgePageFixture(
      {
        title: 'Original command evidence',
        content: 'Retain the actual command result and its original Audit facts.',
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: '2026-10-31T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: source.workspaceId }
    ),
    summary: 'Publish genuine original command evidence',
  });
  sourceDb = openWorkspaceDb(source.dataRoot, source.workspaceId);
  const original = source.store.getCommandRequest(
    'knowledge.notebook.create',
    requestId,
    { workspaceId: source.workspaceId, actorId: FIXTURE_LOCAL_USER_ID },
    sourceDb
  );
  expect(original).not.toBeNull();
  const receipt = original!;
  const audits = listSqliteAuditEvents(sourceDb.sqlite, source.workspaceId).filter(
    (event) => event.requestId === requestId
  );
  expect(audits.length).toBeGreaterThan(0);
  expect(audits).toContainEqual(
    expect.objectContaining({
      outcome: 'succeeded',
      resource: `knowledge-notebook:${result.notebookRevision}`,
    })
  );

  // This isolated dormant target carries the SAME owner identity and original facts.
  // It proves tuple serialization, not admission, business-state copying or migration.
  targetDb = openWorkspaceDb(targetRoot, source.workspaceId);
  applyScopedMigrations(targetDb, undefined, 'pre-knowledge');
  await client.open({
    database: 'command-tuple',
    path: workspaceDbPath(targetRoot, source.workspaceId),
    create: false,
    initialize: 'workspace',
    productOwner: { kind: 'workspace', workspaceId: source.workspaceId },
    dataRoot: targetRoot,
  });
  const before = targetDb.sqlite.serialize();
  expect(() => prepareControlCommandRequestStatement(allocateEntityId('ws'), receipt)).toThrow();
  expect(targetDb.sqlite.serialize()).toEqual(before);
  const tuple = [
    ...audits.map(prepareAuditEventStatement),
    prepareControlCommandRequestStatement(source.workspaceId, receipt),
  ];
  const refusal: ControlSqlStatement = {
    mode: 'get',
    sql: 'SELECT 1 WHERE 0',
    expectRow: 'present',
  };
  // NotebookEditing11/DX147: a later native condition must roll back receipt AND Audit.
  await expect(client.write('command-tuple', [...tuple, refusal])).rejects.toThrow();
  expect(getCommandRequestRecordFromDb(targetDb, receipt.key, receipt.createdAt)).toBeNull();
  expect(listSqliteAuditEvents(targetDb.sqlite, source.workspaceId)).toEqual([]);
  await client.write('command-tuple', tuple);
  expect(getCommandRequestRecordFromDb(targetDb, receipt.key, receipt.createdAt)).toEqual(receipt);
  expect(listSqliteAuditEvents(targetDb.sqlite, source.workspaceId)).toEqual(audits);

  await client.shutdown();
  targetDb.sqlite.close();
  targetDb = openWorkspaceDb(targetRoot, source.workspaceId);
  expect(getCommandRequestRecordFromDb(targetDb, receipt.key, receipt.createdAt)).toEqual(receipt);
  expect(listSqliteAuditEvents(targetDb.sqlite, source.workspaceId)).toEqual(audits);
  expect(getCommandRequestRecordFromDb(sourceDb, receipt.key, receipt.createdAt)).toEqual(receipt);
  expect(
    listSqliteAuditEvents(sourceDb.sqlite, source.workspaceId).filter(
      (event) => event.requestId === requestId
    )
  ).toEqual(audits);
});
