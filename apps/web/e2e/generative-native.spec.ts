import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreateLightAppResponse,
  LightAppRecord,
  LightAppSchemaInput,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaceDataRoot } from './_lib/demo-data.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
let fixtureRoot: string | null = null;
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});

/** Native browser actions must use the retained exact source and preserve drafts on local failure. */
test('edits and refreshes native Kernel data, reopens after restart and groups an independent Tool source', async ({
  page,
}) => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'openkit-generative-browser-'));
  await seedDemoWorkspaceDataRoot(fixtureRoot);
  const [
    { FsStore },
    { openCoreDb, openWorkspaceDb },
    { applyScopedMigrations },
    ui,
    { createHash },
  ] = await Promise.all([
    import('../../nanocore/dist/lib/store.js'),
    import('../../nanocore/dist/storage/db.js'),
    import('../../nanocore/dist/storage/migrate.js'),
    import('../../nanocore/dist/generative-ui/commands.js'),
    import('node:crypto'),
  ]);
  const store = new FsStore({ dataRoot: fixtureRoot });
  const workspaceId = store.listWorkspaces().find((workspace) => workspace.kind === 'code')!.id;
  const threadId = store.listThreads(workspaceId)[0]!.id;
  const coreDb = openCoreDb(fixtureRoot);
  const users = coreDb.sqlite.prepare("SELECT id FROM users WHERE kind = 'local'").all() as Array<{
    id: string;
  }>;
  expect(users).toHaveLength(1);
  const imageEvidence = coreDb.sqlite.prepare('SELECT * FROM worker_image_settlements').all();
  expect(imageEvidence).toHaveLength(1);
  await seedDemoWorkspaceDataRoot(fixtureRoot);
  expect(coreDb.sqlite.prepare('SELECT * FROM worker_image_settlements').all()).toEqual(
    imageEvidence
  );
  const workspaceDb = openWorkspaceDb(fixtureRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  const actor = { kind: 'user' as const, id: users[0]!.id };
  const turn = store.createTurn(workspaceId, threadId, 'Native Generative browser proof', actor);
  const context = {
    store,
    workspaceDb,
    actor,
    dataRoot: fixtureRoot,
    workspaceId,
    requestId: randomUUID(),
    inflightCommands: new WeakMap(),
  };
  const messages = (surfaceId: string, components: unknown[]) => [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId,
        catalogId: 'urn:openkit:a2ui:catalog:native:v1',
        sendDataModel: false,
      },
    },
    { version: 'v0.9', updateComponents: { surfaceId, components } },
  ];
  let appId: string;
  let recordId: string;
  try {
    const schema: LightAppSchemaInput = {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Native browser notes',
      purpose: 'Preserve local-only annotations without copying external records.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Local annotations.',
          indexes: [],
          fields: [
            {
              name: 'note',
              type: 'text',
              required: true,
              description: 'A local annotation owned by this Kernel.',
            },
          ],
        },
      ],
    };
    let app: CreateLightAppResponse;
    let record: LightAppRecord;
    // The local capability transport uses production token and attempt admission. Only image and backend acceptance evidence are synthetic; no provider or host runs.
    const requireCore = createRequire(new URL('../../nanocore/package.json', import.meta.url));
    const [
      { Hono },
      { Client, StreamableHTTPClientTransport },
      { loadRuntimeConfig },
      { resolveAgentSetup },
      { resolveAgentEnvironmentPackage },
      { recordAgentEnvironmentPackageSnapshot },
      { createSchedulerAdmissionEntry },
      attempts,
      nativeAttempts,
      { createDefaultWorkerControlGateway },
      { createDefaultWorkerMcpGateway },
      { registerWorkerMcpRoutes },
      { WorkspaceMutationAdmission },
    ] = await Promise.all([
      import(requireCore.resolve('hono')),
      import(requireCore.resolve('@modelcontextprotocol/client')),
      import('../../nanocore/dist/config/runtime-config.js'),
      import('../../nanocore/dist/agents/setup-resolver.js'),
      import('../../nanocore/dist/runtime/agent-environment.js'),
      import('../../nanocore/dist/runtime/aep-snapshot-ledger.js'),
      import('../../nanocore/dist/scheduler-records.js'),
      import('../../nanocore/dist/runtime/execution-attempt-records.js'),
      import('../../nanocore/dist/runtime/nanohost-attempt-records.js'),
      import('../../nanocore/dist/app.js'),
      import('../../nanocore/dist/runtime/worker-mcp-gateway.js'),
      import('../../nanocore/dist/worker-mcp-routes.js'),
      import('../../nanocore/dist/workspace-mutation-admission.js'),
    ]);
    const runtime = loadRuntimeConfig(fixtureRoot);
    const resolved = resolveAgentSetup(runtime.agentManifests[0]!, runtime);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.setup).not.toBeNull();
    const agentSessionId = allocateEntityId('as');
    const createdAt = new Date().toISOString();
    store.createAgentSession({
      id: agentSessionId,
      agentId: resolved.setup!.manifest.id,
      workspaceId,
      threadId,
      status: 'busy',
      message: null,
      createdAt,
      updatedAt: createdAt,
    });
    const workerTurn = store.updateTurn(turn.id, { agentSessionId });
    const environmentPackage = resolveAgentEnvironmentPackage({
      coreDb,
      agentSetup: resolved.setup!,
      agentSessionId,
      backend: { kind: 'openshell' },
      captureCoverage: { scope: 'server', value: 'off' },
      createdAt,
      requestId: randomUUID(),
      triggerActor: actor,
      turn: workerTurn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    recordAgentEnvironmentPackageSnapshot(workspaceDb, { environmentPackage, createdAt });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `generative-browser-${randomUUID()}`,
      requestId: environmentPackage.scope.requestId!,
      triggerActor: actor,
      workspaceId,
      threadId,
      turnId: turn.id,
      turnInput: 'Update the retained local note.',
      requestedAgentId: resolved.setup!.manifest.id,
    });
    const attempt = attempts.createSchedulerExecutionAttempt(coreDb, {
      entry,
      preparationInput: { admission: entry },
    });
    attempts.bindSchedulerExecutionAttemptSession(coreDb, {
      attemptId: attempt.attemptId,
      agentSessionId,
    });
    const sandboxBindingRef = `generative-browser-${randomUUID()}`;
    nativeAttempts.bindNanoHostAttemptPreparation(coreDb, {
      attemptId: attempt.attemptId,
      agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: sandboxBindingRef,
      sessionCompatibilityKey: 'generative-browser-local',
    });
    const submitted = attempts.recordSchedulerExecutionOperation(coreDb, {
      attemptId: attempt.attemptId,
      operationId: `generative-browser-${randomUUID()}`,
      submission: true,
    });
    expect(
      attempts.acceptSchedulerExecutionObservation(coreDb, {
        ...attempts.schedulerExecutionCorrelation(submitted),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      })?.disposition
    ).toBe('accepted');
    const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
    const registration = workerControlGateway.registerSession(environmentPackage, {
      sandboxBindingRef,
    });
    nativeAttempts.bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId: attempt.attemptId,
      sandboxBindingRef,
      workerControlTokenHash: registration.workerControlTokenHash,
      workerInferenceTokenHash: registration.workerInferenceTokenHash,
      workerCapabilityTokenHash: registration.workerCapabilityTokenHash,
    });
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const route = new Hono();
    registerWorkerMcpRoutes({
      app: route,
      coreDb,
      store,
      runtimeConfig: () => runtime,
      workerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const deniedWorker = await route.request('/api/worker-capabilities/mcp/openkit-generative', {
      method: 'POST',
      headers: {
        authorization: 'Bearer invalid-local-fixture-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(deniedWorker.status).toBe(401);
    const worker = new Client({ name: 'generative-browser-local-worker', version: '1.0.0' });
    try {
      await worker.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-generative'),
          {
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
              route.fetch(new Request(input, init)),
            requestInit: {
              headers: { authorization: `Bearer ${registration.workerCapabilityToken}` },
            },
          }
        )
      );
      expect((await worker.listTools()).tools.map((tool: { name: string }) => tool.name)).toContain(
        'kernel_records_update'
      );
      const createdApp = await worker.callTool({ name: 'kernel_apps_create', arguments: schema });
      app = createdApp.structuredContent as CreateLightAppResponse;
      appId = app.appId;
      const createdRecord = await worker.callTool({
        name: 'kernel_records_create',
        arguments: {
          appId,
          collection: 'notes',
          schemaRevision: app.schemaRevision,
          data: { note: 'Before Worker update' },
        },
      });
      record = createdRecord.structuredContent as LightAppRecord;
      recordId = record.id;
      expect(record).toMatchObject({ revision: 1, schemaRevision: app.schemaRevision });
      const updated = await worker.callTool({
        name: 'kernel_records_update',
        arguments: {
          appId,
          collection: 'notes',
          recordId,
          schemaRevision: app.schemaRevision,
          expectedRecordRevision: record.revision,
          data: { note: 'Original local note' },
        },
      });
      expect(updated.structuredContent).toMatchObject({
        id: recordId,
        schemaRevision: app.schemaRevision,
        revision: 2,
        data: { note: 'Original local note' },
      });
    } finally {
      await worker.close().catch(() => undefined);
      workerControlGateway.unregisterSession(environmentPackage.snapshotId);
      await workerMcpGateway.close();
    }
    const collection = app.schema!.collections[0]!;
    await ui.publishGenerativePresentation(
      { ...context, requestId: randomUUID() },
      {
        threadId,
        turnId: turn.id,
        title: 'Edit local note',
        fallbackText: 'Local note editor',
        messages: messages('native-note', [
          { id: 'root', component: 'Column', children: ['note', 'save', 'refresh'] },
          {
            id: 'note',
            component: 'TextField',
            label: 'Local note',
            value: { path: '/records/0/data/note' },
          },
          {
            id: 'save',
            component: 'Button',
            child: 'save-label',
            action: {
              event: {
                name: 'save',
                context: {
                  expectedRecordRevision: { path: '/records/0/revision' },
                  values: { path: '/records/0/data' },
                },
              },
            },
          },
          { id: 'save-label', component: 'Text', text: 'Save local note' },
          {
            id: 'refresh',
            component: 'Button',
            child: 'refresh-label',
            action: { event: { name: 'refresh' } },
          },
          { id: 'refresh-label', component: 'Text', text: 'Refresh local note' },
        ]),
        source: {
          kind: 'kernel-records',
          appId,
          collectionId: collection.id,
          schemaRevision: app.schemaRevision,
          query: {
            page: 1,
            perPage: 1,
            filter: `id = ${JSON.stringify(recordId)}`,
            fields: 'note',
          },
        },
        actions: [
          {
            name: 'save',
            componentId: 'save',
            kind: 'kernel-record-update',
            recordId,
            writableFieldIds: [collection.fields[0]!.id],
          },
          { name: 'refresh', componentId: 'refresh', kind: 'refresh' },
        ],
      }
    );
    const text = 'External source observation: 3 matches.';
    const source = store.createItem({
      id: 'it_00000000-0000-7000-8000-000000000059',
      workspaceId,
      threadId,
      turnId: turn.id,
      type: 'tool-call',
      status: 'completed',
      tool: 'selected-source-query',
      server: 'local-test',
      arguments: {},
      result: text,
      error: null,
      durationMs: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await ui.publishGenerativePresentation(
      { ...context, requestId: randomUUID() },
      {
        threadId,
        turnId: turn.id,
        title: 'Independent observation',
        fallbackText: text,
        messages: messages('independent-observation', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: {
          kind: 'item',
          itemId: source.id,
          contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        },
        actions: [],
      }
    );
    // This fixture created no Worker process or external stream. Its awaited native calls and revoked route are complete; cancel the modeled Turn and release only that local attempt before normal Core boot.
    store.updateTurn(turn.id, { status: 'cancelled', completedAt: new Date().toISOString() });
    const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId: attempt.attemptId,
      cause: 'local-capability-fixture-ended',
    });
    expect(
      attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation: attempts.schedulerExecutionCorrelation(closing),
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
        fenceRef: 'local-capability-fixture:no-worker-process',
      }).phase
    ).toBe('closed');
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }

  stack = await startIsolatedWebStack({ mode: 'local', dataRoot: fixtureRoot, useSimulator: true });
  const coreUrl = stack.coreUrl;
  const operation = async (name: string, input: unknown) => {
    const response = await fetch(`${coreUrl}/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify(input),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  await page.goto(`${stack.webUrl}/chat/${workspaceId}/${threadId}`);
  const note = page.getByRole('textbox', { name: 'Local note', exact: true });
  await expect(note).toHaveValue('Original local note');
  await note.fill('Browser committed note');
  await page.getByRole('button', { name: 'Save local note', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await operation('kernel.records.get', {
            workspaceId,
            appId,
            collection: 'notes',
            recordId,
            schemaRevision: 1,
          })
        ).data.note
    )
    .toBe('Browser committed note');
  await note.fill('Keep this unsaved draft');
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/app/operations/generative-ui.refresh') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Refresh local note', exact: true }).click();
  await refreshed;
  await expect(page.getByText(/^Current/)).toBeVisible();
  await expect(note).toHaveValue('Keep this unsaved draft');

  // A distinct owner write makes the displayed compare-and-set revision stale.
  await operation('kernel.records.update', {
    workspaceId,
    appId,
    collection: 'notes',
    recordId,
    schemaRevision: 1,
    expectedRecordRevision: 3,
    data: { note: 'Concurrent owner note' },
  });
  await page.getByRole('button', { name: 'Save local note', exact: true }).click();
  await expect(page.getByText('Record revision is stale.', { exact: true })).toBeVisible();
  await expect(note).toHaveValue('Keep this unsaved draft');
  expect(
    (
      await operation('kernel.records.get', {
        workspaceId,
        appId,
        collection: 'notes',
        recordId,
        schemaRevision: 1,
      })
    ).data.note
  ).toBe('Concurrent owner note');
  await expect(
    page.getByText('Source history · selected-source-query', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByText('External source observation: 3 matches.', { exact: true })
      .filter({ visible: true })
  ).toHaveCount(1);

  await stack.restartCore();
  await page.reload();
  await expect(note).toHaveValue('Original local note');
  const currentObservation = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/app/operations/generative-ui.refresh') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Refresh local note', exact: true }).click();
  expect((await currentObservation).ok()).toBe(true);
  await expect(page.getByText(/^Current/)).toBeVisible();
  await expect(note).toHaveValue('Concurrent owner note');
  expect(
    (
      await operation('kernel.records.get', {
        workspaceId,
        appId,
        collection: 'notes',
        recordId,
        schemaRevision: 1,
      })
    ).revision
  ).toBe(4);
});
