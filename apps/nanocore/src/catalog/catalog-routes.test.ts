import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import {
  GetWorkspaceCatalogResponseSchema,
  ImportSkillResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { ApiErrorSchema } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createAppWithLocalIdentity as createApp,
  createLoopbackAppFetch,
} from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  catalogDocumentPath,
  loadWorkspaceResourceCatalog,
  projectEffectiveWorkspaceMcpCatalog,
} from './resource-catalog.js';

/** Creates isolated catalog authority without credential material or upstream contact. */
async function catalogFixture(checkListenerTlsChange?: () => Promise<boolean>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-binding-routes-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('MCP binding workspace');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: workspace.id,
  });
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot, checkListenerTlsChange });
  const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
  const app = createApp({ coreDb, dataRoot, store, runtimeConfigManager, workerMcpGateway });
  const close = async () => {
    await workerMcpGateway.close();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  };
  return { app, coreDb, dataRoot, workspace, runtimeConfigManager, workerMcpGateway, close };
}

/** Posts complete logical input through the canonical catalog operation. */
function postCatalog(app: ReturnType<typeof createApp>, path: OperationId, input: unknown) {
  return app.request(
    ...operationRequest(
      path,
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }
    )
  );
}

/** Hold the real Audit acknowledgement after the native commit. */
function holdCatalogAudit(requestId: string, action = 'catalog.mcp-binding') {
  const worker = getControlStoreWorkerClient();
  const acknowledge = worker.standaloneAudit.bind(worker);
  const committed = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const audit = vi.spyOn(worker, 'standaloneAudit').mockImplementation(async (db, input) => {
    const result = await acknowledge(db, input);
    if (input.stage === action && input.event.requestId === requestId) {
      committed.resolve();
      await reply.promise;
    }
    return result;
  });
  return { committed, reply, audit };
}

async function openActiveMcpFixture(checkListenerTlsChange?: () => Promise<boolean>) {
  const f = await catalogFixture(checkListenerTlsChange);
  const workspaceId = f.workspace.id;
  const change = (expectedRevision: number, tool: string, requestId = crypto.randomUUID()) =>
    postCatalog(f.app, 'catalog.mcp-binding', {
      workspaceId,
      mcpId: 'echo',
      enabled: true,
      schemaPolicy: 'tracking',
      allowedTools: [tool],
      bindingRevision: expectedRevision,
      expectedRevision,
      requestId,
    });
  const installedTools = () =>
    f.runtimeConfigManager
      .current()
      .workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === workspaceId)
      ?.catalog.servers.find((server) => server.id === 'echo')?.allowedTools;
  try {
    const created = await postCatalog(f.app, 'catalog.mcp-create', {
      workspaceId,
      allowedTools: ['base'],
      declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
      displayName: 'Echo',
      id: 'echo',
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await change(1, 'base')).status).toBe(200);
    return { ...f, change, installedTools };
  } catch (error) {
    await f.close();
    throw error;
  }
}

