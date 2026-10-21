// openkit-test-platform: posix
// The contract composes actual Notebook Git publication with managed LocalStorage originals.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { allocateEntityId, ContentReferenceSchema } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { acceptWorkspaceInvitation, createWorkspaceInvitation } from '../workspace-sharing.js';
import { deriveManagedSourceAccess } from './managed-source-access.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, validateOpenKitKnowledgeProfile } from './okf.js';
import { readSourceByteRange } from './source-bytes.js';
import { parseSourcePointer } from './source-pointers.js';
import { publishCapturedSource } from './source-publication.js';
import { readManagedSourceText } from './source-reading.js';

/** A fresh real Workspace with current human membership and the existing command engine. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-source-cutover-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Canonical Workspace Sources');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(async () => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const actor = { kind: 'session' as const, userId };
  const access: KnowledgeRetrievalAccess = {
    coreDb,
    store,
    actor: { kind: 'user', id: userId },
    requestActor: actor,
  };
  const invoke = createOperationInvocation({
    coreDb,
    store,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    repositoryWorkspaceDb: (workspaceId) => {
      const db = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(db);
      return db;
    },
  });
  const scope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const root = join(dataRoot, 'workspaces', workspace.id);
  const notebookRoot = join(root, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(notebookRoot, 'notebook.git') });
  const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot, scope });
  return {
    dataRoot,
    coreDb,
    workspaceDb,
    userId,
    store,
    workspace,
    actor,
    access,
    invoke,
    scope,
    root,
    notebookRoot,
    notebook,
    knowledgeBaseId,
  };
}

/** Inspect exact native Git bytes and confine the published logical locator before reading raw. */
function retained(f: Awaited<ReturnType<typeof fixture>>, sourceId: string, bytes: Uint8Array) {
  const revision = f.notebook.publishedRevision();
  const content = f.notebook.readSourcePointers(revision)[sourceId]!;
  const parsed = parseOkfDocument({ path: `sources/${sourceId}.md`, content });
  if (!parsed.ok) throw new Error('Fixture requires a published canonical SourceSummary.');
  expect(validateOpenKitKnowledgeProfile(parsed.document, f.scope)).toMatchObject({
    conformance: 'OpenKit-profile-valid',
    errors: [],
  });
  const reference = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
  expect(reference).toMatchObject({
    knowledgeBaseId: f.knowledgeBaseId,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    locator: { ownerScope: f.scope, mount: 'managed' },
    range: null,
    availability: 'available',
  });
  const rawRoot = resolve(f.notebookRoot, 'raw');
  const rawPath = resolve(rawRoot, reference.locator.path);
  const confined = relative(rawRoot, rawPath);
  expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
  expect(readFileSync(rawPath)).toEqual(Buffer.from(bytes));
  return { revision, content, reference, rawRoot, rawPath, document: parsed.document };
}

