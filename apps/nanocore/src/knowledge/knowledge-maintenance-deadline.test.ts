import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  type KnowledgeMaintenanceDependencies,
  maintainKnowledgeAgent,
} from './knowledge-agent-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';

it('accepts a real maintenance editor Tool after 150 seconds within the 300-second KM run', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-editor-deadline-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Editor deadline', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:maintenance-editor-deadline',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  const baseRevision = notebook.publishedRevision();
  const overview = notebook.readRevision(baseRevision).files['index.md']!;
  onTestFinished(() => {
    vi.useRealTimers();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  let editorResult: unknown;
  // Only the model wait is replaced; maintenance admission, editor and native outcome are real.
  const run = vi.fn(async (input: KnowledgeManagerAgentRun) => {
    vi.setSystemTime(Date.now() + 150_000);
    const execute = (name: string, value: unknown) =>
      input.tools
        .find((tool) => tool.name === name)!
        .execute(value, {
          callId: randomUUID(),
          toolOccurrence: 1,
          signal: input.signal,
        });
    const read = await execute('knowledge.notebook-workspace.update', {
      script: 'cat index.md',
    });
    editorResult = read;
    expect(read.isError).not.toBe(true);
    expect(
      JSON.parse(read.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''))
    ).toMatchObject({ exitCode: 0, stdout: overview, truncated: false });
    await execute('knowledge.notebook.update', { summary: 'The current overview is sufficient.' });
    expect(input.validateResult('{"summary":"No changes are needed."}')).toBeUndefined();
    store.updateTurn(input.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: input.turn.id, text: '{"summary":"No changes are needed."}' };
  });
  const dependencies: KnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager: {
      current: () => ({
        workspaceConfigs: [
          {
            workspaceId: workspace.id,
            config: {
              workspace: {
                knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
              },
            },
          },
        ],
      }),
    } as unknown as RuntimeConfigManager,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    pin: (input) => {
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
    run,
  };
  // Date alone measures the real editor's absolute deadline; its asynchronous I/O stays real.
  vi.useFakeTimers({ toFake: ['Date'] });
  const result = await maintainKnowledgeAgent(dependencies, {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    requestActor: { kind: 'local', userId },
    actor,
    trigger: 'request',
    instructions: 'Inspect the current overview and report whether it needs changes.',
    sources: [],
    signal: new AbortController().signal,
  });
  expect(editorResult).toBeDefined();
  expect(result.outcome).toBe('no-change');
  expect(run).toHaveBeenCalledTimes(1);
  expect(store.getTurnById(result.turnId).status).toBe('completed');
  expect(notebook.publishedRevision()).toBe(baseRevision);
  expect(notebook.readRevision(baseRevision).files['index.md']).toBe(overview);
  expect(
    store
      .getTurnById(result.turnId)
      .items.filter((item) => item.type === 'status' && item.knowledgeMaintenanceResult)
      .map((item) => item.knowledgeMaintenanceResult)
  ).toEqual([result]);
});
