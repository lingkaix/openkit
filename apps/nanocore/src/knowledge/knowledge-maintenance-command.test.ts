import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import {
  pinKnowledgeManagerExecution,
  runKnowledgeManagerAgent,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import type { KnowledgeMaintenanceDependencies } from './knowledge-agent-maintenance.js';
import { runKnowledgeMaintenanceCommand } from './knowledge-maintenance-command.js';
import { KnowledgeNotebook } from './notebook.js';
import { publishWorkspaceNotebookEntry } from './notebook-entry-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';

type Request = Parameters<LLMGatewayProviderDispatcher['createResponses']>[1];
type DispatchContext = Parameters<LLMGatewayProviderDispatcher['createResponses']>[2];
type Response = Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>;

/** Real admission, role, virtual editor, publisher and receipts; only the external Responses transport is fake. */
async function fixture(reviewRequired = false, failAfterPublication = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-command-proof-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Maintenance command proof', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'fixture:human-workspace',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const bootstrap = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot }),
  });
  await publishWorkspaceNotebookEntry(
    {
      store,
      workspaceDb,
      notebook,
      producer: actor,
      inflightCommands: new WeakMap(),
      revalidate: (request) =>
        readWorkspaceNotebookAdmission({
          store,
          coreDb,
          workspaceDb,
          notebook,
          request,
          requestActor: { kind: 'local', userId },
          actor,
          runtimeConfigManager: bootstrap,
          workspaceMutationAdmission,
        }),
    },
    {
      operation: 'knowledge.create',
      workspaceId: workspace.id,
      requestId: randomUUID(),
      knowledgePageId: 'labels',
      baseRevision: notebook.publishedRevision(),
      kind: 'project-context',
      title: 'Labels',
      content: 'Human note: keep this sentence.',
    }
  );
  const baseRevision = notebook.publishedRevision();
  const ordinary = store.createThread(workspace.id, 'Shared source conversation');
  const sourceTurn = store.createTurn(workspace.id, ordinary.id, 'Record the label rule', actor);
  const now = new Date().toISOString();
  store.createItem({
    id: allocateEntityId('it'),
    workspaceId: workspace.id,
    threadId: ordinary.id,
    turnId: sourceTurn.id,
    type: 'user-message',
    actor,
    text: 'The project uses cobalt labels.',
    status: 'completed',
    createdAt: now,
    completedAt: now,
  });
  store.updateTurn(sourceTurn.id, { status: 'completed', completedAt: now });
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    providerRegistry: new ProviderRegistry([
      {
        id: 'fixture',
        kind: 'custom',
        displayName: 'Fake transport',
        baseUrl: 'https://provider.invalid/v1',
        models: ['ordinary-model', 'maintenance-model'],
        modelMetadata: { 'ordinary-model': metadata, 'maintenance-model': metadata },
      },
    ]),
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'ordinary',
      logicalModels: ['ordinary', 'maintenance'].map((id) => ({
        id,
        displayName: id,
        contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
        routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: `${id}-model` }],
      })),
    },
    internalRoleProfiles: {
      schemaVersion: 1,
      profiles: [
        {
          id: 'maintenance-profile',
          roleId: 'knowledge-manager',
          preferredLogicalModelId: 'maintenance',
          compatibleLogicalModelIds: [],
          requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
          limits: { maxModelTurns: 8, maxToolCalls: 24, deadlineMs: 120_000 },
        },
      ],
    },
    workspaceConfigs: [
      {
        workspaceId: workspace.id,
        path: join(dataRoot, 'workspace.yaml'),
        config: WorkspaceConfigSchema.parse({
          schemaVersion: 1,
          workspace: {
            name: workspace.name,
            internalRoles: [{ roleId: 'knowledge-manager', profileId: 'maintenance-profile' }],
            knowledgeMaintenance: {
              enabled: true,
              reviewRequiredPageIds: reviewRequired ? ['labels'] : [],
            },
          },
        }),
      },
    ],
  });
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot });
  const input = {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    actor,
    requestActor: { kind: 'local' as const, userId },
    trigger: 'request' as const,
    instructions: 'Retain the human note, integrate the label rule and update the overview.',
    sources: [],
    signal: new AbortController().signal,
  };
  const observedReceipts: Array<ReturnType<FsStore['getCommandRequest']>> = [];
  let nativeResultAtFailure: unknown;
  let sourceReference: string | undefined;
  const createResponses = vi.fn(
    async (_provider: unknown, request: Request, context: DispatchContext): Promise<Response> => {
      const receipt = store.getCommandRequest(
        'knowledge.maintain',
        input.requestId,
        { workspaceId: workspace.id, actorId: actor.id },
        workspaceDb
      );
      observedReceipts.push(receipt);
      const step = observedReceipts.length;
      if (step === 3 && failAfterPublication) {
        const retained = receipt
          ? store
              .getTurnById(receipt.response.id)
              .items.findLast((item) => item.type === 'status' && item.knowledgeMaintenanceResult)
          : undefined;
        nativeResultAtFailure =
          retained?.type === 'status'
            ? structuredClone(retained.knowledgeMaintenanceResult)
            : undefined;
        throw new Error('Synthetic Provider failure after native publication.');
      }
      context?.onUsage?.({ input_tokens: 9, output_tokens: 3, total_tokens: 12 });
      if (step === 1) {
        const messages = request.input as Array<{
          role?: string;
          content?: Array<{ text?: string }>;
        }>;
        const text = messages.find((message) => message.role === 'user')!.content![0]!.text!;
        const payload = JSON.parse(text) as { sources: Array<{ file: string; reference: string }> };
        const source = payload.sources[0]!;
        sourceReference = source.reference;
        return toolCall('edit', 'knowledge.notebook-workspace.update', {
          script: `cat '${source.file}'\nsed -i 's/^source_refs:.*$/source_refs: ["${source.reference}"]/' labels.md\nprintf '\\nThe project uses cobalt labels.\\n' >> labels.md\nprintf '\\n[Labels](labels.md)\\n' >> index.md`,
        });
      }
      if (step === 2)
        return toolCall('publish', 'knowledge.notebook.update', {
          summary: 'Integrate the cobalt label rule',
        });
      return toolCall('result', 'knowledge.result', { summary: 'Maintenance complete.' });
    }
  );
  const roleDependencies = {
    store,
    runtimeConfig: () => runtimeConfigManager.current(),
    dispatcher: { createResponses },
    resolveGatewayProvider: (_id: string, model: string) => ({
      id: 'fixture',
      displayName: 'Fake transport',
      adapterId: 'fixture',
      models: [model],
      baseUrl: null,
      apiKey: '',
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native' as const, chatCompletions: 'native' as const },
      modelMetadata: { [model]: metadata },
    }),
  };
  const dependencies: KnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager,
    workspaceMutationAdmission,
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    pin: (run) => {
      pinKnowledgeManagerExecution(roleDependencies, run);
    },
    run: (run) => runKnowledgeManagerAgent(roleDependencies, run),
  };
  const replay = (instructions = input.instructions) =>
    runKnowledgeMaintenanceCommand(
      { ...dependencies, store: new FsStore({ dataRoot }), inflightCommands: new WeakMap() },
      { ...input, instructions }
    );
  return {
    store,
    workspace,
    notebook,
    baseRevision,
    dependencies,
    input,
    createResponses,
    observedReceipts,
    replay,
    sourceTurn,
    sourceReference: () => sourceReference,
    nativeResultAtFailure: () => nativeResultAtFailure,
  };
}

