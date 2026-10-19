// openkit-test-platform: posix
// The canonical-root regression creates a real fixture-local directory symlink.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  ContentReferenceSchema,
  KnowledgeBaseIdSchema,
  KnowledgeSourceIdSchema,
} from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, validateOpenKitKnowledgeProfile } from './okf.js';
import {
  listUserKnowledgeSources,
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';

const aliceId = 'usr_00000000-0000-7000-8000-000000000001';
const bobId = 'usr_00000000-0000-7000-8000-000000000002';

/** Real User authority, Notebook and raw files supply the oracle without model invocation. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'scoped-sources-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const databases = [aliceId, bobId].map((userId) => {
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at) VALUES (?, 'human', 'Source fixture', ?, 0, ?, ?)"
      )
      .run(userId, [userId, 'example.invalid'].join('@'), Date.now(), Date.now());
    const userDb = openUserDb(dataRoot, userId);
    applyScopedMigrations(userDb);
    return userDb;
  });
  const store = new FsStore({ dataRoot });
  const contexts = databases.map((userDb) => ({
    coreDb,
    userDb,
    actor: { kind: 'session' as const, userId: userDb.userId },
    store,
    inflightCommands: new WeakMap(),
  }));
  onTestFinished(() => {
    vi.restoreAllMocks();
    for (const db of databases) if (db.sqlite.open) db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const request = () => ({
    requestId: randomUUID(),
    kind: 'document' as const,
    title: 'Exact personal source',
    content: 'Literal source.\r\nUnicode Ω 雪.\n',
  });
  const root = (userId = aliceId) => join(dataRoot, 'users', userId, 'memory');
  const notebook = (userId = aliceId) =>
    new KnowledgeNotebook({ repositoryPath: join(root(userId), 'notebook.git') });
  const retained = (id: string, userId = aliceId) => {
    const book = notebook(userId);
    const revision = book.publishedRevision();
    const content = book.readSourcePointers(revision)[id]!;
    const parsed = parseOkfDocument({ path: `sources/${id}.md`, content });
    if (!parsed.ok) throw new Error('Fixture expects a valid canonical Source pointer.');
    const reference = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
    expect(reference.locator.ownerScope).toEqual({ kind: 'user', userId });
    const rawRoot = resolve(root(userId), 'raw');
    const rawPath = resolve(rawRoot, reference.locator.path);
    const confined = relative(rawRoot, rawPath);
    expect(isAbsolute(confined)).toBe(false);
    expect(confined === '..' || confined.startsWith('../')).toBe(false);
    return { book, revision, content, document: parsed.document, reference, rawPath };
  };
  // Fault injection uses Git publication directly; ordinary edits cannot alter captured facts.
  const publish = (id: string, content: string | null) => {
    const book = notebook();
    const baseRevision = book.publishedRevision();
    const candidateRevision = book.prepareSourcePointers({
      baseRevision,
      changes: { [id]: content },
      metadata: book.readRevision(baseRevision).metadata,
    });
    return book.publish({ baseRevision, candidateRevision }).revision;
  };
  return {
    alice: contexts[0]!,
    bob: contexts[1]!,
    coreDb,
    databases,
    dataRoot,
    request,
    root,
    notebook,
    retained,
    publish,
  };
}

describe('explicit native User Source intake', () => {
  it('captures exact literal bytes outside Git with one canonical SourceSummary pointer', async () => {
    const f = fixture();
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: f.dataRoot,
      scope: { kind: 'user', userId: aliceId },
    });
    expect(KnowledgeBaseIdSchema.safeParse(knowledgeBaseId).success).toBe(true);
    expect(await registerUserKnowledgeSource(f.alice, request)).toEqual(source);
    expect(
      readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'user', userId: aliceId } })
    ).toBe(knowledgeBaseId);
    expect(KnowledgeSourceIdSchema.safeParse(source.id).success).toBe(true);
    const digest = `sha256:${createHash('sha256').update(request.content).digest('hex')}`;
    expect(source).toMatchObject({
      ownerScope: { kind: 'user', userId: aliceId },
      kind: 'document',
      title: request.title,
      contentDigest: digest,
      uri: null,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(source.capturedAt).toBe(source.createdAt);
    expect(source.updatedAt).toBe(source.createdAt);
    const saved = f.retained(source.id);
    expect(Object.keys(saved.book.readSourcePointers(saved.revision))).toEqual([source.id]);
    expect(readFileSync(saved.rawPath)).toEqual(Buffer.from(request.content));
    expect(
      validateOpenKitKnowledgeProfile(saved.document, { kind: 'user', userId: aliceId })
    ).toMatchObject({ conformance: 'OpenKit-profile-valid', errors: [] });
    expect(saved.document.frontmatter).toMatchObject({
      type: 'SourceSummary',
      scope: { kind: 'user', userId: aliceId },
      title: request.title,
      sourceKind: 'document',
      contentRef: {
        knowledgeBaseId,
        contentDigest: digest,
        locator: { ownerScope: { kind: 'user', userId: aliceId }, mount: 'managed' },
        range: null,
        availability: 'available',
      },
      byteLength: Buffer.byteLength(request.content),
      mediaType: 'application/octet-stream',
      captureChannel: 'knowledge.source.register',
      capturedAt: source.capturedAt,
      created_at: source.createdAt,
      updated_at: source.updatedAt,
      sensitivity: 'confidential',
      requiredFeatures: ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-git-notebook.v1'],
      uri: null,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(saved.book.readRevision(saved.revision).metadata).toMatchObject({
      producer: { kind: 'user', id: aliceId },
      changeRequest: { requestId: request.requestId },
      authority: {
        kind: 'direct',
        instructionReference: `knowledge.source.register:${request.requestId}`,
      },
    });
    expect(
      existsSync(join(f.dataRoot, 'users', aliceId, 'sources', 'registry', `${source.id}.json`))
    ).toBe(false);
    expect(listUserKnowledgeSources(f.alice)).toEqual([source]);
    expect(await readUserKnowledgeSource(f.alice, source.id)).toEqual({
      source,
      content: request.content,
    });
    expect(await readUserKnowledgeSource(f.alice, source.id, 'model')).toEqual({
      source,
      content: request.content,
    });
    expect(listUserKnowledgeSources(f.alice, 'model')).toEqual([source]);
    expect(saved.book.readSourcePointers(saved.revision)[source.id]).not.toContain(request.content);
  });

  it('replays the original Source through durable User receipts after reopen and conflicts on changed input', async () => {
    const f = fixture();
    const request = f.request();
    const original = await registerUserKnowledgeSource(f.alice, request);
    const saved = f.retained(original.id);
    f.alice.userDb.sqlite.close();
    const reopenedDb = openUserDb(f.dataRoot, aliceId);
    f.databases.push(reopenedDb);
    const reopened = {
      ...f.alice,
      userDb: reopenedDb,
      store: new FsStore({ dataRoot: f.dataRoot }),
      inflightCommands: new WeakMap(),
    };
    expect(await registerUserKnowledgeSource(reopened, request)).toEqual(original);
    expect(f.notebook().publishedRevision()).toBe(saved.revision);
    expect(readFileSync(saved.rawPath)).toEqual(Buffer.from(request.content));
    await expect(
      registerUserKnowledgeSource(reopened, { ...request, content: 'Changed source.' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(Object.keys(f.notebook().readSourcePointers(f.notebook().publishedRevision()))).toEqual([
      original.id,
    ]);
    const audits = reopenedDb.sqlite
      .prepare(
        "SELECT actor_json, resource, summary FROM audit_events WHERE action = 'knowledge.source.register'"
      )
      .all() as { actor_json: string; resource: string; summary: string }[];
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.actor_json)).toEqual({ kind: 'user', id: aliceId });
    expect(audits[0]!.resource).toContain(original.id);
    expect(JSON.stringify(audits)).not.toContain(request.title);
    expect(JSON.stringify(audits)).not.toContain('Literal source.');
    expect(
      reopenedDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS total FROM idempotency_requests WHERE command_name = 'knowledge.source.register'"
        )
        .get()
    ).toEqual({ total: 1 });
    expect(
      f.coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'knowledge.source.register'"
        )
        .get()
    ).toEqual({ total: 0 });
  });

  it('refuses unjoined kinds, provenance, owner selectors and invalid text before creating storage', async () => {
    const f = fixture();
    const request = f.request();
    for (const change of [
      { kind: 'transcript' },
      { kind: 'url' },
      { kind: 'upload' },
      { kind: 'code' },
      { uri: 'https://example.invalid/document' },
      { originatingThreadId: 'th_00000000-0000-7000-8000-000000000001' },
      { originatingFileId: 'file' },
      { userId: bobId },
      { ownerScope: { kind: 'user', userId: bobId } },
      { content: '' },
      { content: '\ud800' },
      { requestId: 'invalid' },
    ]) {
      await expect(
        registerUserKnowledgeSource(f.alice, { ...request, ...change } as typeof request)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(existsSync(f.root())).toBe(false);
  });

  it('derives the current self and refuses foreign handles and Workers before metadata', async () => {
    const f = fixture();
    const source = await registerUserKnowledgeSource(f.alice, f.request());
    const foreign = { ...f.alice, actor: { kind: 'session' as const, userId: bobId } };
    const worker = {
      ...f.alice,
      actor: { kind: 'worker', userId: aliceId },
    } as unknown as typeof f.alice;
    for (const context of [foreign, worker]) {
      expect(() => listUserKnowledgeSources(context)).toThrow('Scoped notebook access denied.');
      await expect(readUserKnowledgeSource(context, source.id)).rejects.toThrow(
        'Scoped notebook access denied.'
      );
      await expect(registerUserKnowledgeSource(context, f.request())).rejects.toThrow(
        'Scoped notebook access denied.'
      );
    }
    await expect(readUserKnowledgeSource(f.alice, '../outside')).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
    await expect(
      readUserKnowledgeSource({ ...f.alice, userDb: f.bob.userDb }, source.id)
    ).rejects.toThrow('Scoped notebook access denied.');
  });

  it('rechecks active User and current bearer authority for reads and replay', async () => {
    const f = fixture();
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: aliceId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const bearer = {
      ...f.alice,
      actor: {
        kind: 'token' as const,
        userId: aliceId,
        tokenId: issued.tokenId,
        tokenScope: 'server-admin' as const,
      },
    };
    const request = f.request();
    const source = await registerUserKnowledgeSource(bearer, request);
    expect((await readUserKnowledgeSource(bearer, source.id))?.content).toBe(request.content);
    revokeOpenKitAccessTokenRecord(f.coreDb, issued.tokenId);
    expect(() => listUserKnowledgeSources(bearer)).toThrow('Scoped notebook access denied.');
    await expect(readUserKnowledgeSource(bearer, source.id)).rejects.toThrow(
      'Scoped notebook access denied.'
    );
    await expect(registerUserKnowledgeSource(bearer, request)).rejects.toThrow(
      'Scoped notebook access denied.'
    );
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, aliceId))();
    await expect(readUserKnowledgeSource(f.alice, source.id)).rejects.toThrow(
      'Scoped notebook access denied.'
    );
    await expect(registerUserKnowledgeSource(f.alice, f.request())).rejects.toThrow(
      'Scoped notebook access denied.'
    );
  });

  it('does not replace absent established Source storage or return an empty store', async () => {
    const f = fixture();
    expect(listUserKnowledgeSources(f.alice)).toEqual([]);
    expect(existsSync(f.root())).toBe(false);
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    rmSync(f.root(), { recursive: true });
    await expect(readUserKnowledgeSource(f.alice, source.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(() => listUserKnowledgeSources(f.alice)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    await expect(registerUserKnowledgeSource(f.alice, request)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    await expect(registerUserKnowledgeSource(f.alice, f.request())).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(existsSync(f.root())).toBe(false);
  });

  it('refuses an absent established pointer rather than returning an empty Source collection', async () => {
    const f = fixture();
    const source = await registerUserKnowledgeSource(f.alice, f.request());
    f.publish(source.id, null);
    expect
      .soft(() => listUserKnowledgeSources(f.alice))
      .toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    await expect
      .soft(readUserKnowledgeSource(f.alice, source.id))
      .rejects.toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });

  it('keeps two User Source collections separate even for the same request identity', async () => {
    const f = fixture();
    const request = f.request();
    const alice = await registerUserKnowledgeSource(f.alice, request);
    const bobRequest = {
      ...request,
      title: 'Other personal source',
      content: 'Other exact source.',
    };
    const bob = await registerUserKnowledgeSource(f.bob, bobRequest);
    expect(bob.id).not.toBe(alice.id);
    expect(listUserKnowledgeSources(f.alice)).toEqual([alice]);
    expect(listUserKnowledgeSources(f.bob)).toEqual([bob]);
    expect(await readUserKnowledgeSource(f.alice, bob.id)).toBeNull();
    expect(await readUserKnowledgeSource(f.bob, alice.id)).toBeNull();
    expect((await readUserKnowledgeSource(f.bob, bob.id))?.content).toBe(bobRequest.content);
    expect(
      f.notebook(bobId).readSourcePointers(f.notebook(bobId).publishedRevision())
    ).not.toHaveProperty(alice.id);
  });

  it('refuses a redirected Source root without following it or replacing retained bytes', async () => {
    const f = fixture();
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    const saved = f.retained(source.id);
    const retainedRoot = `${f.root()}-retained`;
    renameSync(f.root(), retainedRoot);
    symlinkSync(retainedRoot, f.root(), 'dir');
    expect
      .soft(() => listUserKnowledgeSources(f.alice))
      .toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    await expect
      .soft(readUserKnowledgeSource(f.alice, source.id))
      .rejects.toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    await expect.soft(registerUserKnowledgeSource(f.alice, f.request())).rejects.toMatchObject({
      code: 'recovery_required',
    });
    const retainedBook = new KnowledgeNotebook({
      repositoryPath: join(retainedRoot, 'notebook.git'),
    });
    expect(Object.keys(retainedBook.readSourcePointers(retainedBook.publishedRevision()))).toEqual([
      source.id,
    ]);
    expect(readFileSync(join(retainedRoot, 'raw', saved.reference.locator.path), 'utf8')).toBe(
      request.content
    );
  });

  it('ignores descriptive additions but refuses unsupported semantics and corrupt captured bytes without repair', async () => {
    const f = fixture();
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    const saved = f.retained(source.id);
    const original = saved.document.frontmatter;
    const annotated = `---\n${JSON.stringify({ ...original, description: 'Unknown annotation', contentRef: { ...saved.reference, description: 'Unknown reference annotation' }, descriptive: { note: 'Unknown nested annotation' } })}\n---\n`;
    f.publish(source.id, annotated);
    writeFileSync(join(f.root(), 'notes.txt'), 'Descriptive file addition.');
    expect(await readUserKnowledgeSource(f.alice, source.id)).toEqual({
      source,
      content: request.content,
    });
    expect(f.retained(source.id).content).toBe(annotated);
    for (const change of [
      { schema_version: 'unsupported-scope-schema' },
      { type: 'UnknownSource' },
      {
        requiredFeatures: [
          ...(original.requiredFeatures as string[]),
          'openkit.memory-suppression.v1',
        ],
      },
      { sourceKind: 'unknown-source-kind' },
    ]) {
      const retained = `---\n${JSON.stringify({ ...original, ...change })}\n---\n`;
      const revision = f.publish(source.id, retained);
      expect
        .soft(() => listUserKnowledgeSources(f.alice), JSON.stringify(change))
        .toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(f.notebook().readSourcePointers(revision)[source.id]).toBe(retained);
    }
    f.publish(source.id, saved.content);
    const material = saved.rawPath;
    writeFileSync(material, 'Changed retained source.');
    expect(await readUserKnowledgeSource(f.alice, source.id)).toBeNull();
    expect(listUserKnowledgeSources(f.alice)).toEqual([source]);
    expect(readFileSync(material, 'utf8')).toBe('Changed retained source.');
    rmSync(material);
    expect(await readUserKnowledgeSource(f.alice, source.id)).toBeNull();
    expect(listUserKnowledgeSources(f.alice)).toEqual([source]);
    expect(f.retained(source.id).content).toBe(saved.content);
  });

  it('does not allocate another Source after a missing completion receipt', async () => {
    const f = fixture();
    const request = f.request();
    vi.spyOn(f.alice.store, 'recordCommandRequest').mockImplementationOnce(() => {
      throw new Error('Receipt unavailable.');
    });
    await expect.soft(registerUserKnowledgeSource(f.alice, request)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    const retained = Object.keys(f.notebook().readSourcePointers(f.notebook().publishedRevision()));
    expect(retained).toHaveLength(1);
    await expect.soft(registerUserKnowledgeSource(f.alice, request)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(Object.keys(f.notebook().readSourcePointers(f.notebook().publishedRevision()))).toEqual(
      retained
    );
  });
});
