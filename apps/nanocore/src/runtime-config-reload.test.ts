import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type ServerHttp2Session } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getNanoHostTransportSessionAuthority } from './app.js';
import transportRevision from './auth/nanohost-transport-revision.json' with { type: 'json' };
import { createNanoHostTransportTokenRecord } from './auth/nanohost-transport-token-store.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import { openCoreDb } from './storage/db.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { seedWritableGitRepository } from './test-support/git-repository.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates a temporary NanoCore data root with one runtime config.
 *
 * @param model Provider model id.
 * @returns Temporary data root path.
 */
function createConfiguredDataRoot(model: string): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-reload-api-'));

  writeServerConfig(dataRoot, model);

  return dataRoot;
}

/**
 * Writes the canonical server config used by reload API tests.
 *
 * @param dataRoot Data root that owns the config file.
 * @param model Provider model id.
 */
function writeServerConfig(dataRoot: string, model: string): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'server.jsonc'),
    `{
      "schemaVersion": 1,
      "defaults": {
        "defaultAgentId": "agent_codex_host"
      }
    }`
  );
  const providersRoot = join(dataRoot, 'config', 'providers');
  mkdirSync(providersRoot, { recursive: true });
  writeFileSync(
    join(providersRoot, 'agent-openrouter.provider.jsonc'),
    JSON.stringify({
      id: 'agent-openrouter',
      vendor: 'openrouter',
      kind: 'gateway',
      displayName: `Agent OpenRouter ${model}`,
      models: ['openai/gpt-5.1'],
    })
  );
  const gatewayPath = join(dataRoot, 'config', 'gateway.jsonc');
  if (!existsSync(gatewayPath))
    writeFileSync(
      gatewayPath,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              { id: 'primary', providerProfileId: 'agent-openrouter', providerModel: model },
            ],
          },
        ],
        requiredFeatures: [],
      })
    );
}

