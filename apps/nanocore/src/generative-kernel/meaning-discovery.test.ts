import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { importWorkspaceSkill } from '../catalog/resource-catalog.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { updateOkfFrontmatter } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { OperationInvocationContext } from '../operation-contract.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createLightApp, createRecord, getLightApp, getRecord } from './commands.js';

const NOW = '2026-10-19T00:00:00.000Z';
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** Real app storage, authenticated operation admission and published meaning owners share one scope. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-meaning-discovery-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Meaning discovery');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const ownerScope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const actor = { kind: 'user' as const, id: userId };
  const context: OperationInvocationContext = {
    kind: 'public',
    actor: { kind: 'local', userId },
  };
  const command = () => ({
    dataRoot,
    store,
    workspaceId: workspace.id,
    actor,
    requestId: randomUUID(),
    inflightCommands: new WeakMap(),
  });
  const invoke = createOperationInvocation({
    dataRoot,
    store,
    coreDb,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    store,
    userId,
    workspace,
    ownerScope,
    actor,
    context,
    command,
    invoke,
    notebook,
  };
}

/** Publish genuine governed page bytes; exact content pins come from the external owner. */
function publish(f: ReturnType<typeof fixture>, content: string) {
  const baseRevision = f.notebook.publishedRevision();
  const candidateRevision = f.notebook.prepare({
    baseRevision,
    changes: { 'domain.md': content },
    metadata: {
      summary: 'Publish domain meaning',
      producer: f.actor,
      authority: { kind: 'direct', instructionReference: 'test:app-meaning' },
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(content) },
      sourceReferences: [],
    },
  });
  f.notebook.publish({ baseRevision, candidateRevision });
  const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: f.ownerScope });
  return formatReferenceUri(
    { scopeId: `page/workspace/${f.workspace.id}/${knowledgeBaseId}`, objectId: 'domain' },
    digest(content)
  );
}

/** Native authored serialization preserves exact page bytes and optional Source lineage. */
function page(f: ReturnType<typeof fixture>, sourceReferences: string[] = []) {
  return serializeUserAuthoredKnowledgePage(
    {
      id: 'domain',
      kind: 'project-context',
      title: 'Domain meaning',
      content: 'Original domain meaning.\n',
      sourceReferences,
      createdAt: NOW,
      updatedAt: NOW,
    },
    f.ownerScope
  );
}

/** Use the existing native definition writer; no resolver or receiver is replaced. */
function createApp(f: ReturnType<typeof fixture>, references: string[]) {
  const schema: LightAppSchemaInput = {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Cases',
    purpose: 'Track operational case state.',
    references,
    collections: [
      {
        name: 'cases',
        type: 'base',
        description: 'Case state',
        indexes: [],
        fields: [{ name: 'state', type: 'text', required: true, description: 'Current state' }],
      },
    ],
  };
  return createLightApp(f.command(), schema);
}

const unavailable = (reference: string) => ({ reference, status: 'unavailable' });

