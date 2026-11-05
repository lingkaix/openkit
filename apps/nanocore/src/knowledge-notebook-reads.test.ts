import { corruptTestWorkspaceNotebookCommit } from './test-support/workspace-notebook-corruption.js';
// openkit-test-platform: posix

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { FsStore } from './lib/store.js';
import {
  collectKnowledgeInventory,
  currentKnowledgeReferenceProofs,
  type KnowledgeRetrievalAccess,
  knowledgePageReadable,
  knowledgeSourceAudienceReadable,
  readAuthorizedWorkspaceNotebookPages,
} from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import {
  rebuildWorkspaceDerivedIndexes,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyMigrations } from './storage/migrate.js';
import { nativeProductScope } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { readTestWorkspaceNotebookSelection } from './test-support/workspace-notebook.js';
import {
  captureWorkspaceSourceFixture,
  readWorkspaceSourceFixture,
} from './test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
/** Applies an exact Source Thread audience through the current request, decision and configuration owners. */
async function restrictSourceThread(
  f: {
    dataRoot: string;
    coreDb: ReturnType<typeof openCoreDb>;
    store: FsStore;
    workspaceId: string;
    userId: string;
  },
  sourceThreadId: string,
  allow = false,
  deferReload = false
) {
  const manager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const app = createApp({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
    runtimeConfigManager: manager,
  });
  const decisionThread = await f.store.createThread(f.workspaceId, 'Source policy decision');
  const owner = { kind: 'workspace' as const, workspaceId: f.workspaceId };
  const scope = {
    subjects: [],
    actions: [],
    resources: [{ kind: 'container', container: { owner, kind: 'thread', id: sourceThreadId } }],
  };
  const common = {
    author: { kind: 'human', id: f.userId },
    authority: { kind: 'human', userId: f.userId },
    authoredAt: new Date().toISOString(),
    state: 'active',
    lifetime: { anchor: { owner, kind: 'workspace', id: f.workspaceId } },
  };
  const statements = [
    { ...common, id: 'source-current-audience', kind: 'managed-boundary', scope },
    ...(allow
      ? [
          {
            ...common,
            id: 'source-current-reader',
            kind: 'permission',
            effect: 'allow',
            grant: { kind: 'ordinary' },
            scope: {
              ...scope,
              subjects: [{ kind: 'human', id: f.userId }],
              actions: ['thread.read'],
            },
          },
        ]
      : []),
  ];
  const requested = await app.request(
    ...operationRequest(
      'workspace.resource-access-request',
      {
        workspaceId: f.workspaceId,
        threadId: decisionThread.id,
        change: {
          resource: { family: 'thread', id: sourceThreadId },
          replacement: { schemaVersion: 1, statements },
        },
      },
      { body: JSON.stringify({ requestId: randomUUID() }) }
    )
  );
  expect(requested.status, await requested.clone().text()).toBe(200);
  const request = (await requested.json()) as { id: string };
  await f.store.applyPendingRequestCommand(f.workspaceId, {
    action: 'grant-command',
    workspaceId: f.workspaceId,
    threadId: decisionThread.id,
    requestId: request.id,
    actor: { kind: 'user', id: f.userId },
    now: new Date().toISOString(),
    decisionContext: { kind: 'local', userId: f.userId },
  });
  // Save the approved restriction first; activate it at the existing synchronous read crossing.
  const reload = manager.reload.bind(manager);
  const delayed = deferReload
    ? vi
        .spyOn(manager, 'reload')
        .mockImplementationOnce(() => reload({ dryRun: true, mode: 'safe' }))
    : undefined;
  const applied = await app.request(
    ...operationRequest('workspace.resource-access-apply', {
      workspaceId: f.workspaceId,
      threadId: decisionThread.id,
      approvalRequestId: request.id,
      confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
    })
  );
  expect(applied.status, await applied.clone().text()).toBe(200);
  delayed?.mockRestore();
  expect((await applied.json()).reloadStatus).toBe(deferReload ? 'dry-run' : 'applied');
  return async () => {
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).toBe('applied');
  };
}

