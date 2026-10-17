// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeEntrySchema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { FsStore } from './lib/store.js';
import { admitKnowledgeRetrieval } from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import {
  type KnowledgeRetrievalAccess,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const NOW = '2026-10-15T00:00:00.000Z';

const testRoots: string[] = [];
const testDbs: CoreDb[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const db of testDbs.splice(0)) db.sqlite.close();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical local retrieval identity', () => {
  it('requires the exact canonical local actor pair before generation access', () => {
    const f = createFixture('local-identity');
    expect(() =>
      admitKnowledgeRetrieval({ workspaceId: f.workspaceId, access: f.access })
    ).not.toThrow();
    for (const actorId of [
      'user_local',
      'usr_00000000-0000-4000-8000-000000000001',
      'usr_00000000-0000-7000-8000-000000000002',
    ]) {
      expect(() =>
        admitKnowledgeRetrieval({
          workspaceId: f.workspaceId,
          access: { ...f.access, actor: { kind: 'user', id: actorId } },
        })
      ).toThrow('Knowledge retrieval access denied.');
    }
    expect(() =>
      admitKnowledgeRetrieval({
        workspaceId: f.workspaceId,
        access: { ...f.access, requestActor: undefined },
      })
    ).toThrow('Knowledge retrieval access denied.');
  });
});

