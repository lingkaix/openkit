import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeNotebookDiffResponseSchema,
  KnowledgeNotebookHistoryResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { diffMemoryHistory, readMemoryHistory, restoreMemoryHistory } from './memory-history.js';
import {
  editMemoryPage,
  readMemoryPage,
  recordMemorySuppression,
  saveMemoryPage,
} from './memory-lifecycle.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';

/** Real User receipts and Git history exercise current self admission and exact historical bytes. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-history-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES (?, ?, ?, false, ?, ?, 'human')"
    )
    .run(userId, 'Memory owner', 'memory-owner@example.invalid', Date.now(), Date.now());
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  onTestFinished(() => {
    vi.restoreAllMocks();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const input = {
    coreDb,
    userDb,
    actor: { kind: 'session' as const, userId },
    store: new FsStore(),
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
  };
  const baseRevision = initializeScopedNotebook({
    ...input,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:memory-history' },
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'users', userId, 'memory', 'notebook.git'),
  });
  const request = (
    base = baseRevision,
    pageId = 'preferences',
    body = 'Earlier exact text.\r\n'
  ) => ({
    requestId: randomUUID(),
    baseRevision: base,
    pageId,
    content: serializeUserAuthoredKnowledgePage(
      {
        id: pageId,
        kind: 'preference',
        title: 'Private preferences',
        content: body,
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId }
    ),
    summary: 'Private authored change',
  });
  return { input, notebook, request, baseRevision };
}

/** Seed retained disallowed content below native publication to test disclosure independently. */
function retained(f: ReturnType<typeof fixture>, content: string, publish = true) {
  const baseRevision = f.notebook.publishedRevision();
  const candidateRevision = f.notebook.prepare({
    baseRevision,
    changes: { 'preferences.md': content },
    metadata: f.notebook.readRevision(baseRevision).metadata,
  });
  if (publish) f.notebook.publish({ baseRevision, candidateRevision });
  return candidateRevision;
}

