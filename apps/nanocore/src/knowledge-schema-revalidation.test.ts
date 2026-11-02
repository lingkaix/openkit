import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import * as notebookAdmission from './knowledge/notebook-workspace-admission.js';
import * as schemaHistory from './knowledge/schema-application.js';
import * as retrieval from './retrieval-knowledge-adapter.js';
import * as knowledgePreparation from './storage/control-store-knowledge.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
} from './test-support/store.js';
import { readTestWorkspaceNotebookSelection } from './test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Builds a real Source and recursive Page closure through their public publication owners. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schema-current-proof-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const workspace = await store.createWorkspace('Current schema proof');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const writer = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const app = createAppWithWorkspaceAuthority({ mode: 'server', coreDb, dataRoot, store });
  const call = async (operation: string, input: Record<string, unknown>) => {
    const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${writer.secret}`,
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        ...input,
        ...(operation === 'knowledge.schema.preview' ? { requestId } : {}),
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const source = await call('knowledge.source.register', {
    kind: 'document',
    title: 'Schema proof evidence',
    content: 'Actual immutable evidence for the recursive Page closure.',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  const sourcePin = `source:${source.body.source.id}@${source.body.source.contentDigest}`;
  const selection = () => readTestWorkspaceNotebookSelection(dataRoot, workspace.id);
  const publish = async (path: string, sourceReferences: string[]) => {
    const result = await call('knowledge.notebook.create', {
      baseRevision: selection().head.notebookCommit,
      path,
      content: serializeKnowledgePageFixture(
        {
          title: path,
          content: `Exact authored content for ${path}.`,
          sourceReferences,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
        { kind: 'workspace', workspaceId: workspace.id }
      ),
      summary: 'Publish schema proof fixture.',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  };
  await publish('companion.md', [sourcePin]);
  const companion = selection();
  const companionBytes = companion.notebook.readRevision(companion.head.notebookCommit).files[
    'companion.md'
  ]!;
  const pagePin = formatReferenceUri(
    {
      scopeId: `page/workspace/${workspace.id}/${companion.head.knowledgeBaseId}`,
      objectId: 'companion',
    },
    `sha256:${createHash('sha256').update(companionBytes).digest('hex')}`
  );
  await publish('guide.md', [sourcePin, pagePin]);
  const initial = selection();
  const input = {
    baseRevision: initial.head.notebookCommit,
    schemaText: `${initial.scopeSchemaText}\n# Explicit reviewed schema change for QA039.\n`,
  };
  return { coreDb, userId, store, workspace, writer, call, selection, initial, input };
}