describe('native Light App meaning discovery', () => {
  it('returns exact published page and Skill versions after both current targets advance', async () => {
    const f = fixture();
    const content = page(f);
    const pageReference = publish(f, content);
    const skillContent =
      '---\nname: domain\ndescription: Interpret case state.\n---\nOriginal procedure.\n';
    const skillInput = {
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      producer: f.actor,
      createdAt: NOW,
      activate: true,
      displayName: 'Domain procedure',
    };
    const first = importWorkspaceSkill({
      ...skillInput,
      expectedRevision: 0,
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from(skillContent).toString('base64'),
        },
      ],
    });
    const skillReference = formatReferenceUri(
      { scopeId: `skill/workspace/${f.workspace.id}`, objectId: first.version.entryId },
      first.version.digest
    );
    const app = await createApp(f, [pageReference, skillReference]);
    const selector = { workspaceId: f.workspace.id, appId: app.appId };
    const expected = {
      ...app,
      meaning: [
        { reference: pageReference, status: 'available', content },
        { reference: skillReference, status: 'available', content: skillContent },
      ],
    };
    expect.soft(await f.invoke('kernel.apps.get', selector, f.context)).toEqual(expected);
    publish(f, content.replace('Original domain meaning.', 'Later domain meaning.'));
    importWorkspaceSkill({
      ...skillInput,
      id: first.version.entryId,
      expectedRevision: first.catalog.revision,
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            skillContent.replace('Original procedure.', 'Later procedure.')
          ).toString('base64'),
        },
      ],
    });
    expect.soft(await f.invoke('kernel.apps.get', selector, f.context)).toEqual(expected);
    expect(getLightApp(f.dataRoot, f.workspace.id, app.appId)).toEqual(app);
  });

  it('reports current denial, wrong scope and unsupported targets without blocking retained app records', async () => {
    const f = fixture();
    const content = page(f);
    const pageReference = publish(f, content);
    const references = [
      pageReference,
      pageReference.replace(f.workspace.id, allocateEntityId('ws')),
      pageReference.replace('/domain@', '/missing@'),
      pageReference.replace('openkit:page/', 'openkit:raw/'),
      formatReferenceUri(
        { scopeId: 'skill/server', objectId: 'unavailable-procedure' },
        digest('absent')
      ),
    ];
    const app = await createApp(f, references);
    const record = await createRecord(f.command(), app.appId, 'cases', 1, { state: 'Open' });
    publish(
      f,
      updateOkfFrontmatter({ path: 'domain.md', content, updates: { sensitivity: 'confidential' } })
    );
    expect
      .soft(
        await f.invoke(
          'kernel.apps.get',
          { workspaceId: f.workspace.id, appId: app.appId },
          f.context
        )
      )
      .toEqual({
        ...app,
        meaning: references.map(unavailable),
      });
    expect(getLightApp(f.dataRoot, f.workspace.id, app.appId)).toEqual(app);
    expect(getRecord(f.dataRoot, f.workspace.id, app.appId, 'cases', record.id, 1).data).toEqual({
      state: 'Open',
    });
    const next = await createRecord(f.command(), app.appId, 'cases', 1, { state: 'Closed' });
    expect(next.data).toEqual({ state: 'Closed' });
    const plain = await createApp(f, []);
    expect
      .soft(
        await f.invoke(
          'kernel.apps.get',
          { workspaceId: f.workspace.id, appId: plain.appId },
          f.context
        )
      )
      .toEqual(plain);
  });

  it('uses trusted output lineage to prevent private Source content from reaching a shared Thread', async () => {
    const f = fixture();
    const sourceThread = f.store.createThread(
      f.workspace.id,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: f.userId }
    );
    const destination = f.store.createThread(
      f.workspace.id,
      'Shared consumer',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const material = 'Private domain evidence.';
    const source = f.store.createKnowledgeSource(
      {
        id: allocateEntityId('ks'),
        workspaceId: f.workspace.id,
        kind: 'document',
        title: 'Private domain source',
        uri: null,
        contentDigest: digest(material),
        originatingThreadId: sourceThread.id,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      material
    );
    const content = page(f, [`source:${source.id}@${digest(material)}`]);
    const reference = publish(f, content);
    const app = await createApp(f, [reference]);
    const selector = { workspaceId: f.workspace.id, appId: app.appId };
    expect
      .soft(
        await f.invoke('kernel.apps.get', selector, {
          ...f.context,
          queryContext: { threadId: sourceThread.id },
        })
      )
      .toEqual({ ...app, meaning: [{ reference, status: 'available', content }] });
    expect
      .soft(
        await f.invoke('kernel.apps.get', selector, {
          ...f.context,
          queryContext: { threadId: destination.id },
        })
      )
      .toEqual({ ...app, meaning: [unavailable(reference)] });
  });
});