describe('NanoHost restart-required reload fencing', () => {
  for (const mode of ['safe', 'strict', 'dry-run', 'read-failed'] as const) {
    it(`keeps native connection authority consistent after ${mode} reload`, async () => {
      const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
      const coreDb = openCoreDb(dataRoot);
      const clients: ReturnType<typeof connect>[] = [];
      const sessions: ServerHttp2Session[] = [];
      let server: ReturnType<typeof createServer> | undefined;
      try {
        applyMigrations(coreDb);
        const localUserId = ensureLocalUser(coreDb);
        const store = createDemoStore({ dataRoot });
        const deploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
        const host = {
          bind: { host: '127.0.0.1', port: 3101 },
          credentialRef: 'fixture-host',
          credentialSlots: {
            A: { companionPath: '/fixture/a-companion', secretPath: '/fixture/a-secret' },
            B: { companionPath: '/fixture/b-companion', secretPath: '/fixture/b-secret' },
          },
          deploymentId,
          identityId: 'fixture-reload-host',
          rendezvousUrl: 'http://127.0.0.1:3101',
        };
        const configPath = join(dataRoot, 'config', 'server.jsonc');
        const originalConfig = JSON.parse(readFileSync(configPath, 'utf8'));
        const writeHost = (value: typeof host) =>
          writeFileSync(configPath, JSON.stringify({ ...originalConfig, nanohost: value }));
        writeHost(host);
        const manager = createRuntimeConfigManager({ dataRoot });
        const initial = manager.current();
        let app = createApp({ coreDb, dataRoot, runtimeConfigManager: manager, store });
        const authority = getNanoHostTransportSessionAuthority(app);
        coreDb.sqlite
          .prepare(
            'INSERT INTO nanohost_integration_identities (identity_id, deployment_id, status, created_at) VALUES (?, ?, ?, ?)'
          )
          .run(host.identityId, deploymentId, 'active', new Date().toISOString());
        const token = createNanoHostTransportTokenRecord(coreDb, {
          deploymentId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          ownerNanoHostIdentityId: host.identityId,
          responsibleServerAdminActorId: localUserId,
        });
        server = createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const result = await app.fetch(
            new Request('http://fixture/api/nanohost/transport/session/admit', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token.secret}`,
                'content-type': 'application/json',
                'x-openkit-nanohost-transport-revision': String(transportRevision),
              },
              body: Buffer.concat(chunks),
            }),
            { incoming: request }
          );
          response
            .writeHead(result.status, Object.fromEntries(result.headers))
            .end(await result.text());
        });
        server.on('session', (session) => sessions.push(session));
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing reload fixture address.');
        const admit = async () => {
          const client = connect(`http://127.0.0.1:${address.port}`);
          clients.push(client);
          const request = client.request({ ':method': 'POST', ':path': '/' });
          let status: unknown;
          request.on('response', (headers) => {
            status = headers[':status'];
          });
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.end('{}');
          await once(request, 'end');
          return { status, body: JSON.parse(Buffer.concat(chunks).toString()) };
        };
        const first = await admit();
        expect(first.status).toBe(200);
        expect(first.body.role).toBe('authoritative');
        const target = getNanoHostRuntimeTarget(coreDb, host.identityId)!;
        upsertNanoHostRuntimeTarget(coreDb, {
          ...target,
          freshEmpty: true,
          observedAt: new Date().toISOString(),
          physicalEpoch: 'a'.repeat(64),
          predecessorFenced: true,
          ready: true,
        });
        expect(getNanoHostRuntimeTarget(coreDb, host.identityId)).toMatchObject({
          ready: true,
          physicalEpoch: 'a'.repeat(64),
        });
        if (mode === 'strict' || mode === 'read-failed') {
          const candidate = await admit();
          expect(candidate.status).toBe(200);
          expect(candidate.body.role).toBe('candidate');
          expect(authority.mayCarryWork(sessions[1]!)).toBe(false);
        }
        writeHost({ ...host, credentialRef: 'fixture-successor' });

        // Direct callers and public operations must cross the same reload fence.
        if (mode === 'read-failed') {
          const failure = new Error('Synthetic readiness observation read failed.');
          const prepare = coreDb.sqlite.prepare.bind(coreDb.sqlite);
          const targetBeforeReload = getNanoHostRuntimeTarget(coreDb, host.identityId);
          const readFailure = vi
            .spyOn(coreDb.sqlite, 'prepare')
            .mockImplementation((sql: string) => {
              if (sql.includes('target_id AS targetId') && sql.includes('WHERE identity_id = ?'))
                throw failure;
              return prepare(sql);
            });
          try {
            expect(() => manager.reload({ mode: 'safe' })).toThrow(failure);
            expect(authority.mayCarryWork(sessions[0]!)).toBe(false);
            expect(authority.mayCarryWork(sessions[1]!)).toBe(false);
            expect(authority.authoritativeGeneration(host.identityId)).toBeNull();
          } finally {
            readFailure.mockRestore();
          }
          // Failed durable observation stays unchanged; process fencing does not claim a committed readiness update.
          expect(getNanoHostRuntimeTarget(coreDb, host.identityId)).toEqual(targetBeforeReload);
        } else if (mode === 'safe') expect(manager.reload({ mode: 'safe' }).status).toBe('applied');
        else {
          const response = await app.request(
            ...operationRequest(
              'runtime.reload',
              {},
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ mode: 'strict', dryRun: mode === 'dry-run' }),
              }
            )
          );
          expect(response.status).toBe(200);
          expect((await response.json()).status).toBe('rejected');
        }
        expect(manager.current().openKitConfig.nanohost).toEqual(host);
        if (mode === 'strict' || mode === 'dry-run') expect(manager.current()).toBe(initial);
        if (mode === 'dry-run') {
          expect(authority.mayCarryWork(sessions[0]!)).toBe(true);
          expect(getNanoHostRuntimeTarget(coreDb, host.identityId)).toMatchObject({
            ready: true,
            physicalEpoch: 'a'.repeat(64),
          });
          return;
        }
        expect(authority.mayCarryWork(sessions[0]!)).toBe(false);
        expect(authority.authoritativeGeneration(host.identityId)).toBeNull();
        expect(getNanoHostRuntimeTarget(coreDb, host.identityId)).toMatchObject({
          ready: false,
          freshEmpty: false,
          physicalEpoch: null,
        });
        if (mode === 'strict' || mode === 'read-failed') {
          authority.closePhysicalConnection(sessions[0]!);
          expect(authority.mayCarryWork(sessions[1]!)).toBe(false);
          expect(authority.authoritativeGeneration(host.identityId)).toBeNull();
        }
        expect((await admit()).status).toBe(409);

        writeHost(host);
        expect(manager.reload({ mode: 'safe' }).status).toBe('applied');
        expect(manager.status().pendingRestart).toEqual([]);
        expect((await admit()).status).toBe(409);
        expect(authority.authoritativeGeneration(host.identityId)).toBeNull();

        // A new App lifetime reads the restored startup file and admits a fresh generation.
        app = createApp({
          coreDb,
          dataRoot,
          runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
          store,
        });
        expect((await admit()).status).toBe(200);
      } finally {
        for (const client of clients) client.destroy();
        for (const session of sessions) session.destroy();
        if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
        coreDb.sqlite.close();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });
  }
});

