// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { createKnowledgeOperationImplementations } from './knowledge-operations.js';
import { FsStore } from './lib/store.js';
import {
  collectKnowledgeInventory,
  type KnowledgeRetrievalAccess,
  knowledgePageReadable,
  knowledgeSourceAudienceReadable,
  readAuthorizedWorkspaceNotebookPages,
} from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import {
  rebuildWorkspaceDerivedIndexes,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real storage, current membership and Git provide independent read facts. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-reads-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Pinned notebook reads', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: LOCAL_USER_ID },
    instructionReference: 'test-owned-fresh-workspace',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const repositoryPath = join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const access: KnowledgeRetrievalAccess = {
    store,
    coreDb,
    actor: { kind: 'user', id: LOCAL_USER_ID },
    requestActor: { kind: 'session', userId: LOCAL_USER_ID },
  };
  return { dataRoot, workspaceId: workspace.id, access, coreDb, store, repositoryPath, notebook };
}

/** Publish test-owned content through the actual content owner, without claiming native admission. */
function publish(f: ReturnType<typeof fixture>, changes: Record<string, string | null>) {
  const baseRevision = f.notebook.publishedRevision();
  const candidateRevision = f.notebook.prepare({
    baseRevision,
    changes,
    metadata: {
      summary: 'Read regression content',
      producer: { kind: 'user', id: LOCAL_USER_ID },
      authority: { kind: 'direct', instructionReference: 'test-owned-content-fixture' },
      changeRequest: { requestId: randomUUID(), inputDigest: digest(JSON.stringify(changes)) },
      sourceReferences: [],
    },
  });
  f.notebook.publish({ baseRevision, candidateRevision });
  return candidateRevision;
}

/** OKF byte identity is intentionally separate from the notebook commit. */
function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** A generic OKF page needs no fabricated Review or accepted Proposal. */
function page(title: string, refs: readonly string[] = [], body = 'Exact retained page bytes.\n') {
  return `---\ntype: note\ntitle: ${JSON.stringify(title)}\nsource_refs: ${JSON.stringify(refs)}\nsensitivity: internal\n---\n${body}`;
}

