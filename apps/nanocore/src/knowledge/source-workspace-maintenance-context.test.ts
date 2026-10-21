// openkit-test-platform: posix
// Real native admission, Source publication, Storage and Notebook editor surround one role double.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { ContentReferenceSchema } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import {
  type KnowledgeManagerAgentDependencies,
  type KnowledgeManagerAgentRun,
  pinKnowledgeManagerExecution,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { ProviderRegistry } from '../providers/registry.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  type KnowledgeMaintenanceDependencies,
  prepareKnowledgeMaintenance,
} from './knowledge-agent-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import type { NotebookUpdate } from './notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { parseOkfDocument, stringListFrontmatterField } from './okf.js';

it('captures native Workspace tell during execution and publishes from the exact Source-containing editor base', async () => {
  const original = 'The release label is AMBER-SOURCE-9.\r\nKeep exact Ω 雪 bytes.\n';
  const digest = `sha256:${createHash('sha256').update(Buffer.from(original)).digest('hex')}`;
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-workspace-maintenance-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Native Source maintenance');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(async () => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const actor = { kind: 'agent' as const, id: 'knowledge-manager', responsibleUserId: userId };
  const scope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const initialRevision = notebook.publishedRevision();
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      adapter: 'openai-compatible',
      displayName: 'Unused role transport',
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
    dataRoot,
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
        workspaceId: workspace.id,
        path: join(dataRoot, 'workspaces', workspace.id, 'workspace.jsonc'),
        config: WorkspaceConfigSchema.parse({
          schemaVersion: 1,
          workspace: {
            name: workspace.name,
            knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
          },
        }),
      },
    ],
  });
  const runtimeConfigManager = { current: () => snapshot } as RuntimeConfigManager;
  const currentAuthority = () => {
    if (!currentWorkspaceAuthority(coreDb, workspace.id, actor, 'knowledge.write', true))
      throw new OperationError('workspace_access_denied', 'Current native admission denied.', 403);
  };
  const currentAdmission = (request: NotebookUpdate) =>
    readWorkspaceNotebookAdmission({
      store,
      coreDb,
      workspaceDb,
      notebook,
      workspaceMutationAdmission,
      runtimeConfigManager,
      currentAuthority,
      actor: { kind: 'user', id: userId },
      request,
    });
  const roleDependencies: KnowledgeManagerAgentDependencies = {
    store,
    runtimeConfig: () => snapshot,
    dispatcher: {
      createResponses: async () => {
        throw new Error('Only the bounded role runner is replaced in this test.');
      },
    },
    resolveGatewayProvider: () => {
      throw new Error('No external Provider call is needed for the editor boundary.');
    },
  };
  const deliveries: Array<{ sourceId: string; reference: string; baseRevision: string }> = [];
  const run = vi.fn(async (input: KnowledgeManagerAgentRun) => {
    const payload = JSON.parse(
      input.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(
        ''
      )
    );
    expect(payload.sources).toHaveLength(1);
    const supplied = payload.sources[0];
    expect(supplied).toMatchObject({ content: original, truncated: false });
    const match = /^source:([^@]+)@(sha256:[0-9a-f]{64})$/.exec(supplied.reference);
    expect(match).not.toBeNull();
    const sourceId = match![1]!;
    expect(match![2]).toBe(digest);
    const baseRevision = input.inputs!.baseRevision;
    expect(baseRevision).not.toBe(initialRevision);
    expect(baseRevision).toBe(notebook.publishedRevision());
    expect(payload.notebookRevision).toBe(baseRevision);
    expect(notebook.readSourcePointers(baseRevision)).toHaveProperty(sourceId);
    expect(store.getTurnById(input.turn.id).internalExecution?.knowledge?.baseRevision).toBe(
      baseRevision
    );
    // Re-admission uses the actual pinned-input rule, rather than a fixture that rewrites the pin.
    pinKnowledgeManagerExecution(roleDependencies, input);
    const execute = (name: string, value: unknown) =>
      input.tools
        .find((tool) => tool.name === name)!
        .execute(value, {
          callId: randomUUID(),
          toolOccurrence: 1,
          signal: input.signal,
        });
    const inspected = await execute('knowledge.notebook-workspace.update', {
      script: `cat /sources/${sourceId}`,
    });
    expect(
      JSON.parse(
        inspected.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      )
    ).toMatchObject({ exitCode: 0, stdout: original, truncated: false });
    const page = serializeKnowledgePageFixture(
      {
        title: 'Release label',
        content: original,
        sourceReferences: [supplied.reference],
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      scope
    );
    const edited = await execute('knowledge.notebook-workspace.update', {
      script: `cat > release-label.md <<'PAGE'\n${page}\nPAGE\nprintf '\\n[Release label](release-label.md)\\n' >> index.md`,
    });
    expect(
      JSON.parse(
        edited.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      ).exitCode
    ).toBe(0);
    await execute('knowledge.notebook.update', { summary: 'Retain the supplied release label.' });
    expect(input.validateResult('{"summary":"Retained the release label."}')).toBeUndefined();
    deliveries.push({ sourceId, reference: supplied.reference, baseRevision });
    await store.updateTurn(input.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: input.turn.id, text: '{"summary":"Retained the release label."}' };
  });
  const dependencies: KnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager,
    workspaceMutationAdmission,
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    pin: (input) => {
      pinKnowledgeManagerExecution(roleDependencies, input);
    },
    run,
  };
  expect(currentWorkspaceAuthority(coreDb, workspace.id, actor, 'knowledge.read', true)).toBe(
    'member'
  );
  expect(currentWorkspaceAuthority(coreDb, workspace.id, actor, 'knowledge.write', true)).toBe(
    'member'
  );
  expect(() =>
    currentAdmission({
      workspaceId: workspace.id,
      requestId: randomUUID(),
      baseRevision: initialRevision,
      changes: [],
      summary: 'Check the actual current native publication admission.',
    })
  ).not.toThrow();
  const input = {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    actor,
    currentAdmission,
    trigger: 'request' as const,
    instructions: 'Retain this exact release label in the Workspace notebook.',
    sources: [],
    tellContent: original,
    signal: new AbortController().signal,
  };
  expect(input).not.toHaveProperty('requestActor');
  const prepared = await prepareKnowledgeMaintenance(dependencies, input);
  expect(prepared).not.toBeInstanceOf(Promise);
  expect(store.getTurnById(prepared.turnId).triggerActor).toEqual(actor);
  expect(run).not.toHaveBeenCalled();
  const result = await prepared.execute();
  expect(result.outcome).toBe('published');
  expect(run).toHaveBeenCalledTimes(1);
  const delivered = deliveries[0]!;
  const retained = store.getTurnById(prepared.turnId);
  expect(retained.internalExecution?.knowledge?.baseRevision).toBe(delivered.baseRevision);
  expect(retained.status).toBe('completed');
  expect(notebook.inspectRevision(result.notebookRevision).parentRevision).toBe(
    delivered.baseRevision
  );
  const pointer = notebook.readSourcePointers(delivered.baseRevision)[delivered.sourceId]!;
  expect(notebook.readSourcePointers(result.notebookRevision)[delivered.sourceId]).toBe(pointer);
  const parsed = parseOkfDocument({ path: `sources/${delivered.sourceId}.md`, content: pointer });
  if (!parsed.ok) throw new Error('Expected the published canonical SourceSummary.');
  expect(parsed.document.frontmatter).toMatchObject({
    type: 'SourceSummary',
    scope,
    byteLength: Buffer.byteLength(original),
    captureChannel: 'knowledge.source.register',
    originatingThreadId: retained.threadId,
    originatingTurnId: retained.id,
  });
  const reference = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
  expect(reference.locator.ownerScope).toEqual(scope);
  expect(reference.knowledgeBaseId).toBe(readDefaultKnowledgeBaseId({ dataRoot, scope }));
  expect(reference.locator.mount).toBe('managed');
  expect(reference.contentDigest).toBe(digest);
  const rawRoot = resolve(root, 'raw');
  const rawPath = resolve(rawRoot, reference.locator.path);
  const confined = relative(rawRoot, rawPath);
  expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
  expect(readFileSync(rawPath)).toEqual(Buffer.from(original));
  const page = notebook.readRevision(result.notebookRevision).files['release-label.md']!;
  expect(page).toContain(original);
  const parsedPage = parseOkfDocument({ path: 'release-label.md', content: page });
  expect(stringListFrontmatterField(parsedPage.document!, 'source_refs')).toEqual([
    delivered.reference,
  ]);
});
