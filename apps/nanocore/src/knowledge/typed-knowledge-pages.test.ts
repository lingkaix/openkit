import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { retrieveWorkspaceKnowledge } from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readRetrievalTrace } from '../storage/retrieval-traces.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { KnowledgeNotebook } from './notebook.js';
import { publishWorkspaceNotebook } from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, updateOkfFrontmatter } from './okf.js';

const NOW = '2026-10-19T00:00:00.000Z';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';

/** Exact governed bytes; service attribution stays with the existing publisher. */
function page(
  id: string,
  type: string,
  ownerId = workspaceId,
  fields: Record<string, unknown> = {}
) {
  return updateOkfFrontmatter({
    path: `${id}.md`,
    content: serializeUserAuthoredKnowledgePage(
      {
        id,
        kind: 'project-context',
        title: id,
        content: 'domain-selector evidence.',
        sourceReferences: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      { kind: 'workspace', workspaceId: ownerId }
    ),
    updates: {
      type,
      applies_to: ['tool:invoice.check', 'step:invoice-review'],
      ...(type === 'Effect' ? { basis: 'Observed invoice outcomes.', last_checked_at: NOW } : {}),
      annotation: { keep: ['exact', 'extension'] },
      ...fields,
    },
  });
}

/** Exercises the same final-tree validator used by publication, including authored schemas. */
function validate(content: string, schema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT) {
  return validateNotebookCandidate({
    ownerScope: { kind: 'workspace', workspaceId },
    base: { files: {} },
    candidate: { files: { 'domain.md': content } },
    scopeSchemaText: schema,
    registeredSources: new Map(),
    resolvedReferences: new Map(),
  });
}

describe('governed domain page fields', () => {
  it.each([
    'Rule',
    'Effect',
    'Objective',
  ])('admits the official %s type with required fields', (type) => {
    expect(validate(page('domain', type)).errors).toEqual([]);
  });
  it.each([
    'Rule',
    'Effect',
    'Objective',
  ])('refuses missing or malformed %s applicability under an authored schema', (type) => {
    const schema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
      /allowed_types: .*/,
      `allowed_types: [${type}]`
    );
    for (const applies_to of [undefined, [], [''], [1], 'tool:invoice.check']) {
      expect(validate(page('domain', type, workspaceId, { applies_to }), schema).errors).toEqual([
        { pageId: 'domain', code: 'notebook.invalid_page' },
      ]);
    }
  });
  it('refuses an Effect without descriptive basis or an actual offset last-check timestamp', () => {
    const schema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
      /allowed_types: .*/,
      'allowed_types: [Effect]'
    );
    for (const fields of [
      { basis: undefined },
      { basis: '' },
      { last_checked_at: undefined },
      { last_checked_at: '2026-10-19' },
    ]) {
      expect(validate(page('domain', 'Effect', workspaceId, fields), schema).errors).toEqual([
        { pageId: 'domain', code: 'notebook.invalid_page' },
      ]);
    }
  });
});