describe('published Workspace notebook reads', () => {
  it('rebuilds indexes from one Git revision and resolves an admitted selection after later publication', async () => {
    const f = fixture();
    const content = serializeUserAuthoredKnowledgePage(
      {
        id: 'stable/pinned',
        kind: 'project-context',
        title: 'Pinned source knowledge',
        content: 'Original notebook retrieval bytes.',
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
        sourceReferences: [],
      },
      { kind: 'workspace', workspaceId: f.workspaceId }
    );
    const revision = publish(f, { 'stable/pinned.md': content });
    const physical = join(f.dataRoot, 'workspaces', f.workspaceId, 'knowledge', 'pages', 'stable');
    mkdirSync(physical, { recursive: true });
    writeFileSync(join(physical, 'pinned.md'), page('PHYSICAL-SUBSTITUTION'));
    const rebuilt = rebuildWorkspaceDerivedIndexes(f);
    expect(rebuilt.itemCount).toBe(1);
    const index = JSON.parse(readFileSync(join(f.dataRoot, rebuilt.indexPath), 'utf8'));
    expect(index.notebookRevision).toBe(revision);
    expect(index.records).toEqual([
      expect.objectContaining({
        conceptId: 'stable/pinned',
        contentDigest: digest(content),
        indexed: true,
      }),
    ]);
    const selection = await retrieveWorkspaceKnowledge({
      ...f,
      caller: 'app-api',
      query: 'Original notebook retrieval bytes',
      limit: 5,
      pinnedReferences: [{ scopeId: `page/workspace/${f.workspaceId}`, objectId: 'stable/pinned' }],
    });
    expect(selection.notebookRevision).toBe(revision);
    expect(selection.selected[0]).toMatchObject({ revision, contentDigest: digest(content) });
    publish(f, {
      'stable/pinned.md': content.replace(
        'Original notebook retrieval bytes.',
        'Later publication bytes.'
      ),
    });
    const resolved = resolveWorkspaceKnowledgeRetrievalPages({
      ...f,
      caller: 'app-api',
      selection,
    });
    expect(resolved).toEqual([
      expect.objectContaining({
        notebookRevision: revision,
        knowledgePageId: 'stable/pinned',
        contentDigest: digest(content),
        content,
      }),
    ]);
  });

  it('fails closed on unknown source sensitivity rather than widening disclosure through a nested page', () => {
    const f = fixture();
    const origin = page('Unknown source restriction').replace(
      'sensitivity: internal',
      'sensitivity: future-private-rule'
    );
    publish(f, {
      'origin.md': origin,
      'selected.md': page('Derived from unknown restriction', ['knowledge:origin']),
    });
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({ ...f, pageIds: ['selected'] })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied' }));
    expect(readAuthorizedWorkspaceNotebookPages(f).pages).toEqual([]);
  });

  it('uses current selected administrator credential admission without requiring membership and denies its revocation', () => {
    const f = fixture();
    publish(f, { 'page.md': page('Administrator inspection') });
    const administratorId = addMember(f);
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: administratorId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    removeMember(f, administratorId);
    const access: KnowledgeRetrievalAccess = {
      ...f.access,
      actor: { kind: 'user', id: administratorId },
      requestActor: {
        kind: 'session',
        userId: administratorId,
        adminTokenId: issued.record.tokenId,
      },
    };
    expect(
      readAuthorizedWorkspaceNotebookPages({ ...f, access }).pages.map((entry) => entry.id)
    ).toEqual(['page']);
    revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
    expect(() => readAuthorizedWorkspaceNotebookPages({ ...f, access })).toThrowError(
      expect.objectContaining({ code: 'workspace_access_denied' })
    );
  });

  it('rechecks source audience at return when it changes during selected source material verification', async () => {
    const f = fixture();
    const sourceThread = f.store.createThread(
      f.workspaceId,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
    const source = await registerSource(f, sourceThread.id);
    publish(f, {
      'selected.md': page('Denied after selection', [
        `source:${source.id}@${source.contentDigest}`,
      ]),
      'public.md': page('Public page'),
    });
    const read = f.store.readKnowledgeSourceMaterial.bind(f.store);
    vi.spyOn(f.store, 'readKnowledgeSourceMaterial').mockImplementation((workspaceId, sourceId) => {
      const bytes = read(workspaceId, sourceId);
      Object.assign(sourceThread, { privateOwnerUserId: randomUUID() });
      return bytes;
    });
    expect(readAuthorizedWorkspaceNotebookPages(f).pages.map((entry) => entry.id)).toEqual([
      'public',
    ]);
  });

  it('rechecks source audience immediately after a direct selected material read', async () => {
    const f = fixture();
    const thread = f.store.createThread(
      f.workspaceId,
      'Current private audience',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: LOCAL_USER_ID,
      }
    );
    const source = await registerSource(f, thread.id);
    const content = page('Direct page read', [`source:${source.id}@${source.contentDigest}`]);
    const revision = publish(f, { 'selected.md': content });
    const read = f.store.readKnowledgeSourceMaterial.bind(f.store);
    vi.spyOn(f.store, 'readKnowledgeSourceMaterial').mockImplementation((workspaceId, sourceId) => {
      const bytes = read(workspaceId, sourceId);
      Object.assign(thread, { privateOwnerUserId: randomUUID() });
      return bytes;
    });
    expect(knowledgePageReadable({ ...f, notebookRevision: revision }, 'selected', content)).toBe(
      false
    );
  });

  it('does not turn raw acceptance or imported history into missing live source authority', () => {
    const f = fixture();
    const refs = [
      `turn:${randomUUID()}`,
      `item:${randomUUID()}`,
      `context-package:${randomUUID()}@ctxpkg_sha256_${'a'.repeat(64)}`,
    ];
    publish(f, {
      'forged.md': page('Not a live Review', refs).replace(
        'sensitivity: internal',
        'sensitivity: internal\nreview_state: accepted'
      ),
    });
    Object.assign(f.store.getWorkspace(f.workspaceId), {
      importedFrom: {
        sourceDeploymentId: randomUUID(),
        sourceWorkspaceId: f.workspaceId,
        exportCreatedAt: '2026-10-17T00:00:00.000Z',
        manifestDigest: digest('history'),
      },
    });
    const result = readAuthorizedWorkspaceNotebookPages(f);
    expect(result.pages).toEqual([]);
    expect([...result.referenceProofs]).toEqual([]);
  });

  it('keeps an exact narrow read useful when an unrelated retained page object is unavailable', () => {
    const f = fixture();
    const content = page('Selected exact page');
    const revision = publish(f, {
      'selected.md': content,
      'unrelated.md': page('Unselected', [], 'UNRELATED-BYTES'),
    });
    const object = f.notebook.inspectRevision(revision).entries['unrelated.md']!;
    rmSync(join(f.repositoryPath, 'objects', object.slice(0, 2), object.slice(2)));
    expect(
      readAuthorizedWorkspaceNotebookPages({
        ...f,
        notebookRevision: revision,
        pageIds: ['selected'],
      }).pages[0]?.content
    ).toBe(content);
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({ ...f, notebookRevision: revision })
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });

  it('keeps enumeration and recursive source reads pinned when publication advances during admission', async () => {
    const f = fixture();
    const source = await registerSource(f);
    const origin = page('Original nested source', [], 'ORIGINAL-IMMUTABLE-BYTES\n');
    const content = page('Selected page', [
      `source:${source.id}@${source.contentDigest}`,
      `knowledge:nested/origin@${digest(origin)}`,
    ]);
    const revision = publish(f, { 'selected.md': content, 'nested/origin.md': origin });
    const read = f.store.readKnowledgeSourceMaterial.bind(f.store);
    let next: string | undefined;
    vi.spyOn(f.store, 'readKnowledgeSourceMaterial').mockImplementation((workspaceId, sourceId) => {
      if (!next)
        next = publish(f, { 'nested/origin.md': page('Later nested source', [], 'LATER-BYTES\n') });
      return read(workspaceId, sourceId);
    });
    const result = readAuthorizedWorkspaceNotebookPages(f);
    expect(next).toBeTruthy();
    expect(f.notebook.publishedRevision()).toBe(next);
    expect(result.notebookRevision).toBe(revision);
    expect(result.pages.find((entry) => entry.id === 'selected')?.content).toBe(content);
    expect(result.pages.find((entry) => entry.id === 'nested/origin')?.content).toBe(origin);
    expect(result.pages.every((entry) => entry.contentDigest === digest(entry.content))).toBe(true);
    expect(
      readAuthorizedWorkspaceNotebookPages({
        ...f,
        notebookRevision: revision,
        pageIds: ['selected'],
      }).pages[0]?.content
    ).toBe(content);
  });

  it('filters foreign private source identity and denies exact historical reads after source revocation', async () => {
    const f = fixture();
    const sourceThread = f.store.createThread(
      f.workspaceId,
      'Source audience',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
    const source = await registerSource(f, sourceThread.id);
    const destination = f.store.createThread(f.workspaceId, 'Shared destination');
    // The public aggregate projects admitted Knowledge entries, including their required timestamps.
    const entryBytes = (id: string, title: string, sourceReferences: string[], content: string) =>
      serializeUserAuthoredKnowledgePage(
        {
          id,
          kind: 'project-context',
          title,
          content,
          sourceReferences,
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
        },
        { kind: 'workspace', workspaceId: f.workspaceId }
      );
    const secret = entryBytes(
      'denied-path-marker',
      'DENIED-TITLE-MARKER',
      [`source:${source.id}@${source.contentDigest}`],
      'DENIED-BODY-MARKER\n'
    );
    const revision = publish(f, {
      'denied-path-marker.md': secret,
      'public.md': entryBytes('public', 'Public page', [], 'Public control page.\n'),
    });
    expect(readAuthorizedWorkspaceNotebookPages(f).pages).toHaveLength(2);
    expect(knowledgeSourceAudienceReadable(f, source.id)).toBe(true);
    const memberId = addMember(f);
    const foreignAccess: KnowledgeRetrievalAccess = {
      ...f.access,
      actor: { kind: 'user', id: memberId },
      requestActor: { kind: 'session', userId: memberId },
    };
    expect(
      readAuthorizedWorkspaceNotebookPages({ ...f, access: foreignAccess }).pages.map(
        (entry) => entry.id
      )
    ).toEqual(['public']);
    expect(knowledgeSourceAudienceReadable({ ...f, access: foreignAccess }, source.id)).toBe(false);
    Object.assign(sourceThread, { privateOwnerUserId: randomUUID() });
    expect(knowledgeSourceAudienceReadable(f, source.id)).toBe(false);
    expect(knowledgeSourceAudienceReadable(f, randomUUID())).toBe(false);
    const app = createApp({
      store: f.store,
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      mode: 'server',
      auth: {
        api: { getSession: async () => ({ user: { id: LOCAL_USER_ID } }) },
        handler: async () => new Response(null, { status: 404 }),
      },
    });
    for (const operation of ['workspace.read', 'workspace.dashboard']) {
      const response = await app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: f.workspaceId }),
      });
      expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(200);
      const body = (await response.json()) as { counts: { knowledgeEntryCount: number } };
      expect(body.counts.knowledgeEntryCount).toBe(1);
    }

    const result = readAuthorizedWorkspaceNotebookPages({ ...f, notebookRevision: revision });
    expect(result.pages.map((entry) => entry.id)).toEqual(['public']);
    const serialized = JSON.stringify({
      pages: result.pages,
      proofKeys: [...result.referenceProofs.keys()],
    });
    for (const value of [
      'DENIED-TITLE-MARKER',
      'DENIED-BODY-MARKER',
      'denied-path-marker',
      digest(secret),
      source.id,
      source.contentDigest,
    ])
      expect(serialized).not.toContain(value);
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({
        ...f,
        notebookRevision: revision,
        pageIds: ['denied-path-marker'],
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_access_denied',
        message: 'Knowledge page is unavailable.',
      })
    );
    Object.assign(sourceThread, { privateOwnerUserId: LOCAL_USER_ID });
    expect(
      readAuthorizedWorkspaceNotebookPages({
        ...f,
        access: { ...f.access, outputThreadId: destination.id },
      }).pages.map((entry) => entry.id)
    ).toEqual(['public']);
  });

  it.each([
    'membership',
    'credential',
    'disabled-user',
  ] as const)('rechecks current %s after a page was selected', (condition) => {
    const f = fixture();
    const memberId = addMember(f);
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: memberId,
      scope: 'workspace',
      workspaceIds: [f.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const access: KnowledgeRetrievalAccess = {
      ...f.access,
      actor: { kind: 'user', id: memberId },
      requestActor: {
        kind: 'token',
        userId: memberId,
        tokenId: issued.record.tokenId,
        tokenScope: 'workspace',
        tokenWorkspaceIds: issued.record.workspaceIds,
      },
    };
    publish(f, { 'selected.md': page('Selected') });
    const selected = readAuthorizedWorkspaceNotebookPages({ ...f, access });
    if (condition === 'membership') removeMember(f, memberId);
    else if (condition === 'credential')
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
    else f.coreDb.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(memberId);
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({
        ...f,
        access,
        notebookRevision: selected.notebookRevision,
        pageIds: ['selected'],
      })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied' }));
  });

  it.each([
    'pin',
    'captured-bytes',
    'turn-chain',
    'nested-digest',
  ] as const)('excludes an exact %s contradiction without a source identity leak', async (condition) => {
    const f = fixture();
    const thread = f.store.createThread(f.workspaceId, 'Source Thread');
    const source = await registerSource(f, thread.id);
    const origin = page('Origin');
    const refs =
      condition === 'nested-digest'
        ? [`knowledge:origin@sha256:${'f'.repeat(64)}`]
        : [
            `source:${source.id}@${condition === 'pin' ? `sha256:${'f'.repeat(64)}` : source.contentDigest}`,
          ];
    const other =
      condition === 'turn-chain' ? f.store.createThread(f.workspaceId, 'Other Thread') : null;
    const contradictoryTurn = other
      ? f.store.createTurn(f.workspaceId, other.id, 'Other Turn', f.access.actor)
      : null;
    publish(f, { 'selected.md': page('Denied source page', refs), 'origin.md': origin });
    if (condition === 'captured-bytes')
      writeFileSync(
        join(
          f.dataRoot,
          'workspaces',
          f.workspaceId,
          'sources',
          'materials',
          source.id,
          'content.txt'
        ),
        'CHANGED-SOURCE-BYTES'
      );
    if (condition === 'turn-chain') {
      Object.assign(source, { originatingTurnId: contradictoryTurn!.id });
    }
    expect(readAuthorizedWorkspaceNotebookPages(f).pages.map((entry) => entry.id)).toEqual([
      'origin',
    ]);
  });

  it('denies unpublished candidates and mismatched roots, and ignores physical page substitutions', () => {
    const f = fixture();
    const content = page('Published bytes');
    const revision = publish(f, { 'page.md': content });
    const candidate = f.notebook.prepare({
      baseRevision: revision,
      changes: { 'page.md': page('Unpublished bytes') },
      metadata: f.notebook.inspectRevision(revision).metadata,
    });
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({ ...f, notebookRevision: candidate, pageIds: ['page'] })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({ ...f, dataRoot: join(f.dataRoot, 'foreign') })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied' }));
    const physical = join(f.dataRoot, 'workspaces', f.workspaceId, 'knowledge', 'pages');
    mkdirSync(physical, { recursive: true });
    writeFileSync(join(physical, 'page.md'), page('PHYSICAL-SUBSTITUTION'));
    writeFileSync(join(physical, 'ghost.md'), page('PHYSICAL-GHOST'));
    const selected = readAuthorizedWorkspaceNotebookPages({
      ...f,
      notebookRevision: revision,
      pageIds: ['page'],
    });
    expect(selected.pages[0]?.content).toBe(content);
    expect(readAuthorizedWorkspaceNotebookPages(f).pages.map((entry) => entry.id)).toEqual([
      'page',
    ]);
  });

  it('fails explicitly for missing selected Git objects without a physical-page fallback', () => {
    const f = fixture();
    const content = page('Missing selected object');
    const revision = publish(f, { 'page.md': content });
    const object = f.notebook.inspectRevision(revision).entries['page.md']!;
    rmSync(join(f.repositoryPath, 'objects', object.slice(0, 2), object.slice(2)));
    const physical = join(f.dataRoot, 'workspaces', f.workspaceId, 'knowledge', 'pages');
    mkdirSync(physical, { recursive: true });
    writeFileSync(join(physical, 'page.md'), content);
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({ ...f, notebookRevision: revision, pageIds: ['page'] })
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });

  it('enumerates published Git pages with one commit revision and separate exact digests', () => {
    const f = fixture();
    const content = page('Git inventory marker');
    const revision = publish(f, { 'nested/page.md': content });
    const inventory = collectKnowledgeInventory(f);
    expect(inventory.notebookRevision).toBe(revision);
    expect(inventory.referenceProofs.get('nested/page')).toMatchObject({
      contentDigest: digest(content),
      knowledgePageId: 'nested/page',
      sourceReferences: [],
    });
    expect(f.store.listKnowledgeProposals(f.workspaceId)).toEqual([]);
    expect(inventory.view.documents).toEqual([
      expect.objectContaining({
        key: { namespace: 'knowledge', id: 'nested/page' },
        revision,
        digest: digest(content).slice(7),
        locator: 'knowledge/pages/nested/page.md',
        content: { kind: 'inline-text', text: content },
      }),
    ]);
  });
});