describe('governed Knowledge retrieval over the Retrieval Kernel', () => {
  it('enumerates lexical matches before sensitivity, conflict, freshness, and budget dispositions', async () => {
    const fixture = createFixture('enumeration');
    const selected = await createEntry(
      fixture,
      'Selected evidence',
      'selection-marker selection-marker'
    );
    const overflow = await createEntry(fixture, 'Overflow evidence', 'selection-marker');
    const stale = await createEntry(
      fixture,
      'Selection marker stale evidence',
      'selection-marker selection-marker selection-marker'
    );
    const conflicted = await createEntry(
      fixture,
      'Selection marker conflicted evidence',
      'selection-marker selection-marker selection-marker selection-marker'
    );
    const sensitive = await createEntry(
      fixture,
      'Selection marker private evidence',
      'selection-marker selection-marker selection-marker selection-marker selection-marker'
    );
    await updatePageFields(fixture, stale.id, { freshness: 'stale' });
    await updatePageFields(fixture, conflicted.id, { freshness: 'stale' });
    await updatePageFields(fixture, sensitive.id, {
      freshness: 'stale',
      sensitivity: 'confidential',
    });
    fixture.store.recordKnowledgeConflict({
      id: 'kf_00000000-0000-7c2b-96dc-273a402e04ac',
      workspaceId: fixture.workspaceId,
      subjectReferences: [`knowledge:${conflicted.id}`, `knowledge:${sensitive.id}`],
      sourceReferences: [],
      status: 'conflicting',
      summary: 'The test owns an unresolved conflict.',
      suggestedActions: ['Resolve the test conflict.'],
      producer: 'test-author',
      createdAt: NOW,
      updatedAt: NOW,
    });

    const trace = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'selection-marker'),
      limit: 1,
    });

    expect(trace.selected).toEqual([
      expect.objectContaining({
        reference: { scopeId: `page/workspace/${fixture.workspaceId}`, objectId: selected.id },
      }),
    ]);
    expect(exclusionReasons(trace)).toEqual(
      expect.objectContaining({
        [sensitive.id]: 'sensitive_content',
        [conflicted.id]: 'lower_conformance',
        [stale.id]: 'freshness_expired',
        [overflow.id]: 'budget_exceeded',
      })
    );

    const frontmatterOnly = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'confidential'),
      limit: 20,
    });
    expect(frontmatterOnly).toMatchObject({ selected: [], excluded: [] });
  });

  it('moves a pin first without changing either kernel score', async () => {
    const fixture = createFixture('pin-score');
    const higher = await createEntry(
      fixture,
      'Release cadence release cadence',
      'release cadence release cadence'
    );
    const pinned = await createEntry(fixture, 'Other notes', 'release cadence');
    const ordinary = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'release cadence'),
      limit: 2,
    });
    const withPin = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'release cadence'),
      limit: 2,
      pinnedReferences: [pageReference(fixture, pinned.id)],
    });
    const ordinaryScores = new Map(
      ordinary.selected.map((candidate) => [candidate.reference.objectId, candidate.score])
    );

    expect(ordinary.selected[0]?.reference.objectId).toBe(higher.id);
    expect(withPin.selected.map((candidate) => candidate.reference.objectId)).toEqual([
      pinned.id,
      higher.id,
    ]);
    expect(withPin.selected.map((candidate) => candidate.score)).toEqual([
      ordinaryScores.get(pinned.id),
      ordinaryScores.get(higher.id),
    ]);
  });

  it('uses active-only defaults and one generation for explicit app state inspection', async () => {
    const fixture = createFixture('states');
    const pages = {
      active: await createEntry(fixture, 'Active state', 'state-marker'),
      draft: await createEntry(fixture, 'Draft state', 'state-marker'),
      archived: await createEntry(fixture, 'Archived state', 'state-marker'),
      superseded: await createEntry(fixture, 'Superseded state', 'state-marker'),
    };
    for (const state of ['draft', 'archived', 'superseded'] as const) {
      await updatePageFields(fixture, pages[state].id, {
        openkit_status: state,
        status: state === 'draft' ? 'draft' : 'deprecated',
      });
    }

    const defaultTrace = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'state-marker'),
      limit: 20,
    });
    const firstGeneration = onlyRetrievalGeneration(fixture);
    const explicitTrace = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'state-marker'),
      limit: 20,
      states: ['active', 'draft', 'archived', 'superseded'],
    });

    expect(defaultTrace.selected.map((candidate) => candidate.reference.objectId)).toEqual([
      pages.active.id,
    ]);
    expect(defaultTrace.excluded.map((candidate) => candidate.reference.objectId).sort()).toEqual(
      [pages.archived.id, pages.draft.id, pages.superseded.id].sort()
    );
    expect(explicitTrace.selected.map((candidate) => candidate.reference.objectId).sort()).toEqual(
      Object.values(pages)
        .map((page) => page.id)
        .sort()
    );
    expect(onlyRetrievalGeneration(fixture)).toBe(firstGeneration);
    await expect(
      retrieveWorkspaceKnowledge({
        ...retrievalInput(fixture, 'state-marker'),
        caller: 'assistant',
        states: ['archived'],
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('removes a source after audience revocation without exposing its identity', async () => {
    const fixture = createFixture('source-revocation');
    const destination = fixture.store.createThread(
      fixture.workspaceId,
      'Private destination',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: fixture.userId }
    );
    const sourceThread = fixture.store.createThread(
      fixture.workspaceId,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    fixture.access.outputThreadId = destination.id;
    const material = 'source audience material';
    const source = fixture.store.createKnowledgeSource(
      {
        id: 'ks_00000000-0000-78f8-b8d2-1dd7a79cb16e',
        workspaceId: fixture.workspaceId,
        kind: 'document',
        title: 'Private source',
        uri: null,
        contentDigest: sha256(material),
        originatingThreadId: sourceThread.id,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      material
    );
    const sourcePage = await createEntry(
      fixture,
      'Audience source page',
      'audience-marker source-backed',
      [`source:${source.id}@${source.contentDigest}`]
    );
    const control = await createEntry(fixture, 'Audience control page', 'audience-marker control');
    const before = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'audience-marker'),
      limit: 20,
    });
    expect(before.selected.map((candidate) => candidate.reference.objectId)).toEqual(
      expect.arrayContaining([sourcePage.id, control.id])
    );

    Object.assign(sourceThread, {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
    });
    const after = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'audience-marker'),
      limit: 20,
    });

    expect(after.selected.map((candidate) => candidate.reference.objectId)).toEqual([control.id]);
    expect(JSON.stringify(after)).not.toContain(sourcePage.id);
    expect(JSON.stringify(after)).not.toContain('source-backed');
  });

  it('returns a typed failure and writes no trace when lexical enumeration exceeds 1000 matches', async () => {
    const fixture = createFixture('enumeration-incomplete');
    const traceThread = fixture.store.createThread(fixture.workspaceId, 'Enumeration trace owner');
    fixture.access.outputThreadId = traceThread.id;
    const seed = await createEntry(fixture, 'Bulk seed', 'enumeration-overflow');
    const template = readPage(fixture, seed.id);
    const pages = Array.from({ length: 1000 }, (_, index) => {
      const id = `bulk-${String(index).padStart(4, '0')}`;
      return {
        path: `${id}.md`,
        content: copyCanonicalPage(template, id, `Bulk ${index}`, 'enumeration-overflow'),
      };
    });
    for (let offset = 0; offset < pages.length; offset += 256)
      await publishPages(fixture, pages.slice(offset, offset + 256));
    const failedTraceId = traceId(10);

    await expect(
      retrieveWorkspaceKnowledge({
        ...retrievalInput(fixture, 'enumeration-overflow'),
        limit: 20,
        traceId: failedTraceId,
      })
    ).rejects.toMatchObject({
      code: 'knowledge_retrieval_failed',
      status: 503,
    });
    expect(readTraceBytes(fixture)).not.toContain(failedTraceId);
  });

  it('returns a typed failure and writes no successful trace when canonical bytes change in flight', async () => {
    const fixture = createFixture('concurrent-change');
    const page = await createEntry(
      fixture,
      'Concurrent page',
      `before-change-marker\n${'x'.repeat(1024 * 1024)}`
    );
    const failedTraceId = traceId(11);
    const traceThread = fixture.store.createThread(fixture.workspaceId, 'Concurrent trace owner');
    fixture.access.outputThreadId = traceThread.id;
    const pending = retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'before-change-marker'),
      traceId: failedTraceId,
    });

    const failure = expect(pending).rejects.toMatchObject({
      code: 'knowledge_retrieval_failed',
      status: 409,
    });
    await waitForRetrievalStage(fixture);
    await operation(fixture, 'knowledge.update', {
      baseRevision: fixture.notebook.publishedRevision(),
      knowledgeEntryId: page.id,
      content: 'after-change-marker',
    });
    await failure;
    expect(readTraceBytes(fixture)).not.toContain(failedTraceId);
    expect(readPage(fixture, page.id)).toContain('after-change-marker');
  });
});

