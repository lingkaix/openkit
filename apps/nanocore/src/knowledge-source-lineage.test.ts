import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import * as capabilityUsage from './capability/usage-ledger.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import {
  parseOkfDocument,
  stringListFrontmatterField,
  updateOkfFrontmatter,
} from './knowledge/okf.js';
import { FsStore } from './lib/store.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp, createLoopbackAppFetch } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { knowledgePageFixture } from './test-support/knowledge-page.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { readWorkspaceSourceFixture } from './test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const timestamp = '2026-10-19T00:00:00.000Z';

/** Uses real disk, current authorization and operation dispatch without an HTTP replacement. */
async function sourceFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-source-lineage-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: LOCAL_USER_ID,
  });
  const app = createApp({ coreDb, dataRoot, store });
  const client = createCoreClient({
    baseUrl: 'http://test.invalid',
    fetch: createLoopbackAppFetch(app),
  });
  return {
    coreDb,
    dataRoot,
    store,
    client,
    close: async () => {
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Restricts the exact retained Source Thread through the real request, grant and apply owners. */
async function restrictSourceThread(
  f: { dataRoot: string; coreDb: ReturnType<typeof openCoreDb>; store: FsStore },
  threadId: string
) {
  const manager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const app = createApp({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
    runtimeConfigManager: manager,
  });
  const client = createCoreClient({
    baseUrl: 'http://test.invalid',
    fetch: createLoopbackAppFetch(app),
  });
  const decision = await f.store.createThread(DEMO_WORKSPACE_ID, 'Source policy decision');
  const owner = { kind: 'workspace' as const, workspaceId: DEMO_WORKSPACE_ID };
  const requested = await client.operations['workspace.resource-access-request']({
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: decision.id,
    requestId: crypto.randomUUID(),
    change: {
      resource: { family: 'thread', id: threadId },
      replacement: {
        schemaVersion: 1,
        statements: [
          {
            id: 'source-current-audience',
            kind: 'managed-boundary',
            author: { kind: 'human', id: LOCAL_USER_ID },
            authority: { kind: 'human', userId: LOCAL_USER_ID },
            authoredAt: new Date().toISOString(),
            state: 'active',
            lifetime: { anchor: { owner, kind: 'workspace', id: DEMO_WORKSPACE_ID } },
            scope: {
              subjects: [],
              actions: [],
              resources: [
                { kind: 'container', container: { owner, kind: 'thread', id: threadId } },
              ],
            },
          },
        ],
      },
    },
  });
  await f.store.applyPendingRequestCommand(DEMO_WORKSPACE_ID, {
    action: 'grant-command',
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: decision.id,
    requestId: requested.id,
    actor: { kind: 'user', id: LOCAL_USER_ID },
    now: new Date().toISOString(),
    decisionContext: { kind: 'local', userId: LOCAL_USER_ID },
  });
  const applied = await client.operations['workspace.resource-access-apply']({
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: decision.id,
    approvalRequestId: requested.id,
    confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
  });
  if (applied.reloadStatus !== 'applied') throw new Error('Source restriction was not applied.');
}

/** Keeps explicit registered-source selection distinct from coincidentally equal page bytes. */
describe('direct Knowledge saved-source lineage', () => {
  it('withholds published page identities and content after a registered Source becomes private', async () => {
    const f = await sourceFixture();
    try {
      const origin = await f.store.createThread(
        DEMO_WORKSPACE_ID,
        'Initially shared source audience'
      );
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Source audience can become narrower',
        content: 'The protected meeting starts at eight.',
        originatingThreadId: origin.id,
      });
      const page = knowledgePageFixture(
        {
          id: 'protected-meeting-marker',
          title: 'PROTECTED-TITLE-MARKER',
          content: 'PROTECTED-BODY-MARKER',
          sourceReferences: [`source:${source.id}@${source.contentDigest}`],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      );
      const created = await f.client.operations['knowledge.notebook.create']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await f.client.operations['knowledge.notebook.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).notebookRevision,
        path: page.path,
        content: page.content,
        summary: 'Publish the page before its Source audience changes.',
      });
      expect(created.changedPageIds).toContain(page.id);
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: LOCAL_USER_ID,
        scope: 'workspace-readonly',
        workspaceIds: [DEMO_WORKSPACE_ID],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const app = createApp({
        mode: 'server',
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
      });
      const client = createCoreClient({
        baseUrl: 'http://127.0.0.1',
        headers: { authorization: `Bearer ${issued.secret}` },
        fetch: createLoopbackAppFetch(app),
      });
      const before = await client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(before.pages.map((entry) => entry.id)).toContain(page.id);
      // Current policy narrows the Source audience without changing retained Notebook bytes.
      await restrictSourceThread(f, origin.id);
      const after = await client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(after.notebookRevision).toBe(before.notebookRevision);
      for (const denied of [
        page.id,
        'PROTECTED-TITLE-MARKER',
        'PROTECTED-BODY-MARKER',
        source.id,
        source.contentDigest,
      ])
        expect(JSON.stringify(after.pages)).not.toContain(denied);
    } finally {
      await f.close();
    }
  });

  it('filters private Source identities and refuses private metadata for a current ordinary readonly member', async () => {
    const f = await sourceFixture();
    try {
      const privateThread = await f.store.createThread(
        DEMO_WORKSPACE_ID,
        'Private source title',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: allocateEntityId('usr'),
        }
      );
      const { source: privateSource } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Private source identity',
        content: 'Private source material.',
        originatingThreadId: privateThread.id,
      });
      const { source: sharedSource } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Shared source',
        content: 'Shared material.',
      });
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: LOCAL_USER_ID,
        scope: 'workspace-readonly',
        workspaceIds: [DEMO_WORKSPACE_ID],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const app = createApp({
        mode: 'server',
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
      });
      const client = createCoreClient({
        baseUrl: 'http://127.0.0.1',
        headers: { authorization: `Bearer ${issued.secret}` },
        fetch: createLoopbackAppFetch(app),
      });
      const listed = await client.operations['knowledge.source.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(listed.items.map((source) => source.id)).toContain(sharedSource.id);
      expect.soft(listed.items.map((source) => source.id)).not.toContain(privateSource.id);
      const usageCalls = vi.spyOn(capabilityUsage, 'startCapabilityCall');
      try {
        await expect(
          client.operations['knowledge.source.read']({
            workspaceId: DEMO_WORKSPACE_ID,
            sourceId: privateSource.id,
          })
        ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
        expect(usageCalls).not.toHaveBeenCalled();
      } finally {
        usageCalls.mockRestore();
      }
    } finally {
      await f.close();
    }
  });

  it('withholds Source data when its native usage write revokes the presented credential', async () => {
    const f = await sourceFixture();
    try {
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Readable source',
        content: 'Must be withheld after revocation.',
      });
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: LOCAL_USER_ID,
        scope: 'workspace-readonly',
        workspaceIds: [DEMO_WORKSPACE_ID],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const app = createApp({
        mode: 'server',
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
      });
      const client = createCoreClient({
        baseUrl: 'http://127.0.0.1',
        headers: { authorization: `Bearer ${issued.secret}` },
        fetch: createLoopbackAppFetch(app),
      });
      const start = capabilityUsage.startCapabilityCall;
      const usageCalls = vi
        .spyOn(capabilityUsage, 'startCapabilityCall')
        .mockImplementation((input) => {
          const call = start(input);
          revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
          return call;
        });
      try {
        await expect(
          client.operations['knowledge.source.read']({
            workspaceId: DEMO_WORKSPACE_ID,
            sourceId: source.id,
          })
        ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
        expect(usageCalls).toHaveBeenCalledTimes(1);
      } finally {
        usageCalls.mockRestore();
      }
    } finally {
      await f.close();
    }
  });

  it('requires current originating Thread audience for new registration and exact registration replay', async () => {
    const f = await sourceFixture();
    try {
      const thread = await f.store.createThread(
        DEMO_WORKSPACE_ID,
        'Private capture',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: allocateEntityId('usr'),
        }
      );
      const command = {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document' as const,
        title: 'Private capture',
        content: 'Privately owned capture.',
        originatingThreadId: thread.id,
      };
      const registered = await f.client.operations['knowledge.source.register'](command);
      expect(await f.client.operations['knowledge.source.register'](command)).toEqual(registered);
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: LOCAL_USER_ID,
        scope: 'workspace',
        workspaceIds: [DEMO_WORKSPACE_ID],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const app = createApp({
        mode: 'server',
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
      });
      const client = createCoreClient({
        baseUrl: 'http://127.0.0.1',
        headers: { authorization: `Bearer ${issued.secret}` },
        fetch: createLoopbackAppFetch(app),
      });
      await expect(client.operations['knowledge.source.register'](command)).rejects.toMatchObject({
        status: 403,
        code: 'workspace_access_denied',
      });
      await expect(
        client.operations['knowledge.source.register']({
          ...command,
          requestId: crypto.randomUUID(),
        })
      ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
      expect(f.store.listKnowledgeSources(DEMO_WORKSPACE_ID)).toEqual([registered.source]);
    } finally {
      await f.close();
    }
  });

  it('keeps private Sources out of shared Knowledge while permitting their owner-only personal Workspace', async () => {
    const f = await sourceFixture();
    try {
      const thread = await f.store.createThread(
        DEMO_WORKSPACE_ID,
        'Own private capture',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: LOCAL_USER_ID,
        }
      );
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Own private source',
        content: 'Private interpretation.',
        originatingThreadId: thread.id,
      });
      const page = knowledgePageFixture(
        {
          id: 'private-interpretation',
          title: 'Private interpretation',
          content: 'Private interpretation.',
          sourceReferences: [`source:${source.id}@${source.contentDigest}`],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      );
      const before = await f.client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      await expect(
        f.client.operations['knowledge.notebook.create']({
          path: page.path,
          content: page.content,
          summary: 'Refuse a private Source in shared Knowledge.',
          workspaceId: DEMO_WORKSPACE_ID,
          requestId: crypto.randomUUID(),
          baseRevision: before.notebookRevision,
        })
      ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
      expect(
        await f.client.operations['knowledge.notebook.list']({ workspaceId: DEMO_WORKSPACE_ID })
      ).toEqual(before);
      const personal = await f.store.ensureQuickChatWorkspace(LOCAL_USER_ID);
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        workspaceId: personal.id,
        ownerUserId: LOCAL_USER_ID,
      });
      const personalThread = await f.store.createThread(personal.id, 'Personal capture');
      const { source: personalSource } = await f.client.operations['knowledge.source.register']({
        workspaceId: personal.id,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Personal source',
        content: 'Private interpretation.',
        originatingThreadId: personalThread.id,
      });
      const personalPage = knowledgePageFixture(
        {
          id: 'private-interpretation',
          title: 'Private interpretation',
          content: 'Private interpretation.',
          sourceReferences: [`source:${personalSource.id}@${personalSource.contentDigest}`],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: personal.id }
      );
      const personalCommand = {
        workspaceId: personal.id,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await f.client.operations['knowledge.notebook.list']({ workspaceId: personal.id })
        ).notebookRevision,
        path: personalPage.path,
        content: personalPage.content,
        summary: 'Publish owner-only personal Knowledge.',
      };
      const created = await f.client.operations['knowledge.notebook.create'](personalCommand);
      expect(await f.client.operations['knowledge.notebook.create'](personalCommand)).toEqual(
        created
      );
      const current = await f.client.operations['knowledge.notebook.list']({
        workspaceId: personal.id,
      });
      const currentPage = current.pages.find((page) => page.path === personalPage.path)!;
      const update = {
        workspaceId: personal.id,
        requestId: crypto.randomUUID(),
        baseRevision: current.notebookRevision,
        changes: [
          {
            path: currentPage.path,
            content: updateOkfFrontmatter({
              path: currentPage.path,
              content: currentPage.content,
              updates: { title: 'Updated private interpretation' },
            }),
          },
        ],
        summary: 'Edit the personal title while preserving exact Source references.',
      };
      const updated = await f.client.operations['knowledge.notebook.update'](update);
      expect(await f.client.operations['knowledge.notebook.update'](update)).toEqual(updated);
      const after = await f.client.operations['knowledge.notebook.list']({
        workspaceId: personal.id,
      });
      const updatedPage = after.pages.find((page) => page.path === personalPage.path)!;
      expect(
        stringListFrontmatterField(parseOkfDocument(updatedPage).document!, 'source_refs')
      ).toEqual([`source:${personalSource.id}@${personalSource.contentDigest}`]);
    } finally {
      await f.close();
    }
  });

  it('retains the selected exact Source relationship through public indexes and restart', async () => {
    const f = await sourceFixture();
    const { client, coreDb, dataRoot } = f;
    try {
      const { source } = await client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Reading room source',
        content: 'The reading room opens at eight.',
      });
      expect(source.contentDigest).toBeTruthy();
      const reference = `source:${source.id}@${source.contentDigest}`;
      const page = knowledgePageFixture(
        {
          id: 'reading-room-hours',
          title: 'Reading room hours',
          content: 'The reading room opens at eight.',
          sourceReferences: [reference],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      );
      const command = {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await client.operations['knowledge.notebook.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).notebookRevision,
        path: page.path,
        content: page.content,
        summary: 'Publish source-traceable Knowledge through the Notebook.',
      };
      const publication = await client.operations['knowledge.notebook.create'](command);
      expect(await client.operations['knowledge.notebook.create'](command)).toEqual(publication);
      const indexes = await client.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(indexes.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: page.id, reference, resolved: true })
      );
      const reopened = new FsStore({ dataRoot });
      const reopenedApp = createApp({ coreDb, dataRoot, store: reopened });
      const reopenedClient = createCoreClient({
        baseUrl: 'http://test.invalid',
        fetch: createLoopbackAppFetch(reopenedApp),
      });
      const retained = await reopenedClient.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      const retainedPage = retained.pages.find((item) => item.id === page.id)!;
      expect(
        stringListFrontmatterField(parseOkfDocument(retainedPage).document!, 'source_refs')
      ).toEqual([reference]);
      const rebuilt = await reopenedClient.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(rebuilt.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: page.id, reference, resolved: true })
      );
      expect(await reopenedClient.operations['knowledge.notebook.create'](command)).toEqual(
        publication
      );
      expect(
        (
          await reopenedClient.operations['knowledge.notebook.list']({
            workspaceId: DEMO_WORKSPACE_ID,
          })
        ).pages.filter((item) => item.id === page.id)
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it.each([
    'missing',
    'stale-digest',
    'foreign',
  ] as const)('refuses %s Source evidence before publishing a page', async (condition) => {
    const f = await sourceFixture();
    try {
      const targetWorkspaceId =
        condition === 'foreign'
          ? (await f.store.createWorkspace('Foreign source owner')).id
          : DEMO_WORKSPACE_ID;
      if (targetWorkspaceId !== DEMO_WORKSPACE_ID)
        recordWorkspaceOwnerMembership({
          coreDb: f.coreDb,
          workspaceId: targetWorkspaceId,
          ownerUserId: LOCAL_USER_ID,
        });
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: targetWorkspaceId,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Exact source',
        content: 'The reading room opens at eight.',
      });
      const reference =
        condition === 'missing'
          ? `source:${allocateEntityId('ks')}@${source.contentDigest}`
          : `source:${source.id}@${condition === 'stale-digest' ? `sha256:${'a'.repeat(64)}` : source.contentDigest}`;
      const before = await f.client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      const requestId = crypto.randomUUID();
      const scope = { workspaceId: DEMO_WORKSPACE_ID, actorId: LOCAL_USER_ID };
      expect(f.store.getCommandRequest('knowledge.notebook.create', requestId, scope)).toBeNull();
      const page = knowledgePageFixture(
        {
          id: 'must-not-publish',
          title: 'Must not publish',
          content: 'The reading room opens at eight.',
          sourceReferences: [reference],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      );
      const refusal = await f.client.operations['knowledge.notebook.create']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId,
        baseRevision: before.notebookRevision,
        path: page.path,
        content: page.content,
        summary: 'Refuse invalid Source evidence before publication.',
      }).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 400, code: 'invalid_request' });
      expect(JSON.stringify(refusal)).not.toContain('The reading room opens at eight.');
      expect(JSON.stringify(refusal)).not.toContain('Changed captured bytes.');
      expect(f.store.getCommandRequest('knowledge.notebook.create', requestId, scope)).toBeNull();
      expect(
        await f.client.operations['knowledge.notebook.list']({ workspaceId: DEMO_WORKSPACE_ID })
      ).toEqual(before);
      const indexes = await f.client.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(indexes.sourceReferences.references.some((row) => row.reference === reference)).toBe(
        false
      );
    } finally {
      await f.close();
    }
  });

  it.each([
    'changed',
    'missing',
  ] as const)('keeps an exact Source-backed saved page when original bytes are %s', async (condition) => {
    const f = await sourceFixture();
    try {
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Independent original',
        content: 'Retained original bytes.',
      });
      const reference = `source:${source.id}@${source.contentDigest}`;
      const current = await f.client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      const page = knowledgePageFixture(
        {
          id: 'independent-saved-page',
          title: 'Independent saved page',
          content: 'Saved bytes remain exact.',
          sourceReferences: [reference],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      );
      const command = {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: current.notebookRevision,
        path: page.path,
        content: page.content,
        summary: 'Save the exact Source-backed page.',
      };
      const entry = await f.client.operations['knowledge.notebook.create'](command);
      const before = await f.client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      const saved = before.pages.find((item) => item.id === page.id)!;
      expect(saved.content).toBe(page.content);
      const path = join(
        f.dataRoot,
        'workspaces',
        DEMO_WORKSPACE_ID,
        'knowledge',
        'raw',
        'sources',
        source.id,
        'original'
      );
      if (condition === 'changed') writeFileSync(path, 'Changed captured bytes.');
      else rmSync(path);
      expect(
        (
          await readWorkspaceSourceFixture({
            ...f,
            userId: LOCAL_USER_ID,
            workspaceId: DEMO_WORKSPACE_ID,
            sourceId: source.id,
          })
        ).status
      ).not.toBe('ok');
      expect(await f.client.operations['knowledge.notebook.create'](command)).toEqual(entry);
      const retained = await f.client.operations['knowledge.notebook.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(retained.pages.find((item) => item.id === page.id)).toEqual(saved);
      const indexes = await f.client.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(indexes.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: page.id, reference, resolved: true })
      );
    } finally {
      await f.close();
    }
  });

  it('rechecks the current actor before an exact successful command can be replayed', async () => {
    const f = await sourceFixture();
    try {
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Reading room',
        content: 'The room opens at eight.',
      });
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: LOCAL_USER_ID,
        scope: 'workspace',
        workspaceIds: [DEMO_WORKSPACE_ID],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const server = createApp({
        mode: 'server',
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
      });
      const client = createCoreClient({
        baseUrl: 'http://127.0.0.1',
        headers: { authorization: `Bearer ${issued.secret}` },
        fetch: (input, init) => server.fetch(new Request(input, init)),
      });
      const page = knowledgePageFixture(
        {
          id: 'authorized-source-link',
          title: 'Authorized source link',
          content: 'The room opens at eight.',
          sourceReferences: [`source:${source.id}@${source.contentDigest}`],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      );
      const command = {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await client.operations['knowledge.notebook.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).notebookRevision,
        path: page.path,
        content: page.content,
        summary: 'Publish source-traceable Knowledge through the Notebook.',
      };
      const publication = await client.operations['knowledge.notebook.create'](command);
      expect(publication.changedPageIds).toEqual([page.id]);
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);

      await expect(client.operations['knowledge.notebook.create'](command)).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        client.operations['knowledge.source.list']({ workspaceId: DEMO_WORKSPACE_ID })
      ).rejects.toMatchObject({ status: 401 });
      expect(
        (
          await f.client.operations['knowledge.notebook.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).pages.filter((item) => item.id === page.id)
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