describe('resource catalog operations', () => {
  it('keeps schema-invalid retained catalog reads on the fixed catalog.read error', async () => {
    const f = await catalogFixture();
    try {
      writeFileSync(
        catalogDocumentPath(f.dataRoot, f.workspace.id),
        JSON.stringify({ revision: 'invalid-retained-revision' })
      );
      const response = await f.app.request(
        ...operationRequest(
          'catalog.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: f.workspace.id }),
          }
        )
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        code: 'catalog_read_failed',
        message: 'The record could not be processed.',
      });
    } finally {
      f.coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it.each(['http', 'cli'] as const)(
    'stores, retains and replaces credential bindings through %s',
    async (surface) => {
      const f = await catalogFixture();
      try {
        await createVaultReference(f.coreDb, {
          referenceId: 'vault_00000000-0000-796e-9f65-da34836d04d3',
          displayName: 'Synthetic MCP token',
          ownerScope: 'workspace',
          workspaceId: f.workspace.id,
          secretKind: 'mcp-token',
          backendKind: 'encrypted-file',
          backendLocator: 'synthetic',
        });
        const grant = await createVaultGrant(f.coreDb, {
          grantId: 'grant_00000000-0000-7fb6-8f22-bece61eb0941',
          vaultReferenceId: 'vault_00000000-0000-796e-9f65-da34836d04d3',
          ownerScope: 'workspace',
          workspaceId: f.workspace.id,
          allowedInjectionPaths: ['gateway-only'],
          lifetime: 'workspace',
        });
        expect(grant.targetCapabilityId).toBeNull();
        const created = await postCatalog(f.app, 'catalog.mcp-create', {
          workspaceId: f.workspace.id,
          ...{
            allowedTools: ['echo'],
            declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
            displayName: 'Echo',
            id: 'echo',
            expectedRevision: 0,
            requestId: crypto.randomUUID(),
          },
        });
        expect(created.status, await created.clone().text()).toBe(201);
        const credentialBindings = [
          {
            slot: 'token',
            vaultGrantId: grant.grantId,
            sink: { kind: 'header', name: 'Authorization' },
            presentation: 'bearer',
          },
        ];
        const command = {
          allowedTools: ['echo'],
          enabled: true,
          schemaPolicy: 'tracking',
          bindingRevision: 1,
          expectedRevision: 1,
          requestId: crypto.randomUUID(),
          credentialBindings,
        };
        const client = createCoreClient({
          baseUrl: 'http://nanocore.test',
          fetch: createLoopbackAppFetch(f.app),
        });
        const { operationCatalog } = await import(
          new URL('../../../../skills/openkit-operations.mjs', import.meta.url).href
        );
        const operation = operationCatalog.find(
          (entry: { id: string }) => entry.id === 'catalog.mcp-binding'
        );
        const update = async (body: Record<string, unknown>) => {
          if (surface === 'cli') {
            return operation.handler(
              { client },
              operation.inputSchema.parse({
                ...body,
                workspaceId: f.workspace.id,
                mcpId: 'echo',
              })
            );
          }
          const response = await postCatalog(f.app, 'catalog.mcp-binding', {
            workspaceId: f.workspace.id,
            mcpId: 'echo',
            ...body,
          });
          expect(response.status).toBe(200);
          return response.json();
        };
        expect(await update(command)).toEqual({ revision: 2 });
        const bound = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
        expect(bound.mcp.bindings[0]?.credentialBindings).toEqual(credentialBindings);
        expect(projectEffectiveWorkspaceMcpCatalog(bound).servers[0]?.credentialBindings).toEqual(
          credentialBindings
        );
        const { credentialBindings: _omitted, ...policyOnly } = command;
        expect(
          await update({
            ...policyOnly,
            bindingRevision: 2,
            expectedRevision: 2,
            requestId: crypto.randomUUID(),
            timeoutMs: 1200,
          })
        ).toEqual({ revision: 3 });
        const retained = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
        expect(retained.mcp.bindings[0]?.credentialBindings).toEqual(credentialBindings);
        expect(
          projectEffectiveWorkspaceMcpCatalog(retained).servers[0]?.credentialBindings
        ).toEqual(credentialBindings);
        const stale = await postCatalog(f.app, 'catalog.mcp-binding', {
          workspaceId: f.workspace.id,
          mcpId: 'echo',
          ...{
            ...command,
            expectedRevision: 2,
            bindingRevision: 3,
            requestId: crypto.randomUUID(),
            credentialBindings: [],
          },
        });
        expect(stale.status).toBe(409);
        expect(ApiErrorSchema.parse(await stale.json()).code).toBe('conflict');
        const staleBinding = await postCatalog(f.app, 'catalog.mcp-binding', {
          workspaceId: f.workspace.id,
          mcpId: 'echo',
          ...{
            ...command,
            expectedRevision: 3,
            bindingRevision: 1,
            requestId: crypto.randomUUID(),
            credentialBindings: [],
          },
        });
        expect(staleBinding.status).toBe(409);
        expect(ApiErrorSchema.parse(await staleBinding.json()).code).toBe('conflict');
        expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(retained);
        expect(
          await update({
            ...command,
            bindingRevision: 3,
            expectedRevision: 3,
            requestId: crypto.randomUUID(),
            credentialBindings: [],
          })
        ).toEqual({ revision: 4 });
        const cleared = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
        expect(cleared.mcp.bindings[0]?.credentialBindings).toEqual([]);
        expect(projectEffectiveWorkspaceMcpCatalog(cleared).servers[0]?.credentialBindings).toEqual(
          []
        );
      } finally {
        f.coreDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        rmSync(f.dataRoot, { force: true, recursive: true });
      }
    }
  );

  it.each(['bearer-sink', 'transport-sink', 'duplicate-destination'] as const)(
    'refuses %s without publishing a catalog revision',
    async (invalid) => {
      const f = await catalogFixture();
      try {
        const created = await postCatalog(f.app, 'catalog.mcp-create', {
          workspaceId: f.workspace.id,
          ...{
            allowedTools: ['echo'],
            declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
            displayName: 'Echo',
            id: 'echo',
            expectedRevision: 0,
            requestId: crypto.randomUUID(),
          },
        });
        expect(created.status, await created.clone().text()).toBe(201);
        const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
        const binding = {
          slot: 'token',
          vaultGrantId: 'grant_00000000-0000-7fb6-8f22-bece61eb0941',
          sink:
            invalid === 'transport-sink'
              ? { kind: 'env', name: 'TOKEN' }
              : { kind: 'header', name: invalid === 'bearer-sink' ? 'X-Token' : 'Authorization' },
          ...(invalid === 'bearer-sink' ? { presentation: 'bearer' } : {}),
        };
        const response = await postCatalog(f.app, 'catalog.mcp-binding', {
          workspaceId: f.workspace.id,
          mcpId: 'echo',
          ...{
            allowedTools: ['echo'],
            bindingRevision: 1,
            enabled: true,
            expectedRevision: 1,
            requestId: crypto.randomUUID(),
            schemaPolicy: 'tracking',
            credentialBindings:
              invalid === 'duplicate-destination'
                ? [
                    binding,
                    { ...binding, slot: 'other', sink: { kind: 'header', name: 'authorization' } },
                  ]
                : [binding],
          },
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(ApiErrorSchema.parse(await response.json()).code).toBe('invalid_request');
        expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
      } finally {
        f.coreDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        rmSync(f.dataRoot, { force: true, recursive: true });
      }
    }
  );

  it('reports a saved binding when activation fails and later applies it in the same process', async () => {
    const f = await catalogFixture();
    const closeIdle = vi.spyOn(f.workerMcpGateway, 'closeServerIfIdle');
    const closeWorkspace = vi.spyOn(f.workerMcpGateway, 'closeWorkspace');
    try {
      const request = { workspaceId: f.workspace.id, requestId: crypto.randomUUID() };
      const created = await postCatalog(f.app, 'catalog.mcp-create', {
        ...request,
        allowedTools: ['echo'],
        declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
        displayName: 'Echo',
        id: 'echo',
        expectedRevision: 0,
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const binding = {
        workspaceId: f.workspace.id,
        mcpId: 'echo',
        enabled: true,
        schemaPolicy: 'tracking',
      };
      const enabled = await postCatalog(f.app, 'catalog.mcp-binding', {
        ...binding,
        allowedTools: ['echo'],
        expectedRevision: 1,
        bindingRevision: 1,
        requestId: crypto.randomUUID(),
      });
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const before = f.runtimeConfigManager.current();
      const configRoot = join(f.dataRoot, 'config');
      mkdirSync(configRoot, { recursive: true });
      const invalidGateway = join(configRoot, 'gateway.jsonc');
      writeFileSync(invalidGateway, '{');
      closeIdle.mockClear();
      closeWorkspace.mockClear();

      const failed = await postCatalog(f.app, 'catalog.mcp-binding', {
        ...binding,
        allowedTools: ['changed'],
        expectedRevision: 2,
        bindingRevision: 2,
        requestId: crypto.randomUUID(),
      });
      expect(failed.status).toBe(409);
      expect(ApiErrorSchema.parse(await failed.json())).toMatchObject({
        code: 'mcp_config_saved_activation_failed',
        details: {
          savedRevision: 3,
          auditAcknowledged: true,
          reloadStatus: 'failed',
          activeRuntimeVersion: before.version,
        },
      });
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(3);
      expect(f.runtimeConfigManager.current()).toBe(before);
      expect(closeIdle).not.toHaveBeenCalled();
      expect(closeWorkspace).not.toHaveBeenCalled();

      rmSync(invalidGateway);
      const reload = await postCatalog(f.app, 'runtime.reload', { mode: 'safe' });
      expect(reload.status).toBe(200);
      expect(await reload.json()).toMatchObject({ status: 'applied' });
      expect(
        f.runtimeConfigManager
          .current()
          .workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === f.workspace.id)?.catalog
          .servers[0]
      ).toMatchObject({ id: 'echo', allowedTools: ['changed'] });
      expect(closeIdle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          workspaceId: f.workspace.id,
          server: expect.objectContaining({ id: 'echo', allowedTools: ['echo'] }),
        }),
        { exactCatalog: true }
      );
      expect(closeWorkspace).not.toHaveBeenCalled();
    } finally {
      closeIdle.mockRestore();
      closeWorkspace.mockRestore();
      await f.workerMcpGateway.close();
      await shutdownControlStoreWorkerClient();
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it.each(['first', 'second'])(
    'reports a saved binding with tool %s superseded before activation',
    async (firstTool) => {
      const f = await openActiveMcpFixture();
      const requestId = crypto.randomUUID();
      const { committed, reply, audit } = holdCatalogAudit(requestId);
      const first = f.change(2, firstTool, requestId);
      try {
        await Promise.race([
          committed.promise,
          first.then(() => {
            throw new Error('The first Audit did not reach the acknowledgement gate.');
          }),
        ]);
        expect(f.installedTools()).toEqual(['base']);
        expect((await f.change(3, 'second')).status).toBe(200);
        expect(f.installedTools()).toEqual(['second']);
        reply.resolve();

        const response = await first;
        expect(response.status).toBe(409);
        expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
          details: {
            savedRevision: 3,
            auditAcknowledged: true,
            reloadStatus: 'superseded',
            activeRuntimeVersion: f.runtimeConfigManager.current().version,
          },
        });
        expect(f.installedTools()).toEqual(['second']);
        const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
        try {
          expect(
            listWorkspaceAuditEvents(workspaceDb, f.workspace.id).filter(
              (event) => event.requestId === requestId && event.action === 'catalog.mcp-binding'
            )
          ).toMatchObject([{ outcome: 'succeeded', resourceRevision: 3 }]);
        } finally {
          workspaceDb.sqlite.close();
        }
      } finally {
        reply.resolve();
        await Promise.allSettled([first]);
        audit.mockRestore();
        await f.close();
      }
    },
    30_000
  );

  it('reports a saved selection superseded by removal of an unbound MCP entry', async () => {
    const f = await catalogFixture();
    const workspaceId = f.workspace.id;
    const common = { workspaceId, displayName: 'Unbound', allowedTools: [] };
    const requestId = crypto.randomUUID();
    const { committed, reply, audit } = holdCatalogAudit(requestId, 'catalog.mcp-select');
    let selection: Promise<Response> | undefined;
    try {
      const created = await postCatalog(f.app, 'catalog.mcp-create', {
        ...common,
        id: 'unbound',
        declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const initialDigest = (await created.json()).versionDigest;
      const staged = await postCatalog(f.app, 'catalog.mcp-stage-version', {
        ...common,
        mcpId: 'unbound',
        declaration: { endpoint: 'https://mcp.example.test/new', kind: 'http' },
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
      });
      expect(staged.status, await staged.clone().text()).toBe(201);
      const { versionDigest } = await staged.json();
      selection = Promise.resolve(
        postCatalog(f.app, 'catalog.mcp-select', {
          workspaceId,
          mcpId: 'unbound',
          digest: versionDigest,
          expectedRevision: 2,
          expectedCurrentDigest: initialDigest,
          requestId,
        })
      );
      await Promise.race([
        committed.promise,
        selection.then(() => {
          throw new Error('The select Audit did not reach the acknowledgement gate.');
        }),
      ]);
      const removed = await postCatalog(f.app, 'catalog.mcp-remove', {
        workspaceId,
        mcpId: 'unbound',
        expectedRevision: 3,
        requestId: crypto.randomUUID(),
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ revision: 4 });
      reply.resolve();
      const response = await selection;
      expect(response.status).toBe(409);
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        details: { savedRevision: 3, auditAcknowledged: true, reloadStatus: 'superseded' },
      });
    } finally {
      reply.resolve();
      await Promise.allSettled([selection]);
      audit.mockRestore();
      await f.close();
    }
  }, 30_000);

  it('confirms a saved binding when a concurrent command changes a different entry', async () => {
    const f = await openActiveMcpFixture();
    const requestId = crypto.randomUUID();
    const { committed, reply, audit } = holdCatalogAudit(requestId);
    const binding = f.change(2, 'changed', requestId);
    try {
      await Promise.race([
        committed.promise,
        binding.then(() => {
          throw new Error('The binding Audit did not reach the acknowledgement gate.');
        }),
      ]);
      const unrelated = await postCatalog(f.app, 'catalog.mcp-create', {
        workspaceId: f.workspace.id,
        id: 'other',
        displayName: 'Other',
        allowedTools: [],
        declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
        expectedRevision: 3,
        requestId: crypto.randomUUID(),
      });
      expect(unrelated.status, await unrelated.clone().text()).toBe(201);
      expect(f.installedTools()).toEqual(['changed']);
      reply.resolve();
      const response = await binding;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revision: 3 });
    } finally {
      reply.resolve();
      await Promise.allSettled([binding]);
      audit.mockRestore();
      await f.close();
    }
  }, 30_000);

  it('retires each immediately preceding installation when reloads overlap', async () => {
    const tls = Promise.withResolvers<boolean>();
    let checking: Promise<boolean> | undefined;
    const f = await openActiveMcpFixture(() => checking ?? Promise.resolve(false));
    const closeIdle = vi.spyOn(f.workerMcpGateway, 'closeServerIfIdle');
    const native = getControlStoreWorkerClient();
    const publish = native.runtimePolicyPublication.bind(native);
    const inspected = Promise.withResolvers<void>();
    const releaseInspect = Promise.withResolvers<void>();
    const requestId = crypto.randomUUID();
    const { committed, reply, audit } = holdCatalogAudit(requestId);
    const requests: Promise<unknown>[] = [];
    try {
      await f.runtimeConfigManager.bindNativePolicyPublication(f.coreDb);
      const publication = vi
        .spyOn(native, 'runtimePolicyPublication')
        .mockImplementationOnce(async (db, input) => {
          const result = await publish(db, input);
          expect(input.kind).toBe('inspect');
          inspected.resolve();
          await releaseInspect.promise;
          return result;
        });
      try {
        const middle = f.change(2, 'middle');
        requests.push(middle);
        await Promise.race([
          inspected.promise,
          middle.then(() => {
            throw new Error('The middle reload did not reach native inspection.');
          }),
        ]);
        checking = tls.promise;
        const refresh = Promise.resolve(
          f.runtimeConfigManager.reload({ dryRun: false, mode: 'safe' })
        );
        requests.push(refresh);
        releaseInspect.resolve();
        expect((await middle).status).toBe(200);
        expect(f.installedTools()).toEqual(['middle']);

        const final = f.change(3, 'final', requestId);
        requests.push(final);
        await Promise.race([
          committed.promise,
          final.then(() => {
            throw new Error('The final Audit did not reach the acknowledgement gate.');
          }),
        ]);
        tls.resolve(false);
        expect((await refresh).status).toBe('applied');
        expect(f.installedTools()).toEqual(['final']);
        reply.resolve();
        expect((await final).status).toBe(200);
        expect(
          closeIdle.mock.calls.map(([input, options]) => [input.server.allowedTools, options])
        ).toEqual([
          [['base'], { exactCatalog: true }],
          [['middle'], { exactCatalog: true }],
        ]);
      } finally {
        publication.mockRestore();
      }
    } finally {
      releaseInspect.resolve();
      reply.resolve();
      tls.resolve(false);
      await Promise.allSettled(requests);
      closeIdle.mockRestore();
      audit.mockRestore();
      await f.close();
    }
  }, 30_000);

  it('returns JSON invalid_request for a malformed catalog body', async () => {
    const f = await catalogFixture();
    try {
      const response = await postCatalog(f.app, 'catalog.mcp-create', {
        workspaceId: f.workspace.id,
        ...{ displayName: 42 },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        code: 'invalid_request',
        message: 'Invalid operation input.',
      });
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it('imports a Skill and returns the redacted Workspace catalog summary', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-resource-catalog-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Catalog workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const empty = await app.request(
        ...operationRequest(
          'catalog.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: workspace.id }),
          }
        )
      );
      expect(empty.status).toBe(200);
      expect(GetWorkspaceCatalogResponseSchema.parse(await empty.json())).toMatchObject({
        candidates: [],
        mcp: [],
        plugins: [],
        revision: 0,
        skills: [],
      });

      const imported = await app.request(
        ...operationRequest(
          'catalog.skill-import',
          {},
          {
            method: 'POST',
            headers: {
              ...{ 'content-type': 'application/json' },
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              workspaceId: workspace.id,
              ...{
                activate: true,
                displayName: 'Repo guidelines',
                expectedRevision: 0,
                requestId: '00000000-0000-4000-8000-000000000001',
                tree: [
                  {
                    contentBase64: Buffer.from(
                      '---\nname: repo-guidelines\ndescription: Exercise ordinary Skill import.\n---\n# Hello\n',
                      'utf8'
                    ).toString('base64'),
                    kind: 'file',
                    path: 'SKILL.md',
                  },
                ],
              },
            }),
          }
        )
      );
      expect(imported.status, await imported.clone().text()).toBe(201);
      const importedBody = ImportSkillResponseSchema.parse(await imported.json());
      expect(importedBody.entry.id).toBe('repo-guidelines');
      expect(importedBody.version.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const summary = await app.request(
        ...operationRequest(
          'catalog.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: workspace.id }),
          }
        )
      );
      expect(GetWorkspaceCatalogResponseSchema.parse(await summary.json()).skills).toEqual([
        expect.objectContaining({
          currentDigest: importedBody.version.digest,
          displayName: 'Repo guidelines',
          id: 'repo-guidelines',
          pinDigest: null,
          versions: [expect.objectContaining({ digest: importedBody.version.digest })],
        }),
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects a plugin upload path that escapes the staging root', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-resource-catalog-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Catalog workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const app = createApp({ coreDb, dataRoot, store });
    try {
      const escaped = await app.request(
        ...operationRequest(
          'catalog.plugin-import',
          {},
          {
            method: 'POST',
            headers: {
              ...{ 'content-type': 'application/json' },
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              workspaceId: workspace.id,
              ...{
                expectedRevision: 0,
                install: true,
                requestId: '00000000-0000-4000-8000-000000000002',
                tree: [
                  {
                    contentBase64: Buffer.from('x').toString('base64'),
                    kind: 'file',
                    path: '../../outside.txt',
                  },
                ],
              },
            }),
          }
        )
      );
      expect(escaped.status).toBe(400);
    } finally {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