afterEach(async () => {
  await closeRetrievalServices();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real storage, current membership and Git provide independent read facts. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-reads-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Pinned notebook reads', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: LOCAL_USER_ID },
    instructionReference: 'test-owned-fresh-workspace',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const repositoryPath = join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git');
  const access: KnowledgeRetrievalAccess = {
    store,
    coreDb,
    actor: { kind: 'user', id: LOCAL_USER_ID },
    requestActor: { kind: 'session', userId: LOCAL_USER_ID },
  };
  return {
    dataRoot,
    workspaceId: workspace.id,
    access,
    coreDb,
    store,
    repositoryPath,
    get notebook() {
      return readTestWorkspaceNotebookSelection(dataRoot, workspace.id).notebook;
    },
  };
}

/** Injects exact retained OKF and deliberate corruption after real native owner admission; creates no success evidence. */
function publish(f: Awaited<ReturnType<typeof fixture>>, changes: Record<string, string | null>) {
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
  corruptTestWorkspaceNotebookCommit(f.dataRoot, f.workspaceId, candidateRevision);
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
    const f = await fixture();
    const content = serializeKnowledgePageFixture(
      {
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
      pinnedReferences: [{ scopeId: workspacePageScope(f), objectId: 'stable/pinned' }],
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

  it('fails closed on unknown source sensitivity rather than widening disclosure through a nested page', async () => {
    const f = await fixture();
    const origin = page('Unknown source restriction').replace(
      'sensitivity: internal',
      'sensitivity: future-private-rule'
    );
    publish(f, {
      'origin.md': origin,
      'selected.md': page('Derived from unknown restriction', [
        formatReferenceUri({ scopeId: workspacePageScope(f), objectId: 'origin' }),
      ]),
    });
    expect(() =>
      readAuthorizedWorkspaceNotebookPages({ ...f, pageIds: ['selected'] })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied' }));
    expect(readAuthorizedWorkspaceNotebookPages(f).pages).toEqual([]);
  });

  it('uses current selected administrator credential admission without requiring membership and denies its revocation', async () => {
    const f = await fixture();
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

  it('rechecks source audience at return when it changes during selected Source pointer verification', async () => {
    const f = await fixture();
    const sourceThread = await f.store.createThread(f.workspaceId, 'Initially shared source');
    const source = await registerSource(f, sourceThread.id);
    publish(f, {
      'selected.md': page('Denied after selection', [
        `source:${source.id}@${source.contentDigest}`,
      ]),
      'public.md': page('Public page'),
    });
    const activateRestriction = await restrictSourceThread(
      { ...f, userId: LOCAL_USER_ID },
      sourceThread.id,
      false,
      true
    );
    const list = f.store.listKnowledgeSources.bind(f.store);
    vi.spyOn(f.store, 'listKnowledgeSources').mockImplementation((workspaceId) => {
      const sources = list(workspaceId);
      activateRestriction();
      return sources;
    });
    expect(readAuthorizedWorkspaceNotebookPages(f).pages.map((entry) => entry.id)).toEqual([
      'public',
    ]);
  });

  it('rechecks source audience immediately after a direct selected Source pointer read', async () => {
    const f = await fixture();
    const thread = await f.store.createThread(f.workspaceId, 'Current Source audience');
    const source = await registerSource(f, thread.id);
    const content = page('Direct page read', [`source:${source.id}@${source.contentDigest}`]);
    const revision = publish(f, { 'selected.md': content });
    const activateRestriction = await restrictSourceThread(
      { ...f, userId: LOCAL_USER_ID },
      thread.id,
      false,
      true
    );
    const list = f.store.listKnowledgeSources.bind(f.store);
    vi.spyOn(f.store, 'listKnowledgeSources').mockImplementation((workspaceId) => {
      const sources = list(workspaceId);
      activateRestriction();
      return sources;
    });
    expect(knowledgePageReadable({ ...f, notebookRevision: revision }, 'selected', content)).toBe(
      false
    );
  });

  it('does not turn raw acceptance or imported history into missing live source authority', async () => {
    const f = await fixture();
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

  it('keeps an exact narrow read useful when an unrelated retained page object is unavailable', async () => {
    const f = await fixture();
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
    const f = await fixture();
    const source = await registerSource(f);
    const origin = page('Original nested source', [], 'ORIGINAL-IMMUTABLE-BYTES\n');
    const content = page('Selected page', [
      `source:${source.id}@${source.contentDigest}`,
      formatReferenceUri(
        { scopeId: workspacePageScope(f), objectId: 'nested/origin' },
        digest(origin)
      ),
    ]);
    const revision = publish(f, { 'selected.md': content, 'nested/origin.md': origin });
    const list = f.store.listKnowledgeSources.bind(f.store);
    let next: string | undefined;
    vi.spyOn(f.store, 'listKnowledgeSources').mockImplementation((workspaceId) => {
      if (!next)
        next = publish(f, { 'nested/origin.md': page('Later nested source', [], 'LATER-BYTES\n') });
      return list(workspaceId);
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
    const f = await fixture();
    const sourceThread = await f.store.createThread(f.workspaceId, 'Source audience');
    const source = await registerSource(f, sourceThread.id);
    const destination = await f.store.createThread(f.workspaceId, 'Shared destination');
    // The public aggregate projects exact admitted Notebook pages; authored timestamps remain in OKF bytes.
    const entryBytes = (title: string, sourceReferences: string[], content: string) =>
      serializeKnowledgePageFixture(
        {
          title,
          content,
          sourceReferences,
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
        },
        { kind: 'workspace', workspaceId: f.workspaceId }
      );
    const secret = entryBytes(
      'DENIED-TITLE-MARKER',
      [`source:${source.id}@${source.contentDigest}`],
      'DENIED-BODY-MARKER\n'
    );
    const revision = publish(f, {
      'denied-path-marker.md': secret,
      'public.md': entryBytes('Public page', [], 'Public control page.\n'),
    });
    // A later ordinary Store mutation refreshes the cached aggregate from both published pages.
    await f.store.createThread(f.workspaceId, 'Count refresh');
    expect(f.store.getWorkspace(f.workspaceId).counts.knowledgeEntryCount).toBe(2);
    expect(readAuthorizedWorkspaceNotebookPages(f).pages).toHaveLength(2);
    expect(knowledgeSourceAudienceReadable(f, source.id)).toBe(true);
    await restrictSourceThread({ ...f, userId: LOCAL_USER_ID }, sourceThread.id, true);
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
    await restrictSourceThread({ ...f, userId: LOCAL_USER_ID }, sourceThread.id);
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
    for (const operation of ['workspace.read', 'workspace.dashboard', 'workspace.list']) {
      const response = await app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(operation === 'workspace.list' ? {} : { workspaceId: f.workspaceId }),
      });
      expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(200);
      const body = (await response.json()) as {
        counts?: { knowledgeEntryCount: number };
        items?: Array<{ workspace: { id: string; counts: { knowledgeEntryCount: number } } }>;
      };
      expect(
        operation === 'workspace.list'
          ? body.items?.find(({ workspace }) => workspace.id === f.workspaceId)?.workspace.counts
              .knowledgeEntryCount
          : body.counts?.knowledgeEntryCount
      ).toBe(1);
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
    await restrictSourceThread({ ...f, userId: LOCAL_USER_ID }, sourceThread.id, true);
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
  ] as const)('rechecks current %s after a page was selected', async (condition) => {
    const f = await fixture();
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
    'turn-chain',
    'nested-digest',
  ] as const)('excludes an exact %s contradiction without a source identity leak', async (condition) => {
    const f = await fixture();
    const thread = await f.store.createThread(f.workspaceId, 'Source Thread');
    const source = await registerSource(f, thread.id);
    const origin = page('Origin');
    const refs =
      condition === 'nested-digest'
        ? [
            formatReferenceUri(
              { scopeId: workspacePageScope(f), objectId: 'origin' },
              `sha256:${'f'.repeat(64)}`
            ),
          ]
        : [
            `source:${source.id}@${condition === 'pin' ? `sha256:${'f'.repeat(64)}` : source.contentDigest}`,
          ];
    const other =
      condition === 'turn-chain' ? await f.store.createThread(f.workspaceId, 'Other Thread') : null;
    const contradictoryTurn = other
      ? await f.store.createTurn(f.workspaceId, other.id, 'Other Turn', f.access.actor)
      : null;
    publish(f, { 'selected.md': page('Denied source page', refs), 'origin.md': origin });
    if (condition === 'turn-chain') {
      const list = f.store.listKnowledgeSources.bind(f.store);
      vi.spyOn(f.store, 'listKnowledgeSources').mockImplementation((workspaceId) =>
        list(workspaceId).map((entry) =>
          entry.id === source.id ? { ...entry, originatingTurnId: contradictoryTurn!.id } : entry
        )
      );
    }
    expect(readAuthorizedWorkspaceNotebookPages(f).pages.map((entry) => entry.id)).toEqual([
      'origin',
    ]);
  });

  it('keeps exact saved page bytes when its independent captured original changes', async () => {
    const f = await fixture();
    const source = await registerSource(f);
    const content = page('Saved evidence', [`source:${source.id}@${source.contentDigest}`]);
    const revision = publish(f, { 'selected.md': content });
    writeFileSync(
      join(
        f.dataRoot,
        'workspaces',
        f.workspaceId,
        'knowledge',
        'raw',
        'sources',
        source.id,
        'original'
      ),
      'CHANGED-SOURCE-BYTES'
    );
    const original = await readWorkspaceSourceFixture({
      ...f,
      userId: LOCAL_USER_ID,
      sourceId: source.id,
    });
    expect(original.status).not.toBe('ok');
    expect(
      readAuthorizedWorkspaceNotebookPages({
        ...f,
        notebookRevision: revision,
        pageIds: ['selected'],
      }).pages
    ).toEqual([
      expect.objectContaining({ id: 'selected', content, contentDigest: digest(content) }),
    ]);
  });

  it('denies unpublished candidates and mismatched roots, and ignores physical page substitutions', async () => {
    const f = await fixture();
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

  it('fails explicitly for missing selected Git objects without a physical-page fallback', async () => {
    const f = await fixture();
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

  it('enumerates published Git pages with one commit revision and separate exact digests', async () => {
    const f = await fixture();
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
  f: Awaited<ReturnType<typeof fixture>>,
  originatingThreadId: string | null = null
) {
  const content = 'Exact independent source material.\n';
  const now = new Date().toISOString();
  return captureWorkspaceSourceFixture({
    dataRoot: f.dataRoot,
    store: f.store,
    coreDb: f.coreDb,
    userId: LOCAL_USER_ID,
    source: {
      id: allocateEntityId('ks'),
      workspaceId: f.workspaceId,
      kind: 'document',
      title: 'Source',
      uri: null,
      contentDigest: digest(content),
      originatingThreadId,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    content,
  });
}

/** Adds a real currently active member without granting the private Source Thread audience. */
function addMember(f: Awaited<ReturnType<typeof fixture>>): string {
  const id = allocateEntityId('usr');
  const now = new Date().toISOString();
  f.coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Fixture member', ?, false, ?, ?, 'human', 'active')"
    )
    .run(id, id, Date.now(), Date.now());
  f.coreDb.sqlite
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)"
    )
    .run(f.workspaceId, id, now, now, now);
  return id;
}

/** Current membership revocation retains the required tombstone and lifecycle timestamps. */
function removeMember(f: Awaited<ReturnType<typeof fixture>>, userId: string): void {
  const now = new Date().toISOString();
  f.coreDb.sqlite
    .prepare(
      "UPDATE workspace_members SET status = 'removed', removed_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
    )
    .run(now, now, f.workspaceId, userId);
}

/** Reads the base retained by the actual Workspace creator. */
function workspacePageScope(f: Awaited<ReturnType<typeof fixture>>): string {
  return `page/workspace/${f.workspaceId}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'workspace', workspaceId: f.workspaceId } })}`;
}

// Schema #598: Source metadata and current disclosure keep their original separate owners.
describe('borrowed FsStore Source selection and current admission', () => {
  it('uses the borrowed Notebook selection without retaining a Source disclosure grant', async () => {
    const f = await fixture();
    const sourceThread = await f.store.createThread(f.workspaceId, 'Bound Source origin');
    const first = await registerSource(f, sourceThread.id);
    const owner = { kind: 'workspace' as const, workspaceId: f.workspaceId };
    const scope = nativeProductScope(f.dataRoot, owner);
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      db.sqlite.exec('BEGIN');
      const bound = new FsStore({
        dataRoot: f.dataRoot,
        nativeProductScope: { ...scope, sqlite: db.sqlite },
      });
      expect(bound.listKnowledgeSources(f.workspaceId).map(({ id }) => id)).toEqual([first.id]);
      const second = await registerSource(f);
      expect(
        f.store
          .listKnowledgeSources(f.workspaceId)
          .map(({ id }) => id)
          .sort()
      ).toEqual([first.id, second.id].sort());
      expect(bound.getKnowledgeSource(f.workspaceId, first.id)).toEqual(first);
      expect(bound.listKnowledgeSources(f.workspaceId).map(({ id }) => id)).toEqual([first.id]);
      expect(db.sqlite.inTransaction).toBe(true);
      db.sqlite.exec('ROLLBACK');
      expect(
        bound
          .listKnowledgeSources(f.workspaceId)
          .map(({ id }) => id)
          .sort()
      ).toEqual([first.id, second.id].sort());
      const current = { ...f, store: bound, access: { ...f.access, store: bound } };
      expect(knowledgeSourceAudienceReadable(current, first.id)).toBe(true);
      // The real request/decision/configuration owners revoke this exact origin's current audience.
      await restrictSourceThread({ ...f, userId: LOCAL_USER_ID }, sourceThread.id);
      expect(knowledgeSourceAudienceReadable(current, first.id)).toBe(false);
      expect(db.sqlite.open).toBe(true);
    } finally {
      if (db.sqlite.inTransaction) db.sqlite.exec('ROLLBACK');
      db.sqlite.close();
    }
  }, 30_000);
});

// Schema #598: the public retrieval seam must borrow an explicitly supplied Workspace cut.
describe('borrowed Workspace retrieval selection', () => {
  it('keeps the public Notebook and Source proof read on its held SQL selection until rollback', async () => {
    const f = await fixture();
    const firstSource = await registerSource(f);
    const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    const firstContent = serializeKnowledgePageFixture(
      {
        title: 'Held source page',
        content: 'Exact before-publication bytes.',
        sourceReferences: [`source:${firstSource.id}@${firstSource.contentDigest}`],
        createdAt: '2026-11-03T00:00:00.000Z',
        updatedAt: '2026-11-03T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: f.workspaceId }
    );
    const firstResponse = await app.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: f.workspaceId,
          baseRevision: f.notebook.publishedRevision(),
          path: 'before.md',
          content: firstContent,
          summary: 'Publish the real initial retrieval page.',
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const firstRevision = f.notebook.publishedRevision();
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    const originalConnection = db.sqlite;
    const originalPath = originalConnection.name;
    const scope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId: f.workspaceId });
    const options: ConstructorParameters<typeof FsStore>[0] = {
      dataRoot: f.dataRoot,
      nativeProductScope: { ...scope, sqlite: originalConnection },
    };
    const bound = new FsStore(options);
    // This narrow optional extension lets the baseline compile before the public access type
    // acquires its accepted borrowed handle. It neither fabricates nor changes an Actor.
    const access: Parameters<typeof readAuthorizedWorkspaceNotebookPages>[0]['access'] & {
      readonly workspaceDb?: ReturnType<typeof openWorkspaceDb>;
    } = { ...f.access, store: bound, workspaceDb: db };
    try {
      originalConnection.exec('BEGIN');
      const before = readAuthorizedWorkspaceNotebookPages({ ...f, access });
      expect(before.notebookRevision).toBe(firstRevision);
      expect(before.pages).toEqual([
        {
          id: 'before',
          path: 'before.md',
          content: firstContent,
          contentDigest: digest(firstContent),
        },
      ]);
      expect(before.referenceProofs.get('before')).toEqual({
        knowledgePageId: 'before',
        contentDigest: digest(firstContent),
        sourceReferences: [`source:${firstSource.id}@${firstSource.contentDigest}`],
        resolvedReferences: new Set([`source:${firstSource.id}@${firstSource.contentDigest}`]),
      });
      expect(bound.listKnowledgeSources(f.workspaceId).map(({ id }) => id)).toEqual([
        firstSource.id,
      ]);
      const secondSource = await registerSource(f);
      const secondContent = serializeKnowledgePageFixture(
        {
          title: 'Later source page',
          content: 'Exact peer-publication bytes.',
          sourceReferences: [`source:${secondSource.id}@${secondSource.contentDigest}`],
          createdAt: '2026-11-03T00:00:00.000Z',
          updatedAt: '2026-11-03T00:00:00.000Z',
        },
        { kind: 'workspace', workspaceId: f.workspaceId }
      );
      const secondResponse = await app.request(
        ...operationRequest(
          'knowledge.notebook.create',
          {
            workspaceId: f.workspaceId,
            baseRevision: f.notebook.publishedRevision(),
            path: 'after.md',
            content: secondContent,
            summary: 'Publish through the real peer owner.',
          },
          { body: JSON.stringify({ requestId: randomUUID() }) }
        )
      );
      expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
      const later = readAuthorizedWorkspaceNotebookPages(f);
      expect(later.notebookRevision).not.toBe(firstRevision);
      expect(later.pages.map(({ id }) => id)).toEqual(['after', 'before']);
      expect(later.referenceProofs.get('after')).toEqual({
        knowledgePageId: 'after',
        contentDigest: digest(secondContent),
        sourceReferences: [`source:${secondSource.id}@${secondSource.contentDigest}`],
        resolvedReferences: new Set([`source:${secondSource.id}@${secondSource.contentDigest}`]),
      });
      expect(
        f.store
          .listKnowledgeSources(f.workspaceId)
          .map(({ id }) => id)
          .sort()
      ).toEqual([firstSource.id, secondSource.id].sort());
      // Current implementation opens another Workspace reader here and follows the peer head.
      // The deciding expected RED is the changed notebookRevision, not setup or lock failure.
      const held = readAuthorizedWorkspaceNotebookPages({ ...f, access });
      expect(held.notebookRevision).toBe(firstRevision);
      expect(held.pages).toEqual(before.pages);
      expect(held.referenceProofs).toEqual(before.referenceProofs);
      expect(bound.listKnowledgeSources(f.workspaceId).map(({ id }) => id)).toEqual([
        firstSource.id,
      ]);
      expect(db.sqlite).toBe(originalConnection);
      expect(originalConnection.name).toBe(originalPath);
      expect(originalConnection.open).toBe(true);
      expect(originalConnection.inTransaction).toBe(true);
      originalConnection.exec('ROLLBACK');
      const refreshed = readAuthorizedWorkspaceNotebookPages({ ...f, access });
      expect(refreshed.notebookRevision).toBe(later.notebookRevision);
      expect(refreshed.pages).toEqual(later.pages);
      expect(refreshed.referenceProofs).toEqual(later.referenceProofs);
      expect(
        bound
          .listKnowledgeSources(f.workspaceId)
          .map(({ id }) => id)
          .sort()
      ).toEqual([firstSource.id, secondSource.id].sort());
      expect(db.sqlite).toBe(originalConnection);
      expect(originalConnection.open).toBe(true);
      expect(originalConnection.inTransaction).toBe(false);
    } finally {
      if (originalConnection.inTransaction) originalConnection.exec('ROLLBACK');
      originalConnection.close();
    }
  }, 30_000);

  it('refuses a mismatched borrowed Workspace owner or physical path before content and retains both callers', async () => {
    const f = await fixture();
    const source = await registerSource(f);
    const content = serializeKnowledgePageFixture(
      {
        title: 'Correct physical owner page',
        content: 'These valid bytes must not admit a wrong reader.',
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
        createdAt: '2026-11-03T00:00:00.000Z',
        updatedAt: '2026-11-03T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: f.workspaceId }
    );
    const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    const response = await app.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: f.workspaceId,
          baseRevision: f.notebook.publishedRevision(),
          path: 'owned.md',
          content,
          summary: 'Publish through the actual Notebook owner.',
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(readAuthorizedWorkspaceNotebookPages(f).pages).toEqual([
      { id: 'owned', path: 'owned.md', content, contentDigest: digest(content) },
    ]);
    const peer = await f.store.createWorkspace('Different physical retrieval owner');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: peer.id,
      ownerUserId: LOCAL_USER_ID,
    });
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    const peerDb = openWorkspaceDb(f.dataRoot, peer.id);
    const originalConnection = db.sqlite;
    const peerConnection = peerDb.sqlite;
    const originalPath = originalConnection.name;
    const peerPath = peerConnection.name;
    const scope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId: f.workspaceId });
    const options: ConstructorParameters<typeof FsStore>[0] = {
      dataRoot: f.dataRoot,
      nativeProductScope: { ...scope, sqlite: originalConnection },
    };
    const bound = new FsStore(options);
    try {
      originalConnection.exec('BEGIN');
      peerConnection.exec('BEGIN');
      expect(bound.listKnowledgeSources(f.workspaceId).map(({ id }) => id)).toEqual([source.id]);
      const validAccess: Parameters<typeof currentKnowledgeReferenceProofs>[0]['access'] = {
        ...f.access,
        store: bound,
        workspaceDb: db,
      };
      expect(
        currentKnowledgeReferenceProofs({
          workspaceId: f.workspaceId,
          access: validAccess,
          pageIds: ['owned'],
        })
      ).toEqual(readAuthorizedWorkspaceNotebookPages(f).referenceProofs);
      const readRevision = vi.spyOn(KnowledgeNotebook.prototype, 'readRevision');
      const readContent = vi.spyOn(KnowledgeNotebook.prototype, 'readContent');
      // Both are deliberate invalid input descriptors over genuine admitted connections.
      // The second keeps the claimed owner while substituting a foreign physical database.
      const mismatches: Array<ReturnType<typeof openWorkspaceDb>> = [
        peerDb,
        { ...db, sqlite: peerConnection },
        // A direct proof read must reject contradictory root metadata even when the
        // actual connection has the correct retained Workspace and Knowledge Base.
        { ...db, dataRoot: join(f.dataRoot, 'contradictory-root') },
      ];
      for (const workspaceDb of mismatches) {
        const access: Parameters<typeof readAuthorizedWorkspaceNotebookPages>[0]['access'] & {
          readonly workspaceDb?: ReturnType<typeof openWorkspaceDb>;
        } = { ...f.access, store: bound, workspaceDb };
        // Baseline ignores this supplied handle and returns the real page instead of refusing.
        expect(() =>
          readAuthorizedWorkspaceNotebookPages({ ...f, access, pageIds: ['owned'] })
        ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
        // R1: this exported direct API must enforce the same physical owner before
        // loading proof bytes; pinNotebook's validation cannot protect this crossing.
        expect(() =>
          currentKnowledgeReferenceProofs({
            workspaceId: f.workspaceId,
            access,
            pageIds: ['owned'],
          })
        ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
        expect(readRevision).not.toHaveBeenCalled();
        expect(readContent).not.toHaveBeenCalled();
        expect(db.sqlite).toBe(originalConnection);
        expect(peerDb.sqlite).toBe(peerConnection);
        expect(originalConnection.name).toBe(originalPath);
        expect(peerConnection.name).toBe(peerPath);
        expect(originalConnection.open).toBe(true);
        expect(peerConnection.open).toBe(true);
        expect(originalConnection.inTransaction).toBe(true);
        expect(peerConnection.inTransaction).toBe(true);
      }
      readRevision.mockRestore();
      readContent.mockRestore();
      expect(readAuthorizedWorkspaceNotebookPages({ ...f, access: f.access }).pages).toEqual([
        { id: 'owned', path: 'owned.md', content, contentDigest: digest(content) },
      ]);
    } finally {
      if (originalConnection.inTransaction) originalConnection.exec('ROLLBACK');
      if (peerConnection.inTransaction) peerConnection.exec('ROLLBACK');
      originalConnection.close();
      peerConnection.close();
    }
  }, 30_000);
});