/** Model Tool requests cross the actual canonical Tool projection. */
function toolCall(callId: string, name: string, args: Record<string, string>): Response {
  return {
    id: randomUUID(),
    object: 'response',
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name: operationToolName(name),
        arguments: JSON.stringify(args),
      },
    ],
  };
}

/** Provider-visible Tool output is evidence that the real editor or publisher returned. */
function toolOutput(request: Request, callId: string): string {
  const messages = request.input as Array<{ type?: string; call_id?: string; output?: string }>;
  const result = messages.find(
    (message) => message.type === 'function_call_output' && message.call_id === callId
  );
  expect(result, `Missing actual ${callId} Tool output`).toBeDefined();
  return result!.output!;
}

// Real Gateway, Git publication and reopened-Store replay exceed the generic 30 s harness; the role retains its own 120 s execution deadline.
it.each([
  false,
  true,
])('runs real maintenance with required Review %s and replays its native result without another model call', async (reviewRequired) => {
  const f = await fixture(reviewRequired);
  const result = await runKnowledgeMaintenanceCommand(f.dependencies, f.input);
  expect(result.outcome).toBe(reviewRequired ? 'review-required' : 'published');
  expect(f.createResponses).toHaveBeenCalledTimes(3);
  expect(
    f.createResponses.mock.calls.every(([, request]) => request.model === 'maintenance-model')
  ).toBe(true);
  expect(f.observedReceipts.every((receipt) => receipt?.response.id === result.turnId)).toBe(true);
  const edit = JSON.parse(toolOutput(f.createResponses.mock.calls[1]![1], 'edit'));
  expect(edit).toMatchObject({ exitCode: 0, stderr: '' });
  expect(edit.stdout).toContain('The project uses cobalt labels.');
  const publication = JSON.parse(toolOutput(f.createResponses.mock.calls[2]![1], 'publish'));
  expect(publication.outcome).toBe(reviewRequired ? 'review_required' : 'published');
  const selected = reviewRequired ? result.candidateRevision! : result.notebookRevision;
  const committed = f.notebook.readRevision(selected);
  expect(committed.parentRevision).toBe(f.baseRevision);
  expect(committed.files['labels.md']).toContain('Human note: keep this sentence.');
  expect(committed.files['labels.md']).toContain('The project uses cobalt labels.');
  expect(committed.files['labels.md']).toContain(f.sourceReference());
  expect(committed.files['index.md']).toContain('[Labels](labels.md)');
  if (reviewRequired) {
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect(f.store.projectKnowledgeProposalDraft(f.workspace.id, result.proposalId!)).toMatchObject(
      { candidateRevision: selected }
    );
  } else expect(f.notebook.publishedRevision()).toBe(selected);
  const turn = f.store.getTurnById(result.turnId);
  expect(turn).toMatchObject({
    status: 'completed',
    internalExecution: {
      logicalModelId: 'maintenance',
      knowledge: {
        purpose: 'maintenance',
        baseRevision: f.baseRevision,
        sourceRange: [{ turnId: f.sourceTurn.id }],
      },
    },
  });
  expect(turn.items.filter((item) => item.type === 'tool-call').map((item) => item.tool)).toEqual([
    'knowledge.notebook-workspace.update',
    'knowledge.notebook.update',
    'knowledge.result',
  ]);
  expect(await f.replay()).toEqual(result);
  expect(f.createResponses).toHaveBeenCalledTimes(3);
  await expect(f.replay('Changed maintenance instructions.')).rejects.toBeInstanceOf(
    IdempotencyKeyConflictError
  );
  expect(f.createResponses).toHaveBeenCalledTimes(3);
  expect(f.notebook.publishedRevision()).toBe(reviewRequired ? f.baseRevision : selected);
  expect(
    f.store
      .listThreads(f.workspace.id)
      .flatMap((thread) => f.store.listThreadTurns(f.workspace.id, thread.id))
      .filter((work) => work.agentId === 'knowledge-manager')
  ).toHaveLength(1);
}, 120_000);

it('retains publication before a late Provider failure and replays that published outcome from the same failed model Turn', async () => {
  const f = await fixture(false, true);
  const result = await runKnowledgeMaintenanceCommand(f.dependencies, f.input);
  expect(result.outcome).toBe('published');
  expect(f.store.getTurnById(result.turnId).status).toBe('failed');
  expect(f.notebook.publishedRevision()).toBe(result.notebookRevision);
  expect(f.notebook.readRevision(result.notebookRevision).files['labels.md']).toContain(
    'The project uses cobalt labels.'
  );
  expect(await f.replay()).toEqual(result);
  expect(f.nativeResultAtFailure()).toEqual(result);
  expect(f.createResponses).toHaveBeenCalledTimes(3);
  expect(f.notebook.publishedRevision()).toBe(result.notebookRevision);
}, 120_000);