it('checks the complete schema closure once per synchronous preview and apply inspection', async () => {
  const f = await fixture();
  // QA039 explicitly requires removal of repeated complete proofs within one synchronous stretch.
  // Observe the actual Page/reference owner; its real authority and Git work still run.
  const completeProof = vi.spyOn(retrieval, 'readAuthorizedWorkspaceNotebookPages');
  const preview = await f.call('knowledge.schema.preview', f.input);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body).toMatchObject({
    workspaceId: f.workspace.id,
    notebookRevision: f.input.baseRevision,
    inventoryComplete: true,
    coverage: 'workspace',
  });
  expect(preview.body.records.map((row: { path: string }) => row.path)).toEqual(
    expect.arrayContaining(['companion.md', 'guide.md'])
  );
  expect(completeProof.mock.calls.length).toBeGreaterThan(0);
  expect
    .soft(completeProof.mock.calls.length, 'public preview complete proofs')
    .toBeLessThanOrEqual(1);
  completeProof.mockClear();

  const events: string[] = [];
  const originalAdmission = notebookAdmission.readWorkspaceNotebookAdmission;
  vi.spyOn(notebookAdmission, 'readWorkspaceNotebookAdmission').mockImplementation((...args) => {
    const result = originalAdmission(...args);
    events.push('admission');
    return result;
  });
  const originalHistory = schemaHistory.prepareSchemaApplicationHistory;
  vi.spyOn(schemaHistory, 'prepareSchemaApplicationHistory').mockImplementation(async (...args) => {
    const result = await originalHistory(...args);
    events.push('history');
    return result;
  });
  const originalSelection = knowledgePreparation.prepareWorkspaceKnowledgeSelection;
  vi.spyOn(knowledgePreparation, 'prepareWorkspaceKnowledgeSelection').mockImplementation(
    async (...args) => {
      const result = await originalSelection(...args);
      events.push('selection');
      return result;
    }
  );
  const client = getControlStoreWorkerClient();
  const originalPause = client.tryPauseForWorkspaceCapture.bind(client);
  vi.spyOn(client, 'tryPauseForWorkspaceCapture').mockImplementation((...args) => {
    const paused = originalPause(...args);
    return (
      paused?.then((resume) => {
        events.push('drained');
        return resume;
      }) ?? null
    );
  });
  const originalOpen = client.openWorkspaceSchemaApplication.bind(client);
  vi.spyOn(client, 'openWorkspaceSchemaApplication').mockImplementation(async (...args) => {
    const submit = await originalOpen(...args);
    events.push('opened');
    return async () => {
      events.push('submit');
      await submit();
    };
  });
  const requestId = randomUUID();
  const applied = await f.call('knowledge.schema.apply', {
    ...f.input,
    requestId,
    reviewedReport: preview.body,
  });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(completeProof.mock.calls.length).toBeGreaterThan(0);
  expect
    .soft(completeProof.mock.calls.length, 'public apply complete proofs')
    .toBeLessThanOrEqual(2);
  expect(events.filter((event) => event !== 'admission')).toEqual([
    'drained',
    'history',
    'selection',
    'opened',
    'submit',
  ]);
  // Current authority is never borrowed from immutable selection across an await.
  for (const [after, before] of [
    ['drained', 'history'],
    ['history', 'selection'],
    ['selection', 'submit'],
    ['opened', 'submit'],
  ]) {
    expect(events.slice(events.indexOf(after) + 1, events.indexOf(before))).toContain('admission');
  }
  expect(f.selection().scopeSchemaText).toBe(f.input.schemaText);
  expect(f.selection().head.notebookCommit).toBe(f.input.baseRevision);
  const db = createTestWorkspaceDb(f.coreDb.dataRoot, f.workspace.id);
  try {
    expect(
      f.store.getCommandRequest(
        'knowledge.schema.apply',
        requestId,
        {
          workspaceId: f.workspace.id,
          actorId: f.userId,
        },
        db
      )?.response
    ).toEqual({ kind: 'knowledge_schema_report', id: applied.body.reportDigest });
    expect(
      listWorkspaceAuditEvents(db, f.workspace.id).filter(
        (event) => event.action === 'knowledge.schema.apply' && event.requestId === requestId
      )
    ).toHaveLength(1);
  } finally {
    closeTestCoreDb(db);
  }
});

it('refuses schema publication when the actual writer token is revoked after native opening', async () => {
  const f = await fixture();
  const preview = await f.call('knowledge.schema.preview', f.input);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const client = getControlStoreWorkerClient();
  const originalOpen = client.openWorkspaceSchemaApplication.bind(client);
  const opening = vi
    .spyOn(client, 'openWorkspaceSchemaApplication')
    .mockImplementation(async (...args) => {
      const submit = await originalOpen(...args);
      revokeOpenKitAccessTokenRecord(f.coreDb, f.writer.tokenId);
      return submit;
    });
  const requestId = randomUUID();
  const applied = await f.call('knowledge.schema.apply', {
    ...f.input,
    requestId,
    reviewedReport: preview.body,
  });
  expect(opening).toHaveBeenCalledOnce();
  expect(applied.status, JSON.stringify(applied.body)).toBe(403);
  expect(f.selection().head).toEqual(f.initial.head);
  expect(f.selection().scopeSchemaText).toBe(f.initial.scopeSchemaText);
  const db = createTestWorkspaceDb(f.coreDb.dataRoot, f.workspace.id);
  try {
    expect(
      f.store.getCommandRequest(
        'knowledge.schema.apply',
        requestId,
        {
          workspaceId: f.workspace.id,
          actorId: f.userId,
        },
        db
      )
    ).toBeNull();
    expect(
      listWorkspaceAuditEvents(db, f.workspace.id).filter(
        (event) => event.action === 'knowledge.schema.apply' && event.requestId === requestId
      )
    ).toHaveLength(0);
  } finally {
    closeTestCoreDb(db);
  }
});
