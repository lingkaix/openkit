import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import {
  type KnowledgeManagerAgentRun,
  pinKnowledgeManagerExecution,
  runKnowledgeManagerAgent,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveUserMemory,
} from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { appendMemorySuppression } from './memory-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, stringListFrontmatterField } from './okf.js';
import { resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import {
  prepareUserMemoryMaintenance,
  readUserMemoryNotebookAdmission,
  runUserMemoryMaintenanceCommand,
} from './user-memory-agent-maintenance.js';
import {
  createUserMemoryProposal,
  decideUserMemoryProposal,
  readUserMemoryProposal,
  readUserMemoryProposalPreview,
} from './user-memory-proposals.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
/** Real scoped persistence and virtual editor surround the bounded fake role runner. */
function fixture(enabled = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'user-memory-agent-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES (?, ?, ?, false, ?, ?, 'human')"
    )
    .run(userId, 'User', 'user@example.invalid', Date.now(), Date.now());
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  const store = new FsStore({ dataRoot });
  const requestActor = { kind: 'session', userId } as const;
  const settings = { enabled, reviewRequiredPageIds: [] as string[] };
  const run = vi.fn(async (run: KnowledgeManagerAgentRun) => {
    const execute = (name: string, value: unknown) =>
      run.tools
        .find((tool) => tool.name === name)!
        .execute(value, { callId: randomUUID(), toolOccurrence: 1, signal: run.signal });
    const payload = JSON.parse(
      run.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    );
    expect(payload.sources[0].content).toBe('I prefer green labels.');
    expect(run.inputs?.sourceRange).toEqual([]);
    const page = serializeUserAuthoredKnowledgePage(
      {
        id: 'labels',
        kind: 'preference',
        title: 'Labels',
        content: 'I prefer green labels.',
        sourceReferences: [payload.sources[0].reference],
        createdAt: '2026-10-18T00:00:00.000Z',
        updatedAt: '2026-10-18T00:00:00.000Z',
      },
      { kind: 'user', userId }
    );
    await execute('knowledge.notebook-workspace.update', {
      script: `cat > labels.md <<'PAGE'\n${page}\nPAGE\nprintf '\\n[Labels](labels.md)\\n' >> index.md`,
    });
    await execute('knowledge.notebook.update', { summary: 'Record labels.' });
    expect(run.validateResult('{"summary":"Recorded."}')).toBeUndefined();
    store.updateTurn(run.turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    return { turnId: run.turn.id, text: 'Recorded.' };
  });
  const dependencies = {
    coreDb,
    userDb,
    store,
    runtimeConfigManager: {
      current: () => ({ userConfigs: [{ userId, config: { knowledgeMaintenance: settings } }] }),
    } as unknown as RuntimeConfigManager,
    openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: (run: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>) => {
      store.updateTurn(run.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'fixture-model',
          contextStrategy: 'compaction',
          threshold: 1000,
          knowledge: run.inputs!,
        },
      });
    },
  };
  const input = {
    requestId: randomUUID(),
    requestActor,
    trigger: 'request' as const,
    instructions: 'Remember my preference.',
    sources: [],
    tellContent: 'I prefer green labels.',
    signal: new AbortController().signal,
  };
  onTestFinished(() => {
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const notebook = () =>
    new KnowledgeNotebook({
      repositoryPath: join(
        resolveScopedNotebookOwner({ coreDb, actor: requestActor, target: { kind: 'user' } })
          .notebookRoot,
        'notebook.git'
      ),
    });
  return { dependencies, input, notebook, run, store, settings, userDb, coreDb };
}

/** Exercises the real Gateway, configured model pin, compaction path and result loop with a fake external Provider. */
function useFakeProvider(f: ReturnType<typeof fixture>) {
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      adapter: 'openai-compatible',
      displayName: 'Fake transport',
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
    dataRoot: f.coreDb.dataRoot,
    providerRegistry,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'km-model',
      logicalModels: [
        {
          id: 'km-model',
          displayName: 'KM',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: 'fixture-model' }],
        },
      ],
    },
  });
  let script = '';
  let calls = 0;
  const createResponses = vi.fn(async () => {
    const step = ++calls;
    return {
      id: `response-${step}`,
      object: 'response',
      output: [
        {
          type: 'function_call',
          call_id: `call-${step}`,
          name:
            step === 1
              ? operationToolName('knowledge.notebook-workspace.update')
              : step === 2
                ? 'knowledge_notebook_update'
                : 'knowledge_result',
          arguments: JSON.stringify(step === 1 ? { script } : { summary: 'Record labels.' }),
        },
      ],
    };
  });
  const native = {
    store: f.store,
    runtimeConfig: () => snapshot,
    dispatcher: { createResponses: createResponses as never },
    resolveGatewayProvider: () => ({
      id: 'fixture',
      displayName: 'Fake transport',
      adapterId: 'fixture',
      models: ['fixture-model'],
      baseUrl: null,
      apiKey: '',
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native' as const, chatCompletions: 'native' as const },
      modelMetadata: {
        'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
      },
    }),
  };
  f.dependencies.pin = (run) => {
    pinKnowledgeManagerExecution(native, run);
  };
  f.run.mockImplementation(async (run) => {
    const payload = JSON.parse(
      run.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    );
    const page = serializeUserAuthoredKnowledgePage(
      {
        id: 'labels',
        kind: 'preference',
        title: 'Labels',
        content: 'I prefer green labels.',
        sourceReferences: [payload.sources[0].reference],
        createdAt: '2026-10-18T00:00:00.000Z',
        updatedAt: '2026-10-18T00:00:00.000Z',
      },
      { kind: 'user', userId }
    );
    script = `cat > labels.md <<'PAGE'\n${page}\nPAGE\nprintf '\\n[Labels](labels.md)\\n' >> index.md`;
    return runKnowledgeManagerAgent(native, run);
  });
  return createResponses;
}

