import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { ServerKnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import {
  prepareServerKnowledgeMaintenance,
  runServerKnowledgeMaintenanceCommand,
  type ServerKnowledgeMaintenanceDependencies,
  serverNotebookAdmission,
} from './server-knowledge-maintenance.js';
import {
  decideServerNotebookProposal,
  readServerNotebookProposal,
} from './server-notebook-proposals.js';

/** Actual Server notebook, Core receipts, Thread records and publisher surround only a fake bounded role. */
function fixture(enabled: boolean) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-km-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  initializeScopedNotebook({
    coreDb,
    actor: requestActor,
    target: { kind: 'server' },
    initialization: { requestId: randomUUID(), instructionReference: 'fixture' },
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'server', 'knowledge', 'notebook.git'),
  });
  const original = notebook.publishedRevision();
  const human = notebook.prepare({
    baseRevision: original,
    changes: {
      'index.md':
        '---\nokf_version: "0.2"\n---\n# Human overview\n\nPreserve this human correction.\n',
    },
    metadata: {
      summary: 'Human correction',
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('human correction') },
      producer: actor,
      authority: { kind: 'direct', instructionReference: 'fixture' },
      sourceReferences: [],
    },
  });
  notebook.publish({ baseRevision: original, candidateRevision: human });
  const run = vi.fn(async (input: ServerKnowledgeManagerAgentRun) => {
    const payload = JSON.parse(
      input.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(
        ''
      )
    );
    expect(payload.sourceRange).toEqual([]);
    expect(payload.humanEdits.changes).toContainEqual(
      expect.objectContaining({ after: expect.stringContaining('Preserve this human correction.') })
    );
    expect(input.inputs).toMatchObject({
      ownerScope: { kind: 'server' },
      baseRevision: human,
      trigger: 'request',
      sourceRange: [],
    });
    expect('workspaceId' in input.turn).toBe(false);
    expect(input.tools.map((tool) => tool.name)).toEqual([
      'thread.history.read',
      'knowledge.notebook-workspace.update',
      'knowledge.notebook.update',
    ]);
    const execute = async (name: string, value: unknown) =>
      input.tools
        .find((tool) => tool.name === name)!
        .execute(value, { signal: input.signal, callId: randomUUID(), toolOccurrence: 1 });
    await execute('knowledge.notebook-workspace.update', {
      script: "printf '\\nThe explicit Server fact is BLUE-HERON-7.\\n' >> index.md",
    });
    await execute('knowledge.notebook.update', {
      summary: 'Keep the human overview and add the explicit fact.',
    });
    expect(input.validateResult(JSON.stringify({ summary: 'Finished.' }))).toBeUndefined();
    store.updateServerTurn(input.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: input.turn.id, text: '{"summary":"Finished."}' };
  });
  const dependencies: ServerKnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager: {
      current: () => ({
        openKitConfig: { knowledgeMaintenance: { enabled, reviewRequiredPageIds: [] } },
      }),
    } as unknown as RuntimeConfigManager,
    inflightCommands: new WeakMap(),
    pin: (input) => {
      store.updateServerTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'server-model',
          contextStrategy: 'compaction',
          threshold: 1000,
          knowledge: input.inputs!,
        },
      });
    },
    run,
  };
  const input = {
    requestId: randomUUID(),
    requestActor,
    actor,
    trigger: 'request' as const,
    instructions:
      'Integrate the explicit Server fact, preserve human edits, and keep the overview current.',
    sources: [],
    tellContent: 'The explicit Server fact is BLUE-HERON-7.',
    signal: new AbortController().signal,
  };
  return { dependencies, input, run, store, notebook, human, coreDb, requestActor };
}

it.each([
  true,
  false,
])('keeps Server maintenance off Workspace storage, preserves human inputs and uses delegation=%s or exact review', async (enabled) => {
  const f = fixture(enabled);
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input);
  expect(result.outcome).toBe(enabled ? 'published' : 'review-required');
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input)).toEqual(result);
  expect(f.run).toHaveBeenCalledTimes(1);
  const turn = f.store.getServerTurnById(result.turnId);
  expect(turn).toMatchObject({
    owner: { kind: 'server' },
    internalExecution: {
      roleId: 'knowledge-manager',
      logicalModelId: 'server-model',
      contextStrategy: 'compaction',
      knowledge: { baseRevision: f.human, ownerScope: { kind: 'server' } },
    },
  });
  expect(f.store.listWorkspaces()).toEqual([]);
  if (!enabled) {
    expect(f.notebook.publishedRevision()).toBe(f.human);
    const context = {
      ...f.dependencies,
      actor: f.requestActor,
      revalidate: () => serverNotebookAdmission(f.dependencies, f.requestActor),
    };
    const candidate = readServerNotebookProposal(context, result.proposalId!);
    expect(candidate.diff[0]!.after).toContain('Preserve this human correction.');
    const decision = await decideServerNotebookProposal(context, {
      proposalId: result.proposalId!,
      requestId: randomUUID(),
      proposalDigest: candidate.proposalDigest,
      baseRevision: candidate.proposal.baseRevision,
      candidateRevision: candidate.proposal.candidateRevision,
      decision: 'accepted',
    });
    expect(decision.notebookRevision).toBe(candidate.proposal.candidateRevision);
  }
  const files = f.notebook.readRevision(f.notebook.publishedRevision()).files;
  expect(files['index.md']).toContain('Preserve this human correction.');
  expect(files['index.md']).toContain('BLUE-HERON-7');
});

it('retains skipped active-writer and missing-authority schedule outcomes without a model call', async () => {
  const f = fixture(true);
  const thread = f.store.createServerThread('Server Knowledge maintenance');
  const active = f.store.createServerTurn(thread.id, 'Active run', f.input.actor, null, {
    agentId: 'knowledge-manager',
  });
  const skipped = await prepareServerKnowledgeMaintenance(f.dependencies, {
    ...f.input,
    trigger: 'schedule',
  }).execute();
  expect(skipped.outcome).toBe('skipped');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.store.getServerTurnById(active.id).status).toBe('running');
  f.store.updateServerTurn(active.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: { code: 'recovery_required', message: 'Interrupted run.' },
  });
  const failed = await prepareServerKnowledgeMaintenance(f.dependencies, {
    ...f.input,
    requestActor: undefined,
    trigger: 'schedule',
  }).execute();
  expect(failed.outcome).toBe('failed');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.store.getServerTurnById(failed.turnId).items).toContainEqual(
    expect.objectContaining({ type: 'status', knowledgeMaintenanceResult: failed })
  );
});
