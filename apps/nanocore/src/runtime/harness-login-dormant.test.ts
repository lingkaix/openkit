import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { connect, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { expect, it, vi } from 'vitest';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import { createApp } from '../app.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import * as operationRoutes from '../operation-json-routes.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import * as sessionDispatch from './nanohost-session-dispatch.js';

it('keeps the default App Login lifecycle uninstalled, unsupported and unavailable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-dormant-login-'));
  const coreDb = createTestCoreDb(dataRoot);
  const authority = createNanoHostTransportSessionAuthority();
  // Observe real composition: neither spy replaces a producer, consumer or handler.
  const dispatchFactory = vi.spyOn(sessionDispatch, 'createNanoHostSessionDispatch');
  const registration = vi.spyOn(operationRoutes, 'registerOperationJsonRoutes');
  let client: ReturnType<typeof connect> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    ensureLocalUser(coreDb);
    const manifest = createTestAgentSetup().manifest;
    const gatewayConfig = createTestGatewayConfig();
    const providerRegistry = new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Dormant Login fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]);
    const app = createApp({
      coreDb,
      dataRoot,
      openKitConfig: {},
      agentManifests: [manifest],
      gatewayConfig,
      providerRegistry,
      nanohostTransportSessionAuthority: authority,
    });
    expect(dispatchFactory).toHaveBeenCalledTimes(1);
    const dispatch: sessionDispatch.NanoHostSessionDispatch =
      dispatchFactory.mock.results[0]!.value;
    expect(dispatch.supportsHarnessLogin?.()).toBe(false);

    // A diagnostic-only refusal cannot prove App supply: inspect the actual admission input.
    expect(registration).toHaveBeenCalledTimes(1);
    const supply = registration.mock.calls[0]![0].turnStartServices;
    expect(supply).toMatchObject({ supportedRequiredFeatures: [] });
    const dependencies = { ...supply, gatewayConfig, providerRegistry };
    expect(resolveAgentSetup(manifest, dependencies).setup).not.toBeNull();
    // Agent Manifest And AEP Resolution: unsupported required features fail before launch.
    const blocked = resolveAgentSetup(
      { ...manifest, requiredFeatures: ['worker.harness-login.v1'] },
      dependencies
    );
    expect(blocked.setup).toBeNull();
    expect(blocked.diagnostics).toEqual([
      {
        agentId: manifest.id,
        code: 'agent_setup.unsupported_required_feature',
        message: `Agent ${manifest.id} requires unsupported feature: worker.harness-login.v1.`,
        severity: 'error',
      },
    ]);

    const target = {
      deploymentId: 'dormant-login',
      identityId: 'dormant-login',
      targetId: 'dormant-login',
    };
    const allocated = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: new Date().toISOString(),
    });
    const listener = getRequestListener(app.fetch);
    let physicalConnection: object | undefined;
    server = createServer((request, response) => {
      if (!physicalConnection) {
        physicalConnection = readNanoHostPhysicalConnectionContext(request);
        if (!physicalConnection) throw new Error('Missing fixture H2 connection.');
        authority.admit({
          connectionGeneration: allocated.connectionGeneration,
          identityId: target.identityId,
          physicalConnection,
        });
      }
      void listener(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture H2 listener.');
    client = connect(`http://127.0.0.1:${address.port}`);
    const post = async (path: string) => {
      const stream = client!.request({ ':method': 'POST', ':path': path });
      const headers = once(stream, 'response');
      stream.end('{"kind":"acquire"}');
      const [response] = await headers;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return { status: response[':status'], body: Buffer.concat(chunks).toString('utf8') };
    };
    // Establish the actual H2 identity before readiness; public routing does not install Login.
    expect((await post('/api/worker-control/harness/login')).status).toBe(404);
    if (!physicalConnection || !dispatch.readiness) throw new Error('Missing real readiness seam.');
    await dispatch.readiness(
      physicalConnection,
      Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
      { coreDb, ...target }
    );
    expect(authority.mayCarryWork(physicalConnection)).toBe(true);
    const unavailable = await post('/worker-control/harness/login');
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body)).toMatchObject({ code: 'worker_login_unavailable' });
    expect(dispatch.supportsHarnessLogin?.()).toBe(false);

    // An omitted authored marker must not hide a requirement inferred during composition (#604).
    const privateRoute = { providerProfileId: 'native-metadata', providerModel: 'gpt-5.1-codex' };
    const login = createTestAgentSetup({
      privateRoute,
      credentialDeclarations: [
        {
          id: 'codex-subscription',
          vaultGrantId: 'grant_00000000-0000-7f83-847d-ca64a2c18901',
          visibility: 'runtime-token',
          consumer: 'codex-login',
        },
      ],
    }).manifest;
    expect(login.requiredFeatures ?? []).not.toContain('worker.harness-login.v1');
    const omittedMarker = resolveAgentSetup(login, {
      ...supply,
      gatewayConfig: createTestGatewayConfig({ privateRoute }),
      providerRegistry: new ProviderRegistry([
        {
          id: 'native-metadata',
          displayName: 'Codex native metadata',
          kind: 'oauth',
          vendor: 'openai-codex',
          models: [privateRoute.providerModel],
          modelMetadata: {
            [privateRoute.providerModel]: {
              family: 'codex-metadata-fixture',
              limit: { context: 128_000, output: 16_000 },
              modalities: { input: ['text'], output: ['text'] },
              reasoning: true,
              tool_call: true,
            },
          },
        },
      ]),
      subscriptionAccounts: {
        gatewayUnavailableReason: () => {
          throw new Error('Login setup must not consult Server account readiness.');
        },
      },
      providerCredentialConfigured: () => {
        throw new Error('Login setup must not consult Server key readiness.');
      },
    });
    expect(omittedMarker.setup).toBeNull();
    expect(omittedMarker.diagnostics).toContainEqual({
      agentId: login.id,
      code: 'agent_setup.unsupported_required_feature',
      message: `Agent ${login.id} requires unsupported feature: worker.harness-login.v1.`,
      severity: 'error',
    });
  } finally {
    client?.destroy();
    try {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await authority.closeAllPhysicalConnections();
    } finally {
      vi.restoreAllMocks();
      await disposeTestStore(dataRoot, coreDb);
    }
  }
});
