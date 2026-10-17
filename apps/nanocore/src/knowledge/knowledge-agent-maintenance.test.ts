import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { readInternalContextEvidence } from '../internal-agents/internal-context-evidence.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { internalContextSourceDigest } from '../internal-agents/rolling-context.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  type KnowledgeMaintenanceDependencies,
  maintainKnowledgeAgent,
  prepareKnowledgeMaintenance,
} from './knowledge-agent-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';

/** Actual owners and virtual Tools surround a fake role runner; no provider or retrieval process is needed. */
function fixture(enabled = true, protectedPages: string[] = []) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'knowledge-maintenance-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const workspace = store.createWorkspace('Maintenance fixture', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'fixture',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: actor.id });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  const baseRevision = notebook.publishedRevision();
  const humanRevision = notebook.prepare({
    baseRevision,
    changes: { 'index.md': '---\nokf_version: "0.2"\n---\n# Human correction\n' },
    metadata: {
      summary: 'Human correction',
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('human edit') },
      producer: actor,
      authority: { kind: 'direct', instructionReference: 'fixture-human' },
      sourceReferences: [],
    },
  });
  notebook.publish({ baseRevision, candidateRevision: humanRevision });
  const ordinary = store.createThread(workspace.id, 'Ordinary shared work');
  const ordinaryTurn = store.createTurn(
    workspace.id,
    ordinary.id,
    'Explicit human expression',
    actor,
    null
  );
  const timestamp = new Date().toISOString();
  store.createItem({
    id: allocateEntityId('it'),
    workspaceId: workspace.id,
    threadId: ordinary.id,
    turnId: ordinaryTurn.id,
    type: 'user-message',
    actor,
    text: 'The project uses green labels.',
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  });
  store.updateTurn(ordinaryTurn.id, {
    status: 'completed',
    completedAt: timestamp,
    internalExecution: {
      roleId: 'assistant',
      logicalModelId: 'ordinary-model',
      contextStrategy: 'rolling',
      threshold: 1000,
    },
  });
  const run = vi.fn(async (input: KnowledgeManagerAgentRun) => {
    const payload = JSON.parse(
      input.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(
        ''
      )
    );
    const history = input.tools.find((tool) => tool.name === 'thread.history.read')!;
    expect(history).toBeDefined();
    const foreignItems = store.getTurnById(ordinaryTurn.id).items;
    expect(
      await history.execute(
        {
          range: {
            threadId: ordinary.id,
            firstItemId: foreignItems[0]!.id,
            lastItemId: foreignItems[0]!.id,
            sourceDigest: internalContextSourceDigest(store, foreignItems, 'compaction'),
          },
          limit: 5,
        },
        { callId: randomUUID(), toolOccurrence: 1, signal: input.signal }
      )
    ).toMatchObject({ isError: true });
    expect(input.readEvidence([])).toBe(
      readInternalContextEvidence({
        store,
        coreDb,
        workspaceId: workspace.id,
        threadId: input.turn.threadId,
        nativeAuthority: { actorRef: actor, assertCurrent: input.assertCurrent },
        items: [],
        strategy: 'compaction',
      })
    );
    const ref = payload.sources[0].reference;
    const page = `---\ntype: KnowledgePage\ntitle: Labels\nschema_version: openkit-scope-knowledge-schema-v4\nrequiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]\nopenkit_status: active\nstatus: stable\nscope: {kind: workspace, workspaceId: ${workspace.id}}\nsource_refs: [${JSON.stringify(ref)}]\nreview_state: user-authored\nsensitivity: normal\nfreshness: current\ncreated_at: "2026-10-17T00:00:00.000Z"\nupdated_at: "2026-10-17T00:00:00.000Z"\n---\nThe project uses green labels.\n`;
    const execute = async (name: string, args: unknown) =>
      input.tools
        .find((tool) => tool.name === name)!
        .execute(args, { callId: randomUUID(), toolOccurrence: 1, signal: input.signal });
    await execute('knowledge.notebook-workspace.update', {
      script: `cat > labels.md <<'PAGE'\n${page}PAGE\nprintf '\\n[Labels](labels.md)\\n' >> index.md`,
    });
    await execute('knowledge.notebook.update', { summary: 'Record labels' });
    input.validateResult('Done.');
    store.updateTurn(input.turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    return { turnId: input.turn.id, text: 'Done.' };
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
                knowledgeMaintenance: { enabled, reviewRequiredPageIds: protectedPages },
              },
            },
          },
        ],
      }),
    } as unknown as RuntimeConfigManager,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: (input) => {
      store.updateTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'test-role-model',
          contextStrategy: 'compaction',
          threshold: 1000,
          knowledge: input.inputs!,
        },
      });
    },
  };
  const input = {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    requestActor: { kind: 'local', userId: actor.id } as const,
    actor,
    trigger: 'request' as const,
    instructions: 'Organize the notebook and retain current human edits.',
    sources: [],
    signal: new AbortController().signal,
  };
  return { dependencies, input, notebook, humanRevision, ordinaryTurn, run, store, workspace };
}