describe('Workspace native Source cutover', () => {
  it('publishes the public capture once in the current Notebook and retains private origin admission', async () => {
    const f = await fixture();
    const origin = await f.store.createThread(
      f.workspace.id,
      'Private captured origin',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: f.userId,
      }
    );
    const input = {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      kind: 'document' as const,
      title: 'Explicit Workspace original',
      content: 'Exact Workspace original.\r\nUnicode Ω 雪.\n',
      originatingThreadId: origin.id,
    };
    const context = { kind: 'public' as const, actor: f.actor };
    const before = f.notebook.publishedRevision();
    const result = await f.invoke('knowledge.source.register', input, context);
    const revision = f.notebook.publishedRevision();
    expect(result.source).toMatchObject({
      workspaceId: f.workspace.id,
      title: input.title,
      originatingThreadId: origin.id,
      contentDigest: `sha256:${createHash('sha256').update(Buffer.from(input.content)).digest('hex')}`,
    });
    expect(await f.invoke('knowledge.source.register', input, context)).toEqual(result);
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(
      (await f.invoke('knowledge.source.list', { workspaceId: f.workspace.id }, context)).items
    ).toEqual([result.source]);
    expect(
      (
        await f.invoke(
          'knowledge.source.read',
          { workspaceId: f.workspace.id, sourceId: result.source.id },
          context
        )
      ).source
    ).toEqual(result.source);

    const otherUserId = allocateEntityId('usr');
    const email = `${otherUserId}@example.invalid`;
    f.coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status) VALUES (?, 'human', 'Other member', ?, 0, ?, ?, 'active')"
      )
      .run(otherUserId, email, Date.now(), Date.now());
    const invitation = f.coreDb.sqlite.transaction(() =>
      createWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId: f.workspace.id,
        inviterUserId: f.userId,
        inviteeEmail: email,
      })
    )();
    expect(invitation.kind).toBe('created');
    if (invitation.kind !== 'created') throw new Error('Fixture invitation was not created.');
    const accepted = f.coreDb.sqlite.transaction(() =>
      acceptWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId: f.workspace.id,
        invitationId: invitation.invitation.invitationId,
        inviteeUserId: otherUserId,
        expectedRevision: invitation.invitation.revision,
      })
    )();
    expect(accepted.kind).toBe('accepted');
    const otherContext = {
      kind: 'public' as const,
      actor: { kind: 'session' as const, userId: otherUserId },
    };
    expect(
      (await f.invoke('knowledge.source.list', { workspaceId: f.workspace.id }, otherContext)).items
    ).toEqual([]);
    await expect(
      f.invoke(
        'knowledge.source.read',
        { workspaceId: f.workspace.id, sourceId: result.source.id },
        otherContext
      )
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });

    expect
      .soft(existsSync(join(f.root, 'sources', 'registry', `${result.source.id}.json`)))
      .toBe(false);
    expect
      .soft(existsSync(join(f.root, 'sources', 'materials', result.source.id, 'content.txt')))
      .toBe(false);
    expect(Object.keys(f.notebook.readSourcePointers(revision))).toEqual([result.source.id]);
    expect(revision).not.toBe(before);
    const saved = retained(f, result.source.id, Buffer.from(input.content));
    expect(saved.document.frontmatter).toMatchObject({
      type: 'SourceSummary',
      scope: f.scope,
      title: input.title,
      sourceKind: input.kind,
      byteLength: Buffer.byteLength(input.content),
      mediaType: 'application/octet-stream',
      captureChannel: 'knowledge.source.register',
      capturedAt: result.source.capturedAt,
      originatingThreadId: origin.id,
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(saved.content).not.toContain(input.content);
    expect(f.notebook.readRevision(revision).metadata).toMatchObject({
      producer: { kind: 'user', id: f.userId },
      changeRequest: { requestId: input.requestId },
      authority: {
        kind: 'direct',
        instructionReference: `knowledge.source.register:${input.requestId}`,
      },
    });
    expect(
      f.workspaceDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'knowledge.source.register' AND request_id = ?"
        )
        .get(input.requestId)
    ).toEqual({ count: 1 });
    expect(
      f.workspaceDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name = 'knowledge.source.register' AND request_id = ?"
        )
        .get(input.requestId)
    ).toEqual({ count: 1 });
    await expect(
      f.invoke('knowledge.source.register', { ...input, content: 'Changed input.' }, context)
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(readFileSync(saved.rawPath)).toEqual(Buffer.from(input.content));
  });

  it('publishes non-UTF8 binary originals through the common native publisher and reads exact ranges', async () => {
    const f = await fixture();
    const bytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
        'base64'
      )
    );
    const now = new Date().toISOString();
    const source = {
      id: allocateEntityId('ks'),
      kind: 'document' as const,
      title: 'Captured binary original',
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      uri: null,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const owner = { dataRoot: f.dataRoot, ownerScope: f.scope };
    await publishCapturedSource(
      {
        owner,
        database: { kind: 'workspace', workspaceDb: f.workspaceDb },
        access: f.access,
        producer: { kind: 'user', id: f.userId },
        requestId: randomUUID(),
        commandInput: source,
        captureChannel: 'knowledge.source.register',
        revalidatePublication: () => {
          if (
            !isWorkspaceOperationAuthorized(f.coreDb, f.actor, f.workspace.id, {
              mutating: true,
              policyOperation: 'knowledge.write',
            })
          )
            throw new Error('Fixture requires current Source publication authority.');
        },
      },
      source,
      bytes
    );
    expect(Object.keys(f.notebook.readSourcePointers(f.notebook.publishedRevision()))).toEqual([
      source.id,
    ]);
    const saved = retained(f, source.id, bytes);
    expect(saved.document.frontmatter).toMatchObject({
      type: 'SourceSummary',
      byteLength: bytes.byteLength,
      mediaType: 'image/png',
      captureChannel: 'knowledge.source.register',
    });
    const pointer = parseSourcePointer(owner, source.id, saved.content);
    const mount = readKnowledgeMounts({ dataRoot: f.dataRoot, scope: f.scope }).find(
      (candidate) => candidate.default
    )!;
    const admit = () =>
      deriveManagedSourceAccess({
        owner,
        knowledgeBaseId: f.knowledgeBaseId,
        mount,
        access: f.access,
        consumer: 'native',
        mode: 'read-only',
      });
    const storage = new LocalStorage({
      mounts: [
        {
          name: mount.name,
          ownerScope: f.scope,
          knowledgeBaseId: f.knowledgeBaseId,
          root: saved.rawRoot,
          managed: true,
        },
      ],
      stagingRoot: join(f.notebookRoot, '.source-staging'),
    });
    try {
      const range = await readSourceByteRange({ pointer, storage, admit, offset: 8, length: 13 });
      expect(range.status).toBe('ok');
      if (range.status !== 'ok') throw new Error('Captured binary range must remain available.');
      expect(Array.from(range.value)).toEqual(Array.from(bytes.subarray(8, 21)));
      await expect(readManagedSourceText({ owner, pointer, access: f.access })).resolves.toEqual({
        status: 'unavailable',
        reason: 'unsupported',
        reference: saved.reference,
      });
    } finally {
      await storage.close();
    }
  });
});