describe('source-free native Memory history', () => {
  it('reads published history and exact diffs, then restores through one new publication and receipt', async () => {
    const f = fixture();
    const original = f.request();
    const saved = await saveMemoryPage(f.input, original);
    const edited = await editMemoryPage(
      f.input,
      f.request(saved.notebookRevision, 'preferences', 'Later exact text.\n')
    );
    const selection = {
      baseRevision: edited.notebookRevision,
      fromRevision: saved.notebookRevision,
      pageIds: ['preferences'],
    };
    const history = KnowledgeNotebookHistoryResponseSchema.parse(readMemoryHistory(f.input, {}));
    expect(history.revisions.map(({ revision }) => revision)).toEqual([
      edited.notebookRevision,
      saved.notebookRevision,
      f.baseRevision,
    ]);
    expect(history.revisions[0]).toMatchObject({
      availability: 'available',
      changedPaths: ['preferences.md'],
      producer: { kind: 'user', id: userId },
    });
    expect(readMemoryHistory(f.input, { limit: 1 }).nextRevision).toBe(saved.notebookRevision);
    const diff = KnowledgeNotebookDiffResponseSchema.parse(diffMemoryHistory(f.input, selection));
    expect(diff).toMatchObject({
      baseRevision: selection.baseRevision,
      fromRevision: selection.fromRevision,
      forRestore: false,
      truncated: false,
      changes: [{ path: 'preferences.md', after: original.content }],
    });
    const request = { ...selection, requestId: randomUUID(), summary: 'Restore my earlier text' };
    const restored = await restoreMemoryHistory(f.input, request);
    expect(restored.baseRevision).toBe(edited.notebookRevision);
    expect(restored.receiptRef.operation).toBe('knowledge.notebook.restore');
    expect(restored.notebookRevision).not.toBe(saved.notebookRevision);
    expect(readMemoryPage(f.input, 'preferences')?.content).toBe(original.content);
    expect(await restoreMemoryHistory(f.input, request)).toEqual(restored);
    await expect(
      restoreMemoryHistory(f.input, { ...request, fromRevision: restored.notebookRevision })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.notebook.history().revisions).toHaveLength(4);
  });

  it('checks the current bearer before history, diff and restoration', async () => {
    const f = fixture();
    const saved = await saveMemoryPage(f.input, f.request());
    const token = createOpenKitAccessTokenRecord(f.input.coreDb, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const input = {
      ...f.input,
      actor: {
        kind: 'token' as const,
        userId,
        tokenId: token.tokenId,
        tokenScope: 'server-admin' as const,
      },
    };
    expect(readMemoryHistory(input, {}).revisions).toHaveLength(2);
    revokeOpenKitAccessTokenRecord(f.input.coreDb, token.tokenId);
    const selection = { baseRevision: saved.notebookRevision, fromRevision: f.baseRevision };
    expect(() => readMemoryHistory(input, {})).toThrow('Scoped notebook access denied.');
    expect(() => diffMemoryHistory(input, selection)).toThrow('Scoped notebook access denied.');
    await expect(
      restoreMemoryHistory(input, {
        ...selection,
        requestId: randomUUID(),
        summary: 'Denied restore',
      })
    ).rejects.toThrow('Scoped notebook access denied.');
  });

  it('rechecks current authority after reading historical content', async () => {
    const f = fixture();
    await saveMemoryPage(f.input, f.request());
    const read = KnowledgeNotebook.prototype.readRevision;
    vi.spyOn(KnowledgeNotebook.prototype, 'readRevision').mockImplementationOnce(function (
      this: KnowledgeNotebook,
      ...args
    ) {
      const result = read.apply(this, args);
      f.input.coreDb.sqlite.transaction(() => disableCanonicalUser(f.input.coreDb, userId))();
      return result;
    });
    expect(() => readMemoryHistory(f.input, {})).toThrow('Scoped notebook access denied.');
  });

  it('withholds forgotten bodies, summaries, producers and paths and cannot restore their identity', async () => {
    const f = fixture();
    const saved = await saveMemoryPage(f.input, f.request());
    const edited = await editMemoryPage(
      f.input,
      f.request(saved.notebookRevision, 'preferences', 'Changed private text')
    );
    const current = readMemoryPage(f.input, 'preferences')!;
    recordMemorySuppression(f.input, {
      requestId: randomUUID(),
      pageId: current.id,
      notebookRevision: current.notebookRevision,
      digest: current.digest,
    });
    const history = readMemoryHistory(f.input, {});
    expect(history.revisions.slice(0, 2)).toEqual([
      {
        revision: edited.notebookRevision,
        parentRevision: saved.notebookRevision,
        availability: 'unavailable',
      },
      {
        revision: saved.notebookRevision,
        parentRevision: f.baseRevision,
        availability: 'unavailable',
      },
    ]);
    const selection = {
      baseRevision: edited.notebookRevision,
      fromRevision: saved.notebookRevision,
      pageIds: ['preferences'],
    };
    expect(() => diffMemoryHistory(f.input, selection)).toThrow('Memory page unavailable.');
    await expect(
      restoreMemoryHistory(f.input, {
        ...selection,
        requestId: randomUUID(),
        summary: 'Cannot revive',
      })
    ).rejects.toThrow('Memory page unavailable.');
    expect(JSON.stringify(history)).not.toContain('Private authored change');
    expect(f.notebook.publishedRevision()).toBe(edited.notebookRevision);
  });

  it.each([
    [
      'source-bearing',
      (content: string) => content.replace('source_refs: []', 'source_refs: ["source:private"]'),
    ],
    [
      'restricted',
      (content: string) => content.replace('sensitivity: "normal"', 'sensitivity: "restricted"'),
    ],
  ])('does not disclose retained %s page metadata or text', async (_kind, modify) => {
    const f = fixture();
    const request = f.request();
    const saved = await saveMemoryPage(f.input, request);
    const revision = retained(f, modify(request.content));
    expect(readMemoryHistory(f.input, {}).revisions[0]).toEqual({
      revision,
      parentRevision: saved.notebookRevision,
      availability: 'unavailable',
    });
    const selection = {
      baseRevision: revision,
      fromRevision: saved.notebookRevision,
      pageIds: ['preferences'],
    };
    expect(() => diffMemoryHistory(f.input, selection)).toThrow('Memory page unavailable.');
    await expect(
      restoreMemoryHistory(f.input, { ...selection, requestId: randomUUID(), summary: 'Denied' })
    ).rejects.toThrow('Memory page unavailable.');
  });

  it('fails closed on historical required semantics that the current scope schema cannot admit', async () => {
    const f = fixture();
    const request = f.request();
    await saveMemoryPage(f.input, request);
    retained(
      f,
      request.content.replace(
        'requiredFeatures: [',
        'requiredFeatures: ["openkit.unknown-history.v1",'
      )
    );
    expect(() => readMemoryHistory(f.input, {})).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('does not disclose an unpublished candidate through a history cursor or diff', async () => {
    const f = fixture();
    const saved = await saveMemoryPage(f.input, f.request());
    const revision = retained(
      f,
      f.request(saved.notebookRevision, 'preferences', 'Unpublished candidate').content,
      false
    );
    expect(() => readMemoryHistory(f.input, { revision })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(() =>
      diffMemoryHistory(f.input, { baseRevision: saved.notebookRevision, fromRevision: revision })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('clips ordinary UTF-8 display and refuses a partial restore', async () => {
    const f = fixture();
    const saved = await saveMemoryPage(
      f.input,
      f.request(undefined, 'preferences', '€'.repeat(24000))
    );
    const edited = await editMemoryPage(
      f.input,
      f.request(saved.notebookRevision, 'preferences', 'Current')
    );
    const selection = {
      baseRevision: edited.notebookRevision,
      fromRevision: saved.notebookRevision,
      pageIds: ['preferences'],
    };
    const diff = KnowledgeNotebookDiffResponseSchema.parse(diffMemoryHistory(f.input, selection));
    expect(diff.truncated).toBe(true);
    expect(diff.changes[0]?.after).not.toContain('\ufffd');
    expect(() => diffMemoryHistory(f.input, { ...selection, forRestore: true })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
    await expect(
      restoreMemoryHistory(f.input, {
        ...selection,
        requestId: randomUUID(),
        summary: 'Oversized restore',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.notebook.publishedRevision()).toBe(edited.notebookRevision);
  });

  it('refuses deletion through restore and does not overwrite a changed current base', async () => {
    const f = fixture();
    const saved = await saveMemoryPage(f.input, f.request());
    await expect(
      restoreMemoryHistory(f.input, {
        requestId: randomUUID(),
        baseRevision: saved.notebookRevision,
        fromRevision: f.baseRevision,
        pageIds: ['preferences'],
        summary: 'Delete by restoring',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const edited = await editMemoryPage(
      f.input,
      f.request(saved.notebookRevision, 'preferences', 'New current')
    );
    await expect(
      restoreMemoryHistory(f.input, {
        requestId: randomUUID(),
        baseRevision: saved.notebookRevision,
        fromRevision: saved.notebookRevision,
        pageIds: ['preferences'],
        summary: 'Stale base',
      })
    ).rejects.toMatchObject({ code: 'conflict', currentRevision: edited.notebookRevision });
    expect(readMemoryPage(f.input, 'preferences')?.content).toContain('New current');
  });
});
