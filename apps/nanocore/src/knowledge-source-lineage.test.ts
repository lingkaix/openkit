import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Uses real disk, current authorization and operation dispatch without an HTTP replacement. */
function sourceFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-source-lineage-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: LOCAL_USER_ID,
  });
  const app = createApp({ coreDb, dataRoot, store });
  const client = createCoreClient({
    baseUrl: 'http://test.invalid',
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  return {
    coreDb,
    dataRoot,
    store,
    client,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Keeps explicit registered-source selection distinct from coincidentally equal entry bytes. */
describe('direct Knowledge saved-source lineage', () => {
  it('withholds published page identities and content after a registered Source becomes private', async () => {
    const f = sourceFixture();
    try {
      const origin = f.store.createThread(DEMO_WORKSPACE_ID, 'Initially shared source audience');
      const { source } = await f.client.operations['knowledge.source.register']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Source audience can become narrower',
        content: 'The protected meeting starts at eight.',
        originatingThreadId: origin.id,
      });
      const created = await f.client.operations['knowledge.create']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await f.client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).notebookRevision,
        knowledgePageId: 'protected-meeting-marker',
        kind: 'project-context',
        title: 'PROTECTED-TITLE-MARKER',
        content: 'PROTECTED-BODY-MARKER',
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
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
        fetch: (input, init) => app.fetch(new Request(input, init)),
      });
      const before = await client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID });
      expect(before.items.map((entry) => entry.id)).toContain(created.id);
      // Change the real current audience; immutable notebook bytes and their revision stay intact.
      Object.assign(origin, {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000002',
      });
      const after = await client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID });
      expect(after.notebookRevision).toBe(before.notebookRevision);
      for (const denied of [
        created.id,
        created.title,
        created.content,
        source.id,
        source.contentDigest,
      ])
        expect(JSON.stringify(after.items)).not.toContain(denied);
    } finally {
      f.close();
    }
  });

  it('filters private Source identities and refuses private metadata for a current ordinary readonly member', async () => {
    const f = sourceFixture();
    try {
      const privateThread = f.store.createThread(
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
        fetch: (input, init) => app.fetch(new Request(input, init)),
      });
      const listed = await client.operations['knowledge.source.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(listed.items.map((source) => source.id)).toContain(sharedSource.id);
      expect.soft(listed.items.map((source) => source.id)).not.toContain(privateSource.id);
      const derivedReads = vi.spyOn(f.store, 'listKnowledgeSourceDerivedRepresentations');
      try {
        await expect(
          client.operations['knowledge.source.read']({
            workspaceId: DEMO_WORKSPACE_ID,
            sourceId: privateSource.id,
          })
        ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
        expect(derivedReads).not.toHaveBeenCalled();
      } finally {
        derivedReads.mockRestore();
      }
    } finally {
      f.close();
    }
  });

  it('withholds Source data when its derived metadata read revokes the presented credential', async () => {
    const f = sourceFixture();
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
        fetch: (input, init) => app.fetch(new Request(input, init)),
      });
      const read = f.store.listKnowledgeSourceDerivedRepresentations.bind(f.store);
      const derivedReads = vi
        .spyOn(f.store, 'listKnowledgeSourceDerivedRepresentations')
        .mockImplementation((workspaceId, sourceId) => {
          const representations = read(workspaceId, sourceId);
          revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
          return representations;
        });
      try {
        await expect(
          client.operations['knowledge.source.read']({
            workspaceId: DEMO_WORKSPACE_ID,
            sourceId: source.id,
          })
        ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
        expect(derivedReads).toHaveBeenCalledTimes(1);
      } finally {
        derivedReads.mockRestore();
      }
    } finally {
      f.close();
    }
  });

  it('requires current originating Thread audience for new registration and exact registration replay', async () => {
    const f = sourceFixture();
    try {
      const thread = f.store.createThread(
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
        fetch: (input, init) => app.fetch(new Request(input, init)),
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
      f.close();
    }
  });

  it('keeps private Sources out of shared Knowledge while permitting their owner-only personal Workspace', async () => {
    const f = sourceFixture();
    try {
      const thread = f.store.createThread(
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
      const fields = {
        kind: 'project-context' as const,
        title: 'Private interpretation',
        content: 'Private interpretation.',
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
      };
      const before = await f.client.operations['knowledge.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      await expect(
        f.client.operations['knowledge.create']({
          ...fields,
          workspaceId: DEMO_WORKSPACE_ID,
          requestId: crypto.randomUUID(),
          baseRevision: before.notebookRevision,
          knowledgePageId: 'private-interpretation',
        })
      ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
      expect(
        await f.client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
      ).toEqual(before);
      const personal = f.store.ensureQuickChatWorkspace(LOCAL_USER_ID);
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        workspaceId: personal.id,
        ownerUserId: LOCAL_USER_ID,
      });
      const personalThread = f.store.createThread(personal.id, 'Personal capture');
      const { source: personalSource } = await f.client.operations['knowledge.source.register']({
        workspaceId: personal.id,
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Personal source',
        content: 'Private interpretation.',
        originatingThreadId: personalThread.id,
      });
      const personalCommand = {
        ...fields,
        workspaceId: personal.id,
        requestId: crypto.randomUUID(),
        baseRevision: (await f.client.operations['knowledge.list']({ workspaceId: personal.id }))
          .notebookRevision,
        knowledgePageId: 'private-interpretation',
        sourceReferences: [`source:${personalSource.id}@${personalSource.contentDigest}`],
      };
      const entry = await f.client.operations['knowledge.create'](personalCommand);
      expect(await f.client.operations['knowledge.create'](personalCommand)).toEqual(entry);
      const update = {
        workspaceId: personal.id,
        knowledgeEntryId: entry.id,
        requestId: crypto.randomUUID(),
        baseRevision: (await f.client.operations['knowledge.list']({ workspaceId: personal.id }))
          .notebookRevision,
        title: 'Updated private interpretation',
      };
      const updated = await f.client.operations['knowledge.update'](update);
      expect(await f.client.operations['knowledge.update'](update)).toEqual(updated);
      expect(updated.sourceReferences).toEqual(personalCommand.sourceReferences);
    } finally {
      f.close();
    }
  });

  it('retains the selected exact Source relationship through public indexes and restart', async () => {
    const f = sourceFixture();
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
      const command = {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).notebookRevision,
        knowledgePageId: 'reading-room-hours',
        kind: 'project-context' as const,
        title: 'Reading room hours',
        content: 'The reading room opens at eight.',
        sourceReferences: [reference],
      };
      const entry = await client.operations['knowledge.create'](command);
      expect(await client.operations['knowledge.create'](command)).toEqual(entry);
      const indexes = await client.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(indexes.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: entry.id, reference, resolved: true })
      );
      const reopened = new FsStore({ dataRoot });
      const reopenedApp = createApp({ coreDb, dataRoot, store: reopened });
      const reopenedClient = createCoreClient({
        baseUrl: 'http://test.invalid',
        fetch: (input, init) => reopenedApp.fetch(new Request(input, init)),
      });
      const retained = await reopenedClient.operations['knowledge.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(retained.items.find((item) => item.id === entry.id)?.sourceReferences).toEqual([
        reference,
      ]);
      const rebuilt = await reopenedClient.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(rebuilt.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: entry.id, reference, resolved: true })
      );
      expect(await reopenedClient.operations['knowledge.create'](command)).toEqual(entry);
      expect(
        (
          await reopenedClient.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).items.filter((item) => item.id === entry.id)
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it.each([
    'missing',
    'stale-digest',
    'foreign',
    'changed-bytes',
    'missing-bytes',
  ] as const)('refuses %s Source evidence before publishing an entry', async (condition) => {
    const f = sourceFixture();
    try {
      const targetWorkspaceId =
        condition === 'foreign'
          ? f.store.createWorkspace('Foreign source owner').id
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
      const materialPath = join(
        f.dataRoot,
        'workspaces',
        targetWorkspaceId,
        'sources',
        'materials',
        source.id,
        'content.txt'
      );
      if (condition === 'changed-bytes') writeFileSync(materialPath, 'Changed captured bytes.');
      if (condition === 'missing-bytes') rmSync(materialPath);
      const before = await f.client.operations['knowledge.list']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      const requestId = crypto.randomUUID();
      const scope = { workspaceId: DEMO_WORKSPACE_ID, actorId: LOCAL_USER_ID };
      expect(f.store.getCommandRequest('knowledge.create', requestId, scope)).toBeNull();
      const refusal = await f.client.operations['knowledge.create']({
        workspaceId: DEMO_WORKSPACE_ID,
        requestId,
        baseRevision: before.notebookRevision,
        knowledgePageId: 'must-not-publish',
        kind: 'project-context',
        title: 'Must not publish',
        content: 'The reading room opens at eight.',
        sourceReferences: [reference],
      }).catch((error: unknown) => error);
      // Missing/corrupt immutable captured bytes require recovery; invalid selection remains a request error.
      expect(refusal).toMatchObject(
        condition === 'changed-bytes' || condition === 'missing-bytes'
          ? { status: 409, code: 'recovery_required' }
          : { status: 400, code: 'invalid_request' }
      );
      expect(JSON.stringify(refusal)).not.toContain('The reading room opens at eight.');
      expect(JSON.stringify(refusal)).not.toContain('Changed captured bytes.');
      expect(f.store.getCommandRequest('knowledge.create', requestId, scope)).toBeNull();
      expect(
        await f.client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
      ).toEqual(before);
      const indexes = await f.client.operations['knowledge.indexes']({
        workspaceId: DEMO_WORKSPACE_ID,
      });
      expect(indexes.sourceReferences.references.some((row) => row.reference === reference)).toBe(
        false
      );
    } finally {
      f.close();
    }
  });

  it('rechecks the current actor before an exact successful command can be replayed', async () => {
    const f = sourceFixture();
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
      const command = {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: crypto.randomUUID(),
        baseRevision: (
          await client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).notebookRevision,
        knowledgePageId: 'authorized-source-link',
        kind: 'project-context' as const,
        title: 'Authorized source link',
        content: 'The room opens at eight.',
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
      };
      const entry = await client.operations['knowledge.create'](command);
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);

      await expect(client.operations['knowledge.create'](command)).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        client.operations['knowledge.source.list']({ workspaceId: DEMO_WORKSPACE_ID })
      ).rejects.toMatchObject({ status: 401 });
      expect(
        (
          await f.client.operations['knowledge.list']({ workspaceId: DEMO_WORKSPACE_ID })
        ).items.filter((item) => item.id === entry.id)
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});
