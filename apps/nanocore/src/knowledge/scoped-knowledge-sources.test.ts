// openkit-test-platform: posix
// The canonical-root regression creates a real fixture-local directory symlink.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecordEnvelope } from '@openkit/config-schema';
import { KnowledgeBaseIdSchema, KnowledgeSourceIdSchema } from '@openkit/protocol';
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
import {
  listUserKnowledgeSources,
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';

const aliceId = 'usr_00000000-0000-7000-8000-000000000001';
const bobId = 'usr_00000000-0000-7000-8000-000000000002';

/** Real User databases and files supply the oracle without a Notebook, Workspace or model invocation. */
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
  const store = new FsStore();
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
  const root = (userId = aliceId) => join(dataRoot, 'users', userId, 'sources');
  return { alice: contexts[0]!, bob: contexts[1]!, coreDb, databases, dataRoot, request, root };
}

describe('explicit native User Source intake', () => {
  it('captures exact literal bytes under the sibling Source family with one canonical envelope', async () => {
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
    expect(readFileSync(join(f.root(), 'materials', source.id, 'content.txt'))).toEqual(
      Buffer.from(request.content)
    );
    const row = JSON.parse(readFileSync(join(f.root(), 'registry', `${source.id}.json`), 'utf8'));
    expect(row).toMatchObject({
      schemaVersion: 1,
      recordType: 'source',
      id: source.id,
      ownerScope: 'user',
      lineage: { userId: aliceId, requestId: request.requestId },
      contentDigest: digest,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      redactionLevel: 'none',
      sensitivity: 'confidential',
      requiredFeatures: ['openkit.knowledge-owner-scope.v1'],
      payload: {
        kind: 'document',
        title: request.title,
        uri: null,
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
      },
    });
    expect(Object.keys(row.payload).sort()).toEqual(
      [
        'kind',
        'title',
        'uri',
        'originatingThreadId',
        'originatingTurnId',
        'originatingFileId',
      ].sort()
    );
    expect(() => parseRecordEnvelope(row)).toThrow(
      'Unsupported required feature: openkit.knowledge-owner-scope.v1'
    );
    expect(
      parseRecordEnvelope(row, { supportedFeatures: ['openkit.knowledge-owner-scope.v1'] }).id
    ).toBe(source.id);
    expect(listUserKnowledgeSources(f.alice)).toEqual([source]);
    expect(readUserKnowledgeSource(f.alice, source.id)).toEqual({
      source,
      content: request.content,
    });
    expect(readUserKnowledgeSource(f.alice, source.id, 'model')).toEqual({
      source,
      content: request.content,
    });
    expect(listUserKnowledgeSources(f.alice, 'model')).toEqual([source]);
    expect(existsSync(join(f.dataRoot, 'users', aliceId, 'memory'))).toBe(false);
  });

  it('replays the original Source through durable User receipts after reopen and conflicts on changed input', async () => {
    const f = fixture();
    const request = f.request();
    const original = await registerUserKnowledgeSource(f.alice, request);
    f.alice.userDb.sqlite.close();
    const reopenedDb = openUserDb(f.dataRoot, aliceId);
    f.databases.push(reopenedDb);
    const reopened = {
      ...f.alice,
      userDb: reopenedDb,
      store: new FsStore(),
      inflightCommands: new WeakMap(),
    };
    expect(await registerUserKnowledgeSource(reopened, request)).toEqual(original);
    await expect(
      registerUserKnowledgeSource(reopened, { ...request, content: 'Changed source.' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(readdirSync(join(f.root(), 'registry'))).toEqual([`${original.id}.json`]);
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
      expect(() => readUserKnowledgeSource(context, source.id)).toThrow(
        'Scoped notebook access denied.'
      );
      await expect(registerUserKnowledgeSource(context, f.request())).rejects.toThrow(
        'Scoped notebook access denied.'
      );
    }
    expect(() => readUserKnowledgeSource(f.alice, '../outside')).toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(() => readUserKnowledgeSource({ ...f.alice, userDb: f.bob.userDb }, source.id)).toThrow(
      'Scoped notebook access denied.'
    );
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
    expect(readUserKnowledgeSource(bearer, source.id)?.content).toBe(request.content);
    revokeOpenKitAccessTokenRecord(f.coreDb, issued.tokenId);
    expect(() => listUserKnowledgeSources(bearer)).toThrow('Scoped notebook access denied.');
    await expect(registerUserKnowledgeSource(bearer, request)).rejects.toThrow(
      'Scoped notebook access denied.'
    );
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, aliceId))();
    expect(() => readUserKnowledgeSource(f.alice, source.id)).toThrow(
      'Scoped notebook access denied.'
    );
    await expect(registerUserKnowledgeSource(f.alice, f.request())).rejects.toThrow(
      'Scoped notebook access denied.'
    );
  });

  it('does not replace absent established Source storage or return an empty store', async () => {
    const f = fixture();
    expect(() => listUserKnowledgeSources(f.alice)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(existsSync(f.root())).toBe(false);
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    rmSync(f.root(), { recursive: true });
    expect(() => readUserKnowledgeSource(f.alice, source.id)).toThrowError(
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
    expect(readUserKnowledgeSource(f.alice, bob.id)).toBeNull();
    expect(readUserKnowledgeSource(f.bob, alice.id)).toBeNull();
    expect(readUserKnowledgeSource(f.bob, bob.id)?.content).toBe(bobRequest.content);
    expect(existsSync(join(f.root(bobId), 'registry', `${alice.id}.json`))).toBe(false);
  });

  it('refuses a redirected Source root without following it or replacing retained bytes', async () => {
    const f = fixture();
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    const retainedRoot = `${f.root()}-retained`;
    renameSync(f.root(), retainedRoot);
    symlinkSync(retainedRoot, f.root(), 'dir');
    expect(() => listUserKnowledgeSources(f.alice)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(() => readUserKnowledgeSource(f.alice, source.id)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    await expect(registerUserKnowledgeSource(f.alice, f.request())).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(readdirSync(join(retainedRoot, 'registry'))).toEqual([`${source.id}.json`]);
    expect(readFileSync(join(retainedRoot, 'materials', source.id, 'content.txt'), 'utf8')).toBe(
      request.content
    );
  });

  it('ignores descriptive additions but refuses unsupported semantics and corrupt captured bytes without repair', async () => {
    const f = fixture();
    const request = f.request();
    const source = await registerUserKnowledgeSource(f.alice, request);
    const path = join(f.root(), 'registry', `${source.id}.json`);
    const original = JSON.parse(readFileSync(path, 'utf8'));
    const annotated = JSON.stringify({
      ...original,
      description: 'Unknown annotation',
      lineage: { ...original.lineage, description: 'Unknown lineage annotation' },
      payload: { ...original.payload, descriptive: { note: 'Unknown nested annotation' } },
    });
    writeFileSync(path, annotated);
    writeFileSync(join(f.root(), 'registry', 'notes.txt'), 'Descriptive file addition.');
    expect(readUserKnowledgeSource(f.alice, source.id)).toEqual({
      source,
      content: request.content,
    });
    expect(readFileSync(path, 'utf8')).toBe(annotated);
    for (const change of [
      { schemaVersion: 2 },
      { recordType: 'unknown-source' },
      { requiredFeatures: ['openkit.knowledge-owner-scope.v1', 'openkit.memory-suppression.v1'] },
      { payload: { ...original.payload, kind: 'transcript' } },
    ]) {
      const retained = JSON.stringify({ ...original, ...change });
      writeFileSync(path, retained);
      expect(() => listUserKnowledgeSources(f.alice)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(readFileSync(path, 'utf8')).toBe(retained);
    }
    writeFileSync(path, JSON.stringify(original));
    const material = join(f.root(), 'materials', source.id, 'content.txt');
    writeFileSync(material, 'Changed retained source.');
    expect(() => readUserKnowledgeSource(f.alice, source.id)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(readFileSync(material, 'utf8')).toBe('Changed retained source.');
  });

  it('does not allocate another Source after a missing completion receipt', async () => {
    const f = fixture();
    const request = f.request();
    vi.spyOn(f.alice.store, 'recordCommandRequest').mockImplementationOnce(() => {
      throw new Error('Receipt unavailable.');
    });
    await expect(registerUserKnowledgeSource(f.alice, request)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    const retained = readdirSync(join(f.root(), 'registry'));
    expect(retained).toHaveLength(1);
    await expect(registerUserKnowledgeSource(f.alice, request)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(readdirSync(join(f.root(), 'registry'))).toEqual(retained);
  });
});
