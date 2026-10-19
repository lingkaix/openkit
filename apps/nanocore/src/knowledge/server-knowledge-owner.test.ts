import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ContentReferenceSchema, KnowledgeBaseIdSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, validateOpenKitKnowledgeProfile } from './okf.js';
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
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: f.dataRoot,
      scope: { kind: 'server' },
    });
    expect(KnowledgeBaseIdSchema.safeParse(knowledgeBaseId).success).toBe(true);
    expect(await registerServerKnowledgeSource(f, request)).toEqual(source);
    expect(readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'server' } })).toBe(
      knowledgeBaseId
    );
    expect(source).toMatchObject({ ownerScope: { kind: 'server' }, kind: 'document', uri: null });
    expect(await readServerKnowledgeSource(f, source.id)).toEqual({
      source,
      content: request.content,
    });
    expect(listServerKnowledgeSources(f)).toEqual([source]);
    const root = join(f.dataRoot, 'server', 'knowledge');
    const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
    const revision = notebook.publishedRevision();
    const pointer = notebook.readSourcePointers(revision)[source.id]!;
    const parsed = parseOkfDocument({ path: `sources/${source.id}.md`, content: pointer });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Canonical Server Source pointer must be valid OKF.');
    expect(validateOpenKitKnowledgeProfile(parsed.document, { kind: 'server' })).toMatchObject({
      conformance: 'OpenKit-profile-valid',
      errors: [],
    });
    const reference = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
    const rawRoot = resolve(root, 'raw');
    const rawPath = resolve(rawRoot, reference.locator.path);
    const confined = relative(rawRoot, rawPath);
    expect(isAbsolute(confined)).toBe(false);
    expect(confined === '..' || confined.startsWith('../')).toBe(false);
    const digest = `sha256:${createHash('sha256').update(Buffer.from(request.content)).digest('hex')}`;
    expect(source.contentDigest).toBe(digest);
    expect(readFileSync(rawPath)).toEqual(Buffer.from(request.content));
    expect(parsed.document.frontmatter).toMatchObject({
      type: 'SourceSummary',
      scope: { kind: 'server' },
      title: request.title,
      sourceKind: 'document',
      contentRef: {
        knowledgeBaseId,
        contentDigest: digest,
        locator: { ownerScope: { kind: 'server' }, mount: 'managed' },
        range: null,
        availability: 'available',
      },
      byteLength: Buffer.byteLength(request.content),
      mediaType: 'application/octet-stream',
      captureChannel: 'knowledge.source.register',
      capturedAt: source.capturedAt,
      created_at: source.createdAt,
      updated_at: source.updatedAt,
      sensitivity: 'internal',
      uri: null,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(parsed.document.frontmatter.scope).not.toHaveProperty('workspaceId');
    expect(notebook.readRevision(revision).metadata).toMatchObject({
      producer: { kind: 'user', id: f.actor.userId },
      changeRequest: { requestId: request.requestId },
      authority: {
        kind: 'direct',
        instructionReference: `knowledge.source.register:${request.requestId}`,
      },
    });
    expect(existsSync(join(f.dataRoot, 'server', 'sources', 'registry', `${source.id}.json`))).toBe(
      false
    );
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
    expect(await readServerKnowledgeSource(f, workspaceSourceId)).toBeNull();
    expect(
      admitsServerKnowledge({ ...f, actor: { kind: 'session', userId: f.actor.userId } })
    ).toBe(false);
    expect(() => listServerKnowledgeSources({ ...f, actor: undefined })).toThrow(
      'Server Knowledge access denied.'
    );
    writeFileSync(rawPath, 'Changed captured bytes');
    expect(await readServerKnowledgeSource(f, source.id)).toBeNull();
    expect(listServerKnowledgeSources(f)).toEqual([source]);
    expect(notebook.readSourcePointers(notebook.publishedRevision())[source.id]).toBe(pointer);
    expect(readFileSync(rawPath, 'utf8')).toBe('Changed captured bytes');
    rmSync(rawPath);
    expect(await readServerKnowledgeSource(f, source.id)).toBeNull();
    expect(listServerKnowledgeSources(f)).toEqual([source]);
    rmSync(root, { recursive: true });
    expect(() => listServerKnowledgeSources(f)).toThrow('Server Source storage requires recovery.');
  });
});
