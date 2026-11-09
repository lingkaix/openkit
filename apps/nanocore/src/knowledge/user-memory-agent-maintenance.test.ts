import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { formatReferenceUri, workspaceIdForOwner } from '@openkit/protocol';
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
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { ControlStoreWorkerError } from '../storage/control-store-worker-error.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveUserMemory,
} from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';

import { appendMemorySuppression } from './memory-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import {
  attributedNotebookPageBytes,
  parseOkfDocument,
  stringListFrontmatterField,
} from './okf.js';
import { pinScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
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
/** Retained DIAG-MEM script structure with only synthetic owner and Source fixture pins. */
function retainedMemoryScript(sourceReference: string): string {
  return `mkdir -p /notebook/sources /notebook/claims && cat > /notebook/sources/km16-color-preference.md << 'EOF'
---
type: SourceSummary
title: Synthetic KM16 color-code preference
schema_version: "openkit-scope-knowledge-schema-v4"
openkit_status: active
scope:
  kind: user
  userId: "${userId}"
requiredFeatures:
  - "openkit.knowledge-owner-scope.v1"
  - "openkit.knowledge-git-notebook.v1"
source_refs:
  - "${sourceReference}"
review_state: unreviewed
sensitivity: confidential
freshness: current
created_at: "2026-04-09T00:00:00Z"
updated_at: "2026-04-09T00:00:00Z"
---

# Synthetic KM16 color-code preference

The admitted source asks that a personal preference be remembered: the synthetic KM16 test color code is ORCHID-TEAL-42. The source states that this is synthetic test data.

Original text remains in the admitted Source and is not rewritten here.
EOF
cat > /notebook/claims/km16-color-code.md << 'EOF'
---
type: Claim
title: Synthetic KM16 test color code
schema_version: "openkit-scope-knowledge-schema-v4"
openkit_status: active
scope:
  kind: user
  userId: "${userId}"
requiredFeatures:
  - "openkit.knowledge-owner-scope.v1"
  - "openkit.knowledge-git-notebook.v1"
source_refs:
  - "${sourceReference}"
review_state: unreviewed
sensitivity: confidential
freshness: current
confidence: 1
created_at: "2026-04-09T00:00:00Z"
updated_at: "2026-04-09T00:00:00Z"
---

# Synthetic KM16 test color code

The user asked that this personal preference be remembered: the synthetic KM16 test color code is ORCHID-TEAL-42. The source identifies the value as synthetic test data.

See [source summary](../sources/km16-color-preference.md).
EOF
cat > /notebook/index.md << 'EOF'
---
okf_version: "0.2"
type: Index
title: Notebook
schema_version: "openkit-scope-knowledge-schema-v4"
openkit_status: active
scope:
  kind: user
  userId: "${userId}"
requiredFeatures:
  - "openkit.knowledge-owner-scope.v1"
  - "openkit.knowledge-git-notebook.v1"
source_refs:
  - "${sourceReference}"
review_state: unreviewed
sensitivity: confidential
freshness: current
created_at: "2026-04-09T00:00:00Z"
updated_at: "2026-04-09T00:00:00Z"
---

# Notebook

Personal memory for this user scope.

## Contents

- [Synthetic KM16 test color code](claims/km16-color-code.md) — remembered preference: ORCHID-TEAL-42 (synthetic test data).
- [Source summary](sources/km16-color-preference.md) — short synthesis of the admitted source.
EOF`;
}

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
    const page = serializeKnowledgePageFixture(
      {
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
    await store.updateTurn(run.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
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
    pin: async (run: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>) => {
      await store.updateTurn(run.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'fixture-model',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
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
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
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
  f.dependencies.pin = async (run) => {
    await pinKnowledgeManagerExecution(native, run);
  };
  f.run.mockImplementation(async (run) => {
    const payload = JSON.parse(
      run.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    );
    const page = serializeKnowledgePageFixture(
      {
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
  it.each([
    'unpinned',
    'pinned',
    'candidate-pinned',
    'foreign-scope',
    'wrong-pin',
    'missing-target',
    'suppressed-target',
  ] as const)(
    'admits only exact unsuppressed User page citations through maintenance publication: %s',
    async (kind) => {
      const f = fixture();
      const first = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
      expect(first.outcome).toBe('published');
      const target = f.notebook().readRevision(first.notebookRevision).files['labels.md']!;
      const context = { ...f.dependencies, actor: f.input.requestActor };
      const pin = pinScopedNotebook({ ...context, target: { kind: 'user' } });
      const authoredTarget = attributedNotebookPageBytes(
        'labels.md',
        target.replace('I prefer green labels.', 'I prefer updated green labels.'),
        { kind: 'user', userId },
        'user-authored'
      );
      const selectedTarget =
        kind === 'candidate-pinned'
          ? attributedNotebookPageBytes(
              'labels.md',
              authoredTarget,
              { kind: 'user', userId },
              'delegated'
            )
          : target;
      const reference = formatReferenceUri(
        {
          scopeId:
            kind === 'foreign-scope'
              ? `page/server/${pin.knowledgeBaseId}`
              : `page/user/${userId}/${pin.knowledgeBaseId}`,
          objectId: kind === 'missing-target' ? 'missing' : 'labels',
        },
        kind === 'pinned' || kind === 'candidate-pinned'
          ? `sha256:${createHash('sha256').update(selectedTarget).digest('hex')}`
          : kind === 'wrong-pin'
            ? `sha256:${'0'.repeat(64)}`
            : undefined
      );
      if (kind === 'suppressed-target') {
        const owner = resolveScopedNotebookOwner({ ...context, target: { kind: 'user' } });
        appendMemorySuppression(owner.notebookRoot, {
          userId,
          requestId: randomUUID(),
          pageId: 'labels',
          lastRevision: first.notebookRevision,
          digest: `sha256:${createHash('sha256').update(target).digest('hex')}`,
          actorId: userId,
          sourceFingerprints: [],
        });
      }
      const citing = serializeKnowledgePageFixture(
        {
          title: 'Citing',
          content: 'Compare saved labels.',
          sourceReferences: [reference],
          createdAt: '2026-10-18T00:00:00Z',
          updatedAt: '2026-10-18T00:00:00Z',
        },
        { kind: 'user', userId }
      );
      f.run.mockImplementationOnce(async (run) => {
        const script = `${kind === 'candidate-pinned' ? `cat > labels.md <<'TARGET'\n${authoredTarget}TARGET\n` : ''}cat > citing.md <<'PAGE'\n${citing}\nPAGE`;
        for (const [name, args] of [
          ['knowledge.notebook-workspace.update', { script }],
          ['knowledge.notebook.update', { summary: 'Compare admitted User page bytes.' }],
        ] as const) {
          await run.tools
            .find((tool) => tool.name === name)!
            .execute(args, {
              callId: randomUUID(),
              toolOccurrence: 1,
              signal: run.signal,
            });
        }
        await f.store.updateTurn(run.turn.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        return { turnId: run.turn.id, text: '{"summary":"Finished."}' };
      });
      const result = await runUserMemoryMaintenanceCommand(f.dependencies, {
        ...f.input,
        requestId: randomUUID(),
        tellContent: undefined,
      });
      const allowed = kind === 'unpinned' || kind === 'pinned' || kind === 'candidate-pinned';
      expect(result.outcome).toBe(allowed ? 'published' : 'failed');
      if (allowed) {
        const files = f.notebook().readRevision(result.notebookRevision).files;
        expect(files['citing.md']).toContain(reference);
        expect(files['labels.md']).toBe(selectedTarget);
        const admission = readUserMemoryNotebookAdmission(context, files);
        expect(admission.pageScopeId).toBe(`page/user/${userId}/${pin.knowledgeBaseId}`);
        expect(admission.resolvedReferences.get('citing')?.has(reference)).toBe(true);
        f.run.mockImplementationOnce(async (run) => {
          await run.tools
            .find((tool) => tool.name === 'knowledge.notebook.update')!
            .execute(
              { summary: 'Inspect the selected citing page without edits.' },
              { callId: randomUUID(), toolOccurrence: 1, signal: run.signal }
            );
          await f.store.updateTurn(run.turn.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
          });
          return { turnId: run.turn.id, text: '{"summary":"Finished."}' };
        });
        const inspected = await runUserMemoryMaintenanceCommand(f.dependencies, {
          ...f.input,
          requestId: randomUUID(),
          tellContent: undefined,
          pageIds: ['citing'],
        });
        expect(inspected.outcome).toBe('no-change');
        expect(f.run).toHaveBeenCalledTimes(3);
      } else {
        expect(f.notebook().publishedRevision()).toBe(first.notebookRevision);
      }
    }
  );

  // DIAG-MEM retained publication regression and its frontmatter-only success control.
  it.each(['exact', 'no-index-refs', 'frontmatter-only'] as const)(
    'retains strict publication validation and safe author feedback for %s retained script',
    async (mode) => {
      const f = fixture();
      let script = '';
      let feedback: unknown;
      let baseRevision: string | undefined;
      f.run.mockImplementation(async (run) => {
        const payload = JSON.parse(
          run.messages[0]!.content.flatMap((part) =>
            part.type === 'text' ? [part.text] : []
          ).join('')
        );
        script = retainedMemoryScript(payload.sources[0].reference);
        const indexOffset = script.indexOf('cat > /notebook/index.md');
        if (mode === 'no-index-refs')
          script =
            script.slice(0, indexOffset) +
            script.slice(indexOffset).replace(/source_refs:\n {2}- .*\n/, '');
        if (mode === 'frontmatter-only')
          script =
            script.slice(0, indexOffset) +
            script
              .slice(indexOffset)
              .replace(/\n---\n[\s\S]*?\n---\n/, '\n---\nokf_version: "0.2"\n---\n');
        baseRevision = f.notebook().publishedRevision();
        const execute = (name: string, value: unknown) =>
          run.tools
            .find((tool) => tool.name === name)!
            .execute(value, {
              callId: randomUUID(),
              toolOccurrence: 1,
              signal: run.signal,
            });
        await execute('knowledge.notebook-workspace.update', { script });
        feedback = await execute('knowledge.notebook.update', {
          summary: 'Record synthetic preference.',
        });
        await f.store.updateTurn(run.turn.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        return { turnId: run.turn.id, text: 'Done.' };
      });
      const result = await runUserMemoryMaintenanceCommand(f.dependencies, {
        ...f.input,
        tellContent: 'Remember the synthetic color code ORCHID-TEAL-42.',
      });
      if (mode !== 'frontmatter-only') {
        expect(result.outcome).toBe('failed');
        expect(f.notebook().publishedRevision()).toBe(baseRevision);
        expect(Object.keys(f.notebook().readRevision(baseRevision!).files)).toEqual(['index.md']);
        // S63 final-tree validation and MEM-1: only closed native codes reach the author.
        expect(feedback).toMatchObject({ isError: true });
        const text = (feedback as { content: Array<{ type: string; text?: string }> }).content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('');
        expect(JSON.parse(text)).toEqual({
          code: 'invalid_request',
          diagnostics: ['okf.invalid_index_frontmatter'],
        });
        expect(text).not.toContain('ORCHID-TEAL-42');
        expect(text).not.toContain(userId);
        expect(text).not.toContain(f.coreDb.dataRoot);
        return;
      }
      expect(result.outcome).toBe('published');
      if (result.outcome !== 'published') return;
      const published = f.notebook().readRevision(result.notebookRevision);
      expect(Object.keys(published.files).sort()).toEqual([
        'claims/km16-color-code.md',
        'index.md',
        'sources/km16-color-preference.md',
      ]);
      // Only index frontmatter was corrected; both concepts and the complete overview body survive.
      for (const match of script.matchAll(/cat > \/notebook\/([^ ]+) << 'EOF'\n([\s\S]*?)\nEOF/g)) {
        const path = match[1]!;
        const authored = `${match[2]}\n`;
        expect(parseOkfDocument({ path, content: published.files[path]! }).document?.body).toBe(
          parseOkfDocument({ path, content: authored }).document?.body
        );
      }
      expect(published.files['index.md']).toMatch(/^---\nokf_version: "0\.2"\n---\n/);
      expect(published.metadata.sourceReferences).toHaveLength(1);
    }
  );

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
    expect(f.store.getThread(workspaceIdForOwner(turn.owner), turn.threadId)).toMatchObject({
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
    const timeline = await openAssistantTimeline(
      f.store,
      workspaceIdForOwner(work.owner),
      userId,
      'Private Assistant'
    );
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
        workspaceId: workspaceIdForOwner(work.owner),
        access,
        caller: 'app-api',
        query: 'green labels',
      });
      expect(selection.selected.map(({ reference }) => reference.objectId)).toContain('labels');
      expect(
        resolveWorkspaceKnowledgeRetrievalPages({
          dataRoot: f.coreDb.dataRoot,
          workspaceId: workspaceIdForOwner(work.owner),
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
      await f.store.updateTurn(run.turn.id, {
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
    const humanFiles = nativeNotebook.readRevision(current).files;
    let capturedBase = '';
    let capturedAuditCount = 0;
    const auditCount = () =>
      (
        f.userDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as {
          count: number;
        }
      ).count;
    f.run.mockImplementationOnce(async (run) => {
      // The new Source is captured under valid self authority before this revocation.
      capturedBase = nativeNotebook.publishedRevision();
      expect(run.inputs!.baseRevision).toBe(capturedBase);
      expect(nativeNotebook.readRevision(capturedBase).files).toEqual(humanFiles);
      capturedAuditCount = auditCount();
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
    expect(capturedBase).not.toBe('');
    expect(nativeNotebook.publishedRevision()).toBe(capturedBase);
    expect(nativeNotebook.readRevision(capturedBase).files).toEqual(humanFiles);
    expect(auditCount()).toBe(capturedAuditCount);
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
    const prepared = await prepareUserMemoryMaintenance(f.dependencies, {
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
    await prepared.fail();
  });
});

// S61:220-222: retries inspect reached evidence; they do not fill a missing decision Audit.
it.each(['rejected', 'deferred'] as const)(
  'refuses User %s replay after reached Audit failure and preserves successful decision replay',
  async (decision) => {
    const { readFileSync } = await import('node:fs');
    const { createOperationInvocation } = await import('../operation-composition.js');
    const f = fixture(false);
    const pending = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
    expect(pending.outcome).toBe('review-required');
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
    const selected = readUserMemoryProposal(context, pending.proposalId!);
    const proposal = selected.proposal;
    const baseRevision = f.notebook().publishedRevision();
    const request = {
      requestId: randomUUID(),
      proposalId: proposal.id,
      proposalDigest: selected.proposalDigest,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      decision,
    };
    const invoke = createOperationInvocation(f.dependencies);
    const human = {
      kind: 'public' as const,
      actor: f.input.requestActor,
      delivery: 'human' as const,
    };
    const auditRows = (proposalId: string, requestId: string) =>
      f.userDb.sqlite
        .prepare(
          'SELECT * FROM audit_events WHERE workspace_id IS NULL AND request_id = ? AND action = ? AND resource = ? LIMIT 2'
        )
        .all(requestId, 'knowledge.proposal.decide', `knowledge-proposal:${proposalId}`);
    expect(auditRows(proposal.id, request.requestId)).toEqual([]);
    // The public Memory owner opens its own User handle; this isolated trigger faults that real INSERT.
    f.userDb.sqlite.exec(
      "CREATE TRIGGER refuse_proposal_decision_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.proposal.decide' BEGIN SELECT RAISE(ABORT, 'injected decision audit persistence failure'); END"
    );
    try {
      const failedDecision = invoke('memory.proposal.decide', request, human);
      await expect(failedDecision).rejects.toBeInstanceOf(ControlStoreWorkerError);
      await expect(failedDecision).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
        message: 'Control database writer operation failed.',
      });
    } finally {
      f.userDb.sqlite.exec('DROP TRIGGER refuse_proposal_decision_audit');
    }
    // The new public handle must have reached Review retention before the intended SQL refusal.
    const afterFailure = readUserMemoryProposal(context, proposal.id);
    expect(afterFailure.reviews).toHaveLength(1);
    expect(afterFailure.reviews[0]).toMatchObject({ requestId: request.requestId, decision });
    expect(auditRows(proposal.id, request.requestId)).toEqual([]);
    expect(f.notebook().publishedRevision()).toBe(baseRevision);
    expect(f.notebook().retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
    const root = resolveScopedNotebookOwner({
      coreDb: f.coreDb,
      actor: f.input.requestActor,
      target: { kind: 'user' },
    }).notebookRoot;
    const reviewPath = join(root, 'reviews', `${proposal.id}.json`);
    const proposalPath = join(root, 'proposals', `${proposal.id}.md`);
    const retainedReviewBytes = readFileSync(reviewPath, 'utf8');
    const retainedProposalBytes = readFileSync(proposalPath, 'utf8');
    await expect
      .soft(invoke('memory.proposal.decide', request, human))
      .rejects.toMatchObject({ code: 'recovery_required' });
    expect(auditRows(proposal.id, request.requestId)).toEqual([]);
    expect(readFileSync(reviewPath, 'utf8')).toBe(retainedReviewBytes);
    expect(readFileSync(proposalPath, 'utf8')).toBe(retainedProposalBytes);
    expect(readUserMemoryProposal(context, proposal.id).reviews).toEqual(afterFailure.reviews);
    expect(f.notebook().publishedRevision()).toBe(baseRevision);
    expect(f.notebook().retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
    // A separate lawful request proves restored persistence and successful nonaccepted replay remain valid.
    const control = await createUserMemoryProposal(
      context,
      {
        requestId: randomUUID(),
        baseRevision,
        summary: 'Retain a complete human decision after restoring persistence.',
        changes: [
          {
            path: 'index.md',
            content: `${f.notebook().readRevision(baseRevision).files['index.md']}\nA separately reviewed control.\n`,
          },
        ],
      },
      { kind: 'agent', id: 'knowledge-manager', responsibleUserId: userId },
      []
    );
    const controlSelected = readUserMemoryProposal(context, control.id);
    const controlRequest = {
      requestId: randomUUID(),
      proposalId: control.id,
      proposalDigest: controlSelected.proposalDigest,
      baseRevision: control.baseRevision,
      candidateRevision: control.candidateRevision,
      decision,
    };
    const completed = await invoke('memory.proposal.decide', controlRequest, human);
    const completedAudit = auditRows(control.id, controlRequest.requestId);
    expect(completedAudit).toHaveLength(1);
    expect(await invoke('memory.proposal.decide', controlRequest, human)).toEqual(completed);
    expect(auditRows(control.id, controlRequest.requestId)).toEqual(completedAudit);
    expect(readUserMemoryProposal(context, control.id).reviews).toEqual([completed.review]);
    expect(f.notebook().publishedRevision()).toBe(baseRevision);
  }
);

// S61:220-222: retained User deciding Audit is incomplete without its original Review.
it.each(['rejected', 'deferred'] as const)(
  'refuses User %s replay when its original Audit survives a lost Review file',
  async (decision) => {
    const { existsSync, readFileSync, unlinkSync } = await import('node:fs');
    const { createOperationInvocation } = await import('../operation-composition.js');
    const f = fixture(false);
    const pending = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
    expect(pending.outcome).toBe('review-required');
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
    const selected = readUserMemoryProposal(context, pending.proposalId!);
    const proposal = selected.proposal;
    const baseRevision = f.notebook().publishedRevision();
    const request = {
      requestId: randomUUID(),
      proposalId: proposal.id,
      proposalDigest: selected.proposalDigest,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      decision,
    };
    const invoke = createOperationInvocation(f.dependencies);
    const human = {
      kind: 'public' as const,
      actor: f.input.requestActor,
      delivery: 'human' as const,
    };
    const auditRows = () =>
      f.userDb.sqlite
        .prepare(
          'SELECT * FROM audit_events WHERE workspace_id IS NULL AND request_id = ? AND action = ? AND resource = ? LIMIT 2'
        )
        .all(request.requestId, 'knowledge.proposal.decide', `knowledge-proposal:${proposal.id}`);
    expect(auditRows()).toEqual([]);
    const completed = await invoke('memory.proposal.decide', request, human);
    expect(completed.application).toBeNull();
    expect(readUserMemoryProposal(context, proposal.id).reviews).toEqual([completed.review]);
    const retainedAudit = auditRows();
    expect(retainedAudit).toHaveLength(1);
    expect(retainedAudit[0]).toMatchObject({
      request_id: request.requestId,
      action: 'knowledge.proposal.decide',
      resource: `knowledge-proposal:${proposal.id}`,
      outcome: 'succeeded',
    });
    const ownerRoot = resolveScopedNotebookOwner({
      coreDb: f.coreDb,
      actor: f.input.requestActor,
      target: { kind: 'user' },
    }).notebookRoot;
    const reviewPath = join(ownerRoot, 'reviews', `${proposal.id}.json`);
    const proposalPath = join(ownerRoot, 'proposals', `${proposal.id}.md`);
    const retainedReviewBytes = readFileSync(reviewPath, 'utf8');
    const retainedProposalBytes = readFileSync(proposalPath, 'utf8');
    expect(f.notebook().publishedRevision()).toBe(baseRevision);
    expect(f.notebook().retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
    expect(await invoke('memory.proposal.decide', request, human)).toEqual(completed);
    expect(auditRows()).toEqual(retainedAudit);
    expect(readFileSync(reviewPath, 'utf8')).toBe(retainedReviewBytes);
    expect(readUserMemoryProposal(context, proposal.id).reviews).toEqual([completed.review]);
    // Deliberate corruption after lawful public completion: no SQL or synthetic Review is written.
    unlinkSync(reviewPath);
    expect(existsSync(reviewPath)).toBe(false);
    expect(auditRows()).toEqual(retainedAudit);
    await expect
      .soft(invoke('memory.proposal.decide', request, human))
      .rejects.toMatchObject({ code: 'recovery_required' });
    expect.soft(existsSync(reviewPath)).toBe(false);
    expect.soft(auditRows()).toEqual(retainedAudit);
    expect.soft(readFileSync(proposalPath, 'utf8')).toBe(retainedProposalBytes);
    expect.soft(f.notebook().publishedRevision()).toBe(baseRevision);
    expect
      .soft(f.notebook().retainedCandidate(proposal.id).revision)
      .toBe(proposal.candidateRevision);
    // Missing original Review also forbids changing the same incomplete command into publication.
    await expect
      .soft(invoke('memory.proposal.decide', { ...request, decision: 'accepted' }, human))
      .rejects.toMatchObject({ code: 'recovery_required' });
    expect.soft(existsSync(reviewPath)).toBe(false);
    expect.soft(auditRows()).toEqual(retainedAudit);
    expect.soft(readFileSync(proposalPath, 'utf8')).toBe(retainedProposalBytes);
    expect.soft(f.notebook().publishedRevision()).toBe(baseRevision);
    expect
      .soft(f.notebook().retainedCandidate(proposal.id).revision)
      .toBe(proposal.candidateRevision);
  }
);

// S61:220–222 and the 0600 stale-new-decision ruling: only acceptance publishes against current head.
it.each(['rejected', 'deferred', 'accepted'] as const)(
  'User stale new %s decision preserves current publication and its exact reviewed tuple',
  async (decision) => {
    const f = fixture(false);
    const pending = await runUserMemoryMaintenanceCommand(f.dependencies, f.input);
    expect(pending.outcome).toBe('review-required');
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
    const selected = readUserMemoryProposal(context, pending.proposalId!);
    const proposal = selected.proposal;
    // Advance the real head through a separately created and accepted Proposal, not a raw ref write.
    const control = await createUserMemoryProposal(
      context,
      {
        requestId: randomUUID(),
        baseRevision: proposal.baseRevision,
        summary: 'Publish a separate reviewed change before deciding the older Proposal.',
        changes: [
          {
            path: 'index.md',
            content: `${f.notebook().readRevision(proposal.baseRevision).files['index.md']}\nA separate current publication.\n`,
          },
        ],
      },
      { kind: 'agent', id: 'knowledge-manager', responsibleUserId: userId },
      []
    );
    const controlSelected = readUserMemoryProposal(context, control.id);
    await decideUserMemoryProposal(context, {
      requestId: randomUUID(),
      proposalId: control.id,
      proposalDigest: controlSelected.proposalDigest,
      baseRevision: control.baseRevision,
      candidateRevision: control.candidateRevision,
      decision: 'accepted',
    });
    const currentHead = f.notebook().publishedRevision();
    const currentFiles = f.notebook().readRevision(currentHead).files;
    expect(currentHead).toBe(control.candidateRevision);
    expect(currentHead).not.toBe(proposal.baseRevision);
    expect(currentHead).not.toBe(proposal.candidateRevision);
    expect(readUserMemoryProposal(context, proposal.id).reviews).toEqual([]);
    const request = {
      requestId: randomUUID(),
      proposalId: proposal.id,
      proposalDigest: selected.proposalDigest,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      decision,
    };
    if (decision === 'accepted') {
      await expect(decideUserMemoryProposal(context, request)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(readUserMemoryProposal(context, proposal.id).reviews).toEqual([]);
    } else {
      await expect(decideUserMemoryProposal(context, request)).resolves.toMatchObject({
        review: request,
        notebookRevision: null,
      });
      expect(readUserMemoryProposal(context, proposal.id).reviews).toEqual([
        expect.objectContaining(request),
      ]);
    }
    expect(f.notebook().publishedRevision()).toBe(currentHead);
    expect(f.notebook().readRevision(currentHead).files).toEqual(currentFiles);
    expect(f.notebook().retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
  }
);

it.each(['maintain', 'tell'] as const)(
  'retains the original %s User receipt before inference and never rewrites it after role failure',
  async (kind) => {
    const f = fixture();
    const { tellContent: _tellContent, ...maintenanceInput } = f.input;
    const input = kind === 'tell' ? f.input : maintenanceInput;
    const command = kind === 'tell' ? 'knowledge.tell' : 'knowledge.maintain';
    let before: unknown;
    f.run.mockImplementationOnce(async (run) => {
      const receipt = f.store.getCommandRequest(
        command,
        input.requestId,
        { userId, actorId: userId },
        f.userDb
      )!;
      expect(receipt).toMatchObject({
        command,
        requestId: input.requestId,
        response: { kind: 'turn', id: run.turn.id },
      });
      expect(f.store.getTurnById(run.turn.id).triggerActor).toEqual({ kind: 'user', id: userId });
      expect(
        f.store.getThread(workspaceIdForOwner(run.turn.owner), run.turn.threadId)
      ).toMatchObject({ visibility: 'private', privateOwnerUserId: userId });
      before = f.userDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .get(input.requestId);
      throw new Error('External role failed after receipt acknowledgement.');
    });
    const result = await runUserMemoryMaintenanceCommand(f.dependencies, input);
    expect(result.outcome).toBe('failed');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(before).toBeDefined();
    expect(
      f.userDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .get(input.requestId)
    ).toEqual(before);
    await shutdownControlStoreWorkerClient();
    const cold = openUserDb(f.coreDb.dataRoot, userId);
    try {
      expect(
        cold.sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
          .get(input.requestId)
      ).toEqual(before);
      const reopened = new FsStore({ dataRoot: f.coreDb.dataRoot });
      expect(reopened.getTurnById(result.turnId)).toEqual(f.store.getTurnById(result.turnId));
    } finally {
      cold.sqlite.close();
    }
    expect(await runUserMemoryMaintenanceCommand(f.dependencies, input)).toEqual(result);
    expect(f.run).toHaveBeenCalledTimes(1);
  }
);

it.each(['maintain', 'tell'] as const)(
  'keeps acknowledged personal Workspace preparation without inference after a real %s User receipt INSERT fault',
  async (kind) => {
    const f = fixture();
    const { tellContent: _tellContent, ...maintenanceInput } = f.input;
    const input = kind === 'tell' ? f.input : maintenanceInput;
    const command = kind === 'tell' ? 'knowledge.tell' : 'knowledge.maintain';
    f.userDb.sqlite.exec(
      `CREATE TRIGGER refuse_memory_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.command_name = '${command}' BEGIN SELECT RAISE(ABORT, 'memory receipt fault'); END`
    );
    await expect(runUserMemoryMaintenanceCommand(f.dependencies, input)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(
      f.userDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(input.requestId)
    ).toEqual([]);
    const workspaces = f.store.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    const threads = f.store.listThreads(workspaces[0]!.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ visibility: 'private', privateOwnerUserId: userId });
    const turns = f.store.listThreadTurns(workspaces[0]!.id, threads[0]!.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      agentId: 'knowledge-manager',
      triggerActor: { kind: 'user', id: userId },
    });
    await shutdownControlStoreWorkerClient();
    const cold = openUserDb(f.coreDb.dataRoot, userId);
    try {
      expect(
        cold.sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
          .all(input.requestId)
      ).toEqual([]);
      const reopened = new FsStore({ dataRoot: f.coreDb.dataRoot });
      expect(reopened.getTurnById(turns[0]!.id)).toEqual(turns[0]);
    } finally {
      cold.sqlite.close();
    }
  }
);