/** Real Core, native fixed-base publisher, retained KB and Retrieval Kernel; no selector double. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'domain-page-selection-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Typed domain pages');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const root = join(dataRoot, 'workspaces', workspace.id);
  const repositoryPath = join(root, 'knowledge', 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const access = { store, coreDb, actor, requestActor };
  const dependencies = {
    store,
    workspaceDb,
    notebook,
    producer: actor,
    inflightCommands: new WeakMap(),
    admission: (request: Parameters<typeof readWorkspaceNotebookAdmission>[0]['request']) =>
      readWorkspaceNotebookAdmission({
        store,
        coreDb,
        workspaceDb,
        notebook,
        request,
        requestActor,
        actor,
        runtimeConfigManager: { current: () => snapshot },
        workspaceMutationAdmission,
      }),
  };
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    store,
    workspace,
    root,
    repositoryPath,
    notebook,
    access,
    publish: (changes: { path: string; content: string }[]) => {
      const request = {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        baseRevision: notebook.publishedRevision(),
        summary: 'Publish domain meaning',
        changes,
      };
      return publishWorkspaceNotebook(
        { ...dependencies, revalidate: () => dependencies.admission(request) },
        request
      );
    },
    retrieve: (filters: Record<string, unknown> = {}) =>
      retrieveWorkspaceKnowledge({
        dataRoot,
        workspaceId: workspace.id,
        access,
        caller: 'app-api',
        query: 'domain-selector',
        ...filters,
      }),
  };
}

it('publishes exact typed metadata, reads it after restart and rejects a missing required field before publication', async () => {
  const f = fixture();
  const changes = ['Rule', 'Effect', 'Objective'].map((type) => ({
    path: `${type.toLowerCase()}.md`,
    content: page(type.toLowerCase(), type, f.workspace.id),
  }));
  const published = await f.publish(changes);
  const restarted = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
  for (const { path, content } of changes)
    expect(restarted.readRevision(published.notebookRevision).files[path]).toBe(content);
  const invalid = page('rule', 'Rule', f.workspace.id, { applies_to: undefined });
  await expect(f.publish([{ path: 'rule.md', content: invalid }])).rejects.toMatchObject({
    code: 'invalid_request',
  });
  expect(restarted.publishedRevision()).toBe(published.notebookRevision);
});

it('intersects exact type and any-match applicability after ordinary governance, including pins and absent-filter identity', async () => {
  const f = fixture();
  await f.publish([
    { path: 'invoice-rule.md', content: page('invoice-rule', 'Rule', f.workspace.id) },
    {
      path: 'shipping-rule.md',
      content: page('shipping-rule', 'Rule', f.workspace.id, {
        applies_to: ['tool:shipping.check'],
      }),
    },
    { path: 'invoice-effect.md', content: page('invoice-effect', 'Effect', f.workspace.id) },
    { path: 'descriptive.md', content: page('descriptive', 'KnowledgePage', f.workspace.id) },
    {
      path: 'stale-rule.md',
      content: page('stale-rule', 'Rule', f.workspace.id, { freshness: 'stale' }),
    },
    {
      path: 'private-rule.md',
      content: page('private-rule', 'Rule', f.workspace.id, { sensitivity: 'confidential' }),
    },
  ]);
  const ids = (result: Awaited<ReturnType<typeof f.retrieve>>) =>
    result.selected.map((entry) => entry.reference.objectId).sort();
  const before = await f.retrieve();
  expect(ids(before)).toEqual(['descriptive', 'invoice-effect', 'invoice-rule', 'shipping-rule']);
  expect(before.retrievalParameters).not.toHaveProperty('types');
  expect(before.retrievalParameters).not.toHaveProperty('appliesTo');
  const typeOnly = await f.retrieve({ types: ['Rule'] });
  expect(ids(typeOnly)).toEqual(['invoice-rule', 'shipping-rule']);
  const applicable = await f.retrieve({ appliesTo: ['tool:unknown', 'step:invoice-review'] });
  expect(ids(applicable)).toEqual(['invoice-effect', 'invoice-rule']);
  const scopeId = `page/workspace/${f.workspace.id}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'workspace', workspaceId: f.workspace.id } })}`;
  const filters = {
    types: ['Objective', 'Rule'],
    appliesTo: ['tool:invoice.check'],
    pinnedReferences: [{ scopeId, objectId: 'shipping-rule' }],
  };
  const filtered = await f.retrieve(filters);
  expect(ids(filtered)).toEqual(['invoice-rule']);
  expect(filtered.retrievalParameters).toMatchObject({
    types: ['Objective', 'Rule'],
    appliesTo: ['tool:invoice.check'],
  });
  expect(ids(await f.retrieve({ appliesTo: ['tool:invoice'] }))).toEqual([]);
  expect((await f.retrieve()).requestDigest).toBe(before.requestDigest);
});

it('forwards typed filters through the native operation and records supplied filters in the existing trace', async () => {
  const f = fixture();
  await f.publish([
    { path: 'invoice-rule.md', content: page('invoice-rule', 'Rule', f.workspace.id) },
    { path: 'invoice-effect.md', content: page('invoice-effect', 'Effect', f.workspace.id) },
  ]);
  const thread = f.store.createThread(f.workspace.id, 'Filtered native query');
  Object.assign(f.access, { outputThreadId: thread.id });
  const filters = { types: ['Rule', 'Rule'], appliesTo: ['tool:invoice.check'] };
  const traced = await f.retrieve(filters);
  expect(traced.retrievalTraceRef).toBeDefined();
  expect(readRetrievalTrace(f.root, traced.retrievalTraceRef!)?.retrievalParameters).toMatchObject({
    types: ['Rule'],
    appliesTo: ['tool:invoice.check'],
  });
  // The public native operation owns request forwarding, without request-selected authority.
  const { createApp } = await import('../test-support/app.js');
  const response = await createApp({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
  }).request('/api/app/operations/knowledge.retrieval', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
    body: JSON.stringify({ workspaceId: f.workspace.id, query: 'domain-selector', ...filters }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const native = await response.json();
  expect(
    native.selected.map((entry: { reference: { objectId: string } }) => entry.reference.objectId)
  ).toEqual(['invoice-rule']);
});