interface Fixture {
  dataRoot: string;
  workspaceId: string;
  workspaceRoot: string;
  store: FsStore;
  access: KnowledgeRetrievalAccess;
  userId: string;
  notebook: KnowledgeNotebook;
  app: ReturnType<typeof createApp>;
}

function createFixture(label: string): Fixture {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-retrieval-governance-${label}-`));
  testRoots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  testDbs.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace(label, {
    requestId: randomUUID(),
    producer: { kind: 'user', id: userId },
    instructionReference: 'test-fixture:retrieval-governance',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  return {
    dataRoot,
    workspaceId: workspace.id,
    workspaceRoot,
    store,
    userId,
    notebook: new KnowledgeNotebook({
      repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
    }),
    app: createApp({ coreDb, dataRoot, store }),
    access: {
      store,
      coreDb,
      actor: { kind: 'user', id: userId },
      requestActor: { kind: 'local', userId },
    },
  };
}

/** Uses the actual native command/header and current shared Core root for every page publication. */
async function operation(fixture: Fixture, name: string, input: Record<string, unknown>) {
  const response = await fixture.app.request(`/api/app/operations/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
    body: JSON.stringify({ workspaceId: fixture.workspaceId, ...input }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** Publishes source-free or source-admitted human evidence at the exact current base. */
async function createEntry(
  fixture: Fixture,
  title: string,
  content: string,
  sourceReferences: string[] = []
) {
  const files = fixture.notebook.inspectRevision(fixture.notebook.publishedRevision()).entries;
  return KnowledgeEntrySchema.parse(
    await operation(fixture, 'knowledge.create', {
      baseRevision: fixture.notebook.publishedRevision(),
      knowledgePageId: `page-${String(Object.keys(files).length).padStart(4, '0')}`,
      kind: 'project-context',
      title,
      content,
      sourceReferences,
    })
  );
}

/** Observes the same exact published Git bytes used by the retrieval owner. */
function readPage(fixture: Fixture, id: string): string {
  return fixture.notebook.readRevision(fixture.notebook.publishedRevision(), [`${id}.md`]).files[
    `${id}.md`
  ]!;
}

/** Keeps each native publication within the existing changed-file bound. */
async function publishPages(
  fixture: Fixture,
  changes: readonly { path: string; content: string }[]
) {
  return operation(fixture, 'knowledge.notebook.update', {
    baseRevision: fixture.notebook.publishedRevision(),
    changes,
    summary: 'Governed retrieval fixture',
  });
}

async function updatePageFields(
  fixture: Fixture,
  id: string,
  fields: Readonly<Record<string, string>>
): Promise<void> {
  let content = readPage(fixture, id);
  for (const [field, value] of Object.entries(fields)) {
    const expression = new RegExp(`^${field}: .+$`, 'm');
    if (!expression.test(content)) throw new Error(`Fixture field is missing: ${field}.`);
    content = content.replace(expression, `${field}: ${JSON.stringify(value)}`);
  }
  await publishPages(fixture, [{ path: `${id}.md`, content }]);
}

function copyCanonicalPage(template: string, id: string, title: string, body: string): string {
  const boundary = template.lastIndexOf('\n---\n');
  if (boundary < 0) throw new Error('Canonical Knowledge fixture has no body boundary.');
  const frontmatter = template
    .slice(0, boundary + '\n---\n'.length)
    .replace(/^title: .+$/m, `title: ${JSON.stringify(title)}`)
    .replace(/^openkit_entry_id: .+$/m, `openkit_entry_id: ${JSON.stringify(id)}`);
  return `${frontmatter}${body}\n`;
}

function retrievalInput(fixture: Fixture, query: string) {
  return {
    access: fixture.access,
    caller: 'app-api' as const,
    dataRoot: fixture.dataRoot,
    workspaceId: fixture.workspaceId,
    query,
    now: () => NOW,
  };
}

function pageReference(fixture: Fixture, objectId: string) {
  return { scopeId: `page/workspace/${fixture.workspaceId}`, objectId };
}

function exclusionReasons(trace: {
  excluded: Array<{ reference: { objectId: string }; reason: string }>;
}): Record<string, string> {
  return Object.fromEntries(
    trace.excluded.map((candidate) => [candidate.reference.objectId, candidate.reason])
  );
}

function onlyRetrievalGeneration(fixture: Fixture): string {
  const pointers = findNamedFiles(join(fixture.workspaceRoot, 'indexes', 'retrieval'), 'CURRENT');
  expect(pointers).toHaveLength(1);
  return readFileSync(pointers[0]!, 'utf8');
}

function readTraceBytes(fixture: Fixture): string {
  const root = join(fixture.workspaceRoot, 'threads');
  if (!existsSync(root)) return '';
  return findNamedFiles(root, '.json', true)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function findNamedFiles(root: string, name: string, suffix = false): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...findNamedFiles(path, name, suffix));
    else if (entry.isFile() && (suffix ? entry.name.endsWith(name) : entry.name === name)) {
      paths.push(path);
    }
  }
  return paths;
}

async function waitForRetrievalStage(fixture: Fixture): Promise<void> {
  const root = join(fixture.workspaceRoot, 'indexes', 'retrieval');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (hasStagingDirectory(root)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out while waiting for Retrieval Kernel publication staging.');
}

function hasStagingDirectory(root: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.stage-')) return true;
    if (entry.isDirectory() && hasStagingDirectory(join(root, entry.name))) return true;
  }
  return false;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function traceId(index: number): string {
  return testEntityId('krt', `retrieval-trace-${index}`);
}