describe('runtime config reload API', () => {
  it('hydrates the joined Workspace name after an accepted config reload', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const store = createDemoStore({ dataRoot });
    const workspaceConfigPath = join(
      dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'config',
      'workspace.jsonc'
    );
    const app = createApp({ dataRoot, store, turnExecutor: new SimulatedTurnExecutor() });

    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Reloaded Workspace', defaultAgentId: null },
      })
    );
    const response = await app.request(
      ...operationRequest(
        'runtime.reload',
        {},
        {
          method: 'POST',
          body: JSON.stringify({ mode: 'safe' }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(response.status).toBe(200);
    expect(store.getWorkspace('ws_00000000-0000-7000-8000-000000000001').name).toBe(
      'Reloaded Workspace'
    );
  });

  it('keeps provider changes pending restart and exposes the live runtime status', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const app = createApp({
      dataRoot,
      runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
      turnExecutor: new SimulatedTurnExecutor(),
    });

    writeServerConfig(dataRoot, 'openai/gpt-5.2');
    const reloadRes = await app.request(
      ...operationRequest(
        'runtime.reload',
        {},
        {
          method: 'POST',
          body: JSON.stringify({ mode: 'safe' }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(reloadRes.status).toBe(200);
    const reload = (await reloadRes.json()) as {
      runtimeConfig: { currentVersion: number; pendingRestart: Array<{ path: string }> };
      plan: { applied: Array<{ path: string }>; requiresRestart: Array<{ path: string }> };
    };

    expect(reload.runtimeConfig.currentVersion).toBe(2);
    expect(reload.plan.applied).toEqual([]);
    expect(reload.plan.requiresRestart).toEqual([expect.objectContaining({ path: 'providers' })]);
    expect(reload.runtimeConfig.pendingRestart).toEqual([
      expect.objectContaining({ path: 'providers' }),
    ]);

    const diagnosticsRes = await app.request(...operationRequest('diagnostics.app', {}));
    const diagnostics = (await diagnosticsRes.json()) as {
      runtimeConfig: { currentVersion: number };
      providers: { registry: Array<{ id: string; models: string[] }> };
    };

    expect(diagnostics.runtimeConfig.currentVersion).toBe(2);
    expect(diagnostics.providers.registry[0]?.models).toContain('openai/gpt-5.1');
  });

  it('keeps the active AgentSession across a restart-required provider reload', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      identityId: 'identity_reload_fixture',
      observedAt: new Date().toISOString(),
      targetId: 'target_reload_fixture',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...target,
      freshEmpty: true,
      observedAt: new Date().toISOString(),
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const store = createDemoStore({ dataRoot });
    const agentSetup = createTestAgentSetup({
      logicalModelId: 'reasoning',
      privateRoute: {
        providerProfileId: 'agent-openrouter',
        providerModel: 'openai/gpt-5.1',
      },
    });
    const app = createApp({
      agentManifests: [agentSetup.manifest],
      coreDb,
      dataRoot,
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.1',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
          vendor: 'openrouter',
          secretRef: 'env:OPENKIT_RELOAD_FIXTURE_KEY',
        },
      ]),
      // This lifecycle fixture needs configured non-Vault supply, without a Provider call.
      providerCredentialResolver: (secretRef) =>
        secretRef === 'env:OPENKIT_RELOAD_FIXTURE_KEY' ? 'test-only-reload-key' : null,
      store,
      turnExecutor: new SimulatedTurnExecutor({ coreDb }),
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-runtime-reload-repository-'));

    try {
      seedWritableGitRepository(repositoryPath);

      const turnRes = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              requestId: '0190f4c8-0000-7000-8000-000000000301',
              input: 'Run with version one',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const turn = (await turnRes.json()) as { id: string; configVersion: number };

      expect(turnRes.status, JSON.stringify(turn)).toBe(202);
      expect(turn.configVersion, JSON.stringify(turn)).toBe(1);
      expect(turn).not.toHaveProperty('agentSessionId');
      await vi.waitFor(() => {
        expect(store.getTurnById(turn.id).status).toBe('completed');
        expect(
          coreDb.sqlite
            .prepare('SELECT phase FROM scheduler_execution_attempts WHERE turn_id = ?')
            .get(turn.id)
        ).toEqual({ phase: 'closed' });
      });
      const sessionsBeforeReload = store.listThreadAgentSessions(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      );
      expect(sessionsBeforeReload).toEqual([
        expect.objectContaining({ configVersion: 1, stale: false, status: 'idle' }),
      ]);

      writeServerConfig(dataRoot, 'openai/gpt-5.2');
      const reloadRes = await app.request(
        ...operationRequest(
          'runtime.reload',
          {},
          {
            method: 'POST',
            body: JSON.stringify({ mode: 'safe' }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      expect(reloadRes.status).toBe(200);
      const reload = (await reloadRes.json()) as {
        runtimeConfig: { pendingRestart: Array<{ path: string }> };
        plan: { requiresRestart: Array<{ path: string }> };
      };
      expect(reload.plan.requiresRestart).toContainEqual(
        expect.objectContaining({ path: 'providers' })
      );
      expect(reload.runtimeConfig.pendingRestart).toContainEqual(
        expect.objectContaining({ path: 'providers' })
      );

      const dashboardRes = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        }),
      });
      const dashboard = await dashboardRes.json();
      const sessionsAfterReload = store.listThreadAgentSessions(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      );

      expect(dashboardRes.status, JSON.stringify(dashboard)).toBe(200);
      expect(JSON.stringify(dashboard)).not.toMatch(/agentSession/i);
      expect(sessionsAfterReload).toEqual(sessionsBeforeReload);
      expect(
        store
          .listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .some((item) => item.status === 'interrupted')
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