describe('Workspace Knowledge Manager maintenance admission', () => {
  it('publishes through the existing owner with exact human edits and selected ordinary expressions as inputs', async () => {
    const f = fixture();
    const own = f.store.createTurn(
      f.workspace.id,
      f.ordinaryTurn.threadId,
      'Prior KM input',
      f.input.actor,
      null
    );
    const timestamp = new Date().toISOString();
    f.store.createItem({
      id: allocateEntityId('it'),
      workspaceId: f.workspace.id,
      threadId: own.threadId,
      turnId: own.id,
      type: 'user-message',
      actor: f.input.actor,
      text: 'A prior KM run must not become learning input.',
      status: 'completed',
      createdAt: timestamp,
      completedAt: timestamp,
    });
    f.store.updateTurn(own.id, {
      status: 'completed',
      completedAt: timestamp,
      internalExecution: {
        roleId: 'knowledge-manager',
        logicalModelId: 'km-model',
        contextStrategy: 'compaction',
        threshold: 1000,
      },
    });
    const result = await maintainKnowledgeAgent(f.dependencies, {
      ...f.input,
      pageIds: ['index'],
      tellContent: '€'.repeat(22000),
      askingThreadId: f.ordinaryTurn.threadId,
      askingTurnId: f.ordinaryTurn.id,
    });
    expect(result.outcome).toBe('published');
    const current = f.notebook.readRevision(result.notebookRevision);
    expect(current.parentRevision).toBe(f.humanRevision);
    expect(current.files['index.md']).toContain('# Human correction');
    expect(current.files['labels.md']).toContain('review_state: delegated');
    expect(current.metadata.producer).toEqual({
      kind: 'agent',
      id: 'knowledge-manager',
      responsibleUserId: f.input.actor.id,
    });
    const run = f.run.mock.calls[0]![0];
    expect(run.inputs?.sourceRange.map((range) => range.turnId)).toEqual([f.ordinaryTurn.id]);
    const payload = JSON.parse(
      run.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    );
    expect(payload.selectedPageIds).toEqual(['index']);
    expect(
      payload.humanEdits.changes.some((change: { after: string }) =>
        change.after?.includes('# Human correction')
      )
    ).toBe(true);
    expect(payload.sources[0].content).toContain('The project uses green labels.');
    expect(
      payload.sources.reduce(
        (size: number, source: { content: string }) => size + Buffer.byteLength(source.content),
        0
      )
    ).toBeLessThanOrEqual(64 * 1024);
    expect(payload.sources[1].content).not.toContain('�');
    expect(payload.sources[1].truncated).toBe(true);
    expect(f.store.getTurnById(result.turnId).status).toBe('completed');
    expect(
      f.store
        .getTurnById(result.turnId)
        .items.flatMap((item) =>
          item.type === 'status' && item.knowledgeMaintenanceResult
            ? [item.knowledgeMaintenanceResult]
            : []
        )[0]
    ).toEqual(result);
  });
  it('includes a human page removal outside the active editing snapshot', async () => {
    const f = fixture();
    const content = `---
 type: KnowledgePage
 title: Removed lesson
 schema_version: openkit-scope-knowledge-schema-v4
 requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
 openkit_status: active
 status: stable
 scope: {kind: workspace, workspaceId: ${f.workspace.id}}
 source_refs: []
 review_state: user-authored
 sensitivity: normal
 freshness: current
 created_at: "2026-10-17T00:00:00.000Z"
 updated_at: "2026-10-17T00:00:00.000Z"
---
An obsolete human lesson.
`.replace(/^ /gm, '');
    const publish = (changes: Record<string, string | null>) => {
      const baseRevision = f.notebook.publishedRevision();
      const candidateRevision = f.notebook.prepare({
        baseRevision,
        changes,
        metadata: {
          summary: 'Human correction',
          producer: f.input.actor,
          changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(changes) },
          authority: { kind: 'direct', instructionReference: 'human correction' },
          sourceReferences: [],
        },
      });
      f.notebook.publish({ baseRevision, candidateRevision });
    };
    publish({ 'obsolete.md': content });
    publish({ 'obsolete.md': null });
    const result = await maintainKnowledgeAgent(f.dependencies, f.input);
    expect(result.outcome).toBe('published');
    const run = f.run.mock.calls[0]![0];
    const payload = JSON.parse(
      run.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    );
    expect(payload.humanEdits.changes).toContainEqual({
      path: 'obsolete.md',
      before: content,
      after: null,
    });
    expect(payload.files).not.toContain('obsolete.md');
  });
  it('retains the settled native result before a later provider failure', async () => {
    const f = fixture();
    const execute = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (run) => {
      await execute({ ...run, validateResult: () => {} });
      const current = f.store.getTurnById(run.turn.id);
      expect(
        current.items.filter((item) => item.type === 'status' && item.knowledgeMaintenanceResult)
      ).toHaveLength(1);
      throw new Error('Late provider failure.');
    });
    const result = await maintainKnowledgeAgent(f.dependencies, f.input);
    expect(result.outcome).toBe('published');
    const current = f.store.getTurnById(result.turnId);
    expect(
      current.items.filter((item) => item.type === 'status' && item.knowledgeMaintenanceResult)
    ).toHaveLength(1);
    expect(
      current.items.find((item) => item.type === 'status')?.knowledgeMaintenanceResult
    ).toEqual(result);
  });
  it('saves the exact multi-page Proposal when publication is not delegated', async () => {
    const f = fixture(false);
    const result = await maintainKnowledgeAgent(f.dependencies, f.input);
    expect(result.outcome).toBe('review-required');
    expect(f.notebook.publishedRevision()).toBe(f.humanRevision);
    const proposal = f.store.projectKnowledgeProposalDraft(f.workspace.id, result.proposalId!);
    expect(proposal.candidateRevision).toBe(result.candidateRevision);
    expect(proposal.changes?.map((change) => change.path)).toEqual(['index.md', 'labels.md']);
    expect(f.notebook.readRevision(result.candidateRevision!).files['labels.md']).toContain(
      'review_state: delegated'
    );
  });
  it('pins scheduled work before provider execution, skips another writer and records failed work without processing its range', async () => {
    const f = fixture();
    const prepared = prepareKnowledgeMaintenance(f.dependencies, {
      ...f.input,
      trigger: 'schedule',
    });
    expect(f.run).not.toHaveBeenCalled();
    const retained = f.store.getTurnById(prepared.turnId);
    expect(retained.internalExecution?.knowledge).toMatchObject({
      purpose: 'maintenance',
      trigger: 'schedule',
      baseRevision: f.humanRevision,
    });
    const skipped = await maintainKnowledgeAgent(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
    });
    expect(skipped).toMatchObject({ outcome: 'skipped', threadId: retained.threadId });
    expect(f.run).not.toHaveBeenCalled();
    prepared.fail();
    expect(f.store.getTurnById(retained.id).status).toBe('failed');
    f.run.mockRejectedValueOnce(new Error('Synthetic provider failure.'));
    const failed = await maintainKnowledgeAgent(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
    });
    expect(failed.outcome).toBe('failed');
    expect(f.store.getTurnById(failed.turnId).status).toBe('failed');
    expect(
      f.store
        .getTurnById(failed.turnId)
        .internalExecution?.knowledge?.sourceRange.map((range) => range.turnId)
    ).toEqual([f.ordinaryTurn.id]);
    expect(f.notebook.publishedRevision()).toBe(f.humanRevision);
  });
  it('reuses the scheduled maintenance Thread after model admission failed before pinning', async () => {
    const f = fixture();
    vi.spyOn(f.dependencies, 'pin').mockImplementationOnce(() => {
      throw new Error('Synthetic unavailable model.');
    });
    const unavailable = prepareKnowledgeMaintenance(f.dependencies, {
      ...f.input,
      trigger: 'schedule',
    });
    const failed = await unavailable.execute();
    expect(failed.outcome).toBe('failed');
    expect(
      f.store
        .getTurnById(unavailable.turnId)
        .items.flatMap((item) =>
          item.type === 'status' && item.knowledgeMaintenanceResult
            ? [item.knowledgeMaintenanceResult]
            : []
        )[0]
    ).toEqual(failed);
    expect(f.store.getTurnById(unavailable.turnId).internalExecution).toBeUndefined();
    expect(f.store.getTurnById(unavailable.turnId).triggerSource).toEqual({
      kind: 'automation',
      summary: 'Knowledge Manager scheduled maintenance.',
    });
    const next = prepareKnowledgeMaintenance(f.dependencies, {
      ...f.input,
      requestId: randomUUID(),
    });
    expect(f.store.getTurnById(next.turnId).threadId).toBe(failed.threadId);
    expect(f.run).not.toHaveBeenCalled();
    next.fail();
  });
});
