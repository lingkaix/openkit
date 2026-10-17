import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { publishNotebook } from './knowledge/notebook-publication.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './knowledge/okf.js';
import { initializeScopedNotebook } from './knowledge/scoped-notebook-owner.js';
import { registerServerKnowledgeSource } from './knowledge/server-knowledge-owner.js';
import { FsStore } from './lib/store.js';
import {
  canReadServerKnowledge,
  readAuthorizedServerNotebookPages,
} from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real current administrator, Workspace query owner and separately published Server notebook. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-knowledge-retrieval-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Server Knowledge consumer');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  initializeScopedNotebook({
    coreDb,
    actor,
    target: { kind: 'server' },
    initialization: {
      requestId: randomUUID(),
      instructionReference: 'Create shared Server Knowledge.',
    },
  });
  onTestFinished(async () => {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const access = {
    store,
    coreDb,
    actor: { kind: 'user' as const, id: userId },
    requestActor: actor,
  };
  return { dataRoot, coreDb, actor, store, workspace, access };
}

/** Valid owner-specific page; publication assigns the authoritative review state. */
function page(scope: string, sourceRefs: string[] = []) {
  return `---
type: KnowledgePage
title: Shared quasar operations
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: ${scope}
source_refs: ${JSON.stringify(sourceRefs)}
review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
---
Quasar deployment operations use the shared literal document.
`;
}

describe('Server Knowledge through the existing retrieval source', () => {
  it('retrieves Source-bound Server pages through the actual Kernel and retains exact query-owned history', async () => {
    const f = fixture();
    const source = await registerServerKnowledgeSource(
      { ...f, inflightCommands: new WeakMap() },
      {
        requestId: randomUUID(),
        kind: 'document',
        title: 'Shared source',
        content: 'Quasar deployment operations source.',
      }
    );
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'server', 'knowledge', 'notebook.git'),
    });
    const sourceRef = `source:${source.id}@${source.contentDigest}`;
    const published = await publishNotebook(
      {
        store: f.store,
        owner: { kind: 'server', coreDb: f.coreDb },
        notebook,
        producer: f.access.actor,
        inflightCommands: new WeakMap(),
        revalidate: () => ({
          scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
          reviewRequiredPageIds: [],
          registeredSources: new Map([[source.id, source.contentDigest]]),
          resolvedReferences: new Map([['shared-guide', new Set([sourceRef])]]),
        }),
      },
      {
        requestId: randomUUID(),
        baseRevision: notebook.publishedRevision(),
        summary: 'Publish shared guide',
        changes: [{ path: 'shared-guide.md', content: page('{kind: server}', [sourceRef]) }],
      }
    );
    const thread = f.store.createThread(f.workspace.id, 'Asking Thread');
    const access = { ...f.access, outputThreadId: thread.id };
    const input = {
      ...f,
      workspaceId: f.workspace.id,
      access,
      caller: 'app-api' as const,
      query: 'quasar',
      sourceScope: 'server' as const,
    };
    const selection = await retrieveWorkspaceKnowledge(input);
    expect(selection.selected).toEqual([
      expect.objectContaining({
        reference: { scopeId: 'page/server', objectId: 'shared-guide' },
        revision: published.notebookRevision,
        sourceReferences: [sourceRef],
      }),
    ]);
    expect(selection.retrievalTraceRef?.scopeId).toBe(
      `retrieval-trace/thread/${f.workspace.id}/${thread.id}`
    );
    expect(existsSync(join(f.dataRoot, 'server', 'indexes', 'retrieval'))).toBe(true);
    const read = () =>
      resolveWorkspaceKnowledgeRetrievalPages({
        ...input,
        retrievalTraceRef: selection.retrievalTraceRef!,
      });
    expect(read()?.[0]?.content).toContain('Quasar deployment operations');
    await publishNotebook(
      {
        store: f.store,
        owner: { kind: 'server', coreDb: f.coreDb },
        notebook,
        producer: f.access.actor,
        inflightCommands: new WeakMap(),
        revalidate: () => ({
          scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
          reviewRequiredPageIds: [],
          registeredSources: new Map(),
          resolvedReferences: new Map(),
        }),
      },
      {
        requestId: randomUUID(),
        baseRevision: notebook.publishedRevision(),
        summary: 'Later unrelated edit',
        changes: [{ path: 'later.md', content: page('{kind: server}') }],
      }
    );
    expect(read()?.[0]?.notebookRevision).toBe(published.notebookRevision);
    expect(
      assertKnowledgeRetrievalTraceReadable({
        ...input,
        retrievalTraceRef: selection.retrievalTraceRef!,
      }).sourceScope
    ).toBe('page/server');
    const denied = {
      ...access,
      requestActor: { kind: 'session' as const, userId: f.actor.userId },
    };
    expect(canReadServerKnowledge({ access: denied })).toBe(false);
    const nativeAccess = { ...denied, serverKnowledgeActor: f.actor };
    expect(canReadServerKnowledge({ access: nativeAccess })).toBe(true);
    expect(
      readAuthorizedServerNotebookPages({
        ...input,
        access: nativeAccess,
        pageIds: ['shared-guide'],
      }).pages[0]?.id
    ).toBe('shared-guide');
    expect(() => readAuthorizedServerNotebookPages({ ...input, access: denied })).toThrow(
      'Server Knowledge access denied.'
    );
    expect(() =>
      assertKnowledgeRetrievalTraceReadable({
        ...input,
        access: denied,
        retrievalTraceRef: selection.retrievalTraceRef!,
      })
    ).toThrow();
  });

  it('selects an ordinary generated delegated Workspace publication only with its actual publishing commit', async () => {
    const f = fixture();
    const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    applyScopedMigrations(workspaceDb);
    onTestFinished(() => workspaceDb.sqlite.close());
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'workspaces', f.workspace.id, 'knowledge', 'notebook.git'),
    });
    const producer = {
      kind: 'agent' as const,
      id: 'knowledge-manager',
      responsibleUserId: f.actor.userId,
    };
    await publishNotebook(
      {
        store: f.store,
        owner: { kind: 'workspace', workspaceDb },
        notebook,
        producer,
        actor: f.access.actor,
        publicationAuthority: {
          kind: 'delegated',
          settingReference: '{"enabled":true}',
          settingDigest: commandInputHash({ enabled: true }),
        },
        inflightCommands: new WeakMap(),
        revalidate: () => ({
          scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
          reviewRequiredPageIds: [],
          registeredSources: new Map(),
          resolvedReferences: new Map([['generated', new Set()]]),
        }),
      },
      {
        requestId: randomUUID(),
        baseRevision: notebook.publishedRevision(),
        summary: 'Generated guide',
        changes: [
          {
            path: 'generated.md',
            content: page(`{kind: workspace, workspaceId: ${f.workspace.id}}`),
          },
        ],
      }
    );
    expect(notebook.readRevision(notebook.publishedRevision()).files['generated.md']).toContain(
      'review_state: delegated'
    );
    const selection = await retrieveWorkspaceKnowledge({
      ...f,
      workspaceId: f.workspace.id,
      caller: 'app-api',
      query: 'quasar',
    });
    expect(selection.selected.map(({ reference }) => reference.objectId)).toEqual(['generated']);
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        ...f,
        workspaceId: f.workspace.id,
        caller: 'app-api',
        selection,
      })?.[0]?.knowledgePageId
    ).toBe('generated');
    // An independent human-authored commit cannot turn a page label into native delegation.
    const candidateRevision = notebook.prepare({
      baseRevision: notebook.publishedRevision(),
      changes: {
        'forged.md': page(`{kind: workspace, workspaceId: ${f.workspace.id}}`).replace(
          'review_state: user-authored',
          'review_state: delegated'
        ),
      },
      metadata: {
        summary: 'Untrusted review label',
        changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('forged') },
        producer: f.access.actor,
        authority: { kind: 'direct', instructionReference: 'test:label' },
        sourceReferences: [],
      },
    });
    notebook.publish({ baseRevision: notebook.publishedRevision(), candidateRevision });
    const later = await retrieveWorkspaceKnowledge({
      ...f,
      workspaceId: f.workspace.id,
      caller: 'app-api',
      query: 'quasar',
    });
    expect(later.selected.map(({ reference }) => reference.objectId)).toEqual(['generated']);
    expect(later.excluded).toContainEqual(
      expect.objectContaining({
        reference: { scopeId: `page/workspace/${f.workspace.id}`, objectId: 'forged' },
        reason: 'lower_conformance',
      })
    );
  });

  it('selects one admitted Server base without an unavailable placeholder or a fabricated query trace', async () => {
    const f = fixture();
    const selection = await retrieveWorkspaceKnowledge({
      ...f,
      workspaceId: f.workspace.id,
      access: f.access,
      caller: 'app-api',
      query: 'Shared deployment guide',
      sourceScope: 'server',
    });
    expect(selection).toMatchObject({ sourceScope: 'page/server', selected: [], excluded: [] });
    expect(selection).not.toHaveProperty('retrievalTraceRef');
  });
});
