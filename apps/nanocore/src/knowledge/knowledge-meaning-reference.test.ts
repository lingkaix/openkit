import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, formatReferenceUri, type KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveKnowledgeMeaningReference } from './knowledge-meaning-reference.js';
import { KnowledgeNotebook } from './notebook.js';
import { updateOkfFrontmatter } from './okf.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';

const NOW = '2026-10-19T00:00:00.000Z';
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Actual native scope creation and Git publication; no parser or authorization double. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'knowledge-meaning-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Meaning references');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const access: KnowledgeRetrievalAccess = {
    coreDb,
    store,
    actor: { kind: 'user', id: userId },
    requestActor: { kind: 'local', userId },
  };
  const ownerScope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { dataRoot, coreDb, userId, store, access, workspace, ownerScope, notebook };
}

/** Native page bytes, including descriptive extensions, are checked as a complete exact document. */
function page(ownerScope: KnowledgeOwnerScope, sourceReferences: string[] = []) {
  return serializeUserAuthoredKnowledgePage(
    {
      id: 'domain',
      kind: 'project-context',
      title: 'Domain meaning',
      content: 'Exact domain meaning.\n',
      sourceReferences,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerScope
  );
}

/** Fixed Git publication is the fixture effect; the subject is the native read boundary. */
function publish(
  f: ReturnType<typeof fixture>,
  notebook: KnowledgeNotebook,
  content: string,
  retainOnly = false
) {
  const baseRevision = notebook.publishedRevision();
  const candidateRevision = notebook.prepare({
    baseRevision,
    changes: { 'domain.md': content },
    metadata: {
      summary: 'Publish meaning',
      producer: { kind: 'user', id: f.userId },
      authority: { kind: 'direct', instructionReference: 'test:meaning' },
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(content) },
      sourceReferences: [],
    },
  });
  if (retainOnly) notebook.retainCandidate({ proposalId: randomUUID(), candidateRevision });
  else notebook.publish({ baseRevision, candidateRevision });
  return candidateRevision;
}

function reference(
  f: ReturnType<typeof fixture>,
  scope: Exclude<KnowledgeOwnerScope, { kind: 'user' }> = f.ownerScope,
  content = page(f.ownerScope)
) {
  const kb = readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope });
  const scopeId =
    scope.kind === 'server' ? `page/server/${kb}` : `page/workspace/${f.workspace.id}/${kb}`;
  return formatReferenceUri({ scopeId, objectId: 'domain' }, digest(content));
}

function resolve(f: ReturnType<typeof fixture>, uri: string) {
  return resolveKnowledgeMeaningReference({
    workspaceId: f.workspace.id,
    reference: uri,
    access: f.access,
  });
}

const unavailable = (reference: string) => ({ status: 'unavailable', reference });

describe('exact governed Knowledge meaning receiver', () => {
  it('returns exact current and older published bytes without selecting an unpublished candidate', () => {
    const f = fixture();
    const content = page(f.ownerScope);
    const revision = publish(f, f.notebook, content);
    const uri = reference(f);
    expect(resolve(f, uri)).toEqual({
      status: 'available',
      reference: uri,
      contentDigest: digest(content),
      notebookRevision: revision,
      content,
    });
    const changed = content.replace('Exact domain meaning.', 'Later domain meaning.');
    publish(f, f.notebook, changed);
    expect(resolve(f, uri)).toEqual({
      status: 'available',
      reference: uri,
      contentDigest: digest(content),
      notebookRevision: revision,
      content,
    });
    const pending = changed.replace('Later domain meaning.', 'Unpublished meaning.');
    publish(f, f.notebook, pending, true);
    const pendingUri = reference(f, f.ownerScope, pending);
    expect(resolve(f, pendingUri)).toEqual(unavailable(pendingUri));
  });

  it('refuses missing pins, wrong bytes/KB/Workspace, private User and unsupported raw targets uniformly', () => {
    const f = fixture();
    publish(f, f.notebook, page(f.ownerScope));
    const uri = reference(f);
    for (const denied of [
      uri.split('@')[0]!,
      uri.replace(digest(page(f.ownerScope)), `sha256:${'0'.repeat(64)}`),
      uri.replace(
        readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: f.ownerScope }),
        allocateEntityId('kb')
      ),
      uri.replace(f.workspace.id, allocateEntityId('ws')),
      formatReferenceUri(
        { scopeId: `page/user/${f.userId}/${allocateEntityId('kb')}`, objectId: 'domain' },
        digest(page(f.ownerScope))
      ),
      uri.replace('openkit:page/', 'openkit:raw/'),
      'openkit:page/workspace/../domain@sha256:bad',
    ]) {
      expect(resolve(f, denied)).toEqual(unavailable(denied));
    }
  });

  it('rechecks current caller and current page sensitivity even for a retained old pin', () => {
    const f = fixture();
    const content = page(f.ownerScope);
    publish(f, f.notebook, content);
    const uri = reference(f);
    expect(resolve(f, uri).status).toBe('available');
    publish(
      f,
      f.notebook,
      updateOkfFrontmatter({ path: 'domain.md', content, updates: { sensitivity: 'confidential' } })
    );
    expect(resolve(f, uri)).toEqual(unavailable(uri));
    publish(f, f.notebook, content);
    f.coreDb.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(f.userId);
    expect(resolve(f, uri)).toEqual(unavailable(uri));
  });

  it('keeps current recursive Source audience checks on exact page reads', () => {
    const f = fixture();
    const sourceThread = f.store.createThread(
      f.workspace.id,
      'Source audience',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const destination = f.store.createThread(
      f.workspace.id,
      'Meaning consumer',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    f.access.outputThreadId = destination.id;
    const material = 'Admitted source.';
    const source = f.store.createKnowledgeSource(
      {
        id: allocateEntityId('ks'),
        workspaceId: f.workspace.id,
        kind: 'document',
        title: 'Meaning evidence',
        uri: null,
        contentDigest: digest(material),
        originatingThreadId: sourceThread.id,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      material
    );
    const content = page(f.ownerScope, [`source:${source.id}@${digest(material)}`]);
    publish(f, f.notebook, content);
    const uri = reference(f, f.ownerScope, content);
    expect(resolve(f, uri).status).toBe('available');
    Object.assign(sourceThread, {
      visibility: 'private',
      privateOwnerUserId: allocateEntityId('usr'),
    });
    expect(resolve(f, uri)).toEqual(unavailable(uri));
  });

  it('admits Server meaning separately and does not treat Workspace membership as Server authority', () => {
    const f = fixture();
    initializeScopedNotebook({
      coreDb: f.coreDb,
      actor: f.access.requestActor,
      target: { kind: 'server' },
      initialization: { requestId: randomUUID(), instructionReference: 'test:server-meaning' },
    });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'server', 'knowledge', 'notebook.git'),
    });
    const scope = { kind: 'server' } as const;
    const content = page(scope);
    const revision = publish(f, notebook, content);
    const uri = reference(f, scope, content);
    expect(resolve(f, uri)).toEqual({
      status: 'available',
      reference: uri,
      content,
      contentDigest: digest(content),
      notebookRevision: revision,
    });
    f.access.requestActor = { kind: 'session', userId: f.userId };
    expect(resolve(f, uri)).toEqual(unavailable(uri));
  });
});
