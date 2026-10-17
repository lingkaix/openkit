import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitsServerKnowledge,
  listServerKnowledgeSources,
  readServerKnowledgeSource,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';

/** Actual Core authority, receipt, Audit and canonical Source files. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-sources-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { coreDb, actor, store, inflightCommands: new WeakMap(), dataRoot };
}

describe('Server literal Source owner', () => {
  it('captures exact bytes with one Core receipt and Audit, never reading a Workspace Source as Server', async () => {
    const f = fixture();
    const request = {
      requestId: randomUUID(),
      kind: 'document' as const,
      title: 'Shared document',
      content: 'Exact shared Source.\r\nΩ\n',
    };
    const source = await registerServerKnowledgeSource(f, request);
    expect(await registerServerKnowledgeSource(f, request)).toEqual(source);
    expect(source).toMatchObject({ ownerScope: { kind: 'server' }, kind: 'document', uri: null });
    expect(readServerKnowledgeSource(f, source.id)).toEqual({ source, content: request.content });
    expect(listServerKnowledgeSources(f)).toEqual([source]);
    const envelope = JSON.parse(
      readFileSync(join(f.dataRoot, 'server', 'sources', 'registry', `${source.id}.json`), 'utf8')
    );
    expect(envelope).toMatchObject({
      ownerScope: 'server',
      lineage: { requestId: request.requestId },
      contentDigest: source.contentDigest,
    });
    expect(envelope.payload).not.toHaveProperty('workspaceId');
    expect(
      f.coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'knowledge.source.register'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      f.coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name = 'knowledge.source.register'"
        )
        .get()
    ).toEqual({ count: 1 });
    await expect(
      registerServerKnowledgeSource(f, { ...request, content: 'Changed' })
    ).rejects.toThrow();
    const workspace = f.store.createWorkspace('Separate Workspace Source owner');
    const workspaceSourceId = 'ks_00000000-0000-7000-8000-000000000001';
    f.store.createKnowledgeSource(
      {
        id: workspaceSourceId,
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Workspace only',
        contentDigest: source.contentDigest,
        capturedAt: source.capturedAt,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        uri: null,
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
      },
      request.content
    );
    expect(f.store.getKnowledgeSource(workspace.id, workspaceSourceId).id).toBe(workspaceSourceId);
    expect(readServerKnowledgeSource(f, workspaceSourceId)).toBeNull();
    expect(
      admitsServerKnowledge({ ...f, actor: { kind: 'session', userId: f.actor.userId } })
    ).toBe(false);
    expect(() => listServerKnowledgeSources({ ...f, actor: undefined })).toThrow(
      'Server Knowledge access denied.'
    );
    writeFileSync(
      join(f.dataRoot, 'server', 'sources', 'materials', source.id, 'content.txt'),
      'Changed captured bytes'
    );
    expect(() => readServerKnowledgeSource(f, source.id)).toThrow(
      'Server Source storage requires recovery.'
    );
  });
});