describe('User-private bounded Memory maintenance', () => {
  it('publishes an Agent candidate with explicit Source provenance and replays without another model run', async () => {
    const f = fixture();
    const provider = useFakeProvider(f);
    const result = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
    expect(result.outcome).toBe('published');
    const revision = f.notebook().readRevision(result.notebookRevision);
    expect(revision.files['labels.md']).toMatch(/review_state: ["']?delegated/);
    expect(revision.metadata.producer).toEqual({
      kind: 'agent',
      id: 'knowledge-manager',
      responsibleUserId: userId,
    });
    const turn = f.store.getTurnById(result.turnId);
    expect(f.store.getThread(turn.workspaceId, turn.threadId)).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: userId,
      entryPath: 'knowledge-manager',
    });
    expect(turn.internalExecution?.knowledge?.ownerScope).toEqual({ kind: 'user', userId });
    expect(await runUserMemoryMaintenanceCommand(f.dependencies, f.input)).toEqual(result);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(turn.internalExecution).toMatchObject({
      logicalModelId: 'km-model',
      contextStrategy: 'compaction',
      threshold: 32_000,
    });
  });
  it('retains the exact candidate when disabled and publishes only after an actual self human decision', async () => {
    const f = fixture(false);
    const result = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
    expect(result.outcome).toBe('review-required');
    expect(f.notebook().publishedRevision()).not.toBe(result.candidateRevision);
    const context = {
      ...f.dependencies,
      actor: f.input.requestActor,
      revalidate: (files: Readonly<Record<string, string>>, paths?: readonly string[]) =>
        readUserMemoryNotebookAdmission(
          { ...f.dependencies, actor: f.input.requestActor },
          files,
          paths
        ),
    };
    const selected = readUserMemoryProposal(context, result.proposalId!);
    expect(selected.proposal.changes?.map(({ path }) => path)).toEqual(['index.md', 'labels.md']);
    const preview = readUserMemoryProposalPreview(context, {
      proposalId: result.proposalId!,
      path: 'labels.md',
      offset: 0,
    });
    expect(preview.after).toContain('I prefer green labels.');
    const decision = {
      proposalId: result.proposalId!,
      requestId: randomUUID(),
      proposalDigest: selected.proposalDigest,
      baseRevision: selected.proposal.baseRevision,
      candidateRevision: selected.proposal.candidateRevision,
      decision: 'accepted' as const,
    };
    const accepted = await decideUserMemoryProposal(context, decision);
    expect(accepted.review.actor).toEqual({ kind: 'user', id: userId });
    expect(f.notebook().readRevision(accepted.notebookRevision!).metadata.producer.kind).toBe(
      'agent'
    );
    expect(await decideUserMemoryProposal(context, decision)).toEqual(accepted);
    expect(f.run).toHaveBeenCalledTimes(1);
    const published = f.notebook().readRevision(accepted.notebookRevision!);
    const work = f.store.getTurnById(result.turnId);
    const timeline = openAssistantTimeline(f.store, work.workspaceId, userId, 'Private Assistant');
    const access = {
      coreDb: f.coreDb,
      userDb: f.userDb,
      store: f.store,
      requestActor: f.input.requestActor,
      actor: { kind: 'user' as const, id: userId },
      outputThreadId: timeline.id,
    };
    try {
      const selection = await retrieveUserMemory({
        dataRoot: f.coreDb.dataRoot,
        workspaceId: work.workspaceId,
        access,
        caller: 'app-api',
        query: 'green labels',
      });
      expect(selection.selected.map(({ reference }) => reference.objectId)).toContain('labels');
      expect(
        resolveWorkspaceKnowledgeRetrievalPages({
          dataRoot: f.coreDb.dataRoot,
          workspaceId: work.workspaceId,
          access,
          caller: 'app-api',
          selection,
        })?.find(({ knowledgePageId }) => knowledgePageId === 'labels')?.content
      ).toBe(published.files['labels.md']);
      expect(published.files['labels.md']).toBe(preview.after);
      expect(published.files['labels.md']).toMatch(/review_state: ["']?accepted/);
    } finally {
      await closeRetrievalServices();
    }
  });

  it('withholds suppressed pages and Source versions from later model/editor inputs', async () => {
    const f = fixture();
    const first = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
    const content = f.notebook().readRevision(first.notebookRevision).files['labels.md']!;
    const navigationMarker = 'FORGOTTEN_NAVIGATION_MARKER';
    const humanRevision = f.notebook().prepare({
      baseRevision: first.notebookRevision,
      changes: { 'index.md': `---\nokf_version: "0.2"\n---\n# ${navigationMarker}\n` },
      metadata: {
        summary: 'Human navigation edit',
        producer: { kind: 'user', id: userId },
        authority: { kind: 'direct', instructionReference: 'human navigation edit' },
        sourceReferences: [],
        changeRequest: {
          requestId: randomUUID(),
          inputDigest: commandInputHash(navigationMarker),
        },
      },
    });
    f.notebook().publish({
      baseRevision: first.notebookRevision,
      candidateRevision: humanRevision,
    });
    const proposalContext = {
      ...f.dependencies,
      actor: f.input.requestActor,
      revalidate: (files: Readonly<Record<string, string>>, paths?: readonly string[]) =>
        readUserMemoryNotebookAdmission(
          { ...f.dependencies, actor: f.input.requestActor },
          files,
          paths
        ),
    };
    const pending = createUserMemoryProposal(
      proposalContext,
      {
        requestId: randomUUID(),
        baseRevision: humanRevision,
        changes: [
          {
            path: 'index.md',
            content: `---\nokf_version: "0.2"\n---\n# ${navigationMarker} candidate\n`,
          },
        ],
        summary: 'Pending navigation edit',
      },
      { kind: 'agent', id: 'knowledge-manager', responsibleUserId: userId },
      []
    );

    const refs = stringListFrontmatterField(
      parseOkfDocument({ path: 'labels.md', content }).document!,
      'source_refs'
    )!;
    const owner = resolveScopedNotebookOwner({
      coreDb: f.coreDb,
      actor: f.input.requestActor,
      target: { kind: 'user' },
    });
    appendMemorySuppression(owner.notebookRoot, {
      userId,
      requestId: randomUUID(),
      pageId: 'labels',
      lastRevision: first.notebookRevision,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      actorId: userId,
      sourceFingerprints: refs,
    });
    expect(() =>
      readUserMemoryProposalPreview(proposalContext, {
        proposalId: pending.id,
        path: 'index.md',
        offset: 0,
      })
    ).toThrow();
    const denied = await runUserMemoryMaintenanceCommand(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
      tellContent: undefined,
      sources: refs,
    });
    expect(denied.outcome).toBe('failed');
    expect(f.run).toHaveBeenCalledTimes(1);
    f.run.mockImplementationOnce(async (run) => {
      expect(JSON.stringify(run.messages)).not.toContain('I prefer green labels.');
      expect(JSON.stringify(run.messages)).not.toContain(navigationMarker);
      const prompt = JSON.parse((run.messages[0]!.content[0] as { text: string }).text);
      expect(prompt.overview).toEqual({ unavailable: true });
      const editor = run.tools.find((tool) => tool.name === 'knowledge.notebook-workspace.update')!;
      const read = await editor.execute(
        { script: 'cat labels.md; cat index.md' },
        { callId: randomUUID(), toolOccurrence: 1, signal: run.signal }
      );
      expect(JSON.stringify(read)).not.toContain('I prefer green labels.');
      await run.tools
        .find((tool) => tool.name === 'knowledge.notebook.update')!
        .execute(
          { summary: 'No changes.' },
          { callId: randomUUID(), toolOccurrence: 2, signal: run.signal }
        );
      f.store.updateTurn(run.turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      return { turnId: run.turn.id, text: 'No changes.' };
    });
    const next = await runUserMemoryMaintenanceCommand(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
      tellContent: undefined,
    });
    expect(next.outcome).toBe('no-change');
    expect(f.notebook().publishedRevision()).toBe(humanRevision);
  });

  it('checks current identity before native effects and never overwrites a newer notebook base', async () => {
    const f = fixture();
    const original = f.run.getMockImplementation()!;
    let current = '';
    f.run.mockImplementationOnce(async (run) => {
      const baseRevision = f.notebook().publishedRevision();
      current = f.notebook().prepare({
        baseRevision,
        changes: { 'index.md': '---\nokf_version: "0.2"\n---\n# New human edit\n' },
        metadata: {
          summary: 'Human edit',
          producer: { kind: 'user', id: userId },
          authority: { kind: 'direct', instructionReference: 'human edit' },
          sourceReferences: [],
          changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('human edit') },
        },
      });
      f.notebook().publish({ baseRevision, candidateRevision: current });
      return original(run);
    });
    expect((await runUserMemoryMaintenanceCommand(f.dependencies, f.input)).outcome).toBe('failed');
    expect(f.notebook().publishedRevision()).toBe(current);
    const nativeNotebook = f.notebook();
    f.run.mockImplementationOnce(async (run) => {
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, userId))();
      return original(run);
    });
    expect(
      (
        await runUserMemoryMaintenanceCommand(f.dependencies, {
          ...f.input,
          requestId: randomUUID(),
        })
      ).outcome
    ).toBe('failed');
    expect(nativeNotebook.publishedRevision()).toBe(current);
    await expect(
      runUserMemoryMaintenanceCommand(f.dependencies, { ...f.input, requestId: randomUUID() })
    ).rejects.toThrow('Scoped notebook access denied');
  });

  it('skips a disabled schedule without a model and replays its retained outcome', async () => {
    const f = fixture(false);
    const input = { ...f.input, trigger: 'schedule' as const };
    const result = await runUserMemoryMaintenanceCommand(f.dependencies, input);
    expect(result.outcome).toBe('skipped');
    expect(await runUserMemoryMaintenanceCommand(f.dependencies, input)).toEqual(result);
    expect(f.run).not.toHaveBeenCalled();
    const prepared = prepareUserMemoryMaintenance(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
    });
    const second = await runUserMemoryMaintenanceCommand(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
    });
    expect(second).toMatchObject({
      outcome: 'skipped',
      threadId: f.store.getTurnById(prepared.turnId).threadId,
    });
    prepared.fail();
  });
});
