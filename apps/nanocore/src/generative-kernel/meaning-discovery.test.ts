import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { applyEdits, modify } from 'jsonc-parser';
import { describe, expect, it, onTestFinished } from 'vitest';
import { importWorkspaceSkill } from '../catalog/resource-catalog.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { updateOkfFrontmatter } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { OperationInvocationContext } from '../operation-contract.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createLightApp, createRecord, getLightApp, getRecord } from './commands.js';

const NOW = '2026-10-19T00:00:00.000Z';
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** Real app storage, authenticated operation admission and published meaning owners share one scope. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-meaning-discovery-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Meaning discovery');
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
function publish(f: Awaited<ReturnType<typeof fixture>>, content: string) {
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
function page(f: Awaited<ReturnType<typeof fixture>>, sourceReferences: string[] = []) {
  return serializeKnowledgePageFixture(
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
function createApp(f: Awaited<ReturnType<typeof fixture>>, references: string[]) {
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
    const sourceThread = await f.store.createThread(
      f.workspace.id,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: f.userId }
    );
    const destination = await f.store.createThread(
      f.workspace.id,
      'Shared consumer',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const material = 'Private domain evidence.';
    const source = await captureWorkspaceSourceFixture({
      ...f,
      source: {
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
      content: material,
    });
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

  it('keeps Worker Source reads under the exact Agent grant rather than its responsible User grant', async () => {
    const f = await fixture();
    const thread = await f.store.createThread(f.workspace.id, 'Managed Worker Source');
    const turn = await f.store.createTurn(
      f.workspace.id,
      thread.id,
      'Interpret case state',
      f.actor
    );
    const agentId = 'domain-reader';
    const agentSessionId = allocateEntityId('as');
    await f.store.createAgentSession({
      id: agentSessionId,
      agentId,
      workspaceId: f.workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await f.store.updateTurn(turn.id, { agentId, agentSessionId });
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId,
      agentSetup: createTestAgentSetup({ agentId }),
      backend: { kind: 'openshell' },
      createdAt: NOW,
      requestId: randomUUID(),
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      queueEntryId: randomUUID(),
      requestId: randomUUID(),
      triggerActor: turn.triggerActor,
      workspaceId: f.workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      turnInput: 'Interpret case state',
      requestedAgentId: agentId,
    });
    recordTestExecutionAttempt(f.coreDb, {
      entry,
      attemptId: allocateEntityId('attempt'),
      agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: 'domain-reader-binding',
      sessionCompatibilityKey: 'domain-reader-session',
      now: () => NOW,
      operationId: 'domain-reader-submit',
    });
    const context: OperationInvocationContext = {
      kind: 'worker',
      actor: turn.triggerActor,
      requestId: randomUUID(),
      bindings: { workspaceId: f.workspace.id },
      lineage: {
        workspaceId: f.workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
      },
    };
    const material = 'Domain evidence protected from this Agent.';
    const source = await captureWorkspaceSourceFixture({
      ...f,
      source: {
        id: allocateEntityId('ks'),
        workspaceId: f.workspace.id,
        kind: 'document',
        title: 'Managed domain source',
        uri: null,
        contentDigest: digest(material),
        originatingThreadId: thread.id,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      content: material,
    });
    const content = page(f, [`source:${source.id}@${digest(material)}`]);
    const reference = publish(f, content);
    const app = await createApp(f, [reference]);
    const configDirectory = join(f.dataRoot, 'workspaces', f.workspace.id, 'config');
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'workspace.jsonc');
    // Add only the managed policy; the Notebook's retained default-KB binding must stay exact.
    const originalConfig = readFileSync(configPath, 'utf8');
    const policyConfig = applyEdits(
      originalConfig,
      modify(originalConfig, ['requiredFeatures'], ['openkit.workspace-resource-policy.v1'], {})
    );
    const grant = (agentCanRead: boolean) =>
      writeFileSync(
        configPath,
        applyEdits(
          policyConfig,
          modify(
            policyConfig,
            ['workspace', 'policy'],
            {
              mediation: {
                schemaVersion: 1,
                statements: [
                  ...managedThreadPolicy({
                    workspaceId: f.workspace.id,
                    threadId: thread.id,
                    userId: f.userId,
                    operations: ['thread.read'],
                  }).statements,
                  ...managedThreadPolicy({
                    workspaceId: f.workspace.id,
                    threadId: thread.id,
                    userId: f.userId,
                    agentId,
                    operations: agentCanRead
                      ? ['workspace.read', 'thread.read']
                      : ['workspace.read'],
                  })
                    .statements.filter((statement) => statement.kind === 'permission')
                    .map((statement) => ({ ...statement, id: 'source-agent-read' })),
                ],
              },
            },
            {}
          )
        )
      );
    const selector = { workspaceId: f.workspace.id, appId: app.appId };
    grant(false);
    expect.soft(await f.invoke('kernel.apps.get', selector, context)).toEqual({
      ...app,
      meaning: [unavailable(reference)],
    });
    grant(true);
    expect(await f.invoke('kernel.apps.get', selector, context)).toEqual({
      ...app,
      meaning: [{ reference, status: 'available', content }],
    });
  });

  it.each([
    { label: 'one oversized Skill', count: 1, characters: 1024 * 1024 },
    { label: 'aggregate Skills below the individual limit', count: 2, characters: 400 * 1024 },
  ])('refuses $label when the complete UTF-8 JSON read exceeds 2 MiB', async ({
    count,
    characters,
  }) => {
    const f = await fixture();
    // The accepted read ceiling counts encoded bytes; each non-ASCII character uses three UTF-8 bytes.
    const maximum = 2 * 1024 * 1024;
    let revision = 0;
    const contents: string[] = [];
    const references: string[] = [];
    for (let index = 0; index < count; index++) {
      const content = `---\nname: domain-${index}\ndescription: Interpret domain state.\n---\n${'界'.repeat(characters)}\n`;
      const imported = importWorkspaceSkill({
        dataRoot: f.dataRoot,
        workspaceId: f.workspace.id,
        producer: f.actor,
        createdAt: NOW,
        activate: true,
        displayName: `Domain ${index}`,
        expectedRevision: revision,
        tree: [
          {
            kind: 'file',
            path: 'SKILL.md',
            contentBase64: Buffer.from(content).toString('base64'),
          },
        ],
      });
      revision = imported.catalog.revision;
      contents.push(content);
      references.push(
        formatReferenceUri(
          { scopeId: `skill/workspace/${f.workspace.id}`, objectId: imported.version.entryId },
          imported.version.digest
        )
      );
    }
    const app = await createApp(f, references);
    if (count > 1) {
      for (const content of contents) {
        expect(Buffer.byteLength(JSON.stringify(content), 'utf8')).toBeLessThan(maximum);
      }
    }
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...app,
          meaning: references.map((reference, index) => ({
            reference,
            status: 'available',
            content: contents[index],
          })),
        }),
        'utf8'
      )
    ).toBeGreaterThan(maximum);
    const result = await f
      .invoke('kernel.apps.get', { workspaceId: f.workspace.id, appId: app.appId }, f.context)
      .then(
        (response) => ({
          outcome: 'returned',
          bytes: Buffer.byteLength(JSON.stringify(response), 'utf8'),
        }),
        (error: unknown) => ({ outcome: 'refused', error })
      );
    expect(result).toMatchObject({
      outcome: 'refused',
      error: { code: 'limit_exceeded', details: { maximum } },
    });
    expect(getLightApp(f.dataRoot, f.workspace.id, app.appId)).toEqual(app);
  });
});
