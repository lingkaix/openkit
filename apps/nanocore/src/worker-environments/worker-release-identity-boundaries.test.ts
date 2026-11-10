import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrepareWorkerEnvironmentResponse } from '@openkit/app-api-schemas';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from '../runtime/nanohost-session-dispatch.js';
import { writeWorkerImageSettlement } from '../runtime/worker-image-settlements.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import {
  ensureUserQuickChatWorkspace,
  recordWorkspaceOwnerMembership,
} from '../workspace-membership.js';

const imageDigest = `sha256:${'d'.repeat(64)}`;
const mismatch = { sourceCommit: 'b'.repeat(40), releaseTag: null };
const safeMessage =
  'Worker build identity is absent, invalid or different from the running Core release.';
const fixtures: Array<{
  root: string;
  coreDb: ReturnType<typeof createTestCoreDb>;
  stop?: () => Promise<void>;
}> = [];

afterEach(async () => {
  for (const fixture of fixtures) await fixture.stop?.();
  for (const { root, coreDb } of fixtures.splice(0)) await disposeTestStore(root, coreDb);
});

/** Uses the actual App, private administration products and image result settlement. */
async function administrationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-release-public-'));
  const store = await createDemoStore({ dataRoot: root });
  const coreDb = createTestCoreDb(root);
  fixtures.push({ root, coreDb });
  const userId = ensureLocalUser(coreDb);
  await ensureUserQuickChatWorkspace({ coreDb, store, userId });
  const home = await store.ensureQuickChatWorkspace(userId);
  const thread = await store.createThread(home.id, 'Administration', undefined, 'administration', {
    privateOwnerUserId: userId,
    visibility: 'private',
  });
  const fileId = 'agents/codex.agent.jsonc';
  const initial = readFileSync(join(root, 'config', fileId), 'utf8');
  let releaseIdentity = TEST_WORKER_RELEASE_IDENTITY as {
    sourceCommit: string;
    releaseTag: string | null;
  };
  const effects: NanoHostSessionEffectRequest[] = [];
  const dispatch: NanoHostSessionDispatch = {
    async effect(requestOrConnection, carried) {
      const request = (carried ?? requestOrConnection) as NanoHostSessionEffectRequest;
      effects.push(request);
      if (request.kind === 'image.acquire') {
        if (request.imageSettlement)
          await writeWorkerImageSettlement(coreDb, {
            ...request.imageSettlement,
            requestId: request.requestId,
            operation: request.kind,
            outcome: { kind: 'success', imageDigest },
          });
        return { digest: imageDigest };
      }
      if (request.kind === 'image.inspect')
        return {
          digest: imageDigest,
          releaseIdentity,
          platform: { architecture: 'amd64', os: 'linux' },
          storageLayout: {
            family: 'openkit-worker',
            gid: 1000,
            uid: 1000,
            version: '1',
            targets: [{ target: '/sandbox' }, { target: '/workspace' }],
            workingDirectory: '/tmp/openkit-bootstrap',
          },
          environmentDefaults: {
            defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
            values: {},
          },
        };
      throw new Error(`Unexpected release witness effect: ${request.kind}`);
    },
    async fileExportResult() {},
    async imageBuildInput() {
      throw new Error('Unexpected build input.');
    },
    async poll() {
      return null;
    },
    async result() {},
    async route() {
      throw new Error('Unexpected semantic route.');
    },
  };
  const app = createAppWithLocalIdentity({
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    coreDb,
    dataRoot: root,
    store,
    nanoHostSessionDispatch: dispatch,
    llmGatewayDispatcher: {
      async createResponses() {
        throw new Error('Environment administration must not dispatch a model.');
      },
    },
  });
  const prepare = () =>
    app.request(
      ...operationRequest(
        'worker-environment.prepare',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            administrationThreadId: thread.id,
            configuration: {
              expectedRevision: `sha256:${createHash('sha256').update(initial).digest('hex')}`,
              fileId,
            },
            declaration: {
              kind: 'reference',
              pullPolicy: 'if-not-present',
              ref: 'registry.example.com/openkit/worker:release-witness',
            },
            replaceNow: null,
            requestId: randomUUID(),
            target: { agentId: 'agent_codex_host', kind: 'agent' },
          }),
        }
      )
    );
  return {
    app,
    effects,
    initial,
    filePath: join(root, 'config', fileId),
    prepare,
    changeImageRelease() {
      releaseIdentity = mismatch;
    },
  };
}

