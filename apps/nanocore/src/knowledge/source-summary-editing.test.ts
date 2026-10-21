import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeNotebookPathSchema,
  UpdateKnowledgeNotebookRequestSchema,
} from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import type { AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import {
  type KnowledgeManagerAgentRun,
  pinKnowledgeManagerExecution,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { prepareKnowledgeMaintenance } from './knowledge-agent-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import { type NotebookUpdate, publishWorkspaceNotebook } from './notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';
import { parseSourcePointer } from './source-pointers.js';

let seed: Awaited<ReturnType<typeof fixture>>;
let linkedSeed: Awaited<ReturnType<typeof fixture>>;
let linkedSourceId: string;
const retainedCleanup: Array<() => void> = [];

// Capture once through native owners, then close SQLite before copying this immutable baseline.
// Each case opens its own Store, databases and Git copy; audience and publication never leak.
beforeAll(async () => {
  seed = await fixture(true);
  seed.workspaceDb.sqlite.close();
  seed.coreDb.sqlite.close();
  linkedSeed = await fixture(false, seed, true);
  linkedSourceId = await captureRelatedSource(linkedSeed);
  linkedSeed.baseRevision = linkedSeed.notebook.publishedRevision();
  linkedSeed.workspaceDb.sqlite.close();
  linkedSeed.coreDb.sqlite.close();
}, 120_000);
afterAll(() => {
  for (const cleanup of retainedCleanup) cleanup();
});

/** Native capture, current admission, Git, Storage and Review; no Source is inserted as a curated Page. */
async function fixture(
  initialize = false,
  baseline: {
    dataRoot: string;
    workspace: { id: string };
    origin: { id: string };
    baseRevision: string;
  } = seed,
  retain = false
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-summary-editing-'));
  if (!initialize) cpSync(baseline.dataRoot, dataRoot, { recursive: true });
  const coreDb = openCoreDb(dataRoot);
  if (initialize) applyMigrations(coreDb);
  const userId = initialize ? ensureLocalUser(coreDb) : seed.userId;
  const store = new FsStore({ dataRoot });
  const workspace = initialize
    ? store.createWorkspace('Source description correction')
    : store.getWorkspace(baseline.workspace.id);
  if (initialize)
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  if (initialize) applyScopedMigrations(workspaceDb);
  const cleanup = () => {
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  };
  if (initialize || retain) retainedCleanup.push(cleanup);
  else onTestFinished(cleanup);
  const app = createApp({ coreDb, dataRoot, store });
  const call = async (operation: string, input: Record<string, unknown>, targetApp = app) => {
    const { requestId, ...body } = input;
    const response = await targetApp.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  const origin = initialize
    ? store.createThread(workspace.id, 'Shared evidence')
    : store.getThread(workspace.id, baseline.origin.id);
  const original = 'Captured release facts.\r\nKeep exact \u03a9 \u96ea bytes.\n';
  if (initialize) {
    const captured = await call('knowledge.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Unclear intake title',
      content: original,
      originatingThreadId: origin.id,
    });
    expect(captured.status, JSON.stringify(captured.body)).toBe(200);
  }
  const source = initialize ? store.listKnowledgeSources(workspace.id)[0]! : seed.source;
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const repositoryPath = join(root, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const owner = { dataRoot, ownerScope: { kind: 'workspace', workspaceId: workspace.id } } as const;
  // These captured inputs belong to the closed baseline; deciding reads below still use each copy.
  const pointer = initialize
    ? notebook.readSourcePointers(notebook.publishedRevision())[source.id]!
    : seed.pointer;
  const parsed = parseSourcePointer(owner, source.id, pointer);
  const rawPath = join(root, 'raw', parsed.fields.contentRef.locator.path);
  expect(readFileSync(rawPath)).toEqual(Buffer.from(original));
  const page = serializeKnowledgePageFixture(
    {
      title: 'Unrelated human page',
      content: 'Keep this independent page unchanged.',
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    },
    owner.ownerScope
  );
  if (initialize) {
    const seeded = await call('knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: notebook.publishedRevision(),
      summary: 'Retain unrelated human content',
      changes: [{ path: 'unrelated.md', content: page }],
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  }
  const baseRevision = initialize ? notebook.publishedRevision() : baseline.baseRevision;
  const sourcePath = `sources/${source.id}.md`;
  const path = `@sources/${source.id}.md`;
  const corrected = updateOkfFrontmatter({
    path: sourcePath,
    content: pointer,
    updates: {
      title: 'Release evidence',
      description: 'Captured release facts for onboarding.',
      tags: ['onboarding', 'release'],
    },
    body: 'The captured material describes the release facts.\n',
  });
  return {
    dataRoot,
    coreDb,
    workspaceDb,
    userId,
    store,
    workspace,
    app,
    call,
    origin,
    original,
    source,
    root,
    repositoryPath,
    notebook,
    owner,
    pointer,
    parsed,
    rawPath,
    page,
    baseRevision,
    path,
    sourcePath,
    corrected,
  };
}

describe('ordinary SourceSummary editing through native owners', () => {
  it.each([
    'unchanged Source summary',
    'joint Source summary repair',
  ])('preserves live Page links during confirmed deletion with %s', async (mode) => {
    const f = await fixture();
    const linked = updateOkfFrontmatter({
      path: f.sourcePath,
      content: f.pointer,
      updates: {},
      body: '[Notes](../pages/unrelated.md)\n',
    });
    const linkedResult = await f.call('knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: f.baseRevision,
      summary: 'Link the existing curated Page from the Source summary',
      changes: [{ path: f.path, content: linked }],
    });
    expect(linkedResult.status, JSON.stringify(linkedResult.body)).toBe(200);
    const linkedRevision = f.notebook.publishedRevision();
    expect(f.notebook.readSourcePointers(linkedRevision)[f.source.id]).toBe(linked);
    if (mode === 'unchanged Source summary') {
      const deleted = await f.call('knowledge.notebook.delete', {
        requestId: randomUUID(),
        baseRevision: linkedRevision,
        path: 'unrelated.md',
        expectedContentDigest: `sha256:${createHash('sha256').update(f.page).digest('hex')}`,
        confirmRemoval: true,
        summary: 'Attempt exact confirmed removal while a live Source summary still links here',
      });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(400);
      expect(f.notebook.publishedRevision()).toBe(linkedRevision);
      expect(f.notebook.readRevision(linkedRevision).files['unrelated.md']).toBe(f.page);
      expect(f.notebook.readSourcePointers(linkedRevision)[f.source.id]).toBe(linked);
    } else {
      const repaired = updateOkfFrontmatter({
        path: f.sourcePath,
        content: linked,
        updates: {},
        body: 'The linked Page was removed; retained Source evidence is unchanged.\n',
      });
      const request: NotebookUpdate = {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        baseRevision: linkedRevision,
        summary: 'Remove the exactly confirmed Page and repair its live Source link together',
        changes: [
          { path: 'unrelated.md', content: null },
          { path: f.path, content: repaired },
        ],
      };
      const actor = { kind: 'user', id: f.userId } as const;
      const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot: null });
      const runtimeConfigManager = { current: () => snapshot };
      const workspaceMutationAdmission = new WorkspaceMutationAdmission();
      const currentAuthority = () => {
        if (!currentWorkspaceAuthority(f.coreDb, f.workspace.id, actor, 'knowledge.write', true))
          throw new OperationError(
            'workspace_access_denied',
            'Current native admission denied.',
            403
          );
      };
      // Native confirmation binds both removed bytes and the complete joint candidate.
      const published = await publishWorkspaceNotebook(
        {
          store: f.store,
          workspaceDb: f.workspaceDb,
          notebook: f.notebook,
          actor,
          producer: actor,
          confirmedRemovals: { 'unrelated.md': f.page },
          inflightCommands: new WeakMap(),
          revalidate: () =>
            readWorkspaceNotebookAdmission({
              store: f.store,
              coreDb: f.coreDb,
              workspaceDb: f.workspaceDb,
              notebook: f.notebook,
              runtimeConfigManager,
              workspaceMutationAdmission,
              currentAuthority,
              actor,
              request,
            }),
        },
        request
      );
      const reopened = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
      expect(reopened.publishedRevision()).toBe(published.notebookRevision);
      expect(reopened.readRevision(published.notebookRevision).files).not.toHaveProperty(
        'unrelated.md'
      );
      expect(reopened.readSourcePointers(published.notebookRevision)[f.source.id]).toBe(repaired);
      expect(parseSourcePointer(f.owner, f.source.id, repaired).fields).toEqual(f.parsed.fields);
    }
    expect(f.notebook.readRevision(linkedRevision).files['unrelated.md']).toBe(f.page);
    expect(f.notebook.readSourcePointers(linkedRevision)[f.source.id]).toBe(linked);
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
  });

  it('separates transient Source edit addresses from curated Page paths', () => {
    const id = allocateEntityId('ks');
    const sourceAddress = `@sources/${id}.md`;
    expect(KnowledgeNotebookPathSchema.safeParse('sources/notes.md').success).toBe(true);
    expect(KnowledgeNotebookPathSchema.safeParse(`sources/${id}.md`).success).toBe(true);
    expect(KnowledgeNotebookPathSchema.safeParse(sourceAddress).success).toBe(false);
    const update = UpdateKnowledgeNotebookRequestSchema.safeParse({
      requestId: randomUUID(),
      baseRevision: 'fixed-base',
      summary: 'Edit the existing Source summary',
      changes: [{ path: sourceAddress, content: 'Edited Source summary.\n' }],
    });
    expect(update.success, JSON.stringify(update)).toBe(true);
  });

  it('retains both a curated Page and a native Source with the same relative spelling in complete content', async () => {
    const f = await fixture();
    const pagePath = f.sourcePath;
    const page = serializeKnowledgePageFixture(
      {
        title: 'Separate curated interpretation',
        content: 'This Page is distinct from its similarly named Source.',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      f.owner.ownerScope
    );
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'nested-page-notebook.git'),
    });
    const original = f.notebook.readRevision(f.baseRevision);
    const baseRevision = notebook.initialize({
      files: { ...original.files, [pagePath]: page },
      sourcePointers: f.notebook.readSourcePointers(f.baseRevision),
      metadata: original.metadata,
    });
    const candidateRevision = notebook.prepare({
      baseRevision,
      changes: { 'index.md': '---\nokf_version: "0.2"\n---\n# Separate updated overview\n' },
      metadata: {
        ...original.metadata,
        changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'c'.repeat(64)}` },
      },
    });
    for (const revision of [baseRevision, candidateRevision]) {
      expect(notebook.readRevision(revision).files[pagePath]).toBe(page);
      expect(notebook.readSourcePointers(revision)[f.source.id]).toBe(f.pointer);
      // The complete inventory must retain both canonical members, regardless of its key encoding.
      expect(Object.values(notebook.readContent(revision))).toEqual(
        expect.arrayContaining([page, f.pointer])
      );
    }
  });

  it('publishes descriptive bytes, reopens metadata, replays exactly and preserves fixed-base history and originals', async () => {
    const f = await fixture();
    const input = {
      requestId: randomUUID(),
      baseRevision: f.baseRevision,
      summary: 'Correct the existing Source description',
      changes: [{ path: f.path, content: f.corrected }],
    };
    const published = await f.call('knowledge.notebook.update', input);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const reopened = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
    const revision = reopened.publishedRevision();
    expect(revision).toBe(published.body.notebookRevision);
    expect(reopened.readSourcePointers(revision)[f.source.id]).toBe(f.corrected);
    expect(reopened.readRevision(revision).files).toEqual(
      f.notebook.readRevision(f.baseRevision).files
    );
    expect(reopened.inspectRevision(revision).entries).not.toHaveProperty(f.sourcePath);
    expect(reopened.readSourcePointers(f.baseRevision)[f.source.id]).toBe(f.pointer);
    const after = parseSourcePointer(
      f.owner,
      f.source.id,
      reopened.readSourcePointers(revision)[f.source.id]!
    );
    expect(after.fields).toEqual(f.parsed.fields);
    expect(after.source).toMatchObject({ ...f.parsed.source, title: 'Release evidence' });
    const metadata = new FsStore({ dataRoot: f.dataRoot }).getKnowledgeSource(
      f.workspace.id,
      f.source.id
    );
    expect(metadata).toMatchObject({
      id: f.source.id,
      title: 'Release evidence',
      contentDigest: f.source.contentDigest,
    });
    expect(
      parseOkfDocument({ path: f.sourcePath, content: after.content }).document?.frontmatter
    ).toMatchObject({
      title: 'Release evidence',
      description: 'Captured release facts for onboarding.',
      tags: ['onboarding', 'release'],
    });
    const history = await f.call('knowledge.notebook.history', { limit: 1 });
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.revisions[0]).toMatchObject({
      revision,
      parentRevision: f.baseRevision,
      availability: 'available',
      changedPaths: [f.path],
    });
    const diff = await f.call('knowledge.notebook.diff', {
      baseRevision: revision,
      fromRevision: f.baseRevision,
    });
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    expect(diff.body.changes).toEqual([{ path: f.path, before: f.corrected, after: f.pointer }]);
    const later = await f.call('knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: revision,
      summary: 'Later independent overview',
      changes: [{ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Later overview\n' }],
    });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(await f.call('knowledge.notebook.update', input)).toEqual(published);
    const stale = await f.call('knowledge.notebook.update', {
      ...input,
      requestId: randomUUID(),
      summary: 'Stale correction',
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(reopened.publishedRevision()).toBe(later.body.notebookRevision);
    expect(reopened.readSourcePointers(f.baseRevision)[f.source.id]).toBe(f.pointer);
    expect(reopened.readRevision(reopened.publishedRevision()).files['unrelated.md']).toBe(f.page);
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
  });

  it.each([
    'digest',
    'location',
    'channel',
    'thread lineage',
    'turn lineage',
    'file lineage',
    'create',
    'remove',
    'rename',
  ])('refuses ordinary Source %s changes without publication or raw effects', async (control) => {
    const f = await fixture();
    let updates: Record<string, unknown> = {};
    if (control === 'digest')
      updates = {
        contentRef: { ...f.parsed.fields.contentRef, contentDigest: `sha256:${'a'.repeat(64)}` },
      };
    if (control === 'location')
      updates = {
        contentRef: {
          ...f.parsed.fields.contentRef,
          locator: { ...f.parsed.fields.contentRef.locator, path: 'sources/another/original' },
        },
      };
    if (control === 'channel') updates = { captureChannel: 'knowledge.tell' };
    if (control === 'thread lineage') updates = { originatingThreadId: null };
    if (control === 'turn lineage') updates = { originatingTurnId: allocateEntityId('tu') };
    if (control === 'file lineage') updates = { originatingFileId: 'different-captured-file' };
    const changed = updateOkfFrontmatter({ path: f.sourcePath, content: f.corrected, updates });
    const other = `@sources/${allocateEntityId('ks')}.md`;
    const changes =
      control === 'create'
        ? [{ path: other, content: changed }]
        : control === 'remove'
          ? [{ path: f.path, content: null }]
          : control === 'rename'
            ? [
                { path: f.path, content: null },
                { path: other, content: changed },
              ]
            : [{ path: f.path, content: changed }];
    const result = await f.call('knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: f.baseRevision,
      summary: 'Attempt to change captured evidence identity',
      changes,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    if (control === 'remove') {
      const confirmed = await f.call('knowledge.notebook.delete', {
        requestId: randomUUID(),
        baseRevision: f.baseRevision,
        path: f.path,
        expectedContentDigest: `sha256:${createHash('sha256').update(f.pointer).digest('hex')}`,
        confirmRemoval: true,
        summary: 'Ordinary human confirmation cannot remove a Source',
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(400);
    }
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect(f.notebook.readSourcePointers(f.baseRevision)).toEqual({ [f.source.id]: f.pointer });
    expect(f.notebook.readRevision(f.baseRevision).files['unrelated.md']).toBe(f.page);
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
  });

  it.each([
    'ordinary',
    'ordinary with linked Source',
    'unselected',
    'private',
    'revoked',
  ])('uses the real Workspace KM editor and publisher under %s admission', async (mode) => {
    const linked = mode.endsWith('with linked Source');
    const f = await fixture(false, linked ? linkedSeed : seed);
    await assertMaintenance(
      f,
      mode,
      await runMaintenance(f, mode, linked ? linkedSourceId : undefined)
    );
  });

  describe.each([
    'required Review',
    'required Review with linked Source',
  ])('%s admission', (mode) => {
    let baseline: Awaited<ReturnType<typeof fixture>>;
    let observed: Awaited<ReturnType<typeof runMaintenance>>;
    beforeAll(async () => {
      const linked = mode.endsWith('with linked Source');
      baseline = await fixture(false, linked ? linkedSeed : seed, true);
      observed = await runMaintenance(baseline, mode, linked ? linkedSourceId : undefined);
      baseline.workspaceDb.sqlite.close();
      baseline.coreDb.sqlite.close();
    }, 120_000);
    // One real KM proposal feeds independent copies. No case depends on a prior case's mutation.
    it.each([
      'candidate',
      'refusals',
      'acceptance',
    ] as const)('preserves exact Source Review %s through native owners', async (stage) => {
      const f = await fixture(false, baseline);
      await assertMaintenance(f, mode, observed, stage);
    });
  });
});

/** Captures the related original before the immutable linked-Source baseline is closed. */
async function captureRelatedSource(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const captured = await f.call('knowledge.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Related release evidence',
    content: 'Independent related evidence.',
    originatingThreadId: f.origin.id,
  });
  expect(captured.status, JSON.stringify(captured.body)).toBe(200);
  return captured.body.source.id;
}

/** Includes unreachable candidates so a refused edit cannot hide a prepared commit. */
function notebookCommitInventory(repositoryPath: string): string {
  return execFileSync(
    'git',
    ['--git-dir', repositoryPath, 'cat-file', '--batch-all-objects', '--batch-check'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter((line) => line.split(' ')[1] === 'commit')
    .sort()
    .join('\n');
}

/** Runs the actual editor and native publisher with a deterministic, transport-free model driver. */
async function runMaintenance(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: string,
  relatedSourceId?: string,
  protectedField?: 'source_refs' | 'created_at'
) {
  const requiresReview = mode.startsWith('required Review');
  const linkedSource = mode.endsWith('with linked Source');
  const selectedSources = [f.source.id];
  let summaryBody = 'The captured material describes the release facts.\n';
  if (linkedSource) {
    const relatedId = relatedSourceId ?? (await captureRelatedSource(f));
    selectedSources.push(relatedId);
    f.baseRevision = f.notebook.publishedRevision();
    summaryBody += `[Related evidence](${relatedId}.md)\n`;
    f.corrected = updateOkfFrontmatter({
      path: f.sourcePath,
      content: f.corrected,
      updates: {},
      body: summaryBody,
    });
  }
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      adapter: 'openai-compatible',
      displayName: 'Unused transport',
      kind: 'llm',
      enabled: true,
      baseUrl: 'https://provider.invalid/v1',
      models: ['fixture-model'],
      credential: { kind: 'none' },
      capabilities: { llm: { responses: 'supported', chatCompletions: 'supported' } },
      modelMetadata: {
        'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
      },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: f.dataRoot,
    providerRegistry,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'knowledge',
      logicalModels: [
        {
          id: 'knowledge',
          displayName: 'Knowledge',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: 'fixture-model' }],
        },
      ],
    },
    workspaceConfigs: [
      {
        workspaceId: f.workspace.id,
        path: join(f.dataRoot, 'workspaces', f.workspace.id, 'workspace.jsonc'),
        config: WorkspaceConfigSchema.parse({
          schemaVersion: 1,
          workspace: {
            name: f.workspace.name,
            knowledgeMaintenance: {
              enabled: !requiresReview,
              reviewRequiredPageIds: [],
            },
          },
        }),
      },
    ],
  });
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot: f.dataRoot,
    initialSnapshot: snapshot,
  });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const actor = { kind: 'user', id: f.userId } as const;
  const currentAuthority = () => {
    if (!currentWorkspaceAuthority(f.coreDb, f.workspace.id, actor, 'knowledge.write', true))
      throw new OperationError('workspace_access_denied', 'Current native admission denied.', 403);
  };
  const currentAdmission = (request: NotebookUpdate) =>
    readWorkspaceNotebookAdmission({
      store: f.store,
      coreDb: f.coreDb,
      workspaceDb: f.workspaceDb,
      notebook: f.notebook,
      workspaceMutationAdmission,
      runtimeConfigManager,
      currentAuthority,
      actor,
      request,
    });
  let runs = 0;
  const inspections: Array<{ exitCode: number; stdout: string }> = [];
  let writeRefused = false;
  let revokedReadRefused = false;
  let revokedSubmitRefused = false;
  let reviewToolExposed = false;
  let forgedReviewRefused = false;
  let modelInput = '';
  let sourceRefusal:
    | { tool: AgentToolResult; commits: string; revision: string; proposalCount: number }
    | undefined;
  const run = async (input: KnowledgeManagerAgentRun) => {
    runs += 1;
    reviewToolExposed = input.tools.some((tool) => tool.name === 'knowledge.proposal.decide');
    modelInput = input.messages
      .flatMap((message) =>
        message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      )
      .join('');
    const execute = async (name: string, value: unknown) => {
      const result = await input.tools
        .find((tool) => tool.name === name)!
        .execute(value, {
          callId: randomUUID(),
          toolOccurrence: 1,
          signal: input.signal,
        });
      if (result.isError) throw new Error('Native Tool refused.');
      return JSON.parse(
        result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      );
    };
    if (mode === 'unselected') {
      const inspected = await execute('knowledge.notebook-workspace.update', {
        script: `cat /notebook/${f.path}`,
      });
      inspections.push(inspected);
      try {
        const attempted = await execute('knowledge.notebook-workspace.update', {
          script: `mkdir -p @sources; cat > /notebook/${f.path} <<'SOURCE'\n${f.corrected}SOURCE\n`,
        });
        writeRefused = attempted.exitCode !== 0;
        if (!writeRefused)
          await execute('knowledge.notebook.update', { summary: 'Unselected overwrite' });
      } catch {
        writeRefused = true;
      }
    } else if (mode === 'revoked') {
      // Current audience is a test-owned Thread fact, not a new visibility-transition API.
      Object.assign(f.origin, { visibility: 'private', privateOwnerUserId: f.userId });
      revokedReadRefused = await execute('knowledge.notebook-workspace.update', {
        script: `cat /notebook/${f.path}`,
      }).then(
        () => false,
        () => true
      );
      revokedSubmitRefused = await execute('knowledge.notebook.update', {
        summary: 'Revoked Source edit',
      }).then(
        () => false,
        () => true
      );
    } else {
      if (protectedField) {
        const invalid = updateOkfFrontmatter({
          path: f.sourcePath,
          content: f.pointer,
          updates: {
            [protectedField]:
              protectedField === 'source_refs'
                ? [`source:${f.source.id}@${f.source.contentDigest}`]
                : '2026-10-18T00:00:00.000Z',
          },
        });
        await execute('knowledge.notebook-workspace.update', {
          script: `cat > /notebook/${f.path} <<'SOURCE'\n${invalid}SOURCE\n`,
        });
        const tool = await input.tools
          .find((tool) => tool.name === 'knowledge.notebook.update')!
          .execute(
            { summary: 'Submit the selected Source edit.' },
            { callId: randomUUID(), toolOccurrence: 1, signal: input.signal }
          );
        sourceRefusal = {
          tool,
          commits: notebookCommitInventory(f.repositoryPath),
          revision: f.notebook.publishedRevision(),
          proposalCount: f.store.listKnowledgeProposals(f.workspace.id).length,
        };
        // Recover in the same admitted editor from the original captured frontmatter.
        await execute('knowledge.notebook-workspace.update', {
          script: `cat > /notebook/${f.path} <<'SOURCE'\n${f.pointer}SOURCE\n`,
        });
      }
      const inspected = await execute('knowledge.notebook-workspace.update', {
        script: `cat /notebook/${f.path}`,
      });
      inspections.push(inspected);
      const edited = await execute('knowledge.notebook-workspace.update', {
        script: `cat > /notebook/${f.path} <<'SOURCE'\n${f.corrected}SOURCE\n`,
      });
      inspections.push(edited);
      if (requiresReview) {
        forgedReviewRefused = await execute('knowledge.notebook.update', {
          summary: 'Claim human acceptance',
          decision: 'accepted',
          actor: { kind: 'user', id: f.userId },
        }).then(
          () => false,
          () => true
        );
      }
      await execute('knowledge.notebook.update', {
        summary: 'Correct the selected Source for onboarding',
      });
    }
    f.store.updateTurn(input.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: input.turn.id, text: 'Completed the bounded Source edit attempt.' };
  };
  if (mode === 'private')
    Object.assign(f.origin, { visibility: 'private', privateOwnerUserId: f.userId });
  const prepared = prepareKnowledgeMaintenance(
    {
      store: f.store,
      coreDb: f.coreDb,
      runtimeConfigManager,
      workspaceMutationAdmission,
      openWorkspace: (id) => openWorkspaceDb(f.dataRoot, id),
      inflightCommands: new WeakMap(),
      run,
      pin: (input) =>
        pinKnowledgeManagerExecution(
          {
            store: f.store,
            runtimeConfig: () => snapshot,
            dispatcher: {
              createResponses: async () => {
                throw new Error('No Provider call is needed.');
              },
            },
            resolveGatewayProvider: () => {
              throw new Error('No Provider call is needed.');
            },
          },
          input
        ),
    },
    {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      actor,
      currentAdmission,
      trigger: 'request',
      instructions: 'Correct the selected Source title, description, tags and summary.',
      sources: mode === 'unselected' ? [] : selectedSources,
      signal: new AbortController().signal,
    }
  );
  const result = await prepared.execute();
  return {
    result,
    runs,
    inspections,
    writeRefused,
    revokedReadRefused,
    revokedSubmitRefused,
    reviewToolExposed,
    forgedReviewRefused,
    modelInput,
    summaryBody,
    requiresReview,
    sourceRefusal,
  };
}

it.each([
  'source_refs',
  'created_at',
] as const)('reports protected SourceSummary %s edits with a repair instruction before candidate creation', async (field) => {
  const f = await fixture();
  const commits = notebookCommitInventory(f.repositoryPath);
  const observed = await runMaintenance(f, 'required Review', undefined, field);
  expect(observed.sourceRefusal).toBeDefined();
  const refusal = observed.sourceRefusal!;
  expect(refusal.tool.isError).toBe(true);
  const feedback = refusal.tool.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
  expect(refusal.commits).toBe(commits);
  expect(refusal.revision).toBe(f.baseRevision);
  expect(refusal.proposalCount).toBe(0);
  for (const privateText of [f.dataRoot, f.source.contentDigest, f.original, 'NotebookError:'])
    expect(feedback).not.toContain(privateText);
  expect(JSON.parse(feedback)).toEqual({
    code: 'invalid_request',
    diagnostics: ['notebook.invalid_source_edit'],
    message:
      'Selected SourceSummary edits may change title, description, tags and summary text. Restore other frontmatter from the admitted summary, including source_refs and created_at; put citations on synthesized Pages. Resubmit with knowledge.notebook.update, then call knowledge.result after a successful submission.',
  });
  expect(observed.result.outcome).toBe('review-required');
  const proposal = f.store.listKnowledgeProposals(f.workspace.id)[0]!;
  const candidate = f.notebook.readSourcePointers(proposal.candidateRevision)[f.source.id]!;
  expect(parseSourcePointer(f.owner, f.source.id, candidate).fields).toEqual(f.parsed.fields);
  expect(candidate).toBe(
    updateOkfFrontmatter({
      path: f.sourcePath,
      content: f.corrected,
      updates: { review_state: 'delegated' },
    })
  );
  expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
  expect(f.notebook.readSourcePointers(f.baseRevision)[f.source.id]).toBe(f.pointer);
  expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
}, 120_000);

/** Keeps the original publication, disclosure, cold-load and exact Review oracles. */
async function assertMaintenance(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: string,
  observed: Awaited<ReturnType<typeof runMaintenance>>,
  stage?: 'candidate' | 'refusals' | 'acceptance'
) {
  const {
    result,
    runs,
    inspections,
    writeRefused,
    revokedReadRefused,
    revokedSubmitRefused,
    reviewToolExposed,
    forgedReviewRefused,
    modelInput,
    summaryBody,
    requiresReview,
  } = observed;
  if (mode === 'private') {
    expect(result.outcome).toBe('failed');
    expect(runs).toBe(0);
  } else if (mode === 'unselected' || mode === 'revoked') {
    // A rejected Tool never creates a native outcome; completion must fail rather than publish.
    expect(result.outcome).toBe('failed');
    expect(runs).toBe(1);
    if (mode === 'unselected') {
      expect(inspections).toHaveLength(1);
      expect(inspections[0]!.exitCode).not.toBe(0);
      expect(JSON.stringify(inspections)).not.toContain('Unclear intake title');
      expect(writeRefused).toBe(true);
      expect(modelInput).not.toContain('Unclear intake title');
      expect(modelInput).not.toContain(f.source.contentDigest);
    } else {
      expect(revokedReadRefused).toBe(true);
      expect(revokedSubmitRefused).toBe(true);
    }
  } else {
    expect(runs).toBe(1);
    expect(reviewToolExposed).toBe(false);
    if (requiresReview) expect(forgedReviewRefused).toBe(true);
    expect(inspections).toHaveLength(2);
    expect(inspections[0]).toMatchObject({ exitCode: 0, stdout: f.pointer });
    expect(inspections[1]!.exitCode).toBe(0);
    const expectedCandidate = updateOkfFrontmatter({
      path: f.sourcePath,
      content: f.corrected,
      body: summaryBody,
      updates: { review_state: 'delegated' },
    });
    if (!requiresReview) {
      expect(result.outcome).toBe('published');
      const after = f.notebook.readSourcePointers(f.notebook.publishedRevision())[f.source.id]!;
      expect(after).toBe(expectedCandidate);
      expect(parseSourcePointer(f.owner, f.source.id, after).fields).toEqual(f.parsed.fields);
      expect(f.notebook.readRevision(f.notebook.publishedRevision()).files).toEqual(
        f.notebook.readRevision(f.baseRevision).files
      );
      expect(
        parseOkfDocument({ path: f.sourcePath, content: after }).document?.frontmatter
      ).toMatchObject({
        title: 'Release evidence',
        description: 'Captured release facts for onboarding.',
        tags: ['onboarding', 'release'],
        review_state: 'delegated',
      });
      expect(parseOkfDocument({ path: f.sourcePath, content: after }).document?.body).toBe(
        summaryBody
      );
      expect(f.store.listKnowledgeProposals(f.workspace.id)).toEqual([]);
    } else {
      expect(result.outcome, JSON.stringify(result)).toBe('review-required');
      expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
      const proposal = f.store.listKnowledgeProposals(f.workspace.id)[0]!;
      const tuple = {
        proposalId: proposal.id,
        proposalDigest: f.store.knowledgeProposalDigest(f.workspace.id, proposal.id),
        baseRevision: f.baseRevision,
        candidateRevision: proposal.candidateRevision,
      };
      const candidate = f.notebook.readSourcePointers(proposal.candidateRevision)[f.source.id]!;
      if (stage === 'candidate') {
        const inventory = await f.call('knowledge.proposal.read', { proposalId: proposal.id });
        expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
        expect(inventory.body).toEqual({ ...tuple, paths: [f.path] });
        const preview = await f.call('knowledge.proposal.read', {
          proposalId: proposal.id,
          path: f.path,
        });
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        expect(preview.body).toMatchObject({
          ...tuple,
          path: f.path,
          before: f.pointer,
          after: candidate,
          nextOffset: null,
        });
        expect(candidate).toBe(expectedCandidate);
        expect(proposal.changes).toEqual([{ path: f.path, content: candidate }]);
        expect(f.notebook.readRevision(proposal.candidateRevision).files).toEqual(
          f.notebook.readRevision(f.baseRevision).files
        );
        // A fresh Store must load the complete Source delta without treating it as a Page.
        const savedStore = new FsStore({ dataRoot: f.dataRoot });
        expect(savedStore.projectKnowledgeProposalDraft(f.workspace.id, proposal.id)).toEqual(
          proposal
        );
        expect(savedStore.knowledgeProposalDigest(f.workspace.id, proposal.id)).toBe(
          tuple.proposalDigest
        );
        const savedApp = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: savedStore });
        expect(
          await f.call(
            'knowledge.proposal.read',
            { proposalId: proposal.id, path: f.path },
            savedApp
          )
        ).toEqual(preview);
        expect(savedStore.getKnowledgeProposalReviewDecision(proposal.id)).toBeNull();
        expect(
          new KnowledgeNotebook({ repositoryPath: f.repositoryPath }).publishedRevision()
        ).toBe(f.baseRevision);
        expect(
          parseOkfDocument({ path: f.sourcePath, content: candidate }).document?.frontmatter
        ).toMatchObject({
          title: 'Release evidence',
          description: 'Captured release facts for onboarding.',
          tags: ['onboarding', 'release'],
        });
      }
      if (stage === 'refusals') {
        const forged = await f.call('knowledge.proposal.decide', {
          ...tuple,
          requestId: randomUUID(),
          decision: 'accepted',
          actor: { kind: 'user', id: f.userId },
        });
        expect(forged.status, JSON.stringify(forged.body)).toBe(403);
        expect(f.store.getKnowledgeProposalReviewDecision(proposal.id)).toBeNull();
        expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
        expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
        Object.assign(f.origin, { visibility: 'private', privateOwnerUserId: f.userId });
        const denied = await f.call('knowledge.proposal.read', {
          proposalId: proposal.id,
          path: f.path,
        });
        expect(denied.status).toBe(403);
        expect(JSON.stringify(denied.body)).not.toContain('Unclear intake title');
        expect(JSON.stringify(denied.body)).not.toContain('Release evidence');
        expect(
          (
            await f.call('knowledge.proposal.decide', {
              ...tuple,
              requestId: randomUUID(),
              decision: 'accepted',
            })
          ).status
        ).toBe(403);
        expect(f.store.getKnowledgeProposalReviewDecision(proposal.id)).toBeNull();
        expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
        expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
        Object.assign(f.origin, { visibility: 'workspace', privateOwnerUserId: undefined });
        const mismatched = await f.call('knowledge.proposal.decide', {
          ...tuple,
          proposalDigest: `sha256:${'b'.repeat(64)}`,
          requestId: randomUUID(),
          decision: 'accepted',
        });
        expect(mismatched.status).toBe(409);
        expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
        expect(f.store.getKnowledgeProposalReviewDecision(proposal.id)).toBeNull();
      }
      if (stage === 'acceptance') {
        const decision = { ...tuple, requestId: randomUUID(), decision: 'accepted' };
        const accepted = await f.call('knowledge.proposal.decide', decision);
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        expect(f.notebook.publishedRevision()).toBe(proposal.candidateRevision);
        expect(f.notebook.readSourcePointers(f.notebook.publishedRevision())[f.source.id]).toBe(
          candidate
        );
        expect(await f.call('knowledge.proposal.decide', decision)).toEqual(accepted);
        // Reopen after publication and replay through the native operation, not a DTO comparison.
        const acceptedStore = new FsStore({ dataRoot: f.dataRoot });
        expect(acceptedStore.projectKnowledgeProposalDraft(f.workspace.id, proposal.id)).toEqual(
          proposal
        );
        expect(acceptedStore.knowledgeProposalDigest(f.workspace.id, proposal.id)).toBe(
          tuple.proposalDigest
        );
        expect(acceptedStore.getKnowledgeProposalReviewDecision(proposal.id)).toEqual(
          f.store.getKnowledgeProposalReviewDecision(proposal.id)
        );
        const acceptedApp = createApp({
          coreDb: f.coreDb,
          dataRoot: f.dataRoot,
          store: acceptedStore,
        });
        expect(await f.call('knowledge.proposal.decide', decision, acceptedApp)).toEqual(accepted);
        const publishedNotebook = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
        expect(publishedNotebook.publishedRevision()).toBe(proposal.candidateRevision);
        expect(publishedNotebook.readSourcePointers(proposal.candidateRevision)[f.source.id]).toBe(
          candidate
        );
        expect(publishedNotebook.readRevision(proposal.candidateRevision).files).toEqual(
          publishedNotebook.readRevision(f.baseRevision).files
        );
        expect(acceptedStore.getKnowledgeSource(f.workspace.id, f.source.id)).toMatchObject({
          title: 'Release evidence',
          contentDigest: f.source.contentDigest,
        });
      }
    }
  }
  if (mode === 'unselected' || mode === 'private' || mode === 'revoked') {
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect(f.store.listKnowledgeProposals(f.workspace.id)).toEqual([]);
  }
  expect(reviewToolExposed).toBe(false);
  const reopened = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
  expect(reopened.readSourcePointers(f.baseRevision)[f.source.id]).toBe(f.pointer);
  expect(reopened.readRevision(reopened.publishedRevision()).files['unrelated.md']).toBe(f.page);
  expect(reopened.inspectRevision(reopened.publishedRevision()).entries).not.toHaveProperty(
    f.sourcePath
  );
  expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
}
