import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentReferenceSchema } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument } from './okf.js';
import { listUserKnowledgeSources, readUserKnowledgeSource } from './scoped-knowledge-sources.js';
import { resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import { runUserMemoryMaintenanceCommand } from './user-memory-agent-maintenance.js';

it('reports native no-change through the recorded result and replay despite a misleading model summary', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-native-no-change-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  const store = new FsStore({ dataRoot });
  onTestFinished(() => {
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const misleadingSummary = 'Saved your preference to Memory: use green labels.';
  const noChangeSummary = 'No Memory page changes were published.';
  let baseRevision = '';
  let baseFiles: Readonly<Record<string, string>> = {};
  const notebook = () =>
    new KnowledgeNotebook({
      repositoryPath: join(
        resolveScopedNotebookOwner({ coreDb, actor, target: { kind: 'user' } }).notebookRoot,
        'notebook.git'
      ),
    });
  const run = vi.fn(async (input: KnowledgeManagerAgentRun) => {
    baseRevision = input.inputs!.baseRevision;
    baseFiles = notebook().readRevision(baseRevision).files;
    const edit = input.tools.find(({ name }) => name === 'knowledge.notebook-workspace.update')!;
    const submit = input.tools.find(({ name }) => name === 'knowledge.notebook.update')!;
    // The real editor receives no edits. A summary cannot itself become page content.
    const result = await submit.execute(
      { summary: misleadingSummary },
      {
        callId: randomUUID(),
        toolOccurrence: 1,
        signal: input.signal,
      }
    );
    expect(
      JSON.parse(
        result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      )
    ).toEqual({ outcome: 'no_change' });
    expect(input.validateResult(JSON.stringify({ summary: misleadingSummary }))).toBeUndefined();
    expect.soft(edit.description).not.toBe(submit.description);
    expect.soft(edit.description).toMatch(/script/i);
    expect.soft(submit.description).toMatch(/submit/i);
    expect.soft(submit.description).toMatch(/summary.*(?:not|never).*content/i);
    store.updateTurn(input.turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    return { turnId: input.turn.id, text: JSON.stringify({ summary: misleadingSummary }) };
  });
  const dependencies = {
    coreDb,
    userDb,
    store,
    runtimeConfigManager: {
      current: () => ({
        userConfigs: [
          {
            userId,
            config: { knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] } },
          },
        ],
      }),
    } as unknown as RuntimeConfigManager,
    openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: (input: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>) => {
      store.updateTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'fixture-model',
          contextStrategy: 'compaction',
          threshold: 1000,
          knowledge: input.inputs!,
        },
      });
    },
  };
  const input = {
    requestId: randomUUID(),
    requestActor: actor,
    trigger: 'request' as const,
    instructions: 'Remember my preference.',
    tellContent: 'I prefer green labels.\r\n  Preserve my exact wording. Ω 雪.\n',
    sources: [],
    signal: new AbortController().signal,
  };
  const result = await runUserMemoryMaintenanceCommand(dependencies, input);
  expect(result).toMatchObject({ outcome: 'no-change', notebookRevision: baseRevision });
  expect.soft(result.summary).toBe(noChangeSummary);
  expect(notebook().publishedRevision()).toBe(baseRevision);
  expect(notebook().readRevision(baseRevision).files).toEqual(baseFiles);
  expect(JSON.stringify(baseFiles)).not.toContain('I prefer green labels.');
  const sources = listUserKnowledgeSources({ coreDb, userDb, actor });
  expect(sources).toHaveLength(1);
  const source = sources[0]!;
  expect((await readUserKnowledgeSource({ coreDb, userDb, actor }, source.id))?.content).toBe(
    input.tellContent
  );
  // Capture commits the Source pointer before the editor base without publishing a Memory page.
  const captured = notebook().readRevision(baseRevision);
  expect(captured.parentRevision).not.toBeNull();
  expect(notebook().readRevision(captured.parentRevision!).files).toEqual(baseFiles);
  expect(notebook().readSourcePointers(captured.parentRevision!)).toEqual({});
  const pointers = notebook().readSourcePointers(baseRevision);
  expect(Object.keys(pointers)).toEqual([source.id]);
  const pointer = pointers[source.id]!;
  const parsed = parseOkfDocument({ path: `sources/${source.id}.md`, content: pointer });
  if (!parsed.ok) throw new Error('Expected a valid captured SourceSummary.');
  const original = Buffer.from(input.tellContent);
  const contentDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`;
  expect(parsed.document.frontmatter).toMatchObject({
    type: 'SourceSummary',
    scope: { kind: 'user', userId },
    byteLength: original.byteLength,
    captureChannel: 'knowledge.source.register',
  });
  const contentRef = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
  expect(contentRef).toMatchObject({
    contentDigest,
    locator: { ownerScope: { kind: 'user', userId }, mount: 'managed' },
    range: null,
    availability: 'available',
  });
  expect(source.contentDigest).toBe(contentDigest);
  const { notebookRoot } = resolveScopedNotebookOwner({ coreDb, actor, target: { kind: 'user' } });
  expect(readFileSync(join(notebookRoot, 'raw', contentRef.locator.path))).toEqual(original);
  expect(pointer).not.toContain(input.tellContent);
  expect(pointer).not.toContain(misleadingSummary);
  expect(JSON.stringify(baseFiles)).not.toContain(misleadingSummary);
  expect(captured.metadata).toMatchObject({
    producer: { kind: 'user', id: userId },
    changeRequest: { requestId: input.requestId },
    authority: {
      kind: 'direct',
      instructionReference: `knowledge.source.register:${input.requestId}`,
    },
  });
  const turn = store.getTurnById(result.turnId);
  const status = store
    .listThreadItems(turn.workspaceId, turn.threadId)
    .find((item) => item.knowledgeMaintenanceResult);
  expect.soft(status).toMatchObject({
    summary: noChangeSummary,
    knowledgeMaintenanceResult: { ...result, summary: noChangeSummary },
  });
  expect(await runUserMemoryMaintenanceCommand(dependencies, input)).toEqual(result);
  expect(run).toHaveBeenCalledTimes(1);
  expect(notebook().publishedRevision()).toBe(baseRevision);
  expect(listUserKnowledgeSources({ coreDb, userDb, actor })).toEqual(sources);
});