it('returns the trusted incompatibility from public preparation before accepting image defaults', async () => {
  const f = await administrationFixture();
  f.changeImageRelease();
  const response = await f.prepare();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'worker_release_incompatible',
    message: safeMessage,
  });
  expect(f.effects.map((effect) => effect.kind)).toEqual(['image.acquire', 'image.inspect']);
  expect(readFileSync(f.filePath, 'utf8')).toBe(f.initial);
});

it('returns the trusted incompatibility from public activation after a genuine successful preparation', async () => {
  const f = await administrationFixture();
  const preparation = await f.prepare();
  const prepared = (await preparation.json()) as PrepareWorkerEnvironmentResponse;
  expect(preparation.status, JSON.stringify(prepared)).toBe(200);
  f.effects.length = 0;
  f.changeImageRelease();
  const response = await f.app.request(
    ...operationRequest(
      'worker-environment.activate',
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          affectedStorage: prepared.affectedStorage,
          configuration: prepared.configuration,
          confirmation: prepared.activationConfirmation,
          replaceNow: prepared.replaceNow,
          requestId: randomUUID(),
          resolvedCandidate: prepared.resolvedCandidate,
          target: prepared.target,
        }),
      }
    )
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'worker_release_incompatible',
    message: safeMessage,
  });
  expect(f.effects.map((effect) => effect.kind)).toEqual(['image.inspect']);
  expect(readFileSync(f.filePath, 'utf8')).toBe(f.initial);
});

it('publishes the specific incompatibility on the public failed Turn before native material delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-release-turn-'));
  const store = await createDemoStore({ dataRoot: root });
  const coreDb = createTestCoreDb(root);
  const owned: (typeof fixtures)[number] = { root, coreDb };
  fixtures.push(owned);
  const ownerUserId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
  const agent = createTestAgentSetup({
    imageRef: imageDigest,
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  admitTestNativeEnvironment(coreDb, agent.manifest);
  const configuration = createInMemoryRuntimeConfigSnapshot({
    ...loadRuntimeConfig(root),
    agentManifests: [agent.manifest],
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Release witness',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
  });
  const native = await createNativeTaskAdmissionFixture(coreDb, store, {
    releaseIdentity: mismatch,
    readRuntimeConfig: () => configuration,
  });
  const entered: Array<{ turnId: string; work: Promise<void> }> = [];
  const start = native.executor.startTurn.bind(native.executor);
  native.executor.startTurn = (...args) => {
    const work = start(...args);
    entered.push({ turnId: args[1], work });
    void work.catch(() => undefined);
    return work;
  };
  owned.stop = async () => {
    for (const execution of entered) native.executionFor(execution.turnId).completion.resolve();
    await Promise.allSettled(entered.map((execution) => execution.work));
    await native.restore();
  };
  const app = createAppWithLocalIdentity({
    releaseIdentity: mismatch,
    coreDb,
    dataRoot: root,
    store,
    agentManifests: [agent.manifest],
    gatewayConfig: configuration.gatewayConfig,
    providerRegistry: configuration.providerRegistry,
    openKitConfig: { defaults: { defaultAgentId: agent.manifest.id } },
    fileAdmission: native.fileAdmission,
    workerControlGateway: native.workerControlGateway,
    turnExecutor: native.executor,
  });
  const response = await app.request(
    ...operationRequest(
      'turn.start',
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: 'Refuse an incompatible Worker image.',
          requestId: randomUUID(),
          threadId: DEMO_THREAD_ID,
          workspaceId: DEMO_WORKSPACE_ID,
        }),
      }
    )
  );
  const turn = (await response.json()) as { id: string };
  expect(response.status, JSON.stringify(turn)).toBe(202);
  await vi.waitFor(() => expect(entered).toHaveLength(1));
  await Promise.allSettled(entered.map((execution) => execution.work));
  expect(native.effects.map((effect) => effect.kind)).toEqual(['image.acquire', 'image.inspect']);
  const read = await app.request(
    ...operationRequest('turn.read', {
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: turn.id,
    })
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    id: turn.id,
    status: 'failed',
    error: { code: 'worker_release_incompatible', message: safeMessage },
  });
});
