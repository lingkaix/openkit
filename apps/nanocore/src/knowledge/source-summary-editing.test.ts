import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
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
import type { NotebookUpdate } from './notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';
import { parseSourcePointer } from './source-pointers.js';

/** Native capture, current admission, Git, Storage and Review; no Source is inserted as a curated Page. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-summary-editing-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Source description correction');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(() => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
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
  const origin = store.createThread(workspace.id, 'Shared evidence');
  const original = 'Captured release facts.\r\nKeep exact \u03a9 \u96ea bytes.\n';
  const captured = await call('knowledge.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Unclear intake title',
    content: original,
    originatingThreadId: origin.id,
  });
  expect(captured.status, JSON.stringify(captured.body)).toBe(200);
  const source = store.listKnowledgeSources(workspace.id)[0]!;
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const repositoryPath = join(root, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const owner = { dataRoot, ownerScope: { kind: 'workspace', workspaceId: workspace.id } } as const;
  const pointer = notebook.readSourcePointers(notebook.publishedRevision())[source.id]!;
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
  const seeded = await call('knowledge.notebook.update', {
    requestId: randomUUID(),
    baseRevision: notebook.publishedRevision(),
    summary: 'Retain unrelated human content',
    changes: [{ path: 'unrelated.md', content: page }],
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  const baseRevision = notebook.publishedRevision();
  const path = `sources/${source.id}.md`;
  const corrected = updateOkfFrontmatter({
    path,
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
    corrected,
  };
}

describe('ordinary SourceSummary editing through native owners', () => {
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
    expect(reopened.inspectRevision(revision).entries).not.toHaveProperty(f.path);
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
      parseOkfDocument({ path: f.path, content: after.content }).document?.frontmatter
    ).toMatchObject({
      title: 'Release evidence',
      description: 'Captured release facts for onboarding.',
      tags: ['onboarding', 'release'],
    });
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
    const changed = updateOkfFrontmatter({ path: f.path, content: f.corrected, updates });
    const other = `sources/${allocateEntityId('ks')}.md`;
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
    'required Review',
    'unselected',
    'private',
    'revoked',
  ])('uses the real Workspace KM editor and publisher under %s admission', async (mode) => {
    const f = await fixture();
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
                enabled: mode !== 'required Review',
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
        throw new OperationError(
          'workspace_access_denied',
          'Current native admission denied.',
          403
        );
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
            script: `mkdir -p sources; cat > /notebook/${f.path} <<'SOURCE'\n${f.corrected}SOURCE\n`,
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
        const inspected = await execute('knowledge.notebook-workspace.update', {
          script: `cat /notebook/${f.path}`,
        });
        inspections.push(inspected);
        const edited = await execute('knowledge.notebook-workspace.update', {
          script: `cat > /notebook/${f.path} <<'SOURCE'\n${f.corrected}SOURCE\n`,
        });
        inspections.push(edited);
        if (mode === 'required Review') {
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
        sources: mode === 'unselected' ? [] : [f.source.id],
        signal: new AbortController().signal,
      }
    );
    if (mode === 'private') {
      expect((await prepared.execute()).outcome).toBe('failed');
      expect(runs).toBe(0);
    } else if (mode === 'unselected' || mode === 'revoked') {
      // A rejected Tool never creates a native outcome; completion must fail rather than publish.
      expect((await prepared.execute()).outcome).toBe('failed');
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
      const result = await prepared.execute();
      expect(runs).toBe(1);
      expect(reviewToolExposed).toBe(false);
      if (mode === 'required Review') expect(forgedReviewRefused).toBe(true);
      expect(inspections).toHaveLength(2);
      expect(inspections[0]).toMatchObject({ exitCode: 0, stdout: f.pointer });
      expect(inspections[1]!.exitCode).toBe(0);
      const expectedCandidate = updateOkfFrontmatter({
        path: f.path,
        content: f.corrected,
        updates: { review_state: 'delegated' },
      });
      if (mode === 'ordinary') {
        expect(result.outcome).toBe('published');
        const after = f.notebook.readSourcePointers(f.notebook.publishedRevision())[f.source.id]!;
        expect(after).toBe(expectedCandidate);
        expect(parseSourcePointer(f.owner, f.source.id, after).fields).toEqual(f.parsed.fields);
        expect(f.notebook.readRevision(f.notebook.publishedRevision()).files).toEqual(
          f.notebook.readRevision(f.baseRevision).files
        );
        expect(
          parseOkfDocument({ path: f.path, content: after }).document?.frontmatter
        ).toMatchObject({
          title: 'Release evidence',
          description: 'Captured release facts for onboarding.',
          tags: ['onboarding', 'release'],
          review_state: 'delegated',
        });
        expect(parseOkfDocument({ path: f.path, content: after }).document?.body).toBe(
          'The captured material describes the release facts.\n'
        );
        expect(f.store.listKnowledgeProposals(f.workspace.id)).toEqual([]);
      } else {
        expect(result.outcome).toBe('review-required');
        expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
        const proposal = f.store.listKnowledgeProposals(f.workspace.id)[0]!;
        const tuple = {
          proposalId: proposal.id,
          proposalDigest: f.store.knowledgeProposalDigest(f.workspace.id, proposal.id),
          baseRevision: f.baseRevision,
          candidateRevision: proposal.candidateRevision,
        };
        const inventory = await f.call('knowledge.proposal.read', { proposalId: proposal.id });
        expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
        expect(inventory.body).toEqual({ ...tuple, paths: [f.path] });
        const preview = await f.call('knowledge.proposal.read', {
          proposalId: proposal.id,
          path: f.path,
        });
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        const candidate = f.notebook.readSourcePointers(proposal.candidateRevision)[f.source.id]!;
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
          parseOkfDocument({ path: f.path, content: candidate }).document?.frontmatter
        ).toMatchObject({
          title: 'Release evidence',
          description: 'Captured release facts for onboarding.',
          tags: ['onboarding', 'release'],
        });
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
    if (mode === 'unselected' || mode === 'private' || mode === 'revoked') {
      expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
      expect(f.store.listKnowledgeProposals(f.workspace.id)).toEqual([]);
    }
    expect(reviewToolExposed).toBe(false);
    const reopened = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
    expect(reopened.readSourcePointers(f.baseRevision)[f.source.id]).toBe(f.pointer);
    expect(reopened.readRevision(reopened.publishedRevision()).files['unrelated.md']).toBe(f.page);
    expect(reopened.inspectRevision(reopened.publishedRevision()).entries).not.toHaveProperty(
      f.path
    );
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(f.original));
  });
});
