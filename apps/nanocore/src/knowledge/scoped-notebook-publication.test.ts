import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb, type UserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { KnowledgeNotebook } from './notebook.js';
import type { NotebookEdit } from './notebook-publication.js';
import { initializeScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import { publishScopedNotebook, readScopedNotebookHistory } from './scoped-notebook-publication.js';

const alice = 'usr_00000000-0000-7000-8000-000000000001';
const bob = 'usr_00000000-0000-7000-8000-000000000002';

/** Real canonical identities, authenticated bearer, existing scoped SQLite and Git; no boolean grants. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'scoped-publication-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  for (const userId of [alice, bob])
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES (?, ?, ?, false, ?, ?, 'human')"
      )
      .run(userId, userId, `${userId}@example.invalid`, Date.now(), Date.now());
  const userDb = openUserDb(dataRoot, alice);
  applyScopedMigrations(userDb);
  onTestFinished(() => {
    vi.restoreAllMocks();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const actor: Actor = { kind: 'session', userId: alice };
  const issued = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: bob,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const verified = verifyOpenKitAccessTokenRecord(coreDb, issued.secret);
  if (!verified) throw new Error('Fixture bearer must authenticate.');
  const administrator: Actor = {
    kind: 'token',
    userId: verified.ownerUserId,
    tokenId: verified.tokenId,
    tokenScope: verified.scope,
  };
  const store = new FsStore();
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
  const common = { coreDb, store, runtimeConfigManager, inflightCommands: new WeakMap() };
  const user = { ...common, actor, target: { kind: 'user' } as const, userDb };
  const server = { ...common, actor: administrator, target: { kind: 'server' } as const };
  const initialization = () => ({
    requestId: randomUUID(),
    instructionReference: 'test:fresh-scoped-notebook',
  });
  const initialUser = initializeScopedNotebook({ ...user, initialization: initialization() });
  const initialServer = initializeScopedNotebook({ ...server, initialization: initialization() });
  return {
    dataRoot,
    coreDb,
    userDb,
    user,
    server,
    actor,
    administrator,
    initialUser,
    initialServer,
  };
}

/** Exact governed profile; Git commit identity is supplied by publication, never by these bytes. */
function page(
  ownerScope: KnowledgeOwnerScope,
  body = 'Exact authored bytes.\r\n',
  sourceReferences: string[] = []
): string {
  return serializeUserAuthoredKnowledgePage(
    {
      id: 'note',
      kind: 'preference',
      title: 'Direct note',
      content: body,
      sourceReferences,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    },
    ownerScope
  );
}

/** One human request uses the same common publication identity and fixed-base contract. */
function edit(baseRevision: string, ownerScope: KnowledgeOwnerScope, body?: string): NotebookEdit {
  return {
    requestId: randomUUID(),
    baseRevision,
    changes: [{ path: 'note.md', content: page(ownerScope, body) }],
    summary: 'Save exact direct note',
  };
}

/** Reads only the real existing database to check that failed commands leave no false completion evidence. */
function counts(db: Pick<UserDb, 'sqlite'>) {
  return {
    audit: (
      db.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }
    ).count,
    receipts: (
      db.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get() as {
        count: number;
      }
    ).count,
  };
}

/** Same canonical root resolver as production; the fixture never accepts an arbitrary Notebook path. */
function notebook(input: Parameters<typeof resolveScopedNotebookOwner>[0]): KnowledgeNotebook {
  return new KnowledgeNotebook({
    repositoryPath: join(resolveScopedNotebookOwner(input).notebookRoot, 'notebook.git'),
  });
}

