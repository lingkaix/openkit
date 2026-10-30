import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';
import { updateOkfFrontmatter } from './okf.js';
import { previewNotebookSchema } from './scope-schema-migration.js';
import { readSourcePointers } from './source-pointers.js';

/** Real native initialization and Source publication; the preview receives no fabricated retained record. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'scope-schema-preview-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Schema preview');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const app = createApp({ coreDb, dataRoot, store });
  const call = async (operation: string, input: Record<string, unknown>) => {
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({ workspaceId: workspace.id, ...input }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const source = await call('knowledge.source.register', {
    kind: 'document',
    title: 'Original',
    content: 'Exact Source original.',
  });
  const ownerScope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const scopeSchemaText = readFileSync(join(root, 'schema', 'scope-schema.yaml'), 'utf8');
  const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot, scope: ownerScope });
  const registeredSources = new Map(
    [...readSourcePointers({ dataRoot, ownerScope })].map(([id, pointer]) => [
      id,
      pointer.source.contentDigest,
    ])
  );
  return {
    call,
    root,
    ownerScope,
    sourceId: source.source.id as string,
    input: {
      workspaceId: workspace.id,
      notebook,
      scopeSchemaText,
      pageScopeId: `page/workspace/${workspace.id}/${knowledgeBaseId}`,
      registeredSources,
      revalidate: () => {},
    },
  };
}

it('previews every unchanged Page and Source without the editing diagnostic cap or publication', async () => {
  const f = await fixture();
  const paths = Array.from({ length: 101 }, (_, index) => `note-${index}.md`);
  const changes = paths.map((path, index) => ({
    path,
    content: updateOkfFrontmatter({
      path,
      content: serializeKnowledgePageFixture(
        {
          title: path,
          content: 'Retained page bytes.',
          createdAt: '2026-10-31T00:00:00.000Z',
          updatedAt: '2026-10-31T00:00:00.000Z',
        },
        f.ownerScope
      ),
      updates: index === 0 ? { openkit_status: 'draft', status: 'draft' } : {},
    }),
  }));
  await f.call('knowledge.notebook.update', {
    baseRevision: f.input.notebook.publishedRevision(),
    changes,
    summary: 'Publish real preview inputs.',
  });
  const revision = f.input.notebook.publishedRevision();
  const content = f.input.notebook.readContent(revision);
  const schemaFiles = readdirSync(join(f.root, 'schema'));
  const candidateSchemaText = f.input.scopeSchemaText.replace(
    /^allowed_types:.*$/m,
    'allowed_types: [Observation]'
  );
  const report = previewNotebookSchema({ ...f.input, candidateSchemaText });

  expect(report).toMatchObject({
    workspaceId: f.ownerScope.workspaceId,
    notebookRevision: revision,
    coverage: 'notebook',
    completeMigration: false,
    schemaDiagnostics: [],
    baseSchemaDigest: `sha256:${createHash('sha256').update(f.input.scopeSchemaText).digest('hex')}`,
    candidateSchemaDigest: `sha256:${createHash('sha256').update(candidateSchemaText).digest('hex')}`,
  });
  expect(report.records.map((record) => record.path).sort()).toEqual(
    ['index.md', ...paths, `@sources/${f.sourceId}.md`].sort()
  );
  expect(report.records.find((record) => record.path === 'index.md')?.status).toBe('valid');
  expect(report.records.find((record) => record.path === paths[0])?.status).toBe('invalid-draft');
  expect(report.records.filter((record) => record.status === 'needs-review')).toHaveLength(101);
  expect(
    report.records
      .filter((record) => record.path !== 'index.md')
      .every((record) => record.diagnostics.length > 0)
  ).toBe(true);
  expect(report.records.flatMap((record) => record.diagnostics).length).toBeGreaterThan(100);
  expect(f.input.notebook.publishedRevision()).toBe(revision);
  expect(f.input.notebook.readContent(revision)).toEqual(content);
  expect(readFileSync(join(f.root, 'schema', 'scope-schema.yaml'), 'utf8')).toBe(
    f.input.scopeSchemaText
  );
  expect(readdirSync(join(f.root, 'schema'))).toEqual(schemaFiles);
});

it('reports invalid candidate schema separately without activating or rewriting it', async () => {
  const f = await fixture();
  const revision = f.input.notebook.publishedRevision();
  const report = previewNotebookSchema({
    ...f.input,
    candidateSchemaText: 'schema_version: [broken',
  });
  expect(report.schemaDiagnostics.length).toBeGreaterThan(0);
  expect(report).toMatchObject({
    notebookRevision: revision,
    coverage: 'notebook',
    completeMigration: false,
  });
  expect(f.input.notebook.publishedRevision()).toBe(revision);
  expect(readFileSync(join(f.root, 'schema', 'scope-schema.yaml'), 'utf8')).toBe(
    f.input.scopeSchemaText
  );
});