/** Captured source fixtures use the native Source id owner and real captured-byte storage. */
async function registerSource(
  f: ReturnType<typeof fixture>,
  originatingThreadId: string | null = null
) {
  const operations = createKnowledgeOperationImplementations({
    store: f.store,
    coreDb: f.coreDb,
    inflightCommands: new WeakMap(),
  });
  const result = await operations['knowledge.source.register'](
    {
      workspaceId: f.workspaceId,
      requestId: randomUUID(),
      kind: 'document',
      title: 'Source',
      content: 'Exact independent source material.\n',
      ...(originatingThreadId ? { originatingThreadId } : {}),
    },
    {
      kind: 'public',
      actor: f.access.requestActor!,
      actorRef: f.access.actor,
      scope: { kind: 'workspace', workspaceId: f.workspaceId },
    }
  );
  return f.store.getKnowledgeSource(f.workspaceId, result.source.id);
}

/** Adds a real currently active member without granting the private Source Thread audience. */
function addMember(f: ReturnType<typeof fixture>): string {
  const id = allocateEntityId('usr');
  const now = new Date().toISOString();
  f.coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Fixture member', ?, false, ?, ?, 'human', 'active')"
    )
    .run(id, id, Date.now(), Date.now());
  f.coreDb.sqlite
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, ?, 'active', 'viewer', NULL, ?, NULL, 1, ?, ?)"
    )
    .run(f.workspaceId, id, now, now, now);
  return id;
}

/** Current membership revocation retains the required tombstone and lifecycle timestamps. */
function removeMember(f: ReturnType<typeof fixture>, userId: string): void {
  const now = new Date().toISOString();
  f.coreDb.sqlite
    .prepare(
      "UPDATE workspace_members SET status = 'removed', removed_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
    )
    .run(now, now, f.workspaceId, userId);
}