describe('internal direct User and Server Notebook publication', () => {
  it.each([
    'user',
    'server',
  ] as const)('honors current %s protected-page policy before effects and again after preparation', async (kind) => {
    const f = fixture();
    const input = kind === 'user' ? f.user : f.server;
    const initial = kind === 'user' ? f.initialUser : f.initialServer;
    const db = kind === 'user' ? f.userDb : f.coreDb;
    const request = edit(initial, resolveScopedNotebookOwner(input).ownerScope);
    const configRoot =
      kind === 'user' ? join(f.dataRoot, 'users', alice, 'config') : join(f.dataRoot, 'config');
    const configPath = join(configRoot, kind === 'user' ? 'user.jsonc' : 'server.jsonc');
    const protect = (pageIds: string[]) => {
      mkdirSync(configRoot, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          schemaVersion: 1,
          knowledgeMaintenance: { enabled: false, reviewRequiredPageIds: pageIds },
        })
      );
      expect(input.runtimeConfigManager.reload({ mode: 'safe' }).status).toBe('applied');
    };
    protect(['note']);
    await expect(publishScopedNotebook(input, request)).rejects.toMatchObject({
      code: 'review_required',
    });
    expect(notebook(input).publishedRevision()).toBe(initial);
    expect(counts(db)).toEqual({ audit: 2, receipts: 0 });

    protect([]);
    const prepare = KnowledgeNotebook.prototype.prepare;
    const prepared = vi
      .spyOn(KnowledgeNotebook.prototype, 'prepare')
      .mockImplementationOnce(function (this: KnowledgeNotebook, input) {
        const candidate = prepare.call(this, input);
        protect(['note']);
        return candidate;
      });
    await expect(publishScopedNotebook(input, request)).rejects.toMatchObject({
      code: 'review_required',
    });
    expect(prepared).toHaveBeenCalledOnce();
    expect(notebook(input).publishedRevision()).toBe(initial);
    expect(counts(db)).toEqual({ audit: 2, receipts: 0 });
  });

  it.each([
    'user',
    'server',
  ] as const)('publishes and replays exact %s scope through its existing Audit/receipt owner', async (kind) => {
    const f = fixture();
    const input = kind === 'user' ? f.user : f.server;
    const ownerScope = resolveScopedNotebookOwner(input).ownerScope;
    const base = kind === 'user' ? f.initialUser : f.initialServer;
    const db = kind === 'user' ? f.userDb : f.coreDb;
    const request = edit(base, ownerScope);
    const first = await publishScopedNotebook(input, request);
    expect(first).toMatchObject({
      ownerScope,
      baseRevision: base,
      receiptRef: { requestId: request.requestId, ownerScope },
    });
    const saved = notebook(input).readRevision(first.notebookRevision);
    expect(saved.files['note.md']).toBe(request.changes[0]!.content);
    expect(saved.metadata.producer).toEqual({ kind: 'user', id: input.actor.userId });
    const later = await publishScopedNotebook(
      input,
      edit(first.notebookRevision, ownerScope, 'Later exact bytes.')
    );
    expect(
      await publishScopedNotebook(
        { ...input, store: new FsStore(), inflightCommands: new WeakMap() },
        request
      )
    ).toEqual(first);
    expect(notebook(input).publishedRevision()).toBe(later.notebookRevision);
    await expect(
      publishScopedNotebook(input, { ...request, summary: 'Changed input under same key' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    await expect(publishScopedNotebook(input, edit(base, ownerScope))).rejects.toMatchObject({
      code: 'conflict',
      currentRevision: later.notebookRevision,
    });
    const history = readScopedNotebookHistory({ ...input, limit: 2 });
    expect(history.ownerScope).toEqual(ownerScope);
    expect(history.revisions.map(({ revision }) => revision)).toEqual([
      later.notebookRevision,
      first.notebookRevision,
    ]);
    expect(history.nextRevision).toBe(base);
    const audits = db.sqlite
      .prepare(
        'SELECT notebook_admission_json AS evidence FROM audit_events WHERE request_id = ? ORDER BY rowid'
      )
      .all(request.requestId) as { evidence: string }[];
    expect(audits).toHaveLength(2);
    expect(audits.map(({ evidence }) => JSON.parse(evidence).ownerScope)).toEqual([
      ownerScope,
      ownerScope,
    ]);
    expect(counts(db)).toEqual({ audit: 6, receipts: 2 });
    const receipt = db.sqlite
      .prepare('SELECT scope_json AS scope FROM idempotency_requests WHERE request_id = ?')
      .get(request.requestId) as { scope: string };
    expect(JSON.parse(receipt.scope)).toEqual(
      kind === 'user' ? { userId: alice, actorId: alice } : { coreId: 'server', actorId: bob }
    );
    expect(notebook(kind === 'user' ? f.server : f.user).publishedRevision()).toBe(
      kind === 'user' ? f.initialServer : f.initialUser
    );
  });

  it('refuses foreign User profiles/databases and keeps administrator User inspection read-only', async () => {
    const f = fixture();
    const foreignDb = openUserDb(f.dataRoot, bob);
    applyScopedMigrations(foreignDb);
    try {
      const request = edit(f.initialUser, { kind: 'user', userId: alice });
      await expect(
        publishScopedNotebook({ ...f.user, userDb: foreignDb }, request)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        publishScopedNotebook(f.user, edit(f.initialUser, { kind: 'user', userId: bob }))
      ).rejects.toMatchObject({ code: 'invalid_request' });
      const inspection = {
        ...f.user,
        actor: f.administrator,
        target: { kind: 'user-inspection', userId: alice } as const,
      };
      expect(readScopedNotebookHistory(inspection).ownerScope).toEqual({
        kind: 'user',
        userId: alice,
      });
      await expect(
        publishScopedNotebook(
          inspection as unknown as Parameters<typeof publishScopedNotebook>[0],
          request
        )
      ).rejects.toThrow('Scoped notebook access denied.');
      await expect(
        publishScopedNotebook(
          { ...f.server, actor: f.actor },
          edit(f.initialServer, { kind: 'server' })
        )
      ).rejects.toThrow('Scoped notebook access denied.');
      expect(counts(f.userDb)).toEqual({ audit: 2, receipts: 0 });
      expect(counts(f.coreDb)).toEqual({ audit: 2, receipts: 0 });
      expect(counts(foreignDb)).toEqual({ audit: 0, receipts: 0 });
      expect(notebook(f.user).publishedRevision()).toBe(f.initialUser);
      expect(notebook(f.server).publishedRevision()).toBe(f.initialServer);
    } finally {
      foreignDb.sqlite.close();
    }
  });

  it('denies a disabled User and revoked current administrator before fresh effects or completed replay', async () => {
    const f = fixture();
    const userRequest = edit(f.initialUser, { kind: 'user', userId: alice });
    const serverRequest = edit(f.initialServer, { kind: 'server' });
    await publishScopedNotebook(f.user, userRequest);
    await publishScopedNotebook(f.server, serverRequest);
    const beforeUser = counts(f.userDb);
    const beforeServer = counts(f.coreDb);
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, alice))();
    revokeOpenKitAccessTokenRecord(f.coreDb, f.administrator.tokenId!);
    for (const [input, request] of [
      [f.user, userRequest],
      [f.server, serverRequest],
    ] as const) {
      await expect(publishScopedNotebook(input, request)).rejects.toThrow(
        'Scoped notebook access denied.'
      );
      await expect(
        publishScopedNotebook(input, { ...request, requestId: randomUUID() })
      ).rejects.toThrow('Scoped notebook access denied.');
      expect(() => readScopedNotebookHistory(input)).toThrow('Scoped notebook access denied.');
    }
    expect(counts(f.userDb)).toEqual(beforeUser);
    expect(counts(f.coreDb)).toEqual(beforeServer);
  });

  it('rechecks a real administrator revocation after preparation and before Audit/ref publication', async () => {
    const f = fixture();
    const prepare = KnowledgeNotebook.prototype.prepare;
    vi.spyOn(KnowledgeNotebook.prototype, 'prepare').mockImplementationOnce(function (
      this: KnowledgeNotebook,
      input
    ) {
      const revision = prepare.call(this, input);
      revokeOpenKitAccessTokenRecord(f.coreDb, f.administrator.tokenId!);
      return revision;
    });
    await expect(
      publishScopedNotebook(f.server, edit(f.initialServer, { kind: 'server' }))
    ).rejects.toThrow('Scoped notebook access denied.');
    expect(counts(f.coreDb)).toEqual({ audit: 2, receipts: 0 });
    expect(
      new KnowledgeNotebook({
        repositoryPath: join(f.dataRoot, 'server', 'knowledge', 'notebook.git'),
      }).publishedRevision()
    ).toBe(f.initialServer);
  });

  it('refuses unsupported Source refs in new edits and retained history instead of granting disclosure', async () => {
    const f = fixture();
    const scope = { kind: 'user', userId: alice } as const;
    const request = edit(f.initialUser, scope);
    const sourceContent = page(scope, 'Source-bound bytes.', [
      'source:ks_00000000-0000-7000-8000-000000000001',
    ]);
    await expect(
      publishScopedNotebook(f.user, {
        ...request,
        changes: [{ path: 'note.md', content: sourceContent }],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(counts(f.userDb)).toEqual({ audit: 2, receipts: 0 });
    const retained = notebook(f.user);
    const candidate = retained.prepare({
      baseRevision: f.initialUser,
      changes: { 'note.md': sourceContent },
      metadata: retained.readRevision(f.initialUser).metadata,
    });
    retained.publish({ baseRevision: f.initialUser, candidateRevision: candidate });
    expect(() => readScopedNotebookHistory(f.user)).toThrow('Notebook invalid request.');
    await expect(
      publishScopedNotebook(f.user, { ...request, baseRevision: candidate })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(retained.publishedRevision()).toBe(candidate);
    expect(counts(f.userDb)).toEqual({ audit: 2, receipts: 0 });
  });

  it.each([
    'user',
    'server',
  ] as const)('retains %s Git/Audit effects after receipt failure and refuses inferred completion', async (kind) => {
    const f = fixture();
    const input = kind === 'user' ? f.user : f.server;
    const db = kind === 'user' ? f.userDb : f.coreDb;
    const initial = kind === 'user' ? f.initialUser : f.initialServer;
    const request = edit(initial, resolveScopedNotebookOwner(input).ownerScope);
    db.sqlite.exec(
      "CREATE TRIGGER refuse_admission BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT, 'test admission fault'); END"
    );
    await expect(publishScopedNotebook(input, request)).rejects.toThrow('test admission fault');
    expect(notebook(input).publishedRevision()).toBe(initial);
    expect(counts(db)).toEqual({ audit: 2, receipts: 0 });
    db.sqlite.exec('DROP TRIGGER refuse_admission');
    db.sqlite.exec(
      "CREATE TRIGGER refuse_receipt BEFORE INSERT ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'test receipt fault'); END"
    );
    await expect(publishScopedNotebook(input, request)).rejects.toThrow('test receipt fault');
    const published = notebook(input).publishedRevision();
    expect(published).not.toBe(initial);
    expect(counts(db)).toEqual({ audit: 4, receipts: 0 });
    db.sqlite.exec('DROP TRIGGER refuse_receipt');
    await expect(
      publishScopedNotebook({ ...input, store: new FsStore() }, request)
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(notebook(input).publishedRevision()).toBe(published);
    expect(counts(db)).toEqual({ audit: 4, receipts: 0 });
  });
});
